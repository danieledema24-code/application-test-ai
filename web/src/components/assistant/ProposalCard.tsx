"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { AcceptanceCriterionCreate, Proposal, RequirementDetail } from "@/lib/contract";
import { likelihoodText, impactText } from "@/lib/strategy";
import { Button, InlineError, StatusPill, useToast } from "@/components/ui";
import { GeneratedByLabel, ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { DiffView } from "@/components/domain/DiffView";

const KIND_LABEL: Record<Proposal["kind"], string> = {
  add_acceptance_criteria: "Add acceptance criteria",
  update_requirement: "Update requirements",
  add_requirement: "Suggest missing requirements",
  reassess_risks: "Reassess application risk",
  update_risk: "Update risk",
  regenerate_stage: "Regenerate",
};

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "Waiting for your review",
  accepted: "Applied",
  rejected: "Rejected",
  stale: "Out of date",
  failed: "Failed",
};

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

function Item({ p, value, onChange, lockedReason, compact, fullViewHref }: { p: Proposal; value: "accept" | "reject"; onChange: (v: "accept" | "reject") => void; lockedReason: string | null; compact?: boolean; fullViewHref: string }) {
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
          {isAcList(p.preview) ? (
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
          {p.status === "stale" && <p className="text-small font-medium text-warning-fg">{p.target?.key ?? "The target"} changed after this proposal was made. Ask again to get a proposal for the current version.</p>}
          {p.result?.error && <p className="text-small text-danger-fg">{p.result.error}</p>}
        </div>
        {pending ? (
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

/** Locked target requirements can't be changed by a proposal (design §11.4, check 48). */
function useLockedReason(p: Proposal): string | null {
  const isReq = p.target?.type === "requirement" && !!p.target.id && p.kind !== "add_requirement";
  const req = useApi<RequirementDetail>(isReq && p.status === "pending" ? `/requirements/${p.target!.id}` : null, undefined, { shouldRetryOnError: false });
  return req.data?.locked ? `${req.data.key} is locked. Unlock it to apply this change.` : null;
}

function Row(props: { p: Proposal; value: "accept" | "reject"; onChange: (v: "accept" | "reject") => void; onLocked: (id: string, locked: boolean) => void; compact?: boolean; fullViewHref: string }) {
  const lockedReason = useLockedReason(props.p);
  const { onLocked, p } = props;
  useEffect(() => onLocked(p.id, !!lockedReason), [onLocked, p.id, lockedReason]);
  return <Item {...props} lockedReason={lockedReason} />;
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
      if (ok) toast(`${ok} change${ok === 1 ? "" : "s"} applied. View in ${kind?.includes("risk") ? "Test Strategy" : "Requirements"}.`);
    } else toast("Proposal rejected. Nothing was changed.", "info");
    onDone();
  }

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
          />
        ))}
        {failures.length > 0 && (
          <InlineError error={failures.join(" ")} />
        )}
        {pending.length > 0 && (
          <>
            <p className="text-small text-fg-muted">
              Applying creates new revisions attributed to you, “applied from AI QA Analyst proposal”.{gateReopens ? ` ${gateReopens}` : ""}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => void run("reject")} loading={busy === "reject"}>
                Reject all
              </Button>
              <Button size="sm" onClick={() => void run("apply")} loading={busy === "apply"} disabled={accepted.length === 0}>
                Apply {accepted.length} accepted change{accepted.length === 1 ? "" : "s"}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
