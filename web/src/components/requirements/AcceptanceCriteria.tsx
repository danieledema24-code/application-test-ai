"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { AcceptanceCriterion, ItemStatus } from "@/lib/contract";
import { Button, Callout, InlineError, StatusPill, TextArea, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";

/** "Then" holds extra "And" lines, one per line, each starting "And " (the API has one `then` field). */
export function splitThen(then: string): { then: string; and: string[] } {
  const lines = then.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const first: string[] = [];
  const and: string[] = [];
  for (const l of lines) {
    if (/^and\s+/i.test(l) && first.length) and.push(l.replace(/^and\s+/i, ""));
    else if (and.length) and.push(l);
    else first.push(l);
  }
  return { then: first.join(" "), and };
}

export function joinThen(then: string, and: string[]): string {
  return [then.trim(), ...and.map((a) => a.trim()).filter(Boolean).map((a) => `And ${a}`)].join("\n");
}

export type GwtValue = { given: string; when: string; then: string; and: string[] };
type GwtErrors = Partial<Record<"given" | "when" | "then", string>>;

export function validateGwt(v: GwtValue): GwtErrors {
  const e: GwtErrors = {};
  if (!v.given.trim()) e.given = "Describe the starting situation.";
  if (!v.when.trim()) e.when = "Describe the action.";
  if (!v.then.trim()) e.then = "Describe the expected result.";
  return e;
}

/** Given / When / Then editor with "And" lines (design P2 §5.3). */
export function GwtEditor({ initial, onSave, onCancel, saveLabel = "Save criterion", error }: { initial?: GwtValue; onSave: (v: GwtValue) => Promise<void>; onCancel: () => void; saveLabel?: string; error?: string | null }) {
  const [v, setV] = useState<GwtValue>(initial ?? { given: "", when: "", then: "", and: [] });
  const [errors, setErrors] = useState<GwtErrors>({});
  const [busy, setBusy] = useState(false);
  const givenRef = useRef<HTMLTextAreaElement>(null);
  const whenRef = useRef<HTMLTextAreaElement>(null);
  const thenRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => givenRef.current?.focus(), []);
  async function save() {
    const e = validateGwt(v);
    setErrors(e);
    if (Object.keys(e).length) {
      (e.given ? givenRef : e.when ? whenRef : thenRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      await onSave(v);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-md border border-line bg-elevated p-3">
      <TextArea ref={givenRef} label="Given" rows={2} maxLength={500} value={v.given} onChange={(e) => setV({ ...v, given: e.target.value })} error={errors.given} />
      <TextArea ref={whenRef} label="When" rows={2} maxLength={500} value={v.when} onChange={(e) => setV({ ...v, when: e.target.value })} error={errors.when} />
      <TextArea ref={thenRef} label="Then" rows={2} maxLength={500} value={v.then} onChange={(e) => setV({ ...v, then: e.target.value })} error={errors.then} />
      {v.and.map((a, i) => (
        <div key={i} className="flex items-end gap-2">
          <TextArea label={`And (line ${i + 1})`} rows={1} wrapClassName="flex-1" value={a} onChange={(e) => setV({ ...v, and: v.and.map((x, j) => (j === i ? e.target.value : x)) })} />
          <Button variant="ghost" size="sm" aria-label={`Remove And line ${i + 1}`} onClick={() => setV({ ...v, and: v.and.filter((_, j) => j !== i) })}>
            Remove
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setV({ ...v, and: [...v.and, ""] })}>
        Add “And” line
      </Button>
      <InlineError error={error ?? null} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => void save()} loading={busy}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

function Gwt({ ac }: { ac: Pick<AcceptanceCriterion, "given" | "when" | "then"> }) {
  const { then, and } = splitThen(ac.then);
  const row = (k: string, v: string, i?: number) => (
    <div key={`${k}-${i ?? 0}`} className="grid grid-cols-[3.5rem_1fr] gap-2">
      <dt className="font-mono font-bold text-fg-strong">{k}</dt>
      <dd className="text-fg">{v}</dd>
    </div>
  );
  return (
    <dl className="space-y-0.5 text-body">
      {row("Given", ac.given)}
      {row("When", ac.when)}
      {row("Then", then)}
      {and.map((a, i) => row("And", a, i))}
    </dl>
  );
}

const AC_STATUS: Record<ItemStatus, string> = { draft: "Draft", approved: "Approved", rejected: "Rejected" };

/**
 * Acceptance criteria cards with per-criterion status, edit and add (design P2 §5.3). Locked requirements
 * can't have their criteria edited; status changes still work.
 */
export function AcceptanceCriteriaList({
  requirementId,
  criteria,
  readOnly,
  locked,
  onChanged,
}: {
  requirementId: string;
  criteria: AcceptanceCriterion[];
  readOnly: boolean;
  locked: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = criteria.filter((c) => c.status !== "rejected");
  const rejected = criteria.filter((c) => c.status === "rejected");

  function failure(err: unknown, what: string) {
    if (err instanceof ApiError && err.status === 409) return `Someone else changed ${what} while you were editing. Reload to see their version; your text is still here.`;
    if (err instanceof ApiError && err.status === 403) return "You don’t have permission to change acceptance criteria.";
    if (err instanceof ApiError && err.code === "network") return "You’re offline. Your changes are still here; save again when you reconnect.";
    return `Couldn’t save ${what}. Your changes are still here. Try again.`;
  }

  async function create(v: GwtValue) {
    setError(null);
    try {
      await api(`/requirements/${requirementId}/acceptance-criteria`, { body: { kind: "positive", given: v.given.trim(), when: v.when.trim(), then: joinThen(v.then, v.and) } });
      setEditing(null);
      toast("Acceptance criterion added.");
      await onChanged();
    } catch (err) {
      setError(failure(err, "the criterion"));
      throw err;
    }
  }

  async function update(ac: AcceptanceCriterion, v: GwtValue) {
    setError(null);
    try {
      await api(`/acceptance-criteria/${ac.id}`, { method: "PATCH", body: { version: ac.version, given: v.given.trim(), when: v.when.trim(), then: joinThen(v.then, v.and) } });
      setEditing(null);
      toast(`${ac.key} saved.`);
      await onChanged();
    } catch (err) {
      setError(failure(err, ac.key));
      throw err;
    }
  }

  async function setStatus(ac: AcceptanceCriterion, status: ItemStatus) {
    setError(null);
    try {
      await api(`/acceptance-criteria/${ac.id}/status`, { body: { version: ac.version, status } });
      toast(`${ac.key} ${status === "approved" ? "approved" : status === "rejected" ? "rejected" : "moved back to draft"}.`);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section aria-labelledby="ac-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ac-heading" className="text-h3 font-semibold text-fg-strong">
          Acceptance criteria ({visible.length})
        </h2>
        {!readOnly && !locked && editing !== "new" && (
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing("new")}>
            Add criterion
          </Button>
        )}
      </div>
      {visible.length === 0 && editing !== "new" && (
        <Callout
          tone="warning"
          actions={
            !readOnly && !locked ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                Add criterion
              </Button>
            ) : undefined
          }
        >
          No acceptance criteria. Requirements need at least one before Gate 3 can pass its checks.
        </Callout>
      )}
      {editing === "new" && <GwtEditor onSave={create} onCancel={() => setEditing(null)} error={error} />}
      {editing !== "new" && <InlineError error={error} />}
      <ul className="space-y-3">
        {visible.map((ac) => (
          <li key={ac.id} className="rounded-md border border-line bg-surface p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-small font-semibold text-fg-strong">{ac.key}</span>
                <StatusPill status={ac.status} label={AC_STATUS[ac.status]} tone={ac.status === "draft" ? "amber" : undefined} />
                {ac.kind !== "positive" && <span className="text-caption text-fg-muted">{ac.kind === "negative" ? "Negative" : "Boundary"}</span>}
                <GeneratedByLabel generatedBy={ac.generated_by} />
              </span>
              {!readOnly && editing !== ac.id && (
                <span className="flex flex-wrap gap-2">
                  {ac.status !== "approved" && (
                    <Button size="sm" variant="secondary" onClick={() => void setStatus(ac, "approved")}>
                      Approve <span className="sr-only">{ac.key}</span>
                    </Button>
                  )}
                  {!locked && !ac.locked && (
                    <Button size="sm" variant="secondary" onClick={() => setEditing(ac.id)}>
                      Edit <span className="sr-only">{ac.key}</span>
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void setStatus(ac, "rejected")}>
                    Reject <span className="sr-only">{ac.key}</span>
                  </Button>
                </span>
              )}
            </div>
            {editing === ac.id ? (
              <GwtEditor initial={{ given: ac.given, when: ac.when, ...splitThen(ac.then) }} onSave={(v) => update(ac, v)} onCancel={() => setEditing(null)} error={error} />
            ) : (
              <Gwt ac={ac} />
            )}
          </li>
        ))}
      </ul>
      {rejected.length > 0 && (
        <p className="text-small text-fg-muted">
          {rejected.length} rejected criteri{rejected.length === 1 ? "on" : "a"} not shown ({rejected.map((r) => r.key).join(", ")}).
        </p>
      )}
    </section>
  );
}
