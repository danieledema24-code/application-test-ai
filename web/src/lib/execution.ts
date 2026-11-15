// Test Execution, Gate 7 and failure analysis (P4-05…P4-08; design docs/design/P4-qa-analyst-phase4.md §3, §7–§9):
// API shapes as built (backend app/api/routers/execution.py, automation.py preview) and the pure helpers the screens
// use. Values come from the API; this file only words them.

import type { IsoDate, Uuid } from "@/lib/contract";
import type { Tone } from "@/components/ui/StatusPill";

export type RunStatus = "awaiting_authorisation" | "rejected" | "queued" | "running" | "passed" | "failed" | "error" | "cancelled";
export type ResultState = "passed" | "failed" | "error" | "flaky" | "skipped" | "blocked" | "running" | "waiting";
export type Classification =
  | "application_defect"
  | "selector_failure"
  | "script_defect"
  | "test_data_issue"
  | "environment_failure"
  | "network_failure"
  | "flaky"
  | "unknown";
export type Confidence = "high" | "medium" | "low";
export type Browser = "chromium" | "firefox" | "webkit";
export type Viewport = "desktop" | "mobile";
export type Suite = "smoke" | "regression" | "all_approved";
export type Person = { id?: Uuid; full_name?: string; email?: string } | null;

export type SideEffectLine = { kind: string; form: string | null; text: string; count: number; case_keys: string[] };
export type ScopeCase = {
  key: string;
  title: string;
  test_case_id: Uuid;
  script_id: Uuid;
  script_version: number;
  path: string;
  side_effects: string[];
  needs_approval: string[];
  signs_in: boolean;
  retried: boolean;
  blocked: string | null;
};
export type ApprovalNeed = { kind: "external_transaction" | "destructive"; title: string; case_keys: string[]; cases: { key: string; title: string; step: number | string | null; quote: string | null }[] };

/** `POST /projects/{id}/execution-runs/preview` and `run.scope` (frozen at request time). */
export type RunScope = {
  target_origin: string;
  target_host: string;
  selection: { suite: Suite | null; case_keys: string[] | null };
  browsers: Browser[];
  viewports: Viewport[];
  viewport_sizes: Record<string, { width: number; height: number }>;
  bundle_version: number | null;
  cases: ScopeCase[];
  left_out: { key: string; title: string; reason: string; code: string }[];
  blocked: { key: string; title: string; reason: string }[];
  tests: number;
  limit: number;
  over_limit: boolean;
  limit_message: string | null;
  estimated_seconds: number;
  side_effects: SideEffectLine[];
  risky: "yes" | "no";
  risky_line: string | null;
  approvals_needed: ApprovalNeed[];
  signs_in: boolean;
  not_retried: string[];
  installed_browsers: Partial<Record<Browser, boolean>>;
  scope_hash: string;
};

export type Totals = Partial<Record<"passed" | "failed" | "error" | "flaky" | "skipped" | "blocked", number>> & { tests?: number; finished?: number };

export type RunSummary = {
  id: Uuid;
  key: string;
  mode: "automated" | "manual";
  status: RunStatus;
  selection: { suite?: Suite | null; case_keys?: string[] | null } | null;
  selection_label: string;
  browsers: Browser[];
  viewports: Viewport[];
  tests: number;
  totals: Totals;
  /** First side-effect line of the scope, e.g. "May submit the Contact us form (if the application does not block it)". */
  side_effect?: string | null;
  notes: string | null;
  requested_by: Person;
  authorisation: { decision: "approve" | "reject"; by: Person; at: IsoDate; comment: string | null; self_authorised: boolean } | null;
  created_at: IsoDate;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  duration_ms: number | null;
  error: string | null;
  bundle_version: number | null;
};

export type RunList = {
  items: RunSummary[];
  waiting: string[];
  running: string | null;
  permissions: { can_request: boolean; can_authorise: boolean };
};

