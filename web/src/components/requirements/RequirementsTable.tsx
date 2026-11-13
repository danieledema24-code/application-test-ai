"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { CircleAlert, Lock, PencilLine, Plus, SlidersHorizontal, Sparkle, TriangleAlert } from "lucide-react";
import { api, ApiError, buildQuery, errorMessage } from "@/lib/api";
import type { BulkStatusResult, RequirementStatus, RequirementSummary } from "@/lib/contract";
import {
  BAND_TEXT,
  CATEGORY_TEXT,
  EMPTY_FILTERS,
  LABEL_FILTER_TEXT,
  STATUS_TEXT,
  activeFilterChips,
  approvalFlagSentence,
  approvalFlags,
  clearFilter,
  filterRequirements,
  filtersToQuery,
  type ReqFilters,
} from "@/lib/requirements";
import {
  Badge,
  BulkActionBar,
  BULK_BAR_PADDING,
  Button,
  Checkbox,
  ConfirmDialog,
  Disclosure,
  Drawer,
  EmptyState,
  FilterChips,
  InlineError,
  LinkButton,
  Modal,
  SelectField,
  StatusPill,
  TextArea,
  TextField,
  Tooltip,
  useToast,
} from "@/components/ui";
import { ProvenanceLabel, ProvenanceLegend } from "@/components/domain/ObservationLabel";
import { ConfidenceValue } from "@/components/domain/ConfidenceValue";
import { RejectDialog } from "./RejectDialog";

const PAGE_SIZE = 50;

export function sourceText(r: Pick<RequirementSummary, "source">): string {
  if (r.source === "discovery") return "Discovery";
  if (r.source === "document") return "Document";
  if (r.source === "user") return "User";
  return "AI QA Analyst";
}

export function StatusFlags({ r }: { r: Pick<RequirementSummary, "locked" | "human_edited" | "conflict" | "changed_in_latest"> }) {
  const flag = (Icon: typeof Lock, text: string) => (
    <Tooltip content={text}>
      <span tabIndex={0} className="inline-flex text-fg-muted">
        <Icon className="h-4 w-4" aria-hidden />
        <span className="sr-only">{text}</span>
      </span>
    </Tooltip>
  );
  return (
    <span className="inline-flex items-center gap-1">
      {r.locked && flag(Lock, "Locked")}
      {r.human_edited && flag(PencilLine, "Edited by a person")}
      {r.conflict && flag(TriangleAlert, "Conflict between document and application")}
      {r.changed_in_latest && flag(Sparkle, "Changed in latest generation")}
    </span>
  );
}

export function RequirementStatusPill({ status }: { status: RequirementStatus }) {
  return <StatusPill status={status} label={STATUS_TEXT[status]} tone={status === "draft" ? "amber" : undefined} />;
}

function AcCount({ n }: { n: number }) {
  if (n > 0) return <span className="tabular-nums">{n}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-warning-fg">
      <CircleAlert className="h-3.5 w-3.5" aria-hidden />
      None
    </span>
  );
}

type Setter = (f: ReqFilters, opts?: { replace?: boolean }) => void;

function FilterFields({ f, set, sources }: { f: ReqFilters; set: Setter; sources: { value: string; label: string }[] }) {
  return (
    <>
      <SelectField
        label="Status"
        value={f.status}
        onChange={(e) => set({ ...f, status: e.target.value as ReqFilters["status"] })}
        options={[{ value: "", label: "Any (except Rejected)" }, ...(["draft", "approved", "rejected", "needs_info"] as const).map((s) => ({ value: s, label: STATUS_TEXT[s] }))]}
      />
      <SelectField
        label="Label"
        value={f.label}
        onChange={(e) => set({ ...f, label: e.target.value as ReqFilters["label"] })}
        options={[{ value: "", label: "Any" }, ...(["observed", "inferred", "assumed", "unverified", "weak"] as const).map((s) => ({ value: s, label: LABEL_FILTER_TEXT[s] }))]}
      />
      <SelectField
        label="Category"
        value={f.category}
        onChange={(e) => set({ ...f, category: e.target.value as ReqFilters["category"] })}
        options={[{ value: "", label: "Any" }, ...Object.entries(CATEGORY_TEXT).map(([value, label]) => ({ value, label }))]}
      />
      <SelectField label="Source" value={f.source} onChange={(e) => set({ ...f, source: e.target.value })} options={[{ value: "", label: "Any" }, ...sources]} />
    </>
  );
}

