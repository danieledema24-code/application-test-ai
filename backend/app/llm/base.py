"""Provider-independent LLM interface (architecture.md "llm/").

Every call: redaction first, untrusted content wrapped, output validated with Pydantic, one repair attempt with
the validation errors, then the caller's rule-based fallback. Callers must always have a deterministic fallback.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from app.llm.untrusted import SYSTEM_RULES, wrap_untrusted
from app.security.redact import redact_text

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class UntrustedBlock:
    source: str
    content: str
    max_chars: int = 4000


@dataclass(frozen=True)
class Budget:
    max_output_tokens: int = 4000


class ResultStatus(StrEnum):
    ok = "ok"
    unavailable = "unavailable"  # AI disabled / not configured
    invalid = "invalid"  # output failed validation after one repair
    error = "error"  # transport/provider error after retries


@dataclass
class LLMUsage:
    provider: str | None
    model: str | None
    tokens_in: int = 0
    tokens_out: int = 0
    calls: int = 0
    repairs: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "calls": self.calls,
            "repairs": self.repairs,
        }


@dataclass
class StructuredResult(Generic[T]):
    status: ResultStatus
    value: T | None = None
    usage: LLMUsage | None = None
    issues: list[str] = field(default_factory=list)
    reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == ResultStatus.ok and self.value is not None


@dataclass
class RawCompletion:
    data: Any  # parsed tool input (dict) or raw text
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class ToolTurnResult:
    text: str
    tool_calls: list[dict[str, Any]]
    usage: LLMUsage


class LLMTransportError(RuntimeError):
    pass


class LLMClient(Protocol):
    enabled: bool
    provider: str | None
    model: str | None

    async def structured(
        self,
        schema: type[T],
        task: str,
        untrusted_blocks: Sequence[UntrustedBlock] = (),
        budget: Budget | None = None,
    ) -> StructuredResult[T]: ...

    async def tool_turn(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], budget: Budget | None = None
    ) -> ToolTurnResult: ...


def build_prompt(task: str, blocks: Sequence[UntrustedBlock]) -> tuple[str, str]:
    """Returns (system, user). Redaction runs on the task and on every block before wrapping."""
    parts = [f"Task:\n{redact_text(task)}"]
    if blocks:
        parts.append("Website data (untrusted):")
        parts.extend(wrap_untrusted(redact_text(b.content), b.source, b.max_chars) for b in blocks)
    return SYSTEM_RULES, "\n\n".join(parts)


def _errors_text(exc: ValidationError) -> str:
    lines = []
    for e in exc.errors()[:20]:
        loc = ".".join(str(x) for x in e.get("loc", ()))
        lines.append(f"- {loc or '(root)'}: {e.get('msg')}")
    return "\n".join(lines)


class BaseLLMClient:
    """Shared structured-output loop. Subclasses implement `_complete`."""

    enabled: bool = True
    provider: str | None = None
    model: str | None = None

    async def _complete(self, system: str, user: str, schema: dict[str, Any], budget: Budget) -> RawCompletion:
        raise NotImplementedError

    async def tool_turn(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], budget: Budget | None = None
    ) -> ToolTurnResult:
        raise LLMTransportError("Tool turns are not supported by this provider")

    async def structured(
        self,
        schema: type[T],
        task: str,
        untrusted_blocks: Sequence[UntrustedBlock] = (),
        budget: Budget | None = None,
    ) -> StructuredResult[T]:
        budget = budget or Budget()
        usage = LLMUsage(self.provider, self.model)
        system, user = build_prompt(task, untrusted_blocks)
        json_schema = schema.model_json_schema()
        issues: list[str] = []
        for attempt in range(2):
            try:
                raw = await self._complete(system, user, json_schema, budget)
            except LLMTransportError as exc:
                log.warning("LLM call failed: %s", exc)
                return StructuredResult(ResultStatus.error, usage=usage, reason=str(exc), issues=issues)
            usage.calls += 1
            usage.tokens_in += raw.tokens_in
            usage.tokens_out += raw.tokens_out
            try:
                data = json.loads(raw.data) if isinstance(raw.data, str) else raw.data
                value = schema.model_validate(data)
                return StructuredResult(ResultStatus.ok, value=value, usage=usage, issues=issues)
            except json.JSONDecodeError as exc:
                problem = f"Output was not valid JSON: {exc.msg}"
            except ValidationError as exc:
                problem = _errors_text(exc)
            issues.append(f"attempt {attempt + 1}: {problem}")
            if attempt == 0:
                usage.repairs += 1
                user = (
                    f"{user}\n\nYour previous output failed validation:\n{problem}\n"
                    "Call the tool again with corrected output that matches the schema exactly."
                )
        return StructuredResult(ResultStatus.invalid, usage=usage, issues=issues, reason="Output failed validation")


class DisabledLLM(BaseLLMClient):
    enabled = False
    provider = None
    model = None

    def __init__(self, reason: str = "AI is not configured (no ANTHROPIC_API_KEY)") -> None:
        self.reason = reason

    async def structured(
        self,
        schema: type[T],
        task: str,
        untrusted_blocks: Sequence[UntrustedBlock] = (),
        budget: Budget | None = None,
    ) -> StructuredResult[T]:
        return StructuredResult(ResultStatus.unavailable, reason=self.reason)


class FakeLLM(BaseLLMClient):
    """Scripted provider for tests. Captures every (system, user) payload actually sent."""

    provider = "fake"
    model = "fake-model"

    def __init__(self, responses: Sequence[Any] = ()) -> None:
        self.responses = list(responses)
        self.captured: list[dict[str, Any]] = []

    async def _complete(self, system: str, user: str, schema: dict[str, Any], budget: Budget) -> RawCompletion:
        self.captured.append({"system": system, "user": user, "schema": schema})
        if not self.responses:
            raise LLMTransportError("FakeLLM has no scripted response left")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise LLMTransportError(str(item))
        return RawCompletion(data=item, tokens_in=len(user) // 4, tokens_out=50)
