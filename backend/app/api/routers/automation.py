"""Automation (P4-02, P4-03a, P4-04) and risky-action approvals (P4-05).

Reads are open to every member of the organisation (viewers included); validating needs a member; reviewing an
AI-written script (G6, decision D10) and deciding an approval need `can_approve`. Scripts are read-only (D13): there
is no write endpoint for code. Objects of another organisation are 404 through the tenant-scoped session.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.api.routers import p2common as c
from app.automation.toolkit import ToolkitError
from app.context import AppContext
from app.db.models import (
    Approval,
    AutomationAssessment,
    AutomationAsset,
    AutomationScript,
    Project,
    StageRun,
)
from app.domain.automation import side_effects as fx
from app.domain.enums import (
    ApprovalKind,
    AssetKind,
    AutomationSuitability,
    Role,
    ScriptGeneratedBy,
    ScriptStatus,
    StageKey,
)
from app.orchestrator.orchestrator import Orchestrator
from app.services import approvals as apr
from app.services import automation as svc
from app.services import automation_export as xport
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.secrets import credentials_secret

router = APIRouter(tags=["automation"])
log = logging.getLogger(__name__)

CHECK_NAMES = ("guard", "tsc", "eslint", "secret_scan", "tags", "locators")


# ------------------------------------------------------------------ helpers


def _require_approver(p: Principal, message: str) -> None:
    if p.membership.role == Role.viewer or not p.scope.can_approve:
        raise Forbidden(message)


def _check_states(validation: dict[str, Any] | None, status: ScriptStatus) -> dict[str, str]:
    """Per check: ok | failed | not_checked (design P4 §6.3 checks row)."""
    v = validation or {}
    states: dict[str, str] = {}
    for name in CHECK_NAMES:
        chk = v.get(name)
        if not chk or chk.get("not_checked") or status == ScriptStatus.draft:
            states[name] = "not_checked"
        elif not chk.get("ok"):
            states[name] = "failed"
        elif name == "locators" and any(m.get("not_checked") for m in chk.get("messages") or []):
            states[name] = "not_checked"
        else:
            states[name] = "ok"
    return states


def _locator_counts(validation: dict[str, Any] | None) -> dict[str, int]:
    msgs = ((validation or {}).get("locators") or {}).get("messages") or []
    failed = sum(1 for m in msgs if not m.get("not_checked"))
    not_checked = sum(1 for m in msgs if m.get("not_checked"))
    return {"failed": failed, "not_checked": not_checked}


async def _bundle(s: ScopedSession, project_id: uuid.UUID, version: int | None) -> tuple[StageRun | None, bool]:
    current = await svc.current_run(s, project_id, StageKey.automation)
    if version is None or (current is not None and current.version == version):
        return current, True
    run = await svc.run_by_version(s, project_id, StageKey.automation, version)
    if run is None:
        raise NotFound("Scripts version not found")
    return run, False


def _asset_state(a: AutomationAsset, output: dict[str, Any]) -> str:
    if a.generated_by == ScriptGeneratedBy.platform:
        return "platform"
    checks = ((output.get("validation") or {}).get("assets") or {}).get(a.path)
    if not checks:
        return "not_checked"
    if any(chk and not chk.get("ok") for chk in checks.values()):
        return "invalid"
    for item in (output.get("locators") or {}).get(a.path, []):
        if item.get("status") in ("missing", "multiple"):
            return "invalid"
    return "valid"


def _script_row(x: AutomationScript, keys: dict[uuid.UUID, tuple[str, str]]) -> dict[str, Any]:
    key, title = keys.get(x.test_case_id, ("", ""))
    return {
        "id": x.id,
        "case_key": key,
        "case_title": title,
        "test_case_id": x.test_case_id,
        "case_lineage_id": x.case_lineage_id,
        "case_version": x.case_version,
        "path": x.path,
        "version": x.version,
        "generated_by": x.generated_by.value,
        "status": svc.script_state(x),
        "checks": _check_states(x.validation, x.status),
        "locators": _locator_counts(x.validation),
        "first_problem": _first_problem(x),
    }


def _first_problem(x: AutomationScript) -> str | None:
    if x.status != ScriptStatus.invalid:
        return None
    for name in CHECK_NAMES:
        chk = (x.validation or {}).get(name) or {}
        if not chk.get("ok", True):
            for m in chk.get("messages") or []:
                if not m.get("not_checked"):
                    return str(m.get("message"))
    return None


async def _case_info(s: ScopedSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[str, str]]:
    from app.db.models import TestCase

    if not ids:
        return {}
    return {
        r.id: (r.key, r.title) for r in (await s.execute(select(TestCase).where(TestCase.id.in_(set(ids))))).scalars()
    }


# ------------------------------------------------------------------ export (P4-10)


async def _export_rows(
    s: ScopedSession, scripts: list[AutomationScript], info: dict[uuid.UUID, tuple[str, str]]
) -> list[tuple[AutomationScript, str, str]]:
    """The script each case would run (a rejected AI script falls back to its rules script), with its state.
    Outdated scripts are left out of the export entirely: their case changed after the bundle was written."""
    rows: list[tuple[AutomationScript, str, str]] = []
    for x in scripts:
        state = svc.script_state(x)
        if state == "outdated":
            continue
        if state == "valid" and not svc.runnable(x):
            state = "needs_review"
        if state == "rejected" and (fb := await svc.rules_fallback(s, x)) is not None:
            x, state = fb, "valid"
        rows.append((x, info.get(x.test_case_id, ("", ""))[0], state))
    return rows


def _export_summary(rows: list[tuple[AutomationScript, str, str]]) -> dict[str, Any]:
    left = [(key, state) for _x, key, state in rows if state != "valid"]
    return {
        "scripts": sum(1 for _x, _k, state in rows if state == "valid"),
        "left_out": [{"case_key": k, "reason": xport.LEFT_OUT_REASON.get(st, "can't run")} for k, st in left],
    }


async def _recheck(ctx: AppContext, assets: list[AutomationAsset], scripts: list[AutomationScript]) -> set[str]:
    """Re-runs the guard and TypeScript checks on the specs about to be zipped (roadmap P4-10 "Zip safety"), as a run
    does before it starts; returns the paths that fail. Refuses the export when the checks can't run at all."""
    if not scripts:
        return set()
    ws = svc.workspace(ctx, f"export-{uuid.uuid4().hex}")
    try:
        await ctx.toolkit.init(ws)
        files = {a.path: a.code for a in assets if a.generated_by.value != "platform"}
        files.update({x.path: x.code for x in scripts})
        svc.write_bundle(ws, files)
        report = await ctx.toolkit.validate(ws, [x.path for x in scripts])
    except (ToolkitError, OSError) as exc:
        log.info("export re-check failed: %s", str(exc).splitlines()[0][:200] if str(exc) else type(exc).__name__)
        raise Conflict(
            "The scripts couldn't be checked again before zipping, so nothing was exported. Try again."
        ) from exc
    finally:
        shutil.rmtree(ws, ignore_errors=True)
    checked = report.get("files") or {}
    return {
        x.path
        for x in scripts
        if x.path not in checked
        or not (
            (checked[x.path].get("guard") or {}).get("ok", False)
            and (checked[x.path].get("tsc") or {}).get("ok", False)
        )
    }


