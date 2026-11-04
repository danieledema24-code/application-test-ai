// Executes ONE automation script in its own process (spawned by services/runner.ts).
// The process receives a scrubbed environment (no platform secrets) and reads its job,
// including any test credentials, from stdin. In production this entrypoint runs inside a
// per-job Docker container; the contract (stdin job → result.json + files in outDir) is the same.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { applyNetworkPolicy } from "../services/browser.js";

type Job = {
  scriptPath: string; outDir: string; baseUrl: string; allowedHosts: string[]; allowPrivate: boolean;
  recordVideo: boolean; timeoutMs: number; credentials: Record<string, string>; secrets: string[];
};
type StepOutcome = { index: number; label: string; status: "PASSED" | "FAILED" | "NOT_EXECUTED"; durationMs: number; error?: string };

const redact = (s: string, secrets: string[]) => secrets.reduce((acc, x) => (x && x.length >= 4 ? acc.split(x).join("[REDACTED]") : acc), s);

async function main() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Job;
  const consoleLines: string[] = [];
  const networkLines: string[] = [];
  const blocked: string[] = [];
  const steps: StepOutcome[] = [];
  const started = Date.now();
  let status: "PASSED" | "FAILED" | "ERROR" = "PASSED";
  let error = "";
  let failedStep: string | null = null;
  let kind: "assertion" | "script" | "navigation" | "timeout" | null = null;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 860 },
    ...(job.recordVideo ? { recordVideo: { dir: path.join(job.outDir, "video"), size: { width: 1280, height: 800 } } } : {}),
  });
  await applyNetworkPolicy(context, job.allowedHosts, job.allowPrivate, blocked);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("console", (m) => consoleLines.push(`[${new Date().toISOString()}] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[${new Date().toISOString()}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) => networkLines.push(`FAILED ${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "unknown"}`));
  page.on("response", (r) => { if (r.status() >= 400) networkLines.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });

  let index = 0;
  const step = async (label: string, fn: () => Promise<void>) => {
    const i = index++;
    const t = Date.now();
    try {
      await fn();
      steps.push({ index: i, label, status: "PASSED", durationMs: Date.now() - t });
    } catch (e) {
      steps.push({ index: i, label, status: "FAILED", durationMs: Date.now() - t, error: e instanceof Error ? e.message : String(e) });
      failedStep ??= label;
      throw e;
    }
  };
  const env = { baseUrl: job.baseUrl.replace(/\/$/, ""), credentials: job.credentials };

  try {
    const mod = await import(pathToFileURL(job.scriptPath).href);
    if (typeof mod.default !== "function") throw new Error("Script must `export default async function ({ page, expect, env, step })`");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      mod.default({ page, expect, env, step }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`Test exceeded ${job.timeoutMs}ms timeout`), { name: "TimeoutError" })), job.timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    const err = e as Error;
    error = err.message ?? String(e);
    const matcher = (e as { matcherResult?: unknown }).matcherResult !== undefined || /expect\(|toBe|toHave|toContain/.test(error);
    kind = err.name === "TimeoutError" || /Timeout \d+ms exceeded|exceeded .*timeout/i.test(error) ? "timeout"
      : /net::ERR|NS_ERROR|ECONNREFUSED|ENOTFOUND|blockedbyclient/i.test(error) ? "navigation"
      : matcher ? "assertion" : "script";
    status = kind === "assertion" || kind === "timeout" ? "FAILED" : kind === "navigation" ? "ERROR" : "ERROR";
  }

  try {
    await page.screenshot({ path: path.join(job.outDir, "final.png"), fullPage: true, mask: [page.locator("input[type=password]")] });
  } catch { /* page may be closed */ }
  const video = page.video();
  await context.close();
  let videoPath: string | null = null;
  if (video) videoPath = await video.path().catch(() => null);
  await browser.close();

  const result = {
    status, error: redact(error, job.secrets), kind, failedStep, steps: steps.map((s) => ({ ...s, error: s.error && redact(s.error, job.secrets) })),
    durationMs: Date.now() - started, finalUrl: redact(page.url(), job.secrets), blocked,
    hasScreenshot: await fs.stat(path.join(job.outDir, "final.png")).then(() => true, () => false), videoPath,
  };
  await fs.writeFile(path.join(job.outDir, "console.log"), redact(consoleLines.join("\n"), job.secrets));
  await fs.writeFile(path.join(job.outDir, "network.log"), redact([...networkLines, ...blocked.map((b) => `BLOCKED by policy ${b}`)].join("\n"), job.secrets));
  await fs.writeFile(path.join(job.outDir, "result.json"), JSON.stringify(result));
}

main().then(() => process.exit(0), async (e) => {
  console.error(e);
  process.exit(1);
});
