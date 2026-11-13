"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, Plus, RefreshCw } from "lucide-react";
import { api, buildQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { StageRunDetail, StageState, TestDesignRunOutput } from "@/lib/contract";
import { fmtDate } from "@/lib/format";
import { caseFiltersToQuery, caseTypeText, parseCaseFilters, type CaseFilters } from "@/lib/testcases";
import { Button, Callout, Card, CardBody, Disclosure, EmptyState, ErrorState, LinkButton, Skeleton, Spinner, TabPanel, Tabs } from "@/components/ui";
import { AgentActivityFeed } from "@/components/domain/AgentActivityFeed";
import { GateBanner } from "@/components/domain/GateReviewPanel";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { OutOfDateCallout } from "@/components/domain/OutOfDateCallout";
import { OlderVersionBanner, VersionSelect } from "@/components/domain/VersionSelect";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, isWorking, requirementsStages, runLabel, useAllRequirements, useStageRuns } from "@/components/requirements/hooks";
import { RegenerateDialog, testDesignRegenerateCopy } from "@/components/requirements/RegenerateDialog";
import { useAllConditions, useAllTestCases, useAllTestData, useCaseSearch, useCaseStats, useDesignLint, useGaps } from "@/components/testcases/hooks";
import { TestCasesTable } from "@/components/testcases/TestCasesTable";
import { ConditionDrawerBody, ConditionsTab } from "@/components/testcases/Conditions";
import { TestDataDrawer, TestDataTab } from "@/components/testcases/TestData";
import { Gate5Review } from "@/components/testcases/Gate5Review";
import { Drawer } from "@/components/ui";

const VIEWS = ["cases", "conditions", "data", "review"] as const;
type View = (typeof VIEWS)[number];

function RunningCard({ design, reqN, strategyV }: { design: StageState; reqN: number; strategyV: number | null }) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <Spinner label={`The Test Design Agent is designing test cases from ${reqN} approved requirement${reqN === 1 ? "" : "s"} and the techniques in ${strategyV ? `Strategy v${strategyV}` : "the approved strategy"}.`} />
        {design.progress?.label && <p className="text-small text-fg-muted">{design.progress.label}</p>}
        <ol className="space-y-1.5">
          <li className="flex items-center justify-between gap-3 text-body">
            <span>
              <span className="mr-1 tabular-nums text-fg-muted">13</span> Test conditions &amp; test cases
            </span>
            <span className="text-small text-fg-muted">{design.status === "queued" ? "Queued" : "Running"}</span>
          </li>
          <li className="flex items-center justify-between gap-3 text-body">
            <span>
              <span className="mr-1 tabular-nums text-fg-muted">14</span> Traceability
            </span>
            <span className="text-small text-fg-muted">Waiting</span>
          </li>
        </ol>
      </CardBody>
    </Card>
  );
}

