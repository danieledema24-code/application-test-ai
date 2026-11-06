import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Script, TestResult } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { parse, str } from "../lib/json.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { putObject } from "../lib/storage.js";
import { redactText } from "../lib/redact.js";
import { CONFIG_TS, FIXTURES_TS, isPlaywrightTestSpec, normaliseSpec } from "./playwright-project.js";
import { emitWebhook, notify, recordActivity } from "./activity.js";
import { analyseFailure } from "./analysis.js";
import { endpointToSpec, envCredentials, executeApi, secretValues, type ApiSpec } from "./api-runner.js";
import { isCancelled } from "./queue.js";
import { generateScript } from "./scriptgen.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(here, "../..");
const PW_CLI = path.join(API_ROOT, "node_modules/@playwright/test/cli.js");
// Run workspaces live under api/.runs so specs resolve @playwright/test from api/node_modules.
const RUNS_DIR = path.join(API_ROOT, ".runs");

/** Where a running automated run's fixtures drop live viewport frames (w<slot>.jpg + w<slot>.json). */
export const liveDir = (runId: string) => path.join(RUNS_DIR, runId, "live");

async function loadRun(runId: string) {
  return prisma.testRun.findUniqueOrThrow({
    where: { id: runId },
    include: { project: true, environment: true, results: { include: { testCase: true }, orderBy: { createdAt: "asc" } } },
  });
}
type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

async function previousStatuses(testCaseId: string | null, runId: string) {
  if (!testCaseId) return [];
  const prev = await prisma.testResult.findMany({
    where: { testCaseId, testRunId: { not: runId }, status: { in: ["PASSED", "FAILED", "ERROR"] } },
    orderBy: { createdAt: "desc" }, take: 5, select: { status: true },
  });
  return prev.map((p) => p.status);
}

async function storeData(run: LoadedRun, resultId: string, fileName: string, data: Buffer, fileType: string, name: string, mimeType: string) {
  if (fileType.endsWith("LOG") && data.length === 0) return;
  const key = await putObject(`${run.project.organisationId}/${run.projectId}/runs/${run.id}/${resultId}/${fileName}`, data);
  await prisma.evidence.create({ data: { testRunId: run.id, testResultId: resultId, fileType, name, mimeType, size: data.length, storageReference: key } });
}

async function finishResult(run: LoadedRun, result: TestResult, data: Partial<TestResult>, analysisInput?: Parameters<typeof analyseFailure>[0], secrets: string[] = []) {
  // Persist the outcome first (NFR-005) — analysis is best-effort and never changes the status.
  await prisma.testResult.update({ where: { id: result.id }, data: { ...data, executedAt: new Date() } });
  if (analysisInput && (data.status === "FAILED" || data.status === "ERROR")) {
    emitWebhook(run.project.organisationId, "test.failed", { runId: run.id, runKey: run.key, testCaseKey: result.testCaseKey, status: data.status });
    const analysis = await analyseFailure(analysisInput, secrets).catch(() => null);
    if (analysis) await prisma.testResult.update({ where: { id: result.id }, data: { failureAnalysis: str(analysis) } });
  }
}

type PwStep = { title: string; duration: number; error?: { message?: string } };
type PwAttachment = { name: string; contentType: string; path?: string; body?: string };
type PwResult = { status: string; duration: number; error?: { message?: string; stack?: string }; errors?: { message?: string }[]; steps?: PwStep[]; attachments?: PwAttachment[] };
type PwSpec = { title: string; file: string; tests: { results: PwResult[] }[] };
type PwSuite = { specs?: PwSpec[]; suites?: PwSuite[] };

function collectSpecs(suites: PwSuite[] = [], out: PwSpec[] = []) {
  for (const s of suites) {
    out.push(...(s.specs ?? []));
    collectSpecs(s.suites, out);
  }
  return out;
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Runs the whole automated run as one Playwright Test invocation (parallel workers, optional remote browser). */
async function runPlaywright(workDir: string, env: Record<string, string>, runId: string, timeoutMs: number) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    // Scrubbed environment: no platform secrets (JWT/encryption/AI keys, database URL) reach test code.
    const childEnv = { PATH: process.env.PATH ?? "", HOME: os.homedir(), CI: "1", FORCE_COLOR: "0", ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), ...env };
    const child = spawn(process.execPath, [PW_CLI, "test", "--config", path.join(workDir, "playwright.config.ts")], { cwd: workDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (d: Buffer) => (output = (output + d.toString()).slice(-20_000));
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const watchdog = setInterval(() => isCancelled(runId) && child.kill("SIGTERM"), 1000);
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearInterval(watchdog);
      clearTimeout(killer);
      resolve({ code, output });
    });
  });
}

