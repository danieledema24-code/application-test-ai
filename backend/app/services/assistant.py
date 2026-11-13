"""AI QA Analyst assistant (P2-10).

Built-in intents are deterministic and work with AI off; every artefact they mention is cited. Free-form questions
use the LLM (structured output, project data inside untrusted blocks) when AI is configured, otherwise a keyword
router maps them to an intent. Every reply passes the citation guard: an ID token that doesn't resolve to an artefact
of this project is replaced and flagged. The assistant never changes data itself: changes are proposals that the
user accepts, and accepting applies them through the same service functions as the REST API.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import (
    AcceptanceCriterion,
    ApplicationFeature,
    AssistantProposal,
    AssistantThread,
    ReadinessCriterion,
    Requirement,
    Risk,
    ScanSession,
    SourceDocument,
    StageRun,
    User,
    WorkflowStage,
)
from app.domain.enums import AcKind, GateKey, GeneratedBy, ItemStatus, ProposalStatus, StageKey
from app.domain.stages import STAGE_BY_KEY, STAGE_ORDER
from app.llm.base import Budget, UntrustedBlock
from app.services import gates
from app.services import serialize_p2 as out
from app.services.counters import next_key

KEY_RE = re.compile(r"\b(REQ|AC|RISK|DOR|DOD|TS|TP|DOC|PROP|FEAT|TCOND|TC|TD)-\d{2,6}\b")
AI_OFF_NOTICE = "Free-form answers need AI, which isn't configured. Built-in questions still work."
DEFAULT_AI_TURNS_PER_DAY = 200
REGENERABLE = ("requirements", "readiness_criteria", "test_strategy", "test_plan", "test_design")


@dataclass(frozen=True)
class IntentSpec:
    intent: str
    label: str
    example: str
    params_schema: dict[str, Any]
    creates_proposal: bool = False
    requires_ai: bool = False
    available: bool = True

    @property
    def requires_role(self) -> str:
        return "member" if self.creates_proposal else "viewer"


def _schema(**props: str) -> dict[str, Any]:
    return {"type": "object", "properties": {k: {"type": v} for k, v in props.items()}}


INTENTS: dict[str, IntentSpec] = {
    i.intent: i
    for i in (
        IntentSpec("help", "What can you do?", "What can you help with?", _schema()),
        IntentSpec("workflow_status", "Where are we?", "What's the status of the workflow?", _schema()),
        IntentSpec("needs_attention", "What needs my attention?", "What needs my attention?", _schema()),
        IntentSpec("coverage_summary", "Requirement coverage", "How many requirements have criteria?", _schema()),
        IntentSpec(
            "list_requirements",
            "List requirements",
            "Which requirements are still in draft?",
            _schema(status="string", classification="string", category="string", without_ac="boolean"),
        ),
        IntentSpec("explain_requirement", "Explain a requirement", "Explain REQ-0001", _schema(key="string")),
        IntentSpec("explain_gate", "Explain a gate", "Why can't I approve G3?", _schema(gate="string")),
        IntentSpec("list_access_gaps", "Access gaps", "Which areas couldn't be reached?", _schema()),
        IntentSpec("risk_summary", "Risk summary", "What are the highest risks?", _schema()),
        IntentSpec("execution_results", "Test results", "Did the tests pass?", _schema()),
        IntentSpec(
            "propose_negative_criteria",
            "Add negative criteria",
            "Add negative criteria to REQ-0001",
            _schema(requirement_key="string"),
            creates_proposal=True,
        ),
        IntentSpec(
            "propose_risk_reassessment",
            "Reassess application risk",
            "Reassess the risks",
            _schema(),
            creates_proposal=True,
        ),
        IntentSpec(
            "propose_regenerate",
            "Regenerate a stage",
            "Regenerate the requirements",
            _schema(stage="string", reason="string"),
            creates_proposal=True,
        ),
        IntentSpec(
            "list_test_cases",
            "List test cases",
            "Which test cases are still in draft?",
            _schema(
                status="string",
                technique="string",
                test_type="string",
                priority="string",
                requirement_key="string",
                suite="string",
                lint="string",
            ),
        ),
        IntentSpec("explain_test_case", "Explain a test case", "Explain TC-0001", _schema(key="string")),
        IntentSpec("traceability_for", "Trace an item", "What tests cover REQ-0001?", _schema(key="string")),
        IntentSpec(
            "propose_negative_cases",
            "Generate more negative test cases",
            "Generate more negative test cases for REQ-0002",
            _schema(requirement_key="string", feature_key="string"),
            creates_proposal=True,
        ),
        IntentSpec(
            "propose_regression_suite",
            "Generate regression scenarios",
            "Build a regression set for the high risks",
            _schema(scope="string"),
            creates_proposal=True,
        ),
        IntentSpec(
            "propose_test_case_update",
            "Update test cases",
            "Make the steps of TC-0003 more specific",
            {"type": "object", "properties": {"test_case_keys": {"type": "array"}, "instruction": {"type": "string"}}},
            creates_proposal=True,
            requires_ai=True,
            available=False,
        ),
        IntentSpec(
            "propose_missing_test_cases",
            "Suggest missing test cases",
            "What test cases are missing for REQ-0004?",
            {"type": "object", "properties": {"requirement_keys": {"type": "array"}, "focus": {"type": "string"}}},
            creates_proposal=True,
            requires_ai=True,
            available=False,
        ),
        IntentSpec(
            "propose_requirement_update",
            "Improve requirements",
            "Make REQ-0003 more specific",
            {
                "type": "object",
                "properties": {"requirement_keys": {"type": "array"}, "instruction": {"type": "string"}},
            },
            creates_proposal=True,
            requires_ai=True,
        ),
        IntentSpec(
            "propose_missing_requirements",
            "Find missing requirements",
            "What requirements are missing for checkout?",
            _schema(focus="string"),
            creates_proposal=True,
            requires_ai=True,
            available=False,
        ),
        IntentSpec(
            "propose_risk_update",
            "Update a risk",
            "Raise the impact of RISK-001",
            _schema(risk_key="string"),
            creates_proposal=True,
            requires_ai=True,
            available=False,
        ),
    )
}

LATER_PHASE = [
    {"label": "Run tests and explain failures", "available_from_phase": 4, "needs": "Test execution (Phase 4)"},
    {"label": "Performance, accessibility and security checks", "available_from_phase": 5, "needs": "Phase 5"},
]


def capabilities(ctx: AppContext) -> dict[str, Any]:
    ai = bool(ctx.llm.enabled)
    return {
        "ai_enabled": ai,
        "model": ctx.llm.model if ai else None,
        "free_form": ai,
        "intents": [
            {
                "intent": i.intent,
                "label": i.label,
                "example": i.example,
                "params_schema": i.params_schema,
                "creates_proposal": i.creates_proposal,
                "requires_ai": i.requires_ai,
                "needs_ai": i.requires_ai,  # listed under "Needs AI"; `available` says whether it runs now
                "available": i.available and (ai or not i.requires_ai),
                "requires_role": i.requires_role,
            }
            for i in INTENTS.values()
        ],
        "later_phase_tasks": LATER_PHASE,
        "notice": None if ai else AI_OFF_NOTICE,
    }


@dataclass
class Answer:
    content: str
    intent: str | None
    answered_by: str = "intent"
    generated_by: str = "rules"
    citations: list[dict[str, Any]] = field(default_factory=list)
    notices: list[dict[str, str]] = field(default_factory=list)
    proposals: list[dict[str, Any]] = field(default_factory=list)  # specs; persisted by the caller
    follow_ups: list[dict[str, Any]] = field(default_factory=list)
    llm: dict[str, Any] | None = None

    def cite(self, ref: dict[str, Any]) -> str:
        if all(c["key"] != ref["key"] for c in self.citations):
            self.citations.append(ref)
        return str(ref["key"])

    def notice(self, code: str, message: str) -> None:
        self.notices.append({"code": code, "message": message})


@dataclass
class Turn:
    ctx: AppContext
    s: AsyncSession
    project_id: uuid.UUID
    can_edit: bool


def _follow(intent: str, **params: Any) -> dict[str, Any]:
    return {"intent": intent, "label": INTENTS[intent].label, "params": params}


# ---------------------------------------------------------------- data access


async def _current_run(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> StageRun | None:
    st = await gates._stage(s, project_id, key)
    if st.current_stage_run_id is None:
        return None
    run = await s.get(StageRun, st.current_stage_run_id)
    return run if run is not None and run.finished_at is not None else None


async def data_versions(s: AsyncSession, project_id: uuid.UUID) -> dict[str, int]:
    outv: dict[str, int] = {}
    for key in (
        StageKey.discovery,
        StageKey.requirements,
        StageKey.readiness_criteria,
        StageKey.test_strategy,
        StageKey.test_design,
    ):
        run = await _current_run(s, project_id, key)
        if run is not None:
            outv[key.value] = run.version
    from app.services.plan import current_plan

    plan = await current_plan(s, project_id)
    if plan is not None:
        outv["test_plan"] = plan.version
    return outv


async def _requirements(s: AsyncSession, project_id: uuid.UUID) -> list[Requirement]:
    _run, reqs = await gates.current_requirements(s, project_id)
    return sorted(reqs, key=lambda r: r.key)


async def _risks(s: AsyncSession, project_id: uuid.UUID) -> list[Risk]:
    run, _strat = await gates.current_strategy(s, project_id)
    if run is None:
        return []
    rows = (await s.execute(select(Risk).where(Risk.stage_run_id == run.id))).scalars()
    return sorted(rows, key=lambda r: (-r.score, r.key))


def _ref(project_id: uuid.UUID, kind: str, id_: uuid.UUID | None, key: str, label: str) -> dict[str, Any]:
    return out.artefact_ref(project_id, kind, id_, key, label)


async def resolve_keys(s: AsyncSession, project_id: uuid.UUID, keys: set[str]) -> dict[str, dict[str, Any]]:
    """Resolves ID tokens against the project's current artefacts (tenant-scoped session)."""
    found: dict[str, dict[str, Any]] = {}
    if not keys:
        return found
    by_prefix: dict[str, set[str]] = {}
    for k in keys:
        by_prefix.setdefault(k.split("-", 1)[0], set()).add(k)
    reqs = await _requirements(s, project_id) if {"REQ", "AC"} & set(by_prefix) else []
    for r in reqs:
        if r.key in keys:
            found[r.key] = _ref(project_id, "requirement", r.id, r.key, r.title)
    if "AC" in by_prefix and reqs:
        acs = (
            await s.execute(
                select(AcceptanceCriterion).where(
                    AcceptanceCriterion.requirement_id.in_([r.id for r in reqs]),
                    AcceptanceCriterion.key.in_(by_prefix["AC"]),
                )
            )
        ).scalars()
        for a in acs:
            found[a.key] = _ref(project_id, "acceptance_criterion", a.id, a.key, a.then_text[:80])
    if "RISK" in by_prefix:
        for rk in await _risks(s, project_id):
            if rk.key in keys:
                found[rk.key] = _ref(project_id, "risk", rk.id, rk.key, rk.title)
    if {"DOR", "DOD"} & set(by_prefix):
        run = await _current_run(s, project_id, StageKey.readiness_criteria)
        if run is not None:
            for c in (
                await s.execute(select(ReadinessCriterion).where(ReadinessCriterion.stage_run_id == run.id))
            ).scalars():
                if c.key in keys:
                    found[c.key] = _ref(project_id, "readiness_criterion", c.id, c.key, c.text[:80])
    if "DOC" in by_prefix:
        for d in (
            await s.execute(
                select(SourceDocument).where(
                    SourceDocument.project_id == project_id, SourceDocument.key.in_(by_prefix["DOC"])
                )
            )
        ).scalars():
            found[d.key] = _ref(project_id, "document", d.id, d.key, d.title)
    if "FEAT" in by_prefix:
        for f in (
            await s.execute(
                select(ApplicationFeature).where(
                    ApplicationFeature.project_id == project_id, ApplicationFeature.key.in_(by_prefix["FEAT"])
                )
            )
        ).scalars():
            found[f.key] = _ref(project_id, "feature", f.id, f.key, f.name)
    if "PROP" in by_prefix:
        for p in (
            await s.execute(
                select(AssistantProposal).where(
                    AssistantProposal.project_id == project_id, AssistantProposal.key.in_(by_prefix["PROP"])
                )
            )
        ).scalars():
            found[p.key] = {"type": "proposal", "id": str(p.id), "key": p.key, "label": p.summary[:80], "path": None}
    if {"TC", "TCOND", "TD"} & set(by_prefix):
        from app.services import testdesign as tds

        drun = await tds.current_run(s, project_id)
        if drun is not None:
            for tc in await tds.cases_of(s, drun.id):
                if tc.key in keys:
                    found[tc.key] = _ref(project_id, "test_case", tc.id, tc.key, tc.title)
            for cond in await tds.conditions_of(s, drun.id):
                if cond.key in keys:
                    found[cond.key] = _ref(project_id, "test_condition", cond.id, cond.key, cond.title)
            for item in await tds.data_of(s, drun.id):
                if item.key in keys:
                    found[item.key] = _ref(project_id, "test_data", item.id, item.key, item.name)
    for prefix in ("TS", "TP"):
        if prefix in by_prefix:
            if prefix == "TS":
                _run, strat = await gates.current_strategy(s, project_id)
                if strat is not None and strat.key in keys:
                    found[strat.key] = _ref(project_id, "test_strategy", strat.id, strat.key, "Test Strategy")
            else:
                from app.services.plan import current_plan

                plan = await current_plan(s, project_id)
                if plan is not None and plan.key in keys:
                    found[plan.key] = _ref(project_id, "test_plan", plan.id, plan.key, "Test Plan")
    return found


