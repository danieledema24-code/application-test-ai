"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronDown, Compass, Loader2, Lock, Radar, Radio, Route } from "lucide-react";
import { api, fileUrl } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, plural } from "@/lib/format";
import type { DiscoveryPage, DiscoverySummary, ProjectDetail, TestCase } from "@/lib/types";
import { ConfirmPermission } from "@/components/domain/ConfirmPermission";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, ErrorState, InlineError, LinkButton, LoadingBlock, SelectField, StatusPill, TextField, useToast } from "@/components/ui";
import { LiveFrame, useLiveSlots } from "@/components/run/LiveView";

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
        <span className="hidden text-xs text-fg-muted sm:inline">{page.depth === 0 ? "Start page" : `${plural(page.depth, "click")} from the start`}</span>
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
          description="The scan follows the links it can reach. It can miss pages behind a sign-in, a search box or a form."
        />
        <CardBody className="space-y-4">
          {d.coverageNote && <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-100">{d.coverageNote}</p>}
          {d.authRequired && (
            <p className="flex items-center gap-2 text-sm text-fg">
              <Lock className="h-4 w-4 text-amber-400" aria-hidden /> Some pages need a sign-in. Add a test login in Sites &amp; logins, then scan again with
              “Sign in first” ticked.
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
              <EmptyState title="No pages found" />
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
            <Route className="h-4 w-4 text-fg-muted" aria-hidden /> Journeys we spotted ({d.workflows.length})
          </h3>
          <Card>
            {d.workflows.length === 0 ? (
              <EmptyState title="No journeys spotted" />
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

// ---- SCAN-1: live scan, automatic checks and what to do next ----

type Stage = "queued" | "running" | "failed" | "cancelled" | "no-pages" | "writing" | "gen-failed" | "done" | "no-checks-yet";

/** One state for the stage area, from the scan status and its automatic check writing. */
function stageOf(d: DiscoverySummary): Stage {
  if (d.status === "QUEUED") return "queued";
  if (d.status === "RUNNING") return "running";
  if (d.status === "CANCELLED") return "cancelled";
  if (d.status === "FAILED") return d.stoppedEarly ? "failed" : "no-pages";
  if (d.pages.length === 0) return "no-pages";
  const g = d.generation;
  if (!g) return "no-checks-yet";
  if (g.status === "PENDING" || g.status === "RUNNING") return "writing";
  return g.status === "FAILED" ? "gen-failed" : "done";
}

const isLive = (s: Stage) => s === "queued" || s === "running";

function ProgressBar({ value, max, label, valueText }: { value: number; max: number; label: string; valueText: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-valuetext={valueText} className="h-2 w-full overflow-hidden rounded-full bg-overlay">
      <div className="h-full rounded-full bg-sky-400 transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  );
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/** Panel heading that can take focus when a final state appears (the card's main heading). */
function PanelHeading({ id, headingRef, icon, children }: { id: string; headingRef?: React.Ref<HTMLHeadingElement>; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 id={id} ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-base font-semibold text-fg-strong focus:outline-none">
      {icon}
      {children}
    </h2>
  );
}

function ScanLiveView({ d, siteName }: { d: DiscoverySummary; siteName: string }) {
  const live = useLiveSlots(d.testRunId, d.status === "RUNNING");
  const slot = live.data?.live ? live.data.slots.find((s) => s.slot === 0) : undefined;
  const recent = d.pages.slice(-5).reverse();
  const valueText = `${d.pages.length} of up to ${d.maxPages}`;
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Radio className="h-4 w-4 animate-pulse text-red-400 motion-reduce:animate-none" aria-hidden /> Watching your site live
          </span>
        }
        description="This is the browser we’re using to look around your site."
        actions={<StatusPill status={d.status} />}
      />
      <CardBody className="grid gap-4 lg:grid-cols-[1fr_280px]">
        {d.testRunId ? (
          <LiveFrame runId={d.testRunId} slot={slot} alt={`Live view of the browser scanning ${siteName}`} placeholder="Waiting for the browser…" />
        ) : (
          <div className="flex aspect-[1366/860] items-center justify-center rounded-lg border border-line bg-black text-sm text-fg-muted">Waiting for the browser…</div>
        )}
        <div className="min-w-0 space-y-4 text-sm">
          {d.status === "QUEUED" || !d.current ? (
            <p className="text-fg-muted">Getting ready to open your site.</p>
          ) : (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Now visiting</p>
              <p className="mt-1 truncate font-medium text-fg-strong" title={d.current.title || "(untitled page)"}>
                {d.current.title || "(untitled page)"}
              </p>
              <p className="truncate font-mono text-xs text-fg-muted" title={d.current.url}>
                {d.current.url}
              </p>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Pages found</p>
            <p className="mb-1.5 mt-1 text-fg">{valueText}</p>
            <ProgressBar value={d.pages.length} max={d.maxPages} label="Pages found" valueText={valueText} />
          </div>
          {recent.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Recently visited</p>
              <ul className="mt-1 space-y-1">
                {recent.map((p) => (
                  <li key={p.url} className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="truncate text-fg">{p.title || "(untitled page)"}</span>
                    <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-fg-muted" title={p.url}>
                      {pathOf(p.url)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ScanStagePanel({ d }: { d: DiscoverySummary }) {
  const g = d.generation;
  const showProgress = g && g.total > 0 && g.done !== undefined;
  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="flex items-center gap-2 text-base font-semibold text-fg-strong">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Writing checks for the pages we found…
        </p>
        <p className="text-sm text-fg-muted">
          We found {plural(d.pages.length, "page")}. Now writing step-by-step checks and the automated tests that go with them. This usually takes under a minute.
        </p>
        {showProgress && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[12rem] flex-1">
              <ProgressBar value={g.done!} max={g.total} label="Checks written" valueText={`${g.done} of ${g.total}`} />
            </div>
            <span className="text-sm text-fg-muted">
              {g.done} of {plural(g.total, "check")} written
            </span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ScanFailedPanel({ d, cancelled, headingRef, onScanAgain, starting }: {
  d: DiscoverySummary;
  cancelled: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
  onScanAgain: () => void;
  starting: boolean;
}) {
  return (
    <Card className={cancelled ? "" : "border-red-500/40"}>
      <CardBody className="space-y-3">
        <div role={cancelled ? undefined : "alert"} className="space-y-1">
          <PanelHeading id="scan-stage-heading" headingRef={headingRef} icon={<AlertTriangle className={`h-4 w-4 ${cancelled ? "text-fg-muted" : "text-red-400"}`} aria-hidden />}>
            {cancelled ? "Scan cancelled" : "The scan stopped early"}
          </PanelHeading>
          <p className="text-sm text-fg-muted">
            {cancelled
              ? `We kept the ${plural(d.pages.length, "page")} found so far.`
              : `${d.summary || "We couldn’t finish looking around your site."} Check that the address works in your browser, then try again.`}
          </p>
        </div>
        <Button className="min-h-11" loading={starting} onClick={onScanAgain}>
          Scan again
        </Button>
      </CardBody>
    </Card>
  );
}

function NoPagesPanel({ projectId, headingRef, onScanAgain, starting }: { projectId: string; headingRef: React.Ref<HTMLHeadingElement>; onScanAgain: () => void; starting: boolean }) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <PanelHeading id="scan-stage-heading" headingRef={headingRef}>
          We couldn’t find any pages
        </PanelHeading>
        <p className="text-sm text-fg-muted">Your site may need a sign-in first, or the address may be wrong. Add a test login in Sites &amp; logins, then scan again.</p>
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" loading={starting} onClick={onScanAgain}>
            Scan again
          </Button>
          <LinkButton className="min-h-11" href={`/projects/${projectId}?tab=environments`}>
            Sites &amp; logins
          </LinkButton>
        </div>
      </CardBody>
    </Card>
  );
}

function GenerationFailedPanel({ d, headingRef, onRetry, retrying, legacy }: {
  d: DiscoverySummary;
  headingRef: React.Ref<HTMLHeadingElement>;
  onRetry: () => void;
  retrying: boolean;
  /** An older scan that finished before checks were written automatically. */
  legacy?: boolean;
}) {
  const reason = (d.generation?.error || "Something went wrong while writing the checks").replace(/\.$/, "");
  return (
    <Card className={legacy ? "" : "border-amber-500/50"}>
      <CardBody className="space-y-3">
        <div role={legacy ? undefined : "alert"} className="space-y-1">
          <PanelHeading id="scan-stage-heading" headingRef={headingRef} icon={legacy ? undefined : <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />}>
            {legacy ? "Want checks for these pages?" : "Your scan worked, but we couldn’t write the checks"}
          </PanelHeading>
          <p className="text-sm text-fg-muted">
            {legacy ? `We can write step-by-step checks for the ${plural(d.pages.length, "page")} this scan found.` : `${reason}. Your pages are saved below.`}
          </p>
        </div>
        <Button className="min-h-11" loading={retrying} onClick={onRetry}>
          {legacy ? "Write checks" : "Try again"}
        </Button>
      </CardBody>
    </Card>
  );
}

function WhatsNextPanel({ project, d, headingRef }: { project: ProjectDetail; d: DiscoverySummary; headingRef: React.Ref<HTMLHeadingElement> }) {
  const toast = useToast();
  const g = d.generation!;
  const scanCases = useApi<TestCase[]>(`/projects/${project.id}/test-cases`, { scan: d.id });
  const [approving, setApproving] = useState(false);
  const filtered = `/projects/${project.id}?tab=test-cases&scan=${d.id}`;
  const drafts = (scanCases.data || []).filter((c) => c.status === "DRAFT");
  const alreadyApproved = !!scanCases.data && scanCases.data.length > 0 && drafts.length === 0;

  async function approveAll() {
    setApproving(true);
    try {
      await api("/test-cases/bulk-status", { body: { ids: drafts.map((c) => c.id), status: "APPROVED" } });
      toast(`${plural(drafts.length, "check")} approved`);
      await scanCases.mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Approve failed", "error");
    } finally {
      setApproving(false);
    }
  }

  if (g.total === 0)
    return (
      <Card className="border-accent/50">
        <CardBody className="space-y-3">
          <PanelHeading id="scan-stage-heading" headingRef={headingRef} icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />}>
            No new checks needed
          </PanelHeading>
          <p className="text-sm text-fg-muted">
            {g.skippedDuplicates > 0 ? `You already have checks for all ${plural(d.pages.length, "page")} we found.` : "We couldn’t find anything to check on these pages."}
          </p>
          <LinkButton className="min-h-11" href={`/projects/${project.id}?tab=test-cases`}>
            See the checks
          </LinkButton>
        </CardBody>
      </Card>
    );

  const manualOnly = g.total - g.withScript;
  return (
    <Card className="border-accent/50">
      <CardBody className="space-y-4">
        <div className="space-y-1">
          <PanelHeading id="scan-stage-heading" headingRef={headingRef} icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />}>
            Your checks are ready
          </PanelHeading>
          <p className="text-sm text-fg-muted">
            We wrote {plural(g.total, "check")} for the {plural(d.pages.length, "page")} we found.
          </p>
        </div>
        <dl className="flex flex-col gap-4 sm:flex-row sm:gap-10">
          <div>
            <dt className="sr-only">Step-by-step checks</dt>
            <dd className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-fg-strong">{g.total}</span>
              <span className="text-sm text-fg">
                step-by-step {g.total === 1 ? "check" : "checks"} <span className="text-fg-muted">(a person can follow them)</span>
              </span>
            </dd>
          </div>
          <div>
            <dt className="sr-only">With an automated test</dt>
            <dd className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-fg-strong">{g.withScript}</span>
              <span className="text-sm text-fg">
                with an automated test <span className="text-fg-muted">(we can run these for you)</span>
              </span>
            </dd>
          </div>
        </dl>
        {g.withScript === 0 ? (
          <p className="text-sm text-fg-muted">None of these can be automated yet. A person can follow the steps.</p>
        ) : (
          manualOnly > 0 && (
            <p className="text-sm text-fg-muted">
              {plural(manualOnly, "check")} {manualOnly === 1 ? "needs" : "need"} a person to follow {manualOnly === 1 ? "it" : "them"}. We can’t automate {manualOnly === 1 ? "it" : "them"} yet.
            </p>
          )
        )}
        {g.skippedDuplicates > 0 && (
          <p className="text-sm text-fg-muted">We skipped {plural(g.skippedDuplicates, "check")} you already had.</p>
        )}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-fg">
          <li>Look them over. They’re drafts until you approve them.</li>
          <li>Approve them and we’ll run the automated ones.</li>
          <li>To see the code of an automated test, open a check and scroll to “Automation script”.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          {g.withScript === 0 ? (
            !alreadyApproved && (
              <Button className="min-h-11" loading={approving} disabled={!drafts.length} onClick={approveAll}>
                Approve all
              </Button>
            )
          ) : (
            <LinkButton variant="primary" className="min-h-11" href={`${filtered}&run=1`}>
              {alreadyApproved ? "Run these checks" : "Approve all and run"}
            </LinkButton>
          )}
          <LinkButton className="min-h-11" href={filtered}>
            Review first
          </LinkButton>
          <Link href={filtered} className="py-2 text-sm font-medium text-fg-strong hover:underline sm:ml-auto">
            See the checks →
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

/** What the polite live region says when the stage changes (never on every poll). */
function announcementFor(stage: Stage, d: DiscoverySummary) {
  switch (stage) {
    case "queued":
    case "running":
      return "Scan started";
    case "writing":
      return `Scan finished. ${plural(d.pages.length, "page")} found. Writing checks`;
    case "no-pages":
      return "Scan finished. No pages found.";
    case "done":
      return d.generation!.total ? `${plural(d.generation!.total, "check")} ready` : "No new checks needed";
    case "gen-failed":
      return "Couldn’t write the checks";
    default:
      return ""; // failures are announced by the card's role="alert"
  }
}

const FOCUS_STAGES: Stage[] = ["done", "gen-failed", "failed", "no-pages"];

export function DiscoveryTab({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const toast = useToast();
  const authorisedEnvs = project.environments.filter((e) => e.authorised);
  const [envId, setEnvId] = useState(authorisedEnvs[0]?.id || "");
  const [maxPages, setMaxPages] = useState(15);
  const [useCreds, setUseCreds] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // Focus only moves for scans (or retries) started in this session, never on first page load.
  const startedHere = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const latest = useApi<DiscoverySummary | null>(currentId ? null : `/projects/${project.id}/discovery`);
  const id = currentId || latest.data?.id || null;
  const detail = useApi<DiscoverySummary>(id ? `/discovery/${id}` : null, undefined, {
    refreshInterval: (d) => (!d || isLive(stageOf(d)) || stageOf(d) === "writing" ? 2000 : 0),
  });
  const d = detail.data;
  const stage = d ? stageOf(d) : null;
  const running = stage ? isLive(stage) : false;
  const env = project.environments.find((e) => e.id === envId);
  useEffect(() => {
    if (!envId && authorisedEnvs[0]) setEnvId(authorisedEnvs[0].id);
  }, [envId, authorisedEnvs]);

  // Stage changes: refresh the project (counts), announce once, and move focus to a final card.
  const prevStage = useRef<Stage | null>(null);
  useEffect(() => {
    if (!stage || !d || stage === prevStage.current) return;
    const first = prevStage.current === null;
    prevStage.current = stage;
    if (!isLive(stage)) onChanged();
    if (first) return;
    setAnnouncement(announcementFor(stage, d));
    if (startedHere.current && FOCUS_STAGES.includes(stage)) requestAnimationFrame(() => headingRef.current?.focus());
  }, [stage, d, onChanged]);

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    setStarting(true);
    setStartError(null);
    try {
      const res = await api<{ discoveryId: string; runId: string }>(`/projects/${project.id}/discovery`, {
        body: { environmentId: envId, maxPages, useCredentials: useCreds },
      });
      startedHere.current = true;
      prevStage.current = null;
      setAnnouncement("Scan started");
      setCurrentId(res.discoveryId);
      toast("Scan started");
    } catch (err) {
      setStartError(err);
    } finally {
      setStarting(false);
    }
  }

  async function retryGeneration() {
    if (!d) return;
    setRetrying(true);
    try {
      const updated = await api<DiscoverySummary>(`/discovery/${d.id}/generate`, { body: {} });
      startedHere.current = true;
      await detail.mutate(updated, { revalidate: false });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn’t start writing the checks", "error");
    } finally {
      setRetrying(false);
    }
  }

  const siteName = project.environments.find((e) => e.id === d?.environmentId)?.baseUrl || project.name;

  return (
    <div className="space-y-6">
      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-fg-muted" aria-hidden /> Scan your site
            </span>
          }
          description="We open your site like a visitor would and list its pages and forms. Nothing is submitted or changed."
        />
        <CardBody>
          {authorisedEnvs.length === 0 ? (
            project.environments[0] ? (
              <ConfirmPermission env={project.environments[0]} onConfirmed={onChanged} />
            ) : (
              <p className="text-sm text-amber-200">Add the site’s address in Site settings first.</p>
            )
          ) : (
            <form onSubmit={start} className="flex flex-wrap items-end gap-4">
              <SelectField
                label="Site"
                wrapClassName="min-w-[16rem]"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
                options={authorisedEnvs.map((e) => ({ value: e.id, label: `${e.name} — ${e.baseUrl}` }))}
              />
              <TextField label="Pages (max)" type="number" min={1} max={100} wrapClassName="w-28" value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value) || 1)} />
              <Checkbox
                className="pb-2"
                label="Sign in first"
                disabled={!env?.hasCredentials}
                description={env?.hasCredentials ? "Uses the saved test login" : "Add a test login in Sites & logins"}
                checked={useCreds}
                onChange={(e) => setUseCreds(e.target.checked)}
              />
              {/* One scan at a time, including the check writing that follows it (the API refuses a second one). */}
              <Button type="submit" loading={starting} disabled={running || stage === "writing" || !envId}>
                {running ? "Scanning…" : stage === "writing" ? "Writing checks…" : "Scan my site"}
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
            <EmptyState icon={<Radar className="h-5 w-5" aria-hidden />} title="No scans yet" description="Scan your site and we’ll write checks for every page we find." />
          </Card>
        )
      ) : !d || !stage ? (
        detail.error ? <ErrorState error={detail.error} onRetry={() => detail.mutate()} /> : <LoadingBlock />
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3 text-sm text-fg">
              <StatusPill status={d.status} />
              <span>Started {fmtDateTime(d.startedAt)}</span>
              {d.completedAt && <span>· Completed {fmtDateTime(d.completedAt)}</span>}
              {running && <span className="text-fg-muted">· {plural(d.pages.length, "page")} found so far</span>}
            </div>
            {detail.error && <p className="text-sm text-fg-muted">Lost connection. We’ll update this when you’re back online.</p>}
          </div>
          {isLive(stage) && <ScanLiveView d={d} siteName={siteName} />}
          {stage === "writing" && <ScanStagePanel d={d} />}
          {(stage === "failed" || stage === "cancelled") && (
            <ScanFailedPanel d={d} cancelled={stage === "cancelled"} headingRef={headingRef} onScanAgain={() => start()} starting={starting} />
          )}
          {stage === "no-pages" && <NoPagesPanel projectId={project.id} headingRef={headingRef} onScanAgain={() => start()} starting={starting} />}
          {(stage === "gen-failed" || stage === "no-checks-yet") && (
            <GenerationFailedPanel d={d} headingRef={headingRef} onRetry={retryGeneration} retrying={retrying} legacy={stage === "no-checks-yet"} />
          )}
          {stage === "done" && <WhatsNextPanel project={project} d={d} headingRef={headingRef} />}
          {!isLive(stage) && (d.pages.length > 0 || stage === "no-pages") && <AppMap d={d} />}
        </>
      )}
    </div>
  );
}
