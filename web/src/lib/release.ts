// Release readiness and Gate 9 (P6-05b; decisions D32, D33, D37; design P6 §3.7, §3.8, §10). The verdict is worked
// out by rules on the server; this file only words it. "Recommended" and "Final" are always written next to it, and a
// person decides at Gate 9 (approve, reject, or override to a different verdict with a reason of at least 20 characters).

import type { IsoDate, UserRef, Uuid } from "./contract";
import { fmtDateTime } from "./format";

export type Verdict = "go" | "conditional" | "no_go";
export type VerdictState = "recommended" | "final" | "not_decided";
export type AssessmentStatus = "awaiting_approval" | "final" | "rejected" | "stale" | "superseded";
export type CriterionStatus = "met" | "not_met" | "not_evaluable";
export type CriterionSource = "exit_criterion" | "dod" | "platform";
export type Decision = "approve" | "reject" | "override";
export type RiskLevel = "low" | "medium" | "high" | "very_high";

export type EvidenceRef = { type: string; key: string; id?: string | null; label?: string | null; path?: string | null };

export type Criterion = {
  id: string;
  rule: string | null;
  text: string;
  source: CriterionSource;
  source_label: string;
  blocking: boolean;
  status: CriterionStatus;
  detail: string | null;
  evidence_refs: EvidenceRef[];
  measured?: Record<string, unknown> | null;
  confirmable: boolean;
  can_confirm: boolean;
  manual: boolean;
  confirmed_by: UserRef | null;
  confirm_reason: string | null;
  confirmed_at: IsoDate | null;
};

export type Condition = { text: string; criterion_id: string; blocking: boolean; evidence_refs: EvidenceRef[] };

export type ResidualRow = {
  risk: EvidenceRef;
  title: string;
  status: string;
  initial: RiskLevel;
  residual: RiskLevel;
  line: string;
  reduced: boolean;
  tests: { passed: string[]; failed: string[]; not_tested: string[] };
};

export type ChangesSince = {
  previous: { id: Uuid; key: string; created_at: IsoDate | null; recommendation: Verdict; final_verdict: Verdict | null; status: AssessmentStatus } | null;
  recommendation?: { from: Verdict; to: Verdict };
  change_sets?: string[];
  runs?: string[];
  defects?: { key: string; from: string | null; to: string }[];
  exploratory_sessions?: string[];
  criteria?: { id: string; text: string; from: CriterionStatus; to: CriterionStatus }[];
  text: string | null;
};

export type ReleaseSummary = {
  id: Uuid;
  key: string;
  status: AssessmentStatus;
  recommendation: Verdict;
  final_verdict: Verdict | null;
  verdict: Verdict;
  verdict_state: VerdictState;
  decision: Decision | null;
  decided_by: UserRef | null;
  decided_at: IsoDate | null;
  override_line: string | null;
  conditions: number;
  overall_residual: RiskLevel | null;
  stale_reason: string | null;
  superseded_by: string | null;
  created_at: IsoDate | null;
  assessed_at?: IsoDate | null;
};

export type Assessment = ReleaseSummary & {
  reason: string | null;
  statement: string;
  criteria: Criterion[];
  counts: { total: number; met: number; not_met: number; not_evaluable: number; blocking: number; blocking_not_met: number; manual: number };
  conditions_list: Condition[];
  residual_risks: ResidualRow[];
  override_reason: string | null;
  decision_record: { decision: Decision; by: string; at: IsoDate | null; text: string } | null;
  created_by: UserRef | null;
  generated_by: "rules" | "mixed";
  ai_sections: { narrative?: { text: string; generated_by: "ai" | "rules" } } & Record<string, unknown>;
  scope: Record<string, unknown>;
  changes_since: ChangesSince;
  is_latest: boolean;
  latest: { id: Uuid; key: string };
  decidable: boolean;
  not_decidable_reason: string | null;
  permissions: { can_decide: boolean; can_confirm: boolean; can_assess: boolean };
};

