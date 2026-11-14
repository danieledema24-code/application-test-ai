// Phase 4 journey (P4-15, design P4 §15) through the real UI against the running backend (8200), web (3002) and
// the demo shop (E2E_SITE_URL, default :4100), AI off: Phase 3 to Gate 5 with "Submission is blocked and Message is
// identified as required" for the empty-Message case → automation and G6 → a member requests the run and can't
// authorise it → an approver authorises (G7) → live view → the case fails, "Likely bug in the application", a DEF
// draft → a member can't confirm it, the approver does (G8) → traceability chain and gaps match the API →
// Test Execution and Defect reports downloaded (PDF, CSV) → the analyst explains the failed test.
//
// Signs in with the shared e2e account (an owner, so it can approve gates) and a member without gate approval,
// invited once and kept in playwright/.auth/e2e-member.json (journey.signInMember). Neither file is overwritten.
//
//   P4_PROJECT   optional existing project id on the demo shop (steps already done are skipped).
//
// The run submits the demo shop's contact form once per attempt: that is the bug being demonstrated.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { SITE_URL, useSharedAccount } from "./helpers";
import { LONG, a11y, appears, approveCase, noSideways, openFrom, reloadUntil, signInMember } from "./journey";

test.describe.configure({ mode: "serial" });

const EXPECTED = "Submission is blocked and Message is identified as required";
const OTHER_EXPECTED = "The form is accepted and a confirmation message is shown.";
const API = `${(process.env.E2E_API_URL ?? "http://localhost:8200").replace(/\/+$/, "")}/api/v1`;

let projectId = process.env.P4_PROJECT ?? "";
let emptyKey = "";
let runKey = "";
let defectKey = "";

test.beforeEach(async ({ page }) => {
  await useSharedAccount(page);
});

/** The member, in a context of its own; closed by the caller. */
async function memberPage(browser: Browser, owner: Page): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInMember(page, owner, browser);
  return page;
}

/** GET on the API with the signed-in page's token, for "matches the API" checks. */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  const token = await page.evaluate(() => window.localStorage.getItem("qa_token"));
  const r = await page.request.get(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(r.status(), path).toBe(200);
  return (await r.json()) as T;
}

