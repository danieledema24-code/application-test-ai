"use client";

// Overview "Release readiness" card (design P6 §4.5): the latest verdict with its state word, conditions, residual
// risk and Gate 9, and "Overridden by {name}: '{reason}'" whenever the verdict was overridden.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { AVAILABLE_AFTER_RUN, assessError, finalLine, glanceLine, quotedOverride, type ReleaseOverview } from "@/lib/release";
import { Button, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { VerdictChip } from "@/components/domain/ReleaseLabels";
import { releaseReachable, useReleaseOverview } from "@/components/release/hooks";
import { useProject } from "./ProjectContext";

export function ReleaseGlance() {
  const p = useProject();
  const router = useRouter();
  const { role, canApprove } = useAuth();
  const member = role !== null && role !== "viewer";
  const reachable = releaseReachable(p.workflow);
  const q = useReleaseOverview(p.id, reachable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = `/projects/${p.id}/release-readiness`;
  const d = q.data;
  const a = d?.latest ?? null;

  async function assess() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<ReleaseOverview>(`/projects/${p.id}/release-assessments`, { body: {} });
      await q.mutate(next, { revalidate: false });
      router.push(page);
    } catch (e) {
      setError(assessError(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (!reachable || (d && !d.available && !a)) body = <p className="text-fg-muted">{AVAILABLE_AFTER_RUN}.</p>;
  else if (!d) body = q.error ? <p className="text-fg-muted">Couldn’t load release readiness.</p> : <Skeleton className="h-10" />;
  else if (d.assessing) body = <p>Assessing release readiness…</p>;
  else if (!a)
    body = (
      <div className="space-y-2">
        <p>Not assessed yet.</p>
        {member && (
          <Button size="sm" variant="secondary" onClick={() => void assess()} loading={busy}>
            Assess release readiness
          </Button>
        )}
        {error && (
          <p role="alert" className="text-small font-medium text-danger-fg">
            {error}
          </p>
        )}
      </div>
    );
  else
    body = (
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <VerdictChip verdict={a.verdict} state={a.verdict_state} />
          <span>
            {a.key} · {fmtDateTime(a.assessed_at ?? a.created_at)}
          </span>
        </p>
        {/* Overridden: the quoted line names the decider once; otherwise "Final: Go · A. Approver". */}
        {a.override_line ? <p className="break-words font-medium text-fg-strong">{quotedOverride(a.override_line)}</p> : finalLine(a) && <p className="font-medium text-fg-strong">{finalLine(a)}</p>}
        {a.status === "stale" ? <p>Out of date: evidence changed after {a.key}.</p> : <p className="text-small text-fg">{glanceLine(a, canApprove && member)}</p>}
      </div>
    );

  return (
    // A named region (the Card's classes on a labelled section), so the card can be found as "Release readiness".
    <section aria-labelledby="release-glance-heading" className="min-w-0 rounded-lg border border-line bg-surface shadow-xs">
      <CardHeader title={<span id="release-glance-heading">Release readiness</span>} />
      <CardBody className="space-y-1 text-body text-fg">
        {body}
        <Link href={page} className="mt-3 inline-flex items-center gap-1 font-medium text-navy-700 hover:underline">
          Open release readiness <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </section>
  );
}