@router.get("/projects/{project_id}/automation/export")
async def export_project(
    project_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    p: MemberPrincipal,
    version: int | None = Query(default=None, ge=1),
) -> Response:
    """Standalone Playwright project (zip) for the shown scripts version, with CI templates (design P4 §6.2)."""
    from datetime import UTC, datetime

    from app.agents.reporting.phase4_reports import host_of

    project = await c.project_of(s, project_id)
    run, _current = await _bundle(s, project_id, version)
    if run is None:
        raise Conflict("Scripts haven't been written yet")
    scripts, assets = await svc.bundle_rows(s, run.id)
    rows = await _export_rows(s, scripts, await _case_info(s, [x.test_case_id for x in scripts]))
    if not any(state == "valid" for _x, _k, state in rows):
        raise Conflict("No script can run yet, so there is nothing to export")
    included = [x for x, _k, state in rows if state == "valid" and x.status == ScriptStatus.valid]
    effects = await apr.script_effects(s, project_id, included)
    specs = {
        path: xport.SpecInfo(no_retry=bool(e.needs_approval), signs_in=any(x.kind == fx.SIGNS_IN for x in e.effects))
        for path, e in effects.items()
    }
    exp = xport.build(
        project_name=project.name,
        host=await host_of(s, project_id),
        base_url=(await apr.target(s, project_id))[0],
        version=run.version,
        scripts=rows,
        assets=assets,
        at=datetime.now(UTC),
        specs=specs,
        failed_recheck=await _recheck(ctx, assets, included),
    )
    audit(s, org_id=project.organisation_id, action="automation.exported", target_type="stage_run",
          target_id=run.id, actor_user_id=p.user.id, project_id=project.id,
          metadata={"bundle_version": run.version, "scripts": len(exp.scripts), "left_out": len(exp.left_out)})  # fmt: skip
    await s.commit()
    return Response(
        exp.data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{exp.file_name}"', "Cache-Control": "no-store"},
    )


