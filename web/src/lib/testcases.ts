// Test design (design P3 §5–§13): techniques, priority, lint vocabulary, list filters, the bulk-approve guard,
// visible values and the Gate 5 checks. Pure functions, unit-tested in tests/unit/phase3.spec.ts.

import type {
  CaseStatus,
  Gaps,
  LintCode,
  LintItem,
  Priority,
  RiskLevel,
  StageGate,
  Suite,
  Technique,
  TestCaseDetail,
  TestCaseSummary,
  TestStepInput,
} from "./contract";

// ---- Techniques (§7.4) -------------------------------------------------------------------

export const TECHNIQUES: Record<Technique, { short: string; name: string; definition: string }> = {
  equivalence_partitioning: {
    short: "EP",
    name: "Equivalence partitioning",
    definition: "Splits inputs into groups the application should treat the same way, and tests one value from each group.",
  },
  boundary_value_analysis: { short: "BVA", name: "Boundary value analysis", definition: "Tests the values at the edges of what’s allowed, where mistakes are most likely." },
  decision_table: { short: "DT", name: "Decision table", definition: "Tests each combination of conditions that leads to a different outcome." },
  state_transition: { short: "ST", name: "State transition", definition: "Tests moving between states, such as signed out to signed in." },
  use_case: { short: "UC", name: "Use case", definition: "Follows a complete task the way a user would." },
  error_guessing: { short: "EG", name: "Error guessing", definition: "Tries inputs and actions that often cause problems, based on experience." },
  checklist: { short: "CL", name: "Checklist", definition: "A fixed list of quality checks." },
  exploratory: { short: "EX", name: "Exploratory", definition: "Not designed in Phase 3." },
  other: { short: "—", name: "Other", definition: "Written by a person without a named technique." },
};

/** The techniques offered in filters and the edit form (exploratory isn't designed in Phase 3). */
export const TECHNIQUE_OPTIONS: Technique[] = [
  "equivalence_partitioning",
  "boundary_value_analysis",
  "decision_table",
  "state_transition",
  "use_case",
  "error_guessing",
  "checklist",
  "other",
];

/** Techniques a person can pick for a new case: only values the API accepts ("other" is display-only). */
export const CASE_FORM_TECHNIQUES: Technique[] = TECHNIQUE_OPTIONS.filter((t) => t !== "other");

export function techniqueInfo(t: string | null | undefined) {
  return TECHNIQUES[(t ?? "other") as Technique] ?? { short: "—", name: t ? t.replace(/_/g, " ") : "Other", definition: "" };
}

// ---- Priority (§3, §10) ------------------------------------------------------------------

export const PRIORITY_TEXT: Record<Priority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const RISK_LEVEL_TEXT: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High", very_high: "Very high" };

/** The priority a risk level gives (P3-05): very high → critical, high → high, medium → medium, low/none → low. */
export function priorityFromRisk(level: RiskLevel | null | undefined): Priority {
  return level === "very_high" ? "critical" : level === "high" ? "high" : level === "medium" ? "medium" : "low";
}

/** An override below the derived priority for a High or Very high risk gets the Advice "Priority lower than its risk". */
export function overrideBelowRisk(override: Priority, derived: Priority, risk: RiskLevel | null | undefined): boolean {
  return (risk === "high" || risk === "very_high") && PRIORITY_ORDER[override] > PRIORITY_ORDER[derived];
}

// ---- Statuses ------------------------------------------------------------------------------

export const CASE_STATUS_TEXT: Record<CaseStatus, string> = { draft: "Draft", approved: "Approved", rejected: "Rejected", deprecated: "Deprecated" };

export const SUITE_TEXT: Record<Suite, string> = { smoke: "Smoke", regression: "Regression" };

export const LEVEL_TEXT_CASE: Record<string, string> = {
  component: "Component",
  component_integration: "Component integration",
  system: "System",
  system_integration: "System integration",
  acceptance: "Acceptance",
};

