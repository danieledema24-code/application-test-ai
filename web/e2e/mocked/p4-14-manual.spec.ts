// P4-14b record manual results against the stubbed API (./fixtures.ts + the phase 2–4 fixtures +
// ./p4-14-manual-fixtures.ts, test-only). Each test names the design checks (docs/design/P4-14-manual-results.md §10)
// it covers.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4, overview } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { MEMBER, SAVED_AT, SEEDED_AT, manualCases, manualRun, mockManual, mockTraceManual, newManual, seedResult, type ManualState } from "./p4-14-manual-fixtures";
import { mockPhase6, newP6 } from "./phase6-fixtures";
import { mockManualMustRun, mockRelease, newRelease } from "./phase6-release-fixtures";

// Long mocked flows (start, record, upload, finish) need more than the 30 s project default, in WebKit above all.
test.describe.configure({ timeout: 90_000 });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

/** The page's own date-time format (fmtDateTime, browser locale) for an ISO time from the server. */
const when = (page: Page, iso: string) => page.evaluate((i) => new Date(i).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), iso);

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function setup(page: Page, over: Partial<ManualState> = {}, seed?: (q: ManualState) => void, opts: { trace?: boolean } = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const q = newManual(over);
  seed?.(q);
  const role = q.role;
  const canApprove = role === "owner" || role === "admin";
  const exec = newExec({ role, canApprove });
  // G6 isn't satisfied (an invalid script): manual runs don't need it (check 1).
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role }), newP3({ designed: true, g5: "approved", canApprove, cases: manualCases() }));
  await mockPhase4(page, s, newP4({ role, canApprove, invalid: true }));
  await mockExec(page, exec);
  await mockManual(page, q, exec);
  if (opts.trace) await mockTraceManual(page);
  await signedIn(page, s);
  return { q, exec };
}

/** RUN-0005 recording TC-0027, TC-0033, TC-0040, TC-0041 (the four that need a person and have no result). */
const four = (q: ManualState) => manualRun(q, [27, 33, 40, 41]);
const card = (page: Page, k: string) => page.getByRole("region", { name: new RegExp(`^${k} `) });
const status = (page: Page) => page.locator('p[role="status"][aria-live="polite"]').last();

