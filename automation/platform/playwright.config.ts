// Platform file (trusted, shipped by automation/). Every setting comes from the environment so the same project
// runs on the platform (the backend sets ATA_* variables and reads the JSON report), on a developer machine and
// in CI (list + HTML reports).
import { defineConfig, devices } from "@playwright/test";

const env = process.env;
const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);
const reportFile = env.ATA_REPORT_FILE;

type BrowserName = "chromium" | "firefox" | "webkit";
const DEVICE: Record<BrowserName, string> = { chromium: "Desktop Chrome", firefox: "Desktop Firefox", webkit: "Desktop Safari" };
// Decision D7: Chromium desktop 1440×900 by default; mobile 390×844 and Firefox/WebKit are opt-in per run.
const browsers = (env.ATA_BROWSERS ?? "chromium")
  .split(",")
  .map((b) => b.trim())
  .filter((b): b is BrowserName => b in DEVICE);
const viewports = (env.ATA_VIEWPORTS ?? "1440x900")
  .split(",")
  .map((v) => v.trim().match(/^(\d{2,4})x(\d{2,4})$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));
const videoModes = ["off", "on", "retain-on-failure"] as const;
const traceModes = ["off", "on", "retain-on-failure"] as const;
const video = videoModes.find((m) => m === env.ATA_VIDEO) ?? "retain-on-failure";
const trace = traceModes.find((m) => m === env.ATA_TRACE) ?? "retain-on-failure";
const retries = num(env.PW_RETRIES, 0);
// Platform runs: spec files (paths relative to this file) that must not be retried (decision D9: tests that may
// pay or delete run once) and that must not record a trace (tests that sign in, so the password is never traced).
const list = (v: string | undefined) => (v ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const noRetry = list(env.ATA_NO_RETRY);
const noTrace = list(env.ATA_NO_TRACE);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fileRe = (files: string[]) => new RegExp(`(^|/)(${files.map(escape).join("|")})$`);
type Group = { suffix: string; retries: number; trace: (typeof traceModes)[number]; files: string[] | null; skip: string[] };
// One project per browser × screen size, split by retry and trace settings when some specs differ. A group with
// `files` runs exactly those; the default group (`files: null`) runs every other spec.
const special = [...new Set([...noRetry, ...noTrace])];
const groups: Group[] = [
  { suffix: "", retries, trace, files: null, skip: special },
  ...[
    { suffix: "~once", retries: 0, trace, files: special.filter((f) => noRetry.includes(f) && !noTrace.includes(f)) },
    { suffix: "~notrace", retries, trace: "off" as const, files: special.filter((f) => noTrace.includes(f) && !noRetry.includes(f)) },
    { suffix: "~once~notrace", retries: 0, trace: "off" as const, files: special.filter((f) => noTrace.includes(f) && noRetry.includes(f)) },
  ]
    .filter((g) => g.files.length > 0)
    .map((g) => ({ ...g, skip: [] })),
];
const reporter: NonNullable<Parameters<typeof defineConfig>[0]["reporter"]> = reportFile
  ? [["json", { outputFile: reportFile }], ...(env.ATA_PROGRESS_FILE ? [["./progress.ts"] as [string]] : [])]
  : [["list"], ["html", { open: "never" }]];

export default defineConfig({
  testDir: "./tests",
  outputDir: env.ATA_OUTPUT_DIR ?? "./test-results",
  timeout: num(env.TEST_TIMEOUT_MS, 60_000),
  expect: { timeout: 10_000 },
  workers: Math.min(num(env.PW_WORKERS, 2), 4),
  retries,
  forbidOnly: true,
  reporter,
  use: {
    baseURL: env.BASE_URL,
    // A missing element fails as "locator.fill: Timeout …ms exceeded" (classified "Element not found"), not as a
    // whole-test timeout.
    actionTimeout: num(env.ACTION_TIMEOUT_MS, 15_000),
    navigationTimeout: 30_000,
    trace,
    video,
    screenshot: "off", // the fixtures attach one masked final screenshot per test
    acceptDownloads: false,
    serviceWorkers: "block",
  },
  projects: browsers.flatMap((browser) =>
    (viewports.length ? viewports : [{ width: 1440, height: 900 }]).flatMap((viewport) =>
      groups.map((g) => ({
        name: `${browser}-${viewport.width}x${viewport.height}${g.suffix}`,
        retries: g.retries,
        ...(g.files ? { testMatch: fileRe(g.files) } : {}),
        ...(g.skip.length ? { testIgnore: fileRe(g.skip) } : {}),
        use: { ...devices[DEVICE[browser]], viewport, trace: g.trace },
      })),
    ),
  ),
});
