"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useProject } from "@/components/workspace/ProjectContext";
import { ChangeReviewScreen } from "@/components/domain/ChangeReviewScreen";

/** Review regenerated requirements (design P2 §5.7): `/requirements/changes?run=<n>`. */
function Changes() {
  const p = useProject();
  const params = useSearchParams();
  const n = Number(params.get("run") ?? "");
  const run = Number.isInteger(n) && n > 0 ? n : null;
  useEffect(() => {
    document.title = `Review regenerated requirements · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  return (
    <ChangeReviewScreen
      run={run}
      apiBase={run ? `/projects/${p.id}/stages/requirements/runs/${run}/review` : null}
      title="Review regenerated requirements"
      backHref={`/projects/${p.id}/requirements`}
      backLabel="Requirements"
      afterApplyHref={`/projects/${p.id}/requirements?changed=1`}
      onDone={p.refresh}
    />
  );
}

export default function ChangesPage() {
  return (
    <Suspense>
      <Changes />
    </Suspense>
  );
}
