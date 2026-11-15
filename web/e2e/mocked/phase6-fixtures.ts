// DEVELOPMENT/TEST FIXTURES ONLY. Phase 6 change-set stand-ins for the QA Analyst API (backend
// app/api/routers/changes.py), layered over ./fixtures.ts with page.route(): rescans, change sets and scan
// history are answered here, everything else falls back. CHG-0001 is the demo shop's release 2 (design P6 §14
// step 2), with the subjects the backend writes (backend/tests/integration/test_p6_changes_demo.py).

import type { Page, Route } from "@playwright/test";
import type { ScanDetail, ScanSummary } from "../../src/lib/contract";
import { CHANGE_STATEMENT, type ChangeItem, type ChangeScanRef, type ChangeSet, type DisplayKind, type Significance } from "../../src/lib/change";
import { API, type MockState } from "./fixtures";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string, details: unknown = null) => json(route, status, { error: { code, message, details } });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const HOST = "http://localhost:4100";
const MEMBER = { id: "m", full_name: "M. Member" };

export const G1_CHANGED = "The URL or allowed hosts changed: authorise them again (Gate 1)";

type ScanDef = { n: number; day: string; rescan?: boolean; baseline?: number | null; g2?: boolean; status?: ScanSummary["status"]; pages: number };

export type P6State = {
  role: "owner" | "admin" | "member" | "viewer";
  scans: ScanDef[];
  sets: ChangeSet[];
  items: Record<string, ChangeItem[]>;
  /** POST /rescans answers 409: the URL or hosts changed since Gate 1. */
  g1Changed: boolean;
  /** A new comparison completes on the n-th GET of its change set (0 = right away). */
  compareDelay: number;
  requests: { method: string; path: string; body: unknown }[];
};

const iso = (day: string, time = "10:00:00") => `2026-11-${day}T${time}Z`;

export function scanRef(d: ScanDef, baselineN: number | null): ChangeScanRef {
  return {
    id: `scan${d.n}`,
    key: `SCAN-000${d.n}`,
    number: d.n,
    status: d.status ?? "completed",
    partial: d.status === "partial",
    is_rescan: !!d.rescan,
    pages: d.pages,
    started_at: iso(d.day),
    finished_at: iso(d.day, "10:09:00"),
    created_at: iso(d.day),
    g2_approved: !!d.g2,
    baseline: d.n === baselineN,
  };
}

function summary(d: ScanDef): ScanSummary {
  return {
    id: `scan${d.n}`,
    key: `SCAN-000${d.n}`,
    status: d.status ?? "completed",
    start_url: `${HOST}/`,
    pages_found: d.pages,
    started_at: iso(d.day),
    finished_at: iso(d.day, "10:09:00"),
    number: d.n,
    created_at: iso(d.day),
    is_rescan: !!d.rescan,
    baseline_number: d.baseline ?? null,
    g2_approved: !!d.g2,
  };
}

const shot = (id: string) => ({ id, kind: "screenshot", mime: "image/png", size: 70, captured_at: iso("15"), content_url: `${API}/evidence/${id}/content?exp=1&sig=x`, removed: null });
const ref = (page: string, scan: number) => ({ page_id: `pg${scan}${page}`, url: `${HOST}${page}`, fingerprint: null, screenshot: shot(`ev-${scan}${page.replace(/\//g, "-")}`), dom: null });

let seq = 0;
function item(kind: ChangeItem["kind"], display: DisplayKind, significance: Significance, page: string | null, subject: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, scans: [number, number] = [2, 3]): ChangeItem {
  seq += 1;
  return {
    id: `ci${seq}`,
    kind,
    display_kind: display,
    significance,
    page_url: page ? `${HOST}${page}` : null,
    page,
    subject,
    before,
    after,
    before_ref: page && before && kind !== "journey_changed" ? ref(page, scans[0]) : null,
    after_ref: page && after && kind !== "journey_changed" ? ref(page, scans[1]) : null,
  };
}

const field = (over: Record<string, unknown>) => ({ form: "Contact form", name: "message", label: "Message", type: "textarea", required: false, constraints: {}, options: null, ...over });
const button = (name: string) => ({ kind: "button", role: "button", name, selector: "#contact button[type=submit]", locator: `getByRole('button', { name: '${name}' })` });
const steps = (enter: string, press: string) => ({ name: "Contact the company", steps: ["Go to Home", "Open Contact us", `Enter ${enter}`, `Press ${press}`] });

