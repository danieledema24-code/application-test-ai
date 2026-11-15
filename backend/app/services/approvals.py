"""Run scope and approvals for risky actions (P4-05, decision D12; design P4 §7, open questions 1–3).

`run_scope` resolves a selection to the runnable scripts of the current bundle and computes what the run may do on
the site (the G7 authorisation summary), which cases are left out and why, and which separate approvals it needs.
It is a read: nothing is created and the target is never contacted. P4-06 stores it on the run request.

Approvals: one `approvals` row per risky kind (`external_transaction`, `destructive`) of a run request, pending for
24 hours, decided by `can_approve` with the target host typed to confirm (both kinds), single use (`used` when the
run starts). A run can't be authorised or started while one of its approvals is undecided; a rejected approval
skips its cases ("Not approved: external transaction"), not the run. Run requests without approvals expire after
7 days, and any script change invalidates a waiting request.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, GateBlocked, ValidationFailed
from app.db.models import (
    Approval,
    AutomationAssessment,
    AutomationScript,
    ExecutionRun,
    Project,
    ProjectUrl,
    User,
)
from app.db.types import utcnow
from app.domain.automation import side_effects as fx
from app.domain.enums import (
    ApprovalKind,
    ApprovalStatus,
    AutomationSuitability,
    RunStatus,
    ScriptStatus,
    StageKey,
    UrlRole,
)
from app.security.ssrf import normalise_url
from app.services import automation as svc
from app.services.audit import audit
from app.services.counters import next_key

# G7 summary line for tests that need a saved test login that isn't there (design §7.1 "Left out / blocked").
BLOCKED_LINE = "Will be blocked: no saved test login"
APPROVAL_TTL = timedelta(hours=24)
REQUEST_TTL = timedelta(days=7)
MAX_TESTS = 300
BROWSERS = ("chromium", "firefox", "webkit")
VIEWPORTS = {"desktop": {"width": 1440, "height": 900}, "mobile": {"width": 390, "height": 844}}
SECONDS_PER_TEST = 12  # estimate only (design §7.2 "about 4 minutes")
WORKERS = 2
KIND_WORDS = {
    ApprovalKind.external_transaction: "external transaction",
    ApprovalKind.destructive: "destructive action",
}
SKIP_REASONS = {
    ApprovalKind.external_transaction: "Not approved: external transaction",
    ApprovalKind.destructive: "Not approved: destructive action",
}


# ------------------------------------------------------------------ browsers


def installed_browsers() -> dict[str, bool]:
    """Which Playwright browsers are installed on this server (D7: Firefox and WebKit only when installed)."""
    env = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    roots = [Path(env)] if env and env != "0" else []
    roots += [Path.home() / "Library" / "Caches" / "ms-playwright", Path.home() / ".cache" / "ms-playwright"]
    found = dict.fromkeys(BROWSERS, False)
    for root in roots:
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            for b in BROWSERS:
                if entry.name.startswith(f"{b}-") or (b == "chromium" and entry.name.startswith("chromium_headless")):
                    found[b] = True
    return found


# ------------------------------------------------------------------ scope


async def target(s: AsyncSession, project_id: uuid.UUID) -> tuple[str, str]:
    """(origin, host) of the G1-approved site."""
    url = (
        await s.execute(
            select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
        )
    ).scalar_one()
    n = normalise_url((url.last_check or {}).get("final_url") or url.url)
    return n.origin, n.host


def _left(key: str, title: str, reason: str, code: str) -> dict[str, Any]:
    return {"key": key, "title": title, "reason": reason, "code": code}


async def run_scope(
    s: AsyncSession,
    project: Project,
    *,
    suite: str | None = None,
    case_keys: list[str] | None = None,
    browsers: list[str] | None = None,
    viewports: list[str] | None = None,
) -> dict[str, Any]:
    """The scope of a run request (design §7.1–7.3). Raises ValidationFailed for an unknown suite, browser or size."""
    browsers = list(dict.fromkeys(browsers or ["chromium"]))
    viewports = list(dict.fromkeys(viewports or ["desktop"]))
    installed = installed_browsers()
    if any(b not in BROWSERS for b in browsers) or not browsers:
        raise ValidationFailed("Choose Chromium, Firefox or WebKit")
    missing = [b for b in browsers if b != "chromium" and not installed.get(b)]
    if missing:
        raise ValidationFailed(f"{missing[0].capitalize()} is not installed on this server")
    if any(v not in VIEWPORTS for v in viewports) or not viewports:
        raise ValidationFailed("Choose Desktop or Mobile")
    if suite is not None and suite not in ("smoke", "regression", "all_approved"):
        raise ValidationFailed("Choose Smoke, Regression, All automated or specific test cases")
    origin, host = await target(s, project.id)
    _decision, cases = await svc.approved_cases(s, project.id)
    bundle = await svc.current_run(s, project.id, StageKey.automation)
    scripts: dict[str, AutomationScript] = {}
    if bundle is not None:
        for x in (await svc.bundle_rows(s, bundle.id))[0]:
            scripts[str(x.case_lineage_id)] = x
    arun = await svc.current_run(s, project.id, StageKey.automation_assessment)
    assessments: dict[str, AutomationAssessment] = {}
    if arun is not None:
        for row in (
            await s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == arun.id))
        ).scalars():
            assessments[str(row.case_lineage_id)] = row
    site = await svc.site_model(s, project.id, [c.row for c in cases])
    wanted = set(case_keys or [])
    unknown = sorted(wanted - {c.case.key for c in cases})
    if unknown:
        raise ValidationFailed(f"{', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} not an approved test case")
    chosen: list[dict[str, Any]] = []
    left_out: list[dict[str, Any]] = []
    per_case: dict[str, fx.CaseEffects] = {}
    blocked: list[dict[str, Any]] = []
    for c in cases:
        key, title = c.case.key, c.case.title
        if case_keys is not None:
            if key not in wanted:
                continue
        elif suite in ("smoke", "regression") and suite not in c.case.suites:
            continue
        script = scripts.get(c.case.lineage_id)
        a = assessments.get(c.case.lineage_id)
        if script is None:
            if a is not None and a.suitability == AutomationSuitability.manual_only:
                left_out.append(_left(key, title, "needs a person", "manual_only"))
            else:
                left_out.append(_left(key, title, "no script yet", "no_script"))
            continue
        state = svc.script_state(script)
        if state == "outdated" or script.case_version != c.case.version:
            left_out.append(_left(key, title, "script is outdated", "outdated"))
            continue
        if state == "needs_review":
            left_out.append(_left(key, title, "script needs review (Gate 6)", "needs_review"))
            continue
        if state == "rejected":
            fallback = await svc.rules_fallback(s, script)
            if fallback is None:
                left_out.append(_left(key, title, "script rejected in review", "rejected"))
                continue
            script, state = fallback, "valid"
        if state == "invalid":
            left_out.append(_left(key, title, "script can't run", "invalid"))
            continue
        if state != "valid":
            left_out.append(_left(key, title, "script not checked yet", "not_checked"))
            continue
        model = a.step_model if a is not None else {}
        effects = fx.effects_of(model or {}, site)
        partial = a is not None and a.suitability == AutomationSuitability.partial
        if not partial:
            # A blocked test never runs, so it neither signs in nor submits anything (QA P4-BUG-07).
            per_case[key] = effects
        item = {
            "key": key,
            "title": title,
            "test_case_id": str(c.row.id),
            "case_lineage_id": c.case.lineage_id,
            "script_id": str(script.id),
            "script_version": script.version,
            "sha256": script.sha256,
            "path": script.path,
            "side_effects": effects.as_list(),
            "needs_approval": [] if partial else effects.needs_approval,
            "signs_in": any(e.kind == fx.SIGNS_IN for e in effects.effects),
            "retried": not effects.needs_approval,
            "blocked": "Needs saved test credentials" if partial else None,
        }
        chosen.append(item)
        if partial:
            blocked.append({"key": key, "title": title, "reason": "Needs saved test credentials"})
    names = {f.anchor: f.name for f in site.forms}
    lines = fx.summary_lines(per_case, names)
    if blocked:
        keys = sorted(b["key"] for b in blocked)
        lines.append({"kind": "blocked", "form": None, "text": BLOCKED_LINE, "count": len(keys), "case_keys": keys})
    approvals: list[dict[str, Any]] = []
    for kind in fx.NEEDS_APPROVAL:
        affected = [i for i in chosen if kind in i["needs_approval"]]
        if not affected:
            continue
        quotes = []
        for i in affected:
            e = next(e for e in per_case[i["key"]].effects if e.kind == kind)
            quotes.append({"key": i["key"], "title": i["title"], "step": e.step, "quote": e.quote})
        approvals.append(
            {"kind": kind, "title": fx.APPROVAL_TITLES[kind], "case_keys": [i["key"] for i in affected],
             "cases": quotes}
        )  # fmt: skip
    tests = len(chosen) * len(browsers) * len(viewports)
    runnable_tests = (len(chosen) - len(blocked)) * len(browsers) * len(viewports)
    over = tests > MAX_TESTS
    seconds = -(-max(runnable_tests, 0) * SECONDS_PER_TEST // WORKERS)
    not_retried = [i["key"] for i in chosen if not i["retried"]]
    scope: dict[str, Any] = {
        "target_origin": origin,
        "target_host": host,
        "selection": {"suite": suite, "case_keys": sorted(wanted) if case_keys is not None else None},
        "browsers": browsers,
        "viewports": viewports,
        "viewport_sizes": {v: VIEWPORTS[v] for v in viewports},
        "bundle_version": bundle.version if bundle else None,
        "cases": chosen,
        "left_out": left_out,
        "blocked": blocked,
        "tests": tests,
        "limit": MAX_TESTS,
        "over_limit": over,
        "limit_message": (
            f"A run can include up to {MAX_TESTS} tests. This selection makes {tests} ({len(chosen)} cases × "
            f"{len(browsers) * len(viewports)} browser and screen size combinations). Choose fewer cases or one "
            "screen size."
        )
        if over
        else None,
        "estimated_seconds": seconds,
        "side_effects": lines,
        "risky": "yes" if approvals else "no",
        "risky_line": None if approvals else "Pays, buys or deletes anything: no",
        "approvals_needed": approvals,
        "signs_in": any(i["signs_in"] for i in chosen),
        "not_retried": not_retried,
        "installed_browsers": installed,
    }
    scope["scope_hash"] = scope_hash(scope)
    return scope


async def script_effects(
    s: AsyncSession, project_id: uuid.UUID, scripts: list[AutomationScript]
) -> dict[str, fx.CaseEffects]:
    """Possible side effects per script path, from each case's step model, as `run_scope` computes them (used by the
    export to keep the platform's retry and trace rules)."""
    _decision, cases = await svc.approved_cases(s, project_id)
    arun = await svc.current_run(s, project_id, StageKey.automation_assessment)
    models: dict[str, dict[str, Any]] = {}
    if arun is not None:
        for row in (
            await s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == arun.id))
        ).scalars():
            models[str(row.case_lineage_id)] = dict(row.step_model or {})
    site = await svc.site_model(s, project_id, [c.row for c in cases])
    return {x.path: fx.effects_of(models.get(str(x.case_lineage_id), {}), site) for x in scripts}


