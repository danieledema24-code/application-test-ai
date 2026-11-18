// QA probes for P6-03c (exploratory workspace and live session view): risky behaviours not covered by
// phase6-explore.spec.ts. Test-only; uses the same stubbed API fixtures.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { demoSession, mockExplore, newExplore, runningSession, waitingSession, type ExploreState } from "./phase6-explore-fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<ExploreState> = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newExplore(over);
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const e = newExec({ role: q.role, canApprove: q.canApprove });
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }), newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, e);
  await mockExplore(page, s, q, p4);
  await signedIn(page, s);
  return q;
}

const TAB = "/projects/p1/execution?tab=exploratory";
const EXP = (k: string) => `/projects/p1/execution/exploratory/${k}`;
const posts = (q: ExploreState) => q.requests.filter((r) => r.method === "POST" && r.path === "/projects/p1/exploratory-sessions");
const API_RE = /\/api\/v1\//;

test.describe("QA P6-03c probes", () => {
  test("member signed-in request: a second click after the POST answered but before navigation does not create a second request", async ({ page }) => {
    const q = await setup(page, { role: "member", canApprove: false });
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await expect(dialog).toBeVisible();
    // Slow down the client-side navigation to the new session page (RSC fetch / document) so the dialog stays up.
    await page.route(/\/projects\/p1\/execution\/exploratory\/EXP-0002/, async (route) => {
      if (API_RE.test(route.request().url())) return route.fallback();
      await new Promise((r) => setTimeout(r, 2500));
      return route.fallback();
    });
    await dialog.getByRole("checkbox", { name: "Explore signed in, with the saved test account" }).check();
    const btn = dialog.getByRole("button", { name: "Request approval", exact: true });
    await btn.click();
    await expect.poll(() => posts(q).length).toBe(1);
    await page.waitForTimeout(300);
    if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    expect(q.sessions.filter((x) => x.status === "awaiting_approval").map((x) => x.key), "only one pending request").toEqual(["EXP-0002"]);
    expect(posts(q).length, "only one POST /exploratory-sessions").toBe(1);
  });

  test("start: a server error shows 'Couldn't start exploring: … Nothing was started.' and the dialog stays", async ({ page }) => {
    const q = await setup(page);
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await page.route(/\/api\/v1\/projects\/p1\/exploratory-sessions$/, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: { code: "internal", message: "The worker is unavailable" } }) })
        : route.fallback(),
    );
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText(/^Couldn.t start exploring: .*Nothing was started\.$/)).toBeVisible();
    expect(q.sessions.length).toBe(1);
  });

  test("start: over the organisation limit for minutes and 0 actions are refused client-side; nothing is sent", async ({ page }) => {
    const q = await setup(page);
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await dialog.getByRole("textbox", { name: "Actions" }).fill("0");
    await dialog.getByRole("textbox", { name: "Minutes" }).fill("11");
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText("Enter a whole number of actions (1 or more).")).toBeVisible();
    await expect(dialog.getByText("Your organisation allows up to 10 minutes.")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Actions" })).toBeFocused();
    await dialog.getByRole("textbox", { name: "Actions" }).fill("1.5");
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText("Enter a whole number of actions (1 or more).")).toBeVisible();
    expect(posts(q)).toHaveLength(0);
    // The limit lines describe the fields.
    await expect(dialog.getByRole("textbox", { name: "Minutes" })).toHaveAccessibleDescription(/Your organisation allows up to 10\. This server allows up to/);
  });

  test("chosen pages with none ticked: 'Choose at least one page.'", async ({ page }) => {
    const q = await setup(page);
    await page.goto(`${TAB}&new=1`);
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await dialog.getByRole("radio", { name: /Chosen pages/ }).check();
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(dialog.getByText("Choose at least one page.")).toBeVisible();
    expect(posts(q)).toHaveLength(0);
    await expect(dialog.getByRole("radio", { name: /Pages with open defects/ })).toBeDisabled();
  });

  test("Stop now: Escape on the confirmation keeps exploring and sends nothing", async ({ page }) => {
    const q = await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 1 });
    await page.goto(EXP("EXP-0002"));
    await page.getByRole("button", { name: "Stop now" }).click();
    await expect(page.getByRole("dialog", { name: "Stop EXP-0002 now?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop now" })).toBeFocused();
    expect(q.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(0);
  });

  test("Stop now: server accepted but hasn't stopped after 5 s → 'Still stopping…'", async ({ page }) => {
    const q = await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 1 });
    await page.route(/\/api\/v1\/quality-scans\/exp-2\/cancel$/, (route) => {
      q.requests.push({ method: "POST", path: "/quality-scans/exp-2/cancel", body: {} });
      const s = q.sessions.find((x) => x.key === "EXP-0002")!;
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ message: "Stopping EXP-0002…", scan: s }) });
    });
    await page.goto(EXP("EXP-0002"));
    await page.getByRole("button", { name: "Stop now" }).click();
    await page.getByRole("dialog", { name: "Stop EXP-0002 now?" }).getByRole("button", { name: "Stop now" }).click();
    await expect(page.getByRole("button", { name: /Stopping/ })).toBeVisible();
    await expect(page.getByText("Still stopping… the browser is being shut down.")).toBeVisible({ timeout: 8000 });
  });

  test("Stop now offline: 'Connection lost…' and it retries until the server answers, then stops", async ({ page }) => {
    const q = await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 1 });
    let fails = 2;
    await page.route(/\/api\/v1\/quality-scans\/exp-2\/cancel$/, (route) => {
      if (route.request().method() === "POST" && fails > 0) {
        fails--;
        return route.abort("internetdisconnected");
      }
      return route.fallback();
    });
    await page.goto(EXP("EXP-0002"));
    await page.getByRole("button", { name: "Stop now" }).click();
    await page.getByRole("dialog", { name: "Stop EXP-0002 now?" }).getByRole("button", { name: "Stop now" }).click();
    await expect(page.getByText("Connection lost. Reconnecting… the session keeps running on the server.")).toBeVisible();
    await expect(page.getByRole("paragraph").filter({ hasText: /^Stopped by .* after \d+ actions\. Steps and findings so far are kept\.$/ })).toBeVisible({ timeout: 10000 });
    expect(q.requests.filter((r) => r.path === "/quality-scans/exp-2/cancel")).toHaveLength(1);
    await expect(page.getByText("Connection lost. Reconnecting…")).toHaveCount(0);
  });

  test("session ends while focus is in the live block → results heading; focus elsewhere stays put", async ({ page }) => {
    await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 3 });
    await page.goto(EXP("EXP-0002"));
    await page.getByRole("button", { name: "Pause updates" }).focus();
    await expect(page.getByRole("heading", { name: "Results" })).toBeFocused({ timeout: 30000 });
    await expect(page.getByRole("heading", { name: "Live progress" })).toHaveCount(0);
  });

  test("session ends while focus is on the back link: focus is not moved", async ({ page }) => {
    await setup(page, { sessions: [runningSession("EXP-0003"), demoSession()], stepsPerTick: 3 });
    await page.goto(EXP("EXP-0003"));
    const back = page.getByRole("link", { name: "Exploratory", exact: true });
    await back.focus();
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(500);
    await expect(back).toBeFocused();
  });

  test("polite region: milestones only (start, finding, 25/50/75 %, end), never per step", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __said: string[] }).__said = [];
      new MutationObserver(() => {
        document.querySelectorAll('p[role="status"].sr-only').forEach((el) => {
          const t = el.textContent ?? "";
          const said = (window as unknown as { __said: string[] }).__said;
          if (t && said[said.length - 1] !== t) said.push(t);
        });
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await setup(page, { stepsPerTick: 2 });
    await page.goto(`${TAB}&new=1`);
    await page.getByRole("dialog", { name: "Explore pages" }).getByRole("button", { name: "Start exploring" }).click();
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 60000 });
    await page.waitForTimeout(500);
    const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
    console.log("announcements:", JSON.stringify(said));
    expect(said.some((t) => /Finding on \/offers/.test(t))).toBe(true);
    expect(said.some((t) => /25 %/.test(t))).toBe(true);
    expect(said.some((t) => /EXP-0002 finished/.test(t) || /finished/i.test(t))).toBe(true);
    expect(said.some((t) => /Menu item|Clicked/.test(t))).toBe(false);
    expect(said.length).toBeLessThanOrEqual(8);
  });

  test("reduced motion: paused by default but still refreshes about every 5 s", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 1 });
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByRole("button", { name: "Resume updates" })).toBeVisible();
    const live = page.getByTestId("explore-live-line");
    const first = await live.innerText();
    await expect(live).not.toHaveText(first, { timeout: 7000 });
  });

  test("other member on someone else's waiting request: read-only with the permission line; no Withdraw, no Approve; axe clean", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false, sessions: [waitingSession("EXP-0004", { requested_by: { id: "m", full_name: "M. Member" } }), demoSession()] });
    await page.goto(EXP("EXP-0004"));
    const panel = page.getByRole("region", { name: /Approve exploratory session EXP-0004/ });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Approving signed-in exploration needs approval permission. Someone who can approve will see this request.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw request" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Approve and start/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Don.t approve/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("viewer on a waiting and on a running session: no controls at all", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false, sessions: [runningSession("EXP-0005"), waitingSession("EXP-0004"), demoSession()] });
    await page.goto(EXP("EXP-0004"));
    await expect(page.getByRole("region", { name: /Approve exploratory session EXP-0004/ })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Approve|Don.t approve|Withdraw/ })).toHaveCount(0);
    await page.goto(EXP("EXP-0005"));
    await expect(page.getByTestId("explore-live-line")).toBeVisible();
    await expect(page.getByRole("button", { name: /Stop now|Stopping/ })).toHaveCount(0);
    await page.goto(TAB);
    await expect(page.getByRole("button", { name: "Explore…" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Review EXP|Open EXP-0004$/ }).filter({ hasText: /Review|Open/ })).toHaveCount(0);
  });

  test("live view and Stop confirmation are axe-clean; 375 px live view has a single Stop now tab stop", async ({ page }) => {
    await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 1 });
    await page.goto(EXP("EXP-0002"));
    await expect(page.getByTestId("explore-live-line")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Stop now" }).click();
    await expect(page.getByRole("dialog", { name: "Stop EXP-0002 now?" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.getByRole("button", { name: "Stop now" })).toHaveCount(1);
    const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(w).toBeLessThanOrEqual(0);
  });

  test("unknown session key: 404 copy", async ({ page }) => {
    await setup(page);
    await page.goto(EXP("EXP-0099"));
    await expect(page.getByText("We couldn't find EXP-0099 in this project.").first()).toBeVisible();
  });

  test("results at 375 px: Not tried and blocked view does not scroll sideways; axe clean", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(`${EXP("EXP-0001")}?view=not-tried`);
    await expect(page.getByText("POST /basket").first()).toBeVisible();
    const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(w).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });
  test("Stop now offline: pressing Stop now again while reconnecting doesn't start a second retry loop", async ({ page }) => {
    const q = await setup(page, { sessions: [runningSession("EXP-0002"), demoSession()], stepsPerTick: 1 });
    let fails = 3;
    let attempts = 0;
    await page.route(/\/api\/v1\/quality-scans\/exp-2\/cancel$/, (route) => {
      attempts++;
      if (fails > 0) {
        fails--;
        return route.abort("internetdisconnected");
      }
      return route.fallback();
    });
    await page.goto(EXP("EXP-0002"));
    await page.getByRole("button", { name: "Stop now" }).click();
    await page.getByRole("dialog", { name: "Stop EXP-0002 now?" }).getByRole("button", { name: "Stop now" }).click();
    await expect(page.getByText("Connection lost. Reconnecting… the session keeps running on the server.")).toBeVisible();
    // Stop now stays enabled while reconnecting (design §9.5); press it again.
    await page.getByRole("button", { name: /Stop now|Stopping/ }).first().click();
    const dlg = page.getByRole("dialog", { name: "Stop EXP-0002 now?" });
    if (await dlg.isVisible().catch(() => false)) await dlg.getByRole("button", { name: "Stop now" }).click();
    await expect(page.getByRole("paragraph").filter({ hasText: /^Stopped by .* after \d+ actions/ })).toBeVisible({ timeout: 12000 });
    await page.waitForTimeout(4500);
    console.log("cancel attempts:", attempts, "succeeded:", q.requests.filter((r) => r.path === "/quality-scans/exp-2/cancel").length);
    expect(q.requests.filter((r) => r.path === "/quality-scans/exp-2/cancel").length).toBe(1);
  });
  test("viewer: ?new=1 opens no dialog, no 'Explore pages…' in the header menu, Settings › Limits is read-only", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false });
    await page.goto(`${TAB}&new=1`);
    await expect(page.getByRole("table", { name: "Exploratory sessions" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const more = page.getByRole("button", { name: "More project actions" });
    if (await more.count()) {
      await more.click();
      await expect(page.getByRole("menuitem", { name: "Explore pages…" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await page.goto("/settings/load-limits");
    await expect(page.getByRole("heading", { name: "Exploratory sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save exploration limits" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Actions per session" })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });
});
