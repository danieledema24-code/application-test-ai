import { defineConfig, devices } from "@playwright/test";

// Three projects:
//  - unit:      pure TypeScript logic (URL checks, lifecycle roll-up, SSE parsing). No browser, no server.
//  - e2e:       real journeys against the web app (3002) and the QA Analyst backend (8200).
//               Needs the backend running with a test database and a fixture site (E2E_SITE_URL).
//  - ui-mocked: UI behaviour with the API stubbed by page.route() fixtures (e2e/mocked/fixtures.ts).
//               Development aid only; nothing from it ships in the product.
const WEB_URL = process.env.WEB_URL ?? "http://localhost:3002";
const unitOnly = process.argv.some((a) => a === "--project=unit") || process.env.PW_UNIT === "1";

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  projects: [
    { name: "unit", testDir: "./tests/unit" },
    { name: "e2e", testDir: "./e2e", testIgnore: /mocked\//, use: { ...devices["Desktop Chrome"] }, timeout: 300_000 },
    { name: "ui-mocked", testDir: "./e2e/mocked", use: { ...devices["Desktop Chrome"] }, timeout: 30_000 },
  ],
  webServer: unitOnly
    ? undefined
    : {
        command: "npx next dev -p 3002",
        url: WEB_URL,
        // Explicit, so a local .env.local pointing elsewhere can't redirect the tests.
        env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8200" },
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
