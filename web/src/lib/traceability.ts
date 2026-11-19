// Traceability (design P3 §14): coverage tiles, matrix filters and chain levels. Pure; unit-tested.

import type { ArtefactRef, CaseExec, Chain, Coverage, ExecutionCoverage, Gaps, ImpactCell, Unavailable } from "./contract";

/** Phase 4 content, or `Unavailable` in reports stored before it. */
export function isAvailable<T>(x: T | Unavailable | undefined | null): x is T {
  return !!x && !(typeof x === "object" && "available" in (x as object) && (x as Unavailable).available === false);
}

export const PHASE4_SR = "not recorded in this version";
export const PHASE4_TEXT = "Shown once tests have run";

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
    ...executionTiles(c.execution, href),
    ...nfTiles(c.non_functional, href),
    ...changeTiles(c.changes, href),
  ];
}

/** Phase 6 tiles (design P6 §12.1): the counts are the lengths of the three change gap lists. */
export function changeTiles(n: Coverage["changes"] | undefined, href: (q: Record<string, string>) => string): Tile[] {
  if (!n) return [];
  const at = (id: string) => href({ view: "coverage" }) + `#${id}`;
  return [
    { id: "chg_outdated", label: "Scripts that are outdated", value: String(n.scripts_outdated), hint: "locators not found after a change", warn: n.scripts_outdated > 0, href: at("gap-outdated") },
    { id: "chg_rerun", label: "Impacted tests not re-run", value: String(n.impacted_not_rerun), hint: "no result since their change", warn: n.impacted_not_rerun > 0, href: at("gap-impacted") },
    { id: "chg_pages", label: "New pages without requirements", value: String(n.new_pages_without_requirements), hint: "pages a rescan added", href: at("gap-new-pages") },
  ];
}

const IMPACT_STATUS: Record<string, string> = { open: "open", resolved: "resolved", no_action: "no action needed" };
const IMPACT_LEVEL: Record<string, string> = { direct: "Direct", indirect: "Indirect", gap: "Not covered" };

/** The matrix's Change cell (design P6 §12.1): "Direct · CHG-0001 · open" / "Indirect · resolved" / "—". */
export function changeCellText(c: ImpactCell | null | undefined): string {
  if (!c) return "—";
  const level = IMPACT_LEVEL[c.level] ?? c.level;
  return c.status === "open" ? `${level} · ${c.change_set} · open` : `${level} · ${IMPACT_STATUS[c.status] ?? c.status}`;
}

/** "Change for TC-0019: directly affected by CHG-0001, open. Script outdated." */
export function changeSr(caseKey: string, c: ImpactCell | null | undefined, scriptState?: string): string {
  const outdated = scriptState === "outdated" ? " Script outdated." : "";
  if (!c) return `Change for ${caseKey}: not affected.${outdated}`;
  const how = c.level === "direct" ? "directly affected" : c.level === "indirect" ? "indirectly affected" : "not covered";
  return `Change for ${caseKey}: ${how} by ${c.change_set}, ${IMPACT_STATUS[c.status] ?? c.status}.${outdated}`;
}

/** 375 px card line: "Change: Direct · CHG-0001 · open · Script outdated". */
export function changeLine(x: Partial<CaseExec>): string | null {
  if (!x.impacted && x.script?.state !== "outdated") return null;
  return `Change: ${changeCellText(x.impacted)}${x.script?.state === "outdated" ? " · Script outdated" : ""}`;
}

/** Phase 5 tiles (design P5 §12.1): the counts are the lengths of the three non-functional gap lists. */
export function nfTiles(n: Coverage["non_functional"] | undefined, href: (q: Record<string, string>) => string): Tile[] {
  if (!n) return [];
  const at = (id: string) => href({ view: "coverage" }) + `#${id}`;
  return [
    { id: "nf_open", label: "Open accessibility findings", value: String(n.requirements_with_open_accessibility_findings), hint: "requirements with open findings", warn: n.requirements_with_open_accessibility_findings > 0, href: at("gap-nf-open") },
    { id: "nf_pages", label: "Pages not checked for accessibility", value: String(n.pages_not_checked_for_accessibility), hint: "pages no finished check covered", href: at("gap-nf-pages") },
    { id: "nf_without", label: "Non-functional requirements without evidence", value: String(n.non_functional_requirements_without_evidence), hint: "no check, run or finding yet", href: at("gap-nf-without") },
  ];
}

