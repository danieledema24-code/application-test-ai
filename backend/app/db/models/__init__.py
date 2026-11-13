"""All ORM models; importing this module registers every table on `Base.metadata`."""

from app.db.models.agents import AgentEvent, AgentTask, Job, WorkerHeartbeat
from app.db.models.assistant import AssistantMessage, AssistantProposal, AssistantThread, SourceDocument
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
from app.db.models.requirements import (
    AcceptanceCriterion,
    EntityRevision,
    ReadinessCriterion,
    Requirement,
    requirement_features,
)
from app.db.models.strategy import Risk, TestPlan, TestStrategy, risk_features, risk_requirements

__all__ = [
    "AcceptanceCriterion",
    "AgentEvent",
    "AgentTask",
    "ApplicationFeature",
    "AssistantMessage",
    "AssistantProposal",
    "AssistantThread",
    "AuditLog",
    "DiscoveredPage",
    "EntityRevision",
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
    "ReadinessCriterion",
    "Requirement",
    "Risk",
    "ScanSession",
    "SourceDocument",
    "StageRun",
    "TestPlan",
    "TestStrategy",
    "User",
    "UserJourney",
    "UserSession",
    "WorkerHeartbeat",
    "WorkflowStage",
    "feature_pages",
    "requirement_features",
    "risk_features",
    "risk_requirements",
]
