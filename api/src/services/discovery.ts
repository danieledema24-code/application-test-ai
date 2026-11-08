import fs from "node:fs/promises";
import path from "node:path";
import type { Environment, Prisma } from "@prisma/client";
import { chromium, type Page } from "playwright";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { parse, str } from "../lib/json.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { plural } from "../lib/text.js";
import { putObject } from "../lib/storage.js";
import { aiJSON } from "./ai.js";
import { applyNetworkPolicy } from "./browser.js";
import { recordActivity } from "./activity.js";
import { isCancelled } from "./queue.js";
import { liveDir } from "./runner.js";
import { generateChecksForScan, generationDto } from "./scan-checks.js";

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

/**
 * Streams the scan's viewport as JPEG frames into the run's live folder (slot 0), in the same format the
 * automated-run fixture uses, so GET /test-runs/:id/live and its MJPEG stream work unchanged.
 */
async function streamLiveFrames(page: Page, dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const slot = path.join(dir, "w0");
  let title = "";
  const state = () => fs.writeFile(`${slot}.json`, JSON.stringify({ title, state: "running", at: Date.now() })).catch(() => {});
  await state();
  let last = 0;
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  cdp?.on("Page.screencastFrame", async (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (Date.now() - last < 100) return;
    last = Date.now();
    // Written then renamed so the stream never reads a half-written frame.
    await fs.writeFile(`${slot}.tmp`, Buffer.from(f.data, "base64")).then(() => fs.rename(`${slot}.tmp`, `${slot}.jpg`)).catch(() => {});
  });
  await cdp?.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 860 }).catch(() => {});
  return {
    visiting: (t: string) => {
      title = t;
      return state();
    },
    stop: () => cdp?.send("Page.stopScreencast").catch(() => {}),
  };
}

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

/**
 * Runs a queued scan. Any error, including ones before the browser starts (e.g. the site was deleted while
 * the scan waited), ends the scan as FAILED with a plain reason, so it never stays QUEUED or RUNNING and
 * blocks the next scan of the project.
 */
export async function runDiscovery(discoveryId: string) {
  const d = await prisma.discovery.findUnique({ where: { id: discoveryId }, include: { project: true } });
  if (!d) return;
  try {
    const env = await prisma.environment.findUnique({ where: { id: d.environmentId } });
    if (!env) return await failScan(d, "The site was removed before the scan could start.");
    await scanSite(d, env);
  } catch (err) {
    console.error(`[discovery] ${discoveryId} crashed:`, err);
    await failScan(d, `We couldn't finish looking around your site (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).`).catch(() => {});
  } finally {
    if (d.testRunId) await fs.rm(path.join(liveDir(d.testRunId), ".."), { recursive: true, force: true }).catch(() => {});
  }
}

/** Ends a scan that is still QUEUED or RUNNING as FAILED (run ERROR), keeping any pages already saved. */
async function failScan(d: { id: string; projectId: string; testRunId: string | null; result: string; project: { organisationId: string } }, reason: string) {
  const current = await prisma.discovery.findUnique({ where: { id: d.id } });
  const r = parse<Partial<DiscoveryResult>>(current?.result ?? d.result, {});
  const result = { ...r, limitations: [...(r.limitations ?? []), reason], stoppedEarly: true };
  delete (result as { current?: unknown }).current;
  const res = await prisma.discovery.updateMany({
    where: { id: d.id, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "FAILED", summary: reason, result: str(result), completedAt: new Date() },
  });
  if (!res.count) return;
  if (d.testRunId) await prisma.testRun.updateMany({ where: { id: d.testRunId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "ERROR", completedAt: new Date() } });
  await recordActivity({
    organisationId: d.project.organisationId, projectId: d.projectId, actionType: "DISCOVERY_COMPLETED", actionStatus: "FAILED",
    message: "Site scan stopped early", link: `/projects/${d.projectId}?tab=discovery`, executionReference: d.id,
  });
}

