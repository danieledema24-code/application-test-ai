// P4-14b manual results: the pure helpers behind the Start modal, the record page, finishing and the displays
// (design docs/design/P4-14-manual-results.md §4–§7).
import { expect, test } from "@playwright/test";
import {
  RESULT_STATUS,
  checkResultFiles,
  defaultSelection,
  finishBlocker,
  finishedCallout,
  finishCopy,
  manualCounts,
  manualErrors,
  manualFinishedToast,
  manualLabel,
  manualProgress,
  manualResultsSentence,
  matchesCase,
  recordStartHref,
  recordedSummary,
  scriptedCaseKeys,
  runStatusText,
  savedAnnouncement,
  savedLine,
  startLabel,
  uploadedFileName,
  whoText,
  MANUAL_MAX_BYTES,
  type RunSummary,
  type StartCase,
  type TestRow,
} from "../../src/lib/execution";
import { execLine, resultText } from "../../src/lib/traceability";
import { attentionRows, manualPendingCount, needPersonKeys } from "../../src/lib/attention";
import { retestErrors, retestLine } from "../../src/lib/release";

const row = (status: TestRow["status"], id: string | null = "r"): Pick<TestRow, "status" | "id"> => ({ status, id });

test("run status pill and run list text for a manual run (§5)", () => {
  const manual = { recorded: 2, tests: 4, change_set_key: null };
  expect(runStatusText({ status: "recording", totals: { tests: 4, finished: 2 }, mode: "manual", manual })).toEqual({ label: "Recording · 2 of 4 recorded", tone: "blue", status: "recording" });
  // Older responses without `manual`: totals carry the counts.
  expect(runStatusText({ status: "recording", totals: { tests: 4, finished: 0 }, mode: "manual" }).label).toBe("Recording · 0 of 4 recorded");
  expect(runStatusText({ status: "failed", totals: { passed: 1, failed: 1 }, mode: "manual" }).label).toBe("Finished · 1 failed");
  expect(manualProgress({ totals: {}, tests: 3 })).toEqual({ recorded: 0, tests: 3 });
  const r = { status: "failed", totals: { passed: 1, failed: 1, tests: 4, finished: 2 }, tests: 4, manual } as Pick<RunSummary, "status" | "totals" | "tests" | "manual">;
  expect(manualResultsSentence(r)).toBe("1 passed · 1 failed · 2 not run (by hand)");
  expect(manualResultsSentence({ ...r, status: "recording" })).toBe("1 passed · 1 failed · 2 not recorded yet (by hand)");
  expect(manualResultsSentence({ status: "recording", totals: {}, tests: 4, manual: { recorded: 0, tests: 4, change_set_key: null } })).toBe("4 not recorded yet (by hand)");
  expect(whoText({ mode: "manual", requested_by: { full_name: "J. Tester" } } as RunSummary)).toBe("J. Tester · not needed (manual)");
  expect(RESULT_STATUS.not_recorded.label).toBe("Not recorded yet");
  expect(RESULT_STATUS.not_run.label).toBe("Not run");
});

test("record page summary, saved line and announcement (§4.2, §6, §7)", () => {
  const c = manualCounts([row("passed"), row("failed"), row("not_recorded", null), row("not_recorded", null)]);
  expect(c).toEqual({ recorded: 2, total: 4, passed: 1, failed: 1, blocked: 0 });
  expect(recordedSummary(c)).toBe("2 of 4 recorded · 1 passed · 1 failed");
  expect(recordedSummary(manualCounts([row("not_recorded", null)]))).toBe("0 of 1 recorded");
  expect(recordedSummary(manualCounts([row("blocked")]))).toBe("1 of 1 recorded · 1 blocked");
  expect(savedLine("passed", "J. Tester", "19 Nov 15:40")).toBe("Saved · Passed · Recorded by J. Tester, 19 Nov 15:40");
  expect(savedLine("blocked", null, null)).toBe("Saved · Blocked · Recorded by someone");
  expect(savedAnnouncement("TC-0027", "passed", 2, 4)).toBe("TC-0027 saved as Passed. 2 of 4 recorded.");
  expect(manualLabel("J. Tester")).toBe("By hand · Recorded by J. Tester");
});

test("card validation: status then What happened (§6)", () => {
  expect(manualErrors(null, "  ")).toEqual({ status: "Choose Passed, Failed or Blocked.", actual_result: "Describe what happened." });
  expect(manualErrors("failed", "")).toEqual({ actual_result: "Describe what happened." });
  expect(manualErrors("blocked", "No screen reader on this machine")).toEqual({});
});

