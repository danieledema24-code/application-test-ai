"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CircleCheck, CircleX, Info } from "lucide-react";
import type { GateCheck } from "@/lib/requirements";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { GateDecision, ScanDetail, StageRunDetail, StageState } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { scanSignIn } from "@/lib/discovery";
import { gateReview } from "@/lib/lifecycle";
import { Button, Callout, Card, ConfirmDialog, InlineError, StatusPill, TextArea, useToast } from "@/components/ui";
import { GeneratedByLabel } from "./ObservationLabel";

const GATE_NAMES: Record<string, string> = {
  G2: "Discovery completeness",
  G3: "Requirements review",
  G4: "Test strategy approval",
  G5: "Test case quality",
  G6: "Script validation",
  G7: "Execution authorisation",
  G8: "Defect review",
  G9: "Release readiness",
};

const RATING: Record<string, string> = { good: "Complete", partial: "Partially complete", limited: "Insufficient" };
const RECOMMEND: Record<string, string> = {
  proceed: "Proceed: discovery is complete enough to derive requirements.",
  proceed_with_caution: "Proceed with caution: review the gaps below before deriving requirements.",
  do_not_proceed: "Re-scan before deriving requirements: too much of the site couldn’t be observed.",
};

type Check = GateCheck;

/** Checklist lines built from the scan's own numbers (never invented). */
export function completenessChecklist(scan: ScanDetail, journeys?: number): Check[] {
  const out: Check[] = [];
  const limit = scan.limits?.max_pages;
  out.push({ tone: scan.stats.pages > 0 ? "ok" : "fail", text: `${scan.stats.pages} of ${scan.pages_found} page${scan.pages_found === 1 ? "" : "s"} found ${scan.stats.pages === 1 ? "was" : "were"} visited${limit ? ` (page limit ${limit})` : ""}` });
  out.push(
    scan.limits?.include_mobile
      ? { tone: "ok", text: "Visited pages captured on desktop and mobile" }
      : { tone: "warn", text: "Desktop only: no responsive observations" },
  );
  const signIn = scanSignIn(scan);
  if (signIn?.state === "succeeded") out.push({ tone: "ok", text: `Signed in with the test account: ${signIn.pages} signed-in page${signIn.pages === 1 ? "" : "s"} visited` });
  if (signIn?.state === "failed") out.push({ tone: "fail", text: `Sign-in failed: ${signIn.reason}` });
  out.push({ tone: "ok", text: `${scan.stats.forms} form${scan.stats.forms === 1 ? "" : "s"}${journeys !== undefined ? ` and ${journeys} user journey${journeys === 1 ? "" : "s"}` : ""} catalogued` });
  // After a successful sign-in the signed-in areas were explored, so the sign-in boundaries are no longer a gap.
  if (scan.auth_boundaries.length && signIn?.state !== "succeeded")
    out.push({
      tone: "warn",
      text: `${scan.auth_boundaries.length} area${scan.auth_boundaries.length === 1 ? " needs" : "s need"} credentials (${scan.auth_boundaries
        .slice(0, 3)
        .map((b) => {
          try {
            return new URL(b.url).pathname;
          } catch {
            return b.url;
          }
        })
        .join(", ")}${scan.auth_boundaries.length > 3 ? ", …" : ""})`,
    });
  const notVisited = Math.max(0, scan.pages_found - scan.stats.pages);
  if (notVisited > 0 && limit && scan.stats.pages >= limit) out.push({ tone: "warn", text: `${notVisited} page${notVisited === 1 ? "" : "s"} not visited: page limit reached` });
  if (scan.stats.failed_requests > 0) out.push({ tone: "fail", text: `${scan.stats.failed_requests} request${scan.stats.failed_requests === 1 ? "" : "s"} failed while loading pages` });
  return out;
}

