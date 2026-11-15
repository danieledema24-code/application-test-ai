"""Performance Testing Agent rules (P5-01b, agent G): targets, profiles, thresholds and their results.

Pure functions. Targets are public discovered pages (visited, HTTP 200, same host, not behind sign-in, not a
logout/delete/unsubscribe/download link), at most 10, weighted start page 3, listing/search 2, others 1. Thresholds
come from approved requirements that state a number ("within 2 seconds", "under 500 ms"), otherwise defaults (p95
< 800 ms per page, errors < 1 % overall). Every number is computed here, never by the AI.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from app.domain.enums import PerfProfileType
from app.domain.performance.limits import MAX_TARGETS, LoadLimits, duration_text

DEFAULT_P95_MS = 800
DEFAULT_ERROR_RATE = 0.01
DEFAULT_THINK = {"min": 500, "max": 1500}
DEFAULT_SOURCE = "Default threshold (no requirement states one)"
SKIP = re.compile(r"log-?out|sign-?out|delete|remove|unsubscribe|download|\.(pdf|zip|docx?|xlsx?)$", re.IGNORECASE)
_SPEED_WORDS = re.compile(
    r"\b(load|loads|loaded|respond|responds|response|open|opens|display|displays|render|"
    r"renders|appear|appears|fast|quick|quickly|speed|available)\b",
    re.IGNORECASE,
)
_LIMIT = re.compile(
    r"\b(?:within|under|in under|in less than|less than|below|no more than|at most|faster than|in)\s+"
    r"(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b",
    re.IGNORECASE,
)
TYPE_NAMES = {
    PerfProfileType.load: "Load (steady traffic)",
    PerfProfileType.stress: "Stress (step up to your limit)",
    PerfProfileType.spike: "Spike (sudden jump for 30 s)",
    PerfProfileType.soak: "Short soak (longer, half the users)",
}


def parse_threshold_ms(text: str) -> int | None:
    """'Product pages load within 2 seconds' -> 2000; 'responds in under 500 ms' -> 500; no speed statement -> None."""
    if not _SPEED_WORDS.search(text or ""):
        return None
    m = _LIMIT.search(text or "")
    if m is None:
        return None
    value = float(m.group(1).replace(",", "."))
    unit = m.group(2).lower()
    ms = value if unit.startswith("m") else value * 1000
    return round(ms) if 0 < ms <= 60_000 else None


def path_of(url: str) -> str:
    p = urlsplit(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


@dataclass(frozen=True)
class PageInfo:
    page_id: str
    url: str
    status: int | None
    page_type: str
    requires_auth: bool
    title: str = ""
    visited: bool = True


def eligible(p: PageInfo, host: str) -> str | None:
    """None when the page may be loaded; otherwise why not (shown on the disabled checklist row)."""
    u = urlsplit(p.url)
    if not p.visited:
        return "wasn't visited by discovery"
    if p.requires_auth:
        return "needs sign-in"
    if p.status not in (None, 200):
        return f"answered HTTP {p.status}"
    if (u.hostname or "") != host:
        return "is on another host"
    if SKIP.search(u.path or ""):
        return "looks like a logout, delete or download link"
    return None


def weight(p: PageInfo, start_path: str) -> int:
    path = path_of(p.url)
    if path in (start_path, "/"):
        return 3
    if p.page_type in ("listing", "search"):
        return 2
    return 1


def select_targets(pages: list[PageInfo], host: str, start_path: str = "/") -> list[dict[str, Any]]:
    """Up to 10 targets, the heaviest first (stable by discovery order)."""
    ok = [p for p in pages if eligible(p, host) is None]
    seen: set[str] = set()
    picked: list[dict[str, Any]] = []
    for p in ok:
        path = path_of(p.url)
        if path in seen:
            continue
        seen.add(path)
        picked.append(
            {
                "path": path,
                "weight": weight(p, start_path),
                "page_id": p.page_id,
                "title": p.title[:120],
                "why": _why(p, start_path),
            }
        )
    picked.sort(key=lambda t: -int(t["weight"]))
    return picked[:MAX_TARGETS]


def _why(p: PageInfo, start_path: str) -> str:
    w = weight(p, start_path)
    return "Start page" if w == 3 else ("Listing page" if w == 2 else "")


def stages_for(kind: PerfProfileType, ceiling: LoadLimits) -> list[dict[str, int]]:
    """Default stages per template (design §9.1), within the ceiling."""
    top = ceiling.vus
    if kind == PerfProfileType.load:
        users = min(10, top)
        return [
            {"duration_s": 30, "target_vus": users},
            {"duration_s": 90, "target_vus": users},
            {"duration_s": 10, "target_vus": 0},
        ]
    if kind == PerfProfileType.stress:
        steps = [max(1, top * i // 4) for i in (1, 2, 3, 4)]
        out = []
        for u in steps:
            out += [{"duration_s": 10, "target_vus": u}, {"duration_s": 20, "target_vus": u}]
        return [*out, {"duration_s": 10, "target_vus": 0}]
    if kind == PerfProfileType.spike:
        low = max(1, top // 5)
        return [
            {"duration_s": 20, "target_vus": low},
            {"duration_s": 5, "target_vus": top},
            {"duration_s": 30, "target_vus": top},
            {"duration_s": 5, "target_vus": low},
            {"duration_s": 10, "target_vus": 0},
        ]
    half = max(1, top // 2)
    hold = max(10, ceiling.duration_s - 40)
    return [
        {"duration_s": 30, "target_vus": half},
        {"duration_s": hold, "target_vus": half},
        {"duration_s": 10, "target_vus": 0},
    ]


def thresholds_for(targets: list[dict[str, Any]], req_limits: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Per target p95 (from the requirement mapped to its page when one states a number) and overall errors.

    `req_limits`: page_id -> {ms, key, lineage_id} from the requirement parser."""
    out: list[dict[str, Any]] = []
    for t in targets:
        r = req_limits.get(str(t.get("page_id") or ""))
        if r is not None:
            out.append(
                {
                    "metric": "p95",
                    "scope": "path",
                    "path": t["path"],
                    "op": "<",
                    "value": int(r["ms"]),
                    "source": {"type": "requirement", "key": r["key"], "lineage_id": r["lineage_id"]},
                }
            )
        else:
            out.append(
                {
                    "metric": "p95",
                    "scope": "path",
                    "path": t["path"],
                    "op": "<",
                    "value": DEFAULT_P95_MS,
                    "source": {"type": "default"},
                }
            )
    out.append(
        {"metric": "error_rate", "scope": "all", "op": "<", "value": DEFAULT_ERROR_RATE, "source": {"type": "default"}}
    )
    return out


