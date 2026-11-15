// Defects and Gate 8 (P4-09, decision D11; design docs/design/P4-qa-analyst-phase4.md §3, §11): API shapes as built
// (backend app/api/routers/defects.py) and the pure helpers the screens use.

import type { IsoDate, Uuid } from "@/lib/contract";
import type { Tone } from "@/components/ui/StatusPill";
import type { Classification, Confidence, Person, ResultDetail, ResultEvidence, Signal } from "@/lib/execution";

export type DefectStatus = "draft" | "confirmed" | "rejected" | "fixed" | "verified" | "closed";
export type Severity = "critical" | "major" | "minor" | "trivial";
export type DefectPriority = "critical" | "high" | "medium" | "low";
export type DefectAction = "confirm" | "reject" | "fixed" | "verified" | "closed";
export type RejectReason = "not_a_defect" | "duplicate" | "works_as_intended" | "cannot_reproduce" | "test_problem" | "accepted_risk";

export type Reproducibility = { attempts_failed?: number; attempts?: number; kind?: "always" | "intermittent"; occurrences?: number; text?: string };

export type DefectRow = {
  id: Uuid;
  key: string;
  summary: string;
  severity: Severity;
  priority: DefectPriority;
  status: DefectStatus;
  source: "analysis" | "user" | "accessibility" | "security" | "performance";
  /** Observed "Why" line of a non-functional draft (design P5 §10); null otherwise. */
  why?: string | null;
  reproducibility: Reproducibility;
  cases: string[];
  requirements: string[];
  run_key: string | null;
  result_key: string | null;
  last_seen: IsoDate | null;
  version: number;
  created_at: IsoDate;
  /** null = allowed; "permission" = needs another role; else the reason it doesn't apply. */
  actions: Record<DefectAction, string | null>;
};

export type DefectList = {
  items: DefectRow[];
  counts: Record<DefectStatus, number>;
  finished_runs: number;
  permissions: { can_raise: boolean; can_decide: boolean };
};

export type DefectDetail = DefectRow & {
  description: string;
  environment: { url?: string; browser?: string; viewport?: string; run_key?: string; result_key?: string; date?: string; failed_step?: string; script_version?: number; duplicate_of?: string; related_to?: string;
    // Phase 5 (P5-02/P5-01c): non-functional drafts
    scan_key?: string; rule_id?: string; axe?: string | null; pages?: string[]; engine?: string; profile?: string; virtual_users?: number;
    occurrences?: { scan_key?: string; run_key?: string; pages?: number; added?: boolean; measured?: number | null; at?: string }[] };
  preconditions: string[];
  steps: string[];
  expected: string;
  actual: string;
  severity_derived: Severity;
  severity_reason: string | null;
  priority_derived: DefectPriority;
  priority_reason: string | null;
  root_cause_hypothesis: string | null;
  status_reason: RejectReason | null;
  status_comment: string | null;
  evidence: ResultEvidence[];
  result: { id: Uuid; key: string; status: string } | null;
  analysis: { classification: Classification; label: string; confidence: Confidence; signals: Signal[]; generated_by: string } | null;
  script: { id: Uuid; path: string; version: number } | null;
  occurrences: { result_id: Uuid; result_key: string | null; run_key: string | null; seen_at: IsoDate; status: string | null }[];
  g8: { decision: string; by: Person; at: IsoDate; comment: string | null } | null;
  verify: { ready: boolean; message: string } | null;
  permissions: { can_edit: boolean; can_decide: boolean };
};

export const DEFECT_STATUS: Record<DefectStatus, { label: string; tone: Tone; note?: string; status: string }> = {
  draft: { label: "Draft", tone: "amber", note: "waiting for review", status: "draft" },
  confirmed: { label: "Confirmed", tone: "red", status: "failed" },
  rejected: { label: "Rejected", tone: "grey", status: "rejected" },
  fixed: { label: "Fixed", tone: "blue", note: "needs verifying", status: "queued" },
  verified: { label: "Verified", tone: "green", status: "completed" },
  closed: { label: "Closed", tone: "grey", status: "cancelled" },
};

export const SEVERITY_TEXT: Record<Severity, string> = { critical: "Critical", major: "Major", minor: "Minor", trivial: "Trivial" };
export const PRIORITY_TEXT: Record<DefectPriority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const REJECT_REASONS: { value: RejectReason; label: string }[] = [
  { value: "not_a_defect", label: "Not a defect" },
  { value: "duplicate", label: "Duplicate" },
  { value: "works_as_intended", label: "Works as intended" },
  { value: "cannot_reproduce", label: "Can't reproduce" },
  { value: "test_problem", label: "Problem with the test" },
];
/** Non-functional drafts only (design P5 §10, open question 2). */
export const ACCEPTED_RISK_REASON: { value: RejectReason; label: string } = { value: "accepted_risk", label: "Accepted risk" };
export const NON_FUNCTIONAL_SOURCES = ["accessibility", "security", "performance"] as const;
export const isNonFunctional = (source: string | null | undefined) => (NON_FUNCTIONAL_SOURCES as readonly string[]).includes(source ?? "");
/** Source chip text (design P5 §10). */
export const SOURCE_TEXT: Record<DefectRow["source"], string> = { analysis: "Functional", user: "Functional", accessibility: "Accessibility", security: "Security", performance: "Performance" };
export const rejectReasonText = (r: string | null | undefined) => [...REJECT_REASONS, ACCEPTED_RISK_REASON].find((x) => x.value === r)?.label ?? r ?? "";

