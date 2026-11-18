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

/** ID-like tokens the citation guard knows (roadmap P2-10; P3-06 adds TCOND- and TD-; P5-07 adds A11Y-, SEC-, PERF-, PRF-). */
export const CITATION_TOKEN = /\b(?:REQ|AC|FEAT|JRN|EV|RISK|DOR|DOD|DOC|SCAN|PROP|TCOND|TC|TD|DEF|APR|PERF|PRF)-\d{2,}\b|\b(?:RUN|A11Y|SEC)-\d{2,}(?:-\d{2,})?\b|\bG[1-9]\b/g;

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

// ---- Phase 6 action proposals (design P6 §12.3) ----------------------------------------------------------------

export const REGRESSION_FOOTER = "Creates a run request. Someone who can approve must still authorise it at Gate 7; the assistant can't start runs.";
export const EXPLORE_FOOTER = "Only clicks things that can't change data and blocks anything the page tries to send.";
export const EXPLORE_APPROVAL = "Needs approval by someone who can approve.";
export const ASSESS_FOOTER = "Starts an assessment from the evidence recorded now. Someone who can approve still decides at Gate 9.";

type ActionKind = "request_regression_run" | "start_exploration" | "assess_release";
const ACTION_KINDS = new Set<string>(["request_regression_run", "start_exploration", "assess_release"]);

export function isActionProposal(kind: string | undefined): kind is ActionKind {
  return !!kind && ACTION_KINDS.has(kind);
}

/** The footer and the single button of a Phase 6 action proposal; null for other kinds. */
export function actionProposal(kind: string | undefined, payload: Record<string, unknown> | undefined): { footer: string; applyLabel: string } | null {
  if (kind === "request_regression_run") return { footer: REGRESSION_FOOTER, applyLabel: "Create run request" };
  if (kind === "start_exploration")
    return payload?.signed_in ? { footer: `${EXPLORE_FOOTER} ${EXPLORE_APPROVAL}`, applyLabel: "Request approval" } : { footer: EXPLORE_FOOTER, applyLabel: "Start exploring" };
  if (kind === "assess_release") return { footer: ASSESS_FOOTER, applyLabel: "Assess" };
  return null;
}

/** The toast's [Open RUN-0005] / [Open EXP-0002] action (design P6 §12.3); null when nothing was created. */
export function actionToastLink(kind: string | undefined, projectId: string, key: string | undefined): { label: string; href: string } | null {
  if (!key) return null;
  if (kind === "request_regression_run" && /^RUN-\d+$/.test(key)) return { label: `Open ${key}`, href: `/projects/${projectId}/execution/${key}` };
  if (kind === "start_exploration" && /^EXP-\d+$/.test(key)) return { label: `Open ${key}`, href: `/projects/${projectId}/execution/exploratory/${key}` };
  return null;
}

/** Toast after accepting (design P6 §18): names the run or session it created. */
export function actionToast(kind: string | undefined, payload: Record<string, unknown> | undefined, key: string | undefined): string | null {
  if (kind === "request_regression_run") return `${key ?? "The run"} requested. Someone who can approve must authorise it (Gate 7).`;
  if (kind === "start_exploration") return payload?.signed_in ? `${key ?? "The session"} requested. Someone who can approve must approve it.` : `${key ?? "The session"} started.`;
  if (kind === "assess_release") return "Assessing release readiness. The recommendation appears on Release readiness.";
  return null;
}
