"""Playwright project export (P4-10, QA P4-BUG-02): the README command works against a local target, `.env.example`
and the suite scripts are present, retries default to the platform's (none for specs that may pay or delete), a spec
that fails the re-check before zipping is left out and listed, and the 20 MB cap gives a clear error."""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import UTC, datetime
from typing import Any

import pytest

from app.db.models import AutomationAsset, AutomationScript
from app.domain.enums import AssetKind, ScriptGeneratedBy, ScriptStatus
from app.services import automation_export as xport

AT = datetime(2026, 11, 14, 9, 0, tzinfo=UTC)
CONFIG = (
    'import { defineConfig } from "@playwright/test";\n\nconst env = process.env;\nexport default defineConfig({});\n'
)


def _script(path: str, code: str = "test('x', async () => {});\n") -> AutomationScript:
    return AutomationScript(id=uuid.uuid4(), path=path, code=code, status=ScriptStatus.valid)


def _asset(path: str, code: str) -> AutomationAsset:
    return AutomationAsset(path=path, code=code, kind=AssetKind.config, generated_by=ScriptGeneratedBy.platform)


def _build(base_url: str = "http://localhost:4100", **kw: Any) -> tuple[xport.Export, dict[str, str]]:
    scripts = kw.pop(
        "scripts",
        [
            (_script("tests/contact/TC-0006.spec.ts"), "TC-0006", "valid"),
            (_script("tests/checkout/TC-0010.spec.ts"), "TC-0010", "valid"),
            (_script("tests/sign-in/TC-0020.spec.ts"), "TC-0020", "valid"),
        ],
    )
    exp = xport.build(
        project_name="Demo shop",
        host="localhost",
        base_url=base_url,
        version=2,
        scripts=scripts,
        assets=[_asset("playwright.config.ts", CONFIG)],
        at=AT,
        **kw,
    )
    z = zipfile.ZipFile(io.BytesIO(exp.data))
    root = "localhost-playwright-v2/"
    return exp, {n.removeprefix(root): z.read(n).decode() for n in z.namelist()}


SPECS = {
    "tests/checkout/TC-0010.spec.ts": xport.SpecInfo(no_retry=True),
    "tests/sign-in/TC-0020.spec.ts": xport.SpecInfo(signs_in=True),
}


def test_local_target_readme_command_and_env_example_allow_private() -> None:
    _exp, files = _build(specs=SPECS)
    readme = files["README.md"]
    assert "ATA_ALLOW_PRIVATE=true BASE_URL=http://localhost:4100 npx playwright test" in readme
    assert "| `ATA_ALLOW_PRIVATE` |" in readme and "Default 1, as on the platform" in readme
    env = files[".env.example"]
    assert "BASE_URL=http://localhost:4100" in env and "ATA_ALLOW_PRIVATE=true" in env
    assert "TEST_USERNAME=\n" in env and "TEST_PASSWORD=\n" in env and "PW_RETRIES=1" in env
    assert ".env" in files[".gitignore"].splitlines()
    pkg = json.loads(files["package.json"])["scripts"]
    assert pkg["test"] == "playwright test"
    assert pkg["test:smoke"] == "playwright test --grep @smoke"
    assert pkg["test:regression"] == "playwright test --grep @regression"
    # The sign-in and run-once specs are named so nobody is surprised.
    assert "- `tests/sign-in/TC-0020.spec.ts`" in readme and "- `tests/checkout/TC-0010.spec.ts`" in readme


