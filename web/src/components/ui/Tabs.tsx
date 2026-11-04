"use client";

import { useRef } from "react";

export type TabItem = { id: string; label: React.ReactNode; count?: number };

export function Tabs({
  tabs,
  value,
  onChange,
  label = "Sections",
  idPrefix = "tab",
}: {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  idPrefix?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(e: React.KeyboardEvent, i: number) {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      onChange(tabs[next].id);
      refs.current[next]?.focus();
    }
  }
  return (
    <div className="scrollbar-thin -mx-1 overflow-x-auto border-b border-slate-200">
      <div role="tablist" aria-label={label} className="flex min-w-max gap-1 px-1">
        {tabs.map((t, i) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`${idPrefix}-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`relative -mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                selected
                  ? "border-blue-700 text-blue-800"
                  : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({
  id,
  idPrefix = "tab",
  children,
}: {
  id: string;
  idPrefix?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-${id}`} className="pt-6">
      {children}
    </div>
  );
}

/** Small segmented control, e.g. 7/30/90 day toggle. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            o.value === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
