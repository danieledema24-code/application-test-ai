"use client";

import { Radio } from "lucide-react";
import { fileUrl } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Card, CardBody, CardHeader, StatusPill } from "@/components/ui";

export type LiveSlot = { slot: number; title?: string; state?: string; at?: number; hasFrame: boolean };
type LiveState = { status: string; live: boolean; slots: LiveSlot[] };

const STATE_STATUS: Record<string, string> = { running: "RUNNING", passed: "PASSED", failed: "FAILED" };

/** Polls which browser slots of a run (automated run or site scan) have live frames. Pass `active=false` to stop. */
export function useLiveSlots(runId: string | null, active = true) {
  return useApi<LiveState>(runId && active ? `/test-runs/${runId}/live` : null, undefined, { refreshInterval: (d) => (!d || d.live ? 1500 : 0) });
}

/** One browser's live MJPEG stream, or a placeholder until its first frame exists. Not interactive. */
export function LiveFrame({ runId, slot, alt, placeholder = "Waiting for the first frame…", children }: {
  runId: string;
  slot: LiveSlot | undefined;
  alt: string;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-black">
      {slot?.hasFrame ? (
        // eslint-disable-next-line @next/next/no-img-element -- MJPEG stream, not an optimisable image
        <img src={fileUrl(`/test-runs/${runId}/live/${slot.slot}`)} alt={alt} className="aspect-[1366/860] w-full object-contain" />
      ) : (
        <div className="flex aspect-[1366/860] items-center justify-center text-sm text-fg-muted">{placeholder}</div>
      )}
      {children && <figcaption className="flex items-center justify-between gap-3 border-t border-line bg-surface px-3 py-2">{children}</figcaption>}
    </figure>
  );
}

/** Live browser view of an automated run: one MJPEG stream per Playwright worker. */
export function LiveView({ runId }: { runId: string }) {
  const { data } = useLiveSlots(runId);
  if (!data?.live) return null;
  return (
    <Card className="mt-4">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Radio className="h-4 w-4 animate-pulse text-red-400" aria-hidden /> Live view
          </span>
        }
        description="What each browser is showing right now. Full recordings appear under each result when the run finishes."
      />
      <CardBody>
        {data.slots.length === 0 ? (
          <p className="text-sm text-fg-muted" role="status">
            Starting the browser…
          </p>
        ) : (
          <div className={`grid gap-4 ${data.slots.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {data.slots.map((s) => (
              <LiveFrame key={s.slot} runId={runId} slot={s} alt={`Live browser for ${s.title ?? `worker ${s.slot + 1}`}`}>
                <span className="truncate text-xs text-fg">
                  <span className="text-fg-muted">Worker {s.slot + 1}:</span> {s.title ?? "—"}
                </span>
                {s.state && <StatusPill status={STATE_STATUS[s.state] ?? "RUNNING"} />}
              </LiveFrame>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
