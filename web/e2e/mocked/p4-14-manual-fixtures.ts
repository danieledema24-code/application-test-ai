// DEVELOPMENT/TEST FIXTURES ONLY. P4-14 manual runs and results (backend P4-14a: docs/architecture/api-contracts.md
// "Manual runs and results (as built, P4-14a)") stand-ins, layered over ./fixtures.ts and the phase 2–4 fixtures with
// page.route(): manual runs, their results, evidence uploads, finish and discard are answered here; automated runs and
// everything else fall back to ./phase4-exec-fixtures.ts and the earlier fixtures.

import type { Page, Route } from "@playwright/test";
import type { AutomationAssessment } from "../../src/lib/automation";
import type { TestCaseDetail } from "../../src/lib/contract";
import type { ExecState } from "./phase4-exec-fixtures";
import type { ResultDetail, ResultEvidence, RunDetail, TestRow } from "../../src/lib/execution";
import { API } from "./fixtures";
import { testCase } from "./phase3-fixtures";

const NOW = "2026-11-19T15:20:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string, details: unknown = null) => json(route, status, { error: { code, message, details } });

export const ME = { id: "u", full_name: "Daniele Edema" };
export const MEMBER = { id: "m", full_name: "M. Member" };
const NOT_ANALYSED = "Not analysed: recorded by a person";
const WORD: Record<string, string> = { passed: "Passed", failed: "Failed", blocked: "Blocked" };

type Suit = "suitable" | "partial" | "manual_only";
const CASES: { n: number; title: string; suit: Suit; steps?: [string, string][]; expected?: string; last?: TestCaseDetail["last_result"] }[] = [
  { n: 19, title: "Send the form with an empty Message", suit: "suitable", last: { status: "failed", run_key: "RUN-0003", result_key: "RUN-0003-01", at: "2026-11-13T14:20:00Z", manual: false, results: [{ browser: "chromium", viewport: "1440x900", status: "failed", result_key: "RUN-0003-01" }] } },
  {
    n: 27,
    title: "Check the sign-in form's action address",
    suit: "manual_only",
    steps: [
      ["Open /sign-in", "The sign-in form is shown"],
      ["Inspect the form's action address", "It starts with https://"],
    ],
    expected: "The form posts to an https:// address",
  },
  { n: 33, title: "Keyboard-only navigation", suit: "manual_only" },
  {
    n: 34,
    title: "Zoom the page to 400%",
    suit: "manual_only",
    last: { status: "passed", run_key: "RUN-0002", result_key: "RUN-0002-01", at: "2026-11-12T10:00:00Z", manual: true, recorded_by: "M. Member", results: [{ browser: "manual", viewport: "manual", status: "passed", result_key: "RUN-0002-01" }] },
  },
  { n: 40, title: "Screen reader reads the form errors", suit: "manual_only" },
  { n: 41, title: "Error colours have enough contrast", suit: "manual_only" },
];

const key = (n: number) => `TC-${String(n).padStart(4, "0")}`;

/** The approved cases for ./phase3-fixtures.ts (`newP3({ cases })`): one automated, five that need a person. */
export function manualCases(): TestCaseDetail[] {
  return CASES.map((c) =>
    testCase(c.n, {
      title: c.title,
      status: "approved",
      version: 2,
      last_result: c.last ?? null,
      execution_status: c.last?.status ?? "not_run",
      preconditions: c.n === 27 ? ["Signed out"] : ["The site is open"],
      steps: (c.steps ?? [["Open the page", "The page is shown"]]).map(([action, expected], i) => ({ n: i + 1, action, data: [], expected })),
      expected_result: c.expected ?? `${c.title}: works as described`,
      automation_suitability: { value: c.suit, reason: c.suit === "manual_only" ? "Needs human judgement" : "Deterministic UI checks", assessed: "assessed" },
    }),
  );
}

export type ManualState = {
  role: "owner" | "admin" | "member" | "viewer";
  runs: RunDetail[];
  results: Record<string, ResultDetail>;
  next: number;
  requests: { method: string; path: string; body: unknown }[];
  /** One-shot error for the next PUT of a result. */
  failSave: { status: number; code: string; message: string; details?: unknown } | null;
  /** Milliseconds each upload waits before it answers (to see "Uploading…"). */
  uploadDelay: number;
  /** Treat the nth upload (1-based) as an HTML file: WebKit doesn't expose multipart bodies to page.route(). */
  htmlUpload: number | null;
};

