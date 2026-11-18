"use client";

// Test Execution › Exploratory (design P6 §9.1): the sessions with their status, findings and budget, the organisation
// limits line and [Explore…]. One session at a time per project: while one runs, [Explore…] is aria-disabled with the
// reason. Viewers see the table only. `?tab=exploratory&new=1` opens the start dialog.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { useOnline } from "@/lib/useOnline";
import { claimRouteFocus } from "@/lib/focusReturn";
import {
  budgetUsedText,
  findingsText,
  G2_FIRST_EXPLORE,
  NO_BROWSER,
  OFFLINE_EXPLORE,
  SHORT_STATEMENT,
  whatExploredText,
  type Session,
  type SessionList,
} from "@/lib/exploratory";
import { Button, Callout, EmptyState, ErrorState, LinkButton, Skeleton, Table, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { useProject } from "@/components/workspace/ProjectContext";
import { SessionStatusPill } from "./Labels";
import { ExploreDialog } from "./ExploreDialog";
import { useSessions } from "./hooks";

const RETURN_KEY = (projectId: string) => `qa:exp-return:${projectId}`;
function remember(projectId: string, key: string) {
  try {
    sessionStorage.setItem(RETURN_KEY(projectId), JSON.stringify({ key, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

function whoText(s: Session): string {
  const by = s.requested_by?.full_name ?? "—";
  const ok = s.approved_by?.full_name ?? "—";
  return `${by} · ${ok}`;
}

/** The [Explore…] button: aria-disabled with its reason when a session runs or waits for approval, offline, before G2 or without Chromium. */
export function ExploreButton({ list, onOpen }: { list: SessionList; onOpen: () => void }) {
  const online = useOnline();
  const id = useId();
  const reason = !online ? OFFLINE_EXPLORE : !list.gate.ok ? G2_FIRST_EXPLORE : !list.browser_available ? NO_BROWSER : list.running ? (list.running_line ?? `${list.running} is running. One session at a time per project.`) : list.waiting[0] ? `${list.waiting[0]} is waiting for approval. One session at a time.` : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={() => !reason && onOpen()} aria-disabled={reason ? true : undefined} aria-describedby={reason ? id : undefined}>
        Explore…
      </Button>
      {reason && (
        <p id={id} className="max-w-xs text-right text-small text-fg-muted">
          {reason}
        </p>
      )}
    </div>
  );
}

export function ExploratoryTab() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const viewer = role === "viewer" || role === null;
  const q = useSessions(p.id);
  const d = q.data;
  const canStart = !!d?.permissions.can_start && !viewer;
  // Not closed when a session starts meanwhile: the dialog shows the 409 with a link to it.
  const open = params.get("new") === "1" && canStart && !!d?.options;
  const setOpen = (v: boolean) => router.push(`/projects/${p.id}/execution?tab=exploratory${v ? "&new=1" : ""}`, { scroll: false });
  const restored = useRef(false);

  // Coming back from a session focuses the row link it was opened from (design P6 §16.2).
  useEffect(() => {
    if (!d || restored.current) return;
    restored.current = true;
    try {
      const raw = sessionStorage.getItem(RETURN_KEY(p.id));
      const v = raw ? (JSON.parse(raw) as { key: string; at: number }) : null;
      sessionStorage.removeItem(RETURN_KEY(p.id));
      if (!v || Date.now() - v.at > 60_000) return;
      const el = document.querySelector<HTMLElement>(`[data-exp-link="${v.key}"]:not([hidden])`) ?? document.querySelector<HTMLElement>(`[data-exp-link="${v.key}"]`);
      if (!el) return;
      claimRouteFocus(window.location.pathname);
      requestAnimationFrame(() => el.focus());
    } catch {
      /* storage unavailable */
    }
  }, [d, p.id]);

  function started(s: Session & { message?: string }, approved: boolean) {
    toast(approved ? `${s.key} approved and starting.` : (s.message ?? `${s.key} started.`), "success");
    void q.mutate();
    p.refresh();
    router.push(`/projects/${p.id}/execution/exploratory/${s.key}`);
  }

  const heading = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 className="text-h2 font-semibold text-fg-strong">Exploratory testing</h2>
      {d && canStart && d.gate.ok && <ExploreButton list={d} onOpen={() => setOpen(true)} />}
    </div>
  );

  if (q.error && !d)
    return (
      <div className="space-y-4">
        {heading}
        <ErrorState error={q.error} title="Couldn’t load exploratory sessions." message="Try again." onRetry={() => void q.mutate()} />
      </div>
    );
  if (!d)
    return (
      <div className="space-y-4" aria-busy="true">
        {heading}
        <Skeleton className="h-40" />
      </div>
    );

  const waiting = d.items.filter((s) => s.status === "awaiting_approval");
  const canApprove = d.permissions.can_approve && !viewer;
  const link = (s: Session, extra = "") => (
    <Link
      href={`/projects/${p.id}/execution/exploratory/${s.key}`}
      onClick={() => remember(p.id, s.key)}
      data-exp-link={s.key}
      className={`font-mono font-medium text-navy-700 underline underline-offset-2 ${extra}`}
      aria-label={`Open ${s.key}`}
    >
      {s.key}
    </Link>
  );
  return (
    <div className="space-y-5">
      {heading}
      {!d.browser_available && <Callout tone="danger">{NO_BROWSER}</Callout>}
      {waiting.length > 0 && (
        <Callout
          tone="warning"
          title={
            waiting.length === 1
              ? `${waiting[0].key} is waiting for ${canApprove ? "your approval" : "approval by someone who can approve"}`
              : `${waiting.length} exploratory sessions are waiting for approval`
          }
          actions={!viewer ? <LinkButton href={`/projects/${p.id}/execution/exploratory/${waiting[0].key}`}>{canApprove ? `Review ${waiting[0].key}` : `Open ${waiting[0].key}`}</LinkButton> : undefined}
        >
          Signed-in exploration starts only after someone who can approve types the host and approves. Nothing is sent to the site before that.
        </Callout>
      )}
      {!d.gate.ok ? (
        <EmptyState title={d.gate.message ?? G2_FIRST_EXPLORE} action={viewer ? undefined : <LinkButton href={`/projects/${p.id}/discovery?view=summary#gate-review`}>Review Gate 2</LinkButton>} />
      ) : d.items.length === 0 ? (
        <EmptyState
          title="No exploratory session yet."
          description={SHORT_STATEMENT}
          action={canStart ? <ExploreButton list={d} onOpen={() => setOpen(true)} /> : undefined}
        />
      ) : (
        <>
          <div className="hidden md:block">
            <Table label="Exploratory sessions">
              <THead>
                <tr>
                  <Th>Session</Th>
                  <Th>What was explored</Th>
                  <Th>Status</Th>
                  <Th>Findings</Th>
                  <Th>Budget used</Th>
                  <Th>Started · approved by</Th>
                  <Th>When</Th>
                </tr>
              </THead>
              <TBody>
                {d.items.map((s) => (
                  <Tr key={s.id}>
                    <Td rowHeader>{link(s)}</Td>
                    <Td>
                      {whatExploredText(s)}
                      {s.signed_in && <span className="block text-small text-fg-muted">Signed in</span>}
                    </Td>
                    <Td>
                      <SessionStatusPill session={s} />
                    </Td>
                    <Td>{findingsText(s.progress)}</Td>
                    <Td>{budgetUsedText(s)}</Td>
                    <Td>{whoText(s)}</Td>
                    <Td>{fmtDateTime(s.started_at ?? s.created_at)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="space-y-3 md:hidden" aria-label="Exploratory sessions">
            {d.items.map((s) => (
              <li key={s.id} className="space-y-1 rounded-lg bg-surface p-4 ring-1 ring-line">
                <p className="flex flex-wrap items-center gap-2">
                  {link(s)}
                  <SessionStatusPill session={s} />
                </p>
                <p className="text-body text-fg [overflow-wrap:anywhere]">{whatExploredText(s)}</p>
                <p className="text-small text-fg">
                  Findings: {findingsText(s.progress)} · {budgetUsedText(s)}
                </p>
                <p className="text-small text-fg-muted">
                  {whoText(s)} · {fmtDateTime(s.started_at ?? s.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-small text-fg-muted">{d.limits.line}</p>
      {canStart && d.options && <ExploreDialog open={open} onClose={() => setOpen(false)} projectId={p.id} list={d} onStarted={started} onConflict={() => void q.mutate()} />}
    </div>
  );
}

