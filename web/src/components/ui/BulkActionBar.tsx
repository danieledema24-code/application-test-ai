"use client";

/**
 * Sticky selection toolbar (design P2 §5.2). A labelled region at the bottom of the viewport; pages add
 * bottom padding equal to its height so it never hides the focused row (WCAG 2.4.11).
 */
export function BulkActionBar({ count, noun = "selected", children, onClear }: { count: number; noun?: string; children: React.ReactNode; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div role="region" aria-label="Bulk actions" className="fixed inset-x-0 bottom-0 z-30 border-t border-line-strong bg-surface/95 px-4 py-3 shadow-lg backdrop-blur lg:left-64">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3">
        <p className="text-body font-semibold tabular-nums text-fg-strong">
          {count} {noun}
        </p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        <button type="button" onClick={onClear} className="ml-auto rounded-md px-2 py-1 text-body font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900">
          Clear selection
        </button>
      </div>
    </div>
  );
}

/** Height reserved under content while the bar is shown. */
export const BULK_BAR_PADDING = "pb-24";
