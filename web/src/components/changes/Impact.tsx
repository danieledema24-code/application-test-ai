"use client";

// Impact and the regression run of a change set (design P6 §7, P6-02, D27, D28): what each change affects, as nested
// lists with the reason verbatim, the close dialog for the items a person closes, and the recommended regression run
// that a member requests (it still waits for Gate 7). Re-run and repair items close themselves (OQ4); a must-run
// test whose script is outdated blocks the request until its repair is decided (OQ3).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  DEFAULT_IMPACT_FILTER,
  IMPACT_GROUP_TITLE,
  IMPACT_GROUPS,
  IMPACT_HOW,
  IMPACT_LEVEL_HELP,
  IMPACT_LEVEL_LABEL,
  IMPACT_LEVELS,
  IMPACT_STATUS_LABEL,
  IMPACT_STATUSES,
  TARGET_KIND_LABEL,
  autoCloseLine,
  byGroup,
  closeErrors,
  closedLine,
  estimateLine,
  filterImpact,
  impactHeading,
  includeShouldText,
  nextCloseTarget,
  requestedRunStatus,
  requestedToast,
  requirementTree,
  targetLabel,
  type ChangeSet,
  type ImpactFilter,
  type ImpactGroup,
  type ImpactItem,
  type ImpactNode,
  type ImpactView,
  type Recommendation,
  type RegressionPick,
} from "@/lib/change";
import type { RunDetail } from "@/lib/execution";
import { fmtDateTime } from "@/lib/format";
import { Button, Callout, Checkbox, Disclosure, EmptyState, ErrorState, InlineError, Modal, SelectField, Skeleton, Table, TBody, Td, TextArea, Th, THead, Tr, useToast } from "@/components/ui";
import { ImpactActionLabel, ImpactLegend, ImpactLevelLabel, ImpactStatusLabel, ScriptStateLabel } from "@/components/domain/ChangeLabels";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useProject } from "@/components/workspace/ProjectContext";

const link = "font-medium text-navy-700 underline underline-offset-2";
type KindFilter = ImpactFilter["kind"];

/** Where an item's key links to, if it has a page of its own. */
function targetHref(projectId: string, i: ImpactItem): string | null {
  const key = i.target?.key;
  if (!key) return null;
  if (i.target_kind === "requirement") return `/projects/${projectId}/requirements/${key}`;
  if (i.target_kind === "test_case" || i.target_kind === "automation_script") return `/projects/${projectId}/test-cases/${key}`;
  if (i.target_kind === "defect") return `/projects/${projectId}/defects/${key}`;
  if (i.target_kind === "performance_target") return `/projects/${projectId}/non-functional/profiles/${key}`;
  return null;
}

// ------------------------------------------------------------------ impact tab (§7.1)

