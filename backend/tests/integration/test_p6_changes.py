"""P6-01 end to end on the backend fixture site (real browser, AI off): Scan 1 on release 1 is approved at G2, the site
switches to release 2 (`site.version = 2`), and `POST /rescans` runs Scan 2 and the `change_analysis` stage writes
CHG-0001. A second rescan (Scan 3, compared with Scan 2) makes CHG-0002, and a person compares Scan 1 with Scan 3.

Checks: the moved "Add to basket" button is `element_moved` (cosmetic), "About" → "About us" is a cosmetic heading
change, the product price (£12.50 → £13.00) is "Content values changed" and not a rename, the ambiguous "Opening hours"
rename is a remove and two adds, the new page and nav link are listed, items carry both scans' evidence; Scan 1's rows,
pages, evidence files (count and sha256) and reports are byte-for-byte unchanged after both rescans (no row of an
earlier session updated or deleted); comparing 1 with 3 adds CHG-0003 and leaves CHG-0001/0002 as they were; approved
work keeps its status (D27); other organisations get 404.
"""

from __future__ import annotations

import hashlib
import shutil
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text

from app.context import AppContext, build_context
from app.db.models import Evidence, WorkflowStage
from app.db.tenant import BYPASS
from app.llm.base import DisabledLLM
from tests.conftest import Account, client_for, make_settings, register, worker_for
from tests.fixtures.site import FixtureSite, running_site

API = "/api/v1"


@dataclass
class Chain:
    ctx: AppContext
    client: httpx.AsyncClient
    site: FixtureSite
    owner: Account
    other: Account
    pid: str
    scans: dict[int, str]
    before: dict[str, Any]
    files_before: dict[str, str]
    stages_before: dict[str, tuple[str, str | None]]


async def _rows(ctx: AppContext, scan_id: str) -> dict[str, Any]:
    """Every row that belongs to one scan session (its own row, pages, evidence, features, journeys, its discovery
    stage run, feature links) plus the project's reports, as raw column values."""
    hexid = uuid.UUID(scan_id).hex
    out: dict[str, Any] = {}
    async with ctx.session_factory() as s:
        tables = [r[0] for r in (await s.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))).all()]
        for t in tables:
            cols = [r[1] for r in (await s.execute(text(f"PRAGMA table_info({t})"))).all()]
            if "scan_session_id" in cols:
                rows = (
                    await s.execute(text(f"SELECT * FROM {t} WHERE scan_session_id = :i ORDER BY id"), {"i": hexid})  # noqa: S608
                ).all()
                out[t] = [tuple(r) for r in rows]
        out["scan_sessions"] = [tuple(r) for r in (await s.execute(text("SELECT * FROM scan_sessions WHERE id = :i"), {"i": hexid})).all()]  # fmt: skip
        run_id = (
            await s.execute(text("SELECT stage_run_id FROM scan_sessions WHERE id = :i"), {"i": hexid})
        ).scalar_one()
        out["stage_runs"] = [tuple(r) for r in (await s.execute(text("SELECT * FROM stage_runs WHERE id = :i"), {"i": run_id})).all()]  # fmt: skip
        page_ids = [r[0] for r in (await s.execute(text("SELECT id FROM discovered_pages WHERE scan_session_id = :i"), {"i": hexid})).all()]  # fmt: skip
        links: list[tuple[Any, ...]] = []
        for page_id in page_ids:
            q = text("SELECT * FROM feature_pages WHERE page_id = :p")
            links += [tuple(r) for r in (await s.execute(q, {"p": page_id})).all()]
        out["feature_pages"] = sorted(links)
        out["qa_reports"] = [tuple(r) for r in (await s.execute(text("SELECT * FROM qa_reports ORDER BY id"))).all()]
    return out


async def _files(ctx: AppContext, scan_id: str) -> dict[str, str]:
    async with ctx.session_factory() as s:
        rows = (
            await s.execute(
                select(Evidence).where(Evidence.scan_session_id == uuid.UUID(scan_id)).execution_options(**BYPASS)
            )
        ).scalars()
        files = {e.storage_key: e.sha256 for e in rows}
    for key, sha in files.items():
        assert hashlib.sha256(await ctx.storage.get(key)).hexdigest() == sha, key
    return files


async def _stages(ctx: AppContext, pid: str) -> dict[str, tuple[str, str | None]]:
    async with ctx.session_factory() as s:
        rows = (
            await s.execute(
                select(WorkflowStage).where(WorkflowStage.project_id == uuid.UUID(pid)).execution_options(**BYPASS)
            )
        ).scalars()
        return {r.stage_key.value: (r.status.value, str(r.current_stage_run_id)) for r in rows}


