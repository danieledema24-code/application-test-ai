// Phase 3 journey (P3-09) through the real UI against the running backend (8200), web (3002) and a demo site
// (E2E_SITE_URL, default the local demo shop on :4100): discovery → Gate 3 → Gate 4 → test design → Gate 5 →
// traceability → reports. Signs in with the shared e2e account (helpers.useSharedAccount; the account file
// is never overwritten).
//
//   P3_PROJECT   optional existing project id whose discovery already finished (skips creating a project).
//
// Works with AI off (rules path): assertions are about structure and code-computed numbers, never about
// generated wording. Invitations created here are revoked again; no account is created from them.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { SITE_URL, seriousA11yViolations, useSharedAccount } from "./helpers";

test.describe.configure({ mode: "serial" });

let projectId = process.env.P3_PROJECT ?? "";
const LONG = 15 * 60_000;

async function a11y(page: Page, screen: string) {
  expect.soft(await seriousA11yViolations(page), `axe serious/critical on ${screen}`).toEqual([]);
}

async function noSideways(page: Page, screen: string) {
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const extra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(extra, `${screen} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Waits up to `ms` for the locator to show. (`isVisible({ timeout })` doesn't wait, so it can't be used here.) */
async function appears(l: Locator, ms: number): Promise<boolean> {
  return l.first().waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false);
}

/**
 * Opens a list row's link and waits for the page. The dev server compiles a route on its first visit and drops
 * compiled routes after about a minute idle, so the first navigation after a long generation wait can take
 * 20–30 s (QA BUG-P3-19: measured 24 s for the RSC request; the click itself isn't lost). Production builds
 * precompile routes.
 */
async function openFrom(page: Page, link: Locator, url: RegExp) {
  await link.click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(url, { timeout: 90_000 });
}

async function reloadUntil(page: Page, url: string, check: () => Promise<boolean>, timeout = LONG) {
  const end = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    // Data loads client-side and an event stream stays open ("networkidle" is unreliable): poll after each load.
    const settle = Date.now() + 15_000;
    while (Date.now() < settle) {
      if (await check().catch(() => false)) return;
      await page.waitForTimeout(1_000);
    }
    if (Date.now() > end) throw new Error(`Timed out waiting on ${url}`);
    await page.waitForTimeout(5_000);
  }
}

test.beforeEach(async ({ page }) => {
  await useSharedAccount(page);
});

test("P3 setup: discovery finished and Gate 2 approved", async ({ page }) => {
  test.setTimeout(LONG + 120_000);
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
  const approve = page.getByRole("button", { name: "Approve discovery" });
  if (await approve.count()) {
    await approve.click();
    await expect(page.getByText(/Discovery approved/).first()).toBeVisible();
  }
});

test("Gate 3: requirements generated, some approved, gate approved", async ({ page }) => {
  test.setTimeout(LONG + 60_000);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/requirements`, async () => {
    const gen = page.getByRole("button", { name: "Generate requirements" });
    if (await appears(gen, 3_000)) await gen.click();
    return (await page.getByRole("checkbox", { name: /^Select REQ-/ }).count()) > 0;
  });
  // Approve every draft so test design has approved requirements to work from.
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
  const approve = page.getByRole("button", { name: "Approve requirements" });
  const approved = page.getByText(/Requirements approved/).first();
  // Either the gate is already approved, or Approve appears once the review loads.
  if (!(await appears(approved, 5_000))) {
    await expect(approve).toBeVisible({ timeout: 60_000 });
    await approve.click();
    const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
    if (await appears(confirm, 3_000)) await confirm.getByRole("button", { name: "Approve requirements" }).click();
    await expect(approved).toBeVisible({ timeout: 30_000 });
  }
});

