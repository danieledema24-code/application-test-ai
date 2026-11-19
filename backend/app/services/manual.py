"""Manual runs and results (P4-14a; decisions D15, D38, D39, D40; design P4 §10).

A manual run (`RUN-0005`, `mode = manual`) is a person's record of cases they tested by hand. Nothing runs on the
platform, so it has no Gate 7, no approvals, no stage run, no worker and no toolkit check. It is created in status
`recording` (never `running`: an automated run and a load test refuse to start beside a `running` execution run) with
one planned test per case (browser and size `manual`, shown "By hand").

Each result counts as soon as it is saved (not at finish): `last_results` treats a manual run like any run (the latest
result wins, manual or automated, D38), and release readiness reads it unchanged (D40). Until the run is finished only
the person who recorded a result can change it. Results recorded by hand are never analysed or classified, and no
defect is drafted automatically; `POST /defects {from_result_id}` prefills one.

D37 manual re-tests (D39) are written here too: `record_retest` puts the result in the caller's newest `recording`
manual run for the change set (created with the change set's manual must-run cases if there is none).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.db.models import ChangeSet, Evidence, ExecutionResult, ExecutionRun, Project, TestCase, User
from app.db.types import utcnow
from app.domain.enums import EvidenceKind, ResultStatus, RunMode, RunStatus
from app.security.redact import redact_text
from app.services.audit import audit
from app.services.counters import next_key

MANUAL = "manual"  # browser and viewport of a result recorded by hand
BY_HAND = "By hand"
NOT_ANALYSED = "Not analysed: recorded by a person"
NOT_FOR_MANUAL = "Manual runs don't run on the platform."
ONLY_MANUAL = "Only results of manual runs are recorded by hand."
WHAT_HAPPENED = "Describe what happened."
MAX_CASES = 100
MAX_TEXT = 2000
MAX_FILE_MB = 10
MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024
MAX_FILES = 5
TOO_LARGE = f"This file is larger than {MAX_FILE_MB} MB."
BAD_TYPE = "This file type isn't supported. Use PNG, JPEG or PDF."
NO_FILE = "Choose a file to upload."
TOO_MANY_FILES = f"A result can have up to {MAX_FILES} files."
UPLOADS_PER_HOUR = 20  # the P2-08 per-project upload limit
NO_RESULTS_TO_FINISH = "Record at least one result before finishing, or cancel the run."
HAS_RESULTS = "{key} has recorded results, so it can't be cancelled. Finish it instead."
STATUS_WORD = {"passed": "Passed", "failed": "Failed", "blocked": "Blocked"}
# (mime, evidence kind, file extension) by magic bytes.
_PNG = b"\x89PNG\r\n\x1a\n"
_JPEG = b"\xff\xd8\xff"
_PDF = b"%PDF-"


def is_manual(run: ExecutionRun) -> bool:
    return run.mode == RunMode.manual


def by_hand(r: ExecutionResult) -> bool:
    """A result a person recorded (manual runs and D37 re-tests)."""
    return r.recorded_by is not None


def finished_message(run: ExecutionRun) -> str:
    if run.status == RunStatus.cancelled:
        return f"{run.key} was cancelled. Start a new manual run to record again."
    return f"{run.key} is finished. Start a new manual run to record again."


def sniff(data: bytes) -> tuple[str, EvidenceKind, str]:
    """PNG, JPEG or PDF by content (never by name or declared type)."""
    if data.startswith(_PNG):
        return "image/png", EvidenceKind.screenshot, "png"
    if data.startswith(_JPEG):
        return "image/jpeg", EvidenceKind.screenshot, "jpg"
    if data.startswith(_PDF):
        return "application/pdf", EvidenceKind.document_file, "pdf"
    raise ValidationFailed(BAD_TYPE, details=[{"field": "file", "message": BAD_TYPE}])


def _clean(text: str | None, secrets: list[str]) -> str:
    """People's text, trimmed, with the saved test account, token-like values and registered secrets redacted (it is
    shown in reports and to viewers)."""
    return redact_text((text or "").strip(), secrets)[:MAX_TEXT]


async def saved_values(ctx: Any, s: AsyncSession, project_id: uuid.UUID) -> list[str]:
    """The project's saved test-account values, only to redact them from what people type (they never leave here).
    Not a use of the credentials, so not audited as one (as `secrets.backfill`)."""
    import json

    from app.services.secrets import credentials_secret

    secret = await credentials_secret(s, project_id)
    if secret is None:
        return []
    try:
        creds = json.loads(ctx.encryptor.decrypt(secret.ciphertext))
    except Exception:  # noqa: BLE001 - undecryptable (key rotated away): pattern redaction still applies
        return []
    return [str(v) for k, v in creds.items() if k in ("username", "password") and isinstance(v, str) and v]


def _plan_item(run_key: str, n: int, case: TestCase, title: str) -> dict[str, Any]:
    return {
        "key": f"{run_key}-{n:02d}",
        "case_key": case.key,
        "title": title,
        "test_case_id": str(case.id),
        "case_lineage_id": str(case.lineage_id),
        "script_id": None,
        "browser": MANUAL,
        "viewport": MANUAL,
        "size": MANUAL,
        "retried": False,
        "signs_in": False,
    }


# ------------------------------------------------------------------ runs


async def _approved(s: AsyncSession, project_id: uuid.UUID) -> dict[str, tuple[TestCase, str]]:
    """Cases approved at the latest G5 by key (D38: any of them can be recorded by hand), with their approved title."""
    from app.services import automation as asvc

    decision, cases = await asvc.approved_cases(s, project_id)
    if decision is None:
        raise Conflict("Test cases haven't been approved at Gate 5 yet")
    return {c.case.key: (c.row, c.case.title) for c in cases}


async def create_run(
    s: AsyncSession,
    project: Project,
    user: User,
    *,
    case_keys: list[str],
    change_set_key: str | None = None,
    cases: list[tuple[TestCase, str]] | None = None,
) -> ExecutionRun:
    """A manual run in `recording`. `cases` (D37 re-tests) skips the G5 lookup: the change set's picks are used."""
    if cases is None:
        keys = list(dict.fromkeys(k.strip().upper() for k in case_keys if k.strip()))
        if not keys:
            msg = "Choose the test cases you'll record."
            raise ValidationFailed(msg, details=[{"field": "case_keys", "message": msg}])
        if len(keys) > MAX_CASES:
            msg = f"A manual run can have up to {MAX_CASES} test cases."
            raise ValidationFailed(msg, details=[{"field": "case_keys", "message": msg}])
        approved = await _approved(s, project.id)
        missing = [k for k in keys if k not in approved]
        if missing:
            msg = f"Only test cases approved at Gate 5 can be recorded: {', '.join(missing)}."
            raise ValidationFailed(msg, details=[{"field": "case_keys", "message": msg}])
        cases = [approved[k] for k in keys]
    if change_set_key:
        cs = (
            await s.execute(
                select(ChangeSet).where(ChangeSet.project_id == project.id, ChangeSet.key == change_set_key)
            )
        ).scalar_one_or_none()
        if cs is None:
            msg = f"{change_set_key} isn't a change set of this project."
            raise ValidationFailed(msg, details=[{"field": "change_set_key", "message": msg}])
    _n, key = await next_key(s, project.organisation_id, project.id, "run")
    plan = [_plan_item(key, i, c, title) for i, (c, title) in enumerate(cases, start=1)]
    now = utcnow()
    run = ExecutionRun(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        mode=RunMode.manual,
        selection={"suite": None, "case_keys": [c.key for c, _t in cases]},
        scope={"cases": [{"key": c.key, "title": t, "test_case_id": str(c.id)} for c, t in cases], "manual": True},
        config={"plan": plan, "change_set_key": change_set_key, "notes": None},
        status=RunStatus.recording,
        totals={"tests": len(plan), "finished": 0},
        requested_by=user.id,
        started_at=now,
    )
    s.add(run)
    await s.flush()
    audit(
        s,
        org_id=project.organisation_id,
        action="execution_run.manual_started",
        target_type="execution_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": key, "tests": len(plan), "change_set": change_set_key},
    )
    return run