export type ApprovalCard = {
  id: Uuid;
  key: string;
  kind: "external_transaction" | "destructive";
  title: string;
  status: "pending" | "approved" | "rejected" | "expired" | "used";
  scope: { case_keys: string[]; cases?: ApprovalNeed["cases"]; target_host?: string } | null;
  decided_by: Person;
  decided_at: IsoDate | null;
  comment: string | null;
  expires_at: IsoDate | null;
  confirm_prompt: string | null;
  can_decide: boolean;
};

export type TestRow = {
  id: Uuid | null;
  key: string;
  case_key: string;
  title: string | null;
  test_case_id: Uuid | null;
  browser: Browser;
  viewport: string;
  status: ResultState;
  attempts: number | null;
  duration_ms: number | null;
  failed_step: { n: number; title: string } | null;
  reason: string | null;
  error_reason?: string | null;
  classification: Classification | null;
  confidence: Confidence | null;
  defect: { id: Uuid; key: string; status: string; summary: string; occurrence?: boolean } | null;
  retried: boolean;
};

export type AnalysisGroup = {
  classification: Classification;
  label: string;
  items: { result_id: Uuid; result_key: string; case_key: string | null; signal: string; defect: TestRow["defect"]; fix_suggestion?: boolean }[];
};

export type RunDetail = RunSummary & {
  scope: RunScope | null;
  config: { workers?: number; retries?: number; test_timeout_s?: number };
  approvals: ApprovalCard[];
  tests_rows: TestRow[];
  progress: { finished: number; passed: number; flaky: number; failed: number } | null;
  request_problem: string | null;
  waiting_for: string | null;
  cancelled_by: Person;
  analysis: {
    status: string;
    output: { analysed: number; by_classification: Partial<Record<Classification, number>>; groups: AnalysisGroup[]; drafted: string[] } | null;
    error: string | null;
    generated_by: string | null;
  } | null;
  permissions: { can_authorise: boolean; can_cancel: boolean; can_rerun: boolean; is_requester: boolean };
};

export type Signal = { code: string; detail: string; observed: boolean; evidence: string[] };
export type Analysis = {
  classification: Classification;
  label: string;
  confidence: Confidence;
  signals: Signal[];
  summary: string;
  possible_causes: string[];
  next_steps: string[];
  hypothesis: boolean;
  generated_by: string;
  case_key: string | null;
  evidence_refs?: { evidence_id: Uuid; kind: string }[];
  defect?: TestRow["defect"];
  no_defect?: "flaky" | "low_confidence" | "not_application";
  overridden?: {
    by: Uuid;
    by_user?: Person;
    at: IsoDate;
    reason: string;
    previous: { classification: Classification | null; confidence: Confidence | null; label: string | null };
  };
};

export type StepRun = { n: number; title: string; status: "passed" | "failed" | "skipped"; duration_ms: number; error: string | null };
export type AttemptDetail = { attempt: number; status: string; duration_ms: number; steps: StepRun[]; error: string | null };
export type ResultEvidence = { id: Uuid; kind: string; mime: string; size: number; captured_at: IsoDate; content_url: string; attempt: number | null; masked?: boolean; removed?: string | null };

export type ResultDetail = TestRow & {
  run: { id: Uuid; key: string; status: RunStatus } | null;
  case: { id: Uuid; key: string; title: string; version: number; expected_result: string; provenance: string; steps: { n: number; action: string; expected: string }[] } | null;
  script: { id: Uuid; path: string; version: number } | null;
  attempt_details: AttemptDetail[];
  error: string | null;
  actual_result: string | null;
  page_state: { url?: string; title?: string; heading?: string; messages?: string[]; browser?: string };
  checks_by_step: Record<string, { helper: string; kind: string; args: string[] }[]>;
  evidence: ResultEvidence[];
  signs_in: boolean;
  analysis: Analysis | null;
  heal_suggestions: HealSuggestion[];
  permissions: { can_reclassify: boolean; can_raise_defect: boolean; can_accept_fix: boolean };
};

