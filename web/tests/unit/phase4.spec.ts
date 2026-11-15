import { expect, test } from "@playwright/test";
import {
  CHECK_LEGEND,
  CHECK_TEXT,
  SUITABILITY_TEXT,
  assertionText,
  assessmentSentence,
  automationBadge,
  automationPhase,
  checksByStep,
  fileLinkName,
  g6Groups,
  g6StatusText,
  groupScripts,
  locatorStatusHint,
  locatorStatusText,
  problemLines,
  validationSentence,
  type ScriptRow,
} from "../../src/lib/automation";
import { automationValueText } from "../../src/lib/testcases";
import { PROJECT_SECTIONS, isBuilt, sectionBadge } from "../../src/lib/sections";

const row = (path: string, over: Partial<ScriptRow> = {}): ScriptRow => ({
  id: path,
  case_key: path.split("/").pop()!.replace(".spec.ts", ""),
  case_title: "",
  test_case_id: "t",
  case_lineage_id: "l",
  case_version: 1,
  path,
  version: 1,
  generated_by: "rules",
  status: "valid",
  checks: { guard: "ok", tsc: "ok", eslint: "ok", secret_scan: "ok", tags: "ok", locators: "ok" },
  locators: { failed: 0, not_checked: 0 },
  first_problem: null,
  ...over,
});

test.describe("Phase 4 · automation vocabulary (design P4 §3, §19)", () => {
  test("suitability labels replace the preliminary ones once assessed", () => {
    expect(SUITABILITY_TEXT).toEqual({ suitable: "Can be automated", partial: "Needs test credentials", manual_only: "Needs a person" });
    expect(automationValueText({ value: "suitable", assessed: "assessed" })).toBe("Can be automated");
    expect(automationValueText({ value: "manual_only", assessed: "assessed" })).toBe("Needs a person");
    expect(automationValueText({ value: "suitable", assessed: "preliminary" })).toBe("Suitable (preliminary)");
    expect(automationValueText(null)).toBe("");
  });

  test("check names and the legend", () => {
    expect(Object.values(CHECK_TEXT)).toEqual(["Safety check", "TypeScript", "Code style", "No secrets", "Test case tag", "Live page"]);
    expect(CHECK_LEGEND.locators).toContain("we don't click, type or submit");
  });

  test("locator statuses", () => {
    expect(locatorStatusText("unique", 1)).toBe("Found once");
    expect(locatorStatusText("multiple", 2)).toBe("Found 2 times");
    expect(locatorStatusText("missing", 0)).toBe("Not found");
    expect(locatorStatusText("not_checked", null)).toBe("Not checked");
    expect(locatorStatusHint("multiple", null)).toBe("A test would fail: it must match exactly one.");
    expect(locatorStatusHint("not_checked", null)).toBe("needs sign-in and no test credentials are saved");
  });

  test("overview sentences", () => {
    expect(assessmentSentence({ suitable: 18, partial: 2, manual_only: 4, total: 24 })).toBe(
      "18 of 24 approved test cases can be automated · 2 need test credentials · 4 need a person",
    );
    expect(assessmentSentence({ suitable: 1, partial: 1, manual_only: 1, total: 3 })).toBe(
      "1 of 3 approved test cases can be automated · 1 needs test credentials · 1 needs a person",
    );
    expect(validationSentence({ valid: 21, invalid: 1, locators_not_checked: 2 })).toBe("21 valid · 1 can't run · 2 not checked on the live page");
    expect(validationSentence(undefined)).toBe("0 valid");
  });
});

