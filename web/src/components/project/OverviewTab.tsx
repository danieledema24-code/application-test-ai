"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { fmtPct, timeAgo } from "@/lib/format";
import type { ProjectDetail } from "@/lib/types";
import { Button, Card, LinkButton, CardBody, CardHeader, EmptyState, StatusPill } from "@/components/ui";
import { PassFailDonut } from "@/components/domain/Charts";
import { RunsTable } from "@/components/domain/RunsTable";
import { NewRunModal } from "@/components/domain/NewRunModal";

/** The three steps from a new project to a first result, shown until a run has happened. */
function GettingStarted({ project, onNavigate }: { project: ProjectDetail; onNavigate: (tab: string) => void }) {
  const [running, setRunning] = useState(false);
  const s = project.stats;
  const scanned = project.discovery?.status === "COMPLETED";
  const reviewed = (s?.runnableCases ?? 0) > 0;
  const ran = Boolean(s?.lastRunAt);
  const steps = [
    {
      title: "Scan your site",
      body: "We open your site, find its pages and forms, and never submit anything.",
      done: scanned,
      action: <Button size="sm" onClick={() => onNavigate("discovery")}>Scan my site</Button>,
    },
    {
      title: "Review the suggested checks",
      body: "We suggest checks for what we found. Skim them, then click Approve and run.",
      done: reviewed,
      action: (
        <LinkButton size="sm" href={`/projects/${project.id}?tab=test-cases${scanned && !s?.testCases ? "&generate=1" : ""}`}>
          {s?.testCases ? "Review checks" : "Suggest checks"}
        </LinkButton>
      ),
    },
    {
      title: "Run them",
      body: "Each check runs in a real browser. You get a plain pass or fail, with screenshots of anything that broke.",
      done: ran,
      action: <Button size="sm" onClick={() => setRunning(true)}>Run checks</Button>,
    },
  ];
  const next = steps.findIndex((x) => !x.done);
  return (
    <Card>
      <CardHeader title="Get your first result" description="Three steps, a few minutes. No testing experience needed." />
      <CardBody>
        <ol className="grid gap-3 md:grid-cols-3">
          {steps.map((x, i) => (
            <li key={x.title} className={`rounded-lg border p-4 ${i === next ? "border-accent/60 bg-accent-soft/30" : "border-line"}`}>
              <div className="flex items-center gap-2">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${x.done ? "bg-emerald-500/20 text-emerald-300" : "bg-overlay text-fg-strong"}`}>
                  {x.done ? <Check className="h-3.5 w-3.5" aria-label="Done" /> : i + 1}
                </span>
                <h3 className="text-sm font-semibold text-fg-strong">{x.title}</h3>
              </div>
              <p className="mt-2 text-sm text-fg-muted">{x.body}</p>
              {i === next && <div className="mt-3">{x.action}</div>}
            </li>
          ))}
        </ol>
      </CardBody>
      <NewRunModal open={running} onClose={() => setRunning(false)} projectId={project.id} />
    </Card>
  );
}

export function OverviewTab({ project, onNavigate }: { project: ProjectDetail; onNavigate: (tab: string) => void }) {
  const s = project.stats;
  const runs = project.recentRuns || [];
  const agg = runs.reduce(
    (a, r) => ({
      passed: a.passed + (r.summary?.passed || 0),
      failed: a.failed + (r.summary?.failed || 0) + (r.summary?.error || 0),
      blocked: a.blocked + (r.summary?.blocked || 0),
      other: a.other + (r.summary?.notExecuted || 0),
    }),
    { passed: 0, failed: 0, blocked: 0, other: 0 },
  );
  const stats = [
    { label: "Test cases", value: s?.testCases ?? 0 },
    { label: "Open bugs", value: s?.openDefects ?? 0 },
    { label: "Pass rate", value: fmtPct(s?.passRate) },
    { label: "Last run", value: s?.lastRunAt ? timeAgo(s.lastRunAt) : "Never", pill: s?.lastRunStatus },
  ];
  return (
    <div className="space-y-6">
      {!s?.lastRunAt && <GettingStarted project={project} onNavigate={onNavigate} />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((x) => (
          <Card key={x.label} className="p-5">
            <p className="text-sm font-medium text-fg-muted">{x.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-fg-strong">{x.value}</p>
            {x.pill && <StatusPill status={x.pill} className="mt-1" />}
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader title="Pass / fail" description={`Across the ${runs.length} most recent runs`} />
          <CardBody>
            <PassFailDonut {...agg} />
          </CardBody>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title="Recent runs" actions={<Button size="sm" variant="ghost" onClick={() => onNavigate("runs")}>View all</Button>} />
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" description="Follow the steps above to get your first result." />
          ) : (
            <RunsTable runs={runs} showProject={false} />
          )}
        </Card>
      </div>
      {project.discovery && (
        <Card>
          <CardHeader title="Latest discovery" actions={<StatusPill status={project.discovery.status} />} />
          <CardBody>
            <p className="text-sm text-fg">{project.discovery.summary || "Discovery in progress."}</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => onNavigate("discovery")}>
              Open app map
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
