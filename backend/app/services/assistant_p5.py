"""AI QA Analyst v4 (P5-07): non-functional intents, grounded in stored checks and load tests only.

Deterministic, AI off: `performance_summary` (latest judged load test), `accessibility_summary`, `security_summary`
(always ends with the fixed security statement), `explain_finding`. Proposals: `propose_scan` starts an accessibility
or security check when accepted (members, no approval, D19); `propose_performance_run` creates a load test **request**
waiting for its approval: the assistant never approves load tests or starts load.
"""

from __future__ import annotations

import uuid
from collections import Counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.db.models import PerformanceProfile, PerformanceRun, QualityFinding, QualityScan, User
from app.domain.enums import FindingStatus, PerfProfileStatus, QualityScanKind
from app.domain.nonfunctional import accessibility as a11y
from app.domain.performance import profile as rules
from app.security import passive_rules as sec
from app.services import nf_evidence as nfe
from app.services import serialize_p2 as out

if TYPE_CHECKING:
    from app.services.assistant import Answer, Turn

NO_RUN = "No load test has run in this project yet."
VIEWERS = "Only members, owners and admins can apply proposals."
KIND_TEXT = {"accessibility": "accessibility", "security": "security"}
SEVERITY_ORDER = ("critical", "serious", "high", "moderate", "medium", "minor", "low", "info")
STATUS_TEXT = {
    "open": "open",
    "accepted_risk": "accepted as a risk",
    "false_positive": "marked a false positive",
    "fixed": "marked fixed",
}
NF_PREFIXES = ("A11Y", "SEC", "PERF", "PRF")


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


def scan_ref(project_id: uuid.UUID, sc: QualityScan) -> dict[str, Any]:
    what = "Accessibility check" if sc.kind == QualityScanKind.accessibility else "Security check"
    return _ref(project_id, "quality_scan", sc.id, sc.key, what)


def finding_ref(project_id: uuid.UUID, f: QualityFinding) -> dict[str, Any]:
    return _ref(project_id, "quality_finding", f.id, f.key, f.title[:80])


def run_ref(project_id: uuid.UUID, run: PerformanceRun) -> dict[str, Any]:
    return _ref(project_id, "performance_run", run.id, run.key, f"Load test {run.key}")


def profile_ref(project_id: uuid.UUID, p: PerformanceProfile) -> dict[str, Any]:
    return _ref(project_id, "performance_profile", p.id, p.key, p.name[:80])


def duration_text(seconds: int) -> str:
    m, sec_ = divmod(int(seconds), 60)
    return " ".join(x for x in (f"{m} min" if m else "", f"{sec_} s" if sec_ or not m else "") if x)


async def _name(t: Turn, user_id: uuid.UUID | None) -> str:
    u = await t.s.get(User, user_id) if user_id else None
    return (u.full_name or "a project member") if u else "a project member"


# ---------------------------------------------------------------- summaries


async def performance_summary(t: Turn, _p: dict[str, Any]) -> Answer:
    from app.agents.reporting.phase5_reports import paragraph
    from app.services import performance as psvc

    a = _a("", "performance_summary")
    st = await nfe.load(t.s, t.project_id)
    run = st.run
    if run is None:
        a.content = NO_RUN
        a.follow_ups.append(_follow("propose_performance_run"))
        return a
    snap = run.profile_snapshot or {}
    vus = rules.numbers(snap)[0]
    d = {
        "status": run.status.value,
        "limits": {"test": {"vus": vus}},
        "threshold_results": run.threshold_results or [],
        "profile_snapshot": snap,
        "aborted_reason": run.aborted_reason,
    }
    key = a.cite(run_ref(t.project_id, run))
    lines = [f"{key} ({run.status.value}): {paragraph(d)}"]
    for th in run.threshold_results or []:
        if th.get("scope") != "path" or th.get("result") not in ("met", "missed"):
            continue
        mark = "✗ Missed" if th["result"] == "missed" else "✓ Met"
        lines.append(
            f"- {key}: {th.get('path')} p{str(th.get('metric'))[1:]} {rules.ms_text(th.get('measured'))}, "
            f"threshold {rules.ms_text(th.get('value'))} ({mark})"
        )
    prof = await t.s.get(PerformanceProfile, run.profile_id)
    if prof is not None:
        lines.append(f"Profile: {a.cite(profile_ref(t.project_id, prof))}.")
    ap = await psvc._approval(t.s, run)
    if ap is not None and ap.decided_by:
        a.cite({"type": "approval", "id": str(ap.id), "key": ap.key, "label": ap.key, "path": None})
        lines.append(f"Approved by {await _name(t, ap.decided_by)} ({ap.key}).")
    lines.append(psvc.LOCATION)
    a.content = "\n".join(lines)
    return a


