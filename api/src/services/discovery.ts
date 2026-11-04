import { chromium, type Page } from "playwright";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { parse, str } from "../lib/json.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { putObject } from "../lib/storage.js";
import { aiJSON } from "./ai.js";
import { applyNetworkPolicy } from "./browser.js";
import { recordActivity } from "./activity.js";
import { isCancelled } from "./queue.js";

export type DiscoveredPage = {
  url: string; title: string; status: number | null; depth: number; links: string[]; buttons: string[];
  forms: { action: string; method: string; fields: { name: string; type: string; label: string; required: boolean }[] }[];
  navItems: string[]; headings: string[]; screenshotEvidenceId: string | null;
};

export type DiscoveryResult = {
  pages: DiscoveredPage[]; inaccessible: { url: string; reason: string }[]; authRequired: boolean;
  limitations: string[]; workflows: { name: string; steps: string[] }[]; coverageNote: string;
  blockedRequests: string[]; summarySource: "claude" | "heuristic";
};

const SKIP_LINK = /logout|log-out|signout|sign-out|delete|remove|unsubscribe|\.(pdf|zip|png|jpe?g|gif|svg|mp4|docx?)$/i;

type PageInfo = { title: string; links: string[]; buttons: string[]; navItems: string[]; headings: string[]; forms: DiscoveredPage["forms"]; hasPassword: boolean };

// Passed to the browser as source text: tsx/esbuild would otherwise inject helpers (e.g. __name)
// into a compiled function that do not exist inside the page.
const EXTRACT_SCRIPT = `(() => {
  const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const labelFor = (el) => {
    const id = el.getAttribute("id");
    const lab = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : el.closest("label");
    return ((lab && lab.textContent) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 60);
  };
  const uniq = (a) => [...new Set(a)];
  return {
    title: document.title,
    links: uniq([...document.querySelectorAll("a[href]")].map((a) => a.href)).slice(0, 200),
    buttons: uniq([...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")]
      .map((b) => text(b) || b.value || b.getAttribute("aria-label") || "").filter(Boolean)).slice(0, 50),
    navItems: uniq([...document.querySelectorAll("nav a, header a, [role=navigation] a")].map(text).filter(Boolean)).slice(0, 40),
    headings: uniq([...document.querySelectorAll("h1, h2")].map(text).filter(Boolean)).slice(0, 15),
    forms: [...document.querySelectorAll("form")].slice(0, 10).map((f) => ({
      action: f.action, method: (f.method || "get").toUpperCase(),
      fields: [...f.querySelectorAll("input, select, textarea")]
        .filter((i) => !["hidden", "submit", "button"].includes(i.type))
        .slice(0, 25)
        .map((i) => ({ name: i.getAttribute("name") || i.getAttribute("id") || "", type: i.type || i.tagName.toLowerCase(), label: labelFor(i), required: Boolean(i.required) })),
    })),
    hasPassword: Boolean(document.querySelector("input[type=password]")),
  };
})()`;

async function extractPage(page: Page): Promise<PageInfo> {
  return page.evaluate(EXTRACT_SCRIPT) as Promise<PageInfo>;
}

/** Attempts a form login with the environment's stored test credentials. Never logs the values. */
async function tryLogin(page: Page, creds: { username?: string; password?: string }) {
  if (!creds.username || !creds.password) return false;
  const pwd = page.locator("input[type=password]").first();
  if (!(await pwd.count())) return false;
  const user = page.locator("input[type=email], input[name*=user i], input[name*=email i], input[name*=login i], input[type=text]").first();
  await user.fill(creds.username);
  await pwd.fill(creds.password);
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), pwd.press("Enter")]);
  return !(await page.locator("input[type=password]").count());
}

