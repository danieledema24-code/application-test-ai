"use client";

import { Fragment } from "react";
import type { ReportSummary, RequirementsSpecContent, RequirementDetail, TestPlanReportContent, TestStrategyReportContent } from "@/lib/contract";
import { CATEGORY_TEXT, LABEL_TEXT, STATUS_TEXT, confidenceText } from "@/lib/requirements";
import { LEVEL_TEXT, TYPE_NAMES, impactText, likelihoodText } from "@/lib/strategy";
import type { ReportType } from "@/lib/reports";
import { fmtDate } from "@/lib/format";
import { GeneratedByLabel, ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { RiskMatrix } from "@/components/strategy/Risks";
import { DerivedValue } from "@/components/strategy/TestPlan";
import { ReportToc, type TocSection } from "./ReportDocument";

export const REQ_SPEC_TOC: TocSection[] = [
  { id: "intro", n: "1", title: "Introduction & scope" },
  { id: "sources", n: "2", title: "Sources" },
  { id: "labels", n: "3", title: "Labels & confidence" },
  { id: "summary", n: "4", title: "Summary" },
  { id: "functional", n: "5", title: "Functional requirements" },
  { id: "non_functional", n: "6", title: "Non-functional requirements" },
  { id: "open", n: "7", title: "Open items" },
  { id: "readiness", n: "8", title: "Definition of Ready & Done" },
  { id: "rejected", n: "A", title: "Rejected requirements" },
];

export const STRATEGY_REPORT_TOC: TocSection[] = [
  { id: "summary", n: "1", title: "Summary" },
  { id: "scope", n: "2", title: "Scope" },
  { id: "levels", n: "3", title: "Test levels" },
  { id: "types", n: "4", title: "Test types" },
  { id: "risks", n: "5", title: "Risk register" },
  { id: "criteria", n: "6", title: "Entry & exit criteria" },
  { id: "approval", n: "7", title: "Tests that need separate approval" },
];

export const PLAN_REPORT_TOC: TocSection[] = [
  { id: "intro", n: "1", title: "Introduction" },
  { id: "items", n: "2", title: "Test items" },
  { id: "scope", n: "3", title: "Scope" },
  { id: "approach", n: "4", title: "Approach" },
  { id: "env", n: "5", title: "Environments & test data" },
  { id: "criteria", n: "6", title: "Entry & exit criteria" },
  { id: "suspension", n: "7", title: "Suspension & resumption" },
  { id: "deliverables", n: "8", title: "Deliverables" },
  { id: "roles", n: "9", title: "Roles" },
  { id: "schedule", n: "10", title: "Schedule" },
  { id: "risks", n: "11", title: "Risks & contingencies" },
];

function H2({ id, n, children }: { id: string; n: string; children: React.ReactNode }) {
  return (
    <h2 id={`report-${id}`} className="scroll-mt-24 border-t border-line pt-8 text-h2 font-semibold text-fg-strong first:border-0 first:pt-0">
      <span className="mr-2 tabular-nums text-fg-muted">{n}</span>
      {children}
    </h2>
  );
}

const List = ({ items }: { items: string[] }) =>
  items.length ? (
    <ul className="list-disc space-y-1 pl-5 text-body text-fg">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  ) : (
    <p className="text-body text-fg-muted">None.</p>
  );

function Req({ r }: { r: RequirementDetail }) {
  // Stored report content drops signed evidence links, so these lists may be missing (BUG-P2-06).
  const opt = r as Partial<RequirementDetail>;
  const evidence = opt.evidence ?? [];
  return (
    <article className="space-y-1.5 rounded-md border border-line p-4">
      <h4 className="text-body font-semibold text-fg-strong">
        <span className="mr-2 font-mono">{r.key}</span>
        {r.title}
      </h4>
      <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <ProvenanceLabel provenance={r.classification} confidence={r.confidence} /> {confidenceText(r.confidence)} · {CATEGORY_TEXT[r.category]} · {r.source} · {STATUS_TEXT[r.status]}
      </p>
      {r.description && <p className="text-body text-fg">{r.description}</p>}
      {(opt.assumptions ?? []).length > 0 && <p className="text-small text-fg">Assumptions: {r.assumptions.join("; ")}</p>}
      {(opt.acceptance_criteria ?? []).length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-small text-fg">
          {r.acceptance_criteria
            .filter((a) => a.status !== "rejected")
            .map((a) => (
              <li key={a.id}>
                <strong>Given</strong> {a.given} <strong>When</strong> {a.when} <strong>Then</strong> {a.then}
              </li>
            ))}
        </ol>
      )}
      {(opt.related_features ?? []).length > 0 && <p className="text-small text-fg-muted">Features: {r.related_features.map((f) => f.label || f.key).join(", ")}</p>}
      {evidence.length > 0 && <p className="text-small text-fg-muted">Evidence items: {evidence.length}</p>}
      <p className="text-small text-fg-muted">Linked test cases: None yet (test design is Phase 3)</p>
    </article>
  );
}

