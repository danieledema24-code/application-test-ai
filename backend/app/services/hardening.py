"""Phase 5 hardening (P5-05b/c, decision D23): audit log reading and export, evidence retention, and project deletion
scheduling. Audit rows stay append-only (threat T9): this module only reads them, and every export is itself recorded.
"""

from __future__ import annotations

import contextlib
import csv
import io
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import Select, Table, false, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import AuditLog, Evidence, Organisation, Project, User
from app.db.tenant import bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import EvidenceKind

log = logging.getLogger(__name__)

EXPORT_LIMIT = 100_000
PURGE_DELAY = timedelta(hours=24)

# ------------------------------------------------------------------ audit log (design P5 §13.3)

# Plain labels for the actions; the code stays in the export and the tooltip.
ACTION_LABEL: dict[str, str] = {
    "gate.approved": "Approved a gate",
    "gate.reopened": "Reopened a gate",
    "performance_run.requested": "Requested a load test",
    "performance_run.approved": "Approved a load test",
    "performance_run.rejected": "Refused a load test",
    "performance_run.started": "Load test started",
    "performance_run.stopped": "Stopped a load test",
    "performance_run.withdrawn": "Withdrew a load test request",
    "quality_scan.started": "Started a check",
    "quality_scan.finished": "A check finished",
    "quality_finding.triaged": "Triaged a finding",
    "defect.created": "Raised a defect",
    "defect.updated": "Changed a defect",
    "report.downloaded": "Downloaded a report",
    "report.generated": "Generated a report",
    "audit_log.exported": "Exported the audit log",
    "load_ceiling.changed": "Changed load limits",
    "retention.changed": "Changed retention",
    "retention.applied": "Retention removed files",
    "member.invited": "Invited a member",
    "member.role_changed": "Changed a member's role",
    "member.removed": "Removed a member",
    "project.created": "Created a project",
    "project.archived": "Archived a project",
    "project.unarchived": "Unarchived a project",
    "project.purge_scheduled": "Scheduled a project deletion",
    "project.purge_cancelled": "Cancelled a project deletion",
    "project.purged": "Deleted a project permanently",
    "auth.login": "Signed in",
    "auth.logout": "Signed out",
}

ACTION_GROUPS: dict[str, tuple[str, ...]] = {
    "Gates": ("gate.",),
    "Approvals and load tests": ("approval.", "performance_run.", "performance_profile.", "load_ceiling."),
    "Checks": ("quality_scan.", "quality_finding."),
    "Defects": ("defect.",),
    "Reports": ("report.", "document.", "audit_log."),
    "Settings and members": ("member.", "invitation.", "organisation.", "retention.", "secret."),
    "Projects": ("project.",),
}


def action_label(action: str) -> str:
    return ACTION_LABEL.get(action) or action.replace("_", " ").replace(".", ": ").capitalize()


def details_text(row: AuditLog) -> str:
    """Short details line. Never the typed host text, secrets or tokens (metadata is redacted on insert)."""
    m = row.meta or {}
    parts = [str(m[k]) for k in ("key", "approval", "filename", "kind", "changes") if m.get(k)]
    if row.action == "retention.applied" and "files" in m:
        n = int(m["files"] or 0)
        parts.append(f"{n} file{'' if n == 1 else 's'} removed")
    if "host_typed" in m:
        parts.append(f"host typed: {'yes' if m.get('host_typed') in (True, 'yes') else 'no'}")
    return " · ".join(parts)


