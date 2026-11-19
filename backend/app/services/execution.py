"""Test runs and Gate 7 (P4-06; decisions D7, D8, D9, D12; design P4 §7–§8; open questions 1, 3, 7).

A run request (`RUN-0001`) freezes its scope when it is created: the runnable scripts of the current bundle (by
id and sha256), browsers, screen sizes, what the tests may do on the site and the separate approvals they need. It
is immutable from then on. G7 authorises exactly that scope (its hash is stored on the decision); every run needs
its own authorisation, and an approver may authorise their own request ("Requested and authorised by {name}").
A run can't be authorised while one of its approvals is undecided (open question 1), and a waiting request
expires after 7 days or as soon as one of its scripts changes (open question 3).

Results come only from Playwright's JSON reporter (the engine, `app.agents.execution.engine`). Nothing here sets a
result status.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, Forbidden, GateBlocked, ValidationFailed
from app.context import AppContext
from app.db.models import (
    Approval,
    Defect,
    DefectOccurrence,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    Project,
    StageRun,
    User,
)
from app.db.types import utcnow
from app.domain.enums import (
    ApprovalKind,
    ApprovalStatus,
    GateDecisionKind,
    GateKey,
    GateSubjectType,
    ResultStatus,
    RunMode,
    RunStatus,
    StageKey,
)
from app.services import approvals as apr
from app.services.audit import audit
from app.services.counters import next_key

WORKERS = 2
MAX_WORKERS = 4
RETRIES = 1  # decision D9
TEST_TIMEOUT_S = 60
RUN_LIMIT_S = 30 * 60
EXECUTION_GROUP = "execution"  # job concurrency group: 2 active runs per organisation (1 per project in the job)
SUITE_TEXT = {"smoke": "Smoke", "regression": "Regression", "all_approved": "All automated"}
VIEWPORT_TEXT = {"desktop": "Desktop", "mobile": "Mobile"}
CANCELLED = "Run cancelled"
STOPPED_CANCELLED = "Stopped: run cancelled"  # the test was running when the run was cancelled (QA P4-BUG-06)
TIME_LIMIT = "Run time limit reached"
WORKER_STOPPED = "The worker stopped; the run did not complete"
# Rows that are not results: never analysed, never a case's last result.
NOT_RESULTS = (CANCELLED, STOPPED_CANCELLED, WORKER_STOPPED)
# Errors whose text is the reason the test didn't finish, shown in the run's list (`error_reason`).
INTERRUPTED = (*NOT_RESULTS, TIME_LIMIT)
FINISHED = (RunStatus.passed, RunStatus.failed, RunStatus.error, RunStatus.cancelled, RunStatus.rejected)


def _aware(d: datetime | None) -> datetime | None:
    return None if d is None else (d if d.tzinfo is not None else d.replace(tzinfo=UTC))


def selection_label(selection: dict[str, Any]) -> str:
    keys = selection.get("case_keys")
    if keys:
        return f"{len(keys)} chosen test case{'s' if len(keys) != 1 else ''}"
    return SUITE_TEXT.get(str(selection.get("suite") or "all_approved"), "All automated")


def size_of(viewport: str) -> str:
    v = apr.VIEWPORTS.get(viewport) or apr.VIEWPORTS["desktop"]
    return f"{v['width']}x{v['height']}"


def plan_of(run_key: str, scope: dict[str, Any]) -> list[dict[str, Any]]:
    """One planned test per case × browser × screen size, keyed RUN-0003-01… in a stable order."""
    plan: list[dict[str, Any]] = []
    for case in scope.get("cases") or []:
        for browser in scope.get("browsers") or ["chromium"]:
            for viewport in scope.get("viewports") or ["desktop"]:
                plan.append(
                    {
                        "key": f"{run_key}-{len(plan) + 1:02d}",
                        "case_key": case["key"],
                        "title": case["title"],
                        "test_case_id": case["test_case_id"],
                        "case_lineage_id": case["case_lineage_id"],
                        "script_id": case["script_id"],
                        "script_version": case["script_version"],
                        "sha256": case["sha256"],
                        "path": case["path"],
                        "browser": browser,
                        "viewport": viewport,
                        "size": size_of(viewport),
                        "retried": bool(case.get("retried", True)),
                        "signs_in": bool(case.get("signs_in")),
                        "blocked": case.get("blocked"),
                    }
                )
    return plan


# ------------------------------------------------------------------ requests


async def create_run(
    ctx: AppContext,
    s: AsyncSession,
    project: Project,
    user: User,
    *,
    suite: str | None,
    case_keys: list[str] | None,
    browsers: list[str],
    viewports: list[str],
    notes: str | None,
    workers: int | None = None,
) -> ExecutionRun:
    """A run request waiting for G7. Never contacts the site."""
    problem = ctx.toolkit.problem()
    if problem is not None:
        raise Conflict(f"Tests can't run on this server: {problem}.")
    scope = await apr.run_scope(
        s,
        project,
        suite=suite if case_keys is None else None,
        case_keys=case_keys,
        browsers=browsers,
        viewports=viewports,
    )
    if case_keys is not None:
        cant = list(scope["left_out"])
        if cant:
            raise Conflict(
                "These test cases can't run: " + ", ".join(f"{x['key']} ({x['reason']})" for x in cant),
                details={"left_out": cant},
            )
    if not scope["cases"]:
        raise Conflict("No script can run yet. Open Automation to see why.", details={"left_out": scope["left_out"]})
    if scope["over_limit"]:
        raise ValidationFailed(str(scope["limit_message"]))
    _n, key = await next_key(s, project.organisation_id, project.id, "run")
    w = max(1, min(int(workers or WORKERS), MAX_WORKERS))
    run = ExecutionRun(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        mode=RunMode.automated,
        selection={"suite": scope["selection"]["suite"], "case_keys": scope["selection"]["case_keys"]},
        scope=scope,
        scope_hash=scope["scope_hash"],
        config={
            "workers": w,
            "retries": RETRIES,
            "test_timeout_s": TEST_TIMEOUT_S,
            "notes": (notes or "").strip()[:500] or None,
            "plan": plan_of(key, scope),
        },
        bundle_version=scope.get("bundle_version"),
        status=RunStatus.awaiting_authorisation,
        totals={},
        requested_by=user.id,
    )
    s.add(run)
    await s.flush()
    await apr.request_approvals(s, project, run, requested_by=user.id)
    audit(
        s,
        org_id=project.organisation_id,
        action="execution_run.requested",
        target_type="execution_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": key, "tests": scope["tests"], "scope_hash": run.scope_hash},
    )
    return run


async def request_problem(s: AsyncSession, run: ExecutionRun) -> str | None:
    """Why a waiting request can't be authorised as it stands (expired, scripts changed), or None."""
    if run.status != RunStatus.awaiting_authorisation:
        return None
    if apr.request_expired(run):
        return "This request expired after 7 days. Request it again."
    approvals = await apr.run_approvals(s, run.id)
    if any(a.status == ApprovalStatus.expired for a in approvals) or any(
        a.status == ApprovalStatus.pending and (_aware(a.expires_at) or utcnow()) <= utcnow() for a in approvals
    ):
        return "This request expired after 24 hours because it includes a separate approval. Request it again."
    changed = await apr.scripts_changed(s, run)
    if changed:
        return (
            f"{changed[0]}'s script changed after this request, so this run can't be authorised as requested. "
            "Request it again."
        )
    return None


