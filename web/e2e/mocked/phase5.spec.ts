// Phase 5 Non-functional: accessibility, passive security, load profiles, load test approval/live/results, load limits
// and the Gate 8 additions, against the stubbed API (./fixtures.ts + phase 2–4 fixtures + ./phase5-fixtures.ts,
// test-only). Each test names the design checks (docs/design/P5-qa-analyst-phase5.md §21) it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { API } from "./fixtures";
import { abortedRun, failedRun, mockPhase5, newP5, runningRun, SEC_STATEMENT, waitingRun, A11Y_STATEMENT, type P5State } from "./phase5-fixtures";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
const reply = (body: unknown) => ({ status: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ref = (type: string, key: string, label = key) => ({ type, id: key, key, label, path: `/projects/p1/traceability/${key}` });

async function axe(page: Page) {
  // Pages set document.title in an effect; axe's document-title rule must not run before it (QA P5 round 2).
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<P5State> = {}, extra?: (q: P5State) => void) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const q = newP5(over);
  extra?.(q);
  const exec = newExec({ role: q.role, canApprove: q.canApprove });
  // Gate 8: the first draft is an accessibility draft (design P5 §10).
  Object.assign(exec.defects[0], { source: "accessibility", summary: "Product images have no text alternative (2 pages)", why: "axe rule image-alt failed on /products/1, /products/2 (2 elements). · A11Y-0001", cases: [] });
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role });
  const p3 = newP3({ designed: true, g5: "approved", canApprove: q.canApprove });
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, p3);
  await mockPhase4(page, s, p4);
  await mockExec(page, exec);
  await mockPhase5(page, q, p4);
  await signedIn(page, s);
  return { q, exec };
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** For the failure message: the innermost elements that stick out past the right edge. */
const overflowing = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5 && ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 0.5))
      .filter((el) => !el.closest("[class*=overflow-x-auto]"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} "${(el.textContent ?? "").trim().slice(0, 40)}"`)
      .join(" | "),
  );
const NF = "/projects/p1/non-functional";

test.describe("Phase 5 · navigation and overview", () => {
  test("sidebar shows Non-functional built; /performance redirects to the Performance tab (check 1)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/performance");
    await expect(page).toHaveURL(/\/projects\/p1\/non-functional\?tab=performance$/);
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link")).toHaveCount(12);
    await expect(nav.getByRole("link", { name: /^Non-functional/ })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /coming in Phase/ })).toHaveCount(0);
    await expect(page.getByText(/Coming in Phase 5/i)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Performance" })).toHaveAttribute("aria-selected", "true");
    expect(await axe(page)).toEqual([]);
  });

  test("before Gate 2: 'Approve Gate 2 first' and no tabs (check 2)", async ({ page }) => {
    await setup(page, { g2: false, g4: false });
    await page.goto(NF);
    await expect(page.getByText("Non-functional checks use the pages discovery found. Approve Gate 2 first.")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Review Gate 2" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("approver sees the Approve badge and a Review link for the waiting load test (check 4)", async ({ page }) => {
    await setup(page, {}, (q) => q.runs.unshift(waitingRun()));
    await page.goto(`${NF}?tab=performance`);
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Non-functional, 1 load test waiting for your approval" })).toBeVisible();
    await expect(page.getByText("PERF-0002 is waiting for your approval")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review PERF-0002" })).toBeVisible();
  });

  test("member sees 'Waiting' and an Open link instead of Review (check 4)", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false }, (q) => q.runs.unshift(waitingRun()));
    await page.goto(`${NF}?tab=performance`);
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link", { name: "Non-functional, a load test is waiting for approval" })).toBeVisible();
    await expect(page.getByText("PERF-0002 is waiting for approval by someone who can approve")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open PERF-0002" })).toBeVisible();
  });
});

test.describe("Phase 5 · accessibility", () => {
  test("start dialog defaults: all pages, Desktop and keyboard on, Phone off, signed-in disabled without credentials (check 6)", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto(`${NF}?tab=accessibility`);
    await expect(page.getByText(A11Y_STATEMENT)).toBeVisible();
    await page.getByRole("button", { name: "Check accessibility…" }).click();
    const dialog = page.getByRole("dialog", { name: "Check accessibility" });
    await expect(dialog.getByText("All discovered pages (6)")).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /^Desktop/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Phone/ })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Follow keyboard focus/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Include pages behind sign-in/ })).toBeDisabled();
    await expect(dialog.getByText("Save test credentials to include these pages.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Start check" }).click();
    await expect(page).toHaveURL(/\/non-functional\/checks\/A11Y-0002$/);
    expect(q.requests.find((r) => r.path === "/projects/p1/accessibility-scans")?.body).toMatchObject({ viewports: ["desktop"], keyboard: true, signed_in: false });
  });

  test("By rule: image-alt Critical and color-contrast Serious on 2 pages, statement and linked drafts (check 7)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/checks/A11Y-0001`);
    await expect(page.getByRole("heading", { level: 1, name: /A11Y-0001 · Accessibility check/ })).toBeVisible();
    await expect(page.getByText(A11Y_STATEMENT)).toBeVisible();
    const table = page.getByRole("table", { name: "Findings by rule" });
    const img = table.getByRole("row", { name: /image-alt/ });
    await expect(img).toContainText("Critical");
    await expect(img).toContainText("2 pages");
    await expect(img).toContainText("1.1.1");
    const contrast = table.getByRole("row", { name: /color-contrast/ });
    await expect(contrast).toContainText("Serious");
    await expect(contrast).toContainText("2 pages");
    await expect(contrast).toContainText("1.4.3");
    await expect(page.getByRole("link", { name: "DEF-0004" })).toHaveAttribute("href", "/projects/p1/defects/DEF-0004");
    await expect(page.getByRole("link", { name: "DEF-0005" })).toBeVisible();
    // Needs review is kept apart and never counted.
    await expect(table.getByRole("row", { name: /region/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Needs review (1)" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("finding drawer: numbered element, screenshot alt names it, How to fix with its source (check 8)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/checks/A11Y-0001?finding=A11Y-0001-01`);
    const drawer = page.getByRole("dialog", { name: /A11Y-0001-01/ });
    await expect(drawer.getByRole("heading", { name: "Elements (1)" })).toBeVisible();
    await expect(drawer.getByRole("listitem").filter({ hasText: "img.product-image" })).toContainText(/^1\s*img\.product-image/);
    await expect(drawer.getByRole("img")).toHaveAttribute("alt", /img\.product-image/);
    await expect(drawer.getByRole("heading", { name: "How to fix" })).toBeVisible();
    await expect(drawer.getByText("(From axe-core)")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("triage needs a reason; then the status reads Accepted risk (check 9)", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto(`${NF}/checks/A11Y-0001?finding=A11Y-0001-01`);
    await page.getByRole("button", { name: "Accept risk or mark false positive for A11Y-0001-01" }).click();
    const dialog = page.getByRole("dialog", { name: /Accept risk or mark false positive · A11Y-0001-01/ });
    await dialog.getByRole("radio", { name: /Accept the risk/ }).check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Say why. The reason is shown in reports.")).toBeVisible();
    expect(q.requests.filter((r) => r.path.endsWith("/triage"))).toHaveLength(0);
    await dialog.getByLabel("Reason").fill("Decorative product shots, replaced next sprint");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("A11Y-0001-01 marked as accepted risk.")).toBeVisible();
    const drawer = page.getByRole("dialog", { name: /A11Y-0001-01/ });
    await expect(drawer.getByText("Accepted risk").first()).toBeVisible();
    await expect(drawer.getByText(/Decorative product shots, replaced next sprint/)).toBeVisible();
  });

  test("keyboard results carry the Heuristic label and never a draft (check 11)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/checks/A11Y-0001?view=keyboard`);
    await expect(page.getByRole("heading", { name: /Keyboard checks \(heuristic\)/ })).toBeVisible();
    const table = page.getByRole("table", { name: "Keyboard checks" });
    await expect(table.getByRole("row", { name: /\/contact/ })).toContainText("✗ 1 without outline");
    await expect(page.getByText("Keyboard checks don't create defect drafts automatically. Raise one if a person confirms it.")).toBeVisible();
    await page.getByRole("button", { name: "Show focus order for /", exact: true }).click();
    await expect(page.getByText('Link "Products"')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 5 · security", () => {
  test("the statement comes first on the Security tab, and the run starts without approval (checks 12, 14)", async ({ page }) => {
    const { q } = await setup(page, { role: "member", canApprove: false });
    await page.goto(`${NF}?tab=security`);
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("heading", { level: 2, name: "Security (passive)" })).toBeVisible();
    const firstText = await panel.evaluate((el) => {
      const h = el.querySelector("h2");
      let n = h?.nextElementSibling;
      while (n && !n.textContent?.trim()) n = n.nextElementSibling;
      return n?.textContent?.trim() ?? "";
    });
    expect(firstText).toContain(SEC_STATEMENT);
    await page.getByRole("button", { name: "Run security check" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/checks\/SEC-0002$/);
    expect(q.requests.find((r) => r.path === "/projects/p1/security-assessments")).toBeTruthy();
    expect(q.requests.filter((r) => r.path.includes("raise-defect"))).toHaveLength(0);
  });

  test("demo result: failed rules with page counts, loopback N/A, no HttpOnly finding (check 13)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/checks/SEC-0001`);
    await expect(page.getByText(SEC_STATEMENT)).toBeVisible();
    await expect(page.getByText("Content-Security-Policy missing")).toBeVisible();
    await expect(page.getByText("6 of 6 pages").first()).toBeVisible();
    await expect(page.getByText("Pages served over HTTPS")).toBeVisible();
    await expect(page.getByText("The target is plain http on this computer (loopback)").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Details for/ })).toHaveCount(4);
    await expect(page.getByText(/HttpOnly/)).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("raise defect makes one draft for the rule; a cookie finding never shows a value (checks 14, 15)", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto(`${NF}/checks/SEC-0001?finding=SEC-0001-04`);
    const cookie = page.getByRole("dialog", { name: /SEC-0001-04/ });
    await expect(cookie.getByLabel("Observed value")).toHaveText("recently_viewed · Path=/ · no HttpOnly · no Secure · no SameSite");
    await expect(cookie.getByText("Cookie values are never stored.")).toBeVisible();
    expect(await page.content()).not.toMatch(/recently_viewed=/);
    await page.goto(`${NF}/checks/SEC-0001?finding=SEC-0001-01`);
    const drawer = page.getByRole("dialog", { name: /SEC-0001-01/ });
    await expect(drawer.getByText("Pages (6): / · /products · /products/1 · /products/2 · /about · /contact")).toBeVisible();
    await drawer.getByRole("button", { name: "Raise defect for Content-Security-Policy missing" }).click();
    await page.getByRole("dialog", { name: /Raise a defect for csp-missing/ }).getByRole("button", { name: "Raise defect" }).click();
    await expect(page.getByText("DEF-0007 created as a draft.")).toBeVisible();
    expect(q.requests.filter((r) => r.path.endsWith("/raise-defect"))).toHaveLength(1);
  });
});

