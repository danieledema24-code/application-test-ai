"""Test runs, Gate 7, results, evidence, live view and failure analysis (P4-06, P4-07, P4-08).

Reads are open to every member of the organisation (viewers included). Requesting, cancelling (own runs) and
re-running need a member; authorising (G7) and deciding approvals need `can_approve`, in one request (design §7.3).
Results are never written through the API: only the engine stores them, from Playwright's report. People change a
result's *classification* (with a reason), never its status. Objects of another organisation are 404.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.api.routers import p2common as c
from app.api.routers.automation import Browser, SelectionInput, Viewport
from app.db.models import (
    AutomationAsset,
    AutomationScript,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    Project,
    TestCase,
)
from app.db.tenant import BYPASS
from app.domain.defects import classify as cl
from app.domain.enums import FailureClass, ResultStatus, Role, RunStatus, StageKey
from app.orchestrator.orchestrator import Orchestrator
from app.services import approvals as apr
from app.services import defects as dsvc
from app.services import execution as xsvc
from app.services import serialize as ser
from app.services import serialize_p2 as out
from app.services.audit import audit

router = APIRouter(tags=["execution"])


def _approver(p: Principal) -> bool:
    return p.membership.role != Role.viewer and bool(p.scope.can_approve)


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


async def _run(s: Any, run_id: uuid.UUID) -> ExecutionRun:
    run: ExecutionRun = await c.load(s, ExecutionRun, run_id, "Run")
    return run


async def _emit(ctx: Ctx, project: Project, type_: str, message: str, data: dict[str, Any]) -> None:
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type=type_,
        message=message,
        stage_key=StageKey.execution.value,
        agent_key="execution",
        data=data,
    )


async def _start(ctx: Ctx, p: Principal, project: Project, run: ExecutionRun) -> None:
    """After a commit that left the run `queued`: its job, the mirrored stage events."""
    await ctx.queue.enqueue(
        "execution_run",
        {"run_id": str(run.id)},
        org_id=run.organisation_id,
        project_id=run.project_id,
        dedupe_key=f"execution_run:{run.id}",
        concurrency_group=xsvc.EXECUTION_GROUP,
        max_attempts=1,
    )
    await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)


# ------------------------------------------------------------------ list and detail


@router.get("/projects/{project_id}/execution-runs")
async def list_runs(
    project_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    status: str | None = None,
    mode: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    stmt = select(ExecutionRun).where(ExecutionRun.project_id == project_id)
    if status:
        stmt = stmt.where(ExecutionRun.status.in_([x for x in status.split(",") if x]))
    if mode:
        stmt = stmt.where(ExecutionRun.mode == mode)
    runs = list((await s.execute(stmt.order_by(ExecutionRun.created_at.desc()).limit(limit))).scalars())
    users = await out.users(s, await xsvc.user_ids(s, runs))
    see = out.sees_email(p.membership.role)
    items = [await xsvc.run_summary(s, r, users, see_email=see) for r in runs]
    waiting = [r.key for r in runs if r.status == RunStatus.awaiting_authorisation]
    return {
        "items": items,
        "waiting": waiting,
        "running": next((r.key for r in runs if r.status == RunStatus.running), None),
        "permissions": {"can_request": _member(p), "can_authorise": _approver(p)},
    }


async def run_detail(ctx: Ctx, s: Any, p: Principal, run: ExecutionRun) -> dict[str, Any]:
    runs = [run]
    users = await out.users(s, await xsvc.user_ids(s, runs))
    approvals = await apr.run_approvals(s, run.id)
    if await apr.expire_due(s, approvals):
        await s.commit()
    problem = await xsvc.request_problem(s, run)
    ahead = None
    if run.status == RunStatus.queued:
        other = (
            await s.execute(
                select(ExecutionRun.key).where(
                    ExecutionRun.project_id == run.project_id,
                    ExecutionRun.status == RunStatus.running,
                    ExecutionRun.id != run.id,
                )
            )
        ).scalar_one_or_none()
        ahead = other
    cancelled_by = (run.config or {}).get("cancelled_by")
    see = out.sees_email(p.membership.role)
    d = await xsvc.run_summary(s, run, users, see_email=see)
    d.update(
        {
            "scope": run.scope,
            "config": {k: v for k, v in (run.config or {}).items() if k in ("workers", "retries", "test_timeout_s")},
            "approvals": [await apr.approval_dict(s, a, can_decide=_approver(p), see_email=see) for a in approvals],
            "tests_rows": await xsvc.tests_rows(s, run),
            "progress": (run.totals or {}).get("progress") if run.status == RunStatus.running else None,
            "request_problem": problem,
            "waiting_for": ahead,
            "cancelled_by": out.person(users.get(uuid.UUID(cancelled_by)), see_email=see) if cancelled_by else None,
            "analysis": await xsvc.analysis_summary(s, run),
            "permissions": {
                "can_authorise": _approver(p) and run.status == RunStatus.awaiting_authorisation,
                "can_cancel": _member(p) and xsvc.can_cancel(run, p.user, _approver(p)),
                "can_rerun": _member(p) and run.status in xsvc.FINISHED,
                "is_requester": run.requested_by == p.user.id,
            },
        }
    )
    return d


@router.get("/execution-runs/{run_id}")
async def get_run(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await run_detail(ctx, s, p, await _run(s, run_id))


@router.get("/projects/{project_id}/execution-runs/by-key/{key}")
async def get_run_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    run = (
        await s.execute(select(ExecutionRun).where(ExecutionRun.project_id == project_id, ExecutionRun.key == key))
    ).scalar_one_or_none()
    if run is None:
        raise NotFound(f"We couldn't find {key} in this project.")
    return await run_detail(ctx, s, p, run)


@router.get("/execution-runs/{run_id}/results")
async def run_results(run_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    return await xsvc.tests_rows(s, await _run(s, run_id))


# ------------------------------------------------------------------ requests and G7


class ApprovalChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["external_transaction", "destructive"]
    decision: Literal["approve", "reject"]
    confirm_text: str | None = Field(default=None, max_length=300)
    comment: str | None = Field(default=None, max_length=2000)


class RunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selection: SelectionInput = Field(default_factory=SelectionInput)
    browsers: list[Browser] = Field(default_factory=lambda: list[Browser](["chromium"]))
    viewports: list[Viewport] = Field(default_factory=lambda: list[Viewport](["desktop"]))
    notes: str | None = Field(default=None, max_length=500)
    workers: int | None = Field(default=None, ge=1, le=4)
    authorise: bool = False
    approvals: list[ApprovalChoice] = Field(default_factory=list, max_length=5)


@router.post("/projects/{project_id}/execution-runs", status_code=201)
async def request_run(
    project_id: uuid.UUID, body: RunInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    """A run request (G7 waiting), or with `authorise: true` an authorised run in the same request (approvers)."""
    project = await c.project_of(s, project_id)
    if body.authorise and not _approver(p):
        raise Forbidden("Authorising runs needs gate-approval permission")
    case_keys = body.selection.case_keys
    run = await xsvc.create_run(
        ctx,
        s,
        project,
        p.user,
        suite=body.selection.suite or ("all_approved" if case_keys is None else None),
        case_keys=case_keys,
        browsers=list(body.browsers),
        viewports=list(body.viewports),
        notes=body.notes,
        workers=body.workers,
    )
    if body.authorise:
        await xsvc.authorise(
            s,
            project,
            run,
            p.user,
            decision="approve",
            comment=None,
            approvals=[a.model_dump() for a in body.approvals],
        )
        await Orchestrator(ctx).mirror_execution_run(s, project, run)
    await s.commit()
    name = p.user.full_name or p.user.email
    tests = len((run.config or {}).get("plan") or [])
    await _emit(
        ctx,
        project,
        "execution.run_requested",
        f"{run.key} requested by {name}: {tests} tests · "
        + ("authorised" if body.authorise else "waiting for authorisation"),
        {"kind": "request", "run_key": run.key, "tests": tests},
    )
    if run.status == RunStatus.queued:
        await _emit(
            ctx,
            project,
            "execution.run_authorised",
            f"{run.key} requested and authorised by {name}",
            {"kind": "gate", "gate": "G7", "run_key": run.key},
        )
        await _start(ctx, p, project, run)
    return await run_detail(ctx, s, p, run)


class AuthoriseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]
    comment: str | None = Field(default=None, max_length=2000)
    approvals: list[ApprovalChoice] = Field(default_factory=list, max_length=5)


@router.post("/execution-runs/{run_id}/authorise")
async def authorise_run(
    run_id: uuid.UUID, body: AuthoriseInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    run = await _run(s, run_id)
    if not _approver(p):
        raise Forbidden("Authorising runs needs gate-approval permission")
    project = await c.project_of(s, run.project_id)
    try:
        await xsvc.authorise(
            s,
            project,
            run,
            p.user,
            decision=body.decision,
            comment=body.comment,
            approvals=[a.model_dump() for a in body.approvals],
        )
    except Conflict:
        await s.commit()  # keep `expired` approval transitions
        raise
    if run.status == RunStatus.queued:
        await Orchestrator(ctx).mirror_execution_run(s, project, run)
    await s.commit()
    name = p.user.full_name or p.user.email
    if run.status == RunStatus.queued:
        self_auth = run.requested_by == p.user.id
        await _emit(
            ctx,
            project,
            "execution.run_authorised",
            f"{run.key} {'requested and authorised' if self_auth else 'authorised'} by {name}",
            {"kind": "gate", "gate": "G7", "run_key": run.key},
        )
        await _start(ctx, p, project, run)
    else:
        await _emit(
            ctx,
            project,
            "execution.run_rejected",
            f"{run.key} not authorised by {name}",
            {"kind": "gate", "gate": "G7", "run_key": run.key, "decision": "reject"},
        )
    return await run_detail(ctx, s, p, run)


@router.post("/execution-runs/{run_id}/cancel")
async def cancel_run(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    run = await _run(s, run_id)
    project = await c.project_of(s, run.project_id)
    message = await xsvc.cancel(s, project, run, p.user, can_approve=_approver(p))
    if run.status == RunStatus.cancelled:
        await Orchestrator(ctx).mirror_execution_run(s, project, run)
    await s.commit()
    await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)
    await _emit(
        ctx,
        project,
        "execution.run_status",
        message.rstrip("."),
        {"kind": "status", "run_key": run.key, "status": "cancelled"},
    )
    return {"message": message, "run": await run_detail(ctx, s, p, run)}


class RerunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    only: Literal["failed", "all"] = "failed"


@router.post("/execution-runs/{run_id}/rerun", status_code=201)
async def rerun(run_id: uuid.UUID, body: RerunInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    """A **new** run request with the same browsers and sizes; it needs its own G7 (decision D8)."""
    run = await _run(s, run_id)
    project = await c.project_of(s, run.project_id)
    plan = (run.config or {}).get("plan") or []
    if body.only == "failed":
        bad = {
            r.key
            for r in (
                await s.execute(
                    select(ExecutionResult).where(
                        ExecutionResult.execution_run_id == run.id,
                        ExecutionResult.status.in_([ResultStatus.failed, ResultStatus.error]),
                    )
                )
            ).scalars()
        }
        keys = sorted({i["case_key"] for i in plan if i["key"] in bad})
        if not keys:
            raise Conflict(f"{run.key} has no failed tests to run again")
    else:
        keys = sorted({i["case_key"] for i in plan})
    scope = run.scope or {}
    new = await xsvc.create_run(
        ctx,
        s,
        project,
        p.user,
        suite=None,
        case_keys=keys,
        browsers=list(scope.get("browsers") or ["chromium"]),
        viewports=list(scope.get("viewports") or ["desktop"]),
        notes=f"Re-run of {run.key}",
    )
    await s.commit()
    await _emit(
        ctx,
        project,
        "execution.run_requested",
        f"{new.key} requested by {p.user.full_name or p.user.email}: re-run of {run.key} · waiting for authorisation",
        {"kind": "request", "run_key": new.key},
    )
    return await run_detail(ctx, s, p, new)


# ------------------------------------------------------------------ live view (P4-07)


def _frame(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def _slot_id(run_id: uuid.UUID, slot: str) -> uuid.UUID:
    return uuid.uuid5(run_id, f"live:{slot}")


@router.get("/execution-runs/{run_id}/live")
async def live(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    """Worker slots with short-lived signed frame URLs; 404 once the run is not running (frames are not stored)."""
    from app.agents.execution.engine import live_dir

    run = await _run(s, run_id)
    if run.status != RunStatus.running:
        raise NotFound("The run isn't running")
    d = live_dir(ctx, run.id)
    slots = []
    if d.is_dir():
        import json

        for meta in sorted(d.glob("w*.json")):
            slot = meta.stem
            try:
                info = json.loads(meta.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            frame = d / f"{slot}.jpg"
            url = None
            if frame.is_file():
                exp, sig = ctx.signer.sign(_slot_id(run.id, slot), run.organisation_id)
                base = ctx.settings.public_api_url.rstrip("/")
                url = f"{base}/api/v1/execution-runs/{run.id}/live/{slot}/frame?exp={exp}&sig={sig}"
            slots.append(
                {
                    "slot": slot,
                    "title": str(info.get("title") or "")[:200],
                    "state": info.get("state"),
                    "frame_url": url,
                    "at": info.get("at"),
                }
            )
    return {"slots": slots}


@router.get("/execution-runs/{run_id}/live/{slot}/frame")
async def live_frame(
    run_id: uuid.UUID, slot: str, ctx: Ctx, exp: int = Query(...), sig: str = Query(..., max_length=128)
) -> Response:
    """Public but signed (like evidence): the latest JPEG frame of one worker slot."""
    from app.agents.execution.engine import live_dir

    if not slot.startswith("w") or not slot[1:].isdigit():
        raise NotFound("No such slot")
    async with ctx.session_factory() as s:
        run = (
            await s.execute(select(ExecutionRun).where(ExecutionRun.id == run_id).execution_options(**BYPASS))
        ).scalar_one_or_none()
    if run is None or not ctx.signer.verify(_slot_id(run.id, slot), run.organisation_id, exp, sig):
        raise Forbidden("This link is invalid or has expired")
    data = _frame(live_dir(ctx, run.id) / f"{slot}.jpg") if run.status == RunStatus.running else None
    if data is None:
        raise NotFound("No frame")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


# ------------------------------------------------------------------ results


async def _asset_version(s: Any, script: AutomationScript | None, path: Any) -> int | None:
    """Current version of the page object a fix suggestion changes; the fix creates the next one."""
    if script is None or not path:
        return None
    asset = (
        await s.execute(
            select(AutomationAsset).where(
                AutomationAsset.stage_run_id == script.stage_run_id, AutomationAsset.path == str(path)
            )
        )
    ).scalar_one_or_none()
    return int(asset.version) if asset else None


async def result_detail(ctx: Ctx, s: Any, p: Principal, r: ExecutionResult) -> dict[str, Any]:
    run = await s.get(ExecutionRun, r.execution_run_id)
    plan: list[dict[str, Any]] = list((run.config or {}).get("plan") or []) if run else []
    item: dict[str, Any] = next((i for i in plan if i["key"] == r.key), {})
    case = await s.get(TestCase, r.test_case_id) if r.test_case_id else None
    script = await s.get(AutomationScript, r.automation_script_id) if r.automation_script_id else None
    evidence = list(
        (await s.execute(select(Evidence).where(Evidence.execution_result_id == r.id).order_by(Evidence.key))).scalars()
    )
    defect = await xsvc.defect_for_result(s, r.id)
    checks: dict[str, list[dict[str, Any]]] = {}
    for m in (script.assertion_map if script else []) or []:
        checks.setdefault(str(m.get("step")), []).append(
            {"helper": m.get("helper"), "kind": m.get("kind"), "args": m.get("args")}
        )
    analysis = dict(r.analysis or {})
    overridden = analysis.get("overridden")
    users = await out.users(s, [uuid.UUID(overridden["by"])] if overridden and overridden.get("by") else [])
    if overridden and overridden.get("by"):
        analysis["overridden"] = {
            **overridden,
            "by_user": out.person(users.get(uuid.UUID(overridden["by"])), see_email=out.sees_email(p.membership.role)),
        }
    return {
        **xsvc.result_row(r, item),
        "run": {"id": run.id, "key": run.key, "status": run.status.value} if run else None,
        "case": {
            "id": case.id,
            "key": case.key,
            "title": case.title,
            "version": case.version,
            "expected_result": case.expected_result,
            "provenance": case.provenance.value,
            "steps": [
                {"n": st.get("n"), "action": st.get("action", ""), "expected": st.get("expected", "")}
                for st in case.steps or []
                if isinstance(st, dict)
            ],
        }
        if case
        else None,
        "script": {"id": script.id, "path": script.path, "version": script.version} if script else None,
        "attempt_details": r.steps or [],
        "error": r.error,
        "actual_result": r.actual_result,
        "page_state": {
            k: v for k, v in (r.page_state or {}).items() if k in ("url", "title", "heading", "messages", "browser")
        },
        "checks_by_step": checks,
        "evidence": [
            {
                **ser.evidence_link(ctx, e).model_dump(mode="json"),
                "attempt": (e.meta or {}).get("attempt"),
                "masked": bool((e.meta or {}).get("masked")),
            }
            for e in evidence
        ],
        "signs_in": bool(item.get("signs_in")),
        "retried": bool(item.get("retried", True)),
        "analysis": analysis or None,
        "defect": {"id": defect.id, "key": defect.key, "status": defect.status.value, "summary": defect.summary}
        if defect
        else None,
        "heal_suggestions": [
            {
                **h,
                "candidates": [{k: v for k, v in c.items() if k != "spec"} for c in h.get("candidates") or []],
                "asset_version": await _asset_version(s, script, h.get("asset_path")),
            }
            for h in r.heal_suggestions or []
        ],
        "permissions": {
            "can_reclassify": _member(p) and r.analysis is not None,
            "can_raise_defect": _member(p),
            "can_accept_fix": _member(p),
        },
    }


@router.get("/execution-results/{result_id}")
async def get_result(result_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    r: ExecutionResult = await c.load(s, ExecutionResult, result_id, "Result")
    return await result_detail(ctx, s, p, r)


@router.get("/projects/{project_id}/execution-results/by-key/{key}")
async def get_result_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    r = (
        await s.execute(
            select(ExecutionResult).where(ExecutionResult.project_id == project_id, ExecutionResult.key == key)
        )
    ).scalar_one_or_none()
    if r is None:
        raise NotFound(f"We couldn't find {key} in this project.")
    return await result_detail(ctx, s, p, r)


class ReclassifyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    classification: FailureClass
    reason: str = Field(default="", max_length=2000)


@router.post("/execution-results/{result_id}/classification")
async def reclassify(
    result_id: uuid.UUID, body: ReclassifyInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    """Changes the likely cause only (P4-08). The result's status never changes. To `application_defect` drafts a
    defect; away from it leaves an existing draft for G8."""
    r: ExecutionResult = await c.load(s, ExecutionResult, result_id, "Result")
    if r.analysis is None:
        raise Conflict("This result hasn't been analysed")
    reason = body.reason.strip()
    if not reason:
        raise ValidationFailed(
            "Say why you think the cause is different.",
            details=[{"field": "reason", "message": "Say why you think the cause is different."}],
        )
    new = body.classification.value
    a = dict(r.analysis)
    prev = {"classification": a.get("classification"), "confidence": a.get("confidence"), "label": a.get("label")}
    if new == a.get("classification"):
        raise Conflict("That is already the cause")
    from app.db.types import utcnow

    a.update(
        {
            "classification": new,
            "label": cl.LABELS[new],
            "overridden": {
                "by": str(p.user.id),
                "at": utcnow().isoformat(),
                "reason": reason,
                "previous": prev,
                "original": (r.analysis or {}).get("overridden", {}).get("original") or prev,
            },
        }
    )
    r.classification = body.classification
    project = await c.project_of(s, r.project_id)
    created = None
    if new == "application_defect" and await xsvc.defect_for_result(s, r.id) is None and r.test_case_id:
        case = await s.get(TestCase, r.test_case_id)
        script = await s.get(AutomationScript, r.automation_script_id) if r.automation_script_id else None
        if case is not None:
            d, made = await dsvc.draft_from_result(
                s, project, r, case, a, list(script.assertion_map or []) if script else [], user_id=p.user.id
            )
            a["defect"] = {
                "id": str(d.id),
                "key": d.key,
                "status": d.status.value,
                "summary": d.summary,
                "occurrence": not made,
            }
            a.pop("no_defect", None)
            created = d.key if made else None
    r.analysis = a
    audit(
        s,
        org_id=project.organisation_id,
        action="execution_result.reclassified",
        target_type="execution_result",
        target_id=r.id,
        actor_user_id=p.user.id,
        project_id=project.id,
        metadata={"key": r.key, "from": prev["classification"], "to": new},
    )
    await s.commit()
    if created:
        await ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type="defect.drafted",
            message=f"Drafted {created} from a reclassified result",
            stage_key=StageKey.failure_analysis.value,
            data={"kind": "result", "defect_key": created},
        )
    return {"message": f"Cause changed to {cl.LABELS[new]}.", "result": await result_detail(ctx, s, p, r)}


@router.post("/execution-results/{result_id}/heal-suggestions/{n}/accept")
async def accept_fix(result_id: uuid.UUID, n: int, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    """Accepts fix suggestion option `n` (design §9.3): a new page-object version with only that locator changed.
    Expected results and assertions never change; scripts using it must pass their checks before the next run."""
    from app.services import heal

    r: ExecutionResult = await c.load(s, ExecutionResult, result_id, "Result")
    project = await c.project_of(s, r.project_id)
    asset, keys = await heal.accept(s, project, r, n, p.user.id)
    await s.commit()
    name = asset.path.rsplit("/", 1)[-1]
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="automation.healed",
        message=f"{name} version {asset.version} created from a fix suggestion",
        stage_key=StageKey.automation.value,
        data={"kind": "result", "path": asset.path, "version": asset.version},
    )
    return {
        "message": f"{name} version {asset.version} created. Validate it before the next run.",
        "asset": {"id": asset.id, "path": asset.path, "version": asset.version},
        "scripts_to_validate": keys,
        "result": await result_detail(ctx, s, p, r),
    }
