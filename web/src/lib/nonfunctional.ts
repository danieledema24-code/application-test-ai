// Non-functional checks (design P5 §3, §6–§9): accessibility (P5-02), passive security (P5-03) and load tests
// (P5-01b/c). Types mirror backend app/api/routers/nonfunctional.py; helpers are pure and unit-tested in
// tests/unit/phase5.spec.ts. Numbers always come from the API; this file only words them.

import type { Tone } from "@/components/ui/StatusPill";
import type { Person } from "./execution";
import type { Health } from "./contract";

type Uuid = string;
type IsoDate = string;

// ------------------------------------------------------------------ fixed statements (§3.6; never paraphrased)

export const SECURITY_STATEMENT =
  "This is a passive check of what a normal visitor's browser receives. It is not a security audit or a penetration test, and no findings does not mean the site is secure.";
export const A11Y_STATEMENT = "Automated checks find only part of WCAG 2.2 AA issues. Screen reader, zoom and cognitive checks need a person.";
export const PERF_LOCATION = "Load is generated from the platform host, not from your users' locations.";

/** The run page's defect line: "Defect drafted: …", "Occurrence added to: …", or both. */
export function runDefectGroups(defects: { key: string; summary: string; status: string; link?: string }[] | undefined) {
  const all = defects ?? [];
  return [
    { label: "Defect drafted", items: all.filter((d) => d.link !== "occurrence_added") },
    { label: "Occurrence added to", items: all.filter((d) => d.link === "occurrence_added") },
  ].filter((g) => g.items.length > 0);
}

export function perfStatement(version: string | null | undefined): string {
  return `Measured with the built-in load generator${version ? ` ${version}` : ""}. ${PERF_LOCATION}`;
}
export const KEYBOARD_NO_DRAFT = "Keyboard checks don't create defect drafts automatically. Raise one if a person confirms it.";
export const NO_DRAFT_ABORTED =
  "No defect drafted: a load test stopped this way may be caused by the environment. Raise one if the site itself is at fault.";
export const KILL_SWITCH_LINE = "The kill switch stops load by itself when the site looks overwhelmed, to protect it.";
export const G2_FIRST = "Non-functional checks use the pages discovery found. Approve Gate 2 first.";
export const G4_FIRST = "Load profiles use the approved Test Strategy. Approve Gate 4 first.";
export const PERCENTILE_HELP =
  "p50: half the requests were faster than this. p95: 95 out of 100 were faster. p99: 99 out of 100 were faster. The slowest few requests are what busy visitors notice.";
export const MEMBER_APPROVE_NOTE = "Approving load tests needs approval permission. Someone who can approve will see this request.";

// ------------------------------------------------------------------ API shapes

export type CheckKind = "accessibility" | "security";
export type ScanStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type A11ySeverity = "critical" | "serious" | "moderate" | "minor";
export type SecSeverity = "high" | "medium" | "low" | "info";
export type FindingStatus = "open" | "accepted_risk" | "false_positive" | "fixed";
export type CheckResult = "failed" | "passed" | "not_applicable" | "not_checked";

