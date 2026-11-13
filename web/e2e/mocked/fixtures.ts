// DEVELOPMENT/TEST FIXTURES ONLY. A stateful stand-in for the QA Analyst API (docs/architecture/api-contracts.md),
// served through Playwright's page.route(). It lets the UI be exercised before the real backend is ready.
// Nothing here is imported by the product code.

import type { Page, Route } from "@playwright/test";
import type {
  AgentEvent,
  Dashboard,
  EvidenceDetail,
  Feature,
  Journey,
  PageDetail,
  PageSummary,
  ProjectDetail,
  ReportDetail,
  ScanDetail,
  StageKey,
  StageState,
  UrlCheckResult,
  Workflow,
} from "../../src/lib/contract";

export const API = "http://localhost:8200/api/v1";
const NOW = "2026-11-12T14:01:00Z";

const LATER: [StageKey, number][] = [
  ["requirements", 2],
  ["readiness_criteria", 2],
  ["test_strategy", 2],
  ["test_design", 3],
  ["traceability", 3],
  ["automation_assessment", 4],
  ["automation", 4],
  ["execution", 4],
  ["failure_analysis", 4],
  ["defects_summary", 4],
  ["release_readiness", 5],
  ["performance", 5],
];

function stage(key: StageKey, phase: number, over: Partial<StageState> = {}): StageState {
  return {
    key,
    title: key.replace(/_/g, " "),
    phase,
    available: phase === 1,
    status: "not_started",
    current_version: null,
    gate: null,
    started_at: null,
    finished_at: null,
    stale_reason: null,
    progress: null,
    ...over,
  };
}

export type MockState = {
  user: { id: string; email: string; full_name: string } | null;
  org: string;
  projects: ProjectDetail[];
  /** "running" | "awaiting" | "approved" */
  phase: "running" | "awaiting" | "approved" | "paused";
  events: AgentEvent[];
  decisions: { decision: string; comment: string; decided_by: { id: string; full_name: string }; decided_at: string }[];
  /** Captures for assertions. */
  requests: { method: string; path: string; body: unknown }[];
  duplicateOnce: boolean;
  wrongPassword: boolean;
  /** Gate 2 policy. The backend default is "recommended": the stage completes and the gate stays open. */
  g2Policy: "required" | "recommended";
  /** GET /health `allow_private_targets` (undefined = field absent). */
  allowPrivateTargets?: boolean;
  /** A second, newer scan exists (Scan 1's report is then based on an older scan). */
  rescanned: boolean;
  /** Mobile captures differ from desktop (collapsed navigation). */
  responsiveDiffs: boolean;
  /** POST /auth/register answers 422 with this field error (raw validator text, as the backend sends it). */
  registerFieldError?: { field: string; message: string };
  /** Phase 2: the scan signed in with saved test credentials ("failed" = the site rejected them). */
  signIn?: "failed" | "succeeded";
};

export function newState(over: Partial<MockState> = {}): MockState {
  return {
    user: null,
    org: "Acme Ltd",
    projects: [],
    phase: "running",
    events: [],
    decisions: [],
    requests: [],
    duplicateOnce: false,
    wrongPassword: false,
    g2Policy: "recommended",
    rescanned: false,
    responsiveDiffs: true,
    ...over,
  };
}

export function project(id = "p1", over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id,
    name: "acme.com",
    primary_url: "https://acme.com",
    status: "active",
    current_stage: "discovery",
    current_stage_status: "running",
    pages_discovered: 2,
    awaiting_approval: false,
    updated_at: NOW,
    description: "",
    version: 1,
    urls: [
      {
        id: "u1",
        url: "https://acme.com",
        role: "primary",
        allowed_hosts: ["acme.com"],
        authorisation_status: "approved",
        authorised_by: { id: "u", full_name: "Daniele Edema" },
        authorised_at: NOW,
        last_check: null,
      },
    ],
    approval_policy: { G2: "required" },
    locked_gates: [],
    settings: { max_pages: 30, max_depth: 3, include_mobile: true, respect_robots: true },
    created_at: NOW,
    created_by: { id: "u", full_name: "Daniele Edema" },
    ...over,
  };
}

