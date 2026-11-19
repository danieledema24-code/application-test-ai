import { expect, test } from "@playwright/test";
import {
  CHANGE_STATEMENT,
  CHOOSE_OPTION,
  DEFAULT_IMPACT_FILTER,
  IMPACT_ACTION_LABEL,
  IMPACT_LEVEL_HELP,
  IMPACT_LEVEL_LABEL,
  IMPACT_STATUS_LABEL,
  NO_ACTION_REASON,
  affectedLines,
  autoCloseLine,
  byGroup,
  closeErrors,
  closedLine,
  durationText,
  estimateLine,
  filterImpact,
  impactHeading,
  impactLine,
  includeShouldText,
  nextCloseTarget,
  nextSteps,
  requestedRunStatus,
  requestedToast,
  requirementTree,
  targetLabel,
  LATER_SCAN,
  compareError,
  compareWithHint,
  cosmeticCount,
  countsLine,
  existingPair,
  filterItems,
  groupOf,
  journeyLines,
  navigationLines,
  pagesWithChanges,
  partialWarning,
  rebaselineText,
  scanKindLabel,
  scanOptionLabel,
  screenshotAlt,
  setStatusLabel,
  showingLine,
  sideText,
  type ChangeFilter,
} from "../../src/lib/change";
import { fmtDate } from "../../src/lib/format";
import { CURRENT_PHASE } from "../../src/lib/sections";
import { changeSet, cosmeticItems, demoImpact, demoItems, demoRecommendation, demoRepairs, newP6, scanRef } from "../../e2e/mocked/phase6-fixtures";
import * as R from "../../src/lib/repairs";

const ANY: ChangeFilter = { hideCosmetic: false, kind: "", significance: "", page: "" };
const s1 = scanRef({ n: 1, day: "12", pages: 11 }, 2);
const s2 = scanRef({ n: 2, day: "13", g2: true, pages: 12 }, 2);
const s3 = scanRef({ n: 3, day: "15", rescan: true, pages: 13 }, 2);

