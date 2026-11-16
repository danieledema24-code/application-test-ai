"""Script validation (P4-04): six checks per script, stored in `automation_scripts.validation`.

1. `guard` (spec-guard), 2. `tsc`, 3. `eslint` (the toolkit, offline, in a throwaway workspace),
4. `secret_scan` (the saved username and password, token patterns, literals typed into password fields),
5. `tags` (title, tag and file name agree, and the case is in the G5 snapshot at the script's case version),
6. `locators` (live and read-only: every locator a script uses is counted on its page; no click, fill or submit
   apart from signing in with the saved test account when a page needs it).

A script is `valid` when checks 1–5 pass and none of its locators is missing or found more than once; a locator
that couldn't be checked (sign-in needed, no credentials saved) is a warning, not a blocker. Messages name lines,
never values.
"""

from __future__ import annotations

import contextlib
import logging
import re
import shutil
import uuid
from typing import Any
from urllib.parse import urljoin

from sqlalchemy import select

from app.automation.toolkit import ToolkitError
from app.context import AppContext
from app.db.models import AutomationScript, Project, ProjectUrl, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.db.types import utcnow
from app.domain.automation import secret_scan
from app.domain.enums import ScriptStatus, UrlRole
from app.services import automation as svc
from app.services import testdesign as tds

log = logging.getLogger(__name__)
PAGE_TIMEOUT_MS = 20_000


def _check(ok: bool, messages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"ok": ok, "messages": messages or []}


def _line_of(code: str, needle: str) -> int | None:
    for n, line in enumerate(code.splitlines(), start=1):
        if needle in line:
            return n
    return None


