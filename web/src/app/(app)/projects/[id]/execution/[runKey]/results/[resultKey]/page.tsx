"use client";

// Result detail (design P4 §8.6–8.7, §9.2): expected vs actual, steps per attempt, the analysis (a Hypothesis) and
// the evidence. Passed results show steps and screenshot only.

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { fmtDuration } from "@/lib/format";
import { attemptsPhrase, resultHeader, sizeText, type ResultDetail, type RunDetail } from "@/lib/execution";
import { Callout, EmptyState, ErrorState, LinkButton, Skeleton, Button, useToast } from "@/components/ui";
import { DefectStatusPill, ResultStatus } from "@/components/domain/ExecutionLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { useAuth } from "@/lib/auth";
import { AnalysisPanel } from "@/components/execution/Analysis";
import { EvidenceViewer, ExpectedActual, StepResults } from "@/components/execution/Result";
import { RunDialog, type RunPrefill } from "@/components/execution/RunDialog";
import { FixSuggestion } from "@/components/execution/FixSuggestion";
import { api, ApiError } from "@/lib/api";

function ResultPage() {
  const p = useProject();
  const router = useRouter();
  const toast = useToast();
  const { role } = useAuth();
  const { runKey, resultKey } = useParams<{ runKey: string; resultKey: string }>();
  const rk = decodeURIComponent(runKey);
  const key = decodeURIComponent(resultKey);
  const q = useApi<ResultDetail>(`/projects/${p.id}/execution-results/by-key/${key}`, undefined, { shouldRetryOnError: false });
  const r = q.data;
  const [rerun, setRerun] = useState(false);
  const viewer = role === "viewer" || role === null;
  const runs = useApi<{ permissions: { can_authorise: boolean } }>(!viewer ? `/projects/${p.id}/execution-runs` : null, { limit: 1 }, { shouldRetryOnError: false });
  const prefill = useMemo<RunPrefill | undefined>(() => (r?.case_key ? { caseKeys: [r.case_key] } : undefined), [r?.case_key]);

  useEffect(() => {
    document.title = `${key} · ${rk} · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [key, rk, p.project?.name]);

  const back = (
    <Link href={`/projects/${p.id}/execution/${rk}`} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
      <ArrowLeft className="h-4 w-4" aria-hidden /> {rk}
    </Link>
  );
  if (q.error && !r) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return <EmptyState title={`We couldn’t find ${key} in this project.`} action={<LinkButton href={`/projects/${p.id}/execution/${rk}`}>Back to {rk}</LinkButton>} />;
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={q.error} title={`Couldn’t load ${key}.`} message="Try again." onRetry={() => void q.mutate()} />
      </div>
    );
  }
  if (!r)
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64" />
      </div>
    );

  async function validateNow() {
    try {
      await api(`/projects/${p.id}/automation/validate`, { method: "POST" });
      toast("Validation started. Scripts run their checks again.", "success", { action: { label: "Open Automation", onClick: () => router.push(`/projects/${p.id}/automation`) } });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t start validation. Try again.", "error");
    }
  }

  const header = resultHeader(r);
  const browser = r.page_state.browser ?? (r.browser === "chromium" ? "Chromium" : r.browser);
  const defect = r.defect ?? r.analysis?.defect ?? null;
  const passed = r.status === "passed";
  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {r.key} · {r.case_key} {r.title}
          </h1>
          <ResultStatus status={r.status} />
        </div>
        <p className="text-small text-fg-muted">
          {browser} · {sizeText(r.viewport)} {r.viewport.replace("x", " × ")} · {attemptsPhrase(r)}
          {r.duration_ms !== null ? ` · ${fmtDuration(r.duration_ms)}` : ""}
          {r.script ? ` · script ${r.script.path.split("/").pop()} v${r.script.version}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {defect ? (
            <LinkButton href={`/projects/${p.id}/defects/${defect.key}`}>
              View {defect.key} · <DefectStatusPill status={defect.status} withNote={false} />
            </LinkButton>
          ) : (
            r.permissions.can_raise_defect &&
            !passed &&
            r.status !== "flaky" && <LinkButton href={`/projects/${p.id}/defects/new?from=${r.key}`}>Raise defect…</LinkButton>
          )}
          {!viewer && r.case_key && (
            <Button variant="secondary" onClick={() => setRerun(true)}>
              Re-run this test…
            </Button>
          )}
        </div>
      </div>
      {header && (
        <Callout
          tone={r.status === "error" ? "danger" : r.status === "flaky" || r.status === "blocked" ? "warning" : "neutral"}
          title={header}
          actions={r.status === "blocked" && !viewer ? <LinkButton href={`/projects/${p.id}/settings`}>Add test credentials</LinkButton> : undefined}
        />
      )}
      <ExpectedActual r={r} />
      <StepResults r={r} />
      {!passed && (
        <AnalysisPanel
          result={r}
          projectId={p.id}
          onChanged={(next, message) => {
            void q.mutate(next, { revalidate: false });
            toast(message, "success");
          }}
        />
      )}
      {!passed && r.heal_suggestions?.length > 0 && (
        <FixSuggestion
          result={r}
          onAccepted={(res) => {
            void q.mutate(res.result, { revalidate: false });
            toast(res.message, "success", { action: { label: "Validate now", onClick: () => void validateNow() } });
          }}
          onError={(m) => toast(m, "error")}
          onValidate={() => void validateNow()}
        />
      )}
      {r.evidence.length > 0 ? <EvidenceViewer r={r} /> : <p className="text-body text-fg-muted">No evidence was recorded for this test.</p>}
      {!viewer && (
        <RunDialog
          open={rerun}
          onClose={() => setRerun(false)}
          projectId={p.id}
          canAuthorise={!!runs.data?.permissions.can_authorise}
          prefill={prefill}
          onCreated={(run: RunDetail, authorised) => {
            toast(authorised ? `${run.key} authorised and starting.` : `${run.key} requested. Someone who can approve gates must authorise it.`, "success");
            router.push(`/projects/${p.id}/execution/${run.key}`);
          }}
        />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ResultPage />
    </Suspense>
  );
}
