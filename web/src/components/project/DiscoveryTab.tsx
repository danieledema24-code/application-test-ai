"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Compass, Lock, Radar, Route } from "lucide-react";
import { api, fileUrl } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import type { DiscoveryPage, DiscoverySummary, ProjectDetail } from "@/lib/types";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, ErrorState, InlineError, LoadingBlock, SelectField, StatusPill, TextField, useToast } from "@/components/ui";

function PageCard({ page }: { page: DiscoveryPage }) {
  const [open, setOpen] = useState(false);
  const ok = page.status !== null && page.status < 400;
  return (
    <li className="rounded-lg border border-line bg-surface">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <ChevronDown className={`h-4 w-4 shrink-0 text-fg-muted transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg-strong">{page.title || "(untitled page)"}</p>
          <p className="truncate font-mono text-xs text-fg-muted">{page.url}</p>
        </div>
        <span className="hidden text-xs text-fg-muted sm:inline">depth {page.depth}</span>
        <Badge tone={page.status === null ? "grey" : ok ? "green" : "red"}>{page.status ?? "n/a"}</Badge>
      </button>
      {open && (
        <div className="grid gap-4 border-t border-line px-4 py-4 lg:grid-cols-[1fr_280px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <ListBlock title="Navigation items" items={page.navItems} />
            <ListBlock title="Buttons" items={page.buttons} />
            <ListBlock title={`Links (${page.links.length})`} items={page.links} mono max={12} />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Forms ({page.forms.length})</p>
              {page.forms.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">None found</p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {page.forms.map((f, i) => (
                    <li key={i} className="rounded-md bg-elevated p-2 text-xs">
                      <p className="font-mono text-fg">
                        {f.method?.toUpperCase() || "GET"} {f.action || "(same page)"}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {f.fields.map((fl, j) => (
                          <li key={j} className="text-fg">
                            {fl.label || fl.name} <span className="text-fg-muted">({fl.type})</span>
                            {fl.required && <span className="text-red-400"> required</span>}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {page.screenshotEvidenceId && (
            <a href={fileUrl(`/evidence/${page.screenshotEvidenceId}/file`)} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fileUrl(`/evidence/${page.screenshotEvidenceId}/file`)}
                alt={`Screenshot of ${page.title || page.url}`}
                className="w-full rounded-md border border-line object-cover object-top"
                loading="lazy"
              />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function ListBlock({ title, items, mono, max = 20 }: { title: string; items: string[]; mono?: boolean; max?: number }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</p>
      {!items || items.length === 0 ? (
        <p className="mt-1 text-sm text-fg-muted">None found</p>
      ) : (
        <ul className={`mt-1 space-y-0.5 text-sm text-fg ${mono ? "font-mono text-xs" : ""}`}>
          {items.slice(0, max).map((x, i) => (
            <li key={i} className="truncate">
              {x}
            </li>
          ))}
          {items.length > max && <li className="text-xs text-fg-muted">+{items.length - max} more</li>}
        </ul>
      )}
    </div>
  );
}

function AppMap({ d }: { d: DiscoverySummary }) {
  return (
    <div className="space-y-6">
      <Card className="border-amber-500/40">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden /> Limitations / not covered
            </span>
          }
          description="Discovery is a best-effort crawl. It does not guarantee full coverage of the application."
        />
        <CardBody className="space-y-4">
          {d.coverageNote && <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-100">{d.coverageNote}</p>}
          {d.authRequired && (
            <p className="flex items-center gap-2 text-sm text-fg">
              <Lock className="h-4 w-4 text-amber-400" aria-hidden /> Some areas require authentication. Add credentials to the environment and re-run with
              “Use stored credentials”.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Inaccessible pages ({d.inaccessible.length})</p>
              {d.inaccessible.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">None recorded</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {d.inaccessible.map((x, i) => (
                    <li key={i}>
                      <span className="break-all font-mono text-xs text-fg">{x.url}</span>
                      <span className="text-fg-muted"> — {x.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Known limitations</p>
              {d.limitations.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">None reported</p>
              ) : (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-fg">
                  {d.limitations.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {d.summary && (
        <Card>
          <CardHeader title="Summary" />
          <CardBody>
            <p className="text-sm text-fg">{d.summary}</p>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <Compass className="h-4 w-4 text-fg-muted" aria-hidden /> Pages found ({d.pages.length})
          </h3>
          {d.pages.length === 0 ? (
            <Card>
              <EmptyState title="No pages discovered" />
            </Card>
          ) : (
            <ul className="space-y-2">
              {d.pages.map((p) => (
                <PageCard key={p.url} page={p} />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <Route className="h-4 w-4 text-fg-muted" aria-hidden /> Candidate workflows ({d.workflows.length})
          </h3>
          <Card>
            {d.workflows.length === 0 ? (
              <EmptyState title="No workflows identified" />
            ) : (
              <ul className="divide-y divide-line">
                {d.workflows.map((w, i) => (
                  <li key={i} className="px-4 py-3">
                    <p className="text-sm font-medium text-fg-strong">{w.name}</p>
                    <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-fg">
                      {w.steps.map((s, j) => (
                        <li key={j}>{s}</li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function DiscoveryTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const toast = useToast();
  const authorisedEnvs = project.environments.filter((e) => e.authorised);
  const [envId, setEnvId] = useState(authorisedEnvs[0]?.id || "");
  const [maxPages, setMaxPages] = useState(15);
  const [useCreds, setUseCreds] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const latest = useApi<DiscoverySummary | null>(currentId ? null : `/projects/${project.id}/discovery`);
  const id = currentId || latest.data?.id || null;
  const detail = useApi<DiscoverySummary>(id ? `/discovery/${id}` : null, undefined, {
    refreshInterval: (d) => (!d || d.status === "QUEUED" || d.status === "RUNNING" ? 2000 : 0),
    onSuccess: (d) => {
      if (d.status === "COMPLETED" || d.status === "FAILED") onChanged();
    },
  });
  const d = detail.data;
  const running = d?.status === "QUEUED" || d?.status === "RUNNING";
  const env = project.environments.find((e) => e.id === envId);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setStarting(true);
    setStartError(null);
    try {
      const res = await api<{ discoveryId: string; runId: string }>(`/projects/${project.id}/discovery`, {
        body: { environmentId: envId, maxPages, useCredentials: useCreds },
      });
      setCurrentId(res.discoveryId);
      toast("Discovery started");
    } catch (err) {
      setStartError(err);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-fg-muted" aria-hidden /> Application discovery
            </span>
          }
          description="Crawls the application to map pages, forms and navigation. Read-only: no forms are submitted."
        />
        <CardBody>
          {authorisedEnvs.length === 0 ? (
            <p className="text-sm text-amber-200">No authorised environments. Confirm authorisation for an environment in the Environments tab first.</p>
          ) : (
            <form onSubmit={start} className="flex flex-wrap items-end gap-4">
              <SelectField
                label="Environment"
                wrapClassName="min-w-[16rem]"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
                options={authorisedEnvs.map((e) => ({ value: e.id, label: `${e.name} — ${e.baseUrl}` }))}
              />
              <TextField label="Max pages" type="number" min={1} max={100} wrapClassName="w-28" value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value) || 1)} />
              <Checkbox
                className="pb-2"
                label="Use stored credentials"
                disabled={!env?.hasCredentials}
                description={env?.hasCredentials ? undefined : "No credentials stored"}
                checked={useCreds}
                onChange={(e) => setUseCreds(e.target.checked)}
              />
              <Button type="submit" loading={starting} disabled={running || !envId}>
                {running ? "Discovery running…" : "Start discovery"}
              </Button>
            </form>
          )}
          <div className="mt-3">
            <InlineError error={startError} />
          </div>
        </CardBody>
      </Card>

      {latest.error && !currentId ? (
        <ErrorState error={latest.error} onRetry={() => latest.mutate()} />
      ) : !id ? (
        latest.isLoading ? (
          <LoadingBlock />
        ) : (
          <Card>
            <EmptyState title="No discovery yet" description="Start a discovery to build an app map you can generate test cases from." />
          </Card>
        )
      ) : !d ? (
        detail.error ? <ErrorState error={detail.error} onRetry={() => detail.mutate()} /> : <LoadingBlock />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm text-fg">
            <StatusPill status={d.status} />
            <span>Started {fmtDateTime(d.startedAt)}</span>
            {d.completedAt && <span>· Completed {fmtDateTime(d.completedAt)}</span>}
            {running && <span className="text-fg-muted">· {d.pages.length} pages so far — refreshing every 2s</span>}
            {d.status === "COMPLETED" && (
              <Link href={`/projects/${project.id}?tab=test-cases`} className="ml-auto font-medium text-accent hover:underline">
                Generate test cases from this map →
              </Link>
            )}
          </div>
          {d.status === "FAILED" && <InlineError error={d.summary || "Discovery failed."} />}
          {(d.status === "COMPLETED" || d.pages.length > 0) && <AppMap d={d} />}
        </>
      )}
    </div>
  );
}
