// QA verification of P6-05b (release readiness workspace and Gate 9) against the stubbed API. Fills the gaps of
// phase6-release.spec.ts: reject, override boundaries and the No-go recommendation, assess errors, offline, the
// superseded and older views, stale rows on the Overview, Escape/focus details, Reports page, viewer details.
// Uses the test-only fixtures (./fixtures.ts + phase 2–4, 6 and ./phase6-release-fixtures.ts).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { assessment, demoAssessments, mockRelease, newRelease, rel1Criteria, type ReleaseState } from "./phase6-release-fixtures";

async function setup(page: Page, over: Partial<ReleaseState> = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newRelease(over);
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }), newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, newExec({ role: q.role, canApprove: q.canApprove }));
  await mockRelease(page, s, q, p4);
  await signedIn(page, s);
  return q;
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

const RR = "/projects/p1/release-readiness";
const panel = (page: Page, key = "REL-0002") => page.getByRole("region", { name: `Gate 9 · Release decision for ${key}` });
const card = (page: Page) => page.getByRole("region", { name: /^(Recommendation|Final verdict)$/ });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("QA P6-05b · Gate 9 decisions", () => {
  test("reject: reason required on submit, focus on it; then toast, record, 'Not decided', Assess again; lifecycle 'Rejected: assess again'", async ({ page }) => {
    const q = await setup(page);
    await page.goto(RR);
    const g9 = panel(page);
    await g9.getByRole("radio", { name: "Reject this assessment" }).check();
    const reason = g9.getByRole("textbox", { name: /^Reason/ });
    await reason.fill("   ");
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await expect(g9.getByText("Say why. The reason is shown on the assessment.")).toBeVisible();
    await expect(reason).toBeFocused();
    expect(q.requests.filter((r) => r.path.endsWith("/decision"))).toHaveLength(0);
    await reason.fill("  Criteria list misses the payment check  ");
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    const dialog = page.getByRole("dialog", { name: "Reject REL-0002?" });
    await expect(dialog).toContainText("Reject REL-0002? Nothing is decided and Gate 9 goes back to 'changes requested'.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Reject assessment" }).click();
    await expect(page.getByText("REL-0002 rejected.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/decision"))?.body).toEqual({ decision: "reject", reason: "Criteria list misses the payment check" });
    // Rejected: nothing decided. Focus goes to the verdict card heading (design §16.2).
    await expect(card(page).getByRole("heading", { name: "Recommendation" })).toBeFocused();
    await expect(card(page).getByText("Conditional · Not decided")).toBeVisible();
    await expect(panel(page).getByText(/^Rejected by Daniele Edema: 'Criteria list misses the payment check'/)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Assess again" })).toBeVisible();
    await expect(panel(page).getByRole("radio")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1");
    await page.getByRole("button", { name: "Show all 21 steps" }).click();
    await expect(page.getByRole("region", { name: /^Reporting/ }).getByText("Rejected: assess again")).toBeVisible();
  });

  test("override boundaries: 19 characters after trimming is refused, exactly 20 is accepted and sent trimmed", async ({ page }) => {
    const q = await setup(page);
    await page.goto(RR);
    const g9 = panel(page);
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    await g9.getByRole("group", { name: "Final verdict" }).getByRole("radio", { name: "No-go" }).check();
    const reason = g9.getByRole("textbox", { name: "Reason (at least 20 characters)" });
    await reason.fill("   1234567890123456789   "); // 19 characters + spaces
    await expect(reason).toHaveAccessibleDescription(/19 of 20 characters/);
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await expect(g9.getByText("Write at least 20 characters. The reason is shown next to the verdict.")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await reason.fill("  12345678901234567890  ");
    await expect(reason).toHaveAccessibleDescription(/20 of 20 characters/);
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    const dialog = page.getByRole("dialog", { name: "Override the recommendation?" });
    await expect(dialog).toContainText("Final verdict: No-go (recommended: Conditional)");
    // Override to No-go: no "blocking criteria not met" warning (only for Go).
    await expect(dialog.getByText(/^Blocking criteria not met/)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Override to No-go" }).click();
    await expect(page.getByText("REL-0002 overridden: No-go is final.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/decision"))?.body).toEqual({ decision: "override", final_verdict: "no_go", reason: "12345678901234567890" });
    await expect(card(page).getByText("No-go · Final")).toBeVisible();
  });

  test("No-go recommendation: Override offers Go and Conditional only; Approve sends no reason or verdict", async ({ page }) => {
    const q = await setup(page, { assessments: [assessment("REL-0001", rel1Criteria())] });
    await page.goto(RR);
    const g9 = panel(page, "REL-0001");
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    const verdicts = g9.getByRole("group", { name: "Final verdict" });
    await expect(verdicts.getByRole("radio")).toHaveCount(2);
    await expect(verdicts.getByRole("radio", { name: "Go", exact: true })).toBeVisible();
    await expect(verdicts.getByRole("radio", { name: "Conditional" })).toBeVisible();
    await expect(verdicts.getByRole("radio", { name: "No-go" })).toHaveCount(0);
    // Override to Conditional: no blocking warning (only Go gets it).
    await verdicts.getByRole("radio", { name: "Conditional" }).check();
    await g9.getByRole("textbox", { name: "Reason (at least 20 characters)" }).fill("Agreed with product to ship behind a flag");
    await g9.getByRole("button", { name: "Record decision for REL-0001" }).click();
    await expect(page.getByRole("dialog").getByText(/^Blocking criteria not met/)).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    // Switch to Approve: the verdict and reason are not sent.
    await g9.getByRole("radio", { name: "Approve: No-go becomes the final verdict" }).check();
    await expect(g9.getByRole("group", { name: "Final verdict" })).toHaveCount(0);
    await g9.getByRole("button", { name: "Record decision for REL-0001" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve: No-go" }).click();
    await expect(page.getByText("REL-0001: No-go is final.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/decision"))?.body).toEqual({ decision: "approve" });
  });

  test("Escape on the decision confirmation returns focus to Record decision; nothing is sent", async ({ page }) => {
    const q = await setup(page);
    await page.goto(RR);
    const g9 = panel(page);
    await g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" }).check();
    const record = g9.getByRole("button", { name: "Record decision for REL-0002" });
    await record.click();
    await expect(page.getByRole("dialog", { name: "Approve REL-0002?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(record).toBeFocused();
    expect(q.requests.filter((r) => r.path.endsWith("/decision"))).toHaveLength(0);
  });

  test("server 403 on decide (permission revoked meanwhile): danger callout with the message, focus on it, still waiting", async ({ page }) => {
    await setup(page);
    await page.route(`${API}/release-assessments/*/decision`, (route) =>
      route.fulfill({ status: 403, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "forbidden", message: "Deciding Gate 9 needs approval permission", details: [] } }) }),
    );
    await page.goto(RR);
    const g9 = panel(page);
    await g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" }).check();
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve: Conditional" }).click();
    const alert = g9.getByRole("alert");
    await expect(alert).toContainText("Deciding Gate 9 needs approval permission");
    // design §16.2: "Server error on submit → the danger Callout". Give the page time to settle first.
    await page.waitForTimeout(500);
    const focused = await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.slice(0, 60)}`);
    test.info().annotations.push({ type: "focus after server error", description: focused });
    const focusedInsideAlertWrapper = await page.evaluate(() => !!document.activeElement?.querySelector('[role="alert"]'));
    expect(focusedInsideAlertWrapper, `focus is on: ${focused}`).toBe(true);
    await expect(card(page).getByText("Conditional · Recommended")).toBeVisible();
  });
});

test.describe("QA P6-05b · assess", () => {
  test("assess fails: 'Couldn't assess release readiness: {reason}. Nothing was changed.' with Try again, focus on the callout", async ({ page }) => {
    await setup(page, { assessments: [] });
    await page.route(`${API}/projects/p1/release-assessments`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "conflict", message: "Release readiness is already being assessed.", details: [] } }) })
        : route.fallback(),
    );
    await page.goto(RR);
    await expect(page.getByText("Not assessed yet.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Assess release readiness" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't assess" });
    await expect(alert).toHaveText(/Couldn't assess release readiness: Release readiness is already being assessed\. Nothing was changed\./);
    const focusedInside = await page.evaluate(() => !!document.activeElement?.querySelector('[role="alert"]'));
    expect(focusedInside).toBe(true);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("no assessment yet: empty state copy + statement-free; Assess (members) immediately, no confirm dialog; toast and focus on h1", async ({ page }) => {
    const q = await setup(page, { assessments: [], assessDelay: 1 });
    await page.goto(RR);
    await expect(page.getByText("Not assessed yet.", { exact: true })).toBeVisible();
    await expect(page.getByText("The platform checks the exit criteria and recommends Go, Conditional or No-go. A person decides at Gate 9.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Assess release readiness" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("REL-0001: Conditional (recommended).")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Release readiness" })).toBeFocused();
    expect(q.requests.filter((r) => r.method === "POST" && r.path === "/projects/p1/release-assessments")).toHaveLength(1);
    await expect(page.getByText("This is the first assessment.")).toBeVisible();
  });

  test("stale latest: [Assess release readiness] doesn't ask first; Overview row 'out of date' with Assess again; Reports badge", async ({ page }) => {
    const stale = demoAssessments();
    Object.assign(stale[0], { status: "stale", stale_reason: "RUN-0006 finished at 16:20", verdict_state: "not_decided" });
    await setup(page, { assessments: stale });
    await page.goto("/projects/p1");
    await expect(page.getByText("REL-0002 is out of date: evidence changed after it was assessed.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Assess again" })).toHaveAttribute("href", RR);
    await expect(page.getByRole("region", { name: "Release readiness" }).getByText("Out of date: evidence changed after REL-0002.")).toBeVisible();
    // No waiting pill for a stale one.
    await expect(page.getByText("REL-0002 waiting for your decision (Gate 9)")).toHaveCount(0);
    await page.goto(RR);
    await page.getByRole("button", { name: "Assess release readiness" }).click();
    await expect(page.getByRole("dialog", { name: "Assess again?" })).toHaveCount(0);
    await expect(page.getByText("REL-0003: Conditional (recommended).")).toBeVisible({ timeout: 15_000 });
  });

  test("assessing from an older assessment's page goes to the latest page", async ({ page }) => {
    const stale = demoAssessments();
    Object.assign(stale[0], { status: "stale", stale_reason: "RUN-0006 finished at 16:20", verdict_state: "not_decided" });
    await setup(page, { assessments: stale });
    await page.goto(`${RR}/REL-0001`);
    await expect(page.getByText("You're viewing REL-0001 (Final: No-go). The latest is REL-0002.")).toBeVisible();
    await page.getByRole("button", { name: "Assess release readiness" }).click();
    await expect(page).toHaveURL(new RegExp(`${RR}$`));
    await expect(page.getByText("REL-0003: Conditional (recommended).")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("QA P6-05b · offline, roles, pages", () => {
  test("offline: Record decision and Assess are aria-disabled with 'You're offline. Reconnect to …'", async ({ page, context }) => {
    const q = await setup(page);
    await page.goto(RR);
    await expect(card(page).getByText("Conditional · Recommended")).toBeVisible();
    await context.setOffline(true);
    const g9 = panel(page);
    const record = g9.getByRole("button", { name: "Record decision for REL-0002" });
    await expect(record).toHaveAttribute("aria-disabled", "true");
    await expect(record).toHaveAccessibleDescription("You're offline. Reconnect to decide.");
    const assess = page.getByRole("button", { name: "Assess release readiness" });
    await expect(assess).toHaveAttribute("aria-disabled", "true");
    await expect(assess).toHaveAccessibleDescription("You're offline. Reconnect to assess.");
    await g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" }).check();
    await record.click({ force: true }); // aria-disabled: does nothing
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await context.setOffline(false);
    expect(q.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("viewer: no Confirm, no Assess, no manual re-test link, no radios; Overview attention row is text only", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false });
    await page.goto(RR);
    await expect(card(page).getByText("Conditional · Recommended")).toBeVisible();
    await expect(page.getByRole("button", { name: /Confirm result/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Assess/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Record manual re-tests/ })).toHaveCount(0);
    await expect(panel(page).getByRole("radio")).toHaveCount(0);
    await expect(panel(page).getByText("Waiting for a decision by someone who can approve")).toBeVisible();
    // Viewer sees no "your decision" anywhere.
    await expect(page.getByText(/your decision/i)).toHaveCount(0);
    await page.goto("/projects/p1");
    await expect(page.getByRole("link", { name: /Decide REL-0002|Open REL-0002|Assess release readiness/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Release readiness" }).getByRole("button")).toHaveCount(0);
  });

  test("member who can approve (member + can_approve) gets the decision form", async ({ page }) => {
    await setup(page, { role: "member", canApprove: true });
    await page.goto(RR);
    await expect(panel(page).getByRole("radio")).toHaveCount(3);
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Reports, release readiness waiting for your decision" })).toBeVisible();
  });

  test("superseded REL-0002 page: banner and panel name REL-0003, 'Not decided', no radios, no Confirm", async ({ page }) => {
    const list = demoAssessments();
    Object.assign(list[0], { status: "superseded", superseded_by: "REL-0003", verdict_state: "not_decided" });
    const r3 = assessment("REL-0003", list[0].criteria.map((c) => ({ ...c })), { id: "rel3" });
    await setup(page, { assessments: [r3, ...list] });
    await page.goto(`${RR}/REL-0002`);
    await expect(page.getByRole("heading", { level: 1, name: "Release readiness · REL-0002" })).toBeVisible();
    await expect(card(page).getByText("Conditional · Not decided")).toBeVisible();
    await expect(page.getByText(/^Replaced by REL-0003 \(.+\)\. This assessment can't be decided\.$/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Open REL-0003" }).first()).toHaveAttribute("href", RR);
    await expect(panel(page).getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Confirm result/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Go to the decision" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("criteria filter: Not evaluable only; 'Blocking first' off restores server order", async ({ page }) => {
    await setup(page);
    await page.goto(RR);
    const table = page.getByRole("table", { name: "Criteria (8)" });
    await page.getByLabel("Status").selectOption("not_evaluable");
    await expect(table.getByRole("rowheader")).toHaveCount(2);
    await page.getByLabel("Status").selectOption("met");
    await expect(table.getByRole("rowheader")).toHaveCount(4);
    await page.getByLabel("Status").selectOption("");
    await page.getByRole("checkbox", { name: "Blocking first" }).uncheck();
    await expect(table.getByRole("rowheader").nth(4)).toContainText("95 % of executed tests pass");
  });

  test("Reports page: no 'Phase 6' note; Release readiness card links to the page; breadcrumb on the page", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/reports");
    await expect(page.getByText(/Phase 6/)).toHaveCount(0);
    const glance = page.getByRole("region", { name: "Release readiness" });
    await expect(glance.getByText("Conditional · Recommended")).toBeVisible();
    await glance.getByRole("link", { name: "Open release readiness" }).click();
    await expect(page).toHaveURL(new RegExp(`${RR}$`));
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toContainText("Release readiness");
    await expect(page.getByRole("link", { name: "Reports" }).first()).toBeVisible();
  });

  test("320 px: page, decision form and reject dialog don't scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await setup(page);
    await page.goto(RR);
    await expect(card(page).getByText("Conditional · Recommended")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const g9 = panel(page);
    await g9.getByRole("radio", { name: "Reject this assessment" }).check();
    await g9.getByRole("textbox", { name: /^Reason/ }).fill("Criteria list misses the payment check");
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });

  test("touch targets: G9 radio rows and Go to the decision are at least 24 px tall", async ({ page }) => {
    await setup(page);
    await page.goto(RR);
    const g9 = panel(page);
    for (const label of await g9.locator("label").all()) {
      const box = await label.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(24);
    }
    const go = await card(page).getByRole("link", { name: "Go to the decision" }).boundingBox();
    expect(go!.height).toBeGreaterThanOrEqual(24);
  });
});