def _counts(findings: list[QualityFinding]) -> str:
    c = Counter(f.severity.value for f in findings)
    return ", ".join(f"{c[sv]} {sv}" for sv in SEVERITY_ORDER if c.get(sv))


def _finding_line(a: Answer, project_id: uuid.UUID, f: QualityFinding) -> str:
    return (
        f"- {a.cite(finding_ref(project_id, f))} ({f.severity.value.capitalize()}): {f.title} on {a11y.path_of(f.url)}"
    )


async def accessibility_summary(t: Turn, _p: dict[str, Any]) -> Answer:
    a = _a("", "accessibility_summary")
    st = await nfe.load(t.s, t.project_id)
    sc = st.a11y_scan
    if sc is None:
        a.content = f"No accessibility check has run in this project yet.\n{a11y.STATEMENT}"
        a.follow_ups.append(_follow("propose_scan", kind="accessibility"))
        return a
    key = a.cite(scan_ref(t.project_id, sc))
    pages = len((sc.config or {}).get("pages") or [])
    opened = sorted(st.open_a11y(), key=lambda f: (SEVERITY_ORDER.index(f.severity.value), f.key))
    if not opened:
        lines = [f"{key} checked {_plural(pages, 'page')}: no open accessibility findings."]
    else:
        lines = [f"{key} checked {_plural(pages, 'page')}: {_plural(len(opened), 'open finding')} ({_counts(opened)})."]
        lines += [_finding_line(a, t.project_id, f) for f in opened[:8]]
        if len(opened) > 8:
            lines.append(f"…and {len(opened) - 8} more on the check page.")
    review = [f for f in st.a11y if not nfe.counted(f)]
    if review:
        lines.append(f"{_plural(len(review), 'more result')} need a person to review (keyboard or needs review).")
    lines.append(a11y.STATEMENT)
    a.content = "\n".join(lines)
    return a


async def security_summary(t: Turn, _p: dict[str, Any]) -> Answer:
    a = _a("", "security_summary")
    st = await nfe.load(t.s, t.project_id)
    sc = st.sec_scan
    if sc is None:
        a.content = f"No security check has run in this project yet.\n{sec.STATEMENT}"
        a.follow_ups.append(_follow("propose_scan", kind="security"))
        return a
    key = a.cite(scan_ref(t.project_id, sc))
    counts = (sc.summary or {}).get("counts") or {}
    pages = len((sc.config or {}).get("pages") or [])
    lines = [
        f"{key} looked at {_plural(pages, 'page')}: {counts.get('failed', 0)} failed · {counts.get('passed', 0)} passed "
        f"· {counts.get('not_applicable', 0)} not applicable."
    ]
    opened = sorted(st.open_sec(), key=lambda f: (SEVERITY_ORDER.index(f.severity.value), f.key))
    if opened:
        lines.append(f"{_plural(len(opened), 'open finding')} ({_counts(opened)}):")
        lines += [_finding_line(a, t.project_id, f) for f in opened[:8]]
        if len(opened) > 8:
            lines.append(f"…and {len(opened) - 8} more on the check page.")
    else:
        lines.append("No passive check failed on the pages checked.")
    lines.append(sec.STATEMENT)
    a.content = "\n".join(lines)
    return a


async def _finding(t: Turn, key: str) -> QualityFinding | None:
    q = select(QualityFinding).where(QualityFinding.project_id == t.project_id, QualityFinding.key == key)
    return (await t.s.execute(q)).scalar_one_or_none()