async function scanSite(d: Prisma.DiscoveryGetPayload<{ include: { project: true } }>, env: Environment) {
  const orgId = d.project.organisationId;
  const evidencePrefix = `${orgId}/${d.projectId}/discovery/${d.id}`;
  const cancelled = async () => Boolean(d.testRunId) && (isCancelled(d.testRunId!) || (await prisma.testRun.findUnique({ where: { id: d.testRunId! } }))?.status === "CANCELLED");
  if (await cancelled()) {
    await prisma.discovery.update({ where: { id: d.id }, data: { status: "CANCELLED", completedAt: new Date() } });
    return;
  }
  await prisma.discovery.update({ where: { id: d.id }, data: { status: "RUNNING", startedAt: new Date() } });
  if (d.testRunId) await prisma.testRun.update({ where: { id: d.testRunId }, data: { status: "RUNNING", startedAt: new Date() } });

  const result: DiscoveryResult = {
    pages: [], inaccessible: [], authRequired: false, limitations: [], workflows: [], coverageNote: "",
    blockedRequests: [], summarySource: "heuristic",
  };
  let summary = "";
  let failed = false;
  // Pages found so far and the page being visited are saved as the scan goes, for the live view.
  const progress = (current: { url: string; title: string }) =>
    prisma.discovery.update({ where: { id: d.id }, data: { result: str({ ...result, current }) } }).catch(() => {});
  const browser = await chromium.launch();
  let live: Awaited<ReturnType<typeof streamLiveFrames>> | null = null;
  try {
    const start = await assertSafeTarget(env.baseUrl);
    const context = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1366, height: 860 } });
    await applyNetworkPolicy(context, [start.hostname], config.allowPrivateTargets, result.blockedRequests);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    if (d.testRunId) live = await streamLiveFrames(page, liveDir(d.testRunId));
    const creds = env.encryptedCredentials ? parse<{ username?: string; password?: string }>(decrypt(env.encryptedCredentials), {}) : {};
    let loggedIn = false;

    const queue: { url: string; depth: number }[] = [{ url: start.toString(), depth: 0 }];
    const seen = new Set<string>();
    while (queue.length && result.pages.length < d.maxPages) {
      if (await cancelled()) {
        result.limitations.push("The scan was cancelled before it finished.");
        break;
      }
      const { url, depth } = queue.shift()!;
      const norm = url.split("#")[0];
      if (seen.has(norm)) continue;
      seen.add(norm);
      await progress({ url: norm, title: "" });
      await live?.visiting(norm);
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
              result.limitations.push("Signed in with the saved test login, so pages behind the sign-in were included.");
              info = await extractPage(page);
            } else {
              result.limitations.push("We found a sign-in form but couldn't sign in with the saved test login, so pages behind it were not included.");
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
        await progress({ url: page.url(), title: info.title });
        await live?.visiting(info.title || page.url());
        for (const l of sameOrigin) if (!SKIP_LINK.test(l) && !seen.has(l.split("#")[0])) queue.push({ url: l, depth: depth + 1 });
      } catch (err) {
        result.inaccessible.push({ url: norm, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    }
    const unvisited = queue.filter((q) => !seen.has(q.url.split("#")[0])).length;
    if (unvisited) result.limitations.push(`Stopped at the limit of ${plural(d.maxPages, "page")}; ${plural(unvisited, "more link")} ${unvisited === 1 ? "was" : "were"} not visited.`);
    if (result.authRequired && !loggedIn) result.limitations.push("Some pages need a sign-in. Add a test login in Sites & logins, then scan again with \"Sign in first\" ticked to include them.");
    if (result.blockedRequests.length) result.limitations.push(`${plural(result.blockedRequests.length, "request")} to other or internal addresses ${result.blockedRequests.length === 1 ? "was" : "were"} blocked to keep the scan safe.`);
    result.limitations.push("Links that sign out, delete or unsubscribe, and file downloads, were not followed on purpose.");
    result.limitations.push("The scan does not submit forms or try multi-step journeys; the journeys below are guesses based on the page layout.");
    await context.close();
    ({ summary } = await summarise(result));
  } catch (err) {
    failed = true;
    summary = `We couldn't finish looking around your site (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).`;
    result.limitations.push(summary);
  } finally {
    await live?.stop();
    await browser.close().catch(() => {});
    // Removing the folder also ends any open live stream for this scan.
    if (d.testRunId) await fs.rm(path.join(liveDir(d.testRunId), ".."), { recursive: true, force: true });
  }

  result.coverageNote =
    `We looked at ${plural(result.pages.length, "page")}${result.inaccessible.length ? ` and couldn't open ${result.inaccessible.length} more` : ""}. ` +
    "The scan only sees pages it can reach by following links, so this is not a complete picture of your site.";
  // A cancelled scan keeps what it found but stays CANCELLED, and no checks are written for it.
  const wasCancelled = await cancelled();
  const status = wasCancelled ? "CANCELLED" : failed || result.pages.length === 0 ? "FAILED" : "COMPLETED";
  // Checks are written straight after a successful scan; PENDING is saved with COMPLETED so the page never shows a gap.
  const generate = status === "COMPLETED" && result.pages.length > 0;
  await prisma.discovery.update({
    where: { id: d.id },
    data: { status, result: str({ ...result, stoppedEarly: failed }), summary, completedAt: new Date(), ...(generate ? { generation: str({ status: "PENDING", total: 0, withScript: 0, skippedDuplicates: 0 }) } : {}) },
  });
  if (d.testRunId)
    await prisma.testRun.update({ where: { id: d.testRunId }, data: { status: status === "FAILED" ? "ERROR" : status, completedAt: new Date() } });
  await recordActivity({
    organisationId: orgId, projectId: d.projectId, actionType: "DISCOVERY_COMPLETED",
    actionStatus: status === "FAILED" ? "FAILED" : "DONE",
    message: status === "COMPLETED" ? `Site scan found ${plural(result.pages.length, "page")} on ${env.name.toLowerCase()}`
      : status === "CANCELLED" ? `Site scan cancelled after ${plural(result.pages.length, "page")}` : "Site scan stopped early",
    link: `/projects/${d.projectId}?tab=discovery`, executionReference: d.id,
  });
  if (generate) await generateChecksForScan(d.id);
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
      `Found ${plural(r.pages.length, "page")} with ${plural(forms, "form")}. ` +
      `Main menu: ${[...new Set(r.pages.flatMap((p) => p.navItems))].slice(0, 8).join(", ") || "none found"}. ` +
      (r.authRequired ? "Some pages need a sign-in. " : "") +
      "Only pages that can be reached by following links are included. (Written by rules because AI is not set up.)",
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
  if (pages.length > 1) flows.push({ name: "Browse the main pages", steps: pages.slice(0, 6).map((p) => `Visit ${p.title || p.url}`) });
  return flows.slice(0, 12);
}

export function discoveryDto(d: {
  id: string; projectId: string; environmentId: string; status: string; startedAt: Date | null; completedAt: Date | null; result: string; summary: string;
  testRunId: string | null; maxPages: number; generation: string;
}) {
  const r = parse<Partial<DiscoveryResult> & { current?: { url: string; title: string }; stoppedEarly?: boolean }>(d.result, {});
  return {
    id: d.id, projectId: d.projectId, environmentId: d.environmentId, status: d.status, startedAt: d.startedAt, completedAt: d.completedAt,
    testRunId: d.testRunId, pages: r.pages ?? [], inaccessible: r.inaccessible ?? [], authRequired: r.authRequired ?? false,
    limitations: r.limitations ?? [], workflows: r.workflows ?? [], summary: d.summary, coverageNote: r.coverageNote ?? "",
    generatedBy: r.summarySource ?? null, maxPages: d.maxPages,
    // FAILED with stoppedEarly=false means the scan worked but found no pages it could open.
    stoppedEarly: d.status === "FAILED" ? r.stoppedEarly ?? true : false,
    current: d.status === "RUNNING" ? r.current ?? null : null, generation: generationDto(d.generation),
  };
}
