"""SSRF guard (threat T1/T2). Ported from `api/src/lib/ssrf.ts` and extended.

Rules: http/https only; no credentials in the URL; IP literals in every form a browser accepts (decimal, octal,
hex, shortened) are canonicalised before checking; every A/AAAA record of a host name must be public; IPv4
addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4) are checked as IPv4; cloud metadata endpoints are
always blocked, even when private targets are allowed for local development.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from urllib.parse import urlsplit, urlunsplit

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str], Awaitable[list[str]]]

METADATA_HOSTS = frozenset(
    {
        "metadata.google.internal",
        "metadata",
        "metadata.goog",
        "metadata.azure.com",
        "instance-data",
        "instance-data.ec2.internal",
    }
)
METADATA_IPS = frozenset({ipaddress.ip_address("100.100.100.200"), ipaddress.ip_address("fd00:ec2::254")})
_LINK_LOCAL_V4 = ipaddress.ip_network("169.254.0.0/16")
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")
_KNOWN_SCHEMES = frozenset(
    {"http", "https", "ftp", "file", "javascript", "data", "mailto", "about", "blob", "vbscript", "ws", "wss"}
)


class BlockedCode(StrEnum):
    invalid_url = "invalid_url"
    unsupported_scheme = "unsupported_scheme"
    credentials_in_url = "credentials_in_url"
    metadata = "metadata"
    private_address = "private_address"
    redirect_blocked = "redirect_blocked"
    dns_failure = "dns_failure"


BLOCKED_REASONS: dict[BlockedCode, str] = {
    BlockedCode.invalid_url: "Invalid URL",
    BlockedCode.unsupported_scheme: "Unsupported scheme",
    BlockedCode.credentials_in_url: "Credentials in URL",
    BlockedCode.metadata: "Cloud metadata endpoint",
    BlockedCode.private_address: "Private network address",
    BlockedCode.redirect_blocked: "Redirect to a blocked address",
    BlockedCode.dns_failure: "Host name could not be resolved",
}


class UrlRejected(ValueError):
    def __init__(self, code: BlockedCode, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class NormalisedUrl:
    url: str
    scheme: str
    host: str  # IDNA, lower case, IP literals canonical, IPv6 without brackets
    port: int  # effective port
    explicit_port: bool

    @property
    def origin(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.scheme}://{host}" + (f":{self.port}" if self.explicit_port else "")


@dataclass
class TargetCheck:
    allowed: bool
    host: str
    code: BlockedCode | None = None
    reason: str | None = None
    blocked_ip: str | None = None
    resolved_ips: list[str] = field(default_factory=list)
    dns_timed_out: bool = False


# ---------------------------------------------------------------------------- IP helpers


def _parse_ipv4_part(part: str) -> int | None:
    if part == "":
        return None
    try:
        if part.lower().startswith("0x"):
            return int(part[2:] or "0", 16)
        if len(part) > 1 and part.startswith("0"):
            return int(part[1:], 8)
        return int(part, 10)
    except ValueError:
        return None


def parse_ipv4_literal(host: str) -> ipaddress.IPv4Address | None:
    """WHATWG/inet_aton IPv4 parsing: accepts `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`, as browsers do."""
    parts = host.split(".")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    if not 1 <= len(parts) <= 4:
        return None
    nums = [_parse_ipv4_part(p) for p in parts]
    if any(n is None for n in nums):
        return None
    values = [n for n in nums if n is not None]
    for n in values[:-1]:
        if n > 255:
            return None
    last = values[-1]
    if last >= 256 ** (5 - len(values)):
        return None
    total = last
    for i, n in enumerate(values[:-1]):
        total += n << (8 * (3 - i))
    return ipaddress.IPv4Address(total)


def parse_ip_literal(host: str) -> IPAddress | None:
    h = host.strip("[]").lower()
    h = h.split("%", 1)[0]
    if ":" in h:
        try:
            return ipaddress.IPv6Address(h)
        except ValueError:
            return None
    if re.fullmatch(r"[0-9a-fx.]+", h) and re.search(r"\d", h):
        return parse_ipv4_literal(h)
    return None


def embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """IPv4 inside IPv6: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d, 6to4 2002:AABB:CCDD::."""
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    packed = ip.packed
    if ip in _NAT64:
        return ipaddress.IPv4Address(packed[12:])
    if packed[:12] == bytes(12) and int.from_bytes(packed[12:], "big") > 1:
        return ipaddress.IPv4Address(packed[12:])
    return None


def canonical_ip(ip: IPAddress) -> IPAddress:
    if isinstance(ip, ipaddress.IPv6Address):
        return embedded_ipv4(ip) or ip
    return ip


def is_metadata_ip(ip: IPAddress) -> bool:
    ip = canonical_ip(ip)
    if isinstance(ip, ipaddress.IPv4Address) and ip in _LINK_LOCAL_V4:
        # The whole IPv4 link-local range is blocked: it hosts AWS/ECS/Azure/GCP metadata services.
        return True
    return ip in METADATA_IPS


def is_private_ip(ip: IPAddress) -> bool:
    ip = canonical_ip(ip)
    if ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_private:
        return True
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT:
        return True
    return not ip.is_global


def is_loopback_ip(ip: IPAddress) -> bool:
    """127.0.0.0/8 and ::1 (including IPv4-in-IPv6 embeddings of 127/8)."""
    return canonical_ip(ip).is_loopback


def is_metadata_host(host: str) -> bool:
    h = host.strip("[]").lower().rstrip(".")
    if h in METADATA_HOSTS:
        return True
    ip = parse_ip_literal(h)
    return ip is not None and is_metadata_ip(ip)


# ---------------------------------------------------------------------------- URL normalisation


def has_scheme(raw: str) -> bool:
    m = _SCHEME_RE.match(raw)
    if not m:
        return False
    scheme = m.group(1).lower()
    return raw[m.end() :].startswith("//") or scheme in _KNOWN_SCHEMES


def normalise_url(raw: str, *, default_scheme: str = "https") -> NormalisedUrl:
    """Normalises user input: trims, adds https:// if missing, IDNA host, drops fragment, canonical IP literals."""
    text = raw.strip()
    if not text:
        raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: empty")
    if any(c in text for c in "\r\n\t\x00 "):
        raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: contains whitespace or control characters")
    if not has_scheme(text):
        text = f"{default_scheme}://{text}"
    try:
        parts = urlsplit(text)
    except ValueError as exc:
        raise UrlRejected(BlockedCode.invalid_url, "Invalid URL") from exc
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise UrlRejected(BlockedCode.unsupported_scheme, f"Unsupported scheme: {scheme or 'none'}")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise UrlRejected(BlockedCode.credentials_in_url, "Credentials in URL are not allowed")
    try:
        hostname = parts.hostname
        port = parts.port
    except ValueError as exc:
        raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: bad port") from exc
    if not hostname:
        raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: missing host")
    hostname = hostname.rstrip(".")
    ip = parse_ip_literal(hostname)
    if ip is not None:
        host = str(ip)
    else:
        if not re.fullmatch(r"[^\s/\\?#@:]+", hostname):
            raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: bad host")
        try:
            host = hostname.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: bad host name") from exc
        if "." not in host and host != "localhost":
            raise UrlRejected(BlockedCode.invalid_url, "Invalid URL: host needs a domain")
    default_port = 443 if scheme == "https" else 80
    explicit = port is not None and port != default_port
    eff_port = port if port is not None else default_port
    netloc_host = f"[{host}]" if ":" in host else host
    netloc = netloc_host + (f":{eff_port}" if explicit else "")
    path = parts.path or "/"
    url = urlunsplit((scheme, netloc, path, parts.query, ""))
    return NormalisedUrl(url=url, scheme=scheme, host=host, port=eff_port, explicit_port=explicit)


