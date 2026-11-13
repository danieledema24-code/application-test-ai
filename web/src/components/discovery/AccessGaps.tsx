"use client";

import { CircleCheck } from "lucide-react";
import type { ScanDetail } from "@/lib/contract";
import Link from "next/link";
import { accessGapRows, isSignInGap } from "@/lib/discovery";
import { Button, EmptyState, TBody, THead, Table, Td, Th, Tr } from "@/components/ui";
import { ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, refsToItems } from "@/components/domain/EvidenceDrawer";

/** Access gaps (design spec §8.2): what discovery could not observe, why, and what to do next. */
export function AccessGaps({ scan, projectId, onRescan }: { scan: ScanDetail; projectId: string; onRescan: () => void }) {
  const rows = accessGapRows(scan);
  if (rows.length === 0)
    return (
      <EmptyState
        icon={<CircleCheck className="h-5 w-5 text-success-fg" aria-hidden />}
        title="No access gaps."
        description="Every page found within the limit was observed."
      />
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-fg-muted">
          Areas discovery couldn’t observe in this scan. Signed-in areas need test credentials, which owners and admins can add in{" "}
          <Link href={`/projects/${projectId}/settings?view=credentials`} className="font-medium text-navy-700 underline underline-offset-2">
            Project settings
          </Link>
          .
        </p>
        <Button variant="secondary" onClick={onRescan}>
          Re-scan…
        </Button>
      </div>
      <Table label="Access gaps">
        <THead>
          <tr>
            <Th>Area</Th>
            <Th>Reason</Th>
            <Th>Label</Th>
            <Th>Evidence</Th>
            <Th>Suggested next step</Th>
          </tr>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <Tr key={`${r.area}-${i}`}>
              <Td rowHeader className="break-all font-mono text-small">
                {r.area}
              </Td>
              <Td>
                {r.reason}
                {r.description && <span className="block text-small text-fg-muted">{r.description}</span>}
                {isSignInGap(r.reason) && <span className="block text-small text-fg-muted">We tried once, to avoid locking the account.</span>}
              </Td>
              <Td>
                <ObservationLabel provenance="observed" />
              </Td>
              <Td>
                <EvidenceLinks items={refsToItems(r.evidence)} subject={`access gap ${r.area}`} />
              </Td>
              <Td>{r.suggestion}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
