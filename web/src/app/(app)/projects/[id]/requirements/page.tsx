"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, RefreshCw } from "lucide-react";
import { api, buildQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { StageState } from "@/lib/contract";
import { filtersToQuery, parseFilters, type ReqFilters } from "@/lib/requirements";
import { Button, Callout, Card, CardBody, EmptyState, ErrorState, LinkButton, Skeleton, Spinner, TabPanel, Tabs, useToast } from "@/components/ui";
import { AgentActivityFeed } from "@/components/domain/AgentActivityFeed";
import { GateBanner } from "@/components/domain/GateReviewPanel";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { OutOfDateCallout } from "@/components/domain/OutOfDateCallout";
import { OlderVersionBanner, VersionSelect } from "@/components/domain/VersionSelect";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, isWorking, requirementsStages, useAllRequirements, useDocuments, useReadiness, useRequirementStats, useStageRuns, runLabel } from "@/components/requirements/hooks";
import { RequirementsTable } from "@/components/requirements/RequirementsTable";
import { ReadinessTab } from "@/components/requirements/Readiness";
import { SourceDocuments } from "@/components/requirements/Documents";
import { Gate3Review } from "@/components/requirements/Gate3Review";
import { RegenerateDialog, requirementsRegenerateCopy } from "@/components/requirements/RegenerateDialog";

const VIEWS = ["list", "readiness", "sources", "review"] as const;
type View = (typeof VIEWS)[number];

/** Step list while the first generation runs (design §5.9). */
function RunningCard({ req, dor, scanN, docs }: { req: StageState; dor: StageState | undefined; scanN: number | null; docs: number }) {
  const step = (label: string, s: StageState | undefined, n: number) => {
    const st = s?.status;
    const text = st === "running" ? "Running" : st === "queued" ? "Queued" : st === "completed" || st === "approved" || st === "awaiting_approval" ? "Done" : st === "failed" ? "Failed" : "Waiting";
    return (
      <li key={n} className="flex items-center justify-between gap-3 text-body">
        <span>
          <span className="mr-1 tabular-nums text-fg-muted">{n}</span> {label}
        </span>
        <span className="text-small text-fg-muted">{text}</span>
      </li>
    );
  };
  return (
    <Card>
      <CardBody className="space-y-3">
        <Spinner label={`The Requirements Engineering Agent is deriving requirements from ${scanN ? `Scan ${scanN}` : "the latest scan"}${docs ? ` and ${docs} document${docs === 1 ? "" : "s"}` : ""}.`} />
        {req.progress?.label && <p className="text-small text-fg-muted">{req.progress.label}</p>}
        <ol className="space-y-1.5">
          {step("Derive requirements", req, 9)}
          {step("Acceptance criteria", req, 10)}
          {step("Ready & Done", dor, 11)}
        </ol>
      </CardBody>
    </Card>
  );
}

