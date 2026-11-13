"use client";

import Link from "next/link";
import { Circle, CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleX, Diamond, Loader2, MessageSquareWarning, RefreshCw, UserRoundCheck } from "lucide-react";
import type { ProjectSummary, Workflow } from "@/lib/contract";
import { GATE_1, LIFECYCLE, STATUS_LABEL, buildLifecycle, gateReview, stageStatusText, upstreamGateHint, type LifecycleStage, type LifecycleStatus } from "@/lib/lifecycle";
import { fmtDateTime } from "@/lib/format";
import { Button, Disclosure, Tooltip } from "@/components/ui";

const STATUS_TONE: Record<LifecycleStatus, string> = {
  done: "text-success-fg",
  running: "text-info-fg",
  waiting: "text-warning-fg",
  changes_requested: "text-warning-fg",
  paused: "text-warning-fg",
  out_of_date: "text-warning-fg",
  failed: "text-danger-fg",
  cancelled: "text-fg-muted",
  not_started: "text-fg-muted",
  later: "text-fg-muted",
};

const MINI_BAR: Record<LifecycleStatus, string> = {
  done: "bg-navy-800",
  running: "bg-info-solid",
  waiting: "bg-warning-solid",
  changes_requested: "bg-warning-solid",
  paused: "bg-warning-solid",
  out_of_date: "bg-warning-solid",
  failed: "bg-danger-solid",
  cancelled: "bg-line-strong",
  not_started: "bg-line-strong",
  later: "bg-line",
};

/** Icon for a lifecycle status. Running spins, with a static icon under reduced motion (§2.3). */
export function StageStatusIcon({ status, className = "h-4 w-4" }: { status: LifecycleStatus; className?: string }) {
  const tone = STATUS_TONE[status];
  switch (status) {
    case "done":
      return <CircleCheck className={`${className} ${tone}`} aria-hidden />;
    case "running":
      return (
        <>
          <Loader2 className={`${className} ${tone} animate-spin motion-reduce:hidden`} aria-hidden />
          <CircleDot className={`${className} ${tone} hidden motion-reduce:inline`} aria-hidden />
        </>
      );
    case "waiting":
      return <UserRoundCheck className={`${className} ${tone}`} aria-hidden />;
    case "paused":
      return <CirclePause className={`${className} ${tone}`} aria-hidden />;
    case "changes_requested":
      return <MessageSquareWarning className={`${className} ${tone}`} aria-hidden />;
    case "out_of_date":
      return <RefreshCw className={`${className} ${tone}`} aria-hidden />;
    case "failed":
      return <CircleX className={`${className} ${tone}`} aria-hidden />;
    case "cancelled":
      return <CircleSlash className={`${className} ${tone}`} aria-hidden />;
    case "later":
      return <CircleDashed className={`${className} ${tone}`} aria-hidden />;
    default:
      return <Circle className={`${className} ${tone}`} aria-hidden />;
  }
}

function stageHref(projectId: string, s: LifecycleStage) {
  return `/projects/${projectId}/${s.section}`;
}

function a11yStage(s: LifecycleStage) {
  return `${s.label}: ${stageStatusText(s).toLowerCase()}`;
}

function gateText(s: LifecycleStage) {
  if (!s.gate) return "";
  const st = s.gateStatus === "done" ? "approved" : s.gateStatus === "waiting" ? (gateReview(s.gateStage) === "recommended" ? "ready for your review" : "waiting for your approval") : s.status === "later" ? s.phaseLabel.toLowerCase() : "not reached";
  return `Gate ${s.gate.key.slice(1)}, ${s.gate.name}: ${st}`;
}

