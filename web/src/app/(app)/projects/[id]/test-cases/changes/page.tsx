"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Callout } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { ChangeReviewScreen } from "@/components/domain/ChangeReviewScreen";
import { gateApproved, requirementsStages } from "@/components/requirements/hooks";

/** Review regenerated test cases, conditions and test data (design P3 §12.2): `/test-cases/changes?run=<n>`. */
function Changes() {
  const p = useProject();
  const params = useSearchParams();
  const { role } = useAuth();
  const viewer = role === "viewer";
  const n = Number(params.get("run") ?? "");
  const run = Number.isInteger(n) && n > 0 ? n : (requirementsStages(p.workflow).design?.pending_review?.version ?? null);
  const g5Approved = gateApproved(requirementsStages(p.workflow).g5);
  const current = requirementsStages(p.workflow).design?.current_version ?? null;
  useEffect(() => {
    document.title = `Review regenerated test cases · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  return (
    <ChangeReviewScreen
      run={run}
      apiBase={run ? `/projects/${p.id}/stages/test_design/runs/${run}/review` : null}
      title="Review regenerated test cases"
      backHref={`/projects/${p.id}/test-cases`}
      backLabel="Test Cases"
      afterApplyHref={`/projects/${p.id}/test-cases?changed=1`}
      onDone={p.refresh}
      versionNoun="Design run"
      banner={
        <>
          <p className="text-body text-fg">Applies to test cases, conditions and test data.</p>
          {viewer && <Callout tone="neutral">You have view-only access. A member, owner or admin can apply these changes.</Callout>}
        </>
      }
      reviewProps={{
        viewer,
        applyNote: g5Approved ? "Gate 5 will need approval again." : null,
        protectedSub: "approved, edited, locked or written by people",
        itemHref: (i) => (i.type === "test_case" ? `/projects/${p.id}/test-cases/${i.key}` : null),
        discardBody: current ? `Design run ${current} stays current.` : undefined,
      }}
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
