// DEVELOPMENT/TEST FIXTURES ONLY. Exploratory testing stand-ins for the QA Analyst API (backend
// app/api/routers/exploratory.py, the exploratory branches of /quality-scans/{id}/cancel and
// POST /approvals/{id}/decision, and the exploration fields of /organisations/{id}/settings; P6-03a), layered over
// ./fixtures.ts and the phase 2–4 fixtures with page.route(). EXP-0001 is the demo's session on release 2 (design P6
// §14 step 6): the uncaught error and "NaN" on /offers, the blocked POST /basket and "Apply code" not tried. Nothing
// here is imported by the product code.

import type { Page, Route } from "@playwright/test";
import type { StageState, Workflow } from "../../src/lib/contract";
import type { Finding } from "../../src/lib/nonfunctional";
import { exploreStatement, SHORT_STATEMENT, type ExploreOptions, type Session, type SessionList, type Step, type StepOutcome } from "../../src/lib/exploratory";
import { API, type MockState } from "./fixtures";
import { p4Workflow, type P4State } from "./phase4-fixtures";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const err = (route: Route, status: number, code: string, message: string, details: unknown = null) => json(route, status, { error: { code, message, details } });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const MEMBER = { id: "m", full_name: "M. Member" };
const ME = { id: "u", full_name: "Daniele Edema" };
const NOW = "2026-11-15T11:02:00Z";
const LATER = "2026-11-15T11:08:12Z";
const HOST = "localhost";
const NETLOC = "localhost:4100";
const LIMITS = { organisation: { actions: 60, minutes: 10 }, server: { actions: 200, minutes: 20 } };
export const WHAT_IT_DOES = [
  `Clicks buttons that can't submit, tabs, menus and links to pages on ${NETLOC}, and presses Escape to check that a dialog closes.`,
  "Never types, selects, uploads, submits forms or downloads files.",
  'Never clicks anything named like delete, remove, buy, pay, order, checkout, subscribe, send, submit, confirm, save or sign out, and never opens sign-out addresses, even through a redirect. Those are listed as "Not tried".',
  "Blocks every request the page tries to send other than reading. Blocked attempts are listed.",
  "Desktop 1440 × 900 only.",
];
const PAGES = [
  { page_id: "pg-home", url: "http://localhost:4100/", path: "/", requires_auth: false, anonymous_reason: null, signed_in_reason: null },
  { page_id: "pg-offers", url: "http://localhost:4100/offers", path: "/offers", requires_auth: false, anonymous_reason: null, signed_in_reason: null },
  { page_id: "pg-contact", url: "http://localhost:4100/contact", path: "/contact", requires_auth: false, anonymous_reason: null, signed_in_reason: null },
  { page_id: "pg-account", url: "http://localhost:4100/account", path: "/account", requires_auth: true, anonymous_reason: "needs sign-in: turn on Explore signed in", signed_in_reason: null },
  { page_id: "pg-logout", url: "http://localhost:4100/logout", path: "/logout", requires_auth: false, anonymous_reason: "looks like a sign-out link", signed_in_reason: "looks like a sign-out link" },
];

export type ExploreState = {
  role: "owner" | "admin" | "member" | "viewer";
  canApprove: boolean;
  g2: boolean;
  credentials: boolean;
  changeSet: boolean;
  browser: boolean;
  /** Newest first. */
  sessions: Session[];
  steps: Record<string, Step[]>;
  findings: Record<string, Finding[]>;
  /** The next start answers 409: this session started elsewhere a moment before. */
  conflictNext: string | null;
  /** Milliseconds before POST /exploratory-sessions answers (a double click lands while the first is in flight). */
  startDelay: number;
  /** A running session takes this many actions per GET of its page, and ends when the budget is used. */
  stepsPerTick: number;
  /** Exploration ceiling of the organisation (Settings › Limits). */
  ceiling: { actions: number; minutes: number };
  requests: { method: string; path: string; body: unknown }[];
};

