"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { TestStep } from "@/lib/types";
import { Button, inputClass } from "@/components/ui";

export function StepsEditor({ steps, onChange }: { steps: TestStep[]; onChange: (s: TestStep[]) => void }) {
  const update = (i: number, patch: Partial<TestStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-fg">Steps</legend>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2 rounded-lg border border-line bg-elevated/60 p-2">
            <span className="mt-2 w-6 shrink-0 text-center text-xs font-semibold text-fg-muted">{i + 1}</span>
            <div className="grid flex-1 gap-2 sm:grid-cols-[2fr_1fr_2fr]">
              <div>
                <label htmlFor={`step-${i}-action`} className="sr-only">
                  Step {i + 1} action
                </label>
                <input
                  id={`step-${i}-action`}
                  className={inputClass}
                  placeholder="Action"
                  value={s.action}
                  onChange={(e) => update(i, { action: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`step-${i}-data`} className="sr-only">
                  Step {i + 1} test data
                </label>
                <input
                  id={`step-${i}-data`}
                  className={inputClass}
                  placeholder="Test data (optional)"
                  value={s.data || ""}
                  onChange={(e) => update(i, { data: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`step-${i}-expected`} className="sr-only">
                  Step {i + 1} expected result
                </label>
                <input
                  id={`step-${i}-expected`}
                  className={inputClass}
                  placeholder="Expected result"
                  value={s.expected || ""}
                  onChange={(e) => update(i, { expected: e.target.value })}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-start gap-0.5">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1.5 text-fg-muted hover:bg-overlay disabled:opacity-30" aria-label={`Move step ${i + 1} up`}>
                <ArrowUp className="h-4 w-4" aria-hidden />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="rounded p-1.5 text-fg-muted hover:bg-overlay disabled:opacity-30" aria-label={`Move step ${i + 1} down`}>
                <ArrowDown className="h-4 w-4" aria-hidden />
              </button>
              <button type="button" onClick={() => onChange(steps.filter((_, j) => j !== i))} className="rounded p-1.5 text-fg-muted hover:bg-overlay hover:text-red-400" aria-label={`Remove step ${i + 1}`}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <Button size="sm" variant="secondary" className="mt-2" onClick={() => onChange([...steps, { action: "", data: "", expected: "" }])} icon={<Plus className="h-4 w-4" aria-hidden />}>
        Add step
      </Button>
    </fieldset>
  );
}
