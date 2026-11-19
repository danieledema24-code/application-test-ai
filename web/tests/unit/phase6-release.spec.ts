// Release readiness and Gate 9 wording and logic (P6-05b, D32, D33, D37; design P6 §3.7, §3.8, §4.3–4.5, §10).
import { expect, test } from "@playwright/test";
import {
  RELEASE_STATEMENT,
  changesSinceParts,
  criteriaRows,
  decisionConfirm,
  decisionErrors,
  decisionRecordText,
  counterText,
  confirmErrors,
  evidenceName,
  finalLine,
  g9Chip,
  g9Text,
  gate9State,
  glanceLine,
  headerPill,
  manualRetestHref,
  manualRetestSets,
  overrideOptions,
  overrideText,
  quotedOverride,
  releaseAttentionRows,
  retestErrors,
  retestLine,
  staleText,
  statementFor,
  historyFinal,
  assessmentOption,
  step21Text,
  unmetBlocking,
  verdictText,
  type Assessment,
  type Criterion,
  type ReleaseSummary,
} from "../../src/lib/release";
import { buildLifecycle, stageStatusText } from "../../src/lib/lifecycle";
import { fmtDateTime } from "../../src/lib/format";
import type { StageKey, StageState, Workflow } from "../../src/lib/contract";

const fmt = (iso: string | null | undefined) => (iso ? "15 Nov 16:00" : "");
const approver = { id: "u1", full_name: "A. Approver", email: "a@example.com" } as ReleaseSummary["decided_by"];

function crit(over: Partial<Criterion>): Criterion {
  return {
    id: "c",
    rule: null,
    text: "Criterion",
    source: "platform",
    source_label: "Platform check",
    blocking: false,
    status: "met",
    detail: null,
    evidence_refs: [],
    confirmable: false,
    can_confirm: false,
    manual: false,
    confirmed_by: null,
    confirm_reason: null,
    confirmed_at: null,
    ...over,
  };
}

function summary(over: Partial<ReleaseSummary> = {}): ReleaseSummary {
  return {
    id: "a2",
    key: "REL-0002",
    status: "awaiting_approval",
    recommendation: "conditional",
    final_verdict: null,
    verdict: "conditional",
    verdict_state: "recommended",
    decision: null,
    decided_by: null,
    decided_at: null,
    override_line: null,
    conditions: 4,
    overall_residual: "medium",
    stale_reason: null,
    superseded_by: null,
    created_at: "2026-11-15T16:00:00Z",
    ...over,
  };
}

const DEF1 = crit({ id: "rr.open_defects", text: "No open critical or high defects", blocking: true, status: "not_met", evidence_refs: [{ type: "defect", key: "DEF-0001", label: "DEF-0001 (major)" }] });

test("statement: fixed wording with the snapshot time (§3.8)", () => {
  // design P6 §3.8: {time} is fmtDateTime of the snapshot, like every other time on the page.
  expect(statementFor({ assessed_at: "2026-11-15T16:00:00", created_at: null })).toBe(RELEASE_STATEMENT(fmtDateTime("2026-11-15T16:00:00")));
  expect(RELEASE_STATEMENT("15 Nov 2026, 16:00")).toBe(
    "This recommendation is based on the tests the platform ran and the evidence recorded up to 15 Nov 2026, 16:00. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it.",
  );
});

test("the verdict is never shown without its state word (§3.7)", () => {
  expect(verdictText(summary())).toBe("Conditional · Recommended");
  expect(verdictText(summary({ verdict: "go", verdict_state: "final" }))).toBe("Go · Final");
  expect(verdictText(summary({ verdict_state: "not_decided" }))).toBe("Conditional · Not decided");
});

test("Gate 9 state per role and status", () => {
  expect(gate9State(summary(), true)).toBe("waiting for your decision");
  expect(gate9State(summary(), false)).toBe("waiting for a decision by someone who can approve");
  expect(gate9State(summary({ status: "final", decision: "override", decided_by: approver }), true)).toBe("overridden by A. Approver");
  expect(gate9State(summary({ status: "final", decision: "approve", decided_by: approver }), true)).toBe("approved by A. Approver");
  expect(gate9State(summary({ status: "stale" }), true)).toBe("out of date: assess again");
  expect(gate9State(summary({ status: "superseded", superseded_by: "REL-0003" }), true)).toBe("replaced by REL-0003");
});

