// Phase 2 UI behaviour against the stubbed API (./fixtures.ts + ./phase2-fixtures.ts, test-only).
// Each test names the design checks (docs/design/P2-qa-analyst-phase2.md §17) it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2, riskFixture, type P2State } from "./phase2-fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<P2State> = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const p = newP2(over);
  await mockApi(page, s);
  await mockPhase2(page, s, p);
  await signedIn(page, s);
  return p;
}

test.describe("Phase 2 · requirements", () => {
  test("list: filters, hidden rejected, provenance labels, sidebar badge; no serious axe violations", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/requirements");
    await expect(page.getByRole("heading", { level: 1, name: "Requirements" })).toBeVisible();
    // Sidebar attention badge is part of the link name (§3.2).
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Requirements, Gate 3 waiting for approval" })).toBeVisible();
    // G3 banner on the list tab.
    await expect(page.getByText(/Gate 3 · .* is waiting for your approval/)).toBeVisible();
    const table = page.getByRole("table").first();
    await expect(table.getByRole("link", { name: /REQ-0001/ }).first()).toBeVisible();
    await expect(table.getByRole("link", { name: /REQ-0004/ })).toHaveCount(0);
    await expect(page.getByText(/1 rejected requirement.* hidden/)).toBeVisible();
    // Labels carry text, not just colour.
    await expect(table.locator("[data-provenance=assumed]").first()).toContainText("Assumed");
    await page.getByLabel("Status").first().selectOption("draft");
    await expect(page).toHaveURL(/status=draft/);
    await expect(page.getByRole("button", { name: "Remove filter Status: Draft" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("Back steps through filter changes instead of leaving the page", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/requirements");
    await page.getByLabel("Status").first().selectOption("draft");
    await expect(page).toHaveURL(/status=draft/);
    await page.getByLabel("Label").first().selectOption("weak");
    await expect(page).toHaveURL(/status=draft.*label=weak|label=weak.*status=draft/);
    await page.goBack();
    await expect(page).toHaveURL(/\/requirements\?status=draft$/);
    await expect(page.getByLabel("Status").first()).toHaveValue("draft");
    await page.goBack();
    await expect(page).toHaveURL(/\/requirements$/);
  });

  test("bulk approve asks first when some are Assumed or have no criteria, and can approve only the clean ones", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/requirements");
    await page.getByRole("checkbox", { name: /Select REQ-0002/ }).first().check();
    await page.getByRole("checkbox", { name: /Select REQ-0003/ }).first().check();
    await expect(page.getByText("2 requirements selected")).toBeAttached();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Approve 2" }).click();
    const dialog = page.getByRole("dialog", { name: "Approve 2 requirements?" });
    await expect(dialog).toContainText("1 is Assumed or Unverified, 1 has low confidence and 1 has no acceptance criteria.");
    await dialog.getByRole("button", { name: "Approve 1 only" }).click();
    await expect.poll(() => p.requests.find((r) => r.path.endsWith("/requirements/bulk-status"))?.body).toMatchObject({ ids: ["id-REQ-0002"], status: "approved" });
  });

  test("detail: focused h1, label with reason, Given/When/Then criteria, Prev/Next", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/requirements/REQ-0003");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toContainText("Contact form validates field 3");
    await expect(page.locator("[data-provenance=assumed]").first()).toBeVisible();
    await expect(page.getByText(/no acceptance criteria/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Previous.*REQ-0002/ })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("detail approve: one status call, the server approves the draft criteria and the page refetches", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/requirements/REQ-0002");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Contact form validates field 2");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("REQ-0002 and 1 acceptance criterion approved.").first()).toBeVisible();
    expect(p.requests.filter((r) => r.path.startsWith("/acceptance-criteria/"))).toEqual([]);
    expect(p.requests.filter((r) => r.path === "/requirements/id-REQ-0002/status")).toHaveLength(1);
  });

  test("Gate 3: code-computed checks; approving with drafts asks first and records the decision", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/requirements?view=review");
    await expect(page.getByText("1 approved · 1 rejected")).toBeVisible();
    await expect(page.getByText("Changes since approval: 2")).toBeVisible();
    await expect(page.getByRole("link", { name: /Assumed or Unverified/ }).first()).toHaveAttribute("href", /label=weak/);
    await expect(page.getByRole("link", { name: /2 still Draft or Needs info/ })).toBeVisible();
    await expect(page.getByText("Definition of Ready (2) and Done (1) defined")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Approve requirements" }).click();
    const dialog = page.getByRole("dialog", { name: "Approve with 2 drafts?" });
    await expect(dialog).toContainText("The 2 drafts are left out until you approve them.");
    await dialog.getByRole("button", { name: "Approve requirements" }).click();
    await expect.poll(() => p.requests.find((r) => r.path.endsWith("/gates/G3/decision"))?.body).toMatchObject({ decision: "approve" });
  });

  test("Ready & Done: numbered criteria with origin tags; editing needs at least one criterion", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/requirements?view=readiness");
    await expect(page.getByText("It has at least one approved acceptance criterion")).toBeVisible();
    await expect(page.getByText("Added by you")).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("button", { name: "Edit Definition of Done" }).click();
    await page.getByRole("button", { name: /Remove/ }).first().click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Add at least one criterion.")).toBeVisible();
  });

  test("Ready & Done: a reordered list is saved with positions, not just a toast", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/requirements?view=readiness");
    await page.getByRole("button", { name: "Edit Definition of Ready" }).click();
    await page.getByRole("button", { name: "Move criterion 1 down" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Definition of Ready saved.")).toBeVisible();
    const moves = p.requests.filter((r) => r.method === "PATCH" && r.path.startsWith("/readiness-criteria/"));
    expect(moves.map((r) => [r.path, (r.body as { position?: number }).position])).toEqual([
      ["/readiness-criteria/dor-2", 0],
      ["/readiness-criteria/dor-1", 1],
    ]);
  });

  test("regeneration review: grouped radios with defaults; Apply sends the decisions", async ({ page }) => {
    const p = await setup(page, { pendingReview: true });
    await page.goto("/projects/p1/requirements");
    await page.getByRole("link", { name: "Review changes" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review regenerated requirements" })).toBeVisible();
    const added = page.getByRole("group", { name: /REQ-0005/ });
    await expect(added.getByRole("radio", { name: "Accept" })).toBeChecked();
    const gone = page.getByRole("group", { name: /REQ-0003/ });
    await expect(gone.getByRole("radio", { name: "Mark rejected" })).toBeChecked();
    await gone.getByRole("radio", { name: "Keep" }).check();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Apply 2 changes" }).click();
    // Exactly the reviewable items: unchanged ones (one with a null default) are left out, never sent as null.
    await expect.poll(() => p.requests.find((r) => r.path.endsWith("/review/apply"))?.body).toEqual({ decisions: { new1: "accept", "l-REQ-0002": "accept", "l-REQ-0003": "keep" } });
    await expect(page).toHaveURL(/requirements\?changed=1/);
  });

  test("source documents: unsupported files are refused before upload", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/requirements?view=sources");
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("x") });
    await expect(page.getByText("photo.png: only PDF, Markdown and Word (.docx) files can be added.").first()).toBeVisible();
    expect(p.requests.some((r) => r.path.endsWith("/documents") && r.method === "POST")).toBe(false);
    await expect(page.getByText("No documents yet.")).toBeVisible();
  });
});

