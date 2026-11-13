"""Phase 2 migrations (0005-0012) on a database with Phase 1 data: up -> down to Phase 1 -> up again keeps
projects, scans, pages, evidence and secrets; the credentials backfill (app code, needs the key) is idempotent."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from sqlalchemy import text

from app.context import build_context
from app.db.migrate import downgrade, upgrade
from app.llm.base import DisabledLLM
from app.services.secrets import backfill
from tests.conftest import client_for, make_settings, register, worker_for
from tests.fixtures.site import running_site


async def _counts(ctx: object) -> dict[str, int]:
    out = {}
    async with ctx.engine.connect() as conn:  # type: ignore[attr-defined]
        for t in ("projects", "project_urls", "scan_sessions", "discovered_pages", "evidence", "secrets", "stage_runs"):
            out[t] = int((await conn.execute(text(f"SELECT COUNT(*) FROM {t}"))).scalar_one())  # noqa: S608
    return out


async def test_up_down_up_with_phase1_data(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, _site):
        async with client_for(ctx) as client:
            owner = await register(client, "mig@example.com", org="Mig Org")
            r = await client.post(
                "/api/v1/projects",
                headers=owner.headers,
                json={
                    "url": base_url, "name": "Phase 1 project", "start": True,
                    "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                    "scan": {"max_pages": 8, "max_depth": 2},
                    "credentials": {"login_url": f"{base_url}/login", "username": "p1@example.com",
                                    "password": "phase-one-password"},
                },
            )  # fmt: skip
            assert r.status_code == 201, r.text
            await worker_for(ctx).run_until_idle(timeout=240)
    before = await _counts(ctx)
    assert before["discovered_pages"] > 0 and before["secrets"] == 1
    # Back to the Phase 1 schema: Phase 2 tables/columns go, Phase 1 rows stay.
    await downgrade(ctx.engine, "0004")
    async with ctx.engine.connect() as conn:
        tables = {row[0] for row in await conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        assert "requirements" not in tables and "source_documents" not in tables
        cols = {row[1] for row in await conn.execute(text("PRAGMA table_info(secrets)"))}
        assert "metadata" not in cols and "version" not in cols
    # Phase 1 rows kept (requirement-stage runs belong to the Phase 1 stage_runs table and stay too).
    after_down = await _counts(ctx)
    assert after_down == before
    await upgrade(ctx.engine)
    after_up = await _counts(ctx)
    assert after_up == before
    async with ctx.engine.connect() as conn:
        row = (await conn.execute(text("SELECT kind, metadata, version FROM secrets"))).one()
        assert row[0] == "login_credentials" and row[1] is None and row[2] == 1
        ctx_kinds = {r[0] for r in await conn.execute(text("SELECT DISTINCT auth_context FROM discovered_pages"))}
        assert ctx_kinds == {"anonymous"}
    assert await backfill(ctx) == 1
    assert await backfill(ctx) == 0  # idempotent
    async with ctx.engine.connect() as conn:
        meta = (await conn.execute(text("SELECT metadata FROM secrets"))).scalar_one()
        assert json.loads(meta)["username_hint"] == "p1…@example.com" and "phase-one-password" not in meta
    # Down to base and up again on the same file works too.
    await downgrade(ctx.engine, "base")
    await upgrade(ctx.engine)
    await ctx.close()
