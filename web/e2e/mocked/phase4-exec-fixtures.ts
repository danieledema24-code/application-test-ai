// DEVELOPMENT/TEST FIXTURES ONLY. Phase 4 execution, analysis and defects (P4-06…P4-09) stand-ins for the QA
// Analyst API (backend app/api/routers/execution.py, defects.py and the run preview in automation.py), layered over
// ./fixtures.ts and the phase 2–4 fixtures with page.route(): execution and defect paths are answered here,
// everything else falls back.

import type { Page, Route } from "@playwright/test";
import type { ApprovalCard, ResultDetail, RunDetail, RunScope, TestRow } from "../../src/lib/execution";
import type { DefectDetail, DefectRow, DefectStatus } from "../../src/lib/defects";
import { API } from "./fixtures";

const NOW = "2026-11-13T14:20:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string, details: unknown = null) => json(route, status, { error: { code, message, details } });
// 1×1 grey PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

export type ExecState = {
  role: "owner" | "admin" | "member" | "viewer";
  canApprove: boolean;
  /** Add a checkout case needing an external-transaction approval (design check 17). */
  risky: boolean;
  runs: RunDetail[];
  results: ResultDetail[];
  defects: DefectDetail[];
  requests: { method: string; path: string; body: unknown }[];
};

const ME = { id: "u", full_name: "Daniele Edema" };
const MEMBER = { id: "m", full_name: "M. Member" };
const APPROVER = { id: "a", full_name: "A. Approver" };

const SIDE = [
  { kind: "may_submit", form: "contact", text: "May submit the Contact us form (if the application does not block it)", count: 1, case_keys: ["TC-0019"] },
  { kind: "submits", form: "contact", text: "Submits the Contact us form", count: 1, case_keys: ["TC-0020"] },
  { kind: "signs_in", form: null, text: "Signs in with the saved test account", count: 1, case_keys: ["TC-0031"] },
];

const CASES = [
  ["TC-0019", "Send the contact form with an empty Message"],
  ["TC-0020", "Send the contact form with every field valid"],
  ["TC-0031", "Sign in: valid email and correct password"],
  ["TC-0022", "Open the home page"],
] as const;

export function scope(q: ExecState, sel: { suite?: string | null; case_keys?: string[] | null } = { suite: "regression" }, browsers: string[] = ["chromium"], viewports: string[] = ["desktop"]): RunScope {
  let cases = CASES.map(([key, title]) => ({
    key: key as string,
    title: title as string,
    test_case_id: `tc-${key}`,
    script_id: `s-${key}`,
    script_version: 1,
    path: `tests/x/${key}.spec.ts`,
    side_effects: [],
    needs_approval: [] as string[],
    signs_in: key === "TC-0031",
    retried: true,
    blocked: key === "TC-0031" ? "Needs saved test credentials" : null,
  }));
  if (q.risky) cases.push({ key: "TC-0044", title: "Pay with a test card on /checkout", test_case_id: "tc-TC-0044", script_id: "s-TC-0044", script_version: 1, path: "tests/checkout/TC-0044.spec.ts", side_effects: [], needs_approval: ["external_transaction"], signs_in: false, retried: false, blocked: null });
  if (sel.case_keys) cases = cases.filter((c) => sel.case_keys!.includes(c.key));
  else if (sel.suite === "smoke") cases = cases.slice(0, 2);
  const tests = cases.length * browsers.length * viewports.length;
  const approvals = q.risky && cases.some((c) => c.key === "TC-0044") ? [{ kind: "external_transaction" as const, title: "External transaction (payment or purchase)", case_keys: ["TC-0044"], cases: [{ key: "TC-0044", title: "Pay with a test card on /checkout", step: 4, quote: "Press Pay now" }] }] : [];
  return {
    target_origin: "http://localhost:4100",
    target_host: "localhost:4100",
    selection: { suite: (sel.case_keys ? null : (sel.suite ?? "regression")) as never, case_keys: sel.case_keys ?? null },
    browsers: browsers as never,
    viewports: viewports as never,
    viewport_sizes: {},
    bundle_version: 2,
    cases,
    left_out: sel.case_keys ? [] : [{ key: "TC-0040", title: "Send the newsletter form", reason: "script can't run", code: "invalid" }],
    blocked: cases.filter((c) => c.blocked).map((c) => ({ key: c.key, title: c.title, reason: "Needs saved test credentials" })),
    tests,
    limit: 300,
    over_limit: tests > 300,
    limit_message: null,
    estimated_seconds: 240,
    side_effects: SIDE.filter((l) => l.case_keys.some((k) => cases.some((c) => c.key === k))),
    risky: approvals.length ? "yes" : "no",
    risky_line: approvals.length ? null : "Pays, buys or deletes anything: no",
    approvals_needed: approvals,
    signs_in: cases.some((c) => c.signs_in),
    not_retried: cases.filter((c) => !c.retried).map((c) => c.key),
    installed_browsers: { chromium: true, firefox: false, webkit: false },
    scope_hash: `h-${cases.map((c) => c.key).join(",")}-${browsers.join()}-${viewports.join()}`,
  };
}

