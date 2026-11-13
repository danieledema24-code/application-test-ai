"""Shared plumbing for the Phase 2 agents (requirements, readiness, strategy, plan)."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.requirements.rules import DiscoveryInput, DocStatement
from app.db.models import (
    ApplicationFeature,
    DiscoveredPage,
    Evidence,
    KnowledgeItem,
    ScanSession,
    SourceDocument,
    StageRun,
    UserJourney,
    WorkflowStage,
)
from app.domain.enums import DocumentStatus, GeneratedBy, KnowledgeKind, KnowledgeStatus, ReviewStatus, StageKey


@dataclass
class StageOutcome:
    output: dict[str, Any]
    generated_by: GeneratedBy
    validation_issues: list[dict[str, Any]] = field(default_factory=list)
    llm: dict[str, Any] | None = None
    candidate: bool = False  # rows were written as a candidate that needs review
    partial: bool = False
    events: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)


async def stage_row(session: AsyncSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
    return (
        await session.execute(
            select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
        )
    ).scalar_one()


async def applied_run(session: AsyncSession, project_id: uuid.UUID, key: StageKey) -> StageRun | None:
    """The stage's current version, if it has produced one (a queued first run has no rows yet)."""
    st = await stage_row(session, project_id, key)
    if st.current_stage_run_id is None:
        return None
    run = (await session.execute(select(StageRun).where(StageRun.id == st.current_stage_run_id))).scalar_one_or_none()
    if run is None or run.finished_at is None:
        return None
    return run


async def project_evidence_ids(session: AsyncSession, project_id: uuid.UUID, ids: Iterable[Any]) -> set[uuid.UUID]:
    """Ids from `ids` that resolve to evidence in this project (tenant scope applies too)."""
    wanted: set[uuid.UUID] = set()
    for i in ids:
        try:
            wanted.add(uuid.UUID(str(i)))
        except ValueError:
            continue
    if not wanted:
        return set()
    rows = (
        await session.execute(select(Evidence.id).where(Evidence.project_id == project_id, Evidence.id.in_(wanted)))
    ).scalars()
    return set(rows)


def filter_refs(refs: list[dict[str, Any]], valid: set[uuid.UUID]) -> tuple[list[dict[str, Any]], int]:
    kept, dropped = [], 0
    for r in refs or []:
        try:
            ok = uuid.UUID(str(r.get("evidence_id"))) in valid
        except ValueError:
            ok = False
        if ok:
            kept.append({k: v for k, v in r.items() if k in ("evidence_id", "selector", "excerpt", "note")})
        else:
            dropped += 1
    return kept, dropped


async def rejected_decisions(
    session: AsyncSession, project_id: uuid.UUID, entity_type: str
) -> tuple[set[uuid.UUID], set[str]]:
    rows = (
        await session.execute(
            select(KnowledgeItem).where(
                KnowledgeItem.project_id == project_id,
                KnowledgeItem.kind == KnowledgeKind.decision,
                KnowledgeItem.status == KnowledgeStatus.active,
            )
        )
    ).scalars()
    lineages: set[uuid.UUID] = set()
    keys: set[str] = set()
    for k in rows:
        meta = k.meta or {}
        if meta.get("entity_type") != entity_type or meta.get("decision") != "rejected":
            continue
        if meta.get("lineage_id"):
            lineages.add(uuid.UUID(str(meta["lineage_id"])))
        if meta.get("match_key"):
            keys.add(str(meta["match_key"]))
    return lineages, keys


async def load_discovery(
    session: AsyncSession, project_id: uuid.UUID, *, include_documents: bool = True
) -> tuple[DiscoveryInput, StageRun, ScanSession] | None:
    drun = await applied_run(session, project_id, StageKey.discovery)
    if drun is None:
        return None
    scan = (await session.execute(select(ScanSession).where(ScanSession.stage_run_id == drun.id))).scalar_one_or_none()
    if scan is None:
        return None
    pages = list(
        (
            await session.execute(
                select(DiscoveredPage)
                .where(DiscoveredPage.scan_session_id == scan.id)
                .order_by(DiscoveredPage.sequence)
            )
        ).scalars()
    )
    features = list(
        (
            await session.execute(
                select(ApplicationFeature)
                .where(ApplicationFeature.scan_session_id == scan.id)
                .order_by(ApplicationFeature.key)
            )
        ).scalars()
    )
    journeys = list(
        (
            await session.execute(
                select(UserJourney).where(UserJourney.scan_session_id == scan.id).order_by(UserJourney.key)
            )
        ).scalars()
    )
    docs: list[DocStatement] = []
    if include_documents:
        for d in (
            await session.execute(
                select(SourceDocument)
                .where(SourceDocument.project_id == project_id, SourceDocument.status == DocumentStatus.ready)
                .order_by(SourceDocument.key)
            )
        ).scalars():
            if d.text_evidence_id is None:
                continue
            for st in d.statements or []:
                docs.append(
                    DocStatement(
                        document_id=d.id,
                        document_key=d.key,
                        text_evidence_id=d.text_evidence_id,
                        text=str(st.get("text", "")),
                        anchor=str(st.get("anchor", "")),
                        heading=str(st.get("heading", "")),
                        page=st.get("page"),
                    )
                )
    data = DiscoveryInput(
        scan_key=scan.key,
        scan_number=scan.sequence,
        start_url=scan.start_url,
        pages=pages,
        features=features,
        journeys=journeys,
        access_gaps=list(scan.access_gaps or []),
        auth_boundaries=list(scan.auth_boundaries or []),
        auth=scan.auth,
        documents=docs,
    )
    return data, drun, scan


def is_candidate_run(run: StageRun) -> bool:
    return run.review_status == ReviewStatus.pending_review
