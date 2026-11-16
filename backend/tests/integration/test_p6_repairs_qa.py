"""QA probes for P6-04 on the demo shop (written by QA, not the developer): concurrent accepts of two repairs on the
same page object, a double accept of one repair, what every suggestion offers, and what the regression run then
shows for the empty-Message case."""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import shutil
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app.context import build_context
from app.db.models import AutomationAsset, AutomationScript
from app.db.tenant import BYPASS
from app.domain.enums import Role
from app.llm.base import DisabledLLM
from tests.conftest import client_for, make_settings, register, worker_for
from tests.integration.test_p4_automation import _user
from tests.integration.test_p6_demo_shop import Shop

API = "/api/v1"
EXPECTED = "Submission is blocked and Message is identified as required"
pytestmark = [
    pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed"),
    pytest.mark.skipif(
        not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
        reason="the automation toolkit's dependencies are not installed",
    ),
]


async def test_qa_concurrent_accepts_and_demo_outcome(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    version = tmp_path / "demo-version"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version))
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    try:
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p6-qa604.example.com", org="P6 QA604")
            h = owner.headers
            idle = worker_for(ctx).run_until_idle

            async def stage(key: str) -> dict[str, Any]:
                wf = (await c.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
                return dict(next(s for s in wf["stages"] if s["key"] == key))

            async def gate(g: str, key: str, who: dict[str, str]) -> None:
                st = await stage(key)
                d = await c.post(f"{API}/projects/{pid}/gates/{g}/decision", headers=who,
                                 json={"decision": "approve", "comment": "ok", "stage_run_version": st["current_version"]})  # fmt: skip
                assert d.status_code == 200, d.text
                await idle(timeout=600)

            async def code() -> tuple[dict[str, str], dict[str, str]]:
                """(spec path -> sha256, page object path -> code) of the project's current scripts and assets."""
                async with ctx.session_factory() as s:
                    scripts = (
                        await s.execute(
                            select(AutomationScript)
                            .where(AutomationScript.project_id == uuid.UUID(pid))
                            .execution_options(**BYPASS)
                        )
                    ).scalars()
                    assets = (
                        await s.execute(
                            select(AutomationAsset)
                            .where(AutomationAsset.project_id == uuid.UUID(pid))
                            .execution_options(**BYPASS)
                        )
                    ).scalars()
                    return (
                        {x.path: hashlib.sha256(x.code.encode()).hexdigest() for x in scripts},
                        {a.path: a.code for a in assets},
                    )

            r = await c.post(f"{API}/projects", headers=h, json={
                "url": shop.base, "name": "Demo shop", "start": True,
                "authorisation": {"attested": True, "statement": "Private demo shop run by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            pid = r.json()["id"]
            await idle(timeout=600)
            await gate("G2", "discovery", h)

            # Phase 4: requirements, strategy and cases approved; G6 passes; DEF-0001 confirmed at G8.
            reqs = (await c.get(f"{API}/projects/{pid}/requirements?limit=100", headers=h)).json()["items"]
            ids = [x["id"] for x in reqs if x["status"] == "draft"]
            assert (await c.post(f"{API}/projects/{pid}/requirements/bulk-status", headers=h,
                                 json={"ids": ids, "status": "approved"})).status_code == 200  # fmt: skip
            await gate("G3", "requirements", h)
            await gate("G4", "test_strategy", h)
            oq = (await c.get(f"{API}/projects/{pid}/test-cases?limit=50&open_question=true", headers=h)).json()
            empty = next(x for x in oq["items"] if "empty Message" in x["title"])
            d = (await c.get(f"{API}/test-cases/{empty['id']}", headers=h)).json()
            w = await c.patch(f"{API}/test-cases/{d['id']}", headers=h,
                              json={"version": d["version"], "expected_result": EXPECTED})  # fmt: skip
            assert w.status_code == 200, w.text
            cases: list[dict[str, Any]] = []
            cursor = None
            while True:
                q = f"{API}/projects/{pid}/test-cases?limit=100" + (f"&cursor={cursor}" if cursor else "")
                page = (await c.get(q, headers=h)).json()
                cases += page["items"]
                cursor = page["next_cursor"]
                if not cursor:
                    break
            bulk = await c.post(f"{API}/projects/{pid}/test-cases/bulk-status", headers=h,
                                json={"ids": [x["id"] for x in cases if x["status"] == "draft"], "status": "approved"})  # fmt: skip
            assert bulk.status_code == 200, bulk.text
            await gate("G5", "test_design", h)
            auto = (await c.get(f"{API}/projects/{pid}/automation", headers=h)).json()
            assert auto["g6"]["state"] == "passed_automatically", auto["g6"]
            member = await _user(ctx, c, owner.org_id, "member@p6-qa604.example.com", Role.member)
            approver = await _user(ctx, c, owner.org_id, "approver@p6-qa604.example.com", Role.member, True)
            req = await c.post(f"{API}/projects/{pid}/execution-runs", headers=member,
                               json={"selection": {"case_keys": [empty["key"]]}})  # fmt: skip
            assert req.status_code == 201, req.text
            run_id = req.json()["id"]
            ok = await c.post(
                f"{API}/execution-runs/{run_id}/authorise", headers=approver, json={"decision": "approve"}
            )
            assert ok.status_code == 200, ok.text
            await idle(timeout=600)
            run = (await c.get(f"{API}/execution-runs/{run_id}", headers=h)).json()
            res = (await c.get(f"{API}/execution-results/{run['tests_rows'][0]['id']}", headers=h)).json()
            assert res["defect"]["key"] == "DEF-0001", res["defect"]
            defect_id = res["defect"]["id"]
            yes = await c.post(f"{API}/defects/{defect_id}/status", headers=approver, json={"action": "confirm"})
            assert yes.status_code == 200, yes.text

            # Release 2 and the rescan: CHG-0001, its impact and the repair suggestions (demo chain steps 2–4).
            version.write_text("2\n")
            r = await c.post(f"{API}/projects/{pid}/rescans", json={}, headers=member)
            assert r.status_code == 202, r.text
            await idle(timeout=600)
            [chg] = (await c.get(f"{API}/projects/{pid}/changes", headers=h)).json()["items"]
            assert chg["key"] == "CHG-0001" and chg["status"] == "completed"
            listing = (await c.get(f"{API}/projects/{pid}/heal-suggestions?change_set={chg['id']}", headers=h)).json()
            by_expr = {i["old_expression"]: i for i in listing["items"] if i["kind"] == "locator"}
            h1 = by_expr["getByLabel('Message')"]
            h2 = by_expr["getByRole('button', { name: 'Send message' })"]
            assert (h1["key"], h2["key"]) == ("HEAL-0001", "HEAL-0002"), sorted(by_expr)
            for sug, new in ((h1, "getByLabel('Your message')"), (h2, "getByRole('button', { name: 'Send' })")):
                first = sug["candidates"][0]
                assert first["expression"] == new, sug["candidates"]
                assert first["level"] == "high" and first["match_count"] == 1 and first["offered"], first
                assert first["signals"][0]["text"] == "Same field, renamed (CHG-0001)", first["signals"]
                assert first["evidence"] and first["evidence"]["kind"] == "screenshot"
                assert sug["file_name"] == "ContactPage.ts" and sug["source"] == "change"
            no = await c.post(f"{API}/change-sets/{chg['id']}/regression-run", headers=member, json={})
            assert no.status_code == 422 and "HEAL-0001" in no.text, no.text

            # QA: every suggestion of the change set, as the API shows it.
            dump = [
                {"key": i["key"], "kind": i["kind"], "old": i["old_expression"], "status": i["status"],
                 "review": (i["review"] or {}).get("message"),
                 "cands": [(x["expression"], x["level"], x["score"], x["offered"], x["match_count"],
                            [s["text"] for s in x["signals"]], bool(x["evidence"]), x["not_offered_reason"])
                           for x in i["candidates"]]}
                for i in sorted(listing["items"], key=lambda i: i["key"])
            ]  # fmt: skip
            print("QA-SUGGESTIONS", json.dumps(dump, indent=1))
            specs_before, assets_before = await code()
            contact = "pages/ContactPage.ts"
            # Probe 1: the same suggestion accepted twice at the same time: exactly one wins.
            a, b = await asyncio.gather(
                c.post(f"{API}/heal-suggestions/{h1['id']}/accept", headers=member, json={"index": 0}),
                c.post(f"{API}/heal-suggestions/{h1['id']}/accept", headers=approver, json={"index": 0}),
            )
            print("QA-DOUBLE", a.status_code, b.status_code, b.text[:200])
            # Probe 2: two different suggestions on the same page object accepted at the same time.
            others = [
                i for i in listing["items"]
                if i["kind"] == "locator" and i["status"] == "open" and i["file"] == contact and i["id"] != h1["id"]
            ]  # fmt: skip
            results = await asyncio.gather(
                *[c.post(f"{API}/heal-suggestions/{i['id']}/accept", headers=member, json={"index": 0}) for i in others]
            )
            print(
                "QA-CONCURRENT", [(i["key"], r.status_code, r.text[:160]) for i, r in zip(others, results, strict=True)]
            )
            # Whatever failed in the race is accepted again, one at a time (as a person retrying would).
            retried = []
            for i, r in [(h1, a if a.status_code != 200 else b), *zip(others, results, strict=True)]:
                if r.status_code != 200 and i["key"] != "HEAL-0004":
                    again = await c.post(f"{API}/heal-suggestions/{i['id']}/accept", headers=member, json={"index": 0})
                    retried.append((i["key"], again.status_code))
            print("QA-RETRIED", retried)
            await idle(timeout=600)
            specs_after, assets_after = await code()
            print("QA-CONTACTPAGE-DIFF")
            print(
                "\n".join(
                    difflib.unified_diff(
                        assets_before[contact].splitlines(), assets_after[contact].splitlines(), lineterm=""
                    )
                )
            )
            assert specs_after == specs_before
            listing2 = (
                await c.get(f"{API}/projects/{pid}/heal-suggestions?change_set={chg['id']}&status=all", headers=h)
            ).json()
            accepted = [i for i in listing2["items"] if i["status"] == "accepted" and i["file"] == contact]
            for i in accepted:
                cand = i["candidates"][i["accepted_index"]]
                exp = cand["expression"]
                print(
                    "QA-ACCEPTED",
                    i["key"],
                    i["old_expression"],
                    "->",
                    exp,
                    "checking",
                    (i["checking"] or {}).get("state"),
                )
            async with ctx.session_factory() as s:
                runs = (
                    await s.execute(
                        select(AutomationAsset).where(AutomationAsset.path == contact).execution_options(**BYPASS)
                    )
                ).scalars()
                for a_ in runs:
                    print("QA-ASSET-VERSION", a_.version)
            rec = (await c.get(f"{API}/change-sets/{chg['id']}/regression-recommendation", headers=h)).json()
            print("QA-BLOCKED", rec["blocked"])
            print(
                "QA-MUST",
                [
                    (p["key"], p["runnable"], p["not_runnable_reason"], (p["script"] or {}).get("state"))
                    for p in rec["must"]
                ],
            )
            # Every accepted change must be in the file: the new expression of every accepted repair is present.
            missing = []
            for i in accepted:
                cand = i["candidates"][i["accepted_index"]]
                name = (cand.get("element") or {}).get("name")
                if name and f'"{name}"' not in assets_after[contact]:
                    missing.append((i["key"], cand["expression"]))
            reg = await c.post(
                f"{API}/change-sets/{chg['id']}/regression-run", headers=member, json={"include_should": False}
            )
            print("QA-REG", reg.status_code, reg.text[:300])
            if reg.status_code == 201:
                ok = await c.post(
                    f"{API}/execution-runs/{reg.json()['id']}/authorise", headers=approver, json={"decision": "approve"}
                )
                assert ok.status_code == 200, ok.text
                await idle(timeout=900)
                done = (await c.get(f"{API}/execution-runs/{reg.json()['id']}", headers=h)).json()
                for t in done["tests_rows"]:
                    d = (await c.get(f"{API}/execution-results/{t['id']}", headers=h)).json()
                    print("QA-RESULT", t["case_key"], t["status"], (d.get("error") or "")[:200])
                    if t["status"] != "passed":
                        tc = (
                            (await c.get(f"{API}/test-cases/{d['case']['id']}", headers=h)).json()
                            if d.get("case")
                            else {}
                        )
                        print("QA-CASE", t["case_key"], tc.get("title"), "| expected:", tc.get("expected_result"))
                        print(
                            "QA-RESULT-REPAIRS",
                            [(x["key"], x["kind"], (x["review"] or {}).get("message")) for x in d.get("repairs") or []],
                        )
                        print("QA-RESULT-ANALYSIS", (d.get("analysis") or {}).get("classification"), d.get("defect"))
                after_run = (await c.get(f"{API}/change-sets/{chg['id']}/impact", headers=h)).json()["items"]
                print(
                    "QA-IMPACT-OPEN",
                    [(i["action"], i["target_kind"], i["status"]) for i in after_run if i["status"] == "open"],
                )
            assert sorted([a.status_code, b.status_code]) == [200, 409], (a.status_code, b.status_code)
            assert all(r.status_code in (200, 409) for r in results), [r.status_code for r in results]
            assert not missing, f"accepted repairs lost from {contact}: {missing}"
    finally:
        shop.stop()
        await ctx.close()
