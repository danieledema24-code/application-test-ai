"""P4-01: the Python adapter for the automation/ Node toolkit (scrubbed child env, JSON parsing, timeouts)."""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path
from typing import Any

import pytest

from app.automation import toolkit as tk
from app.automation.toolkit import Toolkit, ToolkitError
from tests.conftest import make_settings

PLATFORM_SECRETS = {
    "SECRET_KEY": "platform-secret-key-value",
    "ANTHROPIC_API_KEY": "sk-ant-not-a-real-key",
    "DATABASE_URL": "postgresql://qa:pw@db/qa",
    "ENCRYPTION_KEY": "c2VjcmV0",
}
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


class _FakeProc:
    def __init__(self, stdout: bytes, code: int) -> None:
        self._stdout = stdout
        self.returncode = code
        self.pid = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, b""

    async def wait(self) -> int:
        return self.returncode


def _fake_root(tmp_path: Path, script: str) -> Path:
    root = tmp_path / "automation"
    (root / "bin").mkdir(parents=True)
    (root / "node_modules" / "@playwright" / "test").mkdir(parents=True)
    (root / "bin" / "qa.mjs").write_text(script)
    return root


async def test_child_env_contains_no_platform_secret(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in PLATFORM_SECRETS.items():
        monkeypatch.setenv(k, v)
    captured: dict[str, Any] = {}

    async def fake_exec(*args: Any, **kwargs: Any) -> _FakeProc:
        captured["args"], captured["env"] = args, kwargs["env"]
        captured["new_session"] = kwargs.get("start_new_session")
        return _FakeProc(b'{"exit_code": 0, "report_file": "r.json", "duration_ms": 5, "stderr_tail": ""}\n', 0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    toolkit = Toolkit(make_settings(tmp_path, automation_dir=_fake_root(tmp_path, "")))
    res = await toolkit.run(
        tmp_path / "ws",
        tmp_path / "r.json",
        env={"BASE_URL": "http://127.0.0.1:4100", "TEST_USERNAME": "u", "TEST_PASSWORD": "p"},
        timeout_s=10,
    )
    assert res.exit_code == 0 and res.data["report_file"] == "r.json"
    env = captured["env"]
    assert set(env) <= {"PATH", "HOME", "CI", "PLAYWRIGHT_BROWSERS_PATH", "BASE_URL", "TEST_USERNAME", "TEST_PASSWORD"}
    assert env["CI"] == "1" and env["BASE_URL"] == "http://127.0.0.1:4100"
    for k, v in PLATFORM_SECRETS.items():
        assert k not in env and v not in env.values()
    assert captured["new_session"] is True  # own process group, killed as a whole


def test_only_known_run_variables_can_be_passed() -> None:
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Toolkit.child_env({"SECRET_KEY": "x"})
    with pytest.raises(ValueError, match="NODE_OPTIONS"):
        Toolkit.child_env({"NODE_OPTIONS": "--require /tmp/x.js"})


@needs_node
async def test_real_child_sees_only_the_scrubbed_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in PLATFORM_SECRETS.items():
        monkeypatch.setenv(k, v)
    root = _fake_root(
        tmp_path,
        "process.stdout.write(JSON.stringify({exit_code: 0, env: Object.keys(process.env).sort()}) + '\\n');\n",
    )
    res = await Toolkit(make_settings(tmp_path, automation_dir=root)).call(["run"], env={"BASE_URL": "http://x"})
    keys = set(res.data["env"])
    assert not keys & set(PLATFORM_SECRETS), keys
    assert {"PATH", "HOME", "CI", "BASE_URL"} <= keys


@needs_node
async def test_timeout_kills_the_process_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tk, "KILL_GRACE_S", 1.0)
    pid_file = tmp_path / "child.pid"
    script = (
        "import { spawn } from 'node:child_process';\n"
        "import fs from 'node:fs';\n"
        "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n"
        f"fs.writeFileSync({str(pid_file)!r}, String(c.pid));\n"
        "setInterval(() => {}, 1000);\n"
    )
    toolkit = Toolkit(make_settings(tmp_path, automation_dir=_fake_root(tmp_path, script)))
    started = time.monotonic()
    res = await toolkit.call(["run"], timeout_s=1.0)
    assert res.timed_out and time.monotonic() - started < 6
    grandchild = int(pid_file.read_text())
    for _ in range(50):
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.1)
    else:
        pytest.fail("the grandchild process survived the process-group kill")


async def test_missing_toolkit_reports_no_version(tmp_path: Path) -> None:
    toolkit = Toolkit(make_settings(tmp_path, automation_dir=tmp_path / "nowhere"))
    assert toolkit.problem() is not None
    assert await toolkit.version() is None
    with pytest.raises(ToolkitError):
        await toolkit.validate(tmp_path)


@needs_node
async def test_version_reports_the_pinned_playwright_and_chromium(tmp_path: Path) -> None:
    """Needs `npm ci` and `npx playwright install chromium` in automation/ (the shared browser install)."""
    toolkit = Toolkit(make_settings(tmp_path))
    if toolkit.problem() is not None:
        pytest.skip(toolkit.problem() or "")
    import importlib.metadata
    import json

    version = await toolkit.version()
    assert version is not None
    driver = Path(importlib.import_module("playwright").__file__ or "").parent / "driver" / "package" / "package.json"
    # One browser install serves both: the toolkit pins the Playwright build the Python package bundles.
    assert version.playwright == json.loads(driver.read_text())["version"]
    assert importlib.metadata.version("playwright").startswith(".".join(version.playwright.split(".")[:2]))
    assert "chromium" in version.browsers


@needs_node
async def test_a_validation_that_times_out_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """QA P4-BUG-04: a timed-out check raises with its reason; it never comes back as an empty report."""
    monkeypatch.setattr(tk, "KILL_GRACE_S", 0.5)
    toolkit = Toolkit(make_settings(tmp_path, automation_dir=_fake_root(tmp_path, "setInterval(() => {}, 1000);\n")))
    toolkit.timeout_s = 1
    with pytest.raises(ToolkitError, match="timed out after 1 s"):
        await toolkit.validate(tmp_path)


def test_gate6_is_not_announced_while_the_checks_never_ran() -> None:
    from app.orchestrator.orchestrator import g6_unchecked

    assert g6_unchecked({"validation": {"status": "running"}}) == "the script checks haven't finished"
    problem = "The testing toolkit couldn't check the scripts: timed out"
    assert (
        g6_unchecked({"validation": {"status": "done", "toolkit": problem, "counts": {"not_checked": 29}}}) == problem
    )
    assert g6_unchecked({"validation": {"status": "done", "toolkit": None, "counts": {"valid": 29}}}) is None
