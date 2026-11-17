"""Exploratory sessions (P6-03a, decisions D29, D30): requests, charters, budget, approval, stop, reads and drafts.

A session is a `quality_scans` row of kind `exploratory` (EXP-0001) run by the `exploratory_session` job
(`app.agents.exploratory.explorer`). Its `config` holds the charter, the pages in charter order, the budget, the change
set and whether it is signed in. Anonymous sessions are queued at once; a signed-in session is created
`awaiting_approval` with a pending `exploratory_session` approval (`can_approve`, the host typed, single use, 24 h:
the P5-01b load test pattern) and nothing contacts the site before it is approved. The budget is checked against the
organisation ceiling and the platform cap here and again when the job starts; the worker enforces it. Stop now is one
conditional UPDATE the job polls (the P5 `stopped_by` pattern), so it ends within 2 s.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime
from typing import Any

from sqlalchemy import CursorResult, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.agents.discovery.heuristics import skip_reason
from app.agents.phase2 import applied_run
from app.api.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    Approval,
    ChangeItem,
    ChangeSet,
    Defect,
    DefectLink,
    DiscoveredPage,
    ExploratoryStep,
    Organisation,
    PerformanceRun,
    Project,
    QualityFinding,
    QualityScan,
    Requirement,
    User,
)
from app.db.types import utcnow
from app.domain.enums import (
    ApprovalKind,
    ApprovalStatus,
    ChangeKind,
    ChangeSetStatus,
    DefectSeverity,
    DefectSource,
    FindingStatus,
    PerfRunStatus,
    Priority,
    QualityScanKind,
    QualityScanStatus,
    StageKey,
    StepOutcome,
)
from app.domain.exploratory import limits as lim
from app.domain.exploratory import oracles as orc
from app.domain.exploratory.actions import path_of
from app.domain.stages import QUALITY_SCAN_STAGE_STATUS
from app.services import approvals as apr
from app.services import defects as dsvc
from app.services import quality as qsvc
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.counters import next_key

KIND = QualityScanKind.exploratory
JOB = "exploratory_session"
ACTIVE = (QualityScanStatus.queued, QualityScanStatus.running)
WAITING = (QualityScanStatus.awaiting_approval,)
FINISHED = (
    QualityScanStatus.completed,
    QualityScanStatus.partial,
    QualityScanStatus.cancelled,
    QualityScanStatus.failed,
)
REFUSE_NEEDS_COMMENT = "Say why this session shouldn't run."
NEEDS_CREDENTIALS = "Save test credentials to explore signed in."
NOTHING_SENT = "Nothing was sent to the site."
ROOT_CAUSE = "Not analysed. Automated checks measure what happens, not why."
# Charters (roadmap P6-03a): key → label. "change_set" is the default when a completed change set exists.
CHARTERS = {
    "change_set": "New and changed pages from {key}",
    "open_defects": "Pages with open defects",
    "all": "All discovered pages",
    "chosen": "Chosen pages",
}
STATUS_LABELS = {
    QualityScanStatus.awaiting_approval: "Waiting for approval",
    QualityScanStatus.rejected: "Not approved",
    QualityScanStatus.expired: "Request expired",
    QualityScanStatus.queued: "Waiting to start",
    QualityScanStatus.running: "Exploring",
    QualityScanStatus.completed: "Finished · budget used",
    QualityScanStatus.partial: "Finished · budget used",
    QualityScanStatus.failed: "Didn't complete",
    QualityScanStatus.cancelled: "Stopped",
}
DEFECT_SEVERITY = {"high": DefectSeverity.major, "medium": DefectSeverity.minor, "low": DefectSeverity.trivial}
REMOVED_KINDS = (ChangeKind.page_removed,)


def what_it_does(netloc: str) -> list[str]:
    """Design §9.2 "What it does" (the start dialog and the approval panel show it verbatim)."""
    return [
        f"Clicks buttons that can't submit, tabs, menus and links to pages on {netloc}, and presses Escape to check "
        "that a dialog closes.",
        "Never types, selects, uploads, submits forms or downloads files.",
        "Never clicks anything named like delete, remove, buy, pay, order, checkout, subscribe, send, submit, confirm, "
        "save or sign out, and never opens sign-out addresses, even through a redirect. Those are listed as "
        '"Not tried".',
        "Blocks every request the page tries to send other than reading. Blocked attempts are listed.",
        "Desktop 1440 × 900 only.",
    ]


# ------------------------------------------------------------------ limits


async def org_ceiling(s: AsyncSession, org_id: uuid.UUID) -> lim.Budget:
    org = await s.get(Organisation, org_id)
    return lim.Budget.from_dict(((org.settings if org else None) or {}).get("exploration_ceiling"), lim.DEFAULT_CEILING)


async def limits(ctx: AppContext, s: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    """{organisation (the effective ceiling), server (the platform cap), stored, default} for the dialog's lines."""
    stored = await org_ceiling(s, org_id)
    cap = ctx.settings.explore_cap
    eff = lim.effective_ceiling(stored, cap)
    return {
        "organisation": eff.as_dict(),
        "server": cap.as_dict(),
        "stored": stored.as_dict(),
        "default": eff.as_dict(),  # a session asks for the whole effective ceiling unless the person lowers it
        "line": f"Limits: up to {eff.actions} actions and {eff.minutes} minutes per session in this organisation.",
    }


def _raise(violations: list[lim.Violation]) -> None:
    if violations:
        raise ValidationFailed(
            violations[0].message, details=[{"field": v.field, "message": v.message} for v in violations]
        )


