"""AI QA Analyst v2 (P3-06): test-design intents, deterministic and AI-off.

Read intents cite every artefact they mention. Rule-based proposals (`add_test_cases`, `set_suite`) are applied
through the same REST service functions as the UI, with the accepting user's permissions.
"""

from __future__ import annotations

import re
import uuid
from typing import TYPE_CHECKING, Any

from app.domain.enums import CaseStatus
from app.domain.testdesign import generate as gen
from app.services import serialize_p3 as p3
from app.services import testdesign as tds
from app.services import traceability as trace

if TYPE_CHECKING:
    from app.services.assistant import Answer, Turn

NO_MORE_NEGATIVES = "No further negative test cases can be derived from the discovered constraints."
NEGATIVE_RULES = ("design.ep.", "design.eg.", "design.bva.")
SCOPE_LABELS = {
    "high_risk": "high-risk cases",
    "changed_since_g5": "changed since Gate 5",
    "all": "every approved case",
}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


async def _lookup(t: Turn) -> p3.Lookup:
    run = await tds.current_run(t.s, t.project_id)
    return await p3.lookup(t.s, t.project_id, run)


def _case_ref(lk: p3.Lookup, c: Any) -> dict[str, Any]:
    return lk.case_ref(c)


# ------------------------------------------------------------------ read intents


