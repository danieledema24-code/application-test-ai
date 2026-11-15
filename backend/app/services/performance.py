"""Load profiles, load test requests, `load_test` approvals and runs (P5-01b, decisions D17, D18, D20).

Load is capped in code at every step: the profile is checked against the organisation ceiling (itself within the
platform hard cap) when it is saved, when a run is requested and when its approval is decided; the adapter and the
generator check the hard cap again. Every run needs its own `load_test` approval by `can_approve` with the host typed
(single use, 24 h). A changed profile, ceiling or hard cap invalidates a waiting request. Nothing contacts the
target until the approved run's job starts.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CursorResult, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.agents.phase2 import applied_run
from app.api.errors import Conflict, Forbidden, ValidationFailed
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    Approval,
    Defect,
    Organisation,
    PerformanceProfile,
    PerformanceRun,
    Project,
    Requirement,
    User,
)
from app.db.types import utcnow
from app.domain.enums import (
    ApprovalKind,
    ApprovalStatus,
    GeneratedBy,
    PerfProfileStatus,
    PerfProfileType,
    PerfRunStatus,
    Provenance,
    RequirementStatus,
    StageKey,
)
from app.domain.performance import profile as rules
from app.domain.performance.limits import (
    DEFAULT_CEILING,
    MAX_TARGETS,
    LoadLimits,
    Violation,
    ceiling_violations,
    duration_text,
    effective_ceiling,
    profile_violations,
)
from app.domain.stages import PERF_RUN_STAGE_STATUS
from app.services import approvals as apr
from app.services import revisions
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.counters import next_key

PERF_GROUP = "performance"
ACTIVE = (PerfRunStatus.queued, PerfRunStatus.running)
FINISHED = (
    PerfRunStatus.passed,
    PerfRunStatus.failed,
    PerfRunStatus.stopped,
    PerfRunStatus.aborted,
    PerfRunStatus.error,
)
ENGINE_NAME = "Built-in load generator"
LOCATION = "Load is generated from the platform host, not from your users' locations."
KILL_SWITCH_TEXT = (
    "Stops by itself if the site looks overwhelmed: over 20 % errors, responses slower than 10 s, or no successful "
    "response for 5 s."
)
WHAT_IT_DOES = [
    "GET requests only: no forms, no sign-in, no data changes.",
    "Load comes from this platform's computer, not from your users' locations.",
    KILL_SWITCH_TEXT,
    "Real visitors may notice the site is slower while it runs. Use a test or staging copy if you can.",
]
G4_BLOCK = "Load profiles use the approved Test Strategy. Approve Gate 4 first."
REFUSE_NEEDS_COMMENT = "Say why this load test shouldn't run."
STATUS_LABELS = {
    PerfRunStatus.awaiting_approval: "Waiting for approval",
    PerfRunStatus.rejected: "Not approved",
    PerfRunStatus.expired: "Request expired",
    PerfRunStatus.queued: "Waiting to start",
    PerfRunStatus.running: "Running",
    PerfRunStatus.passed: "Finished · all thresholds met",
    PerfRunStatus.failed: "Finished · thresholds missed",
    PerfRunStatus.stopped: "Stopped",
    PerfRunStatus.aborted: "Stopped automatically",
    PerfRunStatus.error: "Didn't complete",
}


# ------------------------------------------------------------------ limits


async def org_ceiling(s: AsyncSession, org_id: uuid.UUID) -> LoadLimits:
    org = await s.get(Organisation, org_id)
    raw = ((org.settings if org else None) or {}).get("load_ceiling")
    return LoadLimits.from_dict(raw, DEFAULT_CEILING)


async def limits(ctx: AppContext, s: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    """{test?, organisation, server} as the UI's three columns (organisation = the effective ceiling)."""
    cap = ctx.settings.load_hard_cap
    ceiling = effective_ceiling(await org_ceiling(s, org_id), cap)
    return {"organisation": ceiling.as_dict(), "server": cap.as_dict(), "max_targets": MAX_TARGETS}


def _raise(violations: list[Violation]) -> None:
    if violations:
        raise ValidationFailed(
            violations[0].message, details=[{"field": v.field, "message": v.message} for v in violations]
        )


def check_profile(ctx: AppContext, ceiling: LoadLimits, snap: dict[str, Any]) -> list[Violation]:
    vus, rps, duration, targets = rules.numbers(snap)
    return profile_violations(
        vus=vus, rps=rps, duration_s=duration, targets=targets, ceiling=ceiling, cap=ctx.settings.load_hard_cap
    )


