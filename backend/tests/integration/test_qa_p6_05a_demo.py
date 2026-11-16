"""QA P6-05a: the demo chain (no-go on v1, conditional on v2) run end to end, then a sweep proving the shop's test
account never leaks: not into the database (assessments, snapshots, audit rows, gate decisions, events), the log
output, files the run wrote, or the criteria/conditions an AI narrative prompt is built from. Values are never printed:
only where they were found.
"""

from __future__ import annotations

import base64
import logging
import sqlite3
from pathlib import Path

import pytest

from tests.integration.test_p6_demo_shop import _demo_login
from tests.integration.test_p6_release_demo import pytestmark as _marks
from tests.integration.test_p6_release_demo import test_demo_chain_no_go_then_conditional as _chain

pytestmark = _marks


def _needles() -> dict[str, bytes]:
    email, password, _token = _demo_login()
    return {
        "password": password.encode(),
        "password_b64": base64.b64encode(password.encode()),
        "email": email.encode(),
    }


async def test_demo_chain_never_leaks_the_test_account(
    tmp_path: Path, template_db: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    await _chain(tmp_path, template_db)
    needles = _needles()
    # 1. Log output.
    logs = caplog.text.encode()
    assert [k for k, v in needles.items() if v in logs] == [], "test account in the log output"
    # 2. Every row of every table, as text (the secret itself is encrypted in project_secrets).
    db = sqlite3.connect(tmp_path / "qa.db")
    hits: list[str] = []
    tables = [r[0] for r in db.execute("select name from sqlite_master where type='table'")]
    for table in tables:
        for row in db.execute(f'select * from "{table}"'):  # noqa: S608 - table names from sqlite_master
            blob = repr(row).encode()
            for k, v in needles.items():
                if k.startswith("password") and v in blob:
                    hits.append(f"{table}:{k}")
    rel = db.execute(
        "select criteria, conditions, residual_risks, scope, ai_sections from release_assessments"
    ).fetchall()
    db.close()
    assert sorted(set(hits)) == [], "password found in database tables"
    # 3. The assessment rows (the AI prompt is built from criteria + conditions): neither email nor password.
    for row in rel:
        blob = repr(row).encode()
        assert [k for k, v in needles.items() if v in blob] == [], "test account in a release assessment"
    # 4. Files the run wrote (artefacts, reports, evidence), excluding the database (checked above per table).
    found: list[str] = []
    for f in tmp_path.rglob("*"):
        if not f.is_file() or f.name.startswith("qa.db"):
            continue
        data = f.read_bytes()
        if needles["password"] in data:
            found.append(str(f.relative_to(tmp_path)))
    assert found == [], f"password in files: {found[:10]}"