async def decide_approvals(
    s: AsyncSession, run: ExecutionRun, user: User, decisions: list[dict[str, Any]]
) -> list[Approval]:
    """Approval decisions sent with the authorisation (design §7.3: one click), matched by kind."""
    approvals = await apr.run_approvals(s, run.id)
    by_kind = {a.kind.value: a for a in approvals}
    for d in decisions:
        a = by_kind.get(str(d.get("kind")))
        if a is None:
            raise ValidationFailed(
                f"This run has no {apr.KIND_WORDS.get(ApprovalKind(d['kind']), d['kind'])} to decide"
            )
        if a.status != ApprovalStatus.pending:
            continue
        await apr.decide(
            s,
            a,
            decision=str(d.get("decision")),
            comment=d.get("comment"),
            confirm_text=d.get("confirm_text"),
            user=user,
        )
    return approvals


async def authorise(
    s: AsyncSession,
    project: Project,
    run: ExecutionRun,
    user: User,
    *,
    decision: str,
    comment: str | None,
    approvals: list[dict[str, Any]] | None = None,
) -> GateDecision:
    """G7 for one run. Approve: approvals decided first, then the run is queued (the caller enqueues the job)."""
    if run.status != RunStatus.awaiting_authorisation:
        raise Conflict(f"{run.key} is not waiting for authorisation", details={"status": run.status.value})
    text = (comment or "").strip()
    if decision == "reject":
        if not text:
            raise ValidationFailed(
                "Say why this run shouldn't go ahead.",
                details=[{"field": "comment", "message": "Say why this run shouldn't go ahead."}],
            )
    else:
        problem = await request_problem(s, run)
        if problem is not None:
            raise Conflict(problem, details={"reason": "request_invalid"})
        await decide_approvals(s, run, user, approvals or [])
        await apr.ensure_decided(s, run)
        if (await apr.scripts_changed(s, run)) or apr.scope_hash(run.scope or {}) != run.scope_hash:
            raise GateBlocked("The scripts changed while you were choosing. Check the summary again.")
    gd = GateDecision(
        organisation_id=project.organisation_id,
        project_id=project.id,
        gate_key=GateKey.G7,
        stage_run_id=None,
        decision=GateDecisionKind.approve if decision == "approve" else GateDecisionKind.reject,
        comment=text,
        decided_by=user.id,
        snapshot_hash=run.scope_hash,
        artefact_snapshot=[
            {"type": "automation_script", "id": i["script_id"], "sha256": i["sha256"]}
            for i in (run.scope or {}).get("cases", [])
        ],
        subject_type=GateSubjectType.execution_run,
        subject_id=run.id,
    )
    s.add(gd)
    await s.flush()
    run.g7_decision_id = gd.id
    if decision == "approve":
        run.status = RunStatus.queued
        skipped = await apr.consume(s, run)
        run.config = {**(run.config or {}), "skipped": skipped}
    else:
        run.status = RunStatus.rejected
        run.finished_at = utcnow()
        for a in await apr.run_approvals(s, run.id):
            if a.status == ApprovalStatus.pending:
                a.status = ApprovalStatus.expired
    audit(
        s,
        org_id=project.organisation_id,
        action=f"execution_run.{'authorised' if decision == 'approve' else 'rejected'}",
        target_type="execution_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": run.key, "scope_hash": run.scope_hash, "self_authorised": run.requested_by == user.id},
    )
    return gd


