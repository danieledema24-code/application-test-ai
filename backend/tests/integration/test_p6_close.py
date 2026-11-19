"""P6-08 closing suites on the demo shop (release 1, then release 2 through `DEMO_VERSION_FILE`), AI off, against a
private copy of the shop on a free port (the shared one on :4100 is never touched).

One project gets every kind of Phase 6 artefact: the Phase 4 chain to DEF-0001, REL-0001, the shop's test account
saved, the rescan (CHG-0001), its impact items (one closed as "No action needed"), repair suggestions (one accepted),
a manual re-test (D37), a regression run waiting for G7, an anonymous exploratory session (EXP-0001, with its draft)
and a signed-in one (EXP-0002, approved with the typed host), REL-0002 decided at G9, a scan comparison, and both
Phase 6 reports. Then:

- **Cross-tenant:** another organisation gets 404 on every Phase 6 endpoint (the list is checked against the app's
  routes, so a new endpoint can't be left out) and on the Phase 5 endpoints that now serve Phase 6 objects (sessions,
  findings, evidence, reports, chains by CHG/EXP/HEAL/REL key). Signed URLs of every evidence file written from the
  rescan on open with their own signature, and a signature made for another organisation, a tampered expiry or an
  expired one is refused (403, as for every signed URL since P1).
- **Credential absence:** the test account's password (plain and base64) appears in no Phase 6 API response, no report
  in any format (HTML, PDF text, JSON, CSV, XLSX cells), no evidence file, no event, no database row and no log line;
  its email appears in no report, change set, impact item, repair, session, finding, step or assessment.

Values are never printed: only where they were found.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import shutil
import sqlite3
import uuid
import zipfile
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from pypdf import PdfReader
from sqlalchemy import select

from app.context import AppContext, build_context
from app.db.models import Evidence
from app.db.tenant import BYPASS
from app.domain.enums import Role
from app.llm.base import DisabledLLM
from app.main import create_app
from tests.conftest import Account, client_for, make_settings, register, worker_for
from tests.integration.test_p4_automation import _user
from tests.integration.test_p6_demo_shop import Shop, _demo_login
from tests.integration.test_p6_release_demo import pytestmark as _marks
from tests.integration.test_p6_repairs_demo import EXPECTED

API = "/api/v1"
pytestmark = _marks
FORMATS = ("html", "pdf", "json", "csv", "xlsx")

# Every Phase 6 route (method, path template under /api/v1). test_the_sweep_covers_every_phase6_route compares it
# with the app, so an endpoint added later fails here until it is added to the sweep below.
PHASE6_ROUTES = {
    ("POST", "/projects/{project_id}/rescans"),
    ("GET", "/projects/{project_id}/changes"),
    ("POST", "/projects/{project_id}/changes"),
    ("GET", "/projects/{project_id}/change-sets/{key}"),
    ("GET", "/change-sets/{change_set_id}"),
    ("GET", "/change-sets/{change_set_id}/items"),
    ("GET", "/change-sets/{change_set_id}/impact"),
    ("PATCH", "/impact-items/{item_id}"),
    ("GET", "/change-sets/{change_set_id}/regression-recommendation"),
    ("GET", "/change-sets/{change_set_id}/manual-retests"),
    ("POST", "/change-sets/{change_set_id}/manual-retests"),
    ("POST", "/change-sets/{change_set_id}/regression-run"),
    ("POST", "/projects/{project_id}/exploratory-sessions"),
    ("GET", "/projects/{project_id}/exploratory-sessions"),
    ("GET", "/quality-scans/{scan_id}/steps"),
    ("POST", "/quality-scans/{scan_id}/withdraw"),
    ("POST", "/projects/{project_id}/release-assessments"),
    ("GET", "/projects/{project_id}/release-readiness"),
    ("GET", "/projects/{project_id}/release-assessments"),
    ("GET", "/projects/{project_id}/release-assessments/by-key/{key}"),
    ("GET", "/release-assessments/{assessment_id}"),
    ("POST", "/release-assessments/{assessment_id}/criteria/{criterion_id}/confirm"),
    ("POST", "/release-assessments/{assessment_id}/decision"),
    ("GET", "/projects/{project_id}/heal-suggestions"),
    ("GET", "/heal-suggestions/{suggestion_id}"),
    ("POST", "/heal-suggestions/{suggestion_id}/accept"),
    ("POST", "/heal-suggestions/{suggestion_id}/reject"),
    ("POST", "/projects/{project_id}/reports/completion/lessons-suggestion"),
}
PHASE6_PATH = re.compile(
    r"^/(change-sets|impact-items|heal-suggestions|release-assessments)/"
    r"|^/projects/\{project_id\}/(rescans|changes|change-sets|exploratory-sessions|release-readiness|"
    r"release-assessments|heal-suggestions|reports/completion)"
    r"|^/quality-scans/\{scan_id\}/(steps|withdraw)$"
)


class Chain:
    def __init__(self) -> None:
        self.ctx: AppContext
        self.client: httpx.AsyncClient
        self.tmp: Path
        self.owner: Account
        self.other: Account
        self.member: dict[str, str] = {}
        self.approver: dict[str, str] = {}
        self.ids: dict[str, Any] = {}
        self.rescan_at: datetime
        self.logs = ""

    async def get(self, path: str, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.get(f"{API}{path}", headers=h or self.owner.headers)

    async def ok(self, method: str, path: str, h: dict[str, str] | None = None, body: Any = None) -> Any:
        r = await self.client.request(method, f"{API}{path}", json=body, headers=h or self.owner.headers)
        assert r.status_code in (200, 201, 202), f"{method} {path} -> {r.status_code} {r.text[:300]}"
        return r.json()


def _needles() -> dict[str, bytes]:
    email, password, _token = _demo_login()
    return {"password": password.encode(), "password_b64": base64.b64encode(password.encode()), "email": email.encode()}


async def _build(c: Chain, shop: Shop, version: Path) -> None:
    idle = worker_for(c.ctx).run_until_idle
    ids = c.ids

    async def gate(g: str, key: str) -> None:
        wf = await c.ok("GET", f"/projects/{pid}/workflow")
        st = next(s for s in wf["stages"] if s["key"] == key)
        await c.ok("POST", f"/projects/{pid}/gates/{g}/decision", body={
            "decision": "approve", "comment": "ok", "stage_run_version": st["current_version"]})  # fmt: skip
        await idle(timeout=600)

    async def run_cases(keys: list[str]) -> dict[str, Any]:
        req = await c.ok("POST", f"/projects/{pid}/execution-runs", c.member, {"selection": {"case_keys": keys}})
        await c.ok("POST", f"/execution-runs/{req['id']}/authorise", c.approver, {"decision": "approve"})
        await idle(timeout=900)
        return dict(await c.ok("GET", f"/execution-runs/{req['id']}"))

    async def assess() -> dict[str, Any]:
        await c.ok("POST", f"/projects/{pid}/release-assessments", c.member, {})
        await idle(timeout=600)
        return dict((await c.ok("GET", f"/projects/{pid}/release-readiness"))["latest"])

    r = await c.ok("POST", "/projects", body={
        "url": shop.base, "name": "Demo shop", "start": True,
        "authorisation": {"attested": True, "statement": "Private demo shop run by the test suite."},
        "scan": {"max_pages": 30, "max_depth": 3},
    })  # fmt: skip
    pid = ids["pid"] = r["id"]
    await idle(timeout=600)
    await gate("G2", "discovery")
    reqs = (await c.ok("GET", f"/projects/{pid}/requirements?limit=100"))["items"]
    await c.ok("POST", f"/projects/{pid}/requirements/bulk-status", body={
        "ids": [x["id"] for x in reqs if x["status"] == "draft"], "status": "approved"})  # fmt: skip
    await gate("G3", "requirements")
    await gate("G4", "test_strategy")
    oq = await c.ok("GET", f"/projects/{pid}/test-cases?limit=50&open_question=true")
    empty = next(x for x in oq["items"] if "empty Message" in x["title"])
    d = await c.ok("GET", f"/test-cases/{empty['id']}")
    await c.ok("PATCH", f"/test-cases/{d['id']}", body={"version": d["version"], "expected_result": EXPECTED})
    cases: list[dict[str, Any]] = []
    cursor = None
    while True:
        page = await c.ok("GET", f"/projects/{pid}/test-cases?limit=100" + (f"&cursor={cursor}" if cursor else ""))
        cases += page["items"]
        cursor = page["next_cursor"]
        if not cursor:
            break
    await c.ok("POST", f"/projects/{pid}/test-cases/bulk-status", body={
        "ids": [x["id"] for x in cases if x["status"] == "draft"], "status": "approved"})  # fmt: skip
    await gate("G5", "test_design")

    # Release 1: DEF-0001 confirmed at G8, then REL-0001.
    run = await run_cases([empty["key"]])
    row = next(t for t in run["tests_rows"] if t["case_key"] == empty["key"])
    res = await c.ok("GET", f"/execution-results/{row['id']}")
    ids["def1"] = res["defect"]["id"]
    await c.ok("POST", f"/defects/{ids['def1']}/status", c.approver, {"action": "confirm"})
    rel1 = await assess()
    ids["rel1"], ids["rel1_key"] = rel1["id"], rel1["key"]

    # The shop's test account is saved before release 2, so every later step could leak it.
    email, password, _token = _demo_login()
    await c.ok("PUT", f"/projects/{pid}/secrets/scan_credentials", body={
        "login_url": f"{shop.base}/login", "username": email, "password": password})  # fmt: skip

    # Release 2: rescan, impact, repairs, manual re-test, regression run (waiting for G7).
    version.write_text("2\n")
    c.rescan_at = datetime.now()
    r = await c.ok("POST", f"/projects/{pid}/rescans", c.member, {})
    ids["scan1"], ids["scan2"] = r["baseline"]["id"], r["scan"]["id"]
    await idle(timeout=600)
    [chg] = (await c.ok("GET", f"/projects/{pid}/changes"))["items"]
    ids["chg"], ids["chg_key"] = chg["id"], chg["key"]
    heals = (await c.ok("GET", f"/projects/{pid}/heal-suggestions?change_set={chg['id']}"))["items"]
    contact = sorted((i for i in heals if i["kind"] == "locator" and i["status"] == "open"
                      and any((u["path"] or "").startswith("tests/contact/") for u in i["used_by"])),
                     key=lambda i: i["key"])  # fmt: skip
    assert contact, heals
    ids["heal"], ids["heal_key"] = contact[0]["id"], contact[0]["key"]
    await c.ok("POST", f"/heal-suggestions/{contact[0]['id']}/accept", c.member, {"index": 0})
    await idle(timeout=600)
    others = [i for i in heals if i["id"] != contact[0]["id"]]
    ids["heal_other"] = (others or contact)[0]["id"]
    impact = (await c.ok("GET", f"/change-sets/{chg['id']}/impact"))["items"]
    gap = next(i for i in impact if i["status"] == "open" and i["level"] == "gap")
    ids["impact_item"] = gap["id"]
    await c.ok("PATCH", f"/impact-items/{gap['id']}", c.member,
               {"status": "no_action", "reason": "The Offers page is covered by exploration this release"})  # fmt: skip
    manual = await c.ok("GET", f"/change-sets/{chg['id']}/manual-retests")
    if manual["items"]:
        ids["manual_case"] = manual["items"][0]["case_key"]
        await c.ok("POST", f"/change-sets/{chg['id']}/manual-retests", c.member, {
            "case_key": ids["manual_case"], "status": "passed", "note": "Checked by hand on release 2"})  # fmt: skip
    # The remaining Contact repairs, so the regression run can be requested.
    for sug in contact[1:]:
        await c.ok("POST", f"/heal-suggestions/{sug['id']}/accept", c.member, {"index": 0})
        await idle(timeout=600)
    reg = await c.ok("POST", f"/change-sets/{chg['id']}/regression-run", c.member, {"include_should": False})
    ids["reg_run"] = reg["id"]

    # Exploration: EXP-0001 anonymous (the /offers draft), EXP-0002 signed in, approved with the typed host.
    exp1 = await c.ok("POST", f"/projects/{pid}/exploratory-sessions", c.member, {})
    await idle(timeout=900)
    ids["exp1"], ids["exp1_key"] = exp1["id"], exp1["key"]
    sess = await c.ok("GET", f"/quality-scans/{exp1['id']}")
    assert sess["status"] == "completed", sess["status"]
    draft = await c.ok("GET", f"/projects/{pid}/defects/by-key/{sess['defects'][0]['key']}")
    ids["exp_defect"] = draft["id"]
    findings = (await c.ok("GET", f"/quality-scans/{exp1['id']}/findings"))["items"]
    ids["finding"] = findings[0]["id"]
    exp2 = await c.ok("POST", f"/projects/{pid}/exploratory-sessions", body={
        "signed_in": True, "budget": {"actions": 15}, "approve": True, "confirm_text": "127.0.0.1"})  # fmt: skip
    await idle(timeout=900)
    ids["exp2"] = exp2["id"]
    assert (await c.ok("GET", f"/quality-scans/{exp2['id']}"))["signed_in"] is True

    # REL-0002 decided at G9; a comparison of the two scans; both reports.
    rel2 = await assess()
    ids["rel2"], ids["rel2_key"] = rel2["id"], rel2["key"]
    await c.ok("POST", f"/release-assessments/{rel2['id']}/decision", c.approver, {"decision": "approve"})
    await c.ok("POST", f"/projects/{pid}/changes", c.member, {"from_scan_id": ids["scan1"], "to_scan_id": ids["scan2"]})
    await c.ok("POST", f"/projects/{pid}/reports", c.member, {"report_type": "completion", "run_key": rel2["key"]})
    await idle(timeout=600)
    reps = await c.ok("GET", f"/projects/{pid}/reports")
    ids["reports"] = [x["id"] for x in reps if x["report_type"] in ("completion", "release_readiness")]
    assert {x["report_type"] for x in reps if x["id"] in ids["reports"]} == {"completion", "release_readiness"}
    assert all(x["status"] == "ready" for x in reps if x["id"] in ids["reports"]), reps


@pytest.fixture(scope="module")
async def chain(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Chain]:
    tmp = tmp_path_factory.mktemp("p6close")
    shutil.copy(template_db, tmp / "qa.db")
    version = tmp / "demo-version"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version))
    c = Chain()
    c.tmp = tmp
    c.ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    # Every log record while the chain runs, to look for the credential afterwards.
    lines: list[str] = []
    handler = logging.Handler(logging.DEBUG)
    handler.emit = lambda rec: lines.append(f"{rec.getMessage()} {rec.args!r}")  # type: ignore[method-assign]
    root = logging.getLogger()
    old_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        async with client_for(c.ctx) as client:
            c.client = client
            c.owner = await register(client, "owner@p6-close.example.com", org="P6 Close")
            c.other = await register(client, "other@p6-close.example.com", org="P6 Close Other")
            c.member = await _user(c.ctx, client, c.owner.org_id, "member@p6-close.example.com", Role.member)
            c.approver = await _user(c.ctx, client, c.owner.org_id, "approver@p6-close.example.com", Role.member, True)
            await _build(c, shop, version)
            c.logs = "\n".join(lines)
            yield c
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)
        version.write_text("1\n")
        shop.stop()
        await c.ctx.close()


def test_the_sweep_covers_every_phase6_route(chain: Chain) -> None:
    paths = create_app(ctx=chain.ctx, start_worker=False).openapi()["paths"]
    found = {
        (method.upper(), p[len(API) :])
        for p, ops in paths.items()
        if p.startswith(API) and PHASE6_PATH.search(p[len(API) :])
        for method in ops
    }
    assert found == PHASE6_ROUTES, (sorted(found - PHASE6_ROUTES), sorted(PHASE6_ROUTES - found))


def _calls(c: Chain) -> list[tuple[str, str, Any]]:
    i = c.ids
    pid, chg, rel2 = i["pid"], i["chg"], i["rel2"]
    rep = i["reports"][0]
    calls: list[tuple[str, str, Any]] = [
        # Phase 6 endpoints (PHASE6_ROUTES, in its order)
        ("POST", f"/projects/{pid}/rescans", {}),
        ("GET", f"/projects/{pid}/changes", None),
        ("POST", f"/projects/{pid}/changes", {"from_scan_id": i["scan1"], "to_scan_id": i["scan2"]}),
        ("GET", f"/projects/{pid}/change-sets/{i['chg_key']}", None),
        ("GET", f"/change-sets/{chg}", None),
        ("GET", f"/change-sets/{chg}/items", None),
        ("GET", f"/change-sets/{chg}/impact", None),
        ("PATCH", f"/impact-items/{i['impact_item']}", {"status": "resolved"}),
        ("GET", f"/change-sets/{chg}/regression-recommendation", None),
        ("GET", f"/change-sets/{chg}/manual-retests", None),
        ("POST", f"/change-sets/{chg}/manual-retests", {"case_key": i.get("manual_case", "TC-0001"), "note": "x"}),
        ("POST", f"/change-sets/{chg}/regression-run", {"include_should": True}),
        ("POST", f"/projects/{pid}/exploratory-sessions", {}),
        ("GET", f"/projects/{pid}/exploratory-sessions", None),
        ("GET", f"/quality-scans/{i['exp1']}/steps", None),
        ("POST", f"/quality-scans/{i['exp2']}/withdraw", None),
        ("POST", f"/projects/{pid}/release-assessments", {}),
        ("GET", f"/projects/{pid}/release-readiness", None),
        ("GET", f"/projects/{pid}/release-assessments", None),
        ("GET", f"/projects/{pid}/release-assessments/by-key/{i['rel2_key']}", None),
        ("GET", f"/release-assessments/{rel2}", None),
        ("POST", f"/release-assessments/{rel2}/criteria/exit.ac_executed/confirm", {"status": "met", "reason": "x"}),
        ("POST", f"/release-assessments/{rel2}/decision", {"decision": "approve"}),
        ("GET", f"/projects/{pid}/heal-suggestions", None),
        ("GET", f"/heal-suggestions/{i['heal']}", None),
        ("POST", f"/heal-suggestions/{i['heal_other']}/accept", {"index": 0}),
        ("POST", f"/heal-suggestions/{i['heal_other']}/reject", {"reason": "x"}),
        ("POST", f"/projects/{pid}/reports/completion/lessons-suggestion", {"run_key": i["rel2_key"]}),
        # Earlier endpoints that now serve Phase 6 objects
        ("GET", f"/quality-scans/{i['exp1']}", None),
        ("GET", f"/projects/{pid}/quality-scans/by-key/{i['exp1_key']}", None),
        ("GET", f"/quality-scans/{i['exp1']}/findings", None),
        ("POST", f"/quality-scans/{i['exp1']}/cancel", None),
        ("GET", f"/quality-findings/{i['finding']}", None),
        ("POST", f"/quality-findings/{i['finding']}/triage", {"status": "false_positive", "reason": "x"}),
        ("POST", f"/quality-findings/{i['finding']}/raise-defect", {}),
        ("GET", f"/defects/{i['exp_defect']}", None),
        ("GET", f"/scans/{i['scan2']}", None),
        ("GET", f"/scans/{i['scan2']}/pages", None),
        ("GET", f"/scans/{i['scan2']}/evidence", None),
        ("GET", f"/projects/{pid}/scans/2", None),
        ("GET", f"/execution-runs/{i['reg_run']}", None),
        ("GET", f"/projects/{pid}/reports", None),
        ("POST", f"/projects/{pid}/reports", {"report_type": "completion"}),
        ("POST", f"/projects/{pid}/reports", {"report_type": "release_readiness", "run_key": i["rel2_key"]}),
        ("GET", f"/projects/{pid}/traceability/gaps", None),
        ("GET", f"/projects/{pid}/traceability/coverage", None),
    ]
    for r in i["reports"]:
        calls.append(("GET", f"/reports/{r}", None))
        calls += [("GET", f"/reports/{r}/download?format={f}", None) for f in FORMATS]
    for key in (i["chg_key"], i["exp1_key"], i["heal_key"], i["rel1_key"], i["rel2_key"]):
        calls.append(("GET", f"/projects/{pid}/traceability/chain?key={key}", None))
    assert rep in i["reports"]
    return calls


async def test_other_organisation_gets_404_on_every_phase6_endpoint(chain: Chain) -> None:
    calls = _calls(chain)
    covered = {(m, p.split("?")[0]) for m, p, _ in calls}
    for method, template in PHASE6_ROUTES:  # every route has at least one concrete call
        rx = re.compile("^" + re.sub(r"\\\{[a-z_]+\\\}", "[^/]+", re.escape(template)) + "$")
        assert any(m == method and rx.match(p) for m, p in covered), (method, template)
    wrong = []
    for method, path, body in calls:
        r = await chain.client.request(method, f"{API}{path}", json=body, headers=chain.other.headers)
        if r.status_code != 404:
            wrong.append(f"{method} {path} -> {r.status_code} {r.text[:120]}")
    assert wrong == []
    # Nothing changed for the owner: the sweep's writes were all refused.
    assert (await chain.get(f"/release-assessments/{chain.ids['rel2']}")).json()["status"] == "final"
    sets = (await chain.get(f"/projects/{chain.ids['pid']}/changes")).json()["items"]
    assert [x["key"] for x in sets] == ["CHG-0001"]  # comparing the same pair again returns CHG-0001


async def _phase6_evidence(c: Chain) -> list[Evidence]:
    async with c.ctx.session_factory() as s:
        rows = (await s.execute(select(Evidence).execution_options(**BYPASS))).scalars().all()
    project = uuid.UUID(c.ids["pid"])
    return [e for e in rows if e.project_id == project and e.captured_at.replace(tzinfo=None) >= c.rescan_at]


async def test_signed_urls_of_phase6_evidence_are_bound_to_the_organisation(chain: Chain) -> None:
    rows = await _phase6_evidence(chain)
    kinds = {e.kind.value for e in rows}
    # Discovery of release 2, repair screenshots, exploration before/after, report files.
    assert {"screenshot", "report_render"} <= kinds, kinds
    assert any(e.quality_scan_id is not None for e in rows), "exploration evidence"
    other_org = chain.other.org_id
    for e in rows:
        good = chain.ctx.evidence_url(e.id, e.organisation_id).replace("http://test", "")
        assert (await chain.client.get(good)).status_code == 200, (e.kind, e.key)
        foreign = chain.ctx.evidence_url(e.id, other_org).replace("http://test", "")
        assert (await chain.client.get(foreign)).status_code == 403, (e.kind, e.key)
        tampered = re.sub(r"exp=(\d+)", lambda m: f"exp={int(m.group(1)) + 999}", good)
        assert (await chain.client.get(tampered)).status_code == 403
        expired = re.sub(r"exp=\d+", "exp=1", good)
        assert (await chain.client.get(expired)).status_code == 403
        meta = await chain.client.get(f"{API}/evidence/{e.id}", headers=chain.other.headers)
        assert meta.status_code == 404, (e.kind, e.key)


def _pdf_text(data: bytes) -> str:
    return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages)


def _xlsx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return "\n".join(z.read(n).decode("utf-8", "replace") for n in z.namelist() if n.endswith(".xml"))


async def test_no_credential_in_any_phase6_artefact_or_format(chain: Chain) -> None:
    c, i = chain, chain.ids
    needles = _needles()
    secret = {k: v for k, v in needles.items() if k.startswith("password")}
    hits: list[str] = []
    scanned: dict[str, int] = {"reports": 0, "evidence": 0}

    def scan(where: str, data: bytes, keys: dict[str, bytes]) -> None:
        hits.extend(f"{where}: {k}" for k, v in keys.items() if v in data)

    # 1. Every Phase 6 API response the owner can read (JSON), with the test account's email too.
    pid, chg = i["pid"], i["chg"]
    reads = [
        f"/projects/{pid}/changes", f"/change-sets/{chg}", f"/change-sets/{chg}/items", f"/change-sets/{chg}/impact",
        f"/change-sets/{chg}/regression-recommendation", f"/change-sets/{chg}/manual-retests",
        f"/projects/{pid}/heal-suggestions", f"/heal-suggestions/{i['heal']}", f"/projects/{pid}/exploratory-sessions",
        f"/projects/{pid}/release-readiness", f"/projects/{pid}/release-assessments",
        f"/release-assessments/{i['rel1']}", f"/release-assessments/{i['rel2']}", f"/projects/{pid}/reports",
        f"/projects/{pid}/traceability/gaps", f"/execution-runs/{i['reg_run']}", f"/defects/{i['exp_defect']}",
    ]  # fmt: skip
    for exp in (i["exp1"], i["exp2"]):
        reads += [f"/quality-scans/{exp}", f"/quality-scans/{exp}/steps", f"/quality-scans/{exp}/findings"]
    for path in reads:
        r = await c.get(path)
        assert r.status_code == 200, (path, r.status_code)
        scan(path, r.content, needles)
    # The event feed (Phase 6 events included): never the password.
    events = await c.get(f"/projects/{pid}/events?limit=500")
    scan("events", events.content, secret)

    # 2. Both Phase 6 report types in every format: no password and no email.
    for rep in i["reports"]:
        for fmt in FORMATS:
            r = await c.client.get(f"{API}/reports/{rep}/download?format={fmt}", headers=c.owner.headers,
                                   follow_redirects=True)  # fmt: skip
            if r.status_code == 422:  # a format the report type doesn't offer
                continue
            assert r.status_code == 200, (rep, fmt, r.status_code)
            data = r.content
            text = data
            if fmt == "pdf":
                text = _pdf_text(data).encode()
            elif fmt == "xlsx":
                text = _xlsx_text(data).encode()
            scan(f"report {rep} {fmt}", data + b"\n" + text, needles)
            scanned["reports"] += 1

    # 3. Every evidence file written from the rescan on (screenshots, steps, report files).
    for e in await _phase6_evidence(c):
        scanned["evidence"] += 1
        scan(f"evidence {e.kind.value} {e.key}", await c.ctx.storage.get(e.storage_key), secret)
        scan(f"evidence metadata {e.kind.value} {e.key}", json.dumps(e.meta or {}).encode(), needles)

    # 4. Every database row (the secret itself is stored encrypted) and the log output.
    db = sqlite3.connect(c.tmp / "qa.db")
    try:
        for (table,) in db.execute("select name from sqlite_master where type='table'").fetchall():
            for row in db.execute(f'select * from "{table}"'):  # noqa: S608 - table names from sqlite_master
                scan(f"table {table}", repr(row).encode(), secret)
    finally:
        db.close()
    scan("log output", c.logs.encode(), secret)
    assert sorted(set(hits)) == []
    # The sweep looked at something: both report types in all five formats, and the rescan's evidence.
    assert scanned["reports"] >= 2 * len(FORMATS) and scanned["evidence"] > 10, scanned
    # And it would have found the password (a control, so an empty result means something).
    scan("control", b"x" + needles["password"] + b"x", secret)
    assert hits == ["control: password"]
