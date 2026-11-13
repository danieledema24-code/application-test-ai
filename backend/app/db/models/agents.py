"""Agent tasks, agent events (the event bus), durable jobs, worker heartbeats."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedMixin, IdMixin, TenantMixin, TimestampMixin
from app.db.types import BigIntPK, UTCDateTime, json_default_dict, str_enum, utcnow
from app.domain.enums import EventLevel, JobStatus, TaskStatus


class AgentTask(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "agent_tasks"
    __table_args__ = (Index("ix_agent_tasks_project_created", "project_id", "created_at"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None
    )
    agent_key: Mapped[str] = mapped_column(String(32))
    status: Mapped[TaskStatus] = mapped_column(str_enum(TaskStatus, "task_status"), default=TaskStatus.queued)
    input: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    output_ref: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    error: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    llm: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), default=None, unique=True)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    heartbeat_at: Mapped[datetime | None] = mapped_column(default=None)


class AgentEvent(TenantMixin, Base):
    """User-visible event log; the monotonic id is the SSE cursor."""

    __tablename__ = "agent_events"
    __table_args__ = (
        Index("ix_agent_events_project_id", "project_id", "id"),
        Index("ix_agent_events_org_id", "organisation_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    agent_task_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    stage_key: Mapped[str | None] = mapped_column(String(32), default=None)
    agent_key: Mapped[str | None] = mapped_column(String(32), default=None)
    type: Mapped[str] = mapped_column(String(48))
    level: Mapped[EventLevel] = mapped_column(str_enum(EventLevel, "event_level"), default=EventLevel.info)
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Job(IdMixin, TimestampMixin, Base):
    """Durable queue row. Has organisation_id but is infrastructure: the worker claims across organisations and
    rebuilds the tenant scope from this row (never from payload content)."""

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_run_after", "status", "run_after"),)

    kind: Mapped[str] = mapped_column(String(32))
    organisation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organisations.id", ondelete="RESTRICT"), index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), default=None)
    payload: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    status: Mapped[JobStatus] = mapped_column(str_enum(JobStatus, "job_status"), default=JobStatus.queued)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), default=None, unique=True)
    concurrency_group: Mapped[str | None] = mapped_column(String(32), default=None)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    run_after: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    locked_by: Mapped[str | None] = mapped_column(String(100), default=None)
    locked_at: Mapped[datetime | None] = mapped_column(default=None)
    heartbeat_at: Mapped[datetime | None] = mapped_column(default=None)
    cancel_requested: Mapped[bool] = mapped_column(default=False)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)


class WorkerHeartbeat(CreatedMixin, Base):
    __tablename__ = "worker_heartbeats"

    worker_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    mode: Mapped[str] = mapped_column(String(16))
    heartbeat_at: Mapped[datetime] = mapped_column(default=utcnow)
