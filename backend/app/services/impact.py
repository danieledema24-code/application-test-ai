"""Change impact and the regression recommendation (P6-02, decisions D27, D28).

After a rescan's change set is written, `analyse` maps the change onto the project's approved work through
traceability (`app.domain.change.impact`), re-checks the locators of the scripts on changed pages on the live site
(read-only page loads, the G6 check), marks the scripts whose locators no longer resolve `outdated` with the reason,
and stores the impact items and the regression recommendation (must / should / excluded, D28). With AI on the model
may only reorder "should run"; an answer that drops a must-run test or names an unknown test is rejected and the rule
order kept. Comparisons a person asks for between two older scans list changes only: impact is about the approved
work against the site as the rescan saw it.

Impact items close in three ways: `rerun` items when their case has a result from a run started after the change set
(`resolve_reruns`, called when a run finishes), `heal` items when the script is valid again (`resolve_heals`, after
validation), and `review` / `regenerate` / `write_requirement` items by a member (`close`), with a reason for "No
action needed". Re-run and repair items can't be closed by a person (design P6 OQ4).
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, ValidationFailed
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    AutomationScript,
    ChangeItem,
    ChangeSet,
    Defect,
    DefectLink,
    DiscoveredPage,
    ExecutionResult,
    ExecutionRun,
    HealSuggestion,
    ImpactItem,
    PerformanceProfile,
    Project,
    ProjectUrl,
    QualityFinding,
    QualityScan,
    Risk,
    User,
)
from app.db.tenant import TenantScope, bind_scope
from app.db.types import utcnow
from app.domain.change import diff as d
from app.domain.change import impact as im
from app.domain.enums import (
    ActorType,
    ChangeSetStatus,
    FindingStatus,
    HealKind,
    HealStatus,
    ImpactAction,
    ImpactLevel,
    ImpactStatus,
    ImpactTargetKind,
    PerfProfileStatus,
    QualityScanKind,
    QualityScanStatus,
    RequirementStatus,
    ResultStatus,
    ScriptStatus,
    StageKey,
    UrlRole,
)
from app.llm.base import UntrustedBlock
from app.services import automation as asvc
from app.services import gates
from app.services import serialize_p2 as out
from app.services import testdesign as tds
from app.services.audit import audit

log = logging.getLogger(__name__)

AGENT = "change"
CLOSABLE = frozenset({ImpactAction.review, ImpactAction.regenerate, ImpactAction.write_requirement})
SELF_CLOSING = (
    "Re-run and repair items close by themselves: a re-run item when its test has a result from a later run, a repair "
    "item when the script is valid again"
)
NO_ACTION_REASON = "Say why no action is needed."
NO_IMPACT = "Impact is worked out when a rescan is compared with its baseline. This comparison lists changes only."
NOT_READY = "Impact is worked out when the comparison has finished"
# Results that say a test ran (cancelled, interrupted and never-run rows don't).
RAN = frozenset({ResultStatus.passed, ResultStatus.failed, ResultStatus.error, ResultStatus.flaky})
_TC_KEY = re.compile(r"\bTC-\d+\b")


# ---------------------------------------------------------------- the model of approved work


def _path(url: str | None) -> str:
    return d.path_of(url) if url else ""


async def _features(s: AsyncSession, ids: set[str]) -> dict[str, im.FeatureIn]:
    if not ids:
        return {}
    rows = list(
        (
            await s.execute(select(ApplicationFeature).where(ApplicationFeature.id.in_([uuid.UUID(x) for x in ids])))
        ).scalars()
    )
    page_ids = {uuid.UUID(str(p)) for f in rows for p in f.page_ids or []}
    urls: dict[str, str] = {}
    if page_ids:
        for pid, url in (
            await s.execute(select(DiscoveredPage.id, DiscoveredPage.url).where(DiscoveredPage.id.in_(page_ids)))
        ).all():
            urls[str(pid)] = url
    return {
        str(f.id): im.FeatureIn(
            id=str(f.id),
            key=f.key,
            name=f.name,
            category=f.category.value,
            pages=frozenset(_path(urls.get(str(p))) for p in f.page_ids or [] if str(p) in urls),
        )
        for f in rows
    }


async def bundle_locators(s: AsyncSession, project_id: uuid.UUID) -> tuple[Any, dict[str, im.ScriptIn]]:
    """The current automation bundle and its scripts with the page-object locators each uses."""
    bundle = await asvc.current_run(s, project_id, StageKey.automation)
    if bundle is None:
        return None, {}
    output = dict(bundle.output or {})
    specs: dict[str, list[dict[str, Any]]] = dict(output.get("locators") or {})
    pages: dict[str, str] = dict(output.get("pages") or {})
    refs: dict[str, list[str]] = dict(output.get("script_locators") or {})
    scripts: dict[str, im.ScriptIn] = {}
    for x in (await asvc.bundle_rows(s, bundle.id))[0]:
        locs: list[im.LocatorIn] = []
        for ref in dict.fromkeys(refs.get(str(x.case_lineage_id), [])):
            file, getter = ref.split("#", 1)
            spec = next((i for i in specs.get(file, []) if i.get("getter") == getter), None)
            if spec is None or file not in pages:
                continue
            locs.append(
                im.LocatorIn(
                    file=file,
                    getter=getter,
                    page=pages[file],
                    by=str(spec.get("by") or ""),
                    name=str(spec.get("name") or ""),
                    role=str(spec.get("role") or ""),
                    element=str(spec.get("element") or ""),
                    css=str(spec.get("css") or ""),
                    within=str(spec.get("within") or ""),
                    exact=bool(spec.get("exact")),
                )
            )
        scripts[str(x.case_lineage_id)] = im.ScriptIn(
            lineage=str(x.case_lineage_id),
            id=str(x.id),
            path=x.path,
            state=asvc.script_state(x),
            locators=tuple(locs),
            outdated_reason=x.outdated_reason,
        )
    return bundle, scripts


async def latest_scan(s: AsyncSession, project_id: uuid.UUID, kind: QualityScanKind) -> QualityScan | None:
    return (
        await s.execute(
            select(QualityScan)
            .where(
                QualityScan.project_id == project_id,
                QualityScan.kind == kind,
                QualityScan.status.in_([QualityScanStatus.completed, QualityScanStatus.partial]),
            )
            .order_by(QualityScan.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def build_model(s: AsyncSession, project_id: uuid.UUID) -> im.Model:
    _rrun, reqs = await gates.current_requirements(s, project_id)
    approved = [r for r in reqs if r.status == RequirementStatus.approved]
    srun, _strategy = await gates.current_strategy(s, project_id)
    risks = list((await s.execute(select(Risk).where(Risk.stage_run_id == srun.id))).scalars()) if srun else []
    fids = {str(f) for r in approved for f in r.feature_ids or []} | {
        str(f) for r in risks for f in r.feature_ids or []
    }
    _decision, cases = await asvc.approved_cases(s, project_id)
    _bundle, scripts = await bundle_locators(s, project_id)
    defects = list(
        (
            await s.execute(
                select(Defect).where(Defect.project_id == project_id, Defect.status.in_(list(im.OPEN_DEFECT)))
            )
        ).scalars()
    )
    links: dict[uuid.UUID, list[str]] = {}
    if defects:
        for link in (
            await s.execute(select(DefectLink).where(DefectLink.defect_id.in_([x.id for x in defects])))
        ).scalars():
            if link.test_case_lineage_id is not None:
                links.setdefault(link.defect_id, []).append(str(link.test_case_lineage_id))
    findings: list[im.FindingIn] = []
    for kind in (QualityScanKind.accessibility, QualityScanKind.security):
        scan = await latest_scan(s, project_id, kind)
        if scan is None:
            continue
        for f in (
            await s.execute(
                select(QualityFinding).where(
                    QualityFinding.scan_id == scan.id, QualityFinding.status == FindingStatus.open
                )
            )
        ).scalars():
            findings.append(im.FindingIn(str(f.id), f.key, f.title, f.kind.value, f.severity.value, _path(f.url)))
    targets: list[im.PerfTargetIn] = []
    for prof in (
        await s.execute(
            select(PerformanceProfile).where(
                PerformanceProfile.project_id == project_id,
                PerformanceProfile.status.in_([PerfProfileStatus.draft, PerfProfileStatus.ready]),
            )
        )
    ).scalars():
        for t in prof.targets or []:
            if t.get("path"):
                targets.append(im.PerfTargetIn(str(prof.id), prof.key, prof.name, _path(str(t["path"]))))
    return im.Model(
        features=await _features(s, fids),
        requirements=[
            im.RequirementIn(str(r.lineage_id), r.key, r.title, tuple(str(f) for f in r.feature_ids or []))
            for r in approved
        ],
        cases=[
            im.CaseIn(
                lineage=c.case.lineage_id,
                key=c.case.key,
                title=c.case.title,
                requirement_lineages=tuple(str(x) for x in c.row.requirement_lineage_ids or []),
                steps=tuple(t for st in c.case.steps for t in (st.action, st.expected) if t),
                test_type=c.row.test_type,
                suites=c.case.suites,
                risk_lineage=str(c.row.risk_lineage_id) if c.row.risk_lineage_id else None,
                test_case_id=str(c.row.id),
            )
            for c in cases
            if c.status not in ("rejected", "deprecated")
        ],
        scripts=scripts,
        defects=[
            im.DefectIn(
                str(x.id),
                x.key,
                x.summary,
                x.severity.value,
                x.status.value,
                tuple(links.get(x.id, [])),
                tuple(str(st) for st in x.steps or []),
            )
            for x in defects
        ],
        findings=findings,
        perf_targets=targets,
        risks=[
            im.RiskIn(
                str(r.lineage_id),
                r.key,
                r.title,
                r.level.value,
                r.status.value,
                tuple(str(x) for x in r.requirement_lineage_ids or []),
                tuple(str(x) for x in r.feature_ids or []),
            )
            for r in risks
        ],
    )


def change_in(r: ChangeItem) -> im.ChangeIn:
    return im.ChangeIn(
        id=str(r.id),
        kind=r.kind,
        significance=r.significance,
        page=d.path_of(r.page_url) if r.page_url else None,
        before=r.before,
        after=r.after,
        subject=d.describe(d.Change(r.kind, r.significance, r.page_url, r.before, r.after)),
    )


# ---------------------------------------------------------------- analysis


async def _recheck(
    ctx: AppContext,
    scope: TenantScope,
    project: Project,
    scripts: dict[str, im.ScriptIn],
    changed_pages: set[str],
    set_key: str,
) -> tuple[dict[str, dict[str, tuple[int, int | None]]], dict[str, Any]]:
    """Counts the locators of the scripts on changed pages on the live site (read-only), exactly as G6 does."""
    from app.agents.automation import validation as val
    from app.services.secrets import credentials_secret, use_credentials

    wanted: dict[str, dict[str, dict[str, Any]]] = {}
    pages: dict[str, str] = {}
    for sc in scripts.values():
        if sc.state == "outdated" and f"after {set_key}" not in (sc.outdated_reason or ""):
            continue  # outdated for another reason (its case changed): regenerating it is the fix
        for loc in sc.locators:
            if loc.page in changed_pages:
                pages[loc.file] = loc.page
                wanted.setdefault(loc.file, {})[loc.getter] = {
                    "getter": loc.getter, "element": loc.element, "by": loc.by, "name": loc.name,
                    "role": loc.role, "exact": loc.exact, "within": loc.within, "css": loc.css,
                }  # fmt: skip
    info: dict[str, Any] = {"checked_at": utcnow().isoformat(), "pages": sorted(set(pages.values())), "files": {}}
    if not pages:
        return {}, info
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        url = (
            await s.execute(
                select(ProjectUrl).where(ProjectUrl.project_id == project.id, ProjectUrl.role == UrlRole.primary)
            )
        ).scalar_one_or_none()
        secret = await credentials_secret(s, project.id)
        creds = await use_credentials(ctx, s, secret, purpose="locator_recheck", task_id=None) if secret else None
        await s.commit()
    if url is None:
        info["reason"] = "the project has no target URL"
        return {}, info
    results = await val.verify_locators(
        ctx, scope, project, url, pages, {f: list(g.values()) for f, g in wanted.items()}, creds, also_exact=True
    )
    del creds
    counts: dict[str, dict[str, tuple[int, int | None]]] = {}
    for file, res in results.items():
        exact = res.get("exact") or {}
        per: dict[str, tuple[int, int | None]] = {}
        for getter, (status, n) in (res.get("locators") or {}).items():
            if status == "not_checked":
                continue
            per[getter] = (int(n or 0), exact.get(getter))
        counts[file] = per
        info["files"][file] = {"page": pages.get(file), "reason": res.get("reason"),
                               "counts": {g: list(v) for g, v in per.items()}}  # fmt: skip
    return counts, info


async def analyse(ctx: AppContext, scope: TenantScope, change_set_id: uuid.UUID) -> dict[str, Any] | None:
    """Writes the impact items and the regression recommendation of a rescan's change set (retry-safe: the set's
    items are written again). Returns the counts, or None for a set that has no impact (a person's comparison)."""
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()
        if cs.stage_run_id is None or cs.status != ChangeSetStatus.completed:
            return None
        project = (await s.execute(select(Project).where(Project.id == cs.project_id))).scalar_one()
        rows = list((await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars())
        changes = [change_in(r) for r in rows]
        model = await build_model(s, project.id)
        key = cs.key
    a = im.analyse(changes, model, set_key=key)
    affected = im.affected_pages(changes)
    changed_pages, removed_pages = set(affected.changed), set(affected.removed)
    counts, check = await _recheck(ctx, scope, project, model.scripts, changed_pages, key)
    renamed = im.renamed_names(changes)
    broken: dict[str, list[im.LocatorIn]] = {}
    for lineage, sc in model.scripts.items():
        locs = im.broken_locators(sc, counts, renamed)
        if locs:
            broken[lineage] = locs
    heals = im.heal_items(broken, changes, set_key=key)
    rec = im.recommend(model, a)
    stored: dict[str, Any] = {
        **rec.as_dict(),
        "order": "rules",
        "explanation": None,
        "generated_at": utcnow().isoformat(),
    }
    stored, usage = await ai_reorder(ctx, stored)
    check["broken"] = {
        lin: [{"file": x.file, "getter": x.getter, "page": x.page, "expression": im.expression(x)} for x in locs]
        for lin, locs in broken.items()
    }
    removed_targets = {t.profile_id: t for t in model.perf_targets if t.path in removed_pages}
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()
        await s.execute(delete(ImpactItem).where(ImpactItem.change_set_id == cs.id))
        items = a.items + heals
        for i in items:
            s.add(
                ImpactItem(
                    organisation_id=cs.organisation_id,
                    project_id=cs.project_id,
                    change_set_id=cs.id,
                    change_item_ids=i.change_ids,
                    target_kind=i.target_kind,
                    target_ref=i.target_ref,
                    level=i.level,
                    action=i.action,
                    reason=i.reason,
                )
            )
        bundle = await asvc.current_run(s, cs.project_id, StageKey.automation)
        if bundle is not None and broken:
            for row in (
                await s.execute(
                    select(AutomationScript).where(
                        AutomationScript.stage_run_id == bundle.id,
                        AutomationScript.case_lineage_id.in_([uuid.UUID(x) for x in broken]),
                    )
                )
            ).scalars():
                # The automation stage keeps its status (D27): the script is listed as outdated with the reason.
                row.status = ScriptStatus.outdated
                row.outdated_reason = im.outdated_reason(broken[str(row.case_lineage_id)], key)
        if removed_targets:
            profiles = (
                await s.execute(
                    select(PerformanceProfile).where(PerformanceProfile.id.in_([uuid.UUID(x) for x in removed_targets]))
                )
            ).scalars()
            for prof in profiles:
                if prof.status in (PerfProfileStatus.draft, PerfProfileStatus.ready):
                    prof.status = PerfProfileStatus.stale
                    prof.stale_reason = f"Page {removed_targets[str(prof.id)].path} was removed ({key})"
        summary = summarise(items, stored)
        cs.rerun_recommendation = stored
        cs.summary = {
            **(cs.summary or {}),
            "impact": summary,
            "locator_check": check,
            **({"impact_llm": usage} if usage else {}),
        }
        audit(
            s,
            org_id=cs.organisation_id,
            action="impact.analysed",
            target_type="change_set",
            target_id=cs.id,
            actor_type=ActorType.system,
            project_id=cs.project_id,
            metadata={"key": key, **{k: v for k, v in summary.items() if isinstance(v, int)}},
        )
        await s.commit()
    message = (
        f"Impact of {key}: {summary['requirements']} requirement{'s' if summary['requirements'] != 1 else ''}, "
        f"{summary['test_cases']} test case{'s' if summary['test_cases'] != 1 else ''}, "
        f"{summary['scripts_outdated']} script{'s' if summary['scripts_outdated'] != 1 else ''} outdated"
    )
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="change.impact",
        message=message,
        stage_key=StageKey.change_analysis.value,
        agent_key=AGENT,
        data={"kind": "result", "change_set_key": key, **{k: v for k, v in summary.items() if isinstance(v, int)}},
    )
    return summary


def summarise(items: list[im.Impact] | list[ImpactItem], rec: dict[str, Any]) -> dict[str, Any]:
    def kind(i: Any) -> str:
        return str(i.target_kind.value)

    def action(i: Any) -> str:
        return str(i.action.value)

    def is_open(i: Any) -> bool:
        return getattr(i, "status", ImpactStatus.open) == ImpactStatus.open

    return {
        "total": len(items),
        "open": sum(1 for i in items if is_open(i)),
        "requirements": sum(1 for i in items if kind(i) == "requirement"),
        "test_cases": sum(1 for i in items if kind(i) == "test_case"),
        # Repaired scripts (their item resolved) are no longer outdated.
        "scripts_outdated": sum(1 for i in items if action(i) == "heal" and is_open(i)),
        "defects": sum(1 for i in items if kind(i) == "defect"),
        "review": sum(1 for i in items if action(i) == "review"),
        "gaps": sum(1 for i in items if action(i) == "write_requirement"),
        "must": len(rec.get("must") or []),
        "should": len(rec.get("should") or []),
    }


# ---------------------------------------------------------------- AI: "should run" order only


class AiRegressionOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    must_run: list[str] = Field(max_length=500)
    should_run: list[str] = Field(max_length=500)
    explanation: str = Field(min_length=10, max_length=400)


async def ai_reorder(ctx: AppContext, rec: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    """With AI on, the model may reorder the should-run tests and explain why. It may not drop, add or move a
    must-run test, or name a test that isn't listed: such an answer is rejected and the rule order kept."""
    should = rec.get("should") or []
    if not ctx.llm.enabled or len(should) < 2:
        return rec, None

    def line(p: dict[str, Any]) -> str:
        return f"- {p['key']} {p['title']}: {'; '.join(p.get('reasons') or [])}"

    listing = "MUST RUN (always included, in this order):\n" + "\n".join(line(p) for p in rec.get("must") or [])
    listing += "\n\nSHOULD RUN (order these):\n" + "\n".join(line(p) for p in should)
    task = (
        "A website changed. Order the SHOULD RUN regression tests so the most useful ones come first (tests linked to "
        "high risks and tests on the changed pages first), and explain the order in one or two plain sentences. "
        "Return must_run exactly as listed (every key, none added or removed) and should_run with every listed key "
        "exactly once. Use only the test keys in the list."
    )
    res = await ctx.llm.structured(AiRegressionOrder, task, [UntrustedBlock("regression tests", listing, 8000)])
    usage = res.usage.as_dict() if res.usage else None
    if not res.ok or res.value is None:
        return {**rec, "ai": {"status": "invalid", "issue": "; ".join(res.issues)[:300] or res.reason}}, usage
    v = res.value
    order = im.ai_order(rec, v.must_run, v.should_run)
    known = {str(p["key"]) for p in [*(rec.get("must") or []), *should, *(rec.get("excluded") or [])]}
    unknown = sorted(set(_TC_KEY.findall(v.explanation)) - known)
    if order is None or unknown:
        issue = (
            "The answer named a test that isn't recommended: " + ", ".join(unknown)
            if unknown
            else "The answer dropped, added or moved a must-run test, or didn't list every should-run test once"
        )
        log.info("AI regression order rejected: %s", issue)
        return {**rec, "ai": {"status": "rejected", "issue": issue}}, usage
    by_key = {str(p["key"]): p for p in should}
    return {
        **rec,
        "should": [by_key[k] for k in order],
        "order": "ai",
        "explanation": v.explanation.strip(),
        "ai": {"status": "ok"},
    }, usage


# ---------------------------------------------------------------- closing


async def resolve_reruns(s: AsyncSession, run: ExecutionRun) -> int:
    """Re-run items (tests and the defects they re-test) close when this run, started after the change set, has a
    result for their case. Called by the engine when the run finishes."""
    lineages = {
        str(r.case_lineage_id)
        for r in (await s.execute(select(ExecutionResult).where(ExecutionResult.execution_run_id == run.id))).scalars()
        if r.status in RAN and (r.error or "") not in _not_results()
    }
    if not lineages:
        return 0
    started = run.created_at
    items = list(
        (
            await s.execute(
                select(ImpactItem)
                .join(ChangeSet, ChangeSet.id == ImpactItem.change_set_id)
                .where(
                    ImpactItem.project_id == run.project_id,
                    ImpactItem.status == ImpactStatus.open,
                    ImpactItem.action == ImpactAction.rerun,
                    ChangeSet.created_at <= started,
                )
            )
        ).scalars()
    )
    defect_ids = [uuid.UUID(i.target_ref) for i in items if i.target_kind == ImpactTargetKind.defect]
    defect_cases: dict[str, set[str]] = {}
    if defect_ids:
        for link in (await s.execute(select(DefectLink).where(DefectLink.defect_id.in_(defect_ids)))).scalars():
            if link.test_case_lineage_id is not None:
                defect_cases.setdefault(str(link.defect_id), set()).add(str(link.test_case_lineage_id))
    n = 0
    now = utcnow()
    for i in items:
        cases = defect_cases.get(i.target_ref, set()) if i.target_kind == ImpactTargetKind.defect else {i.target_ref}
        if cases & lineages:
            i.status, i.resolved_by_run_id, i.resolved_at = ImpactStatus.resolved, run.id, now
            n += 1
    return n


def _not_results() -> tuple[str, ...]:
    from app.services.execution import NOT_RESULTS

    return NOT_RESULTS


async def resolve_heals(s: AsyncSession, project_id: uuid.UUID) -> int:
    """Repair items close when the script of their case is valid again in the current bundle."""
    items = list(
        (
            await s.execute(
                select(ImpactItem).where(
                    ImpactItem.project_id == project_id,
                    ImpactItem.status == ImpactStatus.open,
                    ImpactItem.action == ImpactAction.heal,
                )
            )
        ).scalars()
    )
    if not items:
        return 0
    _bundle, scripts = await bundle_locators(s, project_id)
    n = 0
    now = utcnow()
    for i in items:
        sc = scripts.get(i.target_ref)
        if sc is not None and sc.state == "valid":
            i.status, i.resolved_at = ImpactStatus.resolved, now
            n += 1
    return n


async def close(
    s: AsyncSession, project: Project, item: ImpactItem, user: User, status: str, reason: str | None
) -> ImpactItem:
    if item.action not in CLOSABLE:
        raise ValidationFailed(SELF_CLOSING, details=[{"field": "status", "message": SELF_CLOSING}])
    if item.status != ImpactStatus.open:
        who = (await s.execute(select(User).where(User.id == item.resolved_by))).scalar_one_or_none()
        name = (who.full_name or "a team member") if who else "a team member"
        raise Conflict(f"This item was already closed by {name}.")
    text = (reason or "").strip()
    if status == ImpactStatus.no_action.value and not text:
        raise ValidationFailed(NO_ACTION_REASON, details=[{"field": "reason", "message": NO_ACTION_REASON}])
    cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == item.change_set_id))).scalar_one()
    item.status = ImpactStatus(status)
    item.status_reason = text or None
    item.resolved_by = user.id
    item.resolved_at = utcnow()
    audit(
        s,
        org_id=project.organisation_id,
        action="impact_item.closed",
        target_type="impact_item",
        target_id=item.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"change_set": cs.key, "target_kind": item.target_kind.value, "action": item.action.value,
                  "status": status},
    )  # fmt: skip
    return item


