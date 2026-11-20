// DEVELOPMENT/TEST FIXTURES ONLY. Release readiness and Gate 9 stand-ins for the QA Analyst API (backend
// app/api/routers/release.py, app/services/release.py; P6-05a), layered over ./fixtures.ts and the phase 2–4 and
// phase 6 fixtures with page.route(). REL-0001 is the demo's No-go on release 1 and REL-0002 its Conditional after
// CHG-0001 (design P6 §14 steps 1 and 7). Nothing here is imported by the product code.

import type { Page, Route } from "@playwright/test";
import type { StageState, Workflow } from "../../src/lib/contract";
import type { Assessment, Criterion, ManualRetest, ReleaseOverview, ReleaseSummary, Verdict } from "../../src/lib/release";
import { API, type MockState } from "./fixtures";
import { p4Workflow, type P4State } from "./phase4-fixtures";
import { demoRecommendation, type P6State } from "./phase6-fixtures";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string, details: unknown = null) => json(route, status, { error: { code, message, details } });
const MEMBER = { id: "m", full_name: "M. Member" };
const LABEL: Record<Verdict, string> = { go: "Go", conditional: "Conditional", no_go: "No-go" };
const STATEMENT = (t: string) => `This recommendation is based on the tests the platform ran and the evidence recorded up to ${t}. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it.`;
const iso = (day: string, time: string) => `2026-11-${day}T${time}Z`;
const MANUAL = "Manual test: a person runs it (not part of the automated run)";

export type ReleaseState = {
  role: "owner" | "admin" | "member" | "viewer";
  canApprove: boolean;
  /** A run has finished (passed or failed): assessing is possible. */
  available: boolean;
  /** Newest first. */
  assessments: Assessment[];
  /** GETs of the overview while a new assessment is worked out (0 = ready on the first GET). */
  assessDelay: number;
  /** The verdict of the next assessment. */
  next: Verdict;
  /** The next decision answers 409 and the assessment goes stale (someone else's evidence arrived). */
  staleOnDecide: string | null;
  /** Impacted manual must-run tests of CHG-0001 and their recorded re-tests (D37). */
  retests: Record<string, ManualRetest[]>;
  requests: { method: string; path: string; body: unknown }[];
};

const ref = (type: string, key: string, path: string | null, label?: string) => ({ type, key, id: key.toLowerCase(), label: label ?? key, path });
const defectRef = (key: string, sev: string) => ref("defect", key, `/projects/p1/defects/${key}`, `${key} (${sev})`);

function crit(id: string, text: string, source: Criterion["source"], blocking: boolean, status: Criterion["status"], detail: string, refs: Criterion["evidence_refs"] = [], over: Partial<Criterion> = {}): Criterion {
  const label = source === "exit_criterion" ? "Exit criterion (Test Strategy v2)" : source === "dod" ? "Definition of Done" : "Platform check";
  const confirmable = source !== "platform" && status === "not_evaluable";
  return { id, rule: id.startsWith("exit.text") ? null : id, text, source, source_label: label, blocking, status, detail, evidence_refs: refs, measured: null, confirmable, can_confirm: false, manual: false, confirmed_by: null, confirm_reason: null, confirmed_at: null, ...over };
}

function verdictOf(criteria: Criterion[]): Verdict {
  if (criteria.some((c) => c.blocking && c.status === "not_met")) return "no_go";
  return criteria.some((c) => c.status !== "met") ? "conditional" : "go";
}

function conditionsOf(criteria: Criterion[]) {
  const out: Assessment["conditions_list"] = [];
  for (const blocking of [true, false])
    for (const c of criteria) if (c.blocking === blocking && c.status !== "met") out.push({ text: CONDITION[c.id] ?? `Confirm: ${c.text}`, criterion_id: c.id, blocking, evidence_refs: c.evidence_refs });
  return out;
}

const CONDITION: Record<string, string> = {
  "exit.no_open_high_defects": "Fix or accept DEF-0001 (major)",
  "rr.open_defects": "Fix or accept DEF-0007 (minor)",
  "rr.impact_reviewed": "Review TC-0012 after CHG-0001: page /products/1 was removed (CHG-0001)",
  "rr.impacted_rerun": "Re-test TC-0031 by hand after CHG-0001 and record the result (manual test)",
};

