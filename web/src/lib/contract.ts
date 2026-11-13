// Types for the QA Analyst backend (docs/architecture/api-contracts.md, base /api/v1).
// Field names are the API's (snake_case). Keep in sync with the backend's OpenAPI schema.
// Where the contract leaves a shape unspecified, the type is marked "assumed" and every reader
// treats those fields as optional.

export type Uuid = string;
export type IsoDate = string;

// ---- Shared ---------------------------------------------------------------

export type Provenance = "observed" | "inferred" | "assumed" | "unverified";
export type GeneratedBy = "ai" | "rules" | "human";

export type EvidenceRef = {
  evidence_id: Uuid;
  selector?: string | null;
  excerpt?: string | null;
  note?: string | null;
};

export type Provenanced = {
  provenance: Provenance;
  confidence: number;
  evidence_refs: EvidenceRef[];
  generated_by: GeneratedBy;
};

export type StageKey =
  | "intake"
  | "discovery"
  | "discovery_report"
  | "requirements"
  | "readiness_criteria"
  | "test_strategy"
  | "test_design"
  | "traceability"
  | "automation_assessment"
  | "automation"
  | "execution"
  | "failure_analysis"
  | "defects_summary"
  | "release_readiness"
  | "performance";

export type StageStatus =
  | "not_started"
  | "queued"
  | "running"
  | "paused"
  | "awaiting_approval"
  | "approved"
  | "changes_requested"
  | "completed"
  | "failed"
  | "stale"
  | "cancelled";

export type GateKey = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9";

export type Page<T> = { items: T[]; next_cursor: string | null };

/** Error envelope returned with every non-2xx response. */
export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: { field?: string; message: string }[] | Record<string, unknown> | null;
    request_id?: string;
  };
};

/** Assumed: the contract references UserRef without defining it. */
export type UserRef = { id: Uuid; full_name?: string; email?: string };

// ---- Auth -----------------------------------------------------------------

export type User = { id: Uuid; email: string; full_name: string };
export type Organisation = { id: Uuid; name: string; slug: string };
export type Role = "owner" | "admin" | "member" | "viewer";

export type AuthResponse = {
  token: string;
  expires_at: IsoDate;
  user: User;
  organisation: Organisation;
  role: Role;
};

export type Me = { user: User; organisation: Organisation; role: Role; can_approve: boolean };

// ---- Health / dashboard ---------------------------------------------------

export type Health = {
  status: "ok" | "degraded";
  db: boolean;
  worker: { mode: "inline" | "separate"; last_heartbeat_s: number | null };
  queue_depth: number;
  ai: { enabled: boolean; provider: string | null; model: string | null };
  browser: { available: boolean };
  version: string;
  /** Being added by the backend: true when the server allows loopback/private targets (dev/test only). */
  allow_private_targets?: boolean;
};

export type ActivityItem = {
  id: number;
  project_id: Uuid;
  project_name: string;
  type: string;
  message: string;
  level: string;
  created_at: IsoDate;
};

export type ProjectStatus = "active" | "paused" | "archived";

export type ProjectSummary = {
  id: Uuid;
  name: string;
  primary_url: string;
  status: ProjectStatus;
  current_stage: StageKey | null;
  current_stage_status: StageStatus | null;
  pages_discovered: number;
  awaiting_approval: boolean;
  updated_at: IsoDate;
};

export type Dashboard = {
  welcome: { full_name: string; organisation: string };
  recent_projects: ProjectSummary[];
  activity: ActivityItem[];
  health: {
    projects_total: number;
    scans_running: number;
    awaiting_approval: number;
    failed_stages: number;
    pages_discovered_30d: number;
  };
  ai: { enabled: boolean; model: string | null };
};

// ---- URL check / project creation (Gate 1) ---------------------------------

export type UrlCheckResult = {
  input_url: string;
  normalised_url: string;
  allowed: boolean;
  blocked_reason: string | null;
  reachable: boolean;
  http_status: number | null;
  final_url: string | null;
  redirects: { url: string; status: number }[];
  cross_site_redirect: boolean;
  tls: { valid: boolean; error: string | null } | null;
  content_type: string | null;
  robots: { found: boolean; disallows_start: boolean } | null;
  checked_at: IsoDate;
  /** Not in the contract: optional extras read if the backend sends them. */
  page_title?: string | null;
  resolved_ip?: string | null;
  error?: string | null;
};

