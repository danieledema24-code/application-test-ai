"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsUpDown, CircleHelp, FolderKanban, LayoutDashboard, ScanSearch, Settings, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { Page, ProjectDetail, ProjectSummary, Proposal, TestCaseStats, Workflow } from "@/lib/contract";
import { PROJECT_SECTIONS, comingLabel, isBuilt, phaseLabel, projectRoute, sectionBadge } from "@/lib/sections";
import { LoadingBlock } from "@/components/ui";
import { Topbar } from "./Topbar";
import { takeRouteFocusClaim } from "@/lib/focusReturn";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderKanban },
];
const FOOT_NAV = [
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/help", label: "Help", icon: CircleHelp },
];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function navItemClass(active: boolean) {
  return `relative flex min-h-9 items-center gap-3 rounded-md px-3 py-1.5 text-body font-medium transition-colors duration-150 ${
    active
      ? "bg-accent-soft text-fg-strong before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
      : "text-fg-muted hover:bg-overlay hover:text-fg-strong"
  }`;
}

function SwitchProject({ currentId }: { currentId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useApi<Page<ProjectSummary>>(open ? "/projects" : null, { limit: 8, status: "active" });
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
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Switch project"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-1.5 text-fg-muted hover:bg-overlay hover:text-fg-strong"
      >
        <ChevronsUpDown className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-40 w-60 rounded-lg bg-surface py-1 shadow-md ring-1 ring-line-strong">
          <p className="px-3 py-1.5 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Recent projects</p>
          {!data && <p className="px-3 py-2 text-small text-fg-muted">Loading…</p>}
          <ul>
            {data?.items.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  onClick={() => setOpen(false)}
                  aria-current={p.id === currentId ? "true" : undefined}
                  className={`block truncate px-3 py-2 text-body hover:bg-overlay ${p.id === currentId ? "font-semibold text-fg-strong" : "text-fg"}`}
                >
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/projects" onClick={() => setOpen(false)} className="block border-t border-line px-3 py-2 text-small font-medium text-fg-strong hover:bg-overlay">
            All projects
          </Link>
        </div>
      )}
    </div>
  );
}

