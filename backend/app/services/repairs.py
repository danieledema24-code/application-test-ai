"""Locator repair suggestions (P6-04, decision D31): HEAL-0001 rows in `heal_suggestions`.

Two sources:
- **change**: after a rescan's impact is written (P6-02), every broken locator of an outdated script gets one
  suggestion (`propose_for_change_set`), before any test fails;
- **failure**: P4-08's "Element not found" path (`propose_from_failure`). The Phase 4 JSON on the result is still
  written, so the P4-08 accept endpoint and Phase 4 screens keep working; that endpoint now also decides the row.

Candidates come from the live page, loaded read-only (page loads only; the one sign-in with the saved test account when
a page needs it, as the G6 check does): never a click, a typed value or a submission. Each offered candidate finds
exactly one visible, enabled element with the original's role, and has a masked screenshot with that element
outlined. The score and its signals are code (`app.domain.change.heal`). With AI on, the model may only reorder the
verified candidates and explain the order; any other answer is rejected, logged, and the rule order kept.

A person accepts one suggestion at a time (no batch accept, nothing applied automatically): the page object gets a new
version with that one locator line changed (`heal.apply_fix`, then the expected-value guard), its scripts go back to
"not checked" once none of their locators is still broken, and the G6 checks run on them again. Other open
suggestions for the same locator are replaced. A reject needs a reason; the same candidates aren't offered again for
that locator on that page. When a text a script checks changed, the suggestion is an "Expected result may be out of
date" review: it links the case and has no accept action (expected results are never changed).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, NotFound, ValidationFailed
from app.context import AppContext
from app.db.models import (
    AutomationAsset,
    AutomationScript,
    ChangeItem,
    ChangeSet,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    HealSuggestion,
    Project,
    ProjectUrl,
    StageRun,
    User,
)
from app.db.tenant import TenantScope, bind_scope
from app.db.types import utcnow
from app.domain.automation import emit
from app.domain.automation import expected_guard as guard
from app.domain.change import heal as hd
from app.domain.change import impact as im
from app.domain.enums import (
    ActorType,
    ChangeKind,
    ChangeSetStatus,
    EvidenceKind,
    GeneratedBy,
    HealKind,
    HealSource,
    HealStatus,
    ResultStatus,
    ScriptGeneratedBy,
    ScriptStatus,
    StageKey,
    UrlRole,
)
from app.llm.base import UntrustedBlock
from app.services import automation as asvc
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.counters import next_key
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)
AGENT = "repairs"
PAGE_TIMEOUT_MS = 15_000
REASON_NEEDED = "Say why. The reason is kept with the suggestion."
NO_CANDIDATE = "No safe replacement found: nothing on {page} matches exactly once with the same role."
DECIDED = {HealStatus.accepted, HealStatus.rejected, HealStatus.superseded}

# In-page reads only (page.evaluate): roles, names and where each control sits. Nothing is clicked or typed.
_FACTS = """
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const FIELDS = ['textbox','searchbox','combobox','listbox','checkbox','radio','spinbutton','slider'];
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r.split(' ')[0];
    const t = el.tagName.toLowerCase();
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (t === 'form') return 'form';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'range') return 'slider';
      if (ty === 'number') return 'spinbutton';
      if (ty === 'search') return 'searchbox';
      if (ty === 'hidden' || ty === 'file') return '';
      return 'textbox';
    }
    return '';
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const ids = el.getAttribute('aria-labelledby');
    if (ids) return clean(ids.split(/\\s+/).map((i) => (document.getElementById(i) || {}).innerText || '').join(' '));
    return '';
  };
  const placeOf = (el) => {
    const f = el.closest('form');
    if (f) return 'form#' + Array.from(document.forms).indexOf(f);
    const l = el.closest('nav,main,header,footer,aside,[role=navigation],[role=main],[role=banner],[role=contentinfo],[role=complementary]');
    return l ? (l.getAttribute('role') || l.tagName.toLowerCase()) : 'body';
  };
  const facts = (el) => {
    const role = roleOf(el);
    const field = FIELDS.includes(role);
    const label = labelOf(el);
    const text = field ? '' : clean(el.innerText || el.value || '');
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return {
      role, label, text,
      name: label || (field ? clean(el.getAttribute('placeholder') || el.getAttribute('title')) : text || clean(el.getAttribute('title'))),
      placeholder: clean(el.getAttribute('placeholder')),
      testid: el.getAttribute('data-testid') || '',
      place: placeOf(el),
      visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none',
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    };
  };
