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

export type StageGate = {
  key: GateKey;
  policy: string;
  status: string;
  recommendation: GateRecommendation | null;
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
};

export type Workflow = { project_status: ProjectStatus; stages: StageState[] };

/** Assumed: the contract references GateDecision without defining it. */
export type GateDecision = {
  gate?: GateKey;
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

export type ReportDetail = ReportSummary & { content: DiscoveryReportContent | null };

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
