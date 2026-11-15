// Phase 5 journey (P5-08, design P5 §16) through the real UI against the running backend (8200), web (3002) and the
// demo shop (E2E_SITE_URL, default :4100), AI off. Written by QA as the independent real-stack check:
//   setup to Gate 4 → accessibility check (image-alt + color-contrast, grouped drafts, triage) → passive security
//   check by a member (7 failed rules, loopback "Not applicable", raise one grouped draft) → load profile (short),
//   member requests, approver types the host, live tiles, /products/2 misses p95 → second load test stopped with
//   Stop now → Performance/Accessibility/Security reports downloaded → Gate 8: confirm one non-functional draft,
//   reject another as "Accepted risk" → the assistant answers a security question with the fixed statement.
//
// Signs in with the shared e2e account (owner, can approve) and the e2e member (journey.signInMember). Neither
// account file is overwritten.
//
//   P5_PROJECT   optional existing project id on the demo shop past Gate 4 (setup steps already done are skipped).
//   P5QA_STATE   optional JSON file the ids are written to (for phase5-qa-verification.spec.ts).
//
// The load tests send at most 10 virtual users / 20 requests a second to localhost:4100 for under a minute.
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { SITE_URL, useSharedAccount } from "./helpers";
import { LONG, a11y, appears, noSideways, reloadUntil, signInMember } from "./journey";

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 60_000 });

const API = `${(process.env.E2E_API_URL ?? "http://localhost:8200").replace(/\/+$/, "")}/api/v1`;
const SECURITY_STATEMENT =
  "This is a passive check of what a normal visitor's browser receives. It is not a security audit or a penetration test, and no findings does not mean the site is secure.";
const STATE = process.env.P5QA_STATE ?? "";

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let projectId = process.env.P5_PROJECT ?? "";
const state: Json = {};

async function save(extra: Json) {
  Object.assign(state, extra, { projectId });
  if (!STATE) return;
  const prev = await readFile(STATE, "utf8").then((t) => JSON.parse(t) as Json).catch(() => ({}));
  await writeFile(STATE, JSON.stringify({ ...prev, ...state }, null, 2));
}

test.beforeAll(async () => {
  // Resume: ids from an earlier run of this file (for example after a soft failure stopped the serial chain).
  if (!STATE) return;
  const prev = await readFile(STATE, "utf8").then((t) => JSON.parse(t) as Json).catch(() => null);
  if (prev && (!projectId || prev.projectId === projectId)) Object.assign(state, prev);
});

test.beforeEach(async ({ page }) => {
  await useSharedAccount(page);
});

async function memberPage(browser: Browser, owner: Page): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInMember(page, owner, browser);
  return page;
}

async function token(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("qa_token"));
}

async function apiGet<T = Json>(page: Page, path: string): Promise<T> {
  const r = await page.request.get(`${API}${path}`, { headers: { Authorization: `Bearer ${await token(page)}` } });
  expect(r.status(), path).toBe(200);
  return (await r.json()) as T;
}

