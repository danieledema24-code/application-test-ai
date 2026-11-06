"use client";

import { useState } from "react";
import Link from "next/link";
import { FileUp, Plus, Save, Send, Sparkles, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { prettyJson } from "@/lib/format";
import type { ApiAuth, ApiEndpoint, ApiExchange, HttpMethod, ProjectDetail, TestCase } from "@/lib/types";
import { API_AUTHS, HTTP_METHODS } from "@/lib/types";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  InlineError,
  LoadingBlock,
  Modal,
  SelectField,
  Tabs,
  TextArea,
  TextField,
  inputClass,
  useToast,
} from "@/components/ui";
import { ApiExchangeView } from "@/components/domain/ApiExchangeView";
import { AiDraftBadge } from "@/components/domain/AiBits";

const METHOD_COLOUR: Record<string, string> = {
  GET: "text-emerald-400",
  POST: "text-sky-400",
  PUT: "text-amber-300",
  PATCH: "text-violet-300",
  DELETE: "text-red-400",
};

type Pair = { k: string; v: string };
const toPairs = (o: Record<string, string> | null | undefined): Pair[] => {
  const p = Object.entries(o || {}).map(([k, v]) => ({ k, v: String(v) }));
  return p.length ? p : [{ k: "", v: "" }];
};
const fromPairs = (p: Pair[]) => Object.fromEntries(p.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v]));

function KeyValueEditor({ label, pairs, onChange }: { label: string; pairs: Pair[]; onChange: (p: Pair[]) => void }) {
  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="space-y-2">
        {pairs.map((p, i) => (
          <div key={i} className="flex gap-2">
            <label className="sr-only" htmlFor={`${label}-k-${i}`}>
              {label} name {i + 1}
            </label>
            <input id={`${label}-k-${i}`} className={`${inputClass} font-mono text-xs`} placeholder="Name" value={p.k} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
            <label className="sr-only" htmlFor={`${label}-v-${i}`}>
              {label} value {i + 1}
            </label>
            <input id={`${label}-v-${i}`} className={`${inputClass} font-mono text-xs`} placeholder="Value" value={p.v} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <button
              type="button"
              onClick={() => onChange(pairs.length > 1 ? pairs.filter((_, j) => j !== i) : [{ k: "", v: "" }])}
              className="rounded p-2 text-fg-muted hover:bg-overlay hover:text-red-400"
              aria-label={`Remove ${label.toLowerCase()} row ${i + 1}`}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => onChange([...pairs, { k: "", v: "" }])} icon={<Plus className="h-4 w-4" aria-hidden />}>
        Add row
      </Button>
    </fieldset>
  );
}

type Draft = {
  name: string;
  method: HttpMethod;
  path: string;
  headers: Pair[];
  query: Pair[];
  body: string;
  auth: ApiAuth;
  expectedStatus: number;
  maxResponseMs: number;
  requiredFields: string;
  jsonSchema: string;
};

function toDraft(e: ApiEndpoint): Draft {
  return {
    name: e.name || "",
    method: e.method,
    path: e.path,
    headers: toPairs(e.headers),
    query: toPairs(e.query),
    body: e.body === null || e.body === undefined ? "" : prettyJson(e.body),
    auth: e.auth || "NONE",
    expectedStatus: e.expectedStatus ?? 200,
    maxResponseMs: e.maxResponseMs ?? 2000,
    requiredFields: (e.requiredFields || []).join(", "),
    jsonSchema: e.jsonSchema ? prettyJson(e.jsonSchema) : "",
  };
}

function draftToBody(d: Draft): Partial<ApiEndpoint> {
  const parseJson = (s: string, field: string) => {
    if (!s.trim()) return null;
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`${field} must be valid JSON.`);
    }
  };
  return {
    name: d.name,
    method: d.method,
    path: d.path,
    headers: fromPairs(d.headers),
    query: fromPairs(d.query),
    body: parseJson(d.body, "Body"),
    auth: d.auth,
    expectedStatus: Number(d.expectedStatus),
    maxResponseMs: Number(d.maxResponseMs),
    requiredFields: d.requiredFields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    jsonSchema: parseJson(d.jsonSchema, "JSON schema"),
  };
}

