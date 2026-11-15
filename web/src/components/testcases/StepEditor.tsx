"use client";

import { useRef } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import type { TestDataItem } from "@/lib/contract";
import { KIND_TEXT, displayValue, newStep, vagueWords, type StepDraft } from "@/lib/testcases";
import { Button, SelectField, TextArea } from "@/components/ui";

function dataOptionLabel(d: TestDataItem): string {
  if (d.kind === "secret_ref") return `${d.key} · ${d.field_label} · Saved test account (value never shown)`;
  return `${d.key} · ${d.field_label} · ${KIND_TEXT[d.kind] ?? d.kind} · ${displayValue(d.value, 24).text}`;
}

const NEW_DATA = "__new";

/**
 * Keyboard-first step editor (design P3 §8.3): each step is a fieldset with Move up / Move down / Remove
 * buttons named for the step; no drag. Moves keep focus on the same button; removals move focus to the next
 * step's action. Every change is announced through `announce`.
 */
export function StepEditor({
  steps,
  onChange,
  errors,
  data,
  onNewData,
  announce,
  hint,
}: {
  steps: StepDraft[];
  onChange: (s: StepDraft[]) => void;
  errors: Record<string, string>;
  data: TestDataItem[];
  /** Opens "New test data item…" and resolves with the created item (or null). */
  onNewData?: () => Promise<TestDataItem | null>;
  announce: (msg: string) => void;
  /** Hint under expected-result fields (e.g. for open questions). */
  hint?: (i: number) => string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const focus = (id: string) =>
    setTimeout(() => {
      (root.current?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null)?.focus();
    }, 0);

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    announce(`Step ${i + 1} moved to position ${j + 1}`);
    // Keep focus on the same control in the step's new position; at an edge it is disabled, so use the other.
    const atEdge = (d === -1 && j === 0) || (d === 1 && j === steps.length - 1);
    focus(`step-${j}-${atEdge ? (d === -1 ? "down" : "up") : d === -1 ? "up" : "down"}`);
  }

  function remove(i: number) {
    const next = steps.filter((_, k) => k !== i);
    onChange(next);
    announce(`Step ${i + 1} removed`);
    focus(next.length ? `step-${Math.min(i, next.length - 1)}-action` : "add-step");
  }

  function add() {
    onChange([...steps, newStep()]);
    announce(`Step ${steps.length + 1} added`);
    focus(`step-${steps.length}-action`);
  }

  async function addData(i: number, value: string) {
    if (!value) return;
    let item: TestDataItem | null | undefined = data.find((d) => d.id === value);
    if (value === NEW_DATA) item = onNewData ? await onNewData() : null;
    if (!item) return;
    const s = steps[i];
    if (s.data.some((x) => x.id === item!.id)) return;
    const next = [...steps];
    next[i] = { ...s, data: [...s.data, { id: item.id, key: item.key, label: item.field_label }] };
    onChange(next);
    announce(`${item.key} added to step ${i + 1}`);
  }

  const set = (i: number, patch: Partial<StepDraft>) => {
    const next = [...steps];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  const activeData = data.filter((d) => d.status === "active");

  return (
    <div ref={root} className="space-y-3">
      {steps.map((s, i) => {
        const vague = [...vagueWords(s.action), ...vagueWords(s.expected)];
        return (
          <fieldset key={s.id} className="rounded-md border border-line p-3">
            <legend className="px-1 text-body font-semibold text-fg-strong">Step {i + 1}</legend>
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              <Button id={`step-${i}-up`} size="sm" variant="ghost" icon={<ArrowUp className="h-4 w-4" aria-hidden />} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>
                <span aria-hidden>Move up</span>
              </Button>
              <Button
                id={`step-${i}-down`}
                size="sm"
                variant="ghost"
                icon={<ArrowDown className="h-4 w-4" aria-hidden />}
                disabled={i === steps.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Move step ${i + 1} down`}
              >
                <span aria-hidden>Move down</span>
              </Button>
              <Button id={`step-${i}-remove`} size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => remove(i)} aria-label={`Remove step ${i + 1}`}>
                <span aria-hidden>Remove</span>
              </Button>
            </div>
            <div className="space-y-3">
              <TextArea id={`step-${i}-action`} label="Action" required rows={2} maxLength={500} value={s.action} onChange={(e) => set(i, { action: e.target.value })} error={errors[`step-${i}-action`]} />
              <div>
                <p className="text-body font-medium text-fg-strong">Test data</p>
                {s.data.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {s.data.map((d) => (
                      <li key={d.id} className="inline-flex items-center gap-1 rounded-full bg-overlay px-2 py-0.5 text-small text-fg-strong ring-1 ring-inset ring-line-strong">
                        <span className="font-mono">{d.key}</span> {d.label}
                        <button
                          type="button"
                          onClick={() => {
                            set(i, { data: s.data.filter((x) => x.id !== d.id) });
                            announce(`${d.key} removed from step ${i + 1}`);
                          }}
                          aria-label={`Remove ${d.key} from step ${i + 1}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-surface"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <SelectField
                  label={`Add test data to step ${i + 1}`}
                  hideLabel
                  value=""
                  onChange={(e) => void addData(i, e.target.value)}
                  wrapClassName="mt-1 max-w-md"
                  options={[
                    { value: "", label: "Add test data…" },
                    ...activeData.map((d) => ({ value: d.id, label: dataOptionLabel(d) })),
                    ...(onNewData ? [{ value: NEW_DATA, label: "New test data item…" }] : []),
                  ]}
                />
              </div>
              <TextArea
                id={`step-${i}-expected`}
                label="Expected"
                rows={2}
                maxLength={500}
                value={s.expected}
                onChange={(e) => set(i, { expected: e.target.value })}
                error={errors[`step-${i}-expected`]}
                hint={hint?.(i)}
              />
              {vague.length > 0 && (
                <p className="text-small text-warning-fg">
                  {vague.map((w) => (
                    <span key={w}>
                      ‘<mark className="bg-warning-bg text-warning-fg">{w}</mark>’ is vague.{" "}
                    </span>
                  ))}
                  Say exactly what the user sees.
                </p>
              )}
            </div>
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button id="add-step" variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={add}>
          Add step
        </Button>
        <span className="text-small text-fg-muted">
          {steps.length} step{steps.length === 1 ? "" : "s"} · 15 recommended maximum
        </span>
      </div>
      {errors["add-step"] && <p className="text-small font-medium text-danger-fg">{errors["add-step"]}</p>}
    </div>
  );
}
