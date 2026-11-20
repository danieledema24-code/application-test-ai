// QA (P4-14b): states and edge cases of design docs/design/P4-14-manual-results.md §4.4, §4.5 and §6 that
// p4-14-manual.spec.ts doesn't exercise, against the same stubbed API (./p4-14-manual-fixtures.ts, test-only).
import { expect, test, type Page } from "@playwright/test";
import { API, mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4, p4Workflow } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { manualCases, manualRun, mockManual, newManual, seedResult, type ManualState } from "./p4-14-manual-fixtures";

test.describe.configure({ timeout: 90_000 });

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Content-Type": "application/json" };

async function setup(page: Page, over: Partial<ManualState> = {}, seed?: (q: ManualState) => void, opts: { noRuns?: boolean } = {}) {
  const s = newState({ phase: "approved" });
  s.projects = [project()];
  const q = newManual(over);
  seed?.(q);
  const role = q.role;
  const canApprove = role === "owner" || role === "admin";
  const exec = newExec({ role, canApprove });
  if (opts.noRuns) exec.runs = [];
  await mockApi(page, s);
  await mockPhase2(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role }));
  await mockPhase3(page, s, newP2({ g3: "approved", strategy: true, g4: "approved", role }), newP3({ designed: true, g5: "approved", canApprove, cases: manualCases() }));
  await mockPhase4(page, s, newP4({ role, canApprove, invalid: true }));
  await mockExec(page, exec);
  await mockManual(page, q, exec);
  await signedIn(page, s);
  return { q, exec };
}

const four = (q: ManualState) => manualRun(q, [27, 33, 40, 41]);
const card = (page: Page, k: string) => page.getByRole("region", { name: new RegExp(`^${k} `) });
const live = (page: Page) => page.locator('main p[role="status"][aria-live="polite"]').last();

test("no runs yet: both empty states offer [Record manual results]; before Gate 6 it says manual results still work (§3)", async ({ page }) => {
  await setup(page, {}, undefined, { noRuns: true });
  await page.goto("/projects/p1/execution");
  await expect(page.getByText("No tests have run yet.")).toBeVisible();
  // One in the header and one in the empty state, next to [Run tests…].
  await expect(page.getByRole("button", { name: "Record manual results" })).toHaveCount(2);
  // Before the automation stage has a version (no scripts yet): the "Tests can run once…" state.
  await page.route(`${API}/projects/p1/workflow`, (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(p4Workflow(newP4({ assessed: false }))) }));
  await page.reload();
  await expect(page.getByText("Tests can run once scripts pass their checks (Gate 6).")).toBeVisible();
  await expect(page.getByText("You can still record results for cases you test by hand.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run tests…" })).toHaveCount(0);
  await page.getByRole("button", { name: "Record manual results" }).last().click();
  await expect(page.getByRole("dialog", { name: "Record manual results" })).toBeVisible();
});

test("Start modal offline: Start is unavailable with the offline reason (§6)", async ({ page, context }) => {
  await setup(page);
  await page.goto("/projects/p1/execution?record=1");
  const dialog = page.getByRole("dialog", { name: "Record manual results" });
  await expect(dialog.getByRole("checkbox", { name: /Select TC-0027/ })).toBeChecked();
  await context.setOffline(true);
  const start = dialog.getByRole("button", { name: /^Start recording/ });
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription("You're offline. Reconnect to start recording.");
  await context.setOffline(false);
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
});