export function caseLevelText(level: string): string {
  return LEVEL_TEXT_CASE[level] ?? level.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function caseTypeText(type: string): string {
  return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const SIDE_EFFECT_TEXT: Record<string, string> = {
  submits_form: "Submits a form",
  signs_in: "Signs in",
  creates_data: "Creates data",
  external_transaction: "External transaction",
};

export const AUTOMATION_TEXT: Record<string, string> = { suitable: "Suitable", partial: "Partly automatable", manual_only: "Manual only" };

// ---- Lint vocabulary (§8.6) -----------------------------------------------------------------

export type LintSeverity = "must" | "advice";

export const LINT_DEFS: Record<LintCode, { severity: LintSeverity; name: string; hint: string }> = {
  missing_steps: { severity: "must", name: "No steps", hint: "Add at least one step." },
  missing_expected_result: { severity: "must", name: "Missing expected result", hint: "Write what should happen." },
  orphan_case: { severity: "must", name: "Not linked to a requirement", hint: "Link the requirement this case checks." },
  unresolved_placeholder: { severity: "must", name: "Unfinished text", hint: "Replace the placeholder with the real wording." },
  technique_data_mismatch: {
    severity: "must",
    name: "Data doesn’t match the technique",
    hint: "A boundary value case needs test data at the boundary. Add it, or change the technique.",
  },
  literal_secret: { severity: "must", name: "Password typed into the case", hint: "Use the saved test account instead of a typed password." },
  non_synthetic_data: { severity: "must", name: "Real-looking data", hint: "Use synthetic data, such as an example.com email." },
  open_question: { severity: "must", name: "Open question", hint: "Write the expected result, or resolve the requirement and regenerate." },
  vague_wording: { severity: "advice", name: "Vague wording", hint: "Say exactly what the user sees, e.g. ‘The error \"Name is required\" is shown’." },
  too_many_steps: { severity: "advice", name: "More than 15 steps", hint: "Split it into smaller cases." },
  duplicate_case: { severity: "advice", name: "Same as another case", hint: "Reject one, or change its data." },
  type_not_in_strategy: { severity: "advice", name: "Test type not in the strategy", hint: "Change the type, or add it to the Test Strategy." },
  linked_requirement_rejected: { severity: "advice", name: "Linked requirement was rejected", hint: "Relink the case, or deprecate it." },
  priority_below_risk: { severity: "advice", name: "Priority lower than its risk", hint: "Check the reason, or clear the override." },
};

export function lintName(code: string): string {
  return LINT_DEFS[code as LintCode]?.name ?? code.replace(/_/g, " ");
}

/** Must fix = anything that blocks approval (all errors and the open question); everything else is Advice. */
export function lintSeverity(item: Pick<LintItem, "code" | "severity" | "blocks_approval">): LintSeverity {
  if (item.blocks_approval || item.severity === "error") return "must";
  return LINT_DEFS[item.code]?.severity === "must" && item.severity !== "warning" && item.severity !== "info" ? "must" : "advice";
}

/** "steps[3].expected" → 4 (1-based step number), else null. */
export function stepOfPath(path: string | null | undefined): number | null {
  const m = path?.match(/^steps\[(\d+)\]/);
  return m ? Number(m[1]) + 1 : null;
}

/** "missing expected result (step 4)" for one blocking item, as used in the disabled-Approve reason. */
function shortLintText(i: LintItem): string {
  const step = stepOfPath(i.path);
  return `${lintName(i.code).toLowerCase()}${step ? ` (step ${step})` : ""}`;
}

/** "Fix 1 check before approving: open question." (§8.1). Null when nothing blocks. */
export function approveBlockReason(lint: LintItem[] | null | undefined): string | null {
  const blocking = (lint ?? []).filter((i) => lintSeverity(i) === "must");
  if (!blocking.length) return null;
  return `Fix ${blocking.length} check${blocking.length === 1 ? "" : "s"} before approving: ${blocking.map(shortLintText).join(", ")}.`;
}

/**
 * Counts for the list's Checks chip. Assumption (reported to the backend): the open-question item has
 * severity "warning" with `blocks_approval: true`, so `lint_summary.warnings` includes it; it is shown as Must fix.
 */
export function lintCounts(c: Pick<TestCaseSummary, "lint_summary" | "expected_result_status">): { must: number; advice: number } {
  const oq = c.expected_result_status === "open_question" ? 1 : 0;
  const ls = c.lint_summary ?? { errors: 0, warnings: 0, blocks_approval: false };
  const must = (ls.errors ?? 0) + oq;
  const advice = Math.max(0, (ls.warnings ?? 0) - oq);
  return { must: must === 0 && ls.blocks_approval ? 1 : must, advice };
}

export function canBeApproved(c: Pick<TestCaseSummary, "lint_summary" | "expected_result_status">): boolean {
  return lintCounts(c).must === 0;
}

// ---- Visible values (§7.1, §19) ---------------------------------------------------------------

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

function words(n: number): string {
  return n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export type ValueDisplay = { text: string; sr: string; truncated: boolean; full: string; length: number };

/**
 * How a literal test value is shown: empty → "(empty) 0 characters"; whitespace-only → "␣␣␣ (3 spaces)";
 * long values → "aaaa…aaa (81 characters)". `sr` is what a screen reader should hear. Always plain text.
 */
/** "Not decided: {message}" exactly once, whether or not the server already prefixed the message. */
export function openQuestionText(message: string | null | undefined): string {
  const rest = openQuestionMessage(message);
  return rest ? `Not decided: ${rest}` : "Not decided";
}

/**
 * True when a step's or the case's expected result is the open question itself: the question text (as built,
 * without a prefix) or an older "Not decided: …" text.
 */
export function isUndecided(text: string | null | undefined, message: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (/^not decided\b/i.test(t)) return true;
  const m = openQuestionMessage(message);
  return !!m && openQuestionMessage(t) === m;
}

/** The open question without any "Not decided:" prefix the server may have added. */
export function openQuestionMessage(message: string | null | undefined): string {
  return (message ?? "").replace(/^(\s*not decided\s*:\s*)+/i, "").trim();
}

export function displayValue(value: string | null | undefined, max = 40): ValueDisplay {
  const v = value ?? "";
  const length = [...v].length;
  if (length === 0) return { text: "(empty) 0 characters", sr: "empty, 0 characters", truncated: false, full: "", length };
  if (/^ +$/.test(v)) return { text: `${"␣".repeat(length)} (${length} space${length === 1 ? "" : "s"})`, sr: `${words(length)} space${length === 1 ? "" : "s"}`, truncated: false, full: v, length };
  if (/^\s+$/.test(v)) return { text: `${v.replace(/ /g, "␣").replace(/\t/g, "⇥").replace(/\n/g, "↵")} (${length} whitespace characters)`, sr: `${words(length)} whitespace characters`, truncated: false, full: v, length };
  if (length > max) {
    const chars = [...v];
    const text = `${chars.slice(0, 4).join("")}…${chars.slice(-3).join("")} (${length} characters)`;
    return { text, sr: `${length} characters, starting ${chars.slice(0, 4).join("")}`, truncated: true, full: v, length };
  }
  return { text: v, sr: v, truncated: false, full: v, length };
}

// ---- List filters (§6.2) ------------------------------------------------------------------------

export type CaseChecksFilter = "must" | "advice" | "clean";
export type CaseSource = "rules" | "ai" | "human";

export type CaseFilters = {
  q: string;
  status: CaseStatus | "";
  technique: Technique | "";
  type: string;
  priority: Priority | "";
  level: string;
  risk: RiskLevel | "";
  suite: Suite | "";
  req: string;
  feature: string;
  checks: CaseChecksFilter | "";
  source: CaseSource | "";
  oq: boolean;
  prioSet: boolean;
  locked: boolean;
  edited: boolean;
  changed: boolean;
  noReq: boolean;
  /** Rejected and deprecated cases are hidden unless asked for. */
  showHidden: boolean;
  /** Exact case keys ("Show skipped", "Show them"). */
  keys: string[];
  group: "none" | "requirement" | "feature";
  sort: "priority" | "key" | "status" | "changed";
};

export const EMPTY_CASE_FILTERS: CaseFilters = {
  q: "",
  status: "",
  technique: "",
  type: "",
  priority: "",
  level: "",
  risk: "",
  suite: "",
  req: "",
  feature: "",
  checks: "",
  source: "",
  oq: false,
  prioSet: false,
  locked: false,
  edited: false,
  changed: false,
  noReq: false,
  showHidden: false,
  keys: [],
  group: "none",
  sort: "priority",
};

const FLAGS = { oq: "oq", prioSet: "prio_set", locked: "locked", edited: "edited", changed: "changed", noReq: "no_req", showHidden: "show_hidden" } as const;

type Params = { get(name: string): string | null };

function oneOf<T extends string>(v: string | null, allowed: readonly T[]): T | "" {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : "";
}

export function parseCaseFilters(params: Params): CaseFilters {
  const f: CaseFilters = { ...EMPTY_CASE_FILTERS };
  f.q = params.get("q") ?? "";
  f.status = oneOf(params.get("status"), ["draft", "approved", "rejected", "deprecated"] as const);
  f.technique = oneOf(params.get("technique"), Object.keys(TECHNIQUES) as Technique[]);
  f.type = params.get("type") ?? "";
  f.priority = oneOf(params.get("priority"), ["critical", "high", "medium", "low"] as const);
  f.level = params.get("level") ?? "";
  f.risk = oneOf(params.get("risk"), ["low", "medium", "high", "very_high"] as const);
  f.suite = oneOf(params.get("suite"), ["smoke", "regression"] as const);
  f.req = params.get("req") ?? "";
  f.feature = params.get("feature") ?? "";
  f.checks = oneOf(params.get("checks"), ["must", "advice", "clean"] as const);
  f.source = oneOf(params.get("source"), ["rules", "ai", "human"] as const);
  for (const [k, p] of Object.entries(FLAGS)) (f as Record<string, unknown>)[k] = params.get(p) === "1";
  f.keys = (params.get("keys") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  f.group = oneOf(params.get("group"), ["none", "requirement", "feature"] as const) || "none";
  f.sort = oneOf(params.get("sort"), ["priority", "key", "status", "changed"] as const) || "priority";
  return f;
}

/** Only non-default values, so links and browser Back restore the exact set. */
export function caseFiltersToQuery(f: CaseFilters): Record<string, string> {
  const q: Record<string, string> = {};
  for (const k of ["q", "status", "technique", "type", "priority", "level", "risk", "suite", "req", "feature", "checks", "source"] as const) if (f[k]) q[k] = f[k];
  for (const [k, p] of Object.entries(FLAGS)) if ((f as Record<string, unknown>)[k]) q[p] = "1";
  if (f.keys.length) q.keys = f.keys.join(",");
  if (f.group !== "none") q.group = f.group;
  if (f.sort !== "priority") q.sort = f.sort;
  return q;
}

const CHECKS_TEXT: Record<CaseChecksFilter, string> = { must: "Must fix", advice: "Advice only", clean: "No issues" };
const SOURCE_TEXT: Record<CaseSource, string> = { rules: "Rules", ai: "AI", human: "Person" };

export function caseFilterChips(f: CaseFilters): { key: keyof CaseFilters; label: string }[] {
  const out: { key: keyof CaseFilters; label: string }[] = [];
  if (f.q) out.push({ key: "q", label: `Search: ${f.q}` });
  if (f.status) out.push({ key: "status", label: `Status: ${CASE_STATUS_TEXT[f.status]}` });
  if (f.technique) out.push({ key: "technique", label: `Technique: ${techniqueInfo(f.technique).name}` });
  if (f.type) out.push({ key: "type", label: `Type: ${caseTypeText(f.type)}` });
  if (f.priority) out.push({ key: "priority", label: `Priority: ${PRIORITY_TEXT[f.priority]}` });
  if (f.level) out.push({ key: "level", label: `Level: ${caseLevelText(f.level)}` });
  if (f.risk) out.push({ key: "risk", label: `Risk: ${RISK_LEVEL_TEXT[f.risk]}` });
  if (f.suite) out.push({ key: "suite", label: `Suite: ${SUITE_TEXT[f.suite]}` });
  if (f.req) out.push({ key: "req", label: `Requirement: ${f.req}` });
  if (f.feature) out.push({ key: "feature", label: `Feature: ${f.feature}` });
  if (f.checks) out.push({ key: "checks", label: `Checks: ${CHECKS_TEXT[f.checks]}` });
  if (f.source) out.push({ key: "source", label: `Source: ${SOURCE_TEXT[f.source]}` });
  if (f.oq) out.push({ key: "oq", label: "Open question" });
  if (f.prioSet) out.push({ key: "prioSet", label: "Priority set by a person" });
  if (f.locked) out.push({ key: "locked", label: "Locked" });
  if (f.edited) out.push({ key: "edited", label: "Edited by people" });
  if (f.changed) out.push({ key: "changed", label: "Changed in latest generation" });
  if (f.noReq) out.push({ key: "noReq", label: "No requirement link" });
  if (f.keys.length) out.push({ key: "keys", label: `Cases: ${f.keys.length <= 3 ? f.keys.join(", ") : `${f.keys.length} chosen`}` });
  return out;
}

export function clearCaseFilter(f: CaseFilters, key: keyof CaseFilters): CaseFilters {
  return { ...f, [key]: EMPTY_CASE_FILTERS[key] };
}

function hidden(c: Pick<TestCaseSummary, "status">): boolean {
  return c.status === "rejected" || c.status === "deprecated";
}

/** `serverMatches`: ids the API's search found (objective and step text), merged with key/title matches here. */
/** Rules / AI / Person for the Source filter: `source` (as built) wins, then human edits, then `generated_by`. */
export function caseOrigin(c: Pick<TestCaseSummary, "generated_by" | "human_edited" | "source">): CaseSource {
  if (c.source === "user") return "human";
  if (c.source === "assistant") return "ai";
  if (c.generated_by === "human") return "human";
  return c.generated_by === "ai" ? "ai" : "rules";
}

export function matchesCase(c: TestCaseSummary, f: CaseFilters, serverMatches?: Set<string> | null): boolean {
  if (hidden(c) && !f.showHidden && f.status !== c.status && !f.keys.includes(c.key)) return false;
  if (f.keys.length && !f.keys.includes(c.key)) return false;
  if (f.status && c.status !== f.status) return false;
  if (f.technique && c.technique !== f.technique) return false;
  if (f.type && c.test_type !== f.type) return false;
  if (f.priority && c.priority !== f.priority) return false;
  if (f.level && c.test_level !== f.level) return false;
  if (f.risk && c.risk_level !== f.risk) return false;
  if (f.suite && !(c.suites ?? []).includes(f.suite)) return false;
  if (f.req && !(c.requirement_keys ?? []).includes(f.req)) return false;
  if (f.feature && (c.feature?.label ?? "").toLowerCase() !== f.feature.toLowerCase() && c.feature?.key !== f.feature) return false;
  if (f.checks) {
    const { must, advice } = lintCounts(c);
    if (f.checks === "must" && must === 0) return false;
    if (f.checks === "advice" && (must > 0 || advice === 0)) return false;
    if (f.checks === "clean" && (must > 0 || advice > 0)) return false;
  }
  if (f.source && caseOrigin(c) !== f.source) return false;
  if (f.oq && c.expected_result_status !== "open_question") return false;
  if (f.prioSet && !c.priority_overridden) return false;
  if (f.locked && !c.locked) return false;
  if (f.edited && !c.human_edited) return false;
  if (f.changed && !c.changed_in_latest) return false;
  if (f.noReq && (c.requirement_keys ?? []).length > 0) return false;
  if (f.q.trim()) {
    const q = f.q.trim().toLowerCase();
    const local = c.key.toLowerCase().includes(q) || c.title.toLowerCase().includes(q) || (c.objective ?? "").toLowerCase().includes(q);
    if (!local && !serverMatches?.has(c.id)) return false;
  }
  return true;
}

const STATUS_ORDER: Record<CaseStatus, number> = { draft: 0, approved: 1, rejected: 2, deprecated: 3 };

const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key, undefined, { numeric: true });

/** Priority (default): ties broken by risk score, highest first, then key. */
export function sortCases<T extends TestCaseSummary>(rows: T[], sort: CaseFilters["sort"]): T[] {
  const out = [...rows];
  out.sort((a, b) => {
    switch (sort) {
      case "key":
        return byKey(a, b);
      case "status":
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byKey(a, b);
      case "changed":
        return (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || byKey(a, b);
      default:
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (b.risk_score ?? -1) - (a.risk_score ?? -1) || byKey(a, b);
    }
  });
  return out;
}

export function filterCases(all: TestCaseSummary[], f: CaseFilters, serverMatches?: Set<string> | null) {
  const rows = sortCases(
    all.filter((c) => matchesCase(c, f, serverMatches)),
    f.sort,
  );
  const visibleHidden = f.showHidden || f.keys.length > 0;
  const rejected = visibleHidden || f.status === "rejected" ? 0 : all.filter((c) => c.status === "rejected" && matchesCase(c, { ...f, showHidden: true }, serverMatches)).length;
  const deprecated = visibleHidden || f.status === "deprecated" ? 0 : all.filter((c) => c.status === "deprecated" && matchesCase(c, { ...f, showHidden: true }, serverMatches)).length;
  return { rows, hiddenRejected: rejected, hiddenDeprecated: deprecated };
}

export type CaseGroup = { id: string; title: string; key: string | null; cases: TestCaseSummary[]; approved: number };

/**
 * Group by requirement (a case linked to two requirements appears in both; unlinked cases come last under
 * "Not linked to a requirement") or by feature.
 */
export function groupCases(rows: TestCaseSummary[], by: "requirement" | "feature", titles: Record<string, string> = {}): CaseGroup[] {
  const groups = new Map<string, CaseGroup>();
  const add = (id: string, title: string, key: string | null, c: TestCaseSummary) => {
    const g = groups.get(id) ?? { id, title, key, cases: [], approved: 0 };
    g.cases.push(c);
    if (c.status === "approved") g.approved += 1;
    groups.set(id, g);
  };
  for (const c of rows) {
    if (by === "requirement") {
      const keys = c.requirement_keys ?? [];
      if (!keys.length) add("__none", "Not linked to a requirement", null, c);
      for (const k of keys) add(k, titles[k] ? `${k} ${titles[k]}` : k, k, c);
    } else {
      const label = c.feature?.label ?? "";
      add(label ? `f:${label}` : "__none", label || "No feature", c.feature?.key ?? null, c);
    }
  }
  const list = [...groups.values()];
  list.sort((a, b) => (a.id === "__none" ? 1 : b.id === "__none" ? -1 : a.key && b.key ? byKey({ key: a.key }, { key: b.key }) : a.title.localeCompare(b.title)));
  return list;
}

// ---- Bulk approve guard (§6.3) ---------------------------------------------------------------

export const BULK_LIMIT = 200;

export type SkipReason = "must_fix" | "open_question";

export function bulkApproveGuard(rows: TestCaseSummary[]) {
  const drafts = rows.filter((c) => c.status === "draft");
  const skipped: { c: TestCaseSummary; reason: SkipReason; text: string }[] = [];
  const approvable: TestCaseSummary[] = [];
  for (const c of drafts) {
    if (c.expected_result_status === "open_question") skipped.push({ c, reason: "open_question", text: "open question" });
    else if (!canBeApproved(c)) {
      const n = lintCounts(c).must;
      skipped.push({ c, reason: "must_fix", text: `${n} check${n === 1 ? "" : "s"} you must fix` });
    } else approvable.push(c);
  }
  return { approvable, skipped };
}

/** "3 can't be approved yet: 2 have checks you must fix and 1 has an open question. They'll stay as drafts." */
export function skippedSentence(skipped: { reason: SkipReason }[]): string {
  const must = skipped.filter((s) => s.reason === "must_fix").length;
  const oq = skipped.filter((s) => s.reason === "open_question").length;
  const parts: string[] = [];
  if (must) parts.push(`${must} ${must === 1 ? "has" : "have"} checks you must fix`);
  if (oq) parts.push(`${oq} ${oq === 1 ? "has" : "have"} an open question`);
  return `${skipped.length} can’t be approved yet: ${parts.join(" and ")}. They’ll stay as drafts.`;
}

// ---- Priority source text (§10) -----------------------------------------------------------------

/** Second line under the priority in the list: "from RISK-003", "set by a person", "no linked risk". */
export function prioritySourceShort(c: Pick<TestCaseSummary, "priority_overridden" | "risk_key" | "risk_level">): string {
  if (c.priority_overridden) return "set by a person";
  if (c.risk_key) return `from ${c.risk_key}`;
  if (c.risk_level) return `from a ${RISK_LEVEL_TEXT[c.risk_level]} risk`;
  return "no linked risk";
}

// ---- Edit form (§8.2–§8.4) ----------------------------------------------------------------------

export type StepDraft = { id: string; action: string; expected: string; data: { id: string; key: string; label: string }[] };

export type CaseForm = {
  title: string;
  objective: string;
  requirement_ids: string[];
  acceptance_criterion_ids: string[];
  /** Empty until a person picks one on a new case; the API has no "other" value. */
  technique: Technique | "";
  preconditions: string[];
  steps: StepDraft[];
  expected_result: string;
  test_type: string;
  test_level: string;
  suites: Suite[];
  reason: string;
};

/** Vague words the server lint also flags (P3-01a): word-boundary matches only. */
export const VAGUE_WORDS = ["works", "as expected", "correctly", "properly", "appropriate", "etc", "should be fine", "verify it", "check that it"];

export function vagueWords(text: string): string[] {
  const t = text.toLowerCase();
  return VAGUE_WORDS.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(t));
}

const PLACEHOLDER = /\b(TBD|TODO)\b|<[^<>]{1,40}>|\{\{/;
const EMAIL = /[A-Z0-9._%+-]+@([A-Z0-9-]+\.)+[A-Z]{2,}/gi;
const RESERVED = /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/i;
const PASSWORD_LIKE = /\b(password|passwort|pwd|passcode)\b\s*(is|=|:)?\s*["“']?[^\s"”']{4,}/i;

/** Real-looking email domains in free text (the synthetic guard, D3). */
export function realLookingEmails(text: string): string[] {
  return (text.match(EMAIL) ?? []).filter((e) => !RESERVED.test(e.split("@")[1] ?? ""));
}

export function looksLikePassword(text: string): boolean {
  return PASSWORD_LIKE.test(text) && !/saved test account|test credentials/i.test(text);
}

/** Client preview of the server lint (§8.2 "Checks (preview)"). The server is authoritative. */
export function lintPreview(form: Pick<CaseForm, "steps" | "expected_result" | "requirement_ids" | "title" | "objective">): { code: LintCode; severity: LintSeverity; text: string; field: string }[] {
  const out: { code: LintCode; severity: LintSeverity; text: string; field: string }[] = [];
  const steps = form.steps.filter((s) => s.action.trim() || s.expected.trim());
  if (steps.length === 0) out.push({ code: "missing_steps", severity: "must", text: "No steps. Add at least one step.", field: "step-0-action" });
  const target = stepExpectedTarget(form.steps);
  if (steps.length > 0 && target !== null) out.push({ code: "missing_expected_result", severity: "must", text: `Missing expected result. Write what should happen after step ${target + 1}.`, field: `step-${target}-expected` });
  if (!form.expected_result.trim()) out.push({ code: "missing_expected_result", severity: "must", text: "Missing expected result. Write what should happen at the end of the case.", field: "expected_result" });
  if (form.requirement_ids.length === 0) out.push({ code: "orphan_case", severity: "must", text: "Not linked to a requirement. Link the requirement this case checks.", field: "requirements" });
  const texts: [string, string, string][] = [
    ["title", "Title", form.title],
    ["objective", "Objective", form.objective],
    ["expected_result", "Overall expected result", form.expected_result],
    ...form.steps.flatMap((s, i): [string, string, string][] => [
      [`step-${i}-action`, `step ${i + 1}`, s.action],
      [`step-${i}-expected`, `step ${i + 1}`, s.expected],
    ]),
  ];
  for (const [field, name, text] of texts) {
    const ph = text.match(PLACEHOLDER);
    if (ph) out.push({ code: "unresolved_placeholder", severity: "must", text: `Unfinished text. Replace ‘${ph[0]}’ in ${name} with the real wording.`, field });
    if (realLookingEmails(text).length) out.push({ code: "non_synthetic_data", severity: "must", text: `Real-looking data in ${name}. Use synthetic data, such as an example.com email.`, field });
    if (looksLikePassword(text)) out.push({ code: "literal_secret", severity: "must", text: `Password typed into ${name}. Use the saved test account instead of a typed password.`, field });
    for (const w of vagueWords(text)) out.push({ code: "vague_wording", severity: "advice", text: `‘${w}’ is vague. Say exactly what the user sees.`, field });
  }
  if (steps.length > 15) out.push({ code: "too_many_steps", severity: "advice", text: "More than 15 steps. Split it into smaller cases.", field: `step-15-action` });
  return out;
}

/** Validation on save (§8.3): field id → message, in focus order. */
export function validateCaseForm(form: CaseForm): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  if (!form.title.trim()) out.push({ field: "title", message: "Give the case a short, specific title." });
  else if (form.title.trim().length < 5) out.push({ field: "title", message: "Use at least 5 characters for the title." });
  if (!form.objective.trim()) out.push({ field: "objective", message: "Say what this case checks." });
  if (!form.technique) out.push({ field: "technique", message: TECHNIQUE_NEEDED });
  if (form.steps.length === 0) out.push({ field: "add-step", message: "Add at least one step." });
  form.steps.forEach((s, i) => {
    const n = i + 1;
    if (!s.action.trim()) out.push({ field: `step-${i}-action`, message: `Describe the action for step ${n}.` });
    else if (looksLikePassword(s.action)) out.push({ field: `step-${i}-action`, message: `Step ${n} contains what looks like a password. Reference the saved test account instead.` });
    else if (realLookingEmails(s.action).length) out.push({ field: `step-${i}-action`, message: `Step ${n} contains a real-looking email address. Use a test data item with a reserved domain such as example.com.` });
    // A step's expected result is optional: setup steps such as "Open /contact" have none (QA BUG-P3-02).
    if (!s.expected.trim()) return;
    if (looksLikePassword(s.expected)) out.push({ field: `step-${i}-expected`, message: `Step ${n} contains what looks like a password. Reference the saved test account instead.` });
    else if (realLookingEmails(s.expected).length) out.push({ field: `step-${i}-expected`, message: `Step ${n} contains a real-looking email address. Use a test data item with a reserved domain such as example.com.` });
  });
  const target = stepExpectedTarget(form.steps);
  if (target !== null) out.push({ field: `step-${target}-expected`, message: STEP_EXPECTED_NEEDED });
  if (!form.expected_result.trim()) out.push({ field: "expected_result", message: "Describe what the user should see at the end." });
  return out;
}

export const TECHNIQUE_NEEDED = "Choose the test design technique this case uses.";

const FIELD_TEXT: Record<string, string> = {
  title: "Give the case a short, specific title.",
  objective: "Say what this case checks.",
  expected_result: "Describe what the user should see at the end.",
  technique: TECHNIQUE_NEEDED,
  test_type: "Choose a test type.",
  test_level: "Choose a test level.",
  requirement_ids: "Link a requirement that still exists in this project.",
  acceptance_criterion_ids: "Pick acceptance criteria from the linked requirements.",
  preconditions: "Check the preconditions.",
  suites: "Choose suites from the list.",
  steps: "Add at least one step.",
};
const FIELD_NAME: Record<string, string> = { side_effects: "side effects", priority: "priority", reason: "reason" };
/** Parser wording such as "Input should be 'a', 'b'…" or "Field required" is never shown to people. */
const RAW_VALIDATION = /^(input should|string should|field required|list should|value is not|ensure this|extra inputs|unable to parse|invalid|none is not)/i;

/**
 * Maps a 422 `details` list (`[{field: "steps.1.expected", message}]`) to form fields with plain-language messages
 * (QA BUG-P3-05). Anything that isn't a form field goes to `other`, in plain words.
 */
export function caseFieldErrors(details: unknown): { fields: { field: string; message: string }[]; other: string[] } {
  const fields: { field: string; message: string }[] = [];
  const other: string[] = [];
  for (const d of Array.isArray(details) ? (details as unknown[]) : []) {
    if (!d || typeof d !== "object") continue;
    const path = String((d as { field?: unknown }).field ?? "");
    const raw = String((d as { message?: unknown }).message ?? "").replace(/^value error,\s*/i, "");
    const human = raw && !RAW_VALIDATION.test(raw) ? raw : null;
    const step = /^steps\.(\d+)\.(action|expected|data_ids)/.exec(path);
    let field: string | null = null;
    let message: string;
    if (step) {
      const i = Number(step[1]);
      field = `step-${i}-${step[2] === "expected" ? "expected" : "action"}`;
      message = human ?? (step[2] === "expected" ? `Check the expected result for step ${i + 1}.` : step[2] === "action" ? `Describe the action for step ${i + 1}.` : `Pick test data that still exists for step ${i + 1}.`);
    } else {
      const top = path.split(".")[0];
      field = top === "requirement_ids" || top === "acceptance_criterion_ids" ? "requirements" : top in FIELD_TEXT ? top : null;
      message = human ?? FIELD_TEXT[top] ?? `Check the ${FIELD_NAME[top] ?? (top.replace(/_/g, " ") || "form")}.`;
    }
    if (field && !fields.some((f) => f.field === field)) fields.push({ field, message });
    else if (!field && !other.includes(message)) other.push(message);
  }
  return { fields, other };
}

export const STEP_EXPECTED_NEEDED = "Describe the expected result for at least one step, usually the last one.";

/**
 * The case needs at least one step with an expected result. Returns the step whose expected field should take
 * focus when none has one (the last step with an action), or null when the rule is met or there are no steps.
 */
export function stepExpectedTarget(steps: Pick<StepDraft, "action" | "expected">[]): number | null {
  if (steps.length === 0 || steps.some((s) => s.expected.trim())) return null;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].action.trim()) return i;
  return steps.length - 1;
}

export function stepsInput(steps: StepDraft[]): TestStepInput[] {
  return steps.map((s) => ({ action: s.action.trim(), data_ids: s.data.map((d) => d.id), expected: s.expected.trim() }));
}

let stepSeq = 0;
export function newStep(over: Partial<StepDraft> = {}): StepDraft {
  stepSeq += 1;
  return { id: `step-${stepSeq}`, action: "", expected: "", data: [], ...over };
}

/** The form for an existing case. An open question's expected result starts empty, never "Not decided…" (§8.4). */
export function toCaseForm(d: TestCaseDetail): CaseForm {
  const oq = d.expected_result_status === "open_question";
  const undecided = (t: string) => (oq && isUndecided(t, d.open_question?.message) ? "" : t);
  return {
    title: d.title,
    objective: d.objective ?? "",
    requirement_ids: (d.requirements ?? []).map((r) => r.id).filter((x): x is string => !!x),
    acceptance_criterion_ids: (d.acceptance_criteria ?? []).map((r) => r.id).filter((x): x is string => !!x),
    technique: d.technique,
    preconditions: [...(d.preconditions ?? [])],
    steps: (d.steps ?? []).map((s) => newStep({ action: s.action, expected: undecided(s.expected ?? ""), data: (s.data ?? []).filter((x) => x.id).map((x) => ({ id: x.id!, key: x.key, label: x.label })) })),
    expected_result: undecided(d.expected_result ?? ""),
    test_type: d.test_type,
    test_level: d.test_level,
    suites: [...(d.suites ?? [])],
    reason: "",
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * PATCH body with only what changed since `base` (plus version and reason). An unchanged form sends no fields,
 * so a save never silently drops or overwrites content it didn't touch.
 */
export function casePatch(base: CaseForm, form: CaseForm, version: number) {
  const body: Record<string, unknown> = { version };
  if (form.title.trim() !== base.title.trim()) body.title = form.title.trim();
  if (form.objective.trim() !== base.objective.trim()) body.objective = form.objective.trim();
  const pre = form.preconditions.map((p) => p.trim()).filter(Boolean);
  if (!same(pre, base.preconditions.map((p) => p.trim()).filter(Boolean))) body.preconditions = pre;
  if (!same(stepsInput(form.steps), stepsInput(base.steps))) body.steps = stepsInput(form.steps);
  if (form.expected_result.trim() !== base.expected_result.trim()) body.expected_result = form.expected_result.trim();
  if (form.test_type !== base.test_type) body.test_type = form.test_type;
  if (form.test_level !== base.test_level) body.test_level = form.test_level;
  if (!same([...form.suites].sort(), [...base.suites].sort())) body.suites = form.suites;
  if (!same([...form.requirement_ids].sort(), [...base.requirement_ids].sort())) body.requirement_ids = form.requirement_ids;
  if (!same([...form.acceptance_criterion_ids].sort(), [...base.acceptance_criterion_ids].sort())) body.acceptance_criterion_ids = form.acceptance_criterion_ids;
  if (form.reason.trim()) body.change_reason = form.reason.trim();
  return body;
}

export function patchHasChanges(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => k !== "version" && k !== "change_reason");
}

// ---- Gate 5 checks (§13.1) -------------------------------------------------------------------------

export type G5Link = { label: string; href: string };
export type G5Line = { id: string; text: string; links: G5Link[] };
export type G5Checks = { blockers: G5Line[]; advice: G5Line[]; passed: G5Line[] };

function keysText(keys: string[], max = 5): string {
  return keys.length > max ? `${keys.slice(0, max).join(", ")} and ${keys.length - max} more` : keys.join(", ");
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Gate 5 lines, all computed from API data (design D1): blockers disable approval, advice never does.
 * Every line that names items has its own uniquely named link.
 */
export function g5Checks(o: {
  cases: TestCaseSummary[];
  gaps: Gaps | null | undefined;
  g4Approved: boolean;
  designCurrent: boolean;
  strategyVersion: number | null;
  gate?: StageGate | null;
  listHref: (q: Record<string, string>) => string;
  traceHref: (anchor: string) => string;
  riskHref: (key: string) => string;
  g4Href: string;
}): G5Checks {
  const blockers: G5Line[] = [];
  const advice: G5Line[] = [];
  const passed: G5Line[] = [];
  const active = o.cases.filter((c) => c.status === "draft" || c.status === "approved");
  const approved = o.cases.filter((c) => c.status === "approved");
  const drafts = o.cases.filter((c) => c.status === "draft");
  const sv = o.strategyVersion ? `Strategy v${o.strategyVersion}` : "The Test Strategy";

  // 1. G4 approved and the design built from it.
  if (!o.g4Approved) blockers.push({ id: "g4", text: "Gate 4 isn’t approved. Test cases are designed from the approved Test Strategy.", links: [{ label: "Review Gate 4", href: o.g4Href }] });
  else if (!o.designCurrent)
    blockers.push({ id: "g4", text: `These test cases were designed from an older strategy. Regenerate them from ${sv} before approving.`, links: [{ label: "Regenerate test cases from the current strategy", href: o.listHref({ regenerate: "1" }) }] });
  else passed.push({ id: "g4", text: `${sv} is approved, and these cases were designed from it`, links: [] });

  // 2. At least one approved case.
  if (approved.length === 0) blockers.push({ id: "approved", text: "No test case is approved yet. Approve at least one.", links: [{ label: "Show test cases to approve", href: o.listHref({ status: "draft" }) }] });
  else passed.push({ id: "approved", text: `${approved.length} ${plural(approved.length, "test case", "test cases")} approved`, links: [] });

  // 3. No approved case with a Must-fix item.
  const approvedMust = approved.filter((c) => !canBeApproved(c) && c.expected_result_status !== "open_question");
  if (approvedMust.length)
    blockers.push({
      id: "approved-must",
      text: `${approvedMust.length} approved ${plural(approvedMust.length, "case has", "cases have")} checks you must fix: ${keysText(approvedMust.map((c) => c.key))}.`,
      links: [{ label: `Show ${approvedMust.length} approved ${plural(approvedMust.length, "case", "cases")} with checks to fix`, href: o.listHref({ status: "approved", checks: "must" }) }],
    });
  else if (approved.length) passed.push({ id: "approved-must", text: "No approved case has checks you must fix", links: [] });

  // 4. Open High / Very high risks whose approved requirements have no approved case.
  const risky = o.gaps?.untested_high_risk?.open ?? [];
  for (const r of risky) {
    const reqs = r.requirements ?? [];
    const level = /very/i.test(r.risk.label ?? "") ? "Very high" : "High";
    const reqKeys = reqs.map((x) => x.key);
    blockers.push({
      id: `risk-${r.risk.key}`,
      text: `${r.risk.key} (${level}) is open and ${reqKeys.join(", ") || "its requirement"} ${reqKeys.length > 1 ? "have" : "has"} no approved test case. Approve a case for ${reqKeys.join(", ") || "it"}, or accept the risk with a comment.`,
      links: [
        ...reqs.slice(0, 3).map((x) => ({ label: `Show test cases for ${x.key}`, href: o.listHref({ req: x.key, show_hidden: "1" }) })),
        { label: `Open ${r.risk.key}`, href: o.riskHref(r.risk.key) },
      ],
    });
  }
  if (o.gaps && risky.length === 0) passed.push({ id: "risk", text: "Every open High or Very high risk has an approved test case", links: [] });

  // 5. No active case with an open question (D1 blocker, accepted open question 1).
  const oq = active.filter((c) => c.expected_result_status === "open_question");
  if (oq.length)
    blockers.push({
      id: "oq",
      text: `${oq.length} test ${plural(oq.length, "case has", "cases have")} an open question: ${keysText(oq.map((c) => c.key))}.`,
      links: [{ label: oq.length === 1 ? "Show the case with an open question" : `Show ${oq.length} cases with an open question`, href: o.listHref({ oq: "1" }) }],
    });
  else passed.push({ id: "oq", text: "No active case has an open question", links: [] });

  // A server blocker the checks above don't explain (the server is authoritative).
  const serverBlockers = (o.gate?.preconditions ?? []).filter((x) => x.blocking && !x.met);
  if (blockers.length === 0 && serverBlockers.length)
    for (const x of serverBlockers) blockers.push({ id: `server-${x.code}`, text: x.message, links: x.link ? [{ label: `Open the item for “${x.message.slice(0, 40)}”`, href: x.link }] : [] });

  // Advice.
  if (drafts.length)
    advice.push({
      id: "drafts",
      text: `${drafts.length} ${plural(drafts.length, "draft", "drafts")} will be left out of the approved set.`,
      links: [{ label: `Show ${drafts.length} draft test ${plural(drafts.length, "case", "cases")}`, href: o.listHref({ status: "draft" }) }],
    });
  const uncovered = [...(o.gaps?.requirements_without_test_cases?.none ?? []), ...(o.gaps?.requirements_without_test_cases?.none_approved ?? [])];
  if (uncovered.length)
    advice.push({
      id: "req-uncovered",
      text: `${uncovered.length} approved ${plural(uncovered.length, "requirement has", "requirements have")} no approved test case: ${keysText(uncovered.map((r) => r.key))}.`,
      links: [{ label: "Show uncovered requirements", href: o.traceHref("gap-requirements") }],
    });
  const acs = o.gaps?.acceptance_criteria_without_test_cases ?? [];
  if (acs.length)
    advice.push({
      id: "ac-uncovered",
      text: `${acs.length} approved acceptance ${plural(acs.length, "criterion has", "criteria have")} no test case.`,
      links: [{ label: "Show uncovered acceptance criteria", href: o.traceHref("gap-acceptance-criteria") }],
    });
  const draftMust = drafts.filter((c) => !canBeApproved(c) && c.expected_result_status !== "open_question");
  if (draftMust.length)
    advice.push({
      id: "draft-must",
      text: `${draftMust.length} ${plural(draftMust.length, "draft has", "drafts have")} checks you must fix: ${keysText(draftMust.map((c) => c.key))}.`,
      links: [{ label: `Show ${draftMust.length} ${plural(draftMust.length, "draft", "drafts")} with checks to fix`, href: o.listHref({ status: "draft", checks: "must" }) }],
    });
  const approvedAdvice = approved.filter((c) => lintCounts(c).advice > 0);
  if (approvedAdvice.length)
    advice.push({
      id: "approved-advice",
      text: `${approvedAdvice.length} approved ${plural(approvedAdvice.length, "case has", "cases have")} advice: ${keysText(approvedAdvice.map((c) => c.key))}.`,
      links: [{ label: `Show ${approvedAdvice.length} approved ${plural(approvedAdvice.length, "case", "cases")} with advice`, href: o.listHref({ status: "approved", checks: "advice" }) }],
    });
  return { blockers, advice, passed };
}

/** Tile and filter link for the "Quality checks by type" lint summary (§13.1): "Show 1 case: open question". */
export function lintTypeLinkLabel(code: string, n: number): string {
  return `Show ${n} ${n === 1 ? "case" : "cases"}: ${lintName(code).toLowerCase()}`;
}

// ---- Test data (§11) ---------------------------------------------------------------------------------

export const KIND_TEXT: Record<string, string> = { valid: "Valid", invalid: "Invalid", boundary: "Boundary", secret_ref: "Saved test account" };

/**
 * Case keys from a "retire while in use" 409. Reads every shape seen so far: `details.used_by`, `details[].cases`,
 * `details[].used_by` and `details[].key`; each entry may be a key or `{key}`.
 */
export function usedByFromConflict(details: unknown): string[] {
  const keyOf = (x: unknown) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { key?: unknown }).key === "string" ? (x as { key: string }).key : null);
  const lists: unknown[] = [];
  const visit = (d: unknown) => {
    if (!d || typeof d !== "object") return;
    const o = d as { used_by?: unknown; cases?: unknown };
    if (Array.isArray(o.used_by)) lists.push(...o.used_by);
    if (Array.isArray(o.cases)) lists.push(...o.cases);
  };
  if (Array.isArray(details)) {
    for (const d of details) {
      visit(d);
      const k = d && typeof d === "object" && !("cases" in d) && !("used_by" in d) ? keyOf(d) : null;
      if (k) lists.push(k);
    }
  } else visit(details);
  return [...new Set(lists.map(keyOf).filter((k): k is string => !!k && /^TC-\d+$/.test(k)))];
}

/** A readable form name from a discovery anchor such as "form:/contact:contact us" → "Contact us". */
export function formAnchorLabel(anchor: string | null | undefined): string | null {
  if (!anchor) return null;
  const m = /^form:[^:]*:(.+)$/.exec(anchor.trim());
  const name = (m ? m[1] : anchor.replace(/^form:/, "")).trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

/** "TC-0012", "TC-0012 and TC-0042", "TC-0012, TC-0013 and TC-0042"; past `max`, "…, TC-0020 and 3 more". */
export function listText(items: string[], max = Infinity): string {
  const shown = items.length > max ? items.slice(0, max) : items;
  const rest = items.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A form heading: the label, plus its path only when the label doesn't already include it. */
export function formHeading(label: string, path: string | null | undefined): string {
  const l = label.trim();
  return path && !l.includes(path) ? `${l} (${path})` : l;
}

export const PRELIMINARY_TEXT = "Preliminary: assessed in Phase 4.";

/** The automation reason without the "Preliminary: assessed in Phase 4." sentence, which the UI prints once itself. */
export function automationReasonText(reason: string | null | undefined): string {
  return (reason ?? "").split(PRELIMINARY_TEXT).join(" ").replace(/\s+/g, " ").trim();
}

/** A coverage item as people read it ("empty", "81 characters"); the raw id ("len:0") only when no label came. */
export function coverageItemText(o: { coverage_item?: string | null; coverage_item_label?: string | null } | null | undefined): string {
  return (o?.coverage_item_label ?? "").trim() || (o?.coverage_item ?? "").trim();
}

export const SYNTHETIC_NOTICE = "Synthetic data only. Values are generated for testing and aren’t real people’s details. Saved logins are referenced, never shown.";
export const SAVED_LOGIN_TEXT = "Uses the saved test account (value never shown)";

/** Maps the API's guard message to the design's field copy (§11.2). */
export function guardMessage(message: string): string {
  const m = message.toLowerCase();
  if (/reserved domain|real-looking data|email/.test(m) && /domain|email/.test(m)) return "Use a reserved domain such as example.com; real-looking data isn’t allowed.";
  if (/phone/.test(m)) return "Use a fictional number, such as +44 20 7946 0000; real-looking numbers aren’t allowed.";
  if (/card/.test(m)) return "This looks like a real card number. Use a published test card such as 4111 1111 1111 1111.";
  if (/password/.test(m)) return "Passwords must reference saved test credentials.";
  if (/boundary/.test(m)) return message.replace(/\.?$/, ".");
  if (/5,?000|too long|at most/.test(m)) return "Values can be up to 5,000 characters.";
  return message;
}

/** Client-side guard before saving a test data value (the server re-checks). */
export function dataValueError(value: string, kind: string, boundaryLength: number | null): string | null {
  if (value.length > 5000) return "Values can be up to 5,000 characters.";
  if (realLookingEmails(value).length) return "Use a reserved domain such as example.com; real-looking data isn’t allowed.";
  const digits = value.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits) && !TEST_CARDS.has(digits)) return "This looks like a real card number. Use a published test card such as 4111 1111 1111 1111.";
  if (kind === "boundary" && boundaryLength !== null && [...value].length !== boundaryLength)
    return `This item tests the ${boundaryLength}-character boundary; change the case instead.`;
  return null;
}

const TEST_CARDS = new Set(["4111111111111111", "4242424242424242", "5555555555554444", "378282246310005", "6011111111111117", "4000056655665556", "5105105105105100"]);

function luhn(d: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// ---- Requirement detail, "Linked test cases" (§9) --------------------------------------------------

/** The state line under "Linked test cases"; `text: null` means the list is shown. */
/**
 * Cases shown on a requirement page: those linked to it, plus open-question cases waiting on its answer
 * (`waitingOn` maps case id → requirement key). Rejected cases are left out.
 */
export function casesForRequirement<T extends Pick<TestCaseSummary, "id" | "status" | "requirement_keys" | "expected_result_status">>(
  cases: T[],
  requirementKey: string,
  waitingOn: Record<string, string>,
): { cases: T[]; waiting: T[] } {
  const live = cases.filter((c) => c.status !== "rejected");
  const waiting = live.filter((c) => c.expected_result_status === "open_question" && waitingOn[c.id] === requirementKey);
  const linked = live.filter((c) => (c.requirement_keys ?? []).includes(requirementKey) || waiting.includes(c));
  return { cases: linked, waiting };
}

export function linkedCasesState(o: { g4Approved: boolean; designed: boolean; status: string; count: number }): { text: string | null; uncovered: boolean; offerNew: boolean } {
  if (o.status === "rejected") return { text: "Rejected requirements get no test cases.", uncovered: false, offerNew: false };
  if (o.count > 0) return { text: null, uncovered: false, offerNew: true };
  if (!o.designed) return { text: o.g4Approved ? "Test cases are designed after the Test Strategy is approved (Gate 4). Design hasn’t run yet." : "Test cases are designed after the Test Strategy is approved (Gate 4).", uncovered: false, offerNew: false };
  if (o.status === "draft" || o.status === "needs_info") return { text: "Test cases are designed only from approved requirements.", uncovered: false, offerNew: false };
  return { text: "No test cases yet.", uncovered: o.status === "approved", offerNew: true };
}

// ---- Assistant proposals (§16.2) ---------------------------------------------------------------------

/** Splits a `set_suite` preview into the two lists the card shows ("Add to Regression" / "Remove from Regression"). */
export function suiteDiff<T extends { key: string; from: readonly string[]; to: readonly string[]; action?: string }>(changes: T[], suite = "regression"): { add: T[]; remove: T[] } {
  // As built each item says `action`; older previews only carry from/to.
  const add = changes.filter((c) => (c.action ? c.action === "add" : (c.to ?? []).includes(suite) && !(c.from ?? []).includes(suite)));
  const remove = changes.filter((c) => (c.action ? c.action === "remove" : (c.from ?? []).includes(suite) && !(c.to ?? []).includes(suite)));
  return { add, remove };
}

/** Toast after applying test-design proposals: "3 test cases added as drafts. View in Test Cases." */
export function proposalAppliedToast(kind: string | undefined, ok: number, cases = ok): string {
  if (kind === "add_test_cases") return `${cases} test case${cases === 1 ? "" : "s"} added as drafts. View in Test Cases.`;
  if (kind === "set_suite") return `${ok} suite change${ok === 1 ? "" : "s"} applied. View in Test Cases.`;
  if (kind === "update_test_case") return `${ok} change${ok === 1 ? "" : "s"} applied. View in Test Cases.`;
  return `${ok} change${ok === 1 ? "" : "s"} applied. View in ${kind?.includes("risk") ? "Test Strategy" : "Requirements"}.`;
}