export type ReleaseOverview = {
  available: boolean;
  reason: string | null;
  assessing: boolean;
  assessing_text: string | null;
  stage: { status: string; stale_reason: string | null };
  latest: Assessment | null;
  history: ReleaseSummary[];
  statement_template: string;
  permissions: { can_assess: boolean; can_decide: boolean };
};

export type ConfirmResponse = { assessment: Assessment; message: string; verdict_changed: boolean };
export type DecisionResponse = { assessment: Assessment; message: string };

// ---- manual re-tests of impacted manual must-run tests (D37) ---------------------------------------------------

/** D37 re-test; since D39 (P4-14) a manual result: `run_key`/`result_key` say where it is stored (null for legacy rows). */
export type ManualRetest = { id: Uuid; status: "passed" | "failed"; note: string; recorded_by: UserRef | null; recorded_at: IsoDate | null; run_key?: string | null; result_key?: string | null };
export type ManualRetestItem = { case_key: string; title: string | null; test_case_id: Uuid; case_lineage_id: Uuid; reasons: string[]; latest: ManualRetest | null; history: ManualRetest[] };
export type ManualRetests = {
  change_set: { id: Uuid; key: string };
  items: ManualRetestItem[];
  counts: { total: number; recorded: number; open: number };
  permissions: { can_record: boolean };
  message?: string;
};

/** The server's "not runnable" reason on an impacted manual must-run test (backend services/impact.py MUST_MANUAL). */
export const MUST_MANUAL = "Manual test: a person runs it (not part of the automated run)";
export const RETEST_STATUS_ERROR = "Choose Passed or Failed.";
export const RETEST_NOTE_ERROR = "Describe what happened.";

export function retestErrors(status: "passed" | "failed" | null, note: string): { status?: string; note?: string } {
  const out: { status?: string; note?: string } = {};
  if (!status) out.status = RETEST_STATUS_ERROR;
  if (!note.trim()) out.note = RETEST_NOTE_ERROR;
  return out;
}

/** "Passed · By hand · Recorded by M. Member · 15 Nov 16:00: 'what happened'" — a recorded manual re-test, in the
 * vocabulary of every manual result (P4-14 §4.6). */
export function retestLine(r: ManualRetest, fmt: (iso: string | null | undefined) => string): string {
  return `${r.status === "passed" ? "Passed" : "Failed"} · By hand · Recorded by ${who(r.recorded_by)} · ${fmt(r.recorded_at)}: '${r.note}'`;
}

// ---- vocabulary (design P6 §3.7, §3.8) -----------------------------------------------------------------------

/** design P6 §3.8 `RELEASE_STATEMENT(time)`; never edited per screen. */
export function RELEASE_STATEMENT(time: string): string {
  return `This recommendation is based on the tests the platform ran and the evidence recorded up to ${time}. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it.`;
}

export const VERDICT_LABEL: Record<Verdict, string> = { go: "Go", conditional: "Conditional", no_go: "No-go" };
export const STATE_WORD: Record<VerdictState, string> = { recommended: "Recommended", final: "Final", not_decided: "Not decided" };
export const CRITERION_STATUS_LABEL: Record<CriterionStatus, string> = { met: "Met", not_met: "Not met", not_evaluable: "Not evaluable" };
export const ASSESSMENT_STATUS_LABEL: Record<AssessmentStatus, string> = {
  awaiting_approval: "Waiting for Gate 9",
  final: "Final",
  rejected: "Rejected",
  stale: "Out of date",
  superseded: "Replaced",
};
export const LEVEL_LABEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High", very_high: "Very high" };
export const VERDICTS: Verdict[] = ["go", "conditional", "no_go"];

