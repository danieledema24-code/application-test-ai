import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Site the backend scans in the real-stack journey. Default: the local demo shop on :4100. Local
 * targets need the backend's dev setting ALLOW_PRIVATE_TARGETS=true (it reports
 * `allow_private_targets` on GET /health, and the web client then defers to the server check).
 */
export const SITE_URL = process.env.E2E_SITE_URL ?? "http://localhost:4100/";

export function uniqueEmail(prefix = "qa") {
  // `.test` is a special-use TLD that the backend's email validation rejects outside its own pytest config,
  // so a real (dev) backend answered 422 and every register() call failed. example.com is reserved but accepted.
  return `${prefix}+${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

export async function register(page: Page, opts: { name?: string; email?: string; org?: string; password?: string } = {}) {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? "correct horse battery staple";
  await page.goto("/register");
  await page.getByLabel("Full name").fill(opts.name ?? "Erin Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByLabel("Organisation name").fill(opts.org ?? "E2E Org");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { email, password };
}

export type Account = { email: string; password: string };

// Gitignored. Keeps one account across tests and runs: the backend allows 5 sign-ups per hour per IP.
const ACCOUNT_FILE = path.join(__dirname, "..", "playwright", ".auth", "e2e-account.json");

export async function signIn(page: Page, account: Account): Promise<boolean> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs in with the shared e2e account, registering it once if it doesn't exist yet (or no longer
 * works, e.g. after a database reset). Use this unless the test is about sign-up itself.
 */
export async function useSharedAccount(page: Page): Promise<Account> {
  let saved: Account | null = null;
  try {
    saved = JSON.parse(await readFile(ACCOUNT_FILE, "utf8")) as Account;
  } catch {
    saved = null;
  }
  if (saved && (await signIn(page, saved))) return saved;
  const account = await register(page, { name: "Erin Shared", org: "E2E Shared Org", email: uniqueEmail("shared") });
  await mkdir(path.dirname(ACCOUNT_FILE), { recursive: true });
  await writeFile(ACCOUNT_FILE, JSON.stringify(account));
  return account;
}

/** WCAG A/AA violations of serious/critical impact, as readable strings. */
export async function seriousA11yViolations(page: Page, onlyRules?: string[]) {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  if (onlyRules) b = b.withRules(onlyRules);
  const r = await b.analyze();
  return r.violations
    .filter((v) => onlyRules || v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}
