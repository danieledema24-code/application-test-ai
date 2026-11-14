"""Automation services (P4-02, P4-03a, P4-04): inputs from the G5 snapshot and discovery, bundle validation, G6.

Input is the G5-approved snapshot: the cases frozen in the last G5 approval at their approved versions (content
from their revisions when the row moved on), their test data items and the discovered form/page model. While G5
is reopened, the last approval stays the input.

G6 follows decision D10: static validation always blocks a script; a bundle whose runnable scripts were all
written by rules and pass their checks completes by itself ("Passed automatically"); AI-written scripts need a
`can_approve` review each.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.phase2 import load_discovery
from app.agents.requirements.rules import _form_name, _label, _path, normalise
from app.context import AppContext
from app.db.models import (
    AutomationAssessment,
    AutomationAsset,
    AutomationScript,
    EntityRevision,
    GateDecision,
    Project,
    StageRun,
    TestCase,
    TestData,
    WorkflowStage,
)
from app.domain.automation import steps as sm
from app.domain.enums import (
    AssetKind,
    AutomationSuitability,
    ExpectedResultStatus,
    GateKey,
    GatePolicy,
    GateStatus,
    ScriptGeneratedBy,
    ScriptStatus,
    StageKey,
    StageStatus,
    TestDataKind,
)
from app.domain.stages import merged_policy
from app.services import gates as gate_rules
from app.services import testdesign as tds

log = logging.getLogger(__name__)

# Files `automation/` ships into every bundle (trusted platform code, never generated or guarded).
PLATFORM_FILES: dict[str, AssetKind] = {
    "fixtures.ts": AssetKind.platform,
    "qa.ts": AssetKind.platform,
    "policy.ts": AssetKind.platform,
    "playwright.config.ts": AssetKind.config,
    "tsconfig.json": AssetKind.config,
    "eslint.config.js": AssetKind.config,
}
CHECKS = ("guard", "tsc", "eslint", "secret_scan", "tags", "locators")
STATIC_CHECKS = ("guard", "tsc", "eslint", "secret_scan", "tags")


# ------------------------------------------------------------------ stage helpers


async def stage(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
    return (
        await s.execute(
            select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
        )
    ).scalar_one()


async def current_run(s: AsyncSession, project_id: uuid.UUID, key: StageKey) -> StageRun | None:
    st = await stage(s, project_id, key)
    if st.current_stage_run_id is None:
        return None
    run = await s.get(StageRun, st.current_stage_run_id)
    return run if run is not None and run.finished_at is not None else None


async def run_by_version(s: AsyncSession, project_id: uuid.UUID, key: StageKey, version: int) -> StageRun | None:
    st = await stage(s, project_id, key)
    return (
        await s.execute(select(StageRun).where(StageRun.workflow_stage_id == st.id, StageRun.version == version))
    ).scalar_one_or_none()


# ------------------------------------------------------------------ inputs


@dataclass
class ApprovedCase:
    row: TestCase  # the case row frozen in the G5 snapshot
    case: sm.CaseIn
    status: str  # the row's current status (it may have been reopened since)


async def last_g5(s: AsyncSession, project_id: uuid.UUID) -> GateDecision | None:
    return await gate_rules.last_approval(s, project_id, GateKey.G5)


async def approved_cases(s: AsyncSession, project_id: uuid.UUID) -> tuple[GateDecision | None, list[ApprovedCase]]:
    """The cases of the last G5 approval at their approved versions (P3-04 `basis=approved` reader)."""
    decision = await last_g5(s, project_id)
    if decision is None:
        return None, []
    wanted = {uuid.UUID(i["id"]): int(i["version"]) for i in tds.snapshot_items(decision, "test_case")}
    if not wanted:
        return decision, []
    rows = list((await s.execute(select(TestCase).where(TestCase.id.in_(wanted)))).scalars())
    revs: dict[uuid.UUID, dict[str, Any]] = {}
    moved = [r for r in rows if r.version != wanted[r.id]]
    if moved:
        for rev in (
            await s.execute(
                select(EntityRevision)
                .where(
                    EntityRevision.entity_type == "test_case",
                    EntityRevision.lineage_id.in_([r.lineage_id for r in moved]),
                )
                .order_by(EntityRevision.version)
            )
        ).scalars():
            row = next(r for r in moved if r.lineage_id == rev.lineage_id)
            if rev.version <= wanted[row.id]:
                revs[row.id] = {**revs.get(row.id, {}), **(rev.snapshot or {})}
    req_keys = await _requirement_keys(s, project_id)
    out: list[ApprovedCase] = []
    for r in sorted(rows, key=lambda x: x.key):
        snap = revs.get(r.id, {})

        def pick(name: str, default: Any, snap: dict[str, Any] = snap) -> Any:
            return snap[name] if name in snap and snap[name] is not None else default

        steps = tuple(
            sm.StepIn(
                n=int(st.get("n") or i),
                action=str(st.get("action") or ""),
                data_refs=tuple(str(x) for x in st.get("data_refs") or []),
                expected=str(st.get("expected") or ""),
            )
            for i, st in enumerate(pick("steps", r.steps) or [], start=1)
        )
        status = str(pick("expected_result_status", r.expected_result_status.value))
        out.append(
            ApprovedCase(
                row=r,
                status=r.status.value,
                case=sm.CaseIn(
                    lineage_id=str(r.lineage_id),
                    key=r.key,
                    title=str(pick("title", r.title)),
                    version=wanted[r.id],
                    steps=steps,
                    expected_result=str(pick("expected_result", r.expected_result)),
                    open_question=status == ExpectedResultStatus.open_question.value,
                    suites=tuple(sorted(str(x) for x in pick("suites", r.suites) or [])),
                    requirement_keys=tuple(
                        sorted({req_keys[str(x)] for x in r.requirement_lineage_ids or [] if str(x) in req_keys})
                    ),
                ),
            )
        )
    return decision, out


async def _requirement_keys(s: AsyncSession, project_id: uuid.UUID) -> dict[str, str]:
    _run, reqs = await gate_rules.current_requirements(s, project_id)
    return {str(r.lineage_id): r.key for r in reqs}


async def site_model(s: AsyncSession, project_id: uuid.UUID, case_rows: list[TestCase]) -> sm.SiteModel:
    """The discovered forms and pages (same anchors as the test design) plus the cases' test data items."""
    from app.services.secrets import credentials_secret

    forms: list[sm.FormInfo] = []
    pages: dict[str, sm.PageInfo] = {}
    captcha = mfa = False
    loaded = await load_discovery(s, project_id, include_documents=False)
    if loaded is not None:
        data, _drun, scan = loaded
        auth = scan.auth or {}
        captcha = auth.get("reason_code") == "captcha"
        mfa = auth.get("reason_code") == "mfa_required"
        seen: set[str] = set()
        for page in data.pages:
            if getattr(page.status, "value", page.status) != "visited":
                continue
            path = _path(page.url).split("?")[0]
            links: list[tuple[str, str]] = []
            buttons: list[str] = []
            for comp in page.components or []:
                if comp.get("kind") == "button" and comp.get("name"):
                    buttons.append(str(comp["name"]))
                if comp.get("kind") == "link" and comp.get("name"):
                    href = str((comp.get("details") or {}).get("href") or "")
                    if href:
                        links.append((str(comp["name"]), _path(href).split("?")[0]))
            known = {h for _t, h in links}
            for href in page.links or []:
                p = _path(str(href)).split("?")[0]
                if p not in known:
                    links.append(("", p))
                    known.add(p)
            nav = tuple(
                (str(n.get("text") or ""), _path(str(n.get("href") or "")).split("?")[0])
                for n in page.nav_links or []
                if n.get("text")
            )
            for idx, form in enumerate(page.forms or []):
                if form.get("submit_label"):
                    buttons.append(str(form["submit_label"]))
                purpose = form.get("purpose_guess", "other")
                if purpose in ("search", "filter"):
                    continue
                anchor = f"form:{path}:{normalise(str(form.get('name') or form.get('submit_label') or idx))}"
                if anchor in seen:
                    continue
                seen.add(anchor)
                fields = tuple(
                    sm.FieldInfo(
                        key=f"{anchor}:{normalise(str(fld.get('name') or _label(fld)))}",
                        label=_label(fld),
                        name=str(fld.get("name") or ""),
                        type=str(fld.get("type") or "text"),
                        required=bool(fld.get("required")),
                        locator=str(fld.get("locator") or ""),
                    )
                    for fld in form.get("fields") or []
                    if fld.get("type") not in ("hidden", "submit", "button")
                )
                alias = _form_name(form)
                display = str(form.get("name") or "").strip() or alias[:1].upper() + alias[1:]
                forms.append(
                    sm.FormInfo(
                        anchor=anchor,
                        name=display,
                        purpose=str(purpose),
                        path=path,
                        submit_label=str(form.get("submit_label") or "Submit"),
                        fields=fields,
                        locator=str(form.get("locator") or ""),
                        requires_auth=bool(page.requires_auth),
                        alias=alias,
                    )
                )
            if path not in pages:
                pages[path] = sm.PageInfo(
                    path=path,
                    title=str(page.title or ""),
                    requires_auth=bool(page.requires_auth),
                    buttons=tuple(dict.fromkeys(buttons)),
                    links=tuple(links),
                    nav=nav,
                )
    data_items: dict[str, sm.DataInfo] = {}
    lineages = {str(x) for r in case_rows for st in r.steps or [] for x in st.get("data_refs") or []}
    run_ids = {r.stage_run_id for r in case_rows}
    if lineages and run_ids:
        rows = (
            await s.execute(
                select(TestData).where(
                    TestData.stage_run_id.in_(run_ids),
                    TestData.lineage_id.in_([uuid.UUID(x) for x in lineages]),
                )
            )
        ).scalars()
        for d in rows:
            ref = d.form_ref or {}
            secret = None
            if d.kind == TestDataKind.secret_ref:
                secret = "password" if "password" in d.name.lower() else "username"
            data_items[str(d.lineage_id)] = sm.DataInfo(
                lineage_id=str(d.lineage_id),
                key=d.key,
                field_label=d.field_label,
                field_key=str(ref.get("field_key") or ""),
                form_anchor=str(ref.get("form_anchor") or ""),
                kind=d.kind.value,
                value=None if d.kind == TestDataKind.secret_ref else (d.value or ""),
                secret=secret,
                altered="altered" in d.name.lower(),
                display=d.name.split(" · ", 1)[-1],
            )
    login = next((f for f in forms if f.purpose == "login"), None)
    return sm.SiteModel(
        forms=forms,
        pages=pages,
        data=data_items,
        credentials_saved=await credentials_secret(s, project_id) is not None,
        login_path=login.path if login else None,
        captcha_login=captcha,
        mfa_login=mfa,
    )