export type ScanSettings = {
  max_pages: number;
  max_depth: number;
  include_mobile: boolean;
  respect_robots: boolean;
  /** Phase 2: sign in with the saved test credentials (ignored when none are saved). */
  use_credentials?: boolean;
};

export const DEFAULT_SCAN_SETTINGS: ScanSettings = { max_pages: 30, max_depth: 3, include_mobile: true, respect_robots: true };

export type ProjectCreate = {
  url: string;
  name?: string | null;
  description?: string;
  authorisation: { attested: true; statement: string };
  scan?: ScanSettings;
  start?: boolean;
  /** Resend after a 409 duplicate warning to create a second project for the same URL. */
  confirmDuplicate?: boolean;
  /** All three or none; stored encrypted and never returned. */
  credentials?: { login_url: string; username: string; password: string } | null;
};

export type ProjectUrl = {
  id: Uuid;
  url: string;
  role: string;
  allowed_hosts: string[];
  authorisation_status: string;
  authorised_by: UserRef | null;
  authorised_at: IsoDate | null;
  last_check: UrlCheckResult | null;
};

export type ProjectDetail = ProjectSummary & {
  description: string;
  version: number;
  urls: ProjectUrl[];
  approval_policy: Partial<Record<GateKey, "required" | "recommended" | "auto">>;
  locked_gates: GateKey[];
  settings: ScanSettings;
  created_at: IsoDate;
  created_by: UserRef;
};

// ---- Workflow -------------------------------------------------------------

export type GateRecommendation = {
  recommend: "proceed" | "proceed_with_caution" | "do_not_proceed";
  reasons: string[];
  generated_by: "ai" | "rules";
};

export type GatePrecondition = { code: string; met: boolean; blocking: boolean; message: string; link: string | null };

export type StageGate = {
  key: GateKey;
  policy: string;
  status: string;
  recommendation: GateRecommendation | null;
  title?: string;
  decision?: GateDecision | null;
  /** Phase 2 (G3/G4): computed on read so the UI can show blockers before the user clicks. */
  preconditions?: GatePrecondition[];
  /** Phase 2 (G3/G4): items new or changed since the last approval; 0 if never approved. */
  changes_since_approval?: number;
};

export type StageState = {
  key: StageKey;
  title: string;
  phase: number;
  available: boolean;
  status: StageStatus;
  current_version: number | null;
  gate: StageGate | null;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  stale_reason: string | null;
  progress: { done: number; total: number | null; label: string } | null;
  /** Phase 2: a regenerated candidate run waiting for review. */
  pending_review?: { version: number; created_at: IsoDate; summary: Record<string, number> } | null;
  /** Phase 2: which upstream approval this stage's current output used. */
  approved_input?: { stage_key: StageKey; snapshot_hash: string; version: number } | null;
};

export type Workflow = { project_status: ProjectStatus; stages: StageState[] };

/** Assumed: the contract references GateDecision without defining it. */
export type GateDecision = {
  id?: Uuid;
  gate_key?: GateKey;
  gate?: GateKey;
  stage_run_version?: number | null;
  artefact_snapshot?: { items: number; hash: string } | null;
  decision: "approve" | "reject" | "request_changes";
  comment?: string | null;
  decided_by?: UserRef | null;
  decided_at?: IsoDate | null;
  created_at?: IsoDate | null;
};

export type StageRunDetail = {
  version: number;
  status: string;
  generated_by: string;
  partial: boolean;
  upstream_versions: Partial<Record<StageKey, number>>;
  validation_issues: { severity: string; code: string; message: string; path: string | null }[];
  output: Record<string, unknown>;
  decisions: GateDecision[];
};

// ---- Scans / discovery ----------------------------------------------------

export type ScanStatus = "queued" | "running" | "paused" | "completed" | "partial" | "failed" | "cancelled";

export type ScanSummary = {
  id: Uuid;
  key: string;
  status: ScanStatus;
  start_url: string;
  pages_found: number;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
};

