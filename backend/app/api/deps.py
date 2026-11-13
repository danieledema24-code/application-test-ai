"""Request dependencies: app context, authenticated principal, tenant-scoped DB session, role checks."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Forbidden, RateLimited, Unauthenticated
from app.context import AppContext
from app.db.models import Membership, Organisation, User, UserSession
from app.db.tenant import BYPASS, TenantScope, bind_scope
from app.db.types import utcnow
from app.domain.enums import Role
from app.logging import org_id_var
from app.security.tokens import token_hash


def get_ctx(request: Request) -> AppContext:
    ctx: AppContext = request.app.state.ctx
    return ctx


Ctx = Annotated[AppContext, Depends(get_ctx)]


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def raw_session(ctx: Ctx) -> AsyncIterator[AsyncSession]:
    async with ctx.session_factory() as s:
        yield s


RawSession = Annotated[AsyncSession, Depends(raw_session)]


@dataclass
class Principal:
    user: User
    organisation: Organisation
    membership: Membership
    session_id: uuid.UUID
    token: str

    @property
    def scope(self) -> TenantScope:
        return TenantScope(
            org_id=self.organisation.id,
            user_id=self.user.id,
            role=self.membership.role,
            can_approve=self.membership.can_approve,
        )


async def current_principal(
    request: Request,
    ctx: Ctx,
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthenticated("Sign in to continue")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise Unauthenticated("Sign in to continue")
    retry = ctx.rate_limiter.hit(f"api:{token_hash(token)}", ctx.settings.rl_api_per_min, 60)
    if retry is not None:
        raise RateLimited("Too many requests", retry)
    now = utcnow()
    async with ctx.session_factory() as s:
        sess = (
            await s.execute(select(UserSession).where(UserSession.token_hash == token_hash(token)))
        ).scalar_one_or_none()
        if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
            raise Unauthenticated("Your session expired. Sign in again to continue.")
        user = (await s.execute(select(User).where(User.id == sess.user_id))).scalar_one_or_none()
        org = (
            await s.execute(select(Organisation).where(Organisation.id == sess.organisation_id))
        ).scalar_one_or_none()
        membership = (
            await s.execute(
                select(Membership)
                .where(Membership.user_id == sess.user_id, Membership.organisation_id == sess.organisation_id)
                .execution_options(**BYPASS)
            )
        ).scalar_one_or_none()
        if user is None or not user.is_active or org is None or membership is None:
            raise Unauthenticated("Sign in to continue")
        # Sliding refresh: after 1 h of use, extend the 12 h lifetime.
        last = sess.last_refreshed_at or sess.created_at
        if now - last > timedelta(hours=1):
            sess.expires_at = now + timedelta(hours=ctx.settings.session_ttl_hours)
            sess.last_refreshed_at = now
            await s.commit()
    org_id_var.set(str(org.id))
    return Principal(user=user, organisation=org, membership=membership, session_id=sess.id, token=token)


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


async def scoped_session(ctx: Ctx, principal: CurrentPrincipal) -> AsyncIterator[AsyncSession]:
    async with ctx.session_factory() as s:
        bind_scope(s, principal.scope)
        yield s


ScopedSession = Annotated[AsyncSession, Depends(scoped_session)]


def require_member(principal: CurrentPrincipal) -> Principal:
    if principal.membership.role == Role.viewer:
        raise Forbidden("Viewers have read-only access")
    return principal


MemberPrincipal = Annotated[Principal, Depends(require_member)]