async def save_ceiling(
    ctx: AppContext, s: AsyncSession, org: Organisation, user: User, raw: dict[str, Any]
) -> dict[str, Any]:
    """`PATCH /organisations/{id}/settings {load_ceiling}` (owner/admin): within the hard cap, audited."""
    try:
        new = LoadLimits(vus=int(raw["vus"]), rps=int(raw["rps"]), duration_s=int(raw["duration_s"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise ValidationFailed("Enter whole numbers for users, requests a second and duration") from exc
    issues = ceiling_violations(new, ctx.settings.load_hard_cap)
    for v in issues:
        if v.message.startswith("The platform"):
            limit = getattr(ctx.settings.load_hard_cap, v.field)
            v_text = f"This server allows up to {duration_text(limit) if v.field == 'duration_s' else limit}."
            raise ValidationFailed(v_text, details=[{"field": v.field, "message": v_text}])
    _raise(issues)
    before = LoadLimits.from_dict((org.settings or {}).get("load_ceiling"), DEFAULT_CEILING)
    org.settings = {**(org.settings or {}), "load_ceiling": new.as_dict()}
    changes = [
        f"{label} {getattr(before, f)} → {getattr(new, f)}"
        for f, label in (("vus", "users"), ("rps", "requests a second"), ("duration_s", "seconds"))
        if getattr(before, f) != getattr(new, f)
    ]
    if changes:  # nothing is recorded when nothing changed
        audit(
            s,
            org_id=org.id,
            action="load_ceiling.changed",
            target_type="organisation",
            target_id=org.id,
            actor_user_id=user.id,
            metadata={"from": before.as_dict(), "to": new.as_dict(), "changes": ", ".join(changes)},
        )
    return new.as_dict()


# ------------------------------------------------------------------ targets and requirement thresholds


async def page_infos(s: AsyncSession, project_id: uuid.UUID) -> list[rules.PageInfo]:
    from app.db.models import DiscoveredPage, ScanSession

    drun = await applied_run(s, project_id, StageKey.discovery)
    if drun is None:
        return []
    scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == drun.id))).scalar_one_or_none()
    if scan is None:
        return []
    rows = (
        await s.execute(
            select(DiscoveredPage).where(DiscoveredPage.scan_session_id == scan.id).order_by(DiscoveredPage.sequence)
        )
    ).scalars()
    return [
        rules.PageInfo(
            page_id=str(p.id),
            url=p.final_url or p.url,
            status=p.http_status,
            page_type=p.page_type.value,
            requires_auth=p.requires_auth,
            title=p.title or "",
            visited=p.status.value == "visited",
        )
        for p in rows
    ]


async def requirement_limits(s: AsyncSession, project_id: uuid.UUID) -> dict[str, dict[str, Any]]:
    """page id -> {ms, key, lineage_id}: approved requirements that state a time, through their features' pages."""
    rrun = await applied_run(s, project_id, StageKey.requirements)
    if rrun is None:
        return {}
    reqs = (
        await s.execute(
            select(Requirement)
            .where(Requirement.stage_run_id == rrun.id, Requirement.status == RequirementStatus.approved)
            .order_by(Requirement.key)
        )
    ).scalars()
    found: dict[str, dict[str, Any]] = {}
    for r in reqs:
        # An assumed number (the rule-made "Pages load within 3 seconds" is a placeholder) never replaces the default
        # page threshold (design check 25); a requirement someone stated (document, user, observed) does.
        if r.provenance in (Provenance.assumed, Provenance.unverified):
            continue
        ms = rules.parse_threshold_ms(f"{r.title}. {r.description}")
        if ms is None or not r.feature_ids:
            continue
        feats = (
            await s.execute(
                select(ApplicationFeature).where(ApplicationFeature.id.in_([uuid.UUID(str(x)) for x in r.feature_ids]))
            )
        ).scalars()
        for f in feats:
            for pid in f.page_ids or []:
                prev = found.get(str(pid))
                if prev is None or ms < prev["ms"]:
                    found[str(pid)] = {"ms": ms, "key": r.key, "lineage_id": str(r.lineage_id)}
    return found


async def eligible_pages(s: AsyncSession, project: Project) -> list[dict[str, Any]]:
    """The "Add pages…" checklist: every discovered page, eligible or not (with the reason)."""
    _origin, host = await apr.target(s, project.id)
    return [
        {"page_id": p.page_id, "path": rules.path_of(p.url), "title": p.title, "reason": rules.eligible(p, host)}
        for p in await page_infos(s, project.id)
    ]


