"""Workspace members and invitations (P3-07, decision D5).

Owners and admins manage members; anyone in the workspace can list them (email shown to owners/admins only).
Invitations are one-time links: a 32-byte token returned once, stored only as its SHA-256, valid for 7 days.
Role changes take effect on the member's next request (`current_principal` re-reads the membership every time).
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.api.deps import Ctx, CurrentPrincipal, Principal, RawSession, ScopedSession, client_ip
from app.api.errors import Conflict, Forbidden, NotFound, RateLimited, ValidationFailed
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.db.models import Invitation, Membership, Organisation, User, UserSession
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import Role
from app.schemas import api
from app.security.passwords import hash_password
from app.security.tokens import new_token, token_hash
from app.services import auth as auth_svc
from app.services.audit import audit

router = APIRouter(tags=["members"])

INVITE_TTL = timedelta(days=7)
NO_LONGER_VALID = "This invitation is no longer valid"
HAS_ACCOUNT = "This email already has an account. Multi-workspace accounts aren't supported yet"
LAST_OWNER = "A workspace needs at least one owner"
INVITES_PER_HOUR = 20
LOOKUPS_PER_HOUR = 10
MANAGERS = (Role.owner, Role.admin)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemberPatch(Body):
    version: int | None = None
    role: Literal["owner", "admin", "member", "viewer"] | None = None
    can_approve: bool | None = None


class InvitationCreate(Body):
    email: EmailStr
    role: Literal["admin", "member", "viewer"]
    can_approve: bool = False


class AcceptBody(Body):
    full_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=10, max_length=200)

    @field_validator("full_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


def _manager(p: Principal) -> None:
    if p.membership.role not in MANAGERS:
        raise Forbidden("Only owners and admins can manage members")


def mask_email(email: str) -> str:
    """`jane.doe@example.com` -> `j***@example.com` (the public invitation page shows only this)."""
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


def _user_ref(u: User | None, *, with_email: bool) -> dict[str, Any] | None:
    if u is None:
        return None
    return {"id": str(u.id), "full_name": u.full_name, "email": u.email if with_email else None}


async def _users(s: Any, ids: list[uuid.UUID | None]) -> dict[uuid.UUID, User]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {u.id: u for u in (await s.execute(select(User).where(User.id.in_(wanted)))).scalars()}


def _member_out(m: Membership, us: dict[uuid.UUID, User], p: Principal) -> dict[str, Any]:
    see_email = p.membership.role in MANAGERS
    u = us.get(m.user_id)
    return {
        "membership_id": str(m.id),
        "user": _user_ref(u, with_email=see_email),
        "email": u.email if (u is not None and see_email) else None,
        "role": m.role.value,
        "can_approve": bool(m.can_approve),
        "joined_at": m.joined_at or m.created_at,
        "invited_by": _user_ref(us.get(m.invited_by), with_email=False) if m.invited_by else None,
        "is_you": m.user_id == p.user.id,
    }


def _status(inv: Invitation) -> str:
    if inv.accepted_at is not None:
        return "accepted"
    if inv.revoked_at is not None:
        return "revoked"
    if inv.expires_at <= utcnow():
        return "expired"
    return "pending"


def _invitation_out(inv: Invitation, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    return {
        "id": str(inv.id),
        "email": inv.email,
        "role": inv.role,
        "can_approve": inv.can_approve,
        "status": _status(inv),
        "invited_by": _user_ref(us.get(inv.invited_by), with_email=False),
        "created_at": inv.created_at,
        "expires_at": inv.expires_at,
        "accepted_at": inv.accepted_at,
    }


async def _owners(s: ScopedSession) -> int:
    return len(list((await s.execute(select(Membership.id).where(Membership.role == Role.owner))).scalars()))


# ---------------------------------------------------------------- members


@router.get("/organisation/members")
async def list_members(
    s: ScopedSession, p: CurrentPrincipal, limit: int | None = None, cursor: str | None = None
) -> dict[str, Any]:
    rows = list((await s.execute(select(Membership).order_by(Membership.created_at, Membership.id))).scalars())
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    page = rows[off : off + lim]
    us = await _users(s, [x for m in page for x in (m.user_id, m.invited_by)])
    return {
        "items": [_member_out(m, us, p) for m in page],
        "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None,
    }


async def _membership(s: ScopedSession, membership_id: uuid.UUID) -> Membership:
    m = (await s.execute(select(Membership).where(Membership.id == membership_id))).scalar_one_or_none()
    if m is None:
        raise NotFound("Member not found")
    return m


@router.patch("/organisation/members/{membership_id}")
async def patch_member(
    membership_id: uuid.UUID, body: MemberPatch, request: Request, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    _manager(p)
    m = await _membership(s, membership_id)
    new_role = Role(body.role) if body.role is not None else m.role
    touches_owner = Role.owner in (new_role, m.role) and new_role != m.role
    if touches_owner and p.membership.role != Role.owner:
        raise Forbidden("Only an owner can grant or change the owner role")
    if m.role == Role.owner and p.membership.role != Role.owner and body.can_approve is not None:
        raise Forbidden("Only an owner can change an owner")
    if m.user_id == p.user.id and p.membership.role == Role.admin and new_role != m.role:
        raise Forbidden("Admins can't change their own role")
    if m.role == Role.owner and new_role != Role.owner and await _owners(s) <= 1:
        raise Conflict(LAST_OWNER)
    if new_role == Role.viewer and body.can_approve:
        raise ValidationFailed(
            "Viewers can't approve gates", details=[{"field": "can_approve", "message": "Not allowed for viewers."}]
        )
    if new_role == Role.owner:
        can_approve = True  # owners always approve
    elif new_role == Role.viewer:
        can_approve = False
    elif body.can_approve is not None:
        can_approve = body.can_approve
    elif body.role is not None and new_role == Role.admin and m.role != Role.admin:
        can_approve = True  # defaults to true for admins
    else:
        can_approve = m.can_approve
    before = {"role": m.role.value, "can_approve": m.can_approve}
    m.role, m.can_approve = new_role, can_approve
    after = {"role": m.role.value, "can_approve": m.can_approve}
    if after != before:
        audit(
            s,
            org_id=p.organisation.id,
            action="member.role_changed",
            target_type="membership",
            target_id=m.id,
            actor_user_id=p.user.id,
            ip=client_ip(request),
            metadata={"user_id": str(m.user_id), "from": before, "to": after},
        )
        await s.commit()
    us = await _users(s, [m.user_id, m.invited_by])
    return _member_out(m, us, p)


@router.delete("/organisation/members/{membership_id}", status_code=204)
async def remove_member(membership_id: uuid.UUID, request: Request, s: ScopedSession, p: CurrentPrincipal) -> Response:
    _manager(p)
    m = await _membership(s, membership_id)
    if m.role == Role.owner and p.membership.role != Role.owner:
        raise Forbidden("Only an owner can remove an owner")
    if m.role == Role.owner and await _owners(s) <= 1:
        raise Conflict(LAST_OWNER)
    user_id = m.user_id
    await s.delete(m)
    await s.execute(
        update(UserSession)
        .where(
            UserSession.user_id == user_id,
            UserSession.organisation_id == p.organisation.id,
            UserSession.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )
    audit(
        s,
        org_id=p.organisation.id,
        action="member.removed",
        target_type="membership",
        target_id=membership_id,
        actor_user_id=p.user.id,
        ip=client_ip(request),
        metadata={"user_id": str(user_id)},
    )
    await s.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- invitations (managers)


@router.get("/organisation/invitations")
async def list_invitations(
    s: ScopedSession, p: CurrentPrincipal, status: Literal["pending", "expired", "accepted", "revoked"] | None = None
) -> list[dict[str, Any]]:
    _manager(p)
    rows = list((await s.execute(select(Invitation).order_by(Invitation.created_at.desc()))).scalars())
    if status:
        rows = [r for r in rows if _status(r) == status]
    us = await _users(s, [r.invited_by for r in rows])
    return [_invitation_out(r, us) for r in rows]


@router.post("/organisation/invitations", status_code=201)
async def create_invitation(
    body: InvitationCreate, request: Request, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    _manager(p)
    email = str(body.email).strip().lower()
    if body.role == "viewer" and body.can_approve:
        raise ValidationFailed(
            "Viewers can't approve gates", details=[{"field": "can_approve", "message": "Not allowed for viewers."}]
        )
    existing = (
        await s.execute(select(User.id).where(User.email == email).execution_options(**BYPASS))
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict(HAS_ACCOUNT, details=[{"field": "email", "message": HAS_ACCOUNT}])
    pending = [
        r
        for r in (await s.execute(select(Invitation).where(Invitation.email == email))).scalars()
        if _status(r) == "pending"
    ]
    if pending:
        raise Conflict(
            "This email already has a pending invitation; revoke it to send a new one",
            details=[{"field": "email", "message": "A pending invitation exists."}],
        )
    retry = ctx.rate_limiter.hit(f"invite:{p.organisation.id}", INVITES_PER_HOUR, 3600)
    if retry is not None:
        raise RateLimited(f"Too many invitations. Try again in {max(1, int(retry // 60))} minutes.", retry)
    token = new_token()
    inv = Invitation(
        organisation_id=p.organisation.id,
        email=email,
        role=body.role,
        can_approve=body.can_approve,
        token_hash=token_hash(token),
        invited_by=p.user.id,
        expires_at=utcnow() + INVITE_TTL,
    )
    s.add(inv)
    await s.flush()
    audit(
        s,
        org_id=p.organisation.id,
        action="member.invited",
        target_type="invitation",
        target_id=inv.id,
        actor_user_id=p.user.id,
        ip=client_ip(request),
        metadata={"email": email, "role": body.role, "can_approve": body.can_approve},
    )
    await s.commit()
    us = await _users(s, [p.user.id])
    return {"invitation": _invitation_out(inv, us), "link": f"/invite/{token}"}


@router.post("/organisation/invitations/{invitation_id}/revoke")
async def revoke_invitation(
    invitation_id: uuid.UUID, request: Request, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    _manager(p)
    inv = (await s.execute(select(Invitation).where(Invitation.id == invitation_id))).scalar_one_or_none()
    if inv is None:
        raise NotFound("Invitation not found")
    if _status(inv) == "pending":
        inv.revoked_at = utcnow()
        inv.revoked_by = p.user.id
        audit(
            s,
            org_id=p.organisation.id,
            action="invitation.revoked",
            target_type="invitation",
            target_id=inv.id,
            actor_user_id=p.user.id,
            ip=client_ip(request),
            metadata={"email": inv.email},
        )
        await s.commit()
    us = await _users(s, [inv.invited_by])
    return _invitation_out(inv, us)


# ---------------------------------------------------------------- public


def _ip_limit(ctx: Ctx, request: Request) -> None:
    retry = ctx.rate_limiter.hit(f"invitation:{client_ip(request)}", LOOKUPS_PER_HOUR, 3600)
    if retry is not None:
        raise RateLimited(f"Too many attempts. Try again in {max(1, int(retry // 60))} minutes.", retry)


async def _valid(s: RawSession, token: str) -> Invitation:
    if not token or len(token) > 200:
        raise NotFound(NO_LONGER_VALID)
    inv = (
        await s.execute(
            select(Invitation).where(Invitation.token_hash == token_hash(token)).execution_options(**BYPASS)
        )
    ).scalar_one_or_none()
    if inv is None or _status(inv) != "pending":
        raise NotFound(NO_LONGER_VALID)
    return inv


@router.get("/invitations/{token}")
async def lookup_invitation(token: str, request: Request, ctx: Ctx, s: RawSession) -> dict[str, Any]:
    _ip_limit(ctx, request)
    inv = await _valid(s, token)
    org = (await s.execute(select(Organisation).where(Organisation.id == inv.organisation_id))).scalar_one()
    inviter = (await s.execute(select(User).where(User.id == inv.invited_by))).scalar_one_or_none()
    return {
        "organisation_name": org.name,
        "invited_by_name": inviter.full_name if inviter else None,
        "role": inv.role,
        "email_hint": mask_email(inv.email),
        "expires_at": inv.expires_at,
    }


@router.post("/invitations/{token}/accept", response_model=api.AuthResponse, status_code=201)
async def accept_invitation(
    token: str, body: AcceptBody, request: Request, ctx: Ctx, s: RawSession
) -> api.AuthResponse:
    _ip_limit(ctx, request)
    inv = await _valid(s, token)
    if (
        await s.execute(select(User.id).where(User.email == inv.email).execution_options(**BYPASS))
    ).scalar_one_or_none() is not None:
        raise Conflict(HAS_ACCOUNT)
    org = (await s.execute(select(Organisation).where(Organisation.id == inv.organisation_id))).scalar_one()
    user = User(email=inv.email, full_name=body.full_name, password_hash=hash_password(body.password))
    s.add(user)
    await s.flush()
    role = Role(inv.role)
    m = Membership(
        organisation_id=org.id,
        user_id=user.id,
        role=role,
        can_approve=bool(inv.can_approve) and role != Role.viewer,
        invited_by=inv.invited_by,
        joined_at=utcnow(),
    )
    s.add(m)
    inv.accepted_at = utcnow()
    inv.accepted_user_id = user.id
    tok, sess = await auth_svc.create_session(
        s, ctx, user, org.id, client_ip(request), request.headers.get("user-agent")
    )
    audit(
        s,
        org_id=org.id,
        action="member.joined",
        target_type="membership",
        target_id=m.id,
        actor_user_id=user.id,
        ip=client_ip(request),
        metadata={"invitation_id": str(inv.id), "role": role.value, "can_approve": m.can_approve},
    )
    try:
        await s.commit()
    except IntegrityError as exc:
        await s.rollback()
        raise Conflict(HAS_ACCOUNT) from exc
    return api.AuthResponse(
        token=tok,
        expires_at=sess.expires_at,
        user=api.UserRef(id=user.id, email=user.email, full_name=user.full_name),
        organisation=api.OrganisationOut(id=org.id, name=org.name, slug=org.slug),
        role=m.role.value,
    )
