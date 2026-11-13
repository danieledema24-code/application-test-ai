import { expect, test } from "@playwright/test";
import type { Chain, Coverage, Gaps, LintItem, Member, StageKey, StageState, TestCaseDetail, TestCaseSummary } from "../../src/lib/contract";
import {
  EMPTY_CASE_FILTERS,
  approveBlockReason,
  CASE_FORM_TECHNIQUES,
  STEP_EXPECTED_NEEDED,
  TECHNIQUE_NEEDED,
  bulkApproveGuard,
  canBeApproved,
  caseFieldErrors,
  casesForRequirement,
  caseFilterChips,
  caseFiltersToQuery,
  caseOrigin,
  coverageItemText,
  casePatch,
  dataValueError,
  displayValue,
  automationReasonText,
  filterCases,
  formHeading,
  listText,
  isUndecided,
  formAnchorLabel,
  g5Checks,
  groupCases,
  lintCounts,
  lintPreview,
  lintTypeLinkLabel,
  linkedCasesState,
  newStep,
  openQuestionMessage,
  openQuestionText,
  overrideBelowRisk,
  parseCaseFilters,
  patchHasChanges,
  priorityFromRisk,
  proposalAppliedToast,
  skippedSentence,
  suiteDiff,
  techniqueInfo,
  toCaseForm,
  usedByFromConflict,
  validateCaseForm,
} from "../../src/lib/testcases";
import { chainLevels, coverageTiles, g5SnapshotExists, gapCounts, keyHref, levelName, parseTraceFilters, traceApiQuery, traceFiltersToQuery, typeOfKey } from "../../src/lib/traceability";
import { approvesText, effectiveCanApprove, inviteErrorText, memberGuards, memberPatch, roleChangedToast, roleOptions } from "../../src/lib/members";
import { approvedBand, downloadFormats, draftBand, phase2ReportFileName, reportBySlug } from "../../src/lib/reports";
import { buildLifecycle, stageStatusLabel, stageStatusTextFor, statusLabel, waitingLabel } from "../../src/lib/lifecycle";
import { sectionBadge } from "../../src/lib/sections";
import { attentionRows } from "../../src/lib/attention";
import { riskCoverageText, riskHasNoApprovedCase } from "../../src/lib/strategy";
import { splitCitations } from "../../src/lib/assistant";
import { claimRouteFocus, takeRouteFocusClaim } from "../../src/lib/focusReturn";
import { valueText } from "../../src/lib/diff";
import { autoStartedAfterG4 } from "../../src/lib/lifecycle";

// ---- Fixtures (test-only) ---------------------------------------------------------

function tc(key: string, over: Partial<TestCaseSummary> = {}): TestCaseSummary {
  return {
    id: `id-${key}`,
    key,
    lineage_id: `l-${key}`,
    title: `Case ${key}`,
    technique: "boundary_value_analysis",
    test_type: "functional",
    test_level: "system",
    status: "draft",
    priority: "medium",
    derived_priority: "medium",
    priority_overridden: false,
    risk_level: null,
    risk_score: null,
    suites: [],
    requirement_keys: ["REQ-0001"],
    lint_summary: { errors: 0, warnings: 0, blocks_approval: false },
    expected_result_status: "defined",
    execution_status: "not_run",
    last_result: null,
    stage_run_version: 1,
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: "2026-11-13T10:00:00Z",
    generated_by: "rules",
    ...over,
  } as TestCaseSummary;
}

function stage(key: StageKey, over: Partial<StageState> = {}): StageState {
  return { key, title: key, phase: 3, available: true, status: "not_started", current_version: null, gate: null, started_at: null, finished_at: null, stale_reason: null, progress: null, ...over };
}

const ref = (key: string, label = "") => ({ type: "requirement" as const, id: `id-${key}`, key, label, path: "" });
const params = (q: Record<string, string>) => new URLSearchParams(q);

const NO_GAPS: Gaps = {
  requirements_without_test_cases: { none: [], none_approved: [] },
  test_cases_without_requirements: [],
  acceptance_criteria_without_test_cases: [],
  untested_high_risk: { open: [], accepted: [] },
  features_without_requirements: [],
  requirements_without_execution_evidence: { available: false, available_from_phase: 4, message: "" },
  failed_tests: { available: false, available_from_phase: 4, message: "" },
  outdated_automation_scripts: { available: false, available_from_phase: 4, message: "" },
  defects_without_regression_coverage: { available: false, available_from_phase: 4, message: "" },
};

const g5 = (cases: TestCaseSummary[], over: Partial<Parameters<typeof g5Checks>[0]> = {}) =>
  g5Checks({
    cases,
    gaps: NO_GAPS,
    g4Approved: true,
    designCurrent: true,
    strategyVersion: 2,
    listHref: (q) => `/list?${new URLSearchParams(q)}`,
    traceHref: (a) => `/trace#${a}`,
    riskHref: (k) => `/risk/${k}`,
    g4Href: "/g4",
    ...over,
  });

// ---- Test cases: lint and approval (§8) ------------------------------------------------------