export async function executeAutomatedRun(runId: string) {
  const run = await loadRun(runId);
  if (run.status !== "QUEUED") return;
  await start(run);
  const env = run.environment!;
  const creds = envCredentials(env);
  const secrets = secretValues(creds);
  const cfg = parse<{ recordVideo?: boolean | "failures"; timeoutMs?: number; workers?: number; slowMoMs?: number; extraHosts?: string[] }>(env.configuration, {});
  let base: URL;
  try {
    base = await assertSafeTarget(env.baseUrl);
    if (creds.playwrightWsEndpoint) await assertSafeTarget(creds.playwrightWsEndpoint.replace(/^ws/, "http"));
  } catch (err) {
    return abortRun(run, `Environment rejected: ${(err as Error).message}`);
  }
  const initiator = run.initiatedById ? await prisma.user.findUnique({ where: { id: run.initiatedById } }) : null;

  const workDir = path.join(RUNS_DIR, run.id);
  await fs.mkdir(path.join(workDir, "tests"), { recursive: true });
  await fs.mkdir(liveDir(run.id), { recursive: true });
  try {
    await fs.writeFile(path.join(workDir, "fixtures.ts"), FIXTURES_TS);
    await fs.writeFile(path.join(workDir, "playwright.config.ts"), CONFIG_TS);
    const byFile = new Map<string, { result: (typeof run.results)[number]; script: Script }>();
    for (const result of run.results) {
      const tc = result.testCase;
      if (!tc) {
        await finishResult(run, result, { status: "ERROR", errorMessage: "Test case was deleted before execution" });
        continue;
      }
      let script = await prisma.script.findFirst({ where: { testCaseId: tc.id }, orderBy: { version: "desc" } });
      // Regenerate when the case changed since the script was written, or the script predates Playwright Test specs.
      if (!script || script.testCaseVersion !== tc.version || !isPlaywrightTestSpec(script.code)) script = await generateScript(tc, initiator?.fullName ?? "system");
      const file = `${tc.key}.spec.ts`;
      await fs.writeFile(path.join(workDir, "tests", file), normaliseSpec(script.code));
      byFile.set(file, { result, script });
    }
    if (!byFile.size) return await complete(run.id);

    const reportFile = path.join(workDir, "report.json");
    const perTest = cfg.timeoutMs ?? 60_000;
    const workers = Math.min(Math.max(cfg.workers ?? config.workerConcurrency, 1), 8);
    const { output } = await runPlaywright(workDir, {
      BASE_URL: base.toString(), TEST_USERNAME: creds.username ?? "", TEST_PASSWORD: creds.password ?? "",
      ATA_ALLOWED_HOSTS: [base.hostname, ...(cfg.extraHosts ?? [])].join(","), ATA_ALLOW_PRIVATE: String(config.allowPrivateTargets),
      ATA_REPORT_FILE: reportFile, PW_WORKERS: String(workers), RECORD_VIDEO: String(cfg.recordVideo ?? true), TEST_TIMEOUT_MS: String(perTest),
      ATA_LIVE_DIR: liveDir(run.id), PW_SLOWMO_MS: String(Math.min(Math.max(cfg.slowMoMs ?? 0, 0), 3000)),
      ...(creds.playwrightWsEndpoint ? { PW_WS_ENDPOINT: creds.playwrightWsEndpoint } : {}),
    }, run.id, perTest * Math.ceil(byFile.size / workers) + 120_000);

    const report = parse<{ suites?: PwSuite[]; errors?: { message?: string }[] } | null>(await fs.readFile(reportFile, "utf8").catch(() => null), null);
    const specs = collectSpecs(report?.suites);
    const globalError = redactText(stripAnsi([...(report?.errors ?? []).map((e) => e.message ?? ""), report ? "" : output.slice(-1500)].join("\n").trim()), secrets);

    for (const [file, { result, script }] of byFile) {
      const tc = result.testCase!;
      const spec = specs.find((s) => path.basename(s.file) === file);
      const pw = spec?.tests[0]?.results.at(-1);
      const caseInput = { key: tc.key, title: tc.title, steps: parse(tc.steps, []), expectedResult: tc.expectedResult };
      if (!pw) {
        const message = isCancelled(run.id) ? "Run cancelled before this test executed" : globalError || "Test did not run (no result reported by Playwright)";
        await finishResult(run, result, { status: "ERROR", errorMessage: message.slice(0, 4000), scriptVersion: script.version },
          isCancelled(run.id) ? undefined : { testCase: caseInput, executionType: "AUTOMATED", status: "ERROR", errorMessage: message, kind: "script", script: script.code.slice(0, 6000) }, secrets);
        continue;
      }
      const error = redactText(stripAnsi(pw.error?.message ?? pw.errors?.map((e) => e.message).join("\n") ?? ""), secrets);
      const kind = pw.status === "timedOut" || /Timeout \d+ms exceeded/i.test(error) ? "timeout"
        : /net::ERR|NS_ERROR|ECONNREFUSED|ENOTFOUND|blockedbyclient/i.test(error) ? "navigation"
        : /expect\(|toBe|toHave|toContain/.test(error) ? "assertion" : pw.status === "passed" ? null : "script";
      const status = pw.status === "passed" ? "PASSED" : pw.status === "skipped" ? "BLOCKED" : kind === "assertion" || kind === "timeout" ? "FAILED" : "ERROR";
      const steps = (pw.steps ?? []).filter((st) => !/^(Before|After) Hooks$|^Worker Cleanup$/.test(st.title));
      const failedStep = steps.find((st) => st.error)?.title ?? null;

      let consoleText = "", networkText = "";
      for (const att of pw.attachments ?? []) {
        const data = att.path ? await fs.readFile(att.path).catch(() => null) : att.body ? Buffer.from(att.body, "base64") : null;
        if (!data) continue;
        if (att.name === "console" || att.name === "network") {
          const text = redactText(data.toString("utf8"), secrets);
          if (att.name === "console") consoleText = text; else networkText = text;
          await storeData(run, result.id, `${att.name}.log`, Buffer.from(text), att.name === "console" ? "CONSOLE_LOG" : "NETWORK_LOG", att.name === "console" ? "Browser console.log" : "Network errors.log", "text/plain");
        } else if (att.name === "final-state") await storeData(run, result.id, "final.png", data, "SCREENSHOT", "Final state.png", "image/png");
        else if (att.name === "video") await storeData(run, result.id, "video.webm", data, "VIDEO", "Recording.webm", "video/webm");
        else if (att.name === "trace") await storeData(run, result.id, "trace.zip", data, "TRACE", "Playwright trace.zip", "application/zip");
      }
      await finishResult(run, result, {
        status, errorMessage: error.slice(0, 8000), durationMs: Math.round(pw.duration), scriptVersion: script.version,
        actualResult: status === "PASSED" ? "All automated steps passed." : `Failed at step: ${failedStep ?? "(test setup)"}`,
        stepResults: str(steps.map((st, i) => ({ index: i, label: st.title, status: st.error ? "FAILED" : "PASSED", note: st.error?.message ? redactText(stripAnsi(st.error.message), secrets).slice(0, 500) : undefined, durationMs: Math.round(st.duration) }))),
      }, status === "PASSED" ? undefined : {
        testCase: caseInput, executionType: "AUTOMATED", status, errorMessage: error, failedStep, kind,
        consoleExcerpt: consoleText.slice(-3000), networkExcerpt: networkText.slice(-3000),
        previousResults: await previousStatuses(tc.id, run.id), script: script.code.slice(0, 6000),
      }, secrets);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  await complete(run.id);
}

export async function executeApiRun(runId: string) {
  const run = await loadRun(runId);
  if (run.status !== "QUEUED") return;
  await start(run);
  const env = run.environment!;
  const secrets = secretValues(envCredentials(env));
  for (const result of run.results) {
    if (isCancelled(run.id)) break;
    const tc = result.testCase;
    const endpoint = tc?.apiEndpointId ? await prisma.apiEndpoint.findUnique({ where: { id: tc.apiEndpointId } }) : null;
    const spec: ApiSpec | null = tc?.apiSpec ? { ...(endpoint ? endpointToSpec(endpoint) : {}), ...parse<ApiSpec>(tc.apiSpec, {} as ApiSpec) } : endpoint ? endpointToSpec(endpoint) : null;
    if (!tc || !spec) {
      await finishResult(run, result, { status: "BLOCKED", errorMessage: "No API request is defined for this test case" });
      continue;
    }
    const t0 = Date.now();
    let exchange;
    try {
      exchange = await executeApi(spec, env);
    } catch (err) {
      await finishResult(run, result, { status: "ERROR", errorMessage: (err as Error).message, durationMs: Date.now() - t0 });
      continue;
    }
    const failedAssertions = exchange.assertions.filter((a) => !a.passed);
    const status = !exchange.response ? "ERROR" : failedAssertions.length ? "FAILED" : "PASSED";
    const errorMessage = failedAssertions.map((a) => `${a.name}: ${a.message}`).join("\n");
    await finishResult(run, result, {
      status, errorMessage, durationMs: exchange.response?.timeMs ?? Date.now() - t0, apiExchange: str(exchange),
      actualResult: exchange.response ? `HTTP ${exchange.response.status} in ${exchange.response.timeMs}ms` : "No response",
      stepResults: str(exchange.assertions.map((a, i) => ({ index: i, label: a.name, status: a.passed ? "PASSED" : "FAILED", note: a.message }))),
    }, {
      testCase: { key: tc.key, title: tc.title, steps: parse(tc.steps, []), expectedResult: tc.expectedResult }, executionType: "API",
      status, errorMessage, apiExchange: exchange, previousResults: await previousStatuses(tc.id, run.id),
    }, secrets);
  }
  await complete(run.id);
}

async function start(run: LoadedRun) {
  await prisma.testRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: new Date() } });
  emitWebhook(run.project.organisationId, "run.started", { runId: run.id, runKey: run.key, projectId: run.projectId });
}

