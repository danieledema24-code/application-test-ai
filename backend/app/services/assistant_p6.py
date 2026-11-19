"""AI QA Analyst v5 (P6-06): change, repair, exploration and release intents, grounded in stored rows only.

Deterministic, AI off: `what_changed` (the latest rescan change set, always ending with the fixed change statement),
`impact_summary`, `explain_heal` (the coded signals in words and the fixed repair line; no accept here), and
`release_readiness_summary` ("Can we release?": the latest assessment only, verdict and blocking criteria from the
stored row, always ending with the fixed release statement; with AI on the router still answers it from the rules, so
the model can't contradict the verdict). Proposals: `propose_regression_run` creates a run **request** waiting for
Gate 7; `propose_exploration` starts an anonymous session, or requests a signed-in one that waits for its approval,
only when a person accepts it (one session at a time); `assess_release` (from "Can we release?" without an assessment)
starts an assessment. The assistant never authorises, approves or decides anything.
"""

from __future__ import annotations

import uuid
from collections import Counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.api.errors import AppError
from app.db.models import ChangeItem, ChangeSet, HealSuggestion, ImpactItem, QualityScan, ReleaseAssessment, ScanSession
from app.db.types import utcnow
from app.domain.change import diff as d
from app.domain.change.heal import REPAIR_LINE
from app.domain.enums import ApprovalStatus, HealKind, ImpactStatus, QualityScanKind, StageKey
from app.domain.release import criteria as rc
from app.services import serialize_p2 as out

if TYPE_CHECKING:
    from app.services.assistant import Answer, Turn

VIEWERS = "Only members, owners and admins can apply proposals."
NO_CHANGE_SET = "No rescan has been compared yet. Rescan the site after Gate 2 to see what changed."
NO_ASSESSMENT = "No release assessment exists yet."
EXPLORE_FOOTER = "Only clicks things that can't change data and blocks anything the page tries to send."
EXPLORE_APPROVAL = "Needs approval by someone who can approve."
REGRESSION_FOOTER = (
    "Creates a run request. Someone who can approve must still authorise it at Gate 7; the assistant can't start runs."
)
P6_PREFIXES = ("CHG", "EXP", "HEAL", "REL")
SIGNIFICANCES = ("structural", "behavioural", "cosmetic")
LEVEL_WORD = {"high": "High match", "medium": "Medium match", "low": "Low match"}
ACTION_WORD = {
    "rerun": "re-run",
    "review": "review",
    "heal": "repair the script",
    "regenerate": "regenerate",
    "write_requirement": "write a requirement",
}


def _a(content: str, intent: str) -> Answer:
    from app.services.assistant import Answer

    return Answer(content, intent)


def _follow(intent: str, **params: Any) -> dict[str, Any]:
    from app.services.assistant import _follow as f

    return f(intent, **params)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _ref(project_id: uuid.UUID, kind: str, id_: Any, key: str, label: str) -> dict[str, Any]:
    return out.artefact_ref(project_id, kind, id_, key, label)


def set_ref(project_id: uuid.UUID, cs: ChangeSet) -> dict[str, Any]:
    return _ref(project_id, "change_set", cs.id, cs.key, f"Change set {cs.key}")


def heal_ref(project_id: uuid.UUID, h: HealSuggestion, cs_key: str | None = None) -> dict[str, Any]:
    from app.services.traceability import heal_path

    ref = _ref(project_id, "heal_suggestion", h.id, h.key, f"Repair suggestion {h.key}")
    return {**ref, "path": heal_path(project_id, cs_key, h.key)}


def session_ref(project_id: uuid.UUID, sc: QualityScan) -> dict[str, Any]:
    return _ref(project_id, "exploratory_session", sc.id, sc.key, f"Exploratory session {sc.key}")


def assessment_ref(project_id: uuid.UUID, a: ReleaseAssessment) -> dict[str, Any]:
    return _ref(project_id, "release_assessment", a.id, a.key, f"Release assessment {a.key}")


def minutes_text(seconds: int | None) -> str:
    if not seconds:
        return ""
    return f", about {max(1, round(seconds / 60))} min"


async def latest_set(t: Turn) -> ChangeSet | None:
    from app.services.traceability import rescan_sets

    sets = await rescan_sets(t.s, t.project_id)
    return sets[-1] if sets else None


