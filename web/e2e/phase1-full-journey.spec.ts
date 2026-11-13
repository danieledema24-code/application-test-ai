// Phase 1 independent QA verification (roadmap P1-16): the whole journey through the real UI against the
// running backend (8200), web (3002) and a demo site. Collects evidence (screenshots, downloads, a findings JSON)
// into P1_SHOTS / P1_DOWNLOADS. Uses soft assertions so one run records every failure, not just the first.
//
//   P1_TARGET   demo site URL. Default http://localhost:4100/ (round 2: the client defers loopback to the server
//               when the backend reports allow_private_targets).
//   P1_PART     "1" = sign up → Gate 1 → discovery done (registers account A),
//               "2" = continue as account A from P1_ACCOUNTS (no new sign-up; needs user B in the file for the
//                     cross-organisation UI check), unset = both.
//   P1_SHOTS, P1_DOWNLOADS, P1_ACCOUNTS (credentials file, *.local.txt; never printed)
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

const TARGET = process.env.P1_TARGET ?? "http://localhost:4100/";
const PART = process.env.P1_PART;
const SCRATCH = "/private/tmp/claude-501/-Users-danieledema-football-predictor/716cc19a-68a4-4b9a-b61c-cb2d9406cfc3/scratchpad";
const SHOTS = process.env.P1_SHOTS ?? `${SCRATCH}/p1-shots`;
const DOWNLOADS = process.env.P1_DOWNLOADS ?? `${SCRATCH}/p1-downloads`;
const ACCOUNTS = process.env.P1_ACCOUNTS ?? `${SCRATCH}/p1-accounts.local.txt`;
const RESULTS = `${SCRATCH}/p1-results-part${PART ?? "all"}.json`;
const API = "http://localhost:8200/api/v1";

