"use client";

// Run page ⋯ menu (design P4 §13–14): the run's frozen Test Execution Report, the analyst with this run as context,
// and a copyable link. Closes on Escape or an outside click, like the project header menu.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { useAssistantDrawer } from "@/components/assistant/AssistantDrawer";

export function RunMenu({ projectId, runKey, finished }: { projectId: string; runKey: string; finished: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const assistant = useAssistantDrawer();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const item = "flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay";
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" aria-label={`More actions for ${runKey}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="px-2.5">
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-64 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          {finished && (
            <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), router.push(`/projects/${projectId}/reports/test-execution?run=${runKey}`))}>
              Open Test Execution Report
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              assistant.open({ type: "execution_run", id: null, key: runKey, label: runKey, path: `/projects/${projectId}/execution/${runKey}` });
            }}
          >
            Ask the analyst
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              void navigator.clipboard
                .writeText(`${window.location.origin}/projects/${projectId}/execution/${runKey}`)
                .then(() => toast("Run link copied."))
                .catch(() => toast("Couldn’t copy the link.", "error"));
            }}
          >
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}
