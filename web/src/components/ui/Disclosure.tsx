"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

/** Accessible show/hide: a real button with aria-expanded/aria-controls. Controlled or uncontrolled. */
export function Disclosure({
  label,
  openLabel,
  children,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  className = "",
  buttonClassName = "",
  headingLevel,
}: {
  label: React.ReactNode;
  /** Button text while open, e.g. "Hide steps". Defaults to `label`. */
  openLabel?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  buttonClassName?: string;
  /** Wrap the button in a heading element for document structure. */
  headingLevel?: 2 | 3;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlled ?? inner;
  const id = useId();
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setInner(next);
    onOpenChange?.(next);
  };
  const button = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={id}
      onClick={toggle}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-md text-body font-medium text-fg-strong hover:underline ${buttonClassName}`}
    >
      {open ? (openLabel ?? label) : label}
      <ChevronDown className={`h-4 w-4 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} aria-hidden />
    </button>
  );
  const Heading = headingLevel === 2 ? "h2" : headingLevel === 3 ? "h3" : null;
  return (
    <div className={className}>
      {Heading ? <Heading>{button}</Heading> : button}
      <div id={id} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}
