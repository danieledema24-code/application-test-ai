"""P5-01a: the Python adapter for the toolkit's load generator. Over-cap configurations are refused before any
process starts, the generator gets the hard cap and a scrubbed environment, progress lines are streamed, a stop
ends the run within 2 s with a partial summary, and the k6 export is labelled and never run."""

from __future__ import annotations

import asyncio
import shutil
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from app.automation.loadgen import LoadGenerator, LoadGeneratorError, LoadRefused, check_config
from app.automation.toolkit import Toolkit
from app.domain.performance.limits import DEFAULT_HARD_CAP, LoadLimits
from tests.conftest import make_settings
from tests.unit.test_toolkit import PLATFORM_SECRETS

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


class _Site:
    def __init__(self) -> None:
        self.log: list[str] = []
        self.headers: list[dict[str, str]] = []
        site = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                site.log.append(f"GET {self.path}")
                site.headers.append({k.lower(): v for k, v in self.headers.items()})
                body = b"ok"
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture
def site() -> Iterator[_Site]:
    s = _Site()
    yield s
    s.server.shutdown()
    s.server.server_close()


def _config(origin: str, **over: Any) -> dict[str, Any]:
    return {
        "origin": origin,
        "targets": [{"path": "/", "weight": 2}, {"path": "/products", "weight": 1}],
        "stages": [{"duration_s": 1, "target_vus": 3}, {"duration_s": 2, "target_vus": 3}],
        "think_time_ms": {"min": 50, "max": 100},
        "max_rps": 20,
        "allowed_hosts": ["127.0.0.1"],
        "allow_private": True,
        **over,
    }


def _gen(tmp_path: Path, cap: LoadLimits = DEFAULT_HARD_CAP) -> LoadGenerator:
    return LoadGenerator(Toolkit(make_settings(tmp_path)), cap)


def test_check_config_refuses_over_cap_unknown_keys_and_non_get() -> None:
    cap = LoadLimits(vus=50, rps=50, duration_s=600)
    with pytest.raises(LoadRefused, match=r"51 users \(limit 50\)"):
        check_config(_config("http://x", stages=[{"duration_s": 5, "target_vus": 51}]), cap)
    with pytest.raises(LoadRefused, match=r"60 requests a second \(limit 50\)"):
        check_config(_config("http://x", max_rps=60), cap)
    with pytest.raises(LoadRefused, match=r"601 s of load \(limit 600 s\)"):
        check_config(_config("http://x", stages=[{"duration_s": 601, "target_vus": 1}]), cap)
    with pytest.raises(LoadRefused, match="Unknown load settings: headers"):
        check_config({**_config("http://x"), "headers": {"Authorization": "Bearer x"}}, cap)
    with pytest.raises(LoadRefused, match="Only GET"):
        check_config(_config("http://x", targets=[{"path": "/", "weight": 1, "method": "POST"}]), cap)
    with pytest.raises(LoadRefused, match="1–10 pages"):
        check_config(_config("http://x", targets=[{"path": f"/{i}", "weight": 1} for i in range(11)]), cap)


async def test_over_cap_is_refused_before_any_process(
    tmp_path: Path, site: _Site, monkeypatch: pytest.MonkeyPatch
) -> None:
    spawned: list[Any] = []

    async def no_exec(*args: Any, **kwargs: Any) -> Any:
        spawned.append(args)
        raise AssertionError("nothing may be spawned")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_exec)
    gen = _gen(tmp_path, LoadLimits(vus=2, rps=50, duration_s=600))
    with pytest.raises(LoadRefused, match=r"3 users \(limit 2\)"):
        await gen.run(_config(site.origin), tmp_path / "run")
    assert spawned == [] and site.log == []