async def validate_bundle(
    ctx: AppContext,
    scope: TenantScope,
    project_id: uuid.UUID,
    run_id: uuid.UUID,
    *,
    only_draft: bool = False,
    only_scripts: set[uuid.UUID] | None = None,
) -> tuple[dict[str, Any], str]:
    """Validates a bundle and returns (the bundle run's new output, a one-line summary for the activity feed)."""
    from app.services.secrets import credentials_secret, use_credentials

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
        project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
        scripts, assets = await svc.bundle_rows(s, run.id)
        decision = await svc.last_g5(s, project_id)
        approved = {
            (str(i["id"]), int(i["version"])) for i in tds.snapshot_items(decision, "test_case")
        }  # (case row id, version)
        case_rows = await svc._case_keys(s, [x.test_case_id for x in scripts])
        secret = await credentials_secret(s, project_id)
        creds: dict[str, str] | None = None
        if secret is not None:
            creds = await use_credentials(ctx, s, secret, purpose="script_validation", task_id=None)
        url = (
            await s.execute(
                select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
            )
        ).scalar_one_or_none()
        await s.commit()
        targets = [
            x
            for x in scripts
            if x.status != ScriptStatus.outdated
            and (not only_draft or x.status == ScriptStatus.draft)
            and (only_scripts is None or x.id in only_scripts)
        ]
        output = dict(run.output or {})
        generated = {a.path: a.code for a in assets if a.generated_by.value != "platform"}
        files = {**generated, **{x.path: x.code for x in scripts if x.status != ScriptStatus.outdated}}

    # 1–3 and the toolkit's tag check, in a throwaway workspace (never inside the bundle tables).
    toolkit_problem = ctx.toolkit.problem()
    report: dict[str, Any] = {}
    if toolkit_problem is None and targets:
        ws = svc.workspace(ctx, f"validate-{run_id.hex[:12]}-{uuid.uuid4().hex[:8]}")
        try:
            await ctx.toolkit.init(ws)
            svc.write_bundle(ws, files)
            report = await ctx.toolkit.validate(ws)
        except (ToolkitError, OSError, ValueError) as exc:
            toolkit_problem = f"The testing toolkit couldn't check the scripts: {str(exc).splitlines()[0][:200]}"
        finally:
            shutil.rmtree(ws, ignore_errors=True)
    file_reports: dict[str, Any] = dict(report.get("files") or {})
    # Never "not checked" without a reason (QA P4-BUG-04).
    no_result = "The testing toolkit returned no result for this script; validate again"

    # 6. Live locator check: pages used by the scripts being validated.
    specs: dict[str, list[dict[str, Any]]] = dict(output.get("locators") or {})
    pages: dict[str, str] = dict(output.get("pages") or {})
    script_locators: dict[str, list[str]] = dict(output.get("script_locators") or {})
    wanted_pages = sorted(
        {ref.split("#", 1)[0] for x in targets for ref in script_locators.get(str(x.case_lineage_id), [])}
    )
    page_results: dict[str, dict[str, Any]] = {}
    if wanted_pages and url is not None:
        page_results = await _verify_locators(ctx, scope, project, url,
                                              {p: pages[p] for p in wanted_pages if p in pages}, specs, creds)  # fmt: skip
    creds_username = creds.get("username") if creds else None
    creds_password = creds.get("password") if creds else None
    del creds

    asset_checks: dict[str, dict[str, Any]] = {}
    for path, code in generated.items():
        rep = file_reports.get(path) or {}
        asset_checks[path] = {
            "guard": rep.get("guard"),
            "tsc": rep.get("tsc"),
            "eslint": rep.get("eslint"),
            "secret_scan": secret_scan.scan(code, username=creds_username, password=creds_password),
        }

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
        project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
        rows = {
            x.id: x
            for x in (
                await s.execute(select(AutomationScript).where(AutomationScript.stage_run_id == run_id))
            ).scalars()
        }
        for t in targets:
            row = rows.get(t.id)
            if row is None:
                continue
            validation: dict[str, Any] = {}
            rep = file_reports.get(row.path)
            if toolkit_problem is not None or rep is None:
                msg = toolkit_problem or no_result
                for name in ("guard", "tsc", "eslint"):
                    validation[name] = {"ok": False, "messages": [{"line": None, "message": msg}], "not_checked": True}
            else:
                for name in ("guard", "tsc", "eslint"):
                    validation[name] = _check(bool(rep[name]["ok"]), list(rep[name].get("messages") or []))
            # Problems in the page objects or data file a script imports are problems of the script too.
            for imported in re.findall(r'from "\.\./\.\./((?:pages|data)/[A-Za-z0-9-]+)"', row.code):
                checks = asset_checks.get(f"{imported}.ts") or {}
                for name in ("guard", "tsc", "eslint", "secret_scan"):
                    c = checks.get(name)
                    if c is not None and not c.get("ok"):
                        first = (c.get("messages") or [{"message": "failed"}])[0]
                        validation.setdefault(name, _check(True))
                        validation[name] = _check(
                            False,
                            [*validation[name]["messages"],
                             {"line": None, "message": f"{imported}.ts: {first.get('message')}"}],
                        )  # fmt: skip
            scan = secret_scan.scan(row.code, username=creds_username, password=creds_password)
            if not (validation.get("secret_scan") or {"ok": True})["ok"]:
                scan = _check(False, scan["messages"] + validation["secret_scan"]["messages"])
            validation["secret_scan"] = scan
            tags = dict((rep or {}).get("tags") or {"ok": True, "messages": []})
            tag_msgs = list(tags.get("messages") or [])
            if (str(row.test_case_id), row.case_version) not in approved:
                key = case_rows.get(row.test_case_id, "This test case")
                tag_msgs.append(
                    {"line": 1, "message": f"{key} version {row.case_version} is not the version approved at Gate 5"}
                )
            validation["tags"] = _check(bool(tags.get("ok", True)) and not tag_msgs, tag_msgs)
            validation["locators"] = _locator_check(row, script_locators.get(str(row.case_lineage_id), []), specs,
                                                    pages, page_results)  # fmt: skip
            row.validation = validation
            static_ok = all(validation[c]["ok"] for c in ("guard", "tsc", "eslint", "secret_scan", "tags"))
            if toolkit_problem is not None or rep is None:
                row.status = ScriptStatus.draft
            else:
                row.status = ScriptStatus.valid if static_ok and validation["locators"]["ok"] else ScriptStatus.invalid
        # Locator table for the page objects (design P4 §6.3).
        for file, items in specs.items():
            res = page_results.get(file)
            for item in items:
                if res is None:
                    continue
                item["status"], item["count"] = res["locators"].get(item["getter"], ("not_checked", None))
                if res.get("reason"):
                    item["reason"] = res["reason"]
        statuses = [r for r in rows.values() if r.status != ScriptStatus.outdated]
        counts = {
            "valid": sum(1 for r in statuses if r.status == ScriptStatus.valid),
            "invalid": sum(1 for r in statuses if r.status == ScriptStatus.invalid),
            "not_checked": sum(1 for r in statuses if r.status == ScriptStatus.draft),
            "locators_not_checked": sum(
                1
                for r in statuses
                if r.status == ScriptStatus.valid
                and any(m.get("not_checked") for m in ((r.validation or {}).get("locators") or {}).get("messages", []))
            ),
            "outdated": sum(1 for r in rows.values() if r.status == ScriptStatus.outdated),
        }
        issues = [
            f"{case_rows.get(r.test_case_id, r.path)}: {_first_problem(r.validation or {})}"
            for r in statuses
            if r.status == ScriptStatus.invalid
        ]
        output = dict(run.output or {})
        output["locators"] = specs
        output["validation"] = {
            "status": "done",
            "checked_at": utcnow().isoformat(),
            "counts": counts,
            "toolkit": toolkit_problem or (no_result if any(x.path not in file_reports for x in targets) else None),
            "assets": asset_checks,
            "issues": issues,
        }
        run.output = output
        await s.flush()
        # P6-02: a repair item closes when its script is valid again.
        from app.services.impact import resolve_heals

        await resolve_heals(s, project_id)
        await s.commit()
    first_invalid = f" ({issues[0].split(': ', 1)[-1]})" if issues else ""
    unchecked = counts["not_checked"] + counts["locators_not_checked"]
    reason = output["validation"]["toolkit"]
    why = f" ({reason})" if reason and counts["not_checked"] else ""
    summary = (
        f"Validation: {counts['valid']} valid · {counts['invalid']} invalid{first_invalid} · {unchecked} not checked"
        f"{why}"
    )
    return output, summary


