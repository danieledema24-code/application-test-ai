"""Application Discovery Agent (agent A). Runs one scan session: crawl, capture evidence, analyse, persist.

Tools are enforced by `ToolRegistry`, not by a prompt: browser navigation is same-site and policy-checked, the
LLM (if enabled) sees page summaries only inside untrusted blocks and has no tools.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.base import ToolRegistry
from app.agents.discovery import heuristics as h
from app.agents.discovery.completeness import CompletenessInput, assess, recommend
from app.agents.discovery.crawler import (
    CapturedPage,
    Control,
    Crawler,
    CrawlResult,
    FailedPage,
    Frontier,
    canonical,
    parse_robots,
)
from app.agents.discovery.schemas import (
    Completeness,
    DiscoveryLimits,
    EvidenceRefModel,
    ExtractedComponent,
    ExtractedForm,
    FeatureCandidate,
    GateRecommendationModel,
    JourneyCandidate,
    JourneyStep,
    LlmDiscoveryAnalysis,
    NavLink,
)
from app.browser.network_policy import NetworkPolicy
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    DiscoveredPage,
    Evidence,
    Job,
    KnowledgeItem,
    Project,
    ProjectUrl,
    ScanSession,
    UserJourney,
    feature_pages,
)
from app.db.tenant import TenantScope, bind_scope
from app.db.types import utcnow
from app.domain.enums import (
    EventLevel,
    EvidenceKind,
    GeneratedBy,
    KnowledgeKind,
    KnowledgeStatus,
    PageStatus,
    PageType,
    Provenance,
    ScanStatus,
)
from app.llm.base import Budget, UntrustedBlock
from app.llm.injection import detect_injection
from app.security.ssrf import normalise_url
from app.services.counters import next_key
from app.services.evidence import write_evidence
from app.services.url_check import fetch_robots, safe_fetch

log = logging.getLogger(__name__)
AGENT_KEY = "discovery"
STAGE_KEY = "discovery"

DISCOVERY_TOOLS = frozenset(
    {
        "browser.navigate",
        "browser.extract",
        "browser.aria_snapshot",
        "browser.screenshot",
        "browser.capture_console_network",
        "http.probe",
        "evidence.write",
        "kb.propose",
        "llm.structured",
    }
)

_STAT_KEYS = (
    "pages",
    "pages_failed",
    "forms",
    "inputs",
    "buttons",
    "links",
    "dropdowns",
    "tables",
    "modals",
    "search",
    "filters",
    "tabs",
    "pagination",
    "components",
    "console_errors",
    "failed_requests",
    "blocked_requests",
    "screenshots",
    "queued",
    "access_gaps",
)


def empty_stats() -> dict[str, Any]:
    stats: dict[str, Any] = dict.fromkeys(_STAT_KEYS, 0)
    stats["elapsed_s"] = 0
    return stats


@dataclass
class DiscoveryOutcome:
    scan_status: ScanStatus
    partial: bool
    paused: bool
    generated_by: GeneratedBy
    validation_issues: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    recommendation: GateRecommendationModel | None = None
    output: dict[str, Any] = field(default_factory=dict)
    llm_usage: dict[str, Any] | None = None


class _DbSink:
    """CrawlSink that persists each page and its evidence immediately and emits live events."""

    def __init__(self, agent: DiscoveryAgent) -> None:
        self.a = agent
        self.page_ids: dict[str, uuid.UUID] = {}
        self.sequence = 0

    async def load_existing(self) -> None:
        async with self.a.session() as s:
            rows = (
                await s.execute(
                    select(
                        DiscoveredPage.id, DiscoveredPage.url, DiscoveredPage.final_url, DiscoveredPage.sequence
                    ).where(DiscoveredPage.scan_session_id == self.a.scan_id)
                )
            ).all()
            for pid, url, final_url, seq in rows:
                self.page_ids[canonical(url)] = pid
                if final_url:
                    self.page_ids[canonical(final_url)] = pid
                self.sequence = max(self.sequence, seq)

    async def control(self) -> Control:
        async with self.a.session() as s:
            ctl = (
                await s.execute(select(ScanSession.control).where(ScanSession.id == self.a.scan_id))
            ).scalar_one_or_none()
            if self.a.job_id is not None:
                cancel = (
                    await s.execute(select(Job.cancel_requested).where(Job.id == self.a.job_id))
                ).scalar_one_or_none()
                if cancel and ctl is None:
                    ctl = "cancel"
        return "pause" if ctl == "pause" else "cancel" if ctl == "cancel" else None

    async def on_visiting(self, url: str, done: int, total: int | None) -> None:
        path = h.path_of(url)
        async with self.a.session() as s:
            scan = await self.a.load_scan(s)
            scan.current = {
                "url": url,
                "title": "",
                "screenshot_evidence_id": (scan.current or {}).get("screenshot_evidence_id"),
            }
            await s.commit()
        await self.a.emit("log", f"Visiting {path}", data={"kind": "action", "url": url, "path": path})
        await self.a.emit(
            "task.progress", f"{done} of up to {total} pages", data={"done": done, "total": total, "label": "pages"}
        )

    async def on_skip(self, url: str, reason: str) -> None:
        path = h.path_of(url)
        await self.a.emit(
            "log", f"Skipped {path} — {reason}", data={"kind": "skip", "url": url, "path": path, "reason": reason}
        )

    async def save_frontier(self, frontier: Frontier) -> None:
        async with self.a.session() as s:
            scan = await self.a.load_scan(s)
            scan.frontier = frontier.to_json()
            stats = dict(scan.stats or empty_stats())
            stats["queued"] = len(frontier.queue)
            stats["elapsed_s"] = int(frontier.elapsed_s)
            stats["blocked_requests"] = (
                len(self.a.policy.blocked) if self.a.policy else stats.get("blocked_requests", 0)
            )
            scan.stats = stats
            if self.a.policy is not None:
                scan.blocked_requests = list(self.a.policy.blocked)
            await s.commit()

    def _parent(self, parent_url: str | None) -> uuid.UUID | None:
        return self.page_ids.get(canonical(parent_url)) if parent_url else None

    async def on_page(self, cp: CapturedPage) -> None:
        a = self.a
        ex = cp.extract
        components = ex.components
        forms = ex.forms
        counts = h.page_counts(forms, components, ex.counts.get("links", len(ex.links)))
        page_type = h.classify_page(
            cp.final_url,
            cp.status,
            depth=cp.depth,
            forms=forms,
            components=components,
            has_password=ex.has_password,
            title=ex.title,
        )
        self.sequence += 1
        page_id = uuid.uuid4()
        url_key = canonical(cp.final_url)
        injection = detect_injection(f"{ex.text}\n{ex.hidden_text}")
        async with a.session() as s:
            evid: dict[str, Evidence] = {}
            name = (urlsplit(cp.final_url).path.strip("/").replace("/", "_") or "home")[:60]
            page_row = DiscoveredPage(
                id=page_id,
                organisation_id=a.scope.org_id,
                scan_session_id=a.scan_id,
                project_id=a.project_id,
                url=cp.final_url,
                url_hash=hashlib.sha256(url_key.encode()).hexdigest(),
                canonical_url=url_key,
                final_url=cp.final_url,
                title=ex.title[:500],
                http_status=cp.status,
                status=PageStatus.visited,
                depth=cp.depth,
                sequence=self.sequence,
                parent_page_id=self._parent(cp.parent_url),
                found_via="redirect" if cp.redirected_from else cp.found_via,
                redirected_from=cp.redirected_from,
                page_type=page_type,
                # A sign-in page that loaded is public; only a URL that redirected to it required signing in.
                requires_auth=page_type == PageType.auth and bool(cp.redirected_from),
                headings=[x.text for x in ex.headings],
                nav_links=[x.model_dump() for x in ex.nav_links],
                links=[link.href for link in ex.links if a.crawler and a.crawler._same_site(link.href)][:200],
                load_ms=cp.load_ms,
                console_issues=cp.console,
                network_issues=cp.network,
            )
            s.add(page_row)
            await s.flush()
            if cp.screenshot:
                evid["desktop"] = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.screenshot,
                    data=cp.screenshot,
                    mime="image/jpeg",
                    name=f"{name}-desktop.jpg",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=cp.final_url,
                    viewport="desktop 1440x900",
                    metadata={
                        "title": ex.title[:200],
                        "alt": f"Screenshot of {ex.title or 'page'} ({h.path_of(cp.final_url)}), desktop",
                    },
                )
            if cp.mobile_screenshot:
                evid["mobile"] = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.screenshot,
                    data=cp.mobile_screenshot,
                    mime="image/jpeg",
                    name=f"{name}-mobile.jpg",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=cp.final_url,
                    viewport="mobile 390x844",
                    metadata={
                        "title": ex.title[:200],
                        "alt": f"Screenshot of {ex.title or 'page'} ({h.path_of(cp.final_url)}), mobile",
                    },
                )
            if cp.dom_html:
                evid["dom"] = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.dom_snapshot,
                    data=cp.dom_html.encode("utf-8"),
                    mime="text/plain; charset=utf-8",
                    name=f"{name}-dom.html.txt",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=cp.final_url,
                    metadata={"note": "Sanitised DOM: password and hidden input values removed"},
                )
            if cp.aria:
                evid["aria"] = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.aria_snapshot,
                    data=cp.aria.encode("utf-8"),
                    mime="text/yaml; charset=utf-8",
                    name=f"{name}-aria.yaml",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=cp.final_url,
                )
            if cp.console or cp.network:
                evid["console"] = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.console_log,
                    data=json.dumps({"console": cp.console, "network": cp.network}, indent=2).encode(),
                    mime="application/json",
                    name=f"{name}-console-network.json",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=cp.final_url,
                )
            if injection:
                evid["text"] = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.page_text,
                    data=(ex.text + "\n\n--- hidden text ---\n" + ex.hidden_text).encode("utf-8"),
                    mime="text/plain; charset=utf-8",
                    name=f"{name}-text.txt",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=cp.final_url,
                )
            dom_id = evid["dom"].id if "dom" in evid else None
            page_row.forms = [_form_dto(f, dom_id) for f in forms]
            page_row.components = [_component_dto(c, dom_id) for c in components]
            page_row.counts = counts
            page_row.screenshot_evidence_id = evid["desktop"].id if "desktop" in evid else None
            page_row.responsive = {
                vp: {
                    "viewport": "desktop 1440x900" if vp == "desktop" else "mobile 390x844",
                    "nav_collapsed": bool(obs.menu_button and obs.nav_links_visible < obs.nav_links_total),
                    "horizontal_overflow": obs.horizontal_overflow,
                    "screenshot_evidence_id": str(evid[vp].id) if vp in evid else None,
                }
                for vp, obs in cp.responsive.items()
            }
            page_row.structure_hash = hashlib.sha256(
                json.dumps(
                    [page_row.headings, [c["fingerprint"] for c in page_row.components]], sort_keys=True
                ).encode()
            ).hexdigest()
            scan = await a.load_scan(s)
            stats = dict(scan.stats or empty_stats())
            stats["pages"] += 1
            for k in (
                "forms",
                "inputs",
                "buttons",
                "links",
                "dropdowns",
                "tables",
                "modals",
                "search",
                "filters",
                "tabs",
                "pagination",
            ):
                stats[k] = stats.get(k, 0) + counts.get(k, 0)
            stats["components"] = stats.get("components", 0) + len(components)
            stats["console_errors"] = stats.get("console_errors", 0) + sum(
                1 for c in cp.console if c["level"] == "error"
            )
            stats["failed_requests"] = stats.get("failed_requests", 0) + len(cp.network)
            stats["screenshots"] = stats.get("screenshots", 0) + sum(1 for k in ("desktop", "mobile") if k in evid)
            scan.stats = stats
            scan.current = {
                "url": cp.final_url,
                "title": ex.title[:200],
                "screenshot_evidence_id": str(page_row.screenshot_evidence_id)
                if page_row.screenshot_evidence_id
                else None,
            }
            if ex.captcha:
                scan.robots = {**(scan.robots or {}), "bot_protection": True}
            if injection:
                flags = list(scan.injection_flags or [])
                for m in injection[:3]:
                    flags.append(
                        {
                            "page_url": cp.final_url,
                            "page_id": str(page_id),
                            "excerpt": m.excerpt[:300],
                            "evidence_refs": [
                                {
                                    "evidence_id": str(evid["text"].id),
                                    "excerpt": m.excerpt[:300],
                                    "selector": None,
                                    "note": "Page text (untrusted)",
                                }
                            ],
                        }
                    )
                scan.injection_flags = flags
                s.add(
                    KnowledgeItem(
                        organisation_id=a.scope.org_id,
                        project_id=a.project_id,
                        kind=KnowledgeKind.fact,
                        title=f"Text addressed to AI agents on {h.path_of(cp.final_url)}",
                        content="Page text contained instruction-like content addressed to AI agents. It was treated as untrusted data and ignored.",
                        provenance=Provenance.observed,
                        evidence_refs=[{"evidence_id": str(evid["text"].id), "excerpt": injection[0].excerpt[:300]}],
                        source=AGENT_KEY,
                        status=KnowledgeStatus.active,
                        scan_session_id=a.scan_id,
                    )
                )
            await s.commit()
        self.page_ids[url_key] = page_id
        self.page_ids[canonical(cp.url)] = page_id
        path = h.path_of(cp.final_url)
        shot = evid.get("desktop")
        await a.emit(
            "page.discovered",
            f'Found page "{ex.title or path}" ({path})',
            data={
                "kind": "finding",
                "label": "observed",
                "page_id": str(page_id),
                "url": cp.final_url,
                "path": path,
                "title": ex.title[:200],
                "page_type": page_type.value,
                "counts": counts,
                "screenshot": {"id": str(shot.id), "content_url": a.ctx.evidence_url(shot.id, a.scope.org_id)}
                if shot
                else None,
                "evidence_ids": [str(e.id) for e in evid.values()],
            },
        )
        if evid:
            await a.emit(
                "evidence.captured",
                f"Captured {len(evid)} evidence item{'s' if len(evid) != 1 else ''} for {path}",
                data={
                    "kind": "action",
                    "page_id": str(page_id),
                    "evidence_ids": [str(e.id) for e in evid.values()],
                    "path": path,
                },
            )
        for f in forms:
            label = h.form_display_name(f)
            await a.emit(
                "log",
                f"Found form: {label} ({len(f.fields)} field{'s' if len(f.fields) != 1 else ''})",
                data={
                    "kind": "finding",
                    "label": "observed",
                    "path": path,
                    "page_id": str(page_id),
                    "evidence_ids": [str(e.id) for k, e in evid.items() if k in ("dom", "desktop")],
                },
            )
        for c in components:
            if c.kind == "button" and (
                c.details.get("destructive") or (c.details.get("transactional") and not c.details.get("in_form"))
            ):
                await a.emit(
                    "log",
                    f"Skipped '{c.name[:60]}' button — destructive and transactional actions are never performed",
                    data={"kind": "skip", "path": path, "page_id": str(page_id)},
                )
        if page_type == PageType.auth:
            await a.emit(
                "log",
                f"Found auth boundary: {path} has a sign-in form"
                if not cp.redirected_from
                else f"Found auth boundary: {h.path_of(cp.redirected_from)} redirects to {path}",
                data={"kind": "finding", "label": "observed", "path": path, "page_id": str(page_id)},
            )
        if injection:
            await a.emit(
                "log",
                f"Page text on {path} contained instructions addressed to AI agents. Treated as page content and ignored.",
                level=EventLevel.warn,
                data={"kind": "warning", "path": path, "page_id": str(page_id), "evidence_ids": [str(evid["text"].id)]},
            )

    async def on_failed(self, fp: FailedPage) -> None:
        a = self.a
        self.sequence += 1
        page_id = uuid.uuid4()
        key = canonical(fp.url)
        path = h.path_of(fp.url)
        async with a.session() as s:
            row = DiscoveredPage(
                id=page_id,
                organisation_id=a.scope.org_id,
                scan_session_id=a.scan_id,
                project_id=a.project_id,
                url=fp.url,
                url_hash=hashlib.sha256(key.encode()).hexdigest(),
                canonical_url=key,
                final_url=fp.redirected_from,
                title=fp.title,
                http_status=fp.status,
                status=PageStatus.blocked if "blocked" in fp.reason.lower() else PageStatus.failed,
                failure_reason=fp.reason,
                depth=fp.depth,
                sequence=self.sequence,
                parent_page_id=self._parent(fp.parent_url),
                found_via=fp.found_via,
                page_type=PageType.auth
                if fp.status in (401, 403) or (fp.redirected_from and "login" in fp.redirected_from)
                else PageType.error,
                requires_auth=fp.status in (401, 403) or bool(fp.redirected_from and "login" in fp.redirected_from),
            )
            s.add(row)
            await s.flush()
            ev = None
            if fp.screenshot:
                ev = await write_evidence(
                    s,
                    a.ctx.storage,
                    org_id=a.scope.org_id,
                    project_id=a.project_id,
                    kind=EvidenceKind.screenshot,
                    data=fp.screenshot,
                    mime="image/jpeg",
                    name=f"{(path.strip('/') or 'home')[:60]}-error.jpg",
                    owner_id=a.scan_id,
                    scan_session_id=a.scan_id,
                    page_id=page_id,
                    source_url=fp.url,
                    viewport="desktop 1440x900",
                    metadata={"alt": f"Screenshot of {path} ({fp.reason})"},
                )
                row.screenshot_evidence_id = ev.id
            scan = await a.load_scan(s)
            stats = dict(scan.stats or empty_stats())
            stats["pages_failed"] = stats.get("pages_failed", 0) + 1
            if ev:
                stats["screenshots"] = stats.get("screenshots", 0) + 1
            scan.stats = stats
            await s.commit()
        self.page_ids[key] = page_id
        if fp.status in (401, 403):
            await a.emit(
                "log",
                f"Found auth boundary: {path} requires sign-in (HTTP {fp.status})",
                data={
                    "kind": "finding",
                    "label": "observed",
                    "path": path,
                    "page_id": str(page_id),
                    "evidence_ids": [str(ev.id)] if ev else [],
                },
            )
        elif fp.redirected_from:
            await a.emit(
                "log",
                f"Found auth boundary: {path} redirects to {h.path_of(fp.redirected_from)}",
                data={"kind": "finding", "label": "observed", "path": path, "page_id": str(page_id)},
            )
        else:
            await a.emit(
                "page.failed",
                f"Couldn't load {path} — {fp.reason}",
                level=EventLevel.warn,
                data={"kind": "warning", "url": fp.url, "path": path, "reason": fp.reason, "page_id": str(page_id)},
            )
        if "blocked" in fp.reason.lower():
            await a.emit(
                "request.blocked",
                f"Blocked {path}: {fp.reason}",
                level=EventLevel.warn,
                data={"kind": "warning", "url": fp.url, "reason": fp.reason},
            )


def _fingerprint(kind: str, role: str | None, name: str, selector: str) -> str:
    return hashlib.sha1(f"{kind}|{role}|{name.lower()}|{selector}".encode(), usedforsecurity=False).hexdigest()[:16]


def _form_dto(f: ExtractedForm, dom_id: uuid.UUID | None) -> dict[str, Any]:
    return {
        "name": f.name or f.heading,
        "method": f.method,
        "action": f.action,
        "purpose_guess": h.form_purpose(f),
        "submit_label": f.submit_label,
        "selector": f.selector,
        "locator": f.locator,
        "fields": [
            {
                "name": x.name,
                "type": x.type,
                "label": x.label,
                "required": x.required,
                "placeholder": x.placeholder,
                "constraints": {
                    "min": x.constraints.min,
                    "max": x.constraints.max,
                    "maxlength": x.constraints.maxlength,
                    "minlength": x.constraints.minlength,
                    "pattern": x.constraints.pattern,
                },
                "options": x.options,
                "locator": x.locator,
                "autocomplete": x.autocomplete,
            }
            for x in f.fields
        ],
        "evidence_refs": [{"evidence_id": str(dom_id), "selector": f.selector, "excerpt": f.html[:300], "note": None}]
        if dom_id
        else [],
    }


def _component_dto(c: ExtractedComponent, dom_id: uuid.UUID | None) -> dict[str, Any]:
    return {
        "kind": c.kind,
        "role": c.role,
        "name": c.name[:120],
        "locator": c.locator,
        "locators": c.locators[:6],
        "fingerprint": _fingerprint(c.kind, c.role, c.name, c.selector),
        "details": {**c.details, "visible": c.visible, "selector": c.selector},
        "evidence_refs": [{"evidence_id": str(dom_id), "selector": c.selector, "excerpt": c.html[:300], "note": None}]
        if dom_id
        else [],
    }


class DiscoveryAgent:
    key = AGENT_KEY
    input_model = DiscoveryLimits
    output_model = Completeness

    def __init__(
        self,
        ctx: AppContext,
        scope: TenantScope,
        *,
        project_id: uuid.UUID,
        scan_id: uuid.UUID,
        stage_run_id: uuid.UUID,
        task_id: uuid.UUID,
        job_id: uuid.UUID | None,
    ) -> None:
        self.ctx = ctx
        self.scope = scope
        self.project_id = project_id
        self.scan_id = scan_id
        self.stage_run_id = stage_run_id
        self.task_id = task_id
        self.job_id = job_id
        self.tools = ToolRegistry(AGENT_KEY, DISCOVERY_TOOLS)
        self.policy: NetworkPolicy | None = None
        self.crawler: Crawler | None = None

    # ------------------------------------------------------------------ helpers

    def session(self) -> AsyncSession:
        s = self.ctx.session_factory()
        bind_scope(s, self.scope)
        return s

    async def load_scan(self, s: AsyncSession) -> ScanSession:
        return (await s.execute(select(ScanSession).where(ScanSession.id == self.scan_id))).scalar_one()

    async def emit(
        self, type_: str, message: str, *, level: EventLevel = EventLevel.info, data: dict[str, Any] | None = None
    ) -> None:
        await self.ctx.events.emit(
            org_id=self.scope.org_id,
            project_id=self.project_id,
            type=type_,
            message=message,
            level=level,
            stage_key=STAGE_KEY,
            agent_key=AGENT_KEY,
            task_id=self.task_id,
            data=data,
        )

    # ------------------------------------------------------------------ run

    async def run(self) -> DiscoveryOutcome:
        s_ = self.ctx.settings
        async with self.session() as s:
            scan = await self.load_scan(s)
            limits = DiscoveryLimits.model_validate(
                {
                    **scan.limits,
                    "page_timeout_s": s_.scan_page_timeout_s,
                    "total_timeout_s": s_.scan_time_limit_s,
                    "politeness_ms": s_.scan_politeness_delay_ms,
                    "mobile_sample": s_.scan_mobile_sample_pages,
                }
                | {
                    k: v
                    for k, v in scan.limits.items()
                    if k in ("page_timeout_s", "total_timeout_s", "politeness_ms", "mobile_sample")
                }
            )
            resumed = bool(scan.frontier.get("started"))
            frontier = Frontier.from_json(scan.frontier) if resumed else None
            start = normalise_url(scan.start_url)
            scan.status = ScanStatus.running
            scan.control = None
            scan.started_at = scan.started_at or utcnow()
            if not scan.stats:
                scan.stats = empty_stats()
            await s.commit()
            robots_state = dict(scan.robots or {})
        await self.emit(
            "task.started",
            "Resumed Application Discovery" if resumed else "Started Application Discovery",
            data={"kind": "status", "resumed": resumed},
        )
        allowed_hosts = [start.host]
        self.policy = NetworkPolicy(
            approved_origins={start.origin},
            allowed_hosts=allowed_hosts,
            allow_private_targets=s_.allow_private_targets,
            resolver=self.ctx.resolver,
            fetch_timeout_ms=limits.page_timeout_s * 1000,
        )
        if frontier is not None:
            async with self.session() as s:
                self.policy.blocked = list((await self.load_scan(s)).blocked_requests or [])
        robots_parser = None
        sitemap_urls: list[str] = []
        self.tools.require("http.probe")
        robots_text, _ = await fetch_robots(self.ctx, start, {start.origin})
        if robots_text is not None:
            robots_parser, sitemaps = parse_robots(robots_text)
            robots_state.update(
                found=True, disallows_start=not robots_parser.can_fetch("*", start.url), sitemaps=sitemaps[:5]
            )
        else:
            robots_state.update(found=False, disallows_start=False, sitemaps=[])
        if not resumed:
            sitemap_urls = await self._sitemap_urls(start, robots_state.get("sitemaps", []))
            robots_state["sitemap_urls"] = len(sitemap_urls)
        async with self.session() as s:
            scan = await self.load_scan(s)
            scan.robots = robots_state
            await s.commit()
        if robots_state.get("disallows_start") and limits.respect_robots:
            await self.emit(
                "log",
                "robots.txt disallows the start page for automated agents; it is not visited.",
                level=EventLevel.warn,
                data={"kind": "warning"},
            )
        sink = _DbSink(self)
        await sink.load_existing()
        self.tools.require("browser.navigate")
        try:
            async with self.ctx.browser_pool.isolated_context(self.policy) as context:
                await self.emit(
                    "log", "Launched isolated Chromium browser (desktop 1440 × 900)", data={"kind": "action"}
                )
                self.crawler = Crawler(
                    context=context,
                    policy=self.policy,
                    start_url=start.url,
                    allowed_hosts=allowed_hosts,
                    limits=limits,
                    sink=_SkipFlushingSink(sink, self),
                    robots=robots_parser,
                    sitemap_urls=sitemap_urls,
                    max_dom_bytes=s_.scan_max_dom_bytes,
                )
                if frontier is not None:
                    async with self.session() as s:
                        prior = (await self.load_scan(s)).skipped_links or []
                    for item in prior:
                        self.crawler.skipped[item["url"]] = item["reason"]
                result = await self.crawler.run(frontier)
        except Exception as exc:
            log.exception("discovery browser failed")
            result = CrawlResult(
                stop="failed",
                frontier=frontier or Frontier(),
                not_visited=[],
                skipped_links=[],
                external_links=[],
                robots_skipped=[],
                robots=None,
                error=f"The browser could not be started ({str(exc).splitlines()[0][:160]}).",
            )
        return await self._finish(result, limits)

    async def _sitemap_urls(self, start: Any, sitemaps: list[str]) -> list[str]:
        candidates = list(dict.fromkeys([*sitemaps, f"{start.origin}/sitemap.xml"]))[:3]
        urls: list[str] = []
        for sm in candidates:
            try:
                n = normalise_url(sm)
            except ValueError:
                continue
            if n.host != start.host:
                continue
            res = await safe_fetch(self.ctx, n, approved_origins={start.origin}, max_redirects=2)
            if not res.ok or res.status != 200:
                continue
            text = res.body.decode("utf-8", errors="replace")
            for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", text)[:500]:
                if urlsplit(loc).hostname == start.host:
                    urls.append(loc)
        return list(dict.fromkeys(urls))

    # ------------------------------------------------------------------ finish + analysis

    async def _finish(self, result: CrawlResult, limits: DiscoveryLimits) -> DiscoveryOutcome:
        assert self.policy is not None
        if result.stop == "paused":
            async with self.session() as s:
                scan = await self.load_scan(s)
                scan.status = ScanStatus.paused
                scan.control = None
                scan.skipped_links = result.skipped_links
                scan.external_links = result.external_links
                await s.commit()
                pages = scan.stats.get("pages", 0)
            await self.emit(
                "log",
                f"Discovery paused. {pages} page{'' if pages == 1 else 's'} visited so far.",
                data={"kind": "status"},
            )
            return DiscoveryOutcome(ScanStatus.paused, partial=True, paused=True, generated_by=GeneratedBy.rules)

        async with self.session() as s:
            scan = await self.load_scan(s)
            project = (await s.execute(select(Project).where(Project.id == self.project_id))).scalar_one()
            has_credentials = (
                await s.execute(
                    select(ProjectUrl.credentials_secret_id).where(ProjectUrl.project_id == self.project_id)
                )
            ).scalars().first() is not None
            rows = list(
                (
                    await s.execute(
                        select(DiscoveredPage)
                        .where(DiscoveredPage.scan_session_id == self.scan_id)
                        .order_by(DiscoveredPage.sequence)
                    )
                )
                .scalars()
                .all()
            )
            dom_by_page = dict(
                (
                    await s.execute(
                        select(Evidence.page_id, Evidence.id).where(
                            Evidence.scan_session_id == self.scan_id, Evidence.kind == EvidenceKind.dom_snapshot
                        )
                    )
                ).all()
            )
            evidence_ids = {
                str(e)
                for e in (
                    await s.execute(select(Evidence.id).where(Evidence.scan_session_id == self.scan_id))
                ).scalars()
            }
            _ = project
        views = [_view(r, dom_by_page.get(r.id)) for r in rows]
        visited = [v for v in views if not v.failed]
        stop = result.stop
        stopped_early = stop if stop in ("cancelled", "timeout", "failed") else None
        reason = result.stop_reason
        limit_skipped = len(result.not_visited) if reason == "page_limit" else 0

        issues: list[dict[str, Any]] = []
        features = h.build_features(views)
        journeys = h.build_journeys(views)
        generated_by = GeneratedBy.rules
        summary_by = GeneratedBy.rules
        summary: str | None = None
        llm_usage: dict[str, Any] | None = None
        if self.ctx.llm.enabled and visited:
            self.tools.require("llm.structured")
            ai = await self._ai_analysis(views, evidence_ids, issues)
            if ai is not None:
                ai_features, ai_journeys, ai_summary, llm_usage = ai
                if ai_features:
                    features = ai_features
                if ai_journeys:
                    journeys = ai_journeys
                if ai_summary:
                    summary, summary_by = ai_summary, GeneratedBy.ai
                kinds = {bool(ai_features), bool(ai_journeys)}
                generated_by = (
                    GeneratedBy.ai if kinds == {True} else GeneratedBy.mixed if True in kinds else GeneratedBy.rules
                )
        boundaries = h.auth_boundaries(views)
        bot = bool((scan.robots or {}).get("bot_protection"))
        gaps = h.access_gaps(
            views,
            not_visited=len(result.not_visited),
            stop_reason=reason,
            max_pages=limits.max_pages,
            robots_skipped=result.robots_skipped,
            skipped_links=result.skipped_links,
            bot_protection=bot,
        )
        # Areas that could not be observed without signing in; the same list drives the "Needs credentials" gaps,
        # the Gate 2 completeness line, the summary and the limitation. A visible sign-in page is a boundary; when
        # it is the only signal, the signed-in area behind it counts as one area.
        auth_areas = list(dict.fromkeys(h.path_of(b["url"]) for b in boundaries if b["kind"] != "login_form"))
        login_forms = list(dict.fromkeys(h.path_of(b["url"]) for b in boundaries if b["kind"] == "login_form"))
        if not auth_areas and login_forms:
            auth_areas = [h.signed_in_area_label(login_forms)]
        failed_loads = [v.path for v in views if v.failed and v.status not in (401, 403, 404) and not v.redirect_target]
        mobile_captured = all("mobile" in (r.responsive or {}) for r in rows if r.status == PageStatus.visited)
        completeness = assess(
            CompletenessInput(
                visited=len(visited),
                found_total=len(views) + len(result.not_visited),
                not_visited_limit=limit_skipped,
                not_visited_stopped=len(result.not_visited) - limit_skipped,
                max_pages=limits.max_pages,
                auth_areas=auth_areas,
                failed_loads=failed_loads,
                broken_links=sum(1 for v in views if v.status == 404),
                stopped_early=stopped_early,
                mobile_captured=mobile_captured and limits.include_mobile,
                mobile_requested=limits.include_mobile,
                forms=sum(len(v.forms) for v in visited),
                journeys=len(journeys),
                bot_protection=bot,
                robots_skipped=len(result.robots_skipped),
            )
        )
        rec = recommend(completeness, auth_gaps=bool(auth_areas), stop_reason=reason)
        limitations = self._limitations(result, limits, scan, views, has_credentials, bool(auth_areas))
        if summary is None:
            summary = _rules_summary(views, features, journeys, auth_areas, urlsplit(scan.start_url).hostname or "")

        if not visited:
            scan_status = ScanStatus.failed if stop != "cancelled" else ScanStatus.cancelled
        elif stop == "completed":
            scan_status = ScanStatus.completed
        elif stop == "cancelled":
            scan_status = ScanStatus.cancelled
        else:
            scan_status = ScanStatus.partial
        error = result.error
        if not visited and error is None and stop != "cancelled":
            first_fail = next((v for v in views if v.failed), None)
            error = (
                f"No pages could be explored ({first_fail.failure_reason})."
                if first_fail and first_fail.failure_reason
                else "No pages could be explored. The site may block automated browsers."
            )
        partial = bool(result.not_visited) or stop in ("cancelled", "timeout", "failed")

        async with self.session() as s:
            scan = await self.load_scan(s)
            page_ids = {r.id for r in rows}
            feature_rows: list[ApplicationFeature] = []
            for f in features:
                _, key = await next_key(s, self.scope.org_id, self.project_id, "feature")
                row = ApplicationFeature(
                    organisation_id=self.scope.org_id,
                    scan_session_id=self.scan_id,
                    stage_run_id=self.stage_run_id,
                    project_id=self.project_id,
                    key=key,
                    name=f.name[:200],
                    description=f.description,
                    category=f.category,
                    provenance=f.provenance,
                    confidence=f.confidence,
                    evidence_refs=[r.model_dump(mode="json") for r in f.evidence_refs],
                    generated_by=f.generated_by,
                    page_ids=[str(p) for p in f.page_ids if p in page_ids],
                    reason=f.reason,
                )
                s.add(row)
                feature_rows.append(row)
            await s.flush()
            for row in feature_rows:
                for pid in row.page_ids:
                    await s.execute(feature_pages.insert().values(feature_id=row.id, page_id=uuid.UUID(pid)))
            for j in journeys:
                _, key = await next_key(s, self.scope.org_id, self.project_id, "journey")
                s.add(
                    UserJourney(
                        organisation_id=self.scope.org_id,
                        scan_session_id=self.scan_id,
                        stage_run_id=self.stage_run_id,
                        project_id=self.project_id,
                        key=key,
                        name=j.name[:200],
                        steps=[st.model_dump(mode="json") for st in j.steps],
                        provenance=j.provenance,
                        confidence=j.confidence,
                        evidence_refs=[r.model_dump(mode="json") for r in j.evidence_refs],
                        generated_by=j.generated_by,
                        reason=j.reason,
                    )
                )
            for b in boundaries:
                s.add(
                    KnowledgeItem(
                        organisation_id=self.scope.org_id,
                        project_id=self.project_id,
                        kind=KnowledgeKind.fact,
                        title=f"Auth boundary at {h.path_of(b['url'])}",
                        content={
                            "login_form": "A sign-in form is present.",
                            "http_401": "The page returns HTTP 401 without signing in.",
                            "http_403": "The page returns HTTP 403 without signing in.",
                            "redirect_to_login": "The page redirects to the sign-in page.",
                        }.get(b["kind"], b["kind"]),
                        provenance=Provenance.observed if b["evidence_refs"] else Provenance.unverified,
                        evidence_refs=b["evidence_refs"],
                        source=AGENT_KEY,
                        status=KnowledgeStatus.active,
                        scan_session_id=self.scan_id,
                    )
                )
            stats = dict(scan.stats or empty_stats())
            stats["access_gaps"] = len(gaps)
            stats["queued"] = 0
            stats["blocked_requests"] = len(self.policy.blocked)
            scan.stats = stats
            scan.status = scan_status
            scan.control = None
            scan.current = None
            scan.finished_at = utcnow()
            scan.completeness = completeness.model_dump()
            scan.auth_boundaries = boundaries
            scan.access_gaps = gaps
            scan.limitations = limitations
            scan.blocked_requests = list(self.policy.blocked)
            scan.skipped_links = result.skipped_links
            scan.external_links = result.external_links
            scan.summary = summary
            scan.summary_generated_by = summary_by
            scan.error = error
            scan.frontier = {
                **result.frontier.to_json(),
                "not_visited": result.not_visited[:500],
                "stop_reason": result.stop_reason,
            }
            await s.commit()

        if result.stop_reason == "page_limit":
            await self.emit(
                "log",
                f"Page limit reached: {len(visited)} of {limits.max_pages} visited, "
                f"{len(result.not_visited)} more found but not visited",
                data={"kind": "warning"},
            )
        done_msg = {
            ScanStatus.completed: f"Discovery completed: {len(visited)} pages, {len(features)} features, {len(journeys)} journeys",
            ScanStatus.partial: f"Discovery stopped early after {len(visited)} pages. Results are partial.",
            ScanStatus.cancelled: f"Discovery was cancelled after {len(visited)} pages. Results are partial.",
            ScanStatus.failed: f"Discovery failed: {error}",
        }[scan_status]
        await self.emit(
            "task.completed" if scan_status != ScanStatus.failed else "task.failed",
            done_msg,
            level=EventLevel.error if scan_status == ScanStatus.failed else EventLevel.info,
            data={
                "kind": "status" if scan_status != ScanStatus.failed else "error",
                "status": scan_status.value,
                "reason": error,
                "pages": len(visited),
            },
        )
        return DiscoveryOutcome(
            scan_status=scan_status,
            partial=partial,
            paused=False,
            generated_by=generated_by,
            validation_issues=issues,
            error=error,
            recommendation=rec,
            llm_usage=llm_usage,
            output={
                "scan_session_id": str(self.scan_id),
                "pages": len(visited),
                "pages_failed": len(views) - len(visited),
                "features": len(features),
                "journeys": len(journeys),
                "access_gaps": len(gaps),
                "completeness": completeness.model_dump(),
            },
        )

    def _limitations(
        self,
        result: CrawlResult,
        limits: DiscoveryLimits,
        scan: ScanSession,
        views: list[h.PageView],
        has_credentials: bool,
        needs_sign_in: bool,
    ) -> list[str]:
        out = [h.UI_ONLY_LIMITATION]
        out.append("Discovery is read-only: forms were catalogued but not submitted, and buttons were not clicked.")
        if any(v.found_via == "search" for v in views):
            out.append('Search boxes that use GET were tried with the harmless term "test" to observe results pages.')
        out.append("Filters, dialogs, tabs and expandable sections were catalogued but not operated.")
        skipped = result.skipped_links
        if skipped:
            examples = ", ".join(h.path_of(x["url"]) for x in skipped[:4])
            out.append(
                f"Links that sign out, delete or unsubscribe, and file downloads, were not followed on purpose ({examples})."
            )
        else:
            out.append("Links that sign out, delete or unsubscribe, and file downloads, are never followed.")
        n = len(result.not_visited)
        more = f"{n} more link{'s were' if n != 1 else ' was'} not visited"
        reason = result.stop_reason
        if reason == "page_limit":
            out.append(f"Stopped at the limit of {limits.max_pages} pages; {more}.")
        elif n and reason == "cancelled":
            out.append(f"Discovery was cancelled after {len(views)} pages; {more}.")
        elif n and reason == "timeout":
            out.append(f"Discovery stopped at the {limits.total_timeout_s // 60}-minute time limit; {more}.")
        elif n and reason in ("failed", "paused"):
            out.append(f"Discovery stopped before it finished; {more}.")
        if result.robots_skipped:
            out.append(f"{len(result.robots_skipped)} pages were not visited because robots.txt disallows them.")
        if self.policy and self.policy.blocked:
            n = len(self.policy.blocked)
            out.append(
                f"{n} request{'s' if n != 1 else ''} to other or internal addresses {'were' if n != 1 else 'was'} blocked to keep the scan safe."
            )
        if needs_sign_in:
            out.append(
                "Some pages need a sign-in. Phase 1 discovery is unauthenticated: the credentials you provided are stored "
                "encrypted for authenticated discovery in a later phase."
                if has_credentials
                else "Some pages need a sign-in. Phase 1 discovery covers public pages only; signed-in areas are listed as access gaps."
            )
        if limits.include_mobile:
            out.append(
                f"Mobile layout was observed at 390 × 844 for up to {limits.mobile_sample} pages (viewport emulation only)."
            )
        else:
            out.append("Desktop only: responsive behaviour was not observed.")
        if reason == "timeout" and not n:
            out.append(f"Discovery stopped at the {limits.total_timeout_s // 60}-minute time limit.")
        if reason == "cancelled":
            out.append("Discovery was cancelled before it finished; results are partial.")
        if result.error:
            out.append(f"Discovery stopped early: {result.error}")
        flags = scan.injection_flags or []
        if flags:
            n = len({f["page_url"] for f in flags})
            out.append(
                f"Page content was treated as untrusted data; {n} page{'s' if n != 1 else ''} contained text addressed to AI agents, which was ignored."
            )
        out.append(
            "Only pages reachable by following links (or listed in sitemap.xml) from the start page are included."
        )
        return out

    async def _ai_analysis(
        self, views: list[h.PageView], evidence_ids: set[str], issues: list[dict[str, Any]]
    ) -> tuple[list[FeatureCandidate], list[JourneyCandidate], str | None, dict[str, Any]] | None:
        blocks = []
        for v in views[:60]:
            if v.failed:
                continue
            forms = [
                {
                    "purpose": h.form_purpose(f),
                    "fields": [x.label or x.name for x in f.fields][:10],
                    "submit": f.submit_label,
                }
                for f in v.forms
            ]
            comps: dict[str, int] = {}
            for c in v.components:
                comps[c.kind] = comps.get(c.kind, 0) + 1
            content = json.dumps(
                {
                    "page_id": str(v.id),
                    "url": v.url,
                    "title": v.title,
                    "type": v.page_type,
                    "nav": [n.text for n in v.nav_links][:15],
                    "forms": forms,
                    "components": comps,
                    "evidence_ids": [str(e) for e in (v.screenshot_id, v.dom_id) if e],
                }
            )
            blocks.append(UntrustedBlock(source=f"page:{v.id}", content=content, max_chars=3000))
        res = await self.ctx.llm.structured(
            LlmDiscoveryAnalysis,
            "Analyse the discovered pages of a website. Identify application features (each backed by the pages and "
            "evidence ids given) and likely user journeys across the given pages. Write a 3-6 sentence summary that "
            "states coverage is partial. Mark a feature 'observed' only if a page element supports it.",
            blocks,
            Budget(max_output_tokens=self.ctx.settings.ai_max_output_tokens),
        )
        usage: dict[str, Any] = (
            res.usage.as_dict() if res.usage else {"provider": self.ctx.llm.provider, "model": self.ctx.llm.model}
        )
        if not res.ok or res.value is None:
            issues.append(
                {
                    "severity": "warning",
                    "code": f"llm_{res.status.value}",
                    "message": f"AI analysis unavailable ({res.reason}); rule-based analysis used.",
                    "path": None,
                }
            )
            for msg in res.issues:
                issues.append({"severity": "warning", "code": "llm_validation", "message": msg[:500], "path": None})
            usage["fallback_used"] = True
            return None
        value = res.value
        known_pages = {str(v.id): v for v in views if not v.failed}
        known_urls = {canonical(v.url) for v in views}
        for u in value.page_urls_mentioned:
            if canonical(u) not in known_urls:
                issues.append(
                    {
                        "severity": "warning",
                        "code": "undiscovered_url",
                        "message": f"AI output mentioned an undiscovered URL; ignored: {u[:200]}",
                        "path": "page_urls_mentioned",
                    }
                )
        features: list[FeatureCandidate] = []
        for i, f in enumerate(value.features):
            pids = [p for p in f.page_ids if p in known_pages]
            if len(pids) != len(f.page_ids):
                issues.append(
                    {
                        "severity": "warning",
                        "code": "unknown_page",
                        "message": f"Feature '{f.name}' referenced pages that were not discovered; those references were dropped.",
                        "path": f"features[{i}].page_ids",
                    }
                )
            if not pids:
                issues.append(
                    {
                        "severity": "warning",
                        "code": "feature_dropped",
                        "message": f"Feature '{f.name}' had no discovered pages and was dropped.",
                        "path": f"features[{i}]",
                    }
                )
                continue
            eids = [e for e in f.evidence_ids if e in evidence_ids]
            if len(eids) != len(f.evidence_ids):
                issues.append(
                    {
                        "severity": "warning",
                        "code": "unknown_evidence",
                        "message": f"Feature '{f.name}' cited evidence that does not exist in this scan; it was removed.",
                        "path": f"features[{i}].evidence_ids",
                    }
                )
            prov = Provenance(f.provenance)
            if prov == Provenance.observed and not eids:
                prov = Provenance.unverified
                issues.append(
                    {
                        "severity": "warning",
                        "code": "provenance_downgraded",
                        "message": f"Feature '{f.name}' was marked observed without valid evidence; downgraded to unverified.",
                        "path": f"features[{i}].provenance",
                    }
                )
            features.append(
                FeatureCandidate(
                    name=f.name,
                    description=f.description,
                    category=f.category,
                    page_ids=[uuid.UUID(p) for p in pids],
                    provenance=prov,
                    confidence=f.confidence,
                    evidence_refs=[EvidenceRefModel(evidence_id=uuid.UUID(e)) for e in eids],
                    generated_by=GeneratedBy.ai,
                )
            )
        journeys: list[JourneyCandidate] = []
        for i, j in enumerate(value.journeys):
            steps = [
                JourneyStep(page_id=uuid.UUID(st.page_id), action=st.action, label="inferred")
                for st in j.steps
                if st.page_id in known_pages
            ]
            if len(steps) != len(j.steps):
                issues.append(
                    {
                        "severity": "warning",
                        "code": "unknown_page",
                        "message": f"Journey '{j.name}' used pages that were not discovered; those steps were dropped.",
                        "path": f"journeys[{i}].steps",
                    }
                )
            if not steps:
                continue
            refs = [
                EvidenceRefModel(evidence_id=known_pages[str(st.page_id)].screenshot_id)
                for st in steps
                if known_pages[str(st.page_id)].screenshot_id is not None
            ][:6]
            journeys.append(
                JourneyCandidate(
                    name=j.name,
                    steps=steps,
                    provenance=Provenance.inferred,
                    confidence=min(j.confidence, 0.8),
                    evidence_refs=refs,
                    generated_by=GeneratedBy.ai,
                    reason="Inferred by AI from the discovered pages; not performed.",
                )
            )
        usage["fallback_used"] = False
        return features, journeys, value.summary, usage


class _SkipFlushingSink:
    """Wraps the DB sink so newly skipped links are reported as live events after each page."""

    def __init__(self, inner: _DbSink, agent: DiscoveryAgent) -> None:
        self.inner = inner
        self.agent = agent
        self.reported: set[str] = set()

    async def control(self) -> Control:
        return await self.inner.control()

    async def on_visiting(self, url: str, done: int, total: int | None) -> None:
        await self.inner.on_visiting(url, done, total)

    async def on_page(self, page: CapturedPage) -> None:
        await self.inner.on_page(page)
        await self._flush()

    async def on_failed(self, page: FailedPage) -> None:
        await self.inner.on_failed(page)
        await self._flush()

    async def on_skip(self, url: str, reason: str) -> None:
        await self.inner.on_skip(url, reason)

    async def save_frontier(self, frontier: Frontier) -> None:
        await self.inner.save_frontier(frontier)
        crawler = self.agent.crawler
        if crawler is not None:
            async with self.agent.session() as s:
                scan = await self.agent.load_scan(s)
                scan.skipped_links = [{"url": u, "reason": r} for u, r in crawler.skipped.items()]
                await s.commit()

    async def _flush(self) -> None:
        crawler = self.agent.crawler
        if crawler is None:
            return
        for url, reason in list(crawler.skipped.items()):
            if url not in self.reported:
                self.reported.add(url)
                if reason != "too many query variants of the same page" or len(self.reported) < 50:
                    await self.inner.on_skip(url, reason)


def _view(r: DiscoveredPage, dom_id: uuid.UUID | None) -> h.PageView:
    return h.PageView(
        id=r.id,
        url=r.url,
        title=r.title,
        status=r.http_status,
        failed=r.status != PageStatus.visited,
        depth=r.depth,
        parent_id=r.parent_page_id,
        page_type=r.page_type.value,
        requires_auth=r.requires_auth,
        forms=[
            ExtractedForm.model_validate(
                {
                    **f,
                    "fields": f.get("fields", []),
                    "html": (f.get("evidence_refs") or [{}])[0].get("excerpt") or "",
                    "name": f.get("name"),
                }
            )
            for f in (r.forms or [])
        ],
        components=[
            ExtractedComponent.model_validate(
                {
                    "kind": c["kind"],
                    "role": c.get("role"),
                    "name": c.get("name", ""),
                    "locator": c.get("locator", ""),
                    "selector": c.get("details", {}).get("selector", ""),
                    "details": c.get("details", {}),
                    "html": (c.get("evidence_refs") or [{}])[0].get("excerpt") or "",
                }
            )
            for c in (r.components or [])
        ],
        nav_links=[NavLink.model_validate(n) for n in (r.nav_links or [])],
        screenshot_id=r.screenshot_evidence_id,
        dom_id=dom_id,
        failure_reason=r.failure_reason,
        redirected_from=r.redirected_from if r.status == PageStatus.visited else None,
        redirect_target=r.final_url if r.status != PageStatus.visited else None,
        found_via=r.found_via,
    )


def _rules_summary(
    views: list[h.PageView],
    features: list[FeatureCandidate],
    journeys: list[JourneyCandidate],
    auth_areas: list[str],
    host: str,
) -> str:
    visited = [v for v in views if not v.failed]
    forms = sum(len(v.forms) for v in visited)
    comps = sum(len(v.components) for v in visited)
    nav = list(dict.fromkeys(n.text for v in visited for n in v.nav_links))[:8]
    parts = [
        f"Explored {len(visited)} page{'s' if len(visited) != 1 else ''} on {host} and found {forms} form{'s' if forms != 1 else ''}, "
        f"{comps} interactive element{'s' if comps != 1 else ''}, {len(features)} feature{'s' if len(features) != 1 else ''} "
        f"and {len(journeys)} likely user journey{'s' if len(journeys) != 1 else ''}.",
    ]
    if nav:
        parts.append(f"Main navigation: {', '.join(nav)}.")
    if auth_areas:
        parts.append(
            f"{len(auth_areas)} area{'s' if len(auth_areas) != 1 else ''} need{'s' if len(auth_areas) == 1 else ''} a sign-in ({', '.join(auth_areas[:3])}) and {'was' if len(auth_areas) == 1 else 'were'} not observed."
        )
    parts.append("Only publicly reachable pages are covered; backend behaviour was not verified.")
    return " ".join(parts)