# ---------------------------------------------------------------- reading


async def _targets(s: AsyncSession, project_id: uuid.UUID, items: list[ImpactItem]) -> dict[tuple[str, str], Any]:
    """What each item points at, as it is now: {(target_kind, target_ref): row-ish dict}."""
    refs: dict[str, set[str]] = {}
    for i in items:
        refs.setdefault(i.target_kind.value, set()).add(i.target_ref)
    found: dict[tuple[str, str], Any] = {}
    if refs.get("requirement"):
        _run, reqs = await gates.current_requirements(s, project_id)
        for r in reqs:
            if str(r.lineage_id) in refs["requirement"]:
                found[("requirement", str(r.lineage_id))] = {"id": str(r.id), "key": r.key, "title": r.title}
    case_lineages = refs.get("test_case", set()) | refs.get("automation_script", set())
    if case_lineages:
        run = await tds.current_run(s, project_id)
        if run is not None:
            for c in await tds.cases_of(s, run.id):
                if str(c.lineage_id) in case_lineages:
                    found[("test_case", str(c.lineage_id))] = {
                        "id": str(c.id), "key": c.key, "title": c.title,
                        "requirement_lineages": [str(x) for x in c.requirement_lineage_ids or []],
                    }  # fmt: skip
    if refs.get("defect"):
        for x in (
            await s.execute(select(Defect).where(Defect.id.in_([uuid.UUID(r) for r in refs["defect"]])))
        ).scalars():
            found[("defect", str(x.id))] = {"id": str(x.id), "key": x.key, "title": x.summary,
                                             "severity": x.severity.value, "status": x.status.value}  # fmt: skip
    if refs.get("quality_finding"):
        for f in (
            await s.execute(
                select(QualityFinding).where(QualityFinding.id.in_([uuid.UUID(r) for r in refs["quality_finding"]]))
            )
        ).scalars():
            found[("quality_finding", str(f.id))] = {"id": str(f.id), "key": f.key, "title": f.title,
                                                      "severity": f.severity.value, "kind": f.kind.value,
                                                      "status": f.status.value}  # fmt: skip
    if refs.get("performance_target"):
        for p in (
            await s.execute(
                select(PerformanceProfile).where(
                    PerformanceProfile.id.in_([uuid.UUID(r) for r in refs["performance_target"]])
                )
            )
        ).scalars():
            found[("performance_target", str(p.id))] = {"id": str(p.id), "key": p.key, "title": p.name,
                                                         "status": p.status.value}  # fmt: skip
    return found


