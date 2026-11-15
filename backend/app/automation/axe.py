"""axe-core for accessibility checks (P5-02): vendored through the automation toolkit, never fetched at runtime.

`axe-core` is pinned in `automation/package.json`. The browser worker reads `axe.min.js` from
`automation/node_modules/axe-core` and runs it with `page.evaluate` (not a script tag, so the target's CSP doesn't
block it and `bypass_csp` stays off). Before use, the installed package must be the version `package-lock.json`
pins; the file's sha256 is recorded on every scan. A missing or mismatched install is reported as unavailable
(`GET /health.tools.axe` = null), never replaced by a CDN copy.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)
TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]


@dataclass(frozen=True)
class AxeScript:
    version: str
    sha256: str
    source: str


_cache: dict[Path, AxeScript | None] = {}


def load_axe(automation_dir: Path) -> AxeScript | None:
    """The pinned axe-core script, or None when it isn't installed as the lock file pins it (cached per process)."""
    if automation_dir in _cache:
        return _cache[automation_dir]
    _cache[automation_dir] = found = _load(automation_dir)
    return found


def _load(automation_dir: Path) -> AxeScript | None:
    pkg_dir = automation_dir / "node_modules" / "axe-core"
    try:
        installed = json.loads((pkg_dir / "package.json").read_text())["version"]
        lock = json.loads((automation_dir / "package-lock.json").read_text())
        pinned = lock["packages"]["node_modules/axe-core"]["version"]
        source = (pkg_dir / "axe.min.js").read_text(encoding="utf-8")
    except (OSError, KeyError, ValueError):
        log.warning("axe-core is not installed in %s", automation_dir)
        return None
    if installed != pinned:
        log.warning("axe-core %s is installed but package-lock.json pins %s", installed, pinned)
        return None
    return AxeScript(version=str(installed), sha256=hashlib.sha256(source.encode()).hexdigest(), source=source)