"""
COLLECT_JS = (
    "() => {"
    + _FACTS
    + """
  const out = [];
  document.querySelectorAll('a[href], button, input, textarea, select, summary, [role]').forEach((el) => {
    const f = facts(el);
    if (f.role && f.role !== 'form' && f.name) out.push(f);
  });
  return out.slice(0, 400);
}"""
)
FACTS_JS = "(el) => {" + _FACTS + " return facts(el); }"
OUTLINE_JS = """(el) => {
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.setAttribute('data-ata-outline', '1');
  box.style.cssText = `position:absolute;left:${r.left + window.scrollX - 4}px;top:${r.top + window.scrollY - 4}px;` +
    `width:${r.width + 8}px;height:${r.height + 8}px;outline:3px solid #b91c1c;box-shadow:inset 0 0 0 2px #fff;` +
    'z-index:2147483647;pointer-events:none';
  document.body.appendChild(box);
}"""
CLEAR_JS = "() => document.querySelectorAll('[data-ata-outline]').forEach((e) => e.remove())"


# ---------------------------------------------------------------- the locator jobs


@dataclass
class Job:
    """One broken page-object locator to find a replacement for."""

    file: str
    getter: str
    page: str
    spec: dict[str, Any]
    lineages: list[str]
    change_ids: list[str] = field(default_factory=list)
    match: hd.DiffMatch | None = None
    ambiguous: list[str] = field(default_factory=list)
    taken: set[str] = field(default_factory=set)
    siblings: list[dict[str, Any]] = field(default_factory=list)
    order: int = 0

    @property
    def old_expression(self) -> str:
        return hd.spec_expression(self.spec)


@dataclass
class Checked:
    """What the live page said about one job."""

    candidates: list[hd.Candidate] = field(default_factory=list)
    fingerprint: str | None = None
    reason: str | None = None  # why the page couldn't be checked
    shots: dict[str, bytes] = field(default_factory=dict)  # element key -> outlined screenshot
    checked_at: str | None = None


def _ekey(e: hd.Element) -> str:
    return f"{e.role}|{hd.fold(e.name)}"


def _shown(spec: dict[str, Any]) -> dict[str, Any]:
    """The element a candidate is about: for "the form that has this button", the button (its role is checked and
    outlined); otherwise the spec itself."""
    if spec.get("by") == "form_button":
        return {"by": "role", "role": "button", "name": spec.get("name"), "exact": False}
    return spec


async def _evaluate_job(page: Any, job: Job, elements: list[hd.Element]) -> Checked:
    from playwright.async_api import Error

    from app.agents.automation.validation import _locate

    res = Checked(fingerprint=hd.page_fingerprint(elements), checked_at=utcnow().isoformat())
    role = hd.original_role(job.spec)
    if not role:
        return res
    # Where the page object's other elements sit (for "In the same form").
    places: list[str] = []
    for sib in job.siblings:
        with contextlib.suppress(Error):
            loc = _locate(page, sib)
            if await loc.count() == 1:
                places.append(str((await loc.first.evaluate(FACTS_JS)).get("place") or ""))
    original_place = hd.majority_place(places)
    targets = hd.likely_elements(
        job.spec, elements, taken=job.taken, new_name=job.match.new_name if job.match else None
    )
    ambiguous = {hd.fold(n) for n in job.ambiguous}
    old_name = str(job.spec.get("name") or job.spec.get("element") or "")
    seen: set[str] = set()
    for el in targets:
        for strategy, spec in hd.candidate_specs(job.spec, el):
            expr = hd.spec_expression(spec)
            if expr in seen or expr == job.old_expression:
                continue
            seen.add(expr)
            try:
                n = await _locate(page, spec).count()
                if n > 1 and spec["by"] in ("role", "text"):
                    exact = {**spec, "exact": True}
                    if await _locate(page, exact).count() == 1:
                        spec, n, expr = exact, 1, hd.spec_expression(exact)
            except Error:
                n = 0
            if n == 0:
                continue
            cand = hd.Candidate(expr, strategy, spec, el, match_count=n, offered=False)
            if hd.fold(el.name) in ambiguous:
                cand.match_count = max(n, len(ambiguous))
                cand.not_offered_reason = hd.AMBIGUOUS
            elif n > 1:
                cand.not_offered_reason = hd.AMBIGUOUS
            else:
                try:
                    facts = hd.element_of(await _locate(page, _shown(spec)).first.evaluate(FACTS_JS))
                except Error:
                    continue
                if not hd.same_role(role, facts.role):
                    continue  # its role doesn't match the original's: never offered
                if not (facts.visible and facts.enabled):
                    continue
                cand.element = hd.Element(**{**facts.__dict__, "name": el.name})
                cand.offered = True
            s = hd.score(old_name=old_name, original=job.spec, strategy=strategy, element=cand.element,
                         match=job.match, original_place=original_place)  # fmt: skip
            cand.score, cand.level = s.score, s.level
            cand.signals = [{"code": x.code, "text": x.text} for x in s.signals]
            res.candidates.append(cand)
    res.candidates = hd.rank(res.candidates, job.spec)
    # One outlined screenshot per offered element (password fields masked).
    for cand in res.candidates:
        if not cand.offered or _ekey(cand.element) in res.shots:
            continue
        try:
            target = _locate(page, _shown(cand.spec)).first
            await target.evaluate(OUTLINE_JS)
            res.shots[_ekey(cand.element)] = await page.screenshot(
                type="jpeg", quality=70, full_page=True, mask=[page.locator("input[type=password]")], timeout=10_000
            )
        except Error:
            pass
        finally:
            with contextlib.suppress(Error):
                await page.evaluate(CLEAR_JS)
    return res


@contextlib.asynccontextmanager
async def _site(
    ctx: AppContext, scope: TenantScope, project: Project, *, sign_in_needed: bool
) -> AsyncIterator[tuple[Any, bool, str]]:
    """An isolated browser context under the network policy (G1 hosts, SSRF rules). Signs in with the saved test
    account only when a page to check is behind sign-in. Yields (context, signed in, origin)."""
    from app.agents.discovery.signin import sign_in
    from app.browser.network_policy import NetworkPolicy
    from app.security.ssrf import normalise_url
    from app.services.secrets import credentials_secret, use_credentials

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        url = (
            await s.execute(
                select(ProjectUrl).where(ProjectUrl.project_id == project.id, ProjectUrl.role == UrlRole.primary)
            )
        ).scalar_one_or_none()
        secret = await credentials_secret(s, project.id) if sign_in_needed else None
        creds = await use_credentials(ctx, s, secret, purpose="heal_verification", task_id=None) if secret else None
        await s.commit()
    if url is None:
        raise RuntimeError("the project has no target URL")
    start = normalise_url((url.last_check or {}).get("final_url") or url.url)
    origins = {start.origin}
    login_url = (creds or {}).get("login_url")
    if login_url:
        with contextlib.suppress(Exception):
            origins.add(normalise_url(login_url).origin)
    policy = NetworkPolicy(
        approved_origins=origins,
        allowed_hosts=list(url.allowed_hosts or []) or [start.host],
        allow_private_targets=ctx.settings.allow_private_targets,
        resolver=ctx.resolver,
        fetch_timeout_ms=PAGE_TIMEOUT_MS,
    )
    async with ctx.browser_pool.isolated_context(policy) as context:
        signed = False
        if creds and login_url:
            outcome = await sign_in(context, policy, login_url, creds["username"], creds["password"])
            signed = outcome.result == "succeeded"
        del creds
        yield context, signed, start.origin


async def check_live(
    ctx: AppContext, scope: TenantScope, project: Project, jobs: list[Job], auth_paths: set[str] | None = None
) -> dict[tuple[str, str], Checked]:
    """Loads each page once (read-only) and finds the candidates of every job on it."""
    from playwright.async_api import Error

    out: dict[tuple[str, str], Checked] = {}
    by_page: dict[str, list[Job]] = {}
    for j in jobs:
        by_page.setdefault(j.page, []).append(j)
    needs = auth_paths or set()
    if not jobs:
        return out
    try:
        async with _site(ctx, scope, project, sign_in_needed=bool(set(by_page) & needs)) as (context, signed, origin):
            for path, page_jobs in sorted(by_page.items()):
                if path in needs and not signed:
                    for j in page_jobs:
                        out[(j.file, j.getter)] = Checked(reason="it needs sign-in and the test account didn't work")
                    continue
                page = await context.new_page()
                page.set_default_timeout(PAGE_TIMEOUT_MS)
                try:
                    await page.goto(urljoin(origin + "/", path.lstrip("/")), wait_until="domcontentloaded")
                    with contextlib.suppress(Error):
                        await page.wait_for_load_state("load", timeout=5_000)
                    elements = [hd.element_of(x) for x in await page.evaluate(COLLECT_JS)]
                    for j in page_jobs:
                        out[(j.file, j.getter)] = await _evaluate_job(page, j, elements)
                except Error:
                    for j in page_jobs:
                        out.setdefault((j.file, j.getter), Checked(reason="the page couldn't be opened"))
                finally:
                    with contextlib.suppress(Error):
                        await page.close()
    except Exception:  # noqa: BLE001 - no browser or no URL: suggestions say the page couldn't be checked
        log.warning("repair suggestions: the live page couldn't be checked")
    for j in jobs:
        out.setdefault((j.file, j.getter), Checked(reason="the browser couldn't start"))
    return out


# ---------------------------------------------------------------- AI: reorder verified candidates only


class AiRepairOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    order: list[str] = Field(max_length=3)
    explanation: str = Field(min_length=10, max_length=300)


async def ai_reorder(
    ctx: AppContext, s: AsyncSession, project: Project, key: str, job: Job, cands: list[hd.Candidate]
) -> tuple[list[hd.Candidate], str | None]:
    """With AI on, the model may reorder the verified candidates and explain the choice. An answer naming an
    expression that wasn't verified, or anything but an order (an assertion, an expected text), is rejected: an audit
    entry records the issue and the rule order stays."""
    offered = [c for c in cands if c.offered]
    if not ctx.llm.enabled or len(offered) < 2:
        return cands, None
    listing = "\n".join(
        f"- {c.expression}: {'; '.join(str(x['text']) for x in c.signals)} (score {c.score:.2f})" for c in offered
    )
    task = (
        f"A page object's locator {job.old_expression} no longer finds its element on {job.page}. These replacement "
        "locators were each checked on the live page and find exactly one element. Order them, most likely first, "
        "and explain the order in one sentence. Return `order` with exactly these expressions, each once, and nothing "
        "else: never a new locator, an assertion or an expected result."
    )
    res = await ctx.llm.structured(AiRepairOrder, task, [UntrustedBlock("verified locators", listing, 4000)])
    issue: str | None = None
    order: list[str] | None = None
    if not res.ok or res.value is None:
        issue = "; ".join(res.issues)[:300] or res.reason or "The answer wasn't a valid order"
    else:
        order = hd.ai_order([c.expression for c in offered], res.value.order)
        if order is None:
            unknown = [x for x in res.value.order if x not in {c.expression for c in offered}]
            issue = (
                "The answer named an expression that wasn't verified: " + ", ".join(unknown)[:250]
                if unknown
                else "The answer didn't list every verified candidate once"
            )
    if order is None or res.value is None:
        log.info("AI repair order rejected for %s: %s", key, issue)
        audit(s, org_id=project.organisation_id, action="heal_suggestion.ai_rejected", target_type="heal_suggestion",
              actor_type=ActorType.system, project_id=project.id, metadata={"key": key, "issue": issue})  # fmt: skip
        return cands, None
    by_expr = {c.expression: c for c in offered}
    rest = [c for c in cands if not c.offered]
    return [by_expr[x] for x in order] + rest, res.value.explanation.strip()


# ---------------------------------------------------------------- writing suggestions


async def _write(
    ctx: AppContext,
    s: AsyncSession,
    project: Project,
    job: Job,
    checked: Checked,
    *,
    source: HealSource,
    change_item_id: uuid.UUID | None,
    result: ExecutionResult | None,
    asset: AutomationAsset | None,
) -> HealSuggestion:
    sid = uuid.uuid4()
    _n, key = await next_key(s, project.organisation_id, project.id, "heal")
    cands, explanation = await ai_reorder(ctx, s, project, key, job, checked.candidates)
    stored: list[dict[str, Any]] = []
    evidence: dict[str, str] = {}
    for c in cands:
        ek = _ekey(c.element)
        if c.offered and ek in checked.shots and ek not in evidence:
            ev = await write_evidence(
                s, ctx.storage, org_id=project.organisation_id, project_id=project.id, kind=EvidenceKind.screenshot,
                data=checked.shots[ek], mime="image/jpeg", name="repair-outlined.jpg", owner_id=sid,
                source_url=job.page, metadata={"outlined": f"{hd.role_word(c.element.role)} '{c.element.name}'",
                                               "masked": "password inputs", "heal": key},
            )  # fmt: skip
            if result is not None:
                ev.execution_result_id = result.id
            await s.flush()
            evidence[ek] = str(ev.id)
        d = c.as_dict()
        d["evidence_id"] = evidence.get(ek) if c.offered else None
        d["page_fingerprint"] = checked.fingerprint
        d["checked_at"] = checked.checked_at
        stored.append(d)
    if explanation and stored:
        stored[0]["ai_explanation"] = explanation
    meta = {"page": job.page, "page_fingerprint": checked.fingerprint, "checked_at": checked.checked_at,
            "unchecked_reason": checked.reason, "element": str(job.spec.get("element") or ""), "meta": True}  # fmt: skip
    row = HealSuggestion(
        id=sid,
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        source=source,
        change_item_id=change_item_id,
        execution_result_id=result.id if result else None,
        automation_asset_id=asset.id if asset else None,
        asset_version=asset.version if asset else None,
        file=job.file,
        getter=job.getter,
        old_expression=job.old_expression,
        candidates=[*stored, meta],
        kind=HealKind.locator,
        test_case_lineage_id=uuid.UUID(job.lineages[0]) if job.lineages else None,
        generated_by=GeneratedBy.ai if explanation else GeneratedBy.rules,
    )
    s.add(row)
    audit(s, org_id=project.organisation_id, action="heal_suggestion.created", target_type="heal_suggestion",
          target_id=sid, actor_type=ActorType.system, project_id=project.id,
          metadata={"key": key, "source": source.value, "file": job.file, "getter": job.getter,
                    "offered": sum(1 for c in stored if c["offered"])})  # fmt: skip
    return row


def split(row: HealSuggestion) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The candidates and the suggestion's own facts (page, fingerprint, check time), stored as the list's last
    entry (`meta: true`) because `heal_suggestions` has no other JSON column."""
    items = [dict(x) for x in row.candidates or [] if isinstance(x, dict)]
    meta = next((x for x in items if x.get("meta")), {})
    return [x for x in items if not x.get("meta")], meta


