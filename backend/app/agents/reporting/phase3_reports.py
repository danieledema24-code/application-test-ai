"""Phase 3 reports (P3-08): Test Case Specification and Requirements Traceability Matrix, plus their CSV exports.

Content comes from the same services as the API (counts equal `/test-cases/stats`, coverage equals
`/traceability/coverage`). Test data appears as synthetic values; credentials are named, never shown.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import Project
from app.domain.enums import CaseStatus, GateKey, ReportType
from app.domain.testdesign.generate import DEFINITIONS
from app.services import gates
from app.services import serialize as ser
from app.services import serialize_p2 as out2
from app.services import serialize_p3 as out
from app.services import testdesign as tds
from app.services import traceability as trace

DESIGN_FIRST = "Design test cases first"
EXECUTION_NOTE = "Execution status: Not run. Execution arrives in Phase 4."
PHASE4 = "Not available until Phase 4"
DISCLAIMER = (
    "Test cases are designed from the observable user interface and the approved requirements; backend behaviour is "
    "not verified. Test data is synthetic. Nothing in this document has been executed."
)
SYNTHETIC_NOTE = (  # design check 61
    "Synthetic data only. Values are generated for testing and aren't real people's details "
    "(reserved example domains, fictional phone ranges and published test cards). Saved logins are named, never shown."
)
FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


async def has_design(s: AsyncSession, project_id: Any) -> bool:
    return await tds.current_run(s, project_id) is not None


async def build(ctx: AppContext, s: AsyncSession, project: Project, report_type: ReportType) -> dict[str, Any]:
    run = await tds.current_run(s, project.id)
    if run is None:
        raise ValueError(DESIGN_FIRST)
    if report_type == ReportType.test_case_spec:
        return await _spec(ctx, s, project, run)
    return await _rtm(s, project)


async def _spec(ctx: AppContext, s: AsyncSession, project: Project, run: Any) -> dict[str, Any]:
    from app.api.routers.testdesign import case_stats

    await tds.ensure_lint_current(s, project.id, run.id)
    lk = await out.lookup(s, project.id, run)
    counts = await case_stats(s, project.id)
    cases = [c for c in out.sort_cases(lk.cases, "priority") if c.status != CaseStatus.rejected]
    evs = await ser.evidence_map(s, [x.get("evidence_id") for c in cases for x in c.evidence_refs or []])
    details = {c.id: out.case_detail(ctx, c, lk, {k: v for k, v in evs.items() if _cites(c, k)}) for c in cases}
    by_feature: dict[str, list[dict[str, Any]]] = {}
    feature_names = await _feature_names(s, project.id)
    for r in sorted(lk.requirements.values(), key=lambda x: x.key):
        mine = [c for c in cases if str(r.lineage_id) in {str(x) for x in c.requirement_lineage_ids or []}]
        if not mine:
            continue
        fname = next((feature_names[str(f)] for f in r.feature_ids or [] if str(f) in feature_names), "Other")
        by_feature.setdefault(fname, []).append(
            {"requirement": lk.req_ref(r.lineage_id), "cases": [details[c.id] for c in mine]}
        )
    orphans = [c for c in cases if not any(str(x) in lk.requirements for x in c.requirement_lineage_ids or [])]
    if orphans:
        by_feature.setdefault("Not linked to a requirement", []).append(
            {"requirement": None, "cases": [details[c.id] for c in orphans]}
        )
    conds = sorted(lk.conditions.values(), key=lambda c: c.key)
    used = sorted({c.technique for c in conds if c.status.value != "rejected"} | {c.technique for c in cases})
    techniques = [
        {
            "technique": t,
            "definition": DEFINITIONS.get(t, ""),
            "conditions": sum(1 for c in conds if c.technique == t and c.status.value != "rejected"),
        }
        for t in used
    ]
    total = counts["total"] - counts["by_status"].get("rejected", 0)
    return {
        "scope_and_method": [
            f"Test design version {run.version}, from the approved requirements and test strategy.",
            "Values for partitions and boundaries are computed in code from the constraints discovery observed.",
            "Cases are ordered by risk-based priority within each requirement.",
        ],
        "techniques": techniques,
        "counts": counts,
        "cases_by_feature": by_feature,
        "conditions": [out.condition_out(c, lk) for c in conds],
        "test_data": [out.data_out(d, lk) for d in sorted(lk.data.values(), key=lambda d: d.key)],
        "test_data_note": SYNTHETIC_NOTE,
        "not_designed": list((run.output or {}).get("not_designed", [])),
        "execution_note": EXECUTION_NOTE,
        "summary": (
            f"{total} test case(s) across {sum(len(v) for v in by_feature.values())} requirement group(s): "
            f"{counts['by_status'].get('approved', 0)} approved, {counts['by_status'].get('draft', 0)} draft, "
            f"{counts['open_questions']} open question(s)."
        ),
        "summary_generated_by": "rules",
        "disclaimer": DISCLAIMER,
        "stage_run_version": run.version,
    }


def _cites(c: Any, evidence_id: Any) -> bool:
    return str(evidence_id) in {str(x.get("evidence_id")) for x in c.evidence_refs or []}


async def _feature_names(s: AsyncSession, project_id: Any) -> dict[str, str]:
    from sqlalchemy import select

    from app.db.models import ApplicationFeature

    rows = (await s.execute(select(ApplicationFeature).where(ApplicationFeature.project_id == project_id))).scalars()
    return {str(f.id): f.name for f in rows}


async def _based_on(s: AsyncSession, project_id: Any) -> dict[str, str | None]:
    out_: dict[str, str | None] = {}
    for gate in (GateKey.G3, GateKey.G4, GateKey.G5):
        d = await gates.last_approval(s, project_id, gate)
        if d is None:
            out_[gate.value] = None
            continue
        us = await out2.users(s, [d.decided_by])
        who = us.get(d.decided_by) if d.decided_by else None
        by = f" by {who.full_name}" if who is not None else ""
        out_[gate.value] = f"{(d.snapshot_hash or '')[:12]} · approved{by} on {d.created_at.date().isoformat()}"
    return out_


async def _rtm(s: AsyncSession, project: Project) -> dict[str, Any]:
    t = await trace.load(s, project.id)
    cov = trace.coverage(t)
    return {
        "based_on": await _based_on(s, project.id),
        "forward": [trace.public(r) for r in trace.forward_rows(t)],
        "backward": [trace.public(r) for r in trace.backward_rows(t)],
        "coverage": cov,
        "gaps": await trace.gaps(s, t),
        "phase4_note": PHASE4,
        "summary": (
            f"{cov['requirements']['with_approved_case']} of {cov['requirements']['approved']} approved requirement(s) "
            f"have an approved test case; {cov['acceptance_criteria']['covered']} of "
            f"{cov['acceptance_criteria']['approved']} approved acceptance criteria are covered."
        ),
        "summary_generated_by": "rules",
        "stage_run_version": t.design_version,
    }


# ------------------------------------------------------------------ CSV


def safe_cell(value: Any) -> str:
    """Spreadsheet formula-injection guard: a cell starting with = + - @ tab or CR is prefixed with '."""
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(FORMULA_START) else text