def scope_hash(scope: dict[str, Any]) -> str:
    """What G7 authorises: the target, browsers, sizes and each script version (sha) in the run."""
    basis = {
        "target": scope.get("target_origin"),
        "browsers": scope.get("browsers"),
        "viewports": scope.get("viewports"),
        "scripts": sorted((i["script_id"], i["sha256"]) for i in scope.get("cases", [])),
        "approvals": [(a["kind"], a["case_keys"]) for a in scope.get("approvals_needed", [])],
    }
    return hashlib.sha256(json.dumps(basis, sort_keys=True).encode()).hexdigest()


# ------------------------------------------------------------------ approvals


async def request_approvals(
    s: AsyncSession, project: Project, run: ExecutionRun, *, requested_by: uuid.UUID | None
) -> list[Approval]:
    """One pending approval per risky kind in the run's scope (24 h). Called when a run request is created."""
    out: list[Approval] = []
    now = utcnow()
    for need in (run.scope or {}).get("approvals_needed", []):
        kind = ApprovalKind(need["kind"])
        _n, key = await next_key(s, project.organisation_id, project.id, "approval")
        row = Approval(
            organisation_id=project.organisation_id,
            project_id=project.id,
            key=key,
            kind=kind,
            execution_run_id=run.id,
            scope={
                "case_keys": list(need["case_keys"]),
                "cases": list(need.get("cases") or []),
                "target_origin": (run.scope or {}).get("target_origin"),
                "target_host": (run.scope or {}).get("target_host"),
                "side_effects": [kind.value],
                "run_key": run.key,
            },
            requested_by=requested_by,
            status=ApprovalStatus.pending,
            expires_at=now + APPROVAL_TTL,
        )
        s.add(row)
        await s.flush()
        audit(s, org_id=project.organisation_id, action="approval.requested", target_type="approval",
              target_id=row.id, actor_user_id=requested_by, project_id=project.id,
              metadata={"key": key, "kind": kind.value, "run": run.key, "cases": len(need["case_keys"])})  # fmt: skip
        out.append(row)
    return out


