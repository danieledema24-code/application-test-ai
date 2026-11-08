"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity as ActivityIcon, Bot, Bug, CheckCircle2, FileText, FolderKanban, FolderPlus, PlayCircle, Sparkles } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDuration, fmtPct, timeAgo } from "@/lib/format";
import type { Activity, DashboardData, TrendPoint } from "@/lib/types";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LinkButton,
  PageHeader,
  Segmented,
  Skeleton,
  StatusPill,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  Button,
} from "@/components/ui";
import { TrendChart, SummaryBar } from "@/components/domain/Charts";
import { NewProjectModal } from "@/components/domain/NewProjectModal";
import { NewRunModal } from "@/components/domain/NewRunModal";
import { GenerateCasesModal } from "@/components/domain/GenerateCasesModal";
import { GenerateReportModal } from "@/components/domain/GenerateReportModal";

function Kpi({ label, value, icon, hint }: { label: string; value: React.ReactNode; icon: React.ReactNode; hint?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-fg-muted">{label}</p>
        <span className="text-fg-subtle">{icon}</span>
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-fg-strong">{value}</p>
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [modal, setModal] = useState<null | "project" | "run" | "cases" | "report">(null);
  const dash = useApi<DashboardData>("/dashboard");
  const trend = useApi<TrendPoint[]>("/dashboard/trend", { days });
  const activity = useApi<Activity[]>("/activity", { limit: 20 });
  const d = dash.data;

  // A brand-new workspace gets one clear thing to do instead of empty charts and five quick actions.
  if (d && d.totals.projects === 0)
    return (
      <>
        <PageHeader title={`Welcome${user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}`} description="Let’s check your first site." />
        <Card className="mx-auto max-w-2xl p-8 text-center">
          <h2 className="text-xl font-semibold text-fg-strong">Test your website in a few minutes</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            Paste your site’s address. We scan its pages and forms, suggest checks, and run them in a real browser. No testing experience needed.
          </p>
          <ol className="mx-auto mt-6 grid max-w-lg gap-3 text-left text-sm text-fg sm:grid-cols-3">
            {["Paste your site’s address", "Approve the checks we suggest", "Get plain pass / fail results"].map((t, i) => (
              <li key={t} className="flex gap-2 rounded-lg border border-line p-3">
                <span className="font-semibold text-accent">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
          <Button className="mt-6" icon={<FolderPlus className="h-4 w-4" aria-hidden />} onClick={() => setModal("project")}>
            Test a site
          </Button>
        </Card>
        <NewProjectModal open={modal === "project"} onClose={() => setModal(null)} />
      </>
    );

  return (
    <>
      <PageHeader
        title={`Welcome back${user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}`}
        description="Overview of quality across your workspace."
        actions={
          <Button icon={<FolderPlus className="h-4 w-4" aria-hidden />} onClick={() => setModal("project")}>
            Test a new site
          </Button>
        }
      />

      {dash.error && !d ? (
        <Card>
          <ErrorState error={dash.error} onRetry={() => dash.mutate()} />
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {d ? (
            <>
              <Kpi label="Projects" value={d.totals.projects} icon={<FolderKanban className="h-5 w-5" aria-hidden />} />
              <Kpi label="Tests executed" value={d.totals.testsExecuted} icon={<PlayCircle className="h-5 w-5" aria-hidden />} />
              <Kpi label="Pass rate" value={fmtPct(d.totals.passRate)} icon={<CheckCircle2 className="h-5 w-5" aria-hidden />} hint="Recorded results" />
              <Kpi label="Open bugs" value={d.totals.openDefects} icon={<Bug className="h-5 w-5" aria-hidden />} />
            </>
          ) : (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[118px] rounded-xl" />)
          )}
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Results trend"
            description="Recorded test results per day"
            actions={
              <Segmented
                label="Time range"
                value={days}
                onChange={setDays}
                options={[
                  { value: 7, label: "7 days" },
                  { value: 30, label: "30 days" },
                  { value: 90, label: "90 days" },
                ]}
              />
            }
          />
          <CardBody>
            {trend.error && !trend.data ? (
              <ErrorState error={trend.error} onRetry={() => trend.mutate()} />
            ) : !trend.data ? (
              <Skeleton className="h-64" />
            ) : trend.data.every((p) => p.passed + p.failed + p.blocked + p.other === 0) ? (
              <EmptyState title="No results in this period" description="Run some tests to see the trend." />
            ) : (
              <TrendChart data={trend.data} days={days} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Most recent run" />
          <CardBody>
            {!d ? (
              <Skeleton className="h-40" />
            ) : !d.latestRun ? (
              <EmptyState title="No runs yet" action={<Button size="sm" onClick={() => setModal("run")}>Run a test</Button>} />
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/test-runs/${d.latestRun.id}`} className="block truncate font-medium text-fg-strong hover:underline">
                      {d.latestRun.key} · {d.latestRun.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {d.latestRun.projectName} · {d.latestRun.environmentName} · {timeAgo(d.latestRun.createdAt)}
                    </p>
                  </div>
                  <StatusPill status={d.latestRun.status} />
                </div>
                <SummaryBar s={d.latestRun.summary} />
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-elevated p-2">
                    <dt className="text-xs text-fg-muted">Pass rate</dt>
                    <dd className="font-semibold text-fg-strong">{fmtPct(d.latestRun.summary.passRate)}</dd>
                  </div>
                  <div className="rounded-lg bg-elevated p-2">
                    <dt className="text-xs text-fg-muted">Duration</dt>
                    <dd className="font-semibold text-fg-strong">{fmtDuration(d.latestRun.summary.durationMs)}</dd>
                  </div>
                  <div className="rounded-lg bg-elevated p-2">
                    <dt className="text-xs text-fg-muted">Type</dt>
                    <dd className="text-sm font-semibold capitalize text-fg-strong">{d.latestRun.executionType.toLowerCase()}</dd>
                  </div>
                </dl>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Quick actions" />
        <CardBody className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<FolderPlus className="h-4 w-4" aria-hidden />} onClick={() => setModal("project")}>
            Create project
          </Button>
          <Button variant="secondary" icon={<PlayCircle className="h-4 w-4" aria-hidden />} onClick={() => setModal("run")}>
            Run a test
          </Button>
          <Button variant="secondary" icon={<Sparkles className="h-4 w-4" aria-hidden />} onClick={() => setModal("cases")}>
            Generate test cases
          </Button>
          <LinkButton href="/defects" icon={<Bug className="h-4 w-4" aria-hidden />}>
            View defects
          </LinkButton>
          <Button variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />} onClick={() => setModal("report")}>
            Generate report
          </Button>
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Recent projects" actions={<LinkButton href="/projects" size="sm" variant="ghost">View all</LinkButton>} />
          {!d ? (
            <CardBody>
              <Skeleton className="h-40" />
            </CardBody>
          ) : d.recentProjects.length === 0 ? (
            <EmptyState title="No projects yet" description="Create a project to start testing an application." action={<Button size="sm" onClick={() => setModal("project")}>Create project</Button>} />
          ) : (
            <Table label="Recent projects">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Last run</Th>
                  <Th>Latest status</Th>
                  <Th className="text-right">Open bugs</Th>
                </tr>
              </THead>
              <TBody>
                {d.recentProjects.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <Link href={`/projects/${p.id}`} className="font-medium text-fg-strong hover:underline">
                        {p.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge>{p.applicationType}</Badge>
                    </Td>
                    <Td className="text-fg-muted">{timeAgo(p.stats?.lastRunAt)}</Td>
                    <Td>{p.stats?.lastRunStatus ? <StatusPill status={p.stats.lastRunStatus} /> : <span className="text-fg-muted">—</span>}</Td>
                    <Td className="text-right tabular-nums">{p.stats?.openDefects ?? "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          <div className="max-h-[420px] overflow-y-auto">
            {activity.error && !activity.data ? (
              <ErrorState error={activity.error} onRetry={() => activity.mutate()} />
            ) : !activity.data ? (
              <CardBody>
                <Skeleton className="h-40" />
              </CardBody>
            ) : activity.data.length === 0 ? (
              <EmptyState title="No activity yet" icon={<ActivityIcon className="h-5 w-5" aria-hidden />} />
            ) : (
              <ul className="divide-y divide-line">
                {activity.data.map((a) => (
                  <li key={a.id} className="px-5 py-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-fg">
                          {a.link ? (
                            <Link href={a.link} className="hover:underline">
                              {a.message}
                            </Link>
                          ) : (
                            a.message
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-muted">
                          {[a.actor?.fullName, a.projectName, timeAgo(a.createdAt)].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      {a.viaAI && (
                        <Badge tone="violet" title="Performed by the AI assistant">
                          <Bot className="h-3 w-3" aria-hidden /> AI
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <NewProjectModal open={modal === "project"} onClose={() => setModal(null)} />
      <NewRunModal open={modal === "run"} onClose={() => setModal(null)} />
      <GenerateCasesModal open={modal === "cases"} onClose={() => setModal(null)} />
      <GenerateReportModal open={modal === "report"} onClose={() => setModal(null)} />
    </>
  );
}
