"use client";

// Exploratory session page (design P6 §9.3–9.7): approval while waiting, the live view with Stop now while exploring,
// and the results when it ends. Data refreshes at least every 2 s while active (SSE events refresh it sooner, see
// ProjectContext; polling is the fallback). The polite region announces milestones only: start, each new finding,
// 25/50/75 % of the action budget and the end. `?view=` picks the results view, `&finding=` opens the drawer.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { liveMilestone, type Finding } from "@/lib/nonfunctional";
import {
  budgetPct,
  CONNECTION_LOST,
  endAnnouncement,
  findingAnnouncement,
  isActiveSession,
  isFinishedSession,
  NOTHING_SENT,
  sessionPoll,
  STILL_STOPPING,
  type Session,
  type Step,
} from "@/lib/exploratory";
import { Button, Callout, ConfirmDialog, ErrorState, LinkButton, Skeleton, useToast } from "@/components/ui";
import { HonestyNote } from "@/components/domain/NonFunctionalLabels";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { useProject } from "@/components/workspace/ProjectContext";
import { SessionStatusPill } from "./Labels";
import { ExploreApprovalPanel } from "./ExploreApprovalPanel";
import { LiveExploreView } from "./LiveExploreView";
import { ExploreFindingDrawer, SessionResults, type ResultsView } from "./SessionResults";

function SessionMenu({ projectId, sessionKey }: { projectId: string; sessionKey: string }) {
  const toast = useToast();
  const assistant = useAssistantDrawer();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const item = "flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay";
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" aria-label={`More actions for ${sessionKey}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="px-2.5">
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-72 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), assistant.open())}>
            Ask the analyst about {sessionKey}
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              void navigator.clipboard
                .writeText(`${window.location.origin}/projects/${projectId}/execution/exploratory/${sessionKey}`)
                .then(() => toast("Session link copied."))
                .catch(() => toast("Couldn’t copy the link.", "error"));
            }}
          >
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}

/** "New and changed pages from CHG-0001 · 3 pages · budget 60 actions, 10 min · not signed in · rules (AI off)". */
function scopeLine(s: Session): string {
  return `${s.charter.label ?? "Pages"} · ${s.pages} page${s.pages === 1 ? "" : "s"} · budget ${s.budget.actions} actions, ${s.budget.minutes} min · ${s.signed_in ? "signed in" : "not signed in"} · ${s.chosen_by === "ai" ? "AI-guided" : "rules (AI off)"}`;
}

