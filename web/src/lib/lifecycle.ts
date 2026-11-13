// QA lifecycle model (design spec §7.1): the 21 steps of spec §5 grouped into 8 stages with 9 gates,
// mapped onto the API's workflow stages. Pure functions, unit-tested in tests/unit.

import type { GateKey, StageKey, StageState, StageStatus, Workflow } from "./contract";

export type LifecycleStatus =
  | "done"
  | "running"
  | "waiting"
  | "changes_requested"
  | "paused"
  | "out_of_date"
  | "failed"
  | "cancelled"
  | "not_started"
  | "later";

export const STATUS_LABEL: Record<LifecycleStatus, string> = {
  done: "Done",
  running: "Running",
  waiting: "Waiting for your approval",
  changes_requested: "Changes requested",
  paused: "Paused",
  out_of_date: "Out of date",
  failed: "Failed",
  cancelled: "Cancelled",
  not_started: "Not started",
  later: "Coming later",
};

export type LifecycleStageDef = {
  id: string;
  label: string;
  /** Project section slug the stage links to. */
  section: string;
  phase: number;
  phaseLabel: string;
  /** API stages that roll up into this lifecycle stage, in order. */
  apiStages: StageKey[];
  steps: { n: number; name: string; agent: string }[];
  /** Gate at the end of the stage (Execution has its gate before). */
  gate: { key: GateKey; name: string; position: "before" | "after" } | null;
};

export const LIFECYCLE: LifecycleStageDef[] = [
  {
    id: "discovery",
    label: "Discovery",
    section: "discovery",
    phase: 1,
    phaseLabel: "Phase 1",
    apiStages: ["intake", "discovery", "discovery_report"],
    steps: [
      { n: 1, name: "Validate URL & check access", agent: "Lead QA Orchestrator" },
      { n: 2, name: "Create QA project", agent: "Lead QA Orchestrator" },
      { n: 3, name: "Launch isolated browser", agent: "Application Discovery Agent" },
      { n: 4, name: "Inspect application", agent: "Application Discovery Agent" },
      { n: 5, name: "Build sitemap & functionality map", agent: "Application Discovery Agent" },
      { n: 6, name: "Capture screenshots & DOM evidence", agent: "Application Discovery Agent" },
      { n: 7, name: "Identify access gaps", agent: "Application Discovery Agent" },
      { n: 8, name: "Generate Application Discovery Report", agent: "Application Discovery Agent" },
    ],
    gate: { key: "G2", name: "Discovery completeness", position: "after" },
  },
  {
    id: "requirements",
    label: "Requirements",
    section: "requirements",
    phase: 2,
    phaseLabel: "Phase 2",
    apiStages: ["requirements", "readiness_criteria"],
    steps: [
      { n: 9, name: "Derive provisional requirements", agent: "Requirements Engineering Agent" },
      { n: 10, name: "Acceptance criteria", agent: "Requirements Engineering Agent" },
      { n: 11, name: "Definition of Ready & Done", agent: "Requirements Engineering Agent" },
    ],
    gate: { key: "G3", name: "Requirements review", position: "after" },
  },
  {
    id: "strategy",
    label: "Strategy",
    section: "test-strategy",
    phase: 2,
    phaseLabel: "Phase 2",
    apiStages: ["test_strategy"],
    steps: [{ n: 12, name: "Risk-based Test Strategy & Test Plan", agent: "Test Strategy Agent" }],
    gate: { key: "G4", name: "Test strategy approval", position: "after" },
  },
  {
    id: "test-design",
    label: "Test design",
    section: "test-cases",
    phase: 3,
    phaseLabel: "Phase 3",
    apiStages: ["test_design", "traceability"],
    steps: [
      { n: 13, name: "Test conditions & test cases", agent: "Test Design Agent" },
      { n: 14, name: "Traceability matrix", agent: "Test Design Agent" },
    ],
    gate: { key: "G5", name: "Test case quality", position: "after" },
  },
  {
    id: "automation",
    label: "Automation",
    section: "automation",
    phase: 4,
    phaseLabel: "Phase 4",
    apiStages: ["automation_assessment", "automation"],
    steps: [
      { n: 15, name: "Automation suitability", agent: "Test Automation Engineer Agent" },
      { n: 16, name: "Generate scripts", agent: "Test Automation Engineer Agent" },
      { n: 17, name: "Validate scripts", agent: "Test Automation Engineer Agent" },
    ],
    gate: { key: "G6", name: "Script validation", position: "after" },
  },
  {
    id: "execution",
    label: "Execution",
    section: "execution",
    phase: 4,
    phaseLabel: "Phase 4",
    apiStages: ["execution"],
    steps: [{ n: 18, name: "Execute approved tests", agent: "Test Execution Agent" }],
    gate: { key: "G7", name: "Execution authorisation", position: "before" },
  },
  {
    id: "defects",
    label: "Defects",
    section: "defects",
    phase: 4,
    phaseLabel: "Phase 4",
    apiStages: ["failure_analysis", "defects_summary"],
    steps: [
      { n: 19, name: "Analyse results & investigate failures", agent: "Failure Analysis Agent" },
      { n: 20, name: "Defect reports & QA summary", agent: "Defect Reporting Agent" },
    ],
    gate: { key: "G8", name: "Defect review", position: "after" },
  },
  {
    id: "reporting",
    label: "Reporting",
    section: "reports",
    phase: 5,
    phaseLabel: "Phase 5",
    apiStages: ["release_readiness"],
    steps: [{ n: 21, name: "Release readiness assessment", agent: "Lead QA Orchestrator" }],
    gate: { key: "G9", name: "Release readiness", position: "after" },
  },
];