function Editor({ endpoint, project, onSaved, onDeleted }: { endpoint: ApiEndpoint; project: ProjectDetail; onSaved: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => toDraft(endpoint));
  const [section, setSection] = useState("params");
  const [envId, setEnvId] = useState(project.environments.find((e) => e.authorised)?.id || project.environments[0]?.id || "");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [exchange, setExchange] = useState<ApiExchange | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const env = project.environments.find((e) => e.id === envId);

  async function save(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      await api(`/api-endpoints/${endpoint.id}`, { method: "PATCH", body: draftToBody(d) });
      onSaved();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function send(confirm = false) {
    // Persist edits first so the server sends exactly what is shown.
    if (!(await save())) return;
    setSending(true);
    setError(null);
    try {
      const ex = await api<ApiExchange>(`/api-endpoints/${endpoint.id}/send`, { body: { environmentId: envId, ...(confirm ? { confirm: true } : {}) } });
      setExchange(ex);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.requiresConfirmation) {
        setNeedsConfirm(err.message);
      } else setError(err);
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    try {
      await api(`/api-endpoints/${endpoint.id}`, { method: "DELETE" });
      toast("Endpoint deleted");
      setConfirmDelete(false);
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Name" wrapClassName="flex-1 min-w-[12rem]" value={d.name} onChange={(e) => set("name", e.target.value)} />
            <SelectField
              label="Environment"
              wrapClassName="min-w-[14rem]"
              value={envId}
              onChange={(e) => setEnvId(e.target.value)}
              options={project.environments.map((e) => ({ value: e.id, label: `${e.name} — ${e.baseUrl}` }))}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <SelectField label="Method" hideLabel wrapClassName="w-28" value={d.method} onChange={(e) => set("method", e.target.value as HttpMethod)} options={HTTP_METHODS.map((m) => ({ value: m, label: m }))} className="font-semibold" />
            <div className="min-w-[12rem] flex-1">
              <label htmlFor="api-path" className="sr-only">
                Path
              </label>
              <div className="flex rounded-md shadow-sm ring-1 ring-inset ring-line-strong focus-within:ring-2 focus-within:ring-accent">
                <span className="hidden max-w-[16rem] truncate rounded-l-md bg-elevated px-3 py-2 font-mono text-xs leading-5 text-fg-muted sm:block">{env?.baseUrl || ""}</span>
                <input id="api-path" className="block w-full rounded-r-md border-0 bg-transparent px-3 py-2 font-mono text-sm text-fg-strong focus:outline-none" placeholder="/v1/resource" value={d.path} onChange={(e) => set("path", e.target.value)} />
              </div>
            </div>
            <Button icon={<Send className="h-4 w-4" aria-hidden />} loading={sending} disabled={!envId} onClick={() => send(false)}>
              Send
            </Button>
            <Button variant="secondary" icon={<Save className="h-4 w-4" aria-hidden />} loading={saving && !sending} onClick={async () => (await save()) && toast("Endpoint saved")}>
              Save
            </Button>
            <Button variant="ghost" aria-label="Delete endpoint" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirmDelete(true)} />
          </div>
          {env && !env.authorised && <p className="text-sm text-amber-200">This environment is not confirmed as authorised for testing.</p>}

          <Tabs
            idPrefix="api-editor"
            label="Request sections"
            value={section}
            onChange={setSection}
            tabs={[
              { id: "params", label: "Query" },
              { id: "headers", label: "Headers" },
              { id: "body", label: "Body" },
              { id: "auth", label: "Auth" },
              { id: "assert", label: "Assertions" },
            ]}
          />
          <div role="tabpanel" id={`api-editor-panel-${section}`} aria-labelledby={`api-editor-${section}`}>
            {section === "params" && <KeyValueEditor label="Query" pairs={d.query} onChange={(p) => set("query", p)} />}
            {section === "headers" && <KeyValueEditor label="Headers" pairs={d.headers} onChange={(p) => set("headers", p)} />}
            {section === "body" && <TextArea label="Body (JSON)" mono rows={10} value={d.body} onChange={(e) => set("body", e.target.value)} placeholder='{ "name": "example" }' />}
            {section === "auth" && (
              <div className="max-w-sm">
                <SelectField
                  label="Auth type"
                  value={d.auth}
                  onChange={(e) => set("auth", e.target.value as ApiAuth)}
                  options={API_AUTHS.map((a) => ({ value: a, label: a === "NONE" ? "No auth" : a === "API_KEY" ? "API key" : a === "BEARER" ? "Bearer token" : "Basic" }))}
                  hint="Values come from the selected environment’s stored credentials; they are never shown here."
                />
              </div>
            )}
            {section === "assert" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Expected status" type="number" value={d.expectedStatus} onChange={(e) => set("expectedStatus", Number(e.target.value))} />
                <TextField label="Max response time (ms)" type="number" value={d.maxResponseMs} onChange={(e) => set("maxResponseMs", Number(e.target.value))} />
                <TextField label="Required fields" hint="Comma-separated JSON paths, e.g. id, data.name" wrapClassName="sm:col-span-2" value={d.requiredFields} onChange={(e) => set("requiredFields", e.target.value)} />
                <TextArea label="JSON schema (optional)" mono rows={6} wrapClassName="sm:col-span-2" value={d.jsonSchema} onChange={(e) => set("jsonSchema", e.target.value)} />
              </div>
            )}
          </div>
          <InlineError error={error} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Response" />
        <CardBody>
          {sending ? <LoadingBlock label="Sending request…" /> : exchange ? <ApiExchangeView exchange={exchange} /> : <p className="text-sm text-fg-muted">Send the request to see the response.</p>}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={!!needsConfirm}
        onClose={() => setNeedsConfirm(null)}
        onConfirm={() => {
          setNeedsConfirm(null);
          void send(true);
        }}
        title="Confirm potentially destructive request"
        confirmLabel={`Send ${d.method} anyway`}
        danger
      >
        <p>{needsConfirm}</p>
        <p className="mt-2">
          The <strong>{env?.name}</strong> environment does not allow destructive actions. This {d.method} request may change data. Only continue if you’re sure.
        </p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} title="Delete endpoint?" danger confirmLabel="Delete">
        This deletes the saved endpoint definition.
      </ConfirmDialog>
    </div>
  );
}

