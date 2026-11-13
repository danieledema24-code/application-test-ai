// DEVELOPMENT/TEST FIXTURES ONLY. Phase 2 stand-ins for the QA Analyst API (api-contracts.md "Phase 2
// endpoints"), layered over ./fixtures.ts with page.route(): Phase 2 paths are answered here, everything else
// falls back to the Phase 1 mock. Nothing here is imported by the product code.

import type { Page, Route } from "@playwright/test";
import type {
  AcceptanceCriterion,
  AssistantCapabilities,
  AssistantMessage,
  ChangeReview,
  Proposal,
  ReadinessCriteria,
  ReadinessCriterion,
  RequirementDetail,
  Risk,
  SecretMeta,
  StageKey,
  StageState,
  TestPlan,
  TestStrategy,
  Thread,
  Workflow,
} from "../../src/lib/contract";
import { API, type MockState } from "./fixtures";

const NOW = "2026-11-13T10:00:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string) => json(route, status, { error: { code, message, details: null } });

export type P2State = {
  role: "owner" | "admin" | "member" | "viewer";
  aiEnabled: boolean;
  g3: "pending" | "approved" | "none";
  strategy: boolean;
  g4: "pending" | "approved" | "none";
  credentials: boolean;
  pendingReview: boolean;
  requirements: RequirementDetail[];
  risks: Risk[];
  proposals: Proposal[];
  threads: Thread[];
  requests: { method: string; path: string; body: unknown }[];
};

function ac(reqKey: string, n: number, over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id: `ac-${reqKey}-${n}`,
    key: `AC-${reqKey.slice(4)}-${n}`,
    lineage_id: `acl-${reqKey}-${n}`,
    requirement_id: `id-${reqKey}`,
    requirement_key: reqKey,
    kind: "positive",
    given: "the contact form is open",
    when: "the visitor submits an email without @",
    then: "an error says the email is invalid",
    classification: "observed",
    provenance: "observed",
    confidence: 0.9,
    evidence_refs: [],
    generated_by: "rules",
    status: "draft",
    rule_id: null,
    test_values: null,
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    updated_by: null,
    ...over,
  };
}

export function requirement(n: number, over: Partial<RequirementDetail> = {}): RequirementDetail {
  const key = `REQ-${String(n).padStart(4, "0")}`;
  return {
    id: `id-${key}`,
    key,
    lineage_id: `l-${key}`,
    title: `Contact form validates field ${n}`,
    type: "functional",
    category: "validation",
    behaviour_scope: "ui",
    classification: "observed",
    provenance: "observed",
    confidence: 0.88,
    evidence_refs: [],
    generated_by: "rules",
    source: "discovery",
    status: "draft",
    ac_count: 1,
    ac_approved: 0,
    risk_level: null,
    stage_run_version: 1,
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    description: `The contact form rejects invalid input in field ${n}.`,
    assumptions: [],
    rule_id: "form.required_field",
    related_features: [{ type: "feature", id: "f1", key: "FEAT-001", label: "Contact form", path: "/projects/p1/discovery?view=functionality" }],
    source_refs: { journey_ids: [], page_ids: [], document_ids: [] },
    acceptance_criteria: [ac(key, 1)],
    linked_test_cases: [],
    status_comment: null,
    status_changed_by: null,
    status_changed_at: null,
    validation_issues: [],
    evidence: [],
    created_at: NOW,
    updated_by: null,
    ...over,
  };
}

export function riskFixture(n: number, over: Partial<Risk> = {}): Risk {
  return {
    id: `risk-${n}`,
    key: `RISK-${String(n).padStart(3, "0")}`,
    lineage_id: `rl-${n}`,
    title: `Checkout payment fails silently ${n}`,
    description: "Payment errors may not be shown.",
    category: "product",
    requirements: [],
    features: [{ type: "feature", id: "f2", key: "FEAT-002", label: "Checkout", path: "" }],
    likelihood: 4,
    impact: 5,
    score: 20,
    level: "very_high",
    factors: [],
    likelihood_rationale: "Payment forms change often.",
    impact_rationale: "Lost orders.",
    mitigation: { test_types: ["functional", "regression"], techniques: [], notes: null },
    requires_approval: false,
    status: "open",
    status_comment: null,
    provenance: "inferred",
    confidence: 0.7,
    evidence_refs: [],
    generated_by: "rules",
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    updated_by: null,
    ...over,
  };
}