const results: Record<string, unknown> = {};
async function note(k: string, v: unknown) {
  results[k] = v;
  await writeFile(RESULTS, JSON.stringify(results, null, 2));
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function axeSerious(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function accounts() {
  const out: Record<string, { email: string; password: string }> & { project?: string } = {};
  for (const line of (await readFile(ACCOUNTS, "utf8")).split("\n")) {
    const [k, a, b] = line.trim().split(/\s+/);
    if (k === "A" || k === "B") out[k] = { email: a, password: b };
    if (k === "project") out.project = a;
  }
  return out;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
}

function collectors(page: Page) {
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror ${page.url()} :: ${e.message.slice(0, 300)}`));
  page.context().on("request", (r: Request) => requests.push(r.url()));
  const axeByScreen: Record<string, string[]> = {};
  const a11y = async (screen: string) => {
    axeByScreen[screen] = await axeSerious(page);
    await note("axe", axeByScreen);
    expect.soft(axeByScreen[screen], `axe serious/critical on ${screen}`).toEqual([]);
  };
  return { consoleErrors, requests, a11y };
}

/** Discovery finished: either the stage waits for G2 (policy required) or completed (policy recommended). */
async function waitForDiscoveryFinished(page: Page, projectUrl: string) {
  await page.goto(projectUrl);
  await expect(page.getByText(/Waiting for your approval|Discovery done/).first()).toBeVisible({ timeout: 15 * 60_000 });
}

test.describe.configure({ mode: "serial" });

test("part 1: sign up → dashboard → Gate 1 → live discovery → done", async ({ page }) => {
  test.skip(PART === "2", "part 2 only");
  test.setTimeout(30 * 60_000);
  await mkdir(SHOTS, { recursive: true });
  await mkdir(DOWNLOADS, { recursive: true });
  const { consoleErrors, a11y } = collectors(page);

  const A = { email: `p1qa-a-${Date.now()}@example.com`, password: `P1-${randomBytes(12).toString("base64url")}` };
  await writeFile(ACCOUNTS, `A ${A.email} ${A.password}\n`, { mode: 0o600 });
  await page.goto("/register");
  await a11y("register");
  await page.getByLabel("Full name").fill("Quinn Analyst");
  await page.getByLabel("Work email").fill(A.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(A.password);
  await page.getByLabel("Organisation name").fill("Phase One QA Org");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome, Quinn");
  await expect.soft(page.getByText("What happens next")).toBeVisible();
  await expect.soft(page.getByText("Recent projects")).toHaveCount(0);
  await shot(page, "01-dashboard-empty");
  await a11y("dashboard-empty");

  const url = page.getByLabel("Website URL");
  const start = page.getByRole("button", { name: "Start QA Analysis" });
  await url.fill(TARGET);
  await expect.soft(page.getByText(/Reachable|Blocked|Unreachable/).first()).toBeVisible({ timeout: 60_000 });
  await start.click();
  await expect(page).toHaveURL(/\/projects\/new\?url=/);
  await expect(page.getByText("Reachable").first()).toBeVisible({ timeout: 60_000 });
  await a11y("new-project");
  await start.click();
  await expect.soft(page.getByText("Confirm you're authorised to test this site.")).toBeVisible();
  await expect.soft(page.getByRole("checkbox", { name: /I am authorised to test this site/ })).toBeFocused();
  await page.getByRole("checkbox", { name: /I am authorised to test this site/ }).check();
  await page.getByRole("button", { name: /scan settings/i }).click();
  await page.getByLabel("Maximum pages").fill("10");
  await start.click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/discovery/, { timeout: 60_000 });
  const projectUrl = page.url().replace(/\/discovery.*$/, "");
  await appendFile(ACCOUNTS, `project ${projectUrl.split("/projects/")[1]}\n`);
  // Live view: the feed fills from the stream without a reload; snapshot early to catch running-state UI.
  await page.waitForTimeout(1200);
  await shot(page, "06-live-discovery-early");
  await note("live_early_text", (await page.locator("main").innerText()).slice(0, 2000));
  const liveFeed = page.getByRole("list", { name: "Agent events, newest first" });
  await expect.soft(liveFeed.getByRole("listitem").first(), "live feed populates without reload").toBeVisible({ timeout: 60_000 });
  await note("live_feed_rows", { rows: await liveFeed.getByRole("listitem").count(), top: (await liveFeed.getByRole("listitem").allInnerTexts()).slice(0, 8) });
  await note("live_indicator", await page.getByText(/^(Live|Connecting…|Reconnecting… Missed events will catch up\.|Live updates stopped\.)$/).allInnerTexts());
  await shot(page, "07-live-discovery-feed");
  await waitForDiscoveryFinished(page, projectUrl);
  await note("after_finish_text", (await page.locator("main").innerText()).slice(0, 2500));
  await shot(page, "08a-overview-after-finish");
  await note("console_errors_part1", consoleErrors);
});

test("part 2: results, evidence, report, re-scan, Gate 2, downloads, isolation, sign out", async ({ page, browser }) => {
  test.skip(PART === "1", "part 1 only");
  test.setTimeout(45 * 60_000);
  await mkdir(SHOTS, { recursive: true });
  await mkdir(DOWNLOADS, { recursive: true });
  const acc = await accounts();
  const { consoleErrors, requests, a11y } = collectors(page);
  await signIn(page, acc.A.email, acc.A.password);
  const token = await page.evaluate(() => localStorage.getItem("qa_token"));
  const projectUrl = `/projects/${acc.project}`;
  const auth = { Authorization: `Bearer ${token}` };

  // ---- Dashboard with a project: numbers vs API -----------------------------------------------------------
  await page.waitForTimeout(2500);
  await note("dashboard_with_project", (await page.locator("main").innerText()).slice(0, 3000));
  const dash = await (await fetch(`${API}/dashboard`, { headers: auth })).json().catch(() => null);
  await note("dashboard_api", dash);
  await shot(page, "20-dashboard-with-project");
  await a11y("dashboard-with-project");

  // ---- Overview: G2 under the default ("recommended") policy ---------------------------------------------
  await page.goto(projectUrl);
  await page.waitForTimeout(2500);
  await note("overview_default_policy", (await page.locator("main").innerText()).slice(0, 3500));
  await note("lifecycle_default_policy", await page.getByRole("list", { name: "QA lifecycle" }).first().innerText().catch(() => "n/a"));
  await shot(page, "08-overview-default-policy");
  await a11y("overview-completed");
  await page.getByRole("button", { name: "Show all 21 steps" }).click().catch(() => undefined);
  await note("lifecycle_21_steps", (await page.locator("main").innerText()).slice(0, 5000));
  await shot(page, "09-overview-21-steps");

  await page.goto(`${projectUrl}/discovery?view=summary`);
  await page.waitForTimeout(2000);
  await note("g2_default_policy_approve_buttons", await page.getByRole("button", { name: "Approve discovery" }).count());
  // Design §8.4 / §14 #28 and P1-15: the user can approve Gate 2 after discovery. Recorded as a soft failure.
  await expect.soft(page.getByRole("button", { name: "Approve discovery" }), "G2 approvable under default policy").toBeVisible({ timeout: 5_000 });

  // ---- Result views ---------------------------------------------------------------------------------------
  for (const v of ["summary", "sitemap", "functionality", "journeys", "responsive", "gaps"]) {
    await page.goto(`${projectUrl}/discovery?view=${v}`);
    await page.waitForTimeout(2500);
    await note(`view_${v}`, (await page.locator("main").innerText()).slice(0, 7000));
    await note(`view_${v}_labels`, {
      observed: await page.getByText(/^Observed/).count(),
      inferred: await page.getByText(/^Inferred/).count(),
      evidenceControls: await page.getByRole("button", { name: /evidence/i }).count(),
      evidenceMissing: await page.getByText("Evidence missing").count(),
    });
    await shot(page, `10-view-${v}`);
    await a11y(`discovery-${v}`);
  }
  // ---- UI vs API: journey step labels, access-gap count, responsive content ------------------------------------
  {
    const scans = await (await fetch(`${API}/projects/${acc.project}/scans`, { headers: auth })).json();
    const sid = scans.items[0].id;
    const apiJourneys = await (await fetch(`${API}/scans/${sid}/journeys`, { headers: auth })).json();
    const sd = await (await fetch(`${API}/scans/${sid}`, { headers: auth })).json();
    await page.goto(`${projectUrl}/discovery?view=journeys`);
    await page.waitForTimeout(2500);
    const mismatches: string[] = [];
    for (const j of apiJourneys) {
      const steps = page.getByRole("list", { name: `Steps of ${j.name}` }).getByRole("listitem");
      const uiLabels = await steps.evaluateAll((els) => els.map((e) => (/Inferred/.test(e.textContent ?? "") ? "inferred" : /Observed/.test(e.textContent ?? "") ? "observed" : "?")));
      const apiLabels = j.steps.map((st: { label: string }) => st.label);
      if (JSON.stringify(uiLabels) !== JSON.stringify(apiLabels)) mismatches.push(`${j.name}: ui=${uiLabels} api=${apiLabels}`);
    }
    await note("journey_label_mismatches", mismatches);
    expect.soft(mismatches, "journey step labels match API").toEqual([]);
    await page.goto(`${projectUrl}/discovery?view=gaps`);
    await page.waitForTimeout(2500);
    const tabText = await page.getByRole("tab", { name: /Access gaps/ }).innerText();
    const rows = await page.locator("main table tbody tr").count();
    await note("gaps_ui_vs_api", { tab: tabText, rows, api_access_gaps: sd.access_gaps?.length, api_auth_boundaries: sd.auth_boundaries?.length, stats: sd.stats?.access_gaps, evidenceMissing: await page.getByText("Evidence missing").count() });
    expect.soft(tabText.replace(/\D/g, ""), "access-gap tab count equals API").toBe(String(sd.access_gaps?.length));
    await page.goto(`${projectUrl}/discovery?view=responsive`);
    await page.waitForTimeout(3000);
    const respText = (await page.locator("main").innerText()).slice(-1200);
    await note("responsive_tail", respText);
    expect.soft(respText.replace(/\s+/g, " ").trim().endsWith("Only pages with differences"), "responsive view not blank").toBe(false);
  }

  await page.goto(`${projectUrl}/discovery?view=sitemap`);
  await page.waitForTimeout(1500);
  const tree = page.getByRole("tree", { name: "Sitemap" });
  if (await tree.count()) {
    const first = tree.getByRole("treeitem").first();
    await first.focus();
    await page.keyboard.press("End");
    await expect.soft(tree.getByRole("treeitem").last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect.soft(first).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    await note("page_detail_drawer", (await page.getByRole("dialog").innerText().catch(() => "no dialog")).slice(0, 3000));
    await shot(page, "11-page-detail");
    await page.keyboard.press("Escape");
  }
  await page.getByRole("radio", { name: "List" }).click().catch(() => undefined);
  await note("sitemap_list", (await page.locator("main").innerText()).slice(0, 3000));

  // ---- Evidence drawer: screenshot + DOM as escaped text -------------------------------------------------
  await page.goto(`${projectUrl}/discovery?view=summary`);
  await page.waitForTimeout(2000);
  const evLinks = page.getByRole("button", { name: /evidence/i });
  await note("summary_evidence_controls", await evLinks.evaluateAll((els) => els.slice(0, 12).map((e) => e.getAttribute("aria-label") || e.textContent?.trim())));
  // "Contact form" observation's evidence (screenshot + DOM).
  const contactEv = page.getByRole("button", { name: /evidence/i }).nth(1);
  await contactEv.click();
  const drawer = page.getByRole("dialog");
  await expect.soft(drawer).toBeVisible();
  await page.waitForTimeout(2500);
  await note("evidence_drawer_1", (await drawer.innerText().catch(() => "")).slice(0, 2500));
  await note("evidence_drawer_img", await drawer.locator("img").evaluateAll((els) => els.map((e) => ({ alt: e.getAttribute("alt"), loaded: (e as HTMLImageElement).naturalWidth > 0, src: (e as HTMLImageElement).src.replace(/sig=[^&]+/, "sig=…") }))));
  await shot(page, "13-evidence-drawer");
  // Step through the drawer's evidence items looking for a DOM snippet.
  const items = drawer.getByRole("radio");
  const nItems = await items.count();
  let domChecked = false;
  for (let i = 0; i < nItems && !domChecked; i++) {
    await items.nth(i).click().catch(() => undefined);
    await page.waitForTimeout(1500);
    const pre = page.getByLabel("DOM snippet, shown as text");
    if (await pre.count()) {
      domChecked = true;
      await note("dom_snippet", (await pre.innerText()).slice(0, 1500));
      await expect.soft(pre.locator("a, script, form, input, button")).toHaveCount(0);
      await shot(page, "13b-evidence-dom");
    }
  }
  await note("evidence_dom_checked", { domChecked, nItems });
  await page.keyboard.press("Escape");

  // ---- Report v1 (Draft) ----------------------------------------------------------------------------------
  await page.goto(`${projectUrl}/reports/discovery`);
  await expect(page.getByRole("heading", { level: 1, name: "Application Discovery Report" })).toBeVisible({ timeout: 120_000 });
  await expect.soft(page.getByText("Discovery observes the user interface only. Backend behaviour, data handling and security have not been verified.").first()).toBeVisible();
  await note("report_v1_text", (await page.locator("main").innerText()).slice(0, 15000));
  await shot(page, "14-report-draft");
  await a11y("report-draft");
  for (const fmt of ["PDF", "HTML", "JSON"]) {
    const btn = page.getByRole("button", { name: `Download ${fmt}` });
    if (!(await btn.count())) {
      await note(`scan1_download_${fmt}`, "button missing");
      continue;
    }
    const dl = page.waitForEvent("download", { timeout: 120_000 });
    await btn.click();
    if (fmt === "PDF") await note("pdf_button_while_preparing", await btn.innerText().catch(() => ""));
    const f = await dl;
    await note(`scan1_download_${fmt}`, f.suggestedFilename());
    await f.saveAs(path.join(DOWNLOADS, `scan1-draft-${f.suggestedFilename()}`));
  }

  // ---- Gate 2 under the DEFAULT policy: keyboard approve on Scan 1 ------------------------------------------------
  await page.goto(`${projectUrl}/discovery?view=summary`);
  await page.waitForTimeout(2500);
  if (await page.getByRole("button", { name: "Approve discovery" }).count()) {
    await page.getByLabel("Comment").focus();
    await page.keyboard.type("Default policy: public demo shop covered.");
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      await page.keyboard.press("Tab");
      ok = (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Approve discovery";
    }
    await note("default_policy_approve_by_tab", ok);
    if (ok) await page.keyboard.press("Enter");
    else await page.getByRole("button", { name: "Approve discovery" }).click();
    await expect.soft(page.getByText(/by Quinn Analyst, .* · “Default policy: public demo shop covered\.”/)).toBeVisible({ timeout: 30_000 });
    await note("default_policy_focus_after_approve", await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200)));
    await shot(page, "15a-gate2-approved-default-policy");
    await page.goto(`${projectUrl}/reports/discovery`);
    await expect(page.getByRole("heading", { level: 1, name: "Application Discovery Report" })).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(2500);
    await note("report_scan1_after_default_approval", (await page.locator("main").innerText()).slice(0, 900));
    const dl = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "Download PDF" }).click();
    const f = await dl;
    await f.saveAs(path.join(DOWNLOADS, `scan1-approved-${f.suggestedFilename()}`));
  }

  // ---- Duplicate URL warning + Create anyway; pause on a fresh scan -------------------------------------------
  await page.goto(`/projects/new?url=${encodeURIComponent(TARGET)}`);
  await expect(page.getByText("Reachable").first()).toBeVisible({ timeout: 60_000 });
  await note("dup_before_submit", (await page.locator("main").innerText()).slice(0, 1500));
  await page.getByRole("checkbox", { name: /I am authorised to test this site/ }).check();
  await page.getByRole("button", { name: "Start QA Analysis" }).click();
  await expect.soft(page.getByText(/You already have a project for/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "21-duplicate-warning");
  await note("dup_warning_text", (await page.locator("main").innerText()).slice(0, 2000));
  const createAnyway = page.getByRole("button", { name: "Create anyway" });
  if (await createAnyway.count()) {
    await createAnyway.click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/discovery/, { timeout: 60_000 });
    const p2 = page.url().replace(/\/discovery.*$/, "");
    await appendFile(ACCOUNTS, `project2 ${p2.split("/projects/")[1]}\n`);
    const pause = page.getByRole("button", { name: /Pause analysis|Pausing…/ });
    const canPause = await pause.isVisible().catch(() => false);
    await note("p2_pause_visible_immediately", canPause);
    await shot(page, "22-project2-live");
    await note("p2_live_text", (await page.locator("main").innerText()).slice(0, 2500));
    if (canPause) {
      await pause.click();
      await page.waitForTimeout(3000);
      await note("p2_after_pause", (await page.locator("main").innerText()).slice(0, 1500));
      await shot(page, "23-project2-paused");
    }
  }

  // ---- Make G2 "required" (API), re-scan through the UI → Scan 2 waits for approval ----------------------------
  const pd = await (await fetch(`${API}/projects/${acc.project}`, { headers: auth })).json();
  const patch = await fetch(`${API}/projects/${acc.project}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ version: pd.version, approval_policy: { ...pd.approval_policy, G2: "required" } }),
  });
  await note("patch_g2_required", patch.status);
  await page.goto(projectUrl);
  await page.waitForTimeout(2500);
  const ovFeed = page.getByRole("list", { name: "Agent events, newest first" });
  const before = await ovFeed.getByRole("listitem").count();
  await note("feed_rows_before_rescan", before);
  await page.getByRole("button", { name: "More project actions" }).click();
  await page.getByRole("menuitem", { name: /Re-scan site/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  await note("rescan_dialog", (await dlg.innerText()).slice(0, 1500));
  await shot(page, "24-rescan-dialog");
  await dlg.getByRole("button", { name: "Start re-scan" }).click();
  await expect.soft(page.getByText("Re-scan started.")).toBeVisible({ timeout: 30_000 });
  // Without reloading, new rows must stream in (SSE through CORS).
  const t0 = Date.now();
  await expect.soft.poll(async () => ovFeed.getByRole("listitem").count(), { timeout: 60_000, message: "feed streams new rows" }).toBeGreaterThan(before + 5);
  await note("feed_stream", { before, after: await ovFeed.getByRole("listitem").count(), ms: Date.now() - t0, top: (await ovFeed.getByRole("listitem").allInnerTexts()).slice(0, 6) });
  await note("feed_indicator", await page.getByText(/^(Live|Connecting…|Reconnecting… Missed events will catch up\.|Live updates stopped\.)$/).allInnerTexts());
  await shot(page, "25-rescan-live-feed");
  await page.goto(projectUrl);
  await expect(page.getByText("Waiting for your approval").first()).toBeVisible({ timeout: 15 * 60_000 });
  await note("overview_waiting", (await page.locator("main").innerText()).slice(0, 3500));
  await note("lifecycle_waiting", await page.getByRole("list", { name: "QA lifecycle" }).first().innerText().catch(() => "n/a"));
  await shot(page, "26-overview-g2-waiting");
  await a11y("overview-g2-waiting");

  // Draft report for Scan 2, before approval.
  await page.goto(`${projectUrl}/reports/discovery?scan=2`);
  await expect(page.getByRole("heading", { level: 1, name: "Application Discovery Report" })).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  await note("report_scan2_draft_header", (await page.locator("main").innerText()).slice(0, 1200));
  {
    const dl = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "Download PDF" }).click();
    const f = await dl;
    await note("scan2_draft_pdf", f.suggestedFilename());
    await f.saveAs(path.join(DOWNLOADS, `scan2-draft-${f.suggestedFilename()}`));
  }

  // ---- Gate 2 by keyboard: Review gate → comment → Approve ---------------------------------------------------
  await page.goto(projectUrl);
  const review = page.getByRole("link", { name: "Review gate" }).first();
  await review.focus();
  await page.keyboard.press("Enter");
  await expect.soft(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  await shot(page, "27-gate2-waiting-panel");
  await a11y("discovery-g2-waiting");
  const comment = page.getByLabel("Comment");
  await comment.focus();
  await page.keyboard.type("Public demo shop covered; the sign-in area is an accepted gap for now.");
  // Reach Approve with Tab only (no mouse).
  let reached = false;
  for (let i = 0; i < 6 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Approve discovery";
  }
  await note("approve_reached_by_tab", reached);
  expect.soft(reached, "Approve discovery reachable by Tab from the comment").toBe(true);
  if (reached) await page.keyboard.press("Enter");
  else await page.getByRole("button", { name: "Approve discovery" }).click();
  await expect.soft(page.getByText(/by Quinn Analyst, .* · “Public demo shop covered/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await note("focus_after_approve", await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300)));
  await note("gate2_approved_text", (await page.locator("main").innerText()).slice(0, 3000));
  await shot(page, "15-gate2-approved");
  await page.goto(projectUrl);
  await page.waitForTimeout(2500);
  await note("lifecycle_approved", await page.getByRole("list", { name: "QA lifecycle" }).first().innerText().catch(() => "n/a"));
  await shot(page, "16-overview-approved");

  // ---- Scan selector: both scans; older one read-only ------------------------------------------------------------
  await page.goto(`${projectUrl}/discovery`);
  await page.waitForTimeout(2000);
  await note("scan_options", await page.getByLabel("Scan").locator("option").allInnerTexts().catch(() => []));
  await page.goto(`${projectUrl}/discovery?scan=1&view=summary`);
  await page.waitForTimeout(2500);
  await note("scan1_view", (await page.locator("main").innerText()).slice(0, 1500));
  await note("scan1_approve_buttons", await page.getByRole("button", { name: "Approve discovery" }).count());
  await shot(page, "28-scan1-older");

  // ---- Report after approval: PDF/HTML/JSON -----------------------------------------------------------------------
  await page.goto(`${projectUrl}/reports/discovery?scan=2`);
  await expect(page.getByRole("heading", { level: 1, name: "Application Discovery Report" })).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(2500);
  await note("report_scan2_approved_header", (await page.locator("main").innerText()).slice(0, 1500));
  await shot(page, "17-report-approved");
  await a11y("report-approved");
  for (const fmt of ["PDF", "HTML", "JSON"]) {
    const btn = page.getByRole("button", { name: `Download ${fmt}` });
    if (!(await btn.count())) {
      await note(`scan2_download_${fmt}`, "button missing");
      continue;
    }
    const dl = page.waitForEvent("download", { timeout: 120_000 });
    await btn.click();
    const f = await dl;
    await note(`scan2_download_${fmt}`, f.suggestedFilename());
    await f.saveAs(path.join(DOWNLOADS, `scan2-approved-${f.suggestedFilename()}`));
  }
  await page.goto(`${projectUrl}/reports`);
  await page.waitForTimeout(2000);
  await note("reports_list", (await page.locator("main").innerText()).slice(0, 2000));
  await shot(page, "29-reports-list");

  // ---- Unbuilt sections ----------------------------------------------------------------------------------------
  const nav = page.getByRole("navigation", { name: "Project sections" });
  await note("project_nav_links", await nav.getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || e.textContent?.trim())));
  const unbuilt: Record<string, unknown> = {};
  for (const slug of ["requirements", "test-strategy", "test-cases", "automation", "execution", "performance", "defects", "traceability", "assistant"]) {
    await page.goto(`${projectUrl}/${slug}`);
    await page.waitForTimeout(1000);
    unbuilt[slug] = { text: (await page.locator("main").innerText()).slice(-420).replace(/\s+/g, " "), tables: await page.locator("main table").count(), status: await page.title() };
  }
  await note("unbuilt_sections", unbuilt);
  await shot(page, "18-coming-in-phase");
  await a11y("coming-in-phase");

  // ---- Another organisation's user sees nothing of org A in the UI -------------------------------------------------
  if (acc.B) {
    const ctxB = await browser.newContext();
    const pb = await ctxB.newPage();
    await signIn(pb, acc.B.email, acc.B.password);
    await pb.waitForTimeout(2000);
    await note("B_dashboard", (await pb.locator("main").innerText()).slice(0, 1200));
    const axeB = await axeSerious(pb);
    await note("axe_B_dashboard_empty", axeB);
    expect.soft(axeB).toEqual([]);
    await pb.goto(`${projectUrl}`);
    await pb.waitForTimeout(3000);
    await note("B_opens_A_project", (await pb.locator("main").innerText()).slice(0, 600));
    await pb.screenshot({ path: path.join(SHOTS, "30-other-org-project-not-found.png") });
    await pb.goto(`${projectUrl}/reports/discovery`);
    await pb.waitForTimeout(3000);
    await note("B_opens_A_report", (await pb.locator("main").innerText()).slice(0, 600));
    await ctxB.close();
  }

  // ---- Sign out, Back, old token, sign in again ----------------------------------------------------------------------
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.soft(page.getByText("You’ve signed out.")).toBeVisible();
  await shot(page, "19-signed-out");
  await page.goBack();
  await page.waitForTimeout(2500);
  await note("after_back", { url: page.url(), text: (await page.locator("body").innerText()).slice(0, 300) });
  const old = await fetch(`${API}/auth/me`, { headers: auth });
  await note("old_token_me_status", old.status);
  expect.soft(old.status).toBe(401);
  await page.goto("/register");
  await page.waitForTimeout(1000);
  await a11y("register");
  await page.goto("/login");
  await a11y("login");
  await signIn(page, acc.A.email, acc.A.password);

  // ---- Network + console ----------------------------------------------------------------------------------------------
  const newToken = await page.evaluate(() => localStorage.getItem("qa_token"));
  const leaks = requests.filter((u) => (token && u.includes(token)) || (newToken && u.includes(newToken)) || /[?&](token|access_token|auth|bearer)=/i.test(u));
  await note("token_in_url", leaks);
  expect.soft(leaks).toEqual([]);
  await note("distinct_api_paths", [...new Set(requests.filter((u) => u.includes(":8200/")).map((u) => u.replace(/\?.*$/, "").replace(/[0-9a-f-]{36}/g, "{id}")))]);
  await note("console_errors", consoleErrors);
  await note("console_cors_errors", consoleErrors.filter((e) => /CORS/.test(e)).length);
  expect.soft(consoleErrors.filter((e) => /CORS/.test(e)), "no CORS errors").toEqual([]);
  await note("request_count", requests.length);
});