export type ProgressRow = { url: string; path: string; viewport: string; state: "done" | "not_checked" | "checking" | "waiting"; reason: string | null; problems: number };
export type KeyboardSummary = {
  url: string;
  viewport: string;
  focusable?: number;
  tabbable?: number;
  presses?: number;
  trap?: boolean;
  not_visible?: number;
  not_reachable?: number;
  completed?: boolean;
  order?: { n: number; role: string; label: string }[];
  error?: string;
  path?: string;
};
export type SecurityRuleRow = {
  rule_id: string;
  subject: string;
  category: "transport" | "headers" | "cookies" | "content";
  title: string;
  severity: SecSeverity;
  result: CheckResult;
  reason: string;
  passed_text?: string;
  pages: string[];
  page_count: number;
  observed: string;
  why?: string;
  fix?: string;
  reference?: { name: string; url: string } | null;
};
export type ScanSummary = {
  visited?: number;
  total?: number;
  progress?: ProgressRow[];
  drafted?: string[];
  occurrences_added?: string[];
  not_found_again?: number;
  pages_checked?: number;
  pages_not_checked?: number;
  rules_failed?: number;
  pages_with_problems?: number;
  by_severity?: Partial<Record<A11ySeverity, number>>;
  needs_review?: number;
  keyboard?: KeyboardSummary[];
  keyboard_findings?: number;
  elements?: number;
  rules?: SecurityRuleRow[];
  counts?: Partial<Record<CheckResult, number>>;
};
export type Scan = {
  id: Uuid;
  key: string;
  kind: CheckKind;
  status: ScanStatus;
  status_label: string;
  pages: number;
  viewports: string[];
  keyboard: boolean;
  signed_in: boolean;
  summary: ScanSummary;
  not_checked: { url: string; reason: string; viewport?: string }[];
  tool_versions: Record<string, string>;
  requested_by: Person;
  created_at: IsoDate;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  error: string | null;
  cancel_requested: boolean;
  statement: string;
  open_findings?: number;
  page_list?: { url: string; path: string; page_id: Uuid | null; requires_auth: boolean }[];
  progress?: ProgressRow[];
  defects?: { key: string; summary: string; status: string }[];
};
export type FindingNode = { target: string; html: string; summary: string };
export type Finding = {
  id: Uuid;
  key: string;
  scan_id: Uuid;
  scan_key: string;
  kind: CheckKind;
  rule_id: string;
  severity: A11ySeverity | SecSeverity;
  title: string;
  url: string;
  path: string;
  page_id: Uuid | null;
  viewport: string | null;
  nodes: FindingNode[];
  references: { type: string; criterion?: string; name?: string | null; level?: string | null; url?: string; source?: string }[];
  status: FindingStatus;
  status_reason: string | null;
  status_by: Person;
  seen_before: string | null;
  reopened: boolean;
  details: Record<string, unknown>;
  heuristic: boolean;
  needs_review: boolean;
  best_practice: boolean;
  /** The API sends {key, title, …} objects; older fixtures plain keys. Read with `mappedKeys`. */
  mapped: { features: MappedRef[]; requirements: MappedRef[]; test_cases: MappedRef[] };
  defect: { id: Uuid; key: string; status: string; summary: string } | null;
  evidence: { evidence_id: string; kind: string; outlined?: string[] }[];
  created_at: IsoDate;
};

