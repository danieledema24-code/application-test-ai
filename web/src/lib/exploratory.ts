// Exploratory testing (P6-03c; decisions D29, D30; design docs/design/P6-qa-analyst-phase6.md §9): the rule-based
// safe explorer's sessions (EXP-0001) as the API returns them (backend app/api/routers/exploratory.py,
// app/services/exploratory.py; api-contracts "Exploratory testing (as built, P6-03a)"). Numbers, statuses, the
// summary sentence and the honesty statement come from the API; this file only words the rest. Pure; unit-tested in
// tests/unit/phase6-explore.spec.ts.

import type { Tone } from "@/components/ui/StatusPill";
import type { Person } from "./execution";
import type { Finding } from "./nonfunctional";

type Uuid = string;
type IsoDate = string;

// ------------------------------------------------------------------ fixed text (§3.8, §9; never paraphrased)

/** EXPLORE_STATEMENT (§3.8). Finished sessions carry it from the API with their real numbers; this is the same text. */
export function exploreStatement(actions: number, pages: number): string {
  return `This session tried ${actions} actions on ${pages} pages within its budget. Exploration is a sample, not a complete test, and it never submits forms or sends data.`;
}
export const SHORT_STATEMENT = "Exploration is a sample, not a complete test.";
export const EXPLORE_INTRO =
  "Clicks around pages to find problems nobody wrote a test for: script errors, broken links, pages that fall over. It only clicks things that can't change data, never types or submits, and blocks anything the page tries to send.";
export const G2_FIRST_EXPLORE = "Exploration uses the pages discovery found. Approve Gate 2 first.";
export const NO_BROWSER = "Exploration can't run on this server: the Chromium browser isn't installed.";
export const OFFLINE_EXPLORE = "You're offline. Reconnect to start exploring.";
export const MEMBER_APPROVE_EXPLORE = "Approving signed-in exploration needs approval permission. Someone who can approve will see this request.";
export const MEMBER_REQUEST_LINE = "Nothing happens on the site until someone who can approve types the host and approves.";
export const SIGNED_IN_HELP = "Signed-in sessions need approval: someone who can approve types the host first. The sign-out link and button are never clicked.";
export const NO_CREDENTIALS = "Save test credentials to explore signed in.";
export const AUTO_DRAFT_LINE = "Drafted automatically: uncaught errors and high findings always get a draft for Gate 8.";
export const BLOCKED_NOTE = "The request was stopped before it left the browser. Nothing was sent.";
export const NOTHING_SENT = "Nothing was sent to the site.";
export const PAUSE_TIP = "Pauses the screen, not the session.";
export const STILL_STOPPING = "Still stopping… the browser is being shut down.";
export const CONNECTION_LOST = "Connection lost. Reconnecting… the session keeps running on the server.";

// ------------------------------------------------------------------ API shapes

