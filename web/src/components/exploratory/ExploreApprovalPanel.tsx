"use client";

// Approval of a signed-in session (design P6 §9.4, decision D30): the P5 load-test approval layout and typed-host rule
// (`useTypedHost`). The summary sentence and "What it does" come from the server verbatim. Someone who can approve
// types the host to approve, or refuses with a comment; the requester can withdraw; other members and viewers read.

import { useId, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { MEMBER_APPROVE_EXPLORE, type Session } from "@/lib/exploratory";
import { Button, Disclosure, InlineError, TextArea, TextField, useToast } from "@/components/ui";
import { useTypedHost } from "@/components/nonfunctional/LoadApproval";
import { ExploreWhatItDoes } from "./ExploreDialog";

/** "in 23 h" / "in 40 min" until the request expires (never negative). */
function expiresIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return "now";
  const h = Math.floor(ms / 3_600_000);
  return h >= 1 ? `in ${h} h` : `in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

export function ExploreApprovalPanel({ session, onDone, canApproveRole }: { session: Session; onDone: () => void; canApproveRole: boolean }) {
  const toast = useToast();
  const host = session.host ?? "";
  const th = useTypedHost(host);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | "withdraw" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const hintId = useId();
  const a = session.approval;
  if (!a) return null;
  const canDecide = session.permissions.can_approve;
  const pages = (session.page_list ?? []).map((x) => x.path);

  const focusHost = () => requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-approval-host]")?.focus());
  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    if (decision === "approve" && !th.ok) {
      th.setError(th.typed.trim() ? `Type ${host} exactly to approve.` : th.reason);
      focusHost();
      return;
    }
    if (decision === "reject" && !comment.trim()) {
      setCommentError("Say why this session shouldn't run.");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await api(`/approvals/${a!.id}/decision`, { method: "POST", body: { decision, comment: comment.trim() || undefined, confirm_text: decision === "approve" ? th.typed : undefined } });
      toast(decision === "approve" ? `${session.key} approved and starting.` : `${session.key} not approved.`, "success");
      onDone();
      if (decision === "approve") requestAnimationFrame(() => document.querySelector<HTMLElement>("h1[data-page-title]")?.focus());
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && decision === "approve") {
        th.setError(e.message);
        focusHost();
      } else if (e instanceof ApiError && e.status === 422) setCommentError(e.message);
      else setError(e);
      onDone();
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    if (busy) return;
    setBusy("withdraw");
    setError(null);
    try {
      const r = await api<{ message: string }>(`/quality-scans/${session.id}/withdraw`, { method: "POST" });
      toast(r.message, "success");
      onDone();
    } catch (e) {
      setError(e);
      onDone();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="approval-title" className="rounded-xl bg-surface ring-1 ring-warning-line">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id="approval-title" className="text-h3 font-semibold text-fg-strong">
          Approve exploratory session {session.key} · {a.key}
        </h2>
        <span className="text-small font-medium text-warning-fg">{canApproveRole ? "Waiting for your approval" : "Waiting for approval by someone who can approve"}</span>
      </div>
      <div className="space-y-4 px-5 py-4">
        <p className="text-small text-fg-muted">
          Requested by {session.requested_by?.full_name ?? "someone"} · {fmtDateTime(session.created_at)} · expires {fmtDateTime(a.expires_at)} ({expiresIn(a.expires_at)})
        </p>
        <p className="text-body text-fg-strong" data-testid="explore-summary">
          {session.summary_sentence}
        </p>
        <ExploreWhatItDoes items={session.what_it_does ?? []} />
        <div className="text-small text-fg [overflow-wrap:anywhere]">
          <span className="font-medium text-fg-strong">Pages: </span>
          {pages.slice(0, 3).join(", ")}
          {pages.length > 3 && (
            <Disclosure label={`Show pages (${pages.length})`} className="mt-1">
              <ul className="list-disc pl-5">
                {pages.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
        {canDecide && (
          <div className="space-y-3">
            <div className="max-w-md">
              <TextField
                label={`Type ${host} to approve`}
                value={th.typed}
                onChange={(e) => {
                  th.setTyped(e.target.value);
                  th.setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                error={th.error}
                data-approval-host
              />
              <p id={hintId} className="mt-1 text-small text-fg-muted">
                {th.ok ? "Your approval is recorded with your name, the time and that you typed the host." : th.reason}
              </p>
            </div>
            <TextArea
              label="Comment (needed to refuse)"
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setCommentError(null);
              }}
              rows={2}
              error={commentError}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => decide("approve")} loading={busy === "approve"} aria-disabled={!th.ok || undefined} aria-describedby={!th.ok ? hintId : undefined}>
                Approve and start exploring
              </Button>
              <Button variant="secondary" onClick={() => decide("reject")} loading={busy === "reject"}>
                Don&apos;t approve…
              </Button>
            </div>
          </div>
        )}
        {session.permissions.can_withdraw && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={withdraw} loading={busy === "withdraw"}>
              Withdraw request
            </Button>
          </div>
        )}
        {!canDecide && session.permissions.can_triage && <p className="text-small text-fg-muted">{MEMBER_APPROVE_EXPLORE}</p>}
        <InlineError error={error} />
      </div>
    </section>
  );
}