# ------------------------------------------------------------------ assessment (P4-02)


@router.get("/projects/{project_id}/automation/assessment")
async def get_assessment(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    st = await svc.stage(s, project_id, StageKey.automation_assessment)
    run = await svc.current_run(s, project_id, StageKey.automation_assessment)
    decision = await svc.last_g5(s, project_id)
    saved = await credentials_secret(s, project_id) is not None
    cases: list[dict[str, Any]] = []
    counts = {v.value: 0 for v in AutomationSuitability}
    if run is not None:
        rows = list(
            (await s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == run.id))).scalars()
        )
        info = await _case_info(s, [r.test_case_id for r in rows])
        for r in sorted(rows, key=lambda x: info.get(x.test_case_id, ("", ""))[0]):
            key, title = info.get(r.test_case_id, ("", ""))
            counts[r.suitability.value] += 1
            cases.append(
                {
                    "test_case_id": r.test_case_id,
                    "case_lineage_id": r.case_lineage_id,
                    "key": key,
                    "title": title,
                    "case_version": r.case_version,
                    "suitability": r.suitability.value,
                    "reasons": list(r.reasons or []),
                    "blockers": list(r.blockers or []),
                }
            )
    return {
        "status": st.status.value,
        "stale_reason": st.stale_reason,
        "g5_approved": decision is not None,
        "g5_decided_at": decision.created_at if decision else None,
        "credentials_saved": saved,
        "run": {"id": run.id, "version": run.version, "finished_at": run.finished_at} if run else None,
        "counts": {**counts, "total": len(cases)},
        "cases": cases,
    }


# ------------------------------------------------------------------ bundle (P4-03a, P4-04)