async def _rejected_before(s: AsyncSession, project_id: uuid.UUID, job: Job, fingerprint: str | None) -> bool:
    """A rejected suggestion for the same locator on the same page (same fingerprint) isn't offered again."""
    rows = (
        await s.execute(
            select(HealSuggestion).where(
                HealSuggestion.project_id == project_id,
                HealSuggestion.kind == HealKind.locator,
                HealSuggestion.status == HealStatus.rejected,
                HealSuggestion.file == job.file,
                HealSuggestion.getter == job.getter,
                HealSuggestion.old_expression == job.old_expression,
            )
        )
    ).scalars()
    for r in rows:
        _c, meta = split(r)
        if meta.get("page_fingerprint") in (None, fingerprint):
            return True
    return False


def _bundle_maps(
    output: dict[str, Any],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str], dict[str, list[str]]]:
    specs: dict[str, list[dict[str, Any]]] = {
        k: [dict(x) for x in v] for k, v in (output.get("locators") or {}).items()
    }
    return (
        specs,
        dict(output.get("pages") or {}),
        {k: list(v) for k, v in (output.get("script_locators") or {}).items()},
    )


def _job(file: str, getter: str, specs: dict[str, list[dict[str, Any]]], pages: dict[str, str],
         refs: dict[str, list[str]]) -> Job | None:  # fmt: skip
    items = specs.get(file, [])
    spec = next((x for x in items if x.get("getter") == getter), None)
    if spec is None or file not in pages:
        return None
    lineages = sorted(lin for lin, rs in refs.items() if f"{file}#{getter}" in rs)
    taken = {str(x.get("name") or "") for x in items if x.get("getter") != getter}
    siblings = [x for x in items if x.get("getter") != getter and x.get("by") in ("label", "placeholder", "role")]
    order = next((i for i, x in enumerate(items) if x.get("getter") == getter), 0)
    return Job(file, getter, pages[file], spec, lineages, taken=taken, siblings=siblings[:6], order=order)


