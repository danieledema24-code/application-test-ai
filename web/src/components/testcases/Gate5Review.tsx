"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { buildQuery } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DesignLint, Gaps, LintCode, StageState, TestCaseSummary } from "@/lib/contract";
import { LINT_DEFS, g5Checks, lintCounts, lintName, lintTypeLinkLabel } from "@/lib/testcases";
import { Disclosure, StatTile } from "@/components/ui";
import { GateReviewPanel } from "@/components/domain/GateReviewPanel";
import { SeverityText } from "./Bits";

/** Cases per lint code (from the lint summary), split by severity, each with a link to exactly those cases. */
export function lintByType(lint: DesignLint | null | undefined) {
  const byCode = new Map<string, Set<string>>();
  for (const c of lint?.cases ?? []) for (const i of c.items ?? []) byCode.set(i.code, (byCode.get(i.code) ?? new Set()).add(c.key));
  const rows = [...byCode.entries()].map(([code, keys]) => ({ code, keys: [...keys].sort(), severity: LINT_DEFS[code as LintCode]?.severity ?? "advice" }));
  return { must: rows.filter((r) => r.severity === "must"), advice: rows.filter((r) => r.severity === "advice") };
}

/**
 * Review · Gate 5 (design P3 §13). Every line is computed from API data: blockers disable approval, advice never
 * does. The approve button stays focusable with its visible reason (R2-04).
 */
