"""Auth flows (T7), error envelope, CORS and request ids."""

from __future__ import annotations

import httpx
from sqlalchemy import select

from app.context import AppContext
from app.db.models import AuditLog
from app.db.tenant import BYPASS
from tests.conftest import PASSWORD, client_for, register


async def test_register_login_me_logout(client: httpx.AsyncClient) -> None:
    acct = await register(client, "Ada@Example.com")
    me = await client.get("/api/v1/auth/me", headers=acct.headers)
    assert me.status_code == 200
    assert me.json()["role"] == "owner" and me.json()["can_approve"] is True
    assert me.json()["user"]["email"] == "ada@example.com"
    login = await client.post("/api/v1/auth/login", json={"email": "ada@example.com", "password": PASSWORD})
    assert login.status_code == 200
    out = await client.post("/api/v1/auth/logout", headers=acct.headers)
    assert out.status_code == 204
    after = await client.get("/api/v1/auth/me", headers=acct.headers)
    assert after.status_code == 401 and after.json()["error"]["code"] == "unauthenticated"


async def test_duplicate_email_conflict_and_validation_envelope(client: httpx.AsyncClient) -> None:
    await register(client, "dup@example.com")
    r = await client.post(
        "/api/v1/auth/register",
        json={"full_name": "B", "email": "dup@example.com", "password": PASSWORD, "organisation_name": "B"},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "conflict"
    bad = await client.post("/api/v1/auth/register", json={"full_name": "", "email": "nope", "password": "short"})
    err = bad.json()["error"]
    assert bad.status_code == 422 and err["code"] == "validation_error"
    assert {"email", "password"} <= {d["field"] for d in err["details"]}
    assert err["request_id"] == bad.headers["x-request-id"]


async def test_login_throttle_returns_429_with_retry_after(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(rl_login_failures=3)
    async with client_for(ctx) as c:
        await register(c, "t@example.com")
        for _ in range(3):
            r = await c.post("/api/v1/auth/login", json={"email": "t@example.com", "password": "wrong-password-1"})
            assert r.status_code == 401
            assert r.json()["error"]["message"] == "Incorrect email or password"
        blocked = await c.post("/api/v1/auth/login", json={"email": "t@example.com", "password": PASSWORD})
        assert blocked.status_code == 429 and blocked.json()["error"]["code"] == "rate_limited"
        assert int(blocked.headers["retry-after"]) > 0


async def test_unknown_email_login_uses_same_message(client: httpx.AsyncClient) -> None:
    r = await client.post("/api/v1/auth/login", json={"email": "ghost@example.com", "password": PASSWORD})
    assert r.status_code == 401 and r.json()["error"]["message"] == "Incorrect email or password"


async def test_forgot_password_is_enumeration_safe_and_reset_is_single_use(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(env="development")
    async with client_for(ctx) as c:
        acct = await register(c, "reset@example.com")
        known = await c.post("/api/v1/auth/forgot-password", json={"email": "reset@example.com"})
        unknown = await c.post("/api/v1/auth/forgot-password", json={"email": "ghost@example.com"})
        assert known.status_code == unknown.status_code == 200
        assert set(known.json()) == set(unknown.json())
        token = known.json()["dev_reset_link"].split("token=")[1]
        new_pw = "a-brand-new-password"
        assert (
            await c.post("/api/v1/auth/reset-password", json={"token": token, "password": new_pw})
        ).status_code == 200
        again = await c.post("/api/v1/auth/reset-password", json={"token": token, "password": "another-password-9"})
        assert again.status_code == 400
        # Reset revokes existing sessions.
        assert (await c.get("/api/v1/auth/me", headers=acct.headers)).status_code == 401
        assert (
            await c.post("/api/v1/auth/login", json={"email": "reset@example.com", "password": new_pw})
        ).status_code == 200
        async with ctx.session_factory() as s:
            actions = {a.action for a in (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars()}
        assert {"user.registered", "auth.password_reset_requested", "auth.password_reset"} <= actions


async def test_dev_reset_link_hidden_outside_development(client: httpx.AsyncClient) -> None:
    await register(client, "x@example.com")
    r = await client.post("/api/v1/auth/forgot-password", json={"email": "x@example.com"})
    assert r.json()["dev_reset_link"] is None


async def test_bad_token_and_cors(client: httpx.AsyncClient) -> None:
    r = await client.get(
        "/api/v1/projects", headers={"Authorization": "Bearer nonsense", "Origin": "http://localhost:3002"}
    )
    assert r.status_code == 401
    assert r.headers["access-control-allow-origin"] == "http://localhost:3002"
    pre = await client.options(
        "/api/v1/projects", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert "access-control-allow-origin" not in pre.headers


async def test_health(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["db"] is True and body["ai"]["enabled"] is False and body["worker"]["mode"] == "off"
    assert body["allow_private_targets"] is False


async def test_unhandled_error_returns_500_envelope_without_internals(api_ctx: AppContext) -> None:
    from app.main import create_app

    app = create_app(ctx=api_ctx, start_worker=False)

    @app.get("/api/v1/_boom")
    async def boom() -> None:
        raise RuntimeError("database password is hunter2")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/api/v1/_boom")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal" and "hunter2" not in r.text
    assert r.json()["error"]["request_id"] == r.headers["x-request-id"]


async def test_sse_preflight_from_web_origin_succeeds(client: httpx.AsyncClient) -> None:
    """BUG-3: the web client's fetch-streaming SSE request sends Cache-Control and Last-Event-ID."""
    r = await client.options(
        "/api/v1/projects/00000000-0000-0000-0000-000000000000/events/stream",
        headers={
            "Origin": "http://localhost:3002",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization, cache-control, last-event-id, accept",
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == "http://localhost:3002"
    allowed = r.headers["access-control-allow-headers"].lower()
    for h in ("authorization", "cache-control", "last-event-id", "accept"):
        assert h in allowed
