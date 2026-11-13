"""ORM -> API mapping for Phase 3 test design (api-contracts.md "Phase 3 endpoints"). Plain dicts in contract shape.

Nothing here is ever an execution result: `execution_status` is "not_run" and `last_result` is null in Phase 3.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import (
    AcceptanceCriterion,
    ApplicationFeature,
    Requirement,
    Risk,
    StageRun,
    TestCase,
    TestCondition,
    TestData,
    User,
)
from app.domain.enums import CaseStatus, Priority, TestDataKind
from app.domain.testdesign import lint as lint_rules
from app.domain.testdesign import priority as prio
from app.services import gates
from app.services import serialize as ser
from app.services import testdesign as tds
from app.services.serialize_p2 import TECHNIQUE_SHORT, artefact_ref, editable, provenanced, refs, user_dict, users


@dataclass
class Lookup:
    project_id: uuid.UUID
    run: StageRun | None
    requirements: dict[str, Requirement] = field(default_factory=dict)  # lineage -> current row
    acs: dict[str, AcceptanceCriterion] = field(default_factory=dict)
    ac_req_key: dict[str, str] = field(default_factory=dict)
    risks: dict[str, Risk] = field(default_factory=dict)  # lineage -> current row
    conditions: dict[str, TestCondition] = field(default_factory=dict)  # lineage -> row of the same run
    data: dict[str, TestData] = field(default_factory=dict)
    cases: list[TestCase] = field(default_factory=list)
    users: dict[uuid.UUID, User] = field(default_factory=dict)
    features: dict[str, ApplicationFeature] = field(default_factory=dict)  # id -> row
    changed: set[str] = field(default_factory=set)  # case lineages new or changed vs the run this one replaced

    def feature_ref(self, c: TestCase) -> dict[str, Any] | None:
        """The feature of the case's first linked requirement that has one."""
        for lin in c.requirement_lineage_ids or []:
            r = self.requirements.get(str(lin))
            for fid in (r.feature_ids if r is not None else None) or []:
                f = self.features.get(str(fid))
                if f is not None:
                    return artefact_ref(self.project_id, "feature", f.id, f.key, f.name)
        return None

    def req_ref(self, lineage: Any) -> dict[str, Any] | None:
        r = self.requirements.get(str(lineage))
        if r is None:
            return None
        return artefact_ref(self.project_id, "requirement", r.id, r.key, f"{r.key} · {r.title}"[:200])

    def ac_ref(self, lineage: Any) -> dict[str, Any] | None:
        a = self.acs.get(str(lineage))
        if a is None:
            return None
        label = f"{a.key} · When {a.when_text}, then {a.then_text}"[:200]
        return artefact_ref(self.project_id, "acceptance_criterion", a.id, a.key, label)

    def risk_ref(self, r: Risk) -> dict[str, Any]:
        label = f"{r.key} · {r.title} ({r.level.value.replace('_', ' ')})"[:200]
        return artefact_ref(self.project_id, "risk", r.id, r.key, label)

    def condition_ref(self, lineage: Any) -> dict[str, Any] | None:
        c = self.conditions.get(str(lineage)) if lineage else None
        if c is None:
            return None
        return artefact_ref(self.project_id, "test_condition", c.id, c.key, f"{c.key} · {c.title}"[:200])

    def case_ref(self, c: TestCase) -> dict[str, Any]:
        label = f"{c.key} · {c.status.value.capitalize()} · {TECHNIQUE_SHORT.get(c.technique, c.technique)}"
        return artefact_ref(self.project_id, "test_case", c.id, c.key, label)

    def data_ref(self, d: TestData) -> dict[str, Any]:
        return artefact_ref(self.project_id, "test_data", d.id, d.key, data_display(d))


def data_display(d: TestData) -> str:
    if d.kind == TestDataKind.secret_ref:
        return f"{d.key} · {d.field_label} · Uses the saved test credentials"
    if d.length is not None and d.kind == TestDataKind.boundary:
        return f"{d.key} · {d.field_label} · {d.length} character{'s' if d.length != 1 else ''}"
    return f"{d.key} · {d.name}"