function CheckIcon({ tone }: { tone: Check["tone"] }) {
  if (tone === "ok") return <CircleCheck className="h-4 w-4 shrink-0 text-success-fg" aria-label="Met" />;
  if (tone === "warn") return <AlertTriangle className="h-4 w-4 shrink-0 text-warning-fg" aria-label="Gap" />;
  if (tone === "info") return <Info className="h-4 w-4 shrink-0 text-info-fg" aria-label="Note" />;
  return <CircleX className="h-4 w-4 shrink-0 text-danger-fg" aria-label="Problem" />;
}

/** Banner shown at the top of Discovery and in "Needs your attention" while the gate is open. */
export function GateBanner({ stage, reviewHref }: { stage: StageState; reviewHref: string }) {
  const review = gateReview(stage);
  if (!review || !stage.gate) return null;
  const name = `Gate ${stage.gate.key.slice(1)} · ${GATE_NAMES[stage.gate.key] ?? "Quality gate"}`;
  const what = stage.gate.key === "G2" ? "approve or re-scan" : "approve or request changes";
  return (
    <Callout
      tone={review === "required" ? "warning" : "info"}
      title={review === "required" ? `${name} is waiting for your approval` : `${name} is ready for your review (approval recommended)`}
      actions={
        <Link href={reviewHref} className="inline-flex h-10 items-center gap-1 rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
          Review Gate {stage.gate.key.slice(1)} <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      }
    >
      Review the agent’s assessment, then {what}.
    </Callout>
  );
}

function decisionBy(d: GateDecision) {
  return d.decided_by?.full_name || d.decided_by?.email || "a team member";
}

/** Normalised form used to drop lines that repeat across reasons, checklist and recommendation. */
function key(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();
}

