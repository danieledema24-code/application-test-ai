"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, ChevronsUp, CircleCheck, CircleHelp, CircleX, Equal, Info, KeyRound, Lock, PencilLine, Ruler, Sparkle, TriangleAlert, X } from "lucide-react";
import type { CaseStatus, Priority, TestCaseSummary, TestDataItem } from "@/lib/contract";
import { CASE_STATUS_TEXT, KIND_TEXT, PRIORITY_TEXT, TECHNIQUE_OPTIONS, displayValue, lintCounts, techniqueInfo } from "@/lib/testcases";
import { StatusPill, Tooltip } from "@/components/ui";

// ---- Technique (§7.4) ---------------------------------------------------------------------------

/** Short name always; full name at md+ (or always when `full`). The full name is in sr text either way. */
export function TechniqueChip({ technique, full = false }: { technique: string | null | undefined; full?: boolean }) {
  const t = techniqueInfo(technique);
  return (
    <Tooltip content={t.name}>
      <span tabIndex={full ? undefined : 0} className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-overlay px-1.5 py-0.5 text-caption font-medium text-fg-strong ring-1 ring-inset ring-line-strong">
        <span aria-hidden>{t.short}</span>
        <span className={full ? "" : "sr-only md:not-sr-only"}>
          <span className="sr-only">Technique: </span>
          {t.name}
        </span>
      </span>
    </Tooltip>
  );
}

/** "What do techniques mean?" (§6.1): a disclosure with each technique's short name, full name and definition. */
export function TechniqueLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex min-h-8 items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
        What do techniques mean? <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-surface p-3 shadow-lg ring-1 ring-line-strong">
          <dl className="space-y-2 text-small">
            {TECHNIQUE_OPTIONS.map((k) => {
              const t = techniqueInfo(k);
              return (
                <div key={k}>
                  <dt className="font-semibold text-fg-strong">
                    {t.short !== "—" ? `${t.short} · ` : ""}
                    {t.name}
                  </dt>
                  <dd className="text-fg">{t.definition}</dd>
                </div>
              );
            })}
          </dl>
          <button type="button" onClick={() => setOpen(false)} className="mt-2 text-small font-medium text-navy-700 underline underline-offset-2">
            Close
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Priority (§3) ------------------------------------------------------------------------------

const PRIORITY_STYLE: Record<Priority, { cls: string; Icon: typeof ChevronUp }> = {
  critical: { cls: "bg-danger-solid text-white font-bold ring-danger-solid", Icon: ChevronsUp },
  high: { cls: "bg-danger-bg text-danger-fg ring-danger-line", Icon: ChevronUp },
  medium: { cls: "bg-warning-bg text-warning-fg ring-warning-line", Icon: Equal },
  low: { cls: "bg-overlay text-fg-muted ring-line-strong", Icon: ChevronDown },
};

export function PriorityValue({ priority }: { priority: Priority | null | undefined }) {
  const p = priority ?? "low";
  const { cls, Icon } = PRIORITY_STYLE[p] ?? PRIORITY_STYLE.low;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium ring-1 ring-inset ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">Priority </span>
      {PRIORITY_TEXT[p] ?? p}
    </span>
  );
}

// ---- Lint (§3, §8.6) ----------------------------------------------------------------------------

export function SeverityText({ severity }: { severity: "must" | "advice" | "clean" }) {
  if (severity === "must")
    return (
      <span className="inline-flex items-center gap-1 font-medium text-danger-fg">
        <CircleX className="h-4 w-4" aria-hidden /> Must fix
      </span>
    );
  if (severity === "advice")
    return (
      <span className="inline-flex items-center gap-1 font-medium text-warning-fg">
        <TriangleAlert className="h-4 w-4" aria-hidden /> Advice
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 font-medium text-success-fg">
      <CircleCheck className="h-4 w-4" aria-hidden /> No issues
    </span>
  );
}