export function newManual(over: Partial<ManualState> = {}): ManualState {
  return { role: "owner", runs: [], results: {}, next: 5, requests: [], failSave: null, uploadDelay: 0, htmlUpload: null, ...over };
}

function planRow(runKey: string, i: number, n: number): TestRow {
  const c = CASES.find((x) => x.n === n)!;
  return {
    id: null,
    key: `${runKey}-${String(i).padStart(2, "0")}`,
    case_key: key(n),
    title: c.title,
    test_case_id: `tc${n}`,
    browser: "manual" as never,
    viewport: "manual",
    status: "not_recorded",
    attempts: null,
    duration_ms: null,
    failed_step: null,
    reason: null,
    classification: null,
    confidence: null,
    defect: null,
    retried: false,
    manual: true,
    actual_result: null,
    notes: null,
    recorded_by: null,
  };
}

/** A manual run in `recording` with `cases` (numbers), started by `by`. */
export function manualRun(q: ManualState, cases: number[], opts: { by?: typeof ME; change?: string | null; key?: string } = {}): RunDetail {
  const runKey = opts.key ?? `RUN-${String(q.next++).padStart(4, "0")}`;
  const run = {
    id: runKey.toLowerCase(),
    key: runKey,
    mode: "manual",
    status: "recording",
    selection: { suite: null, case_keys: cases.map(key) },
    selection_label: "Manual",
    browsers: [],
    viewports: [],
    tests: cases.length,
    totals: { tests: cases.length, finished: 0 },
    notes: null,
    requested_by: opts.by ?? ME,
    authorisation: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: null,
    finished_by: null,
    duration_ms: null,
    error: null,
    bundle_version: null,
    manual: { recorded: 0, tests: cases.length, change_set_key: opts.change ?? null },
    scope: null,
    config: {},
    approvals: [],
    tests_rows: cases.map((n, i) => planRow(runKey, i + 1, n)),
    progress: null,
    request_problem: null,
    waiting_for: null,
    cancelled_by: null,
    analysis: null,
    permissions: { can_authorise: false, can_cancel: false, can_rerun: false, is_requester: false },
  } as unknown as RunDetail;
  q.runs.unshift(run);
  return run;
}

/** Records a result directly (seeding): `who` defaults to me. */
export function seedResult(q: ManualState, run: RunDetail, n: number, status: "passed" | "failed" | "blocked", what: string, who = ME, notes: string | null = null) {
  const row = run.tests_rows.find((r) => r.case_key === key(n))!;
  write(q, run, row, status, what, notes, who, SEEDED_AT);
}

/** recorded_at of seeded results and of results saved through PUT (the server's clock, not the browser's). */
export const SEEDED_AT = "2026-11-19T15:40:00Z";
export const SAVED_AT = "2026-11-19T15:52:00Z";

function write(q: ManualState, run: RunDetail, row: TestRow, status: string, what: string, notes: string | null, who: typeof ME, at: string) {
  Object.assign(row, { id: `res-${row.key}`, status, actual_result: what, notes, recorded_by: who, recorded_at: at, attempts: 1 });
  const c = CASES.find((x) => key(x.n) === row.case_key)!;
  const prev = q.results[row.key];
  q.results[row.key] = {
    ...row,
    run: { id: run.id, key: run.key, status: run.status },
    case: { id: row.test_case_id!, key: row.case_key, title: c.title, version: 2, expected_result: c.expected ?? `${c.title}: works as described`, provenance: "observed", steps: (c.steps ?? [["Open the page", "The page is shown"]]).map(([action, expected], i) => ({ n: i + 1, action, expected })) },
    script: null,
    attempt_details: [],
    error: null,
    actual_result: what,
    page_state: {},
    checks_by_step: {},
    evidence: prev?.evidence ?? [],
    signs_in: false,
    analysis: null,
    heal_suggestions: [],
    repairs: [],
    notes,
    not_analysed: NOT_ANALYSED,
    recorded_by: who,
    permissions: { can_reclassify: false, can_raise_defect: true, can_accept_fix: false },
  };
  totals(run);
}