test.describe("Phase 5 · load profiles", () => {
  test("users above the ceiling: field error and Request disabled with the reason (check 16)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/profiles/PRF-01`);
    await expect(page.getByRole("heading", { level: 1, name: "PRF-01 · Load test of public pages" })).toBeVisible();
    await page.getByLabel("Users at end of stage 2").fill("30");
    await expect(page.getByText("Your organisation allows up to 20 virtual users.")).toBeVisible();
    const request = page.getByRole("button", { name: "Request load test…" });
    await expect(request).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("PRF-01 is over your organisation's limits. Edit it first.")).toBeVisible();
    await request.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("requirement thresholds are locked; defaults say so; k6 script says Not run by the platform (checks 17, 26)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/profiles/PRF-01`);
    const t = page.getByRole("table", { name: "Thresholds" });
    await expect(t.getByRole("row", { name: /\/products\/2/ })).toContainText("From REQ-0012");
    await expect(t.getByText("Locked: comes from a requirement. It can be tightened, not loosened.")).toBeVisible();
    await expect(t.getByText("Default threshold (no requirement states one)").first()).toBeVisible();
    await expect(t.getByRole("button", { name: /Remove/ })).toHaveCount(0);
    await expect(page.getByText("Not run by the platform. Run it yourself with k6 if you use it.")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download k6 script for PRF-01" }).click();
    expect((await download).suggestedFilename()).toBe("PRF-01-v2-k6.js");
    expect(await axe(page)).toEqual([]);
  });

  test("member request: exact summary, limits table, then Waiting for approval (check 18)", async ({ page }) => {
    const { q } = await setup(page, { role: "member", canApprove: false });
    await page.goto(`${NF}/profiles/PRF-01`);
    await page.getByRole("button", { name: "Request load test…" }).click();
    const dialog = page.getByRole("dialog", { name: "Request a load test · PRF-01 v2" });
    await expect(dialog.getByTestId("load-summary")).toHaveText(
      "Up to 10 virtual users, at most 20 requests a second, for 2 minutes 10 seconds, against localhost:4100; GET only; not signed in.",
    );
    await expect(dialog.getByRole("textbox", { name: /Type localhost/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Request approval" }).click();
    await expect(page).toHaveURL(/\/load-tests\/PERF-0005$/);
    await expect(page.getByText("Waiting for approval by someone who can approve", { exact: true })).toBeVisible();
    const sent = q.requests.find((r) => r.path === "/projects/p1/performance-runs" && r.method === "POST");
    expect(sent?.body).toMatchObject({ profile_id: "prf-1" });
    expect((sent?.body as { approve?: boolean }).approve).toBeFalsy();
  });
});

test.describe("Phase 5 · load test approval, live view and results", () => {
  test("approver: typed host gates Approve; wrong host and empty refusal show errors (check 19)", async ({ page }) => {
    const { q } = await setup(page, {}, (s) => s.runs.unshift(waitingRun()));
    await page.goto(`${NF}/load-tests/PERF-0002`);
    const panel = page.getByRole("region", { name: /Approve load test PERF-0002/ });
    const approve = panel.getByRole("button", { name: "Approve and start load test" });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(panel.getByText("Type localhost to approve.")).toBeVisible();
    await panel.getByRole("button", { name: "Don't approve…" }).click();
    await expect(panel.getByText("Say why this load test shouldn't run.")).toBeVisible();
    await panel.getByLabel("Type localhost to approve").fill("localhst");
    await approve.click({ force: true });
    await expect(panel.getByText("Type localhost exactly to approve.")).toBeVisible();
    expect(q.requests.filter((r) => r.path.endsWith("/decision"))).toHaveLength(0);
    expect(await axe(page)).toEqual([]);
    await panel.getByLabel("Type localhost to approve").fill("localhost");
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await approve.click();
    await expect(page.getByText("PERF-0002 approved and starting.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/decision"))?.body).toMatchObject({ decision: "approve", confirm_text: "localhost" });
  });

  test("member sees no enabled Approve control and the permission note; viewer sees no buttons (check 20)", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false }, (s) => s.runs.unshift(waitingRun({ requested_by: { id: "m", full_name: "M. Member" } })));
    await page.goto(`${NF}/load-tests/PERF-0002`);
    const panel = page.getByRole("region", { name: /Approve load test PERF-0002/ });
    await expect(panel.getByText("Waiting for approval by someone who can approve")).toBeVisible();
    await expect(panel.getByText("Approving load tests needs approval permission. Someone who can approve will see this request.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Approve and start load test" })).toHaveCount(0);
  });

  test("viewer: no buttons on a waiting load test (check 20)", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false }, (s) => s.runs.unshift(waitingRun({ requested_by: { id: "m", full_name: "M. Member" } })));
    await page.goto(`${NF}/load-tests/PERF-0002`);
    await expect(page.getByRole("heading", { level: 1, name: /PERF-0002/ })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: /Approve|Don't approve|Withdraw|Stop/ })).toHaveCount(0);
  });

  test("Stop now by keyboard: confirm focuses Stop now; result reads Stopped by the person (check 23)", async ({ page }) => {
    const { q } = await setup(page, {}, (s) => s.runs.unshift(runningRun()));
    await page.goto(`${NF}/load-tests/PERF-0003`);
    await expect(page.getByText("Virtual users")).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop now" });
    await stop.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Stop PERF-0003 now?" });
    await expect(dialog.getByRole("button", { name: "Stop now" })).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Stopped by Daniele Edema/).first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole("button", { name: /Pause updates/ })).toHaveCount(0);
    expect(q.requests.filter((r) => r.path.endsWith("/stop"))).toHaveLength(1);
  });

  test("kill switch: banner, Hypothesis causes, no draft (check 24)", async ({ page }) => {
    await setup(page, {}, (s) => s.runs.unshift(abortedRun()));
    await page.goto(`${NF}/load-tests/PERF-0004`);
    await expect(page.getByText("Stopped automatically: 100 % errors over 10 s.")).toBeVisible();
    await expect(page.getByText(/Possible causes/)).toBeVisible();
    await expect(page.getByText("Hypothesis").first()).toBeVisible();
    await expect(page.getByText("Not measured").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^DEF-/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test("demo result: Missed in text with measured p95, Met elsewhere, chart Table view, statement and engine (check 25)", async ({ page }) => {
    await setup(page);
    await page.goto(`${NF}/load-tests/PERF-0001`);
    const t = page.getByRole("table", { name: "Threshold results" });
    const missed = t.getByRole("row", { name: /\/products\/2/ });
    await expect(missed).toContainText("Missed");
    await expect(missed).toContainText("1.4 s");
    await expect(missed).toContainText("800 ms");
    await expect(t.getByRole("row", { name: /^\/ / }).first()).toContainText("Met");
    await expect(page.getByText(/Measured with the built-in load generator 0\.5\.0/)).toBeVisible();
    await expect(page.getByRole("link", { name: "DEF-0006" }).first()).toBeVisible();
    await page.getByRole("radio", { name: "Table" }).first().click();
    await expect(page.getByRole("table", { name: "Response time (p95) as a table" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 5 · Gate 8 and settings", () => {
  test("Gate 8: source chip, observed Why line, Accepted risk reason with an unchecked checkbox (check 27)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/defects?view=review");
    const gate = page.getByRole("region", { name: "Gate 8 · Defect review" });
    await expect(gate.getByText("Non-functional drafts state what was observed.", { exact: false })).toBeVisible();
    await expect(gate.getByText(/· Accessibility$/)).toBeVisible();
    await expect(gate.getByText("Why: axe rule image-alt failed on /products/1, /products/2 (2 elements). · A11Y-0001")).toBeVisible();
    await expect(gate.getByText("Hypothesis")).toHaveCount(0);
    await gate.getByRole("button", { name: "Reject DEF-0001…" }).click();
    const dialog = page.getByRole("dialog", { name: "Reject DEF-0001" });
    await dialog.getByRole("radio", { name: "Accepted risk" }).check();
    await expect(dialog.getByRole("checkbox", { name: "Also mark the findings as Accepted risk with this comment" })).not.toBeChecked();
    expect(await axe(page)).toEqual([]);
  });

  test("member: no Load limits link, and the URL shows the owner/admin message (check 34)", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false });
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "Load limits" })).toHaveCount(0);
    await page.goto("/settings/load-limits");
    await expect(page.getByText("Only owners and admins can see this page.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("owner above the hard cap: 'This server allows up to 50.' and nothing is saved (check 35)", async ({ page }) => {
    const { q } = await setup(page);
    await page.goto("/settings/load-limits");
    await page.getByLabel("Virtual users").fill("60");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("This server allows up to 50.").first()).toBeVisible();
    expect(q.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(await axe(page)).toEqual([]);
  });

  test("320 px: a load test watched live and then shown as results in place doesn't scroll sideways (check 44)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const { q } = await setup(page, {}, (s) => s.runs.unshift(runningRun()));
    await page.goto(`${NF}/load-tests/PERF-0003`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await sideways(page), await overflowing(page)).toBeLessThanOrEqual(0);
    // The run finishes while the page is open: the results replace the live view without a reload.
    const done = { ...failedRun(), key: "PERF-0003", id: q.runs[0].id };
    q.runs[0] = done;
    await expect(page.getByRole("region", { name: "Threshold results" }).or(page.getByText("Thresholds")).first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);
    expect(await sideways(page), await overflowing(page)).toBeLessThanOrEqual(0);
  });

  for (const [width, role] of [[375, "owner"], [320, "owner"], [320, "member"]] as const) {
    test(`${width} px (${role}): Non-functional pages don't scroll sideways (check 44)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await setup(page, { role, canApprove: role === "owner" }, (s) => s.runs.unshift(waitingRun()));
      for (const url of [`${NF}?tab=performance`, `${NF}?tab=security`, `${NF}/checks/A11Y-0001`, `${NF}/checks/SEC-0001`, `${NF}/profiles/PRF-01`, `${NF}/load-tests/PERF-0001`, `${NF}/load-tests/PERF-0002`]) {
        await page.goto(url);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(await sideways(page), `${url}: ${await overflowing(page)}`).toBeLessThanOrEqual(0);
      }
    });
  }
});

test.describe("Phase 5 · overview, lifecycle and header", () => {
  test("Overview: attention row with Review PERF-0002, Non-functional card as text, lifecycle rows and header pill (checks 4, 5)", async ({ page }) => {
    await setup(page, {}, (q) => q.runs.unshift(waitingRun()));
    await page.goto("/projects/p1");
    const row = page.getByRole("listitem").filter({ hasText: "PERF-0002 is waiting for your approval." });
    await expect(row.getByRole("link", { name: "Review PERF-0002" })).toHaveAttribute("href", "/projects/p1/non-functional/load-tests/PERF-0002");
    const card = page.locator("dl").filter({ has: page.getByText("Accessibility", { exact: true }) }).filter({ has: page.getByText("Performance", { exact: true }) });
    await expect(card.getByText(/^A11Y-0001 · .* rules? on \d+ of 6 pages/)).toBeVisible();
    await expect(card.getByText(/SEC-0001 · .* passive check, not a security audit/)).toBeVisible();
    await expect(card.getByText(/PERF-0001 · .* 1 of \d+ thresholds missed/)).toBeVisible();
    expect(await card.innerText()).not.toMatch(/%|score|grade/i);
    const optional = page.getByRole("region", { name: "Optional checks · any time after Gate 2" });
    await expect(optional.getByText("PERF-0002 waiting for your approval")).toBeVisible();
    await expect(optional.getByText(/^Done: \d+ open findings?$/).first()).toBeVisible();
    await expect(page.getByText("PERF-0002 waiting for your approval").first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("viewer: the waiting row is text only (check 4)", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false }, (q) => q.runs.unshift(waitingRun()));
    await page.goto("/projects/p1");
    const row = page.getByRole("listitem").filter({ hasText: "PERF-0002 is waiting for approval by someone who can approve." });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link")).toHaveCount(0);
  });

  test("before Gate 2 the optional rows read 'Available after Gate 2'; after it, 'Not run yet' and Reporting is Phase 6 (checks 2, 3)", async ({ page }) => {
    await setup(page, { g2: false, g4: false, scans: [], findings: [], runs: [] });
    await page.goto("/projects/p1");
    const optional = page.getByRole("region", { name: "Optional checks · any time after Gate 2" });
    await expect(optional.getByText("Available after Gate 2")).toHaveCount(3);
    await expect(optional.getByRole("link")).toHaveCount(0);
    await expect(page.getByText("Available after Gate 2.")).toBeVisible();
    await setup(page, { scans: [], findings: [], runs: [] });
    await page.goto("/projects/p1");
    await expect(page.getByRole("region", { name: "Optional checks · any time after Gate 2" }).getByText("Not run yet")).toHaveCount(3);
    await expect(page.getByText("Not checked yet.")).toHaveCount(3);
    await expect(page.getByRole("list", { name: "QA lifecycle" }).getByText("Phase 6").first()).toBeVisible();
  });
});

test.describe("Phase 5 · load test request states", () => {
  test("a profile edited after the request: can't be approved as made, with Request again (check 21)", async ({ page }) => {
    await setup(page, {}, (q) => q.runs.unshift(waitingRun({ problem: "PRF-01 changed after this request (version 2 now)", permissions: { can_approve: false, can_stop: false, can_withdraw: false, can_request_again: true } })));
    await page.goto(`${NF}/load-tests/PERF-0002`);
    await expect(page.getByText("This request can't be approved as it was made")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve and start load test" })).toHaveCount(0);
    await page.getByRole("link", { name: "Request again…" }).click();
    await expect(page).toHaveURL(/\/non-functional\/profiles\/PRF-01\?request=1$/);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("running: Pause updates freezes the tiles while load continues; reduced motion starts paused (check 22)", async ({ page }) => {
    const { q } = await setup(page, {}, (s) => s.runs.unshift(runningRun()));
    await page.goto(`${NF}/load-tests/PERF-0003`);
    await expect(page.getByText("18.4")).toBeVisible();
    await page.getByRole("button", { name: "Pause updates" }).click();
    await expect(page.getByText(/updates paused/)).toBeVisible();
    q.runs[0].live = { ...q.runs[0].live!, rps: 19.9 };
    await page.waitForTimeout(2500);
    await expect(page.getByText("18.4")).toBeVisible();
    await expect(page.getByText("19.9")).toHaveCount(0);
    await page.getByRole("button", { name: "Resume updates" }).click();
    await expect(page.getByText("19.9")).toBeVisible({ timeout: 3000 });
    expect(q.requests.filter((r) => r.path.endsWith("/stop"))).toHaveLength(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.getByRole("button", { name: "Resume updates" })).toBeVisible();
  });
});

test.describe("Phase 5 · defects, traceability, assistant and settings", () => {
  test("Defects list: Source filter offers the four sources and each row has a source chip (check 28)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/defects");
    const source = page.getByLabel("Source");
    await expect(source.locator("option")).toHaveText(["Any", "Functional", "Accessibility", "Security", "Performance"]);
    await expect(page.getByRole("table", { name: "Defects" }).getByText("Accessibility", { exact: true }).first()).toBeVisible();
    const req = page.waitForRequest((r) => r.url().includes("/projects/p1/defects?") && r.url().includes("source=accessibility"));
    await source.selectOption("accessibility");
    await req;
    await expect(page).toHaveURL(/source=accessibility/);
  });

  test("traceability: Non-functional cells in text and gap lists whose counts match coverage (check 31)", async ({ page }) => {
    await setup(page);
    const gaps = {
      requirements_without_test_cases: { none: [], none_approved: [] },
      test_cases_without_requirements: [],
      acceptance_criteria_without_test_cases: [],
      untested_high_risk: { open: [], accepted: [] },
      features_without_requirements: [],
      requirements_without_execution_evidence: { executed: true, automated_not_run: [], manual_only: [] },
      failed_tests: [],
      flaky_tests: [],
      outdated_automation_scripts: [],
      defects_without_regression_coverage: [],
      requirements_with_open_accessibility_findings: [{ requirement: ref("requirement", "REQ-0009", "Product images have text alternatives"), open: 2, by_severity: { critical: 1, serious: 1 }, findings: ["A11Y-0001-01", "A11Y-0001-02"], scan_key: "A11Y-0001" }],
      pages_not_checked_for_accessibility: [ref("page", "/account", "Account")],
      non_functional_requirements_without_evidence: [],
    };
    await page.route(`${API}/projects/p1/traceability**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/gaps")) return route.fulfill(reply(gaps));
      if (path.endsWith("/coverage"))
        return route.fulfill(
          reply({
            basis: "current",
            design_version: 2,
            snapshot_hash: null,
            requirements: { approved: 1, with_case: 1, with_approved_case: 1, percent_approved_covered: 100 },
            acceptance_criteria: { approved: 0, covered: 0, percent: 0 },
            high_risk_requirements: { total: 0, with_approved_case: 0 },
            techniques: [],
            test_cases: { by_status: { approved: 1 }, orphans: 0 },
            execution: { executed: true, requirements: { approved: 1, with_result: 1 }, results: { tests: 1, passed: 1, failed: 0, flaky: 0, error: 0, blocked: 0, skipped: 0 }, automation: { approved_cases: 1, with_valid_script: 1 } },
            non_functional: { requirements_with_open_accessibility_findings: 1, pages_not_checked_for_accessibility: 1, non_functional_requirements_without_evidence: 0 },
          }),
        );
      return route.fulfill(
        reply({
          next_cursor: null,
          items: [
            {
              requirement: ref("requirement", "REQ-0009", "Product images have text alternatives"),
              requirement_status: "approved",
              risk: null,
              acceptance_criteria: [],
              conditions: [],
              test_cases: [{ case: ref("test_case", "TC-0019"), status: "approved", priority: "high", script: null, result: null, defects: [] }],
              automation: [],
              results: [],
              defects: [],
              accessibility: { open: 2, by_severity: { critical: 1, serious: 1 }, findings: ["A11Y-0001-01", "A11Y-0001-02"], scan_key: "A11Y-0001" },
              security: { open: 1, findings: ["SEC-0001-01"], scan_key: "SEC-0001" },
              performance: { last_run: "PERF-0001", thresholds: 1, thresholds_failed: 1 },
            },
          ],
        }),
      );
    });
    await page.goto("/projects/p1/traceability");
    for (const [tile, n] of [["Open accessibility findings", 1], ["Pages not checked for accessibility", 1], ["Non-functional requirements without evidence", 0]] as const)
      await expect(page.getByRole("link", { name: new RegExp(`^${tile} ${n} `) })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Requirements with open accessibility findings (1)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pages not checked for accessibility (1)" })).toBeVisible();
    await page.getByRole("button", { name: "Non-functional requirements without evidence (0)" }).click();
    await expect(page.getByText("None. Every non-functional requirement has a check, run or finding.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.goto("/projects/p1/traceability?view=matrix");
    const matrix = page.getByRole("table", { name: /Forward traceability/ });
    await expect(matrix.getByRole("columnheader", { name: "Non-functional" })).toBeVisible();
    await expect(matrix.getByRole("link", { name: "Accessibility for REQ-0009: 2 open findings, 1 critical" })).toBeVisible();
    await expect(matrix.getByText("2 open (1 critical)")).toBeVisible();
    await expect(matrix.getByText("Open: 1")).toBeVisible();
    await expect(matrix.getByText("✗ Missed in PERF-0001")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("assistant v4: non-functional chips work without AI, Later phases are Phase 6 only, load test proposal is a request (check 32)", async ({ page }) => {
    await setup(page);
    const messages: unknown[] = [];
    // The thread is read with ?limit=50: match on the path so every reload returns the posted turn.
    await page.route((url) => url.pathname.endsWith("/assistant/threads/t1"), (route) => route.fulfill(reply({ id: "t1", title: "Plan a load test", created_at: "2026-11-13T14:20:00Z", messages })));
    await page.route(`${API}/assistant/threads/t1/messages`, (route) => {
      const body = route.request().postDataJSON() as { intent?: string };
      const base = { thread_id: "t1", citations: [], notices: [], answered_by: "intent", generated_by: "rules", created_at: "2026-11-13T14:20:00Z" };
      const proposal = {
        id: "prop9",
        key: "PROP-009",
        kind: "request_load_test",
        target: { type: "performance_profile", id: "prf-1", key: "PRF-01", label: "Load test", path: "/projects/p1/non-functional/profiles/PRF-01" },
        summary: "Run a load test with PRF-01: up to 10 virtual users, at most 20 requests a second, 2 min 10 s, against localhost:4100.",
        payload: { profile_key: "PRF-01" },
        preview: null,
        base_versions: {},
        status: "pending",
        generated_by: "rules",
        created_by: { id: "u", full_name: "Daniele Edema" },
        created_at: "2026-11-13T14:20:00Z",
        decided_by: null,
        decided_at: null,
        decision_comment: null,
        result: null,
      };
      const turn = {
        user_message: { ...base, id: "u9", role: "user", content: "Plan a load test", intent: body.intent ?? null, proposals: [] },
        reply: { ...base, id: "a9", role: "assistant", intent: body.intent ?? null, content: proposal.summary, proposals: [proposal] },
      };
      messages.push(turn.user_message, turn.reply);
      return route.fulfill(reply(turn));
    });
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    const noAi = tasks.locator("section").filter({ has: page.getByRole("heading", { name: "Works without AI" }) });
    for (const label of ["Is the site fast enough?", "Can everyone use the site?", "Is the site missing basic protections?", "Explain a finding", "Plan a load test"])
      await expect(noAi.getByRole("button", { name: new RegExp(label.replace(/[?]/g, "\\?")) })).toBeVisible();
    const later = tasks.locator("section").filter({ has: page.getByRole("heading", { name: "Later phases" }) });
    await expect(later.getByText("Release readiness and Test Completion Report")).toBeVisible();
    await expect(later.getByText("What changed since the last scan")).toBeVisible();
    await expect(later.getByText(/Phase [2-5]/)).toHaveCount(0);
    await noAi.getByRole("button", { name: /Plan a load test/ }).click();
    await noAi.getByRole("button", { name: "Propose a load test" }).click();
    const card = page.getByRole("region", { name: /Proposal · Create load test request/ });
    await expect(card.getByText(/the assistant can't approve load tests or start load/)).toBeVisible();
    // The new thread id lands in the URL after the answer; let that navigation and its title settle before axe.
    await expect(page).toHaveURL(/thread=t1/);
    await expect(page).toHaveTitle(/^AI QA Analyst · /);
    expect(await axe(page)).toEqual([]);
  });

  test("Settings › Organisation: proxy state and tools as text (check 39)", async ({ page }) => {
    await setup(page);
    await page.route(`${API}/health`, (route) =>
      route.fulfill(
        reply({
          status: "ok",
          db: true,
          worker: { mode: "inline", last_heartbeat_s: 1 },
          queue_depth: 0,
          ai: { enabled: false, provider: null, model: null },
          browser: { available: true },
          version: "test",
          egress_proxy: "off",
          tools: { loadgen: "0.5.0", axe: "4.14.0", k6: null, docker: null },
        }),
      ),
    );
    await page.goto("/settings");
    await expect(page.getByText("Network safety proxy")).toBeVisible();
    await expect(page.getByText("Off (development only): DNS tricks could reach internal services.")).toBeVisible();
    await expect(page.getByText("axe-core 4.14.0")).toBeVisible();
    await expect(page.getByText("built-in 0.5.0")).toBeVisible();
    await expect(page.getByText("Not installed · Not needed: the platform exports k6 scripts but doesn't run them")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("Phase 5 · audit log, retention, archive and delete", () => {
  test("load test page: occurrence link to the open defect, and the removed time series (P5-BUG-06, P5-BUG-08)", async ({ page }) => {
    const gone = "Removed by the retention policy on 14 Dec 2026.";
    await setup(page, {}, (q) => {
      const r = q.runs.find((x) => x.key === "PERF-0001")!;
      r.defects = [{ key: "DEF-0006", summary: "Desk lamp page slows down under load (p95 1.6 s with 10 users; threshold 800 ms)", status: "draft", link: "occurrence_added" }];
      r.timeseries = [];
      r.timeseries_removed = gone;
    });
    await page.goto(`${NF}/load-tests/PERF-0001`);
    await expect(page.getByText("Occurrence added to:")).toBeVisible();
    await expect(page.getByRole("link", { name: "DEF-0006" })).toHaveAttribute("href", "/projects/p1/defects/DEF-0006");
    await expect(page.getByText("Defect drafted:")).toHaveCount(0);
    await expect(page.getByTestId("removed-evidence")).toHaveText(gone);
    expect(await axe(page)).toEqual([]);
  });

  const entry = (i: number, over: Record<string, unknown> = {}) => ({
    id: `a${i}`,
    at: "2026-11-13T15:10:00Z",
    who: { name: "A. Approver", email: "a@example.com" },
    actor_type: "user",
    action: "performance_run.approved",
    label: "Approved a load test",
    project: { id: "p1", name: "acme.com" },
    details: "PERF-0002 · APR-0004 · host typed: yes",
    target_type: "performance_run",
    ...over,
  });

  test("owner: audit log filters, paging moves focus, export toast (check 36)", async ({ page }) => {
    await setup(page);
    const seen: string[] = [];
    await page.route(`${API}/organisations/*/audit-log**`, (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      seen.push(url.search);
      if (url.pathname.endsWith("/export"))
        return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "text/csv" }, body: "When,Who\r\n" });
      if (url.searchParams.get("group") === "Reports") return route.fulfill(reply({ items: [], total: 0, next_cursor: null, groups: ["Gates", "Reports"], export_limit: 100000 }));
      if (url.searchParams.get("cursor")) return route.fulfill(reply({ items: [entry(3, { action: "gate.approved", label: "Approved a gate", details: "" })], total: 3, next_cursor: null, groups: ["Gates", "Reports"], export_limit: 100000 }));
      return route.fulfill(reply({ items: [entry(1), entry(2)], total: 3, next_cursor: "Mg", groups: ["Gates", "Reports"], export_limit: 100000 }));
    });
    await page.goto("/settings");
    await page.getByRole("link", { name: "Audit log" }).click();
    await expect(page.getByRole("link", { name: "Audit log" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("3 entries match · newest first")).toBeVisible();
    await expect(page.getByRole("cell", { name: "PERF-0002 · APR-0004 · host typed: yes" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "A. Approver · a@example.com" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Show 50 more" }).click();
    await expect(page.getByRole("cell", { name: "Approved a gate" })).toBeVisible();
    await expect(page.getByRole("row").nth(3)).toBeFocused();
    await expect(page.getByRole("button", { name: "Show 50 more" })).toHaveCount(0);
    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByText("Export ready: 3 entries. The export itself is recorded in the audit log.")).toBeVisible();
    expect(seen.some((s) => s.includes("format=csv"))).toBe(true);
    await page.getByLabel("What").selectOption("Reports");
    await expect(page.getByText("No entries match these filters.")).toBeVisible();
    expect(seen.some((s) => s.includes("group=Reports"))).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page.getByText("3 entries match · newest first")).toBeVisible();
  });

  test("member: no Retention or Audit log links; the URL says who can see it (check 36)", async ({ page }) => {
    await setup(page, { role: "member", canApprove: false });
    for (const [path, what] of [["audit-log**", "the audit log"], ["retention", "retention"]])
      await page.route(`${API}/organisations/*/${path}`, (route) =>
        route.fulfill({ status: 403, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "forbidden", message: `Only owners and admins can see ${what}.` } }) }),
      );
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "Retention" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
    await page.goto("/settings/audit-log");
    await expect(page.getByText("Only owners and admins can see this page.")).toBeVisible();
    await page.goto("/settings/retention");
    await expect(page.getByText("Only owners and admins can see this page.")).toBeVisible();
  });

  test("retention: invalid days, shortening asks first, saved (check 37)", async ({ page }) => {
    await setup(page);
    const puts: unknown[] = [];
    const cur = { videos_traces_days: 30, screenshots_days: 90, timeseries_days: 90, saved: true, can_edit: true };
    await page.route(`${API}/organisations/*/retention`, (route) => {
      const m = route.request().method();
      if (m === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (m === "PUT") {
        const body = route.request().postDataJSON();
        puts.push(body);
        return route.fulfill(reply({ ...cur, ...body, message: "Retention saved." }));
      }
      return route.fulfill(reply(cur));
    });
    await page.goto("/settings/retention");
    await page.getByLabel("Screenshots (days)").fill("-3");
    await page.getByRole("button", { name: "Save retention" }).click();
    await expect(page.getByText("Enter a whole number of days (0 or more).")).toBeVisible();
    expect(puts).toHaveLength(0);
    await page.getByLabel("Screenshots (days)").fill("30");
    await page.getByRole("button", { name: "Save retention" }).click();
    const dialog = page.getByRole("dialog", { name: "Keep screenshots for 30 days instead of 90?" });
    await expect(dialog.getByText("Screenshots older than 30 days are removed at the next daily clean-up. This can't be undone.")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep 90 days" }).click();
    expect(puts).toHaveLength(0);
    await page.getByRole("button", { name: "Save retention" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Shorten to 30 days" }).click();
    await expect(page.getByText("Retention saved.")).toBeVisible();
    expect(puts).toEqual([{ videos_traces_days: 30, screenshots_days: 30, timeseries_days: 90 }]);
    expect(await axe(page)).toEqual([]);
  });

  test("archive and delete: admin sees Unarchive, but Delete is aria-disabled with the reason (check 38)", async ({ page }) => {
    const proj = project("p1", { status: "archived" });
    await setup(page, { role: "admin", canApprove: true });
    await page.route(`${API}/projects/p1`, (route) => (route.request().method() === "GET" ? route.fulfill(reply(proj)) : route.fallback()));
    await page.goto("/projects/p1/settings?view=archive");
    await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
    const del = page.getByRole("button", { name: "Delete project permanently…" });
    await expect(del).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Only the organisation owner can delete a project permanently.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await del.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("owner schedules deletion with the typed name, sees the callout and cancels (check 38)", async ({ page }) => {
    const proj = project("p1", { status: "archived" });
    await setup(page);
    await page.route(`${API}/projects/p1/purge`, (route) => {
      const m = route.request().method();
      if (m === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (m === "POST") {
        proj.purge_scheduled_at = new Date(2026, 10, 14, 16, 2).toISOString();
        return route.fulfill(reply({ purge_scheduled_at: proj.purge_scheduled_at, archived: true, message: "acme.com will be deleted on 14 Nov at 16:02." }));
      }
      proj.purge_scheduled_at = null;
      return route.fulfill(reply({ purge_scheduled_at: null, archived: true, message: "Deletion cancelled. Nothing was removed." }));
    });
    await page.route(`${API}/projects/p1`, (route) => (route.request().method() === "GET" ? route.fulfill(reply(proj)) : route.fallback()));
    await page.goto("/projects/p1/settings?view=archive");
    await page.getByRole("button", { name: "Delete project permanently…" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete acme.com permanently?" });
    const schedule = dialog.getByRole("button", { name: "Schedule deletion" });
    await expect(schedule).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("Type acme.com to confirm").fill("acme");
    await schedule.click({ force: true });
    await expect(dialog.getByText("Type the project name exactly to confirm.")).toBeVisible();
    await dialog.getByLabel("Type acme.com to confirm").fill("acme.com");
    await expect(schedule).not.toHaveAttribute("aria-disabled", "true");
    await schedule.click();
    await expect(page.getByText("acme.com will be deleted on 14 Nov at 16:02.")).toBeVisible();
    const callout = page.getByText("This project will be deleted permanently on 14 Nov at 16:02. Only the audit log will keep a record.").first();
    await expect(callout).toBeVisible();
    await page.goto("/projects/p1/defects");
    await expect(page.getByText("This project will be deleted permanently on 14 Nov at 16:02.", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    await expect(page.getByText("Deletion cancelled. Nothing was removed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel deletion" })).toHaveCount(0);
  });
});
