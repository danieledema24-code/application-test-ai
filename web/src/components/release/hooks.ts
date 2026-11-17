"use client";

import { useCallback, useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import type { Workflow } from "@/lib/contract";
import { useApi } from "@/lib/hooks";
import type { Assessment, ReleaseOverview } from "@/lib/release";

// While an assessment is being worked out, every 2 s; otherwise every 15 s, so an assessment that went out of date
// (new evidence) shows it without a reload.
const FAST = 2000;
const SLOW = 15000;

/**
 * Release readiness only exists once tests can run: the stage is available (Phase 6) and scripts exist. Earlier
 * projects make no call (the lifecycle, header, sidebar and Overview share this SWR key).
 */
export function releaseReachable(workflow: Workflow | null | undefined): boolean {
  const st = workflow?.stages.find((x) => x.key === "release_readiness");
  return !!st?.available && !!workflow?.stages.find((x) => x.key === "automation")?.current_version;
}

export function useReleaseOverview(projectId: string, enabled = true) {
  // A number, not a function of the data: SWR only re-reads a function when its timer fires (up to 15 s after an
  // Assess), but restarts the timer as soon as a numeric interval changes. So the 2 s pace starts right away.
  const [fast, setFast] = useState(false);
  const q = useApi<ReleaseOverview>(enabled ? `/projects/${projectId}/release-readiness` : null, undefined, { refreshInterval: fast ? FAST : SLOW, shouldRetryOnError: false });
  const assessing = !!q.data?.assessing;
  useEffect(() => setFast(assessing), [assessing]);
  return q;
}

/** One assessment by key (`/release-readiness/REL-0001`); older ones are read-only. */
export function useAssessment(projectId: string, key: string | null) {
  return useApi<Assessment>(key ? `/projects/${projectId}/release-assessments/by-key/${key}` : null, undefined, { refreshInterval: 15000 });
}

/** Revalidates every release readiness key of the project (after assess, confirm, decide, or a manual re-test). */
export function useRefreshRelease(projectId: string) {
  const { mutate } = useSWRConfig();
  return useCallback(
    () => mutate((k) => typeof k === "string" && (k.startsWith(`/projects/${projectId}/release-`) || k.startsWith("/release-assessments/") || k === `/projects/${projectId}/workflow`)),
    [mutate, projectId],
  );
}
