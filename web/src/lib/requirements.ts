// Requirements workspace logic (design P2 §5, §6): URL-synced filters, confidence bands, bulk-approve
// guard and the Gate 3 checks. Pure functions, unit-tested in tests/unit/requirements.spec.ts.
// Every number shown at a gate is computed here from the requirement set, never by the agent.

import type {
  Classification,
  ReadinessCriteria,
  RequirementCategory,
  RequirementStatus,
  RequirementSummary,
} from "./contract";

export const LABEL_TEXT: Record<Classification, string> = { observed: "Observed", inferred: "Inferred", assumed: "Assumed", unverified: "Unverified" };

export const STATUS_TEXT: Record<RequirementStatus, string> = { draft: "Draft", approved: "Approved", rejected: "Rejected", needs_info: "Needs info" };

export const CATEGORY_TEXT: Record<RequirementCategory, string> = {
  navigation: "Navigation",
  content: "Content",
  form_input: "Form input",
  validation: "Validation",
  authentication: "Authentication",
  session: "Session",
  search: "Search",
  commerce: "Commerce",
  account: "Account",
  data_processing: "Data processing",
  notification: "Notification",
  integration: "Integration",
  accessibility: "Accessibility",
  usability: "Usability",
  compatibility: "Compatibility",
  performance: "Performance",
  security: "Security",
  privacy: "Privacy",
  other: "Other",
};

export const SOURCE_TEXT: Record<string, string> = { discovery: "Discovery", document: "Document", user: "User", assistant: "AI QA Analyst" };

export type ConfidenceBand = "high" | "medium" | "low";

/** High ≥ 80 %, Medium 50–79 %, Low < 50 % (design P2 §5.4). Accepts 0–1 (API) values. */
export function confidenceBand(confidence: number): ConfidenceBand {
  const pct = Math.round(confidence * 100);
  if (pct >= 80) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

export const BAND_TEXT: Record<ConfidenceBand, string> = { high: "High", medium: "Medium", low: "Low" };

/** "68% · Medium" */
export function confidenceText(confidence: number): string {
  return `${Math.round(confidence * 100)}% · ${BAND_TEXT[confidenceBand(confidence)]}`;
}

// ---- Filters ---------------------------------------------------------------

/** Label filter: one label, or "weak" for Assumed or Unverified together (the Gate 3 tile and check). */
export type LabelFilter = Classification | "weak";

export const LABEL_FILTER_TEXT: Record<LabelFilter, string> = { ...LABEL_TEXT, weak: "Assumed or Unverified" } as Record<LabelFilter, string>;

export function isWeakLabel(r: { classification: Classification }): boolean {
  return r.classification === "assumed" || r.classification === "unverified";
}

/**
 * The single meaning of "without acceptance criteria" in the web app: no criterion that isn't rejected
 * (`ac_count`, which already leaves rejected ones out, is 0). Drafts count as criteria (BUG-P2-10).
 */
export function hasNoCriteria(r: { ac_count: number }): boolean {
  return r.ac_count === 0;
}

export type ReqFilters = {
  q: string;
  status: RequirementStatus | "";
  label: LabelFilter | "";
  category: RequirementCategory | "";
  source: string;
  conf: ConfidenceBand | "";
  feature: string;
  locked: boolean;
  edited: boolean;
  noAc: boolean;
  conflict: boolean;
  changed: boolean;
  /** Rejected requirements are hidden unless the status filter asks for them or this is set. */
  showRejected: boolean;
  sort: "id" | "title" | "confidence" | "status" | "changed";
};

export const EMPTY_FILTERS: ReqFilters = {
  q: "",
  status: "",
  label: "",
  category: "",
  source: "",
  conf: "",
  feature: "",
  locked: false,
  edited: false,
  noAc: false,
  conflict: false,
  changed: false,
  showRejected: false,
  sort: "id",
};

const FLAG_PARAMS = { locked: "locked", edited: "edited", noAc: "no_ac", conflict: "conflict", changed: "changed", showRejected: "show_rejected" } as const;

type Params = { get(name: string): string | null };

function oneOf<T extends string>(v: string | null, allowed: readonly T[]): T | "" {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : "";
}

export function parseFilters(params: Params): ReqFilters {
  const f: ReqFilters = { ...EMPTY_FILTERS };
  f.q = params.get("q") ?? "";
  f.status = oneOf(params.get("status"), ["draft", "approved", "rejected", "needs_info"] as const);
  f.label = oneOf(params.get("label"), ["observed", "inferred", "assumed", "unverified", "weak"] as const);
  f.category = oneOf(params.get("category"), Object.keys(CATEGORY_TEXT) as RequirementCategory[]);
  f.source = params.get("source") ?? "";
  f.conf = oneOf(params.get("conf"), ["high", "medium", "low"] as const);
  f.feature = params.get("feature") ?? "";
  for (const [k, p] of Object.entries(FLAG_PARAMS)) (f as Record<string, unknown>)[k] = params.get(p) === "1";
  f.sort = oneOf(params.get("sort"), ["id", "title", "confidence", "status", "changed"] as const) || "id";
  return f;
}

/** Query params for a filter set (only non-default values), so links and Back restore it. */
export function filtersToQuery(f: ReqFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.q) q.q = f.q;
  if (f.status) q.status = f.status;
  if (f.label) q.label = f.label;
  if (f.category) q.category = f.category;
  if (f.source) q.source = f.source;
  if (f.conf) q.conf = f.conf;
  if (f.feature) q.feature = f.feature;
  for (const [k, p] of Object.entries(FLAG_PARAMS)) if ((f as Record<string, unknown>)[k]) q[p] = "1";
  if (f.sort !== "id") q.sort = f.sort;
  return q;
}

