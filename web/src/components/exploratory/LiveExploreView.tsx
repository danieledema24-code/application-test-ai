"use client";

// Live session (design P6 §9.5; pattern of the P5 LiveLoadView): four tiles, the last step and the step log, updated
// at least every 2 s (SSE `exploration.step` refreshes the data; polling is the fallback). [Pause updates] freezes the
// screen, not the session (WCAG 2.2.2); under reduced motion it starts paused and refreshes every 5 s. Tiles and the
// log are not live regions (the page's polite region announces milestones only). The log never scrolls by itself when
// the person has scrolled up: [Jump to latest step] appears instead.

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/useMotion";
import { budgetPct, findingsText, lastStepLines, liveLine, PAUSE_TIP, stepAction, type Session, type Step } from "@/lib/exploratory";
import { Button, StatTile } from "@/components/ui";
import { StepOutcomeLabel } from "./Labels";

/** The step log (§9.5, §9.6): a table at md+, cards below; a "Problem found" row links its finding. */
export function StepLog({ steps, onFinding, label = "Step log" }: { steps: Step[]; onFinding?: (key: string) => void; label?: string }) {
  if (!steps.length) return <p className="text-body text-fg-muted">Waiting for the first step…</p>;
  const findingLinks = (s: Step) =>
    onFinding && s.findings.length > 0 ? (
      <span className="mt-1 block text-small">
        {s.findings.map((k, i) => (
          <span key={k}>
            {i > 0 && ", "}
            <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => onFinding(k)}>
              Open {k}
            </button>
          </span>
        ))}
      </span>
    ) : null;
  return (
    <>
      <table className="hidden min-w-full divide-y divide-line text-small md:table" aria-label={label}>
        <thead className="bg-elevated">
          <tr>
            {["#", "Page", "Action", "Outcome", "Chosen by"].map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line bg-surface">
          {steps.map((s) => (
            <tr key={s.n}>
              <th scope="row" className="px-3 py-2 text-left font-medium tabular-nums text-fg-strong">
                {s.n}
              </th>
              <td className="break-all px-3 py-2 font-mono text-xs text-fg">{s.page}</td>
              <td className="px-3 py-2 text-fg [overflow-wrap:anywhere]">{stepAction(s)}</td>
              <td className="px-3 py-2">
                <StepOutcomeLabel step={s} />
                {findingLinks(s)}
              </td>
              <td className="px-3 py-2 text-fg">{s.chosen_by === "ai" ? "AI" : "Rules"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ol className="space-y-2 md:hidden" aria-label={label}>
        {steps.map((s) => (
          <li key={s.n} className="rounded-md bg-surface p-3 text-small ring-1 ring-line [overflow-wrap:anywhere]">
            <span className="font-medium tabular-nums text-fg-strong">{s.n}</span> · <span className="break-all font-mono text-xs">{s.page}</span> · {stepAction(s)} · <StepOutcomeLabel step={s} />
            {findingLinks(s)}
          </li>
        ))}
      </ol>
    </>
  );
}

export function LiveExploreView({ session, steps, focusRef }: { session: Session; steps: Step[]; focusRef: React.MutableRefObject<boolean> }) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState<boolean | null>(null);
  const isPaused = paused ?? reduced;
  const [shown, setShown] = useState({ session, steps });
  const latest = useRef({ session, steps });
  latest.current = { session, steps };
  // Paused: the screen keeps its last values. Reduced motion starts paused and refreshes every 5 s until resumed.
  useEffect(() => {
    if (!isPaused) setShown({ session, steps });
  }, [session, steps, isPaused]);
  useEffect(() => {
    if (!reduced || paused !== null) return;
    const t = setInterval(() => setShown(latest.current), 5000);
    return () => clearInterval(t);
  }, [reduced, paused]);

  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  const n = shown.steps.length;
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [n]);
  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom.current) setBehind(false);
  };
  const jump = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setBehind(false);
    el.focus();
  };

  const s = shown.session;
  const p = s.progress;
  const last = lastStepLines(p.last_step);
  return (
    <section
      aria-labelledby="live-title"
      className="space-y-4 rounded-xl bg-surface p-5 ring-1 ring-line-strong"
      onFocus={() => (focusRef.current = true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusRef.current = false;
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="live-title" className="text-h3 font-semibold text-fg-strong">
          Live progress
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setPaused(!isPaused)} title={PAUSE_TIP}>
          {isPaused ? "Resume updates" : "Pause updates"}
        </Button>
      </div>
      <p className="text-body text-fg" data-testid="explore-live-line">
        {liveLine(s)}
      </p>
      <div aria-hidden className="h-2 w-full overflow-hidden rounded-full bg-overlay">
        <div className="h-full bg-info-solid" style={{ width: `${budgetPct(p)}%` }} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile size="sm" label="Now on" value={<span className="break-all font-mono text-body">{p.current_page ?? "—"}</span>} />
        <StatTile size="sm" label="Findings so far" value={findingsText(p)} />
        <StatTile size="sm" label="Blocked write attempts" value={String(p.blocked)} />
        <StatTile size="sm" label="Not tried" value={String(p.not_tried)} />
      </div>
      <div className="text-body">
        <h3 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Last step</h3>
        {last ? (
          <>
            <p className="text-fg-strong [overflow-wrap:anywhere]">{last[0]}</p>
            {last[1] && <p className="text-small text-fg [overflow-wrap:anywhere]">{last[1]}</p>}
          </>
        ) : (
          <p className="text-fg-muted">Waiting for the first step…</p>
        )}
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Step log (newest at the bottom)</h3>
          {behind && (
            <Button variant="secondary" size="sm" onClick={jump}>
              Jump to latest step
            </Button>
          )}
        </div>
        <div ref={logRef} onScroll={onScroll} tabIndex={0} role="region" aria-label="Step log, newest at the bottom" className="scrollbar-thin max-h-96 overflow-y-auto rounded-md ring-1 ring-line">
          <StepLog steps={shown.steps} />
        </div>
      </div>
      <p className="text-small text-fg-muted">
        Updated at least every 2 seconds · steps chosen by rules{isPaused ? " · updates paused" : ""}
      </p>
    </section>
  );
}