export type ScanStats = {
  pages: number;
  forms: number;
  inputs: number;
  buttons: number;
  links: number;
  tables: number;
  modals: number;
  search: number;
  filters: number;
  console_errors: number;
  failed_requests: number;
  blocked_requests: number;
  /** Equals access_gaps.length on the scan (also in the report's counts). */
  access_gaps?: number;
};

/** One access gap as reported by discovery (fixed reason vocabulary; includes auth boundaries). */
export type AccessGap = {
  area: string;
  reason: string;
  description: string;
  suggestion: string;
  evidence_refs: EvidenceRef[];
};

export type AuthBoundary = {
  url: string;
  kind: "login_form" | "http_401" | "http_403" | "redirect_to_login";
  evidence_refs: EvidenceRef[];
};

export type ScanDetail = ScanSummary & {
  limits: ScanSettings;
  stats: ScanStats;
  /** null until the scan has finished and been assessed. */
  completeness: { score: number; rating: "good" | "partial" | "limited"; reasons: string[] } | null;
  auth_boundaries: AuthBoundary[];
  access_gaps: AccessGap[];
  limitations: string[];
  blocked_requests: { url: string; reason: string }[];
  current: { url: string; title: string } | null;
  error: string | null;
  /** Phase 2: sign-in with saved test credentials. */
  auth?: { attempted: boolean; result: string; reason_code: string | null; login_url: string | null; authenticated_pages: number } | null;
};

export type EvidenceLink = {
  id: Uuid;
  kind: string;
  mime: string;
  size: number;
  captured_at: IsoDate;
  content_url: string;
};

export type EvidenceDetail = EvidenceLink & { metadata?: Record<string, unknown> | null };

export type PageSummary = {
  id: Uuid;
  url: string;
  title: string;
  http_status: number | null;
  depth: number;
  page_type: string;
  requires_auth: boolean;
  counts: Record<string, number>;
  screenshot: EvidenceLink | null;
  /** Phase 2: pages visited with the test-account session are "authenticated". */
  auth_context?: "anonymous" | "authenticated";
};

export type FormField = {
  name: string;
  type: string;
  label: string;
  required: boolean;
  placeholder: string | null;
  constraints: { min: string | null; max: string | null; maxlength: number | null; pattern: string | null };
  options: string[] | null;
  locator: string;
};

export type Form = {
  name: string | null;
  method: string;
  action: string;
  purpose_guess: string;
  submit_label: string | null;
  fields: FormField[];
};

export type ComponentKind =
  | "button"
  | "link"
  | "dropdown"
  | "search"
  | "filter"
  | "table"
  | "modal"
  | "tabs"
  | "accordion"
  | "menu"
  | "pagination"
  | "other";

export type PageComponent = {
  kind: ComponentKind;
  role: string | null;
  name: string;
  locator: string;
  fingerprint: string;
  details: Record<string, unknown>;
};

export type ResponsiveView = {
  viewport: string;
  nav_collapsed: boolean;
  horizontal_overflow: boolean;
  screenshot: EvidenceLink | null;
};

export type PageDetail = PageSummary & {
  headings: string[];
  nav_links: { text: string; href: string }[];
  forms: Form[];
  components: PageComponent[];
  responsive: Record<string, ResponsiveView>;
  console_issues: { level: string; text: string }[];
  network_issues: { url: string; status: number | null; failure: string | null }[];
  evidence: EvidenceLink[];
};

/** Assumed: the contract names SitemapNode ("tree by URL path + discovery parent") without fields. */
export type SitemapNode = {
  url?: string | null;
  path?: string | null;
  title?: string | null;
  page_id?: Uuid | null;
  status?: string | null;
  http_status?: number | null;
  requires_auth?: boolean | null;
  visited?: boolean | null;
  /** Phase 2: taken from the page; "authenticated" = visited with the test-account session. */
  auth_context?: "anonymous" | "authenticated";
  children?: SitemapNode[];
};

export type Feature = Provenanced & {
  id: Uuid;
  key: string;
  name: string;
  description: string;
  category: string;
  page_ids: Uuid[];
};

export type Journey = Provenanced & {
  id: Uuid;
  key: string;
  name: string;
  /** `label` is the step's own provenance: navigated steps are observed, never-performed ones inferred. */
  steps: { page_id: Uuid; action: string; label?: "observed" | "inferred" }[];
  /** Why the journey is labelled as it is, when the API gives a reason. */
  reason?: string | null;
};

