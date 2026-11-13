"use client";

import type { Feature, Journey, ScanDetail } from "@/lib/contract";
import { accessGapRows, elapsed } from "@/lib/discovery";
import { fmtDateTime } from "@/lib/format";
import { Card, CardBody, CardHeader, StatTile } from "@/components/ui";
import { GeneratedByLabel, LabelsHelp, ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, refsToItems } from "@/components/domain/EvidenceDrawer";

export const UI_ONLY_LIMITATION = "Discovery observes the user interface only. Backend behaviour, data handling and security have not been verified.";

export function limitationsOf(scan: ScanDetail): string[] {
  const list = [...(scan.limitations ?? [])];
  if (!list.some((l) => l.trim() === UI_ONLY_LIMITATION)) list.push(UI_ONLY_LIMITATION);
  return list;
}

/** Summary tab body (gate panel is rendered above it by the page). */
export function DiscoverySummary({
  scan,
  features,
  journeys,
}: {
  scan: ScanDetail;
  features: Feature[] | undefined;
  journeys: Journey[] | undefined;
}) {
  const soFar = scan.status === "cancelled" || scan.status === "partial" || scan.status === "running" ? " so far" : "";
  const gaps = accessGapRows(scan).length;
  const key = (features ?? []).slice().sort((a, b) => b.confidence - a.confidence).slice(0, 6);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Pages" value={scan.stats.pages} hint={soFar ? `visited${soFar}` : `${scan.pages_found} found`} />
        <StatTile label="Forms" value={scan.stats.forms} />
        <StatTile label="User journeys" value={journeys ? journeys.length : "—"} />
        <StatTile label="Access gaps" value={gaps} />
      </div>
      <Card>
        <CardHeader title="Key observations" actions={<LabelsHelp />} />
        <CardBody>
          {!features ? (
            <p className="text-body text-fg-muted">Loading observations…</p>
          ) : key.length === 0 ? (
            <p className="text-body text-fg-muted">No observations yet. They appear when discovery has catalogued functionality.</p>
          ) : (
            <ul className="space-y-3">
              {key.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-fg">
                  <span className="font-medium text-fg-strong">{f.name}:</span>
                  <span>{f.description}</span>
                  <ObservationLabel provenance={f.provenance} confidence={f.confidence} />
                  <GeneratedByLabel generatedBy={f.generated_by} />
                  <EvidenceLinks items={refsToItems(f.evidence_refs)} subject={f.name} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Scope & settings" />
          <CardBody>
            <dl className="divide-y divide-line text-body">
              {(
                [
                  ["Start URL", <span key="u" className="break-all font-mono text-small">{scan.start_url}</span>],
                  ["Maximum pages", scan.limits?.max_pages],
                  ["Maximum link depth", scan.limits?.max_depth],
                  ["Viewports", scan.limits?.include_mobile ? "Desktop + Mobile" : "Desktop only"],
                  ["robots.txt", scan.limits?.respect_robots ? "Respected" : "Ignored"],
                  ["Credentials", "None (public pages only)"],
                  ["Started", fmtDateTime(scan.started_at)],
                  ["Finished", scan.finished_at ? fmtDateTime(scan.finished_at) : "—"],
                  ["Duration", elapsed(scan.started_at, scan.finished_at)],
                ] as [string, React.ReactNode][]
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-2">
                  <dt className="text-fg-muted">{k}</dt>
                  <dd className="text-right tabular-nums text-fg-strong">{v ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Limitations of this scan" />
          <CardBody>
            <ul className="list-disc space-y-1 pl-5 text-body text-fg">
              {limitationsOf(scan).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
