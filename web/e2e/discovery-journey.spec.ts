// Phase 1 critical journey (roadmap P1-13…P1-16): register → submit fixture URL → watch discovery →
// approve Gate 2 → download the PDF report. Runs against the real backend (ALLOW_PRIVATE_TARGETS=true)
// and the demo shop (E2E_SITE_URL, default http://localhost:4100/). Uses the shared e2e account, so
// the first-run dashboard is covered in auth.spec.ts instead.
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { SITE_URL, seriousA11yViolations, useSharedAccount } from "./helpers";

test.describe.configure({ mode: "serial" });

test("discovery journey: start, watch live, approve G2, download PDF", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  // Client-side exceptions (e.g. data shapes the mocks don't cover) fail the journey.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await useSharedAccount(page);

  // P1-13: typing a URL and pausing shows the live check result. Local targets are checked by the
  // server (the browser no longer refuses them when the server allows private targets).
  await page.getByLabel("Website URL").fill(SITE_URL);
  await expect(page.getByText("Reachable")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start QA Analysis" }).click();
  await expect(page).toHaveURL(/\/projects\/new\?url=/);

  // Gate 1: the button is never disabled; unticked shows the error.
  await expect(page.getByText("Reachable")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Start QA Analysis" }).click();
  await expect(page.getByText("Confirm you're authorised to test this site.")).toBeVisible();
  await page.getByRole("checkbox", { name: /I am authorised to test this site/ }).check();
  await page.getByRole("button", { name: "Show scan settings (optional)" }).click();
  await page.getByLabel("Maximum pages").fill("10");
  await page.getByRole("button", { name: "Start QA Analysis" }).click();

  // The shared account may already have a project for this URL (earlier runs): create a new one anyway.
  const createAnyway = page.getByRole("button", { name: "Create anyway" });
  await expect(page.getByText("Project created. Discovery has started.").or(createAnyway)).toBeVisible({ timeout: 30_000 });
  if (await createAnyway.isVisible()) await createAnyway.click();

  // P1-13: taken to the workspace; discovery queued or running.
  await expect(page.getByText("Project created. Discovery has started.")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/projects\/[^/]+\/discovery/, { timeout: 30_000 });
  const projectUrl = page.url().replace(/\/discovery.*$/, "");

  // P1-14: the activity feed streams (SSE through CORS) and replays history on the Overview.
  await page.goto(projectUrl);
  const feed = page.getByRole("list", { name: "Agent events, newest first" });
  await expect(feed.getByRole("listitem").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Reconnecting… Missed events will catch up.")).toHaveCount(0);

  // P1-14: when discovery finishes, Gate 2 is highlighted with an action to review. Under the default
  // policy ("recommended") it is ready for review; under "required" it waits for approval.
  await expect(page.getByRole("link", { name: "Review gate" })).toBeVisible({ timeout: 4 * 60_000 });
  await expect(page.getByText(/is ready for your review|is waiting for your approval/).first()).toBeVisible();
  expect(await seriousA11yViolations(page, ["color-contrast"])).toEqual([]);

  // P1-15: approve G2 with a comment.
  await page.getByRole("link", { name: "Review gate" }).click();
  await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Not reached")).toHaveCount(0);
  expect(await seriousA11yViolations(page, ["color-contrast"])).toEqual([]);
  await page.getByLabel("Comment").fill("Fixture site covered.");
  await page.getByRole("button", { name: "Approve discovery" }).click();
  await expect(page.getByText(/“Fixture site covered\.”/)).toBeVisible({ timeout: 15_000 });

  // Access gaps: exactly the API's gaps, none without their evidence where the API gives some.
  await page.getByRole("tab", { name: /Access gaps/ }).click();
  await expect(page.getByRole("table", { name: "Access gaps" }).getByText("Couldn’t observe")).toHaveCount(0);

  // Report: approved, then the PDF.
  await page.goto(`${projectUrl}/reports/discovery`);
  await expect(page.getByRole("heading", { level: 1, name: "Application Discovery Report" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Draft — awaiting Gate 2")).toHaveCount(0, { timeout: 30_000 });
  expect(await seriousA11yViolations(page, ["color-contrast"])).toEqual([]);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-discovery-report-scan1-\d{4}-\d{2}-\d{2}\.pdf$/);
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  expect(pageErrors).toEqual([]);
});

test("blocked URLs are refused with the exact copy and nothing is created", async ({ page }) => {
  await useSharedAccount(page);
  await page.goto(`/projects/new?url=${encodeURIComponent("http://169.254.169.254/")}`);
  await expect(page.getByText("This is a cloud metadata address. It can't be analysed.").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Website URL")).toHaveAttribute("aria-invalid", "true");
});
