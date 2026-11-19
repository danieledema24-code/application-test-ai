"use client";

// Organisation exploration limits (design P6 §9.9, decision D30): every exploratory session must stay within them;
// signed-in sessions also need approval. Owners and admins change them (same validation, confirmation and audit as
// the load limits, P5 §9.7); everyone else reads them. The server's cap is shown and can't be changed here.

import { useEffect, useState } from "react";
import { api, ApiError, fieldErrorsOf } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { ceilingError, type Budget } from "@/lib/exploratory";
import { Button, Card, CardBody, ConfirmDialog, InlineError, TextField, useToast } from "@/components/ui";

type Settings = { exploration_ceiling?: Budget; exploration_effective?: Budget; exploration_cap?: Budget; can_edit: boolean; message?: string };

export function ExplorationLimits() {
  const { organisation } = useAuth();
  const toast = useToast();
  const q = useApi<Settings>(organisation ? `/organisations/${organisation.id}/settings` : null);
  const d = q.data;
  const [actions, setActions] = useState("");
  const [minutes, setMinutes] = useState("");
  const [errors, setErrors] = useState<{ actions?: string; minutes?: string }>({});
  const [confirm, setConfirm] = useState<null | "raise" | "lower">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!d?.exploration_ceiling) return;
    setActions(String(d.exploration_ceiling.actions));
    setMinutes(String(d.exploration_ceiling.minutes));
  }, [d]);
  // Servers before P6-03a don't send exploration limits: nothing to show.
  if (!d?.exploration_ceiling || !d.exploration_cap) return null;
  const cur = d.exploration_ceiling;
  const cap = d.exploration_cap;
  const next = { actions: Number(actions), minutes: Number(minutes) };

  function onSave() {
    const e = { actions: ceilingError("actions", actions, cap) ?? undefined, minutes: ceilingError("minutes", minutes, cap) ?? undefined };
    setErrors(e);
    if (e.actions || e.minutes) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-limit-field="${e.actions ? "actions" : "minutes"}"]`)?.focus());
      return;
    }
    const raise = next.actions > cur.actions || next.minutes > cur.minutes;
    const lower = next.actions < cur.actions || next.minutes < cur.minutes;
    if (raise) setConfirm("raise");
    else if (lower) setConfirm("lower");
    else void save();
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Settings>(`/organisations/${organisation!.id}/settings`, { method: "PATCH", body: { exploration_ceiling: next } });
      toast(r.message ?? "Exploration limits saved.", "success");
      setConfirm(null);
      void q.mutate();
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
        <h2 className="text-h2 font-semibold text-fg-strong">Exploratory sessions</h2>
        <p className="text-body text-fg">Every session in this organisation must stay within these limits. Signed-in sessions also need approval.</p>
        {d.can_edit ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Actions per session"
                inputMode="numeric"
                value={actions}
                onChange={(e) => setActions(e.target.value)}
                error={errors.actions}
                hint={`This server allows up to ${cap.actions}.`}
                data-limit-field="actions"
              />
              <TextField
                label="Minutes per session"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                error={errors.minutes}
                hint={`This server allows up to ${cap.minutes}.`}
                data-limit-field="minutes"
              />
            </div>
            <Button onClick={onSave} loading={busy && !confirm}>
              Save exploration limits
            </Button>
          </>
        ) : (
          <>
            <dl className="grid gap-2 text-body sm:grid-cols-2">
              <div>
                <dt className="font-medium text-fg-strong">Actions per session</dt>
                <dd>
                  {cur.actions} <span className="text-small text-fg-muted">(this server allows up to {cap.actions})</span>
                </dd>
              </div>
              <div>
                <dt className="font-medium text-fg-strong">Minutes per session</dt>
                <dd>
                  {cur.minutes} <span className="text-small text-fg-muted">(this server allows up to {cap.minutes})</span>
                </dd>
              </div>
            </dl>
            <p className="text-small text-fg-muted">Only owners and admins can change these limits.</p>
          </>
        )}
        <InlineError error={error} />
        <ConfirmDialog
          open={confirm !== null}
          onClose={() => setConfirm(null)}
          onConfirm={save}
          loading={busy}
          title={confirm === "raise" ? `Raise the limits to ${next.actions} actions and ${next.minutes} minutes?` : "Lower the exploration limits?"}
          confirmLabel={confirm === "raise" ? "Raise limits" : "Lower limits"}
        >
          <p>{confirm === "raise" ? "Longer sessions click more on the sites you test." : "New sessions must stay within the lower limits."}</p>
        </ConfirmDialog>
      </CardBody>
    </Card>
  );
}
