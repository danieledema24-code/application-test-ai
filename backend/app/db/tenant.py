"""Tenant scoping (database-schema.md "Tenant isolation enforcement").

* `TenantScope` is bound to a session (API: from the auth session; worker: `system_scope` from the job row).
* A `do_orm_execute` listener adds `organisation_id == scope.org_id` to every ORM SELECT/UPDATE/DELETE touching a
  tenant model, and raises `TenantScopeMissing` when no scope is bound (safety net against unscoped queries).
  "Touching" is decided by walking the whole statement (FROM clauses, joins, subqueries), not only the selected
  entities, so aggregates such as `select(func.count()).select_from(Project)` are covered too.
* A `before_flush` listener fills/validates `organisation_id` on new tenant rows.
* Infrastructure code that must read across organisations (auth lookup of memberships, the job claimer) passes
  `execution_options(tenant_bypass=True)` explicitly.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Generic, TypeVar, cast

from sqlalchemy import Select, Table, event, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session, with_loader_criteria
from sqlalchemy.sql import visitors

from app.db.base import Base, TenantMixin
from app.domain.enums import Role

SCOPE_KEY = "tenant_scope"
BYPASS: dict[str, Any] = {"tenant_bypass": True}


class TenantScopeMissing(RuntimeError):
    pass


@dataclass(frozen=True)
class TenantScope:
    org_id: uuid.UUID
    user_id: uuid.UUID | None = None
    role: Role | None = None
    can_approve: bool = False
    system: bool = False


def system_scope(org_id: uuid.UUID) -> TenantScope:
    return TenantScope(org_id=org_id, system=True, role=Role.owner, can_approve=False)


def bind_scope(session: AsyncSession, scope: TenantScope) -> None:
    session.sync_session.info[SCOPE_KEY] = scope


def get_scope(session: AsyncSession) -> TenantScope:
    scope = session.sync_session.info.get(SCOPE_KEY)
    if scope is None:
        raise TenantScopeMissing("No tenant scope bound to this session")
    return cast(TenantScope, scope)


def _is_tenant(cls: Any) -> bool:
    return bool(getattr(cls, "__tenant__", False))


_tenant_tables_cache: tuple[int, dict[Table, str]] = (-1, {})


def _tenant_tables() -> dict[Table, str]:
    """Tenant tables -> model name, rebuilt when new mappers are registered."""
    global _tenant_tables_cache
    mappers = Base.registry.mappers
    if _tenant_tables_cache[0] != len(mappers):
        tables: dict[Table, str] = {}
        for m in mappers:
            if _is_tenant(m.class_):
                for t in m.tables:
                    if isinstance(t, Table):
                        tables[t] = m.class_.__name__
        _tenant_tables_cache = (len(mappers), tables)
    return _tenant_tables_cache[1]


def _tenant_models_in(statement: Any) -> set[str]:
    """Every tenant model referenced anywhere in the statement, including FROM-only aggregates and subqueries."""
    tables = _tenant_tables()
    return {tables[el] for el in visitors.iterate(statement) if isinstance(el, Table) and el in tables}


@event.listens_for(Session, "do_orm_execute")
def _add_tenant_criteria(state: ORMExecuteState) -> None:
    if state.is_column_load or state.is_relationship_load:
        return
    if not (state.is_select or state.is_update or state.is_delete):
        return
    if state.execution_options.get("tenant_bypass"):
        return
    names = {m.class_.__name__ for m in state.all_mappers if _is_tenant(m.class_)} | _tenant_models_in(state.statement)
    if not names:
        return
    scope = state.session.info.get(SCOPE_KEY)
    if scope is None:
        raise TenantScopeMissing(f"Query on tenant model(s) {', '.join(sorted(names))} without a tenant scope")
    org_id = scope.org_id
    state.statement = state.statement.options(
        with_loader_criteria(TenantMixin, lambda cls: cls.organisation_id == org_id, include_aliases=True)
    )


@event.listens_for(Session, "before_flush")
def _check_new_rows(session: Session, _ctx: Any, _instances: Any) -> None:
    scope = session.info.get(SCOPE_KEY)
    for obj in session.new:
        if not _is_tenant(type(obj)):
            continue
        current = getattr(obj, "organisation_id", None)
        if scope is None:
            if current is None:
                raise TenantScopeMissing(f"New {type(obj).__name__} without organisation_id or tenant scope")
            continue
        if current is None:
            obj.organisation_id = scope.org_id
        elif current != scope.org_id:
            raise TenantScopeMissing(f"Refusing to write {type(obj).__name__} into another organisation")


M = TypeVar("M", bound=TenantMixin)


class TenantRepository(Generic[M]):
    """Tenant-scoped data access. Reads of another organisation's ids return None (the API maps that to 404)."""

    def __init__(self, session: AsyncSession, model: type[M]) -> None:
        self.session = session
        self.model = model
        self.scope = get_scope(session)

    def select(self) -> Select[tuple[M]]:
        return cast("Select[tuple[M]]", select(self.model).where(self.model.organisation_id == self.scope.org_id))

    async def get(self, id_: uuid.UUID) -> M | None:
        id_col = self.model.id  # type: ignore[attr-defined]
        result = await self.session.execute(self.select().where(id_col == id_))
        return cast("M | None", result.scalar_one_or_none())

    async def list(self, *where: Any, order_by: Any = None, limit: int | None = None) -> list[M]:
        stmt = self.select().where(*where)
        if order_by is not None:
            stmt = stmt.order_by(order_by)
        if limit is not None:
            stmt = stmt.limit(limit)
        return cast("list[M]", list((await self.session.execute(stmt)).scalars().all()))

    def add(self, obj: M) -> M:
        obj.organisation_id = self.scope.org_id
        self.session.add(obj)
        return obj
