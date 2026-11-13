import { expect, test } from "@playwright/test";
import type { ChangeReviewItem, ReadinessCriteria, RequirementSummary, Risk, RiskMatrix, StageKey, StageState, TestStrategy } from "../../src/lib/contract";
import {
  EMPTY_FILTERS,
  activeFilterChips,
  approvalFlagSentence,
  approvalFlags,
  checklistChanges,
  checklistOrder,
  confidenceBand,
  confidenceText,
  filterRequirements,
  filtersToQuery,
  gate3Checks,
  parseFilters,
} from "../../src/lib/requirements";
import { fieldChanges, listDiff, reviewDecisions, wordDiff } from "../../src/lib/diff";
import { cellName, cellScore, gate4Checks, matrixCells, riskChecks } from "../../src/lib/strategy";
import { handleAssistantSse, splitCitations } from "../../src/lib/assistant";
import { buildLifecycle, fromApiStatus, phase2Step, stageStatusText, upstreamGateHint } from "../../src/lib/lifecycle";
import { sectionBadge } from "../../src/lib/sections";
import { checkDocumentFiles, docStatusText } from "../../src/lib/documents";
import { draftBand, phase2ReportFileName, reportBySlug } from "../../src/lib/reports";
import { attentionRows } from "../../src/lib/attention";
import { isSignInGap, matchesAccess, nodeStatus, scanSignIn } from "../../src/lib/discovery";

// ---- Fixtures (test-only) ---------------------------------------------------------

function req(key: string, over: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id: `id-${key}`,
    key,
    lineage_id: `l-${key}`,
    title: `Requirement ${key}`,
    type: "functional",
    category: "form_input",
    behaviour_scope: "ui",
    classification: "observed",
    provenance: "observed",
    confidence: 0.9,
    evidence_refs: [],
    generated_by: "rules",
    source: "discovery",
    status: "draft",
    ac_count: 1,
    ac_approved: 0,
    risk_level: null,
    stage_run_version: 1,
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: "2026-11-13T10:00:00Z",
    ...over,
  } as RequirementSummary;
}

function stage(key: StageKey, over: Partial<StageState> = {}): StageState {
  return { key, title: key, phase: 2, available: true, status: "not_started", current_version: null, gate: null, started_at: null, finished_at: null, stale_reason: null, progress: null, ...over };
}

function risk(key: string, over: Partial<Risk> = {}): Risk {
  return {
    id: `r-${key}`,
    key,
    lineage_id: key,
    title: key,
    description: "",
    category: "product",
    requirements: [],
    features: [],
    likelihood: 4,
    impact: 5,
    score: 20,
    level: "very_high",
    factors: [],
    likelihood_rationale: "",
    impact_rationale: "",
    mitigation: { test_types: ["functional"], techniques: [], notes: null },
    requires_approval: false,
    status: "open",
    status_comment: null,
    provenance: "inferred",
    confidence: 0.7,
    evidence_refs: [],
    generated_by: "rules",
    version: 1,
    locked: false,
    human_edited: false,
    updated_at: "2026-11-13T10:00:00Z",
    updated_by: null,
    ...over,
  } as Risk;
}

// ---- Requirements -----------------------------------------------------------------