/** Phase 4 tiles (design P4 §12): numbers are text; flaky and errors are shown separately, never as passed. */
export function executionTiles(e: Coverage["execution"] | undefined, href: (q: Record<string, string>) => string): Tile[] {
  if (!isAvailable<ExecutionCoverage>(e)) return [{ id: "exec", label: "Execution coverage", value: "Not available", hint: PHASE4_TEXT, unavailable: true }];
  const r = e.results;
  const extra = [r.flaky ? `${r.flaky} flaky` : "", r.error ? `${r.error} error${r.error === 1 ? "" : "s"}` : "", r.blocked ? `${r.blocked} blocked` : ""].filter(Boolean).join(" · ");
  return [
    {
      id: "exec",
      label: "Execution coverage",
      value: `${e.requirements.with_result} of ${e.requirements.approved}`,
      hint: "approved requirements with a passed or failed result",
      href: href({ view: "coverage" }) + "#gap-execution",
    },
    {
      id: "pass",
      label: "Pass rate",
      value: r.tests ? `${r.passed} of ${r.tests} (${Math.round((r.passed / r.tests) * 100)}%)` : "No results yet",
      hint: `latest result per test; flaky and errors shown separately${extra ? ` · ${extra}` : ""}`,
      href: href({ view: "coverage" }) + "#gap-failed",
    },
    {
      id: "auto",
      label: "Automation coverage",
      value: `${e.automation.with_valid_script} of ${e.automation.approved_cases}`,
      hint: "approved cases with a valid script",
    },
  ];
}

const SCRIPT_WORD: Record<string, string> = { valid: "Valid", invalid: "Invalid", not_checked: "Not checked", outdated: "Outdated", needs_review: "Needs review", rejected: "Rejected" };
const RESULT_WORD: Record<string, string> = { passed: "Passed", failed: "Failed", error: "Error", flaky: "Flaky", blocked: "Blocked", skipped: "Skipped" };

export function scriptText(s: CaseExec["script"] | undefined): string {
  return s ? `${s.file} ${s.state === "valid" ? "✓" : s.state === "invalid" ? "✗" : "·"} ${SCRIPT_WORD[s.state] ?? s.state}` : "No script";
}

/** "✓ Passed RUN-0003"; a result recorded by hand adds "· By hand · Recorded by J. Tester" (P4-14 §5). */
export function resultText(r: CaseExec["result"] | undefined): string {
  return r ? `${r.status === "passed" ? "✓" : r.status === "failed" || r.status === "error" ? "✗" : "·"} ${RESULT_WORD[r.status] ?? r.status} ${r.run_key}${byHand(r)}` : "Not run";
}

function byHand(r: { manual?: boolean; recorded_by?: string | null }): string {
  return r.manual ? ` · By hand · Recorded by ${r.recorded_by || "someone"}` : "";
}

export function defectText(d: CaseExec["defects"][number]): string {
  return `${d.key} ${d.status.charAt(0).toUpperCase()}${d.status.slice(1)}`;
}

/** 375 px card line (design P4 §12): "Script ✓ Valid · Last result ✗ Failed (RUN-0003) · DEF-0001 Draft". */
export function execLine(x: Partial<CaseExec>): string {
  const sc = x.script ? `Script ${x.script.state === "valid" ? "✓" : x.script.state === "invalid" ? "✗" : "·"} ${SCRIPT_WORD[x.script.state] ?? x.script.state}` : "No script";
  const res = x.result ? `Last result ${x.result.status === "passed" ? "✓" : x.result.status === "failed" || x.result.status === "error" ? "✗" : "·"} ${RESULT_WORD[x.result.status] ?? x.result.status} (${x.result.run_key})${byHand(x.result)}` : "Not run";
  return [sc, res, ...(x.defects ?? []).map(defectText)].join(" · ");
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
  execution: "None. Every approved requirement has a passed or failed result.",
  failed: "None. No test failed in its latest run.",
  flaky: "None. No test passed only on retry.",
  outdated: "None. Every script matches its test case.",
  regression: "None. Every defect's test case is in the Regression suite.",
  scripts_outdated: "None. Every script's locators were found.",
  impacted: "None. Every impacted test has a result after its change.",
  new_pages: "None.",
  nf_open: "None. No requirement has an open accessibility finding.",
  nf_pages: "None. Every page was checked for accessibility.",
  nf_without: "None. Every non-functional requirement has a check, run or finding.",
};

