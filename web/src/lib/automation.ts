// Automation workspace (P4-02, P4-04; design docs/design/P4-qa-analyst-phase4.md §6): API shapes as built
// (backend app/api/routers/automation.py) and the pure helpers the screens use. Values come from the API; this file
// only words them.

import type { IsoDate, Uuid } from "@/lib/contract";

export type Suitability = "suitable" | "partial" | "manual_only";
export type ScriptState = "valid" | "invalid" | "not_checked" | "outdated" | "needs_review" | "rejected";
export type CheckName = "guard" | "tsc" | "eslint" | "secret_scan" | "tags" | "locators";
export type CheckState = "ok" | "failed" | "not_checked";
export type LocatorStatus = "unique" | "multiple" | "missing" | "not_checked";
export type G6State = "not_started" | "approved" | "passed_automatically" | "reviewed" | "waiting";

export type CheckMessage = { line: number | null; message: string; not_checked?: boolean };
export type Check = { ok: boolean; messages: CheckMessage[]; not_checked?: boolean };

export type AssessedCase = {
  test_case_id: Uuid;
  case_lineage_id: Uuid;
  key: string;
  title: string;
  case_version: number;
  suitability: Suitability;
  reasons: string[];
  blockers: { code: string; message: string }[];
};

export type AutomationAssessment = {
  status: string;
  stale_reason: string | null;
  g5_approved: boolean;
  g5_decided_at: IsoDate | null;
  credentials_saved: boolean;
  run: { id: Uuid; version: number; finished_at: IsoDate | null } | null;
  counts: Record<Suitability, number> & { total: number };
  cases: AssessedCase[];
};

export type ScriptRow = {
  id: Uuid;
  case_key: string;
  case_title: string;
  test_case_id: Uuid;
  case_lineage_id: Uuid;
  case_version: number;
  path: string;
  version: number;
  generated_by: "rules" | "ai" | "heal";
  status: ScriptState;
  checks: Record<CheckName, CheckState>;
  locators: { failed: number; not_checked: number };
  first_problem: string | null;
};

export type AssetRow = {
  id: Uuid;
  path: string;
  kind: "page_object" | "factory" | "fixture" | "platform" | "config";
  generated_by: "rules" | "ai" | "heal" | "platform";
  version: number;
  status: "valid" | "invalid" | "not_checked" | "platform";
};

export type Precondition = { code: string; met: boolean; blocking: boolean; message: string; link: string | null };

export type AutomationOverview = {
  stage: { status: string; gate_status: string; stale_reason: string | null };
  g5: { approved: boolean; decided_at: IsoDate | null; design_version: number | null };
  toolkit_problem: string | null;
  credentials_saved: boolean;
  bundle: null | {
    id: Uuid;
    version: number;
    status: string;
    created_at: IsoDate;
    finished_at: IsoDate | null;
    is_current: boolean;
    generated_by: "rules" | "ai" | "mixed";
    counts: Record<string, number>;
    validation: { status?: "running" | "done" | "failed"; checked_at?: IsoDate; counts?: Record<string, number>; toolkit?: string | null; issues?: string[] };
    not_automated: { case_lineage_id: Uuid; test_case_id: Uuid; key: string; title: string; reason: string }[];
    /** P4-03b: what happened to AI drafts (dropped, fell back to rules). Absent or empty with AI off. */
    ai_checks?: string[];
    /** What the Playwright project export would hold (P4-10): included scripts and the cases left out. */
    export?: { scripts: number; left_out: { case_key: string; reason: string }[] };
    scripts: ScriptRow[];
    assets: AssetRow[];
  };
  versions: { version: number; created_at: IsoDate; finished_at: IsoDate | null }[];
  g6: { state: G6State; preconditions: Precondition[]; decided_at: IsoDate | null };
  permissions: { can_edit: boolean; can_approve: boolean };
};

export type AssertionMapItem = { step: number | string; helper: string; args: string[]; kind: string; step_text: string | null };