async def propose_for_change_set(ctx: AppContext, scope: TenantScope, change_set_id: uuid.UUID) -> dict[str, int]:
    """One suggestion per broken locator of the change set's outdated scripts (source `change`), then an "Expected
    result may be out of date" review for each case whose script checks a text the change set changed. Retry-safe:
    a locator that already has a suggestion from this change set gets no second one."""
    from app.services.impact import change_in

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one()
        if cs.stage_run_id is None or cs.status != ChangeSetStatus.completed:
            return {"locator": 0, "review": 0}
        project = (await s.execute(select(Project).where(Project.id == cs.project_id))).scalar_one()
        rows = list((await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars())
        changes = [change_in(r) for r in rows]
        change_ids = {str(r.id) for r in rows}
        broken: dict[str, list[dict[str, Any]]] = dict(
            ((cs.summary or {}).get("locator_check") or {}).get("broken") or {}
        )
        bundle = await asvc.current_run(s, project.id, StageKey.automation)
        output = dict(bundle.output or {}) if bundle else {}
        scripts, assets = await asvc.bundle_rows(s, bundle.id) if bundle else ([], [])
        existing = list(
            (await s.execute(select(HealSuggestion).where(HealSuggestion.project_id == project.id))).scalars()
        )
        set_key = cs.key
    have = {(h.file, h.getter) for h in existing if h.source == HealSource.change and str(h.change_item_id) in change_ids
            and h.kind == HealKind.locator}  # fmt: skip
    specs, pages, refs = _bundle_maps(output)
    jobs: dict[tuple[str, str], Job] = {}
    for lineage, locs in sorted(broken.items()):
        for loc in locs:
            k = (str(loc.get("file")), str(loc.get("getter")))
            if k in have or k in jobs:
                continue
            j = _job(k[0], k[1], specs, pages, refs)
            if j is None:
                continue
            li = im.LocatorIn(file=j.file, getter=j.getter, page=j.page, by=str(j.spec.get("by") or ""),
                              name=str(j.spec.get("name") or ""), role=str(j.spec.get("role") or ""),
                              element=str(j.spec.get("element") or ""), within=str(j.spec.get("within") or ""))  # fmt: skip
            j.match = hd.diff_match(li, changes, set_key)
            j.ambiguous = hd.ambiguous_renames(li, changes)
            names = {hd.fold(li.name), hd.fold(li.element)} - {""}
            j.change_ids = [
                c.id for c in changes if (c.page == j.page) and ({hd.fold(n) for n in im.used_names(c)} & names)
            ]
            if j.match is not None and j.match.change_id not in j.change_ids:
                j.change_ids.insert(0, j.match.change_id)
            if lineage not in j.lineages:
                j.lineages.append(lineage)
            jobs[k] = j
    # A link to a page the change set removed has no right replacement: its cases get a review, not a repair.
    removed = {c.page for c in changes if c.kind == ChangeKind.page_removed and c.page}
    gone = [j for j in jobs.values() if hd.link_target(j.spec) in removed]
    for j in gone:
        del jobs[(j.file, j.getter)]
    # Locators a person reads (role, label, …) first, then structural ones (a form found by its button, a CSS
    # selector), each by page, file and position in the page object: keys follow what the demo reads (design P6 §14).
    ordered = sorted(jobs.values(), key=lambda j: (j.spec.get("by") not in hd.STRATEGIES, j.page, j.file, j.order))
    checked = await check_live(ctx, scope, project, ordered, await _auth(ctx, scope, project.id, ordered))
    made = 0
    reviews = 0
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        project = (await s.execute(select(Project).where(Project.id == project.id))).scalar_one()
        by_path = {a.path: a for a in assets}
        fallback = next(iter(sorted(change_ids)), None)
        for j in ordered:
            res = checked[(j.file, j.getter)]
            if await _rejected_before(s, project.id, j, res.fingerprint):
                continue
            options = j.change_ids or [c.id for c in changes if c.page == j.page]
            first = options[0] if options else fallback
            await _write(ctx, s, project, j, res, source=HealSource.change,
                         change_item_id=uuid.UUID(first) if first else None, result=None, asset=by_path.get(j.file))  # fmt: skip
            made += 1
        # Expected results are never changed: a changed text a script checks is a review for a person.
        keys = await asvc._case_keys(s, [x.test_case_id for x in scripts])
        checks = []
        for x in scripts:
            mine = {pages.get(r.split("#", 1)[0]) for r in refs.get(str(x.case_lineage_id), [])} - {None}
            checks.append(hd.ScriptChecks(str(x.case_lineage_id), keys.get(x.test_case_id, x.path), frozenset(
                str(p) for p in mine), tuple(dict(a) for a in x.assertion_map or [])))  # fmt: skip
        open_reviews = {
            (str(h.test_case_lineage_id), (split(h)[1].get("review") or {}).get("before"))
            for h in existing
            if h.kind == HealKind.expected_result_review and h.status == HealStatus.open
        }
        removed_ids = {c.page: c.id for c in changes if c.kind == ChangeKind.page_removed and c.page}
        for j in gone:
            target = str(hd.link_target(j.spec))
            for lin in j.lineages:
                user = next((x for x in scripts if str(x.case_lineage_id) == lin), None)
                if user is None or (lin, target) in open_reviews:
                    continue
                rv = hd.TextReview(lin, keys.get(user.test_case_id, user.path), j.page, target, None, "followLink",
                                   removed_ids.get(target), set_key, reason="page_removed")  # fmt: skip
                await _write_review(s, project, rv, source=HealSource.change, change_item_id=rv.change_id, result=None)
                open_reviews.add((lin, target))
                reviews += 1
        for rv in hd.asserted_text_reviews(changes, checks, set_key):
            if (rv.lineage, rv.before) in open_reviews:
                continue
            await _write_review(s, project, rv, source=HealSource.change, change_item_id=rv.change_id, result=None)
            reviews += 1
        await s.commit()
    if made or reviews:
        n = made + reviews
        await ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type="repair.suggested",
            message=f"{set_key}: {n} repair suggestion{'s' if n != 1 else ''} to review",
            stage_key=StageKey.change_analysis.value,
            agent_key=AGENT,
            data={"kind": "result", "change_set_key": set_key, "locator": made, "review": reviews},
        )
    return {"locator": made, "review": reviews}


async def _auth(ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, jobs: list[Job]) -> set[str]:
    from app.agents.automation.validation import _auth_paths

    return await _auth_paths(ctx, scope, project_id, {j.page for j in jobs})


