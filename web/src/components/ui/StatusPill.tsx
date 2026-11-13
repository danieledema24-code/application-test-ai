import { Circle, CircleCheck, CircleDashed, CircleDot, CircleHelp, CirclePause, CircleSlash, CircleX, Loader2, Lock, MessageSquareWarning, RefreshCw, UserRoundCheck, type LucideIcon } from "lucide-react";
import { humanize } from "@/lib/format";

export type Tone = "green" | "red" | "amber" | "blue" | "grey" | "violet";

// Single source of truth for status colours (design spec §2.1). Colour is never the only signal:
// every pill carries an icon or dot plus its text.
const TONES: Record<string, Tone> = {
  // lifecycle / stage / scan statuses (QA Analyst API)
  DONE: "green",
  COMPLETED: "green",
  APPROVED: "green",
  READY: "green",
  ACTIVE: "blue",
  RUNNING: "blue",
  QUEUED: "blue",
  LIVE: "blue",
  RENDERING: "blue",
  AWAITING_APPROVAL: "amber",
  WAITING: "amber",
  PAUSED: "amber",
  PARTIAL: "amber",
  CHANGES_REQUESTED: "amber",
  STALE: "amber",
  DRAFT: "amber",
  // Phase 2 (design P2 §2)
  NEEDS_INFO: "amber",
  REJECTED: "grey",
  OUT_OF_DATE: "amber",
  LOCKED: "grey",
  EXTRACTING: "blue",
  UPLOADING: "blue",
  PENDING: "amber",
  ACCEPTED: "green",
  MITIGATED: "green",
  WITHDRAWN: "grey",
  FAILED: "red",
  ERROR: "red",
  BLOCKED: "red",
  CANCELLED: "grey",
  NOT_STARTED: "grey",
  LATER: "grey",
  ARCHIVED: "grey",
  // legacy screens (kept until P1-16)
  PASSED: "green",
  NOT_EXECUTED: "grey",
  IN_PROGRESS: "blue",
  DEPRECATED: "grey",
  OPEN: "red",
  REOPENED: "red",
  FIXED: "green",
  RETEST_REQUIRED: "amber",
  CLOSED: "grey",
  CRITICAL: "red",
  HIGH: "red",
  MEDIUM: "amber",
  LOW: "grey",
  NEEDS_CONFIRMATION: "amber",
  CONNECTED: "green",
  DISCONNECTED: "grey",
  AUTH_FAILED: "red",
  UNREACHABLE: "amber",
  BLOCKED_TARGET: "red",
  INACTIVE: "grey",
  PRODUCTION: "red",
  STAGING: "amber",
  DEVELOPMENT: "blue",
};

/** Exported for components that build their own chips (lifecycle, gate checklist). */
export const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-success-bg text-success-fg ring-success-line",
  red: "bg-danger-bg text-danger-fg ring-danger-line",
  amber: "bg-warning-bg text-warning-fg ring-warning-line",
  blue: "bg-info-bg text-info-fg ring-info-line",
  grey: "bg-overlay text-fg-muted ring-line-strong",
  violet: "bg-inferred-bg text-inferred-fg ring-inferred-fg/40",
};

export const TONE_TEXT: Record<Tone, string> = {
  green: "text-success-fg",
  red: "text-danger-fg",
  amber: "text-warning-fg",
  blue: "text-info-fg",
  grey: "text-fg-muted",
  violet: "text-inferred-fg",
};

const DOT: Record<Tone, string> = {
  green: "bg-success-solid",
  red: "bg-danger-solid",
  amber: "bg-warning-solid",
  blue: "bg-info-solid",
  grey: "bg-fg-subtle",
  violet: "bg-inferred-fg",
};

/** Icons per normalised status (design spec §7.1 status vocabulary). */
const ICONS: Record<string, LucideIcon> = {
  DONE: CircleCheck,
  COMPLETED: CircleCheck,
  APPROVED: CircleCheck,
  READY: CircleCheck,
  RUNNING: Loader2,
  QUEUED: CircleDot,
  RENDERING: Loader2,
  AWAITING_APPROVAL: UserRoundCheck,
  WAITING: UserRoundCheck,
  PAUSED: CirclePause,
  FAILED: CircleX,
  ERROR: CircleX,
  CANCELLED: CircleSlash,
  NOT_STARTED: Circle,
  LATER: CircleDashed,
  DRAFT: Circle,
  NEEDS_INFO: CircleHelp,
  REJECTED: CircleSlash,
  OUT_OF_DATE: RefreshCw,
  STALE: RefreshCw,
  LOCKED: Lock,
  EXTRACTING: Loader2,
  UPLOADING: Loader2,
  CHANGES_REQUESTED: MessageSquareWarning,
};

function norm(status: string): string {
  return status.toUpperCase().replace(/[\s-]+/g, "_");
}

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return "grey";
  const key = norm(status);
  return TONES[key] || TONES[key.split(/[_(]/)[0]] || "grey";
}

/** Hex colours for legacy charts, aligned with the pill tones. */
export const STATUS_HEX = {
  passed: "#079455",
  failed: "#D92D20",
  blocked: "#DC6803",
  other: "#667085",
};

export function StatusPill({
  status,
  label,
  tone,
  dot = true,
  className = "",
}: {
  status: string | null | undefined;
  label?: string;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  const t = tone || statusTone(status);
  const key = status ? norm(status) : "";
  const Icon = ICONS[key];
  const spinning = key === "RUNNING" || key === "RENDERING" || key === "EXTRACTING" || key === "UPLOADING";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-medium ring-1 ring-inset ${TONE_CLASSES[t]} ${className}`}
    >
      {Icon ? (
        <>
          <Icon className={`h-3.5 w-3.5 ${spinning ? "animate-spin motion-reduce:hidden" : ""}`} aria-hidden />
          {spinning && <CircleDot className="hidden h-3.5 w-3.5 motion-reduce:inline" aria-hidden />}
        </>
      ) : (
        dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[t]}`} />
      )}
      {label ?? (status ? humanize(status) : "None")}
    </span>
  );
}

export function Badge({
  children,
  tone = "grey",
  className = "",
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium ring-1 ring-inset ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