export function Gate5Review({
  projectId,
  stage,
  cases,
  gaps,
  lint,
  g4Approved,
  designCurrent,
  reqVersion,
  strategyVersion,
  designVersion,
  readOnly,
  onDecided,
  onRegenerateWithFeedback,
}: {
  projectId: string;
  stage: StageState;
  cases: TestCaseSummary[];
  gaps: Gaps | null | undefined;
  lint: DesignLint | null | undefined;
  g4Approved: boolean;
  designCurrent: boolean;
  reqVersion: number | null;
  strategyVersion: number | null;
  designVersion: number | null;
  readOnly: boolean;
  onDecided: () => void;
  onRegenerateWithFeedback: (comment: string) => void;
}) {
  const router = useRouter();
  const { role } = useAuth();
  const base = `/projects/${projectId}`;
  const listHref = (q: Record<string, string>) => `${base}/test-cases${buildQuery(q)}`;
  const checks = g5Checks({
    cases,
    gaps,
    g4Approved,
    designCurrent,
    strategyVersion,
    gate: stage.gate,
    listHref,
    traceHref: (a) => `${base}/traceability#${a}`,
    riskHref: (k) => `${base}/test-strategy?view=risks&risk=${k}`,
    g4Href: `${base}/test-strategy?view=review`,
  });
  const active = cases.filter((c) => c.status === "draft" || c.status === "approved");
  const approved = cases.filter((c) => c.status === "approved").length;
  const drafts = cases.filter((c) => c.status === "draft").length;
  const oq = active.filter((c) => c.expected_result_status === "open_question").length;
  const must = active.filter((c) => lintCounts(c).must > 0).length;
  const accepted = gaps?.untested_high_risk?.accepted ?? [];
  const byType = lintByType(lint);
  const rec = stage.gate?.recommendation ?? null;
  const n = checks.blockers.length;
  const recommendation = rec?.reasons?.length
    ? { text: rec.reasons[0], generatedBy: rec.generated_by, reasons: rec.reasons.slice(1) }
    : { text: n ? `Do not approve yet. Resolve the ${n} item${n === 1 ? "" : "s"} under “Must fix before approval”.` : "The checks are met. Review the advice, then approve.", generatedBy: "rules" };

  const typeList = (rows: { code: string; keys: string[] }[]) => (
    <ul className="mt-1 space-y-1">
      {rows.map((r) => (
        <li key={r.code} className="flex flex-wrap items-baseline justify-between gap-2 text-body text-fg">
          <span>
            {lintName(r.code)} · {r.keys.length} case{r.keys.length === 1 ? "" : "s"}
          </span>
          <Link href={listHref({ keys: r.keys.join(","), show_hidden: "1" })} className="font-medium text-navy-700 underline underline-offset-2">
            {lintTypeLinkLabel(r.code, r.keys.length)}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Test cases" value={active.length} href={listHref({})} />
        <StatTile label="Approved" value={approved} href={listHref({ status: "approved" })} />
        <StatTile label="Draft" value={drafts} href={listHref({ status: "draft" })} />
        <StatTile label="Open questions" value={oq} href={listHref({ oq: "1" })} />
        <StatTile label="Must fix" value={must} href={listHref({ checks: "must" })} />
      </div>
      <GateReviewPanel
        projectId={projectId}
        stage={stage}
        title="Gate 5 · Test case quality"
        assessment={`Based on ${reqVersion ? `Requirements v${reqVersion} (Gate 3)` : "the approved requirements"} and ${strategyVersion ? `Strategy v${strategyVersion} (Gate 4)` : "the approved strategy"}${designVersion ? ` · Design run ${designVersion}` : ""}`}
        checks={[]}
        groupedChecks={checks}
        blockedReason={n ? `Fix the ${n} item${n === 1 ? "" : "s"} under ‘Must fix before approval’ to approve.` : null}
        noPermission={
          <>
            You can review this gate, but approving needs gate-approval permission. Ask someone who can approve gates, or ask an owner or admin to give you that permission.
            {role === "member" || role === "admin" || role === "owner" ? <span className="mt-1 block">You can still approve individual test cases in the list.</span> : null}
          </>
        }
        recommendation={recommendation}
        changesSinceApproval={
          stage.gate?.changes_since_approval
            ? { count: stage.gate.changes_since_approval, compareHref: listHref({ changed: "1" }), compareLabel: "Compare with approved set", note: "Phase 4 will use the last approved set until Gate 5 is approved again." }
            : null
        }
        approveLabel="Approve test cases"
        approvedToast="Gate 5 approved."
        afterApproveCopy={
          <>
            <p>Test cases approved. The approved Test Case Specification and Traceability Matrix were saved. Automation starts in Phase 4.</p>
            <p className="mt-2 flex flex-wrap gap-3">
              <Link href={`${base}/traceability`} className="font-medium text-navy-700 underline underline-offset-2">
                Open traceability
              </Link>
              <Link href={`${base}/reports`} className="font-medium text-navy-700 underline underline-offset-2">
                Open reports
              </Link>
            </p>
          </>
        }
        afterRequestChanges={(comment) => (
          <div className="flex flex-wrap gap-2">
            {!readOnly && role !== "viewer" && (
              <button
                type="button"
                onClick={() => onRegenerateWithFeedback(comment)}
                className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay"
              >
                Regenerate with this feedback
              </button>
            )}
            <Link href={listHref({})} className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
              Edit test cases
            </Link>
          </div>
        )}
        confirmApprove={
          drafts > 0
            ? {
                title: `Approve with ${drafts} draft${drafts === 1 ? "" : "s"}?`,
                body: `Only the ${approved} approved case${approved === 1 ? "" : "s"} become${approved === 1 ? "s" : ""} the approved set. The ${drafts} draft${drafts === 1 ? " is" : "s are"} left out until you approve ${drafts === 1 ? "it" : "them"} and Gate 5 is approved again.`,
                confirmLabel: "Approve test cases",
                cancelLabel: "Review drafts",
                onCancel: () => router.push(listHref({ status: "draft" })),
              }
            : null
        }
        reportHref={`${base}/reports/test-case-spec`}
        reportLabel="View Test Case Specification"
        readOnly={readOnly}
        onDecided={onDecided}
      >
        {accepted.length > 0 && (
          <p className="text-body text-fg">
            <span className="font-semibold">Accepted risks ({accepted.length}):</span>{" "}
            {accepted.map((a, i) => (
              <span key={a.risk.key}>
                {i > 0 && "; "}
                {a.risk.key} {a.risk.label}
                {a.comment ? `: “${a.comment}”` : ""}
              </span>
            ))}
          </p>
        )}
        {(byType.must.length > 0 || byType.advice.length > 0) && (
          <Disclosure label="Quality checks by type" defaultOpen headingLevel={3}>
            <div className="mt-2 space-y-3">
              {byType.must.length > 0 && (
                <div>
                  <p className="text-body">
                    <SeverityText severity="must" />
                  </p>
                  {typeList(byType.must)}
                </div>
              )}
              {byType.advice.length > 0 && (
                <div>
                  <p className="text-body">
                    <SeverityText severity="advice" />
                  </p>
                  {typeList(byType.advice)}
                </div>
              )}
            </div>
          </Disclosure>
        )}
      </GateReviewPanel>
    </div>
  );
}
