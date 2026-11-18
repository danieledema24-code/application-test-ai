"use client";

import { useApi } from "@/lib/hooks";
import { isActiveSession, type SessionList } from "@/lib/exploratory";

/** The sessions list's SWR key: shared by the tab, the start dialog, the sidebar badge, the header pill and Overview. */
export const sessionsKey = (projectId: string) => `/projects/${projectId}/exploratory-sessions`;
// While anything is waiting or running the list refreshes every 2 s (SSE refreshes it sooner), else every 15 s.
const listPoll = (d: SessionList | undefined) => (d && (d.running || d.waiting.length || d.items.some(isActiveSession)) ? 2000 : 15000);

/** GET /projects/{id}/exploratory-sessions (design P6 §9.1); `enabled` false makes no call (before Gate 2). */
export function useSessions(projectId: string, enabled = true) {
  return useApi<SessionList>(enabled ? sessionsKey(projectId) : null, { limit: 50 }, { refreshInterval: listPoll, shouldRetryOnError: false });
}