async def _rescan(client: httpx.AsyncClient, owner: Account, pid: str, body: dict[str, Any]) -> dict[str, Any]:
    r = await client.post(f"{API}/projects/{pid}/rescans", json=body, headers=owner.headers)
    assert r.status_code == 202, r.text
    data: dict[str, Any] = r.json()
    return data


@pytest.fixture(scope="module")
async def chain(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Chain]:
    tmp = tmp_path_factory.mktemp("p6-changes")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p6-changes.example.com", org="P6 Changes")
            other = await register(client, "other@p6-changes.example.com", org="P6 Changes Other")
            r = await client.post(f"{API}/projects", headers=owner.headers, json={
                "url": base_url, "name": "Fixture shop", "start": True,
                "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            pid = r.json()["id"]
            await worker_for(ctx).run_until_idle(timeout=300)
            wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
            disc = next(s for s in wf["stages"] if s["key"] == "discovery")
            body = {"decision": "approve", "comment": "", "stage_run_version": disc["current_version"]}
            ok = await client.post(f"{API}/projects/{pid}/gates/G2/decision", json=body, headers=owner.headers)
            assert ok.status_code == 200, ok.text
            await worker_for(ctx).run_until_idle(timeout=300)
            scan1 = (await client.get(f"{API}/projects/{pid}/discovery", headers=owner.headers)).json()["id"]
            before, files_before = await _rows(ctx, scan1), await _files(ctx, scan1)
            stages_before = await _stages(ctx, pid)
            site.version = 2
            scan2 = (await _rescan(client, owner, pid, {}))["scan"]["id"]
            await worker_for(ctx).run_until_idle(timeout=300)
            scan3 = (await _rescan(client, owner, pid, {"compare_with": scan2}))["scan"]["id"]
            await worker_for(ctx).run_until_idle(timeout=300)
            yield Chain(ctx, client, site, owner, other, pid, {1: scan1, 2: scan2, 3: scan3}, before, files_before,
                        stages_before)  # fmt: skip
    await ctx.close()


async def _sets(c: Chain) -> dict[str, dict[str, Any]]:
    items = (await c.client.get(f"{API}/projects/{c.pid}/changes", headers=c.owner.headers)).json()["items"]
    return {x["key"]: x for x in items}


async def _items(c: Chain, cs_id: str) -> list[dict[str, Any]]:
    r = await c.client.get(f"{API}/change-sets/{cs_id}/items", headers=c.owner.headers)
    assert r.status_code == 200, r.text
    items: list[dict[str, Any]] = r.json()["items"]
    return items


async def test_rescan_change_set_on_release_2(chain: Chain) -> None:
    sets = await _sets(chain)
    chg = sets["CHG-0001"]
    assert chg["status"] == "completed" and chg["source"] == "rescan" and chg["generated_by"] == "rules"
    assert chg["base"]["id"] == chain.scans[1] and chg["target"]["id"] == chain.scans[2]
    assert chg["base"]["g2_approved"] and chg["target"]["is_rescan"]
    items = await _items(chain, chg["id"])
    subjects = {(i["kind"], i["significance"], i["page"], i["subject"]) for i in items}
    # Moved (same name, new selector): cosmetic, no script uses its old selector.
    moved = [i for i in items if i["kind"] == "element_moved"]
    assert moved and all(i["significance"] == "cosmetic" and i["subject"] == "Button moved: Add to basket"
                         and i["page"].startswith("/products/") for i in moved)  # fmt: skip
    assert ("page_changed", "cosmetic", "/about", "Headings changed on /about: About → About us") in subjects
    values = [i for i in items if i["display_kind"] == "content_values"]
    assert values and all(i["page"].startswith("/products/") and i["significance"] == "cosmetic" for i in values)
    assert {
        (i["subject"].split(" on ")[0], tuple(i["before"]["values"]), tuple(i["after"]["values"])) for i in values
    } == {("Content values changed", ("Price: £12.50",), ("Price: £13.00",))}
    assert not [i for i in items if i["kind"] == "element_renamed" and "£" in i["subject"]]
    # The ambiguous rename: never guessed.
    assert ("element_removed", "structural", "/contact", "Button removed: Opening hours") in subjects
    assert {"Button added: Opening times", "Button added: Opening days"} <= {i["subject"] for i in items}
    assert not [i for i in items if i["kind"] == "element_renamed" and i["page"] == "/contact"]
    # The all-new page and its nav link.
    assert ("page_added", "structural", "/new-arrivals", "Page added: /new-arrivals") in subjects
    nav = [i for i in items if i["kind"] == "navigation_changed"]
    assert [i["subject"] for i in nav] == ["Navigation changed: 'New arrivals' added"]
    # No item for pages that didn't change.
    assert not {i["page"] for i in items} & {"/blog", "/faq", "/login", "/products"}
    # Evidence from both scans, nothing copied.
    about = next(i for i in items if i["page"] == "/about")
    assert about["before_ref"]["screenshot"] and about["after_ref"]["screenshot"]
    assert about["before_ref"]["screenshot"]["id"] != about["after_ref"]["screenshot"]["id"]
    added = next(i for i in items if i["kind"] == "page_added")
    assert added["before_ref"] is None and added["after_ref"]["screenshot"]
    assert chg["rebaseline_suggested"] is False and chg["not_compared"] == []


async def test_earlier_scan_is_untouched(chain: Chain) -> None:
    after = await _rows(chain.ctx, chain.scans[1])
    for table, rows in chain.before.items():
        if table == "qa_reports":  # later rescans add report versions; every earlier one is unchanged
            assert set(rows) <= set(after[table]) and len(after[table]) > len(rows)
            continue
        assert after[table] == rows, table  # no row of Scan 1 was updated or deleted
    assert len(chain.before["discovered_pages"]) > 5 and chain.before["evidence"]
    files = await _files(chain.ctx, chain.scans[1])  # each file read back; its sha256 still matches
    assert files == chain.files_before
    h = chain.owner.headers
    pages = (await chain.client.get(f"{API}/scans/{chain.scans[1]}/pages?limit=100", headers=h)).json()["items"]
    assert len(pages) == len(chain.before["discovered_pages"])
    shot = next(p["screenshot"] for p in pages if p.get("screenshot"))
    content = await chain.client.get(shot["content_url"].replace("http://test", ""))
    assert content.status_code == 200 and content.content


async def test_approved_work_keeps_its_status_after_rescans(chain: Chain) -> None:
    after = await _stages(chain.ctx, chain.pid)
    for key in ("requirements", "readiness_criteria", "test_strategy"):
        assert after[key] == chain.stages_before[key], key
    assert after["change_analysis"][0] == "completed"


async def test_compare_scan_1_with_scan_3_skipping_2(chain: Chain) -> None:
    sets = await _sets(chain)
    assert sets["CHG-0002"]["base"]["id"] == chain.scans[2] and sets["CHG-0002"]["target"]["id"] == chain.scans[3]
    earlier = {k: await _items(chain, sets[k]["id"]) for k in ("CHG-0001", "CHG-0002")}
    body = {"from_scan_id": chain.scans[1], "to_scan_id": chain.scans[3]}
    r = await chain.client.post(f"{API}/projects/{chain.pid}/changes", json=body, headers=chain.owner.headers)
    assert r.status_code == 202 and r.json()["change_set"]["key"] == "CHG-0003"
    await worker_for(chain.ctx).run_until_idle(timeout=60)
    new = (await _sets(chain))["CHG-0003"]
    assert new["status"] == "completed" and new["source"] == "compare" and new["summary"]["total"] > 0
    assert {i["subject"] for i in await _items(chain, new["id"])} >= {"Page added: /new-arrivals"}
    for k, items in earlier.items():
        assert await _items(chain, sets[k]["id"]) == items, k  # earlier change sets are unchanged
    again = await chain.client.post(f"{API}/projects/{chain.pid}/changes", json=body, headers=chain.owner.headers)
    assert again.status_code == 200 and again.json()["change_set"]["key"] == "CHG-0003"


async def test_other_organisation_gets_404(chain: Chain) -> None:
    sets = await _sets(chain)
    cs = sets["CHG-0001"]["id"]
    for path in (f"/projects/{chain.pid}/scans", f"/change-sets/{cs}", f"/change-sets/{cs}/items",
                 f"/projects/{chain.pid}/changes"):  # fmt: skip
        assert (await chain.client.get(f"{API}{path}", headers=chain.other.headers)).status_code == 404, path
    r = await chain.client.post(f"{API}/projects/{chain.pid}/rescans", json={}, headers=chain.other.headers)
    assert r.status_code == 404
