// Phase 2 and 3 report types (design P2 §10, P3 §15): slugs, names, gates and file names. Unit-tested.

export type Phase2ReportSlug = "requirements" | "test-strategy" | "test-plan" | "test-case-spec" | "rtm";
export type ReportType = "discovery" | "requirements_spec" | "test_strategy" | "test_plan" | "test_case_spec" | "rtm";
export type DownloadFormat = "pdf" | "html" | "csv";

export const REPORT_TYPES: { slug: Phase2ReportSlug | "discovery"; type: ReportType; name: string; gate: "G2" | "G3" | "G4" | "G5" | null; file: string; source: string; csv?: boolean }[] = [
  { slug: "discovery", type: "discovery", name: "Application Discovery Report", gate: "G2", file: "discovery-report", source: "Scan" },
  { slug: "requirements", type: "requirements_spec", name: "Requirements Specification", gate: "G3", file: "requirements-spec", source: "Requirements" },
  { slug: "test-strategy", type: "test_strategy", name: "Test Strategy", gate: "G4", file: "test-strategy", source: "Strategy" },
  { slug: "test-plan", type: "test_plan", name: "Test Plan", gate: null, file: "test-plan", source: "Plan" },
  { slug: "test-case-spec", type: "test_case_spec", name: "Test Case Specification", gate: "G5", file: "test-case-spec", source: "Design run", csv: true },
  { slug: "rtm", type: "rtm", name: "Requirements Traceability Matrix", gate: "G5", file: "rtm", source: "Design run", csv: true },
];

export function isPhase3Report(type: ReportType): boolean {
  return type === "test_case_spec" || type === "rtm";
}

/** Formats in the Download menu: CSV only for the Phase 3 reports (JSON is never offered). */
export function downloadFormats(type: ReportType): DownloadFormat[] {
  return REPORT_TYPES.find((r) => r.type === type)?.csv ? ["pdf", "html", "csv"] : ["pdf", "html"];
}

export const FORMAT_TEXT: Record<DownloadFormat, string> = { pdf: "PDF", html: "HTML (single file)", csv: "CSV (spreadsheet)" };
export const CSV_HINT = "Opens in Excel, Numbers or Google Sheets.";

export function downloadFailedText(format: DownloadFormat): string {
  return format === "pdf" ? "Couldn’t create the PDF. Try again." : format === "html" ? "Couldn’t create the HTML file. Try again." : "Couldn’t create the CSV file. Try again.";
}

export function preparingText(format: DownloadFormat): string {
  return `Preparing ${format === "pdf" ? "PDF" : format === "html" ? "HTML" : "CSV"}…`;
}

export function reportBySlug(slug: string) {
  return REPORT_TYPES.find((r) => r.slug === slug && r.slug !== "discovery") ?? null;
}

/** `{host}-requirements-spec-v{n}-{yyyy-mm-dd}.{pdf|html}` (design P2 §10.3); `{host}-test-case-spec-v{n}-….csv` (P3 §15.2). */
export function phase2ReportFileName(host: string, type: ReportType, version: number, date: Date, format: string): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const safeHost = host.replace(/[^a-z0-9.-]/gi, "-") || "site";
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