async def save_ceiling(
    ctx: AppContext, s: AsyncSession, org: Organisation, user: User, raw: dict[str, Any]
) -> dict[str, int]:
    """`PATCH /organisations/{id}/settings {exploration_ceiling}` (owner/admin): within the platform cap, audited."""
    _raise(lim.ceiling_violations(raw, ctx.settings.explore_cap))
    new = lim.Budget(actions=int(raw["actions"]), minutes=int(raw["minutes"]))
    before = lim.Budget.from_dict((org.settings or {}).get("exploration_ceiling"), lim.DEFAULT_CEILING)
    org.settings = {**(org.settings or {}), "exploration_ceiling": new.as_dict()}
    changes = [
        f"{f} {getattr(before, f)} → {getattr(new, f)}"
        for f in ("actions", "minutes")
        if getattr(before, f) != getattr(new, f)
    ]
    if changes:
        audit(
            s,
            org_id=org.id,
            action="exploration_ceiling.changed",
            target_type="organisation",
            target_id=org.id,
            actor_user_id=user.id,
            metadata={"from": before.as_dict(), "to": new.as_dict(), "changes": ", ".join(changes)},
        )
    return new.as_dict()


# ------------------------------------------------------------------ charters


def _page_out(p: DiscoveredPage) -> dict[str, Any]:
    url = p.final_url or p.url
    return {"page_id": str(p.id), "url": url, "path": path_of(url), "requires_auth": bool(p.requires_auth)}