function trow(run: string, n: number, key: string, status: TestRow["status"], over: Partial<TestRow> = {}): TestRow {
  const title = CASES.find((c) => c[0] === key)?.[1] ?? key;
  const done = status !== "running" && status !== "waiting";
  return {
    id: done ? `res-${run}-${n}` : null,
    key: `${run}-0${n}`,
    case_key: key,
    title,
    test_case_id: `tc-${key}`,
    browser: "chromium",
    viewport: "1440x900",
    status,
    attempts: done ? (status === "blocked" ? 0 : status === "passed" ? 1 : 2) : null,
    duration_ms: done && status !== "blocked" ? 8400 : null,
    failed_step: status === "failed" ? { n: 5, title: "Press Send message" } : null,
    reason: status === "blocked" ? "Needs saved test credentials" : null,
    classification: null,
    confidence: null,
    defect: null,
    retried: true,
    ...over,
  };
}

const perms = (q: ExecState, mine: boolean, status: string) => ({
  can_authorise: q.role !== "viewer" && q.canApprove && status === "awaiting_authorisation",
  can_cancel: q.role !== "viewer" && (q.canApprove || mine) && ["awaiting_authorisation", "queued", "running"].includes(status),
  can_rerun: q.role !== "viewer" && ["passed", "failed", "error", "cancelled"].includes(status),
  is_requester: mine,
});

export function baseRun(q: ExecState, over: Partial<RunDetail> & Pick<RunDetail, "key" | "status">): RunDetail {
  const sc = scope(q);
  const mine = over.requested_by?.id === "u";
  return {
    id: over.key.toLowerCase(),
    mode: "automated",
    selection: { suite: "regression" },
    selection_label: "Regression",
    browsers: ["chromium"],
    viewports: ["desktop"],
    tests: sc.tests,
    totals: {},
    notes: null,
    requested_by: MEMBER,
    authorisation: null,
    created_at: NOW,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error: null,
    bundle_version: 2,
    scope: sc,
    config: { workers: 2, retries: 1, test_timeout_s: 60 },
    approvals: [],
    tests_rows: [],
    progress: null,
    request_problem: null,
    waiting_for: null,
    cancelled_by: null,
    analysis: null,
    ...over,
    permissions: perms(q, mine, over.status),
  };
}

function finishedRun(q: ExecState): RunDetail {
  const rows = [
    trow("RUN-0003", 1, "TC-0019", "failed", { classification: "application_defect", confidence: "high", defect: { id: "d1", key: "DEF-0001", status: "draft", summary: "Contact form accepts an empty Message" } }),
    trow("RUN-0003", 2, "TC-0020", "passed"),
    trow("RUN-0003", 3, "TC-0031", "blocked"),
    trow("RUN-0003", 4, "TC-0022", "flaky", { classification: "flaky", confidence: "high" }),
  ];
  return baseRun(q, {
    key: "RUN-0003",
    status: "failed",
    totals: { passed: 1, failed: 1, flaky: 1, blocked: 1, error: 0 },
    authorisation: { decision: "approve", by: APPROVER, at: NOW, comment: null, self_authorised: false },
    started_at: "2026-11-13T14:16:00Z",
    finished_at: NOW,
    duration_ms: 252000,
    tests_rows: rows,
    analysis: {
      status: "completed",
      generated_by: "rules",
      error: null,
      output: {
        analysed: 2,
        by_classification: { application_defect: 1, flaky: 1 },
        drafted: ["DEF-0001"],
        groups: [
          { classification: "flaky", label: "Flaky", items: [{ result_id: "res-RUN-0003-4", result_key: "RUN-0003-04", case_key: "TC-0022", signal: "Failed on attempt 1, passed on attempt 2", defect: null }] },
          { classification: "application_defect", label: "Likely bug in the application", items: [{ result_id: "res-RUN-0003-1", result_key: "RUN-0003-01", case_key: "TC-0019", signal: "Every action step passed, then the check failed", defect: rows[0].defect }] },
        ],
      },
    },
  });
}

