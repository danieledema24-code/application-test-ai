"""LineageCarryForward (P2-00): matches regenerated candidates to the current version by `match_key` and returns
the change review entries with their default actions. Pure: nothing is applied here.

Defaults (design P2 §5.7): added -> accept; changed (unprotected) -> accept; protected (locked, human-edited,
approved, manually created) -> keep, with the generator's version as a proposal; no longer found -> draft is
marked rejected, anything else is kept. A lineage the user rejected is never proposed again.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

Change = Literal["added", "changed", "protected_with_proposal", "no_longer_found", "suppressed_rejected", "unchanged"]
Action = Literal["accept", "keep", "skip", "mark_rejected"]
ProtectedReason = Literal["locked", "human_edited", "approved", "user_created"]

REJECTED = "rejected"
APPROVED = "approved"


@dataclass(frozen=True)
class CurrentItem:
    lineage_id: uuid.UUID
    key: str
    match_key: str
    content: dict[str, Any]
    status: str = "draft"
    locked: bool = False
    human_edited: bool = False
    user_created: bool = False

    @property
    def protected_reason(self) -> ProtectedReason | None:
        if self.locked:
            return "locked"
        if self.human_edited:
            return "human_edited"
        if self.user_created:
            return "user_created"
        if self.status == APPROVED:
            return "approved"
        return None


@dataclass(frozen=True)
class Candidate:
    match_key: str
    content: dict[str, Any]


@dataclass
class ReviewEntry:
    change: Change
    match_key: str
    lineage_id: uuid.UUID | None
    key: str | None
    current: dict[str, Any] | None
    proposed: dict[str, Any] | None
    default_action: Action | None
    allowed_actions: list[Action]
    protected_reason: ProtectedReason | None = None
    field_diff: list[dict[str, Any]] = field(default_factory=list)
    candidate_index: int | None = None  # position in the candidates list (None when no candidate)


@dataclass
class CarryForwardResult:
    entries: list[ReviewEntry]

    def by_change(self, change: Change) -> list[ReviewEntry]:
        return [e for e in self.entries if e.change == change]

    @property
    def summary(self) -> dict[str, int]:
        keys: tuple[Change, ...] = (
            "added",
            "changed",
            "protected_with_proposal",
            "no_longer_found",
            "unchanged",
            "suppressed_rejected",
        )
        return {k: len(self.by_change(k)) for k in keys}


def field_diff(current: dict[str, Any] | None, proposed: dict[str, Any] | None) -> list[dict[str, Any]]:
    cur, new = current or {}, proposed or {}
    return [
        {"field": k, "from": cur.get(k), "to": new.get(k)}
        for k in sorted(set(cur) | set(new))
        if cur.get(k) != new.get(k)
    ]


def carry_forward(
    current: Sequence[CurrentItem],
    candidates: Sequence[Candidate],
    *,
    rejected_lineages: Iterable[uuid.UUID] = (),
    rejected_match_keys: Iterable[str] = (),
) -> CarryForwardResult:
    rejected_l = set(rejected_lineages)
    rejected_k = set(rejected_match_keys)
    by_key: dict[str, CurrentItem] = {}
    for item in current:
        by_key.setdefault(item.match_key, item)
    entries: list[ReviewEntry] = []
    matched: set[uuid.UUID] = set()
    seen_candidates: set[str] = set()
    for idx, cand in enumerate(candidates):
        if cand.match_key in seen_candidates:
            continue  # duplicates are dropped by the generator's dedupe; first wins
        seen_candidates.add(cand.match_key)
        cur = by_key.get(cand.match_key)
        if cur is not None:
            matched.add(cur.lineage_id)
        rejected = (
            cur is not None and (cur.status == REJECTED or cur.lineage_id in rejected_l)
        ) or cand.match_key in rejected_k
        if rejected:
            entries.append(
                ReviewEntry(
                    "suppressed_rejected",
                    cand.match_key,
                    cur.lineage_id if cur else None,
                    cur.key if cur else None,
                    cur.content if cur else None,
                    cand.content,
                    None,
                    [],
                    candidate_index=idx,
                )
            )
            continue
        if cur is None:
            entries.append(
                ReviewEntry(
                    "added", cand.match_key, None, None, None, cand.content, "accept", ["accept", "skip"], None,
                    field_diff(None, cand.content), idx,
                )
            )  # fmt: skip
            continue
        diff = field_diff(cur.content, cand.content)
        if not diff:
            entries.append(
                ReviewEntry(
                    "unchanged", cand.match_key, cur.lineage_id, cur.key, cur.content, cand.content, "keep", ["keep"],
                    cur.protected_reason, [], idx,
                )
            )  # fmt: skip
        elif cur.protected_reason is not None:
            entries.append(
                ReviewEntry(
                    "protected_with_proposal", cand.match_key, cur.lineage_id, cur.key, cur.content, cand.content,
                    "keep", ["accept", "keep"], cur.protected_reason, diff, idx,
                )
            )  # fmt: skip
        else:
            entries.append(
                ReviewEntry(
                    "changed", cand.match_key, cur.lineage_id, cur.key, cur.content, cand.content, "accept",
                    ["accept", "keep"], None, diff, idx,
                )
            )  # fmt: skip
    for cur in current:
        if cur.lineage_id in matched:
            continue
        if cur.status == REJECTED or cur.user_created:
            # Rejected items and people's own items are carried as they are; generators never re-derive them.
            entries.append(
                ReviewEntry(
                    "unchanged", cur.match_key, cur.lineage_id, cur.key, cur.content, cur.content, "keep", ["keep"],
                    cur.protected_reason,
                )
            )  # fmt: skip
            continue
        unprotected_draft = cur.protected_reason is None and cur.status != APPROVED
        entries.append(
            ReviewEntry(
                "no_longer_found",
                cur.match_key,
                cur.lineage_id,
                cur.key,
                cur.content,
                None,
                "mark_rejected" if unprotected_draft else "keep",
                ["mark_rejected", "keep"],
                cur.protected_reason,
            )
        )
    return CarryForwardResult(entries)


def resolve_action(entry: ReviewEntry, decisions: dict[str, str]) -> Action | None:
    """The user's choice for an entry (decisions keyed by lineage id string) if allowed, else its default."""
    if entry.lineage_id is not None:
        raw = decisions.get(str(entry.lineage_id))
        for allowed in entry.allowed_actions:
            if raw == allowed:
                return allowed
    return entry.default_action
