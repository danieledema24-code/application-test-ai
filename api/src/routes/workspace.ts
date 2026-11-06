import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { authenticate, getProjectForUser, requireAdmin, type AuthUser } from "../auth.js";
import { notFound } from "../lib/errors.js";
import { encrypt, randomToken } from "../lib/crypto.js";
import { parse, provided, str } from "../lib/json.js";
import { nextKey } from "../lib/keys.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { getObject } from "../lib/storage.js";
import { defectDtos, defectInclude, peopleById, projectDto, projectStats, reportDtos, runDtos, runInclude } from "../lib/serialize.js";
import { audit, emitWebhook, recordActivity } from "../services/activity.js";
import { aiJSON, aiStatus } from "../services/ai.js";
import { createReportFor } from "../services/actions.js";
import { queueStats } from "../services/queue.js";

const SEVERITY = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const DEFECT_STATUS = z.enum(["OPEN", "IN_PROGRESS", "FIXED", "RETEST_REQUIRED", "CLOSED", "REOPENED"]);
const defectBody = z.object({
  projectId: z.string(), testResultId: z.string().nullable().optional(), title: z.string().trim().min(1).max(300), description: z.string().default(""),
  severity: SEVERITY.default("MEDIUM"), priority: SEVERITY.default("MEDIUM"), reproductionSteps: z.array(z.string()).default([]),
  expectedResult: z.string().default(""), actualResult: z.string().default(""), environmentName: z.string().default(""),
  aiAnalysis: z.unknown().optional(),
});
const DraftSchema = z.object({
  title: z.string(), description: z.string(), severity: SEVERITY, priority: SEVERITY, reproductionSteps: z.array(z.string()),
  expectedResult: z.string(), actualResult: z.string(),
});

/** "<case>: <first failed check>" (API) or "<case>: step "<step>" failed" (UI), instead of a bare "— failed". */
function defectTitle(caseTitle: string, status: string, stepResults: { status: string; label?: string; note?: string }[]) {
  const failed = stepResults.find((s) => s.status === "FAILED");
  const cause = !failed ? status.toLowerCase()
    : failed.note && failed.note.length <= 120 && !/\n/.test(failed.note) ? `${failed.label ? `${failed.label} — ` : ""}${failed.note}`
    : `step "${failed.label}" failed`;
  const title = `${caseTitle}: ${cause}`;
  return title.length > 200 ? `${title.slice(0, 197)}…` : title;
}

export async function defectDraftFromResult(user: AuthUser, resultId: string) {
  const r = await prisma.testResult.findFirst({ where: { id: resultId, testRun: { project: { organisationId: user.organisationId } } }, include: { testCase: true, testRun: { include: { environment: true } } } });
  if (!r) throw notFound("Test result");
  const steps = parse<{ action: string }[]>(r.testCase?.steps, []).map((s) => s.action);
  const stepResults = parse<{ index: number; status: string; note?: string; label?: string }[]>(r.stepResults, []);
  const analysis = parse<{ summary?: string; classification?: string } | null>(r.failureAnalysis, null);
  const severity = r.testCase?.priority === "CRITICAL" ? "CRITICAL" : r.testCase?.priority === "HIGH" ? "HIGH" : "MEDIUM";
  const base = {
    projectId: r.testRun.projectId, testResultId: r.id,
    title: defectTitle(r.testCaseTitle, r.status, stepResults),
    description: `Test ${r.testCaseKey} ${r.status.toLowerCase()} during ${r.testRun.key} (${r.testRun.executionType.toLowerCase()}).\n\n${r.errorMessage}`.trim(),
    severity, priority: severity, reproductionSteps: steps.length ? steps : stepResults.map((s) => s.label ?? `Step ${s.index + 1}`),
    expectedResult: r.testCase?.expectedResult ?? "", actualResult: r.actualResult || r.errorMessage || stepResults.filter((s) => s.status === "FAILED").map((s) => s.note).join("; "),
    environmentName: r.testRun.environment ? `${r.testRun.environment.name} (${r.testRun.environment.baseUrl})` : "", aiAnalysis: analysis,
    generatedBy: "template" as "template" | "claude",
  };
  const ai = await aiJSON({
    schema: DraftSchema, effort: "low",
    task: "Write a clear, developer-ready defect report from this failed test. Keep facts from the evidence; do not invent behaviour. Severity reflects user impact.",
    input: { ...base, failureAnalysis: analysis, stepResults },
  });
  return ai ? { ...base, ...ai, generatedBy: "claude" as const } : base;
}