/** Defect detail Environment line (design P5 §10): check/run facts for non-functional drafts, run facts otherwise. */
export function environmentLine(d: Pick<DefectDetail, "source" | "environment">, fmt: (iso: string) => string): string {
  const env = d.environment ?? {};
  const vp = env.viewport ? (env.viewport === "desktop" ? "Desktop 1440 × 900" : env.viewport === "mobile" ? "Phone 390 × 844" : env.viewport.replace("x", " × ")) : null;
  const parts =
    d.source === "performance"
      ? [env.url, env.engine, env.profile, env.run_key, env.virtual_users ? `${env.virtual_users} virtual users` : null]
      : d.source === "accessibility" || d.source === "security"
        ? [env.url, env.browser, vp, env.scan_key]
        : [env.url, env.browser, env.viewport ? env.viewport.replace("x", " × ") : null, env.run_key, env.date ? fmt(env.date) : null];
  return parts.filter(Boolean).join(" · ") || "None";
}

/** Occurrences of a non-functional defect: "A11Y-0001 · 2 pages", "A11Y-0002 · 2 pages (added)", "PERF-0001". */
export function nfOccurrences(d: Pick<DefectDetail, "environment">): string[] {
  return (d.environment?.occurrences ?? []).map((o) =>
    o.scan_key ? `${o.scan_key} · ${o.pages ?? 0} page${o.pages === 1 ? "" : "s"}${o.added ? " (added)" : ""}` : `${o.run_key ?? ""}`,
  );
}

export const NF_ROOT_CAUSE = "Not analysed. Automated checks measure what happens, not why.";

export const OPEN: DefectStatus[] = ["draft", "confirmed", "fixed"];

export const ACTION_TEXT: Record<DefectAction, { verb: string; done: string }> = {
  confirm: { verb: "Confirm", done: "confirmed" },
  reject: { verb: "Reject", done: "rejected" },
  fixed: { verb: "Mark fixed", done: "marked fixed" },
  verified: { verb: "Mark verified", done: "verified" },
  closed: { verb: "Close", done: "closed" },
};

/** Bulk plan (§11.2, P3 §6.3 pattern): which selected rows the action applies to, and why the rest are skipped. */
export function bulkPlan(rows: DefectRow[], action: DefectAction): { apply: DefectRow[]; skipped: { key: string; reason: string }[] } {
  const apply: DefectRow[] = [];
  const skipped: { key: string; reason: string }[] = [];
  for (const r of rows) {
    const why = r.actions[action];
    if (why === null) apply.push(r);
    else skipped.push({ key: r.key, reason: why === "permission" ? "needs gate-approval permission" : why.replace(/\.$/, "") });
  }
  return { apply: apply.slice(0, 100), skipped };
}

/** "Confirm 5 defects? 2 can't be confirmed: they aren't drafts." */
export function bulkQuestion(action: DefectAction, selected: number, skipped: { reason: string }[]): string {
  const verb = ACTION_TEXT[action];
  const q = `${verb.verb} ${selected} defect${selected === 1 ? "" : "s"}?`;
  if (!skipped.length) return q;
  const reasons = [...new Set(skipped.map((s) => s.reason.charAt(0).toLowerCase() + s.reason.slice(1)))].join("; ");
  return `${q} ${skipped.length} can't be ${verb.done}: ${reasons}.`;
}

/** After a decision, the next undecided draft's id (focus moves there, §17), or null. */
export function nextUndecided(drafts: { id: string }[], decidedId: string): string | null {
  const i = drafts.findIndex((d) => d.id === decidedId);
  const rest = drafts.filter((d) => d.id !== decidedId);
  if (!rest.length) return null;
  return (rest[Math.max(0, Math.min(i, rest.length - 1))] ?? rest[0]).id;
}

/** Empty-state copy (§11.6). */
export function emptyDefectsText(finishedRuns: number): string {
  if (!finishedRuns) return "Defects appear here when a test run finds a likely bug in the application, or when someone raises one.";
  return `No defects. ${finishedRuns} run${finishedRuns === 1 ? "" : "s"} finished; no failure was classified as a likely application bug.`;
}

/** "2 of 2 attempts (always)" (falls back to the counts when `text` is absent). */
export function reproText(r: Reproducibility | null | undefined): string {
  if (!r) return "None";
  if (r.text) return r.text;
  if (r.attempts) return `${r.attempts_failed ?? r.attempts} of ${r.attempts} attempts (${r.kind ?? "always"})`;
  return "Not recorded";
}

/** Raise-a-defect prefill from a result (§11.5): executed step titles, the case's expected result, what the page
 * showed. The server links the result and fills the environment. */
export function prefillFrom(r: ResultDetail): { summary: string; description: string; steps: string; expected: string; actual: string } {
  const last = r.attempt_details[r.attempt_details.length - 1];
  return {
    summary: r.title ? `${r.title}: ${r.status === "error" ? "the test couldn't finish" : "fails"}` : "",
    description: r.analysis?.summary ?? "",
    steps: (last?.steps ?? []).map((s) => s.title).join("\n") || (r.case?.steps ?? []).map((s) => s.action).join("\n"),
    expected: r.case?.expected_result ?? "",
    actual: r.actual_result ?? "",
  };
}