async def explain_finding(t: Turn, p: dict[str, Any]) -> Answer:
    key = str(p.get("key") or "").upper()
    a = _a("", "explain_finding")
    f = await _finding(t, key) if key else None
    if f is None:
        a.content = (
            "Give a finding key, for example A11Y-0001-01 or SEC-0001-01."
            if not key
            else (f"I can't find {key} in this project.")
        )
        return a
    d = (f.mapped or {}).get("details") or {}
    fk = a.cite(finding_ref(t.project_id, f))
    lines = [f"{fk} ({f.severity.value.capitalize()}): {f.title} on {a11y.path_of(f.url)}."]
    if d.get("observed"):
        lines.append(f"Observed: {d['observed']}")
    if d.get("description"):
        lines.append(f"What: {d['description']}")
    if d.get("why"):
        lines.append(f"Why it matters: {d['why']}")
    fix = d.get("fix") or d.get("how_to_fix")
    if fix:
        lines.append(f"How to fix: {fix}")
    wcag = [
        f"{r.get('criterion')} {r.get('name') or ''}".strip()
        for r in f.references or []
        if isinstance(r, dict) and r.get("type") == "wcag"
    ]
    if wcag:
        lines.append(f"WCAG: {', '.join(wcag)}")
    status = STATUS_TEXT.get(f.status.value, f.status.value)
    if f.status != FindingStatus.open:
        who = await _name(t, f.status_by)
        lines.append(f"Status: {status} by {who}" + (f" ('{f.status_reason}')" if f.status_reason else "") + ".")
    else:
        lines.append("Status: open.")
    if d.get("heuristic") or d.get("needs_review"):
        lines.append("This result needs a person to confirm it; it isn't counted in summaries or readiness.")
    reqs = nfe.req_keys(f)
    if reqs:
        lines.append(f"Mapped requirements: {', '.join(reqs)}.")
    if f.defect_id:
        from app.db.models import Defect

        dft = await t.s.get(Defect, f.defect_id)
        if dft is not None:
            lines.append(f"Defect: {dft.key} ({dft.status.value}).")
    lines.append(a11y.STATEMENT if f.kind == QualityScanKind.accessibility else sec.STATEMENT)
    a.content = "\n".join(lines)
    return a


# ---------------------------------------------------------------- proposals


