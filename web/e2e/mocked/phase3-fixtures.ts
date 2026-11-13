// DEVELOPMENT/TEST FIXTURES ONLY. Phase 3 stand-ins for the QA Analyst API (api-contracts.md "Phase 3
// endpoints"), layered over ./fixtures.ts and ./phase2-fixtures.ts with page.route(): Phase 3 paths are
// answered here, everything else falls back. Nothing here is imported by the product code.

import type { Page, Route } from "@playwright/test";
import type {
  ArtefactRef,
  Coverage,
  ForwardRow,
  BackwardRow,
  Gaps,
  Invitation,
  Member,
  StageKey,
  StageState,
  TestCaseDetail,
  TestCondition,
  TestDataItem,
  Workflow,
} from "../../src/lib/contract";
import { API, type MockState } from "./fixtures";
import { riskFixture, type P2State } from "./phase2-fixtures";

const NOW = "2026-11-13T10:00:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string, details: unknown = null) =>
  json(route, status, { error: { code, message, details } });

export type P3State = {
  /** `can_approve` from the server, independent of role (design check 74). */
  canApprove: boolean;
  designed: boolean;
  stale: boolean;
  g5: "none" | "pending" | "approved";
  cases: TestCaseDetail[];
  conditions: TestCondition[];
  data: TestDataItem[];
  members: Member[];
  invitations: Invitation[];
  invite: { valid: boolean; email_hint: string | null };
  requests: { method: string; path: string; body: unknown }[];
  /** A regenerated design run waiting for review (design P3 check 45). */
  pendingReview?: number;
  /** Gate 5 approved before and reopened by a change: the last decision is an approval (QA BUG-P3-18). */
  g5Reopened?: boolean;
  /** When set, creating a case answers 422 with these details (the API's validation envelope). */
  createErrors?: { field: string; message: string }[];
};

const ref = (type: ArtefactRef["type"], key: string, label = ""): ArtefactRef => ({ type, id: `id-${key}`, key, label, path: "" });
const unavailable = { available: false as const, available_from_phase: 4, message: "Available after test execution (Phase 4)" };

export function testCase(n: number, over: Partial<TestCaseDetail> = {}): TestCaseDetail {
  const key = `TC-${String(n).padStart(4, "0")}`;
  return {
    id: `tc${n}`,
    key,
    lineage_id: `tc${n}`,
    title: `Send the contact form with case ${n}`,
    technique: "boundary_value_analysis",
    test_type: "functional",
    test_level: "system",
    status: "draft",
    priority: "high",
    derived_priority: "high",
    priority_overridden: false,
    risk_level: "high",
    risk_score: 12,
    suites: [],
    requirement_keys: ["REQ-0001"],
    lint_summary: { errors: 0, warnings: 0, blocks_approval: false },
    expected_result_status: "defined",
    execution_status: "not_run",
    last_result: null,
    stage_run_version: 1,
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    provenance: "observed",
    classification: "observed",
    confidence: 0.9,
    evidence_refs: [],
    generated_by: "rules",
    risk_key: "RISK-001",
    feature: ref("feature", "FEAT-001", "Contact form"),
    condition_key: "TCOND-0001",
    objective: "Check that the Name field enforces its maximum length.",
    preconditions: ["The contact page is open"],
    steps: [
      { n: 1, action: "Enter the test value in Name", data: [ref("test_data", "TD-0001", "Name, 41 characters")], expected: "Name shows the value" },
      { n: 2, action: "Press Send message", data: [], expected: "The form is not sent and Name shows an error" },
    ],
    expected_result: "The form is not sent and Name shows a length error.",
    open_question: null,
    condition: ref("test_condition", "TCOND-0001", "Name length"),
    design_basis: { technique: "boundary_value_analysis", coverage_item: "len:41", coverage_item_label: "41 characters", explanation: "maxlength=40 was observed on Name." },
    requirements: [ref("requirement", "REQ-0001", "Contact form validates field 1")],
    acceptance_criteria: [ref("acceptance_criterion", "AC-0001")],
    risks: [ref("risk", "RISK-001", "Contact form loses messages")],
    test_data: [],
    side_effects: ["submits_form"],
    automation_suitability: { value: "suitable", reason: "Deterministic UI checks", assessed: "preliminary" },
    priority_source: { kind: "risk", risk: ref("risk", "RISK-001", "Contact form loses messages"), override_reason: null, overridden_by: null },
    lint: [],
    evidence: [],
    source: "design",
    rule_id: "BVA-MAX",
    status_comment: null,
    status_changed_by: null,
    status_changed_at: null,
    created_at: NOW,
    updated_by: null,
    ...over,
  } as TestCaseDetail;
}

