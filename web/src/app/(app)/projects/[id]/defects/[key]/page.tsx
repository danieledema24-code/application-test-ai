"use client";

// Defect detail (design P4 §11.4): every §11 field labelled ("None" when empty), status actions with one primary per
// state, G8 per defect, verify only after a passing re-run. `?edit=1` edits drafts and confirmed defects. No delete.

import { RemovedEvidence, removedText } from "@/components/domain/RemovedEvidence";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { CONFIDENCE_TEXT } from "@/lib/execution";
import { checkHref, DEFECT_STATUS, environmentLine, isCheckDraft, NF_ROOT_CAUSE, nfOccurrences, PRIORITY_TEXT, rejectReasonText, SOURCE_TEXT, reproText, type DefectAction, type DefectDetail, type DefectList } from "@/lib/defects";
import { Button, Callout, EmptyState, ErrorState, LinkButton, Skeleton, useToast } from "@/components/ui";
import { ClassificationLabel, DefectStatusPill, HypothesisLabel, ObservedLabel, SeverityValue } from "@/components/domain/ExecutionLabels";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useProject } from "@/components/workspace/ProjectContext";
import { RejectDefectDialog, type RejectInput } from "@/components/defects/RejectDefectDialog";
import { DefectForm, lines, type DefectFields } from "@/components/defects/DefectForm";

function Field({ label, children, badge }: { label: string; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div>
      <h2 className="flex flex-wrap items-center gap-2 text-body font-semibold text-fg-strong">
        {label} {badge}
      </h2>
      <div className="mt-1 text-body text-fg">{children}</div>
    </div>
  );
}

function Side({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line py-2.5 last:border-0">
      <dt className="text-small font-semibold text-fg-strong">{label}</dt>
      <dd className="mt-0.5 text-body text-fg">{children}</dd>
    </div>
  );
}

const none = (v: string | null | undefined) => (v && v.trim() ? v : "None");

