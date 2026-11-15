"use client";

// Load test page (design P5 §9.4–9.6): the approval while waiting, the live numbers while running (pausable,
// WCAG 2.2.2) with Stop now, and the results when finished: plain-language paragraph first, thresholds and per-page
// tables, then charts that each have an equivalent table. Numbers come from the load generator via the API.

import { RemovedEvidence } from "@/components/domain/RemovedEvidence";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { api, ApiError, downloadFile, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import {
  countText,
  deltaText,
  durationShort,
  isActiveRun,
  KILL_SWITCH_LINE,
  liveMilestone,
  liveProgress,
  measuredText,
  msText,
  NO_DRAFT_ABORTED,
  PERCENTILE_HELP,
  pctText,
  resultParagraph,
  runDefectGroups,
  runStatusLabel,
  thresholdLimit,
  thresholdMeasure,
  thresholdScope,
  thresholdSource,
  type LoadRun,
  type SeriesPoint,
} from "@/lib/nonfunctional";
import { Button, Callout, ConfirmDialog, Disclosure, ErrorState, Segmented, Skeleton, StatTile, Table, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { HypothesisLabel, ObservedLabel } from "@/components/domain/ExecutionLabels";
import { HonestyNote, LoadRunStatusPill, ThresholdResultLabel } from "@/components/domain/NonFunctionalLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { LimitsTable, LoadApprovalPanel } from "./LoadApproval";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

// ------------------------------------------------------------------ chart with a table one control away (§9.6, §18)

type Series = { key: keyof SeriesPoint; label: string; unit: "ms" | "rps" | "count" };
export function MetricChart({ id, title, caption, points, series, threshold }: { id: string; title: string; caption: string; points: SeriesPoint[]; series: Series; threshold?: number }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : series.unit === "ms" ? msText(v) : series.unit === "rps" ? `${v.toFixed(1)}` : String(v));
  const rows = points.length > 300 ? bucket(points, 5) : points;
  return (
    <figure className="min-w-0 space-y-2 overflow-hidden rounded-lg bg-surface p-4 ring-1 ring-line" aria-labelledby={`${id}-cap`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-semibold text-fg-strong">{title}</h3>
        <Segmented
          label={`${title}: show as`}
          value={mode}
          onChange={setMode}
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
        />
      </div>
      {mode === "chart" ? (
        <div aria-hidden className="h-56 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart accessibilityLayer={false} data={points} margin={{ top: 8, right: 56, bottom: 4, left: 8 }}>
              <CartesianGrid stroke="#E4E7EC" strokeDasharray="3 3" />
              <XAxis dataKey="t" tickFormatter={(t: number) => `${t}s`} stroke="#475467" fontSize={12} />
              <YAxis stroke="#475467" fontSize={12} width={56} tickFormatter={(v: number) => fmt(v)} />
              {threshold !== undefined && <ReferenceLine y={threshold} stroke="#B42318" strokeDasharray="6 4" label={{ value: `Threshold ${msText(threshold)}`, position: "right", fill: "#B42318", fontSize: 12 }} />}
              <Line type="monotone" dataKey={series.key as string} stroke="#1F3A68" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Table label={`${title} as a table`} className="max-h-72">
          <THead>
            <tr>
              <Th>Second</Th>
              <Th>{series.label}</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((p) => (
              <tr key={p.t}>
                <Td rowHeader>{p.t} s</Td>
                <Td>{fmt(p[series.key] as number | null | undefined)}</Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      <figcaption id={`${id}-cap`} className="text-small text-fg-muted">
        {caption}
        {mode === "table" && points.length > 300 && " Shown in 5-second buckets."}
      </figcaption>
    </figure>
  );
}

function bucket(points: SeriesPoint[], size: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    const avg = (k: keyof SeriesPoint) => {
      const xs = chunk.map((p) => p[k]).filter((x): x is number => typeof x === "number");
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    out.push({ t: chunk[0].t, users: avg("users") ?? undefined, rps: avg("rps") ?? undefined, errors: avg("errors") ?? undefined, p95_ms: avg("p95_ms") });
  }
  return out;
}

function trendCaption(points: SeriesPoint[], key: keyof SeriesPoint, what: string, fmt: (n: number) => string): string {
  const xs = points.map((p) => p[key]).filter((x): x is number => typeof x === "number");
  if (xs.length < 2) return `${what}: not enough data to chart.`;
  const max = Math.max(...xs);
  const at = points.find((p) => p[key] === max)?.t ?? 0;
  return `${what} went from ${fmt(xs[0])} to ${fmt(xs[xs.length - 1])}, highest ${fmt(max)} at ${at} s.`;
}

// ------------------------------------------------------------------ live view (§9.5)

function LiveLoadView({ run }: { run: LoadRun }) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState<boolean | null>(null);
  const isPaused = paused ?? reduced;
  const [shown, setShown] = useState(run.live);
  const [shownElapsed, setShownElapsed] = useState(run.elapsed_s);
  const lastShown = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (!isPaused || now - lastShown.current > 5000 && reduced) {
      setShown(run.live);
      setShownElapsed(run.elapsed_s);
      lastShown.current = now;
    }
  }, [run.live, run.elapsed_s, isPaused, reduced]);
  const lim = run.limits?.test;
  const pct = run.planned_s ? Math.min(100, Math.round(((shownElapsed ?? 0) / run.planned_s) * 100)) : 0;
  return (
    <section aria-labelledby="live-title" className="space-y-3 rounded-xl bg-surface p-5 ring-1 ring-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="live-title" className="text-h3 font-semibold text-fg-strong">
          Live numbers
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setPaused(!isPaused)} title="Pauses the screen, not the load test.">
          {isPaused ? "Resume updates" : "Pause updates"}
        </Button>
      </div>
      <p className="text-body text-fg">{liveProgress(shownElapsed, run.planned_s)}</p>
      <div aria-hidden className="h-2 w-full overflow-hidden rounded-full bg-overlay">
        <div className="h-full bg-info-solid" style={{ width: `${pct}%` }} />
      </div>
      {!shown ? (
        <p className="text-body text-fg-muted">Waiting for the first numbers…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile size="sm" label="Virtual users" value={`${shown.users ?? 0} of ${lim?.vus ?? "—"}`} />
          <StatTile size="sm" label="Requests a second" value={`${(shown.rps ?? 0).toFixed(1)}`} hint={`limit ${lim?.rps ?? "—"}`} />
          <StatTile size="sm" label="95 % faster than (p95)" value={msText(shown.p95_ms)} hint="last second" />
          <StatTile size="sm" label="Errors" value={shown.requests ? pctText((shown.errors ?? 0) / shown.requests) : "0 %"} hint="last second" />
        </div>
      )}
      <p className="text-small text-fg-muted">Updated every second · numbers from the load generator · load from the platform&apos;s computer{isPaused ? " · updates paused" : ""}</p>
    </section>
  );
}

// ------------------------------------------------------------------ results (§9.6)

function Results({ run, projectId }: { run: LoadRun; projectId: string }) {
  const toast = useToast();
  const r = run.result ?? {};
  const series = run.timeseries ?? [];
  const judged = run.status === "passed" || run.status === "failed";
  const worstPath = run.threshold_results.find((t) => t.result === "missed" && t.scope === "path") ?? null;
  return (
    <div className="min-w-0 space-y-5">
      {judged && <p className="text-body-lg text-fg-strong [overflow-wrap:anywhere]">{resultParagraph(run)}</p>}
      <Disclosure label="What do p50, p95 and p99 mean?">
        <p className="text-small text-fg">{PERCENTILE_HELP}</p>
      </Disclosure>
      {runDefectGroups(run.defects).map((g) => (
        <p key={g.label} className="text-small text-fg [overflow-wrap:anywhere]">
          {g.label}:{" "}
          {g.items.map((d, i) => (
            <span key={d.key}>
              {i > 0 && ", "}
              <Link href={`/projects/${projectId}/defects/${d.key}`} className="font-medium underline underline-offset-2">
                {d.key}
              </Link>{" "}
              {d.summary}
            </span>
          ))}{" "}
          · Gate 8
        </p>
      ))}
      <section aria-labelledby="th-title" className="space-y-2">
        <h2 id="th-title" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
          Thresholds
        </h2>
        <Table label="Threshold results">
          <THead>
            <tr>
              <Th>Page / scope</Th>
              <Th>Measure</Th>
              <Th>Threshold</Th>
              <Th>Measured</Th>
              <Th>Result</Th>
              <Th>vs {run.previous?.key ?? "previous run"}</Th>
            </tr>
          </THead>
          <TBody>
            {run.threshold_results.map((t) => {
              const delta = deltaText(t, run.previous ?? null);
              return (
                <Tr key={`${t.metric}|${t.path ?? "all"}`}>
                  <Td rowHeader>{thresholdScope(t)}</Td>
                  <Td>{thresholdMeasure(t)}</Td>
                  <Td>
                    {thresholdLimit(t)} <span className="block text-small text-fg-muted">{thresholdSource(t)}</span>
                  </Td>
                  <Td>{measuredText(t)}</Td>
                  <Td>
                    <ThresholdResultLabel result={t.result} />
                  </Td>
                  <Td>
                    <span aria-hidden>{delta.text}</span>
                    <span className="sr-only">{delta.sr}</span>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </section>
      {(r.targets?.length ?? 0) > 0 && (
        <section aria-labelledby="pp-title" className="space-y-2">
          <h2 id="pp-title" className="flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Per page <ObservedLabel text={`Measured during ${run.key}`} />
          </h2>
          <Table label="Per page results">
            <THead>
              <tr>
                <Th>Page</Th>
                <Th>Requests</Th>
                <Th>Req/s</Th>
                <Th>p50</Th>
                <Th>p90</Th>
                <Th>p95</Th>
                <Th>p99</Th>
                <Th>Slowest</Th>
                <Th>Errors</Th>
                <Th>Status codes</Th>
              </tr>
            </THead>
            <TBody>
              {r.targets!.map((t) => (
                <Tr key={t.path}>
                  <Td rowHeader>{t.path}</Td>
                  <Td>{countText(t.count)}</Td>
                  <Td>{t.rps?.toFixed(1) ?? "—"}</Td>
                  <Td>{msText(t.latency_ms?.p50)}</Td>
                  <Td>{msText(t.latency_ms?.p90)}</Td>
                  <Td>{msText(t.latency_ms?.p95)}</Td>
                  <Td>{msText(t.latency_ms?.p99)}</Td>
                  <Td>{msText(t.latency_ms?.max)}</Td>
                  <Td>{pctText(t.error_rate)}</Td>
                  <Td>
                    {Object.entries(t.status_codes ?? {})
                      .map(([c, n]) => `${c}: ${n}`)
                      .join(", ") || "—"}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}
      {run.timeseries_removed && (
        <section aria-labelledby="ot-title" className="space-y-3">
          <h2 id="ot-title" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Over time
          </h2>
          <RemovedEvidence text={run.timeseries_removed} />
        </section>
      )}
      {series.length > 0 && (
        <section aria-labelledby="ot-title" className="space-y-3">
          <h2 id="ot-title" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Over time
          </h2>
          <MetricChart
            id="chart-p95"
            title="Response time (p95)"
            caption={trendCaption(series, "p95_ms", "p95 of all requests", (n) => msText(n))}
            points={series}
            series={{ key: "p95_ms", label: "p95", unit: "ms" }}
            threshold={worstPath?.value}
          />
          <MetricChart id="chart-rps" title="Requests a second" caption={trendCaption(series, "rps", "Requests a second", (n) => n.toFixed(1))} points={series} series={{ key: "rps", label: "Requests a second", unit: "rps" }} />
          <MetricChart id="chart-err" title="Errors" caption={trendCaption(series, "errors", "Errors a second", (n) => String(n))} points={series} series={{ key: "errors", label: "Errors", unit: "count" }} />
        </section>
      )}
      <section aria-labelledby="rd-title" className="space-y-2 text-small text-fg">
        <h2 id="rd-title" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
          Run details
        </h2>
        <p>
          Engine: built-in load generator {run.engine.version ?? ""} · Load from the platform&apos;s computer · Approval {run.approval?.key ?? "—"} · Not signed in · GET only
        </p>
        {run.limits && <LimitsTable {...run.limits} />}
      </section>
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <Button variant="secondary" size="sm" onClick={() => downloadFile(`/performance-runs/${run.id}/k6-script`, `${run.key}-k6.js`).catch((e) => toast(errorMessage(e), "error"))} aria-label={`Download k6 script for ${run.key}`}>
          Download k6 script
        </Button>
        Not run by the platform.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ page

// SWR asks for the interval once when polling starts, before any data: keep polling until a finished run says stop.
const pollInterval = (d: LoadRun | undefined) => (!d || d.status === "running" ? 1000 : isActiveRun(d) || d.status === "awaiting_approval" ? 3000 : 0);

export function LoadTestPage({ runKey }: { runKey: string }) {
  const p = useProject();
  const toast = useToast();
  const { canApprove, role } = useAuth();
  // Live tiles update at least every 2 s (design check 22). The interval function is module-level so SWR's polling
  // effect isn't restarted on every render, and dedupe is shorter than the interval so each tick really fetches.
  const q = useApi<LoadRun>(`/projects/${p.id}/performance-runs/by-key/${runKey}`, undefined, { refreshInterval: pollInterval, dedupingInterval: 500 });
  const run = q.data;
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [slow, setSlow] = useState(false);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const prev = useRef<{ status: string | null; pct: number }>({ status: null, pct: 0 });
  useEffect(() => {
    document.title = `${runKey} · Non-functional · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [runKey, p.project?.name]);
  // Milestones only (§9.5): start, 25/50/75 %, kill switch, end. Never per tick.
  useEffect(() => {
    if (!run) return;
    const pct = run.planned_s ? Math.round(((run.elapsed_s ?? 0) / run.planned_s) * 100) : 0;
    const was = prev.current.status;
    if (was && was !== run.status) {
      if (run.status === "running") setPolite(`${run.key} started`);
      else if (run.status === "aborted") setAssertive(`${run.key} ${run.aborted_reason ?? "stopped automatically"}`);
      else if (run.status === "passed" || run.status === "failed") {
        const met = run.threshold_results.filter((t) => t.result === "met").length;
        setPolite(`${run.key} finished: ${met} of ${run.threshold_results.length} thresholds met`);
      } else if (run.status === "stopped") setPolite(`${run.key} stopped`);
    } else if (run.status === "running") {
      const m = liveMilestone(prev.current.pct, pct);
      if (m) setPolite(`${run.key}: ${m} % done`);
    }
    prev.current = { status: run.status, pct };
    if (!isActiveRun(run)) {
      setStopping(false);
      setSlow(false);
    }
  }, [run]);

  async function stop() {
    if (!run) return;
    setStopping(true);
    setStopOpen(false);
    try {
      await api(`/performance-runs/${run.id}/stop`, { method: "POST" });
      toast(`${run.key} stopped.`, "success");
      setTimeout(() => setSlow(true), 5000);
      q.mutate();
    } catch (e) {
      setStopping(false);
      toast(errorMessage(e), "error");
    }
  }

  const back = (
    <Link href={`/projects/${p.id}/non-functional?tab=performance`} className="inline-flex items-center gap-1 text-small font-medium text-fg-muted hover:text-fg-strong">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Non-functional
    </Link>
  );
  if (q.error && !run)
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={q.error} title={q.error instanceof ApiError && q.error.status === 404 ? `We couldn't find ${runKey} in this project.` : "Couldn't load this load test."} onRetry={() => q.mutate()} />
      </div>
    );
  if (!run)
    return (
      <div className="space-y-4">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64" />
      </div>
    );
  const a = run.approval;
  const viewer = role === "viewer" || role === null;
  return (
    <div className="space-y-5 pb-20 md:pb-0">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 tabIndex={-1} data-page-title className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {run.key} · {run.profile.key} v{run.profile.version} · {run.status === "running" ? "Running" : run.profile.type.charAt(0).toUpperCase() + run.profile.type.slice(1)}
          </h1>
          <LoadRunStatusPill run={run} />
        </div>
        {run.permissions.can_stop && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface p-3 md:static md:border-0 md:bg-transparent md:p-0">
            <Button variant="danger" className="w-full md:w-auto" onClick={() => setStopOpen(true)} loading={stopping} disabled={run.stop_requested && !stopping}>
              {stopping || run.stop_requested ? "Stopping…" : "Stop now"}
            </Button>
          </div>
        )}
      </div>
      <p className="text-small text-fg-muted">
        {fmtDateTime(run.started_at ?? run.created_at)}
        {run.elapsed_s ? ` · ${durationShort(run.elapsed_s)}` : ""}
        {run.result?.overall ? ` · ${countText(run.result.overall.count)} requests` : ""}
        {run.requested_by?.full_name ? ` · requested by ${run.requested_by.full_name}` : ""}
        {a?.decided_by?.full_name && a.status !== "rejected" ? ` · approved by ${a.decided_by.full_name}${a.host_typed ? " (host typed)" : ""}` : ""}
      </p>
      <HonestyNote>{run.statement}</HonestyNote>
      {["passed", "failed", "stopped", "aborted"].includes(run.status) && (
        <p className="text-small">
          <Link href={`/projects/${p.id}/reports/performance?run=${run.key}`} className="font-medium text-navy-700 underline underline-offset-2">
            Open the Performance Report for {run.key}
          </Link>
        </p>
      )}
      <p role="status" className="sr-only">
        {polite}
      </p>
      <p role="alert" className="sr-only">
        {assertive}
      </p>
      {slow && isActiveRun(run) && <Callout tone="warning">Still stopping… the load generator is being shut down.</Callout>}
      {run.status === "awaiting_approval" && <LoadApprovalPanel run={run} onDone={() => q.mutate()} canApproveRole={canApprove && !viewer} pages={run.profile_snapshot?.targets.length ?? 0} />}
      {run.status === "rejected" && (
        <Callout tone="neutral">
          Not approved by {a?.decided_by?.full_name ?? "someone"}: &lsquo;{a?.comment}&rsquo;. Nothing was sent to the site.
        </Callout>
      )}
      {run.status === "expired" && <Callout tone="neutral">This request expired after 24 hours. Nothing was sent to the site.</Callout>}
      {run.status === "queued" && <Callout tone="info">Waiting to start. Load tests run one at a time in your workspace and never beside a test run on this project.</Callout>}
      {a && a.status !== "pending" && a.decided_by && a.status !== "rejected" && (
        <p className="text-small text-fg">
          {run.requested_by?.id && run.requested_by.id === a.decided_by.id ? "Requested and approved" : "Approved"} by {a.decided_by.full_name} · {fmtDateTime(a.decided_at)} · host typed: {a.host_typed ? "yes" : "no"}
        </p>
      )}
      {run.status === "running" && <LiveLoadView run={run} />}
      {run.status === "aborted" && (
        <Callout tone="warning" title={`${run.aborted_reason ?? "Stopped automatically"}.`}>
          <p>{KILL_SWITCH_LINE}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            Possible causes <HypothesisLabel />: the site or the network is overloaded, or the site is down.
          </p>
          <p className="mt-1">{NO_DRAFT_ABORTED}</p>
        </Callout>
      )}
      {run.status === "stopped" && (
        <Callout tone="neutral">
          {runStatusLabel(run)} at {durationShort(run.elapsed_s)}. Measurements cover the first {durationShort(run.elapsed_s)} and aren&apos;t judged against thresholds.
        </Callout>
      )}
      {run.status === "error" && <Callout tone="danger">The load test didn&apos;t complete: {run.error}. No load is being sent.</Callout>}
      {["passed", "failed", "stopped", "aborted", "error"].includes(run.status) && <Results run={run} projectId={p.id} />}
      <ConfirmDialog
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        onConfirm={stop}
        danger
        title={`Stop ${run.key} now?`}
        confirmLabel="Stop now"
        cancelLabel="Keep running"
        focusConfirm
      >
        <p>Load stops within 2 seconds. Results so far are kept and marked Stopped. A stopped load test can&apos;t be resumed.</p>
      </ConfirmDialog>
    </div>
  );
}
