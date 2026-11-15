"""Risk-based prioritisation (P3-05): a case's priority follows the highest risk linked to what it tests."""

from __future__ import annotations

from dataclasses import dataclass

RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
LEVEL_RANK = {"low": 0, "medium": 1, "high": 2, "very_high": 3}
LEVEL_TO_PRIORITY = {"very_high": "critical", "high": "high", "medium": "medium", "low": "low"}


@dataclass(frozen=True)
class RiskFact:
    lineage_id: str
    key: str
    level: str
    score: int
    status: str  # open / mitigated / accepted (all count; accepted ones are labelled)
    requirement_lineage_ids: frozenset[str]
    feature_ids: frozenset[str]


def derived_priority(risk_level: str | None) -> str:
    return LEVEL_TO_PRIORITY.get(risk_level or "", "low")


def effective(derived: str, override: str | None) -> str:
    return override or derived


def top_risk(risks: list[RiskFact], requirement_lineages: set[str], feature_ids: set[str]) -> RiskFact | None:
    """The highest-scoring risk linked to any of the requirements or features (ties: higher level, then key)."""
    linked = [r for r in risks if r.requirement_lineage_ids & requirement_lineages or r.feature_ids & feature_ids]
    if not linked:
        return None
    return max(linked, key=lambda r: (r.score, LEVEL_RANK.get(r.level, 0), r.key))


def below_risk(override: str | None, derived: str, risk_level: str | None) -> bool:
    """An override below the risk-derived priority of a high/very-high risk case (lint `priority_below_risk`)."""
    if override is None or risk_level not in ("high", "very_high"):
        return False
    return RANK[override] < RANK[derived]


def sort_key(priority: str, risk_score: int | None, key: str) -> tuple[int, int, str]:
    """Effective priority first (critical..low), then risk score, then key."""
    return (-RANK.get(priority, 0), -(risk_score or 0), key)
