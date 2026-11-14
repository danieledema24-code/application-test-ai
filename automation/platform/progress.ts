// Platform file (trusted, platform runs only: NOT included in exports). A Playwright reporter that appends one JSON
// line per test start and end to ATA_PROGRESS_FILE, so the platform can show per-test progress while the run is
// going (P4-06). Lines carry the spec file, the project (browser and screen size), the attempt and the status only:
// never errors, values or page text (results come from the JSON reporter at the end).
import fs from "node:fs";
import path from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

export default class ProgressReporter implements Reporter {
  private file = process.env.ATA_PROGRESS_FILE ?? "";
  private root = "";

  onBegin(config: FullConfig): void {
    // Paths relative to the workspace (where playwright.config.ts is), like the bundle's own paths.
    this.root = config.configFile ? path.dirname(config.configFile) : config.rootDir;
  }

  private write(event: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, JSON.stringify({ ...event, at: Date.now() }) + "\n");
    } catch {
      /* best effort */
    }
  }

  private where(test: TestCase): { file: string; project: string } {
    const project = test.parent.project()?.name ?? "";
    return { file: path.relative(this.root, test.location.file).split(path.sep).join("/"), project };
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.write({ event: "begin", ...this.where(test), attempt: result.retry + 1, worker: result.parallelIndex });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.write({
      event: "end",
      ...this.where(test),
      attempt: result.retry + 1,
      status: result.status,
      outcome: test.outcome(),
      duration_ms: Math.round(result.duration),
      retries: test.retries,
    });
  }

  printsToStdio(): boolean {
    return false;
  }
}