def _keys(refs: list[dict[str, Any]] | None) -> str:
    return ", ".join(str(r["key"]) for r in refs or [] if r)


def _expected(c: dict[str, Any]) -> str:
    text = str(c.get("expected_result") or "")
    return f"Not decided: {text}" if c.get("expected_result_status") == "open_question" else text


def to_csv(content: dict[str, Any]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    if content["report_type"] == ReportType.test_case_spec.value:
        w.writerow(
            [
                "Key", "Title", "Status", "Priority", "Risk", "Technique", "Test type", "Test level", "Requirements",
                "Acceptance criteria", "Condition", "Objective", "Preconditions", "Steps", "Expected result",
                "Test data", "Suites", "Lint", "Execution",
            ]
        )  # fmt: skip
        # One row per case: a case linked to several requirements appears in several groups but once here.
        written: set[str] = set()
        for group in content["cases_by_feature"].values():
            for g in group:
                for c in g["cases"]:
                    if c["key"] in written:
                        continue
                    written.add(c["key"])
                    steps = " | ".join(
                        f"{st['n']}. {st['action']}" + (f" → {st['expected']}" if st.get("expected") else "")
                        for st in c["steps"]
                    )
                    data = "; ".join(str(d["label"]) for st in c["steps"] for d in st.get("data", []))
                    w.writerow(
                        [
                            safe_cell(x)
                            for x in (
                                c["key"], c["title"], c["status"], c["priority"], c.get("risk_level") or "",
                                c["technique"], c["test_type"], c["test_level"], _keys(c["requirements"]),
                                _keys(c["acceptance_criteria"]), (c.get("condition") or {}).get("key", ""),
                                c["objective"], "; ".join(c["preconditions"]), steps, _expected(c), data,
                                ", ".join(c.get("suites") or []),
                                ", ".join(sorted({i["code"] for i in c.get("lint") or []})),
                                "Not run",
                            )
                        ]
                    )  # fmt: skip
    else:
        w.writerow(
            [
                "Requirement", "Requirement title", "Requirement status", "Risk level", "Acceptance criteria",
                "Test case", "Test case status", "Priority", "Automation", "Results", "Defects",
            ]
        )  # fmt: skip
        for row in content["forward"]:
            req = row["requirement"] or {}
            title = str(req.get("label", "")).split(" · ", 1)[-1]
            risk = (row.get("risk") or {}).get("level") or ""
            acs = ", ".join(str(a["ac"]["key"]) for a in row["acceptance_criteria"] if a.get("ac"))
            cases = row["test_cases"] or [None]
            for tc in cases:
                w.writerow(
                    [
                        safe_cell(x)
                        for x in (
                            req.get("key", ""), title, row["requirement_status"], risk, acs,
                            tc["case"]["key"] if tc else "No test case", tc["status"] if tc else "",
                            tc["priority"] if tc else "", PHASE4, PHASE4, PHASE4,
                        )
                    ]
                )  # fmt: skip
    return ("﻿" + buf.getvalue()).encode("utf-8")
