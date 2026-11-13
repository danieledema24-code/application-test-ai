"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AgentEvent, ScanDetail } from "@/lib/contract";
import { elapsed } from "@/lib/discovery";
import { fmtDateTime } from "@/lib/format";
import { hostOf, pathOf } from "@/lib/url";
import { Button, Callout, Card, StatTile } from "@/components/ui";
import { LiveConnectionIndicator } from "@/components/domain/AgentActivityFeed";
import { useProject } from "@/components/workspace/ProjectContext";

type Frame = { url: string; title: string; path: string; viewport: string | null; at: string };

/** Latest screenshot announced on the stream (page.discovered / evidence.captured carry a signed URL). */
function latestFrame(events: AgentEvent[]): Frame | null {
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const shot = d.screenshot as { content_url?: string; viewport?: string } | undefined;
    if (shot?.content_url) {
      const url = typeof d.url === "string" ? d.url : "";
      return {
        url: shot.content_url,
        title: typeof d.title === "string" ? d.title : pathOf(url),
        path: pathOf(url),
        viewport: typeof shot.viewport === "string" ? shot.viewport : typeof d.viewport === "string" ? d.viewport : null,
        at: e.created_at,
      };
    }
  }
  return null;
}

/**
 * Live view of a running scan (design spec §8.1): latest captured screenshot (not video), counters
 * from the scan record, and a progress bar in the info tone. Counters are not a live region.
 */
export function LiveDiscovery({ scan }: { scan: ScanDetail }) {
  const p = useProject();
  const frame = useMemo(() => latestFrame(p.events), [p.events]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const host = hostOf(scan.start_url);
  const max = scan.limits?.max_pages ?? 0;
  const done = scan.stats.pages;
  const interactive = scan.stats.buttons + scan.stats.links + scan.stats.inputs + scan.stats.search + scan.stats.filters + scan.stats.modals + scan.stats.tables;
  const gaps = scan.access_gaps.length || scan.stats.access_gaps || 0;
  // The workflow stage is the source of truth for run state: it updates as soon as Pause/Resume
  // return, while the scan record and the event feed can lag (or be unavailable).
  const stage = p.discovery?.status;
  const paused = stage ? stage === "paused" || p.workflow?.project_status === "paused" : scan.status === "paused";
  const queued = !paused && (stage ? stage === "queued" : scan.status === "queued");
  const current = scan.current;

  return (
    <div className="space-y-4">
      {paused && (
        <Callout
          tone="warning"
          title="Discovery is paused."
          actions={
            <Button onClick={() => void p.resume()} loading={p.resuming}>
              Resume analysis
            </Button>
          }
        >
          {done} page{done === 1 ? "" : "s"} visited so far.
        </Callout>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 text-h3 font-semibold text-fg-strong">
            {!paused && !queued && <Loader2 className="h-4 w-4 animate-spin text-info-fg motion-reduce:hidden" aria-hidden />}
            {queued ? "Waiting to start" : paused ? `Paused on ${host}` : `Exploring ${host}`}
          </h2>
          <div className="flex items-center gap-2">
            <LiveConnectionIndicator state={p.streamState} onReconnect={p.reconnect} />
            {!paused && !queued && (
              <Button size="sm" variant="secondary" onClick={() => void p.pause()} loading={p.pausing}>
                {p.pausing ? "Pausing…" : "Pause"}
              </Button>
            )}
          </div>
        </div>
        {p.pausing && (
          <p className="border-b border-line bg-warning-bg px-5 py-2 text-small text-fg-strong" role="status">
            Pausing after the current page…
          </p>
        )}
        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_280px]">
          <figure className="overflow-hidden rounded-lg border border-line bg-elevated">
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived screenshot URL from the API
              <img src={frame.url} alt={`Screenshot of ${frame.title} (${frame.path})${frame.viewport ? `, ${frame.viewport}` : ""}`} className="aspect-[16/10] w-full bg-white object-contain object-top" />
            ) : (
              <div className="flex aspect-[16/10] items-center justify-center px-6 text-center text-body text-fg-muted">
                {queued ? "Waiting for a browser worker…" : "Launching an isolated browser…"}
              </div>
            )}
          </figure>
          <div className="min-w-0 space-y-2">
            <p className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Now visiting</p>
            {current ? (
              <>
                <p className="break-words text-h3 font-semibold text-fg-strong">{current.title || pathOf(current.url)}</p>
                <p className="break-all font-mono text-small text-fg">{pathOf(current.url)}</p>
              </>
            ) : (
              <p className="text-body text-fg-muted">{queued ? "Not started yet." : "Between pages."}</p>
            )}
            {frame && (
              <p className="text-small text-fg-muted">
                {frame.viewport ? `${frame.viewport} · ` : ""}captured <time dateTime={frame.at}>{fmtDateTime(frame.at)}</time>
              </p>
            )}
          </div>
        </div>
        <div className="space-y-4 border-t border-line p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile size="sm" label="Pages visited" value={max ? `${done} / ${max}` : done} />
            <StatTile size="sm" label="Pages found" value={scan.pages_found} />
            <StatTile size="sm" label="Forms" value={scan.stats.forms} />
            <StatTile size="sm" label="Interactive elements" value={interactive} />
            <StatTile size="sm" label="Access gaps" value={gaps} />
            <StatTile size="sm" label="Elapsed" value={elapsed(scan.started_at, null, now)} />
          </div>
          {max > 0 && (
            <div>
              <div
                role="progressbar"
                aria-label="Discovery progress"
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={Math.min(done, max)}
                aria-valuetext={`${done} of up to ${max} pages`}
                className="h-2 overflow-hidden rounded-full bg-info-bg ring-1 ring-inset ring-info-line"
              >
                <div className="h-full rounded-full bg-info-solid transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.min(100, (done / max) * 100)}%` }} />
              </div>
              <p className="mt-1 text-small tabular-nums text-fg-muted">
                {done} of up to {max} pages
              </p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
