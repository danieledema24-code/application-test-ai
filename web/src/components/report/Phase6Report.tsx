"use client";

// Release Readiness and Test Completion reports (P6-05c, D34; design P6 §11): the report pages, their bodies (from the
// report's frozen content: the numbers are the API's, computed in code, people by name only) and the Generate Test
// Completion Report dialog. Downloads: PDF, HTML, CSV, XLSX; JSON stays API-only and there is no DOCX.

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Printer, Sparkles } from "lucide-react";
import { api, ApiError, downloadFile, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ReportDetail, ReportSummary } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { hostOf } from "@/lib/url";
import { COMPLETION_GENERATED, P6_NOT_AVAILABLE, REPORT_TYPES, completionError, downloadFailedText, lessonsByline, lessonsHint, phase2ReportFileName, preparingText, type DownloadFormat, type Phase6ReportType } from "@/lib/reports";
import type { ReleaseSummary, Verdict, VerdictState } from "@/lib/release";
import { Button, Callout, EmptyState, ErrorState, LinkButton, LoadingBlock, Modal, SelectField, StatusPill, Table, TBody, Td, TextArea, Th, THead, Tr, useToast } from "@/components/ui";
import { HonestyNote } from "@/components/domain/NonFunctionalLabels";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { VerdictChip } from "@/components/domain/ReleaseLabels";
import { releaseReachable, useReleaseOverview } from "@/components/release/hooks";
import { useCapabilities } from "@/components/assistant/useThread";
import { useProject } from "@/components/workspace/ProjectContext";

// ---- content (backend app/agents/reporting/phase6_reports.py) -------------------------------------------------

type CriterionRow = { id: string; text: string; blocking: boolean; blocking_text: string; status: string; status_text: string; source_label: string; evidence: string; detail: string; confirmed: string | null };
type ConditionRow = { text: string; blocking: boolean; evidence: string };
type ResidualRow = { key: string; title: string; initial: string; residual: string; line: string };
type Narrative = { text: string; generated_by: "ai" | "rules" } | null;

export type ReadinessContent = {
  source_key: string;
  statement: string;
  band: string | null;
  assessment: { status: string; verdict: Verdict; verdict_state: VerdictState; assessed_at?: string | null; created_by?: { full_name?: string | null } | null };
  verdict_text: string;
  reason: string | null;
  decision_line: string;
  override_text: string | null;
  criteria: CriterionRow[];
  conditions: ConditionRow[];
  residual: ResidualRow[];
  overall_residual: string | null;
  changes: { previous: { key: string } | null; parts: string[]; text: string | null };
  narrative: Narrative;
  limitations: string[];
};

type Bucket = { group: string; approved: number; executed: number; passed: number; failed: number; flaky: number; error: number; blocked: number; skipped: number; not_run: number };

export type CompletionContent = {
  source_key: string;
  basis: "assessment" | "current";
  release: { key: string | null; verdict_text?: string; reason?: string | null; decision_line?: string; override_text?: string | null; statement?: string; text?: string };
  summary: string;
  scope: { requirements: number; acceptance_criteria: number; test_cases: number; test_types: string[] };
  not_tested: { item: string; reason: string }[];
  deviations: { case_key: string; title: string; deviation: string; reason: string }[];
  deviations_line: string;
  measures: {
    groups: Bucket[];
    coverage: {
      requirements: { approved: number; with_approved_case: number; percent_approved_covered: number };
      acceptance_criteria: { approved: number; covered: number; percent: number };
      execution: { requirements: { approved: number; with_result: number } };
    };
    defects: { total: number; by_severity: Record<string, number>; by_status: Record<string, number>; by_source: Record<string, number> };
  };
  runs: { key: string; status: string; selection: string; change_set: string | null; totals: Record<string, number> }[];
  change_sets: { key: string; total: number; regression_runs: string[] }[];
  exploratory: { sessions: { key: string; status: string; actions: number | null; pages: number | null; findings: number; open_high_medium: number; statement: string | null }[]; empty: string | null };
  non_functional: { type: string; source: string | null; text: string }[];
  criteria: CriterionRow[];
  conditions: ConditionRow[];
  residual: ResidualRow[];
  overall_residual: string | null;
  assets: { scripts: { path: string; version: number; state: string }[]; profiles: { key: string; name: string }[] };
  limitations: string[];
  lessons: { text: string; generated_by: "person" | "ai"; author: string | null } | null;
};

