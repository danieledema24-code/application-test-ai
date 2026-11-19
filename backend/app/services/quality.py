"""Accessibility and passive security checks (P5-02, P5-03): starting, reading, triage and defects.

A check is a `quality_scans` row (A11Y-0001 or SEC-0001) run by the `quality_scan` job; each check is its own
stage run of `accessibility` / `security_assessment` (mirrored, like execution runs). Findings are facts stored as
observed; whether one matters is a person's call (triage with a reason) or G8's (defects). Drafts follow D20:
critical/serious accessibility rules are drafted automatically, one per rule per check (a later check adds
occurrences to the open defect); security, keyboard, minor/moderate findings only on request.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.phase2 import applied_run
from app.api.errors import Conflict, GateBlocked, NotFound, ValidationFailed
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    Defect,
    DefectLink,
    DiscoveredPage,
    Evidence,
    Project,
    QualityFinding,
    QualityScan,
    Requirement,
    ScanSession,
    TestCase,
    User,
)
from app.db.types import utcnow
from app.domain.enums import (
    DefectSeverity,
    DefectSource,
    DefectStatus,
    FindingSeverity,
    FindingStatus,
    PageStatus,
    Priority,
    QualityScanKind,
    QualityScanStatus,
    StageKey,
)
from app.domain.nonfunctional import accessibility as a11y
from app.domain.stages import QUALITY_SCAN_STAGE_STATUS
from app.security import passive_rules as sec
from app.services import approvals as apr
from app.services import defects as dsvc
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.counters import next_key

QUALITY_GROUP = "scan"  # checks share discovery's browser budget per organisation
STAGE = {
    QualityScanKind.accessibility: StageKey.accessibility,
    QualityScanKind.security: StageKey.security_assessment,
    QualityScanKind.exploratory: StageKey.exploratory,  # P6-00: sessions are quality scans (P6-03a)
}
COUNTER = {
    QualityScanKind.accessibility: "a11y_scan",
    QualityScanKind.security: "security_scan",
    QualityScanKind.exploratory: "exploratory_session",
}
WHAT = {
    QualityScanKind.accessibility: "An accessibility check",
    QualityScanKind.security: "A security check",
    QualityScanKind.exploratory: "An exploratory session",
}
# The two Phase 5 non-functional check kinds (the Non-functional workspace); exploration lives in Test Execution.
NF_KINDS = (QualityScanKind.accessibility, QualityScanKind.security)
ACTIVE = (QualityScanStatus.queued, QualityScanStatus.running)
SECONDS_PER_PAGE = 10
ROOT_CAUSE = "Not analysed. Automated checks measure what happens, not why."
TRIAGE_WORDS = {
    FindingStatus.accepted_risk: "marked as accepted risk",
    FindingStatus.false_positive: "marked as false positive",
    FindingStatus.open: "reopened",
}


# ------------------------------------------------------------------ inputs


async def discovered_pages(s: AsyncSession, project_id: uuid.UUID) -> tuple[ScanSession | None, list[DiscoveredPage]]:
    """The current discovery's pages a check may visit: visited, HTTP < 400 (others are listed as not checked)."""
    drun = await applied_run(s, project_id, StageKey.discovery)
    if drun is None:
        return None, []
    scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == drun.id))).scalar_one_or_none()
    if scan is None:
        return None, []
    pages = list(
        (
            await s.execute(
                select(DiscoveredPage)
                .where(DiscoveredPage.scan_session_id == scan.id, DiscoveredPage.status == PageStatus.visited)
                .order_by(DiscoveredPage.sequence)
            )
        ).scalars()
    )
    return scan, [p for p in pages if p.http_status is None or p.http_status < 400]