test.describe("requirements (design P2 §5)", () => {
  test("confidence bands: High ≥80, Medium 50–79, Low <50", () => {
    expect([0.8, 0.79, 0.5, 0.49].map(confidenceBand)).toEqual(["high", "medium", "medium", "low"]);
    expect(confidenceText(0.68)).toBe("68% · Medium");
  });

  test("filters round-trip through the URL and become removable chips", () => {
    const f = parseFilters(new URLSearchParams("status=draft&label=assumed&no_ac=1&q=email&sort=title"));
    expect(f).toMatchObject({ status: "draft", label: "assumed", noAc: true, q: "email", sort: "title" });
    expect(filtersToQuery(f)).toEqual({ q: "email", status: "draft", label: "assumed", no_ac: "1", sort: "title" });
    expect(activeFilterChips(f).map((c) => c.label)).toEqual(["Search: email", "Status: Draft", "Label: Assumed", "No acceptance criteria"]);
    expect(parseFilters(new URLSearchParams("status=bogus")).status).toBe("");
  });

  test("rejected requirements are hidden by default and counted", () => {
    const all = [req("REQ-0001"), req("REQ-0002", { status: "rejected" }), req("REQ-0003", { status: "approved" })];
    const r = filterRequirements(all, EMPTY_FILTERS);
    expect(r.rows.map((x) => x.key)).toEqual(["REQ-0001", "REQ-0003"]);
    expect(r.hiddenRejected).toBe(1);
    expect(filterRequirements(all, { ...EMPTY_FILTERS, status: "rejected" }).rows.map((x) => x.key)).toEqual(["REQ-0002"]);
  });

  test("bulk approve guard names weak labels, low confidence and missing criteria", () => {
    const flags = approvalFlags([req("A", { classification: "assumed" }), req("B", { confidence: 0.3 }), req("C", { ac_count: 0 }), req("D")]);
    expect(flags.unflagged.map((r) => r.key)).toEqual(["D"]);
    expect(approvalFlagSentence(flags)).toBe("1 is Assumed or Unverified, 1 has low confidence and 1 has no acceptance criteria.");
  });

  test("Gate 3 checks are computed from the set and link to filtered lists", () => {
    const readiness = {
      definition_of_ready: [{ status: "active" }],
      definition_of_done: [{ status: "active" }, { status: "active" }],
    } as unknown as ReadinessCriteria;
    const checks = gate3Checks(
      [req("REQ-0001", { status: "approved" }), req("REQ-0002"), req("REQ-0003", { ac_count: 0 }), req("REQ-0004", { status: "rejected" })],
      readiness,
      { scanN: 3, documents: 2, listHref: (q) => `/list?${new URLSearchParams(q)}` },
    );
    expect(checks.map((c) => c.text)).toEqual([
      "4 requirements derived from Scan 3 and 2 documents",
      "1 approved · 1 rejected",
      "2 still Draft or Needs info: they won’t be used by the Test Strategy Agent until approved",
      "1 requirement has no acceptance criteria (REQ-0003)",
      "Definition of Ready (1) and Done (2) defined",
    ]);
    expect(checks[3].href).toBe("/list?no_ac=1");
    expect(gate3Checks([req("A")], undefined, { listHref: () => "" }).some((c) => c.tone === "fail" && c.text.startsWith("No requirement is approved"))).toBe(true);
  });

  test("Ready & Done edits become create / patch / remove calls; empty rows are dropped", () => {
    const existing = [
      { id: "a", text: "One", version: 1 },
      { id: "b", text: "Two", version: 2 },
      { id: "c", text: "Three", version: 3 },
    ];
    const out = checklistChanges(existing, [
      { id: "a", text: "One" },
      { id: "b", text: " Two, edited " },
      { id: "new-1", text: "Four" },
      { id: "new-2", text: "  " },
    ]);
    expect(out).toEqual({ create: ["Four"], update: [{ id: "b", version: 2, text: "Two, edited" }], remove: [{ id: "c", version: 3 }] });
  });
});

// ---- Diff ---------------------------------------------------------------------------