test.describe("Phase 2 · add requirement and report states", () => {
  test("Add requirement: Assumed, Draft, title checked before submit", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/requirements/new");
    await expect(page.getByRole("heading", { level: 1, name: "Add requirement" })).toBeVisible();
    await expect(page.locator("[data-provenance=assumed]")).toBeVisible();
    await page.getByLabel("Title").fill("Shor");
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page.getByText("Enter a title of at least 5 characters.")).toBeVisible();
    await expect(page.getByLabel("Title")).toBeFocused();
    await page.getByLabel("Title").fill("Visitor can subscribe to the newsletter");
    await page.getByLabel("Category").selectOption("form_input");
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page).toHaveURL(/\/requirements\/REQ-0005$/);
    expect(p.requests.find((r) => r.method === "POST" && r.path === "/projects/p1/requirements")?.body).toMatchObject({ title: "Visitor can subscribe to the newsletter", category: "form_input" });
    expect(await axe(page)).toEqual([]);
  });

  test("report pages render stored content without evidence or matrix cells", async ({ page }) => {
    await setup(page, { g3: "approved" });
    await page.goto("/projects/p1/reports/requirements");
    await expect(page.getByRole("heading", { level: 2, name: /Functional requirements/ })).toBeVisible();
    await expect(page.getByText("Contact form validates field 1").first()).toBeVisible();
    await expect(page.getByText("Shop spec")).toBeVisible();
    await page.goto("/projects/p1/reports/test-strategy");
    await expect(page.getByRole("heading", { level: 2, name: /Risk register/ })).toBeVisible();
    await expect(page.getByRole("table", { name: /Risk matrix/ })).toBeVisible();
  });

  test("the Test Plan report is honest before Gate 4", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/reports/test-plan");
    await expect(page.getByText("The Test Plan report is available after Gate 4 is approved.")).toBeVisible();
  });
});

