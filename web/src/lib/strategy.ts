// Test Strategy, risk register and Gate 4 logic (design P2 §8). Scores and levels always come from the
// server; this module only labels them and computes the code-owned check lines. Unit-tested.

import type { Risk, RiskLevel, RiskMatrix, TestLevel, TestStrategy, TestType, Technique } from "./contract";
import type { GateCheck } from "./requirements";

export const LIKELIHOOD = ["Rare", "Unlikely", "Possible", "Likely", "Almost certain"] as const;
export const IMPACT = ["Negligible", "Minor", "Moderate", "Major", "Severe"] as const;

export const LEVEL_TEXT: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High", very_high: "Very high" };
export const LEVEL_ABBR: Record<RiskLevel, string> = { low: "L", medium: "M", high: "H", very_high: "VH" };

/** Risk level styling (design P2 §2). The level is always shown as text too. */
export const LEVEL_CLASS: Record<RiskLevel, string> = {
  low: "bg-success-bg text-success-fg ring-success-line",
  medium: "bg-warning-bg text-warning-fg ring-warning-line",
  high: "bg-danger-bg text-danger-fg ring-danger-line",
  very_high: "bg-danger-solid text-white font-bold ring-danger-solid",
};

export function likelihoodText(n: number): string {
  return `${n} ${LIKELIHOOD[n - 1] ?? ""}`.trim();
}
export function impactText(n: number): string {
  return `${n} ${IMPACT[n - 1] ?? ""}`.trim();
}

export const LEVEL_NAMES: Record<TestLevel, string> = {
  component: "Component",
  component_integration: "Component integration",
  system: "System",
  system_integration: "System integration",
  acceptance: "Acceptance",
};

export const TYPE_NAMES: Record<TestType, string> = {
  functional: "Functional",
  smoke: "Smoke",
  sanity: "Sanity",
  regression: "Regression",
  exploratory: "Exploratory",
  usability: "Usability",
  accessibility: "Accessibility",
  compatibility: "Compatibility",
  security: "Security",
  performance: "Performance",
  load: "Load",
  stress: "Stress",
  spike: "Spike",
  endurance: "Endurance",
};

/** Functional-group types; everything else is non-functional (design §8.2 table grouping). */
export const FUNCTIONAL_TYPES: TestType[] = ["functional", "smoke", "sanity", "regression", "exploratory"];

/** Types that can't run without a separate approval in a later phase (design §8.2). */
export const APPROVAL_TYPES: TestType[] = ["performance", "load", "stress", "spike", "endurance", "security"];

export const TECHNIQUE_NAMES: Record<Technique, string> = {
  equivalence_partitioning: "Equivalence partitioning",
  boundary_value_analysis: "Boundary value analysis",
  decision_table: "Decision tables",
  state_transition: "State transition",
  use_case: "Use case",
  error_guessing: "Error guessing",
  exploratory: "Exploratory",
};

/** Accessible name of a matrix cell: "2 risks, likelihood 4 Likely, impact 3 Moderate, score 12, High". */
export function cellName(count: number, likelihood: number, impact: number, score: number | null, level: RiskLevel | null): string {
  return `${count} risk${count === 1 ? "" : "s"}, likelihood ${likelihoodText(likelihood)}, impact ${impactText(impact)}${score !== null ? `, score ${score}` : ""}${level ? `, ${LEVEL_TEXT[level]}` : ""}`;
}

/**
 * Score and level for a matrix cell, read from a server-scored risk in that cell (never computed here).
 * null when no risk in the cell is loaded.
 */
export function cellScore(cell: RiskMatrix["cells"][number], risks: Risk[]): { score: number; level: RiskLevel } | null {
  const r = risks.find((x) => cell.risk_keys.includes(x.key)) ?? risks.find((x) => x.likelihood === cell.likelihood && x.impact === cell.impact);
  return r ? { score: r.score, level: r.level } : null;
}

/**
 * Matrix cells as sent by the server. Older stored report content has only `totals`, so the cells are then
 * grouped from the risks' own (server-set) likelihood and impact — counting only, no scoring (BUG-P2-06).
 */
