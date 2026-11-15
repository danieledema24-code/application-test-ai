"""Standalone Playwright project export (P4-10, design P4 §6.2 "Use the scripts outside this app").

The zip holds the runnable scripts of one bundle (valid, and approved in review when AI-written), the page objects
and platform files the scripts import, a `package.json` (`test`, `test:smoke`, `test:regression`), a `.env.example`,
a README that lists every script left out and why, and CI templates for GitHub Actions and GitLab CI. Nothing secret
is ever written: test credentials and allowed hosts are environment variables the README, `.env.example` and CI
templates name but never fill in.

The exported `playwright.config.ts` is the bundle's platform config with a short preamble so a local run behaves like
a platform run: it reads a `.env` file if there is one (values already in the environment win), retries a failed test
once and never retries specs that may pay or delete (decision D9), and records no trace in specs that sign in.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlsplit

from app.api.errors import AppError
from app.db.models import AutomationAsset, AutomationScript
from app.domain.enums import ScriptStatus
from app.security.ssrf import is_loopback_ip, parse_ip_literal

PLAYWRIGHT_VERSION = "1.65.0"
TYPESCRIPT_VERSION = "5.9.3"
# Platform files a run needs but an export never does (live view and the platform's progress reporter).
PLATFORM_ONLY = frozenset({"live.ts", "progress.ts"})
# Toolkit default; the export keeps Node 22 so `fixtures.ts` type-strips the same way in CI.
NODE_VERSION = "22"

# Zip size cap (roadmap P4-10 "Zip safety").
MAX_ZIP_BYTES = 20 * 1024 * 1024
RETRIES = 1  # decision D9, as on the platform

LEFT_OUT_REASON = {
    "invalid": "can't run: it failed its checks",
    "guard_failed": "can't run: it failed its safety or TypeScript check again when the export was made",
    "not_checked": "not checked yet",
    "needs_review": "AI-written, waiting for review at Gate 6",
    "rejected": "AI-written, rejected in review",
}


class ExportTooLarge(AppError):
    status_code = 409
    code = "export_too_large"


class ConfigUnexpected(RuntimeError):
    """The bundle's playwright.config.ts doesn't have the line the export preamble is inserted before."""


@dataclass
class SpecInfo:
    """What the export needs to know about one included spec, from its case's possible side effects."""

    no_retry: bool = False  # may pay or delete: run once (decision D9)
    signs_in: bool = False  # needs TEST_USERNAME / TEST_PASSWORD; no trace is recorded


@dataclass
class LeftOut:
    case_key: str
    path: str
    reason: str


@dataclass
class Export:
    file_name: str
    scripts: list[str] = field(default_factory=list)
    left_out: list[LeftOut] = field(default_factory=list)
    data: bytes = b""


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:60] or "project"


def package_json(name: str) -> str:
    pkg = {
        "name": f"{slug(name)}-playwright",
        "private": True,
        "type": "module",
        "engines": {"node": ">=22"},
        "scripts": {
            "test": "playwright test",
            "test:smoke": "playwright test --grep @smoke",
            "test:regression": "playwright test --grep @regression",
            "test:headed": "playwright test --headed",
            "report": "playwright show-report",
            "typecheck": "tsc -p tsconfig.json",
        },
        "devDependencies": {
            "@playwright/test": PLAYWRIGHT_VERSION,
            "@types/node": "^22",
            "typescript": TYPESCRIPT_VERSION,
            "typescript-eslint": "^8",
            "eslint": "^10",
        },
    }
    return json.dumps(pkg, indent=2) + "\n"


CREDENTIALS_SKIP = "Blocked: no test login. Set TEST_USERNAME and TEST_PASSWORD (see README)."
_SKIP_LINES = [
    "// Added by the export: without the test login this test can't sign in, so it is skipped (on the platform it",
    "// is reported as blocked).",
    f"test.skip(!process.env.TEST_USERNAME || !process.env.TEST_PASSWORD, {json.dumps(CREDENTIALS_SKIP)});",
]


