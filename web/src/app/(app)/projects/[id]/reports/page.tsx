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
import { FORMAT_HINT, FORMAT_TEXT, P6_CSV_HINT, REPORT_TYPES, downloadFailedText, downloadFormats, isPhase3Report, isPhase6Report, latestPerAssessment, phase2ReportFileName, preparingText, type DownloadFormat, type ReportType } from "@/lib/reports";
import { useAuth } from "@/lib/auth";
import { gateApproved, requirementsStages } from "@/components/requirements/hooks";
import { ReleaseGlance } from "@/components/workspace/OverviewRelease";
import { CompletionReportDialog } from "@/components/report/Phase6Report";
import { releaseReachable, useReleaseOverview } from "@/components/release/hooks";

/** [Download ▾] menu: PDF and HTML, plus CSV for the Phase 3 reports; the trigger shows the loading state (design P2 §10.1, P3 §15.1). */
function DownloadMenu({ report, name, host }: { report: ReportSummary; name: string; host: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<DownloadFormat | null>(null);
  const formats = downloadFormats(report.report_type as ReportType);
  async function get(format: DownloadFormat) {
    setOpen(false);
    setBusy(format);
    try {
      await downloadFile(`/reports/${report.id}/download?format=${format}`, phase2ReportFileName(host, report.report_type as ReportType, report.version, new Date(), format, report.run_key));
      toast("Report downloaded.");
    } catch {
      toast(downloadFailedText(format), "error");
    } finally {
      setBusy(null);
    }
  }
  const item = "flex min-h-10 w-full flex-col items-start px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay";
  return (
    <div className="relative inline-block" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <Button size="sm" variant="secondary" aria-haspopup="menu" aria-expanded={open} aria-label={`Download ${name} version ${report.version}`} onClick={() => setOpen((o) => !o)} loading={!!busy}>
        {busy ? preparingText(busy) : "Download"}
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-60 rounded-lg bg-surface py-1 text-left shadow-lg ring-1 ring-line-strong">
          {formats.map((f) => (
            <button key={f} role="menuitem" type="button" className={item} onClick={() => void get(f)}>
              {FORMAT_TEXT[f]}
              {(f === "csv" && isPhase6Report(report.report_type) ? P6_CSV_HINT[report.report_type] : FORMAT_HINT[f]) && (
                <span className="text-small text-fg-muted">{f === "csv" && isPhase6Report(report.report_type) ? P6_CSV_HINT[report.report_type] : FORMAT_HINT[f]}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function approvalText(r: ReportSummary, gate: string | null): string {
  if (r.status === "rendering") return "Preparing";
  if (r.status === "failed") return "Failed";
  if (r.approval?.status === "approved") return gate ? `Approved (Gate ${gate.slice(1)})` : "Current";
  return gate === "G5" ? "Draft · Gate 5 waiting" : "Draft";
}

/** Reports list (design P1 §9.1, P2 §10.1): discovery report versions, then one row per Phase 2 report type. */
export default function ReportsPage() {
  const p = useProject();
  const toast = useToast();
  const reports = useApi<ReportSummary[]>(`/projects/${p.id}/reports`, undefined, {
    refreshInterval: (d) => (d?.some((r) => r.status === "rendering") ? 3000 : 0),
  });
  const scans = useScans(p.id);
  const { role } = useAuth();
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState<ReportType | null>(null);
  const discovery = (reports.data ?? []).filter((r) => r.report_type === "discovery").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const scanKey = (id: string | null | undefined) => scans.data?.items.find((s) => s.id === id)?.key;
  const discoveryDone = p.discovery && ["completed", "approved", "awaiting_approval", "cancelled", "failed"].includes(p.discovery.status);
  const stages = requirementsStages(p.workflow);
  const host = hostOf(p.project?.primary_url) || "site";
  const ran = !!p.workflow?.stages.find((x) => x.key === "execution")?.current_version;
  const phase4 = REPORT_TYPES.filter((t) => t.phase === 4).map((t) => {
    const versions = (reports.data ?? []).filter((r) => r.report_type === t.type).sort((a, b) => b.version - a.version);
    return { ...t, versions, latest: versions[0], unavailable: !ran && !versions.length ? "Needs a test run" : null };
  });
  const phase5 = REPORT_TYPES.filter((t) => t.phase === 5).map((t) => {
    const versions = (reports.data ?? []).filter((r) => r.report_type === t.type).sort((a, b) => b.version - a.version);
    return { ...t, versions, latest: versions[0] };
  });
  // Phase 6 (design P6 §11.1): the Release Readiness Report's latest version per assessment, newest first; Test
  // Completion Reports on request. Both need an assessment first.
  const release = useReleaseOverview(p.id, releaseReachable(p.workflow));
  const assessed = !!release.data?.history.length;
  const readiness = latestPerAssessment(reports.data ?? []);
  const completion = (reports.data ?? []).filter((r) => r.report_type === "completion").sort((a, b) => b.version - a.version);
  const [completionOpen, setCompletionOpen] = useState(false);
  const phase6 = REPORT_TYPES.filter((t) => t.phase === 6).map((t) => {
    const versions = t.type === "release_readiness" ? readiness : completion;
    return { ...t, versions, latest: versions[0], unavailable: !assessed && !versions.length ? t.unavailable : null };
  });
  const phase2 = REPORT_TYPES.filter((t) => t.type !== "discovery" && !t.phase).map((t) => {
    const versions = (reports.data ?? []).filter((r) => r.report_type === t.type).sort((a, b) => b.version - a.version);
    const unavailable =
      t.type === "test_plan" && !gateApproved(stages.g4)
        ? "Needs Gate 4 approval"
        : t.type === "test_strategy" && !stages.strategy?.current_version
          ? "Needs the Test Strategy"
          : t.type === "requirements_spec" && !stages.req?.current_version
            ? "Needs requirements"
            : isPhase3Report(t.type) && !stages.design?.current_version
              ? "Needs test cases"
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

  async function generateDraft(type: ReportType) {
    setDrafting(type);
    try {
      await api(`/projects/${p.id}/reports`, { body: { report_type: type } });
      toast("Creating a draft from the current version. It appears here when it’s ready.", "info");
      await reports.mutate();
    } catch (err) {
      toast(`Couldn’t create the draft. ${errorMessage(err)}`, "error");
    } finally {
      setDrafting(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Reports
      </h1>
      {/* Release readiness sits at the top of Reports (design P6 §4.1, §11.1): the sidebar's way into the workspace. */}
      <ReleaseGlance />
      <Card>
        <CardHeader
          title="Release readiness and test completion"
          description="A frozen Release Readiness Report is created for each assessment and again when Gate 9 is decided. Test Completion Reports are generated on request."
        />
        {!reports.data ? (
          <LoadingBlock label="Loading reports…" />
        ) : (
          <>
            <Table label="Release readiness and test completion reports">
              <THead>
                <tr>
                  <Th>Report</Th>
                  <Th>Latest</Th>
                  <Th>Status</Th>
                  <Th srOnly>Actions</Th>
                </tr>
              </THead>
              <TBody>
                {phase6.map((t) => (
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
                    <Td className="tabular-nums">{t.latest ? `Version ${t.latest.version} · ${t.latest.run_key ?? "current data"}` : "—"}</Td>
                    <Td>
                      {t.unavailable ? (
                        <span className="text-fg-muted">Not available yet · {t.unavailable}</span>
                      ) : t.latest ? (
                        <StatusPill
                          status={t.latest.status === "failed" ? "failed" : t.latest.status === "rendering" ? "running" : t.latest.approval?.status === "draft" ? "draft" : "approved"}
                          label={
                            t.latest.status === "rendering"
                              ? "Preparing"
                              : t.latest.status === "failed"
                                ? "Failed"
                                : t.latest.approval?.status === "draft"
                                  ? "Draft · Gate 9 not decided"
                                  : t.type === "release_readiness"
                                    ? "Final (Gate 9)"
                                    : "Ready"
                          }
                        />
                      ) : (
                        <span className="text-fg-muted">No version yet</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        {t.type === "completion" && !t.unavailable && role !== "viewer" && role !== null && (
                          <Button size="sm" variant="secondary" onClick={() => setCompletionOpen(true)}>
                            Generate…<span className="sr-only"> {t.name}</span>
                          </Button>
                        )}
                        {t.latest && t.latest.status === "ready" ? <DownloadMenu report={t.latest} name={t.name} host={host} /> : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {phase6
              .filter((t) => t.versions.length > 1)
              .map((t) => (
                <div key={t.type} className="border-t border-line px-5 py-3">
                  <Disclosure label={`${t.name}: earlier (${t.versions.length - 1})`}>
                    <ul className="mt-2 space-y-1 text-body">
                      {t.versions.slice(1).map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2">
                          <Link href={`/projects/${p.id}/reports/${t.slug}?version=${r.version}`} className="text-navy-700 underline underline-offset-2">
                            Version {r.version} · {r.run_key ?? "current data"}
                          </Link>
                          <span className="text-fg-muted">
                            {r.approval?.status === "draft" ? "Draft · " : ""}
                            {fmtDateTime(r.created_at)}
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
      <CompletionReportDialog
        open={completionOpen}
        onClose={() => setCompletionOpen(false)}
        assessment={release.data?.history[0] ?? null}
        onGenerated={() => {
          setCompletionOpen(false);
          void reports.mutate();
        }}
      />
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
        <CardHeader
          title="Requirements, strategy, plan and test design"
          description="Frozen versions are created when Gates 3, 4 and 5 are approved and when the Test Plan is written."
        />
        {!reports.data ? (
          <LoadingBlock label="Loading reports…" />
        ) : (
          <>
            <Table label="Phase 2 and 3 reports">
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
                    <Td>
                      {t.latest
                        ? t.latest.stage_run_version
                          ? `${isPhase3Report(t.type) ? `${t.source} ${t.latest.stage_run_version}` : `${t.source} v${t.latest.stage_run_version}`}${t.gate === "G5" && t.latest.approval?.status === "approved" ? " · Gate 5" : ""}`
                          : "—"
                        : t.unavailable
                          ? `Not available yet · ${t.unavailable}`
                          : "—"}
                    </Td>
                    <Td className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        {isPhase3Report(t.type) && !t.unavailable && role !== "viewer" && role !== null && (!t.latest || t.latest.is_latest_source === false) && (
                          <Button size="sm" variant="secondary" onClick={() => void generateDraft(t.type)} loading={drafting === t.type}>
                            Generate draft<span className="sr-only"> of the {t.name}</span>
                          </Button>
                        )}
                        {t.latest && t.latest.status === "ready" ? <DownloadMenu report={t.latest} name={t.name} host={host} /> : !isPhase3Report(t.type) || t.unavailable ? "—" : null}
                      </span>
                    </Td>
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
      <Card>
        <CardHeader title="Test execution and defects" description="A frozen Test Execution Report is created when each run finishes. Causes are hypotheses unless a person confirmed them." />
        {!reports.data ? (
          <LoadingBlock label="Loading reports…" />
        ) : (
          <Table label="Execution and defect reports">
            <THead>
              <tr>
                <Th>Report</Th>
                <Th>Latest</Th>
                <Th>Status</Th>
                <Th srOnly>Actions</Th>
              </tr>
            </THead>
            <TBody>
              {phase4.map((t) => (
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
                  <Td className="tabular-nums">{t.latest ? `Version ${t.latest.version}${t.latest.run_key ? ` · ${t.latest.run_key}` : t.type === "execution" ? " · latest per test case" : ""}` : "—"}</Td>
                  <Td>
                    {t.unavailable ? (
                      <span className="text-fg-muted">Not available yet · {t.unavailable}</span>
                    ) : t.latest ? (
                      <StatusPill
                        status={t.latest.status === "failed" ? "failed" : t.latest.status === "rendering" ? "running" : t.latest.approval?.status === "draft" ? "draft" : "approved"}
                        label={t.latest.status === "rendering" ? "Preparing" : t.latest.status === "failed" ? "Failed" : t.latest.approval?.status === "draft" ? "Draft · Gate 8 waiting" : "Ready"}
                      />
                    ) : (
                      <span className="text-fg-muted">No version yet</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <span className="inline-flex flex-wrap justify-end gap-2">
                      {!t.unavailable && role !== "viewer" && role !== null && (
                        <Button size="sm" variant="secondary" onClick={() => void generateDraft(t.type)} loading={drafting === t.type}>
                          {t.type === "execution" ? "Generate (latest result per test case)" : "Generate"}
                          <span className="sr-only"> {t.name}</span>
                        </Button>
                      )}
                      {t.latest && t.latest.status === "ready" && <DownloadMenu report={t.latest} name={t.name} host={host} />}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Non-functional" description="A frozen report is created when each load test or check finishes." />
        {!reports.data ? (
          <LoadingBlock label="Loading reports…" />
        ) : (
          <>
            <Table label="Non-functional reports">
              <THead>
                <tr>
                  <Th>Report</Th>
                  <Th>Latest</Th>
                  <Th>Status</Th>
                  <Th srOnly>Actions</Th>
                </tr>
              </THead>
              <TBody>
                {phase5.map((t) => (
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
                    <Td className="tabular-nums">{t.latest ? `Version ${t.latest.version}${t.latest.run_key ? ` · ${t.latest.run_key}` : ""}` : "—"}</Td>
                    <Td>
                      {!t.latest ? (
                        <span className="text-fg-muted">Not available yet · {t.unavailable}</span>
                      ) : (
                        <StatusPill
                          status={t.latest.status === "failed" ? "failed" : t.latest.status === "rendering" ? "running" : "approved"}
                          label={t.latest.status === "rendering" ? "Preparing" : t.latest.status === "failed" ? "Failed" : "Ready"}
                        />
                      )}
                    </Td>
                    <Td className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        {t.latest && role !== "viewer" && role !== null && (
                          <Button size="sm" variant="secondary" onClick={() => void generateDraft(t.type)} loading={drafting === t.type}>
                            Generate<span className="sr-only"> {t.name} from the latest {t.source.toLowerCase()}</span>
                          </Button>
                        )}
                        {t.latest && t.latest.status === "ready" ? <DownloadMenu report={t.latest} name={t.name} host={host} /> : null}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {phase5
              .filter((t) => t.versions.length > 1)
              .map((t) => (
                <div key={t.type} className="border-t border-line px-5 py-3">
                  <Disclosure label={`${t.name}: earlier (${t.versions.length - 1})`}>
                    <ul className="mt-2 space-y-1 text-body">
                      {t.versions.slice(1).map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2">
                          <Link href={`/projects/${p.id}/reports/${t.slug}?version=${r.version}`} className="text-navy-700 underline underline-offset-2">
                            Version {r.version}
                            {r.run_key ? ` · ${r.run_key}` : ""}
                          </Link>
                          <span className="text-fg-muted">{fmtDateTime(r.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                </div>
              ))}
          </>
        )}
      </Card>
    </div>
  );
}
