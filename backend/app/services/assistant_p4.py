"""AI QA Analyst v3 (P4-13): execution and defect intents, grounded in stored runs only.

Deterministic, AI off: `execution_results` (latest finished run), `explain_failed_test`, `analyse_defect`,
`list_defects`, `automation_status`. Proposal: `propose_rerun` creates a run **request** when accepted; it still
needs G7 from someone who can approve gates (the assistant never authorises, approves or confirms anything).
Causes are hypotheses unless a person set them; numbers come from the same rows the API serves.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.db.models import (
    AutomationAssessment,
    AutomationScript,
    Defect,
    DefectLink,
    DefectOccurrence,
    ExecutionResult,
    ExecutionRun,
    TestCase,
)
from app.domain.defects import classify as cl
from app.domain.enums import DefectStatus, ResultStatus, RunStatus, StageKey
from app.services import serialize_p2 as out

if TYPE_CHECKING:
    from app.services.assistant import Answer, Turn

RUN_KEY = re.compile(r"\bRUN-\d{2,6}(?:-\d{2,4})?\b")
FINISHED = (RunStatus.passed, RunStatus.failed, RunStatus.error, RunStatus.cancelled)
NOT_PASSED = (ResultStatus.failed, ResultStatus.error, ResultStatus.flaky)
NO_RUNS = "No tests have been run for this project, so there are no results to report."
STATUS_TEXT = {
    "draft": "draft (waiting for Gate 8)",
    "confirmed": "confirmed",
    "rejected": "rejected",
    "fixed": "marked fixed",
    "verified": "verified",
    "closed": "closed",
}
NEXT_FOR = {
    "draft": "Someone who can approve gates confirms or rejects it at Gate 8.",
    "confirmed": "A developer fixes it, then a member marks it fixed.",
    "fixed": "Re-run its test cases; when they pass, someone who can approve gates marks it verified.",
    "verified": "Nothing: the fix was verified.",
    "rejected": "Nothing: it was rejected at Gate 8.",
    "closed": "Nothing: it is closed.",
}


def _a(content: str, intent: str) -> Answer:
    from app.services.assistant import Answer

    return Answer(content, intent)


def _follow(intent: str, **params: Any) -> dict[str, Any]:
    from app.services.assistant import _follow as f

    return f(intent, **params)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def totals_line(t: dict[str, Any]) -> str:
    g = {k: int(t.get(k) or 0) for k in ("passed", "failed", "flaky", "error", "blocked", "skipped")}
    tests = int(t.get("tests") or sum(g.values()))
    return (
        f"{g['passed']} passed · {g['failed']} failed · {g['flaky']} flaky · {g['error']} errors · "
        f"{g['blocked']} blocked · {g['skipped']} skipped ({_plural(tests, 'test')})"
    )


def run_ref(project_id: uuid.UUID, run: ExecutionRun) -> dict[str, Any]:
    return out.artefact_ref(project_id, "execution_run", run.id, run.key, f"Test run {run.key}")


def result_ref(project_id: uuid.UUID, r: ExecutionResult, case_key: str | None) -> dict[str, Any]:
    return out.artefact_ref(project_id, "execution_result", r.id, r.key, f"{r.key} · {case_key or 'test'}")


def defect_ref(project_id: uuid.UUID, d: Defect) -> dict[str, Any]:
    return out.artefact_ref(project_id, "defect", d.id, d.key, f"{d.key} {d.summary[:80]}")


async def latest_run(t: Turn, finished: bool = True) -> ExecutionRun | None:
    q = select(ExecutionRun).where(ExecutionRun.project_id == t.project_id)
    if finished:
        q = q.where(ExecutionRun.status.in_(FINISHED), ExecutionRun.finished_at.is_not(None))
    return (await t.s.execute(q.order_by(ExecutionRun.created_at.desc()).limit(1))).scalar_one_or_none()


async def _case_keys(t: Turn, ids: set[uuid.UUID]) -> dict[uuid.UUID, TestCase]:
    if not ids:
        return {}
    return {c.id: c for c in (await t.s.execute(select(TestCase).where(TestCase.id.in_(ids)))).scalars()}


NOT_ANALYSED = "Not analysed"


def _cause(r: ExecutionResult) -> str:
    a = r.analysis or {}
    label = a.get("label") or (cl.LABELS.get(r.classification.value) if r.classification else None)
    if not label:
        return NOT_ANALYSED  # nothing was concluded, so it isn't a hypothesis (QA P4-BUG-12)
    return f"{label} (set by a person)" if a.get("overridden") else f"{label} (hypothesis)"


async def last_result_line(t: Turn, a: Answer, case: Any) -> str:
    """ "Last result" sentence for a test case (stored runs only)."""
    lineage = uuid.UUID(str(getattr(case, "lineage_id", "")))
    r = (
        await t.s.execute(
            select(ExecutionResult)
            .where(ExecutionResult.project_id == t.project_id, ExecutionResult.case_lineage_id == lineage)
            .order_by(ExecutionResult.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if r is None:
        return "It hasn't been run yet."
    return f"Last result: {r.status.value} in {a.cite(result_ref(t.project_id, r, getattr(case, 'key', None)))}."


# ------------------------------------------------------------------ intents


async def execution_results(t: Turn, _p: dict[str, Any]) -> Answer:
    run = await latest_run(t)
    if run is None:
        a = _a(NO_RUNS, "execution_results")
        pending = await latest_run(t, finished=False)
        if pending is not None:
            what = (
                "is waiting for authorisation (Gate 7)"
                if pending.status == RunStatus.awaiting_authorisation
                else f"is {pending.status.value}"
            )
            a.content += f" {a.cite(run_ref(t.project_id, pending))} {what}."
        a.notice("no_execution_data", "I never report results that don't exist.")
        return a
    a = _a("", "execution_results")
    from app.services import execution as xsvc

    totals = await xsvc.totals(t.s, run)
    lines = [f"{a.cite(run_ref(t.project_id, run))} ({run.status.value}): {totals_line(totals)}."]
    if run.status == RunStatus.cancelled:
        lines.append("The run was cancelled; tests that didn't finish are not counted as passed.")
    rows = list(
        (
            await t.s.execute(
                select(ExecutionResult)
                .where(ExecutionResult.execution_run_id == run.id, ExecutionResult.status.in_(NOT_PASSED))
                .order_by(ExecutionResult.key)
            )
        ).scalars()
    )
    cases = await _case_keys(t, {r.test_case_id for r in rows if r.test_case_id})
    if rows:
        lines.append("Not passed, by likely cause (causes are hypotheses unless a person confirmed them):")
        groups: dict[str, list[ExecutionResult]] = {}
        for r in rows:
            groups.setdefault(_cause(r), []).append(r)
        for cause, items in groups.items():
            refs = []
            for r in items[:10]:
                case = cases.get(r.test_case_id) if r.test_case_id else None
                d = (r.analysis or {}).get("defect")
                tail = f" → {d['key']}" if d and d.get("key") else ""
                refs.append(f"{a.cite(result_ref(t.project_id, r, case.key if case else None))} "
                            f"({case.key if case else 'test'}, {r.status.value}){tail}")  # fmt: skip
            lines.append(f"- {cause}: " + "; ".join(refs))
        first = rows[0]
        a.follow_ups = [_follow("explain_failed_test", key=first.key), _follow("propose_rerun", only_failed=True)]
    else:
        lines.append("Every test that ran passed.")
    a.content = "\n".join(lines)
    return a


async def _result_for(t: Turn, key: str) -> tuple[ExecutionResult | None, TestCase | None]:
    key = key.upper()
    if RUN_KEY.fullmatch(key) and key.count("-") == 2:
        r = (
            await t.s.execute(
                select(ExecutionResult).where(ExecutionResult.project_id == t.project_id, ExecutionResult.key == key)
            )
        ).scalar_one_or_none()
        case = await t.s.get(TestCase, r.test_case_id) if r is not None and r.test_case_id else None
        return r, case
    case = (
        await t.s.execute(
            select(TestCase)
            .where(TestCase.project_id == t.project_id, TestCase.key == key)
            .order_by(TestCase.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if case is None:
        return None, None
    r = (
        await t.s.execute(
            select(ExecutionResult)
            .where(ExecutionResult.case_lineage_id == case.lineage_id, ExecutionResult.status.in_(NOT_PASSED))
            .order_by(ExecutionResult.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return r, case


async def explain_failed_test(t: Turn, p: dict[str, Any]) -> Answer:
    key = str(p.get("key") or "").upper()
    if not key:
        run = await latest_run(t)
        first = None
        if run is not None:
            first = (
                await t.s.execute(
                    select(ExecutionResult)
                    .where(ExecutionResult.execution_run_id == run.id, ExecutionResult.status.in_(NOT_PASSED))
                    .order_by(ExecutionResult.key)
                    .limit(1)
                )
            ).scalar_one_or_none()
        if first is None:
            return _a(NO_RUNS if run is None else "No test failed in the latest run.", "explain_failed_test")
        key = first.key
    r, case = await _result_for(t, key)
    if r is None:
        msg = (
            f"{key} hasn't failed in any stored run."
            if case is not None
            else f"I can't find {key} in this project's test results."
        )
        return _a(msg, "explain_failed_test")
    a = _a("", "explain_failed_test")
    an = r.analysis or {}
    step = (r.failed_step or {}).get("title")
    where = f", at step '{step}'" if step else ""
    case_part = f"{a.cite(out.artefact_ref(t.project_id, 'test_case', case.id, case.key, case.title))} {case.title}" if case else "this test"  # fmt: skip
    lines = [
        f"{a.cite(result_ref(t.project_id, r, case.key if case else None))} ({case_part}) {r.status.value}{where}."
    ]
    if not an:
        lines.append("It hasn't been analysed yet.")
    else:
        code = str(an.get("classification") or "unknown")
        how = "set by a person" if an.get("overridden") else "Hypothesis"
        lines.append(f"Likely cause: {an.get('label')} (`{code}`) · Confidence: {str(an.get('confidence') or 'low').capitalize()} · {how}.")  # fmt: skip
        sigs = [s for s in an.get("signals") or [] if s.get("detail")]
        if sigs:
            lines.append("Signals:")
            lines += [f"- {s['detail']}{' (observed)' if s.get('observed') else ''}" for s in sigs[:6]]
    if case is not None and case.expected_result:
        lines.append(f"Expected: {case.expected_result}")
    if r.actual_result:
        lines.append(f"Actual: {r.actual_result[:500]}")
    d = an.get("defect")
    if d and d.get("key"):
        row = (await t.s.execute(select(Defect).where(Defect.id == uuid.UUID(str(d["id"]))))).scalar_one_or_none()
        if row is not None:
            lines.append(f"Defect: {a.cite(defect_ref(t.project_id, row))} ({STATUS_TEXT[row.status.value]}).")
            a.follow_ups.append(_follow("analyse_defect", key=row.key))
    elif an.get("no_defect") == "flaky":
        lines.append("No defect was drafted: it passed on the retry (flaky).")
    elif an.get("no_defect") == "low_confidence":
        lines.append("No defect was drafted: confidence is low. A member can raise one from the result page.")
    if r.heal_suggestions:
        first = (r.heal_suggestions or [{}])[0]
        cands = first.get("candidates") or []
        if cands:
            lines.append(f"A fix suggestion is ready: use {cands[0].get('expression')} in {first.get('asset_path')}.")
    a.content = "\n".join(lines)
    a.follow_ups.append(_follow("propose_rerun", case_keys=[case.key] if case else []))
    return a


async def _defect(t: Turn, key: str) -> Defect | None:
    return (
        await t.s.execute(select(Defect).where(Defect.project_id == t.project_id, Defect.key == key.upper()))
    ).scalar_one_or_none()


async def analyse_defect(t: Turn, p: dict[str, Any]) -> Answer:
    key = str(p.get("key") or "").upper()
    d = await _defect(t, key) if key else None
    if d is None:
        return _a(f"I can't find {key or 'that defect'} in this project.", "analyse_defect")
    a = _a("", "analyse_defect")
    rep = d.reproducibility or {}
    lines = [
        f"{a.cite(defect_ref(t.project_id, d))}: {d.summary}",
        f"Status: {STATUS_TEXT[d.status.value]} · Severity: {d.severity.value} · Priority: {d.priority.value}.",
    ]
    if rep:
        lines.append(f"Reproducibility: {rep.get('text') or rep}.")
    if d.expected:
        lines.append(f"Expected: {d.expected}")
    if d.actual:
        lines.append(f"Actual: {d.actual[:500]}")
    occ = list((await t.s.execute(select(DefectOccurrence).where(DefectOccurrence.defect_id == d.id))).scalars())
    lines.append(f"Seen {_plural(max(len(occ), int(rep.get('occurrences') or 1)), 'time')}.")
    links = list((await t.s.execute(select(DefectLink).where(DefectLink.defect_id == d.id))).scalars())
    lineages = {x.test_case_lineage_id for x in links if x.test_case_lineage_id}
    if lineages:
        cases = (
            await t.s.execute(
                select(TestCase).where(TestCase.lineage_id.in_(lineages)).order_by(TestCase.version.desc())
            )
        ).scalars()
        seen: dict[uuid.UUID, TestCase] = {}
        for c in cases:
            seen.setdefault(c.lineage_id, c)
        refs = [a.cite(out.artefact_ref(t.project_id, "test_case", c.id, c.key, c.title)) for c in seen.values()]
        lines.append("Linked test cases: " + ", ".join(sorted(refs)) + ".")
    if d.execution_result_id:
        r = await t.s.get(ExecutionResult, d.execution_result_id)
        if r is not None:
            lines.append(f"Found by {a.cite(result_ref(t.project_id, r, None))}.")
    missing = []
    if not d.evidence_refs:
        missing.append("evidence")
    if not d.steps:
        missing.append("reproduction steps")
    if not d.root_cause_hypothesis:
        missing.append("a root-cause hypothesis (optional)")
    lines.append(f"Next: {NEXT_FOR[d.status.value]}")
    if missing:
        lines.append("Missing: " + ", ".join(missing) + ".")
    a.content = "\n".join(lines)
    return a


async def list_defects(t: Turn, p: dict[str, Any]) -> Answer:
    q = select(Defect).where(Defect.project_id == t.project_id)
    status = str(p.get("status") or "").lower()
    if status in DefectStatus.__members__:
        q = q.where(Defect.status == DefectStatus(status))
    if p.get("severity"):
        q = q.where(Defect.severity == str(p["severity"]).lower())
    rows = list((await t.s.execute(q.order_by(Defect.key))).scalars())
    a = _a("", "list_defects")
    if not rows:
        a.content = "There are no defects" + (f" with status {status}." if status else " in this project yet.")
        return a
    counts = Counter(d.status.value for d in rows)
    head = ", ".join(f"{n} {s}" for s, n in sorted(counts.items()))
    lines = [f"{_plural(len(rows), 'defect')}: {head}."]
    lines += [
        f"- {a.cite(defect_ref(t.project_id, d))} {d.summary} · {d.severity.value} · {STATUS_TEXT[d.status.value]}"
        for d in rows[:20]
    ]
    a.content = "\n".join(lines)
    if counts.get("draft"):
        a.follow_ups.append(_follow("list_defects", status="draft"))
    return a


async def automation_status(t: Turn, _p: dict[str, Any]) -> Answer:
    from app.services import automation as asvc

    a = _a("", "automation_status")
    arun = await asvc.current_run(t.s, t.project_id, StageKey.automation_assessment)
    if arun is None:
        a.content = "Automation hasn't been assessed yet: it starts after Gate 5 approves the test cases."
        return a
    rows = list(
        (await t.s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == arun.id))).scalars()
    )
    suit = Counter(r.suitability.value for r in rows)
    lines = [
        f"Of {_plural(len(rows), 'approved test case')}: {suit.get('suitable', 0)} can be automated, "
        f"{suit.get('partial', 0)} need test credentials, {suit.get('manual_only', 0)} need a person."
    ]
    bundle = await asvc.current_run(t.s, t.project_id, StageKey.automation)
    if bundle is not None:
        scripts: list[AutomationScript] = (await asvc.bundle_rows(t.s, bundle.id))[0]
        states = Counter(asvc.script_state(x) for x in scripts)
        lines.append(
            f"Scripts version {bundle.version}: {states.get('valid', 0)} valid, {states.get('invalid', 0)} can't run, "
            f"{states.get('needs_review', 0)} need review, {states.get('outdated', 0)} outdated, "
            f"{states.get('not_checked', 0)} not checked."
        )
        cases = await _case_keys(t, {x.test_case_id for x in scripts})
        bad = [
            cases[x.test_case_id].key for x in scripts if asvc.script_state(x) == "invalid" and x.test_case_id in cases
        ]
        if bad:
            lines.append("Can't run: " + ", ".join(sorted(bad)[:12]) + ".")
    a.content = "\n".join(lines)
    return a


async def propose_rerun(t: Turn, p: dict[str, Any]) -> Answer:
    keys = [str(k).upper() for k in p.get("case_keys") or [] if k]
    a = _a("", "propose_rerun")
    if not keys:
        run = await latest_run(t)
        if run is None:
            a.content = NO_RUNS
            return a
        rows = (
            await t.s.execute(
                select(ExecutionResult).where(
                    ExecutionResult.execution_run_id == run.id, ExecutionResult.status.in_(NOT_PASSED)
                )
            )
        ).scalars()
        cases = await _case_keys(t, {r.test_case_id for r in rows if r.test_case_id})
        keys = sorted({c.key for c in cases.values()})
        if not keys:
            a.content = f"Nothing failed in {a.cite(run_ref(t.project_id, run))}, so there is nothing to re-run."
            return a
        a.cite(run_ref(t.project_id, run))
    if not t.can_edit:
        a.content = "Viewers can't request test runs. Ask a member of the project."
        return a
    summary = f"Request a run of {_plural(len(keys), 'test case')}: {', '.join(keys[:10])}"
    a.content = (
        f"{summary}. Accepting creates a run request; it starts only after someone who can approve gates "
        "authorises it (Gate 7)."
    )
    a.proposals.append(
        {
            "kind": "request_run",
            "target": None,
            "target_type": "execution_run",
            "target_id": None,
            "target_lineage_id": None,
            "summary": summary[:300],
            "payload": {"case_keys": keys, "browsers": ["chromium"], "viewports": ["desktop"]},
            "preview": [{"case_key": k} for k in keys],
            "base_versions": {},
        }
    )
    return a


async def apply(ctx: Any, s: Any, p: Any, pr: Any) -> list[dict[str, Any]]:
    """Accepting `request_run`: a run request in `awaiting_authorisation` (never a running run)."""
    from app.api.errors import Conflict, GateBlocked
    from app.api.routers import p2common as c
    from app.services import execution as xsvc

    payload = pr.payload or {}
    project = await c.project_of(s, pr.project_id)
    try:
        run = await _create(ctx, s, p, pr, project, payload, xsvc)
    except Conflict as exc:  # not a stale target: the run can't be requested now (say why)
        raise GateBlocked(exc.message) from None
    return [run_ref(pr.project_id, run)]


async def _create(ctx: Any, s: Any, p: Any, pr: Any, project: Any, payload: dict[str, Any], xsvc: Any) -> Any:
    return await xsvc.create_run(
        ctx,
        s,
        project,
        p.user,
        suite=None,
        case_keys=list(payload.get("case_keys") or []),
        browsers=list(payload.get("browsers") or ["chromium"]),
        viewports=list(payload.get("viewports") or ["desktop"]),
        notes=f"Requested from assistant proposal {pr.key}",
    )


async def resolve(s: Any, project_id: uuid.UUID, keys: set[str]) -> dict[str, dict[str, Any]]:
    """Citation guard: RUN-, RUN-n-n, DEF- and APR- keys of this project."""
    from app.db.models import Approval

    found: dict[str, dict[str, Any]] = {}
    runs = {k for k in keys if k.startswith("RUN-") and k.count("-") == 1}
    results = {k for k in keys if k.startswith("RUN-") and k.count("-") == 2}
    defects = {k for k in keys if k.startswith("DEF-")}
    approvals = {k for k in keys if k.startswith("APR-")}
    if runs:
        for r in (
            await s.execute(
                select(ExecutionRun).where(ExecutionRun.project_id == project_id, ExecutionRun.key.in_(runs))
            )
        ).scalars():
            found[r.key] = run_ref(project_id, r)
    if results:
        for x in (
            await s.execute(
                select(ExecutionResult).where(
                    ExecutionResult.project_id == project_id, ExecutionResult.key.in_(results)
                )
            )
        ).scalars():
            found[x.key] = result_ref(project_id, x, None)
    if defects:
        for d in (
            await s.execute(select(Defect).where(Defect.project_id == project_id, Defect.key.in_(defects)))
        ).scalars():
            found[d.key] = defect_ref(project_id, d)
    if approvals:
        for ap in (
            await s.execute(select(Approval).where(Approval.project_id == project_id, Approval.key.in_(approvals)))
        ).scalars():
            found[ap.key] = {"type": "approval", "id": str(ap.id), "key": ap.key, "label": ap.key, "path": None}
    return found