export function newP2(over: Partial<P2State> = {}): P2State {
  return {
    role: "owner",
    aiEnabled: false,
    g3: "pending",
    strategy: false,
    g4: "none",
    credentials: false,
    pendingReview: false,
    requirements: [
      requirement(1, { status: "approved", acceptance_criteria: [ac("REQ-0001", 1, { status: "approved" })], ac_approved: 1 }),
      requirement(2),
      requirement(3, { classification: "assumed", provenance: "assumed", confidence: 0.4, source: "user", generated_by: "human", ac_count: 0, acceptance_criteria: [] }),
      requirement(4, { status: "rejected", status_comment: "Duplicate of REQ-0001" }),
    ],
    risks: [riskFixture(1), riskFixture(2, { likelihood: 2, impact: 2, score: 4, level: "low", mitigation: { test_types: [], techniques: [], notes: null } })],
    proposals: [],
    threads: [],
    requests: [],
    ...over,
  };
}

function st(key: StageKey, phase: number, over: Partial<StageState> = {}): StageState {
  return { key, title: key.replace(/_/g, " "), phase, available: phase <= 2, status: "not_started", current_version: null, gate: null, started_at: null, finished_at: null, stale_reason: null, progress: null, ...over };
}

function workflow(p: P2State): Workflow {
  const g3Gate = p.g3 === "none" ? null : { key: "G3" as const, policy: "required", status: p.g3, recommendation: { recommend: "proceed_with_caution" as const, reasons: ["Resolve the requirements without acceptance criteria, then approve."], generated_by: "rules" as const }, changes_since_approval: p.g3 === "pending" ? 2 : 0 };
  // A Very high risk without a test type is a hard blocker on G4 (the server refuses approval).
  const g4Gate = p.g4 === "none" ? null : { key: "G4" as const, policy: "required", status: p.g4, recommendation: { recommend: "proceed_with_caution" as const, reasons: ["Add a test type for the Very high risk."], generated_by: "rules" as const } };
  return {
    project_status: "active",
    stages: [
      st("intake", 1, { status: "completed" }),
      st("discovery", 1, { status: "approved", current_version: 1, gate: { key: "G2", policy: "recommended", status: "approved", recommendation: null } }),
      st("discovery_report", 1, { status: "completed", current_version: 1 }),
      st("requirements", 2, { status: "completed", current_version: 1, pending_review: p.pendingReview ? { version: 2, created_at: NOW, summary: { added: 1 } } : null }),
      st("readiness_criteria", 2, { status: p.g3 === "approved" ? "approved" : "awaiting_approval", current_version: 1, gate: g3Gate, finished_at: NOW }),
      st("test_strategy", 2, p.strategy ? { status: p.g4 === "approved" ? "approved" : "awaiting_approval", current_version: 1, gate: g4Gate } : {}),
      ...(["test_design", "traceability", "automation_assessment", "automation", "execution", "failure_analysis", "defects_summary", "release_readiness", "performance"] as StageKey[]).map((k, i) => st(k, i < 2 ? 3 : i < 6 ? 4 : 5)),
    ],
  };
}

function readiness(): ReadinessCriteria {
  const c = (kind: "dor" | "dod", n: number, text: string, by: "rules" | "human" = "rules"): ReadinessCriterion => ({
    id: `${kind}-${n}`,
    key: `${kind.toUpperCase()}-0${n}`,
    lineage_id: `${kind}-${n}`,
    kind,
    scope: "requirement",
    text,
    status: "active",
    check: null,
    evaluation: null,
    generated_by: by,
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: NOW,
    updated_by: null,
  });
  return {
    stage_run_version: 1,
    requirements_version: 1,
    generated_by: "rules",
    definition_of_ready: [c("dor", 1, "It has at least one approved acceptance criterion"), c("dor", 2, "Its label is Observed or Inferred, or the product owner approved it", "human")],
    definition_of_done: [c("dod", 1, "All its test cases have been executed")],
  };
}

