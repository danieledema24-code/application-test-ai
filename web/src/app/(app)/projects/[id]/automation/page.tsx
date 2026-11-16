"use client";

// Automation workspace (design P4 §6): Overview | Scripts | Review · Gate 6 | Repairs (design P6 §8.1), with the §6.5 states.

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, buildQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { automationPhase, g6StatusText, type AutomationAssessment, type AutomationOverview } from "@/lib/automation";
import { Button, Callout, ConfirmDialog, EmptyState, ErrorState, LinkButton, Skeleton, TabPanel, Tabs, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { OlderVersionBanner, VersionSelect } from "@/components/domain/VersionSelect";
import { OutOfDateCallout } from "@/components/domain/OutOfDateCallout";
import { useProject } from "@/components/workspace/ProjectContext";
import { hostOf } from "@/lib/url";
import { AssessAction, ExportCard, NotAutomatedCard, SuitabilitySummary, ValidationSummary } from "@/components/automation/Overview";
import { AssetViewer, FileList, ScriptViewer } from "@/components/automation/Scripts";
import { Gate6Review } from "@/components/automation/Gate6Review";
import { RepairList, useRepairs } from "@/components/automation/Repairs";
import { REPAIR_LINE, tabLabel } from "@/lib/repairs";

const VIEWS = ["overview", "scripts", "review", "repairs"] as const;
type View = (typeof VIEWS)[number];

function AutomationScreen() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const { role } = useAuth();
  const toast = useToast();
  const viewer = role === "viewer" || role === null;
  const requested = params.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "overview";
  const file = params.get("file");
  const bundleParam = params.get("bundle");
  const version = bundleParam ? Number(bundleParam) : null;
  const stages = p.workflow?.stages;
  const busyStage = stages?.some((s) => (s.key === "automation" || s.key === "automation_assessment") && (s.status === "queued" || s.status === "running"));
  const [validating, setValidating] = useState(false);
  const repairs = useRepairs(p.id, { status: "all" });
  const overview = useApi<AutomationOverview>(`/projects/${p.id}/automation`, version ? { version } : undefined, {
    refreshInterval: (d) => (busyStage || validating || d?.bundle?.validation.status === "running" ? 2000 : 0),
  });
  const assessment = useApi<AutomationAssessment>(`/projects/${p.id}/automation/assessment`, undefined, { refreshInterval: busyStage ? 2000 : 0 });
  const [confirm, setConfirm] = useState(false);
  const [starting, setStarting] = useState(false);
  const o = overview.data;
  const phase = automationPhase(stages, o);
  const canEdit = !!o?.permissions.can_edit && !viewer;
  const host = hostOf(p.project?.primary_url) || "site";

  useEffect(() => {
    document.title = `Automation · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  useEffect(() => {
    if (validating && o?.bundle?.validation.status && o.bundle.validation.status !== "running") setValidating(false);
  }, [validating, o?.bundle?.validation.status]);
  const prevBusy = useRef(false);
  const { mutate: reloadOverview } = overview;
  const { mutate: reloadAssessment } = assessment;
  useEffect(() => {
    // When the agent finishes, reload what it wrote.
    if (prevBusy.current && !busyStage) {
      void reloadOverview();
      void reloadAssessment();
    }
    prevBusy.current = !!busyStage;
  }, [busyStage, reloadOverview, reloadAssessment]);

  function go(next: { view?: View; file?: string | null; bundle?: number | null }) {
    const v = next.view ?? view;
    const q = buildQuery({
      view: v === "overview" ? undefined : v,
      file: next.file === undefined ? (v === "scripts" ? (file ?? undefined) : undefined) : (next.file ?? undefined),
      bundle: next.bundle === undefined ? (bundleParam ?? undefined) : (next.bundle ?? undefined),
    });
    router.push(`/projects/${p.id}/automation${q}`, { scroll: false });
  }
  const scriptsHref = (f: string) => `/projects/${p.id}/automation${buildQuery({ view: "scripts", file: f, bundle: bundleParam ?? undefined })}`;

  async function runStage(key: "automation_assessment" | "automation") {
    setStarting(true);
    try {
      await api(`/projects/${p.id}/stages/${key}/run`, { method: "POST", body: {} });
      p.refresh();
      setConfirm(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t start. Try again.", "error");
    } finally {
      setStarting(false);
    }
  }
  async function validate() {
    try {
      await api(`/projects/${p.id}/automation/validate`, { method: "POST", query: version ? { version } : undefined });
      setValidating(true);
      toast("Validation started.", "success");
      void overview.mutate();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t start validation. Try again.", "error");
    }
  }

  const b = o?.bundle;
  const latest = o?.versions[0]?.version ?? null;
  const toolkitMissing = !!o?.toolkit_problem;
  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          Automation
        </h1>
        {b && (
          <div className="flex flex-wrap items-end gap-3">
            <VersionSelect
              label="Scripts"
              className="w-56"
              value={b.version}
              versions={(o?.versions ?? []).map((v) => ({ version: v.version, label: `v${v.version} · ${fmtDateTime(v.finished_at ?? v.created_at)}` }))}
              onChange={(n) => go({ bundle: n === latest ? null : n })}
            />
            {canEdit && (
              <>
                <Button variant="secondary" onClick={() => void validate()} aria-disabled={toolkitMissing || undefined} disabled={validating || b.validation.status === "running"}>
                  Validate again
                </Button>
                {b.is_current && (
                  <Button variant="secondary" onClick={() => setConfirm(true)}>
                    Regenerate scripts…
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {b && (
        <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
          <span>
            Written from the test cases approved at Gate 5{o?.g5.decided_at ? ` on ${fmtDate(o.g5.decided_at)}` : ""}
            {o?.g5.design_version ? ` (design run ${o.g5.design_version})` : ""} ·
          </span>
          <GeneratedByLabel generatedBy={b.generated_by} />
        </p>
      )}
    </div>
  );

  if (overview.error && !o)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={overview.error} title="Couldn’t load automation." message="Try again." onRetry={() => void overview.mutate()} />
      </div>
    );
  if (!o)
    return (
      <div className="space-y-6" aria-busy="true">
        {header}
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );

  if (phase === "g5_missing")
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="Scripts are written from the test cases approved at Gate 5. Approve Gate 5 first."
          action={<LinkButton href={`/projects/${p.id}/test-cases?view=review`}>Review Gate 5</LinkButton>}
        />
      </div>
    );
  if (phase === "not_assessed")
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title="Test cases are approved. Check which ones can be automated." action={<AssessAction canEdit={canEdit} busy={starting} onAssess={() => void runStage("automation_assessment")} />} />
      </div>
    );
  if (phase === "assessing" || phase === "writing")
    return (
      <div className="space-y-6">
        {header}
        <Callout tone="info" role="status" title={phase === "assessing" ? "Checking which approved test cases can be automated…" : `Writing scripts${assessment.data ? ` for ${assessment.data.counts.suitable + assessment.data.counts.partial} test cases` : ""}…`}>
          This page updates by itself when the Test Automation Engineer Agent finishes.
        </Callout>
      </div>
    );
  if (phase === "failed" && !b)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={null}
          title="Writing scripts failed. Your test cases are unaffected."
          onRetry={canEdit ? () => void runStage("automation_assessment") : undefined}
        />
      </div>
    );

  const g6 = o.g6;
  const scripts = b?.scripts ?? [];
  const selectedScript = file ? scripts.find((s) => s.path === file) : undefined;
  const selectedAsset = file && !selectedScript ? b?.assets.find((a) => a.path === file) : undefined;
  const stale = stages?.find((s) => s.key === "automation")?.status === "stale";
  return (
    <div className="space-y-6">
      {header}
      {b && !b.is_current && latest !== null && <OlderVersionBanner what="scripts" n={b.version} latest={latest} onViewLatest={() => go({ bundle: null })} />}
      {toolkitMissing && (
        <Callout tone="danger" title="Scripts can't be checked or run on this server">
          The testing toolkit isn&apos;t installed ({o.toolkit_problem}). Ask whoever runs this server to follow the setup in automation/README.
        </Callout>
      )}
      {stale && (
        <OutOfDateCallout
          title="Some scripts are out of date"
          actions={
            canEdit ? (
              <Button variant="secondary" onClick={() => setConfirm(true)}>
                Regenerate scripts…
              </Button>
            ) : undefined
          }
        >
          The approved test cases changed{o.g5.decided_at ? ` on ${fmtDate(o.g5.decided_at)}` : ""}. Outdated scripts can&apos;t run. Regenerate to update them; unchanged scripts stay valid.
        </OutOfDateCallout>
      )}
      {g6.state === "waiting" && (
        <Callout tone="warning" title={`Gate 6: Script validation · ${g6StatusText("waiting", o.permissions.can_approve)}`} actions={<LinkButton href={`/projects/${p.id}/automation?view=review`}>Review Gate 6</LinkButton>}>
          Tests can&apos;t run until the items under “Must fix before tests can run” are done.
        </Callout>
      )}
      {(validating || b?.validation.status === "running") && (
        <Callout tone="info" role="status" title={`Checking ${scripts.filter((s) => s.status !== "outdated").length} scripts.`}>
          The live-page check opens each page and looks for fields and buttons; it doesn&apos;t click, type or submit.
        </Callout>
      )}
      {b && b.generated_by === "rules" && (
        <Callout tone="neutral">Scripts written by rules (AI not configured). Rules cover forms, sign-in, navigation and page checks. Steps needing judgement are left for a person.</Callout>
      )}
      {b && scripts.length === 0 && assessment.data && (
        <EmptyState title={`None of the ${assessment.data.counts.total} approved test cases can be automated yet.`} description="The reasons are listed below." />
      )}
      <div>
        <Tabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "scripts", label: `Scripts (${scripts.filter((s) => s.status !== "outdated").length})` },
            { id: "review", label: "Review · Gate 6" },
            { id: "repairs", label: tabLabel(repairs.data?.counts.open) },
          ]}
          value={view}
          onChange={(v) => go({ view: v as View, file: v === "scripts" ? file : null })}
          label="Automation views"
          idPrefix="auto"
        />
        <TabPanel id={view} idPrefix="auto">
          {view === "overview" && (
            <div className="space-y-4">
              {assessment.data ? <SuitabilitySummary assessment={assessment.data} projectId={p.id} canEdit={canEdit} /> : <Skeleton className="h-40" />}
              <ValidationSummary overview={o} scriptsHref={scriptsHref} />
              <NotAutomatedCard overview={o} projectId={p.id} />
              <ExportCard overview={o} projectId={p.id} host={host} canEdit={canEdit} />
            </div>
          )}
          {view === "scripts" && b && (
            <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <div className="min-w-0">
                <FileList overview={o} file={file} href={scriptsHref} />
              </div>
              <div className="min-w-0">
                {selectedScript ? (
                  <ScriptViewer key={selectedScript.id} id={selectedScript.id} projectId={p.id} />
                ) : selectedAsset ? (
                  <AssetViewer key={selectedAsset.id} id={selectedAsset.id} />
                ) : (
                  <EmptyState title="Choose a file to see its code and checks." />
                )}
              </div>
            </div>
          )}
          {view === "repairs" && (
            <section aria-labelledby="repairs-title" className="space-y-4">
              <h2 id="repairs-title" className="text-h2 font-semibold text-fg-strong">
                Repair suggestions
              </h2>
              <p className="text-body text-fg">{REPAIR_LINE} A person accepts each suggestion; nothing is applied automatically.</p>
              <RepairList
                projectId={p.id}
                filters
                focusKey={params.get("heal")}
                onChanged={() => {
                  void repairs.mutate();
                  void overview.mutate();
                  p.refresh();
                }}
              />
            </section>
          )}
          {view === "review" && (
            <Gate6Review
              overview={o}
              viewer={viewer}
              onChanged={() => {
                void overview.mutate();
                p.refresh();
              }}
            />
          )}
        </TabPanel>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => void runStage("automation")} title="Regenerate scripts" confirmLabel="Regenerate scripts" loading={starting}>
        Write the scripts again from the approved test cases? Scripts whose test case hasn&apos;t changed keep their version and checks. Changed ones get a new version and must pass checks again.
      </ConfirmDialog>
    </div>
  );
}

export default function AutomationPage() {
  return (
    <Suspense>
      <AutomationScreen />
    </Suspense>
  );
}