test.describe("test cases: checks and approval (design P3 §8, §6.3)", () => {
  test("an open question counts as Must fix and blocks approval", () => {
    const oq = tc("TC-0001", { expected_result_status: "open_question", lint_summary: { errors: 0, warnings: 1, blocks_approval: true } });
    expect(lintCounts(oq)).toEqual({ must: 1, advice: 0 });
    expect(canBeApproved(oq)).toBe(false);
    expect(canBeApproved(tc("TC-0002", { lint_summary: { errors: 0, warnings: 2, blocks_approval: false } }))).toBe(true);
    // A server-side blocker with no error count still blocks.
    expect(lintCounts(tc("TC-0003", { lint_summary: { errors: 0, warnings: 0, blocks_approval: true } })).must).toBe(1);
  });

  test("the disabled-Approve reason names each blocking check and its step", () => {
    const lint: LintItem[] = [
      { code: "missing_expected_result", severity: "error", blocks_approval: true, message: "", path: "steps[3].expected", hint: null },
      { code: "vague_wording", severity: "warning", blocks_approval: false, message: "", path: null, hint: null },
    ];
    expect(approveBlockReason(lint)).toBe("Fix 1 check before approving: missing expected result (step 4).");
    expect(approveBlockReason([])).toBeNull();
    expect(approveBlockReason(null)).toBeNull();
  });

  test("bulk approve skips open questions and Must-fix drafts with one plain sentence", () => {
    const rows = [
      tc("TC-0001"),
      tc("TC-0002", { lint_summary: { errors: 2, warnings: 0, blocks_approval: true } }),
      tc("TC-0003", { lint_summary: { errors: 1, warnings: 0, blocks_approval: true } }),
      tc("TC-0004", { expected_result_status: "open_question", lint_summary: { errors: 0, warnings: 1, blocks_approval: true } }),
      tc("TC-0005", { status: "approved" }),
    ];
    const g = bulkApproveGuard(rows);
    expect(g.approvable.map((c) => c.key)).toEqual(["TC-0001"]);
    expect(g.skipped.map((s) => s.c.key)).toEqual(["TC-0002", "TC-0003", "TC-0004"]);
    expect(skippedSentence(g.skipped)).toBe("3 can’t be approved yet: 2 have checks you must fix and 1 has an open question. They’ll stay as drafts.");
  });

  test("risk-derived priority and the below-risk override warning", () => {
    expect(priorityFromRisk("very_high")).toBe("critical");
    expect(priorityFromRisk(null)).toBe("low");
    expect(overrideBelowRisk("low", "high", "high")).toBe(true);
    expect(overrideBelowRisk("critical", "high", "high")).toBe(false);
    expect(overrideBelowRisk("low", "medium", "medium")).toBe(false);
  });

  test("techniques include checklist for non-functional cases and never crash on unknown values", () => {
    expect(techniqueInfo("checklist").name).toMatch(/checklist/i);
    expect(techniqueInfo("boundary_value_analysis").short).toBe("BVA");
    expect(techniqueInfo(undefined).name).toBeTruthy();
    expect(techniqueInfo("made_up").short).toBe("—");
  });
});

// ---- Visible values (§7.1) ----------------------------------------------------------------

test.describe("visible test values (design P3 §7.1, §19)", () => {
  test("empty, spaces-only and long values are never invisible", () => {
    expect(displayValue("").text).toBe("(empty) 0 characters");
    expect(displayValue("   ")).toMatchObject({ text: "␣␣␣ (3 spaces)", sr: "three spaces" });
    const long = displayValue("a".repeat(81));
    expect(long.text).toBe("aaaa…aaa (81 characters)");
    expect(long.truncated).toBe(true);
    expect(displayValue(null).length).toBe(0);
  });

  test("test data guard: reserved email domains, Luhn cards, boundary length and the size limit", () => {
    expect(dataValueError("ada@gmail.com", "valid", null)).toMatch(/reserved domain/);
    expect(dataValueError("ada@example.com", "valid", null)).toBeNull();
    expect(dataValueError("4111 1111 1111 1111", "valid", null)).toBeNull();
    expect(dataValueError("4539 1488 0343 6467", "valid", null)).toMatch(/real card number/);
    expect(dataValueError("abc", "boundary", 4)).toBe("This item tests the 4-character boundary; change the case instead.");
    expect(dataValueError("x".repeat(5001), "valid", null)).toBe("Values can be up to 5,000 characters.");
  });
});

// ---- List filters, grouping (§6) ------------------------------------------------------------