/** Gate 1 is recorded on project creation, before Discovery's first step. */
export const GATE_1 = { key: "G1" as GateKey, name: "Authorisation", afterStep: 1 };

/** API stage status → lifecycle status for one API stage. */
export function fromApiStatus(s: StageState | undefined): LifecycleStatus {
  if (!s) return "not_started";
  if (!s.available && (s.status === "not_started" || !s.status)) return "later";
  switch (s.status) {
    case "completed":
    case "approved":
      return "done";
    case "running":
    case "queued":
      return "running";
    case "awaiting_approval":
      return "waiting";
    case "changes_requested":
      return "changes_requested";
    case "paused":
      return "paused";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "out_of_date";
    case "not_started":
    default:
      return "not_started";
  }
}

export type LifecycleStage = LifecycleStageDef & {
  status: LifecycleStatus;
  /** "Step 4 of 8" while running, 1-based within the stage. */
  currentStep: number | null;
  stages: StageState[];
  gateStatus: LifecycleStatus | null;
  /** The API stage that carries this lifecycle stage's gate, if any. */
  gateStage: StageState | null;
};

/**
 * First match wins (design P2 §12.1): Failed → Waiting → Changes requested → Paused → Running → Out of date →
 * Cancelled → Done → Not started / Coming later.
 */
export function rollUp(statuses: LifecycleStatus[], gateApproved: boolean, available: boolean): LifecycleStatus {
  if (!available) return "later";
  if (statuses.length === 0) return "not_started";
  for (const s of ["failed", "waiting", "changes_requested", "paused", "running", "out_of_date", "cancelled"] as const) if (statuses.includes(s)) return s;
  if (statuses.every((s) => s === "done") && gateApproved) return "done";
  return "not_started";
}

/**
 * Whether a stage's gate can be decided now, and how strongly (mirrors the orchestrator's rule):
 * the stage has finished (awaiting approval, completed or cancelled) and the gate is still open.
 * "required" = gate status pending (policy required); "recommended" = approval advised but not
 * blocking (the default for Gate 2). null = not reached, already decided, or no gate.
 */
export function gateReview(stage: StageState | null | undefined): "required" | "recommended" | null {
  const g = stage?.gate?.status?.toLowerCase();
  if (!stage || !g) return null;
  if (!["awaiting_approval", "completed", "cancelled"].includes(stage.status)) return null;
  if (g === "pending" || (stage.status === "awaiting_approval" && g !== "recommended" && g !== "approved" && g !== "rejected")) return "required";
  if (g === "recommended") return "recommended";
  return null;
}

function gateApprovedFor(stages: StageState[], gateKey: GateKey | undefined): { approved: boolean; stage: StageState | null; status: LifecycleStatus | null } {
  const stage = stages.find((s) => s.gate?.key === gateKey) ?? null;
  if (!stage || !stage.gate) return { approved: true, stage: null, status: null };
  const g = stage.gate.status.toLowerCase();
  const approved = g === "approved" || g === "auto" || g === "auto_approved" || stage.status === "approved";
  // A gate is "waiting" once its stage has finished and the gate is open (required or recommended);
  // "pending" on a stage that hasn't finished means the gate hasn't been reached yet.
  const waiting = !approved && (gateReview(stage) !== null || stage.status === "awaiting_approval");
  return {
    approved,
    stage,
    status: approved ? "done" : waiting ? "waiting" : g === "changes_requested" ? "changes_requested" : g === "rejected" ? "failed" : "not_started",
  };
}