test.describe("diff (design P2 §5.6)", () => {
  test("word diff marks removed and added words", () => {
    const parts = wordDiff("rejects addresses without @", "rejects email addresses without @");
    expect(parts.filter((p) => p.kind === "add").map((p) => p.text.trim())).toEqual(["email"]);
    expect(parts.filter((p) => p.kind === "del")).toEqual([]);
  });

  test("list diff labels added, removed and changed items", () => {
    // An unmatched pair at the same position is a change; leftovers are added or removed.
    expect(listDiff(["a", "b", "c"], ["a", "c", "d"]).filter((x) => x.kind !== "same")).toEqual([{ kind: "changed", text: "d", from: "b" }]);
    expect(listDiff(["a", "b"], ["a"]).filter((x) => x.kind !== "same")).toEqual([{ kind: "removed", text: "b" }]);
    expect(listDiff(["a"], ["a", "c"]).filter((x) => x.kind !== "same")).toEqual([{ kind: "added", text: "c" }]);
  });

  test("field changes skip equal fields", () => {
    expect(fieldChanges({ title: "x", description: "y" }, { title: "x", description: "z" })).toEqual([{ field: "description", from: "y", to: "z" }]);
  });
});

// ---- Strategy and risks ---------------------------------------------------------------

test.describe("strategy and risks (design P2 §8)", () => {
  test("matrix cell names carry count, ratings, server score and level", () => {
    expect(cellName(2, 4, 3, 12, "high")).toBe("2 risks, likelihood 4 Likely, impact 3 Moderate, score 12, High");
    expect(cellName(1, 1, 1, null, null)).toBe("1 risk, likelihood 1 Rare, impact 1 Negligible");
  });

  test("cell score comes from a server-scored risk, never computed", () => {
    const cell: RiskMatrix["cells"][number] = { likelihood: 4, impact: 5, count: 1, risk_keys: ["RISK-001"] };
    // The server's score is used as-is even if it isn't likelihood × impact.
    expect(cellScore(cell, [risk("RISK-001", { score: 99, level: "very_high" })])).toEqual({ score: 99, level: "very_high" });
    expect(cellScore(cell, [])).toBeNull();
  });

  test("risk and Gate 4 checks flag unmitigated high risks and accepted risks without comment", () => {
    const risks = [risk("RISK-001"), risk("RISK-007", { mitigation: { test_types: [], techniques: [], notes: null } }), risk("RISK-009", { status: "accepted", level: "low" })];
    expect(riskChecks(risks).map((c) => c.text)).toEqual(["RISK-007 (Very high) has no test type", "1 Accepted risk has no comment"]);
    const strategy = {
      approved_input: { requirements_version: 5, requirements_snapshot_hash: "h" },
      sections: {
        test_levels: [{ level: "system", in_scope: true, rationale: "x" }],
        test_types: [
          { type: "functional", in_scope: true, rationale: "x", requires_approval: false, available_from_phase: 4 },
          { type: "performance", in_scope: true, rationale: "", requires_approval: true, available_from_phase: 5 },
        ],
        entry_criteria: [{ text: "a" }],
        exit_criteria: [{ text: "b" }],
      },
    } as unknown as TestStrategy;
    const checks = gate4Checks(strategy, risks, { requirementsVersion: 6, g3Reopened: false });
    expect(checks.map((c) => `${c.tone}:${c.text}`)).toEqual([
      "warn:Requirements changed after this strategy was written. Approving uses version 5.",
      "warn:1 decision has no rationale",
      "fail:RISK-007 (Very high) has no test type",
      "warn:1 Accepted risk has no comment",
      "ok:Entry (1) and exit (1) criteria defined",
      "info:1 planned test type needs separate approval before running: Performance",
    ]);
  });
});

// ---- Assistant ----------------------------------------------------------------------------

