// QA P6-01 (independent of phase6.spec.ts): states and focus paths the developer's spec doesn't cover. Runs in
// Chromium (ui-mocked) and WebKit (ui-mocked-webkit). Design references: docs/design/P6-qa-analyst-phase6.md.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, mockApi, newState, project, signedIn, type MockState } from "./fixtures";
import { changeSet, demoItems, mockPhase6, newP6, scanRef, type P6State } from "./phase6-fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<P6State> = {}): Promise<{ s: MockState; q: P6State }> {
  const s = newState({ phase: "approved", g2Policy: "required" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newP6(over);
  await mockApi(page, s);
  await mockPhase6(page, s, q);
  await signedIn(page, s);
  return { s, q };
}

const CHANGES = "/projects/p1/discovery?view=changes";
const CHG1 = "/projects/p1/discovery/changes/CHG-0001";
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const plainRerun = (s: MockState) => s.requests.filter((r) => r.method === "POST" && r.path.startsWith("/projects/p1/stages/discovery/run"));

/** A partial rescan: Scan 3 stopped early; /about and /login weren't reached (design §6.5, OQ2). */
function partialState(): Partial<P6State> {
  const q = newP6();
  q.scans[0] = { ...q.scans[0], status: "partial", pages: 9 };
  const base = scanRef(q.scans[1], 2);
  const target = scanRef(q.scans[0], 2);
  const items = demoItems();
  const cs = changeSet("CHG-0001", base, target, items, {
    not_compared: [
      { page: "/about", url: "http://localhost:4100/about", missing_from: "target", reason: "Scan 3 stopped early and didn't reach this page" },
      { page: "/login", url: "http://localhost:4100/login", missing_from: "target", reason: "Scan 3 stopped early and didn't reach this page" },
    ],
  });
  return { scans: q.scans, sets: [cs], items: { [cs.id]: items } };
}

test.describe("QA P6-01 · focus (Safari helpers)", () => {
  test("drawer opened by mouse click returns focus to its Compare button on Escape and on Close", async ({ page }) => {
    await setup(page);
    await page.goto(CHG1);
    const compare = page.getByRole("button", { name: "Compare /contact" });
    await compare.click();
    const drawer = page.getByRole("dialog", { name: "/contact" });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(compare).toBeFocused();
    await compare.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /^Close/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(compare).toBeFocused();
  });

  test("keyboard only: Tab reaches the noise filter, Space toggles it and the count line changes", async ({ page }) => {
    await setup(page);
    await page.goto(CHG1);
    const hide = page.getByRole("checkbox", { name: /Hide cosmetic changes/ });
    await expect(hide).toBeChecked();
    const tab = test.info().project.name.includes("webkit") ? "Alt+Tab" : "Tab"; // Safari: Option-Tab reaches every control
    for (let i = 0; i < 40 && !(await hide.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press(tab);
    await expect(hide).toBeFocused();
    await page.keyboard.press("Space");
    await expect(hide).not.toBeChecked();
    const compare = page.getByRole("button", { name: "Compare /contact" });
    for (let i = 0; i < 40 && !(await compare.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press(tab);
    await expect(compare).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "/contact" });
    await expect(drawer).toBeVisible();
    // The view switch is reachable and operable by keyboard.
    const after = drawer.getByRole("radio", { name: "After" });
    await after.focus();
    await page.keyboard.press("Space");
    await expect(after).toHaveAttribute("aria-checked", "true");
    await expect(drawer.getByRole("img")).toHaveCount(1);
  });

  test("the 409 Gate 1 callout gets focus after a mouse click on Start rescan", async ({ page }) => {
    await setup(page, { g1Changed: true });
    await page.goto(CHANGES);
    await page.getByRole("button", { name: "Rescan and compare…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Start rescan" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]") && !!document.activeElement?.querySelector("[role=alert]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rescan and compare…" })).toBeFocused();
  });
});

test.describe("QA P6-01 · states", () => {
  test("partial rescan: warning, 'Not compared' rows, never 'Removed' for unreached pages; axe clean; 375 px", async ({ page }) => {
    await setup(page, partialState());
    await page.goto(CHG1);
    await expect(page.getByText("Scan 3 stopped early after 9 pages. Pages it didn't reach are listed as 'Not compared', not as removed.")).toBeVisible();
    const notCompared = page.getByRole("list", { name: "Pages not compared" });
    await expect(notCompared.getByRole("listitem")).toHaveCount(2);
    await expect(notCompared).toContainText("/about · Not compared: Scan 3 stopped early and didn't reach this page");
    await expect(page.getByRole("row", { name: /\/about/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByRole("list", { name: "Elements and form fields" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("failed comparison: danger callout with 'Both scans are unchanged', Try again re-posts the pair; viewer has no Try again", async ({ page }) => {
    const q = newP6();
    q.sets[0] = { ...q.sets[0], status: "failed", error: "interrupted", finished_at: null };
    q.items = {};
    const { q: state } = await setup(page, { sets: q.sets, items: q.items });
    await page.goto(CHG1);
    await expect(page.getByText("Couldn’t compare Scan 2 with Scan 3: interrupted. Both scans are unchanged.")).toBeVisible();
    await expect(page.getByText("Didn't complete")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => state.requests.filter((r) => r.method === "POST" && r.path === "/projects/p1/changes").length).toBe(1);
    expect(state.requests.find((r) => r.path === "/projects/p1/changes")?.body).toEqual({ from_scan_id: "scan2", to_scan_id: "scan3" });
  });

  test("viewer: failed comparison shows no Try again", async ({ page }) => {
    const q = newP6();
    q.sets[0] = { ...q.sets[0], status: "failed", error: "interrupted", finished_at: null };
    await setup(page, { role: "viewer", sets: q.sets, items: {} });
    await page.goto(CHG1);
    await expect(page.getByText(/Both scans are unchanged\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("re-baseline warning shows the counts; members get the regenerate action (design §6.4: opens the dialog)", async ({ page }) => {
    const q = newP6();
    q.sets[0] = { ...q.sets[0], rebaseline_suggested: true, summary: { ...q.sets[0].summary, pages: { ...q.sets[0].summary.pages!, removed: 4, structural: 3, baseline_compared: 12 } } };
    await setup(page, { sets: q.sets });
    await page.goto(CHG1);
    await expect(page.getByText(/^More than half the pages changed \(7 of 12\)\. Approved requirements may no longer describe the site\./)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    // Design §6.4 / §18: the button is "Regenerate requirements…" and opens the existing RegenerateDialog with Scan 3.
    await expect(page.getByRole("button", { name: "Regenerate requirements…" })).toBeVisible();
  });

  test("comparing in progress: change set page says it updates; Changes tab shows the comparing card; axe clean", async ({ page }) => {
    const q = newP6();
    q.sets[0] = { ...q.sets[0], status: "running", finished_at: null };
    await setup(page, { sets: q.sets, compareDelay: 1000 });
    await page.goto(CHG1);
    await expect(page.getByRole("heading", { name: "Comparing Scan 3 with Scan 2…" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.goto(CHANGES);
    await expect(page.getByRole("heading", { name: "Comparing Scan 3 with Scan 2…" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("'CHG-n ready' from the live stream is announced politely and focus doesn't move (design §6.3, check 8)", async ({ page }) => {
    // A stream that stays open (the shared fixture answers and closes, which makes every reconnect overwrite the
    // polite region with "Connection lost"): fetch() of the events stream returns a body the test writes to.
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      const w = window as unknown as { __sse?: ReadableStreamDefaultController<Uint8Array>; __live: string[] };
      w.__live = [];
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("/events/stream")) return real(input, init);
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (w.__sse = c) });
        return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      };
      new MutationObserver(() => {
        const el = document.querySelector("[role=status][aria-live=polite][aria-atomic=true]");
        if (el && el.textContent) w.__live.push(el.textContent);
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await setup(page);
    await page.goto(CHANGES);
    await expect(page.getByRole("heading", { level: 2, name: "Changes" })).toBeVisible();
    const rescan = page.getByRole("button", { name: "Rescan and compare…" });
    await rescan.focus();
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __sse?: unknown }).__sse)).toBe(true);
    const event = { id: 9001, project_id: "p1", stage_key: "discovery", agent_key: "change", task_id: null, type: "change.ready", level: "info",
      message: "CHG-0002 ready: 9 changes between Scan 2 and Scan 4 (6 structural, 3 behavioural, 0 cosmetic)", data: { kind: "result", change_set_key: "CHG-0002" }, created_at: "2026-11-15T12:00:00Z" };  // prettier-ignore
    await page.evaluate((e) => {
      const w = window as unknown as { __sse: ReadableStreamDefaultController<Uint8Array> };
      w.__sse.enqueue(new TextEncoder().encode(`id: ${e.id}\nevent: agent_event\ndata: ${JSON.stringify(e)}\n\n`));
    }, event);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __live: string[] }).__live.some((t) => /CHG-0002 ready: 9 changes/.test(t)))).toBe(true);
    await expect(rescan).toBeFocused();
  });
});

test.describe("QA P6-01 · OQ1: after Gate 2 only 'Rescan and compare…'", () => {
  test("when the scan list fails to load, the ⋯ menu must not fall back to a plain whole-chain re-scan", async ({ page }) => {
    const { s } = await setup(page);
    await page.route(`${API}/projects/p1/scans?**`, (route) => route.fulfill({ status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "internal", message: "boom" } }) }));
    await page.route(`${API}/projects/p1/scans`, (route) => route.fulfill({ status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "internal", message: "boom" } }) }));
    await page.goto("/projects/p1");
    await page.getByRole("button", { name: "More project actions" }).click();
    const item = page.getByRole("menuitem", { name: /Re-scan site|Rescan and compare/ });
    if ((await item.count()) === 0) return; // not offered at all is acceptable
    await item.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const start = dialog.getByRole("button", { name: /Start (rescan|re-scan)/ });
    await start.click();
    await page.waitForTimeout(1500);
    expect(plainRerun(s), "a plain discovery re-run was started after Gate 2 (design OQ1, D27)").toHaveLength(0);
  });

  test("slow scan list: pressing Start before it loads must not start a plain re-scan after Gate 2", async ({ page }) => {
    const { s } = await setup(page);
    await page.route(`${API}/projects/p1/scans**`, async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      return route.fallback();
    });
    await page.goto("/projects/p1");
    await page.getByRole("button", { name: "More project actions" }).click();
    await page.getByRole("menuitem", { name: /Re-scan site|Rescan and compare/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Start (rescan|re-scan)/ }).click();
    await page.waitForTimeout(1500);
    expect(plainRerun(s), "a plain discovery re-run was started after Gate 2 (design OQ1, D27)").toHaveLength(0);
  });
});
