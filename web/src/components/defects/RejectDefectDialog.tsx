"use client";

// Reject one or many defect drafts at Gate 8 (design P4 §11.3): a reason (required) and a comment (required).
// "Works as intended" points to the test case: if the application is right, the expected result is wrong.

import { useEffect, useState } from "react";
import { Button, Checkbox, InlineError, LinkButton, Modal, SelectField, TextArea } from "@/components/ui";
import { ACCEPTED_RISK_REASON, REJECT_REASONS, type RejectReason } from "@/lib/defects";

export type RejectInput = { reason: RejectReason; comment: string; duplicate_of: string | null; mark_findings?: boolean };

export function RejectDefectDialog({
  open,
  onClose,
  subject,
  count,
  caseKey,
  projectId,
  duplicates,
  onReject,
  nonFunctional = false,
}: {
  open: boolean;
  onClose: () => void;
  /** "DEF-0001" for one; undefined for bulk. */
  subject?: string;
  count: number;
  caseKey?: string | null;
  projectId: string;
  /** Other defects a duplicate can point to. */
  duplicates: { key: string; summary: string }[];
  onReject: (v: RejectInput) => Promise<void>;
  /** Accessibility, security or performance drafts: "Accepted risk" is offered (design P5 §10). */
  nonFunctional?: boolean;
}) {
  const [reason, setReason] = useState<RejectReason | "">("");
  const [dup, setDup] = useState("");
  const [comment, setComment] = useState("");
  const [markFindings, setMarkFindings] = useState(false);
  const [err, setErr] = useState<{ reason?: string; dup?: string; comment?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setDup("");
      setComment("");
      setMarkFindings(false);
      setErr({});
      setError(null);
    }
  }, [open]);
  async function submit() {
    const e: typeof err = {};
    if (!reason) e.reason = "Choose a reason and add a comment to reject.";
    if (reason === "duplicate" && !dup) e.dup = "Choose the defect this duplicates.";
    if (!comment.trim()) e.comment = "Choose a reason and add a comment to reject.";
    setErr(e);
    if (Object.keys(e).length || !reason) return;
    setBusy(true);
    try {
      await onReject({ reason, comment: comment.trim(), duplicate_of: reason === "duplicate" ? dup : null, ...(reason === "accepted_risk" ? { mark_findings: markFindings } : {}) });
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }
  const title = subject ? `Reject ${subject}` : `Reject ${count} defect${count === 1 ? "" : "s"}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Reject a draft when it isn't a real bug in the application, and say why."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            {subject ? `Reject ${subject}` : `Reject ${count}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset aria-describedby={err.reason ? "rej-reason-error" : undefined}>
          <legend className="mb-1 text-body font-medium text-fg-strong">
            Reason<span aria-hidden className="text-danger-fg"> *</span>
          </legend>
          {(nonFunctional ? [...REJECT_REASONS, ACCEPTED_RISK_REASON] : REJECT_REASONS).map((r) => (
            <label key={r.value} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="reject-reason" className="h-4 w-4" checked={reason === r.value} onChange={() => setReason(r.value)} />
              {r.label}
            </label>
          ))}
          {err.reason && (
            <p id="rej-reason-error" className="text-small font-medium text-danger-fg">
              {err.reason}
            </p>
          )}
        </fieldset>
        {reason === "duplicate" && (
          <SelectField label="Duplicate of" value={dup} onChange={(e) => setDup(e.target.value)} options={duplicates.map((d) => ({ value: d.key, label: `${d.key} ${d.summary}` }))} placeholder="Choose a defect" error={err.dup} />
        )}
        {reason === "works_as_intended" && (
          <div className="rounded-lg bg-elevated p-3 text-body text-fg ring-1 ring-line">
            <p>
              If the application is right, the test case&apos;s expected result is wrong.{" "}
              {caseKey && (
                <LinkButton size="sm" href={`/projects/${projectId}/test-cases/${caseKey}?edit=1`}>
                  Edit {caseKey}
                </LinkButton>
              )}
            </p>
            <p className="mt-1 text-small text-fg-muted">Editing it moves the case back to draft and Gate 5 needs approval again. Nothing changes automatically.</p>
          </div>
        )}
        {reason === "accepted_risk" && (
          <Checkbox
            label="Also mark the findings as Accepted risk with this comment"
            description="Otherwise the next check reports the same problem again as an occurrence."
            checked={markFindings}
            onChange={(e) => setMarkFindings(e.target.checked)}
          />
        )}
        <TextArea label="Comment" required value={comment} onChange={(e) => setComment(e.target.value)} rows={3} error={err.comment} maxLength={2000} />
        {error !== null && <InlineError error={error} />}
      </div>
    </Modal>
  );
}
