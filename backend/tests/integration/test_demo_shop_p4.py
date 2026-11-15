"""Phase 4 on the real demo shop (http://localhost:4100), AI off (design P4 §15): after G5 the empty-Message case
(expected: "Submission is blocked and Message is identified as required") can be automated, its rules script is
valid and checks the blocked submission and the flagged Message field, the ContactPage locators are each found once,
sign-in cases need test credentials, G6 passes automatically, and the run scope says the case "May submit the Contact
us form (if the application does not block it)". Then the end-to-end chain: a member requests the run, an approver
authorises it (G7), the script fails on both attempts because the shop says "Thank you", the analysis calls it a
"Likely bug in the application", DEF-0001 is drafted, a member can't confirm it and the approver confirms it (G8).
The run submits the shop's contact form (that is the bug being demonstrated); nothing else is posted.

Start the shop first: `cd demo-shop && npm start`. Skipped when it is not running.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.context import AppContext
from app.domain.enums import Role
from tests.conftest import client_for, register, worker_for
from tests.integration.test_p4_automation import _user

# DEMO_SHOP_URL runs the same checks against another copy of the shop (P5-00 used it to prove the flaws change
# nothing for Phases 1–4 before the shared :4100 instance was restarted).
DEMO = os.environ.get("DEMO_SHOP_URL", "http://localhost:4100")
API = "/api/v1"
EXPECTED = "Submission is blocked and Message is identified as required"
pytestmark = pytest.mark.demo_shop


def _demo_running() -> bool:
    try:
        return httpx.get(DEMO, timeout=2).status_code < 500
    except httpx.HTTPError:
        return False


def _toolkit() -> bool:
    return (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir()


@pytest.mark.skipif(not _demo_running(), reason=f"demo shop is not running on {DEMO}")
@pytest.mark.skipif(not _toolkit(), reason="the automation toolkit's dependencies are not installed")
async def test_demo_shop_empty_message_case_is_automated(make_ctx, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(allow_private_targets=True)
    async with client_for(ctx) as c:
        acct = await register(c, org="Demo QA P4")
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
        ids = [x["id"] for x in reqs if x["status"] == "draft"]
        assert (await c.post(f"{API}/projects/{pid}/requirements/bulk-status", headers=h,
                             json={"ids": ids, "status": "approved"})).status_code == 200  # fmt: skip
        for gate, key in (("G3", "requirements"), ("G4", "test_strategy")):
            st = await stage(key)
            d = await c.post(f"{API}/projects/{pid}/gates/{gate}/decision", headers=h,
                             json={"decision": "approve", "comment": "ok", "stage_run_version": st["current_version"]})  # fmt: skip
            assert d.status_code == 200, d.text
            await worker_for(ctx).run_until_idle(timeout=600)
        oq = (await c.get(f"{API}/projects/{pid}/test-cases?limit=50&open_question=true", headers=h)).json()["items"]
        empty = next(x for x in oq if "empty Message" in x["title"])
        d = (await c.get(f"{API}/test-cases/{empty['id']}", headers=h)).json()
        w = await c.patch(f"{API}/test-cases/{d['id']}", headers=h,
                          json={"version": d["version"], "expected_result": EXPECTED})  # fmt: skip
        assert w.status_code == 200, w.text
        all_cases: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = (await c.get(f"{API}/projects/{pid}/test-cases?limit=100" + (f"&cursor={cursor}" if cursor else ""),
                                headers=h)).json()  # fmt: skip
            all_cases += page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                break
        bulk = await c.post(f"{API}/projects/{pid}/test-cases/bulk-status", headers=h,
                            json={"ids": [x["id"] for x in all_cases if x["status"] == "draft"], "status": "approved"})  # fmt: skip
        assert bulk.status_code == 200, bulk.text
        st = await stage("test_design")
        g5 = await c.post(f"{API}/projects/{pid}/gates/G5/decision", headers=h,
                          json={"decision": "approve", "comment": "Rule output reviewed",
                                "stage_run_version": st["current_version"]})  # fmt: skip
        assert g5.status_code == 200, g5.text
        await worker_for(ctx).run_until_idle(timeout=600)

        # §15 step 2: the empty-Message case can be automated; sign-in cases need test credentials.
        assessment = (await c.get(f"{API}/projects/{pid}/automation/assessment", headers=h)).json()
        by_key = {x["key"]: x for x in assessment["cases"]}
        assert by_key[empty["key"]]["suitability"] == "suitable", by_key[empty["key"]]
        signin = [x for x in assessment["cases"] if x["title"].lower().startswith("sign in")]
        with_account = [x for x in signin if "correct password" in x["title"]]
        assert with_account and all(x["suitability"] == "partial" for x in with_account), signin
        assert all(x["reasons"] == ["Needs saved test credentials (Project settings)"] for x in with_account)
        detail = (await c.get(f"{API}/test-cases/{empty['id']}", headers=h)).json()
        assert detail["automation_suitability"] == {
            "value": "suitable", "reason": "Every step and expected result can be scripted", "assessed": "assessed"
        }  # fmt: skip

        # §15 step 3: the script is valid, written by rules, and checks the blocked submission and the Message flag.
        auto = (await c.get(f"{API}/projects/{pid}/automation", headers=h)).json()
        row = next(x for x in auto["bundle"]["scripts"] if x["case_key"] == empty["key"])
        assert row["path"] == f"tests/contact/{empty['key']}.spec.ts" and row["status"] == "valid", row
        assert row["generated_by"] == "rules"
        script = (await c.get(f"{API}/automation-scripts/{row['id']}", headers=h)).json()
        assert "await qa.expectSubmissionBlocked(contact.form);" in script["code"]
        assert 'await qa.expectFieldFlagged("Message");' in script["code"]
        assert "waitForTimeout" not in script["code"] and "test.only" not in script["code"]
        helpers = [(m["helper"], m["args"]) for m in script["assertion_map"]]
        assert ("expectSubmissionBlocked", ["Contact us"]) in helpers, helpers
        assert ("expectFieldFlagged", ["Contact us", "Message"]) in helpers, helpers
        pom = next(a for a in auto["bundle"]["assets"] if a["path"] == "pages/ContactPage.ts")
        table = (await c.get(f"{API}/automation-assets/{pom['id']}", headers=h)).json()["locators"]
        found = {x["element"]: x["status"] for x in table}
        for element in ("Name", "Email", "Message", "Send message"):
            assert found.get(element) == "unique", found

        # §15 step 4: G6 passed automatically (rules only, nothing blocking).
        assert auto["g6"]["state"] == "passed_automatically", auto["g6"]
        assert (await stage("automation"))["status"] == "completed"

        # §15 step 5 (scope only): the negative case is in Regression (P4-BUG-01) and still "may submit" the form.
        assert "regression" in detail["suites"], detail["suites"]
        prev = await c.post(f"{API}/projects/{pid}/execution-runs/preview", headers=h,
                            json={"selection": {"suite": "regression"}})  # fmt: skip
        assert prev.status_code == 200, prev.text
        lines = prev.json()["side_effects"]
        may = [x for x in lines if x["kind"] == "may_submit"]
        assert may[0]["text"] == "May submit the Contact us form (if the application does not block it)", lines
        assert empty["key"] in may[0]["case_keys"]
        assert prev.json()["risky_line"] == "Pays, buys or deletes anything: no"
        # QA P4-BUG-07: no test account is saved, so nothing signs in; those tests are listed as blocked instead.
        blocked = [x for x in lines if x["kind"] == "blocked"]
        assert not [x for x in lines if x["kind"] == "signs_in"], lines
        assert blocked and blocked[0]["text"] == "Will be blocked: no saved test login", lines
        assert set(blocked[0]["case_keys"]) == {b["key"] for b in prev.json()["blocked"]}

        # §15 steps 5–8: request (member) → G7 (approver) → run → analysis → DEF draft → G8.
        member = await _user(ctx, c, acct.org_id, "member@demo-p4.example.com", Role.member)
        approver = await _user(ctx, c, acct.org_id, "approver@demo-p4.example.com", Role.member, True)
        req = await c.post(f"{API}/projects/{pid}/execution-runs", headers=member,
                           json={"selection": {"case_keys": [empty["key"]]}})  # fmt: skip
        assert req.status_code == 201, req.text
        run = req.json()
        assert run["status"] == "awaiting_authorisation" and run["permissions"]["can_authorise"] is False
        lines = [x["text"] for x in run["scope"]["side_effects"]]
        assert "May submit the Contact us form (if the application does not block it)" in lines
        ok = await c.post(f"{API}/execution-runs/{run['id']}/authorise", headers=approver, json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["status"] == "queued", ok.text
        await worker_for(ctx).run_until_idle(timeout=600)
        run = (await c.get(f"{API}/execution-runs/{run['id']}", headers=h)).json()
        assert run["status"] == "failed", run
        row = run["tests_rows"][0]
        assert row["status"] == "failed" and row["attempts"] == 2, row
        res = (await c.get(f"{API}/execution-results/{row['id']}", headers=h)).json()
        assert res["error"].startswith("QA_ASSERTION:") and "Thank you" in res["actual_result"], res["actual_result"]
        assert res["case"]["expected_result"] == EXPECTED
        assert {"screenshot", "video"} <= {e["kind"] for e in res["evidence"]}
        a = res["analysis"]
        assert a["label"] == "Likely bug in the application" and a["confidence"] in ("high", "medium"), a
        assert a["hypothesis"] is True and a["generated_by"] == "rules"
        assert {"assertion_failed_after_actions", "failed_every_attempt"} <= {s["code"] for s in a["signals"]}
        defect = res["defect"]
        assert defect["key"] == "DEF-0001" and defect["status"] == "draft", defect
        d = (await c.get(f"{API}/defects/{defect['id']}", headers=h)).json()
        assert d["summary"] == "Contact form accepts an empty Message", d["summary"]
        assert d["expected"] == EXPECTED and "Thank you" in d["actual"]
        assert d["environment"]["url"].rstrip("/") == DEMO and d["environment"]["browser"].startswith("Chromium")
        assert d["reproducibility"]["text"] == "2 of 2 attempts (always)"
        assert d["severity"] == "major" and d["root_cause_hypothesis"].startswith("Likely bug in the application")
        assert any("Message" in s for s in d["steps"]), d["steps"]
        no = await c.post(f"{API}/defects/{defect['id']}/status", headers=member, json={"action": "confirm"})
        assert no.status_code == 403
        yes = await c.post(f"{API}/defects/{defect['id']}/status", headers=approver, json={"action": "confirm"})
        assert yes.status_code == 200 and yes.json()["defect"]["status"] == "confirmed", yes.text
        assert (await stage("defects_summary"))["status"] == "completed"

        # P4-10 AC1 (QA P4-BUG-02): the exported project, run with its README command, fails the empty-Message case
        # with the same QA_ASSERTION as the platform, and the all-valid contact case passes.
        export = await c.get(f"{API}/projects/{pid}/automation/export", headers=h)
        assert export.status_code == 200, export.text
        exported = {x["case_key"] for x in auto["bundle"]["scripts"] if x["status"] == "valid"}
        accepted = [x["key"] for x in all_cases if x["key"] in exported and x["title"].endswith(": accepted")][:1]
        assert accepted, sorted(exported)
        # QA L2: with no test login set, a sign-in spec is skipped (the platform's "blocked"), not failed.
        signin = _sign_in_keys(export.content)[:1]
        assert signin, "the demo shop has sign-in cases"
        report = _run_export(export.content, tmp_path, [empty["key"], *accepted, *signin])
        outcome = {t: (st, err) for t, st, err in report}
        assert len(outcome) == 3, outcome
        assert outcome[empty["key"]][0] == "failed" and "QA_ASSERTION:" in outcome[empty["key"]][1], outcome
        assert all(outcome[k][0] == "passed" for k in accepted), outcome
        assert outcome[signin[0]][0] == "skipped", outcome


def _sign_in_keys(data: bytes) -> list[str]:
    import io
    import re
    import zipfile

    z = zipfile.ZipFile(io.BytesIO(data))
    return sorted(
        m.group(1)
        for n in z.namelist()
        if n.endswith(".spec.ts") and "process.env.TEST_USERNAME" in z.read(n).decode()
        for m in [re.search(r"(TC-\d+)\.spec\.ts$", n)]
        if m
    )


def _run_export(data: bytes, tmp: Path, keys: list[str]) -> list[tuple[str, str, str]]:
    """Unzips the export, links the toolkit's node_modules (no network install in tests) and runs the README command
    for the given cases; returns (case key, final status, error text) per test."""
    import io
    import json
    import os
    import re
    import subprocess
    import zipfile

    zipfile.ZipFile(io.BytesIO(data)).extractall(tmp)
    root = next(p for p in tmp.iterdir() if p.is_dir())
    (root / "node_modules").symlink_to(Path(__file__).resolve().parents[3] / "automation" / "node_modules")
    readme = (root / "README.md").read_text()
    command = re.search(r"```sh\n(?:.*\n)*?(.*npx playwright test)\n```", readme)
    assert command is not None, readme
    grep = "|".join(f"@{k}\\b" for k in keys)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ATA_", "PW_", "TEST_"))}
    proc = subprocess.run(  # noqa: S602 - the README's own command, run in a temporary folder
        f"{command.group(1)} --reporter=json --grep '{grep}'",
        shell=True, cwd=root, env=env, capture_output=True, text=True, timeout=300,
    )  # fmt: skip
    out = json.loads(proc.stdout)
    rows: list[tuple[str, str, str]] = []

    def walk(suite: dict[str, Any]) -> None:
        for spec in suite.get("specs", []):
            for t in spec.get("tests", []):
                last = t["results"][-1]
                key = next(
                    tag.lstrip("@") for tag in spec.get("tags", []) if tag.startswith("@TC-") or tag.startswith("TC-")
                )
                rows.append((key, last["status"], (last.get("error") or {}).get("message", "")))
        for child in suite.get("suites", []):
            walk(child)

    for suite in out.get("suites", []):
        walk(suite)
    assert len(rows) == len(keys), (rows, proc.stderr[-2000:])
    return rows
