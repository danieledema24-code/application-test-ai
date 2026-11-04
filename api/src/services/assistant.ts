import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";
import type { AuthUser } from "../auth.js";
import { getProjectForUser } from "../auth.js";
import { HttpError } from "../lib/errors.js";
import { parse } from "../lib/json.js";
import { aiStatus, aiToolTurn, type ToolDef } from "./ai.js";
import { audit, emitWebhook, recordActivity } from "./activity.js";
import { nextKey } from "../lib/keys.js";
import { defectDraftFromResult } from "../routes/workspace.js";
import { compareRuns, createReportFor, generateCasesForProject, startRun } from "./actions.js";
import { analyseFailure } from "./analysis.js";

// FR-057–062: the assistant acts by calling platform functions (never by describing them),
// every call is shown to the user, writes that need approval wait for explicit confirmation,
// and every AI-initiated action is recorded in the activity/audit trail.

export type AssistantAction = { id: string; tool: string; label: string; status: "DONE" | "FAILED" | "NEEDS_CONFIRMATION"; projectName?: string; detail: string; link?: string };
type Ctx = { user: AuthUser; projectId?: string; actions: AssistantAction[] };
type ToolResult = { output: unknown; action?: Omit<AssistantAction, "id" | "tool"> };

const pending = new Map<string, { userId: string; tool: string; input: Record<string, unknown>; expires: number }>();

const tools: ToolDef[] = [
  { name: "list_projects", description: "List the workspace's projects with ids, environments and basic stats.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "list_test_cases", description: "Search a project's test cases. Use before running tests to pick the right case ids.",
    input_schema: { type: "object", properties: { projectId: { type: "string" }, search: { type: "string", description: "Matches title/key/description, e.g. 'login'" }, category: { type: "string" }, status: { type: "string", enum: ["DRAFT", "APPROVED", "READY", "DEPRECATED"] } }, required: ["projectId"], additionalProperties: false },
  },
  {
    name: "generate_test_cases", description: "Generate DRAFT test cases with AI from discovery results or text. Drafts require human review before execution.",
    input_schema: { type: "object", properties: { projectId: { type: "string" }, source: { type: "string", enum: ["DISCOVERY", "USER_STORY", "REQUIREMENTS", "DESCRIPTION"] }, text: { type: "string" }, count: { type: "integer" } }, required: ["projectId", "source"], additionalProperties: false },
  },
  {
    name: "run_tests", description: "Create and start a real test run. Only APPROVED/READY cases can run. Runs against PRODUCTION require user confirmation (handled by the platform).",
    input_schema: { type: "object", properties: { projectId: { type: "string" }, executionType: { type: "string", enum: ["AUTOMATED", "API", "MANUAL"] }, testCaseIds: { type: "array", items: { type: "string" } }, environmentName: { type: "string", enum: ["DEVELOPMENT", "STAGING", "PRODUCTION"] }, name: { type: "string" } }, required: ["projectId", "executionType", "testCaseIds"], additionalProperties: false },
  },
  { name: "get_latest_failures", description: "Recorded failed/errored results from recent runs (optionally one project).", input_schema: { type: "object", properties: { projectId: { type: "string" }, limit: { type: "integer" } }, additionalProperties: false } },
  { name: "get_run", description: "Status, summary and per-test results of a run (by id or key like RUN-0004).", input_schema: { type: "object", properties: { run: { type: "string" } }, required: ["run"], additionalProperties: false } },
  { name: "analyse_failure", description: "Run failure investigation on a failed result. Output is a hypothesis.", input_schema: { type: "object", properties: { resultId: { type: "string" } }, required: ["resultId"], additionalProperties: false } },
  { name: "create_defect", description: "Propose a defect for a failed result. The user must confirm before it is created.", input_schema: { type: "object", properties: { resultId: { type: "string" }, title: { type: "string" }, severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] } }, required: ["resultId"], additionalProperties: false } },
  { name: "generate_report", description: "Generate a PDF or CSV QA report for a project or a single run.", input_schema: { type: "object", properties: { projectId: { type: "string" }, runId: { type: "string" }, format: { type: "string", enum: ["PDF", "CSV"] } }, required: ["projectId", "format"], additionalProperties: false } },
  { name: "coverage_gaps", description: "Facts about a project's test coverage: counts by category/status, never-executed cases, discovered pages and forms with no matching test.", input_schema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
  { name: "compare_runs", description: "Compare two runs (ids/keys), or omit both to compare the latest two runs of a project.", input_schema: { type: "object", properties: { projectId: { type: "string" }, a: { type: "string" }, b: { type: "string" } }, additionalProperties: false } },
];