// ---- Reports --------------------------------------------------------------

export type ReportSummary = {
  id: Uuid;
  report_type: string;
  version: number;
  status: "rendering" | "ready" | "failed";
  formats: string[];
  generated_by: string;
  created_at: IsoDate;
  /** Not in the contract: needed to tie a report to its scan. Read if present. */
  scan_id?: Uuid | null;
  /** Additive fields from the backend (read if present). */
  scan_key?: string | null;
  scan_number?: number | null;
  /** false when a newer scan exists: the report describes an older scan. */
  is_latest_scan?: boolean;
  approval_status?: "draft" | "approved" | "changes_requested";
  partial?: boolean;
  /** Phase 2 report types. */
  approval?: { gate: GateKey | null; status: "draft" | "approved"; approved_by: UserRef | null; approved_at: IsoDate | null } | null;
  is_latest_source?: boolean;
  stage_run_version?: number | null;
  error?: string | null;
};

export type DiscoveryReportContent = {
  summary: string;
  summary_generated_by: "ai" | "rules";
  scope_and_method: string[];
  sitemap: SitemapNode;
  functionality_map: Feature[];
  pages: PageSummary[];
  forms_inventory: { page_url: string; form: Form }[];
  interactive_components: Record<string, number>;
  journeys: Journey[];
  auth_boundaries: Record<string, unknown>[];
  access_gaps: Record<string, unknown>[];
  responsive_observations: string[];
  console_and_network_issues: Record<string, unknown>[];
  injection_flags: { page_url: string; excerpt: string; evidence_refs: EvidenceRef[] }[];
  completeness: Record<string, unknown>;
  limitations: string[];
  evidence_index: EvidenceLink[];
  disclaimer: string;
};

export type ReportFile = { format: "pdf" | "html" | "json"; size: number; sha256: string; filename: string; content_url: string };

export type ReportDetail = ReportSummary & { content: DiscoveryReportContent | null; files?: ReportFile[] };

// ---- Live events (SSE) -----------------------------------------------------

export type AgentEvent = {
  id: number;
  project_id: Uuid;
  stage_key: StageKey | null;
  agent_key: string | null;
  task_id: Uuid | null;
  type: string;
  level: string;
  message: string;
  data: Record<string, unknown> | null;
  created_at: IsoDate;
};

// ============================================================================
// Phase 2 (api-contracts.md "Phase 2 endpoints (full detail)")
// ============================================================================

export type Classification = Provenance;
export type BehaviourScope = "ui" | "backend" | "mixed";
export type ItemStatus = "draft" | "approved" | "rejected";
export type RequirementStatus = "draft" | "approved" | "rejected" | "needs_info";
export type RequirementCategory =
  | "navigation"
  | "content"
  | "form_input"
  | "validation"
  | "authentication"
  | "session"
  | "search"
  | "commerce"
  | "account"
  | "data_processing"
  | "notification"
  | "integration"
  | "accessibility"
  | "usability"
  | "compatibility"
  | "performance"
  | "security"
  | "privacy"
  | "other";

export type ArtefactType =
  | "requirement"
  | "acceptance_criterion"
  | "readiness_criterion"
  | "feature"
  | "journey"
  | "page"
  | "evidence"
  | "risk"
  | "strategy_section"
  | "plan_section"
  | "document"
  | "gate"
  | "stage"
  | "scan";

export type ArtefactRef = { type: ArtefactType; id: Uuid | null; key: string; label: string; path: string };

export type Editable = { version: number; locked: boolean; human_edited: boolean; updated_at: IsoDate; updated_by: UserRef | null };

export type ReviewAction = "accept" | "keep" | "skip" | "mark_rejected";

export type ChangeReviewItem = {
  lineage_id: Uuid;
  key: string;
  type: "requirement" | "acceptance_criterion" | "readiness_criterion" | "risk" | "strategy_section" | "plan_section";
  change: "added" | "changed" | "protected_with_proposal" | "no_longer_found" | "unchanged";
  protected_reason: "locked" | "human_edited" | "approved" | "user_created" | null;
  current: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
  field_diff: { field: string; from: unknown; to: unknown }[];
  /** Contract: never null. Older servers sent null for unchanged items, so the UI tolerates it (BUG-P2-03). */
  default_action: ReviewAction | null;
  allowed_actions: ReviewAction[];
  note: string | null;
};

