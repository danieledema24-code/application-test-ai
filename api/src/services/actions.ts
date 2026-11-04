import { prisma } from "../db.js";
import type { AuthUser } from "../auth.js";
import { getProjectForUser } from "../auth.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { parse, str } from "../lib/json.js";
import { nextKey } from "../lib/keys.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { emitWebhook, recordActivity } from "./activity.js";
import { generateCases, type GenerationSource } from "./generation.js";
import { enqueue } from "./queue.js";
import { generateReport } from "./reports.js";
import type { DiscoveryResult } from "./discovery.js";

// Platform operations shared by the REST routes and the AI assistant (FR-059): the assistant
// calls these same functions, so it gets exactly the same permission and safety checks.

export async function startRun(user: AuthUser, projectId: string, input: { executionType: string; environmentId?: string; testCaseIds: string[]; name?: string }, viaAI = false) {
  const project = await getProjectForUser(user, projectId);
  if (!["MANUAL", "AUTOMATED", "API"].includes(input.executionType)) throw badRequest("executionType must be MANUAL, AUTOMATED or API");
  const env = input.environmentId
    ? await prisma.environment.findFirst({ where: { id: input.environmentId, projectId } })
    : await prisma.environment.findFirst({ where: { projectId }, orderBy: { createdAt: "asc" } });
  if (!env) throw badRequest("Choose an environment for this project first");
  if (input.executionType !== "MANUAL") {
    if (!env.authorised) throw new HttpError(409, `You must confirm you are authorised to test ${env.baseUrl} before running automated tests (Environments tab).`);
    await assertSafeTarget(env.baseUrl);
  }
  const cases = await prisma.testCase.findMany({ where: { id: { in: input.testCaseIds }, projectId } });
  if (!cases.length) throw badRequest("Select at least one test case");
  const unapproved = cases.filter((c) => !["APPROVED", "READY"].includes(c.status));
  if (unapproved.length) throw badRequest(`Only approved or ready test cases can be executed. Not approved: ${unapproved.map((c) => c.key).join(", ")}`);
  if (input.executionType === "API") {
    const missing = cases.filter((c) => !c.apiEndpointId && !c.apiSpec);
    if (missing.length) throw badRequest(`These cases have no API request defined: ${missing.map((c) => c.key).join(", ")}`);
    if (!env.allowDestructive) {
      const endpoints = await prisma.apiEndpoint.findMany({ where: { id: { in: cases.map((c) => c.apiEndpointId!).filter(Boolean) } } });
      const method = (c: (typeof cases)[number]) => parse<{ method?: string }>(c.apiSpec, {}).method ?? endpoints.find((e) => e.id === c.apiEndpointId)?.method ?? "GET";
      const destructive = cases.filter((c) => method(c) !== "GET");
      if (destructive.length)
        throw new HttpError(409, `Environment ${env.name} is read-only; ${destructive.map((c) => c.key).join(", ")} would send write requests. Enable destructive testing for this environment if you are authorised.`);
    }
  }
  const [key] = await nextKey(user.organisationId, "run");
  const run = await prisma.testRun.create({
    data: {
      key, projectId, name: input.name || `${input.executionType.charAt(0) + input.executionType.slice(1).toLowerCase()} run — ${cases.length} case(s)`,
      initiatedById: user.id, initiatedByAI: viaAI, executionType: input.executionType, environmentId: env.id,
      status: input.executionType === "MANUAL" ? "IN_PROGRESS" : "QUEUED", startedAt: input.executionType === "MANUAL" ? new Date() : null,
      results: { create: cases.map((c) => ({ testCaseId: c.id, testCaseKey: c.key, testCaseTitle: c.title, testCaseVersion: c.version, stepResults: str(parse<unknown[]>(c.steps, []).map((_, i) => ({ index: i, status: "NOT_EXECUTED" }))) })) },
    },
  });
  if (input.executionType === "MANUAL") emitWebhook(user.organisationId, "run.started", { runId: run.id, runKey: run.key, projectId });
  else enqueue({ type: input.executionType === "API" ? "api-run" : "automated-run", id: run.id });
  await recordActivity({ organisationId: user.organisationId, projectId, userId: user.id, viaAI, actionType: "RUN_STARTED", message: `${run.key} started on ${env.name.toLowerCase()} (${cases.length} case(s))`, link: `/test-runs/${run.id}`, executionReference: run.id });
  return { run, project, env, cases };
}

