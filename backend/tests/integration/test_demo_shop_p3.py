"""Phase 3 on the real demo shop (http://localhost:4100), AI off: G3 → G4 → automatic test design → G5. The deliberate
empty-Message bug gets a case whose expected result is an open question (decision D6), and DoR reports it. Every
approved requirement (including the HTTPS one linked to a high risk) gets a case, so the rule output plus the answer
to the open question is enough to approve G5.

Start the shop first: `cd api && npx tsx src/demo/target-app.ts`. Skipped when it is not running.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.context import AppContext
from tests.conftest import client_for, register, worker_for

DEMO = "http://localhost:4100"
API = "/api/v1"
pytestmark = pytest.mark.demo_shop


def _demo_running() -> bool:
    try:
        return httpx.get(DEMO, timeout=2).status_code < 500
    except httpx.HTTPError:
        return False


@pytest.mark.skipif(not _demo_running(), reason="demo shop is not running on http://localhost:4100")
async def test_demo_shop_design_has_the_empty_message_question(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(allow_private_targets=True)
    async with client_for(ctx) as c:
        acct = await register(c, org="Demo QA P3")
        h = acct.headers
        r = await c.post(f"{API}/projects", headers=h, json={
            "url": DEMO, "name": "Demo shop", "start": True,
            "authorisation": {"attested": True, "statement": "Local demo shop run by the test suite."},
            "scan": {"max_pages": 30, "max_depth": 3},
        })  # fmt: skip
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        await worker_for(ctx).run_until_idle(timeout=600)

        async def stage(key: str) -> dict[str, Any]:
            wf = (await c.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
            return dict(next(s for s in wf["stages"] if s["key"] == key))

        reqs = (await c.get(f"{API}/projects/{pid}/requirements?limit=100", headers=h)).json()["items"]
        ids = [x["id"] for x in reqs if x["status"] == "draft"]  # everything a person could approve, assumed too
        assert (await c.post(f"{API}/projects/{pid}/requirements/bulk-status", headers=h,
                             json={"ids": ids, "status": "approved"})).status_code == 200  # fmt: skip
        for gate, key in (("G3", "requirements"), ("G4", "test_strategy")):
            st = await stage(key)
            d = await c.post(f"{API}/projects/{pid}/gates/{gate}/decision", headers=h,
                             json={"decision": "approve", "comment": "ok", "stage_run_version": st["current_version"]})  # fmt: skip
            assert d.status_code == 200, d.text
            await worker_for(ctx).run_until_idle(timeout=600)
        st = await stage("test_design")
        assert st["status"] == "awaiting_approval", st
        cases = (await c.get(f"{API}/projects/{pid}/test-cases?limit=50&open_question=true", headers=h)).json()["items"]
        titles = [x["title"] for x in cases]
        assert any("empty Message" in t for t in titles), titles
        rc = (await c.get(f"{API}/projects/{pid}/readiness-criteria", headers=h)).json()
        dor = {(i["check"] or {}).get("rule_id"): i for i in rc["definition_of_ready"]}
        ev = dor["dor.test_data_identified"]["evaluation"]
        assert ev["status"] == "not_met" and "Message" in ev["detail"] and "open question" in ev["detail"], ev
        assert "Name" in ev["detail"] and "Email" in ev["detail"], ev

        # Every approved requirement has at least one designed case.
        cov = (await c.get(f"{API}/projects/{pid}/traceability/coverage", headers=h)).json()
        assert cov["requirements"]["with_case"] == cov["requirements"]["approved"], cov["requirements"]
        gaps = (await c.get(f"{API}/projects/{pid}/traceability/gaps", headers=h)).json()
        assert not gaps["requirements_without_test_cases"]["none"], gaps
        all_cases: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = (await c.get(f"{API}/projects/{pid}/test-cases?limit=100" + (f"&cursor={cursor}" if cursor else ""),
                                headers=h)).json()  # fmt: skip
            all_cases += page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                break
        # A 1-character email address can't be valid: the case expects it to be rejected (BUG-P3-06).
        for x in all_cases:
            if x["title"] == "Email with 1 character":
                d = (await c.get(f"{API}/test-cases/{x['id']}", headers=h)).json()
                assert "invalid email address" in d["expected_result"], d["expected_result"]
        # Answer the open question by writing the expected result, then approve every draft case and G5.
        oq = (await c.get(f"{API}/test-cases/{cases[0]['id']}", headers=h)).json()
        assert not oq["expected_result"].startswith("Not decided"), oq["expected_result"]  # the UI adds the prefix
        w = await c.patch(f"{API}/test-cases/{oq['id']}", headers=h, json={
            "version": oq["version"], "expected_result": "Submission is blocked and Message is identified as required",
        })  # fmt: skip
        assert w.status_code == 200, w.text
        drafts = [x["id"] for x in all_cases if x["status"] == "draft"]
        bulk = await c.post(f"{API}/projects/{pid}/test-cases/bulk-status", headers=h,
                            json={"ids": drafts, "status": "approved"})  # fmt: skip
        assert bulk.status_code == 200, bulk.text
        st = await stage("test_design")
        blocking = [p for p in st["gate"]["preconditions"] if p["blocking"] and not p["met"]]
        assert not blocking, (blocking, bulk.json().get("skipped"))
        g5 = await c.post(f"{API}/projects/{pid}/gates/G5/decision", headers=h,
                          json={"decision": "approve", "comment": "Rule output reviewed",
                                "stage_run_version": st["current_version"]})  # fmt: skip
        assert g5.status_code == 200, g5.text
        # "Generate more negative test cases" proposes real missing cases on the demo shop (P3-06 AC1).
        th = (await c.post(f"{API}/projects/{pid}/assistant/threads", headers=h, json={})).json()["id"]
        field_reqs = [x for x in reqs if x["status"] == "draft" and x["category"] in ("form_input", "validation")]
        asked = field_reqs[0]["key"] if field_reqs else reqs[0]["key"]
        msg = await c.post(f"{API}/assistant/threads/{th}/messages", headers=h,
                           json={"content": f"Generate more negative test cases for {asked}"})  # fmt: skip
        reply = msg.json()["reply"]
        assert reply["intent"] == "propose_negative_cases" and reply["proposals"], reply
        known = {x["title"] for x in all_cases}
        assert not known & {x["title"] for x in reply["proposals"][0]["preview"]}
