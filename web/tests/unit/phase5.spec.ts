import { expect, test } from "@playwright/test";
import {
  a11ySummaryLine,
  defaultTab,
  deltaText,
  durationShort,
  groupByRule,
  limitErrors,
  liveMilestone,
  msText,
  nfAttentionRows,
  nfCounts,
  nfGlanceLines,
  nfHeaderPill,
  nfLifecycleRows,
  nfReachable,
  pctText,
  perfStatement,
  profileTotals,
  resultParagraph,
  runStatusLabel,
  screenshotAlt,
  SECURITY_STATEMENT,
  serverToolRows,
  thresholdLimit,
  thresholdSource,
  type Finding,
  type LoadRun,
  type Overview,
  type Scan,
  type ThresholdResult,
} from "../../src/lib/nonfunctional";
import { CURRENT_PHASE, PROJECT_SECTIONS, isBuilt, sectionBadge } from "../../src/lib/sections";
import { environmentLine, isNonFunctional, nfOccurrences, rejectReasonText, SOURCE_TEXT, type DefectDetail } from "../../src/lib/defects";
import { a11yCellText, CHAIN_KEY, gapCounts, keyHref, nfTiles, perfCellText, secCellText, typeOfKey } from "../../src/lib/traceability";
import { CITATION_TOKEN } from "../../src/lib/assistant";
import { LATER_TASKS_FALLBACK } from "../../src/components/assistant/Assistant";
import type { Gaps, Health } from "../../src/lib/contract";

const th = (over: Partial<ThresholdResult>): ThresholdResult => ({ metric: "p95", scope: "path", path: "/", op: "<", value: 800, source: { type: "default" }, measured: 100, result: "met", ...over });

