"""ORM -> API DTO mapping. All numbers come from stored rows."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    DiscoveredPage,
    Evidence,
    GateDecision,
    Project,
    ProjectUrl,
    ScanSession,
    StageRun,
    User,
    UserJourney,
    WorkflowStage,
)
from app.domain.enums import GateStatus, PageStatus, ScanStatus, StageKey, StageStatus, UrlRole
from app.domain.stages import GATE_TITLES, LOCKED_GATES, STAGE_BY_KEY, STAGE_ORDER, merged_policy
from app.schemas import api


def user_ref(u: User | None) -> api.UserRef | None:
    return api.UserRef(id=u.id, email=u.email, full_name=u.full_name) if u else None


async def users_by_id(session: AsyncSession, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, User]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = (await session.execute(select(User).where(User.id.in_(wanted)))).scalars().all()
    return {u.id: u for u in rows}


def evidence_link(ctx: AppContext, ev: Evidence) -> api.EvidenceLink:
    return api.EvidenceLink(
        id=ev.id,
        key=ev.key,
        kind=ev.kind.value,
        mime=ev.mime,
        size=ev.size,
        captured_at=ev.captured_at,
        content_url=ctx.evidence_url(ev.id, ev.organisation_id),
        viewport=ev.viewport,
        source_url=ev.source_url,
        page_id=ev.page_id,
    )


async def evidence_map(session: AsyncSession, ids: Iterable[uuid.UUID | str | None]) -> dict[uuid.UUID, Evidence]:
    wanted = {uuid.UUID(str(i)) for i in ids if i}
    if not wanted:
        return {}
    rows = (await session.execute(select(Evidence).where(Evidence.id.in_(wanted)))).scalars().all()
    return {e.id: e for e in rows}


def path_of(url: str) -> str:
    p = urlsplit(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


# ---------------------------------------------------------------- pages


def page_summary(ctx: AppContext, p: DiscoveredPage, evs: dict[uuid.UUID, Evidence]) -> api.PageSummary:
    shot = evs.get(p.screenshot_evidence_id) if p.screenshot_evidence_id else None
    return api.PageSummary(
        id=p.id,
        url=p.url,
        title=p.title,
        http_status=p.http_status,
        depth=p.depth,
        page_type=p.page_type.value,
        requires_auth=p.requires_auth,
        counts={k: int(v) for k, v in (p.counts or {}).items()},
        screenshot=evidence_link(ctx, shot) if shot else None,
        path=path_of(p.url),
        status=p.status.value,
        failure_reason=p.failure_reason,
        found_via=p.found_via,
        parent_page_id=p.parent_page_id,
        load_ms=p.load_ms,
    )


def _refs(raw: list[Any] | None) -> list[api.EvidenceRef]:
    out = []
    for r in raw or []:
        try:
            out.append(api.EvidenceRef.model_validate(r))
        except ValueError:
            continue
    return out


async def page_detail(ctx: AppContext, session: AsyncSession, p: DiscoveredPage) -> api.PageDetail:
    evs_rows = (
        (await session.execute(select(Evidence).where(Evidence.page_id == p.id).order_by(Evidence.captured_at)))
        .scalars()
        .all()
    )
    evs = {e.id: e for e in evs_rows}
    base = page_summary(ctx, p, evs)
    responsive = {}
    for vp, r in (p.responsive or {}).items():
        sid = r.get("screenshot_evidence_id")
        ev = evs.get(uuid.UUID(sid)) if sid else None
        responsive[vp] = api.ResponsiveViewport(
            viewport=r.get("viewport", vp),
            nav_collapsed=bool(r.get("nav_collapsed")),
            horizontal_overflow=bool(r.get("horizontal_overflow")),
            screenshot=evidence_link(ctx, ev) if ev else None,
        )
    return api.PageDetail(
        **base.model_dump(),
        headings=list(p.headings or []),
        nav_links=[api.NavLinkOut.model_validate(n) for n in (p.nav_links or [])],
        forms=[form_out(f) for f in (p.forms or [])],
        components=[component_out(c) for c in (p.components or [])],
        responsive=responsive,
        console_issues=[api.ConsoleIssue.model_validate(c) for c in (p.console_issues or [])],
        network_issues=[api.NetworkIssue.model_validate(n) for n in (p.network_issues or [])],
        evidence=[evidence_link(ctx, e) for e in evs_rows],
        links=list(p.links or []),
        scan_id=p.scan_session_id,
    )


def form_out(f: dict[str, Any]) -> api.FormOut:
    return api.FormOut(
        name=f.get("name"),
        method=f.get("method", "GET"),
        action=f.get("action", ""),
        purpose_guess=f.get("purpose_guess", "other"),
        submit_label=f.get("submit_label"),
        fields=[
            api.FormFieldOut(
                name=x.get("name", ""),
                type=x.get("type", "text"),
                label=x.get("label", ""),
                required=bool(x.get("required")),
                placeholder=x.get("placeholder"),
                constraints=api.FieldConstraintsOut.model_validate(x.get("constraints") or {}),
                options=x.get("options"),
                locator=x.get("locator", ""),
            )
            for x in f.get("fields", [])
        ],
        locator=f.get("locator", ""),
        evidence_refs=_refs(f.get("evidence_refs")),
    )


def component_out(c: dict[str, Any]) -> api.ComponentOut:
    return api.ComponentOut(
        kind=c["kind"],
        role=c.get("role"),
        name=c.get("name", ""),
        locator=c.get("locator", ""),
        fingerprint=c.get("fingerprint", ""),
        details=c.get("details", {}),
        locators=c.get("locators", []),
        evidence_refs=_refs(c.get("evidence_refs")),
    )


def feature_out(f: ApplicationFeature) -> api.FeatureOut:
    return api.FeatureOut(
        id=f.id,
        key=f.key,
        name=f.name,
        description=f.description,
        category=f.category.value,
        page_ids=[uuid.UUID(str(p)) for p in f.page_ids or []],
        provenance=f.provenance.value,
        confidence=f.confidence,
        evidence_refs=_refs(f.evidence_refs),
        generated_by=f.generated_by.value if f.generated_by.value != "mixed" else "ai",
        reason=f.reason,
    )


def journey_out(j: UserJourney) -> api.JourneyOut:
    return api.JourneyOut(
        id=j.id,
        key=j.key,
        name=j.name,
        steps=[api.JourneyStepOut.model_validate(s) for s in j.steps or []],
        provenance=j.provenance.value,
        confidence=j.confidence,
        evidence_refs=_refs(j.evidence_refs),
        generated_by=j.generated_by.value if j.generated_by.value != "mixed" else "ai",
        reason=j.reason,
    )


# ---------------------------------------------------------------- scans


async def latest_scan_id(session: AsyncSession, project_id: uuid.UUID) -> uuid.UUID | None:
    return (
        await session.execute(
            select(ScanSession.id)
            .where(ScanSession.project_id == project_id)
            .order_by(ScanSession.sequence.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def scan_summary(session: AsyncSession, s: ScanSession, latest_id: uuid.UUID | None = None) -> api.ScanSummary:
    version = (
        await session.execute(select(StageRun.version).where(StageRun.id == s.stage_run_id))
    ).scalar_one_or_none()
    return api.ScanSummary(
        id=s.id,
        key=s.key,
        status=s.status.value,
        start_url=s.start_url,
        pages_found=int((s.stats or {}).get("pages", 0)),
        started_at=s.started_at,
        finished_at=s.finished_at,
        number=s.sequence,
        stage_run_version=version,
        created_at=s.created_at,
        is_latest=latest_id is None or latest_id == s.id,
    )


async def scan_detail(ctx: AppContext, session: AsyncSession, s: ScanSession) -> api.ScanDetail:
    latest = await latest_scan_id(session, s.project_id)
    summary = await scan_summary(session, s, latest)
    current = None
    if s.current and s.status in ("running", "queued", "paused"):
        sid = s.current.get("screenshot_evidence_id")
        evs = await evidence_map(session, [sid])
        ev = evs.get(uuid.UUID(sid)) if sid else None
        current = api.CurrentPage(
            url=s.current.get("url", ""),
            title=s.current.get("title", ""),
            screenshot=evidence_link(ctx, ev) if ev else None,
        )
    queue_position = None
    if s.status == "queued":
        queue_position = await _queue_position(session, s)
    stage_run = (await session.execute(select(StageRun).where(StageRun.id == s.stage_run_id))).scalar_one_or_none()
    gate = None
    if stage_run is not None:
        stage = (
            await session.execute(select(WorkflowStage).where(WorkflowStage.id == stage_run.workflow_stage_id))
        ).scalar_one()
        project = (await session.execute(select(Project).where(Project.id == s.project_id))).scalar_one()
        gate = await gate_state_for_run(session, project, stage, stage_run)
    limits = {k: v for k, v in (s.limits or {}).items() if k in api.ScanSettings.model_fields}
    stats = {k: v for k, v in (s.stats or {}).items() if k in api.ScanStats.model_fields}
    return api.ScanDetail(
        **summary.model_dump(),
        limits=api.ScanSettings.model_validate(limits),
        stats=api.ScanStats.model_validate(stats),
        completeness=api.CompletenessOut.model_validate(s.completeness) if s.completeness else None,
        auth_boundaries=[api.AuthBoundary.model_validate(b) for b in s.auth_boundaries or []],
        access_gaps=[api.AccessGap.model_validate(g) for g in s.access_gaps or []],
        limitations=list(s.limitations or []),
        blocked_requests=[api.BlockedRequest.model_validate(b) for b in s.blocked_requests or []],
        current=current,
        error=s.error,
        summary=s.summary,
        summary_generated_by=s.summary_generated_by.value if s.summary_generated_by else None,
        skipped_links=list(s.skipped_links or []),
        external_links=list(s.external_links or []),
        not_visited=list((s.frontier or {}).get("not_visited", [])),
        stop_reason=(s.frontier or {}).get("stop_reason"),
        partial=scan_is_partial(s),
        injection_flags=[api.InjectionFlag.model_validate(f) for f in s.injection_flags or []],
        robots=s.robots,
        queue_position=queue_position,
        gate=gate,
        project_id=s.project_id,
    )


async def _queue_position(session: AsyncSession, s: ScanSession) -> int:
    ahead = (
        await session.execute(
            select(func.count())
            .select_from(ScanSession)
            .where(
                # Position in this organisation's queue: the scan limit is per organisation (T10: never count others).
                ScanSession.organisation_id == s.organisation_id,
                ScanSession.status == "queued",
                ScanSession.created_at < s.created_at,
            )
        )
    ).scalar_one()
    return int(ahead) + 1


NOT_VISITED_REASON = {
    "page_limit": "page limit",
    "cancelled": "discovery cancelled",
    "timeout": "time limit",
    "paused": "discovery paused",
    "failed": "discovery stopped early",
}


def scan_is_partial(scan: ScanSession) -> bool | None:
    """One rule for the API and the report: a finished scan is partial when it was cancelled, stopped early (time
    limit, error) or reached the page limit with links left unvisited. None while the scan has not finished."""
    if scan.status in (ScanStatus.queued, ScanStatus.running, ScanStatus.paused):
        return None
    if scan.status in (ScanStatus.cancelled, ScanStatus.partial, ScanStatus.failed):
        return True
    frontier = scan.frontier or {}
    reason = frontier.get("stop_reason")
    if reason is not None:
        return bool(reason in ("page_limit", "cancelled", "timeout", "failed"))
    return bool(frontier.get("not_visited"))  # scans recorded before stop_reason existed


def not_visited_reason(scan: ScanSession) -> str:
    """Why the scan's leftover links were not visited (older scans without a recorded reason: page limit)."""
    return NOT_VISITED_REASON.get(str((scan.frontier or {}).get("stop_reason") or "page_limit"), "not visited")


