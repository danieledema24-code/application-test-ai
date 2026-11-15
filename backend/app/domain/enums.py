"""Domain enums. Stored as String(32) + CHECK constraints (portable across SQLite and PostgreSQL)."""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    owner = "owner"
    admin = "admin"
    member = "member"
    viewer = "viewer"


class ActorType(StrEnum):
    user = "user"
    agent = "agent"
    system = "system"


class ProjectStatus(StrEnum):
    active = "active"
    paused = "paused"
    archived = "archived"


class UrlRole(StrEnum):
    primary = "primary"
    additional = "additional"
    api = "api"


class AuthorisationStatus(StrEnum):
    pending = "pending"
    attested = "attested"
    revoked = "revoked"


class StageKey(StrEnum):
    intake = "intake"
    discovery = "discovery"
    discovery_report = "discovery_report"
    requirements = "requirements"
    readiness_criteria = "readiness_criteria"
    test_strategy = "test_strategy"
    test_design = "test_design"
    traceability = "traceability"
    automation_assessment = "automation_assessment"
    automation = "automation"
    execution = "execution"
    failure_analysis = "failure_analysis"
    defects_summary = "defects_summary"
    release_readiness = "release_readiness"
    performance = "performance"
    # Phase 5 (P5-00): optional branches after G2, never queued by advance().
    accessibility = "accessibility"
    security_assessment = "security_assessment"


class StageStatus(StrEnum):
    not_started = "not_started"
    queued = "queued"
    running = "running"
    paused = "paused"
    awaiting_approval = "awaiting_approval"
    approved = "approved"
    changes_requested = "changes_requested"
    completed = "completed"
    failed = "failed"
    stale = "stale"
    cancelled = "cancelled"


class GateKey(StrEnum):
    G1 = "G1"
    G2 = "G2"
    G3 = "G3"
    G4 = "G4"
    G5 = "G5"
    G6 = "G6"
    G7 = "G7"
    G8 = "G8"
    G9 = "G9"


class GatePolicy(StrEnum):
    required = "required"
    recommended = "recommended"
    auto = "auto"


class GateStatus(StrEnum):
    none = "none"
    pending = "pending"
    recommended = "recommended"
    approved = "approved"
    rejected = "rejected"


class GateDecisionKind(StrEnum):
    approve = "approve"
    reject = "reject"
    request_changes = "request_changes"


class GeneratedBy(StrEnum):
    ai = "ai"
    rules = "rules"
    human = "human"
    mixed = "mixed"


class Provenance(StrEnum):
    observed = "observed"
    inferred = "inferred"
    assumed = "assumed"
    unverified = "unverified"


class ScanStatus(StrEnum):
    queued = "queued"
    running = "running"
    paused = "paused"
    completed = "completed"
    partial = "partial"
    failed = "failed"
    cancelled = "cancelled"


class PageType(StrEnum):
    landing = "landing"
    listing = "listing"
    detail = "detail"
    form = "form"
    auth = "auth"
    search = "search"
    error = "error"
    other = "other"


class PageStatus(StrEnum):
    visited = "visited"
    failed = "failed"
    blocked = "blocked"


class FeatureCategory(StrEnum):
    navigation = "navigation"
    auth = "auth"
    search = "search"
    form = "form"
    content = "content"
    commerce = "commerce"
    account = "account"
    other = "other"


class EvidenceKind(StrEnum):
    screenshot = "screenshot"
    dom_snapshot = "dom_snapshot"
    aria_snapshot = "aria_snapshot"
    console_log = "console_log"
    network_log = "network_log"
    http_response = "http_response"
    page_text = "page_text"
    trace = "trace"
    video = "video"
    k6_summary = "k6_summary"
    axe_result = "axe_result"
    lighthouse_result = "lighthouse_result"
    report_render = "report_render"
    document_file = "document_file"
    document_text = "document_text"
    # Phase 5 (P5-00): load-test summary and one-second time series, observed response headers of a page.
    perf_summary = "perf_summary"
    perf_timeseries = "perf_timeseries"
    security_headers = "security_headers"


class KnowledgeKind(StrEnum):
    fact = "fact"
    glossary = "glossary"
    assumption = "assumption"
    decision = "decision"
    constraint = "constraint"
    user_note = "user_note"


