from __future__ import annotations

import uuid

from fastapi import APIRouter, Path
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import NotFound, RateLimited, ValidationFailed
from app.api.routers.projects import load_project
from app.db.models import GateDecision, StageRun, WorkflowStage
from app.domain.enums import GateDecisionKind, GateKey, StageKey
from app.orchestrator.orchestrator import Orchestrator
from app.schemas import api
from app.services import serialize as ser

router = APIRouter(prefix="/projects/{project_id}", tags=["workflow"])


async def _workflow(s: ScopedSession, project_id: uuid.UUID) -> api.Workflow:
    project = await load_project(s, project_id)
    return api.Workflow(project_status=project.status.value, stages=await ser.stage_states(s, project))


async def _stage_state(s: ScopedSession, project_id: uuid.UUID, stage: StageKey) -> api.StageState:
    wf = await _workflow(s, project_id)
    return next(x for x in wf.stages if x.key == stage.value)


def _stage_key(stage: str) -> StageKey:
    try:
        return StageKey(stage)
    except ValueError as exc:
        raise NotFound("Unknown stage") from exc


@router.get("/workflow", response_model=api.Workflow)
async def get_workflow(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> api.Workflow:
    return await _workflow(s, project_id)


@router.post("/workflow/pause", response_model=api.Workflow)
async def pause(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> api.Workflow:
    await Orchestrator(ctx).pause(p.scope, project_id)
    s.expire_all()
    return await _workflow(s, project_id)


@router.post("/workflow/resume", response_model=api.Workflow)
async def resume(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> api.Workflow:
    await Orchestrator(ctx).resume(p.scope, project_id)
    s.expire_all()
    return await _workflow(s, project_id)


@router.post("/stages/{stage}/run", response_model=api.StageState, status_code=202)
async def run_stage(
    project_id: uuid.UUID,
    body: api.StageRunRequest,
    ctx: Ctx,
    s: ScopedSession,
    p: MemberPrincipal,
    stage: str = Path(),
) -> api.StageState:
    key = _stage_key(stage)
    await load_project(s, project_id)
    params = body.parameters or {}
    if key == StageKey.discovery and params:
        try:
            settings = api.ScanSettings.model_validate(params)
        except ValueError as exc:
            raise ValidationFailed(
                "Invalid scan settings", details=[{"field": "parameters", "message": str(exc)[:300]}]
            ) from exc
        cap = int((p.organisation.limits or {}).get("max_pages_cap", ctx.settings.scan_max_pages_cap))
        if settings.max_pages > cap:
            raise ValidationFailed(
                f"Maximum pages is {cap}", details=[{"field": "parameters.max_pages", "message": f"Enter 1–{cap}."}]
            )
        params = settings.model_dump()
    elif key in (StageKey.requirements, StageKey.test_strategy, StageKey.readiness_criteria) and params:
        allowed = {"guidance", "include_documents"} if key == StageKey.requirements else {"guidance"}
        bad = sorted(set(params) - allowed)
        guidance = params.get("guidance")
        if bad or (guidance is not None and (not isinstance(guidance, str) or len(guidance) > 1000)):
            raise ValidationFailed(
                "Invalid parameters",
                details=[{"field": f"parameters.{b}", "message": "Not allowed"} for b in bad]
                or [{"field": "parameters.guidance", "message": "Up to 1000 characters"}],
            )
        if "include_documents" in params and not isinstance(params["include_documents"], bool):
            raise ValidationFailed(
                "Invalid parameters",
                details=[{"field": "parameters.include_documents", "message": "Must be true/false"}],
            )
    retry = ctx.rate_limiter.check(f"stagerun:{project_id}", ctx.settings.rl_stage_runs_per_hour, 3600)
    if retry is not None:
        raise RateLimited("Too many runs for this project in the last hour", retry)
    await Orchestrator(ctx).request_run(p.scope, project_id, key, parameters=params or None, reason=body.reason)
    ctx.rate_limiter.record(f"stagerun:{project_id}")
    s.expire_all()
    return await _stage_state(s, project_id, key)


@router.post("/stages/{stage}/cancel", response_model=api.StageState)
async def cancel_stage(
    project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal, stage: str = Path()
) -> api.StageState:
    key = _stage_key(stage)
    await load_project(s, project_id)
    await Orchestrator(ctx).cancel(p.scope, project_id, key)
    s.expire_all()
    return await _stage_state(s, project_id, key)


async def _stage_row(s: ScopedSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
    await load_project(s, project_id)
    st = (
        await s.execute(
            select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
        )
    ).scalar_one_or_none()
    if st is None:
        raise NotFound("Stage not found")
    return st


@router.get("/stages/{stage}/runs", response_model=list[api.StageRunSummary])
async def list_runs(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, stage: str = Path()
) -> list[api.StageRunSummary]:
    st = await _stage_row(s, project_id, _stage_key(stage))
    runs = (
        (await s.execute(select(StageRun).where(StageRun.workflow_stage_id == st.id).order_by(StageRun.version.desc())))
        .scalars()
        .all()
    )
    users = await ser.users_by_id(s, [r.triggered_by for r in runs])
    return [
        api.StageRunSummary(
            version=r.version,
            status=r.status.value,
            generated_by=r.generated_by.value if r.generated_by else None,
            partial=r.partial,
            started_at=r.started_at,
            finished_at=r.finished_at,
            triggered_by=ser.user_ref(users.get(r.triggered_by)) if r.triggered_by else None,
            created_at=r.created_at,
            review_status=r.review_status.value if r.review_status else "not_required",
        )
        for r in runs
    ]


@router.get("/stages/{stage}/runs/{version}", response_model=api.StageRunDetail)
async def get_run(
    project_id: uuid.UUID, version: int, s: ScopedSession, _p: CurrentPrincipal, stage: str = Path()
) -> api.StageRunDetail:
    st = await _stage_row(s, project_id, _stage_key(stage))
    r = (
        await s.execute(select(StageRun).where(StageRun.workflow_stage_id == st.id, StageRun.version == version))
    ).scalar_one_or_none()
    if r is None:
        raise NotFound("Stage run not found")
    decisions = (
        (
            await s.execute(
                select(GateDecision).where(GateDecision.stage_run_id == r.id).order_by(GateDecision.created_at)
            )
        )
        .scalars()
        .all()
    )
    users = await ser.users_by_id(s, [d.decided_by for d in decisions])
    return api.StageRunDetail(
        version=r.version,
        status=r.status.value,
        generated_by=r.generated_by.value if r.generated_by else None,
        partial=r.partial,
        upstream_versions={k: int(v) for k, v in (r.upstream_versions or {}).items()},
        validation_issues=[api.ValidationIssueOut.model_validate(i) for i in r.validation_issues or []],
        output=r.output or {},
        decisions=[ser.decision_out(d, users, r.version) for d in decisions],
        parameters=r.parameters or {},
        started_at=r.started_at,
        finished_at=r.finished_at,
        error=r.error,
    )


@router.post("/gates/{gate}/decision", response_model=api.StageState)
async def decide(
    project_id: uuid.UUID,
    body: api.GateDecisionRequest,
    ctx: Ctx,
    s: ScopedSession,
    p: MemberPrincipal,
    gate: str = Path(),
) -> api.StageState:
    try:
        gk = GateKey(gate)
    except ValueError as exc:
        raise NotFound("Unknown gate") from exc
    await load_project(s, project_id)
    await Orchestrator(ctx).decide_gate(
        p.scope,
        project_id,
        gk,
        decision=GateDecisionKind(body.decision),
        comment=body.comment,
        stage_run_version=body.stage_run_version,
    )
    s.expire_all()
    from app.domain.stages import GATE_STAGE

    return await _stage_state(s, project_id, GATE_STAGE[gk])
