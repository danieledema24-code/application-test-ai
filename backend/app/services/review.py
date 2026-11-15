"""Candidate-run review (P2-00), generic over regenerable row artefacts.

A regeneration writes a complete *candidate* version under its own stage run: carried copies of current rows,
generator content for unprotected changes, the generator's proposal (`suggested_change`) on protected rows, and new
rows for additions. Nothing changes for users until `apply_rows` runs with their decisions; `discard` leaves the
candidate in history. Review entries are stored on the run (`output.review.items`).
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.types import utcnow
from app.domain.lineage import Candidate, CurrentItem, ReviewEntry, carry_forward, resolve_action
from app.services import revisions
from app.services.revisions import jsonable

_SKIP_CLONE = {"id", "stage_run_id", "created_at", "updated_at", "carried_from_id", "suggested_change"}


@dataclass(frozen=True)
class RowAdapter:
    entity_type: str  # ChangeReviewItem.type / entity_revisions.entity_type
    model: type[Any]
    compare: tuple[tuple[str, str], ...]  # (content name, attribute)
    status_attr: str | None = "status"
    rejected_value: str | None = "rejected"
    approved_value: str | None = "approved"
    user_source_attr: str | None = None  # attribute whose value "user" marks a manually created row

    def content(self, row: Any) -> dict[str, Any]:
        return {name: jsonable(getattr(row, attr)) for name, attr in self.compare}

    def apply_content(self, row: Any, content: dict[str, Any]) -> None:
        for name, attr in self.compare:
            if name in content:
                setattr(row, attr, _coerce(row, attr, content[name]))

    def is_user_created(self, row: Any) -> bool:
        # Rows made through the API (by a person, or by accepting an assistant proposal) get a "user:" match key;
        # a regenerated design never matches them, so they are kept rather than rejected as no longer found.
        if str(getattr(row, "match_key", "") or "").startswith("user:"):
            return True
        if self.user_source_attr is None:
            return str(jsonable(getattr(row, "generated_by", ""))) == "human"
        return str(jsonable(getattr(row, self.user_source_attr, ""))) == "user"

    def current_item(self, row: Any) -> CurrentItem:
        return CurrentItem(
            lineage_id=row.lineage_id,
            key=row.key,
            match_key=row.match_key,
            content=self.content(row),
            status=str(jsonable(getattr(row, self.status_attr))) if self.status_attr else "draft",
            locked=bool(row.locked),
            human_edited=bool(row.human_edited),
            user_created=self.is_user_created(row),
        )


def _coerce(row: Any, attr: str, value: Any) -> Any:
    """Converts a JSON content value back to the column's Python type (enums)."""
    col = inspect(type(row)).columns.get(attr)
    enum_cls = getattr(getattr(col, "type", None), "enum_class", None) if col is not None else None
    if enum_cls is not None and value is not None:
        return enum_cls(value)
    return value


def clone(row: Any, **overrides: Any) -> Any:
    """A copy of `row` for another stage run (new id), carrying its lineage and key."""
    mapper = inspect(type(row))
    data = {c.key: getattr(row, c.key) for c in mapper.column_attrs if c.key not in _SKIP_CLONE}
    data["carried_from_id"] = row.id
    data.update(overrides)
    return type(row)(**data)


def sync_from(target: Any, source: Any) -> None:
    """Copies every mutable column of the current row onto its candidate copy (keeps post-generation edits)."""
    mapper = inspect(type(source))
    for c in mapper.column_attrs:
        if c.key in _SKIP_CLONE or c.key in ("requirement_id", "strategy_id", "organisation_id", "project_id"):
            continue
        setattr(target, c.key, getattr(source, c.key))


@dataclass
class StagedRow:
    entry: ReviewEntry
    row: Any | None  # the candidate-run row (None for suppressed entries without a current row)
    current: Any | None
    candidate: Any | None  # the generator's unsaved row, when there is one


