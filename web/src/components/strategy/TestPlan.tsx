"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { PlanOwnedSection, TestPlan, TestPlanSections, TestPlanVersion } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Callout, Card, CardBody, CardHeader, ChecklistEditor, Drawer, InlineError, SelectField, Spinner, TextArea, TextField, useToast } from "@/components/ui";
import { DiffView } from "@/components/domain/DiffView";
import { ReportToc } from "@/components/report/ReportDocument";

export const PLAN_TOC = [
  { id: "introduction", n: "1", title: "Introduction" },
  { id: "test_items", n: "2", title: "Test items" },
  { id: "scope", n: "3", title: "Scope" },
  { id: "approach", n: "4", title: "Approach" },
  { id: "environments_and_test_data", n: "5", title: "Environments & test data" },
  { id: "entry_exit_criteria", n: "6", title: "Entry & exit criteria" },
  { id: "suspension", n: "7", title: "Suspension & resumption" },
  { id: "deliverables", n: "8", title: "Deliverables" },
  { id: "roles", n: "9", title: "Roles" },
  { id: "schedule", n: "10", title: "Schedule" },
  { id: "risks_and_contingencies", n: "11", title: "Risks" },
];

/** Version selector text: "3 · 13 Nov 11:40 · Derived from Strategy v2 · note". */
export function planVersionLabel(v: TestPlanVersion): string {
  const src = v.source === "derived" ? `Derived from Strategy v${v.strategy_version}` : v.source === "edited" ? "Edited" : "Regenerated";
  return [`${v.version}`, fmtDateTime(v.created_at), src, v.created_by?.full_name, v.note].filter(Boolean).join(" · ");
}

