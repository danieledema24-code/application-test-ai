"use client";

// Exploratory vocabulary (design P6 §3.6): session status and step outcome as text + icon, never colour alone.

import { Ban, CircleAlert, CircleCheck, CircleDashed, CircleDot, ExternalLink, UserRoundCheck, type LucideIcon } from "lucide-react";
import { Badge, StatusPill } from "@/components/ui";
import { outcomeText, SESSION_TONE, type Session, type Step } from "@/lib/exploratory";

export function SessionStatusPill({ session }: { session: Pick<Session, "status" | "status_label"> }) {
  const s = session.status;
  if (s === "awaiting_approval")
    return (
      <Badge tone="amber" className="rounded-full px-2">
        <UserRoundCheck className="h-3.5 w-3.5" aria-hidden />
        {session.status_label}
      </Badge>
    );
  const status = s === "completed" || s === "partial" ? "completed" : s === "rejected" || s === "expired" ? "cancelled" : s;
  return <StatusPill status={status} label={session.status_label} tone={SESSION_TONE[s]} wrap />;
}

const OUTCOME_ICON: Record<Step["outcome"], LucideIcon> = { ok: CircleCheck, no_effect: CircleDashed, navigated: ExternalLink, error: CircleAlert, blocked: Ban };

export function StepOutcomeLabel({ step }: { step: Pick<Step, "outcome" | "observations"> }) {
  const Icon = OUTCOME_ICON[step.outcome] ?? CircleDot;
  const cls = step.outcome === "error" ? "text-danger-fg" : step.outcome === "blocked" ? "text-warning-fg" : "text-fg";
  return (
    <span className={`inline-flex items-start gap-1 font-medium ${cls}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      {outcomeText(step)}
    </span>
  );
}

