import { expect, test } from "@playwright/test";
import { ADMIN_ONLY_PAGE, auditQuery, canArchive, deleteBlocked, deletionCallout, deletionScheduledText, exportText, NO_FILTERS, retentionErrors, shortening, whoText, type AuditEntry } from "../../src/lib/hardening";
import { runDefectGroups } from "../../src/lib/nonfunctional";
import { removedText } from "../../src/components/domain/RemovedEvidence";

// Design P5 §13.3–13.5 (checks 36–38): audit log filters and export copy, retention validation and the shorten
// dialog, archive and delete rights.

test("audit filters: whole days, 'to' includes the chosen day", () => {
  expect(auditQuery(NO_FILTERS)).toEqual({});
  expect(auditQuery({ group: "Projects", project: "p1", from: "2026-11-01", to: "2026-11-13" })).toEqual({
    group: "Projects",
    project: "p1",
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-14T00:00:00.000Z",
  });
});

test("export copy and the 100,000 limit", () => {
  expect(exportText(1284, 100000)).toEqual({ disabled: null, toast: "Export ready: 1,284 entries. The export itself is recorded in the audit log." });
  expect(exportText(100001, 100000).disabled).toBe("Exports are limited to 100,000 entries. Narrow the dates.");
  const e = { who: { name: "A. Approver", email: "a@example.com" }, actor_type: "user" } as AuditEntry;
  expect(whoText(e)).toBe("A. Approver · a@example.com");
  expect(whoText({ ...e, who: null, actor_type: "system" })).toBe("System");
});

test("retention: whole numbers only; shortening asks first, lengthening doesn't", () => {
  expect(retentionErrors({ videos_traces_days: "30", screenshots_days: "-1", timeseries_days: "1.5" })).toEqual({
    screenshots_days: "Enter a whole number of days (0 or more).",
    timeseries_days: "Enter a whole number of days (0 or more).",
  });
  const cur = { videos_traces_days: 30, screenshots_days: 90, timeseries_days: 90 };
  expect(shortening(cur, { ...cur, screenshots_days: 30 })).toEqual({
    title: "Keep screenshots for 30 days instead of 90?",
    body: "Screenshots older than 30 days are removed at the next daily clean-up. This can't be undone.",
    keep: "Keep 90 days",
    confirm: "Shorten to 30 days",
  });
  expect(shortening(cur, { ...cur, screenshots_days: 120 })).toBeNull();
  expect(shortening(cur, { ...cur, screenshots_days: 0 })).toBeNull(); // 0 keeps forever
  expect(shortening({ ...cur, videos_traces_days: 0 }, cur)?.keep).toBe("Keep forever");
  expect(shortening(cur, { ...cur, screenshots_days: 1 })).toEqual({
    title: "Keep screenshots for 1 day instead of 90?",
    body: "Screenshots older than 1 day are removed at the next daily clean-up. This can't be undone.",
    keep: "Keep 90 days",
    confirm: "Shorten to 1 day",
  });
});

test("archive: owner and admin; delete: owner only, archived first", () => {
  expect([canArchive("owner"), canArchive("admin"), canArchive("member"), canArchive("viewer")]).toEqual([true, true, false, false]);
  expect(deleteBlocked("admin", true)).toBe("Only the organisation owner can delete a project permanently.");
  expect(deleteBlocked("owner", false)).toBe("Archive the project first.");
  expect(deleteBlocked("owner", true)).toBeNull();
  const at = new Date(2026, 10, 14, 16, 2).toISOString();
  expect(deletionCallout(at)).toBe("This project will be deleted permanently on 14 Nov at 16:02. Only the audit log will keep a record.");
});

test("deletion toast in local time; owner/admin page message (checks 34, 38)", () => {
  const at = new Date(2026, 10, 14, 16, 2).toISOString();
  expect(deletionScheduledText("Demo Shop", at)).toBe("Demo Shop will be deleted on 14 Nov at 16:02.");
  expect(ADMIN_ONLY_PAGE).toBe("Only owners and admins can see this page.");
});

test("removed evidence and the run's defect groups (P5-BUG-03, P5-BUG-06)", () => {
  expect(removedText({ removed: "Removed by the retention policy on 14 Dec 2026." })).toBe("Removed by the retention policy on 14 Dec 2026.");
  expect([removedText({ removed: null }), removedText(null), removedText(undefined)]).toEqual([null, null, null]);
  const d = (key: string, link?: "drafted" | "occurrence_added") => ({ key, summary: key, status: "draft", link });
  expect(runDefectGroups([d("DEF-1", "drafted"), d("DEF-2", "occurrence_added"), d("DEF-3")]).map((g) => [g.label, g.items.map((x) => x.key)])).toEqual([
    ["Defect drafted", ["DEF-1", "DEF-3"]],
    ["Occurrence added to", ["DEF-2"]],
  ]);
  expect(runDefectGroups(undefined)).toEqual([]);
});