test("Start modal: Cancel returns focus to the opener and drops ?record=1 (§8 Modal contract)", async ({ page }) => {
  await setup(page);
  await page.goto("/projects/p1/execution");
  const opener = page.getByRole("button", { name: "Record manual results" }).first();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Record manual results" });
  await expect(dialog.getByRole("checkbox", { name: /Select TC-0027/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/execution$/);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("files still uploading: Finish is unavailable with 'Wait for 1 file to finish uploading.'; progress is text (§4.4, §6)", async ({ page }) => {
  await setup(page, { uploadDelay: 4_000 }, (q) => seedResult(q, four(q), 33, "failed", "Tab skips the search field"));
  await page.goto("/projects/p1/execution/RUN-0005/record");
  const c = card(page, "TC-0027");
  await c.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("\x89PNG\r\n\x1a\nxx", "latin1") });
  await c.getByRole("radio", { name: "Passed" }).check();
  await c.getByRole("textbox", { name: "What happened" }).fill("Posts to https://acme.com/session");
  await c.getByRole("button", { name: "Save result for TC-0027" }).click();
  await expect(c.getByText(/Uploading shot\.png… \d+%/)).toBeVisible();
  const finish = page.getByRole("button", { name: "Finish recording…" }).first();
  await expect(finish).toHaveAttribute("aria-disabled", "true");
  await expect(finish).toHaveAccessibleDescription("Wait for 1 file to finish uploading.");
  await expect(c.getByRole("link", { name: "Open shot.png from TC-0027 (opens in a new tab)" })).toBeVisible({ timeout: 15_000 });
  await expect(live(page)).toHaveText("shot.png uploaded.");
  await expect(finish).not.toHaveAttribute("aria-disabled", "true");
});

test("an upload that fails on the server keeps the file with [Try again]; the result stays saved (§6)", async ({ page }) => {
  const { q } = await setup(page, {}, (q) => four(q));
  let fail = true;
  await page.route(`${API}/execution-results/*/evidence`, (route) => {
    if (route.request().method() !== "POST" || !fail) return route.fallback();
    fail = false;
    return route.fulfill({ status: 500, headers: CORS, body: JSON.stringify({ error: { code: "internal_error", message: "Something went wrong", details: null } }) });
  });
  await page.goto("/projects/p1/execution/RUN-0005/record");
  const c = card(page, "TC-0040");
  await c.locator('input[type="file"]').setInputFiles({ name: "reader.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%x\n") });
  await c.getByRole("radio", { name: "Blocked" }).check();
  await c.getByRole("textbox", { name: "What happened" }).fill("No screen reader on this machine");
  await c.getByRole("button", { name: "Save result for TC-0040" }).click();
  await expect(c.getByText("reader.pdf didn't upload. The result is saved. Try again.")).toBeVisible();
  await expect(live(page)).toHaveText("reader.pdf didn't upload. The result is saved. Try again.");
  expect(q.results["RUN-0005-03"].status).toBe("blocked");
  await c.getByRole("button", { name: "Try again to upload reader.pdf" }).click();
  await expect(c.getByRole("link", { name: "Open reader.pdf from TC-0040 (opens in a new tab)" })).toBeVisible();
});

test("a rate-limited upload shows the server message verbatim (§6)", async ({ page }) => {
  await setup(page, {}, (q) => four(q));
  await page.route(`${API}/execution-results/*/evidence`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 429, headers: CORS, body: JSON.stringify({ error: { code: "rate_limited", message: "Too many uploads for this project. Try again in 12 minutes.", details: null } }) })
      : route.fallback(),
  );
  await page.goto("/projects/p1/execution/RUN-0005/record");
  const c = card(page, "TC-0041");
  await c.locator('input[type="file"]').setInputFiles({ name: "contrast.png", mimeType: "image/png", buffer: Buffer.from("\x89PNG\r\n\x1a\nxx", "latin1") });
  await c.getByRole("radio", { name: "Failed" }).check();
  await c.getByRole("textbox", { name: "What happened" }).fill("Red on pink is 2.9:1");
  await c.getByRole("button", { name: "Save result for TC-0041" }).click();
  await expect(c.getByText("contrast.png: Too many uploads for this project. Try again in 12 minutes.")).toBeVisible();
});

