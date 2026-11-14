// QA verification of Phase 4 (round 1), through the real UI, against a project that the phase4-journey has taken to
// G8 (P4QA_PROJECT). Accounts come from a JSON file outside the repo (P4QA_ACCOUNTS: {mo, avery, vera} each
// {email, password}); nothing is written back. Screenshots go to P4QA_SHOTS. Product defects are recorded as soft
// assertions so one run reports all of them.
//
//   P4QA_PROJECT=<id> P4QA_ACCOUNTS=/path/accounts.local.txt P4QA_SHOTS=/path/shots \
//     npx playwright test e2e/phase4-qa-verification.spec.ts --project=e2e --workers=1
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seriousA11yViolations, signIn, type Account } from "./helpers";
import { appears } from "./journey";

test.describe.configure({ mode: "default" });

const PROJECT = process.env.P4QA_PROJECT ?? "";
const SHOTS = process.env.P4QA_SHOTS ?? "test-results/p4qa-shots";
const accounts = (): Record<string, Account> => JSON.parse(readFileSync(process.env.P4QA_ACCOUNTS ?? "", "utf8"));
const base = () => `/projects/${PROJECT}`;
let runKey = process.env.P4QA_RUN ?? ""; // set to continue Q2/Q3 after Q1 recorded soft failures

