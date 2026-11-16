"""Test Automation Engineer Agent, AI path (P4-03b).

With AI configured, the model may (a) restructure a rule-written spec and (b) write a spec for a `manual_only` case
whose only blockers are steps the rules couldn't resolve (never judgement, CAPTCHA, MFA, open questions or a missing
expected result). Nothing it writes is trusted:

1. Pydantic (`extra="forbid"`) on the output.
2. The offline static checks a bundle gets (spec-guard, tsc, eslint, test case tag, secret scan) plus "no focused or
   skipped tests". On failure, up to `MAX_REPAIRS` repair calls carry the check messages; still failing → the rule
   script is kept (or the case stays manual) and `fallback_used` is recorded.
3. The expected-value guard (`domain/automation/expected_guard.py`): `assertion_changed` / `assertion_unmapped`
   drop the AI version without a repair (what a test checks is not the model's to change).

Page names, labels and locator candidates come from the target site and reach the prompt only inside untrusted
blocks. AI-written scripts are stored as `generated_by="ai"` and always need a G6 review (decision D10).
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.automation.toolkit import ToolkitError
from app.context import AppContext
from app.domain.automation import expected_guard as eg
from app.domain.automation import secret_scan
from app.domain.automation import steps as sm
from app.llm.base import Budget, LLMUsage, UntrustedBlock
from app.services import automation as svc

log = logging.getLogger(__name__)

MAX_REPAIRS = 3
# Blockers the model may work around: a step the rules couldn't resolve against the discovered site.
AI_FIXABLE = frozenset({"unresolved_control", "unresolved_field", "unresolved_form", "unknown_page"})
FOCUSED = re.compile(r"\b(?:test|describe)\s*\.\s*(?:only|skip|fixme)\b|\.only\s*\(")

TASK_REWRITE = """Rewrite this Playwright spec for test case {key} to improve its structure (step grouping, page object
use) WITHOUT changing what it checks: keep every assertion call exactly as it is, with the same arguments.
Rules: import `test` (and `expect` if needed) from "../../fixtures"; page objects from "../../pages/<Name>"; one test
titled "{key}: <title>" tagged "@{key}"; no fixed waits, no `test.only`/`skip`, no file, process or network access;
no secrets. Return the full file as `code`.

Rule-written spec (trusted, platform-generated):
```ts
{code}
```"""

TASK_NEW = """Write a Playwright spec for test case {key} "{title}". The rules couldn't translate these steps:
{blockers}
Steps (trusted, approved at Gate 5):
{steps}
Overall expected result: {overall}

Rules: put it in {path}; import `test` (and `expect` if needed) from "../../fixtures"; use the `qa` fixture helpers
(qa.expectSubmissionBlocked(form), qa.expectFieldFlagged(fieldLocator, label), qa.expectSubmissionAccepted(form),
qa.expectText(text))
or web-first `expect(locator)` matchers; prefer getByRole/getByLabel locators. One test titled "{key}: <title>" tagged
"@{key}". Every assertion carries a `// expects: step <n>` or `// expects: overall` comment naming the expected result
it checks. No fixed waits, no `test.only`/`skip`, no file, process or network access, no secrets. Return the file
as `code`."""

REPAIR = """

