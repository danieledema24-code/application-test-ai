"use client";

import { X } from "lucide-react";

/** Removable chips for active filters (design P2 §5.2): each is a button "Remove filter Status: Draft". */
export function FilterChips({ chips, onRemove, onClear }: { chips: { key: string; label: string }[]; onRemove: (key: string) => void; onClear: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-small">
      <span className="text-fg-muted">Active:</span>
      <ul className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              onClick={() => onRemove(c.key)}
              aria-label={`Remove filter ${c.label}`}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 font-medium text-fg-strong ring-1 ring-inset ring-navy-200 hover:bg-navy-100"
            >
              {c.label}
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClear} className="font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900">
        Clear filters
      </button>
    </div>
  );
}
