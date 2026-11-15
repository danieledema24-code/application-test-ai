// The 12 project sections (spec §15, design spec §3.2) in sidebar order. `phase: null` = "a later phase".

import {
  Bot,
  Bug,
  ClipboardList,
  Compass,
  FileText,
  Gauge,
  GitBranch,
  LayoutGrid,
  ListChecks,
  PlayCircle,
  Route,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { automationBadge } from "@/lib/automation";
import type { NonFunctionalCounts } from "@/lib/nonfunctional";

export type ProjectSection = {
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Phase the section is built in. 1 = live now. null = later (not yet assigned). */
  phase: number | null;
  /** One sentence for the "Coming in Phase N" page (design spec §13). */
  description?: string;
  /** Built ahead of the rest of its phase (Phase 4 lands story by story: Automation first). */
  built?: boolean;
};

export const PROJECT_SECTIONS: ProjectSection[] = [
  { slug: "", label: "Overview", icon: LayoutGrid, phase: 1 },
  { slug: "discovery", label: "Application Discovery", icon: Compass, phase: 1 },
  {
    slug: "requirements",
    label: "Requirements",
    icon: ClipboardList,
    phase: 2,
    description:
      "The Requirements Engineering Agent will derive provisional requirements from this project's discovery findings, each labelled Observed, Inferred, Assumed or Unverified.",
  },
  {
    slug: "test-strategy",
    label: "Test Strategy",
    icon: Route,
    phase: 2,
    description: "The Test Strategy Agent will write a risk-based Test Strategy and Test Plan, with entry and exit criteria, for your approval.",
  },
  {
    slug: "test-cases",
    label: "Test Cases",
    icon: ListChecks,
    phase: 3,
    description:
      "The Test Design Agent will write test conditions and test cases using techniques such as equivalence partitioning and boundary value analysis.",
  },
  {
    slug: "automation",
    label: "Automation",
    icon: Workflow,
    phase: 4,
    built: true,
    description: "The Test Automation Engineer Agent will generate and validate Playwright scripts linked to approved test cases.",
  },
  {
    slug: "execution",
    label: "Test Execution",
    icon: PlayCircle,
    phase: 4,
    description: "Approved tests will run here, with screenshots, traces and results as evidence.",
  },
  {
    slug: "non-functional",
    label: "Non-functional",
    icon: Gauge,
    phase: 5,
    description: "Speed under load, accessibility and basic security.",
  },
  {
    slug: "defects",
    label: "Defects",
    icon: Bug,
    phase: 4,
    description: "Defect reports drafted from confirmed failures, separated from automation issues, for your review.",
  },
  {
    slug: "traceability",
    label: "Traceability",
    icon: GitBranch,
    phase: 3,
    description: "A requirements traceability matrix linking requirements, test cases, scripts, results and defects.",
  },
  { slug: "reports", label: "Reports", icon: FileText, phase: 1 },
  {
    slug: "assistant",
    label: "AI QA Analyst",
    icon: Bot,
    phase: 2,
    description: "Ask questions about this project's evidence: coverage, failures, risks. Answers use only recorded project data.",
  },
];

export function sectionBySlug(slug: string): ProjectSection | undefined {
  return PROJECT_SECTIONS.find((s) => s.slug === slug);
}

export function phaseLabel(phase: number | null): string {
  return phase === null ? "Later" : `Phase ${phase}`;
}

export function comingLabel(phase: number | null): string {
  return phase === null ? "coming later" : `coming in Phase ${phase}`;
}

/** The phase the product has reached: sections up to it are real screens (design P2 §3.2). */
export const CURRENT_PHASE = 5;

export function isBuilt(s: ProjectSection): boolean {
  return s.built === true || (s.phase !== null && s.phase <= CURRENT_PHASE);
}

export type SectionBadge = { text: string; srText: string };

/** Run and defect counts behind the Test Execution and Defects badges (design P4 §4.2). */
export type ExecutionCounts = { runsWaiting: number; running: boolean; drafts: number };

/**
 * One attention badge per built section, in priority order: gate waiting → out of date → proposals
 * (design P2 §3.2). `workflow` stage statuses come straight from the API.
 */
export function sectionBadge(
  slug: string,
  stages: { key: string; status: string; gate: { key: string; status: string } | null }[] | undefined,
  pendingProposals = 0,
  openQuestions = 0,
  execution?: ExecutionCounts,
  nonFunctional?: NonFunctionalCounts,
): SectionBadge | null {
  const by = (k: string) => stages?.find((s) => s.key === k);
  const gateWaiting = (k: string) => {
    const s = by(k);
    const g = s?.gate?.status?.toLowerCase();
    return !!s && (s.status === "awaiting_approval" || (s.status === "completed" && (g === "pending" || g === "recommended")));
  };
  if (slug === "requirements") {
    if (gateWaiting("readiness_criteria") || gateWaiting("requirements")) return { text: "Review", srText: "Gate 3 waiting for approval" };
    if (by("requirements")?.status === "stale") return { text: "Out of date", srText: "out of date" };
  }
  if (slug === "test-strategy") {
    if (gateWaiting("test_strategy")) return { text: "Review", srText: "Gate 4 waiting for approval" };
    if (by("test_strategy")?.status === "stale") return { text: "Out of date", srText: "out of date" };
  }
  if (slug === "test-cases") {
    if (gateWaiting("test_design")) return { text: "Review", srText: "Gate 5 waiting for approval" };
    if (by("test_design")?.status === "stale") return { text: "Out of date", srText: "out of date" };
    if (openQuestions > 0) return { text: `${openQuestions} ?`, srText: `${openQuestions} open question${openQuestions === 1 ? "" : "s"}` };
  }
  if (slug === "automation") return automationBadge(stages);
  if (slug === "execution" && execution) {
    const n = execution.runsWaiting;
    if (n > 0) return { text: "Authorise", srText: `${n} run${n === 1 ? "" : "s"} waiting for authorisation` };
    if (execution.running) return { text: "Running", srText: "a run is in progress" };
  }
  if (slug === "defects" && execution && execution.drafts > 0) {
    const n = execution.drafts;
    return { text: `${n} to review`, srText: `${n} draft${n === 1 ? "" : "s"} waiting for review` };
  }
  if (slug === "non-functional" && nonFunctional) {
    // Design P5 §4.2, first match wins.
    const n = nonFunctional.waiting;
    if (n > 0 && nonFunctional.canApprove) return { text: "Approve", srText: `${n} load test${n === 1 ? "" : "s"} waiting for your approval` };
    if (n > 0) return { text: "Waiting", srText: "a load test is waiting for approval" };
    if (nonFunctional.running) return { text: "Running", srText: "a check is in progress" };
    if (nonFunctional.stale) return { text: "Out of date", srText: "checks are out of date" };
  }
  if (slug === "traceability" && (by("traceability")?.status === "stale" || by("test_design")?.status === "stale")) return { text: "Out of date", srText: "out of date" };
  if (slug === "assistant" && pendingProposals > 0)
    return { text: String(pendingProposals), srText: `${pendingProposals} proposal${pendingProposals === 1 ? "" : "s"} to review` };
  return null;
}

/** "/projects/abc/discovery" → { id: "abc", section: "discovery" }. `/projects/new` is not a project. */
export function projectRoute(pathname: string): { id: string; section: string } | null {
  const m = pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/);
  if (!m || m[1] === "new") return null;
  return { id: decodeURIComponent(m[1]), section: m[2] ?? "" };
}