test.describe("Phase 2 · settings, strategy, reports", () => {
  test("credentials are write-only and the confirmation is required", async ({ page }) => {
    const p = await setup(page, { credentials: true });
    await page.goto("/projects/p1/settings?view=credentials");
    await expect(page.getByRole("heading", { level: 1, name: "Project settings" })).toBeVisible();
    await expect(page.getByText("Saved (hidden)")).toHaveCount(2);
    await expect(page.getByText("qa…@acme.test")).toHaveCount(0);
    await page.getByRole("button", { name: "Replace credentials" }).click();
    await expect(page.getByLabel("Username or email")).toHaveValue("");
    await page.getByLabel("Username or email").fill("qa@acme.test");
    await page.getByLabel("Password", { exact: true }).fill("secret-pass");
    await page.getByRole("button", { name: "Save credentials" }).click();
    await expect(page.getByText("Confirm this is a dedicated test account.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /dedicated test account/ })).toBeFocused();
    expect(p.requests.some((r) => r.method === "PUT")).toBe(false);
    expect(await axe(page)).toEqual([]);
  });

  test("members see credentials status but no form", async ({ page }) => {
    await setup(page, { credentials: true, role: "member" });
    await page.goto("/projects/p1/settings?view=credentials");
    await expect(page.getByText("Only owners and admins can change test credentials.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace credentials" })).toHaveCount(0);
  });

  test("strategy: approval badge, matrix cell filters the register, rating change uses the server's score", async ({ page }) => {
    const p = await setup(page, { g3: "approved", strategy: true, g4: "pending" });
    await page.goto("/projects/p1/test-strategy");
    await expect(page.getByText("Needs separate approval before running").first()).toBeVisible();
    await expect(page.getByText(/Based on\s+Requirements version 1/)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("tab", { name: /Risk register/ }).click();
    const cell = page.getByRole("button", { name: "1 risk, likelihood 2 Unlikely, impact 2 Minor, score 4, Low" });
    await cell.click();
    await expect(page.getByRole("button", { name: "Remove filter Matrix: L2 × I2" })).toBeVisible();
    const register = page.getByRole("table", { name: "Risk register" });
    await expect(register.getByText("RISK-001")).toHaveCount(0);
    await expect(page.getByText("RISK-002 (Very high) has no test type")).toHaveCount(0);
    await register.getByLabel("Likelihood for RISK-002").selectOption("5");
    await expect.poll(() => p.requests.find((r) => r.method === "PATCH" && r.path === "/risks/risk-2")?.body).toMatchObject({ likelihood: 5 });
    // The row now sits in another cell; clear the matrix filter and read the score the server returned.
    await page.getByRole("button", { name: "Remove filter Matrix: L2 × I2" }).click();
    await expect(register.getByText("10 High")).toBeVisible();
  });

  test("before Gate 4 the plan isn't probed, so no 404 shows up in the console", async ({ page }) => {
    await setup(page, { g3: "approved", strategy: true, g4: "pending" });
    const failed: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    await page.goto("/projects/p1/test-strategy?view=plan");
    await expect(page.getByText("The Test Plan is written from the approved Test Strategy. Approve Gate 4 first.")).toBeVisible();
    await page.goto("/projects/p1/test-strategy");
    await expect(page.getByText("Needs separate approval before running").first()).toBeVisible();
    expect(failed).toEqual([]);
  });

  test("Gate 4 with a hard blocker doesn't say you can approve regardless", async ({ page }) => {
    const blocked = riskFixture(2, { likelihood: 4, impact: 5, score: 20, level: "very_high", mitigation: { test_types: [], techniques: [], notes: null } });
    await setup(page, { g3: "approved", strategy: true, g4: "pending", risks: [riskFixture(1), blocked] });
    await page.goto("/projects/p1/test-strategy?view=review");
    await expect(page.getByText("RISK-002 (Very high) has no test type")).toBeVisible();
    await expect(page.getByText("Add a test type for the Very high risk.")).toBeVisible();
    await expect(page.getByText("You can approve regardless.", { exact: false })).toHaveCount(0);
  });

  test("Gate 4 shows code-computed checks; Test Plan marks strategy sections and never invents dates", async ({ page }) => {
    await setup(page, { g3: "approved", strategy: true, g4: "approved" });
    await page.goto("/projects/p1/test-strategy?view=review");
    await expect(page.getByText("Entry (1) and exit (1) criteria defined")).toBeVisible();
    await expect(page.getByText("1 planned test type needs separate approval before running: Performance")).toBeVisible();
    await page.goto("/projects/p1/test-strategy?view=plan");
    await expect(page.getByRole("heading", { name: /Test Plan · Version 1/ })).toBeVisible();
    await expect(page.getByText("From Test Strategy", { exact: true })).toHaveCount(4);
    await expect(page.getByRole("region", { name: /Schedule & milestones/ })).toContainText("Not set.");
    expect(await axe(page)).toEqual([]);
  });

  test("reports list shows the Requirements Specification with a download menu", async ({ page }) => {
    await setup(page, { g3: "approved" });
    await page.goto("/projects/p1/reports");
    const table = page.getByRole("table", { name: "Phase 2 and 3 reports" });
    await expect(table.getByRole("row", { name: /Requirements Specification/ })).toContainText("Approved (Gate 3)");
    await expect(table.getByRole("row", { name: /Test Plan/ })).toContainText("Needs Gate 4 approval");
    await table.getByRole("button", { name: "Download Requirements Specification version 1" }).click();
    await expect(page.getByRole("menuitem", { name: "HTML (single file)" })).toBeVisible();
  });
});

test.describe("Phase 2 · AI QA Analyst", () => {
  test("AI off: grouped tasks, free text replaced by the callout, a built-in task answers with citations", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/assistant");
    await expect(page.getByRole("heading", { level: 1, name: "AI QA Analyst" })).toBeVisible();
    await expect(page.getByText("AI off")).toBeVisible();
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    await expect(tasks.getByRole("heading", { name: "Works without AI" })).toBeVisible();
    await expect(tasks.getByRole("button", { name: /Reassess application risk/ })).toBeVisible();
    await expect(tasks.getByRole("button", { name: /Add negative criteria/ })).toBeVisible();
    // Phase 3 built the test-case tasks (design P3 §16.1): only Phase 4 tasks remain under "Later phases".
    await expect(tasks.getByText("Available in Phase 3: needs test cases")).toHaveCount(0);
    await expect(tasks.getByText("Available in Phase 4: needs test runs").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Ask about this project" })).toHaveCount(0);
    await expect(page.getByText(/Free-form questions and AI proposals need AI/).first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await tasks.getByRole("button", { name: "What needs my attention?" }).click();
    await tasks.getByRole("button", { name: "Check now" }).click();
    const answer = page.getByRole("article").filter({ hasText: "Gate 3 is waiting" });
    await expect(answer.getByText("Computed from project data")).toBeVisible();
    await expect(answer.getByRole("link", { name: "Requirement REQ-0003: Contact form validates field 3" })).toHaveAttribute("href", "/projects/p1/requirements/REQ-0003");
    await expect(page.getByRole("status").filter({ hasText: "Answer ready" })).toBeAttached();
  });

  test("proposals are diffs; nothing changes until Apply", async ({ page }) => {
    const p = await setup(page);
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    await tasks.getByRole("button", { name: /Add negative criteria/ }).click();
    await expect(tasks.getByLabel("Requirement")).toBeFocused();
    await tasks.getByLabel("Requirement").selectOption("REQ-0003");
    await tasks.getByRole("button", { name: "Propose criteria" }).click();
    const proposal = page.getByRole("region", { name: "Proposal · Add acceptance criteria" });
    await expect(proposal).toContainText("Waiting for your review");
    await expect(proposal.getByRole("radio", { name: "Accept" })).toBeChecked();
    // The target link is focusable, so the row that holds it must not be aria-hidden (BUG-P2-19).
    await expect(proposal.getByRole("link", { name: "REQ-0003" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(p.requests.some((r) => r.path.includes("/accept"))).toBe(false);
    await proposal.getByRole("button", { name: "Apply 1 accepted change" }).click();
    await expect.poll(() => p.requests.some((r) => r.path === "/assistant/proposals/prop1/accept")).toBe(true);
  });

  test("header button opens the side panel with Open full view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setup(page);
    await page.goto("/projects/p1/requirements");
    await page.getByRole("button", { name: "Ask AI QA Analyst" }).click();
    const panel = page.getByRole("dialog", { name: "AI QA Analyst" });
    await expect(panel.getByRole("link", { name: "Open full view" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ask AI QA Analyst" })).toBeFocused();
  });
});

test.describe("Phase 2 · overview", () => {
  test("needs your attention lists the waiting gate and drafts with actions", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1");
    await expect(page.getByText("Gate 3 · Requirements review is waiting for your approval.")).toBeVisible();
    await expect(page.getByText("2 requirements are still Draft.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review drafts" })).toHaveAttribute("href", "/projects/p1/requirements?status=draft");
    await expect(page.getByText(/3 requirements · 1 approved · 1 Assumed or Unverified/)).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 2 · signing in during discovery", () => {
  test("a rejected sign-in shows the banner, the gap with 'We tried once' and a ✗ line on Gate 2", async ({ page }) => {
    const s = newState({ phase: "awaiting", signIn: "failed" });
    s.projects = [project()];
    await mockApi(page, s);
    await mockPhase2(page, s, newP2({ g3: "none" }));
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=gaps");
    await expect(page.getByText(/Couldn’t sign in with the credentials provided: the site rejected the username or password/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Replace credentials" })).toHaveAttribute("href", "/projects/p1/settings?view=credentials");
    await expect(page.getByText("We tried once, to avoid locking the account.").first()).toBeVisible();
    await expect(page.getByText(/arrives? in Phase 2/)).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1/discovery?view=summary");
    await expect(page.getByText("Sign-in failed: the site rejected the username or password")).toBeVisible();
    await expect(page.getByText("Test account, sign-in failed")).toBeVisible();
  });
});

test.describe("Phase 2 · 375 px", () => {
  const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  test("requirement detail and the risk register don't scroll sideways; the register is cards and the matrix fits", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page, { g3: "approved", strategy: true, g4: "pending" });
    await page.goto("/projects/p1/requirements/REQ-0002");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Contact form validates field 2");
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto("/projects/p1/test-strategy?view=risks");
    const cards = page.getByRole("list", { name: "Risk register" });
    await expect(cards.getByRole("listitem").first()).toBeVisible();
    await expect(page.getByRole("table", { name: "Risk register" })).toBeHidden();
    await expect(cards.getByLabel("Likelihood for RISK-001")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const matrix = page.getByRole("table", { name: /Risk matrix/ });
    const box = await matrix.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 2 · QA round 2", () => {
  test("R2-01: a page visited while signed in shows 'Signed in', not 'Needs credentials', and has its own Access filter", async ({ page }) => {
    const s = newState({ phase: "approved", signIn: "succeeded" });
    s.projects = [project()];
    await mockApi(page, s);
    await mockPhase2(page, s, newP2());
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=sitemap");
    const tree = page.getByRole("tree", { name: "Sitemap" });
    await expect(tree.getByRole("treeitem", { name: /My account/ })).toContainText("Signed in");
    await expect(tree.getByText("Needs credentials")).toHaveCount(0);
    await page.getByLabel("Access").selectOption("signed_in");
    await expect(page.getByText("1 of 3 pages match.")).toBeVisible();
    const table = page.getByRole("table", { name: "Pages found" });
    await expect(table.getByRole("row", { name: /My account/ })).toContainText("Signed in");
    await page.getByLabel("Access").selectOption("auth");
    await expect(page.getByText("0 of 3 pages match.")).toBeVisible();
  });

  test("R2-04: without gate-approval permission, Approve is disabled with the reason and no confirmation opens", async ({ page }) => {
    const p = await setup(page, { role: "member" });
    await page.goto("/projects/p1/requirements?view=review");
    await expect(page.getByText("You can review this gate, but approving needs gate-approval permission. Ask an owner or admin.")).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve requirements" });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAccessibleDescription(/approving needs gate-approval permission/);
    await approve.click({ force: true });
    await expect(page.getByRole("dialog", { name: /Approve with \d+ drafts\?/ })).toHaveCount(0);
    expect(p.requests.some((r) => r.path.includes("/gates/"))).toBe(false);
  });
});
