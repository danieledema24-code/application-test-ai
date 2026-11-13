// Traceability (design P3 §14): coverage tiles, matrix filters and chain levels. Pure; unit-tested.

import type { ArtefactRef, Chain, Coverage, Gaps } from "./contract";

export const PHASE4_SR = "not available until Phase 4";
export const PHASE4_TEXT = "Available after test execution (Phase 4)";

export type Tile = { id: string; label: string; value: string; hint: string; href?: string; warn?: boolean; unavailable?: boolean };

function pct(n: number, d: number): string {
  return d > 0 ? ` · ${Math.round((n / d) * 100)}%` : "";
}

/** The seven coverage tiles (§14.2). Every number comes from the API; execution is never 0 or 0%. */
export function coverageTiles(c: Coverage, href: (q: Record<string, string>) => string, casesHref: (q: Record<string, string>) => string): Tile[] {
  // Stored report content can predate a field, so every block falls back to zeros rather than crashing.
  const r = c.requirements ?? { approved: 0, with_case: 0, with_approved_case: 0, percent_approved_covered: 0 };
  const ac = c.acceptance_criteria ?? { approved: 0, covered: 0, percent: 0 };
  const hr = c.high_risk_requirements ?? { total: 0, with_approved_case: 0 };
  const techItems = c.techniques ?? [];
  const complete = techItems.filter((t) => t.items > 0 && t.covered >= t.items).length;
  const bs = c.test_cases?.by_status ?? {};
  const total = Object.values(bs).reduce((a, b) => a + (b ?? 0), 0);
  const parts = (["approved", "draft", "rejected", "deprecated"] as const).map((k) => `${bs[k] ?? 0} ${k}`).join(" · ");
  return [
    {
      id: "req",
      label: "Requirements covered",
      value: `${r.with_approved_case} of ${r.approved}`,
      hint: `approved requirements have an approved test case · ${r.with_case} have any case${pct(r.with_approved_case, r.approved)}`,
      href: href({ view: "matrix", uncovered: "1" }),
    },
    { id: "ac", label: "Acceptance criteria covered", value: `${ac.covered} of ${ac.approved}`, hint: `approved criteria have a test case${pct(ac.covered, ac.approved)}`, href: href({ view: "coverage" }) + "#gap-acceptance-criteria" },
    { id: "risk", label: "High-risk requirements covered", value: `${hr.with_approved_case} of ${hr.total}`, hint: "High or Very high risk, open", href: href({ view: "matrix", risk_level: "high" }) },
    { id: "tech", label: "Technique coverage", value: `${complete} of ${techItems.length}`, hint: "conditions have a case for every value", href: casesHref({ view: "conditions" }) },
    { id: "cases", label: "Test cases", value: String(total), hint: parts, href: casesHref({}) },
    {
      id: "orphans",
      label: "Cases without a requirement",
      value: String(c.test_cases?.orphans ?? 0),
      hint: (c.test_cases?.orphans ?? 0) > 0 ? "Link each case to the requirement it checks" : "Every case is linked",
      warn: (c.test_cases?.orphans ?? 0) > 0,
      href: casesHref({ no_req: "1" }),
    },
    { id: "exec", label: "Execution coverage", value: "Not available", hint: PHASE4_TEXT, unavailable: true },
  ];
}

/** Gap list "empty" sentences (§14.2): never a bare 0. */
/**
 * True when Gate 5 has been approved at least once, so a "Last approved" snapshot exists even while the gate is
 * waiting again after a change (QA BUG-P3-18). Never true before the first approval.
 */
export function g5SnapshotExists(g: { status?: string | null; decision?: { decision?: string } | null; changes_since_approval?: number } | null | undefined): boolean {
  if (!g) return false;
  const st = (g.status ?? "").toLowerCase();
  return st === "approved" || st === "auto" || st === "auto_approved" || g.decision?.decision === "approve" || (g.changes_since_approval ?? 0) > 0;
}

export const GAP_EMPTY: Record<string, string> = {
  none: "None. Every approved requirement has a test case.",
  none_approved: "None. Every approved requirement has an approved test case.",
  orphans: "None. Every test case is linked to a requirement.",
  risks: "None. Every open High or Very high risk has an approved test case.",
  acs: "None. Every approved acceptance criterion has a test case.",
  features: "None. Every discovered feature has a requirement.",
};