/** Fix suggestion for an "Element not found" result (design §9.3): only the locator changes, never a check. */
export type HealCandidate = {
  by: string;
  name: string;
  role: string;
  expression: string;
  status: "unique";
  recommended: boolean;
  diff: { old: string; new: string };
};
export type HealSuggestion = {
  asset_path: string;
  getter: string;
  element: string;
  page_path: string;
  old_expression: string;
  reason: string;
  candidates: HealCandidate[];
  note: string;
  accepted: { n: number; by: Uuid; version: number } | null;
  /** Current version of the page object; accepting creates the next one. */
  asset_version: number | null;
};
export type AcceptFixResponse = {
  message: string;
  asset: { id: Uuid; path: string; version: number };
  scripts_to_validate: string[];
  result: ResultDetail;
};

// ---- Vocabulary (design §3, §19) -------------------------------------------------------------------------

export const RESULT_STATUS: Record<ResultState, { label: string; tone: Tone }> = {
  passed: { label: "Passed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  error: { label: "Error", tone: "red" },
  flaky: { label: "Flaky (passed on retry)", tone: "amber" },
  skipped: { label: "Skipped", tone: "grey" },
  blocked: { label: "Blocked", tone: "amber" },
  running: { label: "Running", tone: "blue" },
  waiting: { label: "Waiting to start", tone: "grey" },
};

export const CLASSIFICATIONS: Record<Classification, { label: string; meaning: string; tone: Tone }> = {
  application_defect: { label: "Likely bug in the application", meaning: "The test did every step, and the site didn't do what the test case expects.", tone: "red" },
  selector_failure: { label: "Element not found", meaning: "The test couldn't find a field or button. The page may have changed since discovery.", tone: "amber" },
  script_defect: { label: "Problem in the test script", meaning: "The script itself broke, so the site wasn't really tested.", tone: "amber" },
  test_data_issue: { label: "Test data problem", meaning: "The site rejected a value the test treats as valid.", tone: "amber" },
  environment_failure: { label: "Environment problem", meaning: "Something around the test stopped it: sign-in refused, a safety block, or a time limit.", tone: "amber" },
  network_failure: { label: "Site unreachable", meaning: "The site couldn't be reached, or the connection dropped.", tone: "amber" },
  flaky: { label: "Flaky", meaning: "It failed, then passed on retry. Not treated as a bug.", tone: "amber" },
  unknown: { label: "Cause unclear", meaning: "The evidence doesn't point to one cause. A person needs to look.", tone: "grey" },
};

/** Order of the "What failed and why" groups (§9.1): application bug, cause unclear, then the rest. */
export const CLASSIFICATION_ORDER: Classification[] = [
  "application_defect",
  "unknown",
  "selector_failure",
  "script_defect",
  "test_data_issue",
  "environment_failure",
  "network_failure",
  "flaky",
];

export const CONFIDENCE_TEXT: Record<Confidence, string> = { high: "High", medium: "Medium", low: "Low" };

export const BROWSER_TEXT: Record<Browser, string> = { chromium: "Chromium", firefox: "Firefox", webkit: "WebKit" };
export const VIEWPORT_TEXT: Record<Viewport, string> = { desktop: "Desktop", mobile: "Mobile" };
export const SUITE_TEXT: Record<Suite, string> = { smoke: "Smoke", regression: "Regression", all_approved: "All automated" };

/** "1440x900" (the plan's size) or "desktop" → "Desktop" / "Mobile". */
export function sizeText(v: string): string {
  if (v === "desktop" || v === "1440x900") return "Desktop";
  if (v === "mobile" || v === "390x844") return "Mobile";
  return v.replace("x", " × ");
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const name = (p: Person) => p?.full_name || p?.email || "someone";

/** Run status pill text (§3): "Finished · 3 failed", "Didn't complete". */
export function runStatusText(r: Pick<RunSummary, "status" | "totals" | "mode">): { label: string; tone: Tone; status: string } {
  const failed = (r.totals.failed ?? 0) + (r.totals.error ?? 0);
  switch (r.status) {
    case "awaiting_authorisation":
      return { label: "Waiting for authorisation", tone: "amber", status: "awaiting_approval" };
    case "rejected":
      return { label: "Not authorised", tone: "grey", status: "rejected" };
    case "queued":
      return { label: "Waiting to start", tone: "blue", status: "queued" };
    case "running":
      return { label: "Running", tone: "blue", status: "running" };
    case "passed": {
      // No failures, but tests that didn't run (blocked, skipped) mean it isn't "all passed" (QA P4-BUG-07).
      const notRun = notRunParts(r.totals);
      if (notRun.length) return { label: `Finished · no failures · ${notRun.join(" · ")}`, tone: "amber", status: "completed" };
      return { label: "Finished · all passed", tone: "green", status: "completed" };
    }
    case "failed":
      return { label: `Finished · ${failed} failed`, tone: "red", status: "failed" };
    case "error":
      return { label: "Didn't complete", tone: "red", status: "error" };
    default:
      return { label: "Cancelled", tone: "grey", status: "cancelled" };
  }
}

/** "20 passed · 3 failed · 1 flaky" (text first; flaky counted separately, never as passed). */
export function resultsSentence(t: Totals, tests?: number): string {
  const parts: string[] = [];
  const order: (keyof Totals)[] = ["passed", "failed", "flaky", "error", "blocked", "skipped"];
  for (const k of order) {
    const n = t[k] ?? 0;
    if (n) parts.push(`${n} ${k === "error" ? plural(n, "error") : k}`);
  }
  if (!parts.length) return `${tests ?? t.tests ?? 0} ${plural(tests ?? t.tests ?? 0, "test")}`;
  return parts.join(" · ");
}

/** Blocked and skipped counts, only when there are any: tests that didn't run are never left out of a finish line. */
function notRunParts(t: Totals): string[] {
  return [t.blocked ? `${t.blocked} blocked` : "", t.skipped ? `${t.skipped} skipped` : ""].filter(Boolean);
}

/** "Finished: 20 passed · 3 failed · 1 flaky · 0 errors · 7 blocked." (§8.5) */
export function finishedSentence(t: Totals): string {
  return `Finished: ${[`${t.passed ?? 0} passed`, `${t.failed ?? 0} failed`, `${t.flaky ?? 0} flaky`, `${t.error ?? 0} ${plural(t.error ?? 0, "error")}`, ...notRunParts(t)].join(" · ")}.`;
}

/** "RUN-0003 finished: 20 passed, 3 failed, 1 flaky, 0 errors" (polite region, §8.4). */
export function finishedAnnouncement(key: string, t: Totals): string {
  return `${key} finished: ${[`${t.passed ?? 0} passed`, `${t.failed ?? 0} failed`, `${t.flaky ?? 0} flaky`, `${t.error ?? 0} ${plural(t.error ?? 0, "error")}`, ...notRunParts(t)].join(", ")}`;
}

/** Screen-reader text after "Show n tests": "that submit the Contact us form" (the verb agrees with n). */
export function thatClause(text: string, n: number): string {
  const lower = text.charAt(0).toLowerCase() + text.slice(1);
  if (n === 1) return `that ${lower}`;
  return `that ${lower.replace(/^(submits|signs|creates)\b/, (w) => w.slice(0, -1))}`;
}

/** "Chromium · Desktop 1440 × 900" for a scope or run. */
export function targetsText(browsers: Browser[], viewports: Viewport[]): string {
  const sizes = viewports.map((v) => (v === "mobile" ? "Mobile 390 × 844" : "Desktop 1440 × 900"));
  return [browsers.map((b) => BROWSER_TEXT[b] ?? b).join(", "), sizes.join(", ")].join(" · ");
}

/** "about 4 minutes" from the server estimate. */
export function aboutDuration(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const m = Math.round(seconds / 60);
  return `about ${m} ${plural(m, "minute")}`;
}

/** "21 tests will run: 21 test cases × 1 browser × 1 screen size." (§7.1) */
export function scopeSentence(s: Pick<RunScope, "tests" | "cases" | "browsers" | "viewports">): string {
  const c = s.cases.length;
  const b = s.browsers.length;
  const v = s.viewports.length;
  return `${s.tests} ${plural(s.tests, "test")} will run: ${c} test ${plural(c, "case")} × ${b} ${plural(b, "browser")} × ${v} screen ${plural(v, "size")}.`;
}

/** The Retries line (§7.2, D9), with the "not retried" cases named. */
export function retriesLine(s: Pick<RunScope, "not_retried" | "approvals_needed">): string {
  const base = "A failing test runs once more to tell real failures from flaky ones, so it may submit a form twice.";
  if (!s.not_retried.length) return base;
  const why = s.approvals_needed.some((a) => a.kind === "external_transaction") ? "may make a payment" : "may delete something";
  return `${base} ${s.not_retried.join(", ")} ${s.not_retried.length === 1 ? "isn't" : "aren't"} retried because ${s.not_retried.length === 1 ? "it" : "they"} ${why}.`;
}

/** Typed host confirmation (§7.3): case-insensitive, trimmed. */
export function hostMatches(typed: string, host: string): boolean {
  return typed.trim().toLowerCase() === host.trim().toLowerCase();
}

export type ApprovalChoice = { kind: ApprovalNeed["kind"]; decision: "approve" | "reject" | null; confirm_text: string };

/** Why Authorise is disabled, or null (§7.3: every card decided; approvals need the typed host). */
export function approvalsBlocker(choices: ApprovalChoice[], host: string): string | null {
  const undecided = choices.filter((c) => c.decision === null).length;
  if (undecided) return `Decide ${undecided} separate ${plural(undecided, "approval")} above to continue.`;
  if (choices.some((c) => c.decision === "approve" && !hostMatches(c.confirm_text, host))) return `Type ${host} exactly to confirm.`;
  return null;
}

/** The G7 decision line: "Requested and authorised by {name}" when the approver requested it themselves. */
export function authorisationLine(r: Pick<RunSummary, "authorisation" | "requested_by">): string | null {
  const a = r.authorisation;
  if (!a) return null;
  if (a.decision === "reject") return `Not authorised by ${name(a.by)}${a.comment ? `: '${a.comment}'` : ""}. Nothing ran.`;
  return `${a.self_authorised ? "Requested and authorised" : "Authorised"} by ${name(a.by)}`;
}

/** The role-aware waiting text (§4.3). */
export function waitingText(key: string, canAuthorise: boolean): string {
  return canAuthorise ? `${key} is waiting for your authorisation` : `${key} is waiting for authorisation by someone who can approve gates`;
}

/** Progress line (§8.4): "9 of 24 finished · 7 passed · 1 failed · 1 flaky · 15 to go". */
export function progressSentence(rows: TestRow[]): { finished: number; total: number; text: string } {
  const total = rows.length;
  const count = (st: ResultState) => rows.filter((r) => r.status === st).length;
  const finished = rows.filter((r) => r.status !== "running" && r.status !== "waiting").length;
  const parts = [`${finished} of ${total} finished`, `${count("passed")} passed`];
  const failed = count("failed") + count("error");
  if (failed) parts.push(`${failed} failed`);
  if (count("flaky")) parts.push(`${count("flaky")} flaky`);
  parts.push(`${total - finished} to go`);
  return { finished, total, text: parts.join(" · ") };
}

/**
 * Milestones for the polite region (§8.4): each failure, every 25 % of progress. Never per frame or per pass.
 * Pure: compares the previous rows with the new ones.
 */
export function milestones(prev: TestRow[], next: TestRow[]): string[] {
  const out: string[] = [];
  const before = new Map(prev.map((r) => [r.key, r.status]));
  for (const r of next) {
    const was = before.get(r.key);
    if ((r.status === "failed" || r.status === "error") && was !== undefined && was !== r.status) out.push(`${r.case_key} failed`);
  }
  const quarter = (rows: TestRow[]) => {
    const p = progressSentence(rows);
    return p.total ? Math.floor((p.finished / p.total) * 4) : 0;
  };
  const q0 = quarter(prev);
  const q1 = quarter(next);
  if (prev.length && q1 > q0 && q1 < 4) out.push(`${q1 * 25}% of tests finished`);
  return out;
}

/** Status-specific result headers (§8.6). */
export function resultHeader(r: Pick<ResultDetail, "status" | "reason" | "error" | "attempts" | "error_reason">): string | null {
  if (r.status === "flaky") return `Failed on attempt 1, passed on attempt ${r.attempts ?? 2}. Treated as flaky, not as a bug.`;
  if (r.status === "blocked") return `Not run: ${(r.reason ?? "needs saved test credentials").replace(/^Needs/, "needs")}.`;
  if (r.status === "skipped") return `Not run: ${r.reason ?? "skipped"}.`;
  if (r.status === "error") return `The test couldn't finish: ${plainError(r.error_reason ?? r.error)}.`;
  return null;
}

function plainError(e: string | null | undefined): string {
  const t = (e ?? "").trim();
  if (!t) return "no reason was recorded";
  if (/run cancelled/i.test(t)) return "the run was cancelled";
  if (/time limit/i.test(t)) return "the run time limit was reached";
  if (/worker/i.test(t) && /stop/i.test(t)) return "the test runner stopped";
  return t.split("\n")[0].replace(/\.$/, "").slice(0, 200);
}

/** "Attempt 1: failed at step 5 · Attempt 2: failed at step 5" */
export function attemptsSummary(a: AttemptDetail[]): string {
  return a
    .map((x) => {
      const f = x.steps.find((s) => s.status === "failed");
      return `Attempt ${x.attempt}: ${x.status === "passed" ? "passed" : f ? `failed at step ${f.n}` : x.status}`;
    })
    .join(" · ");
}

/** "failed on both attempts (2 of 2)" for the result header line. */
export function attemptsPhrase(r: Pick<ResultDetail, "status" | "attempts" | "attempt_details">): string {
  const n = r.attempts ?? 0;
  if (!n) return "not run";
  const failed = r.attempt_details.filter((a) => a.status !== "passed").length;
  if (r.status === "passed") return n === 1 ? "passed on attempt 1" : `passed on attempt ${n}`;
  if (r.status === "flaky") return `passed on attempt ${n} of ${n}`;
  if (n === 2 && failed === 2) return "failed on both attempts (2 of 2)";
  return `failed ${failed || n} of ${n} ${plural(n, "attempt")}`;
}

/** "No defect drafted" lines (§9.2). */
export const NO_DEFECT_TEXT: Record<NonNullable<Analysis["no_defect"]>, string> = {
  flaky: "No defect drafted: flaky results aren't treated as bugs.",
  not_application: "No defect drafted: the likely cause is the test, not the application.",
  low_confidence: "No defect drafted: confidence is low. Look at the evidence, then raise a defect if it's a real bug.",
};

/** Consequence line in Change the cause (§9.2). */
export function reclassifyConsequence(to: Classification, from: Classification, defectKey: string | null): string | null {
  if (to === "application_defect" && !defectKey) return "A defect draft will be created for review at Gate 8.";
  if (from === "application_defect" && to !== "application_defect" && defectKey) return `${defectKey} stays as a draft. Reject it at Gate 8 if it isn't a bug.`;
  return null;
}

/** The "What failed and why" groups in display order, with the item counts (§9.1). */
export function orderedGroups(groups: AnalysisGroup[]): AnalysisGroup[] {
  return [...groups].sort((a, b) => CLASSIFICATION_ORDER.indexOf(a.classification) - CLASSIFICATION_ORDER.indexOf(b.classification));
}

/** "Started by · Authorised by" text for the runs list. */
export function whoText(r: RunSummary): string {
  const by = name(r.requested_by);
  if (r.mode === "manual") return `${by} · not needed (manual)`;
  if (!r.authorisation) return `${by} · —`;
  if (r.authorisation.decision === "reject") return `${by} · not authorised`;
  return `${by} · ${r.authorisation.self_authorised ? "self-authorised" : name(r.authorisation.by)}`;
}

/** Network log lines from the platform fixture ("[time] HTTP 200 GET url", "[time] FAILED GET url — why",
 * "[time] BLOCKED by policy url (reason)") into table rows (§8.7). Text only; nothing is fetched. */
export type NetRow = { time: string; method: string; url: string; status: string; blocked: boolean; failed: boolean };
const STAMP = /^\[([^\]]*)\]\s*/;
export function parseNetwork(text: string): NetRow[] {
  const rows: NetRow[] = [];
  for (const raw of text.split("\n")) {
    const time = raw.trim().match(STAMP)?.[1] ?? "";
    const line = raw.trim().replace(STAMP, "");
    let m = line.match(/^HTTP (\d{3}) ([A-Z]+) (\S+)/);
    if (m) {
      rows.push({ time, method: m[2], url: m[3], status: m[1], blocked: false, failed: Number(m[1]) >= 400 });
      continue;
    }
    m = line.match(/^BLOCKED by policy (\S+)/i);
    if (m) {
      rows.push({ time, method: "", url: m[1], status: "Blocked", blocked: true, failed: true });
      continue;
    }
    m = line.match(/^FAILED ([A-Z]+) (\S+)(?: — (.*))?$/);
    if (m) rows.push({ time, method: m[1], url: m[2], status: m[3] ? `Failed: ${m[3]}` : "Failed", blocked: false, failed: true });
  }
  return rows;
}

/** "Blocked by safety policy: {host} isn't an approved site." */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Console lines ("[time] error: text") with their level as text. */
export type ConsoleLine = { time: string; level: string; text: string };
export function parseConsole(text: string): ConsoleLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim() && l.trim() !== "No console messages.")
    .map((raw) => {
      const time = raw.trim().match(STAMP)?.[1] ?? "";
      const l = raw.trim().replace(STAMP, "");
      const m = l.match(/^(error|warning|warn|info|log|debug|pageerror):\s*(.*)$/i);
      if (!m) return { time, level: "log", text: l };
      const lv = m[1].toLowerCase();
      return { time, level: lv === "warn" ? "warning" : lv === "pageerror" ? "error" : lv, text: m[2] };
    });
}

