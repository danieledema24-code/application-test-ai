"""Phase 2 gate rules (P2-00, P2-05, P2-06): G3/G4 preconditions, approved snapshots and rule recommendations.

Every number here is computed from rows. Recommendations are advisory; blockers are enforced by the decision
endpoint (409 `gate_blocked`).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AcceptanceCriterion,
    ApplicationFeature,
    GateDecision,
    Project,
    ReadinessCriterion,
    Requirement,
    Risk,
    ScanSession,
    StageRun,
    TestStrategy,
    WorkflowStage,
    requirement_features,
)
from app.domain.enums import (
    GateDecisionKind,
    GateKey,
    GatePolicy,
    ItemStatus,
    Provenance,
    ReadinessStatus,
    RequirementStatus,
    RiskLevel,
    RiskStatus,
    StageKey,
    StageStatus,
)
from app.domain.stages import ACTIVE_STATUSES, GATE_TITLES, merged_policy


@dataclass
class Precondition:
    code: str
    met: bool
    blocking: bool
    message: str
    link: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "met": self.met,
            "blocking": self.blocking,
            "message": self.message,
            "link": self.link,
        }


async def _stage(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
    return (
        await s.execute(
            select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
        )
    ).scalar_one()


async def _run(s: AsyncSession, run_id: uuid.UUID | None) -> StageRun | None:
    if run_id is None:
        return None
    return (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one_or_none()


async def current_requirements(s: AsyncSession, project_id: uuid.UUID) -> tuple[StageRun | None, list[Requirement]]:
    st = await _stage(s, project_id, StageKey.requirements)
    run = await _run(s, st.current_stage_run_id)
    if run is None or run.finished_at is None:
        return None, []
    rows = list(
        (
            await s.execute(select(Requirement).where(Requirement.stage_run_id == run.id).order_by(Requirement.key))
        ).scalars()
    )
    return run, rows


async def current_strategy(s: AsyncSession, project_id: uuid.UUID) -> tuple[StageRun | None, TestStrategy | None]:
    st = await _stage(s, project_id, StageKey.test_strategy)
    run = await _run(s, st.current_stage_run_id)
    if run is None or run.finished_at is None:
        return None, None
    strat = (await s.execute(select(TestStrategy).where(TestStrategy.stage_run_id == run.id))).scalar_one_or_none()
    return run, strat


def snapshot_hash(items: list[dict[str, Any]]) -> str:
    raw = json.dumps(sorted(items, key=lambda i: (i["type"], i["id"])), sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


async def g3_snapshot(s: AsyncSession, project_id: uuid.UUID) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Approved requirements, their approved ACs and active readiness criteria (drafts excluded)."""
    run, reqs = await current_requirements(s, project_id)
    items: list[dict[str, Any]] = []
    versions: dict[str, int] = {}
    if run is None:
        return items, versions
    versions["requirements"] = run.version
    approved = [r for r in reqs if r.status == RequirementStatus.approved]
    items += [{"type": "requirement", "id": str(r.id), "version": r.version} for r in approved]
    if approved:
        acs = (
            await s.execute(
                select(AcceptanceCriterion).where(
                    AcceptanceCriterion.requirement_id.in_([r.id for r in approved]),
                    AcceptanceCriterion.status == ItemStatus.approved,
                )
            )
        ).scalars()
        items += [{"type": "acceptance_criterion", "id": str(a.id), "version": a.version} for a in acs]
    rst = await _stage(s, project_id, StageKey.readiness_criteria)
    rrun = await _run(s, rst.current_stage_run_id)
    if rrun is not None and rrun.finished_at is not None:
        versions["readiness_criteria"] = rrun.version
        crit = (
            await s.execute(
                select(ReadinessCriterion).where(
                    ReadinessCriterion.stage_run_id == rrun.id, ReadinessCriterion.status == ReadinessStatus.active
                )
            )
        ).scalars()
        items += [{"type": "readiness_criterion", "id": str(c.id), "version": c.version} for c in crit]
    return items, versions


async def g4_snapshot(s: AsyncSession, project_id: uuid.UUID) -> tuple[list[dict[str, Any]], dict[str, int]]:
    run, strat = await current_strategy(s, project_id)
    if run is None or strat is None:
        return [], {}
    items: list[dict[str, Any]] = [{"type": "test_strategy", "id": str(strat.id), "version": strat.version}]
    risks = (await s.execute(select(Risk).where(Risk.stage_run_id == run.id))).scalars()
    items += [{"type": "risk", "id": str(r.id), "version": r.version} for r in risks]
    return items, {"test_strategy": run.version}