export type ChangeReview = {
  stage_key: StageKey;
  artefact: "requirements" | "readiness_criteria" | "test_strategy" | "test_plan";
  current_version: number | null;
  candidate_version: number;
  review_status: "pending_review" | "applied" | "discarded";
  guidance: string | null;
  summary: Record<string, number>;
  items: ChangeReviewItem[];
  gate_effect: string | null;
};

export type ChangeReviewApply = { decisions: Record<Uuid, ReviewAction>; comment?: string | null };

export type RegenerationDiff = {
  from_version: number | null;
  to_version: number;
  added: string[];
  changed: string[];
  rejected_as_no_longer_found: string[];
  kept_current: string[];
  suppressed_rejected: string[];
};

export type Revision = {
  version: number;
  changed_by: UserRef | null;
  change_reason: string | null;
  source: "user" | "assistant_proposal" | "regeneration_review" | "system";
  created_at: IsoDate;
  changes: Record<string, { from: unknown; to: unknown }>;
  snapshot: Record<string, unknown>;
};

export type ValidationIssue = { severity: "info" | "warning" | "error"; code: string; message: string; path: string | null; item_key?: string | null };

// ---- Project secrets (P2-01) ------------------------------------------------

export type ScanCredentialsInput = { login_url: string; username: string; password: string };

export type SecretMeta = {
  id: Uuid;
  name: string;
  kind: "login_credentials";
  login_url: string | null;
  /** Masked, e.g. "qa…@example.com". Never the full value; the UI doesn't render it either (design §4.2). */
  username_hint: string | null;
  version: number;
  created_by: UserRef;
  created_at: IsoDate;
  rotated_at: IsoDate | null;
  last_used_at: IsoDate | null;
  last_result: "succeeded" | "failed" | "not_attempted" | null;
  last_reason_code: "form_not_found" | "rejected" | "captcha" | "mfa_required" | "timeout" | "blocked" | null;
};

// ---- Requirements (P2-02, P2-03, P2-04) --------------------------------------

export type RequirementSource = "discovery" | "document" | "user" | "assistant";

export type RequirementSummary = Provenanced & {
  id: Uuid;
  key: string;
  lineage_id: Uuid;
  title: string;
  type: "functional" | "non_functional";
  category: RequirementCategory;
  behaviour_scope: BehaviourScope;
  classification: Classification;
  source: RequirementSource;
  status: RequirementStatus;
  ac_count: number;
  ac_approved: number;
  risk_level: RiskLevel | null;
  stage_run_version: number;
  version: number;
  locked: boolean;
  human_edited: boolean;
  updated_at: IsoDate;
  /** Not in the contract: read if the backend sends them (design §5.2 flags and columns). */
  related_feature_names?: string[];
  conflict?: boolean;
  changed_in_latest?: boolean;
};

export type AcceptanceCriterion = Provenanced &
  Editable & {
    id: Uuid;
    key: string;
    lineage_id: Uuid;
    requirement_id: Uuid;
    requirement_key: string;
    kind: "positive" | "negative" | "boundary";
    given: string;
    when: string;
    then: string;
    classification: Classification;
    status: ItemStatus;
    rule_id: string | null;
    test_values: { field: string; value: string; note: string }[] | null;
  };

export type AcceptanceCriterionCreate = { kind: "positive" | "negative" | "boundary"; given: string; when: string; then: string; evidence_refs?: EvidenceRef[] };

export type RequirementDetail = RequirementSummary & {
  description: string;
  assumptions: string[];
  rule_id: string | null;
  related_features: ArtefactRef[];
  source_refs: { journey_ids: Uuid[]; page_ids: Uuid[]; document_ids: Uuid[] };
  acceptance_criteria: AcceptanceCriterion[];
  linked_test_cases: ArtefactRef[];
  status_comment: string | null;
  status_changed_by: UserRef | null;
  status_changed_at: IsoDate | null;
  validation_issues: ValidationIssue[];
  evidence: EvidenceLink[];
  created_at: IsoDate;
  updated_by: UserRef | null;
  /** Not in the contract: the agent's reason for the label (design §5.4 "Why {label}"). Read if present. */
  classification_reason?: string | null;
};