const SYSTEM = `You are the in-app QA assistant. You act by calling tools — never claim to have done something you did not do with a tool.
Rules:
- Resolve projects and test cases with list_projects / list_test_cases before acting; don't guess ids.
- Only APPROVED or READY cases can be executed. If the user's cases are drafts, say so and offer to help review.
- Recorded results from tools are facts. Your own explanations are hypotheses: label them clearly ("Hypothesis:").
- If a tool reports that confirmation is required, tell the user what will happen and that they must press Confirm.
- Never ask for, reveal or invent passwords, tokens or keys.
- Be brief. Use short bullet points and include run/case/defect keys.`;

async function resolveRun(user: AuthUser, ref: string) {
  const run = await prisma.testRun.findFirst({ where: { project: { organisationId: user.organisationId }, OR: [{ id: ref }, { key: ref.toUpperCase() }] }, include: { results: true, project: true, environment: true } });
  if (!run) throw new HttpError(404, `Run ${ref} not found`);
  return run;
}

async function execTool(name: string, input: Record<string, unknown>, ctx: Ctx, confirmed = false): Promise<ToolResult> {
  const u = ctx.user;
  const pid = (input.projectId as string | undefined) ?? ctx.projectId;
  switch (name) {
    case "list_projects": {
      const ps = await prisma.project.findMany({ where: { organisationId: u.organisationId }, include: { environments: true, _count: { select: { testCases: true } } } });
      return { output: ps.map((p) => ({ id: p.id, name: p.name, type: p.applicationType, url: p.applicationUrl, testCases: p._count.testCases, environments: p.environments.map((e) => ({ name: e.name, authorised: e.authorised })) })) };
    }
    case "list_test_cases": {
      await getProjectForUser(u, pid!);
      const s = input.search as string | undefined;
      const cs = await prisma.testCase.findMany({
        where: { projectId: pid, ...(input.status ? { status: input.status as string } : {}), ...(input.category ? { category: input.category as string } : {}), ...(s ? { OR: [{ title: { contains: s } }, { key: { contains: s } }, { description: { contains: s } }, { category: { contains: s.toUpperCase() } }] } : {}) },
        take: 60,
      });
      return { output: cs.map((c) => ({ id: c.id, key: c.key, title: c.title, category: c.category, status: c.status, hasApiRequest: Boolean(c.apiEndpointId || c.apiSpec) })) };
    }
    case "generate_test_cases": {
      const { created, generatedBy, notes } = await generateCasesForProject(u, pid!, { source: input.source as never, text: input.text as string, count: input.count as number }, true);
      const project = await getProjectForUser(u, pid!);
      return { output: { created: created.map((c) => ({ key: c.key, title: c.title, category: c.category })), generatedBy, notes, status: "DRAFT — needs human review" },
        action: { label: "Generated test cases", status: "DONE", projectName: project.name, detail: `${created.length} draft case(s) created (${generatedBy})`, link: `/projects/${pid}?tab=cases` } };
    }
    case "run_tests": {
      const project = await getProjectForUser(u, pid!);
      const env = input.environmentName ? await prisma.environment.findFirst({ where: { projectId: pid, name: input.environmentName as string } }) : null;
      const target = env ?? (await prisma.environment.findFirst({ where: { projectId: pid }, orderBy: { createdAt: "asc" } }));
      const ids = input.testCaseIds as string[];
      if (target?.name === "PRODUCTION" && !confirmed)
        return needsConfirmation(ctx, name, input, `Run ${ids.length} test(s) against PRODUCTION (${target.baseUrl})`, project.name);
      const { run } = await startRun(u, pid!, { executionType: input.executionType as string, environmentId: target?.id, testCaseIds: ids, name: input.name as string }, true);
      return { output: { runId: run.id, runKey: run.key, status: run.status, note: "Run started; results will be recorded by the execution engine." },
        action: { label: `Started ${run.key}`, status: "DONE", projectName: project.name, detail: `${(input.executionType as string).toLowerCase()} run of ${ids.length} case(s) on ${target?.name.toLowerCase()}`, link: `/test-runs/${run.id}` } };
    }
    case "get_latest_failures": {
      if (pid) await getProjectForUser(u, pid);
      const rs = await prisma.testResult.findMany({
        where: { status: { in: ["FAILED", "ERROR"] }, testRun: { project: { organisationId: u.organisationId }, ...(pid ? { projectId: pid } : {}) } },
        include: { testRun: { include: { project: true } } }, orderBy: { createdAt: "desc" }, take: Math.min((input.limit as number) ?? 10, 30),
      });
      return { output: rs.map((r) => ({ resultId: r.id, run: r.testRun.key, runId: r.testRunId, project: r.testRun.project.name, testCase: `${r.testCaseKey} ${r.testCaseTitle}`, status: r.status, error: r.errorMessage.slice(0, 300), analysis: parse<{ classification?: string; summary?: string } | null>(r.failureAnalysis, null) })) };
    }
    case "get_run": {
      const run = await resolveRun(u, input.run as string);
      return { output: { id: run.id, key: run.key, project: run.project.name, status: run.status, type: run.executionType, environment: run.environment?.name, results: run.results.map((r) => ({ resultId: r.id, testCase: `${r.testCaseKey} ${r.testCaseTitle}`, status: r.status, error: r.errorMessage.slice(0, 200) })) } };
    }
    case "analyse_failure": {
      const r = await prisma.testResult.findFirst({ where: { id: input.resultId as string, testRun: { project: { organisationId: u.organisationId } } }, include: { testCase: true, testRun: { include: { project: true } } } });
      if (!r) throw new HttpError(404, "Result not found");
      const a = await analyseFailure({ testCase: { key: r.testCaseKey, title: r.testCaseTitle, steps: parse(r.testCase?.steps, []), expectedResult: r.testCase?.expectedResult ?? "" }, executionType: r.testRun.executionType, status: r.status, errorMessage: r.errorMessage, apiExchange: parse(r.apiExchange, null) });
      await prisma.testResult.update({ where: { id: r.id }, data: { failureAnalysis: JSON.stringify(a) } });
      return { output: a, action: { label: `Investigated ${r.testCaseKey}`, status: "DONE", projectName: r.testRun.project.name, detail: `Hypothesis: ${a.classification.toLowerCase()} (${a.confidence.toLowerCase()} confidence)`, link: `/test-runs/${r.testRunId}` } };
    }
    case "create_defect": {
      const draft = await defectDraftFromResult(u, input.resultId as string);
      const project = await getProjectForUser(u, draft.projectId);
      if (!confirmed) return needsConfirmation(ctx, name, input, `Create defect "${(input.title as string) ?? draft.title}" (${(input.severity as string) ?? draft.severity})`, project.name);
      const [key] = await nextKey(u.organisationId, "defect");
      const d = await prisma.defect.create({
        data: { key, projectId: draft.projectId, testResultId: draft.testResultId, title: (input.title as string) ?? draft.title, description: draft.description, severity: (input.severity as string) ?? draft.severity, priority: draft.priority,
          environmentName: draft.environmentName, reproductionSteps: JSON.stringify(draft.reproductionSteps), expectedResult: draft.expectedResult, actualResult: draft.actualResult, aiAnalysis: draft.aiAnalysis ? JSON.stringify(draft.aiAnalysis) : null, createdById: u.id },
      });
      await recordActivity({ organisationId: u.organisationId, projectId: d.projectId, userId: u.id, viaAI: true, actionType: "DEFECT_CREATED", message: `${d.key} ${d.title}`, link: `/defects/${d.id}` });
      emitWebhook(u.organisationId, "defect.created", { defectId: d.id, key: d.key, title: d.title, severity: d.severity });
      return { output: { defectKey: d.key, defectId: d.id }, action: { label: `Created ${d.key}`, status: "DONE", projectName: project.name, detail: d.title, link: `/defects/${d.id}` } };
    }
    case "generate_report": {
      const project = await getProjectForUser(u, pid!);
      const runId = input.runId ? (await resolveRun(u, input.runId as string)).id : null;
      const r = await createReportFor(u, { projectId: pid!, testRunId: runId, format: (input.format as "PDF" | "CSV") ?? "PDF" }, true);
      return { output: { reportId: r.id, title: r.title }, action: { label: "Generated report", status: "DONE", projectName: project.name, detail: `${r.format}: ${r.title}`, link: `/reports` } };
    }
    case "coverage_gaps": {
      const project = await getProjectForUser(u, pid!);
      const cases = await prisma.testCase.findMany({ where: { projectId: pid } });
      const executed = new Set((await prisma.testResult.findMany({ where: { testCaseId: { in: cases.map((c) => c.id) }, status: { not: "NOT_EXECUTED" } }, select: { testCaseId: true } })).map((r) => r.testCaseId));
      const tally = (k: "category" | "status") => cases.reduce<Record<string, number>>((a, c) => ((a[c[k]] = (a[c[k]] ?? 0) + 1), a), {});
      const d = await prisma.discovery.findFirst({ where: { projectId: pid, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
      const pages = parse<{ pages?: { url: string; title: string; forms: unknown[] }[] }>(d?.result, {}).pages ?? [];
      const text = cases.map((c) => `${c.title} ${c.steps}`).join(" ").toLowerCase();
      const untested = pages.filter((p) => { const path = new URL(p.url).pathname.toLowerCase(); return path !== "/" && !text.includes(path) && !text.includes((p.title ?? "").toLowerCase()); });
      return { output: { project: project.name, totalCases: cases.length, byCategory: tally("category"), byStatus: tally("status"), neverExecuted: cases.filter((c) => !executed.has(c.id)).map((c) => c.key),
        discoveredPagesWithoutTests: untested.map((p) => ({ url: p.url, title: p.title, forms: p.forms.length })), discoveryAvailable: Boolean(d) } };
    }
    case "compare_runs": {
      let a = input.a as string | undefined, b = input.b as string | undefined;
      if (!a || !b) {
        const runs = await prisma.testRun.findMany({ where: { project: { organisationId: u.organisationId }, ...(pid ? { projectId: pid } : {}), executionType: { not: "DISCOVERY" }, status: { notIn: ["QUEUED", "RUNNING", "IN_PROGRESS"] } }, orderBy: { createdAt: "desc" }, take: 2 });
        if (runs.length < 2) return { output: { error: "Fewer than two completed runs to compare" } };
        [b, a] = [runs[0].id, runs[1].id];
      }
      const cmp = await compareRuns(u, (await resolveRun(u, a)).id, (await resolveRun(u, b)).id);
      return { output: { from: cmp.a.key, to: cmp.b.key, fromStatus: cmp.a.status, toStatus: cmp.b.status, changes: cmp.changes } };
    }
    default:
      throw new HttpError(400, `Unknown tool ${name}`);
  }
}

function needsConfirmation(ctx: Ctx, tool: string, input: Record<string, unknown>, detail: string, projectName: string): ToolResult {
  const id = crypto.randomUUID();
  pending.set(id, { userId: ctx.user.id, tool, input: { ...input, projectId: input.projectId ?? ctx.projectId }, expires: Date.now() + 15 * 60_000 });
  ctx.actions.push({ id, tool, label: "Confirmation required", status: "NEEDS_CONFIRMATION", projectName, detail });
  return { output: { status: "AWAITING_USER_CONFIRMATION", detail, note: "Nothing has been executed. Ask the user to press Confirm." } };
}

async function runTool(name: string, input: Record<string, unknown>, ctx: Ctx, confirmed = false) {
  try {
    const r = await execTool(name, input, ctx, confirmed);
    if (r.action) {
      const id = crypto.randomUUID();
      ctx.actions.push({ id, tool: name, ...r.action });
      await audit(ctx.user.organisationId, ctx.user.id, `assistant.${name}`, r.action.detail, { input });
    }
    return { content: JSON.stringify(r.output).slice(0, 30_000), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!["list_projects", "list_test_cases", "get_run", "get_latest_failures", "coverage_gaps", "compare_runs"].includes(name))
      ctx.actions.push({ id: crypto.randomUUID(), tool: name, label: `Could not ${name.replace(/_/g, " ")}`, status: "FAILED", detail: message });
    return { content: JSON.stringify({ error: message }), isError: true };
  }
}

export async function chat(user: AuthUser, messages: { role: "user" | "assistant"; content: string }[], projectId?: string, confirmations: string[] = []) {
  if (projectId) await getProjectForUser(user, projectId);
  const ctx: Ctx = { user, projectId, actions: [] };
  const confirmedNotes: string[] = [];
  for (const id of confirmations) {
    const p = pending.get(id);
    if (!p || p.userId !== user.id || p.expires < Date.now()) {
      ctx.actions.push({ id, tool: "confirmation", label: "Confirmation expired", status: "FAILED", detail: "That pending action is no longer available. Ask again." });
      continue;
    }
    pending.delete(id);
    const r = await runTool(p.tool, p.input, ctx, true);
    confirmedNotes.push(`User confirmed ${p.tool}; result: ${r.content}`);
  }

  if (!aiStatus().enabled) return { reply: await ruleBased(messages.at(-1)?.content ?? "", ctx, confirmedNotes), actions: ctx.actions, aiEnabled: false };

  const history: Anthropic.Beta.BetaMessageParam[] = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  const context = `Current page project id: ${projectId ?? "none"}.${confirmedNotes.length ? `\n${confirmedNotes.join("\n")}` : ""}`;
  const last = history.at(-1);
  if (last?.role === "user") last.content = `${last.content}\n\n<context>${context}</context>`;
  let reply = "";
  for (let i = 0; i < 8; i++) {
    const res = await aiToolTurn(SYSTEM, history, tools);
    if (res.stop_reason === "refusal") return { reply: "I can't help with that request.", actions: ctx.actions, aiEnabled: true };
    history.push({ role: "assistant", content: res.content });
    reply = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim() || reply;
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) break;
    const results = await Promise.all(uses.map(async (t) => {
      const r = await runTool(t.name, (t.input ?? {}) as Record<string, unknown>, ctx);
      return { type: "tool_result" as const, tool_use_id: t.id, content: r.content, is_error: r.isError };
    }));
    history.push({ role: "user", content: results });
  }
  return { reply: reply || "Done.", actions: ctx.actions, aiEnabled: true };
}

/** Limited command mode when no AI provider is configured. Still executes real platform functions. */
async function ruleBased(text: string, ctx: Ctx, confirmedNotes: string[]) {
  const t = text.toLowerCase();
  const prefix = confirmedNotes.length ? "Confirmed action executed. " : "";
  const projectId = ctx.projectId ?? (await prisma.project.findFirst({ where: { organisationId: ctx.user.organisationId }, orderBy: { updatedAt: "desc" } }))?.id;
  if (confirmedNotes.length && !t) return prefix;
  const call = async (name: string, input: Record<string, unknown>) => JSON.parse((await runTool(name, input, ctx)).content);
  if (!projectId) return `${prefix}Create a project first, then I can help with tests, runs and reports.`;
  if (/fail/.test(t) && /(show|latest|recent|list)/.test(t)) {
    const out = await call("get_latest_failures", { projectId: ctx.projectId });
    if (!out.length) return `${prefix}No failed tests recorded.`;
    return `${prefix}Latest recorded failures:\n${out.map((r: { run: string; testCase: string; status: string }) => `• ${r.run} — ${r.testCase} (${r.status})`).join("\n")}`;
  }
  if (/report/.test(t)) {
    await call("generate_report", { projectId, format: /csv/.test(t) ? "CSV" : "PDF" });
    return `${prefix}Report generated from the stored execution records.`;
  }
  if (/compare/.test(t)) {
    const out = await call("compare_runs", { projectId });
    if (out.error) return `${prefix}${out.error}.`;
    return `${prefix}${out.from} → ${out.to}: ${out.changes.length ? out.changes.map((c: { testCaseKey: string; from: string; to: string }) => `${c.testCaseKey} ${c.from ?? "—"} → ${c.to ?? "—"}`).join(", ") : "no status changes"}.`;
  }
  if (/coverage|gap/.test(t)) {
    const out = await call("coverage_gaps", { projectId });
    return `${prefix}${out.totalCases} case(s). Never executed: ${out.neverExecuted.length}. Discovered pages without an obvious test: ${out.discoveredPagesWithoutTests.map((p: { url: string }) => p.url).slice(0, 8).join(", ") || "none"}.`;
  }
  if (/generate|create/.test(t) && /test/.test(t)) {
    const out = await call("generate_test_cases", { projectId, source: "DISCOVERY" });
    return out.error ? `${prefix}${out.error}` : `${prefix}Generated ${out.created.length} draft test case(s). Review and approve them before running.`;
  }
  if (/\b(run|execute|test)\b/.test(t)) {
    const term = t.match(/(?:run|execute|test)\s+(?:the\s+)?([\w\s-]+?)\s*(?:regression\s*)?(?:tests?|suite|api)?$/)?.[1]?.replace(/\b(all|my|regression)\b/g, "").trim();
    const isApi = /\bapi\b/.test(t);
    const list = await call("list_test_cases", { projectId, ...(term ? { search: term } : {}) });
    const runnable = list.filter((c: { status: string; hasApiRequest: boolean }) => ["APPROVED", "READY"].includes(c.status) && (!isApi || c.hasApiRequest));
    if (!runnable.length) return `${prefix}No approved or ready test cases match${term ? ` "${term}"` : ""}. Approve cases first.`;
    const out = await call("run_tests", { projectId, executionType: isApi ? "API" : "AUTOMATED", testCaseIds: runnable.map((c: { id: string }) => c.id) });
    if (out.status === "AWAITING_USER_CONFIRMATION") return `${prefix}This would run against production. Press Confirm to proceed.`;
    return out.error ? `${prefix}${out.error}` : `${prefix}Started ${out.runKey} with ${runnable.length} case(s).`;
  }
  return `${prefix}AI is not configured, so I'm in limited command mode. Try: "run the login tests", "test the registration API", "show me the latest failed tests", "generate test cases", "identify coverage gaps", "compare the last two test runs" or "generate a QA report".`;
}
