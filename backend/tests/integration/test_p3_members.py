"""Workspace members and invitations (P3-07): one-time links stored as hashes, masked email on the public page,
role rules (last owner, admin limits, viewers can't approve), removal revokes sessions, rate limits, isolation."""

from __future__ import annotations

from typing import Any

import httpx
from sqlalchemy import select, text

from app.context import AppContext
from app.db.models import AuditLog
from app.db.tenant import BYPASS
from app.db.types import utcnow
from tests.conftest import PASSWORD, register

API = "/api/v1"


async def _invite(client: httpx.AsyncClient, h: dict[str, str], email: str, role: str, **kw: Any) -> httpx.Response:
    return await client.post(f"{API}/organisation/invitations", json={"email": email, "role": role, **kw}, headers=h)


async def _accept(client: httpx.AsyncClient, link: str, name: str = "New Member") -> httpx.Response:
    token = link.rsplit("/", 1)[-1]
    return await client.post(f"{API}/invitations/{token}/accept", json={"full_name": name, "password": PASSWORD})


def _h(data: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {data['token']}"}


async def test_invite_accept_roles_and_can_approve(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    owner = await register(client, "boss@members.example.com", org="Members Org")
    r = await _invite(client, owner.headers, "new.member@example.com", "member")
    assert r.status_code == 201, r.text
    link = r.json()["link"]
    token = link.rsplit("/", 1)[-1]
    assert link.startswith("/invite/") and len(token) >= 40
    assert r.json()["invitation"]["status"] == "pending" and r.json()["invitation"]["can_approve"] is False
    info = await client.get(f"{API}/invitations/{token}")
    assert info.status_code == 200
    assert info.json() == {
        "organisation_name": "Members Org",
        "invited_by_name": "Ada Tester",
        "role": "member",
        "email_hint": "n***@example.com",
        "expires_at": info.json()["expires_at"],
    }
    acc = await _accept(client, link)
    assert acc.status_code == 201, acc.text
    assert acc.json()["role"] == "member" and acc.json()["organisation"]["name"] == "Members Org"
    me = (await client.get(f"{API}/auth/me", headers=_h(acc.json()))).json()
    assert me["can_approve"] is False and me["role"] == "member"
    # The link works once.
    again = await _accept(client, link)
    assert again.status_code == 404 and again.json()["error"]["message"] == "This invitation is no longer valid"
    assert (await client.get(f"{API}/invitations/{token}")).status_code == 404
    # Only the hash is stored; tokens never appear in the audit log.
    async with api_ctx.engine.connect() as conn:
        stored = (await conn.execute(text("SELECT token_hash FROM invitations"))).scalar_one()
        assert stored != token and len(stored) == 64
        audit = " ".join(str(r) for r in await conn.execute(text("SELECT action, metadata FROM audit_logs")))
        assert token not in audit and "member.invited" in audit and "member.joined" in audit
    # Members list: owner sees emails, the member doesn't; can_approve is the server's value.
    members = (await client.get(f"{API}/organisation/members", headers=owner.headers)).json()["items"]
    by_email = {m["email"]: m for m in members}
    assert (
        by_email["boss@members.example.com"]["can_approve"] is True and by_email["boss@members.example.com"]["is_you"]
    )
    joined = by_email["new.member@example.com"]
    assert joined["role"] == "member" and joined["invited_by"]["full_name"] == "Ada Tester" and joined["joined_at"]
    seen = (await client.get(f"{API}/organisation/members", headers=_h(acc.json()))).json()["items"]
    assert all(m["email"] is None for m in seen)
    # Members can't manage members or invite.
    assert (await _invite(client, _h(acc.json()), "x@example.com", "viewer")).status_code == 403
    p = await client.patch(f"{API}/organisation/members/{joined['membership_id']}", json={"role": "admin"},
                           headers=_h(acc.json()))  # fmt: skip
    assert p.status_code == 403
    # Granting can_approve takes effect on the next request.
    g = await client.patch(f"{API}/organisation/members/{joined['membership_id']}", json={"can_approve": True},
                           headers=owner.headers)  # fmt: skip
    assert g.status_code == 200 and g.json()["can_approve"] is True
    assert (await client.get(f"{API}/auth/me", headers=_h(acc.json()))).json()["can_approve"] is True
    # Viewers can't approve.
    v = await client.patch(f"{API}/organisation/members/{joined['membership_id']}",
                           json={"role": "viewer", "can_approve": True}, headers=owner.headers)  # fmt: skip
    assert v.status_code == 422
    assert (await _invite(client, owner.headers, "v@example.com", "viewer", can_approve=True)).status_code == 422
    # Existing accounts and pending duplicates.
    dup = await _invite(client, owner.headers, "new.member@example.com", "member")
    assert dup.status_code == 409
    assert dup.json()["error"]["message"] == (
        "This email already has an account. Multi-workspace accounts aren't supported yet"
    )
    assert (await _invite(client, owner.headers, "pending@example.com", "viewer")).status_code == 201
    assert (await _invite(client, owner.headers, "pending@example.com", "viewer")).status_code == 409


async def test_revoke_expiry_owner_rules_and_removal(client: httpx.AsyncClient, api_ctx: AppContext) -> None:
    owner = await register(client, "own@rules.example.com", org="Rules Org")
    other = await register(client, "own@else.example.com", org="Else Org")
    # Revoked and expired links are no longer valid; no account is created.
    rv = (await _invite(client, owner.headers, "revoked@example.com", "member")).json()
    ok = await client.post(f"{API}/organisation/invitations/{rv['invitation']['id']}/revoke", headers=owner.headers)
    assert ok.status_code == 200 and ok.json()["status"] == "revoked"
    assert (await _accept(client, rv["link"])).status_code == 404
    ex = (await _invite(client, owner.headers, "expired@example.com", "member")).json()
    async with api_ctx.session_factory() as s:
        from app.db.models import Invitation

        inv = (
            await s.execute(
                select(Invitation).where(Invitation.email == "expired@example.com").execution_options(**BYPASS)
            )
        ).scalar_one()
        inv.expires_at = utcnow()
        await s.commit()
    assert (await _accept(client, ex["link"])).status_code == 404
    listed = (await client.get(f"{API}/organisation/invitations", headers=owner.headers)).json()
    assert {i["email"]: i["status"] for i in listed} == {
        "revoked@example.com": "revoked",
        "expired@example.com": "expired",
    }
    assert (
        await client.post(f"{API}/organisation/invitations/{rv['invitation']['id']}/revoke", headers=other.headers)
    ).status_code == 404
    # An admin joins; admins can't touch owners or make owners.
    adm = (await _invite(client, owner.headers, "admin@example.com", "admin")).json()
    admin = await _accept(client, adm["link"], "Ann Admin")
    members = (await client.get(f"{API}/organisation/members", headers=owner.headers)).json()["items"]
    by_email = {m["email"]: m for m in members}
    me_owner = by_email["own@rules.example.com"]
    me_admin = by_email["admin@example.com"]
    assert me_admin["can_approve"] is False  # invited without approval rights
    up = await client.patch(f"{API}/organisation/members/{me_owner['membership_id']}", json={"role": "member"},
                            headers=_h(admin.json()))  # fmt: skip
    assert up.status_code == 403
    mk = await client.patch(f"{API}/organisation/members/{me_admin['membership_id']}", json={"role": "owner"},
                            headers=_h(admin.json()))  # fmt: skip
    assert mk.status_code == 403
    # The only owner can't demote or remove themselves.
    demote = await client.patch(f"{API}/organisation/members/{me_owner['membership_id']}", json={"role": "admin"},
                                headers=owner.headers)  # fmt: skip
    assert demote.status_code == 409 and demote.json()["error"]["message"] == "A workspace needs at least one owner"
    rm_self = await client.delete(f"{API}/organisation/members/{me_owner['membership_id']}", headers=owner.headers)
    assert rm_self.status_code == 409
    # Other organisations' memberships are invisible.
    assert (
        await client.patch(
            f"{API}/organisation/members/{me_admin['membership_id']}", json={"role": "viewer"}, headers=other.headers
        )
    ).status_code == 404
    # Removing a member revokes their sessions: the next call is 401.
    gone = await client.delete(f"{API}/organisation/members/{me_admin['membership_id']}", headers=owner.headers)
    assert gone.status_code == 204
    assert (await client.get(f"{API}/projects", headers=_h(admin.json()))).status_code == 401
    async with api_ctx.session_factory() as s:
        actions = set((await s.execute(select(AuditLog.action).execution_options(**BYPASS))).scalars())
    assert {"invitation.revoked", "member.removed", "member.joined", "member.invited"} <= actions


async def test_invitation_rate_limits(client: httpx.AsyncClient) -> None:
    owner = await register(client, "rl@members.example.com", org="RL Org")
    codes = [(await _invite(client, owner.headers, f"p{i}@example.com", "viewer")).status_code for i in range(21)]
    assert codes[:20] == [201] * 20 and codes[20] == 429
    lookups = [(await client.get(f"{API}/invitations/not-a-real-token")).status_code for _ in range(11)]
    assert lookups[:10] == [404] * 10 and lookups[10] == 429
