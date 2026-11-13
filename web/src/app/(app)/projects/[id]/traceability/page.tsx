"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import useSWR from "swr";
import { api, buildQuery } from "@/lib/api";
import type { BackwardRow, ForwardRow, Page } from "@/lib/contract";
import { fmtDate, timeAgo } from "@/lib/format";
import { CASE_STATUS_TEXT, RISK_LEVEL_TEXT } from "@/lib/testcases";
import { g5SnapshotExists, parseTraceFilters, traceApiQuery, traceFiltersToQuery, type TraceFilters } from "@/lib/traceability";
import { useAuth } from "@/lib/auth";
import { Button, Callout, Checkbox, EmptyState, ErrorState, LinkButton, Segmented, SelectField, Skeleton, TabPanel, Tabs } from "@/components/ui";
import { OutOfDateCallout } from "@/components/domain/OutOfDateCallout";
import { useProject } from "@/components/workspace/ProjectContext";
import { requirementsStages } from "@/components/requirements/hooks";
import { useCoverage, useGaps } from "@/components/testcases/hooks";
import { BackwardMatrix, CoverageTiles, ForwardMatrix, GapLists } from "@/components/traceability/Traceability";

const VIEWS = ["coverage", "matrix"] as const;
type View = (typeof VIEWS)[number];

