"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, MoreHorizontal, Plus, SlidersHorizontal, UserPen } from "lucide-react";
import { api, ApiError, buildQuery, errorMessage } from "@/lib/api";
import type { CaseBulkStatusResult, CaseStatus, Suite, TestCaseSummary } from "@/lib/contract";
import {
  BULK_LIMIT,
  CASE_STATUS_TEXT,
  EMPTY_CASE_FILTERS,
  LEVEL_TEXT_CASE,
  PRIORITY_TEXT,
  RISK_LEVEL_TEXT,
  SUITE_TEXT,
  TECHNIQUE_OPTIONS,
  bulkApproveGuard,
  caseFilterChips,
  caseFiltersToQuery,
  caseLevelText,
  caseTypeText,
  clearCaseFilter,
  filterCases,
  groupCases,
  prioritySourceShort,
  skippedSentence,
  techniqueInfo,
  type CaseFilters,
} from "@/lib/testcases";
import { BULK_BAR_PADDING, BulkActionBar, Button, Checkbox, Disclosure, Drawer, EmptyState, FilterChips, InlineError, LinkButton, Modal, Segmented, SelectField, TextField, useToast } from "@/components/ui";
import { ProvenanceLabel, ProvenanceLegend } from "@/components/domain/ObservationLabel";
import { noteGateReopened } from "@/components/requirements/hooks";
import { CaseFlags, CaseStatusPill, LintChip, NotDecided, NotRunYet, PriorityValue, TechniqueLegend } from "./Bits";
import { CaseRejectDialog, DeprecateDialog } from "./Dialogs";
import { claimRouteFocus } from "@/lib/focusReturn";

const PAGE_SIZE = 50;

type Setter = (f: CaseFilters, opts?: { replace?: boolean }) => void;

/** Remembers the row a user opened so returning restores focus and scroll (P3-02 AC, design §19). */
export function rememberRow(projectId: string, key: string) {
  try {
    sessionStorage.setItem(`qa:tc-return:${projectId}`, JSON.stringify({ key, y: window.scrollY }));
  } catch {
    /* storage unavailable */
  }
}

function FilterFields({ f, set, types }: { f: CaseFilters; set: Setter; types: string[] }) {
  return (
    <>
      <SelectField
        label="Status"
        value={f.status}
        onChange={(e) => set({ ...f, status: e.target.value as CaseFilters["status"] })}
        options={[{ value: "", label: "Any except Rejected and Deprecated" }, ...(["draft", "approved", "rejected", "deprecated"] as const).map((s) => ({ value: s, label: CASE_STATUS_TEXT[s] }))]}
      />
      <SelectField
        label="Technique"
        value={f.technique}
        onChange={(e) => set({ ...f, technique: e.target.value as CaseFilters["technique"] })}
        options={[{ value: "", label: "Any" }, ...TECHNIQUE_OPTIONS.map((t) => ({ value: t, label: techniqueInfo(t).name }))]}
      />
      <SelectField label="Type" value={f.type} onChange={(e) => set({ ...f, type: e.target.value })} options={[{ value: "", label: "Any" }, ...types.map((t) => ({ value: t, label: caseTypeText(t) }))]} />
      <SelectField
        label="Priority"
        value={f.priority}
        onChange={(e) => set({ ...f, priority: e.target.value as CaseFilters["priority"] })}
        options={[{ value: "", label: "Any" }, ...(["critical", "high", "medium", "low"] as const).map((p) => ({ value: p, label: PRIORITY_TEXT[p] }))]}
      />
    </>
  );
}

