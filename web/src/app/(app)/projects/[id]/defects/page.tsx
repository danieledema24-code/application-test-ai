"use client";

// Defects workspace (design P4 §11.1–11.3, §11.6): Defects | Review · Gate 8. Bulk actions skip rows they don't
// apply to, with reasons. No delete anywhere.

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, buildQuery } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDate } from "@/lib/format";
import { ACTION_TEXT, bulkPlan, bulkQuestion, emptyDefectsText, reproText, type DefectAction, type DefectList, type DefectRow } from "@/lib/defects";
import { BULK_BAR_PADDING, BulkActionBar, Button, Callout, ConfirmDialog, EmptyState, ErrorState, LinkButton, SelectField, Skeleton, TabPanel, Table, Tabs, TBody, Td, TextField, Th, THead, Tr, useToast } from "@/components/ui";
import { DefectStatusPill, SeverityValue } from "@/components/domain/ExecutionLabels";
import { PriorityValue } from "@/components/testcases/Bits";
import { useProject } from "@/components/workspace/ProjectContext";
import { Gate8Review } from "@/components/defects/Gate8Review";
import { RejectDefectDialog, type RejectInput } from "@/components/defects/RejectDefectDialog";
import type { Priority } from "@/lib/contract";

const STATUS = [
  { value: "open", label: "Open" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "fixed", label: "Fixed" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const SEVERITY = [{ value: "", label: "Any" }, ...["critical", "major", "minor", "trivial"].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))];
const PRIORITY = [{ value: "", label: "Any" }, ...["critical", "high", "medium", "low"].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))];

