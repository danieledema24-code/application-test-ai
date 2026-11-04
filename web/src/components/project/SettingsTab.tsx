"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import type { AppType, ProjectDetail } from "@/lib/types";
import { Button, Card, CardBody, CardHeader, InlineError, Modal, SelectField, TextArea, TextField, useToast } from "@/components/ui";

export function SettingsTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({
    name: project.name,
    description: project.description || "",
    applicationUrl: project.applicationUrl || "",
    applicationType: project.applicationType,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/projects/${project.id}`, { method: "PATCH", body: f });
      toast("Project updated");
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/projects/${project.id}`, { method: "DELETE", body: { confirmName } });
      toast(`Project “${project.name}” deleted`);
      router.push("/projects");
    } catch (err) {
      setDeleteError(err);
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader title="Project details" />
        <CardBody>
          <form onSubmit={save} className="space-y-4">
            <TextField label="Project name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <TextArea label="Description" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <TextField label="Application URL" type="url" value={f.applicationUrl} onChange={(e) => setF({ ...f, applicationUrl: e.target.value })} />
              <SelectField
                label="Application type"
                value={f.applicationType}
                onChange={(e) => setF({ ...f, applicationType: e.target.value as AppType })}
                options={[
                  { value: "WEB", label: "Web application" },
                  { value: "API", label: "API" },
                ]}
              />
            </div>
            <InlineError error={error} />
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card className="border-red-200">
        <CardHeader title={<span className="text-red-800">Danger zone</span>} />
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-900">Delete this project</p>
            <p className="text-sm text-slate-600">Permanently deletes all test cases, runs, results, evidence files, defects and reports.</p>
          </div>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete project
          </Button>
        </CardBody>
      </Card>

      <Modal
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setConfirmName("");
        }}
        title="Delete project permanently?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} disabled={confirmName !== project.name} onClick={remove}>
              Delete project
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="flex gap-2 rounded-md bg-red-50 p-3 text-sm text-red-900">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> This cannot be undone. All data and evidence for this project will be removed.
          </p>
          <TextField
            label={
              <>
                Type <strong className="font-mono">{project.name}</strong> to confirm
              </>
            }
            autoComplete="off"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
          />
          <InlineError error={deleteError} />
        </div>
      </Modal>
    </div>
  );
}