# ------------------------------------------------------------------ profiles


def snapshot(p: PerformanceProfile) -> dict[str, Any]:
    return {
        "name": p.name,
        "type": p.type.value,
        "stages": list(p.stages or []),
        "max_rps": p.max_rps,
        "think_time_ms": dict(p.think_time_ms or rules.DEFAULT_THINK),
        "targets": list(p.targets or []),
        "thresholds": list(p.thresholds or []),
    }


async def _record(
    s: AsyncSession, p: PerformanceProfile, user_id: uuid.UUID | None, reason: str, before: dict[str, Any] | None
) -> None:
    await revisions.record(
        s,
        org_id=p.organisation_id,
        project_id=p.project_id,
        entity_type="performance_profile",
        entity_id=p.id,
        lineage_id=p.id,
        version=p.version,
        snapshot={**snapshot(p), "status": p.status.value},
        changes=revisions.diff(before or {}, snapshot(p)),
        source="user" if user_id else "system",
        changed_by=user_id,
        change_reason=reason,
    )


async def draft_profile(
    ctx: AppContext, s: AsyncSession, project: Project, user: User, *, kind: PerfProfileType = PerfProfileType.load
) -> PerformanceProfile:
    """The Performance Testing Agent's rule path: a draft profile over the public discovered pages, default (or
    requirement) thresholds, within the organisation ceiling. Needs G4 (409 otherwise)."""
    from app.api.errors import GateBlocked
    from app.orchestrator.orchestrator import Orchestrator

    try:
        await Orchestrator(ctx).check_optional_upstream(s, project, StageKey.performance)
    except GateBlocked as exc:
        raise GateBlocked(G4_BLOCK) from exc
    _origin, host = await apr.target(s, project.id)
    ceiling = effective_ceiling(await org_ceiling(s, project.organisation_id), ctx.settings.load_hard_cap)
    targets = rules.select_targets(await page_infos(s, project.id), host)
    if not targets:
        raise ValidationFailed("Discovery found no public pages that can be loaded")
    thresholds = rules.thresholds_for(targets, await requirement_limits(s, project.id))
    _n, key = await next_key(s, project.organisation_id, project.id, "perf_profile")
    stages = rules.stages_for(kind, ceiling)
    name = "Load test of public pages" if kind == PerfProfileType.load else rules.TYPE_NAMES[kind]
    p = PerformanceProfile(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        name=name,
        type=kind,
        stages=stages,
        max_rps=min(20, ceiling.rps),
        think_time_ms=dict(rules.DEFAULT_THINK),
        targets=targets,
        thresholds=thresholds,
        status=PerfProfileStatus.draft,
        generated_by=GeneratedBy.rules,
        rationale=f"{len(targets)} public pages from discovery; start page weighted 3, listing pages 2, others 1.",
        created_by=user.id,
    )
    s.add(p)
    await s.flush()
    await _record(s, p, None, "Drafted by the Performance Testing Agent (rules)", None)
    audit(
        s,
        org_id=project.organisation_id,
        action="performance_profile.drafted",
        target_type="performance_profile",
        target_id=p.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": key, "targets": len(targets), "type": kind.value},
    )
    return p


EDITABLE = ("name", "stages", "max_rps", "think_time_ms", "targets", "thresholds")


