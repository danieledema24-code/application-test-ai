import { ArrowRight, Blocks, CircleCheck, CircleDashed, CircleDot, CircleSlash, ClipboardList, Hash, Minus, MousePointerClick, Move, Paintbrush, PenLine, Plus, Target, Unlink, type LucideIcon } from "lucide-react";
import {
  DISPLAY_KIND_LABEL,
  IMPACT_ACTION_LABEL,
  IMPACT_LEVEL_HELP,
  IMPACT_LEVEL_LABEL,
  IMPACT_STATUS_LABEL,
  SIGNIFICANCE_HELP,
  SIGNIFICANCE_LABEL,
  SIGNIFICANCES,
  type DisplayKind,
  type ImpactAction,
  type ImpactLevel,
  type ImpactStatus,
  type Significance,
} from "@/lib/change";
import { Badge, Disclosure, type Tone } from "@/components/ui";

// Change vocabulary (design P6 §3.1, §3.2): every kind and significance is text + icon, never colour alone.

const KIND_ICON: Record<DisplayKind, LucideIcon> = {
  added: Plus,
  removed: Minus,
  renamed: ArrowRight,
  moved: Move,
  changed: PenLine,
  requirement_changed: ClipboardList,
  content_values: Hash,
};

export function ChangeKindLabel({ kind }: { kind: DisplayKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-small text-fg">
      <Icon className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
      {DISPLAY_KIND_LABEL[kind]}
    </span>
  );
}

const SIG: Record<Significance, { tone: Tone; icon: LucideIcon }> = {
  structural: { tone: "amber", icon: Blocks },
  behavioural: { tone: "blue", icon: MousePointerClick },
  cosmetic: { tone: "grey", icon: Paintbrush },
};

export function SignificanceLabel({ significance }: { significance: Significance }) {
  const s = SIG[significance];
  return (
    <Badge tone={s.tone} title={SIGNIFICANCE_HELP[significance]}>
      <s.icon className="h-3.5 w-3.5" aria-hidden />
      {SIGNIFICANCE_LABEL[significance]}
    </Badge>
  );
}

/** "Legend: Structural · Behavioural · Cosmetic [What do these mean?]" (design P6 §6.5); the tooltip text in words. */
export function SignificanceLegend() {
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        Legend:
        {SIGNIFICANCES.map((s) => (
          <SignificanceLabel key={s} significance={s} />
        ))}
      </p>
      <Disclosure label="What do these mean?">
        <dl className="space-y-1 text-small">
          {SIGNIFICANCES.map((s) => (
            <div key={s}>
              <dt className="inline font-semibold text-fg-strong">{SIGNIFICANCE_LABEL[s]}: </dt>
              <dd className="inline text-fg">{SIGNIFICANCE_HELP[s]}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}

// Impact vocabulary (design P6 §3.3): level, action and status as text chips with icons.

const LEVEL: Record<ImpactLevel, { tone: Tone; icon: LucideIcon }> = {
  direct: { tone: "amber", icon: Target },
  indirect: { tone: "blue", icon: CircleDashed },
  gap: { tone: "grey", icon: CircleSlash },
};

export function ImpactLevelLabel({ level }: { level: ImpactLevel }) {
  const l = LEVEL[level];
  return (
    <Badge tone={l.tone} title={IMPACT_LEVEL_HELP[level]}>
      <l.icon className="h-3.5 w-3.5" aria-hidden />
      {IMPACT_LEVEL_LABEL[level]}
    </Badge>
  );
}

export function ImpactActionLabel({ action }: { action: ImpactAction }) {
  return <span className="whitespace-nowrap text-small text-fg">{IMPACT_ACTION_LABEL[action]}</span>;
}

const STATUS: Record<ImpactStatus, { tone: Tone; icon: LucideIcon }> = {
  open: { tone: "amber", icon: CircleDot },
  resolved: { tone: "green", icon: CircleCheck },
  no_action: { tone: "grey", icon: CircleSlash },
};

export function ImpactStatusLabel({ status }: { status: ImpactStatus }) {
  const st = STATUS[status];
  return (
    <Badge tone={st.tone}>
      <st.icon className="h-3.5 w-3.5" aria-hidden />
      {IMPACT_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Script state for regression rows and impact rows (design P6 §3.4): "Outdated" is amber with `Unlink`. */
export function ScriptStateLabel({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-small text-fg-muted">No script</span>;
  if (state === "outdated")
    return (
      <Badge tone="amber">
        <Unlink className="h-3.5 w-3.5" aria-hidden />
        Outdated
      </Badge>
    );
  if (state === "valid")
    return (
      <Badge tone="green">
        <CircleCheck className="h-3.5 w-3.5" aria-hidden />
        Valid
      </Badge>
    );
  const words: Record<string, string> = { invalid: "Invalid", needs_review: "Needs review", not_checked: "Not checked", draft: "Not checked", rejected: "Rejected" };
  return <Badge tone="grey">{words[state] ?? state}</Badge>;
}

/** The three level lines (design P6 §7.1 "How impact works"). */
export function ImpactLegend() {
  return (
    <dl className="space-y-1 text-small">
      {(Object.keys(IMPACT_LEVEL_LABEL) as ImpactLevel[]).map((l) => (
        <div key={l}>
          <dt className="inline font-semibold text-fg-strong">{IMPACT_LEVEL_LABEL[l]}: </dt>
          <dd className="inline text-fg">{IMPACT_LEVEL_HELP[l]}</dd>
        </div>
      ))}
    </dl>
  );
}
