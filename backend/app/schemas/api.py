"""Request/response DTOs. Field names and casing follow docs/architecture/api-contracts.md exactly (snake_case)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

T = TypeVar("T")

StageKeyT = Literal[
    "intake",
    "discovery",
    "discovery_report",
    "requirements",
    "readiness_criteria",
    "test_strategy",
    "test_design",
    "traceability",
    "automation_assessment",
    "automation",
    "execution",
    "failure_analysis",
    "defects_summary",
    "release_readiness",
    "performance",
]
StageStatusT = Literal[
    "not_started",
    "queued",
    "running",
    "paused",
    "awaiting_approval",
    "approved",
    "changes_requested",
    "completed",
    "failed",
    "stale",
    "cancelled",
]
GateKeyT = Literal["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]
RoleT = Literal["owner", "admin", "member", "viewer"]


class Req(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


class Ok(BaseModel):
    ok: bool = True


class UserRef(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str


class OrganisationOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str


class EvidenceRef(BaseModel):
    evidence_id: uuid.UUID
    selector: str | None = None
    excerpt: str | None = Field(None, max_length=300)
    note: str | None = None


class EvidenceLink(BaseModel):
    id: uuid.UUID
    key: str | None = None
    kind: str
    mime: str
    size: int
    captured_at: datetime
    content_url: str
    viewport: str | None = None
    source_url: str | None = None
    page_id: uuid.UUID | None = None


class EvidenceDetail(EvidenceLink):
    sha256: str
    scan_session_id: uuid.UUID | None = None
    metadata: dict[str, Any] = {}


# ---------------------------------------------------------------- health


class WorkerHealth(BaseModel):
    mode: Literal["inline", "separate", "off"]
    last_heartbeat_s: float | None


class AiHealth(BaseModel):
    enabled: bool
    provider: str | None
    model: str | None


class BrowserHealth(BaseModel):
    available: bool


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    db: bool
    worker: WorkerHealth
    queue_depth: int
    ai: AiHealth
    browser: BrowserHealth
    version: str
    # True only when the dev-only ALLOW_PRIVATE_TARGETS flag is on (never in production): loopback targets such as
    # http://localhost:4100 can be analysed. LAN/link-local addresses stay blocked either way.
    allow_private_targets: bool = False


# ---------------------------------------------------------------- auth


class RegisterRequest(Req):
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=10, max_length=200)
    organisation_name: str = Field(min_length=1, max_length=120)

    @field_validator("full_name", "organisation_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


class LoginRequest(Req):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class AuthResponse(BaseModel):
    token: str
    expires_at: datetime
    user: UserRef
    organisation: OrganisationOut
    role: RoleT


class MeResponse(BaseModel):
    user: UserRef
    organisation: OrganisationOut
    role: RoleT
    can_approve: bool


class ForgotPasswordRequest(Req):
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    ok: bool = True
    dev_reset_link: str | None = None


class ResetPasswordRequest(Req):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=10, max_length=200)


# ---------------------------------------------------------------- url check + projects


class UrlCheckRequest(Req):
    url: str = Field(max_length=2048)


class RedirectHop(BaseModel):
    url: str
    status: int


class TlsInfo(BaseModel):
    valid: bool
    error: str | None = None


class RobotsInfo(BaseModel):
    found: bool
    disallows_start: bool


class ProjectRef(BaseModel):
    id: uuid.UUID
    name: str


class UrlCheckResult(BaseModel):
    input_url: str
    normalised_url: str
    allowed: bool
    blocked_reason: str | None
    reachable: bool
    http_status: int | None
    final_url: str | None
    redirects: list[RedirectHop]
    cross_site_redirect: bool
    tls: TlsInfo | None
    content_type: str | None
    robots: RobotsInfo | None
    checked_at: datetime
    # Additive (see api-contracts.md "Phase 1 additions"):
    blocked_code: str | None = None
    blocked_ip: str | None = None
    unreachable_code: str | None = None
    unreachable_reason: str | None = None
    title: str | None = None
    resolved_ips: list[str] = []
    requires_auth: bool = False
    bot_protection: bool = False
    existing_project: ProjectRef | None = None
    # Convenience aliases the web client reads (derived, never set by callers):
    resolved_ip: str | None = None  # the blocked address, else the first resolved address
    page_title: str | None = None  # same as `title`
    error: str | None = None  # same as `unreachable_reason`

    @model_validator(mode="after")
    def _aliases(self) -> UrlCheckResult:
        self.resolved_ip = self.blocked_ip or (self.resolved_ips[0] if self.resolved_ips else None)
        self.page_title = self.title
        self.error = self.unreachable_reason
        return self


class ScanSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_pages: int = Field(30, ge=1, le=100)
    max_depth: int = Field(3, ge=0, le=5)
    include_mobile: bool = True
    respect_robots: bool = True


class AuthorisationAttestation(Req):
    attested: Literal[True]
    statement: str = Field(min_length=10, max_length=500)


class CredentialsInput(Req):
    login_url: str | None = Field(None, max_length=2048)
    username: str | None = Field(None, max_length=320)
    password: str | None = Field(None, max_length=500)


class ProjectCreate(Req):
    url: str = Field(max_length=2048)
    name: str | None = Field(None, max_length=120)
    description: str = Field("", max_length=2000)
    authorisation: AuthorisationAttestation
    scan: ScanSettings = ScanSettings()
    start: bool = True
    confirm_duplicate: bool = Field(False, validation_alias=AliasChoices("confirm_duplicate", "confirmDuplicate"))
    credentials: CredentialsInput | None = None


class ProjectPatch(Req):
    version: int
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=2000)
    approval_policy: dict[str, str] | None = None
    settings: ScanSettings | None = None


class ProjectSummary(BaseModel):
    id: uuid.UUID
    name: str
    primary_url: str
    status: Literal["active", "paused", "archived"]
    current_stage: StageKeyT | None
    current_stage_status: StageStatusT | None
    pages_discovered: int
    awaiting_approval: bool
    updated_at: datetime
    # Additive:
    access_gaps: int = 0
    scans: int = 0
    current_activity: str | None = None


class ProjectUrlOut(BaseModel):
    id: uuid.UUID
    url: str
    role: str
    allowed_hosts: list[str]
    authorisation_status: str
    authorised_by: UserRef | None
    authorised_at: datetime | None
    last_check: UrlCheckResult | None
    authorisation_statement: str | None = None
    has_credentials: bool = False
    login_url: str | None = None


class ProjectDetail(ProjectSummary):
    description: str
    version: int
    urls: list[ProjectUrlOut]
    approval_policy: dict[GateKeyT, Literal["required", "recommended", "auto"]]
    locked_gates: list[GateKeyT]
    settings: ScanSettings
    created_at: datetime
    created_by: UserRef


# ---------------------------------------------------------------- workflow


class GateRecommendation(BaseModel):
    recommend: Literal["proceed", "proceed_with_caution", "do_not_proceed"]
    reasons: list[str]
    generated_by: Literal["ai", "rules"]


class GateState(BaseModel):
    key: GateKeyT
    policy: str
    status: str
    recommendation: GateRecommendation | None
    title: str = ""
    decision: GateDecisionOut | None = None


class StageProgress(BaseModel):
    done: int
    total: int | None
    label: str
    # Discovery only (additive):
    screenshots: int | None = None
    queued: int | None = None  # pages waiting in the crawl frontier
    queue_position: int | None = None  # position in the organisation's scan queue while waiting for a worker


class StageState(BaseModel):
    key: StageKeyT
    title: str
    phase: int
    available: bool
    status: StageStatusT
    current_version: int | None
    gate: GateState | None
    started_at: datetime | None
    finished_at: datetime | None
    stale_reason: str | None
    progress: StageProgress | None
    partial: bool = False
    error: str | None = None


class Workflow(BaseModel):
    project_status: Literal["active", "paused", "archived"]
    stages: list[StageState]


class StageRunRequest(Req):
    reason: str | None = Field(None, max_length=500)
    parameters: dict[str, Any] | None = None


class GateDecisionRequest(Req):
    decision: Literal["approve", "reject", "request_changes"]
    comment: str = Field("", max_length=2000)
    stage_run_version: int


class GateDecisionOut(BaseModel):
    id: uuid.UUID
    gate_key: GateKeyT
    decision: str
    comment: str
    decided_by: UserRef | None
    created_at: datetime
    decided_at: datetime | None = None  # same instant as created_at (decisions are immutable)
    gate: GateKeyT | None = None  # same as gate_key
    stage_run_version: int | None = None
    agent_recommendation: dict[str, Any] | None = None


class ValidationIssueOut(BaseModel):
    severity: str
    code: str
    message: str
    path: str | None = None


class StageRunSummary(BaseModel):
    version: int
    status: str
    generated_by: str | None
    partial: bool
    started_at: datetime | None
    finished_at: datetime | None
    triggered_by: UserRef | None
    created_at: datetime


class StageRunDetail(BaseModel):
    version: int
    status: str
    generated_by: str | None
    partial: bool
    upstream_versions: dict[str, int]
    validation_issues: list[ValidationIssueOut]
    output: dict[str, Any]
    decisions: list[GateDecisionOut]
    parameters: dict[str, Any] = {}
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


# ---------------------------------------------------------------- scans


class ScanStats(BaseModel):
    pages: int = 0
    forms: int = 0
    inputs: int = 0
    buttons: int = 0
    links: int = 0
    tables: int = 0
    modals: int = 0
    search: int = 0
    filters: int = 0
    console_errors: int = 0
    failed_requests: int = 0
    blocked_requests: int = 0
    # Additive:
    pages_failed: int = 0
    dropdowns: int = 0
    tabs: int = 0
    pagination: int = 0
    components: int = 0
    screenshots: int = 0
    queued: int = 0
    access_gaps: int = 0
    elapsed_s: int = 0


class CompletenessOut(BaseModel):
    score: int
    rating: Literal["good", "partial", "limited"]
    reasons: list[str]
    checks: list[dict[str, str]] = []


class AuthBoundary(BaseModel):
    url: str
    kind: Literal["login_form", "http_401", "http_403", "redirect_to_login"]
    evidence_refs: list[EvidenceRef]
    login_url: str | None = None


class AccessGap(BaseModel):
    description: str
    suggestion: str
    area: str = ""
    reason: str = ""
    evidence_refs: list[EvidenceRef] = []


class BlockedRequest(BaseModel):
    url: str
    reason: str


class CurrentPage(BaseModel):
    url: str
    title: str
    screenshot: EvidenceLink | None = None


class ScanSummary(BaseModel):
    id: uuid.UUID
    key: str
    status: Literal["queued", "running", "paused", "completed", "partial", "failed", "cancelled"]
    start_url: str
    pages_found: int
    started_at: datetime | None
    finished_at: datetime | None
    # Additive:
    number: int
    stage_run_version: int | None = None
    created_at: datetime | None = None
    is_latest: bool = False


class InjectionFlag(BaseModel):
    page_url: str
    excerpt: str
    evidence_refs: list[EvidenceRef]


class ScanDetail(ScanSummary):
    limits: ScanSettings
    stats: ScanStats
    completeness: CompletenessOut | None
    auth_boundaries: list[AuthBoundary]
    access_gaps: list[AccessGap]
    limitations: list[str]
    blocked_requests: list[BlockedRequest]
    current: CurrentPage | None
    error: str | None
    # Additive:
    summary: str | None = None
    summary_generated_by: str | None = None
    skipped_links: list[dict[str, str]] = []
    external_links: list[str] = []
    not_visited: list[str] = []
    # Why discovery ended: page_limit | exhausted | cancelled | timeout | paused | failed (null while running)
    stop_reason: str | None = None
    # True for cancelled, time-limited, failed or page-limited scans (unvisited frontier); null while running.
    partial: bool | None = None
    injection_flags: list[InjectionFlag] = []
    robots: dict[str, Any] | None = None
    queue_position: int | None = None
    gate: GateState | None = None
    project_id: uuid.UUID | None = None


class FieldConstraintsOut(BaseModel):
    min: str | None = None
    max: str | None = None
    maxlength: int | None = None
    pattern: str | None = None
    minlength: int | None = None


class FormFieldOut(BaseModel):
    name: str
    type: str
    label: str
    required: bool
    placeholder: str | None
    constraints: FieldConstraintsOut
    options: list[str] | None
    locator: str


class FormOut(BaseModel):
    name: str | None
    method: str
    action: str
    purpose_guess: str
    submit_label: str | None
    fields: list[FormFieldOut]
    locator: str = ""
    evidence_refs: list[EvidenceRef] = []


class ComponentOut(BaseModel):
    kind: Literal[
        "button",
        "link",
        "dropdown",
        "search",
        "filter",
        "table",
        "modal",
        "tabs",
        "accordion",
        "menu",
        "pagination",
        "other",
    ]
    role: str | None
    name: str
    locator: str
    fingerprint: str
    details: dict[str, Any]
    locators: list[str] = []
    evidence_refs: list[EvidenceRef] = []


class PageSummary(BaseModel):
    id: uuid.UUID
    url: str
    title: str
    http_status: int | None
    depth: int
    page_type: str
    requires_auth: bool
    counts: dict[str, int]
    screenshot: EvidenceLink | None
    # Additive:
    path: str = "/"
    status: Literal["visited", "failed", "blocked"] = "visited"
    failure_reason: str | None = None
    found_via: str | None = None
    parent_page_id: uuid.UUID | None = None
    load_ms: int | None = None


class ResponsiveViewport(BaseModel):
    viewport: str
    nav_collapsed: bool
    horizontal_overflow: bool
    screenshot: EvidenceLink | None


class ConsoleIssue(BaseModel):
    level: str
    text: str


class NetworkIssue(BaseModel):
    url: str
    status: int | None
    failure: str | None


class NavLinkOut(BaseModel):
    text: str
    href: str


class PageDetail(PageSummary):
    headings: list[str]
    nav_links: list[NavLinkOut]
    forms: list[FormOut]
    components: list[ComponentOut]
    responsive: dict[str, ResponsiveViewport]
    console_issues: list[ConsoleIssue]
    network_issues: list[NetworkIssue]
    evidence: list[EvidenceLink]
    links: list[str] = []
    scan_id: uuid.UUID | None = None


class SitemapNode(BaseModel):
    path: str
    url: str | None = None
    title: str | None = None
    page_id: uuid.UUID | None = None
    status: Literal["visited", "failed", "blocked", "not_visited", "group", "external"] = "group"
    page_type: str | None = None
    requires_auth: bool = False
    reason: str | None = None
    counts: dict[str, int] = {}
    children: list[SitemapNode] = []


class FeatureOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    description: str
    category: str
    page_ids: list[uuid.UUID]
    provenance: Literal["observed", "inferred", "assumed", "unverified"]
    confidence: float
    evidence_refs: list[EvidenceRef]
    generated_by: Literal["ai", "rules", "human"]
    reason: str | None = None


class JourneyStepOut(BaseModel):
    page_id: uuid.UUID
    action: str
    label: Literal["observed", "inferred"] = "observed"


class JourneyOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    steps: list[JourneyStepOut]
    provenance: Literal["observed", "inferred", "assumed", "unverified"]
    confidence: float
    evidence_refs: list[EvidenceRef]
    generated_by: Literal["ai", "rules", "human"]
    reason: str | None = None


class KnowledgeItemOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    content: str
    provenance: str
    evidence_refs: list[EvidenceRef]
    source: str
    status: str
    version: int
    created_at: datetime


# ---------------------------------------------------------------- reports


class ReportCreate(Req):
    report_type: Literal["discovery"]
    scan_id: uuid.UUID | None = None

    @classmethod
    def allowed_types(cls) -> set[str]:
        return {"discovery"}


class ReportFile(BaseModel):
    format: Literal["pdf", "html", "json"]
    size: int
    sha256: str
    filename: str
    content_url: str


class ReportSummary(BaseModel):
    id: uuid.UUID
    report_type: str
    version: int
    status: Literal["rendering", "ready", "failed"]
    formats: list[str]
    generated_by: str
    created_at: datetime
    # Additive:
    scan_id: uuid.UUID | None = None
    scan_key: str | None = None
    scan_number: int | None = None
    is_latest_scan: bool = True
    approval_status: Literal["draft", "approved", "changes_requested"] = "draft"
    partial: bool = False
    error: str | None = None


class ReportDetail(ReportSummary):
    content: dict[str, Any]
    files: list[ReportFile]
    ai_sections: list[Any] = []


# ---------------------------------------------------------------- events, dashboard


class AgentEventOut(BaseModel):
    id: int
    project_id: uuid.UUID
    stage_key: str | None
    agent_key: str | None
    task_id: uuid.UUID | None
    type: str
    level: str
    message: str
    data: dict[str, Any]
    created_at: datetime


class EventsPage(BaseModel):
    items: list[AgentEventOut]
    next_after: int


class ActivityItem(BaseModel):
    id: int
    project_id: uuid.UUID
    project_name: str
    type: str
    message: str
    level: str
    created_at: datetime
    stage_key: str | None = None


class DashboardWelcome(BaseModel):
    full_name: str
    organisation: str


class DashboardHealth(BaseModel):
    projects_total: int
    scans_running: int
    awaiting_approval: int
    failed_stages: int
    pages_discovered_30d: int
    access_gaps: int = 0


class DashboardAi(BaseModel):
    enabled: bool
    model: str | None


class Dashboard(BaseModel):
    welcome: DashboardWelcome
    recent_projects: list[ProjectSummary]
    activity: list[ActivityItem]
    health: DashboardHealth
    ai: DashboardAi


GateState.model_rebuild()
SitemapNode.model_rebuild()
