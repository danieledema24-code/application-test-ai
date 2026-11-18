import { expect, test } from "@playwright/test";
import {
  CLASSIFICATIONS,
  RESULT_STATUS,
  approvalsBlocker,
  attemptsPhrase,
  attemptsSummary,
  authorisationLine,
  finishedAnnouncement,
  finishedSentence,
  thatClause,
  hostMatches,
  isExecSummaryKey,
  milestones,
  orderedGroups,
  parseConsole,
  parseNetwork,
  progressSentence,
  reclassifyConsequence,
  resultHeader,
  resultsSentence,
  retriesLine,
  runStateCopy,
  runStatusText,
  scopeSentence,
  waitingText,
  whoText,
  type RunDetail,
  type RunSummary,
  type TestRow,
} from "../../src/lib/execution";
import { bulkPlan, bulkQuestion, emptyDefectsText, nextUndecided, prefillFrom, reproText, type DefectRow } from "../../src/lib/defects";
import { sectionBadge } from "../../src/lib/sections";
import { execSummary, lastRunLine, lastRunShort } from "../../src/lib/execution";
import { buildLifecycle, subjectGateText, activeStage, waitingGateStage } from "../../src/lib/lifecycle";
import { attentionRows } from "../../src/lib/attention";
import type { StageState, Workflow } from "../../src/lib/contract";


const row = (key: string, status: TestRow["status"], over: Partial<TestRow> = {}): TestRow => ({
  id: status === "waiting" || status === "running" ? null : key,
  key,
  case_key: `TC-${key.slice(-2)}`,
  title: null,
  test_case_id: null,
  browser: "chromium",
  viewport: "1440x900",
  status,
  attempts: null,
  duration_ms: null,
  failed_step: null,
  reason: null,
  classification: null,
  confidence: null,
  defect: null,
  retried: true,
  ...over,
});

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "r1",
  key: "RUN-0003",
  mode: "automated",
  status: "failed",
  selection: { suite: "regression" },
  selection_label: "Regression",
  browsers: ["chromium"],
  viewports: ["desktop"],
  tests: 24,
  totals: { passed: 20, failed: 3, flaky: 1, error: 0 },
  notes: null,
  requested_by: { full_name: "M. Member" },
  authorisation: { decision: "approve", by: { full_name: "A. Approver" }, at: "2026-11-13T14:15:00Z", comment: null, self_authorised: false },
  created_at: "2026-11-13T14:14:00Z",
  started_at: "2026-11-13T14:16:00Z",
  finished_at: "2026-11-13T14:20:00Z",
  duration_ms: 252000,
  error: null,
  bundle_version: 2,
  ...over,
});

