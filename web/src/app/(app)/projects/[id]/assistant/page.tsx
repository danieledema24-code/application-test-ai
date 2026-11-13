"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ArtefactRef } from "@/lib/contract";
import { useProject } from "@/components/workspace/ProjectContext";
import { AssistantWorkspace } from "@/components/assistant/AssistantWorkspace";

/** AI QA Analyst workspace (design P2 §11.2). The thread lives in `?thread=`. */
function AssistantPage() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const threadId = params.get("thread");
  const [context, setContext] = useState<ArtefactRef | null>(null);
  useEffect(() => {
    document.title = `AI QA Analyst · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  return (
    <AssistantWorkspace
      variant="page"
      threadId={threadId}
      onThreadId={(id) => router.replace(`/projects/${p.id}/assistant${id ? `?thread=${encodeURIComponent(id)}` : ""}`, { scroll: false })}
      context={context}
      onClearContext={() => setContext(null)}
    />
  );
}

export default function Page() {
  return (
    <Suspense>
      <AssistantPage />
    </Suspense>
  );
}
