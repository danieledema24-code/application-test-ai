"""The `exploratory_session` job (P6-03a, decisions D29, D30): the rule-based safe explorer.

One isolated Chromium context at 1440 × 900 with the discovery network policy plus the exploration write guard
(`ExplorationPolicy`): every request other than GET/HEAD/OPTIONS is aborted before it leaves the browser and recorded,
WebSockets are refused, popups are closed and browser dialogs dismissed. Pages are taken in charter order; on each,
the allow-list is computed from the live DOM (`app.domain.exploratory.actions`) and each allowed action is taken once
per session (deduped by fingerprint), changed and new elements first. After each action the coded oracles judge what
happened (`app.domain.exploratory.oracles`), the step is stored with its outcome and observations, findings get
before/after masked screenshots and redacted console and network lines, and the page is restored by loading its URL
again. New same-origin pages that links lead to are explored while budget remains. Page text is never acted on: the
rules ignore it, and text that tries to instruct automated tools is only recorded as a finding.

The budget is enforced here (`BudgetMeter`); "Stop now" is polled every 0.25 s and ends the session within 2 s with
its steps and findings kept. A session whose worker died is `failed` "The worker stopped", with its steps kept.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import time
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

from playwright.async_api import BrowserContext, ConsoleMessage, Error, Page, Response
from playwright.async_api import TimeoutError as PwTimeout
from sqlalchemy import select

from app.agents.discovery.crawler import MASK_JS, _screenshot
from app.agents.discovery.heuristics import skip_reason
from app.browser.network_policy import ExplorationPolicy
from app.browser.page_visit import MAX_PAGE_TIMEOUT_S, SignIn, _goto
from app.context import AppContext
from app.db.models import Approval, ExploratoryStep, Job, Project, QualityFinding, QualityScan
from app.db.tenant import TenantScope, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    ActorType,
    ApprovalKind,
    ApprovalStatus,
    ChosenBy,
    EventLevel,
    EvidenceKind,
    FindingSeverity,
    QualityScanStatus,
    StageKey,
    StepOutcome,
)
from app.domain.exploratory import actions as act
from app.domain.exploratory import limits as lim
from app.domain.exploratory import oracles as orc
from app.domain.stages import QUALITY_SCAN_STAGE_STATUS
from app.llm.injection import detect_injection
from app.security.redact import redact_text, redact_url_tokens
from app.services import exploratory as esvc
from app.services import quality as qsvc
from app.services.audit import audit
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)
AGENT = "exploratory"
WORKER_STOPPED = "The worker stopped"
JOB_FAILED = "The session's job failed on the server"
POLL_S = 0.25  # Stop now is seen within this, and the browser is closed right after (≤ 2 s end to end)
SETTLE_MS = 400  # how long an action's effects are observed before the page is read
CLICK_TIMEOUT_MS = 5000
MAX_CONSOLE = 20
MAX_NETWORK = 30
ELEMENTS_JS = r"""() => {
  const SEL = 'a[href], button, input[type=button], input[type=submit], input[type=image], input[type=reset], summary,'
    + ' [role=tab], [role=button], [role=menuitem], [role=switch], [aria-expanded], [aria-haspopup]';
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const uniqueId = (el) => el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;
  const cssPath = (el) => {
    if (uniqueId(el)) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e !== el && uniqueId(e)) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let i = 1; for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
    }
    return parts.join(' > ');
  };
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label'); if (label && label.trim()) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ').trim(); if (t) return t; }
    if (el.tagName === 'INPUT') return el.value || el.getAttribute('alt') || el.title || '';
    const t = (el.innerText || el.textContent || '').trim(); if (t) return t;
    const img = el.querySelector('img[alt]'); if (img) return img.getAttribute('alt');
    return el.title || '';
  };
  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r.split(' ')[0];
    const t = el.tagName.toLowerCase(); if (t === 'a') return 'link'; if (t === 'button' || t === 'summary' || t === 'input') return 'button';
    return t; };
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const t = el.tagName.toLowerCase();
    out.push({ selector: cssPath(el), tag: t, role: roleOf(el), name: nameOf(el).replace(/\s+/g, ' ').slice(0, 120),
      type: (t === 'button' || t === 'input') ? (el.getAttribute('type') || '').toLowerCase() : null,
      href: t === 'a' ? el.href : null, target: el.getAttribute('target'), download: el.hasAttribute('download'),
      in_form: !!(el.form || el.closest('form')), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' });
    if (out.length >= 400) break;
  }
  return out;
}"""
DIALOGS = "dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]"
STATE_JS = (
    """() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const de = document.documentElement;
  return { text: document.body ? document.body.innerText.slice(0, 200000) : '',
    overflow: de.scrollWidth > de.clientWidth + 1,
    dialogs: [...document.querySelectorAll('"""
    + DIALOGS
    + """')].filter(vis).length,
    dom: document.getElementsByTagName('*').length, url: location.href };
}"""
)
CLOSE_CONTROL_JS = (
    """() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const open = [...document.querySelectorAll('"""
    + DIALOGS
    + """')].filter(vis);
  if (!open.length) return true;
  const d = open[open.length - 1];
  return [...d.querySelectorAll('button, [role=button], a[href], input[type=button]')].some((b) =>
    /\\b(close|cancel|dismiss|done|ok|got it|back)\\b|[×✕]/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || b.value || '')));
}"""
)


class Collector:
    """What the page reports while one action (or page load) runs; listeners append, the explorer clears."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.console: list[str] = []
        self.responses: list[tuple[str, str, int]] = []
        self.nav_status: int | None = None
        self.dialogs: list[str] = []

    def clear(self) -> None:
        self.__init__()  # type: ignore[misc]


class ExploreJob:
    def __init__(self, ctx: AppContext, scope: TenantScope, scan_id: uuid.UUID) -> None:
        from app.orchestrator.orchestrator import Orchestrator

        self.ctx, self.scope, self.scan_id = ctx, scope, scan_id
        self.orch = Orchestrator(ctx)
        self.secrets: list[str] = []
        self.col = Collector()
        self.origin = ""
        # Session state (also what the summary shows).
        self.queue: list[str] = []  # page keys in exploration order
        self.page_ids: dict[str, str | None] = {}
        self.priority: dict[str, list[str]] = {}
        self.visited: list[str] = []
        self.tried: set[str] = set()
        self.not_tried: dict[str, dict[str, Any]] = {}
        self.pending: dict[str, dict[str, Any]] = {}  # allowed but not tried yet (never reached if budget runs out)
        self.blocked: list[dict[str, Any]] = []
        self.coverage: dict[str, dict[str, Any]] = {}
        self.findings: dict[str, uuid.UUID] = {}  # fingerprint → finding id (dedupe within the session)
        self.finding_n = 0
        self.pages_added = 0
        self.last_step: dict[str, Any] | None = None
        self.current: str | None = None
        self.end_reason: str | None = None
        self.mapping: dict[str, Any] = {}
        self._tasks: set[asyncio.Future[None]] = set()  # popup closes and dialog dismissals in flight

    # ------------------------------------------------------------------ helpers

    async def _emit(
        self, project: Project, type_: str, message: str, data: dict[str, Any], level: EventLevel = EventLevel.info
    ) -> None:
        await self.ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type=type_,
            message=message,
            level=level,
            stage_key=StageKey.exploratory.value,
            agent_key=AGENT,
            data=data,
        )

    async def _set(self, s: Any, project: Project, scan: QualityScan, status: QualityScanStatus) -> None:
        scan.status = status
        await self.orch.mirror_nonfunctional(
            s, project, StageKey.exploratory, scan, QUALITY_SCAN_STAGE_STATUS.get(status)
        )

    def _spawn(self, coro: Any) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    def _redact(self, text: str) -> str:
        return redact_text(text, self.secrets)

    def _requeue(self, scan: QualityScan) -> Any:
        return self.ctx.queue.enqueue(
            esvc.JOB,
            {"scan_id": str(scan.id)},
            org_id=scan.organisation_id,
            project_id=scan.project_id,
            concurrency_group=qsvc.QUALITY_GROUP,
            run_after=utcnow() + timedelta(seconds=5),
            max_attempts=1,
        )

    # ------------------------------------------------------------------ entry

    async def run(self) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            scan = await s.get(QualityScan, self.scan_id)
            if scan is None:
                return
            project = (await s.execute(select(Project).where(Project.id == scan.project_id))).scalar_one()
            if scan.status == QualityScanStatus.running:
                await self._finish_error(s, project, scan, WORKER_STOPPED)  # started again after its worker died
                return
            if scan.status != QualityScanStatus.queued:
                return
            cfg = dict(scan.config or {})
            if cfg.get("cancel_requested"):
                scan.finished_at = utcnow()
                scan.summary = {**(scan.summary or {}), "end_reason": "stopped"}
                await self._set(s, project, scan, QualityScanStatus.cancelled)
                await s.commit()
                return
            # One session per project, never beside a load test on the project: wait for it.
            other = (
                await s.execute(
                    select(QualityScan.key).where(
                        QualityScan.project_id == scan.project_id,
                        QualityScan.kind == esvc.KIND,
                        QualityScan.status == QualityScanStatus.running,
                        QualityScan.id != scan.id,
                    )
                )
            ).first()
            if other is not None or await esvc.perf_running(s, scan.project_id) is not None:
                await self._requeue(scan)
                return
            if cfg.get("signed_in"):
                a = (
                    await s.execute(
                        select(Approval).where(
                            Approval.quality_scan_id == scan.id, Approval.kind == ApprovalKind.exploratory_session
                        )
                    )
                ).scalar_one_or_none()
                if a is None or a.status != ApprovalStatus.approved:
                    await self._finish_error(s, project, scan, "The session has no approval to use")
                    return
                a.status = ApprovalStatus.used
                audit(s, org_id=a.organisation_id, action="approval.used", target_type="approval", target_id=a.id,
                      project_id=a.project_id, actor_type=ActorType.system,
                      metadata={"key": a.key, "session": scan.key})  # fmt: skip
            # D30: the budget is checked once more when the session starts (the ceiling may have been lowered).
            ceiling = await esvc.org_ceiling(s, scan.organisation_id)
            issues = lim.budget_violations(dict(cfg.get("budget") or {}), ceiling, self.ctx.settings.explore_cap)
            if issues:
                await self._finish_error(s, project, scan, f"The session is over a limit now: {issues[0].message}")
                return
            scan.started_at = utcnow()
            await self._set(s, project, scan, QualityScanStatus.running)
            audit(s, org_id=scan.organisation_id, action="exploratory_session.started", target_type="quality_scan",
                  target_id=scan.id, project_id=scan.project_id, actor_type=ActorType.system,
                  metadata={"key": scan.key, "pages": len(cfg.get("pages") or []), "budget": cfg.get("budget")})  # fmt: skip
            await s.commit()
            self.mapping = await qsvc.page_mapping(s, project.id)
            key = scan.key
        budget = lim.Budget.from_dict(cfg.get("budget"), lim.DEFAULT_CEILING)
        await self._emit(project, "quality.scan_status",
                         f"{key} started: {len(cfg.get('pages') or [])} pages, up to {budget.actions} actions",
                         {"kind": "status", "scan_key": key, "status": "running"})  # fmt: skip
        meter = lim.BudgetMeter(budget=budget, started=time.monotonic())
        explore = asyncio.create_task(self._explore(project, key, cfg, meter))
        watch = asyncio.create_task(self._watch(meter))
        error: str | None = None
        stopped = False
        try:
            done, _ = await asyncio.wait({explore, watch}, return_when=asyncio.FIRST_COMPLETED)
            if watch in done and not explore.done():
                why = watch.result()
                stopped = why == "stopped"
                if why == lim.TIME_USED:
                    self.end_reason = lim.TIME_USED
                explore.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await explore
            else:
                watch.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watch
                exc = explore.exception()
                if exc is not None:
                    log.error("exploratory session failed", exc_info=exc)
                    why = str(exc).splitlines()[0][:200] if str(exc) else type(exc).__name__
                    error = f"The session didn't complete: {self._redact(why)}"
        except asyncio.CancelledError:
            explore.cancel()
            watch.cancel()
            raise
        await self._finish(project, error=error, stopped=stopped, meter=meter)

    async def _watch(self, meter: lim.BudgetMeter) -> str:
        """Returns "stopped" when Stop now is requested, or the time reason when the minutes run out mid-action."""
        while True:
            await asyncio.sleep(POLL_S)
            if time.monotonic() >= meter.deadline():
                return lim.TIME_USED
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                cfg = (await s.execute(select(QualityScan.config).where(QualityScan.id == self.scan_id))).scalar_one()
                if (cfg or {}).get("cancel_requested"):
                    return "stopped"

    async def _credentials(self, project: Project) -> SignIn | None:
        from app.services.secrets import credentials_secret, use_credentials

        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            secret = await credentials_secret(s, project.id)
            if secret is None:
                return None
            creds = await use_credentials(self.ctx, s, secret, purpose="exploratory_session", task_id=None)
            await s.commit()
        self.secrets = [v for v in (creds.get("username"), creds.get("password")) if v]
        login = creds.get("login_url") or (secret.meta or {}).get("login_url")
        if not login:
            return None
        return SignIn(str(login), creds["username"], creds["password"])

    # ------------------------------------------------------------------ the session

    async def _explore(self, project: Project, key: str, cfg: dict[str, Any], meter: lim.BudgetMeter) -> None:
        s_ = self.ctx.settings
        self.origin = str(cfg["origin"])
        timeout_s = min(MAX_PAGE_TIMEOUT_S, int(s_.scan_page_timeout_s))
        policy = ExplorationPolicy(
            approved_origins={self.origin},
            allowed_hosts=[str(cfg["host"])],
            allow_private_targets=s_.allow_private_targets,
            resolver=self.ctx.resolver,
            fetch_timeout_ms=timeout_s * 1000,
            armed=True,
            skip=act.link_skip_reason,
            skip_loads_allowed=frozenset({act.DOWNLOADS}),
        )
        for p in cfg.get("pages") or []:
            k = act.page_key(p["url"])
            if k not in self.queue:
                self.queue.append(k)
                self.page_ids[k] = p.get("page_id")
        self.priority = dict(cfg.get("priority") or {})
        sign_in = await self._credentials(project) if cfg.get("signed_in") else None
        if cfg.get("signed_in") and sign_in is None:
            raise RuntimeError("the saved test login has no sign-in page")
        async with self.ctx.browser_pool.isolated_context(policy) as context:
            if sign_in is not None:
                await self._sign_in(context, policy, sign_in, timeout_s)
            page = await context.new_page()
            # New tabs and windows the page opens are closed at once: exploration stays on its one tab.
            context.on("page", lambda pg: None if pg is page else self._spawn(_close_quietly(pg)))
            page.set_default_timeout(timeout_s * 1000)
            self._listen(page)
            i = 0
            while i < len(self.queue):
                url = self.queue[i]
                i += 1
                if meter.spent(time.monotonic()) is not None:
                    break
                await self._explore_page(project, key, page, policy, url, meter, timeout_s)
            reason = meter.spent(time.monotonic())
            # "Every allowed action was tried" only when nothing allowed is left untried; otherwise say so.
            self.end_reason = self.end_reason or reason or (lim.UNREACHED if self.pending else lim.EXHAUSTED)

    async def _sign_in(self, context: BrowserContext, policy: ExplorationPolicy, creds: SignIn, timeout_s: int) -> None:
        """P2-01 sign-in with the guard disarmed for the login form only; armed again before any page is explored."""
        from app.agents.discovery.signin import sign_in as do_sign_in

        policy.armed = False
        try:
            outcome = await do_sign_in(context, policy, creds.login_url, creds.username, creds.password,
                                       timeout_ms=timeout_s * 1000)  # fmt: skip
        finally:
            policy.armed = True
        if outcome.result != "succeeded":
            raise RuntimeError(f"sign-in failed ({(outcome.reason_code or 'unknown').replace('_', ' ')})")

    def _listen(self, page: Page) -> None:
        def on_console(m: ConsoleMessage) -> None:
            if m.type == "error" and len(self.col.console) < 50:
                self.col.console.append(self._redact(m.text)[:500])

        def on_error(e: Error) -> None:
            if len(self.col.errors) < 50:
                text = f"{e.name}: {e.message}" if getattr(e, "name", None) else str(e)
                self.col.errors.append(self._redact(text)[:500])

        def on_response(r: Response) -> None:
            with contextlib.suppress(Error):
                if act.origin_of(r.url) == self.origin and len(self.col.responses) < 200:
                    self.col.responses.append((r.request.method, redact_url_tokens(r.url)[:500], r.status))
                if r.request.is_navigation_request() and r.frame == page.main_frame:
                    self.col.nav_status = r.status

        def on_dialog(d: Any) -> None:
            if d.type == "beforeunload":
                # A "leave this page?" guard: the navigation is the explorer's own (restoring the page, opening a
                # link) or the action's effect, so it goes ahead. Dismissing would cancel it and strand the page.
                self._spawn(_accept(d))
                return
            self.col.dialogs.append(self._redact(str(d.message or ""))[:200])
            self._spawn(_dismiss(d))

        page.on("console", on_console)
        page.on("pageerror", on_error)
        page.on("response", on_response)
        page.on("dialog", on_dialog)

    async def _open(
        self, page: Page, policy: ExplorationPolicy, url: str, timeout_s: int
    ) -> tuple[int | None, str | None]:
        resp, err = await _goto(page, policy, url, timeout_s)
        if resp is not None and err is None:
            with contextlib.suppress(PwTimeout, Error):
                await page.wait_for_load_state("load", timeout=5000)
            await self._mask(page)
        return (resp.status if resp is not None else None), err

    async def _mask(self, page: Page) -> None:
        if self.secrets:
            with contextlib.suppress(Error):
                await page.evaluate(MASK_JS, self.secrets)

    async def _state(self, page: Page) -> orc.PageState:
        try:
            raw = await page.evaluate(STATE_JS)
        except Error:
            return orc.PageState(url=page.url)
        text = str(raw.get("text") or "")
        return orc.PageState(
            url=str(raw.get("url") or page.url),
            tokens=orc.broken_tokens(text),
            overflow=bool(raw.get("overflow")),
            dialogs=int(raw.get("dialogs") or 0),
            dom_size=int(raw.get("dom") or 0),
            text_hash=hashlib.sha256(text.encode()).hexdigest(),
        )

    async def _text(self, page: Page) -> str:
        with contextlib.suppress(Error):
            return str(await page.evaluate("() => document.body ? document.body.innerText.slice(0, 200000) : ''"))
        return ""

    async def _explore_page(
        self,
        project: Project,
        key: str,
        page: Page,
        policy: ExplorationPolicy,
        url: str,
        meter: lim.BudgetMeter,
        timeout_s: int,
    ) -> None:
        path = act.path_of(url)
        self.current = path
        self.col.clear()
        writes_from = len(policy.writes)
        status, err = await self._open(page, policy, url, timeout_s)
        cov = self.coverage.setdefault(path, {"page": path, "actions": 0, "findings": 0, "not_tried": 0,
                                               "visited": True, "reason": None})  # fmt: skip
        if err is not None or status is None or status >= 400:
            cov["visited"] = False
            cov["reason"] = err or f"HTTP {status}"
            await self._save_progress()
            return
        if act.page_key(page.url) not in self.visited:
            self.visited.append(act.page_key(page.url))
        await asyncio.sleep(SETTLE_MS / 1000)
        state = await self._state(page)
        # Problems while the page loads (uncaught errors, server errors, console errors) and text aimed at tools.
        load = orc.ActionObservation(
            before=state, after=state, action=None, target="load",
            page_errors=list(self.col.errors), console_errors=list(self.col.console),
            responses=list(self.col.responses), blocked=self._writes(policy, writes_from),
        )  # fmt: skip
        problems = orc.evaluate(load)
        if len(self.visited) == 1 or act.page_key(page.url) not in self.visited[:-1]:
            for method, wurl, line, why in self._blocks(policy, writes_from):
                self.blocked.append({"request": f"{method} {act.path_of(wurl)}", "method": method,
                                     "path": act.path_of(wurl), "after": f"Opening {path}", "step": None,
                                     "text": line, "reason": why})  # fmt: skip
        for m in detect_injection(await self._text(page))[:1]:
            problems.append(orc.injection_problem(url, self._redact(m.excerpt)))
        if problems:
            shot = await _screenshot(page)
            await self._findings(project, key, url, None, problems, None, shot, load, [f"Open {url}"], f"load:{path}")
        raw = []
        with contextlib.suppress(Error):
            raw = await page.evaluate(ELEMENTS_JS)
        pa = act.compute_actions(
            [act.Element.from_js(x) for x in raw or []],
            page.url,
            self.origin,
            priority_names=self.priority.get(path) or [],
        )
        for nt in pa.not_tried:
            if nt.fingerprint not in self.not_tried:
                self.not_tried[nt.fingerprint] = nt.as_dict()
                cov["not_tried"] += 1
        todo = [a for a in act.element_actions(pa) if a.fingerprint not in self.tried]
        for a in todo:
            self.pending.setdefault(a.fingerprint, {"element": a.label.split(" ", 1)[1], "page": path})
        await self._save_progress()
        dirty = False
        for a in todo:
            if a.fingerprint in self.tried:
                continue
            if meter.spent(time.monotonic()) is not None:
                return
            if dirty and not await self._restore(page, policy, url, timeout_s):
                cov["reason"] = "The page couldn't be loaded again; its other actions are listed under Never reached."
                await self._save_progress()
                return
            dirty = await self._act(project, key, page, policy, url, a, meter, timeout_s)
            delay = self.ctx.settings.scan_politeness_delay_ms
            if delay:
                await asyncio.sleep(delay / 1000)

    async def _restore(self, page: Page, policy: ExplorationPolicy, url: str, timeout_s: int) -> bool:
        """Loads the page again before the next action (twice at most: the second time with any `onbeforeunload`
        handler cleared first). False when it can't be loaded."""
        for attempt in range(2):
            if attempt:
                with contextlib.suppress(Error):
                    await page.evaluate("() => { window.onbeforeunload = null; }")
            status, err = await self._open(page, policy, url, timeout_s)
            if err is None and status is not None and status < 400:
                await asyncio.sleep(SETTLE_MS / 1000)
                return True
        return False

    def _blocks(self, policy: ExplorationPolicy, since: int) -> list[tuple[str, str, str, str | None]]:
        """(method, url, observation, reason) of each request the guard aborted since `since`: writes, and reads of
        a sign-out or destructive address (a script's fetch, an image, a frame)."""
        out = []
        for w in policy.writes[since:]:
            why = w.get("reason")
            line = orc.skipped_line(w["url"], why) if why else orc.blocked_line(w["method"], w["url"])
            out.append((w["method"], w["url"], line, why))
        return out

    def _writes(self, policy: ExplorationPolicy, since: int) -> list[tuple[str, str]]:
        return [(w["method"], w["url"]) for w in policy.writes[since:]]

    async def _act(
        self,
        project: Project,
        key: str,
        page: Page,
        policy: ExplorationPolicy,
        url: str,
        a: act.Action,
        meter: lim.BudgetMeter,
        timeout_s: int,
    ) -> bool:
        """Takes one action and records it. Returns whether the page needs restoring before the next one."""
        path = act.path_of(url)
        if a.kind == "click" and a.selector:
            try:
                if await page.locator(f"css={a.selector}").count() == 0:
                    return True  # the element isn't there in this state: not an action, nothing spent
            except Error:
                return True
        n = meter.take()
        self.tried.add(a.fingerprint)
        self.pending.pop(a.fingerprint, None)
        before = await self._state(page)
        before_shot = await _screenshot(page)
        self.col.clear()
        writes_from, navs_from = len(policy.writes), len(policy.navs)
        redirects_before = set(policy.nav_redirects)
        nav_error: str | None = None
        try:
            if a.kind == "link" and a.href:
                status, nav_error = await self._open(page, policy, a.href, timeout_s)
                self.col.nav_status = status if status is not None else self.col.nav_status
            elif a.kind == "click" and a.selector:
                await page.locator(f"css={a.selector}").first.click(timeout=CLICK_TIMEOUT_MS)
            elif a.kind == "escape":
                await page.keyboard.press("Escape")
            elif a.kind == "reload":
                await page.reload(wait_until="domcontentloaded")
        except (PwTimeout, Error) as exc:
            nav_error = _short(str(exc))
        await asyncio.sleep(SETTLE_MS / 1000)
        # A click that navigated to a redirecting address: the policy stopped the browser at the redirect (it never
        # follows one itself); follow the validated hop through the policy, like a link.
        hops = [u for u in list(policy.nav_redirects) if u not in redirects_before]
        if hops:
            target = policy.nav_redirects.pop(hops[0])
            for u in hops[1:]:
                policy.nav_redirects.pop(u, None)
            status, nav_error = await self._open(page, policy, target, timeout_s)
            self.col.nav_status = status if status is not None else self.col.nav_status
            await asyncio.sleep(SETTLE_MS / 1000)
        stopped = policy.navs[navs_from:]
        if act.page_key(page.url) != act.page_key(url):
            with contextlib.suppress(PwTimeout, Error):
                await page.wait_for_load_state("load", timeout=5000)
        await self._mask(page)
        after = await self._state(page)
        closable: bool | None = None
        if after.dialogs > before.dialogs:
            closable = await self._dialog_closable(page, after.dialogs)
        real = urlsplit(after.url).scheme.lower() in ("http", "https")  # not chrome-error:// after a failed load
        navigated = real and act.page_key(after.url) != act.page_key(url)
        obs = orc.ActionObservation(
            before=before, after=after, action=a.verb, target=a.fingerprint,
            page_errors=list(self.col.errors), console_errors=list(self.col.console),
            responses=list(self.col.responses), nav_status=self.col.nav_status if navigated or a.kind == "link" else None,
            blocked=self._writes(policy, writes_from), dialog_closable=closable,
        )  # fmt: skip
        problems = orc.evaluate(obs)
        outcome = orc.outcome(problems, bool(obs.blocked) or bool(stopped), navigated, orc.changed(before, after))
        observations: list[dict[str, Any]] = []
        for method, wurl, line, why in self._blocks(policy, writes_from):
            observations.append({"kind": "blocked", "text": line})
            self.blocked.append({"request": f"{method} {act.path_of(wurl)}", "method": method,
                                 "path": act.path_of(wurl), "after": f"{a.verb[0].upper()}{a.verb[1:]} on {path}",
                                 "step": n, "text": line, "reason": why})  # fmt: skip
        for p in problems:
            observations.append({"kind": "problem", "rule": p.rule, "severity": p.severity, "text": p.title})
        for nav in stopped:
            reason = self._nav_reason(nav)
            observations.append({"kind": "blocked_navigation", "text": self._nav_line(nav, reason)})
            nt = act.NotTried(a.role, a.name, path, reason, a.fingerprint)
            if nt.fingerprint not in self.not_tried:
                self.not_tried[nt.fingerprint] = {**nt.as_dict(), "destination": self._nav_where(nav)}
                self.coverage[path]["not_tried"] += 1
        if navigated:
            observations.append({"kind": "navigated", "text": f"Opened {act.path_of(after.url)}"})
        if nav_error and not stopped:
            where = f" ({act.path_of(a.href)})" if a.href else ""
            observations.append({"kind": "error", "text": f"Navigation failed{where}: {nav_error}"})
        if self.col.dialogs:
            observations.append({"kind": "dialog", "text": "The page showed a browser dialog, which was dismissed"})
        if outcome == StepOutcome.no_effect.value:
            observations.append({"kind": "no_effect", "text": "No visible effect"})
        after_shot = await _screenshot(page) if problems else None
        reproduce = [f"Open {url}", _instruction(a)]
        await self._step(project, key, n, url, a, outcome, observations, problems, before_shot, after_shot, obs,
                         reproduce)  # fmt: skip
        cov = self.coverage[path]
        cov["actions"] += 1
        self.last_step = {"n": n, "page": path, "label": a.label, "outcome": outcome,
                          "observation": observations[0]["text"] if observations else None}  # fmt: skip
        await self._save_progress()
        await self._emit(project, "exploration.step", f"{key} step {n}: {outcome}",
                         {"scan_key": key, "n": n, "outcome": outcome})  # fmt: skip
        if navigated and (self.col.nav_status or 200) < 400:
            nxt = act.page_key(after.url)
            cap = self.ctx.settings.scan_max_pages_cap
            if (
                act.origin_of(nxt) == self.origin
                and nxt not in self.queue
                and nxt not in self.visited
                and len(self.queue) < cap
                and skip_reason(nxt) is None
            ):
                self.queue.append(nxt)
                self.pages_added += 1
        return outcome != StepOutcome.no_effect.value or a.kind != "click" or not real

    def _nav_where(self, nav: dict[str, str]) -> str:
        target = nav.get("target") or nav["url"]
        same = act.origin_of(target) == self.origin
        return act.path_of(target) if same else redact_url_tokens(act.origin_of(target) + act.path_of(target))[:300]

    def _nav_reason(self, nav: dict[str, str]) -> str:
        target = nav.get("target") or nav["url"]
        if act.origin_of(target) != self.origin:
            return act.OTHER_SITE
        if nav["reason"] in (act.ENDS_SESSION, act.DOWNLOADS, act.DESTRUCTIVE_LINK):
            return nav["reason"]
        return act.NAV_BLOCKED

    def _nav_line(self, nav: dict[str, str], reason: str) -> str:
        """'Navigation to /logout blocked: would end the session.' (the intended address, never followed)."""
        return f"Navigation to {self._nav_where(nav)} blocked: {reason[:1].lower()}{reason[1:]}."

    async def _dialog_closable(self, page: Page, open_now: int) -> bool:
        with contextlib.suppress(Error):
            await page.keyboard.press("Escape")
        await asyncio.sleep(0.2)
        after = await self._state(page)
        if after.dialogs < open_now:
            return True
        with contextlib.suppress(Error):
            return bool(await page.evaluate(CLOSE_CONTROL_JS))
        return False

    # ------------------------------------------------------------------ storing

    async def _shot(self, project: Project, scan_id: uuid.UUID, data: bytes | None, url: str, role: str, n: int | None,
                    s: Any) -> dict[str, Any] | None:  # fmt: skip
        if data is None:
            return None
        ev = await write_evidence(
            s,
            self.ctx.storage,
            org_id=project.organisation_id,
            project_id=project.id,
            kind=EvidenceKind.screenshot,
            data=data,
            mime="image/jpeg",
            name=f"step-{n or 0}-{role}.jpg",
            owner_id=scan_id,
            page_id=_uuid(self.page_ids.get(act.page_key(url))),
            source_url=url,
            viewport="desktop",
            metadata={"step": n, "role": role, "masked": "password inputs" + (", test login" if self.secrets else "")},
        )
        ev.quality_scan_id = scan_id
        await s.flush()
        return {"evidence_id": str(ev.id), "kind": "screenshot", "role": role, "step": n}

    async def _step(
        self,
        project: Project,
        key: str,
        n: int,
        url: str,
        a: act.Action,
        outcome: str,
        observations: list[dict[str, Any]],
        problems: list[orc.Problem],
        before_shot: bytes | None,
        after_shot: bytes | None,
        obs: orc.ActionObservation,
        reproduce: list[str],
    ) -> list[str]:
        refs: list[dict[str, Any]] = []
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            if problems:
                for data, role in ((before_shot, "before"), (after_shot, "after")):
                    ref = await self._shot(project, self.scan_id, data, url, role, n, s)
                    if ref:
                        refs.append(ref)
            s.add(
                ExploratoryStep(
                    organisation_id=project.organisation_id,
                    project_id=project.id,
                    scan_id=self.scan_id,
                    n=n,
                    page_url=url[:2048],
                    action={**a.as_dict(), "label": a.label},
                    outcome=StepOutcome(outcome),
                    observations=observations,
                    evidence_ids=[r["evidence_id"] for r in refs],
                    chosen_by=ChosenBy.rules,
                )
            )
            await s.commit()
        if problems:
            await self._findings(project, key, url, n, problems, a, None, obs, reproduce, n, refs=refs)
        return [r["evidence_id"] for r in refs]

    async def _findings(
        self,
        project: Project,
        key: str,
        url: str,
        n: int | None,
        problems: list[orc.Problem],
        a: act.Action | None,
        shot: bytes | None,
        obs: orc.ActionObservation,
        reproduce: list[str],
        group: Any,
        *,
        refs: list[dict[str, Any]] | None = None,
    ) -> None:
        path = act.path_of(url)
        console = [self._redact(x)[:300] for x in (obs.page_errors + obs.console_errors)][:MAX_CONSOLE]
        network = [f"{m} {act.path_of(u)} {st}" for m, u, st in obs.responses][:MAX_NETWORK]
        network += [f"{m} {act.path_of(u)} blocked" for m, u in obs.blocked][: max(0, MAX_NETWORK - len(network))]
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            scan = await s.get(QualityScan, self.scan_id)
            assert scan is not None
            if refs is None:
                ref = await self._shot(project, self.scan_id, shot, url, "after", n, s)
                refs = [ref] if ref else []
            new = 0
            for p in problems:
                fp = p.fingerprint(url, obs.target)
                if fp in self.findings:
                    f = await s.get(QualityFinding, self.findings[fp])
                    if f is not None and n is not None:
                        m = dict(f.mapped or {})
                        det = dict(m.get("details") or {})
                        det["steps_seen"] = [*(det.get("steps_seen") or []), n][:50]
                        m["details"] = det
                        f.mapped = m
                    continue
                self.finding_n += 1
                new += 1
                item = {
                    "rule_id": p.rule,
                    "severity": FindingSeverity(p.severity),
                    "title": p.title,
                    "url": url,
                    "page_id": self.page_ids.get(act.page_key(url)),
                    "viewport": "desktop",
                    "nodes": [],
                    "references": [],
                    "fingerprint": fp,
                    "evidence_refs": refs,
                    "observed": p.observed,
                    "subject": p.subject,
                    "steps": reproduce,
                    "step": n,
                    "console": console,
                    "network": network,
                    "action": {**a.as_dict(), "label": a.label} if a else None,
                    "group": group,
                    "category": orc.RULE_NAMES[p.rule],
                }
                f = await qsvc.add_finding(s, scan, self.finding_n, item, self.mapping.get(item["page_id"] or "", {}))
                await s.flush()
                self.findings[fp] = f.id
            await s.commit()
        self.coverage.setdefault(path, {"page": path, "actions": 0, "findings": 0, "not_tried": 0, "visited": True,
                                        "reason": None})["findings"] += new  # fmt: skip
        for p in problems[:new] if new else []:
            await self._emit(project, "quality.finding", f"Finding on {path}: {orc.RULE_NAMES[p.rule].lower()}, "
                             f"{p.severity}", {"scan_key": key, "severity": p.severity, "rule": p.rule})  # fmt: skip

    def _summary(self, meter: lim.BudgetMeter) -> dict[str, Any]:
        explored = [c for c in self.coverage.values() if c.get("visited")]
        not_visited = [act.path_of(u) for u in self.queue if act.path_of(u) not in self.coverage]
        coverage = list(self.coverage.values()) + [
            {"page": p, "actions": 0, "findings": 0, "not_tried": 0, "visited": False,
             "reason": "Not explored: the budget ran out."}
            for p in not_visited
        ]  # fmt: skip
        return {
            "actions": meter.used,
            "pages": len(explored),
            "pages_added": self.pages_added,
            "current_page": self.current,
            "last_step": self.last_step,
            "blocked": self.blocked,
            "not_tried": list(self.not_tried.values()),
            "never_reached": list(self.pending.values()),
            "coverage": coverage,
            "elements_tried": len(self.tried),
            "end_reason": self.end_reason,
        }

    async def _save_progress(self) -> None:
        # The meter lives in `_explore`'s caller; actions so far are the steps taken (`tried` counts them).
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            sc = await s.get(QualityScan, self.scan_id)
            if sc is not None:
                sm = dict(sc.summary or {})
                sm.update({
                    "actions": len(self.tried), "pages": sum(1 for c in self.coverage.values() if c.get("visited")),
                    "pages_added": self.pages_added, "current_page": self.current, "last_step": self.last_step,
                    "blocked": self.blocked, "not_tried": list(self.not_tried.values()),
                })  # fmt: skip
                sc.summary = sm
                await s.commit()

    # ------------------------------------------------------------------ ending

    async def _finish(self, project: Project, *, error: str | None, stopped: bool, meter: lim.BudgetMeter) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            sc = await s.get(QualityScan, self.scan_id)
            assert sc is not None
            if stopped:
                self.end_reason = "stopped"
            elif error:
                self.end_reason = "error"
            sc.summary = {**(sc.summary or {}), **self._summary(meter)}
            sc.finished_at = utcnow()
            drafted: list[str] = []
            added: list[str] = []
            if error is None:
                drafted, added = await esvc.drafts(s, project, sc)
            sc.summary = {**sc.summary, "drafted": drafted, "occurrences_added": added}
            if error is not None:
                sc.error = error
                status = QualityScanStatus.failed
            elif stopped:
                status = QualityScanStatus.cancelled
            else:
                status = QualityScanStatus.completed
            await self._set(s, project, sc, status)
            n_findings = len(self.findings)
            audit(s, org_id=sc.organisation_id, action="exploratory_session.finished", target_type="quality_scan",
                  target_id=sc.id, project_id=sc.project_id, actor_type=ActorType.system,
                  metadata={"key": sc.key, "status": status.value, "actions": meter.used,
                            "pages": sc.summary.get("pages"), "findings": n_findings,
                            "blocked": len(self.blocked), "drafted": drafted})  # fmt: skip
            from app.services.release import mark_stale

            await mark_stale(s, sc.project_id, f"{sc.key} finished")
            await s.commit()
            key = sc.key
            names: dict[uuid.UUID, str] = {}
            if stopped and (sc.config or {}).get("cancelled_by"):
                from app.services import serialize_p2 as out

                us = await out.users(s, [uuid.UUID(sc.config["cancelled_by"])])
                names = {k: (u.full_name or u.email) for k, u in us.items()}
            message = esvc.end_text(sc, names) or f"{key} finished"
        level = EventLevel.error if error else EventLevel.info
        await self._emit(project, "quality.scan_status",
                         f"{key} finished: {meter.used} actions on {sc.summary.get('pages')} pages, {n_findings} "
                         f"findings, {len(self.blocked)} blocked write attempts" if status == QualityScanStatus.completed
                         else f"{key}: {message}",
                         {"kind": "status", "scan_key": key, "status": status.value, "drafted": drafted}, level)  # fmt: skip
        for d in drafted:
            await self.ctx.events.emit(org_id=project.organisation_id, project_id=project.id, type="defect.drafted",
                                       message=f"Drafted {d} from {key}", stage_key=StageKey.exploratory.value,
                                       agent_key=AGENT, data={"kind": "result", "defect_key": d})  # fmt: skip

    async def _finish_error(self, s: Any, project: Project, scan: QualityScan, reason: str) -> None:
        scan.error = reason
        scan.finished_at = utcnow()
        scan.summary = {**(scan.summary or {}), "end_reason": "error"}
        await self._set(s, project, scan, QualityScanStatus.failed)
        audit(s, org_id=scan.organisation_id, action="exploratory_session.finished", target_type="quality_scan",
              target_id=scan.id, project_id=scan.project_id, actor_type=ActorType.system,
              metadata={"key": scan.key, "status": "failed", "reason": reason})  # fmt: skip
        await s.commit()
        await self._emit(project, "quality.scan_status", f"{scan.key} didn't complete: {reason}",
                         {"kind": "status", "scan_key": scan.key, "status": "failed"}, EventLevel.error)  # fmt: skip


def _instruction(a: act.Action) -> str:
    if a.kind == "link":
        return f'Click the link "{a.name}"'
    if a.kind == "escape":
        return "Press Escape"
    if a.kind == "reload":
        return "Reload the page"
    return f'Click the {a.role or "element"} "{a.name}"'


def _short(text: str) -> str:
    return (text or "").strip().splitlines()[0][:200] if (text or "").strip() else "the action failed"


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v)) if v else None
    except ValueError:
        return None