async def _scripts_now(s: AsyncSession, project_id: uuid.UUID) -> dict[str, AutomationScript]:
    bundle = await asvc.current_run(s, project_id, StageKey.automation)
    if bundle is None:
        return {}
    return {str(x.case_lineage_id): x for x in (await asvc.bundle_rows(s, bundle.id))[0]}


async def _heal_links(s: AsyncSession, project_id: uuid.UUID, cs: ChangeSet) -> dict[str, list[dict[str, Any]]]:
    """Repair suggestions (P6-04) for each outdated script's broken locators, by case lineage: the latest locator
    suggestion for each broken locator (a rejected one is not offered again)."""
    broken: dict[str, list[dict[str, Any]]] = dict(((cs.summary or {}).get("locator_check") or {}).get("broken") or {})
    if not broken:
        return {}
    rows = list(
        (
            await s.execute(
                select(HealSuggestion)
                .where(HealSuggestion.project_id == project_id, HealSuggestion.kind == HealKind.locator)
                .order_by(HealSuggestion.created_at)
            )
        ).scalars()
    )
    latest: dict[tuple[str | None, str | None], HealSuggestion] = {}
    for h in rows:
        latest[(h.file, h.getter)] = h
    # A link to a page the change set removed gets a "Test case needs review" item, never a repair (QA P6-04).
    reviews = (
        await s.execute(
            select(HealSuggestion).where(
                HealSuggestion.project_id == project_id, HealSuggestion.kind == HealKind.expected_result_review
            )
        )
    ).scalars()
    gone: dict[tuple[str, str], HealSuggestion] = {}
    for h in reviews:
        rv = next((c.get("review") for c in h.candidates or [] if isinstance(c, dict) and c.get("meta")), None) or {}
        if rv.get("reason") == "page_removed" and h.test_case_lineage_id:
            gone[(str(h.test_case_lineage_id), str(rv.get("before") or ""))] = h
    outp: dict[str, list[dict[str, Any]]] = {}
    for lineage, locs in broken.items():
        for loc in locs:
            last = latest.get((loc.get("file"), loc.get("getter")))
            outp.setdefault(lineage, [])
            href = _HREF_IN.search(str(loc.get("expression") or ""))
            review = gone.get((lineage, href.group(2))) if href else None
            if last is None and review is not None:
                outp[lineage].append({"id": str(review.id), "key": review.key, "status": PAGE_REMOVED,
                                      "expression": loc.get("expression")})  # fmt: skip
            elif last is not None:
                outp[lineage].append({"id": str(last.id), "key": last.key, "status": last.status.value,
                                      "expression": loc.get("expression")})  # fmt: skip
            else:
                outp[lineage].append({"id": None, "key": None, "status": None, "expression": loc.get("expression")})
    return outp


