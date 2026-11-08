"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { AppType, Project } from "@/lib/types";
import { Button, Checkbox, InlineError, Modal, SelectField, TextField, useToast } from "@/components/ui";

const EMPTY = { name: "", applicationUrl: "", applicationType: "WEB" as AppType, authorised: false };

export function NewProjectModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (p: Project) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const p = await api<Project>("/projects", {
        body: {
          name: form.name.trim() || hostOf(form.applicationUrl),
          applicationUrl: form.applicationUrl,
          applicationType: form.applicationType,
          authorised: form.authorised,
        },
      });
      toast(`Project “${p.name}” created`);
      setForm(EMPTY);
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
      title="Test a new site"
      description="Paste the address of the website or API you want to test. You can add more addresses (like a staging copy) later."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-project-form" loading={saving}>
            Create and continue
          </Button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={submit} className="space-y-4">
        <TextField
          label="Website address"
          type="url"
          required
          placeholder="https://www.example.com"
          value={form.applicationUrl}
          onChange={(e) => setForm({ ...form, applicationUrl: e.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name (optional)"
            placeholder={hostOf(form.applicationUrl) || "My site"}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <SelectField
            label="What is it?"
            value={form.applicationType}
            onChange={(e) => setForm({ ...form, applicationType: e.target.value as AppType })}
            options={[
              { value: "WEB", label: "A website or web app" },
              { value: "API", label: "An API" },
            ]}
          />
        </div>
        <Checkbox
          label="I own this site or have permission to test it"
          description="Tests open pages and can fill in forms, so only test sites you’re allowed to."
          checked={form.authorised}
          onChange={(e) => setForm({ ...form, authorised: e.target.checked })}
        />
        <InlineError error={error} />
      </form>
    </Modal>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
