"use client";

import { Lock, PencilLine } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChangeReview as ChangeReviewT, ChangeReviewItem, ReviewAction } from "@/lib/contract";
import { reviewDecisions, valueText } from "@/lib/diff";
import { Button, Card, ConfirmDialog, Disclosure, InlineError } from "@/components/ui";
import { DiffView } from "./DiffView";
import { ProvenanceLabel } from "./ObservationLabel";

const GROUPS: { change: ChangeReviewItem["change"]; title: string; sub?: string; sign: string }[] = [
  { change: "added", title: "Added", sign: "+" },
  { change: "changed", title: "Changed", sub: "not protected", sign: "~" },
  { change: "protected_with_proposal", title: "Proposals for protected items", sub: "locked or edited by people", sign: "~" },
  { change: "no_longer_found", title: "No longer found", sign: "−" },
];

export function actionLabel(a: ReviewAction, change: ChangeReviewItem["change"]): string {
  if (a === "accept") return "Accept";
  if (a === "skip") return "Skip";
  if (a === "mark_rejected") return "Mark rejected";
  return change === "no_longer_found" ? "Keep" : "Keep current";
}

/** Does this decision change anything when applied? */
export function isChange(item: ChangeReviewItem, a: ReviewAction | null | undefined): boolean {
  return a === "accept" || a === "mark_rejected";
}

function itemTitle(i: ChangeReviewItem): string {
  const src = (i.proposed ?? i.current ?? {}) as Record<string, unknown>;
  return valueText(src.title ?? src.text ?? src.name ?? "");
}

const TYPE_FILTERS: { value: string; label: string; types: ChangeReviewItem["type"][] }[] = [
  { value: "test_case", label: "Test cases", types: ["test_case"] },
  { value: "test_condition", label: "Conditions", types: ["test_condition"] },
  { value: "test_data", label: "Test data", types: ["test_data"] },
];

function Row({
  item,
  value,
  onChange,
  disabledReason,
  viewer,
  itemHref,
}: {
  item: ChangeReviewItem;
  value: ReviewAction | null;
  onChange: (a: ReviewAction) => void;
  disabledReason?: string | null;
  viewer?: boolean;
  itemHref?: (i: ChangeReviewItem) => string | null;
}) {
  const src = (item.proposed ?? item.current ?? {}) as Record<string, unknown>;
  const label = typeof src.classification === "string" ? src.classification : null;
  const conf = typeof src.confidence === "number" ? src.confidence : null;
  const status = typeof (item.current ?? {}).status === "string" ? String((item.current ?? {}).status) : null;
  const title = itemTitle(item);
  return (
    <fieldset className="rounded-md border border-line px-4 py-3">
      <legend className="sr-only">
        {item.key} {title}
      </legend>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p aria-hidden className="flex flex-wrap items-center gap-2 text-body text-fg-strong">
            <span className="font-mono font-semibold">{item.key}</span>
            {item.protected_reason === "locked" && <Lock className="h-4 w-4 text-fg-muted" />}
            {item.protected_reason === "human_edited" && <PencilLine className="h-4 w-4 text-fg-muted" />}
            <span>{title}</span>
            {label && <ProvenanceLabel provenance={label} />}
            {conf !== null && <span className="tabular-nums text-small text-fg-muted">{Math.round(conf * 100)}%</span>}
            {status && item.change === "no_longer_found" && <span className="text-small text-fg-muted">[{status === "approved" ? "Approved" : status === "draft" ? "Draft" : status}]</span>}
          </p>
          {item.protected_reason && (
            <p className="text-small text-fg-muted">
              Protected: {item.protected_reason === "locked" ? "locked" : item.protected_reason === "human_edited" ? "edited by a person" : item.protected_reason === "approved" ? "approved" : "written by a person"}
            </p>
          )}
          {item.field_diff.length > 0 && (item.change === "changed" || item.change === "protected_with_proposal") && (
            <DiffView changes={item.field_diff} allowSideBySide={false} />
          )}
          {item.note && <p className="text-small text-fg">{item.note}</p>}
          {!item.note && item.change === "no_longer_found" && item.type === "test_case" && status === "approved" && (
            <p className="text-small text-fg">The requirement or constraint behind this case changed; consider deprecating it.</p>
          )}
          {item.change === "no_longer_found" && itemHref?.(item) && (
            <a href={itemHref(item)!} className="text-small font-medium text-navy-700 underline underline-offset-2">
              Open {item.key}
            </a>
          )}
          {disabledReason && <p className="text-small font-medium text-warning-fg">{disabledReason}</p>}
        </div>
        {viewer ? (
          <p className="text-body text-fg">{value ? actionLabel(value, item.change) : "No decision"}</p>
        ) : (
        <div role="radiogroup" aria-label={`Decision for ${item.key}`} className="flex flex-wrap gap-3">
          {item.allowed_actions.map((a) => {
            const disabled = !!disabledReason && a === "accept";
            return (
              <label key={a} className={`inline-flex min-h-6 items-center gap-1.5 text-body ${disabled ? "text-fg-muted" : "text-fg-strong"}`}>
                <input type="radio" name={`decision-${item.lineage_id}`} value={a} checked={value === a} disabled={disabled} onChange={() => onChange(a)} className="h-4 w-4" />
                {actionLabel(a, item.change)}
              </label>
            );
          })}
        </div>
        )}
      </div>
    </fieldset>
  );
}

