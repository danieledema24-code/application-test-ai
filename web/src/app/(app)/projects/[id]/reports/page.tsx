"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, downloadFile, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ReportSummary } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Disclosure, EmptyState, ErrorState, LinkButton, LoadingBlock, StatusPill, TBody, THead, Table, Td, Th, Tr, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useProject } from "@/components/workspace/ProjectContext";
import { useScans } from "@/components/discovery/hooks";
import { hostOf, scanNumber } from "@/lib/url";
import { REPORT_TYPES, phase2ReportFileName, type ReportType } from "@/lib/reports";
import { gateApproved, requirementsStages } from "@/components/requirements/hooks";

/** [Download ▾] menu with PDF and HTML; the trigger shows the loading state (design P2 §10.1). */
function DownloadMenu({ report, name, host }: { report: ReportSummary; name: string; host: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"pdf" | "html" | null>(null);
  async function get(format: "pdf" | "html") {
    setOpen(false);
    setBusy(format);
    try {
      await downloadFile(`/reports/${report.id}/download?format=${format}`, phase2ReportFileName(host, report.report_type as ReportType, report.version, new Date(), format));
      toast("Report downloaded.");
    } catch {
      toast(format === "pdf" ? "Couldn’t create the PDF. Try again." : "Couldn’t create the HTML file. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }
  const item = "flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay";
  return (
    <div className="relative inline-block" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <Button size="sm" variant="secondary" aria-haspopup="menu" aria-expanded={open} aria-label={`Download ${name} version ${report.version}`} onClick={() => setOpen((o) => !o)} loading={!!busy}>
        {busy === "pdf" ? "Preparing PDF…" : busy === "html" ? "Preparing HTML…" : "Download"}
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-48 rounded-lg bg-surface py-1 text-left shadow-lg ring-1 ring-line-strong">
          <button role="menuitem" type="button" className={item} onClick={() => void get("pdf")}>
            PDF
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => void get("html")}>
            HTML (single file)
          </button>
        </div>
      )}
    </div>
  );
}

function approvalText(r: ReportSummary, gate: string | null): string {
  if (r.status === "rendering") return "Preparing";
  if (r.status === "failed") return "Failed";
  if (r.approval?.status === "approved") return gate ? `Approved (Gate ${gate.slice(1)})` : "Current";
  return "Draft";
}

/** Reports list (design P1 §9.1, P2 §10.1): discovery report versions, then one row per Phase 2 report type. */
export default function ReportsPage() {
  const p = useProject();
  const toast = useToast();
  const reports = useApi<ReportSummary[]>(`/projects/${p.id}/reports`, undefined, {
    refreshInterval: (d) => (d?.some((r) => r.status === "rendering") ? 3000 : 0),
  });
  const scans = useScans(p.id);
  const [busy, setBusy] = useState(false);
  const discovery = (reports.data ?? []).filter((r) => r.report_type === "discovery").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const scanKey = (id: string | null | undefined) => scans.data?.items.find((s) => s.id === id)?.key;
  const discoveryDone = p.discovery && ["completed", "approved", "awaiting_approval", "cancelled", "failed"].includes(p.discovery.status);
  const stages = requirementsStages(p.workflow);
  const host = hostOf(p.project?.primary_url) || "site";
  const phase2 = REPORT_TYPES.filter((t) => t.type !== "discovery").map((t) => {
    const versions = (reports.data ?? []).filter((r) => r.report_type === t.type).sort((a, b) => b.version - a.version);
    const unavailable =
      t.type === "test_plan" && !gateApproved(stages.g4)
        ? "Needs Gate 4 approval"
        : t.type === "test_strategy" && !stages.strategy?.current_version
          ? "Needs the Test Strategy"
          : t.type === "requirements_spec" && !stages.req?.current_version
            ? "Needs requirements"
            : null;
    return { ...t, versions, latest: versions[0], unavailable };
  });

  useEffect(() => {
    document.title = `Reports · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);

  async function generate() {
    setBusy(true);
    try {
      await api(`/projects/${p.id}/reports`, { body: { report_type: "discovery" } });
      toast("Generating the report. It appears here when it’s ready.", "info");
      await reports.mutate();
    } catch (err) {
      toast(`Couldn’t generate the report. ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Reports
      </h1>
      <Card>
        <CardHeader
          title="Application Discovery Report"
          description="One report per scan, generated when discovery finishes."
          actions={
            discoveryDone ? (
              <Button variant="secondary" onClick={() => void generate()} loading={busy}>
                Generate new version
              </Button>
            ) : undefined
          }
        />
        {reports.error && !reports.data ? (
          <ErrorState error={reports.error} title="Couldn’t load the report." message="Try again." onRetry={() => void reports.mutate()} />
        ) : !reports.data ? (
          <LoadingBlock label="Loading reports…" />
        ) : discovery.length === 0 ? (
          <EmptyState
            title="The report is generated when discovery finishes."
            action={
              discoveryDone ? (
                <Button onClick={() => void generate()} loading={busy}>
                  Generate report
                </Button>
              ) : (
                <LinkButton href={`/projects/${p.id}/discovery`}>Watch discovery</LinkButton>
              )
            }
          />
        ) : (
          <Table label="Discovery reports">
            <THead>
              <tr>
                <Th>Report</Th>
                <Th>Scan</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th>Source</Th>
              </tr>
            </THead>
            <TBody>
              {discovery.map((r) => {
                const n = r.scan_number ?? scanNumber(r.scan_key ?? scanKey(r.scan_id));
                const older = r.is_latest_scan === false;
                return (
                  <Tr key={r.id}>
                    <Td rowHeader>
                      {r.status === "ready" ? (
                        <Link href={`/projects/${p.id}/reports/discovery?report=${r.id}`} className="text-navy-700 underline underline-offset-2">
                          Application Discovery Report v{r.version}
                        </Link>
                      ) : (
                        `Application Discovery Report v${r.version}`
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {n ? `Scan ${n}` : "—"}
                      {older && (
                        <Badge tone="grey" className="ml-2">
                          Based on an older scan
                        </Badge>
                      )}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusPill status={r.status} label={r.status === "rendering" ? "Preparing" : r.status === "ready" ? "Ready" : "Failed"} />
                        {r.status === "ready" && r.approval_status === "approved" && <StatusPill status="approved" label="Approved" />}
                        {r.status === "ready" && r.approval_status === "draft" && <Badge tone="grey">Draft</Badge>}
                        {r.partial && <Badge tone="amber">Partial</Badge>}
                      </span>
                    </Td>
                    <Td className="tabular-nums">{fmtDateTime(r.created_at)}</Td>
                    <Td>
                      <GeneratedByLabel generatedBy={r.generated_by} />
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Requirements, strategy and plan" description="Frozen versions are created when Gate 3 and Gate 4 are approved and when the Test Plan is written." />
        {!reports.data ? (
          <LoadingBlock label="Loading reports…" />
        ) : (
          <>
            <Table label="Phase 2 reports">
              <THead>
                <tr>
                  <Th>Report</Th>
                  <Th>Latest</Th>
                  <Th>Status</Th>
                  <Th>Based on</Th>
                  <Th srOnly>Actions</Th>
                </tr>
              </THead>
              <TBody>
                {phase2.map((t) => (
                  <Tr key={t.type}>
                    <Td rowHeader>
                      {t.latest ? (
                        <Link href={`/projects/${p.id}/reports/${t.slug}`} className="text-navy-700 underline underline-offset-2">
                          {t.name}
                        </Link>
                      ) : (
                        t.name
                      )}
                    </Td>
                    <Td className="tabular-nums">{t.latest ? `Version ${t.latest.version}` : "—"}</Td>
                    <Td>
                      {t.latest ? (
                        <StatusPill
                          status={t.latest.approval?.status === "approved" ? "approved" : t.latest.status === "failed" ? "failed" : t.latest.status === "rendering" ? "running" : "draft"}
                          label={approvalText(t.latest, t.gate)}
                        />
                      ) : (
                        <span className="text-fg-muted">Not available yet</span>
                      )}
                    </Td>
                    <Td>{t.latest ? (t.latest.stage_run_version ? `${t.source} v${t.latest.stage_run_version}` : "—") : (t.unavailable ?? "—")}</Td>
                    <Td className="text-right">{t.latest && t.latest.status === "ready" ? <DownloadMenu report={t.latest} name={t.name} host={host} /> : "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {phase2
              .filter((t) => t.versions.length > 1)
              .map((t) => (
                <div key={t.type} className="border-t border-line px-5 py-3">
                  <Disclosure label={`${t.name}: older versions (${t.versions.length - 1})`}>
                    <ul className="mt-2 space-y-1 text-body">
                      {t.versions.slice(1).map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2">
                          <Link href={`/projects/${p.id}/reports/${t.slug}?version=${r.version}`} className="text-navy-700 underline underline-offset-2">
                            Version {r.version}
                          </Link>
                          <span className="text-fg-muted">
                            {approvalText(r, t.gate)} · {fmtDateTime(r.created_at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                </div>
              ))}
          </>
        )}
      </Card>
      <Card className="px-5 py-4">
        <p className="text-body text-fg-muted">
          More reports arrive with later phases: Test Case Specification and Traceability Matrix in Phase 3; execution and defect reports in Phase 4; release readiness in Phase 5.
        </p>
      </Card>
    </div>
  );
}