def _plan_for(run: ExecutionRun, case_key: str) -> dict[str, Any]:
    item = next((i for i in (run.config or {}).get("plan") or [] if i["case_key"] == case_key.upper()), None)
    if item is None:
        raise NotFound(f"{case_key.upper()} isn't in {run.key}.")
    return dict(item)


def check_recording(run: ExecutionRun) -> None:
    if not is_manual(run):
        raise Conflict(ONLY_MANUAL)
    if run.status != RunStatus.recording:
        raise Conflict(finished_message(run), details={"status": run.status.value})


async def lock_recording(s: AsyncSession, run: ExecutionRun) -> None:
    """Takes the run's row lock (PostgreSQL) or the write lock (SQLite) only while the run is still `recording`, so
    a save, an upload, a finish or a cancel racing each other queue up and none lands in a finished run. When the run
    has moved on meanwhile, it is re-read and refused with the usual finished/cancelled message (409)."""
    check_recording(run)
    done = await s.execute(
        update(ExecutionRun)
        .where(ExecutionRun.id == run.id, ExecutionRun.status == RunStatus.recording)
        .values(status=ExecutionRun.status)
        .execution_options(synchronize_session=False)
    )
    if not getattr(done, "rowcount", 0):
        await s.refresh(run)
        check_recording(run)
        raise Conflict(finished_message(run), details={"status": run.status.value})


