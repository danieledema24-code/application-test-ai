"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { AgentEvent, ProjectDetail, ScanSettings, StageState, Workflow } from "@/lib/contract";
import { activeStage } from "@/lib/lifecycle";
import { mergeEvents, openEventStream, type StreamHandle, type StreamState } from "@/lib/sse";
import { useToast } from "@/components/ui";

const ANNOUNCE_THROTTLE_MS = 15000;

type ProjectCtx = {
  id: string;
  project: ProjectDetail | undefined;
  projectError: unknown;
  workflow: Workflow | undefined;
  workflowError: unknown;
  refresh: () => void;
  /** All events received so far, newest first, without duplicates. */
  events: AgentEvent[];
  streamState: StreamState;
  reconnect: () => void;
  /** Announce in the page's status region. `immediate` bypasses the 15 s throttle. */
  announce: (message: string, immediate?: boolean) => void;
  announceAll: boolean;
  setAnnounceAll: (v: boolean) => void;
  discovery: StageState | undefined;
  /** "Pausing…" until an event or the workflow confirms the pause. */
  pausing: boolean;
  resuming: boolean;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancelDiscovery: () => Promise<void>;
  rescan: (settings: ScanSettings) => Promise<boolean>;
  /** Opens the re-scan dialog (rendered by the project layout). */
  openRescan: () => void;
  openCancel: () => void;
};

const Ctx = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useProject must be used inside ProjectProvider");
  return c;
}

/** Human-readable status for immediate announcements (§11 live regions). */
function statusAnnouncement(e: AgentEvent): string | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.type === "stage.status_changed") {
    const stage = String(d.stage_key ?? e.stage_key ?? "stage");
    const name = stage.startsWith("discovery") || stage === "intake" ? (stage === "discovery_report" ? "Discovery report" : "Discovery") : stage.replace(/_/g, " ");
    const to = String(d.to ?? "");
    const words: Record<string, string> = {
      running: "started",
      queued: "queued",
      paused: "paused",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
      awaiting_approval: "is waiting for your approval",
      approved: "approved",
    };
    // Sentence case: "Test design is waiting for your approval", never "test design is…".
    return words[to] ? `${name.charAt(0).toUpperCase()}${name.slice(1)} ${words[to]}` : null;
  }
  if (e.type === "gate.awaiting_approval") return e.message || "A quality gate is waiting for your approval";
  if (e.type === "task.failed") return e.message;
  if (e.type === "report.ready") return "The Application Discovery Report is ready";
  return null;
}