function DefectPage() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { key: rawKey } = useParams<{ key: string }>();
  const key = decodeURIComponent(rawKey);
  const q = useApi<DefectDetail>(`/projects/${p.id}/defects/by-key/${key}`, undefined, { shouldRetryOnError: false });
  const others = useApi<DefectList>(`/projects/${p.id}/defects`, { status: "all" });
  const d = q.data;
  const editing = params.get("edit") === "1" && !!d?.permissions.can_edit;
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState<DefectAction | null>(null);

  useEffect(() => {
    document.title = `${key} · Defects · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [key, p.project?.name]);

  const back = (
    <Link href={`/projects/${p.id}/defects`} className="inline-flex items-center gap-1 text-small font-medium text-navy-700 underline underline-offset-2">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Defects
    </Link>
  );
  if (q.error && !d) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return <EmptyState title={`We couldn’t find ${key} in this project.`} action={<LinkButton href={`/projects/${p.id}/defects`}>Back to defects</LinkButton>} />;
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={q.error} title={`Couldn’t load ${key}.`} message="Try again." onRetry={() => void q.mutate()} />
      </div>
    );
  }
  if (!d)
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-96" />
      </div>
    );

  const caseKey = d.cases[0] ?? null;
  async function act(action: DefectAction, extra: Partial<RejectInput> = {}) {
    setBusy(action);
    try {
      const r = await api<{ message: string; defect: DefectDetail }>(`/defects/${d!.id}/status`, { method: "POST", body: { action, ...extra } });
      await q.mutate(r.defect, { revalidate: false });
      toast(r.message, "success");
      setRejecting(false);
      p.refresh();
    } catch (e) {
      if (action === "reject") throw e;
      toast(e instanceof ApiError ? e.message : "Couldn’t update the defect. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }
  async function save(f: DefectFields) {
    const body: Record<string, unknown> = {
      version: d!.version,
      summary: f.summary,
      description: f.description,
      preconditions: lines(f.preconditions),
      steps: lines(f.steps),
      expected: f.expected,
      actual: f.actual,
    };
    if (f.severity && f.severity !== d!.severity) Object.assign(body, { severity: f.severity, severity_reason: f.severity_reason });
    if (f.priority && f.priority !== d!.priority) Object.assign(body, { priority: f.priority, priority_reason: f.priority_reason });
    const r = await api<DefectDetail>(`/defects/${d!.id}`, { method: "PATCH", body });
    await q.mutate(r, { revalidate: false });
    toast(`${r.key} saved.`, "success");
    router.push(`/projects/${p.id}/defects/${r.key}`);
  }

  const st = DEFECT_STATUS[d.status];
  const canDecide = d.permissions.can_decide;
  const member = d.actions.fixed !== "permission";
  const permNote = "You can read and edit this draft, but confirming or rejecting needs gate-approval permission. Ask someone who can approve gates.";
  const rerun = caseKey && member ? <LinkButton href={`/projects/${p.id}/execution?new=1&cases=${caseKey}`}>Re-run {caseKey}…</LinkButton> : null;
  const env = d.environment ?? {};
  // Drafts from checks and exploration (design P5 §10, P6 §9.8): observed facts, no root-cause analysis.
  const nf = isCheckDraft(d.source);

  if (editing)
    return (
      <div className="space-y-6">
        {back}
        <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Edit {d.key}</h1>
        <p className="text-small text-fg-muted">The cause is changed on the result (Change the cause), not here. Occurrences, links and the Gate 8 record can&apos;t be edited.</p>
        <DefectForm
          initial={{
            summary: d.summary,
            description: d.description ?? "",
            preconditions: (d.preconditions ?? []).join("\n"),
            steps: (d.steps ?? []).join("\n"),
            expected: d.expected ?? "",
            actual: d.actual ?? "",
            severity: d.severity,
            priority: d.priority,
            severity_reason: "",
            priority_reason: "",
          }}
          original={{ severity: d.severity, priority: d.priority }}
          submitLabel="Save changes"
          onSubmit={save}
          onCancel={() => router.push(`/projects/${p.id}/defects/${d.key}`)}
        />
      </div>
    );

  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {d.key} · {d.summary}
          </h1>
          <DefectStatusPill status={d.status} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {d.status === "draft" && (
            <>
              <Button onClick={() => canDecide && void act("confirm")} loading={busy === "confirm"} aria-disabled={!canDecide || undefined} aria-describedby={!canDecide ? "def-perm" : undefined}>
                Confirm
              </Button>
              <Button variant="secondary" onClick={() => canDecide && setRejecting(true)} aria-disabled={!canDecide || undefined} aria-describedby={!canDecide ? "def-perm" : undefined}>
                Reject…
              </Button>
            </>
          )}
          {d.status === "confirmed" && member && (
            <Button onClick={() => void act("fixed")} loading={busy === "fixed"}>
              Mark fixed
            </Button>
          )}
          {d.status === "fixed" && (
            <div className="flex flex-col gap-1">
              <Button onClick={() => canDecide && d.verify?.ready && void act("verified")} loading={busy === "verified"} aria-disabled={!canDecide || !d.verify?.ready || undefined} aria-describedby="def-verify">
                Mark verified
              </Button>
              <p id="def-verify" className="text-small text-fg-muted">
                {!canDecide ? "Marking a fix verified needs gate-approval permission." : d.verify?.message}
              </p>
            </div>
          )}
          {(d.status === "verified" || d.status === "rejected") && member && (
            <Button variant={d.status === "verified" ? "primary" : "secondary"} onClick={() => void act("closed")} loading={busy === "closed"}>
              Close
            </Button>
          )}
          {d.permissions.can_edit && (
            <LinkButton href={`/projects/${p.id}/defects/${d.key}?edit=1`}>Edit</LinkButton>
          )}
          {(d.status === "confirmed" || d.status === "fixed") && rerun}
        </div>
        {d.status === "draft" && !canDecide && member && (
          <Callout tone="neutral">
            <span id="def-perm">{permNote}</span>
          </Callout>
        )}
        {d.status === "rejected" && (
          <p className="text-body text-fg">
            Rejected by {d.g8?.by?.full_name || d.g8?.by?.email || "someone"}: {rejectReasonText(d.status_reason)}
            {d.status_comment ? ` · '${d.status_comment}'` : ""}
          </p>
        )}
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Field label="Description">{none(d.description)}</Field>
          <Field label="Environment">
            {environmentLine(d, fmtDateTime)}
          </Field>
          <Field label="Preconditions">
            {d.preconditions?.length ? (
              <ul className="list-disc pl-5">
                {d.preconditions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : (
              "None"
            )}
          </Field>
          <Field label="Steps to reproduce">
            {d.steps?.length ? (
              <ol className="list-decimal pl-5">
                {d.steps.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            ) : (
              "None"
            )}
          </Field>
          <Field label="Expected result">
            {none(d.expected)}
          </Field>
          <Field
            label="Actual result"
            badge={
              d.source === "analysis" ? (
                <ObservedLabel text="Observed on the page" />
              ) : d.source === "performance" ? (
                <ObservedLabel text={`Measured during ${env.run_key ?? "the load test"}`} />
              ) : nf ? (
                <ObservedLabel text="Observed" />
              ) : undefined
            }
          >
            {none(d.actual)}
          </Field>
          {nf ? (
            <Field label="Root cause">{NF_ROOT_CAUSE}</Field>
          ) : (
            <Field label="Root cause" badge={<HypothesisLabel />}>
            {d.analysis ? (
              <span className="flex flex-wrap items-center gap-2">
                <ClassificationLabel classification={d.analysis.classification} /> ({CONFIDENCE_TEXT[d.analysis.confidence] ?? d.analysis.confidence})
              </span>
            ) : null}
            <span className="mt-1 block">{none(d.root_cause_hypothesis)}</span>
            </Field>
          )}
          <Field label="Evidence">
            {d.evidence.length ? (
              <ul className="flex flex-wrap gap-3">
                {d.evidence.map((e) => (
                  <li key={e.id}>
                    {removedText(e) ? (
                      <RemovedEvidence text={removedText(e)!} className="h-24 w-40 min-h-0 px-2 py-1" />
                    ) : e.kind === "screenshot" ? (
                      <a href={e.content_url} target="_blank" rel="noreferrer" className="block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={e.content_url} alt={`Screenshot from ${env.result_key ?? d.key}`} className="h-24 w-40 rounded object-cover object-top ring-1 ring-line" />
                      </a>
                    ) : (
                      <a href={e.content_url} target="_blank" rel="noreferrer" className="font-medium text-navy-700 underline underline-offset-2">
                        {e.kind === "video" ? "Video" : e.kind === "console_log" ? "Console log" : e.kind === "network_log" ? "Network log" : e.kind === "trace" ? "Trace" : e.kind}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              "None"
            )}
          </Field>
          {d.g8 && (
            <Field label="Gate 8 record">
              {d.g8.decision === "approve" ? "Confirmed" : "Rejected"} by {d.g8.by?.full_name || d.g8.by?.email || "someone"} · {fmtDateTime(d.g8.at)}
              {d.g8.comment ? ` · '${d.g8.comment}'` : ""}
            </Field>
          )}
        </div>
        <dl className="h-fit rounded-xl bg-surface px-4 py-2 ring-1 ring-line">
          <Side label="Severity">
            <SeverityValue severity={d.severity} />
            {d.severity_reason && <span className="mt-1 block text-small text-fg-muted">{d.severity_reason}</span>}
          </Side>
          <Side label="Priority">
            {PRIORITY_TEXT[d.priority] ?? d.priority}
            {d.priority_reason && <span className="text-small text-fg-muted"> · {d.priority_reason}</span>}
          </Side>
          <Side label="Reproducibility">{reproText(d.reproducibility)}</Side>
          <Side label="Status flow">
            Draft → Confirmed → Fixed → Verified → Closed
            <span className="block text-small text-fg-muted">Now: {st.label}</span>
          </Side>
          <Side label="Links">
            {[
              ...d.requirements,
              ...d.cases,
              d.result ? d.result.key : null,
              d.script ? `script v${d.script.version}` : null,
              env.duplicate_of ? `Duplicate of ${env.duplicate_of}` : null,
              env.related_to ? `Related to ${env.related_to}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "None"}
            {d.result && env.run_key && (
              <Link href={`/projects/${p.id}/execution/${env.run_key}/results/${d.result.key}`} className="mt-1 block font-medium text-navy-700 underline underline-offset-2">
                Open {d.result.key} result
              </Link>
            )}
          </Side>
          {nf ? (
            <Side label={`Occurrences (${nfOccurrences(d).length})`}>
              {nfOccurrences(d).length ? (
                <ul>
                  {nfOccurrences(d).map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              ) : (
                "None"
              )}
              {checkHref(p.id, env) && (
                <Link
                  href={checkHref(p.id, env)!}
                  className="mt-1 block font-medium text-navy-700 underline underline-offset-2"
                >
                  Open {env.scan_key ?? env.run_key}
                </Link>
              )}
            </Side>
          ) : (
          <Side label={`Occurrences (${d.occurrences.length})`}>
            {d.occurrences.length ? (
              <ul>
                {d.occurrences.map((o) => (
                  <li key={o.result_id}>
                    {o.run_key} {fmtDate(o.seen_at)}
                  </li>
                ))}
              </ul>
            ) : (
              "None"
            )}
          </Side>
          )}
          <Side label="Source">
            {d.source === "analysis" ? (
              <span className="flex flex-wrap items-center gap-2">
                Drafted by the Defect Analysis Agent <GeneratedByLabel generatedBy={d.analysis?.generated_by ?? "rules"} />
              </span>
            ) : nf ? (
              `${SOURCE_TEXT[d.source]} · drafted from ${env.scan_key ?? env.run_key ?? "a check"}`
            ) : (
              "Raised by a person"
            )}
          </Side>
        </dl>
      </div>
      <RejectDefectDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        subject={d.key}
        count={1}
        caseKey={caseKey}
        projectId={p.id}
        duplicates={(others.data?.items ?? []).filter((x) => x.id !== d.id).map((x) => ({ key: x.key, summary: x.summary }))}
        onReject={(v) => act("reject", v)}
        nonFunctional={isCheckDraft(d.source)}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DefectPage />
    </Suspense>
  );
}