export type PerfRunStatus = "awaiting_approval" | "rejected" | "expired" | "queued" | "running" | "passed" | "failed" | "stopped" | "aborted" | "error";
export type Limits3 = { vus: number; rps: number; duration_s: number };
export type Stage = { duration_s: number; target_vus: number };
export type Target = { path: string; weight: number; page_id?: string; title?: string; why?: string };
export type Threshold = {
  metric: "p95" | "p99" | "error_rate";
  scope: "path" | "all";
  path?: string;
  op: "<" | "<=";
  value: number;
  source: { type: "default" | "requirement"; key?: string; lineage_id?: string };
};
export type ThresholdResult = Threshold & { measured: number | null; result: "met" | "missed" | "not_measured" };
export type Profile = {
  id: Uuid;
  key: string;
  name: string;
  type: "load" | "stress" | "spike" | "soak";
  type_label: string;
  status: "draft" | "ready" | "stale" | "retired";
  stale_reason: string | null;
  version: number;
  versions: number[];
  generated_by: string;
  rationale: string | null;
  stages: Stage[];
  max_rps: number;
  think_time_ms: { min: number; max: number };
  targets: Target[];
  thresholds: Threshold[];
  totals: { vus: number; rps: number; duration_s: number; targets: number };
  violations: { field: string; message: string }[];
  request_preview: { summary: string; expected_requests_text: string; host: string; netloc: string; what_it_does: string[] };
  created_by: Person;
  created_at: IsoDate;
  updated_at: IsoDate;
  read_only?: boolean;
  limits?: { organisation: Limits3; server: Limits3; max_targets: number };
  permissions?: { can_edit: boolean; can_request: boolean; can_approve: boolean; can_admin_limits: boolean };
};
export type LatencyStats = { min?: number; mean?: number; p50?: number; p90?: number; p95?: number; p99?: number; max?: number };
export type TargetStats = { path?: string; count: number; ok?: number; errors?: number; error_rate?: number; rps?: number; latency_ms?: LatencyStats; status_codes?: Record<string, number> };
export type SeriesPoint = { t: number; users?: number; requests?: number; rps?: number; errors?: number; p95_ms?: number | null };
export type LoadRun = {
  id: Uuid;
  key: string;
  status: PerfRunStatus;
  status_label: string;
  profile: { id: Uuid; key: string; version: number; name: string; type: string };
  summary: string;
  expected_requests: number;
  expected_requests_text: string;
  limits: { test: Limits3; organisation: Limits3; server: Limits3 } | null;
  target_host: string;
  netloc: string;
  requested_by: Person;
  stopped_by: Person;
  note: string | null;
  created_at: IsoDate;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  elapsed_s: number | null;
  planned_s: number | null;
  engine: { name?: string; version?: string | null };
  aborted_reason: string | null;
  error: string | null;
  threshold_results: ThresholdResult[];
  live: SeriesPoint & { requests_total?: number; errors_total?: number } | null;
  stop_requested: boolean;
  problem: string | null;
  approval: {
    id: Uuid;
    key: string;
    status: string;
    expires_at: IsoDate | null;
    decided_by: Person;
    decided_at: IsoDate | null;
    comment: string | null;
    host_typed: boolean;
    confirm_prompt: string;
  } | null;
  permissions: { can_approve: boolean; can_stop: boolean; can_withdraw: boolean; can_request_again: boolean };
  statement: string;
  what_it_does: string[];
  profile_snapshot?: { targets: Target[]; stages: Stage[]; max_rps: number; think_time_ms: { min: number; max: number }; thresholds: Threshold[] };
  result?: { overall?: TargetStats; targets?: TargetStats[]; duration_s?: number; generator_location?: string };
  timeseries?: SeriesPoint[];
  /** P5-05c: retention removed the per-second series ("Removed by the retention policy on …"). */
  timeseries_removed?: string | null;
  previous?: { key: string; threshold_results: ThresholdResult[] } | null;
  /** `link`: this run drafted the defect, or added an occurrence to it (P5-BUG-06). */
  defects?: { key: string; summary: string; status: string; link?: "drafted" | "occurrence_added" }[];
};
export type Overview = {
  gates: { g2: boolean; g4: boolean };
  stages: Record<string, { status: string; stale_reason: string | null }>;
  accessibility: Scan | null;
  security: Scan | null;
  performance: { latest: LoadRun | null; waiting: string[]; running: string | null };
  pages: { public: number; signed_in: number };
  credentials_saved: boolean;
  limits: { organisation: Limits3; server: Limits3; max_targets: number };
  tools: { axe: string | null; loadgen: string | null; browser: boolean };
  statements: { security: string; accessibility: string; performance: string };
  permissions: { can_start: boolean; can_approve: boolean; can_admin_limits: boolean };
};

// ------------------------------------------------------------------ vocabulary (§3)

export const A11Y_SEVERITY: Record<A11ySeverity, { label: string; tone: Tone; solid?: boolean }> = {
  critical: { label: "Critical", tone: "red", solid: true },
  serious: { label: "Serious", tone: "red" },
  moderate: { label: "Moderate", tone: "amber" },
  minor: { label: "Minor", tone: "grey" },
};
export const SEC_SEVERITY: Record<SecSeverity, { label: string; tone: Tone }> = {
  high: { label: "High", tone: "red" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "grey" },
  info: { label: "For information", tone: "blue" },
};
export const CHECK_RESULT: Record<CheckResult, { label: string; tone: Tone }> = {
  failed: { label: "Failed", tone: "red" },
  passed: { label: "Passed", tone: "green" },
  not_applicable: { label: "Not applicable", tone: "grey" },
  not_checked: { label: "Not checked", tone: "grey" },
};
export const FINDING_STATUS: Record<FindingStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "amber" },
  accepted_risk: { label: "Accepted risk", tone: "grey" },
  false_positive: { label: "False positive", tone: "grey" },
  fixed: { label: "Not found again", tone: "green" },
};
export const SCAN_TONE: Record<ScanStatus, Tone> = { queued: "blue", running: "blue", completed: "green", partial: "amber", failed: "red", cancelled: "grey" };
export const RUN_TONE: Record<PerfRunStatus, Tone> = {
  awaiting_approval: "amber",
  rejected: "grey",
  expired: "grey",
  queued: "blue",
  running: "blue",
  passed: "green",
  failed: "red",
  stopped: "grey",
  aborted: "amber",
  error: "red",
};
export const THRESHOLD_RESULT = {
  met: { label: "Met", tone: "green" as Tone },
  missed: { label: "Missed", tone: "red" as Tone },
  not_measured: { label: "Not measured", tone: "grey" as Tone },
};
export const CATEGORY_LABEL: Record<SecurityRuleRow["category"], string> = { transport: "Transport", headers: "Headers", cookies: "Cookies", content: "Content" };
export const VIEWPORT_LABEL: Record<string, string> = { desktop: "Desktop 1440 × 900", mobile: "Phone 390 × 844" };
export const TYPE_TEMPLATES: { type: Profile["type"]; label: string }[] = [
  { type: "load", label: "Load (steady traffic)" },
  { type: "stress", label: "Stress (step up to your limit)" },
  { type: "spike", label: "Spike (sudden jump for 30 s)" },
  { type: "soak", label: "Short soak (longer, half the users)" },
];

