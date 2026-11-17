// Phase 6 release readiness and Gate 9 (P6-05b, D32, D33, D37; design P6 §4.2–4.6, §10, §16, §17, §19 checks 1, 4, 5,
// 31–38, 43–45) against the stubbed API (./fixtures.ts + the phase 2–4 and 6 fixtures + ./phase6-release-fixtures.ts,
// test-only). Verdict and statuses as text, the role-aware Gate 9 panel with override (different verdict, ≥ 20
// characters), stale and replaced assessments, confirming a criterion, manual re-tests, focus after each action, axe
// and 375 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { mockPhase6, newP6 } from "./phase6-fixtures";
import { assessment, demoAssessments, mockManualMustRun, mockRelease, newRelease, rel1Criteria, type ReleaseState } from "./phase6-release-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<ReleaseState> = {}, opts: { changes?: boolean } = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newRelease(over);
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }), newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, newExec({ role: q.role, canApprove: q.canApprove }));
  if (opts.changes) {
    const p6 = newP6({ role: q.role, outdated: false });
    await mockPhase6(page, s, p6);
    await mockManualMustRun(page, p6);
  }
  await mockRelease(page, s, q, p4);
  await signedIn(page, s);
  return q;
}

const RR = "/projects/p1/release-readiness";
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const panel = (page: Page, key = "REL-0002") => page.getByRole("region", { name: `Gate 9 · Release decision for ${key}` });
const card = (page: Page) => page.getByRole("region", { name: /^(Recommendation|Final verdict)$/ });
const REASON = "Customer demo needs it; DEF-0007 is cosmetic";
const STATEMENT = /^This recommendation is based on the tests the platform ran and the evidence recorded up to [^.]+\. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it\.$/;

