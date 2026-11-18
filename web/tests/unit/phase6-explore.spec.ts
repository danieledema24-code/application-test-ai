// Unit tests for the exploratory workspace logic (P6-03c; design P6 §9, §16; decisions D29, D30, D35).
import { expect, test } from "@playwright/test";
import {
  budgetError,
  budgetPct,
  budgetUsedText,
  ceilingError,
  charterChoices,
  charterLabel,
  conflictKey,
  defaultCharter,
  endAnnouncement,
  exploreAttentionRows,
  exploreGlanceLine,
  exploreHeaderPill,
  exploreLifecycleStatus,
  exploreReachable,
  exploreStatement,
  findingAnnouncement,
  findingsText,
  isActiveSession,
  isFinishedSession,
  lastStepLines,
  limitLine,
  liveLine,
  neverRan,
  outcomeText,
  pageReason,
  screenshotAlt,
  sessionPoll,
  startErrors,
  whatExploredText,
  type Charter,
  type Session,
  type SessionProgress,
} from "@/lib/exploratory";
import { CHECK_DRAFT_SOURCES, checkHref, environmentLine, isCheckDraft, nfOccurrences } from "@/lib/defects";

const progress = (over: Partial<SessionProgress> = {}): SessionProgress => ({
  actions_used: 60,
  actions_budget: 60,
  minutes_budget: 10,
  pages_explored: 3,
  pages_total: 3,
  current_page: null,
  last_step: null,
  findings: 2,
  findings_by_severity: { high: 0, medium: 2, low: 0 },
  open_findings: 2,
  blocked: 1,
  not_tried: 1,
  ...over,
});

const sess = (over: Partial<Session> = {}): Session =>
  ({
    id: "exp-1",
    key: "EXP-0001",
    kind: "exploratory",
    status: "completed",
    status_label: "Finished · budget used",
    charter: { key: "change_set", label: "New and changed pages from CHG-0001", change_set: { id: "c1", key: "CHG-0001" } },
    pages: 3,
    budget: { actions: 60, minutes: 10 },
    signed_in: false,
    summary_sentence: null,
    created_at: "2026-11-15T10:00:00Z",
    finished_at: "2026-11-15T10:06:12Z",
    elapsed_s: 372,
    progress: progress(),
    end_reason: "budget",
    end_text: null,
    ...over,
  }) as Session;

const limits = { organisation: { actions: 60, minutes: 10 }, server: { actions: 200, minutes: 20 } };