def build_sitemap(
    pages: list[DiscoveredPage],
    not_visited: list[str],
    external: list[str],
    root_url: str,
    not_visited_label: str = "page limit",
) -> api.SitemapNode:
    """Tree by URL path; each discovered page is placed at its path. Not-visited links appear under their path."""
    root = api.SitemapNode(path="/", url=None, status="group")
    index: dict[str, api.SitemapNode] = {"/": root}

    def ensure(path: str) -> api.SitemapNode:
        if path in index:
            return index[path]
        parent_path = path.rsplit("/", 1)[0] or "/"
        parent = ensure(parent_path)
        node = api.SitemapNode(path=path, status="group")
        parent.children.append(node)
        index[path] = node
        return node

    def key_for(url: str) -> str:
        p = urlsplit(url)
        path = (p.path or "/").rstrip("/") or "/"
        return path + (f"?{p.query}" if p.query else "")

    for page in sorted(pages, key=lambda x: (x.depth, x.sequence)):
        k = key_for(page.url)
        if "?" in k:
            node = api.SitemapNode(path=k, status="group")
            ensure(k.split("?")[0]).children.append(node)
            index[k] = node
        node = ensure(k)
        node.url = page.url
        node.title = page.title
        node.page_id = page.id
        node.status = page.status.value
        node.page_type = page.page_type.value
        node.requires_auth = page.requires_auth
        node.reason = page.failure_reason
        node.counts = {k2: int(v) for k2, v in (page.counts or {}).items() if v}
    for url in not_visited[:300]:
        k = key_for(url)
        if k in index and index[k].page_id:
            continue
        node = ensure(k)
        if node.status == "group":
            node.status = "not_visited"
            node.url = url
            node.reason = not_visited_label
    root_page = index.get("/")
    if external:
        ext = api.SitemapNode(
            path="(external)",
            status="external",
            title=f"External links ({len(external)})",
            reason="listed, not visited",
        )
        ext.children = [api.SitemapNode(path=u, url=u, status="external") for u in external[:100]]
        (root_page or root).children.append(ext)
    _ = root_url
    return root


