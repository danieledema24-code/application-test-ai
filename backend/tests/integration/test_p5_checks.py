"""P5-02 accessibility and P5-03 passive security checks against the Phase 5 fixture site (real Chromium, AI off).

Covers: the fixture's known violations and the clean page; the keyboard pass (Tab/Shift+Tab only, heuristics never
drafted); D20 drafts (one per critical/serious rule, a second check adds occurrences); triage carried to a later
check ("Seen before") and the reason rule; a timed-out page (partial, not checked, not counted as clean); the
security rule table (hardened page clean, form posting elsewhere, stack trace, loopback transport not applicable,
cookie names and flags only); the access log (GETs of the chosen pages only, no POST); viewers 403, other
organisations 404.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.context import AppContext
from app.db.models import AgentEvent, Defect, Evidence, Membership
from app.db.tenant import BYPASS
from app.domain.enums import DefectSource, EvidenceKind, Role
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.p5_site import P5Site, running_p5_site
from tests.integration.p5_helpers import API, seed_site

A11Y_PAGES = ["/", "/a11y/clean", "/a11y/label", "/a11y/button", "/a11y/trap", "/a11y/outline"]
SEC_PAGES = ["/", "/sec/hardened", "/sec/form-elsewhere", "/sec/stacktrace"]


@pytest.fixture
async def env(
    make_ctx: CtxFactory,
) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account, str, P5Site]]:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                         scan_page_timeout_s=3)  # fmt: skip
    with running_p5_site() as (base, site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p5c.example.com", org="P5 Checks")
            other = await register(c, "other@p5c.example.com", org="Other Org")
            yield ctx, c, owner, other, base, site


async def _run(ctx: AppContext, client: httpx.AsyncClient, owner: Account, pid: str, path: str,
               body: dict[str, Any]) -> dict[str, Any]:  # fmt: skip
    r = await client.post(f"{API}/projects/{pid}/{path}", json=body, headers=owner.headers)
    assert r.status_code == 201, r.text
    await worker_for(ctx).run_until_idle(timeout=180)
    scan = (await client.get(f"{API}/quality-scans/{r.json()['id']}", headers=owner.headers)).json()
    findings = (await client.get(f"{API}/quality-scans/{scan['id']}/findings", headers=owner.headers)).json()["items"]
    return {"scan": scan, "findings": findings}


def _by(findings: list[dict[str, Any]], path: str) -> dict[str, dict[str, Any]]:
    return {f["rule_id"]: f for f in findings if f["path"] == path and not f["needs_review"]}


async def test_accessibility_check_finds_the_fixture_violations(env: Any) -> None:
    ctx, client, owner, other, base, site = env
    project = await seed_site(ctx, client, owner, base, A11Y_PAGES)
    pid = project["id"]
    site.requests.clear()
    first = await _run(ctx, client, owner, pid, "accessibility-scans", {})
    scan, findings = first["scan"], first["findings"]
    assert scan["status"] == "completed", scan
    assert scan["tool_versions"]["axe"] == "4.14.0"
    # Each fixture violation with its rule and severity; the clean page has none.
    assert _by(findings, "/a11y/label")["label"]["severity"] == "critical"
    assert _by(findings, "/a11y/button")["button-name"]["severity"] == "critical"
    assert any(r["criterion"] == "4.1.2" for r in _by(findings, "/a11y/button")["button-name"]["references"]
               if r.get("type") == "wcag")  # fmt: skip
    trap = _by(findings, "/a11y/trap")["keyboard-trap"]
    assert trap["heuristic"] and trap["defect"] is None
    outline = _by(findings, "/a11y/outline")["focus-not-visible"]
    assert outline["heuristic"] and "#plain" in outline["nodes"][0]["target"]
    assert _by(findings, "/a11y/clean") == {}
    keyboard = {k["path"]: k for k in scan["summary"]["keyboard"]}
    assert keyboard["/a11y/clean"]["trap"] is False and keyboard["/a11y/trap"]["trap"] is True
    # Read only: GETs of the chosen pages, no POST, nothing else (the keyboard pass pressed only Tab/Shift+Tab).
    assert {m for m, _ in site.requests} == {"GET"}
    assert {p.split("?")[0] for _, p in site.requests} <= set(A11Y_PAGES)
    # D20: one draft per critical/serious axe rule; keyboard heuristics never drafted.
    drafts = {d["key"]: d for d in scan["defects"]}
    assert len(drafts) == 2
    async with ctx.session_factory() as s:
        rows = (await s.execute(select(Defect).where(Defect.source == DefectSource.accessibility)
                                .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert sorted(d.environment["rule_id"] for d in rows) == ["button-name", "label"]
        assert all(d.root_cause_hypothesis.startswith("Not analysed") for d in rows)
        shots = (await s.execute(select(Evidence).where(Evidence.kind == EvidenceKind.screenshot,
                                                        Evidence.quality_scan_id == uuid.UUID(scan["id"]))
                                 .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert shots and all(e.meta.get("outlined") for e in shots)
    # Triage needs a reason; a false positive stays one on the next check and is "Seen before".
    label = _by(findings, "/a11y/label")["label"]
    r = await client.post(f"{API}/quality-findings/{label['id']}/triage", json={"status": "false_positive"},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 422 and r.json()["error"]["message"] == "Say why. The reason is shown in reports."
    r = await client.post(f"{API}/quality-findings/{label['id']}/triage",
                          json={"status": "false_positive", "reason": "The field is labelled by the heading"},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 200 and r.json()["message"].endswith("marked as false positive.")
    second = await _run(ctx, client, owner, pid, "accessibility-scans", {})
    again = _by(second["findings"], "/a11y/label")["label"]
    assert again["status"] == "false_positive" and again["seen_before"] == label["key"]
    assert second["scan"]["summary"]["drafted"] == []
    assert second["scan"]["summary"]["occurrences_added"]  # button-name went onto the open draft
    async with ctx.session_factory() as s:
        n = len((await s.execute(select(Defect).where(Defect.source == DefectSource.accessibility)
                                 .execution_options(**BYPASS))).scalars().all())  # fmt: skip
    assert n == 2
    # G8 rows carry the observed "Why" line of non-functional drafts (design P5 §10).
    listed = (await client.get(f"{API}/projects/{pid}/defects?status=draft", headers=owner.headers)).json()["items"]
    whys = {d["key"]: d["why"] for d in listed if d["source"] == "accessibility"}
    assert whys and all(w.startswith("axe rule ") and w.endswith(f" · {scan['key']}") for w in whys.values()), whys
    # G8: rejecting a non-functional draft as Accepted risk can mark its findings too (design open question 2).
    button = next(d for d in scan["defects"] if d["summary"].startswith("Buttons"))
    async with ctx.session_factory() as s:
        did = (await s.execute(select(Defect.id).where(Defect.key == button["key"], Defect.project_id == uuid.UUID(pid))
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
    r = await client.post(f"{API}/defects/{did}/status",
                          json={"action": "reject", "reason": "accepted_risk", "comment": "Icon-only, fixed in Q3",
                                "mark_findings": True}, headers=owner.headers)  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["message"] == f"{button['key']} rejected. 2 findings marked as accepted risk."
    again = (await client.get(f"{API}/quality-scans/{second['scan']['id']}/findings?rule=button-name",
                              headers=owner.headers)).json()["items"]  # fmt: skip
    assert [(f["status"], f["status_reason"]) for f in again] == [("accepted_risk", "Icon-only, fixed in Q3")]
    # Other organisations: 404 on scans and findings.
    assert (await client.get(f"{API}/quality-scans/{scan['id']}", headers=other.headers)).status_code == 404
    assert (await client.get(f"{API}/quality-findings/{label['id']}", headers=other.headers)).status_code == 404


async def test_viewer_cannot_start_or_triage(env: Any) -> None:
    ctx, client, owner, _other, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/a11y/clean"])
    viewer = await register(client, f"viewer-{uuid.uuid4().hex[:6]}@p5c.example.com", org="Viewer Org")
    async with ctx.session_factory() as s:
        m = (await s.execute(select(Membership).where(Membership.user_id == viewer.user_id)
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        m.organisation_id, m.role = owner.org_id, Role.viewer
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": viewer.email, "password": "correct-horse-battery"})
    vh = {"Authorization": f"Bearer {login.json()['token']}"}
    for path in ("accessibility-scans", "security-assessments"):
        r = await client.post(f"{API}/projects/{project['id']}/{path}", json={}, headers=vh)
        assert r.status_code == 403, r.text
    fid = str(uuid.uuid4())
    r = await client.post(f"{API}/quality-findings/{fid}/triage", json={"status": "open", "reason": "x"}, headers=vh)
    assert r.status_code == 403


async def test_a_page_that_times_out_makes_the_check_partial(env: Any) -> None:
    ctx, client, owner, _other, base, site = env
    site.slow_ms = 5000  # /perf/slow outlasts the 3 s page timeout
    project = await seed_site(ctx, client, owner, base, ["/a11y/clean", "/perf/slow"])
    res = await _run(ctx, client, owner, project["id"], "accessibility-scans", {"keyboard": False})
    scan = res["scan"]
    assert scan["status"] == "partial" and scan["status_label"] == "Partial: 1 page not checked"
    assert [n["url"].endswith("/perf/slow") for n in scan["not_checked"]] == [True]
    assert "timed out" in scan["not_checked"][0]["reason"]
    assert scan["summary"]["pages_checked"] == 1 and scan["summary"]["pages_not_checked"] == 1


async def test_passive_security_check(env: Any) -> None:
    ctx, client, owner, _other, base, site = env
    project = await seed_site(ctx, client, owner, base, SEC_PAGES)
    site.requests.clear()
    res = await _run(ctx, client, owner, project["id"], "security-assessments", {})
    scan, findings = res["scan"], res["findings"]
    assert scan["status"] == "completed" and scan["statement"].startswith("This is a passive check")
    rules = {(r["rule_id"], r["subject"]): r for r in scan["summary"]["rules"]}
    for rid in ("https", "http-redirect", "hsts", "tls-version", "password-over-http"):
        assert rules[(rid, "")]["result"] == "not_applicable"
        assert rules[(rid, "")]["reason"] == "The target is plain http on this computer (loopback)"
    # The hardened page raises no header or cookie finding (false-positive check).
    assert not [(f["rule_id"], f["details"]) for f in findings if f["path"] == "/sec/hardened"]
    failed = {r["rule_id"] for r in scan["summary"]["rules"] if r["result"] == "failed"}
    assert {"csp-missing", "nosniff", "clickjacking", "referrer-policy", "permissions-policy", "version-disclosure",
            "cookie-samesite", "form-action", "error-disclosure"} == failed  # fmt: skip
    assert rules[("csp-missing", "")]["page_count"] == 3
    assert rules[("cookie-samesite", "recently_viewed")]["observed"].startswith("recently_viewed · Path=/")
    assert rules[("cookie-httponly", "")]["result"] == "passed"  # sid is HttpOnly; recently_viewed isn't session-like
    form = next(f for f in findings if f["rule_id"] == "form-action")
    assert form["path"] == "/sec/form-elsewhere" and "collect.example.org" in form["details"]["observed"]
    trace = next(f for f in findings if f["rule_id"] == "error-disclosure")
    assert trace["path"] == "/sec/stacktrace" and "Traceback" in trace["details"]["observed"]
    # Cookie values are never stored; no defect is drafted until someone raises one (D19/D20).
    assert "fixture-session" not in json.dumps(res) and "=7" not in json.dumps(
        rules[("cookie-samesite", "recently_viewed")]
    )
    assert scan["defects"] == []
    assert {m for m, _ in site.requests} == {"GET"}
    assert sorted({p for _, p in site.requests}) == sorted(SEC_PAGES)
    # Raise defect groups the rule across its pages (design open question 3).
    csp = next(f for f in findings if f["rule_id"] == "csp-missing")
    r = await client.post(f"{API}/quality-findings/{csp['id']}/raise-defect", json={}, headers=owner.headers)
    assert r.status_code == 201, r.text
    assert r.json()["defect"]["summary"] == "Pages don't send a Content-Security-Policy (3 pages)"
    linked = list((await client.get(f"{API}/quality-scans/{scan['id']}/findings?rule=csp-missing",
                                            headers=owner.headers)).json()["items"])  # fmt: skip
    assert len(linked) == 3 and all(f["defect"]["key"] == r.json()["defect"]["key"] for f in linked)
    async with ctx.session_factory() as s:
        events = (await s.execute(select(AgentEvent.data).where(AgentEvent.type.like("quality.%"))
                                  .execution_options(**BYPASS))).scalars().all()  # fmt: skip
    assert all("text" not in e and "headers" not in e for e in events)
