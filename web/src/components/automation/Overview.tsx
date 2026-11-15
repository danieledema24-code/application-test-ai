"use client";

// Automation › Overview (design P4 §6.2): can these cases be automated, can the scripts run, and what the checks mean.

import { useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleX, Lock, TriangleAlert, UserRound } from "lucide-react";
import {
  CHECK_LEGEND,
  CHECK_ORDER,
  CHECK_TEXT,
  SUITABILITY_TEXT,
  assessmentSentence,
  exportFileName,
  exportPath,
  validationSentence,
  type AssessedCase,
  type AutomationAssessment,
  type AutomationOverview,
  type Suitability,
} from "@/lib/automation";
import { fmtDateTime } from "@/lib/format";
import { Button, Card, Disclosure, useToast } from "@/components/ui";
import { ApiError, downloadFile } from "@/lib/api";

const GROUP_ICON: Record<Suitability, typeof CircleCheck> = { suitable: CircleCheck, partial: Lock, manual_only: UserRound };
const GROUP_LINK: Record<Suitability, (n: number) => string> = {
  suitable: (n) => `Show ${n} ${n === 1 ? "case that can" : "cases that can"} be automated`,
  partial: (n) => `Show ${n} ${n === 1 ? "case" : "cases"} needing credentials`,
  manual_only: (n) => `Show ${n} ${n === 1 ? "case that needs" : "cases that need"} a person`,
};

function CaseLine({ c, projectId, reason }: { c: AssessedCase; projectId: string; reason: boolean }) {
  return (
    <li className="text-body">
      <Link href={`/projects/${projectId}/test-cases/${c.key}`} className="text-navy-700 underline underline-offset-2">
        <span className="font-mono">{c.key}</span> {c.title}
      </Link>
      {reason && c.reasons[0] && <span className="block text-small text-fg">“{c.reasons[0]}”</span>}
    </li>
  );
}

function SuitabilityGroup({ kind, cases, projectId, canEdit }: { kind: Suitability; cases: AssessedCase[]; projectId: string; canEdit: boolean }) {
  const Icon = GROUP_ICON[kind];
  const shown = kind === "manual_only" ? cases.slice(0, 3) : [];
  return (
    <li className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-fg-strong">
          <Icon className="h-4 w-4 text-fg-muted" aria-hidden />
          {SUITABILITY_TEXT[kind]} ({cases.length})
        </p>
        {kind === "partial" && canEdit && cases.length > 0 && (
          <Link href={`/projects/${projectId}/settings#credentials`} className="text-small font-medium text-navy-700 underline underline-offset-2">
            Add test credentials
          </Link>
        )}
      </div>
      {kind === "partial" && cases.length > 0 && <p className="text-small text-fg">Their scripts are written but are blocked in runs until test credentials are saved.</p>}
      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((c) => (
            <CaseLine key={c.key} c={c} projectId={projectId} reason />
          ))}
        </ul>
      )}
      {cases.length > shown.length && (
        <Disclosure label={GROUP_LINK[kind](cases.length)} openLabel={`Hide ${SUITABILITY_TEXT[kind].toLowerCase()} cases`}>
          <ul className="mt-2 space-y-2">
            {cases.map((c) => (
              <CaseLine key={c.key} c={c} projectId={projectId} reason={kind !== "suitable"} />
            ))}
          </ul>
        </Disclosure>
      )}
    </li>
  );
}

export function SuitabilitySummary({ assessment, projectId, canEdit }: { assessment: AutomationAssessment; projectId: string; canEdit: boolean }) {
  const by = (k: Suitability) => assessment.cases.filter((c) => c.suitability === k);
  return (
    <Card as="section" className="space-y-3 p-5">
      <h2 id="suitability-h" className="text-h3 font-semibold text-fg-strong">
        Can these test cases be automated?
      </h2>
      <p className="text-body text-fg-strong">{assessmentSentence(assessment.counts)}</p>
      <ul className="space-y-3">
        {(["suitable", "partial", "manual_only"] as Suitability[]).map((k) => (
          <SuitabilityGroup key={k} kind={k} cases={by(k)} projectId={projectId} canEdit={canEdit} />
        ))}
      </ul>
    </Card>
  );
}

