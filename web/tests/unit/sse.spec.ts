import { expect, test } from "@playwright/test";
import { SseParser, backoffMs, mergeEvents, openEventStream } from "../../src/lib/sse";

test("parses events split across chunks, CRLF, multi-line data and comments", () => {
  const p = new SseParser();
  expect(p.push(": keep-alive\n\nid: 7\nevent: agent_event\nda")).toEqual([]);
  expect(p.push('ta: {"a":1}\r\n\r')).toEqual([]);
  const out = p.push("\nid: 8\ndata: line1\ndata: line2\n\n");
  expect(out).toEqual([
    { id: "7", event: "agent_event", data: '{"a":1}' },
    { id: "8", event: "message", data: "line1\nline2" },
  ]);
  expect(p.lastEventId).toBe("8");
});

test("a message without id inherits the last event id", () => {
  const p = new SseParser();
  p.push("id: 3\ndata: x\n\n");
  expect(p.push("data: y\n\n")).toEqual([{ id: "3", event: "message", data: "y" }]);
});

test("mergeEvents drops duplicates on replay and keeps newest first", () => {
  const a = [{ id: 3 }, { id: 2 }, { id: 1 }];
  const merged = mergeEvents(a, [{ id: 3 }, { id: 4 }, { id: 2 }, { id: 5 }]);
  expect(merged.map((e) => e.id)).toEqual([5, 4, 3, 2, 1]);
  expect(mergeEvents(a, [{ id: 1 }])).toBe(a);
  expect(mergeEvents([], [{ id: 1 }, { id: 2 }, { id: 3 }], 2).map((e) => e.id)).toEqual([3, 2]);
});

test("backoff grows and caps at 15 s", () => {
  expect([0, 1, 2, 3, 4, 5].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
});

test("stream request sends no custom headers beyond Last-Event-ID (minimal CORS preflight)", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const h = openEventStream({ path: "/projects/p1/events/stream", lastEventId: "41", onMessage: () => {}, onState: () => {}, maxRetries: 0 });
    await new Promise((r) => setTimeout(r, 20));
    h.close();
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(calls.length).toBeGreaterThan(0);
  const names = Object.keys(calls[0].headers).map((k) => k.toLowerCase());
  // Accept is CORS-safelisted; Authorization is added when signed in (no window here).
  expect(names.filter((n) => n !== "accept" && n !== "authorization")).toEqual(["last-event-id"]);
  expect(calls[0].headers["Last-Event-ID"]).toBe("41");
});
