// P6-01 change sets (design P6 §3, §6): types for the changes API and the pure rules the Changes screens share.
import type { EvidenceLink, IsoDate, ScanSettings, UserRef, Uuid, Workflow } from "./contract";

/** Design P6 §3.8, rendered by `HonestyNote`; never edited per screen. The API sends the same text as `statement`. */
export const CHANGE_STATEMENT =
  "Changes are detected by comparing what discovery saw in two scans. Content that discovery can't see (behind sign-in without credentials, inside canvases or iframes, or only after form submission) is not compared.";

/**
 * After Gate 2 the only re-scan is "Rescan and compare…" (design P6 §4.4, OQ1). Decided from the workflow's G2 state,
 * never from the scan list, so a slow or failed list can't fall back to the whole-chain re-scan. `null` = not known
 * yet (the workflow hasn't loaded): offer neither.
 */
export function g2EverApproved(wf: Pick<Workflow, "stages"> | undefined): boolean | null {
  if (!wf) return null;
  const g2 = wf.stages.find((s) => s.gate?.key === "G2")?.gate;
  return !!g2 && (g2.ever_approved === true || g2.status === "approved");
}

export const LATER_SCAN = "Choose a later scan in To.";
export const DESKTOP_VIEWPORT = "desktop 1440 × 900";

export type Significance = "structural" | "behavioural" | "cosmetic";
export const SIGNIFICANCES: Significance[] = ["structural", "behavioural", "cosmetic"];

export type ChangeKind =
  | "page_added"
  | "page_removed"
  | "page_changed"
  | "element_added"
  | "element_removed"
  | "element_renamed"
  | "element_moved"
  | "form_added"
  | "form_removed"
  | "form_changed"
  | "field_added"
  | "field_removed"
  | "field_changed"
  | "navigation_changed"
  | "journey_added"
  | "journey_removed"
  | "journey_changed"
  | "requirement_changed";

/** Display groups of design P6 §3.1 (`display_kind` from the API). */
export type DisplayKind = "added" | "removed" | "renamed" | "moved" | "changed" | "requirement_changed" | "content_values";

export type ChangeScanRef = {
  id: Uuid;
  key: string;
  number: number;
  status: string;
  partial: boolean;
  is_rescan: boolean;
  pages: number;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  created_at: IsoDate | null;
  g2_approved: boolean;
  baseline: boolean;
};

export type NotCompared = { page: string; url: string; missing_from: "base" | "target"; reason: string };

export type ChangeSetStatus = "queued" | "running" | "completed" | "failed";

export type ChangeSet = {
  id: Uuid;
  key: string;
  status: ChangeSetStatus;
  source: "rescan" | "compare";
  base: ChangeScanRef;
  target: ChangeScanRef;
  summary: {
    total: number | null;
    by_significance: Record<Significance, number> | null;
    by_kind: Record<string, number> | null;
    content_values: number | null;
    /** `structural`: matched pages with a structural item (with `removed`, the re-baseline share). */
    pages: { baseline: number; target: number; added: number; removed: number; changed: number; not_compared: number; structural?: number; baseline_compared?: number } | null;
  };
  not_compared: NotCompared[];
  rebaseline_suggested: boolean;
  generated_by: string;
  ai_summary: { text: string; generated_by: "ai" } | null;
  started_by: UserRef | null;
  created_at: IsoDate | null;
  finished_at: IsoDate | null;
  error: string | null;
  statement: string;
  permissions: { can_compare: boolean };
} & ChangeSetImpact;

export type ChangeRef = {
  page_id: string | null;
  url: string | null;
  fingerprint: string | null;
  screenshot: EvidenceLink | null;
  dom: EvidenceLink | null;
};

export type ChangeItem = {
  id: Uuid;
  kind: ChangeKind;
  display_kind: DisplayKind;
  significance: Significance;
  page_url: string | null;
  page: string | null;
  subject: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  before_ref: ChangeRef | null;
  after_ref: ChangeRef | null;
};