function MoreFilters({ f, set }: { f: ReqFilters; set: Setter }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <SelectField
        label="Confidence"
        value={f.conf}
        onChange={(e) => set({ ...f, conf: e.target.value as ReqFilters["conf"] })}
        options={[
          { value: "", label: "Any" },
          { value: "high", label: "High (80% or more)" },
          { value: "medium", label: "Medium (50–79%)" },
          { value: "low", label: "Low (under 50%)" },
        ]}
      />
      <TextField label="Feature" value={f.feature} onChange={(e) => set({ ...f, feature: e.target.value }, { replace: true })} hint="Exact feature name" />
      <fieldset className="space-y-2 sm:col-span-2 lg:col-span-1">
        <legend className="mb-1 text-body font-medium text-fg-strong">Show only</legend>
        <Checkbox label="Locked" checked={f.locked} onChange={(e) => set({ ...f, locked: e.target.checked })} />
        <Checkbox label="Edited by people" checked={f.edited} onChange={(e) => set({ ...f, edited: e.target.checked })} />
        <Checkbox label="No acceptance criteria" checked={f.noAc} onChange={(e) => set({ ...f, noAc: e.target.checked })} />
        <Checkbox label="Document conflicts" checked={f.conflict} onChange={(e) => set({ ...f, conflict: e.target.checked })} />
        <Checkbox label="Changed in latest generation" checked={f.changed} onChange={(e) => set({ ...f, changed: e.target.checked })} />
      </fieldset>
    </div>
  );
}

/**
 * Requirements tab (design P2 §5.2): URL-synced filters with chips, a selectable table (cards below md),
 * hidden-rejected line and the bulk action bar with the approve guard and Undo.
 */