async def _close_quietly(page: Page) -> None:
    with contextlib.suppress(Error):
        await page.close()


async def _dismiss(d: Any) -> None:
    with contextlib.suppress(Error):
        await d.dismiss()


async def _accept(d: Any) -> None:
    with contextlib.suppress(Error):
        await d.accept()


async def run_session(ctx: AppContext, scope: TenantScope, scan_id: uuid.UUID, job: Job | None) -> None:
    """Runs the job. Whatever fails (before the session started, while it ran, or while it was being finished), the
    session ends `failed` with the reason and frees the project (the one-active-session index); the job fails too.
    A worker that dies is covered by the reaper (`session_interrupted`), queued or running."""
    try:
        await ExploreJob(ctx, scope, scan_id).run()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.exception("exploratory session job failed")
        await _fail_after_crash(ctx, scope, scan_id, f"{JOB_FAILED} ({type(exc).__name__})")
        raise


async def _fail_after_crash(ctx: AppContext, scope: TenantScope, scan_id: uuid.UUID, reason: str) -> None:
    try:
        async with ctx.session_factory() as s:
            bind_scope(s, scope)
            scan = await s.get(QualityScan, scan_id)
            if scan is None or scan.status not in esvc.ACTIVE:
                return
            project = (await s.execute(select(Project).where(Project.id == scan.project_id))).scalar_one()
            await ExploreJob(ctx, scope, scan.id)._finish_error(s, project, scan, reason)
    except Exception:
        log.exception("could not mark the exploratory session failed")


async def session_interrupted(ctx: AppContext, job: Job) -> None:
    """The reaper gave up on the job: a running session is `failed` "The worker stopped", with its steps kept."""
    scope = system_scope(job.organisation_id)
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        scan = await s.get(QualityScan, uuid.UUID(job.payload["scan_id"]))
        if scan is None or scan.status not in esvc.ACTIVE:
            return
        project = (await s.execute(select(Project).where(Project.id == scan.project_id))).scalar_one()
        await ExploreJob(ctx, scope, scan.id)._finish_error(s, project, scan, WORKER_STOPPED)
