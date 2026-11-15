"""Applies or discards a candidate regeneration (P2-00 review endpoints) for requirements (incl. ACs),
Definition of Ready/Done and the test strategy (incl. risks).

Apply makes the candidate the stage's current version with the reviewer's choices, writes revisions, and reopens
the stage's gate if it was approved and something changed. Downstream outputs keep using the last approved
version until the gate is approved again.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, NotFound
from app.db.models import (
    AcceptanceCriterion,
    Project,
    ReadinessCriterion,
    Requirement,
    Risk,
    StageRun,
    TestStrategy,
    WorkflowStage,
)
from app.db.types import utcnow
from app.domain.enums import GateKey, GatePolicy, GateStatus, ReviewStatus, StageKey, StageStatus
from app.domain.lineage import ReviewEntry, resolve_action
from app.domain.stages import STAGE_BY_KEY, merged_policy
from app.services import review
from app.services.adapters import (
    ACCEPTANCE_CRITERION,
    READINESS,
    REQUIREMENT,
    RISK,
    accept_risk,
    reject_ac,
    reject_requirement,
    remove_readiness,
)
from app.services.audit import audit

ARTEFACT = {
    StageKey.requirements: "requirements",
    StageKey.readiness_criteria: "readiness_criteria",
    StageKey.test_strategy: "test_strategy",
    StageKey.test_design: "test_design",
}
REVIEW_STAGES = frozenset(ARTEFACT)


async def stage_row(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
    st = (
        await s.execute(
            select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
        )
    ).scalar_one_or_none()
    if st is None:
        raise NotFound("Stage not found")
    return st


async def candidate_run(s: AsyncSession, st: WorkflowStage, version: int) -> StageRun:
    run = (
        await s.execute(select(StageRun).where(StageRun.workflow_stage_id == st.id, StageRun.version == version))
    ).scalar_one_or_none()
    if run is None or run.review_status == ReviewStatus.not_required:
        raise NotFound("No change review for this version")
    return run


async def current_version(s: AsyncSession, st: WorkflowStage) -> int | None:
    if st.current_stage_run_id is None:
        return None
    run = await s.get(StageRun, st.current_stage_run_id)
    return run.version if run else None


def gate_effect(st: WorkflowStage) -> str | None:
    gate = STAGE_BY_KEY[st.stage_key].gate or (GateKey.G3 if st.stage_key == StageKey.readiness_criteria else None)
    if gate is None:
        return None
    if st.stage_key == StageKey.readiness_criteria:
        return None
    if st.status == StageStatus.approved or st.gate_status == GateStatus.approved:
        # Also when the stage went stale after approval: applying changes reopens the gate (BUG-P2-21).
        return f"Gate {gate.value[1:]} will need approval again."
    return None


async def change_review(s: AsyncSession, st: WorkflowStage, run: StageRun, include_unchanged: bool) -> dict[str, Any]:
    out = run.output or {}
    raw = (out.get("review") or {}).get("items", [])
    items = [
        {k: v for k, v in i.items() if k not in ("current_row_id", "candidate_row_id", "current_version")}
        for i in raw
        if i["change"] != "suppressed_rejected" and (include_unchanged or i["change"] != "unchanged")
    ]
    for i in items:
        if i.get("default_action") is None:  # unchanged items (also on candidates stored before this rule)
            i["default_action"] = "keep"
            i["allowed_actions"] = list(i.get("allowed_actions") or []) or ["keep"]
    summary: dict[str, int] = {}
    for k in ("added", "changed", "protected_with_proposal", "no_longer_found", "unchanged", "suppressed_rejected"):
        summary[k] = sum(1 for i in raw if i["change"] == k)
    effect = gate_effect(st)
    if st.stage_key == StageKey.readiness_criteria:
        req_st = await stage_row(s, st.project_id, StageKey.requirements)
        if req_st.status == StageStatus.approved or req_st.gate_status == GateStatus.approved:
            effect = "Gate 3 will need approval again."
    return {
        "stage_key": st.stage_key.value,
        "artefact": ARTEFACT[st.stage_key],
        "current_version": await current_version(s, st),
        "candidate_version": run.version,
        "review_status": run.review_status.value,
        "guidance": run.guidance,
        "summary": summary,
        "items": items,
        "gate_effect": effect,
    }


async def _check_pending(s: AsyncSession, st: WorkflowStage, run: StageRun) -> None:
    if run.review_status != ReviewStatus.pending_review or run.finished_at is None:
        raise Conflict("This version is not waiting for review")
    newer = (
        await s.execute(
            select(StageRun.id).where(StageRun.workflow_stage_id == st.id, StageRun.version > run.version).limit(1)
        )
    ).first()
    if newer is not None:
        raise Conflict("A newer version exists; reload to continue")


async def discard(
    s: AsyncSession, project: Project, st: WorkflowStage, run: StageRun, *, user_id: uuid.UUID, comment: str | None
) -> None:
    await _check_pending(s, st, run)
    run.review_status = ReviewStatus.discarded
    run.review_decisions = {**(run.review_decisions or {}), "comment": comment, "discarded_by": str(user_id)}
    audit(
        s,
        org_id=project.organisation_id,
        action="stage.review_discarded",
        target_type="stage",
        target_id=st.stage_key.value,
        actor_user_id=user_id,
        project_id=project.id,
        metadata={"version": run.version, "comment": comment},
    )


async def apply(
    s: AsyncSession,
    project: Project,
    st: WorkflowStage,
    run: StageRun,
    *,
    decisions: dict[str, str],
    user_id: uuid.UUID,
    comment: str | None,
) -> tuple[dict[str, Any], bool]:
    """Returns the RegenerationDiff and whether anything changed."""
    await _check_pending(s, st, run)
    items = list(((run.output or {}).get("review") or {}).get("items", []))
    prev_id = st.current_stage_run_id
    if st.stage_key == StageKey.requirements:
        diff = await _apply_requirements(s, project, run, items, decisions, user_id, prev_id)
    elif st.stage_key == StageKey.readiness_criteria:
        res = await review.apply_rows(
            s,
            READINESS,
            items,
            decisions,
            org_id=project.organisation_id,
            project_id=project.id,
            user_id=user_id,
            reject=remove_readiness,
            rejected_note="No longer applies to this project",
        )
        if prev_id is not None:
            cur = list(
                (
                    await s.execute(select(ReadinessCriterion).where(ReadinessCriterion.stage_run_id == prev_id))
                ).scalars()
            )
            await review.carry_missing(s, READINESS, current_rows=cur, candidate_run_id=run.id)
        diff = _diff(res)
    elif st.stage_key == StageKey.test_design:
        diff = await _apply_test_design(s, project, run, items, decisions, user_id, prev_id)
    else:
        diff = await _apply_strategy(s, project, run, items, decisions, user_id, prev_id)
    prev_version = None
    if prev_id is not None:
        prev = await s.get(StageRun, prev_id)
        prev_version = prev.version if prev else None
    diff = {"from_version": prev_version, "to_version": run.version, **diff}
    changed = bool(diff["added"] or diff["changed"] or diff["rejected_as_no_longer_found"])
    st.current_stage_run_id = run.id
    run.review_status = ReviewStatus.applied
    run.applied_by = user_id
    run.applied_at = utcnow()
    run.review_decisions = {**(run.review_decisions or {}), "decisions": decisions, "comment": comment}
    run.output = {**(run.output or {}), "diff": diff}
    run.status = (
        st.status if st.status in (StageStatus.approved, StageStatus.awaiting_approval) else StageStatus.completed
    )
    st.stale_reason = None
    if st.status == StageStatus.stale:
        if st.gate_key is None:
            st.status = StageStatus.completed
        elif st.gate_status == GateStatus.approved:
            # Approved before it went stale: the approval stands if nothing changed; otherwise the caller reopens the
            # gate from `approved` (audited, `gate.reopened` event), so status and gate state stay in step.
            st.status = StageStatus.approved
        else:  # the gate must be decided again: status and gate state move together
            required = merged_policy(project.approval_policy)[st.gate_key] == GatePolicy.required
            st.status = StageStatus.awaiting_approval if required else StageStatus.completed
            st.gate_status = GateStatus.pending if required else GateStatus.recommended
        run.status = st.status
    st.updated_by = user_id
    audit(
        s,
        org_id=project.organisation_id,
        action="stage.review_applied",
        target_type="stage",
        target_id=st.stage_key.value,
        actor_user_id=user_id,
        project_id=project.id,
        metadata={
            "version": run.version,
            "comment": comment,
            **{k: len(v) for k, v in diff.items() if isinstance(v, list)},
        },
    )
    return diff, changed


def _diff(res: review.ApplyResult) -> dict[str, Any]:
    return {
        "added": res.added,
        "changed": res.changed,
        "rejected_as_no_longer_found": res.rejected_as_no_longer_found,
        "kept_current": res.kept_current,
        "suppressed_rejected": res.suppressed_rejected,
    }


async def _apply_requirements(
    s: AsyncSession,
    project: Project,
    run: StageRun,
    items: list[dict[str, Any]],
    decisions: dict[str, str],
    user_id: uuid.UUID,
    prev_id: uuid.UUID | None,
) -> dict[str, Any]:
    from app.agents.requirements.agent import link_features

    skipped: set[str] = set()
    for it in items:
        if it["type"] != "requirement" or it["change"] != "added" or not it.get("candidate_row_id"):
            continue
        entry = ReviewEntry(
            "added",
            it["match_key"],
            uuid.UUID(it["lineage_id"]),
            it.get("key"),
            None,
            None,
            it.get("default_action"),
            list(it.get("allowed_actions") or []),
        )
        if resolve_action(entry, decisions) == "skip":
            skipped.add(it["lineage_id"])
            await s.execute(
                delete(AcceptanceCriterion).where(
                    AcceptanceCriterion.requirement_id == uuid.UUID(it["candidate_row_id"])
                )
            )
    scan_no = ((run.output or {}).get("review") or {}).get("scan_number", "?")
    org_id, pid = project.organisation_id, project.id
    res = await review.apply_rows(
        s, REQUIREMENT, items, decisions, org_id=org_id, project_id=pid, user_id=user_id,
        reject=reject_requirement, rejected_note=f"No longer found in Scan {scan_no}",
    )  # fmt: skip
    ac_res = await review.apply_rows(
        s, ACCEPTANCE_CRITERION, items, decisions, org_id=org_id, project_id=pid, user_id=user_id,
        reject=reject_ac, skip_parents=skipped, rejected_note=f"No longer found in Scan {scan_no}",
    )  # fmt: skip
    if prev_id is not None:
        cur_reqs = list((await s.execute(select(Requirement).where(Requirement.stage_run_id == prev_id))).scalars())
        cand_by_lineage = {
            r.lineage_id: r
            for r in (await s.execute(select(Requirement).where(Requirement.stage_run_id == run.id))).scalars()
        }
        # Requirements created after the candidate was generated are carried as they are (with their criteria).
        carried = await review.carry_missing(s, REQUIREMENT, current_rows=cur_reqs, candidate_run_id=run.id)
        for c in carried:
            cand_by_lineage[c.lineage_id] = c
        for cur in cur_reqs:
            target = cand_by_lineage.get(cur.lineage_id)
            if target is None:
                continue
            cur_acs = list(
                (
                    await s.execute(select(AcceptanceCriterion).where(AcceptanceCriterion.requirement_id == cur.id))
                ).scalars()
            )
            present = {
                a.lineage_id
                for a in (
                    await s.execute(select(AcceptanceCriterion).where(AcceptanceCriterion.requirement_id == target.id))
                ).scalars()
            }
            for a in cur_acs:
                if a.lineage_id not in present:
                    s.add(review.clone(a, stage_run_id=run.id, requirement_id=target.id))
    await s.flush()
    for r in (await s.execute(select(Requirement).where(Requirement.stage_run_id == run.id))).scalars():
        await link_features(s, r)
    diff = _diff(res)
    diff["changed"] = sorted({*diff["changed"], *(k for k in ac_res.changed)})
    diff["added"] = [*diff["added"], *ac_res.added]
    diff["rejected_as_no_longer_found"] += ac_res.rejected_as_no_longer_found
    return diff


async def _apply_strategy(
    s: AsyncSession,
    project: Project,
    run: StageRun,
    items: list[dict[str, Any]],
    decisions: dict[str, str],
    user_id: uuid.UUID,
    prev_id: uuid.UUID | None,
) -> dict[str, Any]:
    from app.agents.strategy.agent import link_risk

    res = await review.apply_rows(
        s,
        RISK,
        items,
        decisions,
        org_id=project.organisation_id,
        project_id=project.id,
        user_id=user_id,
        reject=accept_risk,
        rejected_note="Accepted: no longer found by the generator",
    )
    strat = (await s.execute(select(TestStrategy).where(TestStrategy.stage_run_id == run.id))).scalar_one()
    prev = (
        (await s.execute(select(TestStrategy).where(TestStrategy.stage_run_id == prev_id))).scalar_one_or_none()
        if prev_id
        else None
    )
    content = dict(strat.content)
    edited = set(strat.human_edited_sections)
    changed: list[str] = []
    kept: list[str] = []
    accepted_sections: set[str] = set()
    for it in items:
        if it["type"] != "strategy_section":
            continue
        name = it["key"]
        entry = ReviewEntry(
            it["change"],
            name,
            None,
            name,
            it["current"],
            it["proposed"],
            it["default_action"],
            list(it["allowed_actions"]),
        )
        action = decisions.get(name) if decisions.get(name) in entry.allowed_actions else entry.default_action
        if action == "accept":
            content[name] = (it["proposed"] or {}).get(name)
            edited.discard(name)
            accepted_sections.add(name)
            changed.append(name)
        else:
            content[name] = (prev.content if prev else it["current"] or {}).get(name)
            kept.append(name)
    if prev is not None:  # edits to the current strategy after the candidate was generated are never lost
        for name in prev.human_edited_sections:
            if name not in accepted_sections:
                content[name] = prev.content.get(name)
                edited.add(name)
        if prev.version >= strat.version:
            strat.version = prev.version + 1
    strat.content = content
    strat.human_edited_sections = sorted(edited)
    strat.suggested_changes = None
    if prev_id is not None:
        cur = list((await s.execute(select(Risk).where(Risk.stage_run_id == prev_id))).scalars())
        await review.carry_missing(
            s, RISK, current_rows=cur, candidate_run_id=run.id, overrides=lambda _r: {"strategy_id": strat.id}
        )
    for r in (await s.execute(select(Risk).where(Risk.stage_run_id == run.id))).scalars():
        await link_risk(s, r)
    diff = _diff(res)
    diff["changed"] += changed
    diff["kept_current"] += kept
    from app.services import testdesign as tds

    await s.flush()
    await tds.recompute_priorities(s, project.id)  # P3-05: derived case priority follows the applied risks
    return diff


async def _apply_test_design(
    s: AsyncSession,
    project: Project,
    run: StageRun,
    items: list[dict[str, Any]],
    decisions: dict[str, str],
    user_id: uuid.UUID,
    prev_id: uuid.UUID | None,
) -> dict[str, Any]:
    """Conditions, then data, then cases (P3-01b). Links are by lineage, so kept rows stay connected."""
    from app.services import testdesign as tds
    from app.services.adapters import (
        TEST_CASE,
        TEST_CONDITION,
        TEST_DATA,
        reject_case,
        reject_condition,
        retire_data,
    )

    org_id, pid = project.organisation_id, project.id
    note = "No longer produced by the test design"
    results = [
        await review.apply_rows(
            s, TEST_CONDITION, items, decisions, org_id=org_id, project_id=pid, user_id=user_id,
            reject=reject_condition, rejected_note=note,
        ),
        await review.apply_rows(
            s, TEST_DATA, items, decisions, org_id=org_id, project_id=pid, user_id=user_id,
            reject=retire_data, rejected_note=note,
        ),
        await review.apply_rows(
            s, TEST_CASE, items, decisions, org_id=org_id, project_id=pid, user_id=user_id,
            reject=reject_case, rejected_note=note,
        ),
    ]  # fmt: skip
    if prev_id is not None:
        for adapter, rows in (
            (TEST_CONDITION, await tds.conditions_of(s, prev_id)),
            (TEST_DATA, await tds.data_of(s, prev_id)),
            (TEST_CASE, await tds.cases_of(s, prev_id)),
        ):
            await review.carry_missing(s, adapter, current_rows=rows, candidate_run_id=run.id)
    parents = await tds.ac_parents(s, pid)
    for cond in await tds.conditions_of(s, run.id):
        await tds.link_condition(s, cond, parents)
    for case in await tds.cases_of(s, run.id):
        await tds.link_case(s, case, parents)
    await s.flush()
    await tds.refresh_derived(s, pid, run.id)
    diff = _diff(results[0])
    for res in results[1:]:
        for k, v in _diff(res).items():
            diff[k] = [*diff[k], *v]
    return diff


def reopen_reason(stage: StageKey) -> str:
    return f"{STAGE_BY_KEY[stage].title} changed"


GATE_FOR_STAGE = {
    StageKey.requirements: GateKey.G3,
    StageKey.readiness_criteria: GateKey.G3,
    StageKey.test_strategy: GateKey.G4,
    StageKey.test_design: GateKey.G5,
}
