// DEVELOPMENT/TEST FIXTURES ONLY. Phase 5 non-functional stand-ins for the QA Analyst API (backend
// app/api/routers/nonfunctional.py and the load_test branch of POST /approvals/{id}/decision), layered over
// ./fixtures.ts and the phase 2–4 fixtures with page.route(): non-functional paths are answered here, everything
// else falls back. Data follows the design's demo thread (docs/design/P5-qa-analyst-phase5.md §16).

import type { Page, Route } from "@playwright/test";
import type { StageKey, Workflow } from "../../src/lib/contract";
import type { Finding, LoadRun, Overview, Profile, Scan, SecurityRuleRow, ThresholdResult } from "../../src/lib/nonfunctional";
import { API } from "./fixtures";
import { p4Workflow, type P4State } from "./phase4-fixtures";

const NOW = "2026-11-13T14:20:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string) => json(route, status, { error: { code, message, details: null } });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

const MEMBER = { id: "m", full_name: "M. Member" };
const ME = { id: "u", full_name: "Daniele Edema" };
const LIMITS = { organisation: { vus: 20, rps: 20, duration_s: 300 }, server: { vus: 50, rps: 50, duration_s: 600 }, max_targets: 10 };
const SUMMARY = "Up to 10 virtual users, at most 20 requests a second, for 2 minutes 10 seconds, against localhost:4100; GET only; not signed in.";
const WHAT = [
  "GET requests only: no forms, no sign-in, no data changes.",
  "Load comes from this platform's computer, not from your users' locations.",
  "Stops by itself if the site looks overwhelmed: over 20 % errors, responses slower than 10 s, or no successful response for 5 s.",
  "Real visitors may notice the site is slower while it runs. Use a test or staging copy if you can.",
];
export const SEC_STATEMENT =
  "This is a passive check of what a normal visitor's browser receives. It is not a security audit or a penetration test, and no findings does not mean the site is secure.";
export const A11Y_STATEMENT = "Automated checks find only part of WCAG 2.2 AA issues. Screen reader, zoom and cognitive checks need a person.";

export type P5State = {
  role: "owner" | "admin" | "member" | "viewer";
  canApprove: boolean;
  g2: boolean;
  g4: boolean;
  credentials: boolean;
  scans: Scan[];
  findings: Finding[];
  profiles: Profile[];
  runs: LoadRun[];
  requests: { method: string; path: string; body: unknown }[];
};

const PAGES = ["/", "/products", "/products/1", "/products/2", "/about", "/contact"];

function a11yScan(over: Partial<Scan> = {}): Scan {
  return {
    id: "scan-a1",
    key: "A11Y-0001",
    kind: "accessibility",
    status: "completed",
    status_label: "Finished",
    pages: 6,
    viewports: ["desktop"],
    keyboard: true,
    signed_in: false,
    summary: {
      visited: 6,
      total: 6,
      progress: PAGES.map((p) => ({ url: `http://localhost:4100${p}`, path: p, viewport: "desktop", state: "done", reason: null, problems: p.startsWith("/products/") ? 2 : 0 })),
      drafted: ["DEF-0004", "DEF-0005"],
      occurrences_added: [],
      pages_checked: 6,
      pages_not_checked: 0,
      rules_failed: 2,
      pages_with_problems: 2,
      by_severity: { critical: 1, serious: 1, moderate: 0, minor: 0 },
      needs_review: 1,
      keyboard: [
        { url: "http://localhost:4100/", path: "/", viewport: "desktop", focusable: 9, tabbable: 9, trap: false, not_visible: 0, not_reachable: 0, completed: true, order: [{ n: 1, role: "Link", label: "Home" }, { n: 2, role: "Link", label: "Products" }] },
        { url: "http://localhost:4100/contact", path: "/contact", viewport: "desktop", focusable: 7, tabbable: 7, trap: false, not_visible: 1, not_reachable: 0, completed: true, order: [{ n: 1, role: "Link", label: "Home" }, { n: 2, role: "Button", label: "Send message" }] },
      ],
      keyboard_findings: 1,
      elements: 4,
    },
    not_checked: [],
    tool_versions: { axe: "4.14.0", chromium: "131.0" },
    requested_by: MEMBER,
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    error: null,
    cancel_requested: false,
    statement: A11Y_STATEMENT,
    open_findings: 5,
    page_list: PAGES.map((p) => ({ url: `http://localhost:4100${p}`, path: p, page_id: `pg${p}`, requires_auth: false })),
    defects: [
      { key: "DEF-0004", summary: "Product images have no text alternative (2 pages)", status: "draft" },
      { key: "DEF-0005", summary: "Text has too little contrast (2 pages)", status: "draft" },
    ],
    ...over,
  };
}

