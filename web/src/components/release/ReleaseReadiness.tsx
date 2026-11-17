"use client";

// Release readiness (P6-05b; design P6 §10, D32, D33): the rules' verdict with its one-sentence reason, the criteria
// with status and Blocking as text, conditions, residual risk, what changed since the last assessment, Gate 9 and the
// history. The verdict is the platform's recommendation until a person decides Gate 9; older assessments are read-only.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { claimRouteFocus } from "@/lib/focusReturn";
import { fmtDateTime } from "@/lib/format";
import { useOnline } from "@/lib/useOnline";
import {
  ASSESSING,
  LEVEL_LABEL,
  LOAD_ERROR,
  NOT_ASSESSED,
  NO_RUN,
  NO_RUN_EMPTY,
  OFFLINE_ASSESS,
  OFFLINE_CONFIRM,
  assessmentOption,
  historyFinal,
  STATUS_OPTIONS,
  VERDICT_LABEL,
  assessError,
  assessedToast,
  cardHeading,
  changesSinceParts,
  criteriaRows,
  criterionChangeText,
  evidenceName,
  gate9State,
  manualRetestHref,
  manualRetestSets,
  olderText,
  overrideText,
  staleText,
  statementFor,
  supersededText,
  type Assessment,
  type ConfirmResponse,
  type Criterion,
  type EvidenceRef,
  type ReleaseOverview,
  type ReleaseSummary,
  type StatusFilter,
} from "@/lib/release";
import { Button, Callout, Checkbox, ConfirmDialog, Disclosure, EmptyState, ErrorState, LinkButton, SelectField, Skeleton, Spinner, Table, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { HonestyNote } from "@/components/domain/NonFunctionalLabels";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { AssessmentStatusLabel, BlockingLabel, CriterionStatusLabel, RiskLevelChip, VerdictChip } from "@/components/domain/ReleaseLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { ConfirmCriterionDialog, GATE9_HEADING, ReleaseDecisionPanel } from "./ReleaseDecision";
import { useAssessment, useRefreshRelease, useReleaseOverview } from "./hooks";

const link = "font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900";
const VERDICT_HEADING = "release-verdict-heading";
const sectionTitle = "text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted";

/** Set when this browser starts an assessment, so the result is announced once it's ready (design P6 §10.2). */
let pendingAssess: { project: string; from: string | null } | null = null;

const who = (u: { full_name?: string; email?: string } | null | undefined) => u?.full_name || u?.email || "someone";
const rowId = (c: Criterion, card = false) => `crit-${card ? "card-" : ""}${c.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

function focusVisible(...ids: string[]) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.offsetParent !== null) {
      el.focus();
      return;
    }
  }
}

export function useAssess(projectId: string, latest: ReleaseSummary | null | undefined, mutate: (d: ReleaseOverview) => unknown) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function assess() {
    setBusy(true);
    setError(null);
    try {
      pendingAssess = { project: projectId, from: latest?.key ?? null };
      const next = await api<ReleaseOverview>(`/projects/${projectId}/release-assessments`, { body: {} });
      await mutate(next);
      return true;
    } catch (e) {
      pendingAssess = null;
      setError(assessError(errorMessage(e)));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { assess, busy, error, setError };
}

export function ReleaseReadinessPage({ relKey }: { relKey?: string }) {
  const p = useProject();
  const router = useRouter();
  const toast = useToast();
  const online = useOnline();
  const { role } = useAuth();
  const member = role !== null && role !== "viewer";
  const ov = useReleaseOverview(p.id);
  const byKey = useAssessment(p.id, relKey ?? null);
  const refreshAll = useRefreshRelease(p.id);
  const overview = ov.data;
  const a: Assessment | undefined = relKey ? byKey.data : (overview?.latest ?? undefined);
  const { assess, busy, error, setError } = useAssess(p.id, overview?.latest, (d) => ov.mutate(d, { revalidate: false })); // `assessing` in the response switches polling to 2 s (hooks.ts)
  const [againOpen, setAgainOpen] = useState(false);
  const [confirming, setConfirming] = useState<Criterion | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const base = `/projects/${p.id}/release-readiness`;

  useEffect(() => {
    document.title = `${relKey ? `${relKey} · ` : ""}Release readiness · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [relKey, p.project?.name]);

  // The assessment this browser asked for is ready: say so (toast + polite region) and put focus on the page h1.
  useEffect(() => {
    if (!overview || overview.assessing || pendingAssess?.project !== p.id) return;
    const from = pendingAssess.from;
    pendingAssess = null;
    if (overview.latest && overview.latest.key !== from) {
      toast(assessedToast(overview.latest), "success");
      if (!relKey) setTimeout(() => document.querySelector<HTMLElement>("main h1")?.focus(), 0);
      void refreshAll();
    } else if (overview.stage.status === "failed") {
      setError(assessError(overview.stage.stale_reason ?? "the assessment didn't complete"));
    }
  }, [overview, p.id, relKey, toast, refreshAll, setError]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // `#gate-9` (Overview "Decide REL-…"): once the panel is there, move focus to its heading.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !a || typeof window === "undefined" || window.location.hash !== "#gate-9") return;
    const el = document.getElementById(GATE9_HEADING);
    if (!el) return;
    jumped.current = true;
    claimRouteFocus(window.location.pathname); // so the route-change focus doesn't move it back to the h1
    el.scrollIntoView({ block: "start" });
    el.focus();
  }, [a]);

  const available = overview?.available ?? false;
  const assessing = !!overview?.assessing;
  const disabledReason = !available ? NO_RUN : !online ? OFFLINE_ASSESS : null;

  async function runAssess() {
    setAgainOpen(false);
    if (disabledReason || assessing) return;
    const ok = await assess();
    if (ok && relKey) router.push(base);
  }
  function onAssess() {
    if (disabledReason || assessing || busy) return;
    if (overview?.latest?.status === "awaiting_approval") setAgainOpen(true);
    else void runAssess();
  }

  const assessButton = (label: string, variant: "primary" | "secondary" = "primary") =>
    member ? (
      <Button variant={variant} className="w-full md:w-auto" onClick={onAssess} loading={busy} aria-disabled={disabledReason || assessing ? true : undefined} aria-describedby={disabledReason ? reasonId : undefined}>
        {label}
      </Button>
    ) : null;

  const back = (
    <Link href={`/projects/${p.id}/reports`} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Reports
    </Link>
  );

  const notFound = relKey && byKey.error instanceof ApiError && byKey.error.status === 404;
  const loadError = (ov.error && !overview) || (relKey && byKey.error && !byKey.data && !notFound);

  return (
    <div className="mx-auto max-w-[960px] space-y-6">
      {back}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          {relKey ? `Release readiness · ${relKey}` : "Release readiness"}
        </h1>
        {overview && (
          <div className="flex flex-col gap-1 md:items-end">
            {assessButton("Assess release readiness")}
            {member && disabledReason && (
              <p id={reasonId} className="text-small font-medium text-fg-strong">
                {disabledReason}
              </p>
            )}
          </div>
        )}
      </div>
      {error && (
        <div ref={errorRef} tabIndex={-1} className="focus:outline-none">
          <Callout
            tone="danger"
            role="alert"
            actions={
              member ? (
                <Button variant="secondary" onClick={onAssess}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {error}
          </Callout>
        </div>
      )}
      {notFound ? (
        <EmptyState title={`We couldn’t find ${relKey} in this project.`} action={<LinkButton href={base}>Open release readiness</LinkButton>} />
      ) : loadError ? (
        <ErrorState error={ov.error ?? byKey.error} title={LOAD_ERROR.replace(/ Try again\.$/, "")} message="Try again." onRetry={() => void refreshAll()} />
      ) : !overview || (relKey && !a) ? (
        <div className="space-y-4" aria-hidden>
          <Skeleton className="h-6 w-80" />
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : assessing && !relKey ? (
        <div aria-busy="true" className="flex justify-center py-16">
          <Spinner label={overview.assessing_text ?? ASSESSING} />
        </div>
      ) : !a ? (
        !available ? (
          <EmptyState title={NO_RUN_EMPTY} action={<LinkButton href={`/projects/${p.id}/execution`}>Open Test Execution</LinkButton>} />
        ) : (
          <EmptyState title="Not assessed yet." description={NOT_ASSESSED.replace(/^Not assessed yet\. /, "")} />
        )
      ) : (
        <AssessmentBody
          a={a}
          overview={overview}
          projectId={p.id}
          onConfirm={setConfirming}
          assessAgain={assessButton("Assess again", "secondary")}
          onDecided={async (next) => {
            await refreshAll();
            if (relKey) await byKey.mutate(next, { revalidate: false });
            setTimeout(() => document.getElementById(VERDICT_HEADING)?.focus(), 0);
          }}
          onConflict={() => void refreshAll()}
          onSelect={(key) => router.push(key === overview.history[0]?.key ? base : `${base}/${key}`)}
        />
      )}
      {a && (
        <ConfirmCriterionDialog
          a={a}
          criterion={confirming}
          onClose={() => setConfirming(null)}
          onDone={async (res: ConfirmResponse) => {
            const c = confirming;
            setConfirming(null);
            toast(res.message, "success");
            await refreshAll();
            if (relKey) await byKey.mutate(res.assessment, { revalidate: false });
            if (c) setTimeout(() => focusVisible(rowId(c), rowId(c, true)), 50);
          }}
        />
      )}
      <ConfirmDialog
        open={againOpen}
        onClose={() => setAgainOpen(false)}
        onConfirm={() => void runAssess()}
        title="Assess again?"
        confirmLabel="Assess again"
        loading={busy}
      >
        <p>
          Assess again? {overview?.latest?.key} is waiting for a Gate 9 decision. A new assessment replaces it; {overview?.latest?.key} stays in history.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function AssessmentBody({
  a,
  overview,
  projectId,
  onConfirm,
  assessAgain,
  onDecided,
  onConflict,
  onSelect,
}: {
  a: Assessment;
  overview: ReleaseOverview;
  projectId: string;
  onConfirm: (c: Criterion) => void;
  assessAgain: React.ReactNode;
  onDecided: (next: Assessment) => void;
  onConflict: () => void;
  onSelect: (key: string) => void;
}) {
  const latestKey = overview.history[0]?.key ?? a.latest.key;
  const isLatest = a.key === latestKey;
  const replacedBy = a.superseded_by ? overview.history.find((h) => h.key === a.superseded_by) : null;
  const supersededAt = replacedBy?.created_at ? fmtDateTime(replacedBy.created_at) : null;
  const base = `/projects/${projectId}/release-readiness`;
  const narrative = a.ai_sections?.narrative;
  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <p className="text-small text-fg">
          {a.key} · assessed {fmtDateTime(a.assessed_at ?? a.created_at)} by {who(a.created_by)} · {a.generated_by === "rules" ? "rules" : "rules and AI"}
        </p>
        <SelectField
          label="Assessment"
          value={a.key}
          onChange={(e) => onSelect(e.target.value)}
          options={overview.history.map((h, i) => ({ value: h.key, label: assessmentOption(h, i === 0) }))}
          wrapClassName="md:w-64"
        />
      </div>
      <HonestyNote>{statementFor(a)}</HonestyNote>
      {a.status === "stale" && <Callout tone="warning">{staleText(a.stale_reason)}</Callout>}
      {a.status === "superseded" ? (
        <Callout
          tone="neutral"
          actions={
            a.superseded_by ? (
              <LinkButton href={a.superseded_by === latestKey ? base : `${base}/${a.superseded_by}`}>Open {a.superseded_by}</LinkButton>
            ) : undefined
          }
        >
          {supersededText(a.superseded_by, supersededAt)}
        </Callout>
      ) : (
        !isLatest && (
          <Callout tone="neutral" actions={<LinkButton href={base}>Open latest</LinkButton>}>
            {olderText(a, latestKey)}
          </Callout>
        )
      )}
      {a.status === "rejected" && <Callout tone="neutral">{a.decision_record?.text ?? `${a.key} was rejected. Assess again when ready.`}</Callout>}
      <VerdictCard a={a} />
      {narrative && (
        <section aria-labelledby="release-narrative" className="space-y-2">
          <h2 id="release-narrative" className={sectionTitle}>
            What this means
          </h2>
          <p className="text-body text-fg">{narrative.text}</p>
          <GeneratedByLabel generatedBy={narrative.generated_by} />
        </section>
      )}
      <Conditions a={a} />
      <CriteriaSection a={a} projectId={projectId} onConfirm={onConfirm} />
      <ResidualRisk a={a} />
      <ChangesSinceSection a={a} />
      <ReleaseDecisionPanel a={a} projectId={projectId} supersededAt={supersededAt} onDecided={onDecided} onConflict={onConflict} assessAction={isLatest ? assessAgain : null} />
      <History items={overview.history} current={a.key} base={base} />
      <ReleaseReports projectId={projectId} assessmentKey={a.key} />
    </>
  );
}

function VerdictCard({ a }: { a: Assessment }) {
  const { role, canApprove } = useAuth();
  const member = role !== null && role !== "viewer";
  const approver = member && canApprove;
  const override = overrideText(a);
  return (
    <section aria-labelledby={VERDICT_HEADING} className="space-y-2 rounded-xl bg-surface p-4 ring-1 ring-line-strong md:p-5">
      <h2 id={VERDICT_HEADING} tabIndex={-1} className="text-h2 font-semibold text-fg-strong focus:outline-none">
        {cardHeading(a)}
      </h2>
      <VerdictChip verdict={a.verdict} state={a.verdict_state} size="lg" />
      {override && <p className="break-words font-medium text-fg-strong">{override}</p>}
      {a.reason && <p className="text-body text-fg">{a.reason}</p>}
      <p className="flex flex-col gap-2 text-body text-fg md:flex-row md:flex-wrap md:items-center md:justify-between">
        <span>
          Overall residual risk: {a.overall_residual ? LEVEL_LABEL[a.overall_residual] : "not assessed"} · Gate 9: {gate9State(a, approver)}
        </span>
        {member && a.status === "awaiting_approval" && (
          <a
            href="#gate-9"
            className={`${link} inline-flex min-h-6 items-center`}
            onClick={(e) => {
              e.preventDefault();
              const h = document.getElementById(GATE9_HEADING);
              h?.scrollIntoView({ block: "start" });
              h?.focus();
            }}
          >
            Go to the decision
          </a>
        )}
      </p>
    </section>
  );
}

function Conditions({ a }: { a: Assessment }) {
  const list = a.conditions_list;
  return (
    <section aria-labelledby="release-conditions" className="space-y-2">
      <h2 id="release-conditions" className={sectionTitle}>
        Conditions ({list.length})
      </h2>
      {list.length === 0 ? (
        <p className="text-body text-fg">No conditions.</p>
      ) : (
        <ol className="list-decimal space-y-1 pl-6 text-body text-fg">
          {list.map((c) => (
            <li key={`${c.criterion_id}-${c.text}`} className="break-words">
              {c.text}
              {c.blocking && (
                <span className="ml-2 inline-flex">
                  <BlockingLabel blocking />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvidenceLinks({ c, projectId, editable }: { c: Criterion; projectId: string; editable: boolean }) {
  const refs = c.evidence_refs;
  const manual = editable ? manualRetestSets(c) : [];
  if (!refs.length && !manual.length) return <span className="text-fg-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {refs.map((r: EvidenceRef) =>
        r.path ? (
          <Link key={`${r.type}-${r.key}`} href={r.path} aria-label={evidenceName(r, c)} className={`${link} inline-flex min-h-6 items-center`}>
            {r.label || r.key}
          </Link>
        ) : (
          <span key={`${r.type}-${r.key}`}>{r.label || r.key}</span>
        ),
      )}
      {manual.map((r) => (
        <Link key={`manual-${r.key}`} href={manualRetestHref(projectId, r.key)} className={`${link} inline-flex min-h-6 items-center`}>
          Record manual re-tests in {r.key}
        </Link>
      ))}
    </span>
  );
}

function ConfirmButton({ c, onConfirm }: { c: Criterion; onConfirm: (c: Criterion) => void }) {
  const online = useOnline();
  if (!c.can_confirm) return null;
  return (
    <Button size="sm" variant="secondary" aria-label={`Confirm result for ${c.text}`} aria-disabled={!online ? true : undefined} title={!online ? OFFLINE_CONFIRM : undefined} onClick={() => online && onConfirm(c)}>
      Confirm result…
    </Button>
  );
}

function CriteriaSection({ a, projectId, onConfirm }: { a: Assessment; projectId: string; onConfirm: (c: Criterion) => void }) {
  const { role } = useAuth();
  const member = role !== null && role !== "viewer";
  const [status, setStatus] = useState<StatusFilter>("");
  const [blockingFirst, setBlockingFirst] = useState(true);
  const rows = criteriaRows(a.criteria, status, blockingFirst);
  const editable = member && a.status === "awaiting_approval";
  const label = `Criteria (${a.criteria.length})`;
  return (
    <section aria-labelledby="release-criteria" className="space-y-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <h2 id="release-criteria" className={sectionTitle}>
          {label}
        </h2>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <SelectField label="Status" value={status} options={STATUS_OPTIONS} onChange={(e) => setStatus(e.target.value as StatusFilter)} wrapClassName="md:w-44" />
          <Checkbox label="Blocking first" checked={blockingFirst} onChange={(e) => setBlockingFirst(e.target.checked)} className="md:pb-2" />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-body text-fg">No criteria with this status.</p>
      ) : (
        <>
          <div className="hidden md:block">
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
                      <span id={rowId(c)} tabIndex={-1} className="focus:outline-2 focus:outline-focus">
                        {c.text}
                      </span>
                      {c.detail && <span className="mt-1 block break-words text-small font-normal text-fg">{c.detail}</span>}
                    </Td>
                    <Td className="align-top">
                      <BlockingLabel blocking={c.blocking} />
                    </Td>
                    <Td className="align-top">
                      <CriterionStatusLabel status={c.status} />
                    </Td>
                    <Td className="whitespace-normal align-top">{c.source_label}</Td>
                    <Td className="whitespace-normal align-top">
                      <span className="flex flex-col items-start gap-2">
                        <EvidenceLinks c={c} projectId={projectId} editable={editable} />
                        <ConfirmButton c={c} onConfirm={onConfirm} />
                      </span>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="space-y-3 md:hidden" aria-label={label}>
            {rows.map((c) => (
              <li key={c.id} className="space-y-2 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
                <h3 id={rowId(c, true)} tabIndex={-1} className="break-words text-body font-semibold text-fg-strong focus:outline-none">
                  {c.text}
                </h3>
                <p className="flex flex-wrap items-center gap-x-1 gap-y-1 text-fg">
                  Status: <CriterionStatusLabel status={c.status} /> · <BlockingLabel blocking={c.blocking} /> · Source: {c.source_label}
                </p>
                {c.detail && <p className="break-words text-fg">{c.detail}</p>}
                <div className="flex flex-wrap items-center gap-2 text-fg">
                  Evidence: <EvidenceLinks c={c} projectId={projectId} editable={editable} />
                </div>
                <ConfirmButton c={c} onConfirm={onConfirm} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ResidualRisk({ a }: { a: Assessment }) {
  const rows = a.residual_risks;
  const title = "Residual risk (highest first)";
  return (
    <section aria-labelledby="release-residual" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="release-residual" className={sectionTitle}>
          {title}
        </h2>
        <p className="text-small text-fg">Overall: {a.overall_residual ? LEVEL_LABEL[a.overall_residual] : "not assessed"}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-body text-fg">No risks in the approved test strategy.</p>
      ) : (
        <>
          <div className="hidden md:block">
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
                  <Tr key={r.risk.key}>
                    <Td rowHeader className="whitespace-normal">
                      {r.risk.path ? (
                        <Link href={r.risk.path} className={link}>
                          {r.risk.label || `${r.risk.key} ${r.title}`}
                        </Link>
                      ) : (
                        r.risk.label || `${r.risk.key} ${r.title}`
                      )}
                    </Td>
                    <Td>
                      <RiskLevelChip level={r.initial} />
                    </Td>
                    <Td>
                      <RiskLevelChip level={r.residual} />
                    </Td>
                    <Td className="whitespace-normal break-words">{r.line}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="space-y-2 md:hidden" aria-label="Residual risk">
            {rows.map((r) => (
              <li key={r.risk.key} className="space-y-1 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
                <h3 className="break-words text-body font-semibold text-fg-strong">{r.risk.label || `${r.risk.key} ${r.title}`}</h3>
                <p className="flex flex-wrap items-center gap-2 text-fg">
                  Before testing: <RiskLevelChip level={r.initial} /> Now: <RiskLevelChip level={r.residual} />
                </p>
                <p className="break-words text-fg">Why: {r.line}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ChangesSinceSection({ a }: { a: Assessment }) {
  const c = a.changes_since;
  const parts = changesSinceParts(c);
  const crit = c.criteria ?? [];
  const title = c.previous ? `What changed since ${c.previous.key}${c.previous.created_at ? ` (${fmtDateTime(c.previous.created_at)})` : ""}` : "What changed since the last assessment";
  return (
    <section aria-labelledby="release-changes" className="space-y-2">
      <h2 id="release-changes" className={sectionTitle}>
        {title}
      </h2>
      {!c.previous ? (
        <p className="text-body text-fg">{c.text ?? "This is the first assessment."}</p>
      ) : (
        <>
          <p className="break-words text-body text-fg">
            {parts.join(" · ")}
            {crit.length === 0 ? " · No criterion changed." : ` · ${crit.length} criteri${crit.length === 1 ? "on" : "a"} changed`}
          </p>
          {crit.length > 0 && (
            <Disclosure label="Show" openLabel="Hide">
              <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-fg">
                {crit.map((x) => (
                  <li key={x.id}>{criterionChangeText(x)}</li>
                ))}
              </ul>
            </Disclosure>
          )}
        </>
      )}
    </section>
  );
}

/** design P6 §10.1 REPORTS: both P6-05c reports of the assessment shown. */
function ReleaseReports({ projectId, assessmentKey }: { projectId: string; assessmentKey: string }) {
  const q = `?assessment=${encodeURIComponent(assessmentKey)}`;
  return (
    <section aria-labelledby="release-reports" className="space-y-2">
      <h2 id="release-reports" className={sectionTitle}>
        Reports
      </h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <LinkButton variant="secondary" href={`/projects/${projectId}/reports/release-readiness${q}`}>
          Open Release Readiness Report
        </LinkButton>
        <LinkButton variant="secondary" href={`/projects/${projectId}/reports/completion${q}`}>
          Open Test Completion Report
        </LinkButton>
      </div>
    </section>
  );
}

function History({ items, current, base }: { items: ReleaseSummary[]; current: string; base: string }) {
  const href = (k: string, i: number) => (i === 0 ? base : `${base}/${k}`);
  const final = historyFinal;
  return (
    <section aria-labelledby="release-history" className="space-y-2">
      <h2 id="release-history" className={sectionTitle}>
        History
      </h2>
      <div className="hidden md:block">
        <Table label="Assessment history">
          <THead>
            <tr>
              <Th>Assessment</Th>
              <Th>Assessed</Th>
              <Th>Recommended</Th>
              <Th>Final</Th>
              <Th>Status</Th>
            </tr>
          </THead>
          <TBody>
            {items.map((h, i) => (
              <Tr key={h.key}>
                <Td rowHeader>
                  {h.key === current ? (
                    <span aria-current="true">{h.key} (shown)</span>
                  ) : (
                    <Link href={href(h.key, i)} className={link}>
                      {h.key}
                    </Link>
                  )}
                </Td>
                <Td>{fmtDateTime(h.assessed_at ?? h.created_at)}</Td>
                <Td>{VERDICT_LABEL[h.recommendation]}</Td>
                <Td className="whitespace-normal">{final(h)}</Td>
                <Td>
                  <AssessmentStatusLabel status={h.status} supersededBy={h.superseded_by} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label="Assessment history">
        {items.map((h, i) => (
          <li key={h.key} className="space-y-1 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
            <p className="font-medium text-fg-strong">
              {h.key === current ? (
                `${h.key} (shown)`
              ) : (
                <Link href={href(h.key, i)} className={link}>
                  {h.key}
                </Link>
              )}{" "}
              · {fmtDateTime(h.assessed_at ?? h.created_at)}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-fg">
              Recommended: {VERDICT_LABEL[h.recommendation]} · Final: {final(h)} <AssessmentStatusLabel status={h.status} supersededBy={h.superseded_by} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
