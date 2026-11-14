"""QA P4-BUG-09: approving Gate 2 while the worker starts the next stages. The approval used to fail with an
unhandled `StaleDataError` (the worker had touched the project's versioned row in between), a 500 without CORS
headers that the browser showed as "Can't reach QA Analyst". Concurrent approvals record exactly one decision."""

from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path

from sqlalchemy import select

from app.context import AppContext, build_context
from app.db.models import GateDecision, Project
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.db.touch import touch_project
from app.domain.enums import GateKey
from app.llm.base import DisabledLLM
from tests.conftest import client_for, make_settings, register, worker_for
from tests.fixtures.site import running_site

API = "/api/v1"


async def test_touches_from_two_sessions_never_conflict(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx()
    async with client_for(ctx) as c:
        acct = await register(c, org="Touch Org")
        r = await c.post(f"{API}/projects", headers=acct.headers, json={
            "url": "https://example.com", "name": "Touch", "start": False,
            "authorisation": {"attested": True, "statement": "A test-owned site, not a real one."},
        })  # fmt: skip
        assert r.status_code == 201, r.text
        pid = uuid.UUID(r.json()["id"])
    sa, sb = ctx.session_factory(), ctx.session_factory()
    async with sa, sb:
        for sess in (sa, sb):
            bind_scope(sess, system_scope(acct.org_id))
        q = select(Project).where(Project.id == pid).execution_options(**BYPASS)
        a, b = (await sa.execute(q)).scalar_one(), (await sb.execute(q)).scalar_one()
        version = a.version
        await touch_project(sb, b)
        await sb.commit()
        await touch_project(sa, a)  # read before the other session's write: used to raise StaleDataError
        await sa.commit()
        assert (await sa.execute(q)).scalar_one().version == version  # a touch is not an edit


async def test_concurrent_g2_approvals_while_the_worker_runs(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, _site):
        async with client_for(ctx) as client:
            owner = await register(client, "race@example.com", org="Race Org")
            r = await client.post(f"{API}/projects", headers=owner.headers, json={
                "url": base_url, "name": "Race", "start": True,
                "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                "scan": {"max_pages": 10, "max_depth": 2},
            })  # fmt: skip
            pid = r.json()["id"]
            worker = worker_for(ctx)
            await worker.start()
            try:
                codes: list[int] = []
                for _ in range(2400):
                    wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
                    d = next(s for s in wf["stages"] if s["key"] == "discovery")
                    if d["status"] == "completed" and d["gate"]["status"] in ("recommended", "pending"):
                        # The worker is now starting the requirements stage (G2 is "recommended").
                        body = {"decision": "approve", "comment": "", "stage_run_version": d["current_version"]}
                        url = f"{API}/projects/{pid}/gates/G2/decision"
                        rs = await asyncio.gather(
                            *[client.post(url, json=body, headers=owner.headers) for _ in range(3)]
                        )
                        codes = sorted(x.status_code for x in rs)
                        break
                    await asyncio.sleep(0.05)
                assert codes == [200, 409, 409], codes
            finally:
                await worker.stop()
            async with ctx.session_factory() as s:
                rows = (
                    await s.execute(
                        select(GateDecision).where(GateDecision.gate_key == GateKey.G2).execution_options(**BYPASS)
                    )
                ).scalars()
                assert len(list(rows)) == 1
    await ctx.close()
