"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Bell, Bug, ChevronDown, CircleHelp, FileCheck2, FolderKanban, LogOut, Menu, PlayCircle, Search, User } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { timeAgo } from "@/lib/format";
import type { Notification, SearchResults } from "@/lib/types";
import { Spinner } from "@/components/ui";

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

type SearchItem = { href: string; label: string; sub: string; icon: React.ReactNode };

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  useDismiss(open, () => setOpen(false), ref);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<SearchResults>("/search", { query: { q: term }, signal: ctrl.signal });
        setResults(r);
        setOpen(true);
        setActive(-1);
      } catch {
        if (!ctrl.signal.aborted) setResults({ projects: [], testCases: [], defects: [], runs: [] });
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const items: SearchItem[] = results
    ? [
        ...(results.projects || []).map((p) => ({
          href: `/projects/${p.id}`,
          label: p.name,
          sub: "Project",
          icon: <FolderKanban className="h-4 w-4" aria-hidden />,
        })),
        ...(results.testCases || []).map((c) => ({
          href: `/test-cases/${c.id}`,
          label: `${c.key} · ${c.title}`,
          sub: "Test case",
          icon: <FileCheck2 className="h-4 w-4" aria-hidden />,
        })),
        ...(results.runs || []).map((r) => ({
          href: `/test-runs/${r.id}`,
          label: `${r.key} · ${r.name}`,
          sub: "Test run",
          icon: <PlayCircle className="h-4 w-4" aria-hidden />,
        })),
        ...(results.defects || []).map((d) => ({
          href: `/defects/${d.id}`,
          label: `${d.key} · ${d.title}`,
          sub: "Defect",
          icon: <Bug className="h-4 w-4" aria-hidden />,
        })),
      ]
    : [];

  function go(item: SearchItem) {
    setOpen(false);
    setQ("");
    router.push(item.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      go(items[active]);
    }
  }

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <label htmlFor="global-search" className="sr-only">
        Search projects, test cases, runs and defects
      </label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
      <input
        id="global-search"
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search…"
        className="block h-9 w-full rounded-md border-0 bg-slate-100 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
      />
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2">
          <Spinner label="" />
        </span>
      )}
      {open && results && (
        <div className="absolute left-0 right-0 top-11 z-40 overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-slate-200">
          {items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-600">No matches for “{q}”.</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Search results" className="max-h-80 overflow-y-auto py-1">
              {items.map((it, i) => (
                <li
                  key={it.href}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(it);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${i === active ? "bg-blue-50" : ""}`}
                >
                  <span className="text-slate-500">{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-900">{it.label}</span>
                  <span className="text-xs text-slate-600">{it.sub}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const { data, error, mutate } = useApi<Notification[]>("/notifications", undefined, { refreshInterval: 60000 });
  const unread = (data || []).filter((n) => !n.read).length;

  async function markAll() {
    try {
      await api("/notifications/read-all", { method: "POST" });
      await mutate();
    } catch {
      /* ignore */
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      >
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-80 overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={markAll} className="text-xs font-medium text-blue-700 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {error && <p className="px-4 py-3 text-sm text-red-700">Couldn’t load notifications.</p>}
            {!error && !data && <p className="px-4 py-3 text-sm text-slate-600">Loading…</p>}
            {data && data.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-600">You’re all caught up.</p>}
            {data?.map((n) => {
              const body = (
                <>
                  <div className="flex items-start gap-2">
                    {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-600" aria-label="Unread" />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{n.title}</p>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">{n.body}</p>}
                      <p className="mt-1 text-xs text-slate-500">{timeAgo(n.createdAt)}</p>
                    </div>
                  </div>
                </>
              );
              return n.link ? (
                <Link
                  key={n.id}
                  href={n.link}
                  onClick={() => setOpen(false)}
                  className="block border-b border-slate-50 px-4 py-3 hover:bg-slate-50"
                >
                  {body}
                </Link>
              ) : (
                <div key={n.id} className="border-b border-slate-50 px-4 py-3">
                  {body}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const initials = (user?.fullName || "?")
    .split(/\s+/)
    .map((s) => s[0])
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
        className="flex items-center gap-2 rounded-md p-1 pr-2 hover:bg-slate-100"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-900 text-xs font-semibold text-white">
          {initials}
        </span>
        <span className="hidden text-left md:block">
          <span className="block text-sm font-medium leading-tight text-slate-900">{user?.fullName}</span>
          <span className="block text-xs leading-tight text-slate-600">{user?.role === "ADMIN" ? "Admin" : "Member"}</span>
        </span>
        <ChevronDown className="hidden h-4 w-4 text-slate-500 md:block" aria-hidden />
        <span className="sr-only">Open user menu</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-40 w-56 overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-slate-200">
          <div className="border-b border-slate-100 px-4 py-2.5">
            <p className="truncate text-sm font-medium text-slate-900">{user?.fullName}</p>
            <p className="truncate text-xs text-slate-600">{user?.email}</p>
          </div>
          <Link
            role="menuitem"
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2 text-sm text-slate-800 hover:bg-slate-50"
          >
            <User className="h-4 w-4" aria-hidden /> Profile & settings
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-slate-800 hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  const { organisation } = useAuth();
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button
        type="button"
        onClick={onOpenNav}
        className="rounded-md p-2 text-slate-700 hover:bg-slate-100 lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {organisation && (
          <span className="hidden max-w-[12rem] truncate rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 xl:inline" title="Workspace">
            {organisation.name}
          </span>
        )}
        <Link
          href="/help"
          className="rounded-md p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          aria-label="Help"
          title="Help"
        >
          <CircleHelp className="h-5 w-5" aria-hidden />
        </Link>
        <Notifications />
        <UserMenu />
      </div>
    </header>
  );
}