export type ChangeSetList = { items: ChangeSet[]; can_compare: boolean };
export type RescanResult = { scan: ChangeScanRef; baseline: ChangeScanRef };
export type RescanBody = { limits?: ScanSettings; compare_with?: Uuid };

// ---- labels ----------------------------------------------------------------

export const DISPLAY_KIND_LABEL: Record<DisplayKind, string> = {
  added: "Added",
  removed: "Removed",
  renamed: "Renamed",
  moved: "Moved",
  changed: "Changed",
  requirement_changed: "Requirement changed",
  content_values: "Content values changed",
};

export const SIGNIFICANCE_LABEL: Record<Significance, string> = { structural: "Structural", behavioural: "Behavioural", cosmetic: "Cosmetic" };

/** Tooltip and legend text (design P6 §3.2). */
export const SIGNIFICANCE_HELP: Record<Significance, string> = {
  structural: "Something was added, removed or now behaves differently: pages, forms, fields, required or allowed values, status codes.",
  behavioural: "Something people click or read to act was renamed, or navigation or a journey changed.",
  cosmetic: "Headings, moves that don't affect a test, and changed numbers or prices.",
};

/** "Scan 2 · 13 Nov 2026 · approved at Gate 2" for selects (design P6 §6.1, §6.3). */
export function scanOptionLabel(s: { number: number; started_at?: IsoDate | null; created_at?: IsoDate | null; status: string; is_rescan?: boolean; g2_approved?: boolean }, fmt: (iso: string | null | undefined) => string): string {
  const bits = [`Scan ${s.number}`, fmt(s.started_at ?? s.created_at)];
  if (s.g2_approved) bits.push("approved at Gate 2");
  else if (s.is_rescan) bits.push("rescan");
  return `${bits.join(" · ")}${s.status === "partial" ? " (partial)" : ""}`;
}

/** The "Kind" column of the scan history (design P6 §6.1). */
export function scanKindLabel(s: { number: number; is_rescan?: boolean; baseline_number?: number | null }, first: number): string {
  if (s.is_rescan) return s.baseline_number ? `Rescan, compared with ${s.baseline_number}` : "Rescan";
  return s.number === first ? "First scan" : "Re-scan";
}

export const COMPARABLE = new Set(["completed", "partial"]);

/** Inline validation of the compare picker: To must be a later scan than From. */
export function compareError(from: number | null, to: number | null): string | null {
  if (from === null || to === null) return null;
  return to > from ? null : LATER_SCAN;
}

/** The change set that already compares this pair (any status but failed), so [Compare] becomes [Open CHG-n]. */
export function existingPair(sets: ChangeSet[], from: number | null, to: number | null): ChangeSet | null {
  if (from === null || to === null) return null;
  return sets.find((s) => s.status !== "failed" && s.base.number === from && s.target.number === to) ?? null;
}

/** Hint under "Compare with" when the person picks a scan that wasn't approved at Gate 2 (design P6 §6.3). */
export function compareWithHint(chosen: { number: number; g2_approved?: boolean } | undefined, baseline: { number: number } | undefined): string | null {
  if (!chosen || !baseline || chosen.g2_approved || chosen.number === baseline.number) return null;
  return `Scan ${chosen.number} wasn't approved at Gate 2. Changes are still listed, but approved work is linked to Scan ${baseline.number}.`;
}

/** "9 changes: 6 structural · 3 behavioural · 0 cosmetic". */
export function countsLine(set: Pick<ChangeSet, "summary">): string {
  const total = set.summary.total ?? 0;
  const by = set.summary.by_significance;
  const head = `${total} change${total === 1 ? "" : "s"}`;
  if (!by) return head;
  return `${head}: ${SIGNIFICANCES.map((s) => `${by[s] ?? 0} ${s}`).join(" · ")}`;
}

// ---- what changed: groups and filters (design P6 §6.5) -----------------------