def with_credentials_skip(code: str) -> str:
    """Skips a sign-in spec when the test login isn't set (QA L2), so an export run without credentials gives the
    platform's outcome ("blocked") instead of failing at sign-in. Inserted after the imports and `test.use(...)`."""
    lines = code.split("\n")
    at = 0
    for i, line in enumerate(lines):
        if line.startswith(("import ", "test.use(")):
            at = i + 1
    return "\n".join([*lines[:at], *_SKIP_LINES, *lines[at:]])


def is_local(base_url: str | None) -> bool:
    """A loopback target (localhost, 127.0.0.1, ::1): the network policy only allows it with ATA_ALLOW_PRIVATE=true."""
    host = (urlsplit(base_url or "").hostname or "").lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    ip = parse_ip_literal(host)
    return ip is not None and is_loopback_ip(ip)


def env_example(base_url: str | None, signs_in: bool) -> str:
    local = is_local(base_url)
    lines = [
        "# Copy this file to .env and fill it in. playwright.config.ts reads .env; variables already set in the",
        "# environment win. Never commit .env: it can hold the test account's password.",
        "",
        "# The site to test.",
        f"BASE_URL={base_url or 'https://your-site.example'}",
        "",
        "# true only when BASE_URL is on this computer (localhost): the network policy blocks private addresses",
        "# otherwise. Leave it false for a real site.",
        f"ATA_ALLOW_PRIVATE={'true' if local else 'false'}",
        "",
        "# Other hosts the site may load from (comma-separated). Every other host is blocked.",
        "ATA_ALLOWED_HOSTS=",
        "",
        "# The test account, for tests that sign in"
        + (" (some tests in this project do; without both values they are skipped as blocked)." if signs_in else "."),
        "TEST_USERNAME=",
        "TEST_PASSWORD=",
        "",
        f"# Retries per failed test. The platform retries once ({RETRIES}); tests that may pay or delete never retry.",
        f"PW_RETRIES={RETRIES}",
        "",
    ]
    return "\n".join(lines)


CONFIG_ANCHOR = "const env = process.env;"


def export_config(platform_config: str, specs: dict[str, SpecInfo]) -> str:
    """The bundle's platform config with the export preamble inserted before it reads the environment."""
    if platform_config.count(CONFIG_ANCHOR) != 1:
        raise ConfigUnexpected("playwright.config.ts has no single `const env = process.env;` line")
    no_retry = ",".join(sorted(p for p, i in specs.items() if i.no_retry))
    no_trace = ",".join(sorted(p for p, i in specs.items() if i.signs_in))
    preamble = "\n".join(
        [
            "// Export settings (added by the export, not part of the platform file). A .env file next to this config",
            "// is read first; variables already set in the environment win. Defaults match a platform run: one",
            "// retry, none for specs that may pay or delete (decision D9), and no trace in specs that sign in.",
            "try {",
            '  process.loadEnvFile(new URL("./.env", import.meta.url));',
            "} catch {",
            "  // No .env file: the environment is used as it is.",
            "}",
            f'process.env.PW_RETRIES ||= "{RETRIES}";',
            f"process.env.ATA_NO_RETRY ??= {json.dumps(no_retry)};",
            f"process.env.ATA_NO_TRACE ??= {json.dumps(no_trace)};",
            "",
        ]
    )
    return platform_config.replace(CONFIG_ANCHOR, preamble + CONFIG_ANCHOR, 1)


GITIGNORE = "node_modules/\ntest-results/\nplaywright-report/\nblob-report/\n.env\n"

GITHUB_WORKFLOW = """\
# Runs the exported Playwright tests on every push and pull request, and on demand.
# Set BASE_URL as a repository variable. If any test signs in, add TEST_USERNAME and TEST_PASSWORD as secrets.
name: Playwright tests

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      BASE_URL: ${{ vars.BASE_URL }}
      ATA_ALLOWED_HOSTS: ${{ vars.ATA_ALLOWED_HOSTS }}
      TEST_USERNAME: ${{ secrets.TEST_USERNAME }}
      TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
      PW_RETRIES: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "%(node)s"
      - run: npm install
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
"""