test("override offers only a different verdict; reason must be ≥ 20 characters; errors only on submit", () => {
  expect(overrideOptions("conditional")).toEqual(["go", "no_go"]);
  expect(overrideOptions("no_go")).toEqual(["go", "conditional"]);
  expect(decisionErrors(null, null, "", "conditional")).toEqual({ decision: "Choose a decision." });
  expect(decisionErrors("override", null, "short", "conditional")).toEqual({
    verdict: "Choose a final verdict.",
    reason: "Write at least 20 characters. The reason is shown next to the verdict.",
  });
  expect(decisionErrors("override", "conditional", "x".repeat(20), "conditional").verdict).toBe("Choose a final verdict.");
  expect(decisionErrors("override", "go", `  ${"x".repeat(19)}  `, "conditional").reason).toBeDefined();
  expect(decisionErrors("override", "go", "x".repeat(20), "conditional")).toEqual({});
  expect(decisionErrors("reject", null, " ", "conditional").reason).toBe("Say why. The reason is shown on the assessment.");
  expect(decisionErrors("approve", null, "", "conditional")).toEqual({});
  expect(counterText("  Too short ")).toBe("9 of 20 characters");
});

test("confirmation text names the decider and the audit log; override to Go lists blocking criteria not met", () => {
  const a = { key: "REL-0001", recommendation: "no_go" as const, criteria: [DEF1, crit({ blocking: false, status: "not_met" })] };
  expect(unmetBlocking(a.criteria)).toEqual(["No open critical or high defects (DEF-0001, major)"]);
  const o = decisionConfirm(a, "override", "go", " Customer demo needs it ", "Daniele Edema");
  expect(o.title).toBe("Override the recommendation?");
  expect(o.body).toContain("Final verdict: Go (recommended: No-go). Your reason is shown as 'Overridden by Daniele Edema: Customer demo needs it' next to the verdict, in the Release Readiness Report and in the audit log.");
  expect(o.danger).toBe("Blocking criteria not met: No open critical or high defects (DEF-0001, major).");
  expect(o.confirmLabel).toBe("Override to Go");
  expect(decisionConfirm(a, "override", "conditional", "x".repeat(20), "D").danger).toBeNull();
  expect(decisionConfirm(a, "approve", null, "", "D")).toMatchObject({ confirmLabel: "Approve: No-go", body: "Make No-go the final verdict for REL-0001? The report will say the release should not go ahead." });
  expect(decisionConfirm({ ...a, recommendation: "conditional" }, "approve", null, "", "D").confirmLabel).toBe("Approve: Conditional");
  expect(decisionConfirm(a, "reject", null, "why", "D").confirmLabel).toBe("Reject assessment");
});

test("decision record and override line: 'Overridden by {name}' with the reason and the recommendation", () => {
  const a = { decision: "override" as const, decided_by: approver, decided_at: "2026-11-15T16:00:00Z", override_reason: "Customer demo needs it", recommendation: "conditional" as const, final_verdict: "go" as const };
  expect(overrideText(a)).toBe("Overridden by A. Approver: 'Customer demo needs it' (recommended: Conditional)");
  expect(overrideText({ ...a, decision: "approve" })).toBeNull();
  expect(decisionRecordText(a, fmt)).toBe("Final verdict: Go · Overridden by A. Approver: 'Customer demo needs it' · recommended: Conditional · 15 Nov 16:00");
  expect(decisionRecordText({ ...a, decision: "approve", final_verdict: "conditional" }, fmt)).toBe("Final verdict: Conditional · approved by A. Approver · 15 Nov 16:00");
  expect(decisionRecordText({ ...a, decision: "reject" }, fmt)).toBe("Rejected by A. Approver: 'Customer demo needs it' · 15 Nov 16:00. Assess again when ready.");
  expect(decisionRecordText({ ...a, decision: null }, fmt)).toBeNull();
  expect(quotedOverride("Overridden by A. Approver: Customer demo: needs it")).toBe("Overridden by A. Approver: 'Customer demo: needs it'");
  expect(finalLine(summary({ status: "final", verdict: "go", decision: "override", decided_by: approver }))).toBe("Final: Go · overridden by A. Approver");
  expect(finalLine(summary())).toBeNull();
});