/** The nine items of CHG-0001 on the demo shop (design P6 §14 step 2): 6 structural, 3 behavioural, 0 cosmetic. */
export function demoItems(): ChangeItem[] {
  return [
    item("page_added", "added", "structural", "/offers", "Page added: /offers", null, { title: "Offers", http_status: 200 }),
    item("page_removed", "removed", "structural", "/products/1", "Page removed: /products/1", { title: "Ceramic mug", http_status: 200 }, null),
    item("element_removed", "removed", "structural", "/products", "Link removed: Travel mug", { kind: "link", role: "link", name: "Travel mug", selector: "a[href='/products/1']", locator: "getByRole('link', { name: 'Travel mug' })" }, null),
    item("element_renamed", "renamed", "behavioural", "/contact", "Button renamed: Send message → Send", button("Send message"), button("Send")),
    item("form_added", "added", "structural", "/offers", "Form added: Promo code", null, { form: "Promo code", action: "/offers", method: "GET", fields: ["Promo code"], submit_label: "Apply code" }),
    item("field_added", "added", "structural", "/contact", "Field added: Order number", null, field({ name: "order", label: "Order number", type: "text", constraints: { maxlength: 20 } })),
    item("field_changed", "changed", "structural", "/contact", "Field changed: Message → Your message (now required)", field({}), field({ label: "Your message", required: true, changed: ["label", "required"] })),
    item("navigation_changed", "changed", "behavioural", null, "Navigation changed: 'Offers' added", { links: [{ text: "Home", href: "/" }, { text: "Products", href: "/products" }] }, {
      links: [{ text: "Home", href: "/" }, { text: "Products", href: "/products" }, { text: "Offers", href: "/offers" }],
      added: [{ text: "Offers", href: "/offers" }],
      removed: [],
      renamed: [],
    }),
    item("journey_changed", "changed", "behavioural", "/", "Journey changed: Contact the company", steps("Message", "Send message"), steps("Your message", "Send")),
  ];
}

/** Scan 1 → Scan 3: a heading and prices changed (cosmetic) next to one structural item. */
export function cosmeticItems(): ChangeItem[] {
  return [
    item("page_changed", "content_values", "cosmetic", "/products/2", "Content values changed on /products/2 (1)", { group: "content_values", values: ["Price: £12.50"] }, { group: "content_values", values: ["Price: £13.00"] }, [1, 3]),
    item("page_changed", "changed", "cosmetic", "/about", "Headings changed on /about: About → About us", { headings: ["About"] }, { headings: ["About us"] }, [1, 3]),
    item("page_added", "added", "structural", "/offers", "Page added: /offers", null, { title: "Offers", http_status: 200 }, [1, 3]),
  ];
}

export function changeSet(key: string, base: ChangeScanRef, target: ChangeScanRef, items: ChangeItem[], over: Partial<ChangeSet> = {}): ChangeSet {
  const by = { structural: 0, behavioural: 0, cosmetic: 0 };
  for (const i of items) by[i.significance] += 1;
  return {
    id: `cs-${key}`,
    key,
    status: "completed",
    source: "rescan",
    base,
    target,
    summary: { total: items.length, by_significance: by, by_kind: {}, content_values: items.filter((i) => i.display_kind === "content_values").length, pages: { baseline: base.pages, target: target.pages, added: 1, removed: 1, changed: 3, not_compared: 0, structural: 2, baseline_compared: base.pages } },
    not_compared: [],
    rebaseline_suggested: false,
    generated_by: "rules",
    ai_summary: null,
    started_by: MEMBER,
    created_at: iso("15", "10:12:00"),
    finished_at: iso("15", "10:12:30"),
    error: null,
    statement: CHANGE_STATEMENT,
    permissions: { can_compare: true },
    ...over,
  };
}

const SCANS: ScanDef[] = [
  { n: 3, day: "15", rescan: true, baseline: 2, pages: 13 },
  { n: 2, day: "13", g2: true, pages: 12 },
  { n: 1, day: "12", pages: 11 },
];