/** Strings from `lines` not already in `seen` (also adds them to `seen`). */
function unseen(lines: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const k = key(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}


export function gateName(key: string): string {
  return `Gate ${key.slice(1)} · ${GATE_NAMES[key] ?? "Quality gate"}`;
}

/** Latest decision for a gate: the one on the stage (Phase 2) or the run's decisions list. */
function useGateDecisions(projectId: string, stage: StageState) {
  const gate = stage.gate;
  const version = stage.current_version;
  const run = useApi<StageRunDetail>(gate && version ? `/projects/${projectId}/stages/${stage.key}/runs/${version}` : null);
  const decisions = (run.data?.decisions ?? []).filter((d) => !d.gate || d.gate === gate?.key);
  const last = decisions[decisions.length - 1] ?? gate?.decision ?? undefined;
  return { run, last };
}

export type GateConfirm = { title: string; body: React.ReactNode; confirmLabel: string; cancelLabel: string; onCancel?: () => void };

/**
 * Gate review (design P1 §8.4, P2 §6.2). Generic over the gate: the caller supplies code-computed checks,
 * the agent's assessment and recommendation (labelled), and the approve/after-approval copy. The
 * recommendation is advisory: approving is never blocked by it. Approve records the user, time and
 * comment; focus then moves to the approved line. Request changes needs a comment.
 */
export function GateReviewPanel({
  projectId,
  stage,
  title,
  assessment,
  assessmentReasons = [],
  checks,
  recommendation,
  approveLabel,
  approvedToast,
  afterApproveCopy,
  afterRequestChanges,
  extraActions,
  reportHref,
  reportLabel = "View report",
  readOnly,
  confirmApprove,
  approvalCopy,
  changesSinceApproval,
  onDecided,
}: {
  projectId: string;
  stage: StageState;
  title?: string;
  assessment?: string | null;
  assessmentReasons?: string[];
  checks: Check[];
  recommendation?: { text: string; generatedBy: string | null | undefined; reasons?: string[] } | null;
  approveLabel: string;
  approvedToast: string;
  afterApproveCopy: React.ReactNode;
  /** Shown after "Request changes" (e.g. [Regenerate with this feedback]). */
  afterRequestChanges?: (comment: string) => React.ReactNode;
  extraActions?: React.ReactNode;
  reportHref?: string;
  reportLabel?: string;
  readOnly?: boolean;
  /** When set, approving asks this first (e.g. "Approve with 4 drafts?"). */
  confirmApprove?: GateConfirm | null;
  /** The policy sentence above the comment. Defaults to the required/recommended copy. */
  approvalCopy?: { required: string; recommended: string };
  /** "Changes since approval: {n}" while a reopened gate waits (design §6.2). */
  changesSinceApproval?: { count: number; compareHref?: string } | null;
  onDecided: () => void;
}) {
  const { canApprove } = useAuth();
  const toast = useToast();
  const gate = stage.gate;
  const { run, last } = useGateDecisions(projectId, stage);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "request_changes">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lastRequest, setLastRequest] = useState<string | null>(null);
  const approvedRef = useRef<HTMLParagraphElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [justDecided, setJustDecided] = useState(false);

  const review = gateReview(stage);
  const waiting = review !== null;
  const approved = !waiting && (stage.status === "approved" || gate?.status === "approved" || last?.decision === "approve");
  const changesRequested = !waiting && !approved && (stage.status === "changes_requested" || gate?.status === "changes_requested" || last?.decision === "request_changes");

  useEffect(() => {
    if (justDecided && approved) approvedRef.current?.focus();
  }, [justDecided, approved, last]);

  if (!gate) return null;

  async function decide(decision: "approve" | "request_changes", skipConfirm = false) {
    setError(null);
    // Gate decisions need gate-approval permission: say so before any confirmation (R2-04).
    if (!canApprove) {
      setError("You don’t have permission to approve quality gates. Ask an owner or admin.");
      return;
    }
    if (decision === "request_changes" && !comment.trim()) {
      setCommentError("Describe what needs to change.");
      commentRef.current?.focus();
      return;
    }
    if (decision === "approve" && confirmApprove && !skipConfirm) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setCommentError(null);
    setBusy(decision);
    try {
      await api(`/projects/${projectId}/gates/${gate!.key}/decision`, {
        body: { decision, comment: comment.trim(), stage_run_version: stage.current_version },
      });
      setJustDecided(true);
      toast(decision === "approve" ? approvedToast : "Changes requested.");
      if (decision === "request_changes") setLastRequest(comment.trim());
      setComment("");
      await run.mutate();
      onDecided();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "You don’t have permission to approve quality gates. Ask an owner or admin."
          : err instanceof ApiError && err.code === "gate_blocked"
            ? `This gate can’t be approved yet. ${blockers(err)}`
            : err instanceof ApiError && err.status === 409
              ? "This gate changed since you opened it. Refresh and review the latest version."
              : `Couldn’t record your decision. ${errorMessage(err)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  // A hard blocker means the gate can't be approved as it is: a blocking precondition from the server, or a failing
  // check on G3/G4 (on G2 a failing check, e.g. a failed sign-in, is advice; the user may still approve).
  const hardBlocked = (gate.preconditions ?? []).some((x) => x.blocking && !x.met) || (gate.key !== "G2" && checks.some((c) => c.tone === "fail"));
  const changes = changesSinceApproval ?? (gate.changes_since_approval ? { count: gate.changes_since_approval } : null);
  const seen = new Set(checks.map((c) => key(c.text)));
  const reasons = unseen(assessmentReasons, seen);
  const recReasons = unseen(recommendation?.reasons ?? [], seen);
  const copy = approvalCopy ?? {
    required: "Approval is required before the next stage can start.",
    recommended: "Approval is recommended but not required. Approving records your sign-off.",
  };

  return (
    <Card as="section" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="gate-review" tabIndex={-1} className="text-h3 font-semibold text-fg-strong focus:outline-none">
          {title ?? gateName(gate.key)}
        </h2>
        {review === "required" ? (
          <StatusPill status="awaiting_approval" label="Waiting for your approval" />
        ) : review === "recommended" ? (
          <StatusPill status="awaiting_approval" label="Ready for review" />
        ) : approved ? (
          <StatusPill status="approved" label="Approved" />
        ) : changesRequested ? (
          <StatusPill status="changes_requested" label="Changes requested" />
        ) : (
          <StatusPill status="not_started" label="Not reached" />
        )}
      </div>
      <div className="space-y-4 px-5 py-4">
        {waiting && changes && changes.count > 0 && (
          <p className="text-body text-fg-strong">
            <span className="font-semibold">Changes since approval: {changes.count}</span>
            {changes.compareHref && (
              <>
                {" · "}
                <Link href={changes.compareHref} className="font-medium text-navy-700 underline underline-offset-2">
                  Compare with approved version
                </Link>
              </>
            )}
          </p>
        )}
        {assessment && (
          <div>
            <p className="text-body text-fg-strong">
              <span className="font-semibold">Agent assessment:</span> {assessment}
            </p>
            {reasons.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-body text-fg">
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {checks.length > 0 && (
          <ul aria-label="Gate checks" className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.text} className="flex items-start gap-2 text-body text-fg">
                <span className="mt-0.5">
                  <CheckIcon tone={c.tone} />
                </span>
                {c.href ? (
                  <Link href={c.href} className="underline decoration-line-strong underline-offset-2 hover:text-navy-900">
                    {c.text}
                  </Link>
                ) : (
                  c.text
                )}
              </li>
            ))}
          </ul>
        )}
        {recommendation && (
          <div className="rounded-md bg-elevated px-3 py-2">
            <p className="flex flex-wrap items-center gap-2 text-body text-fg-strong">
              <Info className="h-4 w-4 text-info-fg" aria-hidden />
              <span className="font-semibold">Recommendation:</span> {recommendation.text}
              <GeneratedByLabel generatedBy={recommendation.generatedBy} />
            </p>
            {recReasons.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-9 text-small text-fg">
                {recReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {waiting && !hardBlocked && <p className="mt-1 pl-6 text-small text-fg-muted">The recommendation is advisory. You can approve regardless.</p>}
          </div>
        )}

        {approved && last && (
          <div>
            <p ref={approvedRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 text-body text-fg-strong focus:outline-none">
              <StatusPill status="approved" label="Approved" />
              <span>
                by {decisionBy(last)}
                {last.decided_at || last.created_at ? `, ${fmtDateTime(last.decided_at ?? last.created_at)}` : ""}
                {last.comment ? ` · “${last.comment}”` : ""}
              </span>
            </p>
            <div className="mt-2 text-body text-fg">{afterApproveCopy}</div>
          </div>
        )}
        {approved && !last && (
          <p ref={approvedRef} tabIndex={-1} className="text-body text-fg-strong focus:outline-none">
            <StatusPill status="approved" label="Approved" />
          </p>
        )}
        {changesRequested && (
          <div className="space-y-2">
            <p className="text-body text-fg">
              Changes requested{last?.decision === "request_changes" ? ` by ${decisionBy(last)}` : ""}
              {last?.decided_at || last?.created_at ? `, ${fmtDateTime(last?.decided_at ?? last?.created_at)}` : ""}
              {last?.comment ? ` · “${last.comment}”` : ""}.
            </p>
            {afterRequestChanges?.(lastRequest ?? last?.comment ?? "")}
          </div>
        )}

        {waiting && !readOnly && (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-body text-fg">{review === "required" ? copy.required : copy.recommended}</p>
            {!canApprove && (
              <div id={`gate-${gate.key}-no-permission`}>
                <Callout tone="neutral">You can review this gate, but approving needs gate-approval permission. Ask an owner or admin.</Callout>
              </div>
            )}
            <TextArea
              ref={commentRef}
              label="Comment"
              hint="Optional when approving. Required when requesting changes."
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              error={commentError}
            />
            <InlineError error={error} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => void decide("approve")}
                loading={busy === "approve"}
                disabled={!canApprove || (!!busy && busy !== "approve")}
                aria-describedby={canApprove ? undefined : `gate-${gate.key}-no-permission`}
              >
                {approveLabel}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void decide("request_changes")}
                loading={busy === "request_changes"}
                disabled={!canApprove || (!!busy && busy !== "request_changes")}
                aria-describedby={canApprove ? undefined : `gate-${gate.key}-no-permission`}
              >
                Request changes
              </Button>
              {extraActions}
              {reportHref && (
                <Link href={reportHref} className="ml-auto inline-flex items-center gap-1 text-body font-medium text-navy-700 hover:underline">
                  {reportLabel} <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
      {confirmApprove && (
        <Modal2
          open={confirming}
          confirm={confirmApprove}
          busy={busy === "approve"}
          onCancel={() => {
            setConfirming(false);
            confirmApprove.onCancel?.();
          }}
          onClose={() => setConfirming(false)}
          onConfirm={() => void decide("approve", true)}
        />
      )}
    </Card>
  );
}

function blockers(err: ApiError): string {
  const d = err.details;
  if (Array.isArray(d)) {
    const msgs = d.map((x) => (x && typeof x === "object" && typeof (x as { message?: unknown }).message === "string" ? (x as { message: string }).message : null)).filter(Boolean);
    if (msgs.length) return msgs.join(" ");
  }
  return err.message;
}

/** Confirm dialog whose cancel action can do something (e.g. [Review drafts]). */
function Modal2({ open, confirm, busy, onCancel, onClose, onConfirm }: { open: boolean; confirm: GateConfirm; busy: boolean; onCancel: () => void; onClose: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog open={open} onClose={onClose} title={confirm.title} confirmLabel={confirm.confirmLabel} cancelLabel={confirm.cancelLabel} loading={busy} onConfirm={onConfirm} onCancel={onCancel}>
      {confirm.body}
    </ConfirmDialog>
  );
}

/** Gate 2 (discovery completeness): the Phase 1 behaviour, built on the generic panel. */
export function DiscoveryGateReview({
  projectId,
  stage,
  scan,
  journeys,
  onDecided,
  onRescan,
  reportHref,
  readOnly,
}: {
  projectId: string;
  stage: StageState;
  scan?: ScanDetail | null;
  journeys?: number;
  onDecided: () => void;
  onRescan: () => void;
  reportHref?: string;
  readOnly?: boolean;
}) {
  const rating = scan?.completeness?.rating;
  // A cancelled or partial scan is never "Complete" (§8.5).
  const assessment = rating ? (rating === "good" && (scan?.status === "cancelled" || scan?.status === "partial") ? "Partially complete" : RATING[rating]) : null;
  const score = typeof scan?.completeness?.score === "number" ? ` · score ${scan.completeness.score}/100` : "";
  const rec = stage.gate?.recommendation;
  const checks = scan ? completenessChecklist(scan, journeys) : [];
  return (
    <GateReviewPanel
      projectId={projectId}
      stage={stage}
      assessment={assessment ? `${assessment}${score}` : null}
      assessmentReasons={scan?.completeness?.reasons ?? []}
      checks={checks}
      recommendation={rec ? { text: RECOMMEND[rec.recommend] ?? rec.recommend, generatedBy: rec.generated_by, reasons: rec.reasons } : null}
      approveLabel="Approve discovery"
      approvedToast="Discovery approved."
      afterApproveCopy={<p>Discovery approved. The Requirements Engineering Agent is now deriving requirements.</p>}
      afterRequestChanges={() => <p className="text-body text-fg">Re-scan to produce a new version for review.</p>}
      approvalCopy={{
        required: "Approval is required before the next stage can start. Approving marks the Discovery Report as Approved.",
        recommended:
          "Approval is recommended but not required. Approving records your sign-off and marks the Discovery Report as Approved; until then it stays a Draft.",
      }}
      extraActions={
        <Button variant="secondary" onClick={onRescan}>
          Re-scan…
        </Button>
      }
      reportHref={reportHref}
      readOnly={readOnly}
      onDecided={onDecided}
    />
  );
}