function result19(q: ExecState): ResultDetail {
  const row = finishedRun(q).tests_rows[0];
  const steps = (attempt: number) => ({
    attempt,
    status: "failed",
    duration_ms: 4200,
    error: "Expected the Contact us form to still be shown",
    steps: [
      { n: 1, title: "Open /contact", status: "passed" as const, duration_ms: 800, error: null },
      { n: 2, title: 'Enter "Ada Test" in Name', status: "passed" as const, duration_ms: 200, error: null },
      { n: 3, title: 'Enter "ada@example.com" in Email', status: "passed" as const, duration_ms: 200, error: null },
      { n: 4, title: "Leave Message empty", status: "passed" as const, duration_ms: 0, error: null },
      { n: 5, title: "Press Send message", status: "failed" as const, duration_ms: 5100, error: "Expected the Contact us form to still be shown" },
    ],
  });
  const ev = (id: string, kind: string, mime: string) => ({ id, kind, mime, size: 10, captured_at: NOW, content_url: `${API}/evidence/${id}/content?exp=1&sig=x`, attempt: 2 });
  return {
    ...row,
    run: { id: "run-0003", key: "RUN-0003", status: "failed" },
    case: { id: "tc-TC-0019", key: "TC-0019", title: row.title!, version: 3, expected_result: "Submission is blocked and Message is identified as required", provenance: "assumed", steps: [] },
    script: { id: "s-TC-0019", path: "tests/contact/TC-0019.spec.ts", version: 1 },
    attempt_details: [steps(1), steps(2)],
    error: "Expected the Contact us form to still be shown",
    actual_result: "Step 'Press Send message' failed: Expected the Contact us form to still be shown, but the page shows 'Thank you' (Message sent) at /contact.",
    page_state: { url: "http://localhost:4100/contact", heading: "Thank you", browser: "Chromium 131.0" },
    checks_by_step: { "5": [{ helper: "expectSubmissionBlocked", kind: "submission_blocked", args: ["Contact us"] }, { helper: "expectFieldFlagged", kind: "field_flagged", args: ["Contact us", "Message"] }] },
    evidence: [ev("ev-shot", "screenshot", "image/png"), ev("ev-video", "video", "video/webm"), ev("ev-trace", "trace", "application/zip"), ev("ev-console", "console_log", "text/plain"), ev("ev-net", "network_log", "text/plain")],
    signs_in: false,
    analysis: {
      classification: "application_defect",
      label: "Likely bug in the application",
      confidence: "high",
      signals: [
        { code: "assertion_failed_after_actions", detail: "Every action step passed, then the check failed", observed: true, evidence: ["screenshot"] },
        { code: "page_contradicts_expected", detail: 'The page showed "Thank you" instead of blocking the form', observed: true, evidence: ["screenshot", "video"] },
        { code: "failed_every_attempt", detail: "It failed on all 2 attempts", observed: true, evidence: [] },
        { code: "no_network_errors", detail: "No network errors, safety blocks or server errors", observed: true, evidence: ["network_log"] },
      ],
      summary: "The site accepted the Contact us form with Message empty.",
      possible_causes: ["The Message field isn't marked as required in the form.", "The server accepts the form without checking Message."],
      next_steps: ["Confirm or reject DEF-0001 (Gate 8).", "After a fix, re-run TC-0019 to verify."],
      hypothesis: true,
      generated_by: "rules",
      case_key: "TC-0019",
      defect: { id: "d1", key: "DEF-0001", status: "draft", summary: "Contact form accepts an empty Message" },
    },
    heal_suggestions: [],
    permissions: { can_reclassify: q.role !== "viewer", can_raise_defect: q.role !== "viewer", can_accept_fix: q.role !== "viewer" },
  };
}

function result22(q: ExecState): ResultDetail {
  const r = result19(q);
  const row = finishedRun(q).tests_rows[3];
  return {
    ...r,
    ...row,
    case: { ...r.case!, key: "TC-0022", title: row.title!, expected_result: "The home page is shown" },
    actual_result: null,
    attempt_details: [
      { ...r.attempt_details[0], steps: r.attempt_details[0].steps.slice(0, 1).map((s) => ({ ...s, status: "failed" as const })) },
      { attempt: 2, status: "passed", duration_ms: 900, error: null, steps: r.attempt_details[0].steps.slice(0, 1) },
    ],
    analysis: { ...r.analysis!, classification: "flaky", label: "Flaky", confidence: "high", signals: [{ code: "flaky_retry_pass", detail: "Failed on attempt 1, passed on attempt 2", observed: true, evidence: ["video"] }], possible_causes: [], next_steps: [], defect: undefined, no_defect: "flaky" },
    defect: null,
  };
}

function resultSignIn(q: ExecState): ResultDetail {
  const r = result19(q);
  return { ...r, key: "RUN-0006-01", case_key: "TC-0031", title: CASES[2][1], status: "failed", signs_in: true, defect: null, analysis: null, evidence: r.evidence.filter((e) => e.kind !== "trace"), run: { id: "run-0006", key: "RUN-0006", status: "failed" } };
}

/** An "Element not found" result with a fix suggestion (design §9.3). */
export function resultHeal(q: ExecState): ResultDetail {
  const r = result19(q);
  const old = 'this.page.getByLabel("Message")';
  const cand = (by: string, expr: string, recommended: boolean) => ({
    by,
    name: "Your message",
    role: by === "role" ? "textbox" : "",
    expression: expr,
    status: "unique" as const,
    recommended,
    diff: { old, new: `this.page.${expr}` },
  });
  return {
    ...r,
    id: "res-RUN-0003-5",
    key: "RUN-0003-05",
    case_key: "TC-0040",
    title: "Send the contact form with every field filled",
    status: "failed",
    defect: null,
    actual_result: null,
    analysis: {
      ...r.analysis!,
      classification: "selector_failure",
      label: "Element not found",
      confidence: "medium",
      signals: [{ code: "locator_not_found", detail: "getByLabel('Message') wasn't found on /contact", observed: true, evidence: ["screenshot"] }],
      defect: undefined,
      no_defect: "not_application",
      case_key: "TC-0040",
    },
    heal_suggestions: [
      {
        asset_path: "pages/ContactPage.ts",
        getter: "message",
        element: "Message field",
        page_path: "/contact",
        old_expression: 'getByLabel("Message")',
        reason: "The Message field's label changed. These locators find it on /contact today:",
        candidates: [cand("label", 'getByLabel("Your message")', true), cand("role", 'getByRole("textbox", { name: "Your message" })', false)],
        note: "Changes how the test finds the field, not what it checks. Expected results stay the same.",
        accepted: null,
        asset_version: 1,
      },
    ],
  };
}

