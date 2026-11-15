// Phase 4 Test Execution, Gate 7, failure analysis and Defects / Gate 8 against the stubbed API (./fixtures.ts + the
// phase 2–4 fixtures + ./phase4-exec-fixtures.ts, test-only). Each test names the design checks
// (docs/design/P4-qa-analyst-phase4.md §20) it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, mockReportsP4, mockTraceP4, newExec, runningRun, waitingRun, type ExecState } from "./phase4-exec-fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

function consoleErrors(page: Page): string[] {
  const out: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|media|video/i.test(m.text())) out.push(m.text());
  });
  page.on("pageerror", (e) => out.push(e.message));
  return out;
}

async function setup(page: Page, over: Partial<ExecState> = {}, extra?: (q: ExecState) => void) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const q = newExec(over);
  extra?.(q);
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role });
  const p3 = newP3({ designed: true, g5: "approved", canApprove: q.canApprove });
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, p3);
  await mockPhase4(page, s, p4);
  await mockExec(page, q);
  await signedIn(page, s);
  return q;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Phase 4 · execution and Gate 7", () => {
  test("sidebar: sections built with Authorise and drafts badges; Non-functional built in Phase 5 (checks 1, 4)", async ({ page }) => {
    await setup(page, {}, (q) => q.runs.unshift(waitingRun(q)));
    await page.goto("/projects/p1/execution");
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Test Execution, 1 run waiting for authorisation" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Defects, 2 drafts waiting for review" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Non-functional", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: /coming in Phase 4/ })).toHaveCount(0);
    await expect(page.getByText("RUN-0004 is waiting for your authorisation")).toBeVisible();
  });

  test("after authorising, the header and sidebar stop asking for authorisation at once (QA P4-BUG-11)", async ({ page }) => {
    await setup(page, {}, (q) => q.runs.unshift(waitingRun(q)));
    await page.goto("/projects/p1/execution/RUN-0004");
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Test Execution, 1 run waiting for authorisation" })).toBeVisible();
    await expect(page.getByText("RUN-0004 waiting for your authorisation")).toBeVisible();
    const panel = page.getByRole("region", { name: "Gate 7 · Authorise RUN-0004" });
    await panel.getByRole("button", { name: /Authorise and run/ }).click();
    // Well before the 15 s poll: the project refresh revalidates the run list behind the header and sidebar.
    await expect(page.getByText("RUN-0004 waiting for your authorisation")).toHaveCount(0, { timeout: 5000 });
    await expect(nav.getByRole("link", { name: "Test Execution, 1 run waiting for authorisation" })).toHaveCount(0, { timeout: 5000 });
  });

  test("runs list: text-first results, flaky separate; axe and 375 px", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/execution");
    await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
    await expect(page.getByText("Runs are started by a person and authorised for each run (Gate 7).", { exact: false })).toBeVisible();
    const table = page.getByRole("table", { name: "Test runs" });
    await expect(table.getByRole("link", { name: "Open RUN-0003" })).toBeVisible();
    await expect(table.getByText("1 passed · 1 failed · 1 flaky · 1 blocked")).toBeVisible();
    await expect(table.getByText("Finished · 1 failed")).toBeVisible();
    await expect(table.getByText("M. Member · A. Approver")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByRole("list", { name: "Test runs" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test("approver: defaults, the demo side-effect line, retries; Authorise and run in one click (checks 13, 14, 15)", async ({ page }) => {
    const q = await setup(page);
    await page.goto("/projects/p1/execution");
    await page.getByRole("button", { name: "Run tests…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Run tests" });
    await expect(dialog.getByText("Step 1 of 2 · What to run")).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Chromium/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Firefox/ })).toBeDisabled();
    await expect(dialog.getByText("Firefox · Not installed on this server")).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Desktop 1440 × 900/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Mobile 390 × 844/ })).not.toBeChecked();
    await expect(dialog.getByText("4 tests will run: 4 test cases × 1 browser × 1 screen size.")).toBeVisible();
    await dialog.getByRole("button", { name: "Left out (1)" }).click();
    await expect(dialog.getByText("· script can't run")).toBeVisible();
    await dialog.getByRole("button", { name: "Next: check what this run will do" }).click();
    await expect(dialog.getByText("Step 2 of 2 · Authorise")).toBeVisible();
    await expect(dialog.getByText("May submit the Contact us form (if the application does not block it): 1 test")).toBeVisible();
    await dialog.getByRole("button", { name: "Show 1 test that may submit the Contact us form (if the application does not block it)" }).click();
    await expect(dialog.getByText("Send the contact form with an empty Message")).toBeVisible();
    await expect(dialog.getByText("Pays, buys or deletes anything: no")).toBeVisible();
    await expect(dialog.getByText(/runs once more .* so it may submit a form twice/)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Authorise and run 4 tests" }).click();
    await expect(page).toHaveURL(/\/execution\/RUN-0004$/);
    const post = q.requests.find((r) => r.method === "POST" && r.path === "/projects/p1/execution-runs");
    expect(post?.body).toMatchObject({ authorise: true, browsers: ["chromium"], viewports: ["desktop"], selection: { suite: "regression" } });
    await expect(page.getByText("RUN-0004 authorised and starting.")).toBeVisible();
    await expect(page.getByText("Authorised. Waiting for a free test runner.")).toBeVisible();
  });

  test("member: Request authorisation; the run waits and can be withdrawn (check 16)", async ({ page }) => {
    const q = await setup(page, { role: "member", canApprove: false });
    await page.goto("/projects/p1/execution?new=1");
    const dialog = page.getByRole("dialog", { name: "Run tests" });
    await dialog.getByRole("button", { name: "Next: check what this run will do" }).click();
    await expect(dialog.getByText("Nothing runs until someone who can approve gates authorises it.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Authorise and run/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Request authorisation" }).click();
    await expect(page).toHaveURL(/\/execution\/RUN-0004$/);
    expect(q.requests.find((r) => r.path === "/projects/p1/execution-runs")?.body).toMatchObject({ authorise: false });
    await expect(page.getByText("RUN-0004 requested. Someone who can approve gates must authorise it.")).toBeVisible();
    const panel = page.getByRole("region", { name: "Gate 7 · Authorise RUN-0004" });
    await expect(panel.getByText("Waiting for authorisation by someone who can approve gates", { exact: true })).toBeVisible();
    await expect(panel.getByText("Authorising runs needs gate-approval permission.", { exact: false })).toBeVisible();
    await expect(panel.getByRole("button", { name: /Authorise and run/ })).toHaveCount(0);
    await panel.getByRole("button", { name: "Withdraw request" }).click();
    await expect(page.getByText("Request withdrawn. Nothing ran.").first()).toBeVisible();
  });

  test("risky action: approval card needs a decision and the typed host (check 17)", async ({ page }) => {
    const q = await setup(page, { risky: true });
    await page.goto("/projects/p1/execution?new=1");
    const dialog = page.getByRole("dialog", { name: "Run tests" });
    await dialog.getByRole("button", { name: "Next: check what this run will do" }).click();
    await expect(dialog.getByText("Needs a separate approval (1)")).toBeVisible();
    await expect(dialog.getByText("External transaction (payment or purchase)")).toBeVisible();
    await expect(dialog.getByText(/TC-0044 isn't retried because it may make a payment/)).toBeVisible();
    const authorise = dialog.getByRole("button", { name: "Authorise and run 5 tests" });
    await expect(authorise).toHaveAttribute("aria-disabled", "true");
    await expect(dialog.getByText("Decide 1 separate approval above to continue.")).toBeVisible();
    await authorise.click({ force: true });
    expect(q.requests.filter((r) => r.path === "/projects/p1/execution-runs")).toHaveLength(0);
    await dialog.getByRole("radio", { name: /Approve: this test may make a payment/ }).check();
    await dialog.getByLabel("Type localhost:4100 to confirm").fill("shop.example.com");
    await expect(dialog.getByText("Type localhost:4100 exactly to confirm.").first()).toBeVisible();
    await dialog.getByLabel("Type localhost:4100 to confirm").fill(" LOCALHOST:4100 ");
    await dialog.getByRole("button", { name: "Authorise and run 5 tests" }).click();
    await expect(page).toHaveURL(/\/execution\/RUN-0004$/);
    expect(q.requests.find((r) => r.path === "/projects/p1/execution-runs")?.body).toMatchObject({ authorise: true, approvals: [{ kind: "external_transaction", decision: "approve", confirm_text: " LOCALHOST:4100 " }] });
  });

  test("G7 review: reject needs a comment, then 'Not authorised … Nothing ran.' (check 18)", async ({ page }) => {
    await setup(page, {}, (q) => q.runs.unshift(waitingRun(q)));
    await page.goto("/projects/p1/execution/RUN-0004");
    const panel = page.getByRole("region", { name: "Gate 7 · Authorise RUN-0004" });
    await expect(panel.getByText("Waiting for your authorisation")).toBeVisible();
    await expect(panel.getByText('Requested by M. Member', { exact: false })).toBeVisible();
    await expect(panel.getByText("May submit the Contact us form (if the application does not block it): 1 test")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await panel.getByRole("button", { name: "Reject request…" }).click();
    await expect(panel.getByText("Say why this run shouldn't go ahead.")).toBeVisible();
    await panel.getByLabel("Comment (needed to reject)").fill("Wrong week");
    await panel.getByRole("button", { name: "Reject request…" }).click();
    await expect(page.getByText("Not authorised by Daniele Edema: 'Wrong week'. Nothing ran.")).toBeVisible();
  });

  test("running: live tiles with pause, polite region, cancel confirm (checks 20, 25)", async ({ page }) => {
    const q = await setup(page, {}, (x) => x.runs.unshift(runningRun(x)));
    await page.goto("/projects/p1/execution/RUN-0005");
    await expect(page.getByText("Progress 1 of 4 finished · 1 passed · 3 to go")).toBeVisible();
    const live = page.getByRole("region", { name: "Live view of the test browser" });
    await expect(live.getByRole("img", { name: /Live view of the test browser, worker 1: TC-0019/ })).toBeVisible();
    await expect(live.getByText("Attempt 2 of 2", { exact: false })).toBeVisible();
    await live.getByRole("button", { name: "Pause live view" }).click();
    await expect(live.getByRole("button", { name: "Resume live view" })).toBeVisible();
    await expect(page.getByText("Frames aren't saved. Failed tests keep a video recording.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /RUN-0005/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel run…" }).click();
    const confirm = page.getByRole("dialog", { name: "Cancel RUN-0005?" });
    await expect(confirm.getByText("The 3 unfinished tests are marked 'Error: run cancelled'.", { exact: false })).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByText("RUN-0005 cancelled.")).toBeVisible();
    expect(q.requests.some((r) => r.path === "/execution-runs/run-0005/cancel")).toBe(true);
    await expect(live).toHaveCount(0);
  });

  test("reduced motion: the live view starts paused (check 20)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page, {}, (x) => x.runs.unshift(runningRun(x)));
    await page.goto("/projects/p1/execution/RUN-0005");
    await expect(page.getByRole("button", { name: "Play live view" })).toBeVisible();
  });
});

