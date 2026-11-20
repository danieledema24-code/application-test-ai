// Phase 6 impact and the regression run (P6-02, design P6 §6.4, §7): the Impact and Regression run tabs of CHG-0001
// against the stubbed API (./fixtures.ts + ./phase6-fixtures.ts, test-only). Keyboard, focus after closing (including
// the Safari path through web/src/lib/pointerFocus.ts: a clicked button isn't focused there), axe and 375 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase6, newP6, type P6State } from "./phase6-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<P6State> = {}) {
  const s = newState({ phase: "approved", g2Policy: "required" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newP6(over);
  await mockApi(page, s);
  await mockPhase6(page, s, q);
  await signedIn(page, s);
  return q;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const CHG1 = "/projects/p1/discovery/changes/CHG-0001";
const focusedName = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

test.describe("Phase 6 · impact (P6-02)", () => {
  test("summary cards, tabs by keyboard and the nested impact list with reasons (§6.4, §7.1)", async ({ page }) => {
    await setup(page);
    await page.goto(CHG1);
    await expect(page.getByRole("heading", { level: 1, name: "CHG-0001 · Scan 2 → Scan 3" })).toBeVisible();
    await expect(page.getByText("2 requirements · 4 test cases")).toBeVisible();
    await expect(page.getByText("2 scripts outdated")).toBeVisible();
    await expect(page.getByText("1 defect to re-test")).toBeVisible();
    await expect(page.getByText("3 to review · 2 not covered")).toBeVisible();
    const steps = page.getByRole("list").filter({ hasText: "Request the regression run (Gate 7)" });
    await expect(steps.getByRole("listitem")).toHaveText([/Repair 2 outdated scripts/, /Request the regression run \(Gate 7\)/, /Close 7 review items/]);
    // Tabs: arrow keys move between them; the URL keeps the tab.
    const what = page.getByRole("tab", { name: "What changed (9)" });
    await expect(what).toHaveAttribute("aria-selected", "true");
    await what.focus();
    await page.keyboard.press("ArrowRight");
    const impact = page.getByRole("tab", { name: "Impact (13 open)" });
    await expect(impact).toBeFocused();
    await expect(impact).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/tab=impact/);
    await expect(page.getByRole("heading", { level: 2, name: "Impact · 13 open of 13" })).toBeVisible();
    // Direct requirement: open, named with its level and change count; indirect: collapsed.
    const req7 = page.getByRole("button", { name: /^REQ-0007 Contact form requires name, email and message, direct, 2 changes/ });
    await expect(req7).toHaveAttribute("aria-expanded", "true");
    const req2 = page.getByRole("button", { name: /^REQ-0002 Visitors can move between pages from the menu, indirect/ });
    await expect(req2).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText('2 changes on /contact: button "Send message" renamed; field "Message" changed')).toBeVisible();
    const under = page.getByRole("list", { name: "Affected by REQ-0007 Contact form requires name, email and message" });
    await expect(under.getByText('Directly affected: button "Send message" renamed; field "Message" changed')).toBeVisible();
    await expect(under.getByText("Closes by itself when TC-0019 has a result from a run after CHG-0001.")).toBeVisible();
    await expect(under.getByText("getByLabel('Message') not found after CHG-0001").first()).toBeVisible();
    await expect(under.getByRole("link", { name: "Review HEAL-0001" })).toHaveAttribute("href", `${CHG1}?tab=repairs&heal=HEAL-0001`);
    // Re-run and repair items have no Close button (OQ4).
    await expect(page.getByRole("button", { name: "Close impact item for TC-0019" })).toHaveCount(0);
    await req2.focus();
    await page.keyboard.press("Enter");
    await expect(req2).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Indirectly affected: navigation changed")).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Defects to re-test (1)" })).toBeVisible();
    await expect(page.getByText("May be fixed or changed by CHG-0001: re-test. Re-tested by TC-0019.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Page removed: review (3)" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Not covered by any requirement (2)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Write a requirement for /offers" }).first()).toHaveAttribute("href", "/projects/p1/requirements/new?from=CHG-0001&page=%2Foffers");
    // Filters: Type Script shows the repair items only.
    await page.getByLabel("Type").selectOption("automation_script");
    await expect(page.getByText("Showing 2 of 13 impact items")).toBeAttached();
    await page.getByLabel("Level").selectOption("gap");
    await expect(page.getByText("No impact items match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("Showing 13 of 13 impact items")).toBeAttached();
    expect(await axe(page)).toEqual([]);
  });

  test("close dialog: errors on submit, focus to the next Close…, then the group heading (§7.2, §16.2)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(`${CHG1}?tab=impact`);
    const close12 = page.getByRole("button", { name: "Close impact item for TC-0012" });
    await close12.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Close impact item · TC-0012 View the Travel mug page" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close item" }).click();
    await expect(dialog.getByText("Choose an option.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Resolved/ })).toBeFocused();
    await dialog.getByRole("radio", { name: "No action needed" }).check();
    await dialog.getByRole("button", { name: "Close item" }).click();
    await expect(dialog.getByText("Say why no action is needed.")).toBeVisible();
    await expect(dialog.getByLabel(/Reason/)).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await dialog.getByLabel(/Reason/).fill("Retired with the Travel mug");
    await dialog.getByRole("button", { name: "Close item" }).click();
    await expect(page.getByText("TC-0012 impact item closed.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close impact item for A11Y-0001-01" })).toBeFocused();
    expect(q.requests.find((r) => r.method === "PATCH")?.body).toEqual({ status: "no_action", reason: "Retired with the Travel mug" });
    // The closed item leaves the Open list; under All it shows who and why.
    await expect(close12).toHaveCount(0);
    await page.getByLabel("Status").selectOption("all");
    await expect(page.getByText("No action needed · M. Member: 'Retired with the Travel mug'")).toBeVisible();
    await page.getByLabel("Status").selectOption("open");
    // Clicking (Safari doesn't focus a clicked button): Escape returns focus to the Close… that opened it.
    const closeA11y = page.getByRole("button", { name: "Close impact item for A11Y-0001-01" });
    await closeA11y.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(closeA11y).toBeFocused();
    // Close the two left in the group: then focus goes to the group heading.
    for (const key of ["A11Y-0001-01", "PRF-01"]) {
      await page.getByRole("button", { name: `Close impact item for ${key}` }).click();
      const d = page.getByRole("dialog");
      await d.getByRole("radio", { name: /^Resolved/ }).check();
      await d.getByRole("button", { name: "Close item" }).click();
      await expect(page.getByText(`${key} impact item closed.`)).toBeVisible();
    }
    await expect.poll(() => focusedName(page)).toMatch(/^Page removed: review/);
  });

  test("viewer: the same lists without Close…, Write a requirement or Regenerate (§7.3)", async ({ page }) => {
    await setup(page, { role: "viewer" });
    await page.goto(`${CHG1}?tab=impact`);
    await expect(page.getByRole("heading", { level: 2, name: "Impact · 13 open of 13" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Close impact item/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Write a requirement/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Regenerate requirements…" })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Defects to re-test" }).getByText("Closes by itself when TC-0019 has a result from a run after CHG-0001.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 6 · regression run (P6-02)", () => {
  test("outdated must-run scripts: Request this run is aria-disabled with the reason; Review repairs opens the Repairs tab (§7.4, OQ3)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(`${CHG1}?tab=regression`);
    await expect(page.getByRole("heading", { level: 2, name: "Regression run · recommended by rules" })).toBeVisible();
    await expect(page.getByText("about 3 min (from RUN-0003)")).toBeVisible();
    const btn = page.getByRole("button", { name: "Request this run" });
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    await expect(btn).toHaveAccessibleDescription(/2 must-run tests have outdated scripts\. Accept or reject their repair suggestions first\./);
    await expect(page.getByText("It still needs Gate 7: someone who can approve authorises it before anything runs.")).toBeVisible();
    // aria-disabled keeps it focusable; pressing it sends nothing.
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(btn).toBeFocused();
    expect(q.requests.filter((r) => r.path.endsWith("/regression-run"))).toHaveLength(0);
    const must = page.getByRole("table", { name: "Must run (2)" });
    await expect(must.getByRole("row", { name: /TC-0019/ })).toContainText("Re-tests DEF-0001");
    await expect(must.getByRole("row", { name: /TC-0019/ })).toContainText("Outdated");
    await expect(must.getByRole("row", { name: /TC-0020/ }).getByRole("link", { name: "Review HEAL-0001" })).toHaveAttribute("href", `${CHG1}?tab=repairs&heal=HEAL-0001`);
    await expect(page.getByRole("table", { name: "Should run (3)" }).getByRole("row", { name: /TC-0030/ })).toContainText("Linked to high risk RISK-03");
    await expect(page.getByRole("table", { name: "Not included (2)" }).getByRole("row", { name: /TC-0031/ })).toContainText("Manual test: a person runs it");
    // QA P6-04 R3: a test moved out of Must run (link to a removed page, D28) keeps its must-run marker.
    await expect(page.getByRole("table", { name: "Not included (2)" }).getByRole("row", { name: /TC-0012/ })).toContainText("Was must run");
    await expect(page.getByRole("table", { name: "Not included (2)" }).getByRole("row", { name: /TC-0031/ })).not.toContainText("Was must run");
    await expect(page.getByRole("checkbox", { name: 'Include the 3 "should run" tests' })).toBeChecked();
    await expect(page.getByText("5 tests, about 3 min · without them: 2 tests, under a minute")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("tabpanel", { name: "Regression run" }).getByRole("button", { name: "Review repairs" }).click();
    await expect(page).toHaveURL(/tab=repairs/);
    await expect(page.getByRole("tab", { name: /^Repairs/ })).toHaveAttribute("aria-selected", "true");
  });

  test("repaired: Request this run sends the selection, toasts and opens the run (§7.4)", async ({ page }) => {
    const q = await setup(page, { outdated: false });
    await page.goto(`${CHG1}?tab=regression`);
    const btn = page.getByRole("button", { name: "Request this run" });
    await expect(btn).not.toHaveAttribute("aria-disabled", "true");
    await page.getByRole("checkbox", { name: 'Include the 3 "should run" tests' }).uncheck();
    await expect(page.getByText("under a minute (from RUN-0003)")).toBeVisible();
    await btn.click();
    await expect(page.getByText("RUN-0005 created. Review and authorise it to start.")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/p1\/execution\/RUN-0005$/, { timeout: 30_000 });
    expect(q.requests.find((r) => r.path.endsWith("/regression-run"))?.body).toEqual({ include_should: false });
  });

  test("a 422 from the server is shown verbatim with focus on it; already requested says so (§7.4)", async ({ page }) => {
    const q = await setup(page, { outdated: false, regression422: "None of the recommended tests can run automatically. A person runs the manual ones." });
    await page.goto(`${CHG1}?tab=regression`);
    await page.getByRole("button", { name: "Request this run" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "None of the recommended tests can run automatically." });
    await expect(alert).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.querySelector("[role=alert]") !== null)).toBe(true);
    q.regression422 = null;
    q.runs.unshift({ id: "run-RUN-0005", key: "RUN-0005", status: "awaiting_authorisation", include_should: true, created_at: "2026-11-15T15:00:00Z" });
    await page.reload();
    await expect(page.getByText("RUN-0005 was requested from this recommendation · Waiting for authorisation.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open RUN-0005" })).toHaveAttribute("href", "/projects/p1/execution/RUN-0005");
    await expect(page.getByRole("button", { name: "Request another run" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("viewer: the lists without the button or the checkbox", async ({ page }) => {
    await setup(page, { role: "viewer" });
    await page.goto(`${CHG1}?tab=regression`);
    await expect(page.getByRole("table", { name: "Must run (2)" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Request/ })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("375 px: impact rows and regression rows as cards, no sideways scroll (§17)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(`${CHG1}?tab=impact`);
    await expect(page.getByRole("heading", { level: 2, name: "Impact · 13 open of 13" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
    await page.getByRole("tab", { name: "Regression run" }).click();
    const cards = page.getByRole("list", { name: "Must run (2)" });
    await expect(cards.getByRole("listitem").first()).toContainText("Why: Directly affected");
    await expect(page.getByRole("list", { name: "Not included (2)" }).getByRole("listitem").filter({ hasText: "TC-0012" })).toContainText("Was must run");
    await expect(page.getByRole("button", { name: "Request this run" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });
});