async def record(
    s: AsyncSession,
    project: Project,
    run: ExecutionRun,
    user: User,
    *,
    case_key: str,
    status: str,
    actual_result: str | None,
    notes: str | None,
    secrets: list[str] | None = None,
    stale_reason: str | None = None,
) -> tuple[ExecutionResult, str | None]:
    """Creates or updates one case's result (D38). Returns it and its previous status (None when new)."""
    from app.services import execution as xsvc
    from app.services.release import mark_stale

    check_recording(run)
    item = _plan_for(run, case_key)
    secrets = list(secrets or [])
    what = _clean(actual_result, secrets)
    if not what:
        raise ValidationFailed(WHAT_HAPPENED, details=[{"field": "actual_result", "message": WHAT_HAPPENED}])
    # Locks the run row first so two first saves of one case queue up instead of racing the unique key, and a
    # save racing Finish either lands before it or is refused.
    await lock_recording(s, run)
    r = (
        await s.execute(
            select(ExecutionResult).where(
                ExecutionResult.execution_run_id == run.id, ExecutionResult.key == item["key"]
            )
        )
    ).scalar_one_or_none()
    previous: str | None = None
    if r is None:
        r = ExecutionResult(
            organisation_id=run.organisation_id,
            project_id=run.project_id,
            execution_run_id=run.id,
            key=item["key"],
            test_case_id=uuid.UUID(item["test_case_id"]),
            case_lineage_id=uuid.UUID(item["case_lineage_id"]),
            browser=MANUAL,
            viewport=MANUAL,
            status=ResultStatus(status),
            attempts=1,
            actual_result=what,
            notes=_clean(notes, secrets) or None,
            recorded_by=user.id,
            recorded_at=utcnow(),
        )
        s.add(r)
    else:
        if r.recorded_by != user.id:
            who = await s.get(User, r.recorded_by) if r.recorded_by else None
            name = (who.full_name if who else None) or "the person who recorded it"
            raise Forbidden(f"Only {name} can change this result until {run.key} is finished.")
        previous = r.status.value
        r.status = ResultStatus(status)
        r.actual_result = what
        r.notes = _clean(notes, secrets) or None
        r.recorded_at = r.updated_at = utcnow()
    await s.flush()
    run.totals = await xsvc.totals(s, run)
    audit(
        s,
        org_id=project.organisation_id,
        action="execution_result.recorded",
        target_type="execution_result",
        target_id=r.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": r.key, "run": run.key, "case": item["case_key"], "status": status, "previous": previous},
    )
    await mark_stale(s, project.id, stale_reason or f"{item['case_key']} recorded by hand ({status})")
    return r, previous


