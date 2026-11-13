"use client";

import Link from "next/link";
import { useState } from "react";
import { CircleCheck, CircleMinus, ShieldAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { StrategyItem, StrategySections, TestStrategy, TestType } from "@/lib/contract";
import { FUNCTIONAL_TYPES, APPROVAL_TYPES, LEVEL_NAMES, TECHNIQUE_NAMES, TYPE_NAMES } from "@/lib/strategy";
import { Badge, Button, Callout, Card, CardBody, CardHeader, ChecklistEditor, InlineError, Segmented, TextArea, Tooltip, useToast } from "@/components/ui";
import { ReportToc } from "@/components/report/ReportDocument";

type SectionKey = keyof StrategySections;

export const STRATEGY_TOC = [
  { id: "scope", n: "1", title: "Scope" },
  { id: "levels", n: "2", title: "Test levels" },
  { id: "types", n: "3", title: "Test types" },
  { id: "techniques", n: "4", title: "Techniques by feature" },
  { id: "environments", n: "5", title: "Environments" },
  { id: "data", n: "6", title: "Test data approach" },
  { id: "criteria", n: "7", title: "Entry & exit criteria" },
  { id: "notes", n: "8", title: "Assumptions & limitations" },
];

/** Keeps rationale and links of unchanged rows; new or changed rows are the user's. */
export function itemsFromRows(original: StrategyItem[], rows: { id: string; text: string }[]): StrategyItem[] {
  return rows.map((r) => {
    const m = r.id.match(/^i-(\d+)$/);
    const o = m ? original[Number(m[1])] : undefined;
    if (o && o.text === r.text) return o;
    return { text: r.text, rationale: o?.rationale ?? null, related: o?.related ?? [], generated_by: "human" };
  });
}

/** "In scope changed → rationale required" (design §8.2). Returns row index → error. */
export function scopeRowErrors(before: { in_scope: boolean; rationale: string }[], after: { in_scope: boolean; rationale: string }[]): Record<number, string> {
  const e: Record<number, string> = {};
  after.forEach((a, i) => {
    const b = before[i];
    if (b && a.in_scope !== b.in_scope && (!a.rationale.trim() || a.rationale.trim() === b.rationale.trim())) e[i] = "Explain why you changed the scope.";
  });
  return e;
}

function Section({
  id,
  n,
  title,
  edited,
  canEdit,
  editing,
  onEdit,
  children,
}: {
  id: string;
  n: string;
  title: string;
  edited: boolean;
  canEdit: boolean;
  editing: boolean;
  onEdit?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span id={`strategy-${id}`} className="scroll-mt-24">
            <span className="mr-2 tabular-nums text-fg-muted">{n}</span>
            {title}
            {edited && (
              <Badge tone="grey" className="ml-2 align-middle">
                Edited
              </Badge>
            )}
          </span>
        }
        actions={
          canEdit && onEdit && !editing ? (
            <Button size="sm" variant="secondary" onClick={onEdit} aria-label={`Edit ${title}`}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">{children}</CardBody>
    </Card>
  );
}

function Items({ items, empty = "None." }: { items: StrategyItem[]; empty?: string }) {
  if (!items.length) return <p className="text-body text-fg-muted">{empty}</p>;
  return (
    <ol className="list-decimal space-y-2 pl-5 text-body text-fg">
      {items.map((it, i) => (
        <li key={i}>
          {it.text}
          {it.rationale && <span className="block text-small text-fg-muted">{it.rationale}</span>}
          {it.related && it.related.length > 0 && (
            <span className="block text-small text-fg-muted">
              Based on{" "}
              {it.related.map((r, j) => (
                <span key={r.key}>
                  {j > 0 && ", "}
                  {r.path ? (
                    <Link href={r.path} className="font-mono text-navy-700 underline underline-offset-2">
                      {r.key}
                    </Link>
                  ) : (
                    <span className="font-mono">{r.key}</span>
                  )}
                </span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

const InScope = ({ v }: { v: boolean }) =>
  v ? (
    <span className="inline-flex items-center gap-1 text-success-fg">
      <CircleCheck className="h-4 w-4" aria-hidden /> In scope
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-fg-muted">
      <CircleMinus className="h-4 w-4" aria-hidden /> Out of scope
    </span>
  );

function ApprovalBadge() {
  return (
    <Tooltip content="Planned only. These tests can’t run until you approve their limits in a later phase.">
      <Badge tone="amber">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
        Needs separate approval before running
      </Badge>
    </Tooltip>
  );
}

/** Row editor for test levels / types: In scope segmented + rationale (required when scope changes). */
function ScopeRowsEditor<T extends { in_scope: boolean; rationale: string }>({
  rows,
  name,
  onSave,
  onCancel,
  busy,
}: {
  rows: T[];
  name: (r: T) => string;
  onSave: (rows: T[]) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(rows);
  const [errors, setErrors] = useState<Record<number, string>>({});
  return (
    <div className="space-y-3">
      {draft.map((r, i) => (
        <fieldset key={i} className="rounded-md border border-line p-3">
          <legend className="px-1 text-body font-medium text-fg-strong">{name(r)}</legend>
          <div className="space-y-2">
            <Segmented
              label={`${name(r)} scope`}
              value={r.in_scope ? "in" : "out"}
              onChange={(v) => setDraft(draft.map((x, j) => (j === i ? { ...x, in_scope: v === "in" } : x)))}
              options={[
                { value: "in", label: "In scope" },
                { value: "out", label: "Out of scope" },
              ]}
            />
            <TextArea
              label="Rationale"
              rows={2}
              maxLength={500}
              value={r.rationale}
              onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, rationale: e.target.value } : x)))}
              error={errors[i]}
            />
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          loading={busy}
          onClick={() => {
            const e = scopeRowErrors(rows, draft);
            setErrors(e);
            if (Object.keys(e).length) {
              document.querySelector<HTMLTextAreaElement>("[aria-invalid=true]")?.focus();
              return;
            }
            onSave(draft);
          }}
        >
          Save section
        </Button>
      </div>
    </div>
  );
}

/**
 * Strategy tab (design P2 §8.2): a document of sections, each with its own [Edit]. Saving a section creates a
 * strategy revision and marks it Edited (protected on regeneration). Version conflicts → 409 callout.
 */
export function StrategyDocument({ projectId, strategy, readOnly, onSaved }: { projectId: string; strategy: TestStrategy; readOnly: boolean; onSaved: (s: TestStrategy) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const s = strategy.sections;
  const edited = (k: SectionKey) => strategy.human_edited_sections.includes(k);
  const canEdit = !readOnly;

  async function save(patch: Partial<StrategySections>, label: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<TestStrategy>(`/projects/${projectId}/test-strategy`, { method: "PATCH", body: { version: strategy.version, sections: patch } });
      setEditing(null);
      toast(`${label} saved. Strategy version ${next.version}.`);
      onSaved(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else setError(`Couldn’t save this section. Your changes are still here. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  }

  const listSection = (key: SectionKey, label: string) => {
    const items = s[key] as StrategyItem[];
    return editing === key ? (
      <ChecklistEditor
        label={label}
        initial={items.map((it, i) => ({ id: `i-${i}`, text: it.text }))}
        onCancel={() => setEditing(null)}
        onSave={(rows) => void save({ [key]: itemsFromRows(items, rows) } as Partial<StrategySections>, label)}
        busy={busy}
        error={error}
        saveLabel="Save section"
      />
    ) : (
      <Items items={items} />
    );
  };

  const types = (functional: boolean) => s.test_types.filter((t) => FUNCTIONAL_TYPES.includes(t.type) === functional);
  const typeTable = (rows: StrategySections["test_types"], caption: string) => (
    <table className="w-full text-small">
      <caption className="mb-1 text-left text-body font-semibold text-fg-strong">{caption}</caption>
      <thead>
        <tr className="text-left text-caption uppercase tracking-[0.04em] text-fg-muted">
          <th scope="col" className="py-1.5 pr-3">Type</th>
          <th scope="col" className="py-1.5 pr-3">In scope</th>
          <th scope="col" className="py-1.5 pr-3">Rationale</th>
          <th scope="col" className="py-1.5">Needs separate approval</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((t) => (
          <tr key={t.type}>
            <th scope="row" className="py-2 pr-3 text-left font-medium text-fg-strong">{TYPE_NAMES[t.type as TestType]}</th>
            <td className="py-2 pr-3"><InScope v={t.in_scope} /></td>
            <td className="py-2 pr-3 text-fg">{t.rationale || <span className="text-fg-muted">No rationale</span>}</td>
            <td className="py-2">{t.in_scope && (t.requires_approval || APPROVAL_TYPES.includes(t.type)) ? <ApprovalBadge /> : <span className="text-fg-muted">No</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[200px_minmax(0,960px)]">
      <ReportToc sections={STRATEGY_TOC} label="Strategy contents" prefix="strategy-" />
      <div className="space-y-6">
        {conflict && (
          <Callout tone="warning" title="Someone else changed the strategy" actions={<Button variant="secondary" onClick={() => window.location.reload()}>Reload</Button>}>
            Your edit wasn’t saved. Reload to see their version, then make your change again.
          </Callout>
        )}
        <Section id="scope" n="1" title="Scope" edited={edited("scope_in") || edited("scope_out")} canEdit={canEdit} editing={editing === "scope_in" || editing === "scope_out"}>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-body font-semibold text-fg-strong">In scope</h3>
                {canEdit && editing !== "scope_in" && <Button size="sm" variant="ghost" onClick={() => setEditing("scope_in")} aria-label="Edit In scope">Edit</Button>}
              </div>
              {listSection("scope_in", "In scope item")}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-body font-semibold text-fg-strong">Out of scope</h3>
                {canEdit && editing !== "scope_out" && <Button size="sm" variant="ghost" onClick={() => setEditing("scope_out")} aria-label="Edit Out of scope">Edit</Button>}
              </div>
              {listSection("scope_out", "Out of scope item")}
            </div>
          </div>
        </Section>

        <Section id="levels" n="2" title="Test levels" edited={edited("test_levels")} canEdit={canEdit} editing={editing === "test_levels"} onEdit={() => setEditing("test_levels")}>
          {editing === "test_levels" ? (
            <>
              <ScopeRowsEditor rows={s.test_levels} name={(r) => LEVEL_NAMES[r.level]} busy={busy} onCancel={() => setEditing(null)} onSave={(rows) => void save({ test_levels: rows }, "Test levels")} />
              <InlineError error={error} />
            </>
          ) : (
            <table className="w-full text-small">
              <thead>
                <tr className="text-left text-caption uppercase tracking-[0.04em] text-fg-muted">
                  <th scope="col" className="py-1.5 pr-3">Level</th>
                  <th scope="col" className="py-1.5 pr-3">In scope</th>
                  <th scope="col" className="py-1.5">Rationale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.test_levels.map((l) => (
                  <tr key={l.level}>
                    <th scope="row" className="py-2 pr-3 text-left font-medium text-fg-strong">{LEVEL_NAMES[l.level]}</th>
                    <td className="py-2 pr-3"><InScope v={l.in_scope} /></td>
                    <td className="py-2 text-fg">{l.rationale || <span className="text-fg-muted">No rationale</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section id="types" n="3" title="Test types" edited={edited("test_types")} canEdit={canEdit} editing={editing === "test_types"} onEdit={() => setEditing("test_types")}>
          {editing === "test_types" ? (
            <>
              <ScopeRowsEditor rows={s.test_types} name={(r) => TYPE_NAMES[r.type]} busy={busy} onCancel={() => setEditing(null)} onSave={(rows) => void save({ test_types: rows }, "Test types")} />
              <InlineError error={error} />
            </>
          ) : (
            <div className="space-y-5 overflow-x-auto">
              {typeTable(types(true), "Functional")}
              {typeTable(types(false), "Non-functional")}
            </div>
          )}
        </Section>

        <Section id="techniques" n="4" title="Techniques by feature" edited={edited("techniques_by_feature")} canEdit={false} editing={false}>
          {s.techniques_by_feature.length === 0 ? (
            <p className="text-body text-fg-muted">None.</p>
          ) : (
            <ul className="divide-y divide-line">
              {s.techniques_by_feature.map((f) => (
                <li key={f.feature.key} className="space-y-1.5 py-3 first:pt-0">
                  <p className="font-medium text-fg-strong">{f.feature.label || f.feature.key}</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {f.techniques.map((t) => (
                      <li key={t.technique}>
                        <Badge tone="grey">{TECHNIQUE_NAMES[t.technique]}</Badge>
                      </li>
                    ))}
                  </ul>
                  {f.techniques.some((t) => t.rationale) && <p className="text-small text-fg-muted">{f.techniques.map((t) => t.rationale).filter(Boolean).join(" ")}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="environments" n="5" title="Environments" edited={edited("environments")} canEdit={false} editing={false}>
          {s.environments.length === 0 ? (
            <p className="text-body text-fg-muted">None.</p>
          ) : (
            <ul className="space-y-2 text-body text-fg">
              {s.environments.map((e) => (
                <li key={e.name}>
                  <span className="font-medium text-fg-strong">{e.name}</span> · <span className="font-mono">{e.url}</span>
                  <span className="block text-small text-fg-muted">
                    Browsers: {e.browsers.join(", ") || "—"} · Viewports: {e.viewports.join(", ") || "—"} · {e.auth === "credentials" ? "Signed in with the test account" : "Public pages"}
                  </span>
                  {e.notes && <span className="block text-small text-fg-muted">{e.notes}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="data" n="6" title="Test data approach" edited={edited("test_data_approach")} canEdit={canEdit} editing={editing === "test_data_approach"} onEdit={() => setEditing("test_data_approach")}>
          {listSection("test_data_approach", "Test data item")}
          <p className="text-small font-medium text-fg-strong">Tests use synthetic data only. No real customer data.</p>
        </Section>

        <Section id="criteria" n="7" title="Entry & exit criteria" edited={edited("entry_criteria") || edited("exit_criteria")} canEdit={canEdit} editing={false}>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {(["entry_criteria", "exit_criteria"] as const).map((k) => (
              <div key={k}>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-body font-semibold text-fg-strong">{k === "entry_criteria" ? "Entry criteria" : "Exit criteria"}</h3>
                  {canEdit && editing !== k && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(k)} aria-label={`Edit ${k === "entry_criteria" ? "Entry criteria" : "Exit criteria"}`}>
                      Edit
                    </Button>
                  )}
                </div>
                {listSection(k, k === "entry_criteria" ? "Entry criterion" : "Exit criterion")}
              </div>
            ))}
          </div>
        </Section>

        <Section id="notes" n="8" title="Assumptions & limitations" edited={false} canEdit={false} editing={false}>
          {(["assumptions", "constraints", "limitations"] as const).map((k) => (
            <div key={k}>
              <h3 className="mb-1 text-body font-semibold text-fg-strong">{k === "assumptions" ? "Assumptions" : k === "constraints" ? "Constraints" : "Limitations"}</h3>
              <Items items={s[k]} />
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