test.describe("Phase 4 · execution vocabulary (design P4 §3)", () => {
  test("result, run and cause labels", () => {
    expect(RESULT_STATUS.flaky.label).toBe("Flaky (passed on retry)");
    expect(RESULT_STATUS.blocked.tone).toBe("amber");
    expect(CLASSIFICATIONS.application_defect.label).toBe("Likely bug in the application");
    expect(CLASSIFICATIONS.unknown.label).toBe("Cause unclear");
    expect(runStatusText(run()).label).toBe("Finished · 3 failed");
    expect(runStatusText(run({ status: "passed" })).label).toBe("Finished · all passed");
    expect(runStatusText(run({ status: "awaiting_authorisation" })).label).toBe("Waiting for authorisation");
    expect(runStatusText(run({ status: "error" })).label).toBe("Didn't complete");
    expect(runStatusText(run({ status: "rejected" })).label).toBe("Not authorised");
  });

  test("flaky is counted separately, never as passed", () => {
    expect(resultsSentence({ passed: 20, failed: 3, flaky: 1 })).toBe("20 passed · 3 failed · 1 flaky");
    expect(finishedSentence({ passed: 20, failed: 3, flaky: 1, error: 0 })).toBe("Finished: 20 passed · 3 failed · 1 flaky · 0 errors.");
    expect(finishedAnnouncement("RUN-0003", { passed: 20, failed: 3, flaky: 1 })).toBe("RUN-0003 finished: 20 passed, 3 failed, 1 flaky, 0 errors");
  });

  test("blocked tests are never 'all passed' and always in the finish line (QA P4-BUG-07)", () => {
    const t = { passed: 12, failed: 0, flaky: 0, error: 0, blocked: 7 };
    expect(runStatusText(run({ status: "passed", totals: t })).label).toBe("Finished · no failures · 7 blocked");
    expect(runStatusText(run({ status: "passed", totals: t })).tone).toBe("amber");
    expect(finishedSentence(t)).toBe("Finished: 12 passed · 0 failed · 0 flaky · 0 errors · 7 blocked.");
    expect(finishedAnnouncement("RUN-0002", t)).toBe("RUN-0002 finished: 12 passed, 0 failed, 0 flaky, 0 errors, 7 blocked");
  });

  test("the run list and draft count are refreshed with the project (QA P4-BUG-11)", () => {
    expect(isExecSummaryKey("p1", "/projects/p1/execution-runs?limit=20")).toBe(true);
    expect(isExecSummaryKey("p1", "/projects/p1/defects?limit=1&status=draft")).toBe(true);
    expect(isExecSummaryKey("p1", "/projects/p1/execution-runs/by-key/RUN-0004")).toBe(false);
    expect(isExecSummaryKey("p1", "/projects/p2/execution-runs?limit=20")).toBe(false);
    expect(isExecSummaryKey("p1", ["/projects/p1/execution-runs"])).toBe(false);
  });

  test("'Show n tests that …' agrees with n (QA P4-BUG-12)", () => {
    expect(thatClause("Submits the Contact us form", 4)).toBe("that submit the Contact us form");
    expect(thatClause("Submits the Contact us form", 1)).toBe("that submits the Contact us form");
    expect(thatClause("Signs in with the saved test account", 7)).toBe("that sign in with the saved test account");
    expect(thatClause("May submit the Contact us form (if the application does not block it)", 10)).toBe(
      "that may submit the Contact us form (if the application does not block it)",
    );
  });

  test("G7 wording: requested and authorised by the same person, role-aware waiting", () => {
    expect(authorisationLine(run())).toBe("Authorised by A. Approver");
    expect(authorisationLine(run({ authorisation: { decision: "approve", by: { full_name: "A. Approver" }, at: "", comment: null, self_authorised: true } }))).toBe("Requested and authorised by A. Approver");
    expect(authorisationLine(run({ authorisation: { decision: "reject", by: { full_name: "A. Approver" }, at: "", comment: "Wrong site", self_authorised: false } }))).toBe("Not authorised by A. Approver: 'Wrong site'. Nothing ran.");
    expect(waitingText("RUN-0004", true)).toBe("RUN-0004 is waiting for your authorisation");
    expect(waitingText("RUN-0004", false)).toBe("RUN-0004 is waiting for authorisation by someone who can approve gates");
    expect(whoText(run())).toBe("M. Member · A. Approver");
    expect(whoText(run({ authorisation: null }))).toBe("M. Member · —");
  });
});

test.describe("Phase 4 · run dialog and approvals (design P4 §7)", () => {
  test("scope sentence and retries line (D9)", () => {
    const scope = { tests: 21, cases: new Array(21).fill(null), browsers: ["chromium" as const], viewports: ["desktop" as const] };
    expect(scopeSentence(scope as never)).toBe("21 tests will run: 21 test cases × 1 browser × 1 screen size.");
    expect(retriesLine({ not_retried: [], approvals_needed: [] })).toBe("A failing test runs once more to tell real failures from flaky ones, so it may submit a form twice.");
    expect(retriesLine({ not_retried: ["TC-0044"], approvals_needed: [{ kind: "external_transaction", title: "", case_keys: ["TC-0044"], cases: [] }] })).toContain("TC-0044 isn't retried because it may make a payment.");
  });

  test("typed host: case-insensitive, trimmed; every card decided before authorising", () => {
    expect(hostMatches("  Shop.Example.com ", "shop.example.com")).toBe(true);
    expect(hostMatches("shop.example.org", "shop.example.com")).toBe(false);
    expect(approvalsBlocker([{ kind: "external_transaction", decision: null, confirm_text: "" }], "shop.example.com")).toBe("Decide 1 separate approval above to continue.");
    expect(approvalsBlocker([{ kind: "destructive", decision: "approve", confirm_text: "wrong" }], "shop.example.com")).toBe("Type shop.example.com exactly to confirm.");
    expect(approvalsBlocker([{ kind: "destructive", decision: "approve", confirm_text: "shop.example.com" }], "shop.example.com")).toBeNull();
    expect(approvalsBlocker([{ kind: "destructive", decision: "reject", confirm_text: "" }], "shop.example.com")).toBeNull();
  });
});

