"""All ORM models; importing this module registers every table on `Base.metadata`."""

from app.db.models.agents import AgentEvent, AgentTask, Job, WorkerHeartbeat
from app.db.models.discovery import (
    ApplicationFeature,
    DiscoveredPage,
    Evidence,
    KnowledgeItem,
    QaReport,
    ScanSession,
    UserJourney,
    feature_pages,
)
from app.db.models.identity import AuditLog, Membership, Organisation, PasswordResetToken, User, UserSession
from app.db.models.projects import (
    GateDecision,
    Project,
    ProjectCounter,
    ProjectSecret,
    ProjectUrl,
    StageRun,
    WorkflowStage,
)

__all__ = [
    "AgentEvent",
    "AgentTask",
    "ApplicationFeature",
    "AuditLog",
    "DiscoveredPage",
    "Evidence",
    "GateDecision",
    "Job",
    "KnowledgeItem",
    "Membership",
    "Organisation",
    "PasswordResetToken",
    "Project",
    "ProjectCounter",
    "ProjectSecret",
    "ProjectUrl",
    "QaReport",
    "ScanSession",
    "StageRun",
    "User",
    "UserJourney",
    "UserSession",
    "WorkerHeartbeat",
    "WorkflowStage",
    "feature_pages",
]
