"use client";

import { useEffect, useState } from "react";
import { api, fileUrl } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Report, TestRun } from "@/lib/types";
import { Button, InlineError, Modal, SelectField, useToast } from "@/components/ui";
import { ProjectSelect } from "./ProjectSelect";

export function GenerateReportModal({
  open,
  onClose,
  projectId: fixedProjectId,
  testRunId: fixedRunId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  testRunId?: string;
  onCreated?: (r: Report) => void;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState(fixedProjectId || "");
  const [runId, setRunId] = useState(fixedRunId || "");
  const [format, setFormat] = useState<"PDF" | "CSV">("PDF");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<Report | null>(null);

  useEffect(() => {
    if (open) {
      setProjectId(fixedProjectId || "");
      setRunId(fixedRunId || "");
      setCreated(null);
      setError(null);
    }
  }, [open, fixedProjectId, fixedRunId]);

  const { data: runs } = useApi<TestRun[]>(open && projectId ? "/test-runs" : null, { projectId, limit: 50 });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api<Report>("/reports", { body: { projectId, format, ...(runId ? { testRunId: runId } : {}) } });
      setCreated(r);
      toast("Report generated");
      onCreated?.(r);
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
      title="Generate report"
      description="Reports are built only from recorded results."
      footer={
        created ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <a href={fileUrl(created.downloadUrl || `/reports/${created.id}/download`)} className="inline-flex h-9 items-center rounded-md bg-blue-700 px-3.5 text-sm font-medium text-white hover:bg-blue-800">
              Download {created.format}
            </a>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="report-form" loading={saving} disabled={!projectId}>
              Generate
            </Button>
          </>
        )
      }
    >
      {created ? (
        <p className="text-sm text-slate-700" role="status">
          <span className="font-medium">{created.title}</span> is ready.
        </p>
      ) : (
        <form id="report-form" onSubmit={submit} className="space-y-4">
          {!fixedProjectId && (
            <ProjectSelect
              value={projectId}
              onChange={(id) => {
                setProjectId(id);
                setRunId("");
              }}
              required
            />
          )}
          {!fixedRunId && (
            <SelectField
              label="Test run (optional)"
              hint="Leave empty for a whole-project report."
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              placeholder="Whole project"
              disabled={!projectId}
              options={(runs || []).map((r) => ({ value: r.id, label: `${r.key} · ${r.name}` }))}
            />
          )}
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-800">Format</legend>
            <div className="flex gap-4">
              {(["PDF", "CSV"] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm text-slate-800">
                  <input type="radio" name="report-format" value={f} checked={format === f} onChange={() => setFormat(f)} className="accent-blue-700" />
                  {f}
                </label>
              ))}
            </div>
          </fieldset>
          <InlineError error={error} />
        </form>
      )}
    </Modal>
  );
}