async def _write_review(
    s: AsyncSession,
    project: Project,
    rv: hd.TextReview,
    *,
    source: HealSource,
    change_item_id: str | None,
    result: ExecutionResult | None,
) -> HealSuggestion:
    _n, key = await next_key(s, project.organisation_id, project.id, "heal")
    row = HealSuggestion(
        organisation_id=project.organisation_id,
        project_id=project.id,
        key=key,
        source=source,
        change_item_id=uuid.UUID(change_item_id) if change_item_id else None,
        execution_result_id=result.id if result else None,
        kind=HealKind.expected_result_review,
        test_case_lineage_id=uuid.UUID(rv.lineage),
        candidates=[{"meta": True, "page": rv.page, "review": rv.as_dict()}],
        generated_by=GeneratedBy.rules,
    )
    s.add(row)
    await s.flush()
    audit(s, org_id=project.organisation_id, action="heal_suggestion.created", target_type="heal_suggestion",
          target_id=row.id, actor_type=ActorType.system, project_id=project.id,
          metadata={"key": key, "source": source.value, "kind": "expected_result_review", "case": rv.case_key})  # fmt: skip
    return row


async def latest_changes(s: AsyncSession, project_id: uuid.UUID) -> tuple[list[im.ChangeIn], str | None]:
    """The changes of the latest finished rescan change set (the strongest signal for a failure's repair too)."""
    from app.services.impact import change_in

    cs = (
        await s.execute(
            select(ChangeSet)
            .where(ChangeSet.project_id == project_id, ChangeSet.status == ChangeSetStatus.completed,
                   ChangeSet.stage_run_id.is_not(None))
            .order_by(ChangeSet.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()  # fmt: skip
    if cs is None:
        return [], None
    rows = (await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars()
    return [change_in(r) for r in rows], cs.key


async def propose_from_failure(
    ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, result_id: uuid.UUID, error: str
) -> HealSuggestion | None:
    """The reactive source: a script failed with "Element not found". One suggestion for the missing locator, unless
    one is already open for it (from a change set or an earlier failure). A failed text check gets a review."""
    from app.services import heal as p4

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        r = await s.get(ExecutionResult, result_id)
        project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
        script = await s.get(AutomationScript, r.automation_script_id) if r and r.automation_script_id else None
        if r is None or script is None:
            return None
        review = hd.failed_text_review(
            error, dict(r.page_state or {}), lineage=str(script.case_lineage_id),
            case_key=(await asvc._case_keys(s, [script.test_case_id])).get(script.test_case_id, script.path),
            result_key=r.key,
        )  # fmt: skip
        if review is not None:
            row = await _write_review(s, project, review, source=HealSource.failure, change_item_id=None, result=r)
            await s.commit()
            return row
        missing = p4.parse_locator(error)
        bundle = await s.get(StageRun, script.stage_run_id)
        output = dict(bundle.output or {}) if bundle else {}
        found = p4.find_spec(output, str(script.case_lineage_id), missing) if missing else None
        if found is None:
            return None
        specs, pages, refs = _bundle_maps(output)
        job = _job(found[0], str(found[1].get("getter")), specs, pages, refs)
        if job is None:
            return None
        already = (
            await s.execute(
                select(HealSuggestion).where(
                    HealSuggestion.project_id == project_id, HealSuggestion.status == HealStatus.open,
                    HealSuggestion.kind == HealKind.locator, HealSuggestion.file == job.file,
                    HealSuggestion.getter == job.getter,
                )
            )
        ).scalars().first()  # fmt: skip
        if already is not None:
            return already
        changes, set_key = await latest_changes(s, project_id)
        asset = (
            await s.execute(
                select(AutomationAsset).where(
                    AutomationAsset.stage_run_id == script.stage_run_id, AutomationAsset.path == job.file
                )
            )
        ).scalar_one_or_none()
    if set_key:
        li = im.LocatorIn(file=job.file, getter=job.getter, page=job.page, by=str(job.spec.get("by") or ""),
                          name=str(job.spec.get("name") or ""), role=str(job.spec.get("role") or ""),
                          element=str(job.spec.get("element") or ""), within=str(job.spec.get("within") or ""))  # fmt: skip
        job.match = hd.diff_match(li, changes, set_key)
        job.ambiguous = hd.ambiguous_renames(li, changes)
    checked = (await check_live(ctx, scope, project, [job], await _auth(ctx, scope, project_id, [job])))[
        (job.file, job.getter)
    ]
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
        r = await s.get(ExecutionResult, result_id)
        if r is None or await _rejected_before(s, project_id, job, checked.fingerprint):
            return None
        row = await _write(ctx, s, project, job, checked, source=HealSource.failure, change_item_id=None, result=r,
                           asset=asset)  # fmt: skip
        await s.commit()
        return row


# ---------------------------------------------------------------- deciding


def _decided_message(who: User | None) -> str:
    return f"This suggestion was already decided by {(who.full_name or 'a team member') if who else 'a team member'}."


async def _guard_open(s: AsyncSession, sug: HealSuggestion) -> None:
    if sug.status != HealStatus.open:
        who = await s.get(User, sug.decided_by) if sug.decided_by else None
        raise Conflict(_decided_message(who))


def remove_clause(reason: str | None, old: str) -> str | None:
    """The outdated reason without the clause for a repaired locator ("getByLabel('Message') not found after
    CHG-0001"); None when nothing is left."""
    clauses = [c for c in (reason or "").split("; ") if c.strip()]
    left = [c for c in clauses if not c.startswith(f"{old} not found after ")]
    return "; ".join(left) or None


# Accepts that rewrite the same page object run one at a time (QA P6-04: two at once lost one change, or answered 500
# from the revision's unique version). In-process locks serialise one API process; `with_for_update` on the asset does
# it across processes on Postgres.
_ACCEPT_LOCKS: dict[tuple[uuid.UUID, str], asyncio.Lock] = {}


def accept_lock(project_id: uuid.UUID, file: str | None) -> asyncio.Lock:
    return _ACCEPT_LOCKS.setdefault((project_id, file or ""), asyncio.Lock())


async def accept(
    s: AsyncSession, project: Project, sug: HealSuggestion, index: int, user: User
) -> tuple[AutomationAsset, list[AutomationScript], list[str]]:
    """Applies candidate `index`: a new page-object version with only that locator line changed. Returns the asset,
    the scripts that must pass their checks again (back to "not checked"), and the keys of suggestions replaced."""
    from app.services import heal as p4
    from app.services import revisions

    if sug.kind != HealKind.locator:
        raise Conflict("Expected results are never changed automatically. Review the test case instead.")
    await _guard_open(s, sug)
    cands, _meta = split(sug)
    if index < 0 or index >= len(cands) or not cands[index].get("offered"):
        raise ValidationFailed("Choose one of the offered replacements.",
                               details=[{"field": "index", "message": "Choose one of the offered replacements."}])  # fmt: skip
    cand = cands[index]
    bundle = await asvc.current_run(s, project.id, StageKey.automation)
    asset = (
        await s.get(AutomationAsset, sug.automation_asset_id, with_for_update=True, populate_existing=True)
        if sug.automation_asset_id
        else None
    )
    if asset is None and bundle is not None:
        asset = (
            await s.execute(
                select(AutomationAsset)
                .where(AutomationAsset.stage_run_id == bundle.id, AutomationAsset.path == sug.file)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
    if asset is None or bundle is None or asset.stage_run_id != bundle.id:
        raise Conflict("These scripts were replaced by a newer version. Nothing was changed.")
    output = dict(bundle.output or {})
    specs, _pages, refs = _bundle_maps(output)
    item = next((x for x in specs.get(str(sug.file), []) if x.get("getter") == sug.getter), None)
    if item is None or hd.spec_expression(item) != sug.old_expression:
        raise Conflict("The page object changed since this suggestion. Nothing was changed.")
    new_item = {**item, **{k: cand["spec"].get(k) for k in ("by", "name", "role", "exact")}}
    before = asset.code
    after = p4.apply_fix(before, p4.expression(item), p4.expression(new_item))  # one line, the locator only
    after = hd.retitle(before, after, str((cand.get("element") or {}).get("name") or "") or None)
    if guard.changed(before, after) or guard.assertion_set(before) != guard.assertion_set(after):
        raise Conflict("This suggestion would change what the test checks. Nothing was changed.")
    asset.code, asset.sha256, asset.version = after, emit.sha256(after), asset.version + 1
    asset.generated_by = ScriptGeneratedBy.heal
    item.update(new_item)
    bundle.output = {**output, "locators": specs}
    users = {lin for lin, rs in refs.items() if f"{sug.file}#{sug.getter}" in rs}
    to_check: list[AutomationScript] = []
    for row in (
        await s.execute(
            select(AutomationScript).where(
                AutomationScript.stage_run_id == bundle.id,
                AutomationScript.case_lineage_id.in_([uuid.UUID(x) for x in users]),
            )
        )
    ).scalars():
        if row.status == ScriptStatus.outdated:
            left = remove_clause(row.outdated_reason, str(sug.old_expression))
            if left is not None:  # another of its locators still waits for a repair
                row.outdated_reason = left
                continue
            row.outdated_reason = None
        row.status = ScriptStatus.draft
        to_check.append(row)
    now = utcnow()
    sug.status, sug.accepted_index, sug.new_asset_version = HealStatus.accepted, index, asset.version
    sug.decided_by, sug.decided_at = user.id, now
    replaced: list[str] = []
    for other in (
        await s.execute(
            select(HealSuggestion).where(
                HealSuggestion.project_id == project.id, HealSuggestion.status == HealStatus.open,
                HealSuggestion.kind == HealKind.locator, HealSuggestion.file == sug.file,
                HealSuggestion.getter == sug.getter, HealSuggestion.id != sug.id,
            )
        )
    ).scalars():  # fmt: skip
        other.status, other.decided_at = HealStatus.superseded, now
        other.reason = f"Another suggestion for this locator was accepted ({sug.key})"
        replaced.append(other.key)
    # The Phase 4 JSON on a failed result says it was accepted too (its own accept then answers 409).
    if sug.execution_result_id is not None:
        r = await s.get(ExecutionResult, sug.execution_result_id)
        if r is not None and r.heal_suggestions:
            first = dict(r.heal_suggestions[0])
            if first.get("accepted") is None:
                r.heal_suggestions = [{**first, "accepted": {"n": None, "by": str(user.id), "version": asset.version,
                                                              "heal": sug.key}}]  # fmt: skip
    await revisions.record(
        s, org_id=project.organisation_id, project_id=project.id, entity_type="automation_asset", entity_id=asset.id,
        lineage_id=asset.id, version=asset.version, snapshot={"path": asset.path, "code": asset.code},
        changes={"code": {"from": before, "to": asset.code}}, changed_by=user.id,
        change_reason=f"Repair suggestion {sug.key} accepted",
    )  # fmt: skip
    audit(s, org_id=project.organisation_id, action="automation_asset.healed", target_type="automation_asset",
          target_id=asset.id, actor_user_id=user.id, project_id=project.id,
          metadata={"path": asset.path, "version": asset.version, "suggestion": sug.key,
                    "from": sug.old_expression, "to": cand.get("expression")})  # fmt: skip
    return asset, to_check, replaced


async def reject(s: AsyncSession, project: Project, sug: HealSuggestion, reason: str | None, user: User) -> None:
    text = (reason or "").strip()
    if not text:
        raise ValidationFailed(REASON_NEEDED, details=[{"field": "reason", "message": REASON_NEEDED}])
    if sug.kind != HealKind.locator:
        raise Conflict("This review closes when the test case is edited and approved (Gate 5).")
    await _guard_open(s, sug)
    sug.status, sug.reason, sug.decided_by, sug.decided_at = HealStatus.rejected, text, user.id, utcnow()
    audit(s, org_id=project.organisation_id, action="heal_suggestion.rejected", target_type="heal_suggestion",
          target_id=sug.id, actor_user_id=user.id, project_id=project.id,
          metadata={"key": sug.key, "file": sug.file, "getter": sug.getter})  # fmt: skip


async def accept_p4(
    s: AsyncSession, project: Project, result: ExecutionResult, n: int, user: User
) -> tuple[AutomationAsset, list[str], list[AutomationScript]]:
    """The P4-08 endpoint. A result with Phase 4 JSON keeps the Phase 4 accept (and replaces the open repair rows for
    that locator); a result with only a repair row accepts option `n` of the row. Returns the asset, the keys of the
    scripts to check again, and (repair rows only) those scripts, so their checks can run."""
    from app.services import heal as p4

    if result.heal_suggestions:
        asset, keys = await p4.accept(s, project, result, n, user.id)
        sug = dict(result.heal_suggestions[0])
        for row in (
            await s.execute(
                select(HealSuggestion).where(
                    HealSuggestion.project_id == project.id, HealSuggestion.status == HealStatus.open,
                    HealSuggestion.kind == HealKind.locator, HealSuggestion.file == sug.get("asset_path"),
                    HealSuggestion.getter == sug.get("getter"),
                )
            )
        ).scalars():  # fmt: skip
            row.status, row.decided_at = HealStatus.superseded, utcnow()
            row.reason = f"Another suggestion for this locator was accepted ({result.key})"
        return asset, keys, []
    own = (
        await s.execute(
            select(HealSuggestion)
            .where(HealSuggestion.execution_result_id == result.id, HealSuggestion.kind == HealKind.locator)
            .order_by(HealSuggestion.created_at.desc())
        )
    ).scalars().first()  # fmt: skip
    if own is None:
        raise NotFound("No such fix suggestion")
    asset, scripts, _replaced = await accept(s, project, own, n, user)
    return asset, sorted(x.path.rsplit("/", 1)[-1].removesuffix(".spec.ts") for x in scripts), scripts


async def enqueue_checks(ctx: AppContext, project: Project, scripts: list[AutomationScript], key: str) -> bool:
    """Runs the G6 checks (static and the live locator check) on the repaired scripts. False when the toolkit isn't
    available on this server (the scripts stay "not checked")."""
    if not scripts or ctx.toolkit.problem() is not None:
        return False
    run_id = scripts[0].stage_run_id
    await ctx.queue.enqueue(
        "automation_validate",
        {"project_id": str(project.id), "stage_run_id": str(run_id), "script_ids": [str(x.id) for x in scripts]},
        org_id=project.organisation_id,
        project_id=project.id,
        dedupe_key=f"automation_validate:{run_id}:{key}",
    )
    return True


# ---------------------------------------------------------------- reading


async def _change_sets(s: AsyncSession, item_ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[ChangeSet, ChangeItem]]:
    if not item_ids:
        return {}
    rows = (
        await s.execute(
            select(ChangeItem, ChangeSet)
            .join(ChangeSet, ChangeSet.id == ChangeItem.change_set_id)
            .where(ChangeItem.id.in_(item_ids))
        )
    ).all()
    return {ci.id: (cs, ci) for ci, cs in rows}


async def list_rows(
    s: AsyncSession,
    project_id: uuid.UUID,
    *,
    status: str | None = None,
    change_set: uuid.UUID | None = None,
    source: str | None = None,
    result: uuid.UUID | None = None,
) -> list[HealSuggestion]:
    q = select(HealSuggestion).where(HealSuggestion.project_id == project_id)
    if status and status != "all":
        if status not in {x.value for x in HealStatus}:
            raise ValidationFailed("Unknown status", details=[{"field": "status", "message": "Unknown"}])
        q = q.where(HealSuggestion.status == HealStatus(status))
    if source:
        if source not in {x.value for x in HealSource}:
            raise ValidationFailed("Unknown source", details=[{"field": "source", "message": "Unknown"}])
        q = q.where(HealSuggestion.source == HealSource(source))
    if result is not None:
        q = q.where(HealSuggestion.execution_result_id == result)
    if change_set is not None:
        ids = select(ChangeItem.id).where(ChangeItem.change_set_id == change_set)
        q = q.where(HealSuggestion.change_item_id.in_(ids))
    return list((await s.execute(q.order_by(HealSuggestion.created_at, HealSuggestion.key))).scalars())


def context_line(r: HealSuggestion) -> str:
    """A suggestion in words for a failure analysis signal: "HEAL-0001 accepted: getByLabel('Message') →
    getByLabel('Your message')", "HEAL-0004 waiting: …", "HEAL-0005: The text changed …"."""
    cands, meta = split(r)
    if r.kind == HealKind.expected_result_review:
        return f"{r.key}: {str((meta.get('review') or {}).get('message') or 'review the test case')[:200]}"
    if r.status == HealStatus.accepted and r.accepted_index is not None and r.accepted_index < len(cands):
        return f"{r.key} accepted: {r.old_expression} → {cands[r.accepted_index].get('expression')}"
    if r.status == HealStatus.rejected:
        return f"{r.key} rejected: {r.old_expression} is still not found"
    return f"{r.key} waiting for a decision: {r.old_expression} not found"


def _check_failed(entry: dict[str, Any], first: str) -> bool:
    """Whether a failure message is this assertion-map entry's (the toolkit's wording, QA_ASSERTION: Expected …)."""
    args = [str(x) for x in entry.get("args") or []]
    kind = str(entry.get("kind") or "")
    if not args:
        return False
    if kind in ("field_flagged", "field_length"):
        label = next((x for x in reversed(args) if not x.isdigit() and x not in ("at most", "exactly")), "")
        return bool(label) and f"Expected {label} to " in first
    if kind == "control_enabled":
        return f"Expected the {args[-1]} control" in first
    return f"Expected the {args[0]} form" in first


def involved(rows: list[HealSuggestion], assertions: list[dict[str, Any]], error: str) -> list[HealSuggestion]:
    """The suggestions whose element the failed check itself goes through (its page-object locators, recorded in the
    assertion map), or whose reviewed text the failed check names. A repair elsewhere in the script isn't one."""
    first = (error or "").strip().splitlines()[0] if error else ""
    failed = [a for a in assertions if _check_failed(a, first)]
    through = {str(x) for a in failed for x in a.get("locators") or []}
    out = []
    for r in rows:
        if r.kind == HealKind.locator and f"{r.file}#{r.getter}" in through:
            out.append(r)
        elif r.kind == HealKind.expected_result_review:
            before = str((split(r)[1].get("review") or {}).get("before") or "")
            if before and before in first:
                out.append(r)
    return out


async def proven(s: AsyncSession, rows: list[HealSuggestion], lineage: uuid.UUID) -> set[uuid.UUID]:
    """The suggestions the case has passed with since (QA P6-04 R3): a passed result for the case (any script
    version) created after the suggestion was decided, or raised when still undecided. Until then a failure through
    the element reads as test maintenance; after it, as any other failure."""
    from app.db.models.automation import saved_at

    if not rows:
        return set()
    last = (
        await s.execute(
            select(func.max(saved_at())).where(
                ExecutionResult.case_lineage_id == lineage,
                ExecutionResult.status == ResultStatus.passed,
                # A pass recorded by hand says nothing about the script's locators.
                ExecutionResult.recorded_by.is_(None),
            )
        )
    ).scalar_one_or_none()
    return {r.id for r in rows if last is not None and last > (r.decided_at or r.created_at)}


async def changed_pages(s: AsyncSession, project_id: uuid.UUID) -> tuple[ChangeSet | None, set[str]]:
    """The latest rescan change set and the paths it changed (cosmetic changes left out)."""
    from app.domain.change import diff as d
    from app.domain.enums import ChangeSignificance

    cs = (
        await s.execute(
            select(ChangeSet)
            .where(ChangeSet.project_id == project_id, ChangeSet.status == ChangeSetStatus.completed,
                   ChangeSet.stage_run_id.is_not(None))
            .order_by(ChangeSet.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()  # fmt: skip
    if cs is None:
        return None, set()
    rows = (await s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars()
    return cs, {
        d.path_of(r.page_url).split("?", 1)[0]
        for r in rows
        if r.page_url and r.significance != ChangeSignificance.cosmetic
    }


async def related(s: AsyncSession, script: AutomationScript) -> list[HealSuggestion]:
    """The suggestions that concern a script now: open ones on its locators or its case, and those decided since the
    latest rescan's change set (QA P6-04: a failure right after a repair is read with that repair in mind)."""
    bundle = await s.get(StageRun, script.stage_run_id)
    _specs, _pages, refs = _bundle_maps(dict(bundle.output or {}) if bundle else {})
    mine = set(refs.get(str(script.case_lineage_id), []))
    since = (
        await s.execute(
            select(ChangeSet.created_at)
            .where(ChangeSet.project_id == script.project_id, ChangeSet.status == ChangeSetStatus.completed,
                   ChangeSet.stage_run_id.is_not(None))
            .order_by(ChangeSet.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()  # fmt: skip
    out: list[HealSuggestion] = []
    for r in await list_rows(s, script.project_id):
        ours = (r.kind == HealKind.locator and f"{r.file}#{r.getter}" in mine) or (
            r.kind == HealKind.expected_result_review and r.test_case_lineage_id == script.case_lineage_id
        )
        recent = r.status == HealStatus.open or (
            since is not None and r.decided_at is not None and r.decided_at >= since
        )
        if ours and recent and r.status != HealStatus.superseded:
            out.append(r)
    return out


async def views(
    ctx: AppContext, s: AsyncSession, rows: list[HealSuggestion], *, see_email: bool, can_decide: bool
) -> list[dict[str, Any]]:
    """The cards (design P6 §8.2): candidates with their signals and screenshots, where the suggestion came from,
    the scripts that use the locator, and after an accept how their checks went."""
    if not rows:
        return []
    project_id = rows[0].project_id
    sets = await _change_sets(s, [r.change_item_id for r in rows if r.change_item_id])
    results: dict[uuid.UUID, tuple[ExecutionResult, ExecutionRun | None]] = {}
    for r in rows:
        if r.execution_result_id and r.execution_result_id not in results:
            res = await s.get(ExecutionResult, r.execution_result_id)
            if res is not None:
                results[r.execution_result_id] = (res, await s.get(ExecutionRun, res.execution_run_id))
    bundle = await asvc.current_run(s, project_id, StageKey.automation)
    output = dict(bundle.output or {}) if bundle else {}
    _specs, pages, refs = _bundle_maps(output)
    scripts = (await asvc.bundle_rows(s, bundle.id))[0] if bundle else []
    by_lineage = {str(x.case_lineage_id): x for x in scripts}
    case_keys = await asvc._case_keys(s, [x.test_case_id for x in scripts])
    from app.services import testdesign as tds

    tdrun = await tds.current_run(s, project_id)
    cases = {str(c.lineage_id): c for c in await tds.cases_of(s, tdrun.id)} if tdrun else {}
    people = await out.users(s, [r.decided_by for r in rows])
    ev_ids = {uuid.UUID(str(c["evidence_id"])) for r in rows for c in split(r)[0] if c.get("evidence_id")}
    evidence = {
        e.id: e for e in (await s.execute(select(Evidence).where(Evidence.id.in_(ev_ids)))).scalars()
    } if ev_ids else {}  # fmt: skip
    from app.services import serialize as ser

    def script_ref(lin: str) -> dict[str, Any] | None:
        x = by_lineage.get(lin)
        c = cases.get(lin)
        if x is None and c is None:
            return None
        state = asvc.script_state(x) if x else None
        first = None
        if x is not None and state == "invalid":
            from app.agents.automation.validation import _first_problem

            first = _first_problem(x.validation or {})
        return {
            "case_key": (case_keys.get(x.test_case_id) if x else None) or (c.key if c else None),
            "test_case_id": str(c.id) if c else None,
            "case_title": c.title if c else None,
            "script_id": str(x.id) if x else None,
            "path": x.path if x else None,
            "state": state,
            "first_error": first,
            "outdated_reason": x.outdated_reason if x else None,
        }

    items: list[dict[str, Any]] = []
    for r in rows:
        cands, meta = split(r)
        cs_ci = sets.get(r.change_item_id) if r.change_item_id else None
        res_run = results.get(r.execution_result_id) if r.execution_result_id else None
        users = sorted(lin for lin, rs in refs.items() if f"{r.file}#{r.getter}" in rs) if r.file else []
        if r.kind == HealKind.expected_result_review and r.test_case_lineage_id:
            users = [str(r.test_case_lineage_id)]
        used = [x for x in (script_ref(lin) for lin in users) if x]
        page = meta.get("page") or (pages.get(str(r.file)) if r.file else None)
        shown: list[dict[str, Any]] = []
        for i, c in enumerate(cands):
            ev = evidence.get(uuid.UUID(str(c["evidence_id"]))) if c.get("evidence_id") else None
            shown.append({
                "index": i, **{k: c.get(k) for k in ("expression", "strategy", "score", "level", "signals",
                                                     "match_count", "offered", "not_offered_reason", "rule_rank",
                                                     "element", "checked_at")},
                "evidence": ser.evidence_link(ctx, ev).model_dump(mode="json") if ev else None,
            })  # fmt: skip
        who = people.get(r.decided_by) if r.decided_by else None
        is_open = r.status == HealStatus.open
        review = meta.get("review") if r.kind == HealKind.expected_result_review else None
        rule_order = [
            c["expression"] for c in sorted(shown, key=lambda c: int(c.get("rule_rank") or 0)) if c["offered"]
        ]
        checking = None
        if r.status == HealStatus.accepted:
            states = [u["state"] for u in used]
            checking = {
                "state": "checking" if any(st == "not_checked" for st in states) else
                "valid" if states and all(st in ("valid", "needs_review") for st in states) else
                "outdated" if any(st == "outdated" for st in states) else "invalid" if states else "valid",
                "scripts": used,
            }  # fmt: skip
        items.append({
            "id": str(r.id),
            "key": r.key,
            "kind": r.kind.value,
            "source": r.source.value,
            "status": r.status.value,
            "file": r.file,
            "file_name": (r.file or "").rsplit("/", 1)[-1] or None,
            "getter": r.getter,
            "element": meta.get("element") or None,
            "page": page,
            "old_expression": r.old_expression,
            "candidates": shown,
            "offered": sum(1 for c in shown if c["offered"]),
            "no_candidate_reason": None if r.kind != HealKind.locator or any(c["offered"] for c in shown) else (
                f"The page couldn't be checked: {meta['unchecked_reason']}." if meta.get("unchecked_reason")
                else NO_CANDIDATE.format(page=page or "the page")
            ),
            "checked_at": meta.get("checked_at"),
            "change_set": {"id": str(cs_ci[0].id), "key": cs_ci[0].key} if cs_ci else None,
            "execution_result": {"id": str(res_run[0].id), "key": res_run[0].key,
                                 "run_key": res_run[1].key if res_run[1] else None,
                                 "run_id": str(res_run[1].id) if res_run[1] else None} if res_run else None,
            "used_by": used,
            "review": review,
            "asset_version": r.asset_version,
            "new_asset_version": r.new_asset_version,
            "accepted_index": r.accepted_index,
            "decided_by": out.person(who, see_email=see_email) if who else None,
            "decided_at": r.decided_at.isoformat() if r.decided_at else None,
            "reason": r.reason,
            "generated_by": r.generated_by.value,
            "order": "ai" if r.generated_by == GeneratedBy.ai else "rules",
            "explanation": next((c.get("ai_explanation") for c in cands if c.get("ai_explanation")), None),
            "rule_order": rule_order,
            "checking": checking,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "can_accept": can_decide and is_open and r.kind == HealKind.locator and any(c["offered"] for c in shown),
            "can_reject": can_decide and is_open and r.kind == HealKind.locator,
        })  # fmt: skip
    return items


def counts(rows: list[HealSuggestion]) -> dict[str, int]:
    return {
        "open": sum(1 for r in rows if r.status == HealStatus.open),
        "open_locator": sum(1 for r in rows if r.status == HealStatus.open and r.kind == HealKind.locator),
        **{st.value: sum(1 for r in rows if r.status == st) for st in HealStatus if st != HealStatus.open},
        "total": len(rows),
    }
