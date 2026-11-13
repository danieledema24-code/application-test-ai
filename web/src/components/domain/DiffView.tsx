"use client";

import { Minus, PencilLine, Plus } from "lucide-react";
import { useState } from "react";
import { humanize } from "@/lib/format";
import { listDiff, valueText, wordDiff, type FieldChange } from "@/lib/diff";
import { Segmented } from "@/components/ui";

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  category: "Category",
  type: "Type",
  assumptions: "Assumptions",
  acceptance_criteria: "Acceptance criteria",
  status: "Status",
  classification: "Label",
  confidence: "Confidence",
  likelihood: "Likelihood",
  impact: "Impact",
  given: "Given",
  when: "When",
  then: "Then",
  text: "Text",
};

export function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? humanize(f);
}

/** Word-level text diff: <del>/<ins> with strike-through and underline plus sr-only "removed:"/"added:". */
export function WordDiff({ from, to }: { from: string; to: string }) {
  return (
    <>
      {wordDiff(from, to).map((p, i) =>
        p.kind === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "del" ? (
          <del key={i} className="rounded-sm bg-diff-del-bg text-diff-del-fg line-through decoration-2">
            <span className="sr-only">removed: </span>
            {p.text}
          </del>
        ) : (
          <ins key={i} className="rounded-sm bg-diff-add-bg text-diff-add-fg underline decoration-2 underline-offset-2">
            <span className="sr-only">added: </span>
            {p.text}
          </ins>
        ),
      )}
    </>
  );
}

function ListDiff({ from, to }: { from: unknown[]; to: unknown[] }) {
  const items = listDiff(from, to).filter((x) => x.kind !== "same");
  return (
    <ul className="space-y-1">
      {items.map((x, i) => (
        <li key={i} className="flex items-start gap-2">
          {x.kind === "added" ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-small font-semibold text-diff-add-fg">
              <Plus className="h-3.5 w-3.5" aria-hidden /> Added
            </span>
          ) : x.kind === "removed" ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-small font-semibold text-diff-del-fg">
              <Minus className="h-3.5 w-3.5" aria-hidden /> Removed
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 text-small font-semibold text-warning-fg">
              <PencilLine className="h-3.5 w-3.5" aria-hidden /> Changed
            </span>
          )}
          <span className="min-w-0">{x.kind === "changed" ? <WordDiff from={x.from ?? ""} to={x.text} /> : x.kind === "removed" ? <del className="line-through">{x.text}</del> : x.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Field-level diff (design P2 §5.6): only changed fields, each under its name; unchanged fields collapse.
 * Inline by default; side-by-side is offered at lg+ only.
 */
export function DiffView({
  changes,
  unchanged = [],
  leftLabel = "Before",
  rightLabel = "After",
  allowSideBySide = true,
}: {
  changes: FieldChange[];
  /** Unchanged fields, collapsed behind "Show". */
  unchanged?: { field: string; value: unknown }[];
  leftLabel?: string;
  rightLabel?: string;
  allowSideBySide?: boolean;
}) {
  const [layout, setLayout] = useState<"inline" | "side">("inline");
  const [showUnchanged, setShowUnchanged] = useState(false);
  if (changes.length === 0) return <p className="text-body text-fg-muted">No differences.</p>;
  return (
    <div className="space-y-3">
      {allowSideBySide && (
        <div className="hidden lg:block">
          <Segmented
            label="Diff layout"
            options={[
              { value: "side", label: "Side by side" },
              { value: "inline", label: "Inline" },
            ]}
            value={layout}
            onChange={setLayout}
          />
        </div>
      )}
      <dl className="space-y-3">
        {changes.map((c) => {
          const isList = Array.isArray(c.from) || Array.isArray(c.to);
          return (
            <div key={c.field}>
              <dt className="text-small font-semibold text-fg-strong">{fieldLabel(c.field)}</dt>
              <dd className="mt-0.5 text-body text-fg">
                {isList ? (
                  <ListDiff from={(c.from as unknown[]) ?? []} to={(c.to as unknown[]) ?? []} />
                ) : layout === "side" && allowSideBySide ? (
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-md bg-diff-del-bg/60 p-2">
                      <p className="text-caption font-semibold text-fg-muted">{leftLabel}</p>
                      <p className="whitespace-pre-wrap">{valueText(c.from) || "—"}</p>
                    </div>
                    <div className="rounded-md bg-diff-add-bg/60 p-2">
                      <p className="text-caption font-semibold text-fg-muted">{rightLabel}</p>
                      <p className="whitespace-pre-wrap">{valueText(c.to) || "—"}</p>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">
                    <WordDiff from={valueText(c.from)} to={valueText(c.to)} />
                  </p>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {unchanged.length > 0 && (
        <div className="text-small text-fg-muted">
          <p>
            {unchanged.length} unchanged field{unchanged.length === 1 ? "" : "s"}.{" "}
            <button type="button" aria-expanded={showUnchanged} className="font-medium text-navy-700 underline underline-offset-2" onClick={() => setShowUnchanged((v) => !v)}>
              {showUnchanged ? "Hide" : "Show"}
            </button>
          </p>
          {showUnchanged && (
            <dl className="mt-2 space-y-2">
              {unchanged.map((u) => (
                <div key={u.field}>
                  <dt className="font-semibold text-fg-strong">{fieldLabel(u.field)}</dt>
                  <dd className="whitespace-pre-wrap text-fg">{valueText(u.value) || "—"}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
