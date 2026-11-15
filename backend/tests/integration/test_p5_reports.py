"""P5-04a Performance, Accessibility and Security reports, and the Defect Report carry-over (G8 decider, sources).

Covers: 409 before any run or check; reports freeze when a check or load test finishes; numbers equal the API
(findings by rule, the security rule table, p95 per page, threshold results, request count); the Security Report
starts with the fixed statement; the approver's name and "host typed" are recorded; the time-series CSV; names only
(no email in any file); other organisations get 404; the Defect Report names the latest Gate 8 decider and splits
counts by source.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import httpx
import pytest
from markupsafe import escape
from openpyxl import load_workbook
from sqlalchemy import select

from app.context import AppContext
from app.db.models import Evidence
from app.db.tenant import BYPASS
from app.domain.enums import EvidenceKind
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.p5_site import P5Site, running_p5_site
from tests.integration.p5_helpers import API, seed_site
from tests.integration.test_p5_performance import REQ, SHORT, _approved_run, _ready_profile

NAME = "Ada Tester"  # tests.conftest.register
A11Y_PAGES = ["/", "/a11y/clean", "/a11y/label", "/a11y/button"]
SEC_PAGES = ["/", "/sec/hardened"]


@pytest.fixture
async def env(
    make_ctx: CtxFactory,
) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account, str, P5Site]]:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                         scan_page_timeout_s=3)  # fmt: skip
    with running_p5_site() as (base, site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p5r.example.com", org="P5 Reports")
            other = await register(c, "other@p5r.example.com", org="Other Org")
            yield ctx, c, owner, other, base, site


def _rows(text: str) -> int:
    return len(list(csv.reader(io.StringIO(text.lstrip("\ufeff")))))


async def _files(client: httpx.AsyncClient, owner: Account, rid: str, formats: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for fmt in formats:
        r = await client.get(f"{API}/reports/{rid}/download?format={fmt}", headers=owner.headers, follow_redirects=True)
        assert r.status_code == 200, (fmt, r.text)
        out[fmt] = r.content.decode("utf-8", errors="replace") if fmt != "pdf" else ""
    return out


async def _report(client: httpx.AsyncClient, owner: Account, pid: str, rtype: str) -> dict[str, Any]:
    reports = (await client.get(f"{API}/projects/{pid}/reports", headers=owner.headers)).json()
    mine = [r for r in reports if r["report_type"] == rtype and r["frozen"]]
    assert len(mine) == 1, reports
    assert mine[0]["status"] == "ready", mine[0]
    return dict((await client.get(f"{API}/reports/{mine[0]['id']}", headers=owner.headers)).json())


async def test_accessibility_and_security_reports(env: Any) -> None:
    ctx, client, owner, other, base, _site = env
    project = await seed_site(ctx, client, owner, base, sorted({*A11Y_PAGES, *SEC_PAGES}))
    pid = project["id"]
    for rtype, msg in (("accessibility", "check accessibility first"), ("security", "run a security check first")):
        r = await client.post(f"{API}/projects/{pid}/reports", json={"report_type": rtype}, headers=owner.headers)
        assert r.status_code == 409 and r.json()["error"]["message"] == f"Not available yet: {msg}"
    a = await client.post(f"{API}/projects/{pid}/accessibility-scans", json={"keyboard": False}, headers=owner.headers)
    assert a.status_code == 201, a.text
    await worker_for(ctx).run_until_idle(timeout=180)
    sec = await client.post(f"{API}/projects/{pid}/security-assessments", json={}, headers=owner.headers)
    assert sec.status_code == 201, sec.text
    await worker_for(ctx).run_until_idle(timeout=180)

    # Accessibility: frozen when the check finished; the rule groups equal the API's findings.
    rep = await _report(client, owner, pid, "accessibility")
    c = rep["content"]
    scan = (await client.get(f"{API}/quality-scans/{a.json()['id']}", headers=owner.headers)).json()
    findings = (await client.get(f"{API}/quality-scans/{scan['id']}/findings", headers=owner.headers)).json()["items"]
    assert rep["run_key"] == scan["key"] and c["source_key"] == scan["key"]
    counted = {f["key"] for f in findings if not f["heuristic"] and not f["needs_review"]}
    assert {f["key"] for g in c["rules"] for f in g["findings"]} == counted
    assert {"button-name", "label"} <= {g["rule_id"] for g in c["rules"]}
    assert c["by_severity"] == scan["summary"]["by_severity"]
    files = await _files(client, owner, rep["id"], ["html", "csv", "json", "pdf"])
    assert str(escape(c["statement"])) in files["html"]
    assert _rows(files["csv"]) == 1 + len(findings)
    # P5-04b: the XLSX has the CSV's rows on its table sheet; document reports refuse XLSX.
    x = await client.get(
        f"{API}/reports/{rep['id']}/download?format=xlsx", headers=owner.headers, follow_redirects=True
    )
    assert x.status_code == 200 and x.content[:2] == b"PK"
    book = load_workbook(io.BytesIO(x.content))
    assert book.sheetnames == ["Summary", "Findings"] and book["Findings"].max_row == _rows(files["csv"])
    assert "@p5r.example.com" not in "".join(files.values())

    # Security: the statement first; HTTPS not applicable on loopback, with the reason.
    srep = await _report(client, owner, pid, "security")
    sc = srep["content"]
    https = next(r for r in sc["rules"] if r["rule_id"] == "https")
    assert https["result"] == "not_applicable" and https["reason"]
    sfiles = await _files(client, owner, srep["id"], ["html", "csv"])
    body = sfiles["html"].split("<body>", 1)[1]
    assert body.index(str(escape(sc["statement"]))) < body.index("<h2>")
    assert _rows(sfiles["csv"]) == 1 + len(sc["rules"])
    r = await client.get(f"{API}/reports/{srep['id']}/download?format=csv_timeseries", headers=owner.headers)
    assert r.status_code == 422

    # A second, on-demand report of the same check; another organisation can't read either.
    again = await client.post(f"{API}/projects/{pid}/reports",
                              json={"report_type": "security", "run_key": sc["source_key"]}, headers=owner.headers)  # fmt: skip
    assert again.status_code == 202, again.text
    missing = await client.post(f"{API}/projects/{pid}/reports",
                                json={"report_type": "security", "run_key": "SEC-9999"}, headers=owner.headers)  # fmt: skip
    assert missing.status_code == 404
    assert (await client.get(f"{API}/reports/{srep['id']}", headers=other.headers)).status_code == 404


async def test_performance_report_and_defect_report_decider(env: Any) -> None:
    ctx, client, owner, _other, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/", "/perf/slow"], g4=True, requirement=(REQ, ["/perf/slow"]))
    pid = project["id"]
    r = await client.post(f"{API}/projects/{pid}/reports", json={"report_type": "performance"}, headers=owner.headers)
    assert r.status_code == 409 and r.json()["error"]["message"] == "Not available yet: run a performance test first"
    prof = await _ready_profile(client, owner, pid, stages=SHORT, paths=["/perf/slow"])
    run = await _approved_run(client, owner, pid, prof["id"], "127.0.0.1")
    await worker_for(ctx).run_until_idle(timeout=180)
    api_run = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert api_run["status"] == "failed"

    rep = await _report(client, owner, pid, "performance")
    c = rep["content"]
    assert c["source_key"] == api_run["key"]
    assert c["run"]["threshold_results"] == api_run["threshold_results"]
    assert c["run"]["result"]["overall"]["count"] == api_run["result"]["overall"]["count"]
    slow = next(t for t in c["run"]["result"]["targets"] if t["path"] == "/perf/slow")
    api_slow = next(t for t in api_run["result"]["targets"] if t["path"] == "/perf/slow")
    assert slow["latency_ms"]["p95"] == api_slow["latency_ms"]["p95"]
    assert "host typed: yes" in c["approval_line"] and NAME in c["approval_line"]
    assert rep["approval"]["decided_by"]["full_name"] == NAME
    files = await _files(client, owner, rep["id"], ["html", "csv", "csv_timeseries", "json"])
    assert "Missed" in files["html"] and "/perf/slow" in files["csv"]
    assert files["csv_timeseries"].splitlines()[0].lstrip("﻿").startswith("Second,")
    assert _rows(files["csv_timeseries"]) == 1 + len(api_run["timeseries"])
    x = await client.get(
        f"{API}/reports/{rep['id']}/download?format=xlsx", headers=owner.headers, follow_redirects=True
    )
    book = load_workbook(io.BytesIO(x.content))
    assert book.sheetnames == ["Summary", "Pages", "Time series"]
    assert book["Pages"].max_row == _rows(files["csv"]) and book["Time series"].max_row == _rows(
        files["csv_timeseries"]
    )
    assert owner.email not in "".join(files.values())
    assert any(f["filename"].endswith(f"-performance-{api_run['key']}-timeseries-{rep['created_at'][:10]}.csv")
               for f in rep["files"])  # fmt: skip

    # Defect Report: reject the draft at G8; the report names the decider (name only) and splits by source.
    drafts = (await client.get(f"{API}/projects/{pid}/defects?status=draft", headers=owner.headers)).json()["items"]
    perf = next(d for d in drafts if d["source"] == "performance")
    r = await client.post(f"{API}/defects/{perf['id']}/status",
                          json={"action": "reject", "reason": "accepted_risk", "comment": "Slow page is known"},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 200, r.text
    d = await client.post(f"{API}/projects/{pid}/reports", json={"report_type": "defect"}, headers=owner.headers)
    assert d.status_code == 202
    await worker_for(ctx).run_until_idle(timeout=60)
    dd = (await client.get(f"{API}/reports/{d.json()['id']}", headers=owner.headers)).json()
    assert dd["approval"]["decided_by"]["full_name"] == NAME and dd["approval"]["decided_at"]
    assert dd["content"]["by_source"]["performance"] == 1
    row = next(x for x in dd["content"]["defects"] if x["key"] == perf["key"])
    assert row["decided_by"] == NAME and row["source"] == "performance"
    dfiles = await _files(client, owner, d.json()["id"], ["html", "csv", "json"])
    assert owner.email not in "".join(dfiles.values())
    assert "Decided by" in dfiles["csv"].splitlines()[0]

    # P5-BUG-08: retention of load test time series removes the evidence file, the series kept in the run and the
    # report's time-series CSV (410 with the removal text); the rest of the report stays.
    async with ctx.session_factory() as s:
        evs = (await s.execute(select(Evidence).where(Evidence.performance_run_id == uuid.UUID(run["id"]),
                                                      Evidence.kind == EvidenceKind.perf_timeseries)
                               .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert evs
        for ev in evs:
            ev.captured_at = ev.captured_at - timedelta(days=100)
        await s.commit()
    url = f"{API}/organisations/{owner.org_id}/retention"
    r = await client.put(url, json={"videos_traces_days": 30, "screenshots_days": 90, "timeseries_days": 90},
                         headers=owner.headers)  # fmt: skip
    assert r.status_code == 200
    applied = (await client.post(f"{url}/apply", headers=owner.headers)).json()
    assert applied["removed"] == len(evs) + 1  # the evidence file(s) and the report's time-series CSV
    after = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert after["timeseries"] == [] and after["timeseries_removed"].startswith("Removed by the retention policy on ")
    r = await client.get(f"{API}/reports/{rep['id']}/download?format=csv_timeseries", headers=owner.headers)
    assert r.status_code == 410 and r.json()["error"]["message"] == after["timeseries_removed"]
    r = await client.get(f"{API}/reports/{rep['id']}/download?format=csv", headers=owner.headers)
    assert r.status_code == 302