async def page_mapping(s: AsyncSession, project_id: uuid.UUID) -> dict[str, dict[str, Any]]:
    """page id -> {features, requirements, test_cases}: discovery features on the page, their requirements (current
    version) and the accessibility test cases linked to them (P5-02 mapping)."""
    scan, pages = await discovered_pages(s, project_id)
    if scan is None:
        return {}
    feats = list(
        (await s.execute(select(ApplicationFeature).where(ApplicationFeature.scan_session_id == scan.id))).scalars()
    )
    rrun = await applied_run(s, project_id, StageKey.requirements)
    reqs = (
        list((await s.execute(select(Requirement).where(Requirement.stage_run_id == rrun.id))).scalars())
        if rrun is not None
        else []
    )
    trun = await applied_run(s, project_id, StageKey.test_design)
    cases = (
        list((await s.execute(select(TestCase).where(TestCase.stage_run_id == trun.id))).scalars())
        if trun is not None
        else []
    )
    out_map: dict[str, dict[str, Any]] = {}
    for p in pages:
        pf = [f for f in feats if str(p.id) in {str(x) for x in f.page_ids or []}]
        fids = {str(f.id) for f in pf}
        pr = [r for r in reqs if fids & {str(x) for x in r.feature_ids or []} and r.status.value != "rejected"]
        lineages = {str(r.lineage_id) for r in pr}
        pc = [
            c
            for c in cases
            if lineages & {str(x) for x in c.requirement_lineage_ids or []}
            and c.test_type in ("accessibility", "security", "performance")
        ]
        out_map[str(p.id)] = {
            "features": [{"key": f.key, "name": f.name} for f in pf],
            "requirements": [{"key": r.key, "title": r.title, "lineage_id": str(r.lineage_id)} for r in pr],
            "test_cases": [{"key": c.key, "title": c.title, "type": c.test_type} for c in pc],
        }
    return out_map


# ------------------------------------------------------------------ start, cancel


async def create_scan(
    ctx: AppContext,
    s: AsyncSession,
    project: Project,
    user: User,
    kind: QualityScanKind,
    *,
    page_ids: list[uuid.UUID] | None,
    viewports: list[str],
    keyboard: bool,
    signed_in: bool,
) -> QualityScan:
    """A queued check (members; no approval, D19). 409 when one of the same kind is running or G2 isn't met."""
    from app.automation.axe import load_axe
    from app.orchestrator.orchestrator import Orchestrator
    from app.services.secrets import credentials_secret

    await Orchestrator(ctx).check_optional_upstream(s, project, STAGE[kind])
    busy = (
        await s.execute(
            select(QualityScan).where(
                QualityScan.project_id == project.id, QualityScan.kind == kind, QualityScan.status.in_(ACTIVE)
            )
        )
    ).scalar_one_or_none()
    if busy is not None:
        raise Conflict(f"{WHAT[kind]} is already running ({busy.key}).", details={"key": busy.key})
    axe = load_axe(ctx.settings.automation_dir) if kind == QualityScanKind.accessibility else None
    if kind == QualityScanKind.accessibility and axe is None:
        raise ValidationFailed(
            "Accessibility checks can't run on this server: the accessibility checker (axe-core) isn't installed."
        )
    disc, pages = await discovered_pages(s, project.id)
    if disc is None or not pages:
        raise GateBlocked("Discovery has no pages to check")
    if page_ids is not None:
        wanted = {str(x) for x in page_ids}
        unknown = wanted - {str(p.id) for p in pages}
        if unknown:
            raise ValidationFailed("Choose pages that discovery visited")
        pages = [p for p in pages if str(p.id) in wanted]
    if signed_in and await credentials_secret(s, project.id) is None:
        raise ValidationFailed("Save test credentials to include pages behind sign-in.")
    chosen = [p for p in pages if signed_in or not p.requires_auth]
    left = [p for p in pages if not signed_in and p.requires_auth]
    if not chosen:
        raise ValidationFailed("Choose at least one page")
    _n, key = await next_key(s, project.organisation_id, project.id, COUNTER[kind])
    origin, host = await apr.target(s, project.id)
    scan = QualityScan(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        kind=kind,
        config={
            "pages": [
                {"page_id": str(p.id), "url": p.final_url or p.url, "requires_auth": p.requires_auth} for p in chosen
            ],
            "viewports": viewports,
            "keyboard": keyboard if kind == QualityScanKind.accessibility else False,
            "signed_in": signed_in,
            "origin": origin,
            "host": host,
            "discovery_scan": disc.key,
        },
        not_checked=[
            {
                "url": p.final_url or p.url,
                "page_id": str(p.id),
                "viewport": None,
                "reason": "needs sign-in; not included",
            }
            for p in left
        ],
        tool_versions={"axe": axe.version, "axe_sha256": axe.sha256} if axe else {"rules": "passive-rules 1"},
        requested_by=user.id,
        status=QualityScanStatus.queued,
    )
    s.add(scan)
    await s.flush()
    await Orchestrator(ctx).mirror_nonfunctional(s, project, STAGE[kind], scan, QUALITY_SCAN_STAGE_STATUS[scan.status])
    audit(
        s,
        org_id=project.organisation_id,
        action="quality_scan.started",
        target_type="quality_scan",
        target_id=scan.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"key": key, "kind": kind.value, "pages": len(chosen), "viewports": viewports},
    )
    return scan