test("Setup: discovery approved, requirements and strategy approved (Gates 2–4)", async ({ page }) => {
  test.setTimeout(3 * LONG);
  if (!projectId) {
    await page.goto(`/projects/new?url=${encodeURIComponent(SITE_URL)}`);
    await page.getByRole("checkbox", { name: /authorised to test/i }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    const dup = page.getByRole("button", { name: /Create anyway/ });
    if (await dup.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false)) await dup.click();
    await page.waitForURL(/\/projects\/[^/]+\/discovery/, { timeout: 60_000 });
    projectId = page.url().match(/\/projects\/([^/]+)\//)![1];
  }
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/discovery?view=summary`, async () => (await page.getByRole("button", { name: "Approve discovery" }).count()) > 0 || (await page.getByText(/Discovery approved/).count()) > 0);
  const discovery = page.getByRole("button", { name: "Approve discovery" });
  if (await discovery.count()) {
    await discovery.click();
    await expect(page.getByText(/Discovery approved/).first()).toBeVisible();
  }

  await reloadUntil(page, `${base}/requirements`, async () => {
    const gen = page.getByRole("button", { name: "Generate requirements" });
    if (await appears(gen, 3_000)) await gen.click();
    return (await page.getByRole("checkbox", { name: /^Select REQ-/ }).count()) > 0;
  });
  await page.goto(`${base}/requirements?status=draft`);
  const boxes = page.getByRole("checkbox", { name: /^Select REQ-/ });
  await boxes.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  if ((await boxes.count()) > 0) {
    await page.getByRole("checkbox", { name: /Select all/ }).first().check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve \d+$/ }).click();
    const guard = page.getByRole("dialog", { name: /^Approve \d+ requirements?\?$/ });
    if (await appears(guard, 2_000)) await guard.getByRole("button", { name: /^Approve/ }).last().click();
  }
  await page.goto(`${base}/requirements?view=review`);
  const reqApproved = page.getByText(/Requirements approved/).first();
  if (!(await appears(reqApproved, 5_000))) {
    await page.getByRole("button", { name: "Approve requirements" }).click({ timeout: 60_000 });
    const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
    if (await appears(confirm, 3_000)) await confirm.getByRole("button", { name: "Approve requirements" }).click();
    await expect(reqApproved).toBeVisible({ timeout: 30_000 });
  }

  await reloadUntil(page, `${base}/test-strategy`, async () => {
    const write = page.getByRole("button", { name: "Write the Test Strategy" });
    if (await appears(write, 3_000)) await write.click();
    return (await page.getByRole("heading", { name: /Test levels/ }).count()) > 0;
  });
  await page.goto(`${base}/test-strategy?view=review`);
  const strategyApproved = page.getByText(/Strategy approved/).first();
  if (!(await appears(strategyApproved, 5_000))) {
    await page.getByRole("button", { name: "Approve test strategy" }).click({ timeout: 60_000 });
    await expect(strategyApproved).toBeVisible({ timeout: 30_000 });
  }
});

test("§15.1 Gate 5: the empty-Message case expects the submission to be blocked; cases and the gate approved", async ({ page }) => {
  test.setTimeout(LONG + 15 * 60_000);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/test-cases`, async () => {
    const start = page.getByRole("button", { name: "Design test cases" });
    if (await appears(start, 3_000)) await start.click();
    return (await page.getByRole("checkbox", { name: /^Select TC-/ }).count()) > 0;
  });
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  if (!(await appears(page.getByText(/^Test cases approved\./), 3_000))) {
    // Open questions (D6): the empty-Message case gets the demo's expected result; the others a confirmation.
    for (let i = 0; i < 12; i++) {
      await page.goto(`${base}/test-cases?oq=1`);
      const row = page.getByRole("link", { name: /^TC-\d+/ });
      if (!(await appears(row, 15_000))) break;
      await openFrom(page, row.first(), /\/test-cases\/TC-\d+(\?|$)/);
      const heading = page.getByRole("heading", { level: 1, name: /TC-\d+/ });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      const text = /empty Message/i.test(await heading.innerText()) ? EXPECTED : OTHER_EXPECTED;
      await page.getByRole("button", { name: "Write expected result" }).click();
      const focused = page.locator("textarea:focus");
      await expect(focused).toBeVisible();
      await focused.fill(text);
      const overall = page.locator("#expected_result");
      if (!(await overall.inputValue()).trim() || text === EXPECTED) await overall.fill(text);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/Expected result saved\. TC-\d+ can now be approved\./).first()).toBeVisible({ timeout: 30_000 });
      await approveCase(page);
    }
    // The remaining drafts in bulk; the guard skips cases with Must-fix checks.
    await page.goto(`${base}/test-cases?status=draft`);
    const boxes = page.getByRole("checkbox", { name: /^Select TC-/ });
    if (await appears(boxes, 15_000)) {
      await page.getByRole("checkbox", { name: /Select all/ }).first().check();
      await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve/ }).first().click();
      const guard = page.getByRole("dialog");
      if (await appears(guard, 3_000)) {
        const go = guard.getByRole("button", { name: /^Approve \d+$/ });
        if ((await go.getAttribute("aria-disabled")) !== "true" && (await go.isEnabled())) await go.click();
        else await guard.getByRole("button", { name: "Cancel" }).click();
      }
      await expect(page.getByText(/test cases? approved\./).first()).toBeVisible({ timeout: 30_000 }).catch(() => undefined);
    }
    // Open High / Very high risks without an approved case: one case from each requirement page.
    await page.goto(`${base}/test-cases?view=review`);
    await expect(page.getByRole("heading", { name: /^(Passed|Must fix before approval) \(\d+\)/ }).first()).toBeVisible({ timeout: 30_000 });
    const reqKeys = [...new Set((await page.getByRole("link", { name: /^Show test cases for REQ-\d+$/ }).allInnerTexts()).map((t) => t.replace("Show test cases for ", "")))];
    for (const key of reqKeys) {
      await page.goto(`${base}/requirements/${key}`);
      await openFrom(page, page.getByRole("link", { name: `New test case for ${key}` }), /\/test-cases\/new/);
      await expect(page.getByRole("heading", { level: 1, name: /New test case/ })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel("Title").fill(`Sign-in page for ${key} is served over HTTPS`);
      await page.getByLabel("Objective").fill(`Confirm the page that ${key} covers is only reachable over a secure connection.`);
      await page.getByLabel("Technique").selectOption({ label: "Use case" });
      await page.locator("#step-0-action").fill("Open the sign-in page using an http:// address");
      await page.locator("#step-0-expected").fill("The browser ends on an https:// address with no security warning");
      await page.locator("#expected_result").fill("The sign-in form is only shown over HTTPS");
      await page.getByRole("button", { name: "Create test case" }).click();
      await expect(page).toHaveURL(/\/test-cases\/TC-\d+(\?|$)/, { timeout: 90_000 });
      await approveCase(page);
    }
    await page.goto(`${base}/test-cases?view=review`);
    const approve = page.getByRole("button", { name: "Approve test cases" });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await expect(approve, await page.locator("main").innerText()).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await approve.click();
    const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
    if (await appears(confirm, 2_000)) await confirm.getByRole("button", { name: "Approve test cases" }).click();
    await expect(page.getByText(/Test cases approved\./).first()).toBeVisible({ timeout: 30_000 });
  }
  // The empty-Message case carries the expected result the run will check.
  await page.goto(`${base}/test-cases?q=${encodeURIComponent("empty Message")}`);
  const link = page.getByRole("link", { name: /^TC-\d+/ }).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  emptyKey = (await link.innerText()).match(/TC-\d+/)![0];
  await openFrom(page, link, /\/test-cases\/TC-\d+(\?|$)/);
  await expect(page.getByText(EXPECTED).first()).toBeVisible({ timeout: 30_000 });
});