async def citation_guard(s: AsyncSession, project_id: uuid.UUID, ans: Answer) -> None:
    """Every ID token in the content must resolve to an artefact of this project; others are replaced."""
    tokens = {m.group(0) for m in KEY_RE.finditer(ans.content)}
    known = {c["key"] for c in ans.citations}
    resolved = await resolve_keys(s, project_id, tokens - known)
    for k in sorted(tokens - known):
        if k in resolved:
            ans.cite(resolved[k])
    bad = sorted(t for t in tokens if t not in known and t not in resolved)
    if bad:
        ans.content = KEY_RE.sub(lambda m: m.group(0) if m.group(0) not in bad else "[unknown reference]", ans.content)
        ans.notice("unresolved_citation", f"Removed {len(bad)} reference(s) that don't exist in this project.")
    keep = {m.group(0) for m in KEY_RE.finditer(ans.content)}
    ans.citations = [c for c in ans.citations if c["key"] in keep]


# ---------------------------------------------------------------- deterministic intents


async def _help(t: Turn, _p: dict[str, Any]) -> Answer:
    items = [f'- **{i.label}**: for example "{i.example}"' for i in INTENTS.values() if i.available]
    a = Answer(
        "I can answer questions about this project's workflow, requirements and risks:\n" + "\n".join(items), "help"
    )
    a.follow_ups = [_follow("workflow_status"), _follow("needs_attention")]
    return a