const progress = (over: Partial<Session["progress"]> = {}): Session["progress"] => ({
  actions_used: 0,
  actions_budget: 60,
  minutes_budget: 10,
  pages_explored: 0,
  pages_total: 3,
  current_page: null,
  last_step: null,
  findings: 0,
  findings_by_severity: { high: 0, medium: 0, low: 0 },
  open_findings: 0,
  blocked: 0,
  not_tried: 0,
  ...over,
});

const pageList = (paths: string[]) => paths.map((x) => ({ page_id: `pg-${x.replace(/\W/g, "") || "home"}`, url: `http://localhost:4100${x}`, path: x, requires_auth: x.startsWith("/account") }));

export function session(key: string, over: Partial<Session> = {}): Session {
  const n = Number(key.slice(-4));
  return {
    id: `exp-${n}`,
    key,
    kind: "exploratory",
    status: "completed",
    status_label: "Finished · budget used",
    charter: { key: "change_set", label: "New and changed pages from CHG-0001", change_set: { id: "cs-CHG-0001", key: "CHG-0001" } },
    pages: 3,
    budget: { actions: 60, minutes: 10 },
    signed_in: false,
    summary_sentence: `Explore 3 pages on ${NETLOC}, for up to 60 actions and 10 minutes.`,
    chosen_by: "rules",
    generated_by: "rules",
    requested_by: MEMBER,
    approved_by: null,
    stopped_by: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: LATER,
    elapsed_s: 372,
    progress: progress(),
    end_reason: null,
    end_text: null,
    statement: SHORT_STATEMENT,
    error: null,
    cancel_requested: false,
    drafted: [],
    approval: null,
    permissions: { can_approve: false, can_stop: false, can_withdraw: false, can_request_again: true, can_triage: true },
    host: HOST,
    netloc: NETLOC,
    what_it_does: WHAT_IT_DOES,
    page_list: pageList(["/", "/offers", "/contact"]),
    left_out: [],
    blocked: [],
    not_tried: [],
    never_reached: [],
    coverage: [],
    elements_tried: 0,
    no_findings_line: null,
    defects: [],
    ...over,
  };
}

const BLOCKED_BASKET = { request: "POST /basket", method: "POST", path: "/basket", after: 'Clicking button "Add to basket" on /offers', step: 23, text: "The page tried to send POST /basket. Blocked: exploration never sends data.", reason: null };
const APPLY_CODE = { element: 'Button "Apply code"', role: "button", name: "Apply code", page: "/offers", reason: "Submits a form", fingerprint: "fp-apply" };

function step(n: number, page: string, label: string, outcome: StepOutcome, over: Partial<Step> = {}): Step {
  const obs: Step["observations"] =
    outcome === "no_effect" ? [{ kind: "no_effect", text: "No visible effect" }] : outcome === "navigated" ? [{ kind: "navigated", text: `Opened ${page}` }] : [];
  return { n, page, page_url: `http://localhost:4100${page}`, action: { id: `a${n}`, kind: "click", target: { role: "button", name: label, fingerprint: `fp${n}` } }, label: `Clicked button "${label}"`, outcome, observations: obs, evidence_ids: [], findings: [], chosen_by: "rules", created_at: NOW, ...over };
}

/** The demo's 60 steps: step 22 finds the uncaught error and "NaN", step 23 tries POST /basket. */
export function demoSteps(count = 60): Step[] {
  const out: Step[] = [];
  for (let n = 1; n <= count; n++) {
    if (n === 22)
      out.push(
        step(22, "/offers", "Show details", "error", {
          observations: [
            { kind: "problem", rule: "uncaught_exception", severity: "medium", text: 'Uncaught error after clicking button "Show details"' },
            { kind: "problem", rule: "broken_text", severity: "medium", text: "'NaN' appeared on the page" },
          ],
          findings: ["EXP-0001-01", "EXP-0001-02"],
        }),
      );
    else if (n === 23) out.push(step(23, "/offers", "Add to basket", "blocked", { observations: [{ kind: "blocked", text: BLOCKED_BASKET.text }] }));
    else out.push(step(n, n % 3 === 0 ? "/contact" : n % 3 === 1 ? "/" : "/offers", `Menu item ${n}`, n % 4 === 0 ? "navigated" : n % 5 === 0 ? "no_effect" : "ok"));
  }
  return out;
}

