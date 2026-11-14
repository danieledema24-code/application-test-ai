// Helpers shared by the real-stack journeys (phase3-journey, phase4-journey).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { seriousA11yViolations, signIn, uniqueEmail, type Account } from "./helpers";

export const LONG = 15 * 60_000;

export async function a11y(page: Page, screen: string) {
  expect.soft(await seriousA11yViolations(page), `axe serious/critical on ${screen}`).toEqual([]);
}

export async function noSideways(page: Page, screen: string) {
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const extra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(extra, `${screen} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Waits up to `ms` for the locator to show. (`isVisible({ timeout })` doesn't wait, so it can't be used here.) */
export async function appears(l: Locator, ms: number): Promise<boolean> {
  return l.first().waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false);
}

/**
 * Opens a list row's link and waits for the page. The dev server compiles a route on its first visit and drops
 * compiled routes after about a minute idle, so the first navigation after a long generation wait can take
 * 20–30 s (QA BUG-P3-19: measured 24 s for the RSC request; the click itself isn't lost). Production builds
 * precompile routes.
 */
export async function openFrom(page: Page, link: Locator, url: RegExp) {
  await link.click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(url, { timeout: 90_000 });
}

export async function reloadUntil(page: Page, url: string, check: () => Promise<boolean>, timeout = LONG) {
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

/** On a case page: approve it if it's a draft. The Approve button stays focusable while blocked, with its reason. */
export async function approveCase(page: Page) {
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(approve).not.toHaveAttribute("aria-disabled", "true");
  await approve.click();
  await expect(approve).toHaveCount(0, { timeout: 30_000 });
}

// Gitignored, like the shared account's file. A member (no gate approval) of the shared account's organisation.
const MEMBER_FILE = path.join(__dirname, "..", "playwright", ".auth", "e2e-member.json");

/**
 * Signs `page` in as a member of the shared account's organisation who can't approve gates. The first time, the
 * shared account (an owner, signed in on `owner`) invites one and the invitation is accepted in a fresh context;
 * the account is then kept in e2e-member.json and reused. Like useSharedAccount, a saved member that can't sign in
 * fails loudly and the file is never overwritten.
 */
export async function signInMember(page: Page, owner: Page, browser: Browser): Promise<Account> {
  const raw = await readFile(MEMBER_FILE, "utf8").catch(() => null);
  if (raw !== null) {
    const saved = JSON.parse(raw) as Account;
    if (await signIn(page, saved)) return saved;
    throw new Error(`Couldn't sign in with the e2e member (${saved.email}) from ${MEMBER_FILE}. If the database was reset, delete the file and run again.`);
  }
  const account = { email: uniqueEmail("member"), password: `member-${Date.now()}-pass` };
  await owner.goto("/settings/members");
  await owner.getByRole("button", { name: "Invite people" }).click();
  const dialog = owner.getByRole("dialog");
  await dialog.getByLabel("Email").fill(account.email);
  // Members can't approve gates by default.
  await dialog.getByRole("button", { name: "Create invitation link" }).click();
  const link = await dialog.getByLabel("Invitation link").inputValue();
  await dialog.getByRole("button", { name: "Copy invitation link" }).click().catch(() => undefined);
  await dialog.getByRole("button", { name: "Done" }).click();
  const closeConfirm = owner.getByRole("dialog", { name: "Close without copying the link?" });
  if (await appears(closeConfirm, 1_000)) await closeConfirm.getByRole("button", { name: "Close without copying" }).click();

  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(link);
  await guest.getByLabel("Full name").fill("Morgan Member");
  await guest.getByRole("textbox", { name: "Password", exact: true }).fill(account.password);
  await guest.getByRole("button", { name: "Create account and join" }).click();
  await expect(guest).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await ctx.close();
  await mkdir(path.dirname(MEMBER_FILE), { recursive: true });
  await writeFile(MEMBER_FILE, JSON.stringify(account), { flag: "wx" });
  expect(await signIn(page, account)).toBe(true);
  return account;
}
