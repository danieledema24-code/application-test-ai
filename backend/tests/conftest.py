"""Shared fixtures: per-test SQLite database (copied from a migrated template), app context and HTTP client."""

from __future__ import annotations

import shutil
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.context import AppContext, build_context
from app.db.migrate import upgrade
from app.db.session import create_engine
from app.llm.base import BaseLLMClient, DisabledLLM
from app.main import create_app
from app.orchestrator.orchestrator import Orchestrator
from app.queue.runner import Worker

PUBLIC_IP = "93.184.216.34"
PASSWORD = "correct-horse-battery"


def make_settings(tmp: Path, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "env": "test",
        "database_url": f"sqlite+aiosqlite:///{tmp / 'qa.db'}",
        "storage_dir": tmp / "storage",
        "worker_mode": "off",
        "log_json": False,
        "ai_provider": "disabled",
        "public_api_url": "http://test",
        "scan_politeness_delay_ms": 0,
        "scan_page_timeout_s": 10,
        "rl_register_per_hour": 1000,
        "sse_max_connection_s": 2,
        "sse_poll_interval_s": 0.05,
        "sse_keepalive_s": 0.5,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


@pytest.fixture(scope="session")
async def template_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("template") / "qa.db"
    engine = create_engine(f"sqlite+aiosqlite:///{path}")
    await upgrade(engine)
    await engine.dispose()
    return path


CtxFactory = Callable[..., Awaitable[AppContext]]


@pytest.fixture
async def make_ctx(tmp_path: Path, template_db: Path) -> AsyncIterator[CtxFactory]:
    """Builds an AppContext on a fresh copy of the migrated database. Extra kwargs override settings."""
    created: list[AppContext] = []

    async def factory(
        *,
        llm: BaseLLMClient | None = None,
        resolver: Any = None,
        transport: httpx.AsyncBaseTransport | None = None,
        **overrides: Any,
    ) -> AppContext:
        if not created:
            shutil.copy(template_db, tmp_path / "qa.db")
        settings = make_settings(tmp_path, **overrides)
        ctx = build_context(settings, llm=llm or DisabledLLM())
        if resolver is not None:
            ctx.resolver = resolver
        ctx.http_transport = transport
        created.append(ctx)
        return ctx

    yield factory
    for c in created:
        await c.close()


@pytest.fixture
async def ctx(make_ctx: CtxFactory) -> AppContext:
    return await make_ctx()


def public_resolver(mapping: dict[str, str] | None = None) -> Callable[[str], Awaitable[list[str]]]:
    """DNS stub: every name resolves to a public test address unless mapped otherwise."""
    table = mapping or {}

    async def resolve(host: str) -> list[str]:
        if host in table:
            return [table[host]] if table[host] else []
        return [PUBLIC_IP]

    return resolve


def site_transport(pages: dict[str, httpx.Response] | None = None) -> httpx.MockTransport:
    """httpx stub for URL checks against fictional public sites."""
    table = pages or {}

    def handler(request: httpx.Request) -> httpx.Response:
        key = str(request.url)
        if key in table:
            return table[key]
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        return httpx.Response(200, headers={"content-type": "text/html"}, html="<title>Shop</title><h1>Shop</h1>")

    return httpx.MockTransport(handler)


@pytest.fixture
async def api_ctx(make_ctx: CtxFactory) -> AppContext:
    """Context for API tests: fictional public sites, no network."""
    return await make_ctx(resolver=public_resolver(), transport=site_transport())


@pytest.fixture
async def client(api_ctx: AppContext) -> AsyncIterator[httpx.AsyncClient]:
    async with client_for(api_ctx) as c:
        yield c


def client_for(ctx: AppContext) -> httpx.AsyncClient:
    app = create_app(ctx=ctx, start_worker=False)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


class Account:
    def __init__(self, data: dict[str, Any]) -> None:
        self.token: str = data["token"]
        self.user_id = uuid.UUID(data["user"]["id"])
        self.org_id = uuid.UUID(data["organisation"]["id"])
        self.email: str = data["user"]["email"]

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


async def register(client: httpx.AsyncClient, email: str | None = None, org: str = "Acme QA") -> Account:
    email = email or f"user-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/v1/auth/register",
        json={"full_name": "Ada Tester", "email": email, "password": PASSWORD, "organisation_name": org},
    )
    assert r.status_code == 201, r.text
    return Account(r.json())


def project_body(url: str = "https://shop.example.com", **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "url": url,
        "authorisation": {"attested": True, "statement": "I am authorised to test this site."},
        "start": False,
    }
    body.update(extra)
    return body


async def create_project(
    client: httpx.AsyncClient, acct: Account, url: str = "https://shop.example.com", **extra: Any
) -> dict[str, Any]:
    r = await client.post("/api/v1/projects", json=project_body(url, **extra), headers=acct.headers)
    assert r.status_code == 201, r.text
    data: dict[str, Any] = r.json()
    return data


def worker_for(ctx: AppContext) -> Worker:
    orch = Orchestrator(ctx)
    return Worker(ctx, orch.run_job, on_interrupted=orch.on_job_interrupted, concurrency=2, heartbeat_s=0.5)
