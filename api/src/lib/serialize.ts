import type {
  Defect, Environment, Evidence, Project, Report, Script, TestCase, TestResult, TestRun, User,
} from "@prisma/client";
import { prisma } from "../db.js";
import { parse } from "./json.js";
import { decrypt } from "./crypto.js";

// Converts DB rows into the shapes documented in docs/API.md.

type Person = { id: string; fullName: string } | null;

export async function peopleById(ids: (string | null | undefined)[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  const users = unique.length ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } }) : [];
  return new Map(users.map((u) => [u.id, u]));
}

export const userDto = (u: User) => ({
  id: u.id, fullName: u.fullName, email: u.email, role: u.role, organisationId: u.organisationId, createdAt: u.createdAt,
});

export const environmentDto = (e: Environment) => ({
  id: e.id, projectId: e.projectId, name: e.name, baseUrl: e.baseUrl,
  configuration: parse<Record<string, unknown>>(e.configuration, {}),
  hasCredentials: Boolean(e.encryptedCredentials), authorised: e.authorised, allowDestructive: e.allowDestructive,
  hasRemoteBrowser: Boolean(e.encryptedCredentials && parse<{ playwrightWsEndpoint?: string }>(decrypt(e.encryptedCredentials), {}).playwrightWsEndpoint),
});

export const projectDto = (p: Project & { environments?: Environment[] }) => ({
  id: p.id, name: p.name, description: p.description, applicationUrl: p.applicationUrl,
  applicationType: p.applicationType, createdAt: p.createdAt, updatedAt: p.updatedAt,
  environments: (p.environments ?? []).map(environmentDto),
});

export async function projectStats(projectId: string) {
  const [testCases, runnableCases, openDefects, lastRun, counts] = await Promise.all([
    prisma.testCase.count({ where: { projectId } }),
    prisma.testCase.count({ where: { projectId, status: { in: ["APPROVED", "READY"] } } }),
    prisma.defect.count({ where: { projectId, status: { notIn: ["CLOSED", "FIXED"] } } }),
    prisma.testRun.findFirst({ where: { projectId, executionType: { not: "DISCOVERY" } }, orderBy: { createdAt: "desc" } }),
    prisma.testResult.groupBy({ by: ["status"], where: { testRun: { projectId } }, _count: true }),
  ]);
  const by = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  const decided = (by.PASSED ?? 0) + (by.FAILED ?? 0) + (by.ERROR ?? 0);
  return {
    testCases, runnableCases, openDefects,
    lastRunAt: lastRun?.completedAt ?? lastRun?.createdAt ?? null,
    lastRunStatus: lastRun?.status ?? null,
    passRate: decided ? Math.round(((by.PASSED ?? 0) / decided) * 1000) / 10 : null,
  };
}

export const caseDto = (c: TestCase, extra: { lastResult?: string | null; hasScript?: boolean } = {}) => ({
  id: c.id, key: c.key, projectId: c.projectId, title: c.title, description: c.description,
  preconditions: c.preconditions, steps: parse(c.steps, []), expectedResult: c.expectedResult,
  category: c.category, priority: c.priority, status: c.status, source: c.source, aiGenerated: c.aiGenerated,
  version: c.version, apiEndpointId: c.apiEndpointId, discoveryId: c.discoveryId, lastResult: extra.lastResult ?? null,
  hasScript: extra.hasScript ?? false, createdAt: c.createdAt, updatedAt: c.updatedAt,
});

export async function casesWithMeta(cases: TestCase[]) {
  const ids = cases.map((c) => c.id);
  const [scripts, results] = await Promise.all([
    prisma.script.findMany({ where: { testCaseId: { in: ids } }, select: { testCaseId: true } }),
    prisma.testResult.findMany({
      where: { testCaseId: { in: ids }, status: { not: "NOT_EXECUTED" } },
      orderBy: { createdAt: "desc" }, select: { testCaseId: true, status: true },
    }),
  ]);
  const withScript = new Set(scripts.map((s) => s.testCaseId));
  const last = new Map<string, string>();
  for (const r of results) if (r.testCaseId && !last.has(r.testCaseId)) last.set(r.testCaseId, r.status);
  return cases.map((c) => caseDto(c, { lastResult: last.get(c.id) ?? null, hasScript: withScript.has(c.id) }));
}