function reasonOf(v: Verdict, criteria: Criterion[], n: number): string {
  if (v === "no_go") return "1 blocking criterion isn't met: there is an open major defect (DEF-0001).";
  if (v === "conditional") {
    const unknown = criteria.find((c) => c.blocking && c.status === "not_evaluable");
    const remain = `${n} condition${n === 1 ? " remains" : "s remain"}`;
    return unknown ? `${unknown.text} can't be checked, so the recommendation can't be Go; ${remain}.` : `Every blocking criterion is met, but ${remain}.`;
  }
  return "Every criterion is met by recorded evidence.";
}

/** REL-0001 on release 1: DEF-0001 (major) is open, so No-go (design P6 §14 step 1, check 31). */
export function rel1Criteria(): Criterion[] {
  return [
    crit("exit.no_open_high_defects", "No open critical or high defects", "exit_criterion", true, "not_met", 'DEF-0001 (major) is open. "Critical or high" means the critical and major severities.', [defectRef("DEF-0001", "major")]),
    crit("rr.impacted_rerun", "Impacted tests re-run since the change", "platform", true, "met", "No change set since the last final assessment, so no impacted test has to be re-run"),
    crit("rr.high_risk_tested", "Every high risk tested and passing", "platform", true, "met", "Every open high risk has a linked test case that passed: RISK-01, RISK-03", [ref("risk", "RISK-01", "/projects/p1/test-strategy?view=risks&risk=RISK-01"), ref("risk", "RISK-03", "/projects/p1/test-strategy?view=risks&risk=RISK-03")]),
    crit("rr.g8_pending", "Nothing waiting at Gate 8", "platform", true, "met", "No defect draft is waiting for a Gate 8 decision"),
    crit("exit.pass_rate", "95 % of executed tests pass", "exit_criterion", false, "met", "97 % of executed tests passed (RUN-0003)", [ref("execution_run", "RUN-0003", "/projects/p1/execution/RUN-0003")]),
  ];
}

/** REL-0002 after CHG-0001: every blocking criterion met but four conditions (design P6 §10.1, §14 step 7). */
export function rel2Criteria(): Criterion[] {
  const chg = ref("change_set", "CHG-0001", "/projects/p1/discovery/changes/CHG-0001");
  return [
    crit("exit.no_open_high_defects", "No open critical or high defects", "exit_criterion", true, "met", 'No critical or major defect is open. "Critical or high" means the critical and major severities.'),
    crit("rr.impacted_rerun", "Impacted tests re-run since the change", "platform", true, "not_evaluable", "Every automated must-run test from CHG-0001 has a result since the change. Manual must-run tests without a recorded re-test: TC-0031 (CHG-0001).", [ref("test_case", "TC-0031", "/projects/p1/test-cases/TC-0031"), chg]),
    crit("rr.high_risk_tested", "Every high risk tested and passing", "platform", true, "met", "Every open high risk has a linked test case that passed: RISK-01, RISK-03"),
    crit("rr.g8_pending", "Nothing waiting at Gate 8", "platform", true, "met", "No defect draft is waiting for a Gate 8 decision"),
    crit("exit.pass_rate", "95 % of executed tests pass", "exit_criterion", false, "met", "97 % of executed tests passed (RUN-0005)", [ref("execution_run", "RUN-0005", "/projects/p1/execution/RUN-0005")]),
    crit("rr.open_defects", "No open minor or trivial defects", "platform", false, "not_met", "DEF-0007 (minor) is open", [defectRef("DEF-0007", "minor")]),
    crit("rr.impact_reviewed", "No open review or gap items from changes", "platform", false, "not_met", "Open: Review TC-0012 after CHG-0001: page /products/1 was removed (CHG-0001)", [{ ...chg, path: "/projects/p1/discovery/changes/CHG-0001?tab=impact", label: "2 items in CHG-0001" }]),
    crit("exit.text.6", "Stakeholders signed off", "exit_criterion", false, "not_evaluable", "The platform can't check this: confirm it"),
  ];
}

