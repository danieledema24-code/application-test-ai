"""P1-05..P1-11 end to end against the local fixture site: discovery safety (T2/T3/T8/T11/T14), outputs, G2, reports,
SSE replay and the cross-tenant 404 suite (T10). One discovery runs for the module; other tests reuse it."""

from __future__ import annotations

import json
import re
import shutil
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.context import AppContext, build_context
from app.db.models import Evidence, Membership, User
from app.db.tenant import BYPASS
from app.domain.enums import EvidenceKind, Role
from app.llm.base import DisabledLLM
from app.security.passwords import hash_password
from tests.conftest import Account, client_for, make_settings, register, worker_for
from tests.fixtures.site import INJECTION, PREFILLED_SECRET, FixtureSite, running_site

API = "/api/v1"


@dataclass
class Discovered:
    ctx: AppContext
    client: httpx.AsyncClient
    site: FixtureSite
    base_url: str
    owner: Account
    project: dict[str, Any]
    scan: dict[str, Any]


@pytest.fixture(scope="module")
async def disc(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Discovered]:
    tmp = tmp_path_factory.mktemp("disc")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@example.com", org="Fixture Org")
            r = await client.post(
                f"{API}/projects",
                headers=owner.headers,
                json={
                    "url": base_url,
                    "name": "Fixture shop",
                    "start": True,
                    "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                    "scan": {"max_pages": 30, "max_depth": 3},
                },
            )
            assert r.status_code == 201, r.text
            await worker_for(ctx).run_until_idle(timeout=240)
            project = (await client.get(f"{API}/projects/{r.json()['id']}", headers=owner.headers)).json()
            scan = (await client.get(f"{API}/projects/{project['id']}/discovery", headers=owner.headers)).json()
            yield Discovered(ctx, client, site, base_url, owner, project, scan)
    await ctx.close()


def _paths(site: FixtureSite) -> list[str]:
    return [p.split("?")[0] for _, p in site.requests]


async def test_discovery_completes_and_catalogues_the_site(disc: Discovered) -> None:
    scan = disc.scan
    assert scan["status"] == "completed", scan.get("error")
    assert scan["stop_reason"] == "exhausted" and scan["partial"] is False  # R2-4: whole site seen within the limit
    pages = (await disc.client.get(f"{API}/scans/{scan['id']}/pages?limit=100", headers=disc.owner.headers)).json()
    paths = {p["path"] for p in pages["items"]}
    assert {"/", "/products", "/contact", "/login", "/about", "/blog", "/faq"} <= paths
    assert any(p.startswith("/products/") for p in paths)
    assert "/products?page=2" in paths  # pagination followed
    assert scan["stats"]["forms"] >= 3 and scan["stats"]["tables"] >= 1 and scan["stats"]["screenshots"] >= 2
    assert scan["completeness"]["score"] > 0 and scan["gate"]["key"] == "G2"


async def test_read_only_safety(disc: Discovered) -> None:
    methods = {m for m, _ in disc.site.requests}
    assert methods == {"GET"}, "discovery must never submit forms"
    paths = _paths(disc.site)
    assert "/logout" not in paths and "/items/7/delete" not in paths
    assert "/docs/manual.pdf" not in paths
    skipped = {s["reason"] for s in disc.scan["skipped_links"]}
    assert {"would end the session", "destructive action", "file download"} <= skipped
    assert "https://external.example.org/partner" in disc.scan["external_links"]
    # Search box used with harmless input via GET.
    assert any(p.startswith("/search?q=test") for _, p in disc.site.requests)


async def test_private_subresources_and_redirects_blocked(disc: Discovered) -> None:
    assert disc.site.internal_hits == [], "the browser reached a private service"
    blocked = disc.scan["blocked_requests"]
    blocked_urls = " ".join(b["url"] for b in blocked)
    assert f"127.0.0.1:{disc.site.internal_port}" in blocked_urls
    assert "169.254.169.254" in blocked_urls
    assert disc.scan["stats"]["blocked_requests"] >= 2