export function RequirementsTable({
  projectId,
  all,
  filters: f,
  setFilters,
  readOnly,
  canEdit,
  onChanged,
  detailQuery,
}: {
  projectId: string;
  all: RequirementSummary[];
  filters: ReqFilters;
  setFilters: Setter;
  readOnly: boolean;
  canEdit: boolean;
  onChanged: () => Promise<unknown> | void;
  /** Extra query for detail links (e.g. the version being viewed). */
  detailQuery?: Record<string, string>;
}) {
  const toast = useToast();
  const { rows, hiddenRejected } = useMemo(() => filterRequirements(all, f), [all, f]);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visible = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [guard, setGuard] = useState<null | ReturnType<typeof approvalFlags>>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [needsInfoOpen, setNeedsInfoOpen] = useState(false);
  const [needsInfoNote, setNeedsInfoNote] = useState("");
  const [needsInfoError, setNeedsInfoError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const { mutate: mutateCache } = useSWRConfig();
  const firstRowRef = useRef<HTMLAnchorElement>(null);
  const selectable = canEdit && !readOnly;

  useEffect(() => setPage(0), [f]);
  useEffect(() => {
    // Selection only ever holds visible-or-matching rows.
    setSelected((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id))));
  }, [rows]);
  useEffect(() => {
    setLive(selected.size ? `${selected.size} requirement${selected.size === 1 ? "" : "s"} selected` : "");
  }, [selected.size]);

  const chips = activeFilterChips(f);
  const selRows = all.filter((r) => selected.has(r.id));
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const sources = [
    { value: "discovery", label: "Discovery" },
    { value: "document", label: "Document" },
    { value: "user", label: "User" },
    { value: "assistant", label: "AI QA Analyst" },
  ];
  const moreCount = [f.conf, f.feature, f.locked, f.edited, f.noAc, f.conflict, f.changed].filter(Boolean).length;
  const filterCount = chips.length;
  const href = (r: RequirementSummary) => `/projects/${projectId}/requirements/${r.key}${buildQuery({ ...filtersToQuery(f), ...detailQuery })}`;

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  async function bulkStatus(ids: string[], status: RequirementStatus, comment?: string): Promise<BulkStatusResult | null> {
    setError(null);
    try {
      return await api<BulkStatusResult>(`/projects/${projectId}/requirements/bulk-status`, { body: { ids, status, comment: comment || undefined } });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? `You don’t have permission to ${status === "approved" ? "approve" : "change"} requirements. Ask an owner or admin.`
          : err instanceof ApiError && err.code === "network"
            ? "You’re offline. Your selection is still here; try again when you reconnect."
            : `Couldn’t update the requirements. ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /** Revert a bulk change to each row's previous status (Undo, 10 s). */
  async function undo(prev: RequirementSummary[]) {
    const groups = new Map<RequirementStatus, string[]>();
    for (const r of prev) groups.set(r.status, [...(groups.get(r.status) ?? []), r.id]);
    for (const [status, ids] of groups) await bulkStatus(ids, status, status === "rejected" || status === "needs_info" ? "Restored by Undo" : undefined);
    await onChanged();
    toast("Previous statuses restored.");
  }

  async function approve(target: RequirementSummary[]) {
    setGuard(null);
    if (!target.length) return;
    setBusy("approve");
    const prev = target.map((r) => ({ ...r }));
    const res = await bulkStatus(
      target.map((r) => r.id),
      "approved",
    );
    setBusy(null);
    if (!res) return;
    setSelected(new Set());
    // Approval also approves draft criteria on the server, so cached requirement details are stale too.
    await Promise.all([onChanged(), mutateCache((k) => typeof k === "string" && k.startsWith("/requirements/"))]);
    const n = res.updated.length;
    const skipped = res.skipped.length ? ` ${res.skipped.length} skipped: ${res.skipped.map((s) => `${s.key} (${s.reason})`).join(", ")}.` : "";
    toast(`${n} requirement${n === 1 ? "" : "s"} approved.${skipped}`, "success", { action: { label: "Undo", onClick: () => void undo(prev) }, duration: 10_000 });
    firstRowRef.current?.focus();
  }

  function startApprove() {
    const flags = approvalFlags(selRows);
    if (flags.flagged.size) setGuard(flags);
    else void approve(selRows);
  }

  async function lock(locked: boolean) {
    setBusy(locked ? "lock" : "unlock");
    setError(null);
    const target = selRows.filter((r) => r.locked !== locked);
    const failed: string[] = [];
    for (const r of target) {
      try {
        await api(`/requirements/${r.id}/lock`, { body: { version: r.version, locked } });
      } catch {
        failed.push(r.key);
      }
    }
    setBusy(null);
    await onChanged();
    setSelected(new Set());
    if (failed.length) setError(`Couldn’t ${locked ? "lock" : "unlock"} ${failed.join(", ")}. Try again.`);
    else toast(`${target.length} requirement${target.length === 1 ? "" : "s"} ${locked ? "locked" : "unlocked"}.`);
  }

  const filterBar = (
    <div className="flex flex-wrap items-end gap-3">
      <TextField
        label="Search"
        placeholder="REQ id, title or text"
        value={f.q}
        onChange={(e) => setFilters({ ...f, q: e.target.value }, { replace: true })}
        wrapClassName="w-full sm:w-64"
        type="search"
      />
      <div className="hidden flex-wrap items-end gap-3 md:flex [&>div]:w-44">
        <FilterFields f={f} set={setFilters} sources={sources} />
      </div>
      <Button variant="secondary" className="hidden md:inline-flex" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}>
        More filters{moreCount ? ` (${moreCount})` : ""}
      </Button>
      <Button variant="secondary" className="md:hidden" onClick={() => setSheetOpen(true)} icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}>
        Filters ({filterCount})
      </Button>
    </div>
  );

  return (
    <div className={`space-y-4 ${selected.size ? BULK_BAR_PADDING : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {filterBar}
        <div className="flex items-center gap-3">
          <ProvenanceLegend />
          {canEdit && !readOnly && (
            <LinkButton href={`/projects/${projectId}/requirements/new`} variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />}>
              Add requirement
            </LinkButton>
          )}
        </div>
      </div>
      {moreOpen && (
        <div className="hidden rounded-lg border border-line bg-surface p-4 md:block">
          <MoreFilters f={f} set={setFilters} />
        </div>
      )}
      <FilterChips chips={chips} onRemove={(k) => setFilters(clearFilter(f, k as keyof ReqFilters))} onClear={() => setFilters({ ...EMPTY_FILTERS, sort: f.sort })} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-body text-fg-muted" aria-live="polite">
          Showing <span className="tabular-nums">{rows.length}</span> of <span className="tabular-nums">{all.filter((r) => r.status !== "rejected" || f.showRejected || f.status === "rejected").length}</span>
        </p>
        <SelectField
          label="Sort"
          value={f.sort}
          onChange={(e) => setFilters({ ...f, sort: e.target.value as ReqFilters["sort"] })}
          options={[
            { value: "id", label: "ID" },
            { value: "title", label: "Title" },
            { value: "confidence", label: "Confidence (low first)" },
            { value: "status", label: "Status" },
            { value: "changed", label: "Last changed" },
          ]}
          wrapClassName="w-52"
        />
      </div>
      <InlineError error={error} />
      {selectable && allVisibleSelected && rows.length > visible.length && selected.size < rows.length && (
        <p className="text-body text-fg">
          All {visible.length} on this page are selected.{" "}
          <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>
            Select all {rows.length} matching requirements
          </button>
        </p>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            title="No requirements match these filters."
            action={
              <Button variant="secondary" onClick={() => setFilters({ ...EMPTY_FILTERS, sort: f.sort })}>
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {/* md+: table */}
          <div className="hidden rounded-lg border border-line bg-surface md:block">
            <div className="scrollbar-thin overflow-x-auto" role="region" aria-label="Requirements" tabIndex={0}>
              <table className="min-w-full divide-y divide-line text-small" aria-label="Requirements">
                <thead className="bg-elevated">
                  <tr>
                    {selectable && (
                      <th scope="col" className="w-10 px-3 py-2.5">
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-accent"
                          aria-label="Select all requirements on this page"
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
                    {["ID", "Requirement", "Label", "Confidence", "Source", "AC", "Status"].map((h) => (
                      <th key={h} scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted ${h === "ID" ? "sticky left-0 bg-elevated" : ""}`}>
                        {h === "AC" ? <abbr title="Acceptance criteria">AC</abbr> : h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-surface">
                  {visible.map((r, i) => (
                    <tr key={r.id} aria-selected={selectable ? selected.has(r.id) : undefined} className={`hover:bg-overlay ${selected.has(r.id) ? "bg-accent-soft" : ""}`}>
                      {selectable && (
                        <td className="px-3 py-3 align-top">
                          <input
                            type="checkbox"
                            className="h-5 w-5 accent-accent"
                            aria-label={`Select ${r.key} ${r.title}`}
                            checked={selected.has(r.id)}
                            onChange={(e) => toggle(r.id, e.target.checked)}
                          />
                        </td>
                      )}
                      <td className="sticky left-0 whitespace-nowrap bg-inherit px-3 py-3 align-top font-mono text-fg-strong">
                        <Link href={href(r)} className="underline-offset-2 hover:underline" aria-hidden tabIndex={-1}>
                          {r.key}
                        </Link>
                      </td>
                      <td className="min-w-64 px-3 py-3 align-top">
                        <Link ref={i === 0 ? firstRowRef : undefined} href={href(r)} className="font-medium text-fg-strong underline-offset-2 hover:underline">
                          <span className="sr-only">{r.key} </span>
                          {r.title}
                        </Link>
                        <p className="text-small text-fg-muted">
                          {r.type === "functional" ? "Functional" : "Non-functional"} · {CATEGORY_TEXT[r.category] ?? r.category}
                          {r.related_feature_names?.length ? ` · ${r.related_feature_names.join(", ")}` : ""}
                        </p>
                        {r.generated_by === "rules" && <p className="sr-only">Generated by rules (AI not configured)</p>}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <ProvenanceLabel provenance={r.classification} />
                      </td>
                      <td className="px-3 py-3 align-top">
                        <ConfidenceValue confidence={r.confidence} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 align-top">{sourceText(r)}</td>
                      <td className="px-3 py-3 align-top">
                        <AcCount n={r.ac_count} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 align-top">
                        <span className="inline-flex items-center gap-1.5">
                          <RequirementStatusPill status={r.status} />
                          <StatusFlags r={r} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {/* below md: cards */}
          <ul className="space-y-3 md:hidden" aria-label="Requirements">
            {visible.map((r) => (
              <li key={r.id} className={`rounded-lg border border-line bg-surface p-3 ${selected.has(r.id) ? "ring-2 ring-accent" : ""}`}>
                <div className="flex items-start gap-3">
                  {selectable && (
                    <label className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center">
                      <input type="checkbox" className="h-5 w-5 accent-accent" aria-label={`Select ${r.key} ${r.title}`} checked={selected.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
                    </label>
                  )}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-small text-fg-strong">{r.key}</span>
                      <span className="inline-flex items-center gap-1">
                        <RequirementStatusPill status={r.status} />
                        <StatusFlags r={r} />
                      </span>
                    </div>
                    <Link href={href(r)} className="block font-medium text-fg-strong underline-offset-2 hover:underline">
                      {r.title}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2 text-small">
                      <ProvenanceLabel provenance={r.classification} />
                      <ConfidenceValue confidence={r.confidence} />
                      <Badge>{sourceText(r)}</Badge>
                      <span className="text-fg-muted">
                        AC: <AcCount n={r.ac_count} />
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Requirements pages" className="flex items-center justify-between gap-3 text-body">
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
      {hiddenRejected > 0 && (
        <p className="text-small text-fg-muted">
          {hiddenRejected} rejected requirement{hiddenRejected === 1 ? "" : "s"} hidden.{" "}
          <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setFilters({ ...f, showRejected: true })}>
            Show them
          </button>
        </p>
      )}
      {f.showRejected && f.status !== "rejected" && (
        <p className="text-small text-fg-muted">
          Rejected requirements are shown.{" "}
          <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setFilters({ ...f, showRejected: false })}>
            Hide them
          </button>
        </p>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>

      {selectable && (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Button size="sm" onClick={startApprove} loading={busy === "approve"}>
            Approve {selected.size}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRejectOpen(true)}>
            Reject…
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setNeedsInfoNote("");
              setNeedsInfoError(null);
              setNeedsInfoOpen(true);
            }}
          >
            Mark as needs info
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void lock(true)} loading={busy === "lock"}>
            Lock
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void lock(false)} loading={busy === "unlock"}>
            Unlock
          </Button>
        </BulkActionBar>
      )}

      {guard && (
        <Modal
          open
          onClose={() => setGuard(null)}
          title={`Approve ${selRows.length} requirements?`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setGuard(null)}>
                Cancel
              </Button>
              {guard.unflagged.length > 0 && (
                <Button variant="secondary" onClick={() => void approve(guard.unflagged)}>
                  Approve {guard.unflagged.length} only
                </Button>
              )}
              <Button onClick={() => void approve(selRows)}>Approve all {selRows.length}</Button>
            </>
          }
        >
          <p className="text-body text-fg">
            {approvalFlagSentence(guard)} Approving confirms them as requirements for testing; their labels stay as they are.
          </p>
        </Modal>
      )}
      <RejectDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        count={selRows.length}
        candidates={all.filter((r) => !selected.has(r.id) && r.status !== "rejected")}
        onReject={async (comment) => {
          const prev = selRows.map((r) => ({ ...r }));
          const res = await bulkStatus(
            selRows.map((r) => r.id),
            "rejected",
            comment,
          );
          if (!res) throw new Error("Couldn’t reject the requirements. Try again.");
          setSelected(new Set());
          await onChanged();
          toast(`${res.updated.length} requirement${res.updated.length === 1 ? "" : "s"} rejected.`, "success", { action: { label: "Undo", onClick: () => void undo(prev) }, duration: 10_000 });
        }}
      />
      <ConfirmDialog
        open={needsInfoOpen}
        onClose={() => setNeedsInfoOpen(false)}
        title={`Mark ${selRows.length} as needs info?`}
        confirmLabel="Mark as needs info"
        loading={busy === "needs_info"}
        onConfirm={async () => {
          if (!needsInfoNote.trim()) {
            setNeedsInfoError("Say what information is needed.");
            return;
          }
          setBusy("needs_info");
          const res = await bulkStatus(
            selRows.map((r) => r.id),
            "needs_info",
            needsInfoNote.trim(),
          );
          setBusy(null);
          if (!res) return;
          setNeedsInfoOpen(false);
          setSelected(new Set());
          await onChanged();
          toast(`${res.updated.length} requirement${res.updated.length === 1 ? "" : "s"} marked as needs info.`);
        }}
      >
        <TextArea label="What information is needed?" rows={3} value={needsInfoNote} onChange={(e) => setNeedsInfoNote(e.target.value)} error={needsInfoError} maxLength={500} />
      </ConfirmDialog>

      <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} title="Filters" footer={<Button onClick={() => setSheetOpen(false)}>Show {rows.length} results</Button>}>
        <div className="space-y-4">
          <FilterFields f={f} set={setFilters} sources={sources} />
          <Disclosure label="More filters" defaultOpen={moreCount > 0}>
            <div className="mt-3">
              <MoreFilters f={f} set={setFilters} />
            </div>
          </Disclosure>
          <p className="text-small text-fg-muted">
            Confidence bands: {BAND_TEXT.high} 80% or more, {BAND_TEXT.medium} 50–79%, {BAND_TEXT.low} under 50%.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
