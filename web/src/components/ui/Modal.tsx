"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { focusOrigin, tabbables, trapTab } from "@/lib/pointerFocus";
import { Button } from "./Button";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Where focus goes on close when it is set then (e.g. an error the confirmed action produced), instead of back to the opener. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnRef = useRef(returnFocusRef);
  returnRef.current = returnFocusRef;
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = focusOrigin();
    const node = ref.current;
    // Focus first form field, else first focusable, else dialog itself.
    const first =
      node?.querySelector<HTMLElement>("[data-autofocus]") ||
      node?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea, select") ||
      node?.querySelector<HTMLElement>(FOCUSABLE);
    (first || node)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && node) trapTab(e, tabbables(node, FOCUSABLE));
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const target = returnRef.current?.current;
      if (target?.isConnected) target.focus();
      else previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const widths = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-scrim" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full ${widths[size]} flex-col rounded-t-xl bg-surface shadow-xl ring-1 ring-line sm:rounded-xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="text-h2 font-semibold text-fg-strong">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-body text-fg-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-fg-muted hover:bg-overlay hover:text-fg-strong"
            aria-label="Close"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  loading,
  onCancel,
  focusConfirm,
  focusCancel,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** The cancel button's action when it differs from closing (e.g. [Review drafts]). */
  onCancel?: () => void;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** Start with focus on the confirm button (e.g. "Stop now", where confirming is the safe direction). */
  focusConfirm?: boolean;
  /** Start with focus on Cancel (e.g. accepting a repair, where confirming is not the safe direction). */
  focusCancel?: boolean;
  /** See Modal: focus on close goes here when it is set then. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel ?? onClose} data-autofocus={focusCancel || undefined}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading} data-autofocus={focusConfirm || undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-body text-fg">{children}</div>
    </Modal>
  );
}