export const NO_RUN = "Run the tests first: release readiness needs execution results.";
export const NO_RUN_EMPTY = "Release readiness needs test results. Run the tests first.";
export const NOT_ASSESSED = "Not assessed yet. The platform checks the exit criteria and recommends Go, Conditional or No-go. A person decides at Gate 9.";
export const ASSESSING = "Assessing: reading results, defects, risks, changes and exploration…";
export const OFFLINE_ASSESS = "You're offline. Reconnect to assess.";
export const OFFLINE_DECIDE = "You're offline. Reconnect to decide.";
export const OFFLINE_CONFIRM = "You're offline. Reconnect to confirm a result.";
export const LOAD_ERROR = "Couldn't load release readiness. Try again.";
export const MEMBER_G9 = "Deciding Gate 9 needs approval permission. Someone who can approve will see this assessment. You can still confirm criteria the platform can't check.";
export const CHOOSE_DECISION = "Choose a decision.";
export const CHOOSE_VERDICT = "Choose a final verdict.";
export const OVERRIDE_REASON = "Write at least 20 characters. The reason is shown next to the verdict.";
export const REJECT_REASON = "Say why. The reason is shown on the assessment.";
export const CONFIRM_STATUS = "Choose Met or Not met.";
export const CONFIRM_REASON = "Say how it was confirmed.";
export const OVERRIDE_MIN = 20;

const who = (u: UserRef | null | undefined) => u?.full_name || u?.email || "someone";

/** The fixed statement for an assessment, from its snapshot time. */
export function statementFor(a: Pick<Assessment, "assessed_at" | "created_at">): string {
  // design P6 §3.8: `{time}` is fmtDateTime of the snapshot, the same format as every other time on the page.
  return RELEASE_STATEMENT(fmtDateTime(a.assessed_at ?? a.created_at));
}

/** "Conditional · Recommended": the verdict is never shown alone (design P6 §3.7). */
export function verdictText(a: Pick<ReleaseSummary, "verdict" | "verdict_state">): string {
  return `${VERDICT_LABEL[a.verdict]} · ${STATE_WORD[a.verdict_state]}`;
}

/** The verdict card's heading: "Final verdict" once decided, else "Recommendation". */
export function cardHeading(a: Pick<ReleaseSummary, "status">): string {
  return a.status === "final" ? "Final verdict" : "Recommendation";
}

/** "Overridden by A. Approver: 'reason' (recommended: Conditional)"; null unless overridden. */
export function overrideText(a: Pick<Assessment, "decision" | "decided_by" | "override_reason" | "recommendation">): string | null {
  if (a.decision !== "override") return null;
  return `Overridden by ${who(a.decided_by)}: '${a.override_reason ?? ""}' (recommended: ${VERDICT_LABEL[a.recommendation]})`;
}

/** Gate 9 in a few words, role-aware (design P6 §10.1 card line, §4.3, §4.5). */
export function gate9State(a: Pick<ReleaseSummary, "status" | "decision" | "decided_by" | "superseded_by">, canApprove: boolean): string {
  switch (a.status) {
    case "awaiting_approval":
      return canApprove ? "waiting for your decision" : "waiting for a decision by someone who can approve";
    case "final":
      return a.decision === "override" ? `overridden by ${who(a.decided_by)}` : `approved by ${who(a.decided_by)}`;
    case "rejected":
      return `rejected by ${who(a.decided_by)}`;
    case "stale":
      return "out of date: assess again";
    case "superseded":
      return a.superseded_by ? `replaced by ${a.superseded_by}` : "replaced";
  }
}

/** The G9 panel pill (design P6 §10.3). */
export function panelPill(a: Pick<ReleaseSummary, "status" | "superseded_by">, canApprove: boolean): { text: string; tone: "amber" | "green" | "grey" } {
  switch (a.status) {
    case "awaiting_approval":
      return { text: canApprove ? "Waiting for your decision" : "Waiting for a decision by someone who can approve", tone: "amber" };
    case "final":
      return { text: "Final", tone: "green" };
    case "rejected":
      return { text: "Rejected", tone: "grey" };
    case "stale":
      return { text: "Out of date", tone: "amber" };
    case "superseded":
      return { text: a.superseded_by ? `Replaced by ${a.superseded_by}` : "Replaced", tone: "grey" };
  }
}

