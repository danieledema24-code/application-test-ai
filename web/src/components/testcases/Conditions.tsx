"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CircleHelp, Info, Lock, LockOpen, MoreHorizontal } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { EvidenceRef, Revision, TestCaseStats, TestCaseSummary, TestCondition, TestDataItem } from "@/lib/contract";
import { CASE_STATUS_TEXT, caseTypeText, coverageItemText, openQuestionMessage, techniqueInfo } from "@/lib/testcases";
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, InlineError, Segmented, Skeleton, StatTile, StatusPill, TextArea, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, refsToItems } from "@/components/domain/EvidenceDrawer";
import { RevisionHistory } from "@/components/domain/RevisionHistory";
import { TechniqueChip, ValueText } from "./Bits";

type ValueRow = { coverage_item?: string; value?: string | null; length?: number | null; tests?: string; expected?: string | null; case_keys?: string[] };

/**
 * Coverage rows for a condition: one per coverage item, joined with the design basis values (assumed shape
 * `design_basis.values[]`), the test data that tests it and the cases that cover it.
 */
export function coverageRows(c: TestCondition, cases: Map<string, TestCaseSummary>, data: TestDataItem[]) {
  const values = (Array.isArray(c.design_basis?.values) ? (c.design_basis.values as ValueRow[]) : []) ?? [];
  return (c.coverage_items ?? []).map((item) => {
    const v = values.find((x) => x.coverage_item === item.id);
    const td = data.find((d) => d.boundary?.coverage_item === item.id && d.boundary?.condition?.key === c.key);
    const covered = (item.covered_by ?? []).map((k) => cases.get(k) ?? null).filter((x): x is TestCaseSummary => !!x);
    return {
      id: item.id,
      // null = no value to show (no item, or a saved login); "" is a real empty-value boundary.
      value: v && typeof v.value === "string" ? v.value : null,
      label: coverageItemText({ coverage_item: item.id, coverage_item_label: td?.boundary?.coverage_item_label ?? item.label }),
      tests: v?.tests ?? item.label,
      expected: v?.expected ?? null,
      data: td ?? null,
      caseKeys: item.covered_by ?? v?.case_keys ?? [],
      cases: covered,
    };
  });
}

function constraintOf(c: TestCondition): { text: string | null; refs: EvidenceRef[] } {
  const b = c.design_basis ?? {};
  const text = typeof b.constraint === "string" ? b.constraint : c.acceptance_criteria?.length && b.source === "acceptance_criterion" ? `test values from ${c.acceptance_criteria.map((a) => a.key).join(", ")}` : null;
  // As built the API sends `evidence_refs` beside `design_basis`; earlier drafts nested it. Read either.
  const top = (c as { evidence_refs?: unknown }).evidence_refs;
  const refs = Array.isArray(b.evidence_refs) ? (b.evidence_refs as EvidenceRef[]) : Array.isArray(top) ? (top as EvidenceRef[]) : [];
  return { text, refs };
}

