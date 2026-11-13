"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ReportSummary } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LinkButton, LoadingBlock, StatusPill, TBody, THead, Table, Td, Th, Tr, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useProject } from "@/components/workspace/ProjectContext";
import { useScans } from "@/components/discovery/hooks";
import { scanNumber } from "@/lib/url";

/** Reports list (design spec §9.1). Phase 1 holds the Application Discovery Report only. */
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
      <Card className="px-5 py-4">
        <p className="text-body text-fg-muted">
          More reports arrive with later phases: Requirements Specification, Test Strategy and Test Plan in Phase 2; test design and traceability reports in Phase 3; execution and
          defect reports in Phase 4; release readiness in Phase 5.
        </p>
      </Card>
    </div>
  );
}
