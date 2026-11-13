"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { Risk, RiskCreate, RiskLevel, RiskMatrix as RiskMatrixT, TestType } from "@/lib/contract";
import { IMPACT, LEVEL_ABBR, LEVEL_CLASS, LEVEL_TEXT, LIKELIHOOD, TYPE_NAMES, cellName, cellScore, impactText, matrixCells, likelihoodText, riskChecks } from "@/lib/strategy";
import { Button, Callout, Card, CardBody, CardHeader, EmptyState, FilterChips, InlineError, Modal, SelectField, TextArea, TextField, useToast } from "@/components/ui";
import { GeneratedByLabel, ProvenanceLabel } from "@/components/domain/ObservationLabel";

const CHECK_ICON: Record<string, string> = { ok: "✓", warn: "⚠", fail: "✗", info: "ⓘ" };

/** Risk matrix (design P2 §8.3): a real table; non-empty cells are buttons that filter the register. */
export function RiskMatrix({ matrix, risks, selected, onSelect }: { matrix: RiskMatrixT; risks: Risk[]; selected: { l: number; i: number } | null; onSelect: (c: { l: number; i: number }) => void }) {
  const cells = matrixCells(matrix, risks);
  const cell = (l: number, i: number) => cells.find((c) => c.likelihood === l && c.impact === i);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-small">
        <caption className="mb-2 text-left text-body font-semibold text-fg-strong">
          Risk matrix: number of risks by likelihood and impact
          {/* Narrow screens show the rating numbers only; this key names them (design §15). */}
          <span className="block text-caption font-normal text-fg-muted sm:hidden" aria-hidden>
            Rows: likelihood 1 {LIKELIHOOD[0]} to 5 {LIKELIHOOD[4]}. Columns: impact 1 {IMPACT[0]} to 5 {IMPACT[4]}.
          </span>
        </caption>
        <thead>
          <tr>
            <td />
            {IMPACT.map((name, k) => (
              <th key={name} scope="col" className="px-1 text-center text-caption font-semibold text-fg-muted">
                {k + 1} <span className="sr-only sm:not-sr-only">{name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[5, 4, 3, 2, 1].map((l) => (
            <tr key={l}>
              <th scope="row" className="pr-1 text-left text-caption font-semibold text-fg-muted sm:whitespace-nowrap sm:pr-2">
                {l} <span className="sr-only sm:not-sr-only">{LIKELIHOOD[l - 1]}</span>
              </th>
              {[1, 2, 3, 4, 5].map((i) => {
                const c = cell(l, i);
                if (!c || c.count === 0) return <td key={i} className="h-11 rounded-md bg-elevated" />;
                const sc = cellScore(c, risks);
                const on = selected?.l === l && selected?.i === i;
                return (
                  <td key={i} className="h-11 p-0">
                    <button
                      type="button"
                      aria-label={cellName(c.count, l, i, sc?.score ?? null, sc?.level ?? null)}
                      aria-pressed={on}
                      onClick={() => onSelect({ l, i })}
                      className={`h-11 w-full rounded-md font-semibold tabular-nums ring-1 ring-inset ${sc ? LEVEL_CLASS[sc.level] : "bg-overlay text-fg-strong ring-line"} ${on ? "outline outline-2 outline-offset-1 outline-focus" : ""}`}
                    >
                      {c.count}
                      <span className="hidden min-[400px]:inline"> {sc ? LEVEL_ABBR[sc.level] : ""}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ratingOptions = (names: readonly string[]) => names.map((n, k) => ({ value: String(k + 1), label: `${k + 1} ${n}` }));

/** Likelihood / impact change saves immediately; the score comes back from the server (never computed here). */
function RatingSelect({ risk, field, onSaved, visibleLabel }: { risk: Risk; field: "likelihood" | "impact"; onSaved: (r: Risk) => void; visibleLabel?: boolean }) {
  const [value, setValue] = useState(String(risk[field]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={visibleLabel ? "min-w-0" : "min-w-36"}>
      <SelectField
        label={visibleLabel ? (field === "likelihood" ? "Likelihood" : "Impact") : `${field === "likelihood" ? "Likelihood" : "Impact"} for ${risk.key}`}
        aria-label={`${field === "likelihood" ? "Likelihood" : "Impact"} for ${risk.key}`}
        hideLabel={!visibleLabel}
        value={saving ? value : String(risk[field])}
        disabled={saving}
        options={ratingOptions(field === "likelihood" ? LIKELIHOOD : IMPACT)}
        onChange={async (e) => {
          const next = e.target.value;
          setValue(next);
          setSaving(true);
          setError(null);
          try {
            onSaved(await api<Risk>(`/risks/${risk.id}`, { method: "PATCH", body: { version: risk.version, [field]: Number(next) } }));
          } catch {
            setValue(String(risk[field]));
            setError(`Couldn’t update ${risk.key}. The previous rating is kept.`);
          } finally {
            setSaving(false);
          }
        }}
      />
      {saving && <span className="sr-only" role="status">Recalculating score</span>}
      <InlineError error={error} />
    </div>
  );
}

function RiskDetails({ risk, inScopeTypes, readOnly, onSaved }: { risk: Risk; inScopeTypes: TestType[]; readOnly: boolean; onSaved: (r: Risk) => void }) {
  const toast = useToast();
  const [types, setTypes] = useState<TestType[]>(risk.mitigation.test_types);
  const [notes, setNotes] = useState(risk.mitigation.notes ?? "");
  const [status, setStatus] = useState<Risk["status"]>(risk.status);
  const [comment, setComment] = useState(risk.status_comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = Array.from(new Set([...inScopeTypes, ...risk.mitigation.test_types]));
  async function save() {
    if (status === "accepted" && !comment.trim()) return setCommentError("Explain why this risk is accepted.");
    setCommentError(null);
    setBusy(true);
    setError(null);
    try {
      const r = await api<Risk>(`/risks/${risk.id}`, {
        method: "PATCH",
        body: { version: risk.version, mitigation: { ...risk.mitigation, test_types: types, notes: notes.trim() || null }, status, comment: status === "accepted" ? comment.trim() : comment.trim() || null },
      });
      toast(`${risk.key} saved.`);
      onSaved(r);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? `${risk.key} was changed by someone else. Reload to see their version.` : `Couldn’t save ${risk.key}. Your changes are still here.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 bg-elevated px-4 py-3">
      <p className="text-body text-fg">{risk.description}</p>
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <ProvenanceLabel provenance={risk.provenance} confidence={risk.confidence} /> <GeneratedByLabel generatedBy={risk.generated_by} />
      </p>
      <dl className="grid gap-2 text-small sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-fg-strong">Why likelihood {likelihoodText(risk.likelihood)}</dt>
          <dd className="text-fg">{risk.likelihood_rationale || "—"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-fg-strong">Why impact {impactText(risk.impact)}</dt>
          <dd className="text-fg">{risk.impact_rationale || "—"}</dd>
        </div>
      </dl>
      {(risk.requirements.length > 0 || risk.features.length > 0) && (
        <p className="text-small text-fg">
          Related:{" "}
          {[...risk.features, ...risk.requirements].map((a, k) => (
            <Fragment key={a.key}>
              {k > 0 && ", "}
              {a.path ? (
                <Link href={a.path} className="text-navy-700 underline underline-offset-2">
                  {a.label || a.key}
                </Link>
              ) : (
                a.label || a.key
              )}
            </Fragment>
          ))}
        </p>
      )}
      {readOnly ? (
        <p className="text-small text-fg">
          Mitigation: {risk.mitigation.test_types.map((t) => TYPE_NAMES[t]).join(", ") || "none"}
          {risk.mitigation.notes ? ` · ${risk.mitigation.notes}` : ""}
        </p>
      ) : (
        <>
          <fieldset>
            <legend className="mb-1 text-body font-medium text-fg-strong">Mitigation test types</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {options.map((t) => (
                <label key={t} className="inline-flex min-h-6 items-center gap-1.5 text-body text-fg">
                  <input type="checkbox" className="h-4 w-4 accent-accent" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />
                  {TYPE_NAMES[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea label="Mitigation notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as Risk["status"])}
            options={[
              { value: "open", label: "Open" },
              { value: "mitigated", label: "Mitigated" },
              { value: "accepted", label: "Accepted" },
            ]}
            wrapClassName="max-w-xs"
          />
          {status === "accepted" && <TextArea label="Why is this risk accepted?" required rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} error={commentError} />}
          <InlineError error={error} />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void save()} loading={busy}>
              Save {risk.key}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function validateRisk(f: { title: string; likelihood_rationale: string; impact_rationale: string }): Partial<Record<"title" | "likelihood_rationale" | "impact_rationale", string>> {
  const e: Partial<Record<"title" | "likelihood_rationale" | "impact_rationale", string>> = {};
  if (f.title.trim().length < 5) e.title = "Enter a title of at least 5 characters.";
  if (!f.likelihood_rationale.trim()) e.likelihood_rationale = "Explain the likelihood rating.";
  if (!f.impact_rationale.trim()) e.impact_rationale = "Explain the impact rating.";
  return e;
}

function AddRisk({ open, onClose, projectId, inScopeTypes, onCreated }: { open: boolean; onClose: () => void; projectId: string; inScopeTypes: TestType[]; onCreated: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: "", description: "", likelihood: "3", impact: "3", likelihood_rationale: "", impact_rationale: "" });
  const [types, setTypes] = useState<TestType[]>([]);
  const [errors, setErrors] = useState<ReturnType<typeof validateRisk>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function create() {
    const e = validateRisk(f);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body: RiskCreate = {
        title: f.title.trim(),
        description: f.description.trim(),
        likelihood: Number(f.likelihood),
        impact: Number(f.impact),
        likelihood_rationale: f.likelihood_rationale.trim(),
        impact_rationale: f.impact_rationale.trim(),
        mitigation: { test_types: types, techniques: [], notes: null },
      };
      const r = await api<Risk>(`/projects/${projectId}/risks`, { body });
      toast(`${r.key} added. Score ${r.score}, ${LEVEL_TEXT[r.level]}.`);
      onCreated();
      onClose();
    } catch (err) {
      setError(`Couldn’t add the risk. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add risk"
      description="Source: User · label Assumed. The score is calculated by the system: likelihood × impact."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void create()} loading={busy}>
            Add risk
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Risk" required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} error={errors.title} />
        <TextArea label="Description" rows={2} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Likelihood" value={f.likelihood} onChange={(e) => setF({ ...f, likelihood: e.target.value })} options={ratingOptions(LIKELIHOOD)} />
          <SelectField label="Impact" value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} options={ratingOptions(IMPACT)} />
        </div>
        <TextArea label="Why this likelihood" required rows={2} maxLength={500} value={f.likelihood_rationale} onChange={(e) => setF({ ...f, likelihood_rationale: e.target.value })} error={errors.likelihood_rationale} />
        <TextArea label="Why this impact" required rows={2} maxLength={500} value={f.impact_rationale} onChange={(e) => setF({ ...f, impact_rationale: e.target.value })} error={errors.impact_rationale} />
        <fieldset>
          <legend className="mb-1 text-body font-medium text-fg-strong">Mitigation test types</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {inScopeTypes.map((t) => (
              <label key={t} className="inline-flex min-h-6 items-center gap-1.5 text-body text-fg">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />
                {TYPE_NAMES[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <InlineError error={error} />
      </div>
    </Modal>
  );
}

/** Risk register tab (design P2 §8.3): matrix + summary, filters, register rows with inline ratings. */
export function RiskRegister({
  projectId,
  risks,
  matrix,
  inScopeTypes,
  generatedBy,
  readOnly,
  onChanged,
}: {
  projectId: string;
  risks: Risk[];
  matrix: RiskMatrixT | undefined;
  inScopeTypes: TestType[];
  generatedBy: string | null;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [cell, setCell] = useState<{ l: number; i: number } | null>(null);
  const [level, setLevel] = useState<RiskLevel | "">("");
  const [status, setStatus] = useState<Risk["status"] | "">("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [local, setLocal] = useState<Record<string, Risk>>({});
  const all = risks.map((r) => (local[r.id] && local[r.id].version >= r.version ? local[r.id] : r));
  const rows = all.filter((r) => (!cell || (r.likelihood === cell.l && r.impact === cell.i)) && (!level || r.level === level) && (!status || r.status === status));
  const saved = (r: Risk) => {
    setLocal((x) => ({ ...x, [r.id]: r }));
    onChanged();
  };
  const totals = matrix?.totals ?? {};
  const chips = [
    ...(cell ? [{ key: "cell", label: `Matrix: L${cell.l} × I${cell.i}` }] : []),
    ...(level ? [{ key: "level", label: `Level: ${LEVEL_TEXT[level]}` }] : []),
    ...(status ? [{ key: "status", label: `Status: ${status[0].toUpperCase()}${status.slice(1)}` }] : []),
  ];
  const checks = riskChecks(all);

  if (all.length === 0)
    return (
      <>
        <EmptyState
          title="No risks identified."
          description="Add one, or regenerate the strategy."
          action={
            !readOnly ? (
              <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>
                Add risk
              </Button>
            ) : undefined
          }
        />
        <AddRisk open={adding} onClose={() => setAdding(false)} projectId={projectId} inScopeTypes={inScopeTypes} onCreated={onChanged} />
      </>
    );

  return (
    <div className="space-y-6">
      {generatedBy === "rules" && (
        <Callout tone="info">Risks were generated by rules from the requirement categories. Review the likelihood and impact; rules use default ratings.</Callout>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardBody>{matrix ? <RiskMatrix matrix={matrix} risks={all} selected={cell} onSelect={setCell} /> : <p className="text-body text-fg-muted">Loading the matrix…</p>}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Summary" />
          <CardBody className="space-y-2 text-body text-fg">
            <p className="font-semibold text-fg-strong">
              {all.length} risk{all.length === 1 ? "" : "s"}
            </p>
            <p>{(["very_high", "high", "medium", "low"] as RiskLevel[]).map((l) => `${totals[l] ?? all.filter((r) => r.level === l).length} ${LEVEL_TEXT[l]}`).join(" · ")}</p>
            <ul className="space-y-1">
              {checks.map((c) => (
                <li key={c.text} className={c.tone === "fail" ? "text-danger-fg" : c.tone === "warn" ? "text-warning-fg" : "text-fg"}>
                  <span aria-hidden>{CHECK_ICON[c.tone]} </span>
                  {c.text}
                </li>
              ))}
            </ul>
            <p className="text-small text-fg-muted">Scores are calculated by the system: likelihood × impact.</p>
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Level"
            value={level}
            onChange={(e) => setLevel(e.target.value as RiskLevel | "")}
            options={[{ value: "", label: "Any" }, ...(["very_high", "high", "medium", "low"] as RiskLevel[]).map((l) => ({ value: l, label: LEVEL_TEXT[l] }))]}
            wrapClassName="w-40"
          />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as Risk["status"] | "")}
            options={[
              { value: "", label: "Any" },
              { value: "open", label: "Open" },
              { value: "mitigated", label: "Mitigated" },
              { value: "accepted", label: "Accepted" },
            ]}
            wrapClassName="w-40"
          />
        </div>
        {!readOnly && (
          <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>
            Add risk
          </Button>
        )}
      </div>
      <FilterChips
        chips={chips}
        onRemove={(k) => (k === "cell" ? setCell(null) : k === "level" ? setLevel("") : setStatus(""))}
        onClear={() => {
          setCell(null);
          setLevel("");
          setStatus("");
        }}
      />

      {/* Below md the register is a list of stacked cards (design §15), so nothing scrolls sideways. */}
      <ul aria-label="Risk register" className="space-y-3 md:hidden">
        {rows.length === 0 && <li className="rounded-md border border-line bg-surface px-4 py-6 text-center text-body text-fg-muted">No risks match these filters.</li>}
        {rows.map((r) => (
          <li key={r.id} className="rounded-md border border-line bg-surface">
            <div className="space-y-3 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-body font-medium text-fg-strong">
                  <span className="mr-2 font-mono">{r.key}</span>
                  <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="text-left underline-offset-2 hover:underline">
                    {r.title}
                  </button>
                </p>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-small ring-1 ring-inset tabular-nums ${LEVEL_CLASS[r.level]}`}>
                  {r.score} {LEVEL_TEXT[r.level]}
                </span>
              </div>
              {readOnly ? (
                <p className="text-small text-fg">
                  Likelihood {likelihoodText(r.likelihood)} · Impact {impactText(r.impact)}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <RatingSelect key={`ml-${r.version}`} risk={r} field="likelihood" onSaved={saved} visibleLabel />
                  <RatingSelect key={`mi-${r.version}`} risk={r} field="impact" onSaved={saved} visibleLabel />
                </div>
              )}
              <p className="text-small text-fg">
                <span className="font-medium text-fg-strong">Mitigation:</span> {r.mitigation.test_types.map((t) => TYPE_NAMES[t]).join(", ") || <span className="text-danger-fg">None</span>}
                {" · "}
                <span className="capitalize">{r.status}</span>
              </p>
            </div>
            {open === r.id && <RiskDetails risk={r} inScopeTypes={inScopeTypes} readOnly={readOnly} onSaved={saved} />}
          </li>
        ))}
      </ul>
      <Card className="hidden md:block">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line text-small" aria-label="Risk register">
            <thead className="bg-elevated">
              <tr className="text-left text-caption uppercase tracking-[0.04em] text-fg-muted">
                <th scope="col" className="px-4 py-2.5">ID</th>
                <th scope="col" className="px-4 py-2.5">Risk</th>
                <th scope="col" className="px-4 py-2.5">Likelihood</th>
                <th scope="col" className="px-4 py-2.5">Impact</th>
                <th scope="col" className="px-4 py-2.5">Score</th>
                <th scope="col" className="px-4 py-2.5">Mitigation (test types)</th>
                <th scope="col" className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-surface">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-body text-fg-muted">
                    No risks match these filters.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td className="px-4 py-3 font-mono text-fg-strong">{r.key}</td>
                    <th scope="row" className="px-4 py-3 text-left font-medium text-fg-strong">
                      <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="text-left underline-offset-2 hover:underline">
                        {r.title}
                      </button>
                      {r.features.length > 0 && <span className="block text-caption font-normal text-fg-muted">Features: {r.features.map((f) => f.label || f.key).join(" · ")}</span>}
                    </th>
                    <td className="px-4 py-3">{readOnly ? likelihoodText(r.likelihood) : <RatingSelect key={`l-${r.version}`} risk={r} field="likelihood" onSaved={saved} />}</td>
                    <td className="px-4 py-3">{readOnly ? impactText(r.impact) : <RatingSelect key={`i-${r.version}`} risk={r} field="impact" onSaved={saved} />}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset tabular-nums ${LEVEL_CLASS[r.level]}`}>
                        {r.score} {LEVEL_TEXT[r.level]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-fg">{r.mitigation.test_types.map((t) => TYPE_NAMES[t]).join(", ") || <span className="text-danger-fg">None</span>}</td>
                    <td className="px-4 py-3 capitalize text-fg">{r.status}</td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <RiskDetails risk={r} inScopeTypes={inScopeTypes} readOnly={readOnly} onSaved={saved} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <AddRisk open={adding} onClose={() => setAdding(false)} projectId={projectId} inScopeTypes={inScopeTypes} onCreated={onChanged} />
    </div>
  );
}
