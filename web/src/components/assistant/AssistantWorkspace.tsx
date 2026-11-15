"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import type { ArtefactRef, AssistantMessage, Page, StageKey, ThreadSummary } from "@/lib/contract";
import { Button, ConfirmDialog, SelectField, useToast } from "@/components/ui";
import { AiStatus, type AiMode } from "@/components/domain/AiStatus";
import { useProject } from "@/components/workspace/ProjectContext";
import { gateApproved, requirementsStages, useAllRequirements, useDiscoveryFeatures, useDocuments } from "@/components/requirements/hooks";
import { useAllTestCases } from "@/components/testcases/hooks";
import { AssistantTaskList, Composer, TasksDisclosure, ThreadMessages } from "./Assistant";
import { useAssistantThread, useCapabilities } from "./useThread";

/** "Answers use only this project's data: Scan 3, Requirements v5, Strategy v2, 2 documents." (design §11.2) */
export function scopeLine(v: Partial<Record<StageKey, number>>, documents: number): string {
  const parts: string[] = [];
  if (v.discovery) parts.push(`Scan ${v.discovery}`);
  if (v.requirements) parts.push(`Requirements v${v.requirements}`);
  if (v.test_strategy) parts.push(`Strategy v${v.test_strategy}`);
  if (v.test_design) parts.push(`Test design run ${v.test_design}`);
  if (documents) parts.push(`${documents} document${documents === 1 ? "" : "s"}`);
  const base = parts.length ? `Answers use only this project’s data: ${parts.join(", ")}.` : "Answers use only this project’s data.";
  const note = !v.requirements && !v.test_strategy ? " Requirements and the strategy aren’t ready yet, so answers draw on discovery results only." : "";
  return `${base}${note} No test results exist yet.`;
}

export function threadOptionLabel(t: ThreadSummary): string {
  const pending = t.pending_proposals ? ` · ${t.pending_proposals} proposal${t.pending_proposals === 1 ? "" : "s"} pending` : "";
  return `${t.title || "Untitled thread"} · ${fmtDateTime(t.updated_at ?? t.created_at)}${pending}`;
}

/**
 * The assistant (design P2 §11): full page (tasks 1/3 + thread 2/3 at lg) or the compact side panel.
 * Thread id and context are owned by the caller so the page can keep them in the URL.
 */
