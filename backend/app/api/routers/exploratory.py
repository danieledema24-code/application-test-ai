"""Exploratory testing (Phase 6, decisions D29, D30). P6-00 lays the foundation: `POST /projects/{id}/exploratory-
sessions` (member) needs discovery with G2 satisfied (409 `gate_blocked`, as the Phase 5 checks) and answers 422 "not
available yet" until P6-03a lands the explorer. `POST /stages/exploratory/run` is refused (RUN_DRIVEN_STAGES). Other
organisations get 404.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Ctx, MemberPrincipal, ScopedSession
from app.api.errors import ValidationFailed
from app.api.routers import p2common as c
from app.domain.enums import StageKey
from app.domain.stages import STAGE_BY_KEY
from app.orchestrator.orchestrator import Orchestrator

router = APIRouter(tags=["exploratory"])


class ExploratoryInput(BaseModel):
    """The request P6-03a implements (charter, pages, change set, budget, signed in); validated in full there."""

    model_config = ConfigDict(extra="forbid")
    charter: str | None = Field(default=None, max_length=200)
    pages: list[uuid.UUID] | None = Field(default=None, max_length=500)
    change_set_id: uuid.UUID | None = None
    budget: dict[str, int] | None = None
    signed_in: bool = False


@router.post("/projects/{project_id}/exploratory-sessions", status_code=201)
async def start_session(
    project_id: uuid.UUID, body: ExploratoryInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    await Orchestrator(ctx).check_optional_upstream(s, project, StageKey.exploratory)
    # P6-03a replaces this with the session request (budget, approval for signed-in sessions, job).
    title = STAGE_BY_KEY[StageKey.exploratory].title
    raise ValidationFailed(
        f"{title} is not available yet", details=[{"field": "stage", "message": f"{title} is not available yet"}]
    )
