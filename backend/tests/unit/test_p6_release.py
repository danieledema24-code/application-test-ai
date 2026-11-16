"""P6-05a release readiness rules (decisions D32, D33): exit criteria recognised from their text, each platform check,
the tiered verdict, conditions, residual risk, manual results, the AI narrative guard and G9 override validation.
Pure: snapshots are built here, nothing touches a database."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.api.errors import ValidationFailed
from app.db.models import ReleaseAssessment
from app.domain.enums import Verdict
from app.domain.release import criteria as rc
from app.services import release as svc

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
STRATEGY = [
    "100% of approved acceptance criteria have been executed",
    "No open critical or high defects",
    "95% of executed tests pass",
    "Every high and very high risk has its mitigation tests executed",
]


def full(**changes: Any) -> rc.Snapshot:
    """A snapshot where every criterion is met: two approved cases passed, one high risk tested, all checks clean."""
    snap = rc.Snapshot(
        assessed_at=NOW,
        strategy_version=2,
        exit_criteria=list(STRATEGY),
        requirements={"r1": rc.Requirement("r1", "REQ-0001", ("f1",)), "r2": rc.Requirement("r2", "REQ-0002")},
        acs=[rc.Ac("a1", "AC-0001"), rc.Ac("a2", "AC-0002")],
        cases=[
            rc.Case("c1", "TC-0001", ("r1",), ("a1",), "passed", NOW - timedelta(hours=1), "RUN-0002", "valid", "a.ts"),
            rc.Case("c2", "TC-0002", ("r2",), ("a2",), "passed", NOW - timedelta(hours=1), "RUN-0002", "valid", "b.ts"),
        ],
        defects=[rc.Defect("DEF-0001", "major", "verified")],
        risks=[
            rc.Risk("RISK-001", "Contact form", "high", requirement_lineages=("r1",)),
            rc.Risk("RISK-002", "Catalogue", "low", feature_ids=("f1",)),
        ],
        exploratory_sessions=["EXP-0001"],
        nf={
            "accessibility": {"scan_key": "A11Y-0001", "open": [("A11Y-0001-01", "minor")]},
            "security": {"scan_key": "SEC-0001", "open": [("SEC-0001-01", "low")]},
            "performance": {"run_key": "PERF-0001", "missed": []},
        },
    )
    for k, v in changes.items():
        setattr(snap, k, v)
    return snap


def by_id(criteria: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in criteria}


# ---------------------------------------------------------------- exit criteria from text


@pytest.mark.parametrize(
    ("text", "rule", "value"),
    [
        ("100% of approved acceptance criteria have been executed", "exit.ac_executed", 100.0),
        ("90 % of the approved acceptance criteria are executed", "exit.ac_executed", 90.0),
        ("No open critical or high defects", "exit.no_open_high_defects", None),
        ("Zero open critical/high severity bugs", "exit.no_open_high_defects", None),
        ("No open major defects", "exit.no_open_high_defects", None),
        ("95% of executed tests pass", "exit.pass_rate", 95.0),
        ("Pass rate of at least 97.5%", "exit.pass_rate", 97.5),
        ("Every high and very high risk has its mitigation tests executed", "exit.high_risks_executed", None),
        ("No serious WCAG 2.2 AA accessibility issues", "exit.nf.accessibility", None),
        ("Security headers are present on every page", "exit.nf.security", None),
        ("Response time under load meets the targets", "exit.nf.performance", None),
        ("Stakeholders signed off", None, None),
        ("140% of executed tests pass", None, None),
    ],
)
def test_exit_criteria_are_recognised_from_their_text(text: str, rule: str | None, value: float | None) -> None:
    assert rc.recognise(text) == (rule, value)


def test_every_criterion_met_is_go() -> None:
    crit = rc.evaluate(full())
    assert all(c["status"] == rc.MET for c in crit), [(c["id"], c["status"], c["detail"]) for c in crit]
    assert rc.verdict(crit) == "go" and rc.conditions(crit) == []
    assert rc.reason(crit, "go", 0) == "Every criterion is met by recorded evidence."
    ids = by_id(crit)
    assert {"exit.ac_executed", "exit.no_open_high_defects", "exit.pass_rate", "exit.high_risks_executed"} <= set(ids)
    # The strategy names the defect criterion, so the platform doesn't add its own; it is blocking (D32).
    assert "rr.no_open_high_defects" not in ids and ids["exit.no_open_high_defects"]["blocking"]
    blocking = {c["id"] for c in crit if c["blocking"]}
    assert blocking == {"exit.no_open_high_defects", "rr.impacted_rerun", "rr.high_risk_tested", "rr.g8_pending"}
    assert ids["exit.no_open_high_defects"]["detail"].endswith(rc.HIGH_MEANS)
    assert ids["exit.pass_rate"]["measured"] == {"value": 100.0, "required": 95.0, "numerator": 2, "denominator": 2}


# ---------------------------------------------------------------- each criterion


def test_open_major_defect_is_blocking_no_go_naming_it() -> None:
    snap = full(defects=[rc.Defect("DEF-0001", "major", "confirmed"), rc.Defect("DEF-0002", "critical", "draft")])
    crit = rc.evaluate(snap)
    c = by_id(crit)["exit.no_open_high_defects"]
    # A draft is a hypothesis (waiting at G8), never an open defect.
    assert c["status"] == rc.NOT_MET and c["detail"].startswith("DEF-0001 (major) is open")
    assert [e["key"] for e in c["evidence_refs"]] == ["DEF-0001"]
    assert by_id(crit)["rr.g8_pending"]["status"] == rc.NOT_MET
    assert rc.verdict(crit) == "no_go"
    assert rc.reason(crit, "no_go", 9).startswith("2 blocking criteria aren't met: there is an open major defect")
    alone = rc.evaluate(full(defects=[rc.Defect("DEF-0001", "major", "fixed")]))
    assert rc.reason(alone, "no_go", 1) == "1 blocking criterion isn't met: there is an open major defect (DEF-0001)."


def test_without_the_strategy_criterion_the_platform_checks_defects() -> None:
    crit = by_id(rc.evaluate(full(exit_criteria=[], defects=[rc.Defect("DEF-0003", "critical", "confirmed")])))
    assert crit["rr.no_open_high_defects"]["blocking"] and crit["rr.no_open_high_defects"]["status"] == rc.NOT_MET


def test_minor_defect_is_a_condition_not_a_blocker() -> None:
    crit = rc.evaluate(full(defects=[rc.Defect("DEF-0007", "minor", "confirmed")]))
    assert by_id(crit)["rr.open_defects"]["status"] == rc.NOT_MET and rc.verdict(crit) == "conditional"
    assert [x["text"] for x in rc.conditions(crit)] == ["Fix or accept DEF-0007 (minor)"]
    assert rc.reason(crit, "conditional", 1) == "Every blocking criterion is met, but 1 condition remains."


def test_g8_pending_is_blocking() -> None:
    crit = rc.evaluate(full(defects=[rc.Defect("DEF-0004", "minor", "draft")]))
    c = by_id(crit)["rr.g8_pending"]
    assert c["blocking"] and c["status"] == rc.NOT_MET and c["conditions"] == ["Decide DEF-0004 at Gate 8"]
    assert rc.verdict(crit) == "no_go"
    assert rc.reason(crit, "no_go", 1) == "1 blocking criterion isn't met: DEF-0004 is waiting at Gate 8."


def test_impacted_tests_must_be_rerun_since_the_change() -> None:
    assert by_id(rc.evaluate(full()))["rr.impacted_rerun"]["detail"].startswith("No change set since")
    pending = full(change_sets=["CHG-0001"], must=[rc.MustPick("CHG-0001", "c1", "TC-0001", rerun=True),
                                                   rc.MustPick("CHG-0001", "c2", "TC-0002", rerun=False)])  # fmt: skip
    c = by_id(rc.evaluate(pending))["rr.impacted_rerun"]
    assert c["status"] == rc.NOT_MET and c["conditions"] == ["Re-test TC-0002 after CHG-0001"]
    assert c["short"] == "1 impacted test hasn't been re-run since CHG-0001"
    # A must-run test moved to Not included (its page was removed, `was_must`) is reviewed, not re-run.
    moved = full(change_sets=["CHG-0001"], must=[
        rc.MustPick("CHG-0001", "c1", "TC-0001", rerun=True),
        rc.MustPick("CHG-0001", "c9", "TC-0012", excluded_reason="Page removed: review or retire the case (HEAL-0004)"),
    ])  # fmt: skip
    c = by_id(rc.evaluate(moved))["rr.impacted_rerun"]
    assert c["status"] == rc.MET and "TC-0012 (Page removed" in c["detail"] and "Was must run" in c["detail"]
    # A manual must-run test without a recorded re-test (D37) can't be checked: conditional, not no-go.
    manual = full(change_sets=["CHG-0001"], must=[rc.MustPick("CHG-0001", "c1", "TC-0001", rerun=True),
                                                  rc.MustPick("CHG-0001", "c5", "TC-0005", manual=True)])  # fmt: skip
    crits = rc.evaluate(manual)
    c = by_id(crits)["rr.impacted_rerun"]
    assert c["status"] == rc.NOT_EVALUABLE and c["conditions"] == [
        "Re-test TC-0005 by hand after CHG-0001 and record the result (manual test)"
    ]
    assert c["short"] == "1 manual impacted test has no recorded re-test"
    assert rc.verdict(crits) == "conditional"
    # D37: a recorded manual re-test counts like an automated result (passed or failed).
    recorded = full(change_sets=["CHG-0001"], must=[
        rc.MustPick("CHG-0001", "c1", "TC-0001", rerun=True),
        rc.MustPick("CHG-0001", "c5", "TC-0005", rerun=True, manual=True, manual_result="failed",
                    manual_note="No confirmation shown"),
    ])  # fmt: skip
    crits = rc.evaluate(recorded)
    c = by_id(crits)["rr.impacted_rerun"]
    assert c["status"] == rc.MET and c["detail"].endswith("Re-tested by hand: TC-0005 (failed).")
    # ... but a failed manual re-test is never "fine": a (non-blocking) condition with the test and the note.
    m = by_id(crits)["rr.manual_retests"]
    assert (m["status"], m["blocking"]) == (rc.NOT_MET, False)
    assert m["conditions"] == [
        "TC-0005 failed when re-tested by hand after CHG-0001: 'No confirmation shown'. Fix it or raise a defect"
    ]
    assert rc.verdict(crits) == "conditional" and m["conditions"][0] in [x["text"] for x in rc.conditions(crits)]
    # Linked to an open major defect: the defect criterion already blocks.
    blocked = replace(recorded, defects=[*recorded.defects, rc.Defect("DEF-0009", "major", "confirmed")])
    crits = rc.evaluate(blocked)
    assert rc.verdict(crits) == "no_go" and by_id(crits)["rr.manual_retests"]["status"] == rc.NOT_MET
    passed = full(change_sets=["CHG-0001"], must=[
        rc.MustPick("CHG-0001", "c5", "TC-0005", rerun=True, manual=True, manual_result="passed", manual_note="ok"),
    ])  # fmt: skip
    crits = rc.evaluate(passed)
    assert by_id(crits)["rr.manual_retests"]["detail"] == "Manual re-tests passed: TC-0005"
    assert rc.verdict(crits) == "go"
    both = full(change_sets=["CHG-0001"], must=[rc.MustPick("CHG-0001", "c2", "TC-0002"),
                                                rc.MustPick("CHG-0001", "c5", "TC-0005", manual=True)])  # fmt: skip
    c = by_id(rc.evaluate(both))["rr.impacted_rerun"]
    assert c["status"] == rc.NOT_MET and c["conditions"] == ["Re-test TC-0002 after CHG-0001"]


def test_outdated_scripts_and_open_change_items_are_conditions() -> None:
    cases = list(full().cases)
    cases[1] = rc.Case("c2", "TC-0002", ("r2",), ("a2",), "passed", NOW, "RUN-0002", "outdated", "tests/b.spec.ts")
    items = [
        rc.OpenItem("review", "TC-0012", "Page removed: /products/1. Review or retire TC-0012 (CHG-0001)"),
        rc.OpenItem("gap", "CHG-0001", "Not covered by any requirement: page /offers added (CHG-0001)"),
        rc.OpenItem("case_review", "HEAL-0004", "Review TC-0012: test case needs review (HEAL-0004) (CHG-0001)"),
        rc.OpenItem("repair", "HEAL-0003", "Accept or reject HEAL-0003 (ContactPage.ts: x) (CHG-0001)"),
    ]
    crit = rc.evaluate(full(cases=cases, open_items=items))
    ids = by_id(crit)
    assert ids["rr.outdated_scripts"]["status"] == rc.NOT_MET
    assert ids["rr.impact_reviewed"]["status"] == rc.NOT_MET and len(ids["rr.impact_reviewed"]["conditions"]) == 4
    assert "1 test case needs review" in ids["rr.impact_reviewed"]["detail"]
    assert rc.verdict(crit) == "conditional"
    texts = [x["text"] for x in rc.conditions(crit)]
    assert texts[0] == "Repair or regenerate the script of TC-0002 (tests/b.spec.ts)" and items[0].text in texts


def test_every_high_risk_needs_a_passing_linked_test() -> None:
    assert by_id(rc.evaluate(full(risks=None)))["rr.high_risk_tested"]["status"] == rc.NOT_EVALUABLE
    assert by_id(rc.evaluate(full(risks=[])))["rr.high_risk_tested"]["detail"] == "No open high or very high risk"
    cases = list(full().cases)
    cases[0] = rc.Case("c1", "TC-0001", ("r1",), ("a1",), "failed", NOW, "RUN-0002", "valid", "a.ts")
    crit = rc.evaluate(full(cases=cases))
    c = by_id(crit)["rr.high_risk_tested"]
    assert c["status"] == rc.NOT_MET and c["detail"] == "RISK-001 (high): TC-0001 failed"
    assert c["short"] == "RISK-001 (high) has no passing test" and rc.verdict(crit) == "no_go"
    # "mitigation tests executed" (the strategy's text) counts a failed result as executed.
    assert by_id(crit)["exit.high_risks_executed"]["status"] == rc.MET
    # Linked through a feature; an accepted risk isn't required to be tested.
    via_feature = full(risks=[rc.Risk("RISK-009", "Nav", "very_high", feature_ids=("f1",))])
    assert by_id(rc.evaluate(via_feature))["rr.high_risk_tested"]["status"] == rc.MET
    accepted = full(cases=cases, risks=[rc.Risk("RISK-001", "Contact", "high", "accepted", ("r1",))])
    assert by_id(rc.evaluate(accepted))["rr.high_risk_tested"]["status"] == rc.MET
    unlinked = full(risks=[rc.Risk("RISK-005", "Sign in", "high", requirement_lineages=("zz",))])
    c = by_id(rc.evaluate(unlinked))["rr.high_risk_tested"]
    assert c["conditions"] == ["Add and run a test case for RISK-005 (high)"]


def test_execution_measures_parse_their_percentage() -> None:
    cases = list(full().cases)
    cases[1] = rc.Case("c2", "TC-0002", ("r2",), ("a2",), None, None, None, "valid", "b.ts")
    crit = by_id(rc.evaluate(full(cases=cases)))
    assert crit["exit.ac_executed"]["status"] == rc.NOT_MET
    assert crit["exit.ac_executed"]["detail"].startswith("50 % executed (1 of 2 approved acceptance criteria)")
    assert crit["exit.pass_rate"]["status"] == rc.MET  # 1 of 1 executed passed
    cases[1] = rc.Case("c2", "TC-0002", ("r2",), ("a2",), "flaky", NOW, "RUN-0003", "valid", "b.ts")
    crit = by_id(rc.evaluate(full(cases=cases)))
    assert crit["exit.pass_rate"]["status"] == rc.NOT_MET and crit["exit.pass_rate"]["measured"]["value"] == 50.0
    none_ran = by_id(rc.evaluate(full(cases=[], acs=[])))
    assert none_ran["exit.pass_rate"]["status"] == rc.NOT_EVALUABLE
    assert none_ran["exit.ac_executed"]["status"] == rc.NOT_EVALUABLE


def test_exploratory_and_non_functional_checks() -> None:
    crit = by_id(rc.evaluate(full(exploratory_sessions=[])))
    assert crit["rr.exploratory"]["status"] == rc.NOT_EVALUABLE
    assert crit["rr.exploratory"]["detail"] == "No exploratory session has run"
    crit = by_id(rc.evaluate(full(exploratory_open=[rc.Finding("EXP-0001-01", "medium")])))
    assert crit["rr.exploratory"]["conditions"] == ["Fix or accept EXP-0001-01 (medium)"]
    nf = dict(full().nf)
    nf["accessibility"] = {"scan_key": "A11Y-0001", "open": [("A11Y-0001-02", "serious")]}
    nf["performance"] = {"run_key": "PERF-0002", "missed": ["/products/2 p95 1.2 s (threshold 800 ms)"]}
    c = by_id(rc.evaluate(full(nf=nf)))["rr.nf"]
    assert c["status"] == rc.NOT_MET
    assert c["conditions"] == [
        "Fix or accept A11Y-0001-02 (serious)",
        "Meet the load-test thresholds missed in PERF-0002: /products/2 p95 1.2 s (threshold 800 ms)",
    ]
    c = by_id(rc.evaluate(full(nf={"accessibility": None, "security": None, "performance": None})))["rr.nf"]
    assert c["status"] == rc.NOT_EVALUABLE and "Run a load test" in c["conditions"]


# ---------------------------------------------------------------- tiering (D32), manual results


def test_tiering() -> None:
    assert rc.verdict([{"blocking": True, "status": rc.NOT_MET}, {"blocking": False, "status": rc.MET}]) == "no_go"
    assert (
        rc.verdict([{"blocking": False, "status": rc.NOT_MET}, {"blocking": True, "status": rc.MET}]) == "conditional"
    )
    assert rc.verdict([{"blocking": False, "status": rc.NOT_EVALUABLE}]) == "conditional"
    # A blocking criterion that can't be evaluated never yields go.
    assert rc.verdict([{"blocking": True, "status": rc.NOT_EVALUABLE}, {"blocking": False, "status": rc.MET}]) == (
        "conditional"
    )
    crit = rc.evaluate(full(risks=None))
    assert rc.verdict(crit) == "conditional"
    assert rc.reason(crit, "conditional", 1).startswith("Every high risk tested and passing can't be checked")


def test_unrecognised_criterion_is_not_evaluable_until_a_person_confirms_it() -> None:
    snap = full(exit_criteria=[*STRATEGY, "Stakeholders signed off"])
    crit = rc.evaluate(snap)
    c = by_id(crit)["exit.text.5"]
    assert c["status"] == rc.NOT_EVALUABLE and c["detail"] == rc.CANT_CHECK and c["confirmable"]
    assert rc.verdict(crit) == "conditional" and rc.conditions(crit)[0]["text"] == "Confirm: Stakeholders signed off"
    rc.apply_manual(c, rc.Manual("met", "Signed off in the release meeting", "M. Member", "u1"))
    assert (
        c["status"] == rc.MET
        and c["manual"]
        and c["detail"] == "Confirmed by M. Member: 'Signed off in the release meeting'"
    )
    verdict, conds, sentence = rc.recompute(crit)
    assert (verdict, conds, sentence) == ("go", [], "Every criterion is met by recorded evidence.")
    rc.apply_manual(c, rc.Manual("not_met", "Legal hasn't signed", "M. Member"))
    assert rc.recompute(crit)[0] == "conditional"
    # Manual results come back on re-evaluation; platform checks are never confirmable.
    again = rc.evaluate(full(exit_criteria=[*STRATEGY, "Stakeholders signed off"],
                             manual={"exit.text.5": rc.Manual("met", "ok", "M. Member")}))  # fmt: skip
    assert by_id(again)["exit.text.5"]["status"] == rc.MET
    assert not any(x["confirmable"] for x in again if x["source"] == "platform")


def test_no_approved_strategy_is_never_go() -> None:
    crit = rc.evaluate(full(strategy_version=None, exit_criteria=[]))
    assert by_id(crit)["rr.strategy"]["status"] == rc.NOT_EVALUABLE and rc.verdict(crit) == "conditional"


def test_definition_of_done_results_are_criteria() -> None:
    dod = [
        rc.DodResult("DOD-01", "Every acceptance criterion is covered by at least one test case", "met", "All 2",
                     "dod.ac_covered"),
        rc.DodResult("DOD-02", "No open critical or high defects", "met", "x", "dod.no_open_high_defects"),
        rc.DodResult("DOD-03", "The release notes are written", "unknown", "No automatic check for this criterion"),
    ]  # fmt: skip
    crit = by_id(rc.evaluate(full(dod=dod)))
    assert crit["dod.DOD-01"]["status"] == rc.MET and crit["dod.DOD-01"]["source"] == "dod"
    assert "dod.DOD-02" not in crit  # the blocking defect criterion covers it
    assert crit["dod.DOD-03"]["status"] == rc.NOT_EVALUABLE and crit["dod.DOD-03"]["confirmable"]
    assert crit["dod.DOD-03"]["detail"] == rc.CANT_CHECK


# ---------------------------------------------------------------- residual risk


def test_residual_risk() -> None:
    change = NOW - timedelta(hours=2)
    cases = [
        rc.Case("c1", "TC-0001", ("r1",), (), "passed", NOW - timedelta(hours=1)),
        rc.Case("c2", "TC-0002", ("r1",), (), None, None),
        rc.Case("c3", "TC-0003", ("r2",), (), "passed", NOW - timedelta(hours=1)),
        rc.Case("c4", "TC-0004", ("r3",), (), "failed", NOW - timedelta(hours=1)),
        rc.Case("c5", "TC-0005", ("r4",), (), "passed", NOW - timedelta(hours=5)),
    ]
    risks = [
        rc.Risk("RISK-001", "Some passed", "high", requirement_lineages=("r1",)),
        rc.Risk("RISK-002", "All passed", "very_high", requirement_lineages=("r2",)),
        rc.Risk("RISK-003", "Failed", "high", requirement_lineages=("r3",)),
        rc.Risk("RISK-004", "Passed before the change", "medium", requirement_lineages=("r4",)),
        rc.Risk("RISK-005", "Accepted", "high", "accepted", ("r9",), comment="Out of scope", accepted_by="A. Approver"),
    ]
    rows, overall = rc.residual(full(cases=cases, risks=risks, latest_change_at=change))
    got = {r["risk"]["key"]: (r["initial"], r["residual"], r["line"]) for r in rows}
    assert got["RISK-001"] == ("high", "medium", "Reduced: some tests passed, none failed")
    assert got["RISK-002"] == ("very_high", "low", "Mitigated by testing: all 1 linked test passed")
    assert got["RISK-003"][1] == "high" and got["RISK-003"][2].startswith("Not reduced: 1 test failed (TC-0004)")
    assert got["RISK-004"] == ("medium", "medium", "Not reduced: 1 test not tested since the change (TC-0005)")
    assert got["RISK-005"] == ("high", "high", "Accepted by A. Approver: 'Out of scope'")
    assert rows[0]["risk"]["key"] == "RISK-003"  # failed or untested high risks first
    assert overall == "high"
    assert rc.residual(full(risks=None)) == ([], None)


# ---------------------------------------------------------------- the AI narrative may explain, never decide


def test_ai_narrative_guard() -> None:
    assert (
        rc.check_narrative("The release is {verdict}: {conditions} things still need a person.", "conditional") is None
    )
    assert "number" in str(rc.check_narrative("There are 3 conditions left before this can ship.", "conditional"))
    assert "placeholder" in str(rc.check_narrative("There are {defects} open defects to look at now.", "no_go"))
    why = rc.check_narrative("Everything looks fine, the product is ready to release today.", "no_go")
    assert why is not None and "Go" in why
    assert rc.check_narrative("This is a conditional release with {conditions} conditions.", "go") is not None
    assert rc.check_narrative("This is a no-go until the blocking criteria are met.", "conditional") is not None
    assert (
        rc.check_narrative("This is a no-go until the {blocking_not_met} blocking criteria are met.", "no_go") is None
    )
    # Release-action language (QA P6-05a): allowed on Go, or when the clause holds it back; never "ignore the items".
    for text, verdict in (
        ("Every criterion is met, so the team can ship this release with confidence.", "go"),
        ("The release is approved by the rules; proceed if the people deciding agree.", "go"),
        ("The build should not ship until the {blocking_not_met} blocking criterion is fixed.", "no_go"),
        ("The release can go ahead once the {conditions} conditions are accepted.", "conditional"),
        ("Deal with the {conditions} conditions before the release goes ahead.", "conditional"),
    ):
        assert rc.check_narrative(text, verdict) is None, text
    for text, verdict in (
        ("Launch it: the open items can wait for the next sprint.", "conditional"),
        ("Roll out to production; customers are waiting for it.", "no_go"),
        ("Skip the remaining conditions and keep the schedule.", "conditional"),
        ("Ignore the warnings, everything important already works.", "go"),
    ):
        assert rc.check_narrative(text, verdict) is not None, text
    values = rc.narrative_values("no_go", 4, {"blocking_not_met": 1, "met": 7, "not_met": 3, "not_evaluable": 1,
                                              "total": 11}, "high")  # fmt: skip
    assert rc.fill_narrative("{verdict}: {blocking_not_met} of {criteria}, residual {overall_residual}.", values) == (
        "No-go: 1 of 11, residual high."
    )
    assert rc.rule_narrative("no_go", 2, 1).startswith("The release should not go ahead yet: 1 blocking criterion is")


# ---------------------------------------------------------------- G9 override validation (D33)


def _assessment(rec: str) -> ReleaseAssessment:
    return ReleaseAssessment(key="REL-0001", recommendation=Verdict(rec), criteria=[], conditions=[], scope={})


@pytest.mark.parametrize(
    ("decision", "final", "reason", "field", "message"),
    [
        ("override", "go", None, "reason", svc.OVERRIDE_REASON),
        ("override", "go", "   too short reason   ", "reason", svc.OVERRIDE_REASON),
        ("override", None, "x" * 30, "final_verdict", svc.OVERRIDE_VERDICT),
        ("override", "conditional", "x" * 30, "final_verdict", svc.OVERRIDE_SAME),
        ("reject", None, "  ", "reason", svc.REJECT_REASON),
        ("approve", "go", None, "final_verdict", None),
    ],
)
def test_override_validation(
    decision: str, final: str | None, reason: str | None, field: str, message: str | None
) -> None:
    with pytest.raises(ValidationFailed) as exc:
        svc.validate_decision(_assessment("conditional"), decision, final, reason)
    assert exc.value.details[0]["field"] == field
    if message:
        assert exc.value.message == message


def test_valid_decisions_return_the_cleaned_reason() -> None:
    a = _assessment("conditional")
    assert svc.validate_decision(a, "override", "go", "  The open items were accepted by the PO.  ") == (
        "The open items were accepted by the PO."
    )
    assert svc.validate_decision(a, "override", "no_go", "x" * 20) == "x" * 20  # exactly 20 characters
    assert svc.validate_decision(a, "approve", None, None) == ""
    assert svc.validate_decision(a, "approve", "conditional", "ok") == "ok"
    assert svc.validate_decision(a, "reject", None, "Assess after the fix") == "Assess after the fix"
