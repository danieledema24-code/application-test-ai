// Phase 2 report types (design P2 §10): slugs, names, gates and file names. Unit-tested.

export type Phase2ReportSlug = "requirements" | "test-strategy" | "test-plan";
export type ReportType = "discovery" | "requirements_spec" | "test_strategy" | "test_plan";

export const REPORT_TYPES: { slug: Phase2ReportSlug | "discovery"; type: ReportType; name: string; gate: "G2" | "G3" | "G4" | null; file: string; source: string }[] = [
  { slug: "discovery", type: "discovery", name: "Application Discovery Report", gate: "G2", file: "discovery-report", source: "Scan" },
  { slug: "requirements", type: "requirements_spec", name: "Requirements Specification", gate: "G3", file: "requirements-spec", source: "Requirements" },
  { slug: "test-strategy", type: "test_strategy", name: "Test Strategy", gate: "G4", file: "test-strategy", source: "Strategy" },
  { slug: "test-plan", type: "test_plan", name: "Test Plan", gate: null, file: "test-plan", source: "Plan" },
];

export function reportBySlug(slug: string) {
  return REPORT_TYPES.find((r) => r.slug === slug && r.slug !== "discovery") ?? null;
}

/** `{host}-requirements-spec-v{n}-{yyyy-mm-dd}.{pdf|html}` (design §10.3). */
export function phase2ReportFileName(host: string, type: ReportType, version: number, date: Date, format: string): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const safeHost = host.replace(/[^a-z0-9.-]/gi, "-") || "site";
  const file = REPORT_TYPES.find((r) => r.type === type)?.file ?? type;
  return `${safeHost}-${file}-v${version}-${d}.${format}`;
}

/** Band on draft report pages (design §10.2). */
export function draftBand(type: ReportType, version: number, strategyVersion?: number | null): string {
  if (type === "test_plan") return `Version ${version} · based on Strategy v${strategyVersion ?? "?"}`;
  const gate = REPORT_TYPES.find((r) => r.type === type)?.gate;
  return `DRAFT — not yet approved at Gate ${gate ? gate.slice(1) : "?"}`;
}
