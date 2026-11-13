"""Authentication use cases: register, login (throttled), sessions, password reset (enumeration-safe)."""

from __future__ import annotations

import re
import uuid
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import BadRequest, Conflict, RateLimited, Unauthenticated
from app.context import AppContext
from app.db.models import Membership, Organisation, PasswordResetToken, User, UserSession
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import ActorType, Role
from app.security.passwords import hash_password, verify_password
from app.security.tokens import new_token, token_hash
from app.services.audit import audit

DEFAULT_ORG_LIMITS = {"max_projects": 100, "max_concurrent_scans": 2, "max_pages_cap": 100}


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "org"
    return f"{s}-{uuid.uuid4().hex[:6]}"


async def create_session(
    s: AsyncSession, ctx: AppContext, user: User, org_id: uuid.UUID, ip: str, ua: str | None
) -> tuple[str, UserSession]:
    token = new_token()
    now = utcnow()
    row = UserSession(
        user_id=user.id,
        token_hash=token_hash(token),
        organisation_id=org_id,
        expires_at=now + timedelta(hours=ctx.settings.session_ttl_hours),
        ip=ip,
        user_agent=(ua or "")[:400],
        last_refreshed_at=now,
    )
    s.add(row)
    return token, row


async def register(
    s: AsyncSession,
    ctx: AppContext,
    *,
    full_name: str,
    email: str,
    password: str,
    org_name: str,
    ip: str,
    ua: str | None,
) -> tuple[str, UserSession, User, Organisation, Membership]:
    email = email.strip().lower()
    if (await s.execute(select(User.id).where(User.email == email))).scalar_one_or_none() is not None:
        raise Conflict(
            "An account with this email already exists",
            details=[{"field": "email", "message": "An account with this email already exists."}],
        )
    user = User(email=email, full_name=full_name.strip(), password_hash=hash_password(password))
    org = Organisation(name=org_name.strip(), slug=slugify(org_name), limits=dict(DEFAULT_ORG_LIMITS))
    s.add_all([user, org])
    await s.flush()
    membership = Membership(organisation_id=org.id, user_id=user.id, role=Role.owner, can_approve=True)
    s.add(membership)
    token, sess = await create_session(s, ctx, user, org.id, ip, ua)
    audit(
        s, org_id=org.id, action="user.registered", target_type="user", target_id=user.id, actor_user_id=user.id, ip=ip
    )
    audit(
        s,
        org_id=org.id,
        action="organisation.created",
        target_type="organisation",
        target_id=org.id,
        actor_user_id=user.id,
        ip=ip,
    )
    try:
        await s.commit()
    except IntegrityError as exc:
        await s.rollback()
        raise Conflict(
            "An account with this email already exists",
            details=[{"field": "email", "message": "An account with this email already exists."}],
        ) from exc
    return token, sess, user, org, membership


async def login(
    s: AsyncSession, ctx: AppContext, *, email: str, password: str, ip: str, ua: str | None
) -> tuple[str, UserSession, User, Organisation, Membership]:
    email = email.strip().lower()
    key = f"login:{ip}:{email}"
    st = ctx.settings
    retry = ctx.rate_limiter.check(key, st.rl_login_failures, st.rl_login_window_s)
    if retry is not None:
        raise RateLimited(f"Too many attempts. Try again in {max(1, int(retry // 60) or 1)} minutes.", retry)
    user = (await s.execute(select(User).where(User.email == email))).scalar_one_or_none()
    ok = verify_password(user.password_hash if user else None, password)
    if not ok or user is None or not user.is_active:
        ctx.rate_limiter.record(key)
        if user is not None:
            m = (
                (await s.execute(select(Membership).where(Membership.user_id == user.id).execution_options(**BYPASS)))
                .scalars()
                .first()
            )
            if m is not None:
                audit(
                    s,
                    org_id=m.organisation_id,
                    action="auth.login_failed",
                    target_type="user",
                    target_id=user.id,
                    actor_type=ActorType.system,
                    ip=ip,
                )
                await s.commit()
        raise Unauthenticated("Incorrect email or password")
    ctx.rate_limiter.reset(key)
    membership = (
        (
            await s.execute(
                select(Membership)
                .where(Membership.user_id == user.id)
                .order_by(Membership.created_at)
                .execution_options(**BYPASS)
            )
        )
        .scalars()
        .first()
    )
    if membership is None:
        raise Unauthenticated("Incorrect email or password")
    org = (await s.execute(select(Organisation).where(Organisation.id == membership.organisation_id))).scalar_one()
    user.last_login_at = utcnow()
    token, sess = await create_session(s, ctx, user, org.id, ip, ua)
    audit(s, org_id=org.id, action="auth.login", target_type="user", target_id=user.id, actor_user_id=user.id, ip=ip)
    await s.commit()
    return token, sess, user, org, membership


async def logout(s: AsyncSession, session_id: uuid.UUID, org_id: uuid.UUID, user_id: uuid.UUID, ip: str) -> None:
    await s.execute(update(UserSession).where(UserSession.id == session_id).values(revoked_at=utcnow()))
    audit(s, org_id=org_id, action="auth.logout", target_type="user", target_id=user_id, actor_user_id=user_id, ip=ip)
    await s.commit()


async def forgot_password(s: AsyncSession, ctx: AppContext, email: str) -> str | None:
    """Returns the raw token (only used for the dev link); the HTTP response is identical either way."""
    user = (await s.execute(select(User).where(User.email == email.strip().lower()))).scalar_one_or_none()
    token = new_token()
    if user is None or not user.is_active:
        return None
    s.add(PasswordResetToken(user_id=user.id, token_hash=token_hash(token), expires_at=utcnow() + timedelta(hours=1)))
    m = (
        (await s.execute(select(Membership).where(Membership.user_id == user.id).execution_options(**BYPASS)))
        .scalars()
        .first()
    )
    if m is not None:
        audit(
            s,
            org_id=m.organisation_id,
            action="auth.password_reset_requested",
            target_type="user",
            target_id=user.id,
            actor_user_id=user.id,
        )
    await s.commit()
    return token


async def reset_password(s: AsyncSession, token: str, password: str) -> None:
    row = (
        await s.execute(select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash(token)))
    ).scalar_one_or_none()
    now = utcnow()
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise BadRequest("This reset link is invalid or has expired. Request a new one.")
    user = (await s.execute(select(User).where(User.id == row.user_id))).scalar_one()
    user.password_hash = hash_password(password)
    await s.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
        .values(used_at=now)
    )
    await s.execute(
        update(UserSession)
        .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    m = (
        (await s.execute(select(Membership).where(Membership.user_id == user.id).execution_options(**BYPASS)))
        .scalars()
        .first()
    )
    if m is not None:
        audit(
            s,
            org_id=m.organisation_id,
            action="auth.password_reset",
            target_type="user",
            target_id=user.id,
            actor_user_id=user.id,
        )
    await s.commit()
