"use client";

import { useState } from "react";
import { AlertTriangle, KeyRound, Pencil, Plus, ShieldCheck, ShieldAlert, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { EnvName, Environment, ProjectDetail } from "@/lib/types";
import { ENV_NAMES } from "@/lib/types";
import { Button, Card, Checkbox, ConfirmDialog, EmptyState, InlineError, Modal, SelectField, StatusPill, TextArea, TextField, useToast } from "@/components/ui";

type Form = {
  name: EnvName;
  baseUrl: string;
  configuration: string;
  username: string;
  password: string;
  apiKey: string;
  bearerToken: string;
  authorised: boolean;
  allowDestructive: boolean;
};

function initialForm(env?: Environment | null): Form {
  return {
    name: env?.name || "STAGING",
    baseUrl: env?.baseUrl || "",
    configuration: env?.configuration && Object.keys(env.configuration).length ? JSON.stringify(env.configuration, null, 2) : "",
    username: "",
    password: "",
    apiKey: "",
    bearerToken: "",
    // Re-confirmation is required on every save.
    authorised: false,
    allowDestructive: env?.allowDestructive ?? true,
  };
}

function EnvForm({ project, env, onClose, onSaved }: { project: ProjectDetail; env: Environment | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<Form>(() => initialForm(env));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const isProd = f.name === "PRODUCTION";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.authorised) return setError("You must confirm you are authorised to test this application.");
    let configuration: Record<string, unknown> | undefined;
    if (f.configuration.trim()) {
      try {
        configuration = JSON.parse(f.configuration);
      } catch {
        return setError("Configuration must be valid JSON.");
      }
    }
    const creds = Object.fromEntries(
      Object.entries({ username: f.username, password: f.password, apiKey: f.apiKey, bearerToken: f.bearerToken }).filter(([, v]) => v.trim() !== ""),
    );
    const body = {
      name: f.name,
      baseUrl: f.baseUrl,
      ...(configuration !== undefined ? { configuration } : env ? { configuration: {} } : {}),
      ...(Object.keys(creds).length ? { credentials: creds } : {}),
      authorised: true,
      allowDestructive: f.allowDestructive,
    };
    setSaving(true);
    setError(null);
    try {
      if (env) await api(`/environments/${env.id}`, { method: "PATCH", body });
      else await api(`/projects/${project.id}/environments`, { body });
      toast(env ? "Environment updated" : "Environment added");
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={env ? `Edit ${env.name.toLowerCase()} environment` : "Add environment"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="env-form" loading={saving} disabled={!f.authorised}>
            Save environment
          </Button>
        </>
      }
    >
      <form id="env-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <SelectField
            label="Environment"
            value={f.name}
            onChange={(e) => {
              const name = e.target.value as EnvName;
              setF((x) => ({ ...x, name, allowDestructive: name === "PRODUCTION" ? false : x.allowDestructive }));
            }}
            options={ENV_NAMES}
          />
          <TextField label="Base URL" type="url" required placeholder="https://staging.example.com" value={f.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
        </div>

        {isProd && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" aria-hidden /> Production environment — read-only by default
            </p>
            <p className="mt-1">
              Tests against production will not perform destructive actions (POST/PUT/PATCH/DELETE, form submissions) unless you explicitly allow them below.
            </p>
            <Checkbox
              className="mt-3"
              label="Allow destructive actions in production"
              description="Only enable this if you understand the impact on live data."
              checked={f.allowDestructive}
              onChange={(e) => set("allowDestructive", e.target.checked)}
            />
          </div>
        )}

        {!isProd && (
          <Checkbox
            label="Allow destructive actions"
            description="Permit POST/PUT/PATCH/DELETE requests and form submissions in this environment without extra confirmation."
            checked={f.allowDestructive}
            onChange={(e) => set("allowDestructive", e.target.checked)}
          />
        )}

        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-800">
            <KeyRound className="mr-1 inline h-4 w-4 text-slate-500" aria-hidden />
            Credentials (write-only)
          </legend>
          <p className="mb-3 text-xs text-slate-600">
            Credentials are encrypted and never shown again.
            {env?.hasCredentials ? " Credentials are currently stored — leave fields blank to keep them." : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Username" autoComplete="off" value={f.username} onChange={(e) => set("username", e.target.value)} />
            <TextField label="Password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
            <TextField label="API key" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
            <TextField label="Bearer token" type="password" autoComplete="off" value={f.bearerToken} onChange={(e) => set("bearerToken", e.target.value)} />
          </div>
        </fieldset>

        <TextArea
          label="Configuration (optional JSON)"
          mono
          rows={4}
          placeholder='{ "loginPath": "/login" }'
          value={f.configuration}
          onChange={(e) => set("configuration", e.target.value)}
        />

        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <Checkbox
            required
            label="I confirm I am authorised to test this application"
            description="Testing systems you don’t own or have permission to test may be illegal."
            checked={f.authorised}
            onChange={(e) => set("authorised", e.target.checked)}
          />
        </div>
        <InlineError error={error} />
      </form>
    </Modal>
  );
}

export function EnvironmentsTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Environment | null | "new">(null);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/environments/${deleting.id}`, { method: "DELETE" });
      toast("Environment removed");
      onChanged();
      setDeleting(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setEditing("new")}>
          Add environment
        </Button>
      </div>
      {project.environments.length === 0 ? (
        <Card>
          <EmptyState title="No environments" description="Add an environment to run tests against." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {project.environments.map((e) => (
            <Card key={e.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <StatusPill status={e.name} />
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label={`Edit ${e.name} environment`} icon={<Pencil className="h-4 w-4" aria-hidden />} />
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(e)} aria-label={`Delete ${e.name} environment`} icon={<Trash2 className="h-4 w-4" aria-hidden />} />
                </div>
              </div>
              <p className="mt-3 break-all font-mono text-sm text-slate-900">{e.baseUrl}</p>
              <ul className="mt-4 space-y-1.5 text-sm">
                <li className="flex items-center gap-2">
                  {e.authorised ? (
                    <>
                      <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden /> <span className="text-slate-800">Authorisation confirmed</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden /> <span className="text-amber-900">Authorisation not confirmed — edit to confirm</span>
                    </>
                  )}
                </li>
                <li className="flex items-center gap-2 text-slate-700">
                  <KeyRound className="h-4 w-4 text-slate-500" aria-hidden /> {e.hasCredentials ? "Credentials stored" : "No credentials"}
                </li>
                {(e.name === "PRODUCTION" || !e.allowDestructive) && (
                  <li className="flex items-center gap-2 text-slate-700">
                    <AlertTriangle className={`h-4 w-4 ${e.allowDestructive ? "text-red-600" : "text-amber-600"}`} aria-hidden />
                    {e.allowDestructive ? "Destructive actions allowed" : "Read-only (destructive actions blocked)"}
                  </li>
                )}
              </ul>
            </Card>
          ))}
        </div>
      )}
      {editing && <EnvForm project={project} env={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={onChanged} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={remove} loading={busy} danger title="Delete environment?" confirmLabel="Delete">
        This removes the {deleting?.name.toLowerCase()} environment and its stored credentials.
      </ConfirmDialog>
    </div>
  );
}
