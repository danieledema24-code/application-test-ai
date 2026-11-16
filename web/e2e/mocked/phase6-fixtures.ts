// DEVELOPMENT/TEST FIXTURES ONLY. Phase 6 change-set stand-ins for the QA Analyst API (backend
// app/api/routers/changes.py), layered over ./fixtures.ts with page.route(): rescans, change sets and scan
// history are answered here, everything else falls back. CHG-0001 is the demo shop's release 2 (design P6 §14
// step 2), with the subjects the backend writes (backend/tests/integration/test_p6_changes_demo.py).

import type { Page, Route } from "@playwright/test";
import type { ScanDetail, ScanSummary } from "../../src/lib/contract";
import { CHANGE_STATEMENT, type ChangeItem, type ChangeScanRef, type ChangeSet, type DisplayKind, type ImpactCounts, type ImpactItem, type Recommendation, type RegressionPick, type Significance } from "../../src/lib/change";
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
  /** P6-02: impact items per change set id (CHG-0001 has the demo's). */
  impact: Record<string, ImpactItem[]>;
  /** The must-run scripts are outdated (the request is refused until repaired). */
  outdated: boolean;
  /** POST /regression-run answers 422 with this message even when nothing is outdated. */
  regression422: string | null;
  /** Runs requested from a recommendation, newest first. */
  runs: { id: string; key: string; status: string; include_should: boolean; created_at: string }[];
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
  const impact: Record<string, ImpactItem[]> = before ? {} : { "cs-CHG-0001": demoImpact() };
  for (const cs of sets) Object.assign(cs, impactOf(cs, impact[cs.id] ?? null, []));
  return { role: "owner", scans, sets, items: before ? {} : { "cs-CHG-0001": items }, g1Changed: false, compareDelay: 1, requests: [], impact, outdated: true, regression422: null, runs: [], ...rest };
}

// ---- P6-02 impact and the regression recommendation (design P6 §7) -----------------------------------------------

const rq = (n: string) => `rq${n}`;
const OUT_MSG = "getByLabel('Message') not found after CHG-0001";
const OUT_SEND = "getByRole('button', { name: 'Send message' }) not found after CHG-0001";
const script = (key: string, state: string, reason: string | null) => ({ id: `sc-${key}`, path: `tests/contact/${key}.spec.ts`, state, outdated_reason: reason });

function imp(id: string, over: Partial<ImpactItem> & Pick<ImpactItem, "target_kind" | "level" | "action" | "reason" | "group">): ImpactItem {
  return { id, target_ref: id, status: "open", status_reason: null, resolved_by: null, resolved_by_run: null, resolved_at: null, target: null, changes: [], page: null, can_close: ["review", "regenerate", "write_requirement"].includes(over.action), ...over };
}