async def test_auth_boundaries_and_access_gaps(disc: Discovered) -> None:
    gaps = disc.scan["access_gaps"]
    assert any("/account" in g["area"] for g in gaps)
    assert "/account" in json.dumps(disc.scan["auth_boundaries"])
    # QA minor: the public sign-in page is an authentication boundary, not an access gap "Needs credentials".
    login = [b for b in disc.scan["auth_boundaries"] if b["url"].endswith("/login")]
    assert [b["kind"] for b in login] == ["login_form"]
    # R2-1: exactly one "Needs credentials" gap (the 401 area); the visible /login page adds no duplicate.
    needs = [g for g in gaps if g["reason"] == "Needs credentials"]
    assert [g["area"] for g in needs] == ["/account"], needs
    pages = (await disc.client.get(f"{API}/scans/{disc.scan['id']}/pages?limit=100", headers=disc.owner.headers)).json()
    assert next(p for p in pages["items"] if p["path"] == "/login")["requires_auth"] is False
    assert any("sign-in" in lim.lower() or "sign in" in lim.lower() for lim in disc.scan["limitations"])


async def test_form_constraints_extracted(disc: Discovered) -> None:
    pages = (await disc.client.get(f"{API}/scans/{disc.scan['id']}/pages?limit=100", headers=disc.owner.headers)).json()
    contact = next(p for p in pages["items"] if p["path"] == "/contact")
    detail = (await disc.client.get(f"{API}/pages/{contact['id']}", headers=disc.owner.headers)).json()
    form = next(f for f in detail["forms"] if f["method"].lower() == "post")
    fields = {f["name"]: f for f in form["fields"]}
    assert fields["name"]["required"] and fields["name"]["constraints"]["maxlength"] == 80
    assert fields["email"]["type"] == "email"
    assert fields["phone"]["constraints"]["pattern"]
    assert fields["msg"]["constraints"]["minlength"] == 10
    assert form["purpose_guess"] == "contact" and form["submit_label"] == "Send message"
    assert any(c["kind"] in ("modal", "dialog", "button") for c in detail["components"])
    assert detail["evidence"] and all(
        e["content_url"].startswith("http://test/api/v1/evidence/") for e in detail["evidence"]
    )


async def test_password_never_stored_in_dom_evidence(disc: Discovered) -> None:
    async with disc.ctx.session_factory() as s:
        evs = (await s.execute(select(Evidence).execution_options(**BYPASS))).scalars().all()
    for ev in evs:
        if ev.kind == EvidenceKind.screenshot:
            continue
        data = await disc.ctx.storage.get(ev.storage_key)
        assert PREFILLED_SECRET.encode() not in data, f"{ev.kind} {ev.key} leaked the password value"


async def test_prompt_injection_flagged(disc: Discovered) -> None:
    flags = disc.scan["injection_flags"]
    assert any("/about" in json.dumps(f) for f in flags)
    assert any("ignore all previous instructions" in json.dumps(f).lower() for f in flags)
    kn = (await disc.client.get(f"{API}/projects/{disc.project['id']}/knowledge", headers=disc.owner.headers)).json()
    assert all(INJECTION not in json.dumps(k.get("content", "")) for k in (kn if isinstance(kn, list) else kn["items"]))
    feats = (await disc.client.get(f"{API}/scans/{disc.scan['id']}/features", headers=disc.owner.headers)).json()
    assert all("passed" not in f["name"].lower() for f in feats)


async def test_features_journeys_sitemap_rules_labelled(disc: Discovered) -> None:
    h = disc.owner.headers
    feats = (await disc.client.get(f"{API}/scans/{disc.scan['id']}/features", headers=h)).json()
    journeys = (await disc.client.get(f"{API}/scans/{disc.scan['id']}/journeys", headers=h)).json()
    sitemap = (await disc.client.get(f"{API}/scans/{disc.scan['id']}/sitemap", headers=h)).json()
    assert feats and all(f["generated_by"] == "rules" for f in feats)
    assert all(f["evidence_refs"] or f["provenance"] != "observed" for f in feats)
    assert journeys and all(j["provenance"] in ("inferred", "observed") for j in journeys)
    assert sitemap["path"] == "/" or "children" in sitemap


