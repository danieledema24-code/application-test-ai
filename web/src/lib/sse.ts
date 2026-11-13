// Server-sent events over fetch streaming (not EventSource) so the bearer token travels in the
// Authorization header, never in the URL. Resumes with Last-Event-ID after a drop (contract: SSE).

import { API_URL, authHeaders, onUnauthorised } from "./api";

export type SseMessage = { id: string | null; event: string; data: string };

/**
 * Incremental text/event-stream parser (WHATWG HTML §9.2.6). Feed it decoded chunks; it returns
 * the complete messages so far and keeps partial lines buffered. Comments (": keep-alive") are ignored.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  private sawField = false;
  /** Last id seen in the stream (persists across messages, like EventSource.lastEventId). */
  lastEventId: string | null = null;

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let idx: number;
    // Lines end with \n, \r\n or \r. A trailing lone \r might be the first half of \r\n: wait for more.
    while ((idx = this.buffer.search(/\r\n|\n|\r(?!$)/)) !== -1) {
      const line = this.buffer.slice(0, idx);
      const sepLen = this.buffer.startsWith("\r\n", idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sepLen);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (!this.sawField) return null;
      const msg: SseMessage | null =
        this.data.length > 0 ? { id: this.id ?? this.lastEventId, event: this.event || "message", data: this.data.join("\n") } : null;
      this.data = [];
      this.event = "";
      this.id = null;
      this.sawField = false;
      return msg;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.sawField = true;
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) {
      this.id = value;
      this.lastEventId = value;
    }
    return null;
  }
}

export type StreamState = "connecting" | "live" | "reconnecting" | "offline" | "stopped" | "idle";

export type StreamOptions = {
  path: string;
  /** Resume point. Sent as Last-Event-ID (and ?after= on the first connect so history is replayed). */
  lastEventId?: string | null;
  onMessage: (msg: SseMessage) => void;
  onState: (state: StreamState) => void;
  /** Retries before giving up and reporting "stopped" (design §7.3: 5). */
  maxRetries?: number;
};

export type StreamHandle = { close: () => void; reconnect: () => void };

/** Exponential backoff with a cap: 1 s, 2 s, 4 s, 8 s, 15 s. */
export function backoffMs(attempt: number): number {
  return Math.min(15000, 1000 * 2 ** Math.max(0, attempt));
}

export function openEventStream(opts: StreamOptions): StreamHandle {
  const maxRetries = opts.maxRetries ?? 5;
  let lastId = opts.lastEventId ?? null;
  let attempt = 0;
  let closed = false;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

  function schedule() {
    if (closed) return;
    if (isOffline()) {
      opts.onState("offline");
      return; // the "online" listener reconnects
    }
    if (attempt >= maxRetries) {
      opts.onState("stopped");
      return;
    }
    opts.onState("reconnecting");
    timer = setTimeout(connect, backoffMs(attempt));
    attempt += 1;
  }

  async function connect() {
    if (closed) return;
    ctrl?.abort();
    ctrl = new AbortController();
    if (attempt === 0) opts.onState("connecting");
    // Keep the preflight minimal: only Authorization and Last-Event-ID are non-safelisted (Accept is
    // CORS-safelisted). Caching is turned off with the `cache` option below, not a request header.
    const headers: Record<string, string> = { Accept: "text/event-stream", ...authHeaders() };
    if (lastId) headers["Last-Event-ID"] = lastId;
    const sep = opts.path.includes("?") ? "&" : "?";
    const url = `${API_URL}${opts.path}${lastId ? "" : `${sep}after=0`}`;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    } catch {
      if (!closed && !ctrl.signal.aborted) schedule();
      return;
    }
    if (res.status === 401) {
      opts.onState("stopped");
      onUnauthorised();
      return;
    }
    if (!res.ok || !res.body) {
      schedule();
      return;
    }
    attempt = 0;
    opts.onState("live");
    const parser = new SseParser();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(value)) {
          if (msg.id) lastId = msg.id;
          opts.onMessage(msg);
        }
      }
    } catch {
      /* dropped connection: fall through to reconnect */
    }
    if (!closed && !ctrl.signal.aborted) schedule(); // server closes after 30 min, or the network dropped
  }

  const onOnline = () => {
    if (closed) return;
    attempt = 0;
    if (timer) clearTimeout(timer);
    void connect();
  };
  const onOffline = () => {
    if (!closed) opts.onState("offline");
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }

  void connect();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
      opts.onState("idle");
    },
    reconnect() {
      if (closed) return;
      attempt = 0;
      if (timer) clearTimeout(timer);
      void connect();
    },
  };
}

/** Merge new events into a list sorted newest-first, dropping duplicates by id. Caps the list length. */
export function mergeEvents<T extends { id: number }>(existing: T[], incoming: T[], cap = 2000): T[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  if (fresh.length === 0) return existing;
  const merged = [...fresh, ...existing].sort((a, b) => b.id - a.id);
  return merged.length > cap ? merged.slice(0, cap) : merged;
}