test.describe("Phase 4 · scripts (design P4 §6.3)", () => {
  test("file link names carry the status", () => {
    expect(fileLinkName("tests/contact/TC-0040.spec.ts", "invalid")).toBe("TC-0040.spec.ts, can't run");
    expect(fileLinkName("tests/contact/TC-0019.spec.ts", "valid")).toBe("TC-0019.spec.ts");
    expect(fileLinkName("fixtures.ts", "platform")).toBe("fixtures.ts, platform file");
  });

  test("scripts are grouped by feature folder, sorted", () => {
    const g = groupScripts([row("tests/sign-in/TC-0003.spec.ts"), row("tests/contact/TC-0019.spec.ts"), row("tests/contact/TC-0002.spec.ts")]);
    expect(g.map((x) => [x.folder, x.scripts.map((s) => s.case_key)])).toEqual([
      ["contact", ["TC-0002", "TC-0019"]],
      ["sign-in", ["TC-0003"]],
    ]);
  });

  test("problem lines come from failed checks, never from not-checked locators", () => {
    const lines = problemLines({
      locators: { ok: false, messages: [{ line: 22, message: "Line 22: Locator 'Message' was not found on /contact" }, { line: 9, message: "Line 9: not checked", not_checked: true }] },
      secret_scan: { ok: false, messages: [{ line: 4, message: "Line 4: an access token appears in the script" }] },
      tsc: { ok: true, messages: [] },
    });
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual([4, 22]);
    expect(lines.get(22)).toEqual(["Line 22: Locator 'Message' was not found on /contact"]);
  });

  test("what the script checks, in words, per step", () => {
    const map = [
      { step: 1, helper: "expectFormShown", args: ["Contact us"], kind: "form_shown", step_text: "Open /contact" },
      { step: 5, helper: "expectSubmissionBlocked", args: ["Contact us"], kind: "submission_blocked", step_text: "Press Send message" },
      { step: 5, helper: "expectFieldFlagged", args: ["Contact us", "Message"], kind: "field_flagged", step_text: "Press Send message" },
    ];
    expect(assertionText(map[0])).toBe("The Contact us form is shown");
    expect(checksByStep(map)).toEqual([
      { step: 1, stepText: "Open /contact", checks: ["The Contact us form is shown"] },
      { step: 5, stepText: "Press Send message", checks: ["Submission is blocked", "Message is flagged"] },
    ]);
  });
});

test.describe("Phase 4 · Gate 6 and navigation (design P4 §4.2, §6.4, §6.5)", () => {
  test("G6 status is role-aware and checks are grouped", () => {
    expect(g6StatusText("passed_automatically", false)).toBe("Passed automatically");
    expect(g6StatusText("waiting", true)).toBe("Waiting for your approval");
    expect(g6StatusText("waiting", false)).toBe("Waiting for approval by someone who can approve gates");
    const g = g6Groups([
      { code: "valid_scripts", met: true, blocking: true, message: "", link: null },
      { code: "ai_reviewed", met: false, blocking: true, message: "", link: null },
      { code: "no_invalid", met: false, blocking: false, message: "", link: null },
    ]);
    expect([g.blockers.length, g.advice.length, g.passed.length]).toEqual([1, 1, 1]);
  });

  test("Automation, Test Execution and Defects are built (Phase 5 builds Non-functional too)", () => {
    const by = (slug: string) => PROJECT_SECTIONS.find((s) => s.slug === slug)!;
    expect(isBuilt(by("automation"))).toBe(true);
    expect(isBuilt(by("execution"))).toBe(true);
    expect(isBuilt(by("defects"))).toBe(true);
    expect(isBuilt(by("non-functional"))).toBe(true);
  });

  test("sidebar badge: Review, then Out of date, then invalid count", () => {
    const stages = (status: string) => [{ key: "automation", status, gate: null }];
    expect(sectionBadge("automation", stages("awaiting_approval"))).toEqual({ text: "Review", srText: "Gate 6 waiting for approval" });
    expect(sectionBadge("automation", stages("stale"))).toEqual({ text: "Out of date", srText: "out of date" });
    expect(sectionBadge("automation", stages("completed"))).toBeNull();
    expect(automationBadge([{ key: "automation", status: "completed" }], 2)).toEqual({ text: "2 invalid", srText: "2 scripts can't run" });
  });

  test("workspace phase", () => {
    const st = (a: string, b: string) => [
      { key: "automation_assessment", status: a },
      { key: "automation", status: b },
    ];
    const none = { g5: { approved: false, decided_at: null, design_version: null }, bundle: null };
    const g5 = { ...none, g5: { approved: true, decided_at: null, design_version: 1 } };
    expect(automationPhase(st("not_started", "not_started"), none)).toBe("g5_missing");
    expect(automationPhase(st("not_started", "not_started"), g5)).toBe("not_assessed");
    expect(automationPhase(st("running", "not_started"), g5)).toBe("assessing");
    expect(automationPhase(st("completed", "queued"), g5)).toBe("writing");
    expect(automationPhase(st("completed", "failed"), g5)).toBe("failed");
  });
});
