"""Project creation (P1-03/P1-04): URL policy (T1/T2), attestation (G1), duplicates, credentials (T8), filters."""

from __future__ import annotations

import uuid

import httpx
from sqlalchemy import select

from app.context import AppContext
from app.db.models import AuditLog, GateDecision, Job, ProjectSecret
from app.db.tenant import BYPASS
from tests.conftest import client_for, create_project, project_body, public_resolver, register, site_transport


async def test_url_check_reports_reachability_and_aliases(client: httpx.AsyncClient) -> None:
    acct = await register(client)
    r = await client.post("/api/v1/projects/url-check", json={"url": "shop.example.com"}, headers=acct.headers)
    body = r.json()
    assert r.status_code == 200
    assert body["normalised_url"] == "https://shop.example.com/" and body["allowed"] and body["reachable"]
    assert body["page_title"] == body["title"] == "Shop"
    assert body["resolved_ip"] == "93.184.216.34" and body["error"] is None


async def test_url_check_blocks_metadata_private_and_redirect_to_private(make_ctx) -> None:  # type: ignore[no-untyped-def]
    transport = site_transport(
        {
            "https://bounce.example.com/": httpx.Response(302, headers={"location": "http://10.0.0.7/admin"}),
        }
    )
    ctx: AppContext = await make_ctx(
        resolver=public_resolver({"intranet.example.com": "192.168.1.20"}), transport=transport
    )
    async with client_for(ctx) as c:
        acct = await register(c)
        for url, code in [
            ("http://169.254.169.254/latest/meta-data", "metadata"),
            ("http://0xa9fea9fe/", "metadata"),
            ("https://intranet.example.com", "private_address"),
            ("https://bounce.example.com", "redirect_blocked"),
            ("file:///etc/passwd", "unsupported_scheme"),
        ]:
            r = await c.post("/api/v1/projects/url-check", json={"url": url}, headers=acct.headers)
            assert r.status_code == 200, url
            assert r.json()["allowed"] is False and r.json()["blocked_code"] == code, url
            created = await c.post("/api/v1/projects", json=project_body(url), headers=acct.headers)
            assert created.status_code == 422 and created.json()["error"]["code"] == "url_blocked", url
        r = await c.post(
            "/api/v1/projects/url-check", json={"url": "https://intranet.example.com"}, headers=acct.headers
        )
        assert r.json()["resolved_ip"] == "192.168.1.20"


async def test_allow_private_targets_refused_in_production() -> None:
    import pytest
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError, match="ALLOW_PRIVATE_TARGETS"):
        Settings(
            _env_file=None,
            env="production",
            allow_private_targets=True,  # type: ignore[call-arg]
            secret_key="x" * 40,
            encryption_key="A" * 44,
        )


async def test_unreachable_site_cannot_be_created(make_ctx) -> None:  # type: ignore[no-untyped-def]
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    ctx: AppContext = await make_ctx(resolver=public_resolver(), transport=httpx.MockTransport(handler))
    async with client_for(ctx) as c:
        acct = await register(c)
        r = await c.post("/api/v1/projects", json=project_body(), headers=acct.headers)
        assert r.status_code == 422 and r.json()["error"]["code"] == "url_unreachable"
        check = await c.post(
            "/api/v1/projects/url-check", json={"url": "https://shop.example.com"}, headers=acct.headers
        )
        assert check.json()["reachable"] is False and check.json()["error"]


async def test_attestation_required(client: httpx.AsyncClient) -> None:
    acct = await register(client)
    body = project_body()
    body["authorisation"] = {"attested": False, "statement": "I am authorised to test this site."}
    r = await client.post("/api/v1/projects", json=body, headers=acct.headers)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    assert any(d["field"].startswith("authorisation") for d in r.json()["error"]["details"])


