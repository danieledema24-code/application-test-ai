"""P2-01: test credentials API and authenticated discovery against the fixture site's cookie-session area.
Asserts the password never reaches logs, agent events, stored evidence/report files, the database file or the
prompts captured by FakeLLM."""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.context import AppContext, build_context
from app.db.models import AgentEvent, AuditLog, Membership, ProjectSecret, User
from app.db.tenant import BYPASS
from app.domain.enums import Role
from app.llm.base import FakeLLM
from app.security.passwords import hash_password
from tests.conftest import Account, client_for, make_settings, register, worker_for
from tests.fixtures.site import running_site

API = "/api/v1"
USER = "qa.tester@fixture.example"
PASSWORD = "Fixture-Pa55word-7731"  # fixture-only credential


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


async def _project(client: httpx.AsyncClient, owner: Account, base_url: str) -> str:
    r = await client.post(
        f"{API}/projects",
        headers=owner.headers,
        json={"url": base_url, "name": "Creds", "start": False,
              "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."}},
    )  # fmt: skip
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


async def _scan(client: httpx.AsyncClient, ctx: AppContext, owner: Account, pid: str) -> dict[str, Any]:
    r = await client.post(f"{API}/projects/{pid}/stages/discovery/run", headers=owner.headers,
                          json={"parameters": {"max_pages": 30, "max_depth": 3}})  # fmt: skip
    assert r.status_code == 202, r.text
    await worker_for(ctx).run_until_idle(timeout=240)
    return dict((await client.get(f"{API}/projects/{pid}/discovery", headers=owner.headers)).json())


@pytest.fixture
async def env(tmp_path: Path, template_db: Path) -> AsyncIterator[tuple[AppContext, FakeLLM, Path]]:
    shutil.copy(template_db, tmp_path / "qa.db")
    llm = FakeLLM()
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=llm)
    yield ctx, llm, tmp_path
    await ctx.close()