export const isActiveScan = (s: Pick<Scan, "status"> | null | undefined) => !!s && (s.status === "queued" || s.status === "running");
export const isActiveRun = (r: Pick<LoadRun, "status"> | null | undefined) => !!r && (r.status === "queued" || r.status === "running");
export const isFinishedRun = (r: Pick<LoadRun, "status">) => !["awaiting_approval", "queued", "running"].includes(r.status);

// ------------------------------------------------------------------ numbers (§3.7)

/** 640 → "640 ms"; 1400 → "1.4 s". */
export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 0.004 → "0.4 %"; 0 → "0 %". */
export function pctText(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  if (rate === 0) return "0 %";
  return `${(rate * 100).toFixed(1)} %`;
}

/** 130 → "2 min 10 s"; 300 → "5 min"; 45 → "45 s". */
export function durationShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (!m) return `${s} s`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function countText(n: number): string {
  return n.toLocaleString("en-GB");
}

export function profileTotals(stages: Stage[], targets: number, maxRps: number): Limits3 & { targets: number } {
  return { vus: Math.max(0, ...stages.map((s) => s.target_vus)), rps: maxRps, duration_s: stages.reduce((n, s) => n + s.duration_s, 0), targets };
}

/** Field errors against the organisation ceiling and server cap (§9.2 inline limits). */
export function limitErrors(t: Limits3, org: Limits3, server: Limits3): Partial<Record<keyof Limits3, string>> {
  const out: Partial<Record<keyof Limits3, string>> = {};
  if (t.vus > server.vus) out.vus = `This server allows up to ${server.vus}.`;
  else if (t.vus > org.vus) out.vus = `Your organisation allows up to ${org.vus} virtual users.`;
  if (t.rps > server.rps) out.rps = `This server allows up to ${server.rps}.`;
  else if (t.rps > org.rps) out.rps = `Your organisation allows up to ${org.rps} requests a second.`;
  if (t.duration_s > server.duration_s) out.duration_s = `This server allows up to ${durationShort(server.duration_s)}.`;
  else if (t.duration_s > org.duration_s) out.duration_s = `Your organisation allows up to ${durationShort(org.duration_s)}.`;
  return out;
}

export function thresholdMeasure(t: Pick<Threshold, "metric">): string {
  if (t.metric === "error_rate") return "Errors";
  return `${t.metric.slice(1)} % of requests faster`;
}
export function thresholdScope(t: Pick<Threshold, "scope" | "path">): string {
  return t.scope === "path" ? (t.path ?? "") : "All requests";
}
export function thresholdLimit(t: Pick<Threshold, "metric" | "value">): string {
  return t.metric === "error_rate" ? `under ${pctText(t.value).replace(".0 %", " %")}` : `under ${msText(t.value)}`;
}
export function thresholdSource(t: Pick<Threshold, "source">): string {
  return t.source?.type === "requirement" && t.source.key ? `From ${t.source.key}` : "Default threshold (no requirement states one)";
}
export function measuredText(t: Pick<ThresholdResult, "metric" | "measured">): string {
  return t.metric === "error_rate" ? pctText(t.measured) : msText(t.measured);
}

