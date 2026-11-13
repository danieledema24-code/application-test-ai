"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, CircleSlash, CircleX, UserRoundCheck, WifiOff } from "lucide-react";
import type { AgentEvent, EvidenceLink as EvidenceLinkT, StageKey } from "@/lib/contract";
import type { StreamState } from "@/lib/sse";
import { Button, Card, Checkbox } from "@/components/ui";
import { ObservationLabel } from "./ObservationLabel";
import { EvidenceLinks, type EvidenceItem } from "./EvidenceDrawer";

const PAGE = 200;

const AGENTS: Record<string, { long: string; short: string }> = {
  orchestrator: { long: "Lead QA Orchestrator", short: "Orchestrator" },
  discovery: { long: "Application Discovery Agent", short: "Discovery Agent" },
  reporting: { long: "Reporting Agent", short: "Reporting" },
  requirements: { long: "Requirements Engineering Agent", short: "Requirements Agent" },
  test_strategy: { long: "Test Strategy Agent", short: "Strategy Agent" },
  assistant: { long: "AI QA Analyst", short: "AI QA Analyst" },
};

export function agentName(key: string | null | undefined) {
  return AGENTS[key ?? ""] ?? { long: key ? key.replace(/_/g, " ") : "System", short: key ? key.replace(/_/g, " ") : "System" };
}

type Kind = "status" | "action" | "finding" | "skip" | "warning" | "error" | "gate";

/** Maps the API's event `type`/`level` onto the feed's visual kinds (design §7.3). */
export function eventKind(e: AgentEvent): Kind {
  if (e.level === "error" || e.type === "task.failed" || e.type === "page.failed") return e.type === "page.failed" ? "warning" : "error";
  if (e.type === "gate.awaiting_approval") return "gate";
  if (e.type === "request.blocked" || (e.data && (e.data as Record<string, unknown>).skipped === true)) return "skip";
  if (e.level === "warning" || e.level === "warn") return "warning";
  if (e.type === "page.discovered" || e.type === "evidence.captured") return "finding";
  if (e.type.startsWith("stage.") || e.type.startsWith("task.") || e.type.startsWith("gate.") || e.type === "report.ready") return "status";
  return "action";
}

function evidenceOf(e: AgentEvent): EvidenceItem[] {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const out: EvidenceItem[] = [];
  const shot = d.screenshot as Partial<EvidenceLinkT> | undefined;
  if (shot && typeof shot.id === "string") out.push({ id: shot.id, link: shot.content_url ? ({ mime: "image/png", kind: "screenshot", size: 0, captured_at: e.created_at, ...shot } as EvidenceLinkT) : null });
  if (typeof d.evidence_id === "string") out.push({ id: d.evidence_id });
  if (Array.isArray(d.evidence_ids)) for (const x of d.evidence_ids) if (typeof x === "string") out.push({ id: x });
  if (Array.isArray(d.evidence_refs))
    for (const r of d.evidence_refs as { evidence_id?: string }[]) if (r && typeof r.evidence_id === "string") out.push({ id: r.evidence_id });
  return out.filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
}

function provenanceOf(e: AgentEvent): string | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (typeof d.provenance === "string") return d.provenance;
  if (e.type === "page.discovered" || e.type === "evidence.captured") return "observed";
  return null;
}

function time24(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "error") return <CircleX className="h-4 w-4 text-danger-fg" aria-label="Error" />;
  if (kind === "warning") return <AlertTriangle className="h-4 w-4 text-warning-fg" aria-label="Warning" />;
  if (kind === "skip") return <CircleSlash className="h-4 w-4 text-fg-muted" aria-label="Skipped" />;
  if (kind === "gate") return <UserRoundCheck className="h-4 w-4 text-warning-fg" aria-label="Approval needed" />;
  return <span className="block h-4 w-4" aria-hidden />;
}

const INDICATOR: Record<StreamState, { dot: string; text: string } | null> = {
  connecting: { dot: "bg-fg-subtle", text: "Connecting…" },
  live: { dot: "bg-success-solid animate-pulse motion-reduce:animate-none", text: "Live" },
  reconnecting: { dot: "bg-warning-solid", text: "Reconnecting… Missed events will catch up." },
  offline: { dot: "", text: "You’re offline. The analysis keeps running on our servers." },
  stopped: { dot: "bg-danger-solid", text: "Live updates stopped." },
  idle: null,
};

export function LiveConnectionIndicator({ state, onReconnect }: { state: StreamState; onReconnect: () => void }) {
  const i = INDICATOR[state];
  if (!i) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-small text-fg">
      {state === "offline" ? <WifiOff className="h-4 w-4 text-warning-fg" aria-hidden /> : <span aria-hidden className={`h-2 w-2 rounded-full ${i.dot}`} />}
      <span className={state === "live" ? "font-medium text-success-fg" : ""}>{i.text}</span>
      {state === "stopped" && (
        <Button size="sm" variant="secondary" onClick={onReconnect}>
          Reconnect
        </Button>
      )}
    </span>
  );
}

/**
 * Live agent activity (design spec §7.3). Newest first; when the user has scrolled or focused inside
 * the list, new events don't move content — a "Show {n} new events" button appears instead.
 * The list itself is not a live region; announcements go through the project's status region.
 */
