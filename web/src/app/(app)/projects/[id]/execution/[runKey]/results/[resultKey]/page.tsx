"use client";

// Result detail (design P4 §8.6–8.7, §9.2): expected vs actual, steps per attempt, the analysis (a Hypothesis) and
// the evidence. Passed results show steps and screenshot only. A result recorded by hand (P4-14 §4.3) shows What
// happened, notes, the case's steps and the uploaded files instead, and is never analysed.

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { fmtBytes, fmtDateTime, fmtDuration } from "@/lib/format";
import { attemptsPhrase, manualLabel, NOT_ANALYSED, resultHeader, sizeText, uploadedFileName, type ResultDetail, type RunDetail } from "@/lib/execution";
import { Callout, EmptyState, ErrorState, LinkButton, Skeleton, Button, useToast } from "@/components/ui";
import { DefectStatusPill, ResultStatus } from "@/components/domain/ExecutionLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { useAuth } from "@/lib/auth";
import { AnalysisPanel } from "@/components/execution/Analysis";
import { EvidenceViewer, ExpectedActual, isManualResult, StepResults } from "@/components/execution/Result";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { RunDialog, type RunPrefill } from "@/components/execution/RunDialog";
import { FixSuggestion } from "@/components/execution/FixSuggestion";
import { RepairCard } from "@/components/automation/Repairs";
import { api, ApiError } from "@/lib/api";

function ResultPage() {
  const p = useProject();
  const router = useRouter();
  const toast = useToast();
  const { role } = useAuth();
  const assistant = useAssistantDrawer();
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

  if (isManualResult(r)) return <ManualResult r={r} projectId={p.id} back={back} viewer={viewer} openAssistant={() => assistant.open({ type: "execution_result", id: r.id, key: r.key, label: r.key, path: `/projects/${p.id}/execution/${rk}/results/${r.key}` })} />;

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
      {/* Design P6 §8.1: a HEAL- suggestion from this failure shows its RepairCard; Phase 4 JSON keeps FixSuggestion. */}
      {!passed && (r.repairs?.length ?? 0) > 0 && (
        <section aria-labelledby="repair-title" className="space-y-3">
          <h2 id="repair-title" className="text-h2 font-semibold text-fg-strong">
            Repair suggestion
          </h2>
          {r.repairs!.map((x) => (
            <RepairCard key={x.id} repair={x} projectId={p.id} headingLevel={3} onChanged={() => void q.mutate()} />
          ))}
        </section>
      )}
      {!passed && !r.repairs?.length && r.heal_suggestions?.length > 0 && (
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

/** A result recorded by hand (§4.3): never analysed, no re-run; [Edit in RUN-0005] for its recorder while recording. */
function ManualResult({ r, projectId, back, viewer, openAssistant }: { r: ResultDetail; projectId: string; back: React.ReactNode; viewer: boolean; openAssistant: () => void }) {
  const runKey = r.run?.key ?? "";
  const defect = r.defect ?? null;
  const steps = r.case?.steps ?? [];
  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 tabIndex={-1} className="break-words text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {r.key} · {r.case_key} {r.title}
          </h1>
          <ResultStatus status={r.status} />
        </div>
        <p className="text-small text-fg-muted">
          {manualLabel(r.recorded_by?.full_name)}
          {r.recorded_at ? `, ${fmtDateTime(r.recorded_at)}` : ""}
          {runKey ? ` · ${runKey}` : ""}
          {r.case ? ` · ${r.case.key} v${r.case.version}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {defect ? (
            <LinkButton href={`/projects/${projectId}/defects/${defect.key}`}>
              View {defect.key} · <DefectStatusPill status={defect.status} withNote={false} />
            </LinkButton>
          ) : (
            !viewer &&
            r.permissions.can_raise_defect &&
            (r.status === "failed" || r.status === "blocked") && <LinkButton href={`/projects/${projectId}/defects/new?from=${r.key}`}>Raise defect…</LinkButton>
          )}
          <Button variant="secondary" onClick={openAssistant}>
            Ask the analyst
          </Button>
          {!viewer && r.permissions.can_record && runKey && (
            <LinkButton href={`/projects/${projectId}/execution/${runKey}/record#${r.case_key}`}>Edit in {runKey}</LinkButton>
          )}
        </div>
      </div>
      <ExpectedActual r={r} />
      {steps.length > 0 && r.case && (
        <section aria-labelledby="manual-steps-title" className="space-y-2">
          <h2 id="manual-steps-title" className="text-h3 font-semibold text-fg-strong">
            Steps ({r.case.key} v{r.case.version}; recorded as one result, not step by step)
          </h2>
          <ol className="space-y-1 rounded-lg bg-surface p-3 ring-1 ring-line">
            {steps.map((s, i) => (
              <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 break-words text-body">
                <span className="tabular-nums text-fg-muted">{s.n ?? i + 1}</span>
                <span>
                  {s.action}
                  {s.expected?.trim() && <span className="block text-small text-fg-muted">Expected: {s.expected}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="text-body text-fg">{r.not_analysed ?? NOT_ANALYSED}.</p>
      <section aria-labelledby="manual-files-title" className="space-y-2">
        <h2 id="manual-files-title" className="text-h3 font-semibold text-fg-strong">
          Files
        </h2>
        {r.evidence.length ? (
          <ul className="space-y-1 text-body">
            {r.evidence.map((e, i) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2">
                {uploadedFileName(e, i)} <span className="text-small text-fg-muted">· {fmtBytes(e.size)}</span>
                {e.removed ? (
                  <span className="text-small text-fg-muted">· {e.removed}</span>
                ) : (
                  <a href={e.content_url} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center text-small font-medium text-navy-700 underline underline-offset-2">
                    Open {uploadedFileName(e, i)}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">No files were added.</p>
        )}
      </section>
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
