"""T1: SSRF vectors (port of the legacy Node API's test/security.test.ts plus IP literal forms and IPv6 embeddings), and the vector file
shared with the Node fixtures in automation/ (P4-01 parity)."""

from __future__ import annotations

import ipaddress
import json
from pathlib import Path
from typing import Any

import pytest

from app.browser.network_policy import NetworkPolicy
from app.security.ssrf import (
    BlockedCode,
    UrlRejected,
    check_host,
    check_url,
    host_matches,
    normalise_url,
    parse_ip_literal,
)


async def public(host: str) -> list[str]:
    return ["93.184.216.34"]


def resolver_for(*addrs: str):  # type: ignore[no-untyped-def]
    async def r(host: str) -> list[str]:
        return list(addrs)

    return r


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("http://169.254.169.254/latest/meta-data", BlockedCode.metadata),
        ("http://metadata.google.internal/", BlockedCode.metadata),
        ("http://127.0.0.1:8080", BlockedCode.private_address),
        ("http://10.0.0.5", BlockedCode.private_address),
        ("http://192.168.1.1", BlockedCode.private_address),
        ("http://172.16.0.1", BlockedCode.private_address),
        ("http://100.64.0.1", BlockedCode.private_address),
        ("http://0.0.0.0", BlockedCode.private_address),
        ("http://[::1]/", BlockedCode.private_address),
        ("http://[fd00::1]/", BlockedCode.private_address),
        ("http://[fe80::1]/", BlockedCode.private_address),
        ("http://localhost:3000/", BlockedCode.private_address),
        ("file:///etc/passwd", BlockedCode.unsupported_scheme),
        ("ftp://example.com", BlockedCode.unsupported_scheme),
        ("javascript:alert(1)", BlockedCode.unsupported_scheme),
        ("https://user:pass@example.com/", BlockedCode.credentials_in_url),
        ("https://", BlockedCode.invalid_url),
    ],
)
async def test_blocked_targets(url: str, code: BlockedCode) -> None:
    resolver = resolver_for("127.0.0.1") if "localhost" in url else public
    _, chk = await check_url(url, allow_loopback=False, resolver=resolver)
    assert not chk.allowed
    assert chk.code == code


@pytest.mark.parametrize(
    "literal",
    [
        "169.254.169.254",
        "2852039166",  # decimal
        "0xa9fea9fe",  # hex
        "0251.0376.0251.0376",  # octal
        "0xa9.0xfe.0xa9.0xfe",
        "169.254.43518",  # short form a.b.c
        "[::ffff:169.254.169.254]",  # IPv4-mapped
        "[::ffff:a9fe:a9fe]",
        "[64:ff9b::a9fe:a9fe]",  # NAT64
        "[2002:a9fe:a9fe::]",  # 6to4
        "[fd00:ec2::254]",  # AWS IPv6 metadata
    ],
)
async def test_metadata_ip_literal_forms_blocked_even_with_allow_loopback(literal: str) -> None:
    _, chk = await check_url(f"http://{literal}/latest/meta-data", allow_loopback=True, resolver=public)
    assert not chk.allowed
    assert chk.code == BlockedCode.metadata


@pytest.mark.parametrize(
    "literal", ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "[::ffff:127.0.0.1]", "[::127.0.0.1]"]
)
async def test_loopback_literal_forms(literal: str) -> None:
    _, chk = await check_url(f"http://{literal}/", allow_loopback=False, resolver=public)
    assert chk.code == BlockedCode.private_address


async def test_hostname_resolving_to_private_is_blocked() -> None:
    chk = await check_host(
        "internal.example.com", allow_loopback=False, resolver=resolver_for("93.184.216.34", "10.1.2.3")
    )
    assert not chk.allowed and chk.code == BlockedCode.private_address and chk.blocked_ip == "10.1.2.3"


async def test_hostname_resolving_to_metadata_blocked_even_when_private_allowed() -> None:
    chk = await check_host("evil.example.com", allow_loopback=True, resolver=resolver_for("169.254.169.254"))
    assert chk.code == BlockedCode.metadata


async def test_dns_lookup_is_bounded_by_timeout() -> None:
    import asyncio
    import time

    async def slow(host: str) -> list[str]:
        await asyncio.sleep(5)
        return ["93.184.216.34"]

    started = time.monotonic()
    chk = await check_host("slow.example.com", allow_loopback=False, resolver=slow, dns_timeout_s=0.2)
    assert time.monotonic() - started < 1
    assert not chk.allowed and chk.dns_timed_out and chk.code == BlockedCode.dns_failure