def audit_query(
    org_id: uuid.UUID,
    *,
    actor: uuid.UUID | None = None,
    group: str | None = None,
    action: str | None = None,
    project: uuid.UUID | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> Select[AuditLog]:
    q = select(AuditLog).where(AuditLog.organisation_id == org_id)
    if actor:
        q = q.where(AuditLog.actor_user_id == actor)
    if action:
        q = q.where(AuditLog.action == action)
    elif group:
        from sqlalchemy import or_

        prefixes = ACTION_GROUPS.get(group) or ()
        q = q.where(or_(*[AuditLog.action.startswith(p) for p in prefixes])) if prefixes else q.where(false())
    if project:
        q = q.where(AuditLog.project_id == project)
    if since:
        q = q.where(AuditLog.created_at >= since)
    if until:
        q = q.where(AuditLog.created_at < until)
    return q


async def count(s: AsyncSession, q: Select[AuditLog]) -> int:
    return int((await s.execute(select(func.count()).select_from(q.subquery()))).scalar_one())


async def rows_out(s: AsyncSession, rows: list[AuditLog], *, see_email: bool) -> list[dict[str, Any]]:
    users = {
        u.id: u
        for u in (
            await s.execute(select(User).where(User.id.in_({r.actor_user_id for r in rows if r.actor_user_id})))
        ).scalars()
    }
    projects = {
        p.id: p.name
        for p in (
            await s.execute(select(Project).where(Project.id.in_({r.project_id for r in rows if r.project_id})))
        ).scalars()
    }
    out = []
    for r in rows:
        u = users.get(r.actor_user_id) if r.actor_user_id else None
        out.append(
            {
                "id": r.id,
                "at": r.created_at,
                "who": {"name": u.full_name, "email": u.email if see_email else None} if u else None,
                "actor_type": r.actor_type.value,
                "action": r.action,
                "label": action_label(r.action),
                "project": {"id": r.project_id, "name": projects.get(r.project_id)} if r.project_id else None,
                "details": details_text(r),
                "target_type": r.target_type,
            }
        )
    return out


def export_bytes(items: list[dict[str, Any]], fmt: str) -> bytes:
    if fmt == "json":
        return json.dumps(items, indent=2, default=str).encode("utf-8")
    from app.agents.reporting.phase3_reports import safe_cell

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(["When", "Who", "Email", "Action", "What", "Project", "Details"])
    for x in items:
        who = x["who"] or {}
        w.writerow(
            [
                safe_cell(v)
                for v in (
                    x["at"].isoformat() if isinstance(x["at"], datetime) else x["at"],
                    who.get("name") or x["actor_type"],
                    who.get("email") or "",
                    x["action"],
                    x["label"],
                    (x["project"] or {}).get("name") or "",
                    x["details"],
                )
            ]
        )
    return ("﻿" + buf.getvalue()).encode("utf-8")


# ------------------------------------------------------------------ retention (design P5 §13.4)

RETENTION_KINDS: dict[str, tuple[EvidenceKind, ...]] = {
    "videos_traces_days": (EvidenceKind.video, EvidenceKind.trace),
    "screenshots_days": (EvidenceKind.screenshot,),
    "timeseries_days": (EvidenceKind.perf_timeseries,),
}
DEFAULT_RETENTION = {"videos_traces_days": 30, "screenshots_days": 90, "timeseries_days": 90}


def retention_of(org: Organisation) -> tuple[dict[str, int], bool]:
    """(days per kind, saved). Nothing is removed until an owner or admin saves a policy (assumption: the
    defaults are a suggestion, so a restart never deletes files nobody chose to remove)."""
    saved = (org.settings or {}).get("retention")
    return ({**DEFAULT_RETENTION, **saved} if saved else dict(DEFAULT_RETENTION)), bool(saved)


RETENTION_LABEL = {"videos_traces_days": "videos and traces", "screenshots_days": "screenshots",
                   "timeseries_days": "load test time series"}  # fmt: skip


def _days(n: int) -> str:
    return "forever" if n == 0 else f"{n} day{'' if n == 1 else 's'}"


def retention_changes(before: dict[str, int], new: dict[str, int]) -> str:
    """ "screenshots 90 days → 30 days", only for what changed ("" when nothing did)."""
    return ", ".join(
        f"{RETENTION_LABEL[k]} {_days(before[k])} → {_days(v)}" for k, v in new.items() if before.get(k) != v
    )


def retention_text(days: dict[str, int]) -> str:
    return ", ".join(f"{RETENTION_LABEL[k]} {_days(v)}" for k, v in days.items())


def removed_text(purged_at: datetime) -> str:
    return f"Removed by the retention policy on {purged_at.day} {purged_at:%b %Y}."


async def apply_retention(
    ctx: AppContext, org_id: uuid.UUID, *, now: datetime | None = None, actor: uuid.UUID | None = None
) -> int:
    """Removes the stored files of evidence older than the organisation's policy and marks the rows `purged_at`.
    The row (what it was, when, its checksum) stays. Report files and the audit log are never touched."""
    now = now or utcnow()
    removed = 0
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(org_id))
        org = await s.get(Organisation, org_id)
        if org is None:
            return 0
        days, saved = retention_of(org)
        if not saved and actor is None:
            return 0
        for field, kinds in RETENTION_KINDS.items() if saved else ():
            n = int(days.get(field) or 0)
            if n <= 0:
                continue
            q = select(Evidence).where(
                Evidence.organisation_id == org_id,
                Evidence.kind.in_(kinds),
                Evidence.purged_at.is_(None),
                Evidence.captured_at < now - timedelta(days=n),
            )
            for ev in (await s.execute(q)).scalars():
                with contextlib.suppress(FileNotFoundError):
                    await ctx.storage.delete(ev.storage_key)
                ev.purged_at = now
                removed += 1
                if ev.kind == EvidenceKind.perf_timeseries and ev.performance_run_id is not None:
                    removed += await _remove_timeseries(ctx, s, ev.performance_run_id, now)
        if removed or actor is not None:  # a person's "Apply now" is recorded even when it removes nothing
            from app.services.audit import audit

            # The daily job is the system; "Apply now" is the person who clicked it.
            audit(s, org_id=org_id, action="retention.applied", target_type="organisation", target_id=org_id,
                  actor_user_id=actor, metadata={"files": removed})  # fmt: skip
        await s.commit()
    return removed


