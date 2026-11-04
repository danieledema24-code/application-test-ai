"use client";

import { useState } from "react";
import { Copy, GitBranch, GitMerge, ListChecks, Plus, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import type { Integration, Webhook, WebhookDelivery, WebhookEvent } from "@/lib/types";
import { WEBHOOK_EVENTS } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DataState,
  EmptyState,
  InlineError,
  Modal,
  PageHeader,
  StatusPill,
  TBody,
  THead,
  Table,
  Td,
  TextField,
  Th,
  Tr,
  useToast,
} from "@/components/ui";

type Provider = Integration["provider"];

const PROVIDERS: { id: Provider; name: string; description: string; icon: React.ReactNode; fields: { key: "baseUrl" | "repo" | "projectKey"; label: string; placeholder: string; required?: boolean }[] }[] = [
  {
    id: "GITHUB",
    name: "GitHub",
    description: "Link runs to commits and pull requests.",
    icon: <GitBranch className="h-5 w-5" aria-hidden />,
    fields: [
      { key: "repo", label: "Repository", placeholder: "org/repo", required: true },
      { key: "baseUrl", label: "API base URL (optional)", placeholder: "https://api.github.com" },
    ],
  },
  {
    id: "GITLAB",
    name: "GitLab",
    description: "Link runs to merge requests and pipelines.",
    icon: <GitMerge className="h-5 w-5" aria-hidden />,
    fields: [
      { key: "repo", label: "Project path", placeholder: "group/project", required: true },
      { key: "baseUrl", label: "Instance URL", placeholder: "https://gitlab.com" },
    ],
  },
  {
    id: "JIRA",
    name: "Jira",
    description: "Push defects to Jira issues.",
    icon: <ListChecks className="h-5 w-5" aria-hidden />,
    fields: [
      { key: "baseUrl", label: "Site URL", placeholder: "https://your-team.atlassian.net", required: true },
      { key: "projectKey", label: "Project key", placeholder: "QA", required: true },
    ],
  },
];

