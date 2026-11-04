"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { AppType, EnvName, Project } from "@/lib/types";
import { ENV_NAMES } from "@/lib/types";
import { Button, InlineError, Modal, SelectField, TextArea, TextField, useToast } from "@/components/ui";

export function NewProjectModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (p: Project) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", description: "", applicationUrl: "", applicationType: "WEB" as AppType, environment: "STAGING" as EnvName });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const p = await api<Project>("/projects", {
        body: {
          name: form.name,
          description: form.description,
          applicationUrl: form.applicationUrl,
          applicationType: form.applicationType,
          environments: [{ name: form.environment, baseUrl: form.applicationUrl }],
        },
      });
      toast(`Project “${p.name}” created`);
      setForm({ name: "", description: "", applicationUrl: "", applicationType: "WEB", environment: "STAGING" });
      onClose();
      if (onCreated) onCreated(p);
      else router.push(`/projects/${p.id}`);
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
      title="New project"
      description="A project is one application under test."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-project-form" loading={saving}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={submit} className="space-y-4">
        <TextField label="Project name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextArea label="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <TextField
          label="Application URL"
          type="url"
          required
          placeholder="https://staging.example.com"
          value={form.applicationUrl}
          onChange={(e) => setForm({ ...form, applicationUrl: e.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Application type"
            value={form.applicationType}
            onChange={(e) => setForm({ ...form, applicationType: e.target.value as AppType })}
            options={[
              { value: "WEB", label: "Web application" },
              { value: "API", label: "API" },
            ]}
          />
          <SelectField
            label="Environment"
            value={form.environment}
            onChange={(e) => setForm({ ...form, environment: e.target.value as EnvName })}
            options={ENV_NAMES}
            hint="You’ll confirm authorisation before any test runs."
          />
        </div>
        <InlineError error={error} />
      </form>
    </Modal>
  );
}