/** Non-functional matrix cells as text (design P5 §12.1); null means the type was never checked. */
export function a11yCellText(c: { open: number; by_severity: Partial<Record<string, number>> } | null | undefined): string {
  if (!c) return "Not checked";
  if (!c.open) return "✓ None open";
  const crit = c.by_severity.critical ?? 0;
  return `${c.open} open${crit ? ` (${crit} critical)` : ""}`;
}

export function secCellText(c: { open: number } | null | undefined): string {
  if (!c) return "Not checked";
  return c.open ? `Open: ${c.open}` : "✓ None open";
}

export function perfCellText(c: { last_run: string; thresholds_failed: number } | null | undefined): string {
  if (!c) return "Not checked";
  return c.thresholds_failed ? `✗ Missed in ${c.last_run}` : "✓ Met";
}

export function gapCounts(g: Gaps) {
  const ev = g.requirements_without_execution_evidence;
  return {
    execution: isAvailable(ev) ? ev.automated_not_run.length + ev.manual_only.length : 0,
    failed: isAvailable(g.failed_tests) ? g.failed_tests.length : 0,
    flaky: g.flaky_tests?.length ?? 0,
    // Phase 6: the spec §12 list with reasons replaces the Phase 4 one (same scripts).
    outdated: g.scripts_outdated ? g.scripts_outdated.length : isAvailable(g.outdated_automation_scripts) ? g.outdated_automation_scripts.length : 0,
    regression: isAvailable(g.defects_without_regression_coverage) ? g.defects_without_regression_coverage.length : 0,
    requirements: (g.requirements_without_test_cases?.none?.length ?? 0) + (g.requirements_without_test_cases?.none_approved?.length ?? 0),
    orphans: g.test_cases_without_requirements?.length ?? 0,
    risks: g.untested_high_risk?.open?.length ?? 0,
    acs: g.acceptance_criteria_without_test_cases?.length ?? 0,
    features: g.features_without_requirements?.length ?? 0,
    nf_open: g.requirements_with_open_accessibility_findings?.length ?? 0,
    nf_pages: g.pages_not_checked_for_accessibility?.length ?? 0,
    nf_without: g.non_functional_requirements_without_evidence?.length ?? 0,
    impacted: g.impacted_not_rerun?.length ?? 0,
    new_pages: g.new_pages_without_requirements?.length ?? 0,
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
  automation_script: { one: "Script", many: "Scripts" },
  execution_result: { one: "Result", many: "Results" },
  defect: { one: "Defect", many: "Defects" },
  page: { one: "Page", many: "Pages" },
  quality_scan: { one: "Check", many: "Checks" },
  quality_finding: { one: "Finding", many: "Findings" },
  performance_profile: { one: "Load test profile", many: "Load test profiles" },
  performance_run: { one: "Load test", many: "Load tests" },
  threshold_result: { one: "Threshold result", many: "Threshold results" },
  // Phase 6 (P6-06)
  change_set: { one: "Change set", many: "Change sets" },
  change_item: { one: "Change", many: "Changes" },
  impact_item: { one: "Impact item", many: "Impact items" },
  page_object: { one: "Page object", many: "Page objects" },
  heal_suggestion: { one: "Repair suggestion", many: "Repair suggestions" },
  exploratory_session: { one: "Exploratory session", many: "Exploratory sessions" },
  release_assessment: { one: "Release assessment", many: "Release assessments" },
  release_criterion: { one: "Criterion", many: "Criteria" },
  evidence: { one: "Evidence", many: "Evidence" },
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
  if (/^DEF-/.test(key)) return "defect";
  if (/^RUN-\d+-\d+$/.test(key)) return "execution_result";
  if (/^(A11Y|SEC)-\d+-\d+$/.test(key)) return "quality_finding";
  if (/^CHG-\d+$/.test(key)) return "change_set";
  if (/^HEAL-\d+$/.test(key)) return "heal_suggestion";
  if (/^EXP-\d+(-\d+)?$/.test(key)) return "exploratory_session";
  if (/^REL-\d+$/.test(key)) return "release_assessment";
  if (/^(A11Y|SEC)-\d+$/.test(key)) return "quality_scan";
  if (/^PERF-\d+$/.test(key)) return "performance_run";
  if (/^PRF-\d+$/.test(key)) return "performance_profile";
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
    case "defect":
      return `${base}/defects/${key}`;
    case "execution_result":
      return `${base}/execution/${key.replace(/-\d+$/, "")}/results/${key}`;
    case "quality_scan":
      return `${base}/non-functional/checks/${key}`;
    case "quality_finding":
      return `${base}/non-functional/checks/${key.replace(/-\d+$/, "")}?finding=${key}`;
    case "performance_run":
      return `${base}/non-functional/load-tests/${key}`;
    case "performance_profile":
      return `${base}/non-functional/profiles/${key}`;
    case "change_set":
      return `${base}/discovery/changes/${key}`;
    case "exploratory_session":
      return `${base}/execution/exploratory/${key.replace(/^(EXP-\d+)-\d+$/, "$1")}`;
    case "release_assessment":
      return `${base}/release-readiness/${key}`;
    default:
      return `${base}/traceability/${key}`;
  }
}

