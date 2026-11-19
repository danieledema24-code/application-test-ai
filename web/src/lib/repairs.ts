// Repair suggestions (P6-04, decision D31; design P6 §3.5, §8). Up to three verified replacements for a broken
// locator, ranked by rules (the AI may only reorder them). A person accepts one, one suggestion at a time; nothing is
// applied automatically, and expected results are never changed: those get a review for a person instead.

import type { EvidenceLink, GeneratedBy, IsoDate, UserRef, Uuid } from "./contract";
import { fmtDate, plural } from "./format";

export type RepairLevel = "high" | "medium" | "low";
export type RepairStatus = "open" | "accepted" | "rejected" | "superseded";
export type RepairSource = "change" | "failure";
export type RepairKind = "locator" | "expected_result_review";

export type RepairCandidate = {
  index: number;
  expression: string;
  strategy: string;
  score: number;
  level: RepairLevel;
  signals: { code: string; text: string }[];
  match_count: number;
  offered: boolean;
  not_offered_reason: string | null;
  rule_rank: number;
  element: { role?: string; name?: string } | null;
  checked_at: IsoDate | null;
  evidence: EvidenceLink | null;
};

export type RepairScript = {
  case_key: string | null;
  test_case_id: Uuid | null;
  case_title: string | null;
  script_id: Uuid | null;
  path: string | null;
  state: string;
  first_error: string | null;
  outdated_reason: string | null;
};

/** `reason` "page_removed": a link to a page the change set removed (no repair can be right; QA P6-04). */
export type RepairReview = { page: string | null; before: string; after: string | null; helper: string; case_key: string; source_key: string; message: string; reason?: "text" | "page_removed" };

export type Repair = {
  id: Uuid;
  key: string;
  kind: RepairKind;
  source: RepairSource;
  status: RepairStatus;
  file: string | null;
  file_name: string | null;
  getter: string | null;
  element: string | null;
  page: string | null;
  old_expression: string | null;
  candidates: RepairCandidate[];
  offered: number;
  no_candidate_reason: string | null;
  checked_at: IsoDate | null;
  change_set: { id: Uuid; key: string } | null;
  execution_result: { id: Uuid; key: string; run_key: string | null; run_id: Uuid | null } | null;
  used_by: RepairScript[];
  review: RepairReview | null;
  asset_version: number | null;
  new_asset_version: number | null;
  accepted_index: number | null;
  decided_by: UserRef | null;
  decided_at: IsoDate | null;
  reason: string | null;
  generated_by: GeneratedBy;
  order: "ai" | "rules";
  explanation: string | null;
  rule_order: string[];
  checking: { state: "checking" | "valid" | "invalid" | "outdated"; scripts: RepairScript[] } | null;
  created_at: IsoDate | null;
  can_accept: boolean;
  can_reject: boolean;
};

export type RepairCounts = { open: number; open_locator: number; accepted: number; rejected: number; superseded: number; total: number };
export type RepairList = { items: Repair[]; counts: RepairCounts; permissions: { can_decide: boolean } };
export type AcceptRepairResponse = {
  message: string;
  asset: { id: Uuid; path: string; version: number };
  scripts_to_validate: string[];
  checking: boolean;
  replaced: string[];
  suggestion: Repair;
};

/** design P6 §3.8 */
export const REPAIR_LINE = "Only this locator changes; the test's checks stay the same.";
export const REPAIRS_EMPTY = "No repair suggestions. When a rescan or a failed test breaks a locator, suggestions appear here.";
export const OFFLINE_LINE = "You're offline. Reconnect to accept or reject.";

export const LEVEL_LABEL: Record<RepairLevel, string> = { high: "High match", medium: "Medium match", low: "Low match" };
export const STATUS_LABEL: Record<RepairStatus, string> = { open: "Open", accepted: "Accepted", rejected: "Rejected", superseded: "Replaced" };

export type StatusFilter = RepairStatus | "all";
export type SourceFilter = RepairSource | "";
export const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "superseded", label: "Replaced" },
  { value: "all", label: "All" },
];
export const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "", label: "Any" },
  { value: "change", label: "From a change" },
  { value: "failure", label: "From a failed test" },
];

export function statusLabel(r: Pick<Repair, "kind" | "status">): string {
  return r.kind === "expected_result_review" && r.status === "open" ? "Needs a person" : STATUS_LABEL[r.status];
}

/** "From CHG-0001 (before any test failed)" · "From a failed test (RUN-0003-07)" */
export function sourceLine(r: Pick<Repair, "source" | "change_set" | "execution_result">): string {
  if (r.source === "change") return r.change_set ? `From ${r.change_set.key} (before any test failed)` : "From a change (before any test failed)";
  return r.execution_result ? `From a failed test (${r.execution_result.key})` : "From a failed test";
}

/** "HEAL-0001 · ContactPage.ts · the Message field" */
export function cardTitle(r: Pick<Repair, "key" | "kind" | "file_name" | "element" | "review">): string {
  if (r.kind === "expected_result_review") return `${r.key} · ${reviewTitle(r.review)}${r.review ? ` · ${r.review.case_key}` : ""}`;
  return [r.key, r.file_name, r.element].filter(Boolean).join(" · ");
}

/** "Expected result may be out of date", or "Test case needs review" for a link to a removed page. */
export function reviewTitle(rv: Pick<RepairReview, "reason"> | null | undefined): string {
  return rv?.reason === "page_removed" ? "Test case needs review" : "Expected result may be out of date";
}

/** "High match (0.93)" */
export function levelText(c: Pick<RepairCandidate, "level" | "score">): string {
  return `${LEVEL_LABEL[c.level]} (${c.score.toFixed(2)})`;
}