/** The list's Checks column: "✗ 1 must fix" (+ "+2 advice"), "⚠ 1 advice" or "✓ No issues". */
export function LintChip({ c }: { c: Pick<TestCaseSummary, "lint_summary" | "expected_result_status"> }) {
  const { must, advice } = lintCounts(c);
  if (must)
    return (
      <span className="inline-flex flex-col">
        <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-danger-fg">
          <CircleX className="h-4 w-4" aria-hidden /> {must} must fix
        </span>
        {advice > 0 && <span className="text-caption text-fg-muted">+{advice} advice</span>}
      </span>
    );
  if (advice)
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-warning-fg">
        <TriangleAlert className="h-4 w-4" aria-hidden /> {advice} advice
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-success-fg">
      <CircleCheck className="h-4 w-4" aria-hidden /> No issues
    </span>
  );
}

// ---- Status -------------------------------------------------------------------------------------

export function CaseStatusPill({ status }: { status: CaseStatus }) {
  return <StatusPill status={status} label={CASE_STATUS_TEXT[status] ?? status} tone={status === "draft" ? "grey" : undefined} />;
}

export function OpenQuestionPill() {
  return <StatusPill status="open_question" label="Open question" />;
}

/** Status flags with sr text (§6.1): open question, locked, edited, changed in latest generation. */
export function CaseFlags({ c }: { c: Pick<TestCaseSummary, "locked" | "human_edited" | "changed_in_latest" | "expected_result_status"> }) {
  const flag = (Icon: typeof Lock, text: string) => (
    <Tooltip content={text}>
      <span tabIndex={0} className="inline-flex text-fg-muted">
        <Icon className="h-4 w-4" aria-hidden />
        <span className="sr-only">{text}</span>
      </span>
    </Tooltip>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {c.expected_result_status === "open_question" && <OpenQuestionPill />}
      {c.locked && flag(Lock, "Locked")}
      {c.human_edited && flag(PencilLine, "Edited by a person")}
      {c.changed_in_latest && flag(Sparkle, "Changed in latest generation")}
    </span>
  );
}

/** "Not run yet" with the Phase 4 tooltip (§6.1): never a pill, never coloured, never "—" alone. */
export function NotRunYet() {
  return (
    <Tooltip content="Execution arrives in Phase 4.">
      <span tabIndex={0} className="whitespace-nowrap text-fg-muted">
        Not run yet<span className="sr-only">. Execution arrives in Phase 4.</span>
      </span>
    </Tooltip>
  );
}

export function NotDecided() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-warning-fg">
      <CircleHelp className="h-4 w-4" aria-hidden /> Not decided
    </span>
  );
}

// ---- Values (§7.1, §11.1) -----------------------------------------------------------------------

/** A literal test value as escaped text: visible whitespace, "(empty) 0 characters", truncation with [Show full value]. */
export function ValueText({ value, max = 40 }: { value: string | null | undefined; max?: number }) {
  const [full, setFull] = useState(false);
  const d = displayValue(value, max);
  if (d.truncated && !full)
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-small text-fg-strong" aria-hidden>
          {d.text}
        </span>
        <button type="button" onClick={() => setFull(true)} className="text-small font-medium text-navy-700 underline underline-offset-2">
          Show full value<span className="sr-only">, {d.length} characters</span>
        </button>
      </span>
    );
  if (d.truncated && full) return <span className="break-all font-mono text-small text-fg-strong">{d.full}</span>;
  return (
    <span className="break-all font-mono text-small text-fg-strong">
      <span aria-hidden>{d.text}</span>
      <span className="sr-only">{d.sr}</span>
    </span>
  );
}

const KIND_ICON: Record<string, typeof Check> = { valid: Check, invalid: X, boundary: Ruler, secret_ref: KeyRound };

export function KindBadge({ kind }: { kind: TestDataItem["kind"] }) {
  const Icon = KIND_ICON[kind] ?? Check;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm bg-overlay px-1.5 py-0.5 text-caption font-medium text-fg-strong ring-1 ring-inset ring-line-strong">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {KIND_TEXT[kind] ?? kind}
    </span>
  );
}
