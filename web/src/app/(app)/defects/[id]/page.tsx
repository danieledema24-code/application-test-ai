"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, humanize, personName } from "@/lib/format";
import type { Defect, DefectStatus, Priority, Severity } from "@/lib/types";
import { DEFECT_STATUSES, ENV_NAMES, PRIORITIES, SEVERITIES } from "@/lib/types";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  InlineError,
  LoadingBlock,
  PageHeader,
  SelectField,
  StatusPill,
  TextArea,
  TextField,
  useToast,
} from "@/components/ui";
import { EvidenceGallery } from "@/components/domain/Evidence";
import { FailureAnalysisCard } from "@/components/domain/AiBits";

// environmentName is free text in the API (e.g. "STAGING (https://…)"); keep any existing value selectable.
const envOptions = (current: string) => (current && !(ENV_NAMES as string[]).includes(current) ? [current, ...ENV_NAMES] : [...ENV_NAMES]);

// Suggested next statuses (the API accepts any; this only orders the dropdown helpfully).
const NEXT: Record<DefectStatus, DefectStatus[]> = {
  OPEN: ["IN_PROGRESS", "FIXED", "CLOSED"],
  IN_PROGRESS: ["FIXED", "OPEN", "CLOSED"],
  FIXED: ["RETEST_REQUIRED", "CLOSED", "REOPENED"],
  RETEST_REQUIRED: ["CLOSED", "REOPENED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["IN_PROGRESS", "FIXED", "CLOSED"],
};

type Form = {
  title: string;
  description: string;
  severity: Severity;
  priority: Priority;
  environmentName: string;
  reproductionSteps: string;
  expectedResult: string;
  actualResult: string;
};

const toForm = (d: Defect): Form => ({
  title: d.title,
  description: d.description || "",
  severity: d.severity,
  priority: d.priority,
  environmentName: d.environmentName || "",
  reproductionSteps: (d.reproductionSteps || []).join("\n"),
  expectedResult: d.expectedResult || "",
  actualResult: d.actualResult || "",
});

export default function DefectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: d, error, isLoading, mutate } = useApi<Defect>(`/defects/${id}`);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (d && !editing) setForm(toForm(d));
  }, [d, editing]);

  if (error && !d)
    return (
      <Card>
        <ErrorState error={error} onRetry={() => mutate()} />
      </Card>
    );
  if (isLoading || !d || !form) return <LoadingBlock label="Loading defect…" />;

  async function changeStatus(status: DefectStatus) {
    setStatusBusy(true);
    try {
      await api(`/defects/${id}`, { method: "PATCH", body: { status } });
      toast(`Status changed to ${humanize(status).toLowerCase()}`);
      await mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setStatusBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/defects/${id}`, {
        method: "PATCH",
        body: {
          ...form,
          reproductionSteps: form.reproductionSteps
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      toast("Defect updated");
      setEditing(false);
      await mutate();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/defects/${id}`, { method: "DELETE" });
      toast(`${d!.key} deleted`);
      router.push("/defects");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  const statusOptions = [d.status, ...NEXT[d.status].filter((s) => s !== d.status), ...DEFECT_STATUSES.filter((s) => s !== d.status && !NEXT[d.status].includes(s))];
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/defects" className="hover:underline">
            Defects
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base text-fg-muted">{d.key}</span> {d.title}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={d.status} />
            <StatusPill status={d.severity} label={`${humanize(d.severity)} severity`} />
            <StatusPill status={d.priority} dot={false} label={`${humanize(d.priority)} priority`} />
          </span>
        }
        actions={
          <>
            <SelectField
              label="Status"
              hideLabel
              wrapClassName="w-48"
              value={d.status}
              disabled={statusBusy}
              onChange={(e) => changeStatus(e.target.value as DefectStatus)}
              options={statusOptions.map((s) => ({ value: s, label: s === d.status ? `Status: ${humanize(s)}` : `→ ${humanize(s)}` }))}
            />
            {!editing && (
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" aria-hidden />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button variant="ghost" aria-label="Delete defect" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirmDelete(true)} />
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              {editing ? (
                <form onSubmit={save} className="space-y-4">
                  <TextField label="Title" required value={form.title} onChange={(e) => set("title", e.target.value)} />
                  <TextArea label="Description" rows={4} value={form.description} onChange={(e) => set("description", e.target.value)} />
                  <div className="grid gap-4 sm:grid-cols-3">
                    <SelectField label="Severity" value={form.severity} onChange={(e) => set("severity", e.target.value as Severity)} options={SEVERITIES} />
                    <SelectField label="Priority" value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)} options={PRIORITIES} />
                    <SelectField label="Environment" value={form.environmentName} onChange={(e) => set("environmentName", e.target.value)} placeholder="Not specified" options={envOptions(form.environmentName)} />
                  </div>
                  <TextArea label="Reproduction steps" hint="One step per line." rows={5} value={form.reproductionSteps} onChange={(e) => set("reproductionSteps", e.target.value)} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextArea label="Expected result" rows={3} value={form.expectedResult} onChange={(e) => set("expectedResult", e.target.value)} />
                    <TextArea label="Actual result" rows={3} value={form.actualResult} onChange={(e) => set("actualResult", e.target.value)} />
                  </div>
                  <InlineError error={saveError} />
                  <div className="flex gap-2">
                    <Button type="submit" loading={saving}>
                      Save
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="space-y-5 text-sm">
                  <p className="whitespace-pre-wrap text-fg">{d.description || <span className="text-fg-muted">No description.</span>}</p>
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Reproduction steps</h3>
                    {d.reproductionSteps?.length ? (
                      <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-fg">
                        {d.reproductionSteps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-1 text-fg-muted">None recorded.</p>
                    )}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Expected result</h3>
                      <p className="mt-1 whitespace-pre-wrap text-fg">{d.expectedResult || "—"}</p>
                    </div>
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Actual result</h3>
                      <p className="mt-1 whitespace-pre-wrap text-fg">{d.actualResult || "—"}</p>
                    </div>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={`Evidence (${d.evidence?.length || 0})`} />
            <CardBody>
              <EvidenceGallery evidence={d.evidence || []} />
            </CardBody>
          </Card>

          {d.aiAnalysis && <FailureAnalysisCard analysis={d.aiAnalysis} title="AI analysis of the linked failure" />}
        </div>

        <Card className="self-start">
          <CardHeader title="Information" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              {[
                ["Project", <Link key="p" href={`/projects/${d.projectId}`} className="text-fg-strong hover:underline">{d.projectName}</Link>],
                ["Environment", d.environmentName ? <StatusPill key="e" status={d.environmentName} dot={false} /> : "—"],
                ["Test case", d.testCaseId ? <Link key="t" href={`/test-cases/${d.testCaseId}`} className="text-fg-strong hover:underline">{d.testCaseKey}</Link> : "—"],
                ["Raised by", personName(d.createdBy)],
                ["Created", fmtDateTime(d.createdAt)],
                ["Updated", fmtDateTime(d.updatedAt)],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between gap-4">
                  <dt className="text-fg-muted">{k}</dt>
                  <dd className="text-right font-medium text-fg-strong">{v}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} danger title={`Delete ${d.key}?`} confirmLabel="Delete">
        This permanently deletes the defect.
      </ConfirmDialog>
    </>
  );
}