function strategy(): TestStrategy {
  const item = (text: string) => ({ text, rationale: null, generated_by: "rules" as const });
  return {
    id: "s1",
    version: 1,
    stage_run_version: 1,
    status: "awaiting_approval",
    generated_by: "rules",
    sections: {
      scope_in: [item("Contact form")],
      scope_out: [item("Payment provider internals")],
      test_levels: [
        { level: "component", in_scope: false, rationale: "Component testing needs source-code access; this project tests the deployed site." },
        { level: "system", in_scope: true, rationale: "The deployed site is the system under test." },
      ],
      test_types: [
        { type: "functional", in_scope: true, rationale: "Core flows.", requires_approval: false, available_from_phase: 4 },
        { type: "performance", in_scope: true, rationale: "Checkout latency matters.", requires_approval: true, available_from_phase: 5 },
      ],
      techniques_by_feature: [],
      risk_based_approach: [],
      entry_criteria: [item("Gate 3 approved")],
      exit_criteria: [item("No open Very high risks")],
      environments: [],
      test_data_approach: [item("Synthetic accounts")],
      tools: [],
      assumptions: [],
      constraints: [],
      limitations: [],
    },
    human_edited_sections: [],
    locked_sections: [],
    approved_input: { requirements_snapshot_hash: "h", requirements_version: 1 },
    plan_status: "current",
    validation_issues: [],
    updated_at: NOW,
    updated_by: null,
  };
}

function plan(): TestPlan {
  return {
    id: "tp1",
    key: "TP-001",
    version: 1,
    strategy_version: 1,
    stage_run_version: 1,
    status: "current",
    generated_by: "rules",
    sections: {
      introduction: "This plan covers acme.com.",
      test_items: [],
      scope: { in_scope: ["Contact form"] },
      approach: { levels: ["System"] },
      environments_and_test_data: {},
      entry_exit_criteria: { entry: ["Gate 3 approved"] },
      suspension_criteria: ["The site is unreachable"],
      resumption_requirements: ["The site is reachable again"],
      deliverables: [{ name: "Test cases", available_from_phase: 3, exists: false }],
      roles: [{ role: "QA lead", responsibility: "Approves gates", assignee: null }],
      schedule: [{ milestone: "Test design", after_stage: "test_design", target_date: null }],
      risks_and_contingencies: [],
    },
    approvals: [{ gate: "G4", status: "approved", decided_by: null, decided_at: NOW }],
    human_edited_sections: [],
    rules_template_sections: ["introduction"],
    note: null,
    updated_at: NOW,
    updated_by: null,
  };
}

function review(): ChangeReview {
  const cur = requirement(2);
  return {
    stage_key: "requirements",
    artefact: "requirements",
    current_version: 1,
    candidate_version: 2,
    review_status: "pending_review",
    guidance: null,
    summary: { added: 1, changed: 1, no_longer_found: 1, protected_with_proposal: 0, unchanged: 2 },
    gate_effect: null,
    items: [
      { lineage_id: "new1", key: "REQ-0005", type: "requirement", change: "added", protected_reason: null, current: null, proposed: { title: "Newsletter sign-up requires consent" }, field_diff: [], default_action: "accept", allowed_actions: ["accept", "skip"], note: null },
      { lineage_id: "l-REQ-0002", key: "REQ-0002", type: "requirement", change: "changed", protected_reason: null, current: { title: cur.title }, proposed: { title: `${cur.title} and phone` }, field_diff: [{ field: "title", from: cur.title, to: `${cur.title} and phone` }], default_action: "accept", allowed_actions: ["accept", "keep"], note: null },
      { lineage_id: "l-REQ-0003", key: "REQ-0003", type: "requirement", change: "no_longer_found", protected_reason: null, current: { title: "Careers page" }, proposed: null, field_diff: [], default_action: "mark_rejected", allowed_actions: ["mark_rejected", "keep"], note: "Not found in Scan 1." },
      { lineage_id: "l-REQ-0001", key: "REQ-0001", type: "requirement", change: "unchanged", protected_reason: null, current: { title: "Same" }, proposed: { title: "Same" }, field_diff: [], default_action: "keep", allowed_actions: ["keep"], note: null },
      // Older servers sent null defaults for unchanged items; the UI must never post them back (BUG-P2-03).
      { lineage_id: "l-REQ-0004", key: "REQ-0004", type: "requirement", change: "unchanged", protected_reason: null, current: { title: "Same too" }, proposed: { title: "Same too" }, field_diff: [], default_action: null, allowed_actions: ["keep"], note: null },
    ],
  };
}