/** Renders a strategy-derived section (read-only object) as readable text, never as raw JSON keys. */
export function DerivedValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <p className="text-body text-fg-muted">Not set.</p>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <p className="text-body text-fg">{String(value)}</p>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-body text-fg-muted">None.</p>;
    return (
      <ul className="list-disc space-y-1 pl-5 text-body text-fg">
        {value.map((v, i) => (
          <li key={i}>{typeof v === "object" && v ? Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string" || typeof x === "number").join(" · ") : String(v)}</li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="space-y-2">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k}>
          <dt className="text-small font-semibold capitalize text-fg-strong">{k.replace(/_/g, " ")}</dt>
          <dd>
            <DerivedValue value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PlanSection({ id, n, title, fromStrategy, edited, template, action, children }: { id: string; n: string; title: string; fromStrategy?: boolean; edited?: boolean; template?: boolean; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`plan-${id}`} className="border-t border-line pt-6 first:border-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id={`plan-${id}`} className="scroll-mt-24 text-h3 font-semibold text-fg-strong">
          <span className="mr-2 tabular-nums text-fg-muted">{n}</span>
          {title}
          {edited && <Badge className="ml-2 align-middle">Edited</Badge>}
          {template && <Badge tone="amber" className="ml-2 align-middle">Standard wording</Badge>}
        </h3>
        {fromStrategy ? <span className="text-small text-fg-muted">From Test Strategy</span> : action}
      </div>
      {children}
    </section>
  );
}

/**
 * Test Plan tab (design P2 §9). Plan-owned sections (1, 2, 7–11) are editable and every save creates a new
 * version; strategy-derived sections (3–6) are read-only with a link to edit them in the strategy.
 * The agent never fills dates: an empty schedule says "Not set."
 */
export function TestPlanDocument({
  projectId,
  plan,
  versions,
  latest,
  readOnly,
  onSaved,
  onSelectVersion,
}: {
  projectId: string;
  plan: TestPlan;
  versions: TestPlanVersion[];
  latest: number;
  readOnly: boolean;
  onSaved: () => void;
  onSelectVersion: (v: number) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<PlanOwnedSection | null>(null);
  const [intro, setIntro] = useState(plan.sections.introduction);
  const [roles, setRoles] = useState(plan.sections.roles);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [from, setFrom] = useState(Math.max(1, plan.version - 1));
  const [to, setTo] = useState(plan.version);
  const compare = useApi<{ sections: { section: string; field_diff: { field: string; from: unknown; to: unknown }[] }[] }>(
    compareOpen ? `/projects/${projectId}/test-plan/compare` : null,
    { from, to },
    { shouldRetryOnError: false },
  );
  const s = plan.sections;
  const edited = (k: PlanOwnedSection) => plan.human_edited_sections.includes(k);
  const template = (k: PlanOwnedSection) => plan.rules_template_sections.includes(k);
  const strategyHref = `/projects/${projectId}/test-strategy`;

  async function save(patch: Partial<TestPlanSections>) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<TestPlan>(`/projects/${projectId}/test-plan`, { method: "PATCH", body: { version: plan.version, sections: patch, note: note.trim() || undefined } });
      toast(`Test Plan saved as version ${next.version}.`);
      setEditing(null);
      setNote("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Someone else saved a newer version. Reload to see it." : "Couldn’t save this section. Your text is still here. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const editBtn = (k: PlanOwnedSection, label: string) =>
    !readOnly && editing !== k ? (
      <Button size="sm" variant="secondary" onClick={() => setEditing(k)} aria-label={`Edit ${label}`}>
        Edit
      </Button>
    ) : null;
  const noteField = <TextField label="Change note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />;
  const list = (items: string[]) =>
    items.length ? (
      <ol className="list-decimal space-y-1 pl-5 text-body text-fg">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ol>
    ) : (
      <p className="text-body text-fg-muted">Not set.</p>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-fg-strong">Test Plan · Version {plan.version}</h2>
          <p className="text-small text-fg-muted">
            Derived from Test Strategy version {plan.strategy_version}
            {plan.approvals.find((a) => a.gate === "G4" && a.decided_at) ? ` (Gate 4 approved ${fmtDateTime(plan.approvals.find((a) => a.gate === "G4")!.decided_at)})` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Plan version"
            value={String(plan.version)}
            onChange={(e) => onSelectVersion(Number(e.target.value))}
            options={versions.map((v) => ({ value: String(v.version), label: planVersionLabel(v) }))}
            wrapClassName="w-72"
          />
          {versions.length > 1 && (
            <Button variant="secondary" onClick={() => setCompareOpen(true)}>
              Compare versions
            </Button>
          )}
          <Link href={`/projects/${projectId}/reports/test-plan`} className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
            Open report
          </Link>
        </div>
      </div>
      {plan.version !== latest && (
        <Callout tone="info" actions={<Button variant="secondary" onClick={() => onSelectVersion(latest)}>View latest</Button>}>
          You’re viewing Test Plan version {plan.version}. The latest is version {latest}. Older versions are read-only.
        </Callout>
      )}
      {plan.generated_by === "rules" && plan.version === latest && (
        <Callout tone="info">Generated from a template (AI not configured). Sections 1, 7, 8 and 9 contain standard wording. Edit them for this project.</Callout>
      )}
      <div className="grid gap-6 xl:grid-cols-[200px_minmax(0,760px)]">
        <ReportToc sections={PLAN_TOC} label="Plan contents" prefix="plan-" />
        <Card>
          <CardBody className="space-y-6">
            <InlineError error={error} />
            <PlanSection id="introduction" n="1" title="Introduction & objectives" edited={edited("introduction")} template={template("introduction")} action={editBtn("introduction", "Introduction")}>
              {editing === "introduction" ? (
                <div className="space-y-2">
                  <TextArea label="Introduction" hideLabel rows={6} maxLength={5000} value={intro} onChange={(e) => setIntro(e.target.value)} />
                  {noteField}
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button loading={busy} onClick={() => void save({ introduction: intro })}>
                      Save section
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-body text-fg">{s.introduction || <span className="text-fg-muted">Not set.</span>}</p>
              )}
            </PlanSection>
            <PlanSection id="test_items" n="2" title="Test items" edited={edited("test_items")}>
              {s.test_items.length ? (
                <ul className="list-disc space-y-1 pl-5 text-body text-fg">
                  {s.test_items.map((t) => (
                    <li key={t.key}>{t.path ? <Link href={t.path} className="text-navy-700 underline underline-offset-2">{t.label || t.key}</Link> : t.label || t.key}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-body text-fg-muted">Not set.</p>
              )}
            </PlanSection>
            {(
              [
                ["scope", "3", "Scope"],
                ["approach", "4", "Approach (levels, types, techniques)"],
                ["environments_and_test_data", "5", "Environments & test data"],
                ["entry_exit_criteria", "6", "Entry & exit criteria"],
              ] as const
            ).map(([k, n, title]) => (
              <PlanSection key={k} id={k} n={n} title={title} fromStrategy>
                <DerivedValue value={s[k]} />
                <Link href={strategyHref} className="mt-2 inline-block text-small font-medium text-navy-700 underline underline-offset-2">
                  Edit in Test Strategy
                </Link>
              </PlanSection>
            ))}
            <PlanSection id="suspension" n="7" title="Suspension & resumption criteria" edited={edited("suspension_criteria") || edited("resumption_requirements")} template={template("suspension_criteria")}>
              <div className="grid gap-4 md:grid-cols-2">
                {(
                  [
                    ["suspension_criteria", "Suspend testing when", "Suspension criterion"],
                    ["resumption_requirements", "Resume when", "Resumption requirement"],
                  ] as const
                ).map(([k, heading, label]) => (
                  <div key={k}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <h4 className="text-body font-semibold text-fg-strong">{heading}</h4>
                      {editBtn(k, heading)}
                    </div>
                    {editing === k ? (
                      <div className="space-y-2">
                        <ChecklistEditor
                          label={label}
                          initial={s[k].map((t, i) => ({ id: `${k}-${i}`, text: t }))}
                          onCancel={() => setEditing(null)}
                          saveLabel="Save section"
                          busy={busy}
                          onSave={(rows) => void save({ [k]: rows.map((r) => r.text) })}
                        />
                        {noteField}
                      </div>
                    ) : (
                      list(s[k])
                    )}
                  </div>
                ))}
              </div>
            </PlanSection>
            <PlanSection id="deliverables" n="8" title="Deliverables" edited={edited("deliverables")} template={template("deliverables")}>
              <ul className="space-y-1 text-body text-fg">
                {s.deliverables.map((d) => (
                  <li key={d.name}>
                    {d.name} · <span className="text-fg-muted">{d.exists ? "Available" : `Available from Phase ${d.available_from_phase}`}</span>
                  </li>
                ))}
              </ul>
            </PlanSection>
            <PlanSection id="roles" n="9" title="Roles & responsibilities" edited={edited("roles")} template={template("roles")} action={editBtn("roles", "Roles")}>
              {editing === "roles" ? (
                <div className="space-y-3">
                  {roles.map((r, i) => (
                    <fieldset key={i} className="grid gap-2 sm:grid-cols-2">
                      <legend className="sr-only">Role {i + 1}</legend>
                      <TextField label={`Role ${i + 1}`} value={r.role} maxLength={120} onChange={(e) => setRoles(roles.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
                      <TextField label={`Responsibility ${i + 1}`} value={r.responsibility} maxLength={300} onChange={(e) => setRoles(roles.map((x, j) => (j === i ? { ...x, responsibility: e.target.value } : x)))} />
                    </fieldset>
                  ))}
                  <Button size="sm" variant="secondary" onClick={() => setRoles([...roles, { role: "", responsibility: "", assignee: null }])}>
                    Add role
                  </Button>
                  {noteField}
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => (setRoles(s.roles), setEditing(null))}>
                      Cancel
                    </Button>
                    <Button loading={busy} onClick={() => void save({ roles: roles.filter((r) => r.role.trim()) })}>
                      Save section
                    </Button>
                  </div>
                </div>
              ) : s.roles.length ? (
                <dl className="space-y-1 text-body">
                  {s.roles.map((r, i) => (
                    <div key={i} className="flex flex-wrap gap-x-2">
                      <dt className="font-semibold text-fg-strong">{r.role}</dt>
                      <dd className="text-fg">{r.responsibility}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-body text-fg-muted">Not set.</p>
              )}
            </PlanSection>
            <PlanSection id="schedule" n="10" title="Schedule & milestones" edited={edited("schedule")}>
              {s.schedule.some((m) => m.target_date) ? (
                <ul className="space-y-1 text-body text-fg">
                  {s.schedule.map((m) => (
                    <li key={m.milestone}>
                      {m.milestone} · {m.target_date ?? "Not set."}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-body text-fg-muted">Not set.</p>
              )}
            </PlanSection>
            <PlanSection id="risks_and_contingencies" n="11" title="Risks & contingencies" edited={edited("risks_and_contingencies")}>
              {s.risks_and_contingencies.length ? (
                <ul className="space-y-1 text-body text-fg">
                  {s.risks_and_contingencies.map((r) => (
                    <li key={r.risk.key}>
                      <span className="font-mono">{r.risk.key}</span> {r.risk.label} · {r.contingency}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-body text-fg-muted">Not set.</p>
              )}
              <Link href={`${strategyHref}?view=risks`} className="mt-2 inline-block text-small font-medium text-navy-700 underline underline-offset-2">
                Open the risk register
              </Link>
            </PlanSection>
          </CardBody>
        </Card>
      </div>
      <Drawer open={compareOpen} onClose={() => setCompareOpen(false)} title="Compare Test Plan versions" wide>
        <div className="mb-4 flex flex-wrap gap-3">
          <SelectField label="From" value={String(from)} onChange={(e) => setFrom(Number(e.target.value))} options={versions.map((v) => ({ value: String(v.version), label: `Version ${v.version}` }))} wrapClassName="w-40" />
          <SelectField label="To" value={String(to)} onChange={(e) => setTo(Number(e.target.value))} options={versions.map((v) => ({ value: String(v.version), label: `Version ${v.version}` }))} wrapClassName="w-40" />
        </div>
        {compare.error ? (
          <InlineError error="Couldn’t compare these versions. Try again." />
        ) : !compare.data ? (
          <Spinner label="Comparing…" />
        ) : compare.data.sections.length === 0 ? (
          <p className="text-body text-fg-muted">No differences.</p>
        ) : (
          <div className="space-y-4">
            {compare.data.sections.map((sec) => (
              <Card key={sec.section}>
                <CardHeader title={PLAN_TOC.find((t) => t.id === sec.section)?.title ?? sec.section.replace(/_/g, " ")} />
                <CardBody>
                  <DiffView changes={sec.field_diff} leftLabel={`Version ${from}`} rightLabel={`Version ${to}`} />
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}
