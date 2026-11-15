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
};

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
