"use client";

// Raise a defect (design P4 §11.5): blank, or `?from=RUN-0003-07` prefilled from a result. Saved as a draft for G8.

import Link from "next/link";
import { Suspense, useEffect, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import type { ResultDetail } from "@/lib/execution";
import { prefillFrom, type DefectDetail } from "@/lib/defects";
import { Callout, EmptyState, LinkButton, Skeleton, useToast } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { DefectForm, EMPTY_FIELDS, lines, type DefectFields } from "@/components/defects/DefectForm";

function NewDefect() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const from = params.get("from");
  const result = useApi<ResultDetail>(from ? `/projects/${p.id}/execution-results/by-key/${from}` : null, undefined, { shouldRetryOnError: false });
  const initial = useMemo<DefectFields>(() => (result.data ? { ...EMPTY_FIELDS, ...prefillFrom(result.data) } : EMPTY_FIELDS), [result.data]);

  useEffect(() => {
    document.title = `Raise a defect · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  if (role === "viewer") return <EmptyState title="Viewers can't raise defects." action={<LinkButton href={`/projects/${p.id}/defects`}>Back to defects</LinkButton>} />;
  async function submit(f: DefectFields) {
    const d = await api<DefectDetail>(`/projects/${p.id}/defects`, {
      method: "POST",
      body: {
        from_result_id: result.data?.id ?? null,
        summary: f.summary,
        description: f.description,
        preconditions: lines(f.preconditions),
        steps: lines(f.steps),
        expected: f.expected,
        actual: f.actual,
        severity: f.severity || null,
        priority: f.priority || null,
      },
    });
    toast(`${d.key} created as a draft.`, "success");
    p.refresh();
    router.push(`/projects/${p.id}/defects/${d.key}`);
  }
  return (
    <div className="space-y-6">
      <Link href={`/projects/${p.id}/defects`} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Defects
      </Link>
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Raise a defect
      </h1>
      {from && !result.data && !result.error ? (
        <Skeleton className="h-96" />
      ) : (
        <DefectForm
          key={result.data?.id ?? "blank"}
          initial={initial}
          submitLabel="Save as draft"
          onSubmit={submit}
          onCancel={() => router.push(`/projects/${p.id}/defects`)}
          intro={
            result.data ? (
              <Callout tone="info">Prefilled from {result.data.key}. Check the wording before saving.</Callout>
            ) : (
              <p className="text-body text-fg-muted">Saved as a draft, then confirmed or rejected at Gate 8 like any draft.</p>
            )
          }
        />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <NewDefect />
    </Suspense>
  );
}
