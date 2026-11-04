"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Defect, DefectDraft, Priority, Project, Severity } from "@/lib/types";
import { ENV_NAMES, PRIORITIES, SEVERITIES } from "@/lib/types";
import { Button, InlineError, Modal, SelectField, TextArea, TextField, useToast } from "@/components/ui";
import { AiDraftBadge } from "./AiBits";

// environmentName is free text in the API (e.g. "STAGING (https://…)"); keep any existing value selectable.
const envOptions = (current: string) => (current && !(ENV_NAMES as string[]).includes(current) ? [current, ...ENV_NAMES] : [...ENV_NAMES]);

type FormState = {
  projectId: string;
  title: string;
  description: string;
  severity: Severity;
  priority: Priority;
  reproductionSteps: string;
  expectedResult: string;
  actualResult: string;
  environmentName: string;
};

function fromDraft(d: DefectDraft | null | undefined, projectId: string): FormState {
  return {
    projectId: d?.projectId || projectId,
    title: d?.title || "",
    description: d?.description || "",
    severity: (d?.severity as Severity) || "MEDIUM",
    priority: (d?.priority as Priority) || "MEDIUM",
    reproductionSteps: Array.isArray(d?.reproductionSteps) ? d!.reproductionSteps.join("\n") : (d?.reproductionSteps as unknown as string) || "",
    expectedResult: d?.expectedResult || "",
    actualResult: d?.actualResult || "",
    environmentName: d?.environmentName || "",
  };
}

export function DefectFormModal({
  open,
  onClose,
  projectId = "",
  testResultId,
  draft,
  draftLoading,
  draftError,
  aiDrafted,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  testResultId?: string;
  draft?: DefectDraft | null;
  draftLoading?: boolean;
  draftError?: unknown;
  /** Show the "AI draft" badge since fields were prefilled by AI. */
  aiDrafted?: boolean;
  onCreated?: (d: Defect) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromDraft(draft, projectId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notes, setNotes] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [notesDrafted, setNotesDrafted] = useState(false);
  const { data: projects } = useApi<Project[]>(open && !projectId ? "/projects" : null);

  useEffect(() => {
    if (open) {
      setForm(fromDraft(draft, projectId));
      setError(null);
      setNotesDrafted(false);
    }
  }, [open, draft, projectId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function draftFromNotes() {
    if (!form.projectId) {
      setError("Choose a project first.");
      return;
    }
    if (!notes.trim()) return;
    setDrafting(true);
    setError(null);
    try {
      const d = await api<DefectDraft>("/ai/defect-from-notes", { body: { projectId: form.projectId, notes } });
      setForm((f) => ({ ...fromDraft(d, f.projectId), environmentName: d.environmentName || f.environmentName }));
      setNotesDrafted(true);
    } catch (e) {
      setError(e);
    } finally {
      setDrafting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api<Defect>("/defects", {
        body: {
          projectId: form.projectId,
          ...(testResultId ? { testResultId } : {}),
          title: form.title,
          description: form.description,
          severity: form.severity,
          priority: form.priority,
          reproductionSteps: form.reproductionSteps
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          expectedResult: form.expectedResult,
          actualResult: form.actualResult,
          environmentName: form.environmentName,
        },
      });
      toast(`Defect ${created.key} created`);
      onClose();
      if (onCreated) onCreated(created);
      else router.push(`/defects/${created.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Create defect"
      description={testResultId ? "Prefilled from the failed test result. Review every field before saving." : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="defect-form" loading={saving} disabled={draftLoading}>
            Create defect
          </Button>
        </>
      }
    >
      {draftLoading ? (
        <p className="text-sm text-slate-600" role="status">
          Preparing draft from the failure…
        </p>
      ) : (
        <form id="defect-form" onSubmit={submit} className="space-y-4">
          {draftError ? <InlineError error={draftError} /> : null}
          {(aiDrafted || notesDrafted) && <AiDraftBadge />}
          {!projectId && (
            <SelectField
              label="Project"
              required
              value={form.projectId}
              onChange={(e) => set("projectId", e.target.value)}
              placeholder="Select a project"
              options={(projects || []).map((p) => ({ value: p.id, label: p.name }))}
            />
          )}
          {!testResultId && (
            <details open className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-800">
                <Sparkles className="mr-1 inline h-4 w-4 text-violet-600" aria-hidden />
                Draft defect from my notes
              </summary>
              <div className="mt-3 space-y-2">
                <TextArea
                  label="Your notes"
                  hint="Paste rough notes; AI will structure them into the fields below for you to review."
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <Button size="sm" variant="secondary" onClick={draftFromNotes} loading={drafting} disabled={!notes.trim()}>
                  Draft fields
                </Button>
              </div>
            </details>
          )}
          <TextField label="Title" required value={form.title} onChange={(e) => set("title", e.target.value)} />
          <TextArea label="Description" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField label="Severity" value={form.severity} onChange={(e) => set("severity", e.target.value as Severity)} options={SEVERITIES} />
            <SelectField label="Priority" value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)} options={PRIORITIES} />
            <SelectField
              label="Environment"
              value={form.environmentName}
              onChange={(e) => set("environmentName", e.target.value)}
              placeholder="Not specified"
              options={envOptions(form.environmentName)}
            />
          </div>
          <TextArea
            label="Reproduction steps"
            hint="One step per line."
            rows={4}
            value={form.reproductionSteps}
            onChange={(e) => set("reproductionSteps", e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextArea label="Expected result" rows={3} value={form.expectedResult} onChange={(e) => set("expectedResult", e.target.value)} />
            <TextArea label="Actual result" rows={3} value={form.actualResult} onChange={(e) => set("actualResult", e.target.value)} />
          </div>
          <InlineError error={error} />
        </form>
      )}
    </Modal>
  );
}
