"use client";

// Load test request and approval (design P5 §9.3–9.4, decision D18): every load test needs its own `load_test`
// approval by someone who can approve, with the host typed exactly. The summary sentence and limits come from the
// server and are shown verbatim.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { hostMatches } from "@/lib/execution";
import {
  durationShort,
  MEMBER_APPROVE_NOTE,
  thresholdSource,
  type Limits3,
  type LoadRun,
  type Profile,
} from "@/lib/nonfunctional";
import { Button, Callout, Disclosure, InlineError, Modal, TextArea, TextField, useToast } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";

/** The three limits side by side (§9.3); a definition list below md. */
export function LimitsTable({ test, organisation, server }: { test: Limits3; organisation: Limits3; server: Limits3 }) {
  const rows: [string, (l: Limits3) => string][] = [
    ["Virtual users", (l) => String(l.vus)],
    ["Requests a second", (l) => String(l.rps)],
    ["Duration", (l) => durationShort(l.duration_s)],
  ];
  return (
    <>
      <table className="hidden w-full text-small md:table" aria-label="Limits">
        <thead>
          <tr className="text-left text-caption uppercase tracking-[0.04em] text-fg-muted">
            <th scope="col" className="py-1 pr-4 font-semibold">
              Limits
            </th>
            <th scope="col" className="py-1 pr-4 font-semibold">
              This test
            </th>
            <th scope="col" className="py-1 pr-4 font-semibold">
              Your organisation
            </th>
            <th scope="col" className="py-1 font-semibold">
              This server (hard limit)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label} className="border-t border-line">
              <th scope="row" className="py-1.5 pr-4 text-left font-medium text-fg-strong">
                {label}
              </th>
              <td className="py-1.5 pr-4 tabular-nums">{f(test)}</td>
              <td className="py-1.5 pr-4 tabular-nums">{f(organisation)}</td>
              <td className="py-1.5 tabular-nums">{f(server)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="space-y-1 text-small md:hidden">
        {rows.map(([label, f]) => (
          <div key={label}>
            <dt className="inline font-medium text-fg-strong">{label}: </dt>
            <dd className="inline">
              this test {f(test)} · organisation {f(organisation)} · server {f(server)}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function WhatItDoes({ items, pages }: { items: string[]; pages: number }) {
  return (
    <div>
      <h3 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">What it does</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-small text-fg">
        <li>
          Opens {pages} page{pages === 1 ? "" : "s"} with {items[0]?.charAt(0).toLowerCase()}
          {items[0]?.slice(1)}
        </li>
        {items.slice(1).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/** The typed-host field and its rules (§9.3, §18): aria-disabled with the reason until the host matches. */
function useTypedHost(host: string) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ok = hostMatches(typed, host);
  return { typed, setTyped, error, setError, ok, reason: `Type ${host} to approve.` };
}

/** Request dialog (§9.3). Member: [Request approval]; approver: also type the host and [Approve and start load test]. */
export function LoadTestRequestDialog({
  open,
  onClose,
  projectId,
  profile,
  limits,
  canApprove,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  profile: Profile;
  limits: { organisation: Limits3; server: Limits3 };
  canApprove: boolean;
}) {
  const { summary, host, netloc, expected_requests_text: expectedText, what_it_does: whatItDoes } = profile.request_preview;
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"request" | "approve" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const th = useTypedHost(host);
  const hintId = useId();
  const reqN = profile.thresholds.filter((t) => t.source?.type === "requirement").length;

  async function send(approve: boolean) {
    if (approve && !th.ok) {
      th.setError(th.typed.trim() ? `Type ${host} exactly to approve.` : th.reason);
      return;
    }
    setBusy(approve ? "approve" : "request");
    setError(null);
    try {
      const run = await api<LoadRun>(`/projects/${projectId}/performance-runs`, {
        method: "POST",
        body: { profile_id: profile.id, note: note.trim() || undefined, approve, confirm_text: approve ? th.typed : undefined },
      });
      toast(approve ? `${run.key} approved and starting.` : `${run.key} requested. Someone who can approve must approve it.`, "success");
      onClose();
      router.push(`/projects/${projectId}/non-functional/load-tests/${run.key}`);
    } catch (e) {
      if (approve && e instanceof ApiError && e.status === 422) th.setError(e.message);
      else setError(new Error(`Couldn't request the load test: ${errorMessage(e)}. Nothing was sent to the site.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Request a load test · ${profile.key} v${profile.version}`}
      footer={
        canApprove ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => send(false)} loading={busy === "request"}>
              Request approval instead
            </Button>
            <Button
              onClick={() => send(true)}
              loading={busy === "approve"}
              aria-disabled={!th.ok || undefined}
              aria-describedby={!th.ok ? hintId : undefined}
            >
              Approve and start load test
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => send(false)} loading={busy === "request"}>
              Request approval
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <div>
          <h3 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Summary</h3>
          <p className="mt-1 text-body text-fg-strong" data-testid="load-summary">
            {summary}
          </p>
          <p className="text-small text-fg-muted">About {expectedText} requests.</p>
        </div>
        <LimitsTable test={{ vus: profile.totals.vus, rps: profile.totals.rps, duration_s: profile.totals.duration_s }} {...limits} />
        <WhatItDoes items={whatItDoes} pages={profile.targets.length} />
        <Disclosure label={`Thresholds ${profile.thresholds.length} (${profile.thresholds.length - reqN} default${reqN ? `, ${reqN} from requirements` : ""})`}>
          <ul className="space-y-1 text-small">
            {profile.thresholds.map((t, i) => (
              <li key={i}>
                {t.scope === "path" ? t.path : "All requests"}: {t.metric === "error_rate" ? `errors under ${(t.value * 100).toFixed(0)} %` : `${t.metric} under ${t.value} ms`} · {thresholdSource(t)}
              </li>
            ))}
          </ul>
        </Disclosure>
        <TextArea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
        {canApprove ? (
          <div className="space-y-1">
            <TextField
              label={`Type ${host} to approve and start`}
              value={th.typed}
              onChange={(e) => {
                th.setTyped(e.target.value);
                th.setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              error={th.error}
            />
            <p id={hintId} className="text-small text-fg-muted">
              {th.ok ? "Your approval is recorded with your name, the time and that you typed the host." : th.reason}
            </p>
          </div>
        ) : (
          <p className="text-small text-fg-muted">Nothing is sent to the site until someone who can approve types the host and approves.</p>
        )}
        <p className="sr-only">Target {netloc}</p>
        <InlineError error={error} />
      </div>
    </Modal>
  );
}

/** Approval on the load test page (§9.4), styled like RunAuthorisationPanel. */
export function LoadApprovalPanel({ run, onDone, canApproveRole, pages }: { run: LoadRun; onDone: () => void; canApproveRole: boolean; pages: number }) {
  const toast = useToast();
  const th = useTypedHost(run.target_host);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | "withdraw" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const hintId = useId();
  const p = useProject();
  const a = run.approval;
  if (!a) return null;
  const blocked = !!run.problem;
  const canDecide = run.permissions.can_approve;

  async function decide(decision: "approve" | "reject") {
    if (decision === "approve" && !th.ok) {
      th.setError(th.typed.trim() ? `Type ${run.target_host} exactly to approve.` : th.reason);
      return;
    }
    if (decision === "reject" && !comment.trim()) {
      setCommentError("Say why this load test shouldn't run.");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await api(`/approvals/${a!.id}/decision`, { method: "POST", body: { decision, comment: comment.trim() || undefined, confirm_text: decision === "approve" ? th.typed : undefined } });
      toast(decision === "approve" ? `${run.key} approved and starting.` : `${run.key} not approved.`, "success");
      onDone();
      if (decision === "approve") requestAnimationFrame(() => document.querySelector<HTMLElement>("h1[data-page-title]")?.focus());
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && decision === "approve") th.setError(e.message);
      else if (e instanceof ApiError && e.status === 422) setCommentError(e.message);
      else setError(e);
      onDone();
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    setBusy("withdraw");
    try {
      const r = await api<{ message: string }>(`/performance-runs/${run.id}/withdraw`, { method: "POST" });
      toast(r.message, "success");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const requester = run.requested_by?.full_name ?? "someone";
  return (
    <section aria-labelledby="approval-title" className="rounded-xl bg-surface ring-1 ring-warning-line">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id="approval-title" className="text-h3 font-semibold text-fg-strong">
          Approve load test {run.key} · {a.key}
        </h2>
        <span className="text-small font-medium text-warning-fg">{canApproveRole ? "Waiting for your approval" : "Waiting for approval by someone who can approve"}</span>
      </div>
      <div className="space-y-4 px-5 py-4">
        <p className="text-small text-fg-muted">
          Requested by {requester} · {fmtDateTime(run.created_at)} · expires {fmtDateTime(a.expires_at)}
          {run.note ? ` · "${run.note}"` : ""}
        </p>
        <p className="text-body text-fg-strong">{run.summary}</p>
        <p className="text-small text-fg-muted">About {run.expected_requests_text} requests.</p>
        {run.limits && <LimitsTable {...run.limits} />}
        <WhatItDoes items={run.what_it_does} pages={pages} />
        {blocked && (
          <Callout tone="warning" title="This request can't be approved as it was made">
            {`${run.problem}. Request it again.`}
            {run.permissions.can_request_again && (
              <Link href={`/projects/${p.id}/non-functional/profiles/${run.profile.key}?request=1`} className="mt-2 block font-medium text-navy-700 underline underline-offset-2">
                Request again…
              </Link>
            )}
          </Callout>
        )}
        {canDecide && (
          <div className="space-y-3">
            <div className="max-w-md">
              <TextField
                label={`Type ${run.target_host} to approve`}
                value={th.typed}
                onChange={(e) => {
                  th.setTyped(e.target.value);
                  th.setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                error={th.error}
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
                Approve and start load test
              </Button>
              <Button variant="secondary" onClick={() => decide("reject")} loading={busy === "reject"}>
                Don&apos;t approve…
              </Button>
            </div>
          </div>
        )}
        {!canDecide && !blocked && canApproveRole === false && run.permissions.can_withdraw === false && run.permissions.can_request_again && (
          <p className="text-small text-fg-muted">{MEMBER_APPROVE_NOTE}</p>
        )}
        {run.permissions.can_withdraw && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={withdraw} loading={busy === "withdraw"}>
              Withdraw request
            </Button>
            {!canApproveRole && <p className="text-small text-fg-muted">{MEMBER_APPROVE_NOTE}</p>}
          </div>
        )}
        <InlineError error={error} />
      </div>
    </section>
  );
}
