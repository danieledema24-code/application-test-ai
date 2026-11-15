"""Shared setup for the Phase 5 integration tests (P5-01b, P5-02, P5-03).

A project on a local fixture site is put past G2 (and G4 when asked) directly in the database, with discovered
pages and features for the given paths (discovery itself is covered in test_discovery_e2e.py), so each test runs
only the check or load test it is about.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

import httpx
from sqlalchemy import func, select

from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    DiscoveredPage,
    Project,
    ProjectUrl,
    Requirement,
    ScanSession,
    StageRun,
    WorkflowStage,
)
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import (
    BehaviourScope,
    FeatureCategory,
    GateStatus,
    GeneratedBy,
    PageStatus,
    PageType,
    Provenance,
    RequirementSource,
    RequirementStatus,
    RequirementType,
    ScanStatus,
    StageKey,
    StageStatus,
)
from tests.conftest import Account

API = "/api/v1"


async def stage_run(
    ctx: AppContext, org_id: uuid.UUID, pid: uuid.UUID, key: StageKey, status: StageStatus, output: dict[str, Any]
) -> uuid.UUID:
    async with ctx.session_factory() as s:
        st = (
            await s.execute(
                select(WorkflowStage)
                .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == key)
                .execution_options(**BYPASS)
            )
        ).scalar_one()
        n = int(
            (
                await s.execute(
                    select(func.count())
                    .select_from(StageRun)
                    .where(StageRun.workflow_stage_id == st.id)
                    .execution_options(**BYPASS)
                )
            ).scalar_one()
        )
        run = StageRun(organisation_id=org_id, workflow_stage_id=st.id, project_id=pid, stage_key=key, version=n + 1,
                       status=status, output=output, generated_by=GeneratedBy.rules, started_at=utcnow(),
                       finished_at=utcnow())  # fmt: skip
        s.add(run)
        await s.flush()
        st.current_stage_run_id = run.id
        st.status = status
        if st.gate_key is not None and status == StageStatus.approved:
            st.gate_status = GateStatus.approved
        await s.commit()
        return run.id


PAGE_TYPES = {"/": PageType.landing, "/products": PageType.listing}


async def seed_site(
    ctx: AppContext,
    client: httpx.AsyncClient,
    owner: Account,
    base_url: str,
    paths: list[str],
    *,
    signed_in: tuple[str, ...] = (),
    g4: bool = False,
    titles: dict[str, str] | None = None,
    requirement: tuple[str, list[str]] | None = None,
    category: str = "performance",
) -> dict[str, Any]:
    """A project on `base_url` with discovery done and G2 approved (G4 too with `g4`). `requirement`: an approved
    requirement (text, page paths) linked through one feature, for threshold and mapping tests."""
    r = await client.post(
        f"{API}/projects",
        json={"url": base_url, "name": f"P5 {uuid.uuid4().hex[:6]}", "start": False,
              "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."}},
        headers=owner.headers,
    )  # fmt: skip
    assert r.status_code == 201, r.text
    project: dict[str, Any] = r.json()
    pid = uuid.UUID(project["id"])
    async with ctx.session_factory() as s:
        url = (
            await s.execute(select(ProjectUrl).where(ProjectUrl.project_id == pid).execution_options(**BYPASS))
        ).scalar_one()
        url.last_check = {**(url.last_check or {}), "final_url": base_url}
        await s.commit()
    drun = await stage_run(ctx, owner.org_id, pid, StageKey.discovery, StageStatus.approved, {"pages": len(paths)})
    pages: dict[str, uuid.UUID] = {}
    async with ctx.session_factory() as s:
        scan = ScanSession(organisation_id=owner.org_id, project_id=pid, stage_run_id=drun, key="SCAN-0001",
                           sequence=1, start_url=base_url + "/", status=ScanStatus.completed,
                           started_at=utcnow(), finished_at=utcnow())  # fmt: skip
        s.add(scan)
        await s.flush()
        for i, path in enumerate(paths):
            full = base_url + path
            p = DiscoveredPage(
                organisation_id=owner.org_id, scan_session_id=scan.id, project_id=pid, url=full,
                url_hash=hashlib.sha256(full.encode()).hexdigest(), final_url=full,
                title=(titles or {}).get(path, path.strip("/").replace("/", " ").title() or "Home") + " · Fixture",
                http_status=200, status=PageStatus.visited, sequence=i, page_type=PAGE_TYPES.get(path, PageType.other),
                requires_auth=path in signed_in,
            )  # fmt: skip
            s.add(p)
            await s.flush()
            pages[path] = p.id
        feat = ApplicationFeature(
            organisation_id=owner.org_id, scan_session_id=scan.id, stage_run_id=drun, project_id=pid, key="FEAT-0001",
            name="Fixture pages", category=FeatureCategory.content, provenance=Provenance.observed, confidence=0.9,
            generated_by=GeneratedBy.rules,
            page_ids=[str(pages[x]) for x in (requirement[1] if requirement else paths)],
        )  # fmt: skip
        s.add(feat)
        await s.commit()
        feat_id = feat.id
    if requirement is not None:
        rrun = await stage_run(ctx, owner.org_id, pid, StageKey.requirements, StageStatus.approved, {})
        async with ctx.session_factory() as s:
            s.add(Requirement(
                organisation_id=owner.org_id, project_id=pid, stage_run_id=rrun, key="REQ-0012",
                match_key="req-0012", title=requirement[0], description=requirement[0],
                type=RequirementType.non_functional, category=category, behaviour_scope=BehaviourScope.ui,
                source=RequirementSource.document, status=RequirementStatus.approved,
                feature_ids=[str(feat_id)], provenance=Provenance.observed, generated_by=GeneratedBy.rules,
            ))  # fmt: skip
            await s.commit()
    if g4:
        await stage_run(ctx, owner.org_id, pid, StageKey.test_strategy, StageStatus.approved, {})
    project["pages"] = {k: str(v) for k, v in pages.items()}
    return project


async def project_row(ctx: AppContext, pid: str) -> Project:
    async with ctx.session_factory() as s:
        return (
            await s.execute(select(Project).where(Project.id == uuid.UUID(pid)).execution_options(**BYPASS))
        ).scalar_one()