CANCELLABLE = (RunStatus.awaiting_authorisation, RunStatus.queued, RunStatus.running, RunStatus.recording)


def can_cancel(run: ExecutionRun, user: User, can_approve: bool) -> bool:
    if run.status not in CANCELLABLE:
        return False
    return can_approve or run.requested_by == user.id


async def cancel(s: AsyncSession, project: Project, run: ExecutionRun, user: User, *, can_approve: bool) -> str:
    """Withdraw a request, cancel a queued run, or ask the engine to stop a running one. Returns the toast text."""
    if not can_cancel(run, user, can_approve):
        if run.status in CANCELLABLE:
            raise Forbidden("Only the person who requested this run or someone who can approve gates can cancel it")
        raise Conflict(f"{run.key} has already finished")
    now = utcnow()
    if run.status == RunStatus.recording:
        from app.services import manual

        message = await manual.cancel(s, run)  # P4-14a: only while nothing is recorded
    elif run.status == RunStatus.awaiting_authorisation:
        run.status = RunStatus.cancelled
        run.finished_at = now
        run.error = "Request withdrawn. Nothing ran."
        for a in await apr.run_approvals(s, run.id):
            if a.status == ApprovalStatus.pending:
                a.status = ApprovalStatus.expired
        message = "Request withdrawn. Nothing ran."
    elif run.status == RunStatus.queued:
        run.status = RunStatus.cancelled
        run.finished_at = now
        run.error = f"Cancelled before it started. {CANCELLED}."
        await write_unfinished(s, run, CANCELLED)
        message = f"{run.key} cancelled."
    else:
        run.config = {**(run.config or {}), "cancel_requested": True, "cancelled_by": str(user.id)}
        message = f"{run.key} cancelled."
    run.config = {**(run.config or {}), "cancelled_by": str(user.id), "cancelled_at": now.isoformat()}
    audit(
        s,
        org_id=project.organisation_id,
        action="execution_run.cancelled",
        target_type="execution_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": run.key},
    )
    return message