async def propose_scan(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services import quality as qsvc

    kind = "security" if str(p.get("kind") or "").lower().startswith("sec") else "accessibility"
    a = _a("", "propose_scan")
    _disc, pages = await qsvc.discovered_pages(t.s, t.project_id)
    chosen = [pg for pg in pages if not pg.requires_auth]
    if not chosen:
        a.content = "Discovery has no pages to check yet."
        return a
    if not t.can_edit:
        a.content = VIEWERS
        return a
    if kind == "accessibility":
        summary = f"Check accessibility on {_plural(len(chosen), 'page')} (desktop)."
    else:
        summary = f"Run a passive security check on {_plural(len(chosen), 'page')}."
    a.content = summary + (
        " Accepting starts the check now; it needs no approval."
        if kind == "accessibility"
        else (f" Accepting starts the check now; it needs no approval.\n{sec.STATEMENT}")
    )
    a.proposals.append(
        {
            "kind": "start_check",
            "target": None,
            "target_type": "quality_scan",
            "target_id": None,
            "target_lineage_id": None,
            "summary": summary[:300],
            "payload": {"scan_kind": kind, "viewports": ["desktop"], "pages": len(chosen)},
            "preview": [{"path": a11y.path_of(pg.final_url or pg.url)} for pg in chosen[:50]],
            "base_versions": {},
        }
    )
    return a


async def _profile_for(t: Turn, key: str | None) -> PerformanceProfile | None:
    q = select(PerformanceProfile).where(PerformanceProfile.project_id == t.project_id)
    if key:
        q = q.where(PerformanceProfile.key == key.upper())
    else:
        q = q.where(PerformanceProfile.status == PerfProfileStatus.ready)
    return (await t.s.execute(q.order_by(PerformanceProfile.created_at.desc()).limit(1))).scalars().first()


async def propose_performance_run(t: Turn, p: dict[str, Any]) -> Answer:
    from app.services import approvals as apr

    a = _a("", "propose_performance_run")
    prof = await _profile_for(t, p.get("profile"))
    if prof is None:
        a.content = (
            f"I can't find {str(p['profile']).upper()} in this project." if p.get("profile") else
            "No load test profile is ready. Draft one on the Performance tab and mark it ready first."
        )  # fmt: skip
        return a
    pk = a.cite(profile_ref(t.project_id, prof))
    if prof.status != PerfProfileStatus.ready:
        a.content = f"{pk} isn't ready. Mark it ready on the Performance tab first."
        return a
    if not t.can_edit:
        a.content = VIEWERS
        return a
    from app.services import performance as psvc

    snap = psvc.snapshot(prof)
    vus, rps, seconds, _n = rules.numbers(snap)
    origin, _host = await apr.target(t.s, t.project_id)
    summary = (
        f"Run a load test with {pk}: up to {_plural(vus, 'virtual user')}, at most {rps} requests a second, "
        f"{duration_text(seconds)}, against {origin.split('://', 1)[1]}."
    )
    a.content = (
        f"{summary}\nCreates a load test request. Someone who can approve must still type the host and approve it; "
        "the assistant can't approve load tests or start load."
    )
    a.proposals.append(
        {
            "kind": "request_load_test",
            "target": profile_ref(t.project_id, prof),
            "target_type": "performance_profile",
            "target_id": prof.id,
            "target_lineage_id": None,
            "summary": summary[:300],
            "payload": {"profile_id": str(prof.id), "profile_key": prof.key},
            "preview": [{"profile_key": prof.key, "vus": vus, "max_rps": rps, "duration_s": seconds}],
            "base_versions": {str(prof.id): prof.version},
        }
    )
    return a


async def apply(ctx: Any, s: Any, p: Any, pr: Any, after: list[Any]) -> list[dict[str, Any]]:
    """Accepting `start_check` queues the check (enqueued once committed); accepting `request_load_test` creates a
    load test in `awaiting_approval` and never approves or starts it."""
    from app.api.errors import Conflict, GateBlocked
    from app.api.routers import p2common as c
    from app.services import performance as psvc
    from app.services import quality as qsvc

    payload = pr.payload or {}
    project = await c.project_of(s, pr.project_id)
    if pr.kind == "start_check":
        kind = QualityScanKind(payload.get("scan_kind") or "accessibility")
        try:
            scan = await qsvc.create_scan(
                ctx,
                s,
                project,
                p.user,
                kind,
                page_ids=None,
                viewports=["desktop"],
                keyboard=kind == QualityScanKind.accessibility,
                signed_in=False,
            )
        except Conflict as exc:  # e.g. a check of this kind is already running: say why, don't mark it stale
            raise GateBlocked(exc.message) from None

        async def _enqueue() -> None:
            from app.orchestrator.orchestrator import Orchestrator

            await qsvc.enqueue(ctx, scan)
            await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)

        after.append(_enqueue)
        return [scan_ref(pr.project_id, scan)]
    prof = await c.load(s, PerformanceProfile, uuid.UUID(payload["profile_id"]), "Profile")
    c.check_version(prof, int((pr.base_versions or {}).get(str(prof.id), -1)))
    try:
        run, _approval = await psvc.request_run(ctx, s, project, p.user, prof, note=f"Requested from {pr.key}")
    except Conflict as exc:
        raise GateBlocked(exc.message) from None
    return [run_ref(pr.project_id, run)]


async def resolve(s: Any, project_id: uuid.UUID, keys: set[str]) -> dict[str, dict[str, Any]]:
    """Citation guard: A11Y-/SEC- checks and findings, PERF- load tests and PRF- profiles of this project."""
    found: dict[str, dict[str, Any]] = {}
    scans = {k for k in keys if k.split("-", 1)[0] in ("A11Y", "SEC") and k.count("-") == 1}
    findings = {k for k in keys if k.split("-", 1)[0] in ("A11Y", "SEC") and k.count("-") == 2}
    runs = {k for k in keys if k.startswith("PERF-")}
    profiles = {k for k in keys if k.startswith("PRF-")}
    if scans:
        q = select(QualityScan).where(QualityScan.project_id == project_id, QualityScan.key.in_(scans))
        for sc in (await s.execute(q)).scalars():
            found[sc.key] = scan_ref(project_id, sc)
    if findings:
        q2 = select(QualityFinding).where(QualityFinding.project_id == project_id, QualityFinding.key.in_(findings))
        for f in (await s.execute(q2)).scalars():
            found[f.key] = finding_ref(project_id, f)
    if runs:
        q3 = select(PerformanceRun).where(PerformanceRun.project_id == project_id, PerformanceRun.key.in_(runs))
        for r in (await s.execute(q3)).scalars():
            found[r.key] = run_ref(project_id, r)
    if profiles:
        q4 = select(PerformanceProfile).where(
            PerformanceProfile.project_id == project_id, PerformanceProfile.key.in_(profiles)
        )
        for pf in (await s.execute(q4)).scalars():
            found[pf.key] = profile_ref(project_id, pf)
    return found
