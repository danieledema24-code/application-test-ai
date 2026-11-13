"use client";

import useSWR from "swr";
import { api, buildQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { Feature, Page, Risk, ScanDetail, ReadinessCriteria, RequirementStats, RequirementSummary, SourceDocument, StageState, Workflow } from "@/lib/contract";

/** Every requirement of a version (cursor pages of 100), so filters, counts and Previous/Next agree. */
export function useAllRequirements(projectId: string, stageRunVersion?: number | null, enabled = true) {
  const key = enabled ? `/projects/${projectId}/requirements${buildQuery({ stage_run_version: stageRunVersion ?? undefined, all: 1 })}` : null;
  return useSWR<RequirementSummary[]>(
    key,
    async () => {
      const out: RequirementSummary[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const page: Page<RequirementSummary> = await api<Page<RequirementSummary>>(`/projects/${projectId}/requirements`, {
          query: { limit: 100, cursor, stage_run_version: stageRunVersion ?? undefined },
        });
        out.push(...page.items);
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      return out;
    },
    { revalidateOnFocus: false },
  );
}

export function useRequirementStats(projectId: string, enabled = true, stageRunVersion?: number | null) {
  return useApi<RequirementStats>(enabled ? `/projects/${projectId}/requirements/stats` : null, { stage_run_version: stageRunVersion ?? undefined }, { shouldRetryOnError: false });
}

export function useReadiness(projectId: string, enabled = true, stageRunVersion?: number | null) {
  return useApi<ReadinessCriteria>(enabled ? `/projects/${projectId}/readiness-criteria` : null, { stage_run_version: stageRunVersion ?? undefined }, { shouldRetryOnError: false });
}

export function useDocuments(projectId: string, enabled = true, poll = false) {
  return useApi<SourceDocument[]>(enabled ? `/projects/${projectId}/documents` : null, { include_withdrawn: true }, { refreshInterval: poll ? 3000 : 0, shouldRetryOnError: false });
}

/** Stage run summaries (contract: list[StageRunSummary]; fields beyond version are read if present). */
export type StageRunSummary = {
  version: number;
  status: string;
  generated_by?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  review_status?: "pending_review" | "applied" | "discarded" | null;
  partial?: boolean;
  upstream_versions?: Record<string, number>;
};

export function useStageRuns(projectId: string, stage: string, enabled = true) {
  return useApi<StageRunSummary[]>(enabled ? `/projects/${projectId}/stages/${stage}/runs` : null, undefined, { shouldRetryOnError: false });
}

/** The stages behind Requirements: the requirement set, Ready & Done, and the one carrying Gate 3. */
export function requirementsStages(wf: Workflow | undefined) {
  const by = (k: string) => wf?.stages.find((s) => s.key === k) as StageState | undefined;
  const req = by("requirements");
  const dor = by("readiness_criteria");
  const g3 = wf?.stages.find((s) => s.gate?.key === "G3");
  const g2 = wf?.stages.find((s) => s.gate?.key === "G2");
  const strategy = by("test_strategy");
  const g4 = wf?.stages.find((s) => s.gate?.key === "G4");
  return { req, dor, g3, g2, strategy, g4, discovery: by("discovery") };
}

export function isWorking(s: StageState | undefined | null): boolean {
  return !!s && (s.status === "running" || s.status === "queued");
}

export function gateApproved(s: StageState | undefined | null): boolean {
  const g = s?.gate?.status?.toLowerCase();
  return g === "approved" || g === "auto" || g === "auto_approved";
}

/**
 * One-time warning after the first change to approved content (design P2 §6.2): the gate reopens and the
 * downstream stage keeps the last approved version. Remembered per project and gate for the session.
 */
export function noteGateReopened(projectId: string, gate: "G3" | "G4", wasApproved: boolean, toast: (m: string, k?: "success" | "error" | "info") => void) {
  if (!wasApproved || typeof window === "undefined") return;
  const k = `qa:reopen:${projectId}:${gate}`;
  try {
    if (window.sessionStorage.getItem(k)) return;
    window.sessionStorage.setItem(k, "1");
  } catch {
    /* storage unavailable: still warn */
  }
  toast(
    gate === "G3"
      ? "Requirements changed since Gate 3 approval. Approve again to pass the changes to the Test Strategy."
      : "The Test Strategy changed since Gate 4 approval. Approve again to update the Test Plan.",
    "info",
  );
}

/** Features of the latest discovery scan (for related-feature pickers and assistant task scopes). */
export function useDiscoveryFeatures(projectId: string, enabled = true) {
  const scan = useApi<ScanDetail>(enabled ? `/projects/${projectId}/discovery` : null, undefined, { shouldRetryOnError: false });
  return useApi<Feature[]>(scan.data ? `/scans/${scan.data.id}/features` : null);
}

/** Version selector label: "5 · 13 Nov 2026 · current". */
export function runLabel(r: StageRunSummary, current: number | null | undefined): string {
  const parts = [`${r.version}`];
  if (r.created_at) parts.push(fmtDate(r.created_at));
  if (r.version === current) parts.push("current");
  else if (r.review_status === "pending_review") parts.push("waiting for review");
  else if (r.review_status === "discarded") parts.push("Discarded");
  if (r.generated_by === "rules") parts.push("rules");
  return parts.join(" · ");
}

/** Every risk of the project (cursor pages of 100). */
export function useAllRisks(projectId: string, enabled = true) {
  return useSWR<Risk[]>(
    enabled ? `/projects/${projectId}/risks?all=1` : null,
    async () => {
      const out: Risk[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const page: Page<Risk> = await api<Page<Risk>>(`/projects/${projectId}/risks`, { query: { limit: 100, cursor } });
        out.push(...page.items);
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      return out;
    },
    { revalidateOnFocus: false },
  );
}