function totals(run: RunDetail) {
  const done = run.tests_rows.filter((r) => r.id);
  const n = (s: string) => done.filter((r) => r.status === s).length;
  run.totals = { tests: run.tests_rows.length, finished: done.length, passed: n("passed"), failed: n("failed"), blocked: n("blocked") };
  run.manual = { ...(run.manual ?? { change_set_key: null }), recorded: done.length, tests: run.tests_rows.length } as RunDetail["manual"];
}

/** The run as the signed-in person sees it (permissions per role, recorder and state). */
function view(q: ManualState, run: RunDetail): RunDetail {
  const member = q.role !== "viewer";
  const recording = run.status === "recording";
  const recorded = run.tests_rows.filter((r) => r.id).length;
  const mine = run.requested_by?.id === ME.id;
  return {
    ...run,
    permissions: {
      can_authorise: false,
      can_cancel: member && recording && recorded === 0 && (mine || q.role === "owner"),
      can_rerun: false,
      is_requester: mine,
      can_record: member && recording,
      can_finish: member && recording && recorded > 0,
    },
  };
}

function resultView(q: ManualState, r: ResultDetail): ResultDetail {
  const run = q.runs.find((x) => x.id === r.run?.id);
  const member = q.role !== "viewer";
  const mine = member && run?.status === "recording" && r.recorded_by?.id === ME.id;
  return { ...r, run: run ? { id: run.id, key: run.key, status: run.status } : r.run, permissions: { can_reclassify: false, can_raise_defect: member, can_accept_fix: false, can_record: mine, can_upload: mine && r.evidence.length < 5 } };
}

/** The manual assessment for the cases above (overrides ./phase4-fixtures.ts). */
function assessment(): AutomationAssessment {
  const cases = CASES.map((c) => ({ test_case_id: `tc${c.n}`, case_lineage_id: `tc${c.n}`, key: key(c.n), title: c.title, case_version: 2, suitability: c.suit, reasons: [c.suit === "manual_only" ? "Needs human judgement" : "Every step can be scripted"], blockers: [] }));
  const count = (k: Suit) => cases.filter((x) => x.suitability === k).length;
  return { status: "completed", stale_reason: null, g5_approved: true, g5_decided_at: NOW, credentials_saved: false, run: { id: "ar1", version: 1, finished_at: NOW }, counts: { suitable: count("suitable"), partial: count("partial"), manual_only: count("manual_only"), total: cases.length }, cases };
}

