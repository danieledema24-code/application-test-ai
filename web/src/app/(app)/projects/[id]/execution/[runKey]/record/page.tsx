"use client";

// Record manual results for a manual run (P4-14b; design docs/design/P4-14-manual-results.md §4.2): one card per case.

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/components/workspace/ProjectContext";
import { ManualRecordPage } from "@/components/execution/ManualRecord";

function RecordPage() {
  const p = useProject();
  const { runKey } = useParams<{ runKey: string }>();
  return <ManualRecordPage projectId={p.id} runKey={decodeURIComponent(runKey)} onRefreshProject={p.refresh} />;
}

export default function Page() {
  return (
    <Suspense>
      <RecordPage />
    </Suspense>
  );
}