function TestCases() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const { role } = useAuth();
  const canEdit = role !== null && role !== "viewer";
  const canManageSecrets = role === "owner" || role === "admin";
  const requested = params.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "cases";
  const filters = useMemo(() => parseCaseFilters(params), [params]);

  const stages = requirementsStages(p.workflow);
  const design = stages.design;
  const current = design?.current_version ?? null;
  const vParam = Number(params.get("version") ?? "");
  const olderVersion = current && Number.isInteger(vParam) && vParam > 0 && vParam !== current ? vParam : null;
  const readOnly = !!olderVersion;
  const runs = useStageRuns(p.id, "test_design", !!current);
  const run = useApi<StageRunDetail>(current ? `/projects/${p.id}/stages/test_design/runs/${olderVersion ?? current}` : null, undefined, { shouldRetryOnError: false });
  const all = useAllTestCases(p.id, olderVersion, !!current);
  const search = useCaseSearch(p.id, filters.q, olderVersion);
  const stats = useCaseStats(p.id, !!current, olderVersion);
  const conditions = useAllConditions(p.id, olderVersion, !!current && (view === "conditions" || !!params.get("condition")));
  const data = useAllTestData(p.id, olderVersion, !!current && (view === "data" || view === "conditions" || !!params.get("data")));
  const lint = useDesignLint(p.id, !!current && view === "review");
  const gaps = useGaps(p.id, "current", !!current && view === "review");
  const reqs = useAllRequirements(p.id, null, !!current);
  const reqTitles = useMemo(() => Object.fromEntries((reqs.data ?? []).map((r) => [r.key, r.title])), [reqs.data]);

  const [regenOpen, setRegenOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `Test Cases · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  const status = design?.status;
  useEffect(() => {
    if (!current) return;
    void all.mutate();
    void stats.mutate();
    void runs.mutate();
    void conditions.mutate();
    void data.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on stage transitions
  }, [current, status, design?.pending_review?.version, design?.gate?.status]);

  function go(next: { view?: View; filters?: CaseFilters; version?: number | null; extra?: Record<string, string | undefined> }, replace = false) {
    const q = buildQuery({
      view: (next.view ?? view) === "cases" ? undefined : (next.view ?? view),
      version: next.version === undefined ? (olderVersion ?? undefined) : (next.version ?? undefined),
      ...((next.view ?? view) === "cases" ? caseFiltersToQuery(next.filters ?? filters) : {}),
      ...next.extra,
    });
    const url = `/projects/${p.id}/test-cases${q}`;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }
  const listHref = (q: Record<string, string>) => `/projects/${p.id}/test-cases${buildQuery(q)}`;

  async function designNow() {
    setStarting(true);
    setStartError(null);
    try {
      await api(`/projects/${p.id}/stages/test_design/run`, { body: { reason: "start", parameters: {} } });
      p.refresh();
    } catch (err) {
      setStartError(`Couldn’t start test design. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setStarting(false);
    }
  }

  const rows = all.data ?? [];
  const live = rows.filter((c) => c.status !== "rejected" && c.status !== "deprecated");
  const g4Approved = gateApproved(stages.g4);
  const g5Approved = gateApproved(stages.g5);
  const pending = design?.pending_review ?? null;
  const running = isWorking(design);
  const output = (run.data?.output ?? {}) as TestDesignRunOutput & { ai_checks?: string[]; cap_reached?: { requirement_keys?: string[] } | null };
  const reqV = run.data?.upstream_versions?.requirements ?? stages.req?.current_version ?? null;
  const strategyV = run.data?.upstream_versions?.test_strategy ?? stages.strategy?.current_version ?? null;
  const generatedBy = stats.data?.generated_by ?? run.data?.generated_by ?? null;
  const notDesigned = stats.data?.not_designed ?? output.not_designed ?? [];
  const oq = stats.data?.open_questions ?? live.filter((c) => c.expected_result_status === "open_question").length;
  const approvedReqs = (reqs.data ?? []).filter((r) => r.status === "approved").length;
  const regen = testDesignRegenerateCopy({
    reqV,
    strategyV: stages.strategy?.current_version ?? strategyV,
    protectedCount: rows.filter((c) => c.status === "approved" || c.human_edited || c.locked || c.generated_by === "human" || c.source === "user").length,
    rejected: rows.filter((c) => c.status === "rejected").length,
  });
  const openRegen = (g = "") => {
    setGuidance(g);
    setRegenOpen(true);
  };
  // `?regenerate=1` (the Gate 5 "designed from an older strategy" link) opens the dialog once, then drops the flag.
  const wantRegen = params.get("regenerate") === "1";
  useEffect(() => {
    if (!wantRegen) return;
    if (canEdit) openRegen();
    go({ extra: { regenerate: undefined } }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantRegen, canEdit]);
  const conditionKey = params.get("condition");
  const dataKey = params.get("data");
  const closeDrawer = () => go({ extra: { condition: undefined, data: undefined } });

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            Test Cases
          </h1>
          {generatedBy && <GeneratedByLabel generatedBy={generatedBy} />}
        </div>
        {current ? (
          <div className="flex flex-wrap items-end gap-3">
            <VersionSelect
              label="Design run"
              className="w-full sm:w-64"
              versions={(runs.data ?? [])
                .filter((r) => r.version <= current || r.review_status === "discarded")
                .sort((a, b) => b.version - a.version)
                .map((r) => ({ version: r.version, label: runLabel(r, current) }))}
              value={olderVersion ?? current}
              onChange={(v) => go({ version: v === current ? null : v })}
            />
            {canEdit && !readOnly && (
              <>
                <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => openRegen()} disabled={running}>
                  Regenerate…
                </Button>
                <LinkButton href={`/projects/${p.id}/test-cases/new`} variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />}>
                  New test case
                </LinkButton>
              </>
            )}
            <LinkButton href={`/projects/${p.id}/reports/test-case-spec`} variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />}>
              Open report
            </LinkButton>
          </div>
        ) : null}
      </div>
      {current && (
        <p className="text-small text-fg-muted">
          Designed from{" "}
          <Link href={`/projects/${p.id}/requirements?view=review`} className="underline underline-offset-2">
            Requirements v{reqV ?? "?"} (Gate 3{stages.g3?.finished_at ? `, ${fmtDate(stages.g3.finished_at)}` : ""})
          </Link>{" "}
          and{" "}
          <Link href={`/projects/${p.id}/test-strategy?view=review`} className="underline underline-offset-2">
            Strategy v{strategyV ?? "?"} (Gate 4{stages.g4?.finished_at ? `, ${fmtDate(stages.g4.finished_at)}` : ""})
          </Link>
          {generatedBy === "rules" ? " · Generated by rules" : generatedBy === "mixed" || generatedBy === "ai" ? " · AI-assisted" : ""}
        </p>
      )}
    </div>
  );

  // ---- Banners (§5.1, §5.2) ----
  const banners: React.ReactNode[] = [];
  if (olderVersion && current) banners.push(<OlderVersionBanner key="older" what="test cases" n={olderVersion} latest={current} onViewLatest={() => go({ version: null })} />);
  if (!olderVersion && current && design?.status === "stale")
    banners.push(
      <OutOfDateCallout
        key="stale"
        title="Test cases may be out of date"
        actions={
          canEdit ? (
            <Button variant="secondary" onClick={() => openRegen()}>
              Regenerate…
            </Button>
          ) : undefined
        }
      >
        They were designed from Strategy v{strategyV ?? "?"}
        {stages.strategy?.current_version && stages.strategy.current_version !== strategyV
          ? `; Strategy v${stages.strategy.current_version} was approved${stages.g4?.finished_at ? ` on ${fmtDate(stages.g4.finished_at)}` : ""}`
          : ""}
        . Regenerate to update them. Approved, edited and locked cases are kept, and the current cases stay in use until you apply changes.
      </OutOfDateCallout>,
    );
  if (!olderVersion && current && running && !pending)
    banners.push(
      <Callout key="regen" tone="info">
        Regenerating test cases… The current cases stay in use until you apply changes.
      </Callout>,
    );
  if (!olderVersion && pending)
    banners.push(
      <Callout key="pending" tone="info" actions={<LinkButton href={`/projects/${p.id}/test-cases/changes?run=${pending.version}`}>Review changes</LinkButton>}>
        Regenerated test cases are ready to review.
      </Callout>,
    );
  if (!olderVersion && stages.g5 && view !== "review") banners.push(<GateBanner key="g5" stage={stages.g5} reviewHref={`/projects/${p.id}/test-cases?view=review`} />);
  if (!olderVersion && current && oq > 0)
    banners.push(
      <Callout key="oq" tone="warning" actions={<LinkButton href={listHref({ oq: "1" })}>Show open questions</LinkButton>}>
        {oq} test case{oq === 1 ? "" : "s"} can’t be approved yet: {oq === 1 ? "its" : "their"} expected result depends on a question that isn’t answered. Decide each one to continue.
      </Callout>,
    );
  if (!olderVersion && current && generatedBy === "rules")
    banners.push(
      <Callout key="rules" tone="info">
        Designed by rules (AI not configured). Rules cover form fields, sign-in, navigation and journeys. Values come from what discovery found; wording is plain. Review titles and expected results.
      </Callout>,
    );
  if (!olderVersion && current && generatedBy === "mixed" && (output.ai_checks?.length ?? 0) > 0)
    banners.push(
      <Disclosure key="ai" label={`Checks on AI suggestions (${output.ai_checks!.length})`}>
        <div className="mt-2 rounded-md bg-elevated p-3 text-body text-fg">
          <p>{output.ai_checks!.length} AI suggestions were changed or dropped by our checks.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {output.ai_checks!.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </Disclosure>,
    );
  if (!olderVersion && run.data?.partial)
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
        Test design stopped at the limit of 300 cases.
        {output.cap_reached?.requirement_keys?.length
          ? ` ${output.cap_reached.requirement_keys.length} requirement${output.cap_reached.requirement_keys.length === 1 ? " wasn’t" : "s weren’t"} designed: ${output.cap_reached.requirement_keys.join(", ")}.`
          : ""}
      </Callout>,
    );

  function notStarted() {
    if (!design) return <EmptyState title="Test design isn’t available for this project." />;
    if (isWorking(design)) return <RunningCard design={design} reqN={approvedReqs} strategyV={stages.strategy?.current_version ?? null} />;
    if (design.status === "failed")
      return (
        <Card>
          <ErrorState
            error={null}
            title={`Test design failed${design.stale_reason ? `: ${design.stale_reason}` : ""}.`}
            message="Your requirements and strategy are unaffected."
            onRetry={canEdit ? () => void designNow() : undefined}
          />
        </Card>
      );
    if (!g4Approved)
      return (
        <div className="space-y-4">
          {stages.g4 && <GateBanner stage={stages.g4} reviewHref={`/projects/${p.id}/test-strategy?view=review`} />}
          <EmptyState
            title="Test cases are designed from the approved Test Strategy. Approve Gate 4 first."
            action={<LinkButton href={`/projects/${p.id}/test-strategy?view=review`}>Review Gate 4</LinkButton>}
          />
        </div>
      );
    return (
      <EmptyState
        title="The strategy is approved. Design test cases to start."
        description={canEdit ? undefined : "An owner, admin or member can start test design."}
        action={
          canEdit ? (
            <div className="space-y-2">
              <Button onClick={() => void designNow()} loading={starting}>
                Design test cases
              </Button>
              {startError && <p className="text-small text-danger-fg">{startError}</p>}
            </div>
          ) : undefined
        }
      />
    );
  }

  function casesPanel() {
    if (!current) return notStarted();
    if (all.error && !all.data) return <ErrorState error={all.error} title="Couldn’t load test cases." message="Try again." onRetry={() => void all.mutate()} />;
    if (!all.data)
      return (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
          <span className="sr-only" role="status">
            Loading test cases…
          </span>
        </div>
      );
    return (
      <div className="space-y-4">
        {params.get("edit") === "1" && !canEdit && <Callout tone="neutral">You have view-only access. Ask an owner or admin for member access to edit test cases.</Callout>}
        {notDesigned.length > 0 && (
          <Callout tone="info">
            Not designed in Phase 3: {notDesigned.map((n) => caseTypeText(n.test_type)).join(", ")}. They need separate approval and are designed in Phase 5.
          </Callout>
        )}
        <TestCasesTable
          projectId={p.id}
          all={rows}
          filters={filters}
          setFilters={(f, o) => go({ filters: f }, o?.replace ?? false)}
          serverMatches={search.data ?? null}
          readOnly={readOnly}
          canEdit={canEdit}
          g5Approved={g5Approved}
          headerSource={generatedBy}
          reqTitles={reqTitles}
          onChanged={async () => {
            await all.mutate();
            void stats.mutate();
            p.refresh();
          }}
          detailQuery={olderVersion ? { v: String(olderVersion) } : undefined}
        />
      </div>
    );
  }

  const tabs = [
    { id: "cases", label: "Test cases", count: current && all.data ? live.length : undefined },
    { id: "conditions", label: "Conditions", count: conditions.data ? conditions.data.filter((c) => c.status !== "rejected").length : undefined },
    { id: "data", label: "Test data", count: data.data ? data.data.filter((d) => d.status === "active").length : undefined },
    { id: "review", label: "Review · Gate 5" },
  ];

  const conditionItem = conditionKey ? conditions.data?.find((c) => c.key === conditionKey) : null;
  const dataItem = dataKey ? (data.data?.find((d) => d.key === dataKey) ?? null) : null;
  const caseMap = new Map(rows.map((c) => [c.key, c]));

  return (
    <div className="space-y-6">
      {header}
      {banners}
      <div>
        <Tabs tabs={tabs} value={view} onChange={(v) => go({ view: v as View })} label="Test Cases views" idPrefix="tc" />
        <TabPanel id={view} idPrefix="tc">
          {view === "cases" && casesPanel()}
          {view === "conditions" &&
            (current ? (
              <ConditionsTab
                projectId={p.id}
                conditions={conditions.data}
                error={conditions.error}
                cases={rows}
                data={data.data ?? []}
                stats={stats.data}
                canEdit={canEdit && !readOnly}
                onOpenData={(k) => go({ extra: { data: k } })}
                onChanged={() => {
                  void conditions.mutate();
                  void all.mutate();
                  p.refresh();
                }}
                onRegenerate={() => openRegen()}
                listHref={listHref}
              />
            ) : (
              notStarted()
            ))}
          {view === "data" &&
            (current ? (
              <TestDataTab
                projectId={p.id}
                items={data.data}
                error={data.error}
                canEdit={canEdit && !readOnly}
                canManageSecrets={canManageSecrets}
                onChanged={() => {
                  void data.mutate();
                  void all.mutate();
                  p.refresh();
                }}
                onOpen={(k) => go({ extra: { data: k } })}
              />
            ) : (
              notStarted()
            ))}
          {view === "review" &&
            (!current || !stages.g5 ? (
              <EmptyState title={running ? "Gate 5 opens when test design finishes." : "Gate 5 opens when test cases are designed."} />
            ) : running && !pending ? (
              <EmptyState title="Gate 5 opens when test design finishes." />
            ) : !all.data ? (
              <Spinner label="Loading the Gate 5 review…" />
            ) : (
              <Gate5Review
                projectId={p.id}
                stage={stages.g5}
                cases={rows}
                gaps={gaps.data}
                lint={lint.data}
                g4Approved={g4Approved}
                designCurrent={design?.status !== "stale"}
                reqVersion={reqV}
                strategyVersion={strategyV}
                designVersion={current}
                readOnly={readOnly}
                onDecided={() => {
                  p.refresh();
                  void all.mutate();
                }}
                onRegenerateWithFeedback={(c) => openRegen(c)}
              />
            ))}
        </TabPanel>
      </div>
      {running && (
        <AgentActivityFeed
          events={p.events}
          streamState={p.streamState}
          onReconnect={p.reconnect}
          running
          stages={["test_design", "traceability"]}
          announceAll={p.announceAll}
          onAnnounceAll={p.setAnnounceAll}
        />
      )}
      <RegenerateDialog
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        projectId={p.id}
        stage="test_design"
        title={regen.title}
        intro={regen.intro}
        bullets={regen.bullets}
        initialGuidance={guidance}
        onStarted={p.refresh}
        guidanceHint="e.g. “More negative cases for sign-in.”"
        aiOffNote={generatedBy === "rules" ? "AI isn’t set up, so the rules design the cases; guidance is saved but not used." : null}
        pendingReviewHref={pending ? `/projects/${p.id}/test-cases/changes?run=${pending.version}` : `/projects/${p.id}/test-cases/changes`}
        pendingReview={!!pending}
      />
      <Drawer open={!!conditionKey && !!conditionItem} onClose={closeDrawer} title={conditionItem ? `${conditionItem.key} · ${conditionItem.title}` : "Condition"} wide>
        {conditionItem && (
          <ConditionDrawerBody
            c={conditionItem}
            cases={caseMap}
            data={data.data ?? []}
            projectId={p.id}
            canEdit={canEdit && !readOnly}
            onOpenData={(k) => go({ extra: { condition: undefined, data: k } })}
            onChanged={() => void conditions.mutate()}
          />
        )}
      </Drawer>
      <TestDataDrawer projectId={p.id} item={dataItem} onClose={closeDrawer} />
    </div>
  );
}

export default function TestCasesPage() {
  return (
    <Suspense>
      <TestCases />
    </Suspense>
  );
}