const reproduce = { attempts_failed: 2, attempts: 2, kind: "always" as const, occurrences: 1, text: "2 of 2 attempts (always)" };

function defect(q: ExecState, key: string, status: DefectStatus, summary: string, over: Partial<DefectDetail> = {}): DefectDetail {
  return {
    id: key.toLowerCase(),
    key,
    summary,
    severity: "major",
    priority: "medium",
    status,
    source: "analysis",
    reproducibility: reproduce,
    cases: ["TC-0019"],
    requirements: ["REQ-0006"],
    run_key: "RUN-0003",
    result_key: "RUN-0003-01",
    last_seen: NOW,
    version: 1,
    created_at: NOW,
    actions: { confirm: null, reject: null, fixed: null, verified: null, closed: null },
    description: "The Contact us form sends the message when Message is empty. Found by TC-0019 in RUN-0003.",
    environment: { url: "http://localhost:4100", browser: "Chromium 131.0", viewport: "1440x900", run_key: "RUN-0003", result_key: "RUN-0003-01", date: NOW, failed_step: "Press Send message", script_version: 1 },
    preconditions: ["The Contact us page is reachable."],
    steps: ["Open /contact", 'Enter "Ada Test" in Name', 'Enter "ada@example.com" in Email', "Leave Message empty", "Press Send message"],
    expected: "Submission is blocked and Message is identified as required",
    actual: "The page shows \"Thank you\" (Message sent) at /contact.",
    severity_derived: "major",
    severity_reason: 'from REQ-0006 risk High (RISK-005) and "a blocked submission failed"',
    priority_derived: "medium",
    priority_reason: "from TC-0019",
    root_cause_hypothesis: "Likely bug in the application (high). The site accepted the Contact us form with Message empty.",
    status_reason: null,
    status_comment: null,
    evidence: [],
    result: { id: "res-RUN-0003-1", key: "RUN-0003-01", status: "failed" },
    analysis: { classification: "application_defect", label: "Likely bug in the application", confidence: "high", signals: [], generated_by: "rules" },
    script: { id: "s-TC-0019", path: "tests/contact/TC-0019.spec.ts", version: 1 },
    occurrences: [{ result_id: "res-RUN-0003-1", result_key: "RUN-0003-01", run_key: "RUN-0003", seen_at: NOW, status: "failed" }],
    g8: null,
    verify: status === "fixed" ? { ready: false, message: "No passing re-run yet. Re-run TC-0019 after the fix to verify it." } : null,
    permissions: { can_edit: true, can_decide: true },
    ...over,
  };
}

/** Actions per the backend's `can_do` (None when allowed, "permission" or the reason). */
function withActions(q: ExecState, d: DefectDetail): DefectDetail {
  const member = q.role !== "viewer";
  const approver = member && q.canApprove;
  const g = (ok: boolean, why: string, needsApprover: boolean) => (needsApprover ? (!approver ? "permission" : ok ? null : why) : !member ? "permission" : ok ? null : why);
  return {
    ...d,
    actions: {
      confirm: g(d.status === "draft", "They aren't drafts.", true),
      reject: g(d.status === "draft", "They aren't drafts.", true),
      fixed: g(d.status === "confirmed", "Only confirmed defects can be marked fixed.", false),
      verified: g(d.status === "fixed", "Only fixed defects can be verified.", true),
      closed: g(d.status === "verified" || d.status === "rejected", "Only verified or rejected defects can be closed.", false),
    },
    permissions: { can_edit: member && ["draft", "confirmed"].includes(d.status), can_decide: approver },
  };
}

export function newExec(over: Partial<ExecState> = {}): ExecState {
  const q: ExecState = { role: "owner", canApprove: true, risky: false, runs: [], results: [], defects: [], requests: [], ...over };
  if (!over.runs) q.runs = [finishedRun(q)];
  if (!over.results) q.results = [result19(q), result22(q), resultSignIn(q), resultHeal(q)];
  if (!over.defects)
    q.defects = [
      defect(q, "DEF-0001", "draft", "Contact form accepts an empty Message"),
      defect(q, "DEF-0002", "draft", "Session isn't kept after reload", { cases: ["TC-0033"], requirements: ["REQ-0009"] }),
      defect(q, "DEF-0003", "confirmed", "Name accepts 300 characters"),
      defect(q, "DEF-0004", "fixed", "Email field allows spaces"),
    ];
  return q;
}