async def write_unfinished(s: AsyncSession, run: ExecutionRun, reason: str) -> int:
    """Every planned test without a result becomes `error` with the reason (cancel, time limit, worker stopped)."""
    have = set(
        (await s.execute(select(ExecutionResult.key).where(ExecutionResult.execution_run_id == run.id))).scalars()
    )
    n = 0
    for item in (run.config or {}).get("plan") or []:
        if item["key"] in have:
            continue
        s.add(
            ExecutionResult(
                organisation_id=run.organisation_id,
                project_id=run.project_id,
                execution_run_id=run.id,
                key=item["key"],
                test_case_id=uuid.UUID(item["test_case_id"]),
                case_lineage_id=uuid.UUID(item["case_lineage_id"]),
                automation_script_id=uuid.UUID(item["script_id"]),
                script_version=item["script_version"],
                browser=item["browser"],
                viewport=item["size"],
                status=ResultStatus.error,
                attempts=0,
                error=reason,
                actual_result=f"The test couldn't finish: {reason[:1].lower() + reason[1:]}.",
            )
        )
        n += 1
    await s.flush()
    run.totals = await totals(s, run)
    return n


async def totals(s: AsyncSession, run: ExecutionRun) -> dict[str, Any]:
    rows = (
        await s.execute(
            select(ExecutionResult.status, func.count(), func.coalesce(func.sum(ExecutionResult.duration_ms), 0))
            .where(ExecutionResult.execution_run_id == run.id)
            .group_by(ExecutionResult.status)
        )
    ).all()
    counts = {v.value: 0 for v in ResultStatus}
    for status, n, _ms in rows:
        counts[status.value if hasattr(status, "value") else str(status)] = int(n)
    out: dict[str, Any] = {"tests": len((run.config or {}).get("plan") or []), **counts}
    out["finished"] = sum(counts.values())
    live = (run.totals or {}).get("live")
    # Live rows belong to a running run only: once it has ended (finished_at set) they are dropped (QA P4-BUG-11).
    if live and run.status == RunStatus.running and run.finished_at is None:
        out["live"] = live
    return out


def final_status(t: dict[str, Any]) -> RunStatus:
    return RunStatus.failed if (t.get("failed") or t.get("error")) else RunStatus.passed


# ------------------------------------------------------------------ reading


async def g7_decision(s: AsyncSession, run: ExecutionRun) -> GateDecision | None:
    if run.g7_decision_id is None:
        return None
    return await s.get(GateDecision, run.g7_decision_id)


def duration_ms(run: ExecutionRun) -> int | None:
    a, b = _aware(run.started_at), _aware(run.finished_at)
    if a is None:
        return None
    return int(((b or utcnow()) - a).total_seconds() * 1000)


