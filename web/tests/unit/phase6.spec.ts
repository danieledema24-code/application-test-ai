import { expect, test } from "@playwright/test";
import {
  CHANGE_STATEMENT,
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
import { changeSet, cosmeticItems, demoItems, scanRef } from "../../e2e/mocked/phase6-fixtures";

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
