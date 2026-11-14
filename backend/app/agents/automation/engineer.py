"""Test Automation Engineer Agent, rule path (P4-03a): the `automation` stage writes an automation bundle.

A bundle is one `automation` stage run: page objects and test data (`automation_assets`), one spec per `suitable`
or `partial` case (`automation_scripts`) and the platform files from `automation/`. Scripts are keyed by case
lineage: one whose case version and emitted code are unchanged keeps its version, status and checks; a changed one
gets the next version and must pass its checks again (P4-04); scripts of cases that changed or left the G5
snapshot are `outdated` in the bundle they came from and never run. Scripts are read-only (decision D13).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.automation import ai_writer as ai
from app.agents.automation.validation import validate_bundle
from app.agents.phase2 import StageOutcome
from app.context import AppContext
from app.db.models import AutomationAssessment, AutomationAsset, AutomationScript, StageRun
from app.db.tenant import TenantScope, bind_scope
from app.domain.automation import emit as em
from app.domain.automation import steps as sm
from app.domain.enums import (
    AssetKind,
    AutomationSuitability,
    GeneratedBy,
    ScriptGeneratedBy,
    ScriptStatus,
    StageKey,
)
from app.services import automation as svc


class AutomationAgent:
    implemented = True

    def __init__(
        self, ctx: AppContext, scope: TenantScope, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID
    ) -> None:
        self.ctx, self.scope, self.project_id, self.run_id, self.task_id = ctx, scope, project_id, run_id, task_id

    async def run(self) -> StageOutcome:
        s = self.ctx.session_factory()
        bind_scope(s, self.scope)
        async with s:
            run = (await s.execute(select(StageRun).where(StageRun.id == self.run_id))).scalar_one()
            arun = await svc.current_run(s, self.project_id, StageKey.automation_assessment)
            if arun is None:
                raise RuntimeError("Automation suitability hasn't been assessed yet")
            rows = {
                str(a.case_lineage_id): a
                for a in (
                    await s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == arun.id))
                ).scalars()
            }
            _decision, cases = await svc.approved_cases(s, self.project_id)
            site = await svc.site_model(s, self.project_id, [c.row for c in cases])
            chosen = [
                (c.case, rows[c.case.lineage_id].step_model)
                for c in cases
                if c.case.lineage_id in rows
                and rows[c.case.lineage_id].suitability != AutomationSuitability.manual_only
                and rows[c.case.lineage_id].case_version == c.case.version
            ]
            bundle = em.Emitter(site).emit(chosen)
            by_lineage = {c.case.lineage_id: c for c in cases}
            # P4-03b: with AI configured, rewrites of rule scripts and scripts for cases the rules couldn't translate.
            ai_codes: dict[str, tuple[str, str]] = {}  # lineage → (path, code) of accepted AI scripts
            ai_issues: list[dict[str, Any]] = []
            llm_usage: dict[str, Any] | None = None
            if self.ctx.llm.enabled:
                ai_codes, ai_issues, llm_usage = await self._ai(cases, rows, site, bundle)
            prev_id = (run.parameters or {}).get("previous_run_id")
            prev_scripts: dict[str, AutomationScript] = {}
            prev_assets: dict[str, AutomationAsset] = {}
            if prev_id:
                old_scripts, old_assets = await svc.bundle_rows(s, uuid.UUID(str(prev_id)))
                prev_scripts = {str(x.case_lineage_id): x for x in old_scripts}
                prev_assets = {x.path: x for x in old_assets}
            # Idempotent per stage run (QA P4-BUG-04): a retried or re-claimed job updates the rows an earlier attempt
            # of this run wrote (same case lineage / same path) instead of inserting duplicates.
            mine_scripts, mine_assets = await svc.bundle_rows(s, self.run_id)
            own_scripts = {str(x.case_lineage_id): x for x in mine_scripts}
            own_assets = {x.path: x for x in mine_assets}
            kept = new_versions = 0
            emitted: dict[str, tuple[str, str, str, list[dict[str, Any]], ScriptGeneratedBy]] = {
                lineage: (out.path, out.code, out.sha256, out.assertion_map, ScriptGeneratedBy.rules)
                for lineage, out in bundle.scripts.items()
            }
            for lineage, (path, code) in ai_codes.items():
                base = bundle.scripts.get(lineage)
                emitted[lineage] = (path, code, em.sha256(code), base.assertion_map if base else
                                    _marked_map(code), ScriptGeneratedBy.ai)  # fmt: skip
            files = dict(bundle.assets)
            platform = svc.platform_sources(self.ctx.toolkit.root)
            # Rows an earlier attempt wrote that this attempt no longer produces go first, so a path can be reused.
            stale: list[AutomationScript | AutomationAsset] = [x for k, x in own_scripts.items() if k not in emitted]
            stale += [x for p, x in own_assets.items() if p not in files and p not in platform]
            for row in stale:
                await s.delete(row)
            if stale:
                await s.flush()
            for lineage, (path, code, sha, amap, made_by) in emitted.items():
                c = by_lineage[lineage]
                prev = prev_scripts.get(lineage)
                same = (
                    prev is not None
                    and prev.case_version == c.case.version
                    and prev.sha256 == sha
                    and prev.generated_by == made_by
                )
                if same and prev is not None:
                    kept += 1
                    version, status, validation = prev.version, prev.status, dict(prev.validation or {})
                    if status == ScriptStatus.outdated:
                        status, validation = ScriptStatus.draft, {}
                else:
                    new_versions += 1
                    version = (prev.version + 1) if prev is not None else 1
                    status, validation = ScriptStatus.draft, {}
                    if prev is not None and prev.status != ScriptStatus.outdated:
                        prev.status = ScriptStatus.outdated
                _upsert(
                    s,
                    own_scripts.pop(lineage, None),
                    AutomationScript,
                    organisation_id=self.scope.org_id,
                    project_id=self.project_id,
                    stage_run_id=self.run_id,
                    test_case_id=c.row.id,
                    case_lineage_id=c.row.lineage_id,
                    case_version=c.case.version,
                    lineage_id=c.row.lineage_id,
                    version=version,
                    path=path,
                    code=code,
                    sha256=sha,
                    assertion_map=amap,
                    status=status,
                    validation=validation,
                    generated_by=made_by,
                    review=prev.review if same and prev is not None else None,
                )
            for lineage, prev in prev_scripts.items():
                if lineage not in emitted and prev.status != ScriptStatus.outdated:
                    prev.status = ScriptStatus.outdated
            for path, code in sorted({**files, **platform}.items()):
                kind = svc.PLATFORM_FILES.get(path)
                generated = kind is None
                prev_a = prev_assets.get(path)
                sha = em.sha256(code)
                version = (
                    prev_a.version
                    if prev_a is not None and prev_a.sha256 == sha
                    else (prev_a.version + 1 if prev_a else 1)
                )
                _upsert(
                    s,
                    own_assets.pop(path, None),
                    AutomationAsset,
                    organisation_id=self.scope.org_id,
                    project_id=self.project_id,
                    stage_run_id=self.run_id,
                    kind=(AssetKind.factory if path.startswith("data/") else AssetKind.page_object)
                    if generated
                    else kind,
                    path=path,
                    code=code,
                    sha256=sha,
                    version=version,
                    generated_by=ScriptGeneratedBy.rules if generated else ScriptGeneratedBy.platform,
                )

            manual = [
                {
                    "case_lineage_id": c.case.lineage_id,
                    "test_case_id": str(c.row.id),
                    "key": c.case.key,
                    "title": c.case.title,
                    "reason": "; ".join(rows[c.case.lineage_id].reasons or []) if c.case.lineage_id in rows else
                    "Not assessed yet",
                }
                for c in cases
                if c.case.lineage_id not in emitted
            ]  # fmt: skip
            page_objects = sum(1 for p in bundle.assets if p.startswith("pages/"))
            data_files = sum(1 for p in bundle.assets if p.startswith("data/"))
            run.upstream_versions = {**(run.upstream_versions or {}), "automation_assessment": arun.version}
            made = "mixed" if ai_codes else "rules"
            run.output = {
                "counts": {
                    "scripts": len(emitted),
                    "page_objects": page_objects,
                    "data_files": data_files,
                    "not_automated": len(manual),
                    "kept": kept,
                    "new_versions": new_versions,
                },
                "not_automated": manual,
                "locators": bundle.locators,
                "pages": bundle.pages,
                "script_locators": {k: v.locators for k, v in bundle.scripts.items()},
                "generated_by": made,
                "validation": {"status": "running"},
            }
            if self.ctx.llm.enabled:
                run.output["ai"] = {
                    "scripts": sorted(by_lineage[k].case.key for k in ai_codes),
                    "issues": ai_issues,
                    "fallback_used": any(i["code"] in ("ai_fallback", "ai_invalid") for i in ai_issues),
                    "llm_usage": llm_usage,
                }
            await s.commit()
        events: list[tuple[str, str, dict[str, Any]]] = [
            (
                "automation.generated",
                f"Wrote {len(emitted)} script{'s' if len(emitted) != 1 else ''}, {page_objects} page "
                f"object{'s' if page_objects != 1 else ''} and {data_files} data file{'s' if data_files != 1 else ''} "
                + (f"({len(ai_codes)} by AI, the rest by rules)" if ai_codes else "(rules)"),
                {
                    "kind": "result",
                    "bundle_version": run.version,
                    "scripts": len(emitted),
                    "skipped": len(manual),
                },
            )
        ]
        for i in ai_issues:
            events.append(("automation.ai_check", i["message"], {"kind": "warning", "code": i["code"]}))
        output, summary = await validate_bundle(self.ctx, self.scope, self.project_id, self.run_id, only_draft=True)
        events.append(
            ("automation.validated", summary, {"kind": "result", **output.get("validation", {}).get("counts", {})})
        )
        for issue in (output.get("validation") or {}).get("issues", [])[:20]:
            events.append(("validation.issue", issue, {"kind": "warning"}))
        return StageOutcome(
            output=output, generated_by=GeneratedBy.mixed if ai_codes else GeneratedBy.rules, events=events
        )

    async def _ai(
        self,
        cases: list[svc.ApprovedCase],
        rows: dict[str, AutomationAssessment],
        site: sm.SiteModel,
        bundle: em.Bundle,
    ) -> tuple[dict[str, tuple[str, str]], list[dict[str, Any]], dict[str, Any] | None]:
        """Runs the AI writer per case (P4-03b). Returns accepted scripts, validation issues and token usage."""
        check = ai.toolkit_check(self.ctx, dict(bundle.assets))
        accepted: dict[str, tuple[str, str]] = {}
        issues: list[dict[str, Any]] = []
        usage = None
        for c in cases:
            lineage = c.case.lineage_id
            row = rows.get(lineage)
            if row is None or row.case_version != c.case.version:
                continue
            base = bundle.scripts.get(lineage)
            if base is None and not (
                row.suitability == AutomationSuitability.manual_only and ai.eligible_manual(row.blockers)
            ):
                continue
            path = base.path if base is not None else f"tests/ai/{c.case.key}.spec.ts"
            res = await ai.write(
                self.ctx,
                case=c.case,
                path=path,
                baseline=base.code if base is not None else None,
                blockers=None if base is not None else list(row.blockers or []),
                blocks=ai.site_blocks(site, base.pages if base is not None else None),
                check=check,
            )
            usage = ai._add(usage, res.usage)
            if res.issue is not None:
                issues.append(res.issue)
            if res.code is not None and (base is None or res.code != base.code):
                accepted[lineage] = (path, res.code)
        out = usage.as_dict() if usage else {"provider": self.ctx.llm.provider, "model": self.ctx.llm.model}
        return (
            accepted,
            issues,
            {**out, "fallback_used": any(i["code"] in ("ai_fallback", "ai_invalid") for i in issues)},
        )


def _marked_map(code: str) -> list[dict[str, Any]]:
    """Assertion map of an AI-only script, from its `// expects:` markers (the guard already checked them)."""
    from app.domain.automation import expected_guard as eg

    lines = code.splitlines()
    out: list[dict[str, Any]] = []
    for a in eg.assertions(code):
        step: int | str = "overall"
        for ln in (a.line, a.line - 1):
            if 1 <= ln <= len(lines) and (m := eg._MARKER.search(lines[ln - 1])):
                step = int(m.group(2)) if m.group(2) else "overall"
                break
        helper = a.text.split("(", 1)[0]
        out.append({"step": step, "helper": helper, "args": [a.text], "kind": "ai"})
    return out


def _upsert(s: AsyncSession, row: Any, model: type[Any], **values: Any) -> None:
    """Updates `row` (written by an earlier attempt of the same stage run) in place, or adds a new `model` row."""
    if row is None:
        s.add(model(**values))
        return
    for name, value in values.items():
        setattr(row, name, value)
