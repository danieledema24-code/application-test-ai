"use client";

import { useEffect, useState } from "react";
import type { DiscoveryReportContent, EvidenceRef, Feature, SitemapNode } from "@/lib/contract";
import { flattenSitemap, nodeStatus } from "@/lib/discovery";
import { fmtDateTime } from "@/lib/format";
import { pathOf } from "@/lib/url";
import { Disclosure } from "@/components/ui";
import { GeneratedByLabel, ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems, refsToItems } from "@/components/domain/EvidenceDrawer";
import { UI_ONLY_LIMITATION } from "@/components/discovery/DiscoverySummary";

export const REPORT_SECTIONS = [
  { id: "summary", n: "1", title: "Summary" },
  { id: "scope", n: "2", title: "Scope & approach" },
  { id: "sitemap", n: "3", title: "Sitemap" },
  { id: "functionality", n: "4", title: "Functionality" },
  { id: "journeys", n: "5", title: "User journeys" },
  { id: "responsive", n: "6", title: "Responsive" },
  { id: "gaps", n: "7", title: "Access gaps & limitations" },
  { id: "completeness", n: "8", title: "Completeness (Gate 2)" },
  { id: "evidence", n: "A", title: "Evidence index" },
  { id: "glossary", n: "B", title: "Labels & glossary" },
];

/** Table of contents: sticky nav at lg+, "Contents" disclosure below; highlights the section in view. */
export function ReportToc() {
  const [current, setCurrent] = useState(REPORT_SECTIONS[0].id);
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id.replace(/^report-/, ""));
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    for (const s of REPORT_SECTIONS) {
      const el = document.getElementById(`report-${s.id}`);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);
  const list = (
    <ol className="space-y-0.5 text-small">
      {REPORT_SECTIONS.map((s) => (
        <li key={s.id}>
          <a
            href={`#report-${s.id}`}
            aria-current={current === s.id ? "location" : undefined}
            className={`flex gap-2 rounded-md px-2 py-1.5 ${current === s.id ? "bg-accent-soft font-semibold text-fg-strong" : "text-fg-muted hover:bg-overlay hover:text-fg-strong"}`}
          >
            <span className="w-4 tabular-nums">{s.n}</span>
            {s.title}
          </a>
        </li>
      ))}
    </ol>
  );
  return (
    <>
      <nav aria-label="Report contents" className="no-print sticky top-24 hidden lg:block">
        {list}
      </nav>
      <div className="no-print rounded-lg border border-line bg-surface p-3 lg:hidden">
        <Disclosure label="Contents">
          <nav aria-label="Report contents" className="mt-2">
            {list}
          </nav>
        </Disclosure>
      </div>
    </>
  );
}