export async function mockManual(page: Page, q: ManualState, exec: ExecState) {
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
    const record = () => q.requests.push({ method, path: `${path}${url.search}`, body });
    const member = q.role !== "viewer";

    if (path === "/projects/p1/automation/assessment") return json(route, 200, assessment());

    // ---- runs (manual first, then the automated runs of ./phase4-exec-fixtures.ts)
    if (path === "/projects/p1/execution-runs" && method === "GET") {
      const st = url.searchParams.get("status");
      const all = [...q.runs.map((r) => view(q, r)), ...exec.runs];
      return json(route, 200, {
        items: all.filter((r) => !st || st.split(",").includes(r.status)),
        waiting: exec.runs.filter((r) => r.status === "awaiting_authorisation").map((r) => r.key),
        running: exec.runs.find((r) => r.status === "running")?.key ?? null,
        recording: q.runs.filter((r) => r.status === "recording").map((r) => r.key),
        permissions: { can_request: member, can_authorise: member && exec.canApprove },
      });
    }
    if (path === "/projects/p1/execution-runs" && method === "POST" && body.mode === "manual") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const keys = (body.case_keys as string[]) ?? [];
      if (!keys.length) return err(route, 422, "validation_error", "Choose the test cases you'll record.", [{ field: "case_keys", message: "Choose the test cases you'll record." }]);
      const unknown = keys.filter((k) => !CASES.some((c) => key(c.n) === k));
      if (unknown.length) return err(route, 422, "validation_error", `Only test cases approved at Gate 5 can be recorded: ${unknown.join(", ")}.`, [{ field: "case_keys", message: "x" }]);
      const run = manualRun(q, keys.map((k) => Number(k.slice(3))), { change: (body.change_set_key as string) ?? null });
      return json(route, 201, view(q, run));
    }
    const byKey = path.match(/^\/projects\/p1\/execution-runs\/by-key\/([^/]+)$/);
    if (byKey) {
      const r = q.runs.find((x) => x.key === byKey[1]);
      return r ? json(route, 200, view(q, r)) : route.fallback();
    }
    const act = path.match(/^\/execution-runs\/([^/]+)\/(finish|cancel)$/);
    if (act) {
      const run = q.runs.find((x) => x.id === act[1]);
      if (!run) return route.fallback();
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const recorded = run.tests_rows.filter((r) => r.id).length;
      if (act[2] === "cancel") {
        if (recorded) return err(route, 409, "conflict", `${run.key} has recorded results, so it can't be cancelled. Finish it instead.`);
        Object.assign(run, { status: "cancelled", finished_at: NOW, error: "Cancelled. Nothing was recorded." });
        return json(route, 200, { message: `${run.key} cancelled.`, run: view(q, run) });
      }
      if (run.status !== "recording") return err(route, 409, "conflict", `${run.key} is finished. Start a new manual run to record again.`);
      if (!recorded) return err(route, 409, "conflict", "Record at least one result before finishing, or cancel the run.");
      for (const r of run.tests_rows) if (!r.id) r.status = "not_run";
      Object.assign(run, { status: run.tests_rows.some((r) => r.status === "failed") ? "failed" : "passed", finished_at: "2026-11-19T16:10:00Z", finished_by: ME });
      for (const r of Object.values(q.results)) if (r.run?.id === run.id) r.run = { id: run.id, key: run.key, status: run.status };
      const notRun = run.tests_rows.length - recorded;
      return json(route, 200, { message: `${run.key} finished: ${recorded} recorded${notRun ? `, ${notRun} not run.` : "."}`, run: view(q, run) });
    }
    const put = path.match(/^\/execution-runs\/([^/]+)\/results\/([^/]+)$/);
    if (put && method === "PUT") {
      const run = q.runs.find((x) => x.id === put[1]);
      if (!run) return err(route, 404, "not_found", "Run not found");
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (q.failSave) {
        const f = q.failSave;
        q.failSave = null;
        return err(route, f.status, f.code, f.message, f.details ?? null);
      }
      if (run.status !== "recording") return err(route, 409, "conflict", `${run.key} is finished. Start a new manual run to record again.`, { status: run.status });
      const row = run.tests_rows.find((r) => r.case_key === put[2]);
      if (!row) return err(route, 404, "not_found", `${put[2]} isn't in ${run.key}.`);
      if (row.recorded_by && row.recorded_by.id !== ME.id) return err(route, 403, "forbidden", `Only ${row.recorded_by.full_name} can change this result until ${run.key} is finished.`);
      const what = String(body.actual_result ?? "").trim();
      if (!what) return err(route, 422, "validation_error", "Describe what happened.", [{ field: "actual_result", message: "Describe what happened." }]);
      write(q, run, row, String(body.status), what, (body.notes as string) || null, ME, SAVED_AT);
      return json(route, 200, { message: `${row.case_key} saved as ${WORD[String(body.status)]}.`, result: resultView(q, q.results[row.key]), run: view(q, run) });
    }
    const res = path.match(/^\/projects\/p1\/execution-results\/by-key\/([^/]+)$/);
    if (res) {
      const r = q.results[res[1]];
      if (!r) return route.fallback();
      const d = exec.defects.find((x) => (x as unknown as { from_result?: string }).from_result === r.key);
      return json(route, 200, resultView(q, d ? { ...r, defect: { id: d.id, key: d.key, status: d.status, summary: d.summary } } : r));
    }
    const ev = path.match(/^\/execution-results\/([^/]+)\/evidence$/);
    if (ev && method === "POST") {
      const r = Object.values(q.results).find((x) => x.id === ev[1]);
      if (!r) return err(route, 404, "not_found", "Result not found");
      q.requests.push({ method, path, body: null });
      const nth = q.requests.filter((x) => x.method === "POST" && x.path.endsWith("/evidence")).length;
      if (q.uploadDelay) await new Promise((ok) => setTimeout(ok, q.uploadDelay));
      const data = req.postDataBuffer()?.toString("latin1") ?? "";
      if (nth === q.htmlUpload || /<html|<!doctype/i.test(data)) return err(route, 422, "validation_error", "This file type isn't supported. Use PNG, JPEG or PDF.", [{ field: "file", message: "This file type isn't supported. Use PNG, JPEG or PDF." }]);
      if (r.evidence.length >= 5) return err(route, 409, "conflict", "A result can have up to 5 files.");
      const pdf = data.includes("%PDF-");
      const n = r.evidence.length + 1;
      const e: ResultEvidence = { id: `ev-${r.key}-${n}`, kind: pdf ? "document_file" : "screenshot", mime: pdf ? "application/pdf" : "image/png", size: 412_000, captured_at: NOW, content_url: `${API}/evidence/ev-${r.key}-${n}/content?exp=1&sig=x`, attempt: null };
      r.evidence = [...r.evidence, e];
      return json(route, 201, { message: `File added to ${r.key}.`, evidence: e, result: resultView(q, r) });
    }
    return route.fallback();
  });
}