async def lookup(
    s: AsyncSession, project_id: uuid.UUID, run: StageRun | None, *, user_ids: list[uuid.UUID | None] | None = None
) -> Lookup:
    lk = Lookup(project_id, run)
    rrun, reqs = await gates.current_requirements(s, project_id)
    lk.requirements = {str(r.lineage_id): r for r in reqs}
    if rrun is not None:
        keys = {r.id: r.key for r in reqs}
        for a in (
            await s.execute(select(AcceptanceCriterion).where(AcceptanceCriterion.stage_run_id == rrun.id))
        ).scalars():
            lk.acs[str(a.lineage_id)] = a
            lk.ac_req_key[str(a.lineage_id)] = keys.get(a.requirement_id, "")
    srun, _strat = await gates.current_strategy(s, project_id)
    if srun is not None:
        lk.risks = {
            str(r.lineage_id): r for r in (await s.execute(select(Risk).where(Risk.stage_run_id == srun.id))).scalars()
        }
    if run is not None:
        lk.conditions = {str(c.lineage_id): c for c in await tds.conditions_of(s, run.id)}
        lk.data = {str(d.lineage_id): d for d in await tds.data_of(s, run.id)}
        lk.cases = await tds.cases_of(s, run.id)
        lk.changed = await _changed_cases(s, run, lk.cases)
    fids = {str(f) for r in reqs for f in r.feature_ids or []}
    if fids:
        q = select(ApplicationFeature).where(ApplicationFeature.id.in_([uuid.UUID(x) for x in fids]))
        lk.features = {str(f.id): f for f in (await s.execute(q)).scalars()}
    ids = list(user_ids or [])
    for c in lk.cases:
        ids += [c.updated_by, c.status_changed_by, c.priority_overridden_by]
    lk.users = await users(s, ids)
    return lk


CASE_CHANGE_FIELDS = ("title", "objective", "preconditions", "steps", "expected_result", "technique", "test_type")


def _case_fingerprint(c: TestCase) -> tuple[str, ...]:
    return tuple(str(getattr(c, f)) for f in CASE_CHANGE_FIELDS)


async def _changed_cases(s: AsyncSession, run: StageRun, cases: list[TestCase]) -> set[str]:
    """Lineages whose content differs from the design run this one replaced (new ones count). Empty for v1."""
    prev_id = (run.parameters or {}).get("previous_run_id")
    if not prev_id:
        return set()
    prev = {
        str(c.lineage_id): _case_fingerprint(c)
        for c in (await s.execute(select(TestCase).where(TestCase.stage_run_id == uuid.UUID(str(prev_id))))).scalars()
    }
    return {str(c.lineage_id) for c in cases if prev.get(str(c.lineage_id)) != _case_fingerprint(c)}


def form_label(form_ref: dict[str, Any] | None) -> dict[str, Any] | None:
    """A human label for a data item's form, e.g. {"label": "Contact us form", "path": "/contact"}."""
    ref = form_ref or {}
    anchor, path = str(ref.get("form_anchor") or ""), ref.get("path")
    if not anchor and not path:
        return None
    parts = anchor.split(":", 2)
    name = parts[2].strip() if len(parts) == 3 and parts[0] == "form" else ""
    if not path and len(parts) >= 2 and parts[0] == "form":
        path = parts[1] or None
    # The label is the form's name only; the UI shows the path next to it.
    return {"label": f"{name[:1].upper() + name[1:]} form" if name else "Form", "path": path}


def _open_question(c: TestCase, lk: Lookup) -> dict[str, Any] | None:
    oq = c.open_question_ref or None
    if not oq or c.expected_result_status.value != "open_question":
        return None
    req = lk.requirements.get(str(oq.get("requirement_lineage_id")))
    ref = (
        artefact_ref(lk.project_id, "requirement", None, oq.get("key", ""), f"{oq.get('key', '')}")
        if req is None
        else artefact_ref(lk.project_id, "requirement", req.id, req.key, f"{req.key} · {req.title}"[:200])
    )
    return {"requirement": ref, "message": oq.get("message", c.expected_result)}


def automation_reason(reason: str | None) -> str:
    from app.domain.testdesign.generate import PRELIMINARY

    return (reason or "").removeprefix(PRELIMINARY).strip()


def coverage_item_label(item: Any) -> str:
    """A readable coverage item: "len:0" -> "empty", "len:81" -> "81 characters", "num:11" -> "11"."""
    raw = str(item or "")
    kind, _, rest = raw.partition(":")
    if kind == "len" and rest.isdigit():
        n = int(rest)
        return "empty" if n == 0 else f"{n} character{'s' if n != 1 else ''}"
    if kind == "num" and rest:
        return rest
    if kind == "ac" and rest:
        return rest.partition(":")[2] or rest
    return (rest or raw).replace("_", " ")


