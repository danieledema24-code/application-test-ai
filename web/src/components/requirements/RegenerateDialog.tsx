"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button, InlineError, Modal, TextArea, useToast } from "@/components/ui";

/**
 * Regenerate (design P2 §5.7, also used for the Test Strategy). The run becomes a candidate: nothing changes
 * until the user reviews and applies it. Locked and edited items are kept; rejected ones stay rejected.
 */
export function RegenerateDialog({
  open,
  onClose,
  projectId,
  stage,
  title,
  intro,
  bullets,
  initialGuidance = "",
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  stage: "requirements" | "test_strategy";
  title: string;
  intro: string;
  bullets: string[];
  initialGuidance?: string;
  onStarted: () => void;
}) {
  const toast = useToast();
  const [guidance, setGuidance] = useState(initialGuidance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setGuidance(initialGuidance);
      setError(null);
    }
  }, [open, initialGuidance]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const parameters = stage === "requirements" ? { include_documents: true, guidance: guidance.trim() || null } : { guidance: guidance.trim() || null };
      await api(`/projects/${projectId}/stages/${stage}/run`, { body: { reason: "regenerate", parameters } });
      toast(stage === "requirements" ? "Regenerating requirements…" : "Regenerating the Test Strategy…", "info");
      onStarted();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "conflict") setError("A regenerated version is still waiting for review. Apply or discard it first.");
      else if (err instanceof ApiError && err.status === 409) setError(err.message || "This can’t run yet: an earlier gate isn’t approved.");
      else if (err instanceof ApiError && err.status === 403) setError("You don’t have permission to regenerate. Ask an owner or admin.");
      else setError(`Couldn’t start regeneration. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={intro}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void run()} loading={busy}>
            Regenerate
          </Button>
        </>
      }
    >
      <ul className="mb-4 list-disc space-y-1 pl-5 text-body text-fg">
        {bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <TextArea
        label="Guidance for the agent (optional)"
        placeholder="e.g. “Focus on checkout; ignore the blog.”"
        rows={3}
        maxLength={1000}
        value={guidance}
        onChange={(e) => setGuidance(e.target.value)}
        hint="Used when AI is set up. Rules-based generation ignores it."
      />
      <div className="mt-3">
        <InlineError error={error} />
      </div>
    </Modal>
  );
}

/** Dialog copy for requirements (design §5.7). */
export function requirementsRegenerateCopy(o: { scanN: number | null; documents: number; protectedCount: number; rejected: number }) {
  const src = [o.scanN ? `Scan ${o.scanN}` : "the latest scan", o.documents ? `${o.documents} source document${o.documents === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
  const bullets: string[] = [];
  if (o.protectedCount) bullets.push(`${o.protectedCount} locked or edited requirement${o.protectedCount === 1 ? " is" : "s are"} kept. Any changes the agent suggests for them are shown as proposals.`);
  if (o.rejected) bullets.push(`${o.rejected} rejected requirement${o.rejected === 1 ? " stays" : "s stay"} rejected and won’t be proposed again.`);
  bullets.push("Nothing changes until you review and apply the results.");
  return { title: "Regenerate requirements?", intro: `The Requirements Engineering Agent will derive requirements again from ${src}.`, bullets };
}