function condition(): TestCondition {
  return {
    id: "cond1",
    key: "TCOND-0001",
    lineage_id: "cond1",
    title: "Name length",
    description: "Name accepts 1 to 40 characters.",
    technique: "boundary_value_analysis",
    test_type: "functional",
    feature: ref("feature", "FEAT-001", "Contact form"),
    requirements: [ref("requirement", "REQ-0001")],
    acceptance_criteria: [],
    design_basis: { constraint: "maxlength=40", values: [{ coverage_item: "len:41", value: "41 characters", tests: "41 characters (max + 1)", expected: "rejected" }] },
    // As built: coverage item ids are raw ("len:41"); people see the label.
    coverage_items: [{ id: "len:41", label: "41 characters (max + 1)", covered_by: ["TC-0001"] }],
    notes: [],
    status: "draft",
    rule_id: "BVA-MAX",
    stage_run_version: 1,
    provenance: "observed",
    confidence: 0.9,
    evidence_refs: [],
    generated_by: "rules",
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    updated_by: null,
  } as TestCondition;
}

function dataItem(): TestDataItem {
  return {
    id: "td1",
    key: "TD-0001",
    lineage_id: "td1",
    name: "Name, 41 characters",
    field_label: "Name",
    feature: ref("feature", "FEAT-001", "Contact form"),
    kind: "boundary",
    value_type: "text",
    value: "a".repeat(41),
    secret_ref: null,
    length: 41,
    boundary: { condition: ref("test_condition", "TCOND-0001"), coverage_item: "len:41", coverage_item_label: "41 characters" },
    synthetic: true,
    generator: "rules",
    status: "active",
    used_by_count: 1,
    generated_by: "rules",
    form: { label: "Contact us form", path: "/contact" },
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    updated_by: null,
  } as TestDataItem;
}

function member(n: number, role: Member["role"], over: Partial<Member> = {}): Member {
  const names = ["Owner Person", "Ana Lee", "Sam Patel", "Kim Ito"];
  return {
    membership_id: `m${n}`,
    user: { id: `u${n}`, full_name: names[n - 1] ?? `User ${n}` },
    email: `user${n}@example.com`,
    role,
    can_approve: role === "owner" || role === "admin",
    joined_at: NOW,
    invited_by: null,
    is_you: n === 1,
    version: 1,
    ...over,
  };
}