async def latest_change_set(s: AsyncSession, project_id: uuid.UUID) -> ChangeSet | None:
    return (
        await s.execute(
            select(ChangeSet)
            .where(ChangeSet.project_id == project_id, ChangeSet.status == ChangeSetStatus.completed)
            .order_by(ChangeSet.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def change_pages(s: AsyncSession, cs: ChangeSet) -> tuple[list[str], dict[str, list[str]]]:
    """Paths of the pages a change set added or changed (in item order) and, per path, the names of new and changed
    elements (the rule strategy tries those first)."""
    rows = list((await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars())
    paths: list[str] = []
    names: dict[str, list[str]] = defaultdict(list)
    for r in sorted(rows, key=lambda x: (x.kind != ChangeKind.page_added, x.created_at)):
        if not r.page_url or r.kind in REMOVED_KINDS:
            continue
        path = path_of(r.page_url)
        if path not in paths:
            paths.append(path)
        after = r.after or {}
        for k in ("name", "label", "text", "to"):
            v = after.get(k)
            if isinstance(v, str) and v.strip() and v not in names[path]:
                names[path].append(v.strip()[:120])
    return paths, dict(names)


async def defect_pages(s: AsyncSession, project_id: uuid.UUID, pages: list[DiscoveredPage]) -> set[str]:
    """Paths of discovered pages an open defect points at: the pages it names, or the pages of the features its
    requirements cover."""
    open_defects = list(
        (await s.execute(select(Defect).where(Defect.project_id == project_id, Defect.status.in_(dsvc.OPEN)))).scalars()
    )
    if not open_defects:
        return set()
    paths: set[str] = set()
    for d in open_defects:
        env = d.environment or {}
        for p in env.get("pages") or []:
            if isinstance(p, str):
                paths.add(path_of(p) if "://" in p else p)
    lineages = set(
        (
            await s.execute(
                select(DefectLink.requirement_lineage_id).where(
                    DefectLink.defect_id.in_([d.id for d in open_defects]),
                    DefectLink.requirement_lineage_id.is_not(None),
                )
            )
        ).scalars()
    )
    if lineages:
        rrun = await applied_run(s, project_id, StageKey.requirements)
        reqs = (
            list((await s.execute(select(Requirement).where(Requirement.stage_run_id == rrun.id))).scalars())
            if rrun is not None
            else []
        )
        fids = {str(f) for r in reqs if r.lineage_id in lineages for f in r.feature_ids or []}
        if fids and pages:
            feats = (
                await s.execute(
                    select(ApplicationFeature).where(ApplicationFeature.scan_session_id == pages[0].scan_session_id)
                )
            ).scalars()
            by_id = {str(p.id): p for p in pages}
            for f in feats:
                if str(f.id) in fids:
                    for pid in f.page_ids or []:
                        if str(pid) in by_id:
                            paths.add(path_of(by_id[str(pid)].final_url or by_id[str(pid)].url))
    return paths


def _eligible(p: DiscoveredPage, signed_in: bool) -> str | None:
    """Why a discovered page can't be explored in this session (None = it can)."""
    url = p.final_url or p.url
    if skip_reason(url) == "would end the session":
        return "looks like a sign-out link"
    if p.requires_auth and not signed_in:
        return "needs sign-in: turn on Explore signed in"
    return None


async def options(ctx: AppContext, s: AsyncSession, project: Project) -> dict[str, Any]:
    """What the start dialog offers (design §9.2): charters with their page counts, the discovered pages with their
    eligibility, the latest change set, whether credentials are saved and the limits."""
    from app.services.secrets import credentials_secret

    _disc, pages = await qsvc.discovered_pages(s, project.id)
    cs = await latest_change_set(s, project.id)
    changed, _names = await change_pages(s, cs) if cs is not None else ([], {})
    by_path = {path_of(p.final_url or p.url): p for p in pages}
    defects = await defect_pages(s, project.id, pages)
    explorable = [p for p in pages if _eligible(p, True) is None]
    charters: list[dict[str, Any]] = []
    if cs is not None:
        n = sum(1 for x in changed if x in by_path and _eligible(by_path[x], True) is None)
        charters.append({"key": "change_set", "label": CHARTERS["change_set"].format(key=cs.key), "pages": n,
                         "change_set": {"id": str(cs.id), "key": cs.key},
                         "disabled_reason": None if n else f"No new or changed page in {cs.key}."})  # fmt: skip
    nd = sum(1 for x in explorable if path_of(x.final_url or x.url) in defects)
    charters += [
        {"key": "open_defects", "label": CHARTERS["open_defects"], "pages": nd, "change_set": None,
         "disabled_reason": None if nd else "No page has an open defect."},
        {"key": "all", "label": CHARTERS["all"], "pages": len(explorable), "change_set": None,
         "disabled_reason": None if explorable else "Discovery found no pages to explore."},
        {"key": "chosen", "label": CHARTERS["chosen"], "pages": None, "change_set": None, "disabled_reason": None},
    ]  # fmt: skip
    default = next((c["key"] for c in charters if c["key"] == "change_set" and not c["disabled_reason"]), "all")
    origin, host = await apr.target(s, project.id)
    netloc = origin.split("://", 1)[1]
    return {
        "charters": charters,
        "default_charter": default,
        "pages": [
            {**_page_out(p), "anonymous_reason": _eligible(p, False), "signed_in_reason": _eligible(p, True)}
            for p in pages
        ],
        "change_set": {"id": str(cs.id), "key": cs.key} if cs is not None else None,
        "credentials_saved": await credentials_secret(s, project.id) is not None,
        "limits": await limits(ctx, s, project.organisation_id),
        "host": host,
        "netloc": netloc,
        "what_it_does": what_it_does(netloc),
        "statement": lim.SHORT_STATEMENT,
    }


async def _charter_pages(
    s: AsyncSession,
    project: Project,
    charter: str,
    *,
    page_ids: list[uuid.UUID] | None,
    change_set_id: uuid.UUID | None,
    signed_in: bool,
) -> tuple[list[DiscoveredPage], list[dict[str, Any]], ChangeSet | None, dict[str, list[str]]]:
    """(pages to explore in charter order, pages left out with the reason, change set, priority names per path)."""
    if charter not in CHARTERS:
        raise ValidationFailed("Choose what to explore", details=[{"field": "charter",
                               "message": "Choose what to explore"}])  # fmt: skip
    _disc, pages = await qsvc.discovered_pages(s, project.id)
    if not pages:
        raise ValidationFailed("Discovery found no pages to explore.")
    cs: ChangeSet | None = None
    names: dict[str, list[str]] = {}
    if charter == "change_set":
        if change_set_id is not None:
            cs = (
                await s.execute(
                    select(ChangeSet).where(ChangeSet.id == change_set_id, ChangeSet.project_id == project.id)
                )
            ).scalar_one_or_none()
            if cs is None:
                raise ValidationFailed("Choose a change set of this project", details=[{"field": "change_set_id",
                                       "message": "Choose a change set of this project"}])  # fmt: skip
            if cs.status != ChangeSetStatus.completed:
                raise ValidationFailed(f"{cs.key} hasn't finished yet")
        else:
            cs = await latest_change_set(s, project.id)
            if cs is None:
                raise ValidationFailed("There is no change set yet. Rescan the site first, or choose other pages.")
        paths, names = await change_pages(s, cs)
        by_path = {path_of(p.final_url or p.url): p for p in pages}
        chosen = [by_path[x] for x in paths if x in by_path]
    elif charter == "open_defects":
        paths_d = await defect_pages(s, project.id, pages)
        chosen = [p for p in pages if path_of(p.final_url or p.url) in paths_d]
        if not chosen:
            raise ValidationFailed("No page has an open defect.")
    elif charter == "chosen":
        wanted = [str(x) for x in page_ids or []]
        if not wanted:
            raise ValidationFailed("Choose at least one page.", details=[{"field": "pages",
                                   "message": "Choose at least one page."}])  # fmt: skip
        by_id = {str(p.id): p for p in pages}
        if set(wanted) - set(by_id):
            raise ValidationFailed("Choose pages that discovery visited")
        chosen = [by_id[x] for x in dict.fromkeys(wanted)]
    elif charter == "all":
        chosen = list(pages)
    else:
        raise ValidationFailed("Choose what to explore", details=[{"field": "charter",
                               "message": "Choose what to explore"}])  # fmt: skip
    keep: list[DiscoveredPage] = []
    left: list[dict[str, Any]] = []
    for p in chosen:
        why = _eligible(p, signed_in)
        if why is None:
            keep.append(p)
        else:
            left.append({**_page_out(p), "reason": why})
    if not keep:
        if charter == "chosen":
            raise ValidationFailed(f"These pages can't be explored: {left[0]['reason']}." if left else
                                   "Choose at least one page.")  # fmt: skip
        if charter == "change_set" and cs is not None and not left:
            raise ValidationFailed(f"No new or changed page in {cs.key}.")
        raise ValidationFailed(f"No page of this charter can be explored: {left[0]['reason']}." if left else
                               "No page of this charter can be explored.")  # fmt: skip
    return keep, left, cs, names


# ------------------------------------------------------------------ requests


async def _busy(s: AsyncSession, project_id: uuid.UUID) -> QualityScan | None:
    return (
        await s.execute(
            select(QualityScan)
            .where(QualityScan.project_id == project_id, QualityScan.kind == KIND, QualityScan.status.in_(ACTIVE))
            .limit(1)
        )
    ).scalar_one_or_none()


def _one_at_a_time(key: str) -> Conflict:
    return Conflict(f"{key} is already running on this project. One session at a time.", details={"key": key})


async def _claim(s: AsyncSession, project_id: uuid.UUID) -> None:
    """Flushes a session that just became `queued`. The partial unique index `uq_quality_scans_one_active_exploration`
    (migration 0021) lets only one queued or running exploratory session exist per project, so of two concurrent
    starts or approvals exactly one commits; the other is rolled back here and gets 409."""
    try:
        await s.flush()
    except IntegrityError:
        await s.rollback()
        busy = await _busy(s, project_id)
        raise _one_at_a_time(busy.key if busy else "Another session") from None


def summary_sentence(n_pages: int, netloc: str, budget: lim.Budget, signed_in: bool) -> str:
    """Design §9.4: 'Explore 3 pages on localhost:4100 signed in with the saved test account, for up to 60 actions
    and 10 minutes.' (server-computed, shown verbatim)."""
    who = " signed in with the saved test account" if signed_in else ""
    pages = f"{n_pages} page{'s' if n_pages != 1 else ''}"
    return f"Explore {pages} on {netloc}{who}, for up to {budget.actions} actions and {budget.minutes} minutes."


async def create_session(
    ctx: AppContext,
    s: AsyncSession,
    project: Project,
    user: User,
    *,
    charter: str | None,
    page_ids: list[uuid.UUID] | None,
    change_set_id: uuid.UUID | None,
    budget: dict[str, Any] | None,
    signed_in: bool,
) -> tuple[QualityScan, Approval | None]:
    """EXP-0001: queued (anonymous) or `awaiting_approval` with its approval (signed in). Sends nothing.

    409 when G2 isn't satisfied or a session is already running on the project; 422 for an unknown charter, pages
    that can't be explored, a budget over a limit (the message names it) or missing credentials."""
    from app.orchestrator.orchestrator import Orchestrator
    from app.services.secrets import credentials_secret

    await Orchestrator(ctx).check_optional_upstream(s, project, StageKey.exploratory)
    busy = await _busy(s, project.id)
    if busy is not None:
        raise _one_at_a_time(busy.key)
    ceiling = await org_ceiling(s, project.organisation_id)
    cap = ctx.settings.explore_cap
    eff = lim.effective_ceiling(ceiling, cap)
    raw = {**eff.as_dict(), **(budget or {})}
    _raise(lim.budget_violations(raw, ceiling, cap))
    chosen_budget = lim.Budget(actions=int(raw["actions"]), minutes=int(raw["minutes"]))
    if charter is None:
        charter = "chosen" if page_ids else ("change_set" if await latest_change_set(s, project.id) else "all")
    if signed_in and await credentials_secret(s, project.id) is None:
        raise ValidationFailed(NEEDS_CREDENTIALS, details=[{"field": "signed_in", "message": NEEDS_CREDENTIALS}])
    pages, left, cs, names = await _charter_pages(
        s, project, charter, page_ids=page_ids, change_set_id=change_set_id, signed_in=signed_in
    )
    cap_pages = ctx.settings.scan_max_pages_cap
    over = pages[cap_pages:]
    pages = pages[:cap_pages]
    left += [{**_page_out(p), "reason": f"over the {cap_pages}-page limit"} for p in over]
    disc, _pages = await qsvc.discovered_pages(s, project.id)
    origin, host = await apr.target(s, project.id)
    netloc = origin.split("://", 1)[1]
    _n, key = await next_key(s, project.organisation_id, project.id, "exploratory_session")
    label = CHARTERS[charter].format(key=cs.key if cs else "")
    scan = QualityScan(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        kind=KIND,
        config={
            "charter": charter,
            "charter_label": label,
            "change_set_id": str(cs.id) if cs else None,
            "change_set_key": cs.key if cs else None,
            "pages": [_page_out(p) for p in pages],
            "priority": names,
            "budget": chosen_budget.as_dict(),
            "signed_in": signed_in,
            "origin": origin,
            "host": host,
            "netloc": netloc,
            "discovery_scan": disc.key if disc else None,
            "viewports": ["desktop"],
            "summary_sentence": summary_sentence(len(pages), netloc, chosen_budget, signed_in),
        },
        not_checked=left,
        tool_versions={"explorer": "rules 1"},
        requested_by=user.id,
        status=QualityScanStatus.awaiting_approval if signed_in else QualityScanStatus.queued,
        summary={"actions": 0, "pages": 0},
    )
    s.add(scan)
    await _claim(s, project.id)
    approval: Approval | None = None
    if signed_in:
        _n2, akey = await next_key(s, project.organisation_id, project.id, "approval")
        approval = Approval(
            organisation_id=project.organisation_id,
            project_id=project.id,
            key=akey,
            kind=ApprovalKind.exploratory_session,
            quality_scan_id=scan.id,
            scope={
                "target_origin": origin,
                "target_host": host,
                "scan_key": key,
                "summary": scan.config["summary_sentence"],
                "pages": [path_of(p.final_url or p.url) for p in pages],
                "budget": chosen_budget.as_dict(),
                "charter": label,
                "what_it_does": what_it_does(netloc),
            },
            requested_by=user.id,
            status=ApprovalStatus.pending,
            expires_at=utcnow() + apr.APPROVAL_TTL,
        )
        s.add(approval)
        await s.flush()
    else:
        await Orchestrator(ctx).mirror_nonfunctional(
            s, project, StageKey.exploratory, scan, QUALITY_SCAN_STAGE_STATUS.get(scan.status)
        )
    audit(
        s,
        org_id=project.organisation_id,
        action="exploratory_session.requested",
        target_type="quality_scan",
        target_id=scan.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": key, "charter": charter, "pages": len(pages), "budget": chosen_budget.as_dict(),
                  "signed_in": signed_in, "approval": approval.key if approval else None},
    )  # fmt: skip
    return scan, approval


async def approval_of(s: AsyncSession, scan: QualityScan) -> Approval | None:
    return (
        await s.execute(
            select(Approval).where(
                Approval.quality_scan_id == scan.id, Approval.kind == ApprovalKind.exploratory_session
            )
        )
    ).scalar_one_or_none()


async def expire(s: AsyncSession, scan: QualityScan) -> bool:
    """A waiting signed-in request whose approval passed 24 h becomes `expired` (nothing was sent)."""
    if scan.kind != KIND or scan.status != QualityScanStatus.awaiting_approval:
        return False
    a = await approval_of(s, scan)
    if a is None:
        return False
    if await apr.expire_due(s, [a]) or a.status == ApprovalStatus.expired:
        scan.status = QualityScanStatus.expired
        scan.finished_at = utcnow()
        return True
    return False


async def decide(
    ctx: AppContext,
    s: AsyncSession,
    a: Approval,
    user: User,
    *,
    decision: str,
    comment: str | None,
    confirm_text: str | None,
) -> QualityScan:
    """D30: approve (host typed) or refuse (comment needed) a signed-in session. Approving queues it."""
    from app.orchestrator.orchestrator import Orchestrator

    scan = await s.get(QualityScan, a.quality_scan_id) if a.quality_scan_id else None
    if scan is None:
        raise Conflict("This approval has no exploratory session")
    if await expire(s, scan):
        raise Conflict(
            f"{a.key} expired after 24 hours. {NOTHING_SENT} Request it again.", details={"status": "expired"}
        )
    if scan.status != QualityScanStatus.awaiting_approval:
        raise Conflict(f"{scan.key} has already been decided", details={"status": scan.status.value})
    host = str((a.scope or {}).get("target_host") or "")
    if decision == "reject" and not (comment or "").strip():
        raise ValidationFailed(REFUSE_NEEDS_COMMENT, details=[{"field": "comment", "message": REFUSE_NEEDS_COMMENT}])
    if decision == "approve":
        if not apr.confirm_matches(confirm_text, host):
            msg = f"Type {host} exactly to approve."
            raise ValidationFailed(msg, details=[{"field": "confirm_text", "message": msg}])
        busy = await _busy(s, scan.project_id)
        if busy is not None:
            raise _one_at_a_time(busy.key)
    await apr.decide(s, a, decision=decision, comment=comment, confirm_text=confirm_text, user=user)
    project = (await s.execute(select(Project).where(Project.id == scan.project_id))).scalar_one()
    if decision == "approve":
        a.scope = {**(a.scope or {}), "host_typed": True, "self_approved": a.requested_by == user.id}
        scan.status = QualityScanStatus.queued
        await _claim(s, scan.project_id)
        await Orchestrator(ctx).mirror_nonfunctional(
            s, project, StageKey.exploratory, scan, QUALITY_SCAN_STAGE_STATUS.get(scan.status)
        )
    else:
        scan.status = QualityScanStatus.rejected
        scan.finished_at = utcnow()
    audit(
        s,
        org_id=scan.organisation_id,
        action=f"exploratory_session.{'approved' if decision == 'approve' else 'rejected'}",
        target_type="quality_scan",
        target_id=scan.id,
        actor_user_id=user.id,
        project_id=scan.project_id,
        metadata={"key": scan.key, "approval": a.key, "host_typed": "yes" if decision == "approve" else None},
    )
    return scan


async def withdraw(s: AsyncSession, scan: QualityScan, user: User) -> None:
    if scan.status != QualityScanStatus.awaiting_approval:
        raise Conflict(f"{scan.key} isn't waiting for approval")
    if scan.requested_by != user.id:
        raise Forbidden("Only the person who requested this session can withdraw it")
    a = await approval_of(s, scan)
    if a is not None and a.status == ApprovalStatus.pending:
        a.status = ApprovalStatus.rejected
        a.comment = "Request withdrawn"
        a.decided_by, a.decided_at = user.id, utcnow()
    scan.status = QualityScanStatus.rejected
    scan.finished_at = utcnow()
    scan.config = {**(scan.config or {}), "withdrawn": True}
    audit(s, org_id=scan.organisation_id, action="exploratory_session.withdrawn", target_type="quality_scan",
          target_id=scan.id, actor_user_id=user.id, project_id=scan.project_id, metadata={"key": scan.key})  # fmt: skip


async def stop(
    ctx: AppContext, s: AsyncSession, project: Project, scan: QualityScan, user: User, *, approver: bool
) -> str:
    """Stop now: the requester or any approver. A queued session stops at once; a running one within 2 s (the job
    polls the flag). One conditional UPDATE of `config` while the session is still active (the job never writes
    `config` once it runs), so it can't mark a session that finished in the meantime."""
    if not approver and scan.requested_by != user.id:
        raise Forbidden("Only the person who started this session or someone who can approve can stop it")
    if scan.status not in ACTIVE:
        raise Conflict(f"{scan.key} isn't running")
    cfg = {**(scan.config or {}), "cancel_requested": True, "cancelled_by": str(user.id)}
    done: CursorResult[Any] = await s.execute(  # type: ignore[assignment]
        update(QualityScan)
        .where(QualityScan.id == scan.id, QualityScan.status.in_(ACTIVE))
        .values(config=cfg)
        .execution_options(synchronize_session=False)
    )
    if not done.rowcount:
        raise Conflict(f"{scan.key} isn't running")
    set_committed_value(scan, "config", cfg)
    if scan.status == QualityScanStatus.queued:
        from app.orchestrator.orchestrator import Orchestrator

        scan.status = QualityScanStatus.cancelled
        scan.finished_at = utcnow()
        scan.summary = {**(scan.summary or {}), "end_reason": "stopped"}
        await Orchestrator(ctx).mirror_nonfunctional(
            s, project, StageKey.exploratory, scan, QUALITY_SCAN_STAGE_STATUS.get(scan.status)
        )
    audit(s, org_id=scan.organisation_id, action="exploratory_session.stop_requested", target_type="quality_scan",
          target_id=scan.id, actor_user_id=user.id, project_id=scan.project_id, metadata={"key": scan.key})  # fmt: skip
    return f"Stopping {scan.key}…" if scan.status == QualityScanStatus.running else f"{scan.key} stopped."


async def enqueue(ctx: AppContext, scan: QualityScan) -> None:
    await ctx.queue.enqueue(
        JOB,
        {"scan_id": str(scan.id)},
        org_id=scan.organisation_id,
        project_id=scan.project_id,
        dedupe_key=f"{JOB}:{scan.id}",
        concurrency_group=qsvc.QUALITY_GROUP,  # counted in the organisation's concurrent browser scans (T5)
        max_attempts=1,
    )


async def perf_running(s: AsyncSession, project_id: uuid.UUID) -> str | None:
    row = (
        await s.execute(
            select(PerformanceRun.key).where(
                PerformanceRun.project_id == project_id, PerformanceRun.status == PerfRunStatus.running
            )
        )
    ).first()
    return str(row[0]) if row else None


# ------------------------------------------------------------------ reads


def status_label(scan: QualityScan, names: dict[uuid.UUID, str]) -> str:
    cfg, sm = scan.config or {}, scan.summary or {}
    budget = lim.Budget.from_dict(cfg.get("budget"), lim.DEFAULT_CEILING)
    used = int(sm.get("actions") or 0)
    if scan.status == QualityScanStatus.running:
        return f"Exploring · {used} of {budget.actions} actions"
    if scan.status == QualityScanStatus.rejected and cfg.get("withdrawn"):
        return "Withdrawn"
    if scan.status in (QualityScanStatus.completed, QualityScanStatus.partial):
        reason = sm.get("end_reason")
        if reason == lim.UNREACHED:
            return "Finished · some actions not reached"
        if reason == lim.EXHAUSTED:
            return "Finished · every allowed action tried"
        if reason == lim.TIME_USED:
            return "Finished · time used"
        return "Finished · budget used"
    if scan.status == QualityScanStatus.cancelled:
        by = cfg.get("cancelled_by")
        who = names.get(uuid.UUID(by)) if by else None
        return f"Stopped by {who}" if who else "Stopped"
    return STATUS_LABELS[scan.status]


def _elapsed(scan: QualityScan) -> int | None:
    if scan.started_at is None:
        return None
    end = scan.finished_at or utcnow()
    return int((_aware(end) - _aware(scan.started_at)).total_seconds())


def _aware(d: datetime) -> datetime:
    from datetime import UTC

    return d if d.tzinfo is not None else d.replace(tzinfo=UTC)


def end_text(scan: QualityScan, names: dict[uuid.UUID, str]) -> str | None:
    """Design §9.6 end states."""
    sm = scan.summary or {}
    used = int(sm.get("actions") or 0)
    budget = lim.Budget.from_dict((scan.config or {}).get("budget"), lim.DEFAULT_CEILING)
    if scan.status in (QualityScanStatus.completed, QualityScanStatus.partial):
        return lim.end_line(sm.get("end_reason"), used, budget, unreached=len(sm.get("never_reached") or []))
    if scan.status == QualityScanStatus.cancelled:
        by = (scan.config or {}).get("cancelled_by")
        who = names.get(uuid.UUID(by)) if by else None
        return f"Stopped by {who or 'someone'} after {used} actions. Steps and findings so far are kept."
    if scan.status == QualityScanStatus.failed:
        return f"Didn't complete: {scan.error or 'the session stopped'}. Steps up to {used} are kept."
    if scan.status == QualityScanStatus.rejected:
        if (scan.config or {}).get("withdrawn"):
            return f"Request withdrawn. {NOTHING_SENT}"
        return f"Not approved. {NOTHING_SENT}"
    if scan.status == QualityScanStatus.expired:
        return f"This request expired after 24 hours. {NOTHING_SENT}"
    return None


async def session_dict(
    s: AsyncSession,
    scan: QualityScan,
    *,
    viewer: User,
    approver: bool,
    member: bool,
    see_email: bool,
    full: bool = False,
) -> dict[str, Any]:
    """One session as the Exploratory tab (list row) and the session page (full) show it (design §9.1–9.6)."""
    a = await approval_of(s, scan)
    cfg, sm = scan.config or {}, scan.summary or {}
    stopper = uuid.UUID(cfg["cancelled_by"]) if cfg.get("cancelled_by") else None
    us = await out.users(s, [x for x in (scan.requested_by, stopper, a.decided_by if a else None) if x])
    names = {k: (u.full_name or u.email) for k, u in us.items()}
    budget = lim.Budget.from_dict(cfg.get("budget"), lim.DEFAULT_CEILING)
    found = list((await s.execute(select(QualityFinding).where(QualityFinding.scan_id == scan.id))).scalars())
    by_sev = {k: sum(1 for f in found if f.severity.value == k) for k in ("high", "medium", "low")}
    used, explored = int(sm.get("actions") or 0), int(sm.get("pages") or 0)
    done = scan.status in FINISHED
    active = scan.status in ACTIVE
    d: dict[str, Any] = {
        "id": scan.id,
        "key": scan.key,
        "kind": scan.kind.value,
        "status": scan.status.value,
        "status_label": status_label(scan, names),
        "charter": {
            "key": cfg.get("charter"),
            "label": cfg.get("charter_label"),
            "change_set": {"id": cfg.get("change_set_id"), "key": cfg.get("change_set_key")}
            if cfg.get("change_set_key")
            else None,
        },
        "pages": len(cfg.get("pages") or []),
        "budget": budget.as_dict(),
        "signed_in": bool(cfg.get("signed_in")),
        "summary_sentence": cfg.get("summary_sentence"),
        "chosen_by": "rules",
        "generated_by": "rules",
        "requested_by": out.person(us.get(scan.requested_by), see_email=see_email) if scan.requested_by else None,
        "approved_by": out.person(us.get(a.decided_by), see_email=see_email)
        if a is not None and a.decided_by and a.status in (ApprovalStatus.approved, ApprovalStatus.used)
        else None,
        "stopped_by": out.person(us.get(stopper), see_email=see_email) if stopper else None,
        "created_at": scan.created_at,
        "started_at": scan.started_at,
        "finished_at": scan.finished_at,
        "elapsed_s": _elapsed(scan),
        "progress": {
            "actions_used": used,
            "actions_budget": budget.actions,
            "minutes_budget": budget.minutes,
            "pages_explored": explored,
            "pages_total": len(cfg.get("pages") or []) + int(sm.get("pages_added") or 0),
            "current_page": sm.get("current_page"),
            "last_step": sm.get("last_step"),
            "findings": len(found),
            "findings_by_severity": by_sev,
            "open_findings": sum(1 for f in found if f.status == FindingStatus.open),
            "blocked": len(sm.get("blocked") or []),
            "not_tried": len(sm.get("not_tried") or []),
        },
        "end_reason": sm.get("end_reason"),
        "end_text": end_text(scan, names),
        "statement": lim.statement(used, explored) if done else lim.SHORT_STATEMENT,
        "error": scan.error,
        "cancel_requested": bool(cfg.get("cancel_requested")),
        "drafted": sm.get("drafted") or [],
        "approval": {
            "id": a.id,
            "key": a.key,
            "status": a.status.value,
            "expires_at": a.expires_at,
            "decided_by": out.person(us.get(a.decided_by), see_email=see_email) if a.decided_by else None,
            "decided_at": a.decided_at,
            "comment": a.comment,
            "host_typed": bool((a.scope or {}).get("host_typed")),
            "self_approved": bool((a.scope or {}).get("self_approved")),
            "confirm_prompt": f"Type {cfg.get('host')} to approve",
        }
        if a
        else None,
        "permissions": {
            "can_approve": approver and scan.status == QualityScanStatus.awaiting_approval,
            "can_stop": active and (approver or scan.requested_by == viewer.id),
            "can_withdraw": scan.status == QualityScanStatus.awaiting_approval and scan.requested_by == viewer.id,
            "can_request_again": member and not active and scan.status != QualityScanStatus.awaiting_approval,
            "can_triage": member,
        },
    }
    if full:
        d["host"] = cfg.get("host")
        d["netloc"] = cfg.get("netloc")
        d["what_it_does"] = what_it_does(str(cfg.get("netloc") or cfg.get("host") or ""))
        d["page_list"] = cfg.get("pages") or []
        d["left_out"] = scan.not_checked or []
        d["blocked"] = sm.get("blocked") or []
        d["not_tried"] = sm.get("not_tried") or []
        d["never_reached"] = sm.get("never_reached") or []
        d["coverage"] = sm.get("coverage") or []
        d["elements_tried"] = int(sm.get("elements_tried") or 0)
        d["no_findings_line"] = (
            f"No problems found by the automated checks in {used} actions on {explored} pages."
            if done and not found
            else None
        )
        drafts = list(
            (
                await s.execute(
                    select(Defect.key, Defect.summary, Defect.status)
                    .join(QualityFinding, QualityFinding.defect_id == Defect.id)
                    .where(QualityFinding.scan_id == scan.id)
                    .distinct()
                )
            ).all()
        )
        d["defects"] = sorted(
            ({"key": k, "summary": smy, "status": st.value} for k, smy, st in drafts), key=lambda x: x["key"]
        )
    return d


async def steps(s: AsyncSession, scan: QualityScan, *, outcome: str | None = None) -> list[dict[str, Any]]:
    stmt = select(ExploratoryStep).where(ExploratoryStep.scan_id == scan.id)
    if outcome:
        wanted = [x for x in outcome.split(",") if x in StepOutcome.__members__]
        stmt = stmt.where(ExploratoryStep.outcome.in_(wanted))
    rows = list((await s.execute(stmt.order_by(ExploratoryStep.n))).scalars())
    findings = list((await s.execute(select(QualityFinding).where(QualityFinding.scan_id == scan.id))).scalars())
    by_step: dict[int, list[str]] = defaultdict(list)
    for f in findings:
        details = (f.mapped or {}).get("details") or {}
        for n in [details.get("step"), *(details.get("steps_seen") or [])]:
            if isinstance(n, int) and f.key not in by_step[n]:
                by_step[n].append(f.key)
    return [
        {
            "n": r.n,
            "page_url": r.page_url,
            "page": path_of(r.page_url),
            "action": r.action,
            "label": (r.action or {}).get("label"),
            "outcome": r.outcome.value,
            "observations": r.observations or [],
            "evidence_ids": r.evidence_ids or [],
            "chosen_by": r.chosen_by.value,
            "findings": by_step.get(r.n, []),
            "created_at": r.created_at,
        }
        for r in rows
    ]


async def get_session(s: AsyncSession, scan_id: uuid.UUID) -> QualityScan:
    scan = (
        await s.execute(select(QualityScan).where(QualityScan.id == scan_id, QualityScan.kind == KIND))
    ).scalar_one_or_none()
    if scan is None:
        raise NotFound("Session not found")
    return scan


# ------------------------------------------------------------------ defects (G8 as always)


async def _open_group_defect(s: AsyncSession, project_id: uuid.UUID, group: str) -> Defect | None:
    rows = (
        await s.execute(
            select(Defect).where(
                Defect.project_id == project_id, Defect.source == DefectSource.exploratory, Defect.status.in_(dsvc.OPEN)
            )
        )
    ).scalars()
    return next((d for d in rows if (d.environment or {}).get("rule_id") == group), None)


def _why(fs: list[QualityFinding], path: str) -> str:
    lead = next((f for f in fs if f.severity.value == "high"), None) or next(
        (f for f in fs if f.rule_id in orc.AUTO_DRAFT_RULES), fs[0]
    )
    title = lead.title.strip()
    return f"{title[:1].lower()}{title[1:]} on {path}"[:300]


def _fields(scan: QualityScan, fs: list[QualityFinding], origin: str, *, by: str | None) -> dict[str, Any]:
    first = fs[0]
    det = (first.mapped or {}).get("details") or {}
    action = det.get("action") or {}
    name = (action.get("target") or {}).get("name") or "the page"
    path = path_of(first.url)
    problems = [orc.Problem(f.rule_id, f.severity.value, f.title, "", ((f.mapped or {}).get("details") or {})
                            .get("subject") or "") for f in fs]  # fmt: skip
    worst = "high" if any(f.severity.value == "high" for f in fs) else (
        "medium" if any(f.severity.value == "medium" for f in fs) else "low")  # fmt: skip
    dsev = DEFECT_SEVERITY[worst]
    observed = "; ".join(str(((f.mapped or {}).get("details") or {}).get("observed") or f.title) for f in fs)
    step = det.get("step")
    return {
        "summary": orc.defect_summary(path, name, problems) if action else first.title[:300],
        "description": (
            f"Raised from {first.key} ({scan.key}) by {by}."
            if by
            else f"Found by {scan.key}"
            + (f" at step {step}" if step else "")
            + ": "
            + ", ".join(f"{f.key} ({f.title})" for f in fs)
            + "."
        ),
        "environment": {
            "url": origin,
            "browser": "Chromium",
            "viewport": "desktop 1440 × 900",
            "scan_key": scan.key,
            "rule_id": group_key(fs),
            "pages": [path],
            "step": step,
            "findings": [f.key for f in fs],
            # Gate 8 "Why" line (design §9.8): the finding that made the draft, where it happened.
            "why": _why(fs, path),
        },
        "preconditions": ["Signed in with the saved test account."] if (scan.config or {}).get("signed_in") else [],
        "steps": list(det.get("steps") or [f"Open {path}."]),
        "expected": f"[Assumed] {('Using ' + repr(name)) if action else 'Opening the page'} works without errors and "
        "shows real values.",
        "actual": f"[Observed] {observed}"[:2000],
        "severity": dsev,
        "severity_derived": dsev,
        "severity_reason": f"from the exploratory finding's severity ({worst})",
        "priority": Priority.medium,
        "priority_derived": Priority.medium,
        "priority_reason": "default for exploratory drafts" if by is None else "set by a person",
        "reproducibility": {"kind": "always"},
        "root_cause_hypothesis": ROOT_CAUSE,
        "evidence_refs": [r for f in fs for r in f.evidence_refs or []][:20],
    }


def group_key(fs: list[QualityFinding]) -> str:
    """One grouped draft per action: the sorted fingerprints of the findings it produced."""
    import hashlib

    return hashlib.sha256("|".join(sorted(f.fingerprint for f in fs)).encode()).hexdigest()[:32]


def _occurrence(d: Defect, scan: QualityScan, fs: list[QualityFinding], *, added: bool) -> None:
    env = dict(d.environment or {})
    occ = [o for o in env.get("occurrences") or [] if o.get("scan_key") != scan.key]
    occ.append({"scan_key": scan.key, "findings": [f.key for f in fs], "added": added, "at": utcnow().isoformat()})
    env["occurrences"] = occ
    d.environment = env


async def drafts(s: AsyncSession, project: Project, scan: QualityScan) -> tuple[list[str], list[str]]:
    """Roadmap "Defect drafts": one grouped draft per action whose findings include a high one or an uncaught error
    (the action's other findings join it), or an occurrence on the open draft of the same group from an earlier
    session. Findings already triaged as accepted risk or false positive ("Seen before") are left out. Returns
    (drafted keys, keys that got an occurrence)."""
    rows = list(
        (
            await s.execute(
                select(QualityFinding).where(QualityFinding.scan_id == scan.id).order_by(QualityFinding.key)
            )
        ).scalars()
    )
    groups: dict[Any, list[QualityFinding]] = defaultdict(list)
    for f in rows:
        if f.defect_id is not None or f.status in (FindingStatus.accepted_risk, FindingStatus.false_positive):
            continue
        g = ((f.mapped or {}).get("details") or {}).get("group")
        groups[g if g is not None else f.key].append(f)
    origin = str((scan.config or {}).get("origin") or "")
    drafted: list[str] = []
    added: list[str] = []
    for fs in groups.values():
        if not any(f.severity.value == "high" or f.rule_id in orc.AUTO_DRAFT_RULES for f in fs):
            continue
        existing = await _open_group_defect(s, project.id, group_key(fs))
        if existing is not None:
            _occurrence(existing, scan, fs, added=True)
            for f in fs:
                f.defect_id = existing.id
            await _link(s, project, existing, fs)
            added.append(existing.key)
            continue
        d = await dsvc.create_defect(s, project, _fields(scan, fs, origin, by=None), source=DefectSource.exploratory,
                                     result=None, case=None, user_id=None)  # fmt: skip
        _occurrence(d, scan, fs, added=False)
        await _link(s, project, d, fs)
        drafted.append(d.key)
    return drafted, added


async def _link(s: AsyncSession, project: Project, d: Defect, fs: list[QualityFinding]) -> None:
    lineages = {r["lineage_id"] for f in fs for r in (f.mapped or {}).get("requirements") or []}
    have = set(
        (await s.execute(select(DefectLink.requirement_lineage_id).where(DefectLink.defect_id == d.id))).scalars()
    )
    for lid in sorted(lineages):
        if uuid.UUID(lid) not in have:
            s.add(DefectLink(organisation_id=project.organisation_id, project_id=project.id, defect_id=d.id,
                             requirement_lineage_id=uuid.UUID(lid)))  # fmt: skip
    for f in fs:
        f.defect_id = d.id


async def raise_defect(s: AsyncSession, project: Project, f: QualityFinding, user: User) -> Defect:
    """Raise defect on one exploratory finding (members; low and medium findings are drafted on request)."""
    scan = await s.get(QualityScan, f.scan_id)
    assert scan is not None
    origin = str((scan.config or {}).get("origin") or "")
    d = await dsvc.create_defect(s, project, _fields(scan, [f], origin, by=user.full_name or user.email),
                                 source=DefectSource.exploratory, result=None, case=None, user_id=user.id)  # fmt: skip
    _occurrence(d, scan, [f], added=False)
    await _link(s, project, d, [f])
    return d