test.describe("Phase 5 · non-functional rules", () => {
  test("fixed statements are verbatim (design §3.6)", () => {
    expect(SECURITY_STATEMENT).toBe(
      "This is a passive check of what a normal visitor's browser receives. It is not a security audit or a penetration test, and no findings does not mean the site is secure.",
    );
    expect(perfStatement("0.5.0")).toBe("Measured with the built-in load generator 0.5.0. Load is generated from the platform host, not from your users' locations.");
  });

  test("numbers are worded per §3.7", () => {
    expect(msText(640)).toBe("640 ms");
    expect(msText(1400)).toBe("1.4 s");
    expect(pctText(0)).toBe("0 %");
    expect(pctText(0.004)).toBe("0.4 %");
    expect(durationShort(130)).toBe("2 min 10 s");
    expect(durationShort(300)).toBe("5 min");
    expect(durationShort(45)).toBe("45 s");
  });

  test("limits: the organisation first, the server cap wins when exceeded (§9.2, §9.7)", () => {
    const org = { vus: 20, rps: 20, duration_s: 300 };
    const server = { vus: 50, rps: 50, duration_s: 600 };
    expect(limitErrors({ vus: 30, rps: 10, duration_s: 100 }, org, server)).toEqual({ vus: "Your organisation allows up to 20 virtual users." });
    expect(limitErrors({ vus: 60, rps: 25, duration_s: 700 }, org, server)).toEqual({
      vus: "This server allows up to 50.",
      rps: "Your organisation allows up to 20 requests a second.",
      duration_s: "This server allows up to 10 min.",
    });
    expect(profileTotals([{ duration_s: 30, target_vus: 10 }, { duration_s: 90, target_vus: 10 }, { duration_s: 10, target_vus: 0 }], 7, 20)).toEqual({ vus: 10, rps: 20, duration_s: 130, targets: 7 });
  });

  test("thresholds: source, limit and change against the previous run", () => {
    expect(thresholdSource(th({}))).toBe("Default threshold (no requirement states one)");
    expect(thresholdSource(th({ source: { type: "requirement", key: "REQ-0012" } }))).toBe("From REQ-0012");
    expect(thresholdLimit(th({ value: 2000 }))).toBe("under 2.0 s");
    expect(thresholdLimit({ metric: "error_rate", value: 0.01 })).toBe("under 1 %");
    expect(deltaText(th({ measured: 1400 }), null)).toEqual({ text: "first run", sr: "first run" });
    expect(deltaText(th({ measured: 1400 }), { key: "PERF-0001", threshold_results: [th({ measured: 1280 })] })).toEqual({ text: "+120 ms", sr: "120 milliseconds slower than PERF-0001" });
  });

  test("result paragraph names the slow page; status labels count missed thresholds (§9.6)", () => {
    const run = {
      limits: { test: { vus: 10, rps: 20, duration_s: 130 }, organisation: { vus: 20, rps: 20, duration_s: 300 }, server: { vus: 50, rps: 50, duration_s: 600 } },
      profile_snapshot: { targets: [{ path: "/products/2", weight: 1, title: "Desk lamp · Demo" }], stages: [], max_rps: 20, think_time_ms: { min: 500, max: 1500 }, thresholds: [] },
      threshold_results: [th({ path: "/products/2", measured: 1400, result: "missed" }), th({ path: "/", measured: 62 }), th({ metric: "error_rate", scope: "all", path: undefined, value: 0.01, measured: 0 })],
    } as unknown as LoadRun;
    expect(resultParagraph(run)).toBe(
      "With up to 10 virtual users, 1 of 2 pages stayed within their thresholds. The Desk lamp page (/products/2) was slow: 95 % of its requests were faster than 1.4 s, and the threshold is 800 ms.",
    );
    expect(runStatusLabel({ ...run, status: "failed", status_label: "", stopped_by: null })).toBe("Finished · 1 of 3 thresholds missed");
    expect(runStatusLabel({ ...run, status: "stopped", status_label: "", stopped_by: { full_name: "A. Approver" } })).toBe("Stopped by A. Approver");
  });

  test("live announcements only at 25 / 50 / 75 %", () => {
    expect(liveMilestone(20, 26)).toBe(25);
    expect(liveMilestone(26, 40)).toBeNull();
    expect(liveMilestone(70, 80)).toBe(75);
  });

  test("accessibility summary line and grouping by rule (§7.4)", () => {
    const scan = { pages: 6, summary: { pages_checked: 6, pages_not_checked: 0, rules_failed: 2, pages_with_problems: 2, by_severity: { critical: 1, serious: 1 }, needs_review: 3 } } as unknown as Scan;
    expect(a11ySummaryLine(scan)).toBe("2 rules failed on 2 of 6 pages · 1 critical · 1 serious · 0 moderate · 0 minor · 3 need review");
    const f = (key: string, rule: string, sev: string, path: string): Finding =>
      ({ key, rule_id: rule, severity: sev, title: rule, path, url: path, nodes: [{ target: "img", html: "", summary: "" }], references: [{ type: "wcag", criterion: "1.1.1", level: "A" }], status: "open", heuristic: false, needs_review: false }) as unknown as Finding;
    const g = groupByRule([f("A-02", "color-contrast", "serious", "/p/1"), f("A-01", "image-alt", "critical", "/p/1"), f("A-03", "image-alt", "critical", "/p/2")]);
    expect(g.map((x) => [x.rule_id, x.pages.length, x.elements, x.wcag])).toEqual([
      ["image-alt", 2, 2, "1.1.1 (A)"],
      ["color-contrast", 1, 1, "1.1.1 (A)"],
    ]);
    expect(screenshotAlt({ path: "/products/2", viewport: "desktop", nodes: [{ target: "img.product-image", html: "", summary: "" }] })).toBe(
      "Screenshot of /products/2 at desktop size with 1 element outlined: element 1, img.product-image.",
    );
  });

  test("default tab: waiting or running first, else the most recent (§4.1)", () => {
    const base = { accessibility: null, security: null, performance: { latest: null, waiting: [], running: null } } as unknown as Overview;
    expect(defaultTab(base)).toBe("performance");
    expect(defaultTab({ ...base, accessibility: { status: "running", created_at: "2026-11-13T10:00:00Z" } as Scan })).toBe("accessibility");
    expect(defaultTab({ ...base, security: { status: "completed", created_at: "2026-11-13T12:00:00Z" } as Scan, accessibility: { status: "completed", created_at: "2026-11-13T10:00:00Z" } as Scan })).toBe("security");
  });

  test("sidebar: Non-functional is built in Phase 5 with Approve / Waiting / Running / Out of date badges (§4.2)", () => {
    expect(CURRENT_PHASE).toBeGreaterThanOrEqual(5);
    const nf = PROJECT_SECTIONS.find((s) => s.slug === "non-functional")!;
    expect(nf.label).toBe("Non-functional");
    expect(isBuilt(nf)).toBe(true);
    expect(PROJECT_SECTIONS).toHaveLength(12);
    const o = (over: Partial<Overview>) =>
      ({ stages: {}, accessibility: null, security: null, performance: { latest: null, waiting: [], running: null }, permissions: { can_approve: true, can_start: true, can_admin_limits: true }, ...over }) as Overview;
    expect(sectionBadge("non-functional", [], 0, 0, undefined, nfCounts(o({ performance: { latest: null, waiting: ["PERF-0002"], running: null } })))).toEqual({ text: "Approve", srText: "1 load test waiting for your approval" });
    expect(
      sectionBadge("non-functional", [], 0, 0, undefined, nfCounts(o({ performance: { latest: null, waiting: ["PERF-0002"], running: null }, permissions: { can_approve: false, can_start: true, can_admin_limits: false } }))),
    ).toEqual({ text: "Waiting", srText: "a load test is waiting for approval" });
    expect(sectionBadge("non-functional", [], 0, 0, undefined, nfCounts(o({ performance: { latest: null, waiting: [], running: "PERF-0003" } })))).toEqual({ text: "Running", srText: "a check is in progress" });
    expect(sectionBadge("non-functional", [], 0, 0, undefined, nfCounts(o({ stages: { accessibility: { status: "stale", stale_reason: null } } })))).toEqual({ text: "Out of date", srText: "checks are out of date" });
    expect(sectionBadge("non-functional", [], 0, 0, undefined, nfCounts(o({})))).toBeNull();
  });

  test("Gate 8: Accepted risk is a non-functional reject reason (open question 2)", () => {
    expect(isNonFunctional("accessibility")).toBe(true);
    expect(isNonFunctional("analysis")).toBe(false);
    expect(rejectReasonText("accepted_risk")).toBe("Accepted risk");
  });

  test("Gate 8 source chips read Functional, Accessibility, Security, Performance (design P5 §10)", () => {
    expect([SOURCE_TEXT.analysis, SOURCE_TEXT.user, SOURCE_TEXT.accessibility, SOURCE_TEXT.security, SOURCE_TEXT.performance]).toEqual(["Functional", "Functional", "Accessibility", "Security", "Performance"]);
  });
});

