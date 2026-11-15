"""Adapter for the `automation/` Node toolkit (P4-01): `node automation/bin/qa.mjs <command>`.

The toolkit validates generated Playwright specs and runs them. Specs are untrusted code, so the child process gets
a scrubbed environment: only `PATH`, `HOME`, `CI=1`, `PLAYWRIGHT_BROWSERS_PATH` (when set) and the variables of
the call. Platform secrets (`SECRET_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, …) never reach it. Each call runs
in its own process group, which is killed (SIGTERM, then SIGKILL after 5 s) on timeout or cancellation.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import resource
import shutil
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings

log = logging.getLogger(__name__)
KILL_GRACE_S = 5.0
VERSION_TTL_S = 300.0
# Run-specific variables a caller may pass to the child (anything else is refused, so a secret can't slip in by
# mistake). Credentials are passed only by the execution engine, only for runs that sign in (P4-06).
ALLOWED_CALL_ENV = frozenset(
    {
        "BASE_URL",
        "ATA_ALLOWED_HOSTS",
        "ATA_APPROVED_ORIGIN",
        "ATA_ALLOW_PRIVATE",
        "ATA_OUTPUT_DIR",
        "ATA_BROWSERS",
        "ATA_VIEWPORTS",
        "ATA_VIDEO",
        "ATA_TRACE",
        "ATA_LOGIN_PATH",
        "ATA_FETCH_TIMEOUT_MS",
        "ATA_NO_RETRY",
        "ATA_NO_TRACE",
        "PW_WORKERS",
        "PW_RETRIES",
        "TEST_TIMEOUT_MS",
        "TEST_USERNAME",
        "TEST_PASSWORD",
    }
)


class ToolkitError(RuntimeError):
    """The toolkit could not run (not installed, timed out, or answered with an error)."""


@dataclass(frozen=True)
class ToolkitVersion:
    node: str
    toolkit: str
    playwright: str | None
    browsers: list[str]
    loadgen: str | None = None  # P5-01a: the `qa perf` load generator's version (None before 0.5.0)


@dataclass(frozen=True)
class ToolkitResult:
    exit_code: int
    data: dict[str, Any]
    timed_out: bool = False
    cancelled: bool = False


@dataclass(frozen=True)
class Limits:
    """Resource limits of a test run's process group (P4-06). macOS does not enforce RLIMIT_AS, so memory is not
    capped there (recorded as a limitation); CPU seconds, file size and open files are."""

    cpu_s: int
    file_size_mb: int = 512
    open_files: int = 4096

    def apply(self) -> None:  # runs in the child between fork and exec
        for which, value in (
            (resource.RLIMIT_CPU, self.cpu_s),
            (resource.RLIMIT_FSIZE, self.file_size_mb * 1024 * 1024),
            (resource.RLIMIT_NOFILE, self.open_files),
        ):
            with contextlib.suppress(ValueError, OSError):
                _soft, hard = resource.getrlimit(which)
                cap = value if hard == resource.RLIM_INFINITY else min(value, hard)
                resource.setrlimit(which, (cap, hard))


class Toolkit:
    def __init__(self, settings: Settings) -> None:
        self.root = Path(settings.automation_dir).resolve()
        self.node = settings.node_binary
        self.timeout_s = settings.toolkit_timeout_s
        self._version: tuple[float, ToolkitVersion | None] | None = None

    @property
    def cli(self) -> Path:
        return self.root / "bin" / "qa.mjs"

    def problem(self) -> str | None:
        """Why the toolkit can't be used, or None."""
        if shutil.which(self.node) is None:
            return "Node.js is not installed"
        if not self.cli.is_file():
            return f"The automation toolkit was not found at {self.root}"
        if not (self.root / "node_modules" / "@playwright" / "test").is_dir():
            return "The automation toolkit's dependencies are not installed (run `npm ci` in automation/)"
        return None

    @staticmethod
    def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
        """The complete environment of a toolkit process (nothing is inherited beyond these keys)."""
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/"), "CI": "1"}
        if os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
            env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ["PLAYWRIGHT_BROWSERS_PATH"]
        for key, value in (extra or {}).items():
            if key not in ALLOWED_CALL_ENV:
                raise ValueError(f"{key} can't be passed to the automation toolkit")
            env[key] = str(value)
        return env

    async def call(
        self,
        args: list[str],
        *,
        env: dict[str, str] | None = None,
        timeout_s: float | None = None,
        cancel: asyncio.Event | None = None,
        limits: Limits | None = None,
        interrupt_first: bool = False,
    ) -> ToolkitResult:
        problem = self.problem()
        if problem is not None:
            raise ToolkitError(problem)
        proc = await asyncio.create_subprocess_exec(
            self.node,
            str(self.cli),
            *args,
            cwd=str(self.root),
            env=self.child_env(env),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,  # own process group: Playwright and its browsers are killed with it
            preexec_fn=limits.apply if limits is not None else None,
        )
        comm = asyncio.ensure_future(proc.communicate())
        waiters: set[asyncio.Future[Any]] = {comm}
        cancelled_wait = asyncio.ensure_future(cancel.wait()) if cancel is not None else None
        if cancelled_wait is not None:
            waiters.add(cancelled_wait)
        try:
            done, _ = await asyncio.wait(
                waiters, timeout=timeout_s or self.timeout_s, return_when=asyncio.FIRST_COMPLETED
            )
        except asyncio.CancelledError:
            # The worker is stopping: never leave Playwright or a browser behind.
            await _kill_group(proc)
            if cancelled_wait is not None:
                cancelled_wait.cancel()
            raise
        timed_out = not done
        cancelled = cancelled_wait is not None and cancelled_wait in done and comm not in done
        if cancelled_wait is not None and not cancelled_wait.done():
            cancelled_wait.cancel()
        if timed_out or cancelled:
            await _kill_group(proc, interrupt_first=interrupt_first)
        stdout, _stderr = await comm
        data: dict[str, Any] = {}
        lines = [ln for ln in stdout.decode("utf-8", "replace").splitlines() if ln.strip()]
        if lines:
            with contextlib.suppress(json.JSONDecodeError):
                parsed = json.loads(lines[-1])
                if isinstance(parsed, dict):
                    data = parsed
        code = proc.returncode if proc.returncode is not None else -1
        if not (timed_out or cancelled) and (code == 2 or not data) and "exit_code" not in data:
            raise ToolkitError(str(data.get("error") or f"The automation toolkit failed (exit code {code})"))
        return ToolkitResult(exit_code=code, data=data, timed_out=timed_out, cancelled=cancelled)

    async def version(self, *, refresh: bool = False) -> ToolkitVersion | None:
        """Versions and installed browsers, cached for 5 minutes. None when the toolkit can't run."""
        now = time.monotonic()
        if not refresh and self._version is not None and now - self._version[0] < VERSION_TTL_S:
            return self._version[1]
        value: ToolkitVersion | None
        try:
            res = await self.call(["version"], timeout_s=30)
            d = res.data
            value = ToolkitVersion(
                node=str(d.get("node", "")),
                toolkit=str(d.get("toolkit", "")),
                playwright=str(d["playwright"]) if d.get("playwright") else None,
                browsers=[str(b) for b in d.get("browsers_installed", [])],
                loadgen=str(d["loadgen"]) if d.get("loadgen") else None,
            )
        except (ToolkitError, OSError) as exc:
            log.info("automation toolkit unavailable: %s", str(exc).splitlines()[0][:200])
            value = None
        self._version = (now, value)
        return value

    async def init(self, bundle_dir: Path, *, live: bool = False) -> list[str]:
        """Copies the platform files (fixtures, qa, policy, config) into a bundle directory."""
        args = ["init", "--dir", str(bundle_dir)] + (["--live"] if live else [])
        res = await self.call(args, timeout_s=60)
        if res.timed_out:
            raise ToolkitError("The automation toolkit timed out after 60 s while preparing the scripts")
        return [str(f) for f in res.data.get("files", [])]

    async def validate(self, bundle_dir: Path, files: list[str] | None = None) -> dict[str, Any]:
        """The toolkit's validation report. Raises ToolkitError when it times out, so a check that never finished
        is reported with its reason instead of as "not checked" (QA P4-BUG-04)."""
        args = ["validate", "--dir", str(bundle_dir)]
        if files:
            args += ["--files", ",".join(files)]
        res = await self.call(args)
        if res.timed_out:
            raise ToolkitError(f"The automation toolkit timed out after {int(self.timeout_s)} s")
        return res.data

    async def run(
        self,
        workspace: Path,
        report: Path,
        *,
        env: dict[str, str],
        timeout_s: float,
        live_dir: Path | None = None,
        progress: Path | None = None,
        grep: str | None = None,
        cancel: asyncio.Event | None = None,
        limits: Limits | None = None,
    ) -> ToolkitResult:
        args = ["run", "--dir", str(workspace), "--report", str(report)]
        if live_dir is not None:
            args += ["--live-dir", str(live_dir)]
        if progress is not None:
            args += ["--progress", str(progress)]
        if grep:
            args += ["--grep", grep]
        # SIGINT first: Playwright's runner stops the tests and still writes the JSON report (finished results kept).
        return await self.call(args, env=env, timeout_s=timeout_s, cancel=cancel, limits=limits, interrupt_first=True)


INTERRUPT_GRACE_S = 4.0


async def _kill_group(proc: asyncio.subprocess.Process, *, interrupt_first: bool = False) -> None:
    """SIGTERM the child's process group, then SIGKILL after the grace period. With `interrupt_first`, SIGINT first
    (Playwright writes its report), then SIGKILL: the group is gone within about 6 seconds."""
    steps = (
        ((signal.SIGINT, INTERRUPT_GRACE_S), (signal.SIGKILL, KILL_GRACE_S))
        if interrupt_first
        else ((signal.SIGTERM, KILL_GRACE_S), (signal.SIGKILL, KILL_GRACE_S))
    )
    for sig, wait in steps:
        if proc.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, sig)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=wait)