async def _scan_word(t: Turn, scan_id: uuid.UUID) -> str:
    sc = await t.s.get(ScanSession, scan_id)
    if sc is None:
        return "a scan"
    when = sc.started_at or sc.created_at
    return f"Scan {sc.sequence}" + (f" ({when.strftime('%-d %b')})" if when else "")


async def _impact(t: Turn, cs: ChangeSet) -> list[ImpactItem]:
    q = select(ImpactItem).where(ImpactItem.change_set_id == cs.id).order_by(ImpactItem.created_at, ImpactItem.id)
    return list((await t.s.execute(q)).scalars())


# ---------------------------------------------------------------- what changed / impact


async def what_changed(t: Turn, _p: dict[str, Any]) -> Answer:
    a = _a("", "what_changed")
    cs = await latest_set(t)
    if cs is None:
        a.content = f"{NO_CHANGE_SET}\n{d.CHANGE_STATEMENT}"
        return a
    key = a.cite(set_ref(t.project_id, cs))
    summary = cs.summary or {}
    sig = summary.get("by_significance") or {}
    total = int(summary.get("total") or 0)
    base, target = await _scan_word(t, cs.base_scan_session_id), await _scan_word(t, cs.target_scan_session_id)
    parts = ", ".join(f"{int(sig.get(x) or 0)} {x}" for x in SIGNIFICANCES)
    lines = [f"{key} found {_plural(total, 'change')} between {base} and {target}: {parts}."]
    pages = summary.get("pages") or {}
    if pages:
        lines.append(
            f"Pages: {int(pages.get('added') or 0)} added, {int(pages.get('removed') or 0)} removed, "
            f"{int(pages.get('changed') or 0)} changed."
        )
    rows = list((await t.s.execute(select(ChangeItem).where(ChangeItem.change_set_id == cs.id))).scalars())
    rows.sort(key=lambda r: (SIGNIFICANCES.index(r.significance.value), d.KIND_ORDER.index(r.kind)))
    for r in rows[:10]:
        lines.append(f"- {d.describe(d.Change(r.kind, r.significance, r.page_url, r.before, r.after))} "
                     f"({r.significance.value})")  # fmt: skip
    if len(rows) > 10:
        lines.append(f"…and {len(rows) - 10} more on the change set page.")
    items = await _impact(t, cs)
    if cs.rerun_recommendation is not None:
        n_open = sum(1 for i in items if i.status == ImpactStatus.open)
        lines.append(f"{n_open} of {_plural(len(items), 'impact item')} {'is' if n_open == 1 else 'are'} open.")
        a.follow_ups.append(_follow("impact_summary"))
        a.follow_ups.append(_follow("propose_regression_run"))
    if cs.rebaseline_suggested:
        lines.append("More than half the pages changed. Consider regenerating requirements from the new scan.")
    lines.append(d.CHANGE_STATEMENT)
    a.content = "\n".join(lines)
    return a


async def impact_summary(t: Turn, _p: dict[str, Any]) -> Answer:
    from app.services import impact as impact_svc

    a = _a("", "impact_summary")
    cs = await latest_set(t)
    if cs is None:
        a.content = NO_CHANGE_SET
        return a
    key = a.cite(set_ref(t.project_id, cs))
    if cs.rerun_recommendation is None:
        a.content = f"{key}: {impact_svc.NOT_READY}."
        return a
    items = await _impact(t, cs)
    targets = await impact_svc._targets(t.s, t.project_id, items) if items else {}
    opened = [i for i in items if i.status == ImpactStatus.open]
    by_action = Counter(i.action.value for i in opened)
    lines = [
        f"{key} affects {_plural(len(items), 'item')}; {len(opened)} {'is' if len(opened) == 1 else 'are'} open"
        + (
            ": " + ", ".join(f"{n} to {ACTION_WORD.get(k, k)}" for k, n in sorted(by_action.items()))
            if by_action
            else ""
        )
        + "."
    ]
    order = {"direct": 0, "indirect": 1, "gap": 2}
    for i in sorted(opened, key=lambda x: (order.get(x.level.value, 9), x.target_kind.value))[:10]:
        tg = targets.get((i.target_kind.value, i.target_ref)) or {}
        who = str(tg.get("key") or "")
        lines.append(f"- {who + ': ' if who and who not in i.reason else ''}{i.reason} ({i.level.value})")
    if len(opened) > 10:
        lines.append(f"…and {len(opened) - 10} more on the Impact tab.")
    rec = await impact_svc.recommendation_view(t.s, cs, can_request=False)
    if rec.get("available"):
        lines.append(f"Regression: {len(rec['must'])} must run, {len(rec['should'])} should run.")
        if rec.get("blocked"):
            lines.append(str(rec["blocked"]["message"]))
        a.follow_ups.append(_follow("propose_regression_run"))
    a.content = "\n".join(lines)
    return a


