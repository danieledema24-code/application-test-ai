import { expect, test } from "@playwright/test";
import { LIFECYCLE, buildLifecycle, rollUp, stageStatusText } from "../../src/lib/lifecycle";
import type { StageKey, StageState, Workflow } from "../../src/lib/contract";

function stage(key: StageKey, over: Partial<StageState> = {}): StageState {
  const phase1 = key === "intake" || key === "discovery" || key === "discovery_report";
  return {
    key,
    title: key,
    phase: phase1 ? 1 : 2,
    available: phase1,
    status: "not_started",
    current_version: null,
    gate: null,
    started_at: null,
    finished_at: null,
    stale_reason: null,
    progress: null,
    ...over,
  };
}

const LATER: StageKey[] = ["requirements", "readiness_criteria", "test_strategy", "test_design", "traceability", "automation_assessment", "automation", "execution", "failure_analysis", "defects_summary", "release_readiness", "performance"];

function wf(...stages: StageState[]): Workflow {
  return { project_status: "active", stages: [...stages, ...LATER.map((k) => stage(k))] };
}

test("21 steps across 8 stages, gates 2–9 placed", () => {
  expect(LIFECYCLE).toHaveLength(8);
  expect(LIFECYCLE.flatMap((s) => s.steps).map((s) => s.n)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  expect(LIFECYCLE.map((s) => s.gate?.key)).toEqual(["G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]);
  expect(LIFECYCLE.find((s) => s.id === "execution")?.gate?.position).toBe("before");
});

test("roll-up: first match wins", () => {
  expect(rollUp(["done", "failed", "running"], true, true)).toBe("failed");
  expect(rollUp(["done", "waiting"], false, true)).toBe("waiting");
  expect(rollUp(["paused", "running"], false, true)).toBe("paused");
  expect(rollUp(["done", "done"], false, true)).toBe("not_started");
  expect(rollUp(["done", "done"], true, true)).toBe("done");
  expect(rollUp([], true, false)).toBe("later");
});

test("discovery running shows step n of 8 and later stages show Phase n", () => {
  const stages = buildLifecycle(
    wf(stage("intake", { status: "completed" }), stage("discovery", { status: "running", progress: { done: 3, total: 25, label: "pages" } }), stage("discovery_report", { gate: { key: "G2", policy: "required", status: "pending", recommendation: null } })),
  );
  expect(stages[0].status).toBe("running");
  expect(stageStatusText(stages[0])).toBe("Running, step 4 of 8");
  expect(stages.slice(1).map(stageStatusText)).toEqual(["Phase 2", "Phase 2", "Phase 3", "Phase 4", "Phase 4", "Phase 4", "Phase 5"]);
});

test("gate waiting → Discovery shows Waiting for your approval", () => {
  const stages = buildLifecycle(
    wf(
      stage("intake", { status: "completed" }),
      stage("discovery", { status: "completed" }),
      stage("discovery_report", { status: "awaiting_approval", current_version: 1, gate: { key: "G2", policy: "required", status: "awaiting_approval", recommendation: null } }),
    ),
  );
  expect(stages[0].status).toBe("waiting");
  expect(stages[0].gateStatus).toBe("waiting");
});

test("gate approved → Discovery done", () => {
  const stages = buildLifecycle(
    wf(
      stage("intake", { status: "completed" }),
      stage("discovery", { status: "completed" }),
      stage("discovery_report", { status: "approved", gate: { key: "G2", policy: "required", status: "approved", recommendation: null } }),
    ),
  );
  expect(stages[0].status).toBe("done");
});
