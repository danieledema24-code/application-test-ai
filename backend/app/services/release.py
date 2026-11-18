"""Release readiness assessments and Gate 9 (P6-05a; decisions D32, D33; design P6 §10).

`assess` takes a snapshot of stored evidence (the G4 strategy's exit criteria, Definition of Done results, the latest
result per approved case, defects and their G8 state, the risk register, the latest non-functional checks and load
test, change sets and their impact since the last final assessment, repair suggestions, exploratory sessions), runs
the coded rules (`app.domain.release.criteria`) and stores one `release_assessments` row (REL-0001) waiting for G9.
With AI on, the model may only write a labelled narrative ("What this means") with placeholders for figures; one that
claims another verdict or writes a number is rejected and the rule text used. It never changes the verdict, a status,
a condition or residual risk.

Any later execution result, defect change, finding triage or rescan marks an assessment that is still waiting for G9
`stale` (`mark_stale`); a stale assessment can't be decided (409). A new assessment supersedes earlier ones that
weren't decided; history is kept. G9 (`can_approve`): approve, reject (with a reason) or override to a different
verdict with a reason of at least 20 characters, shown as "Overridden by {name}: {reason}". Recorded in
`gate_decisions` (G9, subject `release_assessment`) and the audit log.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, NotFound, ValidationFailed
from app.context import AppContext
from app.db.models import (
    ChangeItem,
    ChangeSet,
    EntityRevision,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    HealSuggestion,
    ImpactItem,
    ManualRetest,
    Project,
    QualityFinding,
    QualityScan,
    ReadinessCriterion,
    ReleaseAssessment,
    StageRun,
    TestStrategy,
    User,
    WorkflowStage,
)
from app.db.types import utcnow
from app.domain.enums import (
    AssessmentDecision,
    AssessmentStatus,
    ChangeSetStatus,
    FindingStatus,
    GateDecisionKind,
    GateKey,
    GateStatus,
    GateSubjectType,
    GeneratedBy,
    HealKind,
    HealStatus,
    ImpactAction,
    ImpactLevel,
    ImpactStatus,
    ItemStatus,
    ManualRetestStatus,
    QualityScanKind,
    ReadinessKind,
    ReadinessStatus,
    RequirementStatus,
    ResultStatus,
    RunStatus,
    StageKey,
    StageStatus,
    Verdict,
)
from app.domain.release import criteria as rc
from app.llm.base import UntrustedBlock
from app.services import gates
from app.services import serialize_p2 as out
from app.services.audit import audit

log = logging.getLogger(__name__)

AGENT = "reporting"
STALE_DEFAULT = "Evidence changed after this assessment: assess again"
STALE_409 = "Evidence changed after this assessment: assess again"
OVERRIDE_MIN = 20
OVERRIDE_REASON = "Write at least 20 characters. The reason is shown next to the verdict."
OVERRIDE_SAME = "Choose a final verdict different from the recommendation."
OVERRIDE_VERDICT = "Choose a final verdict."
REJECT_REASON = "Say why. The reason is shown on the assessment."
CONFIRM_REASON = "Say how it was confirmed."
CONFIRM_STATUS = "Choose Met or Not met."
RAN_STATUSES = frozenset({ResultStatus.passed, ResultStatus.failed, ResultStatus.error, ResultStatus.flaky})
SCAN_DONE = ("completed", "partial", "cancelled")


# ---------------------------------------------------------------- the snapshot


def _when(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _aware(value: datetime | None) -> datetime | None:
    return value if value is None or value.tzinfo else value.replace(tzinfo=UTC)


async def _strategy_criteria(s: AsyncSession, project_id: uuid.UUID) -> tuple[int | None, list[str], dict[str, Any]]:
    """The exit criteria of the strategy as approved at G4 (its revision when it was edited since)."""
    g4 = await gates.last_approval(s, project_id, GateKey.G4)
    if g4 is None:
        return None, [], {}
    from app.services.testdesign import snapshot_items

    item = next(iter(snapshot_items(g4, "test_strategy")), None)
    content: dict[str, Any] | None = None
    version: int | None = None
    if item is not None:
        strat = (
            await s.execute(select(TestStrategy).where(TestStrategy.id == uuid.UUID(str(item["id"]))))
        ).scalar_one_or_none()
        if strat is not None:
            version = int(item.get("version") or strat.version)
            if strat.version == version:
                content = dict(strat.content or {})
            else:
                rev = (
                    await s.execute(
                        select(EntityRevision).where(
                            EntityRevision.entity_type == "test_strategy",
                            EntityRevision.entity_id == strat.id,
                            EntityRevision.version == version,
                        )
                    )
                ).scalar_one_or_none()
                content = dict(((rev.snapshot or {}).get("sections") if rev else None) or strat.content or {})
    if content is None:
        _run, strat_now = await gates.current_strategy(s, project_id)
        content = dict(strat_now.content or {}) if strat_now is not None else {}
    texts = []
    for x in content.get("exit_criteria") or []:
        text = str(x.get("text") if isinstance(x, dict) else x or "").strip()
        if text:
            texts.append(text)
    run_version = int((g4.stage_run_versions or {}).get("test_strategy") or 0) or version or 1
    return run_version, texts, {"version": run_version, "strategy_version": version, "g4_decision_id": str(g4.id)}


async def _results_since(s: AsyncSession, project_id: uuid.UUID, lineages: list[str], since: datetime) -> set[str]:
    """Case lineages with a result (that ran) from a run created at or after `since` (the P6-02 re-run rule)."""
    from app.services.execution import NOT_RESULTS

    if not lineages:
        return set()
    rows = (
        await s.execute(
            select(ExecutionResult.case_lineage_id, ExecutionResult.status, ExecutionResult.error)
            .join(ExecutionRun, ExecutionRun.id == ExecutionResult.execution_run_id)
            .where(
                ExecutionResult.project_id == project_id,
                ExecutionResult.case_lineage_id.in_([uuid.UUID(x) for x in lineages]),
                ExecutionRun.created_at >= since,
            )
        )
    ).all()
    return {str(lin) for lin, st, err in rows if st in RAN_STATUSES and (err or "") not in NOT_RESULTS}


async def latest_manual_retests(s: AsyncSession, change_set_id: uuid.UUID) -> dict[uuid.UUID, ManualRetest]:
    """D37: the latest recorded manual re-test per case lineage of a change set."""
    rows = (
        await s.execute(
            select(ManualRetest).where(ManualRetest.change_set_id == change_set_id).order_by(ManualRetest.created_at)
        )
    ).scalars()
    return {r.case_lineage_id: r for r in rows}


def _change_path(project_id: uuid.UUID, key: str, tab: str) -> str:
    return f"/projects/{project_id}/discovery/changes/{key}?tab={tab}"


async def _changes(
    s: AsyncSession, project_id: uuid.UUID, snap: rc.Snapshot, case_keys: dict[str, str]
) -> dict[str, Any]:
    """Change sets since the last final assessment (must-run tests, `was_must`) and every open review, gap, "Test case
    needs review" and repair item."""
    from app.services import impact as impact_svc

    last_final = (
        await s.execute(
            select(ReleaseAssessment)
            .where(ReleaseAssessment.project_id == project_id, ReleaseAssessment.status == AssessmentStatus.final)
            .order_by(ReleaseAssessment.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    sets = list(
        (
            await s.execute(
                select(ChangeSet)
                .where(
                    ChangeSet.project_id == project_id,
                    ChangeSet.stage_run_id.is_not(None),
                    ChangeSet.status == ChangeSetStatus.completed,
                )
                .order_by(ChangeSet.created_at)
            )
        ).scalars()
    )
    snap.latest_change_at = _aware(sets[-1].created_at) if sets else None
    cutoff = _aware(last_final.created_at) if last_final is not None else None
    since = [cs for cs in sets if cutoff is None or (_aware(cs.created_at) or cutoff) > cutoff]
    snap.change_sets = [cs.key for cs in since]
    for cs in since:
        rec = await impact_svc.recommendation_view(s, cs, can_request=False)
        if not rec.get("available"):
            continue
        musts = list(rec.get("must") or [])
        ran = await _results_since(s, project_id, [str(p["case_lineage_id"]) for p in musts], cs.created_at)
        by_hand = {str(k): r for k, r in (await latest_manual_retests(s, cs.id)).items()}
        for p in musts:
            lin = str(p["case_lineage_id"])
            manual = p.get("not_runnable_reason") == impact_svc.MUST_MANUAL
            got = by_hand.get(lin) if manual else None
            snap.must.append(rc.MustPick(cs.key, lin, str(p["key"]), rerun=lin in ran or got is not None,
                                         manual=manual, manual_result=got.status.value if got else None,
                                         manual_note=got.note if got else None))  # fmt: skip
        for p in rec.get("excluded") or []:
            if p.get("was_must"):
                snap.must.append(rc.MustPick(cs.key, str(p["case_lineage_id"]), str(p["key"]),
                                             excluded_reason=str(p.get("not_runnable_reason") or "not included")))  # fmt: skip
    # Open review and gap impact items (D27 "impact reviewed"), from any rescan's change set.
    rows = (
        await s.execute(
            select(ImpactItem, ChangeSet.key)
            .join(ChangeSet, ChangeSet.id == ImpactItem.change_set_id)
            .where(
                ImpactItem.project_id == project_id,
                ImpactItem.status == ImpactStatus.open,
                ChangeSet.stage_run_id.is_not(None),
                or_(ImpactItem.action == ImpactAction.review, ImpactItem.level == ImpactLevel.gap),
            )
            .order_by(ChangeSet.created_at, ImpactItem.created_at)
        )
    ).all()
    targets = await impact_svc._targets(s, project_id, [i for i, _k in rows]) if rows else {}
    for i, cs_key in rows:
        target = targets.get((i.target_kind.value, i.target_ref)) or {}
        key = str(target.get("key") or "")
        text = i.reason if not key or key in i.reason else f"{key}: {i.reason}"
        kind = "gap" if i.level == ImpactLevel.gap else "review"
        snap.open_items.append(rc.OpenItem(kind, key or cs_key, f"{text} ({cs_key})", {
            "type": "impact_item", "id": str(i.id), "key": key or cs_key, "label": f"{text} ({cs_key})",
            "path": _change_path(project_id, cs_key, "impact"),
        }))  # fmt: skip
    # Open repair suggestions and "Test case needs review" items (P6-04).
    heals = (
        await s.execute(
            select(HealSuggestion, ChangeSet.key)
            .outerjoin(ChangeItem, ChangeItem.id == HealSuggestion.change_item_id)
            .outerjoin(ChangeSet, ChangeSet.id == ChangeItem.change_set_id)
            .where(HealSuggestion.project_id == project_id, HealSuggestion.status == HealStatus.open)
            .order_by(HealSuggestion.created_at)
        )
    ).all()
    for h, cs_key in heals:
        where = f" ({cs_key})" if cs_key else ""
        path = _change_path(project_id, cs_key, "repairs") if cs_key else f"/projects/{project_id}/automation"
        if h.kind == HealKind.expected_result_review:
            meta: dict[str, Any] = next((c for c in h.candidates or [] if c.get("meta")), {})
            review = dict(meta.get("review") or {})
            case = str(review.get("case_key") or case_keys.get(str(h.test_case_lineage_id), "") or "a test case")
            text = f"Review {case}: test case needs review ({h.key}){where}"
            snap.open_items.append(rc.OpenItem("case_review", h.key, text, {
                "type": "heal_suggestion", "id": str(h.id), "key": h.key, "label": text, "path": path}))  # fmt: skip
        else:
            what = f"{(h.file or '').rsplit('/', 1)[-1]}: {h.old_expression}" if h.old_expression else h.file or ""
            text = f"Accept or reject {h.key} ({what}){where}"
            snap.open_items.append(rc.OpenItem("repair", h.key, text, {
                "type": "heal_suggestion", "id": str(h.id), "key": h.key, "label": text, "path": path}))  # fmt: skip
    return {
        "change_sets": snap.change_sets,
        "last_final": last_final.key if last_final is not None else None,
        "latest_change_set": sets[-1].key if sets else None,
    }


async def _exploratory(s: AsyncSession, project_id: uuid.UUID, snap: rc.Snapshot) -> list[str]:
    scans = list(
        (
            await s.execute(
                select(QualityScan)
                .where(QualityScan.project_id == project_id, QualityScan.kind == QualityScanKind.exploratory)
                .order_by(QualityScan.created_at)
            )
        ).scalars()
    )
    snap.exploratory_sessions = [x.key for x in scans if x.status.value in SCAN_DONE]
    if snap.exploratory_sessions:
        for f in (
            await s.execute(
                select(QualityFinding)
                .where(
                    QualityFinding.project_id == project_id,
                    QualityFinding.kind == QualityScanKind.exploratory,
                    QualityFinding.status == FindingStatus.open,
                )
                .order_by(QualityFinding.key)
            )
        ).scalars():
            snap.exploratory_open.append(rc.Finding(f.key, f.severity.value, str(f.id)))
    return snap.exploratory_sessions


async def _dod(s: AsyncSession, project_id: uuid.UUID, facts: Any) -> list[rc.DodResult]:
    from app.services.readiness import evaluate_row

    st = (
        await s.execute(
            select(WorkflowStage).where(
                WorkflowStage.project_id == project_id, WorkflowStage.stage_key == StageKey.readiness_criteria
            )
        )
    ).scalar_one_or_none()
    if st is None or st.current_stage_run_id is None:
        return []
    rows = (
        await s.execute(
            select(ReadinessCriterion)
            .where(
                ReadinessCriterion.stage_run_id == st.current_stage_run_id,
                ReadinessCriterion.kind == ReadinessKind.dod,
                ReadinessCriterion.status == ReadinessStatus.active,
            )
            .order_by(ReadinessCriterion.sort_order, ReadinessCriterion.key)
        )
    ).scalars()
    found: list[rc.DodResult] = []
    for r in rows:
        ev = evaluate_row(r, facts) or {"status": "unknown", "detail": rc.CANT_CHECK}
        status = str(ev.get("status"))
        if status == "not_applicable":
            continue
        rule = r.check_rule_id
        if rule is None:
            from app.agents.readiness.rules import text_rule_for

            rule = text_rule_for(r.kind, r.text)
        found.append(rc.DodResult(r.key, r.text, status, str(ev.get("detail") or ""), rule, str(r.id)))
    return found


async def build_snapshot(s: AsyncSession, project_id: uuid.UUID) -> tuple[rc.Snapshot, dict[str, Any]]:
    """Everything the rules look at, read once, plus the scope recorded with the assessment."""
    from app.services import readiness
    from app.services import traceability as trace

    now = utcnow()
    snap = rc.Snapshot(assessed_at=now)
    version, texts, strategy = await _strategy_criteria(s, project_id)
    snap.strategy_version, snap.exit_criteria = version, texts
    try:
        t = await trace.load(s, project_id, "approved")
        approved = True
    except NotFound:
        t = await trace.load(s, project_id)
        approved = False
    reqs = {r.id: r for r in t.lk.requirements.values()}
    snap.requirements = {
        str(r.lineage_id): rc.Requirement(str(r.lineage_id), r.key, tuple(str(f) for f in r.feature_ids or []))
        for r in reqs.values()
        if r.status != RequirementStatus.rejected
    }
    snap.acs = sorted(
        (
            rc.Ac(lin, a.key, str(a.id))
            for lin, a in t.lk.acs.items()
            if a.status == ItemStatus.approved
            and (req := reqs.get(a.requirement_id)) is not None
            and req.status == RequirementStatus.approved
        ),
        key=lambda a: a.key,
    )
    case_keys: dict[str, str] = {}
    if approved:
        for v in t.cases:
            res = t.result(v) or {}
            sc = t.script(v) or {}
            lin = str(v.row.lineage_id)
            case_keys[lin] = v.key
            snap.cases.append(rc.Case(
                lin, v.key, tuple(v.requirement_lineages), tuple(v.ac_lineages), res.get("status"),
                _when(res.get("at")), res.get("run_key"), sc.get("state"), sc.get("path"), str(v.row.id),
            ))  # fmt: skip
    snap.defects = [rc.Defect(str(d["key"]), str(d["severity"]), str(d["status"]), d.get("id")) for d in t.all_defects]
    srun, _strat = await gates.current_strategy(s, project_id)
    if srun is not None:
        people = await out.users(s, [r.updated_by for r in t.risks if r.status.value == "accepted"])
        snap.risks = [
            rc.Risk(
                r.key, r.title, r.level.value, r.status.value,
                tuple(str(x) for x in r.requirement_lineage_ids or []), tuple(str(x) for x in r.feature_ids or []),
                r.status_comment, (people[r.updated_by].full_name or "someone") if r.updated_by in people else None,
                str(r.id),
            )
            for r in sorted(t.risks, key=lambda x: x.key)
        ]  # fmt: skip
    changes = await _changes(s, project_id, snap, case_keys)
    sessions = await _exploratory(s, project_id, snap)
    facts = await readiness.load_facts(s, project_id)
    snap.nf = dict(facts.nf)
    snap.dod = await _dod(s, project_id, facts)
    runs = list(
        (
            await s.execute(
                select(ExecutionRun.key)
                .where(
                    ExecutionRun.project_id == project_id,
                    ExecutionRun.status.in_([RunStatus.passed, RunStatus.failed]),
                )
                .order_by(ExecutionRun.created_at)
            )
        ).scalars()
    )
    scope: dict[str, Any] = {
        "assessed_at": now.isoformat(),
        "strategy": strategy or None,
        "design": {"approved": approved, "version": t.design_version, "g5_hash": t.snapshot_hash},
        "runs": runs,
        "latest_run": runs[-1] if runs else None,
        **changes,
        "defects": {d.key: d.status for d in snap.defects},
        "exploratory_sessions": sessions,
        "accessibility_scan": (snap.nf.get("accessibility") or {}).get("scan_key"),
        "security_scan": (snap.nf.get("security") or {}).get("scan_key"),
        "performance_run": (snap.nf.get("performance") or {}).get("run_key"),
        "cases": len(snap.cases),
        "risks": None if snap.risks is None else len(snap.risks),
    }
    return snap, scope


def snapshot_hash(scope: dict[str, Any], criteria: list[dict[str, Any]]) -> str:
    body = {k: v for k, v in scope.items() if k not in ("assessed_at", "hash")}
    body["criteria"] = [(c["id"], c["status"], c["detail"]) for c in criteria]
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


# ---------------------------------------------------------------- AI narrative (labelled; never the verdict)


class AiNarrative(BaseModel):
    model_config = ConfigDict(extra="forbid")
    narrative: str = Field(min_length=20, max_length=800)


async def ai_narrative(
    ctx: AppContext, verdict: str, criteria: list[dict[str, Any]], conds: list[dict[str, Any]], overall: str | None
) -> tuple[dict[str, Any], Any]:
    """`ai_sections` for the assessment: {} with AI off; else the narrative (AI, or the rule text when the model's
    answer was invalid or claimed something the rules didn't decide) and what happened to the AI's answer."""
    if not ctx.llm.enabled:
        return {}, None
    c = rc.counts(criteria)
    values = rc.narrative_values(verdict, len(conds), c, overall)
    listing = "\n".join(f"- [{x['status']}{', blocking' if x['blocking'] else ''}] {x['text']}" for x in criteria)
    listing += "\nConditions:\n" + "\n".join(f"- {x['text']}" for x in conds[:40])
    task = (
        "Explain in two or three plain sentences, for a reader with no QA background, what this release readiness "
        f"assessment means. The verdict was decided by rules and is final for you: it is {values['verdict']}. "
        "Do not state or "
        "suggest any other verdict, do not change any status, and never write a number: write the placeholders "
        + ", ".join("{" + p + "}" for p in rc.PLACEHOLDERS)
        + " where a value belongs. Use only the criteria and conditions in the data."
    )
    res = await ctx.llm.structured(AiNarrative, task, [UntrustedBlock("assessment criteria", listing, 6000)])
    usage = res.usage.as_dict() if res.usage else None
    rule_text = rc.rule_narrative(verdict, len(conds), c["blocking_not_met"])
    if not res.ok or res.value is None:
        return {"narrative": {"text": rule_text, "generated_by": "rules"},
                "ai": {"status": "invalid", "reason": "The AI answer didn't pass validation"}}, usage  # fmt: skip
    why = rc.check_narrative(res.value.narrative, verdict)
    if why is not None:
        return {"narrative": {"text": rule_text, "generated_by": "rules"},
                "ai": {"status": "rejected", "reason": f"Rejected: {why}"}}, usage  # fmt: skip
    return {"narrative": {"text": rc.fill_narrative(res.value.narrative, values), "generated_by": "ai"},
            "ai": {"status": "ok", "reason": None}}, usage  # fmt: skip


# ---------------------------------------------------------------- creating an assessment (the stage handler)


async def assess(
    ctx: AppContext, s: AsyncSession, project: Project, run: StageRun
) -> tuple[ReleaseAssessment, list[ReleaseAssessment], Any]:
    """Evaluates and stores a new assessment for `run`; earlier undecided ones are superseded. A retried task reuses
    its row. Returns (assessment, superseded, llm usage)."""
    from app.services.counters import next_key

    snap, scope = await build_snapshot(s, project.id)
    criteria = rc.evaluate(snap)
    verdict = rc.verdict(criteria)
    conds = rc.conditions(criteria)
    risks, overall = rc.residual(snap)
    scope["hash"] = snapshot_hash(scope, criteria)
    scope["reason"] = rc.reason(criteria, verdict, len(conds))
    sections, usage = await ai_narrative(ctx, verdict, criteria, conds, overall)
    row = (
        await s.execute(select(ReleaseAssessment).where(ReleaseAssessment.stage_run_id == run.id))
    ).scalar_one_or_none()
    if row is None:
        _n, key = await next_key(s, project.organisation_id, project.id, "release_assessment")
        row = ReleaseAssessment(organisation_id=project.organisation_id, project_id=project.id, key=key,
                                stage_run_id=run.id, recommendation=Verdict(verdict), created_by=run.triggered_by)  # fmt: skip
        s.add(row)
    row.status = AssessmentStatus.awaiting_approval
    row.recommendation = Verdict(verdict)
    row.criteria = criteria
    row.conditions = conds
    row.residual_risks = risks
    row.overall_residual = overall
    row.scope = scope
    row.stale_reason = None
    ai_used = (sections.get("narrative") or {}).get("generated_by") == "ai"
    row.generated_by = GeneratedBy.mixed if ai_used else GeneratedBy.rules
    row.ai_sections = sections
    await s.flush()
    older = list(
        (
            await s.execute(
                select(ReleaseAssessment).where(
                    ReleaseAssessment.project_id == project.id,
                    ReleaseAssessment.id != row.id,
                    ReleaseAssessment.status.in_([AssessmentStatus.awaiting_approval, AssessmentStatus.stale]),
                )
            )
        ).scalars()
    )
    for o in older:
        o.status = AssessmentStatus.superseded
        o.scope = {**(o.scope or {}), "superseded_by": row.key}
    audit(
        s,
        org_id=project.organisation_id,
        action="release_assessment.created",
        target_type="release_assessment",
        target_id=row.id,
        actor_user_id=run.triggered_by,
        project_id=project.id,
        metadata={"key": row.key, "recommendation": verdict, "conditions": len(conds),
                  "superseded": [o.key for o in older], "generated_by": row.generated_by.value},
    )  # fmt: skip
    return row, older, usage


# ---------------------------------------------------------------- stale (evidence changed)


async def mark_stale(s: AsyncSession, project_id: uuid.UUID, reason: str) -> int:
    """Marks the assessment waiting for G9 `stale` (design P6 §10.3: "Evidence changed after this assessment") and its
    stage with it. Called inside the caller's transaction whenever evidence changes: an execution run finishing, a
    defect raised or changed, a finding triaged, a rescan started."""
    rows = list(
        (
            await s.execute(
                select(ReleaseAssessment).where(
                    ReleaseAssessment.project_id == project_id,
                    ReleaseAssessment.status == AssessmentStatus.awaiting_approval,
                )
            )
        ).scalars()
    )
    for a in rows:
        a.status = AssessmentStatus.stale
        a.stale_reason = reason[:500]
    if rows:
        await s.execute(
            update(WorkflowStage)
            .where(
                WorkflowStage.project_id == project_id,
                WorkflowStage.stage_key == StageKey.release_readiness,
                WorkflowStage.status == StageStatus.awaiting_approval,
            )
            .values(status=StageStatus.stale, stale_reason=STALE_DEFAULT, gate_status=GateStatus.none)
            .execution_options(synchronize_session=False)
        )
    return len(rows)


def when_text(at: datetime | None = None) -> str:
    return (at or utcnow()).astimezone(UTC).strftime("%-d %b %Y, %H:%M UTC")


# ---------------------------------------------------------------- reading


async def load(s: AsyncSession, assessment_id: uuid.UUID) -> ReleaseAssessment:
    row = (await s.execute(select(ReleaseAssessment).where(ReleaseAssessment.id == assessment_id))).scalar_one_or_none()
    if row is None:
        raise NotFound("Release assessment not found")
    return row


async def history(s: AsyncSession, project_id: uuid.UUID) -> list[ReleaseAssessment]:
    return list(
        (
            await s.execute(
                select(ReleaseAssessment)
                .where(ReleaseAssessment.project_id == project_id)
                .order_by(ReleaseAssessment.created_at.desc(), ReleaseAssessment.key.desc())
            )
        ).scalars()
    )


def _final(a: ReleaseAssessment) -> str | None:
    return a.final_verdict.value if a.final_verdict is not None else None


def state_word(a: ReleaseAssessment) -> str:
    """Design P6 §3.7: the verdict is always followed by its state word."""
    if a.status == AssessmentStatus.final:
        return "final"
    if a.status == AssessmentStatus.awaiting_approval:
        return "recommended"
    return "not_decided"


def override_line(a: ReleaseAssessment, decider: str | None) -> str | None:
    if a.decision != AssessmentDecision.override:
        return None
    return f"Overridden by {decider or 'someone'}: {a.override_reason}"


def not_decidable(a: ReleaseAssessment) -> str | None:
    if a.status == AssessmentStatus.stale:
        return STALE_409
    if a.status == AssessmentStatus.superseded:
        by = (a.scope or {}).get("superseded_by")
        return f"Replaced by {by}. This assessment can't be decided." if by else "This assessment was replaced."
    if a.status in (AssessmentStatus.final, AssessmentStatus.rejected):
        return "This assessment was already decided."
    return None


def summary_dict(a: ReleaseAssessment, people: dict[uuid.UUID, User], *, see_email: bool) -> dict[str, Any]:
    decider = people.get(a.decided_by) if a.decided_by else None
    name = decider.full_name if decider else None
    return {
        "id": str(a.id),
        "key": a.key,
        "status": a.status.value,
        "recommendation": a.recommendation.value,
        "final_verdict": _final(a),
        "verdict": _final(a) or a.recommendation.value,
        "verdict_state": state_word(a),
        "decision": a.decision.value if a.decision else None,
        "decided_by": out.person(decider, see_email=see_email),
        "decided_at": a.decided_at.isoformat() if a.decided_at else None,
        "override_line": override_line(a, name),
        "conditions": len(a.conditions or []),
        "overall_residual": a.overall_residual,
        "stale_reason": a.stale_reason,
        "superseded_by": (a.scope or {}).get("superseded_by"),
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "assessed_at": (a.scope or {}).get("assessed_at"),
    }


def _changes_since(a: ReleaseAssessment, prev: ReleaseAssessment | None) -> dict[str, Any]:
    """Design P6 §10.1 "What changed since the last assessment" (the previous assessment, any status)."""
    if prev is None:
        return {"previous": None, "text": "This is the first assessment."}
    now, then = a.scope or {}, prev.scope or {}
    before = {c["id"]: c for c in prev.criteria or []}
    crit = [
        {"id": c["id"], "text": c["text"], "from": before[c["id"]]["status"], "to": c["status"]}
        for c in a.criteria or []
        if c["id"] in before and before[c["id"]]["status"] != c["status"]
    ]
    old_defects = dict(then.get("defects") or {})
    defects = [
        {"key": k, "from": old_defects.get(k), "to": v}
        for k, v in sorted((now.get("defects") or {}).items())
        if old_defects.get(k) != v
    ]
    return {
        "previous": {
            "id": str(prev.id),
            "key": prev.key,
            "created_at": prev.created_at.isoformat() if prev.created_at else None,
            "recommendation": prev.recommendation.value,
            "final_verdict": _final(prev),
            "status": prev.status.value,
        },
        "recommendation": {"from": prev.recommendation.value, "to": a.recommendation.value},
        "change_sets": [k for k in now.get("change_sets") or [] if k not in (then.get("change_sets") or [])],
        "runs": [k for k in now.get("runs") or [] if k not in (then.get("runs") or [])],
        "defects": defects,
        "exploratory_sessions": [
            k for k in now.get("exploratory_sessions") or [] if k not in (then.get("exploratory_sessions") or [])
        ],
        "criteria": crit,
        "text": None,
    }


def _with_paths(project_id: uuid.UUID, refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    fixed = []
    for r in refs or []:
        if r.get("path"):
            fixed.append(r)
            continue
        kind, key = str(r.get("type")), str(r.get("key"))
        path = (
            f"/projects/{project_id}/discovery/changes/{key}"
            if kind == "change_set"
            else out.path(project_id, kind, key)
        )
        fixed.append({**r, "path": path})
    return fixed


async def assessment_dict(
    s: AsyncSession, a: ReleaseAssessment, *, see_email: bool, can_assess: bool, can_decide: bool
) -> dict[str, Any]:
    """`GET /release-assessments/{id}`: everything P6-05b shows and P6-05c reports."""
    rows = await history(s, a.project_id)
    prev = next((x for x in rows if (x.created_at, x.key) < (a.created_at, a.key)), None)
    latest = rows[0] if rows else a
    ids: list[uuid.UUID | None] = [a.created_by, a.decided_by]
    for c in a.criteria or []:
        who = (c.get("confirmed_by") or {}).get("id")
        if who:
            ids.append(uuid.UUID(str(who)))
    people = await out.users(s, ids)
    base = summary_dict(a, people, see_email=see_email)
    decider = people.get(a.decided_by) if a.decided_by else None
    criteria = []
    for c in a.criteria or []:
        who = (c.get("confirmed_by") or {}).get("id")
        person = people.get(uuid.UUID(str(who))) if who else None
        criteria.append({
            **{k: v for k, v in c.items() if k not in ("conditions", "short", "confirmed_by")},
            "evidence_refs": _with_paths(a.project_id, c.get("evidence_refs") or []),
            "source_label": _source_label(c, (a.scope or {}).get("strategy")),
            "confirmed_by": out.person(person, see_email=see_email) if person else c.get("confirmed_by"),
            "can_confirm": bool(c.get("confirmable")) and can_assess and a.status == AssessmentStatus.awaiting_approval,
        })  # fmt: skip
    assessed = _when((a.scope or {}).get("assessed_at")) or _aware(a.created_at)
    why_not = not_decidable(a)
    return {
        **base,
        "reason": (a.scope or {}).get("reason"),
        "statement": rc.RELEASE_STATEMENT.format(time=when_text(assessed)),
        "criteria": criteria,
        "counts": rc.counts(a.criteria or []),
        "conditions_list": [
            {**x, "evidence_refs": _with_paths(a.project_id, x.get("evidence_refs") or [])} for x in a.conditions or []
        ],
        "residual_risks": [{**r, "risk": _with_paths(a.project_id, [r["risk"]])[0]} for r in a.residual_risks or []],
        "override_reason": a.override_reason,
        "decision_record": _decision_record(a, decider),
        "created_by": out.person(people.get(a.created_by) if a.created_by else None, see_email=see_email),
        "generated_by": a.generated_by.value,
        "ai_sections": a.ai_sections or {},
        "scope": {k: v for k, v in (a.scope or {}).items() if k not in ("reason",)},
        "changes_since": _changes_since(a, prev),
        "is_latest": latest.id == a.id,
        "latest": {"id": str(latest.id), "key": latest.key},
        "decidable": why_not is None,
        "not_decidable_reason": why_not,
        "permissions": {
            "can_decide": can_decide and why_not is None,
            "can_confirm": can_assess and a.status == AssessmentStatus.awaiting_approval,
            "can_assess": can_assess,
        },
    }


def _source_label(c: dict[str, Any], strategy: dict[str, Any] | None) -> str:
    if c.get("source") == "exit_criterion":
        v = (strategy or {}).get("version")
        return f"Exit criterion (Test Strategy v{v})" if v else "Exit criterion"
    if c.get("source") == "dod":
        return "Definition of Done"
    return "Platform check"


def _decision_record(a: ReleaseAssessment, decider: User | None) -> dict[str, Any] | None:
    if a.decision is None:
        return None
    name = (decider.full_name if decider else None) or "someone"
    at = a.decided_at.isoformat() if a.decided_at else None
    label = rc.VERDICT_LABEL.get(_final(a) or "", "")
    if a.decision == AssessmentDecision.reject:
        text = f"Rejected by {name}: '{a.override_reason}'. Assess again when ready."
    elif a.decision == AssessmentDecision.override:
        text = (
            f"Final verdict: {label} · Overridden by {name}: '{a.override_reason}' · recommended: "
            f"{rc.VERDICT_LABEL[a.recommendation.value]}"
        )
    else:
        text = f"Final verdict: {label} · approved by {name}"
    return {"decision": a.decision.value, "by": name, "at": at, "text": text}


# ---------------------------------------------------------------- a person's result for a criterion


async def confirm(
    s: AsyncSession, a: ReleaseAssessment, criterion_id: str, user: User, *, status: str | None, reason: str | None
) -> tuple[str, str]:
    """Records `met`/`not_met` for a criterion the platform can't check (strategy or DoD, never a platform check) and
    works the recommendation out again. Returns (old verdict, new verdict)."""
    text = (reason or "").strip()
    errors = []
    if status not in (rc.MET, rc.NOT_MET):
        errors.append({"field": "status", "message": CONFIRM_STATUS})
    if not text:
        errors.append({"field": "reason", "message": CONFIRM_REASON})
    criteria = [dict(c) for c in a.criteria or []]
    c = next((x for x in criteria if x.get("id") == criterion_id), None)
    if c is None:
        raise NotFound("Criterion not found")
    if errors:
        raise ValidationFailed(errors[0]["message"], details=errors)
    if not c.get("confirmable"):
        raise Conflict("The platform checks this criterion itself; it can't be confirmed by a person")
    why = not_decidable(a)
    if why is not None:
        raise Conflict(why if a.status != AssessmentStatus.stale else STALE_409)
    assert status is not None
    rc.apply_manual(c, rc.Manual(status, text[:1000], user.full_name or "someone", str(user.id), utcnow().isoformat()))
    old = a.recommendation.value
    verdict, conds, sentence = rc.recompute(criteria)
    a.criteria = criteria
    a.conditions = conds
    a.recommendation = Verdict(verdict)
    a.scope = {**(a.scope or {}), "reason": sentence}
    if verdict != old and (a.ai_sections or {}).get("narrative"):
        # The AI's narrative described the old verdict: the rule text replaces it.
        c_ = rc.counts(criteria)
        a.ai_sections = {**a.ai_sections, "narrative": {"text": rc.rule_narrative(verdict, len(conds),
                                                                                   c_["blocking_not_met"]),
                                                         "generated_by": "rules"}}  # fmt: skip
    audit(
        s,
        org_id=a.organisation_id,
        action="exit_criterion.confirmed",
        target_type="release_assessment",
        target_id=a.id,
        actor_user_id=user.id,
        project_id=a.project_id,
        metadata={"key": a.key, "criterion": criterion_id, "text": c["text"], "status": status, "reason": text[:1000],
                  "recommendation": {"from": old, "to": verdict}},
    )  # fmt: skip
    return old, verdict


# ---------------------------------------------------------------- Gate 9 (D33)


def validate_decision(a: ReleaseAssessment, decision: str, final_verdict: str | None, reason: str | None) -> str:
    """422s for a G9 body; returns the cleaned reason."""
    text = (reason or "").strip()
    if decision == "override":
        if final_verdict is None:
            raise ValidationFailed(OVERRIDE_VERDICT, details=[{"field": "final_verdict", "message": OVERRIDE_VERDICT}])
        if final_verdict == a.recommendation.value:
            raise ValidationFailed(OVERRIDE_SAME, details=[{"field": "final_verdict", "message": OVERRIDE_SAME}])
        if len(text) < OVERRIDE_MIN:
            raise ValidationFailed(OVERRIDE_REASON, details=[{"field": "reason", "message": OVERRIDE_REASON}])
    elif decision == "reject":
        if not text:
            raise ValidationFailed(REJECT_REASON, details=[{"field": "reason", "message": REJECT_REASON}])
    elif final_verdict is not None and final_verdict != a.recommendation.value:
        msg = "To choose a different verdict, override the recommendation with a reason."
        raise ValidationFailed(msg, details=[{"field": "final_verdict", "message": msg}])
    return text


async def decide(
    s: AsyncSession, a: ReleaseAssessment, user: User, *, decision: str, final_verdict: str | None, reason: str
) -> None:
    """Records G9 on `a` (already validated): the assessment, its stage, `gate_decisions` and the audit log."""
    why = not_decidable(a)
    if why is not None:
        raise Conflict(why)
    now = utcnow()
    new_status = AssessmentStatus.rejected if decision == "reject" else AssessmentStatus.final
    final = None if decision == "reject" else (final_verdict if decision == "override" else a.recommendation.value)
    # Claim the decision: of two requests that both read "waiting", only the first changes the row.
    claimed = await s.execute(
        update(ReleaseAssessment)
        .where(ReleaseAssessment.id == a.id, ReleaseAssessment.status == AssessmentStatus.awaiting_approval)
        .values(
            status=new_status,
            decision=AssessmentDecision(decision),
            final_verdict=Verdict(final) if final else None,
            override_reason=reason or None,
            decided_by=user.id,
            decided_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    if getattr(claimed, "rowcount", 1) != 1:
        raise Conflict("This assessment was decided or changed meanwhile; reload to see it")
    await s.refresh(a)
    st = (
        await s.execute(
            select(WorkflowStage).where(
                WorkflowStage.project_id == a.project_id, WorkflowStage.stage_key == StageKey.release_readiness
            )
        )
    ).scalar_one()
    if a.stage_run_id is not None and st.current_stage_run_id == a.stage_run_id:
        stage_status = StageStatus.changes_requested if decision == "reject" else StageStatus.approved
        st.status = stage_status
        st.gate_status = GateStatus.rejected if decision == "reject" else GateStatus.approved
        st.updated_by = user.id
        run = (await s.execute(select(StageRun).where(StageRun.id == a.stage_run_id))).scalar_one_or_none()
        if run is not None:
            run.status = stage_status
    s.add(
        GateDecision(
            organisation_id=a.organisation_id,
            project_id=a.project_id,
            gate_key=GateKey.G9,
            stage_run_id=a.stage_run_id,
            decision=GateDecisionKind.reject if decision == "reject" else GateDecisionKind.approve,
            comment=reason,
            decided_by=user.id,
            agent_recommendation={
                "recommendation": a.recommendation.value,
                "final_verdict": final,
                "decision": decision,
                "overridden": decision == "override",
            },
            artefact_snapshot={"items": [{"type": "release_assessment", "id": str(a.id), "key": a.key}]},
            snapshot_hash=(a.scope or {}).get("hash"),
            subject_type=GateSubjectType.release_assessment,
            subject_id=a.id,
        )
    )
    action = {"approve": "decided", "reject": "decided", "override": "overridden"}[decision]
    audit(
        s,
        org_id=a.organisation_id,
        action=f"release_assessment.{action}",
        target_type="release_assessment",
        target_id=a.id,
        actor_user_id=user.id,
        project_id=a.project_id,
        metadata={"key": a.key, "decision": decision, "recommendation": a.recommendation.value,
                  "final_verdict": final, "reason": reason or None},
    )  # fmt: skip


def decided_message(a: ReleaseAssessment) -> str:
    if a.decision == AssessmentDecision.reject:
        return f"{a.key} rejected."
    label = rc.VERDICT_LABEL[_final(a) or a.recommendation.value]
    if a.decision == AssessmentDecision.override:
        return f"{a.key} overridden: {label} is final."
    return f"{a.key}: {label} is final."


# ---------------------------------------------------------------- manual re-tests (D37)

MANUAL_NOTE = "Add a note: what you did and what you saw."
MANUAL_STATUS = "Choose Passed or Failed."


async def _manual_picks(s: AsyncSession, cs: ChangeSet) -> list[dict[str, Any]]:
    """The change set's impacted manual must-run tests (its regression recommendation, D28)."""
    from app.services import impact as impact_svc

    rec = await impact_svc.recommendation_view(s, cs, can_request=False)
    if not rec.get("available"):
        raise Conflict(str(rec.get("reason") or f"{cs.key} has no regression recommendation"))
    return [p for p in rec.get("must") or [] if p.get("not_runnable_reason") == impact_svc.MUST_MANUAL]


def _retest_dict(r: ManualRetest, people: dict[uuid.UUID, User], *, see_email: bool) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "status": r.status.value,
        "note": r.note,
        "recorded_by": out.person(people.get(r.recorded_by), see_email=see_email),
        "recorded_at": r.created_at.isoformat() if r.created_at else None,
    }


async def manual_retests_view(s: AsyncSession, cs: ChangeSet, *, see_email: bool, can_record: bool) -> dict[str, Any]:
    """`GET /change-sets/{id}/manual-retests`: each impacted manual must-run test with its latest recorded result and
    the history (newest first)."""
    picks = await _manual_picks(s, cs)
    rows = list(
        (
            await s.execute(
                select(ManualRetest).where(ManualRetest.change_set_id == cs.id).order_by(ManualRetest.created_at.desc())
            )
        ).scalars()
    )
    people = await out.users(s, [r.recorded_by for r in rows])
    items = []
    for p in picks:
        mine = [r for r in rows if str(r.case_lineage_id) == str(p["case_lineage_id"])]
        hist = [_retest_dict(r, people, see_email=see_email) for r in mine]
        items.append({
            "case_key": p["key"], "title": p.get("title"), "test_case_id": str(p["test_case_id"]),
            "case_lineage_id": str(p["case_lineage_id"]), "reasons": p.get("reasons") or [],
            "latest": hist[0] if hist else None, "history": hist,
        })  # fmt: skip
    recorded = sum(1 for i in items if i["latest"])
    return {
        "change_set": {"id": str(cs.id), "key": cs.key},
        "items": items,
        "counts": {"total": len(items), "recorded": recorded, "open": len(items) - recorded},
        "permissions": {"can_record": can_record},
    }


async def record_manual_retest(
    s: AsyncSession, project: Project, cs: ChangeSet, user: User, *, case_key: str, status: str | None,
    note: str | None,
) -> ManualRetest:  # fmt: skip
    """Records a person's result for an impacted manual must-run test of `cs` (D37). Audited; an assessment waiting
    for G9 goes stale (it is new evidence for `rr.impacted_rerun`)."""
    errors = []
    if status not in ("passed", "failed"):
        errors.append({"field": "status", "message": MANUAL_STATUS})
    if not (note or "").strip():
        errors.append({"field": "note", "message": MANUAL_NOTE})
    if errors:
        raise ValidationFailed(errors[0]["message"], details=errors)
    pick = next((p for p in await _manual_picks(s, cs) if p["key"] == case_key), None)
    if pick is None:
        msg = f"{case_key} isn't a manual must-run test of {cs.key}."
        raise ValidationFailed(msg, details=[{"field": "case_key", "message": msg}])
    row = ManualRetest(
        organisation_id=project.organisation_id,
        project_id=project.id,
        change_set_id=cs.id,
        case_lineage_id=uuid.UUID(str(pick["case_lineage_id"])),
        test_case_id=uuid.UUID(str(pick["test_case_id"])),
        status=ManualRetestStatus(str(status)),
        note=(note or "").strip(),
        recorded_by=user.id,
    )
    s.add(row)
    await s.flush()
    audit(
        s,
        org_id=project.organisation_id,
        action="manual_retest.recorded",
        target_type="manual_retest",
        target_id=row.id,
        actor_user_id=user.id,
        project_id=project.id,
        metadata={"change_set": cs.key, "case": case_key, "status": status},
    )
    await mark_stale(s, project.id, f"Manual re-test of {case_key} recorded ({status})")
    return row