/** Removable chips for the active filters: "Status: Draft". */
export function activeFilterChips(f: ReqFilters): { key: keyof ReqFilters; label: string }[] {
  const out: { key: keyof ReqFilters; label: string }[] = [];
  if (f.q) out.push({ key: "q", label: `Search: ${f.q}` });
  if (f.status) out.push({ key: "status", label: `Status: ${STATUS_TEXT[f.status]}` });
  if (f.label) out.push({ key: "label", label: `Label: ${LABEL_FILTER_TEXT[f.label]}` });
  if (f.category) out.push({ key: "category", label: `Category: ${CATEGORY_TEXT[f.category]}` });
  if (f.source) out.push({ key: "source", label: `Source: ${sourceFilterLabel(f.source)}` });
  if (f.conf) out.push({ key: "conf", label: `Confidence: ${BAND_TEXT[f.conf]}` });
  if (f.feature) out.push({ key: "feature", label: `Feature: ${f.feature}` });
  if (f.locked) out.push({ key: "locked", label: "Locked" });
  if (f.edited) out.push({ key: "edited", label: "Edited by people" });
  if (f.noAc) out.push({ key: "noAc", label: "No acceptance criteria" });
  if (f.conflict) out.push({ key: "conflict", label: "Document conflicts" });
  if (f.changed) out.push({ key: "changed", label: "Changed in latest generation" });
  return out;
}

export function sourceFilterLabel(source: string): string {
  if (source.startsWith("doc:")) return `Document ${source.slice(4)}`;
  return SOURCE_TEXT[source] ?? source;
}

export function clearFilter(f: ReqFilters, key: keyof ReqFilters): ReqFilters {
  return { ...f, [key]: EMPTY_FILTERS[key] };
}

/** Does the requirement match the filters? Rejected rows are hidden unless asked for (design §5.2). */
export function matchesFilters(r: RequirementSummary, f: ReqFilters): boolean {
  if (r.status === "rejected" && f.status !== "rejected" && !f.showRejected) return false;
  if (f.status && r.status !== f.status) return false;
  if (f.label && (f.label === "weak" ? !isWeakLabel(r) : r.classification !== f.label)) return false;
  if (f.category && r.category !== f.category) return false;
  if (f.source && !(f.source === r.source || (f.source === "document" && r.source === "document"))) return false;
  if (f.conf && confidenceBand(r.confidence) !== f.conf) return false;
  if (f.feature && !(r.related_feature_names ?? []).some((n) => n.toLowerCase() === f.feature.toLowerCase())) return false;
  if (f.locked && !r.locked) return false;
  if (f.edited && !r.human_edited) return false;
  if (f.noAc && !hasNoCriteria(r)) return false;
  if (f.conflict && !r.conflict) return false;
  if (f.changed && !r.changed_in_latest) return false;
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    if (q && !r.key.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q)) return false;
  }
  return true;
}