test.describe("assistant (design P2 §11)", () => {
  test("SSE: deltas are hints, done returns the final turn, errors throw", () => {
    const seen: string[] = [];
    const on = (e: { type: string }) => seen.push(e.type);
    expect(handleAssistantSse({ id: "1", event: "assistant.started", data: '{"answered_by":"ai"}' }, on)).toBeNull();
    expect(handleAssistantSse({ id: "2", event: "assistant.delta", data: '{"text":"Hi"}' }, on)).toBeNull();
    const turn = handleAssistantSse({ id: "3", event: "assistant.done", data: '{"user_message":{"id":"u"},"reply":{"id":"r"}}' }, on);
    expect(turn).toMatchObject({ reply: { id: "r" } });
    expect(seen).toEqual(["started", "delta"]);
    expect(() => handleAssistantSse({ id: "4", event: "assistant.error", data: '{"code":"rate_limited","message":"Limit"}' }, on)).toThrow("Limit");
    expect(handleAssistantSse({ id: "5", event: "assistant.delta", data: "not json" }, on)).toBeNull();
  });

  test("citation tokens are split out of plain text", () => {
    expect(splitCitations("See REQ-0007 and RISK-003, then G3.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "token", text: "REQ-0007" },
      { kind: "text", text: " and " },
      { kind: "token", text: "RISK-003" },
      { kind: "text", text: ", then " },
      { kind: "token", text: "G3" },
      { kind: "text", text: "." },
    ]);
  });
});

// ---- Lifecycle, sidebar, overview ---------------------------------------------------------

test.describe("lifecycle and navigation (design P2 §3.2, §12)", () => {
  test("Phase 2 stage statuses and step text", () => {
    expect(fromApiStatus(stage("requirements", { status: "stale" }))).toBe("out_of_date");
    expect(fromApiStatus(stage("requirements", { status: "changes_requested" }))).toBe("changes_requested");
    const stages = [stage("requirements", { status: "running", progress: { done: 1, total: 3, label: "Writing acceptance criteria" } }), stage("readiness_criteria")];
    expect(phase2Step("requirements", stages)).toBe(2);
    const lc = buildLifecycle({ project_status: "active", stages: [stage("discovery", { phase: 1, status: "approved" }), ...stages, stage("test_strategy")] });
    const reqStage = lc.find((s) => s.id === "requirements")!;
    expect(stageStatusText(reqStage)).toMatch(/^Running, step \d+ \(2 of 3\)$/);
    expect(upstreamGateHint(lc.find((s) => s.id === "strategy")!, lc)).toBe("After Gate 3");
  });

  test("sidebar badge priority: Review, then Out of date, then proposals", () => {
    const st = [{ key: "requirements", status: "awaiting_approval", gate: { key: "G3", status: "pending" } }];
    expect(sectionBadge("requirements", st)).toEqual({ text: "Review", srText: "Gate 3 waiting for your review" });
    expect(sectionBadge("requirements", [{ key: "requirements", status: "stale", gate: null }])).toEqual({ text: "Out of date", srText: "out of date" });
    expect(sectionBadge("assistant", [], 2)).toEqual({ text: "2", srText: "2 proposals to review" });
    expect(sectionBadge("assistant", [], 0)).toBeNull();
  });

  test("Needs your attention keeps the priority order", () => {
    const rows = attentionRows({
      projectId: "p1",
      wf: { project_status: "active", stages: [stage("requirements", { status: "stale" }), stage("test_strategy", { status: "awaiting_approval", gate: { key: "G4", policy: "required", status: "pending", recommendation: null } })] },
      credFailed: true,
      conflicts: 1,
      proposals: 2,
      drafts: 4,
    });
    expect(rows.map((r) => r.text)).toEqual([
      "Gate 4 · Test Strategy review is waiting for your approval.",
      "Sign-in with the test account failed.",
      "Requirements are out of date.",
      "1 requirement conflicts with a document.",
      "2 AI QA Analyst proposals are waiting for review.",
      "4 requirements are still Draft.",
    ]);
    expect(rows[0].href).toBe("/projects/p1/test-strategy?view=review");
  });
});

// ---- Documents and reports -------------------------------------------------------------------