const link = "font-medium text-navy-700 underline underline-offset-2";
const counted = (m: Record<string, number>) =>
  Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
    .join(", ") || "none";

// ---- report bodies ---------------------------------------------------------------------------------------------

function Article({ children }: { children: React.ReactNode }) {
  return <article className="min-w-0 space-y-6 rounded-xl bg-surface p-4 ring-1 ring-line-strong md:p-6">{children}</article>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-2">
      <h2 id={id} className="text-h3 font-semibold text-fg-strong">
        {title}
      </h2>
      {children}
    </section>
  );
}

function List({ items, empty = "None." }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-body text-fg">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-body text-fg">
      {items.map((x, i) => (
        <li key={i} className="break-words">
          {x}
        </li>
      ))}
    </ul>
  );
}

function CriteriaTable({ rows, label }: { rows: CriterionRow[]; label: string }) {
  return (
    <Table label={label}>
      <THead>
        <tr>
          <Th>Criterion</Th>
          <Th>Blocking</Th>
          <Th>Status</Th>
          <Th>Source</Th>
          <Th>Evidence</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((c) => (
          <Tr key={c.id}>
            <Td rowHeader className="min-w-56 whitespace-normal align-top">
              {c.text}
              <span className="mt-1 block text-small font-normal text-fg-muted">{c.detail}</span>
              {c.confirmed && <span className="mt-1 block text-small font-normal text-fg">{c.confirmed}</span>}
            </Td>
            <Td className="align-top">{c.blocking_text}</Td>
            <Td className="align-top">{c.status_text}</Td>
            <Td className="align-top">{c.source_label}</Td>
            <Td className="align-top">{c.evidence || "—"}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

function Conditions({ rows }: { rows: ConditionRow[] }) {
  if (!rows.length) return <p className="text-body text-fg">None.</p>;
  return (
    <ol className="list-decimal space-y-1 pl-5 text-body text-fg">
      {rows.map((x, i) => (
        <li key={i} className="break-words">
          {x.text}
          {x.blocking && " (blocking)"}
        </li>
      ))}
    </ol>
  );
}

function Residual({ rows, overall }: { rows: ResidualRow[]; overall: string | null }) {
  return (
    <>
      <p className="text-body text-fg">Overall residual risk: {overall ?? "—"}</p>
      {rows.length ? (
        <Table label="Residual risk">
          <THead>
            <tr>
              <Th>Risk</Th>
              <Th>Before testing</Th>
              <Th>Now</Th>
              <Th>Why</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.key}>
                <Td rowHeader className="min-w-48 whitespace-normal align-top">
                  {r.key} · {r.title}
                </Td>
                <Td className="align-top">{r.initial}</Td>
                <Td className="align-top">{r.residual}</Td>
                <Td className="min-w-64 whitespace-normal align-top">{r.line}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-body text-fg">No risks in the register.</p>
      )}
    </>
  );
}

function ReadinessBody({ c }: { c: ReadinessContent }) {
  const final = c.assessment.status === "final";
  return (
    <Article>
      <HonestyNote>{c.statement}</HonestyNote>
      <Section id="rr-verdict" title={final ? "Final verdict" : "Recommendation"}>
        <p>
          <VerdictChip verdict={c.assessment.verdict} state={c.assessment.verdict_state} size="lg" />
        </p>
        {c.override_text && <p className="break-words font-medium text-fg-strong">{c.override_text}</p>}
        {c.reason && <p className="text-body text-fg">{c.reason}</p>}
        <p className="text-body text-fg">{c.decision_line}</p>
        <p className="text-small text-fg-muted">
          {c.source_key} · assessed {fmtDateTime(c.assessment.assessed_at ?? null)}
          {c.assessment.created_by?.full_name ? ` by ${c.assessment.created_by.full_name}` : ""}
        </p>
        <GeneratedByLabel generatedBy="computed" />
      </Section>
      {c.narrative && (
        <Section id="rr-narrative" title="What this means">
          <p className="text-body text-fg">{c.narrative.text}</p>
          <GeneratedByLabel generatedBy={c.narrative.generated_by} />
        </Section>
      )}
      <Section id="rr-conditions" title={`Conditions (${c.conditions.length})`}>
        <Conditions rows={c.conditions} />
      </Section>
      <Section id="rr-criteria" title={`Criteria (${c.criteria.length})`}>
        <CriteriaTable rows={c.criteria} label={`Criteria (${c.criteria.length})`} />
        <p className="text-small text-fg-muted">&ldquo;Critical or high&rdquo; means the critical and major severities.</p>
      </Section>
      <Section id="rr-residual" title="Residual risk">
        <Residual rows={c.residual} overall={c.overall_residual} />
      </Section>
      <Section id="rr-changes" title={c.changes.previous ? `What changed since ${c.changes.previous.key}` : "What changed since the last assessment"}>
        {c.changes.previous ? <List items={c.changes.parts} /> : <p className="text-body text-fg">{c.changes.text}</p>}
      </Section>
      <Section id="rr-limitations" title="Limitations">
        <List items={c.limitations} />
      </Section>
    </Article>
  );
}

function CompletionBody({ c, projectId }: { c: CompletionContent; projectId: string }) {
  const m = c.measures;
  const cov = m.coverage;
  return (
    <Article>
      <Section id="tc-summary" title="Summary">
        <p className="text-body text-fg">{c.summary}</p>
        <GeneratedByLabel generatedBy="computed" />
        {c.release.key ? (
          <div className="space-y-2">
            {c.release.statement && <HonestyNote>{c.release.statement}</HonestyNote>}
            <p className="break-words font-medium text-fg-strong">
              <Link href={`/projects/${projectId}/release-readiness/${c.release.key}`} className={link}>
                {c.release.key}
              </Link>
              : {c.release.verdict_text}
              {c.release.override_text ? ` · ${c.release.override_text}` : ""}
            </p>
            {c.release.reason && <p className="text-body text-fg">{c.release.reason}</p>}
            <p className="text-body text-fg">{c.release.decision_line}</p>
          </div>
        ) : (
          <p className="text-body text-fg">{c.release.text}</p>
        )}
      </Section>
      <Section id="tc-scope" title="Scope and what was not tested">
        <p className="text-body text-fg">
          {c.scope.requirements} approved requirements, {c.scope.acceptance_criteria} approved acceptance criteria, {c.scope.test_cases} approved test cases
          {c.scope.test_types.length ? `; test types in scope: ${c.scope.test_types.join(", ")}` : ""}.
        </p>
        <h3 className="text-body font-semibold text-fg-strong">Not tested</h3>
        <List items={c.not_tested.map((x) => `${x.item}: ${x.reason}`)} />
      </Section>
      <Section id="tc-deviations" title="Deviations from the test plan">
        <p className="text-body text-fg">{c.deviations_line}</p>
        {c.deviations.length > 0 && <List items={c.deviations.map((d) => `${d.case_key} · ${d.title}: ${d.deviation} (${d.reason})`)} />}
      </Section>
      <Section id="tc-measures" title="Test measures">
        <Table label="Test measures">
          <THead>
            <tr>
              <Th>Group</Th>
              <Th>Approved</Th>
              <Th>Executed</Th>
              <Th>Passed</Th>
              <Th>Failed</Th>
              <Th>Flaky</Th>
              <Th>Error</Th>
              <Th>Blocked</Th>
              <Th>Skipped</Th>
              <Th>Not run</Th>
            </tr>
          </THead>
          <TBody>
            {m.groups.map((b) => (
              <Tr key={b.group}>
                <Td rowHeader>{b.group}</Td>
                {(["approved", "executed", "passed", "failed", "flaky", "error", "blocked", "skipped", "not_run"] as const).map((k) => (
                  <Td key={k} className="tabular-nums">
                    {b[k]}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
        <p className="text-body text-fg">
          Requirements: {cov.requirements.with_approved_case} of {cov.requirements.approved} approved requirements have an approved test case ({cov.requirements.percent_approved_covered} %); {cov.execution.requirements.with_result} have a result.
        </p>
        <p className="text-body text-fg">
          Acceptance criteria: {cov.acceptance_criteria.covered} of {cov.acceptance_criteria.approved} approved acceptance criteria are covered by a test case ({cov.acceptance_criteria.percent} %).
        </p>
        <p className="text-body text-fg">
          Defects: {m.defects.total} recorded. By severity: {counted(m.defects.by_severity)}. By status: {counted(m.defects.by_status)}. By source: {counted(m.defects.by_source)}.
        </p>
        <h3 className="text-body font-semibold text-fg-strong">Runs</h3>
        {c.runs.length ? (
          <Table label="Runs">
            <THead>
              <tr>
                <Th>Run</Th>
                <Th>Status</Th>
                <Th>Selection</Th>
                <Th>Passed</Th>
                <Th>Failed</Th>
                <Th>Error</Th>
                <Th>Blocked</Th>
                <Th>Skipped</Th>
              </tr>
            </THead>
            <TBody>
              {c.runs.map((r) => (
                <Tr key={r.key}>
                  <Td rowHeader>{r.key}</Td>
                  <Td>{r.status}</Td>
                  <Td className="whitespace-normal">
                    {r.selection}
                    {r.change_set ? ` · regression after ${r.change_set}` : ""}
                  </Td>
                  {(["passed", "failed", "error", "blocked", "skipped"] as const).map((k) => (
                    <Td key={k} className="tabular-nums">
                      {r.totals[k] ?? 0}
                    </Td>
                  ))}
                </Tr>
              ))}
            </TBody>
          </Table>
        ) : (
          <p className="text-body text-fg">No finished run.</p>
        )}
      </Section>
      <Section id="tc-changes" title="Change sets and regression runs">
        <List
          items={c.change_sets.map((x) => `${x.key}: ${x.total} changes · ${x.regression_runs.length ? `regression runs: ${x.regression_runs.join(", ")}` : "no regression run"}`)}
          empty="No rescan has been compared yet."
        />
      </Section>
      <Section id="tc-exploratory" title="Exploratory sessions">
        {c.exploratory.sessions.length ? (
          <ul className="space-y-2 text-body text-fg">
            {c.exploratory.sessions.map((x) => (
              <li key={x.key} className="space-y-1">
                <p>
                  {x.key} · {x.status} · {x.actions ?? "—"} actions · {x.findings} findings ({x.open_high_medium} open high or medium)
                </p>
                {x.statement && <HonestyNote>{x.statement}</HonestyNote>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-fg">{c.exploratory.empty}</p>
        )}
      </Section>
      <Section id="tc-nf" title="Non-functional summary">
        <List items={c.non_functional.map((x) => `${x.type}${x.source ? ` (${x.source})` : ""}: ${x.text}`)} />
      </Section>
      <Section id="tc-exit" title="Exit criteria">
        <CriteriaTable rows={c.criteria} label="Exit criteria" />
        <h3 className="text-body font-semibold text-fg-strong">Conditions</h3>
        <Conditions rows={c.conditions} />
      </Section>
      <Section id="tc-residual" title="Residual risk">
        <Residual rows={c.residual} overall={c.overall_residual} />
      </Section>
      <Section id="tc-assets" title="Reusable assets">
        <p className="text-body text-fg">
          {c.assets.scripts.length} test scripts{c.assets.profiles.length ? `; load-test profiles: ${c.assets.profiles.map((x) => `${x.key} (${x.name})`).join(", ")}` : ""}.
        </p>
        {c.assets.scripts.length > 0 && <List items={c.assets.scripts.map((x) => `${x.path} v${x.version} · ${x.state}`)} />}
      </Section>
      <Section id="tc-limitations" title="Limitations">
        <List items={c.limitations} />
      </Section>
      <Section id="tc-lessons" title="Lessons learned">
        {c.lessons ? (
          <>
            <p className="whitespace-pre-line break-words text-body text-fg">{c.lessons.text}</p>
            <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
              {c.lessons.generated_by === "ai" && <GeneratedByLabel generatedBy="ai" />}
              {lessonsByline(c.lessons)}
            </p>
          </>
        ) : (
          <p className="text-body text-fg">No lessons learned were recorded.</p>
        )}
      </Section>
    </Article>
  );
}

export function Phase6ReportBody({ type, content, projectId }: { type: Phase6ReportType; content: unknown; projectId: string }) {
  if (type === "release_readiness") return <ReadinessBody c={content as ReadinessContent} />;
  return <CompletionBody c={content as CompletionContent} projectId={projectId} />;
}

// ---- Generate Test Completion Report (design P6 §11.1) --------------------------------------------------------

export function CompletionReportDialog({ open, onClose, assessment, onGenerated }: { open: boolean; onClose: () => void; assessment: Pick<ReleaseSummary, "key" | "assessed_at" | "created_at"> | null; onGenerated: (r: ReportSummary) => void }) {
  const p = useProject();
  const toast = useToast();
  const { user } = useAuth();
  const caps = useCapabilities(p.id);
  const aiOn = !!caps.data?.ai_enabled;
  const [basis, setBasis] = useState<"assessment" | "current">("assessment");
  const [lessons, setLessons] = useState("");
  // The suggestion and the server's token for it: the AI label is only sent (and only accepted) for it, unedited.
  const [aiText, setAiText] = useState<{ text: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const name = useId();
  useEffect(() => {
    if (open) {
      setBasis(assessment ? "assessment" : "current");
      setLessons("");
      setAiText(null);
      setError(null);
    }
  }, [open, assessment]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const unedited = aiText !== null && lessons.trim() === aiText.text.trim();

  async function suggest() {
    setSuggesting(true);
    setError(null);
    try {
      const r = await api<{ text: string; token: string }>(`/projects/${p.id}/reports/completion/lessons-suggestion`, { body: basis === "assessment" && assessment ? { run_key: assessment.key } : { basis: "current" } });
      setLessons(r.text);
      setAiText({ text: r.text, token: r.token });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSuggesting(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    const text = lessons.trim();
    try {
      const r = await api<ReportSummary>(`/projects/${p.id}/reports`, {
        body: {
          report_type: "completion",
          ...(basis === "assessment" && assessment ? { run_key: assessment.key } : { basis: "current" }),
          ...(text ? (unedited && aiText ? { lessons_learned: text, lessons_generated_by: "ai", lessons_token: aiText.token } : { lessons_learned: text, lessons_generated_by: "person" }) : {}),
        },
      });
      toast(COMPLETION_GENERATED);
      onGenerated(r);
    } catch (e) {
      setError(completionError(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }

  const radio = "flex min-h-6 cursor-pointer items-start gap-2 pointer-coarse:min-h-11";
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Generate Test Completion Report"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void generate()} loading={busy}>
            Generate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-1 text-body font-medium text-fg-strong">Based on</legend>
          <div className="space-y-2">
            {assessment && (
              <label className={radio}>
                <input type="radio" name={name} className="mt-1 h-4 w-4 shrink-0" checked={basis === "assessment"} onChange={() => setBasis("assessment")} />
                <span>
                  {assessment.key} · {fmtDateTime(assessment.assessed_at ?? assessment.created_at)} (recommended: matches the release decision)
                </span>
              </label>
            )}
            <label className={radio}>
              <input type="radio" name={name} className="mt-1 h-4 w-4 shrink-0" checked={basis === "current"} onChange={() => setBasis("current")} />
              <span>Current data, not tied to an assessment</span>
            </label>
          </div>
        </fieldset>
        <TextArea label="Lessons learned (optional)" rows={4} maxLength={4000} value={lessons} onChange={(e) => setLessons(e.target.value)} hint={lessonsHint(user?.full_name)} />
        {aiOn && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void suggest()} loading={suggesting} icon={<Sparkles className="h-4 w-4" aria-hidden />}>
              Suggest lessons learned
            </Button>
            {unedited && <GeneratedByLabel generatedBy="ai" />}
          </div>
        )}
        {error && (
          <div ref={errorRef} tabIndex={-1} className="focus:outline-none">
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- the report pages (`/reports/release-readiness`, `/reports/completion`; design P6 §4.1, §11.2) ------------

export function Phase6ReportPage({ type }: { type: Phase6ReportType }) {
  const p = useProject();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const { role } = useAuth();
  const member = role !== null && role !== "viewer";
  const def = REPORT_TYPES.find((t) => t.type === type)!;
  const base = `/projects/${p.id}/reports/${def.slug}`;
  const reports = useApi<ReportSummary[]>(`/projects/${p.id}/reports`, undefined, {
    refreshInterval: (d) => (d?.some((r) => r.status === "rendering") ? 3000 : 0),
  });
  const release = useReleaseOverview(p.id, releaseReachable(p.workflow));
  const list = useMemo(() => (reports.data ?? []).filter((r) => r.report_type === type).sort((a, b) => b.version - a.version), [reports.data, type]);
  const wantVersion = Number(params.get("version") ?? "");
  const wantKey = params.get("assessment");
  const byVersion = Number.isInteger(wantVersion) && wantVersion > 0 ? list.find((r) => r.version === wantVersion) : undefined;
  const chosen = byVersion ?? (wantKey ? list.find((r) => r.run_key === wantKey) : list.find((r) => r.status === "ready") ?? list[0]);
  const detail = useApi<ReportDetail>(chosen && chosen.status === "ready" ? `/reports/${chosen.id}` : null);
  const history = release.data?.history ?? [];
  const forKey = wantKey ? history.find((h) => h.key === wantKey) ?? null : null;
  const latestAssessment = forKey ?? history[0] ?? null;
  const hasAssessment = history.length > 0 || list.length > 0;
  const [downloading, setDownloading] = useState<DownloadFormat | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    document.title = `${def.name} · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [def.name, p.project?.name]);

  async function download(format: DownloadFormat) {
    if (!chosen) return;
    setDownloading(format);
    setAnnounce(preparingText(format));
    try {
      await downloadFile(`/reports/${chosen.id}/download?format=${format}`, phase2ReportFileName(hostOf(p.project?.primary_url) || "site", type, chosen.version, new Date(), format, chosen.run_key));
      setAnnounce("Report downloaded.");
      toast("Report downloaded.");
    } catch (err) {
      setAnnounce("");
      toast(err instanceof ApiError && err.status === 409 ? "The report is still being prepared. Try again in a moment." : err instanceof ApiError && err.status === 410 ? err.message : downloadFailedText(format), "error");
    } finally {
      setDownloading(null);
    }
  }

  /** Release Readiness Report on request (an older or out-of-date one); the completion report has its dialog. */
  async function generateReadiness(key: string | null) {
    setCreating(true);
    try {
      const r = await api<ReportSummary>(`/projects/${p.id}/reports`, { body: { report_type: type, ...(key ? { run_key: key } : {}) } });
      toast("Generating the report. It appears here when it’s ready.", "info");
      await reports.mutate();
      router.replace(`${base}?version=${r.version}`);
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? err.message : completionError(errorMessage(err)), "error");
    } finally {
      setCreating(false);
    }
  }

  // A newer version of the same report is being prepared (e.g. right after a Gate 9 decision): say so instead of
  // offering to generate a duplicate.
  const preparing = !!chosen && list.some((r) => r.status === "rendering" && r.version > chosen.version && (r.run_key ?? null) === (chosen.run_key ?? null));
  const generateButton =
    member && hasAssessment && !(type === "release_readiness" && preparing) ? (
      type === "completion" ? (
        <Button onClick={() => setDialog(true)}>Generate…</Button>
      ) : (
        <Button variant="secondary" onClick={() => void generateReadiness(wantKey ?? chosen?.run_key ?? null)} loading={creating}>
          Generate again<span className="sr-only"> for {wantKey ?? chosen?.run_key ?? "the latest assessment"}</span>
        </Button>
      )
    ) : null;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        {def.name}
      </h1>
      <div className="flex w-full flex-wrap items-end gap-3 sm:w-auto">
        {list.length > 0 && (
          <SelectField
            label="Version"
            value={String(chosen?.version ?? "")}
            onChange={(e) => router.replace(`${base}?version=${e.target.value}`)}
            options={[
              ...(chosen ? [] : [{ value: "", label: "Choose a version" }]),
              ...list.map((r) => ({ value: String(r.version), label: `Version ${r.version} · ${r.run_key ?? "current data"} · ${fmtDateTime(r.created_at)}` })),
            ]}
            wrapClassName="w-full sm:w-80"
          />
        )}
        {generateButton}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (reports.error && !reports.data) body = <ErrorState error={reports.error} title="Couldn’t load the report." message="Try again." onRetry={() => void reports.mutate()} />;
  else if (!reports.data || (!release.data && !release.error && releaseReachable(p.workflow) && !list.length)) body = <LoadingBlock label="Loading report…" />;
  else if (!hasAssessment) body = <EmptyState title={P6_NOT_AVAILABLE} action={<LinkButton href={`/projects/${p.id}/release-readiness`}>Open release readiness</LinkButton>} />;
  else if (!chosen)
    body = <EmptyState title={wantKey ? `No ${def.name} for ${wantKey} yet.` : `No ${def.name} yet.`} description={type === "completion" ? "Generate one when the test cycle ends. It is frozen when it’s generated." : undefined} action={generateButton ?? undefined} />;
  else if (chosen.status === "rendering") body = <LoadingBlock label="Preparing the report…" />;
  else if (chosen.status === "failed") body = <ErrorState error={null} title="Couldn’t create the report." message={chosen.error || "Generate it again to try again."} />;
  else if (detail.error && !detail.data) body = <ErrorState error={detail.error} title="Couldn’t load the report." message="Try again." onRetry={() => void detail.mutate()} />;
  else if (!detail.data) body = <LoadingBlock label="Loading report…" />;
  else {
    const content = detail.data.content as unknown as (ReadinessContent | CompletionContent) & { band?: string | null };
    const band = type === "release_readiness" ? (content as ReadinessContent).band : null;
    const approval = chosen.approval as (NonNullable<ReportSummary["approval"]> & { band?: string | null; decided_by?: { full_name?: string | null } | null }) | null | undefined;
    body = (
      <div className="space-y-4">
        <span role="status" className="sr-only">
          {announce}
        </span>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex flex-wrap items-center gap-2 text-body text-fg">
            {band ? (
              <span className="rounded-md bg-warning-bg px-2 py-0.5 text-small font-semibold text-warning-fg ring-1 ring-inset ring-warning-line">{band}</span>
            ) : type === "release_readiness" ? (
              <StatusPill status="approved" label={(content as ReadinessContent).decision_line} />
            ) : (
              <span className="text-small text-fg">{chosen.run_key ? `From ${chosen.run_key}` : "From current data"}</span>
            )}
            <span className="text-small text-fg-muted">
              Version {chosen.version} · generated {fmtDateTime(chosen.created_at)}
            </span>
          </p>
          <div className="no-print flex w-full flex-wrap gap-2 sm:w-auto">
            <Button onClick={() => void download("pdf")} loading={downloading === "pdf"} icon={<Download className="h-4 w-4" aria-hidden />}>
              {downloading === "pdf" ? "Preparing PDF…" : "Download PDF"}
            </Button>
            {(["html", "csv", "xlsx"] as const).map((f) => (
              <Button key={f} variant="secondary" onClick={() => void download(f)} loading={downloading === f}>
                {downloading === f ? preparingText(f) : `Download ${f.toUpperCase()}`}
              </Button>
            ))}
            <Button variant="secondary" onClick={() => window.print()} icon={<Printer className="h-4 w-4" aria-hidden />}>
              Print
            </Button>
          </div>
        </div>
        {preparing ? (
          <Callout tone="info" role="status">
            A new version for {chosen.run_key ?? "current data"} is being prepared. It appears here when it’s ready.
          </Callout>
        ) : (
          type === "release_readiness" &&
          chosen.is_latest_source === false && (
            <Callout tone="info">
              {chosen.run_key} changed after this version was generated
              {approval?.band ? `: ${approval.band.replace(/\.$/, "")}` : approval?.status === "approved" ? ": Gate 9 was decided" : ""}. Generate it again to include the change.
            </Callout>
          )
        )}
        <Phase6ReportBody type={type} content={detail.data.content} projectId={p.id} />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      {header}
      {body}
      <div className="no-print flex flex-wrap gap-2">
        <LinkButton href={`/projects/${p.id}/reports`} variant="ghost">
          All reports
        </LinkButton>
        <LinkButton href={`/projects/${p.id}/release-readiness`} variant="ghost">
          Open release readiness
        </LinkButton>
      </div>
      {type === "completion" && (
        <CompletionReportDialog
          open={dialog}
          onClose={() => setDialog(false)}
          assessment={latestAssessment}
          onGenerated={(r) => {
            setDialog(false);
            void reports.mutate();
            router.replace(`${base}?version=${r.version}`);
          }}
        />
      )}
    </div>
  );
}