/** CHG-0001's impact on the demo shop (design P6 §7.1). */
export function demoImpact(): ImpactItem[] {
  const contact = [{ id: "ci4", subject: "Button renamed: Send message → Send" }, { id: "ci7", subject: "Field changed: Message → Your message (now required)" }];
  return [
    imp("i-req7", { target_kind: "requirement", target_ref: rq("7"), level: "direct", action: "regenerate", group: "requirements", page: "/contact", changes: contact,
      reason: '2 changes on /contact: button "Send message" renamed; field "Message" changed', target: { id: "r7", key: "REQ-0007", title: "Contact form requires name, email and message" } }),
    imp("i-tc19", { target_kind: "test_case", target_ref: "l19", level: "direct", action: "rerun", group: "requirements", page: "/contact", changes: contact,
      reason: 'Directly affected: button "Send message" renamed; field "Message" changed',
      target: { id: "c19", key: "TC-0019", title: "Send the form with an empty Message", requirement_lineages: [rq("7")], script: script("TC-0019", "outdated", OUT_MSG) } }),
    imp("i-sc19", { target_kind: "automation_script", target_ref: "l19", level: "direct", action: "heal", group: "requirements", page: "/contact", changes: contact.slice(1),
      reason: "Script outdated: getByLabel('Message') no longer finds the field", target: { id: "sc-TC-0019", key: "TC-0019", title: "tests/contact/TC-0019.spec.ts", path: "tests/contact/TC-0019.spec.ts", state: "outdated", outdated_reason: OUT_MSG, heal_suggestions: [] } }),
    imp("i-tc20", { target_kind: "test_case", target_ref: "l20", level: "direct", action: "rerun", group: "requirements", page: "/contact", changes: contact.slice(0, 1),
      reason: 'Directly affected: button "Send message" renamed',
      target: { id: "c20", key: "TC-0020", title: "Send the form with a 1-character Name", requirement_lineages: [rq("7")], script: script("TC-0020", "outdated", OUT_SEND) } }),
    imp("i-sc20", { target_kind: "automation_script", target_ref: "l20", level: "direct", action: "heal", group: "requirements", page: "/contact", changes: contact.slice(0, 1),
      reason: "Script outdated: the Send message button was renamed", target: { id: "sc-TC-0020", key: "TC-0020", title: "tests/contact/TC-0020.spec.ts", path: "tests/contact/TC-0020.spec.ts", state: "outdated", outdated_reason: OUT_SEND, heal_suggestions: [{ id: "h1", key: "HEAL-0001", status: "open" }] } }),
    imp("i-req2", { target_kind: "requirement", target_ref: rq("2"), level: "indirect", action: "regenerate", group: "requirements", reason: "1 change: navigation changed",
      target: { id: "r2", key: "REQ-0002", title: "Visitors can move between pages from the menu" } }),
    imp("i-tc02", { target_kind: "test_case", target_ref: "l02", level: "indirect", action: "rerun", group: "requirements", reason: "Indirectly affected: navigation changed",
      target: { id: "c02", key: "TC-0002", title: "Move to Products from the menu", requirement_lineages: [rq("2")], script: { id: "sc-TC-0002", path: "tests/nav/TC-0002.spec.ts", state: "valid", outdated_reason: null } } }),
    imp("i-def1", { target_kind: "defect", target_ref: "d1", level: "direct", action: "rerun", group: "defects", page: "/contact", reason: "May be fixed or changed by CHG-0001: re-test. Re-tested by TC-0019.",
      target: { id: "d1", key: "DEF-0001", title: "Contact form accepts an empty Message", severity: "major", status: "confirmed" } }),
    imp("i-tc12", { target_kind: "test_case", target_ref: "l12", level: "direct", action: "review", group: "page_removed", page: "/products/1", reason: "Page removed: /products/1. Review or retire TC-0012",
      target: { id: "c12", key: "TC-0012", title: "View the Travel mug page", requirement_lineages: [], script: null } }),
    imp("i-a11y", { target_kind: "quality_finding", target_ref: "f1", level: "direct", action: "review", group: "page_removed", page: "/products/1", reason: "Page removed: /products/1. Check whether the finding still applies",
      target: { id: "f1", key: "A11Y-0001-01", title: "Images must have a text alternative", severity: "serious", kind: "accessibility", status: "open" } }),
    imp("i-prf", { target_kind: "performance_target", target_ref: "p1", level: "direct", action: "review", group: "page_removed", page: "/products/1", reason: "Page removed: /products/1 is a target of PRF-01 (profile marked out of date)",
      target: { id: "p1", key: "PRF-01", title: "Browse", status: "stale" } }),
    imp("i-gap1", { target_kind: "coverage_gap", target_ref: "ci1", level: "gap", action: "write_requirement", group: "gaps", page: "/offers", reason: "Not covered by any requirement: page /offers added",
      target: { id: "ci1", key: null, title: "/offers · page added", kind: "page_added" } }),
    imp("i-gap2", { target_kind: "coverage_gap", target_ref: "ci5", level: "gap", action: "write_requirement", group: "gaps", page: "/offers", reason: 'Not covered by any requirement: form "Promo code" added on /offers',
      target: { id: "ci5", key: null, title: "Promo code form on /offers · form added", kind: "form_added" } }),
  ];
}