export type SessionStatus = "awaiting_approval" | "rejected" | "expired" | "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type EndReason = "budget" | "time" | "exhausted" | "unreached" | "stopped" | "error" | null;
export type StepOutcome = "ok" | "no_effect" | "navigated" | "error" | "blocked";
export type Budget = { actions: number; minutes: number };
export type ExploreLimits = { organisation: Budget; server: Budget; stored: Budget; default: Budget; line: string };
export type LastStep = { n: number; page: string; label: string; outcome: StepOutcome; observation: string | null };
export type SessionProgress = {
  actions_used: number;
  actions_budget: number;
  minutes_budget: number;
  pages_explored: number;
  pages_total: number;
  current_page: string | null;
  last_step: LastStep | null;
  findings: number;
  findings_by_severity: { high: number; medium: number; low: number };
  open_findings: number;
  blocked: number;
  not_tried: number;
};
export type SessionApproval = {
  id: Uuid;
  key: string;
  status: "pending" | "approved" | "used" | "rejected" | "expired";
  expires_at: IsoDate;
  decided_by: Person;
  decided_at: IsoDate | null;
  comment: string | null;
  host_typed: boolean;
  self_approved: boolean;
  confirm_prompt: string;
};
/** A write the page tried, or a read of a sign-out/destructive address (`reason` set), stopped in the browser. */
export type BlockedItem = { request: string; method: string; path: string; after: string; step: number; text: string; reason: string | null };
export type NotTriedItem = { element: string; role: string; name: string; page: string; reason: string; fingerprint: string; destination?: string | null };
export type NeverReachedItem = { element: string; page: string };
export type CoverageRow = { page: string; actions: number; findings: number; not_tried: number; visited: boolean; reason: string | null };
export type Session = {
  id: Uuid;
  key: string;
  kind: "exploratory";
  status: SessionStatus;
  status_label: string;
  charter: { key: string | null; label: string | null; change_set: { id: string; key: string } | null };
  pages: number;
  budget: Budget;
  signed_in: boolean;
  summary_sentence: string | null;
  chosen_by: "rules" | "ai";
  generated_by: string;
  requested_by: Person;
  approved_by: Person;
  stopped_by: Person;
  created_at: IsoDate;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  elapsed_s: number | null;
  progress: SessionProgress;
  end_reason: EndReason;
  end_text: string | null;
  statement: string;
  error: string | null;
  cancel_requested: boolean;
  drafted: string[];
  approval: SessionApproval | null;
  permissions: { can_approve: boolean; can_stop: boolean; can_withdraw: boolean; can_request_again: boolean; can_triage: boolean };
  // Full form only (GET /quality-scans/{id}, by-key).
  host?: string | null;
  netloc?: string | null;
  what_it_does?: string[];
  page_list?: { page_id: string; url: string; path: string; requires_auth: boolean }[];
  left_out?: { page_id?: string; url: string; path?: string; reason: string }[];
  blocked?: BlockedItem[];
  not_tried?: NotTriedItem[];
  never_reached?: NeverReachedItem[];
  coverage?: CoverageRow[];
  elements_tried?: number;
  no_findings_line?: string | null;
  defects?: { key: string; summary: string; status: string }[];
};
export type Observation = { kind: "problem" | "blocked" | "blocked_navigation" | "navigated" | "error" | "dialog" | "no_effect"; text: string; rule?: string; severity?: string };
export type Step = {
  n: number;
  page: string;
  page_url: string;
  action: { id: string; kind: string; target: { role: string; name: string; fingerprint: string }; href?: string; label?: string };
  label: string | null;
  outcome: StepOutcome;
  observations: Observation[];
  evidence_ids: string[];
  findings: string[];
  chosen_by: "rules" | "ai";
  created_at: IsoDate;
};
export type Charter = { key: "change_set" | "open_defects" | "all" | "chosen"; label: string; pages: number | null; change_set: { id: string; key: string } | null; disabled_reason: string | null };
export type PageOption = { page_id: string; url: string; path: string; requires_auth: boolean; anonymous_reason: string | null; signed_in_reason: string | null };
export type ExploreOptions = {
  charters: Charter[];
  default_charter: Charter["key"];
  pages: PageOption[];
  change_set: { id: string; key: string } | null;
  credentials_saved: boolean;
  limits: ExploreLimits;
  host: string;
  netloc: string;
  what_it_does: string[];
  statement: string;
};
export type SessionList = {
  items: Session[];
  gate: { ok: boolean; message: string | null };
  running: string | null;
  running_line: string | null;
  waiting: string[];
  performance_running: string | null;
  queued_note: string | null;
  options: ExploreOptions | null;
  limits: ExploreLimits;
  browser_available: boolean;
  statement: string;
  permissions: { can_start: boolean; can_approve: boolean; can_edit_limits: boolean };
};
/** An exploratory finding: the shared quality finding with the explorer's details (P6-03a). */
export type ExploreFindingDetails = {
  observed?: string;
  subject?: string;
  steps?: string[];
  step?: number;
  steps_seen?: number[];
  console?: string[];
  network?: string[];
  action?: { kind: string; target?: { role?: string; name?: string }; label?: string } | null;
  category?: string;
};
export const findingDetails = (f: Pick<Finding, "details">): ExploreFindingDetails => (f.details ?? {}) as ExploreFindingDetails;