test.describe("exploratory statement and status helpers", () => {
  test("the honesty statement carries the real numbers (D35)", () => {
    expect(exploreStatement(60, 3)).toBe(
      "This session tried 60 actions on 3 pages within its budget. Exploration is a sample, not a complete test, and it never submits forms or sends data.",
    );
    // Fixed text, mirrored from backend limits.EXPLORE_STATEMENT: never paraphrased, so no singular form.
    expect(exploreStatement(1, 1)).toContain("tried 1 actions on 1 pages");
  });

  test("active, finished and never-ran states", () => {
    expect(isActiveSession({ status: "queued" })).toBe(true);
    expect(isActiveSession({ status: "running" })).toBe(true);
    expect(isActiveSession({ status: "awaiting_approval" })).toBe(false);
    expect(isActiveSession(null)).toBe(false);
    for (const s of ["completed", "partial", "cancelled", "failed"] as const) expect(isFinishedSession({ status: s })).toBe(true);
    expect(isFinishedSession({ status: "rejected" })).toBe(false);
    for (const s of ["awaiting_approval", "rejected", "expired"] as const) expect(neverRan({ status: s })).toBe(true);
    expect(neverRan({ status: "cancelled" })).toBe(false);
  });

  test("polling: at least every 2 s while running or waiting, off when finished (AC: refresh ≤ 2 s)", () => {
    expect(sessionPoll({ status: "running" })).toBeLessThanOrEqual(2000);
    expect(sessionPoll({ status: "queued" })).toBeLessThanOrEqual(2000);
    expect(sessionPoll({ status: "awaiting_approval" })).toBeLessThanOrEqual(2000);
    expect(sessionPoll(undefined)).toBeLessThanOrEqual(2000);
    expect(sessionPoll({ status: "completed" })).toBe(0);
    expect(sessionPoll({ status: "rejected" })).toBe(0);
  });

  test("list cells: findings by severity, budget used, what was explored", () => {
    expect(findingsText(progress())).toBe("2 (2 medium)");
    expect(findingsText(progress({ findings: 3, findings_by_severity: { high: 1, medium: 0, low: 2 } }))).toBe("3 (1 high, 2 low)");
    expect(findingsText(progress({ findings: 0 }))).toBe("0");
    expect(budgetUsedText(sess())).toBe("60 of 60 actions");
    expect(budgetUsedText(sess({ status: "rejected" }))).toBe("—");
    expect(whatExploredText(sess())).toBe("New and changed pages from CHG-0001 (3)");
  });

  test("live line, budget bar and last step (§9.5)", () => {
    const s = sess({ status: "running", elapsed_s: 220, progress: progress({ actions_used: 23, pages_explored: 2 }) });
    expect(liveLine(s)).toBe("23 of 60 actions · 3 min 40 s of 10 min · page 2 of 3");
    expect(liveLine(sess({ elapsed_s: 0, progress: progress({ actions_used: 0, pages_explored: 0 }) }))).toBe("0 of 60 actions · 0 s of 10 min · page 1 of 3");
    expect(liveLine(sess({ elapsed_s: 120 }))).toContain("2 min of 10 min");
    expect(budgetPct(progress({ actions_used: 15 }))).toBe(25);
    expect(budgetPct(progress({ actions_used: 90 }))).toBe(100);
    expect(budgetPct(progress({ actions_budget: 0 }))).toBe(0);
    expect(lastStepLines(null)).toBeNull();
    expect(lastStepLines({ n: 23, page: "/offers", label: 'Clicked button "Add to basket"', outcome: "blocked", observation: "Blocked POST /basket" })).toEqual([
      '23 · Clicked button "Add to basket" on /offers',
      "Blocked POST /basket",
    ]);
  });

  test("announcements: end of session and new findings", () => {
    expect(endAnnouncement(sess())).toBe("EXP-0001 finished: 60 actions on 3 pages, 2 findings, 1 blocked write attempt");
    expect(endAnnouncement(sess({ status: "cancelled", end_text: "Stopped by A after 12 actions. Steps and findings so far are kept." }))).toBe(
      "Stopped by A after 12 actions. Steps and findings so far are kept.",
    );
    expect(endAnnouncement(sess({ status: "failed", progress: progress({ actions_used: 23 }) }))).toBe("EXP-0001 didn't complete. Steps up to 23 are kept.");
    expect(findingAnnouncement({ path: "/offers", rule_id: "uncaught_exception", severity: "medium", title: "x", details: {} } as never)).toBe(
      "Finding on /offers: uncaught error, medium",
    );
  });

  test("step outcomes are text, never colour alone (§3.6)", () => {
    expect(outcomeText({ outcome: "error", observations: [{ kind: "problem", text: "x", rule: "uncaught_exception" }] })).toBe("Problem found: uncaught error");
    expect(outcomeText({ outcome: "error", observations: [] })).toBe("Problem found");
    expect(outcomeText({ outcome: "blocked", observations: [{ kind: "blocked", text: "POST /basket" }] })).toBe("Blocked: tried to send data");
    expect(outcomeText({ outcome: "blocked", observations: [{ kind: "blocked_navigation", text: "/logout" }] })).toBe("Blocked: navigation stopped");
    expect(outcomeText({ outcome: "no_effect", observations: [] })).toBe("No visible effect");
  });

  test("screenshot alts name the page, the step and what was shown (§9.7)", () => {
    const f = { path: "/offers", rule_id: "broken_text", details: { step: 22, observed: "Bundle price: £NaN", action: { kind: "click", target: { name: "Show details" } } } };
    expect(screenshotAlt("before", f as never)).toBe("Before step 22: /offers before clicking 'Show details'.");
    expect(screenshotAlt("after", f as never)).toBe("After step 22: /offers after clicking 'Show details', showing 'Bundle price: £NaN'.");
    expect(screenshotAlt("after", { ...f, rule_id: "uncaught_exception" } as never)).toBe("After step 22: /offers after clicking 'Show details'.");
    expect(screenshotAlt("before", { path: "/", rule_id: "x", details: { step: 3, action: { kind: "escape" } } } as never)).toBe("Before step 3: / before pressing Escape.");
  });
});