function MoreFilters({ f, set, levels, reqKeys, features }: { f: CaseFilters; set: Setter; levels: string[]; reqKeys: string[]; features: string[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <SelectField label="Level" value={f.level} onChange={(e) => set({ ...f, level: e.target.value })} options={[{ value: "", label: "Any" }, ...levels.map((l) => ({ value: l, label: LEVEL_TEXT_CASE[l] ?? caseLevelText(l) }))]} />
      <SelectField
        label="Risk level"
        value={f.risk}
        onChange={(e) => set({ ...f, risk: e.target.value as CaseFilters["risk"] })}
        options={[{ value: "", label: "Any" }, ...(["very_high", "high", "medium", "low"] as const).map((r) => ({ value: r, label: RISK_LEVEL_TEXT[r] }))]}
      />
      <SelectField
        label="Suite"
        value={f.suite}
        onChange={(e) => set({ ...f, suite: e.target.value as CaseFilters["suite"] })}
        options={[{ value: "", label: "Any" }, { value: "smoke", label: "Smoke" }, { value: "regression", label: "Regression" }]}
      />
      <SelectField label="Requirement" value={f.req} onChange={(e) => set({ ...f, req: e.target.value })} options={[{ value: "", label: "Any" }, ...reqKeys.map((k) => ({ value: k, label: k }))]} />
      <SelectField label="Feature" value={f.feature} onChange={(e) => set({ ...f, feature: e.target.value })} options={[{ value: "", label: "Any" }, ...features.map((k) => ({ value: k, label: k }))]} />
      <SelectField
        label="Checks"
        value={f.checks}
        onChange={(e) => set({ ...f, checks: e.target.value as CaseFilters["checks"] })}
        options={[
          { value: "", label: "Any" },
          { value: "must", label: "Must fix" },
          { value: "advice", label: "Advice only" },
          { value: "clean", label: "No issues" },
        ]}
      />
      <SelectField
        label="Source"
        value={f.source}
        onChange={(e) => set({ ...f, source: e.target.value as CaseFilters["source"] })}
        options={[
          { value: "", label: "Any" },
          { value: "rules", label: "Rules" },
          { value: "ai", label: "AI" },
          { value: "human", label: "Person" },
        ]}
      />
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="mb-1 text-body font-medium text-fg-strong">Show only</legend>
        <Checkbox label="Open question" checked={f.oq} onChange={(e) => set({ ...f, oq: e.target.checked })} />
        <Checkbox label="Priority set by a person" checked={f.prioSet} onChange={(e) => set({ ...f, prioSet: e.target.checked })} />
        <Checkbox label="Locked" checked={f.locked} onChange={(e) => set({ ...f, locked: e.target.checked })} />
        <Checkbox label="Edited by people" checked={f.edited} onChange={(e) => set({ ...f, edited: e.target.checked })} />
        <Checkbox label="Changed in latest generation" checked={f.changed} onChange={(e) => set({ ...f, changed: e.target.checked })} />
        <Checkbox label="No requirement link" checked={f.noReq} onChange={(e) => set({ ...f, noReq: e.target.checked })} />
      </fieldset>
    </div>
  );
}

function SubLine({ c, headerSource }: { c: TestCaseSummary; headerSource?: string | null }) {
  const t = techniqueInfo(c.technique);
  const source = c.generated_by !== headerSource ? (c.generated_by === "human" ? "Written by a person" : c.generated_by === "ai" ? "AI-generated" : null) : null;
  return (
    <p className="text-small text-fg-muted">
      <abbr title={t.name} className="no-underline">
        <span aria-hidden>{t.short}</span>
      </abbr>
      <span className="sr-only">{t.name}</span> · {caseTypeText(c.test_type)} · {caseLevelText(c.test_level)}
      {c.suites?.length ? ` · ${c.suites.map((s) => SUITE_TEXT[s]).join(", ")}` : ""}
      {source ? ` · ${source}` : ""}
    </p>
  );
}

function PrioritySourceLine({ c }: { c: TestCaseSummary }) {
  return (
    <span className="mt-0.5 flex items-center gap-1 text-caption text-fg-muted">
      {c.priority_overridden && <UserPen className="h-3.5 w-3.5" aria-hidden />}
      {prioritySourceShort(c)}
    </span>
  );
}

function ReqKeys({ c, projectId }: { c: TestCaseSummary; projectId: string }) {
  const keys = c.requirement_keys ?? [];
  if (!keys.length)
    return (
      <span className="inline-flex items-center gap-1 text-warning-fg">
        <CircleAlert className="h-3.5 w-3.5" aria-hidden /> None
      </span>
    );
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {keys.map((k) => (
        // min-h-6: each key is its own 24 px target (WCAG 2.5.8), even when keys wrap onto two lines.
        <Link key={k} href={`/projects/${projectId}/requirements/${k}`} className="inline-flex min-h-6 items-center font-mono text-navy-700 underline underline-offset-2" aria-label={`${k} (requirement of ${c.key})`}>
          {k}
        </Link>
      ))}
    </span>
  );
}

/**
 * Test cases tab (design P3 §6): URL-synced filters with chips, grouping, a selectable table (cards below md),
 * the hidden-rejected line and the bulk bar with the approve guard, Undo and Show skipped.
 */