function RequirementsSpec({ c }: { c: RequirementsSpecContent }) {
  const all = Object.values(c.requirements_by_category)
    .flat()
    .map((x) => x.requirement);
  const live = all.filter((r) => r.status !== "rejected");
  const group = (type: "functional" | "non_functional") => {
    const rows = live.filter((r) => r.type === type);
    if (!rows.length) return <p className="text-body text-fg-muted">None.</p>;
    const byCat = new Map<string, RequirementDetail[]>();
    for (const r of rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
    return [...byCat.entries()].map(([cat, rs]) => (
      <section key={cat} className="space-y-2">
        <h3 className="text-h3 font-semibold text-fg-strong">{CATEGORY_TEXT[cat as keyof typeof CATEGORY_TEXT] ?? cat}</h3>
        {rs.map((r) => (
          <Req key={r.id} r={r} />
        ))}
      </section>
    ));
  };
  const open = live.filter((r) => r.status === "draft" || r.status === "needs_info");
  return (
    <>
      <H2 id="intro" n="1">
        Introduction & scope
      </H2>
      <p className="flex flex-wrap items-center gap-2 text-body text-fg">
        {c.summary} <GeneratedByLabel generatedBy={c.summary_generated_by} />
      </p>
      <List items={c.scope_and_method} />
      <H2 id="sources" n="2">
        Sources
      </H2>
      <List
        items={(c.source_documents ?? []).map(
          (d) => `${d.title || d.filename}${d.created_at ? ` · uploaded ${fmtDate(d.created_at)}` : ""}${d.status === "withdrawn" ? " · removed from sources" : ""}`,
        )}
      />
      <H2 id="labels" n="3">
        Labels & confidence
      </H2>
      <dl className="space-y-1 text-body">
        {Object.entries(c.classification_legend).map(([k, v]) => (
          <div key={k}>
            <dt className="inline font-semibold text-fg-strong">{LABEL_TEXT[k as keyof typeof LABEL_TEXT] ?? k}: </dt>
            <dd className="inline text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-small text-fg-muted">Confidence: High 80–100%, Medium 50–79%, Low below 50%.</p>
      <H2 id="summary" n="4">
        Summary
      </H2>
      <table className="text-small">
        <caption className="sr-only">Requirement counts</caption>
        <tbody className="divide-y divide-line">
          <tr>
            <th scope="row" className="py-1 pr-6 text-left font-medium text-fg-strong">
              Total
            </th>
            <td className="tabular-nums">{c.counts.total}</td>
          </tr>
          {Object.entries(c.counts.by_status).map(([k, v]) => (
            <tr key={k}>
              <th scope="row" className="py-1 pr-6 text-left font-medium text-fg-strong">
                {STATUS_TEXT[k as keyof typeof STATUS_TEXT] ?? k}
              </th>
              <td className="tabular-nums">{v}</td>
            </tr>
          ))}
          {Object.entries(c.counts.by_classification).map(([k, v]) => (
            <tr key={k}>
              <th scope="row" className="py-1 pr-6 text-left font-medium text-fg-strong">
                {LABEL_TEXT[k as keyof typeof LABEL_TEXT] ?? k}
              </th>
              <td className="tabular-nums">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <H2 id="functional" n="5">
        Functional requirements
      </H2>
      {group("functional")}
      <H2 id="non_functional" n="6">
        Non-functional requirements
      </H2>
      {group("non_functional")}
      <H2 id="open" n="7">
        Open items
      </H2>
      <List items={[...open.map((r) => `${r.key} ${r.title} · ${STATUS_TEXT[r.status]}`), ...c.open_questions.filter((q) => !open.some((r) => r.key === q.key)).map((q) => `${q.key} ${q.label}`)]} />
      <H2 id="readiness" n="8">
        Definition of Ready & Done
      </H2>
      <h3 className="text-h3 font-semibold text-fg-strong">Definition of Ready</h3>
      <List items={c.readiness.definition_of_ready.filter((x) => x.status === "active").map((x) => x.text)} />
      <h3 className="text-h3 font-semibold text-fg-strong">Definition of Done</h3>
      <List items={c.readiness.definition_of_done.filter((x) => x.status === "active").map((x) => x.text)} />
      <H2 id="rejected" n="A">
        Rejected requirements
      </H2>
      <List items={all.filter((r) => r.status === "rejected").map((r) => `${r.key} ${r.title}${r.status_comment ? ` · ${r.status_comment}` : ""}`)} />
      <h2 className="sr-only">Limitations</h2>
      <List items={c.limitations} />
      <p className="border-t border-line pt-4 text-small text-fg-muted">{c.disclaimer}</p>
    </>
  );
}

function StrategyReport({ c }: { c: TestStrategyReportContent }) {
  const s = c.strategy.sections;
  const approval = s.test_types.filter((t) => t.in_scope && t.requires_approval);
  return (
    <>
      <H2 id="summary" n="1">
        Summary
      </H2>
      <p className="flex flex-wrap items-center gap-2 text-body text-fg">
        {c.summary} <GeneratedByLabel generatedBy={c.summary_generated_by} />
      </p>
      <H2 id="scope" n="2">
        Scope
      </H2>
      <h3 className="text-h3 font-semibold text-fg-strong">In scope</h3>
      <List items={s.scope_in.map((i) => i.text)} />
      <h3 className="text-h3 font-semibold text-fg-strong">Out of scope</h3>
      <List items={s.scope_out.map((i) => `${i.text}${i.rationale ? ` · ${i.rationale}` : ""}`)} />
      <H2 id="levels" n="3">
        Test levels
      </H2>
      <List items={s.test_levels.map((l) => `${l.level.replace(/_/g, " ")}: ${l.in_scope ? "In scope" : "Out of scope"} · ${l.rationale}`)} />
      <H2 id="types" n="4">
        Test types
      </H2>
      <List
        items={s.test_types.map(
          (t) => `${TYPE_NAMES[t.type]}: ${t.in_scope ? "In scope" : "Out of scope"}${t.in_scope && t.requires_approval ? " · Needs separate approval before running" : ""} · ${t.rationale}`,
        )}
      />
      <H2 id="risks" n="5">
        Risk register
      </H2>
      <RiskMatrix matrix={c.risk_matrix} risks={c.risks} selected={null} onSelect={() => undefined} />
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <caption className="sr-only">Risks</caption>
          <thead>
            <tr className="text-left text-caption uppercase text-fg-muted">
              <th scope="col" className="py-1 pr-3">
                ID
              </th>
              <th scope="col" className="py-1 pr-3">
                Risk
              </th>
              <th scope="col" className="py-1 pr-3">
                Likelihood
              </th>
              <th scope="col" className="py-1 pr-3">
                Impact
              </th>
              <th scope="col" className="py-1 pr-3">
                Score
              </th>
              <th scope="col" className="py-1">
                Mitigation
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {c.risks.map((r) => (
              <tr key={r.id}>
                <td className="py-1.5 pr-3 font-mono">{r.key}</td>
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                  {r.title}
                </th>
                <td className="py-1.5 pr-3">{likelihoodText(r.likelihood)}</td>
                <td className="py-1.5 pr-3">{impactText(r.impact)}</td>
                <td className="py-1.5 pr-3 tabular-nums">
                  {r.score} {LEVEL_TEXT[r.level]}
                </td>
                <td className="py-1.5">{r.mitigation.test_types.map((t) => TYPE_NAMES[t]).join(", ") || "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <H2 id="criteria" n="6">
        Entry & exit criteria
      </H2>
      <h3 className="text-h3 font-semibold text-fg-strong">Entry</h3>
      <List items={s.entry_criteria.map((i) => i.text)} />
      <h3 className="text-h3 font-semibold text-fg-strong">Exit</h3>
      <List items={s.exit_criteria.map((i) => i.text)} />
      <H2 id="approval" n="7">
        Tests that need separate approval
      </H2>
      <List items={approval.map((t) => TYPE_NAMES[t.type])} />
      <p className="text-small text-fg-muted">{c.approvals_note}</p>
    </>
  );
}

function PlanReport({ c }: { c: TestPlanReportContent }) {
  const s = c.plan.sections;
  const parts: [string, string, string, React.ReactNode][] = [
    [
      "intro",
      "1",
      "Introduction & objectives",
      <p key="i" className="whitespace-pre-wrap text-body text-fg">
        {s.introduction || "Not set."}
      </p>,
    ],
    ["items", "2", "Test items", <List key="t" items={s.test_items.map((t) => t.label || t.key)} />],
    ["scope", "3", "Scope", <DerivedValue key="s" value={s.scope} />],
    ["approach", "4", "Approach", <DerivedValue key="a" value={s.approach} />],
    ["env", "5", "Environments & test data", <DerivedValue key="e" value={s.environments_and_test_data} />],
    ["criteria", "6", "Entry & exit criteria", <DerivedValue key="c" value={s.entry_exit_criteria} />],
    ["suspension", "7", "Suspension & resumption", <List key="su" items={[...s.suspension_criteria.map((x) => `Suspend: ${x}`), ...s.resumption_requirements.map((x) => `Resume: ${x}`)]} />],
    ["deliverables", "8", "Deliverables", <List key="d" items={s.deliverables.map((d) => `${d.name} · ${d.exists ? "Available" : `Available from Phase ${d.available_from_phase}`}`)} />],
    ["roles", "9", "Roles & responsibilities", <List key="r" items={s.roles.map((r) => `${r.role}: ${r.responsibility}`)} />],
    [
      "schedule",
      "10",
      "Schedule & milestones",
      s.schedule.some((m) => m.target_date) ? (
        <List key="sc" items={s.schedule.map((m) => `${m.milestone} · ${m.target_date ?? "Not set."}`)} />
      ) : (
        <p key="sc" className="text-body text-fg-muted">
          Not set.
        </p>
      ),
    ],
    ["risks", "11", "Risks & contingencies", <List key="rk" items={s.risks_and_contingencies.map((r) => `${r.risk.key} ${r.risk.label} · ${r.contingency}`)} />],
  ];
  return (
    <>
      <p className="text-small text-fg-muted">Derived from Strategy v{c.strategy_version}</p>
      {parts.map(([id, n, title, body]) => (
        <Fragment key={id}>
          <H2 id={id} n={n}>
            {title}
          </H2>
          {body}
        </Fragment>
      ))}
    </>
  );
}

export function phase2Toc(type: ReportType): TocSection[] {
  return type === "requirements_spec" ? REQ_SPEC_TOC : type === "test_strategy" ? STRATEGY_REPORT_TOC : PLAN_REPORT_TOC;
}

/** In-app rendering of a Phase 2 report (design P2 §10.3). Content comes from the API; nothing is invented. */
export function Phase2ReportBody({ type, report, content }: { type: ReportType; report: ReportSummary; content: unknown }) {
  if (!content) return <p className="text-body text-fg-muted">This report has no in-app content. Download it as a PDF instead.</p>;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <ReportToc sections={phase2Toc(type)} />
      </div>
      <article aria-label={`Report version ${report.version}`} className="min-w-0 space-y-4">
        {type === "requirements_spec" && <RequirementsSpec c={content as RequirementsSpecContent} />}
        {type === "test_strategy" && <StrategyReport c={content as TestStrategyReportContent} />}
        {type === "test_plan" && <PlanReport c={content as TestPlanReportContent} />}
      </article>
    </div>
  );
}
