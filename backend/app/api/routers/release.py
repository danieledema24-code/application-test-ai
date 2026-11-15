"""Release readiness (Phase 6). P6-00 lays the foundation: `POST /projects/{id}/release-assessments` (member) goes
through the `release_readiness` stage, so it needs at least one finished execution run (409 "Run the tests first…")
and answers 422 "not available yet" until P6-05a lands the assessment. Other organisations get 404.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter

from app.api.deps import Ctx, MemberPrincipal, ScopedSession
from app.api.routers import p2common as c
from app.domain.enums import StageKey
from app.orchestrator.orchestrator import Orchestrator

router = APIRouter(tags=["release-readiness"])


@router.post("/projects/{project_id}/release-assessments", status_code=201)
async def create_assessment(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    # P6-05a replaces the stage's stub handler; until then request_run answers 422 before anything is queued.
    await Orchestrator(ctx).request_run(p.scope, project_id, StageKey.release_readiness, parameters=None, reason=None)
    return {}
