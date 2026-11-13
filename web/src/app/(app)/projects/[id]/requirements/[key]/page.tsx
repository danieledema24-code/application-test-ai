"use client";

import { Suspense, useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { parseFilters } from "@/lib/requirements";
import { EmptyState, LinkButton } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, requirementsStages, useAllRequirements } from "@/components/requirements/hooks";
import { RequirementDetail } from "@/components/requirements/RequirementDetail";
import { NewRequirement } from "@/components/requirements/NewRequirement";

/** Requirement detail (design P2 §5.3): `/requirements/REQ-0007`, `?v=<n>` read-only, `/requirements/new`. */
function Detail() {
  const p = useProject();
  const { key } = useParams<{ key: string }>();
  const params = useSearchParams();
  const { role } = useAuth();
  const canEdit = role !== "viewer";
  const filters = useMemo(() => parseFilters(params), [params]);
  const stages = requirementsStages(p.workflow);
  const current = stages.req?.current_version ?? null;
  const v = Number(params.get("v") ?? "");
  const olderVersion = current && Number.isInteger(v) && v > 0 && v !== current ? v : null;
  const all = useAllRequirements(p.id, olderVersion, !!current && key !== "new");
  const decoded = decodeURIComponent(key);

  useEffect(() => {
    document.title = `${decoded === "new" ? "Add requirement" : decoded} · Requirements · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [decoded, p.project?.name]);

  if (decoded === "new") {
    if (!canEdit) return <EmptyState title="Viewers can’t add requirements." action={<LinkButton href={`/projects/${p.id}/requirements`}>Back to Requirements</LinkButton>} />;
    return <NewRequirement projectId={p.id} g3Approved={gateApproved(stages.g3)} />;
  }
  if (p.workflow && !current)
    return <EmptyState title="Requirements haven’t been generated yet." action={<LinkButton href={`/projects/${p.id}/requirements`}>Go to Requirements</LinkButton>} />;
  return (
    <RequirementDetail
      projectId={p.id}
      requirementKey={decoded}
      all={all.data}
      filters={filters}
      olderVersion={olderVersion}
      g3Approved={gateApproved(stages.g3)}
      canEdit={canEdit}
      onListChanged={async () => {
        await all.mutate();
        p.refresh();
      }}
    />
  );
}

export default function RequirementPage() {
  return (
    <Suspense>
      <Detail />
    </Suspense>
  );
}
