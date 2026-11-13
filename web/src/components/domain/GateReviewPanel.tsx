"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CircleCheck, CircleX, Info } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { GateDecision, ScanDetail, StageRunDetail, StageState } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { gateReview } from "@/lib/lifecycle";
import { Button, Callout, Card, InlineError, StatusPill, TextArea, useToast } from "@/components/ui";
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

type Check = { tone: "ok" | "warn" | "fail"; text: string };

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
  out.push({ tone: "ok", text: `${scan.stats.forms} form${scan.stats.forms === 1 ? "" : "s"}${journeys !== undefined ? ` and ${journeys} user journey${journeys === 1 ? "" : "s"}` : ""} catalogued` });
  if (scan.auth_boundaries.length)
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
  return <CircleX className="h-4 w-4 shrink-0 text-danger-fg" aria-label="Problem" />;
}

/** Banner shown at the top of Discovery and in "Needs your attention" while the gate is open. */
export function GateBanner({ stage, reviewHref }: { stage: StageState; reviewHref: string }) {
  const review = gateReview(stage);
  if (!review || !stage.gate) return null;
  const name = `Gate ${stage.gate.key.slice(1)} · ${GATE_NAMES[stage.gate.key] ?? "Quality gate"}`;
  return (
    <Callout
      tone={review === "required" ? "warning" : "info"}
      title={review === "required" ? `${name} is waiting for your approval` : `${name} is ready for your review (approval recommended)`}
      actions={
        <Link href={reviewHref} className="inline-flex h-10 items-center gap-1 rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
          Review gate <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      }
    >
      Review the agent’s assessment, then approve or re-scan.
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

/**
 * Gate review (design spec §8.4). The recommendation is advisory: approving is never blocked.
 * Approve records the user, time and comment; focus then moves to the approved line.
 */
export function GateReviewPanel({
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
  /** Older scans: show the decision only. */
  readOnly?: boolean;
}) {
  const { canApprove } = useAuth();
  const toast = useToast();
  const gate = stage.gate;
  const version = stage.current_version;
  const run = useApi<StageRunDetail>(gate && version ? `/projects/${projectId}/stages/${stage.key}/runs/${version}` : null);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "request_changes">(null);
  const [error, setError] = useState<string | null>(null);
  const approvedRef = useRef<HTMLParagraphElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [justDecided, setJustDecided] = useState(false);

  const decisions = (run.data?.decisions ?? []).filter((d) => !d.gate || d.gate === gate?.key);
  const last = decisions[decisions.length - 1];
  // Open for a decision under both "required" (pending) and "recommended" (the Gate 2 default) policies.
  const review = gateReview(stage);
  const waiting = review !== null;
  const approved = !waiting && (stage.status === "approved" || gate?.status === "approved" || last?.decision === "approve");

  useEffect(() => {
    if (justDecided && approved) approvedRef.current?.focus();
  }, [justDecided, approved, last]);

  if (!gate) return null;

  async function decide(decision: "approve" | "request_changes") {
    setError(null);
    if (decision === "request_changes" && !comment.trim()) {
      setCommentError("Describe what needs to change.");
      commentRef.current?.focus();
      return;
    }
    setCommentError(null);
    setBusy(decision);
    try {
      await api(`/projects/${projectId}/gates/${gate!.key}/decision`, {
        body: { decision, comment: comment.trim(), stage_run_version: version },
      });
      setJustDecided(true);
      toast(decision === "approve" ? "Discovery approved." : "Changes requested.");
      setComment("");
      await run.mutate();
      onDecided();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "You don’t have permission to approve quality gates. Ask an owner or admin."
          : err instanceof ApiError && err.status === 409
            ? "This gate changed since you opened it. Refresh and review the latest scan."
            : `Couldn’t record your decision. ${errorMessage(err)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  const rating = scan?.completeness?.rating;
  // A cancelled or partial scan is never "Complete" (§8.5).
  const assessment = rating ? (rating === "good" && (scan?.status === "cancelled" || scan?.status === "partial") ? "Partially complete" : RATING[rating]) : null;
  const rec = gate.recommendation;
  const checks = scan ? completenessChecklist(scan, journeys) : [];
  // The same finding can come back as a completeness reason, a checklist line and a recommendation
  // reason; show each once, in the checklist first.
  const seen = new Set(checks.map((c) => key(c.text)));
  const reasons = unseen(scan?.completeness?.reasons ?? [], seen);
  const recReasons = unseen(rec?.reasons ?? [], seen);

  return (
    <Card as="section" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="gate-review" tabIndex={-1} className="text-h3 font-semibold text-fg-strong focus:outline-none">
          Gate {gate.key.slice(1)} · {GATE_NAMES[gate.key] ?? "Quality gate"}
        </h2>
        {review === "required" ? (
          <StatusPill status="awaiting_approval" label="Waiting for your approval" />
        ) : review === "recommended" ? (
          <StatusPill status="awaiting_approval" label="Ready for review" />
        ) : approved ? (
          <StatusPill status="approved" label="Approved" />
        ) : last?.decision === "request_changes" ? (
          <StatusPill status="changes_requested" label="Changes requested" />
        ) : (
          <StatusPill status="not_started" label="Not reached" />
        )}
      </div>
      <div className="space-y-4 px-5 py-4">
        {assessment && (
          <div>
            <p className="text-body text-fg-strong">
              <span className="font-semibold">Agent assessment:</span> {assessment}
              {typeof scan?.completeness?.score === "number" && <span className="text-fg-muted"> · score {scan.completeness.score}/100</span>}
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
          <ul aria-label="Completeness checks" className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.text} className="flex items-start gap-2 text-body text-fg">
                <span className="mt-0.5">
                  <CheckIcon tone={c.tone} />
                </span>
                {c.text}
              </li>
            ))}
          </ul>
        )}
        {rec && (
          <div className="rounded-md bg-elevated px-3 py-2">
            <p className="flex flex-wrap items-center gap-2 text-body text-fg-strong">
              <Info className="h-4 w-4 text-info-fg" aria-hidden />
              <span className="font-semibold">Recommendation:</span> {RECOMMEND[rec.recommend] ?? rec.recommend}
              <GeneratedByLabel generatedBy={rec.generated_by} />
            </p>
            {recReasons.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-9 text-small text-fg">
                {recReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {waiting && <p className="mt-1 pl-6 text-small text-fg-muted">The recommendation is advisory. You can approve regardless.</p>}
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
            <p className="mt-2 text-body text-fg">Discovery approved. Requirements analysis arrives in Phase 2; these findings are saved and will be used then.</p>
          </div>
        )}
        {approved && !last && (
          <p ref={approvedRef} tabIndex={-1} className="text-body text-fg-strong focus:outline-none">
            <StatusPill status="approved" label="Approved" />
          </p>
        )}
        {!waiting && last?.decision === "request_changes" && (
          <p className="text-body text-fg">
            Changes requested by {decisionBy(last)}
            {last.decided_at || last.created_at ? `, ${fmtDateTime(last.decided_at ?? last.created_at)}` : ""}
            {last.comment ? ` · “${last.comment}”` : ""}. Re-scan to produce a new version for review.
          </p>
        )}

        {waiting && !readOnly && (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-body text-fg">
              {review === "required"
                ? "Approval is required before the next stage can start. Approving marks the Discovery Report as Approved."
                : "Approval is recommended but not required. Approving records your sign-off and marks the Discovery Report as Approved; until then it stays a Draft."}
            </p>
            {!canApprove && <Callout tone="neutral">You can review this gate, but approving needs gate-approval permission. Ask an owner or admin.</Callout>}
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
              <Button onClick={() => void decide("approve")} loading={busy === "approve"} disabled={!!busy && busy !== "approve"}>
                Approve discovery
              </Button>
              <Button variant="secondary" onClick={() => void decide("request_changes")} loading={busy === "request_changes"} disabled={!!busy && busy !== "request_changes"}>
                Request changes
              </Button>
              <Button variant="secondary" onClick={onRescan}>
                Re-scan…
              </Button>
              {reportHref && (
                <Link href={reportHref} className="ml-auto inline-flex items-center gap-1 text-body font-medium text-navy-700 hover:underline">
                  View report <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