# ------------------------------------------------------------------ derived case fields


async def write_case_fields(s: AsyncSession, project_id: uuid.UUID, lineage: uuid.UUID, a: sm.Assessment) -> None:
    """Derived fields (no version bump, no revision, no G5 reopen; the P3-05 priority rule)."""
    run = await tds.current_run(s, project_id)
    rows = list(
        (
            await s.execute(select(TestCase).where(TestCase.project_id == project_id, TestCase.lineage_id == lineage))
        ).scalars()
    )
    for row in rows:
        if run is not None and row.stage_run_id != run.id and len(rows) > 1:
            continue
        row.automation_suitability = AutomationSuitability(a.suitability)
        row.automation_reason = "; ".join(a.reasons)[:2000]
        row.automation_assessed = "assessed"


async def refresh_credentials(s: AsyncSession, project_id: uuid.UUID, saved: bool) -> int:
    """Credentials saved or removed: partial ↔ suitable on the current assessment without a new G5 approval."""
    run = await current_run(s, project_id, StageKey.automation_assessment)
    if run is None:
        return 0
    changed = 0
    for row in (
        await s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == run.id))
    ).scalars():
        before = sm.Assessment(row.suitability.value, list(row.reasons or []), list(row.blockers or []), row.step_model)
        after = sm.with_credentials(before, saved)
        if after.suitability == before.suitability:
            continue
        row.suitability = AutomationSuitability(after.suitability)
        row.reasons = after.reasons
        row.blockers = after.blockers
        await write_case_fields(s, project_id, row.case_lineage_id, after)
        changed += 1
    return changed