/** Where the run page stands (§8.5). */
export function runStateCopy(r: RunDetail): { tone: "info" | "neutral" | "danger"; title: string } | null {
  const unfinished = r.tests_rows.filter((x) => x.status === "error" && (x.error_reason ?? "").length > 0).length;
  if (r.status === "rejected" && r.authorisation) return { tone: "neutral", title: authorisationLine(r) ?? "Not authorised. Nothing ran." };
  if (r.status === "queued")
    return { tone: "info", title: r.waiting_for ? `Authorised. Waiting for a free test runner; ${r.waiting_for} is still running.` : "Authorised. Waiting for a free test runner." };
  if (r.status === "cancelled") {
    if (!r.started_at) return { tone: "neutral", title: "Request withdrawn. Nothing ran." };
    const finished = r.tests_rows.filter((x) => !["running", "waiting"].includes(x.status) && !/cancel/i.test(x.error_reason ?? "")).length;
    return { tone: "neutral", title: `Cancelled by ${name(r.cancelled_by)}${r.finished_at ? ` at ${timeOf(r.finished_at)}` : ""}. ${finished} ${plural(finished, "test")} finished; the rest show 'Error: run cancelled'.` };
  }
  if (r.status === "error") {
    if (/time limit/i.test(r.error ?? "")) return { tone: "danger", title: "The run stopped at its 30-minute limit. Unfinished tests show 'Error: run time limit reached'." };
    if (/expired/i.test(r.error ?? "")) return { tone: "neutral", title: r.error ?? "This request expired. Nothing ran." };
    return { tone: "danger", title: `The run didn't complete: ${plainError(r.error)}. Results that finished are kept; the other ${unfinished} ${plural(unfinished, "test")} show 'Error'.` };
  }
  return null;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export const FINISHED: RunStatus[] = ["passed", "failed", "error", "cancelled", "rejected"];
export const isActive = (s: RunStatus) => s === "queued" || s === "running";

// ---- Project-wide run and defect state (design §4.3): lifecycle G7/G8, header pills, Overview and Dashboard -------

export type ExecSummary = {
  /** Run keys waiting for G7, oldest first as the API lists them. */
  waiting: string[];
  /** Tests in the first waiting run, for "24 tests" in the attention row. */
  waitingTests: number;
  waitingSideEffect: string | null;
  running: string | null;
  /** The latest run that left the request stage (authorised, rejected or withdrawn runs excluded when not started). */
  latest: RunSummary | null;
  /** Latest run authorised (G7 done). */
  latestAuthorised: boolean;
  drafts: number;
  confirmedOpen: number;
  /** Any failure analysis or defect yet (G8 "Not started" before that). */
  analysed: boolean;
};

/** SWR keys behind the header, sidebar and Overview run state (the run list and the draft-defect count). They are
 * revalidated with the project, so authorising or cancelling a run updates "waiting for your authorisation" at once
 * (QA P4-BUG-11) instead of after the 15 s poll. */
export function isExecSummaryKey(projectId: string, key: unknown): boolean {
  if (typeof key !== "string") return false;
  return [`/projects/${projectId}/execution-runs`, `/projects/${projectId}/defects`].some((p) => key === p || key.startsWith(`${p}?`));
}

export function execSummary(
  runs: Pick<RunList, "items" | "waiting" | "running"> | undefined,
  defects: { counts: Partial<Record<string, number>>; finished_runs?: number } | undefined,
): ExecSummary {
  const items = runs?.items ?? [];
  const first = items.find((r) => r.key === runs?.waiting[0]);
  const started = items.filter((r) => r.status !== "awaiting_authorisation" && r.status !== "rejected" && !(r.status === "cancelled" && !r.started_at));
  const latest = started[0] ?? null;
  const counts = defects?.counts ?? {};
  const anyDefect = Object.values(counts).some((n) => (n ?? 0) > 0);
  return {
    waiting: runs?.waiting ?? [],
    waitingTests: first?.tests ?? 0,
    waitingSideEffect: first?.side_effect ?? null,
    running: runs?.running ?? null,
    latest,
    latestAuthorised: latest?.authorisation?.decision === "approve",
    drafts: counts.draft ?? 0,
    confirmedOpen: counts.confirmed ?? 0,
    analysed: anyDefect || items.some((r) => r.finished_at && ((r.totals.failed ?? 0) > 0 || (r.totals.error ?? 0) > 0)),
  };
}

/** "RUN-0003 · 13 Nov 14:20 · 20 passed · 3 failed · 1 flaky" (Overview "Last run"). */
export function lastRunLine(r: RunSummary, when: (iso: string | null) => string): string {
  return `${r.key} · ${when(r.finished_at ?? r.started_at ?? r.created_at)} · ${resultsSentence(r.totals, r.tests)}`;
}

/** "20 of 24 passed · 13 Nov" (Dashboard "Last run"); never a bare percentage. */
export function lastRunShort(r: { tests: number; totals: Totals; finished_at: IsoDate | null; started_at?: IsoDate | null }, date: (iso: string | null) => string): string {
  const total = r.tests || r.totals.tests || 0;
  return `${r.totals.passed ?? 0} of ${total} passed · ${date(r.finished_at ?? r.started_at ?? null)}`;
}