/**
 * Regeneration review (design P2 §5.7): grouped Added / Changed / Protected / No longer found / Unchanged,
 * one radio group per row with the API's default. Nothing changes until "Apply {n} changes".
 */
export function ChangeReview({
  review,
  onApply,
  onDiscard,
  readOnly,
  viewer,
  applyNote,
  protectedSub,
  itemHref,
  discardBody,
}: {
  review: ChangeReviewT;
  onApply: (decisions: Record<string, ReviewAction>) => Promise<void>;
  onDiscard: () => Promise<void>;
  readOnly?: boolean;
  /** View-only users see the default decisions as text, with no buttons (design P3 §12.2). */
  viewer?: boolean;
  /** Shown under the Apply button, e.g. "Gate 5 will need approval again." */
  applyNote?: string | null;
  protectedSub?: string;
  itemHref?: (i: ChangeReviewItem) => string | null;
  discardBody?: string;
}) {
  const defaults = useMemo(() => reviewDecisions(review.items, {}), [review.items]);
  const [decisions, setDecisions] = useState<Record<string, ReviewAction>>(defaults);
  const [filter, setFilter] = useState<"all" | ChangeReviewItem["change"]>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const typed = review.items.some((i) => i.type === "test_case" || i.type === "test_condition" || i.type === "test_data");
  const typeOk = (i: ChangeReviewItem) => typeFilter === "all" || TYPE_FILTERS.find((t) => t.value === typeFilter)?.types.includes(i.type);
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const changes = review.items.filter((i) => isChange(i, decisions[i.lineage_id] ?? i.default_action)).length;
  const sm = review.summary ?? {};
  const unchangedCount = sm.unchanged ?? review.items.filter((i) => i.change === "unchanged").length;

  async function apply() {
    setError(null);
    setBusy("apply");
    try {
      await onApply(reviewDecisions(review.items, decisions));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t apply the changes. Nothing was changed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-body text-fg">
        <span className="font-semibold">Summary:</span> {sm.added ?? 0} added · {sm.changed ?? 0} changed · {sm.no_longer_found ?? 0} no longer found · {sm.protected_with_proposal ?? 0} proposal
        {(sm.protected_with_proposal ?? 0) === 1 ? "" : "s"} for protected items · {unchangedCount} unchanged
        {sm.suppressed_rejected ? ` · ${sm.suppressed_rejected} rejected not proposed again` : ""}
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-body text-fg-strong">
          <span className="mb-1 block font-medium">Filter</span>
          <select className="min-h-10 rounded-md bg-surface px-3 ring-1 ring-inset ring-line-input" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All changes</option>
            {GROUPS.map((g) => (
              <option key={g.change} value={g.change}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
        {typed && (
          <label className="text-body text-fg-strong">
            <span className="mb-1 block font-medium">Show</span>
            <select className="min-h-10 rounded-md bg-surface px-3 ring-1 ring-inset ring-line-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All changes</option>
              {TYPE_FILTERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {!readOnly && !viewer && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setDecisions(defaults)}>
              Accept all suggested
            </Button>
            <Button onClick={() => void apply()} loading={busy === "apply"}>
              Apply {changes} change{changes === 1 ? "" : "s"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
              Discard regeneration
            </Button>
            {applyNote && <p className="w-full text-right text-small font-medium text-warning-fg">{applyNote}</p>}
          </div>
        )}
      </div>
      {review.gate_effect && <p className="text-small font-medium text-warning-fg">{review.gate_effect}</p>}
      <InlineError error={error} />
      {GROUPS.filter((g) => filter === "all" || filter === g.change).map((g) => {
        const items = review.items.filter((i) => i.change === g.change && typeOk(i));
        if (items.length === 0) return null;
        return (
          <Card key={g.change} className="p-4">
            <h2 className="mb-3 text-h3 font-semibold text-fg-strong">
              {g.title} ({items.length}){g.sub ? <span className="font-normal text-fg-muted"> — {g.change === "protected_with_proposal" && protectedSub ? protectedSub : g.sub}</span> : null}
            </h2>
            <div className="space-y-2">
              {items.map((i) => (
                <Row
                  key={i.lineage_id}
                  item={i}
                  value={decisions[i.lineage_id] ?? i.default_action}
                  onChange={(a) => setDecisions({ ...decisions, [i.lineage_id]: a })}
                  viewer={viewer || readOnly}
                  itemHref={itemHref}
                />
              ))}
            </div>
          </Card>
        );
      })}
      {unchangedCount > 0 && (
        <Card className="p-4">
          <Disclosure label={`Unchanged (${unchangedCount})`}>
            <ul className="mt-2 space-y-1 text-body text-fg">
              {review.items
                .filter((i) => i.change === "unchanged")
                .map((i) => (
                  <li key={i.lineage_id}>
                    <span className="font-mono">{i.key}</span> {itemTitle(i)}
                  </li>
                ))}
            </ul>
          </Disclosure>
        </Card>
      )}
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard these results?"
        confirmLabel="Discard regeneration"
        danger
        loading={busy === "discard"}
        onConfirm={async () => {
          setBusy("discard");
          try {
            await onDiscard();
          } finally {
            setBusy(null);
            setConfirmDiscard(false);
          }
        }}
      >
        <p>{discardBody ?? `Version ${review.current_version ?? "—"} stays current. Discarded runs stay in the version history, marked “Discarded”.`}</p>
      </ConfirmDialog>
    </div>
  );
}