async function openStart(page: Page, url = "/projects/p1/execution") {
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
  await page.getByRole("button", { name: "Record manual results" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Record manual results" });
  await expect(dialog.getByRole("checkbox", { name: /TC-0027/ })).toBeVisible();
  return dialog;
}

test.describe("P4-14 · Start modal and entry points", () => {
  test("member before Gate 6 sees [Record manual results]; filter 'Needs a person' with the unrecorded ones pre-selected; 'All approved cases' lists all; script note; axe (checks 1, 2, 3)", async ({ page }) => {
    const { q } = await setup(page, {}, (q) => {
      // Already recording TC-0040 in RUN-0005 (open question 3: still selectable).
      manualRun(q, [40]);
    });
    const dialog = await openStart(page);
    await expect(dialog.getByText("You test the site yourself and record what happened. Nothing runs on the platform, so this doesn't need Gate 7.")).toBeVisible();
    await expect(dialog.getByText("You're already recording RUN-0005 (0 of 1 recorded).")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Continue RUN-0005" })).toBeVisible();
    const show = dialog.getByRole("radiogroup", { name: "Show" });
    await expect(show.getByRole("radio", { name: "Needs a person (5)" })).toHaveAttribute("aria-checked", "true");
    for (const k of ["TC-0027", "TC-0033", "TC-0040", "TC-0041"]) await expect(dialog.getByRole("checkbox", { name: new RegExp(`Select ${k}`) })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Select TC-0034/ })).not.toBeChecked();
    await expect(dialog.getByText("Needs a person · Last result: Passed · By hand, M. Member · 12 Nov")).toBeVisible();
    await expect(dialog.getByText("Also in RUN-0005 (recording)")).toBeVisible();
    await expect(dialog.getByText("4 selected (up to 100)")).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Select TC-0019/ })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);

    await show.getByRole("radio", { name: "All approved cases (6)" }).click();
    await expect(dialog.getByRole("list", { name: "Approved test cases" }).getByRole("listitem")).toHaveCount(6);
    await expect(status(page).or(dialog.getByRole("status"))).toHaveCount(1);
    await expect(dialog.getByRole("status")).toHaveText("Showing 6 cases.");
    const tc19 = dialog.getByRole("checkbox", { name: /Select TC-0019 Send the form with an empty Message/ });
    await expect(dialog.getByText("Can be automated · Last result: Failed · RUN-0003 · 13 Nov")).toBeVisible();
    // "Has a script" follows the scripts bundle, not suitability: TC-0040 needs a person but has a (failing) script;
    // TC-0027 has none; TC-0019's note appears once it is checked.
    const note = "Has a script. A result you record replaces its latest automated result.";
    const item = (k: string) => dialog.getByRole("listitem").filter({ has: page.getByRole("checkbox", { name: new RegExp(`Select ${k}`) }) });
    await expect(item("TC-0040").getByText(note)).toBeVisible();
    await expect(item("TC-0027").getByText(note)).toHaveCount(0);
    await expect(item("TC-0019").getByText(note)).toHaveCount(0);
    await tc19.check();
    await expect(item("TC-0019").getByText(note)).toBeVisible();
    // Selection survives the filter and the search.
    await dialog.getByRole("textbox", { name: "Find a case" }).fill("keyboard");
    await expect(dialog.getByRole("status")).toHaveText("Showing 1 case.");
    await dialog.getByRole("textbox", { name: "Find a case" }).fill("nothing like this");
    await expect(dialog.getByText("No approved case matches 'nothing like this'.")).toBeVisible();
    await dialog.getByRole("textbox", { name: "Find a case" }).fill("");
    await expect(dialog.getByRole("button", { name: "Start recording 5 cases" })).toBeVisible();
    expect(q.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  test("Overview: cases that need a person and have no result, from the bundle, or from the assessment before any bundle (§3)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1");
    // With a bundle: its not_automated list (TC-0027).
    await expect(page.getByText("1 approved case needs a person and has no recorded result.")).toBeVisible();
    // No bundle yet: the assessment's "Needs a person" cases without a passed or failed result (TC-0027, 33, 40, 41).
    await page.route("**/api/v1/projects/p1/automation", (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ ...overview(newP4()), bundle: null }) }) : route.fallback(),
    );
    await page.reload();
    await expect(page.getByText("4 approved cases need a person and have no recorded result.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Record manual results" }).first()).toHaveAttribute("href", "/projects/p1/execution?record=1");
  });

  test("'Record a manual result…' on TC-0019's case detail opens the modal with only TC-0019 selected (check 4)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1/test-cases/TC-0019");
    await page.getByRole("link", { name: "Record a manual result…" }).click();
    await expect(page).toHaveURL(/\/execution\?record=1&cases=TC-0019$/);
    const dialog = page.getByRole("dialog", { name: "Record manual results" });
    await expect(dialog.getByRole("checkbox", { name: /Select TC-0019/ })).toBeChecked();
    await expect(dialog.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "All approved cases (6)" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("1 selected (up to 100)")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Start recording 1 case" })).toBeVisible();
  });

  test("nothing selected: Start is unavailable with the reason; a create error is shown verbatim and focused (§6)", async ({ page }) => {
    await setup(page);
    const dialog = await openStart(page);
    // Mixed → all → none.
    const all = dialog.getByRole("checkbox", { name: "Select all shown (5)" });
    await all.click();
    await expect(all).toBeChecked();
    await all.click();
    await expect(all).not.toBeChecked();
    const start = dialog.getByRole("button", { name: "Start recording 0 cases" });
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await expect(dialog.getByText("Choose at least one case.")).toBeVisible();
    await start.click({ force: true });
    await expect(page).toHaveURL(/record=1/);
    // A server refusal: the message as sent, in an alert that takes focus.
    await page.route("**/api/v1/projects/p1/execution-runs", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 422, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "validation_error", message: "Only test cases approved at Gate 5 can be recorded: TC-0099.", details: null } }) })
        : route.fallback(),
    );
    await dialog.getByRole("checkbox", { name: /Select TC-0027/ }).check();
    await dialog.getByRole("button", { name: "Start recording 1 case" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Only test cases approved at Gate 5 can be recorded: TC-0099.");
    await expect(dialog.getByRole("alert").locator("..")).toBeFocused();
  });

  test("Automation, Traceability and the Overview link to the Start modal; viewers see none of the entry points (check 1)", async ({ page }) => {
    await setup(page, {}, undefined, { trace: true });
    await page.goto("/projects/p1/automation");
    const group = page.getByRole("link", { name: "Record manual results" }).first();
    await expect(group).toHaveAttribute("href", /\/execution\?record=1&cases=TC-0027/);
    await expect(page.getByText("These approved cases are tested by a person. Record what happened in Test Execution.")).toBeVisible();
    await expect(page.getByText("isn't available yet")).toHaveCount(0);
    await page.goto("/projects/p1/traceability?view=coverage");
    await expect(page.getByRole("heading", { name: "Manual only, no recorded result (1)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record manual results" })).toHaveAttribute("href", "/projects/p1/execution?record=1");
  });

  test("viewer: no entry point on Test Execution, case detail, Automation or Traceability; the record page sends them to the read-only run page (checks 1, 13)", async ({ page }) => {
    await setup(page, { role: "viewer" }, (q) => seedResult(q, four(q), 27, "passed", "The form posts to https://acme.com/session"), { trace: true });
    await page.goto("/projects/p1/execution");
    await expect(page.getByRole("table", { name: "Test runs" }).getByText("Recording · 1 of 4 recorded")).toBeVisible();
    await expect(page.getByRole("button", { name: "Record manual results" })).toHaveCount(0);
    await expect(page.getByText(/You're recording/)).toHaveCount(0);
    await page.goto("/projects/p1/execution?record=1");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/projects/p1/test-cases/TC-0019");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record a manual result…" })).toHaveCount(0);
    await page.goto("/projects/p1/automation");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record manual results" })).toHaveCount(0);
    await page.goto("/projects/p1/traceability?view=coverage");
    await expect(page.getByRole("heading", { name: "Manual only, no recorded result (1)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record manual results" })).toHaveCount(0);
    await page.goto("/projects/p1/execution/RUN-0005/record");
    await expect(page).toHaveURL(/\/execution\/RUN-0005$/);
    await expect(page.getByRole("heading", { level: 1, name: "RUN-0005 · Manual" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue recording/ })).toHaveCount(0);
    await page.getByRole("link", { name: /TC-0027 Check the sign-in form's action address/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: /RUN-0005-01/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Raise defect…" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Edit in RUN-0005/ })).toHaveCount(0);
  });
});