export function newP3(over: Partial<P3State> = {}): P3State {
  return {
    canApprove: true,
    designed: true,
    stale: false,
    g5: "pending",
    cases: [
      testCase(1),
      testCase(2, { title: "Send the form with an empty Name", technique: "equivalence_partitioning", priority: "critical", derived_priority: "critical", risk_level: "very_high", status: "approved" }),
      testCase(3, {
        title: "Message is optional",
        expected_result_status: "open_question",
        lint_summary: { errors: 0, warnings: 1, blocks_approval: true },
        lint: [{ code: "open_question", severity: "warning", blocks_approval: true, message: "Expected result not decided", path: "expected_result", hint: null }],
        // As built: the question text has no "Not decided:" prefix (the web adds it once), the submit step and the
        // overall expected result hold the question, and generated setup steps have no expected result.
        open_question: { requirement: ref("requirement", "REQ-0002"), message: "REQ-0002 asks whether Message is optional" },
        expected_result: "REQ-0002 asks whether Message is optional",
        steps: [
          { n: 1, action: "Open /contact", data: [], expected: "" },
          { n: 2, action: "Type a name in Name", data: [ref("test_data", "TD-0001", "Name, 41 characters")], expected: "" },
          { n: 3, action: "Leave Message empty and press Send message", data: [], expected: "REQ-0002 asks whether Message is optional" },
        ],
        requirement_keys: ["REQ-0002"],
        requirements: [ref("requirement", "REQ-0002")],
      }),
      testCase(4, { status: "rejected", title: "Duplicate of TC-0001" }),
    ],
    conditions: [condition()],
    data: [dataItem()],
    members: [member(1, "owner"), member(2, "admin"), member(3, "member"), member(4, "viewer")],
    invitations: [
      { id: "inv1", email: "new.member@example.com", role: "member", can_approve: false, status: "pending", invited_by: { id: "u1", full_name: "Owner Person" }, created_at: NOW, expires_at: "2026-11-20T10:00:00Z", accepted_at: null },
    ],
    invite: { valid: true, email_hint: "ne***@example.com" },
    requests: [],
    ...over,
  };
}

function st(key: StageKey, phase: number, over: Partial<StageState> = {}): StageState {
  return { key, title: key.replace(/_/g, " "), phase, available: phase <= 3, status: "not_started", current_version: null, gate: null, started_at: null, finished_at: null, stale_reason: null, progress: null, ...over };
}

function workflow(q: P3State): Workflow {
  const g5Gate =
    q.g5 === "none"
      ? null
      : { key: "G5" as const, policy: "required", status: q.g5, recommendation: null, changes_since_approval: q.g5Reopened ? 1 : 0, decision: q.g5Reopened ? { decision: "approve" as const } : null };
  const designStatus = !q.designed ? "not_started" : q.stale ? "stale" : q.g5 === "approved" ? "approved" : "awaiting_approval";
  return {
    project_status: "active",
    stages: [
      st("intake", 1, { status: "completed" }),
      st("discovery", 1, { status: "approved", current_version: 1, gate: { key: "G2", policy: "recommended", status: "approved", recommendation: null } }),
      st("discovery_report", 1, { status: "completed", current_version: 1 }),
      st("requirements", 2, { status: "completed", current_version: 1 }),
      st("readiness_criteria", 2, { status: "approved", current_version: 1, gate: { key: "G3", policy: "required", status: "approved", recommendation: null } }),
      st("test_strategy", 2, { status: "approved", current_version: 2, gate: { key: "G4", policy: "required", status: "approved", recommendation: null } }),
      st("test_design", 3, {
        status: designStatus,
        current_version: q.designed ? 2 : null,
        gate: q.designed ? g5Gate : null,
        finished_at: q.designed ? NOW : null,
        pending_review: q.pendingReview ? { version: q.pendingReview, created_at: NOW, summary: { added: 1 } } : null,
      }),
      st("traceability", 3, { status: q.designed ? "completed" : "not_started", current_version: q.designed ? 2 : null }),
      ...(["automation_assessment", "automation", "execution", "failure_analysis", "defects_summary", "release_readiness", "performance"] as StageKey[]).map((k, i) => st(k, i < 4 ? 4 : 5)),
    ],
  };
}

function summary(c: TestCaseDetail) {
  const { objective, preconditions, steps, expected_result, open_question: _oq, condition: _c, design_basis, requirements, acceptance_criteria, risks, test_data, side_effects, automation_suitability, priority_source, lint, evidence, ...rest } = c;
  void [objective, preconditions, steps, expected_result, _oq, _c, design_basis, requirements, acceptance_criteria, risks, test_data, side_effects, automation_suitability, priority_source, lint, evidence];
  // As built the summary carries the open question (requirement + message) and the objective.
  return { ...rest, objective, open_question: _oq ? { requirement: _oq.requirement, message: _oq.message } : null };
}

