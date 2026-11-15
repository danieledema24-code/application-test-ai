"use client";

// Raise or edit a defect (design P4 §11.4 Edit, §11.5). Every §11 field; severity/priority overrides need a reason.

import { useState } from "react";
import { fieldErrorsOf, ApiError } from "@/lib/api";
import { PRIORITY_TEXT, SEVERITY_TEXT, type DefectPriority, type Severity } from "@/lib/defects";
import { Button, InlineError, SelectField, TextArea, TextField } from "@/components/ui";

export type DefectFields = {
  summary: string;
  description: string;
  preconditions: string;
  steps: string;
  expected: string;
  actual: string;
  severity: Severity | "";
  priority: DefectPriority | "";
  severity_reason: string;
  priority_reason: string;
};

export const EMPTY_FIELDS: DefectFields = { summary: "", description: "", preconditions: "", steps: "", expected: "", actual: "", severity: "", priority: "", severity_reason: "", priority_reason: "" };

export const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

export function DefectForm({
  initial,
  original,
  submitLabel,
  onSubmit,
  onCancel,
  intro,
}: {
  initial: DefectFields;
  /** When editing: the saved severity/priority (a change needs a reason). */
  original?: { severity: Severity; priority: DefectPriority };
  submitLabel: string;
  onSubmit: (f: DefectFields) => Promise<void>;
  onCancel: () => void;
  intro?: React.ReactNode;
}) {
  const [f, setF] = useState<DefectFields>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof DefectFields) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const sevChanged = !!original && f.severity !== "" && f.severity !== original.severity;
  const priChanged = !!original && f.priority !== "" && f.priority !== original.priority;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.summary.trim()) errs.summary = "Add a summary.";
    if (!f.actual.trim()) errs.actual = "Describe the actual result.";
    if (sevChanged && !f.severity_reason.trim()) errs.severity_reason = "Explain why you changed the severity.";
    if (priChanged && !f.priority_reason.trim()) errs.priority_reason = "Explain why you changed the priority.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(f);
    } catch (x) {
      if (x instanceof ApiError) {
        const fe = fieldErrorsOf(x.details);
        if (Object.keys(fe).length) setErrors(fe);
      }
      setError(x);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="max-w-3xl space-y-4" noValidate>
      {intro}
      <TextField label="Summary" required value={f.summary} onChange={set("summary")} error={errors.summary} maxLength={300} />
      <TextArea label="Description" value={f.description} onChange={set("description")} rows={3} />
      <TextArea label="Preconditions" hint="One per line." value={f.preconditions} onChange={set("preconditions")} rows={2} />
      <TextArea label="Steps to reproduce" hint="One step per line." value={f.steps} onChange={set("steps")} rows={5} />
      <TextArea label="Expected result" value={f.expected} onChange={set("expected")} rows={2} />
      <TextArea label="Actual result" required value={f.actual} onChange={set("actual")} rows={2} error={errors.actual} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Severity" value={f.severity} onChange={set("severity")} options={Object.entries(SEVERITY_TEXT).map(([value, label]) => ({ value, label }))} placeholder="Derived from the risk" />
        <SelectField label="Priority" value={f.priority} onChange={set("priority")} options={Object.entries(PRIORITY_TEXT).map(([value, label]) => ({ value, label }))} placeholder="From the test case" />
      </div>
      {sevChanged && <TextField label="Why did you change the severity?" required value={f.severity_reason} onChange={set("severity_reason")} error={errors.severity_reason} />}
      {priChanged && <TextField label="Why did you change the priority?" required value={f.priority_reason} onChange={set("priority_reason")} error={errors.priority_reason} />}
      {error !== null && <InlineError error={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