export type RequirementCreate = {
  title: string;
  description: string;
  type: "functional" | "non_functional";
  category: RequirementCategory;
  behaviour_scope: BehaviourScope;
  evidence_refs?: EvidenceRef[];
  assumptions?: string[];
  feature_ids?: Uuid[];
};

export type RequirementPatch = Partial<Omit<RequirementCreate, "evidence_refs">> & { version: number; change_reason?: string | null; evidence_refs?: EvidenceRef[] };

export type RequirementStats = {
  stage_run_version: number | null;
  generated_by: string | null;
  total: number;
  by_classification: Partial<Record<Classification, number>>;
  by_status: Partial<Record<RequirementStatus, number>>;
  by_type: Record<string, number>;
  by_category: Record<string, number>;
  by_source: Record<string, number>;
  without_ac: number;
  locked: number;
  pending_review_version: number | null;
  features_without_requirement: ArtefactRef[];
  acceptance_criteria: { total: number; approved: number; by_kind: Record<string, number> };
};

export type BulkStatusResult = { updated: RequirementSummary[]; skipped: { id: Uuid; key: string; reason: string }[] };

// ---- Readiness (P2-05) -------------------------------------------------------

export type ReadinessEvaluation = {
  criterion_key: string;
  status: "met" | "not_met" | "unknown" | "not_applicable";
  detail: string;
  evidence: ArtefactRef[];
  evaluated_at: IsoDate;
};

export type ReadinessCriterion = Editable & {
  id: Uuid;
  key: string;
  lineage_id: Uuid;
  kind: "dor" | "dod";
  scope: "requirement" | "project";
  text: string;
  status: "active" | "removed";
  check: { rule_id: string; evaluable_from_phase: number } | null;
  evaluation: ReadinessEvaluation | null;
  generated_by: GeneratedBy;
};

export type ReadinessCriteria = {
  stage_run_version: number | null;
  requirements_version: number | null;
  generated_by: string | null;
  definition_of_ready: ReadinessCriterion[];
  definition_of_done: ReadinessCriterion[];
};

// ---- Strategy and risks (P2-06) ----------------------------------------------

export type TestType =
  | "functional"
  | "smoke"
  | "sanity"
  | "regression"
  | "exploratory"
  | "usability"
  | "accessibility"
  | "compatibility"
  | "security"
  | "performance"
  | "load"
  | "stress"
  | "spike"
  | "endurance";
export type TestLevel = "component" | "component_integration" | "system" | "system_integration" | "acceptance";
export type Technique = "equivalence_partitioning" | "boundary_value_analysis" | "decision_table" | "state_transition" | "use_case" | "error_guessing" | "exploratory";
export type RiskLevel = "low" | "medium" | "high" | "very_high";

export type StrategyItem = { text: string; rationale: string | null; evidence_refs?: EvidenceRef[]; related?: ArtefactRef[]; generated_by: GeneratedBy };

export type StrategySections = {
  scope_in: StrategyItem[];
  scope_out: StrategyItem[];
  test_levels: { level: TestLevel; in_scope: boolean; rationale: string }[];
  test_types: { type: TestType; in_scope: boolean; rationale: string; requires_approval: boolean; available_from_phase: number }[];
  techniques_by_feature: { feature: ArtefactRef; techniques: { technique: Technique; rationale: string; evidence_refs: EvidenceRef[] }[] }[];
  risk_based_approach: { level: string; depth: string }[];
  entry_criteria: StrategyItem[];
  exit_criteria: StrategyItem[];
  environments: { name: string; url: string; browsers: string[]; viewports: string[]; auth: "none" | "credentials"; notes: string | null }[];
  test_data_approach: StrategyItem[];
  tools: StrategyItem[];
  assumptions: StrategyItem[];
  constraints: StrategyItem[];
  limitations: StrategyItem[];
};

export type TestStrategy = {
  id: Uuid;
  version: number;
  stage_run_version: number;
  status: "draft" | "awaiting_approval" | "approved" | "stale";
  generated_by: "ai" | "rules" | "mixed" | "human";
  sections: StrategySections;
  human_edited_sections: string[];
  locked_sections: string[];
  approved_input: { requirements_snapshot_hash: string; requirements_version: number };
  plan_status: "current" | "out_of_date" | "not_started";
  validation_issues: ValidationIssue[];
  updated_at: IsoDate;
  updated_by: UserRef | null;
};

