// Phase 5 vocabulary (design P5 §3): severities, check results, finding and run statuses, threshold results, the
// "Heuristic" pill and the fixed honesty statements. Status is always text + icon, never colour alone.

import {
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleSlash,
  CircleX,
  Equal,
  History,
  Info,
  Lightbulb,
  OctagonAlert,
  ShieldCheck,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import { Badge, Callout, StatusPill, TONE_CLASSES, Tooltip } from "@/components/ui";
import {
  A11Y_SEVERITY,
  CHECK_RESULT,
  FINDING_STATUS,
  RUN_TONE,
  SCAN_TONE,
  SEC_SEVERITY,
  THRESHOLD_RESULT,
  runStatusLabel,
  type A11ySeverity,
  type CheckResult,
  type FindingStatus,
  type LoadRun,
  type Scan,
  type SecSeverity,
  type ThresholdResult as TR,
} from "@/lib/nonfunctional";

const A11Y_ICON: Record<A11ySeverity, LucideIcon> = { critical: ChevronsUp, serious: ChevronUp, moderate: Equal, minor: ChevronDown };
const SEC_ICON: Record<SecSeverity, LucideIcon> = { high: ChevronUp, medium: Equal, low: ChevronDown, info: Info };

export function Severity({ severity }: { severity: string }) {
  if (severity in A11Y_SEVERITY) {
    const s = A11Y_SEVERITY[severity as A11ySeverity];
    const Icon = A11Y_ICON[severity as A11ySeverity];
    const cls = s.solid ? "bg-danger-solid text-white ring-danger-solid" : TONE_CLASSES[s.tone];
    return (
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium ring-1 ring-inset ${cls}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {s.label}
      </span>
    );
  }
  const s = SEC_SEVERITY[severity as SecSeverity] ?? { label: severity, tone: "grey" as const };
  const Icon = SEC_ICON[severity as SecSeverity] ?? Info;
  return (
    <Badge tone={s.tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

const RESULT_ICON: Record<CheckResult, LucideIcon> = { failed: CircleX, passed: CircleCheck, not_applicable: CircleSlash, not_checked: CircleDashed };
export function CheckResultLabel({ result }: { result: CheckResult }) {
  const r = CHECK_RESULT[result];
  const Icon = RESULT_ICON[result];
  return (
    <Badge tone={r.tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {r.label}
    </Badge>
  );
}

const FINDING_ICON: Record<FindingStatus, LucideIcon> = { open: CircleDot, accepted_risk: ShieldCheck, false_positive: CircleSlash, fixed: CircleCheck };
export function FindingStatusLabel({ status }: { status: FindingStatus }) {
  const f = FINDING_STATUS[status];
  const Icon = FINDING_ICON[status];
  return (
    <Badge tone={f.tone}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {f.label}
    </Badge>
  );
}

export function SeenBefore({ keyText, reopened }: { keyText: string; reopened?: boolean }) {
  return (
    <Badge tone="grey">
      <History className="h-3.5 w-3.5" aria-hidden />
      {reopened ? "Seen before · reopened" : `Seen before (${keyText})`}
    </Badge>
  );
}

export function NeedsReview() {
  return (
    <Badge tone="grey">
      <CircleHelp className="h-3.5 w-3.5" aria-hidden />
      Needs review
    </Badge>
  );
}

/** "Heuristic" pill (§3.5): same shape as the Hypothesis label. */
export function HeuristicLabel() {
  return (
    <Tooltip content="Worked out by a rule of thumb. A person should check it.">
      <span tabIndex={0} className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-dashed border-inferred-line bg-inferred-bg px-1.5 py-0.5 text-caption font-medium text-inferred-fg">
        <Lightbulb className="h-3.5 w-3.5" aria-hidden />
        Heuristic
        <span className="sr-only">: worked out by a rule of thumb. A person should check it.</span>
      </span>
    </Tooltip>
  );
}

/** A fixed statement (§3.6), first content after the heading; not dismissible. */
export function HonestyNote({ children }: { children: React.ReactNode }) {
  return (
    <Callout tone="info" className="honesty-note">
      {children}
    </Callout>
  );
}

export function ScanStatusPill({ scan }: { scan: Pick<Scan, "status" | "status_label"> }) {
  return <StatusPill status={scan.status === "completed" ? "completed" : scan.status} label={scan.status_label} tone={SCAN_TONE[scan.status]} />;
}

export function LoadRunStatusPill({ run }: { run: Pick<LoadRun, "status" | "status_label" | "threshold_results" | "stopped_by"> }) {
  const label = runStatusLabel(run);
  if (run.status === "aborted")
    return (
      <Badge tone="amber" className="rounded-full px-2">
        <OctagonAlert className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Badge>
    );
  if (run.status === "awaiting_approval")
    return (
      <Badge tone="amber" className="rounded-full px-2">
        <UserRoundCheck className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Badge>
    );
  const status = run.status === "passed" ? "completed" : run.status === "stopped" ? "cancelled" : run.status === "expired" ? "expired" : run.status;
  return <StatusPill status={status} label={label} tone={RUN_TONE[run.status]} />;
}

const TR_ICON = { met: CircleCheck, missed: CircleX, not_measured: CircleDashed };
export function ThresholdResultLabel({ result }: { result: TR["result"] }) {
  const r = THRESHOLD_RESULT[result];
  const Icon = TR_ICON[result];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-medium ${result === "met" ? "text-success-fg" : result === "missed" ? "text-danger-fg" : "text-fg-muted"}`}>
      <Icon className="h-4 w-4" aria-hidden />
      {r.label}
      {result === "not_measured" && <span className="sr-only">: the load test stopped early, so this wasn&apos;t judged</span>}
    </span>
  );
}