const shotRef = (id: string, role: "before" | "after", n: number) => ({ evidence_id: id, kind: "screenshot", role, step: n }) as Finding["evidence"][number];

export function demoFindings(scanKey = "EXP-0001"): Finding[] {
  const base = {
    scan_id: "exp-1",
    scan_key: scanKey,
    kind: "accessibility" as Finding["kind"],
    url: "http://localhost:4100/offers",
    path: "/offers",
    page_id: "pg-offers",
    viewport: "desktop",
    nodes: [],
    references: [],
    status: "open" as const,
    status_reason: null,
    status_by: null,
    seen_before: null,
    reopened: false,
    heuristic: false,
    needs_review: false,
    best_practice: false,
    mapped: { features: [], requirements: [], test_cases: [] },
    created_at: NOW,
  };
  const action = { kind: "click", target: { role: "button", name: "Show details" }, label: 'Clicked button "Show details"' };
  const steps = ["Open http://localhost:4100/offers", 'Click the button "Show details"'];
  const defect = { id: "def-0007", key: "DEF-0007", status: "draft", summary: "Offers page: 'Show details' throws an error and shows £NaN" };
  return [
    {
      ...base,
      id: "f-exp-01",
      key: `${scanKey}-01`,
      rule_id: "uncaught_exception",
      severity: "medium",
      title: 'Uncaught error after clicking button "Show details"',
      details: { observed: "TypeError: Cannot read properties of undefined (reading 'price')", steps, step: 22, console: ["TypeError: Cannot read properties of undefined (reading 'price') at offers.js:14"], network: ["GET /offers 200", "GET /static/offers.js 200"], action, category: "Uncaught error" },
      defect,
      evidence: [shotRef("ev-b22", "before", 22), shotRef("ev-a22", "after", 22)],
    },
    {
      ...base,
      id: "f-exp-02",
      key: `${scanKey}-02`,
      rule_id: "broken_text",
      severity: "medium",
      title: "'NaN' appeared on the page",
      details: { observed: "Bundle price: £NaN", steps, step: 22, console: [], network: ["GET /offers 200"], action, category: "Broken value shown" },
      defect,
      evidence: [shotRef("ev-b22", "before", 22), shotRef("ev-a22", "after", 22)],
    },
  ] as Finding[];
}

/** EXP-0001 on release 2 (design P6 §14 step 6). */
export function demoSession(): Session {
  return session("EXP-0001", {
    end_reason: "budget",
    end_text: "Budget used: 60 of 60 actions",
    statement: exploreStatement(60, 3),
    progress: progress({ actions_used: 60, pages_explored: 3, findings: 2, findings_by_severity: { high: 0, medium: 2, low: 0 }, open_findings: 2, blocked: 1, not_tried: 1, current_page: "/offers" }),
    blocked: [BLOCKED_BASKET],
    not_tried: [APPLY_CODE],
    never_reached: [
      { element: 'Link "Terms"', page: "/" },
      { element: 'Button "Next"', page: "/offers" },
      { element: 'Tab "Reviews"', page: "/offers" },
      { element: 'Link "Help"', page: "/contact" },
    ],
    coverage: [
      { page: "/", actions: 20, findings: 0, not_tried: 0, visited: true, reason: null },
      { page: "/offers", actions: 21, findings: 2, not_tried: 1, visited: true, reason: null },
      { page: "/contact", actions: 19, findings: 0, not_tried: 0, visited: true, reason: null },
    ],
    elements_tried: 41,
    drafted: ["DEF-0007"],
    defects: [{ key: "DEF-0007", summary: "Offers page: 'Show details' throws an error and shows £NaN", status: "draft" }],
  });
}

