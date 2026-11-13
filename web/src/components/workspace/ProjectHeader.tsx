"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { fmtDate } from "@/lib/format";
import { activeStage, gateReview, stageStatusLabel, waitingGateStage } from "@/lib/lifecycle";
import { Button, StatusPill, useToast } from "@/components/ui";
import { useProject } from "./ProjectContext";

/** The project's overall status, from the live workflow. */
function overallStatus(p: ReturnType<typeof useProject>) {
  const wf = p.workflow;
  if (!wf) return null;
  if (wf.project_status === "archived") return { status: "archived", label: "Archived" };
  const waiting = waitingGateStage(wf);
  if (waiting) return { status: "awaiting_approval", label: gateReview(waiting) === "required" ? "Waiting for your approval" : "Ready for your review" };
  const active = activeStage(wf);
  if (wf.project_status === "paused" || active?.status === "paused") return { status: "paused", label: "Discovery paused" };
  if (active) return { status: active.status, label: `${active.key === "discovery_report" ? "Report" : "Discovery"} ${stageStatusLabel(active.status).toLowerCase()}` };
  const failed = wf.stages.find((s) => s.status === "failed");
  if (failed) return { status: "failed", label: `${failed.title} failed` };
  const disc = p.discovery;
  if (disc?.status === "cancelled") return { status: "cancelled", label: "Discovery cancelled" };
  if (disc && (disc.status === "approved" || disc.status === "completed")) return { status: disc.status, label: disc.status === "approved" ? "Discovery approved" : "Discovery done" };
  return { status: "not_started", label: "Not started" };
}

function MoreMenu() {
  const p = useProject();
  const toast = useToast();
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
  const active = activeStage(p.workflow);
  const running = !!active;
  const item = "flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay disabled:text-fg-muted";
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" aria-label="More project actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="px-2.5">
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-60 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          {running && (
            <button role="menuitem" type="button" className={`${item} text-danger-fg`} onClick={() => (setOpen(false), p.openCancel())}>
              Cancel analysis
            </button>
          )}
          <button role="menuitem" type="button" className={item} disabled={running} onClick={() => (setOpen(false), p.openRescan())}>
            Re-scan site{running ? " (after the current scan)" : ""}
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              void navigator.clipboard
                .writeText(`${window.location.origin}/projects/${p.id}`)
                .then(() => toast("Project link copied."))
                .catch(() => toast("Couldn’t copy the link.", "error"));
            }}
          >
            Copy project link
          </button>
        </div>
      )}
    </div>
  );
}

/** Project header shown on every project section (design spec §3.3). */
export function ProjectHeader({ asHeading }: { asHeading: boolean }) {
  const p = useProject();
  const project = p.project;
  const st = overallStatus(p);
  const active = activeStage(p.workflow);
  const paused = p.workflow?.project_status === "paused" || active?.status === "paused";
  const runningNow = active && (active.status === "running" || active.status === "queued") && !paused;
  const scanN = p.discovery?.current_version;
  const Title = asHeading ? "h1" : "p";
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <Title tabIndex={asHeading ? -1 : undefined} className={`truncate font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none ${asHeading ? "text-h1" : "text-h2"}`}>
            {project?.name ?? "Loading project…"}
          </Title>
          {st && <StatusPill status={st.status} label={st.label} />}
        </div>
        {project && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-muted">
            <a href={project.primary_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-navy-700 underline underline-offset-2 hover:text-navy-900">
              {project.primary_url}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">(opens in new tab)</span>
            </a>
            <span aria-hidden>·</span>
            <span>Created {fmtDate(project.created_at)}</span>
            {scanN ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">Scan {scanN}</span>
              </>
            ) : null}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {paused ? (
          <Button onClick={() => void p.resume()} loading={p.resuming}>
            {p.resuming ? "Resuming…" : "Resume analysis"}
          </Button>
        ) : runningNow || p.pausing ? (
          <Button variant="secondary" onClick={() => void p.pause()} loading={p.pausing}>
            {p.pausing ? "Pausing…" : "Pause analysis"}
          </Button>
        ) : null}
        <MoreMenu />
      </div>
    </div>
  );
}