async def _workflow_status(t: Turn, _p: dict[str, Any]) -> Answer:
    stages = list((await t.s.execute(select(WorkflowStage).where(WorkflowStage.project_id == t.project_id))).scalars())
    stages = sorted((x for x in stages if STAGE_BY_KEY[x.stage_key].available), key=lambda x: STAGE_ORDER[x.stage_key])
    lines = []
    for st in stages:
        gate = f" (gate {st.gate_key.value}: {st.gate_status.value})" if st.gate_key else ""
        lines.append(f"- {STAGE_BY_KEY[st.stage_key].title}: {st.status.value.replace('_', ' ')}{gate}")
    a = Answer("Workflow status:\n" + "\n".join(lines), "workflow_status")
    a.follow_ups = [_follow("needs_attention")]
    return a


async def _needs_attention(t: Turn, _p: dict[str, Any]) -> Answer:
    a = Answer("", "needs_attention")
    lines: list[str] = []
    stages = list((await t.s.execute(select(WorkflowStage).where(WorkflowStage.project_id == t.project_id))).scalars())
    for st in sorted(stages, key=lambda x: STAGE_ORDER[x.stage_key]):
        title = STAGE_BY_KEY[st.stage_key].title
        if st.gate_key and st.status.value == "awaiting_approval":
            lines.append(f"- {title} is waiting for {st.gate_key.value} approval.")
        if st.status.value == "stale":
            lines.append(f"- {title} is out of date: {st.stale_reason or 'its input changed'}.")
        if st.status.value == "failed":
            lines.append(f"- {title} failed.")
    reqs = await _requirements(t.s, t.project_id)
    drafts = [r for r in reqs if r.status.value == "draft"]
    if drafts:
        shown = ", ".join(a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title)) for r in drafts[:8])
        more = f" and {len(drafts) - 8} more" if len(drafts) > 8 else ""
        lines.append(f"- {len(drafts)} requirement(s) still in draft: {shown}{more}.")
    conflicts = [r for r in reqs if out.has_conflict(r)]
    if conflicts:
        shown = ", ".join(a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title)) for r in conflicts[:8])
        lines.append(f"- Document conflicts: {shown}.")
    pending = int(
        (
            await t.s.execute(
                select(func.count())
                .select_from(AssistantProposal)
                .where(AssistantProposal.project_id == t.project_id, AssistantProposal.status == ProposalStatus.pending)
            )
        ).scalar_one()
    )
    if pending:
        lines.append(f"- {pending} assistant proposal(s) waiting for a decision.")
    a.content = "Needs attention:\n" + "\n".join(lines) if lines else "Nothing needs your attention right now."
    a.follow_ups = [_follow("list_requirements", status="draft")] if drafts else []
    return a