test("file checks before queuing: type, 10 MB, 5 per result (§4.2, §6)", () => {
  const png = { name: "sign-in-form.png", size: 412_000 };
  const big = { name: "huge.png", size: 12 * 1024 * 1024 };
  const html = { name: "notes.html", size: 100, type: "text/html" };
  const pdf = { name: "network.PDF", size: 1_200_000 };
  const jpegByMime = { name: "photo", size: 10, type: "image/jpeg" };
  expect(checkResultFiles([png, big, html, pdf, jpegByMime], 0)).toEqual({
    accepted: [png, pdf, jpegByMime],
    errors: ["huge.png: This file is larger than 10 MB.", "notes.html: This file type isn't supported. Use PNG, JPEG or PDF."],
  });
  expect(checkResultFiles([{ name: "edge.png", size: MANUAL_MAX_BYTES }], 0).accepted).toHaveLength(1);
  // 4 already uploaded or queued: one more fits, the 6th doesn't.
  expect(checkResultFiles([png, pdf], 4)).toEqual({ accepted: [png], errors: ["You can add up to 5 files to a result."] });
  expect(checkResultFiles([png], 5)).toEqual({ accepted: [], errors: ["You can add up to 5 files to a result."] });
  expect(uploadedFileName({ mime: "application/pdf" }, 1)).toBe("File 2 (PDF)");
  expect(uploadedFileName({ mime: "image/png" }, 0)).toBe("File 1 (PNG)");
});

test("finish recording: blockers and confirm copy (§4.4)", () => {
  expect(finishBlocker(0, 0)).toBe("Record at least one case to finish, or discard the run.");
  expect(finishBlocker(2, 1)).toBe("Wait for 1 file to finish uploading.");
  expect(finishBlocker(2, 3)).toBe("Wait for 3 files to finish uploading.");
  expect(finishBlocker(2, 0)).toBeNull();
  expect(finishCopy("RUN-0005", [], null)).toEqual({ title: "Finish RUN-0005?", lines: ["Results can't be changed after this. To record again, start a new manual run."] });
  expect(finishCopy("RUN-0005", ["TC-0040", "TC-0041"], null)).toEqual({
    title: "Finish with 2 cases not recorded? They'll show 'Not run'.",
    lines: ["Not recorded: TC-0040, TC-0041.", "Results can't be changed after this."],
  });
  expect(finishCopy("RUN-0005", ["TC-0040"], "J. Tester")).toEqual({
    title: "Finish with 1 case not recorded? It'll show 'Not run'.",
    lines: ["J. Tester started RUN-0005. Finishing it ends recording for everyone.", "Not recorded: TC-0040.", "Results can't be changed after this."],
  });
  const at = () => "19 Nov 16:10";
  expect(finishedCallout({ key: "RUN-0005", finished_at: "x", finished_by: { id: "j", full_name: "J. Tester" } }, at)).toBe("RUN-0005 was finished by J. Tester on 19 Nov 16:10. Start a new manual run to record again.");
  expect(finishedCallout({ key: "RUN-0005", finished_at: "x", finished_by: null }, at)).toBe("RUN-0005 was finished on 19 Nov 16:10. Start a new manual run to record again.");
  const c = manualCounts([row("passed"), row("failed"), row("not_recorded", null), row("not_recorded", null)]);
  expect(manualFinishedToast("RUN-0005", c)).toBe("RUN-0005 finished: 1 passed, 1 failed, 2 not run.");
  expect(manualFinishedToast("RUN-0005", manualCounts([row("passed"), row("blocked")]))).toBe("RUN-0005 finished: 1 passed, 0 failed, 1 blocked.");
});