async def test_g2_recommended_gate_and_approval(disc: Discovered) -> None:
    h, pid = disc.owner.headers, disc.project["id"]
    wf = (await disc.client.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
    d = next(s for s in wf["stages"] if s["key"] == "discovery")
    assert d["status"] == "completed" and d["gate"]["status"] == "recommended" and d["gate"]["policy"] == "recommended"
    assert d["progress"]["screenshots"] >= 1
    # A member without approval rights cannot decide.
    async with disc.ctx.session_factory() as s:
        u = User(email="viewer@example.com", full_name="Vic Viewer", password_hash=hash_password("viewer-password-1"))
        s.add(u)
        await s.flush()
        s.add(Membership(organisation_id=disc.owner.org_id, user_id=u.id, role=Role.member, can_approve=False))
        await s.commit()
    login = await disc.client.post(
        f"{API}/auth/login", json={"email": "viewer@example.com", "password": "viewer-password-1"}
    )
    viewer = {"Authorization": f"Bearer {login.json()['token']}"}
    body = {"decision": "approve", "comment": "", "stage_run_version": d["current_version"]}
    assert (
        await disc.client.post(f"{API}/projects/{pid}/gates/G2/decision", json=body, headers=viewer)
    ).status_code == 403
    stale = {**body, "stage_run_version": d["current_version"] + 5}
    assert (await disc.client.post(f"{API}/projects/{pid}/gates/G2/decision", json=stale, headers=h)).status_code == 409
    no_comment = {**body, "decision": "request_changes"}
    assert (
        await disc.client.post(f"{API}/projects/{pid}/gates/G2/decision", json=no_comment, headers=h)
    ).status_code == 422
    ok = await disc.client.post(f"{API}/projects/{pid}/gates/G2/decision", json=body, headers=h)
    assert ok.status_code == 200 and ok.json()["gate"]["status"] == "approved"
    assert ok.json()["gate"]["decision"]["decided_at"]
    await worker_for(disc.ctx).run_until_idle(timeout=120)
    reports = (await disc.client.get(f"{API}/projects/{pid}/reports", headers=h)).json()
    assert reports[0]["approval_status"] == "approved"


async def test_report_files_json_html_pdf(disc: Discovered) -> None:
    h, pid = disc.owner.headers, disc.project["id"]
    reports = (await disc.client.get(f"{API}/projects/{pid}/reports", headers=h)).json()
    rep = reports[0]
    assert rep["status"] == "ready" and set(rep["formats"]) == {"json", "html", "pdf"}
    assert rep["scan_id"] == disc.scan["id"] and rep["generated_by"] == "rules"
    detail = (await disc.client.get(f"{API}/reports/{rep['id']}", headers=h)).json()
    for section in (
        "summary",
        "scope_and_method",
        "sitemap",
        "functionality_map",
        "journeys",
        "access_gaps",
        "limitations",
    ):
        assert section in detail["content"], section
    files: dict[str, bytes] = {}
    for fmt in ("json", "html", "pdf"):
        r = await disc.client.get(f"{API}/reports/{rep['id']}/download?format={fmt}", headers=h)
        assert r.status_code == 302
        signed = r.headers["location"].replace("http://test", "")
        content = await disc.client.get(signed, headers={"Origin": "http://localhost:3002"})
        assert content.status_code == 200
        assert content.headers["access-control-allow-origin"] == "http://localhost:3002"
        assert content.headers["content-security-policy"] == "sandbox"
        assert "attachment" in content.headers["content-disposition"]
        files[fmt] = content.content
    assert files["pdf"].startswith(b"%PDF")
    assert json.loads(files["json"])["site"]["host"] == "127.0.0.1"
    html = files["html"].decode()
    assert "Content-Security-Policy" in html and "<script>alert" not in html
    assert "&lt;script&gt;alert" in html  # hostile page title is escaped
    assert PREFILLED_SECRET not in html


async def test_new_report_version_keeps_old(disc: Discovered) -> None:
    h, pid = disc.owner.headers, disc.project["id"]
    bad = await disc.client.post(f"{API}/projects/{pid}/reports", json={"report_type": "test_summary"}, headers=h)
    assert bad.status_code == 422
    r = await disc.client.post(f"{API}/projects/{pid}/reports", json={"report_type": "discovery"}, headers=h)
    assert r.status_code == 202 and r.json()["status"] == "rendering"
    await worker_for(disc.ctx).run_until_idle(timeout=120)
    reports = (await disc.client.get(f"{API}/projects/{pid}/reports", headers=h)).json()
    versions = sorted(x["version"] for x in reports)
    assert versions[-1] == versions[-2] + 1 and all(x["status"] == "ready" for x in reports)


async def test_signed_urls_tamper_and_cross_org(disc: Discovered) -> None:
    async with disc.ctx.session_factory() as s:
        ev = (await s.execute(select(Evidence).execution_options(**BYPASS).limit(1))).scalar_one()
    good = disc.ctx.evidence_url(ev.id, ev.organisation_id).replace("http://test", "")
    assert (await disc.client.get(good)).status_code == 200
    other_org = disc.ctx.evidence_url(ev.id, uuid.uuid4()).replace("http://test", "")
    assert (await disc.client.get(other_org)).status_code == 403
    tampered = re.sub(r"exp=(\d+)", lambda m: f"exp={int(m.group(1)) + 999}", good)
    assert (await disc.client.get(tampered)).status_code == 403
    expired = re.sub(r"exp=\d+", "exp=1", good)
    assert (await disc.client.get(expired)).status_code == 403


async def test_events_replay_and_sse(disc: Discovered) -> None:
    h, pid = disc.owner.headers, disc.project["id"]
    page = (await disc.client.get(f"{API}/projects/{pid}/events?limit=100", headers=h)).json()
    ids = [e["id"] for e in page["items"]]
    assert ids == sorted(ids) and len(ids) > 5
    types = {e["type"] for e in page["items"]}
    assert {"stage.status_changed", "gate.decided", "page.discovered"} & types
    shots = [e["data"]["screenshot"] for e in page["items"] if (e["data"] or {}).get("screenshot")]
    assert shots and all(s["content_url"].startswith("http://test/api/v1/evidence/") for s in shots)
    cursor = ids[4]
    after = (await disc.client.get(f"{API}/projects/{pid}/events?after={cursor}&limit=3", headers=h)).json()
    assert [e["id"] for e in after["items"]] == ids[5:8] and after["next_after"] == ids[7]
    # SSE: the stream ends after SSE_MAX_CONNECTION_S (2 s in tests), so the buffered body can be parsed.
    r = await disc.client.get(f"{API}/projects/{pid}/events/stream", headers={**h, "Last-Event-ID": str(cursor)})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    frames = [f for f in r.text.split("\n\n") if f.startswith("id:")]
    sse_ids = [int(f.split("\n")[0][4:]) for f in frames]
    assert sse_ids and sse_ids[0] == ids[5] and sse_ids == sorted(sse_ids)
    first = json.loads(frames[0].split("data: ", 1)[1])
    assert first["project_id"] == pid and "type" in first and first["created_at"].endswith("Z")


async def test_dashboard_and_activity(disc: Discovered) -> None:
    dash = (await disc.client.get(f"{API}/dashboard", headers=disc.owner.headers)).json()
    assert dash["health"]["projects_total"] == 1 and dash["health"]["access_gaps"] >= 1
    assert dash["recent_projects"][0]["id"] == disc.project["id"]
    act = (await disc.client.get(f"{API}/activity?limit=5", headers=disc.owner.headers)).json()
    assert len(act["items"]) == 5 and act["next_cursor"]


async def test_cross_tenant_access_is_404(disc: Discovered) -> None:
    other = await register(disc.client, "intruder@example.com", org="Intruder Org")
    h = disc.owner.headers
    pid, sid = disc.project["id"], disc.scan["id"]
    page_id = (await disc.client.get(f"{API}/scans/{sid}/pages?limit=1", headers=h)).json()["items"][0]["id"]
    evs = (await disc.client.get(f"{API}/scans/{sid}/evidence", headers=h)).json()
    ev_id = (evs if isinstance(evs, list) else evs["items"])[0]["id"]
    rep_id = (await disc.client.get(f"{API}/projects/{pid}/reports", headers=h)).json()[0]["id"]
    run_body = {"reason": "x"}
    calls: list[tuple[str, str, dict[str, Any] | None]] = [
        ("GET", f"/projects/{pid}", None),
        ("PATCH", f"/projects/{pid}", {"version": 1, "name": "pwned"}),
        ("POST", f"/projects/{pid}/archive", None),
        ("POST", f"/projects/{pid}/unarchive", None),
        ("GET", f"/projects/{pid}/workflow", None),
        ("POST", f"/projects/{pid}/workflow/pause", None),
        ("POST", f"/projects/{pid}/workflow/resume", None),
        ("POST", f"/projects/{pid}/stages/discovery/run", run_body),
        ("POST", f"/projects/{pid}/stages/discovery/cancel", None),
        ("GET", f"/projects/{pid}/stages/discovery/runs", None),
        ("GET", f"/projects/{pid}/stages/discovery/runs/1", None),
        ("POST", f"/projects/{pid}/gates/G2/decision", {"decision": "approve", "comment": "", "stage_run_version": 1}),
        ("GET", f"/projects/{pid}/scans", None),
        ("GET", f"/projects/{pid}/scans/1", None),
        ("GET", f"/projects/{pid}/discovery", None),
        ("GET", f"/scans/{sid}", None),
        ("GET", f"/scans/{sid}/pages", None),
        ("GET", f"/pages/{page_id}", None),
        ("GET", f"/scans/{sid}/sitemap", None),
        ("GET", f"/scans/{sid}/features", None),
        ("GET", f"/scans/{sid}/journeys", None),
        ("GET", f"/scans/{sid}/evidence", None),
        ("GET", f"/projects/{pid}/knowledge", None),
        ("GET", f"/evidence/{ev_id}", None),
        ("GET", f"/projects/{pid}/reports", None),
        ("POST", f"/projects/{pid}/reports", {"report_type": "discovery"}),
        ("GET", f"/reports/{rep_id}", None),
        ("GET", f"/reports/{rep_id}/download?format=pdf", None),
        ("GET", f"/projects/{pid}/events", None),
        ("GET", f"/projects/{pid}/events/stream", None),
    ]
    for method, path, body in calls:
        r = await disc.client.request(method, f"{API}{path}", json=body, headers=other.headers)
        assert r.status_code == 404, f"{method} {path} -> {r.status_code} {r.text[:200]}"
        assert r.json()["error"]["code"] == "not_found"
    listing = (await disc.client.get(f"{API}/projects?status=all", headers=other.headers)).json()
    assert listing["items"] == []
    dash = (await disc.client.get(f"{API}/dashboard", headers=other.headers)).json()
    assert dash["recent_projects"] == [] and dash["activity"] == []
    assert (await disc.client.get(f"{API}/activity", headers=other.headers)).json()["items"] == []
    # The owner's project is untouched.
    assert (await disc.client.get(f"{API}/projects/{pid}", headers=h)).json()["name"] == "Fixture shop"


async def test_dashboard_health_numbers_are_tenant_scoped(disc: Discovered) -> None:
    """QA (P1-16 verification): another organisation's dashboard health must not count this org's data (T10).
    Found against the running app: a brand-new org saw projects_total=2 and pages_discovered_30d=12."""
    other = await register(disc.client, f"health-{uuid.uuid4().hex[:8]}@example.com", org="Health Probe Org")
    health = (await disc.client.get(f"{API}/dashboard", headers=other.headers)).json()["health"]
    assert health["projects_total"] == 0, health
    assert health["pages_discovered_30d"] == 0, health
    assert health["scans_running"] == 0 and health["awaiting_approval"] == 0 and health["failed_stages"] == 0, health
    assert health["access_gaps"] == 0, health


async def test_regenerate_discovery_marks_report_stale(disc: Discovered) -> None:
    h, pid = disc.owner.headers, disc.project["id"]
    r = await disc.client.post(f"{API}/projects/{pid}/stages/discovery/run", json={"reason": "re-scan"}, headers=h)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    again = await disc.client.post(f"{API}/projects/{pid}/stages/discovery/run", json={}, headers=h)
    assert again.status_code == 409
    wf = (await disc.client.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
    assert next(s for s in wf["stages"] if s["key"] == "discovery_report")["status"] == "stale"
    await worker_for(disc.ctx).run_until_idle(timeout=240)
    scans = (await disc.client.get(f"{API}/projects/{pid}/scans", headers=h)).json()
    items = scans["items"] if isinstance(scans, dict) else scans
    assert {s["key"] for s in items} >= {"SCAN-0001", "SCAN-0002"}
    reports = (await disc.client.get(f"{API}/projects/{pid}/reports", headers=h)).json()
    assert any(not x["is_latest_scan"] for x in reports) and any(x["is_latest_scan"] for x in reports)
    wf = (await disc.client.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
    assert next(s for s in wf["stages"] if s["key"] == "discovery_report")["status"] == "completed"
