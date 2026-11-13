"use client";

import useSWR from "swr";
import { api, ApiError, buildQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Coverage, DesignLint, Gaps, Page, TestCaseDetail, TestCaseStats, TestCaseSummary, TestCondition, TestDataItem } from "@/lib/contract";

/** All pages of a cursor list (pages of 100), so filters, counts and Previous/Next agree. */
async function allPages<T>(path: string, query: Record<string, string | number | boolean | null | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: Page<T> = await api<Page<T>>(path, { query: { ...query, limit: 100, cursor } });
    out.push(...page.items);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** Every test case of a design run (default: the current run). */
export function useAllTestCases(projectId: string, stageRunVersion?: number | null, enabled = true) {
  const key = enabled ? `/projects/${projectId}/test-cases${buildQuery({ stage_run_version: stageRunVersion ?? undefined, all: 1 })}` : null;
  return useSWR<TestCaseSummary[]>(key, () => allPages<TestCaseSummary>(`/projects/${projectId}/test-cases`, { stage_run_version: stageRunVersion ?? undefined }), {
    revalidateOnFocus: false,
  });
}

/** Ids the server's search found (objective and step text). Only fetched while a search term is set. */
export function useCaseSearch(projectId: string, q: string, stageRunVersion?: number | null) {
  const term = q.trim();
  const key = term ? `/projects/${projectId}/test-cases${buildQuery({ q: term, stage_run_version: stageRunVersion ?? undefined, search: 1 })}` : null;
  return useSWR<Set<string>>(
    key,
    async () => new Set((await allPages<TestCaseSummary>(`/projects/${projectId}/test-cases`, { q: term, stage_run_version: stageRunVersion ?? undefined })).map((c) => c.id)),
    { revalidateOnFocus: false, keepPreviousData: true },
  );
}

export function useCaseStats(projectId: string, enabled = true, stageRunVersion?: number | null) {
  return useApi<TestCaseStats>(enabled ? `/projects/${projectId}/test-cases/stats` : null, { stage_run_version: stageRunVersion ?? undefined }, { shouldRetryOnError: false });
}

export function useDesignLint(projectId: string, enabled = true) {
  return useApi<DesignLint>(enabled ? `/projects/${projectId}/test-design/lint` : null, undefined, { shouldRetryOnError: false });
}

export function useAllConditions(projectId: string, stageRunVersion?: number | null, enabled = true) {
  const key = enabled ? `/projects/${projectId}/test-conditions${buildQuery({ stage_run_version: stageRunVersion ?? undefined, all: 1 })}` : null;
  return useSWR<TestCondition[]>(key, () => allPages<TestCondition>(`/projects/${projectId}/test-conditions`, { stage_run_version: stageRunVersion ?? undefined }), {
    revalidateOnFocus: false,
  });
}

export function useAllTestData(projectId: string, stageRunVersion?: number | null, enabled = true) {
  const key = enabled ? `/projects/${projectId}/test-data${buildQuery({ stage_run_version: stageRunVersion ?? undefined, all: 1 })}` : null;
  return useSWR<TestDataItem[]>(key, () => allPages<TestDataItem>(`/projects/${projectId}/test-data`, { stage_run_version: stageRunVersion ?? undefined }), { revalidateOnFocus: false });
}

export function useCoverage(projectId: string, basis: "current" | "approved", enabled = true) {
  return useApi<Coverage>(enabled ? `/projects/${projectId}/traceability/coverage` : null, { basis }, { shouldRetryOnError: false });
}

export function useGaps(projectId: string, basis: "current" | "approved", enabled = true) {
  return useApi<Gaps>(enabled ? `/projects/${projectId}/traceability/gaps` : null, { basis }, { shouldRetryOnError: false });
}

/** 404 = expected "not there" answer (unknown key, never approved): not an error worth logging. */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * The requirement each open-question case waits on, by case id. The list API may not carry it, so the few
 * open-question cases are read one by one (QA BUG-P3-07).
 */
export function useOpenQuestionKeys(cases: TestCaseSummary[] | undefined) {
  const open = (cases ?? []).filter((c) => c.expected_result_status === "open_question" && c.status !== "rejected");
  const known = Object.fromEntries(open.filter((c) => c.open_question?.requirement?.key).map((c) => [c.id, c.open_question!.requirement!.key]));
  const missing = open.filter((c) => !(c.id in known)).map((c) => c.id);
  const key = missing.length ? `open-question-keys:${missing.sort().join(",")}` : null;
  const res = useSWR<Record<string, string>>(
    key,
    async () => {
      const details = await Promise.all(missing.map((id) => api<TestCaseDetail>(`/test-cases/${id}`).catch(() => null)));
      return Object.fromEntries(details.filter((d): d is TestCaseDetail => !!d?.open_question?.requirement?.key).map((d) => [d.id, d.open_question!.requirement.key]));
    },
    { revalidateOnFocus: false },
  );
  return { keys: { ...known, ...(res.data ?? {}) }, loading: !!key && !res.data && !res.error };
}