async def test_authenticated_discovery_and_redaction(env: tuple[AppContext, FakeLLM, Path]) -> None:
    ctx, llm, tmp = env
    cap = _Capture()
    logging.getLogger().addHandler(cap)
    try:
        with running_site(credentials=(USER, PASSWORD)) as (base_url, site):
            async with client_for(ctx) as client:
                owner = await register(client, "own@cred.example.com", org="Cred Org")
                pid = await _project(client, owner, base_url)
                put = await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers,
                                       json={"login_url": f"{base_url}/login", "username": USER, "password": PASSWORD})  # fmt: skip
                assert put.status_code == 201, put.text
                meta = put.json()
                assert (
                    meta["username_hint"] == "qa…@fixture.example" and "password" not in meta and "username" not in meta
                )
                scan = await _scan(client, ctx, owner, pid)
                assert scan["auth"]["result"] == "succeeded", scan["auth"]
                assert scan["auth"]["authenticated_pages"] >= 2
                assert len(site.login_posts) == 1  # exactly one sign-in attempt
                assert not any(g["reason"] == "Needs credentials" for g in scan["access_gaps"])
                # R2-01: completeness doesn't count the signed-in areas; R2-03: the attempted sign-in form isn't a
                # "not performed" gap.
                assert "need credentials" not in json.dumps(scan["completeness"]).replace("needs", "need")
                assert not any("sign in form" in g["description"].lower() for g in scan["access_gaps"])
                pages = (await client.get(f"{API}/scans/{scan['id']}/pages?limit=100&auth_context=authenticated",
                                          headers=owner.headers)).json()["items"]  # fmt: skip
                paths = {p["path"]: p for p in pages}
                assert "/account" in paths and "/account/orders" in paths
                assert all(p["requires_auth"] for p in paths.values())
                methods = {m for m, path in site.requests if path != "/login"}
                assert methods == {"GET"}  # only the sign-in form was ever submitted
                secrets = (await client.get(f"{API}/projects/{pid}/secrets", headers=owner.headers)).json()
                assert secrets[0]["last_result"] == "succeeded"
    finally:
        logging.getLogger().removeHandler(cap)
    # The password and the username appear nowhere.
    async with ctx.session_factory() as s:
        events = (await s.execute(select(AgentEvent).execution_options(**BYPASS))).scalars().all()
        audits = (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars().all()
        assert any(e.type == "auth.signin_succeeded" for e in events)
        assert any(a.action == "secret.used" for a in audits)
        blob = " ".join(f"{e.message} {e.data}" for e in events) + " ".join(str(a.meta) for a in audits)
        assert PASSWORD not in blob and USER not in blob
    assert all(PASSWORD not in line for line in cap.lines)
    assert all(PASSWORD not in str(c) and USER not in str(c) for c in llm.captured)
    for f in tmp.rglob("*"):
        if f.is_file():
            assert PASSWORD.encode() not in f.read_bytes(), f


async def test_wrong_password_and_captcha_and_roles(env: tuple[AppContext, FakeLLM, Path]) -> None:
    ctx, _llm, _tmp = env  # _tmp: the context's storage root
    with running_site(credentials=(USER, PASSWORD)) as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "own2@cred.example.com", org="Cred Org 2")
            other = await register(client, "other@cred.example.com", org="Other Org")
            pid = await _project(client, owner, base_url)
            bad_host = await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers,
                                        json={"login_url": "https://elsewhere.example.org/login", "username": USER,
                                              "password": PASSWORD})  # fmt: skip
            assert bad_host.status_code == 422 and bad_host.json()["error"]["details"][0]["field"] == "login_url"
            body = {"login_url": f"{base_url}/login", "username": USER, "password": "not-the-password"}
            assert (
                await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers, json=body)
            ).status_code == 201
            # Roles: a member can read status but not manage credentials; another org sees nothing.
            async with ctx.session_factory() as s:
                u = User(
                    email="mem@cred.example.com", full_name="Mem", password_hash=hash_password("member-password-1")
                )
                s.add(u)
                await s.flush()
                s.add(Membership(organisation_id=owner.org_id, user_id=u.id, role=Role.member, can_approve=False))
                await s.commit()
            tok = (
                await client.post(
                    f"{API}/auth/login", json={"email": "mem@cred.example.com", "password": "member-password-1"}
                )
            ).json()["token"]
            mem = {"Authorization": f"Bearer {tok}"}
            listed = await client.get(f"{API}/projects/{pid}/secrets", headers=mem)
            assert listed.status_code == 200 and listed.json()[0]["username_hint"]
            sid = listed.json()[0]["id"]
            assert (
                await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=mem, json=body)
            ).status_code == 403
            assert (await client.delete(f"{API}/projects/{pid}/secrets/{sid}", headers=mem)).status_code == 403
            assert (
                await client.post(f"{API}/projects/{pid}/secrets/scan_credentials/test", headers=mem)
            ).status_code == 403
            assert (await client.get(f"{API}/projects/{pid}/secrets", headers=other.headers)).status_code == 404
            scan = await _scan(client, ctx, owner, pid)
            assert scan["auth"]["result"] == "failed" and scan["auth"]["reason_code"] == "rejected"
            assert len(site.login_posts) == 1
            gap = next(g for g in scan["access_gaps"] if g["reason"] == "Sign-in failed with the saved credentials")
            assert "Update" in gap["suggestion"]
            # The gap carries evidence (a screenshot of the page afterwards and a note), never the values.
            assert len(gap["evidence_refs"]) == 2, gap
            files = [f for f in _tmp.rglob("*") if f.is_file() and "sign-in" in f.name]
            assert {f.suffix for f in files} >= {".jpg", ".txt"}
            note = next(f for f in files if f.suffix == ".txt").read_text()
            assert "failed (rejected)" in note
            for f in files:
                data = f.read_bytes()
                assert USER.encode() not in data and b"not-the-password" not in data
            assert scan["stats"]["pages"] >= 10  # the public crawl is complete
            # Rotation and the sign-in test.
            ok = {**body, "password": PASSWORD}
            rot = await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers, json=ok)
            assert rot.status_code == 200 and rot.json()["version"] == 2
            t = await client.post(f"{API}/projects/{pid}/secrets/scan_credentials/test", headers=owner.headers)
            assert t.status_code == 202
            await worker_for(ctx).run_until_idle(timeout=120)
            meta = (await client.get(f"{API}/projects/{pid}/secrets", headers=owner.headers)).json()[0]
            assert meta["last_result"] == "succeeded"
            # Delete: ciphertext gone, audit kept, next scan makes no attempt.
            assert (
                await client.delete(f"{API}/projects/{pid}/secrets/{sid}", headers=owner.headers)
            ).status_code == 204
            async with ctx.session_factory() as s:
                assert (await s.execute(select(ProjectSecret).execution_options(**BYPASS))).first() is None
                actions = {a.action for a in (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars()}
                assert {"secret.created", "secret.rotated", "secret.deleted", "secret.used"} <= actions
            posts = len(site.login_posts)
            scan = await _scan(client, ctx, owner, pid)
            assert scan["auth"] is None and len(site.login_posts) == posts
    with running_site(credentials=(USER, PASSWORD), captcha=True) as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "own3@cred.example.com", org="Cred Org 3")
            pid = await _project(client, owner, base_url)
            body = {"login_url": f"{base_url}/login", "username": USER, "password": PASSWORD}
            assert (
                await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers, json=body)
            ).status_code == 201
            scan = await _scan(client, ctx, owner, pid)
            assert scan["auth"]["reason_code"] == "captcha" and site.login_posts == []
            assert any(g["reason"] == "Sign-in needs a CAPTCHA or MFA (not attempted)" for g in scan["access_gaps"])