@needs_node
async def test_generator_refuses_too_when_the_adapter_check_is_bypassed(
    tmp_path: Path, site: _Site, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Defence in depth: the generator applies the hard cap it is given even if the Python check were skipped."""
    import app.automation.loadgen as lg

    monkeypatch.setattr(lg, "check_config", lambda _c, _cap: None)
    gen = _gen(tmp_path, LoadLimits(vus=2, rps=50, duration_s=600))
    with pytest.raises(LoadGeneratorError, match=r"Profile exceeds the platform limit: 3 users \(limit 2\)"):
        await gen.run(_config(site.origin), tmp_path / "run")
    assert site.log == []


@needs_node
async def test_run_streams_progress_with_a_scrubbed_env_and_returns_the_summary(
    tmp_path: Path, site: _Site, monkeypatch: pytest.MonkeyPatch
) -> None:
    for k, v in PLATFORM_SECRETS.items():
        monkeypatch.setenv(k, v)
    captured: dict[str, Any] = {}
    real_exec = asyncio.create_subprocess_exec

    async def spy(*args: Any, **kwargs: Any) -> Any:
        captured["args"], captured["env"] = args, kwargs["env"]
        captured["new_session"] = kwargs.get("start_new_session")
        return await real_exec(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy)
    progress: list[dict[str, Any]] = []

    async def on_progress(line: dict[str, Any]) -> None:
        progress.append(line)

    res = await _gen(tmp_path).run(_config(site.origin), tmp_path / "run", on_progress=on_progress)
    assert res.status == "completed" and res.exit_code == 0 and res.summary is not None
    assert res.summary["overall"]["count"] == len(site.log) > 0
    assert all(line.startswith("GET ") for line in site.log)
    assert len(progress) == 3 and {"t", "users", "rps", "p95_ms", "errors"} <= set(progress[0])
    args = captured["args"]
    assert args[args.index("--max-vus") + 1] == "50" and args[args.index("--max-rps") + 1] == "50"
    assert args[args.index("--max-duration") + 1] == "600"
    assert captured["new_session"] is True
    env = captured["env"]
    assert not set(PLATFORM_SECRETS) & set(env)
    assert all(v not in str(env) for v in PLATFORM_SECRETS.values())
    # Never signed in: no cookie or authorization header ever reached the target.
    assert all("cookie" not in h and "authorization" not in h for h in site.headers)


@needs_node
async def test_stop_ends_the_run_within_two_seconds_with_a_partial_summary(tmp_path: Path, site: _Site) -> None:
    stop = asyncio.Event()
    seen = asyncio.Event()

    async def on_progress(line: dict[str, Any]) -> None:
        if line["t"] >= 2:
            seen.set()

    config = _config(site.origin, stages=[{"duration_s": 1, "target_vus": 2}, {"duration_s": 59, "target_vus": 2}])
    task = asyncio.ensure_future(_gen(tmp_path).run(config, tmp_path / "run", on_progress=on_progress, stop=stop))
    await asyncio.wait_for(seen.wait(), timeout=20)
    asked = time.monotonic()
    stop.set()
    res = await asyncio.wait_for(task, timeout=10)
    assert time.monotonic() - asked <= 2.5
    assert res.status == "stopped" and res.reason == "Stopped by a person"
    assert res.summary is not None and res.summary["overall"]["count"] > 0


@needs_node
@pytest.mark.parametrize("delay_s", [0.0, 0.05, 0.2])
async def test_a_stop_while_the_generator_is_still_starting_is_a_stop_not_a_refusal(
    tmp_path: Path, site: _Site, delay_s: float
) -> None:
    # R3-BUG-01 follow-up: a SIGTERM that lands before the toolkit installs its handlers used to exit 2 via the
    # bin wrapper, which the adapter read as "refused the configuration".
    stop = asyncio.Event()
    config = _config(site.origin, stages=[{"duration_s": 60, "target_vus": 2}])
    task = asyncio.ensure_future(_gen(tmp_path).run(config, tmp_path / f"run-{delay_s}", stop=stop))
    await asyncio.sleep(delay_s)
    stop.set()
    res = await asyncio.wait_for(task, timeout=10)
    assert res.status == "stopped"


@needs_node
async def test_k6_export_is_labelled_and_parses(tmp_path: Path) -> None:
    script = await _gen(tmp_path).export_k6(_config("http://localhost:4100", allowed_hosts=["localhost"]), tmp_path)
    assert "Not run by the platform" in script
    assert 'const BASE = "http://localhost:4100";' in script
    with pytest.raises(LoadRefused):
        await _gen(tmp_path, LoadLimits(vus=1, rps=1, duration_s=1)).export_k6(_config("http://x"), tmp_path)
