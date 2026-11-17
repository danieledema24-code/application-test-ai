"use client";

// Gate 9 (design P6 §10.3, D33) and confirming a criterion the platform can't check (§10.4). An approver approves,
// rejects, or overrides to a different verdict with a reason of at least 20 characters; members see a read-only panel
// with the reason, viewers the pill and the recommendation only. A stale or replaced assessment can't be decided.

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { useOnline } from "@/lib/useOnline";
import {
  MEMBER_G9,
  OFFLINE_DECIDE,
  VERDICT_LABEL,
  confirmErrors,
  counterText,
  decisionConfirm,
  decisionErrors,
  decisionRecordText,
  overrideOptions,
  panelPill,
  staleText,
  supersededText,
  type Assessment,
  type ConfirmResponse,
  type Criterion,
  type Decision,
  type DecisionErrors,
  type DecisionResponse,
  type Verdict,
} from "@/lib/release";
import { Button, Callout, ConfirmDialog, Modal, StatusPill, TextArea, useToast } from "@/components/ui";

const link = "font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900";
export const GATE9_HEADING = "gate-9-heading";

const PILL_STATUS = { awaiting_approval: "awaiting_approval", final: "completed", rejected: "rejected", stale: "stale", superseded: "cancelled" } as const;

export function ReleaseDecisionPanel({
  a,
  projectId,
  supersededAt,
  onDecided,
  onConflict,
  assessAction,
}: {
  a: Assessment;
  projectId: string;
  /** When the assessment that replaced this one was made ("15 Nov 17:02"). */
  supersededAt: string | null;
  onDecided: (next: Assessment, message: string) => void;
  /** The assessment changed meanwhile (409): reload it. */
  onConflict: () => void;
  /** [Assess again] for members (stale or rejected), or null. */
  assessAction: React.ReactNode;
}) {
  const { role, canApprove } = useAuth();
  const member = role !== null && role !== "viewer";
  const approver = member && canApprove;
  const pill = panelPill(a, approver);
  const record = decisionRecordText(a, fmtDateTime);
  const rec = VERDICT_LABEL[a.recommendation];
  return (
    <section id="gate-9" aria-labelledby={GATE9_HEADING} className="scroll-mt-20 rounded-xl bg-surface ring-1 ring-line-strong">
      <header className="flex flex-col gap-2 border-b border-line px-4 py-3 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-5">
        <h2 id={GATE9_HEADING} tabIndex={-1} className="text-h3 font-semibold text-fg-strong focus:outline-none">
          Gate 9 · Release decision for {a.key}
        </h2>
        <StatusPill status={PILL_STATUS[a.status]} label={pill.text} tone={pill.tone} wrap />
      </header>
      <div className="space-y-4 px-4 py-4 text-body text-fg md:px-5">
        {record ? (
          <div className="space-y-3">
            <p className="break-words font-medium text-fg-strong">{record}</p>
            {a.status === "rejected" && assessAction}
          </div>
        ) : a.status === "superseded" ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {supersededText(a.superseded_by, supersededAt)}
            {a.superseded_by && (
              <Link href={`/projects/${projectId}/release-readiness/${a.superseded_by}`} className={link}>
                Open {a.superseded_by}
              </Link>
            )}
          </p>
        ) : (
          <>
            {a.status === "stale" && (
              <Callout tone="warning" actions={assessAction}>
                {staleText(a.stale_reason)}
              </Callout>
            )}
            {approver ? (
              <DecisionForm a={a} disabled={a.status !== "awaiting_approval"} onDecided={onDecided} onConflict={onConflict} />
            ) : member ? (
              <p>{MEMBER_G9}</p>
            ) : (
              <p>The platform recommends {rec}.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function DecisionForm({ a, disabled, onDecided, onConflict }: { a: Assessment; disabled: boolean; onDecided: (next: Assessment, message: string) => void; onConflict: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const online = useOnline();
  const name = user?.full_name || user?.email || "you";
  const [decision, setDecision] = useState<Decision | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  // Override and Reject each keep their own reason, so switching between them doesn't carry text across.
  const [overrideReason, setOverrideReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const reason = decision === "reject" ? rejectReason : decision === "override" ? overrideReason : "";
  const [errors, setErrors] = useState<DecisionErrors>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const firstVerdict = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const ids = { legend: useId(), decisionError: useId(), verdictError: useId(), offline: useId(), approveHelp: useId(), overrideHelp: useId(), rejectHelp: useId() };
  const rec = VERDICT_LABEL[a.recommendation];
  const n = a.conditions_list.length;
  const approveHelp =
    a.recommendation === "conditional"
      ? `The ${n} condition${n === 1 ? " is" : "s are"} listed in the report as what must still happen.`
      : a.recommendation === "no_go"
        ? "The report will say the release should not go ahead."
        : "Every criterion is met by recorded evidence.";

  function choose(d: Decision) {
    setDecision(d);
    setErrors({});
    if (d !== "override") setVerdict(null);
  }

  function submit() {
    if (disabled || !online) return;
    const e = decisionErrors(decision, verdict, reason, a.recommendation);
    setErrors(e);
    if (e.decision) return firstRadio.current?.focus();
    if (e.verdict) return firstVerdict.current?.focus();
    if (e.reason) return reasonRef.current?.focus();
    setServerError(null);
    setConfirm(true);
  }

  async function record() {
    if (!decision) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { decision };
      if (decision === "override") body.final_verdict = verdict;
      if (decision !== "approve") body.reason = reason.trim();
      const res = await api<DecisionResponse>(`/release-assessments/${a.id}/decision`, { body });
      setConfirm(false);
      toast(res.message, "success");
      onDecided(res.assessment, res.message);
    } catch (err) {
      setConfirm(false);
      setServerError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) onConflict();
      // Focus goes to the error through the dialog's returnFocusRef: it closes in the same render, after the callout exists.
    } finally {
      setBusy(false);
    }
  }

  const c = decisionConfirm(a, decision ?? "approve", verdict, reason, name);
  const options = overrideOptions(a.recommendation);
  const radioRow = "flex min-h-6 cursor-pointer items-start gap-2 pointer-coarse:min-h-11";
  return (
    <div className="space-y-4">
      {serverError && (
        <div ref={errorRef} tabIndex={-1} className="focus:outline-none">
          <Callout tone="danger" role="alert">
            {serverError}
          </Callout>
        </div>
      )}
      <p>The platform recommends {rec}. You decide; your decision is recorded with your name and the time.</p>
      <fieldset disabled={disabled} className="space-y-3" aria-describedby={errors.decision ? ids.decisionError : undefined}>
        <legend id={ids.legend} className="mb-1 text-body font-semibold text-fg-strong">
          Your decision on {a.key}
        </legend>
        {errors.decision && (
          <p id={ids.decisionError} className="text-small font-medium text-danger-fg">
            {errors.decision}
          </p>
        )}
        <div className="space-y-1">
          <label className={radioRow}>
            <input ref={firstRadio} type="radio" name={`g9-${a.id}`} className="mt-1 h-4 w-4 shrink-0" checked={decision === "approve"} onChange={() => choose("approve")} aria-describedby={ids.approveHelp} />
            <span className="font-medium text-fg-strong">Approve: {rec} becomes the final verdict</span>
          </label>
          <p id={ids.approveHelp} className="pl-6 text-small text-fg">
            {approveHelp}
          </p>
        </div>
        <div className="space-y-1">
          <label className={radioRow}>
            <input type="radio" name={`g9-${a.id}`} className="mt-1 h-4 w-4 shrink-0" checked={decision === "override"} onChange={() => choose("override")} aria-describedby={ids.overrideHelp} />
            <span className="font-medium text-fg-strong">Override: choose a different final verdict</span>
          </label>
          <p id={ids.overrideHelp} className="pl-6 text-small text-fg">
            Shown as &quot;Overridden by {name}: {"{reason}"}&quot; next to the verdict, in the reports and the audit log.
          </p>
          {decision === "override" && (
            <div className="space-y-3 pl-6 pt-1">
              <fieldset className="space-y-1" aria-describedby={errors.verdict ? ids.verdictError : undefined}>
                <legend className="text-small font-semibold text-fg-strong">Final verdict</legend>
                <div className="flex flex-wrap gap-x-5">
                  {options.map((v, i) => (
                    <label key={v} className={`${radioRow} items-center`}>
                      <input ref={i === 0 ? firstVerdict : undefined} type="radio" name={`g9-verdict-${a.id}`} className="h-4 w-4 shrink-0" checked={verdict === v} onChange={() => setVerdict(v)} />
                      {VERDICT_LABEL[v]}
                    </label>
                  ))}
                </div>
                {errors.verdict && (
                  <p id={ids.verdictError} className="text-small font-medium text-danger-fg">
                    {errors.verdict}
                  </p>
                )}
              </fieldset>
              <TextArea
                ref={reasonRef}
                label="Reason (at least 20 characters)"
                required
                rows={3}
                maxLength={2000}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                error={errors.reason}
                hint={counterText(overrideReason)}
              />
            </div>
          )}
        </div>
        <div className="space-y-1">
          <label className={radioRow}>
            <input type="radio" name={`g9-${a.id}`} className="mt-1 h-4 w-4 shrink-0" checked={decision === "reject"} onChange={() => choose("reject")} aria-describedby={ids.rejectHelp} />
            <span className="font-medium text-fg-strong">Reject this assessment</span>
          </label>
          <p id={ids.rejectHelp} className="pl-6 text-small text-fg">
            Nothing is decided. Gate 9 goes back to &quot;changes requested&quot;; assess again after dealing with the reason.
          </p>
          {decision === "reject" && (
            <div className="pl-6 pt-1">
              <TextArea ref={reasonRef} label="Reason" required rows={3} maxLength={2000} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} error={errors.reason} />
            </div>
          )}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Button
          className="w-full md:w-auto"
          aria-label={`Record decision for ${a.key}`}
          aria-disabled={disabled || !online ? true : undefined}
          aria-describedby={!online && !disabled ? ids.offline : undefined}
          onClick={submit}
        >
          Record decision…
        </Button>
        {!online && !disabled && (
          <p id={ids.offline} className="text-small font-medium text-fg-strong">
            {OFFLINE_DECIDE}
          </p>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => void record()} title={c.title} confirmLabel={c.confirmLabel} danger={decision === "reject"} loading={busy} focusCancel returnFocusRef={errorRef}>
        <p>{c.body}</p>
        {c.danger && (
          <Callout tone="danger">
            <span className="font-medium">{c.danger}</span>
          </Callout>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** design P6 §10.4: Met or Not met with a required reason; the recommendation is worked out again. */
export function ConfirmCriterionDialog({ a, criterion: c, onClose, onDone }: { a: Assessment; criterion: Criterion | null; onClose: () => void; onDone: (res: ConfirmResponse) => void }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<"met" | "not_met" | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ status?: string; reason?: string }>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const statusError = useId();
  useEffect(() => {
    if (c) {
      setStatus(null);
      setReason("");
      setErrors({});
      setServerError(null);
    }
  }, [c]);
  if (!c) return null;

  async function save() {
    if (!c) return;
    const e = confirmErrors(status, reason);
    setErrors(e);
    if (e.status) return firstRadio.current?.focus();
    if (e.reason) return reasonRef.current?.focus();
    setBusy(true);
    setServerError(null);
    try {
      const res = await api<ConfirmResponse>(`/release-assessments/${a.id}/criteria/${encodeURIComponent(c.id)}/confirm`, { body: { status, reason: reason.trim() } });
      onDone(res);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const name = user?.full_name || user?.email || "you";
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Confirm: ${c.text}`}
      description="The platform can't check this. Record what a person confirmed."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset aria-describedby={errors.status ? statusError : undefined}>
          <legend className="mb-1 text-body font-medium text-fg-strong">Result</legend>
          <div className="flex flex-wrap gap-x-6">
            {(["met", "not_met"] as const).map((s, i) => (
              <label key={s} className="flex min-h-6 cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
                <input ref={i === 0 ? firstRadio : undefined} type="radio" name={`confirm-${c.id}`} className="h-4 w-4" checked={status === s} onChange={() => setStatus(s)} />
                {s === "met" ? "Met" : "Not met"}
              </label>
            ))}
          </div>
          {errors.status && (
            <p id={statusError} className="mt-1 text-small font-medium text-danger-fg">
              {errors.status}
            </p>
          )}
        </fieldset>
        <TextArea
          ref={reasonRef}
          label="Reason"
          required
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
          hint={`Shown as "Confirmed by ${name}" on the assessment and in the report. The recommendation is worked out again.`}
        />
        {serverError && (
          <Callout tone="danger" role="alert">
            {serverError}
          </Callout>
        )}
      </div>
    </Modal>
  );
}
