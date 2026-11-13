// Runs against the real QA Analyst backend (8200) and the web app (3002). See playwright.config.ts.
// Sign-ups are rate limited (5/hour/IP): only the first test registers a new account; the
// duplicate-email test reuses the shared account (see helpers.useSharedAccount).
import { expect, test } from "@playwright/test";
import { register, seriousA11yViolations, uniqueEmail, useSharedAccount } from "./helpers";

test("P1-12: register and sign in land on /dashboard; sign out ends the session", async ({ page }) => {
  const { email, password } = await register(page, { name: "Erin Tester", org: "E2E Org" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome, Erin");
  await expect(page.getByText("E2E Org").first()).toBeVisible();
  // First run: welcome, URL input and what happens next; no metric tiles or mock data.
  await expect(page.getByText("What happens next")).toBeVisible();
  await expect(page.getByText("Active projects")).toHaveCount(0);
  expect(await seriousA11yViolations(page, ["color-contrast"])).toEqual([]);

  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("You’ve signed out.")).toBeVisible();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("P1-12: wrong credentials show a generic message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(uniqueEmail("nobody"));
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("definitely wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "incorrect" })).toHaveText("Email or password is incorrect.");
  await expect(page.getByRole("textbox", { name: "Password", exact: true })).toBeFocused();
  expect(await seriousA11yViolations(page, ["color-contrast"])).toEqual([]);
});

test("P1-12: a backend validation_error shows field messages next to the fields", async ({ page }) => {
  // Bypass the client check so the server's validation answers (password shorter than its minimum).
  await page.route("**/api/v1/auth/register", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, password: "short" }) });
  });
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Val Idation");
  await page.getByLabel("Work email").fill(uniqueEmail("val"));
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("long enough password");
  await page.getByLabel("Organisation name").fill("Val Org");
  await page.getByRole("button", { name: "Create account" }).click();
  const pw = page.getByRole("textbox", { name: "Password", exact: true });
  await expect(pw).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
});

test("P1-12: an email already registered is reported on the email field", async ({ page, browser }) => {
  const { email } = await useSharedAccount(page);
  const other = await browser.newPage();
  await other.goto("/register");
  await other.getByLabel("Full name").fill("Second Person");
  await other.getByLabel("Work email").fill(email);
  await other.getByRole("textbox", { name: "Password", exact: true }).fill("another long password");
  await other.getByLabel("Organisation name").fill("Other Org");
  await other.getByRole("button", { name: "Create account" }).click();
  await expect(other.getByText("An account with this email already exists.")).toBeVisible();
  await other.close();
});
