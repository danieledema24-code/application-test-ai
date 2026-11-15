// Phase 4 Automation UI against the stubbed API (./fixtures.ts + phase2/phase3/phase4 fixtures, test-only). Each test
// names the design checks (docs/design/P4-qa-analyst-phase4.md §20) it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4, type P4State } from "./phase4-fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

function consoleErrors(page: Page): string[] {
  const out: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) out.push(m.text());
  });
  page.on("pageerror", (e) => out.push(e.message));
  return out;
}

async function setup(page: Page, over: Partial<P4State> = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const q = newP4(over);
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role });
  const p3 = newP3({ designed: true, g5: "approved", canApprove: q.canApprove });
  p3.cases[0].automation_suitability = { value: "suitable", reason: "Every step and expected result can be scripted", assessed: "assessed" };
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, p3);
  await mockPhase4(page, s, q);
  await signedIn(page, s);
  return { s, q, p3 };
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Phase 4 · automation", () => {
  test("sidebar: Automation, Test Execution and Defects built; Non-functional built in Phase 5 (check 1)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/automation");
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Automation", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: /^Test Execution/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: /coming in Phase 4/ })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Non-functional", exact: true })).toBeVisible();
  });

  test("overview: counts from the API, grouped reasons quote the step, legend; no serious axe violations (check 6)", async ({ page }) => {
    const errors = consoleErrors(page);
    await setup(page);
    await page.goto("/projects/p1/automation");
    await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
    await expect(page.getByText("3 of 5 approved test cases can be automated · 1 needs test credentials · 1 needs a person")).toBeVisible();
    await page.getByRole("button", { name: "Show 3 cases that can be automated" }).click();
    await expect(page.getByRole("link", { name: /TC-0019 Send the contact form with an empty Message/ }).first()).toBeVisible();
    await expect(page.getByText("“Step 2 'Inspect the form's action address' needs human judgement”")).toBeVisible();
    await expect(page.getByText("Their scripts are written but are blocked in runs until test credentials are saved.")).toBeVisible();
    // Can the scripts run?
    await expect(page.getByText("3 valid · 1 can't run · 1 not checked on the live page")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open TC-0040 script" })).toBeVisible();
    await page.getByRole("button", { name: "What do these mean?" }).click();
    await expect(page.getByText("The script only uses allowed testing commands.", { exact: false })).toBeVisible();
    await expect(page.getByText("Scripts written by rules (AI not configured).", { exact: false })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("assessed case detail drops the preliminary label (check 6)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases/TC-0001");
    await expect(page.getByRole("heading", { level: 1, name: /TC-0001/ })).toBeVisible();
    await expect(page.getByText(/^Can be automated/)).toBeVisible();
    await expect(page.getByText("Preliminary: confirmed by the automation assessment after Gate 5.")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open Automation" })).toBeVisible();
  });

  test("script viewer: valid, rules, read-only, copy, what it checks; keyboard file list (checks 7, 11)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/automation?view=scripts&file=tests/contact/TC-0019.spec.ts");
    const viewer = page.getByRole("article");
    await expect(viewer.getByRole("heading", { name: "tests/contact/TC-0019.spec.ts" })).toBeVisible();
    await expect(viewer.getByText("Valid", { exact: true })).toBeVisible();
    await expect(viewer.getByText("Generated by rules").first()).toBeVisible();
    await expect(viewer.getByText(/Read-only\. To change what this test does, edit TC-0019/)).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Copy code" })).toBeVisible();
    await expect(viewer.getByRole("button", { name: /edit/i })).toHaveCount(0);
    await expect(viewer.getByText("Step 4 Press Send message → Submission is blocked · Message is flagged")).toBeVisible();
    const code = page.getByRole("region", { name: "Code of TC-0019.spec.ts" });
    await code.focus();
    await expect(code).toBeFocused();
    await viewer.getByRole("button", { name: "Copy code" }).click();
    await expect(page.getByText("Code copied")).toBeVisible();
    // File list: folders are buttons, files are links named with their status.
    const files = page.getByRole("navigation", { name: "Script files" });
    await expect(files.getByRole("link", { name: "TC-0040.spec.ts, can't run" })).toBeVisible();
    const folder = files.getByRole("button", { name: "contact (3)" });
    await folder.focus();
    await page.keyboard.press("Enter");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(await axe(page)).toEqual([]);
  });

  test("invalid script: line-linked locator message, outlined line (check 8)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/automation?view=scripts");
    await page.getByRole("navigation", { name: "Script files" }).getByRole("link", { name: "TC-0040.spec.ts, can't run" }).click();
    await expect(page).toHaveURL(/file=tests%2Fcontact%2FTC-0040\.spec\.ts|file=tests\/contact\/TC-0040\.spec\.ts/);
    const viewer = page.getByRole("article");
    await expect(viewer.getByText(/^Can.t run$/)).toBeVisible();
    const msg = viewer.getByRole("link", { name: /^Line \d+: Locator 'Message' was not found on \/contact$/ });
    await expect(msg).toBeVisible();
    const n = (await msg.textContent())!.match(/Line (\d+)/)![1];
    await msg.click();
    await expect(page.locator(`#line-${n}`)).toContainText("Problem on this line");
    expect(await axe(page)).toEqual([]);
  });

  test("page object locator table with fallback reason", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/automation?view=scripts&file=pages/ContactPage.ts");
    const table = page.getByRole("table");
    await expect(table.getByRole("row", { name: /Name getByLabel\("Name"\) Found once 3 scripts/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /Message .* Not found/ })).toBeVisible();
    await expect(table.getByText("Fallback: a form rarely has an accessible name", { exact: false })).toBeVisible();
    await page.goto("/projects/p1/automation?view=scripts&file=fixtures.ts");
    await expect(page.getByText("Platform file: part of the testing toolkit, the same in every project. Not generated.")).toBeVisible();
  });

  test("G6 passed automatically with rules only: no approve button (check 3)", async ({ page }) => {
    await setup(page, { invalid: false });
    await page.goto("/projects/p1/automation?view=review");
    await expect(page.getByRole("heading", { name: "Gate 6 · Script validation" })).toBeVisible();
    await expect(page.getByText("Passed automatically", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Every script was written by rules and passed its checks. No sign-off needed.")).toBeVisible();
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("AI script: a member sees disabled review buttons and the permission note; nothing is sent (check 10)", async ({ page }) => {
    const { q } = await setup(page, { aiScript: true, role: "member", canApprove: false });
    await page.goto("/projects/p1/automation?view=review");
    await expect(page.getByText("Waiting for approval by someone who can approve gates").first()).toBeVisible();
    await expect(page.getByText("Must fix before tests can run (1)")).toBeVisible();
    await expect(page.getByText("You can review these scripts, but approving needs gate-approval permission.", { exact: false })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve script TC-0044" });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    // aria-disabled keeps it focusable for the explanation; pressing it does nothing.
    await approve.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(q.requests.filter((r) => r.path.endsWith("/review"))).toEqual([]);
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Automation, Gate 6 waiting for approval" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("AI script: an approver approves; rejecting needs a comment (check 10)", async ({ page }) => {
    const { q } = await setup(page, { aiScript: true });
    await page.goto("/projects/p1/automation?view=review");
    await expect(page.getByText("Waiting for your approval").first()).toBeVisible();
    await page.getByRole("button", { name: "Reject script… TC-0044" }).click();
    await expect(page.getByText("Say what's wrong with this script.")).toBeVisible();
    await page.getByRole("button", { name: "Approve script TC-0044" }).click();
    await expect(page.getByText("Script approved.")).toBeVisible();
    expect(q.requests.find((r) => r.path === "/automation-scripts/s-TC-0044/review")?.body).toEqual({ decision: "approve", comment: null });
  });

  test("viewer: no Validate, Regenerate or review controls (check 12)", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false, aiScript: true });
    await page.goto("/projects/p1/automation");
    await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
    await expect(page.getByText("3 of 5 approved test cases", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Validate again" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Regenerate scripts…" })).toHaveCount(0);
    await page.goto("/projects/p1/automation?view=review");
    await expect(page.getByRole("heading", { name: "Gate 6 · Script validation" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve script|Reject script/ })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  });

  test("member validates and regenerates with confirmation", async ({ page }) => {
    const { q } = await setup(page, { role: "member", canApprove: false });
    await page.goto("/projects/p1/automation");
    await page.getByRole("button", { name: "Validate again" }).click();
    await expect(page.getByText("Validation started.")).toBeVisible();
    await page.getByRole("button", { name: "Regenerate scripts…" }).click();
    const dialog = page.getByRole("dialog", { name: "Regenerate scripts" });
    await expect(dialog.getByText("Scripts whose test case hasn't changed keep their version and checks.", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Regenerate scripts" }).click();
    await expect.poll(() => q.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /projects/p1/automation/validate", "POST /projects/p1/stages/automation/run"]);
  });

  test("states: before G5, not assessed, toolkit missing (§6.5)", async ({ page }) => {
    await setup(page, { g5: false, assessed: false });
    await page.goto("/projects/p1/automation");
    await expect(page.getByText("Scripts are written from the test cases approved at Gate 5. Approve Gate 5 first.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review Gate 5" })).toBeVisible();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const { q } = await setup(page, { assessed: false });
    await page.goto("/projects/p1/automation");
    await expect(page.getByText("Test cases are approved. Check which ones can be automated.")).toBeVisible();
    await page.getByRole("button", { name: "Assess automation" }).click();
    await expect.poll(() => q.requests.map((r) => r.path)).toContain("/projects/p1/stages/automation_assessment/run");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await setup(page, { toolkitProblem: "Node.js is not installed" });
    await page.goto("/projects/p1/automation");
    await expect(page.getByText("Scripts can't be checked or run on this server")).toBeVisible();
  });

  test("375 px: no sideways scroll on overview and scripts (§18)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto("/projects/p1/automation");
    await expect(page.getByRole("heading", { level: 1, name: "Automation" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto("/projects/p1/automation?view=scripts&file=tests/contact/TC-0019.spec.ts");
    await expect(page.getByRole("region", { name: "Code of TC-0019.spec.ts" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("Phase 4 · Playwright project export (P4-10)", () => {
  test("overview card: valid count, left-out cases, download of the zip", async ({ page }) => {
    const { q } = await setup(page, { invalid: true });
    await page.goto("/projects/p1/automation");
    const card = page.getByRole("region", { name: "Use the scripts outside this app" });
    await expect(card.getByText(/Download a standalone Playwright project with the \d+ valid scripts?, plus CI templates for GitHub Actions and GitLab CI\./)).toBeVisible();
    await expect(card.getByText(/left out because (it|they) can't run: .*TC-0040.*The project's README lists/)).toBeVisible();
    const download = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download Playwright project (v2, zip)" }).click();
    expect((await download).suggestedFilename()).toBe("acme.com-playwright-v2.zip");
    expect(q.requests.some((r) => r.path === "/projects/p1/automation/export")).toBe(true);
    expect(await axe(page)).toEqual([]);
  });

  test("viewers see no download; the header ⋯ menu offers it to members", async ({ page }) => {
    await setup(page, { role: "viewer" });
    await page.goto("/projects/p1/automation");
    const card = page.getByRole("region", { name: "Use the scripts outside this app" });
    await expect(card.getByText("Members and approvers can download the project.")).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
    await page.getByRole("button", { name: "More project actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Download Playwright project" })).toHaveCount(0);
  });

  test("header ⋯ menu: Download Playwright project", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/automation");
    await page.getByRole("button", { name: "More project actions" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download Playwright project" }).click();
    expect((await download).suggestedFilename()).toBe("acme.com-playwright-v2.zip");
  });
});

test.describe("Phase 4 · AI scripts (P4-03b)", () => {
  test("overview lists what happened to AI drafts; AI off shows no such list", async ({ page }) => {
    await setup(page, { aiScript: true });
    await page.goto("/projects/p1/automation");
    await page.getByRole("button", { name: "Checks on AI scripts (1)" }).click();
    await expect(page.getByText("Dropped an AI script for TC-0019: it changed what the test checks. The rules script is used.")).toBeVisible();
  });

  test("AI off: no AI checks list", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/automation");
    await expect(page.getByRole("heading", { name: "Can the scripts run?" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Checks on AI scripts/ })).toHaveCount(0);
  });
});