test.describe("test case list filters (design P3 §6.2)", () => {
  test("URL round-trip keeps only non-default values and drops unknown ones", () => {
    const f = parseCaseFilters(params({ status: "draft", technique: "boundary_value_analysis", oq: "1", keys: "TC-0001,TC-0002", group: "requirement", sort: "key", priority: "nonsense" }));
    expect(f.status).toBe("draft");
    expect(f.oq).toBe(true);
    expect(f.priority).toBe("");
    expect(f.keys).toEqual(["TC-0001", "TC-0002"]);
    expect(caseFiltersToQuery(f)).toEqual({ status: "draft", technique: "boundary_value_analysis", oq: "1", keys: "TC-0001,TC-0002", group: "requirement", sort: "key" });
    expect(caseFiltersToQuery(EMPTY_CASE_FILTERS)).toEqual({});
    expect(caseFilterChips(f).map((c) => c.key)).toEqual(expect.arrayContaining(["status", "technique", "oq"]));
  });

  test("Source filter follows the as-built `source` field (user → Person, assistant → AI)", () => {
    expect(caseOrigin({ source: "user", generated_by: "rules", human_edited: false })).toBe("human");
    expect(caseOrigin({ source: "assistant", generated_by: "rules", human_edited: false })).toBe("ai");
    expect(caseOrigin({ source: "design", generated_by: "rules", human_edited: true })).toBe("rules");
    expect(filterCases([tc("TC-0001", { source: "user" }), tc("TC-0002", { source: "design" })], { ...EMPTY_CASE_FILTERS, source: "human" }).rows.map((c) => c.key)).toEqual(["TC-0001"]);
  });

  test("rejected and deprecated cases are hidden and counted; priority sort puts critical first", () => {
    const all = [
      tc("TC-0001", { priority: "low" }),
      tc("TC-0002", { priority: "critical" }),
      tc("TC-0003", { status: "rejected" }),
      tc("TC-0004", { status: "deprecated" }),
    ];
    const r = filterCases(all, EMPTY_CASE_FILTERS);
    expect(r.rows.map((c) => c.key)).toEqual(["TC-0002", "TC-0001"]);
    expect(r.hiddenRejected).toBe(1);
    expect(r.hiddenDeprecated).toBe(1);
    expect(filterCases(all, { ...EMPTY_CASE_FILTERS, showHidden: true }).rows).toHaveLength(4);
  });

  test("group by requirement: a two-requirement case is in both, unlinked cases come last", () => {
    const groups = groupCases([tc("TC-0001", { requirement_keys: ["REQ-0002", "REQ-0001"] }), tc("TC-0002", { requirement_keys: [] }), tc("TC-0003", { requirement_keys: ["REQ-0001"], status: "approved" })], "requirement", {
      "REQ-0001": "Name is required",
    });
    expect(groups.map((g) => g.title)).toEqual(["REQ-0001 Name is required", "REQ-0002", "Not linked to a requirement"]);
    expect(groups[0].cases.map((c) => c.key)).toEqual(["TC-0001", "TC-0003"]);
    expect(groups[0].approved).toBe(1);
  });
});

// ---- Edit form: send only what changed (§8.2) -------------------------------------------------

test.describe("case edit form (design P3 §8.2–8.4)", () => {
  const detail = {
    ...tc("TC-0005", { expected_result_status: "open_question" }),
    objective: "Check Name",
    preconditions: ["On /contact"],
    steps: [{ n: 1, action: "Leave Name empty", data: [], expected: "Not decided: REQ-0011 asks…" }],
    expected_result: "Not decided: REQ-0011 asks whether Name is optional",
    open_question: { requirement: ref("REQ-0011"), message: "Is Name optional?" },
    condition: null,
    design_basis: null,
    requirements: [ref("REQ-0001")],
    acceptance_criteria: [],
    risks: [],
    test_data: [],
    side_effects: [],
    automation_suitability: null,
    priority_source: { kind: "default", risk: null, override_reason: null, overridden_by: null },
    lint: [],
    evidence: [],
    source: "design",
    rule_id: null,
    status_comment: null,
    status_changed_by: null,
    status_changed_at: null,
    created_at: "2026-11-13T10:00:00Z",
    updated_by: null,
  } as unknown as TestCaseDetail;

  test("an open question's 'Not decided…' text becomes an empty field to fill in", () => {
    const form = toCaseForm(detail);
    expect(form.expected_result).toBe("");
    expect(form.steps[0].expected).toBe("");
  });

  test("an unchanged form sends no fields; a changed title sends only the title, version and reason", () => {
    const base = toCaseForm(detail);
    const same = casePatch(base, { ...base }, 3);
    expect(same).toEqual({ version: 3 });
    expect(patchHasChanges(same)).toBe(false);
    const changed = casePatch(base, { ...base, title: "  New title ", reason: "clearer" }, 3);
    expect(changed).toEqual({ version: 3, title: "New title", change_reason: "clearer" });
    expect(patchHasChanges(changed)).toBe(true);
  });

  test("validation refuses literal passwords in steps", () => {
    const base = toCaseForm(detail);
    const errs = validateCaseForm({ ...base, title: "Title", steps: [newStep({ action: "Type password: hunter2hunter2", expected: "Shown" })], expected_result: "Shown" });
    expect(errs.some((e) => /password/i.test(e.message))).toBe(true);
  });

  // QA BUG-P3-02: generated setup steps ("Open /contact") have no expected result, and that must not block saving.
  test("a step's expected result is optional; the case needs an overall one and at least one step with one", () => {
    const base = { ...toCaseForm(detail), title: "Contact form with an empty Message" };
    const setup = [newStep({ action: "Open /contact", expected: "" }), newStep({ action: "Type Ada in Name", expected: "" })];
    const ok = validateCaseForm({ ...base, steps: [...setup, newStep({ action: "Press Send", expected: "The message is sent" })], expected_result: "A confirmation is shown" });
    expect(ok).toEqual([]);

    const none = validateCaseForm({ ...base, steps: [...setup, newStep({ action: "Press Send", expected: "" })], expected_result: "A confirmation is shown" });
    expect(none).toEqual([{ field: "step-2-expected", message: STEP_EXPECTED_NEEDED }]);

    const noOverall = validateCaseForm({ ...base, steps: [...setup, newStep({ action: "Press Send", expected: "Sent" })], expected_result: " " });
    expect(noOverall.map((e) => e.field)).toEqual(["expected_result"]);
  });

  test("the open-question path: writing the last step and the overall result is enough to save", () => {
    const form = toCaseForm({ ...detail, steps: [{ n: 1, action: "Open /contact", data: [], expected: "" }, { n: 2, action: "Press Send", data: [], expected: "Not decided: REQ-0011 asks…" }] } as TestCaseDetail);
    expect(form.steps.map((x) => x.expected)).toEqual(["", ""]);
    expect(validateCaseForm(form).map((e) => e.field)).toEqual(["step-1-expected", "expected_result"]);
    form.steps[1].expected = "The form is accepted";
    form.expected_result = "The form is accepted with Message empty";
    expect(validateCaseForm(form)).toEqual([]);
    // The server-lint preview agrees: no "missing expected result" for the setup step.
    expect(lintPreview(form).filter((l) => l.code === "missing_expected_result")).toEqual([]);
  });

  // QA BUG-P3-05: the new-case form has no "Other" default; the technique is a real, required choice.
  test("technique: only values the API accepts are offered, and an empty choice is a field error", () => {
    expect(CASE_FORM_TECHNIQUES).not.toContain("other");
    expect(CASE_FORM_TECHNIQUES).toEqual(expect.arrayContaining(["equivalence_partitioning", "use_case", "checklist"]));
    const form = { ...toCaseForm(detail), title: "Valid title", technique: "" as const, expected_result: "Shown", steps: [newStep({ action: "Press Send", expected: "Sent" })] };
    expect(validateCaseForm(form)).toEqual([{ field: "technique", message: TECHNIQUE_NEEDED }]);
  });

  test("422 details map to form fields in plain words; parser wording is never shown", () => {
    const { fields, other } = caseFieldErrors([
      { field: "technique", message: "Input should be 'equivalence_partitioning', 'boundary_value_analysis' or 'checklist'" },
      { field: "steps.1.expected", message: "Field required" },
      { field: "steps.0.action", message: "Step 1 contains what looks like a password." },
      { field: "title", message: "Value error, Title is already used by TC-0004" },
      { field: "side_effects.0", message: "Input should be 'sends_email'" },
    ]);
    expect(fields).toEqual([
      { field: "technique", message: TECHNIQUE_NEEDED },
      { field: "step-1-expected", message: "Check the expected result for step 2." },
      { field: "step-0-action", message: "Step 1 contains what looks like a password." },
      { field: "title", message: "Title is already used by TC-0004" },
    ]);
    expect(other).toEqual(["Check the side effects."]);
    expect(caseFieldErrors(null)).toEqual({ fields: [], other: [] });
    expect(JSON.stringify(caseFieldErrors([{ field: "requirement_ids.0", message: "Input should be a valid UUID" }]))).not.toMatch(/Input should/);
  });

  test("'Not decided:' is shown once whether or not the server prefixes the message", () => {
    expect(openQuestionText("REQ-0007 asks whether Message is optional")).toBe("Not decided: REQ-0007 asks whether Message is optional");
    expect(openQuestionText("Not decided: REQ-0007 asks whether Message is optional")).toBe("Not decided: REQ-0007 asks whether Message is optional");
    expect(openQuestionText("not decided:  Not decided: x")).toBe("Not decided: x");
    expect(openQuestionText(null)).toBe("Not decided");
    expect(openQuestionMessage("Not decided: Is Name optional?")).toBe("Is Name optional?");
  });
});

