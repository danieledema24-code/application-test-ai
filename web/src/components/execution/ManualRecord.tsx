"use client";

// Manual results (P4-14b; design docs/design/P4-14-manual-results.md): the Start modal (§4.1), the record page with
// one card per case (§4.2), finishing and discarding a recording run (§4.4), the leave guard (§4.5) and the fields the
// change set re-test dialog shares (§4.6). Results count as soon as each one is saved; nothing here runs a test.

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleX, Loader2, PencilLine, UserPen } from "lucide-react";
import { api, API_URL, ApiError, authHeaders, toApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { useOnline } from "@/lib/useOnline";
import { fmtBytes, fmtDateTime, fmtShortDate } from "@/lib/format";
import { claimRouteFocus } from "@/lib/focusReturn";
import { SUITABILITY_TEXT, type AutomationAssessment, type AutomationOverview, type Suitability } from "@/lib/automation";
import type { TestCaseDetail, TestCaseSummary } from "@/lib/contract";
import {
  checkResultFiles,
  defaultSelection,
  finishBlocker,
  scriptedCaseKeys,
  finishedCallout,
  finishCopy,
  manualCounts,
  manualErrors,
  manualFinishedToast,
  manualProgress,
  matchesCase,
  recordedSummary,
  recordStartHref,
  savedAnnouncement,
  savedLine,
  startLabel,
  uploadedFileName,
  FILE_COUNT_ERROR,
  MANUAL_ACCEPT,
  MANUAL_MAX_CASES,
  MANUAL_MAX_FILES,
  MANUAL_MAX_TEXT,
  MANUAL_OFFLINE,
  NO_DEFECT_MANUAL,
  STATUS_WORD,
  type ManualStatus,
  type ResultDetail,
  type ResultEvidence,
  type RunDetail,
  type RunList,
  type StartCase,
  type TestRow,
} from "@/lib/execution";
import { Button, Callout, Checkbox, ConfirmDialog, Disclosure, EmptyState, ErrorState, LinkButton, Modal, Segmented, Skeleton, TextArea, TextField, TONE_CLASSES, useToast } from "@/components/ui";
import { DefectStatusPill, ResultStatus, RunStatusPill } from "@/components/domain/ExecutionLabels";
import { RunMenu } from "@/components/execution/RunMenu";
import { useAllTestCases } from "@/components/testcases/hooks";

const link = "font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900";
const cardHeadingId = (caseKey: string) => `card-${caseKey}-h`;
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Focuses a card's h2 (jump links, "Go to TC-0033", "Edit in RUN-0005"). */
function focusCard(caseKey: string) {
  const h = document.getElementById(cardHeadingId(caseKey));
  if (!h) return false;
  h.scrollIntoView({ block: "start" });
  h.focus();
  return true;
}

// ---- Shared fields (record card and change set re-test dialog) ----------------------------------------------------

export type ManualFieldErrors = { status?: string; actual_result?: string; notes?: string };

/**
 * Result radios (native fieldset/legend), What happened (required) and, when `onNotes` is given, Notes. The record
 * card adds Files below; the re-test dialog passes `statuses={["passed", "failed"]}` and no notes.
 */
export function ManualResultFields({
  caseKey,
  statuses,
  status,
  onStatus,
  what,
  onWhat,
  notes,
  onNotes,
  errors,
  readOnly,
  firstRadioRef,
  whatRef,
  notesRef,
  whatHint = "What you did and what you saw.",
}: {
  caseKey: string;
  statuses: ManualStatus[];
  status: ManualStatus | null;
  onStatus: (s: ManualStatus) => void;
  what: string;
  onWhat: (v: string) => void;
  notes?: string;
  onNotes?: (v: string) => void;
  errors: ManualFieldErrors;
  readOnly?: boolean;
  firstRadioRef?: React.Ref<HTMLInputElement>;
  whatRef?: React.Ref<HTMLTextAreaElement>;
  notesRef?: React.Ref<HTMLTextAreaElement>;
  whatHint?: string;
}) {
  const id = useId();
  const statusErr = `${id}-status-error`;
  const blockedHint = `${id}-blocked-hint`;
  const counter = (v: string) => `${v.length.toLocaleString("en-GB")} of ${MANUAL_MAX_TEXT.toLocaleString("en-GB")}`;
  return (
    <div className="space-y-4">
      <fieldset aria-describedby={[errors.status ? statusErr : null, statuses.includes("blocked") ? blockedHint : null].filter(Boolean).join(" ") || undefined}>
        <legend className="mb-1 text-body font-medium text-fg-strong">
          Result for {caseKey}
          <span className="text-danger-fg" aria-hidden>
            {" "}
            *
          </span>
        </legend>
        <div className="flex flex-wrap gap-x-6">
          {statuses.map((s, i) => (
            <label key={s} className="flex min-h-6 cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
              <input
                ref={i === 0 ? firstRadioRef : undefined}
                type="radio"
                name={`${id}-status`}
                className="h-4 w-4"
                checked={status === s}
                onChange={() => onStatus(s)}
                disabled={readOnly}
                required
              />
              {STATUS_WORD[s]}
            </label>
          ))}
        </div>
        {statuses.includes("blocked") && (
          <p id={blockedHint} className="mt-1 text-small text-fg-muted">
            Blocked means you couldn&apos;t test it. It doesn&apos;t count as execution evidence.
          </p>
        )}
        {errors.status && (
          <p id={statusErr} className="mt-1 text-small font-medium text-danger-fg">
            {errors.status}
          </p>
        )}
      </fieldset>
      <div>
        <TextArea
          ref={whatRef}
          label="What happened"
          required
          aria-required
          rows={3}
          maxLength={MANUAL_MAX_TEXT}
          value={what}
          onChange={(e) => onWhat(e.target.value)}
          error={errors.actual_result}
          hint={whatHint}
          readOnly={readOnly}
        />
        <p className="mt-0.5 text-right text-caption tabular-nums text-fg-muted" aria-hidden>
          {counter(what)}
        </p>
      </div>
      {onNotes && (
        <div>
          <TextArea
            ref={notesRef}
            label="Notes"
            rows={2}
            maxLength={MANUAL_MAX_TEXT}
            value={notes ?? ""}
            onChange={(e) => onNotes(e.target.value)}
            error={errors.notes}
            hint="Optional. For example, the browser and device you used."
            readOnly={readOnly}
          />
          <p className="mt-0.5 text-right text-caption tabular-nums text-fg-muted" aria-hidden>
            {counter(notes ?? "")}
          </p>
        </div>
      )}
    </div>
  );
}

// ---- Start modal (§4.1) -------------------------------------------------------------------------------------------

type Filter = "needs" | "all";
type StartRow = StartCase & { suitability: Suitability | null; summary: TestCaseSummary };

function lastResultText(c: TestCaseSummary): string {
  const r = c.last_result;
  if (!r) return "Last result: Not run yet";
  const word = STATUS_WORD[r.status as ManualStatus] ?? r.status.charAt(0).toUpperCase() + r.status.slice(1);
  return r.manual ? `Last result: ${word} · By hand, ${r.recorded_by || "someone"} · ${fmtShortDate(r.at)}` : `Last result: ${word} · ${r.run_key} · ${fmtShortDate(r.at)}`;
}

export function ManualStartDialog({
  open,
  onClose,
  projectId,
  prefill,
  changeSetKey,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  prefill?: string[] | null;
  changeSetKey?: string | null;
  onCreated: (run: RunDetail) => void;
}) {
  const { user } = useAuth();
  const online = useOnline();
  const cases = useAllTestCases(projectId, null, open);
  const assessment = useApi<AutomationAssessment>(open ? `/projects/${projectId}/automation/assessment` : null, undefined, { shouldRetryOnError: false });
  const recording = useApi<RunList>(open ? `/projects/${projectId}/execution-runs` : null, { status: "recording", limit: 100 }, { shouldRetryOnError: false });
  // "Has a script" comes from the current scripts bundle, not from suitability (a suitable case may have no script yet).
  const automation = useApi<AutomationOverview>(open ? `/projects/${projectId}/automation` : null, undefined, { shouldRetryOnError: false });
  const scripted = useMemo(() => scriptedCaseKeys(automation.data?.bundle?.scripts), [automation.data]);
  const [filter, setFilter] = useState<Filter>("needs");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  // The refusal takes focus once it is on screen (§6).
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const allRef = useRef<HTMLInputElement>(null);
  const initialised = useRef(false);

  const loaded = !!cases.data && (assessment.data !== undefined || assessment.error !== undefined);
  const rows = useMemo<StartRow[]>(() => {
    const suit = new Map((assessment.data?.cases ?? []).map((c) => [c.key, c.suitability]));
    return (cases.data ?? [])
      .filter((c) => c.status === "approved")
      .map((c) => ({ key: c.key, title: c.title, suitability: suit.get(c.key) ?? null, needsPerson: suit.get(c.key) === "manual_only", lastStatus: c.last_result?.status ?? null, summary: c }));
  }, [cases.data, assessment.data]);
  const alsoIn = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of recording.data?.items ?? []) if (r.status === "recording") for (const k of r.selection?.case_keys ?? []) m.set(k, [...(m.get(k) ?? []), r.key]);
    return m;
  }, [recording.data]);
  const mine = (recording.data?.items ?? []).find((r) => r.status === "recording" && r.requested_by?.id && r.requested_by.id === user?.id);

  // Defaults once the cases are known (§4.1): the prefilled cases (filter "All" if one of them doesn't need a person),
  // else the "Needs a person" cases without a passed or failed result.
  useEffect(() => {
    if (!open) {
      initialised.current = false;
      return;
    }
    if (initialised.current || !loaded) return;
    initialised.current = true;
    setSelected(defaultSelection(rows, prefill));
    setFilter(prefill?.length && prefill.some((k) => !rows.find((r) => r.key === k)?.needsPerson) ? "all" : "needs");
    setQ("");
    setError(null);
  }, [open, loaded, rows, prefill]);

  const needs = rows.filter((r) => r.needsPerson);
  const pool = filter === "needs" ? needs : rows;
  const shown = pool.filter((r) => matchesCase(r, q));
  const shownSelected = shown.filter((r) => selected.includes(r.key)).length;
  const full = selected.length >= MANUAL_MAX_CASES;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = shownSelected > 0 && shownSelected < shown.length;
  }, [shownSelected, shown.length]);
  useEffect(() => {
    if (open && loaded) setAnnounce(`Showing ${shown.length} ${plural(shown.length, "case")}.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the filter or search changes
  }, [filter, q]);

  function toggle(key: string, on: boolean) {
    setSelected((s) => (on ? (s.includes(key) || s.length >= MANUAL_MAX_CASES ? s : [...s, key]) : s.filter((k) => k !== key)));
  }
  function toggleAll(on: boolean) {
    setSelected((s) => {
      if (!on) return s.filter((k) => !shown.some((r) => r.key === k));
      const add = shown.map((r) => r.key).filter((k) => !s.includes(k));
      return [...s, ...add].slice(0, Math.max(s.length, MANUAL_MAX_CASES));
    });
  }

  const reason = !selected.length ? "Choose at least one case." : !online ? "You're offline. Reconnect to start recording." : null;
  async function start() {
    if (reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api<RunDetail>(`/projects/${projectId}/execution-runs`, { method: "POST", body: { mode: "manual", case_keys: selected, ...(changeSetKey ? { change_set_key: changeSetKey } : {}) } });
      onCreated(run);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "network" ? "You're offline. Reconnect to start recording." : e instanceof ApiError ? e.message : "Couldn't start recording. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const noCases = loaded && rows.length === 0;
  const footer = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <p className="mr-auto text-small text-fg" id="manual-start-count">
        {full ? "100 selected. That's the most one run can hold." : `${selected.length} selected (up to ${MANUAL_MAX_CASES})`}
        {reason && (
          <span id="manual-start-reason" className="block text-fg-muted">
            {reason}
          </span>
        )}
      </p>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button
        onClick={() => void start()}
        aria-disabled={!!reason || noCases || busy || undefined}
        aria-busy={busy || undefined}
        aria-describedby={reason ? "manual-start-reason" : undefined}
        icon={busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : undefined}
      >
        {startLabel(selected.length)}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Record manual results" description="You test the site yourself and record what happened. Nothing runs on the platform, so this doesn't need Gate 7." footer={footer}>
      <div className="space-y-4">
        {changeSetKey && <p className="text-body text-fg">Recording re-tests after {changeSetKey}. They count for its impact and release readiness.</p>}
        {mine && (
          <Callout tone="info" actions={<LinkButton href={`/projects/${projectId}/execution/${mine.key}/record`}>Continue {mine.key}</LinkButton>}>
            You&apos;re already recording {mine.key} ({manualProgress(mine).recorded} of {manualProgress(mine).tests} recorded).
          </Callout>
        )}
        {cases.error && !cases.data ? (
          <ErrorState error={cases.error} title="Couldn’t load the test cases." message="Try again." onRetry={() => void cases.mutate()} />
        ) : !loaded ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : noCases ? (
          <EmptyState
            title="No approved test cases yet. Approve test cases at Gate 5 to record results for them."
            action={<LinkButton href={`/projects/${projectId}/test-cases`}>Open Test Cases</LinkButton>}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mb-1 text-body font-medium text-fg-strong" id="manual-show">
                  Show
                </p>
                <Segmented
                  label="Show"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "needs", label: `Needs a person (${needs.length})` },
                    { value: "all", label: `All approved cases (${rows.length})` },
                  ]}
                />
              </div>
              <TextField label="Find a case" value={q} onChange={(e) => setQ(e.target.value)} placeholder="TC id or title" wrapClassName="w-full sm:w-64" />
            </div>
            <p role="status" aria-live="polite" className="sr-only">
              {announce}
            </p>
            {filter === "needs" && needs.length === 0 ? (
              <p className="text-body text-fg">
                No approved case needs a person. Show all approved cases to record one by hand.{" "}
                <Button size="sm" variant="secondary" onClick={() => setFilter("all")}>
                  Show all approved cases
                </Button>
              </p>
            ) : shown.length === 0 ? (
              <p className="text-body text-fg">No approved case matches &apos;{q.trim()}&apos;.</p>
            ) : (
              <div className="space-y-2">
                <label className="flex min-h-6 items-center gap-2.5 text-body font-medium text-fg-strong pointer-coarse:min-h-11">
                  <input ref={allRef} type="checkbox" className="h-5 w-5" checked={shown.length > 0 && shownSelected === shown.length} onChange={(e) => toggleAll(e.target.checked)} />
                  Select all shown ({shown.length})
                </label>
                <ul className="space-y-2" aria-label="Approved test cases">
                  {shown.map((r) => {
                    const on = selected.includes(r.key);
                    const hasScript = scripted.has(r.key);
                    const others = alsoIn.get(r.key) ?? [];
                    return (
                      <li key={r.key} className="rounded-md px-2 py-1.5 ring-1 ring-inset ring-line">
                        <Checkbox
                          className="min-h-6 pointer-coarse:min-h-11"
                          checked={on}
                          aria-disabled={!on && full ? true : undefined}
                          onChange={(e) => toggle(r.key, e.target.checked)}
                          label={
                            <span className="break-words">
                              <span className="sr-only">Select </span>
                              <span className="font-mono">{r.key}</span> {r.title}
                            </span>
                          }
                          description={
                            <>
                              <span className="block">
                                {r.suitability ? SUITABILITY_TEXT[r.suitability] : "Not assessed"} · {lastResultText(r.summary)}
                              </span>
                              {others.map((k) => (
                                <span key={k} className="block">
                                  Also in {k} (recording)
                                </span>
                              ))}
                              {on && hasScript && <span className="block text-fg">Has a script. A result you record replaces its latest automated result.</span>}
                            </>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
        {error && (
          <div ref={errorRef} tabIndex={-1} className="focus:outline-none">
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- Files (§4.2) -------------------------------------------------------------------------------------------------

type QueuedFile = { id: string; file: File; state: "queued" | "uploading" | "failed"; pct: number; error: string | null; retry: boolean };

function uploadResultFile(resultId: string, file: File, onProgress: (pct: number) => void): Promise<{ message: string; evidence: ResultEvidence; result: ResultDetail }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/execution-results/${resultId}/evidence`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as { message: string; evidence: ResultEvidence; result: ResultDetail });
      else reject(toApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Upload failed."));
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  });
}