def _validate_shape(
    ctx: AppContext,
    p: PerformanceProfile,
    data: dict[str, Any],
    eligible: dict[str, dict[str, Any]],
    req_limits: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Field rules of an edit (422 with field details). Requirement thresholds can be tightened only. When the
    targets change, per-page thresholds follow them: removed pages lose theirs, added pages get one as when drafting
    (the generator refuses a threshold on a page it doesn't load)."""
    new = snapshot(p)
    for k in EDITABLE:
        if k in data and data[k] is not None:
            new[k] = data[k]
    errors: list[dict[str, str]] = []
    stages = new["stages"]
    if not isinstance(stages, list) or not stages or len(stages) > 10:
        errors.append({"field": "stages", "message": "Add 1–10 stages"})
    else:
        for i, st in enumerate(stages):
            if int(st.get("duration_s", 0)) < 1 or int(st.get("target_vus", -1)) < 0:
                errors.append(
                    {"field": f"stages.{i}", "message": "Each stage needs a duration above 0 and 0 or more users"}
                )
    think = new["think_time_ms"] or {}
    if not 0 <= int(think.get("min", 0)) <= int(think.get("max", 0)) <= 60_000:
        errors.append(
            {"field": "think_time_ms", "message": "The pause must be 0–60 s, the first number not above the second"}
        )
    paths = [t.get("path") for t in new["targets"]]
    if len(paths) > MAX_TARGETS:
        errors.append({"field": "targets", "message": f"A profile can load at most {MAX_TARGETS} pages."})
    for t in new["targets"]:
        e = eligible.get(str(t.get("path")))
        if e is None or e["reason"] is not None:
            errors.append(
                {
                    "field": "targets",
                    "message": f"{t.get('path')} can't be loaded: "
                    f"{(e or {}).get('reason') or 'discovery did not visit it'}",
                }
            )
        elif not 1 <= int(t.get("weight", 1)) <= 10:
            errors.append({"field": "targets", "message": "Weights are 1–10"})
        else:
            t["page_id"] = e["page_id"]
    if "targets" in data and not errors:
        per_page = {th.get("path") for th in new["thresholds"] if th.get("scope") == "path"}
        kept = [th for th in new["thresholds"] if th.get("scope") != "path" or th.get("path") in paths]
        added = [th for th in rules.thresholds_for(new["targets"], req_limits) if th.get("scope") == "path"]
        new["thresholds"] = [
            *[th for th in kept if th.get("scope") == "path"],
            *[th for th in added if th["path"] not in per_page],
            *[th for th in kept if th.get("scope") != "path"],
        ]
    old_req = {
        (th.get("path"), th["metric"]): th
        for th in p.thresholds or []
        if (th.get("source") or {}).get("type") == "requirement"
    }
    new_th = {(th.get("path"), th.get("metric")): th for th in new["thresholds"]}
    for k_, th in old_req.items():
        n = new_th.get(k_)
        if (n is None and k_[0] in paths) or (n is not None and float(n.get("value", 0)) > float(th["value"])):
            errors.append(
                {
                    "field": "thresholds",
                    "message": f"This threshold comes from {th['source']['key']}. Change the requirement to change it.",
                }
            )
        elif n is not None:
            n["source"] = th["source"]
    for th in new["thresholds"]:
        th.setdefault("source", {"type": "default"})
        if th.get("metric") not in ("p95", "p99", "error_rate") or th.get("op", "<") not in ("<", "<="):
            errors.append({"field": "thresholds", "message": "Unknown threshold"})
        th["op"] = th.get("op", "<")
    if errors:
        raise ValidationFailed(errors[0]["message"], details=errors)
    return new


async def update_profile(
    ctx: AppContext, s: AsyncSession, p: PerformanceProfile, user: User, data: dict[str, Any], version: int
) -> PerformanceProfile:
    """An edit creates a new version (older ones stay readable as revisions). 422 naming the exceeded limit."""
    if p.version != version:
        raise Conflict("Someone else changed this profile; reload to continue", details={"version": p.version})
    if p.status == PerfProfileStatus.retired:
        raise Conflict(f"{p.key} is retired")
    project = await s.get(Project, p.project_id)
    assert project is not None
    eligible = {e["path"]: e for e in await eligible_pages(s, project)}
    new = _validate_shape(ctx, p, data, eligible, await requirement_limits(s, p.project_id))
    ceiling = await org_ceiling(s, p.organisation_id)
    _raise(check_profile(ctx, ceiling, new))
    before = snapshot(p)
    for k in EDITABLE:
        setattr(p, k, new[k])
    if p.status == PerfProfileStatus.stale:
        p.status = PerfProfileStatus.draft
        p.stale_reason = None
    await s.flush()  # bumps the version (version_id_col)
    await _record(s, p, user.id, "Edited", before)
    audit(
        s,
        org_id=p.organisation_id,
        action="performance_profile.updated",
        target_type="performance_profile",
        target_id=p.id,
        actor_user_id=user.id,
        project_id=p.project_id,
        metadata={"key": p.key, "version": p.version},
    )
    return p


async def set_profile_status(
    ctx: AppContext, s: AsyncSession, p: PerformanceProfile, user: User, status: str
) -> PerformanceProfile:
    if p.status == PerfProfileStatus.retired:
        raise Conflict(f"{p.key} is retired")
    if status == "ready":
        _raise(check_profile(ctx, await org_ceiling(s, p.organisation_id), snapshot(p)))
        p.status = PerfProfileStatus.ready
        p.stale_reason = None
    else:
        p.status = PerfProfileStatus.retired
    await s.flush()
    await _record(s, p, user.id, "Marked ready" if status == "ready" else "Retired", snapshot(p))
    audit(
        s,
        org_id=p.organisation_id,
        action=f"performance_profile.{status}",
        target_type="performance_profile",
        target_id=p.id,
        actor_user_id=user.id,
        project_id=p.project_id,
        metadata={"key": p.key},
    )
    return p


# ------------------------------------------------------------------ run requests and approvals


async def request_run(
    ctx: AppContext, s: AsyncSession, project: Project, user: User, p: PerformanceProfile, *, note: str | None
) -> tuple[PerformanceRun, Approval]:
    """PERF-0001 `awaiting_approval` with a frozen snapshot, and its pending `load_test` approval. Sends nothing."""
    if p.status != PerfProfileStatus.ready:
        raise Conflict(f"Mark {p.key} ready first.")
    ceiling = await org_ceiling(s, project.organisation_id)
    snap = snapshot(p)
    _raise(check_profile(ctx, ceiling, snap))
    origin, host = await apr.target(s, project.id)
    netloc = origin.split("://", 1)[1]
    lim = await limits(ctx, s, project.organisation_id)
    vus, rps, duration, ntargets = rules.numbers(snap)
    snap.update(
        {
            "profile_key": p.key,
            "profile_version": p.version,
            "origin": origin,
            "host": host,
            "netloc": netloc,
            "summary": rules.summary_sentence(snap, netloc),
            "expected_requests": rules.expected_requests(snap),
            "limits": {"test": {"vus": vus, "rps": rps, "duration_s": duration}, **lim},
        }
    )
    _n, key = await next_key(s, project.organisation_id, project.id, "perf_run")
    run = PerformanceRun(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        profile_id=p.id,
        profile_snapshot=snap,
        profile_hash=rules.profile_hash(snap),
        status=PerfRunStatus.awaiting_approval,
        requested_by=user.id,
        engine={"name": "ata-loadgen", "version": None},
        metrics={"note": (note or "").strip()[:500] or None},
    )
    s.add(run)
    await s.flush()
    _n2, akey = await next_key(s, project.organisation_id, project.id, "approval")
    a = Approval(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=akey,
        kind=ApprovalKind.load_test,
        performance_run_id=run.id,
        scope={
            "target_origin": origin,
            "target_host": host,
            "run_key": key,
            "profile_key": p.key,
            "profile_version": p.version,
            "summary": snap["summary"],
            "limits": snap["limits"],
            "targets": ntargets,
            "expected_requests": snap["expected_requests"],
            "note": run.metrics.get("note"),
        },
        requested_by=user.id,
        status=ApprovalStatus.pending,
        expires_at=utcnow() + apr.APPROVAL_TTL,
    )
    s.add(a)
    await s.flush()
    run.approval_id = a.id
    audit(
        s,
        org_id=project.organisation_id,
        action="performance_run.requested",
        target_type="performance_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={
            "key": key,
            "profile": p.key,
            "version": p.version,
            "approval": akey,
            "vus": vus,
            "rps": rps,
            "duration_s": duration,
        },
    )
    return run, a


async def request_problem(ctx: AppContext, s: AsyncSession, run: PerformanceRun) -> str | None:
    """Why a waiting request can't be approved as it was made (design §9.4), or None."""
    p = await s.get(PerformanceProfile, run.profile_id)
    snap = run.profile_snapshot or {}
    if p is None or p.status == PerfProfileStatus.retired:
        return f"{snap.get('profile_key')} was retired"
    if (
        p.version != snap.get("profile_version")
        or rules.profile_hash({**snapshot(p), "origin": snap.get("origin")}) != run.profile_hash
    ):
        return f"{p.key} changed to version {p.version}"
    issues = check_profile(ctx, await org_ceiling(s, run.organisation_id), snap)
    if issues:
        v = issues[0]
        lim = await limits(ctx, s, run.organisation_id)
        if v.field in ("vus", "rps", "duration_s"):
            org_v = lim["organisation"][v.field]
            words = {"vus": f"{org_v} users", "rps": f"{org_v} requests a second", "duration_s": duration_text(org_v)}
            return f"your organisation's limit is now {words[v.field]}"
        return v.message
    return None


async def _approval(s: AsyncSession, run: PerformanceRun) -> Approval | None:
    return (await s.execute(select(Approval).where(Approval.performance_run_id == run.id))).scalar_one_or_none()


async def expire(s: AsyncSession, run: PerformanceRun) -> bool:
    """A waiting request whose approval passed 24 h becomes `expired` (nothing was sent)."""
    if run.status != PerfRunStatus.awaiting_approval:
        return False
    a = await _approval(s, run)
    if a is None:
        return False
    if await apr.expire_due(s, [a]):
        run.status = PerfRunStatus.expired
        run.finished_at = utcnow()
        return True
    return a.status == ApprovalStatus.expired and _set(run, PerfRunStatus.expired)


def _set(run: PerformanceRun, status: PerfRunStatus) -> bool:
    run.status = status
    run.finished_at = run.finished_at or utcnow()
    return True


async def decide(
    ctx: AppContext,
    s: AsyncSession,
    a: Approval,
    user: User,
    *,
    decision: str,
    comment: str | None,
    confirm_text: str | None,
) -> PerformanceRun:
    """D18: approve (host typed, re-checked against the current ceiling and hard cap) or refuse (comment needed)."""
    run = await s.get(PerformanceRun, a.performance_run_id) if a.performance_run_id else None
    if run is None:
        raise Conflict("This approval has no load test")
    if await expire(s, run):
        raise Conflict(
            f"{a.key} expired after 24 hours. Nothing was sent to the site. Request it again.",
            details={"status": "expired"},
        )
    if run.status != PerfRunStatus.awaiting_approval:
        raise Conflict(f"{run.key} has already been decided", details={"status": run.status.value})
    host = str((a.scope or {}).get("target_host") or "")
    if decision == "reject" and not (comment or "").strip():
        raise ValidationFailed(REFUSE_NEEDS_COMMENT, details=[{"field": "comment", "message": REFUSE_NEEDS_COMMENT}])
    if decision == "approve":
        if not apr.confirm_matches(confirm_text, host):
            msg = f"Type {host} exactly to approve."
            raise ValidationFailed(msg, details=[{"field": "confirm_text", "message": msg}])
        problem = await request_problem(ctx, s, run)
        if problem is not None:
            raise Conflict(
                f"This request can't be approved as it was made: {problem}. Request it again.",
                details={"reason": problem},
            )
    await apr.decide(s, a, decision=decision, comment=comment, confirm_text=confirm_text, user=user)
    if decision == "approve":
        a.scope = {**(a.scope or {}), "host_typed": True, "self_approved": a.requested_by == user.id}
        run.status = PerfRunStatus.queued
    else:
        run.status = PerfRunStatus.rejected
        run.finished_at = utcnow()
    audit(
        s,
        org_id=run.organisation_id,
        action=f"performance_run.{'approved' if decision == 'approve' else 'rejected'}",
        target_type="performance_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=run.project_id,
        metadata={"key": run.key, "approval": a.key, "host_typed": "yes" if decision == "approve" else None},
    )
    return run


async def withdraw(s: AsyncSession, run: PerformanceRun, user: User) -> None:
    if run.status != PerfRunStatus.awaiting_approval:
        raise Conflict(f"{run.key} isn't waiting for approval")
    if run.requested_by != user.id:
        raise Forbidden("Only the person who requested this load test can withdraw it")
    a = await _approval(s, run)
    if a is not None and a.status == ApprovalStatus.pending:
        a.status = ApprovalStatus.rejected
        a.comment = "Request withdrawn"
        a.decided_by, a.decided_at = user.id, utcnow()
    run.status = PerfRunStatus.rejected
    run.finished_at = utcnow()
    run.metrics = {**(run.metrics or {}), "withdrawn": True}
    audit(
        s,
        org_id=run.organisation_id,
        action="performance_run.withdrawn",
        target_type="performance_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=run.project_id,
        metadata={"key": run.key},
    )


async def stop(
    ctx: AppContext, s: AsyncSession, project: Project, run: PerformanceRun, user: User, *, approver: bool
) -> str:
    """Requester or any approver. A queued run stops at once; a running one within 2 s (the job polls the flag)."""
    if not approver and run.requested_by != user.id:
        raise Forbidden("Only the person who requested this load test or someone who can approve can stop it")
    if run.status not in ACTIVE:
        raise Conflict(f"{run.key} isn't running")
    # One conditional UPDATE of `stopped_by` alone (the job's stop signal): it never races the job's progress writes
    # to `metrics`, and it can't mark a run that finished in the meantime.
    done: CursorResult[Any] = await s.execute(  # type: ignore[assignment]
        update(PerformanceRun)
        .where(PerformanceRun.id == run.id, PerformanceRun.status.in_(ACTIVE))
        .values(stopped_by=user.id)
        .execution_options(synchronize_session=False)
    )
    if not done.rowcount:
        raise Conflict(f"{run.key} isn't running")
    set_committed_value(run, "stopped_by", user.id)
    if run.status == PerfRunStatus.queued:
        run.status = PerfRunStatus.stopped
        run.finished_at = utcnow()
        from app.orchestrator.orchestrator import Orchestrator

        await Orchestrator(ctx).mirror_nonfunctional(
            s, project, StageKey.performance, run, PERF_RUN_STAGE_STATUS[run.status]
        )
    audit(
        s,
        org_id=run.organisation_id,
        action="performance_run.stopped",
        target_type="performance_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=run.project_id,
        metadata={"key": run.key},
    )
    return f"{run.key} stopped."


async def enqueue(ctx: AppContext, run: PerformanceRun) -> None:
    await ctx.queue.enqueue(
        "performance_run",
        {"run_id": str(run.id)},
        org_id=run.organisation_id,
        project_id=run.project_id,
        dedupe_key=f"performance_run:{run.id}",
        concurrency_group=PERF_GROUP,
        max_attempts=1,
    )


# ------------------------------------------------------------------ reads


def status_label(run: PerformanceRun, names: dict[uuid.UUID, str]) -> str:
    if run.status == PerfRunStatus.failed:
        tr = run.threshold_results or []
        missed = sum(1 for r in tr if r.get("result") == "missed")
        return f"Finished · {missed} of {len(tr)} thresholds missed"
    if run.status == PerfRunStatus.stopped:
        return f"Stopped by {names.get(run.stopped_by, 'someone') if run.stopped_by else 'the platform'}"
    if run.status == PerfRunStatus.rejected and (run.metrics or {}).get("withdrawn"):
        return "Request withdrawn"
    return STATUS_LABELS[run.status]


def _elapsed(run: PerformanceRun) -> int | None:
    if run.started_at is None:
        return None
    end = run.finished_at or utcnow()
    return int((_aware(end) - _aware(run.started_at)).total_seconds())


def _aware(d: datetime) -> datetime:
    from datetime import UTC

    return d if d.tzinfo is not None else d.replace(tzinfo=UTC)


async def run_dict(
    ctx: AppContext,
    s: AsyncSession,
    run: PerformanceRun,
    *,
    viewer: User,
    approver: bool,
    member: bool,
    see_email: bool,
    full: bool = False,
) -> dict[str, Any]:
    a = await _approval(s, run)
    us = await out.users(s, [x for x in (run.requested_by, run.stopped_by, a.decided_by if a else None) if x])
    names = {k: (u.full_name or u.email) for k, u in us.items()}
    snap = run.profile_snapshot or {}
    problem = await request_problem(ctx, s, run) if run.status == PerfRunStatus.awaiting_approval else None
    metrics = dict(run.metrics or {})
    d: dict[str, Any] = {
        "id": run.id,
        "key": run.key,
        "status": run.status.value,
        "status_label": status_label(run, names),
        "profile": {
            "id": run.profile_id,
            "key": snap.get("profile_key"),
            "version": snap.get("profile_version"),
            "name": snap.get("name"),
            "type": snap.get("type"),
        },
        "summary": snap.get("summary"),
        "expected_requests": snap.get("expected_requests"),
        "expected_requests_text": rules.rounded(int(snap.get("expected_requests") or 0)),
        "limits": snap.get("limits"),
        "target_host": snap.get("host"),
        "netloc": snap.get("netloc"),
        "requested_by": out.person(us.get(run.requested_by), see_email=see_email) if run.requested_by else None,
        "stopped_by": out.person(us.get(run.stopped_by), see_email=see_email) if run.stopped_by else None,
        "note": metrics.get("note"),
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "elapsed_s": _elapsed(run),
        "planned_s": rules.numbers(snap)[2] if snap.get("stages") else None,
        "engine": run.engine or {},
        "aborted_reason": run.aborted_reason,
        "error": run.error,
        "threshold_results": run.threshold_results or [],
        "live": metrics.get("live"),
        "stop_requested": run.stopped_by is not None,
        "problem": problem,
        "approval": {
            "id": a.id,
            "key": a.key,
            "status": a.status.value,
            "expires_at": a.expires_at,
            "decided_by": out.person(us.get(a.decided_by), see_email=see_email) if a.decided_by else None,
            "decided_at": a.decided_at,
            "comment": a.comment,
            "host_typed": bool((a.scope or {}).get("host_typed")),
            "confirm_prompt": f"Type {snap.get('host')} to approve",
        }
        if a
        else None,
        "permissions": {
            "can_approve": approver and run.status == PerfRunStatus.awaiting_approval and problem is None,
            "can_stop": run.status in ACTIVE and (approver or run.requested_by == viewer.id),
            "can_withdraw": run.status == PerfRunStatus.awaiting_approval and run.requested_by == viewer.id,
            "can_request_again": member and run.status not in (PerfRunStatus.queued, PerfRunStatus.running),
        },
        "statement": f"Measured with the built-in load generator {(run.engine or {}).get('version') or ''}. {LOCATION}".replace(
            "  ", " "
        ),
        "what_it_does": WHAT_IT_DOES,
    }
    if full:
        d["profile_snapshot"] = {
            k: snap.get(k) for k in ("targets", "stages", "max_rps", "think_time_ms", "thresholds")
        }
        d["result"] = {
            k: metrics.get(k)
            for k in ("overall", "targets", "status_codes", "duration_s", "generator_location")
            if k in metrics
        }
        d["timeseries"] = metrics.get("timeseries") or []
        from app.services.hardening import removed_text

        gone = metrics.get("timeseries_removed_at")
        d["timeseries_removed"] = removed_text(datetime.fromisoformat(gone)) if gone else None
        d["previous"] = await previous_run(s, run)
        drafts = (await s.execute(select(Defect).where(Defect.project_id == run.project_id))).scalars()
        # Drafted by this run, or given an occurrence by it (P5-BUG-06), like Phase 4 runs.
        d["defects"] = []
        for x in drafts:
            env = x.environment or {}
            if env.get("run_key") == run.key:
                d["defects"].append({"key": x.key, "summary": x.summary, "status": x.status.value, "link": "drafted"})
            elif any(o.get("run_key") == run.key for o in env.get("occurrences") or []):
                d["defects"].append(
                    {"key": x.key, "summary": x.summary, "status": x.status.value, "link": "occurrence_added"}
                )
    return d


async def previous_run(s: AsyncSession, run: PerformanceRun) -> dict[str, Any] | None:
    """The previous finished run of the same profile, for "vs previous run" deltas."""
    prev = (
        await s.execute(
            select(PerformanceRun)
            .where(
                PerformanceRun.project_id == run.project_id,
                PerformanceRun.profile_id == run.profile_id,
                PerformanceRun.status.in_([PerfRunStatus.passed, PerfRunStatus.failed]),
                PerformanceRun.created_at < run.created_at,
            )
            .order_by(PerformanceRun.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if prev is None:
        return None
    return {"key": prev.key, "threshold_results": prev.threshold_results or []}


async def profile_dict(ctx: AppContext, s: AsyncSession, p: PerformanceProfile, *, see_email: bool) -> dict[str, Any]:
    ceiling = await org_ceiling(s, p.organisation_id)
    issues = check_profile(ctx, ceiling, snapshot(p))
    vus, rps, duration, ntargets = rules.numbers(snapshot(p))
    us = await out.users(s, [p.created_by] if p.created_by else [])
    hist = await revisions.history(s, "performance_profile", p.id)
    origin, host = await apr.target(s, p.project_id)
    netloc = origin.split("://", 1)[1]
    return {
        "id": p.id,
        "key": p.key,
        "name": p.name,
        "type": p.type.value,
        "type_label": rules.TYPE_NAMES[p.type],
        "status": p.status.value,
        "stale_reason": p.stale_reason,
        "version": p.version,
        "versions": sorted({h.version for h in hist}, reverse=True),
        "generated_by": p.generated_by.value,
        "rationale": p.rationale,
        "stages": p.stages or [],
        "max_rps": p.max_rps,
        "think_time_ms": p.think_time_ms or rules.DEFAULT_THINK,
        "targets": p.targets or [],
        "thresholds": p.thresholds or [],
        "totals": {"vus": vus, "rps": rps, "duration_s": duration, "targets": ntargets},
        "violations": [{"field": v.field, "message": v.message} for v in issues],
        # What a request would say (design §9.3: the summary sentence is server-computed and shown verbatim).
        "request_preview": {
            "summary": rules.summary_sentence(snapshot(p), netloc),
            "expected_requests_text": rules.rounded(rules.expected_requests(snapshot(p))),
            "host": host,
            "netloc": netloc,
            "what_it_does": WHAT_IT_DOES,
        },
        "created_by": out.person(us.get(p.created_by), see_email=see_email) if p.created_by else None,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    }


async def old_version(s: AsyncSession, p: PerformanceProfile, version: int) -> dict[str, Any] | None:
    for h in await revisions.history(s, "performance_profile", p.id):
        if h.version == version:
            return dict(h.snapshot or {})
    return None