async def _coverage(t: Turn, _p: dict[str, Any]) -> Answer:
    reqs = [r for r in await _requirements(t.s, t.project_id) if r.status.value != "rejected"]
    if not reqs:
        return Answer("There are no requirements yet. They are generated after discovery.", "coverage_summary")
    acs = list(
        (
            await t.s.execute(
                select(AcceptanceCriterion)
                .where(
                    AcceptanceCriterion.requirement_id.in_([r.id for r in reqs]),
                    AcceptanceCriterion.status != ItemStatus.rejected,
                )
                .order_by(AcceptanceCriterion.key)
            )
        ).scalars()
    )
    by_req: dict[uuid.UUID, list[AcceptanceCriterion]] = {}
    for c in acs:
        by_req.setdefault(c.requirement_id, []).append(c)
    with_ac = [r for r in reqs if by_req.get(r.id)]
    without = [r for r in reqs if not by_req.get(r.id)]
    by_class: dict[str, int] = {}
    for r in reqs:
        by_class[r.provenance.value] = by_class.get(r.provenance.value, 0) + 1
    approved = sum(1 for r in reqs if r.status.value == "approved")
    a = Answer("", "coverage_summary")
    lines = [
        f"{len(reqs)} requirements ({approved} approved): "
        + ", ".join(f"{n} {k}" for k, n in sorted(by_class.items()))
        + f". {len(with_ac)} have acceptance criteria ({len(acs)} criteria in total)."
    ]
    if with_ac:
        lines.append("With acceptance criteria:")
        for r in with_ac[:15]:
            rk = a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title))
            ks = [
                a.cite(_ref(t.project_id, "acceptance_criterion", c.id, c.key, c.then_text[:80]))
                for c in by_req[r.id][:6]
            ]
            more = f" +{len(by_req[r.id]) - 6}" if len(by_req[r.id]) > 6 else ""
            lines.append(f"- {rk}: {', '.join(ks)}{more}")
        if len(with_ac) > 15:
            lines.append(f"- …and {len(with_ac) - 15} more")
    if without:
        shown = ", ".join(a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title)) for r in without[:15])
        more = f" and {len(without) - 15} more" if len(without) > 15 else ""
        lines.append(f"Without acceptance criteria: {shown}{more}.")
    feats = await gates.features_without_requirement(t.s, t.project_id)
    if feats:
        shown = ", ".join(a.cite(_ref(t.project_id, "feature", f.id, f.key, f.name)) for f in feats[:10])
        lines.append(f"Features without a requirement: {shown}.")
    untested = [r for r in await _risks(t.s, t.project_id) if not (r.mitigation or {}).get("test_types")]
    if untested:
        shown = ", ".join(a.cite(_ref(t.project_id, "risk", r.id, r.key, r.title)) for r in untested[:10])
        lines.append(f"Risks without a test type: {shown}.")
    from app.services import assistant_p3

    lines += await assistant_p3.coverage_v2(t, a)
    a.content = "\n".join(lines)
    target = without[0] if without else reqs[0]
    a.follow_ups = [_follow("propose_negative_criteria", requirement_key=target.key)]
    return a


async def _list_requirements(t: Turn, p: dict[str, Any]) -> Answer:
    reqs = await _requirements(t.s, t.project_id)
    counts = await out.ac_counts(t.s, [r.id for r in reqs])
    filt = []
    for r in reqs:
        if p.get("status") and r.status.value != p["status"]:
            continue
        if p.get("classification") and r.provenance.value != p["classification"]:
            continue
        if p.get("category") and r.category != p["category"]:
            continue
        if p.get("without_ac") and counts.get(r.id, (0, 0))[0] > 0:
            continue
        filt.append(r)
    desc = ", ".join(f"{k} {v}" for k, v in p.items() if v not in (None, "", False)) or "all"
    a = Answer("", "list_requirements")
    if not filt:
        a.content = f"No requirements match ({desc})."
        return a
    lines = [
        f"- {a.cite(_ref(t.project_id, 'requirement', r.id, r.key, r.title))} {r.title} "
        f"({r.provenance.value}, {r.status.value.replace('_', ' ')})"
        for r in filt[:25]
    ]
    more = f"\n…and {len(filt) - 25} more." if len(filt) > 25 else ""
    a.content = f"{len(filt)} requirement(s) ({desc}):\n" + "\n".join(lines) + more
    return a


async def _find_requirement(t: Turn, key: str | None) -> Requirement | None:
    if not key:
        return None
    for r in await _requirements(t.s, t.project_id):
        if r.key == key.upper():
            return r
    return None