def numbers(profile: dict[str, Any]) -> tuple[int, int, int, int]:
    """(peak users, max requests a second, total seconds, targets) of a profile snapshot."""
    stages = profile.get("stages") or []
    vus = max((int(s["target_vus"]) for s in stages), default=0)
    return (
        vus,
        int(profile.get("max_rps") or 0),
        sum(int(s["duration_s"]) for s in stages),
        len(profile.get("targets") or []),
    )


def expected_requests(profile: dict[str, Any]) -> int:
    """About how many requests the profile sends: users × time ÷ (mean pause + 0.1 s), capped by max_rps × time."""
    think = profile.get("think_time_ms") or DEFAULT_THINK
    cycle_s = (int(think.get("min", 500)) + int(think.get("max", 1500))) / 2000 + 0.1
    prev = 0
    total = 0.0
    for st in profile.get("stages") or []:
        d, u = int(st["duration_s"]), int(st["target_vus"])
        total += (prev + u) / 2 * d / cycle_s
        prev = u
    _vus, rps, duration, _t = numbers(profile)
    return int(min(total, rps * duration))


def rounded(n: int) -> str:
    """2,086 -> '2,100' (two significant figures, thousands separators)."""
    if n < 100:
        return str(n)
    digits = len(str(n)) - 2
    return f"{round(n, -digits):,}"


def summary_sentence(profile: dict[str, Any], netloc: str) -> str:
    """'Up to 10 virtual users, at most 20 requests a second, for 2 minutes 10 seconds, against localhost:4100;
    GET only; not signed in.' (computed by the server; shown verbatim)."""
    vus, rps, duration, _t = numbers(profile)
    return (
        f"Up to {vus} virtual user{'s' if vus != 1 else ''}, at most {rps} request{'s' if rps != 1 else ''} a second, "
        f"for {duration_text(duration)}, against {netloc}; GET only; not signed in."
    )


