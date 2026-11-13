"""Phase 3 test-design services: current rows, link tables, derived risk/priority and lint, G5 gate rules.

Derived fields (risk level and score, derived priority, lint) are recomputed without a version bump and are
excluded from the G5 snapshot, so they never reopen a gate.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    NO_AC,
    AcceptanceCriterion,
    GateDecision,
    Project,
    ProjectSecret,
    Requirement,
    Risk,
    StageRun,
    TestCase,
    TestCondition,
    TestData,
    WorkflowStage,
    condition_requirements,
    test_case_data,
    test_case_requirements,
)
from app.domain.enums import (
    CaseStatus,
    ExpectedResultStatus,
    GateKey,
    ItemStatus,
    Priority,
    RequirementStatus,
    RiskStatus,
    StageKey,
    StageStatus,
    TestDataStatus,
)
from app.domain.testdesign import lint as lint_rules
from app.domain.testdesign import priority as prio
from app.services import gates

ACTIVE_CASE = (CaseStatus.draft, CaseStatus.approved)
NOT_RUN_YET = "Execution arrives in Phase 4"
UNAVAILABLE = {
    "available": False,
    "available_from_phase": 4,
    "message": "Available after test execution (Phase 4)",
}


def unavailable(message: str = "Available after test execution (Phase 4)") -> dict[str, Any]:
    return {**UNAVAILABLE, "message": message}


async def design_stage(s: AsyncSession, project_id: uuid.UUID) -> WorkflowStage:
    return (
        await s.execute(
            select(WorkflowStage).where(
                WorkflowStage.project_id == project_id, WorkflowStage.stage_key == StageKey.test_design
            )
        )
    ).scalar_one()


async def current_run(s: AsyncSession, project_id: uuid.UUID) -> StageRun | None:
    st = await design_stage(s, project_id)
    if st.current_stage_run_id is None:
        return None
    run = await s.get(StageRun, st.current_stage_run_id)
    if run is None or run.finished_at is None:
        return None
    return run


async def run_by_version(s: AsyncSession, project_id: uuid.UUID, version: int | None) -> StageRun | None:
    if version is None:
        return await current_run(s, project_id)
    st = await design_stage(s, project_id)
    return (
        await s.execute(select(StageRun).where(StageRun.workflow_stage_id == st.id, StageRun.version == version))
    ).scalar_one_or_none()


async def cases_of(s: AsyncSession, run_id: uuid.UUID) -> list[TestCase]:
    return list((await s.execute(select(TestCase).where(TestCase.stage_run_id == run_id))).scalars())


async def conditions_of(s: AsyncSession, run_id: uuid.UUID) -> list[TestCondition]:
    return list((await s.execute(select(TestCondition).where(TestCondition.stage_run_id == run_id))).scalars())


async def data_of(s: AsyncSession, run_id: uuid.UUID) -> list[TestData]:
    return list((await s.execute(select(TestData).where(TestData.stage_run_id == run_id))).scalars())


# ------------------------------------------------------------------ link tables


def _uuids(raw: Sequence[Any] | None) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    for x in raw or []:
        try:
            u = uuid.UUID(str(x))
        except ValueError:
            continue
        if u not in out:
            out.append(u)
    return out


async def link_condition(s: AsyncSession, row: TestCondition, ac_parent: dict[uuid.UUID, uuid.UUID]) -> None:
    await s.execute(condition_requirements.delete().where(condition_requirements.c.test_condition_id == row.id))
    await _insert_links(s, condition_requirements, "test_condition_id", row, ac_parent)


async def link_case(s: AsyncSession, row: TestCase, ac_parent: dict[uuid.UUID, uuid.UUID]) -> None:
    await s.execute(test_case_requirements.delete().where(test_case_requirements.c.test_case_id == row.id))
    await _insert_links(s, test_case_requirements, "test_case_id", row, ac_parent)
    await s.execute(test_case_data.delete().where(test_case_data.c.test_case_id == row.id))
    for lid in _uuids(row.data_lineage_ids):
        await s.execute(insert(test_case_data).values(test_case_id=row.id, test_data_lineage_id=lid))


async def _insert_links(s: AsyncSession, table: Any, col: str, row: Any, ac_parent: dict[uuid.UUID, uuid.UUID]) -> None:
    reqs = _uuids(row.requirement_lineage_ids)
    pairs: set[tuple[uuid.UUID, uuid.UUID]] = {(r, NO_AC) for r in reqs}
    for ac in _uuids(row.ac_lineage_ids):
        parent = ac_parent.get(ac)
        if parent is not None:
            pairs.add((parent, ac))
    for req, ac in sorted(pairs):
        await s.execute(
            insert(table).values(**{col: row.id, "requirement_lineage_id": req, "acceptance_criterion_lineage_id": ac})
        )


async def ac_parents(s: AsyncSession, project_id: uuid.UUID) -> dict[uuid.UUID, uuid.UUID]:
    """AC lineage -> requirement lineage for the current requirements version."""
    run, reqs = await gates.current_requirements(s, project_id)
    if run is None:
        return {}
    by_id = {r.id: r.lineage_id for r in reqs}
    rows = (
        await s.execute(
            select(AcceptanceCriterion.lineage_id, AcceptanceCriterion.requirement_id).where(
                AcceptanceCriterion.stage_run_id == run.id
            )
        )
    ).all()
    return {lin: by_id[rid] for lin, rid in rows if rid in by_id}


# ------------------------------------------------------------------ derived risk, priority and lint


async def risk_facts(s: AsyncSession, project_id: uuid.UUID) -> list[prio.RiskFact]:
    run, _strat = await gates.current_strategy(s, project_id)
    if run is None:
        return []
    out = []
    for r in (await s.execute(select(Risk).where(Risk.stage_run_id == run.id))).scalars():
        out.append(
            prio.RiskFact(
                str(r.lineage_id),
                r.key,
                r.level.value,
                r.score,
                r.status.value,
                frozenset(str(x) for x in r.requirement_lineage_ids or []),
                frozenset(str(x) for x in r.feature_ids or []),
            )
        )
    return out


@dataclass
class LintContext:
    data: dict[str, TestData]  # lineage -> row (same run)
    requirements: dict[str, Requirement]  # lineage -> current row
    in_scope_types: frozenset[str] | None
    feature_by_requirement: dict[str, list[str]]


async def lint_context(s: AsyncSession, project_id: uuid.UUID, run_id: uuid.UUID) -> LintContext:
    _rrun, reqs = await gates.current_requirements(s, project_id)
    _srun, strat = await gates.current_strategy(s, project_id)
    types = None
    if strat is not None:
        types = (
            frozenset(str(t.get("type")) for t in (strat.content or {}).get("test_types", []) if t.get("in_scope"))
            or None
        )
    return LintContext(
        data={str(d.lineage_id): d for d in await data_of(s, run_id)},
        requirements={str(r.lineage_id): r for r in reqs},
        in_scope_types=types,
        feature_by_requirement={str(r.lineage_id): [str(f) for f in r.feature_ids or []] for r in reqs},
    )


def case_facts(c: TestCase, ctx: LintContext, duplicate_of: str | None) -> lint_rules.CaseFacts:
    data = []
    for lid in c.data_lineage_ids or []:
        d = ctx.data.get(str(lid))
        if d is None:
            continue
        data.append(
            lint_rules.DataFact(
                d.key,
                d.kind.value,
                d.value_type.value,
                d.value,
                d.secret_ref,
                d.field_label,
                (d.form_ref or {}).get("field_type"),
                d.status.value,
            )
        )
    rejected = [
        ctx.requirements[str(lid)].key
        for lid in c.requirement_lineage_ids or []
        if str(lid) in ctx.requirements and ctx.requirements[str(lid)].status == RequirementStatus.rejected
    ]
    oq = c.open_question_ref or {}
    return lint_rules.CaseFacts(
        title=c.title,
        objective=c.objective,
        steps=list(c.steps or []),
        expected_result=c.expected_result,
        expected_result_status=c.expected_result_status.value,
        technique=c.technique,
        test_type=c.test_type,
        requirement_count=len(c.requirement_lineage_ids or []),
        data=data,
        open_question_message=oq.get("message"),
        open_question_key=oq.get("key"),
        has_coverage_item=bool((c.design_basis_ref or {}).get("coverage_item")),
        in_scope_types=ctx.in_scope_types,
        rejected_requirement_keys=rejected,
        duplicate_of=duplicate_of,
        priority_override=c.priority_override.value if c.priority_override else None,
        derived_priority=c.derived_priority.value,
        risk_level=c.risk_level,
    )


def _data_keys(c: TestCase) -> list[str]:
    return [str(x) for x in c.data_lineage_ids or []]


async def refresh_derived(
    s: AsyncSession, project_id: uuid.UUID, run_id: uuid.UUID, *, only: Sequence[TestCase] | None = None
) -> int:
    """Recomputes risk level/score, derived priority and lint for the run's cases. Returns how many cases changed
    priority. No version bump, no revision, no gate reopen."""
    cases = await cases_of(s, run_id)
    risks = await risk_facts(s, project_id)
    ctx = await lint_context(s, project_id, run_id)
    targets = {c.id for c in only} if only is not None else {c.id for c in cases}
    sigs: dict[str, str] = {}
    for c in sorted(cases, key=lambda x: x.key):
        if c.status in (CaseStatus.rejected, CaseStatus.deprecated):
            continue
        sig = lint_rules.signature(list(c.steps or []), _data_keys(c), c.expected_result)
        sigs.setdefault(sig, c.key)
    changed = 0
    for c in cases:
        if c.id not in targets:
            continue
        feats: set[str] = set()
        for lid in c.requirement_lineage_ids or []:
            feats.update(ctx.feature_by_requirement.get(str(lid), []))
        top = prio.top_risk(risks, {str(x) for x in c.requirement_lineage_ids or []}, feats)
        level = top.level if top else None
        derived = Priority(prio.derived_priority(level))
        if (c.risk_level, c.risk_score, c.derived_priority) != (level, top.score if top else None, derived):
            if c.derived_priority != derived:
                changed += 1
            c.risk_level = level
            c.risk_score = top.score if top else None
            c.risk_lineage_id = uuid.UUID(top.lineage_id) if top else None
            c.derived_priority = derived
        sig = lint_rules.signature(list(c.steps or []), _data_keys(c), c.expected_result)
        dup = sigs.get(sig)
        dup_of = dup if dup is not None and dup != c.key and c.status in ACTIVE_CASE else None
        c.lint = lint_rules.lint_case(case_facts(c, ctx, dup_of))
        c.lint_rules_version = lint_rules.LINT_RULES_VERSION
    await s.flush()
    return changed


async def recompute_priorities(s: AsyncSession, project_id: uuid.UUID) -> int:
    """Risk writes and G4 approval: recompute derived fields on the current design (and a pending candidate)."""
    total = 0
    st = await design_stage(s, project_id)
    run_ids = [st.current_stage_run_id] if st.current_stage_run_id else []
    pending = (
        await s.execute(
            select(StageRun.id).where(
                StageRun.workflow_stage_id == st.id,
                StageRun.review_status == "pending_review",
                StageRun.finished_at.is_not(None),
            )
        )
    ).scalars()
    run_ids += [r for r in pending if r not in run_ids]
    for rid in run_ids:
        if rid is not None:
            total += await refresh_derived(s, project_id, rid)
    return total


async def ensure_lint_current(s: AsyncSession, project_id: uuid.UUID, run_id: uuid.UUID) -> None:
    """Re-lints on read when the rules version changed since the cases were linted."""
    stale = (
        await s.execute(
            select(TestCase.id)
            .where(TestCase.stage_run_id == run_id, TestCase.lint_rules_version != lint_rules.LINT_RULES_VERSION)
            .limit(1)
        )
    ).first()
    if stale is not None:
        await refresh_derived(s, project_id, run_id)


# ------------------------------------------------------------------ G5


async def g5_snapshot(s: AsyncSession, project_id: uuid.UUID) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Approved cases plus their conditions and the test data items they use (`{type, id, version}`)."""
    run = await current_run(s, project_id)
    if run is None:
        return [], {}
    cases = [c for c in await cases_of(s, run.id) if c.status == CaseStatus.approved]
    conds = {str(c.lineage_id): c for c in await conditions_of(s, run.id)}
    data = {str(d.lineage_id): d for d in await data_of(s, run.id)}
    items: list[dict[str, Any]] = [{"type": "test_case", "id": str(c.id), "version": c.version} for c in cases]
    seen: set[str] = set()
    for c in cases:
        if c.condition_lineage_id and str(c.condition_lineage_id) in conds:
            cond = conds[str(c.condition_lineage_id)]
            if str(cond.id) not in seen:
                seen.add(str(cond.id))
                items.append({"type": "test_condition", "id": str(cond.id), "version": cond.version})
        for lid in c.data_lineage_ids or []:
            d = data.get(str(lid))
            if d is not None and str(d.id) not in seen:
                seen.add(str(d.id))
                items.append({"type": "test_data", "id": str(d.id), "version": d.version})
    return items, {"test_design": run.version}


