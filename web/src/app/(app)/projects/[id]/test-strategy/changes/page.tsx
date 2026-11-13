"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useProject } from "@/components/workspace/ProjectContext";
import { ChangeReviewScreen } from "@/components/domain/ChangeReviewScreen";

/** Review a regenerated Test Strategy (`?run=<n>`) or Test Plan update (`?plan=<n>`), design P2 §8.2 / §9. */
function Changes() {
  const p = useProject();
  const params = useSearchParams();
  const num = (k: string) => {
    const n = Number(params.get(k) ?? "");
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const run = num("run");
  const planRun = num("plan");
  useEffect(() => {
    document.title = `Review changes · Test Strategy · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  const v = planRun ?? run;
  return (
    <ChangeReviewScreen
      run={v}
      apiBase={planRun ? `/projects/${p.id}/test-plan/changes/${planRun}` : run ? `/projects/${p.id}/stages/test_strategy/runs/${run}/review` : null}
      title={planRun ? "Review the updated Test Plan" : "Review the regenerated Test Strategy"}
      backHref={`/projects/${p.id}/test-strategy${planRun ? "?view=plan" : ""}`}
      backLabel="Test Strategy"
      afterApplyHref={`/projects/${p.id}/test-strategy${planRun ? "?view=plan" : ""}`}
      onDone={p.refresh}
    />
  );
}

export default function StrategyChangesPage() {
  return (
    <Suspense>
      <Changes />
    </Suspense>
  );
}