test.describe("P4-14 · record page", () => {
  test("start 4 cases: record page with focus on the h1, no Gate 7 anywhere; the run list says 'Recording · 0 of 4 recorded'; axe (check 5)", async ({ page }) => {
    const { q } = await setup(page);
    const dialog = await openStart(page);
    await dialog.getByRole("button", { name: "Start recording 4 cases" }).click();
    await expect(page).toHaveURL(/\/execution\/RUN-0005\/record$/);
    const h1 = page.getByRole("heading", { level: 1, name: "Record manual results · RUN-0005" });
    await expect(h1).toBeFocused();
    expect(q.requests.find((r) => r.method === "POST")?.body).toEqual({ mode: "manual", case_keys: ["TC-0027", "TC-0033", "TC-0040", "TC-0041"] });
    await expect(page.getByText(/^By hand · started by Daniele Edema, .+ · 4 cases · Results count as soon as you save them\.$/)).toBeVisible();
    await expect(page.getByText("0 of 4 recorded", { exact: true })).toBeVisible();
    await expect(page.getByText(/Gate 7|Authoris/)).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Cases" });
    await expect(nav.getByRole("link", { name: "TC-0033 Keyboard-only navigation, not recorded yet" })).toBeVisible();
    await expect(card(page, "TC-0027").getByText("Not recorded yet")).toBeVisible();
    // Steps are open while unrecorded.
    await expect(card(page, "TC-0027").getByRole("button", { name: "Steps and expected result" })).toHaveAttribute("aria-expanded", "true");
    await expect(card(page, "TC-0027").getByText("Expected result (TC-0027 v2): The form posts to an https:// address")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole("link", { name: "RUN-0005", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "RUN-0005 · Manual" })).toBeVisible();
    await expect(page.getByText("By hand · started by Daniele Edema", { exact: false })).toContainText("No Gate 7: nothing ran on the platform.");
    await expect(page.getByRole("tab")).toHaveCount(0);
    await page.goto("/projects/p1/execution");
    const table = page.getByRole("table", { name: "Test runs" });
    await expect(table.getByText("Recording · 0 of 4 recorded")).toBeVisible();
    await expect(table.getByText("Manual · 4 cases")).toBeVisible();
    await expect(table.getByText("Daniele Edema · not needed (manual)")).toBeVisible();
    await expect(page.getByText("You're recording RUN-0005 by hand: 0 of 4 recorded.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue recording RUN-0005" })).toBeVisible();
    await page.getByRole("combobox", { name: "Status" }).selectOption("recording");
    await expect(table.getByRole("link", { name: "Open RUN-0005" })).toBeVisible();
    await expect(table.getByRole("link", { name: "Open RUN-0003" })).toHaveCount(0);
  });

  test("Save with nothing: both errors linked to their fields, focus on the first radio; then saved as Passed: announced, count updated, focus stays on Save, no toast (checks 6, 7)", async ({ page }) => {
    const { q } = await setup(page, {}, (q) => four(q));
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const c = card(page, "TC-0027");
    const save = c.getByRole("button", { name: "Save result for TC-0027" });
    await save.click();
    await expect(c.getByText("Choose Passed, Failed or Blocked.")).toBeVisible();
    await expect(c.getByText("Describe what happened.")).toBeVisible();
    const fieldset = c.getByRole("group", { name: /Result for TC-0027/ });
    const errId = await c.getByText("Choose Passed, Failed or Blocked.").getAttribute("id");
    expect(await fieldset.getAttribute("aria-describedby")).toContain(errId!);
    const what = c.getByRole("textbox", { name: "What happened" });
    await expect(what).toHaveAttribute("aria-invalid", "true");
    await expect(what).toHaveAccessibleDescription(/Describe what happened\./);
    await expect(c.getByRole("radio", { name: "Passed" })).toBeFocused();
    expect(q.requests.filter((r) => r.method === "PUT")).toEqual([]);

    await c.getByRole("radio", { name: "Passed" }).check();
    await what.fill("The form posts to https://acme.com/session");
    await c.getByRole("textbox", { name: "Notes" }).fill("Firefox 132 on macOS");
    await save.click();
    await expect(status(page)).toHaveText("TC-0027 saved as Passed. 1 of 4 recorded.");
    await expect(page.getByText("1 of 4 recorded · 1 passed", { exact: true })).toBeVisible();
    // The time is the server's recorded_at, not the browser's clock.
    await expect(c.getByText(`Saved · Passed · Recorded by Daniele Edema, ${await when(page, SAVED_AT)}`, { exact: true })).toBeVisible();
    const again = c.getByRole("button", { name: "Save changes for TC-0027" });
    await expect(again).toBeFocused();
    await expect(again).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("[data-toast], [role=status]").filter({ hasText: "saved as Passed" })).toHaveCount(1);
    expect(q.requests.find((r) => r.method === "PUT")?.body).toEqual({ status: "passed", actual_result: "The form posts to https://acme.com/session", notes: "Firefox 132 on macOS" });
    // Steps close after the first save; editing again shows "Unsaved changes" and enables Save changes.
    await expect(c.getByRole("button", { name: "Steps and expected result" })).toHaveAttribute("aria-expanded", "false");
    await what.fill("The form posts to https://acme.com/session (checked twice)");
    await expect(c.getByText("Unsaved changes")).toBeVisible();
    await expect(again).not.toHaveAttribute("aria-disabled", "true");
  });

  test("files: a 12 MB PNG and a 6th file are refused and announced; a .png that is really HTML gets the server message and the result stays saved (check 8)", async ({ page }) => {
    // a.png uploads first, then fake.png (really HTML) is refused by the server.
    const { q } = await setup(page, { htmlUpload: 2 }, (q) => four(q));
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const c = card(page, "TC-0027");
    await expect(c.getByText("PNG, JPEG or PDF · up to 10 MB each · up to 5 files.")).toBeVisible();
    await expect(c.getByText("Files can't be removed once uploaded; they're kept as evidence.")).toBeVisible();
    const input = c.locator('input[type="file"]');
    await expect(input).toHaveAttribute("accept", ".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf");
    await input.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(12 * 1024 * 1024, 1) });
    await expect(c.getByText("huge.png: This file is larger than 10 MB.")).toBeVisible();
    await expect(status(page)).toHaveText("huge.png: This file is larger than 10 MB.");
    const png = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from("\x89PNG\r\n\x1a\nxx", "latin1") });
    await input.setInputFiles([png("a.png"), png("b.png"), png("c.png"), png("d.png"), png("e.png"), png("f.png")]);
    await expect(c.getByText("You can add up to 5 files to a result.")).toBeVisible();
    await expect(c.getByText("Will upload when you save")).toHaveCount(5);
    // Remove four queued files, then queue one that is really HTML.
    for (const n of ["b", "c", "d", "e"]) await c.getByRole("button", { name: `Remove ${n}.png from TC-0027` }).click();
    await input.setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("<!doctype html><html><body>hi</body></html>") });
    await c.getByRole("radio", { name: "Failed" }).check();
    await c.getByRole("textbox", { name: "What happened" }).fill("The form posts to http://acme.com/session");
    await c.getByRole("button", { name: "Save result for TC-0027" }).click();
    await expect(c.getByText("fake.png: This file type isn't supported. Use PNG, JPEG or PDF.")).toBeVisible();
    await expect(c.getByRole("link", { name: "Open a.png from TC-0027 (opens in a new tab)" })).toBeVisible();
    await expect(c.getByText(/^Saved · Failed · Recorded by Daniele Edema/)).toBeVisible();
    expect(q.results["RUN-0005-01"].status).toBe("failed");
    expect(q.results["RUN-0005-01"].evidence).toHaveLength(1);
  });

  test("Failed saved: no defect drafted, [Raise defect…] opens the form with Actual = What happened (check 9)", async ({ page }) => {
    const { q, exec } = await setup(page, {}, (q) => four(q));
    const before = exec.defects.length;
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const c = card(page, "TC-0033");
    await c.getByRole("radio", { name: "Failed" }).check();
    await c.getByRole("textbox", { name: "What happened" }).fill("Focus is lost after the menu closes");
    await c.getByRole("button", { name: "Save result for TC-0033" }).click();
    await expect(c.getByText("No defect is drafted automatically for manual results.")).toBeVisible();
    expect(exec.defects.length).toBe(before);
    expect(q.requests.some((r) => r.path.includes("/defects"))).toBe(false);
    await c.getByRole("link", { name: "Raise defect… from TC-0033 result" }).click();
    await expect(page).toHaveURL(/\/defects\/new\?from=RUN-0005-02$/);
    await expect(page.getByText("Prefilled from RUN-0005-02. Check the wording before saving.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Actual result/ })).toHaveValue("Focus is lost after the menu closes");
    expect(exec.defects.length).toBe(before);
  });

  test("a result recorded by M. Member is read-only for me; a 403 shows the server message (checks 10, §6)", async ({ page }) => {
    const { q } = await setup(page, {}, (q) => {
      const run = four(q);
      seedResult(q, run, 33, "failed", "Tab skips the search field", MEMBER, "Chrome 131");
    });
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const c = card(page, "TC-0033");
    await expect(c.getByText("Recorded by M. Member", { exact: true })).toBeVisible();
    await expect(c.getByText("Tab skips the search field")).toBeVisible();
    await expect(c.getByText("Chrome 131")).toBeVisible();
    await expect(c.getByText(`Recorded by M. Member, ${await when(page, SEEDED_AT)}. Only they can change it until RUN-0005 is finished.`, { exact: true })).toBeVisible();
    await expect(c.getByRole("radio")).toHaveCount(0);
    await expect(c.getByRole("button", { name: /Save/ })).toHaveCount(0);
    // Someone else saved TC-0027 a moment ago: the server refuses my save.
    q.failSave = { status: 403, code: "forbidden", message: "Only M. Member can change this result until RUN-0005 is finished." };
    const mine = card(page, "TC-0027");
    await mine.getByRole("radio", { name: "Blocked" }).check();
    await mine.getByRole("textbox", { name: "What happened" }).fill("No staging access today");
    await mine.getByRole("button", { name: "Save result for TC-0027" }).click();
    await expect(mine.getByRole("alert")).toHaveText("Only M. Member can change this result until RUN-0005 is finished.");
    await expect(mine.getByRole("textbox", { name: "What happened" })).toHaveValue("No staging access today");
  });

  test("finish with 2 of 4 recorded: dialog names the unrecorded keys; the run page shows two By hand results and two Not run; focus on the h1 (check 11)", async ({ page }) => {
    await setup(page, {}, (q) => {
      const run = four(q);
      seedResult(q, run, 27, "passed", "Posts to https://acme.com/session");
      seedResult(q, run, 33, "failed", "Tab skips the search field");
    });
    await page.goto("/projects/p1/execution/RUN-0005/record");
    await expect(page.getByText("2 of 4 recorded · 1 passed · 1 failed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish recording…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Finish with 2 cases not recorded? They'll show 'Not run'." });
    await expect(dialog.getByText("Not recorded: TC-0040, TC-0041.")).toBeVisible();
    await expect(dialog.getByText("Results can't be changed after this.")).toBeVisible();
    await dialog.getByRole("button", { name: "Finish recording" }).click();
    await expect(page).toHaveURL(/\/execution\/RUN-0005$/);
    const h1 = page.getByRole("heading", { level: 1, name: "RUN-0005 · Manual" });
    await expect(h1).toBeFocused();
    await expect(page.getByText("RUN-0005 finished: 1 passed, 1 failed, 2 not run.")).toBeVisible();
    await expect(page.getByText("Finished · 1 failed")).toBeVisible();
    const table = page.getByRole("table", { name: "Results (4)" });
    await expect(table.getByText("Not run")).toHaveCount(2);
    await expect(table.getByText("Daniele Edema")).toHaveCount(2);
    await expect(page.getByText("Failed by hand (1): TC-0033. Not analysed: recorded by a person.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue recording/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Re-run/ })).toHaveCount(0);
  });

  test("unsaved changes: Finish asks to save first and [Go to TC-0033] focuses the card; Raise defect… asks before leaving; nothing is lost (check 12)", async ({ page }) => {
    await setup(page, {}, (q) => {
      const run = four(q);
      seedResult(q, run, 33, "failed", "Tab skips the search field");
    });
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const c = card(page, "TC-0033");
    await c.getByRole("textbox", { name: "What happened" }).fill("Tab skips the search field and the menu");
    await expect(c.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Finish recording…" }).first().click();
    const save = page.getByRole("dialog", { name: "Save or discard your changes first." });
    await expect(save.getByText("TC-0033 has unsaved changes.")).toBeVisible();
    await save.getByRole("button", { name: "Go to TC-0033" }).click();
    await expect(c.getByRole("heading", { level: 2 })).toBeFocused();
    await c.getByRole("link", { name: "Raise defect… from TC-0033 result" }).click();
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leave.getByText("Your changes to TC-0033 aren't saved.")).toBeVisible();
    await leave.getByRole("button", { name: "Stay" }).click();
    await expect(page).toHaveURL(/\/record$/);
    await expect(c.getByRole("textbox", { name: "What happened" })).toHaveValue("Tab skips the search field and the menu");
    await c.getByRole("link", { name: "Raise defect… from TC-0033 result" }).click();
    await page.getByRole("dialog", { name: "Leave without saving?" }).getByRole("button", { name: "Leave without saving" }).click();
    await expect(page).toHaveURL(/\/defects\/new\?from=RUN-0005-02$/);
  });

  test("unsaved changes: browser Back asks first; Stay keeps the text; Leave without saving goes back (check 12, §4.5)", async ({ page }) => {
    await setup(page, {}, (q) => seedResult(q, four(q), 40, "blocked", "No screen reader"));
    await page.goto("/projects/p1/execution");
    await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
    await page.getByRole("link", { name: "Continue recording RUN-0005" }).click();
    await expect(page).toHaveURL(/\/RUN-0005\/record$/);
    const c = card(page, "TC-0040");
    await c.getByRole("textbox", { name: "What happened" }).fill("No screen reader on this machine");
    await expect(c.getByText("Unsaved changes")).toBeVisible();
    // history.back() rather than page.goBack(): the guard keeps the document, so there's no load to wait for.
    await page.evaluate(() => window.history.back());
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leave.getByText("Your changes to TC-0040 aren't saved.")).toBeVisible();
    await expect(leave.getByRole("button", { name: "Stay" })).toBeFocused();
    await leave.getByRole("button", { name: "Stay" }).click();
    await expect(page).toHaveURL(/\/RUN-0005\/record$/);
    await expect(c.getByRole("textbox", { name: "What happened" })).toHaveValue("No screen reader on this machine");
    await page.evaluate(() => window.history.back());
    await page.getByRole("dialog", { name: "Leave without saving?" }).getByRole("button", { name: "Leave without saving" }).click();
    await expect(page).toHaveURL(/\/projects\/p1\/execution$/);
    await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
  });

  test("saved since: browser Back leaves without asking (§4.5)", async ({ page }) => {
    await setup(page, {}, (q) => four(q));
    await page.goto("/projects/p1/execution");
    await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
    await page.getByRole("link", { name: "Continue recording RUN-0005" }).click();
    await expect(page).toHaveURL(/\/RUN-0005\/record$/);
    const c = card(page, "TC-0040");
    await c.getByRole("radio", { name: "Blocked" }).check();
    await c.getByRole("textbox", { name: "What happened" }).fill("No screen reader on this machine");
    await c.getByRole("button", { name: "Save result for TC-0040" }).click();
    await expect(c.getByText(/^Saved · Blocked/)).toBeVisible();
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(/\/projects\/p1\/execution$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a finished run: record page read-only with the finished callout; no Continue recording or Re-run on the run page (check 13)", async ({ page }) => {
    await setup(page, {}, (q) => {
      const run = four(q);
      seedResult(q, run, 27, "passed", "Posts to https://acme.com/session");
      for (const r of run.tests_rows) if (!r.id) r.status = "not_run";
      Object.assign(run, { status: "passed", finished_at: "2026-11-19T16:10:00Z", finished_by: MEMBER });
    });
    await page.goto("/projects/p1/execution/RUN-0005/record");
    await expect(page.getByText(`RUN-0005 was finished by M. Member on ${await when(page, "2026-11-19T16:10:00Z")}. Start a new manual run to record again.`, { exact: true })).toBeVisible();
    await expect(card(page, "TC-0027").getByText(`Recorded by Daniele Edema, ${await when(page, SEEDED_AT)}.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Record manual results" })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Finish recording/ })).toHaveCount(0);
    await expect(card(page, "TC-0040").getByText("Not run: nothing was recorded for this case.")).toBeVisible();
    await page.goto("/projects/p1/execution/RUN-0005");
    await expect(page.getByText("Finished · all passed")).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue recording/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Re-run/ })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions for RUN-0005" }).click();
    await expect(page.getByRole("menuitem", { name: "Open Test Execution Report" })).toBeVisible();
  });

  test("offline: Save keeps the typed values and says so (check 17); a 409 keeps them with the finished note (§6)", async ({ page, context }) => {
    const { q } = await setup(page, {}, (q) => four(q));
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const c = card(page, "TC-0040");
    await c.getByRole("radio", { name: "Blocked" }).check();
    await c.getByRole("textbox", { name: "What happened" }).fill("No screen reader on this machine");
    await context.setOffline(true);
    await c.getByRole("button", { name: "Save result for TC-0040" }).click();
    await expect(c.getByRole("alert")).toHaveText("You're offline. Your answers are still here; save again when you reconnect.");
    await expect(c.getByRole("textbox", { name: "What happened" })).toHaveValue("No screen reader on this machine");
    await expect(c.getByRole("radio", { name: "Blocked" })).toBeChecked();
    await context.setOffline(false);
    q.failSave = { status: 409, code: "conflict", message: "RUN-0005 is finished. Start a new manual run to record again." };
    await c.getByRole("button", { name: "Save result for TC-0040" }).click();
    await expect(c.getByRole("alert")).toHaveText("RUN-0005 is finished. Start a new manual run to record again.");
    await expect(c.getByRole("textbox", { name: "What happened" })).toHaveValue("No screen reader on this machine");
  });

  test("zero results: Finish unavailable with the reason; Discard RUN-0005… cancels it (check 18)", async ({ page }) => {
    const { q } = await setup(page, {}, (q) => four(q));
    await page.goto("/projects/p1/execution/RUN-0005/record");
    await expect(page.getByRole("heading", { level: 1, name: "Record manual results · RUN-0005" })).toBeVisible({ timeout: 30_000 });
    const finish = page.getByRole("button", { name: "Finish recording…" }).first();
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(finish).toHaveAccessibleDescription("Record at least one case to finish, or discard the run.");
    await finish.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "More actions for RUN-0005" }).click();
    await page.getByRole("menuitem", { name: "Discard RUN-0005…" }).click();
    const dialog = page.getByRole("dialog", { name: "Discard RUN-0005?" });
    await expect(dialog.getByText("Nothing has been recorded in it. It will show as Cancelled.")).toBeVisible();
    await dialog.getByRole("button", { name: "Discard RUN-0005" }).click();
    // The toast comes first, then the run page loads (slow on a cold dev server, so wait longer for the route).
    await expect(page.getByText("RUN-0005 discarded.")).toBeVisible({ timeout: 20_000 });
    expect(q.requests.some((r) => r.path === "/execution-runs/run-0005/cancel")).toBe(true);
    await expect(page).toHaveURL(/\/execution\/RUN-0005$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1, name: "RUN-0005 · Manual" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("RUN-0005 was discarded. Nothing was recorded.")).toBeVisible();
  });

  test("keyboard at 375 px: Start modal and record page don't scroll sideways, targets ≥ 24 px, nothing sticky, focus order from h1 to the cards (check 16)", async ({ page, browserName }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await setup(page, {}, (q) => {
      const run = four(q);
      seedResult(q, run, 33, "failed", "Tab skips the search field", MEMBER);
    });
    await page.goto("/projects/p1/execution?record=1");
    const dialog = page.getByRole("dialog", { name: "Record manual results" });
    await expect(dialog.getByRole("checkbox", { name: /TC-0027/ })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Closing drops ?record=1 from the URL; let that navigation settle before the next one (WebKit).
    await expect(page).toHaveURL(/\/execution$/);
    await page.goto("/projects/p1/execution/RUN-0005/record");
    const h1 = page.getByRole("heading", { level: 1, name: "Record manual results · RUN-0005" });
    await expect(card(page, "TC-0027").getByRole("radio", { name: "Passed" })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // Nothing on the page is sticky or fixed (2.4.11).
    const stuck = await page.locator("main *").evaluateAll((els) => els.filter((e) => ["sticky", "fixed"].includes(getComputedStyle(e).position)).length);
    expect(stuck).toBe(0);
    // Targets: every button, link and radio label in the first card is at least 24 × 24 px.
    const c = card(page, "TC-0027");
    for (const el of await c.locator("button, a, label:has(input[type=radio])").all()) {
      const box = await el.boundingBox();
      if (!box) continue;
      expect(box.height, await el.innerText()).toBeGreaterThanOrEqual(24);
      expect(box.width, await el.innerText()).toBeGreaterThanOrEqual(24);
    }
    // Focus order (§8): h1 → Finish → ⋯ → Cases nav → first card. Safari moves Tab through buttons and links only with
    // Option held (its default "Press Tab to highlight each item" is off).
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    await h1.focus();
    await page.keyboard.press(tab);
    await expect(page.getByRole("button", { name: "Finish recording…" }).first()).toBeFocused();
    await page.keyboard.press(tab);
    await expect(page.getByRole("button", { name: "More actions for RUN-0005" })).toBeFocused();
    await page.keyboard.press(tab);
    await expect(page.getByRole("navigation", { name: "Cases" }).getByRole("link").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(c.getByRole("heading", { level: 2 })).toBeFocused();
    await page.keyboard.press(tab);
    await expect(c.getByRole("button", { name: "Steps and expected result" })).toBeFocused();
    await page.keyboard.press(tab);
    await expect(c.getByRole("radio", { name: "Passed" })).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe("P4-14 · manual results everywhere", () => {
  test("case list, case detail, run page, result detail and traceability show 'By hand · Recorded by'; never a cause, Hypothesis or confidence (check 14)", async ({ page }) => {
    await setup(
      page,
      {},
      (q) => {
        const run = four(q);
        seedResult(q, run, 27, "passed", "Posts to https://acme.com/session", undefined, "Firefox 132");
        seedResult(q, run, 33, "failed", "Tab skips the search field", MEMBER);
      },
      { trace: true },
    );
    await page.goto("/projects/p1/test-cases");
    await expect(page.getByRole("link", { name: "Passed by hand, recorded by M. Member, RUN-0002, 12 November" }).first()).toBeVisible();
    await page.goto("/projects/p1/test-cases/TC-0034");
    await expect(page.getByText("By hand · Recorded by M. Member").first()).toBeVisible();
    await page.goto("/projects/p1/execution/RUN-0005");
    const table = page.getByRole("table", { name: "Results (4)" });
    await expect(table.getByText("Not recorded yet")).toHaveCount(2);
    await expect(table.getByText("M. Member")).toBeVisible();
    await expect(page.getByText("Recording · 2 of 4 recorded")).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue recording RUN-0005" })).toBeVisible();
    await table.getByRole("link", { name: /TC-0033 Keyboard-only navigation/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: /RUN-0005-02 · TC-0033/ })).toBeVisible();
    await expect(page.getByText(`By hand · Recorded by M. Member, ${await when(page, SEEDED_AT)} · RUN-0005 · TC-0033 v2`, { exact: true })).toBeVisible();
    await expect(page.getByText("What happened", { exact: true }).or(page.getByText(/^What happened/))).toBeVisible();
    await expect(page.getByText("Tab skips the search field")).toBeVisible();
    await expect(page.getByText("No notes.")).toBeVisible();
    await expect(page.getByText("Steps (TC-0033 v2; recorded as one result, not step by step)")).toBeVisible();
    await expect(page.getByText("Not analysed: recorded by a person.")).toBeVisible();
    await expect(page.getByText("No files were added.")).toBeVisible();
    await expect(page.getByText(/Hypothesis|Confidence|Observed on the page|Change the cause/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Raise defect…" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask the analyst" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Re-run/ })).toHaveCount(0);
    // My own result while recording: [Edit in RUN-0005] goes to its card.
    await page.goto("/projects/p1/execution/RUN-0005/results/RUN-0005-01");
    await expect(page.getByText("Firefox 132")).toBeVisible();
    await page.getByRole("link", { name: "Edit in RUN-0005" }).click();
    await expect(page).toHaveURL(/\/record#TC-0027$/);
    await expect(card(page, "TC-0027").getByRole("heading", { level: 2 })).toBeFocused();
    await page.goto("/projects/p1/traceability?view=matrix");
    await expect(page.getByText("✓ Passed RUN-0005 · By hand · Recorded by Daniele Edema").first()).toBeVisible();
    await page.goto("/projects/p1/traceability?view=coverage");
    const gap = page.locator("#gap-failed");
    await expect(gap.getByText("By hand · Recorded by M. Member")).toBeVisible();
    await expect(gap.getByText("Not analysed: recorded by a person")).toBeVisible();
    await expect(gap.getByText("(Hypothesis)")).toHaveCount(0);
  });
});

test.describe("P4-14 · change set Manual re-tests (D39)", () => {
  async function setupChange(page: Page, role: "owner" | "viewer" = "owner") {
    const s = newState({ phase: "approved" });
    s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
    const q = newRelease(role === "viewer" ? { role: "viewer", canApprove: false } : {});
    const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
    await mockApi(page, s);
    await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }));
    await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role }), newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
    await mockPhase4(page, s, p4);
    await mockExec(page, newExec({ role: q.role, canApprove: q.canApprove }));
    const p6 = newP6({ role: q.role, outdated: false });
    await mockPhase6(page, s, p6);
    await mockManualMustRun(page, p6);
    await mockRelease(page, s, q, p4);
    await signedIn(page, s);
    return q;
  }

  test("Passed/Failed only with What happened; the latest line reads 'By hand · Recorded by'; links to the result; files go through the Start modal (check 15)", async ({ page }) => {
    const q = await setupChange(page);
    // An earlier re-test stored as a manual result (D39): it links to its result.
    q.retests["TC-0031"] = [{ id: "res1", status: "failed", note: "Blank dashboard", recorded_by: { id: "m", full_name: "M. Member" }, recorded_at: "2026-11-15T16:00:00Z", run_key: "RUN-0007", result_key: "RUN-0007-01" }];
    await page.goto("/projects/p1/discovery/changes/CHG-0001?tab=regression");
    const section = page.getByRole("region", { name: /^Manual re-tests/ });
    await expect(section.getByText("These must-run tests are run by a person, not by the regression run. Record what happened after CHG-0001. Each result counts as a manual result on the test case and for release readiness.")).toBeVisible();
    await expect(section.getByText(/^Latest: Failed · By hand · Recorded by M\. Member · .+: 'Blank dashboard'/)).toBeVisible();
    await expect(section.getByRole("link", { name: "Open RUN-0007-01 result" })).toHaveAttribute("href", "/projects/p1/execution/RUN-0007/results/RUN-0007-01");
    await expect(section.getByText("No defect is drafted automatically for manual results.")).toBeVisible();
    await expect(section.getByRole("link", { name: "Raise defect… from TC-0031 result" })).toHaveAttribute("href", "/projects/p1/defects/new?from=RUN-0007-01");
    await expect(section.getByRole("link", { name: "Record re-tests with files…" })).toHaveAttribute("href", "/projects/p1/execution?record=1&cases=TC-0031&change=CHG-0001");
    await section.getByRole("button", { name: "Record re-test result for TC-0031" }).click();
    const dialog = page.getByRole("dialog", { name: "Record re-test: TC-0031" });
    await expect(dialog.getByText("What happened when you tested TC-0031 by hand after CHG-0001.")).toBeVisible();
    await expect(dialog.getByRole("group", { name: /Result for TC-0031/ }).getByRole("radio")).toHaveCount(2);
    await expect(dialog.getByRole("radio", { name: "Blocked" })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save result" }).click();
    await expect(dialog.getByText("Choose Passed or Failed.")).toBeVisible();
    await expect(dialog.getByText("Describe what happened.")).toBeVisible();
    await dialog.getByRole("radio", { name: "Passed" }).check();
    await dialog.getByRole("textbox", { name: "What happened" }).fill("Signed in and the dashboard loaded");
    await dialog.getByRole("button", { name: "Save result" }).click();
    await expect(page.getByText("Manual re-test of TC-0031 recorded: passed.")).toBeVisible();
    expect(q.requests.find((r) => r.path.endsWith("/manual-retests") && r.method === "POST")?.body).toEqual({ case_key: "TC-0031", status: "passed", note: "Signed in and the dashboard loaded" });
    await expect(section.getByText(/^Latest: Passed · By hand · Recorded by Daniele Edema · .+: 'Signed in and the dashboard loaded'/)).toBeVisible();
    await expect(section.getByRole("heading", { name: "TC-0031 Sign in with the saved test account" })).toBeFocused();
    await expect(section.getByRole("link", { name: "Open RUN-0008-01 result" })).toBeVisible();
    await expect(section.getByRole("button", { name: "Earlier results for TC-0031 (1)" })).toBeVisible();
    // Recording again in the same open run updates that run's result: still one entry per run (D39).
    await section.getByRole("button", { name: "Record re-test result for TC-0031" }).click();
    const again = page.getByRole("dialog", { name: "Record re-test: TC-0031" });
    await expect(again.getByText("If you're still recording a manual run for CHG-0001, this updates your result there instead of adding a new one.")).toBeVisible();
    await again.getByRole("radio", { name: "Failed" }).check();
    await again.getByRole("textbox", { name: "What happened" }).fill("The dashboard stayed blank");
    await again.getByRole("button", { name: "Save result" }).click();
    await expect(again).toHaveCount(0);
    await expect(section.getByText(/^Latest: Failed · By hand · Recorded by Daniele Edema · .+: 'The dashboard stayed blank'/)).toBeVisible();
    await expect(section.getByRole("button", { name: "Earlier results for TC-0031 (1)" })).toBeVisible();
    expect(q.retests["TC-0031"].map((r) => r.run_key)).toEqual(["RUN-0008", "RUN-0007"]);
    // Release readiness: a waiting assessment goes out of date with the server's reason.
    await page.goto("/projects/p1/release-readiness");
    await expect(page.getByText(/Manual re-test of TC-0031 recorded \(passed\)/).first()).toBeVisible();
  });

  test("viewer: the section reads the re-tests without any record action (check 1)", async ({ page }) => {
    await setupChange(page, "viewer");
    await page.goto("/projects/p1/discovery/changes/CHG-0001?tab=regression");
    const section = page.getByRole("region", { name: /^Manual re-tests/ });
    await expect(section).toContainText("Not recorded yet.");
    await expect(section.getByRole("button")).toHaveCount(0);
    await expect(section.getByRole("link", { name: "Record re-tests with files…" })).toHaveCount(0);
  });
});
