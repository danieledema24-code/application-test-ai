"""Chooses the LLM provider from settings. Never logs the key."""

from __future__ import annotations

from app.config import Settings
from app.llm.base import BaseLLMClient, DisabledLLM
from app.llm.claude import ClaudeClient
from app.security.redact import register_secret


def create_llm(settings: Settings) -> BaseLLMClient:
    if settings.ai_provider == "disabled":
        return DisabledLLM("AI is disabled by configuration")
    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    if not key:
        return DisabledLLM()
    register_secret(key)
    return ClaudeClient(key, settings.ai_model, timeout_s=settings.ai_timeout_s)