async def _explain_requirement(t: Turn, p: dict[str, Any]) -> Answer:
    r = await _find_requirement(t, p.get("key"))
    if r is None:
        return Answer(
            f"I can't find {p.get('key') or 'that requirement'} in the current requirement set.", "explain_requirement"
        )
    a = Answer("", "explain_requirement")
    acs = list(
        (
            await t.s.execute(
                select(AcceptanceCriterion)
                .where(AcceptanceCriterion.requirement_id == r.id, AcceptanceCriterion.status != ItemStatus.rejected)
                .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.key)
            )
        ).scalars()
    )
    key = a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title))
    lines = [
        f"**{key} {r.title}** is {r.provenance.value}: {out.classification_reason(r)}",
        f"Status: {r.status.value.replace('_', ' ')}. Scope: {r.behaviour_scope.value}.",
    ]
    if acs:
        lines.append("Acceptance criteria:")
        for c in acs[:10]:
            ck = a.cite(_ref(t.project_id, "acceptance_criterion", c.id, c.key, c.then_text[:80]))
            lines.append(
                f"- {ck} ({c.kind.value}, {c.status.value}): given {c.given_text}, when {c.when_text}, then {c.then_text}"
            )
    else:
        lines.append("It has no acceptance criteria yet.")
    a.content = "\n".join(lines)
    if not any(c.kind == AcKind.negative for c in acs):
        a.follow_ups = [_follow("propose_negative_criteria", requirement_key=r.key)]
    return a


async def _explain_gate(t: Turn, p: dict[str, Any]) -> Answer:
    raw = str(p.get("gate") or "G3").upper()
    try:
        gate = GateKey(raw)
    except ValueError:
        return Answer(f"{raw} isn't a quality gate.", "explain_gate")
    if gate not in (GateKey.G3, GateKey.G4, GateKey.G5):
        return Answer(f"I can explain G3, G4 and G5. {gate.value} is shown on the workflow page.", "explain_gate")
    from app.db.models import Project

    project = (await t.s.execute(select(Project).where(Project.id == t.project_id))).scalar_one()
    pre = await gates.preconditions(t.s, project, gate)
    a = Answer("", "explain_gate")
    lines = [f"{gate.value} preconditions:"]
    for x in pre:
        mark = "met" if x.met else ("blocking" if x.blocking else "warning")
        lines.append(f"- [{mark}] {x.message}")
    blockers = gates.blockers(pre)
    lines.append(
        "It can be approved now." if not blockers else f"{len(blockers)} blocking item(s) must be resolved first."
    )
    a.content = "\n".join(lines)
    return a


async def _access_gaps(t: Turn, _p: dict[str, Any]) -> Answer:
    scan = (
        await t.s.execute(
            select(ScanSession)
            .where(ScanSession.project_id == t.project_id)
            .order_by(ScanSession.sequence.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    gaps = list(scan.access_gaps or []) if scan else []
    if not gaps:
        return Answer("The latest scan found no access gaps.", "list_access_gaps")
    lines = [f"- {g.get('description', '')} Suggestion: {g.get('suggestion', '')}" for g in gaps[:20]]
    return Answer(
        f"{len(gaps)} area(s) couldn't be reached in scan {scan.key if scan else ''}:\n" + "\n".join(lines),
        "list_access_gaps",
    )


async def _risk_summary(t: Turn, _p: dict[str, Any]) -> Answer:
    risks = await _risks(t.s, t.project_id)
    if not risks:
        return Answer("There is no risk register yet. It is written with the test strategy after G3.", "risk_summary")
    a = Answer("", "risk_summary")
    levels: dict[str, int] = {}
    for r in risks:
        levels[r.level.value] = levels.get(r.level.value, 0) + 1
    lines = [
        f"- {a.cite(_ref(t.project_id, 'risk', r.id, r.key, r.title))} {r.title}: "
        f"{r.likelihood}×{r.impact} = {r.score} ({r.level.value.replace('_', ' ')}, {r.status.value})"
        for r in risks[:5]
    ]
    summary = ", ".join(f"{levels.get(k, 0)} {k.replace('_', ' ')}" for k in ("very_high", "high", "medium", "low"))
    a.content = f"{len(risks)} risks ({summary}). Highest:\n" + "\n".join(lines)
    a.follow_ups = [_follow("propose_risk_reassessment")]
    return a


async def _execution(t: Turn, _p: dict[str, Any]) -> Answer:
    a = Answer("No tests have been run for this project, so there are no results to report.", "execution_results")
    a.notice("no_execution_data", "Test execution arrives in Phase 4; I never report results that don't exist.")
    return a


def _readonly(intent: str) -> Answer:
    return Answer("You have read-only access, so I can't prepare changes. Ask a member of the project.", intent)


async def _propose_negative(t: Turn, p: dict[str, Any]) -> Answer:
    if not t.can_edit:
        return _readonly("propose_negative_criteria")
    r = await _find_requirement(t, p.get("requirement_key"))
    if r is None:
        return Answer(
            f"I can't find {p.get('requirement_key') or 'that requirement'} in the current requirement set.",
            "propose_negative_criteria",
        )
    a = Answer("", "propose_negative_criteria")
    key = a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title))
    acs = list(
        (
            await t.s.execute(
                select(AcceptanceCriterion).where(
                    AcceptanceCriterion.requirement_id == r.id, AcceptanceCriterion.status != ItemStatus.rejected
                )
            )
        ).scalars()
    )
    if any(c.kind == AcKind.negative for c in acs):
        a.content = f"{key} already has negative acceptance criteria."
        return a
    positives: list[AcceptanceCriterion | None] = [c for c in acs if c.kind == AcKind.positive]
    positives = positives[:3]
    criteria = []
    for c in positives or [None]:
        given = c.given_text if c else f"the user is using {r.title.lower()}"
        criteria.append(
            {
                "kind": "negative",
                "given": given[:500],
                "when": "the user submits missing or invalid input, or the action is not allowed",
                "then": "the application refuses it with a clear message and nothing is changed or saved",
            }
        )
    payload = {"requirement_id": str(r.id), "requirement_key": r.key, "criteria": criteria}
    a.proposals.append(
        {
            "kind": "add_acceptance_criteria",
            "target": _ref(t.project_id, "requirement", r.id, r.key, r.title),
            "target_type": "requirement",
            "target_id": r.id,
            "target_lineage_id": r.lineage_id,
            "summary": f"Add {len(criteria)} negative acceptance criteria to {r.key}",
            "payload": payload,
            "preview": criteria,
            "base_versions": {str(r.id): r.version},
        }
    )
    a.content = (
        f"I prepared {len(criteria)} negative acceptance criteria for {key} (rule-based; they are classified as "
        "assumed until confirmed). Review and accept the proposal to add them."
    )
    return a


async def _propose_risks(t: Turn, _p: dict[str, Any]) -> Answer:
    if not t.can_edit:
        return _readonly("propose_risk_reassessment")
    risks = [r for r in await _risks(t.s, t.project_id) if r.status.value == "open"]
    if not risks:
        return Answer("There are no open risks to reassess.", "propose_risk_reassessment")
    reqs = {r.lineage_id: r for r in await _requirements(t.s, t.project_id)}
    counts = await out.ac_counts(t.s, [r.id for r in reqs.values()])
    a = Answer("", "propose_risk_reassessment")
    changes = []
    for rk in risks:
        linked = [reqs[uuid.UUID(str(x))] for x in rk.requirement_lineage_ids or [] if uuid.UUID(str(x)) in reqs]
        if not linked:
            continue
        weak = [r for r in linked if r.provenance.value == "unverified" or r.status.value == "needs_info"]
        firm = all(r.status.value == "approved" and counts.get(r.id, (0, 0))[1] > 0 for r in linked)
        if weak and rk.likelihood < 5:
            to, why = rk.likelihood + 1, f"{', '.join(r.key for r in weak[:4])} still unverified or needs information"
        elif firm and not weak and rk.likelihood > 1:
            to, why = rk.likelihood - 1, "all linked requirements are approved with approved acceptance criteria"
        else:
            continue
        for r in (weak or linked)[:4]:
            a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title))
        a.cite(_ref(t.project_id, "risk", rk.id, rk.key, rk.title))
        changes.append(
            {"risk_id": str(rk.id), "risk_key": rk.key, "likelihood": to, "from": rk.likelihood, "rationale": why}
        )
    if not changes:
        a.content = "The current likelihood ratings still match the state of the linked requirements."
        return a
    a.proposals.append(
        {
            "kind": "reassess_risks",
            "target": None,
            "target_type": None,
            "target_id": None,
            "target_lineage_id": None,
            "summary": f"Reassess likelihood of {len(changes)} risk(s)",
            "payload": {"changes": changes},
            "preview": [
                {"field": f"{c['risk_key']}.likelihood", "from": c["from"], "to": c["likelihood"]} for c in changes
            ],
            "base_versions": {
                c["risk_id"]: next(r.version for r in risks if str(r.id) == c["risk_id"]) for c in changes
            },
        }
    )
    a.content = "Proposed likelihood changes (rule-based):\n" + "\n".join(
        f"- {c['risk_key']}: {c['from']} → {c['likelihood']} because {c['rationale']}" for c in changes
    )
    return a