export function waitingRun(q: ExecState, over: Partial<RunDetail> = {}): RunDetail {
  const sc = scope(q);
  const approvals: ApprovalCard[] = sc.approvals_needed.map((a, i) => ({
    id: `apr${i}`,
    key: `APR-000${i + 1}`,
    kind: a.kind,
    title: a.title,
    status: "pending",
    scope: { case_keys: a.case_keys, cases: a.cases, target_host: sc.target_host },
    decided_by: null,
    decided_at: null,
    comment: null,
    expires_at: null,
    confirm_prompt: `Type ${sc.target_host} to confirm`,
    can_decide: q.canApprove,
  }));
  return baseRun(q, { key: "RUN-0004", status: "awaiting_authorisation", notes: "Before the release meeting", approvals, tests_rows: sc.cases.map((c, i) => trow("RUN-0004", i + 1, c.key, "waiting")), ...over });
}

export function runningRun(q: ExecState): RunDetail {
  return baseRun(q, {
    key: "RUN-0005",
    status: "running",
    authorisation: { decision: "approve", by: ME, at: NOW, comment: null, self_authorised: true },
    requested_by: ME,
    started_at: NOW,
    tests_rows: [trow("RUN-0005", 1, "TC-0019", "running", { attempts: 2 }), trow("RUN-0005", 2, "TC-0020", "passed"), trow("RUN-0005", 3, "TC-0031", "waiting"), trow("RUN-0005", 4, "TC-0022", "waiting")],
  });
}

function listOf(q: ExecState, status: string): DefectRow[] {
  const all = q.defects.map((d) => withActions(q, d));
  if (status === "all") return all;
  if (status === "open") return all.filter((d) => ["draft", "confirmed", "fixed"].includes(d.status));
  return all.filter((d) => status.split(",").includes(d.status));
}