# ---------------------------------------------------------------------------- resolution + policy


async def default_resolver(host: str) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


DNS_TIMEOUT_S = 10.0


async def check_host(
    host: str, *, allow_loopback: bool, resolver: Resolver = default_resolver, dns_timeout_s: float = DNS_TIMEOUT_S
) -> TargetCheck:
    """Checks one host. `allow_loopback` must only be true for an approved target with ALLOW_PRIVATE_TARGETS on.

    Even then only loopback (127.0.0.0/8, ::1) is permitted, and only if *every* resolved address is loopback:
    RFC 1918, CGNAT, link-local and other non-public ranges stay blocked, and metadata addresses always are."""
    h = host.strip("[]").lower().rstrip(".")
    if is_metadata_host(h):
        return TargetCheck(False, h, BlockedCode.metadata, BLOCKED_REASONS[BlockedCode.metadata], blocked_ip=h)
    literal = parse_ip_literal(h)
    if literal is not None:
        addrs = [str(literal)]
    else:
        try:
            # getaddrinfo is not bounded by the HTTP timeout and can take 30 s on a slow resolver.
            addrs = await asyncio.wait_for(resolver(h), timeout=dns_timeout_s)
        except TimeoutError:
            return TargetCheck(
                False, h, BlockedCode.dns_failure, f"DNS lookup timed out after {dns_timeout_s:g} s", dns_timed_out=True
            )
        except (OSError, UnicodeError):
            addrs = []
        if not addrs:
            return TargetCheck(False, h, BlockedCode.dns_failure, BLOCKED_REASONS[BlockedCode.dns_failure])
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%", 1)[0])
        if is_metadata_ip(ip):
            return TargetCheck(False, h, BlockedCode.metadata, BLOCKED_REASONS[BlockedCode.metadata], a, addrs)
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%", 1)[0])
        if is_private_ip(ip) and not (allow_loopback and is_loopback_ip(ip)):
            return TargetCheck(
                False, h, BlockedCode.private_address, BLOCKED_REASONS[BlockedCode.private_address], a, addrs
            )
    return TargetCheck(True, h, resolved_ips=addrs)


async def check_url(
    raw: str, *, allow_loopback: bool, resolver: Resolver = default_resolver
) -> tuple[NormalisedUrl | None, TargetCheck]:
    try:
        n = normalise_url(raw)
    except UrlRejected as exc:
        return None, TargetCheck(False, "", exc.code, exc.reason)
    return n, await check_host(n.host, allow_loopback=allow_loopback, resolver=resolver)


def host_matches(host: str, allowed_hosts: list[str]) -> bool:
    h = host.strip("[]").lower()
    return any(h == a or h.endswith(f".{a}") for a in allowed_hosts)
