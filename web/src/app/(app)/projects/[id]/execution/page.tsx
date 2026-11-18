"use client";

// Test Execution (design P4 §8.1, P6 §9.1): tabs Runs and Exploratory. `?new=1` opens the Run tests dialog;
// `&cases=TC-0019,TC-0020` prefills it. `?tab=exploratory` shows the exploratory sessions (`&new=1` opens Explore…).

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import { resultsSentence, targetsText, waitingText, whoText, type RunDetail, type RunList, type RunSummary } from "@/lib/execution";
import { EXPLORE_INTRO, exploreReachable } from "@/lib/exploratory";
import { Button, Callout, EmptyState, ErrorState, LinkButton, SelectField, Skeleton, Table, Tabs, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { RunStatusPill } from "@/components/domain/ExecutionLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { RunDialog, type RunPrefill } from "@/components/execution/RunDialog";
import { ExploratoryTab } from "@/components/exploratory/ExploratoryTab";
import { useSessions } from "@/components/exploratory/hooks";

const STATUS_FILTERS = [
  { value: "", label: "Any status" },
  { value: "awaiting_authorisation", label: "Waiting for authorisation" },
  { value: "queued,running", label: "Waiting to start or running" },
  { value: "passed", label: "Finished with no failures" },
  { value: "failed", label: "Finished with failures" },
  { value: "error,cancelled,rejected", label: "Didn't complete, cancelled or not authorised" },
];

function ResultsCell({ r }: { r: RunSummary }) {
  const t = r.totals;
  const total = r.tests || 1;
  const finished = r.status === "passed" || r.status === "failed" || r.status === "error" || r.status === "cancelled";
  return (
    <div className="space-y-1">
      <p>{finished ? resultsSentence(t, r.tests) : `${r.tests} ${r.tests === 1 ? "test" : "tests"}`}</p>
      {finished && (
        <div aria-hidden className="flex h-1.5 w-32 overflow-hidden rounded-full bg-overlay">
          <span className="bg-success-solid" style={{ width: `${((t.passed ?? 0) / total) * 100}%` }} />
          <span className="bg-warning-solid" style={{ width: `${((t.flaky ?? 0) / total) * 100}%` }} />
          <span className="bg-danger-solid" style={{ width: `${(((t.failed ?? 0) + (t.error ?? 0)) / total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function Runs() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const { role } = useAuth();
  const toast = useToast();
  const viewer = role === "viewer" || role === null;
  const [status, setStatus] = useState("");
  const tab = params.get("tab") === "exploratory" ? "exploratory" : "runs";
  // The Exploratory tab's count of open findings (design P6 §9.1), once exploration is reachable (after G2).
  const sessions = useSessions(p.id, exploreReachable(p.workflow) || tab === "exploratory");
  const openFindings = sessions.data?.items.reduce((n, x) => n + (x.progress?.open_findings ?? 0), 0);
  const list = useApi<RunList>(`/projects/${p.id}/execution-runs`, { status: status || undefined, limit: 100 }, {
    refreshInterval: (d) => (d?.items.some((r) => r.status === "queued" || r.status === "running") ? 3000 : 15000),
  });
  const d = list.data;
  const canRequest = !!d?.permissions.can_request && !viewer;
  const canAuthorise = !!d?.permissions.can_authorise && !viewer;
  const open = params.get("new") === "1" && canRequest;
  const casesParam = params.get("cases");
  const prefill = useMemo<RunPrefill | undefined>(() => (casesParam ? { caseKeys: casesParam.split(",").filter(Boolean) } : undefined), [casesParam]);
  const auto = p.workflow?.stages.find((s) => s.key === "automation");
  const ready = !!auto?.current_version && auto.status !== "awaiting_approval" && auto.status !== "running" && auto.status !== "queued";
  const origin = p.project?.urls?.find((u) => u.role === "primary")?.url ?? p.project?.urls?.[0]?.url;

  useEffect(() => {
    document.title = `Test Execution · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  const setOpen = (v: boolean) => router.push(`/projects/${p.id}/execution${v ? "?new=1" : ""}`, { scroll: false });
  function created(run: RunDetail, authorised: boolean) {
    toast(authorised ? `${run.key} authorised and starting.` : `${run.key} requested. Someone who can approve gates must authorise it.`, "success");
    p.refresh();
    router.push(`/projects/${p.id}/execution/${run.key}`);
  }

  const setTab = (t: string) => router.replace(`/projects/${p.id}/execution${t === "exploratory" ? "?tab=exploratory" : ""}`, { scroll: false });
  const header = (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            Test Execution
          </h1>
          {tab === "runs" && canRequest && ready && <Button onClick={() => setOpen(true)}>Run tests…</Button>}
        </div>
        <p className="text-body text-fg-muted">
          {tab === "exploratory" ? EXPLORE_INTRO : `Runs are started by a person and authorised for each run (Gate 7).${origin ? ` Tests run only on ${origin}.` : ""}`}
        </p>
      </div>
      <Tabs
        label="Test Execution views"
        idPrefix="exec"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "runs", label: "Runs" },
          { id: "exploratory", label: "Exploratory", ...(openFindings ? { count: openFindings } : {}) },
        ]}
      />
    </div>
  );

  if (tab === "exploratory")
    return (
      <div className="space-y-6">
        {header}
        <div role="tabpanel" id="exec-panel-exploratory" aria-labelledby="exec-exploratory">
          <ExploratoryTab />
        </div>
      </div>
    );

  if (list.error && !d)
    return (
      <div className="space-y-6">
        {header}
        <div role="tabpanel" id="exec-panel-runs" aria-labelledby="exec-runs">
          <ErrorState error={list.error} title="Couldn’t load test runs." message="Try again." onRetry={() => void list.mutate()} />
        </div>
      </div>
    );
  if (!d)
    return (
      <div className="space-y-6" aria-busy="true">
        {header}
        <div role="tabpanel" id="exec-panel-runs" aria-labelledby="exec-runs">
          <Skeleton className="h-48" />
        </div>
      </div>
    );

  const waiting = d.items.filter((r) => r.status === "awaiting_authorisation");
  return (
    <div className="space-y-6">
      {header}
      <div role="tabpanel" id="exec-panel-runs" aria-labelledby="exec-runs" className="space-y-6">
        {waiting.length > 0 && (
          <Callout
            tone="warning"
            title={waiting.length === 1 ? waitingText(waiting[0].key, canAuthorise) : `${waiting.length} runs are waiting for authorisation`}
            actions={!viewer ? <LinkButton href={`/projects/${p.id}/execution/${waiting[0].key}`}>Review {waiting[0].key}</LinkButton> : undefined}
          >
            Nothing runs until someone who can approve gates authorises it.
          </Callout>
        )}
        {d.items.length === 0 && !status ? (
          ready ? (
            <EmptyState
              title="No tests have run yet."
              description="Choose which tests to run; you'll see exactly what they'll do on the site before anything starts."
              action={canRequest ? <Button onClick={() => setOpen(true)}>Run tests…</Button> : undefined}
            />
          ) : (
            <EmptyState title="Tests can run once scripts pass their checks (Gate 6)." action={viewer ? undefined : <LinkButton href={`/projects/${p.id}/automation`}>Open Automation</LinkButton>} />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_FILTERS} wrapClassName="w-72" />
            </div>
            {d.items.length === 0 ? (
              <EmptyState title="No runs match this filter." action={<Button variant="secondary" onClick={() => setStatus("")}>Clear filters</Button>} />
            ) : (
              <>
                <div className="hidden md:block">
                  <Table label="Test runs">
                    <THead>
                      <tr>
                        <Th>Run</Th>
                        <Th>What ran</Th>
                        <Th>Status</Th>
                        <Th>Results</Th>
                        <Th>Started by · Authorised by</Th>
                        <Th>When · Duration</Th>
                      </tr>
                    </THead>
                    <TBody>
                      {d.items.map((r) => (
                        <Tr key={r.id}>
                          <Td rowHeader>
                            <Link href={`/projects/${p.id}/execution/${r.key}`} className="font-mono font-medium text-navy-700 underline underline-offset-2" aria-label={`Open ${r.key}`}>
                              {r.key}
                            </Link>
                          </Td>
                          <Td>
                            {r.selection_label}
                            {r.mode === "automated" && <span className="block text-fg-muted">{targetsText(r.browsers, r.viewports).replace(/ 1440 × 900| 390 × 844/g, "")}</span>}
                          </Td>
                          <Td>
                            <RunStatusPill run={r} />
                          </Td>
                          <Td>
                            <ResultsCell r={r} />
                          </Td>
                          <Td>
                            {whoText(r)}
                            {r.status === "awaiting_authorisation" && canAuthorise && (
                              <Link href={`/projects/${p.id}/execution/${r.key}`} className="mt-1 block font-medium text-navy-700 underline underline-offset-2">
                                Review {r.key}
                              </Link>
                            )}
                          </Td>
                          <Td>
                            {fmtDateTime(r.started_at ?? r.created_at)}
                            {r.duration_ms !== null && r.finished_at ? ` · ${fmtDuration(r.duration_ms)}` : ""}
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <ul className="space-y-3 md:hidden" aria-label="Test runs">
                  {d.items.map((r) => (
                    <li key={r.id} className="space-y-1 rounded-lg bg-surface p-4 ring-1 ring-line">
                      <p className="flex flex-wrap items-center gap-2">
                        <Link href={`/projects/${p.id}/execution/${r.key}`} className="font-mono font-medium text-navy-700 underline underline-offset-2">
                          {r.key}
                        </Link>
                        <RunStatusPill run={r} />
                      </p>
                      <p className="text-body text-fg">{r.selection_label}</p>
                      <ResultsCell r={r} />
                      <p className="text-small text-fg-muted">
                        {whoText(r)} · {fmtDateTime(r.started_at ?? r.created_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
      {canRequest && <RunDialog open={open} onClose={() => setOpen(false)} projectId={p.id} canAuthorise={canAuthorise} prefill={prefill} onCreated={created} />}
    </div>
  );
}

export default function ExecutionPage() {
  return (
    <Suspense>
      <Runs />
    </Suspense>
  );
}
