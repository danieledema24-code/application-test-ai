"""AI QA Analyst assistant endpoints (P2-10). Threads are private to their user; proposals apply through the same
router/service functions as the REST API, with the caller's permissions."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import AppError, Conflict, Forbidden, NotFound, RateLimited, ValidationFailed
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers import p2common as c
from app.db.models import AssistantMessage, AssistantProposal, AssistantThread, Requirement, Risk
from app.db.types import utcnow
from app.domain.enums import MessageRole, ProposalStatus, Role
from app.services import assistant as asst
from app.services import serialize_p2 as out
from app.services.audit import audit

router = APIRouter(tags=["assistant"])
MAX_MESSAGES = 50

Intent = Literal[
    "help",
    "workflow_status",
    "needs_attention",
    "coverage_summary",
    "list_requirements",
    "explain_requirement",
    "explain_gate",
    "list_access_gaps",
    "risk_summary",
    "execution_results",
    "propose_negative_criteria",
    "propose_risk_reassessment",
    "propose_regenerate",
    "propose_requirement_update",
    "propose_missing_requirements",
    "propose_risk_update",
]


class ThreadCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(None, max_length=120)


class ArtefactRefIn(BaseModel):
    type: str = Field(max_length=32)
    id: uuid.UUID | None = None
    key: str = Field(max_length=32)
    label: str | None = Field(None, max_length=200)
    path: str | None = Field(None, max_length=300)


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str | None = Field(None, min_length=1, max_length=4000)
    intent: Intent | None = None
    params: dict[str, Any] = {}
    context: ArtefactRefIn | None = None

    @model_validator(mode="after")
    def _one(self) -> MessageCreate:
        if not self.content and not self.intent:
            raise ValueError("Send a message or choose a question")
        return self


class DecisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    comment: str | None = Field(None, max_length=2000)


async def _thread(s: ScopedSession, thread_id: uuid.UUID, p: Principal) -> AssistantThread:
    t = (await s.execute(select(AssistantThread).where(AssistantThread.id == thread_id))).scalar_one_or_none()
    if t is None or t.user_id != p.user.id:
        raise NotFound("Conversation not found")  # private per user: other users' threads don't exist for them
    return t


async def _pending(s: ScopedSession, thread_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not thread_ids:
        return {}
    rows = await s.execute(
        select(AssistantProposal.thread_id, func.count())
        .where(AssistantProposal.thread_id.in_(thread_ids), AssistantProposal.status == ProposalStatus.pending)
        .group_by(AssistantProposal.thread_id)
    )
    return {row[0]: int(row[1]) for row in rows.all()}


def _thread_summary(t: AssistantThread, pending: int) -> dict[str, Any]:
    return {
        "id": t.id,
        "project_id": t.project_id,
        "title": t.title,
        "created_at": t.created_at,
        "last_message_at": t.last_message_at,
        "archived_at": t.archived_at,
        "pending_proposals": pending,
    }


async def _messages_out(s: ScopedSession, msgs: list[AssistantMessage]) -> list[dict[str, Any]]:
    props = (
        list(
            (
                await s.execute(
                    select(AssistantProposal)
                    .where(AssistantProposal.message_id.in_([m.id for m in msgs]))
                    .order_by(AssistantProposal.key)
                )
            ).scalars()
        )
        if msgs
        else []
    )
    us = await out.users(s, [x for p in props for x in (p.created_by, p.decided_by)])
    by_msg: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for pr in props:
        by_msg.setdefault(pr.message_id, []).append(asst.proposal_out(pr, us))
    res = []
    for m in msgs:
        extra = m.llm or {}
        res.append(
            {
                "id": m.id,
                "thread_id": m.thread_id,
                "role": m.role.value,
                "content": m.content,
                "intent": m.intent,
                "answered_by": m.answered_by,
                "generated_by": m.generated_by,
                "citations": list(m.citations or []),
                "proposals": by_msg.get(m.id, []),
                "notices": list(m.notices or []),
                "data_versions": extra.get("data_versions", {}) if m.role == MessageRole.assistant else {},
                "follow_ups": extra.get("follow_ups", []) if m.role == MessageRole.assistant else [],
                "context": m.context_ref,
                "created_at": m.created_at,
            }
        )
    return res


@router.get("/projects/{project_id}/assistant/capabilities")
async def capabilities(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    return asst.capabilities(ctx)


@router.get("/projects/{project_id}/assistant/threads")
async def list_threads(
    project_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    limit: int | None = None,
    cursor: str | None = None,
    include_archived: bool = False,
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    stmt = select(AssistantThread).where(AssistantThread.project_id == project_id, AssistantThread.user_id == p.user.id)
    if not include_archived:
        stmt = stmt.where(AssistantThread.archived_at.is_(None))
    rows = list((await s.execute(stmt.order_by(AssistantThread.last_message_at.desc()))).scalars())
    off, lim = decode_cursor(cursor), clamp_limit(limit, 20)
    page = rows[off : off + lim]
    pending = await _pending(s, [t.id for t in page])
    return {
        "items": [_thread_summary(t, pending.get(t.id, 0)) for t in page],
        "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None,
    }


@router.post("/projects/{project_id}/assistant/threads", status_code=201)
async def create_thread(
    project_id: uuid.UUID, body: ThreadCreate, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    t = AssistantThread(
        organisation_id=project.organisation_id,
        project_id=project_id,
        user_id=p.user.id,
        title=(body.title or "New conversation").strip()[:120] or "New conversation",
    )
    s.add(t)
    await s.commit()
    return {**_thread_summary(t, 0), "messages": [], "has_more": False}


@router.get("/assistant/threads/{thread_id}")
async def get_thread(
    thread_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal, before: uuid.UUID | None = None, limit: int = 30
) -> dict[str, Any]:
    t = await _thread(s, thread_id, p)
    stmt = select(AssistantMessage).where(AssistantMessage.thread_id == t.id)
    if before is not None:
        anchor = await s.get(AssistantMessage, before)
        if anchor is None or anchor.thread_id != t.id:
            raise NotFound("Message not found")
        stmt = stmt.where(AssistantMessage.created_at < anchor.created_at)
    lim = max(1, min(MAX_MESSAGES, limit))
    rows = list((await s.execute(stmt.order_by(AssistantMessage.created_at.desc()).limit(lim + 1))).scalars())
    has_more = len(rows) > lim
    msgs = list(reversed(rows[:lim]))
    pending = await _pending(s, [t.id])
    return {**_thread_summary(t, pending.get(t.id, 0)), "messages": await _messages_out(s, msgs), "has_more": has_more}


@router.post("/assistant/threads/{thread_id}/archive", status_code=204)
async def archive_thread(thread_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> Response:
    t = await _thread(s, thread_id, p)
    if t.archived_at is None:
        t.archived_at = utcnow()
        await s.commit()
    return Response(status_code=204)


async def _answer(
    ctx: Ctx, s: ScopedSession, p: Principal, t: AssistantThread, body: MessageCreate
) -> tuple[asst.Answer, bool]:
    """Returns the answer and whether it used an AI turn."""
    turn = asst.Turn(ctx, s, t.project_id, can_edit=p.membership.role != Role.viewer)
    params = dict(body.params or {})
    if body.context is not None and body.context.type == "requirement":
        params.setdefault("key", body.context.key)
        params.setdefault("requirement_key", body.context.key)
    intent = body.intent
    if intent is not None:
        spec = asst.INTENTS[intent]
        if spec.requires_ai:
            if not ctx.llm.enabled:
                a = asst.Answer("This needs AI, which isn't configured for this installation.", intent)
                a.notice("ai_unavailable", asst.AI_OFF_NOTICE)
                return a, False
            if not spec.available:
                a = asst.Answer("This task isn't available yet.", intent)
                a.notice("partial_answer", "Coming in a later release.")
                return a, False
            _ai_quota(ctx, p)
            return await asst.ai_requirement_update(turn, params), True
        return await asst.HANDLERS[intent](turn, params), False
    text = body.content or ""
    if ctx.llm.enabled:
        _ai_quota(ctx, p)
        ai = await asst.ai_answer(turn, text)
        if ai is not None:
            return ai, True
        routed = asst.route(text)
        fallback = (
            await asst.HANDLERS[routed[0]](turn, {**params, **routed[1]})
            if routed
            else await asst.HANDLERS["help"](turn, {})
        )
        fallback.notice("partial_answer", "The AI answer could not be used; this is a built-in answer.")
        return fallback, True
    routed = asst.route(text)
    if routed is None:
        a = await asst.HANDLERS["help"](turn, {})
        a.content = "I can't answer free-form questions without AI. " + a.content
        a.notice("ai_unavailable", asst.AI_OFF_NOTICE)
        return a, False
    a = await asst.HANDLERS[routed[0]](turn, {**params, **routed[1]})
    a.notice("built_in_answer", "Answered with a built-in question because AI isn't configured.")
    return a, False


def _ai_quota(ctx: Ctx, p: Principal) -> None:
    per_day = int((p.organisation.limits or {}).get("assistant_ai_turns_per_day", asst.DEFAULT_AI_TURNS_PER_DAY))
    retry = ctx.rate_limiter.hit(f"assistant_ai:{p.organisation.id}", per_day, 86400)
    if retry is not None:
        raise RateLimited("Your organisation has used today's AI answers; built-in questions still work", retry)


@router.post("/assistant/threads/{thread_id}/messages", response_model=None)
async def post_message(
    thread_id: uuid.UUID, body: MessageCreate, request: Request, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any] | StreamingResponse:
    t = await _thread(s, thread_id, p)
    if t.archived_at is not None:
        raise Conflict("This conversation is archived")
    retry = ctx.rate_limiter.hit(f"assistant_msg:{p.user.id}", 20, 60)
    if retry is not None:
        raise RateLimited("Too many messages; wait a moment", retry)
    user_msg = AssistantMessage(
        organisation_id=t.organisation_id,
        thread_id=t.id,
        project_id=t.project_id,
        role=MessageRole.user,
        content=body.content or asst.INTENTS[body.intent or "help"].label,
        intent=body.intent,
        params=body.params or {},
        context_ref=body.context.model_dump(mode="json") if body.context else None,
    )
    s.add(user_msg)
    await s.flush()
    ans, _used_ai = await _answer(ctx, s, p, t, body)
    await asst.citation_guard(s, t.project_id, ans)
    reply = AssistantMessage(
        organisation_id=t.organisation_id,
        thread_id=t.id,
        project_id=t.project_id,
        role=MessageRole.assistant,
        content=ans.content,
        intent=ans.intent,
        answered_by=ans.answered_by,
        generated_by=ans.generated_by,
        citations=ans.citations,
        notices=ans.notices,
        llm={
            "usage": ans.llm,
            "data_versions": await asst.data_versions(s, t.project_id),
            "follow_ups": ans.follow_ups,
        },
    )
    reply.created_at = utcnow()
    if reply.created_at <= user_msg.created_at:
        from datetime import timedelta

        reply.created_at = user_msg.created_at + timedelta(microseconds=1)
    s.add(reply)
    await s.flush()
    await asst.persist_proposals(s, t, reply.id, p.user.id, ans)
    t.last_message_at = reply.created_at
    if t.title == "New conversation" and body.content:
        t.title = body.content.strip()[:120]
    await s.commit()
    msgs = await _messages_out(s, [user_msg, reply])
    turn = {"user_message": msgs[0], "reply": msgs[1]}
    if "text/event-stream" not in request.headers.get("accept", ""):
        return turn
    return StreamingResponse(_sse(turn), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


async def _sse(turn: dict[str, Any]) -> AsyncIterator[bytes]:
    def frame(event: str, data: Any) -> bytes:
        return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n".encode()

    reply = turn["reply"]
    yield frame("assistant.started", {"message_id": str(reply["id"]), "answered_by": reply["answered_by"]})
    for pr in reply["proposals"]:
        yield frame("assistant.proposal", pr)
    yield frame("assistant.done", turn)


# ---------------------------------------------------------------- proposals


async def _proposal(s: ScopedSession, proposal_id: uuid.UUID, p: Principal) -> AssistantProposal:
    pr = (await s.execute(select(AssistantProposal).where(AssistantProposal.id == proposal_id))).scalar_one_or_none()
    if pr is None or (pr.created_by != p.user.id and not p.membership.can_approve):
        raise NotFound("Proposal not found")
    return pr


async def _proposal_out(s: ScopedSession, pr: AssistantProposal) -> dict[str, Any]:
    us = await out.users(s, [pr.created_by, pr.decided_by])
    return asst.proposal_out(pr, us)


@router.get("/projects/{project_id}/assistant/proposals")
async def list_proposals(
    project_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    status: str | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    stmt = select(AssistantProposal).where(AssistantProposal.project_id == project_id)
    if p.membership.can_approve:
        stmt = stmt.where(
            (AssistantProposal.created_by == p.user.id) | (AssistantProposal.status == ProposalStatus.pending)
        )
    else:
        stmt = stmt.where(AssistantProposal.created_by == p.user.id)
    if status:
        stmt = stmt.where(AssistantProposal.status.in_(status.split(",")))
    rows = list((await s.execute(stmt.order_by(AssistantProposal.created_at.desc()))).scalars())
    off, lim = decode_cursor(cursor), clamp_limit(limit, 20)
    page = rows[off : off + lim]
    us = await out.users(s, [x for pr in page for x in (pr.created_by, pr.decided_by)])
    return {
        "items": [asst.proposal_out(pr, us) for pr in page],
        "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None,
    }


@router.get("/assistant/proposals/{proposal_id}")
async def get_proposal(proposal_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _proposal_out(s, await _proposal(s, proposal_id, p))


async def _apply(ctx: Ctx, s: ScopedSession, p: Principal, pr: AssistantProposal) -> list[dict[str, Any]]:
    from app.api.routers import requirements as req_api
    from app.api.routers import strategy as strat_api
    from app.api.routers import workflow as wf_api
    from app.schemas import api

    payload = pr.payload or {}
    applied: list[dict[str, Any]] = []
    reason = f"Accepted assistant proposal {pr.key}"
    if pr.kind == "add_acceptance_criteria":
        rid = uuid.UUID(payload["requirement_id"])
        req = await c.load(s, Requirement, rid, "Requirement")
        c.check_version(req, int(pr.base_versions.get(str(rid), -1)))
        for crit in payload.get("criteria", []):
            ac_body = req_api.AcCreate(kind=crit["kind"], given=crit["given"], when=crit["when"], then=crit["then"])
            ac = await req_api.create_ac(rid, ac_body, ctx, s, p)
            applied.append(out.artefact_ref(pr.project_id, "acceptance_criterion", ac["id"], ac["key"], ac["then"]))
    elif pr.kind == "update_requirement":
        rid = uuid.UUID(payload["requirement_id"])
        req = await c.load(s, Requirement, rid, "Requirement")
        c.check_version(req, int(pr.base_versions.get(str(rid), -1)))
        patch = req_api.RequirementPatch(
            version=req.version,
            title=payload.get("title"),
            description=payload.get("description"),
            change_reason=reason,
        )
        d = await req_api.patch_requirement(rid, patch, ctx, s, p)
        applied.append(out.artefact_ref(pr.project_id, "requirement", d["id"], d["key"], d["title"]))
    elif pr.kind == "reassess_risks":
        changes = payload.get("changes", [])
        for ch in changes:  # check every base version first so it applies all or nothing
            risk = await c.load(s, Risk, uuid.UUID(ch["risk_id"]), "Risk")
            c.check_version(risk, int(pr.base_versions.get(ch["risk_id"], -1)))
        for ch in changes:
            risk = await c.load(s, Risk, uuid.UUID(ch["risk_id"]), "Risk")
            body = strat_api.RiskPatch(
                version=risk.version,
                likelihood=int(ch["likelihood"]),
                likelihood_rationale=str(ch["rationale"])[:1000],
                change_reason=reason,
            )
            r = await strat_api.patch_risk(risk.id, body, ctx, s, p)
            applied.append(out.artefact_ref(pr.project_id, "risk", r["id"], r["key"], r["title"]))
    elif pr.kind == "regenerate_stage":
        stage = str(payload.get("stage"))
        if stage == "test_plan":
            await strat_api.regenerate_plan(pr.project_id, strat_api.Guidance(guidance=None), s, p)
        else:
            await wf_api.run_stage(
                pr.project_id, api.StageRunRequest(reason=payload.get("reason") or reason), ctx, s, p, stage=stage
            )
        applied.append({"type": "stage", "id": None, "key": stage, "label": stage, "path": None})
    else:
        raise ValidationFailed("This proposal can't be applied")
    return applied


@router.post("/assistant/proposals/{proposal_id}/accept")
async def accept_proposal(
    proposal_id: uuid.UUID, body: DecisionBody, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    pr = await _proposal(s, proposal_id, p)
    if pr.created_by != p.user.id:
        raise Forbidden("Only the person who asked for this proposal can accept it")
    if pr.status != ProposalStatus.pending:
        raise Conflict(f"This proposal is already {pr.status.value}")
    pid, key = pr.id, pr.key
    token = c.PROPOSAL.set((pid, key))
    try:
        applied = await _apply(ctx, s, p, pr)
    except Conflict:
        await s.rollback()
        pr = await _proposal(s, pid, p)
        pr.status = ProposalStatus.stale
        pr.result = {"applied": [], "error": "The target changed after this proposal was made"}
        await s.commit()
        raise Conflict("The target changed after this proposal was made; ask again for a fresh proposal") from None
    except AppError as exc:
        await s.rollback()
        pr = await _proposal(s, pid, p)
        pr.status = ProposalStatus.failed
        pr.result = {"applied": [], "error": exc.message}
        await s.commit()
        raise
    finally:
        c.PROPOSAL.reset(token)
    pr = await _proposal(s, pid, p)
    pr.status = ProposalStatus.accepted
    pr.decided_by = p.user.id
    pr.decided_at = utcnow()
    pr.decision_comment = body.comment
    pr.result = {"applied": json.loads(json.dumps(applied, default=str)), "error": None}
    audit(
        s,
        org_id=pr.organisation_id,
        action="assistant.proposal_accepted",
        target_type="proposal",
        target_id=pr.id,
        actor_user_id=p.user.id,
        project_id=pr.project_id,
        metadata={"key": key, "kind": pr.kind},
    )
    await s.commit()
    for ref in applied:
        if ref.get("type") in ("requirement", "acceptance_criterion", "risk"):
            await ctx.events.emit(
                org_id=pr.organisation_id,
                project_id=pr.project_id,
                type="artefact.updated",
                message=f"{ref['key']} updated from assistant proposal {key}",
                data={"kind": "action", "type": ref["type"], "key": ref["key"], "source": "assistant_proposal"},
            )
    return await _proposal_out(s, pr)


@router.post("/assistant/proposals/{proposal_id}/reject")
async def reject_proposal(
    proposal_id: uuid.UUID, body: DecisionBody, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    pr = await _proposal(s, proposal_id, p)
    if pr.created_by != p.user.id:
        raise Forbidden("Only the person who asked for this proposal can reject it")
    if pr.status != ProposalStatus.pending:
        raise Conflict(f"This proposal is already {pr.status.value}")
    pr.status = ProposalStatus.rejected
    pr.decided_by = p.user.id
    pr.decided_at = utcnow()
    pr.decision_comment = body.comment
    audit(
        s,
        org_id=pr.organisation_id,
        action="assistant.proposal_rejected",
        target_type="proposal",
        target_id=pr.id,
        actor_user_id=p.user.id,
        project_id=pr.project_id,
        metadata={"key": pr.key},
    )
    await s.commit()
    return await _proposal_out(s, pr)