async def _remove_timeseries(ctx: AppContext, s: AsyncSession, run_id: uuid.UUID, now: datetime) -> int:
    """P5-BUG-08: a load test's per-second series lives in the run row and in its report's time-series CSV as well
    as in the evidence file; retention removes all three. Returns the number of report files removed."""
    from app.db.models import PerformanceRun, QaReport
    from app.domain.enums import ReportType

    run = await s.get(PerformanceRun, run_id)
    if run is None:
        return 0
    metrics = dict(run.metrics or {})
    metrics.pop("live_series", None)
    metrics["timeseries"] = []
    metrics["timeseries_removed_at"] = now.isoformat()
    run.metrics = metrics
    files = 0
    reports = (
        await s.execute(
            select(QaReport).where(
                QaReport.project_id == run.project_id, QaReport.report_type == ReportType.performance
            )
        )
    ).scalars()
    for r in reports:
        if (r.source_versions or {}).get("run_key") != run.key:
            continue
        for f in r.files or []:
            if f.get("format") != "csv_timeseries" or not f.get("evidence_id"):
                continue
            ev = await s.get(Evidence, uuid.UUID(str(f["evidence_id"])))
            if ev is None or ev.purged_at is not None:
                continue
            with contextlib.suppress(FileNotFoundError):
                await ctx.storage.delete(ev.storage_key)
            ev.purged_at = now
            files += 1
    return files


async def apply_retention_all(ctx: AppContext) -> int:
    """The daily clean-up: every organisation with a saved policy."""
    from app.db.tenant import BYPASS

    async with ctx.session_factory() as s:
        ids = [o.id for o in (await s.execute(select(Organisation).execution_options(**BYPASS))).scalars()]
    total = 0
    for oid in ids:
        try:
            total += await apply_retention(ctx, oid)
        except Exception:  # one organisation's failure doesn't stop the others
            log.exception("retention clean-up failed for an organisation")
    return total


# ------------------------------------------------------------------ scheduled project deletion (design P5 §13.5)


