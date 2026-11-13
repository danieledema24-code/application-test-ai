"""Definition of Ready / Done templates and their coded checks (P2-05).

Templates are parametrised by project facts. Checks never report `met` without data: when the data a check needs
does not exist yet (later phases), the status is `unknown` with a detail saying why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.domain.enums import ReadinessKind, ReadinessScope


@dataclass(frozen=True)
class Template:
    rule_id: str
    kind: ReadinessKind
    scope: ReadinessScope
    text: str
    evaluable_from_phase: int


@dataclass
class Facts:
    """What the checks look at, loaded from rows by the service (`app/services/readiness.py`)."""

    requirements: list[dict[str, Any]] = field(
        default_factory=list
    )  # {id, key, status, category, ac_approved, ac_with_values}
    reachable: bool | None = None
    url_checked_at: str | None = None
    auth_boundary: bool = False
    credentials: bool = False
    credentials_result: str | None = None
    risks: int | None = None  # None = no strategy yet
    reports_ready: list[str] = field(default_factory=list)
    # Phase 3 (None = no test design yet). requirement id -> field label -> "data" | "open_question" | "missing"
    test_data: dict[str, dict[str, str]] | None = None
    # requirement id -> (approved AC keys, approved AC keys covered by a draft/approved case)
    ac_coverage: dict[str, tuple[list[str], list[str]]] | None = None
    # {"stale": bool, "without_case": [REQ keys], "orphans": [TC keys]}
    traceability: dict[str, Any] | None = None


DOR, DOD = ReadinessKind.dor, ReadinessKind.dod
REQ, PROJECT = ReadinessScope.requirement, ReadinessScope.project

_BASE: tuple[Template, ...] = (
    Template("dor.requirement_approved", DOR, REQ, "The requirement is approved", 2),
    Template("dor.approved_ac", DOR, REQ, "The requirement has at least one approved acceptance criterion", 2),
    Template("dor.no_open_questions", DOR, REQ, "No open questions remain (nothing marked Needs info)", 2),
    Template("dor.environment_reachable", DOR, PROJECT, "The test environment is reachable", 2),
    Template("dor.risk_assessed", DOR, PROJECT, "Product risks are assessed in the test strategy", 2),
    Template("dod.ac_covered", DOD, REQ, "Every acceptance criterion is covered by at least one test case", 3),
    Template("dod.traceability_updated", DOD, PROJECT, "The traceability matrix is up to date", 3),
    Template("dod.tests_executed", DOD, REQ, "Tests executed with evidence", 4),
    Template("dod.no_open_high_defects", DOD, PROJECT, "No open critical or high defects", 4),
    Template("dod.report_generated", DOD, PROJECT, "The requirements specification report is generated", 2),
)
_FORM_DATA = Template("dor.test_data_identified", DOR, REQ, "Test data is identified for each form field", 2)
_CREDENTIALS = Template(
    "dor.credentials_available", DOR, PROJECT, "Test credentials available for the signed-in area", 2
)


def templates(*, has_forms: bool, auth_boundary: bool) -> list[Template]:
    out = list(_BASE)
    if has_forms:
        out.insert(3, _FORM_DATA)
    if auth_boundary:
        out.insert(4 if has_forms else 3, _CREDENTIALS)
    return out


LATER_PHASE_DETAIL = {
    "dod.tests_executed": "No test execution exists yet (Phase 4)",
    "dod.no_open_high_defects": "No defect tracking exists yet (Phase 4)",
}

FORM_CATEGORIES = frozenset({"form_input", "validation"})


def _result(status: str, detail: str, evidence: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"status": status, "detail": detail, "evidence": evidence or []}


def evaluate(rule_id: str | None, facts: Facts, *, requirement_id: str | None = None) -> dict[str, Any] | None:
    """Evaluates one criterion. Project-scope evaluation of a requirement criterion summarises approved ones."""
    if rule_id is None:
        return None
    if rule_id in LATER_PHASE_DETAIL:
        return _result("unknown", LATER_PHASE_DETAIL[rule_id])
    reqs = facts.requirements
    if requirement_id is not None:
        reqs = [r for r in reqs if r["id"] == requirement_id]
        if not reqs:
            return _result("not_applicable", "The requirement is not part of the current version")
    elif rule_id in ("dor.approved_ac", "dor.test_data_identified"):
        reqs = [r for r in reqs if r["status"] == "approved"]
    if rule_id == "dor.requirement_approved":
        if requirement_id is not None:
            ok = reqs[0]["status"] == "approved"
            return _result("met" if ok else "not_met", "Approved" if ok else f"Status is {reqs[0]['status']}")
        n = sum(1 for r in reqs if r["status"] == "approved")
        return _result("met" if n else "not_met", f"{n} of {len(reqs)} requirement(s) approved")
    if rule_id == "dor.approved_ac":
        if not reqs:
            return _result("unknown", "No approved requirements yet")
        missing = [r["key"] for r in reqs if not r["ac_approved"]]
        return _result(
            "not_met" if missing else "met",
            f"Without an approved acceptance criterion: {', '.join(missing[:8])}" if missing
            else "Every requirement checked has an approved acceptance criterion",
        )  # fmt: skip
    if rule_id == "dor.no_open_questions":
        open_q = [r["key"] for r in reqs if r["status"] == "needs_info"]
        return _result(
            "not_met" if open_q else "met",
            f"Needs info: {', '.join(open_q[:8])}" if open_q else "No requirement is marked Needs info",
        )
    if rule_id == "dor.test_data_identified":
        forms = [r for r in reqs if r["category"] in FORM_CATEGORIES]
        if not forms:
            return _result("not_applicable", "No form requirement in scope")
        if facts.test_data is not None:
            return _test_data(forms, facts.test_data)
        missing = [r["key"] for r in forms if not r["ac_with_values"]]
        return _result(
            "not_met" if missing else "met",
            f"No test values yet for {', '.join(missing[:8])}"
            if missing
            else "Test values are recorded for form fields",
        )
    if rule_id == "dor.environment_reachable":
        if facts.reachable is None:
            return _result("unknown", "The target URL hasn't been checked yet")
        when = f" (last checked {facts.url_checked_at})" if facts.url_checked_at else ""
        return _result(
            "met" if facts.reachable else "not_met", ("Reachable" if facts.reachable else "Not reachable") + when
        )
    if rule_id == "dor.credentials_available":
        if not facts.auth_boundary:
            return _result("not_applicable", "Discovery found no signed-in area")
        if not facts.credentials:
            return _result("not_met", "No test credentials are saved for this project (Settings, Test credentials)")
        if facts.credentials_result == "failed":
            return _result("not_met", "Test credentials are saved but the last sign-in attempt failed")
        return _result("met", "Test credentials are saved for this project")
    if rule_id == "dor.risk_assessed":
        if facts.risks is None:
            return _result("unknown", "The test strategy hasn't been generated yet")
        return _result("met" if facts.risks else "not_met", f"{facts.risks} risk(s) in the risk register")
    if rule_id == "dod.ac_covered":
        return _ac_covered(reqs, facts, requirement_id is not None)
    if rule_id == "dod.traceability_updated":
        tr = facts.traceability
        if tr is None:
            return _result("unknown", "Test cases haven't been designed yet")
        if tr["stale"]:
            return _result("not_met", "The test design is out of date with the requirements or strategy")
        problems = []
        if tr["without_case"]:
            problems.append(f"Approved requirements without a test case: {', '.join(tr['without_case'][:8])}")
        if tr["orphans"]:
            problems.append(f"Test cases without a requirement: {', '.join(tr['orphans'][:8])}")
        if problems:
            return _result("not_met", "; ".join(problems))
        return _result("met", "Every approved requirement traces to a test case and every case to a requirement")
    if rule_id == "dod.report_generated":
        ok = "requirements_spec" in facts.reports_ready
        return _result("met" if ok else "not_met", "Generated" if ok else "Not generated yet")
    return _result("unknown", "No automatic check for this criterion")


def _test_data(forms: list[dict[str, Any]], data: dict[str, dict[str, str]]) -> dict[str, Any]:
    missing: list[str] = []
    questions: list[str] = []
    ok: list[str] = []
    for r in forms:
        fields = data.get(r["id"], {})
        if not fields:
            missing.append(r["key"])
            continue
        for label, state in fields.items():
            if state == "open_question":
                questions.append(f"{label} ({r['key']} has an open question)")
            elif state == "missing":
                missing.append(f"{label} ({r['key']})")
            elif label not in ok:
                ok.append(label)
    if not missing and not questions:
        return _result("met", f"Test data is identified for {', '.join(ok[:8]) or 'every form field'}")
    parts = []
    if ok:
        parts.append(f"Identified for {', '.join(ok[:8])}")
    if questions:
        parts.append(f"Open question: {', '.join(questions[:8])}")
    if missing:
        parts.append(f"No test data yet for {', '.join(missing[:8])}")
    return _result("not_met", "; ".join(parts))


def _ac_covered(reqs: list[dict[str, Any]], facts: Facts, single: bool) -> dict[str, Any]:
    if facts.ac_coverage is None:
        return _result("unknown", "Test cases haven't been designed yet")
    scope = reqs if single else [r for r in reqs if r["status"] == "approved"]
    total: list[str] = []
    uncovered: list[str] = []
    for r in scope:
        approved, covered = facts.ac_coverage.get(r["id"], ([], []))
        total += approved
        uncovered += [k for k in approved if k not in covered]
    if not total:
        return _result("unknown", "No approved acceptance criteria to cover")
    if uncovered:
        return _result("not_met", f"Not covered by a test case: {', '.join(uncovered[:8])}")
    return _result("met", f"All {len(total)} approved acceptance criteria are covered by a test case")


def stamp(result: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    if result is None:
        return None
    return {"criterion_key": key, **result, "evaluated_at": datetime.now(UTC).isoformat()}