async def test_dns_failure() -> None:
    chk = await check_host("nowhere.example.com", allow_loopback=False, resolver=resolver_for())
    assert chk.code == BlockedCode.dns_failure


async def test_public_host_allowed_with_non_standard_port() -> None:
    n, chk = await check_url("https://shop.example.com:8443/a", allow_loopback=False, resolver=public)
    assert chk.allowed and n is not None and n.port == 8443


def test_normalisation() -> None:
    n = normalise_url("  Example.COM/path?q=1#frag ")
    assert n.url == "https://example.com/path?q=1"
    assert n.origin == "https://example.com"
    assert normalise_url("http://example.com:80/").url == "http://example.com/"
    assert normalise_url("https://bücher.example").host == "xn--bcher-kva.example"
    assert normalise_url("http://[::1]:8080/").origin == "http://[::1]:8080"
    with pytest.raises(UrlRejected):
        normalise_url("http://exa mple.com")
    with pytest.raises(UrlRejected):
        normalise_url("http://intranet/")


def test_ip_literal_parsing() -> None:
    assert parse_ip_literal("2852039166") == ipaddress.ip_address("169.254.169.254")
    assert parse_ip_literal("1.2.3") == ipaddress.ip_address("1.2.0.3")
    assert parse_ip_literal("example.com") is None
    assert parse_ip_literal("256.1.1.1") is None


def test_host_matching() -> None:
    assert host_matches("app.example.com", ["example.com"])
    assert host_matches("example.com", ["example.com"])
    assert not host_matches("evil.com", ["example.com"])
    assert not host_matches("notexample.com", ["example.com"])
    assert not host_matches("169.254.169.254", ["example.com"])


@pytest.mark.parametrize("addr", ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])
async def test_dev_flag_allows_loopback_only(addr: str) -> None:
    chk = await check_host("devbox.example.com", allow_loopback=True, resolver=resolver_for(addr))
    assert chk.allowed


@pytest.mark.parametrize(
    "addr",
    ["192.168.1.1", "10.0.0.5", "172.16.3.4", "100.64.0.1", "169.254.10.10", "fe80::1", "fd00::1", "0.0.0.0"],  # noqa: S104
)
async def test_dev_flag_still_blocks_lan_and_link_local(addr: str) -> None:
    chk = await check_host("router.example.com", allow_loopback=True, resolver=resolver_for(addr))
    assert not chk.allowed and chk.code in (BlockedCode.private_address, BlockedCode.metadata)
    _, lit = await check_url(
        f"http://{addr if ':' not in addr else '[' + addr + ']'}/", allow_loopback=True, resolver=public
    )
    assert not lit.allowed


async def test_dev_flag_blocks_host_resolving_to_loopback_and_lan() -> None:
    chk = await check_host("mixed.example.com", allow_loopback=True, resolver=resolver_for("127.0.0.1", "192.168.1.1"))
    assert not chk.allowed and chk.blocked_ip == "192.168.1.1"


# ---------------------------------------------------------------------------- shared vectors (P4-01)

_VECTOR_FILE = Path(__file__).resolve().parents[3] / "automation" / "test" / "policy-vectors.json"
_SHARED = json.loads(_VECTOR_FILE.read_text())
_APPROVED_PORT = 4100
_REASON_CODES = {
    "Unsupported scheme": "unsupported_scheme",
    "Cloud metadata endpoint": "metadata",
    "Private network address": "private_address",
    "Host name could not be resolved": "dns_failure",
    "Outside the approved site": "off_site",
    "Credentials in URL are not allowed": "credentials_in_url",
}


def _fill(s: str) -> str:
    return s.replace("{port}", str(_APPROVED_PORT)).replace("{other_port}", str(_APPROVED_PORT + 1))


@pytest.mark.parametrize("vector", _SHARED["vectors"], ids=lambda v: f"{v['url']}|top={v['top_level']}")
async def test_shared_policy_vectors(vector: dict[str, Any]) -> None:
    """The vectors the Node fixtures are tested with (automation/test/policy.test.ts) give the same verdicts here."""
    addrs = vector.get("resolves_to", ["93.184.216.34"])
    policy = NetworkPolicy(
        approved_origins={_fill(_SHARED["approved_origin"])},
        allowed_hosts=_SHARED["allowed_hosts"],
        allow_private_targets=_SHARED["allow_private"],
        resolver=resolver_for(*addrs),
    )
    reason = await policy.check(_fill(vector["url"]), top_level=vector["top_level"])
    assert ("allowed" if reason is None else "blocked") == vector["verdict"], reason
    if vector.get("code"):
        code = _REASON_CODES.get(reason or "", "invalid_url" if (reason or "").startswith("Invalid URL") else reason)
        assert code == vector["code"]