async def enqueue(ctx: AppContext, scan: QualityScan) -> None:
    await ctx.queue.enqueue(
        "quality_scan",
        {"scan_id": str(scan.id)},
        org_id=scan.organisation_id,
        project_id=scan.project_id,
        dedupe_key=f"quality_scan:{scan.id}",
        concurrency_group=QUALITY_GROUP,
        max_attempts=1,
    )


async def cancel(s: AsyncSession, scan: QualityScan, user: User) -> str:
    if scan.status not in ACTIVE:
        raise Conflict(f"{scan.key} has already finished")
    scan.config = {**(scan.config or {}), "cancel_requested": True, "cancelled_by": str(user.id)}
    audit(
        s,
        org_id=scan.organisation_id,
        action="quality_scan.cancel_requested",
        target_type="quality_scan",
        target_id=scan.id,
        actor_user_id=user.id,
        project_id=scan.project_id,
        metadata={"key": scan.key},
    )
    return f"Cancelling {scan.key}…"


# ------------------------------------------------------------------ findings (called by the scan job)


async def previous(
    s: AsyncSession, project_id: uuid.UUID, fingerprint: str, before: uuid.UUID
) -> QualityFinding | None:
    return (
        await s.execute(
            select(QualityFinding)
            .where(
                QualityFinding.project_id == project_id,
                QualityFinding.fingerprint == fingerprint,
                QualityFinding.scan_id != before,
            )
            .order_by(QualityFinding.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def add_finding(
    s: AsyncSession, scan: QualityScan, n: int, item: dict[str, Any], mapped: dict[str, Any]
) -> QualityFinding:
    """Stores one finding; a fingerprint seen in an earlier check keeps its triage ("Seen before")."""
    prior = await previous(s, scan.project_id, item["fingerprint"], scan.id)
    status, reason, by = FindingStatus.open, None, None
    extra: dict[str, Any] = {}
    if prior is not None:
        extra["seen_before"] = prior.key
        if prior.status in (FindingStatus.accepted_risk, FindingStatus.false_positive):
            status, reason, by = prior.status, prior.status_reason, prior.status_by
        elif prior.status == FindingStatus.fixed:
            extra["reopened"] = True
    details = {
        k: item.get(k)
        for k in (
            "description",
            "how_to_fix",
            "best_practice",
            "needs_review",
            "heuristic",
            "impact",
            "subject",
            "observed",
            "category",
            "why",
            "fix",
            # Exploratory findings (P6-03a): steps to reproduce, the step numbers, redacted console and network lines.
            "steps",
            "step",
            "steps_seen",
            "console",
            "network",
            "action",
            "group",
        )
    }
    f = QualityFinding(
        organisation_id=scan.organisation_id,
        project_id=scan.project_id,
        key=f"{scan.key}-{n:02d}",
        scan_id=scan.id,
        kind=scan.kind,
        rule_id=item["rule_id"],
        severity=item["severity"],
        title=item["title"][:300],
        page_id=uuid.UUID(item["page_id"]) if item.get("page_id") else None,
        url=item["url"][:2048],
        viewport=item.get("viewport"),
        nodes=item.get("nodes") or [],
        references=item.get("references") or [],
        fingerprint=item["fingerprint"],
        status=status,
        status_reason=reason,
        status_by=by,
        evidence_refs=item.get("evidence_refs") or [],
        mapped={**mapped, **extra, "details": {k: v for k, v in details.items() if v not in (None, "", False)}},
    )
    s.add(f)
    return f


async def mark_not_found_again(s: AsyncSession, scan: QualityScan, checked: set[tuple[str, str | None]]) -> int:
    """Open findings of earlier checks of the same kind, on pages this check visited, that it didn't find again."""
    now_fps = set(
        (await s.execute(select(QualityFinding.fingerprint).where(QualityFinding.scan_id == scan.id))).scalars()
    )
    rows = (
        await s.execute(
            select(QualityFinding).where(
                QualityFinding.project_id == scan.project_id,
                QualityFinding.kind == scan.kind,
                QualityFinding.scan_id != scan.id,
                QualityFinding.status == FindingStatus.open,
            )
        )
    ).scalars()
    n = 0
    for f in rows:
        if (f.url, f.viewport) in checked and f.fingerprint not in now_fps:
            f.status = FindingStatus.fixed
            f.status_reason = f"Not found in {scan.key}."
            n += 1
    return n


def _pages_of(findings: list[QualityFinding]) -> list[str]:
    return sorted({f.url for f in findings})


def _path(url: str) -> str:
    return a11y.path_of(url)


async def _open_defect_for_rule(
    s: AsyncSession, project_id: uuid.UUID, source: DefectSource, rule: str
) -> Defect | None:
    rows = (
        await s.execute(
            select(Defect).where(
                Defect.project_id == project_id,
                Defect.source == source,
                Defect.status.in_(dsvc.OPEN),
            )
        )
    ).scalars()
    return next((d for d in rows if (d.environment or {}).get("rule_id") == rule), None)


async def _link(s: AsyncSession, project: Project, d: Defect, findings: list[QualityFinding]) -> None:
    lineages = {r["lineage_id"] for f in findings for r in (f.mapped or {}).get("requirements") or []}
    have = set(
        (await s.execute(select(DefectLink.requirement_lineage_id).where(DefectLink.defect_id == d.id))).scalars()
    )
    for lid in sorted(lineages):
        if uuid.UUID(lid) not in have:
            s.add(
                DefectLink(
                    organisation_id=project.organisation_id,
                    project_id=project.id,
                    defect_id=d.id,
                    requirement_lineage_id=uuid.UUID(lid),
                )
            )
    for f in findings:
        f.defect_id = d.id


def _add_occurrence(d: Defect, scan: QualityScan, pages: list[str], *, added: bool) -> None:
    env = dict(d.environment or {})
    occ = [o for o in env.get("occurrences") or [] if o.get("scan_key") != scan.key]
    occ.append({"scan_key": scan.key, "pages": len(pages), "added": added, "at": utcnow().isoformat()})
    env["occurrences"] = occ
    d.environment = env


async def a11y_drafts(s: AsyncSession, project: Project, scan: QualityScan) -> tuple[list[str], list[str]]:
    """D20: one grouped draft per critical/serious axe rule of this check, or an occurrence on the open defect.
    Returns (drafted keys, keys that got an occurrence)."""
    rows = list(
        (
            await s.execute(
                select(QualityFinding)
                .where(QualityFinding.scan_id == scan.id, QualityFinding.severity.in_(a11y.DRAFTED))
                .order_by(QualityFinding.key)
            )
        ).scalars()
    )
    groups: dict[str, list[QualityFinding]] = defaultdict(list)
    for f in rows:
        d_ = (f.mapped or {}).get("details") or {}
        if d_.get("heuristic") or d_.get("needs_review") or d_.get("best_practice"):
            continue
        if f.status in (FindingStatus.accepted_risk, FindingStatus.false_positive):
            continue
        groups[f.rule_id].append(f)
    drafted: list[str] = []
    added: list[str] = []
    origin, _host = await apr.target(s, project.id)
    for rule, fs in groups.items():
        pages = _pages_of(fs)
        existing = await _open_defect_for_rule(s, project.id, DefectSource.accessibility, rule)
        if existing is not None:
            _add_occurrence(existing, scan, pages, added=True)
            await _link(s, project, existing, fs)
            added.append(existing.key)
            continue
        crit_any = any(f.severity == FindingSeverity.critical for f in fs)
        sev = FindingSeverity.critical if crit_any else FindingSeverity.serious
        dsev = a11y.DEFECT_SEVERITY.get(sev, DefectSeverity.minor)
        crit = next((r for f in fs for r in f.references or [] if r.get("type") == "wcag"), None)
        wcag = f"WCAG {crit['criterion']}" + (f" {crit['name']}" if crit and crit.get("name") else "") if crit else ""
        nodes = sum(len(f.nodes or []) for f in fs)
        first = fs[0]
        target = (first.nodes or [{}])[0].get("target") or "the element"
        fields = {
            "summary": a11y.draft_title(rule, first.title, [f.url for f in fs]),
            "description": f"axe rule {rule} ({sev.value.capitalize()}) failed on {len(pages)} page"
            f"{'s' if len(pages) != 1 else ''} and {nodes} element{'s' if nodes != 1 else ''} in {scan.key}."
            + (f" {wcag}." if wcag else ""),
            "environment": {
                "url": origin,
                "browser": "Chromium",
                "viewport": first.viewport or "desktop",
                "scan_key": scan.key,
                "rule_id": rule,
                "axe": (scan.tool_versions or {}).get("axe"),
                "pages": [_path(u) for u in pages],
            },
            "preconditions": [],
            "steps": [f"Open {_path(u)}." for u in pages[:5]] + [f"Inspect {target}."],
            "expected": f"[Assumed · from {wcag or 'WCAG 2.2 AA'}] {first.title}",
            "actual": f"[Observed] axe rule {rule} failed on {', '.join(_path(u) for u in pages[:5])}"
            f" ({nodes} element{'s' if nodes != 1 else ''}).",
            "severity": dsev,
            "severity_derived": dsev,
            "severity_reason": f"axe impact {sev.value}",
            "priority": Priority.medium,
            "priority_derived": Priority.medium,
            "priority_reason": "default for accessibility drafts",
            "reproducibility": {"kind": "always"},
            "root_cause_hypothesis": ROOT_CAUSE,
            "evidence_refs": [r for f in fs for r in f.evidence_refs or []][:20],
        }
        d = await dsvc.create_defect(
            s, project, fields, source=DefectSource.accessibility, result=None, case=None, user_id=None
        )
        _add_occurrence(d, scan, pages, added=False)
        await _link(s, project, d, fs)
        drafted.append(d.key)
    return drafted, added


# ------------------------------------------------------------------ triage and defects


async def triage(s: AsyncSession, f: QualityFinding, user: User, *, status: str, reason: str | None) -> str:
    text = (reason or "").strip()
    if status not in ("accepted_risk", "false_positive", "open"):
        raise ValidationFailed("Choose an option.", details=[{"field": "status", "message": "Choose an option."}])
    if not text:
        raise ValidationFailed(
            "Say why. The reason is shown in reports.",
            details=[{"field": "reason", "message": "Say why. The reason is shown in reports."}],
        )
    new = FindingStatus(status)
    if new == f.status and new == FindingStatus.open:
        raise Conflict(f"{f.key} is already open")
    f.status = new
    f.status_reason = text[:2000]
    f.status_by = user.id
    audit(
        s,
        org_id=f.organisation_id,
        action="quality_finding.triaged",
        target_type="quality_finding",
        target_id=f.id,
        actor_user_id=user.id,
        project_id=f.project_id,
        metadata={"key": f.key, "status": new.value},
    )
    # P6-05a: triage changes the evidence an assessment waiting for G9 was based on.
    from app.services.release import mark_stale

    await mark_stale(s, f.project_id, f"{f.key} was {TRIAGE_WORDS[new]}")
    return f"{f.key} {TRIAGE_WORDS[new]}."


async def raise_defect(s: AsyncSession, project: Project, f: QualityFinding, user: User, *, group: bool) -> Defect:
    """A draft from a finding (members). Security groups the rule's findings of the check across pages (design
    open question 3); accessibility keyboard, minor/moderate and kill-switch-style findings are single."""
    if f.defect_id is not None:
        d = await s.get(Defect, f.defect_id)
        raise Conflict(f"{f.key} is already linked to {d.key if d else 'a defect'}")
    if f.kind == QualityScanKind.exploratory:
        from app.services.exploratory import raise_defect as explore_defect

        return await explore_defect(s, project, f, user)
    scan = await s.get(QualityScan, f.scan_id)
    assert scan is not None
    fs = [f]
    if group:
        subject = ((f.mapped or {}).get("details") or {}).get("subject") or ""
        fs = [
            x
            for x in (
                await s.execute(
                    select(QualityFinding).where(
                        QualityFinding.scan_id == f.scan_id, QualityFinding.rule_id == f.rule_id
                    )
                )
            ).scalars()
            if (((x.mapped or {}).get("details") or {}).get("subject") or "") == subject and x.defect_id is None
        ]
    pages = _pages_of(fs)
    origin, _host = await apr.target(s, project.id)
    details = (f.mapped or {}).get("details") or {}
    if f.kind == QualityScanKind.security:
        summary = sec.defect_summary(f.rule_id, details.get("subject") or "", len(pages))
        dsev = sec.DEFECT_SEVERITY.get(f.severity, DefectSeverity.minor)
        observed = details.get("observed") or ""
        expected = f"[From {((f.references or [{}])[0]).get('name') or 'OWASP'}] {details.get('fix') or ''}".strip()
        actual = f"[Observed in the response headers] {observed} on {len(pages)} page{'s' if len(pages) != 1 else ''}"
        source = DefectSource.security
    else:
        summary = a11y.draft_title(f.rule_id, f.title, [x.url for x in fs])
        dsev = a11y.DEFECT_SEVERITY.get(f.severity, DefectSeverity.minor)
        if f.severity in (FindingSeverity.moderate, FindingSeverity.minor):
            dsev = DefectSeverity.minor if f.severity == FindingSeverity.moderate else DefectSeverity.trivial
        expected = f"[Assumed · from WCAG] {f.title}"
        actual = f"[Observed on the page] {f.rule_id} on {', '.join(_path(u) for u in pages[:5])}"
        source = DefectSource.accessibility
    fields = {
        "summary": summary,
        "description": f"Raised from {f.key} ({scan.key}) by {user.full_name or user.email}.",
        "environment": {
            "url": origin,
            "browser": "Chromium",
            "viewport": f.viewport or "desktop",
            "scan_key": scan.key,
            "rule_id": f.rule_id,
            "pages": [_path(u) for u in pages],
            "subject": details.get("subject"),
        },
        "preconditions": [],
        "steps": [f"Open {_path(u)}." for u in pages[:5]],
        "expected": expected,
        "actual": actual,
        "severity": dsev,
        "severity_derived": dsev,
        "severity_reason": f"from the rule's severity ({f.severity.value})",
        "priority": Priority.medium,
        "priority_derived": Priority.medium,
        "priority_reason": "set by a person",
        "reproducibility": {"kind": "always"},
        "root_cause_hypothesis": ROOT_CAUSE,
        "evidence_refs": [r for x in fs for r in x.evidence_refs or []][:20],
    }
    d = await dsvc.create_defect(s, project, fields, source=source, result=None, case=None, user_id=user.id)
    _add_occurrence(d, scan, pages, added=False)
    await _link(s, project, d, fs)
    return d


async def mark_findings_for_rejected(s: AsyncSession, d: Defect, user: User, comment: str) -> int:
    """Design open question 2: rejecting a non-functional draft as Accepted risk can mark its findings too."""
    rows = list((await s.execute(select(QualityFinding).where(QualityFinding.defect_id == d.id))).scalars())
    for f in rows:
        f.status = FindingStatus.accepted_risk
        f.status_reason = comment
        f.status_by = user.id
    return len(rows)


# ------------------------------------------------------------------ reads


def status_label(scan: QualityScan) -> str:
    if scan.kind == QualityScanKind.exploratory:
        from app.services.exploratory import status_label as explore_label

        return explore_label(scan, {})
    total = len((scan.config or {}).get("pages") or []) * max(1, len((scan.config or {}).get("viewports") or [1]))
    done = int((scan.summary or {}).get("visited") or 0)
    nc = len(scan.not_checked or [])
    return {
        QualityScanStatus.queued: "Waiting to start",
        QualityScanStatus.running: f"Checking {min(done + 1, total)} of {total} pages",
        QualityScanStatus.completed: "Finished",
        QualityScanStatus.partial: f"Partial: {nc} page{'s' if nc != 1 else ''} not checked",
        QualityScanStatus.failed: "Didn't complete",
        QualityScanStatus.cancelled: "Cancelled",
    }[scan.status]


async def scan_dict(s: AsyncSession, scan: QualityScan, *, see_email: bool, full: bool = False) -> dict[str, Any]:
    us = await out.users(s, [x for x in (scan.requested_by,) if x])
    cfg = scan.config or {}
    d: dict[str, Any] = {
        "id": scan.id,
        "key": scan.key,
        "kind": scan.kind.value,
        "status": scan.status.value,
        "status_label": status_label(scan),
        "pages": len(cfg.get("pages") or []),
        "viewports": cfg.get("viewports") or ["desktop"],
        "keyboard": bool(cfg.get("keyboard")),
        "signed_in": bool(cfg.get("signed_in")),
        "summary": scan.summary or {},
        "not_checked": scan.not_checked or [],
        "tool_versions": {k: v for k, v in (scan.tool_versions or {}).items() if k != "axe_sha256"},
        "requested_by": out.person(us.get(scan.requested_by), see_email=see_email) if scan.requested_by else None,
        "created_at": scan.created_at,
        "started_at": scan.started_at,
        "finished_at": scan.finished_at,
        "error": scan.error,
        "cancel_requested": bool(cfg.get("cancel_requested")),
        "statement": a11y.STATEMENT if scan.kind == QualityScanKind.accessibility else sec.STATEMENT,
    }
    if full:
        d["page_list"] = [
            {
                "url": p["url"],
                "path": _path(p["url"]),
                "page_id": p.get("page_id"),
                "requires_auth": bool(p.get("requires_auth")),
            }
            for p in cfg.get("pages") or []
        ]
        d["progress"] = (scan.summary or {}).get("progress") or []
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
            ({"key": k, "summary": sm, "status": st.value} for k, sm, st in drafts), key=lambda x: x["key"]
        )
    return d


async def finding_dict(
    s: AsyncSession, f: QualityFinding, users: dict[uuid.UUID, User], *, see_email: bool, scan_key: str | None = None
) -> dict[str, Any]:
    m = f.mapped or {}
    details = m.get("details") or {}
    defect = await s.get(Defect, f.defect_id) if f.defect_id else None
    return {
        "id": f.id,
        "key": f.key,
        "scan_id": f.scan_id,
        "scan_key": scan_key or f.key.rsplit("-", 1)[0],
        "kind": f.kind.value,
        "rule_id": f.rule_id,
        "severity": f.severity.value,
        "title": f.title,
        "url": f.url,
        "path": _path(f.url),
        "page_id": f.page_id,
        "viewport": f.viewport,
        "nodes": f.nodes or [],
        "references": f.references or [],
        "status": f.status.value,
        "status_reason": f.status_reason,
        "status_by": out.person(users.get(f.status_by), see_email=see_email) if f.status_by else None,
        "seen_before": m.get("seen_before"),
        "reopened": bool(m.get("reopened")),
        "details": details,
        "heuristic": bool(details.get("heuristic")),
        "needs_review": bool(details.get("needs_review")),
        "best_practice": bool(details.get("best_practice")),
        "mapped": {k: m.get(k) or [] for k in ("features", "requirements", "test_cases")},
        "defect": {"id": defect.id, "key": defect.key, "status": defect.status.value, "summary": defect.summary}
        if defect
        else None,
        "evidence": list(f.evidence_refs or []),
        "created_at": f.created_at,
    }


async def evidence_for_scan(s: AsyncSession, scan_id: uuid.UUID) -> list[Evidence]:
    return list((await s.execute(select(Evidence).where(Evidence.quality_scan_id == scan_id))).scalars())


async def get_scan(s: AsyncSession, scan_id: uuid.UUID) -> QualityScan:
    scan = (await s.execute(select(QualityScan).where(QualityScan.id == scan_id))).scalar_one_or_none()
    if scan is None:
        raise NotFound("Check not found")
    return scan


def is_draftable(d: Defect) -> bool:
    return d.status == DefectStatus.draft and d.source in (
        DefectSource.accessibility,
        DefectSource.security,
        DefectSource.performance,
    )


def host_of(url: str) -> str:
    return urlsplit(url).hostname or ""