def _purge_plan() -> list[tuple[Table, Any]]:
    """(table, how to select this project's rows) for every table holding project data, children first.

    Tables with a `project_id` column are matched on it; link tables without one (feature_pages, requirement_features,
    ...) are matched through their foreign key to a table that has one. `projects` and `audit_logs` are left out:
    the audit log is the record that stays (its `project_id` has no foreign key)."""
    from app.db.base import Base

    plan: list[tuple[Table, Any]] = []
    for t in reversed(Base.metadata.sorted_tables):
        if t.name in ("projects", "audit_logs"):
            continue
        if "project_id" in t.c:
            plan.append((t, ("project_id", None)))
            continue
        for fk in t.foreign_keys:
            parent = fk.column.table
            if "project_id" in parent.c and parent.name != "projects":
                plan.append((t, (fk.parent.name, parent)))
                break
    return plan


async def purge_project(ctx: AppContext, project_id: uuid.UUID, *, now: datetime | None = None) -> bool:
    """Deletes an archived project whose scheduled deletion time has passed: every row of the project and every stored
    file, keeping only the audit log (plus one `project.purged` entry). Returns False and leaves everything when the
    project isn't due, was unarchived or cancelled, or still has a queued or running job (the next pass retries)."""
    from sqlalchemy import delete

    from app.db.models import Job
    from app.db.tenant import BYPASS
    from app.domain.enums import ActorType, JobStatus
    from app.services.audit import audit

    now = now or utcnow()
    async with ctx.session_factory() as s:
        project = (
            await s.execute(select(Project).where(Project.id == project_id).execution_options(**BYPASS))
        ).scalar_one_or_none()
        if project is None or project.archived_at is None or project.purge_scheduled_at is None:
            return False
        if project.purge_scheduled_at > now:
            return False
        busy = (
            await s.execute(
                select(Job.id)
                .where(Job.project_id == project_id, Job.status.in_([JobStatus.queued, JobStatus.running]))
                .execution_options(**BYPASS)
            )
        ).first()
        if busy is not None:
            return False
        org_id, name, requested_by = project.organisation_id, project.name, project.purge_requested_by
        bind_scope(s, system_scope(org_id))
        keys = list(
            (
                await s.execute(
                    select(Evidence.storage_key).where(Evidence.project_id == project_id).execution_options(**BYPASS)
                )
            ).scalars()
        )
        rows = 0
        for table, (col, parent) in _purge_plan():
            if parent is None:
                stmt = delete(table).where(table.c[col] == project_id)
            else:
                stmt = delete(table).where(
                    table.c[col].in_(select(parent.c.id).where(parent.c.project_id == project_id))
                )
            res = await s.execute(stmt.execution_options(**BYPASS))
            rows += max(int(getattr(res, "rowcount", 0) or 0), 0)
        await s.execute(delete(Project).where(Project.id == project_id).execution_options(**BYPASS))
        requester = await s.get(User, requested_by) if requested_by else None
        audit(s, org_id=org_id, action="project.purged", target_type="project", target_id=project_id,
              actor_type=ActorType.system, project_id=project_id,
              metadata={"name": name, "rows": rows, "files": len(keys),
                        "requested_by": requester.full_name if requester else None})  # fmt: skip
        await s.commit()
    for key in keys:
        with contextlib.suppress(Exception):
            await ctx.storage.delete(key)
    with contextlib.suppress(Exception):
        await ctx.storage.delete_prefix(f"{org_id}/{project_id}")
    log.info("project purged", extra={"project_id": str(project_id), "rows": rows, "files": len(keys)})
    return True


async def purge_due(ctx: AppContext, *, now: datetime | None = None) -> int:
    """The worker's pass: every archived project whose deletion time has passed."""
    from app.db.tenant import BYPASS

    now = now or utcnow()
    async with ctx.session_factory() as s:
        due = list(
            (
                await s.execute(
                    select(Project.id)
                    .where(
                        Project.purge_scheduled_at.is_not(None),
                        Project.purge_scheduled_at <= now,
                        Project.archived_at.is_not(None),
                    )
                    .execution_options(**BYPASS)
                )
            ).scalars()
        )
    done = 0
    for pid in due:
        try:
            done += int(await purge_project(ctx, pid, now=now))
        except Exception:  # one project's failure doesn't stop the others; it is retried on the next pass
            log.exception("project purge failed")
    return done