export const CHAIN_KEY = /^(?:(REQ|AC|TCOND|TC|RISK|DEF|PERF|PRF|CHG|EXP|HEAL|REL)-\d+|(A11Y|SEC)-\d+(?:-\d+)?)$/;

export type ChainLevel = { type: string; items: ArtefactRef[]; root?: boolean };

/** Top-down order of the chain levels (§14.4). Risks and features are listed beside the chain. */
const RANK: Record<string, number> = {
  requirement: 0,
  acceptance_criterion: 1,
  // Phase 5 (P5-07): Requirement → Page → Check → Finding → Defect; Requirement → Profile → Load test → Threshold result → Defect.
  page: 1,
  performance_profile: 1,
  test_condition: 2,
  quality_scan: 2,
  performance_run: 2,
  test_case: 3,
  quality_finding: 3,
  threshold_result: 3,
  automation_script: 4,
  execution_result: 5,
  defect: 6,
};

/** Roots whose chain reads top-down from the root: CHG → change → impact item → …, HEAL → page object → …, EXP →
 * finding → defect, REL → criteria → evidence. */
const TOP_DOWN_ROOTS = new Set(["change_set", "heal_suggestion", "exploratory_session", "release_assessment"]);

/** Splits a chain into the nested levels (requirement → AC → condition → case) and the side list (risks, features). */
export function chainLevels(c: Chain): { chain: ChainLevel[]; side: ChainLevel[] } {
  const chain: ChainLevel[] = [];
  const side: ChainLevel[] = [];
  if (TOP_DOWN_ROOTS.has(c.root.type)) {
    // Phase 6 (design P6 §12.1): the root first, then `downstream` in the API's order; `upstream` is listed beside it.
    chain.push({ type: c.root.type, items: [c.root], root: true });
    for (const l of c.downstream ?? []) if (l.items?.length) chain.push({ type: l.type, items: l.items });
    for (const l of c.upstream ?? []) if (l.items?.length) side.push({ type: l.type, items: l.items });
    return { chain, side };
  }
  for (const l of [...(c.upstream ?? []), ...(c.downstream ?? [])]) {
    if (!l.items?.length) continue;
    (l.type in RANK ? chain : side).push({ type: l.type, items: l.items });
  }
  chain.push({ type: c.root.type, items: [c.root], root: true });
  chain.sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9));
  return { chain, side };
}
