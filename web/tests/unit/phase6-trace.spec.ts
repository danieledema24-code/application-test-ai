// Traceability with change, the Overview banner and the assistant's action proposals (P6-06; design P6 §4.5, §12.1, §12.3).
import { expect, test } from "@playwright/test";
import { CHAIN_KEY, changeCellText, changeLine, changeSr, changeTiles, chainLevels, gapCounts, keyHref, typeOfKey } from "../../src/lib/traceability";
import { ASSESS_FOOTER, EXPLORE_APPROVAL, EXPLORE_FOOTER, REGRESSION_FOOTER, actionProposal, actionToast, actionToastLink, isActionProposal } from "../../src/lib/assistant";
import { changedBanner, type ChangeSet } from "../../src/lib/change";
import { fmtShortDate } from "../../src/lib/format";
import type { ArtefactRef, Chain, ImpactCell } from "../../src/lib/contract";

const direct: ImpactCell = { change_set: "CHG-0001", level: "direct", status: "open", action: "rerun" };

test("Change cell, screen-reader text and 375 px line", () => {
  expect(changeCellText(direct)).toBe("Direct · CHG-0001 · open");
  expect(changeCellText({ ...direct, level: "indirect", status: "resolved" })).toBe("Indirect · resolved");
  expect(changeCellText({ ...direct, status: "no_action" })).toBe("Direct · no action needed");
  expect(changeCellText(null)).toBe("—");
  expect(changeSr("TC-0019", direct, "outdated")).toBe("Change for TC-0019: directly affected by CHG-0001, open. Script outdated.");
  expect(changeSr("TC-0019", null)).toBe("Change for TC-0019: not affected.");
  expect(changeLine({ impacted: direct, script: { file: "a.spec.ts", version: 1, state: "outdated" } })).toBe("Change: Direct · CHG-0001 · open · Script outdated");
  expect(changeLine({ impacted: null, script: { file: "a.spec.ts", version: 1, state: "current" } })).toBeNull();
});

test("change tiles link to the three gap lists; counts prefer the Phase 6 lists", () => {
  const tiles = changeTiles({ scripts_outdated: 2, impacted_not_rerun: 3, new_pages_without_requirements: 0 }, () => "/t?view=coverage");
  expect(tiles.map((t) => [t.label, t.value, t.href])).toEqual([
    ["Scripts that are outdated", "2", "/t?view=coverage#gap-outdated"],
    ["Impacted tests not re-run", "3", "/t?view=coverage#gap-impacted"],
    ["New pages without requirements", "0", "/t?view=coverage#gap-new-pages"],
  ]);
  expect(changeTiles(undefined, () => "")).toEqual([]);
  const counts = gapCounts({ scripts_outdated: [{}, {}], impacted_not_rerun: [{}], new_pages_without_requirements: [] } as never);
  expect([counts.outdated, counts.impacted, counts.new_pages]).toEqual([2, 1, 0]);
});

test("CHG, HEAL, EXP and REL keys are chain roots and open where they live", () => {
  for (const k of ["CHG-0001", "HEAL-0003", "EXP-0002", "REL-0001"]) expect(CHAIN_KEY.test(k)).toBe(true);
  expect(typeOfKey("EXP-0002-1")).toBe("exploratory_session");
  expect(keyHref("p", "CHG-0001")).toBe("/projects/p/discovery/changes/CHG-0001");
  expect(keyHref("p", "EXP-0002-1")).toBe("/projects/p/execution/exploratory/EXP-0002");
  expect(keyHref("p", "REL-0001")).toBe("/projects/p/release-readiness/REL-0001");
  expect(keyHref("p", "HEAL-0003")).toBe("/projects/p/traceability/HEAL-0003");
});

test("Phase 6 chains read top-down from the root; upstream goes beside", () => {
  const ref = (type: string, key: string) => ({ type, id: null, key, label: key, path: "" }) as unknown as ArtefactRef;
  const c: Chain = {
    root: ref("change_set", "CHG-0001"),
    upstream: [],
    downstream: [
      { type: "change_item", items: [ref("change_item", "Button removed")] },
      { type: "impact_item", items: [ref("impact_item", "Direct")] },
      { type: "requirement", items: [ref("requirement", "REQ-0001")] },
      { type: "test_case", items: [ref("test_case", "TC-0001")] },
      { type: "execution_result", items: [] },
    ],
    later_phase: [],
  };
  expect(chainLevels(c).chain.map((l) => l.type)).toEqual(["change_set", "change_item", "impact_item", "requirement", "test_case"]);
  const heal = chainLevels({ ...c, root: ref("heal_suggestion", "HEAL-0001"), upstream: [{ type: "change_set", items: [ref("change_set", "CHG-0001")] }], downstream: [] });
  expect(heal.chain.map((l) => l.type)).toEqual(["heal_suggestion"]);
  expect(heal.side.map((l) => l.type)).toEqual(["change_set"]);
});

