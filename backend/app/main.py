"""FastAPI application: middleware, error envelope, routers and the inline worker."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.errors import AppError, envelope
from app.api.routers import (
    assistant,
    auth,
    dashboard,
    documents,
    events,
    evidence,
    health,
    members,
    projects,
    reports,
    requirements,
    review,
    scans,
    secrets,
    strategy,
    testdesign,
    traceability,
    workflow,
)
from app.config import Settings, get_settings
from app.context import AppContext, build_context
from app.db.migrate import prepare_database
from app.logging import configure_logging, request_id_var
from app.orchestrator.orchestrator import Orchestrator
from app.queue.runner import Worker

log = logging.getLogger("app.http")

HTTP_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "bad_request",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
}


class RequestIdMiddleware:
    """Pure ASGI: assigns X-Request-ID and turns unhandled exceptions into the 500 envelope (no internals leaked)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode("latin-1")
        rid = incoming if incoming and len(incoming) <= 64 and incoming.replace("-", "").isalnum() else uuid.uuid4().hex
        token = request_id_var.set(rid)
        started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = list(message.get("headers") or [])
                headers.append((b"x-request-id", rid.encode()))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("unhandled error on %s %s", scope.get("method"), scope.get("path"))
            if not started:
                body = json.dumps(envelope("internal", "Something went wrong on our side. Try again.", rid)).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 500,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                            (b"x-request-id", rid.encode()),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
        finally:
            request_id_var.reset(token)


def _field(loc: tuple[Any, ...] | list[Any]) -> str:
    parts = [str(p) for p in loc if p not in ("body", "query", "path", "header")]
    return ".".join(parts) or "body"


def create_app(
    settings: Settings | None = None, ctx: AppContext | None = None, *, start_worker: bool | None = None
) -> FastAPI:
    settings = settings or (ctx.settings if ctx else get_settings())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging(settings.log_level, settings.log_json)
        context = ctx or build_context(settings)
        app.state.ctx = context
        await prepare_database(context.engine, settings)
        # P2-01 data step: Phase 1 credential rows get kind + non-secret metadata (idempotent; needs the key).
        from app.services.secrets import backfill

        await backfill(context)
        # P3-00 data step (decision D1): G5 becomes a required sign-off on existing projects (idempotent).
        from app.services.projects import require_g5_signoff

        await require_g5_signoff(context)
        worker: Worker | None = None
        run_worker = start_worker if start_worker is not None else settings.worker_mode == "inline"
        if run_worker:
            orch = Orchestrator(context)
            worker = Worker(context, orch.run_job, on_interrupted=orch.on_job_interrupted, mode="inline")
            await worker.start()
        app.state.worker = worker
        try:
            yield
        finally:
            if worker is not None:
                await worker.stop()
            if ctx is None:
                await context.close()

    app = FastAPI(
        title="QA Analyst API",
        version=settings.app_version,
        lifespan=lifespan,
        docs_url="/api/v1/docs",
        openapi_url="/api/v1/openapi.json",
        redoc_url=None,
    )
    if ctx is not None:
        app.state.ctx = ctx

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            envelope(exc.code, exc.message, request_id_var.get(), exc.details),
            status_code=exc.status_code,
            headers=exc.headers or None,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"field": _field(e.get("loc", ())), "message": str(e.get("msg", "Invalid value"))} for e in exc.errors()
        ]
        msg = details[0]["message"] if len(details) == 1 else "Some fields need attention"
        return JSONResponse(envelope("validation_error", msg, request_id_var.get(), details), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = HTTP_CODES.get(exc.status_code, "internal" if exc.status_code >= 500 else "bad_request")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JSONResponse(
            envelope(code, message, request_id_var.get()),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    origins = [settings.web_origin, *settings.extra_test_origins]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        # The SSE client (fetch streaming) sends Cache-Control and Last-Event-ID; Accept for text/event-stream.
        allow_headers=["Authorization", "Content-Type", "Accept", "Cache-Control", "Last-Event-ID", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Retry-After"],
    )
    app.add_middleware(RequestIdMiddleware)
    for r in (
        health,
        members,
        auth,
        projects,
        workflow,
        review,
        requirements,
        strategy,
        testdesign,
        traceability,
        secrets,
        documents,
        assistant,
        scans,
        evidence,
        reports,
        events,
        dashboard,
    ):
        app.include_router(r.router, prefix="/api/v1")
    return app


app = create_app()
