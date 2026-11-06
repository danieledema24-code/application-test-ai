"use client";

import { useState } from "react";
import { AlertTriangle, Globe, KeyRound, Pencil, Plus, ShieldCheck, ShieldAlert, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { EnvName, Environment, ProjectDetail } from "@/lib/types";
import { ENV_NAMES } from "@/lib/types";
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, InlineError, Modal, SelectField, StatusPill, TextArea, TextField, useToast } from "@/components/ui";

type Form = {
  name: EnvName;
  baseUrl: string;
  configuration: string;
  username: string;
  password: string;
  apiKey: string;
  bearerToken: string;
  playwrightWsEndpoint: string;
  recordVideo: boolean;
  workers: string;
  slowMoMs: string;
  authorised: boolean;
  allowDestructive: boolean;
  clearCredentials: boolean;
};

/** Configuration keys edited through dedicated controls rather than the JSON box. */
const MANAGED_CONFIG_KEYS = ["recordVideo", "workers", "slowMoMs"] as const;
const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 8;

function otherConfig(configuration: Record<string, unknown> | undefined) {
  const rest = { ...(configuration || {}) };
  for (const k of MANAGED_CONFIG_KEYS) delete rest[k];
  return rest;
}

function initialForm(env?: Environment | null): Form {
  const cfg = env?.configuration || {};
  const rest = otherConfig(cfg);
  return {
    name: env?.name || "STAGING",
    baseUrl: env?.baseUrl || "",
    configuration: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "",
    username: "",
    password: "",
    apiKey: "",
    bearerToken: "",
    playwrightWsEndpoint: "",
    recordVideo: typeof cfg.recordVideo === "boolean" ? cfg.recordVideo : true,
    workers: String(typeof cfg.workers === "number" ? cfg.workers : DEFAULT_WORKERS),
    slowMoMs: String(typeof cfg.slowMoMs === "number" ? cfg.slowMoMs : 0),
    // Re-confirmation is required on every save.
    authorised: false,
    allowDestructive: env?.allowDestructive ?? true,
    clearCredentials: false,
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
    let extra: Record<string, unknown> = {};
    if (f.configuration.trim()) {
      try {
        const parsed: unknown = JSON.parse(f.configuration);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return setError("Configuration must be a JSON object.");
        extra = parsed as Record<string, unknown>;
      } catch {
        return setError("Configuration must be valid JSON.");
      }
    }
    const workers = Number(f.workers);
    if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) {
      return setError(`Parallel workers must be a whole number from 1 to ${MAX_WORKERS}.`);
    }
    const slowMoMs = Number(f.slowMoMs || 0);
    if (!Number.isInteger(slowMoMs) || slowMoMs < 0 || slowMoMs > 3000) return setError("Slow motion must be a whole number of milliseconds from 0 to 3000.");
    const ws = f.playwrightWsEndpoint.trim();
    if (ws && !/^wss?:\/\//i.test(ws)) return setError("The remote Playwright endpoint must start with wss:// or ws://.");
    // Merge the dedicated controls into the rest of the configuration so other keys are kept.
    const configuration: Record<string, unknown> = { ...extra, recordVideo: f.recordVideo, workers, slowMoMs };
    const creds = Object.fromEntries(
      Object.entries({
        username: f.username,
        password: f.password,
        apiKey: f.apiKey,
        bearerToken: f.bearerToken,
        playwrightWsEndpoint: f.playwrightWsEndpoint,
      })
        .map(([k, v]) => [k, k === "playwrightWsEndpoint" ? v.trim() : v] as const)
        .filter(([, v]) => v.trim() !== ""),
    );
    // Blank fields keep stored values, so removal is explicit: an empty string deletes each stored credential.
    const cleared = { username: "", password: "", apiKey: "", bearerToken: "", apiKeyHeader: "", playwrightWsEndpoint: "" };
    const body = {
      name: f.name,
      baseUrl: f.baseUrl,
      configuration,
      ...(f.clearCredentials ? { credentials: cleared } : Object.keys(creds).length ? { credentials: creds } : {}),
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
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
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

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium text-fg">
            <KeyRound className="mr-1 inline h-4 w-4 text-fg-muted" aria-hidden />
            Credentials (write-only)
          </legend>
          <p className="mb-3 text-xs text-fg-muted">
            Credentials are encrypted and never shown again.
            {env?.hasCredentials ? " Credentials are currently stored — leave fields blank to keep them." : ""}
          </p>
          {env?.hasCredentials && (
            <Checkbox
              className="mb-3"
              label="Remove all stored credentials"
              description="Deletes the stored username, password, API key, bearer token and remote browser endpoint when you save."
              checked={f.clearCredentials}
              onChange={(e) => set("clearCredentials", e.target.checked)}
            />
          )}
          <fieldset disabled={f.clearCredentials} className="grid gap-3 disabled:opacity-50 sm:grid-cols-2">
            <TextField label="Username" autoComplete="off" value={f.username} onChange={(e) => set("username", e.target.value)} />
            <TextField label="Password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
            <TextField label="API key" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
            <TextField label="Bearer token" type="password" autoComplete="off" value={f.bearerToken} onChange={(e) => set("bearerToken", e.target.value)} />
            <TextField
              wrapClassName="sm:col-span-2"
              label="Remote Playwright endpoint (wsEndpoint)"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              placeholder={env?.hasRemoteBrowser ? "Stored — leave blank to keep" : "wss://…"}
              hint="Optional. Run automated tests on a remote Playwright browser server or cloud grid (wss://…) instead of a local browser."
              className="font-mono"
              value={f.playwrightWsEndpoint}
              onChange={(e) => set("playwrightWsEndpoint", e.target.value)}
            />
          </fieldset>
        </fieldset>

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium text-fg">Automated runs</legend>
          <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_10rem_14rem]">
            <Checkbox
              label="Record video"
              description="Save a full video of every automated test as evidence."
              checked={f.recordVideo}
              onChange={(e) => set("recordVideo", e.target.checked)}
            />
            <TextField
              label="Parallel workers"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_WORKERS}
              step={1}
              required
              hint={`1–${MAX_WORKERS}`}
              value={f.workers}
              onChange={(e) => set("workers", e.target.value)}
            />
            <TextField
              label="Slow motion (ms per action)"
              type="number"
              inputMode="numeric"
              min={0}
              max={3000}
              step={100}
              hint="0 = full speed. 300–800 makes the live view easy to follow. Local browsers only."
              value={f.slowMoMs}
              onChange={(e) => set("slowMoMs", e.target.value)}
            />
          </div>
        </fieldset>

        <TextArea
          label="Additional configuration (optional JSON)"
          hint="Other settings, e.g. timeoutMs or loginPath. The settings above take precedence."
          mono
          rows={4}
          placeholder='{ "loginPath": "/login", "timeoutMs": 30000 }'
          value={f.configuration}
          onChange={(e) => set("configuration", e.target.value)}
        />

        <div className="rounded-lg border border-line-strong bg-elevated p-3">
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill status={e.name} />
                  {e.hasRemoteBrowser && (
                    <Badge tone="blue" title="Automated runs connect to a remote Playwright browser (wsEndpoint)">
                      <Globe className="h-3 w-3" aria-hidden /> Remote browser
                    </Badge>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label={`Edit ${e.name} environment`} icon={<Pencil className="h-4 w-4" aria-hidden />} />
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(e)} aria-label={`Delete ${e.name} environment`} icon={<Trash2 className="h-4 w-4" aria-hidden />} />
                </div>
              </div>
              <p className="mt-3 break-all font-mono text-sm text-fg-strong">{e.baseUrl}</p>
              <ul className="mt-4 space-y-1.5 text-sm">
                <li className="flex items-center gap-2">
                  {e.authorised ? (
                    <>
                      <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden /> <span className="text-fg">Authorisation confirmed</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden /> <span className="text-amber-200">Authorisation not confirmed — edit to confirm</span>
                    </>
                  )}
                </li>
                <li className="flex items-center gap-2 text-fg">
                  <KeyRound className="h-4 w-4 text-fg-muted" aria-hidden /> {e.hasCredentials ? "Credentials stored" : "No credentials"}
                </li>
                {(e.name === "PRODUCTION" || !e.allowDestructive) && (
                  <li className="flex items-center gap-2 text-fg">
                    <AlertTriangle className={`h-4 w-4 ${e.allowDestructive ? "text-red-400" : "text-amber-400"}`} aria-hidden />
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
