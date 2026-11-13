"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { AcceptanceCriterionCreate, Proposal, ProposedTestCase, RequirementDetail, SuiteChange, TestCaseDetail } from "@/lib/contract";
import { useAuth } from "@/lib/auth";
import { PRIORITY_TEXT, proposalAppliedToast, suiteDiff, techniqueInfo } from "@/lib/testcases";
import { likelihoodText, impactText } from "@/lib/strategy";
import { Button, Disclosure, InlineError, StatusPill, useToast } from "@/components/ui";
import { GeneratedByLabel, ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { DiffView } from "@/components/domain/DiffView";
import { ValueText } from "@/components/testcases/Bits";

const KIND_LABEL: Record<Proposal["kind"], string> = {
  add_acceptance_criteria: "Add acceptance criteria",
  update_requirement: "Update requirements",
  add_requirement: "Suggest missing requirements",
  reassess_risks: "Reassess application risk",
  update_risk: "Update risk",
  regenerate_stage: "Regenerate",
  add_test_cases: "Add test cases",
  update_test_case: "Update test cases",
  set_suite: "Regression suite",
};

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "Waiting for your review",
  accepted: "Applied",
  rejected: "Rejected",
  stale: "Out of date",
  failed: "Failed",
};

function isCaseList(p: Proposal): boolean {
  return p.kind === "add_test_cases";
}

/** The proposed cases: `preview` when sent, else the documented payload `{cases: [...]}` (as built). */
function proposedCases(p: Proposal): ProposedTestCase[] {
  if (Array.isArray(p.preview) && p.preview.length) return p.preview as ProposedTestCase[];
  const cases = (p.payload as { cases?: unknown }).cases;
  return Array.isArray(cases) ? (cases as ProposedTestCase[]) : [];
}

/** Suite changes: `preview` when sent, else the payload `{changes: [{case_id, key, from, to}]}`. */
function suiteChanges(p: Proposal): SuiteChange[] {
  if (Array.isArray(p.preview) && p.preview.length) return p.preview as SuiteChange[];
  const changes = (p.payload as { changes?: unknown }).changes;
  return Array.isArray(changes) ? (changes as SuiteChange[]) : [];
}

