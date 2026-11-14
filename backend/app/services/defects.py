"""Defects and Gate 8 (P4-08 drafts, P4-09; decision D11; design P4 §11).

A draft comes from a result the analysis classified as a likely application bug at medium or high confidence, or
from a person (`source="user"`). An open defect for the same case and failed step gains an occurrence instead of a
new draft. Every spec §11 field is filled from the case, the result and the analysis; saved credentials only ever
appear as "the saved test account". Severity and priority are derived by code and may be overridden with a reason.

Statuses: draft → confirmed | rejected (G8, per defect, `can_approve`, bulk allowed; rejecting needs a reason and a
comment), confirmed → fixed (members) → verified (`can_approve`, only after a later passing result of the case with
the same or a newer script) → closed (members, also from rejected). No delete.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, ValidationFailed
from app.db.models import (
    Defect,
    DefectLink,
    DefectOccurrence,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    Project,
    Requirement,
    TestCase,
    User,
)
from app.db.types import utcnow
from app.domain.enums import (
    DefectSeverity,
    DefectSource,
    DefectStatus,
    GateDecisionKind,
    GateKey,
    GateSubjectType,
    Priority,
    ResultStatus,
)
from app.services import revisions
from app.services.audit import audit
from app.services.counters import next_key

OPEN = (DefectStatus.draft, DefectStatus.confirmed, DefectStatus.fixed)
REJECT_REASONS = {
    "not_a_defect": "Not a defect",
    "duplicate": "Duplicate",
    "works_as_intended": "Works as intended",
    "cannot_reproduce": "Can't reproduce",
    "test_problem": "Problem with the test",
}
EDITABLE = ("summary", "description", "preconditions", "steps", "expected", "actual", "severity", "priority")
BLOCKING_KINDS = ("submission_blocked", "signed_in", "not_signed_in", "submission_accepted")
EVIDENCE_KINDS = ("screenshot", "video", "trace", "console_log", "network_log")


# ------------------------------------------------------------------ derivation


def derive_severity(risk_level: str | None, assertion_kinds: list[str]) -> tuple[DefectSeverity, str]:
    """critical: a very-high-risk requirement's main flow fails; major: high risk, or a blocked submission or
    sign-in check failed; minor otherwise (trivial only by a person)."""
    if risk_level == "very_high":
        return DefectSeverity.critical, "from the linked requirement's very high risk"
    if risk_level == "high":
        return DefectSeverity.major, "from the linked requirement's high risk"
    blocking = next((k for k in assertion_kinds if k in BLOCKING_KINDS), None)
    if blocking is not None:
        what = "a blocked submission" if "submission" in blocking else "a sign-in check"
        return DefectSeverity.major, f"{what} failed"
    level = f"{risk_level.replace('_', ' ')} risk" if risk_level else "no linked risk"
    return DefectSeverity.minor, f"from the linked requirement's {level}"


def effective_priority(case: TestCase) -> Priority:
    return case.priority_override or case.derived_priority


def summary_for(case_title: str, analysis: dict[str, Any]) -> str:
    """ "Send the contact form with an empty Message" → "Contact form accepts an empty Message"."""
    m = re.match(r"^(?:send|submit) (?:the |a |an )?(.+?) form with (.+)$", case_title.strip(), re.I)
    if m and analysis.get("classification") == "application_defect":
        form = m.group(1).strip()
        return f"{form[:1].upper()}{form[1:]} form accepts {m.group(2).strip()}"[:300]
    return f"{case_title.strip()}: the expected result didn't happen"[:300]


def reproducibility(result: ExecutionResult, occurrences: int = 1) -> dict[str, Any]:
    attempts = max(result.attempts, 1)
    failed = sum(1 for a in result.steps or [] if a.get("status") not in ("passed", "skipped")) or attempts
    kind = "always" if failed == attempts else "intermittent"
    return {
        "attempts_failed": failed,
        "attempts": attempts,
        "kind": kind,
        "occurrences": occurrences,
        "text": f"{failed} of {attempts} attempts ({kind})",
    }


def repro_steps(result: ExecutionResult, case: TestCase) -> list[str]:
    """The executed step titles (synthetic values written in, sign-in as "the saved test account"); the case's own
    steps when the result has none."""
    last = (result.steps or [{}])[-1] if result.steps else {}
    titles = [str(s.get("title") or "") for s in last.get("steps") or [] if s.get("title")]
    if titles:
        return titles
    out = []
    for st in case.steps or []:
        text = st.get("action") if isinstance(st, dict) else str(st)
        if text:
            out.append(str(text))
    return out


# ------------------------------------------------------------------ drafts


async def _evidence_refs(s: AsyncSession, result_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (
        await s.execute(select(Evidence).where(Evidence.execution_result_id == result_id).order_by(Evidence.key))
    ).scalars()
    out = []
    for e in rows:
        if e.kind.value in EVIDENCE_KINDS:
            out.append({"evidence_id": str(e.id), "kind": e.kind.value, "attempt": (e.meta or {}).get("attempt")})
    return out


async def open_duplicate(
    s: AsyncSession, project_id: uuid.UUID, lineage: uuid.UUID, step_title: str | None
) -> Defect | None:
    """An open defect for the same case lineage and failed step (dedupe rule)."""
    links = (
        await s.execute(
            select(DefectLink.defect_id).where(
                DefectLink.project_id == project_id, DefectLink.test_case_lineage_id == lineage
            )
        )
    ).scalars()
    ids = set(links)
    if not ids:
        return None
    for d in (await s.execute(select(Defect).where(Defect.id.in_(ids), Defect.status.in_(OPEN)))).scalars():
        if (d.environment or {}).get("failed_step") == step_title:
            return d
    return None


async def add_occurrence(s: AsyncSession, d: Defect, result: ExecutionResult) -> None:
    exists = (
        await s.execute(
            select(DefectOccurrence).where(
                DefectOccurrence.defect_id == d.id, DefectOccurrence.execution_result_id == result.id
            )
        )
    ).scalar_one_or_none()
    if exists is None:
        s.add(
            DefectOccurrence(
                organisation_id=d.organisation_id,
                project_id=d.project_id,
                defect_id=d.id,
                execution_result_id=result.id,
                seen_at=utcnow(),
            )
        )
        await s.flush()
    n = len(list((await s.execute(select(DefectOccurrence.id).where(DefectOccurrence.defect_id == d.id))).scalars()))
    d.reproducibility = {**(d.reproducibility or {}), "occurrences": n}


async def build_fields(
    s: AsyncSession,
    project: Project,
    result: ExecutionResult,
    case: TestCase,
    analysis: dict[str, Any] | None,
    assertions: list[dict[str, Any]],
) -> dict[str, Any]:
    from app.services import approvals as apr

    run = await s.get(ExecutionRun, result.execution_run_id)
    origin, _host = await apr.target(s, project.id)
    browser = (result.page_state or {}).get("browser") or result.browser.capitalize()
    severity, why = derive_severity(case.risk_level, [str(a.get("kind")) for a in assertions])
    priority = effective_priority(case)
    a = analysis or {}
    label = a.get("label") or "Not analysed"
    conf = str(a.get("confidence") or "").capitalize()
    root = f"{label} ({conf}). {a.get('summary') or ''}".strip() if a else None
    if a.get("possible_causes"):
        root = f"{root} Possible causes: {' '.join(a['possible_causes'][:2])}"
    preconditions = [str(p.get("text") if isinstance(p, dict) else p) for p in case.preconditions or []]
    return {
        "summary": summary_for(case.title, a),
        "description": (a.get("summary") or f"{case.title} failed.")
        + f" Found by {case.key} in {run.key if run else 'a test run'}.",
        "environment": {
            "url": origin,
            "browser": browser,
            "viewport": result.viewport,
            "run_key": run.key if run else None,
            "result_key": result.key,
            "date": (run.finished_at or run.started_at or utcnow()).isoformat() if run else utcnow().isoformat(),
            "failed_step": (result.failed_step or {}).get("title"),
            "script_version": result.script_version,
        },
        "preconditions": preconditions,
        "steps": repro_steps(result, case),
        "expected": case.expected_result,
        "actual": result.actual_result,
        "severity": severity,
        "severity_derived": severity,
        "severity_reason": why,
        "priority": priority,
        "priority_derived": priority,
        "priority_reason": f"from {case.key}",
        "reproducibility": reproducibility(result),
        "root_cause_hypothesis": root,
        "evidence_refs": await _evidence_refs(s, result.id),
    }


async def create_defect(
    s: AsyncSession,
    project: Project,
    fields: dict[str, Any],
    *,
    source: DefectSource,
    result: ExecutionResult | None,
    case: TestCase | None,
    user_id: uuid.UUID | None,
    related_to: str | None = None,
) -> Defect:
    _n, key = await next_key(s, project.organisation_id, project.id, "defect")
    d = Defect(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        source=source,
        execution_result_id=result.id if result else None,
        status=DefectStatus.draft,
        version=1,
        **{k: v for k, v in fields.items() if hasattr(Defect, k)},
    )
    if related_to:
        d.environment = {**(d.environment or {}), "related_to": related_to}
    s.add(d)
    await s.flush()
    if case is not None:
        reqs: list[uuid.UUID | None] = [uuid.UUID(str(x)) for x in case.requirement_lineage_ids or []] or [None]
        for req in reqs:
            s.add(
                DefectLink(
                    organisation_id=project.organisation_id,
                    project_id=project.id,
                    defect_id=d.id,
                    requirement_lineage_id=req,
                    test_case_lineage_id=case.lineage_id,
                )
            )
    if result is not None:
        await add_occurrence(s, d, result)
    await revisions.record(
        s,
        org_id=project.organisation_id,
        project_id=project.id,
        entity_type="defect",
        entity_id=d.id,
        lineage_id=d.id,
        version=1,
        snapshot=snapshot(d),
        changes={},
        source="system" if source == DefectSource.analysis else "user",
        changed_by=user_id,
        change_reason="Drafted from the failure analysis" if source == DefectSource.analysis else "Raised by a person",
    )
    audit(
        s,
        org_id=project.organisation_id,
        action="defect.created",
        target_type="defect",
        target_id=d.id,
        actor_user_id=user_id,
        project_id=project.id,
        metadata={"key": key, "source": source.value},
    )
    return d


async def draft_from_result(
    s: AsyncSession,
    project: Project,
    result: ExecutionResult,
    case: TestCase,
    analysis: dict[str, Any],
    assertions: list[dict[str, Any]],
    *,
    user_id: uuid.UUID | None = None,
) -> tuple[Defect, bool]:
    """A draft for a likely application bug, or a new occurrence of the open one. Returns (defect, created)."""
    step = (result.failed_step or {}).get("title")
    dup = await open_duplicate(s, project.id, case.lineage_id, step)
    if dup is not None:
        await add_occurrence(s, dup, result)
        return dup, False
    fields = await build_fields(s, project, result, case, analysis, assertions)
    return await create_defect(
        s, project, fields, source=DefectSource.analysis, result=result, case=case, user_id=user_id
    ), True


def snapshot(d: Defect) -> dict[str, Any]:
    snap: dict[str, Any] = revisions.jsonable(
        {k: getattr(d, k) for k in (*EDITABLE, "status", "severity_reason", "priority_reason")}
    )
    return snap


# ------------------------------------------------------------------ G8 and statuses


def _gate_decision(project: Project, d: Defect, user: User, decision: GateDecisionKind, comment: str) -> GateDecision:
    return GateDecision(
        organisation_id=project.organisation_id,
        project_id=project.id,
        gate_key=GateKey.G8,
        stage_run_id=None,
        decision=decision,
        comment=comment,
        decided_by=user.id,
        subject_type=GateSubjectType.defect,
        subject_id=d.id,
        artefact_snapshot=[{"type": "defect", "id": str(d.id), "version": d.version}],
    )


async def latest_g8(s: AsyncSession, d: Defect) -> GateDecision | None:
    return (
        (
            await s.execute(
                select(GateDecision)
                .where(GateDecision.subject_type == GateSubjectType.defect, GateDecision.subject_id == d.id)
                .order_by(GateDecision.created_at.desc())
            )
        )
        .scalars()
        .first()
    )


def can_do(d: Defect, action: str, *, member: bool, approver: bool) -> str | None:
    """None when allowed, else why not (for 403/409 and disabled reasons)."""
    if action in ("confirm", "reject"):
        if not approver:
            return "permission"
        return None if d.status == DefectStatus.draft else "They aren't drafts."
    if action == "fixed":
        if not member:
            return "permission"
        return None if d.status == DefectStatus.confirmed else "Only confirmed defects can be marked fixed."
    if action == "verified":
        if not approver:
            return "permission"
        return None if d.status == DefectStatus.fixed else "Only fixed defects can be verified."
    if action == "closed":
        if not member:
            return "permission"
        return (
            None
            if d.status in (DefectStatus.verified, DefectStatus.rejected)
            else "Only verified or rejected defects can be closed."
        )
    return "Unknown action"


async def passing_rerun(s: AsyncSession, d: Defect) -> ExecutionResult | None:
    """A later `passed` result of a linked case with the same or a newer script version (verifies a fix)."""
    lineages = {
        x
        for x in (
            await s.execute(select(DefectLink.test_case_lineage_id).where(DefectLink.defect_id == d.id))
        ).scalars()
        if x
    }
    if not lineages:
        return None
    since = d.confirmed_at or d.created_at
    version = int((d.environment or {}).get("script_version") or 0)
    rows = (
        await s.execute(
            select(ExecutionResult)
            .where(
                ExecutionResult.case_lineage_id.in_(lineages),
                ExecutionResult.status == ResultStatus.passed,
                ExecutionResult.created_at > since,
            )
            .order_by(ExecutionResult.created_at.desc())
        )
    ).scalars()
    return next((r for r in rows if int(r.script_version or 0) >= version), None)


async def set_status(
    s: AsyncSession,
    project: Project,
    d: Defect,
    user: User,
    action: str,
    *,
    member: bool,
    approver: bool,
    reason: str | None = None,
    comment: str | None = None,
    duplicate_of: str | None = None,
) -> str:
    """One status change. Returns the toast message. Raises 403-worthy `PermissionError`, 409 or 422."""
    why = can_do(d, action, member=member, approver=approver)
    if why == "permission":
        raise PermissionError(
            "Confirming or rejecting defects needs gate-approval permission"
            if action in ("confirm", "reject", "verified")
            else "Viewers have read-only access"
        )
    if why is not None:
        raise Conflict(why)
    text = (comment or "").strip()
    before = snapshot(d)
    now = utcnow()
    if action == "confirm":
        d.status = DefectStatus.confirmed
        d.confirmed_by, d.confirmed_at = user.id, now
        d.status_comment = text or None
        s.add(_gate_decision(project, d, user, GateDecisionKind.approve, text))
        message, audit_action = f"{d.key} confirmed.", "defect.confirmed"
    elif action == "reject":
        if reason not in REJECT_REASONS or not text:
            raise ValidationFailed(
                "Choose a reason and add a comment to reject.",
                details=[
                    {
                        "field": "reason" if reason not in REJECT_REASONS else "comment",
                        "message": "Choose a reason and add a comment to reject.",
                    }
                ],
            )
        if reason == "duplicate":
            if not duplicate_of:
                raise ValidationFailed(
                    "Choose the defect this one duplicates.",
                    details=[{"field": "duplicate_of", "message": "Choose the defect this one duplicates."}],
                )
            other = (
                await s.execute(select(Defect).where(Defect.project_id == d.project_id, Defect.key == duplicate_of))
            ).scalar_one_or_none()
            if other is None or other.id == d.id:
                raise ValidationFailed(f"{duplicate_of} isn't another defect in this project")
        d.status = DefectStatus.rejected
        d.status_reason = reason
        d.status_comment = text
        if duplicate_of:
            d.environment = {**(d.environment or {}), "duplicate_of": duplicate_of}
        s.add(_gate_decision(project, d, user, GateDecisionKind.reject, text))
        message, audit_action = f"{d.key} rejected.", "defect.rejected"
    elif action == "fixed":
        d.status = DefectStatus.fixed
        d.status_comment = text or None
        keys = await case_keys(s, d)
        message = f"{d.key} marked fixed." + (f" Re-run {keys[0]} to verify." if keys else "")
        audit_action = "defect.status_changed"
    elif action == "verified":
        passing = await passing_rerun(s, d)
        if passing is None:
            keys = await case_keys(s, d)
            raise Conflict(
                "No passing re-run yet" + (f". Re-run {keys[0]} after the fix to verify it." if keys else ""),
                details={"reason": "no_passing_rerun"},
            )
        d.status = DefectStatus.verified
        run = await s.get(ExecutionRun, passing.execution_run_id)
        d.status_comment = f"Passed in {run.key if run else passing.key}"
        message, audit_action = f"{d.key} verified.", "defect.status_changed"
    else:
        d.status = DefectStatus.closed
        d.status_comment = text or d.status_comment
        message, audit_action = f"{d.key} closed.", "defect.status_changed"
    d.version += 1
    await revisions.record(
        s,
        org_id=project.organisation_id,
        project_id=project.id,
        entity_type="defect",
        entity_id=d.id,
        lineage_id=d.id,
        version=d.version,
        snapshot=snapshot(d),
        changes=revisions.diff(before, snapshot(d)),
        changed_by=user.id,
        change_reason=text or None,
    )
    audit(
        s,
        org_id=project.organisation_id,
        action=audit_action,
        target_type="defect",
        target_id=d.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": d.key, "status": d.status.value, "reason": d.status_reason if action == "reject" else None},
    )
    return message


async def case_keys(s: AsyncSession, d: Defect) -> list[str]:
    lineages = [
        x
        for x in (
            await s.execute(select(DefectLink.test_case_lineage_id).where(DefectLink.defect_id == d.id))
        ).scalars()
        if x
    ]
    if not lineages:
        return []
    rows = (await s.execute(select(TestCase).where(TestCase.lineage_id.in_(lineages)))).scalars()
    return sorted({r.key for r in rows})


async def requirement_keys(s: AsyncSession, d: Defect) -> list[str]:
    lineages = [
        x
        for x in (
            await s.execute(select(DefectLink.requirement_lineage_id).where(DefectLink.defect_id == d.id))
        ).scalars()
        if x
    ]
    if not lineages:
        return []
    rows = (await s.execute(select(Requirement).where(Requirement.lineage_id.in_(lineages)))).scalars()
    return sorted({r.key for r in rows})