async def test_create_records_g1_audit_and_defaults(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    acct = await register(client)
    p = await create_project(client, acct)
    assert p["settings"]["max_pages"] == 30 and p["settings"]["respect_robots"] is True
    assert p["urls"][0]["authorisation_status"] == "attested"
    assert set(p["locked_gates"]) >= {"G1", "G7"}
    wf = (await client.get(f"/api/v1/projects/{p['id']}/workflow", headers=acct.headers)).json()
    intake = next(s for s in wf["stages"] if s["key"] == "intake")
    assert intake["status"] == "approved" and intake["gate"]["status"] == "approved"
    decision = intake["gate"]["decision"]
    assert (
        decision["decision"] == "approve" and decision["decided_at"] and decision["decided_by"]["email"] == acct.email
    )
    assert next(s for s in wf["stages"] if s["key"] == "discovery")["status"] == "not_started"  # start=false
    async with api_ctx.session_factory() as s:
        gates = (await s.execute(select(GateDecision).execution_options(**BYPASS))).scalars().all()
        actions = {a.action for a in (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars()}
    assert [g.gate_key.value for g in gates] == ["G1"]
    assert {"project.created", "gate.approved"} <= actions


async def test_max_pages_limits(client: httpx.AsyncClient) -> None:
    acct = await register(client)
    r = await client.post("/api/v1/projects", json=project_body(scan={"max_pages": 101}), headers=acct.headers)
    assert r.status_code == 422
    ok = await create_project(client, acct, scan={"max_pages": 100})
    assert ok["settings"]["max_pages"] == 100


async def test_duplicate_project_409_and_confirm(client: httpx.AsyncClient) -> None:
    acct = await register(client)
    first = await create_project(client, acct, name="Shop")
    dup = await client.post("/api/v1/projects", json=project_body("https://shop.example.com/"), headers=acct.headers)
    assert dup.status_code == 409
    err = dup.json()["error"]
    assert err["code"] == "DUPLICATE_PROJECT"
    assert err["details"]["project_id"] == first["id"] and err["details"]["project_name"] == "Shop"
    check = await client.post("/api/v1/projects/url-check", json={"url": "shop.example.com"}, headers=acct.headers)
    assert check.json()["existing_project"]["id"] == first["id"]
    second = await client.post("/api/v1/projects", json=project_body(confirmDuplicate=True), headers=acct.headers)
    assert second.status_code == 201 and second.json()["id"] != first["id"]
    # Other organisations never see the duplicate.
    other = await register(client, org="Other")
    assert (await client.post("/api/v1/projects", json=project_body(), headers=other.headers)).status_code == 201


async def test_credentials_validated_encrypted_and_never_returned(
    client: httpx.AsyncClient, api_ctx: AppContext
) -> None:
    acct = await register(client)
    partial = await client.post(
        "/api/v1/projects", json=project_body(credentials={"username": "qa"}), headers=acct.headers
    )
    assert partial.status_code == 422
    fields = {d["field"] for d in partial.json()["error"]["details"]}
    assert {"credentials.login_url", "credentials.password"} <= fields
    offsite = await client.post(
        "/api/v1/projects",
        headers=acct.headers,
        json=project_body(
            credentials={"login_url": "https://evil.example.org/login", "username": "qa", "password": "pw-123456"}
        ),
    )
    assert offsite.status_code == 422
    r = await client.post(
        "/api/v1/projects",
        headers=acct.headers,
        json=project_body(
            credentials={"login_url": "https://shop.example.com/login", "username": "qa", "password": "Sup3r-Secret-PW"}
        ),
    )
    assert r.status_code == 201
    assert "Sup3r-Secret-PW" not in r.text
    async with api_ctx.session_factory() as s:
        secret = (await s.execute(select(ProjectSecret).execution_options(**BYPASS))).scalar_one()
    assert "Sup3r-Secret-PW" not in secret.ciphertext
    assert "Sup3r-Secret-PW" in api_ctx.encryptor.decrypt(secret.ciphertext)


async def test_start_queues_discovery_and_list_filters(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    acct = await register(client)
    started = await create_project(client, acct, start=True)
    idle = await create_project(client, acct, url="https://other.example.com")
    assert started["current_stage"] == "discovery" and started["current_stage_status"] == "queued"
    async with api_ctx.session_factory() as s:
        jobs = (await s.execute(select(Job))).scalars().all()
    assert [(j.kind, j.concurrency_group) for j in jobs] == [("agent_task", "scan")]
    running = (await client.get("/api/v1/projects?status=running", headers=acct.headers)).json()["items"]
    assert [p["id"] for p in running] == [started["id"]]
    all_items = (await client.get("/api/v1/projects", headers=acct.headers)).json()["items"]
    assert {p["id"] for p in all_items} == {started["id"], idle["id"]}
    assert (await client.get("/api/v1/projects?status=awaiting_approval", headers=acct.headers)).json()["items"] == []
    arch = await client.post(f"/api/v1/projects/{idle['id']}/archive", headers=acct.headers)
    assert arch.status_code == 204
    archived = (await client.get("/api/v1/projects?status=archived", headers=acct.headers)).json()["items"]
    assert [p["id"] for p in archived] == [idle["id"]]


async def test_unknown_project_is_404(client: httpx.AsyncClient) -> None:
    acct = await register(client)
    r = await client.get(f"/api/v1/projects/{uuid.uuid4()}", headers=acct.headers)
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


async def test_dev_flag_never_reaches_lan_devices(make_ctx) -> None:  # type: ignore[no-untyped-def]
    """QA safety finding: with ALLOW_PRIVATE_TARGETS=true the URL check reached 192.168.1.1. Loopback only now."""
    hits: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "text/html"}, html="<title>Router</title>")

    ctx: AppContext = await make_ctx(
        allow_private_targets=True,
        resolver=public_resolver({"router.example.com": "192.168.1.1", "devbox.example.com": "127.0.0.1"}),
        transport=httpx.MockTransport(handler),
    )
    async with client_for(ctx) as c:
        acct = await register(c)
        for url in (
            "http://192.168.1.1/",
            "http://10.0.0.1/",
            "http://169.254.169.254/",
            "https://router.example.com/",
        ):
            r = await c.post("/api/v1/projects/url-check", json={"url": url}, headers=acct.headers)
            assert r.json()["allowed"] is False, url
        assert hits == []
        ok = await c.post(
            "/api/v1/projects/url-check", json={"url": "http://devbox.example.com:4100"}, headers=acct.headers
        )
        assert ok.json()["allowed"] is True and hits
        health = (await c.get("/api/v1/health")).json()
        assert health["allow_private_targets"] is True


async def test_url_check_dns_timeout_is_unreachable(make_ctx) -> None:  # type: ignore[no-untyped-def]
    """R2-3: a hanging resolver must not exceed the URL check timeout."""
    import asyncio
    import time

    async def slow(host: str) -> list[str]:
        await asyncio.sleep(10)
        return ["93.184.216.34"]

    ctx: AppContext = await make_ctx(resolver=slow, transport=site_transport(), url_check_timeout_s=0.3)
    async with client_for(ctx) as c:
        acct = await register(c)
        started = time.monotonic()
        r = await c.post("/api/v1/projects/url-check", json={"url": "https://slow.example.com"}, headers=acct.headers)
        assert time.monotonic() - started < 2
        body = r.json()
        assert body["reachable"] is False and body["unreachable_code"] == "dns_timeout"
        assert "DNS lookup" in body["error"]
        created = await c.post("/api/v1/projects", json=project_body("https://slow.example.com"), headers=acct.headers)
        assert created.status_code == 422 and created.json()["error"]["code"] == "url_unreachable"
