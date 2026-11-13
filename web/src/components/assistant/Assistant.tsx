"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, Circle, Square, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import type { ArtefactRef, AssistantCapabilities, AssistantIntent, AssistantMessage, Feature, RequirementSummary, StageKey } from "@/lib/contract";
import { Button, Callout, Checkbox, Disclosure, InlineError, SelectField, Skeleton, TextArea } from "@/components/ui";
import type { AiMode } from "@/components/domain/AiStatus";
import { AnswerCard } from "./AnswerCard";
import { ProposalCard } from "./ProposalCard";
import type { SendInput, ThreadState } from "./useThread";

export const AI_OFF_COPY = "AI isn’t set up for this workspace. Tasks under ‘Works without AI’ still run on your project data. Free-form questions and AI proposals need AI.";

export function AiOffCallout() {
  const { canApprove } = useAuth();
  return (
    <Callout
      tone="neutral"
      actions={
        canApprove ? (
          <Link href="/settings" className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
            Set up AI in Settings
          </Link>
        ) : undefined
      }
    >
      {AI_OFF_COPY}
      {!canApprove && <span className="mt-1 block">Ask an owner or admin to set up AI.</span>}
    </Callout>
  );
}

// ---- Tasks -------------------------------------------------------------------

type TaskDef = {
  id: string;
  label: string;
  hint?: string;
  intent: AssistantIntent | null;
  group: "no_ai" | "ai";
};

/** Task list (design §11.2, with the PM's change: risk reassessment and negative criteria work without AI). */
export const TASKS: TaskDef[] = [
  { id: "coverage", label: "Review coverage", hint: "Features without requirements, criteria gaps, unmitigated risks", intent: "coverage_summary", group: "no_ai" },
  { id: "attention", label: "What needs my attention?", intent: "needs_attention", group: "no_ai" },
  { id: "status", label: "Summarise project status", intent: "workflow_status", group: "no_ai" },
  { id: "plan", label: "Create a new test plan", hint: "from the approved strategy", intent: "propose_regenerate", group: "no_ai" },
  { id: "risk", label: "Reassess application risk", intent: "propose_risk_reassessment", group: "no_ai" },
  { id: "negative", label: "Add negative criteria", hint: "Rule-based negative acceptance criteria", intent: "propose_negative_criteria", group: "no_ai" },
  { id: "update", label: "Update requirements", intent: "propose_requirement_update", group: "ai" },
  { id: "missing", label: "Suggest missing requirements", intent: "propose_missing_requirements", group: "ai" },
  { id: "ask", label: "Ask anything about this project", intent: null, group: "ai" },
];

export const LATER_TASKS_FALLBACK: { label: string; available_from_phase: number; needs: string }[] = [
  { label: "Generate more negative test cases", available_from_phase: 3, needs: "test cases" },
  { label: "Generate regression scenarios", available_from_phase: 3, needs: "test cases" },
  { label: "Explain a failed test", available_from_phase: 4, needs: "test runs" },
  { label: "Improve existing test scripts", available_from_phase: 4, needs: "test runs" },
  { label: "Analyse a defect", available_from_phase: 4, needs: "defects" },
];

type TaskData = {
  requirements: RequirementSummary[];
  features: Feature[];
  strategyVersion: number | null;
  g4Approved: boolean;
  context: ArtefactRef | null;
};

