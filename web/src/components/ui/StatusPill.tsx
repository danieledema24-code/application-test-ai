import { humanize } from "@/lib/format";

type Tone = "green" | "red" | "amber" | "blue" | "grey" | "orange" | "violet";

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
  HIGH: "orange",
  MEDIUM: "amber",
  LOW: "grey",
  // assistant / misc
  NEEDS_CONFIRMATION: "amber",
  CONNECTED: "green",
  DISCONNECTED: "grey",
  ACTIVE: "green",
  INACTIVE: "grey",
  // environments
  PRODUCTION: "red",
  STAGING: "amber",
  DEVELOPMENT: "blue",
};

const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-600/25",
  red: "bg-red-50 text-red-800 ring-red-600/25",
  amber: "bg-amber-50 text-amber-900 ring-amber-600/30",
  orange: "bg-orange-50 text-orange-800 ring-orange-600/25",
  blue: "bg-blue-50 text-blue-800 ring-blue-600/25",
  grey: "bg-slate-100 text-slate-700 ring-slate-500/20",
  violet: "bg-violet-50 text-violet-800 ring-violet-600/25",
};

const DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  blue: "bg-blue-500",
  grey: "bg-slate-400",
  violet: "bg-violet-500",
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
  other: "#94a3b8",
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
