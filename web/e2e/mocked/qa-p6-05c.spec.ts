// QA (independent) for P6-05c reports (design P6 §11, §16, §19 checks 39–40) against the stubbed API. Probes the
// developer's spec doesn't: an AI suggestion that is edited loses its label and is sent as the person's text; an
// out-of-date Release Readiness Report says so and [Generate again] creates a new version; generate errors are shown
// verbatim and focused; content with markup renders as text; the release readiness page links both reports for its
// assessment; a deep link to an assessment without a completion report offers Generate; the dialog hint never shows an
// email; 375 px with long tables.
import { expect, test, type Page, type Route } from "@playwright/test";
import { API, mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { mockRelease, newRelease, type ReleaseState } from "./phase6-release-fixtures";
import { AI_LESSONS, mockReports, newReports, type ReportsState } from "./phase6-reports-fixtures";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const XSS = "<img src=x onerror=\"window.__xss=1\"><script>window.__xss=1</script>";

async function setup(page: Page, over: Partial<ReleaseState> = {}, reports: Partial<ReportsState> = {}, user?: { full_name: string; email: string }) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  if (user) s.user = { id: "u", ...user };
  const q = newRelease(over);
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }), newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, newExec({ role: q.role, canApprove: q.canApprove }));
  await mockRelease(page, s, q, p4);
  const r = newReports(reports);
  await mockReports(page, r);
  await signedIn(page, s);
  return r;
}

const REPORTS = "/projects/p1/reports";
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("QA · P6-05c reports", () => {
  test("an edited AI suggestion loses the AI label and is sent as the person's text", async ({ page }) => {
    const r = await setup(page, {}, { aiOn: true });
    await page.goto(`${REPORTS}/completion`);
    await page.getByRole("button", { name: "Generate…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate Test Completion Report" });
    await dialog.getByRole("button", { name: "Suggest lessons learned" }).click();
    const field = dialog.getByLabel(/Lessons learned/);
    await expect(field).toHaveValue(AI_LESSONS);
    await expect(dialog.getByText("AI-generated", { exact: true })).toBeVisible();
    await field.press("End");
    await field.type(" Edited.");
    // The label goes away once edited.
    await expect(dialog.getByText("AI-generated", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText("Test Completion Report generated.")).toBeVisible();
    const post = r.requests.find((x) => x.method === "POST" && x.path === "/projects/p1/reports");
    expect(post?.body).toEqual({ report_type: "completion", run_key: "REL-0002", lessons_learned: `${AI_LESSONS} Edited.`, lessons_generated_by: "person" });
    await expect(page.getByRole("article").getByText("Written by Daniele Edema.")).toBeVisible();
    await expect(page.getByRole("article").getByText(/Suggested by AI/)).toHaveCount(0);
  });

  test("an out-of-date Release Readiness Report says what changed and Generate again makes a new version", async ({ page }) => {
    const base = newReports();
    base.reports = base.reports.map((x) => (x.id === "rr2" ? { ...x, is_latest_source: false, approval: { ...x.approval!, band: "DRAFT: REL-0002 was replaced by REL-0003 and can't be decided." } as never } : x));
    const r = await setup(page, {}, base);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByText(/REL-0002 changed after this version was generated/)).toBeVisible();
    await page.getByRole("button", { name: "Generate again for REL-0002" }).click();
    await expect(page).toHaveURL(/version=3/);
    const post = r.requests.find((x) => x.method === "POST" && x.path === "/projects/p1/reports");
    expect(post?.body).toEqual({ report_type: "release_readiness", run_key: "REL-0002" });
    await expect(page.getByLabel("Version")).toHaveValue("3");
  });

  test("BUG probe: the out-of-date note has one full stop between the band and 'Generate it again'", async ({ page }) => {
    const base = newReports();
    base.reports = base.reports.map((x) => (x.id === "rr2" ? { ...x, is_latest_source: false, approval: { ...x.approval!, band: "DRAFT: REL-0002 was replaced by REL-0003 and can't be decided." } as never } : x));
    await setup(page, {}, base);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByText(/REL-0002 changed after this version was generated/)).toBeVisible();
    await expect(page.getByText(/decided\.\. Generate/)).toHaveCount(0);
  });

  test("a generate error is shown verbatim, announced and focused; the dialog stays open", async ({ page }) => {
    await setup(page);
    await page.route(`${API}/projects/p1/reports`, (route) =>
      route.request().method() === "POST" ? json(route, 422, { error: { code: "validation_failed", message: "Lessons learned are too long.", details: null } }) : route.fallback(),
    );
    await page.goto(`${REPORTS}/completion`);
    await page.getByRole("button", { name: "Generate…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate Test Completion Report" });
    await dialog.getByRole("button", { name: "Generate" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toHaveText("Couldn’t generate the report: Lessons learned are too long.");
    await expect(dialog).toBeVisible();
    await expect(page.locator(":focus")).toContainText("Couldn’t generate the report");
  });

  test("markup in report content renders as text, never as HTML", async ({ page }) => {
    const base = newReports();
    const c = base.contents.rr2 as Record<string, unknown>;
    base.contents.rr2 = { ...c, override_text: `Overridden by A. Approver: '${XSS}' (recommended: Conditional)`, reason: XSS, criteria: (c.criteria as Record<string, unknown>[]).map((x) => ({ ...x, text: `${x.text} ${XSS}` })) };
    await setup(page, {}, base);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByRole("article").getByText(XSS, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("article").locator("img[src=x], script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("release readiness page links both reports for the assessment shown; a completion deep link without a report offers Generate", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/release-readiness");
    const reports = page.getByRole("region", { name: "Reports" });
    await expect(reports.getByRole("link", { name: "Open Release Readiness Report" })).toHaveAttribute("href", "/projects/p1/reports/release-readiness?assessment=REL-0002");
    await expect(reports.getByRole("link", { name: "Open Test Completion Report" })).toHaveAttribute("href", "/projects/p1/reports/completion?assessment=REL-0002");
    await reports.getByRole("link", { name: "Open Test Completion Report" }).click();
    await expect(page.getByText("No Test Completion Report for REL-0002 yet.")).toBeVisible();
    await page.getByRole("button", { name: "Generate…" }).first().click();
    await expect(page.getByRole("dialog").getByRole("radio", { name: /^REL-0002 · / })).toBeChecked();
    // The REL-0001 deep link opens the REL-0001 Release Readiness Report.
    await page.goto(`${REPORTS}/release-readiness?assessment=REL-0001`);
    await expect(page.getByRole("article").getByText("No-go · Final")).toBeVisible();
  });

  test("the dialog hint never shows an email when the person has no name", async ({ page }) => {
    await setup(page, {}, {}, { full_name: "", email: "nameless@acme.test" });
    await page.goto(`${REPORTS}/completion`);
    await page.getByRole("button", { name: "Generate…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate Test Completion Report" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/@/)).toHaveCount(0);
  });

  test("375 px: a completion report with long tables and the readiness report don't scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(`${REPORTS}/completion`);
    await page.getByRole("button", { name: "Generate…" }).first().click();
    await page.getByRole("dialog").getByLabel(/Lessons learned/).fill("A".repeat(300));
    await page.getByRole("dialog").getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("table", { name: "Test measures" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByRole("table", { name: "Criteria (3)" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // Download buttons are at least 24 px tall.
    const box = await page.getByRole("button", { name: "Download PDF" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });
});
