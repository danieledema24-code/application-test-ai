"use client";

// Performance, Accessibility and Security report bodies (design P5 §11.2), from the report's frozen content. The
// numbers are the run's or check's own (the API's), people appear by name only, and statements come first.

import Link from "next/link";
import { fmtDateTime } from "@/lib/format";
import { HonestyNote } from "@/components/domain/NonFunctionalLabels";
import { Disclosure, Table, TBody, Td, Th, THead, Tr } from "@/components/ui";

type Person = { full_name?: string | null } | null;
type ThresholdText = { scope: string; measure: string; limit: string; source: string; measured: string; result: string };
type Chart = { title: string; points: string; rows: { t: number; value: string }[]; threshold_text?: string | null };
type PerfContent = {
  source_key: string;
  statement: string;
  paragraph: string;
  approval_line: string;
  thresholds: { text: ThresholdText }[];
  charts: Chart[];
  limitations: string[];
  run: {
    key: string;
    status_label: string;
    summary: string;
    profile: { key: string; version: number; name: string; type: string };
    engine: { name?: string; version?: string };
    aborted_reason: string | null;
    error: string | null;
    stopped_by: Person;
    started_at: string | null;
    finished_at: string | null;
    limits?: { test: Lim; organisation: Lim; server: Lim } | null;
    result: { overall?: { count?: number }; targets?: Target[]; generator_location?: string };
    defects?: { key: string; summary: string; status: string }[];
  };
};
type Lim = { vus: number; rps: number; duration_s: number };
type Target = { path: string; count: number; rps: number; error_rate: number; latency_ms: Record<string, number>; status_codes: Record<string, number> };
type Finding = {
  key: string;
  rule_id: string;
  title: string;
  severity: string;
  path: string;
  viewport: string | null;
  nodes: { target: string }[];
  status: string;
  status_reason: string | null;
  status_by: Person;
  seen_before: string | null;
  mapped: { requirements: string[]; test_cases: string[] };
  defect: { key: string } | null;
  details: { observed?: string; why?: string; fix?: string };
};
type ScanContent = {
  source_key: string;
  statement: string;
  summary: string;
  scan: { pages: number; viewports: string[]; keyboard: boolean; signed_in: boolean; tool_versions: Record<string, string>; status_label: string };
  findings: Finding[];
  not_checked: { url: string; reason: string }[];
  // accessibility
  by_severity?: Record<string, number>;
  by_wcag?: Record<string, number>;
  rules?: unknown[];
  needs_review?: Finding[];
  keyboard?: { url: string; path?: string; focusable?: number; trap?: boolean; not_visible?: number; not_reachable?: number }[];
  keyboard_findings?: Finding[];
};
type RuleGroup = { rule_id: string; title: string; severity: string; wcag: string[]; findings: Finding[] };
type SecRule = { rule_id: string; subject: string; title: string; result: string; severity: string; reason: string; page_count: number; observed: string; reference?: { name: string; url: string } };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const RESULT: Record<string, string> = { failed: "✗ Failed", passed: "✓ Passed", not_applicable: "Not applicable", not_checked: "Not checked" };

export function Phase5ReportBody({ type, content, projectId }: { type: "performance" | "accessibility" | "security"; content: unknown; projectId: string }) {
  if (type === "performance") return <PerformanceBody c={content as PerfContent} projectId={projectId} />;
  if (type === "accessibility") return <AccessibilityBody c={content as ScanContent} projectId={projectId} />;
  return <SecurityBody c={content as ScanContent} projectId={projectId} />;
}

function Article({ children }: { children: React.ReactNode }) {
  return <article className="space-y-5 rounded-xl bg-surface p-6 ring-1 ring-line-strong">{children}</article>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-h3 font-semibold text-fg-strong">{title}</h2>
      {children}
    </section>
  );
}