test("stale text carries the server's reason", () => {
  expect(staleText("RUN-0006 finished at 16:20.")).toBe("Evidence changed after this assessment (RUN-0006 finished at 16:20). It can't be decided. Assess again to include the new evidence.");
  expect(staleText(null)).toBe("Evidence changed after this assessment. It can't be decided. Assess again to include the new evidence.");
});

test("criteria rows: status filter and stable blocking-first order; evidence links have unique names", () => {
  const list = [crit({ id: "a", status: "met" }), crit({ id: "b", blocking: true, status: "not_met" }), crit({ id: "c", status: "not_met" }), crit({ id: "d", blocking: true, status: "met" })];
  expect(criteriaRows(list, "", true).map((c) => c.id)).toEqual(["b", "d", "a", "c"]);
  expect(criteriaRows(list, "", false).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  expect(criteriaRows(list, "not_met", true).map((c) => c.id)).toEqual(["b", "c"]);
  expect(evidenceName({ type: "defect", key: "DEF-0001" }, DEF1)).toBe("Open DEF-0001 for criterion No open critical or high defects");
});

test("manual re-tests (D37): link from the impacted re-run criterion to the change set's Regression tab; errors and line", () => {
  const rerun = crit({ id: "rr.impacted_rerun", status: "not_evaluable", evidence_refs: [{ type: "test_case", key: "TC-0031" }, { type: "change_set", key: "CHG-0001" }] });
  expect(manualRetestSets(rerun).map((r) => r.key)).toEqual(["CHG-0001"]);
  expect(manualRetestSets({ ...rerun, status: "met" })).toEqual([]);
  expect(manualRetestHref("p1", "CHG-0001")).toBe("/projects/p1/discovery/changes/CHG-0001?tab=regression#manual-retests");
  expect(retestErrors(null, " ")).toEqual({ status: "Choose Passed or Failed.", note: "Add a note: what you did and what you saw." });
  expect(retestErrors("passed", "ok")).toEqual({});
  expect(retestLine({ id: "r", status: "failed", note: "blank page", recorded_by: approver, recorded_at: "x" }, fmt)).toBe("Failed · recorded by A. Approver · 15 Nov 16:00: 'blank page'");
  expect(confirmErrors(null, "")).toEqual({ status: "Choose Met or Not met.", reason: "Say how it was confirmed." });
});

test("what changed since the last assessment", () => {
  const c: Assessment["changes_since"] = {
    previous: { id: "a1", key: "REL-0001", created_at: null, recommendation: "no_go", final_verdict: "no_go", status: "final" },
    recommendation: { from: "no_go", to: "conditional" },
    change_sets: ["CHG-0001"],
    runs: ["RUN-0005"],
    defects: [{ key: "DEF-0001", from: "fixed", to: "verified" }, { key: "DEF-0007", from: null, to: "confirmed" }],
    exploratory_sessions: ["EXP-0001"],
    text: null,
  };
  expect(changesSinceParts(c)).toEqual(["Recommendation No-go → Conditional", "CHG-0001", "RUN-0005", "DEF-0001 Fixed → Verified", "DEF-0007 confirmed", "EXP-0001"]);
  expect(changesSinceParts({ ...c, recommendation: { from: "no_go", to: "no_go" }, change_sets: [], runs: [], defects: [], exploratory_sessions: [] })).toEqual(["Recommendation unchanged (No-go)"]);
  expect(changesSinceParts({ ...c, previous: null })).toEqual([]);
});

test("Overview, header and lifecycle wording (§4.3–4.5)", () => {
  expect(glanceLine(summary(), true)).toBe("4 conditions · overall residual risk: Medium · Gate 9: waiting for your decision");
  expect(glanceLine(summary({ conditions: 1, overall_residual: null }), false)).toBe("1 condition · Gate 9: waiting for approval");
  expect(glanceLine(summary({ status: "final", decision: "override", decided_by: approver }), true)).toBe("4 conditions · overall residual risk: Medium");
  expect(historyFinal(summary({ final_verdict: "go", decision: "override", decided_by: approver }))).toBe("Go · overridden by A. Approver");
  expect(historyFinal(summary({ final_verdict: "no_go", decision: "approve", decided_by: approver }))).toBe("No-go · A. Approver");
  expect(historyFinal(summary())).toBe("—");
  expect(assessmentOption(summary(), true)).toBe("REL-0002 (latest) · Conditional · Recommended");
  expect(assessmentOption(summary({ key: "REL-0001", verdict: "no_go", verdict_state: "final" }), false)).toBe("REL-0001 · No-go · Final");
  expect(headerPill(summary(), true)).toBe("REL-0002 waiting for your decision (Gate 9)");
  expect(headerPill(summary(), false)).toBe("REL-0002 waiting for a Gate 9 decision");
  expect(headerPill(summary({ status: "final" }), true)).toBeNull();
  expect(step21Text({ available: false, assessing: false, latest: null })).toBe("Available after the first test run");
  expect(step21Text({ available: true, assessing: true, latest: null })).toBe("Assessing…");
  expect(step21Text({ available: true, assessing: false, latest: summary() })).toBe("REL-0002: Conditional (recommended)");
  expect(g9Text({ available: true, latest: summary() }, true)).toBe("REL-0002 waiting for your decision");
  expect(g9Text({ available: false, latest: null }, true)).toBe("Available after the first test run");
  expect(g9Chip(summary({ status: "final", verdict: "go" }))).toBe("Gate 9: final Go");
  expect(g9Chip(null)).toBeNull();
});

test("attention rows: approver gets Decide with the #gate-9 link; members Open; viewers no action", () => {
  const base = "/projects/p1";
  expect(releaseAttentionRows(summary(), base, true, false)).toEqual([{ text: "REL-0002 is waiting for your decision (Gate 9): recommended Conditional.", action: "Decide REL-0002", href: "/projects/p1/release-readiness#gate-9" }]);
  expect(releaseAttentionRows(summary(), base, false, false)[0]).toMatchObject({ action: "Open REL-0002", href: "/projects/p1/release-readiness" });
  expect(releaseAttentionRows(summary(), base, false, true)[0]).toMatchObject({ action: "", href: null });
  expect(releaseAttentionRows(summary({ status: "stale" }), base, true, false)[0].text).toBe("REL-0002 is out of date: evidence changed after it was assessed.");
  expect(releaseAttentionRows(summary({ status: "final" }), base, true, false)).toEqual([]);
});

// ---- lifecycle: G9 is live (design P6 §4.3) -----------------------------------------------------------------

function stage(key: StageKey, over: Partial<StageState> = {}): StageState {
  return { key, title: key, phase: 4, available: true, status: "completed", current_version: 1, gate: null, started_at: null, finished_at: null, stale_reason: null, progress: null, ...over };
}
const ALL: StageKey[] = ["intake", "discovery", "discovery_report", "requirements", "readiness_criteria", "test_strategy", "test_design", "traceability", "automation_assessment", "automation", "execution", "failure_analysis", "defects_summary", "performance"];

test("lifecycle: Reporting links to release readiness and G9 follows the latest assessment", () => {
  const wf: Workflow = {
    project_status: "active",
    stages: [...ALL.map((k) => stage(k)), stage("release_readiness", { status: "awaiting_approval", gate: { key: "G9", policy: "required", status: "awaiting_approval", recommendation: null } })],
  };
  const reporting = buildLifecycle(wf, undefined, { available: true, assessing: false, latest: summary() }).find((s) => s.id === "reporting")!;
  expect(reporting.section).toBe("release-readiness");
  expect(reporting.release?.latest?.key).toBe("REL-0002");
  expect(reporting.status).toBe("waiting");
  expect(stageStatusText(reporting)).not.toBe("Phase 6");
  const decided: Workflow = { ...wf, stages: [...ALL.map((k) => stage(k)), stage("release_readiness", { status: "approved", gate: { key: "G9", policy: "required", status: "approved", recommendation: null } })] };
  const final = buildLifecycle(decided, undefined, { available: true, assessing: false, latest: summary({ status: "final", verdict_state: "final" }) }).find((s) => s.id === "reporting")!;
  expect(final.status).toBe("done");
  const running = buildLifecycle(decided, undefined, { available: true, assessing: true, latest: null }).find((s) => s.id === "reporting")!;
  expect(running.status).toBe("running");
});
