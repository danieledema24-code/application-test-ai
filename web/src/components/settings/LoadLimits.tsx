"use client";

// Organisation load limits (design P5 §9.7): every load test must stay within them; each still needs its own
// approval. The server's hard limits are shown and can't be changed here. Raising or lowering asks first.
// Members and viewers see "Only owners and admins can see this page." (design P5 §2, check 34).

import { useEffect, useState } from "react";
import { api, ApiError, fieldErrorsOf } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { durationShort, type Limits3 } from "@/lib/nonfunctional";
import { ADMIN_ONLY_PAGE } from "@/lib/hardening";
import { Button, Card, CardBody, ConfirmDialog, ErrorState, InlineError, Skeleton, TextField, useToast } from "@/components/ui";

type Settings = { load_ceiling: Limits3; effective_ceiling: Limits3; hard_cap: Limits3; can_edit: boolean; message?: string };

export function LoadLimits() {
  const { organisation } = useAuth();
  const toast = useToast();
  const q = useApi<Settings>(organisation ? `/organisations/${organisation.id}/settings` : null);
  const d = q.data;
  const [vus, setVus] = useState("");
  const [rps, setRps] = useState("");
  const [minutes, setMinutes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<null | "raise" | "lower">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!d) return;
    setVus(String(d.load_ceiling.vus));
    setRps(String(d.load_ceiling.rps));
    setMinutes(String(Math.round((d.load_ceiling.duration_s / 60) * 10) / 10));
  }, [d]);
  if (q.error && !d) return <ErrorState error={q.error} onRetry={() => q.mutate()} />;
  if (!d) return <Skeleton className="h-64" />;
  if (!d.can_edit) return <p className="text-body text-fg">{ADMIN_ONLY_PAGE}</p>;
  const next = { vus: Number(vus), rps: Number(rps), duration_s: Math.round(Number(minutes) * 60) };
  function check(): boolean {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(next) as [keyof Limits3, number][]) {
      if (!Number.isFinite(v) || v < 1) e[k] = "Enter a whole number above 0.";
      else if (v > d!.hard_cap[k]) e[k] = `This server allows up to ${k === "duration_s" ? durationShort(d!.hard_cap[k]) : d!.hard_cap[k]}.`;
    }
    setErrors(e);
    return !Object.keys(e).length;
  }
  function onSave() {
    if (!check()) return;
    const cur = d!.load_ceiling;
    const raise = next.vus > cur.vus || next.rps > cur.rps || next.duration_s > cur.duration_s;
    const lower = next.vus < cur.vus || next.rps < cur.rps || next.duration_s < cur.duration_s;
    if (raise) setConfirm("raise");
    else if (lower) setConfirm("lower");
    else void save();
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Settings>(`/organisations/${organisation!.id}/settings`, { method: "PATCH", body: { load_ceiling: next } });
      toast(r.message ?? "Load limits saved.", "success");
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
  return (
    <Card>
      <CardBody className="space-y-4">
        <h2 className="text-h2 font-semibold text-fg-strong">Load limits</h2>
        <p className="text-body text-fg">Every load test in this organisation must stay within these limits. Each test still needs its own approval.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Virtual users" type="number" min={1} value={vus} onChange={(e) => setVus(e.target.value)} error={errors.vus} hint={errors.vus ? undefined : `This server allows up to ${d.hard_cap.vus}.`} />
          <TextField label="Requests a second" type="number" min={1} value={rps} onChange={(e) => setRps(e.target.value)} error={errors.rps} hint={errors.rps ? undefined : `This server allows up to ${d.hard_cap.rps}.`} />
          <TextField label="Duration (minutes)" type="number" min={1} step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} error={errors.duration_s} hint={errors.duration_s ? undefined : `This server allows up to ${durationShort(d.hard_cap.duration_s)}.`} />
        </div>
        <p className="text-small text-fg-muted">The server limits are set by whoever runs this server and can&apos;t be changed here.</p>
        <Button onClick={onSave} loading={busy && !confirm}>
          Save limits
        </Button>
        <InlineError error={error} />
        <ConfirmDialog
          open={confirm !== null}
          onClose={() => setConfirm(null)}
          onConfirm={save}
          loading={busy}
          title={confirm === "raise" ? `Raise the limits to ${next.vus} users, ${next.rps} requests a second and ${durationShort(next.duration_s)}?` : "Lower the limits?"}
          confirmLabel={confirm === "raise" ? "Raise limits" : "Lower limits"}
        >
          <p>{confirm === "raise" ? "Larger tests put more load on the sites you test." : "Pending load test requests above the new limits can no longer be approved."}</p>
        </ConfirmDialog>
      </CardBody>
    </Card>
  );
}