async def _propose_regenerate(t: Turn, p: dict[str, Any]) -> Answer:
    if not t.can_edit:
        return _readonly("propose_regenerate")
    stage = str(p.get("stage") or "requirements")
    if stage not in REGENERABLE:
        return Answer(f"I can regenerate {', '.join(REGENERABLE)}.", "propose_regenerate")
    reason = str(p.get("reason") or "")[:500] or None
    title = "Test Plan" if stage == "test_plan" else STAGE_BY_KEY[StageKey(stage)].title
    a = Answer(
        f"I prepared a proposal to regenerate the {title}. Nothing changes until you review the new version.",
        "propose_regenerate",
    )
    a.proposals.append(
        {
            "kind": "regenerate_stage",
            "target": None,
            "target_type": "stage",
            "target_id": None,
            "target_lineage_id": None,
            "summary": f"Regenerate the {title}",
            "payload": {"stage": stage, "reason": reason},
            "preview": None,
            "base_versions": {},
        }
    )
    return a


REFUSE_GATE = re.compile(
    r"\b(approve|reject|sign[- ]?off|pass|decide)\b.{0,30}\b(gate|g[1-9])\b|\b(gate|g[1-9])\b.{0,20}\b(approve|reject)\b",
    re.IGNORECASE,
)


def _gate_in(text: str) -> str:
    m = re.search(r"\bG(?:ate\s*)?([1-9])\b", text, re.IGNORECASE)
    return f"G{m.group(1)}" if m else "G3"


async def _refuse_gate(t: Turn, p: dict[str, Any]) -> Answer:
    gate = str(p.get("gate") or "G3").upper()
    a = Answer(
        f"I can't approve or reject gates. Gate decisions are made by a person with approval rights on the "
        f"Gate {gate[1:]} review page. I can explain what {gate} still needs.",
        "explain_gate",
    )
    a.follow_ups = [_follow("explain_gate", gate=gate)]
    return a


HANDLERS = {
    "help": _help,
    "workflow_status": _workflow_status,
    "needs_attention": _needs_attention,
    "coverage_summary": _coverage,
    "list_requirements": _list_requirements,
    "explain_requirement": _explain_requirement,
    "explain_gate": _explain_gate,
    "list_access_gaps": _access_gaps,
    "risk_summary": _risk_summary,
    "execution_results": _execution,
    "propose_negative_criteria": _propose_negative,
    "propose_risk_reassessment": _propose_risks,
    "propose_regenerate": _propose_regenerate,
    "refuse_gate": _refuse_gate,
}