/** After G2 with CHG-0001 (Scan 2 → Scan 3). `before: true` = before G2: two scans, nothing approved. */
export function newP6(over: Partial<P6State> & { before?: boolean } = {}): P6State {
  const { before, ...rest } = over;
  const scans = before ? [{ n: 2, day: "13", pages: 12 }, { n: 1, day: "12", pages: 11 }] : SCANS.map((s) => ({ ...s }));
  const items = demoItems();
  const sets = before ? [] : [changeSet("CHG-0001", scanRef(SCANS[1], 2), scanRef(SCANS[0], 2), items)];
  return { role: "owner", scans, sets, items: before ? {} : { "cs-CHG-0001": items }, g1Changed: false, compareDelay: 1, requests: [], ...rest };
}

export async function mockPhase6(page: Page, s: MockState, q: P6State) {
  const gets: Record<string, number> = {};
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = req.method();
    if (method === "OPTIONS") return route.fallback();
    let body: Record<string, unknown> = {};
    try {
      body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const record = () => q.requests.push({ method, path: `${path}${url.search}`, body });
    const member = q.role !== "viewer";
    const baselineN = q.scans.find((x) => x.g2)?.n ?? null;
    const ref = (n: number) => scanRef(q.scans.find((x) => x.n === n)!, baselineN);

    if (path === "/auth/me" && s.user) return json(route, 200, { user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: q.role, can_approve: q.role !== "viewer" });
    if (path === "/projects/p1/scans") return json(route, 200, { items: q.scans.map(summary), next_cursor: null });
    const sd = path.match(/^\/projects\/p1\/scans\/(\d+)$/);
    if (sd) {
      const d = q.scans.find((x) => x.n === Number(sd[1]));
      if (!d) return route.fallback();
      // Only the limits matter here: the rescan dialog prefills them from the compared scan.
      const detail = { ...summary(d), limits: { max_pages: 20 + d.n, max_depth: 2, include_mobile: false, respect_robots: true } } as unknown as ScanDetail;
      return json(route, 200, detail);
    }
    if (path === "/projects/p1/rescans" && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (q.g1Changed) return err(route, 409, "conflict", G1_CHANGED, [{ field: "url", message: G1_CHANGED }]);
      const base = body.compare_with ? q.scans.find((x) => `scan${x.n}` === body.compare_with)!.n : baselineN!;
      const n = Math.max(...q.scans.map((x) => x.n)) + 1;
      q.scans.unshift({ n, day: "15", rescan: true, baseline: base, status: "running", pages: 0 });
      return json(route, 202, { scan: ref(n), baseline: ref(base) });
    }
    if (path === "/projects/p1/changes" && method === "GET") return json(route, 200, { items: q.sets.map((x) => ({ ...x, permissions: { can_compare: member } })), can_compare: member });
    if (path === "/projects/p1/changes" && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const from = q.scans.find((x) => `scan${x.n}` === body.from_scan_id)!;
      const to = q.scans.find((x) => `scan${x.n}` === body.to_scan_id)!;
      if (to.n <= from.n) return err(route, 422, "validation_failed", "Choose a later scan in To.", [{ field: "to_scan_id", message: "Choose a later scan in To." }]);
      const same = q.sets.find((x) => x.status !== "failed" && x.base.number === from.n && x.target.number === to.n);
      if (same) return json(route, 200, { change_set: same, created: false });
      const key = `CHG-000${q.sets.length + 1}`;
      const items = cosmeticItems();
      const cs = changeSet(key, ref(from.n), ref(to.n), items, { status: "running", source: "compare", finished_at: null, created_at: iso("15", "11:00:00") });
      q.sets.unshift(cs);
      q.items[cs.id] = items;
      return json(route, 202, { change_set: cs, created: true });
    }
    const byKey = path.match(/^\/projects\/p1\/change-sets\/([^/]+)$/);
    if (byKey) {
      const cs = q.sets.find((x) => x.key === byKey[1]);
      if (!cs) return err(route, 404, "not_found", `We couldn't find ${byKey[1]} in this project.`);
      gets[cs.key] = (gets[cs.key] ?? 0) + 1;
      if (cs.status === "running" && gets[cs.key] > q.compareDelay) Object.assign(cs, { status: "completed", finished_at: iso("15", "11:00:20") });
      return json(route, 200, { ...cs, permissions: { can_compare: member } });
    }
    const items = path.match(/^\/change-sets\/([^/]+)\/items$/);
    if (items) {
      const list = q.items[items[1]] ?? [];
      return json(route, 200, { items: list, total: list.length });
    }
    const ev = path.match(/^\/evidence\/([^/]+)\/content$/);
    if (ev) return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "image/png" }, body: PNG });
    return route.fallback();
  });
}
