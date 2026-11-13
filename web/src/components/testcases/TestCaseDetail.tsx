"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, ArrowRight, CircleHelp, Lock, MoreHorizontal, PencilLine } from "lucide-react";
import { api, ApiError, buildQuery, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import type { LintItem, RequirementDetail, RequirementSummary, Revision, TestCaseDetail as Detail, TestCaseSummary, TestDataItem, TestStrategy } from "@/lib/contract";
import { fieldChanges } from "@/lib/diff";
import { fmtDateTime } from "@/lib/format";
import {
  AUTOMATION_TEXT,
  PRELIMINARY_TEXT,
  automationReasonText,
  LINT_DEFS,
  SIDE_EFFECT_TEXT,
  SUITE_TEXT,
  CASE_FORM_TECHNIQUES,
  approveBlockReason,
  caseFieldErrors,
  caseFiltersToQuery,
  caseLevelText,
  caseTypeText,
  casePatch,
  filterCases,
  lintName,
  lintPreview,
  lintSeverity,
  newStep,
  isUndecided,
  openQuestionMessage,
  openQuestionText,
  patchHasChanges,
  stepOfPath,
  stepsInput,
  techniqueInfo,
  toCaseForm,
  validateCaseForm,
  type CaseFilters,
  type CaseForm,
} from "@/lib/testcases";
import { Button, Callout, Card, ConfirmDialog, EmptyState, ErrorState, InlineError, LinkButton, SelectField, Skeleton, TextArea, TextField, useToast } from "@/components/ui";
import { newRow, type ChecklistRow } from "@/components/ui/ChecklistEditor";
import { ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems } from "@/components/domain/EvidenceDrawer";
import { DiffView } from "@/components/domain/DiffView";
import { RevisionHistory } from "@/components/domain/RevisionHistory";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { noteGateReopened, useAllRequirements } from "@/components/requirements/hooks";
import { CaseFlags, CaseStatusPill, NotDecided, SeverityText, TechniqueChip } from "./Bits";
import { CaseRejectDialog, DeprecateDialog } from "./Dialogs";
import { PriorityDialog, PrioritySource } from "./Priority";
import { StepEditor } from "./StepEditor";
import { AddTestData, TestDataDrawer } from "./TestData";
import { useAllTestData } from "./hooks";

const EMPTY_FORM: CaseForm = {
  title: "",
  objective: "",
  requirement_ids: [],
  acceptance_criterion_ids: [],
  technique: "",
  preconditions: [],
  steps: [],
  expected_result: "",
  test_type: "functional",
  test_level: "system",
  suites: [],
  reason: "",
};

const NO_CHANGE_HELP = "Labels, risk and checks are worked out by the system from evidence and links.";

function MoreMenu({ items, label }: { items: { label: string; onClick?: () => void; href?: string; hidden?: boolean }[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const cls = "flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay";
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="px-2.5">
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-64 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          {items
            .filter((i) => !i.hidden)
            .map((i) =>
              i.href ? (
                <Link key={i.label} role="menuitem" href={i.href} className={cls} onClick={() => setOpen(false)}>
                  {i.label}
                </Link>
              ) : (
                <button
                  key={i.label}
                  role="menuitem"
                  type="button"
                  className={cls}
                  onClick={() => {
                    setOpen(false);
                    i.onClick?.();
                  }}
                >
                  {i.label}
                </button>
              ),
            )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-small font-medium text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-body text-fg">{children}</dd>
    </div>
  );
}

function Refs({ refs, projectId, kind }: { refs: { key: string; label: string }[]; projectId: string; kind: "requirements" | "risk" | "ac" | "condition" }) {
  if (!refs.length) return <span className="text-fg-muted">None</span>;
  return (
    <ul className="space-y-0.5">
      {refs.map((r) => (
        <li key={r.key}>
          {kind === "requirements" ? (
            <Link href={`/projects/${projectId}/requirements/${r.key}`} className="text-navy-700 underline underline-offset-2">
              <span className="font-mono">{r.key}</span> {r.label}
            </Link>
          ) : kind === "condition" ? (
            <Link href={`/projects/${projectId}/test-cases?view=conditions&condition=${r.key}`} className="text-navy-700 underline underline-offset-2">
              <span className="font-mono">{r.key}</span> {r.label}
            </Link>
          ) : kind === "risk" ? (
            <Link href={`/projects/${projectId}/test-strategy?view=risks&risk=${r.key}`} className="text-navy-700 underline underline-offset-2">
              <span className="font-mono">{r.key}</span> {r.label}
            </Link>
          ) : (
            <span>
              <span className="font-mono">{r.key}</span> {r.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Quality checks (§8.6): Must fix first, then Advice; each with its fix hint and a [Go to …] button. */
function LintPanel({ items, onGoTo, canEdit }: { items: LintItem[]; onGoTo: (field: string) => void; canEdit: boolean }) {
  const sorted = [...items].sort((a, b) => (lintSeverity(a) === lintSeverity(b) ? 0 : lintSeverity(a) === "must" ? -1 : 1));
  return (
    <section aria-labelledby="checks-h">
      <h2 id="checks-h" className="text-body font-semibold text-fg-strong">
        Quality checks ({items.length})
      </h2>
      {items.length === 0 ? (
        <p className="mt-1 text-body">
          <SeverityText severity="clean" />
        </p>
      ) : (
        <ul className="mt-1 space-y-2">
          {sorted.map((i, n) => {
            const step = stepOfPath(i.path);
            const field = step ? `step-${step - 1}-${/action/.test(i.path ?? "") ? "action" : "expected"}` : i.code === "orphan_case" ? "requirements" : i.code === "missing_steps" ? "add-step" : "expected_result";
            return (
              <li key={`${i.code}-${n}`} className="text-body">
                <p>
                  <SeverityText severity={lintSeverity(i)} /> · {lintName(i.code)}
                  {step ? ` (step ${step})` : ""}
                </p>
                <p className="text-small text-fg">{i.hint ?? i.message ?? LINT_DEFS[i.code]?.hint}</p>
                {canEdit && (
                  <button type="button" onClick={() => onGoTo(field)} className="text-small font-medium text-navy-700 underline underline-offset-2">
                    Go to {step ? `step ${step}` : field === "requirements" ? "requirements" : field === "add-step" ? "steps" : "expected result"}
                    <span className="sr-only"> for {lintName(i.code).toLowerCase()}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Multi-select of requirement checkboxes (non-rejected), and ACs filtered to the chosen requirements. */
function LinkPicker({ reqs, form, setForm, error }: { reqs: RequirementSummary[]; form: CaseForm; setForm: (f: CaseForm) => void; error?: string }) {
  const chosen = reqs.filter((r) => form.requirement_ids.includes(r.id));
  const details = useSWR<RequirementDetail[]>(chosen.length ? `/case-ac-picker?${chosen.map((r) => r.id).join(",")}` : null, () => Promise.all(chosen.map((r) => api<RequirementDetail>(`/requirements/${r.id}`))), {
    revalidateOnFocus: false,
  });
  const acs = (details.data ?? []).flatMap((d) => (d.acceptance_criteria ?? []).filter((a) => a.status !== "rejected").map((a) => ({ id: a.id, key: a.key, text: `${a.given} ${a.when} ${a.then}` })));
  return (
    <div className="space-y-3">
      <fieldset id="requirements" tabIndex={-1} aria-describedby={error ? "requirements-error" : undefined} className="focus:outline-none">
        <legend className="mb-1 text-body font-medium text-fg-strong">Requirements</legend>
        <p className="mb-1 text-small text-fg-muted">Optional on save. Without one, the case shows “Not linked to a requirement” (Must fix).</p>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-2">
          {reqs.length === 0 && <p className="text-small text-fg-muted">No requirements.</p>}
          {reqs.map((r) => (
            <label key={r.id} className="flex items-start gap-2 text-body text-fg-strong">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
                checked={form.requirement_ids.includes(r.id)}
                onChange={(e) => setForm({ ...form, requirement_ids: e.target.checked ? [...form.requirement_ids, r.id] : form.requirement_ids.filter((x) => x !== r.id) })}
              />
              <span className="min-w-0 break-words">
                <span className="font-mono">{r.key}</span> {r.title}
              </span>
            </label>
          ))}
        </div>
        {error && (
          <p id="requirements-error" className="mt-1 text-small font-medium text-danger-fg">
            {error}
          </p>
        )}
      </fieldset>
      {chosen.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-body font-medium text-fg-strong">Acceptance criteria</legend>
          {!details.data ? (
            <Skeleton className="h-10" />
          ) : acs.length === 0 ? (
            <p className="text-small text-fg-muted">The chosen requirements have no acceptance criteria.</p>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-2">
              {acs.map((a) => (
                <label key={a.id} className="flex items-start gap-2 text-body text-fg-strong">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
                    checked={form.acceptance_criterion_ids.includes(a.id)}
                    onChange={(e) =>
                      setForm({ ...form, acceptance_criterion_ids: e.target.checked ? [...form.acceptance_criterion_ids, a.id] : form.acceptance_criterion_ids.filter((x) => x !== a.id) })
                    }
                  />
                  <span className="min-w-0 break-words">
                    <span className="font-mono">{a.key}</span> {a.text}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

/** Undecided expected-result fields of an open-question case, first one first (§8.4). */
function undecidedFields(d: Detail): string[] {
  const out: string[] = [];
  (d.steps ?? []).forEach((s, i) => {
    if (isUndecided(s.expected, d.open_question?.message) || (i === d.steps.length - 1 && !s.expected?.trim())) out.push(`step-${i}-expected`);
  });
  if (isUndecided(d.expected_result, d.open_question?.message) || !d.expected_result?.trim()) out.push("expected_result");
  return out.length ? out : ["expected_result"];
}

/**
 * Test case detail, edit and new (design P3 §8). Every spec §7 field is shown with a label; empty ones say
 * "None". No execution controls exist anywhere. Approve with blockers stays focusable and explains why.
 */
export function TestCaseDetailView({
  projectId,
  caseKey,
  all,
  filters,
  olderVersion,
  canEdit,
  g5Approved,
  isNew,
  prefillRequirement,
  fromKey,
  onListChanged,
}: {
  projectId: string;
  caseKey: string;
  all: TestCaseSummary[] | undefined;
  filters: CaseFilters;
  olderVersion: number | null;
  canEdit: boolean;
  g5Approved: boolean;
  isNew?: boolean;
  prefillRequirement?: string | null;
  fromKey?: string | null;
  onListChanged: () => Promise<unknown> | void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { role } = useAuth();
  const assistant = useAssistantDrawer();
  const detail = useApi<Detail>(isNew ? null : `/projects/${projectId}/test-cases/by-key/${encodeURIComponent(caseKey)}`, undefined, { shouldRetryOnError: false });
  const from = useApi<Detail>(isNew && fromKey ? `/projects/${projectId}/test-cases/by-key/${encodeURIComponent(fromKey)}` : null, undefined, { shouldRetryOnError: false });
  const d = detail.data;
  const revisions = useApi<Revision[]>(d ? `/test-cases/${d.id}/revisions` : null, undefined, { shouldRetryOnError: false });
  const reqs = useAllRequirements(projectId, null, canEdit);
  const data = useAllTestData(projectId, null, true);
  const strategy = useApi<TestStrategy>(canEdit ? `/projects/${projectId}/test-strategy` : null, undefined, { shouldRetryOnError: false });
  const h1 = useRef<HTMLHeadingElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(!!isNew);
  const [form, setForm] = useState<CaseForm | null>(isNew ? { ...EMPTY_FORM, steps: [newStep()] } : null);
  const [base, setBase] = useState<CaseForm | null>(isNew ? { ...EMPTY_FORM, steps: [newStep()] } : null);
  const [preRows, setPreRows] = useState<ChecklistRow[]>([]);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Detail | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deprecateOpen, setDeprecateOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof lintPreview>>([]);
  const [dataDrawer, setDataDrawer] = useState<TestDataItem | null>(null);
  const [newData, setNewData] = useState<null | ((d: TestDataItem | null) => void)>(null);
  const [oqWriting, setOqWriting] = useState(false);
  const prefilled = useRef(false);

  // New case: prefill the requirement (?requirement=REQ-0004) or copy another case (?from=TC-0004).
  useEffect(() => {
    if (!isNew || prefilled.current) return;
    if (fromKey && !from.data) return;
    if (prefillRequirement && !reqs.data) return;
    prefilled.current = true;
    const f: CaseForm = from.data ? { ...toCaseForm(from.data), title: `Copy of ${from.data.title}` } : { ...EMPTY_FORM, steps: [newStep()] };
    const req = prefillRequirement ? reqs.data?.find((r) => r.key === prefillRequirement) : null;
    if (req && !f.requirement_ids.includes(req.id)) f.requirement_ids = [...f.requirement_ids, req.id];
    setForm(f);
    setBase({ ...EMPTY_FORM, steps: f.steps });
    setPreRows(f.preconditions.map((t) => newRow(t)));
  }, [isNew, fromKey, from.data, prefillRequirement, reqs.data]);

  const dirty = editing && !!form && !!base && (JSON.stringify({ ...form, preconditions: preRows.map((r) => r.text) }) !== JSON.stringify(base));
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  useEffect(() => {
    if (d || isNew) h1.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per case
  }, [d?.id, isNew]);

  // Live check preview, debounced (500 ms), never moves focus.
  useEffect(() => {
    if (!editing || !form) return;
    const t = setTimeout(() => setPreview(lintPreview(form)), 500);
    return () => clearTimeout(t);
  }, [editing, form]);

  const { rows } = useMemo(() => filterCases(all ?? [], filters), [all, filters]);
  const idx = rows.findIndex((x) => x.key === caseKey);
  const prev = idx > 0 ? rows[idx - 1] : null;
  const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
  const q = buildQuery(caseFiltersToQuery(filters));
  const listHref = `/projects/${projectId}/test-cases${q}`;
  const itemHref = (k: string) => `/projects/${projectId}/test-cases/${k}${q}`;
  const filtered = Object.keys(caseFiltersToQuery(filters)).length > 0;

  function go(href: string) {
    if (dirty) setLeaveTo(href);
    else router.push(href);
  }

  function focusField(id: string) {
    setTimeout(() => {
      const el = document.getElementById(id);
      el?.focus();
      el?.scrollIntoView({ block: "center" });
    }, 0);
  }

  function startEdit(focusId?: string) {
    if (!d) return;
    const f = toCaseForm(d);
    setBase(f);
    setForm(f);
    setPreRows(f.preconditions.map((t) => newRow(t)));
    setErrors([]);
    setSaveError(null);
    setConflict(null);
    setEditing(true);
    focusField(focusId ?? "title");
  }

  function cancelEdit() {
    if (isNew) {
      go(listHref);
      return;
    }
    setEditing(false);
    setConflict(null);
    setOqWriting(false);
    setTimeout(() => editBtn.current?.focus(), 0);
  }

  // ?edit=1 opens the form; ?write=1 focuses the first undecided expected result.
  const [autoEdit] = useState(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null));
  useEffect(() => {
    if (!d || !canEdit || olderVersion || editing || d.locked) return;
    if (autoEdit?.get("write") === "1" && d.expected_result_status === "open_question") {
      setOqWriting(true);
      startEdit(undecidedFields(d)[0]);
    } else if (autoEdit?.get("edit") === "1") startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once when the case loads
  }, [d?.id]);

  if (!isNew && detail.error && !d) {
    if (detail.error instanceof ApiError && detail.error.status === 404)
      return <EmptyState title={`We couldn’t find ${caseKey} in this project.`} action={<LinkButton href={`/projects/${projectId}/test-cases`}>Back to test cases</LinkButton>} />;
    return <ErrorState error={detail.error} title={`Couldn’t load ${caseKey}.`} message="Try again." onRetry={() => void detail.mutate()} />;
  }
  if (!isNew && !d)
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-2/3" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
        <span className="sr-only" role="status">
          Loading {caseKey}…
        </span>
      </div>
    );

  // ---- older version (?v=n) -----------------------------------------------------------------
  const snapshot = olderVersion && revisions.data ? revisions.data.find((x) => x.version === olderVersion)?.snapshot : null;
  const shown: Detail | undefined = d && snapshot ? ({ ...d, ...(snapshot as Partial<Detail>) } as Detail) : d;
  const readOnly = !canEdit || !!olderVersion;
  const g5Note = (wasApproved: boolean) => noteGateReopened(projectId, "G5", g5Approved && wasApproved, toast);

  async function refreshAll() {
    await Promise.all([detail.mutate(), revisions.mutate(), onListChanged()]);
  }

  function failText(err: unknown) {
    if (err instanceof ApiError && err.status === 403) return "Your permissions changed. Refresh to see what you can do now.";
    if (err instanceof ApiError && err.code === "network") return "You’re offline. Your changes are still here; save again when you reconnect.";
    if (err instanceof ApiError && err.status === 409) return `${caseKey} changed since you opened it. Reload to see the latest version.`;
    return `Couldn’t update ${caseKey}. ${errorMessage(err)}`;
  }

  async function setStatus(status: "approved" | "draft", undoTo?: "approved" | "rejected") {
    if (!d) return;
    setBusy(status);
    setActionError(null);
    try {
      const saved = await api<Detail>(`/test-cases/${d.id}/status`, { body: { version: d.version, status } });
      await detail.mutate(saved, { revalidate: false });
      const msg = status === "approved" ? `${d.key} approved.` : `${d.key} moved back to draft.`;
      setLive(msg);
      toast(
        msg,
        "success",
        undoTo
          ? {
              action: {
                label: "Undo",
                onClick: () =>
                  void api(`/test-cases/${saved.id}/status`, { body: { version: saved.version, status: undoTo, comment: undoTo === "rejected" ? (d.status_comment ?? "Restored by Undo") : undefined } }).then(refreshAll),
              },
              duration: 10_000,
            }
          : undefined,
      );
      g5Note(status === "draft" && d.status === "approved");
      await refreshAll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && status === "approved") {
        const names = Array.isArray(err.details) ? (err.details as LintItem[]).map((x) => lintName(x.code)).join(", ") : err.message;
        setActionError(`${d.key} can’t be approved: ${names}.`);
        void detail.mutate();
      } else setActionError(failText(err));
    } finally {
      setBusy(null);
    }
  }

  async function setLock(locked: boolean) {
    if (!d) return;
    setBusy("lock");
    try {
      await api(`/test-cases/${d.id}/lock`, { body: { version: d.version, locked } });
      toast(`${d.key} ${locked ? "locked" : "unlocked"}.`);
      await refreshAll();
    } catch (err) {
      setActionError(failText(err));
    } finally {
      setBusy(null);
    }
  }

  async function duplicate() {
    if (!d) return;
    try {
      const copy = await api<Detail>(`/test-cases/${d.id}/duplicate`, { body: { title: `Copy of ${d.title}` } });
      toast(`${copy.key} created from ${d.key}.`);
      await onListChanged();
      router.push(`/projects/${projectId}/test-cases/${copy.key}?edit=1`);
    } catch (err) {
      setActionError(failText(err));
    }
  }

  async function save(version: number) {
    if (!form) return;
    const full: CaseForm = { ...form, preconditions: preRows.map((r) => r.text) };
    const errs = validateCaseForm(full);
    setErrors(errs);
    if (errs.length) {
      setTimeout(() => document.getElementById("form-errors")?.focus(), 0);
      focusField(errs[0].field);
      return;
    }
    setBusy("save");
    setSaveError(null);
    try {
      if (isNew) {
        const body = {
          title: full.title.trim(),
          objective: full.objective.trim(),
          preconditions: full.preconditions.map((p) => p.trim()).filter(Boolean),
          steps: stepsInput(full.steps),
          expected_result: full.expected_result.trim(),
          test_type: full.test_type,
          test_level: full.test_level,
          technique: full.technique,
          requirement_ids: full.requirement_ids,
          acceptance_criterion_ids: full.acceptance_criterion_ids,
          suites: full.suites,
          side_effects: from.data?.side_effects ?? [],
        };
        const created = await api<Detail>(`/projects/${projectId}/test-cases`, { body });
        toast(fromKey ? `${created.key} created from ${fromKey}.` : `${created.key} created as a draft.`);
        await onListChanged();
        setEditing(false);
        router.push(`/projects/${projectId}/test-cases/${created.key}`);
        return;
      }
      const body = casePatch(base!, full, version);
      // Answering an open question: the form shows the question's step as empty, so send the steps even if
      // untouched; otherwise the submit step would keep the question text as its expected result.
      if (d!.expected_result_status === "open_question" && body.steps === undefined && (d!.steps ?? []).some((x) => isUndecided(x.expected, d!.open_question?.message)))
        body.steps = stepsInput(full.steps);
      if (!patchHasChanges(body)) {
        cancelEdit();
        return;
      }
      const wasApproved = d!.status === "approved";
      const wasOq = d!.expected_result_status === "open_question";
      const saved = await api<Detail>(`/test-cases/${d!.id}`, { method: "PATCH", body });
      setEditing(false);
      setConflict(null);
      setOqWriting(false);
      const msg =
        wasOq && saved.expected_result_status !== "open_question"
          ? `Expected result saved. ${saved.key} can now be approved.`
          : `${saved.key} saved as version ${saved.version}.${wasApproved && saved.status === "draft" ? " Moved back to Draft." : ""}`;
      toast(msg);
      setLive(msg);
      g5Note(wasApproved);
      await detail.mutate(saved, { revalidate: false });
      await Promise.all([revisions.mutate(), onListChanged()]);
      setTimeout(() => editBtn.current?.focus(), 0);
    } catch (err) {
      if (!isNew && err instanceof ApiError && err.status === 409 && !/lock/i.test(err.message)) {
        try {
          setConflict(await api<Detail>(`/test-cases/${d!.id}`));
        } catch {
          setSaveError(`Couldn’t save ${caseKey}. Your changes are still here. Try again.`);
        }
      } else if (err instanceof ApiError && err.status === 409) setSaveError(`${caseKey} is locked. Unlock it to edit.`);
      else if (err instanceof ApiError && err.status === 422) {
        const { fields, other } = caseFieldErrors(err.details);
        setErrors(fields);
        if (fields.length) {
          setTimeout(() => document.getElementById("form-errors")?.focus(), 0);
          focusField(fields[0].field);
        }
        setSaveError(fields.length && !other.length ? null : `Couldn’t save ${isNew ? "the test case" : caseKey}. ${other.join(" ") || "Check the form and try again."}`);
      } else if (err instanceof ApiError && err.code === "network") setSaveError("You’re offline. Your changes are still here; save again when you reconnect.");
      else setSaveError(`Couldn’t save ${isNew ? "the test case" : caseKey}. Your changes are still here. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  const errorOf = (f: string) => errors.find((e) => e.field === f)?.message;
  const errMap = Object.fromEntries(errors.map((e) => [e.field, e.message]));
  const blockReason = d ? approveBlockReason(d.lint) : null;
  const status = shown?.status ?? "draft";
  const editableNow = !readOnly && !editing && !!d;
  const oq = shown?.expected_result_status === "open_question";
  const strategyTypes = (strategy.data?.sections?.test_types ?? []).filter((t) => t.in_scope).map((t) => t.type as string);
  const strategyLevels = (strategy.data?.sections?.test_levels ?? []).filter((t) => t.in_scope).map((t) => t.level as string);
  const typeOptions = [...new Set([...(strategyTypes.length ? strategyTypes : ["functional", "smoke", "accessibility", "usability", "compatibility"]), form?.test_type ?? "functional"])];
  const levelOptions = [...new Set([...(strategyLevels.length ? strategyLevels : ["system", "acceptance", "component_integration"]), form?.test_level ?? "system"])];
  const conflictWho = conflict?.updated_by?.full_name || conflict?.updated_by?.email || "another user";
  const latestRevisions = [...(revisions.data ?? [])].sort((a, b) => b.version - a.version);
  const viewerOnly = role === "viewer";
  const key = isNew ? "New test case" : (d?.key ?? caseKey);

  const statusActions = editableNow && d && (
    <div className="flex flex-wrap items-center gap-2">
      {status === "draft" && (
        <Button
          onClick={() => {
            if (!blockReason) void setStatus("approved");
          }}
          loading={busy === "approved"}
          aria-disabled={!!blockReason || undefined}
          aria-describedby={blockReason ? "approve-reason" : undefined}
        >
          Approve
        </Button>
      )}
      {status === "draft" && (
        <Button variant="secondary" onClick={() => setRejectOpen(true)}>
          Reject…
        </Button>
      )}
      {status === "rejected" && (
        <Button onClick={() => void setStatus("draft", "rejected")} loading={busy === "draft"}>
          Restore to draft
        </Button>
      )}
      {(status === "draft" || status === "approved") &&
        (d.locked ? (
          <Button ref={editBtn} variant="secondary" icon={<Lock className="h-4 w-4" aria-hidden />} onClick={() => void setLock(false)}>
            Unlock to edit
          </Button>
        ) : (
          <Button ref={editBtn} variant="secondary" icon={<PencilLine className="h-4 w-4" aria-hidden />} onClick={() => startEdit()}>
            Edit
          </Button>
        ))}
      {status === "approved" && (
        <Button variant="secondary" onClick={() => setDeprecateOpen(true)}>
          Deprecate…
        </Button>
      )}
    </div>
  );

  const more = d && (
    <MoreMenu
      label="More test case actions"
      items={[
        { label: "Move back to draft", onClick: () => void setStatus("draft", "approved"), hidden: readOnly || status !== "approved" },
        { label: "Duplicate", onClick: () => void duplicate(), hidden: readOnly || status === "deprecated" },
        { label: d.locked ? "Unlock" : "Lock", onClick: () => void setLock(!d.locked), hidden: readOnly || status === "rejected" || status === "deprecated" },
        { label: "Ask AI QA Analyst about this", onClick: () => assistant.open({ type: "test_case", id: d.id, key: d.key, label: d.title, path: `/projects/${projectId}/test-cases/${d.key}` }) },
        { label: "View traceability", href: `/projects/${projectId}/traceability/${d.key}` },
        {
          label: "Copy link",
          onClick: () =>
            void navigator.clipboard
              .writeText(`${window.location.origin}/projects/${projectId}/test-cases/${d.key}`)
              .then(() => toast("Link copied."))
              .catch(() => toast("Couldn’t copy the link.", "error")),
        },
      ]}
    />
  );

  // ---- main column: read view -------------------------------------------------------------------
  const readMain = shown && (
    <Card className="space-y-5 p-5">
      <section>
        <h2 className="text-h3 font-semibold text-fg-strong">Objective</h2>
        <p className="mt-1 text-body text-fg">{shown.objective || <span className="text-fg-muted">None</span>}</p>
      </section>
      <section>
        <h2 className="text-h3 font-semibold text-fg-strong">Why this case exists</h2>
        <p className="mt-1 text-body text-fg">{shown.design_basis?.explanation || <span className="text-fg-muted">None</span>}</p>
        {(shown.evidence ?? []).length > 0 && (
          <p className="mt-1 text-small text-fg">
            Evidence: <EvidenceLinks items={linksToItems(shown.evidence)} subject={`${shown.key} ${shown.title}`} />
          </p>
        )}
      </section>
      <section>
        <h2 className="text-h3 font-semibold text-fg-strong">Preconditions</h2>
        {(shown.preconditions ?? []).length ? (
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-body text-fg">
            {shown.preconditions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-body text-fg-muted">None</p>
        )}
      </section>
      <section>
        <h2 className="text-h3 font-semibold text-fg-strong">Test data</h2>
        {(shown.test_data ?? []).length ? (
          <ul className="mt-1 flex flex-wrap gap-2">
            {shown.test_data.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setDataDrawer(t)} className="inline-flex items-center gap-1 rounded-full bg-overlay px-2.5 py-1 text-small text-fg-strong ring-1 ring-inset ring-line-strong hover:bg-surface">
                  <span className="font-mono">{t.key}</span> {t.field_label}
                  <span className="sr-only"> (open test data)</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-body text-fg-muted">None</p>
        )}
      </section>
      <section>
        <h2 className="text-h3 font-semibold text-fg-strong">Steps</h2>
        {(shown.steps ?? []).length === 0 ? (
          <p className="mt-1 text-body text-fg-muted">None</p>
        ) : (
          <>
            <div className="mt-2 hidden md:block">
              <table className="min-w-full divide-y divide-line text-small">
                <caption className="sr-only">Steps for {shown.key}</caption>
                <thead>
                  <tr>
                    {["#", "Action", "Data", "Expected"].map((h) => (
                      <th key={h} scope="col" className="px-2 py-1.5 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                        {h === "#" ? <span>#<span className="sr-only"> Step</span></span> : h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.steps.map((s, i) => (
                    <tr key={i} className="align-top">
                      <th scope="row" className="px-2 py-2 text-left font-normal tabular-nums">
                        {s.n ?? i + 1}
                      </th>
                      <td className="px-2 py-2 text-body">{s.action}</td>
                      <td className="px-2 py-2 font-mono">{(s.data ?? []).length ? s.data.map((x) => x.key).join(", ") : "—"}</td>
                      <td className="px-2 py-2 text-body">
                        {!s.expected?.trim() ? (
                          <span className="text-fg-muted">None</span>
                        ) : oq && isUndecided(s.expected, shown.open_question?.message) ? (
                          <NotDecided />
                        ) : (
                          s.expected
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ol className="mt-2 space-y-2 md:hidden" aria-label={`Steps for ${shown.key}`}>
              {shown.steps.map((s, i) => (
                <li key={i} className="rounded-md border border-line p-3 text-body">
                  <p className="font-semibold text-fg-strong">Step {s.n ?? i + 1}</p>
                  <p>
                    <span className="text-fg-muted">Action: </span>
                    {s.action}
                  </p>
                  <p>
                    <span className="text-fg-muted">Data: </span>
                    {(s.data ?? []).length ? s.data.map((x) => x.key).join(", ") : "None"}
                  </p>
                  <p>
                    <span className="text-fg-muted">Expected: </span>
                    {!s.expected?.trim() ? <span className="text-fg-muted">None</span> : oq && isUndecided(s.expected, shown.open_question?.message) ? <NotDecided /> : s.expected}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
      <section>
        <h2 className="text-h3 font-semibold text-fg-strong">Overall expected result</h2>
        {oq && shown.open_question ? (
          <p className="mt-1 text-body text-warning-fg">
            {openQuestionText(shown.open_question.message)}
            {shown.open_question.requirement?.key && (
              <>
                {" "}
                <Link href={`/projects/${projectId}/requirements/${shown.open_question.requirement.key}`} className="font-medium underline underline-offset-2">
                  {shown.open_question.requirement.key}
                </Link>
              </>
            )}
          </p>
        ) : (
          <p className="mt-1 text-body text-fg">{shown.expected_result || <span className="text-fg-muted">None</span>}</p>
        )}
      </section>
    </Card>
  );

  // ---- main column: edit form --------------------------------------------------------------------
  const generated = !!d && d.source !== "user" && d.generated_by !== "human";
  const editMain = form && (
    <Card className="space-y-4 p-5">
      {isNew && <Callout tone="info">Cases you write are labelled Assumed: the system has no evidence for their expected result. Approving them confirms them for testing.</Callout>}
      {d?.status === "approved" && (
        <Callout tone="warning">
          This case is approved. Saving moves it back to Draft.{g5Approved ? " Gate 5 will need approval again." : ""}
        </Callout>
      )}
      {conflict && (
        <Callout
          tone="danger"
          title={`Someone else changed ${d!.key} while you were editing (now version ${conflict.version} by ${conflictWho}).`}
          actions={
            <>
              <Button size="sm" variant="secondary" aria-expanded={compareOpen} onClick={() => setCompareOpen((v) => !v)}>
                Compare with their version
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void detail.mutate(conflict, { revalidate: false });
                  setEditing(false);
                  setConflict(null);
                }}
              >
                Discard my changes
              </Button>
            </>
          }
        >
          Your unsaved text is kept below.
        </Callout>
      )}
      {conflict && compareOpen && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <DiffView
            changes={fieldChanges(
              { title: conflict.title, objective: conflict.objective, steps: (conflict.steps ?? []).map((s) => `${s.action} → ${s.expected}`), expected_result: conflict.expected_result },
              { title: form.title, objective: form.objective, steps: form.steps.map((s) => `${s.action} → ${s.expected}`), expected_result: form.expected_result },
            )}
            leftLabel={`Their version (${conflict.version})`}
            rightLabel="Your unsaved text"
          />
          <Button onClick={() => void save(conflict.version)} loading={busy === "save"}>
            Save mine as version {conflict.version + 1}
          </Button>
        </div>
      )}
      {errors.length > 0 && (
        <div id="form-errors" tabIndex={-1} role="alert" className="rounded-md bg-danger-bg p-3 ring-1 ring-inset ring-danger-line focus:outline-none">
          <p className="font-semibold text-fg-strong">Fix {errors.length === 1 ? "this" : `these ${errors.length}`} before saving:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body">
            {errors.map((e) => (
              <li key={`${e.field}-${e.message}`}>
                <a
                  href={`#${e.field}`}
                  onClick={(ev) => {
                    ev.preventDefault();
                    focusField(e.field);
                  }}
                  className="text-danger-fg underline underline-offset-2"
                >
                  {e.message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <TextField id="title" label="Title" required maxLength={140} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} hint="Give the case a short, specific title." error={errorOf("title")} />
      <TextArea id="objective" label="Objective" required rows={2} maxLength={1000} value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} hint="Say what this case checks." error={errorOf("objective")} />
      <LinkPicker reqs={(reqs.data ?? []).filter((r) => r.status !== "rejected")} form={form} setForm={setForm} error={errorOf("requirements")} />
      {generated ? (
        <div>
          <p className="text-body font-medium text-fg-strong">Technique</p>
          <p className="text-body text-fg">
            {techniqueInfo(form.technique).name} <span className="text-small text-fg-muted">· Set by the design rules.</span>
          </p>
        </div>
      ) : (
        <SelectField
          id="technique"
          label="Technique"
          required
          placeholder="Choose a technique"
          value={form.technique}
          onChange={(e) => setForm({ ...form, technique: e.target.value as CaseForm["technique"] })}
          options={CASE_FORM_TECHNIQUES.map((t) => ({ value: t, label: techniqueInfo(t).name }))}
          hint={form.technique ? techniqueInfo(form.technique).definition : "How the case was designed, for example Error guessing or Use case."}
          error={errorOf("technique")}
        />
      )}
      <div>
        <p className="mb-1 text-body font-medium text-fg-strong">Preconditions</p>
        <PreconditionsEditor rows={preRows} onChange={setPreRows} />
      </div>
      <div>
        <p className="mb-1 text-body font-medium text-fg-strong">Steps</p>
        <StepEditor
          steps={form.steps}
          onChange={(s) => setForm({ ...form, steps: s })}
          errors={errMap}
          data={data.data ?? []}
          announce={setLive}
          onNewData={() => new Promise<TestDataItem | null>((resolve) => setNewData(() => resolve))}
          hint={(i) =>
            oqWriting && d?.open_question && isUndecided(d.steps?.[i]?.expected, d.open_question.message)
              ? `Decide what should happen. Example: ‘Submission is blocked and Message is identified as required.’ Your answer is labelled Assumed until ${d.open_question.requirement?.key ?? "the question"} is resolved.`
              : undefined
          }
        />
      </div>
      <TextArea
        id="expected_result"
        label="Overall expected result"
        required
        rows={2}
        maxLength={1000}
        value={form.expected_result}
        onChange={(e) => setForm({ ...form, expected_result: e.target.value })}
        hint={
          oqWriting && d?.open_question
            ? `Decide what should happen. Example: ‘Submission is blocked and Message is identified as required.’ Your answer is labelled Assumed until ${d.open_question.requirement?.key ?? "the question"} is resolved.`
            : "Describe what the user should see at the end."
        }
        error={errorOf("expected_result")}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Test type" value={form.test_type} onChange={(e) => setForm({ ...form, test_type: e.target.value })} options={typeOptions.map((t) => ({ value: t, label: caseTypeText(t) }))} />
        <SelectField label="Test level" value={form.test_level} onChange={(e) => setForm({ ...form, test_level: e.target.value })} options={levelOptions.map((t) => ({ value: t, label: caseLevelText(t) }))} />
      </div>
      {strategyTypes.length > 0 && !strategyTypes.includes(form.test_type) && <p className="text-small text-warning-fg">Advice: Test type not in the strategy. Change the type, or add it to the Test Strategy.</p>}
      <fieldset>
        <legend className="mb-1 text-body font-medium text-fg-strong">Suites</legend>
        <div className="flex flex-wrap gap-4">
          {(["smoke", "regression"] as const).map((s) => (
            <label key={s} className="inline-flex items-center gap-2 text-body text-fg-strong">
              <input type="checkbox" className="h-5 w-5 accent-accent" checked={form.suites.includes(s)} onChange={(e) => setForm({ ...form, suites: e.target.checked ? [...form.suites, s] : form.suites.filter((x) => x !== s) })} />
              {SUITE_TEXT[s]}
            </label>
          ))}
        </div>
      </fieldset>
      {!isNew && <TextField label="Reason for change" hint="Optional. Stored in the revision." maxLength={200} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
      <p className="text-small text-fg-muted">{NO_CHANGE_HELP}</p>
      <section aria-labelledby="preview-h" className="rounded-md bg-elevated p-3">
        <h3 id="preview-h" className="text-body font-semibold text-fg-strong">
          Checks (preview)
        </h3>
        {preview.length === 0 ? (
          <p className="text-small text-fg">
            <SeverityText severity="clean" />
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-small">
            {preview.map((p, i) => (
              <li key={`${p.code}-${p.field}-${i}`}>
                <SeverityText severity={p.severity} /> · {p.text}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-small text-fg-muted">The server checks again when you save.</p>
      </section>
      <InlineError error={saveError} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save(d?.version ?? 0)} loading={busy === "save"}>
          {isNew ? "Create test case" : "Save changes"}
        </Button>
        <Button variant="secondary" onClick={cancelEdit}>
          Cancel
        </Button>
      </div>
    </Card>
  );

  // ---- side column -------------------------------------------------------------------------------
  const side = shown && (
    <Card className="p-5">
      <dl className="divide-y divide-line">
        <Row label="ID">
          <span className="font-mono">{shown.key}</span>
        </Row>
        <Row label="Requirements">
          <Refs refs={shown.requirements ?? []} projectId={projectId} kind="requirements" />
        </Row>
        <Row label="Acceptance criteria">
          <Refs refs={shown.acceptance_criteria ?? []} projectId={projectId} kind="ac" />
        </Row>
        <Row label="Condition">
          {shown.condition ? <Refs refs={[{ key: shown.condition.key, label: `${shown.condition.label} (${techniqueInfo(shown.technique).name})` }]} projectId={projectId} kind="condition" /> : <span className="text-fg-muted">None</span>}
        </Row>
        <Row label="Risk">
          <Refs refs={(shown.risks ?? []).map((r) => ({ key: r.key, label: r.label }))} projectId={projectId} kind="risk" />
        </Row>
        <Row label="Technique">
          <TechniqueChip technique={shown.technique} full />
        </Row>
        <Row label="Test type">{caseTypeText(shown.test_type)}</Row>
        <Row label="Test level">{caseLevelText(shown.test_level)}</Row>
        <Row label="Suites">{(shown.suites ?? []).length ? shown.suites.map((s) => SUITE_TEXT[s]).join(", ") : <span className="text-fg-muted">None</span>}</Row>
        <Row label="Priority">
          <PrioritySource c={shown} projectId={projectId} />
          {!readOnly && !editing && status !== "deprecated" && status !== "rejected" && (
            <Button size="sm" variant="secondary" className="mt-1" onClick={() => setPriorityOpen(true)}>
              Set priority…
            </Button>
          )}
        </Row>
        <Row label="Expected result label">{oq ? <NotDecided /> : <ProvenanceLabel provenance={shown.classification ?? null} />}</Row>
        <Row label="Last result">
          <span className="text-fg-muted">Not run yet</span>
          <span className="block text-small text-fg-muted">Execution arrives in Phase 4.</span>
        </Row>
        <Row label="Execution status">Not run (read-only)</Row>
        <Row label="Automation">
          {shown.automation_suitability ? (
            <>
              {AUTOMATION_TEXT[shown.automation_suitability.value] ?? shown.automation_suitability.value} ({shown.automation_suitability.assessed === "assessed" ? "assessed" : "preliminary"})
              {automationReasonText(shown.automation_suitability.reason) && <span className="block text-small text-fg">{automationReasonText(shown.automation_suitability.reason)}</span>}
              {shown.automation_suitability.assessed !== "assessed" && <span className="block text-small text-fg-muted">{PRELIMINARY_TEXT}</span>}
            </>
          ) : (
            <span className="text-fg-muted">None. {PRELIMINARY_TEXT}</span>
          )}
        </Row>
        <Row label="Side effects">
          {(shown.side_effects ?? []).length ? shown.side_effects.map((s) => SIDE_EFFECT_TEXT[s] ?? s).join(", ") : <span className="text-fg-muted">None</span>}
          <span className="block text-small text-fg-muted">Labels only. Nothing runs in Phase 3.</span>
        </Row>
        <Row label="Evidence">{(shown.evidence ?? []).length ? <EvidenceLinks items={linksToItems(shown.evidence)} subject={`${shown.key} ${shown.title}`} /> : <span className="text-fg-muted">None</span>}</Row>
      </dl>
      <div className="mt-4 border-t border-line pt-4">
        <LintPanel
          items={shown.lint ?? []}
          canEdit={!readOnly && !d?.locked && (status === "draft" || status === "approved")}
          onGoTo={(f) => {
            if (editing) focusField(f);
            else startEdit(f);
          }}
        />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
        <p className="text-body font-semibold text-fg-strong">Revision history ({latestRevisions.length})</p>
        <button type="button" onClick={() => setHistoryOpen(true)} className="text-small font-medium text-navy-700 underline underline-offset-2">
          View all<span className="sr-only"> revisions of {shown.key}</span>
        </button>
      </div>
      {editing && <p className="mt-3 text-small text-fg-muted">{NO_CHANGE_HELP}</p>}
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-small">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5 text-fg-muted">
            <li>
              <Link
                href={listHref}
                onClick={(e) => {
                  if (dirty) {
                    e.preventDefault();
                    go(listHref);
                  }
                }}
                className="font-medium text-navy-700 underline underline-offset-2"
              >
                Test Cases
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li aria-current="page" className="font-mono text-fg-strong">
              {key}
            </li>
          </ol>
        </nav>
        {!isNew && idx >= 0 && (
          <nav aria-label="Test case navigation" className="flex items-center gap-3">
            {prev ? (
              <Link href={itemHref(prev.key)} onClick={(e) => (dirty ? (e.preventDefault(), go(itemHref(prev.key))) : undefined)} aria-label={`Previous test case: ${prev.key} ${prev.title}`} className="inline-flex items-center gap-1 font-medium text-navy-700 underline underline-offset-2">
                <ArrowLeft className="h-4 w-4" aria-hidden /> Previous
              </Link>
            ) : (
              <span className="text-fg-muted">Previous</span>
            )}
            <span className="tabular-nums text-fg-muted">
              {idx + 1} of {rows.length}
              {filtered ? " (filtered)" : ""}
            </span>
            {next ? (
              <Link href={itemHref(next.key)} onClick={(e) => (dirty ? (e.preventDefault(), go(itemHref(next.key))) : undefined)} aria-label={`Next test case: ${next.key} ${next.title}`} className="inline-flex items-center gap-1 font-medium text-navy-700 underline underline-offset-2">
                Next <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : (
              <span className="text-fg-muted">Next</span>
            )}
          </nav>
        )}
      </div>

      {olderVersion && d && (
        <Callout
          tone="info"
          actions={
            <Button variant="secondary" onClick={() => router.push(itemHref(d.key))}>
              View latest
            </Button>
          }
        >
          You’re viewing version {olderVersion} of {d.key}. The latest is version {d.version}.
        </Callout>
      )}

      <header className="space-y-3">
        <h1 ref={h1} tabIndex={-1} className="break-words text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          {isNew ? (
            "New test case"
          ) : (
            <>
              <span className="font-mono">{d!.key}</span> · {shown!.title}
            </>
          )}
        </h1>
        {!isNew && shown && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <CaseStatusPill status={status} />
              <CaseFlags c={{ ...shown, changed_in_latest: false }} />
              <TechniqueChip technique={shown.technique} full />
              <PrioritySourceInline c={shown} />
              {shown.generated_by === "rules" && <span className="text-small text-fg-muted">Rules</span>}
              {shown.generated_by === "human" && <span className="text-small text-fg-muted">Written by a person</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {statusActions}
              {more}
            </div>
          </div>
        )}
        {blockReason && editableNow && status === "draft" && (
          <p id="approve-reason" className="text-body text-fg">
            {blockReason}
          </p>
        )}
        {status === "deprecated" && shown && (
          <Callout tone="neutral">
            Deprecated by {shown.status_changed_by?.full_name || shown.status_changed_by?.email || "a team member"}
            {shown.status_changed_at ? `, ${fmtDateTime(shown.status_changed_at)}` : ""}
            {shown.status_comment ? `: ${shown.status_comment}` : ""}. Kept for traceability and history.
          </Callout>
        )}
        {status === "rejected" && shown?.status_comment && <p className="text-body text-fg">Rejected: {shown.status_comment}</p>}
        {autoEdit?.get("edit") === "1" && viewerOnly && <Callout tone="neutral">You have view-only access. Ask an owner or admin for member access to edit test cases.</Callout>}
        <InlineError error={actionError} />
      </header>

      {oq && shown?.open_question && !editing && (
        <Callout
          tone="warning"
          title="Open question"
          icon={CircleHelp}
          actions={
            <>
              {editableNow && !d?.locked && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOqWriting(true);
                    startEdit(undecidedFields(d!)[0]);
                  }}
                >
                  Write expected result
                </Button>
              )}
              {shown.open_question.requirement?.key && <LinkButton href={`/projects/${projectId}/requirements/${shown.open_question.requirement.key}`}>Open {shown.open_question.requirement.key}</LinkButton>}
            </>
          }
        >
          The expected result isn’t decided. {openQuestionMessage(shown.open_question.message)} Write what should happen, or resolve {shown.open_question.requirement?.key ?? "the requirement"} and regenerate. This case can’t be approved until then.
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">{editing ? editMain : readMain}</div>
        <div className="min-w-0">{isNew ? <Card className="p-5 text-body text-fg">Source: Person · Label: Assumed · Status: Draft · Priority: derived on save from the linked requirements’ risk.</Card> : side}</div>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>

      {d && (
        <>
          <CaseRejectDialog
            open={rejectOpen}
            onClose={() => setRejectOpen(false)}
            count={1}
            subject={d.key}
            candidates={(all ?? []).filter((c) => c.key !== d.key && c.status !== "rejected")}
            onReject={async (r) => {
              try {
                await api(`/test-cases/${d.id}/status`, { body: { version: d.version, status: "rejected", comment: r.comment, reason: r.reason, duplicate_of: r.duplicate_of ?? undefined } });
              } catch (err) {
                throw new Error(failText(err));
              }
              toast(`${d.key} rejected.`);
              await refreshAll();
            }}
          />
          <DeprecateDialog
            open={deprecateOpen}
            onClose={() => setDeprecateOpen(false)}
            subject={d.key}
            candidates={(all ?? []).filter((c) => c.key !== d.key && (c.status === "approved" || c.status === "draft"))}
            onDeprecate={async (comment) => {
              try {
                await api(`/test-cases/${d.id}/status`, { body: { version: d.version, status: "deprecated", comment } });
              } catch (err) {
                throw new Error(failText(err));
              }
              toast(`${d.key} deprecated.`);
              g5Note(true);
              await refreshAll();
            }}
          />
          <PriorityDialog
            open={priorityOpen}
            onClose={() => setPriorityOpen(false)}
            c={d}
            g5Approved={g5Approved}
            onSaved={(saved, msg) => {
              toast(msg);
              setLive(msg);
              g5Note(d.status === "approved");
              void detail.mutate(saved, { revalidate: false });
              void revisions.mutate();
              void onListChanged();
            }}
          />
          <RevisionHistory open={historyOpen} onClose={() => setHistoryOpen(false)} title={`History of ${d.key}`} revisions={revisions.data ?? []} canRestore={false} />
        </>
      )}
      <TestDataDrawer projectId={projectId} item={dataDrawer} onClose={() => setDataDrawer(null)} />
      {newData && (
        <AddTestData
          projectId={projectId}
          fields={[...new Map((data.data ?? []).map((x) => [`${x.form?.label ?? x.feature?.label ?? ""}|${x.field_label}`, x])).values()]}
          onClose={() => {
            newData(null);
            setNewData(null);
          }}
          onAdded={(item) => {
            void data.mutate();
            newData(item);
            setNewData(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!leaveTo}
        onClose={() => setLeaveTo(null)}
        title={`Discard unsaved changes to ${key}?`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => {
          const to = leaveTo!;
          setLeaveTo(null);
          setEditing(false);
          router.push(to);
        }}
      >
        <p>Your changes haven’t been saved.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Preconditions as a short ordered list of text fields (max 10). */
function PreconditionsEditor({ rows, onChange }: { rows: ChecklistRow[]; onChange: (r: ChecklistRow[]) => void }) {
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-small text-fg-muted">None</p>}
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.id} className="flex items-end gap-2">
            <TextField
              id={`pre-${i}`}
              label={`Precondition ${i + 1}`}
              value={r.text}
              maxLength={300}
              onChange={(e) => onChange(rows.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)))}
              wrapClassName="min-w-0 flex-1"
            />
            <Button
              variant="ghost"
              aria-label={`Remove precondition ${i + 1}`}
              onClick={() => {
                onChange(rows.filter((x) => x.id !== r.id));
                setTimeout(() => document.getElementById(rows.length > 1 ? `pre-${Math.min(i, rows.length - 2)}` : "add-pre")?.focus(), 0);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      {rows.length < 10 && (
        <Button
          id="add-pre"
          variant="secondary"
          size="sm"
          onClick={() => {
            onChange([...rows, newRow("")]);
            setTimeout(() => document.getElementById(`pre-${rows.length}`)?.focus(), 0);
          }}
        >
          Add precondition
        </Button>
      )}
    </div>
  );
}

function PrioritySourceInline({ c }: { c: Detail }) {
  return (
    <span className="inline-flex items-center gap-1 text-small text-fg">
      Priority <span className="font-medium text-fg-strong">{c.priority ? c.priority.charAt(0).toUpperCase() + c.priority.slice(1) : "Low"}</span>
    </span>
  );
}

