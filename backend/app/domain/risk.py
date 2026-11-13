"""Risk scoring (P2-06). Score and level are computed in code only: score = likelihood × impact."""

from __future__ import annotations

from app.domain.enums import RiskLevel

# Test types that always need a separate approval before any test runs (spec §19).
APPROVAL_TEST_TYPES = frozenset({"security", "performance", "load", "stress", "spike", "endurance"})


def risk_score(likelihood: int, impact: int) -> int:
    if not (1 <= likelihood <= 5 and 1 <= impact <= 5):
        raise ValueError("Likelihood and impact must be between 1 and 5")
    return likelihood * impact


def risk_level(score: int) -> RiskLevel:
    """1–4 low, 5–9 medium, 10–16 high, 20–25 very high (design P2 §2)."""
    if score >= 20:
        return RiskLevel.very_high
    if score >= 10:
        return RiskLevel.high
    if score >= 5:
        return RiskLevel.medium
    return RiskLevel.low


def requires_approval(test_types: list[str]) -> bool:
    return any(t in APPROVAL_TEST_TYPES for t in test_types)
