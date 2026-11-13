"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CircleX, FileText } from "lucide-react";
import { ApiError, buildQuery } from "@/lib/api";
import type { ScanDetail, StageState } from "@/lib/contract";
import { accessGapRows, scanActive, scanSignIn } from "@/lib/discovery";
import { fmtDate } from "@/lib/format";
import { activeStage } from "@/lib/lifecycle";
import { scanNumber } from "@/lib/url";
import { Button, Callout, Card, EmptyState, ErrorState, LinkButton, SelectField, Skeleton, Spinner, TabPanel, Tabs } from "@/components/ui";
import { AgentActivityFeed } from "@/components/domain/AgentActivityFeed";
import { DiscoveryGateReview, GateBanner } from "@/components/domain/GateReviewPanel";
import { useProject } from "@/components/workspace/ProjectContext";
import { useAllPages, useFeatures, useJourneys, useScan, useScans, useSitemap } from "@/components/discovery/hooks";
import { LiveDiscovery } from "@/components/discovery/LiveDiscovery";
import { DiscoverySummary } from "@/components/discovery/DiscoverySummary";
import { SitemapView } from "@/components/discovery/SitemapTree";
import { PageDetailDrawer } from "@/components/discovery/PageDetailDrawer";
import { FeatureList, FunctionalityMatrix } from "@/components/discovery/FunctionalityMatrix";
import { JourneyCard } from "@/components/discovery/JourneyCard";
import { ResponsiveCompare } from "@/components/discovery/ResponsiveCompare";
import { AccessGaps } from "@/components/discovery/AccessGaps";

const VIEWS = ["live", "summary", "sitemap", "functionality", "journeys", "responsive", "gaps"] as const;
type View = (typeof VIEWS)[number];

/** Banner for a finished scan that is partial, failed or empty (design spec §8.5). */
function ScanStateBanner({ scan, onRescan }: { scan: ScanDetail; onRescan: () => void }) {
  const n = scan.stats.pages;
  const rescan = (
    <Button variant="secondary" onClick={onRescan}>
      Re-scan
    </Button>
  );
  if (scan.status === "cancelled")
    return (
      <Callout tone="neutral" actions={rescan}>
        Discovery was cancelled after {n} page{n === 1 ? "" : "s"}. Results below are partial.
      </Callout>
    );
  if (scan.status === "partial")
    return (
      <Callout tone="warning" actions={rescan}>
        Discovery stopped early after {n} page{n === 1 ? "" : "s"}{scan.error ? `: ${scan.error}` : ""}. Results below are partial.
      </Callout>
    );
  if (scan.status === "failed" && n > 0)
    return (
      <Callout tone="danger" actions={rescan}>
        Discovery stopped early: {scan.error || "an unexpected error"}. Results from {n} page{n === 1 ? "" : "s"} are shown.
      </Callout>
    );
  return null;
}