function GateDiamond({ s }: { s: LifecycleStage }) {
  if (!s.gate) return null;
  const tone = s.gateStatus === "done" ? "fill-navy-800 text-navy-800" : s.gateStatus === "waiting" ? "fill-warning-solid text-warning-fg" : "text-line-strong fill-surface";
  return (
    <span className="relative inline-flex">
      <Diamond className={`h-3.5 w-3.5 ${tone}`} aria-hidden />
      <span className="sr-only">{gateText(s)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------

export function LifecycleProgress({
  workflow,
  projectId,
  variant,
  onRerun,
  onReviewGate,
}: {
  workflow: Workflow | null | undefined;
  projectId: string;
  variant: "full" | "compact";
  /** Re-run a stage: Discovery opens the re-scan dialog; Requirements/Strategy open their regenerate dialog. */
  onRerun?: (stageId: string) => void;
  onReviewGate?: (stageId: string) => void;
}) {
  const stages = buildLifecycle(workflow);
  if (variant === "compact") return <Compact stages={stages} projectId={projectId} />;
  return <Full stages={stages} projectId={projectId} onRerun={onRerun} onReviewGate={onReviewGate} />;
}

function Compact({ stages, projectId }: { stages: LifecycleStage[]; projectId: string }) {
  return (
    <ol aria-label="QA lifecycle" className="grid grid-cols-8 gap-1">
      {stages.map((s) => {
        const current = s.status === "running" || s.status === "waiting" || s.status === "paused" || s.status === "changes_requested";
        return (
          <li key={s.id} className="min-w-0">
            <Tooltip content={`${s.label}: ${stageStatusText(s)}`} className="w-full">
              <Link
                href={stageHref(projectId, s)}
                aria-current={current ? "step" : undefined}
                aria-label={`${a11yStage(s)}${s.gate && s.gateStatus === "waiting" ? `. ${gateText(s)}` : ""}`}
                className={`flex w-full min-w-0 items-center justify-center gap-1.5 rounded-sm border-b-[3px] px-1 py-1.5 text-caption font-medium hover:bg-overlay xl:justify-start ${
                  s.status === "done" ? "border-navy-800" : current ? "border-info-solid" : s.status === "failed" ? "border-danger-solid" : "border-line-strong"
                } ${s.status === "later" ? "text-fg-muted" : "text-fg-strong"}`}
              >
                <StageStatusIcon status={s.status} className="h-4 w-4 shrink-0" />
                <span className="hidden truncate xl:inline">{s.label}</span>
              </Link>
            </Tooltip>
          </li>
        );
      })}
    </ol>
  );
}

function stepStatus(stage: LifecycleStage, n: number): LifecycleStatus {
  if (stage.status === "later") return "later";
  if (stage.status === "done" || stage.status === "waiting" || stage.status === "changes_requested" || stage.status === "out_of_date") return "done";
  const idx = n - stage.steps[0].n + 1;
  const cur = stage.currentStep;
  if (stage.status === "running" && cur) return idx < cur ? "done" : idx === cur ? "running" : "not_started";
  if (stage.status === "paused") return idx < (cur ?? 4) ? "done" : idx === (cur ?? 4) ? "paused" : "not_started";
  if (stage.status === "failed" || stage.status === "cancelled") {
    // Without per-step data we can only say the stage stopped; mark steps 1–2 (project created) done for Discovery.
    return stage.id === "discovery" && idx <= 2 ? "done" : idx === 3 ? stage.status : "not_started";
  }
  return stage.id === "discovery" && idx <= 2 && stage.stages.some((x) => x.key === "intake" && (x.status === "completed" || x.status === "approved"))
    ? "done"
    : "not_started";
}

function Full({
  stages,
  projectId,
  onRerun,
  onReviewGate,
}: {
  stages: LifecycleStage[];
  projectId: string;
  onRerun?: (stageId: string) => void;
  onReviewGate?: (stageId: string) => void;
}) {
  return (
    <div>
      {/* md+: horizontal rail. Below md: vertical list (no horizontal scroll). */}
      <ol aria-label="QA lifecycle" className="flex flex-col gap-2 md:flex-row md:gap-0">
        {stages.map((s, i) => {
          const current = s.status === "running" || s.status === "waiting" || s.status === "paused";
          const next = stages[i + 1];
          return (
            <li key={s.id} className="flex min-w-0 items-start gap-3 md:flex-1 md:flex-col md:gap-2">
              <div className="flex items-center md:w-full">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-2 ${
                    s.status === "done" ? "bg-success-bg ring-success-line" : current ? "bg-info-bg ring-info-line" : s.status === "failed" ? "bg-danger-bg ring-danger-line" : "bg-surface ring-line-strong"
                  }`}
                >
                  <StageStatusIcon status={s.status} className="h-4.5 w-4.5" />
                </span>
                {next && (
                  <span aria-hidden={!s.gate} className="hidden flex-1 items-center md:flex">
                    <span className={`h-0.5 flex-1 ${s.status === "done" ? "bg-navy-800" : "bg-line-strong"}`} />
                    {s.gate && s.gate.position === "after" && <GateDiamond s={s} />}
                    {next.gate && next.gate.position === "before" && <GateDiamond s={next} />}
                    <span className={`h-0.5 flex-1 ${s.status === "done" ? "bg-navy-800" : "bg-line-strong"}`} />
                  </span>
                )}
              </div>
              <Link
                href={stageHref(projectId, s)}
                aria-current={current ? "step" : undefined}
                className="min-w-0 rounded-sm pr-2 hover:underline"
              >
                <span className={`block text-small font-semibold ${s.status === "later" ? "text-fg-muted" : "text-fg-strong"}`}>{s.label}</span>
                <span className={`block text-caption ${STATUS_TONE[s.status]}`}>{stageStatusText(s)}</span>
                {upstreamGateHint(s, stages) && <span className="block text-caption text-fg-muted">{upstreamGateHint(s, stages)}</span>}
                <span className="sr-only">{s.gate && s.gateStatus === "waiting" ? `. ${gateText(s)}` : ""}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <Disclosure label="Show all 21 steps" openLabel="Hide steps" className="mt-4 border-t border-line pt-3">
        <AllSteps stages={stages} onRerun={onRerun} onReviewGate={onReviewGate} />
      </Disclosure>
    </div>
  );
}

function AllSteps({ stages, onRerun, onReviewGate }: { stages: LifecycleStage[]; onRerun?: (stageId: string) => void; onReviewGate?: (stageId: string) => void }) {
  return (
    <div className="mt-3 space-y-5">
      {stages.map((s) => {
        const run = s.stages.find((x) => x.key === "discovery") ?? s.stages[0];
        const finished = ["done", "failed", "cancelled", "waiting", "changes_requested", "out_of_date"].includes(s.status);
        const canRerun = (s.id === "discovery" || s.id === "requirements" || s.id === "strategy") && finished && s.stages.some((x) => x.current_version);
        return (
          <section key={s.id} aria-labelledby={`stage-${s.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-1.5">
              <h3 id={`stage-${s.id}`} className="flex items-center gap-2 text-h3 font-semibold text-fg-strong">
                <StageStatusIcon status={s.status} />
                {s.label}
                <span className={`text-small font-normal ${STATUS_TONE[s.status]}`}>· {stageStatusText(s)}</span>
              </h3>
              <div className="flex items-center gap-2">
                {run?.started_at && (
                  <span className="text-caption tabular-nums text-fg-muted">
                    Started {fmtDateTime(run.started_at)}
                    {run.finished_at ? ` · finished ${fmtDateTime(run.finished_at)}` : ""}
                  </span>
                )}
                {s.gateStatus === "waiting" && onReviewGate && (
                  <Button size="sm" variant="secondary" onClick={() => onReviewGate(s.id)}>
                    {s.gate ? `Review Gate ${s.gate.key.slice(1)}` : "Review gate"}
                  </Button>
                )}
                {canRerun && onRerun && (
                  <Button size="sm" variant="secondary" onClick={() => onRerun(s.id)}>
                    Re-run stage
                  </Button>
                )}
              </div>
            </div>
            <ol className="mt-1.5 space-y-1">
              {s.gate?.position === "before" && <GateRow s={s} />}
              {s.steps.map((step) => {
                const st = stepStatus(s, step.n);
                return (
                  <li key={step.n}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-small">
                      <span className="w-6 text-right tabular-nums text-fg-muted">{step.n}</span>
                      <StageStatusIcon status={st} />
                      <span className="min-w-0 flex-1 text-fg-strong">{step.name}</span>
                      <span className={STATUS_TONE[st]}>{st === "later" ? s.phaseLabel : STATUS_LABEL[st]}</span>
                      <span className="w-full pl-9 text-caption text-fg-muted sm:w-56 sm:pl-0">{step.agent}</span>
                    </div>
                    {s.id === "discovery" && step.n === GATE_1.afterStep && <Gate1Row />}
                  </li>
                );
              })}
              {s.gate?.position === "after" && <GateRow s={s} />}
            </ol>
            {s.status === "failed" && run?.stale_reason && <p className="mt-1 pl-9 text-small text-danger-fg">{run.stale_reason}</p>}
          </section>
        );
      })}
    </div>
  );
}

function Gate1Row() {
  return (
    <div className="flex items-center gap-3 py-1 pl-9 text-small">
      <Diamond className="h-3.5 w-3.5 fill-navy-800 text-navy-800" aria-hidden />
      <span className="text-fg-strong">Gate 1 · Authorisation</span>
      <span className="text-success-fg">Approved when the project was created</span>
    </div>
  );
}

function GateRow({ s }: { s: LifecycleStage }) {
  if (!s.gate) return null;
  const st = s.gateStatus === "done" ? "Approved" : s.gateStatus === "waiting" ? (gateReview(s.gateStage) === "recommended" ? "Ready for your review" : "Waiting for your approval") : s.status === "later" ? s.phaseLabel : "Not reached";
  return (
    <li className="flex items-center gap-3 py-1 pl-9 text-small">
      <Diamond className={`h-3.5 w-3.5 ${s.gateStatus === "done" ? "fill-navy-800 text-navy-800" : s.gateStatus === "waiting" ? "fill-warning-solid text-warning-fg" : "text-line-strong"}`} aria-hidden />
      <span className="text-fg-strong">
        Gate {s.gate.key.slice(1)} · {s.gate.name}
      </span>
      <span className={s.gateStatus === "waiting" ? "text-warning-fg" : s.gateStatus === "done" ? "text-success-fg" : "text-fg-muted"}>{st}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------

/** Mini variant from a ProjectSummary (dashboard/project lists): 8 bars (aria-hidden) + text label. */
export function LifecycleMini({ project }: { project: Pick<ProjectSummary, "current_stage" | "current_stage_status" | "awaiting_approval"> }) {
  const idx = Math.max(0, LIFECYCLE.findIndex((d) => (project.current_stage ? d.apiStages.includes(project.current_stage) : false)));
  const st: LifecycleStatus = project.awaiting_approval
    ? "waiting"
    : project.current_stage_status === "running" || project.current_stage_status === "queued"
      ? "running"
      : project.current_stage_status === "paused"
        ? "paused"
        : project.current_stage_status === "failed"
          ? "failed"
          : project.current_stage_status === "cancelled"
            ? "cancelled"
            : project.current_stage_status === "completed" || project.current_stage_status === "approved"
              ? "done"
              : "not_started";
  const label = st === "running" ? `${LIFECYCLE[idx].label} running` : st === "waiting" ? `${LIFECYCLE[idx].label}: waiting for approval` : `${LIFECYCLE[idx].label}: ${STATUS_LABEL[st].toLowerCase()}`;
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="flex gap-0.5">
        {LIFECYCLE.map((d, i) => (
          <span key={d.id} className={`h-1 w-3 rounded-full ${i < idx ? MINI_BAR.done : i === idx ? MINI_BAR[st] : MINI_BAR.later}`} />
        ))}
      </span>
      <span className="text-small text-fg">{label}</span>
    </span>
  );
}
