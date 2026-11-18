"use client";

// Results of an exploratory session (design P6 §9.6–9.7): findings, "Not tried and blocked" (blocked write attempts
// with their reasons, "Not tried: may change data", "Never reached"), the full step log with an outcome filter, and
// coverage per page. Empty lists read "None." and are never hidden. The finding drawer follows the P5 FindingDrawer
// structure: numbered steps to reproduce, before/after screenshots with alts, redacted console and network, triage
// and Raise defect.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { RemovedEvidence, removedText } from "@/components/domain/RemovedEvidence";
import {
  AUTO_DRAFT_LINE,
  BLOCKED_NOTE,
  findingDetails,
  OUTCOME_LABEL,
  RULE_NAMES,
  screenshotAlt,
  type Session,
  type Step,
  type StepOutcome,
} from "@/lib/exploratory";
import { durationShort, type Finding } from "@/lib/nonfunctional";
import { Button, ConfirmDialog, Disclosure, Drawer, InlineError, Segmented, SelectField, Skeleton, Table, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { ObservedLabel } from "@/components/domain/ExecutionLabels";
import { FindingStatusLabel, SeenBefore, Severity } from "@/components/domain/NonFunctionalLabels";
import { TriageDialog } from "@/components/nonfunctional/CheckResults";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { StepLog } from "./LiveExploreView";

export type ResultsView = "findings" | "not-tried" | "steps" | "coverage";
const H2 = "text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted";
const none = <p className="text-body text-fg">None.</p>;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ findings (§9.6)

function FindingsView({ findings, open, projectId }: { findings: Finding[]; open: (k: string) => void; projectId: string }) {
  if (!findings.length) return none;
  const what = (f: Finding) => (
    <button type="button" className="text-left font-medium text-navy-700 underline underline-offset-2 [overflow-wrap:anywhere]" onClick={() => open(f.key)} aria-label={`Open ${f.key}: ${f.title}`}>
      {f.title}
    </button>
  );
  const defect = (f: Finding) =>
    f.defect ? (
      <Link href={`/projects/${projectId}/defects/${f.defect.key}`} className="font-medium underline underline-offset-2">
        {f.defect.key} {cap(f.defect.status)}
      </Link>
    ) : (
      "—"
    );
  return (
    <>
      <div className="hidden md:block">
        <Table label={`Findings (${findings.length})`}>
          <THead>
            <tr>
              <Th>Severity</Th>
              <Th>What</Th>
              <Th>Page</Th>
              <Th>Step</Th>
              <Th>Status</Th>
              <Th>Defect</Th>
            </tr>
          </THead>
          <TBody>
            {findings.map((f) => (
              <Tr key={f.id}>
                <Td>
                  <Severity severity={f.severity} />
                </Td>
                <Td rowHeader>{what(f)}</Td>
                <Td className="break-all font-mono text-xs">{f.path}</Td>
                <Td>{findingDetails(f).step ? `step ${findingDetails(f).step}` : "—"}</Td>
                <Td>
                  <FindingStatusLabel status={f.status} />
                </Td>
                <Td>{defect(f)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="space-y-3 md:hidden" aria-label={`Findings (${findings.length})`}>
        {findings.map((f) => (
          <li key={f.id} className="space-y-1 rounded-lg bg-surface p-4 ring-1 ring-line">
            <p className="flex flex-wrap items-center gap-2">
              <Severity severity={f.severity} />
              <FindingStatusLabel status={f.status} />
            </p>
            <p>{what(f)}</p>
            <p className="text-small text-fg [overflow-wrap:anywhere]">
              {f.path} · {findingDetails(f).step ? `step ${findingDetails(f).step}` : "—"} · Defect: {defect(f)}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ not tried and blocked (§9.6)

function NotTriedView({ session }: { session: Session }) {
  const blocked = session.blocked ?? [];
  const notTried = session.not_tried ?? [];
  const never = session.never_reached ?? [];
  return (
    <div className="space-y-6">
      <section aria-labelledby="blocked-h" className="space-y-2">
        <h2 id="blocked-h" className={H2}>
          Blocked write attempts ({blocked.length})
        </h2>
        {blocked.length === 0 ? (
          none
        ) : (
          <>
            <Table label={`Blocked write attempts (${blocked.length})`}>
              <THead>
                <tr>
                  <Th>Request</Th>
                  <Th>After</Th>
                  <Th>Step</Th>
                </tr>
              </THead>
              <TBody>
                {blocked.map((b, i) => (
                  <Tr key={`${b.step}-${b.request}-${i}`}>
                    <Td rowHeader className="break-all font-mono text-xs">
                      {b.request}
                      {b.reason && <span className="mt-1 block font-sans text-small font-normal text-fg">{b.reason}</span>}
                    </Td>
                    <Td className="[overflow-wrap:anywhere]">{b.after}</Td>
                    <Td>{b.step}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <p className="text-small text-fg">{BLOCKED_NOTE}</p>
          </>
        )}
      </section>
      <section aria-labelledby="nottried-h" className="space-y-2">
        <h2 id="nottried-h" className={H2}>
          Not tried: may change data ({notTried.length})
        </h2>
        {notTried.length === 0 ? (
          none
        ) : (
          <Table label={`Not tried: may change data (${notTried.length})`}>
            <THead>
              <tr>
                <Th>Element</Th>
                <Th>Page</Th>
                <Th>Why not tried</Th>
              </tr>
            </THead>
            <TBody>
              {notTried.map((n) => (
                <Tr key={`${n.fingerprint}-${n.page}`}>
                  <Td rowHeader className="[overflow-wrap:anywhere]">{n.element}</Td>
                  <Td className="break-all font-mono text-xs">{n.page}</Td>
                  <Td>
                    {n.reason}
                    {n.destination && <span className="block break-all text-small text-fg-muted">Would have opened {n.destination}</span>}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </section>
      <section aria-labelledby="never-h" className="space-y-2">
        <h2 id="never-h" className={H2}>
          Never reached ({never.length})
        </h2>
        {never.length === 0 ? (
          none
        ) : (
          <Disclosure label={session.end_reason === "unreached" ? `These allowed actions couldn't be reached (${never.length})` : `The budget ran out before these were tried (${never.length})`}>
            <ul className="list-disc space-y-1 pl-5 text-small text-fg [overflow-wrap:anywhere]">
              {never.map((x, i) => (
                <li key={`${x.page}-${x.element}-${i}`}>
                  {x.element} · {x.page}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ step log and coverage (§9.6)

const OUTCOME_FILTER: { value: "" | StepOutcome; label: string }[] = [
  { value: "", label: "Any" },
  ...(Object.keys(OUTCOME_LABEL) as StepOutcome[]).map((k) => ({ value: k, label: OUTCOME_LABEL[k] })),
];

function StepsView({ steps, open }: { steps: Step[]; open: (k: string) => void }) {
  const [outcome, setOutcome] = useState<"" | StepOutcome>("");
  const shown = outcome ? steps.filter((s) => s.outcome === outcome) : steps;
  return (
    <div className="space-y-3">
      <SelectField label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as "" | StepOutcome)} options={OUTCOME_FILTER} wrapClassName="w-64" />
      {shown.length === 0 ? (
        <p className="text-body text-fg">No step has this outcome.</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-md ring-1 ring-line md:ring-0">
          <StepLog steps={shown} onFinding={open} label={`Step log (${shown.length})`} />
        </div>
      )}
    </div>
  );
}

function CoverageView({ session }: { session: Session }) {
  const rows = session.coverage ?? [];
  const left = session.left_out ?? [];
  if (!rows.length && !left.length) return none;
  return (
    <ul className="space-y-1 text-body text-fg [overflow-wrap:anywhere]" aria-label="Coverage by page">
      {rows.map((c) => (
        <li key={c.page}>
          <span className="font-mono text-small">{c.page}</span> ·{" "}
          {c.visited
            ? `${c.actions} action${c.actions === 1 ? "" : "s"} · ${c.findings} finding${c.findings === 1 ? "" : "s"} · ${c.not_tried} not tried`
            : (c.reason ?? "Not explored: the budget ran out.")}
        </li>
      ))}
      {left.map((l) => (
        <li key={l.url}>
          <span className="font-mono text-small">{l.path ?? l.url}</span> · Left out: {l.reason}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ finding drawer (§9.7)

type Evidence = { id: string; content_url: string; mime: string; removed?: string | null };

function Shot({ evidenceId, alt }: { evidenceId: string; alt: string }) {
  const ev = useApi<Evidence>(`/evidence/${evidenceId}`, undefined, { shouldRetryOnError: false });
  if (ev.error) {
    const gone = ev.error instanceof ApiError && ev.error.status === 410;
    return <p className="text-small text-fg-muted">{gone ? errorMessage(ev.error) : "The screenshot couldn't be loaded."}</p>;
  }
  if (!ev.data) return <Skeleton className="h-40" />;
  if (removedText(ev.data)) return <RemovedEvidence text={removedText(ev.data)!} />;
  return (
    <figure className="min-w-0 space-y-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={ev.data.content_url} alt={alt} className="w-full rounded-md ring-1 ring-line" />
      <figcaption className="text-small text-fg-muted">{alt.split(":")[0]}. Password fields and the test login are masked.</figcaption>
    </figure>
  );
}

function BeforeAfter({ f }: { f: Finding }) {
  const role = (r: string) => f.evidence.find((e) => (e as { role?: string }).role === r);
  const before = role("before");
  const after = role("after") ?? (before ? undefined : f.evidence.find((e) => e.kind === "screenshot"));
  const [mode, setMode] = useState<"both" | "before" | "after">("both");
  if (!before && !after) return <p className="text-small text-fg-muted">No screenshots were kept for this finding.</p>;
  const options = [
    { value: "both" as const, label: "Side by side" },
    { value: "before" as const, label: "Before" },
    { value: "after" as const, label: "After" },
  ];
  // Below md only Before/After are offered and one image is shown at full width (design P6 §17).
  const small = mode === "both" ? "before" : mode;
  const shot = (which: "before" | "after") => {
    const e = which === "before" ? before : after;
    return e ? <Shot evidenceId={e.evidence_id} alt={screenshotAlt(which, f)} /> : <p className="text-small text-fg-muted">No {which} screenshot.</p>;
  };
  return (
    <div className="space-y-2">
      <div className="hidden space-y-2 md:block">
        <Segmented label="Before and after: show" value={mode} onChange={setMode} options={options} />
        <div className={`grid gap-3 ${mode === "both" ? "grid-cols-2" : ""}`}>
          {mode !== "after" && shot("before")}
          {mode !== "before" && shot("after")}
        </div>
      </div>
      <div className="space-y-2 md:hidden">
        <Segmented label="Before and after: show" value={small} onChange={setMode} options={options.slice(1)} />
        {shot(small)}
      </div>
    </div>
  );
}

export function ExploreFindingDrawer({
  finding: f,
  session,
  projectId,
  canAct,
  onClose,
  onChanged,
}: {
  finding: Finding;
  session: Session;
  projectId: string;
  canAct: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const assistant = useAssistantDrawer();
  const [triage, setTriage] = useState(false);
  const [confirmRaise, setConfirmRaise] = useState(false);
  const [raising, setRaising] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const d = findingDetails(f);
  const auto = f.severity === "high" || f.rule_id === "uncaught_exception";

  async function raise() {
    if (raising) return;
    setRaising(true);
    setError(null);
    try {
      const r = await api<{ defect: { key: string } }>(`/quality-findings/${f.id}/raise-defect`, { method: "POST", body: {} });
      toast(`${r.defect.key} created as a draft.`, "success", { action: { label: `Open ${r.defect.key}`, onClick: () => router.push(`/projects/${projectId}/defects/${r.defect.key}`) } });
      setConfirmRaise(false);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setRaising(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title={`${f.key} · ${f.title}`} subtitle={f.path} wide>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Severity severity={f.severity} />
          <FindingStatusLabel status={f.status} />
          <SeenBefore keyText={f.seen_before ?? "—"} reopened={f.reopened} />
        </div>
        <p className="text-small text-fg-muted [overflow-wrap:anywhere]">
          {f.path} · desktop 1440 × 900{d.step ? ` · step ${d.step}` : ""}
        </p>
        {f.status !== "open" && f.status_reason && (
          <p className="text-small text-fg">
            {f.status === "accepted_risk" ? "Accepted" : "Marked"} by {f.status_by?.full_name ?? "someone"}: &lsquo;{f.status_reason}&rsquo;
          </p>
        )}
        <section className="space-y-1">
          <h3 className="flex items-center gap-2 text-body font-semibold text-fg-strong">
            What happened <ObservedLabel />
          </h3>
          <p className="text-small text-fg">{d.category ?? RULE_NAMES[f.rule_id] ?? f.title}</p>
          {d.observed && (
            <pre tabIndex={0} aria-label={`What happened in ${f.key}`} className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-3 font-mono text-xs text-fg-strong ring-1 ring-line">
              {d.observed}
            </pre>
          )}
          {f.rule_id === "injection" && (
            <p className="flex flex-wrap items-center gap-2 text-small text-fg">
              This page contains text that tries to instruct automated tools. The explorer ignored it. <ObservedLabel />
            </p>
          )}
        </section>
        <section className="space-y-1">
          <h3 className="text-body font-semibold text-fg-strong">Steps to reproduce</h3>
          {d.steps?.length ? (
            <ol className="list-decimal space-y-1 pl-5 text-body text-fg [overflow-wrap:anywhere]">
              {d.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : (
            <p className="text-body text-fg">Open {f.path}.</p>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-body font-semibold text-fg-strong">Before and after</h3>
          <BeforeAfter f={f} />
        </section>
        <section className="space-y-1">
          <h3 className="text-body font-semibold text-fg-strong">Console (redacted)</h3>
          {d.console?.length ? (
            <pre tabIndex={0} aria-label={`Console output for ${f.key}`} className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-3 font-mono text-xs text-fg-strong ring-1 ring-line">
              {d.console.join("\n")}
            </pre>
          ) : (
            <p className="text-small text-fg">None.</p>
          )}
        </section>
        <section className="space-y-1">
          <h3 className="text-body font-semibold text-fg-strong">Network (redacted)</h3>
          {d.network?.length ? (
            <ul className="space-y-0.5 break-all font-mono text-xs text-fg">
              {d.network.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-fg">None.</p>
          )}
        </section>
        <section className="space-y-1 text-small">
          <h3 className="text-body font-semibold text-fg-strong">Defect</h3>
          {f.defect ? (
            <p className="flex flex-wrap items-center gap-2 text-fg">
              {f.defect.key} · {cap(f.defect.status)}
              <Link href={`/projects/${projectId}/defects/${f.defect.key}`} className="font-medium text-navy-700 underline underline-offset-2">
                Open {f.defect.key}
              </Link>
            </p>
          ) : (
            <p className="text-fg">No defect yet.</p>
          )}
          {auto && <p className="text-fg-muted">{AUTO_DRAFT_LINE}</p>}
        </section>
        <div className="flex flex-wrap gap-2">
          {canAct && (
            <Button variant="secondary" onClick={() => setTriage(true)} aria-label={`Accept risk or mark false positive for ${f.key}`}>
              Accept risk or mark false positive…
            </Button>
          )}
          {canAct && !f.defect && (
            <Button variant="secondary" onClick={() => setConfirmRaise(true)} loading={raising} aria-label={`Raise defect for ${f.key}`}>
              Raise defect…
            </Button>
          )}
          <Button variant="secondary" onClick={() => assistant.open()}>
            Ask the analyst
          </Button>
        </div>
        <InlineError error={error} />
        <p className="border-t border-line pt-3 text-small text-fg-muted">{session.statement}</p>
      </div>
      {triage && <TriageDialog finding={f} open onClose={() => setTriage(false)} onDone={onChanged} />}
      <ConfirmDialog open={confirmRaise} onClose={() => setConfirmRaise(false)} onConfirm={raise} loading={raising} title={`Raise a defect for ${f.key}?`} confirmLabel="Raise defect">
        <p>One draft is created for this finding, with its steps to reproduce. It goes to Gate 8 like every draft.</p>
      </ConfirmDialog>
    </Drawer>
  );
}

// ------------------------------------------------------------------ results block

export function SessionResults({
  session,
  steps,
  findings,
  view,
  setView,
  openFinding,
  projectId,
}: {
  session: Session;
  steps: Step[] | undefined;
  findings: Finding[] | undefined;
  view: ResultsView;
  setView: (v: ResultsView) => void;
  openFinding: (k: string) => void;
  projectId: string;
}) {
  const s = session;
  const p = s.progress;
  const ntb = (s.blocked?.length ?? 0) + (s.not_tried?.length ?? 0);
  return (
    <section aria-labelledby="results-title" className="min-w-0 space-y-4">
      <h2 id="results-title" tabIndex={-1} className="text-h2 font-semibold text-fg-strong focus:outline-none">
        Results
      </h2>
      <p className="text-body text-fg-strong [overflow-wrap:anywhere]" data-testid="explore-facts">
        Budget used: {p.actions_used} of {p.actions_budget} actions · {durationShort(s.elapsed_s)} · {p.pages_explored} page{p.pages_explored === 1 ? "" : "s"} · {s.elements_tried ?? 0} elements tried ·{" "}
        {s.never_reached?.length ?? 0} never reached
      </p>
      <p className="text-body text-fg">
        {p.findings} finding{p.findings === 1 ? "" : "s"}
        {p.findings ? ` (${(["high", "medium", "low"] as const).filter((k) => p.findings_by_severity[k]).map((k) => `${p.findings_by_severity[k]} ${k}`).join(", ")})` : ""} · {p.blocked} blocked write attempt
        {p.blocked === 1 ? "" : "s"} · {p.not_tried} not tried
      </p>
      {s.no_findings_line && <p className="text-body text-fg">{s.no_findings_line}</p>}
      {(s.defects?.length ?? 0) > 0 && (
        <p className="text-small text-fg [overflow-wrap:anywhere]">
          Defect drafted:{" "}
          {s.defects!.map((d, i) => (
            <span key={d.key}>
              {i > 0 && ", "}
              <Link href={`/projects/${projectId}/defects/${d.key}`} className="font-medium underline underline-offset-2">
                {d.key}
              </Link>{" "}
              &ldquo;{d.summary}&rdquo;
            </span>
          ))}{" "}
          · Gate 8
        </p>
      )}
      <Segmented
        label="View"
        value={view}
        onChange={setView}
        options={[
          { value: "findings", label: `Findings (${p.findings})` },
          { value: "not-tried", label: `Not tried and blocked (${ntb})` },
          { value: "steps", label: `Step log (${steps?.length ?? p.actions_used})` },
          { value: "coverage", label: "Coverage" },
        ]}
      />
      {view === "findings" && (findings ? <FindingsView findings={findings} open={openFinding} projectId={projectId} /> : <Skeleton className="h-40" />)}
      {view === "not-tried" && <NotTriedView session={s} />}
      {view === "steps" && (steps ? <StepsView steps={steps} open={openFinding} /> : <Skeleton className="h-40" />)}
      {view === "coverage" && <CoverageView session={s} />}
    </section>
  );
}
