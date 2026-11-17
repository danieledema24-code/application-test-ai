// DEVELOPMENT/TEST FIXTURES ONLY. Release Readiness and Test Completion report stand-ins for the QA Analyst API
// (backend app/agents/reporting/phase6_reports.py, app/api/routers/reports.py; P6-05c), layered over
// ./phase6-release-fixtures.ts with page.route(). The content mirrors the demo: REL-0001 No-go (final), REL-0002
// Conditional awaiting Gate 9. Nothing here is imported by the product code.

import type { Page, Route } from "@playwright/test";
import type { ReportSummary } from "../../src/lib/contract";
import { API } from "./fixtures";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string) => json(route, status, { error: { code, message, details: null } });

export const DRAFT_BAND = "DRAFT: Gate 9 not decided for REL-0002.";
export const STATEMENT =
  "This recommendation is based on the tests the platform ran and the evidence recorded up to 15 Nov 2026, 16:00 UTC. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it.";
export const AI_TOKEN = "9999999999.signed";
export const AI_LESSONS = "Run the contact form checks earlier and confirm DEF-0001 is fixed before the next assessment.";

export type ReportsState = {
  /** No assessment yet: every Phase 6 report answers 409. */
  assessed: boolean;
  aiOn: boolean;
  reports: ReportSummary[];
  contents: Record<string, unknown>;
  requests: { method: string; path: string; body: unknown }[];
};

const crit = (id: string, text: string, blocking: boolean, status: string, status_text: string, evidence: string, detail: string, confirmed: string | null = null) => ({
  id,
  text,
  blocking,
  blocking_text: blocking ? "Blocking" : "Not blocking",
  status,
  status_text,
  source_label: id.startsWith("exit") ? "Exit criterion (Test Strategy v2)" : "Platform check",
  evidence,
  detail,
  confirmed,
});

function readiness(key: string, final: boolean) {
  return {
    report_type: "release_readiness",
    source_key: key,
    statement: STATEMENT,
    band: final ? null : `DRAFT: Gate 9 not decided for ${key}.`,
    assessment: { status: final ? "final" : "awaiting_approval", verdict: final ? "no_go" : "conditional", verdict_state: final ? "final" : "recommended", assessed_at: "2026-11-15T16:00:00Z", created_by: { full_name: "M. Member" } },
    verdict_text: final ? "No-go · Final" : "Conditional · Recommended",
    reason: final ? "1 blocking criterion isn't met: there is an open major defect (DEF-0001)." : "Every blocking criterion is met; 2 conditions remain.",
    decision_line: final ? "Decided by A. Approver, 14 Nov 2026, 09:30 UTC" : "Gate 9: waiting for a decision by someone who can approve.",
    override_text: null,
    criteria: [
      crit("exit.no_open_high_defects", "No open critical or high defects", true, final ? "not_met" : "met", final ? "Not met" : "Met", final ? "DEF-0001" : "", final ? "DEF-0001 (major) is open" : "None open"),
      crit("exit.text.1", "Stakeholders signed off the release notes", false, "met", "Met", "", "Confirmed by a person", "Confirmed by M. Member: 'Signed off in the release meeting'"),
      crit("rr.impacted_rerun", "Impacted tests re-run since the change", false, "not_evaluable", "Not evaluable", "CHG-0001", "TC-0031 is manual and hasn't been re-run"),
    ],
    conditions: final ? [] : [{ text: "Re-run TC-0031 (manual) after CHG-0001", blocking: false, evidence: "TC-0031" }, { text: "Confirm: Stakeholders signed off the release notes", blocking: false, evidence: "" }],
    residual: [{ key: "RISK-0001", title: "Contact form loses messages", initial: "High", residual: final ? "High" : "Medium", line: final ? "DEF-0001 is open" : "Tested; DEF-0001 verified" }],
    overall_residual: final ? "High" : "Medium",
    changes: final ? { previous: null, parts: [], text: "This is the first assessment." } : { previous: { key: "REL-0001" }, parts: ["Recommendation: No-go → Conditional", "DEF-0001: fixed → verified", "Change sets: CHG-0001"], text: null },
    narrative: null,
    limitations: ["The platform tested only what it can reach on the approved site.", "No Word (DOCX) export."],
  };
}

const bucket = (group: string, approved: number, passed: number, failed: number, not_run: number) => ({ group, approved, executed: passed + failed, passed, failed, flaky: 0, error: 0, blocked: 0, skipped: 0, not_run });

