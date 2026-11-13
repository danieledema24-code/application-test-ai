// Discovery result helpers: pure functions over the API's scan/page shapes (unit-tested in tests/unit).

import type { EvidenceRef, PageSummary, ScanDetail, SitemapNode } from "./contract";

/** Component types in the order of spec §5, as matrix columns. Keys match PageSummary.counts. */
export const COMPONENT_TYPES: { key: string; label: string; singular: string; aliases: string[] }[] = [
  { key: "forms", label: "Forms", singular: "form", aliases: ["form"] },
  { key: "inputs", label: "Inputs", singular: "input", aliases: ["input", "fields", "field"] },
  { key: "buttons", label: "Buttons", singular: "button", aliases: ["button"] },
  { key: "links", label: "Links", singular: "link", aliases: ["link"] },
  { key: "dropdowns", label: "Dropdowns", singular: "dropdown", aliases: ["dropdown", "selects", "select"] },
  { key: "search", label: "Search", singular: "search box", aliases: ["searches"] },
  { key: "filters", label: "Filters", singular: "filter", aliases: ["filter"] },
  { key: "tables", label: "Tables", singular: "table", aliases: ["table"] },
  { key: "modals", label: "Modals", singular: "modal", aliases: ["modal", "dialogs", "dialog"] },
  { key: "tabs", label: "Tabs", singular: "tab set", aliases: ["tab"] },
  { key: "menus", label: "Menus", singular: "menu", aliases: ["menu"] },
  { key: "pagination", label: "Pagination", singular: "pagination control", aliases: [] },
  { key: "other", label: "Other interactive", singular: "other interactive element", aliases: ["accordion", "accordions"] },
];

function canonicalKey(k: string): string {
  const low = k.toLowerCase();
  const t = COMPONENT_TYPES.find((c) => c.key === low || c.aliases.includes(low));
  return t ? t.key : "other";
}

/** PageSummary.counts with keys normalised to COMPONENT_TYPES (unknown keys sum into "other"). */
export function normaliseCounts(counts: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const key = canonicalKey(k);
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

/** Matrix columns: only the types that occur on at least one page, in spec order. */
export function matrixColumns(pages: PageSummary[]): typeof COMPONENT_TYPES {
  const present = new Set<string>();
  for (const p of pages) for (const [k, v] of Object.entries(normaliseCounts(p.counts))) if (v > 0) present.add(k);
  return COMPONENT_TYPES.filter((c) => present.has(c.key));
}

/** Component kind (PageComponent.kind) → matrix column key. */
export function componentColumn(kind: string): string {
  const map: Record<string, string> = {
    button: "buttons",
    link: "links",
    dropdown: "dropdowns",
    search: "search",
    filter: "filters",
    table: "tables",
    modal: "modals",
    tabs: "tabs",
    menu: "menus",
    pagination: "pagination",
  };
  return map[kind] ?? "other";
}

function pathOrUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export type AccessGapRow = {
  area: string;
  reason: string;
  description: string;
  suggestion: string;
  evidence: EvidenceRef[];
};

/**
 * Access gaps table rows (design spec §8.2): exactly the gaps discovery reported, in its order, with
 * their own reason and evidence. The API's list already includes sign-in boundaries, failed pages,
 * blocked addresses, unperformed actions and unvisited links, so nothing is added or merged here.
 */
export function accessGapRows(scan: Pick<ScanDetail, "access_gaps">): AccessGapRow[] {
  return (scan.access_gaps ?? []).map((g) => ({
    area: g.area || g.description,
    reason: g.reason || "Couldn’t observe",
    description: g.area && g.description !== g.area ? g.description : "",
    suggestion: g.suggestion || "—",
    evidence: g.evidence_refs ?? [],
  }));
}

export type FlatNode = { key: string; node: SitemapNode; level: number; parentKey: string | null; hasChildren: boolean; label: string; path: string };

export function nodePath(n: SitemapNode): string {
  if (n.path) return n.path;
  if (n.url) return pathOrUrl(n.url);
  return "/";
}

/** Depth-first flattening of the sitemap tree. `expanded` limits recursion to open nodes (null = all). */
export function flattenSitemap(root: SitemapNode | null | undefined, expanded: Set<string> | null): FlatNode[] {
  const out: FlatNode[] = [];
  if (!root) return out;
  const walk = (n: SitemapNode, level: number, parentKey: string | null, idx: string) => {
    const key = n.page_id || `${idx}:${nodePath(n)}`;
    const kids = n.children ?? [];
    out.push({ key, node: n, level, parentKey, hasChildren: kids.length > 0, label: n.title || nodePath(n), path: nodePath(n) });
    if (kids.length && (expanded === null || expanded.has(key))) kids.forEach((c, i) => walk(c, level + 1, key, `${idx}.${i}`));
  };
  walk(root, 1, null, "0");
  return out;
}

/** Status for a sitemap node: "Visited", "Needs credentials", "Couldn't load (HTTP 500)", "Not visited". */
export function nodeStatus(n: SitemapNode): { label: string; tone: "green" | "amber" | "red" | "grey" } {
  if (n.requires_auth) return { label: "Needs credentials", tone: "amber" };
  if (n.http_status && n.http_status >= 400) return { label: `Couldn’t load (HTTP ${n.http_status})`, tone: "red" };
  const s = (n.status ?? "").toLowerCase();
  if (s.includes("fail") || s.includes("error") || s.includes("timeout")) return { label: `Couldn’t load${s.includes("timeout") ? " (timeout)" : ""}`, tone: "red" };
  if (n.visited === false || s.includes("not_visited") || s.includes("queued") || s.includes("skipped")) return { label: "Not visited", tone: "grey" };
  if (n.page_id || n.visited || s.includes("visited") || s === "ok") return { label: "Visited", tone: "green" };
  return { label: "Found", tone: "grey" };
}

/** True for a scan the agent is still working on. */
export function scanActive(status: string | null | undefined): boolean {
  return status === "queued" || status === "running" || status === "paused";
}

/** "04:12" from a start time. */
export function elapsed(startIso: string | null | undefined, endIso?: string | null, now = Date.now()): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const s = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