export function gapCounts(g: Gaps) {
  return {
    requirements: (g.requirements_without_test_cases?.none?.length ?? 0) + (g.requirements_without_test_cases?.none_approved?.length ?? 0),
    orphans: g.test_cases_without_requirements?.length ?? 0,
    risks: g.untested_high_risk?.open?.length ?? 0,
    acs: g.acceptance_criteria_without_test_cases?.length ?? 0,
    features: g.features_without_requirements?.length ?? 0,
  };
}

// ---- Matrix filters (§14.3) -------------------------------------------------------------------------

export type TraceFilters = { dir: "forward" | "backward"; basis: "current" | "approved"; status: string; risk: string; uncovered: boolean };

type Params = { get(name: string): string | null };

export function parseTraceFilters(p: Params): TraceFilters {
  return {
    dir: p.get("dir") === "backward" ? "backward" : "forward",
    basis: p.get("basis") === "approved" ? "approved" : "current",
    status: p.get("status") ?? "",
    risk: p.get("risk_level") ?? "",
    uncovered: p.get("uncovered") === "1",
  };
}

export function traceFiltersToQuery(f: TraceFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.dir !== "forward") q.dir = f.dir;
  if (f.basis !== "current") q.basis = f.basis;
  if (f.status) q.status = f.status;
  if (f.risk) q.risk_level = f.risk;
  if (f.uncovered) q.uncovered = "1";
  return q;
}

/** Query for `GET /traceability` (API names). */
export function traceApiQuery(f: TraceFilters, cursor: string | null) {
  return { view: f.dir, basis: f.basis, status: f.status || undefined, risk_level: f.risk || undefined, uncovered: f.uncovered || undefined, limit: 50, cursor: cursor ?? undefined };
}

// ---- Chain (§14.4) ------------------------------------------------------------------------------------

const LEVEL: Record<string, { one: string; many: string }> = {
  requirement: { one: "Requirement", many: "Requirements" },
  acceptance_criterion: { one: "Acceptance criterion", many: "Acceptance criteria" },
  test_condition: { one: "Condition", many: "Conditions" },
  test_case: { one: "Test case", many: "Test cases" },
  risk: { one: "Risk", many: "Risks" },
  feature: { one: "Feature", many: "Features" },
  test_data: { one: "Test data", many: "Test data" },
};

export function levelName(type: string, n = 1): string {
  const l = LEVEL[type];
  if (!l) return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return n === 1 ? l.one : l.many;
}

/** Key prefix → artefact type, for links from the chain view and citations. */
export function typeOfKey(key: string): string | null {
  if (/^REQ-/.test(key)) return "requirement";
  if (/^AC-/.test(key)) return "acceptance_criterion";
  if (/^TCOND-/.test(key)) return "test_condition";
  if (/^TC-/.test(key)) return "test_case";
  if (/^TD-/.test(key)) return "test_data";
  if (/^RISK-/.test(key)) return "risk";
  return null;
}

/** Where a key opens in the app. */
export function keyHref(projectId: string, key: string, reqOfAc?: string | null): string {
  const base = `/projects/${projectId}`;
  switch (typeOfKey(key)) {
    case "requirement":
      return `${base}/requirements/${key}`;
    case "acceptance_criterion":
      return reqOfAc ? `${base}/requirements/${reqOfAc}#${key}` : `${base}/traceability/${key}`;
    case "test_condition":
      return `${base}/test-cases?view=conditions&condition=${key}`;
    case "test_case":
      return `${base}/test-cases/${key}`;
    case "test_data":
      return `${base}/test-cases?view=data&data=${key}`;
    case "risk":
      return `${base}/test-strategy?view=risks&risk=${key}`;
    default:
      return `${base}/traceability/${key}`;
  }
}

export const CHAIN_KEY = /^(REQ|AC|TCOND|TC|RISK)-\d+$/;

export type ChainLevel = { type: string; items: ArtefactRef[]; root?: boolean };

/** Top-down order of the chain levels (§14.4). Risks and features are listed beside the chain. */
const RANK: Record<string, number> = { requirement: 0, acceptance_criterion: 1, test_condition: 2, test_case: 3 };

/** Splits a chain into the nested levels (requirement → AC → condition → case) and the side list (risks, features). */
export function chainLevels(c: Chain): { chain: ChainLevel[]; side: ChainLevel[] } {
  const chain: ChainLevel[] = [];
  const side: ChainLevel[] = [];
  for (const l of [...(c.upstream ?? []), ...(c.downstream ?? [])]) {
    if (!l.items?.length) continue;
    (l.type in RANK ? chain : side).push({ type: l.type, items: l.items });
  }
  chain.push({ type: c.root.type, items: [c.root], root: true });
  chain.sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9));
  return { chain, side };
}