function Defects() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const viewer = role === "viewer" || role === null;
  const view = params.get("view") === "review" ? "review" : "list";
  const status = params.get("status") ?? "open";
  const severity = params.get("severity") ?? "";
  const priority = params.get("priority") ?? "";
  const qText = params.get("q") ?? "";
  const [search, setSearch] = useState(qText);
  const list = useApi<DefectList>(`/projects/${p.id}/defects`, { status, severity: severity || undefined, priority: priority || undefined, q: qText || undefined });
  const all = useApi<DefectList>(`/projects/${p.id}/defects`, { status: "all" });
  const runs = useApi<{ items: { key: string; analysis?: unknown }[] }>(`/projects/${p.id}/execution-runs`, { limit: 1 }, { shouldRetryOnError: false });
  const fa = p.workflow?.stages.find((s) => s.key === "failure_analysis");
  const analysing = fa?.status === "running" || fa?.status === "queued";
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<DefectAction | null>(null);
  const [busy, setBusy] = useState(false);
  const d = list.data;
  const everything = all.data;
  const canDecide = !!d?.permissions.can_decide && !viewer;
  const canRaise = !!d?.permissions.can_raise && !viewer;

  useEffect(() => {
    document.title = `Defects · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  useEffect(() => setSearch(qText), [qText]);

  function go(next: Record<string, string | undefined>) {
    const cur = { view: view === "review" ? "review" : undefined, status: status === "open" ? undefined : status, severity: severity || undefined, priority: priority || undefined, q: qText || undefined };
    const merged = { ...cur, ...next };
    if (merged.status === "open") merged.status = undefined;
    router.push(`/projects/${p.id}/defects${buildQuery(merged)}`, { scroll: false });
  }
  function reload() {
    void list.mutate();
    void all.mutate();
    p.refresh();
  }

  const rows = useMemo(() => d?.items ?? [], [d]);
  const chosen = rows.filter((r) => selected.includes(r.id));
  // A row gets a checkbox only when this person can do something to it now (no checkbox when only G8 applies).
  const selectable = (r: DefectRow) => Object.values(r.actions).some((v) => v === null);
  const plan = bulk ? bulkPlan(chosen, bulk) : null;

  async function runBulk(action: DefectAction, extra: Partial<RejectInput> = {}) {
    if (!plan || !plan.apply.length) return;
    setBusy(true);
    try {
      const r = await api<{ message: string; skipped: { key: string; reason: string }[] }>(`/projects/${p.id}/defects/bulk-status`, { method: "POST", body: { action, ids: plan.apply.map((x) => x.id), ...extra } });
      const skippedTotal = r.skipped.length + plan.skipped.length;
      const msg = r.message.replace(/ \d+ skipped\.$/, "") + (skippedTotal ? ` ${skippedTotal} skipped.` : "");
      toast(msg, "success", skippedTotal ? { action: { label: "Show skipped", onClick: () => toast([...plan.skipped, ...r.skipped].map((s) => `${s.key}: ${s.reason}`).join(" · "), "info") } } : undefined);
      setSelected([]);
      setBulk(null);
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn’t update the defects. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  const drafts = (everything?.items ?? []).filter((x) => x.status === "draft");
  const decided = (everything?.items ?? []).filter((x) => x.status !== "draft");
  const hidden = everything ? { closed: everything.counts.closed, rejected: everything.counts.rejected } : null;
  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          Defects
        </h1>
        {canRaise && <LinkButton href={`/projects/${p.id}/defects/new`}>Raise defect…</LinkButton>}
      </div>
      <p className="text-body text-fg-muted">Drafted from likely application bugs found in test runs, or raised by people. Each draft is confirmed or rejected at Gate 8.</p>
    </div>
  );
  if (list.error && !d)
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={list.error} title="Couldn’t load defects." message="Try again." onRetry={() => void list.mutate()} />
      </div>
    );
  if (!d)
    return (
      <div className="space-y-6" aria-busy="true">
        {header}
        <Skeleton className="h-48" />
      </div>
    );

  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  return (
    <div className={`space-y-6 ${selected.length ? BULK_BAR_PADDING : ""}`}>
      {header}
      {drafts.length > 0 && view === "list" && (
        <Callout tone="warning" title={canDecide ? `${drafts.length} defect ${drafts.length === 1 ? "draft is" : "drafts are"} waiting for your review.` : `${drafts.length} defect ${drafts.length === 1 ? "draft is" : "drafts are"} waiting for review by someone who can approve gates.`} actions={<Button variant="secondary" onClick={() => go({ view: "review" })}>Review Gate 8</Button>} />
      )}
      {analysing && <Callout tone="info" role="status">Working out why {runs.data?.items[0]?.key ?? "the latest run"}&apos;s tests failed. Drafts appear here when it finishes.</Callout>}
      <div>
        <Tabs
          tabs={[
            { id: "list", label: `Defects (${(everything?.items ?? rows).filter((x) => ["draft", "confirmed", "fixed"].includes(x.status)).length})` },
            { id: "review", label: `Review · Gate 8 (${drafts.length})` },
          ]}
          value={view}
          onChange={(v) => go({ view: v === "review" ? "review" : undefined })}
          label="Defect views"
          idPrefix="def"
        />
        <TabPanel id={view} idPrefix="def">
          {view === "review" ? (
            everything ? <Gate8Review projectId={p.id} drafts={drafts} decided={decided} list={everything} viewer={viewer} onChanged={reload} /> : <Skeleton className="h-40" />
          ) : total === 0 ? (
            <EmptyState title={emptyDefectsText(d.finished_runs)} action={<LinkButton href={`/projects/${p.id}/execution`}>Open Test Execution</LinkButton>} />
          ) : (
            <div className="space-y-4">
              <form
                className="flex flex-wrap items-end gap-3"
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  go({ q: search.trim() || undefined });
                }}
              >
                <TextField label="Search" placeholder="DEF id, summary" value={search} onChange={(e) => setSearch(e.target.value)} wrapClassName="w-60" />
                <SelectField label="Status" value={status} onChange={(e) => go({ status: e.target.value })} options={STATUS} wrapClassName="w-40" />
                <SelectField label="Severity" value={severity} onChange={(e) => go({ severity: e.target.value || undefined })} options={SEVERITY} wrapClassName="w-36" />
                <SelectField label="Priority" value={priority} onChange={(e) => go({ priority: e.target.value || undefined })} options={PRIORITY} wrapClassName="w-36" />
              </form>
              {status === "open" && hidden && hidden.closed + hidden.rejected > 0 && (
                <p className="text-small text-fg-muted">
                  {hidden.closed} closed and {hidden.rejected} rejected {hidden.closed + hidden.rejected === 1 ? "defect is" : "defects are"} hidden.{" "}
                  <button type="button" className="font-medium text-navy-700 underline underline-offset-2" onClick={() => go({ status: "all" })}>
                    Show them
                  </button>
                </p>
              )}
              {rows.length === 0 ? (
                <EmptyState title="No defects match these filters." action={<Button variant="secondary" onClick={() => router.push(`/projects/${p.id}/defects`)}>Clear filters</Button>} />
              ) : (
                <>
                  <div className="hidden md:block">
                    <Table label="Defects">
                      <THead>
                        <tr>
                          {!viewer && <Th srOnly>Select</Th>}
                          <Th>Defect</Th>
                          <Th>Severity</Th>
                          <Th>Priority</Th>
                          <Th>Status</Th>
                          <Th>Reproducibility</Th>
                          <Th>Test case · Req.</Th>
                          <Th>Last seen</Th>
                        </tr>
                      </THead>
                      <TBody>
                        {rows.map((r) => (
                          <Tr key={r.id}>
                            {!viewer && (
                              <Td>
                                {selectable(r) && (
                                  <input
                                    type="checkbox"
                                    className="h-5 w-5"
                                    aria-label={`Select ${r.key} ${r.summary}`}
                                    checked={selected.includes(r.id)}
                                    onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))}
                                  />
                                )}
                              </Td>
                            )}
                            <Td rowHeader>
                              <Link href={`/projects/${p.id}/defects/${r.key}`} className="font-medium text-navy-700 underline underline-offset-2">
                                <span className="font-mono">{r.key}</span> {r.summary}
                              </Link>
                              <span className="block text-caption text-fg-muted">{r.source === "analysis" ? "from analysis" : "raised by a person"}</span>
                            </Td>
                            <Td>
                              <SeverityValue severity={r.severity} />
                            </Td>
                            <Td>
                              <PriorityValue priority={r.priority as Priority} />
                            </Td>
                            <Td>
                              <DefectStatusPill status={r.status} />
                            </Td>
                            <Td>{reproText(r.reproducibility)}</Td>
                            <Td>{[r.cases.join(", "), r.requirements.join(", ")].filter(Boolean).join(" · ") || "None"}</Td>
                            <Td>{r.run_key ? `${r.run_key} ${fmtDate(r.last_seen)}` : fmtDate(r.created_at)}</Td>
                          </Tr>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                  <ul className="space-y-3 md:hidden" aria-label="Defects">
                    {rows.map((r) => (
                      <li key={r.id} className="space-y-1 rounded-lg bg-surface p-4 ring-1 ring-line">
                        <p className="flex flex-wrap items-center gap-2">
                          <Link href={`/projects/${p.id}/defects/${r.key}`} className="font-mono font-medium text-navy-700 underline underline-offset-2">
                            {r.key}
                          </Link>
                          <SeverityValue severity={r.severity} />
                          <DefectStatusPill status={r.status} withNote={false} />
                        </p>
                        <p className="text-body text-fg">{r.summary}</p>
                        <p className="text-small text-fg-muted">
                          {reproText(r.reproducibility)} · {r.cases.join(", ") || "No test case"}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </TabPanel>
      </div>
      {view === "list" && (
        <BulkActionBar count={selected.length} onClear={() => setSelected([])}>
          {canDecide && (
            <>
              <Button size="sm" onClick={() => setBulk("confirm")}>
                Confirm {selected.length}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setBulk("reject")}>
                Reject {selected.length}…
              </Button>
            </>
          )}
          <Button size="sm" variant="secondary" onClick={() => setBulk("fixed")}>
            Mark fixed
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setBulk("closed")}>
            Close
          </Button>
        </BulkActionBar>
      )}
      {plan && bulk && bulk !== "reject" && (
        <ConfirmDialog
          open
          onClose={() => setBulk(null)}
          onConfirm={() => void runBulk(bulk)}
          title={`${ACTION_TEXT[bulk].verb} defects`}
          confirmLabel={plan.apply.length >= 100 && chosen.length > 100 ? `${ACTION_TEXT[bulk].verb} first 100` : `${ACTION_TEXT[bulk].verb} ${plan.apply.length}`}
          loading={busy}
        >
          <p>{bulkQuestion(bulk, chosen.length, plan.skipped)}</p>
          {plan.skipped.length > 0 && (
            <ul className="list-disc pl-5 text-small">
              {plan.skipped.map((s) => (
                <li key={s.key}>
                  {s.key}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </ConfirmDialog>
      )}
      <RejectDefectDialog
        open={bulk === "reject"}
        onClose={() => setBulk(null)}
        count={plan?.apply.length ?? 0}
        projectId={p.id}
        duplicates={(everything?.items ?? []).map((x) => ({ key: x.key, summary: x.summary }))}
        onReject={(v) => runBulk("reject", v)}
      />
    </div>
  );
}

export default function DefectsPage() {
  return (
    <Suspense>
      <Defects />
    </Suspense>
  );
}