test.describe("Phase 6 · change sets (P6-01, design P6 §3, §6)", () => {
  test("the phase is 6 and the statement is the fixed text", () => {
    expect(CURRENT_PHASE).toBe(6);
    expect(CHANGE_STATEMENT).toMatch(/^Changes are detected by comparing what discovery saw in two scans\./);
  });

  test("items fall into the five groups; demo pages with a before/after are listed once", () => {
    const items = demoItems();
    expect(items.map(groupOf).sort()).toEqual(["elements", "elements", "elements", "elements", "elements", "journeys", "navigation", "pages", "pages"]);
    expect(groupOf({ kind: "requirement_changed" })).toBe("requirements");
    expect(pagesWithChanges(items)).toEqual(["/contact", "/offers", "/products", "/products/1"]);
  });

  test("Hide cosmetic changes: hidden count and 'Showing n of m'", () => {
    const items = [...demoItems(), ...cosmeticItems()];
    expect(cosmeticCount(items)).toBe(2);
    const shown = filterItems(items, { ...ANY, hideCosmetic: true });
    expect(showingLine(shown.length, items.length)).toBe("Showing 10 of 12 changes");
    expect(filterItems(items, ANY)).toHaveLength(12);
    expect(filterItems(items, { ...ANY, kind: "content_values" }).map((i) => i.subject)).toEqual(["Content values changed on /products/2 (1)"]);
    expect(filterItems(items, { ...ANY, significance: "behavioural" })).toHaveLength(3);
    expect(filterItems(items, { ...ANY, page: "/contact" }).map((i) => i.kind).sort()).toEqual(["element_renamed", "field_added", "field_changed"]);
    expect(showingLine(1, 1)).toBe("Showing 1 of 1 change");
  });

  test("before and after are written out in words", () => {
    const [added, removed, link, renamed, form, order, message] = demoItems();
    expect(sideText(added, added.before)).toBe("—");
    expect(sideText(added, added.after)).toBe("Offers · 200");
    expect(sideText(removed, removed.before)).toBe("Ceramic mug · 200");
    expect(sideText(link, link.before)).toBe('"Travel mug"');
    expect(sideText(renamed, renamed.after)).toBe('"Send"');
    expect(sideText(form, form.after)).toBe('1 field · submit "Apply code"');
    expect(sideText(order, order.after)).toBe('"Order number" · text · optional · up to 20 characters');
    expect(sideText(message, message.before)).toBe('"Message" · textarea · optional');
    expect(sideText(message, message.after)).toBe('"Your message" · textarea · required');
    const [values, headings] = cosmeticItems();
    expect(sideText(values, values.after)).toBe("Price: £13.00");
    expect(sideText(headings, headings.before)).toBe("About");
  });

  test("navigation and journey lines", () => {
    const items = demoItems();
    expect(navigationLines(items.find((i) => i.kind === "navigation_changed")!)).toEqual(['Link added: "Offers" → /offers']);
    expect(journeyLines(items.find((i) => i.kind === "journey_changed")!)).toEqual(['step 3 "Enter Message" → "Enter Your message"', 'step 4 "Press Send message" → "Press Send"']);
  });

  test("compare picker: To must be later; an existing pair opens instead of comparing again", () => {
    expect(compareError(3, 2)).toBe(LATER_SCAN);
    expect(compareError(2, 2)).toBe(LATER_SCAN);
    expect(compareError(2, 3)).toBeNull();
    const sets = [changeSet("CHG-0001", s2, s3, demoItems()), changeSet("CHG-0002", s1, s3, [], { status: "failed" })];
    expect(existingPair(sets, 2, 3)?.key).toBe("CHG-0001");
    expect(existingPair(sets, 1, 3)).toBeNull(); // a failed comparison can be tried again
  });

  test("scan labels, the Compare with hint and the counts line", () => {
    expect(scanOptionLabel(s2, fmtDate)).toBe(`Scan 2 · ${fmtDate(s2.started_at)} · approved at Gate 2`);
    expect(scanOptionLabel({ ...s3, status: "partial" }, fmtDate)).toBe(`Scan 3 · ${fmtDate(s3.started_at)} · rescan (partial)`);
    expect(scanKindLabel({ number: 3, is_rescan: true, baseline_number: 2 }, 1)).toBe("Rescan, compared with 2");
    expect(scanKindLabel({ number: 1 }, 1)).toBe("First scan");
    expect(scanKindLabel({ number: 2 }, 1)).toBe("Re-scan");
    expect(compareWithHint({ number: 3 }, { number: 2 })).toBe("Scan 3 wasn't approved at Gate 2. Changes are still listed, but approved work is linked to Scan 2.");
    expect(compareWithHint({ number: 2, g2_approved: true }, { number: 2 })).toBeNull();
    expect(countsLine(changeSet("CHG-0001", s2, s3, demoItems()))).toBe("9 changes: 6 structural · 3 behavioural · 0 cosmetic");
    expect(setStatusLabel("completed")).toBe("Compared");
    expect(setStatusLabel("failed")).toBe("Didn't complete");
    expect(setStatusLabel("running")).toBe("Comparing…");
  });

  test("screenshot alts name page, scan, date and size; partial and re-baseline warnings", () => {
    expect(screenshotAlt("Before", "/contact", 2, "13 Nov 2026")).toBe("Before: /contact in Scan 2, 13 Nov 2026, desktop 1440 × 900.");
    expect(partialWarning({ base: s2, target: s3 })).toBeNull();
    expect(partialWarning({ base: s2, target: { ...s3, partial: true, pages: 9 } })).toBe(
      "Scan 3 stopped early after 9 pages. Pages it didn't reach are listed as 'Not compared', not as removed.",
    );
    const big = changeSet("CHG-0003", s2, s3, [], { rebaseline_suggested: true });
    big.summary.pages = { baseline: 12, target: 13, added: 1, removed: 3, changed: 6, not_compared: 0, structural: 5, baseline_compared: 12 };
    expect(rebaselineText(big)).toBe(
      "More than half the pages changed (8 of 12). Approved requirements may no longer describe the site. Consider regenerating requirements from Scan 3; you review the result before anything is replaced.",
    );
  });
});

