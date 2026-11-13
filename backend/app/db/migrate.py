"""Run Alembic migrations from inside the application (startup and tests)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

from app.config import Settings

BACKEND_DIR = Path(__file__).resolve().parents[2]


def alembic_config(connection: Connection | None = None) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["configure_logger"] = False
    if connection is not None:
        cfg.attributes["connection"] = connection
    return cfg


async def _run(engine: AsyncEngine, fn: Callable[[Connection], None]) -> None:
    """SQLite batch migrations recreate tables; with foreign keys enforced, recreating a referenced table that holds
    data fails. Enforcement is switched off for the migration connection (outside the transaction, as SQLite
    requires) and back on afterwards; `PRAGMA foreign_key_check` then verifies nothing was left dangling."""
    sqlite = engine.dialect.name == "sqlite"
    async with engine.connect() as conn:
        if sqlite:
            await conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
            await conn.commit()
        try:
            async with conn.begin():
                await conn.run_sync(fn)
                if sqlite:
                    bad = (await conn.exec_driver_sql("PRAGMA foreign_key_check")).fetchall()
                    if bad:
                        raise RuntimeError(f"Migration left {len(bad)} dangling foreign key(s): {bad[:3]}")
        finally:
            if sqlite:
                await conn.exec_driver_sql("PRAGMA foreign_keys=ON")
                await conn.commit()


async def upgrade(engine: AsyncEngine, revision: str = "head") -> None:
    await _run(engine, lambda sync_conn: command.upgrade(alembic_config(sync_conn), revision))


async def downgrade(engine: AsyncEngine, revision: str = "base") -> None:
    await _run(engine, lambda sync_conn: command.downgrade(alembic_config(sync_conn), revision))


async def prepare_database(engine: AsyncEngine, settings: Settings) -> None:
    """Bring the schema to head. SQLite file directories are created first."""
    url = settings.database_url
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
    await upgrade(engine)
