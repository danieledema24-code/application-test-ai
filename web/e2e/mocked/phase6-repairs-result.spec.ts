// QA (P6-04, design P6 §8.1): a failure-sourced repair (HEAL-…) on the result page renders the RepairCard in place of
// the Phase 4 FixSuggestion; a Phase 4 result with JSON suggestions and no HEAL row keeps FixSuggestion unchanged.
// Stubbed API only (./fixtures.ts + the phase 2–4 fixtures + ./phase6-fixtures.ts, test-only).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec, type ExecState } from "./phase4-exec-fixtures";
import { mockRepairs, newRepairs, type RepairState } from "./phase6-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

const RESULT = "/projects/p1/execution/RUN-0003/results/RUN-0003-05";

async function setup(page: Page, opts: { withRepair: boolean; role?: "owner" | "viewer" }) {
  const role = opts.role ?? "owner";
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const q: ExecState = newExec(role === "viewer" ? { role: "viewer", canApprove: false } : {});
  const rs: RepairState = newRepairs({ role });
  const heal5 = rs.items.find((x) => x.key === "HEAL-0005")!;
  heal5.execution_result = { id: "res-RUN-0003-5", key: "RUN-0003-05", run_key: "RUN-0003", run_id: "run-0003" };
  if (opts.withRepair) {
    const r = q.results.find((x) => x.key === "RUN-0003-05")!;
    (r as unknown as { repairs: unknown[] }).repairs = [{ ...heal5, can_accept: role !== "viewer", can_reject: role !== "viewer" }];
  }
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role });
  const p3 = newP3({ designed: true, g5: "approved", canApprove: q.canApprove });
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, p3);
  await mockPhase4(page, s, p4);
  await mockExec(page, q);
  await mockRepairs(page, rs);
  await signedIn(page, s);
  return { q, rs };
}

test.describe("QA · P6-04 repair card on a failed result (§8.1)", () => {
  test("a HEAL- repair from this failure replaces FixSuggestion; keyboard accept sends one index to the new endpoint", async ({ page, browserName }) => {
    const { q, rs } = await setup(page, { withRepair: true });
    await page.goto(RESULT);
    await expect(page.getByRole("heading", { level: 2, name: "Repair suggestion" })).toBeVisible();
    const card = page.getByRole("article", { name: /^HEAL-0005 / });
    await expect(card).toContainText("From a failed test (RUN-0003-05)");
    await expect(card).toContainText("Only this locator changes; the test's checks stay the same.");
    await expect(card.getByRole("img", { name: /^Screenshot of \/contact on .* with the matched element outlined: text box 'Your message'\.$/ })).toBeVisible();
    // The Phase 4 card is not shown as well.
    await expect(page.getByRole("region", { name: "Fix suggestion" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Accept fix suggestion" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    const radio = card.getByRole("radio", { name: "getByLabel('Your message')" });
    await expect(radio).toBeChecked();
    const accept = card.getByRole("button", { name: "Accept this replacement for getByLabel('Message')" });
    if (browserName === "webkit") await accept.focus();
    else {
      // Keyboard only: from the chosen radio, Tab reaches Accept (past "Open full size").
      await radio.focus();
      for (let i = 0; i < 6 && !(await accept.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    }
    await expect(accept).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Accept HEAL-0005?" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByText("HEAL-0005 accepted. ContactPage.ts version 3 is being checked.")).toBeVisible();
    expect(rs.requests.filter((x) => x.method === "POST")).toEqual([{ method: "POST", path: "/heal-suggestions/h5/accept", body: { index: 0 } }]);
    // The Phase 4 accept endpoint was not called.
    expect(q.requests.filter((x) => x.path.includes("/heal-suggestions/") && x.path.startsWith("/execution-results/"))).toHaveLength(0);
  });

  test("a Phase 4 result with JSON suggestions and no HEAL row keeps FixSuggestion", async ({ page }) => {
    await setup(page, { withRepair: false });
    await page.goto(RESULT);
    await expect(page.getByRole("region", { name: "Fix suggestion" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Repair suggestion" })).toHaveCount(0);
    await expect(page.getByRole("article", { name: /^HEAL-/ })).toHaveCount(0);
  });

  test("viewer: the result's repair card is read-only; 375 px has no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page, { withRepair: true, role: "viewer" });
    await page.goto(RESULT);
    const card = page.getByRole("article", { name: /^HEAL-0005 / });
    await expect(card).toBeVisible();
    await expect(card.getByRole("radio")).toHaveCount(0);
    await expect(card.getByRole("button", { name: /^(Accept|Reject)/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });
});
