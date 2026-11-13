"""Separate worker process: `uv run python -m app.worker` (set WORKER_MODE=separate on the API)."""

from __future__ import annotations

import asyncio
import contextlib
import signal

from app.config import get_settings
from app.context import build_context
from app.logging import configure_logging
from app.orchestrator.orchestrator import Orchestrator
from app.queue.runner import Worker


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    ctx = build_context(settings)
    orch = Orchestrator(ctx)
    worker = Worker(ctx, orch.run_job, on_interrupted=orch.on_job_interrupted, mode="separate")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)
    await worker.start()
    await stop.wait()
    await worker.stop()
    await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
