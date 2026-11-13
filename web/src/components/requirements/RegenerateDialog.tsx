"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import {
  Button,
  InlineError,
  LinkButton,
  Modal,
  TextArea,
  useToast,
} from "@/components/ui";

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
  guidanceHint,
  aiOffNote,
  pendingReviewHref,
  pendingReview = false,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  stage: "requirements" | "test_strategy" | "test_design";
  title: string;
  intro: string;
  bullets: string[];
  initialGuidance?: string;
  onStarted: () => void;
  guidanceHint?: string;
  /** Shown when AI is off (design P3 §12.1). */
  aiOffNote?: string | null;
  /** Where to review a pending regeneration when the server says one exists (409). */
  pendingReviewHref?: string | null;
  /** A regeneration is already waiting for review: say so up front instead of offering to run (design P3 check 45). */
  pendingReview?: boolean;
}) {
  const toast = useToast();
  const [guidance, setGuidance] = useState(initialGuidance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) {
      setGuidance(initialGuidance);
      setError(null);
      setPending(false);
    }
  }, [open, initialGuidance]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const parameters =
        stage === "requirements"
          ? { include_documents: true, guidance: guidance.trim() || null }
          : { guidance: guidance.trim() || null };
      await api(`/projects/${projectId}/stages/${stage}/run`, {
        body: { reason: "regenerate", parameters },
      });
      toast(
        stage === "requirements"
          ? "Regenerating requirements…"
          : stage === "test_design"
            ? "Regenerating test cases…"
            : "Regenerating the Test Strategy…",
        "info",
      );
      onStarted();
      onClose();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === "conflict" &&
        stage === "test_design"
      ) {
        setError(PENDING_REVIEW_TEXT);
        setPending(true);
      } else if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === "conflict"
      )
        setError(
          "A regenerated version is still waiting for review. Apply or discard it first.",
        );
      else if (err instanceof ApiError && err.status === 409)
        setError(
          err.message || "This can’t run yet: an earlier gate isn’t approved.",
        );
      else if (err instanceof ApiError && err.status === 403)
        setError(
          "You don’t have permission to regenerate. Ask an owner or admin.",
        );
      else
        setError(
          `Couldn’t start regeneration. ${err instanceof Error ? err.message : ""}`.trim(),
        );
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
        pendingReview ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {pendingReviewHref && (
              <LinkButton href={pendingReviewHref} variant="primary">
                Review changes
              </LinkButton>
            )}
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void run()} loading={busy}>
              Regenerate
            </Button>
          </>
        )
      }
    >
      {pendingReview ? (
        <p className="text-body text-fg" id="regen-pending">
          {PENDING_REVIEW_TEXT}
        </p>
      ) : (
        <>
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
            hint={
              guidanceHint ??
              "Used when AI is set up. Rules-based generation ignores it."
            }
          />
          {aiOffNote && <p className="mt-2 text-small text-fg">{aiOffNote}</p>}
          <div className="mt-3 space-y-2">
            <InlineError error={error} />
            {pending && pendingReviewHref && (
              <LinkButton href={pendingReviewHref}>Review changes</LinkButton>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

export const PENDING_REVIEW_TEXT =
  "A regeneration is waiting for review. Review or discard it before starting another.";

/** Dialog copy for requirements (design §5.7). */
export function requirementsRegenerateCopy(o: {
  scanN: number | null;
  documents: number;
  protectedCount: number;
  rejected: number;
}) {
  const src = [
    o.scanN ? `Scan ${o.scanN}` : "the latest scan",
    o.documents
      ? `${o.documents} source document${o.documents === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const bullets: string[] = [];
  if (o.protectedCount)
    bullets.push(
      `${o.protectedCount} locked or edited requirement${o.protectedCount === 1 ? " is" : "s are"} kept. Any changes the agent suggests for them are shown as proposals.`,
    );
  if (o.rejected)
    bullets.push(
      `${o.rejected} rejected requirement${o.rejected === 1 ? " stays" : "s stay"} rejected and won’t be proposed again.`,
    );
  bullets.push("Nothing changes until you review and apply the results.");
  return {
    title: "Regenerate requirements?",
    intro: `The Requirements Engineering Agent will derive requirements again from ${src}.`,
    bullets,
  };
}

/** Dialog copy for test design (design P3 §12.1). */
export function testDesignRegenerateCopy(o: {
  reqV: number | null;
  strategyV: number | null;
  protectedCount: number;
  rejected: number;
}) {
  const bullets: string[] = [];
  if (o.protectedCount)
    bullets.push(
      `${o.protectedCount} approved, edited, locked or person-written case${o.protectedCount === 1 ? " is" : "s are"} kept. Any changes the agent suggests for them are shown as proposals.`,
    );
  if (o.rejected)
    bullets.push(
      `${o.rejected} rejected case${o.rejected === 1 ? " stays" : "s stay"} rejected and won’t be proposed again.`,
    );
  bullets.push("Nothing changes until you review and apply the results.");
  const from = [
    o.reqV ? `Requirements v${o.reqV}` : "the approved requirements",
    o.strategyV ? `Strategy v${o.strategyV}` : "the approved Test Strategy",
  ].join(" and ");
  return {
    title: "Regenerate test cases?",
    intro: `The Test Design Agent will design test cases again from ${from}.`,
    bullets,
  };
}
