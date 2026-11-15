"""Marks a project as recently changed (`projects.updated_at`) without its optimistic version check.

`projects.version` is SQLAlchemy's `version_id_col`, so assigning `project.updated_at` on a loaded row turns the
commit into `UPDATE … WHERE version = <the version read>`. The worker touches the project whenever a stage moves,
so a request that read the project a moment earlier (approving Gate 2 while the requirements stage starts) failed
with `StaleDataError`: an unhandled 500 (QA P4-BUG-09). A touch is not an edit, so it is a plain UPDATE of the
timestamp that neither checks nor bumps the version; real edits (name, archive) still go through the version check.
"""

from __future__ import annotations

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.db.models import Project
from app.db.types import utcnow


async def touch_project(s: AsyncSession, project: Project) -> None:
    now = utcnow()
    await s.execute(
        update(Project)
        .where(Project.id == project.id)
        .values(updated_at=now)
        .execution_options(synchronize_session=False)
    )
    # The loaded object shows the new time without becoming dirty (no versioned UPDATE at commit).
    set_committed_value(project, "updated_at", now)
