"use client";

// A change set (design P6 §6.4–6.6): what discovery saw differently between two scans, grouped as text tables,
// with the noise filter on by default and a before/after drawer per page. Screenshots only illustrate; the
// tables carry the change.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, buildQuery, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  CHANGE_STATEMENT,
  DISPLAY_KIND_LABEL,
  GROUPS,
  SIGNIFICANCES,
  SIGNIFICANCE_LABEL,
  cosmeticCount,
  filterItems,
  groupOf,
  journeyLines,
  navigationLines,
  pagesWithChanges,
  partialWarning,
  rebaselineText,
  screenshotAlt,
  showingLine,
  sideText,
  type ChangeFilter,
  type ChangeItem,
  type ChangeSet,
  type DisplayKind,
  type Group,
  type Significance,
  affectedLines,
  nextSteps,
  type ImpactFilter,
  type ImpactItem,
  type Recommendation,
} from "@/lib/change";
import { CircleCheck } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Button, Callout, Card, Checkbox, Disclosure, Drawer, EmptyState, ErrorState, LinkButton, Segmented, SelectField, Skeleton, Table, TabPanel, Tabs, TBody, Td, Th, THead, Tr } from "@/components/ui";
import { ChangeKindLabel, SignificanceLabel, SignificanceLegend } from "@/components/domain/ChangeLabels";
import { HonestyNote } from "@/components/domain/NonFunctionalLabels";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { RemovedEvidence, removedText } from "@/components/domain/RemovedEvidence";
import { RegenerateDialog, requirementsRegenerateCopy } from "@/components/requirements/RegenerateDialog";
import { useProject } from "@/components/workspace/ProjectContext";
import { ChangeSetStatusPill, changeSetHref } from "./Changes";
import { useChangeItems, useChangeSet, useImpact, useRecommendation } from "./hooks";
import { ImpactTab, RegressionTab, TabBody } from "./Impact";
import { RepairList, useRepairs } from "@/components/automation/Repairs";
import { REPAIR_LINE, tabLabel } from "@/lib/repairs";

const RANK: Record<Significance, number> = { structural: 0, behavioural: 1, cosmetic: 2 };

function scanLine(s: ChangeSet["base"]) {
  const bits = [fmtDateTime(s.started_at ?? s.created_at)];
  if (s.g2_approved) bits.push("approved at Gate 2");
  if (s.is_rescan) bits.push("rescan");
  if (s.partial) bits.push("partial");
  return `Scan ${s.number} (${bits.join(", ")})`;
}