# ---------------------------------------------------------------- projects + workflow


def primary_url(urls: list[ProjectUrl]) -> ProjectUrl | None:
    return next((u for u in urls if u.role == UrlRole.primary), urls[0] if urls else None)


async def gate_state_for_run(
    session: AsyncSession, project: Project, stage: WorkflowStage, run: StageRun | None
) -> api.GateState | None:
    if stage.gate_key is None:
        return None
    policy = merged_policy(project.approval_policy)[stage.gate_key]
    rec = None
    decision = None
    if run is not None:
        rec_raw = (run.output or {}).get("recommendation")
        if rec_raw:
            rec = api.GateRecommendation.model_validate(rec_raw)
        d = (
            await session.execute(
                select(GateDecision)
                .where(GateDecision.stage_run_id == run.id)
                .order_by(GateDecision.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if d is not None:
            users = await users_by_id(session, [d.decided_by])
            decision = decision_out(d, users, run.version)
    status = stage.gate_status.value
    if run is not None and stage.current_stage_run_id != run.id:
        status = "approved" if decision and decision.decision == "approve" else "rejected" if decision else "none"
    return api.GateState(
        key=stage.gate_key.value,
        policy=policy.value,
        status=status,
        recommendation=rec,
        title=GATE_TITLES[stage.gate_key],
        decision=decision,
    )


def decision_out(d: GateDecision, users: dict[uuid.UUID, User], version: int | None) -> api.GateDecisionOut:
    return api.GateDecisionOut(
        id=d.id,
        gate_key=d.gate_key.value,
        decision=d.decision.value,
        comment=d.comment,
        decided_by=user_ref(users.get(d.decided_by)) if d.decided_by else None,
        created_at=d.created_at,
        decided_at=d.created_at,
        gate=d.gate_key.value,
        stage_run_version=version,
        agent_recommendation=d.agent_recommendation,
    )


async def stage_states(session: AsyncSession, project: Project) -> list[api.StageState]:
    stages = (
        (await session.execute(select(WorkflowStage).where(WorkflowStage.project_id == project.id))).scalars().all()
    )
    run_ids = [s.current_stage_run_id for s in stages if s.current_stage_run_id]
    runs = (
        {r.id: r for r in (await session.execute(select(StageRun).where(StageRun.id.in_(run_ids)))).scalars().all()}
        if run_ids
        else {}
    )
    out: list[api.StageState] = []
    for st in sorted(stages, key=lambda x: STAGE_ORDER[x.stage_key]):
        d = STAGE_BY_KEY[st.stage_key]
        run = runs.get(st.current_stage_run_id) if st.current_stage_run_id else None
        progress = None
        if st.stage_key == StageKey.discovery and run is not None:
            scan = (
                await session.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))
            ).scalar_one_or_none()
            if scan is not None:
                stats = scan.stats or {}
                progress = api.StageProgress(
                    done=int(stats.get("pages", 0)),
                    total=int((scan.limits or {}).get("max_pages", 0)) or None,
                    label="pages",
                    screenshots=int(stats.get("screenshots", 0)),
                    queued=int(stats.get("queued", 0)),
                    queue_position=await _queue_position(session, scan) if scan.status == ScanStatus.queued else None,
                )
        out.append(
            api.StageState(
                key=st.stage_key.value,
                title=d.title,
                phase=d.phase,
                available=d.available,
                status=st.status.value,
                current_version=run.version if run else None,
                gate=await gate_state_for_run(session, project, st, run),
                started_at=run.started_at if run else None,
                finished_at=run.finished_at if run else None,
                stale_reason=st.stale_reason,
                progress=progress,
                partial=run.partial if run else False,
                error=run.error if run else None,
            )
        )
    return out


_PRIORITY = [
    StageStatus.failed,
    StageStatus.awaiting_approval,
    StageStatus.paused,
    StageStatus.running,
    StageStatus.queued,
]


async def project_summary(session: AsyncSession, project: Project) -> api.ProjectSummary:
    urls = list((await session.execute(select(ProjectUrl).where(ProjectUrl.project_id == project.id))).scalars().all())
    stages = list(
        (await session.execute(select(WorkflowStage).where(WorkflowStage.project_id == project.id))).scalars().all()
    )
    available = [s for s in stages if STAGE_BY_KEY[s.stage_key].available]
    current = None
    for status in _PRIORITY:
        current = next(
            (s for s in sorted(available, key=lambda x: STAGE_ORDER[x.stage_key]) if s.status == status), None
        )
        if current:
            break
    if current is None:
        done = [s for s in available if s.status != StageStatus.not_started]
        current = max(done, key=lambda x: STAGE_ORDER[x.stage_key]) if done else None
    awaiting = any(
        s.status == StageStatus.awaiting_approval or s.gate_status in (GateStatus.pending, GateStatus.recommended)
        for s in stages
        if s.gate_key is not None and s.status not in (StageStatus.queued, StageStatus.running)
    )
    scan = (
        await session.execute(
            select(ScanSession)
            .where(ScanSession.project_id == project.id)
            .order_by(ScanSession.sequence.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    scans = int(
        (
            await session.execute(
                select(func.count()).select_from(ScanSession).where(ScanSession.project_id == project.id)
            )
        ).scalar_one()
    )
    activity = None
    if scan is not None and scan.status == "running" and scan.current:
        activity = f"Visiting {path_of(scan.current.get('url', '/'))}"
    pu = primary_url(urls)
    return api.ProjectSummary(
        id=project.id,
        name=project.name,
        primary_url=pu.url if pu else "",
        status=project.status.value,
        current_stage=current.stage_key.value if current else None,
        current_stage_status=current.status.value if current else None,
        pages_discovered=int((scan.stats or {}).get("pages", 0)) if scan else 0,
        awaiting_approval=awaiting,
        updated_at=project.updated_at,
        access_gaps=len(scan.access_gaps or []) if scan else 0,
        scans=scans,
        current_activity=activity,
    )


async def project_detail(session: AsyncSession, project: Project) -> api.ProjectDetail:
    summary = await project_summary(session, project)
    urls = list((await session.execute(select(ProjectUrl).where(ProjectUrl.project_id == project.id))).scalars().all())
    users = await users_by_id(session, [project.created_by, *(u.authorised_by for u in urls)])
    policy = merged_policy(project.approval_policy)
    settings = {k: v for k, v in (project.settings or {}).items() if k in api.ScanSettings.model_fields}
    return api.ProjectDetail(
        **summary.model_dump(),
        description=project.description,
        version=project.version,
        urls=[
            api.ProjectUrlOut(
                id=u.id,
                url=u.url,
                role=u.role.value,
                allowed_hosts=list(u.allowed_hosts or []),
                authorisation_status=u.authorisation_status.value,
                authorised_by=user_ref(users.get(u.authorised_by)) if u.authorised_by else None,
                authorised_at=u.authorised_at,
                last_check=api.UrlCheckResult.model_validate(u.last_check) if u.last_check else None,
                authorisation_statement=u.authorisation_statement,
                has_credentials=u.credentials_secret_id is not None,
                login_url=(project.settings or {}).get("login_url"),
            )
            for u in urls
        ],
        approval_policy={k.value: v.value for k, v in policy.items()},
        locked_gates=[g.value for g in LOCKED_GATES],
        settings=api.ScanSettings.model_validate(settings),
        created_at=project.created_at,
        created_by=user_ref(users.get(project.created_by))
        or api.UserRef(id=project.created_by, email="", full_name=""),
    )


def page_is_visited(p: DiscoveredPage) -> bool:
    return p.status == PageStatus.visited
