"use client";

import { useEffect, useId, useState } from "react";

/**
 * Tooltip that shows on hover *and* focus, stays while hovered, and is dismissed with Escape
 * (WCAG 1.4.13). Visual only: the trigger must carry the full text in its own accessible name.
 */
export function Tooltip({ content, children, className = "" }: { content: React.ReactNode; children: React.ReactElement | React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <span
        id={id}
        aria-hidden
        className={`pointer-events-none absolute bottom-full left-1/2 z-40 mb-2 w-max max-w-[16rem] -translate-x-1/2 rounded-md bg-navy-900 px-2 py-1 text-caption font-medium text-white shadow-md ${open ? "" : "hidden"}`}
      >
        {content}
      </span>
    </span>
  );
}