/** "+120 ms" / "−40 ms" against the previous run of the same threshold, or "first run". */
export function deltaText(t: ThresholdResult, previous: LoadRun["previous"]): { text: string; sr: string } {
  if (!previous) return { text: "first run", sr: "first run" };
  const p = previous.threshold_results.find((x) => x.metric === t.metric && (x.path ?? null) === (t.path ?? null));
  if (!p || p.measured === null || t.measured === null) return { text: "—", sr: "no earlier value" };
  const d = t.measured - p.measured;
  if (t.metric === "error_rate") {
    const pts = Math.abs(d * 100).toFixed(1);
    return { text: `${d >= 0 ? "+" : "−"}${pts} %`, sr: `${pts} percentage points ${d >= 0 ? "more" : "fewer"} errors than ${previous.key}` };
  }
  const ms = Math.round(Math.abs(d));
  return { text: `${d >= 0 ? "+" : "−"}${ms} ms`, sr: `${ms} milliseconds ${d >= 0 ? "slower" : "faster"} than ${previous.key}` };
}

/** Status label of a load test (§3.4), with the missed count and who stopped it. */
export function runStatusLabel(r: Pick<LoadRun, "status" | "threshold_results" | "stopped_by" | "status_label">): string {
  const missed = r.threshold_results.filter((t) => t.result === "missed").length;
  if (r.status === "failed") return `Finished · ${missed} of ${r.threshold_results.length} thresholds missed`;
  if (r.status === "stopped") return `Stopped by ${r.stopped_by?.full_name ?? "someone"}`;
  return r.status_label;
}

/** The plain-language result paragraph (§9.6). */
export function resultParagraph(r: Pick<LoadRun, "threshold_results" | "profile_snapshot" | "limits">): string {
  const users = r.limits?.test.vus ?? 0;
  const pages = r.threshold_results.filter((t) => t.scope === "path");
  const missed = pages.filter((t) => t.result === "missed");
  const lead = `With up to ${users} virtual user${users === 1 ? "" : "s"}, ${pages.length - missed.length} of ${pages.length} page${pages.length === 1 ? "" : "s"} stayed within their thresholds.`;
  if (!missed.length) {
    const err = r.threshold_results.find((t) => t.metric === "error_rate");
    return err?.result === "missed" ? `${lead} Too many requests failed: ${pctText(err.measured)} errors, and the threshold is ${pctText(err.value)}.` : lead;
  }
  const titles = new Map((r.profile_snapshot?.targets ?? []).map((t) => [t.path, (t.title ?? "").split("·")[0].trim()]));
  const worst = missed[0];
  const name = titles.get(worst.path ?? "") ? `The ${titles.get(worst.path ?? "")} page (${worst.path})` : `${worst.path}`;
  return `${lead} ${name} was slow: ${worst.metric.slice(1)} % of its requests were faster than ${msText(worst.measured)}, and the threshold is ${msText(worst.value)}.`;
}

/** "2 rules failed on 2 of 6 pages · 1 critical · 1 serious · 0 moderate · 0 minor · 3 need review" (§7.4). */
export function a11ySummaryLine(s: Scan): string {
  const sm = s.summary;
  const total = (sm.pages_checked ?? 0) + (sm.pages_not_checked ?? 0) || s.pages;
  const sev = sm.by_severity ?? {};
  const parts = [
    `${sm.rules_failed ?? 0} rule${sm.rules_failed === 1 ? "" : "s"} failed on ${sm.pages_with_problems ?? 0} of ${total} page${total === 1 ? "" : "s"}`,
    ...(["critical", "serious", "moderate", "minor"] as A11ySeverity[]).map((k) => `${sev[k] ?? 0} ${k}`),
  ];
  if (sm.needs_review) parts.push(`${sm.needs_review} need${sm.needs_review === 1 ? "s" : ""} review`);
  return parts.join(" · ");
}

export function secCountsLine(s: Scan): string {
  const c = s.summary.counts ?? {};
  return `${c.failed ?? 0} failed · ${c.passed ?? 0} passed · ${c.not_applicable ?? 0} not applicable · ${c.not_checked ?? 0} not checked`;
}

