"use client";

import { useCallback, useEffect, useState } from "react";
import type { PageSummary, ResponsiveView } from "@/lib/contract";
import { pathOf } from "@/lib/url";
import { Button, Card, Checkbox, EmptyState, Skeleton } from "@/components/ui";
import { ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems } from "@/components/domain/EvidenceDrawer";
import { usePageDetail } from "./hooks";

function observations(views: ResponsiveView[]): string[] {
  const out: string[] = [];
  for (const v of views) {
    if (v.nav_collapsed) out.push(`Navigation collapses into a menu button (${v.viewport})`);
    if (v.horizontal_overflow) out.push(`Content wider than the screen: horizontal scrolling at ${v.viewport}`);
  }
  return out;
}

/** Desktop first, then mobile, then anything else. */
function orderViews(views: ResponsiveView[]): ResponsiveView[] {
  const rank = (v: string) => (/desktop/i.test(v) ? 0 : /mobile/i.test(v) ? 1 : 2);
  return [...views].sort((a, b) => rank(a.viewport) - rank(b.viewport));
}

function PageCompare({ page, onlyDiffs, onResult }: { page: PageSummary; onlyDiffs: boolean; onResult: (id: string, hasDiff: boolean) => void }) {
  const { data } = usePageDetail(page.id);
  const views = orderViews(Object.values(data?.responsive ?? {}));
  const obs = observations(views);
  const hasDiff = obs.length > 0;
  useEffect(() => {
    if (data) onResult(page.id, hasDiff);
  }, [data, hasDiff, page.id, onResult]);
  if (!data) return onlyDiffs ? null : <Skeleton className="h-48" />;
  if (onlyDiffs && !hasDiff) return null;
  const title = data.title || pathOf(data.url);
  return (
    <Card className="p-5">
      <h3 className="text-h3 font-semibold text-fg-strong">
        {title} <span className="font-mono text-small font-normal text-fg-muted">{pathOf(data.url)}</span>
      </h3>
      {views.length === 0 && <p className="mt-2 text-small text-fg-muted">No desktop/mobile capture was recorded for this page.</p>}
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {views.map((v) => (
          <figure key={v.viewport} className="overflow-hidden rounded-md border border-line bg-elevated">
            {v.screenshot ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived evidence URL
              <img src={v.screenshot.content_url} alt={`Screenshot of ${title} (${pathOf(data.url)}), ${v.viewport}`} className="max-h-96 w-full bg-white object-contain object-top" />
            ) : (
              <div className="flex h-40 items-center justify-center text-small text-fg-muted">No screenshot</div>
            )}
            <figcaption className="border-t border-line px-2 py-1 text-caption text-fg-muted">{v.viewport}</figcaption>
          </figure>
        ))}
      </div>
      <ul className="mt-3 space-y-1">
        {views.length === 0 ? null : obs.length === 0 ? (
          <li className="text-small text-fg-muted">No layout differences observed.</li>
        ) : (
          obs.map((o) => (
            <li key={o} className="flex flex-wrap items-center gap-2 text-body text-fg">
              {o} <ObservationLabel provenance="observed" />
              <EvidenceLinks items={linksToItems(views.map((v) => v.screenshot))} subject={`${o} on ${pathOf(data.url)}`} />
            </li>
          ))
        )}
      </ul>
    </Card>
  );
}

const BATCH = 20;

/** Desktop vs mobile per page (design spec §8.2). Needs both viewports. */
export function ResponsiveCompare({ pages, includeMobile, onRescan }: { pages: PageSummary[]; includeMobile: boolean; onRescan: () => void }) {
  // Show every page by default; the filter narrows to pages with observed differences.
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [count, setCount] = useState(BATCH);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const onResult = useCallback((id: string, hasDiff: boolean) => setResults((r) => (r[id] === hasDiff ? r : { ...r, [id]: hasDiff })), []);
  if (!includeMobile)
    return (
      <EmptyState
        title="Responsive observations need both viewports."
        description="This scan used Desktop only."
        action={
          <Button variant="secondary" onClick={onRescan}>
            Re-scan with Mobile
          </Button>
        }
      />
    );
  const visited = pages.filter((p) => !p.requires_auth);
  if (visited.length === 0) return <EmptyState title="No pages to compare yet." description="Desktop and mobile captures appear here once pages have been visited." />;
  const shown = visited.slice(0, count);
  const checked = shown.filter((p) => p.id in results).length;
  const withDiff = shown.filter((p) => results[p.id]).length;
  const allChecked = checked === shown.length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox label="Only pages with differences" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} />
        <p className="text-small text-fg-muted" role="status">
          {allChecked
            ? `${withDiff} of ${shown.length} page${shown.length === 1 ? "" : "s"} show${withDiff === 1 ? "s" : ""} a difference between desktop and mobile.`
            : `Comparing ${checked} of ${shown.length} pages…`}
        </p>
      </div>
      {onlyDiffs && allChecked && withDiff === 0 && (
        <EmptyState
          title="No layout differences observed."
          description="Every compared page looked the same on desktop and mobile (no collapsed navigation or horizontal scrolling). Clear the filter to see the screenshots."
        />
      )}
      <div className="space-y-4">
        {shown.map((p) => (
          <PageCompare key={p.id} page={p} onlyDiffs={onlyDiffs} onResult={onResult} />
        ))}
      </div>
      {visited.length > count && (
        <Button variant="secondary" onClick={() => setCount((c) => c + BATCH)}>
          Check {Math.min(BATCH, visited.length - count)} more page{Math.min(BATCH, visited.length - count) === 1 ? "" : "s"}
        </Button>
      )}
    </div>
  );
}