/** Current step within the Discovery stage (1–8), estimated from the API stage states. */
export function discoveryStep(stages: StageState[]): number | null {
  const by = (k: StageKey) => stages.find((s) => s.key === k);
  const intake = by("intake");
  const disc = by("discovery");
  const rep = by("discovery_report");
  if (intake && (intake.status === "running" || intake.status === "queued")) return 1;
  if (disc?.status === "queued") return 3;
  if (disc?.status === "running" || disc?.status === "paused") {
    const p = disc.progress;
    // Inspecting pages is step 4; once the page limit is reached the agent is mapping/collecting (5–7).
    if (p && p.total && p.done >= p.total) return 7;
    return 4;
  }
  if (rep && (rep.status === "running" || rep.status === "queued" || rep.status === "paused")) return 8;
  return null;
}

/** Current step within a Phase 2 stage, 1-based (Requirements: 9 derive, 10 criteria, 11 Ready & Done). */
export function phase2Step(id: string, stages: StageState[]): number | null {
  const by = (k: StageKey) => stages.find((s) => s.key === k);
  const working = (s: StageState | undefined) => !!s && (s.status === "running" || s.status === "queued" || s.status === "paused");
  if (id === "requirements") {
    if (working(by("readiness_criteria"))) return 3;
    const req = by("requirements");
    if (working(req)) return /accept|criteri/i.test(req?.progress?.label ?? "") ? 2 : 1;
    return null;
  }
  if (id === "strategy") return working(by("test_strategy")) ? 1 : null;
  return null;
}

export function buildLifecycle(workflow: Workflow | undefined | null): LifecycleStage[] {
  const all = workflow?.stages ?? [];
  return LIFECYCLE.map((def) => {
    const stages = def.apiStages.map((k) => all.find((s) => s.key === k)).filter((s): s is StageState => !!s);
    const available = stages.length > 0 ? stages.some((s) => s.available) : false;
    const gate = gateApprovedFor(stages, def.gate?.key);
    const statuses = stages.filter((s) => s.available).map(fromApiStatus);
    if (gate.status === "waiting") statuses.push("waiting");
    const status = rollUp(statuses, gate.approved, available);
    return {
      ...def,
      stages,
      status,
      currentStep: status !== "running" ? null : def.id === "discovery" ? discoveryStep(stages) : phase2Step(def.id, stages),
      gateStatus: available ? gate.status : null,
      gateStage: gate.stage,
    };
  });
}

/** Text for the stage's status, e.g. "Running, step 4 of 8", "Running, step 10 (2 of 3)" or "Phase 2". */
export function stageStatusText(stage: LifecycleStage): string {
  if (stage.status === "later") return stage.phaseLabel;
  if (stage.status === "running" && stage.currentStep) {
    if (stage.id === "discovery") return `Running, step ${stage.currentStep} of ${stage.steps.length}`;
    const step = stage.steps[stage.currentStep - 1];
    return `Running, step ${step?.n ?? stage.currentStep} (${stage.currentStep} of ${stage.steps.length})`;
  }
  return STATUS_LABEL[stage.status];
}

/** "After Gate 2" under a Phase 2 stage that is waiting for its upstream gate (design §12.1). */
export function upstreamGateHint(stage: LifecycleStage, all: LifecycleStage[]): string | null {
  if (stage.status !== "not_started") return null;
  const i = all.findIndex((s) => s.id === stage.id);
  const prev = i > 0 ? all[i - 1] : null;
  if (!prev?.gate || prev.gateStatus === "done") return null;
  return `After Gate ${prev.gate.key.slice(1)}`;
}

/** API stage status → StatusPill key used across the app. */
export function stageStatusLabel(s: StageStatus | null | undefined): string {
  switch (s) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "awaiting_approval":
      return "Waiting for your approval";
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "stale":
      return "Out of date";
    case "cancelled":
      return "Cancelled";
    case "not_started":
    default:
      return "Not started";
  }
}

/** Is any stage of the workflow currently working (queued, running) or paused? */
export function activeStage(workflow: Workflow | undefined | null): StageState | null {
  return workflow?.stages.find((s) => s.status === "running" || s.status === "queued" || s.status === "paused") ?? null;
}

/** The stage waiting for a gate decision, if any. */
export function waitingGateStage(workflow: Workflow | undefined | null): StageState | null {
  return workflow?.stages.find((s) => gateReview(s) !== null) ?? null;
}
