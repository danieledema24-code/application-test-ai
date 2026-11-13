"use client";

import Link from "next/link";

/** Settings sections (design P3 §17.1): two pages, so these are links with aria-current, not ARIA tabs. */
export function SettingsTabs({ current }: { current: "profile" | "members" }) {
  const item = (id: "profile" | "members", href: string, label: string) => (
    <Link
      href={href}
      aria-current={current === id ? "page" : undefined}
      className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-body font-medium ${current === id ? "border-accent text-fg-strong" : "border-transparent text-fg-muted hover:text-fg-strong"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Settings sections" className="mb-6 flex flex-wrap border-b border-line">
      {item("profile", "/settings", "Profile & organisation")}
      {item("members", "/settings/members", "Members")}
    </nav>
  );
}