export function SessionPage({ expKey }: { expKey: string }) {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { canApprove, role } = useAuth();
  const viewer = role === "viewer" || role === null;
  const q = useApi<Session>(`/projects/${p.id}/quality-scans/by-key/${expKey}`, undefined, { refreshInterval: sessionPoll, dedupingInterval: 500 });
  const s = q.data;
  const ran = !!s && (isActiveSession(s) || isFinishedSession(s));
  const active = isActiveSession(s);
  const stepsQ = useApi<{ items: Step[] }>(s && ran ? `/quality-scans/${s.id}/steps` : null, undefined, { refreshInterval: active ? 2000 : 0, dedupingInterval: 500 });
  const findingsQ = useApi<{ items: Finding[] }>(s && ran ? `/quality-scans/${s.id}/findings` : null, undefined, { refreshInterval: active ? 2000 : 0, dedupingInterval: 500 });
  const steps = stepsQ.data?.items;
  const findings = useMemo(() => findingsQ.data?.items, [findingsQ.data]);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [slow, setSlow] = useState(false);
  const [lost, setLost] = useState(false);
  const [polite, setPolite] = useState("");
  const focusInLive = useRef(false);
  const prev = useRef<{ status: string | null; pct: number; findings: Set<string> | null }>({ status: null, pct: 0, findings: null });
  const view = (params.get("view") as ResultsView | null) ?? "findings";
  const findingKey = params.get("finding");

  useEffect(() => {
    document.title = `${expKey} · Exploratory session · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [expKey, p.project?.name]);

  // Milestones only (§9.5): start, each new finding, 25/50/75 % of the action budget, the end. Never per step.
  useEffect(() => {
    if (!s) return;
    const pct = budgetPct(s.progress);
    const was = prev.current.status;
    if (was && was !== s.status) {
      if (s.status === "running") setPolite(`${s.key} started`);
      else if (isFinishedSession(s)) {
        setPolite(endAnnouncement(s));
        setStopping(false);
        setSlow(false);
        void stepsQ.mutate();
        void findingsQ.mutate();
        // Focus was in the live block that is now replaced by the results: move it to the results heading (§16.2).
        if (focusInLive.current || document.activeElement === document.body) {
          focusInLive.current = false;
          requestAnimationFrame(() => document.getElementById("results-title")?.focus());
        }
      }
    } else if (s.status === "running") {
      const m = liveMilestone(prev.current.pct, pct);
      if (m) setPolite(`${s.key}: ${m} % of the action budget used`);
    }
    prev.current = { ...prev.current, status: s.status, pct };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  useEffect(() => {
    if (!findings) return;
    const seen = prev.current.findings;
    const keys = new Set(findings.map((f) => f.key));
    if (seen && prev.current.status === "running") {
      const fresh = findings.filter((f) => !seen.has(f.key));
      if (fresh.length) setPolite(fresh.map(findingAnnouncement).join(". "));
    }
    prev.current.findings = keys;
  }, [findings]);

  const go = (qs: Record<string, string | null>) => {
    const u = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(qs)) if (v === null) u.delete(k);
    else u.set(k, v);
    router.replace(`/projects/${p.id}/execution/exploratory/${expKey}${u.toString() ? `?${u}` : ""}`, { scroll: false });
  };

  // Stop now: within 2 s on the server. Offline, it retries every 2 s until the server answers. Once the server has the
  // stop, [Stop now] is aria-disabled with the reason. While reconnecting it stays enabled (§9.5): pressing it again
  // retries at once in the same loop (the pending timer is cleared), and is ignored while a request is in flight.
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPending = useRef(false);
  const sending = useRef(false);
  useEffect(
    () => () => {
      if (retry.current) clearTimeout(retry.current);
      if (slowTimer.current) clearTimeout(slowTimer.current);
    },
    [],
  );
  function stop() {
    setStopOpen(false);
    if (s?.cancel_requested || sending.current) return;
    if (stopPending.current && !retry.current) return;
    stopPending.current = true;
    void sendStop();
  }
  async function sendStop() {
    if (!s) return;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    sending.current = true;
    setStopping(true);
    try {
      const r = await api<{ message: string; scan: Session }>(`/quality-scans/${s.id}/cancel`, { method: "POST" });
      setLost(false);
      toast(r.scan && isFinishedSession(r.scan) ? `${s.key} stopped.` : r.message, "success");
      void q.mutate(r.scan, { revalidate: true });
      if (slowTimer.current) clearTimeout(slowTimer.current);
      slowTimer.current = setTimeout(() => setSlow(true), 5000);
    } catch (e) {
      if (e instanceof ApiError && e.code === "network") {
        setLost(true);
        retry.current = setTimeout(() => void sendStop(), 2000);
        return;
      }
      stopPending.current = false;
      setStopping(false);
      toast(errorMessage(e), "error");
      void q.mutate();
    } finally {
      sending.current = false;
    }
  }

  const back = (
    <Link href={`/projects/${p.id}/execution?tab=exploratory`} className="inline-flex items-center gap-1 text-small font-medium text-fg-muted hover:text-fg-strong">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Exploratory
    </Link>
  );
  if (q.error && !s)
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={q.error} title={q.error instanceof ApiError && q.error.status === 404 ? `We couldn't find ${expKey} in this project.` : "Couldn't load this session."} onRetry={() => q.mutate()} />
      </div>
    );
  if (!s)
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64" />
      </div>
    );

  const a = s.approval;
  const withdrawn = s.status === "rejected" && /withdrawn/i.test(s.status_label);
  const canStop = s.permissions.can_stop && !viewer;
  const stopPendingNow = (stopping && !lost) || s.cancel_requested;
  const requestAgain = s.permissions.can_request_again && !viewer ? (
    <LinkButton href={`/projects/${p.id}/execution?tab=exploratory&new=1`} variant="secondary" size="sm">
      {isFinishedSession(s) ? "Explore again…" : "Request again"}
    </LinkButton>
  ) : null;
  const finding = findingKey ? findings?.find((f) => f.key === findingKey) : undefined;
  return (
    <div className="space-y-5 pb-20 md:pb-0">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 tabIndex={-1} data-page-title className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {s.key} · Exploratory session
          </h1>
          <SessionStatusPill session={s} />
        </div>
        <div className="flex items-center gap-2">
          {canStop && (
            <div
              className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface p-3 md:static md:border-0 md:bg-transparent md:p-0"
              onFocus={() => (focusInLive.current = true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInLive.current = false;
              }}
            >
              <Button
                variant="danger"
                className="w-full md:w-auto"
                onClick={() => !stopPendingNow && setStopOpen(true)}
                aria-disabled={stopPendingNow || undefined}
                aria-describedby={stopPendingNow ? `${s.key}-stop-reason` : undefined}
              >
                {stopPendingNow ? "Stopping…" : "Stop now"}
              </Button>
              {stopPendingNow && (
                <span id={`${s.key}-stop-reason`} className="sr-only">
                  Stop requested. The session stops within 2 seconds.
                </span>
              )}
            </div>
          )}
          <SessionMenu projectId={p.id} sessionKey={s.key} />
        </div>
      </div>
      <div className="space-y-0.5 text-small text-fg-muted [overflow-wrap:anywhere]">
        <p>{scopeLine(s)}</p>
        <p>
          Started by {s.requested_by?.full_name ?? "someone"} · {fmtDateTime(s.started_at ?? s.created_at)}
        </p>
      </div>
      <HonestyNote>{s.statement}</HonestyNote>
      <p role="status" className="sr-only">
        {polite}
      </p>
      {lost && <Callout tone="warning">{CONNECTION_LOST}</Callout>}
      {slow && isActiveSession(s) && <Callout tone="warning">{STILL_STOPPING}</Callout>}
      {a && a.decided_by && (a.status === "approved" || a.status === "used") && (
        <p className="text-small text-fg">
          {a.self_approved ? "Requested and approved" : "Approved"} by {a.decided_by.full_name} · {fmtDateTime(a.decided_at)} · host typed: {a.host_typed ? "yes" : "no"}
        </p>
      )}
      {s.status === "awaiting_approval" && <ExploreApprovalPanel session={s} onDone={() => void q.mutate()} canApproveRole={canApprove && !viewer} />}
      {s.status === "rejected" &&
        (withdrawn ? (
          <Callout tone="neutral" title={`Request withdrawn. ${NOTHING_SENT}`} actions={requestAgain ?? undefined} />
        ) : (
          <Callout tone="neutral" title={`Not approved by ${a?.decided_by?.full_name ?? "someone"}: ‘${a?.comment ?? ""}’. ${NOTHING_SENT}`} actions={requestAgain ?? undefined} />
        ))}
      {s.status === "expired" && <Callout tone="neutral" title={`This request expired after 24 hours. ${NOTHING_SENT}`} actions={requestAgain ?? undefined} />}
      {s.status === "queued" && (
        <Callout tone="info">Waiting to start. Exploration runs one session at a time per project, never beside a load test, and waits for a free browser in your workspace.</Callout>
      )}
      {s.status === "running" && <LiveExploreView session={s} steps={steps ?? []} focusRef={focusInLive} />}
      {s.status === "cancelled" && <Callout tone="neutral" title={s.end_text ?? `Stopped after ${s.progress.actions_used} actions. Steps and findings so far are kept.`} actions={requestAgain ?? undefined} />}
      {s.status === "failed" && <Callout tone="danger" title={s.end_text ?? `Didn't complete. Steps up to ${s.progress.actions_used} are kept.`} actions={requestAgain ?? undefined} />}
      {(s.status === "completed" || s.status === "partial") &&
        (s.end_reason === "unreached" ? (
          <Callout tone="warning" title={s.end_text ?? "Some allowed actions couldn't be reached: see Never reached."} />
        ) : s.end_reason !== "budget" && s.end_text ? (
          <p className="text-body text-fg" data-testid="explore-end">
            {s.end_text}.
          </p>
        ) : null)}
      {isFinishedSession(s) && (
        <SessionResults
          session={s}
          steps={steps}
          findings={findings}
          view={view}
          setView={(v) => go({ view: v === "findings" ? null : v })}
          openFinding={(k) => go({ finding: k })}
          projectId={p.id}
        />
      )}
      {finding && (
        <ExploreFindingDrawer
          finding={finding}
          session={s}
          projectId={p.id}
          canAct={s.permissions.can_triage && !viewer}
          onClose={() => go({ finding: null })}
          onChanged={() => {
            void findingsQ.mutate();
            void q.mutate();
          }}
        />
      )}
      <ConfirmDialog
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        onConfirm={stop}
        danger
        title={`Stop ${s.key} now?`}
        confirmLabel="Stop now"
        cancelLabel="Keep exploring"
        focusConfirm
      >
        <p>It stops within 2 seconds. Steps and findings so far are kept. A stopped session can&apos;t be resumed.</p>
      </ConfirmDialog>
    </div>
  );
}