const STATUS_ORDER: Record<RequirementStatus, number> = { needs_info: 0, draft: 1, approved: 2, rejected: 3 };

export function sortRequirements(rows: RequirementSummary[], sort: ReqFilters["sort"]): RequirementSummary[] {
  const out = [...rows];
  const byKey = (a: RequirementSummary, b: RequirementSummary) => a.key.localeCompare(b.key, undefined, { numeric: true });
  out.sort((a, b) => {
    switch (sort) {
      case "title":
        return a.title.localeCompare(b.title) || byKey(a, b);
      case "confidence":
        return a.confidence - b.confidence || byKey(a, b);
      case "status":
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byKey(a, b);
      case "changed":
        return b.updated_at.localeCompare(a.updated_at) || byKey(a, b);
      default:
        return byKey(a, b);
    }
  });
  return out;
}

export function filterRequirements(all: RequirementSummary[], f: ReqFilters): { rows: RequirementSummary[]; hiddenRejected: number } {
  const rows = sortRequirements(
    all.filter((r) => matchesFilters(r, f)),
    f.sort,
  );
  const hiddenRejected = f.status === "rejected" || f.showRejected ? 0 : all.filter((r) => r.status === "rejected" && matchesFilters(r, { ...f, showRejected: true })).length;
  return { rows, hiddenRejected };
}

// ---- Bulk approve guard (design §5.2) --------------------------------------

/** Items that need a second look before bulk approval: Assumed/Unverified, low confidence or no AC. */
export function approvalFlags(rows: RequirementSummary[]) {
  const weakLabel = rows.filter(isWeakLabel);
  const lowConfidence = rows.filter((r) => confidenceBand(r.confidence) === "low");
  const noAc = rows.filter(hasNoCriteria);
  const flagged = new Set([...weakLabel, ...lowConfidence, ...noAc].map((r) => r.id));
  return { weakLabel, lowConfidence, noAc, flagged, unflagged: rows.filter((r) => !flagged.has(r.id)) };
}