/** The decision record (all roles, design P6 §10.3), with the time. */
export function decisionRecordText(a: Pick<Assessment, "decision" | "decided_by" | "decided_at" | "override_reason" | "recommendation" | "final_verdict">, fmt: (iso: string | null | undefined) => string): string | null {
  if (!a.decision) return null;
  const by = who(a.decided_by);
  const at = a.decided_at ? fmt(a.decided_at) : null;
  if (a.decision === "reject") return `Rejected by ${by}: '${a.override_reason ?? ""}'${at ? ` · ${at}` : ""}. Assess again when ready.`;
  const final = VERDICT_LABEL[a.final_verdict ?? a.recommendation];
  if (a.decision === "override") return `Final verdict: ${final} · Overridden by ${by}: '${a.override_reason ?? ""}' · recommended: ${VERDICT_LABEL[a.recommendation]}${at ? ` · ${at}` : ""}`;
  return `Final verdict: ${final} · approved by ${by}${at ? ` · ${at}` : ""}`;
}

/** "Evidence changed after this assessment (RUN-0006 finished at 16:20). It can't be decided. …" */
export function staleText(reason: string | null | undefined): string {
  return `Evidence changed after this assessment${reason ? ` (${reason.replace(/\.$/, "")})` : ""}. It can't be decided. Assess again to include the new evidence.`;
}

export function supersededText(byKey: string | null, at: string | null): string {
  return `Replaced by ${byKey ?? "a newer assessment"}${at ? ` (${at})` : ""}. This assessment can't be decided.`;
}

/** History "Final" cell: "Go · overridden by A. Approver" / "No-go · A. Approver" / "—". */
export function historyFinal(a: Pick<ReleaseSummary, "final_verdict" | "decision" | "decided_by">): string {
  if (!a.final_verdict) return "—";
  return a.decision === "override" ? `${VERDICT_LABEL[a.final_verdict]} · overridden by ${who(a.decided_by)}` : `${VERDICT_LABEL[a.final_verdict]} · ${who(a.decided_by)}`;
}

/** Assessment selector option: "REL-0002 (latest) · Conditional · Recommended" (the verdict never alone, §3.7). */
export function assessmentOption(a: Pick<ReleaseSummary, "key" | "verdict" | "verdict_state">, latest: boolean): string {
  return `${a.key}${latest ? " (latest)" : ""} · ${verdictText(a)}`;
}

/** "You're viewing REL-0001 (Final: No-go). The latest is REL-0002." */
export function olderText(a: Pick<ReleaseSummary, "key" | "verdict" | "verdict_state">, latestKey: string): string {
  return `You're viewing ${a.key} (${STATE_WORD[a.verdict_state]}: ${VERDICT_LABEL[a.verdict]}). The latest is ${latestKey}.`;
}

// ---- criteria table (design P6 §10.1) -------------------------------------------------------------------------

export type StatusFilter = CriterionStatus | "";
export const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "Any" },
  { value: "not_met", label: "Not met" },
  { value: "not_evaluable", label: "Not evaluable" },
  { value: "met", label: "Met" },
];

const STATUS_RANK: Record<CriterionStatus, number> = { not_met: 0, not_evaluable: 1, met: 2 };

/** The rows shown: filtered by status; "Blocking first" keeps the server's order within blocking and not blocking. */
export function criteriaRows(list: Criterion[], status: StatusFilter, blockingFirst: boolean): Criterion[] {
  const rows = list.filter((c) => !status || c.status === status);
  if (!blockingFirst) return rows;
  return rows
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(b.c.blocking) - Number(a.c.blocking) || a.i - b.i)
    .map((x) => x.c);
}

