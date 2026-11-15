"use client";

// Non-functional summaries outside the section (design P5 §4.3–4.5): the Overview card, the lifecycle's optional
// rows and the shared data hook. Words come from the pure helpers in lib/nonfunctional.ts.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Workflow } from "@/lib/contract";
import { useApi } from "@/lib/hooks";
import { nfGlanceLines, nfLifecycleRows, nfReachable, type Overview } from "@/lib/nonfunctional";
import { Card, CardBody, CardHeader } from "@/components/ui";

/** GET /projects/{id}/non-functional, only once the checks are reachable (earlier projects make no call). */
export function useNfOverview(projectId: string, wf: Workflow | null | undefined) {
  const g2 = nfReachable(wf);
  const o = useApi<Overview>(g2 ? `/projects/${projectId}/non-functional` : null, undefined, { shouldRetryOnError: false, refreshInterval: 15000 });
  return { g2, overview: o.data };
}

export function NonFunctionalGlance({ projectId, g2, overview }: { projectId: string; g2: boolean; overview: Overview | undefined }) {
  const base = `/projects/${projectId}/non-functional`;
  return (
    <Card>
      <CardHeader title="Non-functional" />
      <CardBody className="space-y-1 text-body text-fg">
        {!g2 ? (
          <p className="text-fg-muted">Available after Gate 2.</p>
        ) : !overview ? (
          <p className="text-fg-muted">Loading…</p>
        ) : (
          <dl className="space-y-1">
            {nfGlanceLines(overview).map((l) => (
              <div key={l.label} className="grid grid-cols-[7rem_1fr] gap-2">
                <dt className="font-medium text-fg-muted">{l.label}</dt>
                <dd className={`break-words ${l.key ? "" : "text-fg-muted"}`}>{l.text}</dd>
              </div>
            ))}
          </dl>
        )}
        <Link href={base} className="mt-3 inline-flex items-center gap-1 font-medium text-navy-700 hover:underline">
          Open Non-functional <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </CardBody>
    </Card>
  );
}

/** "Optional checks · any time after Gate 2" (§4.3): three rows, no gate diamonds, each linking to its tab. */
export function OptionalChecks({ projectId, g2, overview, canApprove }: { projectId: string; g2: boolean; overview: Overview | undefined; canApprove: boolean }) {
  const rows = nfLifecycleRows(overview, g2, canApprove);
  return (
    <section aria-labelledby="optional-checks-h" className="mt-4 border-t border-line pt-3">
      <h3 id="optional-checks-h" className="text-small font-semibold text-fg-strong">
        Optional checks · any time after Gate 2
      </h3>
      <ul className="mt-2 grid gap-2 md:grid-cols-3">
        {rows.map((r) => (
          <li key={r.id} className="min-w-0">
            {g2 ? (
              <Link href={`/projects/${projectId}/non-functional?tab=${r.id}`} className="block rounded-sm hover:underline">
                <span className="block text-small font-semibold text-fg-strong">{r.label}</span>
                <span className="block text-caption text-fg">{r.status}</span>
                <span className="block text-caption text-fg-muted">{r.agent}</span>
              </Link>
            ) : (
              <>
                <span className="block text-small font-semibold text-fg-muted">{r.label}</span>
                <span className="block text-caption text-fg-muted">{r.status}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-caption text-fg-muted">
        Every load test needs its own approval. Accessibility and security checks only read pages. Starts only when someone runs it.
      </p>
    </section>
  );
}