/** Basis switch: "Last approved" is disabled with a visible reason until Gate 5 has been approved (§14.1). */
function BasisSwitch({ value, onChange, approvedAvailable }: { value: "current" | "approved"; onChange: (v: "current" | "approved") => void; approvedAvailable: boolean }) {
  const opt = (v: "current" | "approved", label: string, disabled: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === v}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? "basis-hint" : undefined}
      onClick={() => !disabled && onChange(v)}
      className={`min-h-8 rounded-sm px-3 py-1 text-small font-medium ${value === v ? "bg-surface font-semibold text-fg-strong shadow-xs ring-1 ring-line-strong" : disabled ? "cursor-not-allowed text-fg-muted" : "text-fg-muted hover:text-fg-strong"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-1">
      <p className="text-body font-medium text-fg-strong">Basis</p>
      <div role="radiogroup" aria-label="Basis" className="inline-flex flex-wrap rounded-md bg-overlay p-0.5">
        {opt("current", "Current version", false)}
        {opt("approved", "Last approved (Gate 5)", !approvedAvailable)}
      </div>
      {!approvedAvailable && (
        <p id="basis-hint" className="text-small text-fg-muted">
          Available after Gate 5 is approved.
        </p>
      )}
    </div>
  );
}

function Matrix({ projectId, f, set }: { projectId: string; f: TraceFilters; set: (f: TraceFilters) => void }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  useEffect(() => setCursors([null]), [f.dir, f.basis, f.status, f.risk, f.uncovered]);
  const cursor = cursors[cursors.length - 1];
  const key = `/projects/${projectId}/traceability${buildQuery(traceApiQuery(f, cursor))}`;
  const page = useSWR<Page<ForwardRow | BackwardRow>>(key, () => api(`/projects/${projectId}/traceability`, { query: traceApiQuery(f, cursor) }), { revalidateOnFocus: false });
  const rows = page.data?.items ?? [];
  const more = cursors.length > 1 || !!page.data?.next_cursor;
  const filtered = !!(f.status || f.risk || f.uncovered);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <p className="text-body font-medium text-fg-strong">Direction</p>
          <Segmented
            label="Direction"
            value={f.dir}
            onChange={(dir) => set({ ...f, dir, status: "" })}
            options={[
              { value: "forward", label: "Forward: requirement → test case" },
              { value: "backward", label: "Backward: test case → requirement" },
            ]}
          />
        </div>
        <SelectField
          label="Status"
          value={f.status}
          onChange={(e) => set({ ...f, status: e.target.value })}
          wrapClassName="w-full sm:w-44"
          options={
            f.dir === "forward"
              ? [
                  { value: "", label: "Any" },
                  { value: "approved", label: "Approved" },
                  { value: "draft", label: "Draft" },
                ]
              : [{ value: "", label: "Any" }, ...(["draft", "approved", "rejected", "deprecated"] as const).map((s) => ({ value: s, label: CASE_STATUS_TEXT[s] }))]
          }
        />
        <SelectField
          label="Risk level"
          value={f.risk}
          onChange={(e) => set({ ...f, risk: e.target.value })}
          wrapClassName="w-full sm:w-44"
          options={[{ value: "", label: "Any" }, ...(["very_high", "high", "medium", "low"] as const).map((r) => ({ value: r, label: RISK_LEVEL_TEXT[r] }))]}
        />
        <Checkbox label="Only gaps" checked={f.uncovered} onChange={(e) => set({ ...f, uncovered: e.target.checked })} />
      </div>
      {page.error && !page.data ? (
        <ErrorState error={page.error} title="Couldn’t load traceability." message="Try again." onRetry={() => void page.mutate()} />
      ) : !page.data ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No rows match these filters." : "No rows yet."}
          action={
            filtered ? (
              <Button variant="secondary" onClick={() => set({ ...f, status: "", risk: "", uncovered: false })}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : f.dir === "forward" ? (
        <ForwardMatrix rows={rows as ForwardRow[]} projectId={projectId} more={more} />
      ) : (
        <BackwardMatrix rows={rows as BackwardRow[]} projectId={projectId} more={more} />
      )}
      {(cursors.length > 1 || page.data?.next_cursor) && (
        <nav aria-label="Matrix pages" className="flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={cursors.length <= 1} onClick={() => setCursors(cursors.slice(0, -1))}>
            Previous page
          </Button>
          <span className="tabular-nums text-fg-muted">Page {cursors.length}</span>
          <Button variant="secondary" disabled={!page.data?.next_cursor} onClick={() => setCursors([...cursors, page.data!.next_cursor])}>
            Next page
          </Button>
        </nav>
      )}
    </div>
  );
}

function TraceabilityScreen() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const { role } = useAuth();
  const requested = params.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "coverage";
  const f = useMemo(() => parseTraceFilters(params), [params]);
  const stages = requirementsStages(p.workflow);
  const designed = !!stages.design?.current_version;
  // `Coverage.approved_at` (both bases) is set once Gate 5 was ever approved; the gate state covers older APIs.
  const current = useCoverage(p.id, "current", designed);
  const snapshotExists = !!current.data?.approved_at || g5SnapshotExists(stages.g5?.gate);
  const basis = snapshotExists ? f.basis : "current";
  const approvedCov = useCoverage(p.id, "approved", designed && basis === "approved");
  const coverage = basis === "approved" ? approvedCov : current;
  const gaps = useGaps(p.id, basis, designed && view === "coverage");

  useEffect(() => {
    document.title = `Traceability · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  function go(next: { view?: View; f?: TraceFilters }) {
    const q = buildQuery({ view: (next.view ?? view) === "coverage" ? undefined : (next.view ?? view), ...traceFiltersToQuery(next.f ?? f) });
    router.push(`/projects/${p.id}/traceability${q}`, { scroll: false });
  }
  const href = (q: Record<string, string>) => `/projects/${p.id}/traceability${buildQuery(q)}`;
  const casesHref = (q: Record<string, string>) => `/projects/${p.id}/test-cases${buildQuery(q)}`;

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          Traceability
        </h1>
        {designed && (
          <div className="flex flex-wrap items-end gap-3">
            <BasisSwitch value={basis} approvedAvailable={snapshotExists} onChange={(b) => go({ f: { ...f, basis: b } })} />
            <LinkButton href={`/projects/${p.id}/reports/rtm`} variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />}>
              Open RTM report
            </LinkButton>
          </div>
        )}
      </div>
      {designed && (
        <p className="text-small text-fg-muted">
          {basis === "approved"
            ? `Showing the set approved at Gate 5${coverage.data?.approved_at ? ` on ${fmtDate(coverage.data.approved_at)}` : stages.g5?.finished_at ? ` on ${fmtDate(stages.g5.finished_at)}` : ""}.`
            : `Computed from Requirements v${stages.req?.current_version ?? "?"} · Test design run ${coverage.data?.design_version ?? stages.design?.current_version ?? "?"}${stages.design?.finished_at ? ` · updated ${timeAgo(stages.design.finished_at)}` : ""}`}
        </p>
      )}
      <p className="text-small text-fg-muted">Traceability is read-only. Its links go to the items, where they can be edited.</p>
    </div>
  );

  if (!designed)
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="Traceability is built when test cases are designed. Approve Gate 4 and design test cases first."
          action={<LinkButton href={`/projects/${p.id}/test-cases`}>Go to Test Cases</LinkButton>}
        />
      </div>
    );

  return (
    <div className="space-y-6">
      {header}
      {stages.design?.status === "stale" && (
        <OutOfDateCallout title="Traceability is out of date" actions={<LinkButton href={`/projects/${p.id}/test-cases`}>Go to Test Cases</LinkButton>}>
          Traceability reflects test design run {stages.design.current_version}, which is out of date. Regenerate test cases to update it.
        </OutOfDateCallout>
      )}
      <div>
        <Tabs
          tabs={[
            { id: "coverage", label: "Coverage & gaps" },
            { id: "matrix", label: "Matrix" },
          ]}
          value={view}
          onChange={(v) => go({ view: v as View })}
          label="Traceability views"
          idPrefix="trace"
        />
        <TabPanel id={view} idPrefix="trace">
          {view === "coverage" ? (
            coverage.error && !coverage.data ? (
              <ErrorState error={coverage.error} title="Couldn’t load traceability." message="Try again." onRetry={() => void coverage.mutate()} />
            ) : !coverage.data ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
                {Array.from({ length: 7 }, (_, i) => (
                  <Skeleton key={i} className="h-28" />
                ))}
              </div>
            ) : (
              <div className="space-y-6">
                <h2 className="sr-only">Coverage</h2>
                <CoverageTiles coverage={coverage.data} href={href} casesHref={casesHref} />
                {gaps.data ? <GapLists gaps={gaps.data} projectId={p.id} canEdit={role !== "viewer" && role !== null} /> : gaps.error ? <Callout tone="danger">Couldn’t load the gap lists. Try again.</Callout> : <Skeleton className="h-40" />}
              </div>
            )
          ) : (
            <Matrix projectId={p.id} f={{ ...f, basis }} set={(nf) => go({ f: nf })} />
          )}
        </TabPanel>
      </div>
    </div>
  );
}

export default function TraceabilityPage() {
  return (
    <Suspense>
      <TraceabilityScreen />
    </Suspense>
  );
}