export async function runDiscovery(discoveryId: string) {
  const d = await prisma.discovery.findUniqueOrThrow({ where: { id: discoveryId }, include: { project: true } });
  const env = await prisma.environment.findUniqueOrThrow({ where: { id: d.environmentId } });
  const orgId = d.project.organisationId;
  const evidencePrefix = `${orgId}/${d.projectId}/discovery/${d.id}`;
  await prisma.discovery.update({ where: { id: d.id }, data: { status: "RUNNING", startedAt: new Date() } });
  if (d.testRunId) await prisma.testRun.update({ where: { id: d.testRunId }, data: { status: "RUNNING", startedAt: new Date() } });

  const result: DiscoveryResult = {
    pages: [], inaccessible: [], authRequired: false, limitations: [], workflows: [], coverageNote: "",
    blockedRequests: [], summarySource: "heuristic",
  };
  let summary = "";
  let failed = false;
  const browser = await chromium.launch();
  try {
    const start = await assertSafeTarget(env.baseUrl);
    const context = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1366, height: 860 } });
    await applyNetworkPolicy(context, [start.hostname], config.allowPrivateTargets, result.blockedRequests);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const creds = env.encryptedCredentials ? parse<{ username?: string; password?: string }>(decrypt(env.encryptedCredentials), {}) : {};
    let loggedIn = false;

    const queue: { url: string; depth: number }[] = [{ url: start.toString(), depth: 0 }];
    const seen = new Set<string>();
    while (queue.length && result.pages.length < d.maxPages) {
      if (d.testRunId && isCancelled(d.testRunId)) {
        result.limitations.push("Discovery was cancelled before completion.");
        break;
      }
      const { url, depth } = queue.shift()!;
      const norm = url.split("#")[0];
      if (seen.has(norm)) continue;
      seen.add(norm);
      try {
        const resp = await page.goto(norm, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        const status = resp?.status() ?? null;
        if (status && status >= 400) {
          result.inaccessible.push({ url: norm, reason: `HTTP ${status}` });
          if (status === 401 || status === 403) result.authRequired = true;
          continue;
        }
        let info = await extractPage(page);
        if (info.hasPassword) {
          result.authRequired = true;
          if (d.useCredentials && !loggedIn) {
            loggedIn = await tryLogin(page, creds);
            if (loggedIn) {
              result.limitations.push("Logged in with the environment's stored test credentials; authenticated pages were explored.");
              info = await extractPage(page);
            } else {
              result.limitations.push("Login form detected but automatic login did not succeed; authenticated areas were not explored.");
            }
          }
        }
        const shot = await page.screenshot({ fullPage: false, mask: [page.locator("input[type=password]")] });
        const key = await putObject(`${evidencePrefix}/page-${result.pages.length + 1}.png`, shot);
        const ev = d.testRunId
          ? await prisma.evidence.create({
              data: { testRunId: d.testRunId, fileType: "SCREENSHOT", name: `${info.title || norm}.png`, mimeType: "image/png", size: shot.length, storageReference: key },
            })
          : null;
        const sameOrigin = info.links.filter((l) => {
          try {
            return new URL(l).origin === start.origin;
          } catch {
            return false;
          }
        });
        result.pages.push({
          url: page.url(), title: info.title, status, depth, links: sameOrigin.slice(0, 60), buttons: info.buttons,
          forms: info.forms, navItems: info.navItems, headings: info.headings, screenshotEvidenceId: ev?.id ?? null,
        });
        for (const l of sameOrigin) if (!SKIP_LINK.test(l) && !seen.has(l.split("#")[0])) queue.push({ url: l, depth: depth + 1 });
      } catch (err) {
        result.inaccessible.push({ url: norm, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    }
    const unvisited = queue.filter((q) => !seen.has(q.url.split("#")[0])).length;
    if (unvisited) result.limitations.push(`Page limit of ${d.maxPages} reached; ${unvisited} further discovered link(s) were not visited.`);
    if (result.authRequired && !loggedIn) result.limitations.push("Some functionality appears to require authentication. Add test credentials to the environment and re-run discovery with credentials to explore it.");
    if (result.blockedRequests.length) result.limitations.push(`${result.blockedRequests.length} request(s) to non-approved or internal destinations were blocked by the network policy.`);
    result.limitations.push("Destructive links (logout, delete, unsubscribe) and file downloads were intentionally not followed.");
    result.limitations.push("Discovery does not submit forms or exercise multi-step flows; workflows below are inferred from page structure.");
    await context.close();
    ({ summary } = await summarise(result));
  } catch (err) {
    failed = true;
    summary = `Discovery failed: ${err instanceof Error ? err.message : String(err)}`;
    result.limitations.push(summary);
  } finally {
    await browser.close().catch(() => {});
  }

  result.coverageNote =
    `Inspected ${result.pages.length} page(s); ${result.inaccessible.length} could not be accessed. ` +
    "This is a partial map of publicly reachable pages and is not a complete picture of the application.";
  const status = failed || result.pages.length === 0 ? "FAILED" : "COMPLETED";
  await prisma.discovery.update({ where: { id: d.id }, data: { status, result: str(result), summary, completedAt: new Date() } });
  if (d.testRunId)
    await prisma.testRun.update({ where: { id: d.testRunId }, data: { status: status === "COMPLETED" ? "COMPLETED" : "ERROR", completedAt: new Date() } });
  await recordActivity({
    organisationId: orgId, projectId: d.projectId, actionType: "DISCOVERY_COMPLETED",
    actionStatus: status === "COMPLETED" ? "DONE" : "FAILED",
    message: status === "COMPLETED" ? `Discovery mapped ${result.pages.length} page(s) on ${env.name.toLowerCase()}` : "Application discovery failed",
    link: `/projects/${d.projectId}?tab=discovery`, executionReference: d.id,
  });
}

const SummarySchema = z.object({
  summary: z.string().describe("3-6 sentence summary of the functionality observed. State explicitly that coverage is partial."),
  workflows: z.array(z.object({ name: z.string(), steps: z.array(z.string()) })).describe("Likely user journeys inferred from the pages"),
});

async function summarise(r: DiscoveryResult) {
  const compact = r.pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings, nav: p.navItems, buttons: p.buttons.slice(0, 15), forms: p.forms }));
  const ai = await aiJSON({
    schema: SummarySchema,
    effort: "low",
    task: "Below is the structure of web pages discovered by an automated crawler. Summarise the functionality observed and infer the main user workflows. Only describe what the data supports; mention that unvisited or authenticated areas are not covered.",
    input: { pages: compact, inaccessible: r.inaccessible, authRequired: r.authRequired },
  });
  if (ai) {
    r.workflows = ai.workflows;
    r.summarySource = "claude";
    return { summary: ai.summary };
  }
  r.workflows = heuristicWorkflows(r.pages);
  const forms = r.pages.reduce((n, p) => n + p.forms.length, 0);
  return {
    summary:
      `[Heuristic summary — AI not configured] Discovered ${r.pages.length} page(s) with ${forms} form(s). ` +
      `Primary navigation: ${[...new Set(r.pages.flatMap((p) => p.navItems))].slice(0, 8).join(", ") || "none detected"}. ` +
      (r.authRequired ? "A login or protected area was detected. " : "") +
      "Coverage is limited to pages reachable by following links.",
  };
}