export function AssistantWorkspace({
  variant,
  threadId,
  onThreadId,
  context,
  onClearContext,
}: {
  variant: "page" | "drawer";
  threadId: string | null;
  onThreadId: (id: string | null) => void;
  context: ArtefactRef | null;
  onClearContext: () => void;
}) {
  const p = useProject();
  const { role } = useAuth();
  const toast = useToast();
  const caps = useCapabilities(p.id);
  const threads = useApi<Page<ThreadSummary>>(`/projects/${p.id}/assistant/threads`, { limit: 50 }, { shouldRetryOnError: false });
  const t = useAssistantThread(p.id, threadId, (id) => {
    onThreadId(id);
    void threads.mutate();
  });
  const stages = requirementsStages(p.workflow);
  const reqs = useAllRequirements(p.id, null, !!stages.req?.current_version);
  const features = useDiscoveryFeatures(p.id);
  const docs = useDocuments(p.id);
  const designed = !!stages.design?.current_version;
  const cases = useAllTestCases(p.id, null, designed);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const current = useMemo(() => {
    const v: Partial<Record<StageKey, number>> = {};
    for (const s of p.workflow?.stages ?? []) if (s.current_version) v[s.key] = s.current_version;
    return v;
  }, [p.workflow]);
  const activeDocs = (docs.data ?? []).filter((d) => d.status === "ready").length;

  const aiMode: AiMode = t.error?.mode ?? (caps.data && !caps.data.ai_enabled ? "off" : caps.data ? "on" : "off");
  const canWrite = role !== "viewer";
  const taskData = {
    requirements: reqs.data ?? [],
    features: features.data ?? [],
    strategyVersion: stages.strategy?.current_version ?? null,
    g4Approved: gateApproved(stages.g4),
    context,
    cases: cases.data ?? [],
    designed,
    g5Approved: gateApproved(stages.g5),
  };
  const gateReopens = (m: AssistantMessage): string | null => {
    const targets = m.proposals.map((x) => x.target?.type);
    const gates: string[] = [];
    if (targets.some((x) => x === "requirement" || x === "acceptance_criterion") && gateApproved(stages.g3)) gates.push("Gate 3");
    if (targets.some((x) => x === "risk" || x === "strategy_section") && gateApproved(stages.g4)) gates.push("Gate 4");
    const designKinds = m.proposals.some((x) => x.kind === "add_test_cases" || x.kind === "update_test_case" || x.kind === "set_suite");
    if ((designKinds || targets.some((x) => x === "test_case" || x === "test_condition" || x === "test_data")) && gateApproved(stages.g5)) gates.push("Gate 5");
    return gates.length ? `${gates.join(" and ")} will need approval again.` : null;
  };
  const send = (input: Parameters<typeof t.send>[0]) => void t.send(input);
  const askFocus = () => {
    setTasksOpen(false);
    inputRef.current?.focus();
  };
  const fullView = `/projects/${p.id}/assistant${threadId ? `?thread=${threadId}` : ""}`;
  const empty = t.messages.length === 0 && !t.pendingUser;

  async function deleteThread() {
    if (!threadId) return;
    try {
      await api(`/assistant/threads/${threadId}/archive`, { method: "POST" });
      toast("Thread deleted. Changes you applied from it stay.");
      onThreadId(null);
      void threads.mutate();
    } catch (err) {
      toast(`Couldn’t delete the thread. ${err instanceof Error ? err.message : ""}`.trim(), "error");
    }
  }

  const status = (
    <p role="status" aria-live="polite" className="sr-only">
      {t.announce}
    </p>
  );
  const tasks = (
    <AssistantTaskList caps={caps.data} data={taskData} onRun={send} busy={t.streaming} aiOn={aiMode !== "off"} onAsk={askFocus} canWrite={canWrite} />
  );
  const composer = (
    <Composer aiMode={aiMode} onSend={(text) => send({ body: { content: text, context }, display: text })} streaming={t.streaming} onStop={t.stop} context={context} onClearContext={onClearContext} error={t.error?.text ?? null} inputRef={inputRef} />
  );
  const thread = <ThreadMessages t={t} projectId={p.id} current={current} gateReopens={gateReopens} compact={variant === "drawer"} fullViewHref={fullView} onFollowUp={send} />;

  if (variant === "drawer")
    return (
      <div className="space-y-4">
        {status}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <AiStatus mode={aiMode} provider={caps.data?.model} />
          <Link href={fullView} className="text-small font-medium text-navy-700 underline underline-offset-2">
            Open full view
          </Link>
        </div>
        <TasksDisclosure defaultOpen={false}>{tasks}</TasksDisclosure>
        {thread}
        {composer}
      </div>
    );

  const threadItems = threads.data?.items ?? [];
  return (
    <div className="space-y-6">
      {status}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-h1 font-semibold text-fg-strong">AI QA Analyst</h1>
          <p className="text-body text-fg-muted">{scopeLine(current, activeDocs)}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <AiStatus mode={aiMode} provider={caps.data?.model} />
          <SelectField
            label="History"
            hideLabel
            value={threadId ?? ""}
            onChange={(e) => onThreadId(e.target.value || null)}
            placeholder={threadItems.length ? "History" : "No earlier threads"}
            options={threadItems.map((x) => ({ value: x.id, label: threadOptionLabel(x) }))}
          />
          <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => onThreadId(null)}>
            New thread
          </Button>
          {threadId && (
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirmDelete(true)}>
              Delete thread
            </Button>
          )}
        </div>
      </div>
      {caps.data?.notice && <p className="text-small text-fg-muted">{caps.data.notice}</p>}
      <div className="grid gap-6 lg:grid-cols-3">
        <aside aria-label="Tasks" className="hidden lg:block">
          <h2 className="mb-3 text-h3 font-semibold text-fg-strong">Tasks</h2>
          {tasks}
        </aside>
        <div className="lg:hidden">
          <TasksDisclosure key={empty ? "empty" : "busy"} defaultOpen={empty && !tasksOpen}>
            {tasks}
          </TasksDisclosure>
        </div>
        <section aria-label="Thread" className="space-y-4 lg:col-span-2">
          {thread}
          {composer}
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this thread?"
        confirmLabel="Delete thread"
        danger
        onConfirm={async () => {
          setConfirmDelete(false);
          await deleteThread();
        }}
      >
        Deleting a thread never undoes changes you applied from it.
      </ConfirmDialog>
    </div>
  );
}
