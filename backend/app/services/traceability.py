"""TraceabilityService (P3-04): forward/backward matrix, coverage, gaps and chains, computed on read.

Links resolve by lineage, so regeneration never breaks them. `basis="current"` reads the current versions;
`basis="approved"` reads the test cases frozen in the last G5 approval (content as approved, from their revisions).
P4-12: scripts, results and defects come from the current automation bundle, the latest run that ran each case and
the defect links. Flaky results are counted separately (never as passed) and listed in their own sub-list.
P5-07: non-functional cells per requirement (open accessibility and security findings of the latest checks, threshold
results of the latest judged load test), three non-functional gap lists and chains for A11Y-, SEC- and PERF- keys.
P6-06: the latest rescan's impact per case and requirement (`impacted {change_set, level, status}`), scripts with the
reason they are outdated, three change gap lists (`scripts_outdated`, `impacted_not_rerun`,
`new_pages_without_requirements`; coverage `changes` counts are their lengths) and chains for CHG-, EXP-, HEAL- and REL-
keys.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.errors import NotFound
from app.db.models import EntityRevision, Risk, TestCase
from app.domain.enums import CaseStatus, ItemStatus, RequirementStatus, RiskStatus
from app.services import gates
from app.services import nf_evidence as nfe
from app.services import serialize_p3 as p3
from app.services import testdesign as tds
from app.services.serialize_p2 import TECHNIQUE_SHORT, artefact_ref

Basis = Literal["current", "approved"]
HIGH = ("high", "very_high")


@dataclass
class CaseView:
    """A test case as traceability sees it (current row, or the version frozen at G5)."""

    row: TestCase
    key: str
    title: str
    status: str
    technique: str
    priority: str
    requirement_lineages: list[str]
    ac_lineages: list[str]
    condition_lineage: str | None
    coverage_item: str | None

    @property
    def active(self) -> bool:
        return self.status in ("draft", "approved")


@dataclass
class Trace:
    basis: Basis
    lk: p3.Lookup
    cases: list[CaseView]
    design_version: int | None
    snapshot_hash: str | None
    risks: list[Risk] = field(default_factory=list)
    approved_at: datetime | None = None  # the last G5 approval (what basis=approved shows); None before any G5
    # P4-12, by case lineage: the current script ({file, version, state}) and the defects linked to the case.
    scripts: dict[str, dict[str, Any]] = field(default_factory=dict)
    defects: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    all_defects: list[dict[str, Any]] = field(default_factory=list)
    executed: bool = False  # any run finished in this project
    # P5-07: the latest non-functional evidence, its per-requirement cells and the pages no check covered.
    nf: nfe.NfState = field(default_factory=nfe.NfState)
    nf_cells: dict[str, dict[str, Any]] = field(default_factory=dict)
    pages_not_checked: list[dict[str, Any]] = field(default_factory=list)
    # P6-06: impact of the latest rescan change set by case and requirement lineage, and the three change gap lists.
    impacted: dict[str, dict[str, Any]] = field(default_factory=dict)
    req_impacted: dict[str, dict[str, Any]] = field(default_factory=dict)
    change_gaps: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def result(self, c: CaseView) -> dict[str, Any] | None:
        return self.lk.results.get(str(c.row.lineage_id))

    def script(self, c: CaseView) -> dict[str, Any] | None:
        return self.scripts.get(str(c.row.lineage_id))

    def case_ref(self, c: CaseView) -> dict[str, Any]:
        short = TECHNIQUE_SHORT.get(c.technique, c.technique)
        label = f"{c.key} · {c.status.capitalize()} · {short}"
        return artefact_ref(self.lk.project_id, "test_case", c.row.id, c.key, label)


def _view(row: TestCase, snap: dict[str, Any] | None = None) -> CaseView:
    src = snap or {}

    def pick(name: str, default: Any) -> Any:
        return src[name] if name in src and src[name] is not None else default

    cond = pick("condition_lineage_id", row.condition_lineage_id)
    return CaseView(
        row=row,
        key=row.key,
        title=str(pick("title", row.title)),
        status=str(pick("status", row.status.value)),
        technique=str(pick("technique", row.technique)),
        priority=p3.effective_priority(row),
        requirement_lineages=[str(x) for x in pick("requirement_lineage_ids", row.requirement_lineage_ids) or []],
        ac_lineages=[str(x) for x in pick("ac_lineage_ids", row.ac_lineage_ids) or []],
        condition_lineage=str(cond) if cond else None,
        coverage_item=(row.design_basis_ref or {}).get("coverage_item"),
    )


async def load(s: AsyncSession, project_id: uuid.UUID, basis: Basis = "current") -> Trace:
    run = await tds.current_run(s, project_id)
    snapshot_hash: str | None = None
    decision = await tds.last_g5(s, project_id)
    approved_at = decision.created_at if decision is not None else None
    if basis == "approved":
        if decision is None:
            raise NotFound("Test cases haven't been approved at Gate 5 yet")
        snapshot_hash = decision.snapshot_hash
        wanted = {uuid.UUID(i["id"]): int(i["version"]) for i in tds.snapshot_items(decision, "test_case")}
        rows = list((await s.execute(select(TestCase).where(TestCase.id.in_(wanted)))).scalars()) if wanted else []
        revs: dict[uuid.UUID, dict[str, Any]] = {}
        if rows:
            for rev in (
                await s.execute(
                    select(EntityRevision)
                    .where(
                        EntityRevision.entity_type == "test_case",
                        EntityRevision.lineage_id.in_([r.lineage_id for r in rows]),
                    )
                    .order_by(EntityRevision.version)
                )
            ).scalars():
                row = next(r for r in rows if r.lineage_id == rev.lineage_id)
                if rev.version <= wanted[row.id]:
                    revs[row.id] = {**revs.get(row.id, {}), **(rev.snapshot or {})}
        lk = await p3.lookup(s, project_id, run)
        views = [_view(r, {**revs.get(r.id, {}), "status": "approved"}) for r in sorted(rows, key=lambda x: x.key)]
        version = int((decision.stage_run_versions or {}).get("test_design") or 0) or None
    else:
        lk = await p3.lookup(s, project_id, run)
        views = [_view(r) for r in sorted(lk.cases, key=lambda x: x.key)]
        version = run.version if run else None
    t = Trace(basis, lk, views, version, snapshot_hash, list(lk.risks.values()), approved_at)
    await _load_execution(s, project_id, t)
    await _load_nonfunctional(s, project_id, t)
    await _load_changes(s, project_id, t)
    return t


async def _load_nonfunctional(s: AsyncSession, project_id: uuid.UUID, t: Trace) -> None:
    from app.services import quality as qsvc

    t.nf = await nfe.load(s, project_id)
    t.nf_cells = nfe.per_requirement(t.nf)
    _scan, pages = await qsvc.discovered_pages(s, project_id)
    t.pages_not_checked = [
        artefact_ref(project_id, "page", p.id, qsvc._path(p.url), p.title or qsvc._path(p.url))
        for p in sorted(pages, key=lambda x: x.url)
        if p.url not in t.nf.checked_urls
    ]


def nf_row(t: Trace, req_key: str) -> dict[str, Any]:
    """The Non-functional column group of one requirement: a cell per checked type, None when never checked."""
    cells = t.nf_cells.get(req_key, {})
    a11y = cells.get("accessibility")
    if a11y is None and t.nf.a11y_scan is not None:
        a11y = {"open": 0, "by_severity": {}, "findings": [], "scan_key": t.nf.a11y_scan.key}
    sec = cells.get("security")
    if sec is None and t.nf.sec_scan is not None:
        sec = {"open": 0, "findings": [], "scan_key": t.nf.sec_scan.key}
    return {"accessibility": a11y, "security": sec, "performance": cells.get("performance")}


# Open defects are the ones a person confirmed at Gate 8 and that aren't verified yet. An undecided draft is a
# hypothesis, so it never counts as open (P4-12, QA P4-BUG-08).
OPEN_DEFECT = ("confirmed", "fixed")


async def _load_execution(s: AsyncSession, project_id: uuid.UUID, t: Trace) -> None:
    """Scripts of the current bundle, defects by case and whether anything ran (P4-12)."""
    from app.db.models import AutomationScript, Defect, DefectLink, ExecutionRun
    from app.domain.enums import StageKey
    from app.services import automation as asvc

    bundle = await asvc.current_run(s, project_id, StageKey.automation)
    if bundle is not None:
        for sc in (
            await s.execute(select(AutomationScript).where(AutomationScript.stage_run_id == bundle.id))
        ).scalars():
            t.scripts[str(sc.case_lineage_id)] = {
                "id": str(sc.id),
                "file": sc.path.rsplit("/", 1)[-1],
                "path": sc.path,
                "version": sc.version,
                "state": asvc.script_state(sc),
                "outdated_reason": sc.outdated_reason,
            }
    t.executed = (
        await s.execute(
            select(ExecutionRun.id)
            .where(ExecutionRun.project_id == project_id, ExecutionRun.finished_at.is_not(None))
            .limit(1)
        )
    ).first() is not None
    defects = {d.id: d for d in (await s.execute(select(Defect).where(Defect.project_id == project_id))).scalars()}
    for d in sorted(defects.values(), key=lambda x: x.key):
        t.all_defects.append(_defect_ref(t, d))
    if defects:
        for link in (await s.execute(select(DefectLink).where(DefectLink.defect_id.in_(list(defects))))).scalars():
            if link.test_case_lineage_id is not None:
                d = defects[link.defect_id]
                t.defects.setdefault(str(link.test_case_lineage_id), []).append(_defect_ref(t, d))
    for lin, items in t.defects.items():
        t.defects[lin] = sorted({str(x["key"]): x for x in items}.values(), key=lambda x: str(x["key"]))


def _defect_ref(t: Trace, d: Any) -> dict[str, Any]:
    status = d.status.value
    return {
        **artefact_ref(t.lk.project_id, "defect", d.id, d.key, f"{d.key} · {d.summary}"[:200]),
        "status": status,
        "severity": d.severity.value,
    }


def _strip(x: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in x.items() if not k.startswith("_")}


def _case_exec(t: Trace, c: CaseView) -> dict[str, Any]:
    """Script · Result · Defects of one case, for matrix cells and 375 px cards."""
    sc = t.script(c)
    res = t.result(c)
    script = None
    if sc:
        script = {"file": sc["file"], "version": sc["version"], "state": sc["state"]}
        if sc["state"] == "outdated":
            script["outdated_reason"] = sc.get("outdated_reason")
    return {
        "script": script,
        "result": {k: res[k] for k in ("status", "run_key", "result_key", "at")} if res else None,
        "defects": [_strip(d) for d in t.defects.get(str(c.row.lineage_id), [])],
        "impacted": t.impacted.get(str(c.row.lineage_id)),
    }


# ------------------------------------------------------------------ helpers


def _approved_reqs(t: Trace) -> list[Any]:
    return sorted(
        (r for r in t.lk.requirements.values() if r.status == RequirementStatus.approved), key=lambda r: r.key
    )


def _cases_for_req(t: Trace, lineage: str) -> list[CaseView]:
    return [c for c in t.cases if lineage in c.requirement_lineages]


def _risks_for_req(t: Trace, req: Any) -> list[Risk]:
    lin = str(req.lineage_id)
    feats = {str(f) for f in req.feature_ids or []}
    return sorted(
        (
            r
            for r in t.risks
            if lin in {str(x) for x in r.requirement_lineage_ids or []} or feats & {str(f) for f in r.feature_ids or []}
        ),
        key=lambda r: (-r.score, r.key),
    )


def _pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def _ac_lineages_of(t: Trace, req: Any) -> list[str]:
    return sorted(
        (lin for lin, a in t.lk.acs.items() if a.requirement_id == req.id and a.status != ItemStatus.rejected),
        key=lambda lin: t.lk.acs[lin].key,
    )


# ------------------------------------------------------------------ matrix


def forward_rows(t: Trace) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for r in sorted(t.lk.requirements.values(), key=lambda x: x.key):
        if r.status == RequirementStatus.rejected:
            continue
        lin = str(r.lineage_id)
        cases = [c for c in _cases_for_req(t, lin) if c.status != "rejected"]
        covered_acs = {a for c in cases if c.active for a in c.ac_lineages}
        risks = _risks_for_req(t, r)
        conds = {c.condition_lineage for c in cases if c.condition_lineage}
        rows.append(
            {
                "requirement": t.lk.req_ref(lin),
                "requirement_status": r.status.value,
                "risk": {"level": risks[0].level.value, "risks": [t.lk.risk_ref(x) for x in risks]} if risks else None,
                "acceptance_criteria": [
                    {"ac": t.lk.ac_ref(a), "covered": a in covered_acs} for a in _ac_lineages_of(t, r)
                ],
                "conditions": sorted(
                    (x for x in (t.lk.condition_ref(c) for c in conds) if x), key=lambda x: str(x["key"])
                ),
                "test_cases": [
                    {"case": t.case_ref(c), "status": c.status, "priority": c.priority, **_case_exec(t, c)}
                    for c in cases
                ],
                "automation": [
                    {"case_key": c.key, **_case_exec(t, c)["script"]} for c in cases if t.script(c) is not None
                ],
                "results": [{"case_key": c.key, **_case_exec(t, c)["result"]} for c in cases if t.result(c)],
                "defects": sorted(
                    {
                        str(d["key"]): _strip(d) for c in cases for d in t.defects.get(str(c.row.lineage_id), [])
                    }.values(),
                    key=lambda x: str(x["key"]),
                ),
                **nf_row(t, r.key),
                "impacted": t.req_impacted.get(lin),
                "_risk_level": risks[0].level.value if risks else None,
                "_feature_ids": [str(f) for f in r.feature_ids or []],
                "_approved_case": any(c.status == "approved" for c in cases),
            }
        )
    return rows


def backward_rows(t: Trace) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c in t.cases:
        reqs = [t.lk.requirements[x] for x in c.requirement_lineages if x in t.lk.requirements]
        risks: dict[str, Risk] = {}
        for r in reqs:
            for k in _risks_for_req(t, r):
                risks[k.key] = k
        cond = t.lk.condition_ref(c.condition_lineage) if c.condition_lineage else None
        out.append(
            {
                "test_case": t.case_ref(c),
                "status": c.status,
                "conditions": [cond] if cond else [],
                "acceptance_criteria": [x for x in (t.lk.ac_ref(a) for a in c.ac_lineages) if x],
                "requirements": [x for x in (t.lk.req_ref(q) for q in c.requirement_lineages) if x],
                "risks": [t.lk.risk_ref(risks[k]) for k in sorted(risks)],
                **_case_exec(t, c),
                "_risk_level": max((r.level.value for r in risks.values()), key=_level_rank, default=None),
                "_feature_ids": sorted({str(f) for r in reqs for f in r.feature_ids or []}),
                "_approved_case": c.status == "approved",
            }
        )
    return out


def _level_rank(level: str) -> int:
    return {"low": 1, "medium": 2, "high": 3, "very_high": 4}.get(level, 0)


def public(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if not k.startswith("_")}


# ------------------------------------------------------------------ coverage and gaps


def coverage(t: Trace) -> dict[str, Any]:
    reqs = _approved_reqs(t)
    with_case = [r for r in reqs if any(c.active for c in _cases_for_req(t, str(r.lineage_id)))]
    with_approved = [r for r in reqs if any(c.status == "approved" for c in _cases_for_req(t, str(r.lineage_id)))]
    req_ids = {r.id for r in reqs}
    approved_acs = [
        lin for lin, a in t.lk.acs.items() if a.status == ItemStatus.approved and a.requirement_id in req_ids
    ]
    covered = {a for c in t.cases if c.active for a in c.ac_lineages}
    high = [r for r in reqs if any(k.level.value in HIGH for k in _risks_for_req(t, r))]
    techniques = []
    for cond in sorted(t.lk.conditions.values(), key=lambda x: x.key):
        if cond.status == ItemStatus.rejected:
            continue
        items = [str(i.get("id")) for i in cond.coverage_items or []]
        realised = {c.coverage_item for c in t.cases if c.active and c.condition_lineage == str(cond.lineage_id)}
        techniques.append(
            {
                "condition": t.lk.condition_ref(cond.lineage_id),
                "technique": cond.technique,
                "items": len(items),
                "covered": sum(1 for i in items if i in realised),
            }
        )
    return {
        "basis": t.basis,
        "design_version": t.design_version,
        "snapshot_hash": t.snapshot_hash,
        "approved_at": t.approved_at,
        "requirements": {
            "approved": len(reqs),
            "with_case": len(with_case),
            "with_approved_case": len(with_approved),
            "percent_approved_covered": _pct(len(with_approved), len(reqs)),
        },
        "acceptance_criteria": {
            "approved": len(approved_acs),
            "covered": sum(1 for a in approved_acs if a in covered),
            "percent": _pct(sum(1 for a in approved_acs if a in covered), len(approved_acs)),
        },
        "high_risk_requirements": {
            "total": len(high),
            "with_approved_case": sum(1 for r in high if r in with_approved),
        },
        "techniques": techniques,
        "test_cases": {
            "by_status": {s.value: sum(1 for c in t.cases if c.status == s.value) for s in CaseStatus},
            "orphans": len(_orphans(t)),
        },
        "execution": _execution_coverage(t, reqs),
        "non_functional": {k: len(v) for k, v in _nf_gaps(t, reqs).items()},
        "changes": {k: len(v) for k, v in t.change_gaps.items()},
    }


def _execution_coverage(t: Trace, reqs: list[Any]) -> dict[str, Any]:
    """Execution coverage, pass rate and automation coverage (design P4 §12). Flaky and errors are separate, never
    counted as passed."""
    approved = [c for c in t.cases if c.status == "approved"]
    latest = [r for r in (t.result(c) for c in approved) if r]
    by: dict[str, int] = {}
    for r in latest:
        by[r["status"]] = by.get(r["status"], 0) + 1
    with_result = [
        r
        for r in reqs
        if any(
            (t.result(c) or {}).get("status") in ("passed", "failed")
            for c in _cases_for_req(t, str(r.lineage_id))
            if c.status == "approved"
        )
    ]
    valid = [c for c in approved if (t.script(c) or {}).get("state") == "valid"]
    return {
        "executed": t.executed,
        "requirements": {"approved": len(reqs), "with_result": len(with_result)},
        "results": {
            "tests": len(latest),
            "passed": by.get("passed", 0),
            "failed": by.get("failed", 0),
            "flaky": by.get("flaky", 0),
            "error": by.get("error", 0),
            "blocked": by.get("blocked", 0),
            "skipped": by.get("skipped", 0),
        },
        "automation": {"approved_cases": len(approved), "with_valid_script": len(valid)},
    }


def _orphans(t: Trace) -> list[CaseView]:
    return [c for c in t.cases if c.active and not any(x in t.lk.requirements for x in c.requirement_lineages)]


async def gaps(s: AsyncSession, t: Trace) -> dict[str, Any]:
    reqs = _approved_reqs(t)
    none: list[dict[str, Any]] = []
    none_approved: list[dict[str, Any]] = []
    for r in reqs:
        cases = _cases_for_req(t, str(r.lineage_id))
        ref = t.lk.req_ref(r.lineage_id)
        if not any(c.active for c in cases):
            none.append(ref)  # type: ignore[arg-type]
        elif not any(c.status == "approved" for c in cases):
            none_approved.append(ref)  # type: ignore[arg-type]
    req_ids = {r.id for r in reqs}
    covered = {a for c in t.cases if c.active for a in c.ac_lineages}
    acs = sorted(
        (
            lin
            for lin, a in t.lk.acs.items()
            if a.status == ItemStatus.approved and a.requirement_id in req_ids and lin not in covered
        ),
        key=lambda lin: t.lk.acs[lin].key,
    )
    approved_cases = {str(lin) for c in t.cases if c.status == "approved" for lin in c.requirement_lineages}
    open_: list[dict[str, Any]] = []
    accepted: list[dict[str, Any]] = []
    for k in sorted(t.risks, key=lambda x: x.key):
        if k.level.value not in HIGH:
            continue
        linked = [r for r in reqs if k in _risks_for_req(t, r)]
        missing = [r for r in linked if str(r.lineage_id) not in approved_cases]
        if not missing:
            continue
        if k.status == RiskStatus.accepted:
            accepted.append({"risk": t.lk.risk_ref(k), "comment": k.status_comment or ""})
        elif k.status == RiskStatus.open:
            open_.append({"risk": t.lk.risk_ref(k), "requirements": [t.lk.req_ref(r.lineage_id) for r in missing]})
    feats = await gates.features_without_requirement(s, t.lk.project_id)
    return {
        "requirements_without_test_cases": {"none": none, "none_approved": none_approved},
        "test_cases_without_requirements": [t.case_ref(c) for c in _orphans(t)],
        "acceptance_criteria_without_test_cases": [t.lk.ac_ref(a) for a in acs],
        "untested_high_risk": {"open": open_, "accepted": accepted},
        "features_without_requirements": [artefact_ref(t.lk.project_id, "feature", f.id, f.key, f.name) for f in feats],
        **_execution_gaps(t, reqs),
        **_nf_gaps(t, reqs),
        **t.change_gaps,
    }


def _nf_gaps(t: Trace, reqs: list[Any]) -> dict[str, list[dict[str, Any]]]:
    """The three non-functional gap lists (design P5 §12.1); coverage counts are their lengths."""
    with_open = []
    for r in reqs:
        cell = t.nf_cells.get(r.key, {}).get("accessibility")
        if cell and cell["open"]:
            with_open.append({"requirement": t.lk.req_ref(r.lineage_id), **cell})
    evidence = {
        "accessibility": t.nf.a11y_scan is not None,
        "security": t.nf.sec_scan is not None,
    }
    without = []
    for r in reqs:
        if r.category not in nfe.NF_CATEGORIES:
            continue
        has = (
            "performance" in t.nf_cells.get(r.key, {})
            if r.category == "performance"
            else evidence[r.category] or bool(t.nf_cells.get(r.key, {}).get(r.category))
        )
        if not has:
            without.append({"requirement": t.lk.req_ref(r.lineage_id), "category": r.category})
    return {
        "requirements_with_open_accessibility_findings": with_open,
        "pages_not_checked_for_accessibility": t.pages_not_checked,
        "non_functional_requirements_without_evidence": without,
    }


def _execution_gaps(t: Trace, reqs: list[Any]) -> dict[str, Any]:
    """The four Phase 4 gap lists (design P4 §12), plus the flaky tests sub-list (counted separately)."""
    automated_not_run: list[dict[str, Any]] = []
    manual_only: list[dict[str, Any]] = []
    for r in reqs:
        cases = [c for c in _cases_for_req(t, str(r.lineage_id)) if c.status == "approved"]
        if not cases or any((t.result(c) or {}).get("status") in ("passed", "failed") for c in cases):
            continue
        ref = t.lk.req_ref(r.lineage_id)
        if any(t.script(c) for c in cases):
            automated_not_run.append(ref)  # type: ignore[arg-type]
        else:
            manual_only.append(ref)  # type: ignore[arg-type]
    failed: list[dict[str, Any]] = []
    flaky: list[dict[str, Any]] = []
    for c in t.cases:
        res = t.result(c)
        if not res or not c.active:
            continue
        item = {
            "case": t.case_ref(c),
            "status": res["status"],
            "run_key": res["run_key"],
            "result_key": res["result_key"],
            "classification": res.get("classification"),
            "label": res.get("label"),
        }
        if res["status"] in ("failed", "error"):
            failed.append(item)
        elif res["status"] == "flaky":
            flaky.append(item)
    outdated = [
        {"case": t.case_ref(c), "file": sc["file"], "version": sc["version"]}
        for c in t.cases
        if c.active and (sc := t.script(c)) and sc["state"] == "outdated"
    ]
    regression = {str(c.row.lineage_id) for c in t.cases if c.active and "regression" in (c.row.suites or [])}
    without_regression = []
    for lin, items in t.defects.items():
        for d in items:
            if (d["status"] in OPEN_DEFECT or d["status"] == "verified") and lin not in regression:
                case = next((c for c in t.cases if str(c.row.lineage_id) == lin), None)
                without_regression.append({"defect": _strip(d), "case": t.case_ref(case) if case else None})
    return {
        "requirements_without_execution_evidence": {
            "executed": t.executed,
            "automated_not_run": automated_not_run,
            "manual_only": manual_only,
        },
        "failed_tests": failed,
        "flaky_tests": flaky,
        "outdated_automation_scripts": outdated,
        "defects_without_regression_coverage": sorted(without_regression, key=lambda x: str(x["defect"]["key"])),
    }


# ------------------------------------------------------------------ changes (P6-06)

_LEVEL_RANK = {"direct": 0, "indirect": 1, "gap": 2}


def _impact_cell(cs_key: str, i: Any) -> dict[str, Any]:
    return {"change_set": cs_key, "level": i.level.value, "status": i.status.value, "action": i.action.value}


def _stronger(a: dict[str, Any] | None, b: dict[str, Any]) -> dict[str, Any]:
    """The cell a case or requirement shows when several items name it: open before closed, then direct first."""
    if a is None:
        return b

    def rank(x: dict[str, Any]) -> tuple[bool, int]:
        return x["status"] != "open", _LEVEL_RANK.get(x["level"], 9)

    return b if rank(b) < rank(a) else a


def heal_path(project_id: uuid.UUID, cs_key: str | None, heal_key: str) -> str:
    if cs_key:
        return f"/projects/{project_id}/discovery/changes/{cs_key}?tab=repairs&heal={heal_key}"
    return f"/projects/{project_id}/automation"


async def rescan_sets(s: AsyncSession, project_id: uuid.UUID) -> list[Any]:
    """Completed change sets of rescans (a person's comparison has no impact), oldest first."""
    from app.db.models import ChangeSet
    from app.domain.enums import ChangeSetStatus

    q = (
        select(ChangeSet)
        .where(
            ChangeSet.project_id == project_id,
            ChangeSet.stage_run_id.is_not(None),
            ChangeSet.status == ChangeSetStatus.completed,
        )
        .order_by(ChangeSet.created_at)
    )
    return list((await s.execute(q)).scalars())


async def _load_changes(s: AsyncSession, project_id: uuid.UUID, t: Trace) -> None:
    """The matrix's Change column (the latest rescan change set) and the three change gap lists (design P6 §12.1)."""
    from app.db.models import ChangeItem, ImpactItem
    from app.domain.enums import ChangeKind, ImpactAction, ImpactStatus, ImpactTargetKind
    from app.services import impact as impact_svc

    gaps: dict[str, list[dict[str, Any]]] = {
        "scripts_outdated": [],
        "impacted_not_rerun": [],
        "new_pages_without_requirements": [],
    }
    t.change_gaps = gaps
    sets = await rescan_sets(s, project_id)
    by_id = {cs.id: cs for cs in sets}
    latest = sets[-1] if sets else None
    items = (
        list(
            (
                await s.execute(
                    select(ImpactItem)
                    .where(ImpactItem.change_set_id.in_(list(by_id)))
                    .order_by(ImpactItem.created_at, ImpactItem.id)
                )
            ).scalars()
        )
        if sets
        else []
    )
    for i in items:
        if latest is None or i.change_set_id != latest.id:
            continue
        cell = _impact_cell(latest.key, i)
        if i.target_kind == ImpactTargetKind.test_case:
            t.impacted[i.target_ref] = _stronger(t.impacted.get(i.target_ref), cell)
        elif i.target_kind == ImpactTargetKind.requirement:
            t.req_impacted[i.target_ref] = _stronger(t.req_impacted.get(i.target_ref), cell)
    cases = {str(c.row.lineage_id): c for c in t.cases}

    def cs_ref(cs: Any) -> dict[str, Any]:
        return artefact_ref(project_id, "change_set", cs.id, cs.key, cs.key)

    # Impacted tests not re-run: open re-run items of test cases (they close themselves once a later run has a result).
    seen: set[tuple[str, str]] = set()
    for i in items:
        if i.target_kind != ImpactTargetKind.test_case or i.action != ImpactAction.rerun:
            continue
        c = cases.get(i.target_ref)
        cs = by_id[i.change_set_id]
        if i.status != ImpactStatus.open or c is None or (cs.key, c.key) in seen:
            continue
        seen.add((cs.key, c.key))
        gaps["impacted_not_rerun"].append(
            {"case": t.case_ref(c), "level": i.level.value, "change_set": cs_ref(cs), "reason": i.reason}
        )
    # New pages without requirements: open gap items for a page a rescan added.
    open_gaps = [i for i in items if i.target_kind == ImpactTargetKind.coverage_gap and i.status == ImpactStatus.open]
    if open_gaps:
        ids = [uuid.UUID(i.target_ref) for i in open_gaps]
        added = {
            str(ch.id): ch
            for ch in (
                await s.execute(
                    select(ChangeItem).where(ChangeItem.id.in_(ids), ChangeItem.kind == ChangeKind.page_added)
                )
            ).scalars()
        }
        for i in open_gaps:
            ch = added.get(i.target_ref)
            if ch is None:
                continue
            cs = by_id[i.change_set_id]
            page = impact_svc._path(ch.page_url)
            gaps["new_pages_without_requirements"].append(
                {
                    "page": page,
                    "url": ch.page_url,
                    "change_set": cs_ref(cs),
                    "impact_item_id": str(i.id),
                    "label": f"{page} (added in {cs.key})",
                    "path": f"/projects/{project_id}/discovery/changes/{cs.key}?tab=impact",
                }
            )
    # Scripts that are outdated (spec §12), with the reason and their repair suggestions.
    heals = await impact_svc._heal_links(s, project_id, latest) if latest is not None else {}
    for c in t.cases:
        sc = t.script(c)
        if not c.active or not sc or sc["state"] != "outdated":
            continue
        lin = str(c.row.lineage_id)
        gaps["scripts_outdated"].append(
            {
                "case": t.case_ref(c),
                "file": sc["file"],
                "path": sc["path"],
                "version": sc["version"],
                "reason": sc.get("outdated_reason") or "",
                "change_set": cs_ref(latest) if latest is not None else None,
                "heal_suggestions": [
                    {
                        "key": h["key"],
                        "id": h["id"],
                        "status": h["status"],
                        "path": heal_path(project_id, latest.key if latest else None, h["key"]),
                    }
                    for h in {x["key"]: x for x in heals.get(lin, []) if x.get("key")}.values()
                ],
            }
        )


# ------------------------------------------------------------------ chain


def chain(t: Trace, key: str) -> dict[str, Any]:
    key = key.strip().upper()
    lk = t.lk

    def refs(items: list[Any]) -> list[dict[str, Any]]:
        out = [x for x in items if x]
        return sorted({str(x["key"]): x for x in out}.values(), key=lambda x: str(x["key"]))

    # Phase 4 levels are real (P4-12); `later_phase` stays for older clients and is empty.
    later: list[dict[str, Any]] = []
    req = next((r for r in lk.requirements.values() if r.key == key), None)
    if req is not None:
        lin = str(req.lineage_id)
        cases = [c for c in _cases_for_req(t, lin) if c.status != "rejected"]
        return {
            "root": lk.req_ref(lin),
            "upstream": [{"type": "risk", "items": refs([lk.risk_ref(k) for k in _risks_for_req(t, req)])}],
            "downstream": [
                {"type": "acceptance_criterion", "items": refs([lk.ac_ref(a) for a in _ac_lineages_of(t, req)])},
                {"type": "test_condition", "items": refs([lk.condition_ref(c.condition_lineage) for c in cases])},
                {"type": "test_case", "items": refs([t.case_ref(c) for c in cases])},
                *_exec_levels(t, cases),
            ],
            "later_phase": [],
        }
    ac_lin = next((lin for lin, a in lk.acs.items() if a.key == key), None)
    if ac_lin is not None:
        a = lk.acs[ac_lin]
        parent = next((r for r in lk.requirements.values() if r.id == a.requirement_id), None)
        cases = [c for c in t.cases if ac_lin in c.ac_lineages and c.status != "rejected"]
        return {
            "root": lk.ac_ref(ac_lin),
            "upstream": [
                {"type": "requirement", "items": refs([lk.req_ref(parent.lineage_id)] if parent else [])},
                {"type": "risk", "items": refs([lk.risk_ref(k) for k in _risks_for_req(t, parent)] if parent else [])},
            ],
            "downstream": [
                {"type": "test_condition", "items": refs([lk.condition_ref(c.condition_lineage) for c in cases])},
                {"type": "test_case", "items": refs([t.case_ref(c) for c in cases])},
            ],
            "later_phase": later,
        }
    cond = next((c for c in lk.conditions.values() if c.key == key), None)
    if cond is not None:
        reqs = [lk.requirements[str(x)] for x in cond.requirement_lineage_ids or [] if str(x) in lk.requirements]
        cases = [c for c in t.cases if c.condition_lineage == str(cond.lineage_id) and c.status != "rejected"]
        return {
            "root": lk.condition_ref(cond.lineage_id),
            "upstream": [
                {"type": "acceptance_criterion", "items": refs([lk.ac_ref(a) for a in cond.ac_lineage_ids or []])},
                {"type": "requirement", "items": refs([lk.req_ref(r.lineage_id) for r in reqs])},
                {"type": "risk", "items": refs([lk.risk_ref(k) for r in reqs for k in _risks_for_req(t, r)])},
            ],
            "downstream": [{"type": "test_case", "items": refs([t.case_ref(c) for c in cases])}],
            "later_phase": later,
        }
    case = next((c for c in t.cases if c.key == key), None)
    if case is not None:
        reqs = [lk.requirements[x] for x in case.requirement_lineages if x in lk.requirements]
        return {
            "root": t.case_ref(case),
            "upstream": [
                {"type": "test_condition", "items": refs([lk.condition_ref(case.condition_lineage)])},
                {"type": "acceptance_criterion", "items": refs([lk.ac_ref(a) for a in case.ac_lineages])},
                {"type": "requirement", "items": refs([lk.req_ref(r.lineage_id) for r in reqs])},
                {"type": "risk", "items": refs([lk.risk_ref(k) for r in reqs for k in _risks_for_req(t, r)])},
            ],
            "downstream": _exec_levels(t, [case]),
            "later_phase": [],
        }
    d = next((x for x in t.all_defects if x["key"] == key), None)
    if d is not None:
        cases = [c for c in t.cases if any(x["key"] == key for x in t.defects.get(str(c.row.lineage_id), []))]
        reqs = [lk.requirements[x] for c in cases for x in c.requirement_lineages if x in lk.requirements]
        levels = _exec_levels(t, cases)
        return {
            "root": _strip(d),
            "upstream": [
                {"type": "requirement", "items": refs([lk.req_ref(r.lineage_id) for r in reqs])},
                # P4-12 AC1 (QA P4-BUG-10): requirement → acceptance criterion → case → script → result.
                {"type": "acceptance_criterion", "items": refs([lk.ac_ref(a) for c in cases for a in c.ac_lineages])},
                {"type": "test_case", "items": refs([t.case_ref(c) for c in cases])},
                *[lv for lv in levels if lv["type"] != "defect"],
            ],
            "downstream": [],
            "later_phase": [],
        }
    risk = next((k for k in t.risks if k.key == key), None)
    if risk is not None:
        reqs = [r for r in lk.requirements.values() if risk in _risks_for_req(t, r)]
        cases = [c for r in reqs for c in _cases_for_req(t, str(r.lineage_id)) if c.status != "rejected"]
        return {
            "root": lk.risk_ref(risk),
            "upstream": [],
            "downstream": [
                {"type": "requirement", "items": refs([lk.req_ref(r.lineage_id) for r in reqs])},
                {"type": "test_case", "items": refs([t.case_ref(c) for c in cases])},
            ],
            "later_phase": later,
        }
    raise NotFound(f"Nothing called {key} in this project")


NF_PREFIXES = ("A11Y-", "SEC-", "PERF-", "PRF-")


def is_nf_key(key: str) -> bool:
    return key.strip().upper().startswith(NF_PREFIXES)


async def nf_chain(s: AsyncSession, t: Trace, key: str) -> dict[str, Any]:
    """Chains of non-functional keys (design P5 §12.1): Requirement → Page → Finding → Defect, or Requirement
    (threshold source) → Profile → Load test → Threshold result → Defect. Scoped by the session's tenant and the
    project, so another organisation's key is never resolved."""
    from app.db.models import Defect, PerformanceProfile, PerformanceRun, QualityScan

    key = key.strip().upper()
    pid, lk = t.lk.project_id, t.lk
    reqs_by_key = {r.key: r for r in lk.requirements.values()}

    def req_refs(keys: list[str]) -> list[dict[str, Any]]:
        return [lk.req_ref(reqs_by_key[k].lineage_id) for k in sorted(set(keys)) if k in reqs_by_key]  # type: ignore[misc]

    async def defect_refs(ids: list[Any]) -> list[dict[str, Any]]:
        ids = [i for i in ids if i]
        if not ids:
            return []
        rows = (await s.execute(select(Defect).where(Defect.id.in_(ids)))).scalars()
        return sorted((_strip(_defect_ref(t, d)) for d in rows), key=lambda x: str(x["key"]))

    if key.startswith(("A11Y-", "SEC-")):
        parts = key.split("-")
        scan_key = "-".join(parts[:2])
        scan = (
            await s.execute(select(QualityScan).where(QualityScan.project_id == pid, QualityScan.key == scan_key))
        ).scalar_one_or_none()
        if scan is None:
            raise NotFound(f"Nothing called {key} in this project")
        findings = await nfe.findings_of(s, scan)
        if len(parts) > 2:
            findings = [f for f in findings if f.key == key]
            if not findings:
                raise NotFound(f"Nothing called {key} in this project")
        pages = sorted({f.url for f in findings})
        froot = (
            artefact_ref(
                pid, "quality_finding", findings[0].id, findings[0].key, f"{findings[0].key} · {findings[0].title}"
            )
            if len(parts) > 2
            else artefact_ref(pid, "quality_scan", scan.id, scan.key, f"{scan.key} · {scan.status.value.capitalize()}")
        )
        return {
            "root": froot,
            "upstream": [
                {"type": "requirement", "items": req_refs([k for f in findings for k in nfe.req_keys(f)])},
                {"type": "page", "items": [artefact_ref(pid, "page", None, p, p) for p in pages]},
            ],
            "downstream": [
                *(
                    [
                        {
                            "type": "quality_finding",
                            "items": [
                                artefact_ref(
                                    pid, "quality_finding", f.id, f.key, f"{f.key} · {f.title} · {f.status.value}"
                                )
                                for f in findings
                            ],
                        }
                    ]
                    if len(parts) == 2
                    else []
                ),
                {"type": "defect", "items": await defect_refs(list({f.defect_id for f in findings}))},
            ],
            "later_phase": [],
        }
    if key.startswith("PRF-"):
        prof = (
            await s.execute(
                select(PerformanceProfile).where(PerformanceProfile.project_id == pid, PerformanceProfile.key == key)
            )
        ).scalar_one_or_none()
        if prof is None:
            raise NotFound(f"Nothing called {key} in this project")
        runs = list(
            (
                await s.execute(
                    select(PerformanceRun).where(PerformanceRun.profile_id == prof.id).order_by(PerformanceRun.key)
                )
            ).scalars()
        )
        src = [str((x.get("source") or {}).get("key")) for x in prof.thresholds or []]
        return {
            "root": artefact_ref(pid, "performance_profile", prof.id, prof.key, f"{prof.key} · {prof.name}"),
            "upstream": [{"type": "requirement", "items": req_refs(src)}],
            "downstream": [
                {
                    "type": "performance_run",
                    "items": [
                        artefact_ref(pid, "performance_run", r.id, r.key, f"{r.key} · {r.status.value}") for r in runs
                    ],
                },
            ],
            "later_phase": [],
        }
    run = (
        await s.execute(select(PerformanceRun).where(PerformanceRun.project_id == pid, PerformanceRun.key == key))
    ).scalar_one_or_none()
    if run is None:
        raise NotFound(f"Nothing called {key} in this project")
    snap = run.profile_snapshot or {}
    results = run.threshold_results or []
    labels = []
    for x in results:
        where = x.get("path") or "All requests"
        word = {"met": "✓ Met", "missed": "✗ Missed", "not_measured": "Not measured"}.get(str(x.get("result")), "")
        labels.append(artefact_ref(pid, "threshold_result", None, f"{run.key} · {where} {x.get('metric')}",
                                   f"{where} {x.get('metric')} · {word}"))  # fmt: skip
    drafts = (await s.execute(select(Defect).where(Defect.project_id == pid))).scalars()
    defects = sorted(
        (_strip(_defect_ref(t, d)) for d in drafts if (d.environment or {}).get("run_key") == run.key),
        key=lambda x: str(x["key"]),
    )
    return {
        "root": artefact_ref(pid, "performance_run", run.id, run.key, f"{run.key} · {run.status.value}"),
        "upstream": [
            {"type": "requirement", "items": req_refs([str((x.get("source") or {}).get("key")) for x in results])},
            {
                "type": "performance_profile",
                "items": [
                    artefact_ref(
                        pid,
                        "performance_profile",
                        run.profile_id,
                        str(snap.get("profile_key")),
                        f"{snap.get('profile_key')} v{snap.get('profile_version')}",
                    )
                ],
            },
        ],
        "downstream": [{"type": "threshold_result", "items": labels}, {"type": "defect", "items": defects}],
        "later_phase": [],
    }


def _exec_levels(t: Trace, cases: list[CaseView]) -> list[dict[str, Any]]:
    """Script (version, status) → Result (per browser/size) → Defect for the given cases (design P4 §12)."""
    pid = t.lk.project_id
    scripts: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    defects: dict[str, dict[str, Any]] = {}
    for c in cases:
        sc = t.script(c)
        if sc:
            state = sc["state"].replace("_", " ").capitalize()
            scripts.append(
                artefact_ref(pid, "automation_script", None, sc["path"], f"{sc['file']} v{sc['version']} · {state}")
            )
        res = t.result(c)
        for x in (res or {}).get("results", []):
            size = "mobile" if x["viewport"] == "390x844" else "desktop"
            label = f"{x['result_key']} · {x['status'].capitalize()} · {x['browser'].capitalize()} {size}"
            results.append(artefact_ref(pid, "execution_result", None, x["result_key"], label))
        for d in t.defects.get(str(c.row.lineage_id), []):
            defects[str(d["key"])] = {**_strip(d), "label": f"{d['key']} · {str(d['status']).capitalize()}"}
    return [
        {"type": "automation_script", "items": sorted(scripts, key=lambda x: str(x["key"]))},
        {"type": "execution_result", "items": sorted(results, key=lambda x: str(x["key"]))},
        {"type": "defect", "items": [defects[k] for k in sorted(defects)]},
    ]


# ------------------------------------------------------------------ risk coverage (P3-05)


def risk_coverage(t: Trace, risk: Risk) -> dict[str, Any]:
    reqs = [r for r in _approved_reqs(t) if risk in _risks_for_req(t, r)]
    cases = {c.key: c for r in reqs for c in _cases_for_req(t, str(r.lineage_id)) if c.active}
    uncovered = [r.key for r in reqs if not any(c.status == "approved" for c in _cases_for_req(t, str(r.lineage_id)))]
    return {
        "requirements": len(reqs),
        "test_cases": len(cases),
        "approved_test_cases": sum(1 for c in cases.values() if c.status == "approved"),
        "uncovered_requirement_keys": uncovered,
    }


# ------------------------------------------------------------------ Phase 6 chains (P6-06)

P6_PREFIXES = ("CHG-", "EXP-", "HEAL-", "REL-")
_STATUS_WORD = {"met": "Met", "not_met": "Not met", "not_evaluable": "Not evaluable"}


def is_p6_key(key: str) -> bool:
    return key.strip().upper().startswith(P6_PREFIXES)


def _kind_text(kind: str) -> str:
    return kind.replace("_", " ").capitalize()


async def p6_chain(s: AsyncSession, t: Trace, key: str) -> dict[str, Any]:
    """Chains of Phase 6 keys (design P6 §12.1), listed top-down in `downstream`:
    CHG → change → impact item → requirement → case → script → latest result; HEAL → page object → scripts → cases →
    requirement; EXP → finding → defect (with its Gate 8 state); REL → criteria → evidence. Scoped by the session's
    tenant and the project, so another organisation's key is never resolved."""
    key = key.strip().upper()
    if key.startswith("CHG-"):
        return await _chg_chain(s, t, key)
    if key.startswith("HEAL-"):
        return await _heal_chain(s, t, key)
    if key.startswith("EXP-"):
        return await _exp_chain(s, t, key)
    return await _rel_chain(s, t, key)


def _missing(key: str) -> NotFound:
    return NotFound(f"Nothing called {key} in this project")


def _chain_out(
    root: dict[str, Any], levels: list[dict[str, Any]], upstream: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return {"root": root, "upstream": upstream or [], "downstream": levels, "later_phase": []}


async def _chg_chain(s: AsyncSession, t: Trace, key: str) -> dict[str, Any]:
    from app.db.models import ChangeItem, ChangeSet, ImpactItem
    from app.services import impact as impact_svc

    pid = t.lk.project_id
    cs = (
        await s.execute(select(ChangeSet).where(ChangeSet.project_id == pid, ChangeSet.key == key))
    ).scalar_one_or_none()
    if cs is None:
        raise _missing(key)
    base = f"/projects/{pid}/discovery/changes/{cs.key}"
    changes = list(
        (
            await s.execute(
                select(ChangeItem)
                .where(ChangeItem.change_set_id == cs.id)
                .order_by(ChangeItem.created_at, ChangeItem.id)
            )
        ).scalars()
    )
    impacts = list(
        (
            await s.execute(
                select(ImpactItem)
                .where(ImpactItem.change_set_id == cs.id)
                .order_by(ImpactItem.created_at, ImpactItem.id)
            )
        ).scalars()
    )
    targets = await impact_svc._targets(s, pid, impacts) if impacts else {}
    change_refs = [
        artefact_ref(pid, "change_item", ch.id, str(ch.id),
                     f"{_kind_text(ch.kind.value)} · {impact_svc._path(ch.page_url) if ch.page_url else 'site'} · "
                     f"{ch.significance.value}") | {"path": f"{base}?tab=changes"}
        for ch in changes
    ]  # fmt: skip
    impact_refs = []
    for i in impacts:
        target = targets.get((i.target_kind.value, i.target_ref)) or {}
        who = str(target.get("key") or _kind_text(i.target_kind.value))
        label = f"{who} · {_kind_text(i.level.value)} · {_kind_text(i.action.value)} · {_kind_text(i.status.value)}"
        impact_refs.append(artefact_ref(pid, "impact_item", i.id, str(i.id), label) | {"path": f"{base}?tab=impact"})
    case_lins = {i.target_ref for i in impacts if i.target_kind.value in ("test_case", "automation_script")}
    cases = [c for c in t.cases if str(c.row.lineage_id) in case_lins and c.status != "rejected"]
    req_lins = {i.target_ref for i in impacts if i.target_kind.value == "requirement"}
    req_lins |= {x for c in cases for x in c.requirement_lineages}
    reqs = sorted((x for x in (t.lk.req_ref(lin) for lin in req_lins if lin in t.lk.requirements) if x),
                  key=lambda x: str(x["key"]))  # fmt: skip
    root = artefact_ref(pid, "change_set", cs.id, cs.key, f"{cs.key} · {(cs.summary or {}).get('total', 0)} changes")
    return _chain_out(
        root,
        [
            {"type": "change_item", "items": change_refs},
            {"type": "impact_item", "items": impact_refs},
            {"type": "requirement", "items": reqs},
            {"type": "test_case", "items": sorted((t.case_ref(c) for c in cases), key=lambda x: str(x["key"]))},
            *[lv for lv in _exec_levels(t, cases) if lv["type"] != "defect"],
        ],
    )


async def _heal_chain(s: AsyncSession, t: Trace, key: str) -> dict[str, Any]:
    from app.db.models import ChangeItem, ChangeSet, HealSuggestion

    pid = t.lk.project_id
    h = (
        await s.execute(select(HealSuggestion).where(HealSuggestion.project_id == pid, HealSuggestion.key == key))
    ).scalar_one_or_none()
    if h is None:
        raise _missing(key)
    cs = None
    if h.change_item_id is not None:
        ch = await s.get(ChangeItem, h.change_item_id)
        cs = await s.get(ChangeSet, ch.change_set_id) if ch is not None else None
    lins = {str(h.test_case_lineage_id)} if h.test_case_lineage_id else set()
    if cs is not None:
        broken = ((cs.summary or {}).get("locator_check") or {}).get("broken") or {}
        lins |= {lin for lin, locs in broken.items() if any(x.get("file") == h.file and x.get("getter") == h.getter
                                                            for x in locs)}  # fmt: skip
    cases = [c for c in t.cases if str(c.row.lineage_id) in lins and c.status != "rejected"]
    reqs = {x for c in cases for x in c.requirement_lineages if x in t.lk.requirements}
    path = heal_path(pid, cs.key if cs else None, h.key)
    what = f"{h.getter}: {h.old_expression}" if h.getter and h.old_expression else (h.old_expression or "")
    page_object = (
        [artefact_ref(pid, "page_object", None, h.file, f"{h.file}{f' · {what}' if what else ''}") | {"path": path}]
        if h.file
        else []
    )
    root = artefact_ref(pid, "heal_suggestion", h.id, h.key, f"{h.key} · {_kind_text(h.status.value)}") | {"path": path}
    scripts = [lv for lv in _exec_levels(t, cases) if lv["type"] == "automation_script"]
    return _chain_out(
        root,
        [
            {"type": "page_object", "items": page_object},
            *scripts,
            {"type": "test_case", "items": sorted((t.case_ref(c) for c in cases), key=lambda x: str(x["key"]))},
            {
                "type": "requirement",
                "items": sorted((x for x in (t.lk.req_ref(r) for r in reqs) if x), key=lambda x: str(x["key"])),
            },
        ],
        [{"type": "change_set", "items": [artefact_ref(pid, "change_set", cs.id, cs.key, cs.key)]}] if cs else [],
    )


_G8 = {"draft": "waiting for Gate 8", "rejected": "rejected at Gate 8"}


async def _exp_chain(s: AsyncSession, t: Trace, key: str) -> dict[str, Any]:
    from app.db.models import Defect, QualityScan
    from app.domain.enums import QualityScanKind

    pid = t.lk.project_id
    scan = (
        await s.execute(
            select(QualityScan).where(
                QualityScan.project_id == pid, QualityScan.key == key, QualityScan.kind == QualityScanKind.exploratory
            )
        )
    ).scalar_one_or_none()
    if scan is None:
        raise _missing(key)
    findings = await nfe.findings_of(s, scan)
    path = f"/projects/{pid}/execution/exploratory/{scan.key}"
    finding_refs = [
        artefact_ref(pid, "quality_finding", f.id, f.key, f"{f.title} · {f.severity.value.capitalize()}")
        | {"path": f"{path}?finding={f.key}"}
        for f in findings
    ]
    ids = [f.defect_id for f in findings if f.defect_id]
    defects = list((await s.execute(select(Defect).where(Defect.id.in_(ids)))).scalars()) if ids else []
    defect_refs = []
    for d in sorted(defects, key=lambda x: x.key):
        gate = _G8.get(d.status.value, "confirmed at Gate 8")
        defect_refs.append({**_strip(_defect_ref(t, d)), "label": f"{d.key} · {d.status.value.capitalize()} · {gate}"})
    root = artefact_ref(pid, "exploratory_session", scan.id, scan.key,
                        f"{scan.key} · {(scan.config or {}).get('charter_label') or 'Exploratory session'}")  # fmt: skip
    return _chain_out(
        root, [{"type": "quality_finding", "items": finding_refs}, {"type": "defect", "items": defect_refs}]
    )


async def _rel_chain(s: AsyncSession, t: Trace, key: str) -> dict[str, Any]:
    from app.db.models import ReleaseAssessment
    from app.domain.release.criteria import VERDICT_LABEL
    from app.services import release as rsvc

    pid = t.lk.project_id
    a = (
        await s.execute(
            select(ReleaseAssessment).where(ReleaseAssessment.project_id == pid, ReleaseAssessment.key == key)
        )
    ).scalar_one_or_none()
    if a is None:
        raise _missing(key)
    page = f"/projects/{pid}/release-readiness/{a.key}"
    crit = []
    evidence: dict[str, dict[str, Any]] = {}
    for c in a.criteria or []:
        word = _STATUS_WORD.get(str(c.get("status")), str(c.get("status")))
        blocking = " · Blocking" if c.get("blocking") else ""
        crit.append({"type": "release_criterion", "id": None, "key": f"{a.key} · {c.get('id')}",
                     "label": f"{c.get('text')} · {word}{blocking}", "path": page})  # fmt: skip
        for r in rsvc._with_paths(pid, c.get("evidence_refs") or []):
            evidence.setdefault(str(r.get("key")), r)
    verdict = VERDICT_LABEL.get((a.final_verdict or a.recommendation).value, "")
    state = {"final": "Final", "recommended": "Recommended"}.get(rsvc.state_word(a), "Not decided")
    root = artefact_ref(pid, "release_assessment", a.id, a.key, f"{a.key} · {verdict} · {state}")
    return _chain_out(
        root,
        [
            {"type": "release_criterion", "items": crit},
            {"type": "evidence", "items": [evidence[k] for k in sorted(evidence)]},
        ],
    )