// ------------------------------------------------------------------ status and wording

export const SESSION_TONE: Record<SessionStatus, Tone> = {
  awaiting_approval: "amber",
  rejected: "grey",
  expired: "grey",
  queued: "blue",
  running: "blue",
  completed: "green",
  partial: "green",
  cancelled: "grey",
  failed: "red",
};

export const isActiveSession = (s: Pick<Session, "status"> | null | undefined) => !!s && (s.status === "queued" || s.status === "running");
export const isFinishedSession = (s: Pick<Session, "status"> | null | undefined) => !!s && ["completed", "partial", "cancelled", "failed"].includes(s.status);
/** Waiting, not approved, expired or withdrawn: nothing was sent to the site. */
export const neverRan = (s: Pick<Session, "status">) => ["awaiting_approval", "rejected", "expired"].includes(s.status);

/** Session page polling (SSE refreshes it sooner): 1 s while exploring, 2 s while waiting, then stop. */
export function sessionPoll(s: Pick<Session, "status"> | undefined): number {
  if (!s || s.status === "running") return 1000;
  if (s.status === "queued" || s.status === "awaiting_approval") return 2000;
  return 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 (2 medium)", "3 (1 high, 2 low)", "0". */
export function findingsText(p: Pick<SessionProgress, "findings" | "findings_by_severity">): string {
  if (!p.findings) return "0";
  const by = (["high", "medium", "low"] as const).filter((k) => p.findings_by_severity[k]).map((k) => `${p.findings_by_severity[k]} ${k}`);
  return by.length ? `${p.findings} (${by.join(", ")})` : String(p.findings);
}

/** "60 of 60 actions" (never ran: "—"). */
export function budgetUsedText(s: Pick<Session, "status" | "progress">): string {
  if (neverRan(s)) return "—";
  return `${s.progress.actions_used} of ${s.progress.actions_budget} actions`;
}

/** "New and changed pages from CHG-0001 (3)". */
export function whatExploredText(s: Pick<Session, "charter" | "pages">): string {
  return `${s.charter.label ?? "Pages"} (${s.pages})`;
}

function minutesShort(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** "23 of 60 actions · 3 min 40 s of 10 min · page 2 of 3" (§9.5). */
export function liveLine(s: Pick<Session, "progress" | "elapsed_s">): string {
  const p = s.progress;
  const page = p.pages_total ? ` · page ${Math.min(Math.max(p.pages_explored, 1), p.pages_total)} of ${p.pages_total}` : "";
  return `${p.actions_used} of ${p.actions_budget} actions · ${minutesShort(s.elapsed_s)} of ${p.minutes_budget} min${page}`;
}

/** Percentage of the action budget used (the bar beside the live line, aria-hidden). */
export function budgetPct(p: Pick<SessionProgress, "actions_used" | "actions_budget">): number {
  return p.actions_budget ? Math.min(100, Math.round((p.actions_used / p.actions_budget) * 100)) : 0;
}

/** Polite region at the end (§9.5): "EXP-0001 finished: 60 actions on 3 pages, 2 findings, 1 blocked write attempt". */
export function endAnnouncement(s: Pick<Session, "key" | "status" | "progress" | "end_text">): string {
  const p = s.progress;
  if (s.status === "cancelled") return s.end_text ?? `${s.key} stopped after ${plural(p.actions_used, "action")}.`;
  if (s.status === "failed") return `${s.key} didn't complete. Steps up to ${p.actions_used} are kept.`;
  return `${s.key} finished: ${plural(p.actions_used, "action")} on ${plural(p.pages_explored, "page")}, ${plural(p.findings, "finding")}, ${plural(p.blocked, "blocked write attempt")}`;
}

// The oracles' rule names (backend app/domain/exploratory/oracles.py RULE_NAMES).
export const RULE_NAMES: Record<string, string> = {
  server_error: "Server error",
  uncaught_exception: "Uncaught error",
  not_found: "Missing page",
  broken_text: "Broken value shown",
  console_error: "Console error",
  overflow: "Sideways scrolling",
  dialog_trap: "Dialog can't be closed",
  injection: "Text aimed at automated tools",
};

/** Polite region for a new finding (§9.5): "Finding on /offers: uncaught error, medium". */
export function findingAnnouncement(f: Pick<Finding, "path" | "rule_id" | "severity" | "title" | "details">): string {
  const what = findingDetails(f).category ?? RULE_NAMES[f.rule_id] ?? f.title;
  return `Finding on ${f.path}: ${what.charAt(0).toLowerCase()}${what.slice(1)}, ${f.severity}`;
}

export const OUTCOME_LABEL: Record<StepOutcome, string> = {
  ok: "OK",
  no_effect: "No visible effect",
  navigated: "Opened another page",
  error: "Problem found",
  blocked: "Blocked: tried to send data",
};

/** Step outcome as text (§3.6): "Problem found: uncaught error", "Blocked: tried to send data", "Blocked: navigation stopped". */
export function outcomeText(step: Pick<Step, "outcome" | "observations">): string {
  if (step.outcome === "error") {
    const p = step.observations.find((o) => o.kind === "problem");
    const name = p?.rule ? RULE_NAMES[p.rule] : null;
    return name ? `Problem found: ${name.toLowerCase()}` : OUTCOME_LABEL.error;
  }
  if (step.outcome === "blocked" && !step.observations.some((o) => o.kind === "blocked") && step.observations.some((o) => o.kind === "blocked_navigation"))
    return "Blocked: navigation stopped";
  return OUTCOME_LABEL[step.outcome] ?? step.outcome;
}

/** The step's action as the log shows it: 'Clicked button "Show details"'. */
export const stepAction = (step: Pick<Step, "label" | "action">) => step.label ?? step.action.label ?? `${step.action.kind} ${step.action.target?.name ?? ""}`.trim();

/** The live "Last step" block: "23 · Clicked button "Add to basket" on /offers" + its first observation. */
export function lastStepLines(l: LastStep | null | undefined): [string, string | null] | null {
  if (!l) return null;
  return [`${l.n} · ${l.label} on ${l.page}`, l.observation];
}

/** Screenshot alts (§9.7): "Before step 22: /offers before clicking 'Show details'." / "After …, showing 'Bundle price: £NaN'." */
export function screenshotAlt(role: "before" | "after", f: Pick<Finding, "path" | "rule_id" | "details">): string {
  const d = findingDetails(f);
  const t = d.action?.target;
  const kind = d.action?.kind;
  const verb =
    kind === "escape" ? "pressing Escape" : kind === "reload" ? "reloading the page" : kind === "link" ? `opening link '${t?.name ?? ""}'` : t?.name ? `clicking '${t.name}'` : "the step";
  const step = d.step ? ` step ${d.step}` : "";
  const showing = role === "after" && f.rule_id === "broken_text" && d.observed ? `, showing '${d.observed}'` : "";
  return `${role === "before" ? "Before" : "After"}${step}: ${f.path} ${role} ${verb}${showing}.`;
}

// ------------------------------------------------------------------ start dialog (§9.2)

/** Charters in the dialog: "New and changed pages from CHG-0001" only when a change set exists. */
export function charterChoices(o: Pick<ExploreOptions, "charters" | "change_set">): Charter[] {
  return o.charters.filter((c) => c.key !== "change_set" || !!o.change_set);
}

/** The radio label: "New and changed pages from CHG-0001 (3 pages)", "Chosen pages…". */
export function charterLabel(c: Charter): string {
  if (c.key === "chosen") return "Chosen pages…";
  return `${c.label} (${plural(c.pages ?? 0, "page")})`;
}

/** Default charter: the API's choice when it can be picked, else the first that can. */
export function defaultCharter(o: Pick<ExploreOptions, "charters" | "change_set" | "default_charter">): Charter["key"] {
  const list = charterChoices(o);
  const d = list.find((c) => c.key === o.default_charter && !c.disabled_reason);
  return d?.key ?? list.find((c) => !c.disabled_reason)?.key ?? "all";
}

/** Why a page can't be chosen in this session (null = it can). */
export const pageReason = (p: PageOption, signedIn: boolean) => (signedIn ? p.signed_in_reason : p.anonymous_reason);

const NOUN = { actions: ["action", "actions"], minutes: ["minute", "minutes"] } as const;

/** One budget value against the limits, with the server's wording (backend limits.budget_violations). */
export function budgetError(field: "actions" | "minutes", raw: string, limits: Pick<ExploreLimits, "organisation" | "server">): string | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1) return `Enter a whole number of ${NOUN[field][1]} (1 or more).`;
  const v = Number(t);
  const org = limits.organisation[field];
  const server = limits.server[field];
  const limit = Math.min(org, server);
  if (v > limit) return `${server < org ? "This server" : "Your organisation"} allows up to ${limit} ${limit === 1 ? NOUN[field][0] : NOUN[field][1]}.`;
  return null;
}

