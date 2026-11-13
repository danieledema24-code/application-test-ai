// Word- and field-level diffs for DiffView (design P2 §5.6). Pure; unit-tested.

import type { ChangeReviewItem, ReviewAction } from "./contract";

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

function tokens(s: string): string[] {
  // Words plus the whitespace/punctuation between them, so joining the tokens restores the text.
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** Word-level diff (LCS). Long inputs fall back to a whole-text replace to stay fast. */
export function wordDiff(from: string, to: string): DiffPart[] {
  if (from === to) return from ? [{ kind: "same", text: from }] : [];
  const a = tokens(from);
  const b = tokens(to);
  if (a.length * b.length > 250_000) {
    return [
      ...(from ? [{ kind: "del" as const, text: from }] : []),
      ...(to ? [{ kind: "add" as const, text: to }] : []),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", a[i++]);
    else push("add", b[j++]);
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("add", b[j++]);
  return out;
}

/** Text form of any field value, for diffing and display. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueText).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.label === "string") return o.label;
    if (typeof o.text === "string") return o.text;
    if (typeof o.key === "string" && typeof o.title === "string") return `${o.key} ${o.title}`;
    if ("given" in o || "when" in o || "then" in o) return `Given ${valueText(o.given)} · When ${valueText(o.when)} · Then ${valueText(o.then)}`;
    return JSON.stringify(o);
  }
  return String(v);
}

export type ListChange = { kind: "added" | "removed" | "changed" | "same"; text: string; from?: string };

/** Item-level diff of two lists (assumptions, criteria): + Added, − Removed, ~ Changed (same position). */
export function listDiff(from: unknown[], to: unknown[]): ListChange[] {
  const a = from.map(valueText);
  const b = to.map(valueText);
  const out: ListChange[] = [];
  const remainingB = new Set(b.map((_, i) => i));
  const matchedA = new Set<number>();
  a.forEach((x, i) => {
    const j = b.findIndex((y, k) => y === x && remainingB.has(k));
    if (j !== -1) {
      remainingB.delete(j);
      matchedA.add(i);
    }
  });
  const unA = a.map((x, i) => ({ x, i })).filter(({ i }) => !matchedA.has(i));
  const unB = [...remainingB].sort((x, y) => x - y).map((i) => ({ y: b[i], i }));
  const pairs = Math.min(unA.length, unB.length);
  for (const x of a.filter((_, i) => matchedA.has(i))) out.push({ kind: "same", text: x });
  for (let k = 0; k < pairs; k++) out.push({ kind: "changed", text: unB[k].y, from: unA[k].x });
  for (const { x } of unA.slice(pairs)) out.push({ kind: "removed", text: x });
  for (const { y } of unB.slice(pairs)) out.push({ kind: "added", text: y });
  return out;
}

export type FieldChange = { field: string; from: unknown; to: unknown };

/** Field changes between two snapshots, limited to `fields` when given. */
export function fieldChanges(from: Record<string, unknown> | null | undefined, to: Record<string, unknown> | null | undefined, fields?: string[]): FieldChange[] {
  const keys = fields ?? [...new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])];
  return keys
    .filter((k) => JSON.stringify((from ?? {})[k] ?? null) !== JSON.stringify((to ?? {})[k] ?? null))
    .map((k) => ({ field: k, from: (from ?? {})[k], to: (to ?? {})[k] }));
}

/**
 * The `decisions` body for applying a regeneration review. Unchanged items are left out (the server keeps them),
 * and an item without a chosen or default action is never sent — the API rejects null (BUG-P2-03).
 */
export function reviewDecisions(items: ChangeReviewItem[], chosen: Record<string, ReviewAction | undefined>): Record<string, ReviewAction> {
  const out: Record<string, ReviewAction> = {};
  for (const i of items) {
    if (i.change === "unchanged") continue;
    const a = chosen[i.lineage_id] ?? i.default_action;
    if (a) out[i.lineage_id] = a;
  }
  return out;
}
