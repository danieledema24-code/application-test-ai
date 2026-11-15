"""Adapter for the toolkit's load generator (P5-01a, decision D17): `node automation/bin/qa.mjs perf …`.

Load is capped in code at several layers (decision D18). This adapter is one of them: it refuses a configuration
above the platform hard cap before spawning anything, and always passes the hard cap to the generator as
`--max-vus/--max-rps/--max-duration`, which refuses it again (and has its own compiled maximum). The child gets the
toolkit's scrubbed environment (no platform secret, no credentials: load is never signed in), runs in its own process
group with CPU and file limits, and is stopped with the control file plus SIGTERM (the generator flushes a partial
summary within 2 s). A run that outlives its profile by 30 s is killed (SIGKILL to the group).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.automation.toolkit import Limits, Toolkit
from app.domain.performance.limits import MAX_TARGETS, LoadLimits

log = logging.getLogger(__name__)
WALL_CLOCK_GRACE_S = 30
STOP_GRACE_S = 5.0
# The generator's configuration keys (automation/src/perf/config.ts); anything else is refused here as well.
CONFIG_KEYS = frozenset(
    {
        "origin",
        "targets",
        "stages",
        "think_time_ms",
        "max_rps",
        "thresholds",
        "kill_switch",
        "allowed_hosts",
        "allow_private",
        "max_duration_s",
        "request_timeout_ms",
    }
)
Progress = Callable[[dict[str, Any]], Awaitable[None]]


class LoadRefused(ValueError):
    """The configuration is over a limit or malformed; nothing was started."""


class LoadGeneratorError(RuntimeError):
    """The generator could not run (not installed, or it refused the configuration)."""


@dataclass(frozen=True)
class LoadResult:
    exit_code: int | None
    status: str  # completed | stopped | aborted (kill switch) | killed (wall clock) | error
    summary: dict[str, Any] | None
    reason: str | None = None


def profile_numbers(config: dict[str, Any]) -> tuple[int, int, int, int]:
    """(peak users, max requests a second, total seconds, targets) of a generator configuration."""
    stages = config.get("stages") or []
    try:
        vus = max((int(s["target_vus"]) for s in stages), default=0)
        duration = sum(int(s["duration_s"]) for s in stages)
        rps = int(config.get("max_rps") or 0)
    except (KeyError, TypeError, ValueError) as exc:
        raise LoadRefused("The load profile is malformed") from exc
    return vus, rps, duration, len(config.get("targets") or [])


def check_config(config: dict[str, Any], cap: LoadLimits) -> None:
    """Refuses unknown keys (no headers, cookies or credentials can ride along) and anything over the hard cap."""
    extra = sorted(set(config) - CONFIG_KEYS)
    if extra:
        raise LoadRefused(f"Unknown load settings: {', '.join(extra)}")
    vus, rps, duration, targets = profile_numbers(config)
    if vus > cap.vus:
        raise LoadRefused(f"Profile exceeds the platform limit: {vus} users (limit {cap.vus})")
    if rps > cap.rps:
        raise LoadRefused(f"Profile exceeds the platform limit: {rps} requests a second (limit {cap.rps})")
    if duration > cap.duration_s:
        raise LoadRefused(f"Profile exceeds the platform limit: {duration} s of load (limit {cap.duration_s} s)")
    if vus < 1 or rps < 1 or duration < 1:
        raise LoadRefused("The load profile needs users, a request rate and a duration")
    if not 1 <= targets <= MAX_TARGETS:
        raise LoadRefused(f"A load test can target 1–{MAX_TARGETS} pages")
    for t in config.get("targets") or []:
        if str((t or {}).get("method", "GET")).upper() != "GET":
            raise LoadRefused("Only GET requests are allowed")


class LoadGenerator:
    def __init__(self, toolkit: Toolkit, cap: LoadLimits) -> None:
        self.toolkit = toolkit
        self.cap = cap

    def problem(self) -> str | None:
        if shutil.which(self.toolkit.node) is None:
            return "Node.js is not installed"
        if not self.toolkit.cli.is_file():
            return f"The automation toolkit was not found at {self.toolkit.root}"
        return None

    def _args(self, config_file: Path) -> list[str]:
        return [
            str(self.toolkit.cli),
            "perf",
            "--config",
            str(config_file),
            "--max-vus",
            str(self.cap.vus),
            "--max-rps",
            str(self.cap.rps),
            "--max-duration",
            str(self.cap.duration_s),
        ]

    async def _spawn(self, args: list[str], *, cpu_s: int) -> asyncio.subprocess.Process:
        problem = self.problem()
        if problem is not None:
            raise LoadGeneratorError(problem)
        return await asyncio.create_subprocess_exec(
            self.toolkit.node,
            *args,
            cwd=str(self.toolkit.root),
            env=Toolkit.child_env(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            preexec_fn=Limits(cpu_s=cpu_s).apply,
            limit=1024 * 1024,  # the final summary line can be long
        )

    async def export_k6(self, config: dict[str, Any], workdir: Path) -> str:
        """The equivalent k6 script ("Not run by the platform"); checked by the same limits as a run."""
        check_config(config, self.cap)
        config_file, _summary, _control = await asyncio.to_thread(_prepare, workdir, config)
        out = workdir / "script.js"
        proc = await self._spawn([*self._args(config_file), "--export-k6", str(out)], cpu_s=60)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
        except TimeoutError:
            await _kill(proc, signal.SIGKILL)
            raise LoadGeneratorError("The k6 export timed out") from None
        if proc.returncode != 0:
            raise LoadGeneratorError(_error_of(stdout) or f"The k6 export failed (exit code {proc.returncode})")
        return await asyncio.to_thread(out.read_text)

    async def run(
        self,
        config: dict[str, Any],
        workdir: Path,
        *,
        on_progress: Progress | None = None,
        stop: asyncio.Event | None = None,
    ) -> LoadResult:
        """Runs one load test to its end, a stop, the kill switch or the wall clock. Raises LoadRefused before
        starting anything when the configuration is over the cap, and LoadGeneratorError when the generator
        refuses it (exit code 2, nothing sent)."""
        check_config(config, self.cap)
        _vus, _rps, duration, _n = profile_numbers(config)
        config_file, summary_file, control = await asyncio.to_thread(_prepare, workdir, config)
        wall = duration + WALL_CLOCK_GRACE_S
        proc = await self._spawn(
            [*self._args(config_file), "--summary", str(summary_file), "--control", str(control)], cpu_s=wall + 60
        )
        last: dict[str, Any] = {}

        async def read() -> None:
            assert proc.stdout is not None
            async for raw in proc.stdout:
                with contextlib.suppress(json.JSONDecodeError, UnicodeDecodeError):
                    line = json.loads(raw.decode("utf-8"))
                    if not isinstance(line, dict):
                        continue
                    last.clear()
                    last.update(line)
                    if line.get("type") == "progress" and on_progress is not None:
                        await on_progress(line)

        async def stopper() -> None:
            if stop is None:
                return
            await stop.wait()
            await asyncio.to_thread(control.write_text, "stop")
            await _signal(proc, signal.SIGTERM)

        reader = asyncio.ensure_future(read())
        watcher = asyncio.ensure_future(stopper())
        killed = False
        try:
            await asyncio.wait_for(asyncio.shield(reader), timeout=wall)
        except TimeoutError:
            killed = True
            await _kill(proc, signal.SIGKILL)
        except BaseException:  # cancelled, or the progress callback failed: never leave load running
            await _kill(proc, signal.SIGKILL)
            raise
        finally:
            watcher.cancel()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(reader, timeout=STOP_GRACE_S)
        code = await _wait(proc)
        stopped_early = stop is not None and stop.is_set() and not killed
        if stopped_early and code is not None and (code == 2 or code < 0 or code >= 128) and not summary_file.exists():
            # The stop landed before the generator could write anything (it was still starting): nothing was sent
            # beyond what the summary would show, and this is a stop, not a refusal.
            return LoadResult(code, "stopped", None, "Stopped before the load test started")
        if code == 2 and not killed:
            raise LoadGeneratorError(str(last.get("error") or "The load generator refused the configuration"))
        summary: dict[str, Any] | None = None
        with contextlib.suppress(OSError, json.JSONDecodeError):
            summary = json.loads(await asyncio.to_thread(summary_file.read_text))
        if killed:
            return LoadResult(code, "killed", summary, f"The run did not end within {wall} s and was stopped")
        if summary is None:
            return LoadResult(code, "error", None, str(last.get("error") or "The load generator wrote no summary"))
        return LoadResult(code, str(summary.get("status")), summary, summary.get("reason"))


def _prepare(workdir: Path, config: dict[str, Any]) -> tuple[Path, Path, Path]:
    """Writes the configuration; returns (config file, summary file, control file), the last two cleared."""
    workdir.mkdir(parents=True, exist_ok=True)
    config_file, summary_file, control = (
        workdir / "perf-config.json",
        workdir / "perf-summary.json",
        workdir / "perf-stop",
    )
    config_file.write_text(json.dumps(config))
    for f in (summary_file, control):
        f.unlink(missing_ok=True)
    return config_file, summary_file, control


def _error_of(stdout: bytes) -> str | None:
    for raw in reversed(stdout.decode("utf-8", "replace").splitlines()):
        with contextlib.suppress(json.JSONDecodeError):
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("error"):
                return str(data["error"])
    return None


async def _signal(proc: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, sig)


async def _kill(proc: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    await _signal(proc, sig)
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(proc.wait(), timeout=STOP_GRACE_S)


async def _wait(proc: asyncio.subprocess.Process) -> int | None:
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(proc.wait(), timeout=STOP_GRACE_S)
    if proc.returncode is None:
        await _kill(proc, signal.SIGKILL)
    return proc.returncode