/** Default tab (§4.1): something waiting or running, else the most recently run, else performance. */
export function defaultTab(o: Pick<Overview, "accessibility" | "security" | "performance">): "performance" | "accessibility" | "security" {
  if (o.performance.waiting.length || o.performance.running) return "performance";
  if (isActiveScan(o.accessibility)) return "accessibility";
  if (isActiveScan(o.security)) return "security";
  const dated: [string, "performance" | "accessibility" | "security"][] = [];
  if (o.performance.latest) dated.push([o.performance.latest.created_at, "performance"]);
  if (o.accessibility) dated.push([o.accessibility.created_at, "accessibility"]);
  if (o.security) dated.push([o.security.created_at, "security"]);
  dated.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  return dated[0]?.[1] ?? "performance";
}

/** Grouped by rule for "By rule" (§7.4): violations first by severity, needs-review separately. */
export type RuleGroup = { rule_id: string; title: string; severity: string; findings: Finding[]; pages: string[]; elements: number; wcag: string; status: FindingStatus; heuristic: boolean };
const SEV_ORDER: Record<string, number> = { critical: 0, high: 0, serious: 1, medium: 1, moderate: 2, low: 2, minor: 3, info: 4 };
export function groupByRule(findings: Finding[]): RuleGroup[] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) map.set(f.rule_id, [...(map.get(f.rule_id) ?? []), f]);
  return [...map.entries()]
    .map(([rule_id, fs]) => {
      const wcag = fs[0].references.filter((r) => r.type === "wcag").map((r) => `${r.criterion}${r.level ? ` (${r.level})` : ""}`);
      const open = fs.some((f) => f.status === "open");
      return {
        rule_id,
        title: fs[0].title,
        severity: fs[0].severity,
        findings: fs,
        pages: [...new Set(fs.map((f) => f.path))],
        elements: fs.reduce((n, f) => n + f.nodes.length, 0),
        wcag: [...new Set(wcag)].join(", "),
        status: open ? ("open" as FindingStatus) : fs[0].status,
        heuristic: fs[0].heuristic,
      };
    })
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || a.rule_id.localeCompare(b.rule_id));
}

/** Screenshot alt text (§7.5): page, size and the outlined elements. */
export function screenshotAlt(f: Pick<Finding, "path" | "viewport" | "nodes">): string {
  const n = f.nodes.length;
  const size = f.viewport === "mobile" ? "phone" : "desktop";
  const els = f.nodes
    .slice(0, 5)
    .map((x, i) => `element ${i + 1}, ${x.target}`)
    .join("; ");
  return `Screenshot of ${f.path} at ${size} size with ${n} element${n === 1 ? "" : "s"} outlined: ${els}.`;
}

/** Overall live progress: "1 min 05 s of 2 min 10 s". */
export function liveProgress(elapsed: number | null, planned: number | null): string {
  return `${durationShort(elapsed ?? 0)} of ${durationShort(planned ?? 0)}`;
}

/** Milestones for the polite region (25/50/75 %), never per tick. */
export function liveMilestone(prevPct: number, pct: number): number | null {
  for (const m of [25, 50, 75]) if (prevPct < m && pct >= m) return m;
  return null;
}

/** Sidebar badge counts (§4.2), from GET /projects/{id}/non-functional. */
export type NonFunctionalCounts = { waiting: number; canApprove: boolean; running: boolean; stale: boolean };
export function nfCounts(o: Overview | undefined): NonFunctionalCounts | undefined {
  if (!o) return undefined;
  const st = (k: string) => o.stages[k]?.status;
  return {
    waiting: o.performance.waiting.length,
    canApprove: o.permissions.can_approve,
    running: !!o.performance.running || isActiveScan(o.accessibility) || isActiveScan(o.security),
    stale: st("accessibility") === "stale" || st("security_assessment") === "stale",
  };
}

export type MappedRef = string | { key: string; title?: string; name?: string };
/** Keys of a finding's mapped requirements, test cases or features. */
export function mappedKeys(items: MappedRef[] | undefined): string[] {
  return (items ?? []).map((x) => (typeof x === "string" ? x : x.key));
}

// ------------------------------------------------------------------ Overview, lifecycle and header (§4.3–4.5)

const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

