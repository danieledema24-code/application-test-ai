"""P5-00 (decision D18): load limits. The hard cap can't be set above the compiled maximum, an organisation ceiling
can't exceed the hard cap, and a profile is checked against the effective ceiling with messages naming the limit."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.domain.enums import StageKey
from app.domain.performance.limits import (
    COMPILED_MAX,
    DEFAULT_CEILING,
    DEFAULT_HARD_CAP,
    LoadLimits,
    ceiling_violations,
    default_org_settings,
    duration_text,
    effective_ceiling,
    profile_violations,
)
from app.domain.stages import CURRENT_PHASE, OPTIONAL_STAGES, RUN_DRIVEN_STAGES, RUNNABLE_IN_PHASE, STAGE_BY_KEY
from app.services.counters import format_key
from tests.conftest import make_settings


def test_d18_defaults() -> None:
    assert LoadLimits(vus=20, rps=20, duration_s=300) == DEFAULT_CEILING
    assert LoadLimits(vus=50, rps=50, duration_s=600) == DEFAULT_HARD_CAP
    assert LoadLimits(vus=200, rps=200, duration_s=1800) == COMPILED_MAX
    # P6-00 adds the D30 exploration ceiling next to the load ceiling.
    assert default_org_settings() == {
        "load_ceiling": {"vus": 20, "rps": 20, "duration_s": 300},
        "exploration_ceiling": {"actions": 60, "minutes": 10},
    }


def test_hard_cap_is_refused_above_the_compiled_maximum(tmp_path: Path) -> None:
    assert make_settings(tmp_path).load_hard_cap == DEFAULT_HARD_CAP
    assert make_settings(tmp_path, load_hard_cap_vus=200).load_hard_cap.vus == 200
    for field, value in (("load_hard_cap_vus", 201), ("load_hard_cap_rps", 500), ("load_hard_cap_duration_s", 1801)):
        with pytest.raises(ValidationError, match=r"must be 1–\d+ \(got"):
            make_settings(tmp_path, **{field: value})
    with pytest.raises(ValidationError):
        make_settings(tmp_path, load_hard_cap_vus=0)


def test_ceiling_and_profile_checks_name_the_exceeded_limit() -> None:
    cap = DEFAULT_HARD_CAP
    assert ceiling_violations(LoadLimits(500, 20, 300), cap)[0].message == "The platform allows up to 50 virtual users"
    assert ceiling_violations(DEFAULT_CEILING, cap) == []
    v = profile_violations(vus=30, rps=20, duration_s=130, targets=6, ceiling=DEFAULT_CEILING, cap=cap)
    assert [(x.field, x.message) for x in v] == [("vus", "Your organisation allows up to 20 virtual users")]
    v = profile_violations(vus=10, rps=25, duration_s=400, targets=11, ceiling=DEFAULT_CEILING, cap=cap)
    assert [x.field for x in v] == ["rps", "duration_s", "targets"]
    assert v[0].message == "Your organisation allows up to 20 requests a second"
    assert v[1].message == "Your organisation allows up to 5 minutes of load (asked for 6 minutes 40 seconds)"
    assert v[2].message == "A load test can target up to 10 pages"
    # A ceiling stored above a since-lowered hard cap is clipped, and the message names the platform.
    high = LoadLimits(100, 100, 1200)
    assert effective_ceiling(high, cap) == cap
    v = profile_violations(vus=60, rps=10, duration_s=60, targets=1, ceiling=high, cap=cap)
    assert v[0].message == "The platform allows up to 50 virtual users"
    assert profile_violations(vus=10, rps=20, duration_s=130, targets=6, ceiling=DEFAULT_CEILING, cap=cap) == []
    assert duration_text(130) == "2 minutes 10 seconds" and duration_text(60) == "1 minute"
    assert duration_text(45) == "45 seconds"
    assert LoadLimits.from_dict({"vus": 5, "rps": "x", "duration_s": True}, DEFAULT_CEILING) == LoadLimits(5, 20, 300)


def test_phase5_stage_registry() -> None:
    assert CURRENT_PHASE >= 5  # Phase 6 (P6-00) keeps every Phase 5 rule below
    for key in (StageKey.accessibility, StageKey.security_assessment):
        d = STAGE_BY_KEY[key]
        assert d.phase == 5 and d.gate is None and d.upstream == (StageKey.discovery,) and d.available
        # P5-02/P5-03: checks start from Non-functional (their own endpoints), never as a stage task.
        assert key not in RUNNABLE_IN_PHASE and key in OPTIONAL_STAGES and key in RUN_DRIVEN_STAGES
    assert STAGE_BY_KEY[StageKey.performance].upstream == (StageKey.test_strategy,)
    assert RUN_DRIVEN_STAGES[StageKey.performance] == "Start a performance run from Performance"
    assert StageKey.performance not in RUNNABLE_IN_PHASE
    assert [format_key(k, 1) for k in ("a11y_scan", "security_scan", "perf_profile", "perf_run")] == [
        "A11Y-0001",
        "SEC-0001",
        "PRF-01",
        "PERF-0001",
    ]
