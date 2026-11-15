"""Exploration budget (decision D30): the organisation ceiling on one exploratory session.

`organisations.settings.exploration_ceiling {actions, minutes}` (owner/admin, default 60 actions / 10 minutes). A
session's budget must fit it (P6-03a). Migration 0019 gives every existing organisation the default.
"""

from __future__ import annotations

DEFAULT_EXPLORATION_CEILING: dict[str, int] = {"actions": 60, "minutes": 10}


def default_exploration_ceiling() -> dict[str, int]:
    return dict(DEFAULT_EXPLORATION_CEILING)
