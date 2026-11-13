"""Run Alembic migrations from inside the application (startup and tests)."""

from __future__ import annotations

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


async def upgrade(engine: AsyncEngine, revision: str = "head") -> None:
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync_conn: command.upgrade(alembic_config(sync_conn), revision))


async def downgrade(engine: AsyncEngine, revision: str = "base") -> None:
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync_conn: command.downgrade(alembic_config(sync_conn), revision))


async def prepare_database(engine: AsyncEngine, settings: Settings) -> None:
    """Bring the schema to head. SQLite file directories are created first."""
    url = settings.database_url
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
    await upgrade(engine)