test.describe("Phase 4 · live progress and results (design P4 §8)", () => {
  test("progress line and milestones: failures and every 25 %, never per pass", () => {
    const before = [row("R-01", "running"), row("R-02", "waiting"), row("R-03", "waiting"), row("R-04", "waiting")];
    const after = [row("R-01", "failed"), row("R-02", "running"), row("R-03", "waiting"), row("R-04", "waiting")];
    expect(progressSentence(after).text).toBe("1 of 4 finished · 0 passed · 1 failed · 3 to go");
    expect(milestones(before, after)).toEqual(["TC-01 failed", "25% of tests finished"]);
    const passOnly = [row("R-01", "failed"), row("R-02", "passed"), row("R-03", "waiting"), row("R-04", "waiting")];
    expect(milestones(after, passOnly)).toEqual(["50% of tests finished"]);
    expect(milestones(passOnly, passOnly)).toEqual([]);
  });

  test("status headers and attempts", () => {
    expect(resultHeader({ status: "flaky", reason: null, error: null, attempts: 2 })).toBe("Failed on attempt 1, passed on attempt 2. Treated as flaky, not as a bug.");
    expect(resultHeader({ status: "blocked", reason: "Needs saved test credentials", error: null, attempts: 0 })).toBe("Not run: needs saved test credentials.");
    expect(resultHeader({ status: "error", reason: null, error: "Run cancelled", attempts: 0, error_reason: "Run cancelled" })).toBe("The test couldn't finish: the run was cancelled.");
    // QA P4-BUG-06: a test that was running when the run was cancelled.
    expect(resultHeader({ status: "error", reason: null, error: "Stopped: run cancelled", attempts: 1, error_reason: "Stopped: run cancelled" })).toBe("The test couldn't finish: the run was cancelled.");
    expect(resultHeader({ status: "failed", reason: null, error: null, attempts: 2 })).toBeNull();
    const steps = (failAt: number | null) => [1, 2].map((n) => ({ n, title: `S${n}`, status: n === failAt ? ("failed" as const) : ("passed" as const), duration_ms: 1, error: null }));
    const details = [
      { attempt: 1, status: "failed", duration_ms: 1, steps: steps(2), error: "x" },
      { attempt: 2, status: "failed", duration_ms: 1, steps: steps(2), error: "x" },
    ];
    expect(attemptsSummary(details)).toBe("Attempt 1: failed at step 2 · Attempt 2: failed at step 2");
    expect(attemptsPhrase({ status: "failed", attempts: 2, attempt_details: details })).toBe("failed on both attempts (2 of 2)");
  });

  test("run states (§8.5)", () => {
    const d = (over: Partial<RunDetail>) => ({ ...run(), scope: null, config: {}, approvals: [], tests_rows: [], progress: null, request_problem: null, waiting_for: null, cancelled_by: null, analysis: null, permissions: { can_authorise: false, can_cancel: false, can_rerun: false, is_requester: false }, ...over }) as RunDetail;
    expect(runStateCopy(d({ status: "queued", waiting_for: "RUN-0002" }))?.title).toBe("Authorised. Waiting for a free test runner; RUN-0002 is still running.");
    expect(runStateCopy(d({ status: "cancelled", started_at: null }))?.title).toBe("Request withdrawn. Nothing ran.");
    expect(runStateCopy(d({ status: "error", error: "Run time limit reached" }))?.title).toContain("30-minute limit");
    expect(runStateCopy(d({ status: "failed" }))).toBeNull();
  });

  test("evidence logs are parsed as text", () => {
    const net = parseNetwork("[14:18:01] HTTP 200 GET http://localhost:4100/contact\n[14:18:02] BLOCKED by policy https://evil.example/x (not an approved site)\n[14:18:03] FAILED POST http://localhost:4100/contact — net::ERR_CONNECTION_REFUSED");
    expect(net.map((r) => [r.method, r.status, r.blocked, r.failed])).toEqual([
      ["GET", "200", false, false],
      ["", "Blocked", true, true],
      ["POST", "Failed: net::ERR_CONNECTION_REFUSED", false, true],
    ]);
    expect(parseConsole("[1] error: boom\n[2] log: hi\nNo console messages.")).toEqual([
      { time: "1", level: "error", text: "boom" },
      { time: "2", level: "log", text: "hi" },
    ]);
  });
});

