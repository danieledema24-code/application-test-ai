"""Non-functional evidence for traceability, readiness and the assistant (P5-07).

One loader for "what the latest finished checks and load test say": the latest finished accessibility and security
checks with their findings, the latest judged load test (passed or failed), and the pages any finished accessibility
check covered. Open findings are the ones nobody marked accepted risk, false positive or fixed; heuristics (keyboard)
and "needs review" findings are never counted, the same rule the check page uses.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import PerformanceRun, QualityFinding, QualityScan
from app.domain.enums import FindingStatus, PerfRunStatus, QualityScanKind, QualityScanStatus

SCAN_DONE = (QualityScanStatus.completed, QualityScanStatus.partial, QualityScanStatus.cancelled)
JUDGED = (PerfRunStatus.passed, PerfRunStatus.failed)
NF_CATEGORIES = ("accessibility", "security", "performance")
SEVERE = ("critical", "serious")
SEC_SEVERE = ("high", "medium")


@dataclass
class NfState:
    a11y_scan: QualityScan | None = None
    sec_scan: QualityScan | None = None
    a11y: list[QualityFinding] = field(default_factory=list)
    sec: list[QualityFinding] = field(default_factory=list)
    run: PerformanceRun | None = None
    checked_urls: set[str] = field(default_factory=set)

    def open_a11y(self) -> list[QualityFinding]:
        return [f for f in self.a11y if f.status == FindingStatus.open and counted(f)]

    def open_sec(self) -> list[QualityFinding]:
        return [f for f in self.sec if f.status == FindingStatus.open]

    def missed(self) -> list[dict[str, Any]]:
        return [t for t in (self.run.threshold_results or []) if t.get("result") == "missed"] if self.run else []


def counted(f: QualityFinding) -> bool:
    d = (f.mapped or {}).get("details") or {}
    return not d.get("heuristic") and not d.get("needs_review")


def req_keys(f: QualityFinding) -> list[str]:
    return [str(r.get("key") if isinstance(r, dict) else r) for r in (f.mapped or {}).get("requirements") or []]


async def _latest_scan(s: AsyncSession, project_id: uuid.UUID, kind: QualityScanKind) -> QualityScan | None:
    return (
        (
            await s.execute(
                select(QualityScan)
                .where(
                    QualityScan.project_id == project_id, QualityScan.kind == kind, QualityScan.status.in_(SCAN_DONE)
                )
                .order_by(QualityScan.finished_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )


async def findings_of(s: AsyncSession, scan: QualityScan | None) -> list[QualityFinding]:
    if scan is None:
        return []
    q = select(QualityFinding).where(QualityFinding.scan_id == scan.id).order_by(QualityFinding.key)
    return list((await s.execute(q)).scalars())


async def load(s: AsyncSession, project_id: uuid.UUID) -> NfState:
    st = NfState()
    st.a11y_scan = await _latest_scan(s, project_id, QualityScanKind.accessibility)
    st.sec_scan = await _latest_scan(s, project_id, QualityScanKind.security)
    st.a11y = await findings_of(s, st.a11y_scan)
    st.sec = await findings_of(s, st.sec_scan)
    st.run = (
        (
            await s.execute(
                select(PerformanceRun)
                .where(PerformanceRun.project_id == project_id, PerformanceRun.status.in_(JUDGED))
                .order_by(PerformanceRun.finished_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    for sc in (
        await s.execute(
            select(QualityScan).where(
                QualityScan.project_id == project_id,
                QualityScan.kind == QualityScanKind.accessibility,
                QualityScan.status.in_(SCAN_DONE),
            )
        )
    ).scalars():
        skipped = {n.get("url") for n in sc.not_checked or []}
        st.checked_urls |= {p["url"] for p in (sc.config or {}).get("pages") or [] if p.get("url") not in skipped}
    return st


def per_requirement(st: NfState) -> dict[str, dict[str, Any]]:
    """Requirement key -> {accessibility, security, performance} cells (P5-07). A requirement only gets a cell for
    a type that was checked: no check means "Not checked" in the UI."""
    out: dict[str, dict[str, Any]] = {}
    if st.a11y_scan is not None:
        for f in st.open_a11y():
            for k in req_keys(f):
                cell = out.setdefault(k, {}).setdefault(
                    "accessibility", {"open": 0, "by_severity": {}, "findings": [], "scan_key": st.a11y_scan.key}
                )
                cell["open"] += 1
                cell["by_severity"][f.severity.value] = cell["by_severity"].get(f.severity.value, 0) + 1
                cell["findings"].append(f.key)
    if st.sec_scan is not None:
        for f in st.open_sec():
            for k in req_keys(f):
                cell = out.setdefault(k, {}).setdefault(
                    "security", {"open": 0, "findings": [], "scan_key": st.sec_scan.key}
                )
                cell["open"] += 1
                cell["findings"].append(f.key)
    if st.run is not None:
        for t in st.run.threshold_results or []:
            src = t.get("source") or {}
            if src.get("type") != "requirement" or not src.get("key"):
                continue
            cell = out.setdefault(str(src["key"]), {}).setdefault(
                "performance", {"last_run": st.run.key, "thresholds_failed": 0, "thresholds": 0}
            )
            cell["thresholds"] += 1
            cell["thresholds_failed"] += 1 if t.get("result") == "missed" else 0
    return out
