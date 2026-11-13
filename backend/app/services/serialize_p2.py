"""ORM -> API mapping for Phase 2 artefacts (api-contracts.md "Phase 2 endpoints"). Plain dicts in contract shape."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import (
    AcceptanceCriterion,
    ApplicationFeature,
    EntityRevision,
    ReadinessCriterion,
    Requirement,
    Risk,
    StageRun,
    User,
    risk_requirements,
)
from app.domain.enums import ItemStatus, RiskLevel
from app.services import serialize as ser
from app.services.revisions import jsonable

LEVEL_ORDER = {RiskLevel.low: 0, RiskLevel.medium: 1, RiskLevel.high: 2, RiskLevel.very_high: 3}


def user_dict(u: User | None) -> dict[str, Any] | None:
    ref = ser.user_ref(u)
    return ref.model_dump(mode="json") if ref else None


async def users(s: AsyncSession, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, User]:
    return await ser.users_by_id(s, ids)


def refs(raw: list[Any] | None) -> list[dict[str, Any]]:
    return [
        {k: r.get(k) for k in ("evidence_id", "selector", "excerpt", "note")} for r in raw or [] if r.get("evidence_id")
    ]


def editable(row: Any, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    return {
        "version": row.version,
        "locked": row.locked,
        "human_edited": row.human_edited,
        "updated_at": row.updated_at,
        "updated_by": user_dict(us.get(row.updated_by)) if row.updated_by else None,
    }


def provenanced(row: Any) -> dict[str, Any]:
    return {
        "provenance": row.provenance.value,
        "classification": row.provenance.value,
        "confidence": row.confidence,
        "evidence_refs": refs(row.evidence_refs),
        "generated_by": row.generated_by.value,
    }


def path(project_id: uuid.UUID, kind: str, key: str) -> str:
    base = f"/projects/{project_id}"
    return {
        "requirement": f"{base}/requirements/{key}",
        "acceptance_criterion": f"{base}/requirements?ac={key}",
        "readiness_criterion": f"{base}/requirements?tab=ready-done",
        "feature": f"{base}/discovery?feature={key}",
        "risk": f"{base}/test-strategy?tab=risks&risk={key}",
        "document": f"{base}/documents/{key}",
    }.get(kind, base)


def artefact_ref(project_id: uuid.UUID, kind: str, id_: uuid.UUID | None, key: str, label: str) -> dict[str, Any]:
    return {
        "type": kind,
        "id": str(id_) if id_ else None,
        "key": key,
        "label": label,
        "path": path(project_id, kind, key),
    }


# ---------------------------------------------------------------- requirements


async def run_versions(s: AsyncSession, run_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, int]:
    ids = set(run_ids)
    if not ids:
        return {}
    return {r.id: r.version for r in (await s.execute(select(StageRun).where(StageRun.id.in_(ids)))).scalars()}


async def ac_counts(s: AsyncSession, req_ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[int, int]]:
    if not req_ids:
        return {}
    rows = (
        await s.execute(
            select(AcceptanceCriterion.requirement_id, AcceptanceCriterion.status, func.count())
            .where(AcceptanceCriterion.requirement_id.in_(req_ids))
            .group_by(AcceptanceCriterion.requirement_id, AcceptanceCriterion.status)
        )
    ).all()
    out: dict[uuid.UUID, list[int]] = {}
    for rid, status, n in rows:
        c = out.setdefault(rid, [0, 0])
        if status != ItemStatus.rejected:
            c[0] += n
        if status == ItemStatus.approved:
            c[1] += n
    return {k: (v[0], v[1]) for k, v in out.items()}


async def risk_levels(
    s: AsyncSession, lineages: list[uuid.UUID], risk_run_id: uuid.UUID | None
) -> dict[uuid.UUID, str]:
    if not lineages or risk_run_id is None:
        return {}
    rows = (
        await s.execute(
            select(risk_requirements.c.requirement_lineage_id, Risk.level)
            .join(Risk, Risk.id == risk_requirements.c.risk_id)
            .where(Risk.stage_run_id == risk_run_id, risk_requirements.c.requirement_lineage_id.in_(lineages))
        )
    ).all()
    best: dict[uuid.UUID, RiskLevel] = {}
    for lid, level in rows:
        if lid not in best or LEVEL_ORDER[level] > LEVEL_ORDER[best[lid]]:
            best[lid] = level
    return {k: v.value for k, v in best.items()}


def _feature_ids(r: Requirement) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    for f in r.feature_ids or []:
        try:
            out.append(uuid.UUID(str(f)))
        except ValueError:
            continue
    return out


async def feature_names(s: AsyncSession, rows: list[Requirement]) -> dict[uuid.UUID, str]:
    ids = {f for r in rows for f in _feature_ids(r)}
    if not ids:
        return {}
    q = select(ApplicationFeature.id, ApplicationFeature.name).where(ApplicationFeature.id.in_(ids))
    return {row[0]: row[1] for row in (await s.execute(q)).all()}


CHANGE_FIELDS = ("title", "description", "type", "category", "behaviour_scope", "provenance", "feature_ids")


def _fingerprint(r: Requirement) -> tuple[Any, ...]:
    return tuple(str(getattr(r, f)) for f in CHANGE_FIELDS)


async def changed_in_latest(s: AsyncSession, rows: list[Requirement]) -> set[uuid.UUID]:
    """Lineages whose content differs from the run this generation replaced (new lineages count as changed).
    Empty for a first generation: there is nothing to compare with."""
    out: set[uuid.UUID] = set()
    run_ids = {r.stage_run_id for r in rows}
    for run in (await s.execute(select(StageRun).where(StageRun.id.in_(run_ids)))).scalars() if run_ids else []:
        prev_id = (run.parameters or {}).get("previous_run_id")
        if not prev_id:
            continue
        prev = {
            p.lineage_id: _fingerprint(p)
            for p in (
                await s.execute(select(Requirement).where(Requirement.stage_run_id == uuid.UUID(str(prev_id))))
            ).scalars()
        }
        out |= {r.lineage_id for r in rows if r.stage_run_id == run.id and prev.get(r.lineage_id) != _fingerprint(r)}
    return out


def classification_reason(r: Requirement) -> str:
    """Why the requirement has its provenance label (plain language; derived from the stored fields)."""
    label = r.provenance.value
    n = len(r.evidence_refs or [])
    if r.source.value in ("user", "assistant") and label == "assumed":
        return "Added by a person without evidence, so it is assumed until confirmed."
    if r.source.value == "document":
        if label == "inferred":
            return "Stated in a source document and matched to a discovered feature; not directly observed."
        return "Stated in a source document but not found in the application yet."
    if r.behaviour_scope.value == "backend" and label != "observed":
        return "Backend behaviour can't be observed from the browser, so it is never classified as observed."
    if label == "observed":
        return f"Seen directly in the application ({n} evidence item{'s' if n != 1 else ''})."
    if label == "inferred":
        return "Concluded from what was seen in the application; the behaviour itself was not directly observed."
    if label == "unverified":
        return "Suggested by what was seen, but not confirmed in the application (for example behind sign-in)."
    return "Assumed without direct evidence; confirm with the product owner."


def has_conflict(r: Requirement) -> bool:
    return any("conflict" in str(i.get("code", "")) for i in r.validation_issues or [] if isinstance(i, dict))


async def requirement_summaries(
    s: AsyncSession, rows: list[Requirement], *, risk_run_id: uuid.UUID | None = None
) -> list[dict[str, Any]]:
    counts = await ac_counts(s, [r.id for r in rows])
    versions = await run_versions(s, [r.stage_run_id for r in rows])
    levels = await risk_levels(s, [r.lineage_id for r in rows], risk_run_id)
    us = await users(s, [r.updated_by for r in rows])
    names = await feature_names(s, rows)
    changed = await changed_in_latest(s, rows)
    return [
        requirement_summary(
            r, counts.get(r.id, (0, 0)), versions.get(r.stage_run_id, 0), levels, us, names=names, changed=changed
        )
        for r in rows
    ]


def requirement_summary(
    r: Requirement,
    counts: tuple[int, int],
    run_version: int,
    levels: dict[uuid.UUID, str],
    us: dict[uuid.UUID, User],
    *,
    names: dict[uuid.UUID, str] | None = None,
    changed: set[uuid.UUID] | None = None,
) -> dict[str, Any]:
    return {
        "id": r.id,
        "key": r.key,
        "lineage_id": r.lineage_id,
        "title": r.title,
        "conflict": has_conflict(r),
        "changed_in_latest": r.lineage_id in (changed or set()),
        "related_feature_names": [names[f] for f in _feature_ids(r) if names and f in names],
        "type": r.type.value,
        "category": r.category,
        "behaviour_scope": r.behaviour_scope.value,
        **provenanced(r),
        "source": r.source.value,
        "status": r.status.value,
        "ac_count": counts[0],
        "ac_approved": counts[1],
        "risk_level": levels.get(r.lineage_id) or r.risk_level,
        "stage_run_version": run_version,
        **editable(r, us),
    }


def ac_out(a: AcceptanceCriterion, req_key: str, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    return {
        "id": a.id,
        "key": a.key,
        "lineage_id": a.lineage_id,
        "requirement_id": a.requirement_id,
        "requirement_key": req_key,
        "kind": a.kind.value,
        "given": a.given_text,
        "when": a.when_text,
        "then": a.then_text,
        **provenanced(a),
        "status": a.status.value,
        "rule_id": a.rule_id,
        "test_values": a.test_values,
        "suggested_change": a.suggested_change,
        **editable(a, us),
    }


async def requirement_detail(
    ctx: AppContext, s: AsyncSession, r: Requirement, *, risk_run_id: uuid.UUID | None = None
) -> dict[str, Any]:
    acs = list(
        (
            await s.execute(
                select(AcceptanceCriterion)
                .where(AcceptanceCriterion.requirement_id == r.id)
                .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.key)
            )
        ).scalars()
    )
    us = await users(s, [r.updated_by, r.status_changed_by, *(a.updated_by for a in acs)])
    counts = (
        sum(1 for a in acs if a.status != ItemStatus.rejected),
        sum(1 for a in acs if a.status == ItemStatus.approved),
    )
    versions = await run_versions(s, [r.stage_run_id])
    levels = await risk_levels(s, [r.lineage_id], risk_run_id)
    feats = []
    fids = _feature_ids(r)
    if fids:
        feats = [
            artefact_ref(r.project_id, "feature", f.id, f.key, f.name)
            for f in (await s.execute(select(ApplicationFeature).where(ApplicationFeature.id.in_(fids)))).scalars()
        ]
    evs = await ser.evidence_map(s, [x.get("evidence_id") for x in r.evidence_refs or []])
    src = r.source_refs or {}
    return {
        **requirement_summary(
            r,
            counts,
            versions.get(r.stage_run_id, 0),
            levels,
            us,
            names=await feature_names(s, [r]),
            changed=await changed_in_latest(s, [r]),
        ),
        "classification_reason": classification_reason(r),
        "description": r.description,
        "assumptions": list(r.assumptions or []),
        "rule_id": r.rule_id,
        "related_features": feats,
        "source_refs": {k: list(src.get(k, [])) for k in ("journey_ids", "page_ids", "document_ids")},
        "acceptance_criteria": [ac_out(a, r.key, us) for a in acs],
        "linked_test_cases": [],
        "status_comment": r.status_comment,
        "status_reason": (src.get("status_reason") or {}).get("reason"),
        "duplicate_of": (src.get("status_reason") or {}).get("duplicate_of"),
        "status_changed_by": user_dict(us.get(r.status_changed_by)) if r.status_changed_by else None,
        "status_changed_at": r.status_changed_at,
        "validation_issues": list(r.validation_issues or []),
        "evidence": [ser.evidence_link(ctx, e).model_dump(mode="json") for e in evs.values()],
        "suggested_change": r.suggested_change,
        "created_at": r.created_at,
    }


def revision_out(rev: EntityRevision, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    return {
        "version": rev.version,
        "changed_by": user_dict(us.get(rev.changed_by)) if rev.changed_by else None,
        "change_reason": rev.change_reason,
        "source": rev.source,
        "created_at": rev.created_at,
        "changes": rev.changes or {},
        "snapshot": rev.snapshot or {},
        "proposal_id": rev.proposal_id,
    }


# ---------------------------------------------------------------- readiness and risks


def readiness_out(c: ReadinessCriterion, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    return {
        "id": c.id,
        "key": c.key,
        "lineage_id": c.lineage_id,
        "kind": c.kind.value,
        "scope": c.scope.value,
        "text": c.text,
        "status": c.status.value,
        "check": {"rule_id": c.check_rule_id, "evaluable_from_phase": c.evaluable_from_phase}
        if c.check_rule_id
        else None,
        "evaluation": c.evaluation,
        "position": c.sort_order,
        "generated_by": c.generated_by.value,
        **editable(c, us),
    }


async def risk_out(s: AsyncSession, r: Risk, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    lineages = []
    for x in r.requirement_lineage_ids or []:
        try:
            lineages.append(uuid.UUID(str(x)))
        except ValueError:
            continue
    reqs: list[dict[str, Any]] = []
    if lineages:
        from app.services import gates

        _run, current = await gates.current_requirements(s, r.project_id)
        reqs = [
            artefact_ref(r.project_id, "requirement", q.id, q.key, q.title) for q in current if q.lineage_id in lineages
        ]
    fids = []
    for f in r.feature_ids or []:
        try:
            fids.append(uuid.UUID(str(f)))
        except ValueError:
            continue
    feats = (
        [
            artefact_ref(r.project_id, "feature", f.id, f.key, f.name)
            for f in (await s.execute(select(ApplicationFeature).where(ApplicationFeature.id.in_(fids)))).scalars()
        ]
        if fids
        else []
    )
    return {
        "id": r.id,
        "key": r.key,
        "lineage_id": r.lineage_id,
        "title": r.title,
        "description": r.description,
        "category": r.category.value,
        "requirements": reqs,
        "features": feats,
        "likelihood": r.likelihood,
        "impact": r.impact,
        "score": r.score,
        "level": r.level.value,
        "factors": jsonable(r.factors),
        "likelihood_rationale": r.likelihood_rationale,
        "impact_rationale": r.impact_rationale,
        "mitigation": r.mitigation,
        "requires_approval": r.requires_approval,
        "status": r.status.value,
        "status_comment": r.status_comment,
        "source": r.source,
        "suggested_change": r.suggested_change,
        **provenanced(r),
        **editable(r, us),
    }