// ---- Gate 5 checks (§13.1) ------------------------------------------------------------------

test.describe("Gate 5 checks (design P3 §13.1)", () => {
  test("blockers: no approved case and an open question; advice never blocks", () => {
    const r = g5([tc("TC-0001"), tc("TC-0002", { expected_result_status: "open_question", lint_summary: { errors: 0, warnings: 1, blocks_approval: true } })]);
    expect(r.blockers.map((b) => b.id)).toEqual(["approved", "oq"]);
    expect(r.blockers[1].links[0].label).toBe("Show the case with an open question");
    expect(r.advice.map((a) => a.id)).toContain("drafts");
  });

  test("every link label on the panel is unique", () => {
    const gaps: Gaps = {
      ...NO_GAPS,
      untested_high_risk: { open: [{ risk: { ...ref("RISK-001", "High"), type: "risk" }, requirements: [ref("REQ-0004")] }], accepted: [] },
      requirements_without_test_cases: { none: [ref("REQ-0009")], none_approved: [] },
    };
    const r = g5([tc("TC-0001", { status: "approved", lint_summary: { errors: 1, warnings: 1, blocks_approval: true } }), tc("TC-0002"), tc("TC-0003", { lint_summary: { errors: 1, warnings: 0, blocks_approval: true } })], { gaps, g4Approved: false });
    const labels = [...r.blockers, ...r.advice].flatMap((l) => l.links.map((x) => x.label));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(expect.arrayContaining(["Review Gate 4", "Show test cases for REQ-0004", "Open RISK-001", "Show uncovered requirements"]));
  });

  test("a design from an older strategy blocks with a regenerate link; all clear passes", () => {
    expect(g5([tc("TC-0001", { status: "approved" })], { designCurrent: false }).blockers[0].links[0].href).toContain("regenerate=1");
    const ok = g5([tc("TC-0001", { status: "approved" })]);
    expect(ok.blockers).toEqual([]);
    expect(ok.passed.map((p) => p.id)).toEqual(expect.arrayContaining(["g4", "approved", "approved-must", "risk", "oq"]));
    expect(lintTypeLinkLabel("open_question", 1)).toBe("Show 1 case: open question");
  });
});

// ---- Requirement detail, risks, proposals ------------------------------------------------------

