"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

type Section = "profile" | "members" | "load-limits" | "retention" | "audit-log";

/** Settings sections (design P3 §17.1, P5 §13.1): links with aria-current, not ARIA tabs. Load limits, Retention and Audit log are owner/admin only. */
export function SettingsTabs({ current }: { current: Section }) {
  const { role } = useAuth();
  const admin = role === "owner" || role === "admin";
  const item = (id: Section, href: string, label: string) => (
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
      {admin && item("load-limits", "/settings/load-limits", "Load limits")}
      {admin && item("retention", "/settings/retention", "Retention")}
      {admin && item("audit-log", "/settings/audit-log", "Audit log")}
    </nav>
  );
}