async def snapshot_for(
    s: AsyncSession, project_id: uuid.UUID, gate: GateKey
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if gate == GateKey.G3:
        return await g3_snapshot(s, project_id)
    if gate == GateKey.G4:
        return await g4_snapshot(s, project_id)
    return [], {}


async def last_approval(s: AsyncSession, project_id: uuid.UUID, gate: GateKey) -> GateDecision | None:
    return (
        await s.execute(
            select(GateDecision)
            .where(
                GateDecision.project_id == project_id,
                GateDecision.gate_key == gate,
                GateDecision.decision == GateDecisionKind.approve,
            )
            .order_by(GateDecision.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def gate_satisfied(s: AsyncSession, project: Project, stage: WorkflowStage) -> bool:
    """An upstream is gate-satisfied when it has an output and, under a `required` gate, is approved."""
    from app.domain.stages import OUTPUT_STATUSES

    if stage.status not in OUTPUT_STATUSES:
        return False
    if stage.gate_key is None:
        return True
    policy = merged_policy(project.approval_policy)[stage.gate_key]
    return policy != GatePolicy.required or stage.status == StageStatus.approved


# ------------------------------------------------------------------ preconditions


async def g3_preconditions(s: AsyncSession, project: Project) -> list[Precondition]:
    pid = project.id
    run, reqs = await current_requirements(s, pid)
    base = f"/projects/{pid}/requirements"
    out: list[Precondition] = []
    rst = await _stage(s, pid, StageKey.readiness_criteria)
    rrun = await _run(s, rst.current_stage_run_id)
    updating = rst.status in ACTIVE_STATUSES or rst.status == StageStatus.paused
    ready = (
        run is not None
        and rrun is not None
        and rrun.finished_at is not None
        and int((rrun.upstream_versions or {}).get("requirements", -1)) == run.version
        and not updating
    )
    out.append(
        Precondition(
            "readiness_current",
            ready,
            True,
            "Definition of Ready/Done is defined for this version of the requirements"
            if ready
            else (
                "Definition of Ready/Done is still being updated"
                if updating or rrun is not None
                else "Definition of Ready/Done has not been generated yet"
            ),
            f"{base}?tab=ready-done",
        )
    )
    approved = [r for r in reqs if r.status == RequirementStatus.approved]
    out.append(
        Precondition(
            "approved_requirement",
            bool(approved),
            True,
            f"{len(approved)} requirement(s) approved" if approved else "Approve at least one requirement first",
            f"{base}?status=approved",
        )
    )
    drafts = [r for r in reqs if r.status in (RequirementStatus.draft, RequirementStatus.needs_info)]
    out.append(
        Precondition(
            "drafts_remaining",
            not drafts,
            False,
            "No drafts remain"
            if not drafts
            else f"{len(drafts)} still Draft or Needs info: they won't be used by the Test Strategy Agent until approved",
            f"{base}?status=draft",
        )
    )
    if approved:
        with_ac = set(
            (
                await s.execute(
                    select(AcceptanceCriterion.requirement_id).where(
                        AcceptanceCriterion.requirement_id.in_([r.id for r in approved]),
                        AcceptanceCriterion.status == ItemStatus.approved,
                    )
                )
            ).scalars()
        )
        missing = [r.key for r in approved if r.id not in with_ac]
    else:
        missing = []
    out.append(
        Precondition(
            "approved_without_ac",
            not missing,
            False,
            "Every approved requirement has an approved acceptance criterion"
            if not missing
            else f"{len(missing)} approved requirement(s) have no approved acceptance criterion ({', '.join(missing[:5])})",
            f"{base}?without_ac=true",
        )
    )
    weak = [r.key for r in approved if r.provenance in (Provenance.assumed, Provenance.unverified)]
    out.append(
        Precondition(
            "approved_weak_label",
            not weak,
            False,
            "No approved requirement is Assumed or Unverified"
            if not weak
            else f"{len(weak)} approved requirement(s) are Assumed or Unverified: confirm them with the product owner",
            f"{base}?status=approved&classification=unverified",
        )
    )
    return out


async def g4_preconditions(s: AsyncSession, project: Project) -> list[Precondition]:
    pid = project.id
    base = f"/projects/{pid}/test-strategy"
    out: list[Precondition] = []
    req_stage = await _stage(s, pid, StageKey.requirements)
    g3_ok = await gate_satisfied(s, project, req_stage)
    out.append(
        Precondition(
            "g3_approved",
            g3_ok,
            True,
            "Requirements review (G3) is approved" if g3_ok else "Requirements review (G3) must be approved first",
            f"/projects/{pid}/requirements?tab=review",
        )
    )
    run, strat = await current_strategy(s, pid)
    sections = (strat.content if strat else {}) or {}
    levels = [x for x in sections.get("test_levels", []) if x.get("in_scope")]
    types = [x for x in sections.get("test_types", []) if x.get("in_scope")]
    out.append(
        Precondition(
            "strategy_scope",
            bool(levels and types),
            True,
            "At least one test level and one test type are in scope"
            if levels and types
            else "The strategy needs at least one in-scope test level and test type",
            base,
        )
    )
    crit = bool(sections.get("entry_criteria")) and bool(sections.get("exit_criteria"))
    out.append(
        Precondition(
            "entry_exit_criteria",
            crit,
            True,
            "Entry and exit criteria are defined" if crit else "Entry and exit criteria can't be empty",
            base,
        )
    )
    risks = list((await s.execute(select(Risk).where(Risk.stage_run_id == run.id))).scalars()) if run else []
    unmitigated = sorted(
        r.key
        for r in risks
        if r.level in (RiskLevel.high, RiskLevel.very_high)
        and r.status == RiskStatus.open
        and not (r.mitigation or {}).get("test_types")
    )
    out.append(
        Precondition(
            "risks_mitigated",
            not unmitigated,
            True,
            "Every high and very high risk has a mitigation"
            if not unmitigated
            else f"{', '.join(unmitigated)} need at least one mitigation test type",
            f"/projects/{pid}/test-strategy?tab=risks",
        )
    )
    no_rationale = [t.get("type") for t in sections.get("test_types", []) if not (t.get("rationale") or "").strip()]
    out.append(
        Precondition(
            "rationale",
            not no_rationale,
            False,
            "Every test type decision has a rationale"
            if not no_rationale
            else f"{len(no_rationale)} test type decision(s) have no rationale",
            base,
        )
    )
    accepted = [r.key for r in risks if r.status == RiskStatus.accepted and not (r.status_comment or "").strip()]
    out.append(
        Precondition(
            "accepted_risks_comment",
            not accepted,
            False,
            "Accepted risks are explained" if not accepted else f"{', '.join(accepted)} accepted without a comment",
            f"/projects/{pid}/test-strategy?tab=risks",
        )
    )
    return out


async def preconditions(s: AsyncSession, project: Project, gate: GateKey) -> list[Precondition]:
    if gate == GateKey.G3:
        return await g3_preconditions(s, project)
    if gate == GateKey.G4:
        return await g4_preconditions(s, project)
    return []


def blockers(items: list[Precondition]) -> list[Precondition]:
    return [p for p in items if p.blocking and not p.met]


async def recommendation(s: AsyncSession, project: Project, gate: GateKey) -> dict[str, Any] | None:
    """Rule recommendation (advisory) built from the coded checks plus coverage facts."""
    if gate not in (GateKey.G3, GateKey.G4):
        return None
    pre = await preconditions(s, project, gate)
    reasons = [p.message for p in pre if not p.met]
    if gate == GateKey.G3:
        _, reqs = await current_requirements(s, project.id)
        unverified = sum(1 for r in reqs if r.provenance == Provenance.unverified)
        needs_info = sum(1 for r in reqs if r.status == RequirementStatus.needs_info)
        if unverified:
            reasons.append(f"{unverified} requirement(s) are Unverified")
        if needs_info:
            reasons.append(f"{needs_info} requirement(s) need information")
        uncovered = await features_without_requirement(s, project.id)
        if uncovered:
            reasons.append(f"{len(uncovered)} discovered feature(s) have no requirement")
        scan = (
            await s.execute(
                select(ScanSession)
                .where(ScanSession.project_id == project.id)
                .order_by(ScanSession.sequence.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if scan is not None and scan.access_gaps:
            reasons.append(f"Discovery reported {len(scan.access_gaps)} access gap(s)")
    if blockers(pre):
        rec = "do_not_proceed"
    elif reasons:
        rec = "proceed_with_caution"
    else:
        rec = "proceed"
        reasons = [f"All {GATE_TITLES[gate]} checks pass"]
    return {"recommend": rec, "reasons": reasons[:10], "generated_by": "rules"}


async def features_without_requirement(s: AsyncSession, project_id: uuid.UUID) -> list[ApplicationFeature]:
    run, reqs = await current_requirements(s, project_id)
    dst = await _stage(s, project_id, StageKey.discovery)
    drun = await _run(s, dst.current_stage_run_id)
    if drun is None:
        return []
    feats = list(
        (
            await s.execute(
                select(ApplicationFeature)
                .where(ApplicationFeature.stage_run_id == drun.id)
                .order_by(ApplicationFeature.key)
            )
        ).scalars()
    )
    if run is None:
        return feats
    live = [r.id for r in reqs if r.status != RequirementStatus.rejected]
    covered = (
        set(
            (
                await s.execute(
                    select(requirement_features.c.feature_id).where(requirement_features.c.requirement_id.in_(live))
                )
            ).scalars()
        )
        if live
        else set()
    )
    return [f for f in feats if f.id not in covered]


async def changes_since_approval(s: AsyncSession, project_id: uuid.UUID, gate: GateKey) -> int:
    """Items in the current gate snapshot that are new or at another version than in the last approval, plus
    approved items that have left it. 0 when the gate was never approved."""
    last = await last_approval(s, project_id, gate)
    if last is None:
        return 0
    snap: dict[str, Any] = last.artefact_snapshot if isinstance(last.artefact_snapshot, dict) else {}
    before = {(i["type"], i["id"]): i["version"] for i in snap.get("items", [])}
    items, _ = await snapshot_for(s, project_id, gate)
    now = {(i["type"], i["id"]): i["version"] for i in items}
    return sum(1 for k, v in now.items() if before.get(k) != v) + sum(1 for k in before if k not in now)
