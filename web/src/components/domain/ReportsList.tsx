"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, FilePlus2 } from "lucide-react";
import { fileUrl } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, personName } from "@/lib/format";
import type { Report } from "@/lib/types";
import { Badge, Button, Card, DataState, EmptyState, TBody, THead, Table, Td, Th, Tr } from "@/components/ui";
import { GenerateReportModal } from "./GenerateReportModal";
import { ProjectSelect } from "./ProjectSelect";

export function ReportsList({ projectId: fixedProjectId }: { projectId?: string }) {
  const [projectId, setProjectId] = useState("");
  const [open, setOpen] = useState(false);
  const pid = fixedProjectId || projectId;
  const { data, error, isLoading, mutate } = useApi<Report[]>("/reports", { projectId: pid }, { keepPreviousData: true });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {!fixedProjectId ? <ProjectSelect value={projectId} onChange={setProjectId} placeholder="All projects" label="Filter by project" wrapClassName="w-60" /> : <span />}
        <Button icon={<FilePlus2 className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)}>
          Generate report
        </Button>
      </div>
      <Card>
        <DataState
          data={data}
          error={error}
          isLoading={isLoading}
          onRetry={() => mutate()}
          empty={<EmptyState title="No reports yet" description="Generate a PDF or CSV report from recorded results." action={<Button onClick={() => setOpen(true)}>Generate report</Button>} />}
        >
          {(reports) => (
            <Table label="Reports">
              <THead>
                <tr>
                  <Th>Title</Th>
                  {!fixedProjectId && <Th>Project</Th>}
                  <Th>Scope</Th>
                  <Th>Format</Th>
                  <Th>Created</Th>
                  <Th srOnly>Download</Th>
                </tr>
              </THead>
              <TBody>
                {reports.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium text-fg-strong">{r.title}</Td>
                    {!fixedProjectId && <Td className="text-fg">{r.projectName}</Td>}
                    <Td>
                      {r.reportType === "RUN" && r.testRunId ? (
                        <Link href={`/test-runs/${r.testRunId}`} className="text-fg-strong hover:underline">
                          Run report
                        </Link>
                      ) : (
                        "Project report"
                      )}
                    </Td>
                    <Td>
                      <Badge tone={r.format === "PDF" ? "red" : "green"}>{r.format}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-fg-muted">
                      {fmtDateTime(r.createdAt)} · {personName(r.createdBy)}
                    </Td>
                    <Td className="text-right">
                      <a
                        href={fileUrl(r.downloadUrl || `/reports/${r.id}/download`)}
                        className="inline-flex items-center gap-1 text-sm font-medium text-fg-strong hover:underline"
                        aria-label={`Download ${r.title} (${r.format})`}
                      >
                        <Download className="h-4 w-4" aria-hidden /> Download
                      </a>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
      <GenerateReportModal open={open} onClose={() => setOpen(false)} projectId={fixedProjectId} onCreated={() => mutate()} />
    </div>
  );
}
