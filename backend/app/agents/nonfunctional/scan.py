"""The `quality_scan` job (P5-02 accessibility, P5-03 passive security): one check of the discovered pages.

Accessibility: per page and screen size, axe-core (pinned, run with `page.evaluate`), the Tab/Shift+Tab keyboard
pass and a masked screenshot with the failing elements outlined. Security (D19): per page the main document's
response headers, cookie names and flags (values never read), the network log and the page's forms, scripts and
text; plus one plain-http GET of the start URL and one TLS handshake per HTTPS host. No clicks, typing or form
submission; no probing of paths discovery didn't find. Numbers and severities come from code.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import ssl
import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from playwright.async_api import Error
from sqlalchemy import select

from app.agents.nonfunctional import browser_checks as bc
from app.automation.axe import AxeScript, load_axe
from app.browser.page_visit import SignIn, Visit, VisitTarget, visit_pages
from app.context import AppContext
from app.db.models import Job, Project, QualityScan
from app.db.tenant import TenantScope, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import ActorType, EventLevel, EvidenceKind, FindingSeverity, QualityScanKind, QualityScanStatus
from app.domain.nonfunctional import accessibility as a11y
from app.domain.stages import QUALITY_SCAN_STAGE_STATUS
from app.security import passive_rules as sec
from app.security.redact import redact_text
from app.security.ssrf import check_host
from app.services import quality as qsvc
from app.services.audit import audit
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)
AGENT = {QualityScanKind.accessibility: "accessibility", QualityScanKind.security: "security"}
NAME = {QualityScanKind.accessibility: "Accessibility checker", QualityScanKind.security: "Security checker"}
WORKER_STOPPED = "The worker stopped; the check did not complete"
PAGE_JS = """() => ({
  forms: [...document.forms].map((f) => ({ action: f.action, method: (f.getAttribute('method') || 'get') })),
  password_inputs: document.querySelectorAll('input[type=password]').length,
  scripts: [...document.scripts].filter((s) => s.src).map((s) => ({ src: s.src, integrity: !!s.integrity })),
  text: (document.body ? document.body.innerText : '').slice(0, 200000),
})"""


class ScanJob:
    def __init__(self, ctx: AppContext, scope: TenantScope, scan_id: uuid.UUID) -> None:
        from app.orchestrator.orchestrator import Orchestrator

        self.ctx, self.scope, self.scan_id = ctx, scope, scan_id
        self.orch = Orchestrator(ctx)
        self.secrets: list[str] = []
        self.items: list[dict[str, Any]] = []
        self.keyboard: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []
        self.not_checked: list[dict[str, Any]] = []
        self.checked: set[tuple[str, str | None]] = set()
        self.pages_obs: list[sec.PageObs] = []
        self.total = 0
        self.done = 0
        self.last_announced = 0

    async def _emit(
        self,
        project: Project,
        scan: QualityScan,
        type_: str,
        message: str,
        data: dict[str, Any],
        level: EventLevel = EventLevel.info,
    ) -> None:
        await self.ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type=type_,
            message=message,
            level=level,
            stage_key=qsvc.STAGE[scan.kind].value,
            agent_key=AGENT[scan.kind],
            data={"scan_key": scan.key, "kind": scan.kind.value, **data},
        )

    async def _set(self, scan: QualityScan, project: Project, s: Any, status: QualityScanStatus) -> None:
        scan.status = status
        await self.orch.mirror_nonfunctional(s, project, qsvc.STAGE[scan.kind], scan, QUALITY_SCAN_STAGE_STATUS[status])

    # ------------------------------------------------------------------ entry

    async def run(self) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            scan = await s.get(QualityScan, self.scan_id)
            if scan is None:
                return
            project = (await s.execute(select(Project).where(Project.id == scan.project_id))).scalar_one()
            if scan.status == QualityScanStatus.running:
                await self._finish_error(s, project, scan, WORKER_STOPPED)
                return
            if scan.status != QualityScanStatus.queued:
                return
            if (scan.config or {}).get("cancel_requested"):
                scan.finished_at = utcnow()
                await self._set(scan, project, s, QualityScanStatus.cancelled)
                await s.commit()
                await self.orch._enqueue_pending(self.scope, project.id)
                return
            scan.started_at = utcnow()
            await self._set(scan, project, s, QualityScanStatus.running)
            await s.commit()
            cfg = dict(scan.config or {})
            key = scan.key
        await self.orch._enqueue_pending(self.scope, project.id)
        targets = [
            VisitTarget(uuid.UUID(p["page_id"]) if p.get("page_id") else None, p["url"], bool(p.get("requires_auth")))
            for p in cfg.get("pages") or []
        ]
        viewports = list(cfg.get("viewports") or ["desktop"])
        self.total = len(targets) * len(viewports)
        await self._emit(
            project,
            scan,
            "quality.scan_status",
            f"{key} started: {len(targets)} pages, {', '.join(viewports)}",
            {"status": "running", "total": self.total},
        )
        try:
            await self._execute(project, scan, cfg, targets, viewports)
        except Exception as exc:
            log.exception("quality scan failed")
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                scan2 = await s.get(QualityScan, self.scan_id)
                assert scan2 is not None
                why = redact_text(str(exc).splitlines()[0][:200] if str(exc) else type(exc).__name__, self.secrets)
                await self._finish_error(s, project, scan2, f"The check didn't complete: {why}")

    async def _finish_error(self, s: Any, project: Project, scan: QualityScan, reason: str) -> None:
        scan.error = reason
        scan.finished_at = utcnow()
        scan.summary = {**(scan.summary or {}), "progress": self.progress or (scan.summary or {}).get("progress", [])}
        await self._set(scan, project, s, QualityScanStatus.failed)
        await s.commit()
        await self.orch._enqueue_pending(self.scope, project.id)
        await self._emit(
            project, scan, "quality.scan_status", f"{scan.key} didn't complete", {"status": "failed"}, EventLevel.error
        )

    async def _should_stop(self) -> bool:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            scan = await s.get(QualityScan, self.scan_id)
            return scan is None or bool((scan.config or {}).get("cancel_requested"))

    async def _execute(
        self, project: Project, scan: QualityScan, cfg: dict[str, Any], targets: list[VisitTarget], viewports: list[str]
    ) -> None:
        sign_in: SignIn | None = None
        if cfg.get("signed_in") and any(t.requires_auth for t in targets):
            sign_in = await self._credentials(project)
        axe = load_axe(self.ctx.settings.automation_dir) if scan.kind == QualityScanKind.accessibility else None
        if scan.kind == QualityScanKind.accessibility and axe is None:
            raise RuntimeError("axe-core isn't installed on this server")
        mapping: dict[str, dict[str, Any]] = {}
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            mapping = await qsvc.page_mapping(s, project.id)

        async def handle(v: Visit) -> None:
            await self._page(project, scan, v, axe, mapping, bool(cfg.get("keyboard")))

        left, signin_problem = await visit_pages(
            self.ctx,
            origin=cfg["origin"],
            host=cfg["host"],
            targets=targets,
            viewports=viewports,
            handle=handle,
            should_stop=self._should_stop,
            sign_in=sign_in,
        )
        cancelled = bool(left) and await self._should_stop()
        visited_urls = {u for u, _ in self.checked} | {n["url"] for n in self.not_checked}
        for t in targets:
            if t.url in visited_urls or t.url in {x.url for x in left}:
                continue
            reason = signin_problem or "not visited"
            for vp in viewports:
                self.not_checked.append(
                    {"url": t.url, "page_id": str(t.page_id) if t.page_id else None, "viewport": vp, "reason": reason}
                )
        for t in left:
            for vp in viewports:
                self.not_checked.append(
                    {
                        "url": t.url,
                        "page_id": str(t.page_id) if t.page_id else None,
                        "viewport": vp,
                        "reason": "check cancelled",
                    }
                )
        transport: sec.TransportObs | None = None
        if scan.kind == QualityScanKind.security and not cancelled:
            transport = await self._transport(cfg)
        await self._store(project, scan, mapping, cancelled=cancelled, transport=transport)

    async def _credentials(self, project: Project) -> SignIn | None:
        from app.services.secrets import credentials_secret, use_credentials

        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            secret = await credentials_secret(s, project.id)
            if secret is None:
                return None
            creds = await use_credentials(self.ctx, s, secret, purpose="quality_scan", task_id=None)
            await s.commit()
        self.secrets = [v for v in (creds.get("username"), creds.get("password")) if v]
        login = creds.get("login_url") or (secret.meta or {}).get("login_url")
        if not login:
            return None
        return SignIn(str(login), creds["username"], creds["password"])

    # ------------------------------------------------------------------ per page

    async def _page(
        self,
        project: Project,
        scan: QualityScan,
        v: Visit,
        axe: AxeScript | None,
        mapping: dict[str, Any],
        keyboard: bool,
    ) -> None:
        url = v.target.url
        page_id = str(v.target.page_id) if v.target.page_id else None
        problems = 0
        if v.page is None or v.error is not None or (v.status is not None and v.status >= 400):
            reason = v.error or f"HTTP {v.status}"
            self.not_checked.append({"url": url, "page_id": page_id, "viewport": v.viewport, "reason": reason})
            row = {
                "url": url,
                "path": a11y.path_of(url),
                "viewport": v.viewport,
                "state": "not_checked",
                "reason": reason,
                "problems": 0,
            }
        else:
            self.checked.add((url, v.viewport))
            if scan.kind == QualityScanKind.accessibility and axe is not None:
                problems = await self._a11y_page(project, scan, v, axe, mapping, keyboard)
            else:
                await self._security_page(v)
            row = {
                "url": url,
                "path": a11y.path_of(url),
                "viewport": v.viewport,
                "state": "done",
                "reason": None,
                "problems": problems,
            }
        self.progress.append(row)
        self.done += 1
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            sc = await s.get(QualityScan, self.scan_id)
            if sc is not None:
                sc.summary = {
                    **(sc.summary or {}),
                    "visited": self.done,
                    "total": self.total,
                    "progress": self.progress,
                }
                await s.commit()
        await self._emit(
            project,
            scan,
            "quality.page_done",
            f"{scan.key}: {row['path']} checked",
            {
                "path": row["path"],
                "viewport": v.viewport,
                "state": row["state"],
                "done": self.done,
                "total": self.total,
                "problems": problems,
            },
        )

    async def _a11y_page(
        self, project: Project, scan: QualityScan, v: Visit, axe: AxeScript, mapping: dict[str, Any], keyboard: bool
    ) -> int:
        assert v.page is not None
        url = v.target.url
        page_id = str(v.target.page_id) if v.target.page_id else None
        result = await bc.run_axe(v.page, axe)
        found = a11y.findings_from_axe(result, url=url, viewport=v.viewport, secrets=self.secrets)
        kb_summary: dict[str, Any] | None = None
        if keyboard:
            try:
                k = await bc.keyboard_pass(v.page)
                kf, kb_summary = a11y.keyboard_findings(k, url=url, viewport=v.viewport)
                found.extend(kf)
            except Error as exc:
                kb_summary = {"url": url, "viewport": v.viewport, "error": str(exc).splitlines()[0][:200]}
            if kb_summary is not None:
                kb_summary["path"] = a11y.path_of(url)
                self.keyboard.append(kb_summary)
        violating = [f for f in found if not f.get("needs_review") and not f.get("heuristic")]
        targets: list[str] = []
        for f in violating:
            for n in f["nodes"]:
                if n["target"] and n["target"] not in targets:
                    targets.append(n["target"])
        refs: list[dict[str, Any]] = []
        shot = await bc.outlined_screenshot(v.page, targets) if violating else None
        if shot is not None:
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                ev = await write_evidence(
                    s,
                    self.ctx.storage,
                    org_id=project.organisation_id,
                    project_id=project.id,
                    kind=EvidenceKind.screenshot,
                    data=shot,
                    mime="image/jpeg",
                    name="outlined.jpg",
                    owner_id=scan.id,
                    page_id=v.target.page_id,
                    source_url=url,
                    viewport=v.viewport,
                    metadata={"outlined": targets[:20], "masked": "password inputs"},
                )
                ev.quality_scan_id = scan.id
                await s.commit()
                refs = [{"evidence_id": str(ev.id), "kind": "screenshot", "outlined": targets[:20]}]
        raw = json.dumps({"url": url, "viewport": v.viewport, "axe": result}, default=str)
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            ev2 = await write_evidence(
                s,
                self.ctx.storage,
                org_id=project.organisation_id,
                project_id=project.id,
                kind=EvidenceKind.axe_result,
                data=redact_text(raw, self.secrets).encode(),
                mime="application/json",
                name="axe.json",
                owner_id=scan.id,
                page_id=v.target.page_id,
                source_url=url,
                viewport=v.viewport,
            )
            ev2.quality_scan_id = scan.id
            await s.commit()
        for f in found:
            f["page_id"] = page_id
            f["evidence_refs"] = refs if f in violating else []
            f["mapped"] = mapping.get(page_id or "", {})
            self.items.append(f)
        return len({f["rule_id"] for f in violating})

    async def _security_page(self, v: Visit) -> None:
        assert v.page is not None
        info: dict[str, Any] = {}
        with contextlib.suppress(Error):
            info = await v.page.evaluate(PAGE_JS)
        self.pages_obs.append(
            sec.PageObs(
                url=v.target.url,
                page_id=str(v.target.page_id) if v.target.page_id else None,
                status=v.status,
                headers=v.headers,
                set_cookies=v.set_cookies(),
                requests=v.requests,
                forms=info.get("forms") or [],
                password_inputs=int(info.get("password_inputs") or 0),
                scripts=info.get("scripts") or [],
                text=str(info.get("text") or ""),
            )
        )

    # ------------------------------------------------------------------ transport (security)

    async def _transport(self, cfg: dict[str, Any]) -> sec.TransportObs:
        origin = str(cfg["origin"])
        u = urlsplit(origin)
        t = sec.TransportObs(start_url=origin + "/")
        if u.scheme != "https":
            return t  # plain http (loopback: not applicable; otherwise failed from the start URL itself)
        http_url = urlunsplit(("http", u.netloc, "/", "", ""))
        t.http_redirect = await self._http_get(http_url, u.hostname or "", origin)
        t.tls = await self._tls(u.hostname or "", u.port or 443, origin)
        return t

    async def _http_get(self, url: str, host: str, origin: str) -> dict[str, Any]:
        s_ = self.ctx.settings
        chk = await check_host(host, allow_loopback=s_.allow_private_targets, resolver=self.ctx.resolver)
        if not chk.allowed:
            return {"error": chk.reason or "blocked"}
        try:
            async with httpx.AsyncClient(follow_redirects=False, timeout=10, transport=self.ctx.http_transport) as c:
                r = await c.get(url)
                return {"status": r.status_code, "location": r.headers.get("location")}
        except httpx.HTTPError as exc:
            return {"error": str(exc)[:200] or "no response"}

    async def _tls(self, host: str, port: int, origin: str) -> dict[str, Any]:
        s_ = self.ctx.settings
        chk = await check_host(host, allow_loopback=s_.allow_private_targets, resolver=self.ctx.resolver)
        if not chk.allowed or not chk.resolved_ips:
            return {"error": chk.reason or "blocked"}
        ip = chk.resolved_ips[0]
        context = ssl.create_default_context()
        try:
            _r, w = await asyncio.wait_for(
                asyncio.open_connection(ip, port, ssl=context, server_hostname=host), timeout=10
            )
        except ssl.SSLCertVerificationError as exc:
            return {"error": "certificate not valid", "cert_error": str(exc.verify_message or exc)[:200]}
        except (OSError, TimeoutError) as exc:
            return {"error": str(exc)[:200] or "no response"}
        try:
            obj = w.get_extra_info("ssl_object")
            cert = obj.getpeercert() if obj else None
            not_after = None
            if cert and cert.get("notAfter"):
                not_after = datetime.fromtimestamp(ssl.cert_time_to_seconds(str(cert["notAfter"])), UTC).isoformat()
            return {"version": obj.version() if obj else None, "not_after": not_after, "hostname_ok": True}
        finally:
            w.close()
            with contextlib.suppress(Exception):
                await w.wait_closed()

    # ------------------------------------------------------------------ results

    async def _store(
        self,
        project: Project,
        scan: QualityScan,
        mapping: dict[str, Any],
        *,
        cancelled: bool,
        transport: sec.TransportObs | None,
    ) -> None:
        sec_result: dict[str, Any] | None = None
        if scan.kind == QualityScanKind.security and transport is not None:
            sec_result = sec.evaluate(transport, self.pages_obs, now=datetime.now(UTC))
            by_rule = {(r["rule_id"], r["subject"]): r for r in sec_result["rules"]}
            for f in sec_result["findings"]:
                rule = by_rule.get((f["rule"], f["subject"])) or by_rule.get((f["rule"], ""))
                assert rule is not None
                self.items.append(
                    {
                        "rule_id": f["rule"],
                        "severity": FindingSeverity(rule["severity"]),
                        "title": sec.finding_title(f["rule"], f["subject"]),
                        "url": f["url"],
                        "viewport": "desktop",
                        "page_id": f["page_id"],
                        "nodes": [],
                        "references": [rule["reference"]],
                        "fingerprint": sec.fingerprint(f["rule"], f["subject"], f["url"]),
                        "subject": f["subject"],
                        "observed": f["observed"],
                        "category": rule["category"],
                        "why": rule["why"],
                        "fix": rule["fix"],
                        "mapped": mapping.get(f["page_id"] or "", {}),
                    }
                )
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            sc = await s.get(QualityScan, self.scan_id)
            assert sc is not None
            n = 0
            for item in self.items:
                n += 1
                await qsvc.add_finding(s, sc, n, item, item.get("mapped") or {})
            await s.flush()
            fixed = 0 if cancelled else await qsvc.mark_not_found_again(s, sc, self.checked)
            drafted: list[str] = []
            added: list[str] = []
            if sc.kind == QualityScanKind.accessibility and not cancelled:
                drafted, added = await qsvc.a11y_drafts(s, project, sc)
            sc.not_checked = [*(sc.not_checked or []), *self.not_checked]
            sc.summary = self._summary(sc, sec_result, drafted, added, fixed)
            sc.finished_at = utcnow()
            if cancelled:
                status = QualityScanStatus.cancelled
            elif sc.not_checked:
                status = QualityScanStatus.partial
            else:
                status = QualityScanStatus.completed
            await self._set(sc, project, s, status)
            audit(
                s,
                org_id=sc.organisation_id,
                action="quality_scan.finished",
                target_type="quality_scan",
                target_id=sc.id,
                project_id=sc.project_id,
                actor_type=ActorType.system,
                metadata={"key": sc.key, "status": status.value, "findings": n},
            )
            if status != QualityScanStatus.cancelled:
                # P6-05a: new accessibility/security results are new evidence for an assessment waiting for G9.
                from app.services.release import mark_stale

                await mark_stale(s, sc.project_id, f"{sc.key} finished")
            await s.commit()
            message = self._finished_message(sc)
        await self.orch._enqueue_pending(self.scope, project.id)
        await self._emit(project, scan, "quality.scan_status", message, {"status": status.value, "drafted": drafted})
        # P5-04a: the check's report freezes when it finishes.
        from app.agents.reporting.phase5_reports import freeze_for
        from app.domain.enums import ReportType

        rtype = ReportType.accessibility if scan.kind == QualityScanKind.accessibility else ReportType.security
        await freeze_for(self.ctx, self.scope, project.id, rtype, scan.key)
        for key in drafted:
            await self.ctx.events.emit(
                org_id=project.organisation_id,
                project_id=project.id,
                type="defect.drafted",
                message=f"Drafted {key} from {scan.key}",
                stage_key=qsvc.STAGE[scan.kind].value,
                agent_key=AGENT[scan.kind],
                data={"kind": "result", "defect_key": key},
            )

    def _summary(
        self, sc: QualityScan, sec_result: dict[str, Any] | None, drafted: list[str], added: list[str], fixed: int
    ) -> dict[str, Any]:
        base: dict[str, Any] = {
            "visited": self.done,
            "total": self.total,
            "progress": self.progress,
            "drafted": drafted,
            "occurrences_added": added,
            "not_found_again": fixed,
            "pages_checked": len({u for u, _ in self.checked}),
            "pages_not_checked": len({n["url"] for n in sc.not_checked or []}),
        }
        if sc.kind == QualityScanKind.security:
            base["rules"] = (sec_result or {}).get("rules") or []
            base["counts"] = (sec_result or {}).get("counts") or {}
            return base
        violations = [i for i in self.items if not i.get("needs_review") and not i.get("heuristic")]
        sev: dict[str, int] = {}
        rules: dict[str, set[str]] = {}
        for i in violations:
            rules.setdefault(i["rule_id"], set()).add(i["url"])
        for rid in rules:
            first = next(i for i in violations if i["rule_id"] == rid)
            sev[first["severity"].value] = sev.get(first["severity"].value, 0) + 1
        base.update(
            {
                "rules_failed": len(rules),
                "pages_with_problems": len({i["url"] for i in violations}),
                "by_severity": {k: sev.get(k, 0) for k in ("critical", "serious", "moderate", "minor")},
                "needs_review": len({i["rule_id"] for i in self.items if i.get("needs_review")}),
                "keyboard": self.keyboard,
                "keyboard_findings": len([i for i in self.items if i.get("heuristic")]),
                "elements": sum(len(i["nodes"]) for i in violations),
            }
        )
        return base

    def _finished_message(self, sc: QualityScan) -> str:
        sm = sc.summary or {}
        nc = sm.get("pages_not_checked", 0)
        if sc.status == QualityScanStatus.cancelled:
            return f"{sc.key} cancelled: {sm.get('pages_checked', 0)} pages checked"
        if sc.kind == QualityScanKind.security:
            c = sm.get("counts") or {}
            return (
                f"{sc.key} finished: {c.get('failed', 0)} failed, {c.get('passed', 0)} passed, "
                f"{c.get('not_applicable', 0)} not applicable; {nc} pages not checked"
            )
        return (
            f"{sc.key} finished: {sm.get('rules_failed', 0)} rules failed on {sm.get('pages_with_problems', 0)} "
            f"of {sm.get('pages_checked', 0) + nc} pages; {nc} pages not checked"
        )


async def run_scan(ctx: AppContext, scope: TenantScope, scan_id: uuid.UUID, job: Job | None) -> None:
    await ScanJob(ctx, scope, scan_id).run()


async def scan_interrupted(ctx: AppContext, job: Job) -> None:
    """The reaper gave up on the job: a running check is `failed` with the worker-stopped reason."""
    scope = system_scope(job.organisation_id)
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        scan = await s.get(QualityScan, uuid.UUID(job.payload["scan_id"]))
        if scan is None or scan.status not in qsvc.ACTIVE:
            return
        project = (await s.execute(select(Project).where(Project.id == scan.project_id))).scalar_one()
        await ScanJob(ctx, scope, scan.id)._finish_error(s, project, scan, WORKER_STOPPED)