function ConditionCard({
  c,
  cases,
  data,
  projectId,
  canEdit,
  onOpenData,
  onChanged,
}: {
  c: TestCondition;
  cases: Map<string, TestCaseSummary>;
  data: TestDataItem[];
  projectId: string;
  canEdit: boolean;
  onOpenData: (key: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const rows = coverageRows(c, cases, data);
  const covered = rows.filter((r) => r.caseKeys.length > 0).length;
  const { text: constraint, refs } = constraintOf(c);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(c.description ?? "");
  const [notes, setNotes] = useState((c.notes ?? []).join("\n"));
  const [rejecting, setRejecting] = useState(false);
  const [menu, setMenu] = useState(false);
  const [history, setHistory] = useState<Revision[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drafts = [...cases.values()].filter((x) => x.condition_key === c.key && x.status === "draft");
  const draftKeys = drafts.length ? drafts.map((d) => d.key) : rows.flatMap((r) => r.cases.filter((x) => x.status === "draft").map((x) => x.key));
  const uniqueDrafts = [...new Set(draftKeys)];
  const technique = techniqueInfo(c.technique);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { version: c.version };
      if (description.trim() !== (c.description ?? "").trim()) body.description = description.trim();
      const n = notes
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      if (JSON.stringify(n) !== JSON.stringify(c.notes ?? [])) body.notes = n;
      if (Object.keys(body).length > 1) await api(`/test-conditions/${c.id}`, { method: "PATCH", body });
      setEditing(false);
      toast(`${c.key} saved.`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? `Someone else changed ${c.key}. Reload to see their version; your text is still here.` : `Couldn’t save ${c.key}. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await api(`/test-conditions/${c.id}/status`, { body: { version: c.version, status: "rejected", comment: "Rejected from the Conditions tab" } });
      setRejecting(false);
      toast(`${c.key} rejected${uniqueDrafts.length ? ` with ${uniqueDrafts.length} draft${uniqueDrafts.length === 1 ? "" : "s"}` : ""}.`);
      onChanged();
    } catch (err) {
      setError(`Couldn’t reject ${c.key}. ${errorMessage(err)}`);
      setRejecting(false);
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setMenu(false);
    try {
      await api(`/test-conditions/${c.id}/lock`, { body: { version: c.version, locked: !c.locked } });
      toast(`${c.key} ${c.locked ? "unlocked" : "locked"}.`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openHistory() {
    setMenu(false);
    try {
      setHistory(await api<Revision[]>(`/test-conditions/${c.id}/revisions`));
    } catch (err) {
      setError(`Couldn’t load the history of ${c.key}. ${errorMessage(err)}`);
    }
  }

  return (
    <Card as="article" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words text-body-lg font-semibold text-fg-strong">
          <span className="font-mono">{c.key}</span> · {c.title}
        </h3>
        <span className="flex flex-wrap items-center gap-1.5">
          <TechniqueChip technique={c.technique} />
          <StatusPill status={c.status} label={c.status === "draft" ? "Draft" : c.status === "approved" ? "Approved" : "Rejected"} tone={c.status === "draft" ? "grey" : undefined} />
          {c.locked && (
            <span className="inline-flex items-center text-fg-muted">
              <Lock className="h-4 w-4" aria-hidden />
              <span className="sr-only">Locked</span>
            </span>
          )}
          <GeneratedByLabel generatedBy={c.generated_by} />
        </span>
      </div>
      <div className="mt-2 space-y-1.5 text-body text-fg">
        {c.description && (
          <p>
            <span className="font-semibold text-fg-strong">Why:</span> {c.description}
          </p>
        )}
        <p className="flex flex-wrap items-center gap-x-2">
          <span className="font-semibold text-fg-strong">Constraint:</span>
          {constraint ? <span>{constraint}</span> : <span className="text-fg-muted">{["boundary_value_analysis", "equivalence_partitioning"].includes(c.technique) ? "Not recorded" : "None"}</span>}
          {refs.length > 0 && <EvidenceLinks items={refsToItems(refs)} subject={`${c.key} ${c.title}`} />}
          {(c.acceptance_criteria ?? []).map((a) => (
            <span key={a.key} className="font-mono text-small">
              {a.key}
            </span>
          ))}
        </p>
        <p className="text-small text-fg-muted">
          {caseTypeText(c.test_type)}
          {c.requirements?.length ? ` · ${c.requirements.map((r) => r.key).join(", ")}` : ""}
        </p>
      </div>
      {c.open_question && (
        <p className="mt-2 flex flex-wrap items-center gap-1 text-body text-warning-fg">
          <CircleHelp className="h-4 w-4" aria-hidden />
          Expected result not decided: {openQuestionMessage(c.open_question.message)}{" "}
          {c.open_question.requirement?.key && (
            <Link href={`/projects/${projectId}/requirements/${c.open_question.requirement.key}`} className="font-medium underline underline-offset-2">
              Open {c.open_question.requirement.key}
            </Link>
          )}
        </p>
      )}
      <div className="mt-3">
        <p className="text-body font-semibold text-fg-strong">
          Coverage items ({covered} of {rows.length} have a case)
        </p>
        {rows.length > 0 && (
          <div className="scrollbar-thin mt-1 overflow-x-auto" role="region" aria-label={`Coverage items for ${c.key}`} tabIndex={0}>
            <table className="min-w-full divide-y divide-line text-small">
              <caption className="sr-only">Coverage items for {c.key}</caption>
              <thead>
                <tr>
                  {["Value", "What it tests", "Expected", "Test data", "Test case"].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap px-2 py-1.5 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" className="px-2 py-1.5 text-left font-normal">
                      {r.value !== null ? <ValueText value={r.value} /> : <span className="text-fg">{r.label}</span>}
                      {constraint && <span className="block text-caption text-fg-muted">Constraint: {constraint}</span>}
                    </th>
                    <td className="px-2 py-1.5">{r.tests}</td>
                    <td className="px-2 py-1.5">{r.expected ?? <span className="text-fg-muted">See the case</span>}</td>
                    <td className="px-2 py-1.5">
                      {r.data ? (
                        <button type="button" onClick={() => onOpenData(r.data!.key)} className="font-mono text-navy-700 underline underline-offset-2" aria-label={`Open test data ${r.data.key} (${r.label})`}>
                          {r.data.key}
                        </button>
                      ) : (
                        <span className="text-fg-muted">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.caseKeys.length ? (
                        <span className="flex flex-wrap gap-x-2">
                          {r.caseKeys.map((k) => {
                            const tc = cases.get(k);
                            return (
                              <Link key={k} href={`/projects/${projectId}/test-cases/${k}`} className="whitespace-nowrap text-navy-700 underline underline-offset-2" aria-label={`${k}${tc ? `, ${CASE_STATUS_TEXT[tc.status]}` : ""} (covers ${r.label} in ${c.key})`}>
                                <span className="font-mono">{k}</span>
                                {tc ? ` ${CASE_STATUS_TEXT[tc.status]}` : ""}
                              </Link>
                            );
                          })}
                        </span>
                      ) : (
                        <span className="text-warning-fg">No case</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {(c.notes ?? []).map((n) => (
        <p key={n} className="mt-2 flex items-start gap-1.5 text-small text-fg">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info-fg" aria-hidden />
          {n}
        </p>
      ))}
      <div className="mt-3">
        <InlineError error={error} />
      </div>
      {editing ? (
        <div className="mt-3 space-y-3">
          <TextArea label="Why (description)" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          <TextArea label="Notes" hint="One note per line. Values are calculated from the constraint. To change them, change the requirement or the case." rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} loading={busy}>
              Save notes
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {canEdit && c.status !== "rejected" && !c.locked && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} aria-label={`Edit notes for ${c.key}`}>
              Edit notes
            </Button>
          )}
          {canEdit && c.status !== "rejected" && (
            <Button size="sm" variant="secondary" onClick={() => setRejecting(true)} aria-label={`Reject ${c.key}…`}>
              Reject…
            </Button>
          )}
          <span className="relative">
            <Button size="sm" variant="ghost" aria-label={`More actions for ${c.key}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
            {menu && (
              <span className="absolute right-0 z-30 mt-1 flex w-56 flex-col rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
                {canEdit && (
                  <button type="button" onClick={() => void lock()} className="flex min-h-10 items-center gap-2 px-4 text-left text-body text-fg-strong hover:bg-overlay">
                    {c.locked ? <LockOpen className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />} {c.locked ? "Unlock" : "Lock"}
                  </button>
                )}
                <button type="button" onClick={() => void openHistory()} className="flex min-h-10 items-center px-4 text-left text-body text-fg-strong hover:bg-overlay">
                  History
                </button>
                <Link href={`/projects/${projectId}/traceability/${c.key}`} className="flex min-h-10 items-center px-4 text-body text-fg-strong hover:bg-overlay">
                  Trace {c.key}
                </Link>
              </span>
            )}
          </span>
        </div>
      )}
      <ConfirmDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={`Reject ${c.key}?`}
        danger
        loading={busy}
        confirmLabel={uniqueDrafts.length ? `Reject condition and ${uniqueDrafts.length} draft${uniqueDrafts.length === 1 ? "" : "s"}` : "Reject condition"}
        onConfirm={() => void reject()}
      >
        <p>
          {uniqueDrafts.length
            ? `Rejecting ${c.key} also rejects its ${uniqueDrafts.length} draft test case${uniqueDrafts.length === 1 ? "" : "s"}: ${uniqueDrafts.join(", ")}. Approved cases are kept.`
            : `Rejecting ${c.key} rejects no test cases. Approved cases are kept.`}
        </p>
      </ConfirmDialog>
      {history && <RevisionHistory open onClose={() => setHistory(null)} title={`History of ${c.key}`} revisions={history} canRestore={false} />}
      <span className="sr-only">{technique.name}</span>
    </Card>
  );
}

type GroupBy = "feature" | "requirement" | "technique";

/** Conditions tab (design P3 §7): the test design results, grouped, with coverage tables and constraints. */
export function ConditionsTab({
  projectId,
  conditions,
  error,
  cases,
  data,
  stats,
  canEdit,
  onOpenData,
  onChanged,
  onRegenerate,
  listHref,
}: {
  projectId: string;
  conditions: TestCondition[] | undefined;
  error: unknown;
  cases: TestCaseSummary[];
  data: TestDataItem[];
  stats: TestCaseStats | undefined;
  canEdit: boolean;
  onOpenData: (key: string) => void;
  onChanged: () => void;
  onRegenerate?: () => void;
  listHref: (q: Record<string, string>) => string;
}) {
  const [group, setGroup] = useState<GroupBy>("feature");
  const caseMap = useMemo(() => new Map(cases.map((c) => [c.key, c])), [cases]);
  if (error && !conditions) return <ErrorState error={error} title="Couldn’t load test conditions." message="Try again." onRetry={onChanged} />;
  if (!conditions)
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
        <span className="sr-only" role="status">
          Loading test conditions…
        </span>
      </div>
    );
  const live = conditions.filter((c) => c.status !== "rejected");
  if (!live.length)
    return (
      <EmptyState
        title="No test conditions. Regenerate to design them again."
        action={
          canEdit && onRegenerate ? (
            <Button variant="secondary" onClick={onRegenerate}>
              Regenerate…
            </Button>
          ) : undefined
        }
      />
    );
  const complete = live.filter((c) => (c.coverage_items ?? []).length > 0 && c.coverage_items.every((i) => (i.covered_by ?? []).length > 0)).length;
  const groups = new Map<string, { title: string; conds: TestCondition[] }>();
  for (const c of live) {
    const keys =
      group === "feature"
        ? [[c.feature?.key ?? "none", c.feature ? `Feature · ${c.feature.label}` : "No feature"]]
        : group === "technique"
          ? [[c.technique, techniqueInfo(c.technique).name]]
          : c.requirements?.length
            ? c.requirements.map((r) => [r.key, `${r.key} ${r.label}`])
            : [["none", "Not linked to a requirement"]];
    for (const [k, title] of keys) {
      const g = groups.get(k) ?? { title, conds: [] };
      g.conds.push(c);
      groups.set(k, g);
    }
  }
  const byTech = Object.entries(stats?.by_technique ?? {}).filter(([, n]) => n > 0);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {byTech.map(([t, n]) => (
          <StatTile key={t} size="sm" label={`${techniqueInfo(t).short === "—" ? techniqueInfo(t).name : techniqueInfo(t).short} cases`} value={n} href={listHref({ technique: t })} hint={techniqueInfo(t).name} />
        ))}
        <StatTile size="sm" label="Technique coverage" value={`${complete} of ${live.length}`} hint="conditions complete" />
        {stats?.not_designed?.length ? <StatTile size="sm" label="Not designed" value={`${stats.not_designed.length} test type${stats.not_designed.length === 1 ? "" : "s"}`} hint={stats.not_designed.map((n) => caseTypeText(n.test_type)).join(", ")} /> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Group conditions by"
          value={group}
          onChange={setGroup}
          options={[
            { value: "feature", label: "Feature" },
            { value: "requirement", label: "Requirement" },
            { value: "technique", label: "Technique" },
          ]}
        />
        <p className="text-body text-fg">
          Technique coverage: {complete} of {live.length} conditions complete
        </p>
      </div>
      {[...groups.entries()].map(([k, g]) => (
        <section key={k} aria-labelledby={`cond-group-${k}`} className="space-y-3">
          <h2 id={`cond-group-${k}`} className="text-h3 font-semibold text-fg-strong">
            {g.title}
          </h2>
          {g.conds.map((c) => (
            <ConditionCard key={`${k}-${c.id}`} c={c} cases={caseMap} data={data} projectId={projectId} canEdit={canEdit} onOpenData={onOpenData} onChanged={onChanged} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** Condition drawer content (`?condition=TCOND-0003`). */
export function ConditionDrawerBody(props: Parameters<typeof ConditionCard>[0]) {
  return <ConditionCard {...props} />;
}