test("Gate 4: strategy written and approved; test design starts automatically", async ({ page }) => {
  test.setTimeout(LONG + 60_000);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/test-strategy`, async () => {
    const write = page.getByRole("button", { name: "Write the Test Strategy" });
    if (await appears(write, 3_000)) await write.click();
    return (await page.getByRole("heading", { name: /Test levels/ }).count()) > 0;
  });
  await page.goto(`${base}/test-strategy?view=review`);
  const approve = page.getByRole("button", { name: "Approve test strategy" });
  const approved = page.getByText(/Strategy approved/).first();
  if (!(await appears(approved, 5_000))) {
    await expect(approve).toBeVisible({ timeout: 60_000 });
    await approve.click();
    await expect(approved).toBeVisible({ timeout: 30_000 });
  }
});

test("P3-01/02/03: test design produces cases with techniques, conditions and synthetic test data", async ({ page }) => {
  test.setTimeout(LONG + 60_000);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/test-cases`, async () => {
    // Auto-advance normally starts it; the button covers a backend without auto-start.
    const start = page.getByRole("button", { name: "Design test cases" });
    if (await appears(start, 3_000)) await start.click();
    return (await page.getByRole("checkbox", { name: /^Select TC-/ }).count()) > 0;
  });
  await expect(page.getByRole("heading", { level: 1, name: "Test Cases" })).toBeVisible();
  await a11y(page, "test cases list");
  await noSideways(page, "test cases list");

  // Detail: every case has steps and an expected result or an open question; execution is "Not run".
  await openFrom(page, page.getByRole("link", { name: /^TC-\d+/ }).first(), /\/test-cases\/TC-\d+/);
  await expect(page.getByRole("heading", { level: 1, name: /TC-\d+/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Not run/).first()).toBeVisible();
  await a11y(page, "test case detail");
  await noSideways(page, "test case detail");

  await page.goto(`${base}/test-cases?view=conditions`);
  await expect(page.getByRole("heading", { level: 1, name: "Test Cases" })).toBeVisible();
  await a11y(page, "conditions");
  await page.goto(`${base}/test-cases?view=data`);
  await expect(page.getByText(/Synthetic data only/).first()).toBeVisible();
  await a11y(page, "test data");
  await noSideways(page, "test data");
});

/** On a case page: approve it if it's a draft. The Approve button stays focusable while blocked, with its reason. */
async function approveCase(page: Page) {
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(approve).not.toHaveAttribute("aria-disabled", "true");
  await approve.click();
  await expect(approve).toHaveCount(0, { timeout: 30_000 });
}

test("P3-02 and Gate 5: answer open questions, cover open high risks, approve cases, then approve the gate", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  if (await appears(page.getByText(/^Test cases approved\./), 3_000)) {
    test.info().annotations.push({ type: "gate5", description: "Already approved in an earlier run of this project" });
    return;
  }

  // 1. Open questions (D6): write the expected result on the case page. Setup steps keep no expected result;
  //    the case needs an overall expected result and one step with one (QA BUG-P3-02). Then approve the case.
  for (let i = 0; i < 10; i++) {
    await page.goto(`${base}/test-cases?oq=1`);
    const row = page.getByRole("link", { name: /^TC-\d+/ });
    if (!(await appears(row, 15_000))) break;
    await openFrom(page, row.first(), /\/test-cases\/TC-\d+(\?|$)/);
    await page.getByRole("button", { name: "Write expected result" }).click();
    const focused = page.locator("textarea:focus");
    await expect(focused).toBeVisible();
    await focused.fill("The form is accepted and a confirmation message is shown.");
    const overall = page.locator("#expected_result");
    if (!(await overall.inputValue()).trim()) await overall.fill("The form is accepted and a confirmation message is shown.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Expected result saved\. TC-\d+ can now be approved\./).first()).toBeVisible({ timeout: 30_000 });
    await approveCase(page);
  }

  // 2. Approve the remaining drafts in bulk; the guard skips cases with Must-fix checks.
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

  // 3. Open High / Very high risks whose requirement has no approved case: write one from the requirement page.
  await page.goto(`${base}/test-cases?view=review`);
  // The checks are computed once the gaps load; with nothing to fix, only "Passed (n)" (collapsed) is there.
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

  // 4. Gate 5: no blockers left, so a person who can approve gates approves it.
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  await a11y(page, "gate 5");
  await noSideways(page, "gate 5");
  const approve = page.getByRole("button", { name: "Approve test cases" });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(approve, await page.locator("main").innerText()).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await approve.click();
  const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
  if (await appears(confirm, 2_000)) await confirm.getByRole("button", { name: "Approve test cases" }).click();
  await expect(page.getByText(/Test cases approved\./).first()).toBeVisible({ timeout: 30_000 });
});