const ROLE_WORDS: Record<string, string> = { textbox: "text box", button: "button", link: "link", checkbox: "checkbox", combobox: "drop-down", radio: "radio button", heading: "heading" };

/** "text box 'Your message'" */
export function elementText(e: RepairCandidate["element"]): string {
  if (!e) return "the element";
  const role = e.role ? (ROLE_WORDS[e.role] ?? e.role) : "element";
  return e.name ? `${role} '${e.name}'` : role;
}

/** Screenshot text alternative (design P6 §8.2). */
export function screenshotAlt(c: RepairCandidate, page: string | null): string {
  const when = c.checked_at ?? c.evidence?.captured_at;
  return `Screenshot of ${page ?? "the page"}${when ? ` on ${shortDate(when)}` : ""} with the matched element outlined: ${elementText(c.element)}.`;
}

/** "15 Nov" */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fmtDate(iso) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "✓ Found exactly 1 visible element on /contact (checked 15 Nov 10:20)" — the tick is drawn as an icon. */
export function verifiedLine(c: RepairCandidate, page: string | null, fmt: (iso: string) => string): string {
  return `Found exactly 1 visible element on ${page ?? "the page"}${c.checked_at ? ` (checked ${fmt(c.checked_at)})` : ""}`;
}

/** "More than one element matches; not offered" with its count. */
export function notOfferedText(c: RepairCandidate): string {
  const reason = c.not_offered_reason ?? "Not offered";
  return c.match_count > 1 ? `${reason} (${c.match_count} matches)` : reason;
}

/** Offered candidates in the shown order: High and Medium in the list, Low under "Other possibilities". */
export function splitCandidates(r: Pick<Repair, "candidates">): { main: RepairCandidate[]; other: RepairCandidate[]; notOffered: RepairCandidate[] } {
  const offered = r.candidates.filter((c) => c.offered);
  return {
    main: offered.filter((c) => c.level !== "low"),
    other: offered.filter((c) => c.level === "low"),
    notOffered: r.candidates.filter((c) => !c.offered),
  };
}

/** The candidate preselected on an open card: the first offered one. */
export function firstChoice(r: Pick<Repair, "candidates">): number | null {
  const { main, other } = splitCandidates(r);
  return (main[0] ?? other[0])?.index ?? null;
}

/** The accept confirmation (design P6 §8.3). */
export function acceptText(r: Repair, c: RepairCandidate): string {
  const file = r.file_name ?? "the page object";
  const n = r.used_by.length;
  const next = (r.asset_version ?? 0) + 1;
  const who = n ? `the ${plural(n, "script")} that use${n === 1 ? "s" : ""} it ${n === 1 ? "is" : "are"} checked again (Gate 6) before ${n === 1 ? "it" : "they"} can run` : "its scripts are checked again (Gate 6) before they can run";
  return `Use ${c.expression} in ${file}? ${REPAIR_LINE} ${file} version ${next} is created, and ${who}.`;
}

export function acceptName(r: Pick<Repair, "old_expression" | "key">): string {
  return `Accept this replacement for ${r.old_expression ?? r.key}`;
}

/** "HEAL-0001 · Accepted by M. Member · 15 Nov 10:31 · ContactPage.ts version 3" */
export function acceptedLine(r: Repair, fmt: (iso: string) => string): string {
  const who = r.decided_by?.full_name || r.decided_by?.email || "someone";
  const bits = [`Accepted by ${who}`];
  if (r.decided_at) bits.push(fmt(r.decided_at));
  if (r.file_name && r.new_asset_version) bits.push(`${r.file_name} version ${r.new_asset_version}`);
  return bits.join(" · ");
}

export function rejectedLine(r: Repair): string {
  const who = r.decided_by?.full_name || r.decided_by?.email || "someone";
  return `Rejected by ${who}: '${r.reason ?? ""}'. Fix the test case or regenerate the scripts.`;
}

export function replacedLine(r: Pick<Repair, "reason">): string {
  const why = r.reason ?? "Another suggestion for this locator was accepted";
  return `Replaced: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

/** The check result after an accept: "Checking 3 scripts…", "3 scripts valid again. …", "TC-0020 still fails …". */
export function checkingLine(r: Repair): { tone: "busy" | "ok" | "bad"; text: string } | null {
  const c = r.checking;
  if (!c) return null;
  const n = c.scripts.length;
  if (c.state === "checking") return { tone: "busy", text: `Checking ${plural(n, "script")}…` };
  if (c.state === "valid") return { tone: "ok", text: `${plural(n, "script")} valid again. The impact item is closed.` };
  const bad = c.scripts.find((x) => x.state === "invalid" || x.state === "outdated");
  if (bad && c.state === "invalid") return { tone: "bad", text: `${bad.case_key ?? bad.path ?? "A script"} still fails its checks: ${bad.first_error ?? "see Automation"}.` };
  return { tone: "bad", text: `${bad?.case_key ?? "A script"} is still outdated: ${bad?.outdated_reason ?? "another locator is broken"}.` };
}

/** Cards grouped by page object file (design P6 §8.1); reviews sit under their test case. */
export function groupByFile(items: Repair[]): { file: string; items: Repair[] }[] {
  const out = new Map<string, Repair[]>();
  for (const r of items) {
    const k = r.kind === "expected_result_review" ? "Expected results to review" : (r.file_name ?? "Other");
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return [...out.entries()].map(([file, xs]) => ({ file, items: xs }));
}

export function tabLabel(open: number | undefined): string {
  return open === undefined ? "Repairs" : `Repairs (${open})`;
}

export function acceptError(r: Pick<Repair, "key">, reason: string, status?: number): string {
  // A 409 already says who decided it (design P6 §8.3).
  return status === 409 ? reason : `Couldn't accept ${r.key}: ${reason.replace(/\.$/, "")}. Nothing was changed.`;
}
