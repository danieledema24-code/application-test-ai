"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ProjectDetail, TestCase, TestRun } from "@/lib/types";
import { Button, Checkbox, InlineError, Modal, SelectField, StatusPill, TextField, useToast, inputClass } from "@/components/ui";
import { ProjectSelect } from "./ProjectSelect";
import { ConfirmPermission } from "./ConfirmPermission";

type RunType = "MANUAL" | "AUTOMATED" | "API";

export function NewRunModal({
  open,
  onClose,
  projectId: fixedProjectId,
  preselectedCaseIds,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  preselectedCaseIds?: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [projectId, setProjectId] = useState(fixedProjectId || "");
  const [type, setType] = useState<RunType>("AUTOMATED");
  const [envId, setEnvId] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(preselectedCaseIds || []));
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Reset only when the dialog transitions to open (props may be new arrays each render).
  const preselectedRef = useRef(preselectedCaseIds);
  preselectedRef.current = preselectedCaseIds;
  useEffect(() => {
    if (open) {
      setProjectId(fixedProjectId || "");
      setSelected(new Set(preselectedRef.current || []));
      setError(null);
    }
  }, [open, fixedProjectId]);

  const { data: project, mutate: reloadProject } = useApi<ProjectDetail>(open && projectId ? `/projects/${projectId}` : null);
  const { data: cases, isLoading: casesLoading } = useApi<TestCase[]>(open && projectId ? `/projects/${projectId}/test-cases` : null);

  useEffect(() => {
    if (project && !project.environments.some((e) => e.id === envId)) {
      setEnvId(project.environments.find((e) => e.authorised)?.id || project.environments[0]?.id || "");
    }
  }, [project, envId]);

  const eligible = useMemo(() => {
    const list = (cases || []).filter((c) => c.status === "APPROVED" || c.status === "READY");
    const q = filter.toLowerCase();
    return q ? list.filter((c) => `${c.key} ${c.title} ${c.category}`.toLowerCase().includes(q)) : list;
  }, [cases, filter]);

  // With nothing preselected, tick every runnable case: running everything is what most people want.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (!open) autoSelected.current = false;
    else if (!autoSelected.current && cases && !preselectedRef.current?.length) {
      autoSelected.current = true;
      setSelected(new Set(cases.filter((c) => c.status === "APPROVED" || c.status === "READY").map((c) => c.id)));
    }
  }, [open, cases]);

  const env = project?.environments.find((e) => e.id === envId);
  const allSelected = eligible.length > 0 && eligible.every((c) => selected.has(c.id));

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ids = eligible.filter((c) => selected.has(c.id)).map((c) => c.id);
    if (ids.length === 0) return setError("Select at least one approved or ready test case.");
    setSaving(true);
    setError(null);
    try {
      const run = await api<TestRun>(`/projects/${projectId}/test-runs`, {
        body: { executionType: type, environmentId: envId, testCaseIds: ids, ...(name.trim() ? { name: name.trim() } : {}) },
      });
      toast(`${run.key} ${type === "MANUAL" ? "started" : "queued"}`);
      onClose();
      router.push(`/test-runs/${run.id}`);
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
      title="Run tests"
      description="Runs the checks you’ve approved against your site."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-run-form" loading={saving} disabled={!projectId || !envId}>
            {type === "MANUAL" ? "Start manual run" : `Run ${eligible.filter((c) => selected.has(c.id)).length || ""} checks`.replace("  ", " ")}
          </Button>
        </>
      }
    >
      <form id="new-run-form" onSubmit={submit} className="space-y-4">
        {!fixedProjectId && <ProjectSelect value={projectId} onChange={(id) => setProjectId(id)} required />}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Execution type"
            value={type}
            onChange={(e) => setType(e.target.value as RunType)}
            options={[
              { value: "AUTOMATED", label: "Automated (Playwright)" },
              { value: "MANUAL", label: "Manual" },
              { value: "API", label: "API" },
            ]}
          />
          <SelectField
            label="Environment"
            value={envId}
            onChange={(e) => setEnvId(e.target.value)}
            required
            placeholder={project ? "Select environment" : "Select a project first"}
            options={(project?.environments || []).map((e) => ({
              value: e.id,
              label: `${e.name} — ${e.baseUrl}${e.authorised ? "" : " (not authorised)"}`,
            }))}
          />
        </div>
        {env && !env.authorised && <ConfirmPermission env={env} onConfirmed={() => reloadProject()} />}
        {env?.name === "PRODUCTION" && !env.allowDestructive && (
          <p className="flex gap-2 rounded-md bg-amber-500/10 p-2.5 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> Production is read-only: destructive steps will be blocked.
          </p>
        )}
        <TextField label="Run name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Release 2.4 regression" />
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-fg">Test cases</legend>
          {!projectId ? (
            <p className="text-sm text-fg-muted">Select a project to see its test cases.</p>
          ) : casesLoading ? (
            <p className="text-sm text-fg-muted">Loading test cases…</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <label htmlFor="run-case-filter" className="sr-only">
                  Filter test cases
                </label>
                <input id="run-case-filter" className={`${inputClass} max-w-xs`} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <Checkbox
                  label={`Select all (${eligible.length})`}
                  checked={allSelected}
                  onChange={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      eligible.forEach((c) => (allSelected ? n.delete(c.id) : n.add(c.id)));
                      return n;
                    })
                  }
                />
              </div>
              {eligible.length === 0 ? (
                <p className="rounded-md bg-elevated p-3 text-sm text-fg-muted">
                  Nothing to run yet. In Test Cases, tick the suggested checks you want and click Approve.
                </p>
              ) : (
                <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
                  {eligible.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox label={<span className="font-normal"><span className="font-mono text-xs text-fg-muted">{c.key}</span> {c.title} <span className="text-xs text-fg-muted">· {c.category}</span></span>} checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="flex-1" />
                      <StatusPill status={c.status} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-fg-muted">{eligible.filter((c) => selected.has(c.id)).length} selected</p>
            </>
          )}
        </fieldset>
        <InlineError error={error} />
      </form>
    </Modal>
  );
}