export type Group = "pages" | "elements" | "navigation" | "journeys" | "requirements";
export const GROUPS: { id: Group; title: string; empty: string }[] = [
  { id: "pages", title: "Pages", empty: "No page changes." },
  { id: "elements", title: "Elements and form fields", empty: "No element or form field changes." },
  { id: "navigation", title: "Navigation", empty: "No navigation changes." },
  { id: "journeys", title: "Journeys", empty: "No journey changes." },
  { id: "requirements", title: "Requirements", empty: "No requirement changes." },
];

export function groupOf(item: Pick<ChangeItem, "kind">): Group {
  if (item.kind.startsWith("page_")) return "pages";
  if (item.kind === "navigation_changed") return "navigation";
  if (item.kind.startsWith("journey_")) return "journeys";
  if (item.kind === "requirement_changed") return "requirements";
  return "elements";
}

export type ChangeFilter = { hideCosmetic: boolean; kind: DisplayKind | ""; significance: Significance | ""; page: string };

export function filterItems(items: ChangeItem[], f: ChangeFilter): ChangeItem[] {
  return items.filter(
    (i) =>
      !(f.hideCosmetic && i.significance === "cosmetic") &&
      (!f.kind || i.display_kind === f.kind) &&
      (!f.significance || i.significance === f.significance) &&
      (!f.page || i.page === f.page),
  );
}

export function cosmeticCount(items: ChangeItem[]): number {
  return items.filter((i) => i.significance === "cosmetic").length;
}

/** "Showing 8 of 9 changes" (announced politely when filters change). */
export function showingLine(shown: number, total: number): string {
  return `Showing ${shown} of ${total} change${total === 1 ? "" : "s"}`;
}

/** Pages that have a before/after to show: page items plus every page with element or field changes. */
export function pagesWithChanges(items: ChangeItem[]): string[] {
  return [...new Set(items.filter((i) => i.page && groupOf(i) !== "journeys").map((i) => i.page!))].sort();
}

// ---- before / after as text --------------------------------------------------

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function constraintText(c: Record<string, unknown> | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.maxlength !== undefined) out.push(`up to ${str(c.maxlength)} characters`);
  if (c.minlength !== undefined) out.push(`at least ${str(c.minlength)} characters`);
  if (c.min !== undefined) out.push(`min ${str(c.min)}`);
  if (c.max !== undefined) out.push(`max ${str(c.max)}`);
  if (c.pattern !== undefined) out.push(`pattern ${str(c.pattern)}`);
  return out;
}

/** One side of a change as plain text: "Label \"Message\" · optional", "Text · optional · up to 20 characters". */
export function sideText(item: Pick<ChangeItem, "kind" | "display_kind">, side: Record<string, unknown> | null): string {
  if (!side) return "—";
  const k = item.kind;
  if (item.display_kind === "content_values") return ((side.values as unknown[]) ?? []).map(str).join(", ");
  if (k.startsWith("field_")) {
    const bits = [`"${str(side.label)}"`, str(side.type || "text"), side.required ? "required" : "optional", ...constraintText(side.constraints as Record<string, unknown>)];
    const options = side.options as unknown[] | null;
    if (options?.length) bits.push(`options: ${options.map(str).join(", ")}`);
    return bits.join(" · ");
  }
  if (k.startsWith("form_")) {
    const fields = (side.fields as unknown[]) ?? [];
    return [`${fields.length} field${fields.length === 1 ? "" : "s"}`, side.submit_label ? `submit "${str(side.submit_label)}"` : ""].filter(Boolean).join(" · ");
  }
  if (k.startsWith("element_")) return `"${str(side.name)}"`;
  if (k.startsWith("page_")) {
    if (side.headings) return ((side.headings as unknown[]) ?? []).map(str).join(" / ") || "(no headings)";
    const status = side.http_status ? ` · ${str(side.http_status)}` : "";
    return `${str(side.title) || "Untitled"}${status}`;
  }
  if (k.startsWith("journey_")) return ((side.steps as unknown[]) ?? []).map((s, i) => `${i + 1} ${str(s)}`).join(" → ");
  if (k === "navigation_changed") return ((side.links as { text: string }[]) ?? []).map((l) => l.text).join(" · ");
  if (k === "requirement_changed") return `${str(side.key)} ${str(side.title)}`.trim();
  return "—";
}

