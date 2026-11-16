"""Fix suggestions for "Element not found" failures (P4-08, design P4 §9.3).

When a script fails because a locator found nothing, the live page is opened read-only (page load only: no click,
type or submit) and the page object's missing locator is compared with what the page offers now: labelled fields
for `getByLabel`, buttons and links for `getByRole`. Candidates that are found exactly once are offered. Accepting
one changes **only** that locator expression in the page object (a new version of the asset); spec files and their
assertions are never touched, so expected results stay the same. Scripts using the page object must pass their
checks again before they run.
"""

from __future__ import annotations

import contextlib
import difflib
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import Conflict, NotFound
from app.context import AppContext
from app.db.models import AutomationAsset, AutomationScript, ExecutionResult, Project, ProjectUrl, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.domain.automation import emit
from app.domain.enums import ScriptGeneratedBy, ScriptStatus, UrlRole

log = logging.getLogger(__name__)
PAGE_TIMEOUT_MS = 10_000
_ARG = r"""(?P<q{n}>['"])(?P<v{n}>(?:\\.|(?!(?P=q{n})).)*)(?P=q{n})"""


@dataclass
class Missing:
    by: str  # label | placeholder | role
    name: str
    role: str = ""


def parse_locator(text: str) -> Missing | None:
    """`getByLabel('Message')`, `getByPlaceholder("x")`, `getByRole('button', { name: 'Send' })` → what was missing."""
    m = re.search(r"getBy(Label|Placeholder)\(" + _ARG.format(n=1), text)
    if m:
        return Missing(m.group(1).lower(), m.group("v1"))
    m = re.search(r"getByRole\(" + _ARG.format(n=1) + r"\s*,\s*\{\s*name:\s*" + _ARG.format(n=2), text)
    if m:
        return Missing("role", m.group("v2"), m.group("v1"))
    return None


def find_spec(output: dict[str, Any], lineage: str, missing: Missing) -> tuple[str, dict[str, Any]] | None:
    """The page-object file and locator spec of this script that the missing locator came from."""
    specs: dict[str, list[dict[str, Any]]] = output.get("locators") or {}
    for ref in (output.get("script_locators") or {}).get(lineage, []):
        file, _, getter = str(ref).partition("#")
        for item in specs.get(file, []):
            if item.get("getter") != getter or item.get("name") != missing.name:
                continue
            by = item.get("by")
            if (missing.by == by) or (missing.by == "role" and by in ("role", "form_button")):
                return file, item
    return None


def _locator(item: dict[str, Any]) -> emit.Locator:
    return emit.Locator(
        str(item.get("getter") or "x"),
        str(item.get("element") or ""),
        str(item.get("by") or "label"),
        name=str(item.get("name") or ""),
        role=str(item.get("role") or ""),
        exact=bool(item.get("exact")),
        within=str(item.get("within") or ""),
        css=str(item.get("css") or ""),
    )


def expression(item: dict[str, Any]) -> str:
    return _locator(item).ts()


def rank(missing: str, offered: list[tuple[str, str]], taken: set[str], tag: str | None) -> list[str]:
    """Names on the page now, most likely replacement first: similar wording, same kind of control, not already used
    by another locator of the page object."""
    scored: list[tuple[float, str]] = []
    for name, kind in offered:
        name = " ".join(name.split())
        if not name or name in taken or name == missing:
            continue
        score = difflib.SequenceMatcher(None, missing.lower(), name.lower()).ratio()
        if set(missing.lower().split()) & set(name.lower().split()):
            score += 0.5
        if tag and kind == tag:
            score += 0.3
        scored.append((score, name))
    seen: list[str] = []
    for _s, n in sorted(scored, key=lambda x: (-x[0], x[1])):
        if n not in seen:
            seen.append(n)
    return seen[:3]


def candidates_for(item: dict[str, Any], names: list[str], role_for_field: str | None) -> list[dict[str, Any]]:
    """Alternative locator specs: the same strategy with the new name first, then a role-based one for fields."""
    out: list[dict[str, Any]] = []
    for n in names:
        same = {**item, "name": n}
        out.append(same)
        if item.get("by") == "label" and role_for_field:
            out.append({**item, "by": "role", "role": role_for_field, "name": n, "exact": False})
    return out