export const scriptDto = (s: Script) => ({
  id: s.id, testCaseId: s.testCaseId, testCaseVersion: s.testCaseVersion, version: s.version,
  language: s.language, code: s.code, createdAt: s.createdAt, createdBy: s.createdBy,
});

export const evidenceDto = (e: Evidence) => ({
  id: e.id, testRunId: e.testRunId, testResultId: e.testResultId, fileType: e.fileType, name: e.name,
  url: `/api/evidence/${e.id}/file`, mimeType: e.mimeType, size: e.size, createdAt: e.createdAt,
});

export function runSummary(run: TestRun, results: Pick<TestResult, "status">[]) {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count("PASSED"), failed = count("FAILED"), error = count("ERROR");
  const decided = passed + failed + error;
  return {
    total: results.length, passed, failed, blocked: count("BLOCKED"), notExecuted: count("NOT_EXECUTED"), error,
    passRate: decided ? Math.round((passed / decided) * 1000) / 10 : null,
    durationMs: run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : null,
  };
}

export async function runDtos(runs: (TestRun & { project: Project; environment: Environment | null; results: Pick<TestResult, "status">[] })[]) {
  const people = await peopleById(runs.map((r) => r.initiatedById));
  return runs.map((r) => ({
    id: r.id, key: r.key, projectId: r.projectId, projectName: r.project.name, name: r.name,
    executionType: r.executionType, environmentId: r.environmentId, environmentName: r.environment?.name ?? null,
    status: r.status, initiatedBy: people.get(r.initiatedById ?? "") ?? null, initiatedByAI: r.initiatedByAI,
    startedAt: r.startedAt, completedAt: r.completedAt, createdAt: r.createdAt, summary: runSummary(r, r.results),
  }));
}

export const runInclude = { project: true, environment: true, results: { select: { status: true } } } as const;

export async function resultDtos(results: (TestResult & { evidence: Evidence[]; defects: Pick<Defect, "id">[] })[]) {
  const people = await peopleById(results.map((r) => r.executedById));
  return results.map((r) => ({
    id: r.id, testRunId: r.testRunId, testCaseId: r.testCaseId, testCaseKey: r.testCaseKey, testCaseTitle: r.testCaseTitle,
    status: r.status, actualResult: r.actualResult, errorMessage: r.errorMessage, durationMs: r.durationMs,
    scriptVersion: r.scriptVersion, stepResults: parse(r.stepResults, []), executedBy: people.get(r.executedById ?? "") ?? null,
    executedAt: r.executedAt, failureAnalysis: parse(r.failureAnalysis, null), evidence: r.evidence.map(evidenceDto),
    apiExchange: parse(r.apiExchange, null), defectId: r.defects[0]?.id ?? null,
  }));
}

export async function defectDtos(defects: (Defect & { project: Project; testResult: (TestResult & { evidence: Evidence[]; testRun: TestRun }) | null })[]) {
  const people = await peopleById(defects.map((d) => d.createdById));
  const attached = await prisma.evidence.findMany({ where: { defectId: { in: defects.map((d) => d.id) } } });
  return defects.map((d) => ({
    id: d.id, key: d.key, projectId: d.projectId, projectName: d.project.name, testResultId: d.testResultId,
    testCaseId: d.testResult?.testCaseId ?? null, testCaseKey: d.testResult?.testCaseKey ?? null,
    testRunId: d.testResult?.testRunId ?? null,
    title: d.title, description: d.description, severity: d.severity, priority: d.priority, status: d.status,
    environmentName: d.environmentName, reproductionSteps: parse<string[]>(d.reproductionSteps, []),
    expectedResult: d.expectedResult, actualResult: d.actualResult, aiAnalysis: parse(d.aiAnalysis, null),
    evidence: [...(d.testResult?.evidence ?? []), ...attached.filter((e) => e.defectId === d.id)].map(evidenceDto),
    createdBy: people.get(d.createdById ?? "") ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt,
  }));
}

export const defectInclude = { project: true, testResult: { include: { evidence: true, testRun: true } } } as const;

export async function reportDtos(reports: (Report & { project: Project })[]) {
  const people = await peopleById(reports.map((r) => r.createdById));
  return reports.map((r) => ({
    id: r.id, projectId: r.projectId, projectName: r.project.name, testRunId: r.testRunId, reportType: r.reportType,
    format: r.format, title: r.title, createdAt: r.createdAt, createdBy: people.get(r.createdById ?? "") ?? null,
    downloadUrl: `/api/reports/${r.id}/download`,
  }));
}
