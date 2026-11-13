"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReadinessCriteria, RequirementSummary, StageState } from "@/lib/contract";
import { buildQuery } from "@/lib/api";
import { gate3Checks, isWeakLabel } from "@/lib/requirements";
import { StatTile } from "@/components/ui";
import { GateReviewPanel } from "@/components/domain/GateReviewPanel";

const ASSESSMENT: Record<string, string> = { proceed: "Ready", proceed_with_caution: "Ready with gaps", do_not_proceed: "Not ready" };

/**
 * Review · Gate 3 (design P2 §6.2). Every number is computed here from the requirement set; the agent only
 * supplies the assessment and recommendation (labelled). Drafts left → confirm before approving.
 */
export function Gate3Review({
  projectId,
  stage,
  all,
  readiness,
  scanN,
  documents,
  readOnly,
  onDecided,
  onRegenerateWithFeedback,
}: {
  projectId: string;
  stage: StageState;
  all: RequirementSummary[];
  readiness: ReadinessCriteria | undefined;
  scanN: number | null;
  documents: number;
  readOnly: boolean;
  onDecided: () => void;
  onRegenerateWithFeedback: (comment: string) => void;
}) {
  const router = useRouter();
  const base = `/projects/${projectId}/requirements`;
  const listHref = (q: Record<string, string>) => `${base}${buildQuery({ view: "list", ...q })}`;
  const checks = gate3Checks(all, readiness, { scanN, documents, listHref });
  const live = all.filter((r) => r.status !== "rejected");
  const approved = all.filter((r) => r.status === "approved").length;
  const drafts = all.filter((r) => r.status === "draft" || r.status === "needs_info").length;
  const weak = live.filter(isWeakLabel).length;
  const rec = stage.gate?.recommendation ?? null;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Requirements" value={live.length} href={listHref({})} />
        <StatTile label="Approved" value={approved} href={listHref({ status: "approved" })} />
        <StatTile label="Draft" value={drafts} href={listHref({ status: "draft" })} />
        <StatTile label="Assumed or Unverified" value={weak} href={listHref({ label: "weak" })} />
      </div>
      <GateReviewPanel
        projectId={projectId}
        stage={stage}
        title="Gate 3 · Requirements review"
        assessment={rec ? ASSESSMENT[rec.recommend] : null}
        checks={checks}
        recommendation={rec && rec.reasons.length ? { text: rec.reasons[0], generatedBy: rec.generated_by, reasons: rec.reasons.slice(1) } : null}
        changesSinceApproval={stage.gate?.changes_since_approval ? { count: stage.gate.changes_since_approval } : null}
        approveLabel="Approve requirements"
        approvedToast="Requirements approved."
        afterApproveCopy={
          <>
            Requirements approved. The Test Strategy Agent is now writing the risk-based Test Strategy.{" "}
            <Link href={`/projects/${projectId}/test-strategy`} className="font-medium text-navy-700 underline underline-offset-2">
              Go to Test Strategy
            </Link>
          </>
        }
        afterRequestChanges={(comment) => (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onRegenerateWithFeedback(comment)} className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
              Regenerate with this feedback
            </button>
            <Link href={listHref({})} className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
              Edit requirements
            </Link>
          </div>
        )}
        confirmApprove={
          drafts > 0
            ? {
                title: `Approve with ${drafts} draft${drafts === 1 ? "" : "s"}?`,
                body: `Approved requirements go to the Test Strategy Agent. The ${drafts} draft${drafts === 1 ? " is" : "s are"} left out until you approve ${drafts === 1 ? "it" : "them"}.`,
                confirmLabel: "Approve requirements",
                cancelLabel: "Review drafts",
                onCancel: () => router.push(listHref({ status: "draft" })),
              }
            : null
        }
        reportHref={`/projects/${projectId}/reports/requirements`}
        reportLabel="View Requirements Specification"
        readOnly={readOnly}
        onDecided={onDecided}
      />
    </div>
  );
}
