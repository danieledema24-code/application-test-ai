"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bot, ExternalLink, MoreHorizontal } from "lucide-react";
import { fmtDate } from "@/lib/format";
import { activeStage, gateReview, stageStatusLabel, waitingGateStage, waitingLabel } from "@/lib/lifecycle";
import { useAuth } from "@/lib/auth";
import { ApiError, downloadFile } from "@/lib/api";
import { exportFileName, exportPath } from "@/lib/automation";
import { g2EverApproved } from "@/lib/change";
import { hostOf } from "@/lib/url";
import { Button, StatusPill, useToast } from "@/components/ui";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { useExecSummary } from "@/components/execution/hooks";
import type { ExecSummary } from "@/lib/execution";
import { nfHeaderPill, nfReachable, type Overview } from "@/lib/nonfunctional";
import { useNfOverview } from "@/components/nonfunctional/Summary";
import { headerPill, type ReleaseSummary } from "@/lib/release";
import { releaseReachable, useReleaseOverview } from "@/components/release/hooks";
import { exploreHeaderPill, exploreReachable, type SessionList } from "@/lib/exploratory";
import { useSessions } from "@/components/exploratory/hooks";
import { useProject } from "./ProjectContext";

/** The project's overall status, from the live workflow. */
function overallStatus(p: ReturnType<typeof useProject>, canApprove: boolean, x: ExecSummary | null, nf: Overview | undefined, release: ReleaseSummary | null, sessions: SessionList | undefined) {
  const wf = p.workflow;
  if (!wf) return null;
  if (wf.project_status === "archived") return { status: "archived", label: "Archived" };
  const waiting = waitingGateStage(wf);
  if (waiting) return { status: "awaiting_approval", label: gateReview(waiting) === "required" ? waitingLabel(canApprove) : "Ready for your review" };
  // Test runs and defect drafts (design P4 §4.3).
  if (x?.running) return { status: "running", label: `Test run ${x.running} running` };
  if (x?.waiting.length)
    return { status: "awaiting_approval", label: `${x.waiting[0]} waiting for ${canApprove ? "your authorisation" : "authorisation by someone who can approve gates"}` };
  // Load tests and checks (design P5 §4.4): after run states, before defect drafts.
  const nfPill = nfHeaderPill(nf, canApprove);
  if (nfPill) return { status: nfPill.tone === "blue" ? "running" : "awaiting_approval", label: nfPill.text };
  // Exploratory sessions (design P6 §4.4): "Exploring: EXP-0001" or "EXP-0002 waiting for your approval".
  const expPill = exploreHeaderPill(sessions, canApprove);
  if (expPill) return { status: expPill.tone === "blue" ? "running" : "awaiting_approval", label: expPill.text };
  // Release readiness waiting for Gate 9 (design P6 §4.4): after the load-test states.
  const rel = headerPill(release, canApprove);
  if (rel) return { status: "awaiting_approval", label: rel };
  if (x?.drafts) return { status: "awaiting_approval", label: `${x.drafts} defect draft${x.drafts === 1 ? "" : "s"} to review` };
  const active = activeStage(wf);
  if (wf.project_status === "paused" || active?.status === "paused") return { status: "paused", label: "Discovery paused" };
  if (active) {
    const name = active.key === "discovery_report" ? "Report" : active.key === "discovery" ? "Discovery" : active.title;
    return { status: active.status, label: `${name} ${stageStatusLabel(active.status).toLowerCase()}` };
  }
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
  const router = useRouter();
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
  const active = activeStage(p.workflow);
  const running = !!active;
  const { role } = useAuth();
  const g2 = g2EverApproved(p.workflow);
  const hasBaseline = g2 === true;
  const scripted = !!p.workflow?.stages.find((x) => x.key === "automation")?.current_version;
  const nfOn = nfReachable(p.workflow) && role !== "viewer" && role !== null;
  const nfGo = (tab: string) => (setOpen(false), router.push(`/projects/${p.id}/non-functional?tab=${tab}`));
  // "Assess release readiness" once a test run finished (design P6 §4.4).
  const release = useReleaseOverview(p.id, releaseReachable(p.workflow));
  const canAssess = !!release.data?.available && role !== "viewer" && role !== null;
  // "Explore pages…" after Gate 2 (design P6 §4.4).
  const canExplore = exploreReachable(p.workflow) && role !== "viewer" && role !== null;
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
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), router.push(`/projects/${p.id}/settings`))}>
            Project settings
          </button>
          {/* After G2 only "Rescan and compare…" is offered, never the whole-chain re-scan (design P6 §4.4, OQ1). */}
          {g2 !== null && (!hasBaseline || (role !== "viewer" && role !== null)) && (
            <button role="menuitem" type="button" className={item} disabled={running} onClick={() => (setOpen(false), p.openRescan())}>
              {hasBaseline ? "Rescan and compare…" : "Re-scan site"}
              {running ? " (after the current scan)" : ""}
            </button>
          )}
          {scripted && role !== "viewer" && role !== null && (
            <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), router.push(`/projects/${p.id}/execution?new=1`))}>
              Run tests…
            </button>
          )}
          {canExplore && (
            <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), router.push(`/projects/${p.id}/execution?tab=exploratory&new=1`))}>
              Explore pages…
            </button>
          )}
          {canAssess && (
            <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), router.push(`/projects/${p.id}/release-readiness`))}>
              Assess release readiness
            </button>
          )}
          {nfOn && (
            <>
              <button role="menuitem" type="button" className={item} onClick={() => nfGo("accessibility")}>
                Check accessibility…
              </button>
              <button role="menuitem" type="button" className={item} onClick={() => nfGo("security")}>
                Check security
              </button>
              <button role="menuitem" type="button" className={item} onClick={() => nfGo("performance")}>
                Plan a load test
              </button>
            </>
          )}
          {scripted && role !== "viewer" && role !== null && (
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                const v = p.workflow?.stages.find((x) => x.key === "automation")?.current_version ?? 1;
                void downloadFile(exportPath(p.id, v, true), exportFileName(hostOf(p.project?.primary_url) || "site", v)).catch((e: unknown) =>
                  toast(e instanceof ApiError ? e.message : "Couldn’t download the project. Try again.", "error"),
                );
              }}
            >
              Download Playwright project
            </button>
          )}
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), assistant.open())}>
            Ask AI QA Analyst
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
  const assistant = useAssistantDrawer();
  const project = p.project;
  const { canApprove, role } = useAuth();
  const exec = useExecSummary(p.id, p.workflow);
  const nf = useNfOverview(p.id, p.workflow);
  const release = useReleaseOverview(p.id, releaseReachable(p.workflow));
  const sessions = useSessions(p.id, exploreReachable(p.workflow));
  const st = overallStatus(p, canApprove && role !== "viewer", exec, nf.overview, release.data?.latest ?? null, sessions.data);
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
          {st && <StatusPill status={st.status} label={st.label} wrap />}
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
        {/* Secondary entry point to the assistant (design P2 §11.6); below md it lives in the ⋯ menu. */}
        <Button variant="secondary" aria-label="Ask AI QA Analyst" onClick={() => assistant.open()} className="hidden px-2.5 md:inline-flex xl:px-4">
          <Bot className="h-5 w-5" aria-hidden />
          <span className="hidden xl:inline">Ask AI QA Analyst</span>
        </Button>
        <MoreMenu />
      </div>
    </div>
  );
}