/** The plain names a word diff compares (element names, field labels), else null for a text cell. */
export function diffNames(item: ChangeItem): { from: string; to: string } | null {
  const b = item.before ?? {};
  const a = item.after ?? {};
  if (item.kind === "element_renamed") return { from: str(b.name), to: str(a.name) };
  if (item.kind === "field_changed" && b.label !== a.label) return { from: str(b.label), to: str(a.label) };
  return null;
}

/** Navigation item rows: "+ Link added: \"Offers\" → /offers". */
export function navigationLines(item: ChangeItem): string[] {
  const a = (item.after ?? {}) as { added?: { text: string; href: string }[]; removed?: { text: string; href: string }[]; renamed?: { before: string; after: string; href: string }[] };
  return [
    ...(a.added ?? []).map((x) => `Link added: "${x.text}" → ${x.href}`),
    ...(a.removed ?? []).map((x) => `Link removed: "${x.text}" (was ${x.href})`),
    ...(a.renamed ?? []).map((x) => `Link renamed: "${x.before}" → "${x.after}" (${x.href})`),
  ];
}

/** Journey steps that differ, in words: "step 3 \"Enter Message\" → \"Enter Your message\"". */
export function journeyLines(item: ChangeItem): string[] {
  const b = ((item.before?.steps as unknown[]) ?? []).map(str);
  const a = ((item.after?.steps as unknown[]) ?? []).map(str);
  if (!b.length) return a.map((s, i) => `step ${i + 1} "${s}" added`);
  if (!a.length) return b.map((s, i) => `step ${i + 1} "${s}" removed`);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (b[i] === a[i]) continue;
    if (b[i] === undefined) out.push(`step ${i + 1} "${a[i]}" added`);
    else if (a[i] === undefined) out.push(`step ${i + 1} "${b[i]}" removed`);
    else out.push(`step ${i + 1} "${b[i]}" → "${a[i]}"`);
  }
  return out;
}

/** "Before: /contact in Scan 2, 13 Nov 2026, desktop 1440 × 900." (design P6 §6.6). */
export function screenshotAlt(side: "Before" | "After", page: string, scan: number, date: string): string {
  return `${side}: ${page} in Scan ${scan}, ${date}, ${DESKTOP_VIEWPORT}.`;
}

/** "Scan 3 stopped early after 9 pages. …" when either scan is partial (design P6 §6.5, OQ2). */
export function partialWarning(set: Pick<ChangeSet, "base" | "target">): string | null {
  const s = set.target.partial ? set.target : set.base.partial ? set.base : null;
  if (!s) return null;
  return `Scan ${s.number} stopped early after ${s.pages} page${s.pages === 1 ? "" : "s"}. Pages it didn't reach are listed as 'Not compared', not as removed.`;
}

/** Re-baseline warning (design P6 §6.4): removed and structurally changed pages over the baseline pages compared. */
export function rebaselineText(set: Pick<ChangeSet, "summary" | "target">): string {
  const p = set.summary.pages;
  const counts = p && p.structural !== undefined && p.baseline_compared ? ` (${p.removed + p.structural} of ${p.baseline_compared})` : "";
  return `More than half the pages changed${counts}. Approved requirements may no longer describe the site. Consider regenerating requirements from Scan ${set.target.number}; you review the result before anything is replaced.`;
}

/** Status text of a change set (design P6 §6.4). */
export function setStatusLabel(status: ChangeSetStatus): string {
  return status === "completed" ? "Compared" : status === "failed" ? "Didn't complete" : "Comparing…";
}

// ---- impact and the regression recommendation (P6-02, design P6 §3.3, §7) -------------------------------------

export type ImpactLevel = "direct" | "indirect" | "gap";
export type ImpactAction = "rerun" | "review" | "heal" | "regenerate" | "write_requirement";
export type ImpactStatus = "open" | "resolved" | "no_action";
export type ImpactTargetKind = "requirement" | "test_case" | "automation_script" | "defect" | "quality_finding" | "performance_target" | "coverage_gap";
export type ImpactGroup = "requirements" | "defects" | "page_removed" | "review" | "gaps";