/** "Your organisation allows up to 60. This server allows up to 200." */
export function limitLine(field: "actions" | "minutes", limits: Pick<ExploreLimits, "organisation" | "server">): string {
  return `Your organisation allows up to ${limits.organisation[field]}. This server allows up to ${limits.server[field]}.`;
}

/** An organisation ceiling an owner/admin saves (§9.9), against the server cap (backend limits.ceiling_violations). */
export function ceilingError(field: "actions" | "minutes", raw: string, cap: Budget): string | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1) return `Enter a whole number of ${NOUN[field][1]} (1 or more).`;
  const top = cap[field];
  if (Number(t) > top) return `This server allows up to ${top} ${top === 1 ? NOUN[field][0] : NOUN[field][1]}.`;
  return null;
}

/** Client-side checks run on submit (§16.2): the first message per field, plus the chosen-pages rule. */
export function startErrors(
  v: { charter: Charter["key"] | null; pages: string[]; actions: string; minutes: string },
  limits: Pick<ExploreLimits, "organisation" | "server">,
): { charter?: string; pages?: string; actions?: string; minutes?: string } {
  const e: { charter?: string; pages?: string; actions?: string; minutes?: string } = {};
  if (!v.charter) e.charter = "Choose an option.";
  if (v.charter === "chosen" && v.pages.length === 0) e.pages = "Choose at least one page.";
  const a = budgetError("actions", v.actions, limits);
  const m = budgetError("minutes", v.minutes, limits);
  if (a) e.actions = a;
  if (m) e.minutes = m;
  return e;
}

