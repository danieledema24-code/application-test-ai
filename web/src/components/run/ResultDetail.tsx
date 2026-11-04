"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Bug, Lightbulb, Save, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, fmtDuration, humanize, personName } from "@/lib/format";
import type { DefectDraft, Evidence, FailureAnalysis, ResultStatus, StepResult, TestCase, TestResult, TestRunDetail, TestStep } from "@/lib/types";
import { Button, InlineError, StatusPill, TextArea, inputClass, useToast } from "@/components/ui";
import { EvidenceGallery } from "@/components/domain/Evidence";
import { ApiExchangeView } from "@/components/domain/ApiExchangeView";
import { FailureAnalysisCard } from "@/components/domain/AiBits";
import { DefectFormModal } from "@/components/domain/DefectFormModal";

const STEP_OPTIONS: { status: ResultStatus; label: string; active: string }[] = [
  { status: "PASSED", label: "Passed", active: "bg-emerald-500/20 text-emerald-200 ring-emerald-400" },
  { status: "FAILED", label: "Failed", active: "bg-red-500/20 text-red-200 ring-red-400" },
  { status: "BLOCKED", label: "Blocked", active: "bg-amber-500/20 text-amber-200 ring-amber-400" },
  { status: "NOT_EXECUTED", label: "Not executed", active: "bg-white/10 text-fg-strong ring-fg-subtle" },
];

