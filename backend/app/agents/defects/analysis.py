"""Defect Analysis Agent, rule path (P4-08): the `failure_analysis` stage, one stage run per finished execution run.

Every failed, errored and flaky result of the run gets a hypothesis from `domain/defects/classify.py` with the
signals behind it; the result's status never changes. Likely application bugs at medium or high confidence become
defect drafts (or a new occurrence of the open defect for the same case and failed step). Results of a cancelled
run's unfinished tests are not analysed. AI off: code only.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from typing import Any

from sqlalchemy import or_, select, true

from app.agents.phase2 import StageOutcome
from app.context import AppContext
from app.db.models import (
    AutomationScript,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    Project,
    StageRun,
    TestCase,
)
from app.db.tenant import TenantScope, bind_scope
from app.domain.change import heal as hd
from app.domain.defects import classify as cl
from app.domain.enums import EvidenceKind, FailureClass, GeneratedBy, HealStatus, ResultStatus
from app.services import defects as dsvc
from app.services import execution as xsvc
from app.services import repairs as repairs_svc

log = logging.getLogger(__name__)
ANALYSED = (ResultStatus.failed, ResultStatus.error, ResultStatus.flaky)
NOT_ANALYSED = xsvc.NOT_RESULTS
ORDER = [
    "application_defect",
    "unknown",
    "selector_failure",
    "script_defect",
    "test_data_issue",
    "environment_failure",
    "network_failure",
    "flaky",
]


def counts_sentence(counts: Counter[str]) -> str:
    words = {
        "application_defect": ("likely bug in the application", "likely bugs in the application"),
        "selector_failure": ("element not found", "elements not found"),
        "script_defect": ("problem in a test script", "problems in test scripts"),
        "test_data_issue": ("test data problem", "test data problems"),
        "environment_failure": ("environment problem", "environment problems"),
        "network_failure": ("site unreachable", "site unreachable"),
        "flaky": ("flaky", "flaky"),
        "unknown": ("cause unclear", "causes unclear"),
    }
    return ", ".join(f"{counts[k]} {words[k][0 if counts[k] == 1 else 1]}" for k in ORDER if counts.get(k))


class FailureAnalysisAgent:
    implemented = True

    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id

    async def _text(self, ev: Evidence | None) -> str:
        if ev is None:
            return ""
        try:
            return (await self.ctx.storage.get(ev.storage_key)).decode("utf-8", "replace")[-20_000:]
        except (OSError, KeyError):
            return ""

    async def _suggest_fixes(self, items: list[tuple[uuid.UUID, str]]) -> set[str]:
        """Fix suggestions for "Element not found" results (§9.3): the live page is only loaded, never changed.
        Returns the ids of the results that got one."""
        from app.services import heal

        ready: set[str] = set()
        for result_id, error in items[:10]:
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                r = await s.get(ExecutionResult, result_id)
                if r is None:
                    continue
                found = await heal.suggest(self.ctx, self.scope, self.project_id, r, error)
                if found:
                    r.heal_suggestions = found
                    r.analysis = {**(r.analysis or {}), "fix_suggestion": True}
                    await s.commit()
                    ready.add(str(result_id))
        await self._repairs(items)
        return ready

    async def _repairs(self, items: list[tuple[uuid.UUID, str]]) -> None:
        """P6-04: the same failures as repair suggestions (HEAL-…), ranked and verified on the live page, and a failed
        text check as an "Expected result may be out of date" review. Never fails the analysis."""
        from app.services import repairs

        for result_id, error in items[:10]:
            try:
                await repairs.propose_from_failure(self.ctx, self.scope, self.project_id, result_id, error)
            except Exception:  # a repair suggestion is a hint; the analysis stands without it
                log.warning("repair suggestion for a failed result couldn't be made", exc_info=True)

    async def run(self) -> StageOutcome:
        from app.services import approvals as apr

        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            srun = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            run_id = uuid.UUID(str((srun.parameters or {})["execution_run_id"]))
            run = (await s.execute(select(ExecutionRun).where(ExecutionRun.id == run_id))).scalar_one()
            project = (await s.execute(select(Project).where(Project.id == self.project_id))).scalar_one()
            _origin, host = await apr.target(s, project.id)
            results = list(
                (
                    await s.execute(
                        select(ExecutionResult)
                        .where(ExecutionResult.execution_run_id == run.id, ExecutionResult.status.in_(ANALYSED))
                        .order_by(ExecutionResult.key)
                    )
                ).scalars()
            )
            plan = {i["key"]: i for i in (run.config or {}).get("plan") or []}
            counts: Counter[str] = Counter()
            groups: dict[str, list[dict[str, Any]]] = {}
            drafted: list[tuple[str, str]] = []
            heal_for: list[tuple[uuid.UUID, str]] = []
            text_for: list[tuple[uuid.UUID, str]] = []  # P6-04: failed text checks (expected result may be out of date)
            analysed = 0
            for r in results:
                if r.status == ResultStatus.error and (r.error or "") in NOT_ANALYSED:
                    continue
                case = await s.get(TestCase, r.test_case_id) if r.test_case_id else None
                script = await s.get(AutomationScript, r.automation_script_id) if r.automation_script_id else None
                evidence = list(
                    (await s.execute(select(Evidence).where(Evidence.execution_result_id == r.id))).scalars()
                )
                last = max([int((e.meta or {}).get("attempt") or 1) for e in evidence] or [1])
                pick = {e.kind: e for e in evidence if int((e.meta or {}).get("attempt") or 1) == last}
                rel = await repairs_svc.related(s, script) if script else []
                # An accepted repair changes the script's page object: results before it aren't "the same script"
                # for the flaky rule (QA P6-04 R3).
                fixed_at = max((x.decided_at for x in rel if x.status == HealStatus.accepted and x.decided_at),
                               default=None)  # fmt: skip
                history = [
                    (v, st.value)
                    for v, st in (
                        await s.execute(
                            select(ExecutionResult.script_version, ExecutionResult.status)
                            .where(
                                ExecutionResult.case_lineage_id == r.case_lineage_id,
                                ExecutionResult.execution_run_id != run.id,
                                # Results recorded by hand never make an automated failure look flaky (P4-14a).
                                ExecutionResult.recorded_by.is_(None),
                                ExecutionResult.created_at > fixed_at if fixed_at else true(),
                                # Cancelled or skipped rows are not results; they never make a test look flaky.
                                or_(ExecutionResult.error.is_(None), ExecutionResult.error.not_in(NOT_ANALYSED)),
                            )
                            .order_by(ExecutionResult.created_at.desc())
                            .limit(5)
                        )
                    ).all()
                ]
                assertions = list(script.assertion_map or []) if script else []
                # P6-04 (QA): repairs and reviews that concern this script (a test problem only when the failed check
                # goes through a repaired element), and a rescan that changed the failed page after the open defect
                # for this case was raised (context only: a defect that is still there keeps being linked).
                # The window closes at the case's first passed result after the repair (QA P6-04 R3).
                through = repairs_svc.involved(rel, assertions, r.error or "")
                passed = await repairs_svc.proven(s, through, r.case_lineage_id)
                page_changed_by = None
                if case is not None:
                    cs, changed = await repairs_svc.changed_pages(s, project.id)
                    page = str((r.page_state or {}).get("url") or "").split("?", 1)[0]
                    dup = await dsvc.open_duplicate(s, project.id, case.lineage_id, (r.failed_step or {}).get("title"))
                    if cs is not None and dup is not None and page in changed and dup.created_at <= cs.created_at:
                        page_changed_by = f"{cs.key} changed {page} after {dup.key} was raised"
                fi = cl.FailureInput(
                    status=r.status.value,
                    error=r.error or "",
                    attempts=[{"status": a.get("status"), "error": a.get("error")} for a in r.steps or []],
                    steps=list(((r.steps or [{}])[-1] or {}).get("steps") or []) if r.steps else [],
                    failed_step=r.failed_step,
                    page_state=r.page_state,
                    network_log=await self._text(pick.get(EvidenceKind.network_log)),
                    console_log=await self._text(pick.get(EvidenceKind.console_log)),
                    target_host=host,
                    expected_result=case.expected_result if case else "",
                    expects_sign_in_failure="not signed in" in (case.expected_result.lower() if case else ""),
                    assertions=assertions,
                    history=history,
                    script_version=r.script_version,
                    repairs=[repairs_svc.context_line(x) for x in rel if x.id not in through],
                    repaired=[repairs_svc.context_line(x) for x in through if x.id not in passed],
                    proven=[repairs_svc.context_line(x) for x in through if x.id in passed],
                    page_changed_by=page_changed_by,
                )
                a = cl.classify(fi)
                out = a.as_dict()
                out["case_key"] = (plan.get(r.key) or {}).get("case_key") or (case.key if case else None)
                refs = [{"evidence_id": str(e.id), "kind": e.kind.value} for e in pick.values()]
                out["evidence_refs"] = refs
                if rel:
                    out["repairs"] = [{"id": str(x.id), "key": x.key, "status": x.status.value} for x in rel]
                if a.classification == "application_defect" and a.confidence in ("medium", "high") and case:
                    d, created = await dsvc.draft_from_result(s, project, r, case, out, assertions)
                    out["defect"] = {
                        "id": str(d.id),
                        "key": d.key,
                        "status": d.status.value,
                        "summary": d.summary,
                        "occurrence": not created,
                    }
                    if created:
                        drafted.append((d.key, d.summary))
                elif a.classification == "flaky":
                    out["no_defect"] = "flaky"
                elif a.classification == "application_defect":
                    out["no_defect"] = "low_confidence"
                else:
                    out["no_defect"] = "not_application"
                r.classification = FailureClass(a.classification)
                r.analysis = out
                if a.classification == "selector_failure":
                    heal_for.append((r.id, r.error or ""))
                elif hd.failed_text_review(r.error or "", dict(r.page_state or {}), lineage="", case_key="",
                                           result_key="") is not None:  # fmt: skip
                    text_for.append((r.id, r.error or ""))
                counts[a.classification] += 1
                analysed += 1
                groups.setdefault(a.classification, []).append(
                    {
                        "result_id": str(r.id),
                        "result_key": r.key,
                        "case_key": out["case_key"],
                        "signal": a.signals[0]["detail"] if a.signals else "",
                        "defect": out.get("defect"),
                    }
                )
            await s.commit()
        ready = await self._suggest_fixes(heal_for)
        await self._repairs(text_for)
        # The run's frozen Test Execution Report, with the causes just worked out (design §13).
        from app.agents.reporting.phase4_reports import freeze_for_run

        await freeze_for_run(self.ctx, self.scope, self.project_id, run_id)
        for item in groups.get("selector_failure", []):
            item["fix_suggestion"] = item["result_id"] in ready
        by_class = {k: counts[k] for k in ORDER if counts.get(k)}
        output = {
            "execution_run_id": str(run_id),
            "run_key": run.key,
            "analysed": analysed,
            "by_classification": by_class,
            "groups": [{"classification": k, "label": cl.LABELS[k], "items": groups[k]} for k in ORDER if k in groups],
            "drafted": [k for k, _ in drafted],
        }
        events: list[tuple[str, str, dict[str, Any]]] = [
            (
                "failure_analysis.completed",
                f"Analysed {analysed} result{'s' if analysed != 1 else ''}: {counts_sentence(counts)}"
                if analysed
                else f"Nothing to analyse in {run.key}",
                {"kind": "result", "run_key": run.key, "by_classification": by_class},
            )
        ]
        for key, summary in drafted:
            events.append(("defect.drafted", f"Drafted {key}: {summary}", {"kind": "result", "defect_key": key}))
        return StageOutcome(output=output, generated_by=GeneratedBy.rules, events=events)