@router.get("/projects/{project_id}/automation")
async def get_automation(
    project_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    p: CurrentPrincipal,
    version: int | None = Query(default=None, ge=1),
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    st = await svc.stage(s, project_id, StageKey.automation)
    run, is_current = await _bundle(s, project_id, version)
    decision = await svc.last_g5(s, project_id)
    versions = [
        {"version": r.version, "created_at": r.created_at, "finished_at": r.finished_at}
        for r in (
            await s.execute(
                select(StageRun).where(StageRun.workflow_stage_id == st.id).order_by(StageRun.version.desc())
            )
        ).scalars()
        if r.finished_at is not None
    ]
    bundle: dict[str, Any] | None = None
    has_ai = False
    if run is not None:
        scripts, assets = await svc.bundle_rows(s, run.id)
        info = await _case_info(s, [x.test_case_id for x in scripts])
        output = dict(run.output or {})
        has_ai = any(x.generated_by == ScriptGeneratedBy.ai for x in scripts)
        rows = [_script_row(x, info) for x in scripts]
        live = [r for r in rows if r["status"] != "outdated"]
        bundle = {
            "id": run.id,
            "version": run.version,
            "status": run.status.value,
            "created_at": run.created_at,
            "finished_at": run.finished_at,
            "is_current": is_current,
            "generated_by": "mixed"
            if has_ai and any(x.generated_by == ScriptGeneratedBy.rules for x in scripts)
            else ("ai" if has_ai else "rules"),
            "counts": {
                **(output.get("counts") or {}),
                "valid": sum(1 for r in live if r["status"] == "valid"),
                "invalid": sum(1 for r in live if r["status"] == "invalid"),
                "not_checked": sum(1 for r in live if r["status"] == "not_checked"),
                "needs_review": sum(1 for r in live if r["status"] == "needs_review"),
                "rejected": sum(1 for r in live if r["status"] == "rejected"),
                "outdated": sum(1 for r in rows if r["status"] == "outdated"),
                "locators_not_checked": sum(
                    1 for r in live if r["checks"]["locators"] == "not_checked" and r["status"] == "valid"
                ),
            },
            "validation": {k: v for k, v in (output.get("validation") or {}).items() if k != "assets"},
            "not_automated": output.get("not_automated") or [],
            "ai_checks": [str(i.get("message")) for i in (output.get("ai") or {}).get("issues") or []],
            "export": _export_summary(await _export_rows(s, scripts, info)),
            "scripts": rows,
            "assets": [
                {
                    "id": a.id,
                    "path": a.path,
                    "kind": a.kind.value,
                    "generated_by": a.generated_by.value,
                    "version": a.version,
                    "status": _asset_state(a, output),
                }
                for a in assets
            ],
        }
    pre = await svc.g6_preconditions(s, project)
    g6 = svc.g6_summary(pre, st, has_ai)
    g6["decided_at"] = run.finished_at if run is not None and g6["state"] == "passed_automatically" else None
    return {
        "stage": {"status": st.status.value, "gate_status": st.gate_status.value, "stale_reason": st.stale_reason},
        "g5": {
            "approved": decision is not None,
            "decided_at": decision.created_at if decision else None,
            "design_version": int((decision.stage_run_versions or {}).get("test_design") or 0) if decision else None,
        },
        "toolkit_problem": ctx.toolkit.problem(),
        "credentials_saved": await credentials_secret(s, project_id) is not None,
        "bundle": bundle,
        "versions": versions,
        "g6": g6,
        "permissions": {
            "can_edit": p.membership.role != Role.viewer,
            "can_approve": p.membership.role != Role.viewer and p.scope.can_approve,
        },
    }


async def _script(s: ScopedSession, script_id: uuid.UUID) -> AutomationScript:
    row: AutomationScript = await c.load(s, AutomationScript, script_id, "Script")
    return row


@router.get("/automation-scripts/{script_id}")
async def get_script(script_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    x = await _script(s, script_id)
    run = (await s.execute(select(StageRun).where(StageRun.id == x.stage_run_id))).scalar_one()
    _decision, cases = await svc.approved_cases(s, x.project_id)
    case = next((ac for ac in cases if ac.row.lineage_id == x.case_lineage_id), None)
    info = await _case_info(s, [x.test_case_id])
    key, title = info.get(x.test_case_id, ("", ""))
    steps = {st.n: st for st in case.case.steps} if case is not None and case.case.version == x.case_version else {}
    amap = [
        {**m, "step_text": steps[m["step"]].action if isinstance(m.get("step"), int) and m["step"] in steps else None}
        for m in x.assertion_map or []
    ]
    current = await svc.current_run(s, x.project_id, StageKey.automation)
    us = await out.users(s, [uuid.UUID(str((x.review or {}).get("decided_by")))] if (x.review or {}).get("decided_by")
                         else [])  # fmt: skip
    review = dict(x.review or {})
    if review.get("decided_by"):
        review["decided_by"] = out.person(
            us.get(uuid.UUID(str(review["decided_by"]))), see_email=out.sees_email(p.membership.role)
        )
    return {
        **_script_row(x, info),
        "code": x.code,
        "sha256": x.sha256,
        "validation": x.validation or {},
        "assertion_map": amap,
        "review": review or None,
        "bundle": {"id": run.id, "version": run.version, "is_current": current is not None and current.id == run.id},
        "case": {
            "id": x.test_case_id,
            "key": key,
            "title": title,
            "version": x.case_version,
            "requirement_keys": list(case.case.requirement_keys) if case else [],
        },
        "can_review": x.generated_by == ScriptGeneratedBy.ai
        and p.membership.role != Role.viewer
        and p.scope.can_approve,
    }


@router.get("/automation-scripts/{script_id}/versions")
async def script_versions(script_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    x = await _script(s, script_id)
    rows = list(
        (
            await s.execute(
                select(AutomationScript)
                .where(
                    AutomationScript.project_id == x.project_id, AutomationScript.case_lineage_id == x.case_lineage_id
                )
                .order_by(AutomationScript.version, AutomationScript.created_at)
            )
        ).scalars()
    )
    seen: dict[int, AutomationScript] = {}
    for r in rows:
        seen.setdefault(r.version, r)
    items = sorted(seen.values(), key=lambda r: r.version)
    out_rows: list[dict[str, Any]] = []
    prev: AutomationScript | None = None
    for r in items:
        if prev is None:
            cause = "First version"
        elif r.case_version != prev.case_version:
            cause = "Test case changed"
        elif r.generated_by == ScriptGeneratedBy.heal:
            cause = "Fix suggestion accepted"
        else:
            cause = "Script generator changed"
        out_rows.append(
            {"id": r.id, "version": r.version, "case_version": r.case_version, "created_at": r.created_at,
             "generated_by": r.generated_by.value, "cause": cause, "code": r.code}
        )  # fmt: skip
        prev = r
    return list(reversed(out_rows))


@router.get("/automation-assets/{asset_id}")
async def get_asset(asset_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    a: AutomationAsset = await c.load(s, AutomationAsset, asset_id, "File")
    run = (await s.execute(select(StageRun).where(StageRun.id == a.stage_run_id))).scalar_one()
    output = dict(run.output or {})
    locators = None
    if a.kind == AssetKind.page_object:
        locators = [
            {
                "element": i.get("element"),
                "getter": i.get("getter"),
                "how": _how(i),
                "fallback": i.get("fallback") or None,
                "status": i.get("status") or "not_checked",
                "count": i.get("count"),
                "reason": i.get("reason"),
                "used_by": list(i.get("used_by") or []),
            }
            for i in (output.get("locators") or {}).get(a.path, [])
        ]
    return {
        "id": a.id,
        "path": a.path,
        "kind": a.kind.value,
        "generated_by": a.generated_by.value,
        "version": a.version,
        "status": _asset_state(a, output),
        "code": a.code,
        "checks": ((output.get("validation") or {}).get("assets") or {}).get(a.path),
        "page_path": (output.get("pages") or {}).get(a.path),
        "locators": locators,
        "bundle": {"id": run.id, "version": run.version},
    }


def _how(i: dict[str, Any]) -> str:
    from app.domain.automation.emit import Locator

    loc = Locator(str(i.get("getter") or ""), str(i.get("element") or ""), str(i.get("by") or "css"),
                  name=str(i.get("name") or ""), role=str(i.get("role") or ""), exact=bool(i.get("exact")),
                  within=str(i.get("within") or ""), css=str(i.get("css") or ""))  # fmt: skip
    return loc.ts().replace("this.page.", "")


# ------------------------------------------------------------------ validation (P4-04)


async def _start_validation(
    ctx: Ctx, s: ScopedSession, p: Principal, project: Project, run: StageRun, script_ids: list[uuid.UUID] | None
) -> dict[str, Any]:
    problem = ctx.toolkit.problem()
    if problem is not None:
        raise Conflict(f"Scripts can't be checked on this server: {problem}")
    output = dict(run.output or {})
    if (output.get("validation") or {}).get("status") == "running":
        return {"status": "running"}
    output["validation"] = {**(output.get("validation") or {}), "status": "running"}
    run.output = output
    audit(s, org_id=project.organisation_id, action="automation.validation_requested", target_type="stage_run",
          target_id=run.id, actor_user_id=p.user.id, project_id=project.id,
          metadata={"bundle_version": run.version, "scripts": len(script_ids) if script_ids else "all"})  # fmt: skip
    await s.commit()
    await ctx.queue.enqueue(
        "automation_validate",
        {"project_id": str(project.id), "stage_run_id": str(run.id),
         "script_ids": [str(x) for x in script_ids] if script_ids else []},
        org_id=project.organisation_id,
        project_id=project.id,
        dedupe_key=f"automation_validate:{run.id}:{','.join(sorted(str(x) for x in script_ids or []))}",
    )  # fmt: skip
    return {"status": "running"}


@router.post("/projects/{project_id}/automation/validate", status_code=202)
async def validate_bundle(
    project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal, version: int | None = Query(default=None)
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    run, _current = await _bundle(s, project_id, version)
    if run is None or run.finished_at is None:
        raise Conflict("Scripts haven't been written yet")
    return await _start_validation(ctx, s, p, project, run, None)


@router.post("/automation-scripts/{script_id}/validate", status_code=202)
async def validate_script(script_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    x = await _script(s, script_id)
    if x.status == ScriptStatus.outdated:
        raise Conflict("This script is outdated: its test case changed. Regenerate the scripts instead.")
    project = await c.project_of(s, x.project_id)
    run = (await s.execute(select(StageRun).where(StageRun.id == x.stage_run_id))).scalar_one()
    return await _start_validation(ctx, s, p, project, run, [x.id])


# ------------------------------------------------------------------ G6 review of AI-written scripts (D10)


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]
    comment: str | None = Field(default=None, max_length=2000)


@router.post("/automation-scripts/{script_id}/review")
async def review_script(
    script_id: uuid.UUID, body: ReviewInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    x = await _script(s, script_id)
    _require_approver(p, "Reviewing scripts needs gate-approval permission")
    if x.generated_by != ScriptGeneratedBy.ai:
        raise Conflict("Only scripts written by AI need a review; scripts written by rules need no sign-off")
    if x.status == ScriptStatus.outdated:
        raise Conflict("This script is outdated: its test case changed")
    current = await svc.current_run(s, x.project_id, StageKey.automation)
    if current is None or current.id != x.stage_run_id:
        raise Conflict("These scripts were replaced by a newer version; reload to continue")
    comment = (body.comment or "").strip()
    if body.decision == "reject" and not comment:
        raise ValidationFailed(
            "Say what's wrong with this script.",
            details=[{"field": "comment", "message": "Say what's wrong with this script."}],
        )
    if body.decision == "approve" and x.status != ScriptStatus.valid:
        raise Conflict("Only a script that passed its checks can be approved")
    from app.db.types import utcnow

    x.review = {"decision": body.decision, "comment": comment or None, "decided_by": str(p.user.id),
                "decided_at": utcnow().isoformat()}  # fmt: skip
    # Open question 6: a rejected AI script falls back to the case's rules script when the bundle keeps one.
    fallback = await svc.rules_fallback(s, x) if body.decision == "reject" else None
    info = await _case_info(s, [x.test_case_id])
    key = info.get(x.test_case_id, ("", ""))[0]
    project = await c.project_of(s, x.project_id)
    audit(s, org_id=project.organisation_id, action="automation_script.reviewed", target_type="automation_script",
          target_id=x.id, actor_user_id=p.user.id, project_id=project.id,
          metadata={"decision": body.decision, "case": key, "version": x.version,
                    "fallback": str(fallback.id) if fallback else None})  # fmt: skip
    await s.commit()
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="automation_script.reviewed",
        message=f"{key} script {'approved' if body.decision == 'approve' else 'rejected'} in review",
        stage_key=StageKey.automation.value,
        data={"kind": "review", "decision": body.decision},
    )
    await Orchestrator(ctx).finalise_g6(p.scope, project.id)
    if body.decision == "approve":
        message = "Script approved."
    elif fallback is not None:
        message = f"Script rejected. {key} will use its rules script."
    else:
        message = f"Script rejected. {key} is not automated: script rejected in review."
    return {"id": x.id, "status": "approved" if body.decision == "approve" else "rejected", "message": message,
            "fallback_script_id": fallback.id if fallback else None}  # fmt: skip


# ------------------------------------------------------------------ run scope preview and approvals (P4-05)


class SelectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    suite: Literal["smoke", "regression", "all_approved"] | None = None
    case_keys: list[str] | None = Field(default=None, max_length=1000)


Browser = Literal["chromium", "firefox", "webkit"]
Viewport = Literal["desktop", "mobile"]


class PreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selection: SelectionInput = Field(default_factory=SelectionInput)
    browsers: list[Browser] = Field(default_factory=lambda: list[Browser](["chromium"]))
    viewports: list[Viewport] = Field(default_factory=lambda: list[Viewport](["desktop"]))


@router.post("/projects/{project_id}/execution-runs/preview")
async def preview_run(
    project_id: uuid.UUID, body: PreviewInput, s: ScopedSession, _p: MemberPrincipal
) -> dict[str, Any]:
    """Dry-run read of a run request's scope (design §7.1–7.2). Creates nothing and never contacts the site."""
    project = await c.project_of(s, project_id)
    suite = body.selection.suite if body.selection.case_keys is None else None
    return await apr.run_scope(
        s, project, suite=suite or ("all_approved" if body.selection.case_keys is None else None),
        case_keys=body.selection.case_keys, browsers=list(body.browsers), viewports=list(body.viewports),
    )  # fmt: skip


@router.get("/approvals/{approval_id}")
async def get_approval(approval_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    a: Approval = await c.load(s, Approval, approval_id, "Approval")
    if await apr.expire_due(s, [a]):
        await s.commit()
    return await apr.approval_dict(
        s,
        a,
        can_decide=p.membership.role != Role.viewer and p.scope.can_approve,
        see_email=out.sees_email(p.membership.role),
    )


class DecisionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]
    comment: str | None = Field(default=None, max_length=2000)
    confirm_text: str | None = Field(default=None, max_length=300)


@router.post("/approvals/{approval_id}/decision")
async def decide_approval(
    approval_id: uuid.UUID, body: DecisionInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    a: Approval = await c.load(s, Approval, approval_id, "Approval")
    if a.kind == ApprovalKind.load_test:
        # P5-01b (decision D18): a load test's approval; the response is the load test.
        from app.api.routers.nonfunctional import decide_load_test

        _require_approver(p, "Approving load tests needs approval permission")
        return await decide_load_test(ctx, s, p, a, decision=body.decision, comment=body.comment,
                                      confirm_text=body.confirm_text)  # fmt: skip
    _require_approver(p, "Deciding approvals needs gate-approval permission")
    try:
        await apr.decide(s, a, decision=body.decision, comment=body.comment, confirm_text=body.confirm_text,
                         user=p.user)  # fmt: skip
    except Conflict:
        await s.commit()  # keep an `expired` transition
        raise
    await s.commit()
    run_key = (a.scope or {}).get("run_key")
    await ctx.events.emit(
        org_id=a.organisation_id,
        project_id=a.project_id,
        type=f"approval.{a.status.value}",
        message=f"{a.key} {'approved' if a.status.value == 'approved' else 'not approved'}"
        + (f" for {run_key}" if run_key else ""),
        data={"kind": "approval", "key": a.key, "approval_kind": a.kind.value},
    )
    return await apr.approval_dict(s, a, can_decide=True, see_email=out.sees_email(p.membership.role))
