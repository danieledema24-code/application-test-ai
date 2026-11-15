import { ArrowRight, Blocks, ClipboardList, Hash, Minus, MousePointerClick, Move, Paintbrush, PenLine, Plus, type LucideIcon } from "lucide-react";
import { DISPLAY_KIND_LABEL, SIGNIFICANCE_HELP, SIGNIFICANCE_LABEL, SIGNIFICANCES, type DisplayKind, type Significance } from "@/lib/change";
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
