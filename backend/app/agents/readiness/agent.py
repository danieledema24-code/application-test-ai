"""Readiness agent (agent B, P2-05): Definition of Ready / Done for the current requirements version.

Rule templates only (the AI path adds nothing a project-specific template can't, so this generator is always
`generated_by: "rules"`). A user-triggered regeneration writes a candidate for review; the automatic run after a
requirements change applies the carry-forward defaults directly (locked, edited and custom criteria are kept).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.phase2 import StageOutcome, is_candidate_run
from app.agents.readiness import rules
from app.context import AppContext
from app.db.models import ReadinessCriterion, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.domain.enums import GeneratedBy, Provenance, ReadinessKind, ReadinessStatus
from app.services import gates, review
from app.services.adapters import READINESS, remove_readiness
from app.services.counters import next_key
from app.services.readiness import evaluate_row, load_facts


class ReadinessAgent:
    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id

    async def run(self) -> StageOutcome:
        s = self.ctx.session_factory()
        bind_scope(s, self.scope)
        async with s:
            run = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            req_run, _reqs = await gates.current_requirements(s, self.project_id)
            if req_run is None:
                raise RuntimeError("There are no requirements to define readiness for")
            facts = await load_facts(s, self.project_id)
            has_forms = any(r["category"] in rules.FORM_CATEGORIES for r in facts.requirements)
            tpls = rules.templates(has_forms=has_forms, auth_boundary=facts.auth_boundary)
            cands = [self._row(t, i) for i, t in enumerate(tpls)]
            prev_id = (run.parameters or {}).get("previous_run_id")
            prev_rows: list[ReadinessCriterion] = []
            if prev_id:
                prev_rows = list(
                    (
                        await s.execute(
                            select(ReadinessCriterion).where(ReadinessCriterion.stage_run_id == uuid.UUID(prev_id))
                        )
                    ).scalars()
                )
            run.upstream_versions = {**(run.upstream_versions or {}), "requirements": req_run.version}
            output: dict[str, Any]
            candidate = is_candidate_run(run)
            if not prev_rows and not candidate:
                for c in cands:
                    c.key = await self._key(s, c.kind)
                    s.add(c)
                await s.flush()
                rows = cands
                output = {"counts": _counts(rows), "requirements_version": req_run.version}
            else:
                staged = await review.stage_candidates(
                    s,
                    READINESS,
                    run_id=self.run_id,
                    current_rows=prev_rows,
                    candidate_rows=cands,
                    rejected_lineages=set(),
                    rejected_match_keys=set(),
                    new_key=lambda row: self._key(s, row.kind),
                    refresh_attrs=(),
                )
                items = review.review_items(READINESS, staged)
                if candidate:
                    output = {
                        "review": {"items": items, "summary": review.summarise(items, "readiness_criterion")},
                        "candidate_of": (await s.get(StageRun, uuid.UUID(prev_id))).version if prev_id else None,  # type: ignore[union-attr]
                        "requirements_version": req_run.version,
                    }
                else:
                    res = await review.apply_rows(
                        s,
                        READINESS,
                        items,
                        {},
                        org_id=self.scope.org_id,
                        project_id=self.project_id,
                        user_id=None,
                        reject=remove_readiness,
                        rejected_note="No longer applies to this project",
                    )
                    output = {
                        "diff": {
                            "added": res.added,
                            "changed": res.changed,
                            "rejected_as_no_longer_found": res.rejected_as_no_longer_found,
                            "kept_current": res.kept_current,
                            "suppressed_rejected": [],
                        },
                        "requirements_version": req_run.version,
                    }
                rows = list(
                    (
                        await s.execute(
                            select(ReadinessCriterion).where(ReadinessCriterion.stage_run_id == self.run_id)
                        )
                    ).scalars()
                )
                output["counts"] = _counts(rows)
            for r in rows:
                r.evaluation = evaluate_row(r, facts)
            await s.commit()
        return StageOutcome(output=output, generated_by=GeneratedBy.rules, candidate=candidate)

    def _row(self, t: rules.Template, order: int) -> ReadinessCriterion:
        return ReadinessCriterion(
            id=uuid.uuid4(),
            organisation_id=self.scope.org_id,
            project_id=self.project_id,
            stage_run_id=self.run_id,
            match_key=t.rule_id,
            rule_id=t.rule_id,
            kind=t.kind,
            scope=t.scope,
            text=t.text,
            status=ReadinessStatus.active,
            check_rule_id=t.rule_id,
            evaluable_from_phase=t.evaluable_from_phase,
            provenance=Provenance.inferred,
            confidence=0.7,
            generated_by=GeneratedBy.rules,
            sort_order=order,
            key="",
        )

    async def _key(self, s: AsyncSession, kind: ReadinessKind) -> str:
        return (await next_key(s, self.scope.org_id, self.project_id, kind.value.upper()))[1]


def _counts(rows: list[ReadinessCriterion]) -> dict[str, int]:
    active = [r for r in rows if r.status == ReadinessStatus.active]
    return {
        "dor": sum(1 for r in active if r.kind == ReadinessKind.dor),
        "dod": sum(1 for r in active if r.kind == ReadinessKind.dod),
        "removed": len(rows) - len(active),
    }