function heuristicWorkflows(pages: DiscoveredPage[]) {
  const flows: { name: string; steps: string[] }[] = [];
  for (const p of pages) {
    for (const f of p.forms) {
      const kind = f.fields.some((x) => x.type === "password")
        ? f.fields.filter((x) => x.type === "password").length > 1 ? "Registration" : "Login"
        : f.fields.some((x) => /search|q/i.test(x.name)) ? "Search" : f.fields.some((x) => x.type === "email") ? "Contact / sign-up" : "Form submission";
      flows.push({ name: `${kind} on ${p.title || p.url}`, steps: [`Open ${p.url}`, ...f.fields.map((x) => `Enter ${x.label || x.name || x.type}`), "Submit the form"] });
    }
  }
  if (pages.length > 1) flows.push({ name: "Primary navigation", steps: pages.slice(0, 6).map((p) => `Visit ${p.title || p.url}`) });
  return flows.slice(0, 12);
}

export function discoveryDto(d: { id: string; projectId: string; environmentId: string; status: string; startedAt: Date | null; completedAt: Date | null; result: string; summary: string; testRunId: string | null }) {
  const r = parse<Partial<DiscoveryResult>>(d.result, {});
  return {
    id: d.id, projectId: d.projectId, environmentId: d.environmentId, status: d.status, startedAt: d.startedAt, completedAt: d.completedAt,
    testRunId: d.testRunId, pages: r.pages ?? [], inaccessible: r.inaccessible ?? [], authRequired: r.authRequired ?? false,
    limitations: r.limitations ?? [], workflows: r.workflows ?? [], summary: d.summary, coverageNote: r.coverageNote ?? "",
    generatedBy: r.summarySource ?? null,
  };
}