def _register_p3() -> None:
    from app.services import assistant_p3 as p3

    HANDLERS.update(
        {
            "list_test_cases": p3.list_test_cases,
            "explain_test_case": p3.explain_test_case,
            "traceability_for": p3.traceability_for,
            "propose_negative_cases": p3.propose_negative_cases,
            "propose_regression_suite": p3.propose_regression_suite,
        }
    )


_register_p3()


def route(text: str) -> tuple[str, dict[str, Any]] | None:
    """Keyword routing for free text when AI is off (or as fallback)."""
    t = text.lower()
    asking = re.search(r"\b(why|how|what|when|which|can'?t i|cannot i|could i)\b", t)
    if REFUSE_GATE.search(text) and not asking:  # a command to decide a gate, not a question about it
        return "refuse_gate", {"gate": _gate_in(text)}
    req = re.search(r"\bREQ-\d{2,6}\b", text, re.IGNORECASE)
    gate = re.search(r"\bG([1-9])\b", text, re.IGNORECASE)
    any_key = re.search(r"\b(?:REQ|AC|TCOND|TC|RISK)-\d{2,6}\b", text, re.IGNORECASE)
    tc = re.search(r"\bTC-\d{2,6}\b", text, re.IGNORECASE)
    feat = re.search(r"\bFEAT-\d{2,6}\b", text, re.IGNORECASE)
    if "negative" in t and ("test case" in t or "tests" in t or "cases" in t) and (req or feat):
        param = {"requirement_key": req.group(0).upper()} if req else {"feature_key": feat.group(0).upper()}  # type: ignore[union-attr]
        return "propose_negative_cases", param
    if "regression" in t:
        scope = "changed_since_g5" if "changed" in t else ("all" if re.search(r"\ball\b", t) else "high_risk")
        return "propose_regression_suite", {"scope": scope}
    if any_key and re.search(r"\btrac|\bcover(s|ed)?\b|tested by", t):
        return "traceability_for", {"key": any_key.group(0).upper()}
    if tc:
        return "explain_test_case", {"key": tc.group(0).upper()}
    if "negative" in t and req:
        return "propose_negative_criteria", {"requirement_key": req.group(0).upper()}
    if "reassess" in t and "risk" in t:
        return "propose_risk_reassessment", {}
    if "regenerate" in t:
        stage = next(
            (sx for sx in REGENERABLE if sx.replace("_", " ") in t or sx.split("_")[-1] in t),
            "test_design" if "test case" in t else "requirements",
        )
        return "propose_regenerate", {"stage": stage}
    if req:
        return "explain_requirement", {"key": req.group(0).upper()}
    outcome = re.search(r"\b(pass(ed|es)?|fail(ed|ing|ures?|s)?|results?|execut\w*)\b", t)
    if outcome and ("test" in t or "pass" in t or "result" in t):
        return "execution_results", {}
    if "requirement" in t and re.search(r"not approved|aren'?t approved|unapproved|still (in )?draft|pending", t):
        return "list_requirements", {"status": "draft"}
    if gate or "gate" in t or "approve" in t:
        return "explain_gate", {"gate": f"G{gate.group(1)}" if gate else "G3"}
    if "attention" in t or "to do" in t or "todo" in t:
        return "needs_attention", {}
    if "risk" in t:
        return "risk_summary", {}
    if "access" in t or "couldn't reach" in t or "sign in" in t or "login" in t:
        return "list_access_gaps", {}
    if "coverage" in t or "criteria" in t or "uncovered" in t:
        return "coverage_summary", {}
    if "test case" in t:
        status = "draft" if "draft" in t else ("approved" if "approved" in t else None)
        return "list_test_cases", {"status": status} if status else {}
    if "draft" in t:
        return "list_requirements", {"status": "draft"}
    if "unverified" in t:
        return "list_requirements", {"classification": "unverified"}
    if "requirement" in t:
        return "list_requirements", {}
    if "status" in t or "where are we" in t or "progress" in t:
        return "workflow_status", {}
    if "help" in t or "what can you" in t:
        return "help", {}
    return None


# ---------------------------------------------------------------- AI path


class AiAnswer(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)
    cited_keys: list[str] = Field(default_factory=list, max_length=50)
    follow_up_intents: list[str] = Field(default_factory=list, max_length=4)


class AiRequirementChange(BaseModel):
    key: str
    title: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=2000)
    rationale: str = Field(max_length=500)


class AiRequirementUpdates(BaseModel):
    changes: list[AiRequirementChange] = Field(default_factory=list, max_length=20)


ASK_TASK = (
    "You are the QA analyst assistant for one project. Answer the project member's question using only the project "
    "data below. Cite artefacts by their keys exactly as given (e.g. REQ-0001, RISK-001); never invent keys, counts, "
    "test results or behaviour. Backend behaviour cannot be observed; say so when relevant. No tests have been run. "
    "If the data does not answer the question, say what is missing. Keep it short.\n\nQuestion: {question}"
)
UPDATE_TASK = (
    "Propose improved wording for these requirements: {keys}. Only change title and/or description; keep the meaning "
    "grounded in the data (do not add behaviour that isn't evidenced). Instruction from the project member: "
    "{instruction}"
)