async def run_approvals(s: AsyncSession, run_id: uuid.UUID) -> list[Approval]:
    return list(
        (await s.execute(select(Approval).where(Approval.execution_run_id == run_id).order_by(Approval.key))).scalars()
    )


async def expire_due(s: AsyncSession, approvals: list[Approval], *, now: datetime | None = None) -> list[Approval]:
    """Pending approvals past their 24 h become `expired` (audited)."""
    now = now or utcnow()
    expired = []
    for a in approvals:
        if a.status == ApprovalStatus.pending and _aware(a.expires_at) <= _aware(now):
            a.status = ApprovalStatus.expired
            audit(s, org_id=a.organisation_id, action="approval.expired", target_type="approval", target_id=a.id,
                  project_id=a.project_id, metadata={"key": a.key, "kind": a.kind.value})  # fmt: skip
            expired.append(a)
    return expired


def _aware(d: datetime) -> datetime:
    from datetime import UTC

    return d if d.tzinfo is not None else d.replace(tzinfo=UTC)


def confirm_matches(typed: str | None, host: str) -> bool:
    """Typed confirmation: the target host, trimmed, case-insensitive (design §7.3)."""
    return (typed or "").strip().lower() == host.strip().lower()


async def decide(
    s: AsyncSession,
    approval: Approval,
    *,
    decision: str,
    comment: str | None,
    confirm_text: str | None,
    user: User,
) -> Approval:
    """Approve (typed host required, both kinds; open question 2) or reject. Pending only, before expiry."""
    await expire_due(s, [approval])
    if approval.status == ApprovalStatus.expired:
        raise Conflict(f"{approval.key} expired after 24 hours. Request the run again.", details={"status": "expired"})
    if approval.status != ApprovalStatus.pending:
        raise Conflict(f"{approval.key} has already been decided", details={"status": approval.status.value})
    if decision not in ("approve", "reject"):
        raise ValidationFailed("Choose approve or reject")
    host = str((approval.scope or {}).get("target_host") or "")
    if decision == "approve" and not confirm_matches(confirm_text, host):
        raise ValidationFailed(
            f"Type {host} exactly to confirm.",
            details=[{"field": "confirm_text", "message": f"Type {host} exactly to confirm."}],
        )
    approval.status = ApprovalStatus.approved if decision == "approve" else ApprovalStatus.rejected
    approval.decided_by = user.id
    approval.decided_at = utcnow()
    approval.comment = (comment or "").strip() or None
    audit(s, org_id=approval.organisation_id, action=f"approval.{approval.status.value}", target_type="approval",
          target_id=approval.id, actor_user_id=user.id, project_id=approval.project_id,
          metadata={"key": approval.key, "kind": approval.kind.value,
                    "cases": len((approval.scope or {}).get("case_keys") or [])})  # fmt: skip
    return approval