function StatusButtons({ value, onChange, label }: { value: ResultStatus; onChange: (s: ResultStatus) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {STEP_OPTIONS.map((o) => (
        <button
          key={o.status}
          type="button"
          role="radio"
          aria-checked={value === o.status}
          onClick={() => onChange(o.status)}
          className={`rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${value === o.status ? o.active : "bg-elevated text-fg-muted ring-line-strong hover:bg-overlay hover:text-fg-strong"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function deriveStatus(steps: StepResult[]): ResultStatus {
  if (steps.some((s) => s.status === "FAILED")) return "FAILED";
  if (steps.some((s) => s.status === "BLOCKED")) return "BLOCKED";
  if (steps.length > 0 && steps.every((s) => s.status === "PASSED")) return "PASSED";
  return "NOT_EXECUTED";
}

function ManualExecution({ result, steps, onChanged }: { result: TestResult; steps: TestStep[]; onChanged: () => void }) {
  const toast = useToast();
  const initialSteps: StepResult[] = steps.map((_, i) => {
    const existing = result.stepResults?.find((s) => s.index === i);
    return existing || { index: i, status: "NOT_EXECUTED" };
  });
  const [stepResults, setStepResults] = useState<StepResult[]>(initialSteps);
  const [overall, setOverall] = useState<ResultStatus>(result.status);
  const [overridden, setOverridden] = useState(result.status !== "NOT_EXECUTED");
  const [actual, setActual] = useState(result.actualResult || "");
  const [errorMessage, setErrorMessage] = useState(result.errorMessage || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function updateStep(i: number, patch: Partial<StepResult>) {
    const next = stepResults.map((s) => (s.index === i ? { ...s, ...patch } : s));
    setStepResults(next);
    if (!overridden) setOverall(deriveStatus(next));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/test-results/${result.id}`, {
        method: "PATCH",
        body: {
          status: overall,
          stepResults: stepResults.map((s) => ({ index: s.index, status: s.status, ...(s.note ? { note: s.note } : {}), ...(s.actual ? { actual: s.actual } : {}) })),
          actualResult: actual,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
      toast(`${result.testCaseKey} recorded as ${humanize(overall).toLowerCase()}`);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (fileNote.trim()) fd.append("note", fileNote.trim());
      await api<Evidence>(`/test-results/${result.id}/evidence`, { body: fd });
      toast("Evidence uploaded");
      setFile(null);
      setFileNote("");
      if (fileRef.current) fileRef.current.value = "";
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      {steps.length === 0 ? (
        <p className="text-sm text-fg-muted">This test case has no steps; record the overall result below.</p>
      ) : (
        <ol className="space-y-3">
          {steps.map((step, i) => {
            const sr = stepResults[i];
            return (
              <li key={i} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg-strong">
                      <span className="mr-1.5 font-semibold text-fg-muted">{i + 1}.</span>
                      {step.action}
                    </p>
                    {step.expected && <p className="mt-0.5 text-xs text-fg-muted">Expected: {step.expected}</p>}
                  </div>
                  <StatusButtons label={`Step ${i + 1} result`} value={sr.status} onChange={(s) => updateStep(i, { status: s })} />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`${result.id}-s${i}-actual`} className="sr-only">
                      Step {i + 1} actual result
                    </label>
                    <input id={`${result.id}-s${i}-actual`} className={`${inputClass} text-xs`} placeholder="Actual result (optional)" value={sr.actual || ""} onChange={(e) => updateStep(i, { actual: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor={`${result.id}-s${i}-note`} className="sr-only">
                      Step {i + 1} note
                    </label>
                    <input id={`${result.id}-s${i}-note`} className={`${inputClass} text-xs`} placeholder="Note (optional)" value={sr.note || ""} onChange={(e) => updateStep(i, { note: e.target.value })} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-fg-strong">
            Overall result {!overridden && steps.length > 0 && <span className="text-xs font-normal text-fg-muted">(derived from steps)</span>}
          </p>
          <StatusButtons
            label="Overall result"
            value={overall}
            onChange={(s) => {
              setOverall(s);
              setOverridden(true);
            }}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextArea label="Actual result" rows={2} value={actual} onChange={(e) => setActual(e.target.value)} />
          <TextArea label="Error / failure details" rows={2} value={errorMessage} onChange={(e) => setErrorMessage(e.target.value)} />
        </div>
        <div className="mt-3">
          <InlineError error={error} />
        </div>
        <Button className="mt-3" icon={<Save className="h-4 w-4" aria-hidden />} loading={saving} onClick={save}>
          Save result
        </Button>
      </div>

      <div className="rounded-lg border border-dashed border-line-strong bg-surface p-3">
        <p className="text-sm font-medium text-fg-strong">Upload evidence</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`${result.id}-file`} className="sr-only">
              Evidence file
            </label>
            <input
              id={`${result.id}-file`}
              ref={fileRef}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block text-sm text-fg file:mr-3 file:rounded-md file:border-0 file:bg-overlay file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-fg hover:file:bg-overlay"
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label htmlFor={`${result.id}-file-note`} className="sr-only">
              Evidence note
            </label>
            <input id={`${result.id}-file-note`} className={inputClass} placeholder="Note (optional)" value={fileNote} onChange={(e) => setFileNote(e.target.value)} />
          </div>
          <Button variant="secondary" icon={<Upload className="h-4 w-4" aria-hidden />} disabled={!file} loading={uploading} onClick={upload}>
            Upload
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecordedSteps({ steps: caseSteps, stepResults }: { steps: TestStep[]; stepResults: StepResult[] }) {
  // Automated and API runs record their own labelled steps (script steps / assertions);
  // only manual results line up index-for-index with the test case's steps.
  const labelled = stepResults.some((s) => s.label);
  const steps: TestStep[] = labelled ? [] : caseSteps;
  const count = Math.max(steps.length, ...stepResults.map((s) => s.index + 1), 0);
  if (count === 0) return null;
  return (
    <ol className="space-y-1.5">
      {Array.from({ length: count }).map((_, i) => {
        const step = steps[i];
        const sr = stepResults.find((s) => s.index === i);
        return (
          <li key={i} className="flex flex-wrap items-start gap-3 rounded-md bg-surface px-3 py-2 ring-1 ring-line">
            <span className="w-5 text-xs font-semibold text-fg-muted">{i + 1}.</span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="text-fg-strong">{step?.action || sr?.label || `Step ${i + 1}`}</p>
              {step?.expected && <p className="text-xs text-fg-muted">Expected: {step.expected}</p>}
              {sr?.actual && <p className="text-xs text-fg">Actual: {sr.actual}</p>}
              {sr?.note && <p className="text-xs text-fg">Note: {sr.note}</p>}
            </div>
            <StatusPill status={sr?.status || "NOT_EXECUTED"} />
          </li>
        );
      })}
    </ol>
  );
}

export function ResultDetail({ result, run, onChanged }: { result: TestResult; run: TestRunDetail; onChanged: () => void }) {
  const toast = useToast();
  // TestResult doesn't carry the case's step definitions, so fetch the case for step text.
  const { data: testCase } = useApi<TestCase>(result.testCaseId ? `/test-cases/${result.testCaseId}` : null);
  const steps = result.steps || testCase?.steps || [];
  const [analysis, setAnalysis] = useState<FailureAnalysis | null>(result.failureAnalysis);
  const [analysing, setAnalysing] = useState(false);
  const [defectOpen, setDefectOpen] = useState(false);
  const [draft, setDraft] = useState<DefectDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<unknown>(null);

  const isManualEditable = run.executionType === "MANUAL" && run.status === "IN_PROGRESS";
  const failed = result.status === "FAILED" || result.status === "ERROR";

  async function analyse() {
    setAnalysing(true);
    try {
      const a = await api<FailureAnalysis>(`/test-results/${result.id}/analyse`, { method: "POST" });
      setAnalysis(a);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Analysis failed", "error");
    } finally {
      setAnalysing(false);
    }
  }

  async function openDefect() {
    setDefectOpen(true);
    setDraft(null);
    setDraftError(null);
    setDraftLoading(true);
    try {
      const d = await api<DefectDraft>(`/test-results/${result.id}/defect-draft`, { method: "POST" });
      setDraft({ ...d, environmentName: d.environmentName || run.environmentName });
    } catch (e) {
      setDraftError(e);
      setDraft({
        title: `${result.testCaseKey}: ${result.testCaseTitle} failed`,
        actualResult: result.actualResult || result.errorMessage || "",
        environmentName: run.environmentName,
      });
    } finally {
      setDraftLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-fg-muted">
        <div>
          <dt className="inline">Duration: </dt>
          <dd className="inline font-medium text-fg-strong">{fmtDuration(result.durationMs)}</dd>
        </div>
        {result.scriptVersion !== null && (
          <div>
            <dt className="inline">Script: </dt>
            <dd className="inline font-medium text-fg-strong">v{result.scriptVersion}</dd>
          </div>
        )}
        <div>
          <dt className="inline">Executed: </dt>
          <dd className="inline font-medium text-fg-strong">
            {fmtDateTime(result.executedAt)} {result.executedBy ? `by ${personName(result.executedBy)}` : ""}
          </dd>
        </div>
        <div>
          <Link href={`/test-cases/${result.testCaseId}`} className="font-medium text-accent hover:underline">
            Open test case
          </Link>
        </div>
      </dl>

      {isManualEditable ? (
        testCase || result.steps ? (
          <ManualExecution result={result} steps={steps} onChanged={onChanged} />
        ) : (
          <p className="text-sm text-fg-muted">Loading steps…</p>
        )
      ) : (
        <>
          {(steps.length > 0 || result.stepResults?.length > 0) && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">Steps</h4>
              <RecordedSteps steps={steps} stepResults={result.stepResults || []} />
            </section>
          )}
          {result.actualResult && (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Actual result</h4>
              <p className="whitespace-pre-wrap text-sm text-fg">{result.actualResult}</p>
            </section>
          )}
        </>
      )}

      {result.errorMessage && !isManualEditable && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Error</h4>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-red-500/10 p-3 font-mono text-xs text-red-200 ring-1 ring-inset ring-red-500/30">{result.errorMessage}</pre>
        </section>
      )}

      {result.apiExchange && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">API exchange</h4>
          <ApiExchangeView exchange={result.apiExchange} />
        </section>
      )}

      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">Evidence ({result.evidence?.length || 0})</h4>
        <EvidenceGallery evidence={result.evidence || []} />
      </section>

      {failed && (
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<Lightbulb className="h-4 w-4" aria-hidden />} loading={analysing} onClick={analyse}>
              {analysis ? "Re-analyse failure" : "Analyse failure"}
            </Button>
            {result.defectId ? (
              <Link href={`/defects/${result.defectId}`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-red-300 ring-1 ring-inset ring-red-500/30 hover:bg-red-500/10">
                <Bug className="h-4 w-4" aria-hidden /> View linked defect
              </Link>
            ) : (
              <Button variant="danger" size="sm" icon={<Bug className="h-4 w-4" aria-hidden />} onClick={openDefect}>
                Create defect
              </Button>
            )}
          </div>
          {analysis && <FailureAnalysisCard analysis={analysis} />}
        </section>
      )}

      <DefectFormModal
        open={defectOpen}
        onClose={() => setDefectOpen(false)}
        projectId={run.projectId}
        testResultId={result.id}
        draft={draft}
        draftLoading={draftLoading}
        draftError={draftError ? "Couldn’t prepare an AI draft; fields were prefilled from the result instead." : null}
        aiDrafted={!draftError}
        onCreated={() => onChanged()}
      />
    </div>
  );
}