export type ScriptDetail = ScriptRow & {
  code: string;
  sha256: string;
  validation: Partial<Record<CheckName, Check>>;
  assertion_map: AssertionMapItem[];
  review: { decision: "approve" | "reject"; comment: string | null; decided_by: { full_name?: string } | null; decided_at: IsoDate } | null;
  bundle: { id: Uuid; version: number; is_current: boolean };
  case: { id: Uuid; key: string; title: string; version: number; requirement_keys: string[] };
  can_review: boolean;
};

export type LocatorRow = {
  element: string;
  getter: string;
  how: string;
  fallback: string | null;
  status: LocatorStatus;
  count: number | null;
  reason: string | null;
  used_by: string[];
};

export type AssetDetail = AssetRow & {
  code: string;
  checks: Partial<Record<Exclude<CheckName, "tags" | "locators">, Check>> | null;
  page_path: string | null;
  locators: LocatorRow[] | null;
  bundle: { id: Uuid; version: number };
};

export type ScriptVersion = { id: Uuid; version: number; case_version: number; created_at: IsoDate; generated_by: string; cause: string; code: string };

// ---- Vocabulary (design §3, §19) -------------------------------------------------------------------------

/** Assessed suitability labels; the Phase 3 preliminary labels stay in `AUTOMATION_TEXT` (lib/testcases.ts). */
export const SUITABILITY_TEXT: Record<Suitability, string> = {
  suitable: "Can be automated",
  partial: "Needs test credentials",
  manual_only: "Needs a person",
};

export const SCRIPT_STATUS: Record<ScriptState, { label: string; status: string; tone: "green" | "red" | "grey" | "amber" }> = {
  valid: { label: "Valid", status: "completed", tone: "green" },
  invalid: { label: "Can't run", status: "failed", tone: "red" },
  not_checked: { label: "Not checked yet", status: "not_started", tone: "grey" },
  outdated: { label: "Outdated", status: "stale", tone: "amber" },
  needs_review: { label: "Needs review", status: "awaiting_approval", tone: "amber" },
  rejected: { label: "Rejected in review", status: "rejected", tone: "grey" },
};

export const CHECK_TEXT: Record<CheckName, string> = {
  guard: "Safety check",
  tsc: "TypeScript",
  eslint: "Code style",
  secret_scan: "No secrets",
  tags: "Test case tag",
  locators: "Live page",
};

/** "What do these mean?" (design §6.2 ValidationLegend). */
export const CHECK_LEGEND: Record<CheckName, string> = {
  guard: "The script only uses allowed testing commands. It can't read files, start programs or reach other sites.",
  tsc: "The code compiles.",
  eslint: "No fixed waits, no 'run only this test', no fragile locators.",
  secret_scan: "No password, token or saved login appears in the code.",
  tags: "The script is linked to an approved test case.",
  locators:
    "Each field and button the script uses is found exactly once on the live page. We only open pages and look; we don't click, type or submit (apart from signing in with the saved test account).",
};

export const CHECK_ORDER: CheckName[] = ["guard", "tsc", "eslint", "secret_scan", "tags", "locators"];

export function locatorStatusText(status: LocatorStatus, count: number | null): string {
  if (status === "unique") return "Found once";
  if (status === "multiple") return `Found ${count ?? 2} times`;
  if (status === "missing") return "Not found";
  return "Not checked";
}

export function locatorStatusHint(status: LocatorStatus, reason: string | null): string | null {
  if (status === "multiple") return "A test would fail: it must match exactly one.";
  if (status === "not_checked") return reason ?? "needs sign-in and no test credentials are saved";
  return null;
}

