"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, RefreshCw } from "lucide-react";
import { api, ApiError, buildQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { RiskMatrix, StrategyVersion, TestPlan, TestPlanVersion, TestStrategy, TestType } from "@/lib/contract";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { gate4Checks } from "@/lib/strategy";
import { Button, Callout, Card, CardBody, EmptyState, ErrorState, LinkButton, Skeleton, Spinner, TabPanel, Tabs, useToast } from "@/components/ui";
import { AgentActivityFeed } from "@/components/domain/AgentActivityFeed";
import { GateBanner, GateReviewPanel } from "@/components/domain/GateReviewPanel";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { OutOfDateCallout } from "@/components/domain/OutOfDateCallout";
import { OlderVersionBanner, VersionSelect } from "@/components/domain/VersionSelect";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, isWorking, requirementsStages, useAllRisks } from "@/components/requirements/hooks";
import { RegenerateDialog } from "@/components/requirements/RegenerateDialog";
import { StrategyDocument } from "@/components/strategy/StrategyDocument";
import { RiskRegister } from "@/components/strategy/Risks";
import { TestPlanDocument } from "@/components/strategy/TestPlan";

const VIEWS = ["strategy", "risks", "plan", "review"] as const;
type View = (typeof VIEWS)[number];
const ASSESSMENT: Record<string, string> = { proceed: "Ready", proceed_with_caution: "Ready with gaps", do_not_proceed: "Not ready" };