/** A session that ended with allowed actions it couldn't reach, a blocked sign-out read and a stopped navigation. */
export function unreachedSession(): Session {
  return session("EXP-0003", {
    status: "partial",
    status_label: "Finished · some actions not reached",
    end_reason: "unreached",
    end_text: "12 of 60 actions used. 3 allowed actions couldn't be reached: see Never reached.",
    statement: exploreStatement(12, 2),
    progress: progress({ actions_used: 12, pages_explored: 2, blocked: 1, not_tried: 1 }),
    blocked: [{ request: "GET /logout?img=1", method: "GET", path: "/logout", after: "Opening the page /", step: 3, text: "The page tried to open /logout?img=1.", reason: "The page tried to open /logout?img=1. Blocked: would end the session." }],
    not_tried: [{ element: 'Link "Account"', role: "link", name: "Account", page: "/", reason: "Would end the session", fingerprint: "fp-acc", destination: "/logout" }],
    never_reached: [
      { element: 'Button "More"', page: "/offers" },
      { element: 'Tab "Reviews"', page: "/offers" },
      { element: 'Link "Help"', page: "/contact" },
    ],
    coverage: [
      { page: "/", actions: 8, findings: 0, not_tried: 1, visited: true, reason: null },
      { page: "/offers", actions: 4, findings: 0, not_tried: 0, visited: true, reason: null },
      { page: "/contact", actions: 0, findings: 0, not_tried: 0, visited: false, reason: "Not explored: the budget ran out." },
    ],
    elements_tried: 12,
    no_findings_line: "No problems found by the automated checks in 12 actions on 2 pages.",
  });
}

export function runningSession(key = "EXP-0002", over: Partial<Session> = {}): Session {
  return session(key, {
    status: "running",
    status_label: "Exploring · 0 of 60 actions",
    finished_at: null,
    elapsed_s: 0,
    requested_by: ME,
    permissions: { can_approve: false, can_stop: true, can_withdraw: false, can_request_again: false, can_triage: true },
    ...over,
  });
}

export function waitingSession(key = "EXP-0004", over: Partial<Session> = {}): Session {
  return session(key, {
    status: "awaiting_approval",
    status_label: "Waiting for approval",
    signed_in: true,
    charter: { key: "chosen", label: "Chosen pages", change_set: null },
    summary_sentence: `Explore 3 pages on ${NETLOC} signed in with the saved test account, for up to 60 actions and 10 minutes.`,
    started_at: null,
    finished_at: null,
    elapsed_s: null,
    page_list: pageList(["/account", "/account/orders", "/offers"]),
    approval: { id: "apr-6", key: "APR-0006", status: "pending", expires_at: "2026-11-16T11:30:00Z", decided_by: null, decided_at: null, comment: null, host_typed: false, self_approved: false, confirm_prompt: `Type ${HOST} to approve` },
    ...over,
  });
}

export function newExplore(over: Partial<ExploreState> = {}): ExploreState {
  const q: ExploreState = {
    role: "owner",
    canApprove: true,
    g2: true,
    credentials: true,
    changeSet: true,
    browser: true,
    sessions: [],
    steps: {},
    findings: {},
    conflictNext: null,
    startDelay: 0,
    stepsPerTick: 4,
    ceiling: { ...LIMITS.organisation },
    requests: [],
    ...over,
  };
  if (!over.sessions) q.sessions = [demoSession()];
  for (const s of q.sessions) {
    if (s.key === "EXP-0001" && !q.steps[s.key]) q.steps[s.key] = demoSteps();
    if (s.key === "EXP-0001" && !q.findings[s.key]) q.findings[s.key] = demoFindings();
  }
  return q;
}

function exploreWorkflow(q: ExploreState, p4: P4State): Workflow {
  const wf = p4Workflow(p4);
  wf.stages = wf.stages.map((s) => (s.key === "discovery" && !q.g2 ? { ...s, status: "completed", gate: { ...s.gate!, status: "recommended" } } : s));
  const running = q.sessions.find((s) => s.status === "running" || s.status === "queued");
  const extra: StageState = { ...wf.stages[0], key: "exploratory", title: "Exploratory testing", phase: 6, available: true, status: running ? "running" : "not_started", current_version: null, gate: null, finished_at: null };
  wf.stages.push(extra);
  return wf;
}

