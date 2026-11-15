"""Rescans and change sets (P6-01, decisions D25, D26, D27).

A rescan is an ordinary discovery run started as `parameters.rescan` (same read-only rules, limits and G1 attestation),
compared with the last G2-approved scan unless the person chose another (D25). When it finishes, the
`change_analysis` stage (`ChangeAnalysisAgent`) writes CHG-n through `compute`. A person can also compare any two
finished scans (`POST /projects/{id}/changes`): that set has no stage run and is computed by the `change_compare` job.
Nothing from either scan is copied, changed or deleted; items only point at the pages and evidence of both scans.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, NotFound, ValidationFailed
from app.context import AppContext
from app.db.models import (
    AutomationAsset,
    AutomationScript,
    ChangeItem,
    ChangeSet,
    DiscoveredPage,
    Evidence,
    GateDecision,
    Project,
    ProjectUrl,
    Requirement,
    ScanSession,
    StageRun,
    User,
    UserJourney,
)
from app.db.tenant import TenantScope, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.change import diff as d
from app.domain.enums import (
    AuthorisationStatus,
    ChangeKind,
    ChangeSetStatus,
    ChangeSignificance,
    EvidenceKind,
    GateDecisionKind,
    GateKey,
    GeneratedBy,
    StageKey,
    UrlRole,
)
from app.llm.base import UntrustedBlock
from app.security.ssrf import normalise_url
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.counters import next_key
from app.services.serialize import evidence_link, evidence_map

log = logging.getLogger(__name__)

G1_CHANGED = "The URL or allowed hosts changed: authorise them again (Gate 1)"
NO_BASELINE = (
    "Changes are compared with the scan approved at Gate 2. Approve Gate 2 first, or choose the scan to compare with."
)
NOT_COMPARABLE = "Choose a scan that finished (completed, or stopped early)"
LATER_SCAN = "Choose a later scan in To."
AGENT = "change"
# Display groups (design P6 §3.1).
DISPLAY_KIND: dict[ChangeKind, str] = {
    ChangeKind.page_added: "added",
    ChangeKind.element_added: "added",
    ChangeKind.form_added: "added",
    ChangeKind.field_added: "added",
    ChangeKind.journey_added: "added",
    ChangeKind.page_removed: "removed",
    ChangeKind.element_removed: "removed",
    ChangeKind.form_removed: "removed",
    ChangeKind.field_removed: "removed",
    ChangeKind.journey_removed: "removed",
    ChangeKind.element_renamed: "renamed",
    ChangeKind.element_moved: "moved",
    ChangeKind.requirement_changed: "requirement_changed",
}


# ---------------------------------------------------------------- rescans


async def primary_url(s: AsyncSession, project_id: uuid.UUID) -> ProjectUrl:
    url = (
        await s.execute(
            select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
        )
    ).scalar_one_or_none()
    if url is None:
        raise Conflict("Project has no target URL")
    return url


async def check_g1(s: AsyncSession, project: Project) -> None:
    """A rescan needs the URL and allowed hosts exactly as they were authorised at G1 (roadmap Phase 6 rule 1)."""
    url = await primary_url(s, project.id)
    intake = (
        await s.execute(
            select(StageRun)
            .where(StageRun.project_id == project.id, StageRun.stage_key == StageKey.intake)
            .order_by(StageRun.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    approved = (
        await s.execute(
            select(GateDecision.id).where(
                GateDecision.project_id == project.id,
                GateDecision.gate_key == GateKey.G1,
                GateDecision.decision == GateDecisionKind.approve,
            )
        )
    ).first()
    check = ((intake.output or {}) if intake else {}).get("url_check") or {}
    url_then = check.get("normalised_url")
    hosts_then = {normalise_url(str(check.get("final_url") or url_then)).host} if url_then else set()
    if (
        approved is None
        or url.authorisation_status != AuthorisationStatus.attested
        or url.url != url_then
        or set(url.allowed_hosts or []) != hosts_then
    ):
        raise Conflict(G1_CHANGED, details=[{"field": "url", "message": G1_CHANGED}])


async def g2_scan_ids(s: AsyncSession, project_id: uuid.UUID) -> list[uuid.UUID]:
    """Scans approved at G2, the most recent approval first (D25: the first is the rescan baseline)."""
    rows = (
        await s.execute(
            select(ScanSession.id)
            .join(GateDecision, GateDecision.stage_run_id == ScanSession.stage_run_id)
            .where(
                ScanSession.project_id == project_id,
                GateDecision.gate_key == GateKey.G2,
                GateDecision.decision == GateDecisionKind.approve,
            )
            .order_by(GateDecision.created_at.desc())
        )
    ).all()
    return list(dict.fromkeys(r[0] for r in rows))


async def scan_in_project(s: AsyncSession, project_id: uuid.UUID, scan_id: uuid.UUID, field: str) -> ScanSession:
    scan = (
        await s.execute(select(ScanSession).where(ScanSession.id == scan_id, ScanSession.project_id == project_id))
    ).scalar_one_or_none()
    if scan is None:
        raise NotFound("Scan not found")
    if scan.status.value not in d.COMPARABLE_SCAN_STATUSES:
        raise ValidationFailed(NOT_COMPARABLE, details=[{"field": field, "message": NOT_COMPARABLE}])
    return scan


async def rescan_baseline(s: AsyncSession, project_id: uuid.UUID, compare_with: uuid.UUID | None) -> ScanSession:
    if compare_with is not None:
        return await scan_in_project(s, project_id, compare_with, "compare_with")
    for sid in await g2_scan_ids(s, project_id):
        scan = (await s.execute(select(ScanSession).where(ScanSession.id == sid))).scalar_one()
        if scan.status.value in d.COMPARABLE_SCAN_STATUSES:
            return scan
    raise Conflict(NO_BASELINE, details=[{"field": "compare_with", "message": NO_BASELINE}])


def rescan_limits(base: ScanSession, given: dict[str, Any] | None) -> dict[str, Any]:
    """The baseline's limits unless the person gave others (validated by `ScanSettings` and the org cap first)."""
    keep = ("max_pages", "max_depth", "include_mobile", "respect_robots", "use_credentials")
    return {**{k: v for k, v in (base.limits or {}).items() if k in keep}, **(given or {})}


