"""Automation suitability (P4-02): the `automation_assessment` stage.

For every case in the last G5 approval (at its approved version), the step model decides `suitable`, `partial` or
`manual_only` with reasons a non-QA reader understands. One `automation_assessments` row per case carries the step
model the emitter (P4-03a) consumes. The case's `automation_*` fields are derived: no version bump, no revision,
no G5 reopen. Code only (no AI).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import delete, select

from app.agents.phase2 import StageOutcome
from app.context import AppContext
from app.db.models import AutomationAssessment, AutomationScript, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.domain.automation import steps as sm
from app.domain.enums import AutomationSuitability, GeneratedBy, ScriptStatus, StageKey
from app.services import automation as svc


class AssessmentAgent:
    implemented = True

    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id

    async def run(self) -> StageOutcome:
        s = self.ctx.session_factory()
        bind_scope(s, self.scope)
        async with s:
            run = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            decision, cases = await svc.approved_cases(s, self.project_id)
            if decision is None:
                raise RuntimeError("Scripts are written from the test cases approved at Gate 5; approve Gate 5 first")
            site = await svc.site_model(s, self.project_id, [c.row for c in cases])
            counts = {v.value: 0 for v in AutomationSuitability}
            groups: dict[str, list[dict[str, Any]]] = {v.value: [] for v in AutomationSuitability}
            approved = {(c.case.lineage_id, c.case.version) for c in cases}
            # A retried job (QA P4-BUG-04) starts from scratch: nothing references assessment rows.
            await s.execute(delete(AutomationAssessment).where(AutomationAssessment.stage_run_id == self.run_id))
            for c in cases:
                a = sm.assess(c.case, site)
                s.add(
                    AutomationAssessment(
                        organisation_id=self.scope.org_id,
                        project_id=self.project_id,
                        stage_run_id=self.run_id,
                        test_case_id=c.row.id,
                        case_lineage_id=c.row.lineage_id,
                        case_version=c.case.version,
                        suitability=AutomationSuitability(a.suitability),
                        reasons=a.reasons,
                        blockers=a.blockers,
                        step_model=a.model,
                    )
                )
                await svc.write_case_fields(s, self.project_id, c.row.lineage_id, a)
                counts[a.suitability] += 1
                groups[a.suitability].append({"key": c.case.key, "reason": a.reasons[0] if a.reasons else ""})
            outdated = await self._outdate_scripts(s, approved)
            run.upstream_versions = {
                **(run.upstream_versions or {}),
                "test_design": int((decision.stage_run_versions or {}).get("test_design") or 0),
            }
            await s.commit()
        total = len(cases)
        message = (
            f"Assessed {total} approved case{'s' if total != 1 else ''}: {counts['suitable']} can be automated, "
            f"{counts['partial']} need{'s' if counts['partial'] == 1 else ''} test credentials, "
            f"{counts['manual_only']} need{'s' if counts['manual_only'] == 1 else ''} a person"
        )
        events: list[tuple[str, str, dict[str, Any]]] = [
            ("automation.assessed", message, {"kind": "result", "total": total, **counts})
        ]
        if outdated:
            events.append(
                (
                    "automation.outdated",
                    f"{outdated} script{'s are' if outdated != 1 else ' is'} outdated: the approved test cases changed",
                    {"kind": "warning", "outdated": outdated},
                )
            )
        return StageOutcome(
            output={"counts": {**counts, "total": total}, "g5_decision_id": str(decision.id)},
            generated_by=GeneratedBy.rules,
            events=events,
        )

    async def _outdate_scripts(self, s: Any, approved: set[tuple[str, int]]) -> int:
        """Scripts of the current bundle whose case changed or left the G5 snapshot become `outdated` right away."""
        bundle = await svc.current_run(s, self.project_id, StageKey.automation)
        if bundle is None:
            return 0
        n = 0
        for script in (
            await s.execute(select(AutomationScript).where(AutomationScript.stage_run_id == bundle.id))
        ).scalars():
            if (
                script.status != ScriptStatus.outdated
                and (str(script.case_lineage_id), script.case_version) not in approved
            ):
                script.status = ScriptStatus.outdated
                n += 1
        return n
