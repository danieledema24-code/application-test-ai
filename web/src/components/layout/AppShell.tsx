"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bug,
  FileText,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  PlayCircle,
  Plug,
  Settings,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { getToken } from "@/lib/api";
import { LoadingBlock } from "@/components/ui";
import { Topbar } from "./Topbar";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/test-runs", label: "Test Runs", icon: PlayCircle },
  { href: "/defects", label: "Defects", icon: Bug },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex items-center gap-2.5 px-5 py-5 text-fg-strong"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-on-accent">
          <FlaskConical className="h-4.5 w-4.5" aria-hidden />
        </span>
        <span className="text-sm font-semibold leading-tight">
          Application
          <br />
          Test AI
        </span>
      </Link>
      <nav aria-label="Main" className="mt-2 flex-1 px-3">
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const active =
              pathname === item.href ||
              pathname.startsWith(item.href + "/") ||
              (item.href === "/projects" && pathname.startsWith("/test-cases"));
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent-soft text-fg-strong before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                      : "text-fg-muted hover:bg-white/5 hover:text-fg-strong"
                  }`}
                >
                  <Icon className={`h-4.5 w-4.5 ${active ? "text-accent" : ""}`} aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="m-3 rounded-lg border border-line bg-surface p-3 text-xs text-fg-muted">
        <div className="flex items-center gap-2 font-medium text-fg-strong">
          <BarChart3 className="h-4 w-4 text-fg-muted" aria-hidden /> Recorded results first
        </div>
        <p className="mt-1 leading-relaxed">AI suggestions are hypotheses. Test results recorded by runs are the source of truth.</p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/dashboard";
      router.replace(getToken() ? "/login" : `/login?next=${encodeURIComponent(next)}`);
    }
  }, [loading, user, router]);

  // Close the drawer on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    drawerCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  if (loading || !user) return <LoadingBlock label="Loading your workspace…" className="min-h-screen" />;

  return (
    <div className="min-h-screen bg-canvas">
      <a
        href="#main"
        className="sr-only z-[90] rounded bg-accent px-3 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-canvas lg:block">
        <SidebarContent />
      </aside>
      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-canvas shadow-xl">
            <button
              ref={drawerCloseRef}
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-5 rounded p-1 text-fg-muted hover:text-fg-strong"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}
      <div className="lg:pl-60">
        <Topbar onOpenNav={() => setDrawerOpen(true)} />
        <main id="main" tabIndex={-1} className="mx-auto max-w-[1400px] px-4 py-6 focus:outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      <AssistantPanel />
    </div>
  );
}