async def list_test_cases(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services.assistant import Answer, _follow

    lk = await _lookup(t)
    if lk.run is None:
        return Answer("There are no test cases yet. They are designed after Gate 4 is approved.", "list_test_cases")
    rows = [c for c in lk.cases if c.status != CaseStatus.rejected]
    for attr in ("status", "technique", "test_type"):
        if p.get(attr):
            rows = [c for c in rows if str(getattr(getattr(c, attr), "value", getattr(c, attr))) == str(p[attr])]
    if p.get("priority"):
        rows = [c for c in rows if p3.effective_priority(c) == p["priority"]]
    if p.get("suite"):
        rows = [c for c in rows if p["suite"] in (c.suites or [])]
    if p.get("lint") in ("error", "warning"):
        rows = [c for c in rows if any(i.get("severity") == p["lint"] for i in c.lint or [])]
    if p.get("requirement_key"):
        lins = {lin for lin, r in lk.requirements.items() if r.key == str(p["requirement_key"]).upper()}
        rows = [c for c in rows if lins & {str(x) for x in c.requirement_lineage_ids or []}]
    rows = p3.sort_cases(rows, "priority")
    a = Answer("", "list_test_cases")
    if not rows:
        a.content = "No test cases match."
        return a
    lines = [f"{len(rows)} test case(s), highest priority first:"]
    for c in rows[:20]:
        key = a.cite(_case_ref(lk, c))
        lines.append(f"- {key} {c.title} ({c.status.value}, priority {p3.effective_priority(c)})")
    if len(rows) > 20:
        lines.append(f"- …and {len(rows) - 20} more")
    a.content = "\n".join(lines)
    a.follow_ups = [_follow("explain_test_case", key=rows[0].key)]
    return a


async def explain_test_case(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services.assistant import Answer, _follow

    key = str(p.get("key") or "").upper()
    lk = await _lookup(t)
    c = next((x for x in lk.cases if x.key == key), None)
    if c is None:
        return Answer(f"I can't find {key or 'that test case'} in the current test design.", "explain_test_case")
    a = Answer("", "explain_test_case")
    ck = a.cite(_case_ref(lk, c))
    lines = [f"{ck} {c.title} ({c.status.value})."]
    cond = lk.conditions.get(str(c.condition_lineage_id)) if c.condition_lineage_id else None
    basis = c.design_basis_ref or {}
    if cond is not None:
        cref = lk.condition_ref(cond.lineage_id)
        assert cref is not None
        lines.append(
            f"It exists for {a.cite(cref)} ({cond.title}) using {c.technique.replace('_', ' ')}"
            + (f', coverage item "{basis.get("coverage_item")}"' if basis.get("coverage_item") else "")
            + "."
        )
    elif basis.get("explanation"):
        lines.append(f"Why: {basis['explanation']}.")
    reqs = [lk.req_ref(x) for x in c.requirement_lineage_ids or []]
    if any(reqs):
        lines.append("Requirements: " + ", ".join(a.cite(r) for r in reqs if r) + ".")
    acs = [lk.ac_ref(x) for x in c.ac_lineage_ids or []]
    if any(acs):
        lines.append("Acceptance criteria: " + ", ".join(a.cite(x) for x in acs if x) + ".")
    data = [lk.data[str(x)] for x in c.data_lineage_ids or [] if str(x) in lk.data]
    if data:
        lines.append("Test data: " + "; ".join(f"{a.cite(lk.data_ref(d))} {p3.data_display(d)}" for d in data) + ".")
    risk = lk.risks.get(str(c.risk_lineage_id)) if c.risk_lineage_id else None
    if risk is not None:
        lines.append(
            f"Priority {p3.effective_priority(c)} comes from {a.cite(lk.risk_ref(risk))} ({risk.level.value})."
        )
    else:
        lines.append(f"Priority {p3.effective_priority(c)}.")
    if c.lint:
        lines.append("Checks: " + "; ".join(str(i.get("message")) for i in c.lint[:5]) + ".")
    lines.append("It hasn't been run: execution arrives in Phase 4.")
    a.content = "\n".join(lines)
    a.follow_ups = [_follow("traceability_for", key=c.key)]
    return a


async def traceability_for(t: Turn, p: dict[str, Any]) -> Answer:
    from app.api.errors import NotFound
    from app.services.assistant import Answer

    key = str(p.get("key") or "").upper()
    tr = await trace.load(t.s, t.project_id)
    try:
        ch = trace.chain(tr, key)
    except NotFound:
        return Answer(f"I can't find {key or 'that item'} in this project.", "traceability_for")
    a = Answer("", "traceability_for")
    lines = [f"Traceability for {a.cite(ch['root'])}:"]
    for direction, label in (("upstream", "Traces back to"), ("downstream", "Traces forward to")):
        for group in ch[direction]:
            if group["items"]:
                names = ", ".join(a.cite(x) for x in group["items"][:12])
                lines.append(f"- {label} {group['type'].replace('_', ' ')}: {names}")
    lines.append("Automation scripts, results and defects: available after test execution (Phase 4).")
    a.content = "\n".join(lines)
    return a


async def coverage_v2(t: Turn, a: Answer) -> list[str]:
    """Test-case coverage lines appended to coverage_summary (numbers equal /traceability/coverage)."""
    if await tds.current_run(t.s, t.project_id) is None:
        return ["Test case coverage appears once test cases are designed (after Gate 4)."]
    tr = await trace.load(t.s, t.project_id)
    cov = trace.coverage(tr)
    gaps = await trace.gaps(t.s, tr)
    rq, ac = cov["requirements"], cov["acceptance_criteria"]
    lines = [
        f"Test cases: {rq['with_approved_case']} of {rq['approved']} approved requirements have an approved test case "
        f"({rq['with_case']} have at least one case); {ac['covered']} of {ac['approved']} approved acceptance "
        f"criteria are covered; {cov['high_risk_requirements']['with_approved_case']} of "
        f"{cov['high_risk_requirements']['total']} high-risk requirements have an approved case."
    ]
    none = gaps["requirements_without_test_cases"]["none"]
    if none:
        lines.append("Requirements without a test case: " + ", ".join(a.cite(x) for x in none[:15]) + ".")
    none_approved = gaps["requirements_without_test_cases"]["none_approved"]
    if none_approved:
        lines.append("Without an approved test case: " + ", ".join(a.cite(x) for x in none_approved[:15]) + ".")
    for g in gaps["untested_high_risk"]["open"][:10]:
        lines.append(
            f"Untested high risk {a.cite(g['risk'])}: " + ", ".join(a.cite(x) for x in g["requirements"][:6]) + "."
        )
    if gaps["test_cases_without_requirements"]:
        lines.append(
            "Test cases without a requirement: "
            + ", ".join(a.cite(x) for x in gaps["test_cases_without_requirements"][:10])
            + "."
        )
    lines.append("Execution coverage is available from Phase 4.")
    return lines


# ------------------------------------------------------------------ proposals


async def propose_negative_cases(t: Turn, p: dict[str, Any]) -> Answer:
    from app.agents.testdesign.agent import TestDesignAgent
    from app.services.assistant import Answer, _readonly

    if not t.can_edit:
        return _readonly("propose_negative_cases")
    lk = await _lookup(t)
    if lk.run is None:
        return Answer("Test cases haven't been designed yet; that happens after Gate 4.", "propose_negative_cases")
    key = str(p.get("requirement_key") or p.get("feature_key") or "").upper()
    reqs = [r for r in lk.requirements.values() if r.key == key]
    if not reqs and key.startswith("FEAT"):
        from sqlalchemy import select

        from app.db.models import ApplicationFeature

        feat = (
            await t.s.execute(
                select(ApplicationFeature).where(
                    ApplicationFeature.project_id == t.project_id, ApplicationFeature.key == key
                )
            )
        ).scalar_one_or_none()
        if feat is not None:
            reqs = [r for r in lk.requirements.values() if str(feat.id) in {str(f) for f in r.feature_ids or []}]
    if not reqs:
        return Answer(
            f"I can't find {key or 'that requirement'} in the current requirements.", "propose_negative_cases"
        )
    agent = TestDesignAgent(t.ctx, None, project_id=t.project_id, run_id=uuid.uuid4(), task_id=uuid.uuid4())  # type: ignore[arg-type]
    try:
        inp, _up = await agent._load(t.s)
    except RuntimeError as exc:
        return Answer(str(exc), "propose_negative_cases")
    lineages = {str(r.lineage_id) for r in reqs}
    design = gen.extra_negatives(inp, lineages)
    active = [c for c in lk.cases if c.status != CaseStatus.rejected]
    existing_keys = {c.match_key for c in lk.cases}
    existing_titles = {_norm(c.title) for c in active}
    existing_values = {
        (d.field_label, d.value) for d in lk.data.values() if d.kind.value != "secret_ref" and d.value is not None
    }

    def signature(pairs: list[tuple[str, str | None, str]]) -> frozenset[tuple[str, str | None]]:
        """The values that make a case distinct: everything except the shared valid fill-ins."""
        return frozenset((label, value) for label, value, name in pairs if not name.endswith("· valid"))

    existing_sigs = {
        signature(
            [(row.field_label, row.value, row.name) for x in c.data_lineage_ids or [] if (row := lk.data.get(str(x)))]
        )
        for c in active
    }
    existing_sigs.discard(frozenset())
    picked: list[gen.CaseDraft] = []
    seen_titles: set[str] = set()
    for c in design.cases:
        if not lineages & set(c.requirement_lineages) or c.positive or c.expected_result_status == "open_question":
            continue
        if not c.rule_id.startswith(NEGATIVE_RULES) or c.match_key in existing_keys:
            continue
        title = _norm(c.title)
        if title in existing_titles or title in seen_titles:
            continue
        sig = signature(
            [
                (d.field_label, d.value, d.name)
                for st in c.steps
                for mk in st.get("data", [])
                if (d := design.data.get(mk)) is not None
            ]
        )
        if sig and sig in existing_sigs:
            continue
        seen_titles.add(title)
        picked.append(c)
    a = Answer("", "propose_negative_cases")
    for r in reqs:
        a.cite(lk.req_ref(r.lineage_id))  # type: ignore[arg-type]
    if not picked:
        negatives = [
            c
            for c in active
            if lineages & {str(x) for x in c.requirement_lineage_ids or []}
            and not (c.design_basis_ref or {}).get("positive")
            and c.technique in (gen.EP, gen.BVA, gen.EG, gen.DT, gen.ST)
        ]
        lines = [NO_MORE_NEGATIVES]
        if negatives:
            lines.append(
                f"Negative test cases already in the design for {', '.join(r.key for r in reqs[:3])}: "
                + ", ".join(a.cite(_case_ref(lk, c)) for c in p3.sort_cases(negatives, "key")[:15])
                + "."
            )
        else:
            lines.append(
                f"{', '.join(r.key for r in reqs[:3])} has no field constraint or form to derive negative cases from."
            )
        a.content = "\n".join(lines)
        return a
    picked = picked[:10]
    cases: list[dict[str, Any]] = []
    for c in picked:
        data = []
        for st in c.steps:
            for mk in st.get("data", []):
                d = design.data.get(mk)
                if d is not None and d.kind != "secret_ref":
                    data.append(
                        {
                            "match_key": d.match_key,
                            "name": d.name,
                            "field_label": d.field_label,
                            "kind": d.kind,
                            "value": d.value,
                            "form_ref": {**d.form_ref, "field_type": d.field_type},
                            "reuse": (d.field_label, d.value) in existing_values,
                        }
                    )
        cases.append(
            {
                "title": c.title,
                "objective": c.objective,
                "preconditions": c.preconditions,
                # The stored text is the text the person reviews: "{d0}" is written out here, not on accept.
                "steps": [{**_preview_step(st, design), "data": list(st.get("data", []))} for st in c.steps],
                "expected_result": c.expected_result,
                "technique": c.technique,
                "test_type": c.test_type,
                "test_level": c.test_level,
                "requirement_lineages": list(c.requirement_lineages),
                "ac_lineages": list(c.ac_lineages),
                "provenance": c.provenance,
                "explanation": c.explanation,
                "coverage_item": c.coverage_item,
                "evidence_refs": list(c.evidence_refs),
                "data": data,
            }
        )
    summary = f"Add {len(cases)} negative test case(s) for {', '.join(r.key for r in reqs[:3])}"
    a.proposals.append(
        {
            "kind": "add_test_cases",
            "target": lk.req_ref(reqs[0].lineage_id),
            "target_type": "requirement",
            "target_id": reqs[0].id,
            "target_lineage_id": reqs[0].lineage_id,
            "summary": summary[:300],
            "payload": {"cases": cases, "design_version": lk.run.version},
            "preview": [
                {
                    "title": x["title"],
                    "steps": [{"action": st["action"], "expected": st["expected"]} for st in x["steps"]],
                    "expected_result": x["expected_result"],
                    "technique": x["technique"],
                    "classification": x["provenance"],
                    "constraint": x["explanation"],
                    "data": [
                        {"field_label": d["field_label"], "value": d["value"], "new": not d["reuse"]} for d in x["data"]
                    ],
                }
                for x in cases
            ],
            "base_versions": {"test_design": lk.run.version},
        }
    )
    lines = [f"I prepared {len(cases)} negative test case(s) not already in the design (rule-based):"]
    lines += [f"- {x['title']}: {x['expected_result']}" for x in cases]
    lines.append("Values are computed from the discovered constraints. Nothing changes until you accept.")
    a.content = "\n".join(lines)
    return a


def _written_out(action: str) -> str:
    """Proposals made before the text was written out at proposal time still carry "{dN}"; never store it."""
    return re.sub(r"\{d\d+\}", "the test value", action)


def _preview_step(st: dict[str, Any], design: gen.DesignOutput) -> dict[str, Any]:
    """A proposal step as people read it: "{d0}" replaced by the value it stands for."""
    action = str(st["action"])
    for i, mk in enumerate(st.get("data", [])):
        d = design.data.get(mk)
        shown = ""
        if d is not None:
            short = d.value is not None and 0 < len(d.value) <= 40 and d.kind != "secret_ref"
            shown = f'"{d.value}"' if short else d.display
        action = action.replace(f"{{d{i}}}", shown or "the value")
    return {"action": action, "expected": st.get("expected", "")}


async def propose_regression_suite(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services.assistant import Answer, _readonly

    if not t.can_edit:
        return _readonly("propose_regression_suite")
    scope = str(p.get("scope") or "high_risk")
    if scope not in ("high_risk", "changed_since_g5", "all"):
        return Answer("Choose high_risk, changed_since_g5 or all.", "propose_regression_suite")
    lk = await _lookup(t)
    if lk.run is None:
        return Answer("Test cases haven't been designed yet; that happens after Gate 4.", "propose_regression_suite")
    approved = [c for c in lk.cases if c.status == CaseStatus.approved]
    reasons: dict[uuid.UUID, str] = {}
    if scope == "all":
        reasons = {c.id: "Approved test case (scope: every approved case)" for c in approved}
    else:
        if scope == "high_risk":
            for c in approved:
                if (c.risk_level or "") in ("high", "very_high"):
                    risk = lk.risks.get(str(c.risk_lineage_id)) if c.risk_lineage_id else None
                    level = str(c.risk_level).replace("_", " ")
                    reasons[c.id] = (
                        f"Covers {risk.key} ({level} risk)" if risk is not None else f"Covers a {level} risk"
                    )
        else:
            last = await tds.last_g5(t.s, t.project_id)
            frozen = {(i["id"], int(i["version"])) for i in tds.snapshot_items(last, "test_case")}
            for c in approved:
                if (str(c.id), c.version) not in frozen:
                    reasons[c.id] = "Changed or added since Gate 5 was last approved"
        # one positive case per feature
        seen_features: set[str] = set()
        for c in p3.sort_cases(approved, "priority"):
            if c.technique not in ("use_case", "equivalence_partitioning", "decision_table"):
                continue
            feats = {
                str(f)
                for lin in c.requirement_lineage_ids or []
                for f in (lk.requirements[str(lin)].feature_ids if str(lin) in lk.requirements else []) or []
            }
            if not (c.design_basis_ref or {}).get("positive"):
                continue
            new = feats - seen_features
            if new:
                seen_features |= feats
                reasons.setdefault(c.id, "Main positive case for its feature, so every feature keeps one check")
    chosen = set(reasons)
    changes = []
    for c in sorted(approved, key=lambda x: x.key):
        has = "regression" in (c.suites or [])
        want = c.id in chosen
        if has != want and (want or scope == "all"):
            to = sorted({*(c.suites or []), "regression"}) if want else sorted(set(c.suites or []) - {"regression"})
            reason = reasons[c.id] if want else "Not selected by this scope"
            changes.append(
                {
                    "case_id": str(c.id),
                    "key": c.key,
                    "action": "add" if want else "remove",
                    "from": list(c.suites or []),
                    "to": to,
                    "reason": reason,
                }
            )
    a = Answer("", "propose_regression_suite")
    if not changes:
        a.content = "The regression suite already matches that selection."
        return a
    for ch in changes:
        a.cite(_case_ref(lk, next(c for c in approved if str(c.id) == ch["case_id"])))
    a.proposals.append(
        {
            "kind": "set_suite",
            "target": None,
            "target_type": None,
            "target_id": None,
            "target_lineage_id": None,
            "summary": f"Update the regression suite on {len(changes)} approved test case(s) ({SCOPE_LABELS[scope]})",
            "payload": {"changes": changes, "scope": scope},
            "preview": [
                {"key": ch["key"], "action": ch["action"], "from": ch["from"], "to": ch["to"], "reason": ch["reason"]}
                for ch in changes
            ],
            "base_versions": {
                ch["case_id"]: next(c.version for c in approved if str(c.id) == ch["case_id"]) for ch in changes
            },
        }
    )
    a.content = "Proposed regression suite changes (rule-based):\n" + "\n".join(
        f"- {ch['key']}: {', '.join(ch['from']) or 'no suite'} → {', '.join(ch['to']) or 'no suite'} ({ch['reason']})"
        for ch in changes
    )
    return a


# ------------------------------------------------------------------ apply


async def apply(ctx: Any, s: Any, p: Any, pr: Any, after: list[Any]) -> list[dict[str, Any]]:
    """Applies add_test_cases / set_suite inside the caller's transaction (no commit here).

    Uses the same service functions as the REST endpoints (validation, revisions, audit). Everything is
    flushed into one transaction so the caller either commits all of it or rolls all of it back. A G5
    reopen orchestrator is appended to `after` for the caller to emit once committed.
    """
    from app.api.errors import Conflict
    from app.api.routers import p2common as c
    from app.api.routers import testdesign as td_api
    from app.db.models import TestCase
    from app.db.types import utcnow
    from app.domain.enums import CaseSource, GateKey, GeneratedBy, Provenance
    from app.services import serialize_p2 as out

    payload = pr.payload or {}
    project_id: uuid.UUID = pr.project_id
    key: str = pr.key
    kind: str = pr.kind
    base = dict(pr.base_versions or {})
    applied: list[dict[str, Any]] = []
    reopen_reasons: list[str] = []
    if kind == "add_test_cases":
        run = await tds.current_run(s, project_id)
        if run is None or run.version != int(base.get("test_design", -1)):
            raise Conflict("The test design changed since this proposal; ask again")
        lk = await p3.lookup(s, project_id, run)
        req_ids = {lin: r.id for lin, r in lk.requirements.items()}
        ac_ids = {lin: a.id for lin, a in lk.acs.items()}
        by_value: dict[tuple[str, str], uuid.UUID] = {
            (d.field_label, d.value): d.id
            for d in lk.data.values()
            if d.status.value == "active" and d.value is not None
        }
        for case in payload.get("cases", []):
            data_ids: dict[str, uuid.UUID] = {}
            for d in case.get("data", []):
                data_id = by_value.get((d["field_label"], d["value"]))
                if data_id is None:
                    body = td_api.DataCreate(
                        name=d["name"][:200],
                        field_label=d["field_label"],
                        form_ref=d.get("form_ref") or None,
                        kind=d["kind"] if d["kind"] in ("valid", "invalid", "boundary") else "invalid",
                        value=d["value"],
                    )
                    created = await td_api.create_data_row(
                        s, p, project_id, body, origin=td_api.Origin(provenance=Provenance.inferred)
                    )
                    data_id = created.id
                    by_value[(d["field_label"], d["value"])] = data_id
                    applied.append(out.artefact_ref(project_id, "test_data", data_id, created.key, created.name))
                data_ids[d["match_key"]] = data_id
            steps = [
                td_api.StepIn(
                    action=_written_out(st["action"])[:500],
                    data_ids=[data_ids[m] for m in st.get("data", []) if m in data_ids],
                    expected=(st.get("expected") or "")[:500],
                )
                for st in case["steps"]
            ]
            create = td_api.CaseCreate(
                title=case["title"][:160],
                objective=case.get("objective", "")[:1000],
                preconditions=case.get("preconditions", []),
                steps=steps,
                expected_result=case.get("expected_result", "")[:1000],
                test_type=case.get("test_type", "functional"),
                test_level=case.get("test_level", "system"),
                technique=case.get("technique", "error_guessing"),
                requirement_ids=[req_ids[x] for x in case.get("requirement_lineages", []) if x in req_ids],
                acceptance_criterion_ids=[ac_ids[x] for x in case.get("ac_lineages", []) if x in ac_ids],
            )
            prov = Provenance(case.get("provenance") or "assumed")
            origin = td_api.Origin(
                provenance=prov,
                generated_by=GeneratedBy.rules,
                design_basis={
                    "coverage_item": case.get("coverage_item"),
                    "explanation": case.get("explanation") or f"From assistant proposal {key}",
                },
                evidence_refs=tuple(case.get("evidence_refs") or ()),
            )
            case_row = await td_api.create_case(
                ctx, s, p, project_id, create, source=CaseSource.assistant, origin=origin
            )
            applied.append(out.artefact_ref(project_id, "test_case", case_row.id, case_row.key, case_row.title))
            reopen_reasons.append(f"{case_row.key} created")
    elif kind == "set_suite":
        changes = payload.get("changes", [])
        rows: list[tuple[Any, list[str]]] = []
        for ch in changes:  # all or nothing: check every version before touching anything
            tc = await c.load(s, TestCase, uuid.UUID(ch["case_id"]), "Test case")
            c.check_version(tc, int(base.get(ch["case_id"], -1)))
            rows.append((tc, list(ch["to"])))
        for tc, suites in rows:
            patch = td_api.CasePatch(version=tc.version, suites=suites, change_reason=f"Assistant proposal {key}")
            if await td_api.patch_case_row(ctx, s, p, tc, patch):
                reopen_reasons.append(f"{tc.key} edited")
            applied.append(out.artefact_ref(project_id, "test_case", tc.id, tc.key, tc.title))
    if applied:
        project = await c.project_of(s, project_id)
        if reopen_reasons:
            orch = await c.reopen_if_approved(
                ctx, s, project, GateKey.G5, f"assistant proposal {key}: " + ", ".join(reopen_reasons[:3]), p.user.id
            )
            if orch is not None:
                after.append(orch)
        project.updated_at = utcnow()
        await s.flush()
    return applied