test.describe("start dialog logic (§9.2, §16.2)", () => {
  const charters: Charter[] = [
    { key: "change_set", label: "New and changed pages from CHG-0001", pages: 3, change_set: { id: "c", key: "CHG-0001" }, disabled_reason: null },
    { key: "open_defects", label: "Pages with open defects", pages: 0, change_set: null, disabled_reason: "No page has an open defect." },
    { key: "all", label: "All discovered pages", pages: 12, change_set: null, disabled_reason: null },
    { key: "chosen", label: "Chosen pages", pages: null, change_set: null, disabled_reason: null },
  ];

  test("charters: the change-set option only with a change set; default falls back to the first selectable", () => {
    expect(charterChoices({ charters, change_set: null }).map((c) => c.key)).toEqual(["open_defects", "all", "chosen"]);
    expect(charterLabel(charters[0])).toBe("New and changed pages from CHG-0001 (3 pages)");
    expect(charterLabel(charters[3])).toBe("Chosen pages…");
    expect(defaultCharter({ charters, change_set: { id: "c", key: "CHG-0001" } as never, default_charter: "change_set" })).toBe("change_set");
    expect(defaultCharter({ charters, change_set: null, default_charter: "change_set" })).toBe("all");
    expect(defaultCharter({ charters, change_set: null, default_charter: "open_defects" })).toBe("all");
  });

  test("page reasons depend on signed in or not", () => {
    const p = { page_id: "p", url: "u", path: "/account", requires_auth: true, anonymous_reason: "needs sign-in", signed_in_reason: null };
    expect(pageReason(p, false)).toBe("needs sign-in");
    expect(pageReason(p, true)).toBeNull();
  });

  test("budget limits: inline line and server wording for over-limit values", () => {
    expect(limitLine("actions", limits)).toBe("Your organisation allows up to 60. This server allows up to 200.");
    expect(budgetError("actions", "60", limits)).toBeNull();
    expect(budgetError("actions", "61", limits)).toBe("Your organisation allows up to 60 actions.");
    expect(budgetError("minutes", "25", { organisation: { actions: 60, minutes: 30 }, server: { actions: 200, minutes: 20 } })).toBe("This server allows up to 20 minutes.");
    expect(budgetError("actions", "1.5", limits)).toBe("Enter a whole number of actions (1 or more).");
    expect(budgetError("actions", "0", limits)).toBe("Enter a whole number of actions (1 or more).");
    expect(budgetError("minutes", "", limits)).toBe("Enter a whole number of minutes (1 or more).");
    expect(budgetError("minutes", "2", { organisation: { actions: 60, minutes: 1 }, server: { actions: 200, minutes: 20 } })).toBe("Your organisation allows up to 1 minute.");
  });

  test("startErrors: chosen pages need one page; each field gets its first message", () => {
    expect(startErrors({ charter: "change_set", pages: [], actions: "60", minutes: "10" }, limits)).toEqual({});
    expect(startErrors({ charter: "chosen", pages: [], actions: "61", minutes: "x" }, limits)).toEqual({
      pages: "Choose at least one page.",
      actions: "Your organisation allows up to 60 actions.",
      minutes: "Enter a whole number of minutes (1 or more).",
    });
    expect(startErrors({ charter: null, pages: [], actions: "1", minutes: "1" }, limits)).toEqual({ charter: "Choose an option." });
  });

  test("a 409 names the running session from details, else from the message", () => {
    expect(conflictKey({ details: { key: "EXP-0002" } })).toBe("EXP-0002");
    expect(conflictKey({ message: "EXP-0003 is already running on this project. One session at a time." })).toBe("EXP-0003");
    expect(conflictKey({ details: { key: "LT-0001" }, message: "Something else" })).toBeNull();
    expect(conflictKey(null)).toBeNull();
  });

  test("organisation ceiling against the server cap (§9.9)", () => {
    const cap = { actions: 200, minutes: 20 };
    expect(ceilingError("actions", "200", cap)).toBeNull();
    expect(ceilingError("actions", "250", cap)).toBe("This server allows up to 200 actions.");
    expect(ceilingError("minutes", "-1", cap)).toBe("Enter a whole number of minutes (1 or more).");
  });
});