PAGE_REMOVED = "page_removed"
_HREF_IN = re.compile(r"""a\[href=(["'])(.+?)\1\]""")


def removed_reason(keys: list[str]) -> str:
    return f"Page removed: review or retire the case ({', '.join(keys)})"


def repair_decision(links: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    """(every repair of the script decided, keys of the rejected ones). A locator without a suggestion yet is
    undecided (design P6 OQ3: the run waits until each repair is accepted or rejected)."""
    decided = bool(links) and all(
        x.get("status") in ("accepted", "rejected", "superseded", PAGE_REMOVED) for x in links
    )
    return decided, [str(x["key"]) for x in links if x.get("status") == "rejected"]


def rejected_reason(keys: list[str]) -> str:
    return (
        f"Repair rejected ({', '.join(keys)}): its script is still outdated. Fix the test case or regenerate the "
        "scripts; it isn't part of this run"
    )


def _group(i: ImpactItem, changes: dict[str, ChangeItem]) -> tuple[str, str | None]:
    """The design P6 §7.1 group an item is listed in, and the page it is about."""

    def paths(kinds: tuple[str, ...] = ()) -> list[str]:
        out_: list[str] = []
        for cid in i.change_item_ids or []:
            c = changes.get(str(cid))
            if c is not None and c.page_url and (not kinds or c.kind.value in kinds):
                out_.append(d.path_of(c.page_url))
        return out_

    all_paths = paths()
    first = all_paths[0] if all_paths else None
    if i.target_kind == ImpactTargetKind.coverage_gap:
        return "gaps", first
    if i.target_kind == ImpactTargetKind.defect:
        return "defects", first
    if i.action == ImpactAction.review and i.reason.startswith("Page removed"):
        removed = paths(("page_removed", "page_changed"))
        return "page_removed", removed[0] if removed else first
    if i.target_kind in (ImpactTargetKind.quality_finding, ImpactTargetKind.performance_target):
        return "review", first
    return "requirements", first


async def impact_view(
    s: AsyncSession,
    cs: ChangeSet,
    *,
    level: str | None,
    target_kind: str | None,
    status: str | None,
    see_email: bool,
    can_close: bool,
) -> dict[str, Any]:
    base = {"change_set": {"id": str(cs.id), "key": cs.key}, "generated_by": "rules",
            "permissions": {"can_close": can_close}}  # fmt: skip
    if cs.stage_run_id is None:
        return {**base, "available": False, "reason": NO_IMPACT, "items": [], "counts": None}
    if cs.status != ChangeSetStatus.completed or cs.rerun_recommendation is None:
        reason = cs.error if cs.status == ChangeSetStatus.failed else NOT_READY
        return {**base, "available": False, "reason": reason, "items": [], "counts": None}
    all_items = list(
        (
            await s.execute(select(ImpactItem).where(ImpactItem.change_set_id == cs.id).order_by(ImpactItem.created_at))
        ).scalars()
    )
    q = all_items
    for name, value, enum in (("level", level, "level"), ("target_kind", target_kind, "target_kind"),
                              ("status", status, "status")):  # fmt: skip
        if value:
            allowed = {
                "level": {x.value for x in ImpactLevel},
                "target_kind": {x.value for x in ImpactTargetKind},
                "status": {x.value for x in ImpactStatus},
            }[enum]
            if value not in allowed:
                raise ValidationFailed(f"Unknown {name}", details=[{"field": name, "message": "Unknown"}])
            q = [i for i in q if getattr(i, enum).value == value]
    changes = {
        str(c.id): c for c in (await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars()
    }
    targets = await _targets(s, cs.project_id, all_items)
    scripts = await _scripts_now(s, cs.project_id)
    heals = await _heal_links(s, cs.project_id, cs)
    broken = dict(((cs.summary or {}).get("locator_check") or {}).get("broken") or {})
    users = await out.users(s, [i.resolved_by for i in q])
    run_keys = (
        {
            r.id: r.key
            for r in (
                await s.execute(
                    select(ExecutionRun).where(
                        ExecutionRun.id.in_([i.resolved_by_run_id for i in q if i.resolved_by_run_id])
                    )
                )
            ).scalars()
        }
        if any(i.resolved_by_run_id for i in q)
        else {}
    )

    def one(i: ImpactItem) -> dict[str, Any]:
        group, page = _group(i, changes)
        kind = i.target_kind.value
        target: dict[str, Any] | None
        if kind == "automation_script":
            case = targets.get(("test_case", i.target_ref))
            sc = scripts.get(i.target_ref)
            target = {
                "id": str(sc.id) if sc else None,
                "key": case["key"] if case else None,
                "title": sc.path if sc else None,
                "path": sc.path if sc else None,
                "state": asvc.script_state(sc) if sc else None,
                "outdated_reason": sc.outdated_reason if sc else None,
                "case_lineage_id": i.target_ref,
                "locators": broken.get(i.target_ref, []),
                "heal_suggestions": [x for x in heals.get(i.target_ref, []) if x.get("key")],
            }
        elif kind == "coverage_gap":
            c = changes.get(i.target_ref)
            target = {"id": i.target_ref, "key": None,
                      "title": d.describe(d.Change(c.kind, c.significance, c.page_url, c.before, c.after)) if c else None,
                      "kind": c.kind.value if c else None}  # fmt: skip
        else:
            target = targets.get((kind, i.target_ref))
            if kind == "test_case" and target is not None:
                sc = scripts.get(i.target_ref)
                target = {**target, "script": {"id": str(sc.id), "path": sc.path, "state": asvc.script_state(sc),
                                               "outdated_reason": sc.outdated_reason} if sc else None}  # fmt: skip
        resolver = users.get(i.resolved_by) if i.resolved_by else None
        return {
            "id": str(i.id),
            "target_kind": kind,
            "target_ref": i.target_ref,
            "level": i.level.value,
            "action": i.action.value,
            "reason": i.reason,
            "status": i.status.value,
            "status_reason": i.status_reason,
            "resolved_by": out.person(resolver, see_email=see_email) if resolver else None,
            "resolved_by_run": {"id": str(i.resolved_by_run_id), "key": run_keys.get(i.resolved_by_run_id)}
            if i.resolved_by_run_id
            else None,
            "resolved_at": i.resolved_at.isoformat() if i.resolved_at else None,
            "target": target,
            "changes": [
                {
                    "id": c,
                    "subject": d.describe(
                        d.Change(
                            changes[c].kind,
                            changes[c].significance,
                            changes[c].page_url,
                            changes[c].before,
                            changes[c].after,
                        )
                    ),
                }
                for c in i.change_item_ids or []
                if c in changes
            ],
            "group": group,
            "page": page,
            "can_close": can_close and i.action in CLOSABLE and i.status == ImpactStatus.open,
        }

    counts = summarise(all_items, cs.rerun_recommendation or {})
    counts["by_level"] = {lv: sum(1 for i in all_items if i.level.value == lv) for lv in ("direct", "indirect", "gap")}
    counts["by_status"] = {st.value: sum(1 for i in all_items if i.status == st) for st in ImpactStatus}
    order = {"requirements": 0, "defects": 1, "page_removed": 2, "review": 3, "gaps": 4}
    rows = sorted((one(i) for i in q), key=lambda r: (order[r["group"]], (r["target"] or {}).get("key") or "~",
                                                     r["reason"]))  # fmt: skip
    return {**base, "available": True, "reason": None, "items": rows, "counts": counts}


async def last_durations(s: AsyncSession, project_id: uuid.UUID) -> tuple[dict[str, int], dict[str, str]]:
    """Per case lineage: the duration of its latest result that ran, and the key of that run."""
    rows = (
        await s.execute(
            select(ExecutionResult.case_lineage_id, ExecutionResult.duration_ms, ExecutionResult.status,
                   ExecutionResult.error, ExecutionRun.key)
            .join(ExecutionRun, ExecutionRun.id == ExecutionResult.execution_run_id)
            .where(ExecutionResult.project_id == project_id, ExecutionResult.duration_ms.is_not(None))
            .order_by(ExecutionResult.created_at.desc())
        )
    ).all()  # fmt: skip
    durations: dict[str, int] = {}
    runs: dict[str, str] = {}
    for lineage, ms, status, error, run_key in rows:
        k = str(lineage)
        if k in durations or status not in RAN or (error or "") in _not_results():
            continue
        durations[k], runs[k] = int(ms or 0), run_key
    return durations, runs


async def requested_runs(s: AsyncSession, cs: ChangeSet) -> list[ExecutionRun]:
    runs = (
        await s.execute(
            select(ExecutionRun)
            .where(ExecutionRun.project_id == cs.project_id)
            .order_by(ExecutionRun.created_at.desc())
        )
    ).scalars()
    return [r for r in runs if (r.selection or {}).get("change_set_id") == str(cs.id)]


async def recommendation_view(s: AsyncSession, cs: ChangeSet, *, can_request: bool) -> dict[str, Any]:
    base = {"change_set": {"id": str(cs.id), "key": cs.key}, "permissions": {"can_request": can_request}}
    rec = cs.rerun_recommendation
    if cs.stage_run_id is None:
        return {**base, "available": False, "reason": NO_IMPACT}
    if cs.status != ChangeSetStatus.completed or rec is None:
        return {**base, "available": False, "reason": cs.error if cs.status == ChangeSetStatus.failed else NOT_READY}
    scripts = await _scripts_now(s, cs.project_id)
    states = {lin: im.ScriptState(asvc.script_state(x), x.path, x.outdated_reason) for lin, x in scripts.items()}
    view = im.overlay(rec, states)
    heals = await _heal_links(s, cs.project_id, cs)
    ids = await _case_ids(s, cs.project_id, [str(p["case_lineage_id"]) for g in view.values() for p in g])

    def enrich(p: dict[str, Any], must: bool) -> dict[str, Any]:
        lin = str(p["case_lineage_id"])
        sc = scripts.get(lin)
        why = im.runnable_reason(states.get(lin))
        links = [x for x in heals.get(lin, []) if x.get("key")]
        decided, rejected = repair_decision(heals.get(lin, []))
        if why == im.OUTDATED_SHOULD and decided and rejected:
            why = rejected_reason(rejected)  # OQ3: a rejected repair lifts the block; the test stays listed
        return {
            **p,
            "was_must": False,  # True on a Not included test moved out of Must run (D28, QA P6-04 R3)
            "test_case_id": ids.get(lin),
            "script": {
                "id": str(sc.id),
                "path": sc.path,
                "state": asvc.script_state(sc),
                "outdated_reason": sc.outdated_reason,
                "heal_suggestions": links,
                "repairs_decided": decided,
            }
            if sc
            else None,
            "runnable": why is None,
            "not_runnable_reason": None if why is None else (MUST_MANUAL if why == im.MANUAL and must else why),
        }

    must = [enrich(p, True) for p in view["must"]]
    should = [enrich(p, False) for p in view["should"]]
    excluded = [enrich(p, False) for p in view["excluded"]]
    # D28: a test whose script follows a link to a removed page can't run as written: Not included, "review or
    # retire", with its review item kept open (QA P6-04 R2: nothing to accept or reject, so it never blocks).
    for group in (must, should, excluded):
        for p in list(group):
            gone = [x["key"] for x in heals.get(str(p["case_lineage_id"]), []) if x.get("status") == PAGE_REMOVED]
            if gone and (p["script"] or {}).get("state") == "outdated":
                if group is excluded:
                    p.update(runnable=False, not_runnable_reason=removed_reason(gone))
                    continue
                group.remove(p)
                excluded.append({**p, "runnable": False, "not_runnable_reason": removed_reason(gone),
                                 "was_must": group is must})  # fmt: skip
    durations, runs_of = await last_durations(s, cs.project_id)
    # Every automated test the run would include, also must-run ones that can't run until their repair is decided.
    must_run = [p["case_lineage_id"] for p in must if p["script"] is not None]
    should_run = [p["case_lineage_id"] for p in should]
    used = [runs_of[x] for x in [*must_run, *should_run] if x in runs_of]
    key_of = {p["case_lineage_id"]: p["key"] for p in [*must, *should]}
    no_history = [key_of[x] for x in [*must_run, *should_run] if x not in durations]
    # OQ3: the run waits while a must-run test's script is outdated and its repairs aren't all decided (accepted or
    # rejected). After a reject the test stays in Must run, not runnable, with the reason.
    outdated = [
        p for p in must if (p["script"] or {}).get("state") == "outdated" and not p["script"].get("repairs_decided")
    ]
    requested = await requested_runs(s, cs)
    return {
        **base,
        "available": True,
        "reason": None,
        "order": rec.get("order", "rules"),
        "explanation": rec.get("explanation"),
        "must": must,
        "should": should,
        "excluded": excluded,
        "estimate": {
            "must_seconds": im.estimate(must_run, durations),
            "with_should_seconds": im.estimate([*must_run, *should_run], durations),
            "must_tests": len(must_run),
            "with_should_tests": len(must_run) + len(should_run),
            "from_run_key": max(used) if used else None,
            "no_history": no_history,
        },
        "blocked": {
            "outdated": len(outdated),
            "message": outdated_message(len(outdated)),
            "case_keys": [p["key"] for p in outdated],
        }
        if outdated
        else None,
        "requested_runs": [
            {
                "id": str(r.id),
                "key": r.key,
                "status": r.status.value,
                "include_should": bool((r.selection or {}).get("include_should")),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in requested
        ],
    }


MUST_MANUAL = "Manual test: a person runs it (not part of the automated run)"


def outdated_message(n: int) -> str:
    return (
        f"{n} must-run test{'s' if n != 1 else ''} {'have' if n != 1 else 'has an'} outdated "
        f"script{'s' if n != 1 else ''}. Accept or reject {'their' if n != 1 else 'its'} repair "
        f"suggestion{'s' if n != 1 else ''} first."
    )


async def _case_ids(s: AsyncSession, project_id: uuid.UUID, lineages: list[str]) -> dict[str, str]:
    run = await tds.current_run(s, project_id)
    if run is None or not lineages:
        return {}
    wanted = set(lineages)
    return {str(c.lineage_id): str(c.id) for c in await tds.cases_of(s, run.id) if str(c.lineage_id) in wanted}


# ---------------------------------------------------------------- requesting the run (G7 as before)


async def request_run(
    ctx: AppContext, s: AsyncSession, project: Project, cs: ChangeSet, user: User, *, include_should: bool
) -> ExecutionRun:
    """The recommended tests as a run waiting for G7 (P4-05/P4-06 unchanged). Nothing contacts the site here."""
    from app.services import execution as xsvc

    view = await recommendation_view(s, cs, can_request=True)
    if not view["available"]:
        raise Conflict(str(view["reason"]))
    outdated = [p for p in view["must"] if p["key"] in set((view["blocked"] or {}).get("case_keys") or [])]
    if outdated:
        named = ", ".join(
            f"{p['key']} ({p['script']['path']}: "
            + (
                ", ".join(h["key"] for h in p["script"]["heal_suggestions"] if h.get("status") == "open")
                or "repair suggestion not ready yet"
            )
            + ")"
            for p in outdated
        )
        message = f"{outdated_message(len(outdated))} {named}."
        raise ValidationFailed(message, details=[{"field": "must", "message": message,
                                                   "case_keys": [p["key"] for p in outdated]}])  # fmt: skip
    keys = [p["key"] for p in view["must"] if p["runnable"]]
    if include_should:
        keys += [p["key"] for p in view["should"] if p["runnable"]]
    if not keys:
        raise Conflict("None of the recommended tests can run automatically. A person runs the manual ones.")
    run = await xsvc.create_run(
        ctx, s, project, user, suite=None, case_keys=keys, browsers=["chromium"], viewports=["desktop"],
        notes=f"Regression run recommended by {cs.key}",
    )  # fmt: skip
    run.selection = {**(run.selection or {}), "change_set_id": str(cs.id), "change_set_key": cs.key,
                     "include_should": include_should}  # fmt: skip
    audit(
        s,
        org_id=project.organisation_id,
        action="regression_run.requested",
        target_type="execution_run",
        target_id=run.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"change_set": cs.key, "run": run.key, "include_should": include_should, "case_keys": keys},
    )
    return run


async def set_extras(s: AsyncSession, cs: ChangeSet) -> dict[str, Any]:
    """Impact and regression counts for the change set card (design P6 §6.1, §6.4)."""
    if cs.stage_run_id is None or cs.rerun_recommendation is None:
        return {"impact": None, "regression": None, "repairs": None}
    items = list((await s.execute(select(ImpactItem).where(ImpactItem.change_set_id == cs.id))).scalars())
    counts = summarise(items, cs.rerun_recommendation)
    runs = await requested_runs(s, cs)
    latest = runs[0] if runs else None
    ids = select(ChangeItem.id).where(ChangeItem.change_set_id == cs.id)
    heal_rows = list((await s.execute(select(HealSuggestion).where(HealSuggestion.change_item_id.in_(ids)))).scalars())
    return {
        "impact": counts,
        "repairs": {
            "total": len(heal_rows),
            "open": sum(1 for h in heal_rows if h.status == HealStatus.open),
            "decided": sum(1 for h in heal_rows if h.status != HealStatus.open),
        },
        "regression": {
            "must": counts["must"],
            "should": counts["should"],
            "requested_run": {"id": str(latest.id), "key": latest.key, "status": latest.status.value}
            if latest
            else None,
        },
    }
