// `qa run`: runs `playwright test` in a prepared workspace and reports how it went. Results are read by the
// backend from the JSON reporter file only (never synthesised here).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_DIR, PLAYWRIGHT_CLI, TOOLKIT_DIR } from "./paths.ts";

export interface RunOptions {
  dir: string;
  report: string;
  liveDir?: string;
  progress?: string;
  grep?: string;
}

export interface RunReport {
  exit_code: number | null;
  report_file: string;
  duration_ms: number;
  stderr_tail: string;
}

const TAIL = 4000;

/** Workspaces outside automation/ get a node_modules link so specs and fixtures resolve @playwright/test. */
function ensureModules(dir: string): void {
  const inside = path.resolve(dir).startsWith(TOOLKIT_DIR + path.sep);
  const link = path.join(dir, "node_modules");
  if (!inside && !fs.existsSync(link)) fs.symlinkSync(path.join(TOOLKIT_DIR, "node_modules"), link, "dir");
}

export async function run(opts: RunOptions): Promise<RunReport> {
  const dir = path.resolve(opts.dir);
  const config = path.join(dir, "playwright.config.ts");
  if (!fs.existsSync(config)) throw new Error("The workspace has no playwright.config.ts (run `qa init` first)");
  ensureModules(dir);
  const report = path.resolve(opts.report);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const args = [PLAYWRIGHT_CLI, "test", "--config", config];
  if (opts.grep) args.push("--grep", opts.grep);
  // The caller (the backend adapter) already scrubbed the environment; only the run's own variables are added.
  const env: NodeJS.ProcessEnv = { ...process.env, ATA_REPORT_FILE: report, FORCE_COLOR: "0" };
  if (opts.liveDir) {
    // live.ts is a platform-only file (never exported); a run that streams frames always gets the toolkit's copy.
    fs.copyFileSync(path.join(PLATFORM_DIR, "live.ts"), path.join(dir, "live.ts"));
    fs.mkdirSync(opts.liveDir, { recursive: true });
    env.ATA_LIVE_DIR = path.resolve(opts.liveDir);
  } else delete env.ATA_LIVE_DIR;
  if (opts.progress) {
    // progress.ts is platform-only too: one JSON line per test start and end for the platform's live rows.
    fs.copyFileSync(path.join(PLATFORM_DIR, "progress.ts"), path.join(dir, "progress.ts"));
    fs.mkdirSync(path.dirname(path.resolve(opts.progress)), { recursive: true });
    env.ATA_PROGRESS_FILE = path.resolve(opts.progress);
  } else delete env.ATA_PROGRESS_FILE;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const keep = (d: Buffer) => (stderr = (stderr + d.toString()).slice(-TAIL));
    child.stderr.on("data", keep);
    child.stdout.on("data", keep); // the list reporter is off on the platform; keep warnings like BLOCKED lines
    const stop = (signal: NodeJS.Signals) => child.kill(signal);
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
    child.on("close", (code) =>
      resolve({ exit_code: code, report_file: report, duration_ms: Date.now() - started, stderr_tail: stderr }),
    );
  });
}