test.describe("requirement and risk additions (design P3 §9, §16.2)", () => {
  test("linked test cases states follow the requirement and design state", () => {
    expect(linkedCasesState({ g4Approved: false, designed: false, status: "approved", count: 0 }).text).toBe("Test cases are designed after the Test Strategy is approved (Gate 4).");
    expect(linkedCasesState({ g4Approved: true, designed: true, status: "approved", count: 0 })).toEqual({ text: "No test cases yet.", uncovered: true, offerNew: true });
    expect(linkedCasesState({ g4Approved: true, designed: true, status: "draft", count: 0 }).text).toBe("Test cases are designed only from approved requirements.");
    expect(linkedCasesState({ g4Approved: true, designed: true, status: "rejected", count: 2 }).text).toBe("Rejected requirements get no test cases.");
    expect(linkedCasesState({ g4Approved: true, designed: true, status: "approved", count: 2 }).text).toBeNull();
  });

  test("risk register coverage text and the No-approved-case filter", () => {
    const cov = (approved: number, cases = 3) => ({ requirements: 1, test_cases: cases, approved_test_cases: approved, uncovered_requirement_keys: [] });
    expect(riskCoverageText({ status: "open", coverage: cov(2) })).toEqual({ text: "3 cases, 2 approved", tone: "ok" });
    expect(riskCoverageText({ status: "open", coverage: cov(0) })?.text).toBe("No approved case");
    expect(riskCoverageText({ status: "accepted", coverage: cov(0) })?.text).toBe("Accepted · not required");
    expect(riskCoverageText({ status: "open", coverage: null })).toBeNull();
    expect(riskHasNoApprovedCase({ status: "open", coverage: cov(0) })).toBe(true);
    expect(riskHasNoApprovedCase({ status: "accepted", coverage: cov(0) })).toBe(false);
  });

  test("suite proposals split into add/remove lists; toasts name what was applied", () => {
    const d = suiteDiff([
      { key: "TC-0031", from: [], to: ["regression"] },
      { key: "TC-0040", from: ["regression"], to: [] },
      { key: "TC-0050", from: ["smoke"], to: ["smoke"] },
    ]);
    expect(d.add.map((x) => x.key)).toEqual(["TC-0031"]);
    expect(d.remove.map((x) => x.key)).toEqual(["TC-0040"]);
    expect(proposalAppliedToast("add_test_cases", 1, 3)).toBe("3 test cases added as drafts. View in Test Cases.");
    expect(proposalAppliedToast("update_risk", 2)).toBe("2 changes applied. View in Test Strategy.");
  });

  test("citation tokens include TC, TCOND and TD", () => {
    expect(splitCitations("See TC-0019, TCOND-0003 and TD-0012.").filter((p) => p.kind === "token").map((p) => p.text)).toEqual(["TC-0019", "TCOND-0003", "TD-0012"]);
  });
});

// ---- Traceability (§14) ----------------------------------------------------------------------

test.describe("traceability (design P3 §14)", () => {
  const coverage: Coverage = {
    basis: "current",
    design_version: 2,
    snapshot_hash: null,
    requirements: { approved: 22, with_case: 20, with_approved_case: 18, percent_approved_covered: 82 },
    acceptance_criteria: { approved: 40, covered: 38, percent: 95 },
    high_risk_requirements: { total: 6, with_approved_case: 4 },
    techniques: [],
    test_cases: { by_status: { approved: 30, draft: 18 }, orphans: 2 },
    execution: { available: false, available_from_phase: 4, message: "" },
  };

  test("seven tiles; execution is 'Not available', never 0", () => {
    const tiles = coverageTiles(coverage, (q) => `/t?${new URLSearchParams(q)}`, (q) => `/c?${new URLSearchParams(q)}`);
    expect(tiles).toHaveLength(7);
    expect(tiles[0]).toMatchObject({ label: "Requirements covered", value: "18 of 22" });
    expect(tiles.find((t) => t.id === "orphans")).toMatchObject({ value: "2", warn: true, href: "/c?no_req=1" });
    expect(tiles.find((t) => t.id === "exec")).toMatchObject({ value: "Not available", unavailable: true });
    expect(gapCounts(NO_GAPS)).toEqual({ requirements: 0, orphans: 0, risks: 0, acs: 0, features: 0 });
  });

  test("matrix filters round-trip and map to the API query with a page size of 50", () => {
    const f = parseTraceFilters(params({ dir: "backward", basis: "approved", status: "draft", risk_level: "high", uncovered: "1" }));
    expect(traceFiltersToQuery(f)).toEqual({ dir: "backward", basis: "approved", status: "draft", risk_level: "high", uncovered: "1" });
    expect(traceApiQuery(f, "abc")).toMatchObject({ view: "backward", basis: "approved", limit: 50, cursor: "abc" });
    expect(traceFiltersToQuery(parseTraceFilters(params({})))).toEqual({});
  });

  test("chain levels are top-down; risks go beside the chain; keys open the right page", () => {
    const chain: Chain = {
      root: { type: "test_case", id: "c", key: "TC-0005", label: "Empty Name", path: "" },
      upstream: [
        { type: "test_condition", items: [{ type: "test_condition", id: "x", key: "TCOND-0003", label: "Name length", path: "" }] },
        { type: "acceptance_criterion", items: [{ type: "acceptance_criterion", id: "y", key: "AC-0010", label: "", path: "" }] },
        { type: "requirement", items: [ref("REQ-0004")] },
        { type: "risk", items: [{ type: "risk", id: "r", key: "RISK-003", label: "", path: "" }] },
      ],
      downstream: [],
      later_phase: [],
    };
    const { chain: levels, side } = chainLevels(chain);
    expect(levels.map((l) => l.type)).toEqual(["requirement", "acceptance_criterion", "test_condition", "test_case"]);
    expect(levels[3].root).toBe(true);
    expect(side.map((l) => l.type)).toEqual(["risk"]);
    expect(levelName("acceptance_criterion", 2)).toBe("Acceptance criteria");
    expect(typeOfKey("TCOND-0003")).toBe("test_condition");
    expect(keyHref("p1", "TD-0001")).toBe("/projects/p1/test-cases?view=data&data=TD-0001");
    expect(keyHref("p1", "RISK-003")).toBe("/projects/p1/test-strategy?view=risks&risk=RISK-003");
  });
});

