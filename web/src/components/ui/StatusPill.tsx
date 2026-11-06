import { humanize } from "@/lib/format";

export type Tone = "green" | "red" | "amber" | "blue" | "grey" | "rose" | "violet";

// Single source of truth for status colours across the app.
const TONES: Record<string, Tone> = {
  // results / runs
  PASSED: "green",
  COMPLETED: "green",
  DONE: "green",
  FAILED: "red",
  ERROR: "red",
  BLOCKED: "amber",
  NOT_EXECUTED: "grey",
  QUEUED: "blue",
  RUNNING: "blue",
  IN_PROGRESS: "blue",
  CANCELLED: "grey",
  // test cases
  DRAFT: "grey",
  APPROVED: "green",
  READY: "blue",
  DEPRECATED: "grey",
  // defects
  OPEN: "red",
  REOPENED: "red",
  FIXED: "green",
  RETEST_REQUIRED: "amber",
  CLOSED: "grey",
  // severity / priority
  CRITICAL: "red",
  HIGH: "rose",
  MEDIUM: "amber",
  LOW: "grey",
  // assistant / misc
  NEEDS_CONFIRMATION: "amber",
  CONNECTED: "green",
  DISCONNECTED: "grey",
  AUTH_FAILED: "red",
  UNREACHABLE: "amber",
  BLOCKED_TARGET: "red",
  ACTIVE: "green",
  INACTIVE: "grey",
  // environments
  PRODUCTION: "red",
  STAGING: "amber",
  DEVELOPMENT: "blue",
};

// Status tones are tinted for the dark theme. Orange is deliberately absent: it is the
// call-to-action colour, so "high" severity uses rose and "running/info" uses sky.
const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  red: "bg-red-500/10 text-red-300 ring-red-500/30",
  amber: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  rose: "bg-pink-500/10 text-pink-300 ring-pink-500/30",
  blue: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  grey: "bg-white/5 text-fg-muted ring-white/10",
  violet: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
};

const DOT: Record<Tone, string> = {
  green: "bg-emerald-400",
  red: "bg-red-400",
  amber: "bg-amber-400",
  rose: "bg-pink-400",
  blue: "bg-sky-400",
  grey: "bg-fg-subtle",
  violet: "bg-violet-400",
};

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return "grey";
  const key = status.toUpperCase();
  return TONES[key] || TONES[key.split(/[\s(]/)[0]] || "grey";
}

/** Hex colours for charts, aligned with the pill tones. */
export const STATUS_HEX = {
  passed: "#10b981",
  failed: "#ef4444",
  blocked: "#f59e0b",
  other: "#737373",
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
  const running = status === "RUNNING" || status === "QUEUED";
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[t]} ${className}`}
    >
      {dot && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[t]} ${running ? "animate-pulse" : ""}`} />}
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
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