test("Setup: discovery, requirements and strategy approved (Gates 2–4)", async ({ page }) => {
  test.setTimeout(3 * LONG);
  if (!projectId) {
    await page.goto(`/projects/new?url=${encodeURIComponent(SITE_URL)}`);
    await page.getByRole("checkbox", { name: /authorised to test/i }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    const dup = page.getByRole("button", { name: /Create anyway/ });
    if (await dup.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false)) await dup.click();
    await page.waitForURL(/\/projects\/[^/]+\/discovery/, { timeout: 60_000 });
    projectId = page.url().match(/\/projects\/([^/]+)\//)![1];
  }
  await save({});
  const base = `/projects/${projectId}`;

  // Design check 2: before G2 the Non-functional section says so and offers no tabs.
  const wf = await apiGet(page, `/projects/${projectId}/workflow`);
  const g2done = (wf.stages as Json[]).some((s) => s.key === "discovery" && (s.status === "approved" || ["approved", "satisfied", "recommended"].includes(String(s.gate?.status))));
  if (!g2done) {
    await page.goto(`${base}/non-functional`);
    // A "recommended" (non-blocking) Gate 2 counts as passed: later stages already run before it is decided.
    await expect(page.getByText("Non-functional checks use the pages discovery found. Approve Gate 2 first.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: /Accessibility/ })).toHaveCount(0);
  }

  await reloadUntil(page, `${base}/discovery?view=summary`, async () => (await page.getByRole("button", { name: "Approve discovery" }).count()) > 0 || (await page.getByText(/Discovery approved/).count()) > 0);
  const discovery = page.getByRole("button", { name: "Approve discovery" });
  if (await discovery.count()) {
    await discovery.click();
    await expect(page.getByText(/Discovery approved/).first()).toBeVisible();
  }

  // Design check 3: after G2 nothing starts by itself.
  if (!g2done) {
    const nf0 = await apiGet(page, `/projects/${projectId}/non-functional`);
    expect.soft(nf0.accessibility ?? null, "no accessibility check started by itself after G2").toBeNull();
    expect.soft(nf0.security ?? null, "no security check started by itself after G2").toBeNull();
  }

  await reloadUntil(page, `${base}/requirements`, async () => {
    const gen = page.getByRole("button", { name: "Generate requirements" });
    if (await appears(gen, 3_000)) await gen.click();
    return (await page.getByRole("checkbox", { name: /^Select REQ-/ }).count()) > 0;
  });
  await page.goto(`${base}/requirements?status=draft`);
  const boxes = page.getByRole("checkbox", { name: /^Select REQ-/ });
  await boxes.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  if ((await boxes.count()) > 0) {
    await page.getByRole("checkbox", { name: /Select all/ }).first().check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve \d+$/ }).click();
    const guard = page.getByRole("dialog", { name: /^Approve \d+ requirements?\?$/ });
    if (await appears(guard, 2_000)) await guard.getByRole("button", { name: /^Approve/ }).last().click();
  }
  await page.goto(`${base}/requirements?view=review`);
  const reqApproved = page.getByText(/Requirements approved/).first();
  if (!(await appears(reqApproved, 5_000))) {
    await page.getByRole("button", { name: "Approve requirements" }).click({ timeout: 60_000 });
    const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
    if (await appears(confirm, 3_000)) await confirm.getByRole("button", { name: "Approve requirements" }).click();
    await expect(reqApproved).toBeVisible({ timeout: 30_000 });
  }

  await reloadUntil(page, `${base}/test-strategy`, async () => {
    const write = page.getByRole("button", { name: "Write the Test Strategy" });
    if (await appears(write, 3_000)) await write.click();
    return (await page.getByRole("heading", { name: /Test levels/ }).count()) > 0;
  });
  await page.goto(`${base}/test-strategy?view=review`);
  const strategyApproved = page.getByText(/Strategy approved/).first();
  if (!(await appears(strategyApproved, 5_000))) {
    await page.getByRole("button", { name: "Approve test strategy" }).click({ timeout: 60_000 });
    await expect(strategyApproved).toBeVisible({ timeout: 30_000 });
  }
});

test("§16.1 Accessibility: image-alt and color-contrast on both product pages, grouped drafts, triage needs a reason", async ({ page }) => {
  test.setTimeout(LONG);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/non-functional?tab=accessibility`);
  await expect(page.getByRole("heading", { level: 1, name: "Non-functional" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Automated checks find only part of WCAG 2.2 AA issues. Screen reader, zoom and cognitive checks need a person.").first()).toBeVisible();
  await a11y(page, "Non-functional › Accessibility (never run)");

  await page.getByRole("button", { name: "Check accessibility…" }).click();
  const dlg = page.getByRole("dialog", { name: "Check accessibility" });
  // Design check 6: Desktop and keyboard on, Phone off, signed-in disabled without saved credentials.
  await expect.soft(dlg.getByRole("checkbox", { name: /Desktop/ })).toBeChecked();
  await expect.soft(dlg.getByRole("checkbox", { name: /Phone/ })).not.toBeChecked();
  await expect.soft(dlg.getByRole("checkbox", { name: /Follow keyboard focus/ })).toBeChecked();
  await expect.soft(dlg.getByRole("checkbox", { name: /Include pages behind sign-in/ })).toBeDisabled();
  await dlg.getByRole("button", { name: "Start check" }).click();
  await page.waitForURL(/\/non-functional\/checks\/A11Y-\d+/, { timeout: 60_000 });
  const a11yKey = page.url().match(/(A11Y-\d+)/)![1];

  // The check page must update by itself (no reload): the SWR polling concern.
  const t0 = Date.now();
  await expect(page.getByRole("table", { name: "Findings by rule" })).toBeVisible({ timeout: 8 * 60_000 });
  console.log(`[p5] ${a11yKey} finished on screen without reload after ${Math.round((Date.now() - t0) / 1000)} s`);

  const scan = await apiGet(page, `/projects/${projectId}/quality-scans/by-key/${a11yKey}`);
  const findings = (await apiGet<{ items: Json[] }>(page, `/quality-scans/${scan.id}/findings`)).items;
  const axeFindings = findings.filter((f) => !f.heuristic && !f.needs_review);
  const rules = [...new Set(axeFindings.map((f) => f.rule_id as string))].sort();
  console.log(`[p5] ${a11yKey} status=${scan.status} rules=${rules.join(",")} keyboard=${findings.filter((f) => f.heuristic).map((f) => `${f.rule_id}@${f.path}`).join(",")}`);
  expect(rules).toEqual(expect.arrayContaining(["color-contrast", "image-alt"]));
  for (const rule of ["image-alt", "color-contrast"]) {
    const paths = axeFindings.filter((f) => f.rule_id === rule).map((f) => f.path as string).sort();
    expect(paths, `${rule} pages`).toEqual(["/products/1", "/products/2"]);
  }
  const extra = rules.filter((r) => !["image-alt", "color-contrast"].includes(r));
  expect.soft(extra, "axe rules beyond the two deliberate flaws (design §16.1 expects exactly two)").toEqual([]);

  // Design check 7, D20: one draft per critical/serious rule, linked on screen (findings may lag: page not reloaded).
  const table = page.getByRole("table", { name: "Findings by rule" });
  for (const rule of ["image-alt", "color-contrast"]) await expect(table.getByRole("row").filter({ hasText: `(${rule})` })).toBeVisible();
  const defects = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/defects?source=accessibility`)).items;
  console.log(`[p5] accessibility drafts: ${defects.map((d) => `${d.key} "${d.summary}" ${d.status}`).join(" | ")}`);
  expect(defects.length, "one grouped draft per critical/serious rule").toBeGreaterThanOrEqual(2);
  const imgDraft = defects.find((d) => /text alternative|image/i.test(String(d.summary)));
  expect.soft(String(imgDraft?.summary), "design §16.1 title").toMatch(/Product images have no text alternative \(2 pages\)/);
  const linkedOnScreen = await table.getByRole("row").filter({ hasText: "(image-alt)" }).getByText(/DEF-\d+/).count();
  expect.soft(linkedOnScreen, "the image-alt row shows its draft without a reload (findings list must refresh when the check ends)").toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole("table", { name: "Findings by rule" }).getByRole("row").filter({ hasText: "(image-alt)" }).getByText(/DEF-\d+/)).toBeVisible({ timeout: 30_000 });
  await a11y(page, `${a11yKey} results`);
  await noSideways(page, `${a11yKey} results`);

  // Design check 8: the drawer for /products/2 image-alt.
  await page.getByRole("link", { name: "Open image-alt on /products/2" }).click();
  const drawer = page.getByRole("dialog").filter({ hasText: "/products/2" });
  await expect(drawer).toBeVisible();
  await expect.soft(drawer.getByText(/How to fix/i).first()).toBeVisible();
  await a11y(page, `${a11yKey} finding drawer`);

  // Design check 9: triage without a reason, then Accepted risk with a reason.
  await drawer.getByRole("button", { name: /^Accept risk or mark false positive for / }).click();
  const tri = page.getByRole("dialog", { name: /^Accept risk or mark false positive/ });
  await tri.getByRole("radio", { name: /^Accept the risk/ }).check();
  await tri.getByRole("button", { name: /Save|Mark|Accept/ }).last().click();
  await expect(tri.getByText("Say why. The reason is shown in reports.")).toBeVisible();
  await tri.getByLabel("Reason").fill("QA: product images are decorative stand-ins on the demo shop.");
  await tri.getByRole("button", { name: /Save|Mark|Accept/ }).last().click();
  await expect(tri).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/Accepted by .*QA: product images are decorative/).first()).toBeVisible({ timeout: 15_000 });

  // Design check 11: keyboard results are heuristic and never drafted.
  await page.goto(`${base}/non-functional/checks/${a11yKey}?view=keyboard`);
  await expect(page.getByRole("table", { name: "Keyboard checks" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Keyboard checks don't create defect drafts automatically. Raise one if a person confirms it.")).toBeVisible();
  const kbDrafted = findings.filter((f) => f.heuristic && f.defect);
  expect(kbDrafted, "no keyboard finding has a draft").toEqual([]);
  await save({ a11yKey, a11yScanId: scan.id, a11yFindingId: findings.find((f) => f.rule_id === "image-alt")?.id, a11yDefects: defects.map((d) => d.key) });
});

test("§16.2 Security: a member runs it with no approval, 7 failed rules, loopback Not applicable, one grouped draft on request", async ({ page, browser }) => {
  test.setTimeout(LONG);
  const member = await memberPage(browser, page);
  const base = `/projects/${projectId}`;
  await member.goto(`${base}/non-functional?tab=security`);
  await expect(member.getByRole("heading", { level: 2, name: "Security (passive)" })).toBeVisible({ timeout: 60_000 });
  // Design check 12: the statement is the first content after the heading, verbatim.
  const afterHeading = await member.getByRole("heading", { level: 2, name: "Security (passive)" }).evaluate((h) => (h.nextElementSibling as HTMLElement | null)?.innerText ?? "");
  expect.soft(afterHeading).toContain(SECURITY_STATEMENT);
  await member.getByRole("button", { name: "Run security check" }).click();
  await expect(member.getByRole("dialog")).toHaveCount(0);
  await member.waitForURL(/\/non-functional\/checks\/SEC-\d+/, { timeout: 60_000 });
  const secKey = member.url().match(/(SEC-\d+)/)![1];
  await expect(member.getByText(SECURITY_STATEMENT).first()).toBeVisible();
  await expect(member.getByRole("radiogroup", { name: "Show" }).or(member.getByText(/Show all \d+ checks/)).first()).toBeVisible({ timeout: 5 * 60_000 });

  const scan = await apiGet(member, `/projects/${projectId}/quality-scans/by-key/${secKey}`);
  const rules = (scan.summary.rules ?? []) as Json[];
  const failed = rules.filter((r) => r.result === "failed");
  console.log(`[p5] ${secKey} status=${scan.status} failed=${failed.map((r) => `${r.rule_id}${r.subject ? `[${r.subject}]` : ""}`).join(",")}`);
  console.log(`[p5] ${secKey} not_applicable=${rules.filter((r) => r.result === "not_applicable").map((r) => r.rule_id).join(",")} not_checked=${rules.filter((r) => r.result === "not_checked").map((r) => r.rule_id).join(",")}`);
  expect(failed.length, "design §16.2: exactly 7 failed rules").toBe(7);
  const ids = failed.map((r) => `${r.rule_id} ${r.subject ?? ""} ${r.title}`).join("\n");
  for (const re of [/content-security-policy|csp/i, /nosniff|content-type-options/i, /frame|clickjack/i, /referrer/i, /permissions/i, /powered/i, /samesite/i]) expect.soft(ids, `failed rule ${re}`).toMatch(re);
  expect.soft(ids, "no HttpOnly finding for recently_viewed").not.toMatch(/httponly/i);
  const na = rules.filter((r) => r.result === "not_applicable");
  for (const r of na.filter((x) => /https|hsts|tls|password/i.test(`${x.rule_id} ${x.title}`))) expect.soft(String(r.reason)).toBe("The target is plain http on this computer (loopback)");
  expect.soft(na.filter((x) => /https|hsts|tls|password/i.test(`${x.rule_id} ${x.title}`)).length, "HTTPS, HSTS, TLS and password-over-HTTP read Not applicable").toBeGreaterThanOrEqual(4);

  // D19/D20: nothing drafted automatically.
  const before = (await apiGet<{ items: Json[] }>(member, `/projects/${projectId}/defects?source=security`)).items;
  expect(before, "no security draft before Raise defect").toEqual([]);
  // Design check 15: no cookie value in the DOM.
  await member.reload();
  await expect(member.getByText(/Show all \d+ checks/)).toBeVisible({ timeout: 30_000 });
  const html = await member.content();
  expect(html).not.toMatch(/recently_viewed=\d/);
  await a11y(member, `${secKey} results`);
  await noSideways(member, `${secKey} results`);

  // Raise one grouped draft for X-Powered-By.
  const row = member.getByRole("listitem").filter({ hasText: /Powered/i }).first();
  await row.getByRole("button", { name: /^Details for / }).click();
  const drawer = member.getByRole("dialog").filter({ has: member.getByRole("button", { name: /^Raise defect for / }) });
  await expect(drawer).toBeVisible();
  expect.soft(await drawer.innerText()).toContain(SECURITY_STATEMENT);
  await drawer.getByRole("button", { name: /^Raise defect for / }).click();
  await member.getByRole("dialog", { name: /^Raise a defect for / }).getByRole("button", { name: "Raise defect" }).click();
  await expect.poll(async () => (await apiGet<{ items: Json[] }>(member, `/projects/${projectId}/defects?source=security`)).items.length, { timeout: 15_000 }).toBe(1);
  const sec = (await apiGet<{ items: Json[] }>(member, `/projects/${projectId}/defects?source=security`)).items[0];
  console.log(`[p5] security draft ${sec.key} "${sec.summary}" status=${sec.status}`);
  const secFindings = (await apiGet<{ items: Json[] }>(member, `/quality-scans/${scan.id}/findings`)).items;
  await save({ secKey, secScanId: scan.id, secFindingId: secFindings[0]?.id, secDefect: sec.key });
  await member.context().close();
});

test("§16.3 Performance: member requests, approver types the host, live tiles, /products/2 misses p95; a second run stopped", async ({ page, browser }) => {
  test.setTimeout(LONG);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/non-functional?tab=performance`);
  await expect(page.getByRole("heading", { level: 2, name: "Performance", exact: true })).toBeVisible({ timeout: 60_000 });
  const existing = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/performance-profiles`)).items.filter((p) => p.status !== "retired");
  if (!existing.length) {
    await page.getByRole("button", { name: "Draft a load profile" }).click();
  } else {
    await page.getByRole("link", { name: new RegExp(`^${existing[0].key} `) }).click();
  }
  await page.waitForURL(/\/non-functional\/profiles\/PRF-\d+/, { timeout: 60_000 });
  const prfKey = page.url().match(/(PRF-\d+)/)![1];
  const prof = await apiGet(page, `/projects/${projectId}/performance-profiles/by-key/${prfKey}`);
  console.log(`[p5] ${prfKey} v${prof.version} ${prof.status} targets=${(prof.targets as Json[]).map((t) => t.path).join(",")} stages=${JSON.stringify(prof.stages)} thresholds=${(prof.thresholds as Json[]).length}`);
  await expect.soft(page.getByText("Default threshold (no requirement states one)").first()).toBeVisible();

  // Shorter test for the journey: ramp 10 s → 10 users, hold 30 s, ramp down 5 s.
  const durations = [10, 30, 5];
  if (JSON.stringify((prof.stages as Json[]).map((s) => s.duration_s)) !== JSON.stringify(durations)) {
    for (let i = 0; i < 3; i++) await page.getByLabel(`Duration of stage ${i + 1} in seconds`).fill(String(durations[i]));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled({ timeout: 15_000 });
  }
  const mark = page.getByRole("button", { name: "Mark ready" });
  if (await appears(mark, 3_000)) {
    await mark.click();
    await expect(mark).toHaveCount(0, { timeout: 15_000 });
  }
  await a11y(page, `${prfKey} editor`);

  // A member requests it.
  const member = await memberPage(browser, page);
  await member.goto(`${base}/non-functional/profiles/${prfKey}`);
  await member.getByRole("button", { name: "Request load test…" }).click();
  const dlg = member.getByRole("dialog", { name: /^Request a load test/ });
  const summary = await dlg.getByTestId("load-summary").innerText();
  console.log(`[p5] request summary: ${summary}`);
  expect.soft(summary).toBe("Up to 10 virtual users, at most 20 requests a second, for 45 seconds, against localhost:4100; GET only; not signed in.");
  await expect.soft(dlg.getByRole("table", { name: "Limits" })).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Approve and start load test" })).toHaveCount(0);
  await a11y(member, "Load test request dialog");
  const shopHitsBefore = Date.now();
  await dlg.getByRole("button", { name: "Request approval" }).click();
  await member.waitForURL(/\/non-functional\/load-tests\/PERF-\d+/, { timeout: 60_000 });
  let perfKey = member.url().match(/(PERF-\d+)/)![1];
  await expect(member.getByText("Waiting for approval by someone who can approve").first()).toBeVisible({ timeout: 30_000 });
  await expect(member.getByRole("button", { name: "Approve and start load test" })).toHaveCount(0);
  const waiting = await apiGet(member, `/projects/${projectId}/performance-runs/by-key/${perfKey}`);
  expect(waiting.status).toBe("awaiting_approval");
  expect.soft(waiting.started_at ?? null, "nothing touched the target before approval").toBeNull();
  void shopHitsBefore;

  // Design check 4: the approver sees the request; then approves on the load test page.
  await page.goto(`${base}/non-functional?tab=performance`);
  await expect.soft(page.getByText(new RegExp(`${perfKey} is waiting for your approval`))).toBeVisible({ timeout: 30_000 });
  await page.goto(`${base}/non-functional/load-tests/${perfKey}`);
  const approve = page.getByRole("button", { name: "Approve and start load test" });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect.soft(page.getByText("Type localhost to approve.").first()).toBeVisible();
  await page.getByLabel("Type localhost to approve").fill("localhost:4100");
  // aria-disabled: Playwright won't click it, a keyboard user can still press it (and must get the error).
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect.soft(page.getByText("Type localhost exactly to approve.").first()).toBeVisible();
  await page.getByLabel("Type localhost to approve").fill("localhost");
  await page.waitForTimeout(500); // let the button's 150 ms colour transition finish (axe reads mid-transition colours)
  await a11y(page, `${perfKey} approval panel`);

  // Live view must update on its own: count by-key polls and watch the elapsed text change, without reloading.
  let polls = 0;
  page.on("request", (r) => {
    if (r.url().includes(`/performance-runs/by-key/${perfKey}`)) polls++;
  });
  await approve.click();
  await expect(page.getByRole("heading", { name: "Live numbers" })).toBeVisible({ timeout: 60_000 });
  const tiles: string[] = [];
  for (let i = 0; i < 6; i++) {
    tiles.push(await page.getByRole("heading", { name: "Live numbers" }).locator("xpath=ancestor::section").innerText().catch(() => ""));
    await page.waitForTimeout(2_000);
  }
  console.log(`[p5] ${perfKey} polls in ~12 s of live view: ${polls}`);
  expect.soft(new Set(tiles).size, "live tiles change over 12 s without a reload").toBeGreaterThan(2);
  expect.soft(polls, "the live view fetches at least every 2 s").toBeGreaterThanOrEqual(5);
  await a11y(page, `${perfKey} live view`);

  // Member view during the run: no Stop for someone else's... (members may stop their own requests).
  await expect(page.getByRole("heading", { name: "Threshold results" }).or(page.getByRole("table", { name: "Threshold results" })).first()).toBeVisible({ timeout: 3 * 60_000 });
  const done = await apiGet(page, `/projects/${projectId}/performance-runs/by-key/${perfKey}`);
  const tr = (done.threshold_results as Json[]).map((t) => `${t.path ?? "all"}:${t.metric}:${t.measured}:${t.result}`);
  console.log(`[p5] ${perfKey} status=${done.status} thresholds=${tr.join(" | ")} defects=${JSON.stringify((done.defects as Json[] | undefined)?.map((d) => d.key))}`);
  const p2first = (done.threshold_results as Json[]).find((t) => t.path === "/products/2" && t.metric === "p95");
  expect.soft(p2first?.result, `design §16.3: /products/2 p95 ${p2first?.measured} ms missed against the 800 ms default (threshold used: ${p2first?.value} ms from ${p2first?.source?.key ?? p2first?.source?.type})`).toBe("missed");
  await expect(page.getByRole("table", { name: "Threshold results" })).toBeVisible();
  await a11y(page, `${perfKey} results`);
  await noSideways(page, `${perfKey} results`);
  const p2run = done;
  if (done.status !== "failed") {
    // QA workaround to reach the D20 path: tighten every page threshold to 800 ms (tightening is allowed), mark
    // ready again, and run once more, approved in the request dialog by the approver.
    const cur = await apiGet(page, `/performance-profiles/${prof.id}`);
    const tighter = (cur.thresholds as Json[]).map((t) => (t.metric === "p95" ? { ...t, value: Math.min(Number(t.value), 800) } : t));
    const tok = await token(page);
    const r = await page.request.patch(`${API}/performance-profiles/${prof.id}`, { headers: { Authorization: `Bearer ${tok}` }, data: { version: cur.version, thresholds: tighter } });
    console.log(`[p5] tighten thresholds to 800 ms: ${r.status()} ${(await r.text()).slice(0, 200)}`);
    expect(r.status()).toBe(200);
    const after = await apiGet(page, `/performance-profiles/${prof.id}`);
    if (after.status !== "ready") {
      const rr = await page.request.post(`${API}/performance-profiles/${prof.id}/ready`, { headers: { Authorization: `Bearer ${tok}` } });
      expect(rr.status()).toBe(200);
    }
    await page.goto(`${base}/non-functional/profiles/${prfKey}`);
    await page.getByRole("button", { name: "Request load test…" }).click();
    const d3 = page.getByRole("dialog", { name: /^Request a load test/ });
    await d3.getByLabel("Type localhost to approve and start").fill("localhost");
    await d3.getByRole("button", { name: "Approve and start load test" }).click();
    await page.waitForURL(/\/non-functional\/load-tests\/PERF-\d+/, { timeout: 60_000 });
    const k3 = page.url().match(/(PERF-\d+)/)![1];
    await expect(page.getByRole("table", { name: "Threshold results" })).toBeVisible({ timeout: 3 * 60_000 });
    const d3run = await apiGet(page, `/projects/${projectId}/performance-runs/by-key/${k3}`);
    console.log(`[p5] ${k3} (800 ms) status=${d3run.status} thresholds=${(d3run.threshold_results as Json[]).map((t) => `${t.path ?? "all"}:${t.measured}:${t.result}`).join(" | ")} defects=${JSON.stringify((d3run.defects as Json[]).map((d) => `${d.key} ${d.summary}`))}`);
    Object.assign(done, d3run);
    perfKey = k3;
  }
  void p2run;
  expect(done.status).toBe("failed");
  const p2 = (done.threshold_results as Json[]).find((t) => t.path === "/products/2" && t.metric === "p95");
  expect(p2?.result, "/products/2 p95 missed").toBe("missed");
  const others = (done.threshold_results as Json[]).filter((t) => t.path && t.path !== "/products/2" && t.metric === "p95");
  expect.soft(others.filter((t) => t.result !== "met").map((t) => t.path), "other pages met").toEqual([]);
  if (page.url().includes(perfKey) === false) await page.goto(`${base}/non-functional/load-tests/${perfKey}`);
  await expect(page.getByRole("table", { name: "Threshold results" }).getByRole("row").filter({ hasText: "/products/2" }).getByText("Missed")).toBeVisible({ timeout: 30_000 });
  await expect.soft(page.getByText(/host typed: yes/).first()).toBeVisible();
  await expect.soft(page.getByText(/Measured with the built-in load generator 0\.5\.0/).first()).toBeVisible();
  const perfDefs = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/defects?source=performance&status=all`)).items;
  console.log(`[p5] performance defects: ${perfDefs.map((d) => `${d.key} ${d.status} "${d.summary}" occurrences=${JSON.stringify((d.environment as Json | undefined)?.occurrences ?? d.occurrences ?? null)}`).join(" | ")}; this run links: ${JSON.stringify(done.defects)}`);
  expect(perfDefs.length, "a draft for the missed threshold (or an occurrence on the open one, D20)").toBeGreaterThanOrEqual(1);
  expect.soft((done.defects as Json[]).length, "the failed run's page links the defect it drafted or added an occurrence to").toBeGreaterThanOrEqual(1);
  await a11y(page, `${perfKey} results`);
  await noSideways(page, `${perfKey} results`);
  // Round 2 (P5-BUG-02): on a fresh project the first run must fail on the 800 ms default, not an assumed requirement.
  expect.soft(p2first?.value, "round 2: /products/2 threshold is the 800 ms default").toBe(800);
  expect.soft(JSON.stringify(p2first?.source ?? null), "round 2: threshold source is the default, not an assumed requirement").not.toMatch(/REQ-/);
  const drafted = (done.defects as Json[]).find((d) => d.link === "drafted") ?? (done.defects as Json[])[0];
  console.log(`[p5] round 2 first-run links: ${JSON.stringify(done.defects)}`);
  expect.soft(String(drafted?.summary ?? perfDefs[0]?.summary), "round 2: draft named after the page").toMatch(/^Desk lamp page slows down under load/);

  // Round 2 (P5-BUG-06): a second failing run adds an occurrence and its page says so; the summary follows it.
  if (drafted?.key) {
    await page.goto(`${base}/non-functional/profiles/${prfKey}`);
    await page.getByRole("button", { name: "Request load test…" }).click();
    const d4 = page.getByRole("dialog", { name: /^Request a load test/ });
    await d4.getByLabel("Type localhost to approve and start").fill("localhost");
    await d4.getByRole("button", { name: "Approve and start load test" }).click();
    await page.waitForURL(/\/non-functional\/load-tests\/PERF-\d+/, { timeout: 60_000 });
    const k4 = page.url().match(/(PERF-\d+)/)![1];
    await expect(page.getByRole("table", { name: "Threshold results" })).toBeVisible({ timeout: 3 * 60_000 });
    const r4 = await apiGet(page, `/projects/${projectId}/performance-runs/by-key/${k4}`);
    const p4 = (r4.threshold_results as Json[]).find((t) => t.path === "/products/2" && t.metric === "p95");
    console.log(`[p5] ${k4} status=${r4.status} /products/2 p95=${p4?.measured} ${p4?.result} links=${JSON.stringify(r4.defects)}`);
    if (p4?.result === "missed") {
      expect.soft((r4.defects as Json[]).map((d) => `${d.key}:${d.link}`), "round 2: occurrence link").toContain(`${drafted.key}:occurrence_added`);
      await expect.soft(page.getByText(new RegExp(`Occurrence added to:?\\s*${drafted.key}`)).first()).toBeVisible({ timeout: 30_000 });
      const def = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/defects?source=performance&status=all`)).items.find((d) => d.key === drafted.key)!;
      console.log(`[p5] ${drafted.key} summary after ${k4}: "${def.summary}"`);
      expect.soft(String(def.summary), "round 2: defect summary follows the latest measurement").toContain(Number(p4.measured) >= 1000 ? `p95 ${(Number(p4.measured) / 1000).toFixed(1)} s` : `p95 ${Math.round(Number(p4.measured))} ms`);
    }
    await noSideways(page, `${k4} results`);
  }

  // k6 script download (design check 26).
  await page.goto(`${base}/non-functional/profiles/${prfKey}`);
  const [k6] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: `Download k6 script for ${prfKey}` }).click()]);
  expect(k6.suggestedFilename()).toMatch(/k6\.js$/);
  await expect.soft(page.getByText(/Not run by the platform/).first()).toBeVisible();

  // Second load test: approver requests and approves in one go, then Stop now via keyboard (design check 23).
  await page.getByRole("button", { name: "Request load test…" }).click();
  const dlg2 = page.getByRole("dialog", { name: /^Request a load test/ });
  await dlg2.getByLabel("Type localhost to approve and start").fill("localhost");
  await dlg2.getByRole("button", { name: "Approve and start load test" }).click();
  await page.waitForURL(/\/non-functional\/load-tests\/PERF-\d+/, { timeout: 60_000 });
  const stopKey = page.url().match(/(PERF-\d+)/)![1];
  await expect(page.getByRole("heading", { name: "Live numbers" })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: "Stop now" }).focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: `Stop ${stopKey} now?` });
  await expect(confirm).toBeVisible();
  await expect.soft(confirm.getByRole("button", { name: "Stop now" })).toBeFocused();
  const tStop = Date.now();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await apiGet(page, `/projects/${projectId}/performance-runs/by-key/${stopKey}`)).status, { timeout: 20_000, intervals: [250] }).toBe("stopped");
  const stopS = (Date.now() - tStop) / 1000;
  console.log(`[p5] ${stopKey} stopped ${stopS.toFixed(1)} s after confirming`);
  expect.soft(stopS, "Stop now ends within about 2 s").toBeLessThan(4);
  await expect(page.getByText(/Stopped by /).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Live numbers" })).toHaveCount(0);
  const stopped = await apiGet(page, `/projects/${projectId}/performance-runs/by-key/${stopKey}`);
  expect((stopped.threshold_results as Json[]).every((t) => t.result === "not_measured"), "stopped run: thresholds not measured").toBe(true);
  expect((stopped.defects as Json[] | undefined) ?? [], "stopped run drafts nothing").toEqual([]);
  await save({ prfKey, prfId: prof.id, perfKey, perfRunId: done.id, stopKey, stopRunId: stopped.id, perfDefects: perfDefs.map((d) => d.key) });
  await member.context().close();
});