def undecided_message(pending: list[Approval]) -> str:
    """'Approve or reject: external transaction (APR-0001)' (roadmap P4-05)."""
    return "Approve or reject: " + ", ".join(f"{KIND_WORDS.get(a.kind, a.kind.value)} ({a.key})" for a in pending)


async def ensure_decided(s: AsyncSession, run: ExecutionRun) -> list[Approval]:
    """G7 guard (open question 1): a run can't be authorised or started while an approval is undecided or expired.

    Returns the run's approvals. Raises 409 `gate_blocked`."""
    approvals = await run_approvals(s, run.id)
    await expire_due(s, approvals)
    expired = [a for a in approvals if a.status == ApprovalStatus.expired]
    if expired:
        raise GateBlocked(
            f"{expired[0].key} expired after 24 hours. Request the run again.",
            details={"approvals": [a.key for a in expired]},
        )
    pending = [a for a in approvals if a.status == ApprovalStatus.pending]
    if pending:
        raise GateBlocked(undecided_message(pending), details={"approvals": [a.key for a in pending]})
    return approvals


def skipped_cases(approvals: list[Approval]) -> dict[str, str]:
    """Case key → skip reason for every rejected approval (the run continues without them)."""
    out: dict[str, str] = {}
    for a in approvals:
        if a.status == ApprovalStatus.rejected:
            for key in (a.scope or {}).get("case_keys") or []:
                out.setdefault(str(key), SKIP_REASONS.get(a.kind, "Not approved"))
    return out