# ---------------------------------------------------------------- change sets


async def create_set(
    s: AsyncSession,
    project: Project,
    base: ScanSession,
    target: ScanSession,
    *,
    stage_run_id: uuid.UUID | None = None,
    requested_by: uuid.UUID | None = None,
) -> ChangeSet:
    _, key = await next_key(s, project.organisation_id, project.id, "change_set")
    cs = ChangeSet(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        stage_run_id=stage_run_id,
        base_scan_session_id=base.id,
        target_scan_session_id=target.id,
        status=ChangeSetStatus.queued,
        summary={"requested_by": str(requested_by)} if requested_by else {},
        generated_by=GeneratedBy.rules,
    )
    s.add(cs)
    await s.flush()
    return cs


async def existing_set(
    s: AsyncSession, project_id: uuid.UUID, base_id: uuid.UUID, target_id: uuid.UUID
) -> ChangeSet | None:
    """The pair's set, unless it failed (a failed comparison can be tried again)."""
    return (
        await s.execute(
            select(ChangeSet)
            .where(
                ChangeSet.project_id == project_id,
                ChangeSet.base_scan_session_id == base_id,
                ChangeSet.target_scan_session_id == target_id,
                ChangeSet.status != ChangeSetStatus.failed,
            )
            .order_by(ChangeSet.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def snapshot(s: AsyncSession, scan: ScanSession) -> d.ScanSnap:
    pages = list((await s.execute(select(DiscoveredPage).where(DiscoveredPage.scan_session_id == scan.id))).scalars())
    dom: dict[uuid.UUID, uuid.UUID] = {}
    for ev_id, page_id in (
        await s.execute(
            select(Evidence.id, Evidence.page_id).where(
                Evidence.scan_session_id == scan.id, Evidence.kind == EvidenceKind.dom_snapshot
            )
        )
    ).all():
        if page_id is not None:
            dom.setdefault(page_id, ev_id)
    snaps = [
        d.PageSnap(
            id=str(p.id),
            url=p.url,
            url_hash=p.url_hash,
            auth_context=p.auth_context.value,
            status=p.status.value,
            http_status=p.http_status,
            title=p.title or "",
            headings=[str(h) for h in p.headings or []],
            nav_links=list(p.nav_links or []),
            links=[str(x) for x in p.links or []],
            forms=list(p.forms or []),
            components=list(p.components or []),
            screenshot_evidence_id=str(p.screenshot_evidence_id) if p.screenshot_evidence_id else None,
            dom_evidence_id=str(dom[p.id]) if p.id in dom else None,
        )
        for p in sorted(pages, key=lambda x: x.sequence)
    ]
    url_of = {p.id: p.url for p in pages}
    journeys = [
        d.JourneySnap(
            name=j.name,
            steps=[
                d.JourneyStepSnap(
                    url=url_of.get(uuid.UUID(str(st["page_id"]))) if st.get("page_id") else None,
                    action=str(st.get("action") or ""),
                    label=str(st.get("label") or "observed"),
                )
                for st in j.steps or []
            ],
        )
        for j in (await s.execute(select(UserJourney).where(UserJourney.scan_session_id == scan.id))).scalars()
    ]
    return d.ScanSnap(number=scan.sequence, status=scan.status.value, pages=snaps, journeys=journeys)


_CSS_LOCATOR = re.compile(r"""locator\(\s*(["'`])(.+?)\1\s*\)""")


async def used_selectors(s: AsyncSession, project_id: uuid.UUID) -> set[str]:
    """CSS selectors the current scripts and page objects use: an element that moves away from one isn't cosmetic."""
    from app.services import automation as asvc

    bundle = await asvc.current_run(s, project_id, StageKey.automation)
    if bundle is None:
        return set()
    codes = [
        r[0] for r in (await s.execute(select(AutomationAsset.code).where(AutomationAsset.stage_run_id == bundle.id)))
    ]
    codes += [
        r[0] for r in (await s.execute(select(AutomationScript.code).where(AutomationScript.stage_run_id == bundle.id)))
    ]
    return {m.group(2) for code in codes for m in _CSS_LOCATOR.finditer(code or "")}


# ---------------------------------------------------------------- AI summary (labelled; counts are placeholders)


class AiChangeSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: str = Field(min_length=10, max_length=700)


PLACEHOLDERS = ("total", "structural", "behavioural", "cosmetic", "pages_added", "pages_removed")
_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


def fill_summary(text: str, summary: dict[str, Any]) -> str | None:
    """Every number comes from the change set: the model writes `{total}` etc. and may not write digits itself."""
    if re.search(r"\d", _PLACEHOLDER.sub("", text)) or set(_PLACEHOLDER.findall(text)) - set(PLACEHOLDERS):
        return None
    sig = summary.get("by_significance") or {}
    pages = summary.get("pages") or {}
    values = {
        "total": summary.get("total", 0),
        "structural": sig.get("structural", 0),
        "behavioural": sig.get("behavioural", 0),
        "cosmetic": sig.get("cosmetic", 0),
        "pages_added": pages.get("added", 0),
        "pages_removed": pages.get("removed", 0),
    }
    return _PLACEHOLDER.sub(lambda m: str(values[m.group(1)]), text).strip()


async def ai_summary(ctx: AppContext, items: list[d.Change], summary: dict[str, Any]) -> tuple[str | None, Any]:
    if not ctx.llm.enabled or not items:
        return None, None
    listing = "\n".join(f"- [{i.significance.value}] {d.describe(i)}" for i in items[:80])
    task = (
        "Summarise, in two or three plain sentences for a reader with no QA background, what changed on the website "
        "between two scans. Use only the changes listed in the website data. Never write a number: write the "
        "placeholders " + ", ".join("{" + p + "}" for p in PLACEHOLDERS) + " where a count belongs. Do not add, "
        "remove or reclassify changes, and do not give advice."
    )
    res = await ctx.llm.structured(AiChangeSummary, task, [UntrustedBlock("change list", listing, 6000)])
    usage = res.usage.as_dict() if res.usage else None
    if not res.ok or res.value is None:
        return None, usage
    return fill_summary(res.value.summary, summary), usage


# ---------------------------------------------------------------- computing a set


async def compute(ctx: AppContext, scope: TenantScope, change_set_id: uuid.UUID) -> ChangeSet:
    """Diffs the set's two scans and writes its items (a retried job starts the items again)."""
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()
        project = (await s.execute(select(Project).where(Project.id == cs.project_id))).scalar_one()
        cs.status = ChangeSetStatus.running
        cs.error = None
        await s.commit()
        key = cs.key
    await _emit(ctx, project, "change.status", f"{key}: comparing scans", {"kind": "status", "change_set_key": key,
                                                                            "status": "running"})  # fmt: skip
    try:
        async with ctx.session_factory() as s:
            bind_scope(s, scope)
            cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()
            base = (await s.execute(select(ScanSession).where(ScanSession.id == cs.base_scan_session_id))).scalar_one()
            target = (
                await s.execute(select(ScanSession).where(ScanSession.id == cs.target_scan_session_id))
            ).scalar_one()
            result = d.diff_scans(
                await snapshot(s, base), await snapshot(s, target), used_selectors=await used_selectors(s, project.id)
            )
            await s.execute(delete(ChangeItem).where(ChangeItem.change_set_id == cs.id))
            for i in result.items:
                s.add(_item_row(cs, i))
            text, usage = await ai_summary(ctx, result.items, result.summary)
            summary = {**result.summary, **({"llm": usage} if usage else {})}
            if (cs.summary or {}).get("requested_by"):
                summary["requested_by"] = cs.summary["requested_by"]
            cs.summary = summary
            cs.rebaseline_suggested = result.rebaseline_suggested
            cs.ai_summary = text
            cs.status = ChangeSetStatus.completed
            cs.finished_at = utcnow()
            audit(
                s,
                org_id=project.organisation_id,
                action="change_set.created",
                target_type="change_set",
                target_id=cs.id,
                actor_user_id=uuid.UUID(summary["requested_by"]) if summary.get("requested_by") else None,
                project_id=project.id,
                metadata={
                    "key": cs.key,
                    "base_scan": base.key,
                    "target_scan": target.key,
                    "total": result.summary["total"],
                    "rebaseline_suggested": result.rebaseline_suggested,
                },
            )
            await s.commit()
            counts = {"total": result.summary["total"], **result.summary["by_significance"]}
            message = (
                f"{cs.key} ready: {counts['total']} change{'s' if counts['total'] != 1 else ''} between "
                f"Scan {base.sequence} and Scan {target.sequence} ({counts['structural']} structural, "
                f"{counts['behavioural']} behavioural, {counts['cosmetic']} cosmetic)"
            )
    except Exception as exc:
        reason = str(exc).splitlines()[0][:300] if str(exc) else type(exc).__name__
        async with ctx.session_factory() as s:
            bind_scope(s, scope)
            cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()
            cs.status, cs.error, cs.finished_at = ChangeSetStatus.failed, reason, utcnow()
            await s.commit()
        await _emit(ctx, project, "change.status", f"{key} didn't complete: {reason}",
                    {"kind": "error", "change_set_key": key, "status": "failed"})  # fmt: skip
        raise
    await _emit(ctx, project, "change.status", f"{key}: compared", {"kind": "status", "change_set_key": key,
                                                                    "status": "completed"})  # fmt: skip
    await _emit(ctx, project, "change.ready", message, {"kind": "result", "change_set_key": key, **counts})
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        return (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()


def _item_row(cs: ChangeSet, i: d.Change) -> ChangeItem:
    return ChangeItem(
        organisation_id=cs.organisation_id,
        project_id=cs.project_id,
        change_set_id=cs.id,
        kind=i.kind,
        significance=i.significance,
        page_url=i.page_url,
        before=i.before,
        after=i.after,
        before_ref=i.before_ref,
        after_ref=i.after_ref,
    )


async def _emit(ctx: AppContext, project: Project, type_: str, message: str, data: dict[str, Any]) -> None:
    """Events carry keys and counts only (never page text): `change.status`, `change.ready`."""
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type=type_,
        message=message,
        stage_key=StageKey.change_analysis.value,
        agent_key=AGENT,
        data=data,
    )


async def compare_job(ctx: AppContext, scope: TenantScope, change_set_id: uuid.UUID) -> None:
    """Job `change_compare`: a comparison a person asked for. A failure is recorded on the set, not retried."""
    try:
        await compute(ctx, scope, change_set_id)
    except Exception:
        log.exception("change set %s failed", change_set_id)


async def compare_interrupted(ctx: AppContext, job: Any) -> None:
    """The reaper gave up on a `change_compare` job: the set says it didn't complete; both scans are untouched."""
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(job.organisation_id))
        cs = (
            await s.execute(select(ChangeSet).where(ChangeSet.id == uuid.UUID(job.payload["change_set_id"])))
        ).scalar_one_or_none()
        if cs is not None and cs.status in (ChangeSetStatus.queued, ChangeSetStatus.running):
            cs.status, cs.error, cs.finished_at = ChangeSetStatus.failed, "interrupted", utcnow()
            await s.commit()


async def stage_set_interrupted(ctx: AppContext, scope: TenantScope, stage_run_id: uuid.UUID) -> None:
    """The reaper gave up on a `change_analysis` task: its set is `failed`, so comparing the pair again starts anew."""
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.stage_run_id == stage_run_id))).scalar_one_or_none()
        if cs is None or cs.status not in (ChangeSetStatus.queued, ChangeSetStatus.running):
            return
        cs.status, cs.error, cs.finished_at = ChangeSetStatus.failed, "interrupted", utcnow()
        project = (await s.execute(select(Project).where(Project.id == cs.project_id))).scalar_one()
        key = cs.key
        await s.commit()
    await _emit(ctx, project, "change.status", f"{key} didn't complete: interrupted",
                {"kind": "error", "change_set_key": key, "status": "failed"})  # fmt: skip


