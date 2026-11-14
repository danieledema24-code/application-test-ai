"use client";

// Defect Analysis output (design P4 §9): "What failed and why" on the run page and the analysis panel on a result.
// The cause is always a Hypothesis; signals that read evidence are Observed. Changing the cause never changes the
// result's status.

import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  CLASSIFICATIONS,
  CONFIDENCE_TEXT,
  NO_DEFECT_TEXT,
  orderedGroups,
  reclassifyConsequence,
  type Classification,
  type ResultDetail,
  type RunDetail,
} from "@/lib/execution";
import { Button, Callout, LinkButton, Modal, TextArea } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { ClassificationLabel, DefectStatusPill, HypothesisLabel, ObservedLabel } from "@/components/domain/ExecutionLabels";

const EVIDENCE_TAB: Record<string, string> = { screenshot: "Screenshot", video: "Video", network_log: "Network log", console_log: "Console", trace: "Trace" };

export function WhatFailedCard({ run, projectId }: { run: RunDetail; projectId: string }) {
  const a = run.analysis;
  const failing = run.tests_rows.filter((r) => ["failed", "error", "flaky"].includes(r.status)).length;
  if (run.status === "passed" && !failing) return <p className="text-body text-fg">All {run.tests} tests passed. Nothing to analyse.</p>;
  if (!a) return null;
  if (a.status === "queued" || a.status === "running")
    return (
      <Callout tone="info" role="status">
        Working out why {failing} {failing === 1 ? "test" : "tests"} failed…
      </Callout>
    );
  if (a.status === "failed") return <Callout tone="danger">Couldn&apos;t analyse the failures: {a.error ?? "the analysis stopped"}. Results are unaffected.</Callout>;
  const out = a.output;
  if (!out || !out.groups.length) return null;
  const total = out.groups.reduce((n, g) => n + g.items.length, 0);
  const base = `/projects/${projectId}/execution/${run.key}/results`;
  return (
    <section aria-labelledby="what-failed" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 id="what-failed" className="text-h3 font-semibold text-fg-strong">
          What failed and why
        </h2>
        <span className="flex flex-wrap gap-2">
          <GeneratedByLabel generatedBy={a.generated_by ?? "rules"} />
          <HypothesisLabel />
        </span>
      </div>
      <div className="space-y-3 px-5 py-4">
        <p className="text-body font-medium text-fg-strong">
          {total} {total === 1 ? "test needs" : "tests need"} attention
        </p>
        <ul className="space-y-2">
          {orderedGroups(out.groups).map((g) => (
            <li key={g.classification} className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <span className="min-w-[16rem]">
                <ClassificationLabel classification={g.classification} /> <span className="tabular-nums text-fg">({g.items.length})</span>
              </span>
              <ul className="min-w-0 flex-1 space-y-1">
                {g.items.map((it) => (
                  <li key={it.result_key} className="flex flex-wrap items-center gap-x-2 text-body text-fg">
                    <span className="font-mono text-small">{it.case_key}</span>
                    <span>
                      ·{" "}
                      {it.defect
                        ? it.defect.occurrence
                          ? `added to ${it.defect.key}`
                          : `${it.defect.key} drafted`
                        : g.classification === "flaky"
                          ? "passed on retry; no defect"
                          : it.fix_suggestion
                            ? "a fix suggestion is ready"
                            : it.signal}
                    </span>
                    {it.defect ? (
                      <Link href={`/projects/${projectId}/defects?view=review`} className="text-small font-medium text-navy-700 underline underline-offset-2">
                        Review Gate 8<span className="sr-only"> for {it.defect.key}</span>
                      </Link>
                    ) : (
                      <Link href={`${base}/${it.result_key}`} className="text-small font-medium text-navy-700 underline underline-offset-2">
                        Open {it.case_key} result<span className="sr-only"> ({it.result_key})</span>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="text-small text-fg-muted">Only likely application bugs become defect drafts. Script, page and environment problems don&apos;t.</p>
      </div>
    </section>
  );
}

export function AnalysisPanel({ result, projectId, onChanged }: { result: ResultDetail; projectId: string; onChanged: (r: ResultDetail, message: string) => void }) {
  const a = result.analysis;
  const [open, setOpen] = useState(false);
  if (!a) {
    if (["failed", "error"].includes(result.status))
      return (
        <section aria-labelledby="why-failed" className="rounded-xl bg-surface p-5 ring-1 ring-line-strong">
          <h2 id="why-failed" className="text-h3 font-semibold text-fg-strong">
            Why it failed
          </h2>
          <p className="mt-2 text-body text-fg-muted">Not analysed yet. The analysis runs when the run finishes.</p>
        </section>
      );
    return null;
  }
  const setBy = a.overridden ? a.overridden.by_user?.full_name || a.overridden.by_user?.email || "a person" : null;
  const evidence = new Map((a.evidence_refs ?? []).map((e) => [e.kind, e.evidence_id]));
  const defect = a.defect ?? result.defect;
  return (
    <section aria-labelledby="why-failed" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 id="why-failed" className="text-h3 font-semibold text-fg-strong">
          Why it failed
        </h2>
        <span className="flex flex-wrap gap-2">
          <HypothesisLabel setBy={setBy} />
          <GeneratedByLabel generatedBy={a.generated_by} />
        </span>
      </div>
      <div className="space-y-4 px-5 py-4 text-body text-fg">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg-strong">Most likely cause:</span>
          <ClassificationLabel classification={a.classification} />
          {!a.overridden && <span>· Confidence: {CONFIDENCE_TEXT[a.confidence] ?? a.confidence}</span>}
        </p>
        {a.overridden && (
          <div className="space-y-1">
            <p>
              Cause set by {setBy}: &apos;{a.overridden.reason}&apos;
            </p>
            <p className="text-small text-fg-muted">
              Previously:{" "}
              <s>
                {a.overridden.previous.label ?? a.overridden.previous.classification}
                {a.overridden.previous.confidence ? `, ${a.overridden.previous.confidence}` : ""}
              </s>
              <span className="sr-only">
                {" "}
                (was: {a.overridden.previous.label ?? a.overridden.previous.classification}
                {a.overridden.previous.confidence ? `, ${a.overridden.previous.confidence}` : ""})
              </span>
            </p>
          </div>
        )}
        {a.signals.length > 0 && (
          <div>
            <h3 className="text-body font-semibold text-fg-strong">Why we think so</h3>
            <ul className="mt-1 space-y-1.5">
              {a.signals.map((s) => (
                <li key={s.code} className="flex flex-wrap items-center gap-2">
                  <CircleCheck className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
                  <span>{s.detail}</span>
                  {s.observed && <ObservedLabel />}
                  {s.evidence.map((k) =>
                    evidence.has(k) || EVIDENCE_TAB[k] ? (
                      <a key={k} href="#evidence-title" className="text-small font-medium text-navy-700 underline underline-offset-2">
                        {EVIDENCE_TAB[k] ?? k}
                        <span className="sr-only"> for this signal</span>
                      </a>
                    ) : null,
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {a.possible_causes.length > 0 && (
          <div>
            <h3 className="text-body font-semibold text-fg-strong">Possible causes</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {a.possible_causes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {a.next_steps.length > 0 && (
          <div>
            <h3 className="text-body font-semibold text-fg-strong">What to do next</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {a.next_steps.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {defect ? (
          <p className="flex flex-wrap items-center gap-2">
            {defect.occurrence ? (
              <span>
                Added as an occurrence of {defect.key} (same test, same failed step).
              </span>
            ) : (
              <span>
                Defect: {defect.key} {defect.summary} ·
              </span>
            )}
            <DefectStatusPill status={defect.status} withNote={false} />
            <Link href={`/projects/${projectId}/defects/${defect.key}`} className="font-medium text-navy-700 underline underline-offset-2">
              Open {defect.key}
            </Link>
          </p>
        ) : a.no_defect ? (
          <p className="flex flex-wrap items-center gap-2">
            {NO_DEFECT_TEXT[a.no_defect]}
            {a.no_defect === "low_confidence" && result.permissions.can_raise_defect && (
              <LinkButton size="sm" href={`/projects/${projectId}/defects/new?from=${result.key}`}>
                Raise defect…
              </LinkButton>
            )}
          </p>
        ) : null}
        {result.permissions.can_reclassify && (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Change the cause…
          </Button>
        )}
      </div>
      <ReclassifyDialog open={open} onClose={() => setOpen(false)} result={result} onDone={(r, m) => (setOpen(false), onChanged(r, m))} />
    </section>
  );
}

export function ReclassifyDialog({ open, onClose, result, onDone }: { open: boolean; onClose: () => void; result: ResultDetail; onDone: (r: ResultDetail, message: string) => void }) {
  const current = (result.analysis?.classification ?? "unknown") as Classification;
  const [to, setTo] = useState<Classification>(current);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTo(current);
      setReason("");
      setErr(null);
    }
  }, [open, current]);
  const defectKey = result.analysis?.defect?.key ?? result.defect?.key ?? null;
  const consequence = reclassifyConsequence(to, current, defectKey);
  async function save() {
    if (!reason.trim()) {
      setErr("Say why you think the cause is different.");
      return;
    }
    if (to === current) {
      setErr("Choose a different cause.");
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ message: string; result: ResultDetail }>(`/execution-results/${result.id}/classification`, { method: "POST", body: { classification: to, reason: reason.trim() } });
      onDone(r.result, r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change the cause"
      description="This changes the likely cause only. The test result stays Failed."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Change the cause
          </Button>
        </>
      }
    >
      <fieldset className="space-y-1">
        <legend className="mb-1 text-body font-medium text-fg-strong">Likely cause</legend>
        {(Object.keys(CLASSIFICATIONS) as Classification[]).map((c) => (
          <label key={c} className="flex min-h-11 items-start gap-2">
            <input type="radio" name="cause" className="mt-1 h-4 w-4" checked={to === c} onChange={() => setTo(c)} />
            <span>
              <span className="font-medium text-fg-strong">{CLASSIFICATIONS[c].label}</span>
              <span className="block text-small text-fg-muted">{CLASSIFICATIONS[c].meaning}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <TextArea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} rows={2} error={err ?? undefined} wrapClassName="mt-3" maxLength={2000} />
      {consequence && <p className="mt-2 text-small text-fg">{consequence}</p>}
    </Modal>
  );
}