test("P3-04: traceability coverage, matrix and chain view; execution is never a number", async ({ page }) => {
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/traceability`);
  await expect(page.getByRole("heading", { level: 1, name: "Traceability" })).toBeVisible();
  await expect(page.getByText("Requirements covered", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Execution coverage", { exact: true })).toBeVisible();
  await expect(page.getByText("Not available").first()).toBeVisible();
  await a11y(page, "traceability coverage");
  await noSideways(page, "traceability coverage");

  await page.goto(`${base}/traceability?view=matrix`);
  const table = page.getByRole("table", { name: /Forward traceability/ });
  await expect(table).toBeVisible({ timeout: 30_000 });
  await a11y(page, "traceability matrix");
  await noSideways(page, "traceability matrix");
  await table.getByRole("link", { name: /^Trace REQ-/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /^Trace REQ-/ })).toBeVisible();
  await expect(page.getByText(/not available until Phase 4/).first()).toBeVisible();
  await a11y(page, "chain view");
});

test("P3-08: the Test Case Specification and RTM are listed, open and offer CSV", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/reports`);
  const table = page.getByRole("table", { name: "Phase 2 and 3 reports" });
  await expect(table.getByRole("row", { name: /Test Case Specification/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Requirements Traceability Matrix/ })).toBeVisible();
  await a11y(page, "reports");
  for (const slug of ["test-case-spec", "rtm"]) {
    await reloadUntil(page, `${base}/reports/${slug}`, async () => {
      const create = page.getByRole("button", { name: "Create draft from current" });
      if (await appears(create, 2_000) && !(await page.getByRole("button", { name: "Download CSV" }).count())) await create.click();
      return (await page.getByRole("button", { name: "Download CSV" }).count()) > 0;
    }, 3 * 60_000);
    await expect(page.getByText(/DRAFT, not approved at Gate 5|Approved at Gate 5/).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: slug === "rtm" ? /Coverage$/ : /Test cases$/ })).toBeVisible();
    await a11y(page, `report ${slug}`);
    await noSideways(page, `report ${slug}`);
  }
});

test("P3-07: members list and a copyable invitation link that is revoked again", async ({ page, browser }) => {
  await page.goto("/settings/members");
  await expect(page.getByRole("heading", { name: /Members \(\d+\)/ })).toBeVisible();
  await a11y(page, "members");
  await noSideways(page, "members");
  const invite = page.getByRole("button", { name: "Invite people" });
  if (!(await invite.isVisible().catch(() => false))) return; // The shared account isn't an owner/admin here.
  // Revoke invitations an earlier, interrupted run of this test left behind.
  for (const left of await page.getByRole("button", { name: /^Revoke invitation for p3-invite-/ }).all()) {
    await left.click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  const email = `p3-invite-${Date.now()}@example.com`;
  await invite.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("button", { name: "Create invitation link" }).click();
  const link = await dialog.getByLabel("Invitation link").inputValue();
  expect(link).toMatch(/\/invite\//);

  // The public page in a fresh, signed-out context: no shared-account state is touched.
  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { level: 1, name: /^Join .+ on QA Analyst$/ })).toBeVisible();
  await expect(guest.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  expect.soft(await seriousA11yViolations(guest), "axe serious/critical on accept invitation").toEqual([]);

  // Revoke, then the link stops working.
  await dialog.getByRole("button", { name: "Copy invitation link" }).click().catch(() => undefined);
  await dialog.getByRole("button", { name: "Done" }).click();
  const closeConfirm = page.getByRole("dialog", { name: "Close without copying the link?" });
  // The dialog's own X is also named "Close"; the footer button is the last one.
  if (await appears(closeConfirm, 1_000)) await closeConfirm.getByRole("button", { name: "Close without copying" }).click();
  await page.getByRole("button", { name: `Revoke invitation for ${email}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
  await expect(page.getByText("Invitation revoked.")).toBeVisible();
  await guest.goto(link);
  await expect(guest.getByText("This invitation is no longer valid. Ask the person who invited you for a new link.")).toBeVisible();
  await other.close();
});