/** "Open DEF-0001 for criterion No open critical or high defects" (design P6 §16.1 unique names). */
export function evidenceName(ref: EvidenceRef, c: Pick<Criterion, "text">): string {
  return `Open ${ref.key} for criterion ${c.text}`;
}

/** Change sets named by `rr.impacted_rerun` while a manual must-run test has no recorded re-test (D37). */
export function manualRetestSets(c: Criterion): EvidenceRef[] {
  if (c.id !== "rr.impacted_rerun" || c.status !== "not_evaluable") return [];
  return c.evidence_refs.filter((r) => r.type === "change_set");
}

/** Where a person records the re-test of an impacted manual test: the change set's Regression run tab. */
export function manualRetestHref(projectId: string, changeSetKey: string): string {
  return `/projects/${projectId}/discovery/changes/${changeSetKey}?tab=regression#manual-retests`;
}

export function statusRank(s: CriterionStatus): number {
  return STATUS_RANK[s];
}

// ---- Gate 9 (D33) ---------------------------------------------------------------------------------------------

/** Override offers only verdicts different from the recommendation (design P6 §10.3). */
export function overrideOptions(recommendation: Verdict): Verdict[] {
  return VERDICTS.filter((v) => v !== recommendation);
}

export type DecisionErrors = { decision?: string; verdict?: string; reason?: string };

/** Checks on [Record decision…] (submit, never blur). */
export function decisionErrors(decision: Decision | null, finalVerdict: Verdict | null, reason: string, recommendation: Verdict): DecisionErrors {
  if (!decision) return { decision: CHOOSE_DECISION };
  const out: DecisionErrors = {};
  if (decision === "override") {
    if (!finalVerdict || finalVerdict === recommendation) out.verdict = CHOOSE_VERDICT;
    if (reason.trim().length < OVERRIDE_MIN) out.reason = OVERRIDE_REASON;
  }
  if (decision === "reject" && !reason.trim()) out.reason = REJECT_REASON;
  return out;
}

/** "12 of 20 characters" (the counter is in the field's description, read on focus). */
export function counterText(reason: string): string {
  return `${reason.trim().length} of ${OVERRIDE_MIN} characters`;
}

/** Blocking criteria not met, worded for the override-to-Go warning: "No open critical or high defects (DEF-0001, major)". */
export function unmetBlocking(criteria: Criterion[]): string[] {
  return criteria
    .filter((c) => c.blocking && c.status === "not_met")
    .map((c) => {
      // "DEF-0001 (major)" → "DEF-0001, major", so the list reads "(DEF-0001, major)".
      const refs = c.evidence_refs.filter((r) => r.type !== "change_set").map((r) => (r.label || r.key).replace(/^(\S+) \((.+)\)$/, "$1, $2"));
      return refs.length ? `${c.text} (${refs.join(", ")})` : c.text;
    });
}

export type DecisionConfirm = { title: string; body: string; danger: string | null; confirmLabel: string };

/** The confirmation text per decision (design P6 §10.3). */
export function decisionConfirm(a: Pick<Assessment, "key" | "recommendation" | "criteria">, decision: Decision, finalVerdict: Verdict | null, reason: string, name: string): DecisionConfirm {
  const rec = VERDICT_LABEL[a.recommendation];
  if (decision === "reject")
    return { title: `Reject ${a.key}?`, body: `Reject ${a.key}? Nothing is decided and Gate 9 goes back to 'changes requested'.`, danger: null, confirmLabel: "Reject assessment" };
  if (decision === "override") {
    const to = VERDICT_LABEL[finalVerdict ?? a.recommendation];
    const unmet = finalVerdict === "go" ? unmetBlocking(a.criteria) : [];
    return {
      title: "Override the recommendation?",
      body: `Override the recommendation? Final verdict: ${to} (recommended: ${rec}). Your reason is shown as 'Overridden by ${name}: ${reason.trim()}' next to the verdict, in the Release Readiness Report and in the audit log.`,
      danger: unmet.length ? `Blocking criteria not met: ${unmet.join("; ")}.` : null,
      confirmLabel: `Override to ${to}`,
    };
  }
  if (a.recommendation === "no_go")
    return { title: `Approve ${a.key}?`, body: `Make No-go the final verdict for ${a.key}? The report will say the release should not go ahead.`, danger: null, confirmLabel: "Approve: No-go" };
  return {
    title: `Approve ${a.key}?`,
    body: `Make ${rec} the final verdict for ${a.key}? The Release Readiness Report loses its DRAFT band and names you as the decider.`,
    danger: null,
    confirmLabel: `Approve: ${rec}`,
  };
}