/** Uploaded files of a result: "sign-in-form.png · 412 KB · Uploaded [Open sign-in-form.png]". */
function UploadedFiles({ evidence, names, caseKey }: { evidence: ResultEvidence[]; names: Record<string, string>; caseKey: string }) {
  if (!evidence.length) return null;
  return (
    <ul className="space-y-1 text-small text-fg">
      {evidence.map((e, i) => {
        const name = names[e.id] ?? uploadedFileName(e, i);
        return (
          <li key={e.id} className="flex flex-wrap items-center gap-x-2 break-words">
            <span className="break-all">{name}</span>
            <span className="text-fg-muted">
              · {fmtBytes(e.size)} · {e.removed ? "Removed" : "Uploaded"}
            </span>
            {!e.removed && (
              <a href={e.content_url} target="_blank" rel="noreferrer" className={`${link} inline-flex min-h-6 items-center`}>
                Open {name}
                <span className="sr-only"> from {caseKey} (opens in a new tab)</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---- Record card (§4.2) -------------------------------------------------------------------------------------------

type Saved = { status: ManualStatus; what: string; notes: string };

function savedOf(row: TestRow): Saved | null {
  if (!row.id || !["passed", "failed", "blocked"].includes(row.status)) return null;
  return { status: row.status as ManualStatus, what: row.actual_result ?? "", notes: row.notes ?? "" };
}

export function ManualResultCard({
  row,
  run,
  projectId,
  meId,
  onSaved,
  onDirty,
  onUploading,
  announce,
}: {
  row: TestRow;
  run: RunDetail;
  projectId: string;
  meId: string | null;
  onSaved: (run: RunDetail) => void;
  onDirty: (caseKey: string, dirty: boolean) => void;
  onUploading: (caseKey: string, n: number) => void;
  announce: (text: string) => void;
}) {
  const online = useOnline();
  const caseKey = row.case_key;
  const detail = useApi<TestCaseDetail>(row.test_case_id ? `/test-cases/${row.test_case_id}` : null, undefined, { shouldRetryOnError: false });
  const result = useApi<ResultDetail>(row.id ? `/projects/${projectId}/execution-results/by-key/${row.key}` : null, undefined, { shouldRetryOnError: false });
  const [saved, setSaved] = useState<Saved | null>(() => savedOf(row));
  const [status, setStatus] = useState<ManualStatus | null>(saved?.status ?? null);
  const [what, setWhat] = useState(saved?.what ?? "");
  const [notes, setNotes] = useState(saved?.notes ?? "");
  const [errors, setErrors] = useState<ManualFieldErrors>({});
  const [serverError, setServerError] = useState<{ text: string; retry: boolean } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(row.recorded_at ?? null);
  const [stepsOpen, setStepsOpen] = useState(!row.id);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const firstRadio = useRef<HTMLInputElement>(null);
  const whatRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const uid = useId();

  // A result saved elsewhere (another tab, a reload after 403) replaces the baseline when this card has no edits.
  const rowSaved = savedOf(row);
  const rowSig = JSON.stringify(rowSaved);
  const valuesDirty = !!status && (!saved || saved.status !== status || saved.what !== what || saved.notes !== notes);
  const typedDirty = !saved && (!!status || !!what.trim() || !!notes.trim());
  const pending = queue.filter((f) => f.state === "queued").length;
  const dirty = valuesDirty || typedDirty || pending > 0;
  useEffect(() => {
    if (dirty || saving) return;
    const s = rowSaved;
    setSaved(s);
    setStatus(s?.status ?? null);
    setWhat(s?.what ?? "");
    setNotes(s?.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the server's saved values change
  }, [rowSig]);
  useEffect(() => onDirty(caseKey, dirty), [caseKey, dirty, onDirty]);
  const uploading = queue.filter((f) => f.state === "uploading").length;
  useEffect(() => onUploading(caseKey, uploading), [caseKey, uploading, onUploading]);

  const recording = run.status === "recording";
  const recorder = row.recorded_by ?? null;
  const othersResult = !!row.id && !!recorder && recorder.id !== meId;
  const editable = recording && !!run.permissions.can_record && !othersResult && !conflict;
  const evidence = result.data?.evidence ?? [];
  const fileSlots = MANUAL_MAX_FILES - evidence.length - queue.length;
  const defect = row.defect ?? result.data?.defect ?? null;

  function pickFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = "";
    if (!files.length) return;
    const { accepted, errors: errs } = checkResultFiles(files, evidence.length + queue.length);
    setFileErrors(errs);
    if (errs.length) announce(errs.join(" "));
    if (accepted.length) setQueue((q) => [...q, ...accepted.map((f, i) => ({ id: `${Date.now()}-${i}-${f.name}`, file: f, state: "queued" as const, pct: 0, error: null, retry: false }))]);
  }

  const uploadOne = useCallback(
    async (resultId: string, item: QueuedFile) => {
      setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, state: "uploading", pct: 0, error: null } : x)));
      try {
        const res = await uploadResultFile(resultId, item.file, (pct) => setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, pct } : x))));
        setNames((n) => ({ ...n, [res.evidence.id]: item.file.name }));
        setQueue((q) => q.filter((x) => x.id !== item.id));
        await result.mutate(res.result, { revalidate: false });
        announce(`${item.file.name} uploaded.`);
      } catch (e) {
        const err = e instanceof ApiError ? e : null;
        const known = err && (err.status === 422 || err.status === 409 || err.status === 429 || err.status === 403);
        const text = known ? `${item.file.name}: ${err!.message}` : `${item.file.name} didn't upload. The result is saved. Try again.`;
        setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, state: "failed", error: text, retry: !known || err!.status === 429 } : x)));
        announce(text);
      }
    },
    [announce, result],
  );

  async function save() {
    if (saving) return;
    const errs = manualErrors(status, what);
    setErrors(errs);
    setServerError(null);
    if (errs.status) return firstRadio.current?.focus();
    if (errs.actual_result) return whatRef.current?.focus();
    if (!dirty) return;
    if (!online) return setServerError({ text: MANUAL_OFFLINE, retry: false });
    setSaving(true);
    let fieldFocused = false;
    try {
      let resultId = row.id;
      if (valuesDirty || typedDirty) {
        const res = await api<{ message: string; result: ResultDetail; run: RunDetail }>(`/execution-runs/${run.id}/results/${caseKey}`, {
          method: "PUT",
          body: { status, actual_result: what.trim(), notes: notes.trim() || null },
        });
        const next: Saved = { status: status!, what: what.trim(), notes: notes.trim() };
        setSaved(next);
        setWhat(next.what);
        setNotes(next.notes);
        setSavedAt(res.result.recorded_at ?? res.run.tests_rows.find((r) => r.case_key === caseKey)?.recorded_at ?? null);
        if (!saved) setStepsOpen(false);
        resultId = res.result.id;
        await result.mutate(res.result, { revalidate: false });
        onSaved(res.run);
        const c = manualCounts(res.run.tests_rows);
        announce(savedAnnouncement(caseKey, next.status, c.recorded, c.total));
      }
      for (const item of queue.filter((f) => f.state === "queued")) if (resultId) await uploadOne(resultId, item);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === "network") setServerError({ text: MANUAL_OFFLINE, retry: false });
      else if (err?.status === 422) {
        const f = err.fieldErrors;
        const next: ManualFieldErrors = { status: f.status, actual_result: f.actual_result, notes: f.notes };
        if (next.status || next.actual_result || next.notes) {
          setErrors(next);
          fieldFocused = true;
          if (next.status) firstRadio.current?.focus();
          else if (next.actual_result) whatRef.current?.focus();
          else notesRef.current?.focus();
        } else setServerError({ text: err.message, retry: false });
      } else if (err?.status === 403) setServerError({ text: err.message, retry: false });
      else if (err?.status === 409) setConflict(err.message);
      else setServerError({ text: `Couldn't save ${caseKey}. ${err?.message ?? "Try again."}`, retry: true });
      if (err && (err.status === 403 || err.status === 409)) onSaved(run); // ask the page to reload the run
    } finally {
      setSaving(false);
      // Focus stays on Save (§8) unless a field took it. Safari doesn't focus a clicked button, so move it there.
      if (!fieldFocused) saveRef.current?.focus();
    }
  }

  const chip = (() => {
    if (!row.id || !saved) {
      if (!recording) return <ResultStatus status="not_run" />;
      return <ResultStatus status="not_recorded" />;
    }
    if (!editable)
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ResultStatus status={saved.status} />
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium ring-1 ring-inset ${TONE_CLASSES.grey}`}>
            <UserPen className="h-3.5 w-3.5" aria-hidden />
            Recorded by {recorder?.full_name ?? "someone"}
          </span>
        </span>
      );
    if (valuesDirty || pending)
      return (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium ring-1 ring-inset ${TONE_CLASSES.amber}`}>
          <PencilLine className="h-3.5 w-3.5" aria-hidden />
          Unsaved changes
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1">
        <span className="text-caption text-fg-muted">Saved ·</span>
        <ResultStatus status={saved.status} />
      </span>
    );
  })();

  const steps = detail.data;
  const savedWhen = savedAt ? fmtDateTime(savedAt) : null;
  const recordedLine = recorder ? `Recorded by ${recorder.full_name}${savedWhen ? `, ${savedWhen}` : ""}.` : null;
  return (
    <section aria-labelledby={cardHeadingId(caseKey)} className="min-w-0 space-y-4 rounded-xl bg-surface p-4 ring-1 ring-line-strong sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={cardHeadingId(caseKey)} tabIndex={-1} className="min-w-0 break-words text-h3 font-semibold text-fg-strong focus:outline-none">
          <span className="font-mono">{caseKey}</span> {row.title}
        </h2>
        {chip}
      </div>
      <Disclosure label="Steps and expected result" open={stepsOpen} onOpenChange={setStepsOpen}>
        {detail.error && !steps ? (
          <p className="mt-2 text-body text-fg-muted">Couldn&apos;t load the steps. Open {caseKey} in Test Cases to read them.</p>
        ) : !steps ? (
          <Skeleton className="mt-2 h-20" />
        ) : (
          <div className="mt-2 space-y-2 text-body text-fg">
            {steps.preconditions?.length > 0 && <p>Preconditions: {steps.preconditions.join(" · ")}</p>}
            <ol className="space-y-1">
              {steps.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-1 break-words">
                  <span className="tabular-nums text-fg-muted">{s.n ?? i + 1}.</span>
                  <span>
                    {s.action}
                    {s.expected?.trim() && <span className="block text-small text-fg-muted">Expected: {s.expected}</span>}
                  </span>
                </li>
              ))}
            </ol>
            <p className="break-words">
              <span className="font-medium text-fg-strong">
                Expected result ({caseKey} v{steps.version}):
              </span>{" "}
              {steps.expected_result || "None"}
            </p>
          </div>
        )}
      </Disclosure>

      {editable || conflict ? (
        <>
          <ManualResultFields
            caseKey={caseKey}
            statuses={["passed", "failed", "blocked"]}
            status={status}
            onStatus={(s) => {
              setStatus(s);
              setErrors((e) => ({ ...e, status: undefined }));
            }}
            what={what}
            onWhat={setWhat}
            notes={notes}
            onNotes={setNotes}
            errors={errors}
            readOnly={!!conflict}
            firstRadioRef={firstRadio}
            whatRef={whatRef}
            notesRef={notesRef}
          />
          {!conflict && (
            <div className="space-y-2">
              <p className="text-body font-medium text-fg-strong">Files</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <input ref={fileInput} type="file" multiple accept={MANUAL_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => pickFiles(e.target.files)} />
                <Button
                  variant="secondary"
                  size="sm"
                  aria-describedby={`${uid}-files-hint`}
                  aria-disabled={fileSlots <= 0 || undefined}
                  onClick={() => (fileSlots <= 0 ? (setFileErrors([FILE_COUNT_ERROR]), announce(FILE_COUNT_ERROR)) : fileInput.current?.click())}
                  className="w-full sm:w-auto"
                >
                  Add files…<span className="sr-only"> to {caseKey}</span>
                </Button>
                <span id={`${uid}-files-hint`} className="text-small text-fg-muted">
                  PNG, JPEG or PDF · up to 10 MB each · up to 5 files.
                </span>
              </div>
              <p className="text-small text-fg-muted">Files can&apos;t be removed once uploaded; they&apos;re kept as evidence.</p>
              {fileErrors.length > 0 && (
                <ul className="space-y-0.5">
                  {fileErrors.map((m) => (
                    <li key={m} className="flex items-start gap-1.5 break-words text-small font-medium text-danger-fg">
                      <CircleX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      {m}
                    </li>
                  ))}
                </ul>
              )}
              <UploadedFiles evidence={evidence} names={names} caseKey={caseKey} />
              {queue.length > 0 && (
                <ul className="space-y-1 text-small">
                  {queue.map((f) => (
                    <li key={f.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 break-words ${f.state === "failed" ? "text-danger-fg" : "text-fg"}`}>
                      {f.state === "failed" && <CircleX className="h-4 w-4 shrink-0" aria-hidden />}
                      <span className="break-all">{f.file.name}</span>
                      <span className={f.state === "failed" ? "font-medium" : "text-fg-muted"}>
                        · {fmtBytes(f.file.size)} · {f.state === "queued" ? "Will upload when you save" : f.state === "uploading" ? `Uploading ${f.file.name}… ${f.pct}%` : f.error}
                      </span>
                      {f.state === "queued" && (
                        <Button size="sm" variant="ghost" onClick={() => setQueue((q) => q.filter((x) => x.id !== f.id))}>
                          Remove {f.file.name}
                          <span className="sr-only"> from {caseKey}</span>
                        </Button>
                      )}
                      {f.state === "failed" && f.retry && row.id && (
                        <Button size="sm" variant="secondary" onClick={() => void uploadOne(row.id!, f)}>
                          Try again<span className="sr-only"> to upload {f.file.name}</span>
                        </Button>
                      )}
                      {f.state === "failed" && !f.retry && (
                        <Button size="sm" variant="ghost" onClick={() => setQueue((q) => q.filter((x) => x.id !== f.id))}>
                          Remove {f.file.name}
                          <span className="sr-only"> from {caseKey}</span>
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {serverError && (
            <Callout
              tone="danger"
              role="alert"
              actions={
                serverError.retry ? (
                  <Button size="sm" variant="secondary" onClick={() => void save()}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              {serverError.text}
            </Callout>
          )}
          {conflict ? (
            <Callout tone="info" role="alert">
              {conflict}
            </Callout>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Button
                ref={saveRef}
                onClick={() => void save()}
                aria-disabled={(!!saved && !dirty) || saving || undefined}
                aria-busy={saving || undefined}
                icon={saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : undefined}
                className="w-full sm:w-auto"
              >
                {saving ? "Saving…" : saved ? "Save changes" : "Save result"}
                <span className="sr-only"> for {caseKey}</span>
              </Button>
              {saved && <span className="text-small text-fg">{savedLine(saved.status, recorder?.full_name, savedWhen)}</span>}
            </div>
          )}
        </>
      ) : saved ? (
        <div className="space-y-2 text-body text-fg">
          <div>
            <p className="font-medium text-fg-strong">What happened</p>
            <p className="whitespace-pre-wrap break-words">{saved.what || "—"}</p>
          </div>
          <div>
            <p className="font-medium text-fg-strong">Notes</p>
            <p className="whitespace-pre-wrap break-words">{saved.notes || "No notes."}</p>
          </div>
          <div>
            <p className="font-medium text-fg-strong">Files</p>
            {evidence.length ? <UploadedFiles evidence={evidence} names={names} caseKey={caseKey} /> : <p className="text-fg-muted">No files were added.</p>}
          </div>
          {recordedLine && <p className="text-small text-fg-muted">{recording ? `${recordedLine} Only they can change it until ${run.key} is finished.` : recordedLine}</p>}
        </div>
      ) : (
        <p className="text-body text-fg-muted">{recording ? "Not recorded yet." : "Not run: nothing was recorded for this case."}</p>
      )}

      {saved && (saved.status === "failed" || saved.status === "blocked") &&
        (defect ? (
          <p className="flex flex-wrap items-center gap-2 text-body text-fg">
            <span className="font-mono">{defect.key}</span> · <DefectStatusPill status={defect.status} />
            <Link href={`/projects/${projectId}/defects/${defect.key}`} className={`${link} inline-flex min-h-6 items-center`}>
              Open {defect.key}
            </Link>
          </p>
        ) : (
          <Callout
            tone="info"
            actions={
              <LinkButton href={`/projects/${projectId}/defects/new?from=${row.key}`} size="sm" className="w-full sm:w-auto">
                Raise defect…<span className="sr-only"> from {caseKey} result</span>
              </LinkButton>
            }
          >
            {NO_DEFECT_MANUAL}
          </Callout>
        ))}
    </section>
  );
}

// ---- Record page (§4.2, §4.4, §4.5, §6) ---------------------------------------------------------------------------

export function ManualRecordPage({ projectId, runKey, onRefreshProject }: { projectId: string; runKey: string; onRefreshProject: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { role, user } = useAuth();
  const viewer = role === "viewer";
  const q = useApi<RunDetail>(`/projects/${projectId}/execution-runs/by-key/${runKey}`, undefined, { shouldRetryOnError: false });
  const run = q.data;
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [announcement, setAnnouncement] = useState("");
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const runPage = `/projects/${projectId}/execution/${runKey}`;

  // Viewers and automated runs read the run page instead (§6).
  useEffect(() => {
    if (!run) return;
    if (viewer || run.mode !== "manual") router.replace(runPage);
  }, [run, viewer, router, runPage]);

  useEffect(() => {
    document.title = `Record manual results · ${runKey} · QA Analyst`;
  }, [runKey]);

  // `#TC-0033` (from a result's [Edit in RUN-0005]): focus that card once the run is loaded.
  const jumped = useRef(false);
  useEffect(() => {
    if (!run || jumped.current) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    jumped.current = true;
    if (hash && run.tests_rows.some((r) => r.case_key === hash)) {
      claimRouteFocus(window.location.pathname);
      setTimeout(() => focusCard(hash), 0);
    }
  }, [run]);

  const onDirty = useCallback((k: string, v: boolean) => setDirty((d) => (d[k] === v ? d : { ...d, [k]: v })), []);
  const onUploading = useCallback((k: string, n: number) => setUploads((u) => (u[k] === n ? u : { ...u, [k]: n })), []);
  const announce = useCallback((t: string) => {
    // Re-announce identical text: clear first.
    setAnnouncement("");
    setTimeout(() => setAnnouncement(t), 30);
  }, []);
  const dirtyKeys = Object.keys(dirty).filter((k) => dirty[k]);
  const uploading = Object.values(uploads).reduce((a, b) => a + b, 0);
  const anyDirty = dirtyKeys.length > 0;

  // Leave guard (§4.5): reload/close prompt and in-app links while a card has unsaved changes.
  useEffect(() => {
    if (!anyDirty) return;
    const before = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("click", onClick, true);
    };
  }, [anyDirty]);

  // Browser Back (§4.5): while a card is dirty an extra entry for this same URL sits on top of the history, so Back only
  // pops it; we put it back and ask. "Leave without saving" then goes back past both entries.
  const sentinel = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = anyDirty;
  useEffect(() => {
    if (!anyDirty || sentinel.current) return;
    window.history.pushState(window.history.state, "", window.location.href);
    sentinel.current = true;
  }, [anyDirty]);
  useEffect(() => {
    const onPop = () => {
      if (!sentinel.current) return;
      sentinel.current = false;
      if (dirtyRef.current) {
        window.history.pushState(window.history.state, "", window.location.href);
        sentinel.current = true;
        // After the router has handled this popstate, so its re-render can't take focus from [Stay].
        setTimeout(() => setLeaveTo(LEAVE_BACK), 0);
      } else window.history.back(); // saved since: the extra entry is spent, carry on back
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const back = (
    <Link href={runPage} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
      <ArrowLeft className="h-4 w-4" aria-hidden /> {runKey}
    </Link>
  );

  if (q.error && !run) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return <EmptyState title={`We couldn’t find ${runKey} in this project.`} action={<LinkButton href={`/projects/${projectId}/execution`}>Back to Test Execution</LinkButton>} />;
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={q.error} title={`Couldn’t load ${runKey}.`} message="Try again." onRetry={() => void q.mutate()} />
      </div>
    );
  }
  if (!run || viewer || run.mode !== "manual")
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );

  const rows = run.tests_rows;
  const counts = manualCounts(rows);
  const recording = run.status === "recording";
  const starter = run.requested_by?.full_name || run.requested_by?.email || "someone";
  const blocker = finishBlocker(counts.recorded, uploading);
  const notRecorded = rows.filter((r) => !r.id).map((r) => r.case_key);
  const copy = finishCopy(run.key, notRecorded, run.requested_by?.id && run.requested_by.id !== user?.id ? starter : null);
  const canDiscard = recording && counts.recorded === 0 && run.permissions.can_cancel;

  async function finish() {
    if (!run) return;
    setFinishing(true);
    try {
      const res = await api<{ message: string; run: RunDetail }>(`/execution-runs/${run.id}/finish`, { method: "POST" });
      await q.mutate(res.run, { revalidate: false });
      setFinishOpen(false);
      toast(manualFinishedToast(run.key, manualCounts(res.run.tests_rows)), "success");
      onRefreshProject();
      router.push(runPage);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t finish. Try again.", "error");
      setFinishOpen(false);
      void q.mutate();
    } finally {
      setFinishing(false);
    }
  }
  async function discard() {
    if (!run) return;
    setDiscarding(true);
    try {
      const res = await api<{ message: string; run: RunDetail }>(`/execution-runs/${run.id}/cancel`, { method: "POST" });
      await q.mutate(res.run, { revalidate: false });
      setDiscardOpen(false);
      toast(`${run.key} discarded.`, "success");
      onRefreshProject();
      router.push(runPage);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t discard. Try again.", "error");
      setDiscardOpen(false);
      void q.mutate();
    } finally {
      setDiscarding(false);
    }
  }

  const finishButton = (where: "top" | "bottom") =>
    recording && run.permissions.can_record ? (
      <div className="flex flex-col items-start gap-1">
        <Button
          variant={where === "top" ? "primary" : "secondary"}
          aria-disabled={!!blocker || undefined}
          aria-describedby={blocker ? `finish-reason-${where}` : undefined}
          onClick={() => !blocker && setFinishOpen(true)}
          className="w-full sm:w-auto"
        >
          Finish recording…
        </Button>
        {blocker && (
          <p id={`finish-reason-${where}`} className="text-small text-fg-muted">
            {blocker}
          </p>
        )}
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-2">
        <h1 tabIndex={-1} className="break-words text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          Record manual results · {run.key}
        </h1>
        <p className="text-small text-fg-muted">
          By hand · started by {starter}, {fmtDateTime(run.started_at ?? run.created_at)} · {rows.length} {plural(rows.length, "case")}
          {recording ? " · Results count as soon as you save them." : ""}
        </p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-body font-medium text-fg-strong">{recordedSummary(counts)}</p>
          <div className="flex flex-wrap items-start gap-2">
            {finishButton("top")}
            <RunMenu
              projectId={projectId}
              runKey={run.key}
              finished={!recording && run.status !== "cancelled"}
              extra={[
                { label: `Open ${run.key}`, onClick: () => router.push(runPage) },
                ...(canDiscard ? [{ label: `Discard ${run.key}…`, onClick: () => setDiscardOpen(true) }] : []),
              ]}
            />
          </div>
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {run.status === "cancelled" ? (
        <Callout tone="neutral" title={`${run.key} was discarded. Nothing was recorded.`} />
      ) : !recording ? (
        <Callout
          tone="info"
          title={finishedCallout(run, fmtDateTime)}
          actions={<LinkButton href={recordStartHref(projectId)}>Record manual results</LinkButton>}
        />
      ) : null}

      {run.status !== "cancelled" && (
        <>
          <nav aria-labelledby="cases-nav-h" className="space-y-1">
            <h2 id="cases-nav-h" className="text-h3 font-semibold text-fg-strong">
              Cases
            </h2>
            <ol className="list-decimal space-y-0.5 pl-6 text-body">
              {rows.map((r) => {
                const st = r.id ? STATUS_WORD[r.status as ManualStatus] ?? r.status : recording ? "Not recorded yet" : "Not run";
                return (
                  <li key={r.key} className="break-words">
                    <a
                      href={`#${r.case_key}`}
                      aria-label={`${r.case_key} ${r.title}, ${st.toLowerCase()}`}
                      className={`${link} inline-flex min-h-6 items-center`}
                      onClick={(e) => {
                        e.preventDefault();
                        focusCard(r.case_key);
                      }}
                    >
                      {r.case_key} {r.title}
                      <span aria-hidden>&nbsp;— {st}</span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="space-y-4">
            {rows.map((r) => (
              <ManualResultCard
                key={r.key}
                row={r}
                run={run}
                projectId={projectId}
                meId={user?.id ?? null}
                onSaved={(next) => {
                  if (next === run) void q.mutate();
                  else void q.mutate(next, { revalidate: false });
                  onRefreshProject();
                }}
                onDirty={onDirty}
                onUploading={onUploading}
                announce={announce}
              />
            ))}
          </div>
          {finishButton("bottom")}
        </>
      )}

      {/* Finish (§4.4): unsaved changes first, then the confirm. */}
      {finishOpen && anyDirty ? (
        <Modal
          open
          onClose={() => setFinishOpen(false)}
          size="sm"
          title="Save or discard your changes first."
          footer={
            <Button
              onClick={() => {
                setFinishOpen(false);
                setTimeout(() => focusCard(dirtyKeys[0]), 0);
              }}
            >
              Go to {dirtyKeys[0]}
            </Button>
          }
        >
          <p className="text-body text-fg">
            {dirtyKeys.join(", ")} {dirtyKeys.length === 1 ? "has" : "have"} unsaved changes.
          </p>
        </Modal>
      ) : (
        <ConfirmDialog
          open={finishOpen}
          onClose={() => setFinishOpen(false)}
          onConfirm={() => void finish()}
          title={copy.title}
          confirmLabel="Finish recording"
          cancelLabel="Keep recording"
          loading={finishing}
        >
          {copy.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </ConfirmDialog>
      )}
      <ConfirmDialog open={discardOpen} onClose={() => setDiscardOpen(false)} onConfirm={() => void discard()} title={`Discard ${run.key}?`} confirmLabel={`Discard ${run.key}`} cancelLabel="Keep it" danger loading={discarding}>
        Nothing has been recorded in it. It will show as Cancelled.
      </ConfirmDialog>
      <ConfirmDialog
        open={!!leaveTo}
        onClose={() => setLeaveTo(null)}
        onConfirm={() => {
          const to = leaveTo;
          setDirty({});
          setLeaveTo(null);
          if (to === LEAVE_BACK) {
            sentinel.current = false;
            window.history.go(-2);
          } else if (to) setTimeout(() => router.push(to), 0);
        }}
        title="Leave without saving?"
        confirmLabel="Leave without saving"
        cancelLabel="Stay"
        focusCancel
      >
        Your changes to {dirtyKeys.join(", ")} aren&apos;t saved.
      </ConfirmDialog>
    </div>
  );
}

/** `leaveTo` value for the browser's Back button (any in-app target is a path). */
const LEAVE_BACK = "back";

// ---- Run page for a manual run (§4.3) -----------------------------------------------------------------------------

/** Results of a manual run: no authorisation tab, live view, analysis or re-run. Read-only for viewers. */
export function ManualRunView({ run, projectId }: { run: RunDetail; projectId: string }) {
  const { role } = useAuth();
  const viewer = role === "viewer" || role === null;
  const base = `/projects/${projectId}/execution/${run.key}`;
  const rows = run.tests_rows;
  const recording = run.status === "recording";
  const failed = rows.filter((r) => r.id && r.status === "failed");
  const starter = run.requested_by?.full_name || run.requested_by?.email || "someone";
  const statusCell = (r: TestRow) => (
    <span className="flex flex-wrap items-center gap-1.5">
      <ResultStatus status={r.id ? r.status : recording ? "not_recorded" : "not_run"} />
      {r.defect && (
        <span className="text-caption text-fg-muted">
          {r.defect.key} {r.defect.status}
        </span>
      )}
    </span>
  );
  const who = (r: TestRow) => (r.id && r.recorded_by ? `${r.recorded_by.full_name}${r.recorded_at ? ` · ${fmtDateTime(r.recorded_at)}` : ""}` : "—");
  const title = (r: TestRow) =>
    r.id ? (
      <Link href={`${base}/results/${r.key}`} className={link}>
        {r.case_key} {r.title}
        <span className="sr-only"> ({r.key} result)</span>
      </Link>
    ) : (
      <span>
        {r.case_key} {r.title}
      </span>
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {run.key} · Manual
          </h1>
          <RunStatusPill run={run} />
        </div>
        <div className="flex flex-wrap gap-2">
          {recording && !viewer && run.permissions.can_record && (
            <LinkButton href={`${base}/record`} variant="primary">
              Continue recording<span className="sr-only"> {run.key}</span>
            </LinkButton>
          )}
          <RunMenu projectId={projectId} runKey={run.key} finished={!recording && run.status !== "cancelled"} />
        </div>
      </div>
      <p className="text-small text-fg-muted">
        By hand · started by {starter}, {fmtDateTime(run.started_at ?? run.created_at)} · {rows.length} {plural(rows.length, "case")} · No Gate 7: nothing ran on the platform.
      </p>
      {run.status === "cancelled" && <Callout tone="neutral" title={`${run.key} was discarded. Nothing was recorded.`} />}
      {failed.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-body text-fg">
          Failed by hand ({failed.length}): {failed.map((r) => r.case_key).join(", ")}. Not analysed: recorded by a person.
          <Link href={`${base}/results/${failed[0].key}`} className={`${link} inline-flex min-h-6 items-center`}>
            Open {failed[0].key} result
          </Link>
        </p>
      )}
      <section aria-labelledby="manual-results-h" className="space-y-3">
        <h2 id="manual-results-h" className="text-h2 font-semibold text-fg-strong">
          Results ({rows.length})
        </h2>
        <div className="hidden md:block">
          <table className="min-w-full divide-y divide-line text-left text-body" aria-labelledby="manual-results-h">
            <thead>
              <tr>
                {["Test", "Status", "Recorded by · When"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.key} className="align-top">
                  <th scope="row" className="px-3 py-2 font-normal">
                    {title(r)}
                  </th>
                  <td className="px-3 py-2">{statusCell(r)}</td>
                  <td className="px-3 py-2">{who(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="space-y-2 md:hidden" aria-label={`Results (${rows.length})`}>
          {rows.map((r) => (
            <li key={r.key} className="space-y-1 break-words rounded-lg bg-surface p-3 ring-1 ring-line">
              <p>{title(r)}</p>
              {statusCell(r)}
              <p className="text-small text-fg-muted">Recorded by · When: {who(r)}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