def _first_problem(validation: dict[str, Any]) -> str:
    for name in ("guard", "tsc", "eslint", "secret_scan", "tags", "locators"):
        c = validation.get(name) or {}
        if not c.get("ok", True):
            msgs = [m for m in c.get("messages") or [] if not m.get("not_checked")]
            if msgs:
                return re.sub(r"^Line \d+: ", "", str(msgs[0].get("message")))
    return "failed its checks"


def _locator_check(
    row: AutomationScript,
    refs: list[str],
    specs: dict[str, list[dict[str, Any]]],
    pages: dict[str, str],
    results: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = []
    ok = True
    for ref in refs:
        file, getter = ref.split("#", 1)
        item = next((i for i in specs.get(file, []) if i.get("getter") == getter), None)
        if item is None:
            continue
        res = results.get(file)
        path = pages.get(file, "the page")
        name = item.get("element") or getter
        line = _line_of(row.code, f".{getter}") or _line_of(row.code, f'"{name}"')
        prefix = f"Line {line}: " if line else ""
        if res is None:
            messages.append({"line": line, "message": f"{prefix}Locator '{name}' was not checked on {path}",
                             "not_checked": True})  # fmt: skip
            continue
        status, count = res["locators"].get(getter, ("not_checked", None))
        if status == "missing":
            ok = False
            messages.append({"line": line, "message": f"{prefix}Locator '{name}' was not found on {path}"})
        elif status == "multiple":
            ok = False
            messages.append({"line": line, "message": f"{prefix}Locator '{name}' was found {count} times on {path}"})
        elif status == "not_checked":
            why = res.get("reason") or "needs sign-in and no test credentials are saved"
            messages.append({"line": line, "message": f"{prefix}Locator '{name}' was not checked on {path} ({why})",
                             "not_checked": True})  # fmt: skip
    return {"ok": ok, "messages": messages}


async def _verify_locators(
    ctx: AppContext,
    scope: TenantScope,
    project: Project,
    url: ProjectUrl,
    pages: dict[str, str],
    specs: dict[str, list[dict[str, Any]]],
    creds: dict[str, str] | None,
    *,
    also_exact: bool = False,
) -> dict[str, dict[str, Any]]:
    """Counts each locator on its page in an isolated session under the network policy. Read-only: only page loads
    (GET), plus the one sign-in when a page needs it and credentials are saved. With `also_exact` (P6-02's re-check
    after a change), each locator is also counted with exact name matching, under `exact`."""
    from playwright.async_api import Error, Page

    from app.agents.discovery.signin import sign_in
    from app.browser.network_policy import NetworkPolicy
    from app.security.ssrf import normalise_url

    start = normalise_url((url.last_check or {}).get("final_url") or url.url)
    base = start.origin
    hosts = list(url.allowed_hosts or []) or [start.host]
    origins = {start.origin}
    login_url = (creds or {}).get("login_url")
    if login_url:
        with contextlib.suppress(Exception):
            origins.add(normalise_url(login_url).origin)
    policy = NetworkPolicy(
        approved_origins=origins,
        allowed_hosts=hosts,
        allow_private_targets=ctx.settings.allow_private_targets,
        resolver=ctx.resolver,
        fetch_timeout_ms=PAGE_TIMEOUT_MS,
    )
    needs_auth = await _auth_paths(ctx, scope, project.id, set(pages.values()))
    out: dict[str, dict[str, Any]] = {}
    try:
        async with ctx.browser_pool.isolated_context(policy) as context:
            signed_in = False
            if needs_auth and creds and login_url:
                outcome = await sign_in(context, policy, login_url, creds["username"], creds["password"])
                signed_in = outcome.result == "succeeded"
            for file, path in sorted(pages.items()):
                items = specs.get(file, [])
                if path in needs_auth and not signed_in:
                    reason = (
                        "needs sign-in and no test credentials are saved"
                        if not creds
                        else "signing in with the saved test account didn't work"
                    )
                    out[file] = {"reason": reason, "locators": {i["getter"]: ("not_checked", None) for i in items}}
                    continue
                page: Page = await context.new_page()
                page.set_default_timeout(PAGE_TIMEOUT_MS)
                try:
                    target = urljoin(base + "/", path.lstrip("/"))
                    for _ in range(3):
                        try:
                            await page.goto(target, wait_until="domcontentloaded")
                            break
                        except Error:
                            nxt = policy.nav_redirects.pop(target, None)
                            if nxt is None:
                                raise
                            target = nxt
                    with contextlib.suppress(Error):
                        await page.wait_for_load_state("load", timeout=5_000)
                    counts: dict[str, tuple[str, int | None]] = {}
                    exact: dict[str, int] = {}
                    for item in items:
                        try:
                            n = await _locate(page, item).count()
                        except Error:
                            n = 0
                        counts[item["getter"]] = (
                            ("unique", 1) if n == 1 else ("missing", 0) if n == 0 else ("multiple", n)
                        )
                        if also_exact:
                            try:
                                exact[item["getter"]] = await _locate(page, item, exact=True).count()
                            except Error:
                                exact[item["getter"]] = 0
                    out[file] = {"locators": counts, **({"exact": exact} if also_exact else {})}
                except Error:
                    out[file] = {
                        "reason": "the page couldn't be opened",
                        "locators": {i["getter"]: ("not_checked", None) for i in items},
                    }
                finally:
                    with contextlib.suppress(Error):
                        await page.close()
    except Exception:  # noqa: BLE001 - no browser: every locator is reported as not checked
        log.warning("locator verification could not start the browser")
        for file in pages:
            out.setdefault(
                file,
                {"reason": "the browser couldn't start", "locators": {i["getter"]: ("not_checked", None)
                                                                       for i in specs.get(file, [])}},
            )  # fmt: skip
    return out


async def _auth_paths(ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, paths: set[str]) -> set[str]:
    """Paths among `paths` that discovery found behind sign-in."""
    from app.agents.phase2 import load_discovery

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        loaded = await load_discovery(s, project_id, include_documents=False)
    if loaded is None:
        return set()
    data, _run, _scan = loaded
    return {svc.same_site_path(p.url) for p in data.pages if p.requires_auth and svc.same_site_path(p.url) in paths}


def _locate(page: Any, item: dict[str, Any], *, exact: bool = False) -> Any:
    """The locator as the page object writes it; `exact` matches the whole name (P6-02 re-check)."""
    by, name = item.get("by"), str(item.get("name") or "")
    if by == "label":
        return page.get_by_label(name, exact=True) if exact else page.get_by_label(name)
    if by == "placeholder":
        return page.get_by_placeholder(name, exact=True) if exact else page.get_by_placeholder(name)
    if by in ("role", "form_role"):
        role = "form" if by == "form_role" else str(item.get("role") or "button")
        scope = page.get_by_role("navigation") if item.get("within") == "navigation" else page
        return scope.get_by_role(role, name=name, exact=(exact or bool(item.get("exact"))) or None)
    if by == "form_button":
        return page.locator("form").filter(has=page.get_by_role("button", name=name, exact=exact or None))
    return page.locator(str(item.get("css") or "body"))


verify_locators = _verify_locators  # P6-02: the change set's read-only re-check of script locators
