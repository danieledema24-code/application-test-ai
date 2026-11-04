"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, ExternalLink, Loader2, Send, Sparkles, Trash2, Wrench, X, XCircle, AlertTriangle } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { AiStatus, AssistantAction, AssistantResponse, ChatMessage } from "@/lib/types";
import { Button, StatusPill } from "@/components/ui";

type Turn =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; actions: AssistantAction[]; aiEnabled: boolean }
  | { kind: "error"; content: string };

const SUGGESTIONS = [
  "Summarise the latest test run",
  "Which tests failed this week?",
  "Generate test cases for the login page",
];

function useCurrentProjectId(): string | undefined {
  const pathname = usePathname();
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function ActionCard({
  action,
  resolved,
  onConfirm,
  onCancel,
  busy,
}: {
  action: AssistantAction;
  resolved?: "confirmed" | "cancelled";
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const icon =
    action.status === "DONE" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />
    ) : action.status === "FAILED" ? (
      <XCircle className="h-4 w-4 text-red-400" aria-hidden />
    ) : (
      <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />
    );
  return (
    <div className="rounded-lg border border-line bg-elevated p-3 text-xs">
      <div className="flex items-start gap-2">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <p className="font-medium text-fg-strong">{action.label}</p>
            <StatusPill status={action.status} label={action.status === "NEEDS_CONFIRMATION" ? "Needs confirmation" : undefined} />
          </div>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-fg-muted">
            <dt className="font-medium text-fg">Tool</dt>
            <dd className="font-mono">{action.tool}</dd>
            {action.projectName && (
              <>
                <dt className="font-medium text-fg">Project</dt>
                <dd>{action.projectName}</dd>
              </>
            )}
            {action.detail && (
              <>
                <dt className="font-medium text-fg">Detail</dt>
                <dd className="break-words">{action.detail}</dd>
              </>
            )}
          </dl>
          {action.link && (
            <Link href={action.link} className="mt-1.5 inline-flex items-center gap-1 font-medium text-accent hover:underline">
              Open <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
          {action.status === "NEEDS_CONFIRMATION" && (
            <div className="mt-2">
              {resolved ? (
                <p className="text-fg-muted">{resolved === "confirmed" ? "Confirmed — see the next reply." : "Cancelled. Nothing was changed."}</p>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" onClick={onConfirm} loading={busy}>
                    Confirm
                  </Button>
                  <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<Record<string, "confirmed" | "cancelled">>({});
  const projectId = useCurrentProjectId();
  const { data: status } = useApi<AiStatus>(open ? "/ai/status" : null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function toMessages(ts: Turn[]): ChatMessage[] {
    return ts.flatMap((t): ChatMessage[] =>
      t.kind === "user" ? [{ role: "user", content: t.content }] : t.kind === "assistant" ? [{ role: "assistant", content: t.content }] : [],
    );
  }

  async function send(messages: ChatMessage[], base: Turn[], confirmations?: string[]) {
    setBusy(true);
    try {
      const res = await api<AssistantResponse>("/assistant/chat", {
        body: { messages, projectId, ...(confirmations ? { confirmations } : {}) },
      });
      setTurns([...base, { kind: "assistant", content: res.reply, actions: res.actions || [], aiEnabled: res.aiEnabled }]);
    } catch (err) {
      setTurns([...base, { kind: "error", content: errorMessage(err) }]);
    } finally {
      setBusy(false);
    }
  }

  function submit(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { kind: "user", content }];
    setTurns(next);
    setInput("");
    void send(toMessages(next), next);
  }

  function confirm(turnIndex: number, actionId: string) {
    setResolved((r) => ({ ...r, [actionId]: "confirmed" }));
    // Re-send the same messages that produced the confirmation request.
    const upTo = turns.slice(0, turnIndex);
    void send(toMessages(upTo), turns, [actionId]);
  }

  const limited = status ? !status.enabled : turns.some((t) => t.kind === "assistant" && !t.aiEnabled);

  return (
    <>
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-accent py-3 pl-4 pr-5 text-sm font-semibold text-on-accent shadow-lg shadow-black/50 hover:bg-accent-hover"
          aria-label="Open AI assistant"
        >
          <Sparkles className="h-5 w-5" aria-hidden />
          <span className="hidden sm:inline">Ask AI</span>
        </button>
      )}
      {open && (
        <section
          aria-label="AI assistant"
          className="fixed inset-x-0 bottom-0 z-50 flex h-[85vh] flex-col bg-surface shadow-2xl shadow-black/60 ring-1 ring-line-strong sm:inset-x-auto sm:bottom-5 sm:right-5 sm:h-[640px] sm:max-h-[calc(100vh-2.5rem)] sm:w-[420px] sm:rounded-xl"
        >
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Bot className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-fg-strong">QA Assistant</h2>
              <p className="truncate text-xs text-fg-muted">
                {limited ? "Limited mode (rule-based)" : status?.model ? `AI enabled · ${status.model}` : "AI assistant"}
                {projectId ? " · project context" : ""}
              </p>
            </div>
            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTurns([]);
                  setResolved({});
                }}
                className="rounded p-1.5 text-fg-muted hover:bg-overlay hover:text-fg"
                aria-label="Clear conversation"
                title="Clear conversation"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTimeout(() => launcherRef.current?.focus(), 0);
              }}
              className="rounded p-1.5 text-fg-muted hover:bg-overlay hover:text-fg"
              aria-label="Close AI assistant"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>

          {limited && (
            <p className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
              The AI model is not configured. The assistant runs in limited, rule-based mode and can only handle simple commands.
            </p>
          )}

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            {turns.length === 0 && (
              <div className="py-4 text-center">
                <p className="text-sm font-medium text-fg-strong">How can I help with testing today?</p>
                <p className="mt-1 text-xs text-fg-muted">
                  I can look up runs, generate test cases, start runs and draft defects. Every action I take is shown below.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => submit(s)}
                      className="rounded-lg border border-line px-3 py-2 text-left text-sm text-fg hover:border-accent/60 hover:bg-accent-soft"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => {
              if (t.kind === "user")
                return (
                  <div key={i} className="flex justify-end">
                    <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-on-accent">
                      {t.content}
                    </p>
                  </div>
                );
              if (t.kind === "error")
                return (
                  <p key={i} role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {t.content}
                  </p>
                );
              return (
                <div key={i} className="space-y-2">
                  <p className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-elevated px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-line">
                    {t.content}
                  </p>
                  {t.actions.length > 0 && (
                    <div className="space-y-2">
                      <p className="flex items-center gap-1 text-xs font-medium text-fg-muted">
                        <Wrench className="h-3.5 w-3.5" aria-hidden /> Activity
                      </p>
                      {t.actions.map((a) => (
                        <ActionCard
                          key={a.id}
                          action={a}
                          resolved={resolved[a.id]}
                          busy={busy}
                          onConfirm={() => confirm(i, a.id)}
                          onCancel={() => setResolved((r) => ({ ...r, [a.id]: "cancelled" }))}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {busy && (
              <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Working…
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="border-t border-line px-3 pb-3 pt-2"
          >
            <div className="flex items-end gap-2">
              <label htmlFor="assistant-input" className="sr-only">
                Message the assistant
              </label>
              <textarea
                id="assistant-input"
                ref={inputRef}
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
                placeholder="Ask about tests, runs or defects…"
                className="block max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-lg border-0 bg-canvas px-3 py-2 text-sm text-fg-strong ring-1 ring-inset ring-line-strong placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <Button type="submit" aria-label="Send message" disabled={!input.trim()} loading={busy} icon={<Send className="h-4 w-4" aria-hidden />} />
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-fg-muted">
              AI suggestions are hypotheses — recorded results are the source of truth.
            </p>
          </form>
        </section>
      )}
    </>
  );
}