function ImportModal({ projectId, open, onClose, onImported }: { projectId: string; open: boolean; onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ imported: ApiEndpoint[] }>(`/projects/${projectId}/api-endpoints/import-openapi`, { body: { spec } });
      toast(`${res.imported.length} endpoints imported`);
      setSpec("");
      onImported();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Import OpenAPI specification"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="openapi-form" loading={busy} disabled={!spec.trim()}>
            Import
          </Button>
        </>
      }
    >
      <form id="openapi-form" onSubmit={submit} className="space-y-3">
        <TextArea label="Specification (JSON or YAML)" mono rows={16} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={"openapi: 3.0.0\ninfo:\n  title: My API\npaths:\n  /users:\n    get: …"} />
        <InlineError error={error} />
      </form>
    </Modal>
  );
}

export function ApiTab({ project }: { project: ProjectDetail }) {
  const toast = useToast();
  const { data, error, isLoading, mutate } = useApi<ApiEndpoint[]>(`/projects/${project.id}/api-endpoints`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<TestCase[] | null>(null);
  const selected = data?.find((e) => e.id === selectedId) || data?.[0] || null;

  async function create() {
    setCreating(true);
    try {
      const ep = await api<ApiEndpoint>(`/projects/${project.id}/api-endpoints`, {
        body: { name: "New request", method: "GET", path: "/", headers: {}, query: {}, body: null, auth: "NONE", expectedStatus: 200, maxResponseMs: 2000, requiredFields: [], jsonSchema: null },
      });
      await mutate();
      setSelectedId(ep.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn’t create endpoint", "error");
    } finally {
      setCreating(false);
    }
  }

  async function generateTests() {
    setGenerating(true);
    try {
      const res = await api<{ generated: TestCase[] }>(`/projects/${project.id}/api-endpoints/generate-tests`, { body: {} });
      setGenerated(res.generated);
      toast(`${res.generated.length} draft API test cases generated`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Generation failed", "error");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" icon={<FileUp className="h-4 w-4" aria-hidden />} onClick={() => setImportOpen(true)}>
          Import OpenAPI
        </Button>
        <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} loading={creating} onClick={create}>
          New request
        </Button>
        <Button icon={<Sparkles className="h-4 w-4" aria-hidden />} loading={generating} disabled={!data?.length} onClick={generateTests}>
          Generate API tests
        </Button>
      </div>

      {error && !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => mutate()} />
        </Card>
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            title="No API endpoints"
            description="Import an OpenAPI specification or create a request by hand."
            action={<Button onClick={() => setImportOpen(true)}>Import OpenAPI</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card className="self-start">
            <CardHeader title={`Endpoints (${data.length})`} />
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto" aria-label="Endpoints">
              {data.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    aria-current={selected?.id === e.id ? "true" : undefined}
                    className={`flex w-full items-start gap-2 px-4 py-2.5 text-left text-sm hover:bg-elevated ${selected?.id === e.id ? "bg-accent-soft/70" : ""}`}
                  >
                    <span className={`w-14 shrink-0 font-mono text-xs font-semibold ${METHOD_COLOUR[e.method]}`}>{e.method}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs text-fg-strong">{e.path}</span>
                      {e.name && <span className="block truncate text-xs text-fg-muted">{e.name}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {selected && <Editor key={selected.id} endpoint={selected} project={project} onSaved={() => mutate()} onDeleted={() => { setSelectedId(null); void mutate(); }} />}
        </div>
      )}

      <ImportModal projectId={project.id} open={importOpen} onClose={() => setImportOpen(false)} onImported={() => mutate()} />
      <Modal open={!!generated} onClose={() => setGenerated(null)} title="Generated API tests" footer={<Button onClick={() => setGenerated(null)}>Done</Button>}>
        <AiDraftBadge />
        <ul className="mt-3 divide-y divide-line rounded-md border border-line">
          {(generated || []).map((c) => (
            <li key={c.id} className="px-3 py-2 text-sm">
              <span className="font-mono text-xs text-fg-muted">{c.key}</span>{" "}
              <Link href={`/test-cases/${c.id}`} className="font-medium text-fg-strong hover:underline">
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
        {generated?.length === 0 && <p className="text-sm text-fg-muted">Nothing was generated.</p>}
      </Modal>
    </div>
  );
}