const secret = (): SecretMeta => ({
  id: "sec1",
  name: "scan_credentials",
  kind: "login_credentials",
  login_url: "https://acme.com/login",
  username_hint: "qa…@acme.test",
  version: 1,
  created_by: { id: "u", full_name: "Daniele Edema" },
  created_at: NOW,
  rotated_at: null,
  last_used_at: NOW,
  last_result: "succeeded",
  last_reason_code: null,
});

function caps(p: P2State): AssistantCapabilities {
  return { ai_enabled: p.aiEnabled, model: p.aiEnabled ? "Claude" : null, free_form: p.aiEnabled, intents: [], later_phase_tasks: [], notice: null };
}

function answer(p: P2State, body: Record<string, unknown>): { user_message: AssistantMessage; reply: AssistantMessage } {
  const base: Pick<AssistantMessage, "thread_id" | "citations" | "proposals" | "notices" | "answered_by" | "generated_by" | "intent"> = { thread_id: "t1", citations: [], proposals: [], notices: [], answered_by: null, generated_by: null, intent: null };
  const user: AssistantMessage = { ...base, id: `m${Date.now()}u`, role: "user", content: String(body.content ?? body.intent ?? ""), created_at: NOW };
  const r = p.requirements[2];
  const proposals: Proposal[] =
    body.intent === "propose_negative_criteria"
      ? [
          {
            id: "prop1",
            key: "PROP-001",
            kind: "add_acceptance_criteria",
            target: { type: "requirement", id: r.id, key: r.key, label: r.title, path: `/projects/p1/requirements/${r.key}` },
            summary: "1 negative criterion",
            payload: {},
            preview: [{ kind: "negative", given: "the form is open", when: "the email is empty", then: "an error is shown" }],
            base_versions: {},
            status: "pending",
            generated_by: "rules",
            created_by: { id: "u", full_name: "Daniele Edema" },
            created_at: NOW,
            decided_by: null,
            decided_at: null,
            decision_comment: null,
            result: null,
          },
        ]
      : [];
  p.proposals.push(...proposals);
  const reply: AssistantMessage = {
    ...base,
    id: `m${Date.now()}a`,
    role: "assistant",
    answered_by: "intent",
    generated_by: "rules",
    intent: (body.intent as AssistantMessage["intent"]) ?? null,
    content: body.intent === "needs_attention" ? "Gate 3 is waiting for your approval.\n- REQ-0003 has no acceptance criteria." : "Proposed criteria for REQ-0003.",
    citations: [{ type: "requirement", id: r.id, key: "REQ-0003", label: r.title, path: `/projects/p1/requirements/REQ-0003` }],
    proposals,
    notices: [{ code: "built_in_answer", message: "" }],
    created_at: NOW,
  };
  return { user_message: user, reply };
}

