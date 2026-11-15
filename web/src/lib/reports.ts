// Phase 2 and 3 report types (design P2 §10, P3 §15): slugs, names, gates and file names. Unit-tested.

export type Phase2ReportSlug = "requirements" | "test-strategy" | "test-plan" | "test-case-spec" | "rtm" | "test-execution" | "defects" | "performance" | "accessibility" | "security";
export type ReportType = "discovery" | "requirements_spec" | "test_strategy" | "test_plan" | "test_case_spec" | "rtm" | "execution" | "defect" | "performance" | "accessibility" | "security";
export type DownloadFormat = "pdf" | "html" | "csv" | "csv_timeseries" | "xlsx";

export const REPORT_TYPES: { slug: Phase2ReportSlug | "discovery"; type: ReportType; name: string; gate: "G2" | "G3" | "G4" | "G5" | "G7" | "G8" | null; file: string; source: string; csv?: boolean; phase?: 4 | 5; unavailable?: string }[] = [
  { slug: "discovery", type: "discovery", name: "Application Discovery Report", gate: "G2", file: "discovery-report", source: "Scan" },
  { slug: "requirements", type: "requirements_spec", name: "Requirements Specification", gate: "G3", file: "requirements-spec", source: "Requirements" },
  { slug: "test-strategy", type: "test_strategy", name: "Test Strategy", gate: "G4", file: "test-strategy", source: "Strategy" },
  { slug: "test-plan", type: "test_plan", name: "Test Plan", gate: null, file: "test-plan", source: "Plan" },
  { slug: "test-case-spec", type: "test_case_spec", name: "Test Case Specification", gate: "G5", file: "test-case-spec", source: "Design run", csv: true },
  { slug: "rtm", type: "rtm", name: "Requirements Traceability Matrix", gate: "G5", file: "rtm", source: "Design run", csv: true },
  { slug: "test-execution", type: "execution", name: "Test Execution Report", gate: null, file: "test-execution", source: "Run", csv: true, phase: 4 },
  { slug: "defects", type: "defect", name: "Defect Report", gate: "G8", file: "defects", source: "Defects", csv: true, phase: 4 },
  // Phase 5 (design P5 §11.1): one per finished load test or check.
  { slug: "performance", type: "performance", name: "Performance Report", gate: null, file: "performance", source: "Load test", csv: true, phase: 5, unavailable: "Run a load test first" },
  { slug: "accessibility", type: "accessibility", name: "Accessibility Report", gate: null, file: "accessibility", source: "Accessibility check", csv: true, phase: 5, unavailable: "Check accessibility first" },
  { slug: "security", type: "security", name: "Security Report", gate: null, file: "security", source: "Security check", csv: true, phase: 5, unavailable: "Run a security check first" },
];

export function isPhase5Report(type: ReportType | string): type is "performance" | "accessibility" | "security" {
  return type === "performance" || type === "accessibility" || type === "security";
}

export function isPhase4Report(type: ReportType | string): type is "execution" | "defect" {
  return type === "execution" || type === "defect";
}

export const HYPOTHESIS_BAND = "Causes are hypotheses unless a person confirmed them.";

/** "DRAFT: 2 defects not yet reviewed at Gate 8" while drafts exist (design §13). */
export function defectDraftBand(drafts: number): string | null {
  return drafts > 0 ? `DRAFT: ${drafts} defect${drafts === 1 ? "" : "s"} not yet reviewed at Gate 8` : null;
}

export function isPhase3Report(type: ReportType): boolean {
  return type === "test_case_spec" || type === "rtm";
}

/** Formats in the Download menu: CSV and XLSX only for table reports (design P5 §11.3); JSON is never offered. */
export function downloadFormats(type: ReportType): DownloadFormat[] {
  if (type === "performance") return ["pdf", "html", "csv", "csv_timeseries", "xlsx"];
  return REPORT_TYPES.find((r) => r.type === type)?.csv ? ["pdf", "html", "csv", "xlsx"] : ["pdf", "html"];
}

export const FORMAT_TEXT: Record<DownloadFormat, string> = { pdf: "PDF", html: "HTML (single file)", csv: "CSV (spreadsheet)", csv_timeseries: "CSV: time series", xlsx: "XLSX (Excel workbook)" };
export const FORMAT_HINT: Partial<Record<DownloadFormat, string>> = {
  csv: "Opens in Excel, Numbers or Google Sheets.",
  csv_timeseries: "One row per second",
  xlsx: "One sheet per table, with filters. No formulas.",
};
export const CSV_HINT = "Opens in Excel, Numbers or Google Sheets.";

export function downloadFailedText(format: DownloadFormat): string {
  if (format === "xlsx") return "Couldn’t create the Excel file. Try again.";
  return format === "pdf" ? "Couldn’t create the PDF. Try again." : format === "html" ? "Couldn’t create the HTML file. Try again." : "Couldn’t create the CSV file. Try again.";
}

export function preparingText(format: DownloadFormat): string {
  return `Preparing ${format === "pdf" ? "PDF" : format === "html" ? "HTML" : format === "xlsx" ? "XLSX" : "CSV"}…`;
}

export function reportBySlug(slug: string) {
  return REPORT_TYPES.find((r) => r.slug === slug && r.slug !== "discovery") ?? null;
}

/** `{host}-requirements-spec-v{n}-{yyyy-mm-dd}.{pdf|html}` (design P2 §10.3); `{host}-test-case-spec-v{n}-….csv` (P3 §15.2). */
export function phase2ReportFileName(host: string, type: ReportType, version: number, date: Date, format: string, runKey?: string | null): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const safeHost = host.replace(/[^a-z0-9.-]/gi, "-") || "site";
  // `{host}-test-execution-RUN-0003-{date}` and `{host}-defects-v{n}-{date}` (design P4 §13).
  if (type === "execution") return `${safeHost}-test-execution-${runKey || `latest-v${version}`}-${d}.${format}`;
  // `{host}-performance-PERF-0001-{date}.pdf` and `…-PERF-0001-timeseries-{date}.csv` (design P5 §11.3).
  if (isPhase5Report(type)) return format === "csv_timeseries" ? `${safeHost}-${type}-${runKey ?? "latest"}-timeseries-${d}.csv` : `${safeHost}-${type}-${runKey ?? "latest"}-${d}.${format}`;
  const file = REPORT_TYPES.find((r) => r.type === type)?.file ?? type;
  return `${safeHost}-${file}-v${version}-${d}.${format}`;
}

/** Band on draft report pages (design §10.2). */
export function draftBand(type: ReportType, version: number, strategyVersion?: number | null): string {
  if (type === "test_plan") return `Version ${version} · based on Strategy v${strategyVersion ?? "?"}`;
  if (isPhase3Report(type)) return "DRAFT, not approved at Gate 5";
  const gate = REPORT_TYPES.find((r) => r.type === type)?.gate;
  return `DRAFT — not yet approved at Gate ${gate ? gate.slice(1) : "?"}`;
}

/** "Approved at Gate 5 by {name}, {date}" (P3 §15.2). */
export function approvedBand(gate: string | null | undefined, name: string | null | undefined, date: string): string {
  return `Approved at Gate ${gate ? gate.slice(1) : "?"}${name ? ` by ${name}` : ""}${date ? `, ${date}` : ""}`;
}
