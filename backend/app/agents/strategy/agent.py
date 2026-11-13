"""Test Strategy Agent (agent C, P2-06): strategy sections and the risk register from the G3-approved input.

Input is the approved requirements only (drafts are excluded until approved). Rules always produce the baseline;
the AI path may refine rationales and propose extra risks, which must link existing requirements or features
(anything else is dropped with a validation issue). Score and level are computed in code.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.phase2 import StageOutcome, filter_refs, is_candidate_run, load_discovery, project_evidence_ids
from app.agents.strategy import rules
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    Project,
    ProjectSecret,
    ReadinessCriterion,
    Risk,
    StageRun,
    TestStrategy,
    risk_features,
    risk_requirements,
)
from app.db.tenant import TenantScope, bind_scope
from app.domain.enums import (
    GeneratedBy,
    Provenance,
    ReadinessStatus,
    RequirementStatus,
    RiskCategory,
    RiskStatus,
    StageKey,
    StrategyStatus,
)
from app.domain.risk import requires_approval, risk_level, risk_score
from app.llm.base import Budget, UntrustedBlock
from app.services import gates, review
from app.services.adapters import RISK
from app.services.counters import next_key

TestType = Literal[
    "functional",
    "smoke",
    "sanity",
    "regression",
    "exploratory",
    "usability",
    "accessibility",
    "compatibility",
    "security",
    "performance",
    "load",
    "stress",
    "spike",
    "endurance",
]
Technique = Literal[
    "equivalence_partitioning",
    "boundary_value_analysis",
    "decision_table",
    "state_transition",
    "use_case",
    "error_guessing",
    "exploratory",
]


class AiRisk(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=5, max_length=160)
    description: str = Field(max_length=2000)
    requirement_keys: list[str] = Field(default_factory=list, max_length=20)
    feature_keys: list[str] = Field(default_factory=list, max_length=20)
    likelihood: int = Field(ge=1, le=5)
    impact: int = Field(ge=1, le=5)
    likelihood_rationale: str = Field(max_length=500)
    impact_rationale: str = Field(max_length=500)
    test_types: list[TestType] = Field(min_length=1, max_length=6)
    techniques: list[Technique] = Field(default_factory=list, max_length=6)


class AiTypeRationale(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: TestType
    rationale: str = Field(max_length=400)


class StrategyRefinement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    extra_risks: list[AiRisk] = Field(default_factory=list, max_length=15)
    type_rationales: list[AiTypeRationale] = Field(default_factory=list, max_length=14)


TASK = """You are refining a software test strategy that rules produced from approved requirements.
Return JSON matching the schema. You may (1) improve the rationale wording of test types and (2) propose extra
product risks. Every extra risk must reference requirement keys or feature keys from the lists below; never invent
keys. Likelihood and impact are 1-5 with a short rationale each. Never set a score or level.
Requirement keys: {reqs}
Feature keys: {feats}
{guidance}"""


class StrategyAgent:
    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id
        self.issues: list[dict[str, Any]] = []
        self.llm_usage: dict[str, Any] | None = None

    async def run(self) -> StageOutcome:
        s = self.ctx.session_factory()
        bind_scope(s, self.scope)
        async with s:
            run = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            inp, req_run = await self._load(s)
            drafts = rules.build_risks(inp)
            sections = rules.build_sections(inp, drafts)
            generated_by = GeneratedBy.rules
            if self.ctx.llm.enabled:
                used = await self._ai_refine(inp, drafts, sections, run.guidance)
                generated_by = GeneratedBy.mixed if used else GeneratedBy.rules
            valid = await project_evidence_ids(
                s, self.project_id, [r.get("evidence_id") for d in drafts for r in d.evidence_refs]
            )
            for d in drafts:
                d.evidence_refs, _ = filter_refs(d.evidence_refs, valid)
            for d in drafts:
                if risk_level(d.score).value in ("high", "very_high") and not d.mitigation.get("test_types"):
                    self.issues.append(_issue("error", "risk_unmitigated", "High risk without mitigation", d.title))
            run.upstream_versions = {**(run.upstream_versions or {}), "requirements": req_run.version}
            candidate = is_candidate_run(run)
            prev_id = (run.parameters or {}).get("previous_run_id")
            prev_strategy = (
                (
                    await s.execute(select(TestStrategy).where(TestStrategy.stage_run_id == uuid.UUID(prev_id)))
                ).scalar_one_or_none()
                if prev_id
                else None
            )
            approved_input = {
                "requirements_snapshot_hash": (run.approved_input or {}).get("g3_hash"),
                "requirements_version": req_run.version,
            }
            strat = TestStrategy(
                organisation_id=self.scope.org_id,
                project_id=self.project_id,
                stage_run_id=self.run_id,
                key=(await next_key(s, self.scope.org_id, self.project_id, "TS"))[1]
                if prev_strategy is None
                else prev_strategy.key,
                version=(prev_strategy.version + 1) if prev_strategy else 1,
                status=StrategyStatus.draft,
                generated_by=generated_by,
                content=sections,
                approved_input=approved_input,
                validation_issues=self.issues,
            )
            s.add(strat)
            await s.flush()
            cand_rows = [self._risk_row(d, strat.id) for d in drafts]
            output: dict[str, Any]
            if prev_strategy is None or not candidate:
                for r in cand_rows:
                    r.key = await self._key(s)
                    s.add(r)
                    await s.flush()
                    await link_risk(s, r)
                output = {}
            else:
                cur_risks = list(
                    (await s.execute(select(Risk).where(Risk.stage_run_id == prev_strategy.stage_run_id))).scalars()
                )
                staged = await review.stage_candidates(
                    s,
                    RISK,
                    run_id=self.run_id,
                    current_rows=cur_risks,
                    candidate_rows=cand_rows,
                    rejected_lineages=set(),
                    rejected_match_keys=set(),
                    new_key=lambda _row: self._key(s),
                    overrides={"strategy_id": strat.id},
                    refresh_attrs=("evidence_refs", "factors", "requirement_lineage_ids", "feature_ids"),
                )
                for st in staged:
                    if st.row is not None:
                        st.row.score = risk_score(st.row.likelihood, st.row.impact)
                        st.row.level = risk_level(st.row.score)
                await s.flush()
                for st in staged:
                    if st.row is not None:
                        await link_risk(s, st.row)
                items = review.review_items(RISK, staged)
                for it in items:  # risks no longer found are kept by default (accepting one needs a comment)
                    if it["change"] == "no_longer_found":
                        it["default_action"] = "keep"
                items += section_review(prev_strategy, sections)
                strat.content = {
                    **sections,
                    **{k: prev_strategy.content.get(k) for k in prev_strategy.human_edited_sections},
                    **{k: prev_strategy.content.get(k) for k in prev_strategy.locked_sections},
                }
                strat.human_edited_sections = list(prev_strategy.human_edited_sections)
                strat.locked_sections = list(prev_strategy.locked_sections)
                strat.suggested_changes = {
                    k: sections.get(k)
                    for k in {*prev_strategy.human_edited_sections, *prev_strategy.locked_sections}
                    if sections.get(k) != prev_strategy.content.get(k)
                }
                output = {
                    "candidate_of": (await s.get(StageRun, uuid.UUID(prev_id))).version if prev_id else None,  # type: ignore[union-attr]
                    "review": {
                        "items": items,
                        "summary": review.summarise(items, "risk"),
                        "sections": review.summarise(items, "strategy_section"),
                    },
                }
            risks = list((await s.execute(select(Risk).where(Risk.stage_run_id == self.run_id))).scalars())
            output.update(
                {
                    "strategy_version": strat.version,
                    "plan_version": None,
                    "risks": {
                        lv: sum(1 for r in risks if r.level.value == lv)
                        for lv in ("low", "medium", "high", "very_high")
                    },
                }
            )
            await s.commit()
        return StageOutcome(
            output=output,
            generated_by=generated_by,
            validation_issues=self.issues,
            llm=self.llm_usage,
            candidate=candidate and prev_strategy is not None,
            events=[("validation.issue", i["message"], {"kind": "warning", **i}) for i in self.issues[:20]],
        )

    async def _key(self, s: AsyncSession) -> str:
        return (await next_key(s, self.scope.org_id, self.project_id, "RISK"))[1]

    def _risk_row(self, d: rules.RiskDraft, strategy_id: uuid.UUID) -> Risk:
        score = risk_score(d.likelihood, d.impact)
        return Risk(
            id=uuid.uuid4(),
            organisation_id=self.scope.org_id,
            project_id=self.project_id,
            stage_run_id=self.run_id,
            strategy_id=strategy_id,
            match_key=d.match_key[:400],
            rule_id=d.match_key.split("|")[-1][:64],
            key="",
            title=d.title[:200],
            description=d.description,
            category=RiskCategory(d.category),
            likelihood=d.likelihood,
            impact=d.impact,
            score=score,
            level=risk_level(score),
            factors=d.factors,
            likelihood_rationale=d.likelihood_rationale,
            impact_rationale=d.impact_rationale,
            mitigation=d.mitigation,
            requires_approval=requires_approval(list(d.mitigation.get("test_types", []))),
            status=RiskStatus.open,
            source="discovery",
            requirement_lineage_ids=d.requirement_lineage_ids,
            feature_ids=d.feature_ids,
            provenance=Provenance(d.provenance),
            confidence=0.6 if d.provenance == "inferred" else 0.4,
            evidence_refs=d.evidence_refs,
            generated_by=GeneratedBy.rules,
        )

    async def _load(self, s: AsyncSession) -> tuple[rules.StrategyInput, StageRun]:
        req_run, reqs = await gates.current_requirements(s, self.project_id)
        if req_run is None:
            raise RuntimeError("There are no requirements to build a strategy from")
        approved = [r for r in reqs if r.status == RequirementStatus.approved]
        project = (await s.execute(select(Project).where(Project.id == self.project_id))).scalar_one()
        loaded = await load_discovery(s, self.project_id, include_documents=False)
        if loaded is None:
            raise RuntimeError("Discovery has no results")
        data, _drun, scan = loaded
        readiness: list[dict[str, Any]] = []
        rst = await gates._stage(s, self.project_id, StageKey.readiness_criteria)
        if rst.current_stage_run_id is not None:
            readiness = [
                {"id": c.id, "key": c.key, "kind": c.kind.value, "text": c.text}
                for c in (
                    await s.execute(
                        select(ReadinessCriterion)
                        .where(
                            ReadinessCriterion.stage_run_id == rst.current_stage_run_id,
                            ReadinessCriterion.status == ReadinessStatus.active,
                        )
                        .order_by(ReadinessCriterion.sort_order)
                    )
                ).scalars()
            ]
        has_secret = (
            await s.execute(select(ProjectSecret.id).where(ProjectSecret.project_id == self.project_id).limit(1))
        ).first() is not None
        auth = scan.auth or {}
        inp = rules.StrategyInput(
            start_url=scan.start_url,
            requirements=[
                rules.Req(
                    r.id,
                    r.lineage_id,
                    r.key,
                    r.title,
                    r.category,
                    r.provenance.value,
                    r.rule_id,
                    [str(f) for f in r.feature_ids or []],
                    list(r.evidence_refs or []),
                )
                for r in approved
            ],
            features=[
                rules.Feature(
                    f.id,
                    f.key,
                    f.name,
                    f.category.value,
                    list(f.evidence_refs or []),
                    [str(p) for p in f.page_ids or []],
                )
                for f in data.features
            ],
            journeys=[{"key": j.key, "name": j.name} for j in data.journeys],
            pages=[
                rules.Page(
                    p.id, p.url, len(p.console_issues or []), len(p.network_issues or []), p.screenshot_evidence_id
                )
                for p in data.pages
            ],
            readiness=readiness,
            access_gaps=list(scan.access_gaps or []),
            signed_in_observed=auth.get("result") == "succeeded" and int(auth.get("authenticated_pages", 0)) > 0,
            credentials=has_secret,
            include_mobile=bool((project.settings or {}).get("include_mobile", True)),
            approval_policy=dict(project.approval_policy or {}),
        )
        return inp, req_run

    async def _ai_refine(
        self, inp: rules.StrategyInput, drafts: list[rules.RiskDraft], sections: dict[str, Any], guidance: str | None
    ) -> bool:
        req_keys = {r.key: r for r in inp.requirements}
        feat_keys = {f.key: f for f in inp.features}
        baseline = {
            "risks": [{"title": d.title, "likelihood": d.likelihood, "impact": d.impact} for d in drafts],
            "test_types": [{"type": t["type"], "in_scope": t["in_scope"]} for t in sections["test_types"]],
            "requirements": [{"key": r.key, "title": r.title, "category": r.category} for r in inp.requirements],
            "features": [{"key": f.key, "name": f.name, "category": f.category} for f in inp.features],
        }
        task = TASK.format(
            reqs=", ".join(sorted(req_keys)) or "none",
            feats=", ".join(sorted(feat_keys)) or "none",
            guidance=f"User guidance (from the project member): {guidance[:1000]}" if guidance else "",
        )
        result = await self.ctx.llm.structured(
            StrategyRefinement,
            task,
            [UntrustedBlock("strategy_baseline", json.dumps(baseline), max_chars=60_000)],
            Budget(max_output_tokens=self.ctx.settings.ai_max_output_tokens),
        )
        usage = (
            result.usage.as_dict() if result.usage else {"provider": self.ctx.llm.provider, "model": self.ctx.llm.model}
        )
        self.llm_usage = {**usage, "fallback_used": not result.ok}
        if not result.ok or result.value is None:
            self.issues.append(
                _issue("warning", "ai_fallback", f"AI output unusable ({result.reason}); the rule baseline is used.")
            )
            return False
        by_type = {t["type"]: t for t in sections["test_types"]}
        for tr in result.value.type_rationales:
            if tr.type in by_type and tr.rationale.strip():
                by_type[tr.type]["rationale"] = tr.rationale.strip()
        for r in result.value.extra_risks:
            unknown = [k for k in r.requirement_keys if k not in req_keys] + [
                k for k in r.feature_keys if k not in feat_keys
            ]
            if unknown or not (r.requirement_keys or r.feature_keys):
                self.issues.append(
                    _issue(
                        "warning",
                        "unknown_feature",
                        f"AI risk dropped: it links {', '.join(unknown) or 'nothing'} which doesn't exist in this project",
                        r.title,
                    )
                )
                continue
            drafts.append(
                rules.RiskDraft(
                    match_key=f"ai:{'+'.join(sorted(r.requirement_keys + r.feature_keys))}|{r.title.lower()[:60]}",
                    title=r.title,
                    description=r.description,
                    category="product",
                    likelihood=r.likelihood,
                    impact=r.impact,
                    factors=[],
                    likelihood_rationale=r.likelihood_rationale,
                    impact_rationale=r.impact_rationale,
                    mitigation={"test_types": list(r.test_types), "techniques": list(r.techniques), "notes": None},
                    requirement_lineage_ids=[str(req_keys[k].lineage_id) for k in r.requirement_keys],
                    feature_ids=[str(feat_keys[k].id) for k in r.feature_keys],
                    evidence_refs=[],
                    provenance="inferred",
                )
            )
        return True


def section_review(prev: TestStrategy, sections: dict[str, Any]) -> list[dict[str, Any]]:
    """Section-level review entries (`strategy_section`): edited or locked sections default to keep."""
    out: list[dict[str, Any]] = []
    protected = {*prev.human_edited_sections, *prev.locked_sections}
    for name in rules.SECTIONS:
        cur, new = prev.content.get(name), sections.get(name)
        if cur == new:
            continue
        reason = "locked" if name in prev.locked_sections else "human_edited" if name in protected else None
        out.append(
            {
                "type": "strategy_section",
                "change": "protected_with_proposal" if reason else "changed",
                "lineage_id": name,
                "key": name,
                "match_key": name,
                "protected_reason": reason,
                "current": {name: cur},
                "proposed": {name: new},
                "field_diff": [{"field": name, "from": cur, "to": new}],
                "default_action": "keep" if reason else "accept",
                "allowed_actions": ["accept", "keep"],
                "note": None,
            }
        )
    return out


async def link_risk(s: AsyncSession, row: Risk) -> None:
    await s.execute(risk_requirements.delete().where(risk_requirements.c.risk_id == row.id))
    await s.execute(risk_features.delete().where(risk_features.c.risk_id == row.id))
    for lid in {str(x) for x in row.requirement_lineage_ids or []}:
        await s.execute(insert(risk_requirements).values(risk_id=row.id, requirement_lineage_id=uuid.UUID(lid)))
    fids = []
    for f in row.feature_ids or []:
        try:
            fids.append(uuid.UUID(str(f)))
        except ValueError:
            continue
    if fids:
        existing = set(
            (await s.execute(select(ApplicationFeature.id).where(ApplicationFeature.id.in_(fids)))).scalars()
        )
        for fid in existing:
            await s.execute(insert(risk_features).values(risk_id=row.id, feature_id=fid))


def _issue(severity: str, code: str, message: str, item: str | None = None) -> dict[str, Any]:
    return {"severity": severity, "code": code, "message": message, "path": None, "item_key": item}