export type StrategyVersion = { version: number; stage_run_version: number; status: string; generated_by: string; created_at: IsoDate; approved: boolean };

export type Risk = Provenanced &
  Editable & {
    id: Uuid;
    key: string;
    lineage_id: Uuid;
    title: string;
    description: string;
    category: "product" | "project";
    requirements: ArtefactRef[];
    features: ArtefactRef[];
    likelihood: number;
    impact: number;
    /** likelihood × impact, computed by the server. Never computed in the browser. */
    score: number;
    level: RiskLevel;
    factors: { factor: string; affects: "likelihood" | "impact"; delta: number; evidence_refs: EvidenceRef[] }[];
    likelihood_rationale: string;
    impact_rationale: string;
    mitigation: { test_types: TestType[]; techniques: Technique[]; notes: string | null };
    requires_approval: boolean;
    status: "open" | "mitigated" | "accepted";
    status_comment: string | null;
  };

export type RiskMatrix = { cells: { likelihood: number; impact: number; count: number; risk_keys: string[] }[]; totals: Partial<Record<RiskLevel, number>> };

export type RiskCreate = {
  title: string;
  description: string;
  category?: "product" | "project";
  requirement_ids?: Uuid[];
  feature_ids?: Uuid[];
  likelihood: number;
  impact: number;
  likelihood_rationale: string;
  impact_rationale: string;
  mitigation: { test_types: TestType[]; techniques: Technique[]; notes: string | null };
};

// ---- Test plan (P2-07) -------------------------------------------------------

export type PlanOwnedSection =
  | "introduction"
  | "test_items"
  | "suspension_criteria"
  | "resumption_requirements"
  | "deliverables"
  | "roles"
  | "schedule"
  | "risks_and_contingencies";

export type TestPlanSections = {
  introduction: string;
  test_items: ArtefactRef[];
  scope: Record<string, unknown>;
  approach: Record<string, unknown>;
  environments_and_test_data: Record<string, unknown>;
  entry_exit_criteria: Record<string, unknown>;
  suspension_criteria: string[];
  resumption_requirements: string[];
  deliverables: { name: string; available_from_phase: number; exists: boolean }[];
  roles: { role: string; responsibility: string; assignee: string | null }[];
  schedule: { milestone: string; after_stage: StageKey; target_date: string | null }[];
  risks_and_contingencies: { risk: ArtefactRef; contingency: string }[];
};

export type TestPlan = {
  id: Uuid;
  key: string;
  version: number;
  strategy_version: number;
  stage_run_version: number;
  status: "current" | "out_of_date";
  generated_by: "ai" | "rules" | "mixed" | "human";
  sections: TestPlanSections;
  approvals: { gate: GateKey; status: string; decided_by: UserRef | null; decided_at: IsoDate | null }[];
  human_edited_sections: PlanOwnedSection[];
  rules_template_sections: PlanOwnedSection[];
  note: string | null;
  updated_at: IsoDate;
  updated_by: UserRef | null;
};

export type TestPlanVersion = { version: number; strategy_version: number; source: "derived" | "edited" | "regenerated"; note: string | null; created_by: UserRef | null; created_at: IsoDate };

// ---- Source documents (P2-08) -------------------------------------------------

export type SourceDocument = {
  id: Uuid;
  key: string;
  title: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  status: "extracting" | "ready" | "failed" | "withdrawn";
  pages: number | null;
  chars: number | null;
  sections: number | null;
  statements_found: number | null;
  injection_flags: number;
  error: string | null;
  uploaded_by: UserRef;
  created_at: IsoDate;
  withdrawn_at: IsoDate | null;
};

export type SourceDocumentDetail = SourceDocument & {
  outline: { anchor: string; heading: string; page: number | null }[];
  injection_findings: { anchor: string; excerpt: string }[];
  file: EvidenceLink;
  text: EvidenceLink;
  cited_by: ArtefactRef[];
};

// ---- Assistant (P2-10) --------------------------------------------------------

