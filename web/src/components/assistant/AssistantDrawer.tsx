"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ArtefactRef } from "@/lib/contract";
import { Drawer } from "@/components/ui";
import { AssistantWorkspace } from "./AssistantWorkspace";

type Ctx = { open: (context?: ArtefactRef | null) => void };

const DrawerCtx = createContext<Ctx>({ open: () => undefined });

/** Opens the assistant side panel, optionally about an item ("About: REQ-0007"). */
export function useAssistantDrawer(): Ctx {
  return useContext(DrawerCtx);
}

const threadKey = (projectId: string) => `qa:assistant-thread:${projectId}`;

/**
 * The secondary assistant entry point (design P2 §11.6): a right Drawer (480px, full screen below md) with
 * the current thread (compact), the composer, a Tasks menu and "Open full view".
 */
export function AssistantDrawerProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [context, setContext] = useState<ArtefactRef | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    try {
      setThreadId(window.sessionStorage.getItem(threadKey(projectId)));
    } catch {
      /* storage unavailable: start a new thread */
    }
  }, [projectId]);

  const onThreadId = useCallback(
    (id: string | null) => {
      setThreadId(id);
      try {
        if (id) window.sessionStorage.setItem(threadKey(projectId), id);
        else window.sessionStorage.removeItem(threadKey(projectId));
      } catch {
        /* ignore */
      }
    },
    [projectId],
  );

  const open = useCallback((c?: ArtefactRef | null) => {
    setContext(c ?? null);
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <DrawerCtx.Provider value={value}>
      {children}
      <Drawer open={isOpen} onClose={() => setOpen(false)} title="AI QA Analyst" narrow>
        <AssistantWorkspace variant="drawer" threadId={threadId} onThreadId={onThreadId} context={context} onClearContext={() => setContext(null)} />
      </Drawer>
    </DrawerCtx.Provider>
  );
}