/** Proposed cases show the same information a case card does (design P3 §16.2). */
function CasePreview({ cases }: { cases: ProposedTestCase[] }) {
  return (
    <ul className="space-y-2 text-small text-fg">
      {cases.map((c, i) => {
        const t = techniqueInfo(c.technique);
        return (
          <li key={i} className="space-y-1 rounded bg-diff-add-bg px-2 py-1.5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="sr-only">added: </span>
              <span className="font-semibold" aria-hidden>
                +
              </span>
              <span className="font-mono">TC (new)</span>
              <span className="font-medium text-fg-strong">{c.title}</span>
              {c.technique && (
                <span className="rounded-sm bg-overlay px-1 font-mono">
                  <span aria-hidden>{t.short}</span>
                  <span className="sr-only">{t.name}</span>
                </span>
              )}
              {c.priority && <span>{PRIORITY_TEXT[c.priority]}</span>}
              {c.risk_key && <span>· {c.risk_key}</span>}
              {c.classification && <ProvenanceLabel provenance={c.classification} />}
            </p>
            {c.constraint && <p>Constraint: {c.constraint}</p>}
            {c.classification_note && <p>“{c.classification_note}”</p>}
            {(c.steps ?? []).length > 0 && (
              <Disclosure label={`Steps for ${c.title}`} openLabel={`Hide steps for ${c.title}`}>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  {c.steps.map((s, j) => (
                    <li key={j} className="break-words">
                      {s.action}
                      {(s.data ?? []).map((d, k) => (
                        <span key={k} className="ml-1">
                          {/* Payload steps carry match keys (strings); previews carry resolved items. */}
                          · {typeof d === "string" ? d : `${d.new ? "TD (new)" : (d.key ?? "")} ${d.value ? `“${d.value}”` : (d.label ?? "")}`}
                        </span>
                      ))}
                      {s.expected?.trim() && <span className="block text-fg-muted">Expected: {s.expected}</span>}
                    </li>
                  ))}
                </ol>
              </Disclosure>
            )}
            {(c.data ?? []).length > 0 && (
              <p className="break-words">
                Test data:{" "}
                {(c.data ?? []).map((d, k) => (
                  <span key={k}>
                    {k > 0 && "; "}
                    {d.field_label} <ValueText value={d.value} />
                    {d.new ? " (new)" : ""}
                  </span>
                ))}
              </p>
            )}
            {c.expected_result && <p>Expected result: {c.expected_result}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** "Add to Regression ({n})" / "Remove from Regression ({m})", each item with its reason. */
function SuitePreview({ changes }: { changes: SuiteChange[] }) {
  const { add, remove } = suiteDiff(changes);
  const list = (title: string, items: SuiteChange[], cls: string) =>
    items.length > 0 && (
      <div>
        <p className="font-medium text-fg-strong">
          {title} ({items.length})
        </p>
        <ul className="space-y-0.5">
          {items.map((c) => (
            <li key={c.key} className={`rounded px-2 py-0.5 ${cls}`}>
              <span className="font-mono">{c.key}</span>
              {c.title ? ` ${c.title}` : ""}
              {c.reason ? ` · ${c.reason}` : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="space-y-2 text-small text-fg">
      {list("Add to Regression", add, "bg-diff-add-bg")}
      {list("Remove from Regression", remove, "bg-diff-del-bg")}
    </div>
  );
}

function isAcList(p: Proposal["preview"]): p is AcceptanceCriterionCreate[] {
  return Array.isArray(p) && p.length > 0 && typeof (p[0] as AcceptanceCriterionCreate).given === "string";
}

/** "Likelihood 3 Possible → 4 Likely"; the score is recalculated by the server on apply (design §11.4). */
function fieldPreview(p: Proposal) {
  const rows = (Array.isArray(p.preview) ? p.preview : []) as { field: string; from: unknown; to: unknown }[];
  const risk = p.kind === "reassess_risks" || p.kind === "update_risk";
  const changes = rows
    .filter((r) => !(risk && (r.field === "score" || r.field === "level")))
    .map((r) =>
      risk && (r.field === "likelihood" || r.field === "impact")
        ? { field: r.field, from: r.field === "likelihood" ? likelihoodText(Number(r.from)) : impactText(Number(r.from)), to: r.field === "likelihood" ? likelihoodText(Number(r.to)) : impactText(Number(r.to)) }
        : r,
    );
  return (
    <>
      {changes.length > 0 && <DiffView changes={changes} allowSideBySide={false} />}
      {risk && <p className="text-small text-fg-muted">Score: recalculated on apply.</p>}
    </>
  );
}

function Item({
  p,
  value,
  onChange,
  lockedReason,
  approvedNote,
  compact,
  fullViewHref,
  canWrite,
}: {
  p: Proposal;
  value: "accept" | "reject";
  onChange: (v: "accept" | "reject") => void;
  lockedReason: string | null;
  approvedNote?: string | null;
  compact?: boolean;
  fullViewHref: string;
  canWrite: boolean;
}) {
  const pending = p.status === "pending";
  const payload = p.payload as Record<string, unknown>;
  const label = typeof payload.classification === "string" ? payload.classification : null;
  const conf = typeof payload.confidence === "number" ? payload.confidence : null;
  const legend = `${p.target?.key ?? p.key} ${p.target?.label ?? p.summary}`;
  return (
    <fieldset className="rounded-md border border-line px-3 py-2.5">
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex flex-wrap items-center gap-2 text-body text-fg-strong">
            <span className="font-semibold">{p.kind === "add_requirement" ? "+ New:" : "~"}</span>
            {p.target?.path ? (
              <Link href={p.target.path} className="font-mono text-navy-700 underline underline-offset-2">
                {p.target.key}
              </Link>
            ) : (
              <span className="font-mono">{p.target?.key ?? p.key}</span>
            )}
            <span>{p.target?.label ?? p.summary}</span>
            {label && <ProvenanceLabel provenance={label} confidence={conf} />}
          </p>
          {p.target?.label && p.summary && p.summary !== p.target.label && <p className="text-small text-fg">{p.summary}</p>}
          {isCaseList(p) ? (
            <CasePreview cases={proposedCases(p)} />
          ) : p.kind === "set_suite" ? (
            <SuitePreview changes={suiteChanges(p)} />
          ) : isAcList(p.preview) ? (
            <ul className="space-y-1 text-small text-fg">
              {p.preview.map((ac, i) => (
                <li key={i} className="rounded bg-diff-add-bg px-2 py-1">
                  <span className="sr-only">added: </span>
                  <strong>Given</strong> {ac.given} · <strong>When</strong> {ac.when} · <strong>Then</strong> {ac.then}
                </li>
              ))}
            </ul>
          ) : compact && Array.isArray(p.preview) && p.preview.length > 2 ? (
            <Link href={fullViewHref} className="text-small font-medium text-navy-700 underline underline-offset-2">
              Review in full view
            </Link>
          ) : (
            fieldPreview(p)
          )}
          {lockedReason && pending && <p className="text-small font-medium text-warning-fg">{lockedReason}</p>}
          {approvedNote && pending && <p className="text-small text-fg">{approvedNote}</p>}
          {p.status === "stale" && <p className="text-small font-medium text-warning-fg">{p.target?.key ?? "The target"} changed after this proposal was made. Ask again to get a proposal for the current version.</p>}
          {p.result?.error && <p className="text-small text-danger-fg">{p.result.error}</p>}
        </div>
        {pending && !canWrite ? (
          <StatusPill status="pending" label={STATUS_LABEL.pending.replace("your ", "")} />
        ) : pending ? (
          <div role="radiogroup" aria-label={`Decision for ${p.target?.key ?? p.key}`} className="flex gap-3">
            <label className={`inline-flex items-center gap-1.5 text-body ${lockedReason ? "text-fg-muted" : "text-fg-strong"}`}>
              <input type="radio" name={`prop-${p.id}`} checked={value === "accept"} disabled={!!lockedReason} onChange={() => onChange("accept")} className="h-4 w-4" />
              Accept
            </label>
            <label className="inline-flex items-center gap-1.5 text-body text-fg-strong">
              <input type="radio" name={`prop-${p.id}`} checked={value === "reject"} onChange={() => onChange("reject")} className="h-4 w-4" />
              Reject
            </label>
          </div>
        ) : (
          <StatusPill status={p.status === "accepted" ? "approved" : p.status === "stale" ? "out_of_date" : p.status} label={STATUS_LABEL[p.status]} />
        )}
      </div>
    </fieldset>
  );
}

/** Locked targets can't be changed by a proposal (design P2 §11.4, check 48; P3 §16.2 for test cases). */
function useLockedReason(p: Proposal): { locked: string | null; approved: string | null } {
  const pendingTarget = p.status === "pending" && !!p.target?.id;
  const isReq = pendingTarget && p.target?.type === "requirement" && p.kind !== "add_requirement";
  const isCase = pendingTarget && p.target?.type === "test_case" && p.kind === "update_test_case";
  const req = useApi<RequirementDetail>(isReq ? `/requirements/${p.target!.id}` : null, undefined, { shouldRetryOnError: false });
  const tc = useApi<TestCaseDetail>(isCase ? `/test-cases/${p.target!.id}` : null, undefined, { shouldRetryOnError: false });
  const d = req.data ?? tc.data;
  return {
    locked: d?.locked ? `${d.key} is locked. Unlock it to apply this change.` : null,
    approved: tc.data?.status === "approved" ? "Approved: this change moves it back to Draft." : null,
  };
}

function Row(props: {
  p: Proposal;
  value: "accept" | "reject";
  onChange: (v: "accept" | "reject") => void;
  onLocked: (id: string, locked: boolean) => void;
  compact?: boolean;
  fullViewHref: string;
  canWrite: boolean;
}) {
  const { locked, approved } = useLockedReason(props.p);
  const { onLocked, p } = props;
  useEffect(() => onLocked(p.id, !!locked), [onLocked, p.id, locked]);
  return <Item {...props} lockedReason={locked} approvedNote={approved} />;
}

/**
 * Proposals from one answer (design P2 §11.4): each change has Accept / Reject; nothing is applied until
 * "Apply {n} accepted changes". Each accepted item goes through the normal endpoints with the user's
 * permissions; per-item failures are listed.
 */
export function ProposalCard({
  proposals,
  request,
  projectId,
  gateReopens,
  compact,
  fullViewHref,
  onDone,
}: {
  proposals: Proposal[];
  request?: string | null;
  projectId: string;
  /** Where "Review in full view" goes from the side panel (the thread in the full assistant page). */
  fullViewHref?: string;
  /** "Gate 3 will need approval again." when the targets are approved content. */
  gateReopens?: string | null;
  compact?: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const { role } = useAuth();
  // Viewers see proposals but not Apply/Reject (P3 §16.2); accepting would be a 403.
  const canWrite = role !== "viewer";
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [locked, setLocked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const onLocked = useCallback((id: string, l: boolean) => setLocked((x) => (x[id] === l ? x : { ...x, [id]: l })), []);
  const pending = proposals.filter((p) => p.status === "pending");
  const decision = (p: Proposal) => (locked[p.id] ? "reject" : (decisions[p.id] ?? "accept"));
  const accepted = pending.filter((p) => decision(p) === "accept");
  const kind = proposals[0]?.kind;
  const applied = proposals.filter((p) => p.status === "accepted").length;
  const overall: Proposal["status"] | "partial" = pending.length ? "pending" : applied === proposals.length ? "accepted" : applied ? "partial" : proposals.every((p) => p.status === "stale") ? "stale" : "rejected";

  async function run(all: "apply" | "reject") {
    setBusy(all);
    setFailures([]);
    const fails: string[] = [];
    let ok = 0;
    for (const p of pending) {
      const act = all === "reject" ? "reject" : decision(p);
      try {
        await api(`/assistant/proposals/${p.id}/${act}`, { body: {} });
        if (act === "accept") ok += 1;
      } catch (err) {
        const key = p.target?.key ?? p.key;
        fails.push(
          err instanceof ApiError && err.status === 409
            ? `${key} wasn’t changed: someone edited it since.`
            : err instanceof ApiError && err.status === 403
              ? `${key} wasn’t changed: you don’t have permission.`
              : `${key} wasn’t changed: ${err instanceof Error ? err.message : "error"}.`,
        );
      }
    }
    setBusy(null);
    if (all === "apply") {
      const total = accepted.length;
      if (fails.length) setFailures([...fails, `${ok} of ${total} change${total === 1 ? "" : "s"} applied.`]);
      const caseCount = pending
        .filter((p) => decision(p) === "accept" && isCaseList(p))
        .reduce((n, p) => n + (proposedCases(p).length || 1), 0);
      if (ok) toast(proposalAppliedToast(kind, ok, caseCount || ok));
    } else toast("Proposal rejected. Nothing was changed.", "info");
    onDone();
  }

  const suiteCount = kind === "set_suite" ? accepted.reduce((n, p) => n + (suiteChanges(p).length || 1), 0) : 0;
  const caseTotal = kind === "add_test_cases" ? accepted.reduce((n, p) => n + (proposedCases(p).length || 1), 0) : 0;
  const applyLabel =
    kind === "set_suite"
      ? `Apply ${suiteCount} suite change${suiteCount === 1 ? "" : "s"}`
      : kind === "add_test_cases"
        ? `Add ${caseTotal} test case${caseTotal === 1 ? "" : "s"}`
        : `Apply ${accepted.length} accepted change${accepted.length === 1 ? "" : "s"}`;

  if (proposals.length === 0) return null;
  return (
    <section aria-label={`Proposal · ${KIND_LABEL[kind ?? "update_requirement"]}`} className="mt-3 rounded-lg border border-line-strong bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h4 className="text-small font-semibold text-fg-strong">Proposal · {KIND_LABEL[kind ?? "update_requirement"]}</h4>
        <StatusPill
          status={overall === "pending" ? "awaiting_approval" : overall === "accepted" ? "approved" : overall === "stale" ? "out_of_date" : overall === "partial" ? "approved" : "rejected"}
          label={overall === "pending" ? "Waiting for your review" : overall === "partial" ? `Applied (${applied} of ${proposals.length})` : STATUS_LABEL[overall as Proposal["status"]]}
        />
      </div>
      <div className="space-y-2 px-3 py-3">
        {request && <p className="text-small text-fg">From your request: “{request}”</p>}
        <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
          {proposals.length} change{proposals.length === 1 ? "" : "s"} · <GeneratedByLabel generatedBy={proposals[0].generated_by} />
        </p>
        {proposals.map((p) => (
          <Row
            key={p.id}
            p={p}
            fullViewHref={fullViewHref ?? `/projects/${projectId}/assistant`}
            compact={compact}
            value={decision(p)}
            onChange={(v) => setDecisions({ ...decisions, [p.id]: v })}
            onLocked={onLocked}
            canWrite={canWrite}
          />
        ))}
        {failures.length > 0 && (
          <InlineError error={failures.join(" ")} />
        )}
        {pending.length > 0 && kind === "add_test_cases" && <p className="text-small text-fg">Accepted cases are added as drafts. Review and approve them in Test Cases.</p>}
        {pending.length > 0 && !canWrite && <p className="text-small text-fg-muted">Only members, owners and admins can apply proposals.</p>}
        {pending.length > 0 && canWrite && (
          <>
            <p className="text-small text-fg-muted">
              Applying creates new revisions attributed to you, “applied from AI QA Analyst proposal”.{gateReopens ? ` ${gateReopens}` : ""}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => void run("reject")} loading={busy === "reject"}>
                Reject all
              </Button>
              <Button size="sm" onClick={() => void run("apply")} loading={busy === "apply"} disabled={accepted.length === 0}>
                {applyLabel}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