export async function generateCasesForProject(user: AuthUser, projectId: string, input: { source: GenerationSource; text?: string; discoveryId?: string; categories?: string[]; count?: number }, viaAI = false) {
  const project = await getProjectForUser(user, projectId);
  let pages: DiscoveryResult["pages"] = [];
  let workflows: unknown;
  if (input.source === "DISCOVERY") {
    const d = input.discoveryId
      ? await prisma.discovery.findFirst({ where: { id: input.discoveryId, projectId } })
      : await prisma.discovery.findFirst({ where: { projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    if (!d || d.status !== "COMPLETED") throw badRequest("Run a successful application discovery first, or choose another source");
    const r = parse<DiscoveryResult>(d.result, {} as DiscoveryResult);
    pages = r.pages ?? [];
    workflows = r.workflows;
  } else if (!input.text?.trim()) throw badRequest("Provide the text to generate test cases from");
  if (input.source === "OPENAPI") throw badRequest("Use the API tab's OpenAPI import, then 'Generate API tests'");
  const { cases, generatedBy, notes } = await generateCases({ ...input, pages, workflows, applicationUrl: project.applicationUrl });
  const keys = await nextKey(user.organisationId, "case", cases.length || 1);
  const created = [];
  for (const [i, c] of cases.entries())
    created.push(await prisma.testCase.create({
      data: { key: keys[i], projectId, title: c.title, description: c.description, preconditions: c.preconditions, steps: str(c.steps), expectedResult: c.expectedResult, category: c.category, priority: c.priority, status: "DRAFT", source: "AI", aiGenerated: true },
    }));
  await recordActivity({ organisationId: user.organisationId, projectId, userId: user.id, viaAI, actionType: "CASES_GENERATED", message: `${created.length} draft test case(s) generated from ${input.source.toLowerCase().replace("_", " ")}`, link: `/projects/${projectId}?tab=cases` });
  return { created, generatedBy, notes };
}

export async function createReportFor(user: AuthUser, input: { projectId: string; testRunId?: string | null; format: "PDF" | "CSV" }, viaAI = false) {
  await getProjectForUser(user, input.projectId);
  if (!["PDF", "CSV"].includes(input.format)) throw badRequest("format must be PDF or CSV");
  if (input.testRunId && !(await prisma.testRun.findFirst({ where: { id: input.testRunId, projectId: input.projectId } }))) throw notFound("Test run");
  const report = await generateReport({ ...input, userId: user.id, orgId: user.organisationId });
  await recordActivity({ organisationId: user.organisationId, projectId: input.projectId, userId: user.id, viaAI, actionType: "REPORT_GENERATED", message: `${report.format} report generated: ${report.title}`, link: `/reports` });
  emitWebhook(user.organisationId, "report.generated", { reportId: report.id, projectId: input.projectId, format: report.format });
  return report;
}

export async function compareRuns(user: AuthUser, aId: string, bId: string) {
  const load = (id: string) => prisma.testRun.findFirst({ where: { id, project: { organisationId: user.organisationId } }, include: { results: true, project: true, environment: true } });
  const [a, b] = await Promise.all([load(aId), load(bId)]);
  if (!a || !b) throw notFound("Test run");
  const byCase = (rs: typeof a.results) => new Map(rs.map((r) => [r.testCaseKey, r]));
  const am = byCase(a.results), bm = byCase(b.results);
  const keys = [...new Set([...am.keys(), ...bm.keys()])].sort();
  const changes = keys
    .map((k) => ({ testCaseKey: k, title: (bm.get(k) ?? am.get(k))!.testCaseTitle, from: am.get(k)?.status ?? null, to: bm.get(k)?.status ?? null }))
    .filter((c) => c.from !== c.to);
  return { a, b, changes };
}