function counts(items: ImpactItem[], must: number, should: number): ImpactCounts {
  const n = (f: (i: ImpactItem) => boolean) => items.filter(f).length;
  return {
    total: items.length,
    open: n((i) => i.status === "open"),
    requirements: n((i) => i.target_kind === "requirement"),
    test_cases: n((i) => i.target_kind === "test_case"),
    scripts_outdated: n((i) => i.action === "heal"),
    defects: n((i) => i.target_kind === "defect"),
    review: n((i) => i.action === "review"),
    gaps: n((i) => i.action === "write_requirement"),
    must,
    should,
    by_level: { direct: n((i) => i.level === "direct"), indirect: n((i) => i.level === "indirect"), gap: n((i) => i.level === "gap") },
    by_status: { open: n((i) => i.status === "open"), resolved: n((i) => i.status === "resolved"), no_action: n((i) => i.status === "no_action") },
  };
}

function impactOf(cs: ChangeSet, items: ImpactItem[] | null, runs: P6State["runs"]): Pick<ChangeSet, "impact" | "regression"> {
  if (!items) return { impact: null, regression: null };
  const r = runs[0];
  return { impact: counts(items, 2, 3), regression: { must: 2, should: 3, requested_run: r ? { id: r.id, key: r.key, status: r.status } : null } };
}

function pick(key: string, title: string, reasons: string[], sc: RegressionPick["script"], why: string | null = null): RegressionPick {
  return { case_lineage_id: `l${key.slice(-2)}`, key, title, reasons, test_case_id: `c${key.slice(-2)}`, script: sc, runnable: !why, not_runnable_reason: why };
}

