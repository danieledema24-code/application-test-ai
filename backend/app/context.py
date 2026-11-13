"""Process-wide services shared by the API and the worker."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

import httpx
from sqlalchemy.ext.asyncio import AsyncEngine

from app.browser.pool import BrowserPool
from app.config import Settings
from app.db.session import SessionFactory, create_engine, create_session_factory
from app.events.emitter import EventEmitter
from app.llm.base import BaseLLMClient
from app.llm.factory import create_llm
from app.queue.sql_queue import SqlJobQueue
from app.security.crypto import Encryptor
from app.security.ratelimit import RateLimiter
from app.security.signing import UrlSigner
from app.security.ssrf import Resolver, default_resolver
from app.storage.local import LocalStorage


@dataclass
class AppContext:
    settings: Settings
    engine: AsyncEngine
    session_factory: SessionFactory
    storage: LocalStorage
    llm: BaseLLMClient
    signer: UrlSigner
    encryptor: Encryptor
    rate_limiter: RateLimiter
    queue: SqlJobQueue
    events: EventEmitter
    browser_pool: BrowserPool
    resolver: Resolver = default_resolver
    # Test hook: lets URL checks run against httpx.MockTransport. None = real network.
    http_transport: httpx.AsyncBaseTransport | None = None
    worker_id: str = field(default_factory=lambda: f"w-{uuid.uuid4().hex[:8]}")

    def evidence_url(self, evidence_id: uuid.UUID, org_id: uuid.UUID) -> str:
        exp, sig = self.signer.sign(evidence_id, org_id)
        return f"{self.settings.public_api_url.rstrip('/')}/api/v1/evidence/{evidence_id}/content?exp={exp}&sig={sig}"

    async def close(self) -> None:
        await self.browser_pool.close()
        await self.engine.dispose()


def build_context(settings: Settings, *, llm: BaseLLMClient | None = None) -> AppContext:
    engine = create_engine(settings.database_url)
    sf = create_session_factory(engine)
    secret = settings.secret_key.get_secret_value().encode()
    return AppContext(
        settings=settings,
        engine=engine,
        session_factory=sf,
        storage=LocalStorage(settings.storage_dir),
        llm=llm if llm is not None else create_llm(settings),
        signer=UrlSigner(secret, settings.signed_url_ttl_s),
        encryptor=Encryptor({settings.encryption_key_id: settings.encryption_key_bytes()}, settings.encryption_key_id),
        rate_limiter=RateLimiter(),
        queue=SqlJobQueue(sf),
        events=EventEmitter(sf),
        browser_pool=BrowserPool(headless=settings.browser_headless, max_contexts=settings.pool_max_contexts),
    )
