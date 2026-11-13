"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PageSummary, SitemapNode } from "@/lib/contract";
import { flattenSitemap, nodeStatus, type FlatNode } from "@/lib/discovery";
import { pathOf } from "@/lib/url";
import { Badge, EmptyState, Segmented, TBody, THead, Table, Td, TextField, Th, Tr } from "@/components/ui";
import { ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems } from "@/components/domain/EvidenceDrawer";

/** Builds a minimal tree from the pages list when the API's sitemap isn't available yet. */
export function treeFromPages(pages: PageSummary[]): SitemapNode {
  const root: SitemapNode = { path: "/", title: "Site", children: [] };
  const sorted = [...pages].sort((a, b) => pathOf(a.url).localeCompare(pathOf(b.url)));
  const byPath = new Map<string, SitemapNode>();
  for (const p of sorted) {
    const path = pathOf(p.url);
    const node: SitemapNode = { url: p.url, path, title: p.title, page_id: p.id, http_status: p.http_status, requires_auth: p.requires_auth, visited: true, children: [] };
    byPath.set(path, node);
    if (path === "/") {
      Object.assign(root, node, { children: root.children });
      byPath.set("/", root);
      continue;
    }
    const parentPath = path.replace(/\/[^/]*\/?$/, "") || "/";
    (byPath.get(parentPath) ?? root).children!.push(node);
  }
  return root;
}

