"use client";

import { useState } from "react";
import type { Revision } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { Button, ConfirmDialog, Drawer } from "@/components/ui";
import { DiffView } from "./DiffView";

/** What kind of change a revision was (design P2 §5.3), from its source and changed fields. */
export function revisionType(r: Revision, first: boolean): string {
  if (r.source === "assistant_proposal") return "Applied from AI QA Analyst proposal";
  if (r.source === "regeneration_review") return "Regenerated";
  const ch = r.changes ?? {};
  if (r.change_reason?.startsWith("Restored")) return "Restored";
  if ("status" in ch) {
    const to = String(ch.status?.to ?? "");
    if (to === "approved") return "Approved";
    if (to === "rejected") return "Rejected";
    if (to === "needs_info") return "Marked as needs info";
    if (to === "draft") return "Moved back to draft";
  }
  if ("locked" in ch) return ch.locked?.to ? "Locked" : "Unlocked";
  if (first || r.source === "system") return "Generated";
  return "Edited";
}

export function revisionWho(r: Revision): string {
  return r.changed_by?.full_name || r.changed_by?.email || (r.source === "system" || r.source === "regeneration_review" ? "the agent" : "a team member");
}

/** One line: "v5 Edited by D. Edema · 10:42". */
export function RevisionLine({ r, first }: { r: Revision; first: boolean }) {
  const type = revisionType(r, first);
  return (
    <span>
      <span className="font-semibold tabular-nums text-fg-strong">v{r.version}</span> {type}
      {type !== "Generated" && type !== "Regenerated" ? ` by ${revisionWho(r)}` : ""} · <time dateTime={r.created_at}>{fmtDateTime(r.created_at)}</time>
      {r.change_reason ? <span className="text-fg-muted"> · “{r.change_reason}”</span> : null}
    </span>
  );
}

/**
 * Revision history drawer (design P2 §5.3): newest first, compare with previous, restore. Restoring
 * creates a new version with the old content; nothing is deleted.
 */
export function RevisionHistory({
  open,
  onClose,
  title,
  revisions,
  onRestore,
  canRestore = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  revisions: Revision[];
  onRestore?: (r: Revision) => Promise<void>;
  canRestore?: boolean;
}) {
  const [compare, setCompare] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  const sorted = [...revisions].sort((a, b) => b.version - a.version);
  const latest = sorted[0]?.version ?? 0;
  const minVersion = sorted[sorted.length - 1]?.version;
  return (
    <>
      <Drawer open={open} onClose={onClose} title={title} subtitle={`${revisions.length} revision${revisions.length === 1 ? "" : "s"}`} wide>
        {sorted.length === 0 ? (
          <p className="text-body text-fg-muted">No revisions yet.</p>
        ) : (
          <ol className="space-y-3">
            {sorted.map((r) => (
              <li key={r.version} className="rounded-md border border-line p-3">
                <p className="text-body text-fg">
                  <RevisionLine r={r} first={r.version === minVersion} />
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.keys(r.changes ?? {}).length > 0 && (
                    <Button size="sm" variant="secondary" aria-expanded={compare === r.version} onClick={() => setCompare(compare === r.version ? null : r.version)}>
                      Compare with previous
                    </Button>
                  )}
                  {onRestore && canRestore && r.version !== latest && (
                    <Button size="sm" variant="secondary" onClick={() => setRestoring(r)}>
                      Restore this version
                    </Button>
                  )}
                </div>
                {compare === r.version && (
                  <div className="mt-3 border-t border-line pt-3">
                    <DiffView changes={Object.entries(r.changes ?? {}).map(([field, c]) => ({ field, from: c.from, to: c.to }))} leftLabel={`Version ${r.version - 1}`} rightLabel={`Version ${r.version}`} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Drawer>
      <ConfirmDialog
        open={!!restoring}
        onClose={() => setRestoring(null)}
        title={`Restore version ${restoring?.version}?`}
        confirmLabel="Restore this version"
        loading={busy}
        onConfirm={async () => {
          if (!restoring || !onRestore) return;
          setBusy(true);
          try {
            await onRestore(restoring);
            setRestoring(null);
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          This creates version {latest + 1} with the content of version {restoring?.version}. Nothing is deleted.
        </p>
      </ConfirmDialog>
    </>
  );
}
