"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { InlineError } from "./States";
import { inputClass } from "./Field";

export type ChecklistRow = { id: string; text: string };

let seq = 0;
export function newRow(text = ""): ChecklistRow {
  seq += 1;
  return { id: `new-${seq}`, text };
}

/**
 * Ordered list editing without drag (design P2 §6.1): each row is a text field with Move up, Move down and
 * Remove icon buttons. Empty rows are dropped on save; at least one item is required.
 */
export function ChecklistEditor({
  initial,
  onSave,
  onCancel,
  label = "Criterion",
  max = 30,
  maxLength = 300,
  saveLabel = "Save",
  busy,
  error,
}: {
  initial: ChecklistRow[];
  onSave: (rows: ChecklistRow[]) => void;
  onCancel: () => void;
  label?: string;
  max?: number;
  maxLength?: number;
  saveLabel?: string;
  busy?: boolean;
  error?: string | null;
}) {
  const [rows, setRows] = useState<ChecklistRow[]>(initial.length ? initial : [newRow()]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => {
    if (focusId) refs.current[focusId]?.focus();
  }, [focusId, rows]);

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
    setFocusId(next[j].id);
  }

  function save() {
    const kept = rows.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
    if (kept.length === 0) {
      setLocalError("Add at least one criterion.");
      return;
    }
    setLocalError(null);
    onSave(kept);
  }

  const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted ring-1 ring-inset ring-line-input hover:bg-overlay hover:text-fg-strong disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11";
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.id} className="flex items-center gap-2">
            <label htmlFor={`cl-${r.id}`} className="w-6 shrink-0 text-right text-small tabular-nums text-fg-muted">
              <span className="sr-only">
                {label} {i + 1}
              </span>
              <span aria-hidden>{i + 1}.</span>
            </label>
            <input
              id={`cl-${r.id}`}
              ref={(el) => {
                refs.current[r.id] = el;
              }}
              className={`${inputClass} flex-1`}
              value={r.text}
              maxLength={maxLength}
              onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)))}
            />
            <button type="button" className={iconBtn} aria-label={`Move ${label.toLowerCase()} ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={iconBtn} aria-label={`Move ${label.toLowerCase()} ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className={iconBtn}
              aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
              onClick={() => {
                const next = rows.filter((x) => x.id !== r.id);
                setRows(next);
                setFocusId(next[Math.min(i, next.length - 1)]?.id ?? null);
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      <Button
        variant="secondary"
        size="sm"
        icon={<Plus className="h-4 w-4" aria-hidden />}
        disabled={rows.length >= max}
        onClick={() => {
          const r = newRow();
          setRows([...rows, r]);
          setFocusId(r.id);
        }}
      >
        Add criterion
      </Button>
      <InlineError error={localError ?? error ?? null} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