test.describe("Phase 4 · results and analysis", () => {
  test("run page: What failed and why, groups and footnote (check 27)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/execution/RUN-0003");
    await expect(page.getByRole("heading", { level: 1, name: "RUN-0003 · Regression" })).toBeVisible();
    const card = page.getByRole("region", { name: "What failed and why" });
    await expect(card.getByText("2 tests need attention")).toBeVisible();
    const groups = card.locator(":scope > div > ul > li");
    await expect(groups.first()).toContainText("Likely bug in the application");
    await expect(groups.nth(1)).toContainText("Flaky");
    await expect(card.getByText("DEF-0001 drafted", { exact: false })).toBeVisible();
    await expect(card.getByText("passed on retry; no defect", { exact: false })).toBeVisible();
    await expect(card.getByText("Only likely application bugs become defect drafts. Script, page and environment problems don't.")).toBeVisible();
    const table = page.getByRole("table", { name: "Tests in this run" });
    await expect(table.getByText("Blocked: needs saved test credentials")).toBeVisible();
    await expect(table.getByText("Flaky (passed on retry)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Re-run failed tests…" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("result detail: expected vs actual, attempts, evidence, Hypothesis with Observed signals (checks 22, 26)", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/execution/RUN-0003/results/RUN-0003-01");
    await expect(page.getByRole("heading", { level: 1, name: /RUN-0003-01 · TC-0019/ })).toBeVisible();
    await expect(page.getByText("failed on both attempts (2 of 2)", { exact: false })).toBeVisible();
    const ea = page.getByRole("region", { name: "Expected and actual" });
    await expect(ea.getByText("Submission is blocked and Message is identified as required")).toBeVisible();
    await expect(ea.locator('[data-provenance="assumed"]')).toBeVisible();
    await expect(ea.getByText(/the page shows 'Thank you'/)).toBeVisible();
    await expect(ea.getByText("Observed on the page")).toBeVisible();
    await expect(page.getByText("Attempt 1: failed at step 5 · Attempt 2: failed at step 5")).toBeVisible();
    await expect(page.getByText("Expected: the submission is blocked; Message is flagged as required")).toBeVisible();
    const why = page.getByRole("region", { name: "Why it failed" });
    await expect(why.getByText("Likely bug in the application").first()).toBeVisible();
    await expect(why.getByText("· Confidence: High")).toBeVisible();
    await expect(why.getByText(/^Hypothesis/)).toBeVisible();
    await expect(why.getByText("Generated by rules (AI not configured)")).toBeVisible();
    await expect(why.getByText("No network errors, safety blocks or server errors")).toBeVisible();
    await expect(why.getByRole("link", { name: "Open DEF-0001" })).toBeVisible();
    await expect(page.getByRole("link", { name: /View DEF-0001/ })).toBeVisible();
    const ev = page.getByRole("region", { name: "Evidence" });
    await expect(ev.getByRole("img", { name: "Final screen of TC-0019 on Chromium desktop, attempt 2" })).toBeVisible();
    await expect(ev.getByText("Password fields are hidden in every screenshot.")).toBeVisible();
    await ev.getByRole("tab", { name: "Video" }).click();
    await expect(ev.locator("video[controls]")).toHaveCount(1);
    await expect(ev.locator("video[autoplay]")).toHaveCount(0);
    await expect(ev.getByText("Recording of TC-0019 on Chromium.", { exact: false })).toBeVisible();
    await ev.getByRole("tab", { name: /Console \(1 error\)/ }).click();
    await expect(ev.getByText("<script>window.__pwned=1</script> failed", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await ev.getByRole("tab", { name: /Network \(3 requests, 1 blocked\)/ }).click();
    await expect(ev.getByText("Blocked by safety policy: cdn.evil.example isn't an approved site.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("change the cause: reason required; status still Failed (check 28)", async ({ page }) => {
    const q = await setup(page, { role: "member", canApprove: false });
    await page.goto("/projects/p1/execution/RUN-0003/results/RUN-0003-01");
    await page.getByRole("button", { name: "Change the cause…" }).click();
    const dialog = page.getByRole("dialog", { name: "Change the cause" });
    await expect(dialog.getByText("This changes the likely cause only. The test result stays Failed.")).toBeVisible();
    await dialog.getByRole("radio", { name: /Element not found/ }).check();
    await expect(dialog.getByText("DEF-0001 stays as a draft. Reject it at Gate 8 if it isn't a bug.")).toBeVisible();
    await dialog.getByRole("button", { name: "Change the cause" }).click();
    await expect(dialog.getByText("Say why you think the cause is different.")).toBeVisible();
    expect(q.requests.filter((r) => r.path.endsWith("/classification"))).toHaveLength(0);
    await dialog.getByLabel("Reason").fill("The label changed on /contact");
    await dialog.getByRole("button", { name: "Change the cause" }).click();
    await expect(page.getByText("Cause set by Daniele Edema: 'The label changed on /contact'")).toBeVisible();
    await expect(page.getByText("Set by Daniele Edema", { exact: true })).toBeVisible();
    await expect(page.getByText("Previously:", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 }).locator("..").getByText("Failed", { exact: true })).toBeVisible();
  });

  test("flaky result: never a defect (check 24)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/execution/RUN-0003/results/RUN-0003-04");
    await expect(page.getByText("Flaky (passed on retry)").first()).toBeVisible();
    await expect(page.getByText("Failed on attempt 1, passed on attempt 2. Treated as flaky, not as a bug.")).toBeVisible();
    await expect(page.getByText("No defect drafted: flaky results aren't treated as bugs.")).toBeVisible();
    await expect(page.getByRole("link", { name: /DEF-/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Raise defect…" })).toHaveCount(0);
  });

  test("fix suggestion: unique locators, a locator-only diff, accept creates v2 and asks to validate (§9.3)", async ({ page }) => {
    const q = await setup(page, {}, (x) => {
      const g = x.runs[0].analysis!.output!.groups;
      g.push({ classification: "selector_failure", label: "Element not found", items: [{ result_id: "res-RUN-0003-5", result_key: "RUN-0003-05", case_key: "TC-0040", signal: "getByLabel('Message') wasn't found", defect: null, fix_suggestion: true }] });
    });
    await page.goto("/projects/p1/execution/RUN-0003");
    const card = page.getByRole("region", { name: "What failed and why" });
    await expect(card.getByText("a fix suggestion is ready", { exact: false })).toBeVisible();
    await card.getByRole("link", { name: /Open TC-0040 result/ }).click();
    const fix = page.getByRole("region", { name: "Fix suggestion" });
    await expect(fix.getByText("The Message field's label changed. These locators find it on /contact today:")).toBeVisible();
    await expect(fix.getByRole("radio", { name: /getByLabel\("Your message"\)/ })).toBeChecked();
    await expect(fix.getByText("(recommended)")).toBeVisible();
    await expect(fix.getByText("Found once")).toHaveCount(2);
    await expect(fix.getByText("Change to ContactPage.ts")).toBeVisible();
    await expect(fix.getByText("Changes how the test finds the field, not what it checks. Expected results stay the same.")).toBeVisible();
    await expect(fix.getByText("Creates ContactPage.ts version 2. Scripts must pass checks before they run.")).toBeVisible();
    await fix.getByRole("radio", { name: /getByRole/ }).check();
    await expect(fix.getByText('this.page.getByRole("textbox", { name: "Your message" })').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await fix.getByRole("button", { name: "Accept fix suggestion" }).click();
    await expect(page.getByText("ContactPage.ts version 2 created. Validate it before the next run.")).toBeVisible();
    const call = q.requests.find((r) => r.path.endsWith("/accept"));
    expect(call?.path).toBe("/execution-results/res-RUN-0003-5/heal-suggestions/1/accept");
    await expect(fix.getByText(/Accepted: ContactPage.ts version 2 uses getByRole/)).toBeVisible();
    await expect(fix.getByRole("button", { name: "Accept fix suggestion" })).toHaveCount(0);
    await expect(fix.getByRole("button", { name: "Validate now" })).toBeVisible();
  });

  test("fix suggestion: viewers see it but can't accept", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false });
    await page.goto("/projects/p1/execution/RUN-0003/results/RUN-0003-05");
    const fix = page.getByRole("region", { name: "Fix suggestion" });
    await expect(fix.getByText("Change to ContactPage.ts")).toBeVisible();
    await expect(fix.getByRole("button", { name: "Accept fix suggestion" })).toHaveCount(0);
  });

  test("sign-in result: traces are off; no credentials in the DOM (check 23)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/execution/RUN-0006/results/RUN-0006-01");
    await page.getByRole("tab", { name: "Trace" }).click();
    await expect(page.getByText("No trace: traces are switched off for tests that sign in, so the password is never recorded.")).toBeVisible();
    expect(await page.content()).not.toMatch(/password\s*[:=]/i);
  });

  test("unknown run key: app 404 copy", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/execution/RUN-0099");
    await expect(page.getByText("We couldn’t find RUN-0099 in this project.")).toBeVisible();
  });
});