function completion(key: string | null, lessons: unknown) {
  return {
    report_type: "completion",
    source_key: key ?? "current",
    basis: key ? "assessment" : "current",
    release: key ? { key, verdict_text: "Conditional · Recommended", reason: "Every blocking criterion is met; 2 conditions remain.", decision_line: "Gate 9: waiting for a decision by someone who can approve.", override_text: null, statement: STATEMENT } : { key: null, text: "Current data, not tied to an assessment. The verdict comes from the same rules but no one decided it." },
    summary: "12 approved test cases: 9 passed, 1 failed, 2 not run. 1 defect is open.",
    scope: { requirements: 5, acceptance_criteria: 14, test_cases: 12, test_types: ["functional", "accessibility"] },
    not_tested: [{ item: "Payments", reason: "Out of scope in the Test Strategy" }],
    deviations: [{ case_key: "TC-0031", title: "Check the confirmation email", deviation: "Approved but never executed", reason: "manual" }],
    deviations_line: "Approved but never executed: TC-0031 (manual)",
    measures: {
      groups: [bucket("All", 12, 9, 1, 2), bucket("functional · system", 10, 8, 1, 1), bucket("accessibility · system", 2, 1, 0, 1)],
      coverage: { requirements: { approved: 5, with_approved_case: 5, percent_approved_covered: 100 }, acceptance_criteria: { approved: 14, covered: 13, percent: 92.9 }, execution: { requirements: { approved: 5, with_result: 4 } } },
      defects: { total: 2, by_severity: { major: 1, minor: 1 }, by_status: { confirmed: 1, verified: 1 }, by_source: { run: 2 } },
    },
    runs: [{ key: "RUN-0005", status: "failed", selection: "Regression", change_set: "CHG-0001", totals: { passed: 9, failed: 1, error: 0, blocked: 0, skipped: 0 } }],
    change_sets: [{ key: "CHG-0001", total: 3, regression_runs: ["RUN-0005"] }],
    exploratory: { sessions: [], empty: "No exploratory session has run." },
    non_functional: [{ type: "Accessibility", source: "A11Y-0001", text: "2 serious issues open" }],
    criteria: readiness("REL-0002", false).criteria,
    conditions: readiness("REL-0002", false).conditions,
    residual: readiness("REL-0002", false).residual,
    overall_residual: "Medium",
    assets: { scripts: [{ path: "tests/contact.spec.ts", version: 2, state: "approved" }], profiles: [] },
    limitations: ["Exploratory testing isn't available yet.", "No Word (DOCX) export."],
    lessons,
  };
}

const row = (id: string, report_type: string, version: number, run_key: string | null, draft: boolean, is_latest_source = true): ReportSummary => ({
  id,
  report_type,
  version,
  status: "ready",
  formats: ["pdf", "html", "csv", "xlsx"],
  generated_by: "rules",
  created_at: `2026-11-15T16:0${version}:00Z`,
  approval: { gate: report_type === "release_readiness" ? "G9" : null, status: draft ? "draft" : "approved", approved_by: null, approved_at: null },
  is_latest_source,
  run_key,
  frozen: true,
});

export function newReports(over: Partial<ReportsState> = {}): ReportsState {
  const reports = [row("rr2", "release_readiness", 2, "REL-0002", true), row("rr1", "release_readiness", 1, "REL-0001", false)];
  return { assessed: true, aiOn: false, reports, contents: { rr1: readiness("REL-0001", true), rr2: readiness("REL-0002", false) }, requests: [], ...over };
}

/** Registered after mockRelease, so it answers the reports routes first. */
export async function mockReports(page: Page, r: ReportsState) {
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = req.method();
    if (method === "OPTIONS") return route.fallback();
    let body: Record<string, unknown> = {};
    try {
      body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (path === "/projects/p1/assistant/capabilities") return json(route, 200, { ai_enabled: r.aiOn, provider: r.aiOn ? "fake" : null });
    if (path === "/projects/p1/reports" && method === "GET") return json(route, 200, r.assessed ? r.reports : []);
    if (path === "/projects/p1/reports/completion/lessons-suggestion" && method === "POST") {
      r.requests.push({ method, path, body });
      if (!r.aiOn) return err(route, 409, "conflict", "AI is off: write the lessons learned yourself");
      return json(route, 200, { text: AI_LESSONS, generated_by: "ai", token: AI_TOKEN });
    }
    if (path === "/projects/p1/reports" && method === "POST" && (body.report_type === "completion" || body.report_type === "release_readiness")) {
      r.requests.push({ method, path, body });
      if (!r.assessed) return err(route, 409, "conflict", "Not available yet: assess release readiness first");
      const type = String(body.report_type);
      const version = r.reports.filter((x) => x.report_type === type).length + 1;
      const key = body.basis === "current" ? null : ((body.run_key as string | undefined) ?? "REL-0002");
      const id = `${type === "completion" ? "tc" : "rr"}${version}-new`;
      const created = row(id, type, version, key, type === "release_readiness");
      r.reports = [created, ...r.reports];
      const text = body.lessons_learned as string | undefined;
      r.contents[id] = type === "completion" ? completion(key, text ? { text, generated_by: body.lessons_generated_by ?? "person", author: "Daniele Edema" } : null) : readiness(key ?? "REL-0002", false);
      return json(route, 201, created);
    }
    const detail = path.match(/^\/reports\/([^/]+)$/);
    if (detail && r.contents[detail[1]]) {
      const summary = r.reports.find((x) => x.id === detail[1])!;
      return json(route, 200, { ...summary, content: r.contents[detail[1]], files: [], ai_sections: [] });
    }
    if (path.match(/^\/reports\/[^/]+\/download$/)) {
      r.requests.push({ method, path: `${path}${url.search}`, body });
      const f = url.searchParams.get("format");
      if (f === "docx") return err(route, 422, "validation_failed", "DOCX is not available");
      return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/octet-stream" }, body: f === "pdf" ? "%PDF-1.4 test" : "x" });
    }
    return route.fallback();
  });
}
