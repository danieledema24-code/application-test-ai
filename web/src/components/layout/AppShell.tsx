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
        className="flex items-center gap-2.5 px-5 py-5 text-white focus-visible:outline-white"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
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
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-white ${
                    active ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Icon className={`h-4.5 w-4.5 ${active ? "text-blue-300" : ""}`} aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="m-3 rounded-lg bg-white/5 p-3 text-xs text-slate-300">
        <div className="flex items-center gap-2 font-medium text-white">
          <BarChart3 className="h-4 w-4 text-blue-300" aria-hidden /> Recorded results first
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
        className="sr-only z-[90] rounded bg-white px-3 py-2 text-sm font-medium text-blue-800 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 bg-navy-900 lg:block">
        <SidebarContent />
      </aside>
      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawerOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 bg-navy-900 shadow-xl">
            <button
              ref={drawerCloseRef}
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-5 rounded p-1 text-slate-300 hover:text-white focus-visible:outline-white"
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
