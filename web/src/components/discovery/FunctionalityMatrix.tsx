"use client";

import { useMemo, useState } from "react";
import { Lock } from "lucide-react";
import type { Feature, PageDetail, PageSummary } from "@/lib/contract";
import { componentColumn, matrixColumns, normaliseCounts, COMPONENT_TYPES } from "@/lib/discovery";
import { pathOf } from "@/lib/url";
import { Badge, Button, Card, CardHeader, Drawer, EmptyState, Spinner, TextField } from "@/components/ui";
import { GeneratedByLabel, LabelsHelp, ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems, refsToItems } from "@/components/domain/EvidenceDrawer";
import { usePageDetail } from "./hooks";

type Cell = { pageId: string; type: string };

function typeLabel(key: string) {
  return COMPONENT_TYPES.find((c) => c.key === key) ?? { key, label: key, singular: key };
}

/** Findings for one cell: forms/inputs from page.forms, everything else from page.components. */
function FindingsList({ cell, page }: { cell: Cell; page: PageSummary }) {
  const { data, error } = usePageDetail(cell.pageId);
  if (error) return <p className="text-body text-danger-fg">Couldn’t load findings for this page.</p>;
  if (!data) return <Spinner label="Loading findings…" />;
  const t = typeLabel(cell.type);
  const evidence = linksToItems([data.screenshot, ...data.evidence.filter((e) => /dom|html/.test(e.kind))]);
  const path = pathOf(page.url);
  const rows = findingRows(data, cell.type);
  return (
    <section aria-labelledby="findings-title" className="space-y-3">
      <h3 id="findings-title" className="text-h3 font-semibold text-fg-strong">
        {t.label} on <span className="font-mono">{path}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-body text-fg-muted">The page counts {t.label.toLowerCase()} but no item details were recorded.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {rows.map((r, i) => (
            <li key={i} className="space-y-1 px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-body font-semibold text-fg-strong">
                {r.title} <ObservationLabel provenance="observed" />
              </p>
              {r.detail && <p className="text-small text-fg">{r.detail}</p>}
              <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
                <EvidenceLinks items={evidence} subject={r.title} /> · <span className="font-mono">{path}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function findingRows(page: PageDetail, type: string): { title: string; detail?: string }[] {
  if (type === "forms")
    return page.forms.map((f) => ({
      title: `Form · ${f.name || f.purpose_guess || "Unnamed"}`,
      detail: `${f.fields.length} field${f.fields.length === 1 ? "" : "s"}: ${f.fields
        .map((x) => `${x.label || x.name} (${x.type}${x.required ? ", required" : ""})`)
        .join(", ")}.${f.submit_label ? ` Submit button “${f.submit_label}”.` : ""} Not submitted.`,
    }));
  if (type === "inputs")
    return page.forms.flatMap((f) =>
      f.fields.map((x) => ({
        title: `Input · ${x.label || x.name}`,
        detail: `${x.type}${x.required ? ", required" : ""}${x.constraints?.maxlength ? `, max length ${x.constraints.maxlength}` : ""} · in ${f.name || "form"}`,
      })),
    );
  return page.components
    .filter((c) => componentColumn(c.kind) === type)
    .map((c) => ({ title: `${typeLabel(componentColumn(c.kind)).singular.replace(/^./, (m) => m.toUpperCase())} · ${c.name || c.role || c.kind}`, detail: c.locator }));
}

function FeatureDrawer({ feature, pages, onClose }: { feature: Feature | null; pages: Map<string, PageSummary>; onClose: () => void }) {
  return (
    <Drawer open={!!feature} onClose={onClose} title={feature?.name ?? "Feature"} subtitle={feature && <span className="font-mono">{feature.key}</span>}>
      {feature && (
        <div className="space-y-5">
          <p className="flex flex-wrap items-center gap-2">
            <ObservationLabel provenance={feature.provenance} confidence={feature.confidence} />
            <GeneratedByLabel generatedBy={feature.generated_by} />
            <Badge>{feature.category.replace(/_/g, " ")}</Badge>
          </p>
          <p className="text-body text-fg">{feature.description}</p>
          {feature.provenance === "inferred" && (
            <p className="text-small text-fg-muted">Why inferred: concluded from what the browser saw; discovery is read-only, so this was not exercised.</p>
          )}
          <section>
            <h3 className="text-h3 font-semibold text-fg-strong">Pages</h3>
            <ul className="mt-1 space-y-0.5 text-small">
              {feature.page_ids.map((id) => {
                const p = pages.get(id);
                return (
                  <li key={id} className="font-mono text-fg">
                    {p ? pathOf(p.url) : id}
                  </li>
                );
              })}
            </ul>
          </section>
          <section>
            <h3 className="text-h3 font-semibold text-fg-strong">Evidence</h3>
            {feature.evidence_refs.length === 0 ? (
              <p className="mt-1 text-body text-fg-muted">Evidence missing</p>
            ) : (
              <ul className="mt-2 space-y-3">
                {feature.evidence_refs.map((r, i) => (
                  <li key={`${r.evidence_id}-${i}`} className="rounded-md border border-line p-3 text-small">
                    {r.selector && <p className="break-all font-mono text-fg-strong">{r.selector}</p>}
                    {r.excerpt && <p className="mt-1 whitespace-pre-wrap break-words font-mono text-fg">{r.excerpt}</p>}
                    {r.note && <p className="mt-1 text-fg">{r.note}</p>}
                    <EvidenceLinks items={refsToItems([r])} subject={feature.name} className="mt-2" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

/** Features catalogued by the agent, each with provenance, confidence and evidence (P1-15). */
export function FeatureList({ features, pages }: { features: Feature[]; pages: PageSummary[] }) {
  const [open, setOpen] = useState<Feature | null>(null);
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  return (
    <Card>
      <CardHeader title={`Features (${features.length})`} description="Functionality the agent identified across pages. Open one to see its evidence." />
      {features.length === 0 ? (
        <EmptyState title="No features identified." description="Features need at least one page with interactive components." />
      ) : (
        <ul className="divide-y divide-line">
          {features.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
              <button type="button" onClick={() => setOpen(f)} className="min-w-0 text-left text-body font-semibold text-navy-700 underline underline-offset-2">
                {f.name}
              </button>
              <ObservationLabel provenance={f.provenance} confidence={f.confidence} />
              <GeneratedByLabel generatedBy={f.generated_by} />
              <span className="text-small text-fg-muted">
                {f.category.replace(/_/g, " ")} · {f.page_ids.length} page{f.page_ids.length === 1 ? "" : "s"}
              </span>
              <span className="ml-auto">
                <EvidenceLinks items={refsToItems(f.evidence_refs)} subject={f.name} />
              </span>
              <p className="w-full text-small text-fg">{f.description}</p>
            </li>
          ))}
        </ul>
      )}
      <FeatureDrawer feature={open} pages={byId} onClose={() => setOpen(null)} />
    </Card>
  );
}

/** Pages × component types (design spec §8.2). Below md it becomes per-page cards. */
export function FunctionalityMatrix({ pages }: { pages: PageSummary[] }) {
  const [cell, setCell] = useState<Cell | null>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const allCols = useMemo(() => matrixColumns(pages), [pages]);
  const cols = typeFilter === "all" ? allCols : allCols.filter((c) => c.key === typeFilter);
  const rows = pages.filter((p) => !q || `${p.url} ${p.title}`.toLowerCase().includes(q.toLowerCase()));
  const cellPage = cell ? pages.find((p) => p.id === cell.pageId) : undefined;

  if (pages.length === 0) return <EmptyState title="No pages yet" description="The functionality map fills in as pages are visited." />;

  const cellButton = (p: PageSummary, key: string, n: number) => {
    const t = typeLabel(key);
    const selected = cell?.pageId === p.id && cell.type === key;
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => setCell(selected ? null : { pageId: p.id, type: key })}
        className={`min-h-6 min-w-8 rounded-sm px-1.5 tabular-nums underline underline-offset-2 ${selected ? "bg-accent text-on-accent" : "text-navy-700 hover:bg-overlay"}`}
      >
        {n}
        <span className="sr-only">
          {" "}
          {n === 1 ? t.singular : t.label.toLowerCase()} on {pathOf(p.url)}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-small text-fg-strong">
          <span className="mb-1 block font-medium">Type</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="h-10 rounded-md bg-surface px-2 text-body ring-1 ring-inset ring-line-input">
            <option value="all">All types</option>
            {allCols.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <TextField label="Search pages" type="search" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="w-full sm:w-64" />
        <div className="sm:ml-auto">
          <LabelsHelp />
        </div>
      </div>

      {/* md+: matrix with sticky first column and header */}
      <div className="relative hidden overflow-x-auto rounded-lg border border-line bg-surface md:block" tabIndex={0} role="region" aria-label="Functionality map">
        <table className="min-w-full text-small">
          <caption className="sr-only">Interactive components found per page. A dash means none found; a lock means the page needs credentials.</caption>
          <thead className="sticky top-0 bg-elevated">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-elevated px-3 py-2 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                Page
              </th>
              {cols.map((c) => (
                <th key={c.key} scope="col" className="whitespace-nowrap px-3 py-2 text-right text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => {
              const counts = normaliseCounts(p.counts);
              return (
                <tr key={p.id} className="hover:bg-overlay">
                  <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-normal">
                    <span className="block font-mono text-fg-strong">{pathOf(p.url)}</span>
                    <span className="block max-w-[16rem] truncate text-caption text-fg-muted">{p.title}</span>
                  </th>
                  {cols.map((c) => {
                    const n = counts[c.key] ?? 0;
                    return (
                      <td key={c.key} className="px-3 py-2 text-right">
                        {p.requires_auth && n === 0 ? (
                          <>
                            <Lock className="ml-auto h-3.5 w-3.5 text-warning-fg" aria-hidden />
                            <span className="sr-only">not observed: needs credentials</span>
                          </>
                        ) : n > 0 ? (
                          cellButton(p, c.key, n)
                        ) : (
                          <>
                            <span aria-hidden className="text-fg-muted">
                              –
                            </span>
                            <span className="sr-only">none found</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* below md: per-page cards with count chips */}
      <ul className="space-y-3 md:hidden">
        {rows.map((p) => {
          const counts = normaliseCounts(p.counts);
          const present = cols.filter((c) => (counts[c.key] ?? 0) > 0);
          return (
            <li key={p.id} className="rounded-lg border border-line bg-surface p-3">
              <p className="break-all font-mono text-small text-fg-strong">{pathOf(p.url)}</p>
              <p className="truncate text-caption text-fg-muted">{p.title}</p>
              <p className="mt-2 flex flex-wrap gap-2 text-small">
                {p.requires_auth && present.length === 0 ? (
                  <span className="text-warning-fg">Needs credentials: not observed</span>
                ) : present.length === 0 ? (
                  <span className="text-fg-muted">No interactive components found</span>
                ) : (
                  present.map((c) => (
                    <span key={c.key} className="inline-flex items-center gap-1 rounded-sm bg-overlay px-1.5">
                      {c.label} {cellButton(p, c.key, counts[c.key])}
                    </span>
                  ))
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {cell && cellPage && (
        <Card className="p-5">
          <FindingsList cell={cell} page={cellPage} />
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setCell(null)}>
            Clear selection
          </Button>
        </Card>
      )}
    </div>
  );
}
