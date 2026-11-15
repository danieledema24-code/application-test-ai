"use client";

// Gate 7 review of a run request (design P4 §8.3): styled like GateReviewPanel, bound to a run. Approvers authorise
// or reject (comment required) and decide risky-action approvals in the same request; the requester can withdraw.

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { approvalsBlocker, waitingText, type ApprovalChoice, type RunDetail } from "@/lib/execution";
import { Button, Callout, StatusPill, TextArea } from "@/components/ui";
import { ApprovalsRow, AuthorisationSummary, RiskyActionCard } from "./RunDialog";

export function RunAuthorisationPanel({
  run,
  onChanged,
  onWithdraw,
  onRequestAgain,
}: {
  run: RunDetail;
  onChanged: (run: RunDetail, message: string) => void;
  onWithdraw: () => void;
  onRequestAgain: () => void;
}) {
  const can = run.permissions.can_authorise;
  const pending = run.approvals.filter((a) => a.status === "pending");
  const [choices, setChoices] = useState<ApprovalChoice[]>([]);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChoices(pending.map((a) => ({ kind: a.kind, decision: null, confirm_text: "" })));
    // Only when the set of approvals changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.map((a) => a.id).join(",")]);
  const scope = run.scope;
  const host = scope?.target_host ?? "";
  const blocker = run.request_problem ?? (can ? approvalsBlocker(choices, host) : null);
  const n = run.tests;
  const requester = run.requested_by?.full_name || run.requested_by?.email || "someone";

  async function decide(decision: "approve" | "reject") {
    setError(null);
    if (decision === "reject" && !comment.trim()) {
      setCommentError("Say why this run shouldn't go ahead.");
      return;
    }
    setCommentError(null);
    if (decision === "approve") {
      setTried(true);
      if (blocker) return;
    }
    setBusy(decision);
    try {
      const r = await api<RunDetail>(`/execution-runs/${run.id}/authorise`, {
        method: "POST",
        body: {
          decision,
          comment: comment.trim() || null,
          approvals: decision === "approve" ? choices.map((c) => ({ kind: c.kind, decision: c.decision, confirm_text: c.decision === "approve" ? c.confirm_text : null })) : [],
        },
      });
      onChanged(r, decision === "approve" ? `${run.key} authorised and starting.` : `${run.key} not authorised.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save the decision. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="g7-title" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="g7-title" className="text-h2 font-semibold text-fg-strong">
          Gate 7 · Authorise {run.key}
        </h2>
        <StatusPill status="awaiting_approval" label={can ? "Waiting for your authorisation" : "Waiting for authorisation by someone who can approve gates"} />
      </div>
      <div className="space-y-4 px-5 py-4">
        {!can && (
          <Callout tone="neutral">
            <span id="g7-permission">
              {waitingText(run.key, false)}. Authorising runs needs gate-approval permission.
            </span>
          </Callout>
        )}
        <p className="text-body text-fg">
          Requested by {requester} · {fmtDateTime(run.created_at)}
          {run.notes ? ` · "${run.notes}"` : ""}
        </p>
        {run.request_problem && (
          <Callout tone="warning" title="This request can't be authorised as requested" actions={run.permissions.is_requester || can ? <Button variant="secondary" onClick={onRequestAgain}>Request again</Button> : undefined}>
            {run.request_problem}
          </Callout>
        )}
        {scope && (
          <AuthorisationSummary
            scope={scope}
            approvals={
              <ApprovalsRow count={pending.length}>
                {pending.map((a, i) => {
                  const need = scope.approvals_needed.find((x) => x.kind === a.kind) ?? { kind: a.kind, title: a.title, case_keys: a.scope?.case_keys ?? [], cases: a.scope?.cases ?? [] };
                  return (
                    <RiskyActionCard
                      key={a.id}
                      need={need}
                      approvalKey={a.key}
                      host={host}
                      choice={choices[i] ?? { kind: a.kind, decision: null, confirm_text: "" }}
                      onChange={(c) => setChoices((cs) => cs.map((x, j) => (j === i ? c : x)))}
                      readOnly={!can}
                      showError={tried}
                    />
                  );
                })}
              </ApprovalsRow>
            }
          />
        )}
        {can && (
          <TextArea label="Comment (needed to reject)" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} error={commentError ?? undefined} maxLength={2000} />
        )}
        {error && (
          <p role="alert" className="text-small font-medium text-danger-fg">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          {can && (
            <div className="flex flex-col gap-1">
              <Button onClick={() => void decide("approve")} loading={busy === "approve"} aria-disabled={!!blocker || undefined} aria-describedby={blocker ? "g7-blocker" : undefined}>
                Authorise and run {n} {n === 1 ? "test" : "tests"}
              </Button>
              {blocker && (
                <p id="g7-blocker" className="text-small text-fg-muted">
                  {blocker}
                </p>
              )}
            </div>
          )}
          {can && (
            <Button variant="secondary" onClick={() => void decide("reject")} loading={busy === "reject"}>
              Reject request…
            </Button>
          )}
          {run.permissions.is_requester && run.permissions.can_cancel && (
            <Button variant="secondary" onClick={onWithdraw}>
              Withdraw request
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
