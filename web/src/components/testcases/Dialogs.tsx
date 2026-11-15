"use client";

import { useEffect, useRef, useState } from "react";
import type { TestCaseSummary } from "@/lib/contract";
import { Button, InlineError, Modal, SelectField, TextArea } from "@/components/ui";

/** Case reject reasons (design P3 §8.5) and the API's reason codes. */
export const CASE_REJECT_REASONS = [
  { label: "Not useful", code: "not_applicable" },
  { label: "Duplicate of another test case", code: "duplicate" },
  { label: "Wrong expected result", code: "incorrect" },
  { label: "Out of scope", code: "out_of_scope" },
  { label: "Other", code: "other" },
] as const;

export type CaseRejection = { reason: (typeof CASE_REJECT_REASONS)[number]["code"]; duplicate_of: string | null; comment: string };

/** The status comment: the fixed reason (and duplicate key) lead it, as for requirements. */
export function caseRejectComment(label: string, dupKey: string, comment: string): string {
  const head = label === "Duplicate of another test case" && dupKey ? `${label}: ${dupKey}` : label;
  return comment.trim() ? `${head} — ${comment.trim()}` : head;
}

/** Reject one or many test cases (§8.5). */
export function CaseRejectDialog({
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
  subject?: string;
  candidates: TestCaseSummary[];
  onReject: (r: CaseRejection) => Promise<void>;
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
    if (reason === "Duplicate of another test case" && !dup) e.dup = "Choose the test case this duplicates.";
    if (reason === "Other" && !comment.trim()) e.comment = "Explain why it’s rejected.";
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.reason) reasonRef.current?.focus();
      return;
    }
    const def = CASE_REJECT_REASONS.find((r) => r.label === reason)!;
    const dupCase = candidates.find((c) => c.key === dup);
    setBusy(true);
    setError(null);
    try {
      await onReject({ reason: def.code, duplicate_of: dupCase?.id ?? null, comment: caseRejectComment(reason, dup, comment) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t reject. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={subject ? `Reject ${subject}?` : `Reject ${count} test case${count === 1 ? "" : "s"}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            Reject test case{count === 1 ? "" : "s"}
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
          options={CASE_REJECT_REASONS.map((r) => ({ value: r.label, label: r.label }))}
          error={errors.reason}
        />
        {reason === "Duplicate of another test case" && (
          <SelectField
            label="Duplicate of"
            required
            value={dup}
            onChange={(e) => setDup(e.target.value)}
            placeholder="Choose a test case"
            options={candidates.map((c) => ({ value: c.key, label: `${c.key} ${c.title}` }))}
            error={errors.dup}
          />
        )}
        <TextArea label="Comment" hint={reason === "Other" ? "Required for Other." : "Optional."} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} error={errors.comment} maxLength={500} />
        <p className="text-small text-fg-muted">The agent won’t propose this case again. You can restore it later.</p>
        <InlineError error={error} />
      </div>
    </Modal>
  );
}

export const DEPRECATE_REASONS = ["The requirement or constraint changed", "Replaced by another test case", "Other"] as const;

/** Deprecate approved cases (§8.5). There is no Delete anywhere. */
export function DeprecateDialog({
  open,
  onClose,
  subject,
  count = 1,
  candidates,
  onDeprecate,
}: {
  open: boolean;
  onClose: () => void;
  subject?: string;
  count?: number;
  candidates: TestCaseSummary[];
  onDeprecate: (comment: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [by, setBy] = useState("");
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<{ reason?: string; by?: string; comment?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setBy("");
      setComment("");
      setErrors({});
      setError(null);
    }
  }, [open]);

  async function submit() {
    const e: typeof errors = {};
    if (!reason) e.reason = "Choose a reason.";
    if (reason === "Replaced by another test case" && !by) e.by = "Choose the test case that replaces it.";
    if (reason === "Other" && !comment.trim()) e.comment = "Explain why it’s deprecated.";
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.reason) reasonRef.current?.focus();
      return;
    }
    const head = reason === "Replaced by another test case" ? `${reason}: ${by}` : reason;
    setBusy(true);
    setError(null);
    try {
      await onDeprecate(comment.trim() ? `${head} — ${comment.trim()}` : head);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t deprecate. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={subject ? `Deprecate ${subject}?` : `Deprecate ${count} test case${count === 1 ? "" : "s"}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy}>
            Deprecate test case{count === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-body text-fg">Deprecated cases stay in traceability and history, marked Deprecated. They won’t be automated or run. This can’t be undone.</p>
        <SelectField
          ref={reasonRef}
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Choose a reason"
          options={DEPRECATE_REASONS.map((r) => ({ value: r, label: r }))}
          error={errors.reason}
        />
        {reason === "Replaced by another test case" && (
          <SelectField
            label="Replaced by"
            required
            value={by}
            onChange={(e) => setBy(e.target.value)}
            placeholder="Choose a test case"
            options={candidates.map((c) => ({ value: c.key, label: `${c.key} ${c.title}` }))}
            error={errors.by}
          />
        )}
        <TextArea label="Comment" hint={reason === "Other" ? "Required for Other." : "Optional."} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} error={errors.comment} maxLength={500} />
        <InlineError error={error} />
      </div>
    </Modal>
  );
}
