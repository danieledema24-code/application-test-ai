// Release Readiness and Test Completion reports: types, wording, file names and the per-assessment list (P6-05c, D34;
// design P6 §11).
import { expect, test } from "@playwright/test";
import {
  COMPLETION_GENERATED,
  P6_CSV_HINT,
  FORMAT_TEXT,
  P6_NOT_AVAILABLE,
  completionError,
  downloadFormats,
  isPhase6Report,
  latestPerAssessment,
  lessonsByline,
  lessonsHint,
  phase2ReportFileName,
  reportBySlug,
} from "../../src/lib/reports";

test.describe("Phase 6 reports", () => {
  test("slugs, names and the download menu: PDF, HTML, CSV, XLSX; never DOCX or JSON", () => {
    expect(reportBySlug("release-readiness")?.type).toBe("release_readiness");
    expect(reportBySlug("completion")?.name).toBe("Test Completion Report");
    expect(isPhase6Report("release_readiness") && isPhase6Report("completion") && !isPhase6Report("security")).toBe(true);
    for (const t of ["release_readiness", "completion"] as const) {
      expect(downloadFormats(t)).toEqual(["pdf", "html", "csv", "xlsx"]);
      expect(downloadFormats(t).map((f) => FORMAT_TEXT[f]).join(" ")).not.toMatch(/docx|json|word/i);
    }
    // Each CSV hint names what that file holds.
    expect(P6_CSV_HINT.release_readiness).toBe("Summary, criteria, conditions and residual risk, one section each.");
    expect(P6_CSV_HINT.completion).toMatch(/^Summary, results, measures, runs, deviations, defects, exit criteria, conditions and residual risk/);
  });

  test("file names: {host}-release-readiness-REL-0002-{date}, …-test-completion-current-…", () => {
    const d = new Date(2026, 10, 15);
    expect(phase2ReportFileName("shop.example.com", "release_readiness", 3, d, "pdf", "REL-0002")).toBe("shop.example.com-release-readiness-REL-0002-2026-11-15.pdf");
    expect(phase2ReportFileName("shop.example.com", "completion", 1, d, "xlsx", "REL-0002")).toBe("shop.example.com-test-completion-REL-0002-2026-11-15.xlsx");
    expect(phase2ReportFileName("shop.example.com", "completion", 2, d, "csv", null)).toBe("shop.example.com-test-completion-current-2026-11-15.csv");
  });

  test("copy: not available, generated, errors and the lessons byline", () => {
    expect(P6_NOT_AVAILABLE).toBe("Not available yet: assess release readiness first");
    expect(COMPLETION_GENERATED).toBe("Test Completion Report generated.");
    expect(completionError("Not available yet: assess release readiness first")).toBe("Couldn’t generate the report: Not available yet: assess release readiness first.");
    expect(completionError("REL-0009 doesn't exist.")).toBe("Couldn’t generate the report: REL-0009 doesn't exist.");
    expect(lessonsHint("M. Member")).toBe("Shown in the report as written by M. Member. The report is frozen when it’s generated.");
    // Never an email: without a name the report says "Written by someone." and the hint says so too.
    expect(lessonsHint("")).toBe("Shown in the report as written by someone (your profile has no name). The report is frozen when it’s generated.");
    expect(lessonsHint(null)).not.toMatch(/@/);
    expect(lessonsByline({ generated_by: "person", author: "M. Member" })).toBe("Written by M. Member.");
    expect(lessonsByline({ generated_by: "ai", author: "M. Member" })).toBe("Suggested by AI and kept by M. Member; not edited.");
  });

  test("one Release Readiness Report per assessment, latest first", () => {
    const r = (version: number, run_key: string | null, report_type = "release_readiness") => ({ version, run_key, report_type });
    const got = latestPerAssessment([r(1, "REL-0001"), r(2, "REL-0001"), r(3, "REL-0002"), r(4, "REL-0003"), r(5, "REL-0002"), r(6, null, "completion")]);
    expect(got.map((x) => `${x.run_key} v${x.version}`)).toEqual(["REL-0002 v5", "REL-0003 v4", "REL-0001 v2"]);
  });
});