function TestStrategyWorkspace() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const canEdit = role !== "viewer";
  const requested = params.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "strategy";
  const stages = requirementsStages(p.workflow);
  const st = stages.strategy;
  const current = st?.current_version ?? null;
  const vParam = Number(params.get("version") ?? "");
  const pvParam = Number(params.get("plan_version") ?? "");
  const versions = useApi<StrategyVersion[]>(current ? `/projects/${p.id}/test-strategy/versions` : null, undefined, { shouldRetryOnError: false });
  const latestStrategy = versions.data?.length ? Math.max(...versions.data.map((v) => v.version)) : null;
  const olderVersion = latestStrategy && Number.isInteger(vParam) && vParam > 0 && vParam !== latestStrategy ? vParam : null;
  const strategy = useApi<TestStrategy>(current ? `/projects/${p.id}/test-strategy` : null, { version: olderVersion ?? undefined }, { shouldRetryOnError: false });
  const risks = useAllRisks(p.id, !!current);
  const matrix = useApi<RiskMatrix>(current ? `/projects/${p.id}/risks/matrix` : null, undefined, { shouldRetryOnError: false });
  const g4Approved = gateApproved(stages.g4);
  // The version list answers 200 [] before the plan exists, so it is polled instead of probing the plan (a 404).
  const planVersions = useApi<TestPlanVersion[]>(g4Approved || current ? `/projects/${p.id}/test-plan/versions` : null, undefined, {
    shouldRetryOnError: false,
    refreshInterval: (d) => (g4Approved && !d?.length ? 5000 : 0),
  });
  const planExists = !!planVersions.data?.length;
  const latestPlan = planVersions.data?.length ? Math.max(...planVersions.data.map((v) => v.version)) : null;
  const planVersion = latestPlan && Number.isInteger(pvParam) && pvParam > 0 && pvParam !== latestPlan ? pvParam : null;
  const plan = useApi<TestPlan>(planExists ? `/projects/${p.id}/test-plan` : null, { version: planVersion ?? undefined }, { shouldRetryOnError: false });
  const [regenOpen, setRegenOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    document.title = `Test Strategy · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  const stStatus = st?.status;
  useEffect(() => {
    if (!current) return;
    void strategy.mutate();
    void versions.mutate();
    void risks.mutate();
    void matrix.mutate();
    void plan.mutate();
    void planVersions.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on stage transitions
  }, [current, stStatus, g4Approved, st?.pending_review?.version]);

  function go(next: { view?: View; version?: number | null; plan_version?: number | null }) {
    const v = next.view ?? view;
    router.replace(
      `/projects/${p.id}/test-strategy${buildQuery({
        view: v === "strategy" ? undefined : v,
        version: next.version === undefined ? (olderVersion ?? undefined) : (next.version ?? undefined),
        plan_version: next.plan_version === undefined ? (planVersion ?? undefined) : (next.plan_version ?? undefined),
      })}`,
      { scroll: false },
    );
  }
  async function generate() {
    setStarting(true);
    try {
      await api(`/projects/${p.id}/stages/test_strategy/run`, { body: { reason: "start", parameters: {} } });
      p.refresh();
    } catch (err) {
      toast(`Couldn’t start the Test Strategy. ${err instanceof Error ? err.message : ""}`.trim(), "error");
    } finally {
      setStarting(false);
    }
  }
  const openRegen = (g = "") => {
    setGuidance(g);
    setRegenOpen(true);
  };

  const s = strategy.data;
  const readOnly = !!olderVersion || !canEdit;
  const running = isWorking(st);
  const pending = st?.pending_review ?? null;
  const reqVersion = stages.req?.current_version ?? null;
  const g3Approved = gateApproved(stages.g3);
  const inScopeTypes = (s?.sections.test_types ?? []).filter((t) => t.in_scope).map((t) => t.type as TestType);

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            Test Strategy
          </h1>
          {s && <GeneratedByLabel generatedBy={s.generated_by} />}
        </div>
        {current && (
          <div className="flex flex-wrap items-end gap-3">
            <VersionSelect
              versions={(versions.data ?? [])
                .slice()
                .sort((a, b) => b.version - a.version)
                .map((v) => ({ version: v.version, label: [`${v.version}`, fmtDateTime(v.created_at), v.approved ? "approved" : v.status, v.generated_by === "rules" ? "rules" : null].filter(Boolean).join(" · ") }))}
              value={olderVersion ?? latestStrategy}
              onChange={(v) => go({ version: v === latestStrategy ? null : v })}
            />
            {canEdit && (
              <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => openRegen()} disabled={running || !!pending}>
                Regenerate…
              </Button>
            )}
            <LinkButton href={`/projects/${p.id}/reports/test-strategy`} variant="secondary" icon={<FileText className="h-4 w-4" aria-hidden />}>
              Open report
            </LinkButton>
          </div>
        )}
      </div>
      {s?.approved_input?.requirements_version && (
        <p className="text-small text-fg-muted">
          Based on{" "}
          <Link href={`/projects/${p.id}/requirements?version=${s.approved_input.requirements_version}`} className="text-navy-700 underline underline-offset-2">
            Requirements version {s.approved_input.requirements_version}
          </Link>
          {g3Approved && stages.g3?.finished_at ? ` (Gate 3 approved ${fmtDate(stages.g3.finished_at)})` : ""}
        </p>
      )}
    </div>
  );

  // ---- Not started (design §8.5) ----
  function notStarted() {
    if (!st) return <EmptyState title="The Test Strategy isn’t available for this project." />;
    if (st.status === "paused")
      return (
        <Callout tone="warning" actions={<Button onClick={() => void p.resume()}>Resume analysis</Button>}>
          Test Strategy generation is paused.
        </Callout>
      );
    if (running)
      return (
        <Card>
          <CardBody>
            <Spinner label="The Test Strategy Agent is writing a risk-based strategy from the approved requirements." />
            {st.progress?.label && <p className="mt-2 text-small text-fg-muted">{st.progress.label}</p>}
          </CardBody>
        </Card>
      );
    if (st.status === "failed")
      return (
        <Card>
          <ErrorState error={null} title={`Strategy generation failed${st.stale_reason ? `: ${st.stale_reason}` : ""}.`} message="Your requirements are unaffected." onRetry={canEdit ? () => void generate() : undefined} />
        </Card>
      );
    if (!g3Approved)
      return (
        <div className="space-y-4">
          {stages.g3 && <GateBanner stage={stages.g3} reviewHref={`/projects/${p.id}/requirements?view=review`} />}
          <EmptyState
            title="The Test Strategy is written from approved requirements. Approve Gate 3 first."
            action={<LinkButton href={`/projects/${p.id}/requirements?view=review`}>Review Gate 3</LinkButton>}
          />
        </div>
      );
    return (
      <EmptyState
        title="The Test Strategy hasn’t been written yet."
        action={
          canEdit ? (
            <Button onClick={() => void generate()} loading={starting}>
              Write the Test Strategy
            </Button>
          ) : undefined
        }
      />
    );
  }

  const banners: React.ReactNode[] = [];
  if (olderVersion && latestStrategy) banners.push(<OlderVersionBanner key="older" what="the Test Strategy" n={olderVersion} latest={latestStrategy} onViewLatest={() => go({ version: null })} />);
  if (!olderVersion && current && (st?.status === "stale" || s?.status === "stale"))
    banners.push(
      <OutOfDateCallout
        key="stale"
        title="The Test Strategy may be out of date"
        actions={
          canEdit ? (
            <Button variant="secondary" onClick={() => openRegen()}>
              Regenerate…
            </Button>
          ) : undefined
        }
      >
        This strategy is based on Requirements version {s?.approved_input?.requirements_version ?? "—"}.{reqVersion ? ` Version ${reqVersion} is the latest.` : ""} Regenerate to update it; edited sections and risks are kept.
      </OutOfDateCallout>,
    );
  if (!olderVersion && current && running && !pending)
    banners.push(
      <Callout key="regen" tone="info">
        Regenerating the Test Strategy… The current version stays in use until you apply changes.
      </Callout>,
    );
  if (!olderVersion && pending)
    banners.push(
      <Callout key="pending" tone="info" actions={<LinkButton href={`/projects/${p.id}/test-strategy/changes?run=${pending.version}`}>Review changes</LinkButton>}>
        The regenerated Test Strategy is ready to review.
      </Callout>,
    );
  if (!olderVersion && s?.generated_by === "rules")
    banners.push(
      <Callout key="rules" tone="info">
        Generated by rules (AI not configured). Scope and test types follow the requirement categories; rationales are brief. Review each section.
      </Callout>,
    );
  if (!olderVersion && stages.g4 && view !== "review") banners.push(<GateBanner key="g4" stage={stages.g4} reviewHref={`/projects/${p.id}/test-strategy?view=review`} />);

  function loadingOr(error: unknown, retry: () => void, el: React.ReactNode, ready: boolean) {
    if (error && !ready) return <ErrorState error={error} title="Couldn’t load the test strategy." message="Try again." onRetry={retry} />;
    if (!ready)
      return (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <span className="sr-only" role="status">
            Loading the test strategy…
          </span>
        </div>
      );
    return el;
  }

  function planPanel() {
    if (!g4Approved && !plan.data)
      return (
        <EmptyState
          title="The Test Plan is written from the approved Test Strategy. Approve Gate 4 first."
          action={<LinkButton href={`/projects/${p.id}/test-strategy?view=review`}>Review Gate 4</LinkButton>}
        />
      );
    if ((planVersions.data && !planExists) || (plan.error instanceof ApiError && plan.error.status === 404 && !plan.data))
      return (
        <Card>
          <CardBody>
            <Spinner label={`Writing the Test Plan from Strategy version ${latestStrategy ?? ""}…`} />
          </CardBody>
        </Card>
      );
    return loadingOr(
      plan.error,
      () => void plan.mutate(),
      plan.data && (
        <div className="space-y-4">
          {s?.plan_status === "out_of_date" && !planVersion && (
            <OutOfDateCallout title="The Test Plan may be out of date">
              This plan was written from Strategy version {plan.data.strategy_version}. Version {latestStrategy} is the latest approved strategy.
            </OutOfDateCallout>
          )}
          <TestPlanDocument
            key={plan.data.version}
            projectId={p.id}
            plan={plan.data}
            versions={(planVersions.data ?? []).slice().sort((a, b) => b.version - a.version)}
            latest={latestPlan ?? plan.data.version}
            readOnly={!!planVersion || !canEdit}
            onSaved={() => {
              void plan.mutate();
              void planVersions.mutate();
            }}
            onSelectVersion={(v) => go({ plan_version: v === latestPlan ? null : v })}
          />
        </div>
      ),
      !!plan.data,
    );
  }

  const tabs = [
    { id: "strategy", label: "Strategy" },
    { id: "risks", label: "Risk register", count: risks.data?.length },
    { id: "plan", label: "Test Plan" },
    { id: "review", label: "Review · Gate 4" },
  ];

  return (
    <div className="space-y-6">
      {header}
      {banners}
      <div>
        <Tabs tabs={tabs} value={view} onChange={(v) => go({ view: v as View })} label="Test Strategy views" idPrefix="strat" />
        <TabPanel id={view} idPrefix="strat">
          {!current && view !== "plan"
            ? notStarted()
            : view === "strategy"
              ? loadingOr(strategy.error, () => void strategy.mutate(), s && <StrategyDocument key={s.version} projectId={p.id} strategy={s} readOnly={readOnly} onSaved={() => (void strategy.mutate(), void versions.mutate(), p.refresh())} />, !!s)
              : view === "risks"
                ? loadingOr(
                    risks.error,
                    () => void risks.mutate(),
                    <RiskRegister
                      projectId={p.id}
                      risks={risks.data ?? []}
                      matrix={matrix.data}
                      inScopeTypes={inScopeTypes}
                      generatedBy={s?.generated_by ?? null}
                      readOnly={readOnly}
                      onChanged={() => {
                        void risks.mutate();
                        void matrix.mutate();
                        p.refresh();
                      }}
                    />,
                    !!risks.data,
                  )
                : view === "plan"
                  ? planPanel()
                  : stages.g4 && s && risks.data
                    ? (
                        <GateReviewPanel
                          projectId={p.id}
                          stage={stages.g4}
                          title="Gate 4 · Test Strategy review"
                          assessment={stages.g4.gate?.recommendation ? ASSESSMENT[stages.g4.gate.recommendation.recommend] : null}
                          checks={gate4Checks(s, risks.data, { requirementsVersion: reqVersion, g3Reopened: !g3Approved })}
                          recommendation={
                            stages.g4.gate?.recommendation?.reasons.length
                              ? { text: stages.g4.gate.recommendation.reasons[0], generatedBy: stages.g4.gate.recommendation.generated_by, reasons: stages.g4.gate.recommendation.reasons.slice(1) }
                              : null
                          }
                          approveLabel="Approve test strategy"
                          approvedToast="Test Strategy approved."
                          afterApproveCopy={
                            <>
                              Strategy approved. The Test Plan is being written from it.{" "}
                              <Link href={`/projects/${p.id}/test-strategy?view=plan`} className="font-medium text-navy-700 underline underline-offset-2">
                                Go to Test Plan
                              </Link>
                            </>
                          }
                          afterRequestChanges={(c) =>
                            canEdit ? (
                              <Button variant="secondary" onClick={() => openRegen(c)}>
                                Regenerate with this feedback
                              </Button>
                            ) : null
                          }
                          reportHref={`/projects/${p.id}/reports/test-strategy`}
                          reportLabel="View Test Strategy report"
                          readOnly={!!olderVersion}
                          onDecided={p.refresh}
                        />
                      )
                    : loadingOr(strategy.error ?? risks.error, () => (void strategy.mutate(), void risks.mutate()), null, false)}
        </TabPanel>
      </div>
      {running && (
        <AgentActivityFeed events={p.events} streamState={p.streamState} onReconnect={p.reconnect} running stages={["test_strategy"]} announceAll={p.announceAll} onAnnounceAll={p.setAnnounceAll} />
      )}
      <RegenerateDialog
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        projectId={p.id}
        stage="test_strategy"
        title="Regenerate the Test Strategy?"
        intro={`The Test Strategy Agent will write the strategy again from the approved requirements${s?.approved_input?.requirements_version ? ` (version ${s.approved_input.requirements_version})` : ""}.`}
        bullets={[
          `${s?.human_edited_sections.length ?? 0} edited section${s?.human_edited_sections.length === 1 ? " is" : "s are"} kept. Any changes the agent suggests for them are shown as proposals.`,
          "Edited risks are kept the same way.",
          "Nothing changes until you review and apply the results.",
        ]}
        initialGuidance={guidance}
        onStarted={p.refresh}
      />
    </div>
  );
}

export default function TestStrategyPage() {
  return (
    <Suspense>
      <TestStrategyWorkspace />
    </Suspense>
  );
}