export const IMPACT_LEVELS: ImpactLevel[] = ["direct", "indirect", "gap"];
export const IMPACT_LEVEL_LABEL: Record<ImpactLevel, string> = { direct: "Direct", indirect: "Indirect", gap: "Not covered" };
/** The level's meaning line (legend and the row's screen-reader text). */
export const IMPACT_LEVEL_HELP: Record<ImpactLevel, string> = {
  direct: "A test step or script uses the changed element.",
  indirect: "On a changed page or feature, but no step uses the changed element.",
  gap: "Nothing tests this yet.",
};
export const IMPACT_ACTION_LABEL: Record<ImpactAction, string> = { rerun: "Re-run", review: "Review", heal: "Repair the script", regenerate: "Regenerate", write_requirement: "Write a requirement" };
export const IMPACT_STATUSES: ImpactStatus[] = ["open", "resolved", "no_action"];
export const IMPACT_STATUS_LABEL: Record<ImpactStatus, string> = { open: "Open", resolved: "Resolved", no_action: "No action needed" };
export const TARGET_KIND_LABEL: Record<Exclude<ImpactTargetKind, "coverage_gap">, string> = {
  requirement: "Requirement",
  test_case: "Test case",
  automation_script: "Script",
  defect: "Defect",
  quality_finding: "Finding",
  performance_target: "Performance target",
};
export const IMPACT_GROUP_TITLE: Record<ImpactGroup, string> = {
  requirements: "Requirements and tests",
  defects: "Defects to re-test",
  page_removed: "Page removed: review",
  review: "Findings and targets to review",
  gaps: "Not covered by any requirement",
};
export const IMPACT_GROUPS: ImpactGroup[] = ["requirements", "defects", "page_removed", "review", "gaps"];
export const IMPACT_HOW =
  "Approved versions stay current after a rescan. Work through these items to bring them up to date.";
export const CHOOSE_OPTION = "Choose an option.";
export const NO_ACTION_REASON = "Say why no action is needed.";

export type ScriptRef = { id: string | null; path: string | null; state: string | null; outdated_reason: string | null };
export type HealRef = { id: string; key: string; status: string };

export type ImpactTarget = {
  id: string | null;
  key: string | null;
  title: string | null;
  // test_case
  requirement_lineages?: string[];
  script?: ScriptRef | null;
  // automation_script
  path?: string | null;
  state?: string | null;
  outdated_reason?: string | null;
  case_lineage_id?: string;
  locators?: { file: string; getter: string; page: string; expression: string }[];
  heal_suggestions?: HealRef[];
  // defect, finding
  severity?: string;
  status?: string;
  kind?: string | null;
};

export type ImpactItem = {
  id: Uuid;
  target_kind: ImpactTargetKind;
  target_ref: string;
  level: ImpactLevel;
  action: ImpactAction;
  reason: string;
  status: ImpactStatus;
  status_reason: string | null;
  resolved_by: UserRef | null;
  resolved_by_run: { id: string; key: string | null } | null;
  resolved_at: IsoDate | null;
  target: ImpactTarget | null;
  changes: { id: string; subject: string }[];
  group: ImpactGroup;
  page: string | null;
  can_close: boolean;
};

export type ImpactCounts = {
  total: number;
  open: number;
  requirements: number;
  test_cases: number;
  scripts_outdated: number;
  defects: number;
  review: number;
  gaps: number;
  must: number;
  should: number;
  by_level?: Record<ImpactLevel, number>;
  by_status?: Record<ImpactStatus, number>;
};

export type ImpactView = {
  change_set: { id: Uuid; key: string };
  generated_by: string;
  permissions: { can_close: boolean };
  available: boolean;
  reason: string | null;
  items: ImpactItem[];
  counts: ImpactCounts | null;
};

