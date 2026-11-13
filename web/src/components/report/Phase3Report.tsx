"use client";

import { Fragment } from "react";
import type { ReportSummary, RtmContent, TestCaseDetail, TestCaseSpecContent, TestDataItem } from "@/lib/contract";
import { fmtDate } from "@/lib/format";
import {
  AUTOMATION_TEXT,
  automationReasonText,
  CASE_STATUS_TEXT,
  KIND_TEXT,
  PRIORITY_ORDER,
  PRIORITY_TEXT,
  SAVED_LOGIN_TEXT,
  SIDE_EFFECT_TEXT,
  TECHNIQUES,
  caseLevelText,
  caseTypeText,
  coverageItemText,
  displayValue,
  isUndecided,
  lintName,
  openQuestionText,
  techniqueInfo,
} from "@/lib/testcases";
import { GAP_EMPTY, PHASE4_SR, coverageTiles } from "@/lib/traceability";
import { GeneratedByLabel, ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { BackwardMatrix, ForwardMatrix } from "@/components/traceability/Traceability";
import { ReportToc, type TocSection } from "./ReportDocument";

export const TCS_TOC: TocSection[] = [
  { id: "scope", n: "1", title: "Scope and method" },
  { id: "counts", n: "2", title: "Summary counts" },
  { id: "cases", n: "3", title: "Test cases" },
  { id: "open", n: "4", title: "Open questions" },
  { id: "not_designed", n: "5", title: "Not designed" },
  { id: "gate", n: "6", title: "Gate 5 record" },
  { id: "conditions", n: "A", title: "Conditions" },
  { id: "data", n: "B", title: "Test data" },
  { id: "glossary", n: "C", title: "Glossary" },
];

export const RTM_TOC: TocSection[] = [
  { id: "basis", n: "1", title: "Basis" },
  { id: "coverage", n: "2", title: "Coverage" },
  { id: "gaps", n: "3", title: "Gap lists" },
  { id: "forward", n: "4", title: "Forward matrix" },
  { id: "backward", n: "5", title: "Backward matrix" },
];

export const RTM_DISCLAIMER = "No tests have been run. Execution, script and defect columns are filled from Phase 4.";
export const UNLINKED_TEXT = "Not linked to a requirement";
export const TCS_DATA_NOTICE = "Synthetic data only. Saved logins are named, never shown.";

function H2({ id, n, children }: { id: string; n: string; children: React.ReactNode }) {
  return (
    <h2 id={`report-${id}`} className="scroll-mt-24 border-t border-line pt-8 text-h2 font-semibold text-fg-strong first:border-0 first:pt-0">
      <span className="mr-2 tabular-nums text-fg-muted">{n}</span>
      {children}
    </h2>
  );
}

function Dl({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-[12rem_minmax(0,1fr)]">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="font-medium text-fg-muted">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v || "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function dataText(d: TestDataItem): string {
  if (d.kind === "secret_ref") return `${d.secret_ref ?? d.name}: ${SAVED_LOGIN_TEXT}`;
  return `${d.key} ${d.name}: ${displayValue(d.value ?? "").text}`;
}

const keys = (refs: ({ key: string } | null)[] | null | undefined) => (refs ?? []).map((r) => r?.key).filter(Boolean).join(", ") || "—";

/** One case with every §7 field (P3 §15.2); stored content may lack optional lists, so every list is guarded. */
function CaseBlock({ c }: { c: TestCaseDetail }) {
  const t = techniqueInfo(c.technique);
  return (
    <article className="space-y-3 rounded-md border border-line p-4" aria-labelledby={`tcs-${c.key}`}>
      <h4 id={`tcs-${c.key}`} className="text-body font-semibold text-fg-strong">
        <span className="mr-2 font-mono">{c.key}</span>
        {c.title}
      </h4>
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <span>{CASE_STATUS_TEXT[c.status] ?? c.status}</span>
        <span>· Priority {PRIORITY_TEXT[c.priority] ?? c.priority}</span>
        <span>
          · {t.name} ({t.short})
        </span>
        {c.classification && <ProvenanceLabel provenance={c.classification} />}
      </p>
      <Dl
        rows={[
          ["Objective", c.objective],
          ["Type and level", `${caseTypeText(c.test_type ?? "")} · ${caseLevelText(c.test_level ?? "")}`],
          ["Preconditions", (c.preconditions ?? []).length ? <ul className="list-disc pl-5">{c.preconditions.map((x, i) => <li key={i}>{x}</li>)}</ul> : "None"],
          ["Requirements", keys(c.requirements)],
          ["Acceptance criteria", keys(c.acceptance_criteria)],
          ["Condition", c.condition?.key ?? "—"],
          ["Risks", keys(c.risks)],
          ["Side effects", (c.side_effects ?? []).map((s) => SIDE_EFFECT_TEXT[s] ?? s).join(", ") || "None"],
          ["Automation", c.automation_suitability?.value ? `${AUTOMATION_TEXT[c.automation_suitability.value] ?? c.automation_suitability.value}${c.automation_suitability.assessed ? ` (${c.automation_suitability.assessed})` : ""}${automationReasonText(c.automation_suitability.reason) ? `: ${automationReasonText(c.automation_suitability.reason)}` : ""}` : "—"],
          ["Execution status", "Not run"],
        ]}
      />
      {(c.steps ?? []).length > 0 && (
        <table className="w-full table-fixed border-collapse text-small">
          <caption className="sr-only">Steps for {c.key}</caption>
          <thead>
            <tr className="border-b border-line text-left text-fg-muted">
              <th scope="col" className="w-10 py-1 pr-2">
                #
              </th>
              <th scope="col" className="py-1 pr-2">
                Action and data
              </th>
              <th scope="col" className="py-1">
                Expected
              </th>
            </tr>
          </thead>
          <tbody>
            {c.steps.map((s, i) => (
              <tr key={s.n ?? i} className="border-b border-line align-top">
                <td className="py-1 pr-2 tabular-nums">{s.n ?? i + 1}</td>
                <td className="break-words py-1 pr-2">
                  {s.action}
                  {(s.data ?? []).length > 0 && <span className="block text-fg-muted">Data: {s.data.map((d) => d?.key ?? d?.label).filter(Boolean).join(", ")}</span>}
                </td>
                <td className="break-words py-1">{c.open_question && isUndecided(s.expected, c.open_question.message) ? openQuestionText(c.open_question.message) : s.expected || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dl
        rows={[
          ["Expected result", c.open_question ? openQuestionText(c.open_question.message) : c.expected_result],
          ["Why this case exists", c.design_basis ? [`${techniqueInfo(c.design_basis.technique).name}: ${coverageItemText(c.design_basis)}`.replace(/: $/, ""), c.design_basis.explanation].filter(Boolean).join(". ") : "—"],
          ["Test data", (c.test_data ?? []).map(dataText).join("; ") || "None"],
          ["Checks", (c.lint ?? []).map((l) => lintName(l.code)).join(", ") || "No issues"],
        ]}
      />
    </article>
  );
}

function sortByPriority(cases: TestCaseDetail[]): TestCaseDetail[] {
  return cases.filter(Boolean).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || String(a.key).localeCompare(String(b.key)));
}

/** A case linked to several requirements appears in each group; list it once. */
function uniqueCases(cases: (TestCaseDetail | null | undefined)[]): TestCaseDetail[] {
  const seen = new Set<string>();
  return cases.filter((c): c is TestCaseDetail => !!c && !seen.has(c.key) && !!seen.add(c.key));
}

function approvalLine(a: Record<string, unknown> | null | undefined): string {
  const ap = (a ?? {}) as { status?: string; approved_by?: { full_name?: string } | null; approved_at?: string | null; comment?: string | null };
  if (ap.status === "approved") return `Approved at Gate 5${ap.approved_by?.full_name ? ` by ${ap.approved_by.full_name}` : ""}${ap.approved_at ? `, ${fmtDate(ap.approved_at)}` : ""}${ap.comment ? `. Comment: ${ap.comment}` : "."}`;
  return "Not approved at Gate 5 yet.";
}

function TestCaseSpec({ c }: { c: TestCaseSpecContent }) {
  const groups = Object.entries(c.cases_by_feature ?? {});
  const open = uniqueCases(groups.flatMap(([, reqs]) => (reqs ?? []).flatMap((r) => r?.cases ?? []))).filter((x) => x?.open_question);
  const counts = c.counts;
  return (
    <>
      <p className="text-body text-fg">{c.summary}</p>
      <p className="text-small text-fg-muted">
        Summary: <GeneratedByLabel generatedBy={c.summary_generated_by === "ai" ? "ai" : "rules"} />
      </p>
      <H2 id="scope" n="1">
        Scope and method
      </H2>
      <ul className="list-disc space-y-1 pl-5 text-body text-fg">
        {(c.scope_and_method ?? []).map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      <Dl rows={(c.techniques ?? []).map((t) => [`${techniqueInfo(t.technique).name} (${t.conditions} conditions)`, t.definition || techniqueInfo(t.technique).definition] as [string, string])} />
      <H2 id="counts" n="2">
        Summary counts
      </H2>
      {counts ? (
        <Dl
          rows={[
            ["Test cases", String(counts.total ?? 0)],
            ["By status", Object.entries(counts.by_status ?? {}).map(([k, v]) => `${v} ${(CASE_STATUS_TEXT as Record<string, string>)[k]?.toLowerCase() ?? k}`).join(" · ")],
            ["By priority", Object.entries(counts.by_priority ?? {}).map(([k, v]) => `${v} ${(PRIORITY_TEXT as Record<string, string>)[k] ?? k}`).join(" · ")],
            ["By technique", Object.entries(counts.by_technique ?? {}).map(([k, v]) => `${v} ${techniqueInfo(k).short}`).join(" · ")],
            ["Open questions", String(counts.open_questions ?? 0)],
            ["Execution", counts.execution?.message ?? "Not run"],
          ]}
        />
      ) : (
        <p className="text-body text-fg-muted">No counts in this version.</p>
      )}
      <H2 id="cases" n="3">
        Test cases
      </H2>
      {groups.length === 0 && <p className="text-body text-fg-muted">No test cases in this version.</p>}
      {groups.map(([feature, reqs]) => (
        <section key={feature} className="space-y-3">
          <h3 className="text-h3 font-semibold text-fg-strong">{feature}</h3>
          {(reqs ?? []).map((r, i) => (
            <div key={r?.requirement?.key ?? `unlinked-${i}`} className="space-y-3">
              <p className="text-body font-semibold text-fg-strong">
                {r?.requirement ? (
                  <>
                    <span className="mr-2 font-mono">{r.requirement.key}</span>
                    {r.requirement.label}
                  </>
                ) : (
                  UNLINKED_TEXT
                )}
              </p>
              {sortByPriority(r?.cases ?? []).map((x) => (
                <CaseBlock key={x.key} c={x} />
              ))}
            </div>
          ))}
        </section>
      ))}
      <H2 id="open" n="4">
        Open questions
      </H2>
      {open.length === 0 ? (
        <p className="text-body text-fg-muted">None.</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-body text-fg">
          {open.map((x) => (
            <li key={x.key}>
              {x.key}: {x.open_question?.message}
            </li>
          ))}
        </ul>
      )}
      <H2 id="not_designed" n="5">
        Not designed
      </H2>
      {(c.not_designed ?? []).length === 0 ? <p className="text-body text-fg-muted">None.</p> : <Dl rows={c.not_designed.map((n) => [caseTypeText(n.test_type), n.reason] as [string, string])} />}
      <H2 id="gate" n="6">
        Gate 5 record
      </H2>
      <p className="text-body text-fg">{approvalLine(c.approval as Record<string, unknown>)}</p>
      <p className="text-body text-fg">{c.execution_note || "Execution status: Not run. Test execution arrives in Phase 4."}</p>
      <H2 id="conditions" n="A">
        Conditions
      </H2>
      {(c.conditions ?? []).length === 0 ? (
        <p className="text-body text-fg-muted">None.</p>
      ) : (
        <ul className="space-y-2 text-body">
          {c.conditions.map((x) => (
            <li key={x.key}>
              <span className="mr-2 font-mono">{x.key}</span>
              {x.title} · {techniqueInfo(x.technique).name} · requirements {keys(x.requirements)}
            </li>
          ))}
        </ul>
      )}
      <H2 id="data" n="B">
        Test data
      </H2>
      <p className="text-body font-medium text-fg">{TCS_DATA_NOTICE}</p>
      {(c.test_data ?? []).length === 0 ? (
        <p className="text-body text-fg-muted">None.</p>
      ) : (
        <ul className="space-y-1 text-body">
          {c.test_data.map((d) => (
            <li key={d.key} className="break-words">
              {KIND_TEXT[d.kind] ?? d.kind} · {dataText(d)}
            </li>
          ))}
        </ul>
      )}
      <H2 id="glossary" n="C">
        Glossary
      </H2>
      <Dl rows={Object.values(TECHNIQUES).map((t) => [`${t.short}: ${t.name}`, t.definition] as [string, string])} />
      {c.disclaimer && <p className="border-t border-line pt-4 text-small text-fg-muted">{c.disclaimer}</p>}
    </>
  );
}

function Rtm({ c, projectId }: { c: RtmContent; projectId: string }) {
  const tiles = c.coverage ? coverageTiles(c.coverage, () => "", () => "") : [];
  const g = c.gaps;
  const gapRows: [string, string[], string][] = g
    ? [
        ["Requirements without test cases", [...(g.requirements_without_test_cases?.none ?? []), ...(g.requirements_without_test_cases?.none_approved ?? [])].map((r) => r?.key ?? ""), GAP_EMPTY.none],
        ["Test cases without requirements", (g.test_cases_without_requirements ?? []).map((r) => r?.key ?? ""), GAP_EMPTY.orphans],
        ["Untested high-risk functionality", (g.untested_high_risk?.open ?? []).map((o) => o?.risk?.key ?? "").filter(Boolean), GAP_EMPTY.risks],
        ["Acceptance criteria without test cases", (g.acceptance_criteria_without_test_cases ?? []).map((r) => r?.key ?? ""), GAP_EMPTY.acs],
        ["Features without requirements", (g.features_without_requirements ?? []).map((r) => r?.key ?? ""), GAP_EMPTY.features],
      ]
    : [];
  return (
    <>
      <p className="text-body font-medium text-fg">{RTM_DISCLAIMER}</p>
      <H2 id="basis" n="1">
        Basis
      </H2>
      <Dl
        rows={[
          ["Gate 3 (requirements)", c.based_on?.G3 ?? "Not approved"],
          ["Gate 4 (strategy)", c.based_on?.G4 ?? "Not approved"],
          ["Gate 5 (test cases)", c.based_on?.G5 ?? "Not approved"],
        ]}
      />
      <H2 id="coverage" n="2">
        Coverage
      </H2>
      <Dl rows={tiles.map((t) => [t.label, t.unavailable ? `Not available · ${t.hint}` : `${t.value} · ${t.hint}`] as [string, string])} />
      <H2 id="gaps" n="3">
        Gap lists
      </H2>
      <Dl rows={gapRows.map(([label, all, empty]) => [label, all.filter(Boolean), empty] as const).map(([label, ks, empty]) => [`${label} (${ks.length})`, ks.length ? ks.join(", ") : empty] as [string, string])} />
      <Dl
        rows={[
          ["Requirements without execution evidence", `Not available, ${PHASE4_SR}`],
          ["Failed tests", `Not available, ${PHASE4_SR}`],
          ["Outdated automation scripts", `Not available, ${PHASE4_SR}`],
          ["Defects without regression coverage", `Not available, ${PHASE4_SR}`],
        ]}
      />
      <H2 id="forward" n="4">
        Forward matrix
      </H2>
      {(c.forward ?? []).length ? <ForwardMatrix rows={c.forward} projectId={projectId} regionLabel="Forward matrix, scrolls sideways" /> : <p className="text-body text-fg-muted">No rows.</p>}
      <H2 id="backward" n="5">
        Backward matrix
      </H2>
      {(c.backward ?? []).length ? <BackwardMatrix rows={c.backward} projectId={projectId} regionLabel="Backward matrix, scrolls sideways" /> : <p className="text-body text-fg-muted">No rows.</p>}
    </>
  );
}

/** In-app rendering of the Test Case Specification and the RTM (design P3 §15.2). Content comes from the API. */
export function Phase3ReportBody({ type, report, content, projectId }: { type: "test_case_spec" | "rtm"; report: ReportSummary; content: unknown; projectId: string }) {
  if (!content) return <p className="text-body text-fg-muted">This report has no in-app content. Download it as a PDF instead.</p>;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <ReportToc sections={type === "rtm" ? RTM_TOC : TCS_TOC} />
      </div>
      <article aria-label={`Report version ${report.version}`} className="min-w-0 space-y-4">
        {type === "test_case_spec" ? <TestCaseSpec c={content as TestCaseSpecContent} /> : <Rtm c={content as RtmContent} projectId={projectId} />}
      </article>
    </div>
  );
}