/** Mirrors the orchestrator: Gate 2 sits on the discovery stage. Under "required" the stage waits
 * (awaiting_approval, gate pending); under "recommended" it completes with the gate "recommended". */
function workflow(s: MockState): Workflow {
  const running = s.phase === "running" || s.phase === "paused";
  const required = s.g2Policy === "required";
  const gateStatus = s.phase === "approved" ? "approved" : running ? "none" : required ? "pending" : "recommended";
  const discStatus = s.phase === "paused" ? "paused" : running ? "running" : s.phase === "approved" ? "approved" : required ? "awaiting_approval" : "completed";
  return {
    project_status: s.phase === "paused" ? "paused" : "active",
    stages: [
      stage("intake", 1, { status: "completed" }),
      stage("discovery", 1, {
        status: discStatus,
        current_version: 1,
        progress: { done: 2, total: 25, label: "pages" },
        started_at: NOW,
        gate: {
          key: "G2",
          policy: s.g2Policy,
          status: gateStatus,
          recommendation: running ? null : { recommend: "proceed_with_caution", reasons: ["1 area needs credentials (/account)", "Signed-in area not observed"], generated_by: "rules" },
        },
      }),
      stage("discovery_report", 1, { status: running ? "not_started" : "completed", current_version: running ? null : 1 }),
      ...LATER.map(([k, p]) => stage(k, p)),
    ],
  };
}

const shot = (id: string) => ({ id, kind: "screenshot", mime: "image/png", size: 1234, captured_at: NOW, content_url: `${API}/evidence/${id}/content?exp=1&sig=x` });

const PAGES: PageSummary[] = [
  { id: "pg1", url: "https://acme.com/", title: "Home", http_status: 200, depth: 0, page_type: "home", requires_auth: false, counts: { links: 12, buttons: 2 }, screenshot: shot("ev1") },
  { id: "pg2", url: "https://acme.com/contact", title: "Contact us", http_status: 200, depth: 1, page_type: "contact", requires_auth: false, counts: { forms: 1, inputs: 3, buttons: 1 }, screenshot: shot("ev2") },
  { id: "pg3", url: "https://acme.com/account", title: "My account", http_status: 302, depth: 1, page_type: "auth", requires_auth: true, counts: {}, screenshot: null },
];

export const ACCESS_GAPS: ScanDetail["access_gaps"] = [
  {
    area: "/account",
    reason: "Needs credentials",
    description: "/account redirects to the sign-in page.",
    suggestion: "Add credentials and re-scan",
    evidence_refs: [{ evidence_id: "ev3" }],
  },
  {
    area: "Contact form (/contact)",
    reason: "Not performed: destructive or transactional action",
    description: "The contact form on /contact was not submitted; its validation, confirmation and resulting data changes were not observed.",
    suggestion: "Requires explicit approval in a later phase",
    evidence_refs: [{ evidence_id: "ev2" }, { evidence_id: "ev4", selector: "form#contact" }],
  },
];