function stats(q: P3State) {
  const by_status: Record<string, number> = {};
  for (const c of q.cases) by_status[c.status] = (by_status[c.status] ?? 0) + 1;
  return {
    stage_run_version: 2,
    generated_by: "rules",
    total: q.cases.length,
    by_status,
    by_technique: { boundary_value_analysis: 2, equivalence_partitioning: 1 },
    by_type: { functional: q.cases.length },
    by_level: { system: q.cases.length },
    by_priority: { high: 2, critical: 1 },
    by_suite: {},
    lint: { errors: 0, warnings: 1, cases_blocked: 1 },
    open_questions: q.cases.filter((c) => c.expected_result_status === "open_question" && c.status !== "rejected").length,
    not_designed: [{ test_type: "performance", reason: "Performance testing needs a load environment (Phase 4)." }],
    execution: unavailable,
    pending_review_version: null,
    conditions: { total: 1, complete: 1 },
  };
}

export function coverage(): Coverage {
  return {
    basis: "current",
    design_version: 2,
    snapshot_hash: null,
    requirements: { approved: 2, with_case: 2, with_approved_case: 1, percent_approved_covered: 50 },
    acceptance_criteria: { approved: 1, covered: 1, percent: 100 },
    high_risk_requirements: { total: 1, with_approved_case: 1 },
    techniques: [{ condition: ref("test_condition", "TCOND-0001"), technique: "boundary_value_analysis", items: 1, covered: 1 }],
    test_cases: { by_status: { approved: 1, draft: 2, rejected: 1 }, orphans: 0 },
    execution: unavailable,
  };
}

export function gaps(): Gaps {
  return {
    requirements_without_test_cases: { none: [], none_approved: [ref("requirement", "REQ-0002", "Message is optional")] },
    test_cases_without_requirements: [],
    acceptance_criteria_without_test_cases: [],
    untested_high_risk: { open: [], accepted: [] },
    features_without_requirements: [],
    requirements_without_execution_evidence: unavailable,
    failed_tests: unavailable,
    outdated_automation_scripts: unavailable,
    defects_without_regression_coverage: unavailable,
  };
}

function forward(q: P3State): ForwardRow[] {
  return ["REQ-0001", "REQ-0002"].map((k, i) => ({
    requirement: ref("requirement", k, `Contact form validates field ${i + 1}`),
    requirement_status: "approved",
    risk: i === 0 ? { level: "high", risks: [ref("risk", "RISK-001")] } : null,
    acceptance_criteria: [{ ac: ref("acceptance_criterion", `AC-000${i + 1}`), covered: i === 0 }],
    conditions: i === 0 ? [{ ...ref("test_condition", "TCOND-0001"), technique: "boundary_value_analysis" as const }] : [],
    test_cases: q.cases.filter((c) => c.requirement_keys.includes(k) && c.status !== "rejected").map((c) => ({ case: ref("test_case", c.key, c.title), status: c.status, priority: c.priority })),
    automation: unavailable,
    results: unavailable,
    defects: unavailable,
  }));
}

function backward(q: P3State): BackwardRow[] {
  return q.cases.map((c) => ({ test_case: ref("test_case", c.key, c.title), status: c.status, conditions: c.condition ? [c.condition] : [], acceptance_criteria: c.acceptance_criteria, requirements: c.requirements, risks: c.risks, priority: c.priority, technique: c.technique }));
}

