from __future__ import annotations

import uuid

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, ScopedSession, client_ip
from app.api.errors import Forbidden, NotFound
from app.db.models import Evidence
from app.db.tenant import BYPASS
from app.domain.enums import EvidenceKind
from app.schemas import api
from app.services import serialize as ser
from app.services.audit import audit

router = APIRouter(prefix="/evidence", tags=["evidence"])


@router.get("/{evidence_id}", response_model=api.EvidenceDetail)
async def get_evidence(evidence_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> api.EvidenceDetail:
    ev = (await s.execute(select(Evidence).where(Evidence.id == evidence_id))).scalar_one_or_none()
    if ev is None:
        raise NotFound("Evidence not found")
    return api.EvidenceDetail(
        **ser.evidence_link(ctx, ev).model_dump(),
        sha256=ev.sha256,
        scan_session_id=ev.scan_session_id,
        metadata=ev.meta or {},
    )


@router.get("/{evidence_id}/content")
async def evidence_content(
    evidence_id: uuid.UUID, request: Request, ctx: Ctx, exp: int = Query(...), sig: str = Query(..., max_length=128)
) -> Response:
    """Public but signed: HMAC(secret, id|exp|org_id). The org comes from the stored row, so a signature minted
    for one organisation never opens another organisation's evidence."""
    async with ctx.session_factory() as s:
        ev = (
            await s.execute(select(Evidence).where(Evidence.id == evidence_id).execution_options(**BYPASS))
        ).scalar_one_or_none()
        if ev is None or not ctx.signer.verify(ev.id, ev.organisation_id, exp, sig):
            raise Forbidden("This link is invalid or has expired")
        data = await ctx.storage.get(ev.storage_key)
        if ev.kind == EvidenceKind.report_render:
            audit(
                s,
                org_id=ev.organisation_id,
                action="report.downloaded",
                target_type="evidence",
                target_id=ev.id,
                project_id=ev.project_id,
                ip=client_ip(request),
                metadata={"filename": (ev.meta or {}).get("filename")},
            )
            await s.commit()
    is_image = ev.mime.startswith("image/")
    filename = str((ev.meta or {}).get("filename") or f"{ev.key or ev.id}").replace('"', "")
    disposition = "inline" if is_image else "attachment"
    return Response(
        content=data,
        media_type=ev.mime,
        headers={
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            "Content-Security-Policy": "sandbox",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=600",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )
