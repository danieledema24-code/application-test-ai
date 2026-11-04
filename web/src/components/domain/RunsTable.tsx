import Link from "next/link";
import { Bot } from "lucide-react";
import { fmtDuration, fmtPct, humanize, personName, timeAgo } from "@/lib/format";
import type { TestRun } from "@/lib/types";
import { Badge, StatusPill, TBody, THead, Table, Td, Th, Tr } from "@/components/ui";

export function RunsTable({ runs, showProject = true }: { runs: TestRun[]; showProject?: boolean }) {
  return (
    <Table label="Test runs">
      <THead>
        <tr>
          <Th>Run</Th>
          {showProject && <Th>Project</Th>}
          <Th>Type</Th>
          <Th>Environment</Th>
          <Th>Status</Th>
          <Th className="text-right">Passed / Total</Th>
          <Th className="text-right">Pass rate</Th>
          <Th className="text-right">Duration</Th>
          <Th>Initiated</Th>
        </tr>
      </THead>
      <TBody>
        {runs.map((r) => (
          <Tr key={r.id}>
            <Td>
              <Link href={`/test-runs/${r.id}`} className="font-medium text-blue-800 hover:underline">
                <span className="font-mono text-xs text-slate-600">{r.key}</span> {r.name}
              </Link>
            </Td>
            {showProject && (
              <Td>
                <Link href={`/projects/${r.projectId}`} className="text-slate-800 hover:underline">
                  {r.projectName}
                </Link>
              </Td>
            )}
            <Td>{humanize(r.executionType)}</Td>
            <Td>{r.environmentName ? <StatusPill status={r.environmentName} dot={false} /> : "—"}</Td>
            <Td>
              <StatusPill status={r.status} />
            </Td>
            <Td className="text-right tabular-nums">
              {r.summary?.passed ?? 0} / {r.summary?.total ?? 0}
            </Td>
            <Td className="text-right tabular-nums">{fmtPct(r.summary?.passRate)}</Td>
            <Td className="text-right tabular-nums">{fmtDuration(r.summary?.durationMs)}</Td>
            <Td className="whitespace-nowrap text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                {r.initiatedByAI && (
                  <Badge tone="violet" title="Initiated by the AI assistant">
                    <Bot className="h-3 w-3" aria-hidden /> AI
                  </Badge>
                )}
                {personName(r.initiatedBy)} · {timeAgo(r.createdAt)}
              </span>
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
