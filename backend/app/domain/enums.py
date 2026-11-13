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