/** CHG-0001's recommendation (design P6 §7.4), with the must-run scripts outdated or repaired. */
export function demoRecommendation(q: Pick<P6State, "outdated" | "runs" | "role">, cs: ChangeSet): Recommendation {
  const out = q.outdated;
  const contact = (key: string, reason: string) => ({ ...script(key, out ? "outdated" : "valid", out ? reason : null), heal_suggestions: key === "TC-0020" ? [{ id: "h1", key: "HEAL-0001", status: "open" }] : [] });
  const valid = (key: string, path: string) => ({ id: `sc-${key}`, path, state: "valid", outdated_reason: null, heal_suggestions: [] });
  const must = [
    pick("TC-0019", "Send the form with an empty Message", ['Directly affected: button "Send message" renamed; field "Message" changed', "Re-tests DEF-0001"], contact("TC-0019", OUT_MSG), out ? "Script outdated: accept or reject its repair first" : null),
    pick("TC-0020", "Send the form with a 1-character Name", ['Directly affected: button "Send message" renamed'], contact("TC-0020", OUT_SEND), out ? "Script outdated: accept or reject its repair first" : null),
  ];
  const should = [
    pick("TC-0002", "Move to Products from the menu", ["Indirectly affected: navigation changed"], valid("TC-0002", "tests/nav/TC-0002.spec.ts")),
    pick("TC-0030", "Product list shows prices", ["Linked to high risk RISK-03 (Wrong prices)"], valid("TC-0030", "tests/products/TC-0030.spec.ts")),
    pick("TC-0001", "Home page loads", ["Smoke test"], valid("TC-0001", "tests/home/TC-0001.spec.ts")),
  ];
  const excluded = [
    pick("TC-0012", "View the Travel mug page", ["Page removed: review or retire the case"], null, "Page removed: review or retire the case"),
    pick("TC-0031", "Sign in with the saved test account", ["Manual test: a person runs it"], null, "Manual test: a person runs it"),
  ];
  return {
    change_set: { id: cs.id, key: cs.key },
    permissions: { can_request: q.role !== "viewer" },
    available: true,
    reason: null,
    order: "rules",
    explanation: null,
    must,
    should,
    excluded,
    estimate: { must_seconds: 50, with_should_seconds: 170, must_tests: 2, with_should_tests: 5, from_run_key: "RUN-0003" },
    blocked: out ? { outdated: 2, message: "2 must-run tests have outdated scripts. Accept or reject their repair suggestions first.", case_keys: ["TC-0019", "TC-0020"] } : null,
    requested_runs: q.runs,
  };
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
      return json(route, 200, { ...cs, ...impactOf(cs, q.impact[cs.id] ?? null, q.runs), permissions: { can_compare: member } });
    }
    const impactPath = path.match(/^\/change-sets\/([^/]+)\/impact$/);
    if (impactPath) {
      const cs = q.sets.find((x) => x.id === impactPath[1])!;
      const list = q.impact[cs.id];
      const base = { change_set: { id: cs.id, key: cs.key }, generated_by: "rules", permissions: { can_close: member } };
      if (!list) return json(route, 200, { ...base, available: false, reason: "Impact is worked out when a rescan is compared with its baseline. This comparison lists changes only.", items: [], counts: null });
      return json(route, 200, { ...base, available: true, reason: null, items: list.map((i) => ({ ...i, can_close: member && i.can_close && i.status === "open" })), counts: counts(list, 2, 3) });
    }
    const close = path.match(/^\/impact-items\/([^/]+)$/);
    if (close && method === "PATCH") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const cs = Object.keys(q.impact).find((k) => q.impact[k].some((i) => i.id === close[1]))!;
      const it = q.impact[cs].find((i) => i.id === close[1])!;
      if (it.action === "rerun" || it.action === "heal") return err(route, 422, "validation_error", "Re-run and repair items close by themselves.");
      if (it.status !== "open") return err(route, 409, "conflict", "Already closed.");
      const reason = String(body.reason ?? "").trim();
      if (body.status === "no_action" && !reason) return err(route, 422, "validation_error", "Say why no action is needed.", [{ field: "reason", message: "Say why no action is needed." }]);
      Object.assign(it, { status: body.status, status_reason: reason || null, resolved_by: MEMBER, resolved_at: iso("15", "15:40:00"), can_close: false });
      const label = it.target?.key ?? (it.level === "gap" ? "Gap" : "Impact");
      return json(route, 200, { item: it, counts: counts(q.impact[cs], 2, 3), message: `${label} impact item closed.` });
    }
    const recPath = path.match(/^\/change-sets\/([^/]+)\/regression-recommendation$/);
    if (recPath) {
      const cs = q.sets.find((x) => x.id === recPath[1])!;
      if (!q.impact[cs.id]) return json(route, 200, { change_set: { id: cs.id, key: cs.key }, permissions: { can_request: member }, available: false, reason: "Impact is worked out when a rescan is compared with its baseline. This comparison lists changes only." });
      return json(route, 200, demoRecommendation(q, cs));
    }
    const runPath = path.match(/^\/change-sets\/([^/]+)\/regression-run$/);
    if (runPath && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (q.outdated) return err(route, 422, "validation_error", "2 must-run tests have outdated scripts. Accept or reject their repair suggestions first. TC-0019 (tests/contact/TC-0019.spec.ts: repair suggestion not ready yet), TC-0020 (tests/contact/TC-0020.spec.ts: HEAL-0001).");
      if (q.regression422) return err(route, 422, "validation_error", q.regression422);
      const key = `RUN-000${5 + q.runs.length}`;
      const run = { id: `run-${key}`, key, status: "awaiting_authorisation", include_should: !!body.include_should, created_at: iso("15", "15:00:00") };
      q.runs.unshift(run);
      return json(route, 201, { ...run, mode: "standard", totals: {}, selection: { change_set_id: runPath[1] } });
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
