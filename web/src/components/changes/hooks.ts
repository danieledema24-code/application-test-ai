"use client";

import { useMemo } from "react";
import type { Page, ScanSummary } from "@/lib/contract";
import { COMPARABLE, type ChangeItem, type ChangeSet, type ChangeSetList, type ImpactView, type Recommendation } from "@/lib/change";
import { useApi } from "@/lib/hooks";
import { scanNumber } from "@/lib/url";

const busy = (s: ChangeSet) => s.status === "queued" || s.status === "running";

// Module-level intervals: SWR restarts its polling timer whenever `refreshInterval` changes identity, and the
// workspace re-renders often (live updates), so an inline function would keep postponing the next poll. "No data
// yet" keeps polling, because SWR works the first interval out before the first response arrives.
const listInterval = (d?: ChangeSetList) => (!d || d.items.some(busy) ? 3000 : 0);
const setInterval3s = (d?: ChangeSet) => (!d || busy(d) ? 3000 : 0);

/** Every change set of the project, newest first. Polls while one is being compared. */
export function useChangeSets(projectId: string) {
  return useApi<ChangeSetList>(`/projects/${projectId}/changes`, undefined, { refreshInterval: listInterval });
}

export function useChangeSet(projectId: string, key: string | null) {
  return useApi<ChangeSet>(key ? `/projects/${projectId}/change-sets/${key}` : null, undefined, { refreshInterval: setInterval3s });
}

export function useChangeItems(set: ChangeSet | undefined) {
  return useApi<{ items: ChangeItem[]; total: number }>(set && set.status === "completed" ? `/change-sets/${set.id}/items` : null);
}

/** Impact items of a completed change set (all of them; the tab filters on the page). */
export function useImpact(set: ChangeSet | undefined) {
  return useApi<ImpactView>(set && set.status === "completed" ? `/change-sets/${set.id}/impact` : null);
}

export function useRecommendation(set: ChangeSet | undefined) {
  return useApi<Recommendation>(set && set.status === "completed" ? `/change-sets/${set.id}/regression-recommendation` : null);
}

export type ScanRow = ScanSummary & { n: number };

/**
 * Scans with their numbers, and the rescan baseline (design P6 §6.3, D25): the newest finished scan approved at
 * Gate 2. The API picks the same one when `compare_with` is left out.
 */
export function useScanRows(projectId: string, enabled = true) {
  // Same key as `useScans`, so the Discovery page and this share one request.
  const scans = useApi<Page<ScanSummary>>(enabled ? `/projects/${projectId}/scans` : null, { limit: 100 });
  const rows = useMemo<ScanRow[]>(
    () => (enabled ? (scans.data?.items ?? []) : []).map((s) => ({ ...s, n: s.number ?? scanNumber(s.key) ?? 0 })).sort((a, b) => b.n - a.n),
    [scans.data, enabled],
  );
  const comparable = useMemo(() => rows.filter((s) => COMPARABLE.has(s.status)), [rows]);
  const baseline = useMemo(() => comparable.find((s) => s.g2_approved), [comparable]);
  return { scans, rows, comparable, baseline, hasBaseline: !!baseline };
}