async def consume(s: AsyncSession, run: ExecutionRun) -> dict[str, str]:
    """When the run starts: approvals are single use (`approved` → `used`). Returns the skipped cases."""
    approvals = await ensure_decided(s, run)
    for a in approvals:
        if a.status == ApprovalStatus.approved:
            a.status = ApprovalStatus.used
            audit(s, org_id=a.organisation_id, action="approval.used", target_type="approval", target_id=a.id,
                  project_id=a.project_id, metadata={"key": a.key, "run": run.key})  # fmt: skip
    return skipped_cases(approvals)


# ------------------------------------------------------------------ run request validity (for P4-06)


def request_expired(run: ExecutionRun, *, now: datetime | None = None) -> bool:
    """Open question 3: a run request waiting for authorisation expires after 7 days."""
    if run.status != RunStatus.awaiting_authorisation:
        return False
    return _aware(run.created_at) + REQUEST_TTL <= _aware(now or utcnow())


async def scripts_changed(s: AsyncSession, run: ExecutionRun) -> list[str]:
    """Open question 3: keys of cases whose script changed (or stopped being runnable) since the request."""
    items = (run.scope or {}).get("cases") or []
    if not items:
        return []
    ids = [uuid.UUID(i["script_id"]) for i in items]
    rows = {x.id: x for x in (await s.execute(select(AutomationScript).where(AutomationScript.id.in_(ids)))).scalars()}
    changed = []
    for i in items:
        row = rows.get(uuid.UUID(i["script_id"]))
        if row is None or row.sha256 != i["sha256"] or not svc.runnable(row) or row.status == ScriptStatus.outdated:
            changed.append(str(i["key"]))
    return changed


async def approval_dict(s: AsyncSession, a: Approval, *, can_decide: bool, see_email: bool) -> dict[str, Any]:
    from app.services import serialize_p2 as out

    us = await out.users(s, [x for x in (a.requested_by, a.decided_by) if x])
    run = (
        (await s.execute(select(ExecutionRun).where(ExecutionRun.id == a.execution_run_id))).scalar_one_or_none()
        if a.execution_run_id
        else None
    )
    host = (a.scope or {}).get("target_host")
    return {
        "id": a.id,
        "key": a.key,
        "kind": a.kind.value,
        "title": fx.APPROVAL_TITLES.get(a.kind.value, a.kind.value),
        "status": a.status.value,
        "scope": a.scope,
        "execution_run": {"id": run.id, "key": run.key, "status": run.status.value} if run else None,
        "requested_by": out.person(us.get(a.requested_by), see_email=see_email) if a.requested_by else None,
        "decided_by": out.person(us.get(a.decided_by), see_email=see_email) if a.decided_by else None,
        "decided_at": a.decided_at,
        "comment": a.comment,
        "expires_at": a.expires_at,
        "created_at": a.created_at,
        "confirm_prompt": f"Type {host} to confirm" if host else None,
        "can_decide": can_decide and a.status == ApprovalStatus.pending,
    }
