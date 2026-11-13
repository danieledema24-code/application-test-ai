"""Traceability matrix, coverage, gaps and chains (P3-04). Computed on read; any role can read."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Query

from app.api.deps import CurrentPrincipal, ScopedSession
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers import p2common as c
from app.services import traceability as trace

router = APIRouter(tags=["traceability"])


@router.get("/projects/{project_id}/traceability")
async def matrix(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    view: Literal["forward", "backward"] = "forward",
    basis: Literal["current", "approved"] = "current",
    status: str | None = None,
    risk_level: str | None = None,
    feature_id: uuid.UUID | None = None,
    uncovered: bool | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    t = await trace.load(s, project_id, basis)
    rows = trace.forward_rows(t) if view == "forward" else trace.backward_rows(t)
    if status:
        wanted = set(status.split(","))
        key = "requirement_status" if view == "forward" else "status"
        rows = [r for r in rows if r[key] in wanted]
    if risk_level:
        levels = set(risk_level.split(","))
        rows = [r for r in rows if (r["_risk_level"] or "none") in levels]
    if feature_id is not None:
        rows = [r for r in rows if str(feature_id) in r["_feature_ids"]]
    if uncovered is not None:
        rows = [r for r in rows if (not r["_approved_case"]) == uncovered]
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    page = [trace.public(r) for r in rows[off : off + lim]]
    return {"items": page, "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None}


@router.get("/projects/{project_id}/traceability/coverage")
async def coverage(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    basis: Literal["current", "approved"] = "current",
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    return trace.coverage(await trace.load(s, project_id, basis))


@router.get("/projects/{project_id}/traceability/gaps")
async def gaps(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    basis: Literal["current", "approved"] = "current",
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    t = await trace.load(s, project_id, basis)
    return await trace.gaps(s, t)


@router.get("/projects/{project_id}/traceability/chain")
async def chain(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, key: str = Query(min_length=3, max_length=40)
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    return trace.chain(await trace.load(s, project_id), key)