async def approved_requirements(s: AsyncSession, project_id: uuid.UUID) -> list[Requirement]:
    _run, reqs = await gates.current_requirements(s, project_id)
    return [r for r in reqs if r.status == RequirementStatus.approved]


async def g5_preconditions(s: AsyncSession, project: Project) -> list[gates.Precondition]:
    pid = project.id
    base = f"/projects/{pid}/test-cases"
    out: list[gates.Precondition] = []
    strat_stage = await gates._stage(s, pid, StageKey.test_strategy)
    g4_ok = await gates.gate_satisfied(s, project, strat_stage)
    run = await current_run(s, pid)
    last_g4 = await gates.last_approval(s, pid, GateKey.G4)
    built_from = (run.approved_input or {}).get("strategy_snapshot_hash") if run else None
    matches = built_from is not None and (last_g4 is None or last_g4.snapshot_hash in (None, built_from))
    design_st = await design_stage(s, pid)
    fresh = design_st.status != StageStatus.stale
    ok = g4_ok and matches and fresh
    out.append(
        gates.Precondition(
            "g4_approved",
            ok,
            True,
            "Test strategy approval (G4) is approved, and these cases were designed from it"
            if ok
            else (
                "Test strategy approval (G4) must be approved first"
                if not g4_ok
                else "The strategy changed after these test cases were designed: regenerate them first"
            ),
            f"/projects/{pid}/test-strategy?tab=review",
        )
    )
    cases = await cases_of(s, run.id) if run else []
    approved = [c for c in cases if c.status == CaseStatus.approved]
    out.append(
        gates.Precondition(
            "approved_case",
            bool(approved),
            True,
            f"{len(approved)} test case(s) approved" if approved else "Approve at least one test case first",
            f"{base}?status=approved",
        )
    )
    bad = sorted(c.key for c in approved if lint_rules.blocking(list(c.lint or [])))
    out.append(
        gates.Precondition(
            "approved_lint_errors",
            not bad,
            True,
            "No approved case has checks you must fix"
            if not bad
            else f"{len(bad)} approved case(s) have checks you must fix: {', '.join(bad[:5])}",
            f"{base}?status=approved&lint=error",
        )
    )
    open_q = sorted(
        c.key
        for c in cases
        if c.status in ACTIVE_CASE and c.expected_result_status == ExpectedResultStatus.open_question
    )
    # Design P3 §2 blocker 5 (decision D1): an unresolved open question blocks G5, also on drafts.
    out.append(
        gates.Precondition(
            "open_questions",
            not open_q,
            True,
            "No test case has an open question"
            if not open_q
            else f"{len(open_q)} test case(s) have an open question: {', '.join(open_q[:5])}",
            f"{base}?open_question=true",
        )
    )
    uncovered, accepted = await high_risk_gaps(s, pid, cases)
    out.append(
        gates.Precondition(
            "high_risk_covered",
            not uncovered,
            True,
            "Every approved requirement linked to an open high or very high risk has an approved test case"
            if not uncovered
            else "; ".join(
                f"{u['risk'].key} ({u['risk'].level.value.replace('_', ' ')}) is open and "
                f"{', '.join(r.key for r in u['requirements'])} "
                f"{'has' if len(u['requirements']) == 1 else 'have'} no approved test case"
                for u in uncovered[:5]
            ),
            f"/projects/{pid}/traceability?tab=gaps",
        )
    )
    if accepted:
        out.append(
            gates.Precondition(
                "accepted_risks",
                True,
                False,
                "Accepted risks (not tested): "
                + "; ".join(f"{a['risk'].key}: {a['risk'].status_comment or 'no comment'}" for a in accepted[:5]),
                f"/projects/{pid}/test-strategy?tab=risks",
            )
        )
    drafts = [c for c in cases if c.status == CaseStatus.draft]
    out.append(
        gates.Precondition(
            "drafts_remaining",
            not drafts,
            False,
            "No drafts remain"
            if not drafts
            else f"{len(drafts)} draft(s) will be left out of the approved set until they are approved",
            f"{base}?status=draft",
        )
    )
    reqs = await approved_requirements(s, pid)
    covered = {str(lid) for c in approved for lid in c.requirement_lineage_ids or []}
    no_case = [r.key for r in reqs if str(r.lineage_id) not in covered]
    out.append(
        gates.Precondition(
            "requirements_without_case",
            not no_case,
            False,
            "Every approved requirement has an approved test case"
            if not no_case
            else f"{len(no_case)} approved requirement(s) have no approved test case: {', '.join(no_case[:5])}",
            f"/projects/{pid}/traceability?tab=gaps",
        )
    )
    acs_uncovered = await acs_without_case(s, pid, [c for c in cases if c.status in ACTIVE_CASE])
    out.append(
        gates.Precondition(
            "acs_without_case",
            not acs_uncovered,
            False,
            "Every approved acceptance criterion has a test case"
            if not acs_uncovered
            else f"{len(acs_uncovered)} approved acceptance criteria have no test case",
            f"/projects/{pid}/traceability?tab=gaps",
        )
    )
    draft_errors = sorted(c.key for c in drafts if any(i.get("severity") == "error" for i in c.lint or []))
    out.append(
        gates.Precondition(
            "drafts_with_errors",
            not draft_errors,
            False,
            "No draft has checks you must fix"
            if not draft_errors
            else f"{len(draft_errors)} draft(s) have checks you must fix: {', '.join(draft_errors[:5])}",
            f"{base}?status=draft&lint=error",
        )
    )
    warn = sorted(
        c.key
        for c in approved
        if any(i.get("severity") == "warning" and not i.get("blocks_approval") for i in c.lint or [])
    )
    out.append(
        gates.Precondition(
            "approved_lint_warnings",
            not warn,
            False,
            "No approved case has advice"
            if not warn
            else f"{len(warn)} approved case(s) have advice: {', '.join(warn[:5])}",
            f"{base}?status=approved&lint=warning",
        )
    )
    return out


