"""Test Design Agent (agent D, P3-01a/P3-01b): conditions, cases and synthetic test data from the approved snapshot.

The rule path (`domain/testdesign/generate.py`) is complete on its own. With AI on, the model may refine wording
and add cases for existing approved requirements; every value it states is replaced by a computed value, and a
boundary or partition that can't be traced to a constraint is dropped (`boundary_not_found`). The first generation
applies directly; later runs are candidates reviewed in the generic change review (P2-00 RowAdapters).
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.phase2 import (
    StageOutcome,
    filter_refs,
    is_candidate_run,
    load_discovery,
    project_evidence_ids,
    rejected_decisions,
)
from app.agents.requirements.rules import _form_name, _label, _path, normalise
from app.context import AppContext
from app.db.models import (
    AcceptanceCriterion,
    ProjectSecret,
    StageRun,
    TestCase,
    TestCondition,
    TestData,
)
from app.db.tenant import TenantScope, bind_scope
from app.domain.enums import (
    AutomationSuitability,
    CaseSource,
    CaseStatus,
    ExpectedResultStatus,
    GeneratedBy,
    ItemStatus,
    Provenance,
    RequirementStatus,
    StageKey,
    TestDataKind,
    TestDataStatus,
    TestDataValueType,
)
from app.domain.provenance import CONFIDENCE_CAP
from app.domain.testdesign import generate as gen
from app.domain.testdesign import synthetic as syn
from app.domain.testdesign import values as val
from app.domain.testdesign.lint import text_lint
from app.llm.base import Budget, UntrustedBlock
from app.services import gates, review
from app.services import testdesign as tds
from app.services.adapters import TEST_CASE, TEST_CONDITION, TEST_DATA
from app.services.counters import next_key

AiTechnique = Literal[
    "equivalence_partitioning", "boundary_value_analysis", "use_case", "error_guessing", "decision_table",
    "state_transition",
]  # fmt: skip
AiLabel = Literal["observed", "inferred", "assumed", "unverified"]
APPROVED_NOT_FOUND_NOTE = "The requirement or constraint behind this case changed; consider deprecating"


class AiStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(min_length=3, max_length=500)
    expected: str = Field(max_length=500)


class AiRefinement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_key: str = Field(max_length=400)
    title: str | None = Field(None, max_length=160)
    objective: str | None = Field(None, max_length=1000)
    expected_result: str | None = Field(None, max_length=1000)
    boundary_length: int | None = Field(None, ge=0, le=100_000)
    classification: AiLabel | None = None


class AiExtraCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requirement_key: str = Field(max_length=32)
    technique: AiTechnique
    title: str = Field(min_length=5, max_length=160)
    objective: str = Field(max_length=1000)
    steps: list[AiStep] = Field(min_length=1, max_length=15)
    expected_result: str = Field(min_length=3, max_length=1000)
    classification: AiLabel = "inferred"
    field_label: str | None = Field(None, max_length=120)
    boundary_length: int | None = Field(None, ge=0, le=100_000)
    partition: str | None = Field(None, max_length=120)


class AiFlag(BaseModel):
    model_config = ConfigDict(extra="forbid")
    match_key: str = Field(max_length=400)
    reason: str = Field(max_length=300)


class TestDesignDraftSet(BaseModel):
    __test__ = False
    model_config = ConfigDict(extra="forbid")
    refinements: list[AiRefinement] = Field(default_factory=list, max_length=100)
    extra_cases: list[AiExtraCase] = Field(default_factory=list, max_length=30)
    flags: list[AiFlag] = Field(default_factory=list, max_length=30)


TASK = """You are reviewing test cases that rules designed from approved requirements and discovered form constraints.
Return JSON matching the schema. You may (1) improve the wording of titles, objectives and expected results of
baseline cases (by match_key), (2) add cases for EXISTING approved requirement keys only (error guessing or
use-case alternatives; boundary and partition cases must name the field and use only the computed boundaries), and
(3) flag baseline cases that look wrong. Never invent limits, values, keys, passwords or personal data. Values you
state are replaced by computed values. Requirement keys: {reqs}
{guidance}"""


class TestDesignAgent:
    __test__ = False

    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id
        self.issues: list[dict[str, Any]] = []
        self.llm_usage: dict[str, Any] | None = None
        self.req_keys: dict[str, gen.ReqIn] = {}

    async def run(self) -> StageOutcome:
        s = self.ctx.session_factory()
        bind_scope(s, self.scope)
        async with s:
            run = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            inp, upstream = await self._load(s)
            out = gen.design(inp)
            self.issues += out.issues
            generated_by = GeneratedBy.rules
            if self.ctx.llm.enabled:
                used = await self._ai_refine(inp, out, run.guidance)
                generated_by = GeneratedBy.mixed if used else GeneratedBy.rules
            drafts: list[gen.CaseDraft | gen.ConditionDraft] = [*out.cases, *out.conditions]
            valid = await project_evidence_ids(
                s, self.project_id, [r.get("evidence_id") for c in drafts for r in c.evidence_refs]
            )
            for c in drafts:
                c.evidence_refs, _ = filter_refs(c.evidence_refs, valid)
            run.upstream_versions = {**(run.upstream_versions or {}), **upstream}
            prev_id = (run.parameters or {}).get("previous_run_id")
            candidate = is_candidate_run(run) and prev_id is not None
            prev_run_id = uuid.UUID(prev_id) if candidate and prev_id else None
            items = await self._write(s, out, prev_run_id)
            await tds.refresh_derived(s, self.project_id, self.run_id)
            cases = await tds.cases_of(s, self.run_id)
            conds = await tds.conditions_of(s, self.run_id)
            data = await tds.data_of(s, self.run_id)
            output: dict[str, Any] = {
                "counts": counts(cases, conds, data),
                "not_designed": out.not_designed,
                "lint": {
                    "errors": sum(1 for c in cases for i in c.lint or [] if i.get("severity") == "error"),
                    "warnings": sum(1 for c in cases for i in c.lint or [] if i.get("severity") == "warning"),
                },
                "skipped_requirements": out.skipped_requirements,
                "generated_by": generated_by.value,
            }
            events: list[tuple[str, str, dict[str, Any]]] = []
            if candidate and prev_run_id is not None:
                prev = await s.get(StageRun, prev_run_id)
                output["candidate_of"] = prev.version if prev else None
                output["review"] = {
                    "items": items,
                    "summary": review.summarise(items, "test_case"),
                    "conditions": review.summarise(items, "test_condition"),
                    "data": review.summarise(items, "test_data"),
                }
                events.append(
                    (
                        "test_design.review_ready",
                        f"Regenerated test design (run {run.version}) is ready for review",
                        {
                            "kind": "review",
                            "candidate_version": run.version,
                            "summary": review.summarise(items, "test_case"),
                        },
                    )
                )
            else:
                events.append(
                    (
                        "test_design.generated",
                        f"Test design run {run.version}: {len(conds)} conditions, {len(cases)} test cases and "
                        f"{len(data)} test data items ({generated_by.value})",
                        {
                            "kind": "result",
                            "stage_run_version": run.version,
                            "conditions": len(conds),
                            "cases": len(cases),
                            "data": len(data),
                            "generated_by": generated_by.value,
                        },
                    )
                )
            await s.commit()
        events += [("validation.issue", i["message"], {"kind": "warning", **i}) for i in self.issues[:20]]
        return StageOutcome(
            output=output,
            generated_by=generated_by,
            validation_issues=self.issues,
            llm=self.llm_usage,
            candidate=candidate,
            events=events,
        )

    # ------------------------------------------------------------------ input

    async def _load(self, s: AsyncSession) -> tuple[gen.DesignInput, dict[str, int]]:
        req_run, reqs = await gates.current_requirements(s, self.project_id)
        strat_run, strat = await gates.current_strategy(s, self.project_id)
        if req_run is None or strat_run is None or strat is None:
            raise RuntimeError("Test design needs approved requirements and an approved test strategy")
        loaded = await load_discovery(s, self.project_id, include_documents=False)
        if loaded is None:
            raise RuntimeError("Discovery has no results")
        data, _drun, scan = loaded
        acs = list(
            (
                await s.execute(
                    select(AcceptanceCriterion)
                    .where(AcceptanceCriterion.stage_run_id == req_run.id)
                    .order_by(AcceptanceCriterion.sort_order, AcceptanceCriterion.key)
                )
            ).scalars()
        )
        by_req: dict[uuid.UUID, list[AcceptanceCriterion]] = {}
        for a in acs:
            by_req.setdefault(a.requirement_id, []).append(a)

        def req_in(r: Any, only_approved_acs: bool) -> gen.ReqIn:
            mine = [
                a
                for a in by_req.get(r.id, [])
                if (a.status == ItemStatus.approved if only_approved_acs else a.status != ItemStatus.rejected)
            ]
            return gen.ReqIn(
                lineage_id=str(r.lineage_id),
                key=r.key,
                title=r.title,
                description=r.description,
                match_key=r.match_key,
                rule_id=r.rule_id,
                category=r.category,
                type=r.type.value,
                behaviour_scope=r.behaviour_scope.value,
                provenance=r.provenance.value,
                status=r.status.value,
                feature_ids=tuple(str(f) for f in r.feature_ids or []),
                acs=tuple(
                    gen.AcIn(
                        str(a.lineage_id),
                        a.key,
                        a.kind.value,
                        a.given_text,
                        a.when_text,
                        a.then_text,
                        a.provenance.value,
                        a.rule_id,
                        tuple(
                            (str(v.get("note") or v.get("label") or ""), str(v.get("value", "")))
                            for v in a.test_values or []
                        ),
                    )
                    for a in mine
                ),
                evidence_refs=tuple(r.evidence_refs or []),
            )

        approved = [req_in(r, True) for r in reqs if r.status == RequirementStatus.approved]
        others = [req_in(r, False) for r in reqs if r.status != RequirementStatus.approved]
        self.req_keys = {r.key: r for r in approved}
        content = strat.content or {}
        techniques: dict[str, frozenset[str]] = {}
        for entry in content.get("techniques_by_feature", []):
            fid = str((entry.get("feature") or {}).get("id") or "")
            if fid:
                techniques[fid] = frozenset(str(t.get("technique")) for t in entry.get("techniques", []))
        forms: list[gen.FormIn] = []
        seen: set[str] = set()
        visited = [p for p in data.pages if getattr(p.status, "value", p.status) == "visited"]
        for page in visited:
            for idx, form in enumerate(page.forms or []):
                purpose = form.get("purpose_guess", "other")
                if purpose in ("search", "filter"):
                    continue
                anchor = (
                    f"form:{_path(page.url).split('?')[0]}:"
                    f"{normalise(str(form.get('name') or form.get('submit_label') or idx))}"
                )
                if anchor in seen:
                    continue
                seen.add(anchor)
                fields = []
                for fld in form.get("fields") or []:
                    if fld.get("type") in ("hidden", "submit", "button"):
                        continue
                    label = _label(fld)
                    c = fld.get("constraints") or {}
                    fields.append(
                        val.FieldFacts(
                            key=f"{anchor}:{normalise(str(fld.get('name') or label))}",
                            name=str(fld.get("name") or ""),
                            label=label,
                            type=str(fld.get("type") or "text"),
                            required=bool(fld.get("required")),
                            minlength=_int(c.get("minlength")),
                            maxlength=_int(c.get("maxlength")),
                            min=None if c.get("min") in (None, "") else str(c.get("min")),
                            max=None if c.get("max") in (None, "") else str(c.get("max")),
                            pattern=c.get("pattern") or None,
                            options=tuple(str(o) for o in fld.get("options") or [] if str(o).strip()),
                            selector=str(fld.get("locator") or ""),
                        )
                    )
                forms.append(
                    gen.FormIn(
                        anchor=anchor,
                        name=_form_name(form),
                        purpose=purpose,
                        path=_path(page.url).split("?")[0],
                        submit_label=str(form.get("submit_label") or "Submit"),
                        fields=fields,
                        evidence_refs=[dict(r) for r in form.get("evidence_refs") or []],
                        page_id=str(page.id),
                        form_index=idx,
                    )
                )
        risks = await tds.risk_facts(s, self.project_id)
        has_secret = (
            await s.execute(select(ProjectSecret.id).where(ProjectSecret.project_id == self.project_id).limit(1))
        ).first() is not None
        redirect = next((b for b in scan.auth_boundaries or [] if b.get("kind") == "redirect_to_login"), None)
        auth = scan.auth or {}
        inp = gen.DesignInput(
            requirements=approved,
            other_requirements=others,
            forms=forms,
            risks=risks,
            techniques_by_feature=techniques,
            test_types=list(content.get("test_types", [])),
            credentials_saved=has_secret,
            signed_in_redirect=redirect is not None,
            signed_in_path=_path(str(redirect.get("url"))).split("?")[0] if redirect else None,
            visited_paths=list(dict.fromkeys(_path(p.url) for p in visited))[:10],
            captcha=auth.get("reason_code") == "captcha",
        )
        return inp, {"requirements": req_run.version, "test_strategy": strat_run.version}

    # ------------------------------------------------------------------ rows

    async def _key(self, s: AsyncSession, kind: str) -> str:
        return (await next_key(s, self.scope.org_id, self.project_id, kind))[1]

    def _base(self) -> dict[str, Any]:
        return {
            "id": uuid.uuid4(),
            "organisation_id": self.scope.org_id,
            "project_id": self.project_id,
            "stage_run_id": self.run_id,
            "key": "",
        }

    async def _stage(
        self,
        s: AsyncSession,
        adapter: Any,
        rows: list[Any],
        prev_run_id: uuid.UUID | None,
        kind: str,
        entity: str,
    ) -> list[dict[str, Any]]:
        if prev_run_id is None:
            for r in rows:
                r.lineage_id = uuid.uuid4()
                r.key = await self._key(s, kind)
                s.add(r)
            await s.flush()
            return []
        current = list(
            (await s.execute(select(adapter.model).where(adapter.model.stage_run_id == prev_run_id))).scalars()
        )
        lineages, keys = await rejected_decisions(s, self.project_id, entity)
        staged = await review.stage_candidates(
            s,
            adapter,
            run_id=self.run_id,
            current_rows=current,
            candidate_rows=rows,
            rejected_lineages=lineages,
            rejected_match_keys=keys,
            new_key=lambda _row: self._key(s, kind),
            refresh_attrs=("evidence_refs",),
        )
        items = review.review_items(adapter, staged)
        by_lineage = {str(r.lineage_id): r for r in current}
        for it in items:
            cur = by_lineage.get(str(it.get("lineage_id")))
            if it["change"] != "no_longer_found" or cur is None:
                continue
            status = getattr(cur, "status", None)
            if entity == "test_case" and status == CaseStatus.approved:
                it["note"] = APPROVED_NOT_FOUND_NOTE
            if entity == "test_case" and status == CaseStatus.deprecated:
                it["default_action"] = "keep"
        return items

    async def _write(
        self, s: AsyncSession, out: gen.DesignOutput, prev_run_id: uuid.UUID | None
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        cond_rows = [self._condition_row(c) for c in out.conditions]
        items += await self._stage(s, TEST_CONDITION, cond_rows, prev_run_id, "TCOND", "test_condition")
        conds = {c.match_key: c for c in await tds.conditions_of(s, self.run_id)}
        data_rows = [self._data_row(d, conds) for d in out.data.values()]
        items += await self._stage(s, TEST_DATA, data_rows, prev_run_id, "TD", "test_data")
        data = {d.match_key: d for d in await tds.data_of(s, self.run_id)}
        case_rows = [self._case_row(c, conds, data) for c in out.cases]
        items += await self._stage(s, TEST_CASE, case_rows, prev_run_id, "TC", "test_case")
        parents = await tds.ac_parents(s, self.project_id)
        for cond in await tds.conditions_of(s, self.run_id):
            await tds.link_condition(s, cond, parents)
        for case in await tds.cases_of(s, self.run_id):
            await tds.link_case(s, case, parents)
        await s.flush()
        return items

    def _condition_row(self, c: gen.ConditionDraft) -> TestCondition:
        label = Provenance(c.provenance)
        return TestCondition(
            **self._base(),
            match_key=c.match_key[:400],
            rule_id=c.rule_id[:64],
            title=c.title[:200],
            description=c.description,
            technique=c.technique,
            test_type=c.test_type,
            feature_lineage_id=_uuid(c.feature_id),
            design_basis=c.design_basis,
            coverage_items=[{**i, "covered_by": []} for i in c.coverage_items],
            notes=c.notes,
            status=ItemStatus.draft,
            requirement_lineage_ids=list(dict.fromkeys(c.requirement_lineages)),
            ac_lineage_ids=list(dict.fromkeys(c.ac_lineages)),
            provenance=label,
            confidence=min(0.7, CONFIDENCE_CAP[label]),
            evidence_refs=c.evidence_refs,
            generated_by=GeneratedBy.rules,
        )

    def _data_row(self, d: gen.DataDraft, conds: dict[str, TestCondition]) -> TestData:
        boundary = None
        if d.boundary is not None and d.boundary["condition"] in conds:
            cond = conds[d.boundary["condition"]]
            boundary = {
                "condition_lineage_id": str(cond.lineage_id),
                "condition_key": cond.key,
                "coverage_item": d.boundary["coverage_item"],
            }
        return TestData(
            **self._base(),
            match_key=d.match_key[:400],
            rule_id=d.generator[:64],
            name=d.name[:200],
            feature_lineage_id=_uuid(d.feature_id),
            form_ref=d.form_ref,
            field_label=d.field_label[:200],
            field_selector=d.field_selector[:400],
            kind=TestDataKind(d.kind),
            value_type=TestDataValueType(d.value_type),
            value=d.value if d.kind != "secret_ref" else None,
            secret_ref=d.secret_ref if d.kind == "secret_ref" else None,
            length=d.length,
            boundary_ref=boundary,
            generator=f"{d.generator}:{syn.seed_of(d.match_key)}",
            synthetic=True,
            status=TestDataStatus.active,
            provenance=Provenance.inferred,
            confidence=0.8,
            evidence_refs=[],
            generated_by=GeneratedBy.rules,
        )

    def _case_row(self, c: gen.CaseDraft, conds: dict[str, TestCondition], data: dict[str, TestData]) -> TestCase:
        steps = []
        lineages: list[str] = []
        for n, st in enumerate(c.steps, start=1):
            refs = [data[mk] for mk in st.get("data", []) if mk in data]
            action = str(st["action"])
            for i, d in enumerate(refs):
                action = action.replace(f"{{d{i}}}", data_label(d))
            action = re.sub(r"\{d\d+\}", "the test value", action)
            steps.append(
                {"n": n, "action": action, "data_refs": [str(d.lineage_id) for d in refs], "expected": st["expected"]}
            )
            lineages += [str(d.lineage_id) for d in refs]
        cond = conds.get(c.condition_match_key or "")
        label = Provenance(c.provenance)
        oq = dict(c.open_question) if c.open_question else None
        return TestCase(
            **self._base(),
            match_key=c.match_key[:400],
            rule_id=c.rule_id[:64],
            condition_lineage_id=cond.lineage_id if cond else None,
            title=c.title[:200],
            objective=c.objective,
            preconditions=c.preconditions,
            steps=steps,
            expected_result=c.expected_result,
            expected_result_status=ExpectedResultStatus(c.expected_result_status),
            open_question_ref=oq,
            test_type=c.test_type,
            test_level=c.test_level,
            technique=c.technique,
            suites=c.suites,
            side_effects=c.side_effects,
            design_basis_ref={"coverage_item": c.coverage_item, "explanation": c.explanation, "positive": c.positive},
            automation_suitability=AutomationSuitability(c.automation[0]),
            automation_reason=c.automation[1],
            automation_assessed="preliminary",
            status=CaseStatus.draft,
            source=CaseSource.design,
            requirement_lineage_ids=list(dict.fromkeys(c.requirement_lineages)),
            ac_lineage_ids=list(dict.fromkeys(c.ac_lineages)),
            data_lineage_ids=list(dict.fromkeys(lineages)),
            provenance=label,
            confidence=min(0.75, CONFIDENCE_CAP[label]),
            evidence_refs=c.evidence_refs,
            generated_by=GeneratedBy(c.generated_by),
        )

    # ------------------------------------------------------------------ AI path (P3-01b)

    async def _ai_refine(self, inp: gen.DesignInput, out: gen.DesignOutput, guidance: str | None) -> bool:
        reqs = [
            {
                "key": r.key,
                "title": r.title,
                "description": r.description[:500],
                "acceptance_criteria": [
                    {"key": a.key, "given": a.given, "when": a.when, "then": a.then} for a in r.acs
                ],
            }
            for r in inp.requirements
        ]
        forms = [
            {
                "form": f.name,
                "path": f.path,
                "fields": [
                    {
                        "label": fl.label,
                        "type": fl.type,
                        "required": fl.required,
                        "minlength": fl.minlength,
                        "maxlength": fl.maxlength,
                        "pattern": fl.pattern,
                        "computed_boundaries": sorted(out.allowed_boundaries.get(fl.key, set())),
                    }
                    for fl in f.fields
                ],
            }
            for f in inp.forms
        ]
        baseline = [
            {"match_key": c.match_key, "title": c.title, "technique": c.technique, "expected_result": c.expected_result}
            for c in out.cases[:150]
        ]
        task = TASK.format(
            reqs=", ".join(sorted(self.req_keys)) or "none",
            guidance=f"User guidance (from the project member): {guidance[:1000]}" if guidance else "",
        )
        result = await self.ctx.llm.structured(
            TestDesignDraftSet,
            task,
            [
                UntrustedBlock("approved_requirements", json.dumps(reqs), max_chars=60_000),
                UntrustedBlock("discovered_forms", json.dumps(forms), max_chars=30_000),
                UntrustedBlock("baseline_cases", json.dumps(baseline), max_chars=60_000),
            ],
            Budget(max_output_tokens=self.ctx.settings.ai_max_output_tokens),
        )
        usage = (
            result.usage.as_dict() if result.usage else {"provider": self.ctx.llm.provider, "model": self.ctx.llm.model}
        )
        self.llm_usage = {**usage, "fallback_used": not result.ok}
        if not result.ok or result.value is None:
            self.issues.append(
                gen.issue("warning", "ai_fallback", f"AI output unusable ({result.reason}); the rule baseline is used.")
            )
            return False
        used = False
        by_key = {c.match_key: c for c in out.cases}
        for ref in result.value.refinements:
            case = by_key.get(ref.match_key)
            if case is None:
                continue
            if ref.boundary_length is not None and case.technique == gen.BVA:
                computed = _case_length(case, out)
                if computed is not None and ref.boundary_length != computed:
                    self.issues.append(
                        gen.issue(
                            "warning",
                            "value_recomputed",
                            f"AI changed a boundary value to {ref.boundary_length}; the computed value {computed} is kept",
                            case.title,
                        )
                    )
            for attr in ("title", "objective", "expected_result"):
                text = getattr(ref, attr)
                if not text or not text.strip() or _unsafe(text):
                    continue
                if attr == "expected_result" and case.expected_result_status == "open_question":
                    continue  # an open question is never answered by the model (decision D6)
                setattr(case, attr, text.strip())
                used = True
            if ref.expected_result and case.expected_result_status != "open_question":
                case.provenance = gen.classify(case.expected_result, case.provenance, ref.classification or "inferred")
                if case.steps:
                    case.steps[-1]["expected"] = case.expected_result[:500]
                case.generated_by = "mixed"
        for extra in result.value.extra_cases:
            draft = self._ai_case(extra, inp, out)
            if draft is not None:
                out.cases.append(draft)
                used = True
        for flag in result.value.flags:
            if flag.match_key in by_key:
                self.issues.append(
                    gen.issue(
                        "info", "ai_flag", f"AI flagged a case: {flag.reason[:200]}", by_key[flag.match_key].title
                    )
                )
        return used

    def _ai_case(self, extra: AiExtraCase, inp: gen.DesignInput, out: gen.DesignOutput) -> gen.CaseDraft | None:
        req = self.req_keys.get(extra.requirement_key)
        if req is None:
            self.issues.append(
                gen.issue("warning", "unknown_requirement", f"AI case dropped: {extra.requirement_key} is not approved")
            )
            return None
        texts = [
            extra.title,
            extra.objective,
            extra.expected_result,
            *(f"{s.action} {s.expected}" for s in extra.steps),
        ]
        if any(_unsafe(t) for t in texts):
            self.issues.append(
                gen.issue(
                    "warning", "unsafe_value", "AI case dropped: it contains a literal secret or real-looking data"
                )
            )
            return None
        field = None
        if extra.field_label:
            field = next(
                (
                    fl
                    for f in inp.forms
                    for fl in f.fields
                    if fl.label.lower() == extra.field_label.lower() and req.anchor.startswith(f.anchor)
                ),
                None,
            )
        data_mk: list[str] = []
        if extra.technique == gen.BVA:
            allowed = out.allowed_boundaries.get(field.key, set()) if field else set()
            if field is None or extra.boundary_length is None or extra.boundary_length not in allowed:
                self.issues.append(
                    gen.issue(
                        "warning",
                        "boundary_not_found",
                        f"AI boundary case dropped: no discovered constraint gives {extra.field_label or 'the field'} a "
                        f"boundary at {extra.boundary_length} characters",
                        extra.title,
                    )
                )
                return None
            mk = next(
                (k for k, d in out.data.items() if d.form_ref.get("field_key") == field.key and d.length == extra.boundary_length and d.kind == "boundary"),
                None,
            )  # fmt: skip
            if mk is not None:
                data_mk.append(mk)
        if extra.technique == gen.EP:
            allowed_p = out.allowed_partitions.get(field.key, set()) if field else set()
            if field is None or not extra.partition or extra.partition not in allowed_p:
                self.issues.append(
                    gen.issue(
                        "warning",
                        "boundary_not_found",
                        f"AI partition case dropped: {extra.partition or 'its partition'} isn't a discovered class of "
                        f"{extra.field_label or 'the field'}",
                        extra.title,
                    )
                )
                return None
        steps = [{"action": s.action, "data": [], "expected": s.expected} for s in extra.steps]
        if data_mk:
            steps[0]["data"] = data_mk
            if "{d0}" not in steps[0]["action"]:
                steps[0]["action"] = f"{steps[0]['action']} (uses {{d0}})"
        label = gen.classify(extra.expected_result, req.provenance, extra.classification)
        return gen.CaseDraft(
            match_key=f"ai:{req.match_key}|{normalise(extra.title)[:80]}",
            condition_match_key=None,
            coverage_item=f"ai:{normalise(extra.title)[:40]}",
            title=extra.title,
            objective=extra.objective,
            preconditions=["Signed out"],
            steps=steps,
            expected_result=extra.expected_result,
            technique=extra.technique,
            test_type=gen.test_type_for(req),
            test_level="system",
            requirement_lineages=[req.lineage_id],
            ac_lineages=[],
            provenance=label,
            rule_id="design.ai",
            explanation=f"Proposed by AI for {req.key}; values were checked against the discovered constraints",
            automation=("suitable", f"{gen.PRELIMINARY} Scriptable: fixed inputs and a visible result."),
            feature_ids=list(req.feature_ids),
            generated_by="ai",
        )


def data_label(d: TestData) -> str:
    """How a data item appears in step wording: its key plus a short description, never a secret value."""
    if d.kind == TestDataKind.secret_ref:
        return f"{d.key} (the saved test account's {'password' if 'password' in d.name.lower() else 'username'}" + (
            ", altered so it is wrong)" if "altered" in d.name.lower() else ")"
        )
    if d.value_type == TestDataValueType.empty:
        return f"{d.key} (empty)"
    if d.kind == TestDataKind.boundary and d.length is not None:
        return f"{d.key} ({d.length} character{'s' if d.length != 1 else ''})"
    short = d.name.split(" · ", 1)[-1]
    return f"{d.key} ({short})"


def counts(cases: list[TestCase], conds: list[TestCondition], data: list[TestData]) -> dict[str, Any]:
    def tally(values: list[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        for v in values:
            out[v] = out.get(v, 0) + 1
        return dict(sorted(out.items()))

    return {
        "conditions": len(conds),
        "cases": len(cases),
        "data": len(data),
        "by_technique": tally([c.technique for c in cases]),
        "by_type": tally([c.test_type for c in cases]),
        "by_status": {s.value: sum(1 for c in cases if c.status == s) for s in CaseStatus},
    }


def _unsafe(text: str) -> bool:
    return any(code in ("literal_secret", "non_synthetic_data", "unresolved_placeholder") for code in text_lint(text))


def _case_length(case: gen.CaseDraft, out: gen.DesignOutput) -> int | None:
    for st in case.steps:
        for mk in st.get("data", []):
            d = out.data.get(mk)
            if d is not None and d.kind == "boundary":
                return d.length
    return None


def _uuid(raw: str | None) -> uuid.UUID | None:
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        return None


def _int(raw: Any) -> int | None:
    try:
        return int(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


STAGE = StageKey.test_design