test.describe("Phase 4 · analysis (design P4 §9)", () => {
  test("groups order application bugs first, then cause unclear", () => {
    const g = (c: string) => ({ classification: c as never, label: c, items: [] });
    expect(orderedGroups([g("flaky"), g("network_failure"), g("unknown"), g("application_defect")]).map((x) => x.classification)).toEqual(["application_defect", "unknown", "network_failure", "flaky"]);
  });
  test("change-the-cause consequence lines", () => {
    expect(reclassifyConsequence("application_defect", "selector_failure", null)).toBe("A defect draft will be created for review at Gate 8.");
    expect(reclassifyConsequence("selector_failure", "application_defect", "DEF-0001")).toBe("DEF-0001 stays as a draft. Reject it at Gate 8 if it isn't a bug.");
    expect(reclassifyConsequence("unknown", "selector_failure", null)).toBeNull();
  });
});

const defect = (key: string, status: DefectRow["status"], actions: Partial<DefectRow["actions"]> = {}): DefectRow => ({
  id: key,
  key,
  summary: `Summary ${key}`,
  severity: "major",
  priority: "medium",
  status,
  source: "analysis",
  reproducibility: { attempts_failed: 2, attempts: 2, kind: "always", text: "2 of 2 attempts (always)" },
  cases: ["TC-0019"],
  requirements: ["REQ-0006"],
  run_key: "RUN-0003",
  result_key: "RUN-0003-07",
  last_seen: null,
  version: 1,
  created_at: "2026-11-13T14:20:00Z",
  actions: { confirm: "They aren't drafts.", reject: "They aren't drafts.", fixed: "Only confirmed defects can be marked fixed.", verified: "Only fixed defects can be verified.", closed: "Only verified or rejected defects can be closed.", ...actions },
});

test.describe("Phase 4 · defects and Gate 8 (design P4 §11)", () => {
  test("bulk confirm skips non-drafts with reasons", () => {
    const rows = [defect("DEF-0001", "draft", { confirm: null }), defect("DEF-0002", "draft", { confirm: null }), defect("DEF-0003", "draft", { confirm: null }), defect("DEF-0004", "confirmed"), defect("DEF-0005", "fixed")];
    const plan = bulkPlan(rows, "confirm");
    expect(plan.apply.map((r) => r.key)).toEqual(["DEF-0001", "DEF-0002", "DEF-0003"]);
    expect(plan.skipped).toHaveLength(2);
    expect(bulkQuestion("confirm", 5, plan.skipped)).toBe("Confirm 5 defects? 2 can't be confirmed: they aren't drafts.");
  });
  test("focus moves to the next undecided draft, then to Decided", () => {
    const drafts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(nextUndecided(drafts, "a")).toBe("b");
    expect(nextUndecided(drafts, "c")).toBe("b");
    expect(nextUndecided([{ id: "a" }], "a")).toBeNull();
  });
  test("reproducibility and empty states", () => {
    expect(reproText({ attempts_failed: 2, attempts: 2, kind: "always" })).toBe("2 of 2 attempts (always)");
    expect(emptyDefectsText(0)).toContain("Defects appear here when a test run finds a likely bug");
    expect(emptyDefectsText(3)).toBe("No defects. 3 runs finished; no failure was classified as a likely application bug.");
  });
  test("raise-a-defect prefill uses the executed steps and what the page showed", () => {
    const r = {
      title: "Send the contact form with an empty Message",
      status: "failed",
      analysis: { summary: "The site accepted the form." },
      attempt_details: [{ attempt: 1, status: "failed", duration_ms: 1, error: null, steps: [{ n: 1, title: "Open /contact", status: "passed", duration_ms: 1, error: null }] }],
      case: { expected_result: "Submission is blocked", steps: [] },
      actual_result: "The page shows 'Thank you'.",
    };
    expect(prefillFrom(r as never)).toEqual({
      summary: "Send the contact form with an empty Message: fails",
      description: "The site accepted the form.",
      steps: "Open /contact",
      expected: "Submission is blocked",
      actual: "The page shows 'Thank you'.",
    });
  });
});