test("§15.2 Automation: assessed, scripts written by rules and checked; G6 passed automatically", async ({ page }) => {
  test.setTimeout(LONG);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/automation?view=review`, async () => (await page.getByText(/^Passed automatically/).count()) > 0);
  await a11y(page, "automation review");
  await page.goto(`${base}/automation?view=scripts&file=${encodeURIComponent(`tests/contact/${emptyKey}.spec.ts`)}`);
  await expect(page.getByText("await qa.expectSubmissionBlocked(contact.form);").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Generated by rules").first()).toBeVisible();
  await noSideways(page, "script viewer");
});

test("§15.3 G7: a member requests the run and can't authorise it; the approver authorises it", async ({ page, browser }) => {
  test.setTimeout(5 * 60_000);
  const base = `/projects/${projectId}`;
  const member = await memberPage(browser, page);
  try {
    await member.goto(`${base}/execution?new=1`);
    const dialog = member.getByRole("dialog", { name: "Run tests" });
    await expect(dialog.getByText("Step 1 of 2 · What to run")).toBeVisible({ timeout: 30_000 });
    // Only the empty-Message case: one test, so DEF-0001 is the demo's bug and the run takes about a minute.
    await dialog.getByText("Choose test cases…").click();
    await dialog.getByLabel("Find a test case").fill(emptyKey);
    await dialog.getByRole("checkbox", { name: new RegExp(`^${emptyKey}\\b`) }).check();
    await dialog.getByRole("button", { name: "Next: check what this run will do" }).click();
    await expect(dialog.getByText("Step 2 of 2 · Authorise")).toBeVisible();
    await expect(dialog.getByText(/May submit the Contact us form \(if the application does not block it\): 1 test/)).toBeVisible();
    await expect(dialog.getByText("Nothing runs until someone who can approve gates authorises it.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Authorise and run/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Request authorisation" }).click();
    await expect(member).toHaveURL(/\/execution\/RUN-\d+/, { timeout: 30_000 });
    runKey = member.url().match(/RUN-\d+/)![0];
    const waiting = member.getByRole("region", { name: `Gate 7 · Authorise ${runKey}` });
    await expect(waiting.getByText("Authorising runs needs gate-approval permission.", { exact: false })).toBeVisible();
    await expect(waiting.getByRole("button", { name: /Authorise and run/ })).toHaveCount(0);
    await a11y(member, "G7 waiting (member)");
  } finally {
    await member.context().close();
  }

  await page.goto(`${base}/execution/${runKey}`);
  const panel = page.getByRole("region", { name: `Gate 7 · Authorise ${runKey}` });
  await expect(panel.getByText("Waiting for your authorisation")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Requested by Morgan Member", { exact: false })).toBeVisible();
  await a11y(page, "G7 review (approver)");
  await panel.getByRole("button", { name: "Authorise and run 1 test" }).click();
  await expect(page.getByText(new RegExp(`${runKey} authorised|Authorised`)).first()).toBeVisible({ timeout: 30_000 });
});

test("§15.4–5 Live view while it runs; the empty-Message case fails as a likely bug with a DEF draft", async ({ page }) => {
  test.setTimeout(LONG);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/execution/${runKey}`);
  const live = page.getByRole("region", { name: "Live view of the test browser" });
  const sawLive = await appears(live, 120_000);
  // The run is short: if it finished before the page loaded, say so instead of failing the journey.
  if (!sawLive) test.info().annotations.push({ type: "live view", description: `${runKey} finished before the live view showed` });
  else await expect(page.getByText("Frames aren't saved. Failed tests keep a video recording.")).toBeVisible();

  const why = page.getByRole("region", { name: "What failed and why" });
  await reloadUntil(page, `${base}/execution/${runKey}`, async () => (await why.getByText(/DEF-\d+ drafted/).count()) > 0, 10 * 60_000);
  defectKey = (await why.getByText(/DEF-\d+ drafted/).first().innerText()).match(/DEF-\d+/)![0];
  await expect(page.getByText("Finished · 1 failed").first()).toBeVisible();
  await a11y(page, "run page");
  await noSideways(page, "run page");

  await page.goto(`${base}/execution/${runKey}/results/${runKey}-01`);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`${runKey}-01 · ${emptyKey}`) })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("failed on both attempts (2 of 2)", { exact: false })).toBeVisible();
  const ea = page.getByRole("region", { name: "Expected and actual" });
  await expect(ea.getByText(EXPECTED).first()).toBeVisible();
  await expect(ea.getByText(/Thank you/).first()).toBeVisible();
  const cause = page.getByRole("region", { name: "Why it failed" });
  await expect(cause.getByText("Likely bug in the application").first()).toBeVisible();
  await expect(cause.getByText(/^Hypothesis/)).toBeVisible();
  await expect(cause.getByText("Generated by rules (AI not configured)")).toBeVisible();
  await expect(cause.getByRole("link", { name: `Open ${defectKey}` })).toBeVisible();
  await expect(page.getByRole("region", { name: "Evidence" }).getByRole("img").first()).toBeVisible();
  await a11y(page, "result detail");
});

