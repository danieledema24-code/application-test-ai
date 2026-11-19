"""P6-05a release readiness and Gate 9 through the API (decisions D32, D33), AI off unless stated.

A fixture project is put in the database with every piece of evidence an assessment reads (as test_p5_foundation.py
and test_p6_foundation.py do): approved requirement, acceptance criterion, strategy (G4) with its exit criteria and a
high risk, an approved case (G5), a passed run, clean accessibility and security checks, a load test that met its
thresholds and an exploratory session. The assessment itself runs for real: `POST /release-assessments`, the stage task
on the worker, the rules, the stored row, G9. The demo chain (no-go, then conditional on release 2) is
test_p6_release_demo.py.

Covers: go on the fixture project; an exit criterion the platform can't check, confirmed by a member ("Confirmed by
{name}"); approve, reject and override (422 without a reason or with fewer than 20 characters, 403 for members and
viewers, `gate_decisions` and the audit log with both values); stale after a defect, a triage and a rescan (decisions
and confirmations 409, a new assessment supersedes); other organisations 404; AI off, and FakeLLM narratives (valid,
invalid, and malicious ones claiming another verdict, which never change the verdict).
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.context import AppContext
from app.db.models import (
    AcceptanceCriterion,
    AuditLog,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    PerformanceProfile,
    PerformanceRun,
    QualityFinding,
    QualityScan,
    ReleaseAssessment,
    Requirement,
    Risk,
    ScanSession,
    StageRun,
    TestCase,
    WorkflowStage,
)
from app.db.models import TestStrategy as StrategyRow
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    AcKind,
    BehaviourScope,
    CaseStatus,
    FindingSeverity,
    GateDecisionKind,
    GateKey,
    GeneratedBy,
    ItemStatus,
    PerfRunStatus,
    Provenance,
    QualityScanKind,
    QualityScanStatus,
    RequirementSource,
    RequirementStatus,
    RequirementType,
    RiskCategory,
    RiskLevel,
    Role,
    RunStatus,
    ScanStatus,
    StageKey,
    StageStatus,
    StrategyStatus,
)
from app.domain.risk import risk_level
from app.llm.base import FakeLLM
from app.services.counters import next_key
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.integration.test_p4_automation import _user
from tests.integration.test_p5_foundation import _set_stage
from tests.integration.test_p6_foundation import _through_automation

API = "/api/v1"
EXIT = [
    "100% of approved acceptance criteria have been executed",
    "No open critical or high defects",
    "95% of executed tests pass",
    "Every high and very high risk has its mitigation tests executed",
]
STATEMENT_START = "This recommendation is based on the tests the platform ran and the evidence recorded up to "


class Team:
    def __init__(self, ctx: AppContext, client: httpx.AsyncClient, owner: Account, other: Account) -> None:
        self.ctx, self.client, self.owner, self.other = ctx, client, owner, other
        self.member: dict[str, str] = {}
        self.approver: dict[str, str] = {}
        self.viewer: dict[str, str] = {}

    async def get(self, path: str, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.get(f"{API}{path}", headers=h or self.owner.headers)

    async def post(self, path: str, body: Any, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.post(f"{API}{path}", json=body, headers=h or self.owner.headers)

    async def patch(self, path: str, body: Any, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.patch(f"{API}{path}", json=body, headers=h or self.owner.headers)


async def _team(ctx: AppContext, client: httpx.AsyncClient, tag: str) -> Team:
    owner = await register(client, f"owner@{tag}.example.com", org=f"Release {tag}")
    other = await register(client, f"other@{tag}.example.com", org=f"Other {tag}")
    t = Team(ctx, client, owner, other)
    t.member = await _user(ctx, client, owner.org_id, f"member@{tag}.example.com", Role.member)
    t.approver = await _user(ctx, client, owner.org_id, f"approver@{tag}.example.com", Role.member, True)
    t.viewer = await _user(ctx, client, owner.org_id, f"viewer@{tag}.example.com", Role.viewer)
    return t


@pytest.fixture
async def team(api_ctx: AppContext) -> Any:
    async with client_for(api_ctx) as c:
        yield await _team(api_ctx, c, "p6rel")


async def _current_run(s: Any, pid: uuid.UUID, key: StageKey) -> uuid.UUID:
    st = (
        await s.execute(
            select(WorkflowStage)
            .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == key)
            .execution_options(**BYPASS)
        )
    ).scalar_one()
    assert st.current_stage_run_id is not None
    return st.current_stage_run_id


async def fixture_project(
    t: Team, *, exit_criteria: list[str] | None = None, major_defect: bool = False, finding: bool = False
) -> uuid.UUID:
    """A project whose stored evidence meets every criterion (see the module docstring)."""
    ctx, owner = t.ctx, t.owner
    pid = await _through_automation(ctx, t.client, owner)
    await _set_stage(ctx, owner, pid, StageKey.discovery_report, StageStatus.completed, {})
    async with ctx.session_factory() as s:
        common = {"organisation_id": owner.org_id, "project_id": pid}
        runs = {k: await _current_run(s, pid, k) for k in (StageKey.discovery, StageKey.discovery_report,
                                                             StageKey.requirements, StageKey.test_strategy,
                                                             StageKey.test_design)}  # fmt: skip
        report = (await s.execute(select(StageRun).where(StageRun.id == runs[StageKey.discovery_report])
                                  .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        report.upstream_versions = {"discovery": 1}  # nothing is regenerated after the assessment's task
        req = Requirement(**common, stage_run_id=runs[StageKey.requirements], key="REQ-0001", match_key="req-0001",
                          title="Contact form sends a message", type=RequirementType.functional, category="form_input",
                          behaviour_scope=BehaviourScope.ui, source=RequirementSource.discovery,
                          status=RequirementStatus.approved, provenance=Provenance.observed,
                          generated_by=GeneratedBy.rules)  # fmt: skip
        s.add(req)
        await s.flush()
        ac = AcceptanceCriterion(**common, stage_run_id=runs[StageKey.requirements], requirement_id=req.id,
                                 key="AC-0001", match_key="ac-0001", kind=AcKind.positive, given_text="the form",
                                 when_text="I send it", then_text="it is sent", status=ItemStatus.approved,
                                 provenance=Provenance.observed, generated_by=GeneratedBy.rules)  # fmt: skip
        strat = StrategyRow(**common, stage_run_id=runs[StageKey.test_strategy], key="STR-0001",
                             status=StrategyStatus.approved, generated_by=GeneratedBy.rules,
                             content={"exit_criteria": [{"text": x, "rationale": ""} for x in exit_criteria or EXIT]})  # fmt: skip
        s.add_all([ac, strat])
        await s.flush()
        bind_scope(s, system_scope(owner.org_id))
        _n, risk_key = await next_key(s, owner.org_id, pid, "RISK")  # RISK-001, so a person's next risk is RISK-002
        risk = Risk(**common, stage_run_id=runs[StageKey.test_strategy], strategy_id=strat.id, key=risk_key,
                    match_key="risk-001", title="Contact form doesn't work", category=RiskCategory.product,
                    likelihood=4, impact=4, score=16, level=RiskLevel(risk_level(16)),
                    requirement_lineage_ids=[str(req.lineage_id)], provenance=Provenance.inferred,
                    generated_by=GeneratedBy.rules)  # fmt: skip
        case = TestCase(**common, stage_run_id=runs[StageKey.test_design], key="TC-0001", match_key="tc-0001",
                        title="Send the contact form", test_type="functional", test_level="system",
                        technique="use_case", provenance=Provenance.inferred, generated_by=GeneratedBy.rules,
                        status=CaseStatus.approved, requirement_lineage_ids=[str(req.lineage_id)],
                        ac_lineage_ids=[str(ac.lineage_id)])  # fmt: skip
        s.add_all([risk, case])
        await s.flush()
        s.add(GateDecision(**common, gate_key=GateKey.G4, stage_run_id=runs[StageKey.test_strategy],
                           decision=GateDecisionKind.approve, decided_by=owner.user_id,
                           artefact_snapshot={"items": [{"type": "test_strategy", "id": str(strat.id), "version": 1}]},
                           stage_run_versions={"test_strategy": 2}))  # fmt: skip
        s.add(GateDecision(**common, gate_key=GateKey.G5, stage_run_id=runs[StageKey.test_design],
                           decision=GateDecisionKind.approve, decided_by=owner.user_id, snapshot_hash="h" * 64,
                           artefact_snapshot={"items": [{"type": "test_case", "id": str(case.id), "version": 1}]},
                           stage_run_versions={"test_design": 1}))  # fmt: skip
        # G2 approved on a finished scan: the rescan's baseline (D25).
        bind_scope(s, system_scope(owner.org_id))
        n, scan_key = await next_key(s, owner.org_id, pid, "scan")
        s.add(ScanSession(**common, stage_run_id=runs[StageKey.discovery], key=scan_key, sequence=n,
                          start_url="https://shop.example.com/", status=ScanStatus.completed, finished_at=utcnow()))  # fmt: skip
        s.add(GateDecision(**common, gate_key=GateKey.G2, stage_run_id=runs[StageKey.discovery],
                           decision=GateDecisionKind.approve, decided_by=owner.user_id))  # fmt: skip
        run = ExecutionRun(**common, key="RUN-0001", status=RunStatus.passed, requested_by=owner.user_id,
                           started_at=utcnow(), finished_at=utcnow())  # fmt: skip
        s.add(run)
        await s.flush()
        s.add(ExecutionResult(**common, execution_run_id=run.id, key="RUN-0001-01", case_lineage_id=case.lineage_id,
                              test_case_id=case.id, status="passed"))  # fmt: skip
        for key, kind in (("A11Y-0001", QualityScanKind.accessibility), ("SEC-0001", QualityScanKind.security),
                          ("EXP-0001", QualityScanKind.exploratory)):  # fmt: skip
            scan = QualityScan(**common, key=key, kind=kind, status=QualityScanStatus.completed, finished_at=utcnow())
            s.add(scan)
            await s.flush()
            if finding and kind == QualityScanKind.accessibility:
                s.add(QualityFinding(**common, key="A11Y-0001-01", scan_id=scan.id, kind=kind, rule_id="image-alt",
                                     severity=FindingSeverity.minor, title="Image without alt",
                                     url="https://shop.example.com/", fingerprint="f" * 64))  # fmt: skip
        prof = PerformanceProfile(**common, key="PRF-01", name="Load", stages=[{"duration_s": 30, "target_vus": 5}],
                                  max_rps=10, targets=[{"path": "/", "weight": 1}])  # fmt: skip
        s.add(prof)
        await s.flush()
        s.add(PerformanceRun(**common, key="PERF-0001", profile_id=prof.id, profile_hash="a" * 64,
                             status=PerfRunStatus.passed, finished_at=utcnow(),
                             threshold_results=[{"metric": "p95", "value": 800, "measured": 300, "result": "met"}]))  # fmt: skip
        await s.commit()
    if major_defect:
        r = await t.post(
            f"/projects/{pid}/defects",
            {"summary": "Contact form loses the message", "actual": "Nothing is sent", "severity": "major"},
        )
        assert r.status_code == 201, r.text
        ok = await t.post(f"/defects/{r.json()['id']}/status", {"action": "confirm"}, t.approver)
        assert ok.status_code == 200, ok.text
    return pid


async def assess(t: Team, pid: uuid.UUID, who: dict[str, str] | None = None) -> dict[str, Any]:
    r = await t.post(f"/projects/{pid}/release-assessments", {}, who or t.member)
    assert r.status_code == 202, r.text
    assert r.json()["assessing"] is True
    await worker_for(t.ctx).run_until_idle(timeout=120)
    body = (await t.get(f"/projects/{pid}/release-readiness")).json()
    assert body["assessing"] is False, body["stage"]
    return dict(body["latest"])


def crit(a: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in a["criteria"]}


async def _audit(ctx: AppContext, pid: uuid.UUID, action: str) -> list[AuditLog]:
    async with ctx.session_factory() as s:
        return list(
            (
                await s.execute(
                    select(AuditLog)
                    .where(AuditLog.project_id == pid, AuditLog.action == action)
                    .execution_options(**BYPASS)
                )
            ).scalars()
        )


async def _g9(ctx: AppContext, pid: uuid.UUID) -> list[GateDecision]:
    async with ctx.session_factory() as s:
        return list(
            (
                await s.execute(
                    select(GateDecision)
                    .where(GateDecision.project_id == pid, GateDecision.gate_key == GateKey.G9)
                    .execution_options(**BYPASS)
                )
            ).scalars()
        )


# ---------------------------------------------------------------- go, approve


async def test_fixture_project_with_every_criterion_met_is_go(team: Team) -> None:
    t = team
    pid = await fixture_project(t)
    a = await assess(t, pid)
    bad = [(c["id"], c["status"], c["detail"]) for c in a["criteria"] if c["status"] != "met"]
    assert a["recommendation"] == "go", bad
    assert (a["key"], a["status"], a["verdict_state"], a["conditions_list"]) == ("REL-0001", "awaiting_approval",
                                                                                 "recommended", [])  # fmt: skip
    assert a["reason"] == "Every criterion is met by recorded evidence."
    assert a["statement"].startswith(STATEMENT_START) and a["generated_by"] == "rules" and a["ai_sections"] == {}
    c = crit(a)
    assert c["exit.ac_executed"]["source_label"] == "Exit criterion (Test Strategy v2)"
    assert c["rr.nf"]["source_label"] == "Platform check" and not c["rr.nf"]["can_confirm"]
    assert c["rr.exploratory"]["detail"] == "No open high or medium exploratory finding (EXP-0001)"
    assert {r["risk"]["key"]: r["residual"] for r in a["residual_risks"]} == {"RISK-001": "low"}
    assert a["changes_since"]["text"] == "This is the first assessment."
    evidence = c["exit.pass_rate"]["evidence_refs"][0]
    assert evidence["key"] == "RUN-0001" and evidence["path"].endswith("/execution/RUN-0001")
    wf = (await t.get(f"/projects/{pid}/workflow")).json()
    st = next(x for x in wf["stages"] if x["key"] == "release_readiness")
    assert st["status"] == "awaiting_approval" and st["gate"]["status"] == "pending"
    # A viewer reads it, without decision or confirm permissions.
    seen = (await t.get(f"/release-assessments/{a['id']}", t.viewer)).json()
    assert seen["recommendation"] == "go" and seen["permissions"] == {"can_decide": False, "can_confirm": False,
                                                                       "can_assess": False}  # fmt: skip
    # G9: an approver approves; the recommendation becomes final with the approver's name.
    r = await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "approve"}, t.approver)
    assert r.status_code == 200, r.text
    done = r.json()["assessment"]
    assert r.json()["message"] == "REL-0001: Go is final."
    assert (done["status"], done["final_verdict"], done["verdict_state"]) == ("final", "go", "final")
    assert done["decision_record"]["text"] == "Final verdict: Go · approved by Team Mate"
    assert done["decided_by"]["full_name"] == "Team Mate" and done["decided_by"]["email"] is None
    again = await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "approve"}, t.approver)
    assert again.status_code == 409 and again.json()["error"]["message"] == "This assessment was already decided."
    [g9] = await _g9(t.ctx, pid)
    assert g9.subject_type is not None and g9.subject_type.value == "release_assessment"
    assert str(g9.subject_id) == a["id"] and g9.decision == GateDecisionKind.approve
    assert g9.agent_recommendation == {"recommendation": "go", "final_verdict": "go", "decision": "approve",
                                       "overridden": False}  # fmt: skip
    assert len(await _audit(t.ctx, pid, "release_assessment.created")) == 1
    assert len(await _audit(t.ctx, pid, "release_assessment.decided")) == 1
    wf = (await t.get(f"/projects/{pid}/workflow")).json()
    st = next(x for x in wf["stages"] if x["key"] == "release_readiness")
    assert st["status"] == "approved" and st["gate"]["status"] == "approved"
    # G9 is never decided through /gates.
    r = await t.post(f"/projects/{pid}/gates/G9/decision", {"decision": "approve", "comment": "",
                                                             "stage_run_version": 1})  # fmt: skip
    assert r.status_code == 422


async def test_unrecognised_exit_criterion_is_confirmed_by_a_member(team: Team) -> None:
    t = team
    pid = await fixture_project(t, exit_criteria=[*EXIT, "Stakeholders signed off"])
    a = await assess(t, pid)
    c = crit(a)["exit.text.5"]
    assert (c["status"], c["detail"], c["can_confirm"], c["manual"]) == ("not_evaluable", "The platform can't "
                                                                         "check this: confirm it", True, False)  # fmt: skip
    assert a["recommendation"] == "conditional"
    assert [x["text"] for x in a["conditions_list"]] == ["Confirm: Stakeholders signed off"]
    path = f"/release-assessments/{a['id']}/criteria/exit.text.5/confirm"
    assert (await t.post(path, {"status": "met", "reason": "ok"}, t.viewer)).status_code == 403
    r = await t.post(path, {"status": "met"}, t.member)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Say how it was confirmed."
    r = await t.post(path, {"reason": "Signed off"}, t.member)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Choose Met or Not met."
    r = await t.post(f"/release-assessments/{a['id']}/criteria/rr.nf/confirm", {"status": "met", "reason": "x"},
                     t.member)  # fmt: skip
    assert r.status_code == 409, r.text  # platform checks can't be confirmed by a person
    assert (await t.post(f"/release-assessments/{a['id']}/criteria/nope/confirm",
                         {"status": "met", "reason": "x"}, t.member)).status_code == 404  # fmt: skip
    r = await t.post(path, {"status": "met", "reason": "Signed off in the release meeting"}, t.member)
    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Criterion confirmed. The recommendation is now Go." and r.json()["verdict_changed"]
    now = r.json()["assessment"]
    c = crit(now)["exit.text.5"]
    assert (c["status"], c["manual"]) == ("met", True)
    assert c["detail"] == "Confirmed by Team Mate: 'Signed off in the release meeting'"
    assert c["confirmed_by"]["full_name"] == "Team Mate" and c["confirm_reason"] == "Signed off in the release meeting"
    assert now["recommendation"] == "go" and now["conditions_list"] == [] and now["status"] == "awaiting_approval"
    [log] = await _audit(t.ctx, pid, "exit_criterion.confirmed")
    assert log.meta["criterion"] == "exit.text.5" and log.meta["recommendation"] == {"from": "conditional",
                                                                                              "to": "go"}  # fmt: skip


# ---------------------------------------------------------------- override, reject, roles


async def test_override_needs_a_different_verdict_and_a_reason(team: Team) -> None:
    t = team
    pid = await fixture_project(t, major_defect=True)
    a = await assess(t, pid)
    assert a["recommendation"] == "no_go"
    assert a["reason"] == "1 blocking criterion isn't met: there is an open major defect (DEF-0001)."
    c = crit(a)["exit.no_open_high_defects"]
    assert c["status"] == "not_met" and c["blocking"] and c["evidence_refs"][0]["key"] == "DEF-0001"
    url = f"/release-assessments/{a['id']}/decision"
    for who in (t.member, t.viewer):
        r = await t.post(url, {"decision": "approve"}, who)
        assert r.status_code == 403 and r.json()["error"]["message"] == "Deciding Gate 9 needs approval permission"
    for body, field in (
        ({"decision": "override", "final_verdict": "go"}, "reason"),
        ({"decision": "override", "final_verdict": "go", "reason": "Too short reason"}, "reason"),
        ({"decision": "override", "final_verdict": "no_go", "reason": "x" * 40}, "final_verdict"),
        ({"decision": "override", "reason": "x" * 40}, "final_verdict"),
        ({"decision": "reject"}, "reason"),
        ({"decision": "maybe"}, None),
        ({"decision": "approve", "extra": 1}, None),
    ):
        r = await t.post(url, body, t.approver)
        assert r.status_code == 422, (body, r.text)
        if field:
            assert r.json()["error"]["details"][0]["field"] == field, r.text
    assert not await _g9(t.ctx, pid)
    reason = "DEF-0001 only affects an internal page; the PO accepted it for this release."
    r = await t.post(url, {"decision": "override", "final_verdict": "go", "reason": reason}, t.approver)
    assert r.status_code == 200, r.text
    done = r.json()["assessment"]
    assert r.json()["message"] == "REL-0001 overridden: Go is final."
    assert (done["recommendation"], done["final_verdict"], done["verdict"]) == ("no_go", "go", "go")
    assert done["override_line"] == f"Overridden by Team Mate: {reason}"
    assert (
        done["decision_record"]["text"]
        == f"Final verdict: Go · Overridden by Team Mate: '{reason}' · recommended: No-go"
    )
    listed = (await t.get(f"/projects/{pid}/release-assessments", t.viewer)).json()["items"]
    assert listed[0]["override_line"] == f"Overridden by Team Mate: {reason}"
    [g9] = await _g9(t.ctx, pid)
    assert g9.comment == reason and g9.agent_recommendation == {"recommendation": "no_go", "final_verdict": "go",
                                                                "decision": "override", "overridden": True}  # fmt: skip
    [log] = await _audit(t.ctx, pid, "release_assessment.overridden")
    assert log.meta["recommendation"] == "no_go" and log.meta["final_verdict"] == "go"
    assert log.meta["reason"] == reason


async def test_reject_needs_a_reason_and_requests_changes(team: Team) -> None:
    t = team
    pid = await fixture_project(t, major_defect=True)
    a = await assess(t, pid)
    r = await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "reject", "reason": "Re-test first"},
                     t.approver)  # fmt: skip
    assert r.status_code == 200, r.text
    done = r.json()["assessment"]
    assert (done["status"], done["final_verdict"], done["verdict_state"]) == ("rejected", None, "not_decided")
    assert done["decision_record"]["text"] == "Rejected by Team Mate: 'Re-test first'. Assess again when ready."
    wf = (await t.get(f"/projects/{pid}/workflow")).json()
    st = next(x for x in wf["stages"] if x["key"] == "release_readiness")
    assert st["status"] == "changes_requested"
    [g9] = await _g9(t.ctx, pid)
    assert g9.decision == GateDecisionKind.reject
    # Assessing again is possible; the rejected one stays in history.
    b = await assess(t, pid)
    assert b["key"] == "REL-0002" and b["changes_since"]["previous"]["key"] == "REL-0001"
    hist = (await t.get(f"/projects/{pid}/release-readiness")).json()["history"]
    assert [(h["key"], h["status"]) for h in hist] == [("REL-0002", "awaiting_approval"), ("REL-0001", "rejected")]
    # Lowering the defect's severity changes what blocks: REL-0002 goes stale; the rejected one stays as it was.
    did = crit(b)["exit.no_open_high_defects"]["evidence_refs"][0]["id"]
    d = (await t.get(f"/defects/{did}")).json()
    r = await t.patch(f"/defects/{did}", {"version": d["version"], "severity": "minor", "severity_reason": "Internal"})
    assert r.status_code == 200, r.text
    hist = (await t.get(f"/projects/{pid}/release-readiness")).json()["history"]
    assert [(h["key"], h["status"], h["stale_reason"]) for h in hist] == [
        ("REL-0002", "stale", "DEF-0001 severity changed to minor"),
        ("REL-0001", "rejected", None),
    ]


# ---------------------------------------------------------------- stale


async def test_assessment_goes_stale_when_evidence_changes(team: Team) -> None:
    t = team
    pid = await fixture_project(t, finding=True)
    a = await assess(t, pid)
    assert a["recommendation"] == "go"
    # A new defect (a draft for G8) changes the evidence.
    r = await t.post(f"/projects/{pid}/defects", {"summary": "Footer link is broken", "actual": "404"}, t.member)
    assert r.status_code == 201, r.text
    stale = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert (stale["status"], stale["stale_reason"]) == ("stale", f"{r.json()['key']} was raised")
    assert stale["not_decidable_reason"] == "Evidence changed after this assessment: assess again"
    assert stale["permissions"]["can_decide"] is False and stale["verdict_state"] == "not_decided"
    d = await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "approve"}, t.approver)
    assert (
        d.status_code == 409 and d.json()["error"]["message"] == "Evidence changed after this assessment: assess again"
    )
    wf = (await t.get(f"/projects/{pid}/workflow")).json()
    assert next(x for x in wf["stages"] if x["key"] == "release_readiness")["status"] == "stale"
    # Assess again: REL-0002 (no-go: the draft waits at G8) supersedes REL-0001; history is kept.
    b = await assess(t, pid)
    assert b["key"] == "REL-0002" and b["recommendation"] == "no_go"
    assert crit(b)["rr.g8_pending"]["status"] == "not_met"
    old = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert old["status"] == "superseded" and old["superseded_by"] == "REL-0002"
    assert old["not_decidable_reason"] == "Replaced by REL-0002. This assessment can't be decided."
    assert b["changes_since"]["recommendation"] == {"from": "go", "to": "no_go"}
    assert {"id": "rr.g8_pending", "text": "Nothing waiting at Gate 8", "from": "met", "to": "not_met"} in (
        b["changes_since"]["criteria"]
    )
    # A G8 decision is a defect status change: stale again.
    no = await t.post(f"/defects/{r.json()['id']}/status", {"action": "reject", "reason": "not_a_defect",
                                                           "comment": "Works as designed"}, t.approver)  # fmt: skip
    assert no.status_code == 200, no.text
    assert (await t.get(f"/release-assessments/{b['id']}")).json()["status"] == "stale"
    # Triage of a finding.
    c = await assess(t, pid)
    assert c["recommendation"] == "go"
    async with t.ctx.session_factory() as s:
        fid = (await s.execute(select(QualityFinding.id).where(QualityFinding.project_id == pid)
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
    tr = await t.post(f"/quality-findings/{fid}/triage", {"status": "false_positive", "reason": "Decorative"}, t.member)
    assert tr.status_code == 200, tr.text
    c_now = (await t.get(f"/release-assessments/{c['id']}")).json()
    assert (c_now["status"], c_now["stale_reason"]) == ("stale", "A11Y-0001-01 was marked as false positive")
    confirm = await t.post(f"/release-assessments/{c['id']}/criteria/exit.ac_executed/confirm",
                           {"status": "met", "reason": "x"}, t.member)  # fmt: skip
    assert confirm.status_code == 409
    # A rescan.
    d_ = await assess(t, pid)
    r = await t.post(f"/projects/{pid}/rescans", {}, t.member)
    assert r.status_code == 202, r.text
    d_now = (await t.get(f"/release-assessments/{d_['id']}")).json()
    assert (d_now["status"], d_now["stale_reason"]) == ("stale", "Scan 2 (a rescan) started")
    # A decided assessment never goes stale.
    async with t.ctx.session_factory() as s:
        rows = (await s.execute(select(ReleaseAssessment.key, ReleaseAssessment.status)
                                .where(ReleaseAssessment.project_id == pid)
                                .order_by(ReleaseAssessment.key).execution_options(**BYPASS))).all()  # fmt: skip
    assert [(k, st.value) for k, st in rows] == [("REL-0001", "superseded"), ("REL-0002", "superseded"),
                                                 ("REL-0003", "superseded"), ("REL-0004", "stale")]  # fmt: skip


# ---------------------------------------------------------------- tenants, before any run


async def test_other_organisations_get_404_and_nothing_starts_before_a_run(team: Team) -> None:
    t = team
    pid = await fixture_project(t)
    a = await assess(t, pid)
    o = t.other.headers
    for path in (f"/projects/{pid}/release-readiness", f"/projects/{pid}/release-assessments",
                 f"/release-assessments/{a['id']}", f"/projects/{pid}/release-assessments/by-key/REL-0001"):  # fmt: skip
        assert (await t.get(path, o)).status_code == 404, path
    for path, body in (
        (f"/projects/{pid}/release-assessments", {}),
        (f"/release-assessments/{a['id']}/decision", {"decision": "approve"}),
        (f"/release-assessments/{a['id']}/criteria/exit.ac_executed/confirm", {"status": "met", "reason": "x"}),
    ):
        assert (await t.post(path, body, o)).status_code == 404, path
    by_key = (await t.get(f"/projects/{pid}/release-assessments/by-key/REL-0001", t.viewer)).json()
    assert by_key["id"] == a["id"]
    assert (await t.post(f"/projects/{pid}/release-assessments", {}, t.viewer)).status_code == 403
    # No finished run: the overview says why and nothing can be assessed.
    fresh = await _through_automation(t.ctx, t.client, t.owner)
    body = (await t.get(f"/projects/{fresh}/release-readiness", t.member)).json()
    assert body["available"] is False and body["latest"] is None and body["history"] == []
    assert body["reason"] == "Run the tests first: release readiness needs execution results"
    assert body["permissions"]["can_assess"] is False


# ---------------------------------------------------------------- AI (FakeLLM): narrative only


async def _ai_team(make_ctx: CtxFactory, llm: FakeLLM, tag: str) -> tuple[AppContext, httpx.AsyncClient]:
    ctx = await make_ctx(llm=llm, resolver=public_resolver(), transport=site_transport())
    return ctx, client_for(ctx)


@pytest.mark.parametrize(
    ("responses", "status", "generated_by"),
    [
        ([{"narrative": "The release is {verdict}: {blocking_not_met} blocking criterion is open, so fix it first."}],
         "ok", "ai"),
        ([{"narrative": "Everything checked out and the product is ready to release today."}], "rejected", "rules"),
        ([{"narrative": "There are 3 problems; deal with them before the release goes ahead."}], "rejected", "rules"),
        ([{"narrative": "Fine to ship once reviewed by the team lead.", "verdict": "go"},
          {"narrative": "x", "status": "met"}], "invalid", "rules"),
    ],
)  # fmt: skip
async def test_ai_writes_the_narrative_only(
    make_ctx: CtxFactory, responses: list[dict[str, Any]], status: str, generated_by: str
) -> None:
    llm = FakeLLM(responses)
    ctx, client = await _ai_team(make_ctx, llm, "ai")
    async with client:
        t = await _team(ctx, client, f"p6ai{uuid.uuid4().hex[:6]}")
        pid = await fixture_project(t, major_defect=True)
        a = await assess(t, pid)
    # The verdict, statuses and conditions are the rules', whatever the model wrote.
    assert a["recommendation"] == "no_go" and crit(a)["exit.no_open_high_defects"]["status"] == "not_met"
    assert a["conditions_list"][0]["text"] == "Fix or accept DEF-0001 (major)"
    narrative = a["ai_sections"]["narrative"]
    assert a["ai_sections"]["ai"]["status"] == status and narrative["generated_by"] == generated_by
    if generated_by == "ai":
        assert narrative["text"] == "The release is No-go: 1 blocking criterion is open, so fix it first."
        assert a["generated_by"] == "mixed"
    else:
        assert narrative["text"].startswith("The release should not go ahead yet: 1 blocking criterion is not met")
        assert a["generated_by"] == "rules"
    # The criteria went to the model inside an untrusted block, with the rules' verdict stated in the task.
    assert "Website data (untrusted)" in llm.captured[0]["user"] and "it is No-go." in llm.captured[0]["user"]
