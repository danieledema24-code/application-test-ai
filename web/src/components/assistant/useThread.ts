"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { sendAssistantMessage } from "@/lib/assistant";
import { useApi } from "@/lib/hooks";
import type { ArtefactRef, AssistantCapabilities, AssistantMessage, AssistantMessageCreate, Proposal, Thread } from "@/lib/contract";
import type { AiMode } from "@/components/domain/AiStatus";

export function useCapabilities(projectId: string) {
  return useApi<AssistantCapabilities>(`/projects/${projectId}/assistant/capabilities`, undefined, { shouldRetryOnError: false });
}

export type SendInput = { body: AssistantMessageCreate; display: string };

/**
 * One assistant thread: loads it, sends messages (streamed when the server streams), Stop, and the AI
 * mode learnt from errors. Streamed text is a display hint; the final turn replaces it.
 */
export function useAssistantThread(projectId: string, threadId: string | null, onThreadId: (id: string) => void) {
  const thread = useApi<Thread>(threadId ? `/assistant/threads/${threadId}` : null, { limit: 50 });
  const [extra, setExtra] = useState<AssistantMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<AssistantMessage | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamProposals, setStreamProposals] = useState<Proposal[]>([]);
  const [stopped, setStopped] = useState<{ user: AssistantMessage; text: string } | null>(null);
  const [error, setError] = useState<{ text: string; mode?: AiMode } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [lastInput, setLastInput] = useState<SendInput | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    setExtra([]);
    setStopped(null);
    setError(null);
  }, [threadId]);

  const messages = useMemo(() => {
    const byId = new Map<string, AssistantMessage>();
    for (const m of [...(thread.data?.messages ?? []), ...extra]) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [thread.data, extra]);

  const send = useCallback(
    async (input: SendInput) => {
      setError(null);
      setStopped(null);
      setLastInput(input);
      let id = threadId;
      const user: AssistantMessage = {
        id: `local-${Date.now()}`,
        thread_id: id ?? "",
        role: "user",
        content: input.display,
        intent: input.body.intent ?? null,
        answered_by: null,
        generated_by: null,
        citations: input.body.context ? [input.body.context] : [],
        proposals: [],
        notices: [],
        created_at: new Date().toISOString(),
      };
      setPendingUser(user);
      setStreaming(true);
      setStreamText("");
      setStreamProposals([]);
      setAnnounce("");
      ctrl.current = new AbortController();
      try {
        if (!id) {
          const t = await api<Thread>(`/projects/${projectId}/assistant/threads`, { body: { title: input.display.slice(0, 120) } });
          id = t.id;
          onThreadId(t.id);
        }
        const turn = await sendAssistantMessage(id, input.body, {
          signal: ctrl.current.signal,
          onEvent: (e) => {
            if (e.type === "delta") setStreamText((t) => t + e.text);
            if (e.type === "proposal") setStreamProposals((ps) => [...ps, e.proposal]);
          },
        });
        setExtra((x) => [...x, turn.user_message, turn.reply]);
        setPendingUser(null);
        setAnnounce("Answer ready");
      } catch (err) {
        if (ctrl.current?.signal.aborted) return; // Stop: handled by stop()
        setPendingUser(null);
        if (err instanceof ApiError && err.status === 429) {
          const at = err.retryAfter ? new Date(Date.now() + err.retryAfter * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null;
          setError({ text: `You’ve reached this project’s AI limit for now.${at ? ` It resets at ${at}.` : ""} Tasks that work without AI still run.`, mode: "limited" });
        } else if (err instanceof ApiError && err.code === "network") setError({ text: "You’re offline. Your question is still here; send it when you reconnect." });
        else if (err instanceof ApiError && (err.code === "ai_error" || err.status === 502 || err.status === 503))
          setError({ text: "The AI provider isn’t responding. Tasks that work without AI are still available. Try again in a few minutes.", mode: "unavailable" });
        else if (err instanceof ApiError && err.status === 422 && /citation|check/i.test(err.message))
          setError({ text: "The answer didn’t pass our checks (it cited items that don’t exist), so it isn’t shown. Try rephrasing or narrow the scope." });
        else if (err instanceof ApiError && err.status === 403) setError({ text: "You don’t have permission for this task. Ask an owner or admin." });
        else setError({ text: `Couldn’t get an answer. ${err instanceof Error ? err.message : ""}`.trim() });
      } finally {
        setStreaming(false);
        ctrl.current = null;
      }
    },
    [projectId, threadId, onThreadId],
  );

  const stop = useCallback(() => {
    if (!ctrl.current) return;
    ctrl.current.abort();
    if (pendingUser) setStopped({ user: pendingUser, text: streamText });
    setPendingUser(null);
    setStreaming(false);
    setAnnounce("Stopped");
  }, [pendingUser, streamText]);

  return {
    thread,
    messages,
    pendingUser,
    streaming,
    streamText,
    streamProposals,
    stopped,
    error,
    announce,
    lastInput,
    send,
    stop,
    refresh: () => void thread.mutate(),
  };
}

export type ThreadState = ReturnType<typeof useAssistantThread>;

export function contextLabel(c: ArtefactRef | null | undefined): string | null {
  return c ? c.key : null;
}