function Requirements() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const canEdit = role !== "viewer";
  const requested = params.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "list";
  const filters = useMemo(() => parseFilters(params), [params]);

  const stages = requirementsStages(p.workflow);
  const req = stages.req;
  const current = req?.current_version ?? null;
  const vParam = Number(params.get("version") ?? "");
  const olderVersion = current && Number.isInteger(vParam) && vParam > 0 && vParam !== current ? vParam : null;
  const runs = useStageRuns(p.id, "requirements", !!current);
  const all = useAllRequirements(p.id, olderVersion, !!current);
  const stats = useRequirementStats(p.id, !!current, olderVersion);
  const readiness = useReadiness(p.id, !!current, olderVersion);
  const [pollDocs, setPollDocs] = useState(false);
  const docs = useDocuments(p.id, true, pollDocs);
  const extracting = !!docs.data?.some((d) => d.status === "extracting");
  useEffect(() => setPollDocs(extracting), [extracting]);

  const [regenOpen, setRegenOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    document.title = `Requirements · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  // Reload the set when the stage moves to a new version or finishes a run.
  const reqStatus = req?.status;
  useEffect(() => {
    if (!current) return;
    void all.mutate();
    void stats.mutate();
    void readiness.mutate();
    void runs.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on stage transitions
  }, [current, reqStatus, stages.dor?.status, req?.pending_review?.version]);

  // Filters, tabs and versions push a history entry so Back restores them; only typing in search replaces it.
  function go(next: { view?: View; filters?: ReqFilters; version?: number | null }, replace = false) {
    const q = buildQuery({
      view: (next.view ?? view) === "list" ? undefined : (next.view ?? view),
      version: next.version === undefined ? (olderVersion ?? undefined) : (next.version ?? undefined),
      ...filtersToQuery(next.filters ?? filters),
    });
    const url = `/projects/${p.id}/requirements${q}`;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }

  async function generate() {
    setStarting(true);
    try {
      await api(`/projects/${p.id}/stages/requirements/run`, { body: { reason: "start", parameters: { include_documents: true } } });
      p.refresh();
    } catch (err) {
      toast(`Couldn’t start requirements generation. ${err instanceof Error ? err.message : ""}`.trim(), "error");
    } finally {
      setStarting(false);
    }
  }

  const scanN = p.discovery?.current_version ?? null;
  const readyDocs = (docs.data ?? []).filter((d) => d.status === "ready");
  const rows = all.data ?? [];
  const live = rows.filter((r) => r.status !== "rejected");
  const g3Approved = gateApproved(stages.g3);
  const pending = req?.pending_review ?? null;
  const currentRun = runs.data?.find((r) => r.version === current);
  const generatedAt = currentRun?.finished_at ?? currentRun?.created_at ?? null;
  const newDocs = generatedAt ? readyDocs.filter((d) => d.created_at > generatedAt).length : 0;
  const regen = requirementsRegenerateCopy({
    scanN,
    documents: readyDocs.length,
    protectedCount: rows.filter((r) => r.locked || r.human_edited).length,
    rejected: rows.filter((r) => r.status === "rejected").length,
  });
  const openRegen = (g = "") => {
    setGuidance(g);
    setRegenOpen(true);
  };
  const running = isWorking(req) || isWorking(stages.dor);
  const readOnly = !!olderVersion;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          Requirements
        </h1>
        {stats.data?.generated_by && <GeneratedByLabel generatedBy={stats.data.generated_by} />}
      </div>
      {current ? (
        <div className="flex flex-wrap items-end gap-3">
          <VersionSelect
            versions={(runs.data ?? [])
              .filter((r) => r.version <= current || r.review_status === "discarded")
              .sort((a, b) => b.version - a.version)
              .map((r) => ({ version: r.version, label: runLabel(r, current) }))}
            value={olderVersion ?? current}
            onChange={(v) => go({ version: v === current ? null : v })}
          />
          {canEdit && (
            <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => openRegen()} disabled={running || !!pending}>
              Regenerate…
            </Button>
          )}
          <LinkButton href={`/projects/${p.id}/reports/requirements`} variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />}>
            Open report
          </LinkButton>
        </div>
      ) : null}
    </div>
  );

  // ---- Banners (design §5.1, §5.8, §5.9) ----
  const banners: React.ReactNode[] = [];
  if (olderVersion && current)
    banners.push(<OlderVersionBanner key="older" what="requirements" n={olderVersion} latest={current} onViewLatest={() => go({ version: null })} />);
  if (!olderVersion && current && req?.status === "stale")
    banners.push(
      <OutOfDateCallout
        key="stale"
        title="Requirements may be out of date"
        actions={
          canEdit ? (
            <Button variant="secondary" onClick={() => openRegen()}>
              Regenerate…
            </Button>
          ) : undefined
        }
      >
        {req.stale_reason ||
          `They were generated from ${req.approved_input?.stage_key === "discovery" ? `Scan ${req.approved_input.version}` : "an earlier scan"}.${scanN ? ` Scan ${scanN} is the latest.` : ""}`}{" "}
        Regenerate to update them; locked and edited requirements are kept.
      </OutOfDateCallout>,
    );
  if (!olderVersion && current && running && !pending)
    banners.push(
      <Callout key="regen" tone="info">
        Regenerating requirements… The current version stays in use until you apply changes.
      </Callout>,
    );
  if (!olderVersion && pending)
    banners.push(
      <Callout key="pending" tone="info" actions={<LinkButton href={`/projects/${p.id}/requirements/changes?run=${pending.version}`}>Review changes</LinkButton>}>
        Regenerated requirements are ready to review.
      </Callout>,
    );
  if (!olderVersion && current && stats.data?.generated_by === "rules")
    banners.push(
      <Callout key="rules" tone="info">
        Generated by rules (AI not configured). Rules cover forms, navigation, search and sign-in. Non-functional requirements are limited; add them yourself or set up AI.
      </Callout>,
    );
  if (!olderVersion && currentRun?.partial)
    banners.push(
      <Callout
        key="partial"
        tone="warning"
        actions={
          canEdit ? (
            <Button variant="secondary" onClick={() => openRegen()}>
              Regenerate…
            </Button>
          ) : undefined
        }
      >
        Requirements are partial: the agent stopped at its limit.
        {stats.data?.features_without_requirement.length
          ? ` ${stats.data.features_without_requirement.length} feature${stats.data.features_without_requirement.length === 1 ? " wasn’t" : "s weren’t"} covered: ${stats.data.features_without_requirement.map((f) => f.label).join(", ")}.`
          : ""}
      </Callout>,
    );
  if (!olderVersion && stages.g3 && view !== "review") banners.push(<GateBanner key="g3" stage={stages.g3} reviewHref={`/projects/${p.id}/requirements?view=review`} />);

  // ---- Not generated yet (design §5.9) ----
  function notGenerated() {
    if (!req) return <EmptyState title="Requirements aren’t available for this project." />;
    if (req.status === "paused")
      return (
        <Callout tone="warning" actions={<Button onClick={() => void p.resume()}>Resume analysis</Button>}>
          Requirements generation is paused.
        </Callout>
      );
    if (isWorking(req)) return <RunningCard req={req} dor={stages.dor} scanN={scanN} docs={readyDocs.length} />;
    if (req.status === "failed")
      return (
        <Card>
          <ErrorState
            error={null}
            title={`Requirements generation failed${req.stale_reason ? `: ${req.stale_reason}` : ""}.`}
            message="Discovery results are unaffected."
            onRetry={canEdit ? () => void generate() : undefined}
          />
        </Card>
      );
    const disc = stages.discovery;
    const discDone = disc && ["completed", "approved", "awaiting_approval"].includes(disc.status);
    if (!discDone)
      return (
        <EmptyState
          title="Requirements are derived after discovery finishes."
          action={<LinkButton href={`/projects/${p.id}/discovery`}>Go to Application Discovery</LinkButton>}
        />
      );
    if (stages.g2 && !gateApproved(stages.g2) && stages.g2.gate?.policy === "required")
      return (
        <div className="space-y-4">
          <GateBanner stage={stages.g2} reviewHref={`/projects/${p.id}/discovery?view=summary#gate-review`} />
          <EmptyState
            title="Requirements start when Gate 2 (Discovery completeness) is approved."
            action={<LinkButton href={`/projects/${p.id}/discovery?view=summary#gate-review`}>Review Gate 2</LinkButton>}
          />
        </div>
      );
    return (
      <EmptyState
        title="Requirements haven’t been generated yet."
        description={`The Requirements Engineering Agent derives them from ${scanN ? `Scan ${scanN}` : "the latest scan"}${readyDocs.length ? ` and ${readyDocs.length} document${readyDocs.length === 1 ? "" : "s"}` : ""}.`}
        action={
          canEdit ? (
            <Button onClick={() => void generate()} loading={starting}>
              Generate requirements
            </Button>
          ) : undefined
        }
      />
    );
  }

  function listPanel() {
    if (!current) return notGenerated();
    if (all.error && !all.data) return <ErrorState error={all.error} title="Couldn’t load requirements." message="Try again." onRetry={() => void all.mutate()} />;
    if (!all.data)
      return (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
          <span className="sr-only" role="status">
            Loading requirements…
          </span>
        </div>
      );
    if (live.length === 0 && !filters.showRejected && !filters.status)
      return (
        <EmptyState
          title="No requirements yet."
          description="Discovery found too little to derive them. Add one yourself or re-scan."
          action={
            canEdit && !readOnly ? (
              <div className="flex flex-wrap justify-center gap-2">
                <LinkButton href={`/projects/${p.id}/requirements/new`}>Add requirement</LinkButton>
                <Button variant="secondary" onClick={p.openRescan}>
                  Re-scan site
                </Button>
              </div>
            ) : undefined
          }
        />
      );
    return (
      <RequirementsTable
        projectId={p.id}
        all={rows}
        filters={filters}
        setFilters={(f, o) => go({ filters: f }, o?.replace ?? false)}
        readOnly={readOnly}
        canEdit={canEdit}
        onChanged={async () => {
          await all.mutate();
          void stats.mutate();
          p.refresh();
        }}
        detailQuery={olderVersion ? { v: String(olderVersion) } : undefined}
      />
    );
  }

  const tabs = [
    { id: "list", label: "Requirements", count: current && all.data ? live.length : undefined },
    { id: "readiness", label: "Ready & Done" },
    { id: "sources", label: "Source documents", count: docs.data ? docs.data.filter((d) => d.status !== "withdrawn").length : undefined },
    { id: "review", label: "Review · Gate 3" },
  ];

  return (
    <div className="space-y-6">
      {header}
      {banners}
      <div>
        <Tabs tabs={tabs} value={view} onChange={(v) => go({ view: v as View })} label="Requirements views" idPrefix="req" />
        <TabPanel id={view} idPrefix="req">
          {view === "list" && listPanel()}
          {view === "readiness" &&
            (current ? (
              <ReadinessTab
                projectId={p.id}
                data={readiness.data}
                error={readiness.error}
                loading={readiness.isLoading}
                canEdit={canEdit && !readOnly}
                approvedAt={g3Approved ? (stages.g3?.finished_at ?? null) : null}
                onChanged={() => {
                  void readiness.mutate();
                  p.refresh();
                }}
              />
            ) : (
              <EmptyState title="Ready and Done criteria are generated with the requirements." />
            ))}
          {view === "sources" && (
            <SourceDocuments
              projectId={p.id}
              docs={docs.data}
              loading={docs.isLoading}
              error={docs.error}
              onChanged={() => {
                void docs.mutate();
                p.refresh();
              }}
              requirementsExist={!!current}
              newSinceGeneration={newDocs}
              onRegenerate={() => openRegen()}
            />
          )}
          {view === "review" &&
            (!current || !stages.g3 ? (
              notGenerated()
            ) : !all.data ? (
              <Spinner label="Loading requirements…" />
            ) : (
              <Gate3Review
                projectId={p.id}
                stage={stages.g3}
                all={rows}
                readiness={readiness.data}
                scanN={scanN}
                documents={readyDocs.length}
                readOnly={readOnly}
                onDecided={p.refresh}
                onRegenerateWithFeedback={(c) => openRegen(c)}
              />
            ))}
        </TabPanel>
      </div>
      {running && current && (
        <AgentActivityFeed
          events={p.events}
          streamState={p.streamState}
          onReconnect={p.reconnect}
          running={running}
          stages={["requirements", "readiness_criteria"]}
          announceAll={p.announceAll}
          onAnnounceAll={p.setAnnounceAll}
        />
      )}
      {!current && isWorking(req) && (
        <AgentActivityFeed
          events={p.events}
          streamState={p.streamState}
          onReconnect={p.reconnect}
          running
          stages={["requirements", "readiness_criteria"]}
          announceAll={p.announceAll}
          onAnnounceAll={p.setAnnounceAll}
        />
      )}
      <RegenerateDialog
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        projectId={p.id}
        stage="requirements"
        title={regen.title}
        intro={regen.intro}
        bullets={regen.bullets}
        initialGuidance={guidance}
        onStarted={p.refresh}
      />
    </div>
  );
}

export default function RequirementsPage() {
  return (
    <Suspense>
      <Requirements />
    </Suspense>
  );
}