function residual(n: 1 | 2): Assessment["residual_risks"] {
  const risk = (key: string, title: string) => ({ ...ref("risk", key, `/projects/p1/test-strategy?view=risks&risk=${key}`), label: `${key} · ${title}` });
  const rows: Assessment["residual_risks"] = [
    { risk: risk("RISK-01", "Contact form validation"), title: "Contact form validation", status: "open", initial: "high", residual: "low", line: "Mitigated by testing: all 3 linked tests passed", reduced: true, tests: { passed: ["TC-0019", "TC-0020", "TC-0021"], failed: [], not_tested: [] } },
  ];
  if (n === 2) rows.unshift({ risk: risk("RISK-04", "Removed product page links"), title: "Removed product page links", status: "open", initial: "medium", residual: "medium", line: "Not reduced: 1 test not tested since the change (TC-0012)", reduced: false, tests: { passed: [], failed: [], not_tested: ["TC-0012"] } });
  return rows;
}

export function assessment(key: string, criteria: Criterion[], over: Partial<Assessment> = {}): Assessment {
  const v = verdictOf(criteria);
  const conds = conditionsOf(criteria);
  const n = Number(key.slice(-1));
  const at = over.created_at ?? (n === 1 ? iso("14", "09:10:00") : n === 2 ? iso("15", "16:00:00") : iso("15", "17:02:00"));
  const a: Assessment = {
    id: `rel${n}`,
    key,
    status: "awaiting_approval",
    recommendation: v,
    final_verdict: null,
    verdict: v,
    verdict_state: "recommended",
    decision: null,
    decided_by: null,
    decided_at: null,
    override_line: null,
    conditions: conds.length,
    overall_residual: n === 1 ? "low" : "medium",
    stale_reason: null,
    superseded_by: null,
    created_at: at,
    assessed_at: at,
    reason: reasonOf(v, criteria, conds.length),
    statement: STATEMENT(at),
    criteria,
    counts: { total: criteria.length, met: 0, not_met: 0, not_evaluable: 0, blocking: 0, blocking_not_met: 0, manual: 0 },
    conditions_list: conds,
    residual_risks: residual(n === 1 ? 1 : 2),
    override_reason: null,
    decision_record: null,
    created_by: MEMBER,
    generated_by: "rules",
    ai_sections: {},
    scope: {},
    changes_since: { previous: null, text: "This is the first assessment." },
    is_latest: true,
    latest: { id: `rel${n}`, key },
    decidable: true,
    not_decidable_reason: null,
    permissions: { can_decide: true, can_confirm: true, can_assess: true },
    ...over,
  };
  return a;
}

/** REL-0002 waiting for Gate 9, REL-0001 decided (Final: No-go by A. Approver). */
export function demoAssessments(): Assessment[] {
  const r1 = assessment("REL-0001", rel1Criteria(), {
    status: "final",
    final_verdict: "no_go",
    verdict_state: "final",
    decision: "approve",
    decided_by: { id: "a", full_name: "A. Approver" },
    decided_at: iso("14", "09:30:00"),
    decision_record: { decision: "approve", by: "A. Approver", at: iso("14", "09:30:00"), text: "Final verdict: No-go · approved by A. Approver" },
  });
  const r2 = assessment("REL-0002", rel2Criteria(), {
    changes_since: {
      previous: { id: "rel1", key: "REL-0001", created_at: r1.created_at, recommendation: "no_go", final_verdict: "no_go", status: "final" },
      recommendation: { from: "no_go", to: "conditional" },
      change_sets: ["CHG-0001"],
      runs: ["RUN-0005"],
      defects: [
        { key: "DEF-0001", from: "fixed", to: "verified" },
        { key: "DEF-0007", from: null, to: "confirmed" },
      ],
      exploratory_sessions: ["EXP-0001"],
      criteria: [
        { id: "exit.no_open_high_defects", text: "No open critical or high defects", from: "not_met", to: "met" },
        { id: "rr.impacted_rerun", text: "Impacted tests re-run since the change", from: "met", to: "not_evaluable" },
      ],
      text: null,
    },
  });
  return [r2, r1];
}

