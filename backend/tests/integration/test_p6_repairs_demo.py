"""P6-04 on the demo shop (roadmap "Demo target chain" steps 4 and 5; design P6 §14 step 4), AI off, against a private
copy of the shop on a free port with `DEMO_VERSION_FILE` (the shared one on :4100 is never touched). The Phase 4
chain runs on release 1 up to DEF-0001 confirmed at G8; the version file flips to 2 and a rescan writes CHG-0001, its
impact and, before any test fails, the repair suggestions.

Checks: HEAL-0001 offers `getByLabel('Your message')` and HEAL-0002 `getByRole('button', { name: 'Send' })`, both
High with the signal "Same field, renamed (CHG-0001)", one verified match and an outlined screenshot each. The
regression run is refused while they are open. A member accepts each, one at a time: every accept changes exactly
one line of ContactPage.ts, the spec files stay byte-identical, the G6 checks run by themselves and the Contact
scripts are valid again; the repair impact items close. The regression run then waits for G7 and touches nothing;
once authorised, the empty-Message case passes on release 2 ("Your message" is now required, and its field check
follows the repaired page-object locator, D36), its re-run items close, and DEF-0001 can be marked fixed and then
verified. Nothing is posted to the shop by the repairs.
"""

from __future__ import annotations

import hashlib
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


