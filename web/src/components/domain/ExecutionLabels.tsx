"use client";

// Phase 4 vocabulary chips (design P4 §3): result, run and defect status, failure cause, Hypothesis and severity.
// Every one is text plus icon, never colour alone.

import { ChevronDown, ChevronUp, ChevronsUp, CircleAlert, CircleCheck, CircleDashed, CircleSlash, CircleX, Equal, Eye, Lightbulb, Loader2, Lock, Shuffle, UserPen, type LucideIcon } from "lucide-react";
import { StatusPill, TONE_CLASSES, Tooltip } from "@/components/ui";
import { PROVENANCE_DEFS } from "@/components/domain/ObservationLabel";
import { CLASSIFICATIONS, CONFIDENCE_TEXT, RESULT_STATUS, runStatusText, type Classification, type Confidence, type ResultState, type RunSummary } from "@/lib/execution";
import { DEFECT_STATUS, SEVERITY_TEXT, type DefectStatus, type Severity } from "@/lib/defects";

const RESULT_ICONS: Record<ResultState, LucideIcon> = {
  passed: CircleCheck,
  failed: CircleX,
  error: CircleAlert,
  flaky: Shuffle,
  skipped: CircleSlash,
  blocked: Lock,
  running: Loader2,
  waiting: CircleDashed,
};

const CHIP = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-medium ring-1 ring-inset";

/** "✓ Passed", "Flaky (passed on retry)", "Blocked: needs test credentials" (reason appended when given). */
export function ResultStatus({ status, reason, className = "" }: { status: ResultState | string; reason?: string | null; className?: string }) {
  const s = (status in RESULT_STATUS ? status : "error") as ResultState;
  const v = RESULT_STATUS[s];
  const Icon = RESULT_ICONS[s];
  const spin = s === "running";
  return (
    <span className={`${CHIP} ${TONE_CLASSES[v.tone]} ${className}`}>
      <Icon className={`h-3.5 w-3.5 ${spin ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
      {v.label}
      {reason ? `: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ""}
    </span>
  );
}

export function RunStatusPill({ run }: { run: Pick<RunSummary, "status" | "totals" | "mode"> }) {
  const t = runStatusText(run);
  return <StatusPill status={t.status} label={t.label} tone={t.tone} />;
}

/** "Likely bug in the application" with its one-line meaning in the tooltip. */
export function ClassificationLabel({ classification, className = "" }: { classification: Classification | string | null | undefined; className?: string }) {
  const c = CLASSIFICATIONS[(classification ?? "unknown") as Classification] ?? CLASSIFICATIONS.unknown;
  return (
    <Tooltip content={c.meaning}>
      <span tabIndex={0} className={`${CHIP} ${TONE_CLASSES[c.tone]} ${className}`}>
        {c.tone === "red" ? <CircleX className="h-3.5 w-3.5" aria-hidden /> : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
        {c.label}
        <span className="sr-only">. {c.meaning}</span>
      </span>
    </Tooltip>
  );
}

/** "Hypothesis" (inferred tokens) or, after a person changed the cause, "Set by {name}". */
export function HypothesisLabel({ setBy, className = "" }: { setBy?: string | null; className?: string }) {
  if (setBy)
    return (
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium ${TONE_CLASSES.grey} ring-1 ring-inset ${className}`}>
        <UserPen className="h-3.5 w-3.5" aria-hidden />
        Set by {setBy}
      </span>
    );
  return (
    <Tooltip content="Worked out from the evidence. A person confirms or rejects it.">
      <span tabIndex={0} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-dashed border-inferred-line bg-inferred-bg px-1.5 py-0.5 text-caption font-medium text-inferred-fg ${className}`}>
        <Lightbulb className="h-3.5 w-3.5" aria-hidden />
        Hypothesis
        <span className="sr-only">: worked out from the evidence. A person confirms or rejects it.</span>
      </span>
    </Tooltip>
  );
}

export function ConfidenceText({ confidence }: { confidence: Confidence | null | undefined }) {
  if (!confidence) return null;
  return <span className="whitespace-nowrap text-fg">Confidence: {CONFIDENCE_TEXT[confidence]}</span>;
}

const SEVERITY_STYLE: Record<Severity, { cls: string; Icon: LucideIcon }> = {
  critical: { cls: "bg-danger-solid text-white ring-danger-solid", Icon: ChevronsUp },
  major: { cls: "bg-danger-bg text-danger-fg ring-danger-line", Icon: ChevronUp },
  minor: { cls: "bg-warning-bg text-warning-fg ring-warning-line", Icon: Equal },
  trivial: { cls: "bg-overlay text-fg-muted ring-line-strong", Icon: ChevronDown },
};

export function SeverityValue({ severity }: { severity: Severity | string }) {
  const s = (severity in SEVERITY_STYLE ? severity : "minor") as Severity;
  const { cls, Icon } = SEVERITY_STYLE[s];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium ring-1 ring-inset ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">Severity </span>
      {SEVERITY_TEXT[s]}
    </span>
  );
}

/** "Draft · waiting for review". */
export function DefectStatusPill({ status, withNote = true }: { status: DefectStatus | string; withNote?: boolean }) {
  const d = DEFECT_STATUS[(status in DEFECT_STATUS ? status : "draft") as DefectStatus];
  return <StatusPill status={d.status} tone={d.tone} label={withNote && d.note ? `${d.label} · ${d.note}` : d.label} />;
}

/** The Observed chip with custom text ("Observed on the page"): what the page showed is Observed (§8.6). */
export function ObservedLabel({ text = "Observed" }: { text?: string }) {
  const def = PROVENANCE_DEFS.observed;
  return (
    <span title={def.definition} data-provenance="observed" className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium ${def.cls}`}>
      <Eye className="h-3.5 w-3.5" aria-hidden />
      {text}
    </span>
  );
}