test("another save error: 'Couldn't save TC-0027. …' with [Try again], values kept, then saved (§6, 3.3.7)", async ({ page }) => {
  const { q } = await setup(page, {}, (q) => four(q));
  q.failSave = { status: 500, code: "internal_error", message: "Something went wrong on our side." };
  await page.goto("/projects/p1/execution/RUN-0005/record");
  const c = card(page, "TC-0027");
  await c.getByRole("radio", { name: "Failed" }).check();
  await c.getByRole("textbox", { name: "What happened" }).fill("Posts to http://acme.com/session");
  await c.getByRole("button", { name: "Save result for TC-0027" }).click();
  await expect(c.getByRole("alert")).toContainText("Couldn't save TC-0027. Something went wrong on our side.");
  await expect(c.getByRole("textbox", { name: "What happened" })).toHaveValue("Posts to http://acme.com/session");
  await c.getByRole("alert").getByRole("button", { name: "Try again" }).click();
  await expect(live(page)).toHaveText("TC-0027 saved as Failed. 1 of 4 recorded.");
  await expect(c.getByRole("alert")).toHaveCount(0);
});

test("a server 422 on What happened is shown next to the field, linked and focused (§6)", async ({ page }) => {
  const { q } = await setup(page, {}, (q) => four(q));
  q.failSave = { status: 422, code: "validation_error", message: "Describe what happened.", details: [{ field: "actual_result", message: "Describe what happened." }] };
  await page.goto("/projects/p1/execution/RUN-0005/record");
  const c = card(page, "TC-0033");
  await c.getByRole("radio", { name: "Passed" }).check();
  await c.getByRole("textbox", { name: "What happened" }).fill("   x");
  await c.getByRole("button", { name: "Save result for TC-0033" }).click();
  const what = c.getByRole("textbox", { name: "What happened" });
  await expect(what).toBeFocused();
  await expect(what).toHaveAttribute("aria-invalid", "true");
  await expect(what).toHaveAccessibleDescription(/Describe what happened\./);
});

test("leave guard on the in-app back link: Stay keeps the text; Leave goes to the run page (§4.5)", async ({ page }) => {
  await setup(page, {}, (q) => four(q));
  await page.goto("/projects/p1/execution/RUN-0005/record");
  const c = card(page, "TC-0041");
  await c.getByRole("textbox", { name: "What happened" }).fill("Half typed");
  await page.getByRole("link", { name: "RUN-0005", exact: true }).click();
  const leave = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(leave.getByText("Your changes to TC-0041 aren't saved.")).toBeVisible();
  await expect(leave.getByRole("button", { name: "Stay" })).toBeFocused();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/record$/);
  await expect(c.getByRole("textbox", { name: "What happened" })).toHaveValue("Half typed");
  await page.getByRole("link", { name: "RUN-0005", exact: true }).click();
  await page.getByRole("dialog", { name: "Leave without saving?" }).getByRole("button", { name: "Leave without saving" }).click();
  await expect(page).toHaveURL(/\/execution\/RUN-0005$/);
  await expect(page.getByRole("heading", { level: 1, name: "RUN-0005 · Manual" })).toBeVisible();
});

test("unknown run key: 'We couldn't find RUN-0099 in this project.'; an automated run's record page redirects to its run page (§6)", async ({ page }) => {
  await setup(page);
  await page.goto("/projects/p1/execution/RUN-0099/record");
  await expect(page.getByText("We couldn’t find RUN-0099 in this project.").or(page.getByText("We couldn't find RUN-0099 in this project."))).toBeVisible();
  await page.goto("/projects/p1/execution/RUN-0003/record");
  await expect(page).toHaveURL(/\/execution\/RUN-0003$/);
});

test("a discarded run's record page: grey callout, no cards, no Finish (§6)", async ({ page }) => {
  await setup(page, {}, (q) => {
    const run = four(q);
    Object.assign(run, { status: "cancelled", finished_at: "2026-11-19T16:00:00Z" });
  });
  await page.goto("/projects/p1/execution/RUN-0005/record");
  await expect(page.getByText("RUN-0005 was discarded. Nothing was recorded.")).toBeVisible();
  await expect(page.getByRole("region", { name: /^TC-/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Finish recording/ })).toHaveCount(0);
});