function TaskForm({ task, data, onRun, busy, aiOn, onAsk }: { task: TaskDef; data: TaskData; onRun: (i: SendInput) => void; busy: boolean; aiOn: boolean; onAsk: () => void }) {
  const first = useRef<HTMLElement | null>(null);
  const [scope, setScope] = useState("all");
  const [feature, setFeature] = useState("");
  const [status, setStatus] = useState("draft");
  const [reason, setReason] = useState("");
  const [keep, setKeep] = useState(true);
  const ctxReq = data.context?.type === "requirement" ? data.context.key : "";
  const [req, setReq] = useState(ctxReq);
  const [reqs, setReqs] = useState<string[]>(ctxReq ? [ctxReq] : []);
  const [feats, setFeats] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Task forms move focus to their first field when expanded (design §14).
    const el = document.getElementById(`task-${task.id}-first`);
    (el ?? first.current)?.focus();
  }, [task.id]);
  if (task.group === "ai" && !aiOn) return <AiOffCallout />;
  const run = (intent: AssistantIntent, params: Record<string, unknown>, display: string) => onRun({ body: { intent, params, context: data.context }, display });
  const runBtn = (label: string, onClick: () => void, disabled = false) => (
    <Button size="sm" onClick={onClick} loading={busy} disabled={disabled}>
      {label}
    </Button>
  );
  const reqOptions = data.requirements.filter((r) => r.status !== "rejected");
  switch (task.id) {
    case "coverage":
      return (
        <div className="space-y-2">
          <SelectField
            id={`task-${task.id}-first`}
            label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            options={[
              { value: "all", label: "All features" },
              { value: "feature", label: "A feature" },
              { value: "status", label: "A requirement status" },
            ]}
          />
          {scope === "feature" && (
            <SelectField label="Feature" value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="Choose a feature" options={data.features.map((f) => ({ value: f.key, label: f.name }))} />
          )}
          {scope === "status" && (
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[
                { value: "draft", label: "Draft" },
                { value: "needs_info", label: "Needs info" },
                { value: "approved", label: "Approved" },
              ]}
            />
          )}
          {runBtn("Review coverage", () =>
            run(
              "coverage_summary",
              scope === "feature" ? { scope, feature_key: feature } : scope === "status" ? { scope, status } : { scope },
              `Review coverage · Scope: ${scope === "feature" ? (data.features.find((f) => f.key === feature)?.name ?? "a feature") : scope === "status" ? `requirements in ${status.replace("_", " ")}` : "All features"}`,
            ),
          scope === "feature" && !feature)}
        </div>
      );
    case "attention":
      return runBtn("Check now", () => run("needs_attention", {}, "What needs my attention?"));
    case "status":
      return runBtn("Summarise", () => run("workflow_status", {}, "Summarise project status"));
    case "plan":
      return (
        <div className="space-y-2">
          <p className="text-small text-fg">Based on: {data.g4Approved && data.strategyVersion ? `approved Strategy v${data.strategyVersion}` : "the approved Test Strategy (Gate 4 not approved yet)"}</p>
          <Checkbox id={`task-${task.id}-first`} label="Keep edited sections" checked={keep} onChange={(e) => setKeep(e.target.checked)} description="Edited plan sections arrive as proposals instead of being replaced." />
          {!data.g4Approved && <p className="text-small text-fg-muted">Available after Gate 4 is approved.</p>}
          {runBtn("Create a new test plan", () => run("propose_regenerate", { stage: "test_plan", keep_edited: keep }, "Create a new test plan from the approved strategy"), !data.g4Approved)}
        </div>
      );
    case "risk":
      return (
        <div className="space-y-2">
          <SelectField
            id={`task-${task.id}-first`}
            label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            options={[
              { value: "all", label: "All risks" },
              { value: "feature", label: "A feature" },
            ]}
          />
          {scope === "feature" && (
            <SelectField label="Feature" value={feature} onChange={(e) => setFeature(e.target.value)} placeholder="Choose a feature" options={data.features.map((f) => ({ value: f.key, label: f.name }))} />
          )}
          <TextArea label="Reason (optional)" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          {runBtn("Reassess risk", () => run("propose_risk_reassessment", { scope, feature_key: scope === "feature" ? feature : undefined, reason: reason || undefined }, `Reassess application risk${reason ? ` · ${reason}` : ""}`), scope === "feature" && !feature)}
        </div>
      );
    case "negative":
      return (
        <div className="space-y-2">
          <SelectField
            id={`task-${task.id}-first`}
            label="Requirement"
            value={req}
            onChange={(e) => setReq(e.target.value)}
            placeholder="Choose a requirement"
            options={reqOptions.map((r) => ({ value: r.key, label: `${r.key} ${r.title}` }))}
          />
          {runBtn("Propose criteria", () => run("propose_negative_criteria", { requirement_key: req }, `Generate more negative acceptance criteria for ${req}`), !req)}
        </div>
      );
    case "update":
      return (
        <div className="space-y-2">
          <fieldset>
            <legend className="mb-1 text-body font-medium text-fg-strong">Requirements (1–20)</legend>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md p-1 ring-1 ring-inset ring-line">
              {reqOptions.map((r, i) => (
                <label key={r.key} className="flex min-h-6 items-center gap-2 text-small text-fg">
                  <input
                    id={i === 0 ? `task-${task.id}-first` : undefined}
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={reqs.includes(r.key)}
                    onChange={(e) => setReqs(e.target.checked ? [...reqs, r.key].slice(0, 20) : reqs.filter((x) => x !== r.key))}
                  />
                  <span className="font-mono">{r.key}</span> {r.title}
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea label="What should change" required rows={3} maxLength={1000} value={instruction} onChange={(e) => setInstruction(e.target.value)} error={error} />
          {runBtn("Propose changes", () => {
            if (!reqs.length) return setError("Choose at least one requirement.");
            if (!instruction.trim()) return setError("Describe what should change.");
            setError(null);
            run("propose_requirement_update", { requirement_keys: reqs, instruction: instruction.trim() }, instruction.trim());
          })}
        </div>
      );
    case "missing":
      return (
        <div className="space-y-2">
          <fieldset>
            <legend className="mb-1 text-body font-medium text-fg-strong">Features</legend>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md p-1 ring-1 ring-inset ring-line">
              {data.features.map((f, i) => (
                <label key={f.key} className="flex min-h-6 items-center gap-2 text-small text-fg">
                  <input
                    id={i === 0 ? `task-${task.id}-first` : undefined}
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={feats.includes(f.key)}
                    onChange={(e) => setFeats(e.target.checked ? [...feats, f.key] : feats.filter((x) => x !== f.key))}
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea label="Focus (optional)" rows={2} maxLength={500} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          {runBtn("Suggest requirements", () => run("propose_missing_requirements", { feature_keys: feats, focus: instruction.trim() || undefined }, `Suggest missing requirements${feats.length ? ` for ${feats.length} feature${feats.length === 1 ? "" : "s"}` : ""}`), feats.length === 0)}
        </div>
      );
    default:
      return (
        <Button size="sm" variant="secondary" onClick={onAsk}>
          Go to the question box
        </Button>
      );
  }
}

/** Grouped task list (design §11.2): Works without AI · Needs AI · Later phases (plain text, not buttons). */
export function AssistantTaskList({
  caps,
  data,
  onRun,
  busy,
  aiOn,
  onAsk,
  canWrite,
}: {
  caps: AssistantCapabilities | undefined;
  data: TaskData;
  onRun: (i: SendInput) => void;
  busy: boolean;
  aiOn: boolean;
  onAsk: () => void;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const later = caps?.later_phase_tasks?.length ? caps.later_phase_tasks : LATER_TASKS_FALLBACK;
  const available = (t: TaskDef) => !t.intent || !caps || caps.intents.length === 0 || caps.intents.some((i) => i.intent === t.intent && i.available !== false);
  const proposalTask = (t: TaskDef) => t.intent?.startsWith("propose_");
  const group = (g: TaskDef["group"], title: string) => (
    <section aria-labelledby={`tasks-${g}`}>
      <h3 id={`tasks-${g}`} className="mb-1.5 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
        {title}
      </h3>
      <ul className="space-y-1">
        {TASKS.filter((t) => t.group === g && available(t)).map((t) => (
          <li key={t.id}>
            <button
              type="button"
              aria-expanded={open === t.id}
              onClick={() => (t.id === "ask" ? onAsk() : setOpen(open === t.id ? null : t.id))}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-overlay"
            >
              <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-fg-muted transition-transform motion-reduce:transition-none ${open === t.id ? "rotate-90" : ""}`} aria-hidden />
              <span>
                <span className="block text-body font-medium text-fg-strong">{t.label}</span>
                {t.hint && <span className="block text-small text-fg-muted">{t.hint}</span>}
              </span>
            </button>
            {open === t.id && (
              <div className="ml-6 mt-1 rounded-md border border-line bg-elevated p-3">
                {proposalTask(t) && !canWrite ? (
                  <p className="text-small text-fg-muted">Viewers can read answers but can’t create proposals.</p>
                ) : (
                  <TaskForm task={t} data={data} onRun={onRun} busy={busy} aiOn={aiOn} onAsk={onAsk} />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <div className="space-y-5">
      {group("no_ai", "Works without AI")}
      {group("ai", "Needs AI")}
      <section aria-labelledby="tasks-later">
        <h3 id="tasks-later" className="mb-1.5 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
          Later phases
        </h3>
        <ul className="space-y-1.5">
          {later.map((t) => (
            <li key={t.label} className="flex items-start gap-2 px-2 text-body text-fg-muted">
              <Circle className="mt-1 h-3 w-3 shrink-0" aria-hidden />
              <span>
                <span className="block text-fg">{t.label}</span>
                <span className="block text-small">
                  Available in Phase {t.available_from_phase}: needs {t.needs}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---- Thread ------------------------------------------------------------------

const MAX = 2000;

export function Composer({
  aiMode,
  onSend,
  streaming,
  onStop,
  context,
  onClearContext,
  error,
  inputRef,
}: {
  aiMode: AiMode;
  onSend: (text: string) => void;
  streaming: boolean;
  onStop: () => void;
  context: ArtefactRef | null;
  onClearContext: () => void;
  error: string | null;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  if (aiMode === "off")
    return (
      <div className="space-y-2">
        <p className="text-body font-medium text-fg-strong">Ask about this project</p>
        <AiOffCallout />
      </div>
    );
  const limited = aiMode === "limited";
  const nearLimit = text.length >= MAX * 0.9;
  function submit() {
    if (!text.trim()) {
      setLocalError("Type a question first.");
      inputRef?.current?.focus();
      return;
    }
    setLocalError(null);
    onSend(text.trim());
  }
  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {context && (
        <p className="flex items-center gap-2 text-small">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 font-medium text-fg-strong ring-1 ring-inset ring-navy-200">
            About: <span className="font-mono">{context.key}</span>
            <button type="button" onClick={onClearContext} aria-label={`Remove context ${context.key}`} className="rounded-full p-0.5 hover:bg-navy-100">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </p>
      )}
      <TextArea
        ref={inputRef}
        label="Ask about this project"
        hint="Don’t paste passwords or personal data. Ctrl or Cmd + Enter sends."
        rows={3}
        maxLength={MAX}
        value={text}
        disabled={limited}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
        error={localError}
      />
      <p className="text-caption text-fg-muted tabular-nums" aria-live={nearLimit ? "polite" : "off"}>
        {nearLimit ? `${text.length} of ${MAX} characters` : ""}
      </p>
      <InlineError error={error} />
      <div className="flex justify-end gap-2">
        {streaming && (
          <Button variant="secondary" icon={<Square className="h-4 w-4" aria-hidden />} onClick={onStop}>
            Stop
          </Button>
        )}
        <Button type="submit" loading={streaming} disabled={limited} icon={<ArrowRight className="h-4 w-4" aria-hidden />} className="flex-row-reverse">
          Ask
        </Button>
      </div>
    </form>
  );
}

/** Messages as an ordered list of articles (design §14); the user's request is shown on each proposal. */
export function ThreadMessages({
  t,
  projectId,
  current,
  gateReopens,
  compact,
  fullViewHref,
  onFollowUp,
}: {
  t: ThreadState;
  fullViewHref?: string;
  projectId: string;
  current: Partial<Record<StageKey, number>>;
  gateReopens: (m: AssistantMessage) => string | null;
  compact?: boolean;
  onFollowUp: (i: SendInput) => void;
}) {
  if (t.thread.isLoading && !t.thread.data)
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-20" />
        <Skeleton className="h-28" />
        <span className="sr-only" role="status">
          Loading the conversation…
        </span>
      </div>
    );
  if (t.thread.error && !t.thread.data) return <InlineError error="Couldn’t load this conversation. Try again." />;
  const empty = t.messages.length === 0 && !t.pendingUser && !t.stopped;
  if (empty) return <p className="text-body text-fg-muted">Ask about this project’s requirements, risks and evidence, or pick a task. Answers cite the items they use.</p>;
  const userBefore = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (t.messages[j].role === "user") return t.messages[j].content;
    return null;
  };
  return (
    <ol className="space-y-3" aria-label="Conversation">
      {t.messages.map((m, i) => (
        <li key={m.id}>
          <AnswerCard
            message={m}
            current={current}
            onAskAgain={() => {
              const u = userBefore(i);
              if (u) onFollowUp({ body: m.intent ? { intent: m.intent } : { content: u }, display: u });
            }}
            onFollowUp={(f) => onFollowUp({ body: { intent: f.intent, params: f.params ?? {} }, display: f.label })}
          >
            {m.role === "assistant" && m.proposals.length > 0 && (
              <ProposalCard proposals={m.proposals} request={userBefore(i)} projectId={projectId} gateReopens={gateReopens(m)} compact={compact} fullViewHref={fullViewHref} onDone={t.refresh} />
            )}
          </AnswerCard>
        </li>
      ))}
      {t.stopped && (
        <>
          <li>
            <AnswerCard message={t.stopped.user} />
          </li>
          <li>
            <AnswerCard message={null} streaming={false} stopped>
              <p className="whitespace-pre-wrap text-body text-fg">{t.stopped.text}</p>
            </AnswerCard>
          </li>
        </>
      )}
      {t.pendingUser && (
        <>
          <li>
            <AnswerCard message={t.pendingUser} />
          </li>
          <li>
            <AnswerCard message={t.streamText ? ({ role: "assistant" } as AssistantMessage) : null} streaming streamText={t.streamText} />
          </li>
        </>
      )}
    </ol>
  );
}

export function TasksDisclosure({ defaultOpen, children }: { defaultOpen: boolean; children: React.ReactNode }) {
  return (
    <Disclosure label="Tasks" defaultOpen={defaultOpen} headingLevel={2} buttonClassName="text-h3 font-semibold">
      <div className="mt-3">{children}</div>
    </Disclosure>
  );
}