async def test_demo_chain_repairs_then_the_regression_run(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    version = tmp_path / "demo-version"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version))
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    try:
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p6-repairs-demo.example.com", org="P6 Repairs Demo")
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
            member = await _user(ctx, c, owner.org_id, "member@p6-repairs-demo.example.com", Role.member)
            approver = await _user(ctx, c, owner.org_id, "approver@p6-repairs-demo.example.com", Role.member, True)
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
            # A genuine bug in both releases (QA P6-04 R2): the shop accepts a Name of only spaces. DEF-0002 on v1.
            spaces = next(x for x in cases if "Name" in x["title"] and "spaces" in x["title"].lower())
            req = await c.post(f"{API}/projects/{pid}/execution-runs", headers=member,
                               json={"selection": {"case_keys": [spaces["key"]]}})  # fmt: skip
            assert req.status_code == 201, req.text
            ok = await c.post(f"{API}/execution-runs/{req.json()['id']}/authorise", headers=approver,
                              json={"decision": "approve"})  # fmt: skip
            assert ok.status_code == 200, ok.text
            await idle(timeout=600)
            run = (await c.get(f"{API}/execution-runs/{req.json()['id']}", headers=h)).json()
            res = (await c.get(f"{API}/execution-results/{run['tests_rows'][0]['id']}", headers=h)).json()
            assert res["defect"] and res["defect"]["key"] == "DEF-0002", (res["error"], res.get("analysis"))
            spaces_defect = res["defect"]["id"]
            yes = await c.post(f"{API}/defects/{spaces_defect}/status", headers=approver, json={"action": "confirm"})
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

            # Step 4: a member accepts each suggestion, one at a time.
            specs_before, assets_before = await code()
            contact = "pages/ContactPage.ts"
            for sug in sorted(
                (i for i in listing["items"] if i["kind"] == "locator" and i["status"] == "open"
                 and any((u["path"] or "").startswith("tests/contact/") for u in i["used_by"])),
                key=lambda i: i["key"],
            ):  # fmt: skip
                _specs, assets_now = await code()
                acc = await c.post(f"{API}/heal-suggestions/{sug['id']}/accept", headers=member, json={"index": 0})
                assert acc.status_code == 200, (
                    acc.text,
                    sug["old_expression"],
                    sug["candidates"],
                    sug["no_candidate_reason"],
                )
                body = acc.json()
                assert body["suggestion"]["status"] == "accepted" and body["suggestion"]["accepted_index"] == 0
                again = await c.post(f"{API}/heal-suggestions/{sug['id']}/accept", headers=member, json={"index": 0})
                assert again.status_code == 409 and "already decided by" in again.text
                _specs, assets_after = await code()
                path = body["asset"]["path"]
                before_lines, after_lines = assets_now[path].splitlines(), assets_after[path].splitlines()
                assert len(before_lines) == len(after_lines)
                changed = [i for i, (a, b) in enumerate(zip(before_lines, after_lines, strict=True)) if a != b]
                assert len(changed) == 1, changed  # exactly one changed line per accept
                await idle(timeout=600)
            specs_after, assets_after = await code()
            assert specs_after == specs_before  # the spec files (and their checks) are byte-identical
            assert 'getByLabel("Your message")' in assets_after[contact]
            assert 'getByRole("button", { name: "Send" })' in assets_after[contact]
            assert assets_after[contact].count("\n") == assets_before[contact].count("\n")

            # G6 ran by itself: the Contact scripts are valid again and the repair items closed.
            auto = (await c.get(f"{API}/projects/{pid}/automation", headers=h)).json()
            states = {
                x["path"]: x["status"] for x in auto["bundle"]["scripts"] if x["path"].startswith("tests/contact/")
            }
            assert states and all(st == "valid" for st in states.values()), states
            impact = (await c.get(f"{API}/change-sets/{chg['id']}/impact?target_kind=automation_script",
                                  headers=h)).json()["items"]  # fmt: skip
            contact_items = [i for i in impact if (i["target"]["path"] or "").startswith("tests/contact/")]
            assert contact_items and all(i["status"] == "resolved" for i in contact_items), contact_items
            h1_now = (await c.get(f"{API}/heal-suggestions/{h1['id']}", headers=h)).json()
            assert h1_now["checking"]["state"] == "valid", h1_now["checking"]

            # Step 5: the regression run waits for G7; the empty-Message case passes; DEF-0001 fixed, then verified.
            # Its check finds the field through the repaired page-object locator (D36): nothing it checks changed.
            rec = (await c.get(f"{API}/change-sets/{chg['id']}/regression-recommendation", headers=h)).json()
            assert rec["blocked"] is None, rec["blocked"]
            # D28 (QA P6-04 R2): a case whose script follows the link to the removed /products/1 has nothing to
            # accept or reject: it is Not included ("review or retire"), doesn't block, and its review stays open.
            gone = [i for i in (await c.get(f"{API}/projects/{pid}/heal-suggestions?change_set={chg['id']}",
                                            headers=h)).json()["items"]
                    if (i.get("review") or {}).get("reason") == "page_removed"]  # fmt: skip
            assert gone and all(i["status"] == "open" for i in gone), gone
            excluded = {p["key"]: p for p in rec["excluded"]}
            listed = [p["key"] for p in [*rec["must"], *rec["should"]]]
            for i in gone:
                for u in i["used_by"]:
                    assert u["case_key"] not in listed, (u, listed)
                    why = excluded[u["case_key"]]["not_runnable_reason"]
                    assert why.startswith("Page removed: review or retire the case") and i["key"] in why, why
            fixed = await c.post(f"{API}/defects/{defect_id}/status", headers=member, json={"action": "fixed"})
            assert fixed.status_code == 200, fixed.text
            reg = await c.post(f"{API}/change-sets/{chg['id']}/regression-run", headers=member,
                               json={"include_should": False})  # fmt: skip
            assert reg.status_code == 201, reg.text
            assert reg.json()["status"] == "awaiting_authorisation"
            ok = await c.post(f"{API}/execution-runs/{reg.json()['id']}/authorise", headers=approver,
                              json={"decision": "approve"})  # fmt: skip
            assert ok.status_code == 200, ok.text
            await idle(timeout=900)
            done = (await c.get(f"{API}/execution-runs/{reg.json()['id']}", headers=h)).json()
            rows = {t["case_key"]: t for t in done["tests_rows"]}
            if rows[empty["key"]]["status"] != "passed":
                bad = (await c.get(f"{API}/execution-results/{rows[empty['key']]['id']}", headers=h)).json()
                raise AssertionError((bad["error"], bad["page_state"], bad.get("analysis"), bad.get("repairs")))
            items = (await c.get(f"{API}/change-sets/{chg['id']}/impact", headers=h)).json()["items"]
            tc = next(i for i in items if i["target_kind"] == "test_case" and i["target"]["key"] == empty["key"])
            assert tc["status"] == "resolved" and tc["resolved_by_run"]["id"] == reg.json()["id"]
            # The whitespace-Name case still fails on v2: its failed check doesn't go through a repaired element and
            # the page shows the confirmation, so it stays an application defect, linked again to DEF-0002, with the
            # repair and the page change listed as context (QA P6-04 R2).
            assert rows[spaces["key"]]["status"] == "failed", rows[spaces["key"]]
            again = (await c.get(f"{API}/execution-results/{rows[spaces['key']]['id']}", headers=h)).json()
            assert again["analysis"]["classification"] == "application_defect", again["analysis"]
            assert again["defect"] and again["defect"]["key"] == "DEF-0002", again["defect"]
            codes = [x["code"] for x in again["analysis"]["signals"]]
            assert "repair_context" in codes and "page_changed" in codes, again["analysis"]["signals"]
            verified = await c.post(f"{API}/defects/{defect_id}/status", headers=approver, json={"action": "verified"})
            assert verified.status_code == 200, verified.text
            assert verified.json()["defect"]["status"] == "verified", verified.json()
            # No review was written for the renamed field: its check follows the locator (D36).
            listing = (await c.get(f"{API}/projects/{pid}/heal-suggestions?change_set={chg['id']}", headers=h)).json()
            assert not [
                i for i in listing["items"]
                if i["kind"] == "expected_result_review" and i["review"]["case_key"] == empty["key"]
            ], listing["items"]  # fmt: skip
    finally:
        shop.stop()
        await ctx.close()
