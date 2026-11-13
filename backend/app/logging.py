"""Structured JSON logging with request/tenant context and a redaction filter on every record."""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from app.security.redact import redact_text

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
org_id_var: ContextVar[str | None] = ContextVar("org_id", default=None)
project_id_var: ContextVar[str | None] = ContextVar("project_id", default=None)
job_id_var: ContextVar[str | None] = ContextVar("job_id", default=None)
task_id_var: ContextVar[str | None] = ContextVar("task_id", default=None)

_CONTEXT = {
    "request_id": request_id_var,
    "org_id": org_id_var,
    "project_id": project_id_var,
    "job_id": job_id_var,
    "task_id": task_id_var,
}
_STD_ATTRS = set(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime"}


class ContextRedactFilter(logging.Filter):
    """Adds context ids and redacts the message and any extra fields."""

    def filter(self, record: logging.LogRecord) -> bool:
        for name, var in _CONTEXT.items():
            if getattr(record, name, None) is None:
                setattr(record, name, var.get())
        try:
            message = record.getMessage()
        except (TypeError, ValueError):
            message = str(record.msg)
        record.msg = redact_text(message)
        record.args = None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact_text(record.exc_text)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for name in _CONTEXT:
            value = getattr(record, name, None)
            if value:
                out[name] = value
        for key, value in record.__dict__.items():
            if key not in _STD_ATTRS and key not in _CONTEXT and not key.startswith("_"):
                out[key] = redact_text(value) if isinstance(value, str) else value
        if record.exc_text:
            out["exc"] = record.exc_text
        return json.dumps(out, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        rid = getattr(record, "request_id", None)
        base = f"{datetime.fromtimestamp(record.created, UTC).strftime('%H:%M:%S')} {record.levelname:<7} {record.name}"
        line = f"{base} [{rid}] {record.getMessage()}" if rid else f"{base} {record.getMessage()}"
        return f"{line}\n{record.exc_text}" if record.exc_text else line


def configure_logging(level: str = "INFO", json_logs: bool = True) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(ContextRedactFilter())
    handler.setFormatter(JsonFormatter() if json_logs else TextFormatter())
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_qa_handler", False):
            root.removeHandler(h)
    handler._qa_handler = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level.upper())
    for noisy in ("uvicorn.access", "aiosqlite", "httpx", "httpcore", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