// ---- confirm a criterion (design P6 §10.4) --------------------------------------------------------------------

export function confirmErrors(status: "met" | "not_met" | null, reason: string): { status?: string; reason?: string } {
  const out: { status?: string; reason?: string } = {};
  if (!status) out.status = CONFIRM_STATUS;
  if (!reason.trim()) out.reason = CONFIRM_REASON;
  return out;
}

// ---- what changed since the last assessment (design P6 §10.1) -------------------------------------------------

const DEFECT_WORD: Record<string, string> = { draft: "drafted", confirmed: "confirmed", fixed: "Fixed", verified: "Verified", closed: "Closed", rejected: "rejected", reopened: "reopened" };

/** The text list: "Recommendation No-go → Conditional", "CHG-0001", "DEF-0001 Fixed → Verified", … */
export function changesSinceParts(c: ChangesSince): string[] {
  if (!c.previous) return [];
  const out: string[] = [];
  const r = c.recommendation;
  out.push(r && r.from !== r.to ? `Recommendation ${VERDICT_LABEL[r.from]} → ${VERDICT_LABEL[r.to]}` : `Recommendation unchanged (${VERDICT_LABEL[c.previous.recommendation]})`);
  out.push(...(c.change_sets ?? []), ...(c.runs ?? []));
  for (const d of c.defects ?? []) out.push(d.from ? `${d.key} ${DEFECT_WORD[d.from] ?? d.from} → ${DEFECT_WORD[d.to] ?? d.to}` : `${d.key} ${DEFECT_WORD[d.to] ?? d.to}`);
  out.push(...(c.exploratory_sessions ?? []));
  return out;
}

/** "Impacted tests re-run since the change: Not met → Met" */
export function criterionChangeText(x: { text: string; from: CriterionStatus; to: CriterionStatus }): string {
  return `${x.text}: ${CRITERION_STATUS_LABEL[x.from]} → ${CRITERION_STATUS_LABEL[x.to]}`;
}

// ---- toasts, the Overview card and the lifecycle (design P6 §4.3, §4.5, §10.2) ---------------------------------

/** "REL-0003: Conditional (recommended)." */
export function assessedToast(a: Pick<ReleaseSummary, "key" | "recommendation">): string {
  return `${a.key}: ${VERDICT_LABEL[a.recommendation]} (recommended).`;
}

export function assessError(reason: string): string {
  return `Couldn't assess release readiness: ${reason.replace(/\.$/, "")}. Nothing was changed.`;
}

/** The Overview card's second line: "4 conditions · overall residual risk: Medium · Gate 9: waiting for approval". */
export function glanceLine(a: ReleaseSummary, canApprove: boolean): string {
  const bits = [`${a.conditions} condition${a.conditions === 1 ? "" : "s"}`];
  if (a.overall_residual) bits.push(`overall residual risk: ${LEVEL_LABEL[a.overall_residual]}`);
  // An override already reads "Overridden by {name}: '{reason}'" on its own line: Gate 9 isn't repeated.
  if (a.decision === "override" && a.status === "final") return bits.join(" · ");
  bits.push(`Gate 9: ${a.status === "awaiting_approval" ? (canApprove ? "waiting for your decision" : "waiting for approval") : gate9State(a, canApprove)}`);
  return bits.join(" · ");
}

