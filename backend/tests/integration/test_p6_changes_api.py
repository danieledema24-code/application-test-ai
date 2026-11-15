"""P6-01 rescans and change sets through the API, without a browser (scans and pages are written to the database; the
real rescans run in test_p6_changes.py and test_p6_changes_demo.py):

- `POST /rescans`: the baseline is the last G2-approved scan (D25) or `compare_with`; limits are the baseline's unless
  given (within the cap); 409 when the URL or hosts changed since G1 or there is nothing to compare with; viewers 403;
  the new scan session is a rescan pointing at its baseline; `rescan.started` is audited;
- `POST /changes` compares any two finished scans once (the same pair returns its set; To must be later), the
  `change_compare` job writes the items, and `GET /changes`, `/change-sets/{id}`, `/change-sets/{id}/items` read them
  (filters by kind, significance and page);
- the AI summary (FakeLLM): numbers are placeholders, an invalid or number-writing answer leaves no summary, and the
  items never depend on the model;
- a plain discovery re-run leaves a finished change analysis as it is (QA P6-00 note: nothing would re-queue it);
- `GET /projects/{id}/scans` lists the rescan flag, the baseline and the G2 approval; other organisations get 404.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.context import AppContext
from app.db.models import (
    AgentTask,
    AuditLog,
    ChangeItem,
    ChangeSet,
    DiscoveredPage,
    GateDecision,
    Membership,
    ProjectUrl,
    ScanSession,
    UserJourney,
)
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.domain.enums import (
    GateDecisionKind,
    GateKey,
    GeneratedBy,
    Provenance,
    Role,
    ScanStatus,
    StageKey,
    StageStatus,
)
from app.llm.base import FakeLLM
from app.orchestrator.orchestrator import Orchestrator
from app.services import changes as svc
from app.services.counters import next_key
from tests.conftest import Account, client_for, create_project, public_resolver, register, site_transport, worker_for
from tests.integration.test_p5_foundation import _set_stage, _stage
from tests.integration.test_p6_foundation import _through_automation

API = "/api/v1"
G1_409 = "The URL or allowed hosts changed: authorise them again (Gate 1)"


@pytest.fixture
async def setup(api_ctx: AppContext) -> Any:
    async with client_for(api_ctx) as c:
        owner = await register(c, "owner@p6-01.example.com", org="P6-01 Org")
        other = await register(c, "other@p6-01.example.com", org="P6-01 Other")
        yield api_ctx, c, owner, other


async def _as_role(
    ctx: AppContext, client: httpx.AsyncClient, owner: Account, email: str, role: Role
) -> dict[str, str]:
    acct = await register(client, email, org=f"tmp {email}")
    async with ctx.session_factory() as s:
        m = (
            await s.execute(select(Membership).where(Membership.user_id == acct.user_id).execution_options(**BYPASS))
        ).scalar_one()
        m.organisation_id, m.role = owner.org_id, role
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": acct.email, "password": "correct-horse-battery"})
    return {"Authorization": f"Bearer {login.json()['token']}"}


def _page(base: str, path: str, **kw: Any) -> dict[str, Any]:
    url = f"{base}{path}"
    return {"url": url, "url_hash": hashlib.sha256(url.encode()).hexdigest(), **kw}


CONTACT_V1 = {
    "headings": ["Contact us"],
    "forms": [{"name": None, "method": "POST", "action": "/contact", "submit_label": "Send message",
               "purpose_guess": "contact", "fields": [{"name": "message", "label": "Message", "type": "textarea",
                                                       "required": False, "constraints": {}}]}],
    "components": [{"kind": "button", "role": "button", "name": "Send message", "fingerprint": "a1",
                    "details": {"selector": "main > form > button"}}],
}  # fmt: skip
CONTACT_V2 = {
    "headings": ["Contact us"],
    "forms": [{"name": None, "method": "POST", "action": "/contact", "submit_label": "Send", "purpose_guess": "contact",
               "fields": [{"name": "message", "label": "Your message", "type": "textarea", "required": True,
                           "constraints": {}}]}],
    "components": [{"kind": "button", "role": "button", "name": "Send", "fingerprint": "b2",
                    "details": {"selector": "main > form > button"}}],
}  # fmt: skip


async def _scan(
    ctx: AppContext,
    owner: Account,
    pid: uuid.UUID,
    pages: list[dict[str, Any]],
    *,
    g2: bool = False,
    status: ScanStatus = ScanStatus.completed,
    limits: dict[str, Any] | None = None,
) -> ScanSession:
    """A finished discovery run with its scan session and pages (and optionally its G2 approval)."""
    run_id = await _set_stage(ctx, owner, pid, StageKey.discovery, StageStatus.completed, {"pages": len(pages)})
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        n, key = await next_key(s, owner.org_id, pid, "scan")
        start = pages[0]["url"] if pages else "https://example.com/"
        scan = ScanSession(organisation_id=owner.org_id, project_id=pid, stage_run_id=run_id, key=key, sequence=n,
                           start_url=start, status=status, limits=limits or {"max_pages": 12, "max_depth": 2},
                           stats={"pages": len(pages)})  # fmt: skip
        s.add(scan)
        await s.flush()
        for i, p in enumerate(pages):
            s.add(DiscoveredPage(organisation_id=owner.org_id, project_id=pid, scan_session_id=scan.id,
                                 sequence=i + 1, title=p.get("headings", ["Page"])[0], **p))  # fmt: skip
        s.add(UserJourney(organisation_id=owner.org_id, project_id=pid, scan_session_id=scan.id, stage_run_id=run_id,
                          key=f"J-{n}", name="Contact the company", provenance=Provenance.inferred, confidence=0.6,
                          generated_by=GeneratedBy.rules, steps=[]))  # fmt: skip
        if g2:
            s.add(GateDecision(organisation_id=owner.org_id, project_id=pid, gate_key=GateKey.G2, stage_run_id=run_id,
                               decision=GateDecisionKind.approve, comment=""))  # fmt: skip
        await s.commit()
        await s.refresh(scan)
        return scan


async def _project(client: httpx.AsyncClient, owner: Account) -> tuple[uuid.UUID, str]:
    base = f"https://shop-{uuid.uuid4().hex[:8]}.example.com"
    return uuid.UUID((await create_project(client, owner, base))["id"]), base


async def _two_scans(ctx: AppContext, client: httpx.AsyncClient, owner: Account) -> tuple[uuid.UUID, str, Any, Any]:
    pid, base = await _project(client, owner)
    v1 = [_page(base, "/"), _page(base, "/contact", **CONTACT_V1), _page(base, "/products/1", headings=["Travel mug"])]
    v2 = [_page(base, "/"), _page(base, "/contact", **CONTACT_V2), _page(base, "/offers", headings=["Offers"])]
    s1 = await _scan(ctx, owner, pid, v1, g2=True)
    s2 = await _scan(ctx, owner, pid, v2)
    return pid, base, s1, s2


async def _items(client: httpx.AsyncClient, owner: Account, cs_id: str, **params: str) -> list[dict[str, Any]]:
    r = await client.get(f"{API}/change-sets/{cs_id}/items", params=params, headers=owner.headers)
    assert r.status_code == 200, r.text
    items: list[dict[str, Any]] = r.json()["items"]
    return items


# ------------------------------------------------------------------ POST /rescans


async def test_rescan_compares_with_the_g2_scan_and_keeps_its_limits(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    first = await _scan(ctx, owner, pid, [_page(base, "/")], g2=True, limits={"max_pages": 12, "max_depth": 2})
    await _scan(ctx, owner, pid, [_page(base, "/")])  # a later scan nobody approved
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["baseline"]["id"] == str(first.id) and body["baseline"]["g2_approved"] and body["baseline"]["baseline"]
    assert body["scan"]["number"] == 3 and body["scan"]["is_rescan"] is True
    async with ctx.session_factory() as s:
        scan = (
            await s.execute(select(ScanSession).where(ScanSession.id == uuid.UUID(body["scan"]["id"])).execution_options(
                **BYPASS))
        ).scalar_one()  # fmt: skip
        assert scan.is_rescan and scan.baseline_scan_session_id == first.id
        assert scan.limits["max_pages"] == 12 and scan.limits["max_depth"] == 2
        audits = (
            await s.execute(select(AuditLog).where(AuditLog.action == "rescan.started").execution_options(**BYPASS))
        ).scalars()
        assert [a.meta["baseline"] for a in audits] == [first.key]
    # The history lists the rescan, its baseline and which scan was approved at G2.
    scans = (await client.get(f"{API}/projects/{pid}/scans", headers=owner.headers)).json()["items"]
    by_n = {x["number"]: x for x in scans}
    assert by_n[3]["is_rescan"] and by_n[3]["baseline_number"] == 1 and by_n[1]["g2_approved"]
    assert not by_n[2]["g2_approved"] and not by_n[2]["is_rescan"]


async def test_rescan_with_compare_with_and_given_limits(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    await _scan(ctx, owner, pid, [_page(base, "/")], g2=True)
    other = await _scan(ctx, owner, pid, [_page(base, "/")])
    limits = {"max_pages": 5, "max_depth": 1, "include_mobile": False, "respect_robots": True, "use_credentials": False}
    r = await client.post(f"{API}/projects/{pid}/rescans", json={"compare_with": str(other.id), "limits": limits},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 202, r.text
    assert r.json()["baseline"]["number"] == 2
    async with ctx.session_factory() as s:
        scan = (
            await s.execute(select(ScanSession).where(ScanSession.id == uuid.UUID(r.json()["scan"]["id"])).execution_options(
                **BYPASS))
        ).scalar_one()  # fmt: skip
        assert scan.baseline_scan_session_id == other.id and scan.limits["max_pages"] == 5
        assert scan.limits["include_mobile"] is False


async def test_rescan_refusals(setup: Any) -> None:
    ctx, client, owner, other = setup
    pid, base = await _project(client, owner)
    # Nothing approved at G2 yet and no scan chosen.
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 409 and "Approve Gate 2 first" in r.json()["error"]["message"]
    first = await _scan(ctx, owner, pid, [_page(base, "/")], g2=True)
    failed = await _scan(ctx, owner, pid, [], status=ScanStatus.failed)
    r = await client.post(f"{API}/projects/{pid}/rescans", json={"compare_with": str(failed.id)}, headers=owner.headers)
    assert r.status_code == 422
    r = await client.post(f"{API}/projects/{pid}/rescans", json={"unknown": 1}, headers=owner.headers)
    assert r.status_code == 422
    r = await client.post(f"{API}/projects/{pid}/rescans", json={"limits": {"max_pages": 101}}, headers=owner.headers)
    assert r.status_code == 422
    viewer = await _as_role(ctx, client, owner, "viewer@p6-01.example.com", Role.viewer)
    assert (await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=viewer)).status_code == 403
    assert (await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=other.headers)).status_code == 404
    # Changed allowed hosts since G1: authorise again.
    async with ctx.session_factory() as s:
        url = (
            await s.execute(select(ProjectUrl).where(ProjectUrl.project_id == pid).execution_options(**BYPASS))
        ).scalar_one()
        url.allowed_hosts = [*url.allowed_hosts, "cdn.example.net"]
        await s.commit()
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 409 and r.json()["error"]["message"] == G1_409
    async with ctx.session_factory() as s:
        url = (
            await s.execute(select(ProjectUrl).where(ProjectUrl.project_id == pid).execution_options(**BYPASS))
        ).scalar_one()
        url.allowed_hosts, url.url = url.allowed_hosts[:1], f"{base}/shop"
        await s.commit()
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 409 and r.json()["error"]["message"] == G1_409
    async with ctx.session_factory() as s:
        n = len(list((await s.execute(select(ScanSession).where(ScanSession.project_id == pid).execution_options(
            **BYPASS))).scalars()))  # fmt: skip
    assert n == 2 and first.sequence == 1  # nothing was started


async def test_member_may_rescan(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    await _scan(ctx, owner, pid, [_page(base, "/")], g2=True)
    member = await _as_role(ctx, client, owner, "member@p6-01.example.com", Role.member)
    assert (await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=member)).status_code == 202


# ------------------------------------------------------------------ comparing two scans


async def test_compare_two_scans_once_and_read_the_items(setup: Any) -> None:
    ctx, client, owner, other = setup
    pid, _, s1, s2 = await _two_scans(ctx, client, owner)
    viewer = await _as_role(ctx, client, owner, "viewer2@p6-01.example.com", Role.viewer)
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(s2.id)}
    assert (await client.post(f"{API}/projects/{pid}/changes", json=body, headers=viewer)).status_code == 403
    backwards = {"from_scan_id": str(s2.id), "to_scan_id": str(s1.id)}
    r = await client.post(f"{API}/projects/{pid}/changes", json=backwards, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Choose a later scan in To."
    r = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
    assert r.status_code == 202 and r.json()["created"] is True
    cs = r.json()["change_set"]
    assert cs["key"] == "CHG-0001" and cs["status"] == "queued" and cs["source"] == "compare"
    await worker_for(ctx).run_until_idle(timeout=60)
    detail = (await client.get(f"{API}/change-sets/{cs['id']}", headers=viewer)).json()
    assert detail["status"] == "completed" and detail["base"]["number"] == 1 and detail["target"]["number"] == 2
    assert detail["statement"].startswith("Changes are detected by comparing what discovery saw in two scans.")
    assert detail["generated_by"] == "rules" and detail["ai_summary"] is None
    assert detail["permissions"] == {"can_compare": False}  # a viewer reads, never compares
    assert detail["started_by"]["full_name"]
    assert detail["summary"]["pages"]["added"] == 1 and detail["summary"]["pages"]["removed"] == 1
    items = await _items(client, owner, cs["id"])
    subjects = {(i["kind"], i["significance"], i["subject"]) for i in items}
    assert subjects == {
        ("page_added", "structural", "Page added: /offers"),
        ("page_removed", "structural", "Page removed: /products/1"),
        ("element_renamed", "behavioural", "Button renamed: Send message → Send"),
        ("field_changed", "structural", "Field changed: Message → Your message (now required)"),
    }
    assert {i["display_kind"] for i in items} == {"added", "removed", "renamed", "changed"}
    renamed = next(i for i in items if i["kind"] == "element_renamed")
    assert renamed["page"] == "/contact" and renamed["before_ref"]["page_id"] and renamed["after_ref"]["page_id"]
    # Filters.
    assert [i["kind"] for i in await _items(client, owner, cs["id"], kind="page_added")] == ["page_added"]
    assert len(await _items(client, owner, cs["id"], significance="structural")) == 3
    assert len(await _items(client, owner, cs["id"], page="/contact")) == 2
    r = await client.get(f"{API}/change-sets/{cs['id']}/items", params={"kind": "nope"}, headers=owner.headers)
    assert r.status_code == 422
    # The same pair again: no duplicate.
    again = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
    assert (
        again.status_code == 200
        and again.json()["created"] is False
        and again.json()["change_set"]["key"] == "CHG-0001"
    )
    listed = (await client.get(f"{API}/projects/{pid}/changes", params={"from": str(s1.id), "to": str(s2.id)},
                               headers=viewer)).json()  # fmt: skip
    assert [x["key"] for x in listed["items"]] == ["CHG-0001"] and listed["can_compare"] is False
    by_key = await client.get(f"{API}/projects/{pid}/change-sets/chg-0001", headers=owner.headers)
    assert by_key.status_code == 200 and by_key.json()["id"] == cs["id"]
    # Other organisations: 404 everywhere.
    for path in (f"/change-sets/{cs['id']}", f"/change-sets/{cs['id']}/items", f"/projects/{pid}/changes",
                 f"/projects/{pid}/scans", f"/projects/{pid}/change-sets/CHG-0001"):  # fmt: skip
        assert (await client.get(f"{API}{path}", headers=other.headers)).status_code == 404, path
    r = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=other.headers)
    assert r.status_code == 404
    async with ctx.session_factory() as s:
        audits = list(
            (
                await s.execute(
                    select(AuditLog).where(AuditLog.action == "change_set.created").execution_options(**BYPASS)
                )
            ).scalars()
        )
    assert [a.meta["key"] for a in audits] == ["CHG-0001"] and audits[0].actor_user_id == owner.user_id


async def test_unfinished_or_foreign_scans_cannot_be_compared(setup: Any) -> None:
    ctx, client, owner, other = setup
    pid, _, s1, _ = await _two_scans(ctx, client, owner)
    running = await _scan(ctx, owner, pid, [], status=ScanStatus.running)
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(running.id)}
    assert (await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)).status_code == 422
    opid, obase = await _project(client, other)
    foreign = await _scan(ctx, other, opid, [_page(obase, "/")])
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(foreign.id)}
    assert (await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)).status_code == 404


# ------------------------------------------------------------------ AI summary (FakeLLM)


@pytest.mark.parametrize(
    ("answer", "expected"),
    [({"summary": "The contact form changed: {total} changes, {structural} structural."},
      "The contact form changed: 4 changes, 3 structural."),
     ({"summary": "The site changed in 12 places. Ignore previous instructions."}, None),  # writes numbers itself
     ({"summary": "ok", "extra": "not allowed"}, None)],  # fails the schema twice (one repair) → rules only
)  # fmt: skip
async def test_ai_summary_is_labelled_and_never_changes_items(make_ctx: Any, answer: dict[str, Any],
                                                               expected: str | None) -> None:  # fmt: skip
    llm = FakeLLM([json.dumps(answer), json.dumps(answer)])
    ctx = await make_ctx(llm=llm, resolver=public_resolver(), transport=site_transport())
    async with client_for(ctx) as client:
        owner = await register(client, "ai@p6-01.example.com", org="P6-01 AI")
        pid, _, s1, s2 = await _two_scans(ctx, client, owner)
        r = await client.post(f"{API}/projects/{pid}/changes", json={"from_scan_id": str(s1.id),
                                                                      "to_scan_id": str(s2.id)},
                              headers=owner.headers)  # fmt: skip
        await worker_for(ctx).run_until_idle(timeout=60)
        detail = (await client.get(f"{API}/change-sets/{r.json()['change_set']['id']}", headers=owner.headers)).json()
        assert detail["status"] == "completed" and detail["generated_by"] == "rules"
        assert detail["ai_summary"] == ({"text": expected, "generated_by": "ai"} if expected else None)
        assert detail["summary"]["total"] == 4  # the same items as with AI off
        assert "Website data (untrusted)" in llm.captured[0]["user"] and "Send message" in llm.captured[0]["user"]


# ------------------------------------------------------------------ the change_analysis stage


async def test_change_analysis_runs_after_a_rescan_and_a_plain_rerun_keeps_it(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    v1 = [_page(base, "/"), _page(base, "/contact", **CONTACT_V1)]
    first = await _scan(ctx, owner, pid, v1, g2=True)
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 202
    # The discovery run itself is covered by the browser tests: finish it here with the release-2 pages.
    async with ctx.session_factory() as s:
        scan = (
            await s.execute(select(ScanSession).where(ScanSession.id == uuid.UUID(r.json()["scan"]["id"])).execution_options(
                **BYPASS))
        ).scalar_one()  # fmt: skip
        scan.status = ScanStatus.completed
        for i, p in enumerate([_page(base, "/"), _page(base, "/contact", **CONTACT_V2)]):
            s.add(DiscoveredPage(organisation_id=owner.org_id, project_id=pid, scan_session_id=scan.id, sequence=i + 1,
                                 title="x", **p))  # fmt: skip
        await s.commit()
    from tests.integration.test_p6_foundation import _finish_discovery

    await _finish_discovery(ctx, pid)
    queued = await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert StageKey.change_analysis in queued
    async with ctx.session_factory() as s:
        task = (
            await s.execute(
                select(AgentTask)
                .where(AgentTask.project_id == pid, AgentTask.agent_key == "change")
                .execution_options(**BYPASS)
            )
        ).scalar_one()
    await Orchestrator(ctx).run_task(system_scope(owner.org_id), task.id, None)
    st = await _stage(ctx, pid, StageKey.change_analysis)
    assert st.status == StageStatus.completed
    sets = (await client.get(f"{API}/projects/{pid}/changes", headers=owner.headers)).json()["items"]
    assert len(sets) == 1 and sets[0]["source"] == "rescan" and sets[0]["base"]["id"] == str(first.id)
    assert (
        sets[0]["summary"]["by_kind"] == {"element_renamed": 1, "field_changed": 1, "journey_removed": 1}
        and sets[0]["started_by"]["full_name"]
    )
    # The stage can't be started by hand: a set always compares two given scans.
    r = await client.post(f"{API}/projects/{pid}/stages/change_analysis/run", json={}, headers=owner.headers)
    assert r.status_code == 422 and "compare two scans" in r.json()["error"]["message"]
    # A plain discovery re-run doesn't make the finished comparison stale (nothing would re-queue it).
    await Orchestrator(ctx).request_run(system_scope(owner.org_id), pid, StageKey.discovery, parameters=None,
                                        reason=None)  # fmt: skip
    assert (await _stage(ctx, pid, StageKey.change_analysis)).status == StageStatus.completed


async def test_plain_rerun_never_marks_change_analysis_stale(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    await _set_stage(ctx, owner, pid, StageKey.change_analysis, StageStatus.completed, {})
    await Orchestrator(ctx).request_run(system_scope(owner.org_id), pid, StageKey.discovery, parameters=None,
                                        reason=None)  # fmt: skip
    st = await _stage(ctx, pid, StageKey.change_analysis)
    assert st.status == StageStatus.completed and st.stale_reason is None
    # Requirements and the rest still go stale on a plain re-run (Phase 5 behaviour).
    assert (await _stage(ctx, pid, StageKey.requirements)).status == StageStatus.stale


async def test_requirement_changes_are_appended_after_a_regeneration(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, _, s1, s2 = await _two_scans(ctx, client, owner)
    r = await client.post(f"{API}/projects/{pid}/changes", json={"from_scan_id": str(s1.id), "to_scan_id": str(s2.id)},
                          headers=owner.headers)  # fmt: skip
    await worker_for(ctx).run_until_idle(timeout=60)
    from app.db.models import Project, StageRun

    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        project = (await s.execute(select(Project).where(Project.id == pid))).scalar_one()
        run = StageRun(organisation_id=owner.org_id, workflow_stage_id=(await _stage(ctx, pid, StageKey.requirements)).id,
                       project_id=pid, stage_key=StageKey.requirements, version=9, status=StageStatus.completed)  # fmt: skip
        s.add(run)
        await s.flush()
        n = await svc.append_requirement_changes(
            s,
            project,
            run,
            {"added": ["REQ-0009"], "changed": ["REQ-0002", "AC-0004"], "rejected_as_no_longer_found": []},
        )
        await s.commit()
    assert n == 2
    items = await _items(client, owner, r.json()["change_set"]["id"], kind="requirement_changed")
    assert sorted(i["subject"] for i in items) == ["Requirement added: REQ-0009", "Requirement changed: REQ-0002"]
    detail = (await client.get(f"{API}/change-sets/{r.json()['change_set']['id']}", headers=owner.headers)).json()
    assert detail["summary"]["total"] == 6 and detail["summary"]["pages"]["added"] == 1
    async with ctx.session_factory() as s:
        kinds = [k for (k,) in (await s.execute(select(ChangeItem.kind).execution_options(**BYPASS))).all()]
        sets = list((await s.execute(select(ChangeSet).execution_options(**BYPASS))).scalars())
    assert kinds.count("requirement_changed") == 2 and len(sets) == 1


async def test_interrupted_stage_set_is_failed_and_the_pair_can_be_compared_again(setup: Any) -> None:
    """QA P6-01 #7: when the reaper gives up on a `change_analysis` task, its set says it didn't complete, and
    comparing the same pair again makes a new set instead of returning the stuck one."""
    ctx, client, owner, _ = setup
    pid, _, s1, s2 = await _two_scans(ctx, client, owner)
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        from app.db.models import Project

        project = (await s.execute(select(Project).where(Project.id == pid))).scalar_one()
        cs = await svc.create_set(s, project, s1, s2, stage_run_id=s2.stage_run_id)
        cs.status = svc.ChangeSetStatus.running
        await s.commit()
        cs_id, run_id = cs.id, cs.stage_run_id
    assert run_id is not None
    await svc.stage_set_interrupted(ctx, system_scope(owner.org_id), run_id)
    got = (await client.get(f"{API}/change-sets/{cs_id}", headers=owner.headers)).json()
    assert got["status"] == "failed" and got["error"] == "interrupted"
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(s2.id)}
    r = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
    assert r.status_code == 202 and r.json()["created"] is True and r.json()["change_set"]["key"] == "CHG-0002"


async def test_workflow_says_g2_was_approved_even_while_a_rescan_waits(setup: Any) -> None:
    """QA P6-01 #2: the web decides "Rescan and compare" (OQ1) from the workflow, not from the scan list."""
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)

    async def g2() -> dict[str, Any]:
        wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
        gate: dict[str, Any] = next(s for s in wf["stages"] if s["key"] == "discovery")["gate"]
        return gate

    assert (await g2())["ever_approved"] is False
    await _scan(ctx, owner, pid, [_page(base, "/")], g2=True)
    assert (await g2())["ever_approved"] is True
    assert (await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)).status_code == 202
    assert (await g2())["ever_approved"] is True