test.describe("Phase 6 · release readiness (P6-05b)", () => {
  test("REL-0001: No-go · Recommended with the DEF-0001 sentence; Not met and Blocking as text; DEF-0001 linked; Reports highlighted (checks 1, 31)", async ({ page }) => {
    await setup(page, { assessments: [assessment("REL-0001", rel1Criteria())] });
    await page.goto(RR);
    await expect(page.getByRole("heading", { level: 1, name: "Release readiness" })).toBeVisible();
    await expect(page.getByText(STATEMENT)).toBeVisible();
    const c = card(page);
    await expect(c.getByRole("heading", { name: "Recommendation" })).toBeVisible();
    await expect(c.getByText("No-go · Recommended")).toBeVisible();
    await expect(c.getByText("1 blocking criterion isn't met: there is an open major defect (DEF-0001).")).toBeVisible();
    const table = page.getByRole("table", { name: "Criteria (5)" });
    const row = table.getByRole("row", { name: /No open critical or high defects/ });
    await expect(row.getByRole("cell").nth(0)).toHaveText("Blocking");
    await expect(row.getByRole("cell").nth(1)).toHaveText("Not met");
    await expect(row.getByRole("link", { name: "Open DEF-0001 for criterion No open critical or high defects" })).toHaveAttribute("href", "/projects/p1/defects/DEF-0001");
    // Blocking first: the four blocking criteria lead.
    await expect(table.getByRole("rowheader").nth(4)).toContainText("95 % of executed tests pass");
    await expect(table.getByRole("row", { name: /95 % of executed tests pass/ }).getByText("Not blocking")).toBeVisible();
    await expect(page.getByText("This is the first assessment.")).toBeVisible();
    // Sidebar: still 12 sections, Reports highlighted with the approver's badge; no "Phase 6" left on the page.
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link")).toHaveCount(12);
    await expect(nav.getByRole("link", { name: "Reports, release readiness waiting for your decision" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Phase 6")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Reports" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("REL-0002 layout: conditions, criteria filter, residual risk, what changed, history; Confirm only on strategy criteria; manual re-test link (§10.1, D37)", async ({ page }) => {
    await setup(page);
    await page.goto(RR);
    await expect(card(page).getByText("Conditional · Recommended")).toBeVisible();
    await expect(card(page).getByText("Impacted tests re-run since the change can't be checked, so the recommendation can't be Go; 4 conditions remain.")).toBeVisible();
    await expect(card(page).getByText("Overall residual risk: Medium · Gate 9: waiting for your decision")).toBeVisible();
    const conditions = page.getByRole("region", { name: "Conditions (4)" });
    await expect(conditions.getByRole("listitem")).toHaveCount(4);
    await expect(conditions.getByRole("listitem").first()).toContainText("Re-test TC-0031 by hand after CHG-0001 and record the result (manual test)");
    await expect(conditions.getByRole("listitem").nth(1)).toHaveText("Fix or accept DEF-0007 (minor)");
    // Confirm result… only on the strategy criterion the platform can't check, never on a platform check.
    await expect(page.getByRole("button", { name: /^Confirm result for / })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Confirm result for Stakeholders signed off" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record manual re-tests in CHG-0001" })).toHaveAttribute("href", "/projects/p1/discovery/changes/CHG-0001?tab=regression#manual-retests");
    // Status filter.
    const table = page.getByRole("table", { name: "Criteria (8)" });
    await page.getByLabel("Status", { exact: true }).selectOption("not_met");
    await expect(table.getByRole("rowheader")).toHaveCount(2);
    await page.getByLabel("Status", { exact: true }).selectOption("");
    await expect(table.getByRole("rowheader")).toHaveCount(8);
    // Residual risk, highest first.
    const risk = page.getByRole("table", { name: "Residual risk" });
    await expect(risk.getByRole("rowheader").first()).toHaveText("RISK-04 · Removed product page links");
    await expect(risk.getByRole("row", { name: /RISK-01/ })).toContainText("Mitigated by testing: all 3 linked tests passed");
    // What changed since REL-0001.
    const changed = page.getByRole("region", { name: /^What changed since REL-0001/ });
    await expect(changed).toContainText("Recommendation No-go → Conditional · CHG-0001 · RUN-0005 · DEF-0001 Fixed → Verified · DEF-0007 confirmed · EXP-0001 · 2 criteria changed");
    await changed.getByRole("button", { name: "Show" }).click();
    await expect(changed.getByText("No open critical or high defects: Not met → Met")).toBeVisible();
    // History.
    const history = page.getByRole("table", { name: "Assessment history" });
    await expect(history.getByRole("row", { name: /^REL-0002/ })).toContainText("Waiting for Gate 9");
    await expect(history.getByRole("row", { name: /^REL-0001/ })).toContainText("No-go · A. Approver");
    expect(await axe(page)).toEqual([]);
  });

  test("approver: Override offers only other verdicts; errors until a verdict and 20 characters; confirmation names the audit log; Final with 'Overridden by' on the page and Overview (checks 33, 35)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(RR);
    const g9 = panel(page);
    await expect(g9.getByText("Waiting for your decision")).toBeVisible();
    await expect(g9.getByText("The platform recommends Conditional. You decide; your decision is recorded with your name and the time.")).toBeVisible();
    const record = g9.getByRole("button", { name: "Record decision for REL-0002" });
    await record.click();
    await expect(g9.getByText("Choose a decision.")).toBeVisible();
    await expect(g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" })).toBeFocused();
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    const verdicts = g9.getByRole("group", { name: "Final verdict" });
    await expect(verdicts.getByRole("radio")).toHaveCount(2);
    await expect(verdicts.getByRole("radio", { name: "Go", exact: true })).toBeVisible();
    await expect(verdicts.getByRole("radio", { name: "No-go" })).toBeVisible();
    await expect(verdicts.getByRole("radio", { name: "Conditional" })).toHaveCount(0);
    await record.click();
    await expect(g9.getByText("Choose a final verdict.")).toBeVisible();
    await expect(verdicts.getByRole("radio", { name: "Go", exact: true })).toBeFocused();
    await verdicts.getByRole("radio", { name: "Go", exact: true }).check();
    const reason = g9.getByRole("textbox", { name: "Reason (at least 20 characters)" });
    await reason.fill("Too short");
    await expect(reason).toHaveAccessibleDescription(/9 of 20 characters/);
    await record.click();
    await expect(g9.getByText("Write at least 20 characters. The reason is shown next to the verdict.")).toBeVisible();
    await expect(reason).toBeFocused();
    expect(q.requests.filter((r) => r.path.endsWith("/decision"))).toHaveLength(0);
    await reason.fill(REASON);
    await record.click();
    const dialog = page.getByRole("dialog", { name: "Override the recommendation?" });
    await expect(dialog).toContainText("Final verdict: Go (recommended: Conditional). Your reason is shown as 'Overridden by Daniele Edema: Customer demo needs it; DEF-0007 is cosmetic' next to the verdict, in the Release Readiness Report and in the audit log.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Override to Go" }).click();
    await expect(page.getByText("REL-0002 overridden: Go is final.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/decision"))?.body).toEqual({ decision: "override", final_verdict: "go", reason: REASON });
    const heading = card(page).getByRole("heading", { name: "Final verdict" });
    await expect(heading).toBeFocused();
    await expect(card(page).getByText("Go · Final")).toBeVisible();
    await expect(card(page).getByText(`Overridden by Daniele Edema: '${REASON}' (recommended: Conditional)`)).toBeVisible();
    await expect(panel(page).getByText(new RegExp(`^Final verdict: Go · Overridden by Daniele Edema: '${REASON}' · recommended: Conditional · `))).toBeVisible();
    await expect(panel(page).getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Assessment history" }).getByRole("row", { name: /^REL-0002/ })).toContainText("Go · overridden by Daniele Edema");
    await expect(page.getByLabel("Assessment", { exact: true }).locator("option").first()).toHaveText("REL-0002 (latest) · Go · Final");
    expect(await axe(page)).toEqual([]);
    // Overview card.
    await page.goto("/projects/p1");
    const glance = page.getByRole("region", { name: "Release readiness" });
    await expect(glance.getByText("Go · Final")).toBeVisible();
    await expect(glance.getByText(`Overridden by Daniele Edema: '${REASON}'`)).toBeVisible();
    await expect(glance.getByText(/overridden/i)).toHaveCount(1); // named once (QA note)
    await expect(glance.getByText("4 conditions · overall residual risk: Medium", { exact: true })).toBeVisible();
  });

  test("override to Go with a blocking criterion not met lists it in the confirmation; Approve: No-go wording (check 34)", async ({ page }) => {
    await setup(page, { assessments: [assessment("REL-0001", rel1Criteria())] });
    await page.goto(RR);
    const g9 = panel(page, "REL-0001");
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    await g9.getByRole("group", { name: "Final verdict" }).getByRole("radio", { name: "Go", exact: true }).check();
    await g9.getByRole("textbox", { name: "Reason (at least 20 characters)" }).fill(REASON);
    await g9.getByRole("button", { name: "Record decision for REL-0001" }).click();
    const dialog = page.getByRole("dialog", { name: "Override the recommendation?" });
    await expect(dialog.getByText("Blocking criteria not met: No open critical or high defects (DEF-0001, major).")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Override and Reject keep separate reasons.
    await g9.getByRole("radio", { name: "Reject this assessment" }).check();
    await expect(g9.getByRole("textbox", { name: "Reason" })).toHaveValue("");
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    await expect(g9.getByRole("textbox", { name: "Reason (at least 20 characters)" })).toHaveValue(REASON);
    await g9.getByRole("radio", { name: "Approve: No-go becomes the final verdict" }).check();
    await g9.getByRole("button", { name: "Record decision for REL-0001" }).click();
    const approve = page.getByRole("dialog", { name: "Approve REL-0001?" });
    await expect(approve).toContainText("Make No-go the final verdict for REL-0001? The report will say the release should not go ahead.");
    await approve.getByRole("button", { name: "Approve: No-go" }).click();
    await expect(page.getByText("REL-0001: No-go is final.")).toBeVisible();
    await expect(card(page).getByRole("heading", { name: "Final verdict" })).toBeFocused();
    await expect(panel(page, "REL-0001").getByText(/^Final verdict: No-go · approved by Daniele Edema · /)).toBeVisible();
  });

  test("member: read-only Gate 9 with the reason, no radios; Waiting badge, pill and Overview row; viewer: pill and sentence only, no controls (checks 4, 32)", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false });
    await page.goto(RR);
    const g9 = panel(page);
    await expect(g9.getByText("Waiting for a decision by someone who can approve")).toBeVisible();
    await expect(g9.getByText("Deciding Gate 9 needs approval permission. Someone who can approve will see this assessment. You can still confirm criteria the platform can't check.")).toBeVisible();
    await expect(g9.getByRole("radio")).toHaveCount(0);
    await expect(g9.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm result for Stakeholders signed off" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Assess release readiness" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Reports, release readiness waiting for a decision" })).toBeVisible();
    await expect(page.getByText("REL-0002 waiting for a Gate 9 decision", { exact: true })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1");
    await expect(page.getByText("REL-0002 is waiting for a Gate 9 decision by someone who can approve.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open REL-0002" })).toHaveAttribute("href", RR);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await setup(page, { role: "viewer", canApprove: false });
    await page.goto(RR);
    const v = panel(page);
    await expect(v.getByText("The platform recommends Conditional.")).toBeVisible();
    await expect(v.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Assess|Confirm result|Record decision/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Record manual re-tests in CHG-0001" })).toHaveCount(0);
    await expect(card(page).getByRole("link", { name: "Go to the decision" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1");
    await expect(page.getByText("REL-0002 is waiting for a Gate 9 decision by someone who can approve.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open REL-0002" })).toHaveCount(0);
  });

  test("approver on the Overview: header pill, [Decide REL-0002] lands on the Gate 9 heading; lifecycle step 21 and G9 are live (checks 4, 5)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1");
    await expect(page.getByText("REL-0002 waiting for your decision (Gate 9)", { exact: true })).toBeVisible();
    const glance = page.getByRole("region", { name: "Release readiness" });
    await expect(glance.getByText("Conditional · Recommended")).toBeVisible();
    await expect(glance.getByText("4 conditions · overall residual risk: Medium · Gate 9: waiting for your decision")).toBeVisible();
    const lifecycle = page.getByRole("list", { name: "QA lifecycle" });
    await expect(lifecycle.getByRole("link", { name: /^Reporting/ })).toHaveAttribute("href", RR);
    await expect(page.getByText("Phase 6")).toHaveCount(0);
    await page.getByRole("button", { name: "Show all 21 steps" }).click();
    const reporting = page.getByRole("region", { name: /^Reporting/ });
    await expect(reporting.getByText("REL-0002: Conditional (recommended)")).toBeVisible();
    await expect(reporting.getByText("REL-0002 waiting for your decision")).toBeVisible();
    await expect(reporting.getByRole("link", { name: "Decide Gate 9" })).toHaveAttribute("href", `${RR}#gate-9`);
    await expect(reporting.getByText("Lead QA Orchestrator (rules)")).toBeVisible();
    await page.getByText("REL-0002 is waiting for your decision (Gate 9): recommended Conditional.").isVisible();
    await page.getByRole("link", { name: "Decide REL-0002" }).click();
    await expect(page).toHaveURL(/\/release-readiness#gate-9$/);
    await expect(page.getByRole("heading", { name: "Gate 9 · Release decision for REL-0002" })).toBeFocused();
  });

  test("stale: banner and disabled decision with the reason; Assess again replaces it and REL-0002 stays in history; a 409 on submit shows the server's message (check 36)", async ({ page }) => {
    const stale = demoAssessments();
    Object.assign(stale[0], { status: "stale", stale_reason: "RUN-0006 finished at 16:20", verdict_state: "not_decided" });
    await setup(page, { assessments: stale });
    await page.goto(RR);
    const text = "Evidence changed after this assessment (RUN-0006 finished at 16:20). It can't be decided. Assess again to include the new evidence.";
    await expect(page.getByText(text)).toHaveCount(2); // page banner + the panel
    await expect(card(page).getByText("Conditional · Not decided")).toBeVisible();
    const g9 = panel(page);
    await expect(g9.getByText("Out of date")).toBeVisible();
    for (const r of await g9.getByRole("radio").all()) await expect(r).toBeDisabled();
    await expect(g9.getByRole("button", { name: "Record decision for REL-0002" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Reports, release readiness is out of date" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await g9.getByRole("button", { name: "Assess again" }).click();
    await expect(page.getByText("REL-0003: Conditional (recommended).")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Release readiness" })).toBeFocused();
    const history = page.getByRole("table", { name: "Assessment history" });
    await expect(history.getByRole("row", { name: /^REL-0003/ })).toContainText("Waiting for Gate 9");
    await expect(history.getByRole("row", { name: /^REL-0002/ })).toContainText("Replaced by REL-0003");
    await expect(panel(page, "REL-0003").getByRole("radio").first()).toBeEnabled();

    // The old one stays readable, read-only, and says what replaced it.
    await history.getByRole("link", { name: "REL-0002" }).click();
    await expect(page).toHaveURL(/\/release-readiness\/REL-0002$/);
    await expect(panel(page).getByText(/^Replaced by REL-0003 \(.+\)\. This assessment can't be decided\./)).toBeVisible();
    await expect(panel(page).getByRole("radio")).toHaveCount(0);

    // Evidence arrives while the approver decides: 409, the panel says so and the assessment reloads as stale.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await setup(page, { staleOnDecide: "DEF-0008 was raised" });
    await page.goto(RR);
    const p = panel(page);
    await p.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" }).check();
    await p.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve: Conditional" }).click();
    const alert = p.getByRole("alert");
    await expect(alert).toHaveText("Evidence changed after this assessment. Assess again to include the new evidence.");
    await expect(page.getByText("Evidence changed after this assessment (DEF-0008 was raised). It can't be decided. Assess again to include the new evidence.").first()).toBeVisible();
  });

  test("[Assess release readiness] while REL-0002 waits asks first; assessing shows the spinner, then the new assessment (§10.2)", async ({ page }) => {
    const q = await setup(page, { assessDelay: 2 });
    await page.goto(RR);
    await page.getByRole("button", { name: "Assess release readiness" }).click();
    const dialog = page.getByRole("dialog", { name: "Assess again?" });
    await expect(dialog).toContainText("Assess again? REL-0002 is waiting for a Gate 9 decision. A new assessment replaces it; REL-0002 stays in history.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(q.requests.filter((r) => r.path === "/projects/p1/release-assessments")).toHaveLength(0);
    await page.getByRole("button", { name: "Assess release readiness" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Assess again" }).click();
    await expect(page.getByText("Assessing: reading results, defects, risks, changes and exploration…")).toBeVisible();
    await expect(page.getByText("REL-0003: Conditional (recommended).")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Assessment", { exact: true })).toHaveValue("REL-0003");
  });

  test("Confirm result…: errors on submit, Met with a reason, 'Confirmed by', verdict worked out again, focus on the row (check 37)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(RR);
    await page.getByRole("button", { name: "Confirm result for Stakeholders signed off" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm: Stakeholders signed off" });
    await expect(dialog).toContainText("The platform can't check this. Record what a person confirmed.");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Choose Met or Not met.")).toBeVisible();
    await expect(dialog.getByText("Say how it was confirmed.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Met", exact: true })).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole("radio", { name: "Met", exact: true }).check();
    await dialog.getByRole("textbox", { name: "Reason" }).fill("Signed off in the release meeting");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Criterion confirmed. The recommendation is now Conditional.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/confirm"))?.body).toEqual({ status: "met", reason: "Signed off in the release meeting" });
    const row = page.getByRole("table", { name: "Criteria (8)" }).getByRole("row", { name: /Stakeholders signed off/ });
    await expect(row).toContainText("Confirmed by Daniele Edema: 'Signed off in the release meeting'");
    await expect(row.getByRole("cell").nth(1)).toHaveText("Met");
    await expect(row.getByText("Stakeholders signed off", { exact: true })).toBeFocused();
    await expect(page.getByRole("region", { name: "Conditions (3)" })).toBeVisible();
    // Still offered while REL-0002 waits: the server keeps a not-evaluable strategy criterion confirmable, so a person can correct it.
    await expect(page.getByRole("button", { name: "Confirm result for Stakeholders signed off" })).toBeVisible();
  });

  test("no finished run: 'Run the tests first' and Assess is aria-disabled with the reason; lifecycle reads 'Available after the first test run' (checks 5, 38)", async ({ page }) => {
    const q = await setup(page, { available: false, assessments: [] });
    await page.goto(RR);
    await expect(page.getByText("Release readiness needs test results. Run the tests first.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Test Execution" })).toHaveAttribute("href", "/projects/p1/execution");
    const assess = page.getByRole("button", { name: "Assess release readiness" });
    await expect(assess).toHaveAttribute("aria-disabled", "true");
    await expect(assess).toHaveAccessibleDescription("Run the tests first: release readiness needs execution results.");
    await assess.click({ force: true }); // aria-disabled: focusable, does nothing
    expect(q.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1");
    await expect(page.getByRole("list", { name: "QA lifecycle" }).getByText("Available after the first test run")).toBeVisible();
    await expect(page.getByRole("region", { name: "Release readiness" }).getByText("Available after the first test run.")).toBeVisible();
  });

  test("an older assessment opens read-only with the neutral banner and its decision record; the select switches (§10.1)", async ({ page }) => {
    await setup(page);
    await page.goto(`${RR}/REL-0001`);
    await expect(page.getByRole("heading", { level: 1, name: "Release readiness · REL-0001" })).toBeVisible();
    await expect(page.getByText("You're viewing REL-0001 (Final: No-go). The latest is REL-0002.")).toBeVisible();
    await expect(card(page).getByText("No-go · Final")).toBeVisible();
    await expect(panel(page, "REL-0001").getByText(/^Final verdict: No-go · approved by A\. Approver · /)).toBeVisible();
    await expect(panel(page, "REL-0001").getByRole("radio")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.getByLabel("Assessment", { exact: true }).selectOption("REL-0002");
    await expect(page).toHaveURL(new RegExp(`${RR}$`));
    await page.goto(`${RR}/REL-0009`);
    await expect(page.getByText("We couldn’t find REL-0009 in this project.")).toBeVisible();
  });

  test("keyboard: Go to the decision → G9 heading; arrow keys pick Approve; confirmation starts on Cancel, Escape returns; approve → verdict heading (§16.2, check 44)", async ({ page, browserName }) => {
    await setup(page);
    await page.goto(RR);
    const go = card(page).getByRole("link", { name: "Go to the decision" });
    await go.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Gate 9 · Release decision for REL-0002" })).toBeFocused();
    const g9 = panel(page);
    // Safari's Tab skips radios unless "Keyboard navigation" is on (pointerFocus.ts): start on the first one there.
    if (browserName === "webkit") await g9.getByRole("radio").first().focus();
    else await page.keyboard.press("Tab");
    await expect(g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" })).toBeChecked();
    const record = g9.getByRole("button", { name: "Record decision for REL-0002" });
    await record.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Approve REL-0002?" });
    await expect(dialog).toContainText("Make Conditional the final verdict for REL-0002? The Release Readiness Report loses its DRAFT band and names you as the decider.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(record).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "Approve: Conditional" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("REL-0002: Conditional is final.")).toBeVisible();
    await expect(card(page).getByRole("heading", { name: "Final verdict" })).toBeFocused();
    await expect(card(page).getByText("Conditional · Final")).toBeVisible();
  });

  test("375 px: criteria, risks and history as cards; Gate 9 full width; no sideways scroll on the page or the dialogs (§17, check 45)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(RR);
    await expect(card(page).getByText("Conditional · Recommended")).toBeVisible();
    const cards = page.getByRole("list", { name: "Criteria (8)" });
    await expect(cards.getByRole("heading", { name: "Stakeholders signed off" })).toBeVisible();
    await expect(cards.getByRole("listitem").filter({ hasText: "No open minor or trivial defects" })).toContainText("Status: Not met · Not blocking · Source: Platform check");
    await expect(page.getByRole("table", { name: "Criteria (8)" })).toBeHidden();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
    const g9 = panel(page);
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    await g9.getByRole("group", { name: "Final verdict" }).getByRole("radio", { name: "Go", exact: true }).check();
    await g9.getByRole("textbox", { name: "Reason (at least 20 characters)" }).fill(REASON);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await expect(page.getByRole("dialog", { name: "Override the recommendation?" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await cards.getByRole("button", { name: "Confirm result for Stakeholders signed off" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm: Stakeholders signed off" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("Phase 6 · manual re-tests of impacted manual tests (D37)", () => {
  test("record a result in CHG-0001's Regression run: errors, Failed with a note, latest line, focus; the waiting assessment goes out of date", async ({ page }) => {
    const q = await setup(page, {}, { changes: true });
    await page.goto(RR);
    await page.getByRole("link", { name: "Record manual re-tests in CHG-0001" }).click();
    await expect(page).toHaveURL(/\/discovery\/changes\/CHG-0001\?tab=regression#manual-retests$/);
    const section = page.getByRole("region", { name: "Manual re-tests (0 of 1 recorded)" });
    await expect(section.getByRole("heading", { name: "Manual re-tests (0 of 1 recorded)" })).toBeFocused();
    await expect(section).toContainText("TC-0031 Sign in with the saved test account");
    await expect(section).toContainText("Not recorded yet.");
    expect(await axe(page)).toEqual([]);
    await section.getByRole("button", { name: "Record re-test result for TC-0031" }).click();
    const dialog = page.getByRole("dialog", { name: "Record re-test: TC-0031" });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Choose Passed or Failed.")).toBeVisible();
    await expect(dialog.getByText("Add a note: what you did and what you saw.")).toBeVisible();
    await dialog.getByRole("radio", { name: "Failed" }).check();
    await dialog.getByRole("textbox", { name: "Note" }).fill("Signed in, then the dashboard showed a blank page");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Manual re-test of TC-0031 recorded: failed.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/manual-retests") && r.method === "POST")?.body).toEqual({ case_key: "TC-0031", status: "failed", note: "Signed in, then the dashboard showed a blank page" });
    const done = page.getByRole("region", { name: "Manual re-tests (1 of 1 recorded)" });
    await expect(done.getByText(/^Latest: Failed · recorded by Daniele Edema · .+: 'Signed in, then the dashboard showed a blank page'$/)).toBeVisible();
    await expect(done.getByRole("heading", { name: "TC-0031 Sign in with the saved test account" })).toBeFocused();
    await page.goto(RR);
    await expect(page.getByText("Evidence changed after this assessment (Manual re-test of TC-0031 recorded (failed)). It can't be decided. Assess again to include the new evidence.").first()).toBeVisible();
  });

  test("viewer reads the re-tests without a Record button", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false }, { changes: true });
    await page.goto("/projects/p1/discovery/changes/CHG-0001?tab=regression");
    const section = page.getByRole("region", { name: /^Manual re-tests/ });
    await expect(section).toContainText("Not recorded yet.");
    await expect(section.getByRole("button")).toHaveCount(0);
  });
});
