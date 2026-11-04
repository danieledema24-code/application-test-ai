import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestResult } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { parse, str } from "../lib/json.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { putObject } from "../lib/storage.js";
import { emitWebhook, notify, recordActivity } from "./activity.js";
import { analyseFailure } from "./analysis.js";
import { endpointToSpec, envCredentials, executeApi, secretValues, type ApiSpec } from "./api-runner.js";
import { isCancelled } from "./queue.js";
import { generateScript } from "./scriptgen.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.resolve(here, "../worker/runner-child.ts");
const TSX = path.resolve(here, "../../node_modules/.bin/tsx");

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

/** Runs one Playwright script in an isolated child process and returns its result + local evidence dir. */
async function runInChild(job: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    // Scrubbed environment: the child never sees JWT/encryption/AI keys or the database URL.
    const env = { PATH: process.env.PATH ?? "", HOME: os.homedir(), NODE_ENV: "production", ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) };
    const child = spawn(TSX, [CHILD], { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()).slice(-4000));
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 30_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ ok: code === 0, stderr });
    });
    child.stdin.end(JSON.stringify(job));
  });
}

async function storeFile(run: LoadedRun, resultId: string, localPath: string, fileType: string, name: string, mimeType: string) {
  const data = await fs.readFile(localPath).catch(() => null);
  if (!data || (fileType.endsWith("LOG") && data.length === 0)) return;
  const key = await putObject(`${run.project.organisationId}/${run.projectId}/runs/${run.id}/${resultId}/${path.basename(localPath)}`, data);
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

export async function executeAutomatedRun(runId: string) {
  let run = await loadRun(runId);
  if (run.status !== "QUEUED") return;
  await start(run);
  const env = run.environment!;
  const creds = envCredentials(env);
  const secrets = secretValues(creds);
  const cfg = parse<{ recordVideo?: boolean; timeoutMs?: number; extraHosts?: string[] }>(env.configuration, {});
  let base: URL;
  try {
    base = await assertSafeTarget(env.baseUrl);
  } catch (err) {
    return abortRun(run, `Environment URL rejected: ${(err as Error).message}`);
  }
  const initiator = run.initiatedById ? await prisma.user.findUnique({ where: { id: run.initiatedById } }) : null;

  for (const result of run.results) {
    if (isCancelled(run.id)) break;
    const tc = result.testCase;
    if (!tc) {
      await finishResult(run, result, { status: "ERROR", errorMessage: "Test case was deleted before execution" });
      continue;
    }
    let script = await prisma.script.findFirst({ where: { testCaseId: tc.id }, orderBy: { version: "desc" } });
    if (!script || script.testCaseVersion !== tc.version) script = await generateScript(tc, initiator?.fullName ?? "system");
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ata-run-"));
    try {
      const scriptPath = path.join(workDir, "test.ts");
      await fs.writeFile(scriptPath, script.code);
      const timeoutMs = cfg.timeoutMs ?? 60_000;
      const { ok, stderr } = await runInChild({
        scriptPath, outDir: workDir, baseUrl: base.toString(), allowedHosts: [base.hostname, ...(cfg.extraHosts ?? [])],
        allowPrivate: config.allowPrivateTargets, recordVideo: cfg.recordVideo ?? true, timeoutMs, credentials: creds, secrets,
      }, timeoutMs);
      const out = parse<{
        status: "PASSED" | "FAILED" | "ERROR"; error: string; kind: string | null; failedStep: string | null;
        steps: { index: number; label: string; status: string; durationMs: number; error?: string }[];
        durationMs: number; videoPath: string | null; hasScreenshot: boolean;
      } | null>(await fs.readFile(path.join(workDir, "result.json"), "utf8").catch(() => null), null);

      if (!out) {
        await finishResult(run, result, { status: "ERROR", errorMessage: `Execution worker crashed: ${stderr.split("\n").slice(-5).join(" ").slice(0, 500) || "no output"}`, scriptVersion: script.version },
          { testCase: { key: tc.key, title: tc.title, steps: parse(tc.steps, []), expectedResult: tc.expectedResult }, executionType: "AUTOMATED", status: "ERROR", errorMessage: stderr.slice(-1500), kind: "environment" }, secrets);
        continue;
      }
      if (out.hasScreenshot) await storeFile(run, result.id, path.join(workDir, "final.png"), "SCREENSHOT", "Final state.png", "image/png");
      if (out.videoPath && out.status !== "PASSED") await storeFile(run, result.id, out.videoPath, "VIDEO", "Recording.webm", "video/webm");
      await storeFile(run, result.id, path.join(workDir, "console.log"), "CONSOLE_LOG", "Browser console.log", "text/plain");
      await storeFile(run, result.id, path.join(workDir, "network.log"), "NETWORK_LOG", "Network errors.log", "text/plain");
      const consoleExcerpt = (await fs.readFile(path.join(workDir, "console.log"), "utf8").catch(() => "")).slice(-3000);
      const networkExcerpt = (await fs.readFile(path.join(workDir, "network.log"), "utf8").catch(() => "")).slice(-3000);
      ok || console.warn(`[runner] child exited non-zero for ${tc.key}`);
      await finishResult(run, result, {
        status: out.status, errorMessage: out.error, durationMs: out.durationMs, scriptVersion: script.version,
        actualResult: out.status === "PASSED" ? "All automated steps passed." : `Failed at step: ${out.failedStep ?? "(setup)"}`,
        stepResults: str(out.steps.map((s) => ({ index: s.index, label: s.label, status: s.status, note: s.error, durationMs: s.durationMs }))),
      }, {
        testCase: { key: tc.key, title: tc.title, steps: parse(tc.steps, []), expectedResult: tc.expectedResult }, executionType: "AUTOMATED",
        status: out.status, errorMessage: out.error, failedStep: out.failedStep, kind: out.kind, consoleExcerpt, networkExcerpt,
        previousResults: await previousStatuses(tc.id, run.id), script: script.code.slice(0, 6000),
      }, secrets);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
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