/** Overview "Needs your attention" rows (§4.5), in priority order. Viewers get text only (no href). */
export function nfAttentionRows(o: Overview | undefined, projectId: string, canApprove: boolean, viewer: boolean, now = Date.now()): { text: string; action: string; href: string | null }[] {
  if (!o) return [];
  const base = `/projects/${projectId}/non-functional`;
  const rows: { text: string; action: string; href: string | null }[] = [];
  const open = (key: string, path: string) => ({ action: viewer ? "" : `Open ${key}`, href: viewer ? null : `${base}/${path}/${key}` });
  for (const key of o.performance.waiting.slice(0, 2))
    rows.push(
      canApprove
        ? { text: `${key} is waiting for your approval.`, action: `Review ${key}`, href: `${base}/load-tests/${key}` }
        : { text: `${key} is waiting for approval by someone who can approve.`, ...open(key, "load-tests") },
    );
  const r = o.performance.latest;
  if (r?.finished_at && now - Date.parse(r.finished_at) < 7 * 24 * 3600 * 1000) {
    const missed = r.threshold_results.filter((t) => t.result === "missed");
    if (r.status === "aborted") {
      const why = (r.aborted_reason ?? "").replace(/^Stopped automatically:?\s*/i, "").replace(/\.$/, "") || "the site looked overwhelmed";
      rows.push({ text: `${r.key} was stopped automatically: ${why}.`, ...open(r.key, "load-tests") });
    }
    else if (r.status === "failed" && missed.length) {
      const page = missed.find((t) => t.scope === "path")?.path;
      rows.push({ text: `${r.key} missed ${missed.length} threshold${missed.length === 1 ? "" : "s"}${page ? `: ${page} was slow under load` : ""}.`, ...open(r.key, "load-tests") });
    }
  }
  const a = o.accessibility;
  const severe = (a?.summary.by_severity?.critical ?? 0) + (a?.summary.by_severity?.serious ?? 0);
  if (a && !isActiveScan(a) && severe) rows.push({ text: `${a.key} found ${severe} critical or serious accessibility problem${severe === 1 ? "" : "s"}.`, ...open(a.key, "checks") });
  const st = (k: string) => o.stages[k]?.status;
  if (st("accessibility") === "stale" || st("security_assessment") === "stale")
    rows.push({ text: "Accessibility and security checks are out of date: pages changed after them.", action: viewer ? "" : "Open Non-functional", href: viewer ? null : base });
  return rows;
}

/** Overview "Non-functional" card lines (§4.5): text only, never a score, grade or percentage. */
export function nfGlanceLines(o: Overview): { label: string; text: string; key: string | null }[] {
  const a = o.accessibility;
  const s = o.security;
  const r = o.performance.latest;
  const sev = a?.summary.by_severity ?? {};
  const sevText = (["critical", "serious"] as A11ySeverity[]).filter((k) => sev[k]).map((k) => `${sev[k]} ${k}`).join(", ");
  const done = (x: Scan | null) => !!x && !isActiveScan(x) && x.status !== "failed";
  const a11yText = !a
    ? "Not checked yet."
    : !done(a)
      ? `${a.key} · ${a.status_label}`
      : `${a.key} · ${shortDate(a.finished_at)} · ${a.summary.rules_failed ?? 0} rule${a.summary.rules_failed === 1 ? "" : "s"} on ${a.summary.pages_with_problems ?? 0} of ${a.pages} page${a.pages === 1 ? "" : "s"}${sevText ? ` (${sevText})` : ""}`;
  const secText = !s
    ? "Not checked yet."
    : !done(s)
      ? `${s.key} · ${s.status_label}`
      : `${s.key} · ${shortDate(s.finished_at)} · ${s.open_findings ?? 0} finding${s.open_findings === 1 ? "" : "s"} · passive check, not a security audit`;
  const missed = r ? r.threshold_results.filter((t) => t.result === "missed").length : 0;
  const perfText = !r
    ? "Not checked yet."
    : r.status === "passed" || r.status === "failed"
      ? `${r.key} · ${shortDate(r.finished_at)} · ${missed} of ${r.threshold_results.length} thresholds missed`
      : `${r.key} · ${runStatusLabel(r)}`;
  return [
    { label: "Accessibility", text: a11yText, key: a?.key ?? null },
    { label: "Security", text: secText, key: s?.key ?? null },
    { label: "Performance", text: perfText, key: r?.key ?? null },
  ];
}

