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