async def finish(s: AsyncSession, project: Project, run: ExecutionRun, user: User) -> str:
    """Finishes a manual run: passed, or failed if any result failed. Unrecorded cases stay Not run (no row)."""
    from app.services import execution as xsvc
    from app.services.impact import resolve_reruns

    await lock_recording(s, run)
    t = await xsvc.totals(s, run)
    if not t.get("finished"):
        raise Conflict(NO_RESULTS_TO_FINISH)
    run.totals = t
    run.status = xsvc.final_status(t)
    run.finished_at = utcnow()
    run.config = {**(run.config or {}), "finished_by": str(user.id)}
    await resolve_reruns(s, run)
    audit(
        s,
        org_id=project.organisation_id,
        action="execution_run.finished",
        target_type="execution_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": run.key, "status": run.status.value, "recorded": t["finished"], "tests": t["tests"]},
    )
    not_run = int(t["tests"]) - int(t["finished"])
    return f"{run.key} finished: {t['finished']} recorded" + (f", {not_run} not run." if not_run else ".")


async def cancel(s: AsyncSession, run: ExecutionRun) -> str:
    """A `recording` run is cancelled only while nothing is recorded (results are evidence)."""
    await lock_recording(s, run)
    n = int((await s.execute(select(func.count()).where(ExecutionResult.execution_run_id == run.id))).scalar_one())
    if n:
        raise Conflict(HAS_RESULTS.format(key=run.key))
    run.status = RunStatus.cancelled
    run.finished_at = utcnow()
    run.error = "Cancelled. Nothing was recorded."
    return f"{run.key} cancelled."


# ------------------------------------------------------------------ evidence


async def evidence_count(s: AsyncSession, result_id: uuid.UUID) -> int:
    return int((await s.execute(select(func.count()).where(Evidence.execution_result_id == result_id))).scalar_one())


async def check_upload(s: AsyncSession, r: ExecutionResult, user: User) -> ExecutionRun:
    """Files can be added to a result recorded by hand in a `recording` run, by the person who recorded it."""
    run = await s.get(ExecutionRun, r.execution_run_id)
    assert run is not None
    if not is_manual(run) or not by_hand(r):
        raise Conflict("Files can only be added to results recorded by hand.")
    check_recording(run)
    if r.recorded_by != user.id:
        raise Forbidden(f"Only the person who recorded this result can add files until {run.key} is finished.")
    if await evidence_count(s, r.id) >= MAX_FILES:
        raise Conflict(TOO_MANY_FILES)
    return run


async def add_evidence(
    s: AsyncSession, storage: Any, project: Project, run: ExecutionRun, r: ExecutionResult, user: User, data: bytes
) -> Evidence:
    """Stores the file as-is (a person's screenshot is not masked) as evidence linked to the result. The uploaded
    file name and part headers are never stored or echoed: the stored name is `{result key}-{n}.{ext}`."""
    from app.services.evidence import write_evidence

    if not data:
        raise ValidationFailed(NO_FILE, details=[{"field": "file", "message": NO_FILE}])
    if len(data) > MAX_FILE_BYTES:
        raise ValidationFailed(TOO_LARGE, details=[{"field": "file", "message": TOO_LARGE}])
    mime, kind, ext = sniff(data)
    # The 5-file cap holds under concurrent uploads: a no-op write on the result row first takes its row lock
    # (PostgreSQL) or the database write lock (SQLite) until this transaction commits, so the count below already
    # includes every upload that got there first. Counted before the file is stored, so a refused upload leaves none.
    await lock_recording(s, run)
    await s.execute(update(ExecutionResult).where(ExecutionResult.id == r.id).values(notes=ExecutionResult.notes))
    n = await evidence_count(s, r.id) + 1
    if n > MAX_FILES:
        raise Conflict(TOO_MANY_FILES)
    ev = await write_evidence(
        s,
        storage,
        org_id=project.organisation_id,
        project_id=project.id,
        kind=kind,
        data=data,
        mime=mime,
        name=f"{r.key}-{n}.{ext}",
        owner_id=r.id,
        metadata={"manual": True, "uploaded_by": str(user.id)},
    )
    ev.execution_result_id = r.id
    await s.flush()
    audit(
        s,
        org_id=project.organisation_id,
        action="evidence.uploaded",
        target_type="evidence",
        target_id=ev.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": ev.key, "result": r.key, "run": run.key, "mime": mime, "size": len(data)},
    )
    return ev