def apply_fix(code: str, old: str, new: str) -> str:
    """Replaces the one locator expression; anything else changing is refused. An expression that also appears inside
    another getter (a button inside "the form that has this button") is matched as its getter's `return …;` line."""
    if code.count(old) != 1 and code.count(f"return {old};") == 1:
        old, new = f"return {old};", f"return {new};"
    if code.count(old) != 1:
        raise Conflict("The page object changed since this suggestion. Validate the scripts again.")
    out = code.replace(old, new)
    before, after = code.splitlines(), out.splitlines()
    if len(before) != len(after):
        raise Conflict("This suggestion would change more than the locator.")
    changed = [i for i, (a, b) in enumerate(zip(before, after, strict=True)) if a != b]
    if len(changed) != 1 or old not in before[changed[0]]:
        raise Conflict("This suggestion would change more than the locator.")
    return out


_COLLECT = """(kind) => {
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  if (kind === 'label') {
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden') continue;
      const lab = (el.labels && el.labels[0]) ? clean(el.labels[0].innerText) : clean(el.getAttribute('aria-label'));
      if (lab) out.push([lab, el.tagName.toLowerCase()]);
    }
  } else if (kind === 'placeholder') {
    for (const el of document.querySelectorAll('[placeholder]')) out.push([clean(el.getAttribute('placeholder')), el.tagName.toLowerCase()]);
  } else {
    for (const el of document.querySelectorAll('button, input[type=submit], a[href], [role=button]')) {
      const n = clean(el.getAttribute('aria-label') || el.innerText || el.value);
      if (n) out.push([n, el.tagName.toLowerCase() === 'a' ? 'link' : 'button']);
    }
  }
  return out;
}"""


_WHAT = {"label": "field's label", "placeholder": "field's placeholder", "button": "button's name"}


async def suggest(
    ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, result: ExecutionResult, error: str
) -> list[dict[str, Any]]:
    """Fix suggestions for one "Element not found" result (at most one; empty when nothing safe was found)."""
    missing = parse_locator(error)
    if missing is None:
        return []
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        script = await s.get(AutomationScript, result.automation_script_id) if result.automation_script_id else None
        if script is None:
            return []
        bundle = await s.get(StageRun, script.stage_run_id)
        url = (
            await s.execute(
                select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
            )
        ).scalar_one_or_none()
        output = dict(bundle.output or {}) if bundle else {}
    found = find_spec(output, str(script.case_lineage_id), missing)
    path = (output.get("pages") or {}).get(found[0]) if found else None
    if found is None or url is None or not path:
        return []
    file, item = found
    taken = {str(x.get("name")) for x in (output.get("locators") or {}).get(file, [])}
    kind = "label" if item.get("by") == "label" else "placeholder" if item.get("by") == "placeholder" else "button"
    long_text = re.search(r"message|comment|description|details|notes|enquiry", missing.name, re.I)
    tag = "textarea" if kind == "label" and long_text else None
    try:
        verified = await _verify(ctx, url, path, item, kind, missing.name, taken, tag)
    except Exception:  # noqa: BLE001 - no browser or page: no suggestion, the analysis stands
        log.warning("fix suggestion: the page couldn't be checked")
        return []
    if not verified:
        return []
    old = expression(item)
    options = []
    for i, cand in enumerate(verified):
        new = expression(cand)
        options.append(
            {
                "by": cand["by"],
                "name": cand["name"],
                "role": cand.get("role") or "",
                "expression": new.replace("this.page.", ""),
                "status": "unique",
                "recommended": i == 0,
                "diff": {"old": old, "new": new},
                "spec": cand,
            }
        )
    element = str(item.get("element") or missing.name)
    return [
        {
            "asset_path": file,
            "getter": item.get("getter"),
            "element": element,
            "page_path": path,
            "old_expression": old.replace("this.page.", ""),
            "reason": f"The {missing.name} {_WHAT[kind]} changed. These locators find it on {path} today:",
            "candidates": options,
            "note": "Changes how the test finds the field, not what it checks. Expected results stay the same.",
            "accepted": None,
        }
    ]


