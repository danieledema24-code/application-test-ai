import { CircleCheck, CircleHelp, CircleX, Lock, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react";
import { ASSESSMENT_STATUS_LABEL, CRITERION_STATUS_LABEL, LEVEL_LABEL, STATE_WORD, VERDICT_LABEL, type AssessmentStatus, type CriterionStatus, type RiskLevel, type Verdict, type VerdictState } from "@/lib/release";
import { LEVEL_CLASS } from "@/lib/strategy";
import { Badge, type Tone } from "@/components/ui";

// Release vocabulary (design P6 §3.7): verdict, criterion status, Blocking and assessment status are text + icon,
// never colour alone. The verdict is always followed by its state word (Recommended, Final, Not decided).

const VERDICT: Record<Verdict, { tone: Tone; icon: LucideIcon }> = {
  go: { tone: "green", icon: CircleCheck },
  conditional: { tone: "amber", icon: TriangleAlert },
  no_go: { tone: "red", icon: OctagonX },
};

/** "⚠ Conditional · Recommended" */
export function VerdictChip({ verdict, state, size = "md" }: { verdict: Verdict; state?: VerdictState; size?: "md" | "lg" }) {
  const v = VERDICT[verdict];
  return (
    <Badge tone={v.tone} className={size === "lg" ? "px-2.5 py-1 text-body" : ""}>
      <v.icon className={size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden />
      {VERDICT_LABEL[verdict]}
      {state && <> · {STATE_WORD[state]}</>}
    </Badge>
  );
}

const CRITERION: Record<CriterionStatus, { cls: string; icon: LucideIcon }> = {
  met: { cls: "text-success-fg", icon: CircleCheck },
  not_met: { cls: "text-danger-fg", icon: CircleX },
  not_evaluable: { cls: "text-fg-muted", icon: CircleHelp },
};

export function CriterionStatusLabel({ status }: { status: CriterionStatus }) {
  const c = CRITERION[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-medium ${c.cls}`}>
      <c.icon className="h-4 w-4" aria-hidden />
      {CRITERION_STATUS_LABEL[status]}
    </span>
  );
}

export function BlockingLabel({ blocking }: { blocking: boolean }) {
  if (!blocking) return <span className="whitespace-nowrap text-fg">Not blocking</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-fg-strong">
      <Lock className="h-3.5 w-3.5" aria-hidden />
      Blocking
    </span>
  );
}

const STATUS_TONE: Record<AssessmentStatus, Tone> = { awaiting_approval: "amber", final: "green", rejected: "grey", stale: "amber", superseded: "grey" };

export function AssessmentStatusLabel({ status, supersededBy }: { status: AssessmentStatus; supersededBy?: string | null }) {
  return <Badge tone={STATUS_TONE[status]}>{status === "superseded" && supersededBy ? `Replaced by ${supersededBy}` : ASSESSMENT_STATUS_LABEL[status]}</Badge>;
}

/** Residual level with the existing risk chips (design P6 §3.7). */
export function RiskLevelChip({ level }: { level: RiskLevel }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-small ring-1 ring-inset ${LEVEL_CLASS[level]}`}>{LEVEL_LABEL[level]}</span>;
}