test.describe("outside the section (§4.2–4.5)", () => {
  const list = (items: Session[], running: string | null = null, waiting: string[] = []) => ({ items, running, waiting });

  test("header pill: exploring before waiting; wording by permission", () => {
    expect(exploreHeaderPill(undefined, true)).toBeNull();
    expect(exploreHeaderPill(list([], null, []), true)).toBeNull();
    expect(exploreHeaderPill(list([], "EXP-0002", ["EXP-0004"]), true)).toEqual({ text: "Exploring: EXP-0002", tone: "blue" });
    expect(exploreHeaderPill(list([], null, ["EXP-0004"]), true)).toEqual({ text: "EXP-0004 waiting for your approval", tone: "amber" });
    expect(exploreHeaderPill(list([], null, ["EXP-0004"]), false)?.text).toBe("EXP-0004 waiting for approval by someone who can approve");
  });

  test("lifecycle optional row", () => {
    expect(exploreLifecycleStatus(undefined, false, true)).toBe("Available after Gate 2");
    expect(exploreLifecycleStatus(list([]), true, true)).toBe("Not run yet");
    expect(exploreLifecycleStatus(list([], "EXP-0002"), true, true)).toBe("Exploring");
    expect(exploreLifecycleStatus(list([sess()]), true, true)).toBe("EXP-0001: 2 findings");
    expect(exploreLifecycleStatus(list([sess({ status: "cancelled" })]), true, true)).toBe("Stopped");
    expect(exploreLifecycleStatus(list([sess({ status: "failed" })]), true, true)).toBe("Didn't complete");
  });

  test("attention rows: waiting request for approvers, others read; recent findings within 7 days", () => {
    const waiting = sess({
      key: "EXP-0004",
      status: "awaiting_approval",
      summary_sentence: "Explore 3 pages on localhost:4100 signed in with the saved test account, for up to 60 actions and 10 minutes.",
    });
    const now = Date.parse("2026-11-17T00:00:00Z");
    const rows = exploreAttentionRows(list([waiting, sess()]), "/projects/p1", true, false, now);
    expect(rows).toEqual([
      { text: "EXP-0004 is waiting for your approval: signed-in exploration of 3 pages on localhost:4100.", action: "Review EXP-0004", href: "/projects/p1/execution/exploratory/EXP-0004" },
      { text: "EXP-0001 found 2 problems.", action: "Open EXP-0001", href: "/projects/p1/execution/exploratory/EXP-0001" },
    ]);
    expect(exploreAttentionRows(list([waiting]), "/projects/p1", false, true, now)).toEqual([
      { text: "EXP-0004 is waiting for approval by someone who can approve.", action: "", href: null },
    ]);
    expect(exploreAttentionRows(list([sess()]), "/p", true, false, Date.parse("2026-12-01T00:00:00Z"))).toEqual([]);
  });

  test("overview glance line", () => {
    expect(exploreGlanceLine(undefined, (x) => x)).toBe("No exploratory session yet.");
    expect(exploreGlanceLine(list([sess()]), () => "15 Nov")).toBe("EXP-0001 · 15 Nov · 2 findings (2 medium) · 1 blocked write attempt");
    expect(exploreGlanceLine(list([sess({ status: "running", status_label: "Exploring" })]), () => "")).toBe("EXP-0001 · Exploring");
  });

  test("reachable only with the exploratory stage and Gate 2 approved at least once", () => {
    const wf = (g2: string, ever = false, available = true) => ({
      stages: [
        { key: "discovery", gate: { key: "G2", status: g2, ever_approved: ever } },
        { key: "exploratory", available, gate: null },
      ],
    });
    expect(exploreReachable(wf("approved"))).toBe(true);
    expect(exploreReachable(wf("stale", true))).toBe(true);
    expect(exploreReachable(wf("pending"))).toBe(false);
    expect(exploreReachable(wf("approved", true, false))).toBe(false);
    expect(exploreReachable(null)).toBe(false);
  });
});

test.describe("defects from exploration (§9.8)", () => {
  test("exploratory drafts are check drafts (Accepted risk allowed), functional ones are not", () => {
    expect(CHECK_DRAFT_SOURCES).toContain("exploratory");
    expect(isCheckDraft("exploratory")).toBe(true);
    expect(isCheckDraft("accessibility")).toBe(true);
    expect(isCheckDraft("analysis")).toBe(false);
    expect(isCheckDraft(null)).toBe(false);
  });

  test("the Open link goes to the session page for EXP- keys", () => {
    expect(checkHref("p1", { scan_key: "EXP-0001" })).toBe("/projects/p1/execution/exploratory/EXP-0001");
    expect(checkHref("p1", { scan_key: "A11Y-0001" })).toBe("/projects/p1/non-functional/checks/A11Y-0001");
    expect(checkHref("p1", { run_key: "LT-0001" })).toBe("/projects/p1/non-functional/load-tests/LT-0001");
    expect(checkHref("p1", {})).toBeNull();
  });

  test("environment line and occurrences name the session and step", () => {
    const d = { source: "exploratory", environment: { url: "http://localhost:4100/offers", browser: "Chromium", viewport: "1440x900", scan_key: "EXP-0001", step: 22 } };
    expect(environmentLine(d as never, (x) => x)).toBe("http://localhost:4100/offers · Chromium · 1440x900 · EXP-0001 step 22");
    expect(nfOccurrences({ environment: { occurrences: [{ scan_key: "EXP-0002", findings: ["a", "b"] }] } } as never)).toEqual(["EXP-0002 · 2 findings"]);
  });
});