/** The session key in a 409 "EXP-0002 is already running on this project. One session at a time." */
export function conflictKey(e: { details?: unknown; message?: string } | null | undefined): string | null {
  const d = e?.details as { key?: unknown } | null | undefined;
  if (d && typeof d === "object" && !Array.isArray(d) && typeof d.key === "string" && /^EXP-/.test(d.key)) return d.key;
  return e?.message?.match(/^(EXP-\d+) is already running/)?.[1] ?? null;
}

// ------------------------------------------------------------------ outside the section (§4.2–4.5)

/** Header status pill (§4.4): "Exploring: EXP-0001" (blue) or "EXP-0002 waiting for your approval" (amber). */
export function exploreHeaderPill(l: Pick<SessionList, "waiting" | "running"> | undefined, canApprove: boolean): { text: string; tone: "blue" | "amber" } | null {
  if (!l) return null;
  if (l.running) return { text: `Exploring: ${l.running}`, tone: "blue" };
  const w = l.waiting[0];
  if (w) return { text: `${w} waiting ${canApprove ? "for your approval" : "for approval by someone who can approve"}`, tone: "amber" };
  return null;
}

/** Lifecycle optional row (§4.3). */
export function exploreLifecycleStatus(l: Pick<SessionList, "items" | "waiting" | "running"> | undefined, g2: boolean, canApprove: boolean): string {
  if (!g2) return "Available after Gate 2";
  if (!l) return "Not run yet";
  const w = l.waiting[0];
  if (w) return `${w} waiting ${canApprove ? "for your approval" : "for approval by someone who can approve"}`;
  if (l.running) return "Exploring";
  const last = l.items.find((s) => isFinishedSession(s));
  if (!last) return "Not run yet";
  if (last.status === "cancelled") return "Stopped";
  if (last.status === "failed") return "Didn't complete";
  return `${last.key}: ${plural(last.progress.findings, "finding")}`;
}