function finding(key: string, over: Partial<Finding>): Finding {
  return {
    id: `f-${key}`,
    key,
    scan_id: "scan-a1",
    scan_key: key.split("-").slice(0, 2).join("-"),
    kind: "accessibility",
    rule_id: "image-alt",
    severity: "critical",
    title: "Images must have alternative text",
    url: "http://localhost:4100/products/2",
    path: "/products/2",
    page_id: "pg/products/2",
    viewport: "desktop",
    nodes: [{ target: "img.product-image", html: '<img class="product-image" src="data:image/svg+xml,…">', summary: "Fix any of the following: Element does not have an alt attribute" }],
    references: [{ type: "wcag", criterion: "1.1.1", name: "Non-text Content", level: "A" }, { type: "help", url: "https://dequeuniversity.com/rules/axe/4.14/image-alt", source: "axe-core" }],
    status: "open",
    status_reason: null,
    status_by: null,
    seen_before: null,
    reopened: false,
    details: { how_to_fix: "Images must have alternative text" },
    heuristic: false,
    needs_review: false,
    best_practice: false,
    mapped: { features: [], requirements: [{ key: "REQ-0009", title: "Product images have a text alternative" }], test_cases: [] },
    defect: { id: "def-0004", key: "DEF-0004", status: "draft", summary: "Product images have no text alternative (2 pages)" },
    evidence: [{ evidence_id: "ev-shot", kind: "screenshot", outlined: ["img.product-image"] }],
    created_at: NOW,
    ...over,
  };
}

function a11yFindings(): Finding[] {
  const contrast = { rule_id: "color-contrast", severity: "serious" as const, title: "Elements must meet minimum color contrast ratio thresholds", references: [{ type: "wcag", criterion: "1.4.3", name: "Contrast (Minimum)", level: "AA" }], defect: { id: "def-0005", key: "DEF-0005", status: "draft", summary: "Text has too little contrast (2 pages)" }, nodes: [{ target: "p.price", html: '<p class="price">€19</p>', summary: "Contrast 3.1:1" }] };
  return [
    finding("A11Y-0001-01", {}),
    finding("A11Y-0001-02", { url: "http://localhost:4100/products/1", path: "/products/1" }),
    finding("A11Y-0001-03", { ...contrast, url: "http://localhost:4100/products/1", path: "/products/1" }),
    finding("A11Y-0001-04", { ...contrast }),
    finding("A11Y-0001-05", { rule_id: "focus-not-visible", severity: "serious", title: "Focus not visible", url: "http://localhost:4100/contact", path: "/contact", heuristic: true, defect: null, references: [{ type: "wcag", criterion: "2.4.7", name: "Focus Visible", level: "AA" }], nodes: [{ target: "a#plain", html: "", summary: "Plain link" }], details: { heuristic: true }, evidence: [] }),
    finding("A11Y-0001-06", { rule_id: "region", severity: "minor", title: "All page content should be contained by landmarks", needs_review: true, defect: null, references: [], evidence: [] }),
  ];
}

const RULE = (rule_id: string, title: string, category: SecurityRuleRow["category"], severity: SecurityRuleRow["severity"], result: SecurityRuleRow["result"], over: Partial<SecurityRuleRow> = {}): SecurityRuleRow => ({
  rule_id,
  subject: "",
  category,
  title,
  severity,
  result,
  reason: "",
  pages: [],
  page_count: 0,
  observed: "",
  reference: { name: "OWASP Secure Headers Project", url: "https://owasp.org/www-project-secure-headers/" },
  ...over,
});
const LOOP = "The target is plain http on this computer (loopback)";
const ALL = PAGES.map((p) => `http://localhost:4100${p}`);

