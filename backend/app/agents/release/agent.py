"""The `release_readiness` stage (P6-05a; decisions D32, D33): one release readiness assessment per run.

Started only on request (`POST /projects/{id}/release-assessments` or the stage endpoint) once a test run has
finished (P6-00). The rules are `app.domain.release.criteria`; loading the snapshot and storing the assessment is
`app.services.release.assess`. The stage then waits for Gate 9, which is decided on the assessment itself (D33).
With AI on, the model may only add a labelled narrative; the verdict, statuses, conditions and residual risk are code.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from app.agents.phase2 import StageOutcome
from app.context import AppContext
from app.db.models import Project, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.domain.release.criteria import VERDICT_LABEL, plural
from app.services import release as svc


class ReleaseReadinessAgent:
    implemented = True

    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id

    async def run(self) -> StageOutcome:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            run = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            project = (await s.execute(select(Project).where(Project.id == self.project_id))).scalar_one()
            row, older, usage = await svc.assess(self.ctx, s, project, run)
            await s.commit()
            key, verdict, n = row.key, row.recommendation.value, len(row.conditions or [])
            generated_by = row.generated_by
            assessment_id = row.id
        label = VERDICT_LABEL[verdict]
        message = f"{key} recommended {label}" + (f" ({plural(n, 'condition')})" if n else "")
        return StageOutcome(
            output={
                "assessment_id": str(assessment_id),
                "assessment_key": key,
                "verdict": verdict,  # not "recommendation": that key is the G1–G8 gate recommendation shape
                "conditions": n,
                "superseded": [o.key for o in older],
            },
            generated_by=generated_by,
            llm=usage,
            events=[
                (
                    "release.assessed",
                    message,
                    {"kind": "result", "assessment_key": key, "recommendation": verdict, "conditions": n},
                )
            ],
        )