export async function mockPhase2(page: Page, s: MockState, p: P2State) {
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
    const record = () => p.requests.push({ method, path: `${path}${url.search}`, body });

    if (path === "/auth/me" && s.user) return json(route, 200, { user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: p.role, can_approve: p.role === "owner" || p.role === "admin" });
    if (path === "/projects/p1/workflow") return json(route, 200, workflow(p));
    if (path === "/projects/p1/requirements" && method === "GET") return json(route, 200, { items: p.requirements, next_cursor: null });
    if (path === "/projects/p1/requirements" && method === "POST") {
      record();
      const r = requirement(p.requirements.length + 1, { title: String(b.title), source: "user", classification: "assumed", provenance: "assumed", generated_by: "human" });
      p.requirements.push(r);
      return json(route, 201, r);
    }
    if (path === "/projects/p1/requirements/stats")
      return json(route, 200, { stage_run_version: 1, generated_by: "rules", total: p.requirements.length, by_classification: {}, by_status: {}, by_type: {}, by_category: {}, by_source: {}, without_ac: 1, locked: 0, pending_review_version: null, features_without_requirement: [], acceptance_criteria: { total: 3, approved: 1, by_kind: {} } });
    if (path === "/projects/p1/requirements/bulk-status") {
      record();
      const ids = (b.ids as string[]) ?? [];
      const updated = p.requirements.filter((r) => ids.includes(r.id)).map((r) => Object.assign(r, { status: b.status }));
      return json(route, 200, { updated, skipped: [] });
    }
    if (path === "/projects/p1/readiness-criteria" && method === "POST") {
      record();
      const base = readiness().definition_of_ready[0];
      return json(route, 201, { ...base, id: `new-${p.requests.length}`, key: "DOR-09", text: String(b.text), generated_by: "human" });
    }
    if (path === "/projects/p1/readiness-criteria") return json(route, 200, readiness());
    const rc = path.match(/^\/readiness-criteria\/([^/]+)(\/status)?$/);
    if (rc) {
      record();
      const all = [...readiness().definition_of_ready, ...readiness().definition_of_done];
      const c = all.find((x) => x.id === rc[1]);
      if (!c) return err(route, 404, "not_found", "Not found");
      return json(route, 200, { ...c, ...(typeof b.text === "string" ? { text: b.text, version: c.version + 1 } : {}) });
    }
    if (path === "/projects/p1/documents") return json(route, 200, []);
    if (path === "/projects/p1/stages/requirements/runs")
      return json(route, 200, [{ version: 1, status: "completed", generated_by: "rules", created_at: NOW, finished_at: NOW, review_status: "applied" }]);
    if (path === "/projects/p1/stages/requirements/runs/2/review") return json(route, 200, review());
    if (path.startsWith("/projects/p1/stages/requirements/runs/2/review/")) {
      record();
      p.pendingReview = false;
      return json(route, 200, workflow(p).stages[3]);
    }
    if (path === "/projects/p1/gates/G3/decision") {
      record();
      if (b.decision === "approve") p.g3 = "approved";
      return json(route, 200, workflow(p).stages[4]);
    }
    if (path.startsWith("/projects/p1/stages/") && path.endsWith("/runs")) return json(route, 200, []);
    if (path.match(/^\/projects\/p1\/stages\/[^/]+\/runs\/\d+$/)) return json(route, 200, { version: 1, status: "completed", generated_by: "rules", partial: false, upstream_versions: {}, validation_issues: [], output: {}, decisions: [] });
    const rq = path.match(/^\/requirements\/([^/]+)(\/.*)?$/);
    if (rq) {
      const r = p.requirements.find((x) => x.id === rq[1]);
      if (!r) return err(route, 404, "not_found", "Not found");
      if (!rq[2]) return json(route, 200, r);
      if (rq[2] === "/revisions") return json(route, 200, [{ version: 1, changed_by: null, change_reason: null, source: "system", created_at: NOW, changes: {}, snapshot: {} }]);
      record();
      if (rq[2] === "/status") {
        Object.assign(r, { status: b.status, version: r.version + 1 });
        // The server approves draft criteria together with the requirement (lead decision, BUG-P2-11).
        if (b.status === "approved") for (const a of r.acceptance_criteria) if (a.status === "draft") Object.assign(a, { status: "approved", version: a.version + 1 });
      }
      return json(route, 200, r);
    }
    if (path.startsWith("/acceptance-criteria/")) {
      record();
      return json(route, 200, {});
    }
    // ---- secrets
    if (path === "/projects/p1/secrets") return json(route, 200, p.credentials ? [secret()] : []);
    if (path === "/projects/p1/secrets/scan_credentials" && method === "PUT") {
      record();
      p.credentials = true;
      return json(route, 201, secret());
    }
    // ---- strategy
    if (path === "/projects/p1/test-strategy") return p.strategy ? json(route, 200, strategy()) : err(route, 404, "not_found", "No strategy");
    if (path === "/projects/p1/test-strategy/versions") return json(route, 200, p.strategy ? [{ version: 1, stage_run_version: 1, status: "awaiting_approval", generated_by: "rules", created_at: NOW, approved: false }] : []);
    if (path === "/projects/p1/risks") return json(route, 200, { items: p.risks, next_cursor: null });
    if (path === "/projects/p1/risks/matrix")
      return json(route, 200, { cells: p.risks.map((r) => ({ likelihood: r.likelihood, impact: r.impact, count: 1, risk_keys: [r.key] })), totals: {} });
    const rk = path.match(/^\/risks\/([^/]+)$/);
    if (rk && method === "PATCH") {
      record();
      const r = p.risks.find((x) => x.id === rk[1])!;
      // The server recomputes score and level (the mock uses the contract's level bands).
      Object.assign(r, b, { version: r.version + 1 });
      r.score = r.likelihood * r.impact;
      r.level = r.score >= 20 ? "very_high" : r.score >= 10 ? "high" : r.score >= 5 ? "medium" : "low";
      return json(route, 200, r);
    }
    if (path === "/projects/p1/test-plan") return p.g4 === "approved" ? json(route, 200, plan()) : err(route, 404, "not_found", "No plan");
    if (path === "/projects/p1/test-plan/versions")
      return json(route, 200, p.g4 === "approved" ? [{ version: 1, strategy_version: 1, source: "derived", note: null, created_by: null, created_at: NOW }] : []);
    // ---- assistant
    if (path === "/projects/p1/assistant/capabilities") return json(route, 200, caps(p));
    if (path === "/projects/p1/assistant/proposals") return json(route, 200, { items: p.proposals.filter((x) => x.status === "pending"), next_cursor: null });
    if (path === "/projects/p1/assistant/threads" && method === "GET") return json(route, 200, { items: p.threads, next_cursor: null });
    if (path === "/projects/p1/assistant/threads" && method === "POST") {
      const t: Thread = { id: "t1", title: String(b.title ?? ""), created_at: NOW, messages: [] };
      p.threads.push(t);
      return json(route, 201, t);
    }
    if (path === "/assistant/threads/t1") return json(route, 200, p.threads.find((t) => t.id === "t1") ?? { id: "t1", title: "", created_at: NOW, messages: [] });
    if (path === "/assistant/threads/t1/messages") {
      record();
      if (!p.aiEnabled && b.content) return err(route, 422, "validation_error", "Free-form questions need AI.");
      const turn = answer(p, b);
      const t = p.threads.find((x) => x.id === "t1");
      t?.messages.push(turn.user_message, turn.reply);
      return json(route, 200, turn);
    }
    const pr = path.match(/^\/assistant\/proposals\/([^/]+)\/(accept|reject)$/);
    if (pr) {
      record();
      const x = p.proposals.find((y) => y.id === pr[1]);
      if (x) x.status = pr[2] === "accept" ? "accepted" : "rejected";
      return json(route, 200, x);
    }
    // ---- reports (Phase 2 rows appear next to the discovery report)
    const reportRows = [
      { id: "r1", report_type: "discovery", version: 1, status: "ready", formats: ["pdf", "html"], generated_by: "rules", created_at: NOW, scan_id: "scan1", scan_number: 1, is_latest_scan: true, approval_status: "approved" },
      { id: "rs1", report_type: "requirements_spec", version: 1, status: "ready", formats: ["pdf", "html"], generated_by: "rules", created_at: NOW, approval: { gate: "G3", status: "approved", approved_by: null, approved_at: NOW }, is_latest_source: true, stage_run_version: 1 },
      { id: "ts1", report_type: "test_strategy", version: 1, status: "ready", formats: ["pdf", "html"], generated_by: "rules", created_at: NOW, approval: { gate: "G4", status: "pending", approved_by: null, approved_at: null }, is_latest_source: true, stage_run_version: 1 },
    ];
    if (path === "/projects/p1/reports" && method === "GET" && p.g3 === "approved") return json(route, 200, reportRows);
    // Stored report content as the server writes it: requirements without `evidence`, documents without dates,
    // and a risk matrix with totals only (BUG-P2-06).
    if (path === "/reports/rs1") {
      const { evidence: _evidence, ...req } = requirement(1, { status: "approved" });
      void _evidence;
      return json(route, 200, {
        ...reportRows[1],
        content: {
          project: {},
          generated_at: NOW,
          approval: reportRows[1].approval,
          scope_and_method: ["Derived from the discovered pages."],
          classification_legend: { observed: "Seen directly in the application, with evidence" },
          counts: { total: 1, by_status: { approved: 1 }, by_classification: { observed: 1 } },
          requirements_by_category: { validation: [{ requirement: req }] },
          readiness: { definition_of_ready: [{ key: "DOR-01", text: "It has an approved criterion", status: "active" }], definition_of_done: [] },
          open_questions: [],
          source_documents: [{ key: "DOC-001", title: "Shop spec", filename: "spec.md" }],
          limitations: [],
          summary: "1 provisional requirement.",
          summary_generated_by: "rules",
          disclaimer: "Provisional requirements.",
        },
      });
    }
    if (path === "/reports/ts1")
      return json(route, 200, {
        ...reportRows[2],
        content: { project: {}, generated_at: NOW, approval: reportRows[2].approval, strategy: { version: 1, sections: strategy().sections, generated_by: "rules" }, risks: p.risks, risk_matrix: { totals: { high: 1 } }, summary: "2 risks assessed.", summary_generated_by: "rules", approvals_note: "Separate approval needed." },
      });
    return route.fallback();
  });
}
