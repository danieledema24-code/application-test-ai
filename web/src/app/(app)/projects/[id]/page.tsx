"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ScanDetail } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { activeStage, waitingGateStage } from "@/lib/lifecycle";
import { Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { LifecycleProgress } from "@/components/domain/LifecycleProgress";
import { AgentActivityFeed } from "@/components/domain/AgentActivityFeed";
import { GateBanner } from "@/components/domain/GateReviewPanel";
import { useProject } from "@/components/workspace/ProjectContext";

function Glance({ projectId, running }: { projectId: string; running: boolean }) {
  const { data, error } = useApi<ScanDetail>(`/projects/${projectId}/discovery`, undefined, { refreshInterval: running ? 5000 : 0 });
  const none = error instanceof ApiError && error.status === 404;
  return (
    <Card>
      <CardHeader title="Discovery at a glance" />
      <CardBody>
        {none ? (
          <p className="text-body text-fg-muted">Discovery hasn’t started yet.</p>
        ) : !data ? (
          error ? (
            <p className="text-body text-fg-muted">Couldn’t load discovery results.</p>
          ) : (
            <Skeleton className="h-12" />
          )
        ) : (
          <dl className="grid grid-cols-2 gap-3">
            {[
              ["Pages", data.stats.pages],
              ["Forms", data.stats.forms],
              ["Access gaps", data.access_gaps.length],
              ["Pages found", data.pages_found],
            ].map(([k, v]) => (
              <div key={k as string}>
                <dt className="text-small text-fg-muted">{k}</dt>
                <dd className="text-h2 font-semibold tabular-nums text-fg-strong">
                  {v}
                  {running && k === "Pages" ? <span className="text-small font-normal text-fg-muted"> so far</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <Link href={`/projects/${projectId}/discovery`} className="mt-4 inline-flex items-center gap-1 text-body font-medium text-navy-700 hover:underline">
          Open Discovery <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </Card>
  );
}

function Scope() {
  const p = useProject();
  const project = p.project;
  const url = project?.urls?.[0];
  const s = project?.settings;
  return (
    <Card>
      <CardHeader title="Scope & authorisation" />
      <CardBody>
        {!project ? (
          <Skeleton className="h-20" />
        ) : (
          <ul className="space-y-1 text-body text-fg">
            <li className="break-words">{url?.allowed_hosts?.length ? url.allowed_hosts.join(", ") : project.primary_url}</li>
            {s && (
              <li className="tabular-nums">
                Up to {s.max_pages} pages · depth {s.max_depth}
              </li>
            )}
            {s && <li>{s.include_mobile ? "Desktop + Mobile" : "Desktop only"}</li>}
            <li>No credentials (public pages only)</li>
            <li className="pt-2 text-small text-fg-muted">
              <span className="font-medium text-fg-strong">Gate 1:</span>{" "}
              {url?.authorised_by || url?.authorised_at ? (
                <>
                  Authorised by {url?.authorised_by?.full_name ?? url?.authorised_by?.email ?? project.created_by?.full_name ?? "the project creator"}
                  {url?.authorised_at ? `, ${fmtDateTime(url.authorised_at)}` : ""}
                </>
              ) : (
                <>Authorisation {url?.authorisation_status ?? "recorded"} when the project was created</>
              )}
            </li>
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export default function ProjectOverviewPage() {
  const p = useProject();
  const router = useRouter();
  const waiting = waitingGateStage(p.workflow);
  const running = !!activeStage(p.workflow);
  const reviewHref = `/projects/${p.id}/discovery?view=summary#gate-review`;
  useEffect(() => {
    if (p.project) document.title = `${p.project.name} · QA Analyst`;
  }, [p.project]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="QA lifecycle" />
        <CardBody>
          {p.workflow ? (
            <LifecycleProgress variant="full" workflow={p.workflow} projectId={p.id} onRerun={p.openRescan} onReviewGate={() => router.push(reviewHref)} />
          ) : (
            <Skeleton className="h-16" />
          )}
        </CardBody>
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AgentActivityFeed
            events={p.events}
            streamState={p.streamState}
            onReconnect={p.reconnect}
            running={running}
            announceAll={p.announceAll}
            onAnnounceAll={p.setAnnounceAll}
            reviewHref={reviewHref}
          />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Needs your attention" />
            <CardBody>{waiting ? <GateBanner stage={waiting} reviewHref={reviewHref} /> : <p className="text-body text-fg-muted">Nothing needs your attention.</p>}</CardBody>
          </Card>
          <Glance projectId={p.id} running={running} />
          <Scope />
        </div>
      </div>
    </div>
  );
}