test.describe("Phase 4 · defects and Gate 8", () => {
  test("member: permission note first, disabled decisions, no dialog (check 31)", async ({ page }) => {
    const q = await setup(page, { role: "member", canApprove: false });
    await page.goto("/projects/p1/defects?view=review");
    const gate = page.getByRole("region", { name: "Gate 8 · Defect review" });
    await expect(gate.getByText("2 drafts waiting for review by someone who can approve gates")).toBeVisible();
    await expect(gate.getByText("You can read and edit these drafts, but confirming or rejecting needs gate-approval permission.", { exact: false })).toBeVisible();
    const confirm = gate.getByRole("button", { name: "Confirm DEF-0001" });
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await confirm.click({ force: true });
    await gate.getByRole("button", { name: "Reject DEF-0001…" }).click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(q.requests.filter((r) => r.path.includes("/status"))).toHaveLength(0);
    await expect(gate.getByRole("checkbox")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("approver: confirm is immediate and focus moves to the next draft (checks 44, 5)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/defects?view=review");
    const gate = page.getByRole("region", { name: "Gate 8 · Defect review" });
    await expect(gate.getByText("2 drafts waiting for your review")).toBeVisible();
    await gate.getByRole("button", { name: "Confirm DEF-0001" }).click();
    await expect(page.getByText("DEF-0001 confirmed.")).toBeVisible();
    await expect(gate.getByRole("button", { name: "Confirm DEF-0002" })).toBeFocused();
    await expect(gate.getByRole("button", { name: "Confirm DEF-0001" })).toHaveCount(0);
  });

  test("reject as Works as intended: comment required, Edit TC link with the Gate 5 note (check 33)", async ({ page }) => {
    const q = await setup(page);
    await page.goto("/projects/p1/defects?view=review");
    await page.getByRole("button", { name: "Reject DEF-0001…" }).click();
    const dialog = page.getByRole("dialog", { name: "Reject DEF-0001" });
    await dialog.getByRole("radio", { name: "Works as intended" }).check();
    await expect(dialog.getByRole("link", { name: "Edit TC-0019" })).toBeVisible();
    await expect(dialog.getByText("Editing it moves the case back to draft and Gate 5 needs approval again. Nothing changes automatically.")).toBeVisible();
    await dialog.getByRole("button", { name: "Reject DEF-0001" }).click();
    await expect(dialog.getByText("Choose a reason and add a comment to reject.")).toBeVisible();
    await dialog.getByLabel("Comment").fill("Message is optional by design");
    await dialog.getByRole("button", { name: "Reject DEF-0001" }).click();
    await expect(page.getByText("DEF-0001 rejected.")).toBeVisible();
    expect(q.requests.find((r) => r.path === "/defects/def-0001/status")?.body).toMatchObject({ action: "reject", reason: "works_as_intended", comment: "Message is optional by design" });
  });

  test("bulk confirm skips non-drafts with reasons (check 32)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/defects");
    const table = page.getByRole("table", { name: "Defects" });
    for (const k of ["DEF-0001", "DEF-0002", "DEF-0003", "DEF-0004"]) await table.getByRole("checkbox", { name: new RegExp(`^Select ${k}`) }).check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Confirm 4" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm defects" });
    await expect(dialog.getByText("Confirm 4 defects? 2 can't be confirmed: they aren't drafts.")).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm 2" }).click();
    await expect(page.getByText("2 defects confirmed. 2 skipped.")).toBeVisible();
  });

  test("defect detail: every field labelled, derivations, verify disabled with the reason, no delete (checks 30, 34, 35)", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/defects/DEF-0001");
    await expect(page.getByRole("heading", { level: 1, name: "DEF-0001 · Contact form accepts an empty Message" })).toBeVisible();
    for (const h of ["Description", "Environment", "Preconditions", "Steps to reproduce", "Expected result", "Actual result", "Root cause", "Evidence"]) await expect(page.getByRole("heading", { name: new RegExp(`^${h}`) })).toBeVisible();
    await expect(page.getByText("2 of 2 attempts (always)")).toBeVisible();
    await expect(page.getByText('from REQ-0006 risk High (RISK-005) and "a blocked submission failed"')).toBeVisible();
    await expect(page.getByText("· from TC-0019")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Root cause/ }).getByText(/^Hypothesis/)).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1/defects/DEF-0004");
    const verify = page.getByRole("button", { name: "Mark verified" });
    await expect(verify).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("No passing re-run yet. Re-run TC-0019 after the fix to verify it.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Re-run TC-0019…" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("raise a defect from a result: prefilled; errors name the field", async ({ page }) => {
    const q = await setup(page);
    await page.goto("/projects/p1/defects/new?from=RUN-0003-01");
    await expect(page.getByText("Prefilled from RUN-0003-01. Check the wording before saving.")).toBeVisible();
    await expect(page.getByLabel("Expected result")).toHaveValue("Submission is blocked and Message is identified as required");
    await page.getByLabel(/^Summary/).fill("");
    await page.getByRole("button", { name: "Save as draft" }).click();
    await expect(page.getByText("Add a summary.")).toBeVisible();
    await page.getByLabel(/^Summary/).fill("Contact form accepts an empty Message");
    await page.getByRole("button", { name: "Save as draft" }).click();
    await expect(page.getByText("DEF-0005 created as a draft.")).toBeVisible();
    expect(q.requests.find((r) => r.path === "/projects/p1/defects")?.body).toMatchObject({ from_result_id: "res-RUN-0003-1" });
  });

  test("375 px: defects and the run page don't scroll sideways (check 45)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto("/projects/p1/defects");
    await expect(page.getByRole("list", { name: "Defects" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto("/projects/p1/execution/RUN-0003/results/RUN-0003-01");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("Phase 4 · traceability and readiness (P4-12)", () => {
  test("coverage tiles are text; gap lists computed with a Flaky tests sub-list", async ({ page }) => {
    await setup(page);
    await mockTraceP4(page);
    await page.goto("/projects/p1/traceability");
    await expect(page.getByText("Execution coverage")).toBeVisible();
    await expect(page.getByText("1 of 2", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("0 of 2 (0%)")).toBeVisible();
    await expect(page.getByText("latest result per test; flaky and errors shown separately · 1 flaky")).toBeVisible();
    await expect(page.getByText("Automation coverage")).toBeVisible();
    await expect(page.getByText("Needs test execution", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Failed tests (1)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Flaky tests (1)" })).toBeVisible();
    await expect(page.getByText("Passed only on retry. Counted separately, never as passed.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Automated but not run (1)" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Open TC-0019/ })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("matrix: Scripts · Results · Defects columns in text; chain from DEF-0001 walks back up", async ({ page }) => {
    await setup(page);
    await mockTraceP4(page);
    await page.goto("/projects/p1/traceability?view=matrix");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader", { name: "Execution" })).toBeVisible();
    await expect(table.getByText("Later phases")).toHaveCount(0);
    await expect(table.getByText("TC-0019.spec.ts ✓ Valid")).toBeVisible();
    await expect(table.getByRole("link", { name: "Result for TC-0019: failed in RUN-0003" })).toBeVisible();
    await expect(table.getByText("Not run")).toBeVisible();
    await expect(table.getByRole("link", { name: "DEF-0001 Draft" })).toBeVisible();
    await page.goto("/projects/p1/traceability/DEF-0001");
    await expect(page.getByRole("heading", { level: 1, name: /Trace DEF-0001/ })).toBeVisible();
    for (const t of ["Requirement", "Test case", "Script", "Result", "Defect"]) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "TC-0019.spec.ts v1 · Valid" })).toHaveAttribute("href", /automation\?view=scripts/);
    await expect(page.getByText("(you are here)")).toBeVisible();
  });

  test("375 px card ends with the script, last result and defect line", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await mockTraceP4(page);
    await page.goto("/projects/p1/traceability?view=matrix");
    await expect(page.getByText("TC-0019: Script ✓ Valid · Last result ✗ Failed (RUN-0003) · DEF-0001 Draft")).toBeVisible();
    await expect(page.getByText("TC-0020: Script ✓ Valid · Not run")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("Phase 4 · reports (P4-11)", () => {
  test("reports list: Test Execution Report per run and the Defect Report with its Gate 8 draft state", async ({ page }) => {
    await setup(page);
    await mockReportsP4(page);
    await page.goto("/projects/p1/reports");
    const table = page.getByRole("table", { name: "Execution and defect reports" });
    await expect(table.getByRole("link", { name: "Test Execution Report" })).toBeVisible();
    await expect(table.getByText("Version 1 · RUN-0003")).toBeVisible();
    await expect(table.getByText("Draft · Gate 8 waiting")).toBeVisible();
    await expect(table.getByRole("button", { name: /Generate \(latest result per test case\)/ })).toBeVisible();
    await expect(page.getByText("Test Completion and Release Readiness reports arrive in Phase 6.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("execution report: hypothesis band, totals with flaky apart, results link to the result", async ({ page }) => {
    await setup(page);
    await mockReportsP4(page);
    await page.goto("/projects/p1/reports/test-execution?run=RUN-0003");
    await expect(page.getByRole("heading", { level: 1, name: "Test Execution Report" })).toBeVisible();
    await expect(page.getByText("Causes are hypotheses unless a person confirmed them.").first()).toBeVisible();
    await expect(page.getByText("1 passed · 1 failed · 1 flaky · 0 errors · 1 blocked · 0 skipped (4 tests)")).toBeVisible();
    await expect(page.getByText("Likely bug in the application (Hypothesis)")).toBeVisible();
    await expect(page.getByText("Flaky (set by a person)")).toBeVisible();
    await expect(page.getByRole("link", { name: "RUN-0003-01" })).toHaveAttribute("href", "/projects/p1/execution/RUN-0003/results/RUN-0003-01");
    await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download XLSX" })).toBeVisible(); // P5-04b, check 29
    // QA P4-BUG-03: the approved cases left to a person, with reasons, and the limitations.
    await expect(page.getByRole("heading", { name: "Not automated" })).toBeVisible();
    await expect(page.getByText("Step 5's expected result 'sent to the company' needs human judgement")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Limitations" })).toBeVisible();
    await expect(page.getByText("Not run in Firefox or WebKit, so this report says nothing about those browsers.")).toBeVisible();
    // QA R2-BUG-01: a failure that hit a known defect again names it on the row and in the defect list.
    await expect(page.getByRole("link", { name: "DEF-0001 (occurrence 2)" })).toHaveAttribute("href", "/projects/p1/defects/DEF-0001");
    await expect(page.getByText("Contact form accepts an empty Message · Confirmed · Major · seen again")).toBeVisible();
    // QA R2-BUG-02: who requested and authorised the run, when, and how it ran. Names only.
    await expect(page.getByText(/^Mo Plainmember · /)).toBeVisible();
    await expect(page.getByText(/^Avery Approver · /)).toBeVisible();
    await expect(page.getByText("2 workers · 1 retry per failed test")).toBeVisible();
    await expect(page.getByText("Desktop 1440 × 900", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("@example.com")).toHaveCount(0);
  });

  test("defect report: DRAFT band while drafts wait for Gate 8", async ({ page }) => {
    await setup(page);
    await mockReportsP4(page);
    await page.goto("/projects/p1/reports/defects");
    await expect(page.getByText("DRAFT: 2 defects not yet reviewed at Gate 8")).toBeVisible();
    await expect(page.getByRole("heading", { name: /DEF-0001 Contact form accepts an empty Message/ })).toBeVisible();
  });

  test("run page ⋯ menu: report, analyst, copy link", async ({ page }) => {
    await setup(page);
    await mockReportsP4(page);
    await page.goto("/projects/p1/execution/RUN-0003");
    await page.getByRole("button", { name: "More actions for RUN-0003" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Ask the analyst" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Open Test Execution Report" }).click();
    await expect(page).toHaveURL(/reports\/test-execution\?run=RUN-0003/);
    await expect(page.getByText("1 passed · 1 failed · 1 flaky", { exact: false })).toBeVisible();
  });
});
