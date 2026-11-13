"""Claude provider via the official `anthropic` SDK. Structured output through forced tool use, then re-validated."""

from __future__ import annotations

from typing import Any

import anthropic

from app.llm.base import BaseLLMClient, Budget, LLMTransportError, LLMUsage, RawCompletion, ToolTurnResult

TOOL_NAME = "emit_result"


class ClaudeClient(BaseLLMClient):
    provider = "anthropic"

    def __init__(self, api_key: str, model: str, *, timeout_s: float = 120.0, max_retries: int = 2) -> None:
        self.model = model
        # The SDK retries 408/409/429/5xx/overloaded with exponential backoff.
        self._client = anthropic.AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=max_retries)

    async def _complete(self, system: str, user: str, schema: dict[str, Any], budget: Budget) -> RawCompletion:
        assert self.model is not None
        try:
            resp = await self._client.messages.create(
                model=self.model,
                max_tokens=budget.max_output_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                tools=[{"name": TOOL_NAME, "description": "Return the structured result.", "input_schema": schema}],
                tool_choice={"type": "tool", "name": TOOL_NAME},
            )
        except anthropic.APIError as exc:
            raise LLMTransportError(f"{type(exc).__name__}: {getattr(exc, 'message', 'provider error')}") from exc
        data: Any = None
        for block in resp.content:
            if block.type == "tool_use" and block.name == TOOL_NAME:
                data = block.input
                break
        if data is None:
            data = "".join(getattr(b, "text", "") for b in resp.content)
        return RawCompletion(data=data, tokens_in=resp.usage.input_tokens, tokens_out=resp.usage.output_tokens)

    async def tool_turn(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], budget: Budget | None = None
    ) -> ToolTurnResult:
        assert self.model is not None
        budget = budget or Budget()
        try:
            resp = await self._client.messages.create(
                model=self.model,
                max_tokens=budget.max_output_tokens,
                system=system,
                messages=messages,  # type: ignore[arg-type]
                tools=tools,  # type: ignore[arg-type]
            )
        except anthropic.APIError as exc:
            raise LLMTransportError(f"{type(exc).__name__}: {getattr(exc, 'message', 'provider error')}") from exc
        text = "".join(getattr(b, "text", "") for b in resp.content if b.type == "text")
        calls = [{"id": b.id, "name": b.name, "input": b.input} for b in resp.content if b.type == "tool_use"]
        usage = LLMUsage(self.provider, self.model, resp.usage.input_tokens, resp.usage.output_tokens, calls=1)
        return ToolTurnResult(text=text, tool_calls=calls, usage=usage)