class KnowledgeStatus(StrEnum):
    proposed = "proposed"
    active = "active"
    superseded = "superseded"
    rejected = "rejected"


class ReportType(StrEnum):
    discovery = "discovery"
    requirements_spec = "requirements_spec"
    test_strategy = "test_strategy"
    test_plan = "test_plan"
    test_case_spec = "test_case_spec"
    rtm = "rtm"
    execution = "execution"
    defect = "defect"
    performance = "performance"
    completion = "completion"
    release_readiness = "release_readiness"
    accessibility = "accessibility"
    security = "security"


class ReportStatus(StrEnum):
    rendering = "rendering"
    ready = "ready"
    failed = "failed"


class TaskStatus(StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"
    paused = "paused"


class JobStatus(StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


class EventLevel(StrEnum):
    info = "info"
    warn = "warn"
    error = "error"


# ---------------------------------------------------------------- Phase 2


class ReviewStatus(StrEnum):
    not_required = "not_required"
    pending_review = "pending_review"
    applied = "applied"
    discarded = "discarded"


class BehaviourScope(StrEnum):
    ui = "ui"
    backend = "backend"
    mixed = "mixed"


class RequirementType(StrEnum):
    functional = "functional"
    non_functional = "non_functional"


class RequirementSource(StrEnum):
    discovery = "discovery"
    document = "document"
    user = "user"
    assistant = "assistant"


class RequirementStatus(StrEnum):
    draft = "draft"
    approved = "approved"
    rejected = "rejected"
    needs_info = "needs_info"


class ItemStatus(StrEnum):
    draft = "draft"
    approved = "approved"
    rejected = "rejected"


class AcKind(StrEnum):
    positive = "positive"
    negative = "negative"
    boundary = "boundary"


class ReadinessKind(StrEnum):
    dor = "dor"
    dod = "dod"


class ReadinessScope(StrEnum):
    requirement = "requirement"
    project = "project"


class ReadinessStatus(StrEnum):
    active = "active"
    removed = "removed"


class StrategyStatus(StrEnum):
    draft = "draft"
    awaiting_approval = "awaiting_approval"
    approved = "approved"
    stale = "stale"


class RiskCategory(StrEnum):
    product = "product"
    project = "project"


class RiskLevel(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"
    very_high = "very_high"


class RiskStatus(StrEnum):
    open = "open"
    mitigated = "mitigated"
    accepted = "accepted"


class PlanSource(StrEnum):
    derived = "derived"
    edited = "edited"
    regenerated = "regenerated"


class DocumentStatus(StrEnum):
    extracting = "extracting"
    ready = "ready"
    failed = "failed"
    withdrawn = "withdrawn"


class MessageRole(StrEnum):
    user = "user"
    assistant = "assistant"


class ProposalStatus(StrEnum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"
    stale = "stale"
    failed = "failed"


class SecretKind(StrEnum):
    login_credentials = "login_credentials"


class SignInResult(StrEnum):
    succeeded = "succeeded"
    failed = "failed"
    not_attempted = "not_attempted"


class AuthContext(StrEnum):
    anonymous = "anonymous"
    authenticated = "authenticated"


# ---------------------------------------------------------------- Phase 3: test design and traceability


class Technique(StrEnum):
    equivalence_partitioning = "equivalence_partitioning"
    boundary_value_analysis = "boundary_value_analysis"
    decision_table = "decision_table"
    state_transition = "state_transition"
    use_case = "use_case"
    error_guessing = "error_guessing"
    exploratory = "exploratory"
    # Fixed quality checklists for non-functional cases (labels, overflow, console errors; design P3 open question 4).
    checklist = "checklist"


class CaseStatus(StrEnum):
    draft = "draft"
    approved = "approved"
    rejected = "rejected"
    deprecated = "deprecated"


class Priority(StrEnum):
    critical = "critical"
    high = "high"
    medium = "medium"
    low = "low"


class ExecutionStatus(StrEnum):
    not_run = "not_run"
    passed = "passed"
    failed = "failed"
    blocked = "blocked"
    error = "error"


class CaseSource(StrEnum):
    design = "design"
    user = "user"
    assistant = "assistant"


class ExpectedResultStatus(StrEnum):
    defined = "defined"
    open_question = "open_question"


class AutomationSuitability(StrEnum):
    suitable = "suitable"
    partial = "partial"
    manual_only = "manual_only"


class TestDataKind(StrEnum):
    valid = "valid"
    invalid = "invalid"
    boundary = "boundary"
    secret_ref = "secret_ref"  # noqa: S105 - a reference kind, not a password


class TestDataValueType(StrEnum):
    text = "text"
    email = "email"
    number = "number"
    empty = "empty"
    whitespace = "whitespace"
    secret_ref = "secret_ref"  # noqa: S105 - a reference kind, not a password


class TestDataStatus(StrEnum):
    active = "active"
    retired = "retired"


# ---------------------------------------------------------------- Phase 4: automation, execution, defects


class GateSubjectType(StrEnum):
    """What a per-subject gate decision is about (G7 per run, G8 per defect, G6 per AI-written script)."""

    execution_run = "execution_run"
    defect = "defect"
    automation_script = "automation_script"


class ScriptStatus(StrEnum):
    draft = "draft"
    valid = "valid"
    invalid = "invalid"
    outdated = "outdated"


class AssetKind(StrEnum):
    page_object = "page_object"
    factory = "factory"
    platform = "platform"
    config = "config"


class ScriptGeneratedBy(StrEnum):
    rules = "rules"
    ai = "ai"
    heal = "heal"
    platform = "platform"


class RunMode(StrEnum):
    automated = "automated"
    manual = "manual"


class RunStatus(StrEnum):
    awaiting_authorisation = "awaiting_authorisation"
    rejected = "rejected"
    queued = "queued"
    running = "running"
    passed = "passed"
    failed = "failed"
    error = "error"
    cancelled = "cancelled"


class ResultStatus(StrEnum):
    passed = "passed"
    failed = "failed"
    error = "error"
    skipped = "skipped"
    blocked = "blocked"
    flaky = "flaky"


class FailureClass(StrEnum):
    application_defect = "application_defect"
    script_defect = "script_defect"
    selector_failure = "selector_failure"
    test_data_issue = "test_data_issue"
    environment_failure = "environment_failure"
    network_failure = "network_failure"
    flaky = "flaky"
    unknown = "unknown"


class ApprovalKind(StrEnum):
    destructive = "destructive"
    external_transaction = "external_transaction"
    real_user_data = "real_user_data"
    load_test = "load_test"
    security_test = "security_test"


class ApprovalStatus(StrEnum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    expired = "expired"
    used = "used"


class DefectSeverity(StrEnum):
    critical = "critical"
    major = "major"
    minor = "minor"
    trivial = "trivial"


class DefectStatus(StrEnum):
    draft = "draft"
    confirmed = "confirmed"
    rejected = "rejected"
    fixed = "fixed"
    verified = "verified"
    closed = "closed"


class DefectSource(StrEnum):
    analysis = "analysis"
    user = "user"
    # Phase 5 (P5-00): drafts from non-functional findings (decision D20).
    accessibility = "accessibility"
    security = "security"
    performance = "performance"


# ---------------------------------------------------------------- Phase 5: non-functional testing


class QualityScanKind(StrEnum):
    accessibility = "accessibility"
    security = "security"


class QualityScanStatus(StrEnum):
    queued = "queued"
    running = "running"
    completed = "completed"
    partial = "partial"
    failed = "failed"
    cancelled = "cancelled"


class FindingSeverity(StrEnum):
    """Accessibility uses critical/serious/moderate/minor (axe impact); security uses high/medium/low/info."""

    critical = "critical"
    serious = "serious"
    moderate = "moderate"
    minor = "minor"
    high = "high"
    medium = "medium"
    low = "low"
    info = "info"


class FindingStatus(StrEnum):
    open = "open"
    accepted_risk = "accepted_risk"
    false_positive = "false_positive"
    fixed = "fixed"


class PerfProfileType(StrEnum):
    load = "load"
    stress = "stress"
    spike = "spike"
    soak = "soak"


class PerfProfileStatus(StrEnum):
    draft = "draft"
    ready = "ready"
    stale = "stale"
    retired = "retired"


class PerfRunStatus(StrEnum):
    awaiting_approval = "awaiting_approval"
    rejected = "rejected"
    expired = "expired"
    queued = "queued"
    running = "running"
    passed = "passed"
    failed = "failed"
    stopped = "stopped"
    aborted = "aborted"
    error = "error"
