import PDFDocument from "pdfkit";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { parse } from "../lib/json.js";
import { getObject, putObject } from "../lib/storage.js";
import { aiJSON } from "./ai.js";
import type { FailureAnalysis } from "./analysis.js";

// FR-056: every number in a report is computed from stored execution records. The optional
// AI section is narrative only and is printed separately, labelled as AI-generated.

async function gather(projectId: string, testRunId?: string | null) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { environments: true } });
  const runs = await prisma.testRun.findMany({
    where: testRunId ? { id: testRunId, projectId } : { projectId, executionType: { not: "DISCOVERY" } },
    include: { environment: true, results: { include: { evidence: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  // Project reports use the latest result per test case; run reports use that run's results.
  const latest = new Map<string, (typeof runs)[number]["results"][number] & { runKey: string; env: string }>();
  for (const r of runs) for (const res of r.results) latest.set(testRunId ? res.id : res.testCaseId ?? res.id, { ...res, runKey: r.key, env: r.environment?.name ?? "-" });
  const results = [...latest.values()];
  const totalCases = await prisma.testCase.count({ where: { projectId } });
  const defects = await prisma.defect.findMany({ where: testRunId ? { projectId, testResult: { testRunId } } : { projectId }, orderBy: { createdAt: "desc" } });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count("PASSED"), failed = count("FAILED"), errored = count("ERROR"), blocked = count("BLOCKED"), notExecuted = count("NOT_EXECUTED");
  const decided = passed + failed + errored;
  const summary = { totalCases, executed: results.length, passed, failed: failed + errored, blocked, notExecuted, passRate: decided ? Math.round((passed / decided) * 1000) / 10 : null };
  const openDefects = defects.filter((d) => !["CLOSED", "FIXED"].includes(d.status));
  const risks: string[] = [];
  const crit = openDefects.filter((d) => d.severity === "CRITICAL" || d.severity === "HIGH");
  if (crit.length) risks.push(`${crit.length} open critical/high severity defect(s): ${crit.slice(0, 5).map((d) => d.key).join(", ")}`);
  if (summary.failed) risks.push(`${summary.failed} test(s) failing or erroring in the latest execution`);
  if (blocked + notExecuted) risks.push(`${blocked + notExecuted} test(s) blocked or not executed — their behaviour is unverified`);
  if (!testRunId && totalCases > results.length) risks.push(`${totalCases - results.length} test case(s) have never been executed`);
  if (summary.passRate !== null && summary.passRate < 80) risks.push(`Pass rate of ${summary.passRate}% is below the 80% threshold`);
  const flaky = results.filter((r) => parse<FailureAnalysis | null>(r.failureAnalysis, null)?.classification === "FLAKY");
  if (flaky.length) risks.push(`${flaky.length} test(s) flagged as potentially flaky (hypothesis)`);
  return { project, runs, results, defects, openDefects, summary, risks };
}

const ObsSchema = z.object({ observations: z.array(z.string()).describe("3-6 short observations") });

async function observations(data: Awaited<ReturnType<typeof gather>>) {
  const failures = data.results.filter((r) => ["FAILED", "ERROR"].includes(r.status)).slice(0, 25).map((r) => ({
    key: r.testCaseKey, title: r.testCaseTitle, error: r.errorMessage.slice(0, 300), analysis: parse<FailureAnalysis | null>(r.failureAnalysis, null)?.classification,
  }));
  const ai = await aiJSON({
    schema: ObsSchema, effort: "low",
    task: "Write short QA observations for a test report from these recorded results. Do not restate or alter the numbers; point out patterns, likely root-cause clusters and recommended focus areas. Mark anything uncertain as such.",
    input: { summary: data.summary, failures, openDefects: data.openDefects.map((d) => ({ key: d.key, title: d.title, severity: d.severity })) },
  });
  if (ai) return { source: "AI-generated (Claude) — hypotheses, not verified results", items: ai.observations };
  const byClass = new Map<string, number>();
  for (const r of data.results) {
    const c = parse<FailureAnalysis | null>(r.failureAnalysis, null)?.classification;
    if (c) byClass.set(c, (byClass.get(c) ?? 0) + 1);
  }
  const items = [...byClass.entries()].map(([k, v]) => `${v} failure(s) classified as ${k.toLowerCase()} issues (hypothesis).`);
  if (!items.length) items.push(data.summary.failed ? "Failures have not yet been analysed." : "No failures recorded in this scope.");
  return { source: "Rule-based observations (AI not configured)", items };
}

export async function generateReport(opts: { projectId: string; testRunId?: string | null; format: "PDF" | "CSV"; userId: string; orgId: string }) {
  const data = await gather(opts.projectId, opts.testRunId);
  const scope = opts.testRunId ? data.runs[0]?.key ?? "run" : "project";
  const title = `${data.project.name} — ${opts.testRunId ? `Run ${scope}` : "Project"} QA report`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = opts.format === "CSV" ? csv(data) : await pdf(data, title, await observations(data));
  const key = await putObject(`${opts.orgId}/${opts.projectId}/reports/${stamp}.${opts.format.toLowerCase()}`, file);
  return prisma.report.create({
    data: { projectId: opts.projectId, testRunId: opts.testRunId ?? null, reportType: opts.testRunId ? "RUN" : "PROJECT", format: opts.format, title, fileReference: key, createdById: opts.userId },
  });
}

const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csv(d: Awaited<ReturnType<typeof gather>>) {
  const rows = [["Run", "Environment", "Test case", "Title", "Status", "Duration (ms)", "Executed at", "Error", "AI classification (hypothesis)"]];
  for (const r of d.results)
    rows.push([r.runKey, r.env, r.testCaseKey, r.testCaseTitle, r.status, String(r.durationMs ?? ""), r.executedAt?.toISOString() ?? "", r.errorMessage.slice(0, 500), parse<FailureAnalysis | null>(r.failureAnalysis, null)?.classification ?? ""]);
  rows.push([], ["Summary"], ["Total test cases", String(d.summary.totalCases)], ["Executed", String(d.summary.executed)], ["Passed", String(d.summary.passed)],
    ["Failed", String(d.summary.failed)], ["Blocked", String(d.summary.blocked)], ["Not executed", String(d.summary.notExecuted)], ["Pass %", String(d.summary.passRate ?? "n/a")]);
  rows.push([], ["Defect", "Title", "Severity", "Status", "Environment"], ...d.defects.map((x) => [x.key, x.title, x.severity, x.status, x.environmentName]));
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

const NAVY = "#0B1B3A", GREY = "#5B6475", GREEN = "#15803D", RED = "#B91C1C", AMBER = "#B45309";

async function pdf(d: Awaited<ReturnType<typeof gather>>, title: string, obs: { source: string; items: string[] }) {
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: title } });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const h = (t: string) => doc.moveDown(0.8).fillColor(NAVY).font("Helvetica-Bold").fontSize(13).text(t).moveDown(0.3).font("Helvetica").fontSize(10).fillColor("black");
  const kv = (k: string, v: string) => doc.font("Helvetica-Bold").text(`${k}: `, { continued: true }).font("Helvetica").text(v);

  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor("white").font("Helvetica-Bold").fontSize(18).text(title, 50, 30, { width: 500 });
  doc.font("Helvetica").fontSize(9).text(`Application Test AI · generated ${new Date().toUTCString()}`, 50, 62);
  doc.fillColor("black").fontSize(10).text("", 50, 110);

  h("1. Project information");
  kv("Project", d.project.name);
  kv("Application", `${d.project.applicationUrl} (${d.project.applicationType})`);
  if (d.project.description) kv("Description", d.project.description);

  h("2. Execution summary");
  const s = d.summary;
  const boxes: [string, string, string][] = [["Test cases", String(s.totalCases), NAVY], ["Executed", String(s.executed), NAVY], ["Passed", String(s.passed), GREEN], ["Failed", String(s.failed), RED], ["Blocked", String(s.blocked + s.notExecuted), AMBER], ["Pass %", s.passRate === null ? "n/a" : `${s.passRate}%`, NAVY]];
  const y = doc.y;
  boxes.forEach(([label, value, color], i) => {
    const x = 50 + i * 83;
    doc.roundedRect(x, y, 76, 48, 4).strokeColor("#D8DEE8").stroke();
    doc.fillColor(color).font("Helvetica-Bold").fontSize(16).text(value, x, y + 8, { width: 76, align: "center" });
    doc.fillColor(GREY).font("Helvetica").fontSize(8).text(label, x, y + 30, { width: 76, align: "center" });
  });
  doc.fillColor("black").fontSize(10).text("", 50, y + 60);
  doc.fillColor(GREY).fontSize(8).text("Blocked includes not-executed tests. Pass % = passed / (passed + failed + errored). All figures are computed from stored execution records.").fillColor("black").fontSize(10);

  h("3. Environment information");
  const envs = new Map(d.runs.filter((r) => r.environment).map((r) => [r.environment!.id, r.environment!]));
  if (!envs.size) doc.text("No executions recorded.");
  for (const e of envs.values()) kv(e.name, `${e.baseUrl}${e.name === "PRODUCTION" ? " (read-only unless destructive testing authorised)" : ""}`);
  kv("Runs included", d.runs.map((r) => `${r.key} (${r.executionType.toLowerCase()}, ${r.status.toLowerCase()})`).join(", ") || "none");

  h("4. Defect summary");
  const sev = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((x) => `${x.toLowerCase()}: ${d.openDefects.filter((o) => o.severity === x).length}`).join(" · ");
  kv("Open defects", `${d.openDefects.length} (${sev})`);
  for (const x of d.defects.slice(0, 20)) doc.text(`• ${x.key} [${x.severity}/${x.status}] ${x.title}`);

  h("5. Failed test details");
  const failures = d.results.filter((r) => ["FAILED", "ERROR", "BLOCKED"].includes(r.status));
  if (!failures.length) doc.text("No failed or blocked tests.");
  for (const f of failures.slice(0, 30)) {
    doc.font("Helvetica-Bold").fillColor(f.status === "BLOCKED" ? AMBER : RED).text(`${f.testCaseKey} · ${f.status} · ${f.testCaseTitle}`).fillColor("black").font("Helvetica");
    doc.fontSize(9).text(`Run ${f.runKey} on ${f.env}${f.durationMs ? ` · ${f.durationMs}ms` : ""}`);
    if (f.errorMessage) doc.text(`Error: ${f.errorMessage.slice(0, 600)}`);
    const a = parse<FailureAnalysis | null>(f.failureAnalysis, null);
    if (a) doc.fillColor(GREY).text(`AI hypothesis (${a.classification}, ${a.confidence} confidence): ${a.summary}`).fillColor("black");
    doc.fontSize(10).moveDown(0.4);
  }

  h("6. Execution evidence");
  const shots = failures.flatMap((f) => f.evidence.filter((e) => e.fileType === "SCREENSHOT").map((e) => ({ e, key: f.testCaseKey }))).slice(0, 4);
  const evCount = d.results.reduce((n, r) => n + r.evidence.length, 0);
  doc.text(`${evCount} evidence file(s) stored (screenshots, videos, console and network logs). Full evidence is available in the platform for each run.`);
  for (const { e, key } of shots) {
    const img = await getObject(e.storageReference).catch(() => null);
    if (!img) continue;
    if (doc.y > 560) doc.addPage();
    doc.moveDown(0.3).fontSize(9).text(`${key} — ${e.name}`).fontSize(10);
    try {
      doc.image(img, { fit: [495, 220] });
    } catch {
      // User-uploaded evidence may not be a format pdfkit can embed (only PNG/JPEG); link instead.
      doc.fillColor(GREY).text("(image could not be embedded — view it in the platform)").fillColor("black");
    }
    doc.moveDown(0.5);
  }

  h("7. Observations");
  doc.fillColor(GREY).fontSize(8).text(obs.source).fillColor("black").fontSize(10);
  for (const o of obs.items) doc.text(`• ${o}`);

  h("8. Outstanding risks");
  if (!d.risks.length) doc.text("No outstanding risks identified from recorded data.");
  for (const r of d.risks) doc.text(`• ${r}`);

  doc.end();
  return done;
}
