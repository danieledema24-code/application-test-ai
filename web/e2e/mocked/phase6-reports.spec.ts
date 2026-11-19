// Phase 6 reports (P6-05c, D34; design P6 §11, §19) against the stubbed API (./fixtures.ts + the phase 2–4 and 6
// fixtures + ./phase6-release-fixtures.ts + ./phase6-reports-fixtures.ts, test-only). The Release readiness card at
// the top of Reports, one Release Readiness Report per assessment with older ones under "Earlier", the DRAFT band,
// the Download menu (no DOCX, no JSON), the Generate Test Completion Report dialog (lessons learned by a person or
// labelled AI), 409 before any assessment, viewers, keyboard, axe and 375 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { mockRelease, newRelease, type ReleaseState } from "./phase6-release-fixtures";
import { AI_LESSONS, AI_TOKEN, DRAFT_BAND, STATEMENT, mockReports, newReports, type ReportsState } from "./phase6-reports-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, over: Partial<ReleaseState> = {}, reports: Partial<ReportsState> = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
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
const p6Table = (page: Page) => page.getByRole("table", { name: "Release readiness and test completion reports" });

test.describe("Phase 6 · reports (P6-05c)", () => {
  test("Reports: Release readiness card first; one Release Readiness Report per assessment, REL-0001 under Earlier; menu without DOCX (§11.1, §11.3)", async ({ page }) => {
    await setup(page);
    await page.goto(REPORTS);
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    // The card is the first thing after the heading.
    const glance = page.getByRole("region", { name: "Release readiness", exact: true });
    await expect(glance).toBeVisible();
    const order = await page.evaluate(() => {
      const card = document.getElementById("release-glance-heading")!;
      const discovery = [...document.querySelectorAll("h2,h3")].find((h) => h.textContent?.includes("Application Discovery Report"))!;
      return card.compareDocumentPosition(discovery) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    await expect(page.getByText(/Phase 6/)).toHaveCount(0);
    const table = p6Table(page);
    const rr = table.getByRole("row", { name: /Release Readiness Report/ });
    await expect(rr.getByRole("cell").nth(0)).toHaveText("Version 2 · REL-0002");
    await expect(rr.getByText("Draft · Gate 9 not decided")).toBeVisible();
    await expect(rr.getByRole("link", { name: "Release Readiness Report" })).toHaveAttribute("href", "/projects/p1/reports/release-readiness");
    await expect(table.getByRole("row", { name: /Test Completion Report/ }).getByText("No version yet")).toBeVisible();
    await page.getByRole("button", { name: /Release Readiness Report: earlier \(1\)/ }).click();
    await expect(page.getByRole("link", { name: "Version 1 · REL-0001" })).toHaveAttribute("href", "/projects/p1/reports/release-readiness?version=1");
    // Download menu: PDF · HTML · CSV · XLSX; the CSV names its sections; no DOCX or JSON.
    await rr.getByRole("button", { name: "Download Release Readiness Report version 2" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([/^PDF/, /^HTML \(single file\)/, /^CSV \(spreadsheet\)Summary, criteria, conditions and residual risk, one section each\./, /^XLSX/]);
    await expect(menu.getByText(/DOCX|JSON|Word/)).toHaveCount(0);
    const download = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: /^XLSX/ }).click();
    expect((await download).suggestedFilename()).toMatch(/^localhost-release-readiness-REL-0002-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(await axe(page)).toEqual([]);
  });

  test("Release Readiness Report: DRAFT band, statement first, verdict, Gate 9 line, conditions, criteria with evidence and confirmations; REL-0001 final has no band (§11.2)", async ({ page }) => {
    await setup(page);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByRole("heading", { level: 1, name: "Release Readiness Report" })).toBeVisible();
    await expect(page).toHaveTitle(/^Release Readiness Report · /);
    await expect(page.getByText(DRAFT_BAND, { exact: true })).toBeVisible();
    const article = page.getByRole("article");
    // The statement comes first, before the verdict.
    const text = (await article.textContent()) ?? "";
    expect(text.indexOf(STATEMENT)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(STATEMENT)).toBeLessThan(text.indexOf("Conditional · Recommended"));
    await expect(article.getByRole("heading", { name: "Recommendation" })).toBeVisible();
    await expect(article.getByText("Conditional · Recommended")).toBeVisible();
    await expect(article.getByText("Gate 9: waiting for a decision by someone who can approve.")).toBeVisible();
    await expect(article.getByRole("heading", { name: "Conditions (2)" })).toBeVisible();
    const criteria = article.getByRole("table", { name: "Criteria (3)" });
    await expect(criteria.getByRole("row", { name: /Impacted tests re-run/ }).getByRole("cell").last()).toHaveText("CHG-0001");
    await expect(criteria.getByText("Confirmed by M. Member: 'Signed off in the release meeting'")).toBeVisible();
    await expect(article.getByRole("heading", { name: "What changed since REL-0001" })).toBeVisible();
    await expect(article.getByText("No Word (DOCX) export.")).toBeVisible();
    // The content is computed from project data, whether AI is on or off.
    await expect(article.getByText("Computed from project data").first()).toBeVisible();
    await expect(article.getByText("Generated by rules (AI not configured)")).toHaveCount(0);
    await expect(page.getByText(/@/)).toHaveCount(0);
    expect(await axe(page)).toEqual([]);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/^localhost-release-readiness-REL-0002-\d{4}-\d{2}-\d{2}\.pdf$/);

    await page.getByLabel("Version").selectOption("1");
    await expect(page).toHaveURL(/version=1/);
    await expect(page.getByRole("article").getByText("No-go · Final")).toBeVisible();
    await expect(page.getByRole("article").getByRole("heading", { name: "Final verdict" })).toBeVisible();
    await expect(page.getByText(/^DRAFT:/)).toHaveCount(0);
    await expect(page.getByText("Decided by A. Approver, 14 Nov 2026, 09:30 UTC").first()).toBeVisible();
  });

  test("Generate Test Completion Report: AI suggestion kept unedited is labelled; the report shows measures, deviations and the empty exploratory state (§11.1, §11.2)", async ({ page }) => {
    const r = await setup(page, {}, { aiOn: true });
    await page.goto(REPORTS);
    const row = p6Table(page).getByRole("row", { name: /Test Completion Report/ });
    await row.getByRole("button", { name: "Generate… Test Completion Report" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Test Completion Report" });
    await expect(dialog.getByRole("radio", { name: /REL-0002 · .* \(recommended: matches the release decision\)/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Current data, not tied to an assessment" })).not.toBeChecked();
    await expect(dialog.getByText("Shown in the report as written by Daniele Edema. The report is frozen when it’s generated.")).toBeVisible();
    await dialog.getByRole("button", { name: "Suggest lessons learned" }).click();
    await expect(dialog.getByLabel(/Lessons learned/)).toHaveValue(AI_LESSONS);
    await expect(dialog.getByText(/AI/).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText("Test Completion Report generated.")).toBeVisible();
    await expect(dialog).toBeHidden();
    const post = r.requests.find((x) => x.method === "POST" && x.path === "/projects/p1/reports");
    expect(post?.body).toEqual({ report_type: "completion", run_key: "REL-0002", lessons_learned: AI_LESSONS, lessons_generated_by: "ai", lessons_token: AI_TOKEN });

    await page.goto(`${REPORTS}/completion`);
    const article = page.getByRole("article");
    await expect(article.getByText("Approved but never executed: TC-0031 (manual)")).toBeVisible();
    await expect(article.getByRole("table", { name: "Test measures" }).getByRole("row", { name: /^All/ }).getByRole("cell").nth(2)).toHaveText("9");
    await expect(article.getByText("No exploratory session has run.")).toBeVisible();
    await expect(article.getByText("Suggested by AI and kept by Daniele Edema; not edited.")).toBeVisible();
    await expect(article.getByText("No Word (DOCX) export.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("Generate from current data with lessons a person wrote; keyboard only; Escape returns focus (§11.1)", async ({ page }) => {
    const r = await setup(page, { role: "member", canApprove: false });
    await page.goto(`${REPORTS}/completion`);
    await expect(page.getByText("No Test Completion Report yet.", { exact: true })).toBeVisible();
    const open = page.getByRole("button", { name: "Generate…" }).first();
    await open.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Generate Test Completion Report" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Suggest lessons learned" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    await page.keyboard.press("Enter");
    await dialog.getByRole("radio", { name: "Current data, not tied to an assessment" }).check();
    await dialog.getByLabel(/Lessons learned/).fill("Book the manual re-tests before the change lands.");
    await dialog.getByRole("button", { name: "Generate" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Test Completion Report generated.")).toBeVisible();
    const post = r.requests.find((x) => x.method === "POST" && x.path === "/projects/p1/reports");
    expect(post?.body).toEqual({ report_type: "completion", basis: "current", lessons_learned: "Book the manual re-tests before the change lands.", lessons_generated_by: "person" });
    await expect(page.getByRole("article").getByText("Written by Daniele Edema.")).toBeVisible();
    await expect(page.getByText("From current data")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    expect((await download).suggestedFilename()).toMatch(/^localhost-test-completion-current-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test("right after a Gate 9 decision the new version is being prepared: no duplicate Generate again", async ({ page }) => {
    const base = newReports();
    base.reports = [
      { ...base.reports[0], id: "rr3", version: 3, status: "rendering" },
      ...base.reports.map((x) => (x.id === "rr2" ? { ...x, is_latest_source: false } : x)),
    ];
    await setup(page, {}, base);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByText("A new version for REL-0002 is being prepared. It appears here when it’s ready.")).toBeVisible();
    await expect(page.getByText(/changed after this version was generated/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Generate again/ })).toHaveCount(0);
  });

  test("before any assessment: 'Not available yet' on both rows and verbatim on the report pages (§11.3)", async ({ page }) => {
    await setup(page, { assessments: [] }, { assessed: false });
    await page.goto(REPORTS);
    const table = p6Table(page);
    await expect(table.getByText("Not available yet · Assess release readiness first")).toHaveCount(2);
    await expect(table.getByRole("button", { name: /Generate/ })).toHaveCount(0);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByText("Not available yet: assess release readiness first", { exact: true })).toBeVisible();
    await page.goto(`${REPORTS}/completion`);
    await expect(page.getByText("Not available yet: assess release readiness first", { exact: true })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("viewer reads and downloads but can't generate", async ({ page }) => {
    await setup(page, { role: "viewer", canApprove: false });
    await page.goto(REPORTS);
    await expect(p6Table(page).getByRole("button", { name: /Generate/ })).toHaveCount(0);
    await expect(p6Table(page).getByRole("button", { name: "Download Release Readiness Report version 2" })).toBeVisible();
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByText(DRAFT_BAND, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Generate/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
  });

  test("375 px: Reports, both report pages and the dialog without sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(REPORTS);
    await expect(p6Table(page)).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto(`${REPORTS}/release-readiness`);
    await expect(page.getByText(DRAFT_BAND, { exact: true })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.goto(`${REPORTS}/completion`);
    await page.getByRole("button", { name: "Generate…" }).first().click();
    await expect(page.getByRole("dialog", { name: "Generate Test Completion Report" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await axe(page)).toEqual([]);
  });
});