test.describe("Phase 6 · impact and the regression run (P6-02, design P6 §3.3, §6.4, §7)", () => {
  const items = demoImpact();
  const byId = (id: string) => items.find((i) => i.id === id)!;
  const fmt = (iso: string | null | undefined) => (iso ? "15 Nov 15:40" : "—");

  test("labels: levels, actions, statuses and the level meanings (§3.3)", () => {
    expect(IMPACT_LEVEL_LABEL).toEqual({ direct: "Direct", indirect: "Indirect", gap: "Not covered" });
    expect(IMPACT_LEVEL_HELP.indirect).toBe("On a changed page or feature, but no step uses the changed element.");
    expect(IMPACT_ACTION_LABEL.heal).toBe("Repair the script");
    expect(IMPACT_STATUS_LABEL.no_action).toBe("No action needed");
  });

  test("filters: Open by default; level, status and type combine", () => {
    expect(filterImpact(items, DEFAULT_IMPACT_FILTER)).toHaveLength(13);
    expect(filterImpact(items, { ...DEFAULT_IMPACT_FILTER, level: "gap" }).map((i) => i.id)).toEqual(["i-gap1", "i-gap2"]);
    expect(filterImpact(items, { ...DEFAULT_IMPACT_FILTER, kind: "automation_script" }).map((i) => i.id)).toEqual(["i-sc19", "i-sc20"]);
    const closed = items.map((i) => (i.id === "i-tc12" ? { ...i, status: "no_action" as const } : i));
    expect(filterImpact(closed, DEFAULT_IMPACT_FILTER)).toHaveLength(12);
    expect(filterImpact(closed, { ...DEFAULT_IMPACT_FILTER, status: "no_action" }).map((i) => i.id)).toEqual(["i-tc12"]);
    expect(filterImpact(closed, { ...DEFAULT_IMPACT_FILTER, status: "all" })).toHaveLength(13);
    expect(impactHeading(closed)).toBe("Impact · 12 open of 13");
  });

  test("requirement → case → script nesting; orphans stay at the top level", () => {
    const req = byGroup(items).requirements;
    const tree = requirementTree(req);
    expect(tree.map((n) => n.item.id)).toEqual(["i-req7", "i-req2"]);
    expect(tree[0].children.map((n) => [n.item.id, n.children.map((c) => c.item.id)])).toEqual([
      ["i-tc19", ["i-sc19"]],
      ["i-tc20", ["i-sc20"]],
    ]);
    // Filtered to scripts only: nothing is hidden for want of a parent.
    expect(requirementTree(req.filter((i) => i.target_kind === "automation_script")).map((n) => n.item.id)).toEqual(["i-sc19", "i-sc20"]);
    expect(Object.fromEntries(Object.entries(byGroup(items)).map(([g, xs]) => [g, xs.length]))).toEqual({ requirements: 7, defects: 1, page_removed: 3, review: 0, gaps: 2 });
  });

  test("rows say how they close: by themselves (re-run, repair) or by a person, and who closed them", () => {
    expect(autoCloseLine(byId("i-tc19"), "CHG-0001")).toBe("Closes by itself when TC-0019 has a result from a run after CHG-0001.");
    expect(autoCloseLine(byId("i-def1"), "CHG-0001")).toBe("Closes by itself when TC-0019 has a result from a run after CHG-0001.");
    expect(autoCloseLine(byId("i-sc19"), "CHG-0001")).toBe("Closes by itself when the script is valid again.");
    expect(autoCloseLine(byId("i-tc12"), "CHG-0001")).toBeNull();
    expect(closedLine(byId("i-tc12"), fmt)).toBeNull();
    expect(closedLine({ ...byId("i-tc19"), status: "resolved", resolved_by_run: { id: "r5", key: "RUN-0005" }, resolved_at: "2026-11-15T15:40:00Z" }, fmt)).toBe("Resolved by RUN-0005 (15 Nov 15:40)");
    expect(closedLine({ ...byId("i-tc12"), status: "no_action", status_reason: "Retired", resolved_by: { id: "m", full_name: "M. Member" } }, fmt)).toBe("No action needed · M. Member: 'Retired'");
    expect(closedLine({ ...byId("i-sc19"), status: "resolved", resolved_at: null }, fmt)).toBe("Resolved: TC-0019's script is valid again.");
    expect(targetLabel(byId("i-gap1"))).toBe("/offers · page added");
    expect(targetLabel(byId("i-sc20"))).toBe("Script tests/contact/TC-0020.spec.ts");
    expect(targetLabel(byId("i-prf"))).toBe("PRF-01 target /products/1");
  });

  test("close dialog errors and where focus goes after closing (§7.2, §16.2)", () => {
    expect(closeErrors(null, "")).toEqual({ choice: CHOOSE_OPTION });
    expect(closeErrors("no_action", "  ")).toEqual({ reason: NO_ACTION_REASON });
    expect(closeErrors("no_action", "Retired")).toEqual({});
    expect(closeErrors("resolved", "")).toEqual({});
    const rows = filterImpact(items, DEFAULT_IMPACT_FILTER);
    expect(nextCloseTarget(rows, "i-tc12")).toEqual({ kind: "item", id: "i-a11y" });
    expect(nextCloseTarget(rows, "i-prf")).toEqual({ kind: "item", id: "i-tc12" });
    const one = rows.filter((i) => i.group !== "page_removed" || i.id === "i-prf");
    expect(nextCloseTarget(one, "i-prf")).toEqual({ kind: "group", group: "page_removed" });
    // Re-run items are never a target: they have no [Close…].
    expect(nextCloseTarget(rows.filter((i) => i.group === "defects" || i.id === "i-req2"), "i-req2")).toEqual({ kind: "group", group: "requirements" });
  });

  test("the regression run: estimate, should-run checkbox, toasts and run status (§7.4)", () => {
    const set = newP6().sets[0];
    const rec = demoRecommendation({ outdated: true, runs: [], role: "owner" }, set);
    expect(rec.blocked?.message).toBe("2 must-run tests have outdated scripts. Accept or reject their repair suggestions first.");
    expect(estimateLine(rec, true)).toBe("about 3 min (from RUN-0003)");
    expect(estimateLine(rec, false)).toBe("under a minute (from RUN-0003)");
    expect(estimateLine({ ...rec, estimate: { ...rec.estimate!, with_should_seconds: null } }, true)).toBe("No estimate: these tests haven't run before.");
    const partly = { ...rec, estimate: { ...rec.estimate!, no_history: ["TC-0020", "TC-0030"] } };
    expect(estimateLine(partly, true)).toBe("about 3 min (from RUN-0003) · no timing yet for TC-0020, TC-0030");
    expect(estimateLine(partly, false)).toBe("under a minute (from RUN-0003) · no timing yet for TC-0020");
    expect(durationText(null)).toBeNull();
    expect(durationText(150)).toBe("about 3 min");
    expect(includeShouldText(rec)).toEqual({ label: 'Include the 3 "should run" tests', detail: "5 tests, about 3 min · without them: 2 tests, under a minute" });
    expect(requestedToast("RUN-0005", false)).toBe("RUN-0005 requested. Someone who can approve must authorise it (Gate 7).");
    expect(requestedToast("RUN-0005", true)).toBe("RUN-0005 created. Review and authorise it to start.");
    expect(requestedRunStatus("awaiting_authorisation")).toBe("Waiting for authorisation");
    expect(demoRecommendation({ outdated: false, runs: [], role: "owner" }, set).blocked).toBeNull();
  });

  test("summary cards: Affected, Next steps and the Latest change line (§6.1, §6.4)", () => {
    const set = newP6().sets[0];
    expect(affectedLines(set.impact!)).toEqual(["2 requirements · 4 test cases", "2 scripts outdated", "1 defect to re-test", "3 to review · 2 not covered"]);
    expect(impactLine(set)).toBe("13 of 13 impact items open · 2 scripts outdated · regression run: not requested yet");
    expect(impactLine({ impact: null, regression: null })).toBeNull();
    const rec = demoRecommendation({ outdated: true, runs: [], role: "owner" }, set);
    expect(nextSteps(items, rec)[0]).toMatchObject({ tab: "repairs", action: "Review repairs" });
    expect(nextSteps(items, rec).map((s) => [s.text, s.done])).toEqual([
      ["Repair 2 outdated scripts", false],
      ["Request the regression run (Gate 7)", false],
      ["Close 7 review items", false],
    ]);
    const done = items.map((i) => (i.action === "heal" || i.can_close ? { ...i, status: "resolved" as const } : i));
    const requested = { ...rec, requested_runs: [{ id: "r5", key: "RUN-0005", status: "queued", include_should: true, created_at: null }] };
    expect(nextSteps(done, requested).map((s) => [s.text, s.done])).toEqual([
      ["Scripts repaired", true],
      ["Regression run requested (RUN-0005)", true],
      ["Review items closed", true],
    ]);
  });
});

