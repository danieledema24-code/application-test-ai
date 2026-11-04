"use client";

import { fmtPct, timeAgo } from "@/lib/format";
import type { ProjectDetail } from "@/lib/types";
import { Button, Card, CardBody, CardHeader, EmptyState, StatusPill } from "@/components/ui";
import { PassFailDonut } from "@/components/domain/Charts";
import { RunsTable } from "@/components/domain/RunsTable";

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
    { label: "Open defects", value: s?.openDefects ?? 0 },
    { label: "Pass rate", value: fmtPct(s?.passRate) },
    { label: "Last run", value: s?.lastRunAt ? timeAgo(s.lastRunAt) : "Never", pill: s?.lastRunStatus },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((x) => (
          <Card key={x.label} className="p-5">
            <p className="text-sm font-medium text-slate-600">{x.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{x.value}</p>
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
            <EmptyState title="No runs yet" description="Approve some test cases, then start a run." action={<Button size="sm" onClick={() => onNavigate("runs")}>Go to runs</Button>} />
          ) : (
            <RunsTable runs={runs} showProject={false} />
          )}
        </Card>
      </div>
      {project.discovery && (
        <Card>
          <CardHeader title="Latest discovery" actions={<StatusPill status={project.discovery.status} />} />
          <CardBody>
            <p className="text-sm text-slate-700">{project.discovery.summary || "Discovery in progress."}</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => onNavigate("discovery")}>
              Open app map
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