async def stage_candidates(
    session: AsyncSession,
    adapter: RowAdapter,
    *,
    run_id: uuid.UUID,
    current_rows: Sequence[Any],
    candidate_rows: Sequence[Any],
    rejected_lineages: set[uuid.UUID],
    rejected_match_keys: set[str],
    new_key: Callable[[Any], Awaitable[str]],
    overrides: dict[str, Any] | None = None,
    refresh_attrs: tuple[str, ...] = ("evidence_refs",),
) -> list[StagedRow]:
    """Writes the candidate version of one artefact list and returns what happened to each item.

    `candidate_rows` are unsaved model instances produced by the generator (match_key and content set).
    `refresh_attrs` are taken from the generator for unprotected carried items (fresh evidence from the new scan).
    """
    extra = overrides or {}
    by_lineage = {r.lineage_id: r for r in current_rows}
    result = carry_forward(
        [adapter.current_item(r) for r in current_rows],
        [Candidate(c.match_key, adapter.content(c)) for c in candidate_rows],
        rejected_lineages=rejected_lineages,
        rejected_match_keys=rejected_match_keys,
    )
    staged: list[StagedRow] = []
    for e in result.entries:
        cand = candidate_rows[e.candidate_index] if e.candidate_index is not None else None
        cur = by_lineage.get(e.lineage_id) if e.lineage_id else None
        row: Any | None = None
        if e.change == "added" and cand is not None:
            row = cand
            row.stage_run_id = run_id
            row.lineage_id = uuid.uuid4()
            row.key = await new_key(row)
            row.version = 1
            for k, v in extra.items():
                setattr(row, k, v)
            e.lineage_id, e.key = row.lineage_id, row.key
        elif e.change == "changed" and cand is not None and cur is not None:
            row = cand
            row.stage_run_id = run_id
            row.lineage_id, row.key, row.version, row.carried_from_id = cur.lineage_id, cur.key, cur.version, cur.id
            row.locked, row.human_edited = cur.locked, cur.human_edited
            if adapter.status_attr:
                setattr(row, adapter.status_attr, getattr(cur, adapter.status_attr))
            for k, v in extra.items():
                setattr(row, k, v)
        elif cur is not None:
            row = clone(cur, stage_run_id=run_id, **extra)
            if e.change == "protected_with_proposal" and cand is not None:
                row.suggested_change = {
                    **adapter.content(cand),
                    **{a: jsonable(getattr(cand, a)) for a in refresh_attrs},
                }
            elif e.change == "unchanged" and cand is not None and e.protected_reason is None:
                for a in refresh_attrs:
                    setattr(row, a, getattr(cand, a))
        if row is not None:
            session.add(row)
        staged.append(StagedRow(e, row, cur, cand))
    await session.flush()
    return staged


def review_items(
    adapter: RowAdapter,
    staged: Sequence[StagedRow],
    *,
    parent_lineage: uuid.UUID | None = None,
    note: str | None = None,
) -> list[dict[str, Any]]:
    """Serialisable review entries (stored on the candidate run)."""
    out: list[dict[str, Any]] = []
    for s in staged:
        e = s.entry
        if e.change == "suppressed_rejected":
            out.append({"type": adapter.entity_type, "change": e.change, "key": e.key, "match_key": e.match_key})
            continue
        out.append(
            {
                "type": adapter.entity_type,
                "change": e.change,
                "lineage_id": str(e.lineage_id) if e.lineage_id else None,
                "key": e.key,
                "match_key": e.match_key,
                "protected_reason": e.protected_reason,
                "current": e.current,
                "proposed": e.proposed,
                "field_diff": jsonable(e.field_diff),
                "default_action": e.default_action,
                "allowed_actions": list(e.allowed_actions),
                "note": note if e.change == "no_longer_found" else None,
                "current_row_id": str(s.current.id) if s.current is not None else None,
                "current_version": s.current.version if s.current is not None else None,
                "candidate_row_id": str(s.row.id) if s.row is not None else None,
                "parent_lineage_id": str(parent_lineage) if parent_lineage else None,
            }
        )
    return out


def summarise(items: Sequence[dict[str, Any]], type_: str) -> dict[str, int]:
    keys = ("added", "changed", "protected_with_proposal", "no_longer_found", "unchanged", "suppressed_rejected")
    return {k: sum(1 for i in items if i["type"] == type_ and i["change"] == k) for k in keys}


@dataclass
class ApplyResult:
    added: list[str]
    changed: list[str]
    rejected_as_no_longer_found: list[str]
    kept_current: list[str]
    suppressed_rejected: list[str]
    skipped_rows: list[uuid.UUID]