async def high_risk_gaps(
    s: AsyncSession, project_id: uuid.UUID, cases: list[TestCase] | None = None, *, approved_only: bool = True
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Open high/very-high risks whose approved requirements lack an approved case; accepted ones separately."""
    run, _strat = await gates.current_strategy(s, project_id)
    if run is None:
        return [], []
    if cases is None:
        drun = await current_run(s, project_id)
        cases = await cases_of(s, drun.id) if drun else []
    reqs = {str(r.lineage_id): r for r in await approved_requirements(s, project_id)}
    covered = {
        str(lid)
        for c in cases
        if (c.status == CaseStatus.approved if approved_only else c.status in ACTIVE_CASE)
        for lid in c.requirement_lineage_ids or []
    }
    uncovered: list[dict[str, Any]] = []
    accepted: list[dict[str, Any]] = []
    risks = (await s.execute(select(Risk).where(Risk.stage_run_id == run.id).order_by(Risk.key))).scalars()
    for r in risks:
        if r.level.value not in ("high", "very_high"):
            continue
        linked = [reqs[str(lid)] for lid in r.requirement_lineage_ids or [] if str(lid) in reqs]
        if r.feature_ids:
            fids = {str(f) for f in r.feature_ids}
            linked += [q for q in reqs.values() if fids & {str(f) for f in q.feature_ids or []} and q not in linked]
        missing = sorted((q for q in linked if str(q.lineage_id) not in covered), key=lambda q: q.key)
        if not missing:
            continue
        if r.status == RiskStatus.accepted:
            accepted.append({"risk": r, "requirements": missing})
        elif r.status == RiskStatus.open:
            uncovered.append({"risk": r, "requirements": missing})
    return uncovered, accepted


async def acs_without_case(s: AsyncSession, project_id: uuid.UUID, cases: list[TestCase]) -> list[AcceptanceCriterion]:
    reqs = await approved_requirements(s, project_id)
    if not reqs:
        return []
    acs = list(
        (
            await s.execute(
                select(AcceptanceCriterion)
                .where(
                    AcceptanceCriterion.requirement_id.in_([r.id for r in reqs]),
                    AcceptanceCriterion.status == ItemStatus.approved,
                )
                .order_by(AcceptanceCriterion.key)
            )
        ).scalars()
    )
    covered = {str(x) for c in cases for x in c.ac_lineage_ids or []}
    return [a for a in acs if str(a.lineage_id) not in covered]


async def g5_recommendation(s: AsyncSession, project: Project) -> dict[str, Any]:
    pre = await g5_preconditions(s, project)
    reasons = [p.message for p in pre if not p.met]
    if gates.blockers(pre):
        rec = "do_not_proceed"
    elif reasons:
        rec = "proceed_with_caution"
    else:
        rec = "proceed"
        reasons = ["All Test case quality checks pass"]
    return {"recommend": rec, "reasons": reasons[:10], "generated_by": "rules"}


async def last_g5(s: AsyncSession, project_id: uuid.UUID) -> GateDecision | None:
    return await gates.last_approval(s, project_id, GateKey.G5)


def snapshot_items(decision: GateDecision | None, kind: str) -> list[dict[str, Any]]:
    """`{type, id, version}` entries of one kind from a gate decision's frozen snapshot (`{"items": [...]}`)."""
    raw: Any = decision.artefact_snapshot if decision is not None else None
    items = raw.get("items", []) if isinstance(raw, dict) else (raw or [])
    return [i for i in items if isinstance(i, dict) and i.get("type") == kind]


async def known_secret_refs(s: AsyncSession, project_id: uuid.UUID) -> set[str]:
    """Names (and kinds) of the project's saved secrets; never their values."""
    out: set[str] = set()
    for name, kind in (
        await s.execute(select(ProjectSecret.name, ProjectSecret.kind).where(ProjectSecret.project_id == project_id))
    ).all():
        out.add(name)
        out.add(kind.value if hasattr(kind, "value") else str(kind))
    return out


async def linked_test_cases(s: AsyncSession, project_id: uuid.UUID, lineage_id: uuid.UUID) -> list[TestCase]:
    """Non-rejected cases of the current design run linked to a requirement lineage."""
    run = await current_run(s, project_id)
    if run is None:
        return []
    rows = (
        await s.execute(
            select(TestCase)
            .join(test_case_requirements, test_case_requirements.c.test_case_id == TestCase.id)
            .where(
                TestCase.stage_run_id == run.id,
                TestCase.status != CaseStatus.rejected,
                test_case_requirements.c.requirement_lineage_id == lineage_id,
            )
            .order_by(TestCase.key)
        )
    ).scalars()
    return list(dict.fromkeys(rows))


async def used_by(s: AsyncSession, run_id: uuid.UUID, data_lineage: uuid.UUID) -> list[TestCase]:
    return [c for c in await cases_of(s, run_id) if str(data_lineage) in {str(x) for x in c.data_lineage_ids or []}]


def active_data(rows: list[TestData]) -> list[TestData]:
    return [d for d in rows if d.status == TestDataStatus.active]