export function matrixCells(matrix: Partial<RiskMatrix> | null | undefined, risks: Risk[]): RiskMatrix["cells"] {
  if (matrix?.cells) return matrix.cells;
  const cells = new Map<string, RiskMatrix["cells"][number]>();
  for (const r of risks) {
    const k = `${r.likelihood}:${r.impact}`;
    const c = cells.get(k) ?? { likelihood: r.likelihood, impact: r.impact, count: 0, risk_keys: [] };
    c.count += 1;
    c.risk_keys.push(r.key);
    cells.set(k, c);
  }
  return [...cells.values()];
}

const HIGH: RiskLevel[] = ["high", "very_high"];

export function unmitigatedHighRisks(risks: Risk[]): Risk[] {
  return risks.filter((r) => r.status !== "accepted" && r.status !== "mitigated" && HIGH.includes(r.level) && r.mitigation.test_types.length === 0);
}

export function acceptedWithoutComment(risks: Risk[]): Risk[] {
  return risks.filter((r) => r.status === "accepted" && !r.status_comment?.trim());
}

/** Summary lines for the risk register card (design §8.3), all computed from the server's risks. */
export function riskChecks(risks: Risk[]): GateCheck[] {
  const out: GateCheck[] = [];
  const un = unmitigatedHighRisks(risks);
  if (un.length) for (const r of un) out.push({ tone: "fail", text: `${r.key} (${LEVEL_TEXT[r.level]}) has no test type` });
  else if (risks.length) out.push({ tone: "ok", text: "Every High and Very high risk is mapped to at least one test type" });
  const acc = acceptedWithoutComment(risks);
  if (acc.length) out.push({ tone: "warn", text: `${acc.length} Accepted risk${acc.length === 1 ? " has" : "s have"} no comment` });
  return out;
}

/** Code-computed Gate 4 checks (design §8.4). */
export function gate4Checks(strategy: TestStrategy, risks: Risk[], opts: { requirementsVersion: number | null; g3Reopened: boolean }): GateCheck[] {
  const out: GateCheck[] = [];
  const based = strategy.approved_input?.requirements_version;
  if (based)
    out.push(
      opts.g3Reopened || (opts.requirementsVersion && opts.requirementsVersion !== based)
        ? { tone: "warn", text: `Requirements changed after this strategy was written. Approving uses version ${based}.` }
        : { tone: "ok", text: `Based on Requirements version ${based} (Gate 3 approved)` },
    );
  const s = strategy.sections;
  const decisions = [...s.test_levels, ...s.test_types];
  const missing = decisions.filter((d) => !d.rationale?.trim()).length;
  out.push(
    missing
      ? { tone: "warn", text: `${missing} decision${missing === 1 ? " has" : "s have"} no rationale` }
      : {
          tone: "ok",
          text: `${s.test_levels.length} test level${s.test_levels.length === 1 ? "" : "s"} and ${s.test_types.length} test type${s.test_types.length === 1 ? "" : "s"} decided, each with a rationale`,
        },
  );
  const un = unmitigatedHighRisks(risks);
  if (un.length) for (const r of un) out.push({ tone: "fail", text: `${r.key} (${LEVEL_TEXT[r.level]}) has no test type` });
  else out.push({ tone: "ok", text: "Every High and Very high risk is mapped to at least one test type" });
  const acc = acceptedWithoutComment(risks);
  if (acc.length) out.push({ tone: "warn", text: `${acc.length} Accepted risk${acc.length === 1 ? " has" : "s have"} no comment` });
  const entry = s.entry_criteria.length;
  const exit = s.exit_criteria.length;
  out.push(entry && exit ? { tone: "ok", text: `Entry (${entry}) and exit (${exit}) criteria defined` } : { tone: "fail", text: "Entry and exit criteria are both needed" });
  const approval = s.test_types.filter((t) => t.in_scope && (t.requires_approval || APPROVAL_TYPES.includes(t.type)));
  if (approval.length)
    out.push({
      tone: "info",
      text: `${approval.length} planned test type${approval.length === 1 ? " needs" : "s need"} separate approval before running: ${approval.map((t) => TYPE_NAMES[t.type]).join(", ")}`,
    });
  return out;
}