async def run_summary(
    s: AsyncSession, run: ExecutionRun, users: dict[uuid.UUID, User], *, see_email: bool
) -> dict[str, Any]:
    from app.services import serialize_p2 as out

    gd = await g7_decision(s, run)
    scope = run.scope or {}
    plan = (run.config or {}).get("plan") or []
    finished_by = (run.config or {}).get("finished_by")
    manual = None
    if run.mode == RunMode.manual:
        # P4-14a: "Manual · Recording 2 of 4"; the change set a D37 re-test run belongs to.
        manual = {
            "recorded": int((run.totals or {}).get("finished") or 0),
            "tests": len(plan),
            "change_set_key": (run.config or {}).get("change_set_key"),
        }
    return {
        "id": run.id,
        "key": run.key,
        "mode": run.mode.value,
        "status": run.status.value,
        "selection": run.selection,
        "selection_label": selection_label(run.selection or {}) if run.mode == RunMode.automated else "Manual",
        "browsers": scope.get("browsers") or [],
        "viewports": scope.get("viewports") or [],
        "tests": len((run.config or {}).get("plan") or []) or scope.get("tests") or 0,
        "totals": run.totals or {},
        # First side-effect line, for "RUN-0003 is waiting …: 24 tests, may submit the Contact us form." (§4.3).
        "side_effect": next((str(x.get("text")) for x in scope.get("side_effects") or [] if isinstance(x, dict)), None),
        "notes": (run.config or {}).get("notes"),
        "requested_by": out.person(users.get(run.requested_by), see_email=see_email) if run.requested_by else None,
        "authorisation": {
            "decision": gd.decision.value,
            "by": out.person(users.get(gd.decided_by), see_email=see_email) if gd.decided_by else None,
            "at": gd.created_at,
            "comment": gd.comment or None,
            "self_authorised": gd.decided_by is not None and gd.decided_by == run.requested_by,
        }
        if gd is not None
        else None,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        # P4-14a: who finished a manual run; null otherwise.
        "finished_by": out.person(users.get(uuid.UUID(finished_by)), see_email=see_email) if finished_by else None,
        "duration_ms": duration_ms(run),
        "error": run.error,
        "bundle_version": run.bundle_version,
        "manual": manual,
    }


async def user_ids(s: AsyncSession, runs: list[ExecutionRun]) -> set[uuid.UUID]:
    ids: set[uuid.UUID] = {r.requested_by for r in runs if r.requested_by}
    gids = [r.g7_decision_id for r in runs if r.g7_decision_id]
    if gids:
        ids |= {
            d
            for d in (await s.execute(select(GateDecision.decided_by).where(GateDecision.id.in_(gids)))).scalars()
            if d
        }
    for r in runs:
        for k in ("cancelled_by", "finished_by"):
            by = (r.config or {}).get(k)
            if by:
                ids.add(uuid.UUID(by))
    return ids


def result_row(r: ExecutionResult, plan_item: dict[str, Any] | None = None) -> dict[str, Any]:
    analysis = r.analysis or {}
    return {
        "id": r.id,
        "key": r.key,
        "case_key": (plan_item or {}).get("case_key") or analysis.get("case_key"),
        "title": (plan_item or {}).get("title"),
        "test_case_id": r.test_case_id,
        "browser": r.browser,
        "viewport": r.viewport,
        "status": r.status.value,
        "attempts": r.attempts,
        "duration_ms": r.duration_ms,
        "failed_step": r.failed_step,
        "reason": r.error if r.status in (ResultStatus.skipped, ResultStatus.blocked) else None,
        "error_reason": r.error
        if r.status == ResultStatus.error and (r.attempts == 0 or r.error in INTERRUPTED)
        else None,
        "classification": r.classification.value if r.classification else None,
        "confidence": analysis.get("confidence"),
        "defect": analysis.get("defect"),
        # P4-14a: recorded by hand ("By hand"); the recorder is added by the caller, which knows the people.
        "manual": r.recorded_by is not None,
        "actual_result": r.actual_result if r.recorded_by is not None else None,
        "notes": r.notes if r.recorded_by is not None else None,
        # When it was last saved by hand (the "saved at" that decides the latest result); null for Playwright.
        "recorded_at": (r.recorded_at or r.updated_at) if r.recorded_by is not None else None,
    }