// ---- Members (§17) --------------------------------------------------------------------------

test.describe("members and invitations (design P3 §17)", () => {
  const m = (role: Member["role"], over: Partial<Member> = {}) => ({ role, can_approve: role === "owner", is_you: false, version: 2, ...over });

  test("guards are shown before acting", () => {
    expect(memberGuards("admin", m("owner"), 2)).toMatchObject({ canEdit: false, canRemove: false, reason: "Only owners can change or remove an owner." });
    expect(memberGuards("owner", m("owner", { is_you: true }), 1)).toMatchObject({ canRemove: false, roleLocked: "A workspace needs at least one owner. Make someone else an owner first." });
    expect(memberGuards("admin", m("admin", { is_you: true }), 1)).toMatchObject({ canEdit: true, roleLocked: "You can’t change your own role. Ask an owner." });
    expect(memberGuards("member", m("viewer"), 1)).toMatchObject({ canEdit: false, canRemove: false });
    expect(memberGuards("owner", m("member"), 1)).toMatchObject({ canEdit: true, canRemove: true, roleLocked: null });
    expect(roleOptions("admin")).toEqual(["admin", "member", "viewer"]);
    expect(roleOptions("owner")).toEqual(["owner", "admin", "member", "viewer"]);
  });

  test("approval rights: owners always, viewers never; the patch sends only what changed", () => {
    expect(effectiveCanApprove("owner", false)).toBe(true);
    expect(effectiveCanApprove("viewer", true)).toBe(false);
    expect(approvesText(m("owner"))).toBe("Yes (always)");
    expect(memberPatch(m("member"), "member", false)).toBeNull();
    expect(memberPatch(m("member"), "member", true)).toEqual({ can_approve: true, version: 2 });
    expect(memberPatch(m("member", { can_approve: true }), "viewer", true)).toEqual({ role: "viewer", can_approve: false, version: 2 });
    expect(roleChangedToast("Sam Patel", "member", true)).toBe("Sam Patel is now a Member who can approve gates.");
    expect(roleChangedToast("Ana Lee", "admin", false)).toBe("Ana Lee is now an Admin who can’t approve gates.");
  });

  test("invitation errors map to the design copy", () => {
    expect(inviteErrorText(409, "conflict", "This email already has an account").field).toMatch(/^This email already has an account\. Multi-workspace/);
    expect(inviteErrorText(409, "conflict", "Pending invitation exists").field).toBe("There’s already a pending invitation for this email. Revoke it to create a new link.");
    expect(inviteErrorText(429, "rate_limited", "").form).toBe("You’ve created 20 invitations in the last hour. Try again later.");
  });
});

// ---- Reports (§15) ---------------------------------------------------------------------------

test.describe("reports (design P3 §15)", () => {
  test("Phase 3 report types, CSV only where offered, file names and bands", () => {
    expect(reportBySlug("test-case-spec")?.type).toBe("test_case_spec");
    expect(reportBySlug("rtm")?.gate).toBe("G5");
    expect(downloadFormats("test_case_spec")).toEqual(["pdf", "html", "csv"]);
    expect(downloadFormats("requirements_spec")).toEqual(["pdf", "html"]);
    expect(phase2ReportFileName("www.acme.com", "test_case_spec", 2, new Date(2026, 10, 13), "csv")).toBe("www.acme.com-test-case-spec-v2-2026-11-13.csv");
    expect(phase2ReportFileName("www.acme.com", "rtm", 1, new Date(2026, 10, 13), "pdf")).toBe("www.acme.com-rtm-v1-2026-11-13.pdf");
    expect(draftBand("rtm", 1)).toBe("DRAFT, not approved at Gate 5");
    expect(approvedBand("G5", "Daniele Edema", "13 Nov 2026")).toBe("Approved at Gate 5 by Daniele Edema, 13 Nov 2026");
  });
});

// ---- Lifecycle, sidebar, attention (§4.3) -----------------------------------------------------