test("Start modal: default selection, search, label and entry-point URL (§3, §4.1)", () => {
  const cases: StartCase[] = [
    { key: "TC-0027", title: "Check the sign-in form's action address", needsPerson: true, lastStatus: null },
    { key: "TC-0033", title: "Keyboard-only navigation", needsPerson: true, lastStatus: "passed" },
    { key: "TC-0040", title: "Screen reader reads the form errors", needsPerson: true, lastStatus: "blocked" },
    { key: "TC-0019", title: "Send the form with an empty Message", needsPerson: false, lastStatus: "failed" },
  ];
  expect(defaultSelection(cases, null)).toEqual(["TC-0027", "TC-0040"]);
  expect(defaultSelection(cases, ["TC-0019", "TC-9999"])).toEqual(["TC-0019"]);
  const many = Array.from({ length: 120 }, (_, i) => ({ key: `TC-${1000 + i}`, title: "x", needsPerson: true, lastStatus: null }));
  expect(defaultSelection(many, null)).toHaveLength(100);
  expect(matchesCase(cases[1], "keyboard")).toBe(true);
  expect(matchesCase(cases[1], "tc-0033")).toBe(true);
  expect(matchesCase(cases[1], "screen")).toBe(false);
  expect(matchesCase(cases[1], "  ")).toBe(true);
  expect([...scriptedCaseKeys([{ case_key: "TC-0019", status: "valid" }, { case_key: "TC-0040", status: "invalid" }, { case_key: "TC-0031", status: "rejected" }])]).toEqual(["TC-0019", "TC-0040"]);
  expect(scriptedCaseKeys(null).size).toBe(0);
  expect(startLabel(1)).toBe("Start recording 1 case");
  expect(startLabel(3)).toBe("Start recording 3 cases");
  expect(recordStartHref("p1")).toBe("/projects/p1/execution?record=1");
  expect(recordStartHref("p1", { cases: ["TC-0019"] })).toBe("/projects/p1/execution?record=1&cases=TC-0019");
  expect(recordStartHref("p1", { cases: ["TC-0005", "TC-0031"], change: "CHG-0001" })).toBe("/projects/p1/execution?record=1&cases=TC-0005,TC-0031&change=CHG-0001");
});

test("traceability and change set lines say 'By hand · Recorded by' (§4.6, §5)", () => {
  const res = { status: "passed", run_key: "RUN-0005", result_key: "RUN-0005-01", at: "x", manual: true, recorded_by: "J. Tester" };
  expect(resultText(res)).toBe("✓ Passed RUN-0005 · By hand · Recorded by J. Tester");
  expect(resultText({ ...res, manual: false })).toBe("✓ Passed RUN-0005");
  expect(execLine({ script: null, result: res, defects: [] })).toBe("No script · Last result ✓ Passed (RUN-0005) · By hand · Recorded by J. Tester");
  expect(retestErrors(null, "")).toEqual({ status: "Choose Passed or Failed.", note: "Describe what happened." });
  expect(retestLine({ id: "r", status: "passed", note: "Signed in fine", recorded_by: { id: "m", full_name: "M. Member" }, recorded_at: "x", run_key: "RUN-0007", result_key: "RUN-0007-01" }, () => "15 Nov 16:00")).toBe(
    "Passed · By hand · Recorded by M. Member · 15 Nov 16:00: 'Signed in fine'",
  );
});

test("Overview: approved cases that need a person and have no recorded result (§3)", () => {
  const cases = [
    { key: "TC-0027", status: "approved", last_result: null },
    { key: "TC-0033", status: "approved", last_result: { status: "passed" } },
    { key: "TC-0040", status: "approved", last_result: { status: "blocked" } },
    { key: "TC-0041", status: "deprecated", last_result: null },
  ];
  expect(manualPendingCount(["TC-0027", "TC-0033", "TC-0040", "TC-0041", "TC-0099"], cases)).toBe(2);
  expect(manualPendingCount(["TC-0027"], undefined)).toBe(0);
  // No bundle yet: the assessment's "Needs a person" cases; with a bundle, its not_automated list (no repeats).
  expect(needPersonKeys(null, [{ key: "TC-0027", suitability: "manual_only" }, { key: "TC-0019", suitability: "suitable" }])).toEqual(["TC-0027"]);
  expect(needPersonKeys([{ key: "TC-0027" }, { key: "TC-0033" }], [{ key: "TC-0027", suitability: "manual_only" }])).toEqual(["TC-0027", "TC-0033"]);
  expect(needPersonKeys(undefined, undefined)).toEqual([]);
  const base = { projectId: "p1", wf: undefined, credFailed: false, conflicts: 0, proposals: 0, drafts: 0 };
  expect(attentionRows({ ...base, manualPending: 2 })).toEqual([{ text: "2 approved cases need a person and have no recorded result.", action: "Record manual results", href: "/projects/p1/execution?record=1" }]);
  expect(attentionRows({ ...base, manualPending: 1 })[0].text).toBe("1 approved case needs a person and has no recorded result.");
  expect(attentionRows({ ...base, manualPending: 2, viewer: true })).toEqual([]);
  expect(attentionRows({ ...base, manualPending: 0 })).toEqual([]);
});