async def tests_rows(s: AsyncSession, run: ExecutionRun) -> list[dict[str, Any]]:
    """Every planned test with its result, or its live state (running / waiting) while the run goes."""
    plan = (run.config or {}).get("plan") or []
    results = {
        r.key: r
        for r in (await s.execute(select(ExecutionResult).where(ExecutionResult.execution_run_id == run.id))).scalars()
    }
    live = ((run.totals or {}).get("live") or {}) if run.status == RunStatus.running else {}
    people = await out_users(s, [r.recorded_by for r in results.values()])
    rows = []
    for item in plan:
        r = results.get(item["key"])
        if r is not None:
            row = result_row(r, item)
            row["recorded_by"] = person_name(people, r.recorded_by)
        else:
            state = (live.get(item["key"]) or {}).get("state")
            row = {
                "id": None,
                "key": item["key"],
                "case_key": item["case_key"],
                "title": item["title"],
                "test_case_id": item["test_case_id"],
                "browser": item["browser"],
                "viewport": item["size"],
                # Manual runs: "not_recorded" while recording, "not_run" once finished (unrecorded cases have no row).
                "status": ("not_recorded" if run.status == RunStatus.recording else "not_run")
                if run.mode == RunMode.manual
                else ("running" if state == "running" else "waiting"),
                "attempts": (live.get(item["key"]) or {}).get("attempt"),
                "duration_ms": None,
                "failed_step": None,
                "reason": None,
                "classification": None,
                "confidence": None,
                "defect": None,
                "manual": run.mode == RunMode.manual,
                "actual_result": None,
                "notes": None,
                "recorded_by": None,
                "recorded_at": None,
            }
        row["retried"] = item.get("retried", True)
        rows.append(row)
    return rows


async def out_users(s: AsyncSession, ids: list[uuid.UUID | None]) -> dict[uuid.UUID, User]:
    from app.services import serialize_p2 as out

    return await out.users(s, [i for i in ids if i])


def person_name(people: dict[uuid.UUID, User], user_id: uuid.UUID | None) -> dict[str, Any] | None:
    """The recorder of a manual result as {id, full_name}: names only, never emails (results are read by viewers)."""
    if user_id is None:
        return None
    u = people.get(user_id)
    return {"id": user_id, "full_name": (u.full_name if u else None) or "someone"}


async def analysis_summary(s: AsyncSession, run: ExecutionRun) -> dict[str, Any] | None:
    """'What failed and why' (design §9.1) from the failure_analysis stage run of this run."""
    srun = (
        (
            await s.execute(
                select(StageRun)
                .where(StageRun.project_id == run.project_id, StageRun.stage_key == StageKey.failure_analysis)
                .order_by(StageRun.version.desc())
            )
        )
        .scalars()
        .all()
    )
    mine = next((x for x in srun if str((x.parameters or {}).get("execution_run_id")) == str(run.id)), None)
    if mine is None:
        return None
    return {
        "status": mine.status.value,
        "output": mine.output if mine.finished_at else None,
        "error": mine.error,
        "generated_by": mine.generated_by.value if mine.generated_by else None,
    }


async def defect_for_result(s: AsyncSession, result_id: uuid.UUID) -> Defect | None:
    d = (await s.execute(select(Defect).where(Defect.execution_result_id == result_id))).scalar_one_or_none()
    if d is not None:
        return d
    occ = (
        await s.execute(select(DefectOccurrence).where(DefectOccurrence.execution_result_id == result_id))
    ).scalar_one_or_none()
    return await s.get(Defect, occ.defect_id) if occ is not None else None