export function newRelease(over: Partial<ReleaseState> = {}): ReleaseState {
  return { role: "owner", canApprove: true, available: true, assessments: demoAssessments(), assessDelay: 1, next: "conditional", staleOnDecide: null, retests: { "TC-0031": [] }, requests: [], ...over };
}

function summary(a: Assessment): ReleaseSummary {
  const { id, key, status, recommendation, final_verdict, verdict, verdict_state, decision, decided_by, decided_at, override_line, conditions, overall_residual, stale_reason, superseded_by, created_at, assessed_at } = a;
  return { id, key, status, recommendation, final_verdict, verdict, verdict_state, decision, decided_by, decided_at, override_line, conditions, overall_residual, stale_reason, superseded_by, created_at, assessed_at };
}

function view(q: ReleaseState, a: Assessment): Assessment {
  const member = q.role !== "viewer";
  const open = a.status === "awaiting_approval";
  const latest = q.assessments[0];
  return {
    ...a,
    is_latest: latest.id === a.id,
    latest: { id: latest.id, key: latest.key },
    decidable: open,
    not_decidable_reason: open ? null : a.status === "stale" ? "Evidence changed after this assessment. Assess again." : "This assessment was already decided.",
    criteria: a.criteria.map((c) => ({ ...c, can_confirm: c.confirmable && member && open })),
    permissions: { can_decide: member && q.canApprove && open, can_confirm: member && open, can_assess: member },
  };
}

/** The release_readiness stage as the workflow reports it. */
function stage(q: ReleaseState): Partial<StageState> {
  const a = q.assessments[0];
  const st = !a ? "not_started" : { awaiting_approval: "awaiting_approval", final: "approved", rejected: "changes_requested", stale: "stale", superseded: "not_started" }[a.status];
  const gate = { awaiting_approval: "pending", approved: "approved", changes_requested: "rejected" }[st as string] ?? "none";
  return { available: true, phase: 6, status: st as StageState["status"], current_version: a ? 1 : null, gate: { key: "G9", policy: "required", status: gate as never, recommendation: null } };
}

export function releaseWorkflow(q: ReleaseState, p4: P4State): Workflow {
  const wf = p4Workflow(p4);
  wf.stages = wf.stages.map((s) => (s.key === "release_readiness" ? { ...s, ...stage(q) } : s));
  return wf;
}

let assessing = 0;