test("§15.6 G8: a member can't confirm the draft; the approver confirms it", async ({ page, browser }) => {
  test.setTimeout(3 * 60_000);
  const base = `/projects/${projectId}`;
  const member = await memberPage(browser, page);
  try {
    await member.goto(`${base}/defects?view=review`);
    const gate = member.getByRole("region", { name: "Gate 8 · Defect review" });
    await expect(gate.getByText("confirming or rejecting needs gate-approval permission", { exact: false })).toBeVisible({ timeout: 30_000 });
    const confirm = gate.getByRole("button", { name: `Confirm ${defectKey}` });
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await confirm.click({ force: true });
    await expect(member.getByText(`${defectKey} confirmed.`)).toHaveCount(0);
  } finally {
    await member.context().close();
  }

  await page.goto(`${base}/defects/${defectKey}`);
  await expect(page.getByRole("heading", { level: 1, name: `${defectKey} · Contact form accepts an empty Message` })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("2 of 2 attempts (always)")).toBeVisible();
  await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
  await page.goto(`${base}/defects?view=review`);
  const gate = page.getByRole("region", { name: "Gate 8 · Defect review" });
  await gate.getByRole("button", { name: `Confirm ${defectKey}` }).click({ timeout: 30_000 });
  await expect(page.getByText(`${defectKey} confirmed.`).first()).toBeVisible({ timeout: 30_000 });
  await a11y(page, "gate 8");
});

test("§15.7 Traceability: the chain reaches the defect; the gap lists match the API", async ({ page }) => {
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/traceability/${defectKey}`);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`Trace ${defectKey}`) })).toBeVisible({ timeout: 30_000 });
  for (const t of ["Requirement", "Test case", "Script", "Result", "Defect"]) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`^${emptyKey}\\.spec\\.ts v\\d+`) }).first()).toBeVisible();
  await a11y(page, "chain view");

  const gaps = await apiGet<{ failed_tests: { case: { key: string } }[]; flaky_tests: unknown[] }>(page, `/projects/${projectId}/traceability/gaps`);
  expect(gaps.failed_tests.map((x) => x.case.key)).toContain(emptyKey);
  await page.goto(`${base}/traceability`);
  await expect(page.getByText(`Failed tests (${gaps.failed_tests.length})`).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Needs test execution", { exact: true })).toHaveCount(0);
  await a11y(page, "traceability coverage");
});

test("§15.8 Test Execution and Defect reports: downloaded as PDF and CSV", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const base = `/projects/${projectId}`;
  for (const url of [`${base}/reports/test-execution?run=${runKey}`, `${base}/reports/defects`]) {
    await reloadUntil(page, url, async () => {
      const create = page.getByRole("button", { name: "Create draft from current" });
      if ((await appears(create, 2_000)) && !(await page.getByRole("button", { name: "Download CSV" }).count())) await create.click();
      return (await page.getByRole("button", { name: "Download CSV" }).count()) > 0;
    }, 3 * 60_000);
    await expect(page.getByText(defectKey).first()).toBeVisible();
    for (const [button, ext] of [["Download PDF", ".pdf"], ["Download CSV", ".csv"]] as const) {
      const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: button }).click()]);
      expect(file.suggestedFilename()).toMatch(new RegExp(`\\${ext}$`));
    }
    await a11y(page, `report ${url}`);
  }
});

test("§15.10 The analyst explains the failed test from stored results", async ({ page }) => {
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/assistant`);
  const tasks = page.getByRole("complementary", { name: "Tasks" });
  await tasks.getByRole("button", { name: /Explain a failed test/ }).click({ timeout: 30_000 });
  await tasks.getByLabel("Result or test case (optional)").fill(`${runKey}-01`);
  await tasks.getByRole("button", { name: "Explain", exact: true }).click();
  const answer = page.getByRole("article").filter({ hasText: defectKey }).last();
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer.getByText(/application_defect/).first()).toBeVisible();
  await expect(answer.getByText(/Hypothesis/).first()).toBeVisible();
  await a11y(page, "assistant");
});