async def _verify(
    ctx: AppContext,
    url: ProjectUrl,
    path: str,
    item: dict[str, Any],
    kind: str,
    missing: str,
    taken: set[str],
    tag: str | None,
) -> list[dict[str, Any]]:
    from playwright.async_api import Error

    from app.agents.automation.validation import _locate
    from app.browser.network_policy import NetworkPolicy
    from app.security.ssrf import normalise_url

    start = normalise_url((url.last_check or {}).get("final_url") or url.url)
    policy = NetworkPolicy(
        approved_origins={start.origin},
        allowed_hosts=list(url.allowed_hosts or []) or [start.host],
        allow_private_targets=ctx.settings.allow_private_targets,
        resolver=ctx.resolver,
        fetch_timeout_ms=PAGE_TIMEOUT_MS,
    )
    out: list[dict[str, Any]] = []
    async with ctx.browser_pool.isolated_context(policy) as context:
        page = await context.new_page()
        page.set_default_timeout(PAGE_TIMEOUT_MS)
        try:
            await page.goto(urljoin(start.origin + "/", path.lstrip("/")), wait_until="domcontentloaded")
            with contextlib.suppress(Error):
                await page.wait_for_load_state("load", timeout=5_000)
            offered = [(str(n), str(t)) for n, t in await page.evaluate(_COLLECT, kind)]
            names = rank(missing, offered, taken, tag)
            field_role = None
            if kind == "label":
                field_role = "textbox"
            for cand in candidates_for(item, names, field_role):
                try:
                    n = await _locate(page, cand).count()
                except Error:
                    n = 0
                if n == 1:
                    out.append(cand)
                if len(out) >= 2:
                    break
        finally:
            with contextlib.suppress(Error):
                await page.close()
    return out


async def accept(
    s: AsyncSession, project: Project, result: ExecutionResult, n: int, user_id: uuid.UUID
) -> tuple[AutomationAsset, list[str]]:
    """Creates the next version of the page object with only the chosen locator changed. Returns the asset and the
    keys of the scripts that must pass their checks again."""
    from app.services import revisions
    from app.services.audit import audit

    sug = (result.heal_suggestions or [None])[0]
    if not sug or n < 0 or n >= len(sug.get("candidates") or []):
        raise NotFound("No such fix suggestion")
    if sug.get("accepted") is not None:
        raise Conflict("This fix suggestion was already accepted")
    cand = sug["candidates"][n]
    script = await s.get(AutomationScript, result.automation_script_id) if result.automation_script_id else None
    if script is None:
        raise Conflict("The script of this result no longer exists")
    asset = (
        await s.execute(
            select(AutomationAsset).where(
                AutomationAsset.stage_run_id == script.stage_run_id, AutomationAsset.path == sug["asset_path"]
            )
        )
    ).scalar_one_or_none()
    if asset is None:
        raise Conflict("The page object of this suggestion no longer exists")
    before = asset.code
    asset.code = apply_fix(asset.code, cand["diff"]["old"], cand["diff"]["new"])
    asset.sha256 = emit.sha256(asset.code)
    asset.version += 1
    asset.generated_by = ScriptGeneratedBy.heal
    bundle = await s.get(StageRun, script.stage_run_id)
    output = dict(bundle.output or {}) if bundle else {}
    specs = {k: [dict(x) for x in v] for k, v in (output.get("locators") or {}).items()}
    for x in specs.get(sug["asset_path"], []):
        if x.get("getter") == sug.get("getter"):
            x.update({k: cand["spec"].get(k) for k in ("by", "name", "role", "exact")})
    users = [
        lin
        for lin, refs in (output.get("script_locators") or {}).items()
        if f"{sug['asset_path']}#{sug.get('getter')}" in refs
    ]
    if bundle is not None:
        bundle.output = {**output, "locators": specs}
    keys: list[str] = []
    for row in (
        await s.execute(
            select(AutomationScript).where(
                AutomationScript.stage_run_id == script.stage_run_id,
                AutomationScript.case_lineage_id.in_([uuid.UUID(x) for x in users] or [script.case_lineage_id]),
            )
        )
    ).scalars():
        if row.status != ScriptStatus.outdated:
            row.status = ScriptStatus.draft
            keys.append(row.path.rsplit("/", 1)[-1].removesuffix(".spec.ts"))
    result.heal_suggestions = [{**sug, "accepted": {"n": n, "by": str(user_id), "version": asset.version}}]
    await revisions.record(
        s,
        org_id=project.organisation_id,
        project_id=project.id,
        entity_type="automation_asset",
        entity_id=asset.id,
        lineage_id=asset.id,
        version=asset.version,
        snapshot={"path": asset.path, "code": asset.code},
        changes={"code": {"from": before, "to": asset.code}},
        changed_by=user_id,
        change_reason=f"Fix suggestion from {result.key}",
    )
    audit(
        s,
        org_id=project.organisation_id,
        action="automation_asset.healed",
        target_type="automation_asset",
        target_id=asset.id,
        actor_user_id=user_id,
        project_id=project.id,
        metadata={"path": asset.path, "version": asset.version, "result": result.key},
    )
    return asset, sorted(keys)