async function abortRun(run: LoadedRun, message: string) {
  await prisma.testResult.updateMany({ where: { testRunId: run.id, status: "NOT_EXECUTED" }, data: { status: "ERROR", errorMessage: message } });
  await complete(run.id);
}

/** Final status is derived only from stored result records (FR-056). */
export async function complete(runId: string) {
  const run = await loadRun(runId);
  const statuses = run.results.map((r) => r.status);
  const status = isCancelled(runId) || run.status === "CANCELLED" ? "CANCELLED"
    : run.executionType === "MANUAL" ? "COMPLETED"
    : statuses.includes("FAILED") ? "FAILED" : statuses.includes("ERROR") ? "ERROR" : "PASSED";
  await prisma.testRun.update({ where: { id: runId }, data: { status, completedAt: new Date() } });
  const failed = statuses.filter((s) => s === "FAILED" || s === "ERROR").length;
  const orgId = run.project.organisationId;
  const message = `${run.key} ${run.name}: ${statuses.filter((s) => s === "PASSED").length}/${statuses.length} passed`;
  await recordActivity({
    organisationId: orgId, projectId: run.projectId, userId: run.initiatedById, viaAI: run.initiatedByAI,
    actionType: failed ? "RUN_FAILED" : "RUN_PASSED", actionStatus: failed ? "FAILED" : "DONE", message, link: `/test-runs/${run.id}`, executionReference: run.id,
  });
  emitWebhook(orgId, "run.completed", { runId, runKey: run.key, status, failed, total: statuses.length });
  if (run.initiatedById) await notify(run.initiatedById, `Run ${run.key} ${status.toLowerCase()}`, message, `/test-runs/${run.id}`);
}

/** NFR-005: after a restart, runs that were mid-flight are closed out with their stored results kept. */
export async function recoverInterruptedRuns(requeue: (type: "automated-run" | "api-run", id: string) => void) {
  const stuck = await prisma.testRun.findMany({ where: { status: "RUNNING", executionType: { in: ["AUTOMATED", "API", "DISCOVERY"] } } });
  for (const r of stuck) {
    await prisma.testResult.updateMany({ where: { testRunId: r.id, status: "NOT_EXECUTED" }, data: { status: "ERROR", errorMessage: "Worker stopped unexpectedly; the test did not complete" } });
    if (r.executionType === "DISCOVERY") {
      await prisma.testRun.update({ where: { id: r.id }, data: { status: "ERROR", completedAt: new Date() } });
      await prisma.discovery.updateMany({ where: { testRunId: r.id, status: { in: ["RUNNING", "QUEUED"] } }, data: { status: "FAILED", summary: "Discovery interrupted by a worker restart." } });
    } else await complete(r.id);
  }
  const queued = await prisma.testRun.findMany({ where: { status: "QUEUED", executionType: { in: ["AUTOMATED", "API"] } } });
  for (const r of queued) requeue(r.executionType === "API" ? "api-run" : "automated-run", r.id);
}
