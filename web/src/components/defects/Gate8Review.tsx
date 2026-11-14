"use client";

// Review · Gate 8 (design P4 §11.3, D11): each draft is confirmed or rejected on its own, or many at once.
// Members see the permission note first and disabled controls; no dialog opens for them.

import Link from "next/link";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { nextUndecided, reproText, SEVERITY_TEXT, type DefectList, type DefectRow } from "@/lib/defects";
import { Button, Callout, Disclosure, StatusPill, useToast } from "@/components/ui";
import { DefectStatusPill } from "@/components/domain/ExecutionLabels";
import { RejectDefectDialog, type RejectInput } from "./RejectDefectDialog";

export function Gate8Review({ projectId, drafts, decided, list, viewer, onChanged }: { projectId: string; drafts: DefectRow[]; decided: DefectRow[]; list: DefectList; viewer: boolean; onChanged: () => void }) {
  const toast = useToast();
  const can = list.permissions.can_decide && !viewer;
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<DefectRow[] | null>(null);
  const confirmRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const decidedRef = useRef<HTMLHeadingElement>(null);
  const n = drafts.length;

  function moveFocus(afterId: string) {
    const next = nextUndecided(drafts, afterId);
    setTimeout(() => (next ? confirmRefs.current[next]?.focus() : decidedRef.current?.focus()), 50);
  }

  async function confirm(d: DefectRow) {
    if (!can) return;
    setBusy(d.id);
    try {
      await api(`/defects/${d.id}/status`, { method: "POST", body: { action: "confirm" } });
      toast(`${d.key} confirmed.`, "success");
      moveFocus(d.id);
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t confirm. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }
  async function confirmSelected() {
    const rows = drafts.filter((d) => selected.includes(d.id));
    if (!rows.length) return;
    const r = await api<{ message: string }>(`/projects/${projectId}/defects/bulk-status`, { method: "POST", body: { action: "confirm", ids: rows.map((x) => x.id) } });
    toast(r.message, "success");
    setSelected([]);
    onChanged();
  }
  async function reject(v: RejectInput) {
    const rows = rejecting ?? [];
    if (rows.length === 1) {
      await api(`/defects/${rows[0].id}/status`, { method: "POST", body: { action: "reject", ...v } });
      toast(`${rows[0].key} rejected.`, "success");
      moveFocus(rows[0].id);
    } else {
      const r = await api<{ message: string }>(`/projects/${projectId}/defects/bulk-status`, { method: "POST", body: { action: "reject", ids: rows.map((x) => x.id), ...v } });
      toast(r.message, "success");
      setSelected([]);
    }
    setRejecting(null);
    onChanged();
  }

  const perm = !can ? "g8-permission" : undefined;
  return (
    <section aria-labelledby="g8-title" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="g8-title" className="text-h2 font-semibold text-fg-strong">
          Gate 8 · Defect review
        </h2>
        {n > 0 ? (
          <StatusPill status="awaiting_approval" label={can ? `${n} ${n === 1 ? "draft" : "drafts"} waiting for your review` : `${n} ${n === 1 ? "draft" : "drafts"} waiting for review by someone who can approve gates`} />
        ) : (
          <StatusPill status="completed" label="Done: no drafts waiting" />
        )}
      </div>
      <div className="space-y-4 px-5 py-4">
        {!can && !viewer && (
          <Callout tone="neutral">
            <span id="g8-permission">You can read and edit these drafts, but confirming or rejecting needs gate-approval permission. Ask someone who can approve gates.</span>
          </Callout>
        )}
        {n === 0 ? (
          <p className="text-body text-fg">No defect drafts are waiting. Gate 8 opens again when an analysis drafts a new defect.</p>
        ) : (
          <>
            <p className="text-body text-fg">Confirm a draft when it&apos;s a real bug in the application. Reject it when it isn&apos;t, and say why.</p>
            <ul className="divide-y divide-line">
              {drafts.map((d) => (
                <li key={d.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    {can && (
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5"
                        aria-label={`Select ${d.key} ${d.summary}`}
                        checked={selected.includes(d.id)}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-medium text-fg-strong">
                        <span className="font-mono">{d.key}</span> {d.summary}
                      </p>
                      <p className="text-small text-fg-muted">
                        {SEVERITY_TEXT[d.severity]} · {reproText(d.reproducibility)}
                        {d.cases.length ? ` · ${d.cases.join(", ")}` : ""}
                        {d.source === "analysis" ? " · from analysis" : " · raised by a person"}
                      </p>
                    </div>
                    <Link href={`/projects/${projectId}/defects/${d.key}`} className="text-small font-medium text-navy-700 underline underline-offset-2">
                      Open {d.key}
                    </Link>
                  </div>
                  {!viewer && (
                    <div className="flex flex-wrap gap-2 pl-0 sm:pl-8">
                      <Button
                        ref={(el) => {
                          confirmRefs.current[d.id] = el;
                        }}
                        size="sm"
                        onClick={() => void confirm(d)}
                        loading={busy === d.id}
                        aria-disabled={!can || undefined}
                        aria-describedby={perm}
                      >
                        Confirm {d.key}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => can && setRejecting([d])} aria-disabled={!can || undefined} aria-describedby={perm}>
                        Reject {d.key}…
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {can && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <span className="text-body text-fg">Selected {selected.length}</span>
                <Button size="sm" variant="secondary" onClick={() => void confirmSelected()} aria-disabled={!selected.length || undefined}>
                  Confirm selected
                </Button>
                <Button size="sm" variant="secondary" onClick={() => selected.length && setRejecting(drafts.filter((d) => selected.includes(d.id)))} aria-disabled={!selected.length || undefined}>
                  Reject selected…
                </Button>
              </div>
            )}
          </>
        )}
        <h3 ref={decidedRef} tabIndex={-1} className="text-body font-semibold text-fg-strong focus:outline-none">
          Decided ({decided.length})
        </h3>
        {decided.length > 0 && (
          <Disclosure label="Show decided defects">
            <ul className="space-y-1 text-body text-fg">
              {decided.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/projects/${projectId}/defects/${d.key}`} className="font-mono text-navy-700 underline underline-offset-2">
                    {d.key}
                  </Link>
                  {d.summary} <DefectStatusPill status={d.status} withNote={false} /> <span className="text-small text-fg-muted">{fmtDateTime(d.created_at)}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
      <RejectDefectDialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        subject={rejecting?.length === 1 ? rejecting[0].key : undefined}
        count={rejecting?.length ?? 0}
        caseKey={rejecting?.length === 1 ? rejecting[0].cases[0] : null}
        projectId={projectId}
        duplicates={list.items.filter((x) => !rejecting?.some((r) => r.id === x.id)).map((x) => ({ key: x.key, summary: x.summary }))}
        onReject={reject}
      />
    </section>
  );
}