function PerformanceBody({ c, projectId }: { c: PerfContent; projectId: string }) {
  const r = c.run;
  return (
    <Article>
      <Section title="Summary">
        <p className="text-body text-fg">{c.paragraph}</p>
        <HonestyNote>{c.statement}</HonestyNote>
      </Section>
      <Section title="Load test">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-small sm:grid-cols-[max-content_1fr]">
          <dt className="text-fg-muted">Load test</dt>
          <dd>
            <Link href={`/projects/${projectId}/non-functional/load-tests/${r.key}`} className="font-medium text-navy-700 underline underline-offset-2">
              {r.key}
            </Link>{" "}
            · {r.status_label}
          </dd>
          <dt className="text-fg-muted">Profile</dt>
          <dd>
            {r.profile.key} v{r.profile.version} · {r.profile.name}
          </dd>
          <dt className="text-fg-muted">What was sent</dt>
          <dd>{r.summary}</dd>
          <dt className="text-fg-muted">Approval</dt>
          <dd>{c.approval_line}</dd>
          <dt className="text-fg-muted">Engine</dt>
          <dd>
            {r.engine.name ?? "Built-in load generator"} {r.engine.version ?? ""}
          </dd>
          {r.limits && (
            <>
              <dt className="text-fg-muted">Limits (test · organisation · server)</dt>
              <dd>
                {r.limits.test.vus} · {r.limits.organisation.vus} · {r.limits.server.vus} virtual users; {r.limits.test.rps} · {r.limits.organisation.rps} · {r.limits.server.rps} requests a second
              </dd>
            </>
          )}
          <dt className="text-fg-muted">When</dt>
          <dd>
            {fmtDateTime(r.started_at)} – {fmtDateTime(r.finished_at)} · {r.result.overall?.count ?? 0} requests
          </dd>
          {r.aborted_reason && (
            <>
              <dt className="text-fg-muted">Stopped automatically</dt>
              <dd>{r.aborted_reason}</dd>
            </>
          )}
          {r.stopped_by?.full_name && (
            <>
              <dt className="text-fg-muted">Stopped by</dt>
              <dd>{r.stopped_by.full_name}</dd>
            </>
          )}
        </dl>
      </Section>
      <Section title="Thresholds">
        <Table label="Threshold results">
          <THead>
            <tr>
              <Th>Page / scope</Th>
              <Th>Measure</Th>
              <Th>Threshold</Th>
              <Th>Measured</Th>
              <Th>Result</Th>
            </tr>
          </THead>
          <TBody>
            {c.thresholds.map((t, i) => (
              <Tr key={i}>
                <Td rowHeader>{t.text.scope}</Td>
                <Td>{t.text.measure}</Td>
                <Td>
                  {t.text.limit} <span className="block text-small text-fg-muted">{t.text.source}</span>
                </Td>
                <Td>{t.text.measured}</Td>
                <Td>{t.text.result}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Section>
      {(r.result.targets?.length ?? 0) > 0 && (
        <Section title="Per page">
          <Table label="Per page results">
            <THead>
              <tr>
                <Th>Page</Th>
                <Th>Requests</Th>
                <Th>p50</Th>
                <Th>p90</Th>
                <Th>p95</Th>
                <Th>p99</Th>
                <Th>Errors</Th>
                <Th>Status codes</Th>
              </tr>
            </THead>
            <TBody>
              {r.result.targets!.map((t) => (
                <Tr key={t.path}>
                  <Td rowHeader>{t.path}</Td>
                  <Td>{t.count}</Td>
                  {(["p50", "p90", "p95", "p99"] as const).map((k) => (
                    <Td key={k}>{t.latency_ms?.[k] !== undefined ? `${Math.round(t.latency_ms[k])} ms` : "—"}</Td>
                  ))}
                  <Td>{`${((t.error_rate ?? 0) * 100).toFixed(1)} %`}</Td>
                  <Td>
                    {Object.entries(t.status_codes ?? {})
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ")}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Section>
      )}
      <Section title="Over time">
        {c.charts.map((ch) => (
          <Disclosure key={ch.title} label={`${ch.title} (${ch.rows.length} rows)`}>
            <Table label={`${ch.title} as a table`} className="max-h-72">
              <THead>
                <tr>
                  <Th>Second</Th>
                  <Th>{ch.title}</Th>
                </tr>
              </THead>
              <TBody>
                {ch.rows.map((row) => (
                  <Tr key={row.t}>
                    <Td rowHeader>{row.t}</Td>
                    <Td>{row.value}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Disclosure>
        ))}
        <p className="text-small text-fg-muted">The PDF and HTML show these as charts; the time-series CSV has one row per second.</p>
      </Section>
      <Section title="Defects raised">
        {r.defects?.length ? (
          <ul className="space-y-1 text-body">
            {r.defects.map((d) => (
              <li key={d.key}>
                <Link href={`/projects/${projectId}/defects/${d.key}`} className="font-medium text-navy-700 underline underline-offset-2">
                  {d.key}
                </Link>{" "}
                {d.summary} · {cap(d.status)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg">None.</p>
        )}
      </Section>
      <Section title="Limitations">
        <ul className="ml-5 list-disc space-y-1 text-body text-fg">
          {c.limitations.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </Section>
    </Article>
  );
}

function ScanHeader({ c, projectId }: { c: ScanContent; projectId: string }) {
  return (
    <p className="text-small text-fg-muted">
      <Link href={`/projects/${projectId}/non-functional/checks/${c.source_key}`} className="font-medium text-navy-700 underline underline-offset-2">
        {c.source_key}
      </Link>{" "}
      · {c.scan.pages} pages · {c.scan.viewports.join(", ")} · {c.scan.status_label}
      {c.scan.tool_versions.axe ? ` · axe-core ${c.scan.tool_versions.axe}` : ""}
    </p>
  );
}

function NotChecked({ c }: { c: ScanContent }) {
  if (!c.not_checked.length) return null;
  return (
    <div className="text-small text-fg">
      Not checked (not counted as clean):
      <ul className="ml-5 list-disc">
        {c.not_checked.map((n) => (
          <li key={n.url}>
            {n.url} ({n.reason})
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusText(f: Finding): string {
  return `${cap(f.status)}${f.status_reason ? `: ‘${f.status_reason}’${f.status_by?.full_name ? ` (${f.status_by.full_name})` : ""}` : ""}${f.seen_before ? ` · seen before (${f.seen_before})` : ""}`;
}

function AccessibilityBody({ c, projectId }: { c: ScanContent; projectId: string }) {
  const groups = (c.rules ?? []) as RuleGroup[];
  return (
    <Article>
      <HonestyNote>{c.statement}</HonestyNote>
      <Section title="Summary">
        <p className="text-body text-fg">{c.summary}</p>
        <ScanHeader c={c} projectId={projectId} />
        <p className="text-small text-fg-muted">
          Keyboard pass {c.scan.keyboard ? "on" : "off"} · pages behind sign-in {c.scan.signed_in ? "included" : "not included"}
        </p>
        <NotChecked c={c} />
      </Section>
      {Object.keys(c.by_wcag ?? {}).length > 0 && (
        <Section title="By WCAG criterion">
          <p className="text-body text-fg">
            {Object.entries(c.by_wcag ?? {})
              .map(([k, v]) => `${k}: ${v} rule${v === 1 ? "" : "s"}`)
              .join(" · ")}
          </p>
        </Section>
      )}
      <Section title="Findings by rule">
        {groups.length === 0 && <p className="text-body text-fg">No rule failed on the pages checked.</p>}
        {groups.map((g) => (
          <div key={g.rule_id} className="space-y-1">
            <h3 className="text-body font-semibold text-fg-strong">
              {g.title} ({g.rule_id}) · {cap(g.severity)}
              {g.wcag.length ? ` · WCAG ${g.wcag.join(", ")}` : ""}
            </h3>
            <Table label={`${g.rule_id} findings`}>
              <THead>
                <tr>
                  <Th>Finding</Th>
                  <Th>Page</Th>
                  <Th>Elements</Th>
                  <Th>Status</Th>
                  <Th>Linked to</Th>
                  <Th>Defect</Th>
                </tr>
              </THead>
              <TBody>
                {g.findings.map((f) => (
                  <Tr key={f.key}>
                    <Td rowHeader>{f.key}</Td>
                    <Td>{f.path}</Td>
                    <Td>
                      <span className="break-all font-mono text-xs">{f.nodes.map((n) => n.target).join(", ")}</span>
                    </Td>
                    <Td>{statusText(f)}</Td>
                    <Td>{[...f.mapped.requirements, ...f.mapped.test_cases].join(", ") || "—"}</Td>
                    <Td>{f.defect?.key ?? "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        ))}
      </Section>
      <Section title="Keyboard checks (heuristic)">
        <p className="text-small text-fg-muted">Pressed only Tab and Shift+Tab. A person should confirm these; they never create defect drafts automatically.</p>
        {(c.keyboard ?? []).length === 0 ? (
          <p className="text-body text-fg">The keyboard pass was off.</p>
        ) : (
          <ul className="space-y-1 text-body">
            {(c.keyboard ?? []).map((k) => (
              <li key={k.url}>
                {k.path ?? k.url}: {k.focusable ?? 0} links and controls · trap {k.trap ? "found" : "none"} · {k.not_visible ?? 0} without visible focus · {k.not_reachable ?? 0} not reachable
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Article>
  );
}

function SecurityBody({ c, projectId }: { c: ScanContent; projectId: string }) {
  const rules = (c.rules ?? []) as SecRule[];
  return (
    <Article>
      <HonestyNote>{c.statement}</HonestyNote>
      <Section title="Summary">
        <p className="text-body text-fg">{c.summary}</p>
        <ScanHeader c={c} projectId={projectId} />
        <NotChecked c={c} />
      </Section>
      <Section title="Every rule">
        <Table label="Security rules">
          <THead>
            <tr>
              <Th>Rule</Th>
              <Th>Result</Th>
              <Th>Pages</Th>
              <Th>Reason or observed</Th>
            </tr>
          </THead>
          <TBody>
            {rules.map((r) => (
              <Tr key={`${r.rule_id}|${r.subject}`}>
                <Td rowHeader>{r.title}</Td>
                <Td>
                  {RESULT[r.result] ?? r.result}
                  {r.result === "failed" ? ` · ${cap(r.severity)}` : ""}
                </Td>
                <Td>{r.page_count || "—"}</Td>
                <Td>
                  {r.reason}
                  {r.observed && <span className="block break-all font-mono text-xs">{r.observed}</span>}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Section>
      <Section title="Findings">
        {c.findings.length === 0 && <p className="text-body text-fg">No passive check failed.</p>}
        {c.findings.map((f) => (
          <div key={f.key} className="space-y-1">
            <h3 className="text-body font-semibold text-fg-strong">
              {f.key} · {f.title} · {cap(f.severity)}
            </h3>
            <p className="text-small text-fg-muted">
              {f.path} · {statusText(f)}
              {f.defect ? ` · ${f.defect.key}` : ""}
            </p>
            {f.details.observed && <p className="break-all font-mono text-xs text-fg-strong">{f.details.observed}</p>}
            {f.details.why && <p className="text-body text-fg">Why it matters: {f.details.why}</p>}
            {f.details.fix && <p className="text-body text-fg">How to fix: {f.details.fix}</p>}
          </div>
        ))}
      </Section>
    </Article>
  );
}