function secScan(): Scan {
  const rules: SecurityRuleRow[] = [
    RULE("https", "Pages served over HTTPS", "transport", "high", "not_applicable", { reason: LOOP }),
    RULE("http-redirect", "HTTP redirects to HTTPS", "transport", "medium", "not_applicable", { reason: LOOP }),
    RULE("hsts", "HSTS", "transport", "medium", "not_applicable", { reason: LOOP }),
    RULE("csp-missing", "Content-Security-Policy missing", "headers", "medium", "failed", { pages: ALL, page_count: 6, observed: "Content-Security-Policy: (not sent)" }),
    RULE("clickjacking", "No clickjacking protection", "headers", "medium", "failed", { pages: ALL, page_count: 6 }),
    RULE("nosniff", "X-Content-Type-Options: nosniff missing", "headers", "low", "failed", { pages: ALL, page_count: 6 }),
    RULE("cors-credentials", "CORS doesn't allow any site with credentials", "headers", "high", "passed"),
    RULE("cookie-samesite", "Cookie without SameSite: recently_viewed", "cookies", "low", "failed", { subject: "recently_viewed", pages: ALL.slice(0, 2), page_count: 2, observed: "recently_viewed · Path=/ · no HttpOnly · no Secure · no SameSite" }),
    RULE("cookie-httponly", "Session cookies are HttpOnly", "cookies", "medium", "passed", { reason: "No session-like cookie was set" }),
    RULE("mixed-content", "No mixed content", "content", "medium", "not_applicable", { reason: "The pages themselves are plain http" }),
  ];
  return {
    ...a11yScan(),
    id: "scan-s1",
    key: "SEC-0001",
    kind: "security",
    keyboard: false,
    statement: SEC_STATEMENT,
    open_findings: 4,
    defects: [],
    summary: { visited: 6, total: 6, pages_checked: 6, pages_not_checked: 0, drafted: [], rules, counts: { failed: 4, passed: 2, not_applicable: 4, not_checked: 0 } },
  };
}

function secFindings(): Finding[] {
  const base = { scan_id: "scan-s1", kind: "security" as const, viewport: null, nodes: [], references: [], defect: null, evidence: [] };
  return [
    finding("SEC-0001-01", { ...base, rule_id: "csp-missing", severity: "medium", title: "Content-Security-Policy missing", url: ALL[0], path: "/", details: { observed: "Content-Security-Policy: (not sent)", why: "Without a policy, a script injected into a page can run and steal what visitors type.", fix: "Send a Content-Security-Policy header." } }),
    finding("SEC-0001-02", { ...base, rule_id: "clickjacking", severity: "medium", title: "No clickjacking protection", url: ALL[0], path: "/", details: { observed: "X-Frame-Options: (not sent)" } }),
    finding("SEC-0001-03", { ...base, rule_id: "nosniff", severity: "low", title: "X-Content-Type-Options: nosniff missing", url: ALL[0], path: "/", details: { observed: "X-Content-Type-Options: (not sent)" } }),
    finding("SEC-0001-04", { ...base, rule_id: "cookie-samesite", severity: "low", title: "Cookie without SameSite: recently_viewed", url: ALL[0], path: "/", details: { subject: "recently_viewed", observed: "recently_viewed · Path=/ · no HttpOnly · no Secure · no SameSite" } }),
  ];
}

const TH = (over: Partial<ThresholdResult>): ThresholdResult => ({ metric: "p95", scope: "path", path: "/", op: "<", value: 800, source: { type: "default" }, measured: null, result: "not_measured", ...over });

export function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "prf-1",
    key: "PRF-01",
    name: "Load test of public pages",
    type: "load",
    type_label: "Load (steady traffic)",
    status: "ready",
    stale_reason: null,
    version: 2,
    versions: [2, 1],
    generated_by: "rules",
    rationale: null,
    stages: [
      { duration_s: 30, target_vus: 10 },
      { duration_s: 90, target_vus: 10 },
      { duration_s: 10, target_vus: 0 },
    ],
    max_rps: 20,
    think_time_ms: { min: 500, max: 1500 },
    targets: [
      { path: "/", weight: 3, why: "Start page" },
      { path: "/products", weight: 2, why: "Listing page" },
      { path: "/products/2", weight: 1, why: "" },
    ],
    thresholds: [
      { metric: "p95", scope: "path", path: "/", op: "<", value: 800, source: { type: "default" } },
      { metric: "p95", scope: "path", path: "/products", op: "<", value: 800, source: { type: "default" } },
      { metric: "p95", scope: "path", path: "/products/2", op: "<", value: 2000, source: { type: "requirement", key: "REQ-0012" } },
      { metric: "error_rate", scope: "all", op: "<", value: 0.01, source: { type: "default" } },
    ],
    totals: { vus: 10, rps: 20, duration_s: 130, targets: 3 },
    violations: [],
    request_preview: { summary: SUMMARY, expected_requests_text: "2,100", host: "localhost", netloc: "localhost:4100", what_it_does: WHAT },
    created_by: MEMBER,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

