"use client";

// Run page (design P4 §8.2–8.5, §9.1): authorisation when waiting, live view while running, results and
// "What failed and why" when finished. Rows refresh every 2 s while the run is active. Manual runs (P4-14) show
// their results recorded by hand instead (ManualRunView).

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, buildQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import {
  authorisationLine,
  finishedAnnouncement,
  finishedSentence,
  isActive,
  milestones,
  progressSentence,
  runStateCopy,
  sizeText,
  BROWSER_TEXT,
  targetsText,
  type RunDetail,
  type TestRow,
} from "@/lib/execution";
import { Button, Callout, ConfirmDialog, EmptyState, ErrorState, LinkButton, Segmented, Skeleton, TabPanel, Table, Tabs, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { ResultStatus, RunStatusPill } from "@/components/domain/ExecutionLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { AuthorisationSummary } from "@/components/execution/RunDialog";
import { RunAuthorisationPanel } from "@/components/execution/RunAuthorisation";
import { LiveRunView } from "@/components/execution/LiveRunView";
import { WhatFailedCard } from "@/components/execution/Analysis";
import { RunMenu } from "@/components/execution/RunMenu";
import { ManualRunView } from "@/components/execution/ManualRecord";

type Filter = "all" | "running" | "failed" | "flaky" | "blocked" | "waiting";

function matches(r: TestRow, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "failed") return r.status === "failed" || r.status === "error";
  if (f === "blocked") return r.status === "blocked" || r.status === "skipped";
  return r.status === f;
}

