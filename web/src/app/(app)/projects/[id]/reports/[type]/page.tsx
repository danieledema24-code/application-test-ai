"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { notFound, useParams, useRouter, useSearchParams } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { api, ApiError, downloadFile } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ReportDetail, ReportSummary } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { approvedBand, downloadFailedText, downloadFormats, draftBand, isPhase3Report, phase2ReportFileName, preparingText, reportBySlug, type DownloadFormat } from "@/lib/reports";
import { hostOf } from "@/lib/url";
import { Button, Callout, EmptyState, ErrorState, LinkButton, LoadingBlock, SelectField, StatusPill, useToast } from "@/components/ui";
import { Phase2ReportBody } from "@/components/report/Phase2Report";
import { Phase3ReportBody } from "@/components/report/Phase3Report";
import { useAuth } from "@/lib/auth";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, requirementsStages } from "@/components/requirements/hooks";

type Format = DownloadFormat;

/** Requirements Specification, Test Strategy, Test Plan (design P2 §10.2–10.3), Test Case Specification and RTM (P3 §15.2). */
function Report() {
  const p = useProject();
  const toast = useToast();
  const router = useRouter();
  const { type: slug } = useParams<{ type: string }>();
  const def = reportBySlug(slug);
  const params = useSearchParams();
  const wantVersion = Number(params.get("version") ?? "");
  const reports = useApi<ReportSummary[]>(`/projects/${p.id}/reports`, undefined, {
    refreshInterval: (d) => (d?.some((r) => r.status === "rendering") ? 3000 : 0),
  });
  const list = useMemo(() => (reports.data ?? []).filter((r) => r.report_type === def?.type).sort((a, b) => b.version - a.version), [reports.data, def?.type]);
  const chosen = (Number.isInteger(wantVersion) && wantVersion > 0 ? list.find((r) => r.version === wantVersion) : null) ?? list.find((r) => r.status === "ready") ?? list[0];
  const detail = useApi<ReportDetail>(chosen && chosen.status === "ready" ? `/reports/${chosen.id}` : null);
  const [downloading, setDownloading] = useState<Format | null>(null);
  const [creating, setCreating] = useState(false);
  const [announce, setAnnounce] = useState("");
  const stages = requirementsStages(p.workflow);
  const { role } = useAuth();

  useEffect(() => {
    if (def) document.title = `${def.name} · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [def, p.project?.name]);
  if (!def) notFound();

  async function download(format: Format) {
    if (!chosen || !def) return;
    setDownloading(format);
    setAnnounce(preparingText(format));
    try {
      await downloadFile(`/reports/${chosen.id}/download?format=${format}`, phase2ReportFileName(hostOf(p.project?.primary_url) || "site", def.type, chosen.version, new Date(), format));
      setAnnounce("Report downloaded.");
      toast("Report downloaded.");
    } catch (err) {
      setAnnounce("");
      toast(err instanceof ApiError && err.status === 409 ? "The report is still being prepared. Try again in a moment." : downloadFailedText(format), "error");
    } finally {
      setDownloading(null);
    }
  }

  async function createDraft() {
    if (!def) return;
    setCreating(true);
    try {
      const r = await api<ReportSummary>(`/projects/${p.id}/reports`, { body: { report_type: def.type } });
      toast("Creating a draft from the current version. It appears here when it’s ready.", "info");
      await reports.mutate();
      router.replace(`/projects/${p.id}/reports/${def.slug}?version=${r.version}`);
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? err.message || "Generate the source first." : "Couldn’t create the draft. Try again.", "error");
    } finally {
      setCreating(false);
    }
  }

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        {def.name}
      </h1>
      {list.length > 0 && (
        <SelectField
          label="Version"
          value={String(chosen?.version ?? "")}
          onChange={(e) => router.replace(`/projects/${p.id}/reports/${def.slug}?version=${e.target.value}`)}
          options={list.map((r) => ({ value: String(r.version), label: `Version ${r.version} · ${fmtDateTime(r.created_at)} · ${r.approval?.status === "approved" ? "Approved" : "Draft"}` }))}
          wrapClassName="w-full sm:w-80"
        />
      )}
    </div>
  );

  const notAvailable =
    def.type === "test_plan" && !gateApproved(stages.g4)
      ? "The Test Plan report is available after Gate 4 is approved."
      : def.type === "test_strategy" && !stages.strategy?.current_version
        ? "The Test Strategy report is available once the strategy is written."
        : def.type === "requirements_spec" && !stages.req?.current_version
          ? "The Requirements Specification is available once requirements are generated."
          : isPhase3Report(def.type) && !stages.design?.current_version
            ? def.type === "rtm"
              ? "The Requirements Traceability Matrix is available after test cases are designed."
              : "The Test Case Specification is available after test cases are designed."
            : null;

  let body: React.ReactNode;
  if (reports.error && !reports.data) body = <ErrorState error={reports.error} title="Couldn’t load the report." message="Try again." onRetry={() => void reports.mutate()} />;
  else if (!reports.data) body = <LoadingBlock label="Loading report…" />;
  else if (!chosen)
    body = (
      <EmptyState
        title={notAvailable ?? "No version of this report exists yet."}
        action={
          notAvailable || role === "viewer" ? undefined : (
            <Button onClick={() => void createDraft()} loading={creating}>
              Create draft from current
            </Button>
          )
        }
      />
    );
  else if (chosen.status === "rendering") body = <LoadingBlock label="Preparing the report…" />;
  else if (chosen.status === "failed") body = <ErrorState error={null} title="Couldn’t create the report." message={chosen.error || "Create a new draft to try again."} />;
  else if (detail.error && !detail.data) body = <ErrorState error={detail.error} title="Couldn’t load the report." message="Try again." onRetry={() => void detail.mutate()} />;
  else if (!detail.data) body = <LoadingBlock label="Loading report…" />;
  else {
    const approved = chosen.approval?.status === "approved";
    const phase3 = isPhase3Report(def.type);
    const planVersion = (detail.data.content as unknown as { strategy_version?: number } | null)?.strategy_version;
    body = (
      <div className="space-y-4">
        <span role="status" className="sr-only">
          {announce}
        </span>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex flex-wrap items-center gap-2 text-body text-fg">
            {approved && phase3 ? (
              <StatusPill status="approved" label={approvedBand(chosen.approval?.gate ?? "G5", chosen.approval?.approved_by?.full_name, chosen.approval?.approved_at ? fmtDateTime(chosen.approval.approved_at) : "")} />
            ) : approved ? (
              <StatusPill status="approved" label={`Approved${chosen.approval?.approved_by?.full_name ? ` by ${chosen.approval.approved_by.full_name}` : ""}${chosen.approval?.approved_at ? ` · ${fmtDateTime(chosen.approval.approved_at)}` : ""}`} />
            ) : (
              <span className="rounded-md bg-warning-bg px-2 py-0.5 text-small font-semibold text-warning-fg ring-1 ring-inset ring-warning-line">{draftBand(def.type, chosen.version, planVersion)}</span>
            )}
            <span className="text-small text-fg-muted">Version {chosen.version} · created {fmtDateTime(chosen.created_at)}</span>
          </p>
          <div className="no-print flex flex-wrap gap-2">
            <Button onClick={() => void download("pdf")} loading={downloading === "pdf"} icon={<Download className="h-4 w-4" aria-hidden />}>
              {downloading === "pdf" ? "Preparing PDF…" : "Download PDF"}
            </Button>
            <Button variant="secondary" onClick={() => void download("html")} loading={downloading === "html"}>
              {downloading === "html" ? "Preparing HTML…" : "Download HTML"}
            </Button>
            {downloadFormats(def.type).includes("csv") && (
              <Button variant="secondary" onClick={() => void download("csv")} loading={downloading === "csv"}>
                {downloading === "csv" ? "Preparing CSV…" : "Download CSV"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => window.print()} icon={<Printer className="h-4 w-4" aria-hidden />}>
              Print
            </Button>
          </div>
        </div>
        {chosen.is_latest_source === false && (
          <Callout
            tone="info"
            actions={
              role === "viewer" ? undefined : (
                <Button variant="secondary" onClick={() => void createDraft()} loading={creating}>
                  Create draft from current
                </Button>
              )
            }
          >
            {phase3
              ? `This report reflects design run ${chosen.stage_run_version ?? "?"}. The current run is ${stages.design?.current_version ?? "?"}.`
              : `This report reflects ${def.source} version ${chosen.stage_run_version ?? chosen.version}. The current version has changed since.`}
          </Callout>
        )}
        {phase3 ? (
          <Phase3ReportBody type={def.type as "test_case_spec" | "rtm"} report={chosen} content={detail.data.content} projectId={p.id} />
        ) : (
          <Phase2ReportBody type={def.type} report={chosen} content={detail.data.content} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {body}
      <LinkButton href={`/projects/${p.id}/reports`} variant="ghost" className="no-print">
        All reports
      </LinkButton>
    </div>
  );
}

export default function Phase2ReportPage() {
  return (
    <Suspense>
      <Report />
    </Suspense>
  );
}