export function loadRun(over: Partial<LoadRun> & Pick<LoadRun, "key" | "status">): LoadRun {
  const series = Array.from({ length: 30 }, (_, i) => ({ t: i + 1, users: Math.min(10, i + 1), rps: 15 + (i % 3), errors: 0, p95_ms: 200 + i * 40 }));
  return {
    id: `run-${over.key}`,
    status_label: over.status,
    profile: { id: "prf-1", key: "PRF-01", version: 2, name: "Load test of public pages", type: "load" },
    summary: SUMMARY,
    expected_requests: 2086,
    expected_requests_text: "2,100",
    limits: { test: { vus: 10, rps: 20, duration_s: 130 }, organisation: LIMITS.organisation, server: LIMITS.server },
    target_host: "localhost",
    netloc: "localhost:4100",
    requested_by: MEMBER,
    stopped_by: null,
    note: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    elapsed_s: 130,
    planned_s: 130,
    engine: { name: "ata-loadgen", version: "0.5.0" },
    aborted_reason: null,
    error: null,
    threshold_results: [],
    live: null,
    stop_requested: false,
    problem: null,
    approval: { id: `apr-${over.key}`, key: "APR-0004", status: "used", expires_at: NOW, decided_by: { id: "a", full_name: "A. Approver" }, decided_at: NOW, comment: null, host_typed: true, confirm_prompt: "Type localhost to approve" },
    permissions: { can_approve: false, can_stop: false, can_withdraw: false, can_request_again: true },
    statement: "Measured with the built-in load generator 0.5.0. Load is generated from the platform host, not from your users' locations.",
    what_it_does: WHAT,
    profile_snapshot: { targets: [{ path: "/", weight: 3, title: "Home · Demo" }, { path: "/products/2", weight: 1, title: "Desk lamp · Demo Shop" }], stages: [], max_rps: 20, think_time_ms: { min: 500, max: 1500 }, thresholds: [] },
    result: {
      overall: { count: 2086, error_rate: 0, latency_ms: { p95: 900 } },
      targets: [
        { path: "/", count: 900, rps: 6.9, error_rate: 0, latency_ms: { p50: 40, p90: 55, p95: 62, p99: 80, max: 120 }, status_codes: { "200": 900 } },
        { path: "/products/2", count: 298, rps: 2.3, error_rate: 0, latency_ms: { p50: 610, p90: 1200, p95: 1400, p99: 1600, max: 1700 }, status_codes: { "200": 298 } },
      ],
    },
    timeseries: series,
    previous: null,
    defects: [],
    ...over,
  };
}

export function failedRun(): LoadRun {
  return loadRun({
    key: "PERF-0001",
    status: "failed",
    threshold_results: [TH({ path: "/products/2", measured: 1400, result: "missed" }), TH({ path: "/", measured: 62, result: "met" }), TH({ metric: "error_rate", scope: "all", path: undefined, value: 0.01, measured: 0, result: "met" })],
    defects: [{ key: "DEF-0006", summary: "Desk lamp page slows down under load (p95 1.4 s with 10 users; threshold 800 ms)", status: "draft" }],
  });
}

export function waitingRun(over: Partial<LoadRun> = {}): LoadRun {
  return loadRun({
    key: "PERF-0002",
    status: "awaiting_approval",
    status_label: "Waiting for approval",
    started_at: null,
    finished_at: null,
    elapsed_s: null,
    timeseries: [],
    result: {},
    approval: { id: "apr-PERF-0002", key: "APR-0005", status: "pending", expires_at: "2026-11-14T14:20:00Z", decided_by: null, decided_at: null, comment: null, host_typed: false, confirm_prompt: "Type localhost to approve" },
    permissions: { can_approve: true, can_stop: false, can_withdraw: false, can_request_again: true },
    ...over,
  });
}

export function runningRun(): LoadRun {
  return loadRun({
    key: "PERF-0003",
    status: "running",
    status_label: "Running",
    finished_at: null,
    elapsed_s: 65,
    live: { t: 65, users: 10, rps: 18.4, p95_ms: 420, errors: 0, requests: 18 },
    timeseries: [],
    result: {},
    permissions: { can_approve: false, can_stop: true, can_withdraw: false, can_request_again: false },
  });
}

