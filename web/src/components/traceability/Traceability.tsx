"use client";

import Link from "next/link";
import { useState } from "react";
import { Clock, TriangleAlert } from "lucide-react";
import type { ArtefactRef, BackwardRow, CaseExec, Coverage, ForwardRow, Gaps } from "@/lib/contract";
import { CASE_STATUS_TEXT, PRIORITY_TEXT, techniqueInfo } from "@/lib/testcases";
import { GAP_EMPTY, PHASE4_SR, PHASE4_TEXT, a11yCellText, changeCellText, changeLine, changeSr, coverageTiles, defectText, execLine, gapCounts, isAvailable, keyHref, perfCellText, resultText, scriptText, secCellText } from "@/lib/traceability";
import { Card, Disclosure, StatTile, StatusPill } from "@/components/ui";
import { ManualResultLabel } from "@/components/domain/ExecutionLabels";
import { NOT_ANALYSED, recordStartHref } from "@/lib/execution";

// ---- Coverage tiles and gap lists (§14.2) ---------------------------------------------------------------

export function CoverageTiles({ coverage, href, casesHref }: { coverage: Coverage; href: (q: Record<string, string>) => string; casesHref: (q: Record<string, string>) => string }) {
  const tiles = coverageTiles(coverage, href, casesHref);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <StatTile
          key={t.id}
          label={t.label}
          value={
            t.unavailable ? (
              <span className="inline-flex items-center gap-2 text-h2">
                <StatusPill status="not_available" label="Not available" />
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                {t.value}
                {t.warn && (
                  <>
                    <TriangleAlert className="h-5 w-5 text-warning-fg" aria-hidden />
                    <span className="sr-only">(needs attention)</span>
                  </>
                )}
              </span>
            )
          }
          hint={t.hint}
          href={t.href}
        />
      ))}
    </div>
  );
}

function RefList({ items, projectId, empty, more = 10, extra }: { items: ArtefactRef[]; projectId: string; empty: string; more?: number; extra?: (r: ArtefactRef) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="text-body text-fg-muted">{empty}</p>;
  const shown = all ? items : items.slice(0, more);
  return (
    <>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.key} className="text-body">
            <Link href={keyHref(projectId, r.key)} className="text-navy-700 underline underline-offset-2">
              <span className="font-mono">{r.key}</span> {r.label}
            </Link>
            {extra?.(r)}
          </li>
        ))}
      </ul>
      {items.length > more && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 text-small font-medium text-navy-700 underline underline-offset-2">
          Show all {items.length}
        </button>
      )}
    </>
  );
}

function GapCard({ id, title, count, children }: { id: string; title: string; count: number; children: React.ReactNode }) {
  return (
    <Card as="section" className="p-4">
      <div id={id} className="scroll-mt-24">
        <Disclosure label={`${title} (${count})`} defaultOpen={count > 0} headingLevel={3}>
          <div className="mt-2 space-y-3">{children}</div>
        </Disclosure>
      </div>
    </Card>
  );
}