test.describe("Phase 4 · sidebar badges (design P4 §4.2)", () => {
  test("Authorise, then Running; Defects {n} to review", () => {
    expect(sectionBadge("execution", [], 0, 0, { runsWaiting: 2, running: true, drafts: 0 })).toEqual({ text: "Authorise", srText: "2 runs waiting for authorisation" });
    expect(sectionBadge("execution", [], 0, 0, { runsWaiting: 0, running: true, drafts: 0 })).toEqual({ text: "Running", srText: "a run or exploratory session is in progress" });
    expect(sectionBadge("execution", [], 0, 0, { runsWaiting: 0, running: false, drafts: 0 })).toBeNull();
    expect(sectionBadge("defects", [], 0, 0, { runsWaiting: 0, running: false, drafts: 2 })).toEqual({ text: "2 to review", srText: "2 drafts waiting for review" });
  });
});

// ---- Project-wide run and defect state (design P4 §4.3)


const st = (key: string, over: Partial<StageState> = {}): StageState =>
  ({ key, title: key, phase: 4, available: true, status: "not_started", current_version: null, gate: null, started_at: null, finished_at: null, stale_reason: null, progress: null, ...over }) as StageState;
const phase4 = (exec: Partial<StageState> = {}): Workflow => ({
  project_status: "active",
  stages: [st("automation", { status: "completed", current_version: 1, gate: { key: "G6", policy: "required", status: "approved", recommendation: null } as StageState["gate"] }), st("execution", { gate: { key: "G7", policy: "required", status: "pending", recommendation: null } as StageState["gate"], ...exec }), st("failure_analysis"), st("defects_summary")],
});

