"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Bot, ChevronDown, ChevronRight, FileText, GitCompare, Square, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, fmtDuration, fmtPct, humanize, personName } from "@/lib/format";
import type { TestResult, TestRunDetail } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  StatusPill,
  useToast,
} from "@/components/ui";
import { SummaryBar } from "@/components/domain/Charts";
import { GenerateReportModal } from "@/components/domain/GenerateReportModal";
import { ResultDetail } from "@/components/run/ResultDetail";
import { CompareModal } from "@/components/run/CompareModal";
import { LiveView } from "@/components/run/LiveView";

const ACTIVE = ["QUEUED", "RUNNING"];

function ResultRow({ result, run, onChanged, defaultOpen }: { result: TestResult; run: TestRunDetail; onChanged: () => void; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // Rows appear while the run is still going, so open them once a result says they should be.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const panelId = `result-${result.id}`;
  return (
    <li className="border-b border-line last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-elevated"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />}
        <span className="w-20 shrink-0 font-mono text-xs text-fg-muted">{result.testCaseKey}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-strong">{result.testCaseTitle}</span>
        {result.evidence?.length > 0 && <span className="hidden text-xs text-fg-muted sm:inline">{result.evidence.length} evidence</span>}
        {result.defectId && <Badge tone="red">Defect</Badge>}
        <span className="hidden w-16 text-right text-xs tabular-nums text-fg-muted sm:inline">{fmtDuration(result.durationMs)}</span>
        <StatusPill status={result.status} className="w-28 justify-center" />
      </button>
      {open && (
        <div id={panelId} className="border-t border-line bg-elevated/50 px-4 py-4 sm:px-11">
          <ResultDetail result={result} run={run} onChanged={onChanged} />
        </div>
      )}
    </li>
  );
}