test.describe("Phase 6 · repairs (P6-04, design P6 §3.5, §8)", () => {
  const [h1, h2, h3, h5, h4] = demoRepairs();
  const fmt = () => "15 Nov 10:20";

  test("vocabulary: levels, statuses, sources and titles in words", () => {
    expect(R.REPAIR_LINE).toBe("Only this locator changes; the test's checks stay the same.");
    expect(R.levelText(h1.candidates[0])).toBe("High match (0.93)");
    expect(R.levelText({ level: "medium", score: 0.5 })).toBe("Medium match (0.50)");
    expect(R.statusLabel(h1)).toBe("Open");
    expect(R.statusLabel(h3)).toBe("Needs a person");
    expect(R.statusLabel({ kind: "locator", status: "superseded" })).toBe("Replaced");
    expect(R.sourceLine(h1)).toBe("From CHG-0001 (before any test failed)");
    expect(R.sourceLine(h5)).toBe("From a failed test (RUN-0003-07)");
    expect(R.cardTitle(h1)).toBe("HEAL-0001 · ContactPage.ts · the Message field");
    expect(R.cardTitle(h3)).toBe("HEAL-0003 · Expected result may be out of date · TC-0021");
    expect(R.cardTitle({ ...h3, review: { ...h3.review!, reason: "page_removed" } })).toBe("HEAL-0003 · Test case needs review · TC-0021");
    expect(R.tabLabel(2)).toBe("Repairs (2)");
    expect(R.tabLabel(undefined)).toBe("Repairs");
  });

  test("candidates: High and Medium listed, Low under Other possibilities, ambiguous not offered; the first is chosen", () => {
    const s = R.splitCandidates(h1);
    expect(s.main.map((c) => c.expression)).toEqual(["getByLabel('Your message')", "getByRole('textbox', { name: 'Your message' })"]);
    expect(s.other.map((c) => c.expression)).toEqual(["getByLabel('Order number')"]);
    expect(R.firstChoice(h1)).toBe(0);
    expect(R.firstChoice(h4)).toBeNull();
    expect(R.notOfferedText(h4.candidates[0])).toBe("More than one element matches; not offered (2 matches)");
    expect(R.firstChoice({ candidates: h1.candidates.filter((c) => c.level === "low") })).toBe(2);
  });

  test("text alternatives and the verified line", () => {
    expect(R.screenshotAlt(h1.candidates[0], "/contact")).toBe("Screenshot of /contact on 15 Nov with the matched element outlined: text box 'Your message'.");
    expect(R.screenshotAlt(h2.candidates[0], "/contact")).toBe("Screenshot of /contact on 15 Nov with the matched element outlined: button 'Send'.");
    expect(R.elementText(null)).toBe("the element");
    expect(R.verifiedLine(h1.candidates[0], "/contact", fmt)).toBe("Found exactly 1 visible element on /contact (checked 15 Nov 10:20)");
  });

  test("accept confirmation, decided lines and the check result", () => {
    expect(R.acceptText(h1, h1.candidates[0])).toBe(
      "Use getByLabel('Your message') in ContactPage.ts? Only this locator changes; the test's checks stay the same. ContactPage.ts version 3 is created, and the 1 script that uses it is checked again (Gate 6) before it can run.",
    );
    expect(R.acceptText(h2, h2.candidates[0])).toContain("the 2 scripts that use it are checked again (Gate 6) before they can run.");
    expect(R.acceptName(h1)).toBe("Accept this replacement for getByLabel('Message')");
    const accepted = { ...h1, status: "accepted" as const, decided_by: { id: "m", full_name: "M. Member" }, decided_at: "2026-11-15T10:31:00Z", new_asset_version: 3 };
    expect(R.acceptedLine(accepted, fmt)).toBe("Accepted by M. Member · 15 Nov 10:20 · ContactPage.ts version 3");
    expect(R.checkingLine({ ...accepted, checking: { state: "checking", scripts: h2.used_by } })).toEqual({ tone: "busy", text: "Checking 2 scripts…" });
    expect(R.checkingLine({ ...accepted, checking: { state: "valid", scripts: h1.used_by } })?.text).toBe("1 script valid again. The impact item is closed.");
    const bad = [{ ...h2.used_by[0], state: "invalid", first_error: "Expected the Send control to be shown" }];
    expect(R.checkingLine({ ...accepted, checking: { state: "invalid", scripts: bad } })?.text).toBe("TC-0020 still fails its checks: Expected the Send control to be shown.");
    expect(R.checkingLine(h1)).toBeNull();
    const rejected = { ...h2, status: "rejected" as const, reason: "Tested elsewhere", decided_by: { id: "m", full_name: "M. Member" } };
    expect(R.rejectedLine(rejected)).toBe("Rejected by M. Member: 'Tested elsewhere'. Fix the test case or regenerate the scripts.");
    expect(R.replacedLine({ reason: "Another suggestion for this locator was accepted (HEAL-0001)" })).toBe("Replaced: another suggestion for this locator was accepted (HEAL-0001)");
    expect(R.acceptError(h1, "The page object changed since this suggestion.", 409)).toBe("The page object changed since this suggestion.");
    expect(R.acceptError(h1, "These scripts were replaced by a newer version.", 422)).toBe("Couldn't accept HEAL-0001: These scripts were replaced by a newer version. Nothing was changed.");
  });

  test("grouped by page object file; reviews under their own heading", () => {
    expect(R.groupByFile([h1, h2, h3, h4, h5]).map((g) => [g.file, g.items.map((x) => x.key)])).toEqual([
      ["ContactPage.ts", ["HEAL-0001", "HEAL-0002", "HEAL-0005"]],
      ["Expected results to review", ["HEAL-0003"]],
      ["HomePage.ts", ["HEAL-0004"]],
    ]);
  });
});
