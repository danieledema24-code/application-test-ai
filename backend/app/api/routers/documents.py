"""Source documents (P2-08): upload (multipart, parsed with the stdlib), list, detail, download, withdraw."""

from __future__ import annotations

import hashlib
import re
import uuid
from email import message_from_bytes
from email.message import Message
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession, client_ip
from app.api.errors import Conflict, RateLimited, ValidationFailed
from app.api.routers import p2common as c
from app.db.models import Evidence, Requirement, SourceDocument
from app.db.types import utcnow
from app.domain.enums import DocumentStatus, EvidenceKind, StageKey
from app.services import documents as docs
from app.services import serialize as ser
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.counters import next_key
from app.services.evidence import write_evidence

router = APIRouter(tags=["documents"])
DEFAULT_MAX_MB = 20
DEFAULT_MAX_DOCS = 10


class WithdrawBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str | None = Field(None, max_length=500)


def _doc_out(d: SourceDocument, us: dict[uuid.UUID, Any]) -> dict[str, Any]:
    ready = d.status == DocumentStatus.ready
    # PDFs: one outline entry per page read, so pages_done < pages_total means the page cap was hit.
    pages_done = len(d.outline or []) if ready and d.mime == docs.PDF else None
    truncated = (d.chars or 0) >= docs.MAX_CHARS
    return {
        "partial": ready and (truncated or (pages_done is not None and d.pages is not None and pages_done < d.pages)),
        "pages_done": pages_done,
        "pages_total": d.pages,
        "id": d.id,
        "key": d.key,
        "title": d.title,
        "filename": d.filename,
        "mime": d.mime,
        "size": d.size,
        "sha256": d.sha256,
        "status": d.status.value,
        "pages": d.pages,
        "chars": d.chars,
        "sections": len(d.outline or []) if d.status == DocumentStatus.ready else None,
        "statements_found": len(d.statements or []) if d.status != DocumentStatus.extracting else None,
        "injection_flags": len(d.injection_flags or []),
        "error": d.error,
        "uploaded_by": out.user_dict(us.get(d.uploaded_by)),
        "created_at": d.created_at,
        "withdrawn_at": d.withdrawn_at,
    }


def _parse_multipart(content_type: str, body: bytes) -> tuple[bytes | None, str, str | None]:
    """Returns (file bytes, filename, title) from a multipart/form-data body."""
    msg: Message = message_from_bytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not msg.is_multipart():
        raise ValidationFailed(
            "Send the file as multipart/form-data", details=[{"field": "file", "message": "Missing"}]
        )
    data: bytes | None = None
    filename = ""
    title: str | None = None
    for part in msg.get_payload():
        assert isinstance(part, Message)
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True)
        raw = payload if isinstance(payload, bytes) else b""
        if name == "file":
            data = raw
            filename = str(part.get_filename() or "document")
        elif name == "title":
            title = raw.decode("utf-8", errors="replace").strip() or None
    return data, filename, title


def _safe_filename(name: str) -> str:
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return re.sub(r"[^A-Za-z0-9._ -]", "_", base)[:200] or "document"


async def mark_requirements_stale(s: ScopedSession, project_id: uuid.UUID, reason: str) -> None:
    from app.domain.stages import OUTPUT_STATUSES

    st = await c.stage(s, project_id, StageKey.requirements)
    if st.status in OUTPUT_STATUSES:
        from app.domain.enums import StageStatus

        st.status = StageStatus.stale
        st.stale_reason = reason


@router.post("/projects/{project_id}/documents", status_code=202)
async def upload(
    project_id: uuid.UUID, request: Request, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    limits = p.organisation.limits or {}
    max_bytes = int(limits.get("max_document_mb", DEFAULT_MAX_MB)) * 1024 * 1024
    max_docs = int(limits.get("max_documents", DEFAULT_MAX_DOCS))
    if int(request.headers.get("content-length") or 0) > max_bytes + 64 * 1024:
        raise ValidationFailed(
            f"Files can be up to {max_bytes // (1024 * 1024)} MB", details=[{"field": "file", "message": "Too large"}]
        )
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > max_bytes + 64 * 1024:
            raise ValidationFailed(
                f"Files can be up to {max_bytes // (1024 * 1024)} MB",
                details=[{"field": "file", "message": "Too large"}],
            )
    data, filename, title = _parse_multipart(request.headers.get("content-type", ""), body)
    if not data:
        raise ValidationFailed("Choose a file to upload", details=[{"field": "file", "message": "Missing"}])
    if len(data) > max_bytes:
        raise ValidationFailed(
            f"Files can be up to {max_bytes // (1024 * 1024)} MB", details=[{"field": "file", "message": "Too large"}]
        )
    if title is not None and len(title) > 160:
        raise ValidationFailed("Title is too long", details=[{"field": "title", "message": "Up to 160 characters"}])
    filename = _safe_filename(filename)
    try:
        mime = docs.sniff(data, filename)
    except docs.DocumentError as exc:
        raise ValidationFailed(str(exc), details=[{"field": "file", "message": str(exc)}]) from exc
    active = (
        await s.execute(
            select(func.count()).where(
                SourceDocument.project_id == project_id, SourceDocument.status != DocumentStatus.withdrawn
            )
        )
    ).scalar_one()
    if int(active) >= max_docs:
        raise Conflict(f"A project can have up to {max_docs} documents; withdraw one first")
    retry = ctx.rate_limiter.hit(f"docs:{project_id}", 20, 3600)
    if retry is not None:
        raise RateLimited("Too many uploads for this project in the last hour", retry)
    doc_id = uuid.uuid4()
    ev = await write_evidence(
        s,
        ctx.storage,
        org_id=project.organisation_id,
        project_id=project_id,
        kind=EvidenceKind.document_file,
        data=data,
        mime=mime,
        name=filename,
        owner_id=doc_id,
        metadata={"filename": filename},
    )
    doc_key = (await next_key(s, project.organisation_id, project_id, "DOC"))[1]
    await s.flush()  # the evidence row must exist before the document row that references it
    doc = SourceDocument(
        id=doc_id,
        organisation_id=project.organisation_id,
        project_id=project_id,
        key=doc_key,
        title=(title or filename)[:160],
        filename=filename,
        mime=mime,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        status=DocumentStatus.extracting,
        file_evidence_id=ev.id,
        uploaded_by=p.user.id,
    )
    s.add(doc)
    await s.flush()
    ev.source_document_id = doc.id
    await mark_requirements_stale(s, project_id, f"A source document was added ({doc.key})")
    audit(
        s,
        org_id=project.organisation_id,
        action="document.uploaded",
        target_type="document",
        target_id=doc.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"key": doc.key, "mime": mime, "size": len(data)},
    )
    await s.commit()
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project_id,
        type="document.uploaded",
        message=f"Uploaded {doc.key} {doc.title}",
        stage_key="requirements",
        agent_key="requirements",
        data={"kind": "action", "document_id": str(doc.id), "key": doc.key},
    )
    await ctx.queue.enqueue(
        "document_extract",
        {"document_id": str(doc.id)},
        org_id=project.organisation_id,
        project_id=project_id,
        dedupe_key=f"doc:{doc.id}",
    )
    us = await out.users(s, [doc.uploaded_by])
    return _doc_out(doc, us)


