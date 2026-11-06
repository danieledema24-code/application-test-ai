import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { authenticate, getProjectForUser, type AuthUser } from "../auth.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { parse, provided, str } from "../lib/json.js";
import { nextKey } from "../lib/keys.js";
import { csvCell } from "../lib/csv.js";
import { checkSpec } from "../lib/spec-guard.js";
import { getObject, putObject } from "../lib/storage.js";
import { casesWithMeta, evidenceDto, resultDtos, runDtos, runInclude, scriptDto, environmentDto } from "../lib/serialize.js";
import { audit, recordActivity } from "../services/activity.js";
import { analyseFailure } from "../services/analysis.js";
import { compareRuns, generateCasesForProject, startRun } from "../services/actions.js";
import { DESTRUCTIVE, endpointToSpec, envCredentials, executeApi, requestSchema, secretValues } from "../services/api-runner.js";
import { aiJSON } from "../services/ai.js";
import { CATEGORIES, PRIORITIES } from "../services/generation.js";
import { heuristicApiCases, parseOpenApi } from "../services/openapi.js";
import { cancel } from "../services/queue.js";
import { complete, liveDir } from "../services/runner.js";
import { generateScript, scriptForRun } from "../services/scriptgen.js";
import JSZip from "jszip";
import { CONFIG_TS, envExample, FIXTURES_TS, isPlaywrightTestSpec, normaliseSpec, packageJson, readme } from "../services/playwright-project.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

const step = z.object({ action: z.string().min(1), data: z.string().optional(), expected: z.string().optional() });
const caseFields = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().default(""), preconditions: z.string().default(""),
  steps: z.array(step).default([]), expectedResult: z.string().default(""), category: z.enum(CATEGORIES).default("FUNCTIONAL"), priority: z.enum(PRIORITIES).default("MEDIUM"),
});
const CASE_STATUS = z.enum(["DRAFT", "APPROVED", "READY", "DEPRECATED"]);

async function caseForUser(user: AuthUser, id: string) {
  const tc = await prisma.testCase.findFirst({ where: { id, project: { organisationId: user.organisationId } } });
  if (!tc) throw notFound("Test case");
  return tc;
}
async function resultForUser(user: AuthUser, id: string) {
  const r = await prisma.testResult.findFirst({ where: { id, testRun: { project: { organisationId: user.organisationId } } }, include: { testRun: { include: { environment: true } }, testCase: true, evidence: true } });
  if (!r) throw notFound("Test result");
  return r;
}
const fullResults = (where: object) =>
  prisma.testResult.findMany({ where, include: { evidence: true, defects: { select: { id: true } } }, orderBy: { createdAt: "asc" } });

export async function testingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // ---------------- Test cases ----------------
  app.get("/projects/:id/test-cases", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const q = req.query as { search?: string; category?: string; priority?: string; status?: string };
    const cases = await prisma.testCase.findMany({
      where: {
        projectId: id, ...(q.category ? { category: q.category } : {}), ...(q.priority ? { priority: q.priority } : {}), ...(q.status ? { status: q.status } : {}),
        ...(q.search ? { OR: [{ title: { contains: q.search } }, { key: { contains: q.search } }, { description: { contains: q.search } }] } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return casesWithMeta(cases);
  });

  // Test cases as CSV (same filters as the list).
  app.get("/projects/:id/test-cases/export.csv", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await getProjectForUser(req.user, id);
    const q = req.query as { search?: string; category?: string; priority?: string; status?: string };
    const cases = await prisma.testCase.findMany({
      where: {
        projectId: id, ...(q.category ? { category: q.category } : {}), ...(q.priority ? { priority: q.priority } : {}), ...(q.status ? { status: q.status } : {}),
        ...(q.search ? { OR: [{ title: { contains: q.search } }, { key: { contains: q.search } }, { description: { contains: q.search } }] } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    const rows = [["ID", "Title", "Description", "Preconditions", "Steps", "Expected result", "Category", "Priority", "Status", "Source", "Version", "Last result"]];
    for (const c of await casesWithMeta(cases))
      rows.push([c.key, c.title, c.description, c.preconditions, (c.steps as { action: string; expected?: string }[]).map((st, i) => `${i + 1}. ${st.action}${st.expected ? ` → ${st.expected}` : ""}`).join("\n"),
        c.expectedResult, c.category, c.priority, c.status, c.aiGenerated ? "AI" : c.source, String(c.version), c.lastResult ?? ""]);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${slug(project.name)}-test-cases.csv"`);
    return reply.send("\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
  });

  // Ready-to-run Playwright Test project for the selected (or all approved/ready) cases.
  app.get("/projects/:id/playwright-export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await getProjectForUser(req.user, id);
    const ids = ((req.query as { caseIds?: string }).caseIds ?? "").split(",").filter(Boolean);
    const cases = await prisma.testCase.findMany({
      where: { projectId: id, ...(ids.length ? { id: { in: ids } } : { status: { in: ["APPROVED", "READY"] } }), apiEndpointId: null, apiSpec: null },
      orderBy: { createdAt: "asc" },
    });
    if (!cases.length) throw badRequest(ids.length ? "None of the selected cases are UI test cases" : "Approve some UI test cases first; API cases are not exported as browser specs");
    const draft = cases.filter((c) => !["APPROVED", "READY"].includes(c.status));
    if (draft.length) throw badRequest(`Approve these cases before exporting them: ${draft.map((c) => c.key).join(", ")}`);
    const zip = new JSZip();
    const rejected: string[] = [];
    for (const tc of cases) {
      const { code, problem } = await scriptForRun(tc, req.user.fullName);
      if (problem) rejected.push(`${tc.key}: ${problem}`);
      else zip.file(`tests/${tc.key}.spec.ts`, code);
    }
    if (rejected.length) throw badRequest(`Fix these scripts before exporting them. ${rejected.join("; ")}`);
    const env = await prisma.environment.findFirst({ where: { projectId: id }, orderBy: { createdAt: "asc" } });
    zip.file("playwright.config.ts", CONFIG_TS);
    zip.file("fixtures.ts", FIXTURES_TS);
    zip.file("package.json", packageJson(project.name));
    zip.file(".env.example", envExample(env?.baseUrl ?? project.applicationUrl));
    zip.file(".gitignore", "node_modules\n.env\ntest-results\nplaywright-report\n");
    zip.file("README.md", readme(project.name, cases.map((c) => c.key)));
    zip.file("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", strict: true, esModuleInterop: true, types: ["node"] } }, null, 2) + "\n");
    await audit(req.user.organisationId, req.user.id, "playwright.exported", project.name, { cases: cases.map((c) => c.key) });
    reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${slug(project.name)}-playwright.zip"`);
    return reply.send(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  });

  app.post("/projects/:id/test-cases", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const body = caseFields.parse(req.body);
    const [key] = await nextKey(req.user.organisationId, "case");
    const tc = await prisma.testCase.create({ data: { ...body, steps: str(body.steps), key, projectId: id, source: "MANUAL" } });
    return (await casesWithMeta([tc]))[0];
  });

  app.post("/projects/:id/test-cases/generate", async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      source: z.enum(["DISCOVERY", "USER_STORY", "REQUIREMENTS", "DESCRIPTION", "OPENAPI"]), text: z.string().max(100_000).optional(),
      discoveryId: z.string().optional(), categories: z.array(z.enum(CATEGORIES)).optional(), count: z.number().int().min(1).max(40).optional(),
    }).parse(req.body);
    const { created, generatedBy, notes } = await generateCasesForProject(req.user, id, body);
    return { generated: await casesWithMeta(created), generatedBy, notes };
  });

  app.get("/test-cases/:id", async (req) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    const [dto] = await casesWithMeta([tc]);
    const scripts = await prisma.script.findMany({ where: { testCaseId: tc.id }, orderBy: { version: "desc" } });
    const history = await resultDtos(await prisma.testResult.findMany({ where: { testCaseId: tc.id }, include: { evidence: true, defects: { select: { id: true } } }, orderBy: { createdAt: "desc" }, take: 30 }));
    return { ...dto, apiSpec: parse(tc.apiSpec, null), scripts: scripts.map(scriptDto), history };
  });

  app.patch("/test-cases/:id", async (req) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    const body = provided(caseFields.partial().extend({ status: CASE_STATUS.optional() }).parse(req.body), req.body);
    const contentChanged = (["title", "description", "preconditions", "steps", "expectedResult"] as const).some((k) => body[k] !== undefined);
    // Editing content creates a new revision; an approved case goes back to draft review if its content changes.
    const updated = await prisma.testCase.update({
      where: { id: tc.id },
      data: {
        ...body, steps: body.steps ? str(body.steps) : undefined, version: contentChanged ? { increment: 1 } : undefined,
        ...(contentChanged && !body.status && tc.status !== "DRAFT" ? { status: "DRAFT" } : {}),
      },
    });
    await recordActivity({ organisationId: req.user.organisationId, projectId: tc.projectId, userId: req.user.id, actionType: "CASE_UPDATED", message: `${tc.key} updated${contentChanged ? ` (v${updated.version})` : ""}`, link: `/test-cases/${tc.id}` });
    return (await casesWithMeta([updated]))[0];
  });

  app.post("/test-cases/:id/status", async (req) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    const { status } = z.object({ status: CASE_STATUS }).parse(req.body);
    const updated = await prisma.testCase.update({ where: { id: tc.id }, data: { status } });
    await audit(req.user.organisationId, req.user.id, "testcase.status", tc.key, { from: tc.status, to: status });
    return (await casesWithMeta([updated]))[0];
  });

  app.post("/test-cases/bulk-status", async (req) => {
    const { ids, status } = z.object({ ids: z.array(z.string()).min(1).max(500), status: CASE_STATUS }).parse(req.body);
    const res = await prisma.testCase.updateMany({ where: { id: { in: ids }, project: { organisationId: req.user.organisationId } }, data: { status } });
    await audit(req.user.organisationId, req.user.id, "testcase.bulk_status", `${res.count} case(s)`, { status });
    return { updated: res.count };
  });

  app.delete("/test-cases/:id", async (req, reply) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    await prisma.testCase.delete({ where: { id: tc.id } });
    await audit(req.user.organisationId, req.user.id, "testcase.deleted", tc.key);
    reply.code(204).send();
  });

  app.post("/test-cases/:id/regenerate", async (req) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: tc.projectId } });
    const ai = await aiJSON({
      schema: caseFields.required(),
      task: "Rewrite this test case to be clearer, more specific and fully executable by a human tester. Keep the same intent and category. Return the improved case.",
      input: { applicationUrl: project.applicationUrl, testCase: { title: tc.title, description: tc.description, preconditions: tc.preconditions, steps: parse(tc.steps, []), expectedResult: tc.expectedResult, category: tc.category, priority: tc.priority } },
    });
    if (!ai) throw new HttpError(503, "Regeneration needs AI to be configured (set ANTHROPIC_API_KEY). You can still edit the case manually.");
    const updated = await prisma.testCase.update({
      where: { id: tc.id },
      data: { ...ai, steps: str(ai.steps), status: "DRAFT", aiGenerated: true, version: { increment: 1 } },
    });
    return (await casesWithMeta([updated]))[0];
  });

  app.post("/test-cases/:id/scripts/generate", async (req) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    if (!["APPROVED", "READY"].includes(tc.status)) throw badRequest("Approve the test case before generating an automation script");
    const d = await prisma.discovery.findFirst({ where: { projectId: tc.projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    const hint = d ? parse<{ pages?: { url: string; title: string; forms: unknown; buttons: string[] }[] }>(d.result, {}).pages?.slice(0, 6).map((p) => ({ url: p.url, title: p.title, forms: p.forms, buttons: p.buttons.slice(0, 15) })) : undefined;
    return scriptDto(await generateScript(tc, req.user.fullName, hint));
  });

  app.put("/test-cases/:id/scripts", async (req) => {
    const tc = await caseForUser(req.user, (req.params as { id: string }).id);
    const { code } = z.object({ code: z.string().min(1).max(200_000) }).parse(req.body);
    if (!isPlaywrightTestSpec(code)) throw badRequest('Script must be a Playwright Test spec: import { test, expect } from "../fixtures" (or "@playwright/test") and define test(...)');
    const check = checkSpec(normaliseSpec(code));
    if (!check.ok) throw badRequest(`Script rejected: ${check.error}`);
    const last = await prisma.script.findFirst({ where: { testCaseId: tc.id }, orderBy: { version: "desc" } });
    const s = await prisma.script.create({ data: { testCaseId: tc.id, testCaseVersion: tc.version, version: (last?.version ?? 0) + 1, language: "playwright-test", code, createdById: req.user.id, createdBy: req.user.fullName } });
    await audit(req.user.organisationId, req.user.id, "script.edited", tc.key, { version: s.version });
    return scriptDto(s);
  });

  // ---------------- Test runs ----------------
  app.get("/test-runs", async (req) => {
    const q = req.query as { projectId?: string; status?: string; type?: string; limit?: string };
    const runs = await prisma.testRun.findMany({
      where: {
        project: { organisationId: req.user.organisationId }, ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.status ? { status: q.status } : {}),
        executionType: q.type ? q.type : { not: "DISCOVERY" },
      },
      include: runInclude, orderBy: { createdAt: "desc" }, take: Math.min(Number(q.limit ?? 100), 500),
    });
    return runDtos(runs);
  });

  app.post("/projects/:id/test-runs", async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ executionType: z.enum(["MANUAL", "AUTOMATED", "API"]), environmentId: z.string().optional(), testCaseIds: z.array(z.string()).min(1), name: z.string().max(200).optional() }).parse(req.body);
    const { run } = await startRun(req.user, id, body);
    const full = await prisma.testRun.findUniqueOrThrow({ where: { id: run.id }, include: runInclude });
    return (await runDtos([full]))[0];
  });

  app.get("/test-runs/compare", async (req) => {
    const { a, b } = req.query as { a: string; b: string };
    if (!a || !b) throw badRequest("Provide two run ids: ?a=&b=");
    const cmp = await compareRuns(req.user, a, b);
    const [ra, rb] = await runDtos([{ ...cmp.a, results: cmp.a.results }, { ...cmp.b, results: cmp.b.results }]);
    return { a: ra, b: rb, changes: cmp.changes };
  });

  app.get("/test-runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findFirst({ where: { id, project: { organisationId: req.user.organisationId } }, include: runInclude });
    if (!run) throw notFound("Test run");
    const [dto] = await runDtos([run]);
    const discovery = run.executionType === "DISCOVERY" ? await prisma.discovery.findFirst({ where: { testRunId: id } }) : null;
    return { ...dto, environment: run.environment ? environmentDto(run.environment) : null, results: await resultDtos(await fullResults({ testRunId: id })), discoveryId: discovery?.id ?? null };
  });

  // Live view of an automated run: which tests are on screen in each worker slot right now.
  app.get("/test-runs/:id/live", async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findFirst({ where: { id, project: { organisationId: req.user.organisationId } } });
    if (!run) throw notFound("Test run");
    const dir = liveDir(id);
    const files = run.status === "RUNNING" ? await fs.readdir(dir).catch(() => []) : [];
    const slots = await Promise.all(files.filter((f) => /^w\d+\.json$/.test(f)).map(async (f) => ({
      slot: Number(f.slice(1, -5)), ...parse<{ title?: string; state?: string; at?: number }>(await fs.readFile(path.join(dir, f), "utf8").catch(() => null), {}),
      hasFrame: files.includes(f.replace(".json", ".jpg")),
    })));
    return { status: run.status, live: run.status === "RUNNING" && run.executionType === "AUTOMATED", slots: slots.sort((a, b) => a.slot - b.slot) };
  });

  // MJPEG stream of one worker slot; usable directly as <img src>. Ends when the run's workspace is removed.
  app.get("/test-runs/:id/live/:slot", async (req, reply) => {
    const { id, slot } = req.params as { id: string; slot: string };
    if (!/^\d{1,2}$/.test(slot)) throw badRequest("Invalid slot");
    const run = await prisma.testRun.findFirst({ where: { id, project: { organisationId: req.user.organisationId } } });
    if (!run) throw notFound("Test run");
    const file = path.join(liveDir(id), `w${slot}.jpg`);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store", connection: "close" });
    let lastMtime = 0, missingSince = 0;
    const started = Date.now();
    const timer = setInterval(async () => {
      const st = await fs.stat(file).catch(() => null);
      if (!st) {
        missingSince ||= Date.now();
        if (Date.now() - missingSince > 15_000 && !(await fs.stat(liveDir(id)).catch(() => null))) return stop();
      } else if (st.mtimeMs !== lastMtime) {
        missingSince = 0;
        lastMtime = st.mtimeMs;
        const frame = await fs.readFile(file).catch(() => null);
        if (frame) reply.raw.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from("\r\n")]));
      }
      if (Date.now() - started > 60 * 60_000) stop();
    }, 120);
    const stop = () => {
      clearInterval(timer);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    req.raw.on("close", stop);
  });

  app.post("/test-runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findFirst({ where: { id, project: { organisationId: req.user.organisationId } } });
    if (!run) throw notFound("Test run");
    if (!["QUEUED", "RUNNING", "IN_PROGRESS"].includes(run.status)) throw badRequest("Run is already finished");
    cancel(id);
    await prisma.testRun.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
    return { ok: true };
  });

  app.patch("/test-results/:id", async (req) => {
    const r = await resultForUser(req.user, (req.params as { id: string }).id);
    if (r.testRun.executionType !== "MANUAL") throw badRequest("Only manual results can be edited; automated results are recorded by the execution engine");
    if (r.testRun.status !== "IN_PROGRESS") throw badRequest("This run is completed and its results are locked");
    const body = z.object({
      status: z.enum(["PASSED", "FAILED", "BLOCKED", "NOT_EXECUTED"]).optional(),
      stepResults: z.array(z.object({ index: z.number(), status: z.enum(["PASSED", "FAILED", "BLOCKED", "NOT_EXECUTED"]), note: z.string().optional(), actual: z.string().optional() })).optional(),
      actualResult: z.string().optional(), errorMessage: z.string().optional(), note: z.string().optional(),
    }).parse(req.body);
    // Overall status defaults to the worst step status when not set explicitly.
    let status = body.status;
    if (!status && body.stepResults) {
      const s = body.stepResults.map((x) => x.status);
      status = s.includes("FAILED") ? "FAILED" : s.includes("BLOCKED") ? "BLOCKED" : s.every((x) => x === "PASSED") && s.length ? "PASSED" : (r.status as NonNullable<typeof status>);
    }
    await prisma.testResult.update({
      where: { id: r.id },
      data: {
        status, stepResults: body.stepResults ? str(body.stepResults) : undefined, actualResult: body.actualResult, errorMessage: body.errorMessage,
        executedById: req.user.id, executedAt: new Date(),
      },
    });
    if (body.note) {
      const key = await putObject(`${req.user.organisationId}/${r.testRun.projectId}/runs/${r.testRunId}/${r.id}/note-${Date.now()}.txt`, body.note);
      await prisma.evidence.create({ data: { testRunId: r.testRunId, testResultId: r.id, fileType: "NOTE", name: `Note by ${req.user.fullName}`, mimeType: "text/plain", size: Buffer.byteLength(body.note), storageReference: key } });
    }
    return (await resultDtos(await fullResults({ id: r.id })))[0];
  });

  app.post("/test-results/:id/evidence", async (req) => {
    const r = await resultForUser(req.user, (req.params as { id: string }).id);
    const file = await req.file();
    if (!file) throw badRequest("Attach a file");
    const buf = await file.toBuffer();
    const safe = path.basename(file.filename).replace(/[^\w.-]/g, "_").slice(0, 100);
    const key = await putObject(`${req.user.organisationId}/${r.testRun.projectId}/runs/${r.testRunId}/${r.id}/${Date.now()}-${safe}`, buf);
    const type = file.mimetype.startsWith("image/") ? "SCREENSHOT" : file.mimetype.startsWith("video/") ? "VIDEO" : "ATTACHMENT";
    const ev = await prisma.evidence.create({ data: { testRunId: r.testRunId, testResultId: r.id, fileType: type, name: file.filename, mimeType: file.mimetype, size: buf.length, storageReference: key } });
    return evidenceDto(ev);
  });

  app.post("/test-runs/:id/complete", async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findFirst({ where: { id, project: { organisationId: req.user.organisationId } } });
    if (!run) throw notFound("Test run");
    if (run.executionType !== "MANUAL" || run.status !== "IN_PROGRESS") throw badRequest("Only an in-progress manual run can be completed");
    await complete(id);
    // Failed manual results get a (hypothesis) analysis, like automated ones.
    const failed = await prisma.testResult.findMany({ where: { testRunId: id, status: "FAILED" }, include: { testCase: true } });
    for (const f of failed)
      void analyseFailure({ testCase: { key: f.testCaseKey, title: f.testCaseTitle, steps: parse(f.testCase?.steps, []), expectedResult: f.testCase?.expectedResult ?? "" }, executionType: "MANUAL", status: f.status, errorMessage: `${f.errorMessage}\n${f.actualResult}` })
        .then((a) => prisma.testResult.update({ where: { id: f.id }, data: { failureAnalysis: str(a) } })).catch(() => {});
    const full = await prisma.testRun.findUniqueOrThrow({ where: { id }, include: runInclude });
    return (await runDtos([full]))[0];
  });

  app.post("/test-results/:id/analyse", async (req) => {
    const r = await resultForUser(req.user, (req.params as { id: string }).id);
    if (!["FAILED", "ERROR", "BLOCKED"].includes(r.status)) throw badRequest("Only failed, errored or blocked results can be analysed");
    const logs = await Promise.all(r.evidence.filter((e) => e.fileType.endsWith("LOG")).map(async (e) => ({ type: e.fileType, text: (await getObject(e.storageReference).catch(() => Buffer.from(""))).toString("utf8").slice(-3000) })));
    const prev = await prisma.testResult.findMany({ where: { testCaseId: r.testCaseId, id: { not: r.id }, status: { in: ["PASSED", "FAILED", "ERROR"] } }, orderBy: { createdAt: "desc" }, take: 5 });
    const secrets = r.testRun.environment ? secretValues(envCredentials(r.testRun.environment)) : [];
    const analysis = await analyseFailure({
      testCase: { key: r.testCaseKey, title: r.testCaseTitle, steps: parse(r.testCase?.steps, []), expectedResult: r.testCase?.expectedResult ?? "" },
      executionType: r.testRun.executionType, status: r.status, errorMessage: `${r.errorMessage}\n${r.actualResult}`, failedStep: parse<{ status: string; label?: string }[]>(r.stepResults, []).find((s) => s.status === "FAILED")?.label,
      consoleExcerpt: logs.find((l) => l.type === "CONSOLE_LOG")?.text, networkExcerpt: logs.find((l) => l.type === "NETWORK_LOG")?.text,
      apiExchange: parse(r.apiExchange, null), previousResults: prev.map((p) => p.status),
    }, secrets);
    await prisma.testResult.update({ where: { id: r.id }, data: { failureAnalysis: str(analysis) } });
    return analysis;
  });

  app.get("/evidence/:id/file", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ev = await prisma.evidence.findFirst({ where: { id, testRun: { project: { organisationId: req.user.organisationId } } } });
    if (!ev) throw notFound("Evidence");
    const data = await getObject(ev.storageReference).catch(() => null);
    if (!data) throw notFound("Evidence file");
    // Uploaded files carry a client-chosen MIME type: only passive formats open inline, everything else downloads,
    // and the sandbox CSP stops any HTML/SVG that slips through from running script on this origin.
    const inline = INLINE_MIME.has(ev.mimeType.toLowerCase());
    reply
      .header("content-type", inline ? ev.mimeType : "application/octet-stream")
      .header("content-disposition", contentDisposition(inline ? "inline" : "attachment", ev.name))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header("cache-control", "private, max-age=300");
    return reply.send(data);
  });

  // ---------------- API testing ----------------
  const endpointBody = z.object({
    name: z.string().trim().min(1), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).refine((p) => !/^([a-z][\w+.-]*:|\/\/|\\)/i.test(p.trim()), "Path must be relative to the environment URL, e.g. /api/items"),
    headers: z.record(z.string(), z.string()).default({}), query: z.record(z.string(), z.string()).default({}), body: z.unknown().optional(),
    auth: z.enum(["NONE", "BEARER", "API_KEY", "BASIC"]).default("NONE"), expectedStatus: z.number().int().default(200), maxResponseMs: z.number().int().default(2000),
    requiredFields: z.array(z.string()).default([]), jsonSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  });
  const endpointDto = (e: Awaited<ReturnType<typeof prisma.apiEndpoint.findFirstOrThrow>>) => ({ ...e, headers: parse(e.headers, {}), query: parse(e.query, {}), body: parse(e.body, null), requiredFields: parse(e.requiredFields, []), jsonSchema: parse(e.jsonSchema, null) });
  const endpointForUser = async (user: AuthUser, id: string) => {
    const e = await prisma.apiEndpoint.findFirst({ where: { id, project: { organisationId: user.organisationId } } });
    if (!e) throw notFound("API endpoint");
    return e;
  };
  const toData = (b: Partial<z.infer<typeof endpointBody>>) => ({
    ...b, headers: b.headers && str(b.headers), query: b.query && str(b.query), body: b.body === undefined ? undefined : str(b.body),
    requiredFields: b.requiredFields && str(b.requiredFields), jsonSchema: b.jsonSchema === undefined ? undefined : b.jsonSchema ? str(b.jsonSchema) : null,
  });

  app.get("/projects/:id/api-endpoints", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    return (await prisma.apiEndpoint.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } })).map(endpointDto);
  });

  app.post("/projects/:id/api-endpoints", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const b = endpointBody.parse(req.body);
    return endpointDto(await prisma.apiEndpoint.create({ data: { ...toData(b), name: b.name, method: b.method, path: b.path, projectId: id } as never }));
  });

  app.patch("/api-endpoints/:id", async (req) => {
    const e = await endpointForUser(req.user, (req.params as { id: string }).id);
    return endpointDto(await prisma.apiEndpoint.update({ where: { id: e.id }, data: toData(provided(endpointBody.partial().parse(req.body), req.body)) as never }));
  });

  app.delete("/api-endpoints/:id", async (req, reply) => {
    const e = await endpointForUser(req.user, (req.params as { id: string }).id);
    await prisma.apiEndpoint.delete({ where: { id: e.id } });
    reply.code(204).send();
  });

  app.post("/projects/:id/api-endpoints/import-openapi", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const { spec } = z.object({ spec: z.string().min(2).max(2_000_000) }).parse(req.body);
    const parsed = parseOpenApi(spec);
    const imported = [];
    for (const e of parsed.slice(0, 300)) {
      const { requestSchema: _r, ...rest } = e;
      imported.push(await prisma.apiEndpoint.create({ data: { ...toData(rest as never), name: e.name, method: e.method, path: e.path, projectId: id, jsonSchema: e.jsonSchema ? str({ ...e.jsonSchema, "x-request-schema": e.requestSchema }) : e.requestSchema ? str({ "x-request-schema": e.requestSchema }) : null } as never }));
    }
    await recordActivity({ organisationId: req.user.organisationId, projectId: id, userId: req.user.id, actionType: "OPENAPI_IMPORTED", message: `${imported.length} API endpoint(s) imported from OpenAPI`, link: `/projects/${id}?tab=api` });
    return { imported: imported.map(endpointDto) };
  });

  app.post("/api-endpoints/:id/send", async (req) => {
    const e = await endpointForUser(req.user, (req.params as { id: string }).id);
    const { environmentId, confirm } = z.object({ environmentId: z.string(), confirm: z.boolean().optional() }).parse(req.body);
    const env = await prisma.environment.findFirst({ where: { id: environmentId, projectId: e.projectId } });
    if (!env) throw notFound("Environment");
    if (!env.authorised) throw new HttpError(409, `Confirm that you are authorised to test ${env.baseUrl} first (Environments tab).`);
    if (DESTRUCTIVE.has(e.method) && !env.allowDestructive) throw new HttpError(409, `${env.name} is read-only: ${e.method} requests are disabled for this environment.`);
    // FR-060: write requests need explicit confirmation from the user.
    if (DESTRUCTIVE.has(e.method) && !confirm) throw new HttpError(409, `${e.method} may modify data on ${env.name}. Confirm to send.`, { requiresConfirmation: true });
    await audit(req.user.organisationId, req.user.id, "api.request_sent", `${e.method} ${e.path}`, { env: env.name });
    return executeApi(endpointToSpec(e), env);
  });

  app.post("/projects/:id/api-endpoints/generate-tests", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const { endpointIds } = z.object({ endpointIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    const endpoints = await prisma.apiEndpoint.findMany({ where: { projectId: id, ...(endpointIds?.length ? { id: { in: endpointIds } } : {}) } });
    if (!endpoints.length) throw badRequest("Add or import API endpoints first");
    const plans = endpoints.flatMap((e) => {
      const spec = endpointToSpec(e);
      return heuristicApiCases({ id: e.id, name: e.name, method: e.method, path: e.path, headers: spec.headers ?? {}, query: spec.query ?? {}, body: spec.body, auth: spec.auth ?? "NONE", expectedStatus: e.expectedStatus, requiredFields: spec.requiredFields ?? [], jsonSchema: spec.jsonSchema ?? null, requestSchema: requestSchema(e) })
        .map((p) => ({ ...p, endpoint: e }));
    });
    const keys = await nextKey(req.user.organisationId, "case", plans.length);
    const created = [];
    for (const [i, p] of plans.entries()) {
      const destructive = DESTRUCTIVE.has(p.endpoint.method);
      created.push(await prisma.testCase.create({
        data: {
          key: keys[i], projectId: id, title: p.title, description: `Automated API check for ${p.endpoint.method} ${p.endpoint.path}`,
          preconditions: destructive ? "Run only against an environment where write requests are authorised." : "",
          steps: str([{ action: `Send ${p.endpoint.method} ${p.endpoint.path}${p.spec.omitAuth ? " without authentication" : p.spec.invalidAuth ? " with invalid credentials" : p.spec.body !== undefined ? " with the modified body" : ""}`, expected: p.expectedResult }]),
          expectedResult: p.expectedResult, category: p.category, priority: p.priority, status: "DRAFT", source: "AI", aiGenerated: true,
          apiEndpointId: p.endpoint.id, apiSpec: str(p.spec),
        },
      }));
    }
    await recordActivity({ organisationId: req.user.organisationId, projectId: id, userId: req.user.id, actionType: "CASES_GENERATED", message: `${created.length} API test case(s) generated`, link: `/projects/${id}?tab=cases` });
    return { generated: await casesWithMeta(created) };
  });
}

const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/webm", "video/mp4", "text/plain"]);

/** RFC 6266 header with an ASCII fallback and a UTF-8 filename*, so non-Latin names don't break the response. */
function contentDisposition(type: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "file";
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