export function AgentActivityFeed({
  events,
  streamState,
  onReconnect,
  running,
  stages,
  announceAll,
  onAnnounceAll,
  reviewHref,
  title = "AI agent activity",
}: {
  events: AgentEvent[];
  streamState: StreamState;
  onReconnect: () => void;
  /** Is an agent working right now (any stage queued/running)? */
  running: boolean;
  /** Only show events from these stages (e.g. the Discovery stage on the Live view). */
  stages?: StageKey[];
  announceAll: boolean;
  onAnnounceAll: (v: boolean) => void;
  reviewHref?: string;
  title?: string;
}) {
  const filtered = useMemo(() => (stages ? events.filter((e) => !e.stage_key || stages.includes(e.stage_key)) : events), [events, stages]);
  const [limit, setLimit] = useState(PAGE);
  const [anchor, setAnchor] = useState<number | null>(null); // newest id shown while frozen
  const listRef = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);

  const visible = useMemo(() => (anchor === null ? filtered : filtered.filter((e) => e.id <= anchor)).slice(0, limit), [filtered, anchor, limit]);
  const pending = anchor === null ? 0 : filtered.filter((e) => e.id > anchor).length;
  const hasMore = (anchor === null ? filtered.length : filtered.length - pending) > limit;

  const freeze = () => {
    if (anchor === null && filtered[0]) setAnchor(filtered[0].id);
  };
  const unfreezeIfIdle = () => {
    const el = listRef.current;
    if (el && el.scrollTop <= 4 && !focusInside.current && anchor !== null && pending === 0) setAnchor(null);
  };
  function showNew() {
    setAnchor(null);
    listRef.current?.scrollTo({ top: 0 });
    listRef.current?.querySelector<HTMLElement>("li")?.focus();
  }
  // If frozen with nothing pending and the user is back at the top, unfreeze on the next event.
  useEffect(() => {
    if (anchor !== null && pending === 0) unfreezeIfIdle();
  });

  const nowEvent = running ? filtered.find((e) => e.type === "log" || e.type === "task.progress" || e.type === "page.discovered" || e.type === "task.started") : undefined;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="text-h3 font-semibold text-fg-strong">{title}</h2>
        <LiveConnectionIndicator state={running || streamState !== "live" ? streamState : "live"} onReconnect={onReconnect} />
      </div>
      <div className="border-b border-line bg-elevated px-5 py-3">
        {nowEvent ? (
          <>
            <p className="flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
              <span aria-hidden className="h-2 w-2 rounded-full bg-info-solid animate-pulse motion-reduce:animate-none" />
              Now · <span className="normal-case tracking-normal">{agentName(nowEvent.agent_key).long}</span>
            </p>
            <p className="mt-0.5 text-h3 font-medium text-fg-strong">{nowEvent.message}</p>
          </>
        ) : (
          <p className="text-body text-fg-muted">No agent is working on this project right now.</p>
        )}
      </div>
      <div className="relative">
        {pending > 0 && (
          <div className="sticky top-0 z-10 flex justify-center py-2">
            <Button size="sm" variant="primary" icon={<ArrowUp className="h-4 w-4" aria-hidden />} onClick={showNew}>
              Show {pending} new event{pending === 1 ? "" : "s"}
            </Button>
          </div>
        )}
        <div
          ref={listRef}
          className="max-h-[32rem] overflow-y-auto"
          onScroll={(e) => {
            if (e.currentTarget.scrollTop > 4) freeze();
            else unfreezeIfIdle();
          }}
          onFocus={() => {
            focusInside.current = true;
            freeze();
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              focusInside.current = false;
              unfreezeIfIdle();
            }
          }}
        >
          {visible.length === 0 ? (
            <p className="px-5 py-8 text-center text-body text-fg-muted">{streamState === "connecting" ? "Loading activity…" : "No activity yet."}</p>
          ) : (
            <ol aria-label="Agent events, newest first" className="divide-y divide-line">
              {visible.map((e) => {
                const kind = eventKind(e);
                const agent = agentName(e.agent_key);
                const ev = evidenceOf(e);
                const prov = provenanceOf(e);
                return (
                  <li
                    key={e.id}
                    tabIndex={-1}
                    className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-5 py-2.5 text-small focus:outline-none focus-visible:outline-2 sm:grid-cols-[4.5rem_auto_1fr] ${
                      kind === "gate" ? "bg-warning-bg" : ""
                    }`}
                  >
                    <time dateTime={e.created_at} className="tabular-nums text-fg-muted">
                      {time24(e.created_at)}
                    </time>
                    <span className="hidden sm:block">
                      <span className="inline-flex rounded-sm bg-overlay px-1.5 py-0.5 text-caption font-medium text-fg-muted ring-1 ring-inset ring-line-strong">
                        <span className="hidden md:inline">{agent.long}</span>
                        <span className="md:hidden">{agent.short}</span>
                      </span>
                    </span>
                    <span className="col-span-2 flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 sm:col-span-1">
                      <KindIcon kind={kind} />
                      <span className="sr-only sm:hidden">{agent.long}: </span>
                      <span className="min-w-0 flex-1 break-words text-fg-strong">{e.message}</span>
                      {prov && <ObservationLabel provenance={prov} />}
                      {ev.length > 0 && <EvidenceLinks items={ev} subject={e.message} />}
                      {kind === "gate" && reviewHref && (
                        <Link href={reviewHref} className="font-medium text-navy-700 underline underline-offset-2">
                          Review
                        </Link>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {hasMore && (
            <div className="border-t border-line px-5 py-3 text-center">
              <Button size="sm" variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>
                Load earlier events
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-line px-5 py-3">
        <Checkbox label="Announce every event" description="Screen readers hear each event as it arrives. Off by default." checked={announceAll} onChange={(e) => onAnnounceAll(e.target.checked)} />
      </div>
    </Card>
  );
}
