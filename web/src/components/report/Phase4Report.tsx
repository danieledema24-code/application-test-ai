"use client";

// Test Execution Report and Defect Report bodies (design P4 §13), from the report's frozen content. Causes are
// labelled Hypothesis unless a person set them; flaky results are counted on their own.

import Link from "next/link";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import { HYPOTHESIS_BAND } from "@/lib/reports";
import { ResultStatus } from "@/components/domain/ExecutionLabels";

type DefectRef = { key: string; occurrence: number };
type Cause = { label: string; set_by_person: boolean } | null;
type ExecContent = {
  basis: "run" | "latest_per_case";
  run: { key: string; status: string; selection: string; browsers: string[]; viewports: string[]; started_at: string | null; finished_at: string | null; duration_ms: number | null; authorised: boolean;
    // Added with QA R2-BUG-02; older frozen reports lack them. Names only: reports are shared.
    sizes?: string[]; workers?: number; retries?: number; requested_by?: string | null; requested_at?: string | null;
    authorised_by?: string | null; authorised_at?: string | null; self_authorised?: boolean } | null;
  totals: Record<"passed" | "failed" | "flaky" | "error" | "blocked" | "skipped" | "tests", number>;
  results: { result_key: string; run_key: string; case_key: string | null; title: string | null; browser: string; size: string; status: string; failed_step: string | null; cause: Cause; reason?: string | null; defect?: DefectRef | null }[];
  defects: { key: string; summary: string; status: string; severity: string; raised_here?: boolean }[];
  summary: string;
  flaky_note: string;
  // Older frozen reports (before QA P4-BUG-03) have neither list.
  not_automated?: { case_key: string; title: string; reasons: string[] }[];
  limitations?: string[];
};
type DefectContent = {
  drafts: number;
  summary: string;
  defects: { key: string; summary: string; status: string; severity: string; priority: string; cases: string[]; steps: string[]; expected: string; actual: string; reproducibility: string; root_cause_hypothesis: string | null }[];
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Phase4ReportBody({ type, content, projectId }: { type: "execution" | "defect"; content: unknown; projectId: string }) {
  if (type === "execution") return <ExecutionBody c={content as ExecContent} projectId={projectId} />;
  return <DefectBody c={content as DefectContent} projectId={projectId} />;
}

function ExecutionBody({ c, projectId }: { c: ExecContent; projectId: string }) {
  const t = c.totals;
  return (
    <article className="space-y-5 rounded-xl bg-surface p-6 ring-1 ring-line-strong">
      <p className="rounded-md bg-elevated px-3 py-2 text-small text-fg ring-1 ring-line">{HYPOTHESIS_BAND}</p>
      <section className="space-y-1">
        <h2 className="text-h3 font-semibold text-fg-strong">Summary</h2>
        <p className="text-body text-fg">{c.summary}</p>
        {c.run ? (
          <p className="text-small text-fg-muted">
            <Link href={`/projects/${projectId}/execution/${c.run.key}`} className="font-medium text-navy-700 underline underline-offset-2">
              {c.run.key}
            </Link>{" "}
            · {c.run.selection} · {c.run.browsers.map(cap).join(", ")} · {c.run.viewports.map(cap).join(", ")} · finished {fmtDateTime(c.run.finished_at)}
            {c.run.duration_ms !== null ? ` · ${fmtDuration(c.run.duration_ms)}` : ""} · {c.run.authorised ? "authorised at Gate 7" : "not authorised"}
          </p>
        ) : (
          <p className="text-small text-fg-muted">Latest result per test case, across runs.</p>
        )}
        {c.run && c.run.workers !== undefined && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-small">
            <dt className="text-fg-muted">Requested</dt>
            <dd>
              {c.run.requested_by ?? "Unknown"}
              {c.run.requested_at ? ` · ${fmtDateTime(c.run.requested_at)}` : ""}
            </dd>
            <dt className="text-fg-muted">Authorised (Gate 7)</dt>
            <dd>
              {c.run.authorised ? `${c.run.authorised_by ?? "Unknown"}${c.run.authorised_at ? ` · ${fmtDateTime(c.run.authorised_at)}` : ""}${c.run.self_authorised ? " (self-authorised)" : ""}` : "Not authorised"}
            </dd>
            <dt className="text-fg-muted">Sizes</dt>
            <dd>{(c.run.sizes ?? c.run.viewports).join(", ")}</dd>
            <dt className="text-fg-muted">Workers and retries</dt>
            <dd>
              {plural(c.run.workers, "worker", "workers")} · {plural(c.run.retries ?? 0, "retry", "retries")} per failed test
            </dd>
          </dl>
        )}
        <p className="text-body text-fg">
          {t.passed} passed · {t.failed} failed · {t.flaky} flaky · {t.error} {t.error === 1 ? "error" : "errors"} · {t.blocked} blocked · {t.skipped} skipped ({t.tests} tests)
        </p>
        <p className="text-small text-fg-muted">{c.flaky_note}</p>
      </section>
      <section className="space-y-2">
        <h2 className="text-h3 font-semibold text-fg-strong">Results</h2>
        <div className="overflow-x-auto" role="region" aria-label="Results, scrolls sideways" tabIndex={0}>
          <table className="min-w-full text-left text-small">
            <caption className="sr-only">Results in this report</caption>
            <thead className="bg-elevated">
              <tr>
                {["Result", "Test case", "Browser · size", "Status", "Failed step", "Likely cause", "Defect"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.results.map((x) => (
                <tr key={x.result_key} className="border-t border-line align-top">
                  <td className="px-3 py-1.5 font-mono">
                    <Link href={`/projects/${projectId}/execution/${x.run_key}/results/${x.result_key}`} className="text-navy-700 underline underline-offset-2">
                      {x.result_key}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono">{x.case_key}</span> {x.title}
                  </td>
                  <td className="px-3 py-1.5">
                    {x.browser} · {x.size}
                  </td>
                  <td className="px-3 py-1.5">
                    <ResultStatus status={x.status} />
                    {x.reason ? <span className="block text-fg-muted">{x.reason}</span> : null}
                  </td>
                  <td className="px-3 py-1.5">{x.failed_step ?? "—"}</td>
                  <td className="px-3 py-1.5">{x.cause ? `${x.cause.label} (${x.cause.set_by_person ? "set by a person" : "Hypothesis"})` : "—"}</td>
                  <td className="px-3 py-1.5">
                    {x.defect ? (
                      <Link href={`/projects/${projectId}/defects/${x.defect.key}`} className="font-mono text-navy-700 underline underline-offset-2">
                        {defectText(x.defect)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {c.not_automated && (
        <section className="space-y-1">
          <h2 className="text-h3 font-semibold text-fg-strong">Not automated</h2>
          {c.not_automated.length ? (
            <>
              <p className="text-body text-fg">Approved test cases that need a person, so no test ran for them:</p>
              <ul className="space-y-1 text-body">
                {c.not_automated.map((x) => (
                  <li key={x.case_key}>
                    <span className="font-mono">{x.case_key}</span> {x.title}: <span className="text-fg-muted">{x.reasons.join("; ")}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-body text-fg-muted">None. Every approved test case can be automated.</p>
          )}
        </section>
      )}
      {c.limitations && c.limitations.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-h3 font-semibold text-fg-strong">Limitations</h2>
          <ul className="list-disc space-y-1 pl-5 text-body">
            {c.limitations.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-1">
        <h2 className="text-h3 font-semibold text-fg-strong">Defects</h2>
        {c.defects.length ? (
          <ul className="space-y-1 text-body">
            {c.defects.map((d) => (
              <li key={d.key}>
                <Link href={`/projects/${projectId}/defects/${d.key}`} className="font-mono text-navy-700 underline underline-offset-2">
                  {d.key}
                </Link>{" "}
                {d.summary} · {cap(d.status)} · {cap(d.severity)}
                {d.raised_here === false ? " · seen again" : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg-muted">None.</p>
        )}
      </section>
    </article>
  );
}

function DefectBody({ c, projectId }: { c: DefectContent; projectId: string }) {
  return (
    <article className="space-y-5 rounded-xl bg-surface p-6 ring-1 ring-line-strong">
      <p className="rounded-md bg-elevated px-3 py-2 text-small text-fg ring-1 ring-line">{HYPOTHESIS_BAND}</p>
      <section className="space-y-1">
        <h2 className="text-h3 font-semibold text-fg-strong">Summary</h2>
        <p className="text-body text-fg">{c.summary}</p>
      </section>
      {c.defects.map((d) => (
        <section key={d.key} aria-labelledby={`d-${d.key}`} className="space-y-1 border-t border-line pt-3">
          <h2 id={`d-${d.key}`} className="text-h3 font-semibold text-fg-strong">
            <Link href={`/projects/${projectId}/defects/${d.key}`} className="font-mono text-navy-700 underline underline-offset-2">
              {d.key}
            </Link>{" "}
            {d.summary}
          </h2>
          <p className="text-small text-fg-muted">
            {cap(d.status)} · severity {cap(d.severity)} · priority {cap(d.priority)} · {d.cases.length ? d.cases.join(", ") : "no test case"} · {d.reproducibility}
          </p>
          {d.steps.length > 0 && (
            <ol className="list-decimal pl-5 text-body">
              {d.steps.map((st, i) => (
                <li key={i}>{st}</li>
              ))}
            </ol>
          )}
          <p className="text-body">
            <span className="font-semibold">Expected:</span> {d.expected}
          </p>
          <p className="text-body">
            <span className="font-semibold">Actual:</span> {d.actual}
          </p>
          {d.root_cause_hypothesis && <p className="text-small text-fg-muted">Hypothesis: {d.root_cause_hypothesis}</p>}
        </section>
      ))}
      {c.defects.length === 0 && <p className="text-body text-fg-muted">No defects.</p>}
    </article>
  );
}

/** "DEF-0001" where the result raised it, "DEF-0001 (occurrence 2)" where it failed a known defect again (QA R2-BUG-01). */
function defectText(d: DefectRef): string {
  return d.occurrence > 1 ? `${d.key} (occurrence ${d.occurrence})` : d.key;
}
