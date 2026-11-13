"use client";

import { useEffect, useRef, useState } from "react";
import type { RequirementSummary } from "@/lib/contract";
import { Button, InlineError, Modal, SelectField, TextArea } from "@/components/ui";

export const REJECT_REASONS = ["Not a real feature", "Duplicate of another requirement", "Out of scope", "Incorrect", "Other"] as const;

/**
 * The status comment sent to the API. The contract has one free-text `comment`, so the fixed reason (and
 * the duplicate's key) lead it: "Duplicate of another requirement: REQ-0003 — same search box".
 */
export function rejectComment(reason: string, duplicateOf: string, comment: string): string {
  const head = reason === "Duplicate of another requirement" && duplicateOf ? `${reason}: ${duplicateOf}` : reason;
  return comment.trim() ? `${head} — ${comment.trim()}` : head;
}

/** Reject one or many requirements with a fixed reason (design P2 §5.3). */
export function RejectDialog({
  open,
  onClose,
  count,
  subject,
  candidates,
  onReject,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  /** "REQ-0007" for one, undefined for bulk. */
  subject?: string;
  /** Requirements a duplicate can point to. */
  candidates: RequirementSummary[];
  onReject: (comment: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [dup, setDup] = useState("");
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<{ reason?: string; dup?: string; comment?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setDup("");
      setComment("");
      setErrors({});
      setError(null);
    }
  }, [open]);

  async function submit() {
    const e: typeof errors = {};
    if (!reason) e.reason = "Choose a reason.";
    if (reason === "Duplicate of another requirement" && !dup) e.dup = "Choose the requirement this duplicates.";
    if (reason === "Other" && !comment.trim()) e.comment = "Explain why it’s rejected.";
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.reason) reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onReject(rejectComment(reason, dup, comment));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t reject. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const title = subject ? `Reject ${subject}?` : `Reject ${count} requirement${count === 1 ? "" : "s"}?`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            Reject requirement{count === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SelectField
          ref={reasonRef}
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Choose a reason"
          options={REJECT_REASONS.map((r) => ({ value: r, label: r }))}
          error={errors.reason}
        />
        {reason === "Duplicate of another requirement" && (
          <SelectField
            label="Duplicate of"
            required
            value={dup}
            onChange={(e) => setDup(e.target.value)}
            placeholder="Choose a requirement"
            options={candidates.map((c) => ({ value: c.key, label: `${c.key} ${c.title}` }))}
            error={errors.dup}
          />
        )}
        <TextArea label="Comment" hint={reason === "Other" ? "Required for Other." : "Optional."} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} error={errors.comment} maxLength={500} />
        <p className="text-small text-fg-muted">The agent won’t propose rejected requirements again. You can restore them later.</p>
        <InlineError error={error} />
      </div>
    </Modal>
  );
}