// ---- Sentences --------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "18 of 24 approved test cases can be automated · 2 need test credentials · 4 need a person" (design §6.2). */
export function assessmentSentence(c: AutomationAssessment["counts"]): string {
  const parts = [`${c.suitable} of ${c.total} approved test ${plural(c.total, "case", "cases")} can be automated`];
  if (c.partial) parts.push(`${c.partial} ${plural(c.partial, "needs", "need")} test credentials`);
  if (c.manual_only) parts.push(`${c.manual_only} ${plural(c.manual_only, "needs", "need")} a person`);
  return parts.join(" · ");
}

/** "21 valid · 1 can't run · 2 not checked on the live page" (design §6.2). */
export function validationSentence(counts: Record<string, number> | undefined): string {
  const c = counts ?? {};
  const parts = [`${c.valid ?? 0} valid`];
  if (c.invalid) parts.push(`${c.invalid} can't run`);
  if (c.needs_review) parts.push(`${c.needs_review} ${plural(c.needs_review, "needs", "need")} review`);
  if (c.not_checked) parts.push(`${c.not_checked} not checked yet`);
  if (c.locators_not_checked) parts.push(`${c.locators_not_checked} not checked on the live page`);
  if (c.outdated) parts.push(`${c.outdated} outdated`);
  return parts.join(" · ");
}

/** File link names carry the status (design §6.3): "TC-0040.spec.ts, can't run". */
export function fileLinkName(path: string, status: ScriptState | AssetRow["status"]): string {
  const name = path.split("/").pop() ?? path;
  const suffix: Record<string, string> = {
    invalid: ", can't run",
    not_checked: ", not checked yet",
    outdated: ", outdated",
    needs_review: ", needs review",
    rejected: ", rejected in review",
    platform: ", platform file",
  };
  return `${name}${suffix[status] ?? ""}`;
}

export type FileGroup = { folder: string; scripts: ScriptRow[] };

/** Spec files grouped by feature folder (`tests/<feature>/…`), folders and files sorted. */
export function groupScripts(scripts: ScriptRow[]): FileGroup[] {
  const by = new Map<string, ScriptRow[]>();
  for (const s of scripts) {
    const parts = s.path.split("/");
    const folder = parts.length > 2 ? parts[1] : "tests";
    by.set(folder, [...(by.get(folder) ?? []), s]);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, list]) => ({ folder, scripts: list.sort((x, y) => x.path.localeCompare(y.path)) }));
}

/** Lines with a problem (check messages carry the line), for outlining in the code viewer. */
export function problemLines(validation: Partial<Record<CheckName, Check>> | null | undefined): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const name of CHECK_ORDER) {
    const c = validation?.[name];
    if (!c || c.ok) continue;
    for (const m of c.messages ?? []) {
      if (m.line === null || m.line === undefined || m.not_checked) continue;
      out.set(m.line, [...(out.get(m.line) ?? []), m.message]);
    }
  }
  return out;
}

/** "Live page: 4 of 4 found once" for the checks row. */
export function liveSentence(state: CheckState, check: Check | undefined, used: number): string {
  if (state === "failed") return `Live page: ${(check?.messages ?? []).filter((m) => !m.not_checked).length} not found exactly once`;
  if (state === "not_checked") return "Live page: not checked";
  return `Live page: ${used} of ${used} found once`;
}

/** One line per assertion, in words: "Step 5 Press Send message → Submission is blocked" (design §6.3). */
const HELPER_TEXT: Record<string, (args: string[]) => string> = {
  expectFormShown: (a) => `${a[0] ? `the ${a[0]} form` : "the form"} is shown`,
  expectSubmissionBlocked: () => "Submission is blocked",
  expectFieldFlagged: (a) => `${a[a.length - 1]} is flagged`,
  expectSubmissionAccepted: () => "The form is accepted",
  expectEveryFieldLabelled: () => "Every field has a label",
  expectFieldLength: (a) => `${a[0]} holds ${a[a.length - 1] === "at most" ? "at most " : ""}${a[1] ?? ""} characters`,
  expectSignedIn: () => "Signed in",
  expectNotSignedIn: () => "Not signed in",
  expectErrorShown: () => "An error is shown",
  expectText: (a) => `“${a[a.length - 1]}” is shown`,
  expectUrl: (a) => `The address is ${a[0]}`,
  expectNoConsoleErrors: () => "No console errors",
  expectNoHorizontalOverflow: () => "No sideways scrolling",
  expectControlEnabled: (a) => `${a[0]} is visible and enabled`,
};

