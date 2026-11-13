from __future__ import annotations

import uuid

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from app.api.deps import Ctx, CurrentPrincipal, ScopedSession
from app.api.errors import NotFound
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers.projects import load_project
from app.db.models import (
    ApplicationFeature,
    DiscoveredPage,
    Evidence,
    KnowledgeItem,
    ScanSession,
    StageRun,
    UserJourney,
    WorkflowStage,
)
from app.domain.enums import StageKey
from app.schemas import api
from app.services import serialize as ser

router = APIRouter(tags=["scans"])


async def load_scan(s: ScopedSession, scan_id: uuid.UUID) -> ScanSession:
    scan = (await s.execute(select(ScanSession).where(ScanSession.id == scan_id))).scalar_one_or_none()
    if scan is None:
        raise NotFound("Scan not found")
    return scan


@router.get("/projects/{project_id}/scans", response_model=api.Page[api.ScanSummary])
async def list_scans(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    limit: int | None = Query(None, ge=1, le=100),
    cursor: str | None = None,
) -> api.Page[api.ScanSummary]:
    await load_project(s, project_id)
    lim, off = clamp_limit(limit), decode_cursor(cursor)
    rows = list(
        (
            await s.execute(
                select(ScanSession)
                .where(ScanSession.project_id == project_id)
                .order_by(ScanSession.sequence.desc())
                .offset(off)
                .limit(lim + 1)
            )
        )
        .scalars()
        .all()
    )
    latest = await ser.latest_scan_id(s, project_id)
    return api.Page[api.ScanSummary](
        items=[await ser.scan_summary(s, r, latest) for r in rows[:lim]],
        next_cursor=encode_cursor(off + lim) if len(rows) > lim else None,
    )


@router.get("/projects/{project_id}/scans/{number}", response_model=api.ScanDetail)
async def scan_by_number(
    project_id: uuid.UUID, number: int, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal
) -> api.ScanDetail:
    await load_project(s, project_id)
    scan = (
        await s.execute(select(ScanSession).where(ScanSession.project_id == project_id, ScanSession.sequence == number))
    ).scalar_one_or_none()
    if scan is None:
        raise NotFound("Scan not found")
    return await ser.scan_detail(ctx, s, scan)