function scan(s: MockState): ScanDetail {
  const running = s.phase === "running" || s.phase === "paused";
  return {
    id: "scan1",
    key: "SCAN-0001",
    // The scan record can lag the workflow after Pause (it still says "running"); the UI must follow the stage.
    status: running ? "running" : "completed",
    start_url: "https://acme.com",
    pages_found: 3,
    started_at: NOW,
    finished_at: running ? null : "2026-11-12T14:05:00Z",
    limits: { max_pages: 30, max_depth: 3, include_mobile: true, respect_robots: true },
    stats: { pages: 2, forms: 1, inputs: 3, buttons: 3, links: 12, tables: 0, modals: 0, search: 0, filters: 0, console_errors: 0, failed_requests: 0, blocked_requests: 0, access_gaps: running ? 0 : ACCESS_GAPS.length },
    completeness: { score: 70, rating: "partial", reasons: ["Signed-in area not observed"] },
    auth_boundaries: [{ url: "https://acme.com/account", kind: "redirect_to_login", evidence_refs: [{ evidence_id: "ev3" }] }],
    // As the backend reports them: the sign-in boundary is one of the gaps (not added again by the UI).
    access_gaps: running ? [] : s.signIn === "failed" ? [...ACCESS_GAPS, { area: "https://acme.com/login", reason: "Sign-in failed: the site rejected the username or password", description: "https://acme.com/login", suggestion: "Replace credentials and re-scan", evidence_refs: [] }] : ACCESS_GAPS,
    ...(s.signIn ? { auth: { attempted: true, result: s.signIn, reason_code: s.signIn === "failed" ? "rejected" : null, login_url: "https://acme.com/login", authenticated_pages: s.signIn === "failed" ? 0 : 4 } } : {}),
    limitations: ["Public pages only."],
    blocked_requests: [],
    current: running ? { url: "https://acme.com/contact", title: "Contact us" } : null,
    error: null,
  };
}

const FEATURES: Feature[] = [
  {
    id: "f1",
    key: "FEAT-001",
    name: "Contact form",
    description: "Visitors can send a message with name, email and text.",
    category: "forms",
    page_ids: ["pg2"],
    provenance: "observed",
    confidence: 0.9,
    evidence_refs: [{ evidence_id: "ev2", selector: "form#contact" }, { evidence_id: "ev4", excerpt: '<form id="contact">' }],
    generated_by: "rules",
  },
];

const JOURNEYS: Journey[] = [
  {
    id: "j1",
    key: "JRN-001",
    name: "Contact the company",
    // Labels come from the API. Wording that sounds like an action ("Go to Sign in") can still be an
    // observed navigation, and "Fill in" can be inferred: the UI must not guess from the text.
    steps: [
      { page_id: "pg1", action: "Go to Sign in · Acme", label: "observed" },
      { page_id: "pg2", action: "Open Contact us", label: "observed" },
      { page_id: "pg2", action: "Fill in the contact form", label: "inferred" },
    ],
    reason: "Steps 1–2 were navigated; filling in and sending the form was not performed (read-only).",
    provenance: "inferred",
    confidence: 0.7,
    evidence_refs: [{ evidence_id: "ev2" }],
    generated_by: "rules",
  },
];

/** Hostile DOM snippet: must render as text, never as markup. */
export const HOSTILE_DOM = '<form id="contact"><a href="https://evil.example/">click</a><script>window.__pwned = true</script></form>';

export function event(id: number, over: Partial<AgentEvent>): AgentEvent {
  return {
    id,
    project_id: "p1",
    stage_key: "discovery",
    agent_key: "discovery",
    task_id: null,
    type: "log",
    level: "info",
    message: "",
    data: null,
    created_at: NOW,
    ...over,
  };
}

function sse(events: AgentEvent[]): string {
  return events.map((e) => `id: ${e.id}\nevent: agent_event\ndata: ${JSON.stringify(e)}\n\n`).join("") + ": keep-alive\n\n";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Expose-Headers": "Retry-After",
};

function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json", ...headers }, body: body === undefined ? "" : JSON.stringify(body) });
}

function err(route: Route, status: number, code: string, message: string, details?: unknown) {
  return json(route, status, { error: { code, message, details, request_id: "req-1" } });
}

