"use client";

// Retention (design P5 §13.4): how long heavy or sensitive evidence is kept. Shortening asks first.

import { useEffect, useState } from "react";
import { api, ApiError, fieldErrorsOf } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { ADMIN_ONLY_PAGE, RETENTION_ROWS, retentionErrors, shortening, type Retention as RetentionData, type RetentionField } from "@/lib/hardening";
import { Button, Card, CardBody, ConfirmDialog, ErrorState, InlineError, Skeleton, TextField, useToast } from "@/components/ui";

type Form = Record<RetentionField, string>;

export function Retention() {
  const { organisation } = useAuth();
  const toast = useToast();
  const q = useApi<RetentionData>(organisation ? `/organisations/${organisation.id}/retention` : null, undefined, { shouldRetryOnError: false });
  const d = q.data;
  const [form, setForm] = useState<Form>({ videos_traces_days: "", screenshots_days: "", timeseries_days: "" });
  const [errors, setErrors] = useState<Partial<Record<RetentionField, string>>>({});
  const [confirm, setConfirm] = useState<ReturnType<typeof shortening>>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (d) setForm({ videos_traces_days: String(d.videos_traces_days), screenshots_days: String(d.screenshots_days), timeseries_days: String(d.timeseries_days) });
  }, [d]);
  if (q.error && !d) {
    if (q.error instanceof ApiError && q.error.status === 403) return <p className="text-body text-fg">{ADMIN_ONLY_PAGE}</p>;
    return <ErrorState error={q.error} onRetry={() => q.mutate()} />;
  }
  if (!d) return <Skeleton className="h-64" />;
  const next = Object.fromEntries(RETENTION_ROWS.map(({ field }) => [field, Number(form[field])])) as Record<RetentionField, number>;
  function onSave() {
    const e = retentionErrors(form);
    setErrors(e);
    if (Object.keys(e).length) return;
    const s = shortening(d!, next);
    if (s) setConfirm(s);
    else void save();
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<RetentionData>(`/organisations/${organisation!.id}/retention`, { method: "PUT", body: next });
      toast(r.message ?? "Retention saved.", "success");
      setConfirm(null);
      q.mutate();
    } catch (e) {
      setConfirm(null);
      if (e instanceof ApiError && e.status === 422) setErrors(fieldErrorsOf(e.details));
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const ro = !d.can_edit;
  return (
    <Card>
      <CardBody className="space-y-4">
        <h2 className="text-h2 font-semibold text-fg-strong">Retention</h2>
        <p className="text-body text-fg">How long heavy or sensitive evidence is kept. Reports and the audit log are never removed by retention.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {RETENTION_ROWS.map(({ field, label }) => (
            <TextField key={field} label={`${label} (days)`} type="number" min={0} inputMode="numeric" value={form[field]} readOnly={ro} error={errors[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
          ))}
        </div>
        <p className="text-small text-fg-muted">
          0 keeps them forever. A daily clean-up removes files older than this. The record stays: what it was, when, and its checksum.
          {!d.saved && " Nothing is removed until a policy is saved."}
        </p>
        {!ro && (
          <Button onClick={onSave} loading={busy && !confirm}>
            Save retention
          </Button>
        )}
        <InlineError error={error} />
        <ConfirmDialog open={confirm !== null} onClose={() => setConfirm(null)} onConfirm={save} loading={busy} danger title={confirm?.title ?? ""} confirmLabel={confirm?.confirm} cancelLabel={confirm?.keep}>
          <p>{confirm?.body}</p>
        </ConfirmDialog>
      </CardBody>
    </Card>
  );
}