function ConnectModal({ provider, onClose, onSaved }: { provider: (typeof PROVIDERS)[number]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [config, setConfig] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cfg = Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim()));
      await api("/integrations", { body: { provider: provider.id, config: cfg, token } });
      toast(`${provider.name} connected`);
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
      title={`Connect ${provider.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="integration-form" loading={saving}>
            Connect
          </Button>
        </>
      }
    >
      <form id="integration-form" onSubmit={submit} className="space-y-4">
        {provider.fields.map((f) => (
          <TextField key={f.key} label={f.label} placeholder={f.placeholder} required={f.required} value={config[f.key] || ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
        ))}
        <TextField label="Access token" type="password" autoComplete="off" required hint="Encrypted at rest and never shown again." value={token} onChange={(e) => setToken(e.target.value)} />
        <InlineError error={error} />
      </form>
    </Modal>
  );
}

function CreateWebhookModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(["run.completed"]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<Webhook | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    setUrl("");
    setCreated(null);
    setError(null);
    setCopied(false);
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (events.size === 0) return setError("Select at least one event.");
    setSaving(true);
    setError(null);
    try {
      const w = await api<Webhook>("/webhooks", { body: { url, events: Array.from(events) } });
      setCreated(w);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={created ? "Webhook created" : "New webhook"}
      footer={
        created ? (
          <Button onClick={close}>I’ve saved the secret</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="webhook-form" loading={saving}>
              Create webhook
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-3">
          <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-100">
            Copy this signing secret now. <strong>It will not be shown again.</strong>
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-3 py-2 font-mono text-xs text-fg">{created.secret || "(no secret returned)"}</code>
            {created.secret && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Copy className="h-4 w-4" aria-hidden />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created.secret!);
                    setCopied(true);
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <form id="webhook-form" onSubmit={submit} className="space-y-4">
          <TextField label="Payload URL" type="url" required placeholder="https://example.com/hooks/qa" value={url} onChange={(e) => setUrl(e.target.value)} />
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-fg">Events</legend>
            <div className="space-y-2">
              {WEBHOOK_EVENTS.map((ev) => (
                <Checkbox
                  key={ev}
                  label={<span className="font-mono text-xs">{ev}</span>}
                  checked={events.has(ev)}
                  onChange={() =>
                    setEvents((s) => {
                      const n = new Set(s);
                      if (n.has(ev)) n.delete(ev);
                      else n.add(ev);
                      return n;
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <InlineError error={error} />
        </form>
      )}
    </Modal>
  );
}

function Deliveries({ webhookId }: { webhookId: string }) {
  const { data, error, isLoading, mutate } = useApi<WebhookDelivery[]>(`/webhooks/${webhookId}/deliveries`);
  return (
    <DataState data={data} error={error} isLoading={isLoading} onRetry={() => mutate()} empty={<p className="px-4 py-3 text-sm text-fg-muted">No deliveries yet.</p>}>
      {(rows) => (
        <Table label="Webhook deliveries">
          <THead>
            <tr>
              <Th>Event</Th>
              <Th>Result</Th>
              <Th>HTTP status</Th>
              <Th>Time</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="font-mono text-xs">{r.event}</Td>
                <Td>
                  <StatusPill status={r.success ? "PASSED" : "FAILED"} label={r.success ? "Delivered" : "Failed"} />
                </Td>
                <Td className="tabular-nums">{r.statusCode ?? "—"}</Td>
                <Td className="text-fg-muted">{fmtDateTime(r.createdAt)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </DataState>
  );
}

export default function IntegrationsPage() {
  const toast = useToast();
  const integrations = useApi<Integration[]>("/integrations");
  const webhooks = useApi<Webhook[]>("/webhooks");
  const [connecting, setConnecting] = useState<(typeof PROVIDERS)[number] | null>(null);
  const [newHook, setNewHook] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "integration" | "webhook"; id: string; name: string } | null>(null);

  async function remove() {
    if (!deleting) return;
    try {
      await api(`/${deleting.kind === "integration" ? "integrations" : "webhooks"}/${deleting.id}`, { method: "DELETE" });
      toast(`${deleting.name} removed`);
      if (deleting.kind === "integration") await integrations.mutate();
      else await webhooks.mutate();
      setDeleting(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }

  return (
    <>
      <PageHeader title="Integrations" description="Connect source control and issue tracking, and send events to your own systems." />

      <h2 className="mb-3 text-sm font-semibold text-fg-strong">Connections</h2>
      {integrations.error && !integrations.data ? (
        <InlineError error={integrations.error} />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {PROVIDERS.map((p) => {
            const conns = (integrations.data || []).filter((i) => i.provider === p.id);
            return (
              <Card key={p.id} className="flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-overlay text-fg">{p.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-fg-strong">{p.name}</p>
                    <p className="text-sm text-fg-muted">{p.description}</p>
                  </div>
                </div>
                <div className="mt-4 flex-1 space-y-2">
                  {!integrations.data ? (
                    <p className="text-sm text-fg-muted">Loading…</p>
                  ) : conns.length === 0 ? (
                    <p className="text-sm text-fg-muted">Not connected</p>
                  ) : (
                    conns.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 rounded-md bg-elevated px-3 py-2 text-sm">
                        <StatusPill status={c.connectionStatus} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{c.config.repo || c.config.projectKey || c.config.baseUrl}</span>
                        <button
                          type="button"
                          onClick={() => setDeleting({ kind: "integration", id: c.id, name: `${p.name} connection` })}
                          className="rounded p-1 text-fg-muted hover:text-red-400"
                          aria-label={`Disconnect ${p.name}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <Button variant="secondary" className="mt-4" onClick={() => setConnecting(p)}>
                  {conns.length ? "Add another" : "Connect"}
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-8">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <WebhookIcon className="h-4 w-4 text-fg-muted" aria-hidden /> Webhooks
            </span>
          }
          description="Signed HTTP callbacks for run, test and defect events."
          actions={
            <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setNewHook(true)}>
              New webhook
            </Button>
          }
        />
        <DataState
          data={webhooks.data}
          error={webhooks.error}
          isLoading={webhooks.isLoading}
          onRetry={() => webhooks.mutate()}
          empty={<EmptyState title="No webhooks" description="Create a webhook to notify other systems about test activity." />}
        >
          {(hooks) => (
            <ul className="divide-y divide-line">
              {hooks.map((h) => (
                <li key={h.id}>
                  <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-fg-strong">{h.url}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {h.events.map((e) => (
                          <Badge key={e} className="font-mono">
                            {e}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <StatusPill status={h.active ? "ACTIVE" : "INACTIVE"} />
                    <Button size="sm" variant="ghost" aria-expanded={expanded === h.id} onClick={() => setExpanded(expanded === h.id ? null : h.id)}>
                      {expanded === h.id ? "Hide deliveries" : "Delivery log"}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Delete webhook ${h.url}`} icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setDeleting({ kind: "webhook", id: h.id, name: "Webhook" })} />
                  </div>
                  {expanded === h.id && (
                    <CardBody className="border-t border-line bg-elevated/50 p-0">
                      <Deliveries webhookId={h.id} />
                    </CardBody>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </Card>

      {connecting && <ConnectModal provider={connecting} onClose={() => setConnecting(null)} onSaved={() => integrations.mutate()} />}
      <CreateWebhookModal open={newHook} onClose={() => setNewHook(false)} onCreated={() => webhooks.mutate()} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={remove} danger title={`Remove ${deleting?.name.toLowerCase()}?`} confirmLabel="Remove">
        This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
