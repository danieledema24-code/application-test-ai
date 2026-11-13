// Full end-to-end journey through the web UI, as a brand-new user would do it.
// Sign up -> sign out/in -> project -> site scan -> checks -> approve & run -> results -> download reports.
//
// Usage (from api/, with web on :3002, API on :4000 and the demo shop on :4100 already running):
//   node test/ui-full-journey.mjs
// Env overrides: WEB_URL, API_URL, TARGET_URL, SHOTS_DIR, DOWNLOADS_DIR, HEADED=1
//
// The API is used only to diagnose (read run results to compare against the downloads) and, if a UI
// step is blocked, as a clearly-labelled workaround so later steps can still be tested.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const WEB = process.env.WEB_URL ?? "http://localhost:3002";
const API = process.env.API_URL ?? "http://localhost:4000/api";
const TARGET = process.env.TARGET_URL ?? "http://localhost:4100";
const OUT = process.env.OUT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", ".runs", "ui-journey");
const SHOTS = process.env.SHOTS_DIR ?? join(OUT, "shots");
const DL = process.env.DOWNLOADS_DIR ?? join(OUT, "downloads");
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DL, { recursive: true });

const stamp = Date.now();
const email = `qa+${stamp}@example.com`;
const password = `Qa-${randomBytes(9).toString("base64url")}!`;
const fullName = "Quinn Newuser";
const org = `QA Journey ${stamp}`;
// Credentials go to a gitignored *.local.txt file, never to stdout.
appendFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "ui-journey-account.local.txt"), `${new Date().toISOString()} ${email} ${password}\n`);

const results = []; // { id, name, status: PASS|FAIL|BLOCKED|WORKAROUND, evidence }
const notes = []; // UX/observations
const consoleErrors = [];
const failedRequests = [];
let shotN = 0;