// ---- Traceability with manual results (§5) ------------------------------------------------------------------------

const tref = (type: string, k: string, label = k) => ({ type, id: k.toLowerCase(), key: k, label, path: `/projects/p1/x/${k}` });

/** Matrix and gaps once TC-0027 passed and TC-0033 failed by hand (RUN-0005). */
export async function mockTraceManual(page: Page) {
  const passed = { script: null, result: { status: "passed", run_key: "RUN-0005", result_key: "RUN-0005-01", at: NOW, manual: true, recorded_by: "Daniele Edema" }, defects: [] };
  const failed = { script: null, result: { status: "failed", run_key: "RUN-0005", result_key: "RUN-0005-02", at: NOW, manual: true, recorded_by: "M. Member" }, defects: [] };
  await page.route(`${API}/projects/p1/traceability**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    if (path.endsWith("/coverage"))
      return json(route, 200, {
        basis: "current",
        design_version: 2,
        snapshot_hash: null,
        requirements: { approved: 2, with_case: 2, with_approved_case: 2, percent_approved_covered: 100 },
        acceptance_criteria: { approved: 1, covered: 1, percent: 100 },
        high_risk_requirements: { total: 1, with_approved_case: 1 },
        techniques: [],
        test_cases: { by_status: { approved: 2 }, orphans: 0 },
        execution: { executed: true, requirements: { approved: 2, with_result: 2 }, results: { tests: 2, passed: 1, failed: 1, flaky: 0, error: 0, blocked: 0, skipped: 0 }, automation: { approved_cases: 2, with_valid_script: 0 } },
      });
    if (path.endsWith("/gaps"))
      return json(route, 200, {
        requirements_without_test_cases: { none: [], none_approved: [] },
        test_cases_without_requirements: [],
        acceptance_criteria_without_test_cases: [],
        untested_high_risk: { open: [], accepted: [] },
        features_without_requirements: [],
        requirements_without_execution_evidence: { executed: true, automated_not_run: [], manual_only: [tref("requirement", "REQ-0009", "Screen reader users hear errors")] },
        failed_tests: [{ case: tref("test_case", "TC-0033"), status: "failed", run_key: "RUN-0005", result_key: "RUN-0005-02", classification: null, label: NOT_ANALYSED, manual: true, recorded_by: "M. Member" }],
        flaky_tests: [],
        outdated_automation_scripts: [],
        defects_without_regression_coverage: [],
      });
    return json(route, 200, {
      next_cursor: null,
      items: [
        {
          requirement: tref("requirement", "REQ-0008", "The sign-in form posts over HTTPS"),
          requirement_status: "approved",
          risk: null,
          acceptance_criteria: [],
          conditions: [],
          test_cases: [
            { case: tref("test_case", "TC-0027"), status: "approved", priority: "high", ...passed },
            { case: tref("test_case", "TC-0033"), status: "approved", priority: "high", ...failed },
          ],
          automation: [],
          results: [
            { case_key: "TC-0027", ...passed.result },
            { case_key: "TC-0033", ...failed.result },
          ],
          defects: [],
        },
      ],
    });
  });
}
