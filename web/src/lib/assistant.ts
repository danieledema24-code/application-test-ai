// AI QA Analyst client (api-contracts.md P2-10). A message is answered as JSON, or as an SSE stream when
// we ask for text/event-stream: deltas are display hints only; `assistant.done` carries the final,
// citation-checked turn that replaces them. Parsing is unit-tested in tests/unit/assistant.spec.ts.

import { API_URL, ApiError, NETWORK_ERROR_MESSAGE, authHeaders, onUnauthorised, toApiError } from "./api";
import type { AssistantMessageCreate, AssistantTurn, Proposal } from "./contract";
import { SseParser, type SseMessage } from "./sse";

export type AssistantStreamEvent =
  | { type: "started"; answeredBy: string | null }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; status: string }
  | { type: "proposal"; proposal: Proposal };

/** Applies one SSE message. Returns the final turn on `assistant.done`; throws on `assistant.error`. */
export function handleAssistantSse(msg: SseMessage, onEvent: (e: AssistantStreamEvent) => void): AssistantTurn | null {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(msg.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (msg.event) {
    case "assistant.started":
      onEvent({ type: "started", answeredBy: typeof data.answered_by === "string" ? data.answered_by : null });
      return null;
    case "assistant.delta":
      if (typeof data.text === "string") onEvent({ type: "delta", text: data.text });
      return null;
    case "assistant.tool":
      onEvent({ type: "tool", name: String(data.name ?? ""), status: String(data.status ?? "") });
      return null;
    case "assistant.proposal":
      onEvent({ type: "proposal", proposal: data as unknown as Proposal });
      return null;
    case "assistant.done":
      return data as unknown as AssistantTurn;
    case "assistant.error": {
      const code = String(data.code ?? "ai_error");
      throw new ApiError(code === "rate_limited" ? 429 : 502, code, String(data.message ?? "The AI provider isn’t responding."));
    }
    default:
      return null;
  }
}

/** Sends a message and resolves with the final turn. `signal` aborts (Stop): nothing is kept. */
export async function sendAssistantMessage(
  threadId: string,
  body: AssistantMessageCreate,
  opts: { signal?: AbortSignal; onEvent?: (e: AssistantStreamEvent) => void } = {},
): Promise<AssistantTurn> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/assistant/threads/${threadId}/messages`, {
      method: "POST",
      headers: { Accept: "text/event-stream, application/json", "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError(0, "network", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthorised();
    const data = await res.json().catch(() => null);
    throw toApiError(res.status, data, res.headers);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream") || !res.body) return (await res.json()) as AssistantTurn;
  const parser = new SseParser();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const msg of parser.push(value)) {
      const turn = handleAssistantSse(msg, opts.onEvent ?? (() => undefined));
      if (turn) {
        void reader.cancel().catch(() => undefined);
        return turn;
      }
    }
  }
  throw new ApiError(502, "ai_error", "The answer stopped before it finished. Try again.");
}

/** ID-like tokens the citation guard knows (roadmap P2-10; P3-06 adds TCOND- and TD-). */
export const CITATION_TOKEN = /\b(?:REQ|AC|FEAT|JRN|EV|RISK|DOR|DOD|DOC|SCAN|PROP|TCOND|TC|TD|RUN|DEF)-\d{2,}\b|\bG[1-9]\b/g;

export type ContentPart = { kind: "text"; text: string } | { kind: "token"; text: string };

/** Splits plain text into text and ID-token parts, for citation chips. */
export function splitCitations(text: string): ContentPart[] {
  const out: ContentPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION_TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: "text", text: text.slice(last, i) });
    out.push({ kind: "token", text: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