function Discovery() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const scanParam = params.get("scan");
  const requestedN = scanParam && /^\d+$/.test(scanParam) ? Number(scanParam) : null;
  const scans = useScans(p.id);
  const scanQ = useScan(p.id, requestedN);
  const scan = scanQ.data;
  const latestN = useMemo(() => Math.max(0, ...(scans.data?.items ?? []).map((s) => scanNumber(s.key) ?? 0)), [scans.data]);
  const thisN = scan ? scanNumber(scan.key) : null;
  const isOlder = !!(thisN && latestN && thisN < latestN);
  const active = !!scan && scanActive(scan.status) && !isOlder;
  const signIn = scan ? scanSignIn(scan) : null;
  const pages = useAllPages(scan?.id, active);
  const sitemap = useSitemap(scan?.id, active);
  const features = useFeatures(scan && !active ? scan.id : null);
  const journeys = useJourneys(scan && !active ? scan.id : null);
  const [pageId, setPageId] = useState<string | null>(null);

  const requestedView = params.get("view") as View | null;
  const view: View = requestedView && VIEWS.includes(requestedView) && (requestedView !== "live" || active) ? requestedView : active ? "live" : "summary";

  // Refresh scans/details when the stage changes (new scan, finished scan).
  const discStatus = p.discovery?.status;
  useEffect(() => {
    void scans.mutate();
    void scanQ.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on stage transitions
  }, [discStatus, p.discovery?.current_version]);

  useEffect(() => {
    document.title = `Application Discovery · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  const gateStage: StageState | undefined = p.workflow?.stages.find((s) => s.gate?.key === "G2");
  const reviewHref = `/projects/${p.id}/discovery${buildQuery({ view: "summary", scan: requestedN })}#gate-review`;
  const reportHref = `/projects/${p.id}/reports/discovery`;
  const pageList = useMemo(() => pages.data ?? [], [pages.data]);
  const pageMap = useMemo(() => new Map(pageList.map((x) => [x.id, x])), [pageList]);
  const gapCount = scan ? accessGapRows(scan).length : undefined;

  function go(next: Partial<{ view: View; scan: number | null }>) {
    const q = buildQuery({ view: next.view ?? view, scan: next.scan === undefined ? requestedN : next.scan });
    router.replace(`/projects/${p.id}/discovery${q}`, { scroll: false });
  }

  const notStarted = scanQ.error instanceof ApiError && scanQ.error.status === 404;
  const stageWorking = !!activeStage(p.workflow);

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Application Discovery
      </h1>
      <div className="flex flex-wrap items-end gap-3">
        {scans.data && scans.data.items.length > 0 && (
          <SelectField
            label="Scan"
            value={String(thisN ?? latestN)}
            onChange={(e) => go({ scan: Number(e.target.value) === latestN ? null : Number(e.target.value), view: "summary" })}
            options={scans.data.items
              .map((s) => ({ n: scanNumber(s.key) ?? 0, s }))
              .sort((a, b) => b.n - a.n)
              .map(({ n, s }) => ({
                value: String(n),
                // The latest scan's run state follows the workflow stage (it changes first on Pause/Resume).
                label: `Scan ${n} · ${fmtDate(s.started_at)} · ${n === latestN && scanActive(s.status) && p.discovery?.status === "paused" ? "paused" : s.status}`,
              }))}
            wrapClassName="w-64"
          />
        )}
        <LinkButton href={`${reportHref}${thisN ? `?scan=${thisN}` : ""}`} variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />}>
          Open report
        </LinkButton>
      </div>
    </div>
  );

  if (notStarted)
    return (
      <div className="space-y-6">
        {header}
        <Card className="p-8">
          {stageWorking ? (
            <Spinner label="Preparing discovery: validating the site and launching an isolated browser…" />
          ) : (
            <EmptyState title="Discovery hasn’t run yet" description="Start a scan to explore this site." action={<Button onClick={p.openRescan}>Start discovery</Button>} />
          )}
        </Card>
        <AgentActivityFeed events={p.events} streamState={p.streamState} onReconnect={p.reconnect} running={stageWorking} announceAll={p.announceAll} onAnnounceAll={p.setAnnounceAll} />
      </div>
    );

  if (scanQ.error && !scan)
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <ErrorState error={scanQ.error} title="Couldn’t load discovery results." message="Try again." onRetry={() => void scanQ.mutate()} />
        </Card>
      </div>
    );

  if (!scan)
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <span className="sr-only" role="status">
          Loading discovery results…
        </span>
      </div>
    );

  const failedEmpty = scan.status === "failed" && scan.stats.pages === 0;
  const emptyDone = (scan.status === "completed" || scan.status === "partial") && scan.stats.pages === 0;

  const tabs = [
    ...(active ? [{ id: "live", label: "Live" }] : []),
    { id: "summary", label: "Summary" },
    { id: "sitemap", label: "Sitemap" },
    { id: "functionality", label: "Functionality map" },
    { id: "journeys", label: "User journeys" },
    { id: "responsive", label: "Responsive" },
    { id: "gaps", label: "Access gaps", count: gapCount },
  ];

  return (
    <div className="space-y-6">
      {header}
      {isOlder && (
        <Callout
          tone="info"
          actions={
            <Button variant="secondary" onClick={() => go({ scan: null, view: "summary" })}>
              View latest
            </Button>
          }
        >
          You’re viewing Scan {thisN} from {fmtDate(scan.started_at)}. The latest is Scan {latestN}. Older scans are read-only.
        </Callout>
      )}
      {!isOlder && gateStage && view !== "summary" && <GateBanner stage={gateStage} reviewHref={reviewHref} />}
      {!active && <ScanStateBanner scan={scan} onRescan={p.openRescan} />}
      {signIn?.state === "failed" && (
        <Callout
          tone="warning"
          actions={
            <LinkButton href={`/projects/${p.id}/settings?view=credentials`} variant="secondary">
              Replace credentials
            </LinkButton>
          }
        >
          Couldn’t sign in with the credentials provided: {signIn.reason}. Discovery continued on public pages only. We tried once, to avoid locking the account.
        </Callout>
      )}

      {failedEmpty ? (
        <Card>
          <EmptyState
            icon={<CircleX className="h-5 w-5 text-danger-fg" aria-hidden />}
            title={`Discovery failed: ${scan.error || "the site stopped responding"}.`}
            description="No pages were captured."
            action={
              <Button variant="secondary" onClick={p.openRescan}>
                Re-scan or edit settings
              </Button>
            }
          />
        </Card>
      ) : emptyDone ? (
        <Card>
          <EmptyState
            title="No pages could be explored."
            description="The site may block automated browsers."
            action={
              <Button variant="secondary" onClick={p.openRescan}>
                Re-scan
              </Button>
            }
          />
        </Card>
      ) : (
        <div>
          <Tabs tabs={tabs} value={view} onChange={(v) => go({ view: v as View })} label="Discovery views" idPrefix="disc" />
          <TabPanel id={view} idPrefix="disc">
            {view === "live" && (
              <div className="space-y-6">
                <LiveDiscovery scan={scan} />
                <AgentActivityFeed
                  events={p.events}
                  streamState={p.streamState}
                  onReconnect={p.reconnect}
                  running={active}
                  stages={["intake", "discovery", "discovery_report"]}
                  announceAll={p.announceAll}
                  onAnnounceAll={p.setAnnounceAll}
                  reviewHref={reviewHref}
                />
              </div>
            )}
            {view === "summary" && (
              <div className="space-y-6">
                {gateStage && !isOlder && (
                  <DiscoveryGateReview
                    projectId={p.id}
                    stage={gateStage}
                    scan={scan}
                    journeys={journeys.data?.length}
                    onDecided={p.refresh}
                    onRescan={p.openRescan}
                    reportHref={reportHref}
                  />
                )}
                <DiscoverySummary scan={scan} features={features.data} journeys={journeys.data} />
              </div>
            )}
            {view === "sitemap" && (pages.data ? <SitemapView sitemap={sitemap.data} pages={pageList} onOpenPage={setPageId} /> : <Spinner label="Loading pages…" />)}
            {view === "functionality" &&
              (pages.data ? (
                <div className="space-y-6">
                  <FunctionalityMatrix pages={pageList} />
                  {features.data ? <FeatureList features={features.data} pages={pageList} /> : active ? null : <Spinner label="Loading features…" />}
                </div>
              ) : (
                <Spinner label="Loading pages…" />
              ))}
            {view === "journeys" &&
              (active ? (
                <EmptyState title="Journeys are identified when discovery finishes." />
              ) : !journeys.data ? (
                journeys.error ? (
                  <ErrorState error={journeys.error} title="Couldn’t load discovery results." message="Try again." onRetry={() => void journeys.mutate()} />
                ) : (
                  <Spinner label="Loading journeys…" />
                )
              ) : journeys.data.length === 0 ? (
                <EmptyState title="No user journeys were identified." description="Journeys need at least two linked pages with a clear goal." />
              ) : (
                <div className="space-y-4">
                  {journeys.data.map((j) => (
                    <JourneyCard key={j.id} journey={j} pages={pageMap} />
                  ))}
                </div>
              ))}
            {view === "responsive" && <ResponsiveCompare pages={pageList} includeMobile={scan.limits?.include_mobile ?? true} onRescan={p.openRescan} />}
            {view === "gaps" && <AccessGaps scan={scan} projectId={p.id} onRescan={p.openRescan} />}
          </TabPanel>
        </div>
      )}
      <PageDetailDrawer pageId={pageId} onClose={() => setPageId(null)} />
    </div>
  );
}

export default function DiscoveryPage() {
  return (
    <Suspense>
      <Discovery />
    </Suspense>
  );
}
