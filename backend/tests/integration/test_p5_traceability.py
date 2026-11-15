"""P5-07 traceability and readiness from non-functional results (real accessibility check on the P5 fixture site).

Covers: a requirement mapped to a page with open findings shows them in its row and in the gap list, and the
coverage counts equal the gap lists; pages no check covered are listed; non-functional requirements without
evidence; chains for A11Y- check and finding keys; the DoD rule "No critical accessibility issues" is not met while a
critical or serious finding is open and met (naming the accepted risk and its reason) once it is accepted; another
organisation's key is not resolved.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.agents.readiness.rules import evaluate, nf_rule_for
from app.context import AppContext
from app.db.tenant import bind_scope, system_scope
from app.domain.enums import ReadinessKind
from app.services.readiness import load_facts
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.p5_site import P5Site, running_p5_site
from tests.integration.p5_helpers import API, seed_site

PAGES = ["/", "/a11y/clean", "/a11y/button"]
REQ = "Every button has an accessible name"


@pytest.fixture
async def env(
    make_ctx: CtxFactory,
) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account, str, P5Site]]:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                         scan_page_timeout_s=3)  # fmt: skip
    with running_p5_site() as (base, site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p5t.example.com", org="P5 Trace")
            other = await register(c, "other@p5t.example.com", org="Other Org")
            yield ctx, c, owner, other, base, site


async def _dod(ctx: AppContext, owner: Account, pid: str) -> dict[str, Any] | None:
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        facts = await load_facts(s, uuid.UUID(pid))
    rule = nf_rule_for(ReadinessKind.dod, "No critical accessibility issues")
    assert rule == "dod.nf.accessibility"
    return evaluate(rule, facts)


async def test_nonfunctional_traceability_chain_and_dod(env: Any) -> None:
    ctx, client, owner, other, base, _site = env
    project = await seed_site(ctx, client, owner, base, PAGES, requirement=(REQ, ["/a11y/button"]),
                              category="accessibility")  # fmt: skip
    pid = project["id"]
    # Before any check: not evaluable, every page unchecked, the requirement has no evidence.
    assert (await _dod(ctx, owner, pid)) == {"status": "unknown", "detail": "Not evaluable: no check has run",
                                             "evidence": []}  # fmt: skip
    gaps = (await client.get(f"{API}/projects/{pid}/traceability/gaps", headers=owner.headers)).json()
    assert len(gaps["pages_not_checked_for_accessibility"]) == len(PAGES)
    assert [x["requirement"]["key"] for x in gaps["non_functional_requirements_without_evidence"]] == ["REQ-0012"]

    r = await client.post(f"{API}/projects/{pid}/accessibility-scans", json={"keyboard": False}, headers=owner.headers)
    assert r.status_code == 201, r.text
    await worker_for(ctx).run_until_idle(timeout=180)
    scan = (await client.get(f"{API}/quality-scans/{r.json()['id']}", headers=owner.headers)).json()
    findings = (await client.get(f"{API}/quality-scans/{scan['id']}/findings", headers=owner.headers)).json()["items"]
    button = next(f for f in findings if f["rule_id"] == "button-name")

    rows = (await client.get(f"{API}/projects/{pid}/traceability", headers=owner.headers)).json()["items"]
    row = next(x for x in rows if x["requirement"]["key"] == "REQ-0012")
    assert row["accessibility"]["open"] >= 1 and button["key"] in row["accessibility"]["findings"]
    assert row["accessibility"]["scan_key"] == scan["key"] and row["security"] is None and row["performance"] is None
    gaps = (await client.get(f"{API}/projects/{pid}/traceability/gaps", headers=owner.headers)).json()
    named = gaps["requirements_with_open_accessibility_findings"]
    assert [x["requirement"]["key"] for x in named] == ["REQ-0012"]
    assert gaps["pages_not_checked_for_accessibility"] == []
    assert gaps["non_functional_requirements_without_evidence"] == []
    cov = (await client.get(f"{API}/projects/{pid}/traceability/coverage", headers=owner.headers)).json()
    assert cov["non_functional"] == {k: len(gaps[k]) for k in cov["non_functional"]}

    # Chains: the check and one finding, up to the requirement and down to the draft.
    ch = (
        await client.get(f"{API}/projects/{pid}/traceability/chain?key={button['key']}", headers=owner.headers)
    ).json()
    assert ch["root"]["key"] == button["key"]
    up = {lv["type"]: [i["key"] for i in lv["items"]] for lv in ch["upstream"]}
    assert up["requirement"] == ["REQ-0012"] and up["page"] == ["http://" + base.split("//", 1)[1] + "/a11y/button"]
    down = {lv["type"]: [i["key"] for i in lv["items"]] for lv in ch["downstream"]}
    assert down["defect"] == [button["defect"]["key"]]
    whole = await client.get(f"{API}/projects/{pid}/traceability/chain?key={scan['key']}", headers=owner.headers)
    assert whole.status_code == 200 and whole.json()["root"]["type"] == "quality_scan"
    assert (await client.get(f"{API}/projects/{pid}/traceability/chain?key=A11Y-9999",
                             headers=owner.headers)).status_code == 404  # fmt: skip

    # DoD: not met while a critical/serious finding is open; met once accepted with a reason (named).
    ev = await _dod(ctx, owner, pid)
    assert ev is not None and ev["status"] == "not_met" and button["key"] in ev["detail"]
    for f in findings:
        if f["severity"] in ("critical", "serious") and not f["heuristic"] and not f["needs_review"]:
            t = await client.post(f"{API}/quality-findings/{f['id']}/triage",
                                  json={"status": "accepted_risk", "reason": "Icon buttons are fixed in Q3"},
                                  headers=owner.headers)  # fmt: skip
            assert t.status_code == 200, t.text
    ev = await _dod(ctx, owner, pid)
    assert ev is not None and ev["status"] == "met"
    assert f"{button['key']} accepted as a risk by Ada Tester ('Icon buttons are fixed in Q3')" in ev["detail"]

    # Another organisation can't resolve the key, even in its own project.
    mine = await seed_site(ctx, client, other, base, ["/"])
    r = await client.get(f"{API}/projects/{mine['id']}/traceability/chain?key={scan['key']}", headers=other.headers)
    assert r.status_code == 404
