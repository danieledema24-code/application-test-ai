"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ToastKind = "success" | "error" | "info";
export type ToastOptions = {
  /** One action button, e.g. [Undo] (design P2 §13). Pressing it dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it disappears. Default 6 s (8 s for errors). */
  duration?: number;
};
type ToastItem = { id: number; kind: ToastKind; message: string; action?: ToastOptions["action"] };
type ToastFn = (message: string, kind?: ToastKind, opts?: ToastOptions) => void;

const ToastContext = createContext<{ toast: ToastFn } | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback<ToastFn>(
    (message, kind = "success", opts) => {
      const id = ++counter;
      setItems((xs) => [...xs, { id, kind, message, action: opts?.action }]);
      setTimeout(() => dismiss(id), opts?.duration ?? (kind === "error" ? 8000 : 6000));
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed left-1/2 top-4 z-[80] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg bg-surface px-3.5 py-3 text-body text-fg-strong shadow-lg ring-1 ring-line-strong"
          >
            {t.kind === "success" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-fg" aria-hidden />}
            {t.kind === "error" && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" aria-hidden />}
            {t.kind === "info" && <Info className="mt-0.5 h-4 w-4 shrink-0 text-info-fg" aria-hidden />}
            <p className="flex-1">{t.message}</p>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="rounded px-1 text-body font-semibold text-navy-700 underline underline-offset-2 hover:text-navy-900"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="rounded p-0.5 text-fg-muted hover:text-fg-strong">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx.toast;
}