function TestsTable({ rows, base, filter, setFilter }: { rows: TestRow[]; base: string; filter: Filter; setFilter: (f: Filter) => void }) {
  const count = (f: Filter) => rows.filter((r) => matches(r, f)).length;
  const opts = (["all", "running", "failed", "flaky", "blocked", "waiting"] as Filter[])
    .filter((f) => f === "all" || count(f) > 0)
    .map((f) => ({ value: f, label: `${f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)} ${count(f)}` }));
  const shown = rows.filter((r) => matches(r, filter));
  return (
    <div className="space-y-3">
      <Segmented label="Tests" value={filter} onChange={setFilter} options={opts} />
      <Table label="Tests in this run">
        <THead>
          <tr>
            <Th>Test</Th>
            <Th>Browser · size</Th>
            <Th>Status</Th>
            <Th>Attempt</Th>
            <Th>Time</Th>
          </tr>
        </THead>
        <TBody>
          {shown.map((r) => (
            <Tr key={r.key}>
              <Td rowHeader>
                {r.id ? (
                  <Link href={`${base}/results/${r.key}`} className="font-medium text-navy-700 underline underline-offset-2">
                    {r.case_key} {r.title}
                    <span className="sr-only"> ({r.key} result)</span>
                  </Link>
                ) : (
                  <span>
                    {r.case_key} {r.title}
                  </span>
                )}
                {!r.retried && <span className="block text-caption text-fg-muted">Not retried</span>}
              </Td>
              <Td>
                {BROWSER_TEXT[r.browser] ?? r.browser} · {sizeText(r.viewport)}
              </Td>
              <Td>
                <ResultStatus status={r.status} reason={r.reason ?? r.error_reason} />
                {r.defect && (
                  <span className="mt-1 block text-caption text-fg-muted">
                    {r.defect.key} {r.defect.status}
                  </span>
                )}
              </Td>
              <Td className="tabular-nums">{r.attempts ? (r.attempts > 1 || r.status === "running" ? `${r.attempts} of 2` : "1") : "–"}</Td>
              <Td className="tabular-nums">{r.duration_ms !== null ? fmtDuration(r.duration_ms) : "–"}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function RunPage() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { runKey } = useParams<{ runKey: string }>();
  const key = decodeURIComponent(runKey);
  const [active, setActive] = useState(true);
  const q = useApi<RunDetail>(`/projects/${p.id}/execution-runs/by-key/${key}`, undefined, {
    refreshInterval: active ? 2000 : 0,
    shouldRetryOnError: false,
  });
  const run = q.data;
  const analysing = run?.analysis?.status === "queued" || run?.analysis?.status === "running";
  useEffect(() => {
    // Manual runs are never analysed and don't change by themselves (P4-14): no polling.
    if (run) setActive(run.mode !== "manual" && (isActive(run.status) || run.status === "awaiting_authorisation" || analysing || (["failed", "passed"].includes(run.status) && !run.analysis && run.tests_rows.some((r) => ["failed", "error", "flaky"].includes(r.status)))));
  }, [run, analysing]);
  const view = params.get("view") === "scope" ? "scope" : "results";
  const filter = (params.get("filter") as Filter | null) ?? "all";
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const prev = useRef<RunDetail | null>(null);

  useEffect(() => {
    document.title = `${key} · Test Execution · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [key, p.project?.name]);

  // Polite milestones only (§8.4): start, each failure, every 25 %, the end.
  useEffect(() => {
    if (!run) return;
    const before = prev.current;
    prev.current = run;
    if (!before || before.id !== run.id) return;
    const said: string[] = [];
    if (before.status !== "running" && run.status === "running") said.push(`${run.key} started`);
    said.push(...milestones(before.tests_rows, run.tests_rows));
    if (isActive(before.status) && ["passed", "failed", "error", "cancelled"].includes(run.status)) said.push(finishedAnnouncement(run.key, run.totals));
    if (said.length) setAnnouncement(said.join(". "));
  }, [run]);

  const base = `/projects/${p.id}/execution/${key}`;
  const go = (next: { view?: string; filter?: string }) =>
    router.push(`${base}${buildQuery({ view: (next.view ?? view) === "scope" ? "scope" : undefined, filter: (next.filter ?? filter) === "all" ? undefined : (next.filter ?? filter) })}`, { scroll: false });

  async function cancel() {
    if (!run) return;
    setCancelling(true);
    try {
      const r = await api<{ message: string; run: RunDetail }>(`/execution-runs/${run.id}/cancel`, { method: "POST" });
      await q.mutate(r.run, { revalidate: false });
      toast(r.message, "success");
      p.refresh();
      setCancelOpen(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t cancel. Try again.", "error");
    } finally {
      setCancelling(false);
    }
  }
  async function rerun(only: "failed" | "all") {
    if (!run) return;
    setRerunBusy(true);
    try {
      const r = await api<RunDetail>(`/execution-runs/${run.id}/rerun`, { method: "POST", body: { only } });
      toast(`${r.key} requested. Someone who can approve gates must authorise it.`, "success");
      p.refresh();
      router.push(`/projects/${p.id}/execution/${r.key}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t request the run. Try again.", "error");
    } finally {
      setRerunBusy(false);
    }
  }

  const back = (
    <Link href={`/projects/${p.id}/execution`} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Test Execution
    </Link>
  );
  const rows = useMemo(() => run?.tests_rows ?? [], [run]);

  if (q.error && !run) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return <EmptyState title={`We couldn’t find ${key} in this project.`} action={<LinkButton href={`/projects/${p.id}/execution`}>Back to Test Execution</LinkButton>} />;
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={q.error} title={`Couldn’t load ${key}.`} message="Try again." onRetry={() => void q.mutate()} />
      </div>
    );
  }
  if (!run)
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );

  // Manual runs (P4-14 §4.3): results recorded by hand, nothing ran on the platform.
  if (run.mode === "manual")
    return (
      <div className="space-y-6">
        {back}
        <ManualRunView run={run} projectId={p.id} />
      </div>
    );

  const state = runStateCopy(run);
  const auth = authorisationLine(run);
  const failedCount = rows.filter((r) => r.status === "failed" || r.status === "error").length;
  const progress = progressSentence(rows);
  const finished = ["passed", "failed", "error", "cancelled"].includes(run.status) && !!run.started_at;
  const chromium = run.browsers.includes("chromium");
  const canRequestAgain = run.permissions.can_rerun || run.permissions.is_requester;
  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
              {run.key} · {run.selection_label}
            </h1>
            <RunStatusPill run={run} />
          </div>
          <div className="flex flex-wrap gap-2">
            {run.permissions.can_cancel && (run.status === "running" || run.status === "queued") && (
              <Button variant="secondary" onClick={() => setCancelOpen(true)} loading={cancelling}>
                {cancelling ? "Cancelling…" : "Cancel run…"}
              </Button>
            )}
            {run.permissions.can_rerun && failedCount > 0 && (
              <Button variant="secondary" onClick={() => void rerun("failed")} loading={rerunBusy}>
                Re-run failed tests…
              </Button>
            )}
            <RunMenu projectId={p.id} runKey={run.key} finished={finished} />
          </div>
        </div>
        <p className="text-small text-fg-muted">
          {targetsText(run.browsers, run.viewports)} · {run.tests} {run.tests === 1 ? "test" : "tests"} · requested by {run.requested_by?.full_name || run.requested_by?.email || "someone"}
          {auth && run.authorisation?.decision === "approve" ? ` · ${auth.charAt(0).toLowerCase()}${auth.slice(1)}, ${fmtDateTime(run.authorisation.at)}` : ""}
          {run.finished_at && run.duration_ms !== null ? ` · ${fmtDuration(run.duration_ms)}` : ""}
        </p>
        {run.notes && <p className="text-small text-fg">Note: &quot;{run.notes}&quot;</p>}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {run.status === "awaiting_authorisation" && (
        <RunAuthorisationPanel
          run={run}
          onChanged={(r, message) => {
            void q.mutate(r, { revalidate: false });
            toast(message, "success");
            p.refresh();
          }}
          onWithdraw={() => void cancel()}
          onRequestAgain={() => void rerun("all")}
        />
      )}
      {state && (
        <Callout
          tone={state.tone}
          title={state.title}
          actions={
            (run.status === "rejected" || /expired/i.test(run.error ?? "")) && canRequestAgain ? (
              <Button variant="secondary" onClick={() => void rerun("all")}>
                Request again
              </Button>
            ) : run.status === "error" && run.permissions.can_rerun ? (
              <Button variant="secondary" onClick={() => void rerun("all")}>
                Re-run all…
              </Button>
            ) : undefined
          }
        />
      )}
      {run.status === "running" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-body font-medium text-fg-strong">Progress {progress.text}</p>
            <div aria-hidden className="h-2 w-48 overflow-hidden rounded-full bg-overlay">
              <div className="h-full bg-info-solid" style={{ width: `${progress.total ? (progress.finished / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
          <LiveRunView runId={run.id} chromium={chromium} />
        </div>
      )}

      {run.status !== "awaiting_authorisation" && run.status !== "rejected" && (
        <div>
          <Tabs
            tabs={[
              { id: "results", label: `Results (${rows.length})` },
              { id: "scope", label: "Authorisation & scope" },
            ]}
            value={view}
            onChange={(v) => go({ view: v })}
            label="Run views"
            idPrefix="run"
          />
          <TabPanel id={view} idPrefix="run">
            {view === "results" ? (
              <div className="space-y-4">
                {finished && run.status !== "cancelled" && <p className="text-body text-fg">{finishedSentence(run.totals)}</p>}
                {finished && <WhatFailedCard run={run} projectId={p.id} />}
                {rows.length ? <TestsTable rows={rows} base={base} filter={filter} setFilter={(f) => go({ filter: f })} /> : <EmptyState title="No tests in this run." />}
              </div>
            ) : (
              <ScopeTab run={run} />
            )}
          </TabPanel>
        </div>
      )}
      {run.status === "rejected" && run.scope && <AuthorisationSummary scope={run.scope} />}
      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={() => void cancel()} title={`Cancel ${run.key}?`} confirmLabel="Cancel run" cancelLabel="Keep running" danger loading={cancelling}>
        Tests that have finished keep their results. The {rows.filter((r) => r.status === "running" || r.status === "waiting").length} unfinished tests are marked &apos;Error: run cancelled&apos;. A cancelled run can&apos;t be resumed.
      </ConfirmDialog>
    </div>
  );
}

function ScopeTab({ run }: { run: RunDetail }) {
  const auth = authorisationLine(run);
  return (
    <div className="space-y-4">
      {auth && (
        <p className="text-body text-fg">
          {auth} · {run.authorisation ? fmtDateTime(run.authorisation.at) : ""}
          {run.authorisation?.comment ? ` · '${run.authorisation.comment}'` : ""}
        </p>
      )}
      {run.scope ? <AuthorisationSummary scope={run.scope} /> : <p className="text-body text-fg-muted">No scope was recorded.</p>}
      {run.approvals.length > 0 && (
        <div>
          <h3 className="text-body font-semibold text-fg-strong">Separate approvals</h3>
          <ul className="mt-1 space-y-1 text-body text-fg">
            {run.approvals.map((a) => (
              <li key={a.id}>
                {a.key} · {a.title} · {a.status === "approved" || a.status === "used" ? "Approved" : a.status === "rejected" ? "Not approved" : a.status === "expired" ? "Expired" : "Waiting for decision"}
                {a.decided_by ? ` by ${a.decided_by.full_name || a.decided_by.email}` : ""}
                {a.status === "approved" || a.status === "used" ? ", who typed the site name to confirm" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-small text-fg-muted">
        Configuration: {run.config.workers ?? 2} workers · {run.config.retries ?? 1} retry · {run.config.test_timeout_s ?? 60} s per test
      </p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RunPage />
    </Suspense>
  );
}
