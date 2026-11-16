// Phase 6 repairs (P6-04, D31; design P6 §8, §16): the Repairs tab of CHG-0001 and Automation › Repairs against the
// stubbed API (./fixtures.ts + ./phase6-fixtures.ts, test-only). One suggestion at a time behind a confirmation, no
// bulk selection, text alternatives for the screenshots, keyboard use, focus after accept/reject (including the Safari
// path through web/src/lib/pointerFocus.ts: a clicked button isn't focused there), axe and 375 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase6, mockRepairs, newP6, newRepairs, type RepairState } from "./phase6-fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<RepairState> = {}) {
  const s = newState({ phase: "approved", g2Policy: "required" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const r = newRepairs(over);
  await mockApi(page, s);
  await mockPhase6(page, s, newP6({ role: r.role }));
  await mockRepairs(page, r);
  await signedIn(page, s);
  return r;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const REPAIRS = "/projects/p1/discovery/changes/CHG-0001?tab=repairs";
const card = (page: Page, key: string) => page.getByRole("article", { name: new RegExp(`^${key} `) });
const LINE = "Only this locator changes; the test's checks stay the same.";

test.describe("Phase 6 · repairs (P6-04)", () => {
  test("the card in words: candidates, signals, verified line, screenshot alt, diff, variants; no bulk selection (§8.2, §8.4)", async ({ page }) => {
    await setup(page);
    await page.goto(REPAIRS);
    await expect(page.getByRole("tab", { name: "Repairs (5)" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 2, name: "Repairs (5)" })).toBeVisible();
    const h1 = card(page, "HEAL-0001");
    await expect(h1.getByRole("heading", { name: "HEAL-0001 · ContactPage.ts · the Message field" })).toBeVisible();
    await expect(h1).toContainText("Open · From CHG-0001 (before any test failed)");
    await expect(h1).toContainText("Used by 1 script: TC-0019");
    await expect(h1).toContainText("Not found on /contact after CHG-0001");
    const group = h1.getByRole("group", { name: "Choose a replacement for getByLabel('Message')" });
    const first = group.getByRole("radio", { name: "getByLabel('Your message')" });
    await expect(first).toBeChecked();
    await expect(first).toHaveAccessibleDescription(/^Why: Same field, renamed \(CHG-0001\) · Same role \(text box\)/);
    await expect(h1.getByText("High match (0.93)")).toBeVisible();
    await expect(h1.getByText(/^Found exactly 1 visible element on \/contact \(checked /).first()).toBeVisible();
    await expect(h1.getByRole("img", { name: /^Screenshot of \/contact on 15 Nov with the matched element outlined: text box 'Your message'\.$/ }).first()).toBeVisible();
    await expect(h1.getByRole("button", { name: "Open full size screenshot for getByLabel('Your message')" })).toBeVisible();
    // Low candidates sit under "Other possibilities" and stay selectable there.
    const other = h1.getByRole("button", { name: "Other possibilities (1, low match)" });
    await expect(other).toHaveAttribute("aria-expanded", "false");
    await other.click();
    await expect(group.getByRole("radio", { name: "getByLabel('Order number')" })).toBeVisible();
    await expect(h1.getByText(LINE)).toBeVisible();
    await expect(h1.getByText("After: getByLabel('Your message')")).toBeVisible(); // the diff: "−" / "+" lines, named in text
    await expect(h1.getByText("Before: getByLabel('Message')")).toBeVisible();
    await expect(h1.getByRole("button", { name: "Accept this replacement for getByLabel('Message')" })).toBeVisible();
    await expect(h1.getByRole("button", { name: "Reject HEAL-0001" })).toBeVisible();
    // Ambiguous: listed with the count, no radio; with nothing else offered there is no Accept.
    const h4 = card(page, "HEAL-0004");
    await expect(h4).toContainText("More than one element matches; not offered (2 matches)");
    await expect(h4.getByRole("radio")).toHaveCount(0);
    await expect(h4.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
    await expect(h4).toContainText("No safe replacement found: nothing on / matches exactly once with the same role. Update the test case or regenerate the scripts.");
    await expect(h4.getByRole("link", { name: "Open TC-0040" })).toBeVisible();
    // Expected result: amber, no radios, no Accept or Reject; a person edits the case (Gate 5).
    const h3 = card(page, "HEAL-0003");
    await expect(h3).toContainText("Needs a person");
    await expect(h3).toContainText("The text changed from 'Thank you' to 'Thanks!' on /contact (CHG-0001). TC-0021 checks this text. Expected results are never changed automatically. Review TC-0021.");
    await expect(h3.getByRole("link", { name: "Review TC-0021" })).toHaveAttribute("href", "/projects/p1/test-cases/TC-0021");
    await expect(h3.getByRole("button")).toHaveCount(0);
    // From a failed test.
    await expect(card(page, "HEAL-0005")).toContainText("From a failed test (RUN-0003-07)");
    // No list has checkboxes or a bulk bar.
    await expect(page.getByRole("tabpanel").getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /accept all|accept selected/i })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("keyboard: &heal= focuses the card; choose, confirm (focus on Cancel), accept; heading focused; checks and Replaced (§8.3, §16.2)", async ({ page, browserName }) => {
    const r = await setup(page);
    await page.goto(`${REPAIRS}&heal=HEAL-0001`);
    const h1 = card(page, "HEAL-0001");
    const heading = h1.getByRole("heading", { name: /^HEAL-0001/ });
    await expect(heading).toBeFocused();
    const first = h1.getByRole("radio", { name: "getByLabel('Your message')" });
    // Safari's Tab skips buttons and radios unless "Keyboard navigation" is on (pointerFocus.ts): there, start on it.
    if (browserName === "webkit") await first.focus();
    else await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const second = h1.getByRole("radio", { name: "getByRole('textbox', { name: 'Your message' })" });
    await expect(second).toBeChecked();
    await expect(h1.getByText("After: getByRole('textbox', { name: 'Your message' })")).toBeVisible();
    const accept = h1.getByRole("button", { name: "Accept this replacement for getByLabel('Message')" });
    await accept.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Accept HEAL-0001?" });
    await expect(dialog).toContainText(`Use getByRole('textbox', { name: 'Your message' }) in ContactPage.ts? ${LINE} ContactPage.ts version 3 is created, and the 1 script that uses it is checked again (Gate 6) before it can run.`);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(accept).toBeFocused();
    expect(r.requests.filter((x) => x.method === "POST")).toHaveLength(0);
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Accept replacement" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("HEAL-0001 accepted. ContactPage.ts version 3 is being checked.")).toBeVisible();
    const done = h1.getByRole("heading", { name: /^HEAL-0001 · Accepted by M\. Member · .* · ContactPage\.ts version 3$/ });
    await expect(done).toBeFocused();
    expect(r.requests.filter((x) => x.method === "POST")).toEqual([{ method: "POST", path: "/heal-suggestions/h1/accept", body: { index: 1 } }]);
    await expect(h1.getByRole("status")).toHaveText(/1 script valid again\. The impact item is closed\./, { timeout: 15_000 });
    await expect(card(page, "HEAL-0005")).toContainText("Replaced: another suggestion for this locator was accepted (HEAL-0001)");
    await expect(h1.getByRole("radio")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("pointer: Reject needs a reason; focus returns to the pressed button, then lands on the card heading (§8.3, pointerFocus)", async ({ page }) => {
    const r = await setup(page);
    await page.goto(REPAIRS);
    const h2 = card(page, "HEAL-0002");
    const reject = h2.getByRole("button", { name: "Reject HEAL-0002" });
    await reject.click();
    const dialog = page.getByRole("dialog", { name: "Reject HEAL-0002?" });
    await expect(dialog).toContainText("It won't be offered again for this locator on this page.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(reject).toBeFocused(); // WebKit too: focusOrigin() is the pressed button
    await reject.click();
    await dialog.getByRole("button", { name: "Reject suggestion" }).click();
    const reason = dialog.getByRole("textbox", { name: "Reason" });
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAccessibleDescription("Say why. The reason is kept with the suggestion.");
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(r.requests.filter((x) => x.method === "POST")).toHaveLength(0);
    await reason.fill("The Send button is tested by TC-0030");
    await dialog.getByRole("button", { name: "Reject suggestion" }).click();
    await expect(page.getByText("HEAL-0002 rejected.")).toBeVisible();
    await expect(h2.getByRole("heading", { name: /^HEAL-0002/ })).toBeFocused();
    await expect(h2).toContainText("Rejected by M. Member: 'The Send button is tested by TC-0030'. Fix the test case or regenerate the scripts.");
    await expect(h2.getByRole("link", { name: "Open TC-0020" })).toBeVisible();
    await expect(h2.getByRole("button")).toHaveCount(0);
  });

  test("decided elsewhere: the danger callout says who, focused; nothing changes (§8.3)", async ({ page }) => {
    await setup(page, { decidedElsewhere: "HEAL-0002" });
    await page.goto(REPAIRS);
    const h2 = card(page, "HEAL-0002");
    await h2.getByRole("button", { name: "Accept this replacement for getByRole('button', { name: 'Send message' })" }).click();
    await page.getByRole("dialog", { name: "Accept HEAL-0002?" }).getByRole("button", { name: "Accept replacement" }).click();
    const alert = h2.getByRole("alert");
    await expect(alert).toHaveText("This suggestion was already decided by A. Approver.");
    await expect(page.locator(":focus")).toContainText("This suggestion was already decided by A. Approver.");
    await expect(h2.getByRole("radio")).toHaveCount(1); // still open: nothing was changed here
  });

  test("viewer: read-only cards, candidates as text, no buttons; offline: actions aria-disabled with the reason (§8.3)", async ({ page, context }) => {
    await setup(page, { role: "viewer" });
    await page.goto(REPAIRS);
    const h1 = card(page, "HEAL-0001");
    await expect(h1.getByText("getByLabel('Your message')", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("tabpanel").getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("tabpanel").getByRole("button", { name: /^(Accept|Reject)/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    const p2 = await context.newPage();
    await setup(p2);
    await p2.goto(REPAIRS);
    await context.setOffline(true);
    const accept = card(p2, "HEAL-0001").getByRole("button", { name: "Accept this replacement for getByLabel('Message')" });
    await expect(accept).toHaveAttribute("aria-disabled", "true");
    await expect(accept).toHaveAccessibleDescription("You're offline. Reconnect to accept or reject.");
    await accept.focus();
    await p2.keyboard.press("Enter");
    await expect(p2.getByRole("dialog")).toHaveCount(0);
    await context.setOffline(false);
  });

  test("375 px: candidates stacked, code wraps, buttons full width, no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(REPAIRS);
    const accept = card(page, "HEAL-0001").getByRole("button", { name: "Accept this replacement for getByLabel('Message')" });
    await expect(accept).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const box = await accept.boundingBox();
    const art = await card(page, "HEAL-0001").boundingBox();
    expect(box && art && box.width).toBeGreaterThan((art?.width ?? 0) - 48);
    expect(box && box.height).toBeGreaterThanOrEqual(24);
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 6 · Automation › Repairs (P6-04)", () => {
  test("the Repairs tab after Review · Gate 6, with Status and Source filters (§8.1)", async ({ page }) => {
    const s = newState({ phase: "approved" });
    s.projects = [project()];
    const q4 = newP4();
    const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q4.role });
    const p3 = newP3({ designed: true, g5: "approved", canApprove: q4.canApprove });
    const r = newRepairs();
    await mockApi(page, s);
    await mockPhase2(page, s, p2);
    await mockPhase3(page, s, p2, p3);
    await mockPhase4(page, s, q4);
    await mockRepairs(page, r);
    await signedIn(page, s);
    await page.goto("/projects/p1/automation?view=repairs");
    const tabs = page.getByRole("tablist", { name: "Automation views" }).getByRole("tab");
    await expect(tabs).toHaveText(["Overview", /^Scripts/, "Review · Gate 6", "Repairs (5)"]);
    await expect(page.getByRole("tab", { name: "Repairs (5)" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Status")).toHaveValue("open");
    await expect(page.getByRole("article")).toHaveCount(5);
    await page.getByLabel("Source").selectOption({ label: "From a failed test" });
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(card(page, "HEAL-0005")).toContainText("From a failed test (RUN-0003-07)");
    expect(r.requests.some((x) => x.path.includes("source=failure") && x.path.includes("status=open"))).toBe(true);
    await page.getByLabel("Source").selectOption({ label: "Any" });
    await expect(page.getByRole("heading", { level: 3, name: "ContactPage.ts" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Expected results to review" })).toBeVisible();
    await page.getByLabel("Status").selectOption({ label: "Replaced" });
    await expect(page.getByText("When a rescan or a failed test breaks a locator, suggestions appear here.")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });
});