def effective_priority(c: TestCase) -> str:
    return prio.effective(c.derived_priority.value, c.priority_override.value if c.priority_override else None)


def case_summary(c: TestCase, lk: Lookup) -> dict[str, Any]:
    req_keys = [lk.requirements[str(x)].key for x in c.requirement_lineage_ids or [] if str(x) in lk.requirements]
    risk = lk.risks.get(str(c.risk_lineage_id)) if c.risk_lineage_id else None
    cond = lk.conditions.get(str(c.condition_lineage_id)) if c.condition_lineage_id else None
    return {
        **provenanced(c),
        "id": str(c.id),
        "key": c.key,
        "lineage_id": str(c.lineage_id),
        "title": c.title,
        "technique": c.technique,
        "test_type": c.test_type,
        "test_level": c.test_level,
        "status": c.status.value,
        "priority": effective_priority(c),
        "derived_priority": c.derived_priority.value,
        "priority_overridden": c.priority_override is not None,
        "risk_level": c.risk_level,
        "risk_score": c.risk_score,
        "suites": list(c.suites or []),
        "requirement_keys": req_keys,
        "lint_summary": lint_rules.summary(list(c.lint or [])),
        "expected_result_status": c.expected_result_status.value,
        "execution_status": "not_run",
        "last_result": None,
        "stage_run_version": lk.run.version if lk.run else None,
        "version": c.version,
        "locked": c.locked,
        "human_edited": c.human_edited,
        "updated_at": c.updated_at,
        "source": c.source.value,
        "objective": c.objective,
        "risk_key": risk.key if risk is not None else None,
        "feature": lk.feature_ref(c),
        "condition_key": cond.key if cond is not None else None,
        "changed_in_latest": str(c.lineage_id) in lk.changed,
        "open_question": _open_question(c, lk),
    }


def data_out(d: TestData, lk: Lookup) -> dict[str, Any]:
    boundary = None
    if d.boundary_ref:
        cond = lk.condition_ref(d.boundary_ref.get("condition_lineage_id"))
        if cond is not None:
            item = d.boundary_ref.get("coverage_item")
            boundary = {"condition": cond, "coverage_item": item, "coverage_item_label": coverage_item_label(item)}
    used = [c for c in lk.cases if str(d.lineage_id) in {str(x) for x in c.data_lineage_ids or []}]
    feature = None
    for c in used:
        feature = lk.feature_ref(c)
        if feature is not None:
            break
    return {
        **editable(d, lk.users),
        "id": str(d.id),
        "key": d.key,
        "lineage_id": str(d.lineage_id),
        "name": d.name,
        "field_label": d.field_label,
        "feature": feature,
        "form_ref": {k: v for k, v in (d.form_ref or {}).items() if k in ("form_anchor", "path", "field_type")},
        "form": form_label(d.form_ref),
        "kind": d.kind.value,
        "value_type": d.value_type.value,
        "value": d.value if d.kind != TestDataKind.secret_ref else None,
        "secret_ref": d.secret_ref,
        "length": d.length,
        "boundary": boundary,
        "synthetic": d.synthetic,
        "generator": d.generator,
        "status": d.status.value,
        "used_by_count": sum(1 for c in used if c.status != CaseStatus.rejected),
        # Editing this item moves these approved cases back to draft (the UI then says "Save and reopen review").
        "used_by_approved": sorted(c.key for c in used if c.status == CaseStatus.approved),
        "generated_by": d.generated_by.value,
        "stage_run_version": lk.run.version if lk.run else None,
    }


