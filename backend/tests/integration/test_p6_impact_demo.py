"""P6-02 on the demo shop (roadmap "Demo target chain" step 3, design P6 §7), AI off, against a private copy of the shop
started on a free port with `DEMO_VERSION_FILE` (the shared one on :4100 is never touched). The Phase 4 chain runs on
release 1 up to DEF-0001 confirmed at G8; an accessibility finding and a load-test profile on /products/1 are added
(as P5 would have left them); the version file flips to 2 and a rescan writes CHG-0001 and its impact.

Checks: the Contact requirement and the Contact cases are direct; the Contact scripts are outdated, naming
getByLabel('Message') and the "Send message" button; DEF-0001 is to re-test with its case; /products/1's case, finding
and load-test target are "Page removed: review" (the profile is marked out of date); /offers and the Promo code form
are not covered by any requirement; must-run is the direct Contact cases plus DEF-0001's case, and the run request is
refused while their scripts are outdated. Nothing is posted to the shop by any of it.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app.context import build_context
from app.db.models import AutomationScript, PerformanceProfile, QualityFinding, QualityScan
from app.db.tenant import BYPASS
from app.domain.enums import (
    FindingSeverity,
    PerfProfileStatus,
    QualityScanKind,
    QualityScanStatus,
    Role,
    ScriptStatus,
)
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


async def test_demo_chain_impact_and_regression(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    version = tmp_path / "demo-version"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version))
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    try:
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p6-impact-demo.example.com", org="P6 Impact Demo")
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

            r = await c.post(f"{API}/projects", headers=h, json={
                "url": shop.base, "name": "Demo shop", "start": True,
                "authorisation": {"attested": True, "statement": "Private demo shop run by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            pid = r.json()["id"]
            await idle(timeout=600)
            await gate("G2", "discovery", h)

            # Phase 4 (design P4 §15): requirements, strategy and cases approved; G6 passes; DEF-0001 confirmed.
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
            member = await _user(ctx, c, owner.org_id, "member@p6-impact-demo.example.com", Role.member)
            approver = await _user(ctx, c, owner.org_id, "approver@p6-impact-demo.example.com", Role.member, True)
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
            yes = await c.post(f"{API}/defects/{res['defect']['id']}/status", headers=approver,
                               json={"action": "confirm"})  # fmt: skip
            assert yes.status_code == 200, yes.text
            auto_stage = (await stage("automation"))["status"]

            # What P5 would have left on /products/1: an open accessibility finding and a load-test profile.
            async with ctx.session_factory() as s:
                org = owner.org_id
                scan = QualityScan(organisation_id=org, project_id=uuid.UUID(pid), key="A11Y-0001",
                                   kind=QualityScanKind.accessibility, status=QualityScanStatus.completed)  # fmt: skip
                s.add(scan)
                await s.flush()
                s.add(QualityFinding(organisation_id=org, project_id=uuid.UUID(pid), key="A11Y-0001-01", scan_id=scan.id,
                                     kind=QualityScanKind.accessibility, rule_id="image-alt",
                                     severity=FindingSeverity.serious, title="Images must have a text alternative",
                                     url=f"{shop.base}/products/1", fingerprint="f" * 64))  # fmt: skip
                prof = PerformanceProfile(organisation_id=org, project_id=uuid.UUID(pid), key="PRF-01", name="Browse",
                                          max_rps=5, status=PerfProfileStatus.ready,
                                          targets=[{"path": "/products/1", "weight": 1}, {"path": "/", "weight": 1}])  # fmt: skip
                s.add(prof)
                await s.commit()
                prof_id = prof.id

            # Release 2 and the rescan (demo chain step 2); its change analysis writes the impact (step 3).
            version.write_text("2\n")
            r = await c.post(f"{API}/projects/{pid}/rescans", json={}, headers=member)
            assert r.status_code == 202, r.text
            await idle(timeout=600)
            [chg] = (await c.get(f"{API}/projects/{pid}/changes", headers=h)).json()["items"]
            assert chg["key"] == "CHG-0001" and chg["status"] == "completed"
            view = (await c.get(f"{API}/change-sets/{chg['id']}/impact", headers=h)).json()
            items: list[dict[str, Any]] = view["items"]

            def keyed(kind: str) -> dict[str, dict[str, Any]]:
                return {(i["target"] or {}).get("key") or i["target_ref"]: i for i in items if i["target_kind"] == kind}

            # Requirements: Contact is direct.
            reqs_by = keyed("requirement")
            contact = [i for i in reqs_by.values() if i["level"] == "direct"]
            assert contact and all("/contact" in i["reason"] for i in contact), reqs_by
            # Contact cases: direct, re-run.
            tcs = keyed("test_case")
            assert tcs[empty["key"]]["level"] == "direct" and tcs[empty["key"]]["action"] == "rerun"
            assert 'field "Message" changed' in tcs[empty["key"]]["reason"]
            direct_contact = {k for k, i in tcs.items() if i["level"] == "direct"}
            # Scripts outdated, naming the locators.
            async with ctx.session_factory() as s:
                rows = (
                    await s.execute(
                        select(AutomationScript)
                        .where(AutomationScript.project_id == uuid.UUID(pid))
                        .execution_options(**BYPASS)
                    )
                ).scalars()
                scripts = {r.path: r for r in rows}
            outdated = {p: r.outdated_reason or "" for p, r in scripts.items() if r.status == ScriptStatus.outdated}
            assert f"tests/contact/{empty['key']}.spec.ts" in outdated, sorted(outdated)
            reasons = " ".join(outdated.values())
            assert "getByLabel('Message') not found after CHG-0001" in reasons, outdated
            assert "'Send message'" in reasons and "not found after CHG-0001" in reasons, outdated
            # Besides Contact, only a script that follows the removed Travel mug link.
            others = {p: r for p, r in outdated.items() if not p.startswith("tests/contact/")}
            assert all(r == "locator('a[href=\"/products/1\"]') not found after CHG-0001" for r in others.values()), (
                others
            )
            assert (await stage("automation"))["status"] == auto_stage  # D27
            # DEF-0001: re-test with its case.
            [defect] = keyed("defect").values()
            assert defect["reason"] == f"May be fixed or changed by CHG-0001: re-test. Re-tested by {empty['key']}."
            # Page removed: review.
            removed = [i for i in items if i["group"] == "page_removed"]
            assert {i["target_kind"] for i in removed} >= {"quality_finding", "performance_target"}, removed
            assert all(i["page"] == "/products/1" and i["action"] == "review" for i in removed), removed
            mug = [i for i in removed if i["target_kind"] == "test_case"]
            assert all(i["reason"].startswith("Page removed: /products/1. Review or retire TC-") for i in mug), mug
            async with ctx.session_factory() as s:
                p = (
                    await s.execute(
                        select(PerformanceProfile).where(PerformanceProfile.id == prof_id).execution_options(**BYPASS)
                    )
                ).scalar_one()
                assert (
                    p.status == PerfProfileStatus.stale and p.stale_reason == "Page /products/1 was removed (CHG-0001)"
                )
            # Gaps.
            gaps = sorted(i["reason"] for i in items if i["level"] == "gap")
            assert gaps == [
                'Not covered by any requirement: form "Promo code" added on /offers',
                "Not covered by any requirement: page /offers added",
            ], gaps
            # Regression: must = direct Contact cases + DEF-0001's case; refused while their scripts are outdated.
            rec = (await c.get(f"{API}/change-sets/{chg['id']}/regression-recommendation", headers=h)).json()
            must = {x["key"]: x for x in rec["must"]}
            assert set(must) == direct_contact | {empty["key"]}, (sorted(must), sorted(direct_contact))
            assert must[empty["key"]]["reasons"][-1] == "Re-tests DEF-0001"
            assert {x["key"] for x in rec["excluded"]} >= {i["target"]["key"] for i in mug}
            assert rec["blocked"]["message"].endswith("Accept or reject their repair suggestions first.")
            no = await c.post(f"{API}/change-sets/{chg['id']}/regression-run", headers=member, json={})
            assert no.status_code == 422 and empty["key"] in no.text, no.text
            assert view["counts"]["by_level"]["direct"] >= len(contact) + len(direct_contact)
    finally:
        shop.stop()
        await ctx.close()