/** Lifecycle optional rows (§4.3). Before G2 they read "Available after Gate 2"; never "Running" without a check. */
export function nfLifecycleRows(o: Overview | undefined, g2: boolean, canApprove: boolean): { id: "accessibility" | "security" | "performance"; label: string; agent: string; status: string }[] {
  const scanText = (x: Scan | null | undefined, stage: string) => {
    if (!x) return "Not run yet";
    if (isActiveScan(x)) return "Checking…";
    if (o?.stages[stage]?.status === "stale") return "Out of date: pages changed after this check";
    if (x.status === "failed") return "Didn't complete";
    if (x.status === "partial") return "Partial";
    return `Done: ${x.open_findings ?? 0} open finding${x.open_findings === 1 ? "" : "s"}`;
  };
  const perfText = () => {
    const waiting = o?.performance.waiting[0];
    if (waiting) return `${waiting} waiting ${canApprove ? "for your approval" : "for approval by someone who can approve"}`;
    if (o?.performance.running) return "Running";
    const r = o?.performance.latest;
    if (!r) return "Not run yet";
    if (r.status === "stopped" || r.status === "aborted") return "Stopped";
    const missed = r.threshold_results.filter((t) => t.result === "missed").length;
    return missed ? `Done: ${missed} threshold${missed === 1 ? "" : "s"} missed` : "Done: all thresholds met";
  };
  const before = "Available after Gate 2";
  return [
    { id: "accessibility", label: "Accessibility", agent: "Accessibility checks (axe-core + keyboard pass, no AI)", status: g2 ? scanText(o?.accessibility, "accessibility") : before },
    { id: "security", label: "Security (passive)", agent: "Security rule table (no AI)", status: g2 ? scanText(o?.security, "security_assessment") : before },
    { id: "performance", label: "Performance", agent: "Performance Testing Agent; built-in load generator", status: g2 ? perfText() : before },
  ];
}

/** Header status pill (§4.4): load test running, waiting, or a check running; null when none applies. */
export function nfHeaderPill(o: Overview | undefined, canApprove: boolean): { text: string; tone: "blue" | "amber" } | null {
  if (!o) return null;
  if (o.performance.running) return { text: `Load test ${o.performance.running} running`, tone: "blue" };
  const w = o.performance.waiting[0];
  if (w) return { text: `${w} waiting ${canApprove ? "for your approval" : "for approval by someone who can approve"}`, tone: "amber" };
  if (isActiveScan(o.accessibility)) return { text: "Accessibility check running", tone: "blue" };
  if (isActiveScan(o.security)) return { text: "Security check running", tone: "blue" };
  return null;
}

/** The optional checks are reachable once discovery ran and the accessibility stage is available (G2 approved). */
export function nfReachable(wf: { stages: { key: string; available?: boolean; current_version?: number | null }[] } | null | undefined): boolean {
  return !!wf?.stages.find((x) => x.key === "accessibility")?.available && !!wf?.stages.find((x) => x.key === "discovery")?.current_version;
}

/** Settings › Organisation server-status rows (design P5 §13.2). Text only; `warn` marks the amber proxy row. */
export function serverToolRows(h: Health): { label: string; value: string; warn?: boolean }[] {
  const t = h.tools;
  const rows: { label: string; value: string; warn?: boolean }[] = [];
  if (h.egress_proxy)
    rows.push(
      h.egress_proxy === "on"
        ? { label: "Network safety proxy", value: "On · every connection the platform's browsers make is checked against your approved sites" }
        : { label: "Network safety proxy", value: "Off (development only): DNS tricks could reach internal services.", warn: true },
    );
  if (t) {
    rows.push({ label: "Accessibility checker", value: t.axe ? `axe-core ${t.axe}` : "Not installed" });
    rows.push({ label: "Load generator", value: t.loadgen ? `built-in ${t.loadgen}` : "Not installed" });
    rows.push({ label: "k6", value: t.k6 ? `${t.k6} · Not needed: the platform exports k6 scripts but doesn't run them` : "Not installed · Not needed: the platform exports k6 scripts but doesn't run them" });
    rows.push({ label: "Docker", value: t.docker ? `${t.docker} · Not used in this version` : "Not installed · Not used in this version" });
  }
  return rows;
}
