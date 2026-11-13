"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Page, Proposal, Risk, ScanDetail, SecretMeta } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { activeStage, gateReview, waitingLabel } from "@/lib/lifecycle";
import { LEVEL_TEXT } from "@/lib/strategy";
import { attentionRows } from "@/lib/attention";
import { useAuth } from "@/lib/auth";
import { useCaseStats, useCoverage, useGaps } from "@/components/testcases/hooks";
import { Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { gateApproved, requirementsStages, useAllRequirements, useAllRisks } from "@/components/requirements/hooks";
import { lastSignInText } from "@/components/domain/Credentials";
import { LifecycleProgress } from "@/components/domain/LifecycleProgress";
import { AgentActivityFeed } from "@/components/domain/AgentActivityFeed";
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
  const secrets = useApi<SecretMeta[]>(`/projects/${p.id}/secrets`, undefined, { shouldRetryOnError: false });
  const cred = secrets.data?.find((x) => x.name === "scan_credentials" || x.kind === "login_credentials");
  const credText = !secrets.data ? null : !cred ? "none" : cred.last_result === "succeeded" ? "saved · last sign-in succeeded" : cred.last_result === "failed" ? "saved · last sign-in failed" : "saved · not used yet";
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
            <li>
              Test credentials: {credText ?? "…"}{" "}
              <Link href={`/projects/${p.id}/settings?view=credentials`} className="font-medium text-navy-700 underline underline-offset-2">
                Manage
              </Link>
            </li>
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

function Attention() {
  const p = useProject();
  const { canApprove } = useAuth();
  const [all, setAll] = useState(false);
  const stages = requirementsStages(p.workflow);
  const reqs = useAllRequirements(p.id, null, !!stages.req?.current_version);
  const caseStats = useCaseStats(p.id, !!stages.design?.current_version);
  const proposals = useApi<Page<Proposal>>(`/projects/${p.id}/assistant/proposals`, { status: "pending", limit: 100 }, { shouldRetryOnError: false });
  const secrets = useApi<SecretMeta[]>(`/projects/${p.id}/secrets`, undefined, { shouldRetryOnError: false });
  const cred = secrets.data?.find((x) => x.name === "scan_credentials" || x.kind === "login_credentials");
  const rows = attentionRows({
    projectId: p.id,
    wf: p.workflow,
    credFailed: !!cred && lastSignInText(cred).tone === "warn",
    conflicts: (reqs.data ?? []).filter((r) => r.conflict && r.status !== "rejected").length,
    proposals: proposals.data?.items.length ?? 0,
    drafts: (reqs.data ?? []).filter((r) => r.status === "draft").length,
    openQuestions: caseStats.data?.open_questions ?? 0,
    canApprove,
  });
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <Card>
      <CardHeader title="Needs your attention" />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-body text-fg-muted">Nothing needs your attention.</p>
        ) : (
          <ul className="space-y-2">
            {shown.map((r) => (
              <li key={r.text} className="flex flex-wrap items-baseline justify-between gap-2 text-body text-fg">
                <span>{r.text}</span>
                <Link href={r.href} className="shrink-0 font-medium text-navy-700 underline underline-offset-2">
                  {r.action}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 5 && !all && (
          <button type="button" onClick={() => setAll(true)} className="mt-2 text-small font-medium text-navy-700 underline underline-offset-2">
            Show all {rows.length}
          </button>
        )}
      </CardBody>
    </Card>
  );
}

function gateLine(st: ReturnType<typeof requirementsStages>["g3"], n: number, canApprove = true): string | null {
  if (!st?.gate) return null;
  const review = gateReview(st);
  if (review) return `Gate ${n} ${review === "required" ? waitingLabel(canApprove).toLowerCase() : "ready for review"}`;
  if (gateApproved(st)) return `Gate ${n} approved`;
  if (st.status === "changes_requested") return `Gate ${n}: changes requested`;
  return null;
}

function RequirementsGlance() {
  const p = useProject();
  const { canApprove } = useAuth();
  const stages = requirementsStages(p.workflow);
  const reqs = useAllRequirements(p.id, null, !!stages.req?.current_version);
  const live = (reqs.data ?? []).filter((r) => r.status !== "rejected");
  return (
    <Card>
      <CardHeader title="Requirements at a glance" />
      <CardBody className="space-y-1 text-body text-fg">
        {!stages.req?.current_version ? (
          <p className="text-fg-muted">Starts after Gate 2.</p>
        ) : !reqs.data ? (
          <Skeleton className="h-10" />
        ) : (
          <>
            <p>
              {live.length} requirements · {live.filter((r) => r.status === "approved").length} approved · {live.filter((r) => r.classification === "assumed" || r.classification === "unverified").length} Assumed or Unverified
            </p>
            {gateLine(stages.g3, 3, canApprove) && <p className="text-small text-fg-muted">{gateLine(stages.g3, 3, canApprove)}</p>}
          </>
        )}
        <Link href={`/projects/${p.id}/requirements`} className="mt-3 inline-flex items-center gap-1 font-medium text-navy-700 hover:underline">
          Open Requirements <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </Card>
  );
}

function StrategyGlance() {
  const p = useProject();
  const { canApprove } = useAuth();
  const stages = requirementsStages(p.workflow);
  const has = !!stages.strategy?.current_version;
  const risks = useAllRisks(p.id, has);
  const strategy = useApi<{ sections: { test_types: { in_scope: boolean }[] } }>(has ? `/projects/${p.id}/test-strategy` : null, undefined, { shouldRetryOnError: false });
  const count = (l: Risk["level"]) => (risks.data ?? []).filter((r) => r.level === l).length;
  return (
    <Card>
      <CardHeader title="Test Strategy at a glance" />
      <CardBody className="space-y-1 text-body text-fg">
        {!has ? (
          <p className="text-fg-muted">Starts after Gate 3.</p>
        ) : !risks.data ? (
          <Skeleton className="h-10" />
        ) : (
          <>
            <p>
              {risks.data.length} risks · {count("very_high")} {LEVEL_TEXT.very_high} · {count("high")} {LEVEL_TEXT.high}
            </p>
            {strategy.data && <p>{strategy.data.sections.test_types.filter((t) => t.in_scope).length} test types in scope</p>}
            {gateLine(stages.g4, 4, canApprove) && <p className="text-small text-fg-muted">{gateLine(stages.g4, 4, canApprove)}</p>}
          </>
        )}
        <Link href={`/projects/${p.id}/test-strategy`} className="mt-3 inline-flex items-center gap-1 font-medium text-navy-700 hover:underline">
          Open Test Strategy <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </Card>
  );
}

function TestCasesGlance() {
  const p = useProject();
  const { canApprove } = useAuth();
  const stages = requirementsStages(p.workflow);
  const has = !!stages.design?.current_version;
  const stats = useCaseStats(p.id, has);
  const d = stats.data;
  const oq = d?.open_questions ?? 0;
  return (
    <Card>
      <CardHeader title="Test cases at a glance" />
      <CardBody className="space-y-1 text-body text-fg">
        {!has ? (
          <p className="text-fg-muted">Starts after Gate 4.</p>
        ) : !d ? (
          stats.error ? <p className="text-fg-muted">Couldn’t load the test case counts.</p> : <Skeleton className="h-10" />
        ) : (
          <>
            <p>
              {d.total} case{d.total === 1 ? "" : "s"} · {d.by_status?.approved ?? 0} approved · {oq} open question{oq === 1 ? "" : "s"}
            </p>
            {gateLine(stages.g5, 5, canApprove) && <p className="text-small text-fg-muted">{gateLine(stages.g5, 5, canApprove)}</p>}
          </>
        )}
        <Link href={`/projects/${p.id}/test-cases`} className="mt-3 inline-flex items-center gap-1 font-medium text-navy-700 hover:underline">
          Open Test Cases <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </Card>
  );
}

function TraceabilityGlance() {
  const p = useProject();
  const stages = requirementsStages(p.workflow);
  const has = !!stages.design?.current_version;
  const coverage = useCoverage(p.id, "current", has);
  const gaps = useGaps(p.id, "current", has);
  const c = coverage.data;
  const risks = gaps.data?.untested_high_risk?.open?.length;
  return (
    <Card>
      <CardHeader title="Traceability at a glance" />
      <CardBody className="space-y-1 text-body text-fg">
        {!has ? (
          <p className="text-fg-muted">Starts after Gate 4.</p>
        ) : !c ? (
          coverage.error ? <p className="text-fg-muted">Couldn’t load coverage.</p> : <Skeleton className="h-10" />
        ) : (
          <p>
            {c.requirements.with_approved_case} of {c.requirements.approved} approved requirements covered
            {risks !== undefined ? ` · ${risks} untested high risk${risks === 1 ? "" : "s"}` : ""}
          </p>
        )}
        <Link href={`/projects/${p.id}/traceability`} className="mt-3 inline-flex items-center gap-1 font-medium text-navy-700 hover:underline">
          Open Traceability <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </Card>
  );
}

export default function ProjectOverviewPage() {
  const p = useProject();
  const router = useRouter();
  const running = !!activeStage(p.workflow);
  const reviewHref = `/projects/${p.id}/discovery?view=summary#gate-review`;
  const stageHref: Record<string, string> = {
    discovery: reviewHref,
    requirements: `/projects/${p.id}/requirements?view=review`,
    strategy: `/projects/${p.id}/test-strategy?view=review`,
    "test-design": `/projects/${p.id}/test-cases?view=review`,
  };
  useEffect(() => {
    if (p.project) document.title = `${p.project.name} · QA Analyst`;
  }, [p.project]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="QA lifecycle" />
        <CardBody>
          {p.workflow ? (
            <LifecycleProgress
              variant="full"
              workflow={p.workflow}
              projectId={p.id}
              onRerun={(id) =>
                id === "discovery"
                  ? p.openRescan()
                  : router.push(id === "requirements" ? `/projects/${p.id}/requirements` : id === "test-design" ? `/projects/${p.id}/test-cases` : `/projects/${p.id}/test-strategy`)
              }
              onReviewGate={(id) => router.push(stageHref[id] ?? reviewHref)}
            />
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
          <Attention />
          <Glance projectId={p.id} running={running} />
          <RequirementsGlance />
          <StrategyGlance />
          <TestCasesGlance />
          <TraceabilityGlance />
          <Scope />
        </div>
      </div>
    </div>
  );
}