def test_sign_in_specs_skip_without_the_test_login() -> None:
    """QA L2: without TEST_USERNAME/TEST_PASSWORD a sign-in spec is skipped with a clear message (the platform's
    "blocked"), not failed at sign-in. Other specs are untouched."""
    signin = (
        "// TC-0020 v1\n"
        'import { test } from "../../fixtures";\n'
        'import { credentials } from "../../data/factories";\n'
        "\n"
        'test.use({ trace: "off" });\n'
        "\n"
        "test('TC-0020: sign in', async () => {});\n"
    )
    scripts = [
        (_script("tests/contact/TC-0006.spec.ts"), "TC-0006", "valid"),
        (_script("tests/sign-in/TC-0020.spec.ts", signin), "TC-0020", "valid"),
    ]
    _exp, files = _build(specs=SPECS, scripts=scripts)
    spec = files["tests/sign-in/TC-0020.spec.ts"].splitlines()
    skip = (
        "test.skip(!process.env.TEST_USERNAME || !process.env.TEST_PASSWORD, "
        '"Blocked: no test login. Set TEST_USERNAME and TEST_PASSWORD (see README).");'
    )
    assert spec.index(skip) > spec.index('test.use({ trace: "off" });')
    assert spec.index(skip) < next(i for i, x in enumerate(spec) if x.startswith("test('TC-0020"))
    assert "test.skip" not in files["tests/contact/TC-0006.spec.ts"]
    readme = files["README.md"]
    assert "they are **skipped** with the message" in readme and xport.CREDENTIALS_SKIP in readme
    assert "skipped as blocked" in files[".env.example"]


def test_real_site_needs_no_private_access() -> None:
    _exp, files = _build("https://shop.example.com")
    assert "BASE_URL=https://shop.example.com npx playwright test" in files["README.md"]
    assert "ATA_ALLOW_PRIVATE=true BASE_URL" not in files["README.md"]
    assert "ATA_ALLOW_PRIVATE=false" in files[".env.example"]
    assert xport.is_local("http://127.0.0.1:4100") and xport.is_local("http://[::1]:8080/")
    assert not xport.is_local("http://10.0.0.5") and not xport.is_local(None)


def test_config_keeps_platform_retries_and_reads_dotenv() -> None:
    _exp, files = _build(specs=SPECS)
    cfg = files["playwright.config.ts"]
    pre, post = cfg.split("const env = process.env;")
    assert 'process.loadEnvFile(new URL("./.env", import.meta.url));' in pre
    assert 'process.env.PW_RETRIES ||= "1";' in pre
    assert 'process.env.ATA_NO_RETRY ??= "tests/checkout/TC-0010.spec.ts";' in pre
    assert 'process.env.ATA_NO_TRACE ??= "tests/sign-in/TC-0020.spec.ts";' in pre
    assert post == CONFIG.split("const env = process.env;")[1]  # the platform file is otherwise unchanged
    with pytest.raises(xport.ConfigUnexpected):
        xport.export_config("export default {};\n", {})


def test_a_spec_failing_the_recheck_is_left_out_and_listed() -> None:
    exp, files = _build(specs=SPECS, failed_recheck={"tests/contact/TC-0006.spec.ts"})
    assert "tests/contact/TC-0006.spec.ts" not in files
    assert exp.scripts == ["TC-0010", "TC-0020"]
    assert [x.case_key for x in exp.left_out] == ["TC-0006"]
    assert (
        "- TC-0006 (`tests/contact/TC-0006.spec.ts`): can't run: it failed its safety or TypeScript check"
        in (files["README.md"])
    )


def test_zip_over_the_cap_is_refused_with_a_clear_error() -> None:
    assert xport.MAX_ZIP_BYTES == 20 * 1024 * 1024
    big = [(_script("tests/a.spec.ts", _noise(3 * 1024 * 1024)), "TC-0001", "valid")]
    with pytest.raises(xport.ExportTooLarge) as err:
        _build(max_bytes=1024 * 1024, scripts=big)
    assert err.value.status_code == 409 and err.value.code == "export_too_large"
    assert err.value.message.endswith("MB, over the 1 MB export limit. Nothing was downloaded.")


def _noise(n: int) -> str:
    import random

    rnd = random.Random(7)
    return "".join(rnd.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(n))