export function ImpactTab({ set, view, onChanged, onRegenerate, initialKind = "" }: { set: ChangeSet; view: ImpactView; onChanged: () => Promise<unknown>; onRegenerate?: () => void; initialKind?: KindFilter }) {
  const toast = useToast();
  const [f, setF] = useState<ImpactFilter>({ ...DEFAULT_IMPACT_FILTER, kind: initialKind });
  const [closing, setClosing] = useState<ImpactItem | null>(null);
  const all = view.items;
  const allClosed = all.length > 0 && all.every((i) => i.status !== "open");
  const status = allClosed && f.status === "open" ? "all" : f.status;
  const visible = useMemo(() => filterImpact(all, { ...f, status }), [all, f, status]);
  const visibleGroups = useMemo(() => byGroup(visible), [visible]);
  // A group stays (heading and "nothing open" line) while it has items under the level and type filters, so focus
  // can land on its heading after its last open item is closed (design P6 §7.2).
  const anyStatus = useMemo(() => byGroup(filterImpact(all, { ...f, status: "all" })), [all, f]);
  const filtered = f.level !== "" || f.kind !== "" || f.status !== "open";

  if (!view.available) return <EmptyState title="No impact for this comparison." description={view.reason ?? undefined} />;

  async function closed(item: ImpactItem, message: string) {
    toast(message, "success");
    const target = nextCloseTarget(visible, item.id);
    setClosing(null);
    await onChanged();
    // After the dialog has put focus back on its opener: the next open item's [Close…], else the group heading.
    setTimeout(() => {
      const el = target.kind === "item" ? document.getElementById(`close-${target.id}`) : document.getElementById(`impact-group-${target.group}`);
      (el ?? document.getElementById(`impact-group-${item.group}`) ?? document.getElementById("impact-h"))?.focus();
    }, 50);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="impact-h" tabIndex={-1} className="text-h2 font-semibold text-fg-strong focus:outline-none">
          {impactHeading(all)}
        </h2>
        <GeneratedByLabel generatedBy={view.generated_by} />
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
        <SelectField
          label="Level"
          value={f.level}
          onChange={(e) => setF({ ...f, level: e.target.value as ImpactFilter["level"] })}
          options={[{ value: "", label: "Any" }, ...IMPACT_LEVELS.map((l) => ({ value: l, label: IMPACT_LEVEL_LABEL[l] }))]}
          wrapClassName="w-full md:w-44"
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setF({ ...f, status: e.target.value as ImpactFilter["status"] })}
          options={[...IMPACT_STATUSES.map((s) => ({ value: s, label: IMPACT_STATUS_LABEL[s] })), { value: "all", label: "All" }]}
          wrapClassName="w-full md:w-48"
        />
        <SelectField
          label="Type"
          value={f.kind}
          onChange={(e) => setF({ ...f, kind: e.target.value as KindFilter })}
          options={[{ value: "", label: "Any" }, ...(Object.keys(TARGET_KIND_LABEL) as (keyof typeof TARGET_KIND_LABEL)[]).map((k) => ({ value: k, label: TARGET_KIND_LABEL[k] }))]}
          wrapClassName="w-full md:w-52"
        />
      </div>
      <Disclosure label="How impact works">
        <div className="mt-2 space-y-2">
          <ImpactLegend />
          <p className="text-small text-fg">{IMPACT_HOW}</p>
        </div>
      </Disclosure>
      <p role="status" aria-live="polite" className="sr-only">
        {`Showing ${visible.length} of ${all.length} impact items`}
      </p>
      {allClosed && <Callout tone="success">Every impact item from {set.key} is closed.</Callout>}
      {all.length === 0 ? (
        <EmptyState title={`Nothing approved is affected by ${set.key}.`} />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No impact items match these filters."
          action={
            filtered ? (
              <Button variant="secondary" onClick={() => setF(DEFAULT_IMPACT_FILTER)}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        IMPACT_GROUPS.filter((g) => anyStatus[g].length > 0).map((g) => (
          <ImpactGroupSection key={g} group={g} items={visibleGroups[g]} empty={status === "open" ? "Nothing open here." : "No items with this status here."} set={set} onClose={setClosing} onRegenerate={onRegenerate} />
        ))
      )}
      {closing && <CloseImpactDialog item={closing} onCancel={() => setClosing(null)} onClosed={(m) => void closed(closing, m)} />}
    </div>
  );
}

function ImpactGroupSection({ group, items, empty, set, onClose, onRegenerate }: { group: ImpactGroup; items: ImpactItem[]; empty: string; set: ChangeSet; onClose: (i: ImpactItem) => void; onRegenerate?: () => void }) {
  const headingId = `impact-group-${group}`;
  const row = (i: ImpactItem, heading?: React.ReactNode) => <ImpactRow item={i} heading={heading} set={set} onClose={onClose} onRegenerate={onRegenerate} />;
  let body: React.ReactNode;
  if (!items.length) body = <p className="text-small text-fg">{empty}</p>;
  else if (group === "requirements") body = <TreeList nodes={requirementTree(items)} render={row} label={IMPACT_GROUP_TITLE[group]} />;
  else if (group === "page_removed") {
    const pages = [...new Set(items.map((i) => i.page ?? ""))];
    body = (
      <ul className="space-y-3" aria-label={IMPACT_GROUP_TITLE[group]}>
        {pages.map((pg) => (
          <li key={pg} className="space-y-2">
            <p className="break-all text-body font-semibold text-fg-strong">{pg || "Removed page"}</p>
            <ul className="space-y-2 pl-3 md:pl-5">
              {items
                .filter((i) => (i.page ?? "") === pg)
                .map((i) => (
                  <li key={i.id}>{row(i)}</li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    );
  } else
    body = (
      <ul className="space-y-2" aria-label={IMPACT_GROUP_TITLE[group]}>
        {items.map((i) => (
          <li key={i.id}>{row(i)}</li>
        ))}
      </ul>
    );
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} tabIndex={-1} className="text-h3 font-semibold text-fg-strong focus:outline-none">
        {IMPACT_GROUP_TITLE[group]} <span className="font-normal text-fg-muted">({items.length})</span>
      </h3>
      {body}
    </section>
  );
}

/** Requirement → case → script as nested lists; a requirement row is a show/hide button (direct ones open). */
type RenderRow = (i: ImpactItem, heading?: React.ReactNode) => React.ReactNode;

function TreeList({ nodes, render, label }: { nodes: ImpactNode[]; render: RenderRow; label?: string }) {
  return (
    <ul className="space-y-2" aria-label={label}>
      {nodes.map((n) => (
        <TreeNode key={n.item.id} node={n} render={render} />
      ))}
    </ul>
  );
}

function TreeNode({ node, render }: { node: ImpactNode; render: RenderRow }) {
  const [open, setOpen] = useState(node.item.level === "direct");
  const id = useId();
  if (!node.children.length) return <li>{render(node.item)}</li>;
  const i = node.item;
  const changes = i.reason.match(/^(\d+) changes?/)?.[0];
  return (
    <li className="space-y-2">
      {render(
        i,
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`${targetLabel(i)}, ${IMPACT_LEVEL_LABEL[i.level].toLowerCase()}${changes ? `, ${changes}` : ""}`}
          onClick={() => setOpen(!open)}
          className="inline-flex min-h-8 items-start gap-1.5 text-left text-body font-semibold text-fg-strong hover:underline"
        >
          <ChevronDown className={`mt-1 h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`} aria-hidden />
          <span className="min-w-0 break-words">{targetLabel(i)}</span>
        </button>,
      )}
      <ul id={id} hidden={!open} className="space-y-2 pl-3 md:pl-6" aria-label={`Affected by ${targetLabel(i)}`}>
        {open &&
          node.children.map((c) =>
            c.children.length ? (
              <TreeNode key={c.item.id} node={c} render={render} />
            ) : (
              <li key={c.item.id}>{render(c.item)}</li>
            ),
          )}
      </ul>
    </li>
  );
}

function RowBody({ item: i }: { item: ImpactItem }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-small">
      <ImpactLevelLabel level={i.level} />
      <span className="sr-only">{IMPACT_LEVEL_HELP[i.level]}</span>
      <ImpactActionLabel action={i.action} />
      <ImpactStatusLabel status={i.status} />
    </div>
  );
}

function ImpactRow({ item: i, heading, set, onClose, onRegenerate }: { item: ImpactItem; heading?: React.ReactNode; set: ChangeSet; onClose: (i: ImpactItem) => void; onRegenerate?: () => void }) {
  const projectId = useProjectId();
  const href = targetHref(projectId, i);
  const auto = i.status === "open" ? autoCloseLine(i, set.key) : null;
  const done = closedLine(i, fmtDateTime);
  const label = targetLabel(i);
  const key = i.target?.key;
  const title = key && label.startsWith(key) ? label.slice(key.length).trim() : null;
  const script = i.target_kind === "test_case" ? i.target?.script : null;
  const heals = i.target?.heal_suggestions ?? [];
  const closeName = `Close impact item for ${key ?? (i.target_kind === "coverage_gap" ? label : TARGET_KIND_LABEL[i.target_kind as keyof typeof TARGET_KIND_LABEL] ?? "this item")}`;
  return (
    <div className="space-y-1.5 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
      {heading ?? (
        <p className="break-words text-body font-medium text-fg-strong">
          {href && key ? (
            <>
              <Link href={href} className={link}>
                {key}
              </Link>{" "}
              {title}
            </>
          ) : (
            label
          )}
        </p>
      )}
      <RowBody item={i} />
      <p className="break-words text-fg">{i.reason}</p>
      {heading && href && key && (
        <Link href={href} className={link}>
          Open {key}
        </Link>
      )}
      {i.target_kind === "automation_script" && i.target?.outdated_reason && <p className="break-all font-mono text-small text-fg">{i.target.outdated_reason}</p>}
      {i.target_kind === "automation_script" && i.status === "open" && (
        <p className="text-fg">{heals.length ? `Repair suggestion${heals.length === 1 ? "" : "s"}: ${heals.map((h) => h.key).join(", ")}` : "Repair suggestion not ready yet."}</p>
      )}
      {script && (
        <p className="flex flex-wrap items-center gap-2 text-fg">
          <span className="break-all">Script {script.path}</span> <ScriptStateLabel state={script.state} />
        </p>
      )}
      {auto && <p className="text-fg-muted">{auto}</p>}
      {done && <p className="text-fg">{done}</p>}
      {(i.can_close || (i.status === "open" && (i.action === "write_requirement" || (i.action === "regenerate" && onRegenerate)))) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {i.status === "open" && i.action === "write_requirement" && i.can_close && (
            <Link
              href={`/projects/${projectId}/requirements/new?${new URLSearchParams({ from: set.key, ...(i.page ? { page: i.page } : {}) })}`}
              className="inline-flex min-h-8 items-center rounded-md px-2 text-small font-medium text-navy-700 underline underline-offset-2"
              aria-label={`Write a requirement for ${i.page ?? label}`}
            >
              Write a requirement
            </Link>
          )}
          {i.status === "open" && i.action === "regenerate" && i.can_close && onRegenerate && (
            <Button variant="secondary" size="sm" onClick={onRegenerate}>
              Regenerate requirements…
            </Button>
          )}
          {i.can_close && (
            <Button id={`close-${i.id}`} variant="secondary" size="sm" onClick={() => onClose(i)} aria-label={closeName}>
              Close…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function useProjectId(): string {
  return useProject().id;
}

// ------------------------------------------------------------------ close dialog (§7.2)

export function CloseImpactDialog({ item, onCancel, onClosed }: { item: ImpactItem; onCancel: () => void; onClosed: (message: string) => void }) {
  const [choice, setChoice] = useState<"resolved" | "no_action" | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ choice?: string; reason?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const label = targetLabel(item);

  async function save() {
    const e = closeErrors(choice, reason);
    setErrors(e);
    if (e.choice) return firstRadio.current?.focus();
    if (e.reason) return reasonRef.current?.focus();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>(`/impact-items/${item.id}`, { method: "PATCH", body: { status: choice, reason: reason.trim() || null } });
      onClosed(r.message);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setErrors({ reason: err.message });
        reasonRef.current?.focus();
      } else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      size="sm"
      onClose={onCancel}
      title={`Close impact item · ${label}`}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Close item
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset aria-describedby={errors.choice ? "close-choice-error" : undefined}>
          <legend className="sr-only">How was it dealt with?</legend>
          <div className="space-y-2">
            <label className="flex min-h-11 items-start gap-2.5 text-body text-fg-strong">
              <input ref={firstRadio} type="radio" name="close-impact" className="mt-1 h-4 w-4 accent-accent" checked={choice === "resolved"} onChange={() => setChoice("resolved")} />
              Resolved: I&apos;ve dealt with it (for example, retired or updated the test case)
            </label>
            <label className="flex min-h-11 items-start gap-2.5 text-body text-fg-strong">
              <input type="radio" name="close-impact" className="mt-1 h-4 w-4 accent-accent" checked={choice === "no_action"} onChange={() => setChoice("no_action")} />
              No action needed
            </label>
          </div>
          {errors.choice && (
            <p id="close-choice-error" className="mt-1 text-small font-medium text-danger-fg">
              {errors.choice}
            </p>
          )}
        </fieldset>
        <TextArea
          ref={reasonRef}
          label={'Reason (needed for "No action needed")'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          error={errors.reason}
          maxLength={1000}
          hint="Shown on the item and in the Test Completion Report."
        />
        <InlineError error={error} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ regression run tab (§7.4)

export function RegressionTab({ set, rec, onOpenRepairs }: { set: ChangeSet; rec: Recommendation; onOpenRepairs: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { role, canApprove } = useAuth();
  const member = role !== null && role !== "viewer" && rec.permissions.can_request;
  const [includeShould, setIncludeShould] = useState(true);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const projectId = useProjectId();

  if (!rec.available) return <EmptyState title="No regression run for this comparison." description={rec.reason ?? undefined} />;
  const must = rec.must ?? [];
  const should = rec.should ?? [];
  const excluded = rec.excluded ?? [];
  const blocked = rec.blocked ?? null;
  const requested = rec.requested_runs?.[0] ?? null;
  const inc = includeShouldText(rec);

  async function request() {
    if (blocked || busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const run = await api<RunDetail>(`/change-sets/${set.id}/regression-run`, { body: { include_should: should.length > 0 && includeShould } });
      toast(requestedToast(run.key, canApprove), "success");
      router.push(`/projects/${projectId}/execution/${run.key}`);
    } catch (e) {
      setServerError(errorMessage(e));
      setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  if (!must.length && !should.length)
    return (
      <div className="space-y-4">
        <h2 className="text-h2 font-semibold text-fg-strong">Regression run</h2>
        <EmptyState title={`No approved test case is affected by ${set.key}. A smoke run is still a good idea.`} />
        {excluded.length > 0 && <PickGroup title="Not included" picks={excluded} kind="excluded" />}
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-h2 font-semibold text-fg-strong">Regression run · recommended by {rec.order === "ai" ? "AI" : "rules"}</h2>
        <p className="text-small text-fg">{estimateLine(rec, should.length > 0 && includeShould)}</p>
      </div>
      {requested && (
        <Callout
          tone="info"
          actions={
            <Link href={`/projects/${projectId}/execution/${requested.key}`} className={link}>
              Open {requested.key}
            </Link>
          }
        >
          {requested.key} was requested from this recommendation · {requestedRunStatus(requested.status)}.
        </Callout>
      )}
      {serverError && (
        <div ref={errorRef} tabIndex={-1} className="focus:outline-none">
          <Callout tone="danger" role="alert">
            {serverError}
          </Callout>
        </div>
      )}
      {member && (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
            <Button className="w-full md:w-auto" onClick={() => void request()} loading={busy} aria-disabled={blocked ? true : undefined} aria-describedby={blocked ? reasonId : undefined}>
              {requested ? "Request another run" : "Request this run"}
            </Button>
            <p className="text-small text-fg">It still needs Gate 7: someone who can approve authorises it before anything runs.</p>
          </div>
          {blocked && (
            <p id={reasonId} className="flex flex-wrap items-center gap-2 text-small font-medium text-fg-strong">
              {blocked.message}
              <button type="button" className={`${link} min-h-6`} onClick={onOpenRepairs}>
                Review repairs
              </button>
            </p>
          )}
          {should.length > 0 && <Checkbox label={inc.label} description={inc.detail} checked={includeShould} onChange={(e) => setIncludeShould(e.target.checked)} />}
        </div>
      )}
      <PickGroup title={`Must run (${must.length})`} note="Always included" picks={must} kind="must" generatedBy="rules" />
      {should.length > 0 && (
        <PickGroup
          title={`Should run (${should.length})`}
          picks={should}
          kind="should"
          generatedBy={rec.order === "ai" ? "ai" : "rules"}
          explanation={rec.order === "ai" ? (rec.explanation ?? null) : null}
        />
      )}
      {excluded.length > 0 && <PickGroup title={`Not included (${excluded.length})`} picks={excluded} kind="excluded" generatedBy="rules" />}
    </div>
  );
}

function ScriptCell({ p }: { p: RegressionPick }) {
  if (!p.script) return <span className="text-fg-muted">{p.not_runnable_reason ?? "No script"}</span>;
  const heals = p.script.heal_suggestions ?? [];
  return (
    <span className="inline-flex flex-col gap-1">
      <ScriptStateLabel state={p.script.state} />
      {p.script.state === "outdated" && p.script.outdated_reason && <span className="break-all font-mono text-caption text-fg">{p.script.outdated_reason}</span>}
      {p.script.state === "outdated" && <span className="text-caption text-fg">{heals.length ? `Repair: ${heals.map((h) => h.key).join(", ")}` : "Repair suggestion not ready yet"}</span>}
      {p.script.state !== "outdated" && !p.runnable && p.not_runnable_reason && <span className="text-caption text-fg">{p.not_runnable_reason}</span>}
    </span>
  );
}

function PickGroup({ title, note, picks, kind, generatedBy, explanation }: { title: string; note?: string; picks: RegressionPick[]; kind: "must" | "should" | "excluded"; generatedBy?: string; explanation?: string | null }) {
  const projectId = useProjectId();
  const caseLink = (p: RegressionPick) => (
    <Link href={`/projects/${projectId}/test-cases/${p.key}`} className={link}>
      {p.key}
    </Link>
  );
  const why = (p: RegressionPick) => p.reasons.join(" · ");
  const id = `pick-${kind}`;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={id} className="text-h3 font-semibold text-fg-strong">
          {title}
        </h3>
        {note && <span className="text-small text-fg-muted">— {note}</span>}
        {generatedBy === "ai" ? <GeneratedByLabel generatedBy="ai" /> : generatedBy ? <span className="text-small text-fg-muted">Rules</span> : null}
      </div>
      {explanation && <p className="text-small text-fg">{explanation}</p>}
      <div className="hidden md:block">
        <Table label={title}>
          <THead>
            <tr>
              <Th>Test</Th>
              <Th>Why</Th>
              <Th>Script</Th>
            </tr>
          </THead>
          <TBody>
            {picks.map((p) => (
              <Tr key={p.case_lineage_id}>
                <Td rowHeader className="whitespace-normal">
                  {caseLink(p)} {p.title}
                </Td>
                <Td className="whitespace-normal break-words">{why(p)}</Td>
                <Td className="whitespace-normal">
                  <ScriptCell p={p} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label={title}>
        {picks.map((p) => (
          <li key={p.case_lineage_id} className="space-y-1 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
            <p className="break-words font-medium text-fg-strong">
              {caseLink(p)} {p.title}
            </p>
            <p className="break-words text-fg">Why: {why(p)}</p>
            <div className="flex flex-wrap items-center gap-2 text-fg">
              <span>Script:</span> <ScriptCell p={p} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Loading and error wrappers shared by the two tabs. */
export function TabBody<T>({ q, children, what }: { q: { data?: T; error?: unknown; mutate: () => unknown }; children: (d: T) => React.ReactNode; what: string }) {
  if (q.error && !q.data) return <ErrorState error={q.error} title={`Couldn’t load ${what}.`} message="Try again." onRetry={() => void q.mutate()} />;
  if (!q.data) return <Skeleton className="h-40" />;
  return <>{children(q.data)}</>;
}