async function as(page: Page, who: "mo" | "avery" | "vera") {
  expect(await signIn(page, accounts()[who]), `sign in as ${who}`).toBe(true);
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
async function axe(page: Page, screen: string) {
  expect.soft(await seriousA11yViolations(page), `axe serious/critical on ${screen}`).toEqual([]);
}
async function sideways(page: Page, screen: string) {
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(500);
    const extra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(extra, `${screen} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
    if (width === 375) await shot(page, `375-${screen.replace(/\W+/g, "-")}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.beforeAll(() => {
  if (!PROJECT) throw new Error("Set P4QA_PROJECT");
});

test("Q1 member: Regression request shows the G7 summary and waits; nothing to authorise", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await as(page, "mo");
  await page.goto(`${base()}/execution?new=1`);
  const dialog = page.getByRole("dialog", { name: "Run tests" });
  await expect(dialog.getByText("Step 1 of 2 · What to run")).toBeVisible({ timeout: 60_000 });
  await expect.soft(dialog.getByRole("checkbox", { name: /Chromium/ })).toBeChecked();
  await expect.soft(dialog.getByRole("checkbox", { name: /Mobile/ })).not.toBeChecked();
  await expect.soft(dialog.getByText("Not installed on this server").first()).toBeVisible();
  await dialog.getByText(/^Regression/).first().click();
  await shot(page, "q1-step1");
  await axe(page, "run dialog step 1");
  await dialog.getByRole("button", { name: "Next: check what this run will do" }).click();
  await expect(dialog.getByText("Step 2 of 2 · Authorise")).toBeVisible();
  const text = await dialog.innerText();
  expect.soft(text).toContain("May submit the Contact us form (if the application does not block it)");
  expect.soft(text).toMatch(/Pays, buys or deletes anything: no/);
  expect.soft(text).toMatch(/runs once more/i);
  expect.soft(text).toContain("Nothing runs until someone who can approve gates authorises it.");
  await expect.soft(dialog.getByRole("button", { name: /Authorise and run/ })).toHaveCount(0);
  await shot(page, "q1-step2");
  await axe(page, "run dialog step 2");
  await dialog.getByRole("button", { name: "Request authorisation" }).click();
  await expect(page).toHaveURL(/\/execution\/RUN-\d+/, { timeout: 60_000 });
  runKey = page.url().match(/RUN-\d+/)![0];
  await expect(page.getByText("Waiting for authorisation").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "q1-waiting-member");
  await axe(page, "run waiting (member)");
});

test("Q2 viewer: read only on execution, run, defects and automation; no Phase 4 'coming' copy", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await as(page, "vera");
  await page.goto(`${base()}/execution`);
  await expect(page.getByRole("heading", { level: 1, name: /Test Execution/ })).toBeVisible({ timeout: 60_000 });
  await expect.soft(page.getByRole("button", { name: /Run tests/ })).toHaveCount(0);
  await page.goto(`${base()}/execution/${runKey}`);
  await expect(page.getByText(runKey).first()).toBeVisible({ timeout: 60_000 });
  await expect.soft(page.getByRole("button", { name: /Authorise and run|Reject request|Withdraw|Cancel run/ })).toHaveCount(0);
  await page.goto(`${base()}/defects?view=review`);
  await expect(page.getByRole("heading", { level: 1, name: /Defects/ })).toBeVisible({ timeout: 60_000 });
  await expect.soft(page.getByRole("button", { name: /^Confirm|^Reject|Raise defect/ })).toHaveCount(0);
  await expect.soft(page.getByRole("checkbox")).toHaveCount(0);
  await page.goto(`${base()}/automation`);
  await expect(page.getByRole("heading", { level: 1, name: /Automation/ })).toBeVisible({ timeout: 60_000 });
  await expect.soft(page.getByRole("button", { name: /Validate again|Regenerate|Download Playwright project/ })).toHaveCount(0);
  for (const p of ["", "/traceability", "/test-cases", "/reports", "/assistant", "/automation", "/execution", "/defects"]) {
    await page.goto(`${base()}${p}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(4_000);
    const body = await page.locator("body").innerText();
    expect.soft(body, `page ${p || "/"} promises Phase 4`).not.toMatch(/Coming in Phase 4|until Phase 4|arrives in Phase 4|after test execution \(Phase 4\)|assessed in Phase 4/);
  }
  await shot(page, "q2-viewer-defects");
});

test("Q3 approver: authorises the request; live view pause; results replace the live view", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await as(page, "avery");
  await page.goto(`${base()}/execution/${runKey}`);
  const panel = page.getByRole("region", { name: `Gate 7 · Authorise ${runKey}` });
  await expect(panel.getByText("Waiting for your authorisation")).toBeVisible({ timeout: 60_000 });
  await expect.soft(panel.getByText("Requested by Mo Plainmember", { exact: false })).toBeVisible();
  expect.soft(await panel.innerText()).toContain("May submit the Contact us form (if the application does not block it)");
  await axe(page, "G7 review (approver)");
  await panel.getByRole("button", { name: /^Authorise and run \d+ tests?$/ }).click();
  const live = page.getByRole("region", { name: "Live view of the test browser" });
  if (await appears(live, 120_000)) {
    const pause = live.getByRole("button", { name: "Pause live view" });
    await expect.soft(pause).toBeVisible();
    if (await pause.count()) {
      await pause.click();
      await expect.soft(live.getByRole("button", { name: /Resume live view/ })).toBeVisible();
    }
    await shot(page, "q3-live-paused");
    await axe(page, "live view");
    const img = live.getByRole("img").first();
    if (await appears(img, 20_000)) expect.soft(await img.getAttribute("alt")).toMatch(/^Live view of the test browser/);
  } else test.info().annotations.push({ type: "live", description: "live view not seen" });
  // Finished: either the "What failed and why" card or the all-passed line (design §9.1).
  const done = page.getByRole("region", { name: "What failed and why" }).or(page.getByText(/^Finished/).first());
  for (let i = 0; i < 60 && !(await done.count()); i++) {
    await page.waitForTimeout(10_000);
    await page.reload();
  }
  await expect(done.first()).toBeVisible({ timeout: 60_000 });
  await expect.soft(page.getByRole("region", { name: "Live view of the test browser" })).toHaveCount(0);
  await expect.soft(page.getByText(/^Running$/)).toHaveCount(0);
  await shot(page, "q3-run-finished");
  await axe(page, "run finished");
  await sideways(page, "run page");
  for (const p of ["/execution", "/defects", "/defects?view=review", "/automation", "/automation?view=scripts", "/traceability"]) {
    await page.goto(`${base()}${p}`);
    await page.waitForTimeout(5_000);
    await axe(page, p);
    await sideways(page, p);
  }
});