export async function mockExec(page: Page, q: ExecState) {
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
    const approver = member && q.canApprove;

    // ---- runs
    if (path === "/projects/p1/execution-runs/preview" && method === "POST") {
      const sel = (body.selection ?? {}) as { suite?: string; case_keys?: string[] };
      return json(route, 200, scope(q, sel, (body.browsers as string[]) ?? ["chromium"], (body.viewports as string[]) ?? ["desktop"]));
    }
    if (path === "/projects/p1/execution-runs" && method === "GET") {
      const st = url.searchParams.get("status");
      const items = q.runs.filter((r) => !st || st.split(",").includes(r.status));
      return json(route, 200, {
        items,
        waiting: q.runs.filter((r) => r.status === "awaiting_authorisation").map((r) => r.key),
        running: q.runs.find((r) => r.status === "running")?.key ?? null,
        permissions: { can_request: member, can_authorise: approver },
      });
    }
    if (path === "/projects/p1/execution-runs" && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (body.authorise && !approver) return err(route, 403, "forbidden", "Authorising runs needs gate-approval permission");
      const sel = (body.selection ?? {}) as { suite?: string; case_keys?: string[] };
      const sc = scope(q, sel, body.browsers as string[], body.viewports as string[]);
      const run = body.authorise
        ? baseRun(q, { key: "RUN-0004", status: "queued", scope: sc, tests: sc.tests, requested_by: ME, authorisation: { decision: "approve", by: ME, at: NOW, comment: null, self_authorised: true }, tests_rows: sc.cases.map((c, i) => trow("RUN-0004", i + 1, c.key, "waiting")) })
        : waitingRun(q, { scope: sc, tests: sc.tests, requested_by: ME });
      run.permissions = perms(q, true, run.status);
      q.runs = [run, ...q.runs.filter((r) => r.key !== run.key)];
      return json(route, 201, run);
    }
    const byKey = path.match(/^\/projects\/p1\/execution-runs\/by-key\/([^/]+)$/);
    if (byKey) {
      const r = q.runs.find((x) => x.key === byKey[1]);
      return r ? json(route, 200, r) : err(route, 404, "not_found", `We couldn't find ${byKey[1]} in this project.`);
    }
    const runAct = path.match(/^\/execution-runs\/([^/]+)\/(authorise|cancel|rerun|live)$/);
    if (runAct) {
      const r = q.runs.find((x) => x.id === runAct[1]);
      if (!r) return err(route, 404, "not_found", "Run not found");
      if (runAct[2] === "live") {
        if (r.status !== "running") return err(route, 404, "not_found", "The run isn't running");
        return json(route, 200, { slots: [{ slot: "w0", title: "TC-0019 Send the contact form with an empty Message · Step 5 of 5 · Press Send message · Attempt 2 of 2", state: "running", frame_url: `${API}/execution-runs/${r.id}/live/w0/frame?exp=1&sig=x`, at: NOW }] });
      }
      record();
      if (runAct[2] === "authorise") {
        if (!approver) return err(route, 403, "forbidden", "Authorising runs needs gate-approval permission");
        if (body.decision === "reject") {
          if (!String(body.comment ?? "").trim()) return err(route, 422, "validation_error", "Say why this run shouldn't go ahead.");
          Object.assign(r, { status: "rejected", authorisation: { decision: "reject", by: ME, at: NOW, comment: body.comment, self_authorised: false } });
        } else Object.assign(r, { status: "queued", authorisation: { decision: "approve", by: ME, at: NOW, comment: null, self_authorised: false } });
        r.permissions = perms(q, r.requested_by?.id === "u", r.status);
        return json(route, 200, r);
      }
      if (runAct[2] === "cancel") {
        const withdrawn = !r.started_at;
        Object.assign(r, { status: "cancelled", cancelled_by: ME, finished_at: NOW });
        r.permissions = perms(q, r.requested_by?.id === "u", r.status);
        return json(route, 200, { message: withdrawn ? "Request withdrawn. Nothing ran." : `${r.key} cancelled.`, run: r });
      }
      const again = waitingRun(q, { key: "RUN-0006", id: "run-0006", requested_by: ME, notes: `Re-run of ${r.key}` } as Partial<RunDetail>);
      q.runs = [again, ...q.runs];
      return json(route, 201, again);
    }
    if (/^\/execution-runs\/[^/]+\/live\/w\d+\/frame$/.test(path)) return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "image/png" }, body: PNG });

    // ---- results and evidence
    const res = path.match(/^\/projects\/p1\/execution-results\/by-key\/([^/]+)$/);
    if (res) {
      const r = q.results.find((x) => x.key === res[1]);
      return r ? json(route, 200, r) : err(route, 404, "not_found", `We couldn't find ${res[1]} in this project.`);
    }
    const recl = path.match(/^\/execution-results\/([^/]+)\/classification$/);
    if (recl) {
      record();
      if (!String(body.reason ?? "").trim()) return err(route, 422, "validation_error", "Say why you think the cause is different.");
      const r = q.results.find((x) => x.id === recl[1])!;
      const prev = r.analysis!;
      r.analysis = { ...prev, classification: body.classification as never, label: "Element not found", overridden: { by: "u", by_user: ME, at: NOW, reason: String(body.reason), previous: { classification: prev.classification, confidence: prev.confidence, label: prev.label } } };
      return json(route, 200, { message: "Cause changed to Element not found.", result: r });
    }
    const heal = path.match(/^\/execution-results\/([^/]+)\/heal-suggestions\/(\d+)\/accept$/);
    if (heal) {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const r = q.results.find((x) => x.id === heal[1])!;
      const n = Number(heal[2]);
      r.heal_suggestions = r.heal_suggestions.map((h) => ({ ...h, accepted: { n, by: "u", version: 2 }, asset_version: 2 }));
      return json(route, 200, { message: "ContactPage.ts version 2 created. Validate it before the next run.", asset: { id: "as1", path: "pages/ContactPage.ts", version: 2 }, scripts_to_validate: ["TC-0040"], result: r });
    }
    const ev = path.match(/^\/evidence\/([^/]+)\/content$/);
    if (ev) {
      if (ev[1] === "ev-console") return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "text/plain" }, body: "[14:18:01] log: page ready\n[14:18:02] error: <script>window.__pwned=1</script> failed" });
      if (ev[1] === "ev-net")
        return route.fulfill({
          status: 200,
          headers: { ...CORS, "Content-Type": "text/plain" },
          body: "[14:18:01] HTTP 200 GET http://localhost:4100/contact\n[14:18:03] HTTP 200 POST http://localhost:4100/contact\n[14:18:03] BLOCKED by policy https://cdn.evil.example/x.js (not an approved site)",
        });
      return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": ev[1] === "ev-shot" ? "image/png" : "application/octet-stream" }, body: PNG });
    }

    // ---- defects
    if (path === "/projects/p1/defects" && method === "GET") {
      const status = url.searchParams.get("status") ?? "open";
      const counts = Object.fromEntries((["draft", "confirmed", "rejected", "fixed", "verified", "closed"] as DefectStatus[]).map((s) => [s, q.defects.filter((d) => d.status === s).length]));
      return json(route, 200, { items: listOf(q, status), counts, finished_runs: q.runs.filter((r) => r.finished_at).length, permissions: { can_raise: member, can_decide: approver } });
    }
    if (path === "/projects/p1/defects" && method === "POST") {
      record();
      if (!String(body.summary ?? "").trim()) return err(route, 422, "validation_error", "Add a summary.", [{ field: "body.summary", message: "Add a summary." }]);
      const d = defect(q, "DEF-0005", "draft", String(body.summary), { source: "user", actual: String(body.actual ?? "") });
      q.defects.push(d);
      return json(route, 201, withActions(q, d));
    }
    const dk = path.match(/^\/projects\/p1\/defects\/by-key\/([^/]+)$/);
    if (dk) {
      const d = q.defects.find((x) => x.key === dk[1]);
      return d ? json(route, 200, withActions(q, d)) : err(route, 404, "not_found", `We couldn't find ${dk[1]} in this project.`);
    }
    const ds = path.match(/^\/defects\/([^/]+)\/status$/);
    if (ds) {
      record();
      const d = q.defects.find((x) => x.id === ds[1])!;
      const action = String(body.action);
      if (["confirm", "reject", "verified"].includes(action) && !approver) return err(route, 403, "forbidden", "Confirming or rejecting defects needs gate-approval permission");
      const to: Record<string, DefectStatus> = { confirm: "confirmed", reject: "rejected", fixed: "fixed", verified: "verified", closed: "closed" };
      d.status = to[action];
      if (action === "confirm" || action === "reject") d.g8 = { decision: action === "confirm" ? "approve" : "reject", by: ME, at: NOW, comment: (body.comment as string) ?? null };
      if (action === "reject") Object.assign(d, { status_reason: body.reason, status_comment: body.comment });
      const verb: Record<string, string> = { confirm: "confirmed", reject: "rejected", fixed: "marked fixed. Re-run TC-0019 to verify", verified: "verified", closed: "closed" };
      return json(route, 200, { message: `${d.key} ${verb[action]}.`, defect: withActions(q, d) });
    }
    if (path === "/projects/p1/defects/bulk-status") {
      record();
      const ids = (body.ids as string[]) ?? [];
      const action = String(body.action);
      const to: Record<string, DefectStatus> = { confirm: "confirmed", reject: "rejected", fixed: "fixed", closed: "closed" };
      const done: string[] = [];
      for (const d of q.defects.filter((x) => ids.includes(x.id))) {
        if (withActions(q, d).actions[action as "confirm"] === null) {
          d.status = to[action];
          done.push(d.key);
        }
      }
      const skipped = ids.length - done.length;
      return json(route, 200, { done, skipped: [], message: `${done.length} defect${done.length === 1 ? "" : "s"} ${action === "confirm" ? "confirmed" : action === "reject" ? "rejected" : action === "fixed" ? "marked fixed" : "closed"}.${skipped ? ` ${skipped} skipped.` : ""}` });
    }
    if (/^\/defects\/[^/]+$/.test(path) && method === "DELETE") return err(route, 405, "method_not_allowed", "Defects can't be deleted. Reject or close it instead; the history stays.");
    return route.fallback();
  });
}

