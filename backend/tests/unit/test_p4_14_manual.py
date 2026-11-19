"""P4-14a pure rules: upload type sniffing, the redaction of people's text, release evidence for results recorded by
hand (D40) and the Test Execution Report's "Not automated" wording."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.agents.reporting.phase4_reports import _manual_text, _need_person
from app.api.errors import ValidationFailed
from app.domain.enums import EvidenceKind
from app.domain.release import criteria as rc
from app.services import manual


@pytest.mark.parametrize(
    ("data", "mime", "kind"),
    [
        (b"\x89PNG\r\n\x1a\n....", "image/png", EvidenceKind.screenshot),
        (b"\xff\xd8\xff\xe0....", "image/jpeg", EvidenceKind.screenshot),
        (b"%PDF-1.7\n", "application/pdf", EvidenceKind.document_file),
    ],
)
def test_sniff_accepts_png_jpeg_and_pdf_by_content(data: bytes, mime: str, kind: EvidenceKind) -> None:
    got_mime, got_kind, _ext = manual.sniff(data)
    assert (got_mime, got_kind) == (mime, kind)


@pytest.mark.parametrize("data", [b"<!doctype html><p>hi</p>", b"GIF89a....", b"PK\x03\x04", b"", b"\x89PN"])
def test_sniff_refuses_everything_else(data: bytes) -> None:
    with pytest.raises(ValidationFailed) as exc:
        manual.sniff(data)
    assert exc.value.message == "This file type isn't supported. Use PNG, JPEG or PDF."


def test_people_text_is_trimmed_capped_and_redacted() -> None:
    text = "  Signed in as qa@shop.test with Hunter-2-pass and Bearer abcdefghijklmnop " + "x" * 3000
    out = manual._clean(text, ["qa@shop.test", "Hunter-2-pass"])
    assert "qa@shop.test" not in out and "Hunter-2-pass" not in out and "abcdefghijklmnop" not in out
    assert out.startswith("Signed in as [REDACTED]") and len(out) == manual.MAX_TEXT


def _snap(recorded_by: str | None) -> rc.Snapshot:
    snap = rc.Snapshot(assessed_at=datetime(2026, 11, 19, tzinfo=UTC))
    snap.requirements = {"r1": rc.Requirement("r1", "REQ-0001")}
    snap.cases = [rc.Case("c1", "TC-0027", ("r1",), result="passed", run_key="RUN-0005", recorded_by=recorded_by)]
    snap.risks = [rc.Risk("RISK-001", "Sign-in leaks", "high", requirement_lineages=("r1",))]
    return snap


def test_high_risk_evidence_names_who_recorded_a_manual_pass() -> None:
    by_hand = rc.high_risk_tested(_snap("J. Tester"))
    assert by_hand.status == rc.MET
    assert by_hand.detail.endswith("RISK-001 (TC-0027 by hand, recorded by J. Tester)")
    automated = rc.high_risk_tested(_snap(None))
    assert automated.status == rc.MET and automated.detail.endswith("RISK-001 (TC-0027)")


def test_not_automated_wording() -> None:
    assert _need_person([]) is None
    rows = [{"recorded": True}, {"recorded": False}, {"recorded": False}]
    assert _need_person(rows) == "3 approved test cases need a person; 2 have no recorded result."
    assert _need_person([{"recorded": False}]) == "1 approved test case needs a person; 1 has no recorded result."
    got = {"status": "passed", "run_key": "RUN-0005", "recorded_by": "J. Tester", "at": "2026-11-19T15:40:00+00:00"}
    assert _manual_text(got) == "Passed · RUN-0005 · J. Tester, 19 Nov"
