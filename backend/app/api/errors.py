"""AppError hierarchy mapped to the JSON error envelope (api-contracts.md)."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        details: list[dict[str, Any]] | dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        code: str | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details: list[dict[str, Any]] | dict[str, Any] = details if details is not None else []
        self.headers = headers or {}
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code


class BadRequest(AppError):
    status_code = 400
    code = "bad_request"


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_error"


class Unauthenticated(AppError):
    status_code = 401
    code = "unauthenticated"


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"


class NotFound(AppError):
    status_code = 404
    code = "not_found"

    def __init__(self, message: str = "Not found", **kw: Any) -> None:
        super().__init__(message, **kw)


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class GateBlocked(AppError):
    status_code = 409
    code = "gate_blocked"


class DuplicateProject(AppError):
    """409 with an object `details` ({project_id, project_name, primary_url}); code agreed with the web client."""

    status_code = 409
    code = "DUPLICATE_PROJECT"


class UrlBlocked(AppError):
    status_code = 422
    code = "url_blocked"


class UrlUnreachable(AppError):
    status_code = 422
    code = "url_unreachable"


class RateLimited(AppError):
    status_code = 429
    code = "rate_limited"

    def __init__(self, message: str, retry_after_s: float, **kw: Any) -> None:
        super().__init__(message, headers={"Retry-After": str(int(retry_after_s))}, **kw)
        self.retry_after_s = retry_after_s


def envelope(
    code: str, message: str, request_id: str | None, details: list[dict[str, Any]] | dict[str, Any] | None = None
) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or [], "request_id": request_id}}
