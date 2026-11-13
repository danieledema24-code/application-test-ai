"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { ApiError, downloadFile } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ReportDetail, ReportSummary, ScanDetail, StageRunDetail } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { hostOf, reportFileName, scanNumber } from "@/lib/url";
import { Button, EmptyState, ErrorState, LinkButton, LoadingBlock, useToast } from "@/components/ui";
import { ReportDocument, ReportToc } from "@/components/report/ReportDocument";
import { useProject } from "@/components/workspace/ProjectContext";
import { useScans } from "@/components/discovery/hooks";

type Format = "pdf" | "html" | "json";

function DiscoveryReport() {
  const p = useProject();
  const toast = useToast();
  const params = useSearchParams();
  const reports = useApi<ReportSummary[]>(`/projects/${p.id}/reports`, undefined, {
    refreshInterval: (d) => (d?.some((r) => r.status === "rendering") ? 3000 : 0),
  });
  const scans = useScans(p.id);
  const wantScan = params.get("scan");
  const wantReport = params.get("report");
  const wantScanId = wantScan ? scans.data?.items.find((s) => scanNumber(s.key) === Number(wantScan))?.id : undefined;

  const chosen = useMemo(() => {
    const list = (reports.data ?? []).filter((r) => r.report_type === "discovery").sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (wantReport) return list.find((r) => r.id === wantReport);
    if (wantScanId) return list.find((r) => r.scan_id === wantScanId && r.status === "ready") ?? list.find((r) => r.scan_id === wantScanId);
    return list.find((r) => r.status === "ready") ?? list[0];
  }, [reports.data, wantReport, wantScanId]);

  const detail = useApi<ReportDetail>(chosen && chosen.status === "ready" ? `/reports/${chosen.id}` : null);
  const scanId = detail.data?.scan_id ?? chosen?.scan_id ?? wantScanId ?? null;
  const scan = useApi<ScanDetail>(scanId ? `/scans/${scanId}` : `/projects/${p.id}/discovery`);
  const n = scan.data ? scanNumber(scan.data.key) : null;

  // Report status = Gate 2 status, for the latest scan's stage run.
  const gateStage = p.workflow?.stages.find((s) => s.gate?.key === "G2");
  const isLatest = !!gateStage?.current_version && (n === null || n === gateStage.current_version);
  const run = useApi<StageRunDetail>(gateStage?.current_version && isLatest ? `/projects/${p.id}/stages/${gateStage.key}/runs/${gateStage.current_version}` : null);
  const approval = run.data?.decisions.filter((d) => d.decision === "approve").pop();
  const approved = isLatest && (gateStage?.status === "approved" || gateStage?.gate?.status === "approved" || !!approval);

  const [downloading, setDownloading] = useState<Format | null>(null);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    document.title = `Application Discovery Report · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  async function download(format: Format) {
    if (!chosen) return;
    setDownloading(format);
    setAnnounce(format === "pdf" ? "Preparing PDF…" : "Preparing download…");
    const host = hostOf(p.project?.primary_url) || "site";
    try {
      await downloadFile(`/reports/${chosen.id}/download?format=${format}`, reportFileName(host, n, new Date(), format));
      setAnnounce(format === "pdf" ? "PDF ready" : "Download ready");
      toast("Report downloaded.");
    } catch (err) {
      setAnnounce("");
      toast(err instanceof ApiError && err.status === 409 ? "The report is still being prepared. Try again in a moment." : "Couldn’t create the PDF. Try again.", "error");
    } finally {
      setDownloading(null);
    }
  }

  if (reports.error && !reports.data) return <ErrorState error={reports.error} title="Couldn’t load the report." message="Try again." onRetry={() => void reports.mutate()} />;
  if (!reports.data) return <LoadingBlock label="Loading report…" />;
  if (!chosen)
    return (
      <EmptyState
        title="The report is generated when discovery finishes."
        action={<LinkButton href={`/projects/${p.id}/discovery`}>Watch discovery</LinkButton>}
      />
    );
  if (chosen.status === "rendering") return <LoadingBlock label="Preparing the report…" />;
  if (chosen.status === "failed")
    return <ErrorState error={null} title="Couldn’t create the report." message="Generate a new version from Reports." />;
  if (detail.error && !detail.data) return <ErrorState error={detail.error} title="Couldn’t load the report." message="Try again." onRetry={() => void detail.mutate()} />;
  if (!detail.data) return <LoadingBlock label="Loading report…" />;
  if (!detail.data.content) return <EmptyState title="This report has no in-app content." description="Download it as a PDF instead." />;

  const s = scan.data;
  const partial =
    s && (s.status === "cancelled" || s.status === "partial" || s.status === "failed")
      ? `Partial results: discovery was ${s.status === "cancelled" ? "cancelled" : "stopped"} after ${s.stats.pages} page${s.stats.pages === 1 ? "" : "s"}.`
      : null;
  const url = p.project?.urls?.[0];
  const gate1 = url?.authorised_at ? `confirmed by ${url.authorised_by?.full_name ?? url.authorised_by?.email ?? "the project creator"} on ${fmtDateTime(url.authorised_at)}.` : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <div>
        <ReportToc />
      </div>
      <div className="min-w-0">
        <span role="status" className="sr-only">
          {announce}
        </span>
        <ReportDocument
          content={detail.data.content}
          meta={{
            host: hostOf(p.project?.primary_url) || p.project?.name || "",
            scanNumber: n,
            createdAt: detail.data.created_at,
            status: { approved, by: approval?.decided_by?.full_name ?? null, at: approval?.decided_at ?? approval?.created_at ?? null },
            partial,
            gate1,
          }}
          actions={
            <>
              <Button onClick={() => void download("pdf")} loading={downloading === "pdf"} icon={<Download className="h-4 w-4" aria-hidden />}>
                {downloading === "pdf" ? "Preparing PDF…" : "Download PDF"}
              </Button>
              {detail.data.formats.includes("html") && (
                <Button variant="secondary" onClick={() => void download("html")} loading={downloading === "html"}>
                  Download HTML
                </Button>
              )}
              {detail.data.formats.includes("json") && (
                <Button variant="secondary" onClick={() => void download("json")} loading={downloading === "json"}>
                  Download JSON
                </Button>
              )}
              <Button variant="secondary" onClick={() => window.print()} icon={<Printer className="h-4 w-4" aria-hidden />}>
                Print
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

export default function DiscoveryReportPage() {
  return (
    <Suspense>
      <DiscoveryReport />
    </Suspense>
  );
}