test.describe("documents and reports (design P2 §7, §10)", () => {
  const file = (name: string, size = 1000) => ({ name, size }) as File;

  test("client checks: type, size and the 10-document limit; allowed files continue", () => {
    const out = checkDocumentFiles([file("spec.pdf"), file("image.png"), file("huge.docx", 21 * 1024 * 1024), file("notes.md")], 9);
    expect(out.accepted.map((f) => f.name)).toEqual(["spec.pdf"]);
    expect(out.errors[0]).toBe("image.png: only PDF, Markdown and Word (.docx) files can be added.");
    expect(out.errors[1]).toMatch(/^huge\.docx is .+\. The limit is 20 MB\.$/);
    expect(out.errors[2]).toBe("This project already has 10 documents. Remove one to add another.");
  });

  test("document status text never invents counts", () => {
    const base = { status: "ready", pages: 14, sections: null, chars: 9000, error: null } as never;
    expect(docStatusText(base)).toBe("Ready · 14 pages");
    expect(docStatusText({ ...(base as object), status: "failed", error: "File is password protected" } as never)).toBe("Couldn’t read: password-protected");
  });

  test("report slugs, file names and draft bands", () => {
    expect(reportBySlug("requirements")?.type).toBe("requirements_spec");
    expect(reportBySlug("discovery")).toBeNull();
    expect(phase2ReportFileName("www.acme.com", "requirements_spec", 2, new Date(2026, 10, 13), "pdf")).toBe("www.acme.com-requirements-spec-v2-2026-11-13.pdf");
    expect(draftBand("requirements_spec", 2)).toBe("DRAFT — not yet approved at Gate 3");
    expect(draftBand("test_plan", 3, 2)).toBe("Version 3 · based on Strategy v2");
  });
});

// ---- QA round 1 regressions ----------------------------------------------------------

test.describe("regeneration review decisions (BUG-P2-03)", () => {
  const item = (id: string, change: ChangeReviewItem["change"], default_action: ChangeReviewItem["default_action"]): ChangeReviewItem => ({
    lineage_id: id,
    key: id,
    type: "requirement",
    change,
    protected_reason: null,
    current: null,
    proposed: null,
    field_diff: [],
    default_action,
    allowed_actions: ["accept", "keep"],
    note: null,
  });

  test("never sends null and leaves unchanged items out", () => {
    const items = [item("a", "added", "accept"), item("b", "changed", null), item("c", "unchanged", null), item("d", "unchanged", "keep"), item("e", "no_longer_found", "mark_rejected")];
    expect(reviewDecisions(items, {})).toEqual({ a: "accept", e: "mark_rejected" });
  });

  test("the user's choice wins over the default", () => {
    const items = [item("a", "added", "accept"), item("b", "changed", null)];
    expect(reviewDecisions(items, { a: "skip", b: "keep" })).toEqual({ a: "skip", b: "keep" });
  });
});

test.describe("Ready & Done order (BUG-P2-24)", () => {
  test("no reorder when the order is unchanged, including appended new rows", () => {
    expect(checklistOrder(["x", "y"], [{ id: "x", text: "X" }, { id: "y", text: "Y" }, { id: "tmp", text: "New" }], ["n1"])).toBeNull();
  });

  test("a moved row gives the full new order", () => {
    expect(checklistOrder(["x", "y", "z"], [{ id: "z", text: "Z" }, { id: "x", text: "X" }, { id: "y", text: "Y" }], [])).toEqual(["z", "x", "y"]);
  });

  test("new rows use the server's ids; removed and empty rows drop out", () => {
    expect(checklistOrder(["x", "y"], [{ id: "tmp1", text: "New" }, { id: "y", text: "Y" }, { id: "tmp2", text: "  " }], ["n1"])).toEqual(["n1", "y"]);
  });
});

