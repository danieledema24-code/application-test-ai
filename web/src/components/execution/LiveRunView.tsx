"use client";

// Live view of the test browser (design P4 §8.4): one tile per worker, frames from short-lived signed URLs about
// five times a second. Pausable (WCAG 2.2.2); starts paused under reduced motion (one frame every 5 s). Polling stops
// when the tab is hidden, when paused, and when the run ends (`GET /live` answers 404).

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui";

type Slot = { slot: string; title: string; state: string | null; frame_url: string | null; at: string | null };

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export function LiveRunView({ runId, chromium }: { runId: string; chromium: boolean }) {
  const reduced = useReducedMotion();
  const visible = useVisible();
  const [paused, setPaused] = useState<boolean | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [ended, setEnded] = useState(false);
  const [tick, setTick] = useState(0);
  const isPaused = paused ?? reduced;

  // Slot list and fresh signed URLs every 2 s (every 5 s when paused under reduced motion).
  useEffect(() => {
    if (!chromium || ended || !visible || (isPaused && !reduced)) return;
    let live = true;
    const load = () =>
      api<{ slots: Slot[] }>(`/execution-runs/${runId}/live`)
        .then((d) => live && setSlots(d.slots))
        .catch((e) => {
          if (live && e instanceof ApiError && e.status === 404) setEnded(true);
        });
    void load();
    const t = setInterval(load, isPaused ? 5000 : 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [runId, chromium, ended, visible, isPaused, reduced]);

  // Frame refresh: ~5 fps while playing; reduced motion + paused still shows the latest frame every 5 s.
  useEffect(() => {
    if (!chromium || ended || !visible) return;
    if (isPaused && !reduced) return;
    const t = setInterval(() => setTick((n) => n + 1), isPaused ? 5000 : 200);
    return () => clearInterval(t);
  }, [chromium, ended, visible, isPaused, reduced]);

  if (ended) return null;
  return (
    <section aria-labelledby="live-title" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id="live-title" className="text-h3 font-semibold text-fg-strong">
          Live view of the test browser
        </h2>
        {chromium && (
          <Button variant="secondary" size="sm" onClick={() => setPaused(!isPaused)}>
            {isPaused ? (reduced ? "Play live view" : "Resume live view") : "Pause live view"}
          </Button>
        )}
      </div>
      <div className="p-4">
        {!chromium ? (
          <p className="text-body text-fg-muted">Live view is available for Chromium only. Results appear below as each test finishes.</p>
        ) : slots.length === 0 ? (
          <p className="text-body text-fg-muted">Waiting for the browser…</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {slots.map((s, i) => (
              <figure key={s.slot} className="overflow-hidden rounded-lg bg-[#101828] ring-1 ring-line">
                {s.frame_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${s.frame_url}${isPaused && !reduced ? "" : `&t=${tick}`}`}
                    alt={`Live view of the test browser, worker ${i + 1}: ${s.title || "starting"}`}
                    className="aspect-[16/10] w-full bg-white object-contain object-top"
                  />
                ) : (
                  <div className="flex aspect-[16/10] items-center justify-center text-body text-white">Waiting for the browser…</div>
                )}
                <figcaption className="bg-surface px-3 py-2 text-small text-fg">{s.title || "Waiting for the next test"}</figcaption>
              </figure>
            ))}
          </div>
        )}
        <p className="mt-3 text-small text-fg-muted">Frames aren&apos;t saved. Failed tests keep a video recording.</p>
      </div>
    </section>
  );
}