def profile_hash(snapshot: dict[str, Any]) -> str:
    basis = {k: snapshot.get(k) for k in ("targets", "stages", "max_rps", "think_time_ms", "thresholds", "origin")}
    return hashlib.sha256(json.dumps(basis, sort_keys=True, default=str).encode()).hexdigest()


def generator_config(snapshot: dict[str, Any], *, origin: str, host: str, allow_private: bool) -> dict[str, Any]:
    """The P5-01a configuration for a run snapshot (only the generator's own keys; never credentials)."""
    return {
        "origin": origin,
        "targets": [{"path": t["path"], "weight": int(t["weight"])} for t in snapshot.get("targets") or []],
        "stages": [
            {"duration_s": int(s["duration_s"]), "target_vus": int(s["target_vus"])}
            for s in snapshot.get("stages") or []
        ],
        "think_time_ms": {
            "min": int((snapshot.get("think_time_ms") or DEFAULT_THINK)["min"]),
            "max": int((snapshot.get("think_time_ms") or DEFAULT_THINK)["max"]),
        },
        "max_rps": int(snapshot["max_rps"]),
        "thresholds": [
            {k: th[k] for k in ("metric", "scope", "path", "op", "value") if k in th}
            for th in snapshot.get("thresholds") or []
        ],
        "allowed_hosts": [host],
        "allow_private": allow_private,
    }


# ------------------------------------------------------------------ results


def ms_text(ms: float | None) -> str:
    if ms is None:
        return "—"
    if ms < 1000:
        return f"{round(ms)} ms"
    return f"{ms / 1000:.1f} s"


def evaluate(thresholds: list[dict[str, Any]], summary: dict[str, Any], *, judged: bool) -> list[dict[str, Any]]:
    """Threshold results in code: met / missed, or `not_measured` (values still shown) when the run stopped early
    (decision on design open question 7)."""
    targets = {t.get("path"): t for t in summary.get("targets") or []}
    overall = summary.get("overall") or {}
    out = []
    for th in thresholds:
        scope = th.get("path") if th.get("scope") == "path" else None
        stats = targets.get(scope) if scope else overall
        measured: float | None
        if th["metric"] == "error_rate":
            measured = float((stats or {}).get("error_rate") or 0.0) if stats else None
        else:
            measured = ((stats or {}).get("latency_ms") or {}).get(th["metric"]) if stats else None
        if measured is None or not (stats or {}).get("count") or not judged:
            result = "not_measured"
        else:
            ok = measured < th["value"] if th.get("op", "<") == "<" else measured <= th["value"]
            result = "met" if ok else "missed"
        out.append({**th, "measured": measured, "result": result})
    out.sort(key=lambda r: {"missed": 0, "met": 1, "not_measured": 2}[r["result"]])
    return out


def defect_text(th: dict[str, Any], *, users: int, page_title: str | None) -> tuple[str, str, str]:
    """(summary, expected, actual) of a missed-threshold draft (D20)."""
    src = (
        "Default threshold" if (th.get("source") or {}).get("type") != "requirement" else f"From {th['source']['key']}"
    )
    if th["metric"] == "error_rate":
        rate = f"{float(th['measured']) * 100:.1f} %"
        limit = f"{float(th['value']) * 100:g} %"
        return (
            f"Requests fail under load ({rate} errors with {users} users; threshold {limit})",
            f"[{src}] Errors under {limit}",
            f"[Measured] {rate} of requests failed",
        )
    name = (page_title or "").split("·")[0].strip()
    what = f"{name} page" if name else f"{th.get('path')}"
    measured, limit = ms_text(th["measured"]), ms_text(th["value"])
    pct = str(th["metric"])[1:]  # p95 -> 95, p99 -> 99
    return (
        f"{what} slows down under load ({th['metric']} {measured} with {users} users; threshold {limit})"[:300],
        f"[{src}] {pct} % of requests to {th.get('path')} faster than {limit}",
        f"[Measured] {pct} % of requests to {th.get('path')} were faster than {measured} ({th['metric']})",
    )