function record(id, name, status, evidence = "") {
  results.push({ id, name, status, evidence });
  console.log(`${status.padEnd(10)} ${id} ${name}${evidence ? ` — ${evidence}` : ""}`);
}
function note(s) {
  notes.push(s);
  console.log(`   note: ${s}`);
}
async function shot(page, label) {
  const file = join(SHOTS, `${String(++shotN).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}
async function step(id, name, page, fn) {
  try {
    const ev = await fn();
    record(id, name, "PASS", ev ?? "");
    return true;
  } catch (e) {
    const f = await shot(page, `FAIL-${id}`);
    record(id, name, "FAIL", `${(e?.message ?? String(e)).split("\n")[0].slice(0, 300)} [${f}]`);
    return false;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function apiGet(token, path) {
  const r = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, data: await r.json().catch(() => null) };
}
/** Wait until an <img> matching `sel` has painted a frame (naturalWidth > 0). Returns {count, painted}. */
async function livePainted(page, sel, ms = 15000) {
  const t = Date.now();
  for (;;) {
    const st = await page.locator(sel).evaluateAll((els) => els.map((i) => i.naturalWidth)).catch(() => []);
    if (st.some((w) => w > 0) || Date.now() - t > ms) return { count: st.length, painted: st.filter((w) => w > 0).length };
    await page.waitForTimeout(500);
  }
}
const getToken = (page) => page.evaluate(() => localStorage.getItem("ata_token"));

const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push({ url: page.url(), text: m.text().slice(0, 300) });
});
page.on("pageerror", (e) => consoleErrors.push({ url: page.url(), text: `pageerror: ${e.message.slice(0, 300)}` }));
page.on("requestfailed", (r) => {
  const err = r.failure()?.errorText ?? "";
  // Aborted fetches (SWR revalidation on navigation, live-frame polling) are normal client behaviour.
  if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(err)) return;
  failedRequests.push({ url: r.url(), method: r.method(), error: err });
});
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().includes("/_next/")) failedRequests.push({ url: r.url(), method: r.request().method(), error: `HTTP ${r.status()}`, at: page.url() });
});

let projectId = null, scanId = null, runId = null, token = null, scanCounts = null;

// ---------------------------------------------------------------- 1. Sign up
await step("1.1", "Open app redirects a signed-out visitor to sign-in", page, async () => {
  await page.goto(WEB);
  await page.waitForURL(/\/login/);
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  return `${page.url()} [${await shot(page, "login")}]`;
});
await step("1.2", "Sign-up form rejects a short password with a clear message", page, async () => {
  await page.getByRole("link", { name: "Create a workspace" }).click();
  await page.waitForURL(/\/register/);
  await page.getByLabel(/^Full name/).fill(fullName);
  await page.getByLabel(/^Work email/).fill(email);
  await page.getByLabel(/^Password/).fill("short");
  await page.getByLabel(/^Organisation/).fill(org);
  await page.getByRole("button", { name: "Create workspace" }).click();
  // Native minLength validation may block submit before the JS check; either way we must stay here.
  await page.waitForTimeout(800);
  assert(/\/register/.test(page.url()), "short password was accepted");
  const msg = await page.getByLabel(/^Password/).evaluate((el) => el.validationMessage);
  const inline = await page.getByText("Password must be at least 8 characters.").isVisible().catch(() => false);
  return `stayed on /register; message: ${inline ? "inline 'Password must be at least 8 characters.'" : `browser tooltip '${msg}'`}`;
});
await step("1.3", "Create a workspace with a fresh account lands on the dashboard", page, async () => {
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  await page.getByRole("button", { name: "Test a site" }).waitFor();
  return `${email} -> /dashboard, empty-state 'Test a site' shown [${await shot(page, "dashboard-empty")}]`;
});

// ---------------------------------------------------------------- 2. Sign out / in
await step("2.1", "Sign out from the user menu", page, async () => {
  await page.getByRole("button", { name: /Open user menu/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForURL(/\/login/);
  const tok = await getToken(page);
  assert(!tok, "token still in localStorage after logout");
  return "back on /login, token cleared";
});
await step("2.2", "Protected page after sign-out redirects to sign-in", page, async () => {
  await page.goto(`${WEB}/dashboard`);
  await page.waitForURL(/\/login/, { timeout: 10000 });
  return page.url();
});
await step("2.3", "Wrong password is rejected with a clear message", page, async () => {
  await page.getByLabel(/^Work email/).fill(email);
  await page.getByLabel(/^Password/).fill("definitely-wrong-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  const alert = page.locator('[role="alert"]').filter({ hasText: /./ }).first();
  await alert.waitFor({ timeout: 10000 });
  const text = (await alert.innerText()).trim();
  assert(/invalid|incorrect|wrong|password/i.test(text), `unclear message: '${text}'`);
  assert(/\/login/.test(page.url()), "navigated away despite wrong password");
  return `message: '${text}' [${await shot(page, "wrong-password")}]`;
});
await step("2.4", "Sign back in with the right password", page, async () => {
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/);
  token = await getToken(page);
  assert(token, "no token after login");
  return "/dashboard";
});

// ---------------------------------------------------------------- 3. Project
await step("3.1", "Create a project for the demo shop (permission box left unticked)", page, async () => {
  await page.getByRole("button", { name: "Test a site" }).click();
  const dlg = page.getByRole("dialog", { name: "Test a new site" });
  await dlg.waitFor();
  await dlg.getByLabel(/^Website address/).fill(TARGET);
  await shot(page, "new-project-modal");
  await dlg.getByRole("button", { name: "Create and continue" }).click();
  await page.waitForURL(/\/projects\/[^/?]+/);
  projectId = page.url().match(/\/projects\/([^/?#]+)/)[1];
  return `project ${projectId} [${await shot(page, "project-overview")}]`;
});
await step("3.2", "Site scan tab asks for permission, and confirming it unlocks the scan form", page, async () => {
  await page.getByRole("tab", { name: "Site scan" }).click();
  const btn = page.getByRole("button", { name: /I have permission/ });
  await btn.waitFor();
  await shot(page, "permission-prompt");
  await btn.click();
  await page.getByRole("button", { name: "Scan my site" }).waitFor();
  const env = (await apiGet(token, `/projects/${projectId}`)).data.environments[0];
  assert(env.authorised === true, "environment not authorised in API");
  return `env ${env.baseUrl} authorised [${await shot(page, "scan-form")}]`;
});

// ---------------------------------------------------------------- 4. Scan
let sawLive = false;
await step("4.1", "Start a scan; live view appears while scanning", page, async () => {
  await page.getByRole("button", { name: "Scan my site" }).click();
  const live = page.getByText("This is the browser we’re using to look around your site.");
  await live.waitFor({ timeout: 30000 });
  sawLive = true;
  // Give the live frame a moment to receive a first image.
  // A small site scans in a few seconds, so watch for a painted frame until the scan leaves the live stage.
  let lp = { count: 0, painted: 0 };
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const st = await page.locator('img[alt^="Live view of the browser scanning"]').evaluateAll((els) => els.map((i) => i.naturalWidth)).catch(() => []);
    lp = { count: Math.max(lp.count, st.length), painted: Math.max(lp.painted, st.filter((w) => w > 0).length) };
    if (lp.painted) { await shot(page, "scan-live-frame"); break; }
    if (!(await live.isVisible())) break;
    await page.waitForTimeout(150);
  }
  const hasImg = `${lp.count} img seen, ${lp.painted} painted, live stage lasted ~${Math.round((Date.now() - t0) / 1000)} s`;
  if (!lp.painted) note(`Scan live view: the scan finished before any browser frame was painted in the UI (live panel visible ~${Math.round((Date.now() - t0) / 1000)} s); the API did serve frames.`);
  const progress = await page.getByRole("progressbar", { name: "Pages found" }).getAttribute("aria-valuetext").catch(() => null);
  const btnText = await page.locator('form button[type="submit"]').first().innerText();
  return `live panel shown, frame image: ${hasImg}, progress '${progress}', button '${btnText.trim()}' [${await shot(page, "scan-live")}]`;
});
await step("4.2", "Scan completes and 'Your checks are ready' shows counts", page, async () => {
  const heading = page.getByRole("heading", { name: "Your checks are ready" });
  // Capture the 'writing checks' stage if we catch it.
  const writing = page.getByRole("progressbar", { name: "Checks written" });
  if (await writing.isVisible({ timeout: 60000 }).catch(() => false)) await shot(page, "scan-writing-checks");
  await heading.waitFor({ timeout: 300000 });
  const panel = page.locator("div").filter({ has: heading }).filter({ hasText: "with an automated test" }).last();
  const text = (await panel.innerText()).replace(/\s+/g, " ");
  const total = Number(text.match(/(\d+)\s*step-by-step/)?.[1]);
  const withScript = Number(text.match(/(\d+)\s*with an automated test/)?.[1]);
  assert(total > 0, `no total count in panel: ${text.slice(0, 200)}`);
  assert(withScript >= 0, "no automated count");
  scanCounts = { total, withScript };
  const latest = (await apiGet(token, `/projects/${projectId}/discovery`)).data;
  const d = Array.isArray(latest) ? latest[0] : latest;
  scanId = d?.id ?? null;
  return `${total} step-by-step checks, ${withScript} with an automated test. "${text.match(/We wrote[^.]*\./)?.[0] ?? ""}" [${await shot(page, "scan-ready")}]`;
});
if (!scanId) {
  // Find the scan id from the 'See the checks' link if the list endpoint shape differs.
  const href = await page.getByRole("link", { name: /See the checks/ }).first().getAttribute("href").catch(() => null);
  scanId = href?.match(/scan=([^&]+)/)?.[1] ?? null;
}
if (scanId && scanCounts) {
  const d = (await apiGet(token, `/discovery/${scanId}`)).data;
  if (d?.generation) {
    const ok = d.generation.total === scanCounts.total && d.generation.withScript === scanCounts.withScript;
    record("4.3", "Ready-panel counts match the API's generation record", ok ? "PASS" : "FAIL", `UI ${scanCounts.total}/${scanCounts.withScript} vs API ${d.generation.total}/${d.generation.withScript}; ${d.pages?.length} pages scanned`);
  }
}

// ---------------------------------------------------------------- 5. Checks
let caseUrl = null;
await step("5.1", "'See the checks' opens the Test Cases tab filtered to this scan", page, async () => {
  await page.getByRole("link", { name: /See the checks/ }).first().click();
  await page.waitForURL(/tab=test-cases/);
  await page.locator('a[href^="/test-cases/"]').first().waitFor();
  const rows = await page.locator('a[href^="/test-cases/"]').count();
  assert(/scan=/.test(page.url()), "scan filter not in URL");
  assert(rows === scanCounts?.total, `list shows ${rows} rows, panel said ${scanCounts?.total}`);
  return `${rows} checks listed, all filtered to scan [${await shot(page, "checks-list")}]`;
});
await step("5.2", "A check has numbered steps, expected results, links and an automation script", page, async () => {
  // Prefer a check that has a script (code icon) so the automation section can be verified.
  const withScript = page.locator("tr").filter({ has: page.locator('[aria-label="Has automation script"]') }).locator('a[href^="/test-cases/"]').first();
  const link = (await withScript.count()) ? withScript : page.locator('a[href^="/test-cases/"]').first();
  const title = (await link.innerText()).trim();
  await link.click();
  await page.waitForURL(/\/test-cases\//);
  caseUrl = page.url();
  const stepsHeading = page.getByText(/^Steps \(\d+\)$/);
  await stepsHeading.waitFor();
  const n = Number((await stepsHeading.innerText()).match(/\d+/)[0]);
  const expectedLabels = await page.getByText("Expected", { exact: true }).count();
  const body = await page.locator("main").innerText();
  const hasUrl = body.includes(TARGET);
  const overall = await page.getByText("Overall expected result").isVisible().catch(() => false);
  const script = page.getByText("Automation script", { exact: false }).first();
  const hasScriptSection = await script.isVisible().catch(() => false);
  await script.scrollIntoViewIfNeeded().catch(() => {});
  const code = await page.locator("textarea, pre").evaluateAll((els) => els.map((e) => e.value ?? e.textContent).find((t) => /\btest\(/.test(t)) ?? "");
  const f = await shot(page, "check-detail");
  assert(n >= 2, `only ${n} steps`);
  assert(expectedLabels >= n, `only ${expectedLabels} 'Expected' labels for ${n} steps`);
  assert(hasUrl, `no ${TARGET} link in the steps`);
  assert(hasScriptSection, "no Automation script section");
  assert(/test\(|page\./.test(code), "automation section shows no script code");
  return `'${title}': ${n} numbered steps, ${expectedLabels} expected results, overall expected: ${overall}, URL to ${TARGET} present, script ${code.split("\n").length} lines [${f}]`;
});
await step("9.1", "Refreshing the check page keeps it loaded (no auth loss)", page, async () => {
  await page.reload();
  await page.getByText(/^Steps \(\d+\)$/).waitFor();
  return "reloaded OK";
});
await step("9.2", "Browser back returns to the filtered check list", page, async () => {
  await page.goBack();
  await page.waitForURL(/tab=test-cases/);
  await page.locator('a[href^="/test-cases/"]').first().waitFor();
  return page.url().replace(WEB, "");
});

// ---------------------------------------------------------------- 6. Approve & run
await step("6.1", "'Approve all and run' approves the drafts and opens the run dialog", page, async () => {
  await page.goto(`${WEB}/projects/${projectId}?tab=discovery`);
  const btn = page.getByRole("link", { name: /Approve all and run|Run these checks/ });
  await btn.waitFor({ timeout: 30000 });
  await btn.click();
  const dlg = page.getByRole("dialog", { name: "Run tests" });
  await dlg.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // let the eligible list load
  const submit = dlg.getByRole("button", { name: /^Run \d* ?checks$/ });
  const label = (await submit.innerText()).trim();
  const f = await shot(page, "run-dialog");
  const cases = (await apiGet(token, `/projects/${projectId}/test-cases?scan=${scanId}`)).data;
  const approved = cases.filter((c) => c.status === "APPROVED").length;
  assert(approved === cases.length, `${approved}/${cases.length} approved`);
  assert(/\d/.test(label), `run button shows no count: '${label}'`);
  return `${approved}/${cases.length} approved; button '${label}' [${f}]`;
});
await step("6.2", "Start the run; live view and progress appear", page, async () => {
  const dlg = page.getByRole("dialog", { name: "Run tests" });
  await dlg.getByRole("button", { name: /^Run \d* ?checks$/ }).click();
  await page.waitForURL(/\/test-runs\/[^/]+$/, { timeout: 30000 });
  runId = page.url().split("/").pop();
  const status = page.getByText(/updating every 2 seconds/);
  const sawStatus = await status.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const liveHeading = page.getByText("Live view", { exact: true });
  const sawLiveView = await liveHeading.waitFor({ timeout: 20000 }).then(() => true, () => false);
  const lp = await livePainted(page, 'img[alt^="Live browser for"]');
  if (sawLiveView && !lp.painted) note(`Run live view: ${lp.count} worker <img>(s) but none painted a frame within 15 s (black boxes).`);
  const f = await shot(page, "run-live");
  assert(sawStatus || sawLiveView, "neither progress status nor live view seen");
  if (!sawLiveView) note("Run page: the 'Live view' panel did not appear within 20 s of starting an automated run.");
  return `run ${runId}; progress text: ${sawStatus}; live view: ${sawLiveView}; frames ${lp.count} img / ${lp.painted} painted [${f}]`;
});
await step("9.3", "Refreshing the run page mid-run keeps showing progress", page, async () => {
  await page.reload();
  await page.getByText(/Results \(\d+\)/).waitFor();
  const stillActive = await page.getByText(/updating every 2 seconds/).isVisible().catch(() => false);
  return `reloaded; still running: ${stillActive} [${await shot(page, "run-after-refresh")}]`;
});
await step("6.3", "Run completes with a plain-language outcome", page, async () => {
  const done = page.getByText(/problems? found in \d+ checks?|All \d+ checks? passed/);
  await done.waitFor({ timeout: 600000 });
  return `'${(await done.innerText()).trim()}' [${await shot(page, "run-finished")}]`;
});

// ---------------------------------------------------------------- 7. Results
let runData = null;
await step("7.1", "Pass/fail counts on the page match the recorded results", page, async () => {
  runData = (await apiGet(token, `/test-runs/${runId}`)).data;
  const counts = runData.results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  const group = page.getByRole("group", { name: "Filter results by status" });
  const chips = (await group.innerText()).replace(/\s+/g, " ");
  const uiCount = (label) => Number(chips.match(new RegExp(`${label} (\\d+)`))?.[1] ?? 0);
  assert(uiCount("All") === runData.results.length, `All chip ${uiCount("All")} vs ${runData.results.length}`);
  assert(uiCount("Passed") === (counts.PASSED || 0), `Passed chip ${uiCount("Passed")} vs ${counts.PASSED}`);
  assert(uiCount("Failed") === (counts.FAILED || 0), `Failed chip ${uiCount("Failed")} vs ${counts.FAILED}`);
  return `chips '${chips}'; API ${JSON.stringify(counts)}; summary ${JSON.stringify(runData.summary)}`;
});
await step("7.2", "The contact-form bug (Message not required) is reported as a failure with evidence", page, async () => {
  const bad = runData.results.filter((r) => ["FAILED", "ERROR"].includes(r.status));
  const contact = bad.find((r) => /contact|message/i.test(`${r.testCaseTitle} ${r.errorMessage}`));
  assert(contact, `no failing contact/message check. Failures: ${bad.map((r) => r.testCaseTitle).join(" | ") || "none"}`);
  const row = page.locator("li").filter({ has: page.getByRole("button", { name: new RegExp(contact.testCaseKey) }) }).first();
  const btn = row.getByRole("button", { name: new RegExp(contact.testCaseKey) });
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  const panel = row.locator(`[id="result-${contact.id}"]`);
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  const imgs = panel.locator("img");
  await imgs.first().waitFor({ timeout: 10000 }).catch(() => {});
  const nImg = await imgs.count();
  const loaded = nImg ? await imgs.first().evaluate((i) => i.complete && i.naturalWidth > 0) : false;
  const ptext = (await panel.innerText()).replace(/\s+/g, " ");
  const f = await shot(page, "contact-failure-detail");
  assert(nImg > 0 && loaded, `screenshot evidence missing or not loading (imgs=${nImg}, loaded=${loaded})`);
  return `${contact.testCaseKey} '${contact.testCaseTitle}' ${contact.status}; error: '${(contact.errorMessage || "").slice(0, 140)}'; ${nImg} image(s), first loaded=${loaded}; panel text starts '${ptext.slice(0, 160)}' [${f}]`;
});

await step("7.3", "Blocked checks explain why they couldn't run", page, async () => {
  const blocked = runData.results.filter((r) => r.status === "BLOCKED");
  if (!blocked.length) return "no blocked results";
  const r0 = blocked[0];
  const btn = page.getByRole("button", { name: new RegExp(r0.testCaseKey) });
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
  const panel = page.locator(`[id="result-${r0.id}"]`);
  await panel.waitFor();
  const t = (await panel.innerText()).replace(/\s+/g, " ");
  const f = await shot(page, "blocked-detail");
  assert(/log ?in|sign ?in|credential|password/i.test(t), `no reason shown: '${t.slice(0, 200)}'`);
  return `${blocked.map((b) => b.testCaseKey).join(", ")} blocked; reason (API): '${(r0.errorMessage || r0.actualResult || "").slice(0, 160)}' [${f}]`;
});

// ---------------------------------------------------------------- 8. Downloads
const downloads = [];
async function saveDownload(dl, label) {
  const name = dl.suggestedFilename();
  const path = join(DL, `${label}-${name}`);
  await dl.saveAs(path);
  const failure = await dl.failure();
  const size = statSync(path).size;
  downloads.push({ label, name, path, size, failure });
  return { name, path, size, failure };
}
async function generateReport(format, scopeRun) {
  await page.getByRole("button", { name: "Generate report" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Generate report" });
  await dlg.waitFor();
  if (scopeRun) {
    const sel = dlg.getByLabel(/^Test run/);
    await page.waitForTimeout(800);
    const opt = await sel.locator("option").filter({ hasText: runData?.key ?? "" }).first().getAttribute("value");
    await sel.selectOption(opt);
  }
  await dlg.getByLabel(format, { exact: true }).check();
  await dlg.getByRole("button", { name: "Generate" }).click();
  const link = dlg.getByRole("link", { name: `Download ${format}` });
  await link.waitFor({ timeout: 60000 });
  await shot(page, `report-${format}-ready`);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), link.click()]);
  const out = await saveDownload(dl, `report-${scopeRun ? "run" : "project"}-${format}`);
  // Clicking a plain link may navigate the page; make sure we're still in the app.
  if (!page.url().startsWith(WEB)) note(`Clicking 'Download ${format}' navigated away to ${page.url()}`);
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  await dlg.waitFor({ state: "hidden" });
  return out;
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

await step("8.1", "Reports tab: generate a run PDF report and download it", page, async () => {
  await page.goto(`${WEB}/projects/${projectId}?tab=reports`);
  await page.getByRole("button", { name: "Generate report" }).first().waitFor();
  await shot(page, "reports-empty");
  const d = await generateReport("PDF", true);
  const buf = readFileSync(d.path);
  assert(!d.failure, `download failed: ${d.failure}`);
  assert(buf.subarray(0, 4).toString() === "%PDF", "not a PDF");
  assert(d.size > 2000, `PDF only ${d.size} bytes`);
  const txt = buf.toString("latin1");
  assert(txt.includes("%%EOF"), "PDF has no %%EOF trailer");
  return `${d.name} ${d.size} bytes, starts %PDF, has %%EOF`;
});
await step("8.2", "Reports tab: generate a run CSV report; rows and statuses match the run", page, async () => {
  const d = await generateReport("CSV", true);
  assert(!d.failure, `download failed: ${d.failure}`);
  const rows = parseCsv(readFileSync(d.path, "utf8"));
  const header = rows[0];
  assert(header.includes("Status") && header.includes("Test case"), `header: ${header.join("|")}`);
  const iKey = header.indexOf("Test case"), iSt = header.indexOf("Status");
  const blank = rows.findIndex((r, i) => i > 0 && r.every((c) => c === ""));
  const data = rows.slice(1, blank > 0 ? blank : undefined).filter((r) => r.length >= header.length);
  const fromCsv = Object.fromEntries(data.map((r) => [r[iKey], r[iSt]]));
  const fromApi = Object.fromEntries(runData.results.map((r) => [r.testCaseKey, r.status]));
  const mism = Object.keys(fromApi).filter((k) => fromCsv[k] !== fromApi[k]);
  const summary = Object.fromEntries(rows.filter((r) => r.length === 2 && r[0]).map((r) => [r[0], r[1]]));
  assert(data.length === runData.results.length, `${data.length} CSV rows vs ${runData.results.length} results`);
  assert(mism.length === 0, `status mismatch for ${mism.join(",")}`);
  assert(Number(summary.Passed) === runData.summary.passed, `CSV Passed ${summary.Passed} vs ${runData.summary.passed}`);
  return `${d.name} ${d.size} bytes, ${data.length} result rows, all statuses match; summary Passed=${summary.Passed} Failed=${summary.Failed} Pass%=${summary["Pass %"]}`;
});
await step("8.3", "Whole-project PDF report from the report list's Download link", page, async () => {
  await page.goto(`${WEB}/projects/${projectId}?tab=reports`);
  await page.getByRole("button", { name: "Generate report" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Generate report" });
  await dlg.getByLabel("PDF", { exact: true }).check();
  await dlg.getByRole("button", { name: "Generate" }).click();
  await dlg.getByRole("link", { name: "Download PDF" }).waitFor({ timeout: 60000 });
  await dlg.getByRole("button", { name: "Close", exact: true }).click();
  const rowLinks = page.getByRole("link", { name: /^Download .*\(PDF\)$/ });
  await rowLinks.first().waitFor();
  const n = await rowLinks.count();
  const f = await shot(page, "reports-list");
  const [dl] = await Promise.all([page.waitForEvent("download"), rowLinks.first().click()]);
  const d = await saveDownload(dl, "report-list-PDF");
  const buf = readFileSync(d.path);
  assert(buf.subarray(0, 4).toString() === "%PDF" && d.size > 2000, `bad PDF ${d.size} bytes`);
  return `${n} PDF rows listed; downloaded ${d.name} ${d.size} bytes [${f}]`;
});
await step("8.4", "Test Cases tab: Export CSV downloads all checks with steps and expected results", page, async () => {
  await page.goto(`${WEB}/projects/${projectId}?tab=test-cases`);
  await page.locator('a[href^="/test-cases/"]').first().waitFor();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Export CSV/ }).click()]);
  const d = await saveDownload(dl, "testcases");
  const rows = parseCsv(readFileSync(d.path, "utf8")).filter((r) => r.some((c) => c));
  const header = rows[0];
  const cases = (await apiGet(token, `/projects/${projectId}/test-cases`)).data;
  const keys = new Set(rows.slice(1).map((r) => r[header.findIndex((h) => /^(ID|Key|Test case)$/i.test(h))] ?? r[0]));
  const missing = cases.filter((c) => ![...keys].some((k) => k === c.key)).map((c) => c.key);
  assert(header.some((h) => /Expected/i.test(h)), `no Expected column: ${header.join("|")}`);
  assert(missing.length === 0, `CSV missing ${missing.length} cases: ${missing.slice(0, 5).join(",")}`);
  return `${d.name} ${d.size} bytes, ${rows.length - 1} data rows for ${cases.length} cases; columns: ${header.join(" | ")}`;
});
await step("8.5", "Test Cases tab: Download Playwright project (zip)", page, async () => {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Download Playwright project/ }).click()]);
  const d = await saveDownload(dl, "playwright");
  const buf = readFileSync(d.path);
  assert(buf.subarray(0, 2).toString() === "PK", "not a zip");
  assert(buf.toString("latin1").includes("playwright.config.ts"), "no playwright.config.ts in zip");
  return `${d.name} ${d.size} bytes, zip with playwright.config.ts`;
});

// ---------------------------------------------------------------- 9. Sanity
await step("9.4", "Refreshing the project page on a deep tab keeps the tab", page, async () => {
  await page.goto(`${WEB}/projects/${projectId}?tab=reports`);
  await page.reload();
  const sel = await page.getByRole("tab", { name: "Reports" }).getAttribute("aria-selected");
  assert(sel === "true", "Reports tab not selected after reload");
  return "Reports tab still selected";
});
await step("9.5", "Back from the run page returns to the previous page", page, async () => {
  await page.goto(`${WEB}/test-runs/${runId}`);
  await page.getByText(/Results \(\d+\)/).waitFor();
  await page.goBack();
  await page.waitForURL(/tab=reports/);
  return page.url().replace(WEB, "");
});

// The deliberate wrong-password attempt (step 2.3) is expected to produce one 401 and its console line.
const expected401 = (u) => /\/auth\/login$/.test(u);
const appErrors = consoleErrors.filter((e) => !(/status of 401/.test(e.text) && /\/login/.test(e.url)));
const realFailed = failedRequests.filter((r) => !/\/live\//.test(r.url) && !(r.error === "HTTP 401" && expected401(r.url)));
record("9.6", "No console errors across the journey", appErrors.length ? "FAIL" : "PASS", `${appErrors.length} unexpected error(s) (${consoleErrors.length} total incl. the expected 401 from the wrong-password check)`);
record("9.7", "No unexpected failed network requests", realFailed.length ? "FAIL" : "PASS", `${failedRequests.length} failed/4xx+ request(s), ${realFailed.length} excluding live-frame polling`);

await browser.close();
const summary = { email, projectId, scanId, runId, scanCounts, runSummary: runData?.summary, results, notes, consoleErrors, failedRequests, downloads, shots: SHOTS };
writeFileSync(join(OUT, "journey-result.json"), JSON.stringify(summary, null, 2));
const by = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
console.log(`\n${JSON.stringify(by)}  — details in ${join(OUT, "journey-result.json")}`);
if (consoleErrors.length) console.log("console errors:\n" + consoleErrors.map((e) => ` ${e.url} :: ${e.text}`).join("\n"));
if (failedRequests.length) console.log("failed requests:\n" + failedRequests.map((e) => ` ${e.method} ${e.url} :: ${e.error} (on ${e.at ?? ""})`).join("\n"));
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