# ------------------------------------------------------------------ D37 re-tests (D39)


async def retest_run(
    s: AsyncSession, project: Project, cs: ChangeSet, user: User, picks: list[dict[str, Any]], case_key: str
) -> ExecutionRun:
    """The caller's newest `recording` manual run for `cs` that has the case, or a new one with every pick."""
    runs = (
        await s.execute(
            select(ExecutionRun)
            .where(
                ExecutionRun.project_id == project.id,
                ExecutionRun.mode == RunMode.manual,
                ExecutionRun.status == RunStatus.recording,
                ExecutionRun.requested_by == user.id,
            )
            .order_by(ExecutionRun.created_at.desc())
        )
    ).scalars()
    for run in runs:
        plan = (run.config or {}).get("plan") or []
        if (run.config or {}).get("change_set_key") == cs.key and any(i["case_key"] == case_key for i in plan):
            return run
    rows = {
        c.id: c
        for c in (
            await s.execute(select(TestCase).where(TestCase.id.in_([uuid.UUID(str(p["test_case_id"])) for p in picks])))
        ).scalars()
    }
    cases = [
        (rows[uuid.UUID(str(p["test_case_id"]))], str(p.get("title") or rows[uuid.UUID(str(p["test_case_id"]))].title))
        for p in picks
        if uuid.UUID(str(p["test_case_id"])) in rows
    ]
    return await create_run(s, project, user, case_keys=[], change_set_key=cs.key, cases=cases)


async def retests(s: AsyncSession, cs: ChangeSet) -> dict[str, list[dict[str, Any]]]:
    """D37/D39: per case lineage, the re-tests of `cs` newest first: passed/failed results recorded by hand in a
    manual run created at or after the change set, and legacy `manual_retests` rows. Each is
    {id, status, note, recorded_by (user id), recorded_at, run_key, result_key}."""
    from app.db.models import ManualRetest

    out: dict[str, list[dict[str, Any]]] = {}
    for m in (await s.execute(select(ManualRetest).where(ManualRetest.change_set_id == cs.id))).scalars():
        out.setdefault(str(m.case_lineage_id), []).append(
            {"id": str(m.id), "status": m.status.value, "note": m.note, "recorded_by": m.recorded_by,
             "recorded_at": m.created_at, "run_key": None, "result_key": None}
        )  # fmt: skip
    rows = (
        await s.execute(
            select(ExecutionResult, ExecutionRun.key)
            .join(ExecutionRun, ExecutionRun.id == ExecutionResult.execution_run_id)
            .where(
                ExecutionResult.project_id == cs.project_id,
                ExecutionRun.mode == RunMode.manual,
                ExecutionRun.created_at >= cs.created_at,
                ExecutionResult.status.in_([ResultStatus.passed, ResultStatus.failed]),
            )
        )
    ).all()
    for r, run_key in rows:
        out.setdefault(str(r.case_lineage_id), []).append(
            {"id": str(r.id), "status": r.status.value, "note": r.actual_result, "recorded_by": r.recorded_by,
             "recorded_at": r.recorded_at or r.updated_at, "run_key": run_key, "result_key": r.key}
        )  # fmt: skip
    for items in out.values():
        items.sort(key=lambda x: _aware_ts(x["recorded_at"]), reverse=True)
    return out


def _aware_ts(value: Any) -> float:
    from datetime import UTC, datetime

    if not isinstance(value, datetime):
        return 0.0
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).timestamp()