async def _project_digest(t: Turn) -> str:
    reqs = await _requirements(t.s, t.project_id)
    counts = await out.ac_counts(t.s, [r.id for r in reqs])
    risks = await _risks(t.s, t.project_id)
    stages = list((await t.s.execute(select(WorkflowStage).where(WorkflowStage.project_id == t.project_id))).scalars())
    return json.dumps(
        {
            "stages": [
                {
                    "stage": x.stage_key.value,
                    "status": x.status.value,
                    "gate": x.gate_status.value if x.gate_key else None,
                }
                for x in stages
                if STAGE_BY_KEY[x.stage_key].available
            ],
            "requirements": [
                {
                    "key": r.key,
                    "title": r.title,
                    "status": r.status.value,
                    "classification": r.provenance.value,
                    "scope": r.behaviour_scope.value,
                    "acceptance_criteria": counts.get(r.id, (0, 0))[0],
                }
                for r in reqs[:300]
            ],
            "risks": [
                {"key": r.key, "title": r.title, "score": r.score, "level": r.level.value, "status": r.status.value}
                for r in risks[:100]
            ],
        }
    )


async def ai_answer(t: Turn, question: str) -> Answer | None:
    result = await t.ctx.llm.structured(
        AiAnswer,
        ASK_TASK.format(question=question[:4000]),
        [UntrustedBlock("project_data", await _project_digest(t), max_chars=60_000)],
        Budget(max_output_tokens=t.ctx.settings.ai_max_output_tokens),
    )
    if not result.ok or result.value is None:
        return None
    a = Answer(result.value.answer, None, answered_by="ai", generated_by="ai")
    a.llm = result.usage.as_dict() if result.usage else None
    a.follow_ups = [_follow(i) for i in result.value.follow_up_intents if i in HANDLERS][:4]
    return a


async def ai_requirement_update(t: Turn, p: dict[str, Any]) -> Answer:
    if not t.can_edit:
        return _readonly("propose_requirement_update")
    keys = [str(k).upper() for k in (p.get("requirement_keys") or [])][:20]
    instruction = str(p.get("instruction") or "")[:1000]
    reqs = {r.key: r for r in await _requirements(t.s, t.project_id) if r.key in keys}
    if not reqs:
        return Answer("Tell me which requirements to improve (for example REQ-0001).", "propose_requirement_update")
    data = json.dumps([{"key": r.key, "title": r.title, "description": r.description} for r in reqs.values()])
    result = await t.ctx.llm.structured(
        AiRequirementUpdates,
        UPDATE_TASK.format(keys=", ".join(reqs), instruction=instruction or "make them clear and testable"),
        [UntrustedBlock("requirements", data, max_chars=40_000)],
        Budget(max_output_tokens=t.ctx.settings.ai_max_output_tokens),
    )
    if not result.ok or result.value is None:
        a = Answer("I couldn't prepare changes this time. Try again later.", "propose_requirement_update")
        a.notice("partial_answer", "The AI response could not be used.")
        return a
    a = Answer("", "propose_requirement_update", answered_by="ai", generated_by="ai")
    a.llm = result.usage.as_dict() if result.usage else None
    for ch in result.value.changes:
        r = reqs.get(ch.key.upper())
        if r is None:
            continue  # the model may only touch the requested requirements
        fields = {k: v.strip() for k, v in (("title", ch.title), ("description", ch.description)) if v and v.strip()}
        fields = {k: v for k, v in fields.items() if v != getattr(r, k)}
        if not fields:
            continue
        a.cite(_ref(t.project_id, "requirement", r.id, r.key, r.title))
        a.proposals.append(
            {
                "kind": "update_requirement",
                "target": _ref(t.project_id, "requirement", r.id, r.key, r.title),
                "target_type": "requirement",
                "target_id": r.id,
                "target_lineage_id": r.lineage_id,
                "summary": f"Update {r.key}: {ch.rationale[:200]}",
                "payload": {"requirement_id": str(r.id), **fields},
                "preview": [{"field": k, "from": getattr(r, k), "to": v} for k, v in fields.items()],
                "base_versions": {str(r.id): r.version},
            }
        )
    a.content = (
        f"I prepared {len(a.proposals)} change(s): " + ", ".join(x["target"]["key"] for x in a.proposals) + "."
        if a.proposals
        else "I don't have improvements to suggest for those requirements."
    )
    return a


# ---------------------------------------------------------------- proposals


async def persist_proposals(
    s: AsyncSession, thread: AssistantThread, message_id: uuid.UUID, user_id: uuid.UUID, ans: Answer
) -> list[AssistantProposal]:
    rows = []
    for spec in ans.proposals:
        row = AssistantProposal(
            organisation_id=thread.organisation_id,
            project_id=thread.project_id,
            thread_id=thread.id,
            message_id=message_id,
            key=(await next_key(s, thread.organisation_id, thread.project_id, "PROP"))[1],
            kind=spec["kind"],
            target_type=spec["target_type"],
            target_id=spec["target_id"],
            target_lineage_id=spec["target_lineage_id"],
            summary=spec["summary"],
            payload={**spec["payload"], "_target": spec["target"]},
            preview=spec["preview"],
            base_versions=spec["base_versions"],
            generated_by=GeneratedBy(ans.generated_by),
            created_by=user_id,
        )
        s.add(row)
        rows.append(row)
    await s.flush()
    return rows


def proposal_out(p: AssistantProposal, us: dict[uuid.UUID, User]) -> dict[str, Any]:
    payload = {k: v for k, v in (p.payload or {}).items() if k != "_target"}
    return {
        "id": p.id,
        "key": p.key,
        "thread_id": p.thread_id,
        "kind": p.kind,
        "target": (p.payload or {}).get("_target"),
        "summary": p.summary,
        "payload": payload,
        "preview": p.preview,
        "base_versions": p.base_versions or {},
        "status": p.status.value,
        "generated_by": p.generated_by.value,
        "created_by": out.user_dict(us.get(p.created_by)),
        "created_at": p.created_at,
        "decided_by": out.user_dict(us.get(p.decided_by)) if p.decided_by else None,
        "decided_at": p.decided_at,
        "decision_comment": p.decision_comment,
        "result": p.result,
    }
