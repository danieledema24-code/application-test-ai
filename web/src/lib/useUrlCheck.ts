"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import useSWR from "swr";
import type { Health, UrlCheckResult } from "./contract";
import type { ClientUrlPolicy } from "./url";

export type UrlCheckState =
  | { status: "idle" }
  | { status: "checking"; url: string }
  | { status: "done"; url: string; result: UrlCheckResult }
  | { status: "error"; url: string; error: unknown };

/**
 * Runs POST /projects/url-check for `url` (already client-validated), debounced by `delayMs`.
 * Pass null to reset. `recheck()` runs it again immediately. Out-of-order responses are ignored.
 */
export function useUrlCheck(url: string | null, delayMs = 600) {
  const [state, setState] = useState<UrlCheckState>({ status: "idle" });
  const seq = useRef(0);
  const pending = useRef<Promise<UrlCheckState> | null>(null);

  const run = useCallback((target: string): Promise<UrlCheckState> => {
    const n = ++seq.current;
    setState({ status: "checking", url: target });
    const p = api<UrlCheckResult>("/projects/url-check", { body: { url: target } })
      .then((result): UrlCheckState => ({ status: "done", url: target, result }))
      .catch((error: unknown): UrlCheckState => ({ status: "error", url: target, error }))
      .then((s) => {
        if (n === seq.current) setState(s);
        return s;
      });
    pending.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (!url) {
      seq.current++;
      setState({ status: "idle" });
      pending.current = null;
      return;
    }
    const t = setTimeout(() => void run(url), delayMs);
    return () => clearTimeout(t);
  }, [url, delayMs, run]);

  const recheck = useCallback(() => (url ? run(url) : Promise.resolve<UrlCheckState>({ status: "idle" })), [url, run]);

  /** Resolves with the current check, waiting for one in flight (submit waits for a pending check, §6). */
  const settled = useCallback(async (): Promise<UrlCheckState> => {
    if (state.status === "done" || state.status === "error") return state;
    if (pending.current) return pending.current;
    return url ? run(url) : { status: "idle" };
  }, [state, url, run]);

  return { state, recheck, settled };
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * Client URL policy from GET /health. Private/loopback hosts are blocked in the browser only when
 * the server says it blocks them (`allow_private_targets: false`). While loading, or if the field
 * is absent, the server's URL check decides (it is authoritative either way).
 */
export function useClientUrlPolicy(): ClientUrlPolicy {
  const { data } = useSWR<Health>("/health", (k: string) => api<Health>(k), { revalidateOnFocus: false, dedupingInterval: 300_000, shouldRetryOnError: false });
  return { blockPrivate: data?.allow_private_targets === false };
}
