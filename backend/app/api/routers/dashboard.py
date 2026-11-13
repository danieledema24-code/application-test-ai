from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter
from sqlalchemy import and_, func, select

from app.api.deps import Ctx, CurrentPrincipal, ScopedSession
from app.api.routers.events import MILESTONE_TYPES
from app.db.models import AgentEvent, DiscoveredPage, Project, ScanSession, WorkflowStage
from app.db.types import utcnow
from app.domain.enums import GateStatus, PageStatus, ScanStatus, StageStatus
from app.schemas import api
from app.services import serialize as ser

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard", response_model=api.Dashboard)
async def dashboard(ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> api.Dashboard:
    # Every query is filtered by organisation explicitly; the tenant safety net adds the same criteria (T10).
    org_id = p.organisation.id
    live = and_(Project.organisation_id == org_id, Project.archived_at.is_(None))
    recent = list(
        (await s.execute(select(Project).where(live).order_by(Project.updated_at.desc()).limit(6))).scalars().all()
    )
    rows = (
        await s.execute(
            select(AgentEvent, Project.name)
            .join(Project, Project.id == AgentEvent.project_id)
            .where(AgentEvent.organisation_id == org_id, AgentEvent.type.in_(MILESTONE_TYPES))
            .order_by(AgentEvent.id.desc())
            .limit(20)
        )
    ).all()
    live_ids = select(Project.id).where(live)
    total = int((await s.execute(select(func.count()).select_from(Project).where(live))).scalar_one())
    running = int(
        (
            await s.execute(
                select(func.count())
                .select_from(ScanSession)
                .where(
                    ScanSession.organisation_id == org_id,
                    ScanSession.status.in_([ScanStatus.running, ScanStatus.queued]),
                    ScanSession.project_id.in_(live_ids),
                )
            )
        ).scalar_one()
    )
    awaiting = int(
        (
            await s.execute(
                select(func.count(func.distinct(WorkflowStage.project_id))).where(
                    WorkflowStage.organisation_id == org_id,
                    WorkflowStage.project_id.in_(live_ids),
                    WorkflowStage.gate_key.is_not(None),
                    WorkflowStage.status.in_(
                        [StageStatus.awaiting_approval, StageStatus.completed, StageStatus.cancelled]
                    ),
                    WorkflowStage.gate_status.in_([GateStatus.pending, GateStatus.recommended]),
                )
            )
        ).scalar_one()
    )
    failed = int(
        (
            await s.execute(
                select(func.count())
                .select_from(WorkflowStage)
                .where(
                    WorkflowStage.organisation_id == org_id,
                    WorkflowStage.project_id.in_(live_ids),
                    WorkflowStage.status == StageStatus.failed,
                )
            )
        ).scalar_one()
    )
    pages_30d = int(
        (
            await s.execute(
                select(func.count())
                .select_from(DiscoveredPage)
                .where(
                    DiscoveredPage.organisation_id == org_id,
                    DiscoveredPage.status == PageStatus.visited,
                    DiscoveredPage.created_at >= utcnow() - timedelta(days=30),
                )
            )
        ).scalar_one()
    )
    summaries = [await ser.project_summary(s, r) for r in recent]
    all_live = list((await s.execute(select(Project).where(live))).scalars().all())
    gaps = 0
    for proj in all_live:
        scan = (
            await s.execute(
                select(ScanSession)
                .where(ScanSession.project_id == proj.id)
                .order_by(ScanSession.sequence.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        gaps += len(scan.access_gaps or []) if scan else 0
    return api.Dashboard(
        welcome=api.DashboardWelcome(full_name=p.user.full_name, organisation=p.organisation.name),
        recent_projects=summaries,
        activity=[
            api.ActivityItem(
                id=e.id,
                project_id=e.project_id,
                project_name=name,
                type=e.type,
                message=e.message,
                level=e.level.value,
                created_at=e.created_at,
                stage_key=e.stage_key,
            )
            for e, name in rows
        ],
        health=api.DashboardHealth(
            projects_total=total,
            scans_running=running,
            awaiting_approval=awaiting,
            failed_stages=failed,
            pages_discovered_30d=pages_30d,
            access_gaps=gaps,
        ),
        ai=api.DashboardAi(enabled=ctx.llm.enabled, model=ctx.llm.model),
    )