export async function workspaceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // ---------------- Dashboard ----------------
  app.get("/dashboard", async (req) => {
    const org = req.user.organisationId;
    const [projects, counts, openDefects, latest] = await Promise.all([
      prisma.project.findMany({ where: { organisationId: org }, include: { environments: true }, orderBy: { updatedAt: "desc" } }),
      prisma.testResult.groupBy({ by: ["status"], where: { testRun: { project: { organisationId: org } }, status: { not: "NOT_EXECUTED" } }, _count: true }),
      prisma.defect.count({ where: { project: { organisationId: org }, status: { notIn: ["CLOSED", "FIXED"] } } }),
      prisma.testRun.findFirst({ where: { project: { organisationId: org }, executionType: { not: "DISCOVERY" } }, include: runInclude, orderBy: { createdAt: "desc" } }),
    ]);
    const by = Object.fromEntries(counts.map((c) => [c.status, c._count]));
    const executed = Object.values(by).reduce((a, b) => a + b, 0);
    const decided = (by.PASSED ?? 0) + (by.FAILED ?? 0) + (by.ERROR ?? 0);
    // "Recently accessed" ≈ most recently updated or run.
    const withStats = await Promise.all(projects.map(async (p) => ({ ...projectDto(p), stats: await projectStats(p.id) })));
    withStats.sort((a, b) => +new Date(b.stats.lastRunAt ?? b.updatedAt) - +new Date(a.stats.lastRunAt ?? a.updatedAt));
    return {
      totals: { projects: projects.length, testsExecuted: executed, passRate: decided ? Math.round(((by.PASSED ?? 0) / decided) * 1000) / 10 : null, openDefects },
      latestRun: latest ? (await runDtos([latest]))[0] : null,
      recentProjects: withStats.slice(0, 6),
      quickStats: { passed: by.PASSED ?? 0, failed: (by.FAILED ?? 0) + (by.ERROR ?? 0), blocked: by.BLOCKED ?? 0, queue: queueStats() },
    };
  });

  app.get("/dashboard/trend", async (req) => {
    const days = [7, 30, 90].includes(Number((req.query as { days?: string }).days)) ? Number((req.query as { days?: string }).days) : 30;
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const results = await prisma.testResult.findMany({
      where: { testRun: { project: { organisationId: req.user.organisationId } }, executedAt: { gte: since }, status: { not: "NOT_EXECUTED" } },
      select: { status: true, executedAt: true },
    });
    const buckets = new Map<string, { date: string; passed: number; failed: number; blocked: number; other: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
      buckets.set(d, { date: d, passed: 0, failed: 0, blocked: 0, other: 0 });
    }
    for (const r of results) {
      const b = buckets.get(r.executedAt!.toISOString().slice(0, 10));
      if (!b) continue;
      if (r.status === "PASSED") b.passed++;
      else if (r.status === "FAILED" || r.status === "ERROR") b.failed++;
      else if (r.status === "BLOCKED") b.blocked++;
      else b.other++;
    }
    return [...buckets.values()];
  });

  app.get("/activity", async (req) => {
    const q = req.query as { limit?: string; projectId?: string };
    const items = await prisma.aIActivity.findMany({
      where: { organisationId: req.user.organisationId, ...(q.projectId ? { projectId: q.projectId } : {}) },
      include: { project: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: Math.min(Number(q.limit ?? 20), 100),
    });
    const people = await peopleById(items.map((i) => i.userId));
    return items.map((i) => ({
      id: i.id, type: i.actionType, status: i.actionStatus, message: i.message, projectId: i.projectId, projectName: i.project?.name ?? null,
      actor: people.get(i.userId ?? "") ?? null, viaAI: i.viaAI, link: i.link, createdAt: i.createdAt,
    }));
  });

  // ---------------- Defects ----------------
  app.get("/defects", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const defects = await prisma.defect.findMany({
      where: {
        project: { organisationId: req.user.organisationId }, ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.severity ? { severity: q.severity } : {}),
        ...(q.status ? { status: q.status } : {}), ...(q.environment ? { environmentName: { contains: q.environment } } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59Z`) } : {}) } } : {}),
        ...(q.search ? { OR: [{ title: { contains: q.search } }, { key: { contains: q.search } }, { description: { contains: q.search } }] } : {}),
      },
      include: defectInclude, orderBy: { createdAt: "desc" }, take: 500,
    });
    return defectDtos(defects);
  });

  app.post("/defects", async (req) => {
    const body = defectBody.parse(req.body);
    await getProjectForUser(req.user, body.projectId);
    const source = body.testResultId ? await prisma.testResult.findFirst({ where: { id: body.testResultId, testRun: { projectId: body.projectId } } }) : null;
    if (body.testResultId && !source) throw notFound("Test result");
    // Carry the failure's stored analysis onto the defect when the client didn't send one.
    body.aiAnalysis ??= parse(source?.failureAnalysis, undefined);
    const [key] = await nextKey(req.user.organisationId, "defect");
    const d = await prisma.defect.create({
      data: { ...body, key, testResultId: body.testResultId ?? null, reproductionSteps: str(body.reproductionSteps), aiAnalysis: body.aiAnalysis ? str(body.aiAnalysis) : null, createdById: req.user.id },
      include: defectInclude,
    });
    await recordActivity({ organisationId: req.user.organisationId, projectId: d.projectId, userId: req.user.id, actionType: "DEFECT_CREATED", message: `${d.key} ${d.title} (${d.severity.toLowerCase()})`, link: `/defects/${d.id}` });
    emitWebhook(req.user.organisationId, "defect.created", { defectId: d.id, key: d.key, title: d.title, severity: d.severity, projectId: d.projectId });
    await audit(req.user.organisationId, req.user.id, "defect.created", d.key);
    return (await defectDtos([d]))[0];
  });

  app.post("/test-results/:id/defect-draft", async (req) => defectDraftFromResult(req.user, (req.params as { id: string }).id));

  app.post("/ai/defect-from-notes", async (req) => {
    const { projectId, notes } = z.object({ projectId: z.string(), notes: z.string().min(5).max(20_000) }).parse(req.body);
    await getProjectForUser(req.user, projectId);
    const ai = await aiJSON({ schema: DraftSchema, effort: "low", task: "Convert these manual testing observations into a structured defect report. Only use facts present in the notes.", input: notes });
    if (ai) return { projectId, ...ai, generatedBy: "claude" };
    const lines = notes.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    return {
      projectId, title: lines[0].slice(0, 120), description: notes, severity: /crash|data loss|cannot|500|security/i.test(notes) ? "HIGH" : "MEDIUM", priority: "MEDIUM",
      reproductionSteps: lines.filter((l) => /^(\d+[.)]|-|\*)/.test(l)).map((l) => l.replace(/^(\d+[.)]|-|\*)\s*/, "")),
      expectedResult: lines.find((l) => /expect/i.test(l)) ?? "", actualResult: lines.find((l) => /actual|instead|but/i.test(l)) ?? "", generatedBy: "template",
    };
  });

  const defectForUser = async (user: AuthUser, id: string) => {
    const d = await prisma.defect.findFirst({ where: { id, project: { organisationId: user.organisationId } }, include: defectInclude });
    if (!d) throw notFound("Defect");
    return d;
  };

  app.get("/defects/:id", async (req) => (await defectDtos([await defectForUser(req.user, (req.params as { id: string }).id)]))[0]);

  app.patch("/defects/:id", async (req) => {
    const d = await defectForUser(req.user, (req.params as { id: string }).id);
    const body = provided(defectBody.omit({ projectId: true, testResultId: true, aiAnalysis: true }).partial().extend({ status: DEFECT_STATUS.optional() }).parse(req.body), req.body);
    const updated = await prisma.defect.update({ where: { id: d.id }, data: { ...body, reproductionSteps: body.reproductionSteps ? str(body.reproductionSteps) : undefined }, include: defectInclude });
    if (body.status && body.status !== d.status) {
      await audit(req.user.organisationId, req.user.id, "defect.status", d.key, { from: d.status, to: body.status });
      await recordActivity({ organisationId: req.user.organisationId, projectId: d.projectId, userId: req.user.id, actionType: "DEFECT_UPDATED", message: `${d.key} moved to ${body.status.toLowerCase().replace("_", " ")}`, link: `/defects/${d.id}` });
    }
    return (await defectDtos([updated]))[0];
  });

  app.delete("/defects/:id", async (req, reply) => {
    const d = await defectForUser(req.user, (req.params as { id: string }).id);
    await prisma.defect.delete({ where: { id: d.id } });
    await audit(req.user.organisationId, req.user.id, "defect.deleted", d.key);
    reply.code(204).send();
  });

  // ---------------- Reports ----------------
  app.get("/reports", async (req) => {
    const { projectId } = req.query as { projectId?: string };
    const reports = await prisma.report.findMany({ where: { project: { organisationId: req.user.organisationId }, ...(projectId ? { projectId } : {}) }, include: { project: true }, orderBy: { createdAt: "desc" } });
    return reportDtos(reports);
  });

  app.post("/reports", async (req) => {
    const body = z.object({ projectId: z.string(), testRunId: z.string().nullable().optional(), format: z.enum(["PDF", "CSV"]) }).parse(req.body);
    const report = await createReportFor(req.user, body);
    return (await reportDtos([{ ...report, project: await prisma.project.findUniqueOrThrow({ where: { id: report.projectId } }) }]))[0];
  });

  app.get("/reports/:id/download", async (req, reply) => {
    const r = await prisma.report.findFirst({ where: { id: (req.params as { id: string }).id, project: { organisationId: req.user.organisationId } } });
    if (!r) throw notFound("Report");
    const data = await getObject(r.fileReference);
    const name = `${r.title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-")}.${r.format.toLowerCase()}`;
    reply.header("content-type", r.format === "PDF" ? "application/pdf" : "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}"`);
    return reply.send(data);
  });

  // ---------------- Integrations & webhooks ----------------
  app.get("/integrations", async (req) => {
    const list = await prisma.integration.findMany({ where: { organisationId: req.user.organisationId }, orderBy: { createdAt: "asc" } });
    return list.map((i) => ({ id: i.id, provider: i.provider, connectionStatus: i.connectionStatus, config: parse(i.config, {}), createdAt: i.createdAt }));
  });

  app.post("/integrations", async (req) => {
    requireAdmin(req);
    const body = z.object({ provider: z.enum(["GITHUB", "GITLAB", "JIRA"]), config: z.object({ baseUrl: z.string().optional(), projectKey: z.string().optional(), repo: z.string().optional(), email: z.string().optional() }).default({}), token: z.string().min(4) }).parse(req.body);
    // Verify the token against the provider before storing it.
    const status = await verifyIntegration(body.provider, body.config, body.token);
    const i = await prisma.integration.create({ data: { organisationId: req.user.organisationId, provider: body.provider, config: str(body.config), encryptedCredentialsReference: encrypt(body.token), connectionStatus: status } });
    await audit(req.user.organisationId, req.user.id, "integration.connected", body.provider, { status });
    return { id: i.id, provider: i.provider, connectionStatus: i.connectionStatus, config: body.config, createdAt: i.createdAt };
  });

  app.delete("/integrations/:id", async (req, reply) => {
    requireAdmin(req);
    const res = await prisma.integration.deleteMany({ where: { id: (req.params as { id: string }).id, organisationId: req.user.organisationId } });
    if (!res.count) throw notFound("Integration");
    await audit(req.user.organisationId, req.user.id, "integration.removed", (req.params as { id: string }).id);
    reply.code(204).send();
  });

  const EVENTS = z.enum(["run.started", "run.completed", "test.failed", "defect.created", "report.generated"]);
  app.get("/webhooks", async (req) => {
    const hooks = await prisma.webhook.findMany({ where: { organisationId: req.user.organisationId }, orderBy: { createdAt: "asc" } });
    return hooks.map((h) => ({ id: h.id, url: h.url, events: parse(h.events, []), active: h.active, createdAt: h.createdAt }));
  });

  app.post("/webhooks", async (req) => {
    requireAdmin(req);
    const body = z.object({ url: z.string().pipe(z.url({ protocol: /^https?$/ })), events: z.array(EVENTS).min(1) }).parse(req.body);
    await assertSafeTarget(body.url);
    const secret = `whsec_${randomToken(24)}`;
    const h = await prisma.webhook.create({ data: { organisationId: req.user.organisationId, url: body.url, events: str(body.events), encryptedSecret: encrypt(secret) } });
    await audit(req.user.organisationId, req.user.id, "webhook.created", body.url, { events: body.events });
    return { id: h.id, url: h.url, events: body.events, secret, active: true, createdAt: h.createdAt };
  });

  app.delete("/webhooks/:id", async (req, reply) => {
    requireAdmin(req);
    const res = await prisma.webhook.deleteMany({ where: { id: (req.params as { id: string }).id, organisationId: req.user.organisationId } });
    if (!res.count) throw notFound("Webhook");
    reply.code(204).send();
  });

  app.get("/webhooks/:id/deliveries", async (req) => {
    const h = await prisma.webhook.findFirst({ where: { id: (req.params as { id: string }).id, organisationId: req.user.organisationId } });
    if (!h) throw notFound("Webhook");
    return prisma.webhookDelivery.findMany({ where: { webhookId: h.id }, orderBy: { createdAt: "desc" }, take: 50 });
  });

  // ---------------- Search, notifications, AI status ----------------
  app.get("/search", async (req) => {
    const q = ((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { projects: [], testCases: [], defects: [], runs: [] };
    const org = { organisationId: req.user.organisationId };
    const [projects, testCases, defects, runs] = await Promise.all([
      prisma.project.findMany({ where: { ...org, name: { contains: q } }, select: { id: true, name: true }, take: 5 }),
      prisma.testCase.findMany({ where: { project: org, OR: [{ title: { contains: q } }, { key: { contains: q } }] }, select: { id: true, key: true, title: true, projectId: true }, take: 8 }),
      prisma.defect.findMany({ where: { project: org, OR: [{ title: { contains: q } }, { key: { contains: q } }] }, select: { id: true, key: true, title: true }, take: 8 }),
      prisma.testRun.findMany({ where: { project: org, OR: [{ name: { contains: q } }, { key: { contains: q } }] }, select: { id: true, key: true, name: true }, take: 5 }),
    ]);
    return { projects, testCases, defects, runs };
  });

  app.get("/notifications", async (req) =>
    prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, title: true, body: true, link: true, read: true, createdAt: true } }));

  app.post("/notifications/read-all", async (req) => {
    await prisma.notification.updateMany({ where: { userId: req.user.id, read: false }, data: { read: true } });
    return { ok: true };
  });

  app.get("/ai/status", async () => aiStatus());
}

async function verifyIntegration(provider: string, cfg: { baseUrl?: string; email?: string }, token: string): Promise<string> {
  const target: { url: string; headers: Record<string, string> } | null =
    provider === "GITHUB" ? { url: "https://api.github.com/user", headers: { authorization: `Bearer ${token}`, "user-agent": "application-test-ai" } }
    : provider === "GITLAB" ? { url: `${(cfg.baseUrl ?? "https://gitlab.com").replace(/\/$/, "")}/api/v4/user`, headers: { "private-token": token } }
    : cfg.baseUrl ? { url: `${cfg.baseUrl.replace(/\/$/, "")}/rest/api/3/myself`, headers: { authorization: `Basic ${Buffer.from(`${cfg.email ?? ""}:${token}`).toString("base64")}` } }
    : null;
  if (!target) return "PENDING_CONFIGURATION";
  // Self-hosted base URLs are user input: block internal targets and don't follow redirects with the token attached.
  try {
    await assertSafeTarget(target.url);
  } catch {
    return "BLOCKED_TARGET";
  }
  try {
    const res = await fetch(target.url, { headers: target.headers, redirect: "manual", signal: AbortSignal.timeout(8000) });
    return res.ok ? "CONNECTED" : "AUTH_FAILED";
  } catch {
    return "UNREACHABLE";
  }
}