def case_detail(ctx: AppContext, c: TestCase, lk: Lookup, evidence: dict[Any, Any] | None = None) -> dict[str, Any]:
    reqs = [r for r in (lk.req_ref(x) for x in c.requirement_lineage_ids or []) if r]
    acs = [a for a in (lk.ac_ref(x) for x in c.ac_lineage_ids or []) if a]
    feats: set[str] = set()
    for lid in c.requirement_lineage_ids or []:
        r = lk.requirements.get(str(lid))
        if r is not None:
            feats.update(str(f) for f in r.feature_ids or [])
    req_lins = {str(x) for x in c.requirement_lineage_ids or []}
    risks = [
        lk.risk_ref(r)
        for r in sorted(lk.risks.values(), key=lambda r: (-r.score, r.key))
        if req_lins & {str(x) for x in r.requirement_lineage_ids or []} or feats & {str(f) for f in r.feature_ids or []}
    ]
    steps = []
    for st in c.steps or []:
        data = [lk.data_ref(lk.data[str(x)]) for x in st.get("data_refs", []) if str(x) in lk.data]
        steps.append(
            {"n": st.get("n"), "action": st.get("action", ""), "data": data, "expected": st.get("expected", "")}
        )
    open_question = _open_question(c, lk)
    risk_row = lk.risks.get(str(c.risk_lineage_id)) if c.risk_lineage_id else None
    if c.priority_override is not None:
        source = {
            "kind": "override",
            "risk": lk.risk_ref(risk_row) if risk_row else None,
            "override_reason": c.priority_override_reason,
            "overridden_by": user_dict(lk.users.get(c.priority_overridden_by)) if c.priority_overridden_by else None,
            "overridden_at": c.priority_overridden_at,
        }
    elif risk_row is not None:
        source = {
            "kind": "risk",
            "risk": lk.risk_ref(risk_row),
            "override_reason": None,
            "overridden_by": None,
            "overridden_at": None,
        }
    else:
        source = {
            "kind": "default",
            "risk": None,
            "override_reason": None,
            "overridden_by": None,
            "overridden_at": None,
        }
    basis = c.design_basis_ref or {}
    data_items = [data_out(lk.data[str(x)], lk) for x in c.data_lineage_ids or [] if str(x) in lk.data]
    return {
        **case_summary(c, lk),
        "objective": c.objective,
        "preconditions": list(c.preconditions or []),
        "steps": steps,
        "expected_result": c.expected_result,
        "open_question": open_question,
        "condition": lk.condition_ref(c.condition_lineage_id),
        "design_basis": {
            "technique": c.technique,
            "coverage_item": basis.get("coverage_item") or "",
            "coverage_item_label": coverage_item_label(basis.get("coverage_item")),
            "explanation": basis.get("explanation") or "",
        },
        "requirements": reqs,
        "acceptance_criteria": acs,
        "risks": risks,
        "test_data": data_items,
        "side_effects": list(c.side_effects or []),
        "automation_suitability": {
            "value": c.automation_suitability.value,
            # `assessed: "preliminary"` already says "Preliminary: assessed in Phase 4."; the reason doesn't repeat it.
            "reason": automation_reason(c.automation_reason),
            "assessed": c.automation_assessed,
        },
        "priority_source": source,
        "lint": list(c.lint or []),
        "evidence": [ser.evidence_link(ctx, e).model_dump(mode="json") for e in (evidence or {}).values()],
        "rule_id": c.rule_id,
        "status_comment": c.status_comment,
        "status_changed_by": user_dict(lk.users.get(c.status_changed_by)) if c.status_changed_by else None,
        "status_changed_at": c.status_changed_at,
        "created_at": c.created_at,
        "updated_by": user_dict(lk.users.get(c.updated_by)) if c.updated_by else None,
        "execution_note": tds.NOT_RUN_YET,
    }


def _condition_basis(c: TestCondition, mine: list[TestCase], lk: Lookup) -> dict[str, Any]:
    """The stored design basis plus what the UI shows per coverage item.

    - `constraint`: the declared constraint the condition comes from (None for catalogue/checklist conditions)
    - `evidence_refs`: the condition's evidence (also at the top level)
    - `values[]`: one row per coverage item, `{coverage_item, value, length, tests, expected, case_keys}` from the
      active cases that cover it. The stored boundary list (BVA) stays available as `boundary_values`.
    """
    stored = dict(c.design_basis or {})
    active = [x for x in sorted(mine, key=lambda x: x.key) if x.status != CaseStatus.rejected]
    rows: list[dict[str, Any]] = []
    for item in c.coverage_items or []:
        cid = str(item.get("id"))
        covering = [x for x in active if str((x.design_basis_ref or {}).get("coverage_item")) == cid]
        datum = None
        for x in covering:
            items = [lk.data[str(d)] for d in x.data_lineage_ids or [] if str(d) in lk.data]
            datum = next(
                (d for d in items if (d.boundary_ref or {}).get("coverage_item") == cid),
                None,
            ) or next((d for d in items if d.field_label == stored.get("field")), None)
            if datum is not None:
                break
        rows.append(
            {
                "coverage_item": cid,
                "value": None if datum is None or datum.kind == TestDataKind.secret_ref else datum.value,
                "length": datum.length if datum is not None else None,
                "tests": item.get("label"),
                "expected": covering[0].expected_result if covering else None,
                "case_keys": [x.key for x in covering],
            }
        )
    out = {**stored, "constraint": stored.get("constraint"), "evidence_refs": refs(c.evidence_refs), "values": rows}
    if "values" in stored:
        out["boundary_values"] = stored["values"]
    return out


