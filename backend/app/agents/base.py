"""Agent contract and tool permissions (architecture.md §3). Permissions are enforced in code, not by prompts."""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel


class ToolNotPermitted(PermissionError):
    pass


class ToolRegistry:
    def __init__(self, agent_key: str, granted: frozenset[str]) -> None:
        self.agent_key = agent_key
        self.granted = granted

    def require(self, tool: str) -> None:
        if tool not in self.granted:
            raise ToolNotPermitted(f"Agent '{self.agent_key}' is not permitted to use tool '{tool}'")

    def allows(self, tool: str) -> bool:
        return tool in self.granted


class ValidationIssue(BaseModel):
    severity: str
    code: str
    message: str
    path: str | None = None


class Agent(Protocol):
    key: str
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    tools: ToolRegistry

    async def run(self) -> Any: ...