function H2({ id, n, children }: { id: string; n: string; children: React.ReactNode }) {
  return (
    <h2 id={`report-${id}`} className="scroll-mt-24 border-t border-line pt-8 text-h2 font-semibold text-fg-strong first:border-0 first:pt-0">
      <span className="mr-2 tabular-nums text-fg-muted">{n}</span>
      {children}
    </h2>
  );
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function refsOf(v: unknown): EvidenceRef[] {
  return Array.isArray(v) ? (v.filter((r) => r && typeof r === "object" && typeof (r as EvidenceRef).evidence_id === "string") as EvidenceRef[]) : [];
}

function SitemapList({ root }: { root: SitemapNode | null | undefined }) {
  const nodes = flattenSitemap(root, null);
  if (nodes.length === 0) return <p>No pages were recorded.</p>;
  return (
    <ul className="space-y-0.5 text-small">
      {nodes.map((n) => {
        const st = nodeStatus(n.node);
        return (
          <li key={n.key} style={{ paddingLeft: `${(n.level - 1) * 1.25}rem` }} className="flex flex-wrap gap-x-3">
            <span className="font-mono text-fg-strong">{n.path}</span>
            {n.node.title && <span className="text-fg">{n.node.title}</span>}
            <span className="text-fg-muted">{st.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function FeatureRows({ features }: { features: Feature[] }) {
  if (features.length === 0) return <p>No functionality was catalogued.</p>;
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Functionality inventory">
      <table className="min-w-full text-small">
        <thead className="bg-elevated">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Feature</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Category</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Label</th>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Evidence</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {features.map((f) => (
            <tr key={f.id}>
              <th scope="row" className="px-3 py-2 text-left align-top font-normal">
                <span className="font-semibold text-fg-strong">{f.name}</span>
                <span className="block text-fg">{f.description}</span>
              </th>
              <td className="px-3 py-2 align-top text-fg">{f.category.replace(/_/g, " ")}</td>
              <td className="px-3 py-2 align-top">
                <span className="flex flex-wrap gap-1">
                  <ObservationLabel provenance={f.provenance} confidence={f.confidence} />
                  <GeneratedByLabel generatedBy={f.generated_by} />
                </span>
              </td>
              <td className="px-3 py-2 align-top">
                <EvidenceLinks items={refsToItems(f.evidence_refs)} subject={f.name} />
                <span className="block font-mono text-caption text-fg-muted">{f.evidence_refs.map((r) => r.evidence_id.slice(0, 8)).join(", ")}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type ReportMeta = {
  host: string;
  scanNumber: number | null;
  createdAt: string;
  status: { approved: boolean; by?: string | null; at?: string | null };
  partial: string | null;
  gate1?: string | null;
};

/** The Application Discovery Report as an in-app reading document (design spec §9.1). */
export function ReportDocument({ content, meta, actions }: { content: DiscoveryReportContent; meta: ReportMeta; actions: React.ReactNode }) {
  const pagesById = new Map(content.pages.map((p) => [p.id, p]));
  const limitations = [...content.limitations];
  if (!limitations.includes(UI_ONLY_LIMITATION)) limitations.push(UI_ONLY_LIMITATION);
  const completeness = content.completeness ?? {};
  return (
    <article className="min-w-0 rounded-xl border border-line bg-surface p-6 shadow-xs sm:p-10 print:border-0 print:p-0 print:shadow-none">
      <header className="space-y-3 border-b border-line pb-6">
        <h1 tabIndex={-1} className="text-display font-semibold tracking-[-0.02em] text-fg-strong focus:outline-none">
          Application Discovery Report
        </h1>
        <p className="text-body text-fg-muted">
          {meta.host}
          {meta.scanNumber ? ` · Scan ${meta.scanNumber}` : ""} · <time dateTime={meta.createdAt}>{fmtDateTime(meta.createdAt)}</time>
        </p>
        <p>
          {meta.status.approved ? (
            <span className="inline-flex items-center rounded-full bg-success-bg px-2.5 py-0.5 text-caption font-medium text-success-fg ring-1 ring-inset ring-success-line">
              ✓ Approved{meta.status.by ? ` by ${meta.status.by}` : ""}
              {meta.status.at ? ` on ${fmtDateTime(meta.status.at)}` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-warning-bg px-2.5 py-0.5 text-caption font-medium text-warning-fg ring-1 ring-inset ring-warning-line">
              Draft — awaiting Gate 2
            </span>
          )}
        </p>
        <div className="no-print flex flex-wrap gap-2">{actions}</div>
        {meta.partial && (
          <p className="rounded-md bg-warning-bg px-3 py-2 text-body text-fg-strong ring-1 ring-inset ring-warning-line" role="note">
            {meta.partial}
          </p>
        )}
      </header>

      <div className="mt-8 max-w-[760px] space-y-6 text-body-lg text-fg">
        <section className="space-y-3">
          <H2 id="summary" n="1">
            Summary
          </H2>
          <p className="flex flex-wrap items-center gap-2">
            <GeneratedByLabel generatedBy={content.summary_generated_by} />
          </p>
          <p className="whitespace-pre-line">{content.summary}</p>
          <ul className="grid grid-cols-2 gap-2 text-body sm:grid-cols-4">
            <li>
              <span className="block text-h2 font-semibold tabular-nums text-fg-strong">{content.pages.length}</span>pages
            </li>
            <li>
              <span className="block text-h2 font-semibold tabular-nums text-fg-strong">{content.forms_inventory.length}</span>forms
            </li>
            <li>
              <span className="block text-h2 font-semibold tabular-nums text-fg-strong">{content.journeys.length}</span>user journeys
            </li>
            <li>
              <span className="block text-h2 font-semibold tabular-nums text-fg-strong">{content.access_gaps.length}</span>access gap{content.access_gaps.length === 1 ? "" : "s"}
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <H2 id="scope" n="2">
            Scope & approach
          </H2>
          <ul className="list-disc space-y-1 pl-5">
            {content.scope_and_method.map((s) => (
              <li key={s}>{s}</li>
            ))}
            <li>Credentials used: no. Discovery covered public pages only.</li>
            <li>Approach: read-only exploration in an isolated browser. No forms were submitted and no data was created, changed or deleted.</li>
          </ul>
          {meta.gate1 && <p className="text-body">Gate 1 (authorisation): {meta.gate1}</p>}
        </section>

        <section className="space-y-3">
          <H2 id="sitemap" n="3">
            Sitemap
          </H2>
          <SitemapList root={content.sitemap} />
        </section>

        <section className="space-y-4">
          <H2 id="functionality" n="4">
            Functionality
          </H2>
          <FeatureRows features={content.functionality_map} />
          {content.forms_inventory.length > 0 && (
            <>
              <h3 className="text-h3 font-semibold text-fg-strong">Forms inventory</h3>
              <ul className="space-y-2 text-body">
                {content.forms_inventory.map((f, i) => (
                  <li key={i}>
                    <span className="font-mono text-small text-fg-muted">{pathOf(f.page_url)}</span> · <span className="font-semibold text-fg-strong">{f.form.name || f.form.purpose_guess || "Form"}</span>:{" "}
                    {f.form.fields.map((x) => `${x.label || x.name} (${x.type}${x.required ? ", required" : ""})`).join(", ")}. Not submitted.{" "}
                    <ObservationLabel provenance="observed" />
                  </li>
                ))}
              </ul>
            </>
          )}
          {Object.keys(content.interactive_components).length > 0 && (
            <p className="text-body">
              Interactive components:{" "}
              {Object.entries(content.interactive_components)
                .map(([k, v]) => `${v} ${k}`)
                .join(", ")}
              .
            </p>
          )}
        </section>

        <section className="space-y-3">
          <H2 id="journeys" n="5">
            User journeys
          </H2>
          {content.journeys.length === 0 ? (
            <p>No user journeys were identified. Journeys need at least two linked pages with a clear goal.</p>
          ) : (
            <ul className="space-y-3">
              {content.journeys.map((j) => (
                <li key={j.id}>
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-fg-strong">
                    {j.name} <ObservationLabel provenance={j.provenance} confidence={j.confidence} />
                  </p>
                  <p className="text-body">
                    {j.steps.map((s) => `${s.action}${pagesById.get(s.page_id) ? ` (${pathOf(pagesById.get(s.page_id)!.url)})` : ""}`).join(" → ")}
                  </p>
                  <EvidenceLinks items={refsToItems(j.evidence_refs)} subject={`${j.name} journey`} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <H2 id="responsive" n="6">
            Responsive
          </H2>
          {content.responsive_observations.length === 0 ? (
            <p>No responsive observations were recorded.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              {content.responsive_observations.map((o) => (
                <li key={o}>
                  {o} <ObservationLabel provenance="observed" />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <H2 id="gaps" n="7">
            Access gaps & limitations
          </H2>
          {content.access_gaps.length === 0 ? (
            <p>No access gaps. Every page found within the limit was observed.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              {/* Exactly the reported gaps (they already include sign-in boundaries), with their evidence. */}
              {content.access_gaps.map((g, i) => (
                <li key={`g${i}`}>
                  {g.area ? <span className="font-mono text-small">{str(g.area)}</span> : null}
                  {g.area && g.reason ? ": " : ""}
                  {g.reason ? `${str(g.reason)}. ` : ""}
                  {str(g.description)}
                  {g.suggestion && g.suggestion !== "—" ? ` Suggested next step: ${str(g.suggestion)}` : ""}{" "}
                  <EvidenceLinks items={refsToItems(refsOf(g.evidence_refs))} subject={`access gap ${str(g.area || g.description)}`} />
                </li>
              ))}
            </ul>
          )}
          <h3 className="text-h3 font-semibold text-fg-strong">Limitations</h3>
          <ul className="list-disc space-y-1 pl-5">
            {limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
            {content.injection_flags.length > 0 && (
              <li>
                Page content was treated as untrusted data; {content.injection_flags.length} page{content.injection_flags.length === 1 ? "" : "s"} contained text addressed to AI
                agents, which was ignored.
              </li>
            )}
          </ul>
          {content.console_and_network_issues.length > 0 && (
            <>
              <h3 className="text-h3 font-semibold text-fg-strong">Console and network issues</h3>
              <ul className="list-disc space-y-1 pl-5 text-body">
                {content.console_and_network_issues.slice(0, 50).map((c, i) => (
                  <li key={i} className="break-words">
                    {str(c.page_url ?? c.url)} {str(c.text ?? c.failure ?? c.status)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-body text-fg-muted">{content.disclaimer}</p>
        </section>

        <section className="space-y-3">
          <H2 id="completeness" n="8">
            Completeness (Gate 2)
          </H2>
          <dl className="space-y-1 text-body">
            {"rating" in completeness && (
              <div>
                <dt className="inline font-semibold text-fg-strong">Assessment: </dt>
                <dd className="inline">{({ good: "Complete", partial: "Partially complete", limited: "Insufficient" } as Record<string, string>)[str(completeness.rating)] ?? str(completeness.rating)}</dd>
              </div>
            )}
            {"score" in completeness && (
              <div>
                <dt className="inline font-semibold text-fg-strong">Score: </dt>
                <dd className="inline tabular-nums">{str(completeness.score)}/100</dd>
              </div>
            )}
          </dl>
          {Array.isArray(completeness.reasons) && (
            <ul className="list-disc space-y-1 pl-5">
              {(completeness.reasons as unknown[]).map((r) => (
                <li key={str(r)}>{str(r)}</li>
              ))}
            </ul>
          )}
          <p>
            Decision: {meta.status.approved ? `approved${meta.status.by ? ` by ${meta.status.by}` : ""}${meta.status.at ? ` on ${fmtDateTime(meta.status.at)}` : ""}.` : "awaiting approval."}
          </p>
        </section>

        <section className="space-y-3">
          <H2 id="evidence" n="A">
            Evidence index
          </H2>
          {content.evidence_index.length === 0 ? (
            <p>No evidence files.</p>
          ) : (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Evidence index">
              <table className="min-w-full text-small">
                <thead className="bg-elevated">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">ID</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Type</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Captured</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold text-fg-strong">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {content.evidence_index.map((e) => (
                    <tr key={e.id}>
                      <th scope="row" className="px-3 py-1.5 text-left font-mono font-normal text-fg-strong">
                        {e.id.slice(0, 8)}
                      </th>
                      <td className="px-3 py-1.5 text-fg">{e.kind.replace(/_/g, " ")}</td>
                      <td className="px-3 py-1.5 tabular-nums text-fg">{fmtDateTime(e.captured_at)}</td>
                      <td className="px-3 py-1.5">
                        <EvidenceLinks items={linksToItems([e])} subject={`evidence ${e.id.slice(0, 8)}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <H2 id="glossary" n="B">
            Labels & glossary
          </H2>
          <dl className="space-y-2 text-body">
            {[
              ["Observed", "Seen directly in the browser."],
              ["Inferred", "Concluded from what was seen; not verified."],
              ["Access gap", "An area discovery could not observe, with the reason and a suggested next step."],
              ["Auth boundary", "A point where the site requires sign-in (sign-in form, HTTP 401/403 or a redirect to sign-in)."],
              ["User journey", "A sequence of pages and actions with a clear user goal. Steps that would submit or change data are inferred, not performed."],
              ["ISTQB references", "Terminology follows the ISTQB glossary: test basis, test condition, test item."],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="font-semibold text-fg-strong">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </article>
  );
}