export type AssistantIntent =
  | "help"
  | "workflow_status"
  | "needs_attention"
  | "coverage_summary"
  | "list_requirements"
  | "explain_requirement"
  | "explain_gate"
  | "list_access_gaps"
  | "risk_summary"
  | "execution_results"
  | "propose_negative_criteria"
  | "propose_risk_reassessment"
  | "propose_regenerate"
  | "propose_requirement_update"
  | "propose_missing_requirements"
  | "propose_risk_update";

export type AssistantMessageCreate = { content?: string | null; intent?: AssistantIntent | null; params?: Record<string, unknown>; context?: ArtefactRef | null };

export type AssistantCapabilities = {
  ai_enabled: boolean;
  model: string | null;
  free_form: boolean;
  intents: {
    intent: AssistantIntent;
    label: string;
    example: string;
    params_schema: Record<string, unknown>;
    creates_proposal: boolean;
    requires_ai: boolean;
    available: boolean;
    requires_role: "viewer" | "member";
  }[];
  later_phase_tasks: { label: string; available_from_phase: number; needs: string }[];
  notice: string | null;
};

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale" | "failed";

export type Proposal = {
  id: Uuid;
  key: string;
  kind: "add_acceptance_criteria" | "update_requirement" | "add_requirement" | "reassess_risks" | "update_risk" | "regenerate_stage";
  target: ArtefactRef | null;
  summary: string;
  payload: Record<string, unknown>;
  preview: { field: string; from: unknown; to: unknown }[] | AcceptanceCriterionCreate[] | null;
  base_versions: Record<string, number>;
  status: ProposalStatus;
  generated_by: "ai" | "rules";
  created_by: UserRef;
  created_at: IsoDate;
  decided_by: UserRef | null;
  decided_at: IsoDate | null;
  decision_comment: string | null;
  result: { applied: ArtefactRef[]; error: string | null } | null;
};

export type AssistantNoticeCode = "ai_unavailable" | "built_in_answer" | "unresolved_citation" | "no_execution_data" | "untrusted_content" | "partial_answer";

export type AssistantMessage = {
  id: Uuid;
  thread_id: Uuid;
  role: "user" | "assistant";
  content: string;
  intent: AssistantIntent | null;
  answered_by: "intent" | "ai" | null;
  generated_by: "ai" | "rules" | null;
  citations: ArtefactRef[];
  proposals: Proposal[];
  notices: { code: AssistantNoticeCode; message: string }[];
  created_at: IsoDate;
  /** Not in the contract: data versions the answer used ("Scan 3 · Requirements v5"). Read if present. */
  data_versions?: Partial<Record<StageKey, number>> | null;
  /** Not in the contract: up to 3 follow-up tasks. Read if present. */
  follow_ups?: { label: string; intent: AssistantIntent; params?: Record<string, unknown> }[] | null;
};

export type AssistantTurn = { user_message: AssistantMessage; reply: AssistantMessage };

export type ThreadSummary = { id: Uuid; title: string; created_at: IsoDate; updated_at?: IsoDate; pending_proposals?: number };

export type Thread = ThreadSummary & { messages: AssistantMessage[] };

// ---- Phase 2 report content (P2-09) ------------------------------------------------

export type ReportApproval = { gate?: GateKey | null; status?: string; approved_by?: UserRef | null; approved_at?: IsoDate | null } | Record<string, unknown>;

export type RequirementsSpecContent = {
  project: Record<string, unknown>;
  generated_at: IsoDate;
  approval: ReportApproval;
  scope_and_method: string[];
  classification_legend: Partial<Record<Classification, string>>;
  counts: RequirementStats;
  requirements_by_category: Record<string, { requirement: RequirementDetail }[]>;
  readiness: ReadinessCriteria;
  open_questions: ArtefactRef[];
  source_documents: SourceDocument[];
  limitations: string[];
  summary: string;
  summary_generated_by: "ai" | "rules";
  disclaimer: string;
};

export type TestStrategyReportContent = {
  project: Record<string, unknown>;
  generated_at: IsoDate;
  approval: ReportApproval;
  strategy: TestStrategy;
  risks: Risk[];
  risk_matrix: RiskMatrix;
  summary: string;
  summary_generated_by: "ai" | "rules";
  approvals_note: string;
};

export type TestPlanReportContent = { project: Record<string, unknown>; generated_at: IsoDate; approval: ReportApproval; plan: TestPlan; strategy_version: number };
