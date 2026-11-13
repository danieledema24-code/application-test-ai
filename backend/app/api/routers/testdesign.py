"""Test conditions, test cases, test data and the G5 lint (P3-01a read; P3-02, P3-03, P3-05 write).

Viewers read; members create, edit and decide individual cases (decision D2). Any change to approved content after
G5 approval reopens G5. Derived fields (risk, derived priority, lint) are code-owned: sending them is a 422.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import Conflict, GateBlocked, NotFound, ValidationFailed
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers import p2common as c
from app.context import AppContext
from app.db.models import (
    AcceptanceCriterion,
    KnowledgeItem,
    Project,
    StageRun,
    TestCase,
    TestCondition,
    TestData,
)
from app.db.types import utcnow
from app.domain.enums import (
    CaseSource,
    CaseStatus,
    ExpectedResultStatus,
    GateKey,
    GeneratedBy,
    ItemStatus,
    KnowledgeKind,
    KnowledgeStatus,
    Priority,
    Provenance,
    StageKey,
    TestDataKind,
    TestDataStatus,
    TestDataValueType,
)
from app.domain.provenance import CONFIDENCE_CAP
from app.domain.testdesign import lint as lint_rules
from app.domain.testdesign import synthetic as syn
from app.orchestrator.orchestrator import Orchestrator
from app.services import serialize as ser
from app.services import serialize_p3 as out
from app.services import testdesign as tds
from app.services.adapters import TEST_CASE_SNAPSHOT, TEST_CONDITION_SNAPSHOT, data_snapshot, snapshot
from app.services.audit import audit
from app.services.counters import next_key
from app.services.revisions import history

router = APIRouter(tags=["test design"])

Technique = Literal[
    "equivalence_partitioning",
    "boundary_value_analysis",
    "decision_table",
    "state_transition",
    "use_case",
    "error_guessing",
    "exploratory",
    "checklist",
]
TestType = Literal[
    "functional", "smoke", "sanity", "regression", "usability", "accessibility", "compatibility", "exploratory",
    "security", "performance", "load", "stress", "spike", "endurance",
]  # fmt: skip
TestLevel = Literal["component", "integration", "system", "acceptance"]
Suite = Literal["smoke", "regression"]
SideEffect = Literal["submits_form", "signs_in", "creates_data", "external_transaction"]
DESIGN_FIRST = "Design test cases first"
SUPERSEDED = "The test design was regenerated; reload to continue"


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class Origin:
    """Where non-human content comes from (an accepted assistant proposal built by the rules)."""

    provenance: Provenance
    generated_by: GeneratedBy = GeneratedBy.rules
    design_basis: dict[str, Any] = field(default_factory=dict)
    evidence_refs: tuple[dict[str, Any], ...] = ()


class StepIn(Body):
    action: str = Field(min_length=3, max_length=500)
    data_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    expected: str = Field("", max_length=500)


class CaseCreate(Body):
    title: str = Field(min_length=5, max_length=160)
    objective: str = Field("", max_length=1000)
    preconditions: list[str] = Field(default_factory=list, max_length=20)
    steps: list[StepIn] = Field(min_length=1, max_length=30)
    expected_result: str = Field("", max_length=1000)
    test_type: TestType = "functional"
    test_level: TestLevel = "system"
    technique: Technique = "use_case"
    requirement_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    acceptance_criterion_ids: list[uuid.UUID] = Field(default_factory=list, max_length=40)
    condition_id: uuid.UUID | None = None
    suites: list[Suite] = Field(default_factory=list)
    side_effects: list[SideEffect] = Field(default_factory=list)

    @field_validator("preconditions")
    @classmethod
    def _pre(cls, v: list[str]) -> list[str]:
        return [x.strip()[:300] for x in v if x.strip()]


class CasePatch(Body):
    version: int
    title: str | None = Field(None, min_length=5, max_length=160)
    objective: str | None = Field(None, max_length=1000)
    preconditions: list[str] | None = Field(None, max_length=20)
    steps: list[StepIn] | None = Field(None, min_length=1, max_length=30)
    expected_result: str | None = Field(None, max_length=1000)
    test_type: TestType | None = None
    test_level: TestLevel | None = None
    suites: list[Suite] | None = None
    side_effects: list[SideEffect] | None = None
    requirement_ids: list[uuid.UUID] | None = Field(None, max_length=20)
    acceptance_criterion_ids: list[uuid.UUID] | None = Field(None, max_length=40)
    priority_override: Literal["critical", "high", "medium", "low"] | None = None
    priority_override_reason: str | None = Field(None, max_length=500)
    clear_priority_override: bool = False
    change_reason: str | None = Field(None, max_length=500)


class CaseStatusBody(Body):
    version: int
    status: Literal["draft", "approved", "rejected", "deprecated"]
    comment: str | None = Field(None, max_length=2000)
    reason: Literal["incorrect", "duplicate", "not_applicable", "out_of_scope", "other"] | None = None
    duplicate_of: uuid.UUID | None = None


class BulkStatusBody(Body):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    status: Literal["draft", "approved", "rejected", "deprecated"]
    comment: str | None = Field(None, max_length=2000)


class LockBody(Body):
    version: int
    locked: bool


class DuplicateBody(Body):
    title: str | None = Field(None, min_length=5, max_length=160)


class ConditionPatch(Body):
    version: int
    title: str | None = Field(None, min_length=3, max_length=200)
    description: str | None = Field(None, max_length=2000)
    notes: list[str] | None = Field(None, max_length=20)
    change_reason: str | None = Field(None, max_length=500)


class ConditionStatusBody(Body):
    version: int
    status: Literal["draft", "approved", "rejected"]
    comment: str | None = Field(None, max_length=2000)


class DataCreate(Body):
    name: str = Field(min_length=2, max_length=200)
    field_label: str = Field(min_length=1, max_length=200)
    form_ref: dict[str, Any] | None = None
    kind: Literal["valid", "invalid", "boundary", "secret_ref"]
    value: str | None = Field(None, max_length=10_000)
    secret_ref: str | None = Field(None, max_length=120)


class DataPatch(Body):
    version: int
    name: str | None = Field(None, min_length=2, max_length=200)
    value: str | None = Field(None, max_length=10_000)
    secret_ref: str | None = Field(None, max_length=120)
    change_reason: str | None = Field(None, max_length=500)


class DataStatusBody(Body):
    version: int
    status: Literal["active", "retired"]


REASON_TEXT = {
    "incorrect": "Incorrect",
    "duplicate": "Duplicate",
    "not_applicable": "Not applicable",
    "out_of_scope": "Out of scope",
    "other": "Other",
}


# ---------------------------------------------------------------- shared


async def _project(s: ScopedSession, project_id: uuid.UUID) -> Project:
    return await c.project_of(s, project_id)


async def _current(s: ScopedSession, row: Any) -> StageRun:
    st = await tds.design_stage(s, row.project_id)
    if st.current_stage_run_id != row.stage_run_id:
        raise Conflict(SUPERSEDED)
    run = await s.get(StageRun, row.stage_run_id)
    assert run is not None
    return run


async def _run_or_none(s: ScopedSession, project_id: uuid.UUID, version: int | None) -> StageRun | None:
    run = await tds.run_by_version(s, project_id, version)
    if version is not None and run is None:
        raise NotFound("No test design version with that number")
    return run


async def _finish(
    ctx: AppContext, s: ScopedSession, p: MemberPrincipal, project: Project, reopen: bool, reason: str
) -> None:
    orch = await c.reopen_if_approved(ctx, s, project, GateKey.G5, reason, p.user.id) if reopen else None
    project.updated_at = utcnow()
    await s.commit()
    await c.after_commit(orch, p.scope, project.id)


async def _event(ctx: AppContext, project: Project, kind: str, key: str, what: str) -> None:
    await Orchestrator(ctx)._emit(
        project,
        "artefact.updated",
        f"{key} {what}",
        stage=StageKey.test_design,
        data={"kind": "artefact", "type": kind, "key": key},
    )


async def _revise_case(
    s: ScopedSession, row: TestCase, before: dict[str, Any], user_id: uuid.UUID, reason: str | None
) -> None:
    await c.revise(
        s, entity_type="test_case", row=row, fields=TEST_CASE_SNAPSHOT, before=before, user_id=user_id, reason=reason
    )


async def _lineages_for(
    s: ScopedSession, project_id: uuid.UUID, req_ids: list[uuid.UUID], ac_ids: list[uuid.UUID]
) -> tuple[list[str], list[str]]:
    """Requirement/AC ids of the current requirements version -> lineage ids (an AC also links its requirement)."""
    from app.services import gates

    run, reqs = await gates.current_requirements(s, project_id)
    by_id = {r.id: r for r in reqs}
    req_l: list[str] = []
    for rid in req_ids:
        r = by_id.get(rid)
        if r is None:
            raise ValidationFailed(
                "Link a requirement from the current version",
                details=[{"field": "requirement_ids", "message": "Not a requirement of this project's current set."}],
            )
        req_l.append(str(r.lineage_id))
    ac_l: list[str] = []
    if ac_ids:
        acs = {
            a.id: a
            for a in (
                await s.execute(
                    select(AcceptanceCriterion).where(
                        AcceptanceCriterion.id.in_(ac_ids),
                        AcceptanceCriterion.stage_run_id == (run.id if run else None),
                    )
                )
            ).scalars()
        }
        for aid in ac_ids:
            a = acs.get(aid)
            if a is None:
                raise ValidationFailed(
                    "Link an acceptance criterion from the current version",
                    details=[{"field": "acceptance_criterion_ids", "message": "Not a current acceptance criterion."}],
                )
            ac_l.append(str(a.lineage_id))
            parent = by_id.get(a.requirement_id)
            if parent is not None and str(parent.lineage_id) not in req_l:
                req_l.append(str(parent.lineage_id))
    return list(dict.fromkeys(req_l)), list(dict.fromkeys(ac_l))


async def _steps(s: ScopedSession, run_id: uuid.UUID, steps: list[StepIn]) -> tuple[list[dict[str, Any]], list[str]]:
    ids = {d for st in steps for d in st.data_ids}
    data = {d.id: d for d in (await s.execute(select(TestData).where(TestData.id.in_(ids)))).scalars()} if ids else {}
    outs: list[dict[str, Any]] = []
    lineages: list[str] = []
    for n, st in enumerate(steps, start=1):
        refs = []
        for did in st.data_ids:
            d = data.get(did)
            if d is None or d.stage_run_id != run_id:
                raise ValidationFailed(
                    "Use test data from the current design",
                    details=[{"field": f"steps[{n - 1}].data_ids", "message": "Unknown test data item."}],
                )
            refs.append(str(d.lineage_id))
        lineages += refs
        outs.append({"n": n, "action": st.action.strip(), "data_refs": refs, "expected": st.expected.strip()})
    return outs, list(dict.fromkeys(lineages))


def _texts_guard(*texts: str) -> None:
    for t in texts:
        msgs = syn.text_issues(t or "")
        if msgs:
            raise ValidationFailed(msgs[0], details=[{"field": "steps", "message": msgs[0]}])


async def _detail(ctx: AppContext, s: ScopedSession, row: TestCase) -> dict[str, Any]:
    run = await s.get(StageRun, row.stage_run_id)
    lk = await out.lookup(s, row.project_id, run)
    evs = await ser.evidence_map(s, [x.get("evidence_id") for x in row.evidence_refs or []])
    fresh = next((x for x in lk.cases if x.id == row.id), row)
    return out.case_detail(ctx, fresh, lk, evs)


def _knowledge(row: Any, entity: str, comment: str) -> KnowledgeItem:
    return KnowledgeItem(
        organisation_id=row.organisation_id,
        project_id=row.project_id,
        kind=KnowledgeKind.decision,
        title=f"{row.key} rejected: {row.title if hasattr(row, 'title') else row.name}"[:300],
        content=comment,
        provenance=Provenance.observed,
        evidence_refs=[],
        source="test_design_review",
        status=KnowledgeStatus.active,
        meta={
            "entity_type": entity,
            "decision": "rejected",
            "lineage_id": str(row.lineage_id),
            "match_key": row.match_key,
        },
    )


# ---------------------------------------------------------------- test cases: read


@router.get("/projects/{project_id}/test-cases")
async def list_cases(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    status: str | None = None,
    technique: str | None = None,
    test_type: str | None = None,
    test_level: str | None = None,
    priority: str | None = None,
    risk_level: str | None = None,
    suite: str | None = None,
    requirement_key: str | None = None,
    feature_id: uuid.UUID | None = None,
    lint: Literal["error", "warning", "clean"] | None = None,
    open_question: bool | None = None,
    q: str | None = Query(None, max_length=200),
    sort: Literal["priority", "key", "updated"] = "priority",
    stage_run_version: int | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    await _project(s, project_id)
    run = await _run_or_none(s, project_id, stage_run_version)
    if run is None:
        return {"items": [], "next_cursor": None}
    await tds.ensure_lint_current(s, project_id, run.id)
    lk = await out.lookup(s, project_id, run)
    rows = lk.cases

    def split(v: str | None) -> set[str] | None:
        return {x for x in v.split(",") if x} if v else None

    for attr, wanted in (
        ("status", split(status)),
        ("technique", split(technique)),
        ("test_type", split(test_type)),
        ("test_level", split(test_level)),
    ):
        if wanted:
            rows = [r for r in rows if str(getattr(getattr(r, attr), "value", getattr(r, attr))) in wanted]
    if priority:
        rows = [r for r in rows if out.effective_priority(r) in split(priority)]  # type: ignore[operator]
    if risk_level:
        rows = [r for r in rows if (r.risk_level or "none") in split(risk_level)]  # type: ignore[operator]
    if suite:
        rows = [r for r in rows if split(suite) & set(r.suites or [])]  # type: ignore[operator]
    if requirement_key:
        lins = {lin for lin, r in lk.requirements.items() if r.key in (split(requirement_key) or set())}
        rows = [r for r in rows if lins & {str(x) for x in r.requirement_lineage_ids or []}]
    if feature_id is not None:
        lins = {lin for lin, r in lk.requirements.items() if str(feature_id) in {str(f) for f in r.feature_ids or []}}
        rows = [r for r in rows if lins & {str(x) for x in r.requirement_lineage_ids or []}]
    if lint == "error":
        rows = [r for r in rows if any(i.get("severity") == "error" for i in r.lint or [])]
    elif lint == "warning":
        rows = [r for r in rows if any(i.get("severity") == "warning" for i in r.lint or [])]
    elif lint == "clean":
        rows = [r for r in rows if not r.lint]
    if open_question is not None:
        rows = [r for r in rows if (r.expected_result_status == ExpectedResultStatus.open_question) == open_question]
    if q:
        needle = q.lower()
        rows = [r for r in rows if needle in _search_text(r)]
    rows = out.sort_cases(rows, sort)
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    items = [out.case_summary(r, lk) for r in rows[off : off + lim]]
    return {"items": items, "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None}


def _search_text(r: TestCase) -> str:
    """What `q` matches: key, title, objective, overall expected result, step actions and step expected results."""
    parts = [r.key, r.title, r.objective or "", r.expected_result or ""]
    for st in r.steps or []:
        parts += [str(st.get("action") or ""), str(st.get("expected") or "")]
    return "\n".join(parts).lower()


async def _pending_version(s: ScopedSession, project_id: uuid.UUID) -> int | None:
    st = await tds.design_stage(s, project_id)
    cand = (
        await s.execute(
            select(StageRun.version)
            .where(
                StageRun.workflow_stage_id == st.id,
                StageRun.review_status == "pending_review",
                StageRun.finished_at.is_not(None),
            )
            .order_by(StageRun.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return int(cand) if cand is not None else None


async def case_stats(s: ScopedSession, project_id: uuid.UUID, version: int | None = None) -> dict[str, Any]:
    run = await _run_or_none(s, project_id, version)
    if run is not None:
        await tds.ensure_lint_current(s, project_id, run.id)
    lk = await out.lookup(s, project_id, run)
    not_designed = list((run.output or {}).get("not_designed", [])) if run else []
    return out.stats(lk, not_designed=not_designed, pending=await _pending_version(s, project_id))


@router.get("/projects/{project_id}/test-cases/stats")
async def test_case_stats(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, stage_run_version: int | None = None
) -> dict[str, Any]:
    await _project(s, project_id)
    return await case_stats(s, project_id, stage_run_version)


@router.get("/projects/{project_id}/test-cases/by-key/{key}")
async def case_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal
) -> dict[str, Any]:
    await _project(s, project_id)
    run = await tds.current_run(s, project_id)
    row = (
        (
            await s.execute(select(TestCase).where(TestCase.stage_run_id == run.id, TestCase.key == key))
        ).scalar_one_or_none()
        if run
        else None
    )
    if row is None:
        raise NotFound("Test case not found")
    await tds.ensure_lint_current(s, project_id, row.stage_run_id)
    return await _detail(ctx, s, row)


@router.get("/test-cases/{case_id}")
async def get_case(case_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    row: TestCase = await c.load(s, TestCase, case_id, "Test case")
    await tds.ensure_lint_current(s, row.project_id, row.stage_run_id)
    return await _detail(ctx, s, row)


@router.get("/test-cases/{case_id}/revisions")
async def case_revisions(case_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row: TestCase = await c.load(s, TestCase, case_id, "Test case")
    return await _history(s, "test_case", row)


async def _history(s: ScopedSession, entity: str, row: Any) -> list[dict[str, Any]]:
    from app.services.serialize_p2 import revision_out

    revs = await history(s, entity, row.lineage_id)
    us = await ser.users_by_id(s, [r.changed_by for r in revs])
    return [revision_out(r, us) for r in revs]


@router.delete("/test-cases/{case_id}")
async def delete_case(case_id: uuid.UUID, s: ScopedSession, _p: MemberPrincipal) -> JSONResponse:
    await c.load(s, TestCase, case_id, "Test case")
    return JSONResponse(
        status_code=405,
        content={
            "error": {
                "code": "method_not_allowed",
                "message": "Test cases can't be deleted; deprecate or reject them instead (traceability)",
                "details": [],
            }
        },
        headers={"Allow": "GET, PATCH"},
    )


@router.get("/projects/{project_id}/test-design/lint")
async def lint_summary(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    await _project(s, project_id)
    run = await tds.current_run(s, project_id)
    if run is None:
        return {"rules_version": lint_rules.LINT_RULES_VERSION, "errors": 0, "warnings": 0, "by_code": {}, "cases": []}
    await tds.ensure_lint_current(s, project_id, run.id)
    cases = [x for x in await tds.cases_of(s, run.id) if x.status in tds.ACTIVE_CASE]
    by_code: dict[str, int] = {}
    for x in cases:
        for code in {i["code"] for i in x.lint or []}:
            by_code[code] = by_code.get(code, 0) + 1
    return {
        "rules_version": lint_rules.LINT_RULES_VERSION,
        "errors": sum(1 for x in cases for i in x.lint or [] if i.get("severity") == "error"),
        "warnings": sum(1 for x in cases for i in x.lint or [] if i.get("severity") == "warning"),
        "by_code": dict(sorted(by_code.items())),
        "titles": lint_rules.TITLES,
        "cases": [
            {"key": x.key, "id": str(x.id), "items": list(x.lint)} for x in sorted(cases, key=lambda y: y.key) if x.lint
        ],
    }


# ---------------------------------------------------------------- test cases: write


async def create_case(
    ctx: AppContext, s: ScopedSession, p: MemberPrincipal, project_id: uuid.UUID, body: CaseCreate,
    *, source: CaseSource = CaseSource.user, origin: Origin | None = None,
) -> TestCase:  # fmt: skip
    """Creates a draft case (no commit). `origin` keeps the label of rule content accepted from an assistant
    proposal; without it the case is a person's: assumed, generated_by human."""
    project = await _project(s, project_id)
    run = await tds.current_run(s, project_id)
    if run is None:
        raise GateBlocked(DESIGN_FIRST)
    _texts_guard(body.title, body.objective, body.expected_result, *(x.action + " " + x.expected for x in body.steps))
    req_l, ac_l = await _lineages_for(s, project_id, body.requirement_ids, body.acceptance_criterion_ids)
    steps, data_l = await _steps(s, run.id, body.steps)
    cond_lineage = None
    if body.condition_id is not None:
        cond = (
            await s.execute(
                select(TestCondition).where(TestCondition.id == body.condition_id, TestCondition.stage_run_id == run.id)
            )
        ).scalar_one_or_none()
        if cond is None:
            raise ValidationFailed(
                "Choose a condition from the current design",
                details=[{"field": "condition_id", "message": "Unknown condition."}],
            )
        cond_lineage = cond.lineage_id
    row = TestCase(
        organisation_id=project.organisation_id,
        project_id=project_id,
        stage_run_id=run.id,
        lineage_id=uuid.uuid4(),
        key=(await next_key(s, project.organisation_id, project_id, "TC"))[1],
        match_key=f"user:{uuid.uuid4()}",
        condition_lineage_id=cond_lineage,
        title=body.title.strip(),
        objective=body.objective.strip(),
        preconditions=body.preconditions,
        steps=steps,
        expected_result=body.expected_result.strip(),
        expected_result_status=ExpectedResultStatus.defined,
        test_type=body.test_type,
        test_level=body.test_level,
        technique=body.technique,
        suites=sorted(set(body.suites)),
        side_effects=sorted(set(body.side_effects)),
        design_basis_ref=origin.design_basis
        if origin
        else {"coverage_item": None, "explanation": "Written by a person"},
        automation_reason=f"{tds_preliminary()} Not assessed for cases written by people.",
        status=CaseStatus.draft,
        source=source,
        requirement_lineage_ids=req_l,
        ac_lineage_ids=ac_l,
        data_lineage_ids=data_l,
        provenance=origin.provenance if origin else Provenance.assumed,
        confidence=CONFIDENCE_CAP[origin.provenance if origin else Provenance.assumed],
        evidence_refs=list(origin.evidence_refs) if origin else [],
        generated_by=origin.generated_by if origin else GeneratedBy.human,
        human_edited=origin is None,
        updated_by=p.user.id,
    )
    s.add(row)
    await s.flush()
    await tds.link_case(s, row, await tds.ac_parents(s, project_id))
    await tds.refresh_derived(s, project_id, run.id, only=[row])
    await c.revise(
        s, entity_type="test_case", row=row, fields=TEST_CASE_SNAPSHOT, before=None, user_id=p.user.id, reason="Created"
    )
    audit(
        s,
        org_id=project.organisation_id,
        action="test_case.created",
        target_type="test_case",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"key": row.key, "source": source.value},
    )
    return row