export function TestCasesTable({
  projectId,
  all,
  filters: f,
  setFilters,
  serverMatches,
  readOnly,
  canEdit,
  g5Approved,
  headerSource,
  reqTitles,
  onChanged,
  detailQuery,
}: {
  projectId: string;
  all: TestCaseSummary[];
  filters: CaseFilters;
  setFilters: Setter;
  serverMatches?: Set<string> | null;
  readOnly: boolean;
  canEdit: boolean;
  g5Approved: boolean;
  headerSource?: string | null;
  reqTitles: Record<string, string>;
  onChanged: () => Promise<unknown> | void;
  detailQuery?: Record<string, string>;
}) {
  const toast = useToast();
  const { rows, hiddenRejected, hiddenDeprecated } = useMemo(() => filterCases(all, f, serverMatches), [all, f, serverMatches]);
  const [page, setPage] = useState(0);
  const grouped = f.group !== "none";
  const pages = grouped ? 1 : Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visible = grouped ? rows : rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const groups = useMemo(() => (grouped ? groupCases(visible, f.group as "requirement" | "feature", reqTitles) : null), [grouped, visible, f.group, reqTitles]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [guard, setGuard] = useState<null | ReturnType<typeof bulkApproveGuard>>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deprecateOpen, setDeprecateOpen] = useState(false);
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [mobileMore, setMobileMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const firstRowRef = useRef<HTMLAnchorElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const selectable = canEdit && !readOnly;

  useEffect(() => setPage(0), [f]);
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id))));
  }, [rows]);
  useEffect(() => {
    setLive(selected.size ? `${selected.size} test case${selected.size === 1 ? "" : "s"} selected` : "");
  }, [selected.size]);

  // Returning from a case: focus its link and restore the scroll position. The saved row is read once; rows may
  // render after the data loads, so it is retried until the row appears (QA check 76).
  const returnTo = useRef<{ key: string; y: number } | null | undefined>(undefined);
  if (returnTo.current === undefined) {
    returnTo.current = null;
    try {
      const raw = typeof window !== "undefined" ? sessionStorage.getItem(`qa:tc-return:${projectId}`) : null;
      if (raw) returnTo.current = JSON.parse(raw);
      if (raw) sessionStorage.removeItem(`qa:tc-return:${projectId}`);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    const saved = returnTo.current;
    if (!saved) return;
    const el = Array.from(tableRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-case]") ?? []).find((a) => a.dataset.case === saved.key && a.offsetParent !== null);
    if (!el) return;
    returnTo.current = null;
    claimRouteFocus(window.location.pathname);
    el.focus({ preventScroll: true });
    window.scrollTo(0, saved.y);
  }, [visible]);

  const chips = caseFilterChips(f);
  const selRows = all.filter((r) => selected.has(r.id));
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const types = [...new Set(all.map((c) => c.test_type))].sort();
  const levels = [...new Set(all.map((c) => c.test_level))].sort();
  const reqKeys = [...new Set(all.flatMap((c) => c.requirement_keys ?? []))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const features = [...new Set(all.map((c) => c.feature?.label).filter((x): x is string => !!x))].sort();
  const moreCount = [f.level, f.risk, f.suite, f.req, f.feature, f.checks, f.source, f.oq, f.prioSet, f.locked, f.edited, f.changed, f.noReq].filter(Boolean).length;
  const href = (c: TestCaseSummary) => `/projects/${projectId}/test-cases/${c.key}${buildQuery({ ...caseFiltersToQuery(f), ...detailQuery })}`;
  const approvedSelected = selRows.filter((c) => c.status === "approved");
  const reopenNote = g5Approved && approvedSelected.length > 0;
  const activeTotal = all.filter((c) => (c.status !== "rejected" && c.status !== "deprecated") || f.showHidden).length;

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  async function bulkStatus(ids: string[], status: CaseStatus, comment?: string): Promise<CaseBulkStatusResult | null> {
    setError(null);
    try {
      return await api<CaseBulkStatusResult>(`/projects/${projectId}/test-cases/bulk-status`, { body: { ids, status, comment: comment || undefined } });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "Your permissions changed. Refresh to see what you can do now."
          : err instanceof ApiError && err.code === "network"
            ? "You’re offline. Your selection is still here; try again when you reconnect."
            : `Couldn’t update the test cases. ${errorMessage(err)}`,
      );
      return null;
    }
  }

  function showKeys(keys: string[]) {
    setFilters({ ...EMPTY_CASE_FILTERS, keys, showHidden: true, group: f.group, sort: f.sort });
  }

  async function undo(prev: TestCaseSummary[]) {
    const groupsBy = new Map<CaseStatus, string[]>();
    for (const r of prev) groupsBy.set(r.status, [...(groupsBy.get(r.status) ?? []), r.id]);
    for (const [status, ids] of groupsBy) await bulkStatus(ids, status, status === "rejected" ? "Restored by Undo" : undefined);
    await onChanged();
    toast("Previous statuses restored.");
  }

  async function approve(target: TestCaseSummary[], skippedKeys: string[]) {
    setGuard(null);
    const ids = target.slice(0, BULK_LIMIT).map((r) => r.id);
    if (!ids.length) return;
    setBusy("approve");
    const prev = target.slice(0, BULK_LIMIT).map((r) => ({ ...r }));
    const res = await bulkStatus(ids, "approved");
    setBusy(null);
    if (!res) return;
    setSelected(new Set());
    await onChanged();
    const n = res.updated.length;
    const skipped = [...skippedKeys, ...res.skipped.map((s) => s.key)];
    const reopen = g5Approved ? " Gate 5 will need approval again." : "";
    toast(`${n} test case${n === 1 ? "" : "s"} approved.${skipped.length ? ` ${skipped.length} skipped.` : ""}${reopen}`, "success", {
      action: { label: "Undo", onClick: () => void undo(prev.filter((p) => res.updated.some((u) => u.id === p.id))) },
      secondary: skipped.length ? { label: "Show skipped", onClick: () => showKeys(skipped) } : undefined,
      duration: 10_000,
    });
    firstRowRef.current?.focus();
  }

  function startApprove() {
    const g = bulkApproveGuard(selRows);
    if (g.skipped.length) setGuard(g);
    else void approve(g.approvable, []);
  }

  /** Runs one request per case; partial failures name the cases (§6.4). */
  async function perCase(target: TestCaseSummary[], call: (c: TestCaseSummary) => Promise<unknown>, done: (n: number) => string) {
    setError(null);
    const failed: string[] = [];
    for (const c of target) {
      try {
        await call(c);
      } catch {
        failed.push(c.key);
      }
    }
    await onChanged();
    setSelected(new Set());
    const n = target.length - failed.length;
    if (failed.length)
      toast(`${n} of ${target.length} changed. ${failed.length} ${failed.length === 1 ? "wasn’t" : "weren’t"}: someone edited ${failed.length === 1 ? "it" : "them"} since.`, "error", {
        action: { label: "Show them", onClick: () => showKeys(failed) },
      });
    else toast(done(n));
    return n;
  }

  async function lock(locked: boolean) {
    setBusy(locked ? "lock" : "unlock");
    await perCase(
      selRows.filter((r) => r.locked !== locked),
      (c) => api(`/test-cases/${c.id}/lock`, { body: { version: c.version, locked } }),
      (n) => `${n} test case${n === 1 ? "" : "s"} ${locked ? "locked" : "unlocked"}.`,
    );
    setBusy(null);
  }

  async function suite(s: Suite, add: boolean) {
    setSuiteOpen(false);
    setBusy("suite");
    const target = selRows.filter((c) => (add ? !c.suites?.includes(s) : c.suites?.includes(s)));
    const touchesApproved = target.some((c) => c.status === "approved");
    await perCase(
      target,
      (c) => api(`/test-cases/${c.id}`, { method: "PATCH", body: { version: c.version, suites: add ? [...(c.suites ?? []), s] : (c.suites ?? []).filter((x) => x !== s) } }),
      (n) => `${n} test case${n === 1 ? "" : "s"} ${add ? "added to" : "removed from"} ${SUITE_TEXT[s]}.`,
    );
    noteGateReopened(projectId, "G5", g5Approved && touchesApproved, toast);
    setBusy(null);
  }

  const filterBar = (
    <div className="flex flex-wrap items-end gap-3">
      <TextField
        label="Search"
        placeholder="TC id, title or step text"
        value={f.q}
        onChange={(e) => setFilters({ ...f, q: e.target.value }, { replace: true })}
        wrapClassName="w-full sm:w-64"
        type="search"
      />
      <div className="hidden flex-wrap items-end gap-3 md:flex [&>div]:w-44">
        <FilterFields f={f} set={setFilters} types={types} />
      </div>
      <Button variant="secondary" className="hidden md:inline-flex" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}>
        More filters{moreCount ? ` (${moreCount})` : ""}
      </Button>
      <Button variant="secondary" className="md:hidden" onClick={() => setSheetOpen(true)} icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}>
        Filters ({chips.length})
      </Button>
    </div>
  );

  const groupSort = (
    <>
      <div className="space-y-1">
        <p className="text-body font-medium text-fg-strong" id="tc-group-label">
          Group by
        </p>
        <Segmented
          label="Group by"
          value={f.group}
          onChange={(v) => setFilters({ ...f, group: v })}
          options={[
            { value: "none", label: "None" },
            { value: "requirement", label: "Requirement" },
            { value: "feature", label: "Feature" },
          ]}
        />
      </div>
      <SelectField
        label="Sort"
        value={f.sort}
        onChange={(e) => setFilters({ ...f, sort: e.target.value as CaseFilters["sort"] })}
        options={[
          { value: "priority", label: "Priority" },
          { value: "key", label: "Key" },
          { value: "status", label: "Status" },
          { value: "changed", label: "Last changed" },
        ]}
        wrapClassName="w-44"
      />
    </>
  );

  const row = (c: TestCaseSummary, i: number, alsoIn: string[] = []) => (
    <tr key={`${c.id}-${alsoIn.join()}`} aria-selected={selectable ? selected.has(c.id) : undefined} className={`hover:bg-overlay ${selected.has(c.id) ? "bg-accent-soft" : ""}`}>
      {selectable && (
        <td className="px-3 py-3 align-top">
          <input type="checkbox" className="h-5 w-5 accent-accent" aria-label={`Select ${c.key} ${c.title}`} checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
        </td>
      )}
      <th scope="row" className="sticky left-0 z-[1] min-w-72 bg-surface px-3 py-3 text-left align-top font-normal">
        <Link
          ref={i === 0 ? firstRowRef : undefined}
          href={href(c)}
          data-case={c.key}
          onClick={() => rememberRow(projectId, c.key)}
          className="font-medium text-fg-strong underline-offset-2 hover:underline"
        >
          <span className="font-mono">{c.key}</span> {c.title}
        </Link>
        <SubLine c={c} headerSource={headerSource} />
        {alsoIn.length > 0 && <p className="text-caption text-fg-muted">Also in {alsoIn.join(", ")}</p>}
      </th>
      <td className="whitespace-nowrap px-3 py-3 align-top">
        <PriorityValue priority={c.priority} />
        <PrioritySourceLine c={c} />
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top">{c.expected_result_status === "open_question" ? <NotDecided /> : <ProvenanceLabel provenance={c.classification ?? null} />}</td>
      <td className="px-3 py-3 align-top">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <CaseStatusPill status={c.status} />
          <CaseFlags c={c} />
        </span>
      </td>
      <td className="px-3 py-3 align-top">
        <LintChip c={c} />
      </td>
      <td className="px-3 py-3 align-top">
        <ReqKeys c={c} projectId={projectId} />
      </td>
      <td className="px-3 py-3 align-top">
        <NotRunYet />
      </td>
    </tr>
  );

  const headerCells = ["Test case", "Priority", "Expected result", "Status", "Checks", "Requirements", "Last result"];
  const colCount = headerCells.length + (selectable ? 1 : 0);

  return (
    <div className={`space-y-4 ${selected.size ? BULK_BAR_PADDING : ""}`} ref={tableRef}>
      <div className="flex flex-wrap items-start justify-between gap-3">{filterBar}</div>
      {moreOpen && (
        <div className="hidden rounded-lg border border-line bg-surface p-4 md:block">
          <MoreFilters f={f} set={setFilters} levels={levels} reqKeys={reqKeys} features={features} />
        </div>
      )}
      <FilterChips chips={chips} onRemove={(k) => setFilters(clearCaseFilter(f, k as keyof CaseFilters))} onClear={() => setFilters({ ...EMPTY_CASE_FILTERS, group: f.group, sort: f.sort })} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-body text-fg-muted" aria-live="polite">
          Showing <span className="tabular-nums">{rows.length}</span> of <span className="tabular-nums">{activeTotal}</span>
        </p>
        <div className="hidden flex-wrap items-end gap-3 md:flex">{groupSort}</div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-4">
        <TechniqueLegend />
        <ProvenanceLegend />
      </div>
      <InlineError error={error} />
      {selectable && allVisibleSelected && rows.length > visible.length && selected.size < rows.length && (
        <p className="text-body text-fg">
          All {visible.length} on this page are selected.{" "}
          <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>
            Select all {rows.length} matching test cases
          </button>
        </p>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          {all.length > 0 && all.every((c) => c.status === "rejected") ? (
            <EmptyState
              title="All test cases are rejected. Restore some, add one, or regenerate."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" onClick={() => setFilters({ ...EMPTY_CASE_FILTERS, status: "rejected" })}>
                    Show rejected
                  </Button>
                  {canEdit && !readOnly && (
                    <LinkButton href={`/projects/${projectId}/test-cases/new`} icon={<Plus className="h-4 w-4" aria-hidden />}>
                      New test case
                    </LinkButton>
                  )}
                </div>
              }
            />
          ) : (
            <EmptyState
              title="No test cases match these filters."
              action={
                <Button variant="secondary" onClick={() => setFilters({ ...EMPTY_CASE_FILTERS, group: f.group, sort: f.sort })}>
                  Clear filters
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <>
          {/* md+: table in a labelled scroll region with a sticky first column */}
          <div className="hidden rounded-lg border border-line bg-surface md:block">
            <div className="scrollbar-thin overflow-x-auto" role="region" aria-label="Test cases, scrolls sideways" tabIndex={0}>
              <table className="min-w-full divide-y divide-line text-small">
                <caption className="sr-only">Test cases, {rows.length} shown</caption>
                <thead className="bg-elevated">
                  <tr>
                    {selectable && (
                      <th scope="col" className="w-10 px-3 py-2.5">
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-accent"
                          aria-label="Select all test cases on this page"
                          checked={allVisibleSelected}
                          onChange={(e) => {
                            const next = new Set(selected);
                            for (const r of visible) {
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                            }
                            setSelected(next);
                          }}
                        />
                      </th>
                    )}
                    {headerCells.map((h) => (
                      <th
                        key={h}
                        scope="col"
                        aria-sort={(h === "Priority" && f.sort === "priority") || (h === "Test case" && f.sort === "key") || (h === "Status" && f.sort === "status") ? "ascending" : undefined}
                        className={`whitespace-nowrap px-3 py-2.5 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted ${h === "Test case" ? "sticky left-0 z-[1] bg-elevated" : ""}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                {groups ? (
                  groups.map((g) => (
                    <tbody key={g.id} className="divide-y divide-line border-t-2 border-line-strong bg-surface">
                      <tr className="bg-elevated">
                        <th scope="rowgroup" colSpan={colCount} className="px-3 py-2 text-left text-body font-semibold text-fg-strong">
                          {g.title} · {g.cases.length} case{g.cases.length === 1 ? "" : "s"} · {g.approved} approved
                        </th>
                      </tr>
                      {g.cases.map((c, i) => row(c, -1 + (g === groups[0] && i === 0 ? 1 : 0), f.group === "requirement" && g.key ? (c.requirement_keys ?? []).filter((k) => k !== g.key) : []))}
                    </tbody>
                  ))
                ) : (
                  <tbody className="divide-y divide-line bg-surface">{visible.map((c, i) => row(c, i))}</tbody>
                )}
              </table>
            </div>
          </div>
          {/* below md: cards */}
          <div className="space-y-4 md:hidden">
            {(groups ?? [{ id: "all", title: "", key: null, cases: visible, approved: 0 }]).map((g) => (
              <section key={g.id} aria-label={g.title || "Test cases"}>
                {g.title && (
                  <h3 className="mb-2 text-body font-semibold text-fg-strong">
                    {g.title} · {g.cases.length} case{g.cases.length === 1 ? "" : "s"} · {g.approved} approved
                  </h3>
                )}
                <ul className="space-y-3">
                  {g.cases.map((c) => (
                    <li key={`${g.id}-${c.id}`} className={`rounded-lg border border-line bg-surface p-3 ${selected.has(c.id) ? "ring-2 ring-accent" : ""}`}>
                      <div className="flex items-start gap-3">
                        {selectable && (
                          <label className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center">
                            <input type="checkbox" className="h-5 w-5 accent-accent" aria-label={`Select ${c.key} ${c.title}`} checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                          </label>
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono text-small text-fg-strong">{c.key}</span>
                            <span className="inline-flex flex-wrap items-center gap-1">
                              <CaseStatusPill status={c.status} />
                              <CaseFlags c={c} />
                            </span>
                          </div>
                          <Link href={href(c)} data-case={c.key} onClick={() => rememberRow(projectId, c.key)} className="block break-words font-medium text-fg-strong underline-offset-2 hover:underline">
                            <span className="sr-only">{c.key} </span>
                            {c.title}
                          </Link>
                          <SubLine c={c} headerSource={headerSource} />
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg">
                            <PriorityValue priority={c.priority} />
                            <span className="text-fg-muted">({prioritySourceShort(c)})</span>
                            <span>
                              · Expected: {c.expected_result_status === "open_question" ? <NotDecided /> : <ProvenanceLabel provenance={c.classification ?? null} />}
                            </span>
                          </p>
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
                            <LintChip c={c} /> · <ReqKeys c={c} projectId={projectId} /> · <NotRunYet />
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {pages > 1 && (
            <nav aria-label="Test case pages" className="flex items-center justify-between gap-3 text-body">
              <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous page
              </Button>
              <span className="tabular-nums text-fg-muted">
                Page {page + 1} of {pages}
              </span>
              <Button variant="secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                Next page
              </Button>
            </nav>
          )}
        </>
      )}
      {(hiddenRejected > 0 || hiddenDeprecated > 0) && (
        <p className="text-small text-fg-muted">
          {[hiddenRejected ? `${hiddenRejected} rejected` : null, hiddenDeprecated ? `${hiddenDeprecated} deprecated` : null].filter(Boolean).join(" and ")} test case
          {hiddenRejected + hiddenDeprecated === 1 ? " is" : "s are"} hidden.{" "}
          <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setFilters({ ...f, showHidden: true })}>
            Show them
          </button>
        </p>
      )}
      {f.showHidden && !f.keys.length && (
        <p className="text-small text-fg-muted">
          Rejected and deprecated test cases are shown.{" "}
          <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setFilters({ ...f, showHidden: false })}>
            Hide them
          </button>
        </p>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>

      {selectable && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          {reopenNote && <span className="w-full text-small text-fg sm:w-auto">Changing approved cases reopens Gate 5.</span>}
          <Button size="sm" onClick={startApprove} loading={busy === "approve"}>
            {selected.size > BULK_LIMIT ? `Approve first ${BULK_LIMIT}` : `Approve ${selected.size}`}
          </Button>
          <span className="hidden flex-wrap items-center gap-2 md:flex">
            <Button size="sm" variant="secondary" onClick={() => setRejectOpen(true)}>
              Reject…
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDeprecateOpen(true)}>
              Deprecate…
            </Button>
            <span className="relative">
              <Button size="sm" variant="secondary" aria-expanded={suiteOpen} aria-haspopup="true" onClick={() => setSuiteOpen((o) => !o)} loading={busy === "suite"}>
                Add to suite
              </Button>
              {suiteOpen && <SuiteMenu reopen={reopenNote} onPick={(s, add) => void suite(s, add)} />}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void lock(true)} loading={busy === "lock"}>
              Lock
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void lock(false)} loading={busy === "unlock"}>
              Unlock
            </Button>
          </span>
          <Button size="sm" variant="secondary" className="md:hidden" aria-label="More bulk actions" aria-expanded={mobileMore} onClick={() => setMobileMore(true)}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        </BulkActionBar>
      )}

      <Drawer open={mobileMore} onClose={() => setMobileMore(false)} title={`${selected.size} selected`}>
        <div className="flex flex-col gap-2">
          {reopenNote && <p className="text-small text-fg">Changing approved cases reopens Gate 5.</p>}
          <Button variant="secondary" onClick={() => (setMobileMore(false), setRejectOpen(true))}>
            Reject…
          </Button>
          <Button variant="secondary" onClick={() => (setMobileMore(false), setDeprecateOpen(true))}>
            Deprecate…
          </Button>
          {(["smoke", "regression"] as const).map((s) => (
            <Fragment key={s}>
              <Button variant="secondary" onClick={() => (setMobileMore(false), void suite(s, true))}>
                Add to {SUITE_TEXT[s]}
              </Button>
              <Button variant="secondary" onClick={() => (setMobileMore(false), void suite(s, false))}>
                Remove from {SUITE_TEXT[s]}
              </Button>
            </Fragment>
          ))}
          <Button variant="secondary" onClick={() => (setMobileMore(false), void lock(true))}>
            Lock
          </Button>
          <Button variant="secondary" onClick={() => (setMobileMore(false), void lock(false))}>
            Unlock
          </Button>
        </div>
      </Drawer>

      {guard && (
        <Modal
          open
          onClose={() => setGuard(null)}
          title={`Approve ${selRows.length} test case${selRows.length === 1 ? "" : "s"}?`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setGuard(null)}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  void approve(
                    guard.approvable,
                    guard.skipped.map((s) => s.c.key),
                  )
                }
                disabled={guard.approvable.length === 0}
              >
                Approve {guard.approvable.length}
              </Button>
            </>
          }
        >
          <p className="text-body text-fg">{skippedSentence(guard.skipped)}</p>
          <ul className="mt-3 space-y-1 text-body text-fg" aria-label="Test cases that will be skipped">
            {guard.skipped.map((s) => (
              <li key={s.c.id}>
                <span className="font-mono">{s.c.key}</span> {s.c.title}: {s.text}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      <CaseRejectDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        count={selRows.length}
        candidates={all.filter((r) => !selected.has(r.id) && r.status !== "rejected")}
        onReject={async (r) => {
          const prev = selRows.map((x) => ({ ...x }));
          const res = await bulkStatus(
            selRows.map((x) => x.id),
            "rejected",
            r.comment,
          );
          if (!res) throw new Error("Couldn’t reject the test cases. Try again.");
          setSelected(new Set());
          await onChanged();
          toast(`${res.updated.length} test case${res.updated.length === 1 ? "" : "s"} rejected.`, "success", { action: { label: "Undo", onClick: () => void undo(prev) }, duration: 10_000 });
        }}
      />
      <DeprecateDialog
        open={deprecateOpen}
        onClose={() => setDeprecateOpen(false)}
        count={approvedSelected.length || selRows.length}
        candidates={all.filter((r) => !selected.has(r.id) && (r.status === "approved" || r.status === "draft"))}
        onDeprecate={async (comment) => {
          const skipped = selRows.filter((c) => c.status !== "approved");
          if (!approvedSelected.length) throw new Error("Only approved cases can be deprecated.");
          const res = await bulkStatus(
            approvedSelected.map((x) => x.id),
            "deprecated",
            comment,
          );
          if (!res) throw new Error("Couldn’t deprecate the test cases. Try again.");
          setSelected(new Set());
          await onChanged();
          noteGateReopened(projectId, "G5", g5Approved, toast);
          toast(
            `${res.updated.length} test case${res.updated.length === 1 ? "" : "s"} deprecated.${skipped.length ? ` ${skipped.length} skipped: only approved cases can be deprecated.` : ""}`,
            "success",
            skipped.length ? { action: { label: "Show skipped", onClick: () => showKeys(skipped.map((s) => s.key)) } } : undefined,
          );
        }}
      />

      <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} title="Filters" footer={<Button onClick={() => setSheetOpen(false)}>Show {rows.length} results</Button>}>
        <div className="space-y-4">
          <FilterFields f={f} set={setFilters} types={types} />
          <Disclosure label="More filters" defaultOpen={moreCount > 0}>
            <div className="mt-3">
              <MoreFilters f={f} set={setFilters} levels={levels} reqKeys={reqKeys} features={features} />
            </div>
          </Disclosure>
          <div className="flex flex-wrap items-end gap-3">{groupSort}</div>
        </div>
      </Drawer>
    </div>
  );
}

function SuiteMenu({ reopen, onPick }: { reopen: boolean; onPick: (s: Suite, add: boolean) => void }) {
  return (
    <div className="absolute bottom-full left-0 z-40 mb-2 w-60 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
      {(["smoke", "regression"] as const).map((s) => (
        <Fragment key={s}>
          <button type="button" onClick={() => onPick(s, true)} className="flex min-h-10 w-full items-center px-4 text-left text-body text-fg-strong hover:bg-overlay">
            Add to {SUITE_TEXT[s]}
          </button>
          <button type="button" onClick={() => onPick(s, false)} className="flex min-h-10 w-full items-center px-4 text-left text-body text-fg-strong hover:bg-overlay">
            Remove from {SUITE_TEXT[s]}
          </button>
        </Fragment>
      ))}
      {reopen && <p className="border-t border-line px-4 py-2 text-small text-fg-muted">Gate 5 will need approval again.</p>}
    </div>
  );
}
