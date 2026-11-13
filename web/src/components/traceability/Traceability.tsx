"use client";

import Link from "next/link";
import { useState } from "react";
import { Clock, TriangleAlert } from "lucide-react";
import type { ArtefactRef, BackwardRow, Coverage, ForwardRow, Gaps } from "@/lib/contract";
import { CASE_STATUS_TEXT, PRIORITY_TEXT, techniqueInfo } from "@/lib/testcases";
import { GAP_EMPTY, PHASE4_SR, PHASE4_TEXT, coverageTiles, gapCounts, keyHref } from "@/lib/traceability";
import { Card, Disclosure, StatTile, StatusPill } from "@/components/ui";

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
      <section aria-labelledby="needs-exec" className="space-y-2">
        <h3 id="needs-exec" className="text-body-lg font-semibold text-fg-strong">
          Needs test execution (Phase 4)
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
    </div>
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
  return (
    <>
      <div className="hidden rounded-lg border border-line bg-surface md:block">
        <div className="scrollbar-thin overflow-x-auto" role="region" aria-label={regionLabel} tabIndex={0}>
          <table className="min-w-full divide-y divide-line text-small">
            <caption className="px-3 py-2 text-left text-body font-semibold text-fg-strong">Forward traceability: requirements to test cases, {rows.length} requirements{more ? " on this page" : ""}</caption>
            <colgroup span={5} />
            <colgroup span={3} />
            <thead className="bg-elevated">
              <tr>
                <td colSpan={5} />
                <th scope="colgroup" colSpan={3} className="px-3 py-1.5 text-left text-caption font-semibold text-fg-muted">
                  Later phases · Not available until Phase 4
                </th>
              </tr>
              <tr>
                {["Requirement", "Risk", "Acceptance criteria", "Conditions", "Test cases", "Scripts", "Results", "Defects"].map((h) => (
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
                    <td className="px-3 py-2">
                      <Later />
                    </td>
                    <td className="px-3 py-2">
                      <Later />
                    </td>
                    <td className="px-3 py-2">
                      <Later />
                    </td>
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
              <p className="mt-2 text-small text-fg-muted">Scripts, results, defects: not available until Phase 4</p>
            </article>
          );
        })}
      </div>
    </>
  );
}

export function BackwardMatrix({ rows, projectId, more = false, regionLabel = "Traceability matrix, scrolls sideways" }: { rows: BackwardRow[]; projectId: string; more?: boolean; regionLabel?: string }) {
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
                {["Test case", "Status", "Priority", "Technique", "Conditions", "Acceptance criteria", "Requirements", "Risks"].map((h) => (
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
            <p className="mt-2 text-small text-fg-muted">Scripts, results, defects: not available until Phase 4</p>
          </article>
        ))}
      </div>
    </>
  );
}
