// Phase 6 exploratory workspace and live session (P6-03c; D29, D30; design P6 §9, §16, §17, §19 checks 23–30, 43–45)
// against the stubbed API (./fixtures.ts + the phase 2–4 fixtures + ./phase6-explore-fixtures.ts, test-only): the
// Runs/Exploratory tabs, the start dialog (limits inline, signed-in approval with the typed host), one session at a
// time (aria-disabled reason, 409, double click), the live view (refresh ≤ 2 s, Pause updates, Stop now), results
// (findings with steps and screenshots, Blocked/Not tried/Never reached, the statement), every end state, viewers,
// the organisation limits, defects from exploration, axe, keyboard and 375 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec, type ExecState } from "./phase4-exec-fixtures";
import { demoSession, mockExplore, newExplore, runningSession, session, unreachedSession, waitingSession, type ExploreState } from "./phase6-explore-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<ExploreState> = {}, exec?: (e: ExecState) => void) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newExplore(over);
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const e = newExec({ role: q.role, canApprove: q.canApprove });
  exec?.(e);
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }), newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, e);
  await mockExplore(page, s, q, p4);
  await signedIn(page, s);
  return q;
}

const TAB = "/projects/p1/execution?tab=exploratory";
const EXP = (k: string) => `/projects/p1/execution/exploratory/${k}`;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const STATEMENT_60 = "This session tried 60 actions on 3 pages within its budget. Exploration is a sample, not a complete test, and it never submits forms or sends data.";
const posts = (q: ExploreState) => q.requests.filter((r) => r.method === "POST" && r.path === "/projects/p1/exploratory-sessions");