GITLAB_CI = """\
# Runs the exported Playwright tests in GitLab CI.
# Set BASE_URL as a CI/CD variable. If any test signs in, add TEST_USERNAME and TEST_PASSWORD as masked variables.
stages:
  - test

playwright:
  stage: test
  image: mcr.microsoft.com/playwright:v%(pw)s-noble
  variables:
    PW_RETRIES: "1"
  script:
    - npm install
    - npx playwright test
  artifacts:
    when: always
    expire_in: 14 days
    paths:
      - playwright-report/
"""


def readme(
    project_name: str,
    base_url: str | None,
    version: int,
    scripts: list[str],
    left_out: list[LeftOut],
    at: datetime,
    *,
    sign_in: list[str] | None = None,
    no_retry: list[str] | None = None,
) -> str:
    local = is_local(base_url)
    site = base_url or "https://your-site.example"
    one_line = f"{'ATA_ALLOW_PRIVATE=true ' if local else ''}BASE_URL={site} npx playwright test"
    lines = [
        f"# {project_name}: Playwright tests",
        "",
        f"Exported from scripts version {version} on {at:%d %b %Y}. {len(scripts)} test(s) included.",
        "",
        "## Run the tests",
        "",
        "```sh",
        "npm install",
        "npx playwright install chromium",
        one_line,
        "```",
        "",
        "Or keep the settings in a file: copy `.env.example` to `.env`, fill it in, and run `npm test`.",
        "",
        "- `npm test`: every test",
        "- `npm run test:smoke`: tests tagged `@smoke`",
        "- `npm run test:regression`: tests tagged `@regression`",
        "- `npm run report`: open the HTML report of the last run",
        "",
    ]
    if local:
        lines += [
            f"`{site}` is on this computer, so `ATA_ALLOW_PRIVATE=true` is needed: without it the network policy",
            "blocks every request to it (`BLOCKED by policy … (Private network address)`).",
            "",
        ]
    lines += [
        "## Settings",
        "",
        "All settings come from environment variables or a `.env` file. None are stored in this project.",
        "",
        "| Variable | What it does |",
        "| --- | --- |",
        "| `BASE_URL` | The site to test. Required. |",
        "| `TEST_USERNAME`, `TEST_PASSWORD` | The test account, for tests that sign in. Keep them in your CI secrets. |",
        "| `ATA_ALLOW_PRIVATE` | `true` lets the tests reach a site on this computer (localhost) only. Default `false`: "
        "private network addresses are blocked. |",
        "| `ATA_ALLOWED_HOSTS` | Other hosts the site may load from (comma-separated). Every other host is blocked. |",
        "| `ATA_BROWSERS` | `chromium` (default), `firefox`, `webkit`, comma-separated. |",
        "| `ATA_VIEWPORTS` | Screen sizes such as `1440x900,390x844`. Default `1440x900`. |",
        f"| `PW_RETRIES` | Retries per failed test. Default {RETRIES}, as on the platform. |",
        "",
        "## What the tests can reach",
        "",
        "`policy.ts` checks every request a test makes. Only `BASE_URL` and `ATA_ALLOWED_HOSTS` are allowed; cloud",
        "metadata and private network addresses are always blocked (localhost too, unless `ATA_ALLOW_PRIVATE=true`).",
        "",
    ]
    if sign_in:
        lines += [
            "## Tests that sign in",
            "",
            "These need `TEST_USERNAME` and `TEST_PASSWORD`. Without both, they are **skipped** with the message",
            f'"{CREDENTIALS_SKIP}", as the platform reports them as blocked when no test login is',
            "saved. No trace is recorded for them, so the password never ends up in a trace file:",
            "",
            *[f"- `{p}`" for p in sign_in],
            "",
        ]
    if no_retry:
        lines += [
            "## Tests that never retry",
            "",
            "These may pay for something or delete something, so they run once even when `PW_RETRIES` is set:",
            "",
            *[f"- `{p}`" for p in no_retry],
            "",
        ]
    lines += [
        "## CI",
        "",
        "- GitHub Actions: `.github/workflows/playwright.yml`",
        "- GitLab CI: `.gitlab-ci.yml`",
        "",
        "Both install the project, run every test and keep the HTML report.",
        "",
        "## Tests left out",
        "",
    ]
    if left_out:
        lines.append("These test cases have a script that can't be used yet, so it isn't in this project:")
        lines.append("")
        lines.extend(f"- {x.case_key} (`{x.path}`): {x.reason}" for x in left_out)
    else:
        lines.append("None. Every script in this version is included.")
    lines.append("")
    return "\n".join(lines)