function options(q: ExploreState): ExploreOptions {
  return {
    charters: [
      ...(q.changeSet ? [{ key: "change_set" as const, label: "New and changed pages from CHG-0001", pages: 3, change_set: { id: "cs-CHG-0001", key: "CHG-0001" }, disabled_reason: null }] : []),
      { key: "open_defects", label: "Pages with open defects", pages: 0, change_set: null, disabled_reason: "No page has an open defect." },
      { key: "all", label: "All discovered pages", pages: 4, change_set: null, disabled_reason: null },
      { key: "chosen", label: "Chosen pages", pages: null, change_set: null, disabled_reason: null },
    ],
    default_charter: q.changeSet ? "change_set" : "all",
    pages: PAGES,
    change_set: q.changeSet ? { id: "cs-CHG-0001", key: "CHG-0001" } : null,
    credentials_saved: q.credentials,
    limits: limits(q),
    host: HOST,
    netloc: NETLOC,
    what_it_does: WHAT_IT_DOES,
    statement: SHORT_STATEMENT,
  };
}

function limits(q: ExploreState) {
  const eff = { actions: Math.min(q.ceiling.actions, LIMITS.server.actions), minutes: Math.min(q.ceiling.minutes, LIMITS.server.minutes) };
  return { organisation: eff, server: LIMITS.server, stored: q.ceiling, default: eff, line: `Limits: up to ${eff.actions} actions and ${eff.minutes} minutes per session in this organisation.` };
}

/** Permissions as the server computes them for the person looking. */
function view(q: ExploreState, s: Session): Session {
  const member = q.role !== "viewer";
  const approver = member && q.canApprove;
  const active = s.status === "running" || s.status === "queued";
  return {
    ...s,
    permissions: {
      can_approve: approver && s.status === "awaiting_approval",
      can_stop: active && (approver || s.requested_by?.id === ME.id),
      can_withdraw: s.status === "awaiting_approval" && s.requested_by?.id === ME.id,
      can_request_again: member && !active && s.status !== "awaiting_approval",
      can_triage: member,
    },
  };
}

/** One tick of a running session: a few more steps, a finding at step 6, the end at the budget. */
function advance(q: ExploreState, s: Session) {
  if (s.status === "queued") {
    Object.assign(s, { status: "running", started_at: NOW, status_label: "Exploring · 0 of 60 actions" });
    return;
  }
  if (s.status !== "running") return;
  const p = s.progress;
  if (s.cancel_requested) {
    Object.assign(s, {
      status: "cancelled",
      status_label: `Stopped by ${ME.full_name}`,
      stopped_by: ME,
      finished_at: LATER,
      end_reason: "stopped",
      end_text: `Stopped by ${ME.full_name} after ${p.actions_used} actions. Steps and findings so far are kept.`,
      statement: exploreStatement(p.actions_used, Math.max(1, p.pages_explored)),
      cancel_requested: false,
    });
    return;
  }
  const steps = (q.steps[s.key] ??= []);
  const to = Math.min(p.actions_budget, p.actions_used + q.stepsPerTick);
  for (let n = p.actions_used + 1; n <= to; n++) {
    if (n === 6) {
      steps.push(step(6, "/offers", "Show details", "error", { observations: [{ kind: "problem", rule: "uncaught_exception", severity: "medium", text: 'Uncaught error after clicking button "Show details"' }], findings: [`${s.key}-01`] }));
      q.findings[s.key] = [demoFindings(s.key)[0]];
      Object.assign(p, { findings: 1, open_findings: 1, findings_by_severity: { high: 0, medium: 1, low: 0 } });
    } else if (n === 7) {
      steps.push(step(7, "/offers", "Add to basket", "blocked", { observations: [{ kind: "blocked", text: BLOCKED_BASKET.text }] }));
      p.blocked = 1;
      s.blocked = [{ ...BLOCKED_BASKET, step: 7 }];
    } else steps.push(step(n, n % 2 ? "/" : "/offers", `Menu item ${n}`, "ok"));
  }
  const last = steps[steps.length - 1];
  Object.assign(p, { actions_used: to, pages_explored: to > 4 ? 2 : 1, current_page: last?.page ?? "/", last_step: last ? { n: last.n, page: last.page, label: last.label, outcome: last.outcome, observation: last.observations[0]?.text ?? null } : null });
  s.elapsed_s = (s.elapsed_s ?? 0) + 5;
  s.status_label = `Exploring · ${to} of ${p.actions_budget} actions`;
  if (to >= p.actions_budget)
    Object.assign(s, { status: "completed", status_label: "Finished · budget used", end_reason: "budget", end_text: `Budget used: ${to} of ${p.actions_budget} actions`, finished_at: LATER, statement: exploreStatement(to, 2), elements_tried: to, coverage: [] });
}