// ---- Traceability with Phase 4 data (design P4 §12) ----------------------------------------------------------

const tref = (type: string, key: string, label = key) => ({ type, id: key.toLowerCase(), key, label, path: `/projects/p1/x/${key}` });

/** Coverage, gaps, matrix and chain once tests have run: one failed with a draft defect, one flaky. */
export async function mockTraceP4(page: Page) {
  const exec19 = {
    script: { file: "TC-0019.spec.ts", version: 1, state: "valid" },
    result: { status: "failed", run_key: "RUN-0003", result_key: "RUN-0003-01", at: NOW },
    defects: [{ ...tref("defect", "DEF-0001", "DEF-0001 · Contact form accepts an empty Message"), status: "draft", severity: "major" }],
  };
  const exec20 = { script: { file: "TC-0020.spec.ts", version: 1, state: "valid" }, result: null, defects: [] };
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
        test_cases: { by_status: { approved: 3 }, orphans: 0 },
        execution: { executed: true, requirements: { approved: 2, with_result: 1 }, results: { tests: 2, passed: 0, failed: 1, flaky: 1, error: 0, blocked: 0, skipped: 0 }, automation: { approved_cases: 3, with_valid_script: 2 } },
      });
    if (path.endsWith("/gaps"))
      return json(route, 200, {
        requirements_without_test_cases: { none: [], none_approved: [] },
        test_cases_without_requirements: [],
        acceptance_criteria_without_test_cases: [],
        untested_high_risk: { open: [], accepted: [] },
        features_without_requirements: [],
        requirements_without_execution_evidence: { executed: true, automated_not_run: [tref("requirement", "REQ-0002", "Message is optional")], manual_only: [] },
        failed_tests: [{ case: tref("test_case", "TC-0019"), status: "failed", run_key: "RUN-0003", result_key: "RUN-0003-01", classification: "application_defect", label: "Likely bug in the application" }],
        flaky_tests: [{ case: tref("test_case", "TC-0022"), status: "flaky", run_key: "RUN-0003", result_key: "RUN-0003-04", classification: "flaky", label: "Flaky" }],
        outdated_automation_scripts: [],
        defects_without_regression_coverage: [{ defect: exec19.defects[0], case: tref("test_case", "TC-0019") }],
      });
    if (path.endsWith("/chain"))
      return json(route, 200, {
        root: { ...exec19.defects[0], label: "DEF-0001 · Draft" },
        upstream: [
          { type: "requirement", items: [tref("requirement", "REQ-0006", "Message is required")] },
          { type: "test_case", items: [tref("test_case", "TC-0019", "TC-0019 · Approved")] },
          { type: "automation_script", items: [{ ...tref("automation_script", "tests/contact/TC-0019.spec.ts", "TC-0019.spec.ts v1 · Valid"), path: "/projects/p1/automation?view=scripts&file=tests/contact/TC-0019.spec.ts" }] },
          { type: "execution_result", items: [tref("execution_result", "RUN-0003-01", "RUN-0003-01 · Failed · Chromium desktop")] },
        ],
        downstream: [],
        later_phase: [],
      });
    const backward = url.searchParams.get("view") === "backward";
    return json(route, 200, {
      next_cursor: null,
      items: backward
        ? [{ test_case: tref("test_case", "TC-0019", "Send the contact form with an empty Message"), status: "approved", conditions: [], acceptance_criteria: [], requirements: [tref("requirement", "REQ-0006")], risks: [], ...exec19 }]
        : [
            {
              requirement: tref("requirement", "REQ-0006", "Message is required"),
              requirement_status: "approved",
              risk: null,
              acceptance_criteria: [],
              conditions: [],
              test_cases: [
                { case: tref("test_case", "TC-0019"), status: "approved", priority: "high", ...exec19 },
                { case: tref("test_case", "TC-0020"), status: "approved", priority: "medium", ...exec20 },
              ],
              automation: [{ case_key: "TC-0019", ...exec19.script }, { case_key: "TC-0020", ...exec20.script }],
              results: [{ case_key: "TC-0019", ...exec19.result }],
              defects: exec19.defects,
            },
          ],
    });
  });
}

