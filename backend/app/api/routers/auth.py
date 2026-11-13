from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.api.deps import Ctx, CurrentPrincipal, RawSession, client_ip
from app.api.errors import RateLimited
from app.db.models import Membership, Organisation, User, UserSession
from app.schemas import api
from app.services import auth as svc

router = APIRouter(prefix="/auth", tags=["auth"])


def _auth_response(token: str, sess: UserSession, user: User, org: Organisation, m: Membership) -> api.AuthResponse:
    return api.AuthResponse(
        token=token,
        expires_at=sess.expires_at,
        user=api.UserRef(id=user.id, email=user.email, full_name=user.full_name),
        organisation=api.OrganisationOut(id=org.id, name=org.name, slug=org.slug),
        role=m.role.value,
    )


def _ip_limit(ctx: Ctx, request: Request, kind: str) -> None:
    retry = ctx.rate_limiter.hit(f"{kind}:{client_ip(request)}", ctx.settings.rl_register_per_hour, 3600)
    if retry is not None:
        raise RateLimited(f"Too many attempts. Try again in {max(1, int(retry // 60))} minutes.", retry)


@router.post("/register", response_model=api.AuthResponse, status_code=201)
async def register(body: api.RegisterRequest, request: Request, ctx: Ctx, s: RawSession) -> api.AuthResponse:
    _ip_limit(ctx, request, "register")
    token, sess, user, org, m = await svc.register(
        s,
        ctx,
        full_name=body.full_name,
        email=str(body.email),
        password=body.password,
        org_name=body.organisation_name,
        ip=client_ip(request),
        ua=request.headers.get("user-agent"),
    )
    return _auth_response(token, sess, user, org, m)


@router.post("/login", response_model=api.AuthResponse)
async def login(body: api.LoginRequest, request: Request, ctx: Ctx, s: RawSession) -> api.AuthResponse:
    token, sess, user, org, m = await svc.login(
        s,
        ctx,
        email=str(body.email),
        password=body.password,
        ip=client_ip(request),
        ua=request.headers.get("user-agent"),
    )
    return _auth_response(token, sess, user, org, m)


@router.post("/logout", status_code=204)
async def logout(request: Request, p: CurrentPrincipal, s: RawSession) -> Response:
    await svc.logout(s, p.session_id, p.organisation.id, p.user.id, client_ip(request))
    return Response(status_code=204)


@router.get("/me", response_model=api.MeResponse)
async def me(p: CurrentPrincipal) -> api.MeResponse:
    return api.MeResponse(
        user=api.UserRef(id=p.user.id, email=p.user.email, full_name=p.user.full_name),
        organisation=api.OrganisationOut(id=p.organisation.id, name=p.organisation.name, slug=p.organisation.slug),
        role=p.membership.role.value,
        can_approve=p.membership.can_approve,
    )


@router.post("/forgot-password", response_model=api.ForgotPasswordResponse)
async def forgot_password(
    body: api.ForgotPasswordRequest, request: Request, ctx: Ctx, s: RawSession
) -> api.ForgotPasswordResponse:
    _ip_limit(ctx, request, "forgot")
    token = await svc.forgot_password(s, ctx, str(body.email))
    link = None
    if ctx.settings.env == "development":
        # No SMTP in Phase 1. The link is returned for unknown emails too, so the response shape never reveals
        # whether an account exists (the token is simply invalid then).
        from app.security.tokens import new_token

        link = f"{ctx.settings.web_origin.rstrip('/')}/reset-password?token={token or new_token()}"
    return api.ForgotPasswordResponse(ok=True, dev_reset_link=link)


@router.post("/reset-password", response_model=api.Ok)
async def reset_password(body: api.ResetPasswordRequest, s: RawSession) -> api.Ok:
    await svc.reset_password(s, body.token, body.password)
    return api.Ok()