async def apply_rows(
    session: AsyncSession,
    adapter: RowAdapter,
    items: Sequence[dict[str, Any]],
    decisions: dict[str, str],
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    user_id: uuid.UUID | None,
    reject: Callable[[Any, str], None] | None = None,
    rejected_note: str = "No longer found in the latest generation",
    skip_parents: set[str] | None = None,
) -> ApplyResult:
    """Applies the user's choices to the candidate rows of one artefact type."""
    res = ApplyResult([], [], [], [], [], [])
    skipped_parents = skip_parents or set()
    for it in items:
        if it["type"] != adapter.entity_type:
            continue
        if it["change"] == "suppressed_rejected":
            if it.get("key"):
                res.suppressed_rejected.append(it["key"])
            continue
        if it.get("parent_lineage_id") and it["parent_lineage_id"] in skipped_parents:
            continue
        row = await _get(session, adapter.model, it.get("candidate_row_id"))
        if row is None:
            continue
        cur = await _get(session, adapter.model, it.get("current_row_id"))
        entry = ReviewEntry(
            it["change"],
            it["match_key"],
            uuid.UUID(it["lineage_id"]) if it.get("lineage_id") else None,
            it.get("key"),
            it.get("current"),
            it.get("proposed"),
            it.get("default_action"),
            list(it.get("allowed_actions") or []),
        )
        action = resolve_action(entry, decisions)
        changed_meanwhile = (
            cur is not None and it.get("current_version") is not None and cur.version != it["current_version"]
        )
        if changed_meanwhile and it["change"] in ("changed", "protected_with_proposal"):
            action = "keep"  # someone edited the current item after generation: never overwrite their work
        before = adapter.content(cur) if cur is not None else {}
        if it["change"] == "added":
            if action == "skip":
                res.skipped_rows.append(row.id)
                await session.execute(delete(adapter.model).where(adapter.model.id == row.id))
                continue
            res.added.append(row.key)
        elif it["change"] == "changed":
            if action == "accept" and cur is not None:
                row.version = cur.version + 1
                await _revise(session, adapter, row, before, org_id, project_id, user_id, "Applied regeneration")
                res.changed.append(row.key)
            elif cur is not None:
                sync_from(row, cur)
                res.kept_current.append(row.key)
        elif it["change"] == "protected_with_proposal":
            if cur is not None:
                sync_from(row, cur)
            if action == "accept" and row.suggested_change:
                adapter.apply_content(row, row.suggested_change)
                if "evidence_refs" in row.suggested_change:
                    row.evidence_refs = row.suggested_change["evidence_refs"]
                row.version = (cur.version if cur is not None else row.version) + 1
                await _revise(session, adapter, row, before, org_id, project_id, user_id, "Accepted generator proposal")
                res.changed.append(row.key)
            else:
                res.kept_current.append(row.key)
        elif it["change"] == "no_longer_found":
            if cur is not None:
                sync_from(row, cur)
            if action == "mark_rejected" and reject is not None:
                reject(row, rejected_note)
                row.version = (cur.version if cur is not None else row.version) + 1
                await _revise(session, adapter, row, before, org_id, project_id, user_id, rejected_note)
                res.rejected_as_no_longer_found.append(row.key)
            else:
                res.kept_current.append(row.key)
        elif cur is not None:  # unchanged: pick up edits made after generation
            evidence = row.evidence_refs if hasattr(row, "evidence_refs") else None
            sync_from(row, cur)
            if evidence is not None and not cur.locked and not cur.human_edited:
                row.evidence_refs = evidence
        row.suggested_change = None
    await session.flush()
    return res


async def carry_missing(
    session: AsyncSession,
    adapter: RowAdapter,
    *,
    current_rows: Sequence[Any],
    candidate_run_id: uuid.UUID,
    overrides: Callable[[Any], dict[str, Any]] | None = None,
) -> list[Any]:
    """Rows created in the current version after the candidate was generated are carried into it unchanged."""
    present = {
        r.lineage_id
        for r in (
            await session.execute(select(adapter.model).where(adapter.model.stage_run_id == candidate_run_id))
        ).scalars()
    }
    out = []
    for r in current_rows:
        if r.lineage_id not in present:
            row = clone(r, stage_run_id=candidate_run_id, **(overrides(r) if overrides else {}))
            session.add(row)
            out.append(row)
    await session.flush()
    return out


async def _get(session: AsyncSession, model: type[Any], raw_id: str | None) -> Any | None:
    if not raw_id:
        return None
    return (await session.execute(select(model).where(model.id == uuid.UUID(raw_id)))).scalar_one_or_none()


async def _revise(
    session: AsyncSession,
    adapter: RowAdapter,
    row: Any,
    before: dict[str, Any],
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    user_id: uuid.UUID | None,
    reason: str,
) -> None:
    row.updated_by = user_id
    row.updated_at = utcnow()
    after = adapter.content(row)
    await revisions.record(
        session,
        org_id=org_id,
        project_id=project_id,
        entity_type=adapter.entity_type,
        entity_id=row.id,
        lineage_id=row.lineage_id,
        version=row.version,
        snapshot=after,
        changes=revisions.diff(before, after),
        source="regeneration_review",
        changed_by=user_id,
        change_reason=reason,
    )