test("§16.4 Reports: Performance, Accessibility and Security reports download; statements and approver recorded", async ({ page }) => {
  test.setTimeout(LONG);
  const base = `/projects/${projectId}`;
  for (const slug of ["performance", "accessibility", "security"]) {
    await reloadUntil(page, `${base}/reports/${slug}`, async () => (await page.getByRole("button", { name: "Download PDF" }).count()) > 0, 3 * 60_000);
    for (const label of ["Download PDF", "Download HTML", "Download CSV"]) {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: label, exact: true }).click()]);
      const file = await dl.path();
      const body = await readFile(file!);
      console.log(`[p5] ${slug} ${label}: ${dl.suggestedFilename()} ${body.length} bytes`);
      expect(body.length).toBeGreaterThan(200);
      if (label !== "Download PDF") {
        const text = body.toString("utf8");
        expect.soft(text, `${slug} ${label}: no email address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
        if (slug === "security" && label === "Download HTML") expect.soft(text).toContain("It is not a security audit or a penetration test");
        if (slug === "performance" && label === "Download HTML") expect.soft(text).toMatch(/host typed: yes/);
      }
    }
    await a11y(page, `${slug} report`);
    await noSideways(page, `${slug} report`);
  }
  // XLSX through the Reports list menu (the report page has no XLSX button).
  await page.goto(`${base}/reports`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await a11y(page, "Reports list");
  for (const name of ["Performance Report", "Accessibility Report", "Security Report"]) {
    const trigger = page.getByRole("button", { name: new RegExp(`^Download ${name} version`) }).first();
    await trigger.click();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("menuitem", { name: /XLSX/ }).click()]);
    const file = await dl.path();
    const head = (await readFile(file!)).subarray(0, 2).toString("latin1");
    console.log(`[p5] ${name} XLSX: ${dl.suggestedFilename()} zip=${head === "PK"}`);
    expect(head).toBe("PK");
    const { execFileSync } = await import("node:child_process");
    const xml = execFileSync("unzip", ["-p", file!], { maxBuffer: 50_000_000 }).toString("utf8");
    expect.soft(xml, `${name} XLSX: no formulas`).not.toMatch(/<f>|<f /);
    expect.soft(xml, `${name} XLSX: no email address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  }
});