export function ValidationLegend() {
  return (
    <Disclosure label="What do these mean?">
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-small sm:grid-cols-[10rem_1fr]">
        {CHECK_ORDER.map((c) => (
          <div key={c} className="contents">
            <dt className="font-semibold text-fg-strong">{CHECK_TEXT[c]}</dt>
            <dd className="text-fg">{CHECK_LEGEND[c]}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

export function ValidationSummary({ overview, scriptsHref }: { overview: AutomationOverview; scriptsHref: (file: string) => string }) {
  const b = overview.bundle;
  if (!b) return null;
  const invalid = b.scripts.filter((s) => s.status === "invalid");
  const unchecked = b.scripts.filter((s) => s.status === "valid" && s.checks.locators === "not_checked");
  const counts = { ...b.counts, ...(b.validation.counts ?? {}) };
  return (
    <Card as="section" className="space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="validation-h" className="text-h3 font-semibold text-fg-strong">
          Can the scripts run?
        </h2>
        {b.validation.checked_at && <p className="text-small text-fg-muted">Checked {fmtDateTime(b.validation.checked_at)}</p>}
      </div>
      <p className="text-body text-fg-strong">{validationSentence(counts)}</p>
      {invalid.length > 0 && (
        <ul className="space-y-1">
          {invalid.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start gap-2 text-body">
              <CircleX className="mt-0.5 h-4 w-4 text-danger-fg" aria-hidden />
              <span className="sr-only">Can’t run:</span>
              <span className="min-w-0 flex-1">
                <span className="font-mono">{s.case_key}</span> {s.case_title}
                {s.first_problem ? ` · ${s.first_problem.replace(/^Line \d+: /, "")}` : ""}
              </span>
              <Link href={scriptsHref(s.path)} className="text-small font-medium text-navy-700 underline underline-offset-2">
                Open {s.case_key} script
              </Link>
            </li>
          ))}
        </ul>
      )}
      {unchecked.length > 0 && (
        <p className="flex items-start gap-2 text-body">
          <TriangleAlert className="mt-0.5 h-4 w-4 text-warning-fg" aria-hidden />
          <span>
            {unchecked.map((s) => s.case_key).join(", ")}: not checked on the live page (needs sign-in; no test credentials saved)
          </span>
        </p>
      )}
      <p className="text-small text-fg">Checks every script passes: {CHECK_ORDER.map((c) => CHECK_TEXT[c]).join(" · ")}</p>
      {(b.ai_checks?.length ?? 0) > 0 && (
        <Disclosure label={`Checks on AI scripts (${b.ai_checks!.length})`}>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-fg">
            {b.ai_checks!.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Disclosure>
      )}
      <ValidationLegend />
    </Card>
  );
}

export function NotAutomatedCard({ overview, projectId }: { overview: AutomationOverview; projectId: string }) {
  const items = overview.bundle?.not_automated ?? [];
  if (!items.length) return null;
  return (
    <Card as="section" className="space-y-2 p-5">
      <h2 id="not-automated-h" className="text-h3 font-semibold text-fg-strong">
        Not automated ({items.length})
      </h2>
      <p className="text-small text-fg">These approved cases are tested by a person. Recording manual results in the app isn&apos;t available yet.</p>
      <Disclosure label={`Show ${items.length} not automated ${items.length === 1 ? "case" : "cases"}`}>
        <ul className="mt-2 space-y-2">
          {items.map((c) => (
            <li key={c.key} className="text-body">
              <Link href={`/projects/${projectId}/test-cases/${c.key}`} className="text-navy-700 underline underline-offset-2">
                <span className="font-mono">{c.key}</span> {c.title}
              </Link>
              <span className="block text-small text-fg">{c.reason}</span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </Card>
  );
}

/** "Use the scripts outside this app" (design P4 §6.2, P4-10). The CI templates are inside the zip. */
export function ExportCard({ overview, projectId, host, canEdit }: { overview: AutomationOverview; projectId: string; host: string; canEdit: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const b = overview.bundle;
  const exp = b?.export;
  if (!b || !exp || exp.scripts === 0) return null;
  const left = exp.left_out;
  const n = exp.scripts;
  async function download() {
    if (!b) return;
    setBusy(true);
    try {
      await downloadFile(exportPath(projectId, b.version, b.is_current), exportFileName(host, b.version));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t download the project. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="export-h" className="min-w-0 space-y-3 rounded-lg border border-line bg-surface p-5 shadow-xs">
      <h2 id="export-h" className="text-h3 font-semibold text-fg-strong">
        Use the scripts outside this app
      </h2>
      <p className="text-body text-fg">
        Download a standalone Playwright project with the {n} valid {n === 1 ? "script" : "scripts"}, plus CI templates for GitHub Actions and GitLab CI.
      </p>
      {canEdit ? (
        <Button variant="secondary" onClick={() => void download()} disabled={busy} aria-describedby={left.length ? "export-left" : undefined}>
          Download Playwright project (v{b.version}, zip)
        </Button>
      ) : (
        <p className="text-small text-fg-muted">Members and approvers can download the project.</p>
      )}
      {left.length > 0 && (
        <p id="export-left" className="text-small text-fg">
          {left.length === 1 ? "1 script is" : `${left.length} scripts are`} left out because {left.length === 1 ? "it" : "they"} can&apos;t run:{" "}
          {left.map((x) => x.case_key).join(", ")}. The project&apos;s README lists {left.length === 1 ? "it" : "them"}.
        </p>
      )}
    </section>
  );
}

export function AssessAction({ canEdit, onAssess, busy }: { canEdit: boolean; onAssess: () => void; busy: boolean }) {
  if (!canEdit) return <p className="text-body text-fg-muted">A member, owner or admin can start this.</p>;
  return (
    <Button onClick={onAssess} loading={busy}>
      Assess automation
    </Button>
  );
}