export function ProjectProvider({ id, children, onOpenRescan, onOpenCancel }: { id: string; children: React.ReactNode; onOpenRescan: () => void; onOpenCancel: () => void }) {
  const toast = useToast();
  const { mutate: globalMutate } = useSWRConfig();
  const project = useApi<ProjectDetail>(`/projects/${id}`);
  const [pollFast, setPollFast] = useState(false);
  const workflow = useApi<Workflow>(`/projects/${id}/workflow`, undefined, { refreshInterval: pollFast ? 5000 : 30000 });
  const wf = workflow.data;
  const active = activeStage(wf);
  useEffect(() => setPollFast(!!active), [active]);

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const streamRef = useRef<StreamHandle | null>(null);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);

  // ---- announcements -----------------------------------------------------
  const [liveText, setLiveText] = useState("");
  const [announceAll, setAnnounceAll] = useState(false);
  const lastAnnounce = useRef(0);
  const pendingAnnounce = useRef<string | null>(null);
  const announce = useCallback((message: string, immediate = false) => {
    const now = Date.now();
    if (immediate || now - lastAnnounce.current >= ANNOUNCE_THROTTLE_MS) {
      lastAnnounce.current = now;
      pendingAnnounce.current = null;
      // Clear then set so repeated identical messages are announced again.
      setLiveText("");
      setTimeout(() => setLiveText(message), 50);
    } else {
      pendingAnnounce.current = message;
    }
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      if (pendingAnnounce.current && Date.now() - lastAnnounce.current >= ANNOUNCE_THROTTLE_MS) announce(pendingAnnounce.current, true);
    }, 2000);
    return () => clearInterval(t);
  }, [announce]);

  const refresh = useCallback(() => {
    void workflow.mutate();
    void project.mutate();
  }, [workflow, project]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const announceAllRef = useRef(announceAll);
  announceAllRef.current = announceAll;

  // ---- one SSE connection per open project ---------------------------------
  useEffect(() => {
    setEvents([]);
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshRef.current();
      }, 400);
    };
    let batch: AgentEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const b = batch;
      batch = [];
      setEvents((prev) => mergeEvents(prev, b));
    };
    let wasLive = false;
    const handle = openEventStream({
      path: `/projects/${id}/events/stream`,
      onState: (s) => {
        setStreamState(s);
        if (s === "live" && wasLive) announce("Live updates restored.", true);
        if ((s === "reconnecting" || s === "offline") && wasLive) announce(s === "offline" ? "You’re offline. The analysis keeps running on our servers." : "Connection lost. Reconnecting.", true);
        if (s === "live") wasLive = true;
      },
      onMessage: (msg) => {
        if (msg.event !== "agent_event" && msg.event !== "message") return;
        let e: AgentEvent;
        try {
          e = JSON.parse(msg.data) as AgentEvent;
        } catch {
          return;
        }
        if (typeof e.id !== "number") e.id = Number(msg.id ?? 0);
        batch.push(e);
        if (!flushTimer) flushTimer = setTimeout(flush, 100);

        const st = statusAnnouncement(e);
        if (e.type === "stage.status_changed" || e.type === "gate.awaiting_approval" || e.type === "gate.decided" || e.type === "task.failed") scheduleRefresh();
        if (e.type === "report.ready") void globalMutate((k) => typeof k === "string" && k.includes(`/projects/${id}/reports`));
        if (e.type === "stage.status_changed") {
          const to = String((e.data ?? {}).to ?? "");
          if (to === "paused") setPausing(false);
          if (to === "running") setResuming(false);
        }
        if (st) announce(st, true);
        else if (announceAllRef.current && e.message) announce(e.message, true);
        // Otherwise only progress summaries go to the throttled region (findings are not announced, §11).
        else if (e.type === "task.progress" && e.message) announce(e.message, false);
      },
    });
    streamRef.current = handle;
    return () => {
      handle.close();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (flushTimer) clearTimeout(flushTimer);
      streamRef.current = null;
    };
  }, [id, announce, globalMutate]);

  const discovery = wf?.stages.find((s) => s.key === "discovery");

  // Clear the transitional flags when the workflow itself shows the new state.
  useEffect(() => {
    if (pausing && (wf?.project_status === "paused" || discovery?.status === "paused" || !active)) setPausing(false);
    if (resuming && wf?.project_status !== "paused" && discovery?.status !== "paused") setResuming(false);
  }, [wf, discovery, pausing, resuming, active]);

  const prevPaused = useRef<boolean | null>(null);
  useEffect(() => {
    const paused = wf ? wf.project_status === "paused" || discovery?.status === "paused" : null;
    if (prevPaused.current !== null && paused !== null && paused !== prevPaused.current) {
      if (paused) {
        toast("Analysis paused. Resume any time; nothing is lost.", "info");
        announce("Discovery paused", true);
      } else {
        toast("Analysis resumed.");
        announce("Discovery resumed", true);
      }
    }
    if (paused !== null) prevPaused.current = paused;
  }, [wf, discovery, toast, announce]);

  // Scan records (status, "Scan n · running") are separate from the workflow; refresh them too.
  const refreshScans = useCallback(() => {
    void globalMutate((k) => typeof k === "string" && (k.includes(`/projects/${id}/scans`) || k.includes(`/projects/${id}/discovery`)));
  }, [id, globalMutate]);

  const pause = useCallback(async () => {
    setPausing(true);
    try {
      const next = await api<Workflow>(`/projects/${id}/workflow/pause`, { method: "POST" });
      await workflow.mutate(next, { revalidate: false });
      refreshScans();
    } catch (err) {
      setPausing(false);
      toast(`Couldn’t pause the analysis. ${errorMessage(err)}`, "error");
    }
  }, [id, workflow, toast, refreshScans]);

  const resume = useCallback(async () => {
    setResuming(true);
    try {
      const next = await api<Workflow>(`/projects/${id}/workflow/resume`, { method: "POST" });
      await workflow.mutate(next, { revalidate: false });
      refreshScans();
    } catch (err) {
      setResuming(false);
      toast(`Couldn’t resume the analysis. ${errorMessage(err)}`, "error");
    }
  }, [id, workflow, toast, refreshScans]);

  const cancelDiscovery = useCallback(async () => {
    try {
      await api(`/projects/${id}/stages/discovery/cancel`, { method: "POST" });
      toast("Discovery cancelled. Findings so far are kept as a partial scan.", "info");
      announce("Discovery cancelled", true);
      refresh();
    } catch (err) {
      toast(`Couldn’t cancel discovery. ${errorMessage(err)}`, "error");
    }
  }, [id, toast, announce, refresh]);

  const rescan = useCallback(
    async (settings: ScanSettings) => {
      try {
        await api(`/projects/${id}/stages/discovery/run`, { body: { reason: "Re-scan requested from the discovery workspace", parameters: settings } });
        toast("Re-scan started.");
        announce("Discovery started", true);
        refresh();
        void globalMutate((k) => typeof k === "string" && (k.includes(`/projects/${id}/scans`) || k.includes(`/projects/${id}/discovery`)));
        return true;
      } catch (err) {
        toast(`Couldn’t start the re-scan. ${errorMessage(err)}`, "error");
        return false;
      }
    },
    [id, toast, announce, refresh, globalMutate],
  );

  const value = useMemo<ProjectCtx>(
    () => ({
      id,
      project: project.data,
      projectError: project.error,
      workflow: wf,
      workflowError: workflow.error,
      refresh,
      events,
      streamState,
      reconnect: () => streamRef.current?.reconnect(),
      announce,
      announceAll,
      setAnnounceAll,
      discovery,
      pausing,
      resuming,
      pause,
      resume,
      cancelDiscovery,
      rescan,
      openRescan: onOpenRescan,
      openCancel: onOpenCancel,
    }),
    [id, project.data, project.error, wf, workflow.error, refresh, events, streamState, announce, announceAll, discovery, pausing, resuming, pause, resume, cancelDiscovery, rescan, onOpenRescan, onOpenCancel],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveText}
      </div>
    </Ctx.Provider>
  );
}
