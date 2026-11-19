// Phase 6 Changes (P6-01): rescan and compare, the Changes tab, change sets and the before/after drawer, against
// the stubbed API (./fixtures.ts + ./phase6-fixtures.ts, test-only). Each test names the design checks
// (docs/design/P6-qa-analyst-phase6.md §19) it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase6, newP6, type P6State } from "./phase6-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<P6State> & { before?: boolean } = {}) {
  const s = newState({ phase: over.before ? "awaiting" : "approved", g2Policy: "required" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newP6(over);
  await mockApi(page, s);
  await mockPhase6(page, s, q);
  await signedIn(page, s);
  return q;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const CHANGES = "/projects/p1/discovery?view=changes";
const CHG1 = "/projects/p1/discovery/changes/CHG-0001";
const more = (page: Page) => page.getByRole("button", { name: "More project actions" }).click();

test.describe("Phase 6 · rescan and compare", () => {
  test("before Gate 2: 'Approve Gate 2 first' and the menu keeps 'Re-scan site' (check 6)", async ({ page }) => {
    await setup(page, { before: true });
    await page.goto(CHANGES);
    await expect(page.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Changes are compared with the scan approved at Gate 2. Approve Gate 2 first.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review Gate 2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compare", exact: true })).toHaveCount(0);
    await more(page);
    await expect(page.getByRole("menuitem", { name: "Re-scan site" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Rescan and compare/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await axe(page)).toEqual([]);
  });

  test("after Gate 2: 'Rescan and compare…' preselects the Gate 2 scan, prefills its limits and starts a rescan (checks 6, 7)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(CHANGES);
    await more(page);
    await expect(page.getByRole("menuitem", { name: "Re-scan site" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Rescan and compare…" }).click();
    const dialog = page.getByRole("dialog", { name: "Rescan localhost and compare?" });
    await expect(dialog).toBeVisible();
    const select = dialog.getByLabel("Compare with");
    await expect(select).toHaveValue("scan2");
    await expect(select.locator("option:checked")).toHaveText(/^Scan 2 · .* · approved at Gate 2 \(recommended\)$/);
    await expect(dialog.getByLabel("Maximum pages")).toHaveValue("22");
    await expect(dialog.getByText("Accessibility and security results will be marked out of date, because pages may have changed.")).toBeVisible();
    await select.selectOption("scan3");
    await expect(dialog.getByText("Scan 3 wasn't approved at Gate 2. Changes are still listed, but approved work is linked to Scan 2.")).toBeVisible();
    await expect(dialog.getByLabel("Maximum pages")).toHaveValue("23");
    await select.selectOption("scan2");
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Start rescan" }).click();
    await expect(page.getByText("Scan 4 started. It will be compared with Scan 2.")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/p1\/discovery\?view=live$/);
    const req = q.requests.find((r) => r.path === "/projects/p1/rescans");
    expect(req?.body).toMatchObject({ limits: { max_pages: 22, max_depth: 2 } });
    expect(req?.body).not.toHaveProperty("compare_with");
  });

  test("a 409 because the hosts changed shows the Gate 1 message with focus on it (check 7)", async ({ page }) => {
    await setup(page, { g1Changed: true });
    await page.goto(CHANGES);
    await page.getByRole("button", { name: "Rescan and compare…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Start rescan" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toHaveText(/The site's URL or allowed hosts changed since they were authorised\. Authorise them again \(Gate 1\) before rescanning\./);
    await expect(alert.getByRole("link", { name: "Open Project settings" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.contains(document.querySelector("[role=dialog] [role=alert]")) ?? false)).toBe(true);
  });
});

test.describe("Phase 6 · Changes tab and change sets", () => {
  test("Changes tab: latest change, scan history with the baseline, change sets (check 12 setup)", async ({ page }) => {
    await setup(page);
    await page.goto(CHANGES);
    await expect(page.getByText("Compare what discovery saw in two scans. Nothing from earlier scans is changed or deleted.")).toBeVisible();
    await expect(page.getByText("9 changes: 6 structural · 3 behavioural · 0 cosmetic")).toBeVisible();
    const scans = page.getByRole("region", { name: "Scans" });
    await expect(scans.getByRole("row", { name: /Scan 2/ })).toContainText("Approved (baseline)");
    await expect(scans.getByRole("row", { name: /Scan 3/ })).toContainText("Rescan, compared with 2");
    await expect(scans.getByRole("row", { name: /Scan 1/ })).toContainText("First scan");
    await expect(page.getByRole("region", { name: "Change sets" }).getByRole("row", { name: /CHG-0001/ })).toContainText("Compared");
    // The same pair again opens the existing set (check 12).
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("2");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("3");
    await expect(page.getByRole("link", { name: "Open CHG-0001" }).last()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("CHG-0001 lists exactly the demo items with significance as text; empty groups say so (check 9)", async ({ page }) => {
    await setup(page);
    await page.goto(CHG1);
    await expect(page.getByRole("heading", { level: 1, name: "CHG-0001 · Scan 2 → Scan 3" })).toBeVisible();
    await expect(page.getByText(/^Changes are detected by comparing what discovery saw in two scans\./)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "What changed (9)" })).toBeVisible();
    const elements = page.getByRole("region", { name: "Elements and form fields" });
    for (const [what, sig] of [
      ["Link removed: Travel mug", "Structural"],
      ["Button renamed: Send message → Send", "Behavioural"],
      ["Form added: Promo code", "Structural"],
      ["Field added: Order number", "Structural"],
      ["Field changed: Message → Your message (now required)", "Structural"],
    ])
      await expect(elements.getByRole("row", { name: what })).toContainText(sig);
    await expect(elements.getByRole("row", { name: "Field added: Order number" })).toContainText("up to 20 characters");
    const pages = page.getByRole("region", { name: "Pages" });
    await expect(pages.getByRole("row", { name: "/offers" })).toContainText("Added");
    await expect(pages.getByRole("row", { name: "/products/1" })).toContainText("Removed");
    await expect(page.getByText('Link added: "Offers" → /offers')).toBeVisible();
    await expect(page.getByText(/Contact the company — step 3 "Enter Message" → "Enter Your message"/)).toBeVisible();
    await expect(page.getByText("No requirement changes.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Hide cosmetic changes (0 hidden)" })).toBeChecked();
    await expect(page.getByText("Showing 9 of 9 changes")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("compare Scan 1 with Scan 3: new change set, noise filter and content values; CHG-0001 unchanged (checks 10, 12)", async ({ page }) => {
    const q = await setup(page);
    await page.goto(CHANGES);
    await page.getByLabel("From", { exact: true }).selectOption("3");
    await page.getByLabel("To", { exact: true }).selectOption("2");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.getByText("Choose a later scan in To.")).toBeVisible();
    await expect(page.getByLabel("To", { exact: true })).toBeFocused();
    await page.getByLabel("From", { exact: true }).selectOption("1");
    await page.getByLabel("To", { exact: true }).selectOption("3");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page).toHaveURL(/\/discovery\/changes\/CHG-0002$/);
    await expect(page.getByRole("heading", { level: 1, name: "CHG-0002 · Scan 1 → Scan 3" })).toBeVisible();
    await expect(page.getByText("CHG-0002 ready: 3 changes.")).toBeVisible();
    const hide = page.getByRole("checkbox", { name: "Hide cosmetic changes (2 hidden)" });
    await expect(hide).toBeChecked();
    await expect(page.getByText("Showing 1 of 3 changes")).toBeVisible();
    await hide.uncheck();
    await expect(page.getByText("Showing 3 of 3 changes")).toBeVisible();
    await expect(page.getByText("Content values changed on /products/2 (1): prices or counts")).toBeVisible();
    await page.getByRole("button", { name: "Show values" }).click();
    await expect(page.getByText(/Price: £12.50/)).toBeVisible();
    expect(q.requests.filter((r) => r.method === "POST" && r.path === "/projects/p1/changes")).toHaveLength(1);
    expect(q.sets.find((s) => s.key === "CHG-0001")?.summary.total).toBe(9);
  });

  test("before/after drawer: keyboard, alts, Escape returns focus to the Compare button (check 11)", async ({ page }) => {
    await setup(page);
    await page.goto(CHG1);
    const compare = page.getByRole("button", { name: "Compare /contact" });
    await compare.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "/contact" });
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/page=%2Fcontact/);
    await expect(drawer.getByRole("radio", { name: "Side by side" })).toHaveAttribute("aria-checked", "true");
    await expect(drawer.getByRole("img", { name: /^Before: \/contact in Scan 2, .+, desktop 1440 × 900\.$/ })).toBeVisible();
    await expect(drawer.getByRole("img", { name: /^After: \/contact in Scan 3, .+, desktop 1440 × 900\.$/ })).toBeVisible();
    await expect(drawer.getByRole("row", { name: "Button renamed: Send message → Send" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(compare).toBeFocused();
    // A page that was added has no Before screenshot, only text.
    await page.getByRole("button", { name: "Compare /offers" }).click();
    await expect(page.getByRole("dialog", { name: "/offers" }).getByText("Not in Scan 2: this page is new.")).toBeVisible();
  });

  test("375 px: no sideways scroll; the drawer offers Before and After only (check 11, §17)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(CHANGES);
    await expect(page.getByRole("list", { name: "Scans" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
    await page.goto(CHG1);
    await expect(page.getByRole("list", { name: "Elements and form fields" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Compare /contact" }).click();
    const drawer = page.getByRole("dialog", { name: "/contact" });
    await expect(drawer.getByRole("radio")).toHaveText(["Before", "After"]);
    await expect(drawer.getByRole("radio", { name: "Before" })).toHaveAttribute("aria-checked", "true");
    await expect(drawer.getByRole("img")).toHaveCount(1);
    await drawer.getByRole("radio", { name: "After" }).click();
    await expect(drawer.getByRole("img", { name: /^After: \/contact in Scan 3/ })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("viewer: no Rescan or Compare controls; change sets stay readable (check 13)", async ({ page }) => {
    await setup(page, { role: "viewer" });
    await page.goto(CHANGES);
    await expect(page.getByText("9 changes: 6 structural · 3 behavioural · 0 cosmetic")).toBeVisible();
    await expect(page.getByRole("button", { name: /Rescan and compare/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Compare", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("From", { exact: true })).toHaveCount(0);
    await more(page);
    await expect(page.getByRole("menuitem", { name: /Rescan|Re-scan/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Open CHG-0001" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "What changed (9)" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