test.describe("risk matrix cells (BUG-P2-06)", () => {
  test("uses the server's cells when present", () => {
    const cells = [{ likelihood: 2, impact: 3, count: 1, risk_keys: ["RISK-001"] }];
    expect(matrixCells({ cells, totals: {} }, [])).toBe(cells);
  });

  test("groups the risks by their rating when stored content has totals only", () => {
    const r = (key: string, likelihood: number, impact: number) => ({ key, likelihood, impact }) as Risk;
    expect(matrixCells({ totals: { high: 2 } }, [r("RISK-001", 4, 4), r("RISK-002", 4, 4), r("RISK-003", 1, 2)])).toEqual([
      { likelihood: 4, impact: 4, count: 2, risk_keys: ["RISK-001", "RISK-002"] },
      { likelihood: 1, impact: 2, count: 1, risk_keys: ["RISK-003"] },
    ]);
  });
});

test.describe("labels and criteria filters (BUG-P2-10)", () => {
  test("label=weak covers Assumed and Unverified together", () => {
    const f = parseFilters(new URLSearchParams("label=weak"));
    expect(f.label).toBe("weak");
    const rows = [req("REQ-1", { classification: "assumed" }), req("REQ-2", { classification: "unverified" }), req("REQ-3", { classification: "observed" })];
    expect(filterRequirements(rows, f).rows.map((r) => r.key)).toEqual(["REQ-1", "REQ-2"]);
    expect(activeFilterChips(f).map((c) => c.label)).toEqual(["Label: Assumed or Unverified"]);
  });

  test("'without acceptance criteria' means no criterion that isn't rejected, everywhere", () => {
    const rows = [req("REQ-1", { ac_count: 0 }), req("REQ-2", { ac_count: 2, ac_approved: 0 })];
    expect(filterRequirements(rows, parseFilters(new URLSearchParams("no_ac=1"))).rows.map((r) => r.key)).toEqual(["REQ-1"]);
    expect(approvalFlags(rows).noAc.map((r) => r.key)).toEqual(["REQ-1"]);
    expect(gate3Checks(rows, null, { scanN: 1, documents: 0, listHref: () => "#" }).find((c) => c.text.includes("no acceptance criteria"))?.text).toContain("1 requirement has");
  });
});

test.describe("sign-in during discovery (BUG-P2-14)", () => {
  const auth = (result: string, reason_code: string | null, attempted = true) => ({ auth: { attempted, result, reason_code, login_url: "https://x/login", authenticated_pages: 3 } });

  test("no credentials used: nothing to show", () => {
    expect(scanSignIn({ auth: null })).toBeNull();
    expect(scanSignIn(auth("not_attempted", null, false))).toBeNull();
  });

  test("success carries the signed-in page count; failure the design's reason", () => {
    expect(scanSignIn(auth("succeeded", null))).toEqual({ state: "succeeded", pages: 3 });
    expect(scanSignIn(auth("failed", "rejected"))).toEqual({ state: "failed", reason: "the site rejected the username or password" });
  });

  test("sign-in gaps are recognised for the 'We tried once' line", () => {
    expect(isSignInGap("Sign-in failed: the site rejected the username or password")).toBe(true);
    expect(isSignInGap("Needs credentials")).toBe(false);
  });
});

test.describe("signed-in pages (R2-01)", () => {
  test("a page visited with the session is 'Signed in' even if the node says it needs credentials", () => {
    expect(nodeStatus({ page_id: "p", requires_auth: true, auth_context: "authenticated", visited: true })).toEqual({ label: "Signed in", tone: "green" });
    expect(nodeStatus({ requires_auth: true })).toEqual({ label: "Needs credentials", tone: "amber" });
  });

  test("the Access filter keeps signed-in, public and needs-credentials pages apart", () => {
    const signedIn = { requires_auth: true, auth_context: "authenticated" as const };
    const locked = { requires_auth: true };
    const open = { requires_auth: false, auth_context: "anonymous" as const };
    expect([signedIn, locked, open].map((x) => matchesAccess(x, "signed_in"))).toEqual([true, false, false]);
    expect([signedIn, locked, open].map((x) => matchesAccess(x, "auth"))).toEqual([false, true, false]);
    expect([signedIn, locked, open].map((x) => matchesAccess(x, "public"))).toEqual([false, false, true]);
  });
});