export function ChangeSetPage({ chgKey }: { chgKey: string }) {
  const p = useProject();
  const { role } = useAuth();
  const member = role !== "viewer" && role !== null;
  const q = useChangeSet(p.id, chgKey);
  const set = q.data;
  const items = useChangeItems(set);
  const impact = useImpact(set);
  const rec = useRecommendation(set);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "impact" || tabParam === "regression" || tabParam === "repairs" ? tabParam : "what";
  const repairs = useRepairs(p.id, { status: "all", change_set: set?.id }, !!set && set.status === "completed");
  const openRepairs = repairs.data?.counts.open;
  const kindParam = params.get("kind") as ImpactFilter["kind"] | null;
  const setTab = (t: Tab, extra: Record<string, string> = {}) => router.replace(`${pathname}${buildQuery({ tab: t === "what" ? undefined : t, ...extra })}`, { scroll: false });
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);

  useEffect(() => {
    document.title = `${chgKey} · Changes · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [chgKey, p.project?.name]);

  const back = (
    <Link href={`/projects/${p.id}/discovery?view=changes`} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Changes
    </Link>
  );

  if (q.error && !set) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <div className="space-y-4">
          {back}
          <h1 tabIndex={-1} className="text-h1 font-semibold text-fg-strong focus:outline-none">
            {chgKey}
          </h1>
          <EmptyState title={`We couldn’t find ${chgKey} in this project.`} action={<LinkButton href={`/projects/${p.id}/discovery?view=changes`}>Open Changes</LinkButton>} />
        </div>
      );
    return <ErrorState error={q.error} title="Couldn’t load changes." message="Try again." onRetry={() => void q.mutate()} />;
  }
  if (!set)
    return (
      <div className="space-y-4" aria-hidden>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-32" />
      </div>
    );

  async function retry() {
    if (!set) return;
    setBusy(true);
    setRetryError(null);
    try {
      const r = await api<{ change_set: ChangeSet }>(`/projects/${p.id}/changes`, { body: { from_scan_id: set.base.id, to_scan_id: set.target.id } });
      router.push(changeSetHref(p.id, r.change_set.key));
    } catch (e) {
      setRetryError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const by = set.summary.by_significance;
  const total = set.summary.total ?? 0;
  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {set.key} · Scan {set.base.number} → Scan {set.target.number}
          </h1>
          <p className="mt-1 text-small text-fg">
            {scanLine(set.base)} → {scanLine(set.target)} · compared by rules
            {set.started_by ? ` · started by ${set.started_by.full_name || set.started_by.email || "a team member"}` : ""}
          </p>
        </div>
        <ChangeSetStatusPill set={set} />
      </div>
      <HonestyNote>{CHANGE_STATEMENT}</HonestyNote>
      {set.status === "failed" && (
        <Callout
          tone="danger"
          actions={
            member ? (
              <Button variant="secondary" onClick={() => void retry()} loading={busy}>
                Try again
              </Button>
            ) : undefined
          }
        >
          Couldn’t compare Scan {set.base.number} with Scan {set.target.number}: {(set.error ?? "an unexpected error").replace(/\.$/, "")}. Both scans are unchanged.
          {retryError && <span className="mt-1 block">{retryError}</span>}
        </Callout>
      )}
      {(set.status === "queued" || set.status === "running") && (
        <Card className="p-5">
          <h2 className="text-h3 font-semibold text-fg-strong">
            Comparing Scan {set.target.number} with Scan {set.base.number}…
          </h2>
          <p className="mt-1 text-small text-fg">Comparing pages, elements, forms and navigation. This page updates when it’s done.</p>
        </Card>
      )}
      {set.status === "completed" && (
        <>
          {set.rebaseline_suggested && (
            <Callout
              tone="warning"
              actions={
                member ? (
                  <Button variant="secondary" onClick={() => setRegenOpen(true)}>
                    Regenerate requirements…
                  </Button>
                ) : undefined
              }
            >
              {rebaselineText(set)}
            </Callout>
          )}
          {set.ai_summary && (
            <Card className="p-5">
              <p className="text-body text-fg">{set.ai_summary.text}</p>
              <GeneratedByLabel generatedBy="ai" className="mt-2" />
            </Card>
          )}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card className="p-5">
              <h2 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Changes</h2>
              <p className="mt-1 text-h2 font-semibold tabular-nums text-fg-strong">
                {total} change{total === 1 ? "" : "s"}
              </p>
              {by && (
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-fg">
                  {SIGNIFICANCES.map((s) => (
                    <li key={s}>
                      <span className="tabular-nums">{by[s] ?? 0}</span> {s}
                    </li>
                  ))}
                </ul>
              )}
              <GeneratedByLabel generatedBy={set.generated_by} className="mt-3" />
            </Card>
            {set.impact && (
              <Card className="p-5">
                <h2 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Affected</h2>
                <ul className="mt-2 space-y-1 text-small text-fg">
                  {affectedLines(set.impact).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </Card>
            )}
            {set.impact && impact.data?.available && <NextSteps items={impact.data.items} rec={rec.data} member={member} onOpen={setTab} />}
          </div>
          {/* Design P6 §6.4: the existing dialog; the regeneration reads the current scan (Scan n, this rescan). */}
          <RegenerateDialog
            open={regenOpen}
            onClose={() => setRegenOpen(false)}
            projectId={p.id}
            stage="requirements"
            {...requirementsRegenerateCopy({ scanN: set.target.number, documents: 0, protectedCount: 0, rejected: 0 })}
            onStarted={p.refresh}
          />
          <Tabs
            label="Change set"
            idPrefix="chg"
            value={tab}
            onChange={(t) => setTab(t as Tab)}
            tabs={[
              { id: "what", label: `What changed (${total})` },
              { id: "impact", label: impact.data?.available ? `Impact (${impact.data.items.filter((i) => i.status === "open").length} open)` : "Impact" },
              { id: "regression", label: "Regression run" },
              { id: "repairs", label: tabLabel(openRepairs) },
            ]}
          />
          {tab === "what" && (
            <TabPanel id="what" idPrefix="chg">
              <section aria-labelledby="what-changed" className="space-y-4">
                <h2 id="what-changed" className="text-h2 font-semibold text-fg-strong">
                  What changed ({total})
                </h2>
                {items.error && !items.data ? (
                  <ErrorState error={items.error} title="Couldn’t load changes." message="Try again." onRetry={() => void items.mutate()} />
                ) : !items.data ? (
                  <Skeleton className="h-40" />
                ) : (
                  <WhatChanged set={set} items={items.data.items} />
                )}
              </section>
            </TabPanel>
          )}
          {tab === "impact" && (
            <TabPanel id="impact" idPrefix="chg">
              <TabBody q={impact} what="impact">
                {(v) => (
                  <ImpactTab
                    key={kindParam ?? ""}
                    set={set}
                    view={v}
                    initialKind={kindParam ?? ""}
                    onChanged={() => Promise.all([impact.mutate(), rec.mutate(), q.mutate()])}
                    onRegenerate={member ? () => setRegenOpen(true) : undefined}
                  />
                )}
              </TabBody>
            </TabPanel>
          )}
          {tab === "regression" && (
            <TabPanel id="regression" idPrefix="chg">
              <TabBody q={rec} what="the regression run">
                {(r) => <RegressionTab set={set} rec={r} onOpenRepairs={() => setTab("repairs")} />}
              </TabBody>
            </TabPanel>
          )}
          {tab === "repairs" && (
            <TabPanel id="repairs" idPrefix="chg">
              <section aria-labelledby="repairs-title" className="space-y-4">
                <h2 id="repairs-title" className="text-h2 font-semibold text-fg-strong">
                  {tabLabel(openRepairs)}
                </h2>
                <p className="text-body text-fg">{REPAIR_LINE} A person accepts each suggestion; nothing is applied automatically.</p>
                <RepairList
                  projectId={p.id}
                  changeSet={set.id}
                  focusKey={params.get("heal")}
                  onChanged={() => void Promise.all([repairs.mutate(), impact.mutate(), rec.mutate(), q.mutate()])}
                />
              </section>
            </TabPanel>
          )}
        </>
      )}
    </div>
  );
}

type Tab = "what" | "impact" | "regression" | "repairs";

/** The Next steps card (design P6 §6.4): an ordered list; done steps show a tick; viewers get no buttons. */
function NextSteps({ items, rec, member, onOpen }: { items: ImpactItem[]; rec: Recommendation | undefined; member: boolean; onOpen: (t: Tab, extra?: Record<string, string>) => void }) {
  const steps = nextSteps(items, rec);
  return (
    <Card className="p-5 md:col-span-2 lg:col-span-1">
      <h2 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Next steps</h2>
      <ol className="mt-2 space-y-2 text-small text-fg">
        {steps.map((st, n) => (
          <li key={st.text} className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              {st.done ? <CircleCheck className="h-4 w-4 text-success-fg" aria-hidden /> : <span className="tabular-nums text-fg-muted">{n + 1}</span>}
              {st.done && <span className="sr-only">Done: </span>}
              {st.text}
            </span>
            {member && !st.done && (
              <button
                type="button"
                className="min-h-6 font-medium text-navy-700 underline underline-offset-2"
                onClick={() => onOpen(st.tab, st.query ? Object.fromEntries(new URLSearchParams(st.query)) : {})}
              >
                {st.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The "What changed" content (design P6 §6.5): filters, legend, groups as h3 sections, the page drawer. */
export function WhatChanged({ set, items }: { set: ChangeSet; items: ChangeItem[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openPage = params.get("page");
  const [f, setF] = useState<ChangeFilter>({ hideCosmetic: true, kind: "", significance: "", page: "" });
  const others = useMemo(() => filterItems(items, { ...f, hideCosmetic: false }), [items, f]);
  const shown = useMemo(() => filterItems(items, f), [items, f]);
  const hidden = f.hideCosmetic ? cosmeticCount(others) : 0;
  const pages = useMemo(() => pagesWithChanges(items), [items]);
  const warning = partialWarning(set);
  const kinds = useMemo(() => [...new Set(items.map((i) => i.display_kind))] as DisplayKind[], [items]);
  const pageOptions = useMemo(() => [...new Set(items.map((i) => i.page).filter(Boolean) as string[])].sort(), [items]);
  const showing = showingLine(shown.length, items.length);

  const setPage = (page: string | null) => router.replace(`${pathname}${buildQuery({ page })}`, { scroll: false });
  const byGroup = (g: Group) => shown.filter((i) => groupOf(i) === g);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
        <Checkbox label={`Hide cosmetic changes (${hidden} hidden)`} checked={f.hideCosmetic} onChange={(e) => setF({ ...f, hideCosmetic: e.target.checked })} />
        <SelectField
          label="Kind"
          value={f.kind}
          onChange={(e) => setF({ ...f, kind: e.target.value as DisplayKind | "" })}
          options={[{ value: "", label: "Any" }, ...kinds.map((k) => ({ value: k, label: DISPLAY_KIND_LABEL[k] }))]}
          wrapClassName="w-full md:w-48"
        />
        <SelectField
          label="Significance"
          value={f.significance}
          onChange={(e) => setF({ ...f, significance: e.target.value as Significance | "" })}
          options={[{ value: "", label: "Any" }, ...SIGNIFICANCES.map((s) => ({ value: s, label: SIGNIFICANCE_LABEL[s] }))]}
          wrapClassName="w-full md:w-44"
        />
        <SelectField
          label="Page"
          value={f.page}
          onChange={(e) => setF({ ...f, page: e.target.value })}
          options={[{ value: "", label: "Any" }, ...pageOptions.map((x) => ({ value: x, label: x }))]}
          wrapClassName="w-full md:w-56"
        />
      </div>
      <SignificanceLegend />
      {/* A polite live region: a filter change announces the new count (design P6 §6.5). */}
      <p role="status" aria-live="polite" className="text-small text-fg">
        {showing}
      </p>
      {warning && <Callout tone="warning">{warning}</Callout>}

      <PagesGroup set={set} items={byGroup("pages").concat(byGroup("elements"))} onCompare={setPage} />
      <ElementsGroup items={byGroup("elements")} />
      <ListGroup group="navigation" items={byGroup("navigation")} lines={navigationLines} />
      <ListGroup group="journeys" items={byGroup("journeys")} lines={(i) => [`${i.subject.replace(/^Journey (changed|added|removed): /, "")} — ${journeyLines(i).join("; ")}`]} />
      <ListGroup
        group="requirements"
        items={byGroup("requirements")}
        lines={(i) => [i.subject]}
        note={`Requirement changes appear here after requirements are regenerated from Scan ${set.target.number} and applied.`}
      />
      <PageChangeDrawer set={set} items={items} page={openPage && pages.includes(openPage) ? openPage : null} onClose={() => setPage(null)} />
    </div>
  );
}

function GroupHeading({ group, count }: { group: Group; count: number }) {
  const g = GROUPS.find((x) => x.id === group)!;
  return (
    <h3 className="text-h3 font-semibold text-fg-strong">
      {g.title} <span className="font-normal text-fg-muted">({count})</span>
    </h3>
  );
}

function Empty({ group }: { group: Group }) {
  return <p className="text-small text-fg">{GROUPS.find((x) => x.id === group)!.empty}</p>;
}

type PageRow = { page: string; change: string; kind: DisplayKind; significance: Significance };

function pageRows(items: ChangeItem[]): PageRow[] {
  const by = new Map<string, ChangeItem[]>();
  for (const i of items) if (i.page && i.display_kind !== "content_values") by.set(i.page, [...(by.get(i.page) ?? []), i]);
  return [...by.entries()]
    .map(([page, xs]) => {
      const sig = xs.map((x) => x.significance).sort((a, b) => RANK[a] - RANK[b])[0];
      const added = xs.find((x) => x.kind === "page_added");
      const removed = xs.find((x) => x.kind === "page_removed");
      if (added) return { page, change: "Page added", kind: "added" as const, significance: sig };
      if (removed) return { page, change: "Page removed", kind: "removed" as const, significance: sig };
      return { page, change: `Changed: ${xs.length} change${xs.length === 1 ? "" : "s"}`, kind: "changed" as const, significance: sig };
    })
    .sort((a, b) => a.page.localeCompare(b.page));
}

function PagesGroup({ set, items, onCompare }: { set: ChangeSet; items: ChangeItem[]; onCompare: (page: string) => void }) {
  const rows = pageRows(items);
  const values = items.filter((i) => i.display_kind === "content_values");
  const count = rows.length + values.length + set.not_compared.length;
  const button = (page: string) => (
    <Button variant="secondary" size="sm" onClick={() => onCompare(page)}>
      Compare {page}
    </Button>
  );
  return (
    <section className="space-y-3">
      <GroupHeading group="pages" count={count} />
      {rows.length === 0 && values.length === 0 && set.not_compared.length === 0 ? (
        <Empty group="pages" />
      ) : (
        <>
          {rows.length > 0 && (
            <>
              <div className="hidden md:block">
                <Table label="Pages">
                  <THead>
                    <tr>
                      <Th>Page</Th>
                      <Th>Change</Th>
                      <Th>Significance</Th>
                      <Th srOnly>Before and after</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {rows.map((r) => (
                      <Tr key={r.page}>
                        <Td rowHeader>
                          <span className="break-all">{r.page}</span>
                        </Td>
                        <Td>
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <ChangeKindLabel kind={r.kind} />
                            {r.kind === "changed" ? <span>{r.change.replace("Changed: ", "")}</span> : null}
                          </span>
                        </Td>
                        <Td>
                          <SignificanceLabel significance={r.significance} />
                        </Td>
                        <Td>{button(r.page)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
              <ul className="space-y-2 md:hidden" aria-label="Pages">
                {rows.map((r) => (
                  <li key={r.page} className="space-y-2 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
                    <p className="break-all font-medium text-fg-strong">{r.page}</p>
                    <p className="flex flex-wrap items-center gap-2">
                      {r.change} <SignificanceLabel significance={r.significance} />
                    </p>
                    {button(r.page)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {values.map((v) => {
            const b = ((v.before?.values as string[]) ?? []).map(String);
            const a = ((v.after?.values as string[]) ?? []).map(String);
            return (
              <div key={v.id} className="rounded-lg bg-surface p-3 ring-1 ring-line">
                <p className="flex flex-wrap items-center gap-2 text-small text-fg">
                  <ChangeKindLabel kind="content_values" />
                  <span>
                    Content values changed on <span className="break-all">{v.page}</span> ({a.length}): prices or counts
                  </span>
                  <SignificanceLabel significance={v.significance} />
                </p>
                <Disclosure label="Show values" openLabel="Hide values" className="mt-2">
                  <ul className="space-y-1 text-small">
                    {a.map((x, i) => (
                      <li key={i}>
                        <del className="line-through decoration-2">
                          <span className="sr-only">Before: </span>
                          {b[i]}
                        </del>{" "}
                        →{" "}
                        <ins className="underline decoration-2 underline-offset-2">
                          <span className="sr-only">After: </span>
                          {x}
                        </ins>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              </div>
            );
          })}
          {set.not_compared.length > 0 && (
            <ul className="space-y-1 text-small text-fg" aria-label="Pages not compared">
              {set.not_compared.map((n) => (
                <li key={n.page}>
                  <span className="break-all font-medium text-fg-strong">{n.page}</span> · Not compared: {n.reason.replace(/\.$/, "")}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Before({ item }: { item: ChangeItem }) {
  if (!item.before) return <span aria-label="Before: nothing">—</span>;
  const struck = !item.after || item.kind === "element_renamed";
  const text = sideText(item, item.before);
  return struck ? (
    <del className="line-through decoration-2">
      <span className="sr-only">Before: </span>
      {text}
    </del>
  ) : (
    <span>
      <span className="sr-only">Before: </span>
      {text}
    </span>
  );
}

function After({ item }: { item: ChangeItem }) {
  if (!item.after) return <span aria-label="After: nothing">—</span>;
  const marked = !item.before || item.kind === "element_renamed";
  const text = sideText(item, item.after);
  return marked ? (
    <ins className="underline decoration-2 underline-offset-2">
      <span className="sr-only">After: </span>
      {text}
    </ins>
  ) : (
    <span>
      <span className="sr-only">After: </span>
      {text}
    </span>
  );
}

function ChangeTable({ items, label, withPage = true }: { items: ChangeItem[]; label: string; withPage?: boolean }) {
  return (
    <>
      <div className="hidden md:block">
        <Table label={label}>
          <THead>
            <tr>
              {withPage && <Th>Page</Th>}
              <Th>What</Th>
              <Th>Before</Th>
              <Th>After</Th>
              <Th>Significance</Th>
            </tr>
          </THead>
          <TBody>
            {items.map((i) => (
              <Tr key={i.id}>
                {withPage && (
                  <Td>
                    <span className="break-all">{i.page}</span>
                  </Td>
                )}
                <Td rowHeader className="whitespace-normal">
                  {i.subject}
                </Td>
                <Td className="break-words">
                  <Before item={i} />
                </Td>
                <Td className="break-words">
                  <After item={i} />
                </Td>
                <Td>
                  <SignificanceLabel significance={i.significance} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label={label}>
        {items.map((i) => (
          <li key={i.id} className="space-y-1 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
            <p className="break-words font-medium text-fg-strong">
              {withPage && i.page ? <span className="break-all">{i.page} · </span> : null}
              {i.subject}
            </p>
            <p className="break-words">
              <span aria-hidden>Before: </span>
              <Before item={i} />
            </p>
            <p className="break-words">
              <span aria-hidden>After: </span>
              <After item={i} />
            </p>
            <SignificanceLabel significance={i.significance} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ElementsGroup({ items }: { items: ChangeItem[] }) {
  return (
    <section className="space-y-3">
      <GroupHeading group="elements" count={items.length} />
      {items.length === 0 ? <Empty group="elements" /> : <ChangeTable items={items} label="Elements and form fields" />}
    </section>
  );
}

function ListGroup({ group, items, lines, note }: { group: Group; items: ChangeItem[]; lines: (i: ChangeItem) => string[]; note?: string }) {
  return (
    <section className="space-y-3">
      <GroupHeading group={group} count={items.length} />
      {items.length === 0 ? (
        <>
          <Empty group={group} />
          {note && <p className="text-small text-fg-muted">{note}</p>}
        </>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start gap-2 text-small text-fg">
              <ChangeKindLabel kind={i.display_kind} />
              <span className="min-w-0 flex-1 break-words">
                {lines(i).map((l, n) => (
                  <span key={n} className="block">
                    {l}
                  </span>
                ))}
              </span>
              <SignificanceLabel significance={i.significance} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

type View = "side" | "before" | "after";

/** Before/after for one page (design P6 §6.6). The Drawer returns focus to the row's [Compare …] button. */
export function PageChangeDrawer({ set, items, page, onClose }: { set: ChangeSet; items: ChangeItem[]; page: string | null; onClose: () => void }) {
  const wide = useWide();
  const [view, setView] = useState<View>("side");
  const mine = useMemo(() => items.filter((i) => i.page === page && groupOf(i) !== "journeys"), [items, page]);
  const effective: View = !wide && view === "side" ? "before" : view;
  if (!page) return null;
  const added = mine.some((i) => i.kind === "page_added");
  const removed = mine.some((i) => i.kind === "page_removed");
  const sig = mine.map((x) => x.significance).sort((a, b) => RANK[a] - RANK[b])[0];
  const beforeShot = mine.find((i) => i.before_ref?.screenshot)?.before_ref?.screenshot ?? null;
  const afterShot = mine.find((i) => i.after_ref?.screenshot)?.after_ref?.screenshot ?? null;
  const date = (s: ChangeSet["base"]) => fmtDate(s.started_at ?? s.created_at);
  const state = added ? "Page added" : removed ? "Page removed" : `Changed (${mine.length} change${mine.length === 1 ? "" : "s"})`;
  const options = [...(wide ? [{ value: "side" as View, label: "Side by side" }] : []), { value: "before" as View, label: "Before" }, { value: "after" as View, label: "After" }];

  const panel = (side: "Before" | "After") => {
    const scan = side === "Before" ? set.base : set.target;
    const shot = side === "Before" ? beforeShot : afterShot;
    let body: React.ReactNode;
    if (side === "Before" && added) body = <RemovedEvidence text={`Not in Scan ${scan.number}: this page is new.`} />;
    else if (side === "After" && removed) body = <RemovedEvidence text={`Not in Scan ${scan.number}: discovery didn't find this page.`} />;
    else if (shot && removedText(shot)) body = <RemovedEvidence text={removedText(shot)!} />;
    else if (shot)
      body = (
        <a href={shot.content_url} target="_blank" rel="noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived evidence URL */}
          <img src={shot.content_url} alt={screenshotAlt(side, page, scan.number, date(scan))} className="max-h-[28rem] w-full bg-white object-contain object-top ring-1 ring-line" />
          <span className="mt-1 block text-small text-navy-700 underline underline-offset-2">Open full size</span>
        </a>
      );
    else body = <RemovedEvidence text={`No screenshot was recorded for this page in Scan ${scan.number}.`} />;
    return (
      <figure className="min-w-0 space-y-2">
        <figcaption className="text-small font-semibold text-fg-strong">
          {side} · Scan {scan.number} · {date(scan)}
        </figcaption>
        {body}
      </figure>
    );
  };

  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={<span className="break-all">{page}</span>}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-2">
          {state} {sig && <SignificanceLabel significance={sig} />}
        </span>
      }
    >
      <div className="space-y-5">
        <Segmented label="View" options={options} value={effective} onChange={setView} />
        <div className={effective === "side" ? "grid grid-cols-2 gap-4" : ""}>
          {(effective === "side" || effective === "before") && panel("Before")}
          {(effective === "side" || effective === "after") && panel("After")}
        </div>
        <section className="space-y-2">
          <h3 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Changes on this page</h3>
          <ChangeTable items={mine} label={`Changes on ${page}`} withPage={false} />
        </section>
        <p className="text-small text-fg-muted">
          How elements are matched: same page, then same element fingerprint, then same role and selector (a rename), then same role and name (a move). An element that was both
          renamed and moved shows as removed and added.
        </p>
      </div>
    </Drawer>
  );
}
