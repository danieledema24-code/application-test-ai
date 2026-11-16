"use client";

// Repair suggestions (P6-04, decision D31; design P6 §8). One card per broken locator with up to three verified
// replacements, ranked by rules (the AI may only reorder them). A member accepts one candidate of one card behind a
// confirmation; there is no bulk selection and nothing is applied automatically. "Expected result may be out of date"
// cards have no accept: a person edits the test case (Gate 5).

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleDot, CircleX, FileWarning, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { useOnline } from "@/lib/useOnline";
import {
  REPAIR_LINE,
  REPAIRS_EMPTY,
  OFFLINE_LINE,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  acceptError,
  acceptName,
  acceptText,
  acceptedLine,
  cardTitle,
  checkingLine,
  firstChoice,
  groupByFile,
  levelText,
  notOfferedText,
  rejectedLine,
  replacedLine,
  reviewTitle,
  screenshotAlt,
  sourceLine,
  splitCandidates,
  statusLabel,
  verifiedLine,
  type AcceptRepairResponse,
  type Repair,
  type RepairCandidate,
  type RepairList as RepairListT,
  type SourceFilter,
  type StatusFilter,
} from "@/lib/repairs";
import { Button, Callout, ConfirmDialog, Disclosure, EmptyState, ErrorState, Modal, SelectField, Skeleton, TextArea, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { linksToItems, useEvidence } from "@/components/domain/EvidenceDrawer";
import { RemovedEvidence } from "@/components/domain/RemovedEvidence";

const link = "font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900";

// Polls while an accepted card's scripts are being checked again (module level: see changes/hooks.ts).
const checkingInterval = (d?: RepairListT) => (d?.items.some((r) => r.checking?.state === "checking") ? 3000 : 0);

export function useRepairs(projectId: string, query: { status?: StatusFilter; source?: SourceFilter; change_set?: string; execution_result?: string }, enabled = true) {
  const q = {
    status: query.status && query.status !== "all" ? query.status : undefined,
    source: query.source || undefined,
    change_set: query.change_set,
    execution_result: query.execution_result,
  };
  return useApi<RepairListT>(enabled ? `/projects/${projectId}/heal-suggestions` : null, q, { refreshInterval: checkingInterval });
}

/**
 * The cards of a project, a change set or a result (design P6 §8.1), grouped by page object file. With `filters`,
 * Status and Source selects; cards decided here stay in view until the filter changes, so focus can land on them.
 */
export function RepairList({
  projectId,
  changeSet,
  result,
  filters = false,
  focusKey,
  onChanged,
}: {
  projectId: string;
  changeSet?: string;
  result?: string;
  filters?: boolean;
  /** `&heal=HEAL-0001`: scroll to and focus that card. */
  focusKey?: string | null;
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<StatusFilter>(filters ? "open" : "all");
  const [source, setSource] = useState<SourceFilter>("");
  const q = useRepairs(projectId, { status, source, change_set: changeSet, execution_result: result });
  const [kept, setKept] = useState<Record<string, Repair>>({});
  const focused = useRef<string | null>(null);

  const items = useMemo(() => {
    const live = q.data?.items ?? [];
    const ids = new Set(live.map((r) => r.id));
    const extra = Object.values(kept).filter((r) => !ids.has(r.id));
    return [...live, ...extra].sort((a, b) => a.key.localeCompare(b.key));
  }, [q.data, kept]);

  useEffect(() => {
    if (!focusKey || !q.data || focused.current === focusKey) return;
    const el = document.getElementById(headingId(focusKey));
    if (!el) return;
    focused.current = focusKey;
    el.scrollIntoView({ block: "start" });
    el.focus();
  }, [focusKey, q.data]);

  function changed(r: Repair) {
    setKept((k) => ({ ...k, [r.id]: r }));
    void q.mutate();
    onChanged?.();
  }

  const filterBar = filters && (
    <div className="flex flex-col gap-3 md:flex-row md:items-end">
      <SelectField label="Status" value={status} options={STATUS_OPTIONS} onChange={(e) => (setStatus(e.target.value as StatusFilter), setKept({}))} wrapClassName="md:w-48" />
      <SelectField label="Source" value={source} options={SOURCE_OPTIONS} onChange={(e) => (setSource(e.target.value as SourceFilter), setKept({}))} wrapClassName="md:w-56" />
    </div>
  );

  if (q.error && !q.data) return <ErrorState error={q.error} title="Couldn’t load repair suggestions." message="Try again." onRetry={() => void q.mutate()} />;
  if (!q.data) return <Skeleton className="h-40" />;
  const groups = groupByFile(items);
  return (
    <div className="space-y-5">
      {filterBar}
      {items.length === 0 ? (
        <EmptyState title="No repair suggestions" description={REPAIRS_EMPTY.replace(/^No repair suggestions\. /, "")} />
      ) : (
        groups.map((g) => (
          <section key={g.file} aria-label={g.file} className="space-y-3">
            <h3 className="break-all text-h3 font-semibold text-fg-strong">{g.file}</h3>
            {g.items.map((r) =>
              kept[r.id] && !q.data?.items.some((x) => x.id === r.id) ? (
                <KeptCard key={r.id} repair={r} projectId={projectId} onChanged={changed} />
              ) : (
                <RepairCard key={r.id} repair={r} projectId={projectId} onChanged={changed} />
              ),
            )}
          </section>
        ))
      )}
    </div>
  );
}

const oneInterval = (d?: Repair) => (d?.checking?.state === "checking" ? 3000 : 0);

/** A card decided here that the filter no longer lists: it stays, and keeps showing its scripts' checks. */
function KeptCard({ repair, projectId, onChanged }: { repair: Repair; projectId: string; onChanged: (r: Repair) => void }) {
  const q = useApi<Repair>(`/heal-suggestions/${repair.id}`, undefined, { fallbackData: repair, refreshInterval: oneInterval });
  return <RepairCard repair={q.data ?? repair} projectId={projectId} onChanged={onChanged} />;
}

function headingId(key: string) {
  return `repair-${key}`;
}

/** One suggestion (design P6 §8.2–8.4). */
export function RepairCard({
  repair: r,
  projectId,
  onChanged,
  headingLevel = 4,
}: {
  repair: Repair;
  projectId: string;
  onChanged: (r: Repair) => void;
  /** 4 under a file group (h3); 3 directly under a section's h2 (the result page). */
  headingLevel?: 3 | 4;
}) {
  const H = headingLevel === 3 ? "h3" : "h4";
  const toast = useToast();
  const online = useOnline();
  const [choice, setChoice] = useState<number | null>(() => firstChoice(r));
  const [confirm, setConfirm] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const offlineId = useId();

  useEffect(() => {
    if (!focusHeading) return;
    headRef.current?.focus();
    setFocusHeading(false);
  }, [focusHeading, r.status]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const review = r.kind === "expected_result_review";
  const open = r.status === "open";
  const chosen = r.candidates.find((c) => c.index === choice) ?? null;
  const firstCase = r.used_by.find((u) => u.case_key);
  const caseHref = (key: string) => `/projects/${projectId}/test-cases/${key}`;

  async function accept() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<AcceptRepairResponse>(`/heal-suggestions/${r.id}/accept`, { method: "POST", body: { index: chosen.index } });
      setConfirm(false);
      toast(res.message, "success");
      onChanged(res.suggestion);
      setFocusHeading(true);
    } catch (e) {
      setConfirm(false);
      const status = e instanceof ApiError ? e.status : undefined;
      setError(acceptError(r, e instanceof ApiError ? e.message : "the server didn't answer", status));
      if (status === 409) onChanged(r);
    } finally {
      setBusy(false);
    }
  }

  const tone = review ? "bg-warning-bg ring-warning-line" : "bg-surface ring-line-strong";
  return (
    <article aria-labelledby={headingId(r.key)} className={`rounded-xl ring-1 ${tone}`}>
      <header className="flex flex-col gap-1 border-b border-line px-4 py-3 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-5">
        <H id={headingId(r.key)} ref={headRef} tabIndex={-1} className="break-words text-h3 font-semibold text-fg-strong">
          {review && <FileWarning className="mr-1.5 inline h-4 w-4 text-warning-fg" aria-hidden />}
          {r.status === "accepted" ? `${r.key} · ${acceptedLine(r, fmtDateTime)}` : cardTitle(r)}
        </H>
        <p className="text-small text-fg">
          <StatusText r={r} /> · {sourceLine(r)}
        </p>
      </header>
      <div className="space-y-4 px-4 py-4 text-body text-fg md:px-5">
        {error && (
          <div ref={errorRef} tabIndex={-1}>
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          </div>
        )}
        {review && r.review ? (
          <ReviewBody r={r} caseHref={caseHref} />
        ) : (
          <>
            {r.used_by.length > 0 && (
              <p>
                Used by {r.used_by.length === 1 ? "1 script" : `${r.used_by.length} scripts`}: {r.used_by.map((u) => u.case_key ?? u.path).join(", ")}
              </p>
            )}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-fg-muted">Current locator</span>
              <code className="break-all font-mono text-small text-fg-strong">{r.old_expression}</code>
              <span className="inline-flex items-center gap-1 text-small">
                <CircleX className="h-3.5 w-3.5 text-danger-fg" aria-hidden />
                Not found on {r.page ?? "the page"}
                {r.change_set ? ` after ${r.change_set.key}` : ""}
              </span>
            </p>
            {r.status === "accepted" && <AcceptedBody r={r} />}
            {r.status === "rejected" && (
              <p className="flex flex-wrap items-center gap-2">
                {rejectedLine(r)}
                {firstCase?.case_key && (
                  <Link href={caseHref(firstCase.case_key)} className={link}>
                    Open {firstCase.case_key}
                  </Link>
                )}
              </p>
            )}
            {r.status === "superseded" && <p>{replacedLine(r)}</p>}
            {open && (
              <Candidates r={r} choice={choice} onChoose={setChoice} readOnly={!r.can_accept} />
            )}
            {open && r.no_candidate_reason && (
              <p className="flex flex-wrap items-center gap-2">
                {r.no_candidate_reason} Update the test case or regenerate the scripts.
                {firstCase?.case_key && (
                  <Link href={caseHref(firstCase.case_key)} className={link}>
                    Open {firstCase.case_key}
                  </Link>
                )}
              </p>
            )}
            {open && chosen && r.old_expression && (
              <div className="space-y-2">
                <p className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Change to {r.file_name}</p>
                <LocatorDiff from={r.old_expression} to={chosen.expression} />
              </div>
            )}
            <p className="text-small text-fg">{REPAIR_LINE}</p>
            {open && (r.can_accept || r.can_reject) && (
              <div className="space-y-2">
                <div className="flex flex-col gap-2 md:flex-row">
                  {r.can_accept && (
                    <Button
                      className="w-full md:w-auto"
                      aria-label={acceptName(r)}
                      aria-disabled={!online || !chosen ? true : undefined}
                      aria-describedby={!online ? offlineId : undefined}
                      onClick={() => online && chosen && setConfirm(true)}
                    >
                      Accept this replacement…
                    </Button>
                  )}
                  {r.can_reject && (
                    <Button
                      variant="secondary"
                      className="w-full md:w-auto"
                      aria-label={`Reject ${r.key}`}
                      aria-disabled={!online ? true : undefined}
                      aria-describedby={!online ? offlineId : undefined}
                      onClick={() => online && setRejecting(true)}
                    >
                      Reject…
                    </Button>
                  )}
                </div>
                {!online && (
                  <p id={offlineId} className="text-small font-medium text-fg-strong">
                    {OFFLINE_LINE}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {chosen && (
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          onConfirm={() => void accept()}
          title={`Accept ${r.key}?`}
          confirmLabel="Accept replacement"
          loading={busy}
          focusCancel
        >
          <p>{acceptText(r, chosen)}</p>
        </ConfirmDialog>
      )}
      <RejectDialog
        open={rejecting}
        repair={r}
        onClose={() => setRejecting(false)}
        onDone={(next, message) => {
          setRejecting(false);
          toast(message, "success");
          onChanged(next);
          setFocusHeading(true);
        }}
      />
    </article>
  );
}

/**
 * The one changed line (design P6 §8.2): "−" old and "+" new, with visually hidden "Before:"/"After:", so the difference
 * is text, not colour. A whole-line view rather than `DiffView`'s word diff, which can't show the two expressions whole.
 */
function LocatorDiff({ from, to }: { from: string; to: string }) {
  return (
    <div className="space-y-1 font-mono text-small">
      <p className="break-all rounded-sm bg-diff-del-bg px-2 py-1 text-diff-del-fg">
        <span aria-hidden>− </span>
        <span className="sr-only">Before: </span>
        {from}
      </p>
      <p className="break-all rounded-sm bg-diff-add-bg px-2 py-1 text-diff-add-fg">
        <span aria-hidden>+ </span>
        <span className="sr-only">After: </span>
        {to}
      </p>
    </div>
  );
}

function StatusText({ r }: { r: Repair }) {
  const label = statusLabel(r);
  const icon =
    r.status === "accepted" ? <CircleCheck className="h-3.5 w-3.5 text-success-fg" aria-hidden /> : r.kind === "expected_result_review" && r.status === "open" ? <FileWarning className="h-3.5 w-3.5 text-warning-fg" aria-hidden /> : null;
  return (
    <span className="inline-flex items-center gap-1 font-medium text-fg-strong">
      {icon}
      {label}
    </span>
  );
}

function ReviewBody({ r, caseHref }: { r: Repair; caseHref: (key: string) => string }) {
  const rv = r.review!;
  return (
    <div className="space-y-2">
      <p className="font-medium text-fg-strong">{reviewTitle(rv)}</p>
      <p className="break-words">{rv.message}</p>
      {r.status === "open" && (
        <div className="space-y-1">
          <Link href={caseHref(rv.case_key)} className={`${link} inline-flex min-h-6 items-center`}>
            Review {rv.case_key}
          </Link>
          <p className="text-small text-fg-muted">Edits go through Gate 5. This closes when {rv.case_key} is edited and approved.</p>
        </div>
      )}
    </div>
  );
}

function AcceptedBody({ r }: { r: Repair }) {
  const c = r.candidates.find((x) => x.index === r.accepted_index);
  const line = checkingLine(r);
  return (
    <div className="space-y-2">
      {c && (
        <p className="break-all font-mono text-small text-fg-strong">
          {r.old_expression} <span aria-hidden>→</span>
          <span className="sr-only"> replaced by </span> {c.expression}
        </p>
      )}
      <p role="status" className="flex flex-wrap items-center gap-1.5 text-body">
        {line?.tone === "busy" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
        {line?.tone === "ok" && <CircleCheck className="h-4 w-4 text-success-fg" aria-hidden />}
        {line?.tone === "bad" && <CircleX className="h-4 w-4 text-danger-fg" aria-hidden />}
        {line?.text}
      </p>
    </div>
  );
}

function Candidates({ r, choice, onChoose, readOnly }: { r: Repair; choice: number | null; onChoose: (i: number) => void; readOnly: boolean }) {
  const { main, other, notOffered } = splitCandidates(r);
  const name = useId();
  const row = (c: RepairCandidate) => <CandidateRow key={c.index} r={r} c={c} name={name} checked={choice === c.index} onChoose={onChoose} readOnly={readOnly} />;
  if (main.length + other.length + notOffered.length === 0) return null;
  const body = (
    <>
      <div className="space-y-3">{main.map(row)}</div>
      {notOffered.length > 0 && (
        <ul className="space-y-2">
          {notOffered.map((c) => (
            <li key={c.index} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
              <code className="break-all font-mono text-fg-strong">{c.expression}</code>
              <span className="text-fg">{notOfferedText(c)}</span>
            </li>
          ))}
        </ul>
      )}
      {other.length > 0 && (
        <Disclosure label={`Other possibilities (${other.length}, low match)`}>
          <div className="mt-2 space-y-3">{other.map(row)}</div>
        </Disclosure>
      )}
    </>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <GeneratedByLabel generatedBy={r.order === "ai" ? "ai" : "rules"} />
        {r.order === "ai" && r.explanation && <span className="text-small text-fg">{r.explanation}</span>}
      </div>
      {readOnly ? (
        <div className="space-y-3">
          <p className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Replacements</p>
          {body}
        </div>
      ) : (
        <fieldset className="space-y-3">
          <legend className="mb-2 break-all text-small font-semibold text-fg-strong">Choose a replacement for {r.old_expression}</legend>
          {body}
        </fieldset>
      )}
      {r.order === "ai" && r.rule_order.length > 0 && (
        <Disclosure label="Rule order">
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-small">
            {r.rule_order.map((x) => (
              <li key={x}>
                <code className="break-all font-mono">{x}</code>
              </li>
            ))}
          </ol>
        </Disclosure>
      )}
    </div>
  );
}

function CandidateRow({ r, c, name, checked, onChoose, readOnly }: { r: Repair; c: RepairCandidate; name: string; checked: boolean; onChoose: (i: number) => void; readOnly: boolean }) {
  const id = useId();
  const LevelIcon = c.level === "high" ? CircleCheck : c.level === "medium" ? CircleDot : null;
  const levelCls = c.level === "high" ? "text-success-fg" : c.level === "medium" ? "text-warning-fg" : "text-fg-muted";
  return (
    <div className="space-y-1.5 rounded-lg p-2 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {readOnly ? (
          <code className="break-all font-mono text-small text-fg-strong">{c.expression}</code>
        ) : (
          <label htmlFor={id} className="flex min-h-6 min-w-0 cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
            <input id={id} type="radio" name={name} checked={checked} onChange={() => onChoose(c.index)} className="h-4 w-4 shrink-0" aria-describedby={`${id}-why`} />
            <code className="break-all font-mono text-small text-fg-strong">{c.expression}</code>
          </label>
        )}
        <span className={`inline-flex items-center gap-1 text-small font-medium ${levelCls}`}>
          {LevelIcon && <LevelIcon className="h-3.5 w-3.5" aria-hidden />}
          {levelText(c)}
        </span>
      </div>
      <p id={`${id}-why`} className="break-words text-small text-fg">
        Why: {c.signals.map((s) => s.text).join(" · ")}
      </p>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <p className="inline-flex items-start gap-1 text-small text-fg">
          <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-fg" aria-hidden />
          {verifiedLine(c, r.page, fmtDateTime)}
        </p>
        {c.evidence && <Thumbnail r={r} c={c} />}
      </div>
    </div>
  );
}

function Thumbnail({ r, c }: { r: Repair; c: RepairCandidate }) {
  const open = useEvidence();
  const ev = c.evidence!;
  if (ev.removed) return <RemovedEvidence text={ev.removed} />;
  const alt = screenshotAlt(c, r.page);
  return (
    <figure className="flex items-end gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={ev.content_url} alt={alt} width={160} className="w-40 rounded-md ring-1 ring-line" />
      <figcaption>
        <button type="button" className={`${link} min-h-6 text-small`} onClick={() => open({ items: linksToItems([ev]), subject: `${r.key}: ${c.expression}` })}>
          Open full size<span className="sr-only"> screenshot for {c.expression}</span>
        </button>
      </figcaption>
    </figure>
  );
}

/** Reject with a required reason (design P6 §8.3; `Modal` sm). Validation runs on submit. */
function RejectDialog({ open, repair: r, onClose, onDone }: { open: boolean; repair: Repair; onClose: () => void; onDone: (r: Repair, message: string) => void }) {
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setInvalid(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (!reason.trim()) {
      setInvalid(true);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string; suggestion: Repair }>(`/heal-suggestions/${r.id}/reject`, { method: "POST", body: { reason: reason.trim() } });
      onDone(res.suggestion, res.message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reject the suggestion. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={`Reject ${r.key}?`}
      description="It won't be offered again for this locator on this page."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            Reject suggestion
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextArea
          ref={field}
          label="Reason"
          required
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={invalid ? "Say why. The reason is kept with the suggestion." : undefined}
          hint={invalid ? undefined : "Say why. The reason is kept with the suggestion."}
        />
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Modal>
  );
}