/** Registered after the other mocks, so it answers the exploration routes, the workflow and /auth/me first. */
export async function mockExplore(page: Page, s: MockState, q: ExploreState, p4: P4State) {
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
    const byId = (id: string) => q.sessions.find((x) => x.id === id);

    if (path === "/auth/me" && s.user) return json(route, 200, { user: s.user, organisation: { id: "o1", name: s.org, slug: "acme" }, role: q.role, can_approve: q.canApprove });
    if (path === "/projects/p1/workflow") return json(route, 200, exploreWorkflow(q, p4));

    if (path === "/projects/p1/exploratory-sessions" && method === "GET") {
      const running = q.sessions.find((x) => x.status === "running" || x.status === "queued")?.key ?? null;
      const list: SessionList = {
        items: q.sessions.map((x) => view(q, x)),
        gate: q.g2 ? { ok: true, message: null } : { ok: false, message: "Exploration uses the pages discovery found. Approve Gate 2 first." },
        running,
        running_line: running ? `${running} is running. One session at a time per project.` : null,
        waiting: q.sessions.filter((x) => x.status === "awaiting_approval").map((x) => x.key),
        performance_running: null,
        queued_note: null,
        options: q.g2 ? options(q) : null,
        limits: limits(q),
        browser_available: q.browser,
        statement: SHORT_STATEMENT,
        permissions: { can_start: member, can_approve: approver, can_edit_limits: q.role === "owner" || q.role === "admin" },
      };
      return json(route, 200, list);
    }
    if (path === "/projects/p1/exploratory-sessions" && method === "POST") {
      record();
      if (q.startDelay) await new Promise((r) => setTimeout(r, q.startDelay));
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (!q.g2) return err(route, 409, "gate_blocked", "Approve Gate 2 first.");
      if (body.approve && !approver) return err(route, 403, "forbidden", "Approving signed-in exploration needs approval permission");
      const busy = q.conflictNext ?? q.sessions.find((x) => x.status === "running" || x.status === "queued")?.key;
      if (busy) {
        q.conflictNext = null;
        return err(route, 409, "conflict", `${busy} is already running on this project. One session at a time.`, { key: busy });
      }
      const waiting = q.sessions.find((x) => x.status === "awaiting_approval")?.key;
      if (waiting) return err(route, 409, "conflict", `${waiting} is waiting for approval. One session at a time.`, { key: waiting });
      const b = (body.budget ?? {}) as { actions?: unknown; minutes?: unknown };
      const lim = limits(q).organisation;
      if (typeof b.actions === "number" && b.actions > lim.actions) return err(route, 422, "validation_error", `Your organisation allows up to ${lim.actions} actions.`, [{ field: "actions", message: `Your organisation allows up to ${lim.actions} actions.` }]);
      if (body.signed_in && !q.credentials) return err(route, 422, "validation_error", "Save test credentials to explore signed in.", [{ field: "signed_in", message: "Save test credentials to explore signed in." }]);
      if (body.approve && String(body.confirm_text ?? "").trim().toLowerCase() !== HOST) return err(route, 422, "validation_error", `Type ${HOST} exactly to approve.`);
      const n = Math.max(0, ...q.sessions.map((x) => Number(x.key.slice(-4)))) + 1;
      const key = `EXP-${String(n).padStart(4, "0")}`;
      const budget = { actions: Number(b.actions ?? lim.actions), minutes: Number(b.minutes ?? lim.minutes) };
      const charterKey = String(body.charter ?? "change_set") as Session["charter"]["key"];
      const label = options(q).charters.find((c) => c.key === charterKey)?.label ?? "Chosen pages";
      const pages = charterKey === "chosen" ? ((body.pages as string[]) ?? []).length : 3;
      const signed = !!body.signed_in;
      const common: Partial<Session> = {
        charter: { key: charterKey, label, change_set: charterKey === "change_set" ? { id: "cs-CHG-0001", key: "CHG-0001" } : null },
        pages,
        budget,
        signed_in: signed,
        requested_by: ME,
        progress: progress({ actions_budget: budget.actions, minutes_budget: budget.minutes, pages_total: pages }),
        summary_sentence: `Explore ${pages} page${pages === 1 ? "" : "s"} on ${NETLOC}${signed ? " signed in with the saved test account" : ""}, for up to ${budget.actions} actions and ${budget.minutes} minutes.`,
      };
      const created =
        signed && !body.approve
          ? waitingSession(key, { ...common, id: `exp-${n}` })
          : runningSession(key, {
              ...common,
              id: `exp-${n}`,
              status: "queued",
              status_label: "Waiting to start",
              started_at: null,
              ...(signed ? { approved_by: ME, approval: { id: `apr-${n}`, key: `APR-000${n}`, status: "approved", expires_at: "2026-11-16T11:30:00Z", decided_by: ME, decided_at: NOW, comment: null, host_typed: true, self_approved: true, confirm_prompt: `Type ${HOST} to approve` } } : {}),
            });
      q.sessions.unshift(created);
      const message = created.status === "awaiting_approval" ? `${key} requested. Someone who can approve must approve it.` : signed ? `${key} requested and approved by ${ME.full_name}.` : `${key} started.`;
      return json(route, 201, { message, ...view(q, created) });
    }
    const byKey = path.match(/^\/projects\/p1\/quality-scans\/by-key\/(EXP-\d+)$/);
    if (byKey) {
      const x = q.sessions.find((y) => y.key === byKey[1]);
      if (!x) return err(route, 404, "not_found", `We couldn't find ${byKey[1]} in this project.`);
      advance(q, x);
      return json(route, 200, view(q, x));
    }
    const stepsM = path.match(/^\/quality-scans\/(exp-\d+)\/steps$/);
    if (stepsM) {
      const x = byId(stepsM[1]);
      if (!x) return err(route, 404, "not_found", "Session not found");
      const outcome = url.searchParams.get("outcome");
      const items = (q.steps[x.key] ?? []).filter((st) => !outcome || outcome.split(",").includes(st.outcome));
      return json(route, 200, { items });
    }
    const findingsM = path.match(/^\/quality-scans\/(exp-\d+)\/findings$/);
    if (findingsM) {
      const x = byId(findingsM[1]);
      return json(route, 200, { items: x ? (q.findings[x.key] ?? []) : [] });
    }
    const cancel = path.match(/^\/quality-scans\/(exp-\d+)\/cancel$/);
    if (cancel && method === "POST") {
      record();
      const x = byId(cancel[1])!;
      if (!member) return err(route, 403, "forbidden", "Viewers have read-only access");
      if (x.status !== "running" && x.status !== "queued") return err(route, 409, "conflict", `${x.key} isn't running`);
      x.cancel_requested = true;
      return json(route, 200, { message: `Stopping ${x.key}…`, scan: view(q, x) });
    }
    const withdraw = path.match(/^\/quality-scans\/(exp-\d+)\/withdraw$/);
    if (withdraw && method === "POST") {
      record();
      const x = byId(withdraw[1])!;
      Object.assign(x, { status: "rejected", status_label: "Withdrawn", end_text: "Request withdrawn. Nothing was sent to the site.", approval: { ...x.approval!, status: "rejected", comment: "Request withdrawn", decided_by: ME } });
      return json(route, 200, { message: "Request withdrawn. Nothing was sent to the site.", ...view(q, x) });
    }
    const decision = path.match(/^\/approvals\/(apr-\d+)\/decision$/);
    if (decision && method === "POST") {
      record();
      const x = q.sessions.find((y) => y.approval?.id === decision[1]);
      if (!x) return route.fallback();
      if (!approver) return err(route, 403, "forbidden", "Approving signed-in exploration needs approval permission");
      if (x.status === "expired") return err(route, 409, "conflict", "This request expired after 24 hours.");
      if (body.decision === "approve") {
        if (String(body.confirm_text ?? "").trim().toLowerCase() !== HOST) return err(route, 422, "validation_error", `Type ${HOST} exactly to approve.`);
        Object.assign(x, { status: "queued", status_label: "Waiting to start", approved_by: ME, approval: { ...x.approval!, status: "approved", decided_by: ME, decided_at: NOW, host_typed: true } });
      } else {
        if (!String(body.comment ?? "").trim()) return err(route, 422, "validation_error", "Say why this session shouldn't run.");
        Object.assign(x, { status: "rejected", status_label: "Not approved", end_text: "Not approved. Nothing was sent to the site.", approval: { ...x.approval!, status: "rejected", decided_by: ME, decided_at: NOW, comment: String(body.comment) } });
      }
      return json(route, 200, view(q, x));
    }
    const ev = path.match(/^\/evidence\/(ev-[ab]22)$/);
    if (ev) return json(route, 200, { id: ev[1], kind: "screenshot", mime: "image/png", size: 70, captured_at: NOW, content_url: `${API}/evidence/${ev[1]}/content?exp=1&sig=x`, sha256: "0", metadata: {} });
    if (/^\/evidence\/ev-[ab]22\/content$/.test(path)) return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "image/png" }, body: PNG });
    const triage = path.match(/^\/quality-findings\/(f-exp-\d+)\/triage$/);
    if (triage && method === "POST") {
      record();
      const f = Object.values(q.findings).flat().find((x) => x.id === triage[1])!;
      Object.assign(f, { status: body.status, status_reason: body.reason, status_by: ME });
      return json(route, 200, { message: "Finding updated.", finding: f });
    }
    const raise = path.match(/^\/quality-findings\/(f-exp-\d+)\/raise-defect$/);
    if (raise && method === "POST") {
      record();
      const f = Object.values(q.findings).flat().find((x) => x.id === raise[1])!;
      f.defect = { id: "def-0008", key: "DEF-0008", status: "draft", summary: f.title };
      return json(route, 201, { message: "DEF-0008 created as a draft.", defect: { id: "def-0008", key: "DEF-0008", summary: f.title } });
    }
    const os = path.match(/^\/organisations\/([^/]+)\/settings$/);
    if (os) {
      const load = { vus: 20, rps: 20, duration_s: 300 };
      if (method === "PATCH") {
        record();
        if (!(q.role === "owner" || q.role === "admin")) return err(route, 403, "forbidden", "Only owners and admins can change these limits.");
        const c = (body.exploration_ceiling ?? {}) as { actions: number; minutes: number };
        if (c.actions > LIMITS.server.actions) return err(route, 422, "validation_error", `This server allows up to ${LIMITS.server.actions} actions.`, [{ field: "actions", message: `This server allows up to ${LIMITS.server.actions} actions.` }]);
        q.ceiling = { actions: c.actions, minutes: c.minutes };
      }
      return json(route, 200, {
        load_ceiling: load,
        effective_ceiling: load,
        hard_cap: { vus: 50, rps: 50, duration_s: 600 },
        exploration_ceiling: q.ceiling,
        exploration_effective: limits(q).organisation,
        exploration_cap: LIMITS.server,
        can_edit: q.role === "owner" || q.role === "admin",
        ...(method === "PATCH" ? { message: "Exploration limits saved." } : {}),
      });
    }
    return route.fallback();
  });
}