test.describe("Phase 4 · lifecycle, header and Overview state (design P4 §4.3)", () => {
  const waitingRun = run({ key: "RUN-0004", status: "awaiting_authorisation", tests: 24, authorisation: null, started_at: null, finished_at: null, side_effect: "May submit the Contact us form (if the application does not block it)" });
  const done = run({ key: "RUN-0003", status: "failed", totals: { passed: 20, failed: 3, flaky: 1 }, tests: 24, authorisation: { decision: "approve", by: null, at: "2026-11-13T14:00:00Z", comment: null, self_authorised: false }, finished_at: "2026-11-13T14:20:00Z" });

  test("summary: waiting runs, the latest started run and defect counts", () => {
    const x = execSummary({ items: [waitingRun, done], waiting: ["RUN-0004"], running: null }, { counts: { draft: 2, confirmed: 1 } });
    expect(x.waiting).toEqual(["RUN-0004"]);
    expect(x.waitingTests).toBe(24);
    expect(x.latest?.key).toBe("RUN-0003");
    expect(x.latestAuthorised).toBe(true);
    expect([x.drafts, x.confirmedOpen, x.analysed]).toEqual([2, 1, true]);
    const none = execSummary({ items: [], waiting: [], running: null }, { counts: {} });
    expect([none.latest, none.analysed, none.latestAuthorised]).toEqual([null, false, false]);
    expect(lastRunLine(done, () => "13 Nov 14:20")).toBe("RUN-0003 · 13 Nov 14:20 · 20 passed · 3 failed · 1 flaky");
    expect(lastRunShort(done, () => "13 Nov")).toBe("20 of 24 passed · 13 Nov");
  });

  test("G7 is per run and G8 per defect; never read from the workflow", () => {
    const plain = buildLifecycle(phase4());
    expect(plain.find((s) => s.id === "execution")?.gateStatus).toBe("not_started");
    const x = execSummary({ items: [waitingRun, done], waiting: ["RUN-0004"], running: null }, { counts: { draft: 2 } });
    const lc = buildLifecycle(phase4({ status: "completed", current_version: 3 }), x);
    const exec = lc.find((s) => s.id === "execution")!;
    const defects = lc.find((s) => s.id === "defects")!;
    expect(exec.gateStatus).toBe("waiting");
    expect(subjectGateText(exec, true)).toBe("RUN-0004 is waiting for your authorisation");
    expect(subjectGateText(exec, false)).toBe("RUN-0004 is waiting for authorisation by someone who can approve gates");
    expect(subjectGateText(defects, true)).toBe("Waiting: 2 defect drafts");
    const calm = buildLifecycle(phase4({ status: "completed", current_version: 3 }), { ...x, waiting: [], drafts: 0 });
    expect(subjectGateText(calm.find((s) => s.id === "execution")!, true)).toBe("Done: the latest run was authorised");
    expect(subjectGateText(calm.find((s) => s.id === "defects")!, true)).toBe("Done: no drafts waiting");
    const fresh = buildLifecycle(phase4(), { waiting: [], running: null, latestAuthorised: false, drafts: 0, analysed: false });
    expect(subjectGateText(fresh.find((s) => s.id === "execution")!, true)).toBe("Every run needs authorisation");
    expect(subjectGateText(fresh.find((s) => s.id === "defects")!, true)).toBe("Not started");
  });

  test("a running test run is not workflow work, and G7 never makes the header wait", () => {
    const running = phase4({ status: "running", current_version: 4 });
    expect(activeStage(running)).toBeNull();
    const g7Open = phase4({ status: "completed", current_version: 4 });
    expect(waitingGateStage(g7Open)).toBeNull();
  });

  test("attention rows: run waiting (role-aware), drafts, scripts that can't run, finished run", () => {
    const x = execSummary({ items: [waitingRun, done], waiting: ["RUN-0004"], running: null }, { counts: { draft: 1 } });
    const now = Date.parse("2026-11-14T10:00:00Z");
    const rows = attentionRows({ projectId: "p1", wf: phase4(), credFailed: false, conflicts: 0, proposals: 0, drafts: 0, exec: x, scripts: { aiReview: 0, invalid: 1, outdated: 2 }, now });
    expect(rows.map((r) => r.text)).toEqual([
      "RUN-0004 is waiting for your authorisation: 24 tests, may submit the Contact us form.",
      "1 defect draft from RUN-0003 needs confirming or rejecting.",
      "3 scripts can't run: 1 invalid, 2 outdated.",
      "RUN-0003 finished: 3 failed, 1 flaky.",
    ]);
    expect(rows[0]).toMatchObject({ action: "Review RUN-0004", href: "/projects/p1/execution/RUN-0004" });
    expect(rows[1]).toMatchObject({ action: "Review Gate 8", href: "/projects/p1/defects?view=review" });
    const viewer = attentionRows({ projectId: "p1", wf: phase4(), credFailed: false, conflicts: 0, proposals: 0, drafts: 0, exec: x, canApprove: false, viewer: true, now });
    expect(viewer[0]).toMatchObject({ text: "RUN-0004 is waiting for authorisation by someone who can approve gates.", href: null });
    const later = attentionRows({ projectId: "p1", wf: phase4(), credFailed: false, conflicts: 0, proposals: 0, drafts: 0, exec: { ...x, waiting: [], drafts: 0 }, now: now + 8 * 24 * 3600 * 1000 });
    expect(later).toEqual([]);
  });
});

test.describe("assistant v3 (P4-13)", () => {
  test("run, result, defect and approval keys become citation chips", async () => {
    const { splitCitations } = await import("../../src/lib/assistant");
    const tokens = splitCitations("RUN-0003-01 failed in RUN-0003; see DEF-0001 and APR-0002.")
      .filter((p) => p.kind === "token")
      .map((p) => p.text);
    expect(tokens).toEqual(["RUN-0003-01", "RUN-0003", "DEF-0001", "APR-0002"]);
  });

});
