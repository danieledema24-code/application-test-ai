"""The `change_analysis` stage (P6-01, P6-02; decisions D25–D28): after a rescan finishes, compare it with its
baseline, then work out what the change affects and which tests to rerun.

Queued once per rescan by `advance()` (P6-00). The diff itself is `app.domain.change.diff`; writing the set and its
items is `app.services.changes.compute`, shared with comparisons a person asks for. Impact, the live locator re-check
and the regression recommendation are `app.services.impact.analyse` (rescans only). Code only: with AI on, the model
may only add a labelled plain-words summary (counts are placeholders) and reorder the "should run" tests.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from app.agents.phase2 import StageOutcome
from app.context import AppContext
from app.db.models import ChangeSet, Project, ScanSession, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.domain.change.diff import COMPARABLE_SCAN_STATUSES
from app.domain.enums import GeneratedBy, StageKey
from app.services import changes as svc
from app.services import impact as impact_svc


class ChangeAnalysisAgent:
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
            version = (run.upstream_versions or {}).get("discovery")
            target = (
                await s.execute(
                    select(ScanSession)
                    .join(StageRun, StageRun.id == ScanSession.stage_run_id)
                    .where(
                        ScanSession.project_id == self.project_id,
                        StageRun.stage_key == StageKey.discovery,
                        StageRun.version == version,
                    )
                )
            ).scalar_one_or_none()
            if target is None or not target.is_rescan or target.baseline_scan_session_id is None:
                raise RuntimeError("Change analysis compares a rescan with its baseline; this scan isn't a rescan")
            if target.status.value not in COMPARABLE_SCAN_STATUSES:
                # A cancelled or failed rescan makes no change set (design P6 §5): nothing it missed is "removed".
                return StageOutcome(
                    output={"change_set_id": None, "skipped": f"Scan {target.sequence} didn't finish"},
                    generated_by=GeneratedBy.rules,
                )
            base = (
                await s.execute(select(ScanSession).where(ScanSession.id == target.baseline_scan_session_id))
            ).scalar_one()
            # A retried task reuses its set (compute starts its items again).
            cs = (await s.execute(select(ChangeSet).where(ChangeSet.stage_run_id == run.id))).scalar_one_or_none()
            if cs is None:
                cs = await svc.create_set(s, project, base, target, stage_run_id=run.id)
            await s.commit()
            cs_id = cs.id
        cs = await svc.compute(self.ctx, self.scope, cs_id)
        impact = await impact_svc.analyse(self.ctx, self.scope, cs_id)
        summary = cs.summary or {}
        return StageOutcome(
            output={
                "change_set_id": str(cs.id),
                "change_set_key": cs.key,
                "total": summary.get("total", 0),
                "by_significance": summary.get("by_significance", {}),
                "rebaseline_suggested": cs.rebaseline_suggested,
                "impact": impact,
            },
            generated_by=GeneratedBy.rules,
            llm=summary.get("llm"),
        )
