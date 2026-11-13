"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleHelp, LogOut, Menu, Settings } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { ProjectDetail } from "@/lib/contract";
import { projectRoute, sectionBySlug } from "@/lib/sections";

/** Close a popover when clicking outside / pressing Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

type Crumb = { label: string; href?: string };

const STATIC_CRUMBS: Record<string, Crumb[]> = {
  "/dashboard": [{ label: "Dashboard" }],
  "/projects": [{ label: "Projects" }],
  "/projects/new": [{ label: "Projects", href: "/projects" }, { label: "Start QA analysis" }],
  "/settings": [{ label: "Settings" }],
  "/help": [{ label: "Help" }],
};

function Breadcrumb() {
  const pathname = usePathname();
  const project = projectRoute(pathname);
  const { data } = useApi<ProjectDetail>(project ? `/projects/${project.id}` : null);
  let crumbs: Crumb[] = STATIC_CRUMBS[pathname] ?? [];
  if (project) {
    const base = `/projects/${project.id}`;
    const section = sectionBySlug(project.section);
    crumbs = [{ label: "Projects", href: "/projects" }, { label: data?.name ?? "Project", href: section && section.slug ? base : undefined }];
    if (section && section.slug) crumbs.push({ label: section.label, href: pathname.split("/").length > 4 ? `${base}/${section.slug}` : undefined });
    if (pathname.endsWith("/reports/discovery")) crumbs.push({ label: "Application Discovery Report" });
  }
  if (crumbs.length === 0) return <div className="min-w-0 flex-1" />;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-body">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className={`flex min-w-0 items-center gap-1.5 ${i < crumbs.length - 2 ? "hidden sm:flex" : ""}`}>
              {i > 0 && (
                <span aria-hidden className="text-fg-subtle">
                  /
                </span>
              )}
              {c.href && !last ? (
                <Link href={c.href} className="truncate text-fg-muted hover:text-fg-strong hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={`truncate ${last ? "font-medium text-fg-strong" : "text-fg-muted"}`}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function UserMenu() {
  const { user, organisation, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const initials = (user?.full_name || "?")
    .split(/\s+/)
    .map((s: string) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-10 items-center gap-2 rounded-md p-1 pr-2 hover:bg-overlay"
      >
        <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-50 text-caption font-semibold text-navy-800 ring-1 ring-navy-100">
          {initials}
        </span>
        <span className="hidden text-left text-body font-medium text-fg-strong md:block">{user?.full_name}</span>
        <ChevronDown className="h-4 w-4 text-fg-muted" aria-hidden />
        <span className="sr-only">Account menu</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-40 w-64 overflow-hidden rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          <div className="border-b border-line px-4 py-2.5">
            <p className="truncate text-body font-semibold text-fg-strong">{user?.full_name}</p>
            <p className="truncate text-small text-fg-muted">{user?.email}</p>
            {organisation && <p className="truncate text-small text-fg-muted">{organisation.name}</p>}
          </div>
          <Link
            role="menuitem"
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex min-h-10 items-center gap-2 px-4 py-2 text-body text-fg-strong hover:bg-overlay"
          >
            <Settings className="h-4 w-4" aria-hidden /> Settings
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={() => void logout()}
            className="flex min-h-10 w-full items-center gap-2 px-4 py-2 text-body text-fg-strong hover:bg-overlay"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({
  onOpenNav,
  navOpen,
  hamburgerRef,
}: {
  onOpenNav: () => void;
  navOpen: boolean;
  hamburgerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6 lg:px-8">
      <button
        ref={hamburgerRef}
        type="button"
        onClick={onOpenNav}
        className="rounded-md p-2 text-fg-strong hover:bg-overlay lg:hidden"
        aria-label="Open navigation"
        aria-expanded={navOpen}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>
      <Breadcrumb />
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <Link href="/help" className="rounded-md p-2 text-fg-muted hover:bg-overlay hover:text-fg-strong" aria-label="Help">
          <CircleHelp className="h-5 w-5" aria-hidden />
        </Link>
        <UserMenu />
      </div>
    </header>
  );
}
