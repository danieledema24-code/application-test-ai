"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity as ActivityIcon, ArrowRight, CircleX, FolderKanban, Loader2, UserRoundCheck } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { firstName, useAuth } from "@/lib/auth";
import { fmtDateTime, timeAgo } from "@/lib/format";
import type { ActivityItem, Dashboard } from "@/lib/contract";
import { projectStatusLabel } from "@/lib/projectStatus";
import { shortUrl } from "@/lib/url";
import { useOnline } from "@/lib/useOnline";
import { Callout, Card, CardBody, CardHeader, EmptyState, ErrorState, Skeleton, StatTile, StatusPill, TBody, THead, Table, Td, Th, Tr } from "@/components/ui";
import { StartAnalysisForm } from "@/components/domain/StartAnalysisForm";
import { LifecycleMini } from "@/components/domain/LifecycleProgress";

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function RelTime({ iso }: { iso: string }) {
  // Rendered after mount so server and client agree (relative time depends on "now").
  const [text, setText] = useState("");
  useEffect(() => setText(timeAgo(iso)), [iso]);
  return (
    <time dateTime={iso} title={fmtDateTime(iso)} className="whitespace-nowrap text-small tabular-nums text-fg-muted">
      {text}
    </time>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-navy-50 text-body font-semibold text-navy-800">
      {(name.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

function RecentProjects({ data, error, retry }: { data: Dashboard | undefined; error: unknown; retry: () => void }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Recent projects" />
      {error && !data ? (
        <ErrorState error={error} title="Couldn’t load your projects." message="Try again." onRetry={retry} />
      ) : !data ? (
        <ul aria-label="Loading projects" className="divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-4">
              <Skeleton className="h-9 w-9" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </li>
          ))}
        </ul>
      ) : data.recent_projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Start a QA analysis above to create your first project." />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {data.recent_projects.slice(0, 5).map((p) => {
              const st = projectStatusLabel(p);
              return (
                <li key={p.id}>
                  <Link href={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-overlay">
                    <Avatar name={p.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-body font-semibold text-fg-strong">{p.name}</span>
                        <StatusPill status={st.status} label={st.label} />
                      </span>
                      <span className="mt-0.5 block truncate text-small text-fg-muted">
                        {shortUrl(p.primary_url)} · {p.pages_discovered} page{p.pages_discovered === 1 ? "" : "s"} found
                      </span>
                    </span>
                    <RelTime iso={p.updated_at} />
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line px-5 py-3 text-right">
            <Link href="/projects" className="inline-flex items-center gap-1 text-body font-medium text-navy-700 hover:underline">
              View all projects <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

function levelIcon(a: ActivityItem) {
  if (a.level === "error" || a.type.endsWith(".failed")) return <CircleX className="h-4 w-4 text-danger-fg" aria-hidden />;
  if (a.type.startsWith("gate.awaiting")) return <UserRoundCheck className="h-4 w-4 text-warning-fg" aria-hidden />;
  return <ActivityIcon className="h-4 w-4 text-info-fg" aria-hidden />;
}

function TestingActivity({ data, error }: { data: Dashboard | undefined; error: unknown }) {
  return (
    <Card>
      <CardHeader title="Testing activity" />
      {error && !data ? (
        <CardBody>
          <p className="text-body text-fg-muted">Activity is unavailable right now.</p>
        </CardBody>
      ) : !data ? (
        <CardBody className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </CardBody>
      ) : data.activity.length === 0 ? (
        <EmptyState title="No activity yet." className="py-8" />
      ) : (
        <ol className="divide-y divide-line">
          {data.activity.slice(0, 8).map((a) => (
            <li key={a.id}>
              <Link href={`/projects/${a.project_id}`} className="flex gap-2.5 px-5 py-3 hover:bg-overlay">
                <span className="mt-0.5">{levelIcon(a)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-fg-strong">{a.message}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-small text-fg-muted">
                    <span className="truncate">{a.project_name}</span>
                    <span aria-hidden>·</span>
                    <RelTime iso={a.created_at} />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Health({ data }: { data: Dashboard }) {
  const h = data.health;
  return (
    <Card>
      <CardHeader title="QA project health" description={`${h.pages_discovered_30d} page${h.pages_discovered_30d === 1 ? "" : "s"} discovered in the last 30 days.`} />
      <CardBody className="space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Active projects" value={h.projects_total} icon={<FolderKanban className="h-4 w-4" />} href="/projects" />
          <StatTile label="Analyses running" value={h.scans_running} icon={<Loader2 className="h-4 w-4" />} href="/projects?view=running" />
          <StatTile label="Awaiting your approval" value={h.awaiting_approval} icon={<UserRoundCheck className="h-4 w-4" />} href="/projects?view=awaiting" />
          <StatTile label="Failed stages" value={h.failed_stages} icon={<CircleX className="h-4 w-4" />} href="/projects?view=failed" />
        </div>
        {data.recent_projects.length > 0 && (
          <Table label="Project health">
            <THead>
              <tr>
                <Th>Project</Th>
                <Th>Lifecycle</Th>
                <Th className="text-right">Pages found</Th>
                <Th>Gate status</Th>
              </tr>
            </THead>
            <TBody>
              {data.recent_projects.map((p) => (
                <Tr key={p.id}>
                  <Td rowHeader>
                    <Link href={`/projects/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </Td>
                  <Td>
                    <LifecycleMini project={p} />
                  </Td>
                  <Td className="text-right tabular-nums">{p.pages_discovered}</Td>
                  <Td>{p.awaiting_approval ? <StatusPill status="awaiting_approval" label="Gate waiting" /> : <span className="text-fg-muted">—</span>}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

function WhatHappensNext() {
  const steps = [
    "Enter your website URL.",
    "Confirm you’re authorised to test it.",
    "Watch the AI explore it, then review the Application Discovery Report.",
  ];
  return (
    <Card>
      <CardHeader title="What happens next" />
      <CardBody>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s} className="flex items-start gap-3 text-body text-fg">
              <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-navy-50 text-caption font-semibold text-navy-800">
                {i + 1}
              </span>
              <span>
                <span className="sr-only">{i + 1}. </span>
                {s}
              </span>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

export default function DashboardPage() {
  const { user, organisation } = useAuth();
  const online = useOnline();
  const { data, error, mutate } = useApi<Dashboard>("/dashboard", undefined, { refreshInterval: 15000 });
  const [hello, setHello] = useState("Welcome");
  useEffect(() => setHello(greeting()), []);

  const name = firstName(data ? { full_name: data.welcome.full_name } : user);
  const firstRun = data ? data.health.projects_total === 0 && data.recent_projects.length === 0 : false;
  const total = data?.health.projects_total;

  useEffect(() => {
    document.title = "Dashboard · QA Analyst";
  }, []);

  return (
    <div className="space-y-8">
      {!online && <Callout tone="warning">You’re offline. Changes and live updates resume when you reconnect.</Callout>}
      <div>
        <h1 tabIndex={-1} className="text-display font-semibold tracking-[-0.02em] text-fg-strong focus:outline-none">
          {firstRun ? `Welcome${name ? `, ${name}` : ""}` : `${hello}${name ? `, ${name}` : ""}`}
        </h1>
        <p className="mt-1 text-body text-fg-muted">
          {data?.welcome.organisation ?? organisation?.name}
          {total !== undefined && ` · ${total} project${total === 1 ? "" : "s"}`}
        </p>
      </div>

      <Card className={`border-t-4 border-t-navy-100 ${firstRun ? "p-8 sm:p-10" : "p-6 sm:p-8"}`}>
        <h2 className="text-h2 font-semibold text-fg-strong">Start a QA analysis</h2>
        <p className="mb-5 mt-1 max-w-2xl text-body text-fg-muted">
          Enter a website and the AI QA Analyst explores it, maps its functionality and writes an Application Discovery Report you can review.
        </p>
        <StartAnalysisForm autoFocus={firstRun} />
      </Card>

      {firstRun ? (
        <WhatHappensNext />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <RecentProjects data={data} error={error} retry={() => void mutate()} />
            <TestingActivity data={data} error={error} />
          </div>
          {data ? (
            <Health data={data} />
          ) : !error ? (
            <div aria-hidden className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
