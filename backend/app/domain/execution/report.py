"""Playwright JSON report → execution results (P4-06). Pure: no I/O apart from reading attachment files the caller
allows (the run workspace only).

Status comes only from the reporter (never from a model or a person):
- `passed`: the test passed on its first attempt.
- `flaky`: it failed, then passed on retry (decision D9: never a defect).
- `failed`: an assertion (`QA_ASSERTION:` or a failed `expect`) or a timeout failed on the last attempt.
- `error`: the script or its setup broke (TypeError, strict-mode violation, missing credentials…), or the test was
  interrupted (cancelled, time limit), or Playwright reported nothing for it.

Errors are stripped of ANSI colours, redacted (saved credentials never appear) and capped at 8 KB.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

QA_PREFIX = "QA_ASSERTION:"
MAX_ERROR = 8 * 1024
HOOKS = re.compile(r"^(Before Hooks|After Hooks|Worker Cleanup|Fixture|Attach )", re.I)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
PROJECT = re.compile(r"^(chromium|firefox|webkit)-(\d{2,4})x(\d{2,4})(~.*)?$")
ASSERTION = re.compile(
    r"QA_ASSERTION:|expect\(.*\)\.\w+\(.*\) failed|^\s*Expected[: ].*$|toBe|toHave|toContain", re.I | re.M
)
TIMEOUT = re.compile(r"Timeout \d+ms exceeded|Test timeout of \d+ms exceeded", re.I)
ATTACHMENT_NAMES = {"final-state", "page-state", "console", "network", "masked-regions", "video", "trace"}


@dataclass
class Attachment:
    name: str
    content_type: str
    data: bytes


@dataclass
class Attempt:
    n: int
    status: str  # Playwright: passed | failed | timedOut | interrupted | skipped
    duration_ms: int
    steps: list[dict[str, Any]]
    error: str | None
    page_state: dict[str, Any] | None
    attachments: list[Attachment] = field(default_factory=list)


@dataclass
class Outcome:
    status: str  # ResultStatus value
    attempts: list[Attempt]
    duration_ms: int
    steps: list[dict[str, Any]]
    failed_step: dict[str, Any] | None
    error: str | None
    page_state: dict[str, Any] | None
    actual_result: str
    kind: str | None  # assertion | timeout | script | interrupted | None


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


def redact(text: str, secrets: list[str]) -> str:
    out = text
    for value in sorted({x for x in secrets if x and len(x) >= 3}, key=len, reverse=True):
        out = out.replace(value, "[redacted]")
    return out


def clean(text: str | None, secrets: list[str], limit: int = MAX_ERROR) -> str:
    out = redact(strip_ansi(text or ""), secrets).strip()
    return out if len(out) <= limit else out[: limit - 1] + "…"


def project_target(name: str) -> tuple[str, str] | None:
    """`chromium-1440x900~once` → ("chromium", "1440x900")."""
    m = PROJECT.match(name or "")
    return (m.group(1), f"{m.group(2)}x{m.group(3)}") if m else None


def collect_tests(report: dict[str, Any]) -> list[dict[str, Any]]:
    """Flat list of {file, title, project, status, results} from the nested suites."""
    out: list[dict[str, Any]] = []

    def walk(suite: dict[str, Any]) -> None:
        for spec in suite.get("specs") or []:
            for t in spec.get("tests") or []:
                out.append(
                    {
                        "file": str(spec.get("file") or ""),
                        "title": str(spec.get("title") or ""),
                        "project": str(t.get("projectName") or ""),
                        "status": str(t.get("status") or ""),
                        "results": list(t.get("results") or []),
                    }
                )
        for child in suite.get("suites") or []:
            walk(child)

    for s in report.get("suites") or []:
        walk(s)
    return out


def global_errors(report: dict[str, Any], secrets: list[str]) -> str:
    return clean("\n".join(str(e.get("message") or "") for e in report.get("errors") or []), secrets)


def _steps(raw: list[dict[str, Any]], secrets: list[str]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    for st in raw:
        title = str(st.get("title") or "")
        if HOOKS.match(title) or str(st.get("category") or "test.step") not in ("test.step", ""):
            continue
        err = st.get("error") or None
        steps.append(
            {
                "n": len(steps) + 1,
                "title": redact(title, secrets)[:300],
                "status": "failed" if err else "passed",
                "duration_ms": round(float(st.get("duration") or 0)),
                "error": clean(str(err.get("message") or ""), secrets, 500) if isinstance(err, dict) else None,
            }
        )
    return steps


def _error_of(result: dict[str, Any], secrets: list[str]) -> str | None:
    err = result.get("error") or {}
    text = str(err.get("message") or "") if isinstance(err, dict) else ""
    if not text:
        text = "\n".join(str(e.get("message") or "") for e in result.get("errors") or [] if isinstance(e, dict))
    return clean(text, secrets) or None


def kind_of(pw_status: str, error: str | None) -> str | None:
    if pw_status == "passed":
        return None
    if pw_status == "interrupted":
        return "interrupted"
    text = error or ""
    if text.startswith(QA_PREFIX) or QA_PREFIX in text.split("\n", 1)[0]:
        return "assertion"
    if re.search(r"strict mode violation|TypeError|ReferenceError|SyntaxError|is not a function", text):
        return "script"
    if pw_status == "timedOut" or TIMEOUT.search(text):
        return "timeout"
    if ASSERTION.search(text):
        return "assertion"
    return "script"


def describe_state(state: dict[str, Any] | None) -> str:
    """`"Thank you" (Message sent) at /contact` (the toolkit's describeState)."""
    if not state:
        return ""
    shown = state.get("heading") or state.get("title") or "(no heading)"
    msgs = [str(m) for m in state.get("messages") or [] if m]
    return f'"{shown}"' + (f" ({' · '.join(msgs)})" if msgs else "") + f" at {state.get('url') or '/'}"


def actual_result(
    status: str, failed_step: dict[str, Any] | None, error: str | None, state: dict[str, Any] | None, kind: str | None
) -> str:
    """Plain language (roadmap P4-06): "Step 'Press Send message' failed: Expected the Contact us form to block the
    submission and still be shown, but the page shows "Thank you" (Message sent) at /contact."."""
    if status in ("passed", "flaky"):
        return (
            "Every step passed and every check held."
            if status == "passed"
            else ("Failed on the first attempt, passed on the retry.")
        )
    first = ""
    for line in (error or "").split("\n"):
        line = re.sub(r"^(Error:\s*)+", "", line.strip())
        if line:
            first = line
            break
    if first.startswith(QA_PREFIX):
        first = first[len(QA_PREFIX) :].strip()
    if len(first) > 400:
        first = first[:399] + "…"
    where = f"Step '{failed_step['title']}' failed" if failed_step else "The test failed before its first step"
    text = f"{where}: {first}" if first else f"{where}."
    if first and not re.search(r"[.!?…]$", first):
        text += "."
    if kind != "assertion" and state:
        text += f" The page shows {describe_state(state)}."
    return text


def _attachments(result: dict[str, Any], read: Callable[[str], bytes | None]) -> list[Attachment]:
    out = []
    for a in result.get("attachments") or []:
        name = str(a.get("name") or "")
        if name not in ATTACHMENT_NAMES:
            continue
        data: bytes | None = None
        if a.get("path"):
            data = read(str(a["path"]))
        elif a.get("body"):
            try:
                data = base64.b64decode(str(a["body"]))
            except ValueError:
                data = None
        if data is not None:
            out.append(Attachment(name, str(a.get("contentType") or "application/octet-stream"), data))
    return out


def parse_test(t: dict[str, Any], secrets: list[str], read: Callable[[str], bytes | None]) -> Outcome:
    """One Playwright test (all its attempts) → an outcome."""
    attempts: list[Attempt] = []
    for i, r in enumerate(t["results"], start=1):
        atts = _attachments(r, read)
        state = None
        for a in atts:
            if a.name == "page-state":
                try:
                    loaded = json.loads(redact(a.data.decode("utf-8", "replace"), secrets))
                    state = loaded if isinstance(loaded, dict) else None
                except ValueError:
                    state = None
        attempts.append(
            Attempt(
                n=int(r.get("retry", i - 1)) + 1,
                status=str(r.get("status") or ""),
                duration_ms=round(float(r.get("duration") or 0)),
                steps=_steps(list(r.get("steps") or []), secrets),
                error=_error_of(r, secrets),
                page_state=state,
                attachments=atts,
            )
        )
    if not attempts:
        return no_result("No result reported by Playwright")
    last = attempts[-1]
    if t.get("status") == "flaky" or (last.status == "passed" and len(attempts) > 1):
        status, kind = "flaky", None
    elif last.status == "passed":
        status, kind = "passed", None
    elif last.status == "skipped":
        status, kind = "skipped", None
    else:
        kind = kind_of(last.status, last.error)
        status = "failed" if kind in ("assertion", "timeout") else "error"
    shown = last if status not in ("flaky",) else next((a for a in attempts if a.status != "passed"), last)
    failed_step = next(({"n": s["n"], "title": s["title"]} for s in shown.steps if s["status"] == "failed"), None)
    error = shown.error if status != "passed" else None
    return Outcome(
        status=status,
        attempts=attempts,
        duration_ms=sum(a.duration_ms for a in attempts),
        steps=last.steps,
        failed_step=failed_step if status != "passed" else None,
        error=error,
        page_state=last.page_state,
        actual_result=actual_result(status, failed_step, error, shown.page_state or last.page_state, kind),
        kind=kind,
    )


def no_result(reason: str) -> Outcome:
    return Outcome(
        status="error",
        attempts=[],
        duration_ms=0,
        steps=[],
        failed_step=None,
        error=reason,
        page_state=None,
        actual_result=f"The test couldn't finish: {reason[:1].lower() + reason[1:]}.",
        kind="interrupted",
    )


def safe_reader(root: Path) -> Callable[[str], bytes | None]:
    """Reads an attachment only when its real path is inside the run workspace (as the old runner did)."""
    real_root = root.resolve()

    def read(p: str) -> bytes | None:
        try:
            real = Path(p).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if real_root not in real.parents or not real.is_file():
            return None
        try:
            return real.read_bytes()
        except OSError:
            return None

    return read
