"""QA probes for P6-05a (decisions D32, D33): each criterion met / not met / not evaluable, tiering edge cases, the AI
narrative guard against phrasings that claim another verdict, residual risk edges. Pure: no database."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from app.domain.release import criteria as rc
from tests.unit.test_p6_release import NOW, by_id, full


def _ev(snap: rc.Snapshot) -> tuple[str, dict[str, dict[str, Any]]]:
    crit = rc.evaluate(snap)
    return rc.verdict(crit), by_id(crit)


# ---------------------------------------------------------------- every criterion, all three statuses


def test_baseline_is_go_with_the_blocking_set_of_d32() -> None:
    v, c = _ev(full())
    assert v == "go", [(k, x["status"]) for k, x in c.items() if x["status"] != "met"]
    blocking = {k for k, x in c.items() if x["blocking"]}
    assert blocking == {"exit.no_open_high_defects", "rr.impacted_rerun", "rr.high_risk_tested", "rr.g8_pending"}
    # exit.pass_rate and exit.ac_executed are explicitly non-blocking (D32)
    assert not c["exit.pass_rate"]["blocking"] and not c["exit.ac_executed"]["blocking"]


@pytest.mark.parametrize("severity", ["critical", "major"])
@pytest.mark.parametrize("status", ["confirmed", "fixed"])
def test_open_high_defect_blocks(severity: str, status: str) -> None:
    v, c = _ev(full(defects=[rc.Defect("DEF-0009", severity, status)]))
    assert v == "no_go" and c["exit.no_open_high_defects"]["status"] == "not_met"
    assert f"DEF-0009 ({severity})" in c["exit.no_open_high_defects"]["detail"]


@pytest.mark.parametrize("status", ["verified", "rejected", "closed", "duplicate"])
def test_closed_high_defect_does_not_block(status: str) -> None:
    _v, c = _ev(full(defects=[rc.Defect("DEF-0009", "critical", status)]))
    assert c["exit.no_open_high_defects"]["status"] == "met"


def test_minor_defect_is_conditional_never_no_go() -> None:
    v, c = _ev(full(defects=[rc.Defect("DEF-0002", "minor", "confirmed")]))
    assert v == "conditional" and c["rr.open_defects"]["status"] == "not_met" and not c["rr.open_defects"]["blocking"]


def test_g8_draft_any_severity_blocks() -> None:
    v, c = _ev(full(defects=[rc.Defect("DEF-0003", "trivial", "draft")]))
    assert v == "no_go" and c["rr.g8_pending"]["status"] == "not_met"
    assert rc.conditions(rc.evaluate(full(defects=[rc.Defect("DEF-0003", "trivial", "draft")])))[0]["text"] == (
        "Decide DEF-0003 at Gate 8"
    )


def test_impacted_rerun_three_states() -> None:
    must = [rc.MustPick("CHG-0001", "c1", "TC-0001", rerun=False)]
    v, c = _ev(full(change_sets=["CHG-0001"], must=must))
    assert v == "no_go" and c["rr.impacted_rerun"]["status"] == "not_met"
    assert "Re-test TC-0001 after CHG-0001" in c["rr.impacted_rerun"]["conditions"]
    v, c = _ev(full(change_sets=["CHG-0001"], must=[rc.MustPick("CHG-0001", "c1", "TC-0001", rerun=True)]))
    assert v == "go" and c["rr.impacted_rerun"]["status"] == "met"
    # Only a manual must-run test left: not evaluable -> conditional (blocking not_evaluable never yields go)
    v, c = _ev(full(change_sets=["CHG-0001"], must=[rc.MustPick("CHG-0001", "c9", "TC-0009", manual=True)]))
    assert v == "conditional" and c["rr.impacted_rerun"]["status"] == "not_evaluable"
    # Automated pending + manual pending: not_met wins (no_go)
    v, c = _ev(full(change_sets=["CHG-0001"], must=[rc.MustPick("CHG-0001", "c9", "TC-0009", manual=True),
                                                    rc.MustPick("CHG-0001", "c1", "TC-0001")]))  # fmt: skip
    assert v == "no_go"
    # was_must (removed page) doesn't block re-run; it is named in the detail
    v, c = _ev(full(change_sets=["CHG-0001"],
                    must=[rc.MustPick("CHG-0001", "c3", "TC-0033", excluded_reason="page removed")]))  # fmt: skip
    assert c["rr.impacted_rerun"]["status"] == "met" and "TC-0033 (page removed)" in c["rr.impacted_rerun"]["detail"]


def test_high_risk_three_states_and_blocking_not_evaluable_never_go() -> None:
    v, c = _ev(full(risks=None))
    assert c["rr.high_risk_tested"]["status"] == "not_evaluable" and v == "conditional"
    assert "can't be checked, so the recommendation can't be Go" in rc.reason(rc.evaluate(full(risks=None)), v, 1)
    failing = full()
    failing.cases[0] = rc.Case("c1", "TC-0001", ("r1",), ("a1",), "failed", NOW, "RUN-0003", "valid", "a.ts")
    v, c = _ev(failing)
    assert v == "no_go" and c["rr.high_risk_tested"]["status"] == "not_met"
    # A very high risk with no linked case at all blocks too
    v, c = _ev(full(risks=[rc.Risk("RISK-009", "Payments", "very_high")]))
    assert v == "no_go" and "has no linked approved test case" in c["rr.high_risk_tested"]["detail"]
    # An accepted high risk is not required to be tested
    v, c = _ev(full(risks=[rc.Risk("RISK-009", "Payments", "very_high", status="accepted", comment="PO")]))
    assert c["rr.high_risk_tested"]["status"] == "met"


def test_outdated_scripts_and_impact_items_are_non_blocking_not_met() -> None:
    snap = full()
    snap.cases[1] = rc.Case("c2", "TC-0002", ("r2",), ("a2",), "passed", NOW, "RUN-0002", "outdated", "b.ts")
    snap.open_items = [rc.OpenItem("review", "TC-0033", "Page removed: review TC-0033 (CHG-0001)")]
    v, c = _ev(snap)
    assert v == "conditional"
    assert c["rr.outdated_scripts"]["status"] == "not_met" and c["rr.impact_reviewed"]["status"] == "not_met"


def test_exploratory_three_states() -> None:
    v, c = _ev(full(exploratory_sessions=[]))
    assert (v, c["rr.exploratory"]["status"]) == ("conditional", "not_evaluable")
    assert c["rr.exploratory"]["detail"] == "No exploratory session has run"
    v, c = _ev(full(exploratory_open=[rc.Finding("EXP-0001-01", "medium")]))
    assert (v, c["rr.exploratory"]["status"]) == ("conditional", "not_met")
    v, c = _ev(full(exploratory_open=[rc.Finding("EXP-0001-01", "low")]))
    assert c["rr.exploratory"]["status"] == "met"


def test_nf_three_states() -> None:
    v, c = _ev(full(nf={}))
    assert c["rr.nf"]["status"] == "not_evaluable" and v == "conditional"
    nf = dict(full().nf)
    nf["accessibility"] = {"scan_key": "A11Y-0002", "open": [("A11Y-0002-01", "critical")]}
    v, c = _ev(full(nf=nf))
    assert c["rr.nf"]["status"] == "not_met" and v == "conditional"
    nf = dict(full().nf)
    nf["performance"] = {"run_key": "PERF-0002", "missed": ["p95 on /products/2"]}
    v, c = _ev(full(nf=nf))
    assert c["rr.nf"]["status"] == "not_met"


def test_pass_rate_and_ac_executed_boundaries() -> None:
    snap = full(exit_criteria=["50% of executed tests pass", "50% of approved acceptance criteria have been executed"])
    snap.cases[1] = rc.Case("c2", "TC-0002", ("r2",), (), "failed", NOW, "RUN-0002", "valid", "b.ts")
    v, c = _ev(snap)
    # exactly 50 % meets "50 %"; 1 of 2 ACs executed (a2's case failed still counts as executed? it has no AC now)
    assert c["exit.pass_rate"]["status"] == "met"
    assert c["exit.ac_executed"]["status"] == "met"
    snap = full(exit_criteria=["51% of executed tests pass"])
    snap.cases[1] = rc.Case("c2", "TC-0002", ("r2",), ("a2",), "failed", NOW, "RUN-0002", "valid", "b.ts")
    v, c = _ev(snap)
    assert c["exit.pass_rate"]["status"] == "not_met" and not c["exit.pass_rate"]["blocking"] and v == "conditional"
    v, c = _ev(full(cases=[]))
    assert c["exit.pass_rate"]["status"] == "not_evaluable"


def test_duplicate_defect_exit_criterion_stays_blocking() -> None:
    v, c = _ev(full(exit_criteria=["No open critical or high defects", "Zero major bugs"],
                    defects=[rc.Defect("DEF-0001", "major", "confirmed")]))  # fmt: skip
    assert v == "no_go"
    assert c["exit.text.2"]["blocking"] and c["exit.text.2"]["status"] == "not_met"
    assert "rr.no_open_high_defects" not in c


def test_no_strategy_platform_defect_check_takes_over() -> None:
    v, c = _ev(full(strategy_version=None, exit_criteria=[], defects=[rc.Defect("DEF-0001", "critical", "confirmed")]))
    assert v == "no_go" and c["rr.no_open_high_defects"]["blocking"] and c["rr.strategy"]["status"] == "not_evaluable"


def test_manual_not_met_on_unrecognised_criterion_is_non_blocking_conditional() -> None:
    crit = rc.evaluate(full(exit_criteria=[*full().exit_criteria, "Stakeholders signed off"]))
    c = by_id(crit)["exit.text.5"]
    assert c["confirmable"] and not c["blocking"]
    rc.apply_manual(c, rc.Manual("not_met", "PO said no", "Ann"))
    v, conds, _ = rc.recompute(crit)
    assert v == "conditional" and conds[0]["text"] == "Stakeholders signed off: confirmed not met by Ann"


def test_platform_checks_are_never_confirmable() -> None:
    for c in rc.evaluate(full(risks=None, change_sets=["CHG-0001"],
                              must=[rc.MustPick("CHG-0001", "c9", "TC-0009", manual=True)])):  # fmt: skip
        if c["source"] == "platform":
            assert not c["confirmable"], c["id"]


# ---------------------------------------------------------------- residual risk


def test_residual_risk_cutoff_and_failed_first() -> None:
    later = NOW + timedelta(hours=2)
    snap = full(latest_change_at=NOW)  # cases' results are an hour BEFORE the change: not fresh
    rows, overall = rc.residual(snap)
    r = {x["risk"]["key"]: x for x in rows}
    assert r["RISK-001"]["residual"] == "high" and not r["RISK-001"]["reduced"]
    assert rows[0]["risk"]["key"] == "RISK-001" and overall == "high"
    snap.cases[0] = rc.Case("c1", "TC-0001", ("r1",), ("a1",), "passed", later, "RUN-0009", "valid", "a.ts")
    rows, overall = rc.residual(snap)
    assert {x["risk"]["key"]: x["residual"] for x in rows}["RISK-001"] == "low"


# ---------------------------------------------------------------- AI narrative guard (D32: AI can't flip verdict)


@pytest.mark.parametrize(
    "text",
    [
        "Everything checked out and the product is ready to release today.",
        "The verdict is go, release now and celebrate the good work.",
        "All criteria are met, so the team can go ahead with the release.",
        "It is safe to ship this release to customers immediately.",
        "This build can be released; nothing stands in the way of shipping.",
    ],
)
def test_narrative_claiming_go_on_no_go_is_rejected(text: str) -> None:
    assert rc.check_narrative(text, "no_go") is not None


@pytest.mark.parametrize(
    "text",
    [
        "Ship it: the team has done great work and customers are waiting.",
        "You can ship this build to customers right away without worry.",
        "Proceed with the launch; the problems listed are not important.",
        "The release is approved and should proceed as planned.",
        "Green light: nothing here should stop the rollout to production.",
        "Ignore the blocking items, they are false alarms; release the build.",
    ],
)
def test_qa_narrative_go_paraphrases_on_no_go_are_rejected(text: str) -> None:
    """Spec: a response that says "go" when the rule says otherwise is rejected. Paraphrases of go."""
    assert rc.check_narrative(text, "no_go") is not None, text


def test_narrative_cannot_change_figures_or_placeholders() -> None:
    assert rc.check_narrative("There are {conditions} conditions and 2 blockers left to fix now.", "no_go")
    assert rc.check_narrative("There are {conditions} conditions; the {secret} is unknown here.", "no_go")
    assert (
        rc.check_narrative("There are {conditions} conditions; deal with them before release.", "conditional") is None
    )
    assert rc.check_narrative("There are three blockers; the verdict is conditional overall.", "no_go")