test.describe("Phase 6 · exploratory workspace (P6-03c)", () => {
  test("Test Execution has Runs and Exploratory tabs; EXP-0001 is listed with status, findings and budget; the limits line (§9.1, check 23)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/execution");
    const tabs = page.getByRole("tablist", { name: "Test Execution views" });
    await expect(tabs.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
    await tabs.getByRole("tab", { name: /Exploratory/ }).click();
    await expect(page).toHaveURL(/tab=exploratory/);
    await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Exploratory testing" })).toBeVisible();
    // The tab carries the count of open findings.
    await expect(tabs.getByRole("tab", { name: /Exploratory/ })).toContainText("2");
    const table = page.getByRole("table", { name: "Exploratory sessions" });
    const row = table.getByRole("row", { name: /EXP-0001/ });
    await expect(row).toContainText("New and changed pages from CHG-0001 (3)");
    await expect(row).toContainText("Finished · budget used");
    await expect(row).toContainText("2 (2 medium)");
    await expect(row).toContainText("60 of 60 actions");
    await expect(row).toContainText("M. Member · —");
    await expect(page.getByText("Limits: up to 60 actions and 10 minutes per session in this organisation.")).toBeVisible();
    // Sidebar: Test Execution highlighted; no "Phase 6" placeholder left.
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: /^Test Execution/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Phase 6")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("before Gate 2 the Exploratory tab says 'Approve Gate 2 first' and offers no Explore (check 23)", async ({ page }) => {
    await setup(page, { g2: false, sessions: [] });
    await page.goto(TAB);
    await expect(page.getByText("Exploration uses the pages discovery found. Approve Gate 2 first.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review Gate 2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Explore…" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("start dialog: change-set charter preselected, limits inline, over-limit and whole-number errors with focus, What it does (§9.2, check 24)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(TAB);
    await page.getByRole("button", { name: "Explore…" }).click();
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await expect(dialog.getByRole("radio", { name: "New and changed pages from CHG-0001 (3 pages)" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /Pages with open defects \(0 pages\)/ })).toBeDisabled();
    await expect(dialog.getByText("No page has an open defect.")).toBeVisible();
    const actions = dialog.getByRole("textbox", { name: "Actions" });
    await expect(actions).toHaveValue("60");
    await expect(actions).toHaveAccessibleDescription("Your organisation allows up to 60. This server allows up to 200.");
    await expect(dialog.getByRole("textbox", { name: "Minutes" })).toHaveAccessibleDescription("Your organisation allows up to 10. This server allows up to 20.");
    await expect(dialog.getByRole("heading", { name: "What it does" })).toBeVisible();
    await expect(dialog.getByText("Never types, selects, uploads, submits forms or downloads files.")).toBeVisible();
    await expect(dialog.getByText(/Blocks every request the page tries to send other than reading/)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await actions.fill("61");
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText("Your organisation allows up to 60 actions.")).toBeVisible();
    await expect(actions).toBeFocused();
    await actions.fill("1.5");
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText("Enter a whole number of actions (1 or more).")).toBeVisible();
    expect(posts(q)).toHaveLength(0);
    // Chosen pages: discovered pages only, ineligible ones with the reason; at least one page.
    await actions.fill("30");
    await dialog.getByRole("radio", { name: "Chosen pages…" }).check();
    await expect(dialog.getByRole("checkbox", { name: "/logout" })).toBeDisabled();
    await expect(dialog.getByText("looks like a sign-out link")).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "/account" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText("Choose at least one page.")).toBeVisible();
    expect(posts(q)).toHaveLength(0);
    // Escape closes without creating anything.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(posts(q)).toHaveLength(0);
  });

  test("member signed in: [Request approval] with the approval line and no Approve control (check 25)", async ({ page }) => {
    const q = await setup(page, { role: "member", canApprove: false });
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await dialog.getByRole("checkbox", { name: "Explore signed in, with the saved test account" }).check();
    await expect(dialog.getByText(/Signed-in sessions need approval: someone who can approve types the host first/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Request approval", exact: true })).toBeVisible();
    await expect(dialog.getByText("Nothing happens on the site until someone who can approve types the host and approves.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Approve/ })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: /Type localhost/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Request approval", exact: true }).click();
    // The toast lasts 6 s; check it before the (possibly slow, first-compile) navigation finishes.
    await expect(page.getByText("EXP-0002 requested. Someone who can approve must approve it.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${EXP("EXP-0002")}$`), { timeout: 30_000 });
    expect(posts(q)[0].body).toMatchObject({ signed_in: true });
    expect((posts(q)[0].body as Record<string, unknown>).approve).toBeUndefined();
    // The member reads the request: no Approve control, the permission note.
    await expect(page.getByRole("region", { name: /Approve exploratory session EXP-0002/ })).toBeVisible();
    await expect(page.getByRole("region", { name: /Approve exploratory session EXP-0002/ }).getByText("Waiting for approval by someone who can approve", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve and start exploring" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();
  });

  test("approver signed in: [Approve and start exploring] is aria-disabled until the host is typed; wrong text is refused (check 25)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await dialog.getByRole("checkbox", { name: "Explore signed in, with the saved test account" }).check();
    const approve = dialog.getByRole("button", { name: "Approve and start exploring" });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(approve).toHaveAccessibleDescription("Type localhost to approve.");
    await expect(dialog.getByRole("button", { name: "Request approval instead" })).toBeVisible();
    // aria-disabled (not disabled): it stays focusable and a click explains instead of acting.
    await approve.click({ force: true });
    await expect(dialog.getByText("Type localhost to approve.").first()).toBeVisible();
    expect(posts(q)).toHaveLength(0);
    const host = dialog.getByRole("textbox", { name: "Type localhost to approve and start" });
    await host.fill("localhost:4100");
    await approve.click({ force: true });
    await expect(dialog.getByText("Type localhost exactly to approve.")).toBeVisible();
    await host.fill(" LOCALHOST ");
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    expect(await axe(page)).toEqual([]);
    await approve.click();
    await expect(page.getByText("EXP-0002 approved and starting.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${EXP("EXP-0002")}$`), { timeout: 30_000 });
    expect(posts(q)[0].body).toMatchObject({ signed_in: true, approve: true, confirm_text: " LOCALHOST " });
    await expect(page.getByText(/Requested and approved by Daniele Edema · .* · host typed: yes/)).toBeVisible();
  });

  test("a double click on Start exploring sends one request and shows one session; live progress refreshes within 2 s, Pause freezes it, findings are announced (checks 26)", async ({ page }) => {
    // Record every polite announcement: the finding message is replaced by the next milestone a few seconds
    // later, so on a slow runner it may already be gone when the assertion below runs.
    await page.addInitScript(() => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      new MutationObserver(() => {
        document.querySelectorAll('p[role="status"].sr-only').forEach((el) => {
          const t = el.textContent ?? "";
          if (t && w.__said[w.__said.length - 1] !== t) w.__said.push(t);
        });
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const q = await setup(page, { startDelay: 400 });
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await dialog.getByRole("button", { name: "Start exploring" }).dblclick();
    await expect(page).toHaveURL(new RegExp(`${EXP("EXP-0002")}$`));
    expect(posts(q)).toHaveLength(1);
    expect(q.sessions.filter((x) => x.key !== "EXP-0001")).toHaveLength(1);
    await expect(page.getByRole("heading", { level: 1, name: "EXP-0002 · Exploratory session" })).toBeFocused();
    await expect(page.getByText("New and changed pages from CHG-0001 · 3 pages · budget 60 actions, 10 min · not signed in · rules (AI off)")).toBeVisible();
    const live = page.getByTestId("explore-live-line");
    await expect(live).toBeVisible();
    // Refresh at least every 2 s: the line changes on its own within ~2 s, twice.
    for (let i = 0; i < 2; i++) {
      const before = await live.innerText();
      await expect(live).not.toHaveText(before, { timeout: 2500 });
    }
    await expect(page.getByRole("region", { name: "Step log, newest at the bottom" })).toBeVisible();
    const tiles = page.locator("section", { has: page.getByRole("heading", { name: "Live progress" }) });
    await expect(tiles.getByText("Blocked write attempts")).toBeVisible();
    await expect(tiles.getByText("Not tried", { exact: true })).toBeVisible();
    const said = () => page.evaluate(() => (window as unknown as { __said: string[] }).__said);
    await expect.poll(async () => (await said()).filter((t) => t.includes("Finding on /offers: uncaught error, medium")).length, { timeout: 8000 }).toBe(1);
    // Pause updates freezes tiles and log; the session keeps running.
    await page.getByRole("button", { name: "Pause updates" }).click();
    const frozen = await live.innerText();
    await page.waitForTimeout(2500);
    await expect(live).toHaveText(frozen);
    await page.getByRole("button", { name: "Resume updates" }).click();
    await expect(live).not.toHaveText(frozen, { timeout: 2500 });
    // The tab now explains why another session can't start.
    await page.goto(TAB);
    const explore = page.getByRole("button", { name: "Explore…" });
    await expect(explore).toHaveAttribute("aria-disabled", "true");
    await expect(explore).toHaveAccessibleDescription("EXP-0002 is running. One session at a time per project.");
    await explore.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("reduced motion: the live view starts paused with [Resume updates] (check 26)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()] });
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByRole("button", { name: "Resume updates" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause updates" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("a 409 from a session that started meanwhile names it with a link, and only one session is shown (§9.2 errors)", async ({ page }) => {
    const q = await setup(page, { conflictNext: "EXP-0002" });
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    q.sessions.unshift(runningSession("EXP-0002"));
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    const alert = dialog.getByRole("alert").filter({ hasText: "EXP-0002 is already running on this project. One session at a time." });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("link", { name: "Open EXP-0002" })).toHaveAttribute("href", EXP("EXP-0002"));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("table", { name: "Exploratory sessions" }).getByRole("row", { name: /EXP-0002/ })).toHaveCount(1);
    await expect(page.getByRole("table", { name: "Exploratory sessions" }).getByRole("row", { name: /EXP-0003/ })).toHaveCount(0);
  });

  test("a request waiting for approval blocks a new start: Explore… says why; a start anyway gets the server's 409, focused (QA P6-03c)", async ({ page }) => {
    const q = await setup(page, { sessions: [waitingSession("EXP-0004"), demoSession()] });
    await page.goto(TAB);
    const explore = page.getByRole("button", { name: "Explore…" });
    await expect(explore).toHaveAttribute("aria-disabled", "true");
    await expect(explore).toHaveAccessibleDescription("EXP-0004 is waiting for approval. One session at a time.");
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    const alert = dialog.getByRole("alert").filter({ hasText: "EXP-0004 is waiting for approval. One session at a time." });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("link", { name: "Open EXP-0004" })).toBeVisible();
    await expect(page.locator(":focus")).toContainText("EXP-0004 is waiting for approval");
    expect(q.sessions.filter((x) => x.status === "awaiting_approval")).toHaveLength(1);
  });

  test("Stop now by keyboard: focus on [Stop now] in the confirmation; ends 'Stopped by … after n actions' with no live view left (check 27)", async ({ page }) => {
    const q = await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()] });
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByTestId("explore-live-line")).toBeVisible();
    const stopBtn = page.getByRole("button", { name: "Stop now" });
    await stopBtn.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Stop EXP-0002 now?" });
    await expect(dialog.getByText("It stops within 2 seconds. Steps and findings so far are kept. A stopped session can't be resumed.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stop now" })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Keep exploring" })).toBeVisible();
    await page.keyboard.press("Enter");
    const t0 = Date.now();
    await expect(page.getByRole("paragraph").filter({ hasText: /^Stopped by Daniele Edema after \d+ actions\. Steps and findings so far are kept\.$/ })).toBeVisible({ timeout: 4000 });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(q.requests.filter((r) => r.path === "/quality-scans/exp-2/cancel")).toHaveLength(1);
    await expect(page.getByRole("heading", { name: "Live progress" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop now" })).toHaveCount(0);
    await expect(page.getByText("Stopped by Daniele Edema", { exact: true })).toBeVisible();
    // Focus was on the removed control: it moves to the results heading.
    await expect(page.getByRole("heading", { name: "Results" })).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });

  test("EXP-0001 results: findings with numbered steps and before/after screenshots with alts, POST /basket blocked, Apply code not tried, the statement with real numbers (check 28)", async ({ page }) => {
    await setup(page);
    await page.goto(EXP("EXP-0001"));
    await expect(page.getByText(STATEMENT_60)).toBeVisible();
    await expect(page.getByTestId("explore-facts")).toHaveText("Budget used: 60 of 60 actions · 6 min 12 s · 3 pages · 41 elements tried · 4 never reached");
    await expect(page.getByText("2 findings (2 medium) · 1 blocked write attempt · 1 not tried")).toBeVisible();
    await expect(page.getByText(/Defect drafted: DEF-0007 “Offers page: 'Show details' throws an error and shows £NaN” · Gate 8/)).toBeVisible();
    const findings = page.getByRole("table", { name: "Findings (2)" });
    await expect(findings.getByRole("row", { name: /Uncaught error after clicking button "Show details"/ })).toContainText("Medium");
    await expect(findings.getByRole("row", { name: /'NaN' appeared on the page/ })).toContainText("/offers");
    await expect(findings.getByRole("row", { name: /'NaN' appeared on the page/ })).toContainText("step 22");
    expect(await axe(page)).toEqual([]);
    // Drawer from the keyboard.
    const open = findings.getByRole("button", { name: 'Open EXP-0001-01: Uncaught error after clicking button "Show details"' });
    await open.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: /EXP-0001-01/ });
    await expect(drawer.getByText("/offers · desktop 1440 × 900 · step 22")).toBeVisible();
    await expect(drawer.getByLabel("What happened in EXP-0001-01")).toHaveText("TypeError: Cannot read properties of undefined (reading 'price')");
    const steps = drawer.locator("ol").first();
    await expect(steps.getByRole("listitem")).toHaveText(["Open http://localhost:4100/offers", 'Click the button "Show details"']);
    await expect(drawer.getByRole("img", { name: "Before step 22: /offers before clicking 'Show details'." })).toBeVisible();
    await expect(drawer.getByRole("img", { name: "After step 22: /offers after clicking 'Show details'." })).toBeVisible();
    await expect(drawer.getByRole("region", { name: "Console output for EXP-0001-01" }).or(drawer.getByLabel("Console output for EXP-0001-01"))).toBeVisible();
    await expect(drawer.getByText("Drafted automatically: uncaught errors and high findings always get a draft for Gate 8.")).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open DEF-0007" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Raise defect for EXP-0001-01" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(open).toBeFocused();
    // The NaN finding's after-screenshot names what was shown.
    await findings.getByRole("button", { name: /Open EXP-0001-02/ }).click();
    await expect(page.getByRole("img", { name: "After step 22: /offers after clicking 'Show details', showing 'Bundle price: £NaN'." })).toBeVisible();
    await page.keyboard.press("Escape");
    // Not tried and blocked.
    await page.getByRole("radio", { name: "Not tried and blocked (2)" }).click();
    const blocked = page.getByRole("table", { name: "Blocked write attempts (1)" });
    await expect(blocked.getByRole("row", { name: /POST \/basket/ })).toContainText('Clicking button "Add to basket" on /offers');
    await expect(page.getByText("The request was stopped before it left the browser. Nothing was sent.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Not tried: may change data (1)" }).getByRole("row", { name: /Apply code/ })).toContainText("Submits a form");
    await page.getByRole("button", { name: /The budget ran out before these were tried \(4\)/ }).click();
    await expect(page.getByText('Link "Terms" · /')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    // Step log with the outcome filter; the problem row links its finding.
    await page.getByRole("radio", { name: "Step log (60)" }).click();
    await page.getByRole("combobox", { name: "Outcome" }).selectOption("blocked");
    const log = page.getByRole("table", { name: "Step log (1)" });
    await expect(log.getByRole("row", { name: /Add to basket/ })).toContainText("Blocked: tried to send data");
    await page.getByRole("combobox", { name: "Outcome" }).selectOption("error");
    await expect(page.getByRole("table", { name: "Step log (1)" }).getByText("Problem found: uncaught error")).toBeVisible();
    await expect(page.getByRole("table", { name: "Step log (1)" }).getByRole("button", { name: "Open EXP-0001-02" })).toBeVisible();
    // Coverage per page.
    await page.getByRole("radio", { name: "Coverage" }).click();
    await expect(page.getByRole("list", { name: "Coverage by page" })).toContainText("/offers · 21 actions · 2 findings · 1 not tried");
  });

  test("empty Blocked and Not tried read 'None.'; unreached: Never reached, a blocked sign-out read with its reason, a stopped navigation with its destination (check 29)", async ({ page }) => {
    await setup(page, { sessions: [unreachedSession(), session("EXP-0002", { progress: { ...demoSession().progress, findings: 0, blocked: 0, not_tried: 0, findings_by_severity: { high: 0, medium: 0, low: 0 }, open_findings: 0 }, no_findings_line: "No problems found by the automated checks in 60 actions on 3 pages.", statement: STATEMENT_60 }), demoSession()] });
    await page.goto(`${EXP("EXP-0002")}?view=not-tried`);
    await expect(page.getByText("No problems found by the automated checks in 60 actions on 3 pages.")).toBeVisible();
    for (const h of ["Blocked write attempts (0)", "Not tried: may change data (0)", "Never reached (0)"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
    await expect(page.getByText("None.", { exact: true })).toHaveCount(3);
    await page.goto(`${EXP("EXP-0003")}?view=not-tried`);
    await expect(page.getByText("12 of 60 actions used. 3 allowed actions couldn't be reached: see Never reached.")).toBeVisible();
    await expect(page.getByText("Finished · some actions not reached").first()).toBeVisible();
    await expect(page.getByRole("table", { name: "Blocked write attempts (1)" })).toContainText("The page tried to open /logout?img=1. Blocked: would end the session.");
    const nt = page.getByRole("table", { name: "Not tried: may change data (1)" });
    await expect(nt).toContainText("Would end the session");
    await expect(nt).toContainText("Would have opened /logout");
    await page.getByRole("button", { name: /These allowed actions couldn't be reached \(3\)/ }).click();
    await expect(page.getByText('Button "More" · /offers')).toBeVisible();
    await page.getByRole("radio", { name: "Coverage" }).click();
    await expect(page.getByRole("list", { name: "Coverage by page" })).toContainText("/contact · Not explored: the budget ran out.");
    expect(await axe(page)).toEqual([]);
  });

  test("approval panel: approver types the host to approve (focus on the h1), refusing needs a comment (§9.4)", async ({ page }) => {
    const q = await setup(page, { sessions: [waitingSession("EXP-0004"), demoSession()] });
    await page.goto(EXP("EXP-0004"));
    const panel = page.getByRole("region", { name: "Approve exploratory session EXP-0004 · APR-0006" });
    await expect(panel.getByText("Waiting for your approval")).toBeVisible();
    await expect(panel.getByTestId("explore-summary")).toHaveText("Explore 3 pages on localhost:4100 signed in with the saved test account, for up to 60 actions and 10 minutes.");
    await expect(panel.getByText("Pages: /account, /account/orders, /offers")).toBeVisible();
    await expect(panel.getByText("Never types, selects, uploads, submits forms or downloads files.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await panel.getByRole("button", { name: "Don't approve…" }).click();
    await expect(panel.getByText("Say why this session shouldn't run.")).toBeVisible();
    const approve = panel.getByRole("button", { name: "Approve and start exploring" });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await panel.getByRole("textbox", { name: "Type localhost to approve" }).fill("localhost");
    await approve.click();
    await expect(page.getByText("EXP-0004 approved and starting.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "EXP-0004 · Exploratory session" })).toBeFocused();
    await expect(page.getByTestId("explore-live-line")).toBeVisible();
    expect(q.requests.find((r) => r.path === "/approvals/apr-6/decision")?.body).toMatchObject({ decision: "approve", confirm_text: "localhost" });
  });

  test("not approved, expired and withdrawn requests say 'Nothing was sent to the site.'; withdraw by the requester (§9.4, end states)", async ({ page }) => {
    const me = { id: "u", full_name: "Daniele Edema" };
    await setup(page, {
      role: "member",
      canApprove: false,
      sessions: [
        waitingSession("EXP-0006", { requested_by: me }),
        waitingSession("EXP-0005", { status: "expired", status_label: "Request expired" }),
        waitingSession("EXP-0004", { status: "rejected", status_label: "Not approved", approval: { ...waitingSession().approval!, status: "rejected", decided_by: { id: "a", full_name: "A. Approver" }, comment: "Not before the release freeze" } }),
        demoSession(),
      ],
    });
    await page.goto(EXP("EXP-0004"));
    await expect(page.getByText("Not approved by A. Approver: ‘Not before the release freeze’. Nothing was sent to the site.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Request again" })).toHaveAttribute("href", "/projects/p1/execution?tab=exploratory&new=1");
    await page.goto(EXP("EXP-0005"));
    await expect(page.getByText("This request expired after 24 hours. Nothing was sent to the site.")).toBeVisible();
    await page.goto(EXP("EXP-0006"));
    await expect(page.getByText("Approving signed-in exploration needs approval permission. Someone who can approve will see this request.")).toBeVisible();
    await page.getByRole("button", { name: "Withdraw request" }).click();
    await expect(page.getByText("Request withdrawn. Nothing was sent to the site.").first()).toBeVisible();
    await expect(page.getByText("Withdrawn").first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("didn't complete: the reason, steps kept, [Explore again…] (§9.6 end states)", async ({ page }) => {
    await setup(page, {
      sessions: [session("EXP-0002", { status: "failed", status_label: "Didn't complete", end_reason: "error", end_text: "Didn't complete: The worker stopped. Steps up to 23 are kept.", error: "The worker stopped", progress: { ...demoSession().progress, actions_used: 23 } }), demoSession()],
    });
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByText("Didn't complete: The worker stopped. Steps up to 23 are kept.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore again…" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("viewer: no Explore, Stop, triage or Raise defect controls (check 30)", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false, sessions: [runningSession("EXP-0002", { requested_by: { id: "m", full_name: "M. Member" } }), demoSession(), waitingSession("EXP-0004")] });
    await page.goto(TAB);
    await expect(page.getByRole("table", { name: "Exploratory sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Explore…" })).toHaveCount(0);
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByTestId("explore-live-line")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop now" })).toHaveCount(0);
    await page.goto(`${EXP("EXP-0001")}?finding=EXP-0001-02`);
    const drawer = page.getByRole("dialog", { name: /EXP-0001-02/ });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Accept risk/ })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /Raise defect/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Closing the drawer replaces the URL (drops ?finding=); wait for it, or WebKit aborts the next goto.
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/finding=/);
    await page.goto(EXP("EXP-0004"));
    await expect(page.getByRole("region", { name: /Approve exploratory session EXP-0004/ })).toBeVisible();
    await expect(page.getByRole("button")).not.toContainText(["Approve and start exploring", "Withdraw request", "Don't approve…"]);
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });

  test("a low finding without a defect: Raise defect from the drawer, behind a confirmation", async ({ page }) => {
    const q = await setup(page);
    const f = q.findings["EXP-0001"][1];
    Object.assign(f, { severity: "low", rule_id: "console_error", title: "Console error on /offers", defect: null });
    await page.goto(`${EXP("EXP-0001")}?finding=EXP-0001-02`);
    const drawer = page.getByRole("dialog", { name: /EXP-0001-02/ });
    await drawer.getByRole("button", { name: "Raise defect for EXP-0001-02" }).click();
    await page.getByRole("dialog", { name: "Raise a defect for EXP-0001-02?" }).getByRole("button", { name: "Raise defect" }).click();
    await expect(page.getByText("DEF-0008 created as a draft.")).toBeVisible();
    expect(q.requests.filter((r) => r.path === "/quality-findings/f-exp-02/raise-defect")).toHaveLength(1);
  });

  test("Overview, header and sidebar: the waiting session for an approver (Approve badge, pill, attention row, optional row) (§4.2–4.5)", async ({ page }) => {
    await setup(page, { sessions: [waitingSession("EXP-0004"), demoSession()] });
    await page.goto("/projects/p1");
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Test Execution, 1 exploratory session waiting for your approval" })).toBeVisible();
    await expect(page.getByText("EXP-0004 waiting for your approval").first()).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: "EXP-0004 is waiting for your approval: signed-in exploration of 3 pages on localhost:4100." });
    await expect(row.getByRole("link", { name: "Review EXP-0004" })).toHaveAttribute("href", EXP("EXP-0004"));
    const optional = page.getByRole("region", { name: "Optional checks · any time after Gate 2" });
    await expect(optional.getByRole("link", { name: /Exploratory testing/ })).toHaveAttribute("href", TAB);
    await expect(optional.getByText("EXP-0004 waiting for your approval")).toBeVisible();
    // The date uses the app's locale format (fmtDate).
    await expect(page.getByText(/^EXP-0001 · .*15.* · 2 findings \(2 medium\) · 1 blocked write attempt$/)).toBeVisible();
    // The header ⋯ menu offers "Explore pages…".
    await page.getByRole("button", { name: "More project actions" }).click();
    await page.getByRole("menuitem", { name: "Explore pages…" }).click();
    await expect(page.getByRole("dialog", { name: "Explore pages" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("while exploring: Running badge and 'Exploring: EXP-0002' pill", async ({ page }) => {
    await setup(page, { sessions: [runningSession("EXP-0002", { status: "queued", status_label: "Waiting to start" }), demoSession()], stepsPerTick: 1 });
    await page.goto(TAB);
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Test Execution, a run or exploratory session is in progress" })).toBeVisible();
    await expect(page.getByText("Exploring: EXP-0002")).toBeVisible();
  });

  test("Gate 8: an exploratory draft shows its Why line and can be rejected as Accepted risk (§9.8)", async ({ page }) => {
    await setup(page, {}, (e) => {
      const base = e.defects[0];
      e.defects.unshift({
        ...base,
        id: "def-0007",
        key: "DEF-0007",
        summary: "Offers page: 'Show details' throws an error and shows £NaN",
        severity: "minor",
        source: "exploratory",
        why: 'uncaught error after clicking button "Show details" on /offers · EXP-0001 step 22 [Observed]',
        cases: [],
        requirements: [],
      } as typeof base);
    });
    await page.goto("/projects/p1/defects?view=review");
    const item = page.getByRole("listitem").filter({ hasText: "DEF-0007" });
    await expect(item.getByText(/· Exploratory$/)).toBeVisible();
    await expect(item.getByText('Why: uncaught error after clicking button "Show details" on /offers · EXP-0001 step 22 [Observed]')).toBeVisible();
    await page.getByRole("checkbox", { name: /Select DEF-0007/ }).check();
    await page.getByRole("button", { name: /^Reject/ }).first().click();
    await expect(page.getByRole("dialog").getByRole("radio", { name: "Accepted risk" })).toBeVisible();
  });

  test("Settings › Limits: Exploratory sessions with the server cap, over-cap error, raise confirmation and save; others read only (§9.9)", async ({ page }) => {
    const q = await setup(page);
    await page.goto("/settings/load-limits");
    await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Limits" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Exploratory sessions" })).toBeVisible();
    const actions = page.getByRole("textbox", { name: "Actions per session" });
    await expect(actions).toHaveValue("60");
    await expect(actions).toHaveAccessibleDescription("This server allows up to 200.");
    await actions.fill("250");
    await page.getByRole("button", { name: "Save exploration limits" }).click();
    await expect(page.getByText("This server allows up to 200 actions.")).toBeVisible();
    await expect(actions).toBeFocused();
    expect(q.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    await actions.fill("120");
    await page.getByRole("textbox", { name: "Minutes per session" }).fill("15");
    await page.getByRole("button", { name: "Save exploration limits" }).click();
    const confirm = page.getByRole("dialog", { name: "Raise the limits to 120 actions and 15 minutes?" });
    await expect(confirm.getByText("Longer sessions click more on the sites you test.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await confirm.getByRole("button", { name: "Raise limits" }).click();
    await expect(page.getByText("Exploration limits saved.")).toBeVisible();
    expect(q.requests.find((r) => r.method === "PATCH")?.body).toEqual({ exploration_ceiling: { actions: 120, minutes: 15 } });
  });

  test("member on Settings › Limits reads the exploration limits with the owner/admin line (§9.9)", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false });
    await page.goto("/settings/load-limits");
    await expect(page.getByRole("heading", { name: "Exploratory sessions" })).toBeVisible();
    await expect(page.getByText("Only owners and admins can change these limits.")).toBeVisible();
    await expect(page.getByText("Only owners and admins can see the load-test limits.")).toBeVisible();
    await expect(page.getByText("Only owners and admins can see this page.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save exploration limits" })).toHaveCount(0);
  });

  test("375 px: tab cards, the start dialog, the live view with a sticky Stop now, results and the drawer never scroll sideways (check 45)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page, { sessions: [runningSession("EXP-0002"), demoSession(), unreachedSession()] });
    await page.goto(TAB);
    await expect(page.getByRole("list", { name: "Exploratory sessions" })).toBeVisible();
    expect(await sideways(page)).toBe(0);
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByTestId("explore-live-line")).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop now" });
    const box = await stop.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThan(740);
    expect(await sideways(page)).toBe(0);
    await page.goto(EXP("EXP-0001"));
    await expect(page.getByRole("list", { name: "Findings (2)" })).toBeVisible();
    expect(await sideways(page)).toBe(0);
    await page.goto(`${EXP("EXP-0001")}?finding=EXP-0001-01`);
    const drawer = page.getByRole("dialog", { name: /EXP-0001-01/ });
    await expect(drawer.getByRole("radiogroup", { name: "Before and after: show" }).getByRole("radio")).toHaveText(["Before", "After"]);
    expect(await sideways(page)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/finding=/);
    await page.goto(`${EXP("EXP-0003")}?view=not-tried`);
    await expect(page.getByRole("heading", { name: "Never reached (3)" })).toBeVisible();
    expect(await sideways(page)).toBe(0);
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page, { sessions: [demoSession()] });
    await page.goto(`${TAB}&new=1`);
    await expect(page.getByRole("dialog", { name: "Explore pages" })).toBeVisible();
    expect(await sideways(page)).toBe(0);
    expect(await axe(page)).toEqual([]);
  });
});
