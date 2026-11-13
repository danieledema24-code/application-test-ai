"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Lock, MoreHorizontal, PencilLine, Plus, Trash2 } from "lucide-react";
import { api, ApiError, buildQuery, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ArtefactRef, RequirementCategory, RequirementDetail as RequirementDetailT, RequirementStatus, RequirementSummary, Revision } from "@/lib/contract";
import { fieldChanges } from "@/lib/diff";
import { fmtDateTime } from "@/lib/format";
import { CATEGORY_TEXT, LABEL_TEXT, filterRequirements, filtersToQuery, type ReqFilters } from "@/lib/requirements";
import { useAuth } from "@/lib/auth";
import { Button, Callout, Card, ConfirmDialog, ErrorState, InlineError, SelectField, Skeleton, TextArea, TextField, inputClass, useToast } from "@/components/ui";
import { ProvenanceLabel, ProvenanceLegend, GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { ConfidenceValue } from "@/components/domain/ConfidenceValue";
import { DiffView } from "@/components/domain/DiffView";
import { RevisionHistory, RevisionLine } from "@/components/domain/RevisionHistory";
import { EvidenceLinks, useEvidence, type EvidenceItem } from "@/components/domain/EvidenceDrawer";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";
import { AcceptanceCriteriaList } from "./AcceptanceCriteria";
import { RejectDialog } from "./RejectDialog";
import { RequirementStatusPill, sourceText } from "./RequirementsTable";
import { noteGateReopened, useDiscoveryFeatures } from "./hooks";

type EditForm = { title: string; description: string; category: RequirementCategory; feature_ids: string[]; assumptions: string[]; reason: string };

function toForm(r: Pick<RequirementDetailT, "title" | "description" | "category" | "related_features" | "assumptions">): EditForm {
  return {
    title: r.title,
    description: r.description,
    category: r.category,
    feature_ids: r.related_features.map((f) => f.id).filter((x): x is string => !!x),
    assumptions: [...r.assumptions],
    reason: "",
  };
}

const NON_FUNCTIONAL: RequirementCategory[] = ["accessibility", "usability", "compatibility", "performance", "security", "privacy"];

/** "Why {label}" (design §5.4): the agent's reason when the API gives one, else the code rule's message. */
export function whyLabel(r: RequirementDetailT): string | null {
  if (r.classification === "observed") return null;
  if (r.classification_reason) return r.classification_reason;
  const issue = r.validation_issues.find((i) => i.code === "provenance_downgraded" || i.code === "evidence_unresolved");
  if (issue) return issue.message;
  if (r.source === "user") return "Added by a person without linked evidence. Approve it to accept it, or link evidence by editing it.";
  if (r.source === "document" && r.classification === "unverified") return "Stated in a source document. Not observable in the application during discovery.";
  return null;
}

/** Evidence chips: screenshots, DOM snippets and document excerpts ("Doc p.4"). */
function evidenceItems(r: RequirementDetailT): { items: EvidenceItem[]; labels: string[] } {
  const items: EvidenceItem[] = [];
  const labels: string[] = [];
  for (const ref of r.evidence_refs) {
    const link = r.evidence.find((e) => e.id === ref.evidence_id) ?? null;
    items.push({ id: ref.evidence_id, selector: ref.selector, excerpt: ref.excerpt, note: ref.note, link });
    const k = link?.kind ?? "";
    const evKey = (link as { key?: string } | null)?.key;
    if (k.startsWith("document")) labels.push(`Doc ${ref.note?.replace(/^DOC-\d+\s*/, "") || "excerpt"}`);
    else if (/screenshot/.test(k) || link?.mime?.startsWith("image/")) labels.push(`Screenshot${evKey ? ` ${evKey}` : ""}`);
    else if (/dom|html/.test(k)) labels.push(`DOM${evKey ? ` ${evKey}` : ""}`);
    else labels.push(evKey ?? "Evidence");
  }
  return { items, labels };
}

function EvidenceChips({ r }: { r: RequirementDetailT }) {
  const open = useEvidence();
  const { items, labels } = evidenceItems(r);
  if (items.length === 0) return <EvidenceLinks items={[]} subject={r.key} />;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((it, i) => (
        <li key={`${it.id}-${i}`}>
          <button
            type="button"
            onClick={() => open({ items, subject: `${r.key} ${r.title}`, startIndex: i })}
            className="inline-flex min-h-7 items-center rounded-sm bg-overlay px-2 text-small font-medium text-navy-700 underline underline-offset-2 ring-1 ring-inset ring-line-strong hover:text-navy-900"
          >
            {labels[i]}
            <span className="sr-only"> evidence for {r.key}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AssumptionsEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const icon = "inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted ring-1 ring-inset ring-line-input hover:bg-overlay disabled:opacity-40";
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <fieldset>
      <legend className="mb-1 text-body font-medium text-fg-strong">Assumptions</legend>
      <ol className="space-y-2">
        {value.map((a, i) => (
          <li key={i} className="flex items-center gap-2">
            <input aria-label={`Assumption ${i + 1}`} className={`${inputClass} flex-1`} value={a} maxLength={300} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
            <button type="button" className={icon} aria-label={`Move assumption ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={icon} aria-label={`Move assumption ${i + 1} down`} disabled={i === value.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className={icon} aria-label={`Remove assumption ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      <Button className="mt-2" size="sm" variant="ghost" icon={<Plus className="h-4 w-4" aria-hidden />} disabled={value.length >= 20} onClick={() => onChange([...value, ""])}>
        Add assumption
      </Button>
    </fieldset>
  );
}


function MoreActions({ items }: { items: { label: string; onClick: () => void; hidden?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" aria-label="More requirement actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="px-2.5">
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-64 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          {shown.map((i) => (
            <button
              key={i.label}
              role="menuitem"
              type="button"
              className="flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Requirement detail (design P2 §5.3): read view, in-place edit with optimistic locking, status actions,
 * acceptance criteria and revisions. Labels and confidence are shown but never editable.
 */
export function RequirementDetail({
  projectId,
  requirementKey,
  all,
  filters,
  olderVersion,
  g3Approved,
  canEdit,
  onListChanged,
}: {
  projectId: string;
  requirementKey: string;
  all: RequirementSummary[] | undefined;
  filters: ReqFilters;
  olderVersion: number | null;
  g3Approved: boolean;
  canEdit: boolean;
  onListChanged: () => Promise<unknown> | void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const assistant = useAssistantDrawer();
  const summary = all?.find((r) => r.key === requirementKey);
  const detail = useApi<RequirementDetailT>(summary ? `/requirements/${summary.id}` : null);
  const revisions = useApi<Revision[]>(summary ? `/requirements/${summary.id}/revisions` : null);
  const features = useDiscoveryFeatures(projectId);
  const r = detail.data;
  const h1 = useRef<HTMLHeadingElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [base, setBase] = useState<RequirementDetailT | null>(null);
  const [formErrors, setFormErrors] = useState<{ title?: string; description?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RequirementDetailT | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [needsInfoOpen, setNeedsInfoOpen] = useState(false);
  const [needsInfoNote, setNeedsInfoNote] = useState("");
  const [live, setLive] = useState("");

  const dirty = editing && !!form && !!base && JSON.stringify(form) !== JSON.stringify(toForm(base));
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  useEffect(() => {
    if (r) h1.current?.focus();
    // Focus the heading once per requirement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.id]);
  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  const { rows } = useMemo(() => filterRequirements(all ?? [], filters), [all, filters]);
  const idx = rows.findIndex((x) => x.key === requirementKey);
  const prev = idx > 0 ? rows[idx - 1] : null;
  const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
  const q = buildQuery(filtersToQuery(filters));
  const listHref = `/projects/${projectId}/requirements${q}`;
  const itemHref = (k: string) => `/projects/${projectId}/requirements/${k}${q}`;
  const filtered = Object.keys(filtersToQuery(filters)).length > 0;

  function go(href: string) {
    if (dirty) setLeaveTo(href);
    else router.push(href);
  }

  // ---- older version (?v=n): snapshot, read-only --------------------------------------------
  const snapshot = olderVersion && revisions.data ? revisions.data.find((x) => x.version === olderVersion)?.snapshot : null;
  const shown: RequirementDetailT | undefined = r && snapshot ? ({ ...r, ...(snapshot as Partial<RequirementDetailT>) } as RequirementDetailT) : r;
  const readOnly = !canEdit || !!olderVersion;

  if (all && !summary)
    return (
      <Card>
        <ErrorState
          error={null}
          title={`${requirementKey} wasn’t found`}
          message="It may belong to another version of the requirements. Go back to the list."
          onRetry={() => router.push(listHref)}
        />
      </Card>
    );
  if (detail.error && !r) return <ErrorState error={detail.error} title="Couldn’t load requirements." message="Try again." onRetry={() => void detail.mutate()} />;
  if (!shown || !r)
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40" />
        <span className="sr-only" role="status">
          Loading {requirementKey}…
        </span>
      </div>
    );

  const g3Note = () => noteGateReopened(projectId, "G3", g3Approved, toast);

  async function refreshAll() {
    await Promise.all([detail.mutate(), revisions.mutate(), onListChanged()]);
  }

  function permissionError(err: unknown, action: string) {
    if (err instanceof ApiError && err.status === 403) return `You don’t have permission to ${action} requirements. Ask an owner or admin.`;
    if (err instanceof ApiError && err.code === "network") return "You’re offline. Your changes are still here; save again when you reconnect.";
    if (err instanceof ApiError && err.status === 409) return `${r!.key} changed since you opened it. Reload to see the latest version.`;
    return `Couldn’t update ${r!.key}. ${errorMessage(err)}`;
  }

  async function setStatus(status: RequirementStatus, comment?: string) {
    setBusy(status);
    setActionError(null);
    try {
      await api(`/requirements/${r!.id}/status`, { body: { version: r!.version, status, comment: comment ?? null } });
      // The server approves the requirement's draft criteria with it (same as bulk approve); refetch to show them.
      const drafts = new Set(r!.acceptance_criteria.filter((a) => a.status === "draft").map((a) => a.id));
      const fresh = await detail.mutate();
      const acApproved = status === "approved" ? (fresh?.acceptance_criteria ?? []).filter((a) => drafts.has(a.id) && a.status === "approved").length : 0;
      const msg =
        status === "approved"
          ? `${r!.key}${acApproved ? ` and ${acApproved} acceptance criteri${acApproved === 1 ? "on" : "a"}` : ""} approved.`
          : status === "rejected"
            ? `${r!.key} rejected.`
            : status === "needs_info"
              ? `${r!.key} marked as needs info.`
              : `${r!.key} moved back to draft.`;
      toast(msg);
      setLive(msg);
      g3Note();
      await refreshAll();
    } catch (err) {
      setActionError(permissionError(err, status === "approved" ? "approve" : "change"));
    } finally {
      setBusy(null);
    }
  }

  async function setLock(locked: boolean) {
    setBusy("lock");
    setActionError(null);
    try {
      await api(`/requirements/${r!.id}/lock`, { body: { version: r!.version, locked } });
      toast(`${r!.key} ${locked ? "locked" : "unlocked"}.`);
      await refreshAll();
    } catch (err) {
      setActionError(permissionError(err, "lock"));
    } finally {
      setBusy(null);
    }
  }

  function startEdit() {
    setBase(r!);
    setForm(toForm(r!));
    setFormErrors({});
    setSaveError(null);
    setConflict(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setConflict(null);
    setTimeout(() => editBtn.current?.focus(), 0);
  }

  async function save(version: number) {
    if (!form) return;
    const e: typeof formErrors = {};
    if (form.title.trim().length < 5) e.title = form.title.trim() ? "Use at least 5 characters." : "Enter a title.";
    if (!form.description.trim()) e.description = "Describe the requirement.";
    setFormErrors(e);
    if (Object.keys(e).length) {
      titleRef.current?.focus();
      return;
    }
    setBusy("save");
    setSaveError(null);
    try {
      const saved = await api<RequirementDetailT>(`/requirements/${r!.id}`, {
        method: "PATCH",
        body: {
          version,
          title: form.title.trim(),
          description: form.description.trim(),
          category: form.category,
          type: NON_FUNCTIONAL.includes(form.category) ? "non_functional" : "functional",
          assumptions: form.assumptions.map((a) => a.trim()).filter(Boolean),
          feature_ids: form.feature_ids,
          change_reason: form.reason.trim() || null,
        },
      });
      setEditing(false);
      setConflict(null);
      const msg = `${r!.key} saved as version ${saved.version}.`;
      toast(msg);
      setLive(`Saved as version ${saved.version}`);
      g3Note();
      await detail.mutate(saved, { revalidate: false });
      await Promise.all([revisions.mutate(), onListChanged()]);
      setTimeout(() => editBtn.current?.focus(), 0);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !/lock/i.test(err.message)) {
        // Someone else saved: keep the user's text, fetch theirs for the comparison.
        try {
          setConflict(await api<RequirementDetailT>(`/requirements/${r!.id}`));
        } catch {
          setSaveError(`Couldn’t save ${r!.key}. Your changes are still here. Try again.`);
        }
      } else if (err instanceof ApiError && err.status === 409) setSaveError(`${r!.key} is locked. Unlock it to edit.`);
      else if (err instanceof ApiError && err.code === "network") setSaveError("You’re offline. Your changes are still here; save again when you reconnect.");
      else if (err instanceof ApiError && err.status === 403) setSaveError("You don’t have permission to edit requirements. Ask an owner or admin.");
      else setSaveError(`Couldn’t save ${r!.key}. Your changes are still here. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  async function restore(rev: Revision) {
    const s = rev.snapshot as Partial<RequirementDetailT>;
    try {
      const saved = await api<RequirementDetailT>(`/requirements/${r!.id}`, {
        method: "PATCH",
        body: {
          version: r!.version,
          title: s.title,
          description: s.description,
          category: s.category,
          type: s.type,
          assumptions: s.assumptions,
          change_reason: `Restored version ${rev.version}`,
        },
      });
      toast(`${r!.key} restored as version ${saved.version}.`);
      g3Note();
      await refreshAll();
    } catch (err) {
      toast(permissionError(err, "restore"), "error");
      throw err;
    }
  }

  const why = whyLabel(shown);
  const featureOptions = features.data ?? [];
  const latestRevisions = [...(revisions.data ?? [])].sort((a, b) => b.version - a.version);
  const minRev = latestRevisions[latestRevisions.length - 1]?.version;
  const conflictWho = conflict?.updated_by?.full_name || conflict?.updated_by?.email || "another user";
  const lastChange = r.updated_by ?? null;
  const status = shown.status;

  const editableNow = !readOnly && !editing;
  const primaryActions = editableNow && (
    <div className="flex flex-wrap items-center gap-2">
      {(status === "draft" || status === "needs_info") && (
        <Button onClick={() => void setStatus("approved")} loading={busy === "approved"}>
          Approve
        </Button>
      )}
      {status !== "rejected" && (
        <Button variant="secondary" onClick={() => setRejectOpen(true)}>
          Reject…
        </Button>
      )}
      {status === "rejected" && (
        <Button onClick={() => void setStatus("draft")} loading={busy === "draft"}>
          Restore to draft
        </Button>
      )}
      {status !== "rejected" &&
        (r.locked ? (
          <Button ref={editBtn} variant="secondary" icon={<Lock className="h-4 w-4" aria-hidden />} onClick={() => setUnlockOpen(true)}>
            Unlock to edit
          </Button>
        ) : (
          <Button ref={editBtn} variant="secondary" icon={<PencilLine className="h-4 w-4" aria-hidden />} onClick={startEdit}>
            Edit
          </Button>
        ))}
      <MoreActions
        items={[
          { label: r.locked ? "Unlock" : "Lock", onClick: () => (r.locked ? setUnlockOpen(true) : void setLock(true)), hidden: status === "rejected" },
          {
            label: "Mark as needs info",
            onClick: () => {
              setNeedsInfoNote("");
              setNeedsInfoOpen(true);
            },
            hidden: status === "needs_info" || status === "rejected",
          },
          { label: "Move back to draft", onClick: () => void setStatus("draft"), hidden: status !== "approved" },
          {
            label: "Ask AI QA Analyst about this",
            onClick: () => assistant.open({ type: "requirement", id: r.id, key: r.key, label: r.title, path: `/projects/${projectId}/requirements/${r.key}` }),
          },
          {
            label: "Copy link",
            onClick: () =>
              void navigator.clipboard
                .writeText(`${window.location.origin}/projects/${projectId}/requirements/${r.key}`)
                .then(() => toast("Link copied."))
                .catch(() => toast("Couldn’t copy the link.", "error")),
          },
        ]}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-small">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5 text-fg-muted">
            <li>
              <Link
                href={listHref}
                onClick={(e) => {
                  if (dirty) {
                    e.preventDefault();
                    go(listHref);
                  }
                }}
                className="font-medium text-navy-700 underline underline-offset-2"
              >
                Requirements
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li aria-current="page" className="font-mono text-fg-strong">
              {r.key}
            </li>
          </ol>
        </nav>
        {idx >= 0 && (
          <nav aria-label="Requirement navigation" className="flex items-center gap-3">
            {prev ? (
              <Link
                href={itemHref(prev.key)}
                onClick={(e) => {
                  if (dirty) {
                    e.preventDefault();
                    go(itemHref(prev.key));
                  }
                }}
                aria-label={`Previous requirement: ${prev.key} ${prev.title}`}
                className="inline-flex items-center gap-1 font-medium text-navy-700 underline underline-offset-2"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden /> Previous
              </Link>
            ) : (
              <span className="text-fg-muted">Previous</span>
            )}
            <span className="tabular-nums text-fg-muted">
              {idx + 1} of {rows.length}
              {filtered ? " (filtered)" : ""}
            </span>
            {next ? (
              <Link
                href={itemHref(next.key)}
                onClick={(e) => {
                  if (dirty) {
                    e.preventDefault();
                    go(itemHref(next.key));
                  }
                }}
                aria-label={`Next requirement: ${next.key} ${next.title}`}
                className="inline-flex items-center gap-1 font-medium text-navy-700 underline underline-offset-2"
              >
                Next <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : (
              <span className="text-fg-muted">Next</span>
            )}
          </nav>
        )}
      </div>

      {olderVersion && (
        <Callout
          tone="info"
          actions={
            <Button variant="secondary" onClick={() => router.push(itemHref(r.key))}>
              View latest
            </Button>
          }
        >
          You’re viewing version {olderVersion} of {r.key}. The latest is version {r.version}.
        </Callout>
      )}

      <header className="space-y-3">
        <h1 ref={h1} tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
          <span className="font-mono">{r.key}</span> · {shown.title}
        </h1>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <RequirementStatusPill status={status} />
            <ProvenanceLabel provenance={shown.classification} />
            <span className="text-small text-fg">
              Confidence <ConfidenceValue confidence={shown.confidence} />
            </span>
            {r.human_edited && (
              <span className="inline-flex items-center gap-1 text-small text-fg-muted">
                <PencilLine className="h-4 w-4" aria-hidden /> Edited
              </span>
            )}
            {r.locked && (
              <span className="inline-flex items-center gap-1 text-small text-fg-muted">
                <Lock className="h-4 w-4" aria-hidden /> Locked
              </span>
            )}
            <ProvenanceLegend />
          </div>
          {primaryActions}
        </div>
        {status === "rejected" && r.status_comment && <p className="text-body text-fg">Rejected: {r.status_comment}</p>}
        {status === "needs_info" && r.status_comment && <p className="text-body text-fg">Needs info: {r.status_comment}</p>}
        <InlineError error={actionError} />
      </header>

      {r.conflict && !editing && (
        <Callout
          tone="warning"
          title="The document and the application differ"
          actions={
            editableNow ? (
              <>
                <Button size="sm" variant="secondary" onClick={startEdit}>
                  Keep application behaviour
                </Button>
                <Button size="sm" variant="secondary" onClick={startEdit}>
                  Keep document wording
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setNeedsInfoNote("The document and the application differ.");
                    setNeedsInfoOpen(true);
                  }}
                >
                  Mark as needs info
                </Button>
              </>
            ) : undefined
          }
        >
          {r.validation_issues.find((i) => /conflict/i.test(i.code))?.message ?? "A source document says one thing and the application shows another. Check the evidence below."}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {editing && form ? (
            <Card className="space-y-4 p-5">
              {conflict && (
                <Callout
                  tone="danger"
                  title={`Someone else changed ${r.key} while you were editing (now version ${conflict.version} by ${conflictWho}).`}
                  actions={
                    <>
                      <Button size="sm" variant="secondary" aria-expanded={compareOpen} onClick={() => setCompareOpen((v) => !v)}>
                        Compare with their version
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void detail.mutate(conflict, { revalidate: false });
                          setEditing(false);
                          setConflict(null);
                        }}
                      >
                        Discard my changes
                      </Button>
                    </>
                  }
                >
                  Your unsaved text is kept below.
                </Callout>
              )}
              {conflict && compareOpen && (
                <div className="space-y-3 rounded-md border border-line p-3">
                  <DiffView
                    changes={fieldChanges(
                      { title: conflict.title, description: conflict.description, category: conflict.category, assumptions: conflict.assumptions },
                      { title: form.title, description: form.description, category: form.category, assumptions: form.assumptions },
                    )}
                    leftLabel={`Their version (${conflict.version})`}
                    rightLabel="Your unsaved text"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void detail.mutate(conflict, { revalidate: false });
                        setEditing(false);
                        setConflict(null);
                      }}
                    >
                      Keep theirs
                    </Button>
                    <Button onClick={() => void save(conflict.version)} loading={busy === "save"}>
                      Save mine as version {conflict.version + 1}
                    </Button>
                  </div>
                </div>
              )}
              <TextField ref={titleRef} label="Title" required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} error={formErrors.title} />
              <TextArea label="Description" required rows={4} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} error={formErrors.description} />
              <SelectField
                label="Category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as RequirementCategory })}
                options={Object.entries(CATEGORY_TEXT).map(([value, label]) => ({ value, label }))}
              />
              <fieldset>
                <legend className="mb-1 text-body font-medium text-fg-strong">Related features</legend>
                {featureOptions.length === 0 ? (
                  <p className="text-small text-fg-muted">No discovered features to link.</p>
                ) : (
                  <div className="grid gap-1 sm:grid-cols-2">
                    {featureOptions.map((ft) => (
                      <label key={ft.id} className="flex min-h-6 items-center gap-2 text-body text-fg">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-accent"
                          checked={form.feature_ids.includes(ft.id)}
                          onChange={(e) => setForm({ ...form, feature_ids: e.target.checked ? [...form.feature_ids, ft.id] : form.feature_ids.filter((x) => x !== ft.id) })}
                        />
                        {ft.name}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <AssumptionsEditor value={form.assumptions} onChange={(assumptions) => setForm({ ...form, assumptions })} />
              <div className="rounded-md bg-elevated p-3">
                <p className="flex flex-wrap items-center gap-2 text-body text-fg-strong">
                  <span className="font-medium">Label</span> <ProvenanceLabel provenance={r.classification} />
                  <span className="font-medium">Confidence</span> <ConfidenceValue confidence={r.confidence} />
                </p>
                <p className="mt-1 text-small text-fg-muted">
                  Labels come from evidence. To confirm an Assumed or Unverified requirement, approve it; to correct it, edit the text or reject it.
                </p>
              </div>
              <TextField label="Reason for change" hint="Optional. Stored in the revision." maxLength={200} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              <InlineError error={saveError} />
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => (dirty ? setLeaveTo("__cancel") : cancelEdit())}>
                  Cancel
                </Button>
                <Button onClick={() => void save(conflict?.version ?? base?.version ?? r.version)} loading={busy === "save"}>
                  Save changes
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="space-y-5 p-5">
              <section>
                <h2 className="text-h3 font-semibold text-fg-strong">Description</h2>
                <p className="mt-1 whitespace-pre-wrap text-body text-fg">{shown.description || "—"}</p>
              </section>
              {why && (
                <section>
                  <h2 className="text-h3 font-semibold text-fg-strong">Why {LABEL_TEXT[shown.classification]}</h2>
                  <p className="mt-1 text-body text-fg">{why}</p>
                </section>
              )}
              <section>
                <h2 className="text-h3 font-semibold text-fg-strong">Evidence</h2>
                <div className="mt-1">
                  <EvidenceChips r={shown} />
                </div>
              </section>
              <section>
                <h2 className="text-h3 font-semibold text-fg-strong">Assumptions</h2>
                {shown.assumptions.length ? (
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-body text-fg">
                    {shown.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-1 text-body text-fg-muted">None recorded.</p>
                )}
              </section>
            </Card>
          )}
          {!editing && (
            <Card className="p-5">
              <AcceptanceCriteriaList requirementId={r.id} criteria={shown.acceptance_criteria} readOnly={readOnly} locked={r.locked} onChanged={refreshAll} />
            </Card>
          )}
        </div>

        <aside aria-label="Requirement details" className="min-w-0 space-y-4">
          <Card className="divide-y divide-line">
            <dl className="space-y-2 px-4 py-3 text-body">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <dt className="text-fg-muted">Category</dt>
                <dd className="text-fg">
                  {shown.type === "functional" ? "Functional" : "Non-functional"} · {CATEGORY_TEXT[shown.category] ?? shown.category}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <dt className="text-fg-muted">Source</dt>
                <dd className="space-y-0.5 text-fg">
                  {shown.source === "discovery" ? (
                    <Link href={`/projects/${projectId}/discovery?view=summary`} className="text-navy-700 underline underline-offset-2">
                      Discovery
                    </Link>
                  ) : (
                    <span>{sourceText(shown)}</span>
                  )}
                  {shown.evidence_refs
                    .filter((e) => e.note?.startsWith("DOC-"))
                    .map((e) => (
                      <span key={e.evidence_id} className="block text-small">
                        Document · {e.note}
                      </span>
                    ))}
                  {shown.source === "user" && r.updated_by?.full_name && <span className="block text-small">{r.updated_by.full_name}</span>}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <dt className="text-fg-muted">Generated</dt>
                <dd className="text-fg">
                  <GeneratedByLabel generatedBy={shown.generated_by} className="whitespace-normal!" />
                  {shown.rule_id && <span className="block font-mono text-caption text-fg-muted">{shown.rule_id}</span>}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <dt className="text-fg-muted">Last change</dt>
                <dd className="text-fg">
                  {lastChange?.full_name || lastChange?.email || (shown.generated_by === "human" ? user?.full_name : "The agent")} · {fmtDateTime(r.updated_at)}
                </dd>
              </div>
            </dl>
            <section className="px-4 py-3">
              <h2 className="text-small font-semibold text-fg-strong">Related features</h2>
              {shown.related_features.length ? (
                <ul className="mt-1 space-y-0.5 text-body">
                  {shown.related_features.map((ft: ArtefactRef) => (
                    <li key={ft.key}>
                      <Link href={`/projects/${projectId}/discovery?view=functionality`} className="text-navy-700 underline underline-offset-2">
                        {ft.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-body text-fg-muted">None linked.</p>
              )}
            </section>
            <section className="px-4 py-3">
              <h2 className="text-small font-semibold text-fg-strong">Linked test cases</h2>
              <p className="mt-1 text-body text-fg-muted">None yet. Test cases are written in Phase 3, after the Test Strategy is approved.</p>
            </section>
            <section className="px-4 py-3">
              <div className="flex items-center justify-between">
                <h2 className="text-small font-semibold text-fg-strong">Revision history ({latestRevisions.length})</h2>
                {latestRevisions.length > 0 && (
                  <button type="button" className="text-small font-medium text-navy-700 underline underline-offset-2" onClick={() => setHistoryOpen(true)}>
                    View all
                  </button>
                )}
              </div>
              {revisions.error && !revisions.data ? (
                <p className="mt-1 text-small text-fg-muted">Couldn’t load the history.</p>
              ) : (
                <ol className="mt-1 space-y-1 text-small">
                  {latestRevisions.slice(0, 3).map((rv) => (
                    <li key={rv.version}>
                      <RevisionLine r={rv} first={rv.version === minRev} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </Card>
        </aside>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>

      <RevisionHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={`Revision history · ${r.key}`}
        revisions={revisions.data ?? []}
        canRestore={!readOnly && !r.locked}
        onRestore={restore}
      />
      <RejectDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        count={1}
        subject={r.key}
        candidates={(all ?? []).filter((x) => x.id !== r.id && x.status !== "rejected")}
        onReject={async (comment) => {
          await setStatus("rejected", comment);
        }}
      />
      <ConfirmDialog
        open={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        title={`Unlock ${r.key}?`}
        confirmLabel="Unlock"
        loading={busy === "lock"}
        onConfirm={async () => {
          await setLock(false);
          setUnlockOpen(false);
        }}
      >
        <p>Unlocked requirements can be edited. They stay protected from regeneration only if you edit them.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={needsInfoOpen}
        onClose={() => setNeedsInfoOpen(false)}
        title={`Mark ${r.key} as needs info?`}
        confirmLabel="Mark as needs info"
        loading={busy === "needs_info"}
        onConfirm={async () => {
          if (!needsInfoNote.trim()) return;
          await setStatus("needs_info", needsInfoNote.trim());
          setNeedsInfoOpen(false);
        }}
      >
        <TextArea label="What information is needed?" required rows={3} value={needsInfoNote} onChange={(e) => setNeedsInfoNote(e.target.value)} maxLength={500} />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!leaveTo}
        onClose={() => setLeaveTo(null)}
        onCancel={() => setLeaveTo(null)}
        title={`Discard unsaved changes to ${r.key}?`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => {
          const to = leaveTo;
          setLeaveTo(null);
          setEditing(false);
          setConflict(null);
          if (to && to !== "__cancel") router.push(to);
          else setTimeout(() => editBtn.current?.focus(), 0);
        }}
      >
        <p>Your edits haven’t been saved.</p>
      </ConfirmDialog>
    </div>
  );
}