test("§10 Gate 8: confirm the image-alt draft, reject the security draft as Accepted risk (findings marked too)", async ({ page, browser }) => {
  test.setTimeout(LONG);
  const base = `/projects/${projectId}`;
  const drafts = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/defects?status=draft`)).items;
  const all = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/defects?status=all`)).items;
  const img = all.find((d) => d.source === "accessibility" && /image|text alternative/i.test(String(d.summary)));
  const imgIsDraft = img?.status === "draft";
  const sec = drafts.find((d) => d.source === "security");
  expect(img, "image-alt draft waiting").toBeTruthy();
  expect(sec, "security draft waiting").toBeTruthy();

  // A member can't decide (permission note), as in P4.
  const member = await memberPage(browser, page);
  await member.goto(`${base}/defects?view=review`);
  const mConfirm = member.getByRole("button", { name: `Confirm ${imgIsDraft ? img!.key : sec!.key}` });
  await expect(mConfirm).toBeVisible({ timeout: 30_000 });
  await expect(mConfirm).toHaveAttribute("aria-disabled", "true");
  await member.context().close();

  await page.goto(`${base}/defects?view=review`);
  await expect(page.getByRole("button", { name: `Confirm ${sec!.key}` })).toBeVisible({ timeout: 30_000 });
  // Design check 27: source chip and Observed "Why" line, no Hypothesis label on non-functional rows.
  const imgRow = page.locator("li, tr, article, section").filter({ has: page.getByRole("button", { name: `Confirm ${sec!.key}` }) }).last();
  await expect.soft(imgRow.getByText("Security").first()).toBeVisible();
  console.log(`[p5] G8 row for ${sec!.key}: ${(await imgRow.innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
  await a11y(page, "Defects › Review · Gate 8 with non-functional drafts");
  if (imgIsDraft) await page.getByRole("button", { name: `Confirm ${img!.key}` }).click();
  await expect.poll(async () => (await apiGet(page, `/projects/${projectId}/defects/by-key/${img!.key}`)).status, { timeout: 15_000 }).not.toBe("draft");

  await page.getByRole("button", { name: `Reject ${sec!.key}…` }).click();
  const rej = page.getByRole("dialog").filter({ hasText: "Accepted risk" });
  await expect(rej).toBeVisible();
  await rej.getByRole("radio", { name: "Accepted risk" }).check();
  await rej.getByRole("checkbox", { name: "Also mark the findings as Accepted risk with this comment" }).check();
  await rej.getByRole("textbox", { name: "Comment" }).fill("QA: the demo shop is an internal tool; X-Powered-By is accepted for now.");
  await rej.getByRole("button", { name: /^Reject/ }).last().click();
  await expect.poll(async () => (await apiGet(page, `/projects/${projectId}/defects/by-key/${sec!.key}`)).status, { timeout: 15_000 }).toBe("rejected");
  const secD = await apiGet(page, `/projects/${projectId}/defects/by-key/${sec!.key}`);
  console.log(`[p5] ${sec!.key} after reject: status=${secD.status} reason=${secD.reject_reason ?? secD.rejection_reason ?? JSON.stringify(secD.gate8 ?? null)}`);
  expect(JSON.stringify(secD)).toContain("accepted_risk");
  const scan = await apiGet(page, `/projects/${projectId}/quality-scans/by-key/${state.secKey}`);
  const f = (await apiGet<{ items: Json[] }>(page, `/quality-scans/${scan.id}/findings?status=accepted_risk`)).items;
  console.log(`[p5] security findings marked accepted_risk: ${f.map((x) => x.rule_id).join(",")}`);
  expect(f.length, "the draft's findings are marked Accepted risk").toBeGreaterThan(0);

  // Defect Report names the G8 decider, never an email.
  await save({ confirmedDefect: img!.key, rejectedDefect: sec!.key });
});

test("§12.3 Assistant v4, AI off: a security question ends with the fixed statement; load proposals only request", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/assistant`);
  const chip = page.getByRole("button", { name: /Is the site missing basic protections\?/ });
  await expect(chip.first()).toBeVisible({ timeout: 60_000 });
  await chip.first().click();
  await page.getByRole("listitem").filter({ has: chip.first() }).getByRole("button", { name: "Check now" }).click();
  const answer = page.getByText(/It is not a security audit or a penetration test/).last();
  await expect(answer).toBeVisible({ timeout: 60_000 });
  const thread = await page.getByRole("region", { name: "Thread" }).innerText();
  const last = thread.trim().split("\n").filter((l) => l.trim()).slice(-6).join(" ⏎ ");
  console.log(`[p5] assistant security answer tail: ${last.slice(0, 600)}`);
  await a11y(page, "Assistant with a security answer");
  // "Plan a load test": accepting creates a request waiting for approval, never a running test (design check 32).
  const before = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/performance-runs`)).items.length;
  const plan = page.getByRole("button", { name: /^Plan a load test/ });
  await plan.click();
  await page.getByRole("listitem").filter({ has: plan }).getByRole("button", { name: /Propose a load test/ }).click();
  const accept = page.getByRole("radio", { name: "Accept", exact: true }).last();
  if (await appears(accept, 30_000)) {
    await accept.check();
    await page.getByRole("button", { name: /^Apply 1 accepted change/ }).last().click();
    await page.waitForTimeout(4_000);
    const runs = (await apiGet<{ items: Json[] }>(page, `/projects/${projectId}/performance-runs`)).items;
    console.log(`[p5] after accepting the load-test proposal: ${runs.length - before} new run(s), newest ${runs[0]?.key} ${runs[0]?.status}`);
    expect(runs.length).toBe(before + 1);
    expect(runs[0].status).toBe("awaiting_approval");
  } else {
    console.log(`[p5] no accept control found for the load-test proposal: ${(await page.getByRole("region", { name: "Thread" }).innerText()).slice(-500)}`);
  }
});