export function GapLists({ gaps, projectId, canEdit }: { gaps: Gaps; projectId: string; canEdit: boolean }) {
  const n = gapCounts(gaps);
  const none = gaps.requirements_without_test_cases?.none ?? [];
  const noneApproved = gaps.requirements_without_test_cases?.none_approved ?? [];
  const open = gaps.untested_high_risk?.open ?? [];
  const accepted = gaps.untested_high_risk?.accepted ?? [];
  return (
    <div className="space-y-4">
      <h2 className="text-h3 font-semibold text-fg-strong">Gaps</h2>
      <GapCard id="gap-requirements" title="Requirements without test cases" count={n.requirements}>
        <div>
          <h4 className="text-body font-semibold text-fg-strong">No test case at all ({none.length})</h4>
          <RefList items={none} projectId={projectId} empty={GAP_EMPTY.none} />
        </div>
        <div>
          <h4 className="text-body font-semibold text-fg-strong">Test cases, but none approved ({noneApproved.length})</h4>
          <RefList items={noneApproved} projectId={projectId} empty={GAP_EMPTY.none_approved} />
        </div>
      </GapCard>
      <GapCard id="gap-orphans" title="Test cases without requirements" count={n.orphans}>
        <RefList
          items={gaps.test_cases_without_requirements ?? []}
          projectId={projectId}
          empty={GAP_EMPTY.orphans}
          extra={(r) =>
            canEdit ? (
              <Link href={`/projects/${projectId}/test-cases/${r.key}?edit=1`} className="ml-2 text-small font-medium text-navy-700 underline underline-offset-2">
                Link a requirement<span className="sr-only"> to {r.key}</span>
              </Link>
            ) : null
          }
        />
      </GapCard>
      <GapCard id="gap-risks" title="Untested high-risk functionality" count={n.risks}>
        {open.length === 0 ? (
          <p className="text-body text-fg-muted">{GAP_EMPTY.risks}</p>
        ) : (
          <ul className="space-y-1">
            {open.map((o) => (
              <li key={o.risk.key} className="text-body">
                <Link href={keyHref(projectId, o.risk.key)} className="text-navy-700 underline underline-offset-2">
                  <span className="font-mono">{o.risk.key}</span>
                </Link>{" "}
                ({o.risk.label}) · {(o.requirements ?? []).map((r) => r.key).join(", ") || "requirement"} not covered
              </li>
            ))}
          </ul>
        )}
        {accepted.length > 0 && (
          <div>
            <h4 className="text-body font-semibold text-fg-strong">Accepted, not tested ({accepted.length})</h4>
            <ul className="space-y-1">
              {accepted.map((a) => (
                <li key={a.risk.key} className="text-body">
                  <span className="font-mono">{a.risk.key}</span> {a.risk.label}
                  {a.comment ? `: “${a.comment}”` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </GapCard>
      <GapCard id="gap-acceptance-criteria" title="Acceptance criteria without test cases" count={n.acs}>
        <RefList items={gaps.acceptance_criteria_without_test_cases ?? []} projectId={projectId} empty={GAP_EMPTY.acs} />
      </GapCard>
      <GapCard id="gap-features" title="Features without requirements" count={n.features}>
        <RefList items={gaps.features_without_requirements ?? []} projectId={projectId} empty={GAP_EMPTY.features} />
      </GapCard>
      <ExecutionGaps gaps={gaps} projectId={projectId} canEdit={canEdit} />
      {gaps.pages_not_checked_for_accessibility !== undefined && <NonFunctionalGaps gaps={gaps} projectId={projectId} canEdit={canEdit} />}
    </div>
  );
}

/** The three non-functional gap lists (design P5 §12.1); their counts equal the coverage `non_functional` counts. */
function NonFunctionalGaps({ gaps, projectId, canEdit }: { gaps: Gaps; projectId: string; canEdit: boolean }) {
  const n = gapCounts(gaps);
  const open = gaps.requirements_with_open_accessibility_findings ?? [];
  const without = gaps.non_functional_requirements_without_evidence ?? [];
  const nf = `/projects/${projectId}/non-functional`;
  return (
    <>
      <GapCard id="gap-nf-open" title="Requirements with open accessibility findings" count={n.nf_open}>
        {open.length === 0 ? (
          <p className="text-body text-fg-muted">{GAP_EMPTY.nf_open}</p>
        ) : (
          <ul className="space-y-1">
            {open.map((o) => (
              <li key={o.requirement.key} className="text-body">
                <Trace projectId={projectId} k={o.requirement.key} /> {o.requirement.label} · {a11yCellText(o)} in{" "}
                <Link href={keyHref(projectId, o.scan_key)} className="font-mono text-navy-700 underline underline-offset-2">
                  {o.scan_key}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </GapCard>
      <GapCard id="gap-nf-pages" title="Pages not checked for accessibility" count={n.nf_pages}>
        {(gaps.pages_not_checked_for_accessibility ?? []).length === 0 ? (
          <p className="text-body text-fg-muted">{GAP_EMPTY.nf_pages}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {(gaps.pages_not_checked_for_accessibility ?? []).slice(0, 20).map((pg) => (
                <li key={pg.key} className="break-words font-mono text-body">
                  {pg.key}
                </li>
              ))}
            </ul>
            {canEdit && (
              <Link href={`${nf}?tab=accessibility`} className="text-small font-medium text-navy-700 underline underline-offset-2">
                Check accessibility…
              </Link>
            )}
          </>
        )}
      </GapCard>
      <GapCard id="gap-nf-without" title="Non-functional requirements without evidence" count={n.nf_without}>
        {without.length === 0 ? (
          <p className="text-body text-fg-muted">{GAP_EMPTY.nf_without}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {without.map((w) => (
                <li key={w.requirement.key} className="text-body">
                  <Trace projectId={projectId} k={w.requirement.key} /> {w.requirement.label} · {w.category}
                </li>
              ))}
            </ul>
            <Link href={nf} className="text-small font-medium text-navy-700 underline underline-offset-2">
              Open Non-functional
            </Link>
          </>
        )}
      </GapCard>
    </>
  );
}

function NfCell({ text, sr, href }: { text: string; sr: string; href?: string }) {
  if (text === "Not checked") return <span className="text-fg-muted">Not checked</span>;
  const body = (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{sr}</span>
    </>
  );
  return href ? (
    <Link href={href} className="whitespace-nowrap text-navy-700 underline underline-offset-2">
      {body}
    </Link>
  ) : (
    <span className="whitespace-nowrap">{body}</span>
  );
}

function nfCells(r: ForwardRow, projectId: string) {
  const k = r.requirement.key;
  const a = r.accessibility;
  const sc = r.security;
  const pf = r.performance;
  const crit = a?.by_severity.critical ?? 0;
  return {
    a11y: <NfCell text={a11yCellText(a)} href={a ? keyHref(projectId, a.scan_key) : undefined} sr={a ? `Accessibility for ${k}: ${a.open} open finding${a.open === 1 ? "" : "s"}${crit ? `, ${crit} critical` : ""}` : ""} />,
    sec: <NfCell text={secCellText(sc)} href={sc ? keyHref(projectId, sc.scan_key) : undefined} sr={sc ? `Security for ${k}: ${sc.open} open finding${sc.open === 1 ? "" : "s"}` : ""} />,
    perf: <NfCell text={perfCellText(pf)} href={pf ? keyHref(projectId, pf.last_run) : undefined} sr={pf ? `Performance for ${k}: ${pf.thresholds_failed ? `missed ${pf.thresholds_failed} of ${pf.thresholds} thresholds in ${pf.last_run}` : `all ${pf.thresholds} thresholds met`}` : ""} />,
  };
}

/** The 375 px card's last line (design P5 §12.1): "Accessibility 2 open · Performance ✗ Missed". */
function nfLine(r: ForwardRow): string {
  const parts = [
    r.accessibility ? `Accessibility ${a11yCellText(r.accessibility)}` : null,
    r.security ? `Security ${secCellText(r.security)}` : null,
    r.performance ? `Performance ${r.performance.thresholds_failed ? "✗ Missed" : "✓ Met"}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** The four Phase 4 gap lists (design P4 §12) plus the flaky sub-list; before Phase 4 content, one "Needs test
 * execution" note. */
function ExecutionGaps({ gaps, projectId, canEdit }: { gaps: Gaps; projectId: string; canEdit: boolean }) {
  const ev = gaps.requirements_without_execution_evidence;
  if (!isAvailable(ev) || !isAvailable(gaps.failed_tests) || !isAvailable(gaps.outdated_automation_scripts) || !isAvailable(gaps.defects_without_regression_coverage))
    return (
      <section aria-labelledby="needs-exec" className="space-y-2">
        <h3 id="needs-exec" className="text-body-lg font-semibold text-fg-strong">
          Needs test execution
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {["Requirements without execution evidence", "Failed tests", "Outdated automation scripts", "Defects without regression coverage"].map((t) => (
            <Card key={t} className="p-4">
              <p className="flex items-center gap-2 text-body font-semibold text-fg-strong">
                <Clock className="h-4 w-4 text-fg-muted" aria-hidden />
                {t}
              </p>
              <p className="mt-1 text-small text-fg-muted">{PHASE4_TEXT}.</p>
            </Card>
          ))}
        </div>
      </section>
    );
  const n = gapCounts(gaps);
  const flaky = gaps.flaky_tests ?? [];
  const failedRow = (x: (typeof gaps.failed_tests extends infer T ? (T extends (infer U)[] ? U : never) : never)) => (
    <li key={x.result_key} className="flex flex-wrap items-center gap-x-2 text-body">
      <Link href={keyHref(projectId, x.case.key)} className="font-mono text-navy-700 underline underline-offset-2">
        {x.case.key}
      </Link>
      {x.manual ? (
        <>
          <span>{x.status === "error" ? "Error" : "Failed"}</span>
          <ManualResultLabel name={x.recorded_by} />
          <span className="text-small text-fg-muted">{x.label ?? NOT_ANALYSED}</span>
        </>
      ) : (
        <>
          <span>{x.label ?? (x.status === "flaky" ? "Flaky" : x.status === "error" ? "Error" : "Failed")}</span>
          {x.classification && <span className="text-small text-fg-muted">(Hypothesis)</span>}
        </>
      )}
      <Link href={keyHref(projectId, x.result_key)} className="text-small font-medium text-navy-700 underline underline-offset-2">
        {x.run_key}
        <span className="sr-only"> result {x.result_key}</span>
      </Link>
    </li>
  );
  return (
    <>
      <GapCard id="gap-execution" title="Requirements without execution evidence" count={n.execution}>
        {!ev.executed && <p className="text-body text-fg-muted">No test has run yet.</p>}
        <div>
          <h4 className="text-body font-semibold text-fg-strong">Automated but not run ({ev.automated_not_run.length})</h4>
          <RefList items={ev.automated_not_run} projectId={projectId} empty="None." />
        </div>
        <div>
          <h4 className="text-body font-semibold text-fg-strong">Manual only, no recorded result ({ev.manual_only.length})</h4>
          {canEdit && ev.manual_only.length > 0 && (
            <Link href={recordStartHref(projectId)} className="inline-flex min-h-6 items-center text-small font-medium text-navy-700 underline underline-offset-2">
              Record manual results
            </Link>
          )}
          <RefList items={ev.manual_only} projectId={projectId} empty="None." />
        </div>
        {n.execution === 0 && ev.executed && <p className="text-body text-fg-muted">{GAP_EMPTY.execution}</p>}
      </GapCard>
      <GapCard id="gap-failed" title="Failed tests" count={n.failed}>
        {gaps.failed_tests.length ? <ul className="space-y-1">{gaps.failed_tests.map(failedRow)}</ul> : <p className="text-body text-fg-muted">{GAP_EMPTY.failed}</p>}
        <div>
          <h4 className="text-body font-semibold text-fg-strong">Flaky tests ({flaky.length})</h4>
          <p className="text-small text-fg-muted">Passed only on retry. Counted separately, never as passed.</p>
          {flaky.length ? <ul className="mt-1 space-y-1">{flaky.map(failedRow)}</ul> : <p className="text-body text-fg-muted">{GAP_EMPTY.flaky}</p>}
        </div>
      </GapCard>
      {gaps.scripts_outdated ? (
        <ChangeGaps gaps={gaps} projectId={projectId} canEdit={canEdit} />
      ) : (
      <GapCard id="gap-outdated" title="Outdated automation scripts" count={n.outdated}>
        {gaps.outdated_automation_scripts.length ? (
          <>
            <ul className="space-y-1">
              {gaps.outdated_automation_scripts.map((x) => (
                <li key={x.case.key} className="text-body">
                  <span className="font-mono">{x.file}</span> v{x.version} ·{" "}
                  <Link href={keyHref(projectId, x.case.key)} className="text-navy-700 underline underline-offset-2">
                    {x.case.key}
                  </Link>
                </li>
              ))}
            </ul>
            {canEdit && (
              <Link href={`/projects/${projectId}/automation`} className="text-small font-medium text-navy-700 underline underline-offset-2">
                Regenerate scripts…
              </Link>
            )}
          </>
        ) : (
          <p className="text-body text-fg-muted">{GAP_EMPTY.outdated}</p>
        )}
      </GapCard>
      )}
      <GapCard id="gap-regression" title="Defects without regression coverage" count={n.regression}>
        {gaps.defects_without_regression_coverage.length ? (
          <ul className="space-y-1">
            {gaps.defects_without_regression_coverage.map((x) => (
              <li key={`${x.defect.key}-${x.case?.key ?? ""}`} className="flex flex-wrap items-center gap-x-2 text-body">
                <Link href={keyHref(projectId, x.defect.key)} className="font-mono text-navy-700 underline underline-offset-2">
                  {x.defect.key}
                </Link>
                <span>{defectText(x.defect).replace(`${x.defect.key} `, "")}</span>
                {x.case && (
                  <Link href={keyHref(projectId, x.case.key)} className="text-small font-medium text-navy-700 underline underline-offset-2">
                    Open {x.case.key}
                    <span className="sr-only"> to add it to Regression</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">{GAP_EMPTY.regression}</p>
        )}
      </GapCard>
    </>
  );
}

/** Phase 6 gap lists (design P6 §12.1); counts equal the coverage `changes` tiles. */
function ChangeGaps({ gaps, projectId, canEdit }: { gaps: Gaps; projectId: string; canEdit: boolean }) {
  const outdated = gaps.scripts_outdated ?? [];
  const impacted = gaps.impacted_not_rerun ?? [];
  const pages = gaps.new_pages_without_requirements ?? [];
  const link = "text-small font-medium text-navy-700 underline underline-offset-2";
  return (
    <>
      <GapCard id="gap-outdated" title="Scripts that are outdated" count={outdated.length}>
        {outdated.length ? (
          <ul className="space-y-1">
            {outdated.map((x) => (
              <li key={x.case.key} className="flex flex-wrap items-baseline gap-x-2 text-body">
                <span className="break-all font-mono">{x.path}</span>
                <span className="[overflow-wrap:anywhere]">· {x.reason || "Outdated"}</span>
                <Link href={keyHref(projectId, x.case.key)} className={link}>
                  {x.case.key}
                </Link>
                {x.heal_suggestions.map((h) => (
                  <Link key={h.key} href={h.path} className={link}>
                    Review {h.key}
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">{GAP_EMPTY.scripts_outdated}</p>
        )}
      </GapCard>
      <GapCard id="gap-impacted" title="Impacted tests not re-run" count={impacted.length}>
        {impacted.length ? (
          <ul className="space-y-1">
            {impacted.map((x) => (
              <li key={`${x.change_set.key}-${x.case.key}`} className="flex flex-wrap items-baseline gap-x-2 text-body">
                <Link href={keyHref(projectId, x.case.key)} className="font-mono text-navy-700 underline underline-offset-2">
                  {x.case.key}
                </Link>
                <span>
                  · {x.level} · {x.change_set.key}
                </span>
                <Link href={`/projects/${projectId}/discovery/changes/${x.change_set.key}?tab=regression`} className={link}>
                  Open regression run<span className="sr-only"> for {x.change_set.key}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">{GAP_EMPTY.impacted}</p>
        )}
      </GapCard>
      <GapCard id="gap-new-pages" title="New pages without requirements" count={pages.length}>
        {pages.length ? (
          <ul className="space-y-1">
            {pages.map((x) => (
              <li key={x.impact_item_id} className="flex flex-wrap items-baseline gap-x-2 text-body">
                <span className="[overflow-wrap:anywhere]">{x.label}</span>
                {canEdit && (
                  <Link href={`/projects/${projectId}/requirements/new?${new URLSearchParams({ from: x.change_set.key, page: x.page })}`} className={link} aria-label={`Write a requirement for ${x.page}`}>
                    Write a requirement
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">{GAP_EMPTY.new_pages}</p>
        )}
      </GapCard>
    </>
  );
}

// ---- Matrix (§14.3) ---------------------------------------------------------------------------------

function Later() {
  return (
    <span>
      <span aria-hidden>—</span>
      <span className="sr-only">{PHASE4_SR}</span>
    </span>
  );
}

function Chips({ children }: { children: React.ReactNode[] }) {
  return <ul className="flex flex-col gap-1">{children}</ul>;
}

function NoCase({ text = "No test case" }: { text?: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-warning-fg">
      {text} <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function Trace({ projectId, k }: { projectId: string; k: string }) {
  return (
    <Link href={`/projects/${projectId}/traceability/${k}`} className="font-mono text-navy-700 underline underline-offset-2" aria-label={`Trace ${k}`}>
      {k}
    </Link>
  );
}

/** Scripts · Results · Defects cells (design P4 §12): text, never colour alone; gaps read "No script" / "Not run". */
function ExecCells({ items, projectId, kind }: { items: ({ case: ArtefactRef } & Partial<CaseExec>)[]; projectId: string; kind: "script" | "result" | "defects" }) {
  if (!items.length) return <span className="text-fg-muted">None</span>;
  return (
    <Chips>
      {items.map((t) =>
        kind === "script" ? (
          <li key={t.case.key} className="whitespace-nowrap">
            {t.script ? scriptText(t.script) : <span className="text-fg-muted">No script</span>}
          </li>
        ) : kind === "result" ? (
          <li key={t.case.key} className="whitespace-nowrap">
            {t.result ? (
              <Link href={keyHref(projectId, t.result.result_key)} className="text-navy-700 underline underline-offset-2" aria-label={`Result for ${t.case.key}: ${t.result.status} in ${t.result.run_key}`}>
                {resultText(t.result)}
              </Link>
            ) : (
              <span className="text-fg-muted">Not run</span>
            )}
          </li>
        ) : (
          (t.defects ?? []).map((d) => (
            <li key={`${t.case.key}-${d.key}`} className="whitespace-nowrap">
              <Link href={keyHref(projectId, d.key)} className="text-navy-700 underline underline-offset-2">
                {defectText(d)}
              </Link>
            </li>
          ))
        ),
      )}
    </Chips>
  );
}

/** The Change column (design P6 §12.1): one line per case, text with a full sentence for screen readers. */
function ChangeCells({ items }: { items: ({ case: ArtefactRef } & Partial<CaseExec>)[] }) {
  if (!items.length) return <span className="text-fg-muted">None</span>;
  return (
    <Chips>
      {items.map((t) => (
        <li key={t.case.key} className="whitespace-nowrap">
          <span aria-hidden>
            {changeCellText(t.impacted)}
            {t.script?.state === "outdated" && " · ✗ Outdated"}
          </span>
          <span className="sr-only">{changeSr(t.case.key, t.impacted, t.script?.state)}</span>
        </li>
      ))}
    </Chips>
  );
}

function forwardCells(r: ForwardRow, projectId: string) {
  return {
    risk: r.risk ? (
      <span>
        {r.risk.level}{" "}
        {(r.risk.risks ?? []).map((x) => (
          <Trace key={x.key} projectId={projectId} k={x.key} />
        ))}
      </span>
    ) : (
      <span className="text-fg-muted">None</span>
    ),
    acs: (r.acceptance_criteria ?? []).length ? (
      <Chips>
        {r.acceptance_criteria.map((a) => (
          <li key={a.ac.key}>
            <Trace projectId={projectId} k={a.ac.key} /> {a.covered ? "covered" : <NoCase text="not covered" />}
          </li>
        ))}
      </Chips>
    ) : (
      <span className="text-fg-muted">None</span>
    ),
    conditions: (r.conditions ?? []).length ? (
      <Chips>
        {r.conditions.map((c) => (
          <li key={c.key}>
            <Trace projectId={projectId} k={c.key} /> {c.technique ? techniqueInfo(c.technique).short : ""}
          </li>
        ))}
      </Chips>
    ) : (
      <NoCase text="No condition" />
    ),
    cases: (r.test_cases ?? []).length ? (
      <Chips>
        {r.test_cases.map((t) => (
          <li key={t.case.key} className="whitespace-nowrap">
            <Link href={`/projects/${projectId}/traceability/${t.case.key}`} className="text-navy-700 underline underline-offset-2" aria-label={`Trace ${t.case.key}: test case, ${CASE_STATUS_TEXT[t.status]?.toLowerCase()}, priority ${t.priority}`}>
              <span className="font-mono">{t.case.key}</span> {CASE_STATUS_TEXT[t.status]} · {PRIORITY_TEXT[t.priority]}
            </Link>
          </li>
        ))}
      </Chips>
    ) : (
      <NoCase />
    ),
  };
}

export function ForwardMatrix({ rows, projectId, more = false, regionLabel = "Traceability matrix, scrolls sideways" }: { rows: ForwardRow[]; projectId: string; more?: boolean; regionLabel?: string }) {
  const phase4 = rows.some((r) => isAvailable(r.automation));
  const phase5 = rows.some((r) => "accessibility" in r);
  // Phase 6 (design P6 §12.1): "Change" after Scripts once rows carry the impact of a rescan.
  const phase6 = rows.some((r) => "impacted" in r);
  return (
    <>
      <div className="hidden rounded-lg border border-line bg-surface md:block">
        <div className="scrollbar-thin overflow-x-auto" role="region" aria-label={regionLabel} tabIndex={0}>
          <table className="min-w-full divide-y divide-line text-small">
            <caption className="px-3 py-2 text-left text-body font-semibold text-fg-strong">Forward traceability: requirements to test cases, {rows.length} requirements{more ? " on this page" : ""}</caption>
            <colgroup span={5} />
            <colgroup span={phase6 ? 4 : 3} />
            {phase5 && <colgroup span={3} />}
            <thead className="bg-elevated">
              <tr>
                <td colSpan={5} />
                <th scope="colgroup" colSpan={phase6 ? 4 : 3} className="px-3 py-1.5 text-left text-caption font-semibold text-fg-muted">
                  {phase4 ? "Execution" : "Execution · not recorded"}
                </th>
                {phase5 && (
                  <th scope="colgroup" colSpan={3} className="px-3 py-1.5 text-left text-caption font-semibold text-fg-muted">
                    Non-functional
                  </th>
                )}
              </tr>
              <tr>
                {["Requirement", "Risk", "Acceptance criteria", "Conditions", "Test cases", "Scripts", ...(phase6 ? ["Change"] : []), "Results", "Defects", ...(phase5 ? ["Accessibility", "Security", "Performance"] : [])].map((h) => (
                  <th key={h} scope="col" className={`whitespace-nowrap px-3 py-2 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted ${h === "Requirement" ? "sticky left-0 bg-elevated" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const c = forwardCells(r, projectId);
                return (
                  <tr key={r.requirement.key} className="align-top">
                    <th scope="row" className="sticky left-0 min-w-56 bg-surface px-3 py-2 text-left font-normal">
                      <Trace projectId={projectId} k={r.requirement.key} /> <span className="text-fg-strong">{r.requirement.label}</span>
                      <span className="block text-caption text-fg-muted">{r.requirement_status === "approved" ? "Approved" : r.requirement_status}</span>
                    </th>
                    <td className="px-3 py-2">{c.risk}</td>
                    <td className="px-3 py-2">{c.acs}</td>
                    <td className="px-3 py-2">{c.conditions}</td>
                    <td className="px-3 py-2">{c.cases}</td>
                    {phase4 ? (
                      <>
                        <td className="px-3 py-2">
                          <ExecCells items={r.test_cases ?? []} projectId={projectId} kind="script" />
                        </td>
                        {phase6 && (
                          <td className="px-3 py-2">
                            <ChangeCells items={r.test_cases ?? []} />
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <ExecCells items={r.test_cases ?? []} projectId={projectId} kind="result" />
                        </td>
                        <td className="px-3 py-2">
                          {(r.test_cases ?? []).some((t) => (t.defects ?? []).length) ? <ExecCells items={r.test_cases ?? []} projectId={projectId} kind="defects" /> : <span className="text-fg-muted">None</span>}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2">
                          <Later />
                        </td>
                        {phase6 && (
                          <td className="px-3 py-2">
                            <ChangeCells items={r.test_cases ?? []} />
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <Later />
                        </td>
                        <td className="px-3 py-2">
                          <Later />
                        </td>
                      </>
                    )}
                    {phase5 &&
                      (() => {
                        const nfc = nfCells(r, projectId);
                        return (
                          <>
                            <td className="px-3 py-2">{nfc.a11y}</td>
                            <td className="px-3 py-2">{nfc.sec}</td>
                            <td className="px-3 py-2">{nfc.perf}</td>
                          </>
                        );
                      })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="space-y-3 md:hidden">
        {rows.map((r) => {
          const c = forwardCells(r, projectId);
          return (
            <article key={r.requirement.key} className="rounded-lg border border-line bg-surface p-3">
              <h3 className="break-words text-body font-semibold text-fg-strong">
                {r.requirement.key} · {r.requirement.label}
              </h3>
              <p className="text-small text-fg-muted">{r.requirement_status === "approved" ? "Approved" : r.requirement_status}</p>
              <dl className="mt-2 space-y-1.5 text-small">
                <div>
                  <dt className="font-medium text-fg-muted">Risk</dt>
                  <dd>{c.risk}</dd>
                </div>
                <div>
                  <dt className="font-medium text-fg-muted">Acceptance criteria</dt>
                  <dd>{c.acs}</dd>
                </div>
                <div>
                  <dt className="font-medium text-fg-muted">Conditions</dt>
                  <dd>{c.conditions}</dd>
                </div>
                <div>
                  <dt className="font-medium text-fg-muted">Test cases</dt>
                  <dd>{c.cases}</dd>
                </div>
              </dl>
              {phase4 ? (
                <ul className="mt-2 space-y-0.5 text-small text-fg">
                  {(r.test_cases ?? []).map((t) => (
                    <li key={t.case.key}>
                      <span className="font-mono">{t.case.key}</span>: {execLine(t)}
                      {changeLine(t) && <span className="block">{changeLine(t)}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-small text-fg-muted">Scripts, results, defects: not recorded in this version</p>
              )}
              {phase5 && nfLine(r) && <p className="mt-1 text-small text-fg">{nfLine(r)}</p>}
            </article>
          );
        })}
      </div>
    </>
  );
}

export function BackwardMatrix({ rows, projectId, more = false, regionLabel = "Traceability matrix, scrolls sideways" }: { rows: BackwardRow[]; projectId: string; more?: boolean; regionLabel?: string }) {
  const phase4 = rows.some((r) => r.script !== undefined);
  const refs = (l: ArtefactRef[] | undefined, empty: React.ReactNode) =>
    (l ?? []).length ? (
      <Chips>
        {l!.map((x) => (
          <li key={x.key}>
            <Trace projectId={projectId} k={x.key} />
          </li>
        ))}
      </Chips>
    ) : (
      empty
    );
  return (
    <>
      <div className="hidden rounded-lg border border-line bg-surface md:block">
        <div className="scrollbar-thin overflow-x-auto" role="region" aria-label={regionLabel} tabIndex={0}>
          <table className="min-w-full divide-y divide-line text-small">
            <caption className="px-3 py-2 text-left text-body font-semibold text-fg-strong">Backward traceability: test cases to requirements, {rows.length} test cases{more ? " on this page" : ""}</caption>
            <thead className="bg-elevated">
              <tr>
                {["Test case", "Status", "Priority", "Technique", "Conditions", "Acceptance criteria", "Requirements", "Risks", ...(phase4 ? ["Script", "Last result", "Defects"] : [])].map((h) => (
                  <th key={h} scope="col" className={`whitespace-nowrap px-3 py-2 text-left text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted ${h === "Test case" ? "sticky left-0 bg-elevated" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.test_case.key} className="align-top">
                  <th scope="row" className="sticky left-0 min-w-56 bg-surface px-3 py-2 text-left font-normal">
                    <Trace projectId={projectId} k={r.test_case.key} /> <span className="text-fg-strong">{r.test_case.label}</span>
                  </th>
                  <td className="px-3 py-2">{CASE_STATUS_TEXT[r.status] ?? r.status}</td>
                  <td className="px-3 py-2">{r.priority ? PRIORITY_TEXT[r.priority] : "—"}</td>
                  <td className="px-3 py-2">{r.technique ? techniqueInfo(r.technique).name : "—"}</td>
                  <td className="px-3 py-2">{refs(r.conditions, <span className="text-fg-muted">None</span>)}</td>
                  <td className="px-3 py-2">{refs(r.acceptance_criteria, <span className="text-fg-muted">None</span>)}</td>
                  <td className="px-3 py-2">{refs(r.requirements, <NoCase text="No requirement" />)}</td>
                  <td className="px-3 py-2">{refs(r.risks, <span className="text-fg-muted">None</span>)}</td>
                  {phase4 && (
                    <>
                      <td className="px-3 py-2">
                        <ExecCells items={[{ ...r, case: r.test_case }]} projectId={projectId} kind="script" />
                      </td>
                      <td className="px-3 py-2">
                        <ExecCells items={[{ ...r, case: r.test_case }]} projectId={projectId} kind="result" />
                      </td>
                      <td className="px-3 py-2">{(r.defects ?? []).length ? <ExecCells items={[{ ...r, case: r.test_case }]} projectId={projectId} kind="defects" /> : <span className="text-fg-muted">None</span>}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="space-y-3 md:hidden">
        {rows.map((r) => (
          <article key={r.test_case.key} className="rounded-lg border border-line bg-surface p-3">
            <h3 className="break-words text-body font-semibold text-fg-strong">
              {r.test_case.key} · {r.test_case.label}
            </h3>
            <p className="text-small text-fg-muted">
              {CASE_STATUS_TEXT[r.status] ?? r.status}
              {r.priority ? ` · ${PRIORITY_TEXT[r.priority]}` : ""}
            </p>
            <dl className="mt-2 space-y-1.5 text-small">
              <div>
                <dt className="font-medium text-fg-muted">Conditions</dt>
                <dd>{refs(r.conditions, <span className="text-fg-muted">None</span>)}</dd>
              </div>
              <div>
                <dt className="font-medium text-fg-muted">Requirements</dt>
                <dd>{refs(r.requirements, <NoCase text="No requirement" />)}</dd>
              </div>
              <div>
                <dt className="font-medium text-fg-muted">Risks</dt>
                <dd>{refs(r.risks, <span className="text-fg-muted">None</span>)}</dd>
              </div>
            </dl>
            {phase4 ? <p className="mt-2 text-small text-fg">{execLine(r)}</p> : <p className="mt-2 text-small text-fg-muted">Scripts, results, defects: not recorded in this version</p>}
          </article>
        ))}
      </div>
    </>
  );
}
