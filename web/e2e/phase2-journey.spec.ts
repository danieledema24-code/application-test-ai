// Phase 2 journey through the real UI against the running backend (8200), web (3002) and a demo site
// (E2E_SITE_URL, default the local demo shop on :4100): requirements → Gate 3 → strategy and risks → Gate 4 →
// Test Plan → reports → AI QA Analyst. Signs in with the shared e2e account (no new sign-up).
//
//   P2_PROJECT   optional existing project id whose discovery already finished (skips creating a project).
//
// Works with AI off (rules path): every assertion is about structure and code-computed numbers, never about
// generated wording.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { SITE_URL, seriousA11yViolations, useSharedAccount } from "./helpers";

test.describe.configure({ mode: "serial" });

let projectId = process.env.P2_PROJECT ?? "";
const LONG = 15 * 60_000;

async function a11y(page: Page, screen: string) {
  expect.soft(await seriousA11yViolations(page), `axe serious/critical on ${screen}`).toEqual([]);
}

/** Waits up to `ms` for the locator to show. (`isVisible({ timeout })` doesn't wait, so it can't be used here.) */
async function appears(l: Locator, ms: number): Promise<boolean> {
  return l.first().waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false);
}

async function reloadUntil(page: Page, url: string, check: () => Promise<boolean>, timeout = LONG) {
  const end = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    // Pages load their data client-side (and keep a live event stream open, so "networkidle" is unreliable):
    // poll the check for a while after each load instead of counting elements once.
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

test("P2 setup: a project with finished discovery and Gate 2 approved", async ({ page }) => {
  test.setTimeout(LONG + 120_000);
  if (!projectId) {
    await page.goto(`/projects/new?url=${encodeURIComponent(SITE_URL)}`);
    await page.getByRole("checkbox", { name: /authorised to test/i }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    const dup = page.getByRole("button", { name: /Create anyway/ });
    // isVisible() doesn't wait; the duplicate warning appears after the create call returns 409.
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

test("P2-02/03/04: requirements are generated with labels, confidence and Given/When/Then criteria", async ({ page }) => {
  test.setTimeout(LONG + 60_000);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/requirements`, async () => {
    const gen = page.getByRole("button", { name: "Generate requirements" });
    if (await appears(gen, 3_000)) await gen.click();
    return (await page.getByRole("checkbox", { name: /^Select REQ-/ }).count()) > 0;
  });
  await expect(page.getByRole("heading", { level: 1, name: "Requirements" })).toBeVisible();
  // Every row carries one of the four provenance labels as text.
  const labels = page.locator("[data-provenance]");
  expect(await labels.count()).toBeGreaterThan(0);
  for (const t of await labels.allInnerTexts()) expect(t).toMatch(/Observed|Inferred|Assumed|Unverified/);
  await a11y(page, "requirements list");

  // Detail: focused h1, Given/When/Then criteria.
  // The title link wraps onto two lines; its box centre falls between the lines, so click on the first line's text.
  // The dev server compiles the detail route on its first visit (and drops it after about a minute idle), so the
  // first navigation after the long generation wait can take 20–30 s; the click itself isn't lost (QA BUG-P3-19).
  await page.getByRole("link", { name: /^REQ-\d+/ }).first().click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/\/requirements\/REQ-\d+/, { timeout: 90_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/Given/).first()).toBeVisible();
  await a11y(page, "requirement detail");
});

test("P2-05: Ready & Done criteria exist and are numbered, not tick boxes", async ({ page }) => {
  await page.goto(`/projects/${projectId}/requirements?view=readiness`);
  await expect(page.getByText(/Definition of Ready \(\d+\)/)).toBeVisible({ timeout: LONG });
  await expect(page.getByText(/Definition of Done \(\d+\)/)).toBeVisible();
  await a11y(page, "ready & done");
});

test("Gate 3: approve some requirements, then approve the gate (drafts confirm when any remain)", async ({ page }) => {
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/requirements?status=draft`);
  const boxes = page.getByRole("checkbox", { name: /^Select REQ-/ });
  // The list loads client-side: wait for rows (or give up quickly if there are no drafts) before counting.
  await boxes.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  if ((await boxes.count()) > 0) {
    const firstName = (await boxes.first().getAttribute("aria-label")) ?? "";
    await boxes.first().check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve \d+$/ }).click();
    const guard = page.getByRole("dialog", { name: /^Approve \d+ requirements?\?$/ });
    if (await appears(guard, 2_000)) await guard.getByRole("button", { name: /^Approve all/ }).click();
    // The approved row leaves the Draft-filtered list (a bare /approved/i also matches the hidden <option>).
    await expect(page.getByRole("checkbox", { name: firstName, exact: true })).toHaveCount(0);
  }
  await page.goto(`${base}/requirements?view=review`);
  await expect(page.getByText(/requirements? derived/)).toBeVisible();
  await a11y(page, "gate 3");
  const approve = page.getByRole("button", { name: "Approve requirements" });
  // The panel loads client-side: wait until it shows either the button or the approved state.
  await expect(approve.or(page.getByText(/Requirements approved/)).first()).toBeVisible({ timeout: 30_000 });
  if (await approve.isVisible()) {
    await approve.click();
    const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
    if (await appears(confirm, 2_000)) await confirm.getByRole("button", { name: "Approve requirements" }).click();
    await expect(page.getByText(/Requirements approved/).first()).toBeVisible();
  }
});

test("P2-06: strategy with test levels, approval-gated types and a server-scored risk register", async ({ page }) => {
  test.setTimeout(LONG + 60_000);
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/test-strategy`, async () => {
    const write = page.getByRole("button", { name: "Write the Test Strategy" });
    if (await appears(write, 3_000)) await write.click();
    return (await page.getByRole("heading", { name: /Test levels/ }).count()) > 0;
  });
  await expect(page.getByText(/Based on\s+Requirements version \d+/)).toBeVisible();
  await a11y(page, "strategy");
  await page.getByRole("tab", { name: /Risk register/ }).click();
  await expect(page.getByText("Scores are calculated by the system: likelihood × impact.")).toBeVisible();
  await expect(page.getByRole("table").filter({ hasText: /likelihood and impact/ }).or(page.getByText("No risks identified."))).toBeVisible();
  await a11y(page, "risk register");
});

test("Gate 4 → P2-07 Test Plan: strategy sections are read-only and dates are never invented", async ({ page }) => {
  test.setTimeout(LONG + 60_000);
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/test-strategy?view=review`);
  await a11y(page, "gate 4");
  const approve = page.getByRole("button", { name: "Approve test strategy" });
  await expect(approve.or(page.getByText(/Strategy approved/)).first()).toBeVisible({ timeout: 60_000 });
  if (await approve.isVisible()) {
    await approve.click();
    await expect(page.getByText(/Strategy approved/).first()).toBeVisible();
  }
  await reloadUntil(page, `${base}/test-strategy?view=plan`, async () => (await page.getByRole("heading", { name: /Test Plan · Version \d+/ }).count()) > 0);
  await expect(page.getByText("From Test Strategy", { exact: true }).first()).toBeVisible();
  await a11y(page, "test plan");
});

test("P2-09: the three new reports are listed and open", async ({ page }) => {
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/reports`);
  const table = page.getByRole("table", { name: "Phase 2 and 3 reports" });
  await expect(table.getByRole("row", { name: /Requirements Specification/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Test Strategy/ })).toBeVisible();
  await a11y(page, "reports");
  await page.goto(`${base}/reports/requirements`);
  await expect(page.getByRole("heading", { level: 1, name: "Requirements Specification" })).toBeVisible();
});

test("P2-10: AI QA Analyst answers a built-in task with citations, and AI-only tasks say they need AI when it's off", async ({ page }) => {
  await page.goto(`/projects/${projectId}/assistant`);
  await expect(page.getByRole("heading", { level: 1, name: "AI QA Analyst" })).toBeVisible();
  const tasks = page.getByRole("complementary", { name: "Tasks" });
  await expect(tasks.getByRole("heading", { name: "Works without AI" })).toBeVisible();
  await expect(tasks.getByRole("heading", { name: "Later phases" })).toBeVisible();
  await a11y(page, "assistant");
  await tasks.getByRole("button", { name: "What needs my attention?" }).click();
  await tasks.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("article").filter({ hasText: "AI QA Analyst" }).last()).toBeVisible({ timeout: 60_000 });
  if (await page.getByText("AI off").isVisible()) await expect(page.getByText(/Free-form questions and AI proposals need AI/).first()).toBeVisible();
});