export function abortedRun(): LoadRun {
  return loadRun({
    key: "PERF-0004",
    status: "aborted",
    status_label: "Stopped automatically",
    aborted_reason: "Stopped automatically: 100 % errors over 10 s",
    threshold_results: [TH({ path: "/", measured: 30 }), TH({ metric: "error_rate", scope: "all", path: undefined, value: 0.01, measured: 1 })],
  });
}

export function newP5(over: Partial<P5State> = {}): P5State {
  return { role: "owner", canApprove: true, g2: true, g4: true, credentials: false, scans: [a11yScan(), secScan()], findings: [...a11yFindings(), ...secFindings()], profiles: [profile()], runs: [failedRun()], requests: [], ...over };
}

function overview(q: P5State): Overview {
  const latest = (k: "accessibility" | "security") => q.scans.filter((s) => s.kind === k)[0] ?? null;
  const member = q.role !== "viewer";
  const runs = q.runs;
  return {
    gates: { g2: q.g2, g4: q.g4 },
    stages: {},
    accessibility: q.g2 ? latest("accessibility") : null,
    security: q.g2 ? latest("security") : null,
    performance: {
      latest: runs.find((r) => r.status !== "awaiting_approval") ?? null,
      waiting: runs.filter((r) => r.status === "awaiting_approval").map((r) => r.key),
      running: runs.find((r) => r.status === "running" || r.status === "queued")?.key ?? null,
    },
    pages: { public: 6, signed_in: 2 },
    credentials_saved: q.credentials,
    limits: LIMITS,
    tools: { axe: "4.14.0", loadgen: "0.5.0", browser: true },
    statements: { security: SEC_STATEMENT, accessibility: A11Y_STATEMENT, performance: "Load is generated from the platform host, not from your users' locations." },
    permissions: { can_start: member, can_approve: member && q.canApprove, can_admin_limits: q.role === "owner" || q.role === "admin" },
  };
}

function withPerms(q: P5State, r: LoadRun): LoadRun {
  const approver = q.role !== "viewer" && q.canApprove;
  return { ...r, permissions: { ...r.permissions, can_approve: approver && r.status === "awaiting_approval" && !r.problem, can_withdraw: r.status === "awaiting_approval" && r.requested_by?.id === ME.id } };
}

