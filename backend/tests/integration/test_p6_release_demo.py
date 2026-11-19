"""P6-05a on the demo shop (roadmap "Demo target chain" step 6; decisions D32, D33), AI off, against a private copy of
the shop on a free port with `DEMO_VERSION_FILE` (the shared one on :4100 is never touched).

Release 1: the Phase 4 chain up to DEF-0001 (major) confirmed at G8, plus the whitespace-Name bug (DEF-0002, major)
confirmed at G8. REL-0001 recommends No-go, naming both, and an approver makes it final. Release 2 (which also fixes the
whitespace Name): the rescan (CHG-0001), the repairs accepted, the regression run (G7) with both defects' cases as
must-run, both passing, so DEF-0001 and DEF-0002 are fixed and verified; the manual must-run tests re-tested by hand and
recorded (D37); the sign-in tests of the very high risk the first assessment named, run with the shop's test account.
REL-0002 recommends Conditional with every blocking criterion met; its conditions are the genuine ones (the open "page
removed" review items (D27, D28), no exploration, no non-functional checks, the remaining acceptance criteria). "The
conditions name the minor exploratory defect" waits for P6-03a/P6-08 (roadmap demo chain). A further run makes REL-0002
stale (decision 409); REL-0003 replaces it and is approved.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

import pytest

from app.context import build_context
from app.domain.enums import Role
from app.llm.base import DisabledLLM
from tests.conftest import client_for, make_settings, register, worker_for
from tests.integration.test_p4_automation import _user
from tests.integration.test_p6_demo_shop import Shop, _demo_login
from tests.integration.test_p6_repairs_demo import EXPECTED

API = "/api/v1"
BLOCKING = {"exit.no_open_high_defects", "rr.impacted_rerun", "rr.high_risk_tested", "rr.g8_pending"}
pytestmark = [
    pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed"),
    pytest.mark.skipif(
        not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
        reason="the automation toolkit's dependencies are not installed",
    ),
]


def _crit(a: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in a["criteria"]}


def _dump(a: dict[str, Any]) -> list[tuple[str, str, str]]:
    return [(c["id"], c["status"], c["detail"]) for c in a["criteria"] if c["status"] != "met"]


async def test_demo_chain_no_go_then_conditional(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    version = tmp_path / "demo-version"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version))
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    try:
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p6-release-demo.example.com", org="P6 Release Demo")
            h = owner.headers
            idle = worker_for(ctx).run_until_idle

            async def stage(key: str) -> dict[str, Any]:
                wf = (await c.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
                return dict(next(s for s in wf["stages"] if s["key"] == key))

            async def gate(g: str, key: str) -> None:
                st = await stage(key)
                d = await c.post(f"{API}/projects/{pid}/gates/{g}/decision", headers=h,
                                 json={"decision": "approve", "comment": "ok", "stage_run_version": st["current_version"]})  # fmt: skip
                assert d.status_code == 200, d.text
                await idle(timeout=600)

            async def run_cases(keys: list[str]) -> dict[str, dict[str, Any]]:
                req = await c.post(f"{API}/projects/{pid}/execution-runs", headers=member,
                                   json={"selection": {"case_keys": keys}})  # fmt: skip
                assert req.status_code == 201, req.text
                ok = await c.post(f"{API}/execution-runs/{req.json()['id']}/authorise", headers=approver,
                                  json={"decision": "approve"})  # fmt: skip
                assert ok.status_code == 200, ok.text
                await idle(timeout=900)
                run = (await c.get(f"{API}/execution-runs/{req.json()['id']}", headers=h)).json()
                return {t["case_key"]: t for t in run["tests_rows"]}

            async def assess() -> dict[str, Any]:
                r = await c.post(f"{API}/projects/{pid}/release-assessments", headers=member, json={})
                assert r.status_code == 202, r.text
                await idle(timeout=600)
                body = (await c.get(f"{API}/projects/{pid}/release-readiness", headers=h)).json()
                assert not body["assessing"], body["stage"]
                return dict(body["latest"])

            r = await c.post(f"{API}/projects", headers=h, json={
                "url": shop.base, "name": "Demo shop", "start": True,
                "authorisation": {"attested": True, "statement": "Private demo shop run by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            pid = r.json()["id"]
            await idle(timeout=600)
            await gate("G2", "discovery")
            reqs = (await c.get(f"{API}/projects/{pid}/requirements?limit=100", headers=h)).json()["items"]
            assert (await c.post(f"{API}/projects/{pid}/requirements/bulk-status", headers=h, json={
                "ids": [x["id"] for x in reqs if x["status"] == "draft"], "status": "approved"})).status_code == 200  # fmt: skip
            await gate("G3", "requirements")
            await gate("G4", "test_strategy")
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
            await gate("G5", "test_design")
            member = await _user(ctx, c, owner.org_id, "member@p6-release-demo.example.com", Role.member)
            approver = await _user(ctx, c, owner.org_id, "approver@p6-release-demo.example.com", Role.member, True)

            # Nothing can be assessed before a run has finished.
            no = await c.post(f"{API}/projects/{pid}/release-assessments", headers=member, json={})
            assert no.status_code == 409 and "Run the tests first" in no.text, no.text

            # Release 1: DEF-0001 (major) and DEF-0002 (the whitespace Name, major), both confirmed at G8.
            rows = await run_cases([empty["key"]])
            res = (await c.get(f"{API}/execution-results/{rows[empty['key']]['id']}", headers=h)).json()
            assert res["defect"]["key"] == "DEF-0001", res["defect"]
            def1 = res["defect"]["id"]
            assert (await c.post(f"{API}/defects/{def1}/status", headers=approver,
                                 json={"action": "confirm"})).status_code == 200  # fmt: skip
            spaces = next(x for x in cases if "Name" in x["title"] and "spaces" in x["title"].lower())
            rows = await run_cases([spaces["key"]])
            res = (await c.get(f"{API}/execution-results/{rows[spaces['key']]['id']}", headers=h)).json()
            assert res["defect"] and res["defect"]["key"] == "DEF-0002", (res["error"], res.get("analysis"))
            def2 = res["defect"]["id"]
            assert (await c.get(f"{API}/defects/{def2}", headers=h)).json()["severity"] == "major"
            assert (await c.post(f"{API}/defects/{def2}/status", headers=approver,
                                 json={"action": "confirm"})).status_code == 200  # fmt: skip

            # REL-0001: No-go, naming DEF-0001; an approver makes it final.
            a1 = await assess()
            assert a1["key"] == "REL-0001" and a1["recommendation"] == "no_go", _dump(a1)
            c1 = _crit(a1)
            assert c1["exit.no_open_high_defects"]["status"] == "not_met"
            assert "DEF-0001" in c1["exit.no_open_high_defects"]["detail"], c1["exit.no_open_high_defects"]
            assert "there are 2 open critical or major defects (DEF-0001, DEF-0002)" in a1["reason"], a1["reason"]
            assert a1["conditions_list"][0]["text"] == "Fix or accept DEF-0001 (major)", a1["conditions_list"]
            assert a1["conditions_list"][1]["text"] == "Fix or accept DEF-0002 (major)", a1["conditions_list"]
            ok = await c.post(f"{API}/release-assessments/{a1['id']}/decision", headers=approver,
                              json={"decision": "approve"})  # fmt: skip
            assert ok.status_code == 200 and ok.json()["assessment"]["final_verdict"] == "no_go", ok.text
            high_risk_cases = sorted(set(re.findall(r"TC-\d{4}", c1["rr.high_risk_tested"]["detail"])))  # fmt: skip

            # Release 2: rescan, the repairs accepted, the regression run, DEF-0001 fixed and verified.
            version.write_text("2\n")
            r = await c.post(f"{API}/projects/{pid}/rescans", json={}, headers=member)
            assert r.status_code == 202, r.text
            await idle(timeout=600)
            [chg] = (await c.get(f"{API}/projects/{pid}/changes", headers=h)).json()["items"]
            listing = (await c.get(f"{API}/projects/{pid}/heal-suggestions?change_set={chg['id']}", headers=h)).json()
            for sug in sorted(
                (i for i in listing["items"] if i["kind"] == "locator" and i["status"] == "open"
                 and any((u["path"] or "").startswith("tests/contact/") for u in i["used_by"])),
                key=lambda i: i["key"],
            ):  # fmt: skip
                acc = await c.post(f"{API}/heal-suggestions/{sug['id']}/accept", headers=member, json={"index": 0})
                assert acc.status_code == 200, acc.text
                await idle(timeout=600)
            gone = [i for i in (await c.get(f"{API}/projects/{pid}/heal-suggestions?change_set={chg['id']}",
                                            headers=h)).json()["items"]
                    if (i.get("review") or {}).get("reason") == "page_removed" and i["status"] == "open"]  # fmt: skip
            assert gone, "the removed product page leaves cases to review"
            for d_id in (def1, def2):
                assert (await c.post(f"{API}/defects/{d_id}/status", headers=member,
                                     json={"action": "fixed"})).status_code == 200  # fmt: skip
            rec = (await c.get(f"{API}/change-sets/{chg['id']}/regression-recommendation", headers=h)).json()
            must = {p["key"]: p for p in rec["must"]}
            assert "Re-tests DEF-0002" in must[spaces["key"]]["reasons"], must.get(spaces["key"])
            reg = await c.post(f"{API}/change-sets/{chg['id']}/regression-run", headers=member,
                               json={"include_should": False})  # fmt: skip
            assert reg.status_code == 201, reg.text
            ok = await c.post(f"{API}/execution-runs/{reg.json()['id']}/authorise", headers=approver,
                              json={"decision": "approve"})  # fmt: skip
            assert ok.status_code == 200, ok.text
            await idle(timeout=900)
            done = (await c.get(f"{API}/execution-runs/{reg.json()['id']}", headers=h)).json()
            rows = {t["case_key"]: t for t in done["tests_rows"]}
            assert rows[empty["key"]]["status"] == "passed", rows[empty["key"]]
            assert rows[spaces["key"]]["status"] == "passed", rows[spaces["key"]]  # release 2 fixed it
            for d_id in (def1, def2):
                verified = await c.post(f"{API}/defects/{d_id}/status", headers=approver, json={"action": "verified"})
                assert verified.status_code == 200, verified.text
            # The high risks REL-0001 named get a passing test (sign-in, browsing: release 2 changes neither).
            # They sign in: the owner saves the shop's test account (never printed; read from demo-login.mjs).
            email, password, _token = _demo_login()
            saved = await c.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=h,
                                json={"login_url": f"{shop.base.rstrip('/')}/login", "username": email,
                                      "password": password})  # fmt: skip
            assert saved.status_code in (200, 201), saved.status_code
            assert high_risk_cases, c1["rr.high_risk_tested"]
            hr = await run_cases(high_risk_cases)
            assert any(x["status"] == "passed" for x in hr.values()), hr

            # D37: the manual must-run tests are re-tested by hand and recorded (the platform can't run them).
            manual = (await c.get(f"{API}/change-sets/{chg['id']}/manual-retests", headers=h)).json()
            assert manual["items"] and manual["counts"]["recorded"] == 0, manual
            for item in manual["items"]:
                rec = await c.post(f"{API}/change-sets/{chg['id']}/manual-retests", headers=member, json={
                    "case_key": item["case_key"], "status": "passed",
                    "note": "Followed the steps on release 2: the expected result is shown"})  # fmt: skip
                assert rec.status_code == 201, rec.text

            # REL-0002: Conditional, every blocking criterion met, on the genuine conditions.
            a2 = await assess()
            c2 = _crit(a2)
            assert a2["key"] == "REL-0002" and a2["recommendation"] == "conditional", _dump(a2)
            assert [k for k in sorted(BLOCKING) if c2[k]["status"] != "met"] == [], _dump(a2)
            assert c2["rr.open_defects"]["status"] == "met", c2["rr.open_defects"]
            conds = [x["text"] for x in a2["conditions_list"]]
            assert "Run an exploratory session" in conds and "Run an accessibility check" in conds, conds
            assert c2["rr.impact_reviewed"]["status"] == "not_met", c2["rr.impact_reviewed"]
            refs = {r["key"] for r in c2["rr.impact_reviewed"]["evidence_refs"]}
            for item in gone:  # "Test case needs review" (the removed /products/1 page) stays open: a condition
                case = item["review"]["case_key"]
                assert item["key"] in refs, (item["key"], refs)
                assert f"Review {case}: test case needs review ({item['key']}) (CHG-0001)" in conds, conds
            assert "Page removed: /products/1. Review or retire TC-0033 (CHG-0001)" in conds, conds
            # The recorded manual re-tests count: impacted tests re-run is met.
            assert c2["rr.impacted_rerun"]["status"] == "met", c2["rr.impacted_rerun"]
            assert "Re-tested by hand: " in c2["rr.impacted_rerun"]["detail"], c2["rr.impacted_rerun"]
            assert a2["changes_since"]["previous"]["key"] == "REL-0001"
            assert a2["changes_since"]["recommendation"] == {"from": "no_go", "to": "conditional"}

            # A new run after the assessment: stale, its decision is refused, REL-0003 replaces it.
            await run_cases([empty["key"]])
            stale = (await c.get(f"{API}/release-assessments/{a2['id']}", headers=h)).json()
            assert stale["status"] == "stale" and stale["stale_reason"].endswith("UTC"), stale["stale_reason"]
            no = await c.post(f"{API}/release-assessments/{a2['id']}/decision", headers=approver,
                              json={"decision": "approve"})  # fmt: skip
            assert no.status_code == 409, no.text
            a3 = await assess()
            assert a3["key"] == "REL-0003" and a3["recommendation"] == "conditional", _dump(a3)
            ok = await c.post(f"{API}/release-assessments/{a3['id']}/decision", headers=approver,
                              json={"decision": "approve"})  # fmt: skip
            assert ok.status_code == 200 and ok.json()["message"] == "REL-0003: Conditional is final.", ok.text
            hist = (await c.get(f"{API}/projects/{pid}/release-readiness", headers=h)).json()["history"]
            assert [(x["key"], x["status"]) for x in hist] == [
                ("REL-0003", "final"),
                ("REL-0002", "superseded"),
                ("REL-0001", "final"),
            ]

            # P6-05c (design P6 §14 step 8): both reports. Each assessment's latest Release Readiness Report equals it;
            # REL-0002's (replaced) is no longer current; the Test Completion Report's counts equal the coverage API.
            await idle(timeout=600)
            reps = sorted((await c.get(f"{API}/projects/{pid}/reports", headers=h)).json(), key=lambda r: r["version"])
            rr = {r["run_key"]: r for r in reps if r["report_type"] == "release_readiness"}  # the latest per assessment
            assert set(rr) == {"REL-0001", "REL-0002", "REL-0003"} and all(r["status"] == "ready" for r in rr.values())
            assert rr["REL-0002"]["is_latest_source"] is False
            assert (
                rr["REL-0002"]["approval"]["band"] == "DRAFT: REL-0002 was replaced by REL-0003 and can't be decided."
            )
            r1 = (await c.get(f"{API}/reports/{rr['REL-0001']['id']}", headers=h)).json()["content"]
            assert r1["verdict_text"] == "No-go · Final" and r1["band"] is None
            assert r1["decision_line"].startswith("Decided by Team Mate, ")
            r3 = (await c.get(f"{API}/reports/{rr['REL-0003']['id']}", headers=h)).json()["content"]
            assert r3["verdict_text"] == "Conditional · Final" and r3["band"] is None
            assert [x["text"] for x in r3["conditions"]] == [x["text"] for x in a3["conditions_list"]]
            gen = await c.post(f"{API}/projects/{pid}/reports", headers=member,
                               json={"report_type": "completion", "run_key": "REL-0003"})  # fmt: skip
            assert gen.status_code == 202, gen.text
            await idle(timeout=600)
            done = (await c.get(f"{API}/reports/{gen.json()['id']}", headers=h)).json()
            assert done["status"] == "ready", done["error"]
            cov = (await c.get(f"{API}/projects/{pid}/traceability/coverage?basis=approved", headers=h)).json()
            total = done["content"]["measures"]["total"]
            res = cov["execution"]["results"]
            assert (total["passed"], total["failed"]) == (res["passed"], res["failed"]), (total, res)
            assert done["content"]["exploratory"]["empty"] == "No exploratory session has run."
            for f in ("html", "csv", "json"):
                body = await c.get(f"{API}/reports/{gen.json()['id']}/download?format={f}", headers=h,
                                   follow_redirects=True)  # fmt: skip
                assert body.status_code == 200 and "@p6-release-demo.example.com" not in body.text
    finally:
        shop.stop()
        await ctx.close()
