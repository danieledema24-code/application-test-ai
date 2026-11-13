"""Shared rules for Phase 2 item edits: tenant-scoped loading, optimistic versions, locks, superseded runs,
revisions and gate reopening."""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, NotFound
from app.context import AppContext
from app.db.models import Project, WorkflowStage
from app.db.tenant import TenantScope
from app.domain.enums import GateKey, StageKey, StageStatus
from app.orchestrator.orchestrator import Orchestrator
from app.services import revisions
from app.services.adapters import snapshot

SUPERSEDED = {
    StageKey.requirements: "The requirement set was regenerated; reload to continue",
    StageKey.readiness_criteria: "Definition of Ready/Done was regenerated; reload to continue",
    StageKey.test_strategy: "The test strategy was regenerated; reload to continue",
    StageKey.test_design: "The test design was regenerated; reload to continue",
}


async def load(s: AsyncSession, model: type[Any], item_id: uuid.UUID, what: str) -> Any:
    row = (await s.execute(select(model).where(model.id == item_id))).scalar_one_or_none()
    if row is None:
        raise NotFound(f"{what} not found")
    return row


async def project_of(s: AsyncSession, project_id: uuid.UUID) -> Project:
    p = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if p is None:
        raise NotFound("Project not found")
    return p


async def stage(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
    return (
        await s.execute(
            select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
        )
    ).scalar_one()


async def ensure_current(s: AsyncSession, row: Any, key: StageKey) -> WorkflowStage:
    st = await stage(s, row.project_id, key)
    if st.current_stage_run_id != row.stage_run_id:
        raise Conflict(SUPERSEDED[key])
    return st


def check_version(row: Any, version: int) -> None:
    if row.version != version:
        raise Conflict("This item was changed by someone else; reload to continue")


def check_unlocked(row: Any) -> None:
    if row.locked:
        raise Conflict("Unlock to edit")


# Set while an accepted assistant proposal is being applied (P2-10): revisions are attributed to the assistant
# (accepted by the user) and linked to the proposal. (proposal id, proposal key)
PROPOSAL: ContextVar[tuple[uuid.UUID, str] | None] = ContextVar("assistant_proposal", default=None)


async def revise(
    s: AsyncSession,
    *,
    entity_type: str,
    row: Any,
    fields: tuple[str, ...],
    before: dict[str, Any] | None,
    user_id: uuid.UUID | None,
    reason: str | None,
    source: str = "user",
    proposal_id: uuid.UUID | None = None,
) -> None:
    after = snapshot(row, fields)
    applying = PROPOSAL.get()
    if applying is not None and proposal_id is None:
        source, proposal_id = "assistant", applying[0]
        reason = f"Accepted assistant proposal {applying[1]}" + (
            f": {reason}" if reason and reason != "Created" else ""
        )
    await revisions.record(
        s,
        org_id=row.organisation_id,
        project_id=row.project_id,
        entity_type=entity_type,
        entity_id=row.id,
        lineage_id=row.lineage_id,
        version=row.version,
        snapshot=after,
        changes=revisions.diff(before or {}, after),
        source=source,
        changed_by=user_id,
        change_reason=reason,
        proposal_id=proposal_id,
    )


async def reopen_if_approved(
    ctx: AppContext, s: AsyncSession, project: Project, gate: GateKey, reason: str, user_id: uuid.UUID | None
) -> Orchestrator | None:
    """Reopens the gate inside this transaction; call `after_commit` once committed."""
    orch = Orchestrator(ctx)
    if await orch.reopen_gate(s, project, gate, reason=reason, user_id=user_id):
        return orch
    return None


async def after_commit(orch: Orchestrator | None, scope: TenantScope, project_id: uuid.UUID) -> None:
    if orch is not None:
        await orch.emit_reopened(project_id)


async def stage_is_approved(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> bool:
    return (await stage(s, project_id, key)).status == StageStatus.approved