def build(
    *,
    project_name: str,
    host: str,
    base_url: str | None,
    version: int,
    scripts: list[tuple[AutomationScript, str, str]],
    assets: list[AutomationAsset],
    at: datetime,
    specs: dict[str, SpecInfo] | None = None,
    failed_recheck: set[str] | None = None,
    max_bytes: int = MAX_ZIP_BYTES,
) -> Export:
    """`scripts` holds (script, case key, state) per case, already resolved to the script that would run (a rejected
    AI script is replaced by its rules fallback before this is called). Outdated scripts are not passed in.
    `specs` describes each included spec's side effects; `failed_recheck` holds the paths that failed the guard or
    TypeScript re-check just before zipping (they are left out and listed). Raises ExportTooLarge over `max_bytes`."""
    specs = specs or {}
    bad = failed_recheck or set()
    files: dict[str, str] = {}
    included: list[str] = []
    paths: list[str] = []
    left: list[LeftOut] = []
    for script, key, state in scripts:
        if state == "valid" and script.status == ScriptStatus.valid and script.path in bad:
            left.append(LeftOut(key, script.path, LEFT_OUT_REASON["guard_failed"]))
        elif state == "valid" and script.status == ScriptStatus.valid:
            files[script.path] = script.code
            included.append(key)
            paths.append(script.path)
        else:
            left.append(LeftOut(key, script.path, LEFT_OUT_REASON.get(state, "can't run")))
    used = {p: specs.get(p, SpecInfo()) for p in paths}
    for p in paths:
        if used[p].signs_in:
            files[p] = with_credentials_skip(files[p])
    for a in assets:
        if a.path in PLATFORM_ONLY:
            continue
        files.setdefault(a.path, export_config(a.code, used) if a.path == "playwright.config.ts" else a.code)
    sign_in = sorted(p for p, i in used.items() if i.signs_in)
    no_retry = sorted(p for p, i in used.items() if i.no_retry)
    root = f"{host}-playwright-v{version}"
    files["package.json"] = package_json(project_name)
    files[".gitignore"] = GITIGNORE
    files[".env.example"] = env_example(base_url, bool(sign_in))
    files["README.md"] = readme(project_name, base_url, version, included, left, at, sign_in=sign_in, no_retry=no_retry)
    files[".github/workflows/playwright.yml"] = GITHUB_WORKFLOW % {"node": NODE_VERSION}
    files[".gitlab-ci.yml"] = GITLAB_CI % {"pw": PLAYWRIGHT_VERSION}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(files):
            info = zipfile.ZipInfo(f"{root}/{path}", date_time=at.timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[path])
    data = buf.getvalue()
    if len(data) > max_bytes:
        raise ExportTooLarge(
            f"The Playwright project would be {len(data) / 1024 / 1024:.1f} MB, over the "
            f"{max_bytes // 1024 // 1024} MB export limit. Nothing was downloaded.",
            details={"size_bytes": len(data), "limit_bytes": max_bytes},
        )
    return Export(file_name=f"{root}.zip", scripts=included, left_out=left, data=data)
