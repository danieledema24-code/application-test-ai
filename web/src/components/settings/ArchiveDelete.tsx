"use client";

// Archive and delete (design P5 §13.5): owners and admins archive; only the owner schedules a permanent deletion,
// which runs 24 hours later and can be cancelled until then.

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canArchive, deleteBlocked, deletionCallout, deletionScheduledText } from "@/lib/hardening";
import { Button, Callout, Card, CardBody, ConfirmDialog, InlineError, Modal, TextField, useToast } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";

type Purge = { purge_scheduled_at: string | null; archived: boolean; message: string };

/** Danger callout under the project header while a deletion is scheduled (every page of the project). */
export function DeletionCallout() {
  const p = useProject();
  const { role } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const at = p.project?.purge_scheduled_at;
  if (!at) return null;
  async function cancel() {
    setBusy(true);
    try {
      const r = await api<Purge>(`/projects/${p.id}/purge`, { method: "DELETE" });
      toast(r.message, "success");
      p.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't cancel the deletion.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Callout
      tone="danger"
      actions={
        role === "owner" ? (
          <Button variant="secondary" loading={busy} onClick={() => void cancel()}>
            Cancel deletion
          </Button>
        ) : undefined
      }
    >
      {deletionCallout(at)}
    </Callout>
  );
}

export function ArchiveDelete() {
  const p = useProject();
  const { role } = useAuth();
  const toast = useToast();
  const project = p.project;
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!project) return null;
  const archived = project.status === "archived";
  const name = project.name;
  const blocked = deleteBlocked(role, archived);
  const matches = typed.trim() === name;

  async function setArchived(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${p.id}/${next ? "archive" : "unarchive"}`, { method: "POST" });
      toast(next ? `${name} is archived. Nothing was deleted.` : `${name} is active again.`, "success");
      setConfirmArchive(false);
      p.refresh();
    } catch (e) {
      setConfirmArchive(false);
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function schedule() {
    if (!matches) return setTypedError("Type the project name exactly to confirm.");
    setBusy(true);
    try {
      const r = await api<Purge>(`/projects/${p.id}/purge`, { method: "POST", body: { confirm_name: typed.trim() } });
      // The API's message is in UTC; say it in the viewer's local time.
      toast(r.purge_scheduled_at ? deletionScheduledText(name, r.purge_scheduled_at) : r.message, "success");
      setDeleting(false);
      setTyped("");
      p.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setTypedError(e.message);
      else {
        setDeleting(false);
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-6">
        <h2 className="text-h2 font-semibold text-fg-strong">Archive and delete</h2>
        <section aria-labelledby="archive-h" className="space-y-2">
          <h3 id="archive-h" className="text-small font-semibold uppercase tracking-wide text-fg-muted">
            Archive
          </h3>
          {canArchive(role) ? (
            archived ? (
              <Button variant="secondary" loading={busy && !confirmArchive && !deleting} onClick={() => void setArchived(false)}>
                Unarchive
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setConfirmArchive(true)}>
                Archive project…
              </Button>
            )
          ) : (
            <p className="text-body text-fg-muted">Only owners and admins can archive or unarchive a project.</p>
          )}
          <p className="text-small text-fg-muted">Archiving hides the project from the list and stops new checks and runs. Everything is kept.</p>
        </section>
        <section aria-labelledby="delete-h" className="space-y-2">
          <h3 id="delete-h" className="text-small font-semibold uppercase tracking-wide text-fg-muted">
            Delete permanently
          </h3>
          {project.purge_scheduled_at ? (
            <p className="text-body text-fg">{deletionCallout(project.purge_scheduled_at)}</p>
          ) : (
            <Button variant="danger" aria-disabled={blocked ? true : undefined} aria-describedby={blocked ? "delete-why" : undefined} onClick={() => !blocked && setDeleting(true)}>
              Delete project permanently…
            </Button>
          )}
          {blocked && !project.purge_scheduled_at && (
            <p id="delete-why" className="text-small text-fg-muted">
              {blocked}
            </p>
          )}
          <p className="text-small text-fg-muted">Only archived projects can be deleted. Everything except the audit log is removed.</p>
        </section>
        <InlineError error={error} />
        <ConfirmDialog open={confirmArchive} onClose={() => setConfirmArchive(false)} onConfirm={() => void setArchived(true)} loading={busy} title={`Archive ${name}?`} confirmLabel="Archive project">
          <p>It leaves the projects list and can&apos;t start checks or runs. Nothing is deleted; you can unarchive it.</p>
        </ConfirmDialog>
        <Modal
          open={deleting}
          onClose={() => setDeleting(false)}
          title={`Delete ${name} permanently?`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} aria-disabled={!matches || undefined} onClick={() => void schedule()}>
                Schedule deletion
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p>This removes every requirement, test case, script, run, finding, defect, report and file of this project. Only the audit log keeps a record. Deletion runs in 24 hours; you can cancel until then.</p>
            <TextField
              data-autofocus
              label={`Type ${name} to confirm`}
              value={typed}
              error={typedError ?? undefined}
              autoComplete="off"
              onChange={(e) => {
                setTyped(e.target.value);
                setTypedError(null);
              }}
            />
          </div>
        </Modal>
      </CardBody>
    </Card>
  );
}
