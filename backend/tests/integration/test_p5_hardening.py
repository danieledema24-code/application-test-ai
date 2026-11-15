"""P5-05b/c hardening (design checks 36-38): the audit log (owner/admin only, filters, export recorded), retention
(validation, old files removed, the record stays and its content answers 410 with the removal date), archive rights
(owner and admin) and scheduled permanent deletion (owner only, archived first, typed name, cancellable).
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select

from app.context import AppContext
from app.db.base import Base
from app.db.models import AuditLog, Evidence, Membership
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import EvidenceKind, Role
from app.services.hardening import details_text, purge_due
from tests.conftest import Account, CtxFactory, client_for, create_project, public_resolver, register, site_transport
from tests.fixtures.p5_site import running_p5_site
from tests.integration.p5_helpers import seed_site
from tests.integration.test_p5_performance import _ready_profile

API = "/api/v1"


async def _join(ctx: AppContext, client: httpx.AsyncClient, owner: Account, role: Role) -> dict[str, str]:
    acc = await register(client, f"{role.value}-{uuid.uuid4().hex[:6]}@p5h.example.com", org="Spare Org")
    async with ctx.session_factory() as s:
        m = (await s.execute(select(Membership).where(Membership.user_id == acc.user_id)
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        m.organisation_id, m.role = owner.org_id, role
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": acc.email, "password": "correct-horse-battery"})
    return {"Authorization": f"Bearer {login.json()['token']}"}


async def test_audit_log_rights_filters_and_export(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    owner = await register(client, "owner@p5h.example.com", org="P5 Hardening")
    member = await _join(api_ctx, client, owner, Role.member)
    p = await create_project(client, owner)
    url = f"{API}/organisations/{owner.org_id}/audit-log"

    r = await client.get(url, headers=member)
    assert r.status_code == 403 and r.json()["error"]["message"] == "Only owners and admins can see the audit log."
    other = await register(client, "other@p5h.example.com", org="Other Org")
    assert (await client.get(url, headers=other.headers)).status_code == 404

    everything = (await client.get(url, headers=owner.headers)).json()
    assert everything["total"] >= 2 and "Projects" in everything["groups"]
    created = next(i for i in everything["items"] if i["action"] == "project.created")
    assert created["label"] == "Created a project" and created["project"]["id"] == p["id"]
    assert created["who"]["email"] == owner.email

    projects_only = (await client.get(url, params={"group": "Projects"}, headers=owner.headers)).json()
    assert 0 < projects_only["total"] < everything["total"]
    assert all(i["action"].startswith("project.") for i in projects_only["items"])
    future = (await client.get(url, params={"from": (utcnow() + timedelta(days=1)).isoformat()},
                               headers=owner.headers)).json()  # fmt: skip
    assert future["total"] == 0
    page = (await client.get(url, params={"limit": 1}, headers=owner.headers)).json()
    assert len(page["items"]) == 1 and page["next_cursor"]

    r = await client.get(f"{url}/export", params={"format": "csv"}, headers=owner.headers)
    assert r.status_code == 200 and r.headers["X-Entries"] == str(everything["total"])
    assert r.text.lstrip("﻿").startswith("When,Who,Email,Action,What,Project,Details")
    assert (await client.get(f"{url}/export", headers=member)).status_code == 403
    after = (await client.get(url, params={"action": "audit_log.exported"}, headers=owner.headers)).json()
    assert after["total"] == 1 and after["items"][0]["label"] == "Exported the audit log"
    j = await client.get(f"{url}/export", params={"format": "json"}, headers=owner.headers)
    assert isinstance(j.json(), list)


def test_details_line_says_host_typed_but_never_the_host() -> None:
    row = AuditLog(action="performance_run.approved", meta={"key": "PERF-0001", "approval": "APR-0002",
                                                            "host_typed": "yes"})  # fmt: skip
    assert details_text(row) == "PERF-0001 · APR-0002 · host typed: yes"


async def test_retention_validation_and_removal(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    owner = await register(client, "owner@p5ret.example.com", org="P5 Retention")
    member = await _join(api_ctx, client, owner, Role.member)
    p = await create_project(client, owner)
    url = f"{API}/organisations/{owner.org_id}/retention"

    got = (await client.get(url, headers=owner.headers)).json()
    assert got["saved"] is False and got["screenshots_days"] == 90 and got["can_edit"] is True
    assert (await client.get(url, headers=member)).status_code == 403
    bad = await client.put(url, json={"videos_traces_days": -1, "screenshots_days": 90, "timeseries_days": 90},
                           headers=owner.headers)  # fmt: skip
    assert bad.status_code == 422

    # One old screenshot and one recent one.
    ids = []
    async with api_ctx.session_factory() as s:
        for age in (40, 1):
            key = f"{owner.org_id}/test/{uuid.uuid4().hex}.png"
            await api_ctx.storage.put(key, b"png")
            ev = Evidence(organisation_id=owner.org_id, project_id=uuid.UUID(p["id"]), kind=EvidenceKind.screenshot,
                          storage_key=key, mime="image/png", size=3, sha256=hashlib.sha256(b"png").hexdigest(),
                          captured_at=utcnow() - timedelta(days=age))  # fmt: skip
            s.add(ev)
            await s.flush()
            ids.append((ev.id, key))
        await s.commit()

    # Nothing is removed before a policy is saved.
    assert (await client.post(f"{url}/apply", headers=owner.headers)).json()["removed"] == 0
    r = await client.put(url, json={"videos_traces_days": 30, "screenshots_days": 30, "timeseries_days": 90},
                         headers=owner.headers)  # fmt: skip
    assert r.status_code == 200 and r.json()["message"] == "Retention saved." and r.json()["saved"] is True
    r = await client.post(f"{url}/apply", headers=owner.headers)
    assert r.json() == {"removed": 1, "message": "1 file removed."}
    # P5-BUG-07: before/after in the details, nothing recorded for an unchanged save, "Apply now" is the person.
    same = await client.put(url, json={"videos_traces_days": 30, "screenshots_days": 30, "timeseries_days": 90},
                            headers=owner.headers)  # fmt: skip
    assert same.status_code == 200
    changed = (await client.get(f"{API}/organisations/{owner.org_id}/audit-log",
                                params={"action": "retention.changed"}, headers=owner.headers)).json()  # fmt: skip
    assert changed["total"] == 1
    assert changed["items"][0]["details"] == "screenshots 90 days → 30 days"
    applied = (await client.get(f"{API}/organisations/{owner.org_id}/audit-log",
                                params={"action": "retention.applied"}, headers=owner.headers)).json()  # fmt: skip
    assert applied["items"][0]["who"]["email"] == owner.email and applied["items"][0]["details"] == "1 file removed"
    # The manual apply before any policy was saved removed nothing and is recorded too (QA P5 round 2).
    assert applied["total"] == 2 and applied["items"][1]["details"] == "0 files removed"
    await client.put(url, json={"videos_traces_days": 30, "screenshots_days": 14, "timeseries_days": 0},
                     headers=owner.headers)  # fmt: skip
    changed = (await client.get(f"{API}/organisations/{owner.org_id}/audit-log",
                                params={"action": "retention.changed"}, headers=owner.headers)).json()  # fmt: skip
    assert changed["total"] == 2
    assert changed["items"][0]["details"] == "screenshots 30 days → 14 days, load test time series 90 days → forever"
    await client.put(url, json={"videos_traces_days": 1, "screenshots_days": 14, "timeseries_days": 0},
                     headers=owner.headers)  # fmt: skip
    changed = (await client.get(f"{API}/organisations/{owner.org_id}/audit-log",
                                params={"action": "retention.changed"}, headers=owner.headers)).json()  # fmt: skip
    assert changed["items"][0]["details"] == "videos and traces 30 days → 1 day"

    limits = f"{API}/organisations/{owner.org_id}/settings"
    same_ceiling = {"load_ceiling": {"vus": 20, "rps": 20, "duration_s": 300}}
    assert (await client.patch(limits, json=same_ceiling, headers=owner.headers)).status_code == 200
    lower = {"load_ceiling": {"vus": 10, "rps": 20, "duration_s": 300}}
    assert (await client.patch(limits, json=lower, headers=owner.headers)).status_code == 200
    ceiling = (await client.get(f"{API}/organisations/{owner.org_id}/audit-log",
                                params={"action": "load_ceiling.changed"}, headers=owner.headers)).json()  # fmt: skip
    assert ceiling["total"] == 1 and ceiling["items"][0]["details"] == "users 20 → 10"

    (old_id, old_key), (new_id, _new_key) = ids
    async with api_ctx.session_factory() as s:
        old = (await s.execute(select(Evidence).where(Evidence.id == old_id).execution_options(**BYPASS))).scalar_one()
        new = (await s.execute(select(Evidence).where(Evidence.id == new_id).execution_options(**BYPASS))).scalar_one()
        actions = {a.action for a in (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars()}
    assert old.purged_at is not None and new.purged_at is None
    with pytest.raises(FileNotFoundError):
        await api_ctx.storage.get(old_key)
    assert {"retention.changed", "retention.applied"} <= actions

    rec = (await client.get(f"{API}/evidence/{old_id}", headers=owner.headers)).json()
    assert rec["removed"].startswith("Removed by the retention policy on ") and rec["sha256"]
    exp, sig = api_ctx.signer.sign(old_id, owner.org_id)
    r = await client.get(f"{API}/evidence/{old_id}/content", params={"exp": exp, "sig": sig})
    assert r.status_code == 410
    assert r.json()["error"]["message"].startswith("Removed by the retention policy on ")
    exp, sig = api_ctx.signer.sign(new_id, owner.org_id)
    assert (await client.get(f"{API}/evidence/{new_id}/content", params={"exp": exp, "sig": sig})).content == b"png"


async def test_archive_rights_and_scheduled_deletion(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    owner = await register(client, "owner@p5del.example.com", org="P5 Delete")
    member = await _join(api_ctx, client, owner, Role.member)
    admin = await _join(api_ctx, client, owner, Role.admin)
    p = await create_project(client, owner)
    pid = p["id"]

    r = await client.post(f"{API}/projects/{pid}/archive", headers=member)
    assert r.status_code == 403
    assert r.json()["error"]["message"] == "Only owners and admins can archive or unarchive a project."
    purge = f"{API}/projects/{pid}/purge"
    assert (await client.post(purge, json={"confirm_name": p["name"]}, headers=owner.headers)).status_code == 409

    assert (await client.post(f"{API}/projects/{pid}/archive", headers=admin)).status_code == 204
    r = await client.post(purge, json={"confirm_name": p["name"]}, headers=admin)
    assert r.status_code == 403
    assert r.json()["error"]["message"] == "Only the organisation owner can delete a project permanently."
    r = await client.post(purge, json={"confirm_name": p["name"] + "x"}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Type the project name exactly to confirm."

    r = await client.post(purge, json={"confirm_name": p["name"]}, headers=owner.headers)
    assert r.status_code == 200, r.text
    assert r.json()["message"].startswith(f"{p['name']} will be deleted on ") and r.json()["message"].endswith(" UTC.")
    assert r.json()["purge_scheduled_at"]
    listed = (await client.get(f"{API}/projects?status=archived", headers=owner.headers)).json()["items"]
    assert listed[0]["purge_scheduled_at"]

    r = await client.delete(purge, headers=owner.headers)
    assert r.json() == {"purge_scheduled_at": None, "archived": True,
                        "message": "Deletion cancelled. Nothing was removed."}  # fmt: skip
    detail = (await client.get(f"{API}/projects/{pid}", headers=owner.headers)).json()
    assert detail["purge_scheduled_at"] is None and detail["name"] == p["name"]

    # Unarchiving clears any schedule.
    await client.post(purge, json={"confirm_name": p["name"]}, headers=owner.headers)
    assert (await client.post(f"{API}/projects/{pid}/unarchive", headers=admin)).status_code in (200, 204)
    assert (await client.get(f"{API}/projects/{pid}", headers=owner.headers)).json()["purge_scheduled_at"] is None
    async with api_ctx.session_factory() as s:
        actions = [a.action for a in (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars()]
    assert actions.count("project.purge_scheduled") == 2 and "project.purge_cancelled" in actions


async def test_purge_runs_when_due_and_keeps_only_the_audit_log(make_ctx: CtxFactory) -> None:
    """P5-05c: the worker's pass deletes an archived project once its time has passed (time-shifted here): every row
    in every table and every stored file goes, the audit log stays with a `project.purged` entry, and another project
    of the same organisation is untouched. Before the time, after a cancel or after unarchiving, nothing happens."""
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True)
    with running_p5_site() as (base, _site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p5purge.example.com", org="P5 Purge")
            doomed = await seed_site(ctx, c, owner, base, ["/", "/perf/slow"], g4=True,
                                     requirement=("Pages load within 2 seconds", ["/perf/slow"]))  # fmt: skip
            keep = await create_project(c, owner, url="https://keep.example.com")
            pid = uuid.UUID(doomed["id"])
            await _ready_profile(c, owner, doomed["id"], stages=[{"duration_s": 2, "target_vus": 1}])
            key = f"{owner.org_id}/{pid}/screenshot/x/shot.png"
            await ctx.storage.put(key, b"png")
            async with ctx.session_factory() as s:
                s.add(Evidence(organisation_id=owner.org_id, project_id=pid, kind=EvidenceKind.screenshot,
                               storage_key=key, mime="image/png", size=3, sha256=hashlib.sha256(b"png").hexdigest(),
                               captured_at=utcnow()))  # fmt: skip
                await s.commit()
            assert (await c.post(f"{API}/projects/{pid}/archive", headers=owner.headers)).status_code == 204
            r = await c.post(
                f"{API}/projects/{pid}/purge", json={"confirm_name": doomed["name"]}, headers=owner.headers
            )
            assert r.status_code == 200, r.text

            assert await purge_due(ctx) == 0  # not due yet
            later = utcnow() + timedelta(hours=25)
            await c.delete(f"{API}/projects/{pid}/purge", headers=owner.headers)
            assert await purge_due(ctx, now=later) == 0  # cancelled
            await c.post(f"{API}/projects/{pid}/purge", json={"confirm_name": doomed["name"]}, headers=owner.headers)
            assert await purge_due(ctx, now=later) == 1

            assert (await c.get(f"{API}/projects/{pid}", headers=owner.headers)).status_code == 404
            assert (await c.get(f"{API}/projects/{keep['id']}", headers=owner.headers)).status_code == 200
            assert not await ctx.storage.exists(key)
            async with ctx.session_factory() as s:
                for table in Base.metadata.sorted_tables:
                    if "project_id" in table.c and table.name != "audit_logs":
                        n = (await s.execute(select(func.count()).select_from(table)
                                             .where(table.c.project_id == pid).execution_options(**BYPASS))).scalar_one()  # fmt: skip
                        assert n == 0, table.name
                logs = list((await s.execute(select(AuditLog).where(AuditLog.project_id == pid)
                                             .execution_options(**BYPASS))).scalars())  # fmt: skip
            purged = [a for a in logs if a.action == "project.purged"]
            assert len(purged) == 1 and purged[0].meta["name"] == doomed["name"] and purged[0].meta["rows"] > 10
            assert {"project.created", "project.archived", "project.purge_scheduled"} <= {a.action for a in logs}
            assert await purge_due(ctx, now=later) == 0  # nothing left to do
