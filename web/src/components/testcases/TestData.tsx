"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, MoreHorizontal, Plus } from "lucide-react";
import { api, ApiError, buildQuery, errorMessage } from "@/lib/api";
import type { SecretMeta, TestDataItem } from "@/lib/contract";
import { CASE_STATUS_TEXT, KIND_TEXT, SAVED_LOGIN_TEXT, SYNTHETIC_NOTICE, dataValueError, displayValue, coverageItemText, formAnchorLabel, formHeading, guardMessage, listText, usedByFromConflict } from "@/lib/testcases";
import { Badge, Button, Callout, Disclosure, Drawer, EmptyState, ErrorState, InlineError, LinkButton, Modal, SelectField, Skeleton, TextArea, TextField, useToast } from "@/components/ui";
import { KindBadge, ValueText } from "./Bits";

function formOf(d: TestDataItem): string {
  if (d.form?.label) return formHeading(d.form.label, d.form.path);
  // As built, the server sends `form_ref` (anchor/path); `form` stays a read-if-present extra.
  const ref = d.form_ref;
  if (ref?.path || ref?.form_anchor) return formHeading(d.feature?.label ?? formAnchorLabel(ref.form_anchor) ?? "Form", ref.path);
  return d.feature?.label ?? "Other fields";
}

function lengthText(d: TestDataItem): string {
  if (d.kind === "secret_ref") return "—";
  return String(d.length ?? displayValue(d.value).length);
}

function Value({ d }: { d: TestDataItem }) {
  if (d.kind === "secret_ref") return <span className="text-fg">{SAVED_LOGIN_TEXT}</span>;
  return <ValueText value={d.value} />;
}

function UsedBy({ d, onOpen }: { d: TestDataItem; onOpen: () => void }) {
  if (!d.used_by_count) return <span className="text-fg-muted">Not used</span>;
  return (
    <button type="button" onClick={onOpen} className="whitespace-nowrap font-medium text-navy-700 underline underline-offset-2" aria-label={`Used by ${d.used_by_count} case${d.used_by_count === 1 ? "" : "s"}: show cases using ${d.key}`}>
      Used by {d.used_by_count} case{d.used_by_count === 1 ? "" : "s"}
    </button>
  );
}