function Tree({ root, onOpen, pagesById }: { root: SitemapNode; onOpen: (pageId: string) => void; pagesById: Map<string, PageSummary> }) {
  const all = useMemo(() => flattenSitemap(root, null), [root]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(all.filter((n) => n.level <= 2).map((n) => n.key)));
  const visible = useMemo(() => flattenSitemap(root, expanded), [root, expanded]);
  const [focusKey, setFocusKey] = useState<string | null>(visible[0]?.key ?? null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const current = visible.find((n) => n.key === focusKey) ?? visible[0];

  useEffect(() => {
    if (focusKey && !visible.some((n) => n.key === focusKey)) setFocusKey(visible[0]?.key ?? null);
  }, [visible, focusKey]);

  function move(to: FlatNode | undefined) {
    if (!to) return;
    setFocusKey(to.key);
    refs.current.get(to.key)?.focus();
  }
  function toggle(n: FlatNode, open?: boolean) {
    setExpanded((s) => {
      const next = new Set(s);
      const willOpen = open ?? !next.has(n.key);
      if (willOpen) next.add(n.key);
      else next.delete(n.key);
      return next;
    });
  }
  function onKeyDown(e: React.KeyboardEvent, n: FlatNode) {
    const i = visible.findIndex((x) => x.key === n.key);
    const isOpen = expanded.has(n.key);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(visible[i + 1]);
        break;
      case "ArrowUp":
        move(visible[i - 1]);
        break;
      case "ArrowRight":
        if (n.hasChildren && !isOpen) toggle(n, true);
        else if (n.hasChildren) move(visible[i + 1]);
        break;
      case "ArrowLeft":
        if (n.hasChildren && isOpen) toggle(n, false);
        else move(visible.find((x) => x.key === n.parentKey));
        break;
      case "Home":
        move(visible[0]);
        break;
      case "End":
        move(visible[visible.length - 1]);
        break;
      case "Enter":
      case " ":
        if (n.node.page_id) onOpen(n.node.page_id);
        else if (n.hasChildren) toggle(n);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  return (
    <ul role="tree" aria-label="Sitemap" className="py-1">
      {visible.map((n) => {
        const st = nodeStatus(n.node);
        const page = n.node.page_id ? pagesById.get(n.node.page_id) : undefined;
        const isOpen = expanded.has(n.key);
        return (
          <li
            key={n.key}
            ref={(el) => {
              if (el) refs.current.set(n.key, el);
              else refs.current.delete(n.key);
            }}
            role="treeitem"
            aria-level={n.level}
            aria-expanded={n.hasChildren ? isOpen : undefined}
            aria-selected={current?.key === n.key}
            tabIndex={current?.key === n.key ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, n)}
            onFocus={() => setFocusKey(n.key)}
            className="rounded-md focus:outline-none focus-visible:outline-2 focus-visible:outline-focus"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 hover:bg-overlay" style={{ paddingLeft: `${(n.level - 1) * 1.25 + 0.5}rem` }}>
              <span className="flex w-5 justify-center" aria-hidden>
                {n.hasChildren ? (
                  <button type="button" tabIndex={-1} onClick={() => toggle(n)} className="rounded p-0.5 text-fg-muted hover:text-fg-strong">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : null}
              </span>
              <span className="min-w-[8rem] break-all font-mono text-small text-fg-strong">{n.path}</span>
              {n.node.page_id ? (
                <button type="button" tabIndex={-1} onClick={() => onOpen(n.node.page_id!)} className="min-w-0 flex-1 truncate text-left text-small text-navy-700 underline underline-offset-2">
                  {n.node.title || "Untitled"}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-small text-fg">{n.node.title || ""}</span>
              )}
              <Badge tone={st.tone}>{st.label}</Badge>
              {n.node.page_id && <ObservationLabel provenance="observed" />}
              {page && <EvidenceLinks items={linksToItems([page.screenshot])} subject={`${n.node.title || n.path} page`} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function List({ pages, onOpen }: { pages: PageSummary[]; onOpen: (id: string) => void }) {
  return (
    <>
      {/* below md: one card per page, so the view never scrolls sideways (§14 #32) */}
      <ul aria-label="Pages found" className="space-y-3 md:hidden">
        {pages.map((p) => {
          const st = nodeStatus({ page_id: p.id, http_status: p.http_status, requires_auth: p.requires_auth, visited: true });
          return (
            <li key={p.id} className="space-y-1.5 rounded-lg border border-line bg-surface p-3">
              <button type="button" onClick={() => onOpen(p.id)} className="break-all text-left font-mono text-small text-navy-700 underline underline-offset-2">
                {pathOf(p.url)}
              </button>
              <p className="break-words text-small text-fg">{p.title || "—"}</p>
              <p className="flex flex-wrap items-center gap-2 text-small">
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="text-fg-muted">
                  Depth {p.depth} · {p.page_type.replace(/_/g, " ")}
                </span>
                <ObservationLabel provenance="observed" />
                <EvidenceLinks items={linksToItems([p.screenshot])} subject={`${p.title || pathOf(p.url)} page`} />
              </p>
            </li>
          );
        })}
      </ul>
      <ListTable pages={pages} onOpen={onOpen} />
    </>
  );
}

function ListTable({ pages, onOpen }: { pages: PageSummary[]; onOpen: (id: string) => void }) {
  return (
    <Table label="Pages found" className="hidden md:block">
      <THead>
        <tr>
          <Th>Path</Th>
          <Th>Title</Th>
          <Th>Status</Th>
          <Th className="text-right">Depth</Th>
          <Th>Type</Th>
          <Th>Label</Th>
          <Th>Evidence</Th>
        </tr>
      </THead>
      <TBody>
        {pages.map((p) => {
          const st = nodeStatus({ page_id: p.id, http_status: p.http_status, requires_auth: p.requires_auth, visited: true });
          return (
            <Tr key={p.id}>
              <Td rowHeader className="font-mono text-small">
                <button type="button" onClick={() => onOpen(p.id)} className="break-all text-left text-navy-700 underline underline-offset-2">
                  {pathOf(p.url)}
                </button>
              </Td>
              <Td>{p.title || "—"}</Td>
              <Td>
                <Badge tone={st.tone}>{st.label}</Badge>
              </Td>
              <Td className="text-right tabular-nums">{p.depth}</Td>
              <Td>{p.page_type.replace(/_/g, " ")}</Td>
              <Td>
                <ObservationLabel provenance="observed" />
              </Td>
              <Td>
                <EvidenceLinks items={linksToItems([p.screenshot])} subject={`${p.title || pathOf(p.url)} page`} />
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

const AUTH_FILTERS = [
  { value: "all", label: "All pages" },
  { value: "public", label: "Public" },
  { value: "auth", label: "Needs credentials" },
] as const;

/** Sitemap (design spec §8.2): ARIA tree (APG pattern) with a List alternative; filter by type and access. */
export function SitemapView({ sitemap, pages, onOpenPage }: { sitemap: SitemapNode | undefined; pages: PageSummary[]; onOpenPage: (id: string) => void }) {
  const [mode, setMode] = useState<"tree" | "list">("tree");
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setMode("list");
  }, []);
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [auth, setAuth] = useState<(typeof AUTH_FILTERS)[number]["value"]>("all");
  const types = useMemo(() => Array.from(new Set(pages.map((p) => p.page_type))).sort(), [pages]);
  const filtered = pages.filter(
    (p) =>
      (type === "all" || p.page_type === type) &&
      (auth === "all" || (auth === "auth" ? p.requires_auth : !p.requires_auth)) &&
      (!q || `${p.url} ${p.title}`.toLowerCase().includes(q.toLowerCase())),
  );
  const filtering = q || type !== "all" || auth !== "all";
  const pagesById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const root = sitemap && (sitemap.children?.length || sitemap.page_id) ? sitemap : treeFromPages(pages);

  if (pages.length === 0 && !sitemap?.children?.length) return <EmptyState title="No pages yet" description="Pages appear here as discovery visits them." />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label="Sitemap view"
          options={[
            { value: "tree", label: "Tree" },
            { value: "list", label: "List" },
          ]}
          value={filtering ? "list" : mode}
          onChange={(v) => setMode(v as "tree" | "list")}
        />
        <label className="text-small text-fg-strong">
          <span className="mb-1 block font-medium">Page type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="h-10 rounded-md bg-surface px-2 text-body ring-1 ring-inset ring-line-input">
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-small text-fg-strong">
          <span className="mb-1 block font-medium">Access</span>
          <select value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)} className="h-10 rounded-md bg-surface px-2 text-body ring-1 ring-inset ring-line-input">
            {AUTH_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <TextField label="Search pages" type="search" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="w-full sm:ml-auto sm:w-64" />
      </div>
      {filtering && <p className="text-small text-fg-muted">Filters show results as a list. {filtered.length} of {pages.length} pages match.</p>}
      {filtering || mode === "list" ? <List pages={filtered} onOpen={onOpenPage} /> : <Tree root={root} onOpen={onOpenPage} pagesById={pagesById} />}
    </div>
  );
}