export function assertionText(m: AssertionMapItem): string {
  const f = HELPER_TEXT[m.helper];
  const t = f ? f(m.args ?? []) : m.helper;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Assertions grouped by step for "What this script checks". */
export function checksByStep(map: AssertionMapItem[]): { step: number | string; stepText: string | null; checks: string[] }[] {
  const out: { step: number | string; stepText: string | null; checks: string[] }[] = [];
  for (const m of map) {
    const last = out[out.length - 1];
    if (last && last.step === m.step) last.checks.push(assertionText(m));
    else out.push({ step: m.step, stepText: m.step_text, checks: [assertionText(m)] });
  }
  return out;
}

// ---- Gate 6 (D10) -----------------------------------------------------------------------------------------

export function g6Groups(pre: Precondition[]): { blockers: Precondition[]; advice: Precondition[]; passed: Precondition[] } {
  return {
    blockers: pre.filter((p) => p.blocking && !p.met),
    advice: pre.filter((p) => !p.blocking && !p.met),
    passed: pre.filter((p) => p.met),
  };
}

/** Status pill text for G6, role-aware (design §4.3, §6.4). */
export function g6StatusText(state: G6State, canApprove: boolean): string {
  if (state === "passed_automatically") return "Passed automatically";
  if (state === "reviewed") return "Reviewed";
  if (state === "approved") return "Approved";
  if (state === "waiting") return canApprove ? "Waiting for your approval" : "Waiting for approval by someone who can approve gates";
  return "Not started";
}

/** Sidebar badge for Automation (design §4.2): Review → Out of date → {n} invalid. */
export function automationBadge(
  stages: { key: string; status: string }[] | undefined,
  invalid = 0,
): { text: string; srText: string } | null {
  const st = stages?.find((s) => s.key === "automation");
  if (st?.status === "awaiting_approval") return { text: "Review", srText: "Gate 6 waiting for approval" };
  if (st?.status === "stale") return { text: "Out of date", srText: "out of date" };
  if (invalid > 0) return { text: `${invalid} invalid`, srText: `${invalid} script${invalid === 1 ? "" : "s"} can't run` };
  return null;
}

/** Where the Automation workspace stands (design §6.5), from the workflow stages and the API. */
export type AutomationPhase = "g5_missing" | "not_assessed" | "assessing" | "writing" | "failed" | "ready";

export function automationPhase(
  stages: { key: string; status: string }[] | undefined,
  overview: Pick<AutomationOverview, "g5" | "bundle"> | undefined,
): AutomationPhase {
  const by = (k: string) => stages?.find((s) => s.key === k)?.status;
  if (overview && !overview.g5.approved) return "g5_missing";
  const assess = by("automation_assessment");
  const auto = by("automation");
  if (assess === "queued" || assess === "running") return "assessing";
  if (auto === "queued" || auto === "running") return "writing";
  if (auto === "failed" || assess === "failed") return "failed";
  if (overview?.bundle) return "ready";
  if (assess === "not_started" || assess === "stale" || !assess) return "not_assessed";
  return "writing"; // assessed; the bundle is being written next
}

/** Export file name, matching the API's Content-Disposition (`{host}-playwright-v{n}.zip`). */
export function exportFileName(host: string, version: number): string {
  return `${host.replace(/[^a-zA-Z0-9.-]/g, "-")}-playwright-v${version}.zip`;
}

/** Path of the zip for one scripts version (members and approvers only). */
export function exportPath(projectId: string, version: number, isCurrent: boolean): string {
  return `/projects/${projectId}/automation/export${isCurrent ? "" : `?version=${version}`}`;
}