@router.get("/projects/{project_id}/discovery", response_model=api.ScanDetail)
async def current_discovery(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> api.ScanDetail:
    await load_project(s, project_id)
    st = (
        await s.execute(
            select(WorkflowStage).where(
                WorkflowStage.project_id == project_id, WorkflowStage.stage_key == StageKey.discovery
            )
        )
    ).scalar_one_or_none()
    if st is None or st.current_stage_run_id is None:
        raise NotFound("Discovery has not started")
    scan = (
        await s.execute(select(ScanSession).where(ScanSession.stage_run_id == st.current_stage_run_id))
    ).scalar_one_or_none()
    if scan is None:
        raise NotFound("Discovery has not started")
    return await ser.scan_detail(ctx, s, scan)


@router.get("/scans/{scan_id}", response_model=api.ScanDetail)
async def get_scan(scan_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> api.ScanDetail:
    return await ser.scan_detail(ctx, s, await load_scan(s, scan_id))


@router.get("/scans/{scan_id}/pages", response_model=api.Page[api.PageSummary])
async def list_pages(
    scan_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    _p: CurrentPrincipal,
    page_type: str | None = None,
    q: str | None = Query(None, max_length=200),
    requires_auth: bool | None = None,
    status: str | None = None,
    limit: int | None = Query(None, ge=1, le=100),
    cursor: str | None = None,
) -> api.Page[api.PageSummary]:
    await load_scan(s, scan_id)
    lim, off = clamp_limit(limit, 50), decode_cursor(cursor)
    stmt = select(DiscoveredPage).where(DiscoveredPage.scan_session_id == scan_id)
    if page_type:
        stmt = stmt.where(DiscoveredPage.page_type == page_type)
    if requires_auth is not None:
        stmt = stmt.where(DiscoveredPage.requires_auth.is_(requires_auth))
    if status:
        stmt = stmt.where(DiscoveredPage.status == status)
    if q:
        like = q.lower()
        stmt = stmt.where(
            or_(func.lower(DiscoveredPage.url).contains(like), func.lower(DiscoveredPage.title).contains(like))
        )
    rows = list((await s.execute(stmt.order_by(DiscoveredPage.sequence).offset(off).limit(lim + 1))).scalars().all())
    evs = await ser.evidence_map(s, [r.screenshot_evidence_id for r in rows])
    return api.Page[api.PageSummary](
        items=[ser.page_summary(ctx, r, evs) for r in rows[:lim]],
        next_cursor=encode_cursor(off + lim) if len(rows) > lim else None,
    )


@router.get("/pages/{page_id}", response_model=api.PageDetail)
async def get_page(page_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> api.PageDetail:
    page = (await s.execute(select(DiscoveredPage).where(DiscoveredPage.id == page_id))).scalar_one_or_none()
    if page is None:
        raise NotFound("Page not found")
    return await ser.page_detail(ctx, s, page)


@router.get("/scans/{scan_id}/sitemap", response_model=api.SitemapNode)
async def sitemap(scan_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> api.SitemapNode:
    scan = await load_scan(s, scan_id)
    pages = list(
        (await s.execute(select(DiscoveredPage).where(DiscoveredPage.scan_session_id == scan_id))).scalars().all()
    )
    return ser.build_sitemap(
        pages,
        list((scan.frontier or {}).get("not_visited", [])),
        list(scan.external_links or []),
        scan.start_url,
        ser.not_visited_reason(scan),
    )


@router.get("/scans/{scan_id}/features", response_model=list[api.FeatureOut])
async def features(scan_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[api.FeatureOut]:
    await load_scan(s, scan_id)
    rows = (
        (
            await s.execute(
                select(ApplicationFeature)
                .where(ApplicationFeature.scan_session_id == scan_id)
                .order_by(ApplicationFeature.key)
            )
        )
        .scalars()
        .all()
    )
    return [ser.feature_out(f) for f in rows]


@router.get("/scans/{scan_id}/journeys", response_model=list[api.JourneyOut])
async def journeys(scan_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[api.JourneyOut]:
    await load_scan(s, scan_id)
    rows = (
        (await s.execute(select(UserJourney).where(UserJourney.scan_session_id == scan_id).order_by(UserJourney.key)))
        .scalars()
        .all()
    )
    return [ser.journey_out(j) for j in rows]


@router.get("/scans/{scan_id}/evidence", response_model=list[api.EvidenceLink])
async def scan_evidence(
    scan_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal, kind: str | None = None
) -> list[api.EvidenceLink]:
    await load_scan(s, scan_id)
    stmt = select(Evidence).where(Evidence.scan_session_id == scan_id)
    if kind:
        stmt = stmt.where(Evidence.kind == kind)
    rows = (await s.execute(stmt.order_by(Evidence.captured_at))).scalars().all()
    return [ser.evidence_link(ctx, e) for e in rows]


@router.get("/projects/{project_id}/knowledge", response_model=list[api.KnowledgeItemOut])
async def knowledge(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, kind: str | None = None, status: str | None = None
) -> list[api.KnowledgeItemOut]:
    await load_project(s, project_id)
    stmt = select(KnowledgeItem).where(KnowledgeItem.project_id == project_id)
    if kind:
        stmt = stmt.where(KnowledgeItem.kind == kind)
    if status:
        stmt = stmt.where(KnowledgeItem.status == status)
    rows = (await s.execute(stmt.order_by(KnowledgeItem.created_at.desc()))).scalars().all()
    return [
        api.KnowledgeItemOut(
            id=k.id,
            kind=k.kind.value,
            title=k.title,
            content=k.content,
            provenance=k.provenance.value,
            evidence_refs=[api.EvidenceRef.model_validate(r) for r in k.evidence_refs or []],
            source=k.source,
            status=k.status.value,
            version=k.version,
            created_at=k.created_at,
        )
        for k in rows
    ]


_ = StageRun