/** "3 are Assumed or Unverified and 1 has no acceptance criteria." */
export function approvalFlagSentence(flags: ReturnType<typeof approvalFlags>): string {
  const parts: string[] = [];
  if (flags.weakLabel.length) parts.push(`${flags.weakLabel.length} ${flags.weakLabel.length === 1 ? "is" : "are"} Assumed or Unverified`);
  if (flags.lowConfidence.length) parts.push(`${flags.lowConfidence.length} ${flags.lowConfidence.length === 1 ? "has" : "have"} low confidence`);
  if (flags.noAc.length) parts.push(`${flags.noAc.length} ${flags.noAc.length === 1 ? "has" : "have"} no acceptance criteria`);
  if (parts.length <= 1) return `${parts[0] ?? ""}.`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

// ---- Gate 3 checks (design §6.2) -------------------------------------------

export type GateCheck = { tone: "ok" | "warn" | "fail" | "info"; text: string; href?: string };

export function listKeys(rows: { key: string }[], max = 3): string {
  const keys = rows.map((r) => r.key);
  return keys.length > max ? `${keys.slice(0, max).join(", ")}, …` : keys.join(", ");
}

/** Code-computed Gate 3 checks. `listHref` builds a link to the list with the given filter query. */
export function gate3Checks(
  all: RequirementSummary[],
  readiness: ReadinessCriteria | null | undefined,
  opts: { scanN?: number | null; documents?: number; listHref: (q: Record<string, string>) => string },
): GateCheck[] {
  const out: GateCheck[] = [];
  const by = (s: RequirementStatus) => all.filter((r) => r.status === s);
  const approved = by("approved");
  const rejected = by("rejected");
  const drafts = all.filter((r) => r.status === "draft" || r.status === "needs_info");
  const src = `${opts.scanN ? ` from Scan ${opts.scanN}` : ""}${opts.documents ? ` and ${opts.documents} document${opts.documents === 1 ? "" : "s"}` : ""}`;
  out.push({ tone: all.length ? "ok" : "fail", text: `${all.length} requirement${all.length === 1 ? "" : "s"} derived${src}` });
  out.push({
    tone: approved.length ? "ok" : "fail",
    text: approved.length ? `${approved.length} approved · ${rejected.length} rejected` : "No requirement is approved yet: approve at least one",
    href: opts.listHref({ status: "approved" }),
  });
  if (drafts.length)
    out.push({
      tone: "warn",
      text: `${drafts.length} still Draft or Needs info: they won’t be used by the Test Strategy Agent until approved`,
      href: opts.listHref({ status: "draft" }),
    });
  const noAc = all.filter((r) => r.status !== "rejected" && hasNoCriteria(r));
  if (noAc.length)
    out.push({
      tone: "warn",
      text: `${noAc.length} requirement${noAc.length === 1 ? " has" : "s have"} no acceptance criteria (${listKeys(noAc)})`,
      href: opts.listHref({ no_ac: "1" }),
    });
  const weakApproved = approved.filter(isWeakLabel);
  if (weakApproved.length)
    out.push({
      tone: "warn",
      text: `${weakApproved.length} approved requirement${weakApproved.length === 1 ? " is" : "s are"} Assumed or Unverified: confirm them with the product owner`,
      href: opts.listHref({ status: "approved", label: "weak" }),
    });
  const conflicts = all.filter((r) => r.conflict);
  if (conflicts.length)
    out.push({
      tone: "warn",
      text: `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} between a document and the application (${listKeys(conflicts)})`,
      href: opts.listHref({ conflict: "1" }),
    });
  const dor = readiness?.definition_of_ready.filter((c) => c.status === "active").length ?? 0;
  const dod = readiness?.definition_of_done.filter((c) => c.status === "active").length ?? 0;
  out.push(
    readiness && dor && dod
      ? { tone: "ok", text: `Definition of Ready (${dor}) and Done (${dod}) defined` }
      : { tone: "fail", text: "Definition of Ready and Done not generated yet" },
  );
  return out;
}

// ---- Ready & Done checklist edits -----------------------------------------------

/**
 * Turns an edited checklist into API calls (design P2 §6.1): new rows are created, changed texts patched,
 * missing rows removed (status "removed"; there is no DELETE). Empty rows are dropped. The order is saved
 * separately with `checklistOrder`.
 */
export function checklistChanges(
  existing: { id: string; text: string; version: number }[],
  rows: { id: string; text: string }[],
): { create: string[]; update: { id: string; version: number; text: string }[]; remove: { id: string; version: number }[] } {
  const kept = rows.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const create = kept.filter((r) => !byId.has(r.id)).map((r) => r.text);
  const update = kept.flatMap((r) => {
    const e = byId.get(r.id);
    return e && e.text !== r.text ? [{ id: e.id, version: e.version, text: r.text }] : [];
  });
  const keptIds = new Set(kept.map((r) => r.id));
  const remove = existing.filter((e) => !keptIds.has(e.id)).map((e) => ({ id: e.id, version: e.version }));
  return { create, update, remove };
}

/**
 * The order to save after `checklistChanges` has run (BUG-P2-24). `createdIds` are the ids the server gave the
 * new rows, in row order. Returns the final ids in order when it differs from what the server will have
 * (existing rows in their old order, new rows appended), or null when no reordering is needed. Each id is then
 * sent as `PATCH {position: index}` in turn; a position-only change doesn't bump the version or reopen G3.
 */
export function checklistOrder(existingIds: string[], rows: { id: string; text: string }[], createdIds: string[]): string[] | null {
  const known = new Set(existingIds);
  const kept = rows.filter((r) => r.text.trim());
  let n = 0;
  const final = kept.map((r) => (known.has(r.id) ? r.id : (createdIds[n++] ?? r.id)));
  const keptIds = new Set(final);
  const expected = [...existingIds.filter((id) => keptIds.has(id)), ...createdIds];
  return final.length === expected.length && final.every((id, i) => id === expected[i]) ? null : final;
}