@router.get("/projects/{project_id}/documents")
async def list_documents(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    status: str | None = None,
    include_withdrawn: bool = False,
) -> list[dict[str, Any]]:
    await c.project_of(s, project_id)
    stmt = select(SourceDocument).where(SourceDocument.project_id == project_id)
    if status:
        stmt = stmt.where(SourceDocument.status.in_(status.split(",")))
    elif not include_withdrawn:
        stmt = stmt.where(SourceDocument.status != DocumentStatus.withdrawn)
    rows = list((await s.execute(stmt.order_by(SourceDocument.key))).scalars())
    us = await out.users(s, [r.uploaded_by for r in rows])
    return [_doc_out(r, us) for r in rows]


@router.get("/documents/{doc_id}")
async def get_document(doc_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    d: SourceDocument = await c.load(s, SourceDocument, doc_id, "Document")
    us = await out.users(s, [d.uploaded_by])
    evs = await ser.evidence_map(s, [d.file_evidence_id, d.text_evidence_id])
    cited: list[dict[str, Any]] = []
    if d.text_evidence_id is not None:
        _run = await c.stage(s, d.project_id, StageKey.requirements)
        if _run.current_stage_run_id is not None:
            reqs = (
                await s.execute(select(Requirement).where(Requirement.stage_run_id == _run.current_stage_run_id))
            ).scalars()
            cited = [
                out.artefact_ref(d.project_id, "requirement", r.id, r.key, r.title)
                for r in reqs
                if str(d.id) in [str(x) for x in (r.source_refs or {}).get("document_ids", [])]
            ]
    return {
        **_doc_out(d, us),
        "outline": [
            {"anchor": o.get("anchor"), "heading": o.get("heading"), "page": o.get("page")} for o in d.outline or []
        ],
        "injection_findings": list(d.injection_flags or []),
        "file": ser.evidence_link(ctx, evs[d.file_evidence_id]).model_dump(mode="json")
        if d.file_evidence_id in evs
        else None,
        "text": ser.evidence_link(ctx, evs[d.text_evidence_id]).model_dump(mode="json")
        if d.text_evidence_id and d.text_evidence_id in evs
        else None,
        "cited_by": cited,
        "withdraw_reason": d.withdraw_reason,
    }


@router.get("/documents/{doc_id}/download")
async def download(
    doc_id: uuid.UUID, request: Request, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> RedirectResponse:
    d: SourceDocument = await c.load(s, SourceDocument, doc_id, "Document")
    ev = await s.get(Evidence, d.file_evidence_id)
    assert ev is not None
    audit(
        s,
        org_id=d.organisation_id,
        action="document.downloaded",
        target_type="document",
        target_id=d.id,
        actor_user_id=p.user.id,
        project_id=d.project_id,
        ip=client_ip(request),
    )
    await s.commit()
    return RedirectResponse(ctx.evidence_url(ev.id, ev.organisation_id), status_code=302)


@router.post("/documents/{doc_id}/withdraw")
async def withdraw(doc_id: uuid.UUID, body: WithdrawBody, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    d: SourceDocument = await c.load(s, SourceDocument, doc_id, "Document")
    if d.status != DocumentStatus.withdrawn:
        d.status = DocumentStatus.withdrawn
        d.withdrawn_at = utcnow()
        d.withdrawn_by = p.user.id
        d.withdraw_reason = body.reason
        await mark_requirements_stale(s, d.project_id, f"A source document was withdrawn ({d.key})")
        audit(
            s,
            org_id=d.organisation_id,
            action="document.withdrawn",
            target_type="document",
            target_id=d.id,
            actor_user_id=p.user.id,
            project_id=d.project_id,
            metadata={"key": d.key, "reason": body.reason},
        )
        await s.commit()
    us = await out.users(s, [d.uploaded_by])
    return _doc_out(d, us)