export type RegressionPick = {
  case_lineage_id: string;
  key: string;
  title: string;
  reasons: string[];
  test_case_id: string | null;
  script: (ScriptRef & { heal_suggestions: HealRef[] }) | null;
  runnable: boolean;
  not_runnable_reason: string | null;
  /** Moved from Must run to Not included (a link to a removed page, D28): P6-05/G9 still see it was must-run. */
  was_must?: boolean;
};

export type RequestedRun = { id: Uuid; key: string; status: string; include_should: boolean; created_at: IsoDate | null };

export type Recommendation = {
  change_set: { id: Uuid; key: string };
  permissions: { can_request: boolean };
  available: boolean;
  reason: string | null;
  order?: "rules" | "ai";
  explanation?: string | null;
  must?: RegressionPick[];
  should?: RegressionPick[];
  excluded?: RegressionPick[];
  estimate?: { must_seconds: number | null; with_should_seconds: number | null; must_tests: number; with_should_tests: number; from_run_key: string | null; no_history?: string[] };
  blocked?: { outdated: number; message: string; case_keys: string[] } | null;
  requested_runs?: RequestedRun[];
};

/** Change set additions of P6-02 (`GET /change-sets/{id}`): null for a person's comparison. */
export type ChangeSetImpact = {
  impact?: ImpactCounts | null;
  regression?: { must: number; should: number; requested_run: { id: Uuid; key: string; status: string } | null } | null;
};

export type ImpactFilter = { level: ImpactLevel | ""; status: ImpactStatus | "all"; kind: Exclude<ImpactTargetKind, "coverage_gap"> | "" };
export const DEFAULT_IMPACT_FILTER: ImpactFilter = { level: "", status: "open", kind: "" };

export function filterImpact(items: ImpactItem[], f: ImpactFilter): ImpactItem[] {
  return items.filter((i) => (!f.level || i.level === f.level) && (f.status === "all" || i.status === f.status) && (!f.kind || i.target_kind === f.kind));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Impact · 15 open of 18". */
export function impactHeading(items: ImpactItem[]): string {
  return `Impact · ${items.filter((i) => i.status === "open").length} open of ${items.length}`;
}

/** The row label of an item's target: "TC-0019 Send the form…", "/offers · page added". */
export function targetLabel(i: ImpactItem): string {
  const t = i.target;
  if (i.target_kind === "coverage_gap") return t?.title ?? "Not covered";
  if (i.target_kind === "automation_script") return `Script ${t?.path ?? "(no longer in the bundle)"}`;
  if (i.target_kind === "performance_target") return `${t?.key ?? "Load profile"} target ${i.page ?? ""}`.trim();
  if (!t) return `${TARGET_KIND_LABEL[i.target_kind]} (no longer current)`;
  return [t.key, t.title].filter(Boolean).join(" ");
}

/** How a re-run or repair item closes (design P6 §7.1, §7.3); null for items a person closes. */
export function autoCloseLine(i: ImpactItem, setKey: string): string | null {
  if (i.action === "rerun") {
    const key = i.target_kind === "defect" ? (i.reason.match(/Re-tested by ([^.]+)\./)?.[1] ?? "its test case") : (i.target?.key ?? "the test case");
    return `Closes by itself when ${key} has a result from a run after ${setKey}.`;
  }
  if (i.action === "heal") return "Closes by itself when the script is valid again.";
  return null;
}

/** The closed line (design P6 §3.3, §7.3): "Resolved by RUN-0005 (15 Nov 15:40)", "Resolved by M. Member", "M. Member: 'reason'". */
export function closedLine(i: ImpactItem, fmt: (iso: string | null | undefined) => string): string | null {
  if (i.status === "open") return null;
  const who = i.resolved_by?.full_name || i.resolved_by?.email || null;
  if (i.status === "no_action") return `No action needed · ${who ?? "Someone"}: '${i.status_reason ?? ""}'`;
  const when = i.resolved_at ? ` (${fmt(i.resolved_at)})` : "";
  if (i.resolved_by_run) return `Resolved by ${i.resolved_by_run.key ?? "a run"}${when}`;
  if (i.action === "heal") return `Resolved: ${i.target?.key ? `${i.target.key}'s script` : "the script"} is valid again.`;
  return `Resolved by ${who ?? "someone"}${when}`;
}

export type ImpactNode = { item: ImpactItem; children: ImpactNode[] };

/**
 * The "Requirements and tests" group as a tree (design P6 §7.1): requirement → its test cases → their scripts.
 * Cases and scripts whose parent isn't listed stay at the top level, so nothing is hidden by a filter.
 */
export function requirementTree(items: ImpactItem[]): ImpactNode[] {
  const reqs = items.filter((i) => i.target_kind === "requirement");
  const cases = items.filter((i) => i.target_kind === "test_case");
  const scripts = items.filter((i) => i.target_kind === "automation_script");
  const placedCases = new Set<string>();
  const placedScripts = new Set<string>();
  const caseNode = (c: ImpactItem): ImpactNode => {
    const kids = scripts.filter((s) => s.target_ref === c.target_ref);
    kids.forEach((s) => placedScripts.add(s.id));
    return { item: c, children: kids.map((s) => ({ item: s, children: [] })) };
  };
  const roots: ImpactNode[] = reqs.map((r) => {
    const mine = cases.filter((c) => c.target?.requirement_lineages?.includes(r.target_ref) && !placedCases.has(c.id));
    mine.forEach((c) => placedCases.add(c.id));
    return { item: r, children: mine.map(caseNode) };
  });
  for (const c of cases) if (!placedCases.has(c.id)) roots.push(caseNode(c));
  for (const s of scripts) if (!placedScripts.has(s.id)) roots.push({ item: s, children: [] });
  return roots;
}

/** Items of one group in display order (the server's order), and of the page-removed group by page. */
export function byGroup(items: ImpactItem[]): Record<ImpactGroup, ImpactItem[]> {
  const out: Record<ImpactGroup, ImpactItem[]> = { requirements: [], defects: [], page_removed: [], review: [], gaps: [] };
  for (const i of items) out[i.group].push(i);
  return out;
}

/**
 * After closing an item, focus goes to the next open item's [Close…] in the same group, else the group heading
 * (design P6 §7.2, §16.2). `items` are the rows as they were before the close.
 */
export function nextCloseTarget(items: ImpactItem[], closedId: string): { kind: "item"; id: string } | { kind: "group"; group: ImpactGroup } {
  const at = items.findIndex((i) => i.id === closedId);
  const group = items[at]?.group ?? "requirements";
  const same = items.filter((i) => i.group === group);
  const pos = same.findIndex((i) => i.id === closedId);
  const after = [...same.slice(pos + 1), ...same.slice(0, Math.max(pos, 0))];
  const next = after.find((i) => i.id !== closedId && i.can_close && i.status === "open");
  return next ? { kind: "item", id: next.id } : { kind: "group", group };
}

/** Close dialog checks, on submit (design P6 §7.2). */
export function closeErrors(choice: "resolved" | "no_action" | null, reason: string): { choice?: string; reason?: string } {
  if (!choice) return { choice: CHOOSE_OPTION };
  if (choice === "no_action" && !reason.trim()) return { reason: NO_ACTION_REASON };
  return {};
}

/** "about 3 min", "under a minute"; null when there is no timing. */
export function durationText(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return "under a minute";
  return `about ${Math.round(seconds / 60)} min`;
}

/** The regression tab's estimate line (design P6 §7.4). */
export function estimateLine(rec: Recommendation, includeShould: boolean): string {
  const e = rec.estimate;
  const s = includeShould ? e?.with_should_seconds : e?.must_seconds;
  const t = durationText(s);
  if (!t) return "No estimate: these tests haven't run before.";
  const base = e?.from_run_key ? `${t} (from ${e.from_run_key})` : t;
  // Tests without a timing count as the average of the others; say which they are.
  const none = (e?.no_history ?? []).filter((k) => includeShould || (rec.must ?? []).some((p) => p.key === k));
  if (!none.length) return base;
  const shown = none.length > 3 ? `${none.slice(0, 3).join(", ")} and ${none.length - 3} more` : none.join(", ");
  return `${base} · no timing yet for ${shown}`;
}

/** `[x] Include the 4 "should run" tests  (7 tests, about 3 min · without them: 3 tests, about 1 min)`. */
export function includeShouldText(rec: Recommendation): { label: string; detail: string } {
  const n = rec.should?.length ?? 0;
  const e = rec.estimate;
  const t = (secs: number | null | undefined) => durationText(secs) ?? "no estimate";
  return {
    label: `Include the ${n} "should run" test${n === 1 ? "" : "s"}`,
    detail: e ? `${plural(e.with_should_tests, "test")}, ${t(e.with_should_seconds)} · without them: ${plural(e.must_tests, "test")}, ${t(e.must_seconds)}` : "",
  };
}

/** Run status in words for "was requested from this recommendation" (P4 §3 wording). */
export function requestedRunStatus(status: string): string {
  return (
    {
      awaiting_authorisation: "Waiting for authorisation",
      rejected: "Not authorised",
      queued: "Waiting to start",
      running: "Running",
      passed: "Finished",
      failed: "Finished",
      error: "Didn't complete",
      cancelled: "Cancelled",
    }[status] ?? status
  );
}

/** Toast after a regression run request (design P6 §7.4). */
export function requestedToast(runKey: string, canApprove: boolean): string {
  return canApprove ? `${runKey} created. Review and authorise it to start.` : `${runKey} requested. Someone who can approve must authorise it (Gate 7).`;
}

/** The Affected summary card (design P6 §6.4). */
export function affectedLines(c: ImpactCounts): string[] {
  return [
    `${plural(c.requirements, "requirement")} · ${plural(c.test_cases, "test case")}`,
    `${plural(c.scripts_outdated, "script")} outdated`,
    `${plural(c.defects, "defect")} to re-test`,
    `${c.review} to review · ${c.gaps} not covered`,
  ];
}

export type NextStep = { text: string; done: boolean; tab: "impact" | "regression" | "repairs"; action: string; query?: string };

/** The Next steps card (design P6 §6.4), from the impact rows and the recommendation as they are now. */
export function nextSteps(items: ImpactItem[], rec: Recommendation | undefined): NextStep[] {
  const repairs = items.filter((i) => i.action === "heal" && i.status === "open").length;
  const anyRepairs = items.some((i) => i.action === "heal");
  const closable = items.filter((i) => (i.action === "review" || i.action === "regenerate" || i.action === "write_requirement") && i.status === "open").length;
  const requested = rec?.requested_runs?.[0];
  const steps: NextStep[] = [];
  if (anyRepairs)
    steps.push(
      repairs
        ? { text: `Repair ${plural(repairs, "outdated script")}`, done: false, tab: "repairs", action: "Review repairs" }
        : { text: "Scripts repaired", done: true, tab: "repairs", action: "Review repairs" },
    );
  steps.push(
    requested
      ? { text: `Regression run requested (${requested.key})`, done: true, tab: "regression", action: "Open regression run" }
      : { text: "Request the regression run (Gate 7)", done: false, tab: "regression", action: "Open regression run" },
  );
  steps.push(
    closable
      ? { text: `Close ${plural(closable, "review item")}`, done: false, tab: "impact", action: "Open impact" }
      : { text: "Review items closed", done: true, tab: "impact", action: "Open impact" },
  );
  return steps;
}

/** The Latest change card's impact line (design P6 §6.1); null for a comparison without impact. */
export function impactLine(set: Pick<ChangeSet, "impact" | "regression">): string | null {
  const c = set.impact;
  if (!c) return null;
  const run = set.regression?.requested_run;
  return `${c.open} of ${plural(c.total, "impact item")} open · ${plural(c.scripts_outdated, "script")} outdated · regression run: ${run ? `${run.key} requested` : "not requested yet"}`;
}
