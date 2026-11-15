"""Load limits (decision D18), checked in code at every layer that can start load.

Three nested limits, each a number of virtual users, requests a second and seconds of load:
- the **compiled maximum** (this module): the hard cap may never be set above it, whatever the environment says;
- the **platform hard cap** (`LOAD_HARD_CAP_VUS/RPS/DURATION_S`, default 50 / 50 / 10 min);
- the **organisation ceiling** (`organisations.settings.load_ceiling`, owner/admin, default 20 / 20 / 5 min,
  never above the hard cap).

A profile must fit the ceiling, and the ceiling must fit the hard cap. P5-01b checks a profile when it is saved,
when a run is requested and when its `load_test` approval is decided; the load generator (P5-01a) refuses a
configuration over the `--max-*` limits the adapter passes from the hard cap, and has the same compiled maximum.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LoadLimits:
    vus: int
    rps: int
    duration_s: int

    def as_dict(self) -> dict[str, int]:
        return {"vus": self.vus, "rps": self.rps, "duration_s": self.duration_s}

    @classmethod
    def from_dict(cls, raw: Any, fallback: LoadLimits) -> LoadLimits:
        """Reads a stored `{vus, rps, duration_s}`; missing or malformed values take the fallback's."""
        data = raw if isinstance(raw, dict) else {}

        def pick(name: str, default: int) -> int:
            value = data.get(name)
            return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else default

        return cls(
            vus=pick("vus", fallback.vus),
            rps=pick("rps", fallback.rps),
            duration_s=pick("duration_s", fallback.duration_s),
        )


COMPILED_MAX = LoadLimits(vus=200, rps=200, duration_s=30 * 60)
DEFAULT_HARD_CAP = LoadLimits(vus=50, rps=50, duration_s=10 * 60)
DEFAULT_CEILING = LoadLimits(vus=20, rps=20, duration_s=5 * 60)
# At most this many target URLs per profile (GET only, same origin, never signed in).
MAX_TARGETS = 10


def default_org_settings() -> dict[str, Any]:
    """`organisations.settings` for a new organisation (the migration's server default is the same value): the D18
    load ceiling and, from Phase 6 (P6-00), the D30 exploration ceiling."""
    from app.domain.exploratory.limits import default_exploration_ceiling

    return {"load_ceiling": DEFAULT_CEILING.as_dict(), "exploration_ceiling": default_exploration_ceiling()}


def duration_text(seconds: int) -> str:
    """`130` -> "2 minutes 10 seconds", `300` -> "5 minutes", `45` -> "45 seconds"."""
    minutes, secs = divmod(int(seconds), 60)
    parts = []
    if minutes:
        parts.append(f"{minutes} minute{'s' if minutes != 1 else ''}")
    if secs or not minutes:
        parts.append(f"{secs} second{'s' if secs != 1 else ''}")
    return " ".join(parts)


@dataclass(frozen=True)
class Violation:
    field: str  # vus | rps | duration_s | targets
    message: str


_NOUNS = {"vus": "virtual users", "rps": "requests a second"}


def _over(field: str, value: int, limit: int, who: str) -> Violation:
    if field == "duration_s":
        return Violation(field, f"{who} allows up to {duration_text(limit)} of load (asked for {duration_text(value)})")
    return Violation(field, f"{who} allows up to {limit} {_NOUNS[field]}")


def cap_violations(cap: LoadLimits) -> list[Violation]:
    """The hard cap against the compiled maximum (refused at startup when set above it)."""
    out = []
    for field in ("vus", "rps", "duration_s"):
        value, limit = getattr(cap, field), getattr(COMPILED_MAX, field)
        if value < 1 or value > limit:
            out.append(Violation(field, f"The load hard cap for {field} must be 1–{limit} (got {value})"))
    return out


def ceiling_violations(ceiling: LoadLimits, cap: LoadLimits) -> list[Violation]:
    """An organisation ceiling an owner or admin wants to save, against the platform hard cap."""
    out = []
    for field in ("vus", "rps", "duration_s"):
        value, limit = getattr(ceiling, field), getattr(cap, field)
        if value < 1:
            out.append(Violation(field, "Enter a number above 0"))
        elif value > limit:
            out.append(_over(field, value, limit, "The platform"))
    return out


def effective_ceiling(ceiling: LoadLimits, cap: LoadLimits) -> LoadLimits:
    """The ceiling actually applied: a stored ceiling above a since-lowered hard cap is clipped to the cap."""
    return LoadLimits(
        vus=min(ceiling.vus, cap.vus), rps=min(ceiling.rps, cap.rps), duration_s=min(ceiling.duration_s, cap.duration_s)
    )


def profile_violations(
    *, vus: int, rps: int, duration_s: int, targets: int, ceiling: LoadLimits, cap: LoadLimits
) -> list[Violation]:
    """A profile (peak users, max requests a second, total duration, number of targets) against the effective
    organisation ceiling. Empty when it may run."""
    limit = effective_ceiling(ceiling, cap)
    out = []
    for field, value in (("vus", vus), ("rps", rps), ("duration_s", duration_s)):
        if value < 1:
            out.append(Violation(field, "Enter a number above 0"))
        elif value > getattr(limit, field):
            who = "Your organisation" if getattr(limit, field) == getattr(ceiling, field) else "The platform"
            out.append(_over(field, value, getattr(limit, field), who))
    if targets < 1:
        out.append(Violation("targets", "Add at least one page to load"))
    elif targets > MAX_TARGETS:
        out.append(Violation("targets", f"A load test can target up to {MAX_TARGETS} pages"))
    return out
