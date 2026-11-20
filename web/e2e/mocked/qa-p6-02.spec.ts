// QA probes for P6-02 (design P6 §7) beyond the developer's phase6-impact.spec.ts, in Chromium and WebKit:
// keyboard-only closing (Tab, Space, typing, Enter), a 409 inside the close dialog, a mouse click on the aria-disabled
// "Request this run" (WebKit doesn't focus clicked buttons), the member-without-approval toast, the open count in the
// Impact tab label after closing, and 375 px with the close dialog open and with the blocked reason shown.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase6, newP6, type P6State } from "./phase6-fixtures";

async function axe(page: Page) {
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
  return { s, q };
}

const CHG1 = "/projects/p1/discovery/changes/CHG-0001";
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Presses Tab until `name` (an accessible name) has focus; fails after `max` presses. */
async function tabTo(page: Page, matches: (el: { label: string; text: string; tag: string }) => boolean, max = 80) {
  // Safari moves to every control with Option+Tab (plain Tab skips buttons and links by default).
  const key = page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  for (let n = 0; n < max; n++) {
    await page.keyboard.press(key);
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { label: a?.getAttribute("aria-label") ?? "", text: (a?.textContent ?? "").trim(), tag: a?.tagName ?? "" };
    });
    if (matches(el)) return;
  }
  throw new Error("never reached the control with Tab");
}

test.describe("QA P6-02 · impact", () => {
  test("keyboard only: Tab to Close…, choose with Space, type the reason, submit with Enter", async ({ page, browserName }) => {
    const { q } = await setup(page);
    await page.goto(`${CHG1}?tab=impact`);
    await expect(page.getByRole("tab", { name: "Impact (13 open)" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("heading", { level: 2, name: "Impact · 13 open of 13" }).click();
        await tabTo(page, (el) => el.label === "Close impact item for TC-0012");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: /Close impact item · TC-0012/ });
    await expect(dialog).toBeVisible();
    // Focus is inside the dialog; Tab to the second radio and pick it with Space.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
    await tabTo(page, (el) => el.tag === "INPUT", 10);
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("radio", { name: "No action needed" })).toBeChecked();
    await tabTo(page, (el) => el.tag === "TEXTAREA", 3);
    await expect(dialog.getByLabel(/Reason/)).toBeFocused();
    await page.keyboard.type("Retired with the mug");
    await tabTo(page, (el) => el.text === "Close item", 6);
    await page.keyboard.press("Enter");
    await expect(page.getByText("TC-0012 impact item closed.")).toBeVisible();
    expect(q.requests.find((r) => r.method === "PATCH")?.body).toEqual({ status: "no_action", reason: "Retired with the mug" });
    await expect(page.getByRole("button", { name: "Close impact item for A11Y-0001-01" })).toBeFocused();
    // The tab label's open count follows.
    await expect(page.getByRole("tab", { name: "Impact (12 open)" })).toBeVisible();
    test.info().annotations.push({ type: "browser", description: browserName });
  });

  test("409 (closed by someone else meanwhile): the dialog stays open with the message", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto(`${CHG1}?tab=impact`);
    await page.getByRole("button", { name: "Close impact item for TC-0012" }).click();
    const dialog = page.getByRole("dialog");
    // Someone else closes it first.
    Object.assign(q.impact["cs-CHG-0001"].find((i) => i.id === "i-tc12")!, { status: "resolved" });
    await dialog.getByRole("radio", { name: /^Resolved/ }).check();
    await dialog.getByRole("button", { name: "Close item" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Already closed.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("375 px: the close dialog fits and has no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await setup(page);
    await page.goto(`${CHG1}?tab=impact`);
    await page.getByRole("button", { name: "Close impact item for PRF-01" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: "No action needed" }).check();
    await dialog.getByRole("button", { name: "Close item" }).click();
    await expect(dialog.getByText("Say why no action is needed.")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const box = await dialog.getByRole("button", { name: "Close item" }).boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(375);
    expect(box && box.height).toBeGreaterThanOrEqual(24);
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("QA P6-02 · regression run", () => {
  test("a mouse click on the aria-disabled Request this run sends nothing and the reason stays readable", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto(`${CHG1}?tab=regression`);
    const btn = page.getByRole("button", { name: "Request this run" });
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    // A real pointer click (Playwright's actionability check waits on aria-disabled, so force it).
    await btn.click({ force: true });
    await btn.click({ force: true });
    await expect(page).toHaveURL(/tab=regression/);
    expect(q.requests.filter((r) => r.path.endsWith("/regression-run"))).toHaveLength(0);
    await expect(btn).toHaveAccessibleDescription(/Accept or reject their repair suggestions first\./);
    await expect(page.getByText("It still needs Gate 7: someone who can approve authorises it before anything runs.")).toBeVisible();
    // Must-run outdated tests stay under Must run (OQ3), never under Not included.
    await expect(page.getByRole("table", { name: "Not included (2)" }).getByRole("row", { name: /TC-0019|TC-0020/ })).toHaveCount(0);
    await expect(page.getByText("Always included")).toBeVisible();
  });

  test("keyboard: Tab to Request this run and press Enter; a member without approval gets the Gate 7 toast", async ({ page }) => {
    const { s, q } = await setup(page, { outdated: false, role: "member" });
    await page.route(`${API}/auth/me`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: "member", can_approve: false }) }),
    );
    await page.goto(`${CHG1}?tab=regression`);
    await page.getByRole("heading", { level: 2, name: /Regression run · recommended by rules/ }).click();
    await tabTo(page, (el) => el.text === "Request this run");
    await page.keyboard.press("Enter");
    await expect(page.getByText("RUN-0005 requested. Someone who can approve must authorise it (Gate 7).")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/p1\/execution\/RUN-0005$/, { timeout: 30_000 });
    expect(q.requests.find((r) => r.path.endsWith("/regression-run"))?.body).toEqual({ include_should: true });
  });

  test("375 px: the blocked reason and Review repairs fit without sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(`${CHG1}?tab=regression`);
    await expect(page.getByText("2 must-run tests have outdated scripts. Accept or reject their repair suggestions first.")).toBeVisible();
    const review = page.getByRole("tabpanel", { name: "Regression run" }).getByRole("button", { name: "Review repairs" });
    await expect(review).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const box = await review.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(24);
    expect(await axe(page)).toEqual([]);
  });
});