test.describe("Phase 5 · overview, lifecycle, traceability and settings words (P5-07, §4.3–4.5, §12, §13.2)", () => {
  const scan = (over: Partial<Scan>): Scan =>
    ({ key: "A11Y-0001", kind: "accessibility", status: "completed", status_label: "Done", pages: 6, finished_at: "2026-11-13T10:00:00Z", open_findings: 3, summary: { rules_failed: 2, pages_with_problems: 2, by_severity: { critical: 1, serious: 1 } }, ...over }) as Scan;
  const run = (over: Partial<LoadRun>): LoadRun => ({ key: "PERF-0001", status: "failed", finished_at: "2026-11-13T11:00:00Z", aborted_reason: null, stopped_by: null, status_label: "Finished", threshold_results: [th({ path: "/products/2", result: "missed", measured: 1400 }), th({})], ...over }) as LoadRun;
  const o = (over: Partial<Overview>): Overview =>
    ({ stages: {}, accessibility: scan({}), security: scan({ key: "SEC-0001", kind: "security", open_findings: 7 }), performance: { latest: run({}), waiting: [], running: null }, permissions: { can_approve: true, can_start: true, can_admin_limits: true }, ...over }) as Overview;

  test("Overview card: three text lines, never a score or percentage; never-run lines read 'Not checked yet.'", () => {
    const lines = nfGlanceLines(o({}));
    expect(lines.map((l) => l.label)).toEqual(["Accessibility", "Security", "Performance"]);
    expect(lines[0].text).toMatch(/^A11Y-0001 · .+ · 2 rules on 2 of 6 pages \(1 critical, 1 serious\)$/);
    expect(lines[1].text).toMatch(/^SEC-0001 · .+ · 7 findings · passive check, not a security audit$/);
    expect(lines[2].text).toMatch(/^PERF-0001 · .+ · 1 of 2 thresholds missed$/);
    expect(lines.map((l) => l.text).join(" ")).not.toMatch(/%|score|grade/i);
    expect(nfGlanceLines(o({ accessibility: null, security: null, performance: { latest: null, waiting: [], running: null } })).map((l) => l.text)).toEqual(["Not checked yet.", "Not checked yet.", "Not checked yet."]);
  });

  test("attention rows: waiting (approver / member / viewer), missed, stopped, severe findings, out of date", () => {
    const waiting = o({ performance: { latest: null, waiting: ["PERF-0002"], running: null }, accessibility: null });
    expect(nfAttentionRows(waiting, "p1", true, false)).toEqual([{ text: "PERF-0002 is waiting for your approval.", action: "Review PERF-0002", href: "/projects/p1/non-functional/load-tests/PERF-0002" }]);
    expect(nfAttentionRows(waiting, "p1", false, false)[0]).toEqual({ text: "PERF-0002 is waiting for approval by someone who can approve.", action: "Open PERF-0002", href: "/projects/p1/non-functional/load-tests/PERF-0002" });
    expect(nfAttentionRows(waiting, "p1", false, true)[0].href).toBeNull();
    const now = Date.parse("2026-11-14T10:00:00Z");
    const rows = nfAttentionRows(o({ stages: { accessibility: { status: "stale", stale_reason: null } } }), "p1", true, false, now).map((r) => r.text);
    expect(rows).toEqual([
      "PERF-0001 missed 1 threshold: /products/2 was slow under load.",
      "A11Y-0001 found 2 critical or serious accessibility problems.",
      "Accessibility and security checks are out of date: pages changed after them.",
    ]);
    const aborted = o({ accessibility: null, performance: { latest: run({ status: "aborted", aborted_reason: "Stopped automatically: 100 % errors over 10 s" }), waiting: [], running: null } });
    expect(nfAttentionRows(aborted, "p1", true, false, now)[0].text).toBe("PERF-0001 was stopped automatically: 100 % errors over 10 s.");
    expect(nfAttentionRows(o({}), "p1", true, false, Date.parse("2026-12-30T00:00:00Z")).map((r) => r.text)).not.toContain("PERF-0001 missed 1 threshold: /products/2 was slow under load.");
  });

  test("lifecycle optional rows: Available after Gate 2, Not run yet, Done, waiting; header pill", () => {
    expect(nfLifecycleRows(undefined, false, true).map((r) => r.status)).toEqual(["Available after Gate 2", "Available after Gate 2", "Available after Gate 2"]);
    expect(nfLifecycleRows(o({ accessibility: null, security: null, performance: { latest: null, waiting: [], running: null } }), true, true).map((r) => r.status)).toEqual(["Not run yet", "Not run yet", "Not run yet"]);
    expect(nfLifecycleRows(o({}), true, true).map((r) => r.status)).toEqual(["Done: 3 open findings", "Done: 7 open findings", "Done: 1 threshold missed"]);
    expect(nfLifecycleRows(o({ performance: { latest: null, waiting: ["PERF-0002"], running: null } }), true, false)[2].status).toBe("PERF-0002 waiting for approval by someone who can approve");
    expect(nfHeaderPill(o({ performance: { latest: null, waiting: ["PERF-0002"], running: null } }), true)).toEqual({ text: "PERF-0002 waiting for your approval", tone: "amber" });
    expect(nfHeaderPill(o({ performance: { latest: null, waiting: [], running: "PERF-0003" } }), true)).toEqual({ text: "Load test PERF-0003 running", tone: "blue" });
    expect(nfHeaderPill(o({}), true)).toBeNull();
    expect(nfReachable({ stages: [{ key: "accessibility", available: true }, { key: "discovery", current_version: 1 }] })).toBe(true);
    expect(nfReachable({ stages: [{ key: "accessibility", available: false }, { key: "discovery", current_version: 1 }] })).toBe(false);
  });

  test("traceability: cells as text, chain keys, links and tiles equal the gap lists (check 31)", () => {
    expect(a11yCellText({ open: 2, by_severity: { critical: 1, serious: 1 } })).toBe("2 open (1 critical)");
    expect(a11yCellText(null)).toBe("Not checked");
    expect(secCellText({ open: 1 })).toBe("Open: 1");
    expect(perfCellText({ last_run: "PERF-0001", thresholds_failed: 1 })).toBe("✗ Missed in PERF-0001");
    expect(perfCellText({ last_run: "PERF-0001", thresholds_failed: 0 })).toBe("✓ Met");
    for (const k of ["A11Y-0001", "A11Y-0001-02", "SEC-0001", "PERF-0001", "PRF-01", "REQ-0001"]) expect(CHAIN_KEY.test(k), k).toBe(true);
    expect(CHAIN_KEY.test("PERF-0001-01")).toBe(false);
    expect([typeOfKey("A11Y-0001-02"), typeOfKey("SEC-0001"), typeOfKey("PERF-0001"), typeOfKey("PRF-01")]).toEqual(["quality_finding", "quality_scan", "performance_run", "performance_profile"]);
    expect(keyHref("p1", "A11Y-0001-02")).toBe("/projects/p1/non-functional/checks/A11Y-0001?finding=A11Y-0001-02");
    const g = { requirements_with_open_accessibility_findings: [{}], pages_not_checked_for_accessibility: [{}, {}], non_functional_requirements_without_evidence: [] } as unknown as Gaps;
    const n = gapCounts(g);
    const tiles = nfTiles({ requirements_with_open_accessibility_findings: n.nf_open, pages_not_checked_for_accessibility: n.nf_pages, non_functional_requirements_without_evidence: n.nf_without }, () => "/t");
    expect(tiles.map((t) => t.value)).toEqual(["1", "2", "0"]);
  });

  test("assistant: citations link A11Y/SEC/PERF/PRF keys; Later phases fallback lists phase 7+ items only (check 32; P6-06)", () => {
    expect("See A11Y-0001-02, SEC-0001, PERF-0003, PRF-01 and APR-0005.".match(CITATION_TOKEN)).toEqual(["A11Y-0001-02", "SEC-0001", "PERF-0003", "PRF-01", "APR-0005"]);
    expect(LATER_TASKS_FALLBACK.every((t) => t.available_from_phase > 6)).toBe(true);
  });

  test("defect detail: environment and occurrences of non-functional drafts (§10)", () => {
    const a11y = { source: "accessibility", environment: { url: "http://localhost:4100", browser: "Chromium", viewport: "desktop", scan_key: "A11Y-0001", occurrences: [{ scan_key: "A11Y-0001", pages: 2 }, { scan_key: "A11Y-0002", pages: 2, added: true }] } } as unknown as DefectDetail;
    expect(environmentLine(a11y, (x) => x)).toBe("http://localhost:4100 · Chromium · Desktop 1440 × 900 · A11Y-0001");
    expect(nfOccurrences(a11y)).toEqual(["A11Y-0001 · 2 pages", "A11Y-0002 · 2 pages (added)"]);
    const perf = { source: "performance", environment: { url: "http://localhost:4100", engine: "Built-in load generator 0.5.0", profile: "PRF-01 v1", run_key: "PERF-0001", virtual_users: 10 } } as unknown as DefectDetail;
    expect(environmentLine(perf, (x) => x)).toBe("http://localhost:4100 · Built-in load generator 0.5.0 · PRF-01 v1 · PERF-0001 · 10 virtual users");
  });

  test("settings: proxy state and tools as text; k6 and Docker are 'not needed' (check 39)", () => {
    const h = { egress_proxy: "off", tools: { loadgen: "0.5.0", axe: "4.14.0", k6: null, docker: null } } as unknown as Health;
    expect(serverToolRows(h)).toEqual([
      { label: "Network safety proxy", value: "Off (development only): DNS tricks could reach internal services.", warn: true },
      { label: "Accessibility checker", value: "axe-core 4.14.0" },
      { label: "Load generator", value: "built-in 0.5.0" },
      { label: "k6", value: "Not installed · Not needed: the platform exports k6 scripts but doesn't run them" },
      { label: "Docker", value: "Not installed · Not used in this version" },
    ]);
    expect(serverToolRows({} as Health)).toEqual([]);
  });
});

test("XLSX is offered on table reports only, with its hint (P5-04b, check 29)", async () => {
  const { downloadFormats, FORMAT_HINT, FORMAT_TEXT } = await import("../../src/lib/reports");
  expect(downloadFormats("performance")).toEqual(["pdf", "html", "csv", "csv_timeseries", "xlsx"]);
  for (const t of ["accessibility", "security", "defect", "execution", "rtm", "test_case_spec"] as const) expect(downloadFormats(t)).toContain("xlsx");
  for (const t of ["requirements_spec", "test_strategy", "test_plan"] as const) expect(downloadFormats(t)).not.toContain("xlsx");
  expect([FORMAT_TEXT.xlsx, FORMAT_HINT.xlsx]).toEqual(["XLSX (Excel workbook)", "One sheet per table, with filters. No formulas."]);
});