test.describe("lifecycle and role-aware waiting copy (design P3 §4.3)", () => {
  test("waiting copy depends on can_approve", () => {
    expect(waitingLabel(true)).toBe("Waiting for your approval");
    expect(waitingLabel(false)).toBe("Waiting for approval by someone who can approve gates");
    expect(statusLabel("waiting", false)).toBe(waitingLabel(false));
    expect(stageStatusLabel("awaiting_approval", false)).toBe(waitingLabel(false));
  });

  test("traceability mirrors test design and is never Running on its own; G5 waiting shows on the stage", () => {
    const lc = buildLifecycle({
      project_status: "active",
      stages: [stage("test_design", { status: "completed", current_version: 1, gate: { key: "G5", status: "pending" } as StageState["gate"] }), stage("traceability", { status: "running" })],
    } as never);
    const design = lc.find((s) => s.id === "test-design")!;
    expect(design.status).toBe("waiting");
    expect(stageStatusTextFor(design, false)).toBe("Waiting for approval by someone who can approve gates");
    expect(design.steps.map((s) => s.agent)).toEqual(["Test Design Agent", "Computed, no agent"]);
  });

  test("Test Cases badge: Review, then Out of date, then open questions", () => {
    const st = [{ key: "test_design", status: "awaiting_approval", gate: { key: "G5", status: "pending" } }];
    expect(sectionBadge("test-cases", st, 0, 3)).toEqual({ text: "Review", srText: "Gate 5 waiting for approval" });
    expect(sectionBadge("test-cases", [{ key: "test_design", status: "stale", gate: null }], 0, 3)).toEqual({ text: "Out of date", srText: "out of date" });
    expect(sectionBadge("test-cases", [{ key: "test_design", status: "completed", gate: null }], 0, 1)).toEqual({ text: "1 ?", srText: "1 open question" });
    expect(sectionBadge("traceability", [{ key: "test_design", status: "stale", gate: null }])).toEqual({ text: "Out of date", srText: "out of date" });
  });

  test("attention rows: G5 waiting (role-aware), open questions and out-of-date test cases", () => {
    const wf = { project_status: "active", stages: [stage("test_design", { status: "stale", gate: { key: "G5", status: "pending" } as StageState["gate"] })] } as never;
    const rows = attentionRows({ projectId: "p1", wf, credFailed: false, conflicts: 0, proposals: 0, drafts: 0, openQuestions: 2, canApprove: false });
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["Resolve open questions", "Open test cases"]));
    expect(rows.find((r) => r.action === "Resolve open questions")).toMatchObject({ text: "2 test cases have open questions.", href: "/projects/p1/test-cases?oq=1" });
    const w = attentionRows({ projectId: "p1", wf: { project_status: "active", stages: [stage("test_design", { status: "awaiting_approval", gate: { key: "G5", status: "pending" } as StageState["gate"] })] } as never, credFailed: false, conflicts: 0, proposals: 0, drafts: 0, canApprove: false });
    expect(w[0]).toMatchObject({ action: "Review Gate 5", href: "/projects/p1/test-cases?view=review" });
    expect(w[0].text).toContain("waiting for approval by someone who can approve gates");
  });
});

test.describe("QA round 1 fixes (P3 verification)", () => {
  // BUG-P3-07: REQ-0007 is the open question; TC-0006 waits on it without listing it in requirement_keys.
  test("a requirement page lists the cases waiting on its answer", () => {
    const waiting = tc("TC-0006", { requirement_keys: ["REQ-0003"], expected_result_status: "open_question" });
    const other = tc("TC-0001", { requirement_keys: ["REQ-0007"] });
    const rejected = tc("TC-0009", { requirement_keys: ["REQ-0007"], status: "rejected" });
    const elsewhere = tc("TC-0010", { requirement_keys: ["REQ-0003"], expected_result_status: "open_question" });
    const r = casesForRequirement([waiting, other, rejected, elsewhere], "REQ-0007", { "id-TC-0006": "REQ-0007", "id-TC-0010": "REQ-0011" });
    expect(r.cases.map((c) => c.key)).toEqual(["TC-0006", "TC-0001"]);
    expect(r.waiting.map((c) => c.key)).toEqual(["TC-0006"]);
    expect(casesForRequirement([waiting], "REQ-0007", {}).cases).toEqual([]);
  });

  // BUG-P3-18: after G5 reopens, the approved snapshot still exists.
  test("'Last approved' is available whenever Gate 5 was approved before", () => {
    expect(g5SnapshotExists(null)).toBe(false);
    expect(g5SnapshotExists({ status: "pending", decision: null, changes_since_approval: 0 })).toBe(false);
    expect(g5SnapshotExists({ status: "approved" })).toBe(true);
    expect(g5SnapshotExists({ status: "pending", decision: { decision: "approve" } })).toBe(true);
    expect(g5SnapshotExists({ status: "pending", decision: null, changes_since_approval: 2 })).toBe(true);
    expect(g5SnapshotExists({ status: "pending", decision: { decision: "request_changes" }, changes_since_approval: 0 })).toBe(false);
  });

  test("the open question's own text marks an undecided step, with or without the old prefix", () => {
    const msg = "REQ-0007 asks whether Message is optional";
    expect(isUndecided("REQ-0007 asks whether Message is optional", msg)).toBe(true);
    expect(isUndecided("Not decided: REQ-0007 asks whether Message is optional", msg)).toBe(true);
    expect(isUndecided("The message is sent", msg)).toBe(false);
    expect(isUndecided("", msg)).toBe(false);
    const form = toCaseForm({ ...({} as TestCaseDetail), title: "t", technique: "error_guessing", test_type: "functional", test_level: "system", expected_result_status: "open_question", open_question: { requirement: ref("REQ-0007"), message: msg }, expected_result: msg, steps: [{ n: 1, action: "Open /contact", data: [], expected: "" }, { n: 2, action: "Press Send", data: [], expected: msg }] } as TestCaseDetail);
    expect(form.expected_result).toBe("");
    expect(form.steps.map((x) => x.expected)).toEqual(["", ""]);
  });

  test("regression preview items with an action split into add and remove", () => {
    const { add, remove } = suiteDiff([
      { key: "TC-0001", from: [], to: ["regression"], action: "add" as const, reason: "Covers RISK-003 (high risk)" },
      { key: "TC-0002", from: ["regression"], to: [], action: "remove" as const, reason: "Not selected by this scope" },
    ]);
    expect(add.map((x) => x.key)).toEqual(["TC-0001"]);
    expect(remove.map((x) => x.key)).toEqual(["TC-0002"]);
  });

  test("retire 409: the cases using an item are read from every shape the API has sent", () => {
    expect(usedByFromConflict({ used_by: [{ key: "TC-0012" }, "TC-0042"] })).toEqual(["TC-0012", "TC-0042"]);
    expect(usedByFromConflict([{ cases: ["TC-0012", { key: "TC-0042" }] }])).toEqual(["TC-0012", "TC-0042"]);
    expect(usedByFromConflict([{ key: "TC-0012" }, { key: "TC-0012" }])).toEqual(["TC-0012"]);
    expect(usedByFromConflict(null)).toEqual([]);
  });

  test("test data form headings read as names, not discovery anchors", () => {
    expect(formAnchorLabel("form:/contact:contact us")).toBe("Contact us");
    expect(formAnchorLabel("Sign in")).toBe("Sign in");
    expect(formAnchorLabel(null)).toBeNull();
  });

  test("coverage tiles survive stored content that lacks a block", () => {
    const tiles = coverageTiles({ techniques: [], test_cases: { by_status: {}, orphans: 0 } } as unknown as Coverage, () => "", () => "");
    expect(tiles.find((t) => t.id === "req")?.value).toBe("0 of 0");
  });

  test("a restored list row claims focus once, only for its own page and only briefly", () => {
    expect(takeRouteFocusClaim("/projects/p/test-cases")).toBe(false);
    claimRouteFocus("/projects/p/test-cases");
    expect(takeRouteFocusClaim("/projects/p/requirements")).toBe(false);
    expect(takeRouteFocusClaim("/projects/p/test-cases")).toBe(true);
    expect(takeRouteFocusClaim("/projects/p/test-cases")).toBe(false);
  });
});