/** Inline edit (§11.2): name and value with live count, guard errors, approved-case warning. */
function EditRow({ d, onCancel, onSaved }: { d: TestDataItem; onCancel: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(d.name);
  const [value, setValue] = useState(d.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<TestDataItem | null>(null);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    api<TestDataItem>(`/test-data/${d.id}`)
      .then(setDetail)
      .catch(() => undefined);
  }, [d.id]);
  const approved = (detail?.used_by ?? []).filter((c) => c.status === "approved").map((c) => c.key);
  const approvedKeys = approved.length ? approved : (d.used_by_approved ?? []);
  const boundaryLength = d.kind === "boundary" ? (d.length ?? displayValue(d.value).length) : null;

  async function save() {
    setSaveError(null);
    if (d.kind !== "secret_ref") {
      const e = dataValueError(value, d.kind, boundaryLength);
      setError(e);
      if (e) {
        valueRef.current?.focus();
        return;
      }
    }
    const body: Record<string, unknown> = { version: d.version };
    if (name.trim() !== d.name) body.name = name.trim();
    if (d.kind !== "secret_ref" && value !== (d.value ?? "")) body.value = value;
    if (Object.keys(body).length === 1) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ item: TestDataItem; affected_cases: { key: string }[] }>(`/test-data/${d.id}`, { method: "PATCH", body });
      const n = res.affected_cases?.length ?? 0;
      toast(`${d.key} saved as version ${res.item?.version ?? d.version + 1}.${n ? ` ${n} approved case${n === 1 ? "" : "s"} moved back to Draft.` : ""}`);
      onSaved();
    } catch (err) {
      const fe = err instanceof ApiError ? err.fieldErrors.value : undefined;
      if (fe) {
        setError(guardMessage(fe));
        valueRef.current?.focus();
      } else setSaveError(`Couldn’t save ${d.key}. Your value is still here. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md bg-elevated p-3">
      <TextField label={`Name for ${d.key}`} hint="Optional label" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      {d.kind === "secret_ref" ? (
        <p className="text-body text-fg">Saved test account: {(d.secret_ref ?? "login credentials").replace(/_/g, " ")}</p>
      ) : (
        <TextArea
          ref={valueRef}
          label={`Value for ${d.key}`}
          rows={2}
          mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
          hint={`${[...value].length} character${[...value].length === 1 ? "" : "s"}`}
          error={error}
        />
      )}
      {approvedKeys.length > 0 && (
        <p className="text-body text-fg">
          Used by {approvedKeys.length} approved case{approvedKeys.length === 1 ? "" : "s"} ({approvedKeys.join(", ")}). Saving moves {approvedKeys.length === 1 ? "it" : "them"} back to Draft and Gate 5 will need approval again.
        </p>
      )}
      <InlineError error={saveError} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} loading={busy}>
          {approvedKeys.length ? "Save and reopen review" : "Save"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RowMenu({ d, onRetire, onOpen }: { d: TestDataItem; onRetire: () => void; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <Button size="sm" variant="ghost" aria-label={`More actions for ${d.key}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Button>
      {open && (
        <span className="absolute right-0 z-30 mt-1 flex w-48 flex-col rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          <button type="button" onClick={() => (setOpen(false), onOpen())} className="flex min-h-10 items-center px-4 text-left text-body text-fg-strong hover:bg-overlay">
            Details
          </button>
          {d.status === "active" && (
            <button type="button" onClick={() => (setOpen(false), onRetire())} className="flex min-h-10 items-center px-4 text-left text-body text-fg-strong hover:bg-overlay">
              Retire
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/** Test data detail drawer (`?data=TD-0004`, §11.1). */
export function TestDataDrawer({ projectId, item, onClose }: { projectId: string; item: TestDataItem | null; onClose: () => void }) {
  const [detail, setDetail] = useState<TestDataItem | null>(null);
  useEffect(() => {
    setDetail(null);
    if (!item) return;
    api<TestDataItem>(`/test-data/${item.id}`)
      .then(setDetail)
      .catch(() => setDetail(item));
  }, [item]);
  const d = detail ?? item;
  return (
    <Drawer open={!!item} onClose={onClose} title={d ? `${d.key} · ${d.field_label}` : "Test data"} subtitle={d ? formOf(d) : undefined}>
      {d && (
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-body">
          <dt className="text-fg-muted">Kind</dt>
          <dd>
            <KindBadge kind={d.kind} /> <Badge tone="blue">Synthetic</Badge>
          </dd>
          <dt className="text-fg-muted">Value</dt>
          <dd>
            <Value d={d} />
          </dd>
          <dt className="text-fg-muted">Length</dt>
          <dd>{lengthText(d)}</dd>
          <dt className="text-fg-muted">Generated</dt>
          <dd>{d.generator ? `Generated by rule: ${d.generator}` : d.generated_by === "human" ? "Written by a person" : "—"}</dd>
          <dt className="text-fg-muted">Status</dt>
          <dd>{d.status === "active" ? "Active" : "Retired"}</dd>
          {d.boundary && (
            <>
              <dt className="text-fg-muted">Condition</dt>
              <dd>
                <Link href={`/projects/${projectId}/test-cases?view=conditions&condition=${d.boundary.condition.key}`} className="font-mono text-navy-700 underline underline-offset-2">
                  {d.boundary.condition.key}
                </Link>{" "}
                ({coverageItemText(d.boundary)})
              </dd>
            </>
          )}
          <dt className="text-fg-muted">Used by</dt>
          <dd>
            {!detail ? (
              <Skeleton className="h-5 w-40" />
            ) : (d.used_by ?? []).length === 0 ? (
              "Not used"
            ) : (
              <ul className="space-y-1">
                {(d.used_by ?? []).map((c) => (
                  <li key={c.key}>
                    <Link href={`/projects/${projectId}/test-cases/${c.key}`} className="font-mono text-navy-700 underline underline-offset-2">
                      {c.key}
                    </Link>{" "}
                    {c.status ? CASE_STATUS_TEXT[c.status] : ""}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      )}
    </Drawer>
  );
}

/** Test data tab (design P3 §11): grouped by form → field, synthetic notice, inline edit, add and retire. */
export function TestDataTab({
  projectId,
  items,
  error,
  canEdit,
  canManageSecrets,
  onChanged,
  onOpen,
}: {
  projectId: string;
  items: TestDataItem[] | undefined;
  error: unknown;
  canEdit: boolean;
  canManageSecrets: boolean;
  onChanged: () => void;
  onOpen: (key: string) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState("");
  const [kind, setKind] = useState("");
  const [use, setUse] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [retire, setRetire] = useState<{ d: TestDataItem; usedBy: string[] | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  useEffect(() => {
    api<SecretMeta[]>(`/projects/${projectId}/secrets`)
      .then(setSecrets)
      .catch(() => setSecrets([]));
  }, [projectId]);

  const all = useMemo(() => items ?? [], [items]);
  const forms = [...new Set(all.map(formOf))].sort();
  const rows = all.filter((d) => {
    if (form && formOf(d) !== form) return false;
    if (kind && d.kind !== kind) return false;
    if (use === "used" && !d.used_by_count) return false;
    if (use === "unused" && d.used_by_count) return false;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      if (!d.key.toLowerCase().includes(t) && !d.field_label.toLowerCase().includes(t) && !(d.value ?? "").toLowerCase().includes(t)) return false;
    }
    return true;
  });

  if (error && !items) return <ErrorState error={error} title="Couldn’t load test data." message="Try again." onRetry={onChanged} />;
  if (!items)
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );

  async function startRetire(d: TestDataItem) {
    setRetireError(null);
    if (!d.used_by_count) {
      setRetire({ d, usedBy: null });
      return;
    }
    try {
      const det = await api<TestDataItem>(`/test-data/${d.id}`);
      setRetire({ d, usedBy: (det.used_by ?? []).filter((c) => c.status !== "deprecated").map((c) => c.key) });
    } catch {
      setRetire({ d, usedBy: [] });
    }
  }

  async function doRetire() {
    if (!retire) return;
    setBusy(true);
    try {
      await api(`/test-data/${retire.d.id}/status`, { body: { version: retire.d.version, status: "retired" } });
      toast(`${retire.d.key} retired.`);
      setRetire(null);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const keys = usedByFromConflict(err.details);
        setRetire({ d: retire.d, usedBy: keys });
      } else setRetireError(`Couldn’t retire ${retire.d.key}. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const hasSecretRef = all.some((d) => d.kind === "secret_ref");
  const noSecret = secrets !== null && !secrets.some((s) => s.kind === "login_credentials");

  // form → field → items
  const tree = new Map<string, Map<string, TestDataItem[]>>();
  for (const d of rows) {
    const f = tree.get(formOf(d)) ?? new Map<string, TestDataItem[]>();
    f.set(d.field_label, [...(f.get(d.field_label) ?? []), d]);
    tree.set(formOf(d), f);
  }

  const itemRow = (d: TestDataItem) => (
    <tr key={d.id} className="align-top">
      <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-mono font-normal text-fg-strong">
        {d.key}
      </th>
      <td className="px-3 py-2">
        <KindBadge kind={d.kind} />
      </td>
      <td className="max-w-md px-3 py-2">
        <Value d={d} />
        {d.kind === "secret_ref" && canManageSecrets && (
          <Link href={`/projects/${projectId}/settings?view=credentials`} className="ml-2 text-small font-medium text-navy-700 underline underline-offset-2">
            Manage in Project settings
          </Link>
        )}
      </td>
      <td className="px-3 py-2 tabular-nums">{lengthText(d)}</td>
      <td className="px-3 py-2">
        <UsedBy d={d} onOpen={() => onOpen(d.key)} />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {d.status === "active" ? "Active" : "Retired"}
        {d.locked && (
          <>
            {" "}
            <Lock className="inline h-3.5 w-3.5 text-fg-muted" aria-hidden />
            <span className="sr-only">Locked</span>
          </>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        {canEdit && d.status === "active" && !d.locked && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(d.id)} aria-label={`Edit ${d.key}`}>
            Edit
          </Button>
        )}
        {canEdit && <RowMenu d={d} onRetire={() => void startRetire(d)} onOpen={() => onOpen(d.key)} />}
      </td>
    </tr>
  );

  const itemCard = (d: TestDataItem) => (
    <li key={d.id} className="rounded-lg border border-line bg-surface p-3">
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-small text-fg-strong">{d.key}</span>
        <KindBadge kind={d.kind} />
      </p>
      <p className="mt-1 text-small text-fg-muted">{d.field_label}</p>
      <p className="mt-1">
        <Value d={d} />
      </p>
      <p className="mt-1 flex flex-wrap gap-x-2 text-small text-fg">
        <span>Length {lengthText(d)}</span> · <UsedBy d={d} onOpen={() => onOpen(d.key)} /> · <span>{d.status === "active" ? "Active" : "Retired"}</span>
      </p>
      {canEdit && d.status === "active" && (
        <div className="mt-2 flex gap-2">
          {!d.locked && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(d.id)} aria-label={`Edit ${d.key}`}>
              Edit
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void startRetire(d)} aria-label={`Retire ${d.key}`}>
            Retire
          </Button>
        </div>
      )}
    </li>
  );

  const fieldBlock = (field: string, list: TestDataItem[]) => {
    const used = list.filter((d) => d.used_by_count > 0 || d.kind === "secret_ref");
    const unused = list.filter((d) => !used.includes(d));
    const table = (l: TestDataItem[], label: string) => (
      <>
        <div className="hidden md:block">
          <div className="scrollbar-thin overflow-x-auto rounded-lg border border-line bg-surface" role="region" aria-label={label} tabIndex={0}>
            <table className="min-w-full divide-y divide-line text-small">
              <caption className="sr-only">{label}</caption>
              <thead className="bg-elevated">
                <tr>
                  {["Key", "Kind", "Value", "Length", "Used by", "Status"].map((h) => (
                    <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
                      {h}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {l.map((d) =>
                  editing === d.id ? (
                    <tr key={d.id}>
                      <td colSpan={7} className="px-3 py-2">
                        <EditRow
                          d={d}
                          onCancel={() => setEditing(null)}
                          onSaved={() => {
                            setEditing(null);
                            onChanged();
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    itemRow(d)
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
        <ul className="space-y-2 md:hidden" aria-label={label}>
          {l.map((d) =>
            editing === d.id ? (
              <li key={d.id}>
                <EditRow
                  d={d}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    onChanged();
                  }}
                />
              </li>
            ) : (
              itemCard(d)
            ),
          )}
        </ul>
      </>
    );
    return (
      <div key={field} className="space-y-2">
        <h3 className="text-body-lg font-semibold text-fg-strong">{field}</h3>
        {used.length > 0 && table(used, `Test data for ${field}`)}
        {unused.length > 0 && (
          <Disclosure label={`Not used (${unused.length})`}>
            <div className="mt-2">{table(unused, `Unused test data for ${field}`)}</div>
          </Disclosure>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3 [&>div]:w-full sm:[&>div]:w-44">
          <SelectField label="Form" value={form} onChange={(e) => setForm(e.target.value)} options={[{ value: "", label: "Any" }, ...forms.map((f) => ({ value: f, label: f }))]} />
          <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: "", label: "Any" }, ...Object.entries(KIND_TEXT).map(([value, label]) => ({ value, label }))]} />
          <SelectField
            label="Use"
            value={use}
            onChange={(e) => setUse(e.target.value)}
            options={[
              { value: "", label: "Any" },
              { value: "used", label: "Used" },
              { value: "unused", label: "Not used" },
            ]}
          />
          <TextField label="Search" type="search" placeholder="TD id, field or value" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {canEdit && (
          <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>
            Add test data
          </Button>
        )}
      </div>
      <Callout tone="info">{SYNTHETIC_NOTICE}</Callout>
      {hasSecretRef && noSecret && (
        <Callout
          tone="warning"
          actions={canManageSecrets ? <LinkButton href={`/projects/${projectId}/settings?view=credentials`}>Add one in Project settings</LinkButton> : undefined}
        >
          No test account is saved, so cases that sign in can only be partly automated. {canManageSecrets ? "" : "Ask an owner or admin to add one."}
        </Callout>
      )}
      {all.length === 0 ? (
        <EmptyState title="No test data yet. It’s created with the test cases." />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No test data matches these filters."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setForm("");
                setKind("");
                setUse("");
                setQ("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        [...tree.entries()].map(([f, fields]) => (
          <section key={f} aria-labelledby={`td-form-${f}`} className="space-y-3">
            <h2 id={`td-form-${f}`} className="text-h3 font-semibold text-fg-strong">
              Form · {f}
            </h2>
            {[...fields.entries()].map(([field, list]) => fieldBlock(field, list))}
          </section>
        ))
      )}
      {adding && (
        <AddTestData
          projectId={projectId}
          fields={[...new Map(all.map((d) => [`${formOf(d)}|${d.field_label}`, d])).values()]}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
      {retire && retire.usedBy && retire.usedBy.length > 0 ? (
        <Modal
          open
          onClose={() => setRetire(null)}
          title={`${retire.d.key} is in use`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRetire(null)}>
                Close
              </Button>
              <LinkButton href={`/projects/${projectId}/test-cases${buildQuery({ keys: retire.usedBy.join(","), show_hidden: "1" })}`}>Show these cases</LinkButton>
            </>
          }
        >
          <p className="text-body text-fg">
            {retire.d.key} is used by {listText(retire.usedBy, 10)}. Change those cases to use other data first.
          </p>
        </Modal>
      ) : retire ? (
        <Modal
          open
          onClose={() => setRetire(null)}
          title={`Retire ${retire.d.key}?`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRetire(null)}>
                Cancel
              </Button>
              <Button onClick={() => void doRetire()} loading={busy}>
                Retire
              </Button>
            </>
          }
        >
          <p className="text-body text-fg">It stays in history and can’t be added to new steps.</p>
          <InlineError error={retireError} />
        </Modal>
      ) : null}
    </div>
  );
}

/** Add test data (§11.3): field picker, kind, value. "Saved test account" only for password fields. */
export function AddTestData({ projectId, fields, onClose, onAdded }: { projectId: string; fields: TestDataItem[]; onClose: () => void; onAdded: (d: TestDataItem) => void }) {
  const toast = useToast();
  const [field, setField] = useState("");
  const [kind, setKind] = useState("valid");
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ field?: string; value?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  const picked = fields.find((d) => `${formOf(d)}|${d.field_label}` === field);
  const password = !!picked && (picked.kind === "secret_ref" || /password/i.test(picked.field_label));
  useEffect(() => {
    if (password) setKind("secret_ref");
    else if (kind === "secret_ref") setKind("valid");
  }, [password, kind]);

  async function submit() {
    const e: typeof errors = {};
    if (!picked) e.field = "Choose the form and field.";
    if (!password) {
      const v = dataValueError(value, kind, null);
      if (v) e.value = v;
    }
    setErrors(e);
    if (e.value) valueRef.current?.focus();
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() || picked!.field_label, field_label: picked!.field_label, kind };
      // form_ref is an object (as built): copy the picked field's reference so the new item joins its form.
      if (picked!.form_ref) body.form_ref = picked!.form_ref;
      else if (picked!.form?.path) body.form_ref = { path: picked!.form.path };
      if (password) body.secret_ref = picked!.secret_ref ?? "login_credentials";
      else body.value = value;
      const d = await api<TestDataItem>(`/projects/${projectId}/test-data`, { body });
      toast(`${d.key} created.`);
      onAdded(d);
    } catch (err) {
      const fe = err instanceof ApiError ? err.fieldErrors.value : undefined;
      if (fe) {
        setErrors({ value: guardMessage(fe) });
        valueRef.current?.focus();
      } else setError(`Couldn’t add the test data. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add test data"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Add test data
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SelectField
          label="Form and field"
          required
          value={field}
          onChange={(e) => setField(e.target.value)}
          placeholder="Choose a field"
          options={fields.map((d) => ({ value: `${formOf(d)}|${d.field_label}`, label: `${formOf(d)} · ${d.field_label}` }))}
          error={errors.field}
        />
        <SelectField
          label="Kind"
          required
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={password}
          options={password ? [{ value: "secret_ref", label: "Saved test account" }] : (["valid", "invalid", "boundary"] as const).map((k) => ({ value: k, label: KIND_TEXT[k] }))}
        />
        <TextField label="Name" hint="Optional label" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        {password ? (
          <p className="text-body text-fg">{SAVED_LOGIN_TEXT}</p>
        ) : (
          <TextArea ref={valueRef} label="Value" mono rows={2} value={value} onChange={(e) => setValue(e.target.value)} hint={`${[...value].length} characters`} error={errors.value} />
        )}
        <p className="text-small text-fg-muted">{SYNTHETIC_NOTICE}</p>
        <InlineError error={error} />
      </div>
    </Modal>
  );
}
