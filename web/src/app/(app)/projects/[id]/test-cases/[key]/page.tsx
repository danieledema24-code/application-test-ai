"use client";

import { Suspense, useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { parseCaseFilters } from "@/lib/testcases";
import { Callout, EmptyState, LinkButton } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, requirementsStages } from "@/components/requirements/hooks";
import { useAllTestCases } from "@/components/testcases/hooks";
import { TestCaseDetailView } from "@/components/testcases/TestCaseDetail";

/** Test case detail (design P3 §8): `/test-cases/TC-0019`, `?v=<n>` read-only, `?edit=1`, and `/test-cases/new`. */
function Detail() {
  const p = useProject();
  const { key } = useParams<{ key: string }>();
  const params = useSearchParams();
  const { role } = useAuth();
  const canEdit = role !== null && role !== "viewer";
  const filters = useMemo(() => parseCaseFilters(params), [params]);
  const stages = requirementsStages(p.workflow);
  const current = stages.design?.current_version ?? null;
  const v = Number(params.get("v") ?? "");
  const olderVersion = current && Number.isInteger(v) && v > 0 && v !== current ? v : null;
  const decoded = decodeURIComponent(key);
  const isNew = decoded === "new";
  const all = useAllTestCases(p.id, null, !!current);

  useEffect(() => {
    document.title = `${isNew ? "New test case" : decoded} · Test Cases · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [decoded, isNew, p.project?.name]);

  if (p.workflow && !current)
    return <EmptyState title="Test cases haven’t been designed yet." action={<LinkButton href={`/projects/${p.id}/test-cases`}>Go to Test Cases</LinkButton>} />;
  if (isNew && !canEdit)
    return (
      <div className="space-y-4">
        <Callout tone="neutral">You have view-only access. Ask an owner or admin for member access to edit test cases.</Callout>
        <LinkButton href={`/projects/${p.id}/test-cases`}>Back to test cases</LinkButton>
      </div>
    );
  return (
    <TestCaseDetailView
      key={decoded}
      projectId={p.id}
      caseKey={decoded}
      all={all.data}
      filters={filters}
      olderVersion={olderVersion}
      canEdit={canEdit}
      g5Approved={gateApproved(stages.g5)}
      isNew={isNew}
      prefillRequirement={params.get("requirement")}
      fromKey={params.get("from")}
      onListChanged={async () => {
        await all.mutate();
        p.refresh();
      }}
    />
  );
}

export default function TestCasePage() {
  return (
    <Suspense>
      <Detail />
    </Suspense>
  );
}