export default function TestRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const toast = useToast();
  const { data: run, error, isLoading, mutate } = useApi<TestRunDetail>(`/test-runs/${id}`, undefined, {
    refreshInterval: (d) => (!d || ACTIVE.includes(d.status) ? 2000 : 0),
  });
  const [modal, setModal] = useState<null | "compare" | "report" | "cancel" | "complete">(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string>("ALL");

  if (error && !run)
    return (
      <Card>
        <ErrorState error={error} onRetry={() => mutate()} />
      </Card>
    );
  if (isLoading || !run) return <LoadingBlock label="Loading test run…" />;

  const active = ACTIVE.includes(run.status);
  const manualInProgress = run.executionType === "MANUAL" && run.status === "IN_PROGRESS";
  const results = run.results || [];
  // Problems first: they are what the reader came for.
  const isProblem = (st: string) => st === "FAILED" || st === "ERROR";
  const shown = (filter === "ALL" ? results : results.filter((r) => r.status === filter)).slice().sort((a, b) => Number(isProblem(b.status)) - Number(isProblem(a.status)));
  const counts = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  const problems = (counts.FAILED || 0) + (counts.ERROR || 0);
  const finished = !active && run.status !== "CANCELLED" && results.length > 0;

  async function action(kind: "cancel" | "complete") {
    setBusy(true);
    try {
      await api(`/test-runs/${id}/${kind}`, { method: "POST" });
      toast(kind === "cancel" ? "Run cancelled" : "Run completed");
      setModal(null);
      await mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumb={
          <span>
            <Link href="/test-runs" className="hover:underline">
              Test runs
            </Link>{" "}
            /{" "}
            <Link href={`/projects/${run.projectId}?tab=runs`} className="hover:underline">
              {run.projectName}
            </Link>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base text-fg-muted">{run.key}</span> {run.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={run.status} label={finished && problems ? `Finished · ${problems} problem${problems === 1 ? "" : "s"}` : undefined} />
            <Badge>{humanize(run.executionType)}</Badge>
            {run.environmentName && <StatusPill status={run.environmentName} dot={false} />}
            <span className="inline-flex items-center gap-1.5 text-xs">
              Initiated by {personName(run.initiatedBy)}
              {run.initiatedByAI && (
                <Badge tone="violet" title="This run was started by the AI assistant">
                  <Bot className="h-3 w-3" aria-hidden /> via AI assistant
                </Badge>
              )}
            </span>
          </span>
        }
        actions={
          <>
            {active && (
              <Button variant="secondary" icon={<Square className="h-4 w-4" aria-hidden />} onClick={() => setModal("cancel")}>
                Cancel run
              </Button>
            )}
            {active && run.executionType === "AUTOMATED" && <LiveView runId={run.id} />}

      {manualInProgress && (
              <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} onClick={() => setModal("complete")}>
                Complete run
              </Button>
            )}
            <Button variant="secondary" icon={<GitCompare className="h-4 w-4" aria-hidden />} onClick={() => setModal("compare")}>
              Compare with…
            </Button>
            <Button variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />} onClick={() => setModal("report")}>
              Report
            </Button>
          </>
        }
      />

      <Card>
        <CardBody className="grid gap-6 lg:grid-cols-[1fr_auto]">
          <div>
            {finished && (
              <div className="mb-4">
                <p className={`text-lg font-semibold ${problems ? "text-red-300" : "text-emerald-300"}`}>
                  {problems
                    ? `${problems} problem${problems === 1 ? "" : "s"} found in ${results.length} check${results.length === 1 ? "" : "s"}`
                    : `All ${results.length} check${results.length === 1 ? "" : "s"} passed`}
                </p>
                <p className="text-sm text-fg-muted">
                  {counts.BLOCKED ? `${counts.BLOCKED} check${counts.BLOCKED === 1 ? "" : "s"} couldn’t run (see Blocked). ` : ""}
                  {problems
                    ? "Each problem below shows what we expected and what actually happened, with screenshots."
                    : "Nothing broke. Run these again after your next change to make sure it stays that way."}
                </p>
              </div>
            )}
            <SummaryBar s={run.summary} />
            {active && (
              <p className="mt-3 text-xs text-fg-muted" role="status">
                Run is {run.status.toLowerCase()} — updating every 2 seconds.
              </p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4 lg:grid-cols-2">
            <div>
              <dt className="text-xs text-fg-muted">Pass rate</dt>
              <dd className="font-semibold text-fg-strong">{fmtPct(run.summary.passRate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Duration</dt>
              <dd className="font-semibold text-fg-strong">{fmtDuration(run.summary.durationMs)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Started</dt>
              <dd className="text-fg-strong">{fmtDateTime(run.startedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Completed</dt>
              <dd className="text-fg-strong">{fmtDateTime(run.completedAt)}</dd>
            </div>
          </dl>
        </CardBody>
        {run.environment && (
          <p className="border-t border-line px-5 py-2.5 text-xs text-fg-muted">
            Target: <span className="font-mono text-fg">{run.environment.baseUrl}</span>
            {run.environment.name === "PRODUCTION" && !run.environment.allowDestructive && " · read-only (destructive actions blocked)"}
          </p>
        )}
      </Card>

      {manualInProgress && (
        <p className="mt-4 rounded-lg bg-sky-500/10 px-4 py-3 text-sm text-sky-200 ring-1 ring-inset ring-sky-500/30">
          Manual run in progress. Expand each test case, record step outcomes and evidence, save the result, then <strong>Complete run</strong>.
        </p>
      )}

      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg-strong">Results ({results.length})</h2>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter results by status">
          {["ALL", "FAILED", "ERROR", "BLOCKED", "PASSED", "NOT_EXECUTED"].map((s) =>
            s === "ALL" || counts[s] ? (
              <button
                key={s}
                type="button"
                aria-pressed={filter === s}
                onClick={() => setFilter(s)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${filter === s ? "bg-accent font-semibold text-on-accent ring-accent" : "bg-elevated text-fg-muted ring-line hover:bg-overlay hover:text-fg-strong"}`}
              >
                {s === "ALL" ? "All" : humanize(s)} {s === "ALL" ? results.length : counts[s]}
              </button>
            ) : null,
          )}
        </div>
      </div>
      <Card>
        {shown.length === 0 ? (
          <EmptyState title={results.length === 0 ? (active ? "Waiting for results…" : "No results recorded") : "No results with this status"} />
        ) : (
          <ul>
            {shown.map((r) => (
              <ResultRow key={r.id} result={r} run={run} onChanged={() => mutate()} defaultOpen={results.length === 1 || (isProblem(r.status) && problems <= 3)} />
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog open={modal === "cancel"} onClose={() => setModal(null)} onConfirm={() => action("cancel")} loading={busy} danger title="Cancel this run?" confirmLabel="Cancel run">
        Tests that have not executed yet will not run.
      </ConfirmDialog>
      <ConfirmDialog open={modal === "complete"} onClose={() => setModal(null)} onConfirm={() => action("complete")} loading={busy} title="Complete manual run?" confirmLabel="Complete run">
        {counts.NOT_EXECUTED ? `${counts.NOT_EXECUTED} test case(s) are still not executed and will be recorded as such. ` : ""}
        Make sure every result is saved before completing.
      </ConfirmDialog>
      <CompareModal open={modal === "compare"} onClose={() => setModal(null)} run={run} />
      <GenerateReportModal open={modal === "report"} onClose={() => setModal(null)} projectId={run.projectId} testRunId={run.id} />
    </>
  );
}