// ---- Reports (design P4 §13) --------------------------------------------------------------------------------

export async function mockReportsP4(page: Page) {
  const base = { formats: ["json", "html", "pdf", "csv"], generated_by: "rules", created_at: NOW, status: "ready", frozen: true, is_latest_source: true, stage_run_version: null };
  const exec = { ...base, id: "rep-exec", report_type: "execution", version: 1, run_key: "RUN-0003", approval: { gate: "G7", status: "approved", approved_by: null, approved_at: null } };
  const def = { ...base, id: "rep-def", report_type: "defect", version: 1, run_key: null, frozen: false, approval: { gate: "G8", status: "draft", approved_by: null, approved_at: null } };
  const content: Record<string, unknown> = {
    "rep-exec": {
      report_type: "execution",
      basis: "run",
      run: { key: "RUN-0003", status: "failed", selection: "Regression", browsers: ["chromium"], viewports: ["desktop"], started_at: NOW, finished_at: NOW, duration_ms: 252000, authorised: true, sizes: ["Desktop 1440 × 900"], workers: 2, retries: 1, requested_by: "Mo Plainmember", requested_at: NOW, authorised_by: "Avery Approver", authorised_at: NOW, self_authorised: false },
      totals: { passed: 1, failed: 1, flaky: 1, error: 0, blocked: 1, skipped: 0, tests: 4 },
      results: [
        { result_key: "RUN-0003-01", run_key: "RUN-0003", case_key: "TC-0019", title: "Send the contact form with an empty Message", browser: "Chromium", size: "Desktop 1440 × 900", status: "failed", failed_step: "Press Send message", cause: { label: "Likely bug in the application", set_by_person: false }, defect: { key: "DEF-0001", occurrence: 2 } },
        { result_key: "RUN-0003-04", run_key: "RUN-0003", case_key: "TC-0022", title: "Open the home page", browser: "Chromium", size: "Desktop 1440 × 900", status: "flaky", failed_step: null, cause: { label: "Flaky", set_by_person: true } },
      ],
      defects: [{ key: "DEF-0001", summary: "Contact form accepts an empty Message", status: "confirmed", severity: "major", raised_here: false }],
      summary: "4 test result(s): 1 passed, 1 failed, 1 flaky, 0 error, 1 blocked, 0 skipped.",
      flaky_note: "Flaky tests passed only on a retry. They are counted separately, never as passed.",
      not_automated: [{ case_key: "TC-0005", title: "Send the contact form and check the company receives it", reasons: ["Step 5's expected result 'sent to the company' needs human judgement"] }],
      limitations: ["Tests ran in a separate process with a cleaned environment, resource limits and a network policy that only allows the approved site. It is not a container: memory limits aren't enforced on every server.", "Not run in Firefox or WebKit, so this report says nothing about those browsers."],
    },
    "rep-def": {
      report_type: "defect",
      drafts: 2,
      summary: "4 defect(s): 2 draft, 1 confirmed, 1 fixed, 0 verified, 0 rejected, 0 closed.",
      defects: [{ key: "DEF-0001", summary: "Contact form accepts an empty Message", status: "draft", severity: "major", priority: "medium", cases: ["TC-0019"], steps: ["Open /contact", "Press Send message"], expected: "Submission is blocked", actual: "Thank you", reproducibility: "2 of 2 attempts (always)", root_cause_hypothesis: null }],
    },
  };
  await page.route(`${API}/projects/p1/reports`, (route) => (route.request().method() === "GET" ? json(route, 200, [exec, def]) : route.fallback()));
  await page.route(`${API}/reports/rep-*`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const summary = id === "rep-exec" ? exec : def;
    return json(route, 200, { ...summary, content: content[id], files: [], ai_sections: [] });
  });
}