# ------------------------------------------------------------------ bundle reads


async def bundle_rows(s: AsyncSession, run_id: uuid.UUID) -> tuple[list[AutomationScript], list[AutomationAsset]]:
    scripts = list(
        (
            await s.execute(
                select(AutomationScript).where(AutomationScript.stage_run_id == run_id).order_by(AutomationScript.path)
            )
        ).scalars()
    )
    assets = list(
        (
            await s.execute(
                select(AutomationAsset).where(AutomationAsset.stage_run_id == run_id).order_by(AutomationAsset.path)
            )
        ).scalars()
    )
    return scripts, assets


def platform_sources(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in PLATFORM_FILES:
        p = root / "platform" / name
        if p.is_file():
            out[name] = p.read_text(encoding="utf-8")
    return out


def runnable(script: AutomationScript) -> bool:
    """Valid, and (AI-written) approved in review. Invalid, outdated and unreviewed scripts never run."""
    if script.status != ScriptStatus.valid:
        return False
    if script.generated_by == ScriptGeneratedBy.ai:
        return (script.review or {}).get("decision") == "approve"
    return True


async def rules_fallback(s: AsyncSession, script: AutomationScript) -> AutomationScript | None:
    """Open question 6: the rules script an AI-written script falls back to when it is rejected in review: the latest
    valid rules-written script of the same case at the same case version (a bundle holds one script per case, so it
    comes from an earlier bundle)."""
    return (
        await s.execute(
            select(AutomationScript)
            .where(
                AutomationScript.project_id == script.project_id,
                AutomationScript.case_lineage_id == script.case_lineage_id,
                AutomationScript.case_version == script.case_version,
                AutomationScript.generated_by == ScriptGeneratedBy.rules,
                AutomationScript.status == ScriptStatus.valid,
                AutomationScript.id != script.id,
            )
            .order_by(AutomationScript.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


def script_state(script: AutomationScript) -> str:
    """valid | invalid | not_checked | outdated | needs_review | rejected (design P4 §3 script status)."""
    if script.status == ScriptStatus.outdated:
        return "outdated"
    if script.generated_by == ScriptGeneratedBy.ai:
        decision = (script.review or {}).get("decision")
        if decision == "reject":
            return "rejected"
        if script.status == ScriptStatus.valid and decision != "approve":
            return "needs_review"
    if script.status == ScriptStatus.valid:
        return "valid"
    if script.status == ScriptStatus.invalid:
        return "invalid"
    return "not_checked"


# ------------------------------------------------------------------ G6 (decision D10)


async def g6_preconditions(s: AsyncSession, project: Project) -> list[gate_rules.Precondition]:
    run = await current_run(s, project.id, StageKey.automation)
    base = f"/projects/{project.id}/automation"
    if run is None:
        return [gate_rules.Precondition("bundle", False, True, "Scripts haven't been written yet", base)]
    scripts, _assets = await bundle_rows(s, run.id)
    live = [x for x in scripts if x.status != ScriptStatus.outdated]
    valid = [x for x in live if runnable(x)]
    unreviewed = [x for x in live if script_state(x) == "needs_review"]
    invalid = [x for x in live if x.status == ScriptStatus.invalid]
    unchecked = [x for x in live if x.status == ScriptStatus.draft]
    outdated = [x for x in scripts if x.status == ScriptStatus.outdated]
    not_checked = [
        x for x in live if x.status == ScriptStatus.valid and any(
            "not checked" in str(m.get("message", "")).lower()
            for m in ((x.validation or {}).get("locators") or {}).get("messages", [])
        )
    ]  # fmt: skip
    keys = await _case_keys(s, [x.test_case_id for x in scripts])
    out = [
        gate_rules.Precondition(
            "valid_scripts",
            bool(valid),
            True,
            f"{len(valid)} script{'s' if len(valid) != 1 else ''} can run" if valid else "No script can run yet",
            f"{base}?view=scripts",
        ),
        gate_rules.Precondition(
            "ai_reviewed",
            not unreviewed,
            True,
            "Every script written by AI has been reviewed"
            if not unreviewed
            else f"{len(unreviewed)} script{'s' if len(unreviewed) != 1 else ''} written by AI need"
            f"{'s' if len(unreviewed) == 1 else ''} review: {', '.join(keys.get(x.test_case_id, '?') for x in unreviewed)}",
            f"{base}?view=review",
        ),
        gate_rules.Precondition(
            "no_invalid",
            not invalid,
            False,
            "Every script passed its checks"
            if not invalid
            else f"{len(invalid)} script{'s' if len(invalid) != 1 else ''} can't run and "
            f"{'is' if len(invalid) == 1 else 'are'} left out of runs: {', '.join(keys.get(x.test_case_id, '?') for x in invalid)}",
            f"{base}?view=scripts",
        ),
        gate_rules.Precondition(
            "checked",
            not unchecked,
            False,
            "Every script has been checked"
            if not unchecked
            else f"{len(unchecked)} script{'s' if len(unchecked) != 1 else ''} not checked yet",
            f"{base}?view=scripts",
        ),
        gate_rules.Precondition(
            "locators_checked",
            not not_checked,
            False,
            "Every script was checked on the live page"
            if not not_checked
            else f"{len(not_checked)} script{'s' if len(not_checked) != 1 else ''} weren't checked on the live page "
            "(needs sign-in, no test credentials saved)",
            f"/projects/{project.id}/settings",
        ),
        gate_rules.Precondition(
            "not_outdated",
            not outdated,
            False,
            "No script is outdated"
            if not outdated
            else f"{len(outdated)} script{'s' if len(outdated) != 1 else ''} "
            f"{'is' if len(outdated) == 1 else 'are'} outdated: the test case changed after it was written",
            base,
        ),
    ]
    return out


async def _case_keys(s: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    return {r.id: r.key for r in (await s.execute(select(TestCase).where(TestCase.id.in_(set(ids))))).scalars()}


async def g6_state(s: AsyncSession, project: Project) -> tuple[StageStatus, GateStatus]:
    """Where the `automation` stage stands after generation or validation (decision D10)."""
    pre = await g6_preconditions(s, project)
    blocked = bool(gate_rules.blockers(pre))
    policy = merged_policy(project.approval_policy)[GateKey.G6]
    if policy == GatePolicy.required:
        return StageStatus.awaiting_approval, GateStatus.pending
    if blocked:
        return StageStatus.awaiting_approval, GateStatus.pending
    return StageStatus.completed, GateStatus.approved


async def apply_g6(s: AsyncSession, project: Project) -> tuple[StageStatus, StageStatus, int | None]:
    """Moves the automation stage to its D10 state; returns (old, new, version)."""
    st = await stage(s, project.id, StageKey.automation)
    run = await current_run(s, project.id, StageKey.automation)
    old = st.status
    if run is None or st.status in (StageStatus.queued, StageStatus.running, StageStatus.stale):
        return old, old, run.version if run else None
    if st.status == StageStatus.approved:
        return old, old, run.version  # a person approved it (policy `required`)
    new, gate = await g6_state(s, project)
    st.status, st.gate_status = new, gate
    run.status = new
    return old, new, run.version


def g6_summary(pre: list[gate_rules.Precondition], st: WorkflowStage, has_ai: bool) -> dict[str, Any]:
    blockers = gate_rules.blockers(pre)
    if (
        st.status in (StageStatus.not_started, StageStatus.queued, StageStatus.running)
        and st.current_stage_run_id is None
    ):
        state = "not_started"
    elif st.status == StageStatus.approved:
        state = "approved"
    elif st.status == StageStatus.completed and st.gate_status == GateStatus.approved and not blockers:
        state = "passed_automatically" if not has_ai else "reviewed"
    elif blockers:
        state = "waiting"
    else:
        state = "waiting" if st.status == StageStatus.awaiting_approval else "not_started"
    return {"state": state, "preconditions": [p.as_dict() for p in pre]}


# ------------------------------------------------------------------ workspace


def workspace(ctx: AppContext, name: str) -> Path:
    root = Path(ctx.settings.automation_dir).resolve() / ".runs" / name
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_bundle(root: Path, files: dict[str, str]) -> None:
    for rel, code in files.items():
        target = (root / rel).resolve()
        if not str(target).startswith(str(root.resolve()) + "/"):
            raise ValueError(f"Invalid bundle path {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(code, encoding="utf-8")


def same_site_path(url: str) -> str:
    return urlsplit(url).path or "/"