/** Registers the Phase 3 routes. `p2` supplies the role (and requests log for the requirement paths). */
export async function mockPhase3(page: Page, s: MockState, p2: P2State, q: P3State) {
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = req.method();
    if (method === "OPTIONS") return route.fallback();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const record = () => q.requests.push({ method, path: `${path}${url.search}`, body });

    if (path === "/auth/me" && s.user) return json(route, 200, { user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: p2.role, can_approve: q.canApprove });
    if (path === "/projects/p1/workflow") return json(route, 200, workflow(q));

    // ---- test cases
    if (path === "/projects/p1/test-cases" && method === "GET") {
      const term = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = q.designed ? q.cases.filter((c) => !term || c.title.toLowerCase().includes(term) || c.steps.some((x) => x.action.toLowerCase().includes(term))).map(summary) : [];
      return json(route, 200, { items, next_cursor: null });
    }
    if (path === "/projects/p1/test-cases" && method === "POST") {
      record();
      if (q.createErrors) return err(route, 422, "validation_error", q.createErrors.length === 1 ? q.createErrors[0].message : "Some fields need attention", q.createErrors);
      const c = testCase(q.cases.length + 1, { title: String(b.title), source: "user", generated_by: "human" });
      q.cases.push(c);
      return json(route, 201, c);
    }
    if (path === "/projects/p1/test-cases/stats") return q.designed ? json(route, 200, stats(q)) : err(route, 404, "not_found", "No test design yet");
    const byKey = path.match(/^\/projects\/p1\/test-cases\/by-key\/([^/]+)$/);
    if (byKey) {
      const c = q.cases.find((x) => x.key === decodeURIComponent(byKey[1]));
      return c ? json(route, 200, c) : err(route, 404, "not_found", "Not found");
    }
    if (path === "/projects/p1/test-cases/bulk-status") {
      record();
      const ids = (b.ids as string[]) ?? [];
      const updated = q.cases.filter((c) => ids.includes(c.id)).map((c) => Object.assign(c, { status: b.status, version: c.version + 1 }));
      return json(route, 200, { updated: updated.map(summary), skipped: [] });
    }
    const tcm = path.match(/^\/test-cases\/([^/]+)(\/[a-z]+)?$/);
    if (tcm) {
      const c = q.cases.find((x) => x.id === tcm[1]);
      if (!c) return err(route, 404, "not_found", "Not found");
      if (!tcm[2] && method === "GET") return json(route, 200, c);
      if (tcm[2] === "/revisions") return json(route, 200, [{ version: 1, changed_by: null, change_reason: null, source: "system", created_at: NOW, changes: {}, snapshot: {} }]);
      record();
      if (!tcm[2] && method === "PATCH") {
        if (b.version !== c.version) return err(route, 409, "conflict", "Changed since you opened it");
        const { version: _v, change_reason: _r, steps: st, ...rest } = b;
        void [_v, _r];
        if (Array.isArray(st)) Object.assign(c, { steps: (st as { action: string; expected: string }[]).map((x, i) => ({ n: i + 1, action: x.action, data: [], expected: x.expected })) });
        Object.assign(c, rest, { version: c.version + 1, human_edited: true });
        // Writing the expected result clears the open question (D6), as the API does.
        if (c.expected_result_status === "open_question" && typeof b.expected_result === "string" && b.expected_result.trim())
          Object.assign(c, { expected_result_status: "defined", open_question: null, lint: [], lint_summary: { errors: 0, warnings: 0, blocks_approval: false }, generated_by: "human" });
        return json(route, 200, c);
      }
      if (tcm[2] === "/status") Object.assign(c, { status: b.status, version: c.version + 1 });
      if (tcm[2] === "/lock") Object.assign(c, { locked: b.locked ?? !c.locked });
      return json(route, 200, c);
    }
    if (path === "/projects/p1/test-conditions") return json(route, 200, { items: q.designed ? q.conditions : [], next_cursor: null });
    if (path === "/projects/p1/test-data") return json(route, 200, { items: q.designed ? q.data : [], next_cursor: null });
    if (path === "/projects/p1/test-design/lint")
      return json(route, 200, { rules_version: "1", errors: 0, warnings: 1, by_code: { open_question: 1 }, cases: q.cases.filter((c) => c.lint.length).map((c) => ({ key: c.key, items: c.lint })) });
    if (path === "/projects/p1/stages/test_design/runs")
      return json(route, 200, q.designed ? [{ version: 2, status: "completed", generated_by: "rules", created_at: NOW, finished_at: NOW, review_status: "applied" }] : []);
    if (path.match(/^\/projects\/p1\/stages\/test_design\/runs\/\d+$/))
      return json(route, 200, { version: 2, status: "completed", generated_by: "rules", partial: false, upstream_versions: { requirements: 1, test_strategy: 2 }, validation_issues: [], output: {}, decisions: [] });
    if (path === "/projects/p1/stages/test_design/run") {
      record();
      return json(route, 202, workflow(q).stages[6]);
    }
    if (path === "/projects/p1/gates/G5/decision") {
      record();
      if (b.decision === "approve") q.g5 = "approved";
      return json(route, 200, workflow(q).stages[6]);
    }

    // ---- traceability
    if (path === "/projects/p1/traceability/coverage") return json(route, 200, { ...coverage(), basis: url.searchParams.get("basis") ?? "current" });
    if (path === "/projects/p1/traceability/gaps") return json(route, 200, gaps());
    if (path === "/projects/p1/traceability")
      return json(route, 200, { items: url.searchParams.get("view") === "backward" ? backward(q) : forward(q), next_cursor: null });
    if (path === "/projects/p1/traceability/chain") {
      const key = url.searchParams.get("key");
      const c = q.cases.find((x) => x.key === key);
      if (!c) return err(route, 404, "not_found", "Not found");
      return json(route, 200, {
        root: ref("test_case", c.key, c.title),
        upstream: [
          { type: "test_condition", items: c.condition ? [c.condition] : [] },
          { type: "acceptance_criterion", items: c.acceptance_criteria },
          { type: "requirement", items: c.requirements },
          { type: "risk", items: c.risks },
        ],
        downstream: [],
        later_phase: [
          { type: "automation_script", status: unavailable },
          { type: "execution_result", status: unavailable },
          { type: "defect", status: unavailable },
        ],
      });
    }

    // ---- risks with Phase 3 coverage
    if (path === "/projects/p1/risks")
      return json(route, 200, {
        items: [
          riskFixture(1, { coverage: { requirements: 1, test_cases: 3, approved_test_cases: 2, uncovered_requirement_keys: [] } }),
          riskFixture(2, { likelihood: 2, impact: 2, score: 4, level: "low", coverage: { requirements: 1, test_cases: 1, approved_test_cases: 0, uncovered_requirement_keys: ["REQ-0002"] } }),
        ],
        next_cursor: null,
      });

    // ---- members and invitations
    if (path === "/organisation/members" && method === "GET") {
      const manage = p2.role === "owner" || p2.role === "admin";
      return json(route, 200, { items: q.members.map((m) => ({ ...m, email: manage ? m.email : null })), next_cursor: null });
    }
    const mm = path.match(/^\/organisation\/members\/([^/]+)$/);
    if (mm) {
      record();
      const m = q.members.find((x) => x.membership_id === mm[1]);
      if (!m) return err(route, 404, "not_found", "Not found");
      if (method === "DELETE") {
        q.members = q.members.filter((x) => x !== m);
        return route.fulfill({ status: 204, headers: CORS, body: "" });
      }
      Object.assign(m, "role" in b ? { role: b.role } : {}, "can_approve" in b ? { can_approve: b.can_approve } : {}, { version: (m.version ?? 1) + 1 });
      if (m.role === "owner") m.can_approve = true;
      return json(route, 200, m);
    }
    if (path === "/organisation/invitations" && method === "GET") return json(route, 200, q.invitations);
    if (path === "/organisation/invitations" && method === "POST") {
      record();
      if (String(b.email).includes("taken")) return err(route, 409, "conflict", "This email already has an account");
      const inv: Invitation = { id: `inv${q.invitations.length + 1}`, email: String(b.email), role: b.role as Invitation["role"], can_approve: !!b.can_approve, status: "pending", invited_by: { id: "u1", full_name: "Owner Person" }, created_at: NOW, expires_at: "2026-11-20T10:00:00Z", accepted_at: null };
      q.invitations.push(inv);
      return json(route, 201, { invitation: inv, link: "/invite/tok-secret-123" });
    }
    const rv = path.match(/^\/organisation\/invitations\/([^/]+)\/revoke$/);
    if (rv) {
      record();
      const inv = q.invitations.find((x) => x.id === rv[1])!;
      inv.status = "revoked";
      return json(route, 200, inv);
    }
    const it = path.match(/^\/invitations\/([^/]+)(\/accept)?$/);
    if (it) {
      if (!q.invite.valid) return err(route, 404, "not_found", "This invitation is no longer valid");
      if (!it[2]) return json(route, 200, { organisation_name: "Acme QA", invited_by_name: "Owner Person", role: "member", email_hint: q.invite.email_hint, expires_at: "2026-11-20T10:00:00Z" });
      record();
      s.user = { id: "u9", email: "new.member@example.com", full_name: String(b.full_name) } as MockState["user"];
      return json(route, 201, { token: "tok-new", expires_at: "2026-12-13T10:00:00Z", user: s.user, organisation: { id: "o1", name: "Acme QA", slug: "acme" }, role: "member", can_approve: false });
    }

    // ---- reports
    const rows = [
      { id: "r1", report_type: "discovery", version: 1, status: "ready", formats: ["pdf", "html"], generated_by: "rules", created_at: NOW, scan_id: "scan1", scan_number: 1, is_latest_scan: true, approval_status: "approved" },
      ...(q.designed
        ? [
            { id: "tcs1", report_type: "test_case_spec", version: 1, status: "ready", formats: ["pdf", "html", "csv"], generated_by: "rules", created_at: NOW, approval: { gate: "G5", status: q.g5 === "approved" ? "approved" : "draft", approved_by: q.g5 === "approved" ? { id: "u1", full_name: "Owner Person" } : null, approved_at: q.g5 === "approved" ? NOW : null }, is_latest_source: true, stage_run_version: 2 },
            { id: "rtm1", report_type: "rtm", version: 1, status: "ready", formats: ["pdf", "html", "csv"], generated_by: "rules", created_at: NOW, approval: { gate: "G5", status: "draft", approved_by: null, approved_at: null }, is_latest_source: true, stage_run_version: 2 },
          ]
        : []),
    ];
    if (path === "/projects/p1/reports" && method === "GET") return json(route, 200, rows);
    if (path === "/projects/p1/reports" && method === "POST") {
      record();
      return json(route, 201, { ...rows[1], id: "tcs2", version: 2, status: "rendering" });
    }
    if (path === "/reports/tcs1") {
      const { lint: _lint, ...stored } = q.cases[0];
      void _lint;
      return json(route, 200, {
        ...rows[1],
        content: {
          project: {},
          generated_at: NOW,
          approval: rows[1] && "approval" in rows[1] ? rows[1].approval : {},
          scope_and_method: ["Designed from approved requirements with risk-based priority."],
          techniques: [{ technique: "boundary_value_analysis", definition: "", conditions: 1 }],
          counts: stats(q),
          // Stored content can drop optional lists (P2 bug class): this case has no `lint`.
          cases_by_feature: {
            "Contact form": [{ requirement: ref("requirement", "REQ-0001", "Contact form validates field 1"), cases: [stored, q.cases[2]] }],
            // As built: cases without a requirement are grouped under a null requirement (QA BUG-P3-21).
            "Not linked to a requirement": [
              { requirement: null, cases: [{ ...q.cases[0], key: "TC-0040", title: "Written by a person, no requirement", requirements: [], automation_suitability: null, design_basis: null, condition: null, steps: [{ n: 1, action: "Open /", data: [], expected: "" }] }] },
            ],
          },
          conditions: q.conditions,
          test_data: q.data,
          not_designed: stats(q).not_designed,
          execution_note: "Execution status: Not run.",
          summary: "3 test cases designed from 2 approved requirements.",
          summary_generated_by: "rules",
          disclaimer: "No tests have been run.",
        },
      });
    }
    if (path === "/reports/rtm1")
      return json(route, 200, { ...rows[2], content: { project: {}, generated_at: NOW, approval: {}, based_on: { G3: "Approved 13 Nov 2026", G4: "Approved 13 Nov 2026", G5: null }, forward: forward(q), backward: backward(q), coverage: coverage(), gaps: gaps() } });
    if (path.match(/^\/reports\/[^/]+\/download$/)) {
      record();
      return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "text/csv" }, body: "key,title\n" });
    }
    return route.fallback();
  });
}
