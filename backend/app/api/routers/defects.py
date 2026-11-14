"""Defects and Gate 8 (P4-09, decision D11).

Reads: every member (viewers included). Raising, editing drafts and confirmed defects, marking fixed and closing:
members. Confirming or rejecting a draft (G8, one by one or in bulk) and marking a fix verified: `can_approve`.
No delete (405). Objects of another organisation are 404.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import AppError, Conflict, Forbidden, NotFound, ValidationFailed
from app.api.routers import p2common as c
from app.db.models import (
    AutomationScript,
    Defect,
    DefectLink,
    DefectOccurrence,
    EntityRevision,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    Project,
    Requirement,
    TestCase,
)
from app.domain.enums import DefectSeverity, DefectSource, DefectStatus, Priority, Role, StageKey
from app.services import defects as dsvc
from app.services import revisions
from app.services import serialize as ser
from app.services import serialize_p2 as out

router = APIRouter(tags=["defects"])


class MethodNotAllowed(AppError):
    status_code = 405
    code = "method_not_allowed"


def _approver(p: Principal) -> bool:
    return p.membership.role != Role.viewer and bool(p.scope.can_approve)


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


async def _links(s: Any, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, list[str]]]:
    if not ids:
        return {}
    rows = list((await s.execute(select(DefectLink).where(DefectLink.defect_id.in_(ids)))).scalars())
    case_l = {r.test_case_lineage_id for r in rows if r.test_case_lineage_id}
    req_l = {r.requirement_lineage_id for r in rows if r.requirement_lineage_id}
    cases: dict[uuid.UUID, str] = {}
    if case_l:
        for tc in (await s.execute(select(TestCase).where(TestCase.lineage_id.in_(case_l)))).scalars():
            cases[tc.lineage_id] = tc.key
    reqs: dict[uuid.UUID, str] = {}
    if req_l:
        for rq in (await s.execute(select(Requirement).where(Requirement.lineage_id.in_(req_l)))).scalars():
            reqs[rq.lineage_id] = rq.key
    outd: dict[uuid.UUID, dict[str, list[str]]] = {i: {"cases": [], "requirements": []} for i in ids}
    for r in rows:
        if r.test_case_lineage_id in cases and cases[r.test_case_lineage_id] not in outd[r.defect_id]["cases"]:
            outd[r.defect_id]["cases"].append(cases[r.test_case_lineage_id])
        if r.requirement_lineage_id in reqs and reqs[r.requirement_lineage_id] not in outd[r.defect_id]["requirements"]:
            outd[r.defect_id]["requirements"].append(reqs[r.requirement_lineage_id])
    return outd


def summary(d: Defect, links: dict[str, list[str]], p: Principal) -> dict[str, Any]:
    env = d.environment or {}
    return {
        "id": d.id,
        "key": d.key,
        "summary": d.summary,
        "severity": d.severity.value,
        "priority": d.priority.value,
        "status": d.status.value,
        "source": d.source.value,
        "reproducibility": d.reproducibility,
        "cases": links.get("cases", []),
        "requirements": links.get("requirements", []),
        "run_key": env.get("run_key"),
        "result_key": env.get("result_key"),
        "last_seen": env.get("date"),
        "classification_confidence": None,
        "version": d.version,
        "created_at": d.created_at,
        "actions": {
            a: dsvc.can_do(d, a, member=_member(p), approver=_approver(p))
            for a in ("confirm", "reject", "fixed", "verified", "closed")
        },
    }


@router.get("/projects/{project_id}/defects")
async def list_defects(
    project_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    status: str = "open",
    severity: str | None = None,
    priority: str | None = None,
    source: str | None = None,
    case: str | None = None,
    requirement: str | None = None,
    run: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=200, ge=1, le=500),
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    stmt = select(Defect).where(Defect.project_id == project_id)
    if status == "open":
        stmt = stmt.where(Defect.status.in_(dsvc.OPEN))
    elif status != "all":
        stmt = stmt.where(Defect.status.in_([x for x in status.split(",") if x]))
    if severity:
        stmt = stmt.where(Defect.severity.in_(severity.split(",")))
    if priority:
        stmt = stmt.where(Defect.priority.in_(priority.split(",")))
    if source:
        stmt = stmt.where(Defect.source == source)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Defect.key.ilike(like), Defect.summary.ilike(like)))
    rows = list((await s.execute(stmt.order_by(Defect.created_at.desc()).limit(limit))).scalars())
    links = await _links(s, [d.id for d in rows])
    if case:
        rows = [d for d in rows if case in links[d.id]["cases"]]
    if requirement:
        rows = [d for d in rows if requirement in links[d.id]["requirements"]]
    if run:
        rows = [d for d in rows if (d.environment or {}).get("run_key") == run]
    counts = {
        st.value: int(n)
        for st, n in (
            await s.execute(
                select(Defect.status, func.count()).where(Defect.project_id == project_id).group_by(Defect.status)
            )
        ).all()
    }
    runs = int(
        (
            await s.execute(
                select(func.count())
                .select_from(ExecutionRun)
                .where(ExecutionRun.project_id == project_id, ExecutionRun.finished_at.is_not(None))
            )
        ).scalar_one()
    )
    return {
        "items": [summary(d, links[d.id], p) for d in rows],
        "counts": {k.value: counts.get(k.value, 0) for k in DefectStatus},
        "finished_runs": runs,
        "permissions": {"can_raise": _member(p), "can_decide": _approver(p)},
    }


async def detail(ctx: Ctx, s: Any, p: Principal, d: Defect) -> dict[str, Any]:
    links = (await _links(s, [d.id]))[d.id]
    occ = list(
        (
            await s.execute(
                select(DefectOccurrence).where(DefectOccurrence.defect_id == d.id).order_by(DefectOccurrence.seen_at)
            )
        ).scalars()
    )
    occurrences = []
    for o in occ:
        r = await s.get(ExecutionResult, o.execution_result_id)
        run = await s.get(ExecutionRun, r.execution_run_id) if r else None
        occurrences.append(
            {
                "result_id": o.execution_result_id,
                "result_key": r.key if r else None,
                "run_key": run.key if run else None,
                "seen_at": o.seen_at,
                "status": r.status.value if r else None,
            }
        )
    ev_ids = [uuid.UUID(str(x["evidence_id"])) for x in d.evidence_refs or [] if x.get("evidence_id")]
    evs = list((await s.execute(select(Evidence).where(Evidence.id.in_(ev_ids)))).scalars()) if ev_ids else []
    result = await s.get(ExecutionResult, d.execution_result_id) if d.execution_result_id else None
    analysis = (result.analysis or {}) if result else {}
    script = (
        await s.get(AutomationScript, result.automation_script_id) if result and result.automation_script_id else None
    )
    g8 = await dsvc.latest_g8(s, d)
    users = await out.users(s, [x for x in (d.confirmed_by, g8.decided_by if g8 else None) if x])
    passing = await dsvc.passing_rerun(s, d) if d.status == DefectStatus.fixed else None
    passing_run = await s.get(ExecutionRun, passing.execution_run_id) if passing else None
    case_key = links["cases"][0] if links["cases"] else None
    return {
        **summary(d, links, p),
        "description": d.description,
        "environment": d.environment,
        "preconditions": d.preconditions,
        "steps": d.steps,
        "expected": d.expected,
        "actual": d.actual,
        "severity_derived": d.severity_derived.value,
        "severity_reason": d.severity_reason,
        "priority_derived": d.priority_derived.value,
        "priority_reason": d.priority_reason,
        "root_cause_hypothesis": d.root_cause_hypothesis,
        "status_reason": d.status_reason,
        "status_comment": d.status_comment,
        "evidence": [
            {**ser.evidence_link(ctx, e).model_dump(mode="json"), "attempt": (e.meta or {}).get("attempt")} for e in evs
        ],
        "result": {"id": result.id, "key": result.key, "status": result.status.value} if result else None,
        "analysis": {k: analysis.get(k) for k in ("classification", "label", "confidence", "signals", "generated_by")}
        if analysis
        else None,
        "script": {"id": script.id, "path": script.path, "version": script.version} if script else None,
        "occurrences": occurrences,
        "g8": {
            "decision": g8.decision.value,
            "by": out.person(users.get(g8.decided_by), see_email=out.sees_email(p.membership.role))
            if g8.decided_by
            else None,
            "at": g8.created_at,
            "comment": g8.comment or None,
        }
        if g8
        else None,
        "verify": {
            "ready": passing is not None,
            "message": f"Passed in {passing_run.key} on {passing.created_at:%d %b}"
            if passing and passing_run
            else (
                f"No passing re-run yet. Re-run {case_key} after the fix to verify it."
                if case_key
                else "No passing re-run yet."
            ),
        }
        if d.status == DefectStatus.fixed
        else None,
        "permissions": {
            "can_edit": _member(p) and d.status in (DefectStatus.draft, DefectStatus.confirmed),
            "can_decide": _approver(p),
        },
    }


async def _defect(s: Any, defect_id: uuid.UUID) -> Defect:
    d: Defect = await c.load(s, Defect, defect_id, "Defect")
    return d


@router.get("/defects/{defect_id}")
async def get_defect(defect_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await detail(ctx, s, p, await _defect(s, defect_id))


@router.get("/projects/{project_id}/defects/by-key/{key}")
async def get_defect_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    d = (await s.execute(select(Defect).where(Defect.project_id == project_id, Defect.key == key))).scalar_one_or_none()
    if d is None:
        raise NotFound(f"We couldn't find {key} in this project.")
    return await detail(ctx, s, p, d)


@router.delete("/defects/{defect_id}")
async def delete_defect(defect_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> None:
    await _defect(s, defect_id)
    raise MethodNotAllowed("Defects can't be deleted. Reject or close it instead; the history stays.")


class DefectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_result_id: uuid.UUID | None = None
    summary: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=10_000)
    preconditions: list[str] | None = Field(default=None, max_length=50)
    steps: list[str] | None = Field(default=None, max_length=100)
    expected: str | None = Field(default=None, max_length=5000)
    actual: str | None = Field(default=None, max_length=5000)
    severity: DefectSeverity | None = None
    priority: Priority | None = None
    test_case_key: str | None = None
    related_to: str | None = None


@router.post("/projects/{project_id}/defects", status_code=201)
async def raise_defect(
    project_id: uuid.UUID, body: DefectInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    """A person raises a defect (blank, or prefilled from a result). Saved as a draft for G8, source "user"."""
    project = await c.project_of(s, project_id)
    result: ExecutionResult | None = None
    case: TestCase | None = None
    fields: dict[str, Any] = {}
    if body.from_result_id:
        result = await c.load(s, ExecutionResult, body.from_result_id, "Result")
        case = await s.get(TestCase, result.test_case_id) if result.test_case_id else None
        if case is not None:
            script = await s.get(AutomationScript, result.automation_script_id) if result.automation_script_id else None
            fields = await dsvc.build_fields(
                s, project, result, case, result.analysis, list(script.assertion_map or []) if script else []
            )
    elif body.test_case_key:
        case = (
            (
                await s.execute(
                    select(TestCase)
                    .where(TestCase.project_id == project_id, TestCase.key == body.test_case_key)
                    .order_by(TestCase.version.desc())
                )
            )
            .scalars()
            .first()
        )
        if case is None:
            raise ValidationFailed(f"{body.test_case_key} is not a test case in this project")
    for k in ("summary", "description", "preconditions", "steps", "expected", "actual"):
        v = getattr(body, k)
        if v is not None:
            fields[k] = v
    errors = []
    if not str(fields.get("summary") or "").strip():
        errors.append({"field": "summary", "message": "Add a summary."})
    if not str(fields.get("actual") or "").strip():
        errors.append({"field": "actual", "message": "Describe the actual result."})
    if errors:
        raise ValidationFailed(errors[0]["message"], details=errors)
    sev = body.severity or fields.get("severity") or DefectSeverity.minor
    pri = body.priority or fields.get("priority") or (dsvc.effective_priority(case) if case else Priority.medium)
    fields.setdefault("severity_derived", fields.get("severity") or sev)
    fields.setdefault("priority_derived", fields.get("priority") or pri)
    fields["severity"], fields["priority"] = sev, pri
    fields.setdefault("severity_reason", "set by a person")
    fields.setdefault("priority_reason", f"from {case.key}" if case else "set by a person")
    fields.setdefault("environment", {})
    if result is None and "reproducibility" not in fields:
        fields["reproducibility"] = {}
    d = await dsvc.create_defect(
        s,
        project,
        fields,
        source=DefectSource.user,
        result=result,
        case=case,
        user_id=p.user.id,
        related_to=body.related_to,
    )
    await s.commit()
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="defect.drafted",
        message=f"{d.key} raised by {p.user.full_name or p.user.email}",
        stage_key=StageKey.defects_summary.value,
        data={"kind": "result", "defect_key": d.key},
    )
    return await detail(ctx, s, p, d)


class DefectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    summary: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=10_000)
    preconditions: list[str] | None = Field(default=None, max_length=50)
    steps: list[str] | None = Field(default=None, max_length=100)
    expected: str | None = Field(default=None, max_length=5000)
    actual: str | None = Field(default=None, max_length=5000)
    severity: DefectSeverity | None = None
    severity_reason: str | None = Field(default=None, max_length=1000)
    priority: Priority | None = None
    priority_reason: str | None = Field(default=None, max_length=1000)
    change_reason: str | None = Field(default=None, max_length=1000)


@router.patch("/defects/{defect_id}")
async def edit_defect(
    defect_id: uuid.UUID, body: DefectPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    d = await _defect(s, defect_id)
    if d.status not in (DefectStatus.draft, DefectStatus.confirmed):
        raise Conflict("Only drafts and confirmed defects can be edited")
    c.check_version(d, body.version)
    before = dsvc.snapshot(d)
    for k in ("summary", "description", "preconditions", "steps", "expected", "actual"):
        v = getattr(body, k)
        if v is not None:
            setattr(d, k, v)
    if body.summary is not None and not body.summary.strip():
        raise ValidationFailed("Add a summary.", details=[{"field": "summary", "message": "Add a summary."}])
    for field, reason_field in (("severity", "severity_reason"), ("priority", "priority_reason")):
        v = getattr(body, field)
        if v is not None and v != getattr(d, field):
            why = (getattr(body, reason_field) or "").strip()
            if not why:
                msg = f"Explain why you changed the {field}."
                raise ValidationFailed(msg, details=[{"field": reason_field, "message": msg}])
            setattr(d, field, v)
            setattr(d, reason_field, f"set by {p.user.full_name or p.user.email}: {why}")
    after = dsvc.snapshot(d)
    changes = revisions.diff(before, after)
    if not changes:
        return await detail(ctx, s, p, d)
    d.version += 1
    project = await c.project_of(s, d.project_id)
    await revisions.record(
        s,
        org_id=project.organisation_id,
        project_id=project.id,
        entity_type="defect",
        entity_id=d.id,
        lineage_id=d.id,
        version=d.version,
        snapshot=after,
        changes=changes,
        changed_by=p.user.id,
        change_reason=body.change_reason,
    )
    from app.services.audit import audit

    audit(
        s,
        org_id=project.organisation_id,
        action="defect.updated",
        target_type="defect",
        target_id=d.id,
        actor_user_id=p.user.id,
        project_id=project.id,
        metadata={"key": d.key, "fields": sorted(changes)},
    )
    await s.commit()
    return await detail(ctx, s, p, d)


class StatusInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["confirm", "reject", "fixed", "verified", "closed"]
    reason: Literal["not_a_defect", "duplicate", "works_as_intended", "cannot_reproduce", "test_problem"] | None = None
    comment: str | None = Field(default=None, max_length=2000)
    duplicate_of: str | None = Field(default=None, max_length=32)


async def _after_g8(ctx: Ctx, project: Project, keys: list[str], action: str) -> None:
    if action in ("confirm", "reject") and keys:
        verb = "confirmed" if action == "confirm" else "rejected"
        await ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type=f"defect.{verb}",
            message=f"{', '.join(keys[:5])}{'…' if len(keys) > 5 else ''} {verb} at Gate 8",
            stage_key=StageKey.defects_summary.value,
            data={"kind": "gate", "gate": "G8", "count": len(keys)},
        )


@router.post("/defects/{defect_id}/status")
async def defect_status(
    defect_id: uuid.UUID, body: StatusInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    d = await _defect(s, defect_id)
    project = await c.project_of(s, d.project_id)
    try:
        message = await dsvc.set_status(
            s,
            project,
            d,
            p.user,
            body.action,
            member=_member(p),
            approver=_approver(p),
            reason=body.reason,
            comment=body.comment,
            duplicate_of=body.duplicate_of,
        )
    except PermissionError as exc:
        raise Forbidden(str(exc)) from exc
    await s.commit()
    await _after_g8(ctx, project, [d.key], body.action)
    return {"message": message, "defect": await detail(ctx, s, p, d)}


class BulkInput(StatusInput):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


@router.post("/projects/{project_id}/defects/bulk-status")
async def bulk_status(
    project_id: uuid.UUID, body: BulkInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    """Many defects at once (decision D11: bulk allowed). Non-applicable ones are skipped with a reason."""
    project = await c.project_of(s, project_id)
    if body.action in ("confirm", "reject", "verified") and not _approver(p):
        raise Forbidden("Confirming or rejecting defects needs gate-approval permission")
    if not _member(p):
        raise Forbidden("Viewers have read-only access")
    if body.action == "reject" and (not body.reason or not (body.comment or "").strip()):
        raise ValidationFailed("Choose a reason and add a comment to reject.")
    rows = list(
        (await s.execute(select(Defect).where(Defect.project_id == project_id, Defect.id.in_(body.ids)))).scalars()
    )
    done: list[str] = []
    skipped: list[dict[str, str]] = []
    for d in sorted(rows, key=lambda x: x.key):
        why = dsvc.can_do(d, body.action, member=_member(p), approver=_approver(p))
        if why is not None:
            skipped.append({"key": d.key, "reason": why})
            continue
        try:
            await dsvc.set_status(
                s,
                project,
                d,
                p.user,
                body.action,
                member=True,
                approver=_approver(p),
                reason=body.reason,
                comment=body.comment,
                duplicate_of=body.duplicate_of,
            )
        except Conflict as exc:
            skipped.append({"key": d.key, "reason": exc.message})
            continue
        done.append(d.key)
    missing = len(body.ids) - len(rows)
    await s.commit()
    await _after_g8(ctx, project, done, body.action)
    verb = {
        "confirm": "confirmed",
        "reject": "rejected",
        "fixed": "marked fixed",
        "verified": "verified",
        "closed": "closed",
    }[body.action]
    msg = f"{len(done)} defect{'s' if len(done) != 1 else ''} {verb}."
    if skipped or missing:
        msg += f" {len(skipped) + missing} skipped."
    return {"done": done, "skipped": skipped, "message": msg}


@router.get("/defects/{defect_id}/revisions")
async def defect_revisions(defect_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> list[dict[str, Any]]:
    d = await _defect(s, defect_id)
    rows = list(
        (
            await s.execute(
                select(EntityRevision)
                .where(EntityRevision.entity_type == "defect", EntityRevision.lineage_id == d.id)
                .order_by(EntityRevision.version.desc())
            )
        ).scalars()
    )
    users = await out.users(s, [r.changed_by for r in rows])
    return [
        {
            "version": r.version,
            "changes": r.changes,
            "source": r.source,
            "change_reason": r.change_reason,
            "changed_by": out.person(users.get(r.changed_by), see_email=out.sees_email(p.membership.role))
            if r.changed_by
            else None,
            "created_at": r.created_at,
        }
        for r in rows
    ]


@router.get("/defects/{defect_id}/occurrences")
async def defect_occurrences(
    defect_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> list[dict[str, Any]]:
    d = await _defect(s, defect_id)
    return list((await detail(ctx, s, p, d))["occurrences"])
