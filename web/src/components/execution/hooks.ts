"use client";

// Run and defect state for the lifecycle, header, Overview and Dashboard (design P4 §4.3). Same SWR keys as the
// sidebar badges (AppShell), so these are shared requests, and none are made before scripts exist.

import { useApi } from "@/lib/hooks";
import type { Workflow } from "@/lib/contract";
import type { DefectList } from "@/lib/defects";
import { execSummary, type ExecSummary, type RunList } from "@/lib/execution";

export function useExecSummary(projectId: string, workflow: Workflow | null | undefined): ExecSummary | null {
  const scripted = !!workflow?.stages.find((x) => x.key === "automation")?.current_version;
  const runs = useApi<RunList>(scripted ? `/projects/${projectId}/execution-runs` : null, { limit: 20 }, { shouldRetryOnError: false, refreshInterval: 15000 });
  const defects = useApi<DefectList>(scripted ? `/projects/${projectId}/defects` : null, { status: "draft", limit: 1 }, { shouldRetryOnError: false, refreshInterval: 15000 });
  if (!scripted || (!runs.data && !defects.data)) return null;
  return execSummary(runs.data, defects.data);
}
