"""Phase 2 provenance rules (roadmap "Phase 2 rules every story inherits", spec §6). Pure functions, code-owned.

1. `observed` needs at least one resolvable evidence ref, else it is downgraded to `unverified`.
2. Backend or mixed behaviour can never be `observed`: capped at `inferred` with evidence, else `assumed`. A keyword
   guard on the title and Then clauses forces `behaviour_scope` to at least `mixed`.
3. Confidence is clamped per classification.
4. Acceptance criteria never claim more than their requirement, and are `observed` only when exercised.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.domain.enums import BehaviourScope, Provenance

CONFIDENCE_CAP: dict[Provenance, float] = {
    Provenance.observed: 1.0,
    Provenance.inferred: 0.8,
    Provenance.assumed: 0.5,
    Provenance.unverified: 0.3,
}
STRENGTH: dict[Provenance, int] = {
    Provenance.observed: 3,
    Provenance.inferred: 2,
    Provenance.assumed: 1,
    Provenance.unverified: 0,
}

# Word-boundary guard: these describe behaviour that happens behind the UI. Field names such as "Email" alone do
# not match ("Email is mandatory" stays ui); "is sent", "emails the" and "confirmation email" do.
_BACKEND_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bsaved\b",
        r"\bstored\b",
        r"\bis sent\b",
        r"\bare sent\b",
        r"\bsends\b",
        r"\bemails the\b",
        r"\bconfirmation email\b",
        r"\bdatabase\b",
        r"\bserver\b",
        r"\bpersist\w*",
        r"\bprocessed\b",
        r"\bnotif\w*",
        r"\bintegrat\w*",
        r"\bauthoris\w*",
        r"\bauthoriz\w*",
    )
)


def backend_keywords(*texts: str) -> list[str]:
    """Backend-behaviour keywords found in the texts (empty when none)."""
    found: list[str] = []
    for t in texts:
        for pat in _BACKEND_PATTERNS:
            m = pat.search(t or "")
            if m and m.group(0).lower() not in found:
                found.append(m.group(0).lower())
    return found


def guard_scope(scope: BehaviourScope, *texts: str) -> BehaviourScope:
    """Forces `ui` to `mixed` when the title or Then clauses describe backend behaviour."""
    if scope == BehaviourScope.ui and backend_keywords(*texts):
        return BehaviourScope.mixed
    return scope


def clamp_confidence(classification: Provenance, confidence: float) -> float:
    return round(max(0.0, min(float(confidence), CONFIDENCE_CAP[classification])), 2)


@dataclass
class ProvenanceDecision:
    classification: Provenance
    behaviour_scope: BehaviourScope
    confidence: float
    issues: list[dict[str, str]] = field(default_factory=list)


def apply_rules(
    classification: Provenance,
    scope: BehaviourScope,
    confidence: float,
    *,
    has_evidence: bool,
    texts: tuple[str, ...] = (),
    item_key: str | None = None,
) -> ProvenanceDecision:
    """Applies rules 1–3 to a requirement-like item. Never upgrades a label."""
    issues: list[dict[str, str]] = []
    new_scope = guard_scope(scope, *texts)
    if new_scope != scope:
        issues.append(
            _issue(
                "info",
                "behaviour_scope_raised",
                f"Describes behaviour behind the user interface ({', '.join(backend_keywords(*texts))}); "
                "scope set to mixed.",
                item_key,
            )
        )
    cls = classification
    if new_scope != BehaviourScope.ui:
        if cls == Provenance.observed:
            cls = Provenance.inferred if has_evidence else Provenance.assumed
            issues.append(
                _issue(
                    "warning",
                    "provenance_downgraded",
                    f"Backend behaviour can't be observed in the browser; label set to {cls.value}.",
                    item_key,
                )
            )
        elif cls == Provenance.inferred and not has_evidence:
            cls = Provenance.assumed
            issues.append(
                _issue("warning", "provenance_downgraded", "Inferred without evidence; label set to assumed.", item_key)
            )
    elif cls == Provenance.observed and not has_evidence:
        cls = Provenance.unverified
        issues.append(
            _issue(
                "warning",
                "provenance_downgraded",
                "Observed needs evidence from this project; label set to unverified.",
                item_key,
            )
        )
    return ProvenanceDecision(cls, new_scope, clamp_confidence(cls, confidence), issues)


def cap_to(classification: Provenance, ceiling: Provenance) -> Provenance:
    """The weaker of the two labels."""
    return classification if STRENGTH[classification] <= STRENGTH[ceiling] else ceiling


def ac_classification(
    classification: Provenance,
    *,
    requirement: Provenance,
    exercised: bool,
    has_evidence: bool,
    then_text: str,
) -> Provenance:
    """Rule 4: an AC is observed only when exercised during discovery, never stronger than its requirement, and
    capped at inferred when its Then describes backend behaviour."""
    cls = classification
    if cls == Provenance.observed and (not exercised or not has_evidence):
        cls = Provenance.inferred if has_evidence else Provenance.unverified
    if backend_keywords(then_text) and STRENGTH[cls] > STRENGTH[Provenance.inferred]:
        cls = Provenance.inferred
    if cls == Provenance.inferred and not has_evidence:
        cls = Provenance.assumed
    return cap_to(cls, requirement)


def _issue(severity: str, code: str, message: str, item_key: str | None) -> dict[str, str]:
    out = {"severity": severity, "code": code, "message": message}
    if item_key:
        out["item_key"] = item_key
    return out