/** Registered after the other mocks, so it answers the release routes, the workflow and /auth/me first. */
export async function mockRelease(page: Page, s: MockState, q: ReleaseState, p4: P4State) {
  assessing = 0;
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
    const me = s.user ?? { id: "u", full_name: "Daniele Edema", email: "daniele@acme.test" };
    if (path === "/auth/me" && s.user) return json(route, 200, { user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: q.role, can_approve: q.canApprove });
    if (path === "/projects/p1/workflow") return json(route, 200, releaseWorkflow(q, p4));

    const overview = (): ReleaseOverview => {
      if (assessing > 0 && --assessing === 0) {
        const n = q.assessments.length + 1;
        const key = `REL-000${n}`;
        const criteria = q.next === "go" ? rel2Criteria().map((c) => ({ ...c, status: "met" as const })) : q.next === "no_go" ? rel1Criteria() : rel2Criteria();
        for (const o of q.assessments) if (o.status === "awaiting_approval" || o.status === "stale") Object.assign(o, { status: "superseded", superseded_by: key, verdict_state: "not_decided" });
        const prev = q.assessments[0];
        q.assessments.unshift(
          assessment(key, criteria, {
            id: `rel${n}`,
            created_at: iso("15", "17:02:00"),
            assessed_at: iso("15", "17:02:00"),
            changes_since: prev
              ? { previous: { id: prev.id, key: prev.key, created_at: prev.created_at, recommendation: prev.recommendation, final_verdict: prev.final_verdict, status: prev.status }, recommendation: { from: prev.recommendation, to: verdictOf(criteria) }, change_sets: [], runs: ["RUN-0006"], defects: [], exploratory_sessions: [], criteria: [], text: null }
              : { previous: null, text: "This is the first assessment." },
          }),
        );
      }
      const latest = q.assessments[0];
      return {
        available: q.available,
        reason: q.available ? null : "Run the tests first: release readiness needs execution results",
        assessing: assessing > 0,
        assessing_text: assessing > 0 ? "Assessing: reading results, defects, risks, changes and exploration…" : null,
        stage: { status: String(stage(q).status), stale_reason: null },
        latest: latest ? view(q, latest) : null,
        history: q.assessments.map(summary),
        statement_template: STATEMENT("{time}"),
        permissions: { can_assess: member && q.available && assessing === 0, can_decide: member && q.canApprove },
      };
    };

    if (path === "/projects/p1/release-readiness" && method === "GET") return json(route, 200, overview());
    if (path === "/projects/p1/release-assessments" && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (!q.available) return err(route, 409, "conflict", "Run the tests first: release readiness needs execution results");
      assessing = q.assessDelay + 1;
      return json(route, 202, overview());
    }
    const byKey = path.match(/^\/projects\/p1\/release-assessments\/by-key\/([^/]+)$/);
    if (byKey) {
      const a = q.assessments.find((x) => x.key === byKey[1]);
      if (!a) return err(route, 404, "not_found", "Release assessment not found");
      return json(route, 200, view(q, a));
    }
    const confirm = path.match(/^\/release-assessments\/([^/]+)\/criteria\/([^/]+)\/confirm$/);
    if (confirm && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const a = q.assessments.find((x) => x.id === confirm[1])!;
      const c = a.criteria.find((x) => x.id === decodeURIComponent(confirm[2]));
      if (!c) return err(route, 404, "not_found", "Criterion not found");
      if (!c.confirmable) return err(route, 409, "conflict", "The platform checks this criterion itself; it can't be confirmed by a person");
      if (a.status !== "awaiting_approval") return err(route, 409, "conflict", "This assessment was already decided.");
      const status = body.status as "met" | "not_met";
      const reason = String(body.reason ?? "").trim();
      Object.assign(c, { status, manual: true, detail: `Confirmed by ${me.full_name}: '${reason}'`, confirmed_by: { id: me.id, full_name: me.full_name }, confirm_reason: reason, confirmed_at: iso("15", "16:10:00") });
      const old = a.recommendation;
      const v = verdictOf(a.criteria);
      const conds = conditionsOf(a.criteria);
      Object.assign(a, { recommendation: v, verdict: v, conditions_list: conds, conditions: conds.length, reason: reasonOf(v, a.criteria, conds.length) });
      return json(route, 200, { assessment: view(q, a), message: `Criterion confirmed. The recommendation is now ${LABEL[v]}.`, verdict_changed: v !== old });
    }
    const decide = path.match(/^\/release-assessments\/([^/]+)\/decision$/);
    if (decide && method === "POST") {
      record();
      if (!member || !q.canApprove) return err(route, 403, "forbidden", "Deciding Gate 9 needs approval permission");
      const a = q.assessments.find((x) => x.id === decide[1])!;
      if (q.staleOnDecide) {
        Object.assign(a, { status: "stale", stale_reason: q.staleOnDecide, verdict_state: "not_decided" });
        q.staleOnDecide = null;
        return err(route, 409, "conflict", "Evidence changed after this assessment. Assess again to include the new evidence.");
      }
      if (a.status !== "awaiting_approval") return err(route, 409, "conflict", "This assessment was already decided.");
      const d = body.decision as "approve" | "reject" | "override";
      const reason = String(body.reason ?? "").trim();
      if (d === "override" && (!body.final_verdict || body.final_verdict === a.recommendation)) return err(route, 422, "validation_error", "Choose a final verdict different from the recommendation.");
      if (d === "override" && reason.length < 20) return err(route, 422, "validation_error", "Write at least 20 characters. The reason is shown next to the verdict.");
      const by = { id: me.id, full_name: me.full_name };
      const at = iso("15", "16:30:00");
      if (d === "reject") {
        Object.assign(a, { status: "rejected", decision: "reject", decided_by: by, decided_at: at, override_reason: reason, verdict_state: "not_decided", decision_record: { decision: "reject", by: me.full_name, at, text: `Rejected by ${me.full_name}: '${reason}'. Assess again when ready.` } });
        return json(route, 200, { assessment: view(q, a), message: `${a.key} rejected.` });
      }
      const final = (d === "override" ? body.final_verdict : a.recommendation) as Verdict;
      Object.assign(a, {
        status: "final",
        decision: d,
        final_verdict: final,
        verdict: final,
        verdict_state: "final",
        decided_by: by,
        decided_at: at,
        override_reason: d === "override" ? reason : null,
        override_line: d === "override" ? `Overridden by ${me.full_name}: ${reason}` : null,
        decision_record: { decision: d, by: me.full_name, at, text: d === "override" ? `Final verdict: ${LABEL[final]} · Overridden by ${me.full_name}: '${reason}' · recommended: ${LABEL[a.recommendation]}` : `Final verdict: ${LABEL[final]} · approved by ${me.full_name}` },
      });
      return json(route, 200, { assessment: view(q, a), message: d === "override" ? `${a.key} overridden: ${LABEL[final]} is final.` : `${a.key}: ${LABEL[final]} is final.` });
    }

    // ---- manual re-tests of CHG-0001 (D37)
    const retests = path.match(/^\/change-sets\/([^/]+)\/manual-retests$/);
    if (retests) {
      const items = () =>
        Object.entries(q.retests).map(([key, hist]) => ({ case_key: key, title: "Sign in with the saved test account", test_case_id: `c${key.slice(-2)}`, case_lineage_id: `l${key.slice(-2)}`, reasons: ["Directly affected: page /login changed"], latest: hist[0] ?? null, history: hist }));
      const bodyOf = () => {
        const list = items();
        const recorded = list.filter((i) => i.latest).length;
        return { change_set: { id: retests[1], key: "CHG-0001" }, items: list, counts: { total: list.length, recorded, open: list.length - recorded }, permissions: { can_record: member } };
      };
      if (method === "GET") return json(route, 200, bodyOf());
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const key = String(body.case_key);
      if (!q.retests[key]) return err(route, 422, "validation_error", `${key} isn't a manual must-run test of CHG-0001.`);
      // Since P4-14a (D39) a re-test is a manual result in the caller's recording manual run for the change set
      // (RUN-0008 here): recording again in that run updates its result, so history keeps one entry per run.
      const run = "RUN-0008";
      const hist = q.retests[key];
      const mine = hist.findIndex((h) => h.run_key === run && h.recorded_by?.id === me.id);
      const r: ManualRetest = { id: `res-${key}`, status: body.status as "passed" | "failed", note: String(body.note ?? "").trim(), recorded_by: { id: me.id, full_name: me.full_name }, recorded_at: iso("15", "16:20:00"), run_key: run, result_key: `${run}-01` };
      if (mine >= 0) hist.splice(mine, 1);
      hist.unshift(r);
      const waiting = q.assessments.find((a) => a.status === "awaiting_approval");
      if (waiting) Object.assign(waiting, { status: "stale", stale_reason: `Manual re-test of ${key} recorded (${r.status})`, verdict_state: "not_decided" });
      return json(route, 201, { ...bodyOf(), message: `Manual re-test of ${key} recorded: ${r.status}.` });
    }
    return route.fallback();
  });
}

/** CHG-0001's must-run list with TC-0031 as an impacted manual test (D37), over ./phase6-fixtures.ts. */
export async function mockManualMustRun(page: Page, p6: P6State) {
  await page.route(`${API}/change-sets/cs-CHG-0001/regression-recommendation`, async (route) => {
    const rec = demoRecommendation(p6, p6.sets.find((x) => x.key === "CHG-0001")!);
    rec.must = [...(rec.must ?? []), { case_lineage_id: "l31", key: "TC-0031", title: "Sign in with the saved test account", reasons: ["Directly affected: page /login changed"], test_case_id: "c31", script: null, runnable: false, not_runnable_reason: MANUAL }];
    rec.excluded = (rec.excluded ?? []).filter((x) => x.key !== "TC-0031");
    return json(route, 200, rec);
  });
}
