"""Requirements, acceptance criteria and Definition of Ready/Done (P2-02, P2-03, P2-05)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import NotFound, ValidationFailed
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers import p2common as c
from app.db.models import (
    AcceptanceCriterion,
    KnowledgeItem,
    Project,
    ReadinessCriterion,
    Requirement,
    StageRun,
    requirement_features,
)
from app.db.types import utcnow
from app.domain.enums import (
    AcKind,
    BehaviourScope,
    GateKey,
    GeneratedBy,
    ItemStatus,
    KnowledgeKind,
    KnowledgeStatus,
    Provenance,
    ReadinessKind,
    ReadinessScope,
    ReadinessStatus,
    RequirementSource,
    RequirementStatus,
    RequirementType,
    StageKey,
)
from app.domain.provenance import ac_classification, apply_rules, clamp_confidence
from app.services import gates, revisions
from app.services import serialize_p2 as out
from app.services.adapters import AC_SNAPSHOT, READINESS_SNAPSHOT, REQUIREMENT, REQUIREMENT_SNAPSHOT
from app.services.audit import audit
from app.services.counters import next_key
from app.services.readiness import evaluate_row, load_facts

router = APIRouter(tags=["requirements"])

Category = Literal[
    "navigation",
    "content",
    "form_input",
    "validation",
    "authentication",
    "session",
    "search",
    "commerce",
    "account",
    "data_processing",
    "notification",
    "integration",
    "accessibility",
    "usability",
    "compatibility",
    "performance",
    "security",
    "privacy",
    "other",
]


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceRefIn(Body):
    evidence_id: uuid.UUID
    selector: str | None = Field(None, max_length=500)
    excerpt: str | None = Field(None, max_length=300)
    note: str | None = Field(None, max_length=300)


class RequirementCreate(Body):
    title: str = Field(min_length=5, max_length=160)
    description: str = Field("", max_length=2000)
    type: Literal["functional", "non_functional"]
    category: Category
    behaviour_scope: Literal["ui", "backend", "mixed"]
    evidence_refs: list[EvidenceRefIn] = []
    assumptions: list[str] = Field(default_factory=list, max_length=20)
    feature_ids: list[uuid.UUID] = []


class RequirementPatch(Body):
    version: int
    title: str | None = Field(None, min_length=5, max_length=160)
    description: str | None = Field(None, max_length=2000)
    type: Literal["functional", "non_functional"] | None = None
    category: Category | None = None
    behaviour_scope: Literal["ui", "backend", "mixed"] | None = None
    evidence_refs: list[EvidenceRefIn] | None = None
    assumptions: list[str] | None = Field(None, max_length=20)
    feature_ids: list[uuid.UUID] | None = None
    change_reason: str | None = Field(None, max_length=500)


RejectReason = Literal["not_applicable", "duplicate", "incorrect", "out_of_scope", "other"]
REASON_TEXT = {
    "not_applicable": "Not applicable",
    "duplicate": "Duplicate",
    "incorrect": "Incorrect",
    "out_of_scope": "Out of scope",
    "other": "Other",
}


class StatusBody(Body):
    version: int
    status: Literal["draft", "approved", "rejected", "needs_info"]
    comment: str | None = Field(None, max_length=2000)
    reason: RejectReason | None = None
    duplicate_of: uuid.UUID | None = None


class BulkStatusBody(Body):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    status: Literal["draft", "approved", "rejected", "needs_info"]
    comment: str | None = Field(None, max_length=2000)


class LockBody(Body):
    version: int
    locked: bool


class AcCreate(Body):
    kind: Literal["positive", "negative", "boundary"]
    given: str = Field(min_length=3, max_length=500)
    when: str = Field(min_length=3, max_length=500)
    then: str = Field(min_length=3, max_length=500)
    evidence_refs: list[EvidenceRefIn] = []


class AcPatch(Body):
    version: int
    given: str | None = Field(None, min_length=3, max_length=500)
    when: str | None = Field(None, min_length=3, max_length=500)
    then: str | None = Field(None, min_length=3, max_length=500)
    kind: Literal["positive", "negative", "boundary"] | None = None
    evidence_refs: list[EvidenceRefIn] | None = None
    change_reason: str | None = Field(None, max_length=500)


class AcStatusBody(Body):
    version: int
    status: Literal["draft", "approved", "rejected"]
    comment: str | None = Field(None, max_length=2000)


class ReadinessCreate(Body):
    kind: Literal["dor", "dod"]
    scope: Literal["requirement", "project"]
    text: str = Field(min_length=5, max_length=300)


class ReadinessPatch(Body):
    version: int
    text: str | None = Field(None, min_length=5, max_length=300)
    scope: Literal["requirement", "project"] | None = None
    position: int | None = Field(None, ge=0, le=1000)  # 0-based within its list (DoR or DoD); not a content edit
    change_reason: str | None = Field(None, max_length=500)


class ReadinessStatusBody(Body):
    version: int
    status: Literal["active", "removed"]


# ---------------------------------------------------------------- helpers


async def _req_run(s: ScopedSession, project_id: uuid.UUID, version: int | None) -> StageRun | None:
    st = await c.stage(s, project_id, StageKey.requirements)
    if version is None:
        if st.current_stage_run_id is None:
            return None
        run = await s.get(StageRun, st.current_stage_run_id)
        return run if run is not None and run.finished_at is not None else None
    run = (
        await s.execute(select(StageRun).where(StageRun.workflow_stage_id == st.id, StageRun.version == version))
    ).scalar_one_or_none()
    if run is None:
        raise NotFound("Requirements version not found")
    return run


async def _risk_run_id(s: ScopedSession, project_id: uuid.UUID) -> uuid.UUID | None:
    run, _ = await gates.current_strategy(s, project_id)
    return run.id if run else None


async def _valid_refs(s: ScopedSession, project_id: uuid.UUID, refs: list[EvidenceRefIn]) -> list[dict[str, Any]]:
    from app.agents.phase2 import project_evidence_ids

    ids = await project_evidence_ids(s, project_id, [r.evidence_id for r in refs])
    bad = [str(r.evidence_id) for r in refs if r.evidence_id not in ids]
    if bad:
        raise ValidationFailed(
            "Evidence not found in this project",
            details=[{"field": "evidence_refs", "message": f"Unknown evidence {', '.join(bad[:5])}"}],
        )
    return [r.model_dump(mode="json", exclude_none=True) for r in refs]


async def _valid_features(s: ScopedSession, project_id: uuid.UUID, ids: list[uuid.UUID]) -> list[str]:
    from app.db.models import ApplicationFeature

    if not ids:
        return []
    found = set(
        (
            await s.execute(
                select(ApplicationFeature.id).where(
                    ApplicationFeature.project_id == project_id, ApplicationFeature.id.in_(ids)
                )
            )
        ).scalars()
    )
    if len(found) != len(set(ids)):
        raise ValidationFailed("Feature not found", details=[{"field": "feature_ids", "message": "Unknown feature"}])
    return [str(i) for i in ids]


def _derive(row: Requirement) -> None:
    """Classification is code-owned: re-derived after every edit (never strengthened by an edit)."""
    decision = apply_rules(
        row.provenance,
        row.behaviour_scope,
        row.confidence,
        has_evidence=bool(row.evidence_refs),
        texts=(row.title, row.description),
        item_key=row.key,
    )
    row.provenance = decision.classification
    row.behaviour_scope = decision.behaviour_scope
    row.confidence = clamp_confidence(decision.classification, decision.confidence)


async def _in_g3_snapshot(s: ScopedSession, row: Requirement) -> bool:
    return row.status == RequirementStatus.approved


async def _project(s: ScopedSession, project_id: uuid.UUID) -> Project:
    return await c.project_of(s, project_id)


async def _detail(ctx: Ctx, s: ScopedSession, row: Requirement) -> dict[str, Any]:
    return await out.requirement_detail(ctx, s, row, risk_run_id=await _risk_run_id(s, row.project_id))


async def _finish(ctx: Ctx, s: ScopedSession, p: MemberPrincipal, project: Project, reopen: bool, reason: str) -> None:
    orch = await c.reopen_if_approved(ctx, s, project, GateKey.G3, reason, p.user.id) if reopen else None
    project.updated_at = utcnow()
    await s.commit()
    await c.after_commit(orch, p.scope, project.id)


# ---------------------------------------------------------------- requirements


@router.get("/projects/{project_id}/requirements")
async def list_requirements(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    status: str | None = None,
    classification: str | None = None,
    category: str | None = None,
    type: str | None = None,
    source: str | None = None,
    feature_id: uuid.UUID | None = None,
    without_ac: bool | None = None,
    locked: bool | None = None,
    q: str | None = Query(None, max_length=200),
    stage_run_version: int | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    await _project(s, project_id)
    run = await _req_run(s, project_id, stage_run_version)
    if run is None:
        return {"items": [], "next_cursor": None}
    stmt = select(Requirement).where(Requirement.stage_run_id == run.id)
    if status:
        stmt = stmt.where(Requirement.status.in_(status.split(",")))
    if classification:
        stmt = stmt.where(Requirement.provenance.in_(classification.split(",")))
    if category:
        stmt = stmt.where(Requirement.category.in_(category.split(",")))
    if type:
        stmt = stmt.where(Requirement.type.in_(type.split(",")))
    if source:
        stmt = stmt.where(Requirement.source.in_(source.split(",")))
    if locked is not None:
        stmt = stmt.where(Requirement.locked.is_(locked))
    if feature_id is not None:
        stmt = stmt.where(
            Requirement.id.in_(
                select(requirement_features.c.requirement_id).where(requirement_features.c.feature_id == feature_id)
            )
        )
    if q:
        like = f"%{q.lower()}%"
        from sqlalchemy import func, or_

        stmt = stmt.where(or_(func.lower(Requirement.title).like(like), func.lower(Requirement.key).like(like)))
    rows = list((await s.execute(stmt.order_by(Requirement.key))).scalars())
    if without_ac is not None:
        counts = await out.ac_counts(s, [r.id for r in rows])
        # "Without AC" = no acceptance criterion that isn't rejected (drafts count as having one).
        rows = [r for r in rows if (counts.get(r.id, (0, 0))[0] == 0) == without_ac]
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    page = rows[off : off + lim]
    items = await out.requirement_summaries(s, page, risk_run_id=await _risk_run_id(s, project_id))
    return {"items": items, "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None}


@router.get("/projects/{project_id}/requirements/stats")
async def requirement_stats(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, stage_run_version: int | None = None
) -> dict[str, Any]:
    await _project(s, project_id)
    run = await _req_run(s, project_id, stage_run_version)
    rows = (
        list((await s.execute(select(Requirement).where(Requirement.stage_run_id == run.id))).scalars()) if run else []
    )
    acs = (
        list((await s.execute(select(AcceptanceCriterion).where(AcceptanceCriterion.stage_run_id == run.id))).scalars())
        if run
        else []
    )
    has_ac = {a.requirement_id for a in acs if a.status != ItemStatus.rejected}

    def by(attr: str, values: list[str]) -> dict[str, int]:
        d = dict.fromkeys(values, 0)
        for r in rows:
            v = getattr(r, attr)
            v = v.value if hasattr(v, "value") else v
            d[v] = d.get(v, 0) + 1
        return d

    st = await c.stage(s, project_id, StageKey.requirements)
    pending = (
        await s.execute(
            select(StageRun.version)
            .where(StageRun.workflow_stage_id == st.id, StageRun.review_status == "pending_review")
            .order_by(StageRun.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    uncovered = await gates.features_without_requirement(s, project_id)
    return {
        "stage_run_version": run.version if run else None,
        "generated_by": run.generated_by.value if run and run.generated_by else None,
        "total": len(rows),
        "by_classification": by("provenance", [x.value for x in Provenance]),
        "by_status": by("status", [x.value for x in RequirementStatus]),
        "by_type": by("type", [x.value for x in RequirementType]),
        "by_category": by("category", []),
        "by_source": by("source", [x.value for x in RequirementSource]),
        "without_ac": sum(1 for r in rows if r.id not in has_ac and r.status != RequirementStatus.rejected),
        "locked": sum(1 for r in rows if r.locked),
        "pending_review_version": pending,
        "features_without_requirement": [
            out.artefact_ref(project_id, "feature", f.id, f.key, f.name) for f in uncovered
        ],
        "acceptance_criteria": {
            "total": sum(1 for a in acs if a.status != ItemStatus.rejected),
            "approved": sum(1 for a in acs if a.status == ItemStatus.approved),
            "by_kind": {
                k.value: sum(1 for a in acs if a.kind == k and a.status != ItemStatus.rejected) for k in AcKind
            },
        },
    }


@router.get("/projects/{project_id}/requirements/diff")
async def requirement_diff(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    from_: int | None = Query(None, alias="from"),
    to: int | None = None,
) -> dict[str, Any]:
    await _project(s, project_id)
    to_run = await _req_run(s, project_id, to)
    if to_run is None:
        raise NotFound("No requirements yet")
    if from_ is None and (to_run.output or {}).get("diff"):
        return dict(to_run.output["diff"])
    st = await c.stage(s, project_id, StageKey.requirements)
    if from_ is None:
        prev = (
            await s.execute(
                select(StageRun)
                .where(
                    StageRun.workflow_stage_id == st.id,
                    StageRun.version < to_run.version,
                    StageRun.finished_at.is_not(None),
                    StageRun.review_status != "discarded",
                    StageRun.review_status != "pending_review",
                )
                .order_by(StageRun.version.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    else:
        prev = await _req_run(s, project_id, from_)
    new_rows = list((await s.execute(select(Requirement).where(Requirement.stage_run_id == to_run.id))).scalars())
    old_rows = (
        list((await s.execute(select(Requirement).where(Requirement.stage_run_id == prev.id))).scalars())
        if prev
        else []
    )
    old = {r.lineage_id: r for r in old_rows}
    added: list[str] = []
    changed: list[str] = []
    rejected: list[str] = []
    kept: list[str] = []
    for r in new_rows:
        o = old.get(r.lineage_id)
        if o is None:
            added.append(r.key)
        elif REQUIREMENT.content(o) != REQUIREMENT.content(r) or o.status != r.status:
            (rejected if r.status == RequirementStatus.rejected and o.status != r.status else changed).append(r.key)
        else:
            kept.append(r.key)
    return {
        "from_version": prev.version if prev else None,
        "to_version": to_run.version,
        "added": added,
        "changed": changed,
        "rejected_as_no_longer_found": rejected,
        "kept_current": [],
        "suppressed_rejected": [],
    }


@router.post("/projects/{project_id}/requirements", status_code=201)
async def create_requirement(
    project_id: uuid.UUID, body: RequirementCreate, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await _project(s, project_id)
    run = await _req_run(s, project_id, None)
    if run is None:
        raise ValidationFailed("Requirements haven't been generated yet; run discovery first")
    refs = await _valid_refs(s, project_id, body.evidence_refs)
    feats = await _valid_features(s, project_id, body.feature_ids)
    row = Requirement(
        organisation_id=project.organisation_id,
        project_id=project_id,
        stage_run_id=run.id,
        key=(await next_key(s, project.organisation_id, project_id, "REQ"))[1],
        match_key=f"user:{uuid.uuid4()}",
        title=body.title.strip(),
        description=body.description.strip(),
        type=RequirementType(body.type),
        category=body.category,
        behaviour_scope=BehaviourScope(body.behaviour_scope),
        provenance=Provenance.assumed,
        confidence=0.4,
        evidence_refs=refs,
        generated_by=GeneratedBy.human,
        source=RequirementSource.user,
        source_refs={},
        assumptions=[a.strip()[:300] for a in body.assumptions if a.strip()],
        status=RequirementStatus.draft,
        feature_ids=feats,
        updated_by=p.user.id,
        human_edited=True,
    )
    _derive(row)
    s.add(row)
    await s.flush()
    from app.agents.requirements.agent import link_features

    await link_features(s, row)
    await c.revise(
        s,
        entity_type="requirement",
        row=row,
        fields=REQUIREMENT_SNAPSHOT,
        before=None,
        user_id=p.user.id,
        reason="Created",
    )
    audit(
        s,
        org_id=project.organisation_id,
        action="requirement.created",
        target_type="requirement",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"key": row.key},
    )
    await _finish(ctx, s, p, project, False, "a requirement was added")
    return await _detail(ctx, s, row)


@router.get("/requirements/{req_id}")
async def get_requirement(req_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    row = await c.load(s, Requirement, req_id, "Requirement")
    return await _detail(ctx, s, row)


@router.get("/projects/{project_id}/requirements/by-key/{key}")
async def get_requirement_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal
) -> dict[str, Any]:
    """The requirement with this key in the current requirement set (keys are stable across regenerations)."""
    await _project(s, project_id)
    run = await _req_run(s, project_id, None)
    row = (
        (
            await s.execute(
                select(Requirement).where(Requirement.stage_run_id == run.id, Requirement.key == key.upper())
            )
        ).scalar_one_or_none()
        if run
        else None
    )
    if row is None:
        raise NotFound("Requirement not found")
    return await _detail(ctx, s, row)


@router.patch("/requirements/{req_id}")
async def patch_requirement(
    req_id: uuid.UUID, body: RequirementPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: Requirement = await c.load(s, Requirement, req_id, "Requirement")
    await c.ensure_current(s, row, StageKey.requirements)
    c.check_version(row, body.version)
    c.check_unlocked(row)
    project = await _project(s, row.project_id)
    from app.services.adapters import snapshot

    before = snapshot(row, REQUIREMENT_SNAPSHOT)
    was_approved = row.status == RequirementStatus.approved
    fields = body.model_dump(exclude_unset=True, exclude={"version", "change_reason"})
    if "evidence_refs" in fields:
        row.evidence_refs = await _valid_refs(s, row.project_id, body.evidence_refs or [])
    if "feature_ids" in fields:
        row.feature_ids = await _valid_features(s, row.project_id, body.feature_ids or [])
    for k in ("title", "description", "category"):
        if fields.get(k) is not None:
            setattr(row, k, str(fields[k]).strip())
    if body.type is not None:
        row.type = RequirementType(body.type)
    if body.behaviour_scope is not None:
        row.behaviour_scope = BehaviourScope(body.behaviour_scope)
    if body.assumptions is not None:
        row.assumptions = [a.strip()[:300] for a in body.assumptions if a.strip()]
    _derive(row)
    if snapshot(row, REQUIREMENT_SNAPSHOT) == before:
        return await _detail(ctx, s, row)
    row.human_edited = True
    if was_approved:
        row.status = RequirementStatus.draft
        row.status_comment = "Edited after approval"
    row.version += 1
    row.updated_by = p.user.id
    row.updated_at = utcnow()
    if "feature_ids" in fields:
        from app.agents.requirements.agent import link_features

        await link_features(s, row)
    await c.revise(
        s,
        entity_type="requirement",
        row=row,
        fields=REQUIREMENT_SNAPSHOT,
        before=before,
        user_id=p.user.id,
        reason=body.change_reason,
    )
    audit(
        s,
        org_id=row.organisation_id,
        action="requirement.updated",
        target_type="requirement",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=row.project_id,
        metadata={"key": row.key, "fields": sorted(fields)},
    )
    await _finish(ctx, s, p, project, was_approved, f"{row.key} was edited")
    return await _detail(ctx, s, row)


async def _approve_draft_criteria(s: ScopedSession, row: Requirement, user_id: uuid.UUID) -> list[AcceptanceCriterion]:
    """Approving a requirement approves its draft acceptance criteria in the same transaction (lead decision)."""
    drafts = list(
        (
            await s.execute(
                select(AcceptanceCriterion).where(
                    AcceptanceCriterion.requirement_id == row.id, AcceptanceCriterion.status == ItemStatus.draft
                )
            )
        ).scalars()
    )
    for ac in drafts:
        ac.status = ItemStatus.approved
        ac.version += 1
        ac.updated_by = user_id
        await c.revise(
            s,
            entity_type="acceptance_criterion",
            row=ac,
            fields=AC_SNAPSHOT,
            before={"status": ItemStatus.draft.value},
            user_id=user_id,
            reason=f"Approved with {row.key}",
        )
        audit(
            s,
            org_id=ac.organisation_id,
            action="ac.status_changed",
            target_type="acceptance_criterion",
            target_id=ac.id,
            actor_user_id=user_id,
            project_id=ac.project_id,
            metadata={"key": ac.key, "status": "approved", "cascade_from": row.key},
        )
    return drafts


async def _set_status(
    s: ScopedSession,
    row: Requirement,
    status: str,
    comment: str | None,
    user_id: uuid.UUID,
    cascaded: list[AcceptanceCriterion] | None = None,
) -> bool:
    """Returns whether the approved set changed. Approval cascades to draft ACs (collected in `cascaded`)."""
    new = RequirementStatus(status)
    if new in (RequirementStatus.rejected, RequirementStatus.needs_info) and not (comment or "").strip():
        raise ValidationFailed(
            "A comment is required", details=[{"field": "comment", "message": "Say why (it is kept with the item)."}]
        )
    if new == row.status:
        return False
    before = {"status": row.status.value}
    changed_approved = RequirementStatus.approved in (new, row.status)
    row.status = new
    row.status_comment = (comment or "").strip() or None
    row.status_changed_by = user_id
    row.status_changed_at = utcnow()
    row.version += 1
    row.updated_by = user_id
    await c.revise(
        s,
        entity_type="requirement",
        row=row,
        fields=REQUIREMENT_SNAPSHOT,
        before=before,
        user_id=user_id,
        reason=comment or f"Status set to {new.value}",
    )
    if new == RequirementStatus.approved:
        acs = await _approve_draft_criteria(s, row, user_id)
        if cascaded is not None:
            cascaded.extend(acs)
    if new == RequirementStatus.rejected:
        s.add(
            KnowledgeItem(
                organisation_id=row.organisation_id,
                project_id=row.project_id,
                kind=KnowledgeKind.decision,
                title=f"{row.key} rejected: {row.title}"[:300],
                content=(comment or "").strip(),
                provenance=Provenance.observed,
                evidence_refs=[],
                source="requirement_review",
                status=KnowledgeStatus.active,
                meta={
                    "entity_type": "requirement",
                    "decision": "rejected",
                    "lineage_id": str(row.lineage_id),
                    "match_key": row.match_key,
                },
            )
        )
    audit(
        s,
        org_id=row.organisation_id,
        action="requirement.status_changed",
        target_type="requirement",
        target_id=row.id,
        actor_user_id=user_id,
        project_id=row.project_id,
        metadata={"key": row.key, "status": new.value, "comment": comment},
    )
    return changed_approved


@router.post("/requirements/{req_id}/status")
async def requirement_status(
    req_id: uuid.UUID, body: StatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: Requirement = await c.load(s, Requirement, req_id, "Requirement")
    await c.ensure_current(s, row, StageKey.requirements)
    c.check_version(row, body.version)
    project = await _project(s, row.project_id)
    comment = body.comment
    status_reason: dict[str, Any] | None = None
    if body.reason is not None or body.duplicate_of is not None:
        if body.status != "rejected":
            raise ValidationFailed(
                "A reason applies to rejections only", details=[{"field": "reason", "message": "Only when rejecting."}]
            )
        if body.duplicate_of is not None and body.reason != "duplicate":
            raise ValidationFailed(
                "duplicate_of needs reason 'duplicate'", details=[{"field": "duplicate_of", "message": "Set reason."}]
            )
        dup_key = None
        if body.reason == "duplicate":
            if body.duplicate_of is None:
                raise ValidationFailed(
                    "Choose the requirement this duplicates",
                    details=[{"field": "duplicate_of", "message": "Required for duplicates."}],
                )
            dup = (
                await s.execute(
                    select(Requirement).where(
                        Requirement.id == body.duplicate_of, Requirement.stage_run_id == row.stage_run_id
                    )
                )
            ).scalar_one_or_none()
            if dup is None or dup.id == row.id:
                raise ValidationFailed(
                    "Choose another requirement from this set",
                    details=[{"field": "duplicate_of", "message": "Not a requirement in this set."}],
                )
            dup_key = dup.key
        label = REASON_TEXT[body.reason or "other"] + (f" of {dup_key}" if dup_key else "")
        typed = (comment or "").strip()
        comment = f"{label}: {typed}" if typed else label
        status_reason = {"reason": body.reason, "duplicate_of": str(body.duplicate_of) if body.duplicate_of else None}
    reopen = await _set_status(s, row, body.status, comment, p.user.id)
    refs = {k: v for k, v in (row.source_refs or {}).items() if k != "status_reason"}
    row.source_refs = {**refs, "status_reason": status_reason} if status_reason else refs
    await _finish(ctx, s, p, project, reopen, f"{row.key} status changed")
    return await _detail(ctx, s, row)


@router.post("/projects/{project_id}/requirements/bulk-status")
async def bulk_status(
    project_id: uuid.UUID, body: BulkStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await _project(s, project_id)
    run = await _req_run(s, project_id, None)
    rows = (
        {r.id: r for r in (await s.execute(select(Requirement).where(Requirement.id.in_(body.ids)))).scalars()}
        if run
        else {}
    )
    updated: list[Requirement] = []
    skipped: list[dict[str, Any]] = []
    cascaded: list[AcceptanceCriterion] = []
    reopen = False
    for rid in body.ids:
        r = rows.get(rid)
        if r is None or r.project_id != project_id:
            skipped.append({"id": rid, "key": None, "reason": "Not found"})
            continue
        if run is None or r.stage_run_id != run.id:
            skipped.append({"id": rid, "key": r.key, "reason": "Superseded by a newer version"})
            continue
        try:
            reopen = await _set_status(s, r, body.status, body.comment, p.user.id, cascaded) or reopen
        except ValidationFailed:
            skipped.append({"id": rid, "key": r.key, "reason": "A comment is required"})
            continue
        updated.append(r)
    await _finish(ctx, s, p, project, reopen, f"{len(updated)} requirement(s) changed status")
    keys = {r.id: r.key for r in updated}
    us = await out.users(s, [p.user.id])
    return {
        "updated": await out.requirement_summaries(s, updated, risk_run_id=await _risk_run_id(s, project_id)),
        "skipped": skipped,
        # ACs approved together with their requirement (cascade), so the client needn't refetch each detail.
        "approved_acceptance_criteria": [out.ac_out(a, keys.get(a.requirement_id, ""), us) for a in cascaded],
    }


@router.post("/requirements/{req_id}/lock")
async def lock_requirement(
    req_id: uuid.UUID, body: LockBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: Requirement = await c.load(s, Requirement, req_id, "Requirement")
    await c.ensure_current(s, row, StageKey.requirements)
    c.check_version(row, body.version)
    if row.locked != body.locked:
        before = {"locked": row.locked}
        row.locked = body.locked
        row.version += 1
        row.updated_by = p.user.id
        await c.revise(
            s,
            entity_type="requirement",
            row=row,
            fields=REQUIREMENT_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason="Locked" if body.locked else "Unlocked",
        )
        audit(
            s,
            org_id=row.organisation_id,
            action="requirement.locked" if body.locked else "requirement.unlocked",
            target_type="requirement",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
        )
        await s.commit()
    return await _detail(ctx, s, row)


async def _revisions(s: ScopedSession, entity_type: str, lineage_id: uuid.UUID) -> list[dict[str, Any]]:
    revs = await revisions.history(s, entity_type, lineage_id)
    us = await out.users(s, [r.changed_by for r in revs])
    return [out.revision_out(r, us) for r in revs]


@router.get("/requirements/{req_id}/revisions")
async def requirement_revisions(req_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row = await c.load(s, Requirement, req_id, "Requirement")
    return await _revisions(s, "requirement", row.lineage_id)


@router.get("/requirements/{req_id}/readiness")
async def requirement_readiness(req_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row = await c.load(s, Requirement, req_id, "Requirement")
    st = await c.stage(s, row.project_id, StageKey.readiness_criteria)
    if st.current_stage_run_id is None:
        return []
    crit = (
        await s.execute(
            select(ReadinessCriterion)
            .where(
                ReadinessCriterion.stage_run_id == st.current_stage_run_id,
                ReadinessCriterion.kind == ReadinessKind.dor,
                ReadinessCriterion.scope == ReadinessScope.requirement,
                ReadinessCriterion.status == ReadinessStatus.active,
            )
            .order_by(ReadinessCriterion.sort_order)
        )
    ).scalars()
    facts = await load_facts(s, row.project_id)
    result = []
    for cr in crit:
        ev = evaluate_row(cr, facts, requirement_id=str(row.id)) or {
            "criterion_key": cr.key,
            "status": "unknown",
            "detail": "Manual criterion: check it yourself",
            "evidence": [],
            "evaluated_at": datetime.now().astimezone().isoformat(),
        }
        result.append({**ev, "text": cr.text})
    return result


# ---------------------------------------------------------------- acceptance criteria


async def _ac_context(s: ScopedSession, ac: AcceptanceCriterion) -> Requirement:
    req: Requirement = await c.load(s, Requirement, ac.requirement_id, "Requirement")
    await c.ensure_current(s, req, StageKey.requirements)
    return req


async def _ac_out(s: ScopedSession, ac: AcceptanceCriterion, req: Requirement) -> dict[str, Any]:
    us = await out.users(s, [ac.updated_by])
    return out.ac_out(ac, req.key, us)


def _ac_classify(ac: AcceptanceCriterion, req: Requirement) -> None:
    ac.provenance = ac_classification(
        ac.provenance,
        requirement=req.provenance,
        exercised=ac.exercised and bool(ac.evidence_refs),
        has_evidence=bool(ac.evidence_refs),
        then_text=ac.then_text,
    )
    ac.confidence = clamp_confidence(ac.provenance, ac.confidence)


@router.post("/requirements/{req_id}/acceptance-criteria", status_code=201)
async def create_ac(
    req_id: uuid.UUID, body: AcCreate, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    req: Requirement = await c.load(s, Requirement, req_id, "Requirement")
    await c.ensure_current(s, req, StageKey.requirements)
    project = await _project(s, req.project_id)
    refs = await _valid_refs(s, req.project_id, body.evidence_refs)
    order = len(
        list(
            (await s.execute(select(AcceptanceCriterion.id).where(AcceptanceCriterion.requirement_id == req.id))).all()
        )
    )
    ac = AcceptanceCriterion(
        organisation_id=req.organisation_id,
        project_id=req.project_id,
        stage_run_id=req.stage_run_id,
        requirement_id=req.id,
        key=(await next_key(s, req.organisation_id, req.project_id, "AC"))[1],
        match_key=f"user:{uuid.uuid4()}",
        kind=AcKind(body.kind),
        given_text=body.given.strip(),
        when_text=body.when.strip(),
        then_text=body.then.strip(),
        provenance=Provenance.assumed,
        confidence=0.4,
        evidence_refs=refs,
        generated_by=GeneratedBy.human,
        status=ItemStatus.draft,
        sort_order=order,
        human_edited=True,
        updated_by=p.user.id,
    )
    s.add(ac)
    await s.flush()
    await c.revise(
        s,
        entity_type="acceptance_criterion",
        row=ac,
        fields=AC_SNAPSHOT,
        before=None,
        user_id=p.user.id,
        reason="Created",
    )
    audit(
        s,
        org_id=req.organisation_id,
        action="ac.created",
        target_type="acceptance_criterion",
        target_id=ac.id,
        actor_user_id=p.user.id,
        project_id=req.project_id,
        metadata={"key": ac.key, "requirement": req.key},
    )
    reopen = await _back_to_draft(s, req, p.user.id, f"Acceptance criterion {ac.key} added after approval")
    await _finish(ctx, s, p, project, reopen, f"{ac.key} was added")
    return await _ac_out(s, ac, req)


async def _back_to_draft(s: ScopedSession, req: Requirement, user_id: uuid.UUID, reason: str) -> bool:
    """An approved requirement whose content changed goes back to draft (and G3 reopens). Returns whether it did."""
    if req.status != RequirementStatus.approved:
        return False
    before = {"status": req.status.value}
    req.status = RequirementStatus.draft
    req.status_comment = reason
    req.status_changed_by = user_id
    req.status_changed_at = utcnow()
    req.version += 1
    req.updated_by = user_id
    await c.revise(
        s,
        entity_type="requirement",
        row=req,
        fields=REQUIREMENT_SNAPSHOT,
        before=before,
        user_id=user_id,
        reason=reason,
    )
    return True


@router.patch("/acceptance-criteria/{ac_id}")
async def patch_ac(ac_id: uuid.UUID, body: AcPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    from app.services.adapters import snapshot

    ac: AcceptanceCriterion = await c.load(s, AcceptanceCriterion, ac_id, "Acceptance criterion")
    req = await _ac_context(s, ac)
    c.check_version(ac, body.version)
    c.check_unlocked(ac)
    project = await _project(s, ac.project_id)
    before = snapshot(ac, AC_SNAPSHOT)
    was_approved = ac.status == ItemStatus.approved and req.status == RequirementStatus.approved
    if body.given is not None:
        ac.given_text = body.given.strip()
    if body.when is not None:
        ac.when_text = body.when.strip()
    if body.then is not None:
        ac.then_text = body.then.strip()
    if body.kind is not None:
        ac.kind = AcKind(body.kind)
    if body.evidence_refs is not None:
        ac.evidence_refs = await _valid_refs(s, ac.project_id, body.evidence_refs)
    _ac_classify(ac, req)
    if snapshot(ac, AC_SNAPSHOT) == before:
        return await _ac_out(s, ac, req)
    ac.human_edited = True
    if ac.status == ItemStatus.approved:
        ac.status = ItemStatus.draft
    ac.version += 1
    ac.updated_by = p.user.id
    ac.updated_at = utcnow()
    await c.revise(
        s,
        entity_type="acceptance_criterion",
        row=ac,
        fields=AC_SNAPSHOT,
        before=before,
        user_id=p.user.id,
        reason=body.change_reason,
    )
    audit(
        s,
        org_id=ac.organisation_id,
        action="ac.updated",
        target_type="acceptance_criterion",
        target_id=ac.id,
        actor_user_id=p.user.id,
        project_id=ac.project_id,
        metadata={"key": ac.key},
    )
    await _finish(ctx, s, p, project, was_approved, f"{ac.key} was edited")
    return await _ac_out(s, ac, req)


@router.post("/acceptance-criteria/{ac_id}/status")
async def ac_status(
    ac_id: uuid.UUID, body: AcStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    ac: AcceptanceCriterion = await c.load(s, AcceptanceCriterion, ac_id, "Acceptance criterion")
    req = await _ac_context(s, ac)
    c.check_version(ac, body.version)
    project = await _project(s, ac.project_id)
    new = ItemStatus(body.status)
    if new == ItemStatus.rejected and not (body.comment or "").strip():
        raise ValidationFailed("A comment is required", details=[{"field": "comment", "message": "Say why."}])
    reopen = False
    if new != ac.status:
        before = {"status": ac.status.value}
        reopen = req.status == RequirementStatus.approved and ItemStatus.approved in (new, ac.status)
        ac.status = new
        ac.version += 1
        ac.updated_by = p.user.id
        await c.revise(
            s,
            entity_type="acceptance_criterion",
            row=ac,
            fields=AC_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason=body.comment or f"Status set to {new.value}",
        )
        if new == ItemStatus.rejected:
            s.add(
                KnowledgeItem(
                    organisation_id=ac.organisation_id,
                    project_id=ac.project_id,
                    kind=KnowledgeKind.decision,
                    title=f"{ac.key} rejected"[:300],
                    content=(body.comment or "").strip(),
                    provenance=Provenance.observed,
                    evidence_refs=[],
                    source="requirement_review",
                    status=KnowledgeStatus.active,
                    meta={
                        "entity_type": "acceptance_criterion",
                        "decision": "rejected",
                        "lineage_id": str(ac.lineage_id),
                        "match_key": ac.match_key,
                    },
                )
            )
        audit(
            s,
            org_id=ac.organisation_id,
            action="ac.status_changed",
            target_type="acceptance_criterion",
            target_id=ac.id,
            actor_user_id=p.user.id,
            project_id=ac.project_id,
            metadata={"key": ac.key, "status": new.value},
        )
    await _finish(ctx, s, p, project, reopen, f"{ac.key} status changed")
    return await _ac_out(s, ac, req)


@router.post("/acceptance-criteria/{ac_id}/lock")
async def lock_ac(ac_id: uuid.UUID, body: LockBody, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    ac: AcceptanceCriterion = await c.load(s, AcceptanceCriterion, ac_id, "Acceptance criterion")
    req = await _ac_context(s, ac)
    c.check_version(ac, body.version)
    if ac.locked != body.locked:
        before = {"locked": ac.locked}
        ac.locked = body.locked
        ac.version += 1
        ac.updated_by = p.user.id
        await c.revise(
            s,
            entity_type="acceptance_criterion",
            row=ac,
            fields=AC_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason="Locked" if body.locked else "Unlocked",
        )
        await s.commit()
    return await _ac_out(s, ac, req)


@router.get("/acceptance-criteria/{ac_id}/revisions")
async def ac_revisions(ac_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    ac = await c.load(s, AcceptanceCriterion, ac_id, "Acceptance criterion")
    return await _revisions(s, "acceptance_criterion", ac.lineage_id)


# ---------------------------------------------------------------- Definition of Ready / Done


@router.get("/projects/{project_id}/readiness-criteria")
async def list_readiness(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, stage_run_version: int | None = None
) -> dict[str, Any]:
    await _project(s, project_id)
    st = await c.stage(s, project_id, StageKey.readiness_criteria)
    run: StageRun | None
    if stage_run_version is None:
        run = await s.get(StageRun, st.current_stage_run_id) if st.current_stage_run_id else None
        run = run if run is not None and run.finished_at is not None else None
    else:
        run = (
            await s.execute(
                select(StageRun).where(StageRun.workflow_stage_id == st.id, StageRun.version == stage_run_version)
            )
        ).scalar_one_or_none()
        if run is None:
            raise NotFound("Version not found")
    rows = (
        list(
            (
                await s.execute(
                    select(ReadinessCriterion)
                    .where(ReadinessCriterion.stage_run_id == run.id)
                    .order_by(ReadinessCriterion.sort_order, ReadinessCriterion.key)
                )
            ).scalars()
        )
        if run
        else []
    )
    facts = await load_facts(s, project_id)
    us = await out.users(s, [r.updated_by for r in rows])
    items = []
    for r in rows:
        d = out.readiness_out(r, us)
        if r.status == ReadinessStatus.active and stage_run_version is None:
            d["evaluation"] = evaluate_row(r, facts)  # always evaluated on read from current data
        items.append(d)
    return {
        "stage_run_version": run.version if run else None,
        "requirements_version": int((run.upstream_versions or {}).get("requirements", 0)) or None if run else None,
        "generated_by": run.generated_by.value if run and run.generated_by else None,
        "definition_of_ready": [i for i in items if i["kind"] == "dor"],
        "definition_of_done": [i for i in items if i["kind"] == "dod"],
    }


async def _readiness_finish(ctx: Ctx, s: ScopedSession, p: MemberPrincipal, project_id: uuid.UUID, reason: str) -> None:
    project = await _project(s, project_id)
    await _finish(ctx, s, p, project, True, reason)


@router.post("/projects/{project_id}/readiness-criteria", status_code=201)
async def create_readiness(
    project_id: uuid.UUID, body: ReadinessCreate, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await _project(s, project_id)
    st = await c.stage(s, project_id, StageKey.readiness_criteria)
    if st.current_stage_run_id is None:
        raise ValidationFailed("Definition of Ready/Done hasn't been generated yet")
    kind = ReadinessKind(body.kind)
    order = 1000 + len(
        list(
            (
                await s.execute(
                    select(ReadinessCriterion.id).where(ReadinessCriterion.stage_run_id == st.current_stage_run_id)
                )
            ).all()
        )
    )
    row = ReadinessCriterion(
        organisation_id=project.organisation_id,
        project_id=project_id,
        stage_run_id=st.current_stage_run_id,
        key=(await next_key(s, project.organisation_id, project_id, kind.value.upper()))[1],
        match_key=f"user:{uuid.uuid4()}",
        kind=kind,
        scope=ReadinessScope(body.scope),
        text=body.text.strip(),
        status=ReadinessStatus.active,
        provenance=Provenance.assumed,
        confidence=0.4,
        generated_by=GeneratedBy.human,
        sort_order=order,
        human_edited=True,
        updated_by=p.user.id,
    )
    s.add(row)
    await s.flush()
    await c.revise(
        s,
        entity_type="readiness_criterion",
        row=row,
        fields=READINESS_SNAPSHOT,
        before=None,
        user_id=p.user.id,
        reason="Created",
    )
    audit(
        s,
        org_id=project.organisation_id,
        action="readiness.created",
        target_type="readiness_criterion",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"key": row.key},
    )
    await _finish(ctx, s, p, project, True, f"{row.key} was added")
    us = await out.users(s, [row.updated_by])
    return out.readiness_out(row, us)


async def _readiness_row(s: ScopedSession, crit_id: uuid.UUID, version: int) -> ReadinessCriterion:
    row: ReadinessCriterion = await c.load(s, ReadinessCriterion, crit_id, "Criterion")
    await c.ensure_current(s, row, StageKey.readiness_criteria)
    c.check_version(row, version)
    return row


async def _move(s: ScopedSession, row: ReadinessCriterion, position: int) -> None:
    """Reorders the criterion within its kind. Order is presentation only: no version bump, gate stays as is."""
    siblings = [
        r
        for r in (
            await s.execute(
                select(ReadinessCriterion)
                .where(ReadinessCriterion.stage_run_id == row.stage_run_id, ReadinessCriterion.kind == row.kind)
                .order_by(ReadinessCriterion.sort_order, ReadinessCriterion.key)
            )
        ).scalars()
        if r.id != row.id
    ]
    siblings.insert(min(position, len(siblings)), row)
    for i, r in enumerate(siblings):
        r.sort_order = i


@router.patch("/readiness-criteria/{crit_id}")
async def patch_readiness(
    crit_id: uuid.UUID, body: ReadinessPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    from app.services.adapters import snapshot

    row = await _readiness_row(s, crit_id, body.version)
    if body.position is not None:
        await _move(s, row, body.position)
        if body.text is None and body.scope is None:
            await s.commit()
            return out.readiness_out(row, await out.users(s, [row.updated_by]))
    c.check_unlocked(row)
    before = snapshot(row, READINESS_SNAPSHOT)
    if body.text is not None:
        row.text = body.text.strip()
    if body.scope is not None:
        row.scope = ReadinessScope(body.scope)
    if snapshot(row, READINESS_SNAPSHOT) != before:
        row.human_edited = True
        row.version += 1
        row.updated_by = p.user.id
        row.updated_at = utcnow()
        await c.revise(
            s,
            entity_type="readiness_criterion",
            row=row,
            fields=READINESS_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason=body.change_reason,
        )
        audit(
            s,
            org_id=row.organisation_id,
            action="readiness.updated",
            target_type="readiness_criterion",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key},
        )
        await _readiness_finish(ctx, s, p, row.project_id, f"{row.key} was edited")
    us = await out.users(s, [row.updated_by])
    return out.readiness_out(row, us)


@router.post("/readiness-criteria/{crit_id}/status")
async def readiness_status(
    crit_id: uuid.UUID, body: ReadinessStatusBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row = await _readiness_row(s, crit_id, body.version)
    new = ReadinessStatus(body.status)
    if new != row.status:
        before = {"status": row.status.value}
        row.status = new
        row.version += 1
        row.updated_by = p.user.id
        await c.revise(
            s,
            entity_type="readiness_criterion",
            row=row,
            fields=READINESS_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason=f"Status set to {new.value}",
        )
        audit(
            s,
            org_id=row.organisation_id,
            action="readiness.status_changed",
            target_type="readiness_criterion",
            target_id=row.id,
            actor_user_id=p.user.id,
            project_id=row.project_id,
            metadata={"key": row.key, "status": new.value},
        )
        await _readiness_finish(ctx, s, p, row.project_id, f"{row.key} status changed")
    us = await out.users(s, [row.updated_by])
    return out.readiness_out(row, us)


@router.post("/readiness-criteria/{crit_id}/lock")
async def lock_readiness(crit_id: uuid.UUID, body: LockBody, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    row = await _readiness_row(s, crit_id, body.version)
    if row.locked != body.locked:
        before = {"locked": row.locked}
        row.locked = body.locked
        row.version += 1
        row.updated_by = p.user.id
        await c.revise(
            s,
            entity_type="readiness_criterion",
            row=row,
            fields=READINESS_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason="Locked" if body.locked else "Unlocked",
        )
        await s.commit()
    us = await out.users(s, [row.updated_by])
    return out.readiness_out(row, us)


@router.get("/readiness-criteria/{crit_id}/revisions")
async def readiness_revisions(crit_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row = await c.load(s, ReadinessCriterion, crit_id, "Criterion")
    return await _revisions(s, "readiness_criterion", row.lineage_id)