# ---------------------------------------------------------------- proposals: regression run, exploration


async def propose_regression_run(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services import impact as impact_svc

    a = _a("", "propose_regression_run")
    cs = await latest_set(t)
    if cs is None:
        a.content = NO_CHANGE_SET
        return a
    key = a.cite(set_ref(t.project_id, cs))
    rec = await impact_svc.recommendation_view(t.s, cs, can_request=t.can_edit)
    if not rec.get("available"):
        a.content = f"{key}: {rec.get('reason')}"
        return a
    if rec.get("blocked"):
        # Design §7.4 / OQ3: the reason replaces the button; a must-run test is never dropped silently.
        names = ", ".join(rec["blocked"]["case_keys"])
        a.content = f"{key}: {rec['blocked']['message']} ({names})"
        return a
    include_should = p.get("include_should") is not False
    must = [x for x in rec["must"] if x["runnable"]]
    should = [x for x in rec["should"] if x["runnable"]] if include_should else []
    if not must and not should:
        a.content = f"{key}: none of the recommended tests can run automatically. A person runs the manual ones."
        return a
    if not t.can_edit:
        a.content = VIEWERS
        return a
    est = rec["estimate"]
    secs = est.get("with_should_seconds") if include_should else est.get("must_seconds")
    n = len(must) + len(should)
    split = f"{len(must)} must run, {len(should)} should run" if include_should else f"{len(must)} must run"
    summary = f"Re-run {_plural(n, 'test')} recommended after {key} ({split}){minutes_text(secs)}."
    a.content = f"{summary}\n{REGRESSION_FOOTER}"
    a.proposals.append(
        {
            "kind": "request_regression_run",
            "target": set_ref(t.project_id, cs),
            "target_type": "change_set",
            "target_id": cs.id,
            "target_lineage_id": None,
            "summary": summary[:300],
            "payload": {"change_set_id": str(cs.id), "change_set_key": cs.key, "include_should": include_should},
            "preview": [{"case_key": x["key"], "group": "must"} for x in must]
            + [{"case_key": x["key"], "group": "should"} for x in should],
            "base_versions": {},
        }
    )
    return a


async def _waiting_readonly(t: Turn, esvc: Any) -> QualityScan | None:
    """A signed-in request still waiting for approval and not yet past its 24 h, found without changing anything."""
    from app.services.approvals import _aware

    rows = (
        await t.s.execute(
            select(QualityScan)
            .where(
                QualityScan.project_id == t.project_id,
                QualityScan.kind == esvc.KIND,
                QualityScan.status.in_(esvc.WAITING),
            )
            .order_by(QualityScan.created_at)
        )
    ).scalars()
    now = _aware(utcnow())
    for scan in list(rows):
        ap = await esvc.approval_of(t.s, scan)
        if ap is not None and ap.status == ApprovalStatus.pending and _aware(ap.expires_at) > now:
            return scan
    return None


async def propose_exploration(t: Turn, p: dict[str, Any]) -> Answer:
    from app.api.routers import p2common as c
    from app.domain.exploratory import limits as lim
    from app.orchestrator.orchestrator import Orchestrator
    from app.services import approvals as apr
    from app.services import exploratory as esvc
    from app.services.secrets import credentials_secret

    a = _a("", "propose_exploration")
    if not t.can_edit:
        a.content = VIEWERS
        return a
    signed_in = bool(p.get("signed_in"))
    project = await c.project_of(t.s, t.project_id)
    try:
        await Orchestrator(t.ctx).check_optional_upstream(t.s, project, StageKey.exploratory)
    except AppError as exc:
        a.content = exc.message
        return a
    # Asking is read-only (QA P6-06): esvc._waiting would expire an overdue request, so look without writing.
    busy = await esvc._busy(t.s, t.project_id) or await _waiting_readonly(t, esvc)
    if busy is not None:
        a.cite(session_ref(t.project_id, busy))
        why = esvc._one_at_a_time if busy.status in esvc.ACTIVE else esvc._waiting_for_approval
        a.content = why(busy.key).message
        return a
    if signed_in and await credentials_secret(t.s, t.project_id) is None:
        a.content = esvc.NEEDS_CREDENTIALS
        return a
    cs = await esvc.latest_change_set(t.s, t.project_id)
    charter = "change_set" if cs is not None else "all"
    try:
        pages, _left, cs, _names = await esvc._charter_pages(t.s, project, charter, page_ids=None,
                                                             change_set_id=None, signed_in=signed_in)  # fmt: skip
    except AppError as exc:
        if charter != "change_set":
            a.content = exc.message
            return a
        charter, cs = "all", None  # nothing new or changed to explore: offer every page instead
        try:
            pages, _left, _cs, _names = await esvc._charter_pages(t.s, project, charter, page_ids=None,
                                                                  change_set_id=None, signed_in=signed_in)  # fmt: skip
        except AppError as exc2:
            a.content = exc2.message
            return a
    pages = pages[: t.ctx.settings.scan_max_pages_cap]
    ceiling = await esvc.org_ceiling(t.s, project.organisation_id)
    budget = lim.effective_ceiling(ceiling, t.ctx.settings.explore_cap)
    _origin, host = await apr.target(t.s, t.project_id)
    what = (
        f"{_plural(len(pages), 'new and changed page')} from {a.cite(set_ref(t.project_id, cs))}"
        if cs is not None
        else f"{_plural(len(pages), 'page')} discovery found"
    )
    who = "signed in with the saved test account" if signed_in else "not signed in"
    summary = f"Explore {what}: up to {budget.actions} actions and {budget.minutes} minutes, {who}."
    footer = f"{EXPLORE_FOOTER} {EXPLORE_APPROVAL}" if signed_in else EXPLORE_FOOTER
    a.content = f"{summary}\n{footer}\nNothing starts until you accept this proposal."
    a.proposals.append(
        {
            "kind": "start_exploration",
            "target": set_ref(t.project_id, cs) if cs is not None else None,
            "target_type": "quality_scan",
            "target_id": None,
            "target_lineage_id": None,
            "summary": summary[:300],
            "payload": {
                "charter": charter,
                "change_set_id": str(cs.id) if cs is not None else None,
                "signed_in": signed_in,
                "host": host,
                "budget": budget.as_dict(),
            },
            "preview": [{"path": d.path_of(pg.final_url or pg.url)} for pg in pages[:50]],
            "base_versions": {},
        }
    )
    return a


# ---------------------------------------------------------------- repairs


async def explain_heal(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services import repairs as rsvc

    key = str(p.get("key") or "").upper()
    a = _a("", "explain_heal")
    h = None
    if key:
        q = select(HealSuggestion).where(HealSuggestion.project_id == t.project_id, HealSuggestion.key == key)
        h = (await t.s.execute(q)).scalar_one_or_none()
    if h is None:
        a.content = "Give a repair suggestion key, for example HEAL-0001." if not key else (
            f"I can't find {key} in this project."
        )  # fmt: skip
        return a
    cs_key = None
    if h.change_item_id is not None:
        ch = await t.s.get(ChangeItem, h.change_item_id)
        cs = await t.s.get(ChangeSet, ch.change_set_id) if ch is not None else None
        if cs is not None:
            cs_key = a.cite(set_ref(t.project_id, cs))
    hk = a.cite(heal_ref(t.project_id, h, cs_key))
    status = h.status.value
    if h.kind == HealKind.expected_result_review:
        a.content = (
            f"{hk} ({status}): the text a test checks changed, so its test case needs review. Nothing is changed "
            "automatically; a person reviews the test case.\nExpected results are never changed automatically."
        )
        return a
    cands, _meta = rsvc.split(h)
    where = f"{h.file}" + (f" · {h.getter}" if h.getter else "")
    lines = [f"{hk} ({status}) replaces the locator {h.old_expression} in {where}."]
    if cs_key:
        lines.append(f"It was suggested after {cs_key}.")
    offered = sorted((c for c in cands if c.get("offered")), key=lambda c: -float(c.get("score") or 0))
    for i, c in enumerate(offered[:3], 1):
        signals = "; ".join(str(x.get("text")) for x in c.get("signals") or [])
        found = "found exactly 1 visible element" if c.get("match_count") == 1 else f"{c.get('match_count')} matches"
        lines.append(f"{i}. {c.get('expression')} · {LEVEL_WORD.get(str(c.get('level')), '')} · {found}"
                     + (f" · {signals}" if signals else ""))  # fmt: skip
    if not offered:
        lines.append("No candidate matched exactly one element, so none is offered.")
    if h.accepted_index is not None and 0 <= h.accepted_index < len(cands):
        lines.append(f"Accepted: {cands[h.accepted_index].get('expression')}.")
    lines.append("Accept or reject it on the repair card; the assistant can't accept repairs.")
    lines.append(REPAIR_LINE)
    a.content = "\n".join(lines)
    return a


# ---------------------------------------------------------------- release readiness


def _status_text(st: str) -> str:
    return {"met": "met", "not_met": "not met", "not_evaluable": "not evaluable"}.get(st, st)


async def release_readiness_summary(t: Turn, _p: dict[str, Any]) -> Answer:
    """Design §12.3: verdict with Recommended/Final, REL key, blocking criteria, override line, then always the fixed
    statement. Never "ready to release" unless the final verdict is Go."""
    from app.db.models import User
    from app.orchestrator.orchestrator import Orchestrator
    from app.services import release as rsvc

    a = _a("", "release_readiness_summary")
    rows = await rsvc.history(t.s, t.project_id)
    latest = rows[0] if rows else None
    if latest is None:
        from app.api.routers import p2common as c

        project = await c.project_of(t.s, t.project_id)
        try:
            await Orchestrator.check_release_ready(t.s, project)
        except AppError as exc:
            a.content = f"{NO_ASSESSMENT} {exc.message}"
            return a
        if not t.can_edit:
            a.content = f"{NO_ASSESSMENT} {VIEWERS}"
            return a
        a.content = f"{NO_ASSESSMENT} Accept the proposal to assess release readiness now."
        a.proposals.append(
            {
                "kind": "assess_release",
                "target": None,
                "target_type": "release_assessment",
                "target_id": None,
                "target_lineage_id": None,
                "summary": "Assess release readiness now.",
                "payload": {},
                "preview": [],
                "base_versions": {},
            }
        )
        return a
    key = a.cite(assessment_ref(t.project_id, latest))
    verdict = rc.VERDICT_LABEL[(latest.final_verdict or latest.recommendation).value]
    state = rsvc.state_word(latest)
    lines: list[str] = []
    if latest.status.value == "stale":
        lines.append(f"{key} is out of date: evidence changed after it.")
    if state == "final":
        who = await t.s.get(User, latest.decided_by) if latest.decided_by else None
        name = (who.full_name or "someone") if who else "someone"
        lines.append(f"{key}: {verdict} · Final (decided by {name}).")
        override = rsvc.override_line(latest, name)
        if override:
            lines.append(override)
        if latest.final_verdict is not None and latest.final_verdict.value == "go":
            lines.append("The final verdict is Go: the release was approved at Gate 9.")
    elif latest.status.value == "rejected":
        lines.append(f"{key}: {verdict} · Recommended, rejected at Gate 9. Assess again for a new recommendation.")
    else:
        word = "Recommended" if state == "recommended" else "Not decided"
        lines.append(f"{key}: {verdict} · {word}. Gate 9 decides; the recommendation is advisory.")
    reason = (latest.scope or {}).get("reason")
    if reason:
        lines.append(str(reason))
    crit = latest.criteria or []
    blocking = [c for c in crit if c.get("blocking") and c.get("status") != rc.MET]
    if blocking:
        lines.append("Blocking criteria not met:")
        lines += [
            f"- {c['text']}: {_status_text(str(c['status']))}. {c.get('detail') or ''}".rstrip() for c in blocking
        ]
    counts = rc.counts(crit)
    lines.append(
        f"Criteria: {counts['met']} met, {counts['not_met']} not met, {counts['not_evaluable']} not evaluable"
        f" ({_plural(len(latest.conditions or []), 'condition')})."
    )
    assessed = rsvc._when((latest.scope or {}).get("assessed_at")) or rsvc._aware(latest.created_at)
    lines.append(rc.RELEASE_STATEMENT.format(time=rsvc.when_text(assessed)))
    a.content = "\n".join(lines)
    return a


# ---------------------------------------------------------------- applying proposals


async def apply(ctx: Any, s: Any, p: Any, pr: Any, after: list[Any]) -> list[dict[str, Any]]:
    """`request_regression_run`: a run in `awaiting_authorisation` (Gate 7 still decides). `start_exploration`: an
    anonymous session is queued, a signed-in one waits for its approval (the assistant never approves).
    `assess_release`: an assessment is started; Gate 9 still decides."""
    from app.api.errors import Conflict, GateBlocked
    from app.api.routers import p2common as c
    from app.domain.enums import QualityScanStatus
    from app.orchestrator.orchestrator import Orchestrator

    payload = pr.payload or {}
    project = await c.project_of(s, pr.project_id)
    if pr.kind == "request_regression_run":
        from app.services import assistant_p4 as p4
        from app.services import impact as impact_svc

        cs = await c.load(s, ChangeSet, uuid.UUID(payload["change_set_id"]), "Change set")
        try:
            run = await impact_svc.request_run(ctx, s, project, cs, p.user,
                                               include_should=bool(payload.get("include_should", True)))  # fmt: skip
        except Conflict as exc:
            raise GateBlocked(exc.message) from None
        return [p4.run_ref(pr.project_id, run)]
    if pr.kind == "start_exploration":
        from app.services import exploratory as esvc

        cs_id = payload.get("change_set_id")
        try:
            scan, _approval = await esvc.create_session(
                ctx,
                s,
                project,
                p.user,
                charter=str(payload.get("charter") or "all"),
                page_ids=None,
                change_set_id=uuid.UUID(cs_id) if cs_id else None,
                budget=None,
                signed_in=bool(payload.get("signed_in")),
            )
        except Conflict as exc:  # one session at a time, or a request waiting for approval: say why
            raise GateBlocked(exc.message) from None
        if scan.status == QualityScanStatus.queued:

            async def _enqueue() -> None:
                await esvc.enqueue(ctx, scan)
                await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)

            after.append(_enqueue)
        return [session_ref(pr.project_id, scan)]
    try:
        await Orchestrator(ctx).request_run(
            p.scope, project.id, StageKey.release_readiness, parameters=None, reason=None
        )
    except Conflict as exc:
        raise GateBlocked(exc.message) from None
    return [{"type": "stage", "id": None, "key": "release_readiness", "label": "Release readiness", "path": None}]


# ---------------------------------------------------------------- citation guard


async def resolve(s: Any, project_id: uuid.UUID, keys: set[str]) -> dict[str, dict[str, Any]]:
    """Citation guard: CHG- change sets, HEAL- repair suggestions, EXP- exploratory sessions and REL- assessments of
    this project (tenant-scoped session, filtered by project)."""
    found: dict[str, dict[str, Any]] = {}
    want = {pre: {k for k in keys if k.startswith(f"{pre}-")} for pre in P6_PREFIXES}
    if want["CHG"]:
        q = select(ChangeSet).where(ChangeSet.project_id == project_id, ChangeSet.key.in_(want["CHG"]))
        for cs in (await s.execute(q)).scalars():
            found[cs.key] = set_ref(project_id, cs)
    if want["HEAL"]:
        q2 = select(HealSuggestion).where(HealSuggestion.project_id == project_id, HealSuggestion.key.in_(want["HEAL"]))
        for h in (await s.execute(q2)).scalars():
            found[h.key] = heal_ref(project_id, h)
    sessions = {k for k in want["EXP"] if k.count("-") == 1}
    findings = want["EXP"] - sessions
    if sessions:
        q3 = select(QualityScan).where(
            QualityScan.project_id == project_id,
            QualityScan.kind == QualityScanKind.exploratory,
            QualityScan.key.in_(sessions),
        )
        for sc in (await s.execute(q3)).scalars():
            found[sc.key] = session_ref(project_id, sc)
    if findings:
        from app.db.models import QualityFinding

        q5 = select(QualityFinding).where(QualityFinding.project_id == project_id, QualityFinding.key.in_(findings))
        for f in (await s.execute(q5)).scalars():
            ref = _ref(project_id, "quality_finding", f.id, f.key, f.title[:80])
            found[f.key] = {**ref, "path": f"/projects/{project_id}/execution/exploratory/{f.key.rsplit('-', 1)[0]}"}
    if want["REL"]:
        q4 = select(ReleaseAssessment).where(
            ReleaseAssessment.project_id == project_id, ReleaseAssessment.key.in_(want["REL"])
        )
        for r in (await s.execute(q4)).scalars():
            found[r.key] = assessment_ref(project_id, r)
    return found