test.describe("QA round 2 fixes (P3 verification)", () => {
  test("test data form headings never repeat the path", () => {
    expect(formHeading("Contact us form (/contact)", "/contact")).toBe("Contact us form (/contact)");
    expect(formHeading("Contact us form", "/contact")).toBe("Contact us form (/contact)");
    expect(formHeading("Contact us form", null)).toBe("Contact us form");
  });

  test("keys read as a list: commas, then 'and'; long lists end with 'n more'", () => {
    expect(listText(["TC-0012"])).toBe("TC-0012");
    expect(listText(["TC-0012", "TC-0042"])).toBe("TC-0012 and TC-0042");
    expect(listText(["TC-0012", "TC-0013", "TC-0042"])).toBe("TC-0012, TC-0013 and TC-0042");
    expect(listText(["A", "B", "C", "D"], 2)).toBe("A, B and 2 more");
    expect(listText([])).toBe("");
  });

  test("change review: steps read as numbered actions with expected results, never JSON or ids", () => {
    const steps = [
      { n: 1, action: "Open /contact", expected: "", data_refs: ["0b1c9a52-1111-4a4a-9b9b-222222222222"] },
      { n: 2, action: "Press Send", expected: "The form is sent", data: [{ key: "TD-0001", label: "Name" }] },
    ];
    expect(valueText(steps)).toBe("1. Open /contact\n2. Press Send → The form is sent · data TD-0001");
    expect(valueText({ coverage_item: "41 characters", condition_lineage_id: "0b1c9a52-1111-4a4a-9b9b-222222222222" })).toBe("coverage item: 41 characters");
  });

  test("'Started automatically after Gate 4 approval' holds after the run finishes", () => {
    const g4 = stage("test_strategy", { status: "approved", gate: { key: "G4", policy: "required", status: "approved", recommendation: null, decision: { decision: "approve", decided_at: "2026-11-13T10:00:00Z" } } });
    expect(autoStartedAfterG4(stage("test_design", { status: "awaiting_approval", started_at: "2026-11-13T10:00:03Z" }), g4)).toBe(true);
    expect(autoStartedAfterG4(stage("test_design", { status: "awaiting_approval", started_at: "2026-11-13T11:00:00Z" }), g4)).toBe(false);
    expect(autoStartedAfterG4(stage("test_design", { status: "not_started" }), stage("test_strategy"))).toBe(false);
  });

  test("the automation reason drops the 'Preliminary' sentence the page prints once", () => {
    expect(automationReasonText("Preliminary: assessed in Phase 4. Scriptable: fixed inputs and a visible result.")).toBe("Scriptable: fixed inputs and a visible result.");
    expect(automationReasonText("Scriptable.")).toBe("Scriptable.");
    expect(automationReasonText(null)).toBe("");
  });
});

test("coverage items read as their label ('empty'), falling back to the raw id only without one", () => {
  expect(coverageItemText({ coverage_item: "len:0", coverage_item_label: "empty" })).toBe("empty");
  expect(coverageItemText({ coverage_item: "len:81", coverage_item_label: "81 characters" })).toBe("81 characters");
  expect(coverageItemText({ coverage_item: "len:0", coverage_item_label: null })).toBe("len:0");
  expect(coverageItemText({ coverage_item: "len:0" })).toBe("len:0");
  expect(coverageItemText(null)).toBe("");
});