function ProjectNav({ id, section, onNavigate }: { id: string; section: string; onNavigate?: () => void }) {
  const { data: project } = useApi<ProjectDetail>(`/projects/${id}`);
  // Same SWR keys as the workspace, so these are shared, not extra requests.
  const { data: workflow } = useApi<Workflow>(`/projects/${id}/workflow`);
  const { data: proposals } = useApi<Page<Proposal>>(`/projects/${id}/assistant/proposals`, { status: "pending", limit: 100 }, { shouldRetryOnError: false });
  const pending = proposals?.items?.filter((x) => x.status === "pending").length ?? 0;
  const designed = !!workflow?.stages.find((x) => x.key === "test_design")?.current_version;
  const { data: caseStats } = useApi<TestCaseStats>(designed ? `/projects/${id}/test-cases/stats` : null, undefined, { shouldRetryOnError: false });
  return (
    <div className="mt-6">
      <p className="px-3 text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Project</p>
      <div className="mt-1 flex items-center justify-between gap-1 px-3">
        <p className="truncate text-body font-semibold text-fg-strong" title={project?.name}>
          {project?.name ?? "Loading…"}
        </p>
        <SwitchProject currentId={id} />
      </div>
      <nav aria-label="Project sections" className="mt-1">
        <ul className="space-y-0.5">
          {PROJECT_SECTIONS.map((s) => {
            const href = `/projects/${id}${s.slug ? `/${s.slug}` : ""}`;
            const active = section === s.slug;
            const Icon = s.icon;
            const built = isBuilt(s);
            const badge = built ? sectionBadge(s.slug, workflow?.stages, pending, caseStats?.open_questions ?? 0) : null;
            return (
              <li key={s.slug || "overview"}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  aria-label={built ? (badge ? `${s.label}, ${badge.srText}` : undefined) : `${s.label}, ${comingLabel(s.phase)}`}
                  className={navItemClass(active)}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className={`min-w-0 flex-1 truncate ${built || active ? "" : "text-fg-muted"}`}>{s.label}</span>
                  {badge && (
                    <span aria-hidden className="rounded-sm bg-warning-bg px-1.5 py-0.5 text-caption font-medium tabular-nums text-warning-fg ring-1 ring-inset ring-warning-line">
                      {badge.text}
                    </span>
                  )}
                  {!built && (
                    <span aria-hidden className="rounded-sm bg-overlay px-1.5 py-0.5 text-caption font-medium text-fg-muted ring-1 ring-inset ring-line-strong">
                      <span className="hidden xl:inline">{phaseLabel(s.phase)}</span>
                      <span className="xl:hidden">{s.phase === null ? "Later" : `P${s.phase}`}</span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { organisation } = useAuth();
  const project = projectRoute(pathname);
  const isActive = (href: string) =>
    href === "/projects" ? pathname === "/projects" || pathname === "/projects/new" : pathname === href || pathname.startsWith(href + "/");
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Link href="/dashboard" onClick={onNavigate} className="flex items-center gap-2.5 px-5 py-5 text-fg-strong">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-on-accent">
          <ScanSearch className="h-4.5 w-4.5" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-body font-semibold leading-tight">QA Analyst</span>
          {organisation && <span className="block truncate text-small text-fg-muted">{organisation.name}</span>}
        </span>
      </Link>
      <div className="flex-1 px-3">
        <nav aria-label="Main">
          <ul className="space-y-0.5">
            {NAV.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={navItemClass(active)}>
                    <Icon className="h-4 w-4" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        {project && <ProjectNav id={project.id} section={project.section} onNavigate={onNavigate} />}
      </div>
      <div className="px-3 pb-3 pt-4">
        <ul className="space-y-0.5">
          {FOOT_NAV.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={navItemClass(active)}>
                  <Icon className="h-4 w-4" aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 px-3 text-small text-fg-muted">Only analyse sites you’re authorised to test.</p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!loading && !user) {
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [loading, user, router]);

  // Close the drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // On route change, move focus to the page h1 so screen-reader users hear where they are (§11).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let tries = 0;
    const t = setInterval(() => {
      // A screen that restored focus itself (e.g. back to a list row) keeps it.
      if (takeRouteFocusClaim(window.location.pathname)) {
        clearInterval(t);
        return;
      }
      const h1 = document.querySelector<HTMLElement>("main h1");
      if (h1 || ++tries > 20) {
        clearInterval(t);
        if (h1) {
          if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
          h1.focus({ preventScroll: true });
        }
      }
    }, 50);
    return () => clearInterval(t);
  }, [pathname]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    drawerCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
      if (e.key === "Tab" && drawerRef.current) {
        const items = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  if (loading || !user) return <LoadingBlock label="Loading your workspace…" className="min-h-screen" />;

  return (
    <div className="min-h-screen bg-canvas">
      <a
        href="#main"
        className="sr-only z-[90] rounded-md bg-accent px-3 py-2 text-body font-semibold text-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block">
        <SidebarContent />
      </aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-scrim" onClick={closeDrawer} aria-hidden />
          <div ref={drawerRef} className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-surface shadow-lg">
            <button
              ref={drawerCloseRef}
              type="button"
              onClick={closeDrawer}
              aria-label="Close navigation"
              className="absolute right-3 top-5 z-10 rounded-md p-1.5 text-fg-muted hover:bg-overlay hover:text-fg-strong"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
      <div className="lg:pl-64">
        <Topbar onOpenNav={() => setDrawerOpen(true)} navOpen={drawerOpen} hamburgerRef={hamburgerRef} />
        <main id="main" tabIndex={-1} className="mx-auto max-w-[1280px] px-4 py-6 focus:outline-none sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