/** "Final: Go · overridden by A. Approver" / "Final: Conditional · A. Approver"; null unless final. */
export function finalLine(a: Pick<ReleaseSummary, "status" | "verdict" | "decision" | "decided_by">): string | null {
  if (a.status !== "final") return null;
  return a.decision === "override" ? `Final: ${VERDICT_LABEL[a.verdict]} · overridden by ${who(a.decided_by)}` : `Final: ${VERDICT_LABEL[a.verdict]} · ${who(a.decided_by)}`;
}

/** The summary's "Overridden by A. Approver: reason" with the reason quoted, as on the page (design P6 §19 check 35). */
export function quotedOverride(line: string): string {
  const i = line.indexOf(": ");
  return i < 0 ? line : `${line.slice(0, i)}: '${line.slice(i + 2)}'`;
}

/** Lifecycle step 21's status text (design P6 §4.3). */
export function step21Text(r: { available: boolean; assessing: boolean; latest: ReleaseSummary | null }): string {
  if (r.assessing) return "Assessing…";
  if (r.latest) return `${r.latest.key}: ${VERDICT_LABEL[r.latest.recommendation]} (recommended)`;
  if (!r.available) return AVAILABLE_AFTER_RUN;
  return "Starts when someone assesses release readiness (after a test run).";
}

export const AVAILABLE_AFTER_RUN = "Available after the first test run";

/** Lifecycle G9 row text (design P6 §4.3). */
export function g9Text(r: { available: boolean; latest: ReleaseSummary | null }, canApprove: boolean): string {
  const a = r.latest;
  if (!a) return r.available ? "Not started" : AVAILABLE_AFTER_RUN;
  switch (a.status) {
    case "awaiting_approval":
      return `${a.key} waiting for ${canApprove ? "your decision" : "a decision by someone who can approve"}`;
    case "final":
      return finalLine(a) ?? "Final";
    case "rejected":
      return "Rejected: assess again";
    case "stale":
      return "Out of date: assess again";
    case "superseded":
      return "Not started";
  }
}

/** Compact lifecycle chip "Gate 9: {state}" once an assessment exists. */
export function g9Chip(a: ReleaseSummary | null): string | null {
  if (!a) return null;
  const state = { awaiting_approval: "waiting", final: `final ${VERDICT_LABEL[a.verdict]}`, rejected: "rejected", stale: "out of date", superseded: "replaced" }[a.status];
  return `Gate 9: ${state}`;
}

/** Header pill (design P6 §4.4): only while an assessment waits for Gate 9. */
export function headerPill(a: ReleaseSummary | null | undefined, canApprove: boolean): string | null {
  if (!a || a.status !== "awaiting_approval") return null;
  return canApprove ? `${a.key} waiting for your decision (Gate 9)` : `${a.key} waiting for a Gate 9 decision`;
}

/** Overview "Needs your attention" rows (design P6 §4.5). */
export function releaseAttentionRows(a: ReleaseSummary | null | undefined, base: string, canApprove: boolean, viewer: boolean): { text: string; action: string; href: string | null }[] {
  if (!a) return [];
  const page = `${base}/release-readiness`;
  if (a.status === "awaiting_approval") {
    if (canApprove && !viewer) return [{ text: `${a.key} is waiting for your decision (Gate 9): recommended ${VERDICT_LABEL[a.recommendation]}.`, action: `Decide ${a.key}`, href: `${page}#gate-9` }];
    return [{ text: `${a.key} is waiting for a Gate 9 decision by someone who can approve.`, action: viewer ? "" : `Open ${a.key}`, href: viewer ? null : page }];
  }
  if (a.status === "stale") return [{ text: `${a.key} is out of date: evidence changed after it was assessed.`, action: viewer ? "" : "Assess again", href: viewer ? null : page }];
  return [];
}