export async function mockPhase5(page: Page, q: P5State, p4: P4State) {
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
    const approver = member && q.canApprove;

    if (path === "/projects/p1/workflow") {
      const wf: Workflow = p4Workflow(p4);
      wf.stages = wf.stages.filter((s) => !["performance", "release_readiness"].includes(s.key));
      const extra = (key: StageKey, phase: number, available: boolean) => ({ ...wf.stages[0], key, title: key, phase, available, status: "not_started" as const, current_version: null, gate: null, finished_at: null });
      wf.stages.push(extra("release_readiness", 6, false), extra("performance", 5, q.g4), extra("accessibility", 5, q.g2), extra("security_assessment", 5, q.g2));
      return json(route, 200, wf);
    }
    if (path === "/projects/p1/non-functional") return json(route, 200, overview(q));

    // ---- checks
    if ((path === "/projects/p1/accessibility-scans" || path === "/projects/p1/security-assessments") && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      const a11y = path.endsWith("accessibility-scans");
      const scan: Scan = { ...(a11y ? a11yScan() : secScan()), id: a11y ? "scan-a2" : "scan-s2", key: a11y ? "A11Y-0002" : "SEC-0002", status: "running", status_label: "Checking 1 of 6 pages", summary: { visited: 0, total: 6, progress: [] }, defects: [] };
      q.scans.unshift(scan);
      return json(route, 201, scan);
    }
    const byKey = path.match(/^\/projects\/p1\/quality-scans\/by-key\/([^/]+)$/);
    if (byKey) {
      const s = q.scans.find((x) => x.key === byKey[1]);
      return s ? json(route, 200, s) : err(route, 404, "not_found", `We couldn't find ${byKey[1]} in this project.`);
    }
    const fl = path.match(/^\/quality-scans\/([^/]+)\/findings$/);
    if (fl) {
      const rule = url.searchParams.get("rule");
      return json(route, 200, { items: q.findings.filter((f) => f.scan_id === fl[1] && (!rule || f.rule_id === rule)) });
    }
    const cancel = path.match(/^\/quality-scans\/([^/]+)\/cancel$/);
    if (cancel && method === "POST") {
      record();
      const s = q.scans.find((x) => x.id === cancel[1])!;
      Object.assign(s, { status: "cancelled", status_label: "Cancelled" });
      return json(route, 200, { message: `${s.key} cancelled.` });
    }
    const tri = path.match(/^\/quality-findings\/([^/]+)\/triage$/);
    if (tri && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (!String(body.reason ?? "").trim()) return err(route, 422, "validation_failed", "Say why. The reason is shown in reports.");
      const f = q.findings.find((x) => x.id === tri[1])!;
      Object.assign(f, { status: body.status, status_reason: body.reason, status_by: ME });
      const word = body.status === "accepted_risk" ? "marked as accepted risk" : body.status === "false_positive" ? "marked as false positive" : "reopened";
      return json(route, 200, { message: `${f.key} ${word}.`, finding: f });
    }
    const raise = path.match(/^\/quality-findings\/([^/]+)\/raise-defect$/);
    if (raise && method === "POST") {
      record();
      const f = q.findings.find((x) => x.id === raise[1])!;
      const d = { id: "def-0007", key: "DEF-0007", status: "draft", summary: "Pages don't send a Content-Security-Policy (6 pages)" };
      for (const x of q.findings.filter((y) => y.rule_id === f.rule_id && y.scan_id === f.scan_id)) x.defect = d;
      return json(route, 201, { defect: d });
    }
    if (path === "/evidence/ev-shot") return json(route, 200, { id: "ev-shot", kind: "screenshot", mime: "image/png", size: 70, captured_at: NOW, content_url: `${API}/evidence/ev-shot/content?exp=1&sig=x`, sha256: "0", metadata: {} });
    if (path === "/evidence/ev-shot/content") return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "image/png" }, body: PNG });

    // ---- profiles
    if (path === "/projects/p1/performance-profiles" && method === "GET") {
      if (!q.g4) return err(route, 409, "gate_blocked", "Load profiles use the approved Test Strategy. Approve Gate 4 first.");
      return json(route, 200, { items: q.profiles, permissions: { can_edit: member, can_request: member, can_approve: approver } });
    }
    if (path === "/projects/p1/performance-profiles" && method === "POST") {
      record();
      const p = profile({ id: "prf-2", key: "PRF-02", status: "draft", version: 1, versions: [1] });
      q.profiles.push(p);
      return json(route, 201, p);
    }
    if (path === "/projects/p1/performance-profiles/eligible-pages")
      return json(route, 200, {
        items: [
          { page_id: "pg/about", path: "/about", title: "About", reason: null },
          { page_id: "pg/account", path: "/account", title: "Account", reason: "needs sign-in" },
          { page_id: "pg/logout", path: "/logout", title: "Logout", reason: "looks like a logout, delete or download link" },
        ],
      });
    const pk = path.match(/^\/projects\/p1\/performance-profiles\/by-key\/([^/]+)$/);
    if (pk) {
      const p = q.profiles.find((x) => x.key === pk[1]);
      if (!p) return err(route, 404, "not_found", `We couldn't find ${pk[1]} in this project.`);
      return json(route, 200, { ...p, limits: LIMITS, permissions: { can_edit: member, can_request: member, can_approve: approver, can_admin_limits: q.role === "owner" || q.role === "admin" } });
    }
    const pp = path.match(/^\/performance-profiles\/([^/]+)$/);
    if (pp && method === "PATCH") {
      record();
      const p = q.profiles.find((x) => x.id === pp[1])!;
      const stages = (body.stages as Profile["stages"]) ?? p.stages;
      const vus = Math.max(...stages.map((s) => s.target_vus));
      if (vus > LIMITS.organisation.vus) return err(route, 422, "validation_failed", `Your organisation allows up to ${LIMITS.organisation.vus} virtual users.`);
      Object.assign(p, body, { version: p.version + 1, versions: [p.version + 1, ...p.versions] });
      return json(route, 200, { ...p, message: `${p.key} version ${p.version} saved.` });
    }
    const pa = path.match(/^\/performance-profiles\/([^/]+)\/(ready|retire)$/);
    if (pa && method === "POST") {
      record();
      const p = q.profiles.find((x) => x.id === pa[1])!;
      p.status = pa[2] === "ready" ? "ready" : "retired";
      return json(route, 200, p);
    }
    if (/k6-script$/.test(path)) return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/javascript", "X-Not-Run-By-Platform": "true" }, body: "// Not run by the platform\nexport default function () {}\n" });

    // ---- load tests
    if (path === "/projects/p1/performance-runs" && method === "GET") return json(route, 200, { items: q.runs.map((r) => withPerms(q, r)), permissions: { can_request: member, can_approve: approver } });
    if (path === "/projects/p1/performance-runs" && method === "POST") {
      record();
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (body.approve && !approver) return err(route, 403, "forbidden", "Approving load tests needs approval permission");
      if (body.approve && String(body.confirm_text ?? "").trim().toLowerCase() !== "localhost") return err(route, 422, "validation_failed", "Type localhost exactly to approve.");
      const r = body.approve
        ? loadRun({ key: "PERF-0005", status: "queued", status_label: "Waiting to start", requested_by: ME, timeseries: [], result: {}, finished_at: null, elapsed_s: null })
        : waitingRun({ key: "PERF-0005", requested_by: ME, note: (body.note as string) ?? null, approval: { ...waitingRun().approval!, id: "apr-PERF-0005" } });
      q.runs.unshift(r);
      return json(route, 201, withPerms(q, r));
    }
    const rk = path.match(/^\/projects\/p1\/performance-runs\/by-key\/([^/]+)$/);
    if (rk) {
      const r = q.runs.find((x) => x.key === rk[1]);
      return r ? json(route, 200, withPerms(q, r)) : err(route, 404, "not_found", `We couldn't find ${rk[1]} in this project.`);
    }
    const dec = path.match(/^\/approvals\/([^/]+)\/decision$/);
    if (dec && method === "POST") {
      record();
      const r = q.runs.find((x) => x.approval?.id === dec[1]);
      if (!r) return route.fallback();
      if (!approver) return err(route, 403, "forbidden", "Approving load tests needs approval permission");
      if (body.decision === "approve" && String(body.confirm_text ?? "").trim().toLowerCase() !== "localhost") return err(route, 422, "validation_failed", "Type localhost exactly to approve.");
      if (body.decision === "reject" && !String(body.comment ?? "").trim()) return err(route, 422, "validation_failed", "Say why this load test shouldn't run.");
      Object.assign(r, body.decision === "approve" ? { status: "queued", status_label: "Waiting to start" } : { status: "rejected", status_label: "Not approved" });
      r.approval = { ...r.approval!, status: body.decision === "approve" ? "approved" : "rejected", decided_by: ME, decided_at: NOW, comment: (body.comment as string) ?? null, host_typed: body.decision === "approve" };
      return json(route, 200, withPerms(q, r));
    }
    const stop = path.match(/^\/performance-runs\/([^/]+)\/stop$/);
    if (stop && method === "POST") {
      record();
      const r = q.runs.find((x) => x.id === stop[1])!;
      Object.assign(r, { status: "stopped", status_label: "Stopped", stopped_by: ME, live: null, permissions: { ...r.permissions, can_stop: false }, threshold_results: [TH({ path: "/", measured: 120 })] });
      return json(route, 200, { message: "Stopping.", run: r });
    }
    const wd = path.match(/^\/performance-runs\/([^/]+)\/withdraw$/);
    if (wd && method === "POST") {
      record();
      const r = q.runs.find((x) => x.id === wd[1])!;
      Object.assign(r, { status: "rejected", status_label: "Withdrawn" });
      return json(route, 200, { message: "Request withdrawn. Nothing was sent to the site.", run: r });
    }

    // ---- organisation load limits
    const os = path.match(/^\/organisations\/([^/]+)\/settings$/);
    if (os) {
      if (method === "PATCH") {
        record();
        const c = (body.load_ceiling ?? {}) as Record<string, number>;
        if (c.vus > LIMITS.server.vus) return json(route, 422, { error: { code: "validation_failed", message: `This server allows up to ${LIMITS.server.vus}.`, details: [{ field: "vus", message: `This server allows up to ${LIMITS.server.vus}.` }] } });
        Object.assign(LIMITS.organisation, c);
      }
      return json(route, 200, { load_ceiling: LIMITS.organisation, effective_ceiling: LIMITS.organisation, hard_cap: LIMITS.server, can_edit: q.role === "owner" || q.role === "admin", ...(method === "PATCH" ? { message: "Load limits saved." } : {}) });
    }
    return route.fallback();
  });
}