export async function mockApi(page: Page, s: MockState) {
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    s.requests.push({ method, path: `${path}${url.search}`, body });
    const b = (body ?? {}) as Record<string, unknown>;
    const authed = !!req.headers()["authorization"];
    const me = () => ({ user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: "owner", can_approve: true });

    // ---- auth
    if (path === "/auth/register" && method === "POST") {
      if (s.registerFieldError)
        return err(route, 422, "validation_error", "Request validation failed", [{ field: `body.${s.registerFieldError.field}`, message: s.registerFieldError.message }]);
      s.user = { id: "u", email: String(b.email), full_name: String(b.full_name) };
      s.org = String(b.organisation_name);
      return json(route, 201, { token: "tok", expires_at: NOW, ...me() });
    }
    if (path === "/auth/login" && method === "POST") {
      if (s.wrongPassword) return err(route, 401, "unauthenticated", "Incorrect email or password");
      s.user = s.user ?? { id: "u", email: String(b.email), full_name: "Daniele Edema" };
      return json(route, 200, { token: "tok", expires_at: NOW, ...me() });
    }
    if (path === "/auth/logout") return route.fulfill({ status: 204, headers: CORS });
    if (path === "/health")
      return json(route, 200, {
        status: "ok",
        db: true,
        worker: { mode: "inline", last_heartbeat_s: 1 },
        queue_depth: 0,
        ai: { enabled: false, provider: null, model: null },
        browser: { available: true },
        version: "test",
        ...(s.allowPrivateTargets === undefined ? {} : { allow_private_targets: s.allowPrivateTargets }),
      });
    // Signed content URLs authenticate by signature, never by bearer token (the app must not send one).
    const signed = path.match(/^\/evidence\/([^/]+)\/content$/);
    if (signed && url.searchParams.has("sig")) {
      if (signed[1] === "ev4") return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "text/plain" }, body: HOSTILE_DOM });
      // 1×1 transparent PNG
      return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "image/png" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") });
    }
    if (!authed || !s.user) return err(route, 401, "unauthenticated", "Sign in");
    if (path === "/auth/me") return json(route, 200, me());

    // ---- dashboard / projects
    if (path === "/dashboard") {
      const d: Dashboard = {
        welcome: { full_name: s.user.full_name, organisation: s.org },
        recent_projects: s.projects,
        activity: s.projects.length ? [{ id: 1, project_id: "p1", project_name: "acme.com", type: "stage.status_changed", message: "Discovery started", level: "info", created_at: NOW }] : [],
        health: { projects_total: s.projects.length, scans_running: s.phase === "running" ? s.projects.length : 0, awaiting_approval: s.phase === "awaiting" ? 1 : 0, failed_stages: 0, pages_discovered_30d: 2 },
        ai: { enabled: false, model: null },
      };
      return json(route, 200, d);
    }
    if (path === "/projects/url-check") {
      const target = String(b.url);
      const host = new URL(target).hostname;
      const isPrivate = host === "localhost" || /^(127\.|10\.|192\.168\.)/.test(host);
      const metadata = target.includes("169.254.169.254");
      // Like the server's SSRF policy: metadata always blocked; private hosts unless allowed (dev/test).
      const blocked = metadata || (isPrivate && !s.allowPrivateTargets);
      const r: UrlCheckResult = {
        input_url: target,
        normalised_url: target,
        allowed: !blocked,
        blocked_reason: metadata ? "Cloud metadata endpoint" : blocked ? "Private or internal address" : null,
        reachable: !blocked,
        http_status: blocked ? null : 200,
        final_url: blocked ? null : target,
        redirects: [],
        cross_site_redirect: false,
        tls: { valid: true, error: null },
        content_type: "text/html",
        robots: null,
        checked_at: NOW,
        page_title: "Acme — Industrial Sensors",
      };
      return json(route, 200, r);
    }
    if (path === "/projects" && method === "POST") {
      if (s.duplicateOnce && !b.confirmDuplicate) {
        // Real backend shape: details carry project_id / project_name / primary_url / field.
        return err(route, 409, "DUPLICATE_PROJECT", "A project for this URL already exists.", { project_id: "p1", project_name: "acme.com", primary_url: "https://acme.com", field: "url" });
      }
      const p = project(s.projects.length ? `p${s.projects.length + 1}` : "p1", { name: String(b.name ?? "acme.com") });
      s.projects.push(p);
      return json(route, 201, p);
    }
    if (path === "/projects" && method === "GET") return json(route, 200, { items: s.projects, next_cursor: null });
    const pm = path.match(/^\/projects\/([^/]+)(\/.*)?$/);
    if (pm) {
      const p = s.projects.find((x) => x.id === pm[1]);
      if (!p) return err(route, 404, "not_found", "Not found");
      const rest = pm[2] ?? "";
      if (rest === "") return json(route, 200, { ...p, awaiting_approval: s.phase === "awaiting" });
      if (rest === "/workflow") return json(route, 200, workflow(s));
      if (rest === "/workflow/pause") {
        s.phase = "paused";
        return json(route, 200, workflow(s));
      }
      if (rest === "/workflow/resume") {
        s.phase = "running";
        return json(route, 200, workflow(s));
      }
      if (rest === "/events/stream") {
        const last = Number(req.headers()["last-event-id"] ?? url.searchParams.get("after") ?? 0);
        return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "text/event-stream" }, body: sse(s.events.filter((e) => e.id > last)) });
      }
      if (rest === "/discovery" || rest === "/scans/1") return json(route, 200, scan(s));
      if (rest.startsWith("/scans")) return json(route, 200, { items: [scan(s)], next_cursor: null });
      if (rest.startsWith("/stages/discovery/runs/")) return json(route, 200, { version: 1, status: "completed", generated_by: "rules", partial: false, upstream_versions: {}, validation_issues: [], output: {}, decisions: s.decisions });
      if (rest === "/gates/G2/decision") {
        // Same rule as the orchestrator: decidable when the stage finished and the gate is pending or recommended.
        const st = workflow(s).stages[1];
        if (!st.gate || !["pending", "recommended"].includes(st.gate.status)) return err(route, 409, "conflict", "G2 is not waiting for a decision");
        s.phase = b.decision === "approve" ? "approved" : s.phase;
        s.decisions.push({ decision: String(b.decision), comment: String(b.comment ?? ""), decided_by: { id: "u", full_name: s.user.full_name }, decided_at: "2026-11-12T15:10:00Z" });
        return json(route, 200, workflow(s).stages[1]);
      }
      if (rest === "/reports" && method === "GET")
        return json(
          route,
          200,
          s.phase === "running"
            ? []
            : [
                ...(s.rescanned
                  ? [{ id: "r2", report_type: "discovery", version: 2, status: "ready", formats: ["pdf", "html", "json"], generated_by: "rules", created_at: "2026-11-12T16:00:00Z", scan_id: "scan2", scan_key: "SCAN-0002", scan_number: 2, is_latest_scan: true, approval_status: "draft" }]
                  : []),
                { id: "r1", report_type: "discovery", version: 1, status: "ready", formats: ["pdf", "html", "json"], generated_by: "rules", created_at: NOW, scan_id: "scan1", scan_key: "SCAN-0001", scan_number: 1, is_latest_scan: !s.rescanned, approval_status: s.phase === "approved" ? "approved" : "draft" },
              ],
        );
    }
    if (path === "/scans/scan1") return json(route, 200, scan(s));
    // After a successful sign-in the account page was visited with the session (the sitemap node still says requires_auth).
    const signedInPages = s.signIn === "succeeded" ? PAGES.map((x) => (x.id === "pg3" ? { ...x, http_status: 200, auth_context: "authenticated" as const } : { ...x, auth_context: "anonymous" as const })) : PAGES;
    if (path === "/scans/scan1/pages") return json(route, 200, { items: signedInPages, next_cursor: null });
    if (path === "/scans/scan1/sitemap")
      return json(route, 200, { url: "https://acme.com/", path: "/", title: "Home", page_id: "pg1", children: [{ path: "/contact", title: "Contact us", page_id: "pg2" }, { path: "/account", title: "My account", requires_auth: true, ...(s.signIn === "succeeded" ? { page_id: "pg3" } : {}) }] });
    if (path === "/scans/scan1/features") return json(route, 200, FEATURES);
    if (path === "/scans/scan1/journeys") return json(route, 200, JOURNEYS);
    const pg = path.match(/^\/pages\/([^/]+)$/);
    if (pg) {
      const base = PAGES.find((x) => x.id === pg[1]) ?? PAGES[0];
      const d: PageDetail = {
        ...base,
        headings: ["Contact us"],
        nav_links: [{ text: "Home", href: "https://acme.com/" }],
        forms: base.id === "pg2" ? [{ name: "Contact", method: "post", action: "/contact", purpose_guess: "contact", submit_label: "Send", fields: [{ name: "name", type: "text", label: "Name", required: true, placeholder: null, constraints: { min: null, max: null, maxlength: null, pattern: null }, options: null, locator: "#name" }] }] : [],
        components: [{ kind: "button", role: "button", name: "Send", locator: "button[type=submit]", fingerprint: "b1", details: {} }],
        responsive: {
          desktop: { viewport: "Desktop 1440 × 900", nav_collapsed: false, horizontal_overflow: false, screenshot: base.screenshot },
          mobile: { viewport: "Mobile 390 × 844", nav_collapsed: s.responsiveDiffs, horizontal_overflow: false, screenshot: base.screenshot },
        },
        console_issues: [],
        network_issues: [],
        evidence: [base.screenshot, { ...shot("ev4"), kind: "dom", mime: "text/html" }].filter(Boolean) as PageDetail["evidence"],
      };
      return json(route, 200, d);
    }
    const ev = path.match(/^\/evidence\/([^/]+)$/);
    if (ev) {
      const id = ev[1];
      if (id === "missing") return err(route, 404, "not_found", "Gone");
      const d: EvidenceDetail = id === "ev4" ? { ...shot("ev4"), kind: "dom", mime: "text/html", metadata: { url: "https://acme.com/contact" } } : { ...shot(id), metadata: { url: "https://acme.com/contact", viewport: "Desktop 1440×900" } };
      return json(route, 200, d);
    }
    if (path === "/reports/r1") {
      const d: ReportDetail = {
        id: "r1",
        report_type: "discovery",
        version: 1,
        status: "ready",
        formats: ["pdf", "html", "json"],
        generated_by: "rules",
        created_at: NOW,
        scan_id: "scan1",
        content: {
          summary: "Discovery explored 2 public pages of acme.com.",
          summary_generated_by: "rules",
          scope_and_method: ["Start URL https://acme.com", "Up to 25 pages"],
          sitemap: { path: "/", title: "Home", page_id: "pg1", children: [{ path: "/contact", title: "Contact us", page_id: "pg2" }] },
          functionality_map: FEATURES,
          pages: PAGES,
          forms_inventory: [],
          interactive_components: { buttons: 3, links: 12 },
          journeys: JOURNEYS,
          auth_boundaries: [{ url: "https://acme.com/account", kind: "redirect_to_login", evidence_refs: [] }],
          access_gaps: ACCESS_GAPS,
          responsive_observations: ["Navigation collapses into a menu button at 390 px"],
          console_and_network_issues: [],
          injection_flags: [],
          completeness: { score: 70, rating: "partial", reasons: ["Signed-in area not observed"] },
          limitations: ["Public pages only."],
          evidence_index: [shot("ev1")],
          disclaimer: "Based on publicly reachable pages only; not a security audit; backend behaviour not verified.",
        },
      };
      return json(route, 200, d);
    }
    if (path === "/reports/r1/download") return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/pdf" }, body: "%PDF-1.4 test" });
    return err(route, 404, "not_found", `No fixture for ${method} ${path}`);
  });
}

/** Signs in through the UI's storage key so tests can open app pages directly. */
export async function signedIn(page: Page, s: MockState) {
  s.user = s.user ?? { id: "u", email: "daniele@acme.test", full_name: "Daniele Edema" };
  await page.addInitScript(() => window.localStorage.setItem("qa_token", "tok"));
}