# ---------------------------------------------------------------- requirements regenerated after a rescan


async def append_requirement_changes(s: AsyncSession, project: Project, run: StageRun, diff: dict[str, Any]) -> int:
    """When a requirements candidate created after a rescan is applied (P2-00), its changed lineages become
    `requirement_changed` items of the latest change set whose target scan is older than the candidate."""
    cs = (
        await s.execute(
            select(ChangeSet)
            .join(ScanSession, ScanSession.id == ChangeSet.target_scan_session_id)
            .where(
                ChangeSet.project_id == project.id,
                ChangeSet.status == ChangeSetStatus.completed,
                ScanSession.created_at <= run.created_at,
            )
            .order_by(ScanSession.sequence.desc(), ChangeSet.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if cs is None:
        return 0
    titles = {
        r.key: r.title
        for r in (await s.execute(select(Requirement).where(Requirement.stage_run_id == run.id))).scalars()
    }
    new = d.requirement_changes(diff, titles)
    for i in new:
        s.add(_item_row(cs, i))
    if new:
        await s.flush()
        rows = list((await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars())
        counts = d.summarise(
            d.Change(r.kind, r.significance, r.page_url, r.before, r.after, r.before_ref, r.after_ref) for r in rows
        )
        cs.summary = {**(cs.summary or {}), **counts}
    return len(new)


# ---------------------------------------------------------------- reading


def scan_ref(scan: ScanSession, g2_ids: list[uuid.UUID]) -> dict[str, Any]:
    return {
        "id": str(scan.id),
        "key": scan.key,
        "number": scan.sequence,
        "status": scan.status.value,
        "partial": scan.status.value == "partial",
        "is_rescan": scan.is_rescan,
        "pages": int((scan.stats or {}).get("pages", 0)),
        "started_at": scan.started_at.isoformat() if scan.started_at else None,
        "finished_at": scan.finished_at.isoformat() if scan.finished_at else None,
        "created_at": scan.created_at.isoformat() if scan.created_at else None,
        "g2_approved": scan.id in g2_ids,
        "baseline": bool(g2_ids) and scan.id == g2_ids[0],
    }


async def set_dict(s: AsyncSession, cs: ChangeSet, *, see_email: bool, can_compare: bool) -> dict[str, Any]:
    scans = {
        x.id: x
        for x in (
            await s.execute(
                select(ScanSession).where(ScanSession.id.in_([cs.base_scan_session_id, cs.target_scan_session_id]))
            )
        ).scalars()
    }
    g2 = await g2_scan_ids(s, cs.project_id)
    summary = dict(cs.summary or {})
    requester: uuid.UUID | None = None
    if summary.get("requested_by"):
        requester = uuid.UUID(str(summary["requested_by"]))
    elif cs.stage_run_id is not None:
        target = scans[cs.target_scan_session_id]
        requester = (
            await s.execute(select(StageRun.triggered_by).where(StageRun.id == target.stage_run_id))
        ).scalar_one_or_none()
    user = (await s.execute(select(User).where(User.id == requester))).scalar_one_or_none() if requester else None
    return {
        "id": str(cs.id),
        "key": cs.key,
        "status": cs.status.value,
        "source": "rescan" if cs.stage_run_id else "compare",
        "base": scan_ref(scans[cs.base_scan_session_id], g2),
        "target": scan_ref(scans[cs.target_scan_session_id], g2),
        "summary": {k: summary.get(k) for k in ("total", "by_significance", "by_kind", "content_values", "pages")},
        "not_compared": summary.get("not_compared") or [],
        "rebaseline_suggested": cs.rebaseline_suggested,
        "generated_by": cs.generated_by.value,
        "ai_summary": {"text": cs.ai_summary, "generated_by": "ai"} if cs.ai_summary else None,
        "started_by": out.person(user, see_email=see_email),
        "created_at": cs.created_at.isoformat() if cs.created_at else None,
        "finished_at": cs.finished_at.isoformat() if cs.finished_at else None,
        "error": cs.error,
        "statement": d.CHANGE_STATEMENT,
        "permissions": {"can_compare": can_compare},
    }


def _display_kind(row: ChangeItem) -> str:
    if (row.after or {}).get("group") == d.CONTENT_VALUES:
        return "content_values"
    return DISPLAY_KIND.get(row.kind, "changed")


async def items_list(
    ctx: AppContext,
    s: AsyncSession,
    cs: ChangeSet,
    *,
    kind: str | None,
    significance: str | None,
    page: str | None,
) -> dict[str, Any]:
    q = select(ChangeItem).where(ChangeItem.change_set_id == cs.id)
    if kind:
        try:
            q = q.where(ChangeItem.kind == ChangeKind(kind))
        except ValueError as exc:
            raise ValidationFailed("Unknown change kind", details=[{"field": "kind", "message": "Unknown"}]) from exc
    if significance:
        try:
            q = q.where(ChangeItem.significance == ChangeSignificance(significance))
        except ValueError as exc:
            raise ValidationFailed(
                "Unknown significance", details=[{"field": "significance", "message": "Unknown"}]
            ) from exc
    rows = list((await s.execute(q)).scalars())
    if page:
        rows = [r for r in rows if r.page_url and d.path_of(r.page_url) == page]
    rows.sort(key=lambda r: (d.KIND_ORDER.index(r.kind), d.path_of(r.page_url) if r.page_url else ""))
    ev_ids = [
        ref.get(k)
        for r in rows
        for ref in (r.before_ref or {}, r.after_ref or {})
        for k in ("screenshot_evidence_id", "dom_evidence_id")
    ]
    evs = await evidence_map(s, ev_ids)

    def ref_out(ref: dict[str, Any] | None) -> dict[str, Any] | None:
        if not ref:
            return None
        res: dict[str, Any] = {"page_id": ref.get("page_id"), "url": ref.get("url"),
                               "fingerprint": ref.get("fingerprint")}  # fmt: skip
        for k, name in (("screenshot_evidence_id", "screenshot"), ("dom_evidence_id", "dom")):
            ev = evs.get(uuid.UUID(str(ref[k]))) if ref.get(k) else None
            res[name] = evidence_link(ctx, ev).model_dump(mode="json") if ev else None
        return res

    items = [
        {
            "id": str(r.id),
            "kind": r.kind.value,
            "display_kind": _display_kind(r),
            "significance": r.significance.value,
            "page_url": r.page_url,
            "page": d.path_of(r.page_url) if r.page_url else None,
            "subject": d.describe(d.Change(r.kind, r.significance, r.page_url, r.before, r.after)),
            "before": r.before,
            "after": r.after,
            "before_ref": ref_out(r.before_ref),
            "after_ref": ref_out(r.after_ref),
        }
        for r in rows
    ]
    return {"items": items, "total": len(items)}