def tds_preliminary() -> str:
    from app.domain.testdesign.generate import PRELIMINARY

    return PRELIMINARY


@router.post("/projects/{project_id}/test-cases", status_code=201)
async def post_case(
    project_id: uuid.UUID, body: CaseCreate, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row = await create_case(ctx, s, p, project_id, body)
    project = await _project(s, project_id)
    await _finish(ctx, s, p, project, True, f"{row.key} created")
    await _event(ctx, project, "test_case", row.key, "created")
    new_id = row.id
    s.expire_all()
    return await _detail(ctx, s, await c.load(s, TestCase, new_id, "Test case"))


async def patch_case_row(ctx: AppContext, s: ScopedSession, p: MemberPrincipal, row: TestCase, body: CasePatch) -> bool:
    """Applies a PATCH; returns whether G5 should reopen (the approved set changed)."""
    run = await _current(s, row)
    c.check_version(row, body.version)
    c.check_unlocked(row)
    fields = body.model_dump(exclude_unset=True)
    fields.pop("version", None)
    reason = fields.pop("change_reason", None)
    if body.priority_override is not None and not (body.priority_override_reason or "").strip():
        raise ValidationFailed(
            "Say why the priority is overridden",
            details=[{"field": "priority_override_reason", "message": "A reason is required for a priority override."}],
        )
    if body.priority_override is not None and body.clear_priority_override:
        raise ValidationFailed(
            "Set or clear the override, not both",
            details=[{"field": "clear_priority_override", "message": "Choose one."}],
        )
    before = snapshot(row, TEST_CASE_SNAPSHOT)
    texts = [body.title or "", body.objective or "", body.expected_result or ""]
    texts += [x.action + " " + x.expected for x in body.steps or []]
    _texts_guard(*texts)
    for name in ("title", "objective", "test_type", "test_level"):
        if name in fields and fields[name] is not None:
            setattr(row, name, str(fields[name]).strip())
    if body.preconditions is not None:
        row.preconditions = [x.strip()[:300] for x in body.preconditions if x.strip()]
    if body.suites is not None:
        row.suites = sorted(set(body.suites))
    if body.side_effects is not None:
        row.side_effects = sorted(set(body.side_effects))
    if body.steps is not None:
        row.steps, row.data_lineage_ids = await _steps(s, run.id, body.steps)
    wrote_expected = False
    if body.expected_result is not None:
        row.expected_result = body.expected_result.strip()
        wrote_expected = True
        if row.expected_result and row.expected_result_status == ExpectedResultStatus.open_question:
            # Decision D6: a person answered the open question; the result is theirs (assumed, human-written).
            row.expected_result_status = ExpectedResultStatus.defined
            row.open_question_ref = None
    if body.requirement_ids is not None or body.acceptance_criterion_ids is not None:
        req_l, ac_l = await _lineages_for(
            s, row.project_id, list(body.requirement_ids or []), list(body.acceptance_criterion_ids or [])
        )
        if body.requirement_ids is None:
            req_l = list(dict.fromkeys([*[str(x) for x in row.requirement_lineage_ids or []], *req_l]))
        row.requirement_lineage_ids = req_l
        row.ac_lineage_ids = ac_l if body.acceptance_criterion_ids is not None else row.ac_lineage_ids
    if body.priority_override is not None:
        row.priority_override = Priority(body.priority_override)
        row.priority_override_reason = (body.priority_override_reason or "").strip()
        row.priority_overridden_by = p.user.id
        row.priority_overridden_at = utcnow()
    elif body.clear_priority_override:
        row.priority_override = None
        row.priority_override_reason = None
        row.priority_overridden_by = None
        row.priority_overridden_at = None
    after = snapshot(row, TEST_CASE_SNAPSHOT)
    if after == before:
        return False
    if wrote_expected or body.steps is not None:
        row.provenance = Provenance.assumed  # the expected result is now a person's statement
        row.confidence = min(row.confidence, CONFIDENCE_CAP[Provenance.assumed])
    was_approved = row.status == CaseStatus.approved
    override_only = {k for k in after if before.get(k) != after.get(k)} <= {
        "priority_override",
        "priority_override_reason",
        "suites",  # organising tags: still reopens G5, but the case stays approved
    }
    if was_approved and not override_only:
        row.status = CaseStatus.draft
        row.status_comment = "Edited after approval"
        row.status_changed_by = p.user.id
        row.status_changed_at = utcnow()
    row.version += 1
    row.human_edited = True
    row.updated_by = p.user.id
    row.updated_at = utcnow()
    await s.flush()
    await tds.link_case(s, row, await tds.ac_parents(s, row.project_id))
    await tds.refresh_derived(s, row.project_id, row.stage_run_id, only=[row])
    await _revise_case(s, row, before, p.user.id, reason or "Edited")
    audit(
        s,
        org_id=row.organisation_id,
        action="test_case.updated",
        target_type="test_case",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=row.project_id,
        metadata={
            "key": row.key,
            "fields": sorted(k for k in after if before.get(k) != after.get(k)),
            "reason": reason,
        },
    )
    return was_approved


@router.patch("/test-cases/{case_id}")
async def patch_case(
    case_id: uuid.UUID, body: CasePatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestCase = await c.load(s, TestCase, case_id, "Test case")
    project = await _project(s, row.project_id)
    reopen = await patch_case_row(ctx, s, p, row, body)
    await _finish(ctx, s, p, project, reopen, f"{row.key} edited")
    await _event(ctx, project, "test_case", row.key, "updated")
    s.expire_all()
    return await _detail(ctx, s, await c.load(s, TestCase, case_id, "Test case"))


def _open_question_message(row: TestCase) -> str:
    key = (row.open_question_ref or {}).get("key") or "the requirement"
    return f"Write an expected result or resolve {key} first"


async def set_case_status(
    s: ScopedSession, row: TestCase, status: str, comment: str | None, user_id: uuid.UUID, *, reason: str | None = None
) -> bool:
    """Returns whether the approved set changed. Raises 422 with the blocking lint items for approval."""
    new = CaseStatus(status)
    text = (comment or "").strip()
    if new == row.status:
        return False
    if new == CaseStatus.approved:
        await tds.refresh_derived(s, row.project_id, row.stage_run_id, only=[row])
        blocking = lint_rules.blocking(list(row.lint or []))
        if blocking:
            message = (
                _open_question_message(row)
                if any(i["code"] == "open_question" for i in blocking)
                else f"Fix {len(blocking)} check{'s' if len(blocking) != 1 else ''} before approving"
            )
            raise ValidationFailed(message, details=[{"field": i.get("path") or "lint", **i} for i in blocking])
    if new == CaseStatus.rejected and not text and not reason:
        raise ValidationFailed(
            "A reason is required to reject a test case",
            details=[{"field": "comment", "message": "Say why (it is kept with the case)."}],
        )
    if new == CaseStatus.deprecated:
        if row.status != CaseStatus.approved:
            raise ValidationFailed(
                "Only approved test cases can be deprecated",
                details=[{"field": "status", "message": "Reject a draft instead."}],
            )
        if not text:
            raise ValidationFailed(
                "Say why this test case no longer applies",
                details=[{"field": "comment", "message": "A reason is required to deprecate."}],
            )
    before = {"status": row.status.value, "status_comment": row.status_comment}
    changed = CaseStatus.approved in (new, row.status)
    row.status = new
    row.status_comment = text or (REASON_TEXT.get(reason or ""))
    row.status_changed_by = user_id
    row.status_changed_at = utcnow()
    row.version += 1
    row.updated_by = user_id
    await _revise_case(s, row, before, user_id, text or f"Status set to {new.value}")
    if new == CaseStatus.rejected:
        s.add(_knowledge(row, "test_case", text or REASON_TEXT.get(reason or "other", "Rejected")))
    audit(
        s,
        org_id=row.organisation_id,
        action="test_case.deprecated" if new == CaseStatus.deprecated else "test_case.status_changed",
        target_type="test_case",
        target_id=row.id,
        actor_user_id=user_id,
        project_id=row.project_id,
        metadata={"key": row.key, "status": new.value, "comment": text or None, "reason": reason},
    )
    return changed


@router.post("/test-cases/{case_id}/status")
async def case_status(
    case_id: uuid.UUID, body: CaseStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestCase = await c.load(s, TestCase, case_id, "Test case")
    await _current(s, row)
    c.check_version(row, body.version)
    project = await _project(s, row.project_id)
    if (body.reason or body.duplicate_of) and body.status != "rejected":
        raise ValidationFailed(
            "A reason applies to rejections only", details=[{"field": "reason", "message": "Only when rejecting."}]
        )
    comment = body.comment
    if body.reason == "duplicate" and body.duplicate_of is not None:
        dup = (
            await s.execute(
                select(TestCase).where(TestCase.id == body.duplicate_of, TestCase.stage_run_id == row.stage_run_id)
            )
        ).scalar_one_or_none()
        if dup is None or dup.id == row.id:
            raise ValidationFailed(
                "Choose another test case from this design",
                details=[{"field": "duplicate_of", "message": "Not a case in this design."}],
            )
        comment = f"Duplicate of {dup.key}" + (f": {comment.strip()}" if comment and comment.strip() else "")
    reopen = await set_case_status(s, row, body.status, comment, p.user.id, reason=body.reason)
    await _finish(ctx, s, p, project, reopen, f"{row.key} status changed")
    await _event(ctx, project, "test_case", row.key, f"is now {row.status.value}")
    s.expire_all()
    return await _detail(ctx, s, await c.load(s, TestCase, case_id, "Test case"))


@router.post("/projects/{project_id}/test-cases/bulk-status")
async def bulk_case_status(
    project_id: uuid.UUID, body: BulkStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await _project(s, project_id)
    run = await tds.current_run(s, project_id)
    if run is None:
        raise GateBlocked(DESIGN_FIRST)
    rows = list((await s.execute(select(TestCase).where(TestCase.id.in_(body.ids)))).scalars())
    found = {r.id: r for r in rows}
    updated: list[TestCase] = []
    skipped: list[dict[str, Any]] = []
    reopen = False
    for cid in body.ids:
        row = found.get(cid)
        if row is None or row.project_id != project_id:
            skipped.append({"id": str(cid), "key": None, "reason": "Not found"})
            continue
        if row.stage_run_id != run.id:
            skipped.append({"id": str(cid), "key": row.key, "reason": SUPERSEDED})
            continue
        if row.locked and body.status != "approved":
            skipped.append({"id": str(cid), "key": row.key, "reason": "Locked"})
            continue
        try:
            changed = await set_case_status(s, row, body.status, body.comment, p.user.id)
        except ValidationFailed as exc:
            reason = exc.message
            details = exc.details if isinstance(exc.details, list) else []
            items = [str(d["code"]) for d in details if d.get("code")]
            if items and "open_question" not in items:
                reason = f"Checks you must fix: {', '.join(lint_rules.TITLES.get(i, i).lower() for i in items)}"
            elif "open_question" in items:
                reason = "Open question"
            skipped.append({"id": str(cid), "key": row.key, "reason": reason})
            continue
        reopen = reopen or changed
        updated.append(row)
    await _finish(ctx, s, p, project, reopen and bool(updated), f"{len(updated)} test case(s) changed status")
    s.expire_all()
    run = await tds.current_run(s, project_id)
    lk = await out.lookup(s, project_id, run)
    ids = {u.id for u in updated}
    return {"updated": [out.case_summary(x, lk) for x in lk.cases if x.id in ids], "skipped": skipped}


@router.post("/test-cases/{case_id}/lock")
async def lock_case(
    case_id: uuid.UUID, body: LockBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestCase = await c.load(s, TestCase, case_id, "Test case")
    await _current(s, row)
    c.check_version(row, body.version)
    if row.locked != body.locked:
        before = {"locked": row.locked}
        row.locked = body.locked
        row.version += 1
        row.updated_by = p.user.id
        await _revise_case(s, row, before, p.user.id, "Locked" if body.locked else "Unlocked")
        audit(
            s,
            org_id=row.organisation_id,
            action="test_case.locked" if body.locked else "test_case.unlocked",
            target_type="test_case",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key},
        )
        await s.commit()
    s.expire_all()
    return await _detail(ctx, s, await c.load(s, TestCase, case_id, "Test case"))


@router.post("/test-cases/{case_id}/duplicate", status_code=201)
async def duplicate_case(
    case_id: uuid.UUID, body: DuplicateBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    src: TestCase = await c.load(s, TestCase, case_id, "Test case")
    await _current(s, src)
    project = await _project(s, src.project_id)
    row = TestCase(
        organisation_id=src.organisation_id,
        project_id=src.project_id,
        stage_run_id=src.stage_run_id,
        lineage_id=uuid.uuid4(),
        key=(await next_key(s, src.organisation_id, src.project_id, "TC"))[1],
        match_key=f"user:{uuid.uuid4()}",
        condition_lineage_id=src.condition_lineage_id,
        title=(body.title or f"Copy of {src.title}")[:200],
        objective=src.objective,
        preconditions=list(src.preconditions or []),
        steps=[dict(x) for x in src.steps or []],
        expected_result=src.expected_result,
        expected_result_status=src.expected_result_status,
        open_question_ref=dict(src.open_question_ref) if src.open_question_ref else None,
        test_type=src.test_type,
        test_level=src.test_level,
        technique=src.technique,
        suites=list(src.suites or []),
        side_effects=list(src.side_effects or []),
        design_basis_ref=dict(src.design_basis_ref or {}),
        automation_suitability=src.automation_suitability,
        automation_reason=src.automation_reason,
        status=CaseStatus.draft,
        source=CaseSource.user,
        requirement_lineage_ids=list(src.requirement_lineage_ids or []),
        ac_lineage_ids=list(src.ac_lineage_ids or []),
        data_lineage_ids=list(src.data_lineage_ids or []),
        provenance=Provenance.assumed,
        confidence=CONFIDENCE_CAP[Provenance.assumed],
        evidence_refs=list(src.evidence_refs or []),
        generated_by=GeneratedBy.human,
        human_edited=True,
        updated_by=p.user.id,
    )
    s.add(row)
    await s.flush()
    await tds.link_case(s, row, await tds.ac_parents(s, row.project_id))
    await tds.refresh_derived(s, row.project_id, row.stage_run_id)
    await c.revise(
        s, entity_type="test_case", row=row, fields=TEST_CASE_SNAPSHOT, before=None, user_id=p.user.id,
        reason=f"Duplicated from {src.key}",
    )  # fmt: skip
    audit(
        s,
        org_id=row.organisation_id,
        action="test_case.created",
        target_type="test_case",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=row.project_id,
        metadata={"key": row.key, "duplicated_from": src.key},
    )
    await _finish(ctx, s, p, project, True, f"{row.key} created")
    new_id = row.id
    s.expire_all()
    return await _detail(ctx, s, await c.load(s, TestCase, new_id, "Test case"))


# ---------------------------------------------------------------- test conditions


@router.get("/projects/{project_id}/test-conditions")
async def list_conditions(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    technique: str | None = None,
    status: str | None = None,
    requirement_key: str | None = None,
    feature_id: uuid.UUID | None = None,
    stage_run_version: int | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    await _project(s, project_id)
    run = await _run_or_none(s, project_id, stage_run_version)
    if run is None:
        return {"items": [], "next_cursor": None}
    lk = await out.lookup(s, project_id, run)
    rows = sorted(lk.conditions.values(), key=lambda x: x.key)
    if technique:
        rows = [r for r in rows if r.technique in technique.split(",")]
    if status:
        rows = [r for r in rows if r.status.value in status.split(",")]
    if requirement_key:
        lins = {lin for lin, r in lk.requirements.items() if r.key in requirement_key.split(",")}
        rows = [r for r in rows if lins & {str(x) for x in r.requirement_lineage_ids or []}]
    if feature_id is not None:
        rows = [r for r in rows if r.feature_lineage_id == feature_id]
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    items = [out.condition_out(r, lk) for r in rows[off : off + lim]]
    return {"items": items, "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None}


async def _condition_detail(s: ScopedSession, row: TestCondition) -> dict[str, Any]:
    run = await s.get(StageRun, row.stage_run_id)
    lk = await out.lookup(s, row.project_id, run, user_ids=[row.updated_by])
    fresh = lk.conditions.get(str(row.lineage_id), row)
    return out.condition_out(fresh, lk, with_cases=True)


@router.get("/test-conditions/{cond_id}")
async def get_condition(cond_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    row: TestCondition = await c.load(s, TestCondition, cond_id, "Test condition")
    return await _condition_detail(s, row)


@router.get("/test-conditions/{cond_id}/revisions")
async def condition_revisions(cond_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row: TestCondition = await c.load(s, TestCondition, cond_id, "Test condition")
    return await _history(s, "test_condition", row)


async def _condition_has_approved(s: ScopedSession, row: TestCondition) -> bool:
    return any(
        x.condition_lineage_id == row.lineage_id and x.status == CaseStatus.approved
        for x in await tds.cases_of(s, row.stage_run_id)
    )


@router.patch("/test-conditions/{cond_id}")
async def patch_condition(
    cond_id: uuid.UUID, body: ConditionPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestCondition = await c.load(s, TestCondition, cond_id, "Test condition")
    await _current(s, row)
    c.check_version(row, body.version)
    c.check_unlocked(row)
    project = await _project(s, row.project_id)
    before = snapshot(row, TEST_CONDITION_SNAPSHOT)
    if body.title is not None:
        row.title = body.title.strip()
    if body.description is not None:
        row.description = body.description.strip()
    if body.notes is not None:
        row.notes = [n.strip()[:500] for n in body.notes if n.strip()]
    after = snapshot(row, TEST_CONDITION_SNAPSHOT)
    reopen = False
    if after != before:
        row.version += 1
        row.human_edited = True
        row.updated_by = p.user.id
        await c.revise(
            s, entity_type="test_condition", row=row, fields=TEST_CONDITION_SNAPSHOT, before=before,
            user_id=p.user.id, reason=body.change_reason or "Edited",
        )  # fmt: skip
        audit(
            s,
            org_id=row.organisation_id,
            action="test_condition.updated",
            target_type="test_condition",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key, "reason": body.change_reason},
        )
        reopen = await _condition_has_approved(s, row)
    await _finish(ctx, s, p, project, reopen, f"{row.key} edited")
    s.expire_all()
    return await _condition_detail(s, await c.load(s, TestCondition, cond_id, "Test condition"))


@router.post("/test-conditions/{cond_id}/status")
async def condition_status(
    cond_id: uuid.UUID, body: ConditionStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestCondition = await c.load(s, TestCondition, cond_id, "Test condition")
    await _current(s, row)
    c.check_version(row, body.version)
    project = await _project(s, row.project_id)
    new = ItemStatus(body.status)
    text = (body.comment or "").strip()
    if new == ItemStatus.rejected and not text:
        raise ValidationFailed(
            "A reason is required to reject a condition",
            details=[{"field": "comment", "message": "Say why (it is kept with the condition)."}],
        )
    rejected: list[TestCase] = []
    reopen = False
    if new != row.status:
        before = {"status": row.status.value}
        row.status = new
        row.status_comment = text or None
        row.version += 1
        row.updated_by = p.user.id
        await c.revise(
            s, entity_type="test_condition", row=row, fields=TEST_CONDITION_SNAPSHOT, before=before,
            user_id=p.user.id, reason=text or f"Status set to {new.value}",
        )  # fmt: skip
        if new == ItemStatus.rejected:
            s.add(_knowledge(row, "test_condition", text))
            for case in await tds.cases_of(s, row.stage_run_id):
                if case.condition_lineage_id == row.lineage_id and case.status == CaseStatus.draft:
                    await set_case_status(s, case, "rejected", f"Condition {row.key} rejected: {text}", p.user.id)
                    rejected.append(case)
        audit(
            s,
            org_id=row.organisation_id,
            action="test_condition.status_changed",
            target_type="test_condition",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key, "status": new.value, "comment": text or None, "rejected_cases": len(rejected)},
        )
        reopen = await _condition_has_approved(s, row)
    await _finish(ctx, s, p, project, reopen, f"{row.key} status changed")
    s.expire_all()
    fresh = await c.load(s, TestCondition, cond_id, "Test condition")
    run = await s.get(StageRun, fresh.stage_run_id)
    lk = await out.lookup(s, fresh.project_id, run)
    return {
        "condition": out.condition_out(lk.conditions.get(str(fresh.lineage_id), fresh), lk, with_cases=True),
        "rejected_cases": [lk.case_ref(x) for x in lk.cases if x.id in {r.id for r in rejected}],
    }


@router.post("/test-conditions/{cond_id}/lock")
async def lock_condition(
    cond_id: uuid.UUID, body: LockBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestCondition = await c.load(s, TestCondition, cond_id, "Test condition")
    await _current(s, row)
    c.check_version(row, body.version)
    if row.locked != body.locked:
        before = {"locked": row.locked}
        row.locked = body.locked
        row.version += 1
        row.updated_by = p.user.id
        await c.revise(
            s, entity_type="test_condition", row=row, fields=TEST_CONDITION_SNAPSHOT, before=before,
            user_id=p.user.id, reason="Locked" if body.locked else "Unlocked",
        )  # fmt: skip
        audit(
            s,
            org_id=row.organisation_id,
            action="test_condition.locked" if body.locked else "test_condition.unlocked",
            target_type="test_condition",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key},
        )
        await s.commit()
    s.expire_all()
    return await _condition_detail(s, await c.load(s, TestCondition, cond_id, "Test condition"))


# ---------------------------------------------------------------- test data (P3-03)


@router.get("/projects/{project_id}/test-data")
async def list_data(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    field: str | None = None,
    feature_id: uuid.UUID | None = None,
    kind: str | None = None,
    used: bool | None = None,
    status: str | None = None,
    stage_run_version: int | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    await _project(s, project_id)
    run = await _run_or_none(s, project_id, stage_run_version)
    if run is None:
        return {"items": [], "next_cursor": None}
    lk = await out.lookup(s, project_id, run)
    rows = sorted(lk.data.values(), key=lambda d: d.key)
    if field:
        rows = [d for d in rows if d.field_label.lower() == field.lower()]
    if feature_id is not None:
        rows = [d for d in rows if d.feature_lineage_id == feature_id]
    if kind:
        rows = [d for d in rows if d.kind.value in kind.split(",")]
    if status:
        rows = [d for d in rows if d.status.value in status.split(",")]
    items = [out.data_out(d, lk) for d in rows]
    if used is not None:
        items = [i for i in items if (i["used_by_count"] > 0) == used]
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    return {
        "items": items[off : off + lim],
        "next_cursor": encode_cursor(off + lim) if off + lim < len(items) else None,
    }


async def _data_detail(s: ScopedSession, row: TestData) -> dict[str, Any]:
    run = await s.get(StageRun, row.stage_run_id)
    lk = await out.lookup(s, row.project_id, run, user_ids=[row.updated_by])
    fresh = lk.data.get(str(row.lineage_id), row)
    used = [x for x in lk.cases if str(fresh.lineage_id) in {str(y) for y in x.data_lineage_ids or []}]
    return {
        **out.data_out(fresh, lk),
        "used_by": [{**lk.case_ref(x), "status": x.status.value} for x in sorted(used, key=lambda x: x.key)],
    }


@router.get("/test-data/{data_id}")
async def get_data(data_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    row: TestData = await c.load(s, TestData, data_id, "Test data item")
    return await _data_detail(s, row)


@router.get("/test-data/{data_id}/revisions")
async def data_revisions(data_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row: TestData = await c.load(s, TestData, data_id, "Test data item")
    return await _history(s, "test_data", row)


def _guard(
    value: str | None,
    secret_ref: str | None,
    *,
    field_type: str | None,
    field_label: str,
    known: set[str],
    boundary_length: int | None = None,
) -> None:
    errors = syn.check_value(
        value,
        secret_ref=secret_ref,
        field_type=field_type,
        field_label=field_label,
        known_secrets=known,
        boundary_length=boundary_length,
    )
    if errors:
        raise ValidationFailed(errors[0].message, details=[{"field": e.field, "message": e.message} for e in errors])


def _value_type(value: str | None, kind: str, field_type: str | None) -> TestDataValueType:
    if kind == "secret_ref":
        return TestDataValueType.secret_ref
    v = value or ""
    if v == "":
        return TestDataValueType.empty
    if not v.strip():
        return TestDataValueType.whitespace
    if field_type == "email" or "@" in v:
        return TestDataValueType.email
    if field_type == "number":
        return TestDataValueType.number
    return TestDataValueType.text


@router.post("/projects/{project_id}/test-data", status_code=201)
async def create_data(
    project_id: uuid.UUID, body: DataCreate, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row = await create_data_row(s, p, project_id, body)
    project = await _project(s, project_id)
    key = row.key
    new_id = row.id
    await s.commit()
    await _event(ctx, project, "test_data", key, "created")
    s.expire_all()
    return await _data_detail(s, await c.load(s, TestData, new_id, "Test data item"))


async def create_data_row(
    s: ScopedSession, p: MemberPrincipal, project_id: uuid.UUID, body: DataCreate, *, origin: Origin | None = None
) -> TestData:
    """Creates a test data item without committing (the caller commits). `origin`: see `create_case`."""
    project = await _project(s, project_id)
    run = await tds.current_run(s, project_id)
    if run is None:
        raise GateBlocked(DESIGN_FIRST)
    form_ref = {
        k: v for k, v in (body.form_ref or {}).items() if k in ("form_anchor", "path", "field_type", "field_key")
    }
    field_type = str(form_ref.get("field_type") or "") or None
    if body.kind == "secret_ref" and not body.secret_ref:
        raise ValidationFailed(
            "Choose saved test credentials", details=[{"field": "secret_ref", "message": "Required for this kind."}]
        )
    if body.kind != "secret_ref" and body.secret_ref:
        raise ValidationFailed(
            "Use kind 'secret_ref' to reference saved credentials",
            details=[{"field": "kind", "message": "Set kind to secret_ref."}],
        )
    known = await tds.known_secret_refs(s, project_id)
    _guard(body.value, body.secret_ref, field_type=field_type, field_label=body.field_label, known=known)
    value = None if body.kind == "secret_ref" else (body.value or "")
    row = TestData(
        organisation_id=project.organisation_id,
        project_id=project_id,
        stage_run_id=run.id,
        lineage_id=uuid.uuid4(),
        key=(await next_key(s, project.organisation_id, project_id, "TD"))[1],
        match_key=f"user:{uuid.uuid4()}",
        name=body.name.strip(),
        form_ref=form_ref,
        field_label=body.field_label.strip(),
        kind=TestDataKind(body.kind),
        value_type=_value_type(value, body.kind, field_type),
        value=value,
        secret_ref=body.secret_ref if body.kind == "secret_ref" else None,
        length=len(value) if value is not None else None,
        generator="assistant" if origin else "human",
        synthetic=True,
        status=TestDataStatus.active,
        provenance=origin.provenance if origin else Provenance.assumed,
        confidence=CONFIDENCE_CAP[origin.provenance if origin else Provenance.assumed],
        evidence_refs=[],
        generated_by=origin.generated_by if origin else GeneratedBy.human,
        human_edited=origin is None,
        updated_by=p.user.id,
    )
    s.add(row)
    await s.flush()
    await _revise_data(s, row, None, p.user.id, "Created")
    audit(
        s,
        org_id=project.organisation_id,
        action="test_data.created",
        target_type="test_data",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"key": row.key, "kind": row.kind.value},
    )
    return row


async def _revise_data(
    s: ScopedSession, row: TestData, before: dict[str, Any] | None, user_id: uuid.UUID, reason: str | None
) -> None:
    from app.services import revisions

    after = data_snapshot(row)
    applying = c.PROPOSAL.get()
    if applying is not None:
        reason = f"Accepted assistant proposal {applying[1]}" + (
            f": {reason}" if reason and reason != "Created" else ""
        )
    await revisions.record(
        s,
        org_id=row.organisation_id,
        project_id=row.project_id,
        entity_type="test_data",
        entity_id=row.id,
        lineage_id=row.lineage_id,
        version=row.version,
        snapshot=after,
        changes=revisions.diff(before or {}, after),
        source="assistant" if applying else "user",
        changed_by=user_id,
        change_reason=reason,
        proposal_id=applying[0] if applying else None,
    )


@router.patch("/test-data/{data_id}")
async def patch_data(
    data_id: uuid.UUID, body: DataPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestData = await c.load(s, TestData, data_id, "Test data item")
    await _current(s, row)
    c.check_version(row, body.version)
    c.check_unlocked(row)
    project = await _project(s, row.project_id)
    field_type = (row.form_ref or {}).get("field_type")
    before = data_snapshot(row)
    if body.name is not None:
        row.name = body.name.strip()
    if body.value is not None or body.secret_ref is not None:
        if row.kind == TestDataKind.secret_ref:
            if body.value not in (None, ""):
                raise ValidationFailed(
                    syn.MSG_PASSWORD
                    if syn.is_password_field(field_type, row.field_label)
                    else "This item references saved test credentials; it can't hold a value",
                    details=[{"field": "value", "message": "Reference saved credentials only."}],
                )
            ref = body.secret_ref or row.secret_ref
            _guard(
                None,
                ref,
                field_type=field_type,
                field_label=row.field_label,
                known=await tds.known_secret_refs(s, row.project_id),
            )
            row.secret_ref = ref
        else:
            if body.secret_ref is not None:
                raise ValidationFailed(
                    "Only credential items can reference saved credentials",
                    details=[{"field": "secret_ref", "message": "Not allowed for this item."}],
                )
            boundary = row.length if row.boundary_ref and row.kind == TestDataKind.boundary else None
            _guard(
                body.value, None, field_type=field_type, field_label=row.field_label, known=set(),
                boundary_length=boundary,
            )  # fmt: skip
            row.value = body.value
            row.length = len(body.value or "")
            row.value_type = _value_type(body.value, row.kind.value, field_type)
            row.synthetic = True
    after = data_snapshot(row)
    affected: list[TestCase] = []
    reopen = False
    if after != before:
        row.version += 1
        row.human_edited = True
        row.updated_by = p.user.id
        await _revise_data(s, row, before, p.user.id, body.change_reason or "Edited")
        audit(
            s,
            org_id=row.organisation_id,
            action="test_data.updated",
            target_type="test_data",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key, "reason": body.change_reason},
        )
        affected = [
            x for x in await tds.used_by(s, row.stage_run_id, row.lineage_id) if x.status != CaseStatus.rejected
        ]
        await tds.refresh_derived(s, row.project_id, row.stage_run_id, only=affected)
        reopen = any(x.status == CaseStatus.approved for x in affected)
    await _finish(ctx, s, p, project, reopen, f"{row.key} edited")
    s.expire_all()
    fresh = await c.load(s, TestData, data_id, "Test data item")
    run = await s.get(StageRun, fresh.stage_run_id)
    lk = await out.lookup(s, fresh.project_id, run)
    ids = {x.id for x in affected}
    return {
        "item": out.data_out(lk.data.get(str(fresh.lineage_id), fresh), lk),
        "affected_cases": [lk.case_ref(x) for x in lk.cases if x.id in ids],
    }


@router.post("/test-data/{data_id}/status")
async def data_status(
    data_id: uuid.UUID, body: DataStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestData = await c.load(s, TestData, data_id, "Test data item")
    await _current(s, row)
    c.check_version(row, body.version)
    new = TestDataStatus(body.status)
    if new == TestDataStatus.retired:
        users_ = [
            x
            for x in await tds.used_by(s, row.stage_run_id, row.lineage_id)
            if x.status in (CaseStatus.draft, CaseStatus.approved)
        ]
        if users_:
            keys = ", ".join(sorted(x.key for x in users_))
            raise Conflict(
                f"{row.key} is used by {keys}; change those cases first",
                details={"used_by": sorted(x.key for x in users_)},
            )
    if new != row.status:
        before = data_snapshot(row)
        row.status = new
        row.version += 1
        row.updated_by = p.user.id
        await _revise_data(s, row, before, p.user.id, f"Status set to {new.value}")
        audit(
            s,
            org_id=row.organisation_id,
            action="test_data.status_changed",
            target_type="test_data",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key, "status": new.value},
        )
        await s.commit()
    s.expire_all()
    return await _data_detail(s, await c.load(s, TestData, data_id, "Test data item"))


@router.post("/test-data/{data_id}/lock")
async def lock_data(
    data_id: uuid.UUID, body: LockBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: TestData = await c.load(s, TestData, data_id, "Test data item")
    await _current(s, row)
    c.check_version(row, body.version)
    if row.locked != body.locked:
        before = data_snapshot(row)
        row.locked = body.locked
        row.version += 1
        row.updated_by = p.user.id
        await _revise_data(s, row, before, p.user.id, "Locked" if body.locked else "Unlocked")
        audit(
            s,
            org_id=row.organisation_id,
            action="test_data.locked" if body.locked else "test_data.unlocked",
            target_type="test_data",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key},
        )
        await s.commit()
    s.expire_all()
    return await _data_detail(s, await c.load(s, TestData, data_id, "Test data item"))
