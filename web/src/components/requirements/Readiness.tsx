"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ReadinessCriteria, ReadinessCriterion } from "@/lib/contract";
import { fmtDate } from "@/lib/format";
import { checklistChanges, checklistOrder } from "@/lib/requirements";
import { Button, Card, CardBody, CardHeader, ChecklistEditor, EmptyState, ErrorState, Skeleton, useToast } from "@/components/ui";

function ChecklistCard({
  projectId,
  kind,
  items,
  intro,
  approvedOn,
  canEdit,
  onSaved,
}: {
  projectId: string;
  kind: "dor" | "dod";
  items: ReadinessCriterion[];
  intro: string;
  approvedOn: string | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = items.filter((c) => c.status === "active");
  const title = `${kind === "dor" ? "Definition of Ready" : "Definition of Done"} (${active.length})`;

  async function save(rows: { id: string; text: string }[]) {
    const { create, update, remove } = checklistChanges(active, rows);
    setBusy(true);
    setError(null);
    try {
      const versions = new Map(active.map((c) => [c.id, c.version]));
      for (const u of update) {
        const saved = await api<ReadinessCriterion>(`/readiness-criteria/${u.id}`, { method: "PATCH", body: { version: u.version, text: u.text } });
        versions.set(saved.id, saved.version);
      }
      for (const r of remove) await api(`/readiness-criteria/${r.id}/status`, { body: { version: r.version, status: "removed" } });
      const createdIds: string[] = [];
      for (const text of create) {
        const saved = await api<ReadinessCriterion>(`/projects/${projectId}/readiness-criteria`, { body: { kind, scope: "requirement", text } });
        createdIds.push(saved.id);
        versions.set(saved.id, saved.version);
      }
      // Moving each row to its index in turn leaves the whole list in the edited order.
      const order = checklistOrder(
        active.map((c) => c.id),
        rows,
        createdIds,
      );
      for (const [position, id] of (order ?? []).entries()) {
        await api(`/readiness-criteria/${id}`, { method: "PATCH", body: { version: versions.get(id), position } });
      }
      setEditing(false);
      toast(`${kind === "dor" ? "Definition of Ready" : "Definition of Done"} saved.`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Someone else changed this list. Reload to see their version." : `Couldn’t save. Your changes are still here. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={title}
        actions={
          canEdit && !editing ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} aria-label={`Edit ${kind === "dor" ? "Definition of Ready" : "Definition of Done"}`}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        <p className="text-body text-fg">{intro}</p>
        {editing ? (
          <ChecklistEditor initial={active.map((c) => ({ id: c.id, text: c.text }))} onSave={(rows) => void save(rows)} onCancel={() => setEditing(false)} busy={busy} error={error} />
        ) : (
          <ol className="space-y-2">
            {active.map((c, i) => (
              <li key={c.id} className="flex items-start justify-between gap-3 text-body text-fg">
                <span>
                  <span className="mr-1 tabular-nums text-fg-muted">{i + 1}.</span>
                  {c.text}
                </span>
                <span className="shrink-0 text-caption text-fg-muted">{c.generated_by === "human" ? "Added by you" : "Suggested"}</span>
              </li>
            ))}
          </ol>
        )}
        {approvedOn && <p className="text-small text-fg-muted">Approved with Gate 3 · {approvedOn}</p>}
      </CardBody>
    </Card>
  );
}

/** Ready & Done tab (design P2 §6.1): numbered criteria (not tick boxes), editable as ordered lists. */
export function ReadinessTab({
  projectId,
  data,
  error,
  loading,
  canEdit,
  approvedAt,
  onChanged,
}: {
  projectId: string;
  data: ReadinessCriteria | undefined;
  error: unknown;
  loading: boolean;
  canEdit: boolean;
  approvedAt: string | null;
  onChanged: () => void;
}) {
  if (error && !data) {
    if (error instanceof ApiError && error.status === 404) return <EmptyState title="Ready and Done criteria are generated with the requirements." />;
    return <ErrorState error={error} title="Couldn’t load requirements." message="Try again." onRetry={onChanged} />;
  }
  if (loading && !data)
    return (
      <div className="grid gap-6 lg:grid-cols-2" aria-hidden>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!data || (data.definition_of_ready.length === 0 && data.definition_of_done.length === 0)) return <EmptyState title="Ready and Done criteria are generated with the requirements." />;
  const on = approvedAt ? fmtDate(approvedAt) : null;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ChecklistCard projectId={projectId} kind="dor" items={data.definition_of_ready} intro="A requirement is ready for test design when:" approvedOn={on} canEdit={canEdit} onSaved={onChanged} />
      <ChecklistCard projectId={projectId} kind="dod" items={data.definition_of_done} intro="Testing of a requirement is done when:" approvedOn={on} canEdit={canEdit} onSaved={onChanged} />
    </div>
  );
}
