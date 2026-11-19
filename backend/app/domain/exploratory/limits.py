"""Exploration budget (decision D30): the platform cap, the organisation ceiling and one session's budget.

`organisations.settings.exploration_ceiling {actions, minutes}` (owner/admin, default 60 actions / 10 minutes) must stay
within the platform cap (`EXPLORE_MAX_ACTIONS` / `EXPLORE_MAX_MINUTES`, default and compiled maximum 200 / 20; startup
is refused above it). A session's budget must fit the effective ceiling (the smaller of the two): it is checked when
the session is requested and again when it starts, and enforced by the worker (`BudgetMeter`). Migration 0019 gave
every existing organisation the default ceiling. Pure: unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DEFAULT_EXPLORATION_CEILING: dict[str, int] = {"actions": 60, "minutes": 10}
EXPLORE_STATEMENT = (
    "This session tried {n} actions on {m} pages within its budget. Exploration is a sample, not a complete test, "
    "and it never submits forms or sends data."
)
SHORT_STATEMENT = "Exploration is a sample, not a complete test."
NOUNS = {"actions": ("action", "actions"), "minutes": ("minute", "minutes")}


def default_exploration_ceiling() -> dict[str, int]:
    return dict(DEFAULT_EXPLORATION_CEILING)


@dataclass(frozen=True)
class Budget:
    actions: int
    minutes: int

    @classmethod
    def from_dict(cls, raw: Any, default: Budget) -> Budget:
        """A stored budget or ceiling; missing or malformed values fall back to the default's."""
        raw = raw if isinstance(raw, dict) else {}
        out = {}
        for f in ("actions", "minutes"):
            v = raw.get(f)
            out[f] = v if whole(v) else getattr(default, f)
        return cls(**out)

    def as_dict(self) -> dict[str, int]:
        return {"actions": self.actions, "minutes": self.minutes}


COMPILED_MAX = Budget(actions=200, minutes=20)
DEFAULT_CEILING = Budget(**DEFAULT_EXPLORATION_CEILING)


def whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _noun(field: str, n: int) -> str:
    one, many = NOUNS[field]
    return one if n == 1 else many


def cap_violations(cap: Budget) -> list[str]:
    """The platform cap itself: 1 … the compiled maximum (checked at startup)."""
    out = []
    for f, env in (("actions", "EXPLORE_MAX_ACTIONS"), ("minutes", "EXPLORE_MAX_MINUTES")):
        v, top = getattr(cap, f), getattr(COMPILED_MAX, f)
        if v < 1 or v > top:
            out.append(f"{env} must be between 1 and {top}")
    return out


def effective_ceiling(ceiling: Budget, cap: Budget) -> Budget:
    return Budget(actions=min(ceiling.actions, cap.actions), minutes=min(ceiling.minutes, cap.minutes))


@dataclass(frozen=True)
class Violation:
    field: str
    message: str


def budget_violations(raw: dict[str, Any], ceiling: Budget, cap: Budget) -> list[Violation]:
    """A requested budget against the effective ceiling (design §9.2 wording; the 422 names the exceeded limit)."""
    out = []
    for f in ("actions", "minutes"):
        v = raw.get(f)
        if not whole(v):
            out.append(Violation(f, f"Enter a whole number of {NOUNS[f][1]} (1 or more)."))
            continue
        org, server = getattr(ceiling, f), getattr(cap, f)
        if v > min(org, server):
            limit = min(org, server)
            who = "This server" if server < org else "Your organisation"
            out.append(Violation(f, f"{who} allows up to {limit} {_noun(f, limit)}."))
    return out


def ceiling_violations(raw: dict[str, Any], cap: Budget) -> list[Violation]:
    """An organisation ceiling an owner/admin wants to save (design §9.9)."""
    out = []
    for f in ("actions", "minutes"):
        v = raw.get(f)
        if not whole(v):
            out.append(Violation(f, f"Enter a whole number of {NOUNS[f][1]} (1 or more)."))
        elif v > getattr(cap, f):
            top = getattr(cap, f)
            out.append(Violation(f, f"This server allows up to {top} {_noun(f, top)}."))
    return out


def statement(actions: int, pages: int) -> str:
    return EXPLORE_STATEMENT.format(n=actions, m=pages)


# ------------------------------------------------------------------ enforcement (the worker)

BUDGET_USED = "budget"  # every action of the budget was taken
TIME_USED = "time"  # the minutes ran out
EXHAUSTED = "exhausted"  # every allowed action was tried before the budget ran out
UNREACHED = (
    "unreached"  # budget and time remain, but some allowed actions couldn't be reached (listed as Never reached)
)


@dataclass
class BudgetMeter:
    """Counts actions against the budget and time against the minutes (monotonic seconds from the caller)."""

    budget: Budget
    started: float
    used: int = 0

    def remaining(self) -> int:
        return max(self.budget.actions - self.used, 0)

    def deadline(self) -> float:
        return self.started + self.budget.minutes * 60

    def spent(self, now: float) -> str | None:
        """Why no further action may start (None while budget and time remain)."""
        if self.used >= self.budget.actions:
            return BUDGET_USED
        if now >= self.deadline():
            return TIME_USED
        return None

    def take(self) -> int:
        """Counts one action and returns its step number. Never beyond the budget."""
        if self.used >= self.budget.actions:
            raise RuntimeError("The action budget is used up")
        self.used += 1
        return self.used


def end_line(reason: str | None, used: int, budget: Budget, *, unreached: int = 0) -> str:
    """The results line under the status (design §9.6)."""
    if reason == UNREACHED:
        what = f"{unreached} allowed action{'s' if unreached != 1 else ''}" if unreached else "Some allowed actions"
        return f"{used} of {budget.actions} actions used. {what} couldn't be reached: see Never reached."
    if reason == BUDGET_USED:
        return f"Budget used: {used} of {budget.actions} actions"
    if reason == TIME_USED:
        return f"Time used: {budget.minutes} of {budget.minutes} minutes ({used} of {budget.actions} actions)"
    if reason == EXHAUSTED:
        return f"Every allowed action was tried ({used} of {budget.actions} actions used)"
    return f"{used} of {budget.actions} actions"