def condition_out(c: TestCondition, lk: Lookup, *, with_cases: bool = False) -> dict[str, Any]:
    mine = [x for x in lk.cases if x.condition_lineage_id == c.lineage_id]
    covered: dict[str, list[str]] = {}
    for x in mine:
        if x.status in (CaseStatus.rejected,):
            continue
        item = (x.design_basis_ref or {}).get("coverage_item")
        if item:
            covered.setdefault(str(item), []).append(x.key)
    feature = None
    out: dict[str, Any] = {
        **provenanced(c),
        **editable(c, lk.users),
        "id": str(c.id),
        "key": c.key,
        "lineage_id": str(c.lineage_id),
        "title": c.title,
        "description": c.description,
        "technique": c.technique,
        "test_type": c.test_type,
        "feature": feature,
        "requirements": [r for r in (lk.req_ref(x) for x in c.requirement_lineage_ids or []) if r],
        "acceptance_criteria": [a for a in (lk.ac_ref(x) for x in c.ac_lineage_ids or []) if a],
        "design_basis": _condition_basis(c, mine, lk),
        "coverage_items": [
            {"id": i.get("id"), "label": i.get("label"), "covered_by": covered.get(str(i.get("id")), [])}
            for i in c.coverage_items or []
        ],
        "notes": list(c.notes or []),
        "status": c.status.value,
        "status_comment": c.status_comment,
        "rule_id": c.rule_id,
        "stage_run_version": lk.run.version if lk.run else None,
    }
    if with_cases:
        out["cases"] = [case_summary(x, lk) for x in sorted(mine, key=lambda x: x.key)]
    return out


def sort_cases(cases: list[TestCase], sort: str) -> list[TestCase]:
    if sort == "key":
        return sorted(cases, key=lambda c: c.key)
    if sort == "updated":
        return sorted(cases, key=lambda c: c.updated_at, reverse=True)
    return sorted(cases, key=lambda c: prio.sort_key(effective_priority(c), c.risk_score, c.key))


def stats(lk: Lookup, *, not_designed: list[dict[str, Any]], pending: int | None) -> dict[str, Any]:
    cases = lk.cases

    def tally(values: list[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        for v in values:
            out[v] = out.get(v, 0) + 1
        return dict(sorted(out.items()))

    return {
        "stage_run_version": lk.run.version if lk.run else None,
        "generated_by": lk.run.generated_by.value if lk.run and lk.run.generated_by else None,
        "total": len(cases),
        "by_status": {s.value: sum(1 for c in cases if c.status == s) for s in CaseStatus},
        "by_technique": tally([c.technique for c in cases]),
        "by_type": tally([c.test_type for c in cases]),
        "by_level": tally([c.test_level for c in cases]),
        "by_priority": {p.value: sum(1 for c in cases if effective_priority(c) == p.value) for p in Priority},
        "by_suite": {s: sum(1 for c in cases if s in (c.suites or [])) for s in ("smoke", "regression")},
        "lint": {
            "errors": sum(1 for c in cases for i in c.lint or [] if i.get("severity") == "error"),
            "warnings": sum(1 for c in cases for i in c.lint or [] if i.get("severity") == "warning"),
            "cases_blocked": sum(1 for c in cases if lint_rules.blocking(list(c.lint or []))),
        },
        "open_questions": sum(
            1 for c in cases if c.expected_result_status.value == "open_question" and c.status in tds.ACTIVE_CASE
        ),
        "not_designed": not_designed,
        "execution": tds.unavailable(),
        "pending_review_version": pending,
    }