Your previous script failed these checks:
{problems}
Fix them and return the full corrected file as `code`. Do not change what the test checks."""


class AutomationDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=20, max_length=40_000)
    notes: str | None = Field(default=None, max_length=1000)


@dataclass
class AiResult:
    case_key: str
    code: str | None = None  # accepted AI code, or None (rule script kept / case stays manual)
    issue: dict[str, Any] | None = None  # validation issue for the bundle (code, case_key, message)
    attempts: int = 0
    repairs: int = 0
    fallback_used: bool = False
    usage: LLMUsage | None = None
    problems: list[str] = field(default_factory=list)


StaticCheck = Callable[[str, str], Awaitable[list[str]]]  # (path, code) → problem messages (empty = passes)


def eligible_manual(blockers: list[dict[str, Any]] | None) -> bool:
    codes = {str(b.get("code")) for b in blockers or []}
    return bool(codes) and codes <= AI_FIXABLE


def site_blocks(site: sm.SiteModel, pages: list[str] | None = None) -> list[UntrustedBlock]:
    """Page and form names, labels and locator candidates: website content, so untrusted."""
    wanted = set(pages or [])
    forms = [
        {
            "name": f.name,
            "path": f.path,
            "submit": f.submit_label,
            "fields": [
                {"label": x.label, "type": x.type, "required": x.required, "locator": x.locator} for x in f.fields
            ],
        }
        for f in site.forms
        if not wanted or f.path in wanted
    ]
    page_list = [
        {"path": p, "title": info.title, "nav": [t for t, _h in info.nav][:40]}
        for p, info in site.pages.items()
        if not wanted or p in wanted
    ]
    return [
        UntrustedBlock("discovered_forms", json.dumps(forms), max_chars=20_000),
        UntrustedBlock("discovered_pages", json.dumps(page_list), max_chars=10_000),
    ]


async def write(
    ctx: AppContext,
    *,
    case: sm.CaseIn,
    path: str,
    baseline: str | None,
    blockers: list[dict[str, Any]] | None,
    blocks: list[UntrustedBlock],
    check: StaticCheck,
) -> AiResult:
    """One case: draft → static checks (+ up to 3 repairs) → expected-value guard."""
    res = AiResult(case.key)
    if baseline is not None:
        task = TASK_REWRITE.format(key=case.key, code=baseline)
    else:
        steps = "\n".join(
            f"{st.n}. {st.action}" + (f" → expected: {st.expected}" if st.expected else "") for st in case.steps
        )
        task = TASK_NEW.format(
            key=case.key,
            title=case.title,
            blockers="\n".join(f"- {b.get('message')}" for b in blockers or []),
            steps=steps,
            overall=case.expected_result or "(none)",
            path=path,
        )
    budget = Budget(max_output_tokens=ctx.settings.ai_max_output_tokens)
    prompt = task
    problems: list[str] = []
    for attempt in range(MAX_REPAIRS + 1):
        out = await ctx.llm.structured(AutomationDraft, prompt, blocks, budget)
        res.attempts += 1
        res.usage = _add(res.usage, out.usage)
        if not out.ok or out.value is None:
            res.fallback_used = True
            res.issue = _issue("ai_fallback", case.key, f"AI output for {case.key} was unusable ({out.reason}); "
                               + ("the rules script is used." if baseline else "the case stays manual."))  # fmt: skip
            return res
        code = out.value.code.replace("\r\n", "\n").rstrip() + "\n"
        if baseline is not None and code == baseline.rstrip() + "\n":
            return res  # nothing to improve: the rules script stays, no checks needed
        problems = await check(path, code)
        if FOCUSED.search(code):
            problems.append("Focused or skipped tests (test.only, test.skip, test.fixme) are not allowed")
        if not problems:
            break
        if attempt < MAX_REPAIRS:
            res.repairs += 1
            prompt = task + REPAIR.format(problems="\n".join(f"- {p}" for p in problems[:20]))
    else:
        res.fallback_used = True
        res.problems = problems
        res.issue = _issue("ai_invalid", case.key, f"AI script for {case.key} failed checks after {MAX_REPAIRS} "
                           "repairs; " + ("the rules script is used." if baseline else "the case stays manual."))  # fmt: skip
        return res
    if baseline is not None:
        diff = eg.changed(baseline, code)
        if diff:
            res.problems = diff
            res.issue = _issue("assertion_changed", case.key,
                               f"Dropped an AI script for {case.key}: it changed what the test checks. "
                               "The rules script is used.")  # fmt: skip
            return res
    else:
        steps_with = {st.n for st in case.steps if st.expected.strip()}
        bad = eg.unmapped(code, steps_with, bool(case.expected_result.strip()))
        if bad:
            res.problems = bad
            res.issue = _issue("assertion_unmapped", case.key,
                               f"Dropped an AI script for {case.key}: an assertion isn't linked to an expected "
                               "result. The case stays manual.")  # fmt: skip
            return res
    res.code = code
    return res


def _issue(code: str, key: str, message: str) -> dict[str, Any]:
    return {"code": code, "case_key": key, "message": message}


def _add(a: LLMUsage | None, b: LLMUsage | None) -> LLMUsage | None:
    if b is None:
        return a
    if a is None:
        return LLMUsage(b.provider, b.model, b.tokens_in, b.tokens_out, b.calls, b.repairs)
    a.tokens_in += b.tokens_in
    a.tokens_out += b.tokens_out
    a.calls += b.calls
    a.repairs += b.repairs
    return a


def toolkit_check(
    ctx: AppContext, assets: dict[str, str], username: str | None = None, password: str | None = None
) -> StaticCheck:
    """Offline static checks for one candidate spec in a throwaway workspace with the bundle's page objects/data."""

    async def run(path: str, code: str) -> list[str]:
        problems = [m["message"] for m in secret_scan.scan(code, username=username, password=password)["messages"]]
        if ctx.toolkit.problem() is not None:
            return [*problems, f"The testing toolkit is not available: {ctx.toolkit.problem()}"]
        ws = svc.workspace(ctx, f"ai-{uuid.uuid4().hex[:12]}")
        try:
            await ctx.toolkit.init(ws)
            svc.write_bundle(ws, {**assets, path: code})
            report = await ctx.toolkit.validate(ws, [path])
        except (ToolkitError, OSError, ValueError) as exc:
            return [*problems, f"The script couldn't be checked: {str(exc).splitlines()[0][:200]}"]
        finally:
            shutil.rmtree(ws, ignore_errors=True)
        rep = (report.get("files") or {}).get(path) or {}
        for name in ("guard", "tsc", "eslint", "tags"):
            chk = rep.get(name) or {}
            if not chk.get("ok", False):
                msgs = chk.get("messages") or [{"line": None, "message": f"{name} failed"}]
                problems += [
                    (f"Line {m['line']}: " if m.get("line") else "") + f"{name}: {m.get('message')}" for m in msgs[:10]
                ]
        return problems

    return run