test("action proposals: footers, the single button and the toast", () => {
  expect(isActionProposal("request_regression_run")).toBe(true);
  expect(isActionProposal("requirement_edit")).toBe(false);
  expect(actionProposal("request_regression_run", {})).toEqual({ footer: REGRESSION_FOOTER, applyLabel: "Create run request" });
  expect(actionProposal("start_exploration", {})).toEqual({ footer: EXPLORE_FOOTER, applyLabel: "Start exploring" });
  expect(actionProposal("start_exploration", { signed_in: true })).toEqual({ footer: `${EXPLORE_FOOTER} ${EXPLORE_APPROVAL}`, applyLabel: "Request approval" });
  expect(actionProposal("assess_release", {})?.footer).toBe(ASSESS_FOOTER);
  expect(actionProposal("requirement_edit", {})).toBeNull();
  expect(REGRESSION_FOOTER).toContain("Gate 7");
  expect(actionToast("request_regression_run", {}, "RUN-0004")).toBe("RUN-0004 requested. Someone who can approve must authorise it (Gate 7).");
  expect(actionToast("start_exploration", {}, "EXP-0002")).toBe("EXP-0002 started.");
  expect(actionToast("start_exploration", { signed_in: true }, "EXP-0002")).toBe("EXP-0002 requested. Someone who can approve must approve it.");
  expect(REGRESSION_FOOTER).toContain("the assistant can't start runs"); // the same apostrophe as the API
  expect(actionToastLink("request_regression_run", "p", "RUN-0004")).toEqual({ label: "Open RUN-0004", href: "/projects/p/execution/RUN-0004" });
  expect(actionToastLink("start_exploration", "p", "EXP-0002")).toEqual({ label: "Open EXP-0002", href: "/projects/p/execution/exploratory/EXP-0002" });
  expect(actionToastLink("assess_release", "p", "release_readiness")).toBeNull();
});

function set(over: Partial<ChangeSet> = {}): ChangeSet {
  const scan = (number: number, at: string) => ({ id: `s${number}`, key: `SCAN-${number}`, number, status: "completed", partial: false, is_rescan: number > 1, pages: 10, started_at: at, finished_at: at, created_at: at, g2_approved: true, baseline: number === 1 });
  return {
    id: "c1", key: "CHG-0001", status: "completed", source: "rescan",
    base: scan(2, "2026-11-13T10:00:00Z"), target: scan(3, "2026-11-15T10:00:00Z"),
    summary: { total: 9, by_significance: { structural: 4, behavioural: 4, cosmetic: 1 }, by_kind: null, content_values: 0, pages: null },
    not_compared: [], rebaseline_suggested: false, generated_by: "rules", ai_summary: null, started_by: null,
    created_at: null, finished_at: null, error: null, statement: "", permissions: { can_compare: true },
    impact: { open: 15 } as ChangeSet["impact"],
    ...over,
  };
}

test("Overview banner: latest completed rescan with open impact items", () => {
  const b = changedBanner([set()], fmtShortDate);
  expect(b?.key).toBe("CHG-0001");
  expect(b?.text).toBe(
    "The application changed. CHG-0001 found 9 changes between Scan 2 (13 Nov) and Scan 3 (15 Nov): 4 structural, 4 behavioural, 1 cosmetic. 15 impact items are open.",
  );
  expect(b?.rebaseline).toBeNull();
  expect(changedBanner([set({ rebaseline_suggested: true })], fmtShortDate)?.rebaseline).toBe("More than half the pages changed. Consider regenerating requirements from Scan 3.");
  expect(changedBanner([set({ impact: { open: 1 } as ChangeSet["impact"] })], fmtShortDate)?.text).toContain("1 impact item is open.");
  // Hidden when every item is closed, for a person's comparison, while comparing and with no change set.
  expect(changedBanner([set({ impact: { open: 0 } as ChangeSet["impact"] })], fmtShortDate)).toBeNull();
  expect(changedBanner([set({ source: "compare" })], fmtShortDate)).toBeNull();
  expect(changedBanner([set({ status: "running" })], fmtShortDate)).toBeNull();
  expect(changedBanner(undefined, fmtShortDate)).toBeNull();
});
