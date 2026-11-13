// Phase 3 UI behaviour against the stubbed API (./fixtures.ts + ./phase2-fixtures.ts + ./phase3-fixtures.ts,
// test-only). Each test names the design checks (docs/design/P3-qa-analyst-phase3.md §22) it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2, type P2State } from "./phase2-fixtures";
import { mockPhase3, newP3, testCase, type P3State } from "./phase3-fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

/** Console errors the app itself logs. Failed resource loads (expected 404s) are the browser's, not ours. */
function consoleErrors(page: Page): string[] {
  const out: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) out.push(m.text());
  });
  page.on("pageerror", (e) => out.push(e.message));
  return out;
}

async function setup(page: Page, p2over: Partial<P2State> = {}, over: Partial<P3State> = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", ...p2over });
  // Approved requirements 1 and 2 are what the cases cover.
  p2.requirements[1].status = "approved";
  const q = newP3(over);
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, q);
  await signedIn(page, s);
  return { s, p2, q };
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Phase 3 · test cases", () => {
  test("list: technique, open question, hidden rejected, badge, filters push history; no serious axe violations", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases");
    await expect(page.getByRole("heading", { level: 1, name: "Test Cases" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Test Cases, Gate 5 waiting for approval" })).toBeVisible();
    const table = page.getByRole("table").first();
    await expect(table.getByRole("link", { name: /TC-0001/ }).first()).toBeVisible();
    await expect(table.getByText("Open question").first()).toBeVisible();
    // Rejected cases are hidden and counted, with a way to show them.
    await expect(table.getByRole("link", { name: /TC-0004/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show them" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    // Filters are pushed (Back returns to the unfiltered list), not replaced.
    await page.getByLabel("Status").first().selectOption("draft");
    await expect(page).toHaveURL(/status=draft/);
    await page.goBack();
    await expect(page).not.toHaveURL(/status=draft/);
  });

  test("case detail: an open-question case keeps Approve focusable with the visible reason", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases/TC-0003");
    await expect(page.getByRole("heading", { level: 1, name: /TC-0003/ })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(approve).toHaveAttribute("aria-describedby", "approve-reason");
    await expect(page.locator("#approve-reason")).toContainText("open question");
    // Keyboard users reach it (aria-disabled, never the disabled attribute) and nothing happens on Enter.
    await expect(approve).not.toHaveAttribute("disabled", /.*/);
    await approve.focus();
    await expect(approve).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // "Not decided:" appears once even though the API prefixes the message (QA BUG-P3-16).
    await expect(page.getByText(/Not decided:\s*Not decided/)).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  // QA BUG-P3-02: the D6 path that unblocks Gate 5. Setup steps keep an empty expected result.
  test("write expected result: the open question clears with setup steps left empty, then the case can be approved", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto("/projects/p1/test-cases/TC-0003");
    await expect(page.getByRole("heading", { level: 1, name: /TC-0003/ })).toBeVisible();
    await page.getByRole("button", { name: "Write expected result" }).click();
    // Focus lands in the undecided step (step 3); steps 1 and 2 are setup steps with no expected result.
    await expect(page.locator("#step-2-expected")).toBeFocused();
    await expect(page.locator("#step-0-expected")).toHaveValue("");
    await page.locator("#step-2-expected").fill("The message is sent without a Message");
    // The overall result is still needed: saving names it and moves focus there.
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("#expected_result")).toBeFocused();
    await expect(page.getByText(/Describe the expected result for step [12]\./)).toHaveCount(0);
    await page.locator("#expected_result").fill("The form is accepted with Message left empty");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Expected result saved. TC-0003 can now be approved.").first()).toBeVisible();
    const patch = q.requests.find((r) => r.method === "PATCH" && r.path === "/test-cases/tc3")!.body as { steps: { expected: string }[]; expected_result: string };
    expect(patch.expected_result).toBe("The form is accepted with Message left empty");
    expect(patch.steps.map((x) => x.expected)).toEqual(["", "", "The message is sent without a Message"]);
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await approve.click();
    await expect.poll(() => q.requests.some((r) => r.path === "/test-cases/tc3/status" && (r.body as { status: string }).status === "approved")).toBe(true);
  });

  // QA BUG-P3-05: no invalid "Other" default; the technique is required, and a 422 reads as plain field errors.
  test("new case: technique must be chosen; server validation errors read as field messages", async ({ page }) => {
    const { q } = await setup(page, {}, { createErrors: [{ field: "steps.0.expected", message: "Field required" }, { field: "technique", message: "Input should be 'equivalence_partitioning', 'boundary_value_analysis' or 'checklist'" }] });
    await page.goto("/projects/p1/test-cases/new?requirement=REQ-0001");
    await expect(page.getByRole("heading", { level: 1, name: /New test case/ })).toBeVisible();
    const technique = page.getByLabel("Technique");
    await expect(technique).toHaveValue("");
    await expect(technique.locator("option", { hasText: /^Other$/ })).toHaveCount(0);
    await page.getByLabel("Title").fill("Contact form keeps the typed name after an error");
    await page.getByLabel("Objective").fill("Check the Name value survives a failed send.");
    await page.locator("#step-0-action").fill("Press Send message with Email empty");
    await page.locator("#step-0-expected").fill("Name still shows the typed value");
    await page.locator("#expected_result").fill("The typed name is kept");
    await page.getByRole("button", { name: "Create test case" }).click();
    await expect(page.getByText("Choose the test design technique this case uses.").first()).toBeVisible();
    await expect(technique).toBeFocused();
    expect(q.requests.some((r) => r.method === "POST" && r.path === "/projects/p1/test-cases")).toBe(false);

    await technique.selectOption({ label: "Use case" });
    await page.getByRole("button", { name: "Create test case" }).click();
    await expect(page.getByText("Check the expected result for step 1.").first()).toBeVisible();
    await expect(page.getByText(/Input should be|Field required/)).toHaveCount(0);
    expect((q.requests.find((r) => r.method === "POST" && r.path === "/projects/p1/test-cases")!.body as { technique: string }).technique).toBe("use_case");
  });

  // Design check 45 (QA round 2): a pending review is named before anything runs.
  test("regenerate while a review is pending says so up front and offers only the review", async ({ page }) => {
    const { q } = await setup(page, {}, { pendingReview: 3 });
    await page.goto("/projects/p1/test-cases");
    await page.getByRole("button", { name: "Regenerate…" }).click();
    const dialog = page.getByRole("dialog", { name: "Regenerate test cases?" });
    await expect(dialog.getByText("A regeneration is waiting for review. Review or discard it before starting another.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Regenerate" })).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "Review changes" })).toHaveAttribute("href", "/projects/p1/test-cases/changes?run=3");
    expect(q.requests.some((r) => r.path.includes("/stages/test_design/run"))).toBe(false);
  });

  // Coordinator follow-up: coverage items show their label ("41 characters"), never the raw id ("len:41").
  test("coverage items read as labels on conditions and test data, never raw ids", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases?view=conditions");
    await expect(page.getByRole("button", { name: "Open test data TD-0001 (41 characters)" })).toBeVisible();
    await page.goto("/projects/p1/test-cases?view=data");
    await expect(page.getByRole("heading", { name: "Form · Contact us form (/contact)" })).toBeVisible();
    await expect(page.getByText("(/contact) (/contact)")).toHaveCount(0);
    await page.getByRole("button", { name: /TD-0001/ }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("(41 characters)").first()).toBeVisible();
    await expect(drawer.getByText(/len:41/)).toHaveCount(0);
  });

  test("closing a case returns focus to the row it was opened from", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases");
    const row = page.getByRole("table").first().locator('a[data-case="TC-0002"]');
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: /TC-0002/ })).toBeVisible();
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Test Cases" }).last().click();
    await expect(page.getByRole("heading", { level: 1, name: "Test Cases" })).toBeVisible();
    await expect(page.getByRole("table").first().locator('a[data-case="TC-0002"]')).toBeFocused();
    // It stays there: the route-change focus doesn't take it back to the h1.
    await page.waitForTimeout(1200);
    await expect(page.getByRole("table").first().locator('a[data-case="TC-0002"]')).toBeFocused();
  });

  test("editing a case sends only the changed fields with its version", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto("/projects/p1/test-cases/TC-0001?edit=1");
    const title = page.getByLabel("Title");
    await title.fill("Name rejects 41 characters");
    await page.getByRole("button", { name: /^Save/ }).first().click();
    await expect.poll(() => q.requests.find((r) => r.method === "PATCH" && r.path === "/test-cases/tc1")).toBeTruthy();
    const body = q.requests.find((r) => r.method === "PATCH" && r.path === "/test-cases/tc1")!.body as Record<string, unknown>;
    expect(body.title).toBe("Name rejects 41 characters");
    expect(body.version).toBe(1);
    expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(["title", "version"]));
    expect(body.steps).toBeUndefined();
    expect(body.expected_result).toBeUndefined();
  });

  test("unknown case key shows the not-found state without app console errors", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/test-cases/TC-0999");
    await expect(page.getByText("We couldn’t find TC-0999 in this project.")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("Phase 3 · Gate 5", () => {
  test("blockers are listed under Must fix; Approve stays focusable and says why", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases?view=review");
    await expect(page.getByRole("heading", { name: /Must fix before approval \(1\)/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Show the case with an open question" })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve test cases" });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#gate-G5-blocked")).toContainText("Fix the 1 item under ‘Must fix before approval’ to approve.");
    // Still focusable (aria-disabled, not disabled); activating it does nothing.
    await approve.focus();
    await expect(approve).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("a member granted can_approve can approve Gate 5 (check 74: rights come from the server)", async ({ page }) => {
    const { q } = await setup(page, { role: "member" }, { canApprove: true, cases: [testCase(1, { status: "approved" }), testCase(2, { status: "approved" })] });
    await page.goto("/projects/p1/test-cases?view=review");
    const approve = page.getByRole("button", { name: "Approve test cases" });
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await approve.click();
    await expect.poll(() => q.requests.some((r) => r.path === "/projects/p1/gates/G5/decision")).toBe(true);
  });

  test("an admin without can_approve sees the role-aware waiting copy and a disabled Approve", async ({ page }) => {
    await setup(page, { role: "admin" }, { canApprove: false, cases: [testCase(1, { status: "approved" })] });
    await page.goto("/projects/p1/test-cases?view=review");
    await expect(page.getByText("Waiting for approval by someone who can approve gates").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve test cases" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("You can still approve individual test cases in the list.")).toBeVisible();
  });
});

test.describe("Phase 3 · traceability", () => {
  test("coverage tiles, basis switch before Gate 5, gap lists; execution is never 0", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/traceability");
    await expect(page.getByRole("heading", { level: 1, name: "Traceability" })).toBeVisible();
    await expect(page.getByText("1 of 2", { exact: true })).toBeVisible();
    await expect(page.getByText("Execution coverage")).toBeVisible();
    await expect(page.getByText("Not available").first()).toBeVisible();
    const approvedBasis = page.getByRole("radio", { name: "Last approved (Gate 5)" });
    await expect(approvedBasis).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Available after Gate 5 is approved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Requirements without test cases \(1\)/ })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  // QA BUG-P3-18: once Gate 5 was approved, its snapshot stays available while the gate waits again.
  test("'Last approved' stays available after Gate 5 reopens", async ({ page }) => {
    await setup(page, {}, { g5: "pending", g5Reopened: true });
    await page.goto("/projects/p1/traceability");
    const last = page.getByRole("radio", { name: "Last approved (Gate 5)" });
    await expect(last).toBeVisible();
    await expect(last).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Available after Gate 5 is approved.")).toHaveCount(0);
  });

  test("matrix: forward table with later-phase columns; Trace links open the chain view", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/traceability?view=matrix");
    const table = page.getByRole("table", { name: /Forward traceability/ });
    await expect(table).toBeVisible();
    await expect(table.getByRole("link", { name: "Trace REQ-0001" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1/traceability/TC-0001");
    await expect(page.getByRole("heading", { level: 1, name: /Trace TC-0001/ })).toBeVisible();
    const chain = page.getByRole("region", { name: "Chain" }).or(page.locator("section[aria-labelledby=chain-h]"));
    await expect(chain.getByText("Requirement", { exact: true })).toBeVisible();
    await expect(chain.getByText("(you are here)")).toBeVisible();
    await expect(chain.getByText(/not available until Phase 4/)).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("an unknown chain key shows the 404 copy, without app console errors", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/traceability/TC-0999");
    await expect(page.getByText("We couldn’t find TC-0999 in this project.")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("Phase 3 · requirement and risk additions", () => {
  test("requirement detail lists its linked test cases with the new-case action", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/requirements/REQ-0001");
    await expect(page.getByRole("heading", { name: /Linked test cases \(2\)/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /TC-0001/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "New test case for REQ-0001" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View traceability for REQ-0001" })).toBeVisible();
  });

  // QA BUG-P3-07: the open-question case links REQ-0001; the question it waits on is REQ-0002.
  test("a requirement page lists the case waiting for its answer", async ({ page }) => {
    const waiting = testCase(3, {
      expected_result_status: "open_question",
      open_question: { requirement: { type: "requirement", id: "id-REQ-0002", key: "REQ-0002", label: "", path: "" }, message: "Not decided: REQ-0002 asks whether Message is optional." },
      requirement_keys: ["REQ-0001"],
    });
    await setup(page, {}, { cases: [testCase(1), waiting] });
    await page.goto("/projects/p1/requirements/REQ-0002");
    await expect(page.getByText("1 test case is waiting for this answer: TC-0003.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Linked test cases (1)" })).toBeVisible();
  });

  test("risk register shows test coverage and filters to No approved case", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-strategy?view=risks");
    const table = page.getByRole("table", { name: "Risk register" });
    await expect(table.getByRole("columnheader", { name: "Test coverage" })).toBeVisible();
    await expect(table.getByText("3 cases, 2 approved")).toBeVisible();
    await expect(table.getByText("No approved case")).toBeVisible();
    await page.getByLabel("Test coverage").selectOption("none");
    await expect(table.getByText("3 cases, 2 approved")).toHaveCount(0);
  });
});

test.describe("Phase 3 · members and invitations", () => {
  test("owner: table with guards, invite link shown once, confirm before closing without copying", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto("/settings/members");
    await expect(page.getByRole("link", { name: "Members", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Members (4)" })).toBeVisible();
    // The only owner can't be removed; the reason is visible text.
    await expect(page.getByText("A workspace needs at least one owner. Make someone else an owner first.").first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Invite people" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email").fill("new.person@example.com");
    await dialog.getByRole("button", { name: "Create invitation link" }).click();
    await expect(dialog.getByRole("heading", { name: "Invitation link for new.person@example.com" })).toBeVisible();
    await expect(dialog.getByLabel("Invitation link")).toHaveValue(/\/invite\/tok-secret-123$/);
    expect(q.requests.find((r) => r.path === "/organisation/invitations")?.body).toEqual({ email: "new.person@example.com", role: "member", can_approve: false });
    await dialog.getByRole("button", { name: "Done" }).click();
    const confirm = page.getByRole("dialog", { name: "Close without copying the link?" });
    await expect(confirm).toBeVisible();
    // One button per name: the X is "Close", the footer is "Close without copying" (QA BUG-P3-11).
    await expect(confirm.getByRole("button", { name: "Close", exact: true })).toHaveCount(1);
    await confirm.getByRole("button", { name: "Close without copying" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("an existing account gets the multi-workspace explanation as a field error", async ({ page }) => {
    await setup(page);
    await page.goto("/settings/members");
    await page.getByRole("button", { name: "Invite people" }).click();
    await page.getByRole("dialog").getByLabel("Email").fill("taken@example.com");
    await page.getByRole("button", { name: "Create invitation link" }).click();
    await expect(page.getByText(/This email already has an account\. Multi-workspace accounts aren’t supported yet/)).toBeVisible();
  });

  test("members and viewers see a read-only list without emails or buttons", async ({ page }) => {
    await setup(page, { role: "member" }, { canApprove: false });
    await page.goto("/settings/members");
    await expect(page.getByText("Only owners and admins can manage members.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Invite people" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Email" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Pending invitations/ })).toHaveCount(0);
  });

  test("accept invitation: email hint, same password rules; an invalid link shows one message", async ({ page }) => {
    const s = newState();
    const p2 = newP2();
    const q = newP3();
    await mockApi(page, s);
    await mockPhase2(page, s, p2);
    await mockPhase3(page, s, p2, q);
    await page.goto("/invite/tok-secret-123");
    await expect(page.getByRole("heading", { level: 1, name: "Join Acme QA on QA Analyst" })).toBeVisible();
    await expect(page.getByText("This invitation is for ne***@example.com.")).toBeVisible();
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await expect(page).not.toHaveTitle(/tok-secret/);
    await page.getByRole("button", { name: "Create account and join" }).click();
    await expect(page.getByLabel("Full name")).toBeFocused();
    expect(await axe(page)).toEqual([]);
    q.invite.valid = false;
    await page.goto("/invite/tok-old");
    await expect(page.getByText("This invitation is no longer valid. Ask the person who invited you for a new link.")).toBeVisible();
  });
});

test.describe("Phase 3 · reports and assistant", () => {
  test("reports list offers CSV with its hint for the Phase 3 reports only", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/reports");
    const table = page.getByRole("table", { name: "Phase 2 and 3 reports" });
    await expect(table.getByRole("row", { name: /Test Case Specification/ })).toContainText("Draft · Gate 5 waiting");
    await table.getByRole("button", { name: "Download Test Case Specification version 1" }).click();
    await expect(page.getByRole("menuitem", { name: /CSV \(spreadsheet\)/ })).toContainText("Opens in Excel, Numbers or Google Sheets.");
    await expect(page.getByRole("menuitem", { name: /JSON/ })).toHaveCount(0);
  });

  test("Test Case Specification page: draft band, CSV download, stored content without optional lists renders", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/reports/test-case-spec");
    await expect(page.getByRole("heading", { level: 1, name: "Test Case Specification" })).toBeVisible();
    await expect(page.getByText("DRAFT, not approved at Gate 5")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();
    await expect(page.getByText("Synthetic data only. Saved logins are named, never shown.")).toBeVisible();
    await expect(page.getByText("Execution status").first()).toBeVisible();
    // QA BUG-P3-21: cases without a requirement come in a group whose requirement is null.
    await expect(page.getByText("Not linked to a requirement").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 4, name: /TC-0040/ })).toBeVisible();
    await expect(page.getByText(/Not decided:\s*Not decided/)).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(await axe(page)).toEqual([]);
  });

  test("assistant: test-design tasks are available; only Phase 4 tasks remain under Later phases", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    await expect(tasks.getByRole("button", { name: /Review test coverage/ })).toBeVisible();
    await expect(tasks.getByRole("button", { name: /Explain a test case/ })).toBeVisible();
    await expect(tasks.getByRole("button", { name: /Generate regression scenarios/ })).toBeVisible();
    await tasks.getByRole("button", { name: /Generate regression scenarios/ }).click();
    await expect(tasks.getByRole("radio", { name: /Changed since Gate 5 approval/ })).toBeDisabled();
    await expect(tasks.getByText("Gate 5 hasn’t been approved yet")).toBeVisible();
    await expect(tasks.getByText(/Available in Phase 3/)).toHaveCount(0);
  });
});

test("assistant: AI-only test-case tasks are listed under Needs AI even when not available", async ({ page }) => {
  await setup(page);
  const intent = (name: string, needsAi: boolean, available: boolean) => ({
    intent: name,
    label: name,
    example: "",
    params_schema: {},
    creates_proposal: name.startsWith("propose_"),
    requires_ai: needsAi,
    needs_ai: needsAi,
    available,
    requires_role: "viewer",
  });
  await page.route("**/projects/p1/assistant/capabilities", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify({
        ai_enabled: false,
        model: null,
        free_form: false,
        intents: [intent("coverage_summary", false, true), intent("propose_test_case_update", true, false), intent("propose_missing_test_cases", true, false), intent("explain_test_case", false, false)],
        later_phase_tasks: [],
        notice: null,
      }),
    }),
  );
  await page.goto("/projects/p1/assistant");
  const tasks = page.getByRole("complementary", { name: "Tasks" });
  const needsAi = tasks.getByRole("region", { name: "Needs AI" }).or(tasks.locator('section[aria-labelledby="tasks-ai"]'));
  await expect(needsAi.getByRole("button", { name: "Update test cases" })).toBeVisible();
  await expect(needsAi.getByRole("button", { name: "Suggest missing test cases" })).toBeVisible();
  // An unavailable task that doesn't need AI stays hidden.
  await expect(tasks.getByRole("button", { name: /Explain a test case/ })).toHaveCount(0);
});

test.describe("Phase 3 · 375 and 320 px", () => {
  const pages = [
    "/projects/p1/test-cases",
    "/projects/p1/test-cases/TC-0001",
    "/projects/p1/test-cases?view=review",
    "/projects/p1/test-cases?view=conditions",
    "/projects/p1/test-cases?view=data",
    "/projects/p1/traceability",
    "/projects/p1/traceability?view=matrix",
    "/projects/p1/traceability/TC-0001",
    "/projects/p1/reports/test-case-spec",
    "/projects/p1/reports/rtm",
    "/settings/members",
  ];
  for (const width of [375, 320]) {
    test(`no page scrolls sideways at ${width} px`, async ({ page }) => {
      // Eleven pages in one test: more than the 30 s default when the dev server is compiling.
      test.setTimeout(120_000);
      await setup(page);
      await page.setViewportSize({ width, height: 800 });
      for (const url of pages) {
        await page.goto(url);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(await sideways(page), `${url} at ${width} px`).toBeLessThanOrEqual(0);
      }
    });
  }
});