/** Needs your attention rows (§4.5): a waiting signed-in session, then recent findings (7 days). */
export function exploreAttentionRows(
  l: Pick<SessionList, "items"> | undefined,
  base: string,
  canApprove: boolean,
  viewer: boolean,
  now = Date.now(),
): { text: string; action: string; href: string | null }[] {
  const rows: { text: string; action: string; href: string | null }[] = [];
  if (!l) return rows;
  const w = l.items.find((s) => s.status === "awaiting_approval");
  if (w) {
    const what = (w.summary_sentence ?? "").replace(/^Explore /, "").replace(/ signed in with the saved test account/, "").replace(/, for up to .*$/, "");
    if (canApprove && !viewer) rows.push({ text: `${w.key} is waiting for your approval: signed-in exploration of ${what}.`, action: `Review ${w.key}`, href: `${base}/execution/exploratory/${w.key}` });
    else rows.push({ text: `${w.key} is waiting for approval by someone who can approve.`, action: viewer ? "" : `Open ${w.key}`, href: viewer ? null : `${base}/execution/exploratory/${w.key}` });
  }
  const f = l.items.find((s) => isFinishedSession(s) && s.progress.open_findings > 0 && s.finished_at && now - Date.parse(s.finished_at) < 7 * 24 * 3600 * 1000);
  if (f) rows.push({ text: `${f.key} found ${plural(f.progress.open_findings, "problem")}.`, action: `Open ${f.key}`, href: `${base}/execution/exploratory/${f.key}` });
  return rows;
}

/** Overview line (§4.5): "EXP-0001 · 15 Nov · 2 findings (2 medium) · 1 blocked write attempt". */
export function exploreGlanceLine(l: Pick<SessionList, "items"> | undefined, fmtDate: (iso: string) => string): string {
  const s = l?.items.find((x) => isFinishedSession(x)) ?? l?.items[0];
  if (!s) return "No exploratory session yet.";
  if (!isFinishedSession(s)) return `${s.key} · ${s.status_label}`;
  const p = s.progress;
  const sev = findingsText(p).replace(/^\d+ ?/, "");
  return `${s.key} · ${fmtDate(s.finished_at ?? s.created_at)} · ${plural(p.findings, "finding")}${sev ? ` ${sev}` : ""} · ${plural(p.blocked, "blocked write attempt")}`;
}

/** Exploration is reachable once Gate 2 was approved and the `exploratory` stage exists (the API answers 409 before). */
export function exploreReachable(wf: { stages: { key: string; available?: boolean; gate?: { key: string; status: string; ever_approved?: boolean } | null }[] } | null | undefined): boolean {
  if (!wf?.stages.find((x) => x.key === "exploratory")?.available) return false;
  const g2 = wf.stages.find((s) => s.gate?.key === "G2")?.gate;
  return !!g2 && (g2.ever_approved === true || g2.status === "approved");
}
