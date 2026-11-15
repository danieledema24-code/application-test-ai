"""change_intelligence (P6-00): every Phase 6 table and column, created up front

New tables: `change_sets`, `change_items`, `impact_items`, `heal_suggestions`, `exploratory_steps` and
`release_assessments`. New columns: `scan_sessions.is_rescan` and `baseline_scan_session_id`,
`approvals.quality_scan_id`, `automation_scripts.outdated_reason`. CHECK constraints widened (batch mode recreates the
tables on SQLite): the stage keys gain `change_analysis` and `exploratory`, quality scan and finding kinds and defect
sources gain `exploratory`, approval kinds gain `exploratory_session`, and gate decision subjects gain
`release_assessment` (G9 per assessment, P6-05a). Every existing organisation gets the D30 exploration ceiling in
`organisations.settings` (and the server default carries it). Workflow rows for the two new stages are added to
existing projects by the startup step (`services.projects.ensure_stage_rows`), not here, so a running Phase 5 process
never reads a stage key it doesn't know. Phase 4 `execution_results.heal_suggestions` JSON is left as it is.

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-15 20:00:00
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants
from sqlalchemy.dialects import postgresql

import app.db.types  # noqa: F401 - custom column types

revision: str = '0019'
down_revision: str | None = '0018'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_P5_STAGES = ('intake', 'discovery', 'discovery_report', 'requirements', 'readiness_criteria', 'test_strategy',
              'test_design', 'traceability', 'automation_assessment', 'automation', 'execution', 'failure_analysis',
              'defects_summary', 'release_readiness', 'performance', 'accessibility', 'security_assessment')
_P6_STAGES = (*_P5_STAGES, 'change_analysis', 'exploratory')
_P5_SCAN_KINDS = ('accessibility', 'security')
_P6_SCAN_KINDS = (*_P5_SCAN_KINDS, 'exploratory')
_P5_SOURCES = ('analysis', 'user', 'accessibility', 'security', 'performance')
_P6_SOURCES = (*_P5_SOURCES, 'exploratory')
_P5_APPROVALS = ('destructive', 'external_transaction', 'real_user_data', 'load_test', 'security_test')
_P6_APPROVALS = (*_P5_APPROVALS, 'exploratory_session')
_P5_SUBJECTS = ('execution_run', 'defect', 'automation_script')
_P6_SUBJECTS = (*_P5_SUBJECTS, 'release_assessment')
# (table, column, CHECK name, Phase 5 values, Phase 6 values)
_WIDENED = (
    ('workflow_stages', 'stage_key', 'stage_key', _P5_STAGES, _P6_STAGES),
    ('stage_runs', 'stage_key', 'stage_run_stage_key', _P5_STAGES, _P6_STAGES),
    ('quality_scans', 'kind', 'quality_scan_kind', _P5_SCAN_KINDS, _P6_SCAN_KINDS),
    ('quality_findings', 'kind', 'quality_finding_kind', _P5_SCAN_KINDS, _P6_SCAN_KINDS),
    ('defects', 'source', 'defect_source', _P5_SOURCES, _P6_SOURCES),
    ('gate_decisions', 'subject_type', 'gate_decision_subject_type', _P5_SUBJECTS, _P6_SUBJECTS),
)

_P5_ORG_DEFAULT = '{"load_ceiling": {"vus": 20, "rps": 20, "duration_s": 300}}'
_P6_ORG_DEFAULT = ('{"load_ceiling": {"vus": 20, "rps": 20, "duration_s": 300}, '
                   '"exploration_ceiling": {"actions": 60, "minutes": 10}}')
_EXPLORATION_CEILING = {"actions": 60, "minutes": 10}

_JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql')


def _enum(name: str, values: tuple[str, ...]) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False, create_constraint=True, length=32)


def _in(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _tenant_columns() -> list[sa.Column]:
    return [
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('organisation_id', sa.Uuid(), nullable=False),
        sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
        sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
        sa.Column('project_id', sa.Uuid(), nullable=False),
    ]


def _tenant_constraints(table: str) -> list[sa.Constraint]:
    return [
        sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'],
                                name=op.f(f'fk_{table}_organisation_id_organisations'), ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f(f'fk_{table}_project_id_projects'),
                                ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id', name=op.f(f'pk_{table}')),
    ]


def _fk(table: str, column: str, target: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint([column], [f'{target}.id'], name=op.f(f'fk_{table}_{column}_{target}'),
                                   ondelete='RESTRICT')


def _set_exploration_ceiling(add: bool) -> None:
    """Adds (or removes) `exploration_ceiling` in every organisation's settings, keeping every other key."""
    orgs = sa.table('organisations', sa.column('id', sa.Uuid()), sa.column('settings', _JSON))
    bind = op.get_bind()
    for org_id, settings in bind.execute(sa.select(orgs.c.id, orgs.c.settings)).all():
        data = settings if isinstance(settings, dict) else json.loads(settings or '{}')
        if add and 'exploration_ceiling' not in data:
            data = {**data, 'exploration_ceiling': dict(_EXPLORATION_CEILING)}
        elif not add and 'exploration_ceiling' in data:
            data = {k: v for k, v in data.items() if k != 'exploration_ceiling'}
        else:
            continue
        bind.execute(orgs.update().where(orgs.c.id == org_id).values(settings=data))


def upgrade() -> None:
    op.create_table('change_sets',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=True),
    sa.Column('base_scan_session_id', sa.Uuid(), nullable=False),
    sa.Column('target_scan_session_id', sa.Uuid(), nullable=False),
    sa.Column('status', _enum('change_set_status', ('queued', 'running', 'completed', 'failed')), nullable=False),
    sa.Column('summary', _JSON, nullable=False),
    sa.Column('rerun_recommendation', _JSON, nullable=True),
    sa.Column('rebaseline_suggested', sa.Boolean(), server_default=sa.false(), nullable=False),
    sa.Column('generated_by', _enum('change_set_generated_by', ('ai', 'rules', 'human', 'mixed')), nullable=False),
    sa.Column('ai_summary', sa.Text(), nullable=True),
    sa.Column('finished_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    *_tenant_columns(),
    _fk('change_sets', 'stage_run_id', 'stage_runs'),
    _fk('change_sets', 'base_scan_session_id', 'scan_sessions'),
    _fk('change_sets', 'target_scan_session_id', 'scan_sessions'),
    *_tenant_constraints('change_sets'),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_change_sets_project_id_key'))
    )
    with op.batch_alter_table('change_sets', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_change_sets_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_change_sets_stage_run_id'), ['stage_run_id'], unique=False)
        batch_op.create_index('ix_change_sets_project_target', ['project_id', 'target_scan_session_id'],
                              unique=False)

    op.create_table('change_items',
    sa.Column('change_set_id', sa.Uuid(), nullable=False),
    sa.Column('kind', _enum('change_item_kind', (
        'page_added', 'page_removed', 'page_changed', 'element_added', 'element_removed', 'element_renamed',
        'element_moved', 'form_added', 'form_removed', 'form_changed', 'field_added', 'field_removed',
        'field_changed', 'navigation_changed', 'journey_added', 'journey_removed', 'journey_changed',
        'requirement_changed')), nullable=False),
    sa.Column('significance', _enum('change_significance', ('structural', 'behavioural', 'cosmetic')),
              nullable=False),
    sa.Column('page_url', sa.String(length=2048), nullable=True),
    sa.Column('before', _JSON, nullable=True),
    sa.Column('after', _JSON, nullable=True),
    sa.Column('before_ref', _JSON, nullable=True),
    sa.Column('after_ref', _JSON, nullable=True),
    *_tenant_columns(),
    _fk('change_items', 'change_set_id', 'change_sets'),
    *_tenant_constraints('change_items'),
    )
    with op.batch_alter_table('change_items', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_change_items_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_change_items_set_kind', ['change_set_id', 'kind'], unique=False)

    op.create_table('impact_items',
    sa.Column('change_set_id', sa.Uuid(), nullable=False),
    sa.Column('change_item_ids', _JSON, nullable=False),
    sa.Column('target_kind', _enum('impact_target_kind', (
        'requirement', 'test_case', 'automation_script', 'page_object_locator', 'defect', 'quality_finding',
        'performance_target', 'coverage_gap')), nullable=False),
    sa.Column('target_ref', sa.String(length=64), nullable=False),
    sa.Column('level', _enum('impact_level', ('direct', 'indirect', 'gap')), nullable=False),
    sa.Column('action', _enum('impact_action', ('rerun', 'review', 'heal', 'regenerate', 'write_requirement')),
              nullable=False),
    sa.Column('reason', sa.Text(), nullable=False),
    sa.Column('status', _enum('impact_status', ('open', 'resolved', 'no_action')), nullable=False),
    sa.Column('status_reason', sa.Text(), nullable=True),
    sa.Column('resolved_by', sa.Uuid(), nullable=True),
    sa.Column('resolved_by_run_id', sa.Uuid(), nullable=True),
    sa.Column('resolved_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    *_tenant_columns(),
    _fk('impact_items', 'change_set_id', 'change_sets'),
    _fk('impact_items', 'resolved_by', 'users'),
    _fk('impact_items', 'resolved_by_run_id', 'execution_runs'),
    *_tenant_constraints('impact_items'),
    )
    with op.batch_alter_table('impact_items', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_impact_items_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_impact_items_project_status', ['project_id', 'status'], unique=False)
        batch_op.create_index('ix_impact_items_set_target_kind', ['change_set_id', 'target_kind'], unique=False)

    op.create_table('heal_suggestions',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('source', _enum('heal_source', ('change', 'failure')), nullable=False),
    sa.Column('change_item_id', sa.Uuid(), nullable=True),
    sa.Column('execution_result_id', sa.Uuid(), nullable=True),
    sa.Column('automation_asset_id', sa.Uuid(), nullable=True),
    sa.Column('asset_version', sa.Integer(), nullable=True),
    sa.Column('file', sa.String(length=300), nullable=True),
    sa.Column('getter', sa.String(length=200), nullable=True),
    sa.Column('old_expression', sa.Text(), nullable=True),
    sa.Column('candidates', _JSON, nullable=False),
    sa.Column('kind', _enum('heal_kind', ('locator', 'expected_result_review')), nullable=False),
    sa.Column('test_case_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('status', _enum('heal_status', ('open', 'accepted', 'rejected', 'superseded')), nullable=False),
    sa.Column('accepted_index', sa.Integer(), nullable=True),
    sa.Column('new_asset_version', sa.Integer(), nullable=True),
    sa.Column('decided_by', sa.Uuid(), nullable=True),
    sa.Column('decided_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('reason', sa.Text(), nullable=True),
    sa.Column('generated_by', _enum('heal_generated_by', ('ai', 'rules', 'human', 'mixed')), nullable=False),
    *_tenant_columns(),
    _fk('heal_suggestions', 'change_item_id', 'change_items'),
    _fk('heal_suggestions', 'execution_result_id', 'execution_results'),
    _fk('heal_suggestions', 'automation_asset_id', 'automation_assets'),
    _fk('heal_suggestions', 'decided_by', 'users'),
    *_tenant_constraints('heal_suggestions'),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_heal_suggestions_project_id_key'))
    )
    with op.batch_alter_table('heal_suggestions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_heal_suggestions_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_heal_suggestions_change_item_id'), ['change_item_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_heal_suggestions_execution_result_id'), ['execution_result_id'],
                              unique=False)
        batch_op.create_index('ix_heal_suggestions_project_status', ['project_id', 'status'], unique=False)

    op.create_table('exploratory_steps',
    sa.Column('scan_id', sa.Uuid(), nullable=False),
    sa.Column('n', sa.Integer(), nullable=False),
    sa.Column('page_url', sa.String(length=2048), nullable=False),
    sa.Column('action', _JSON, nullable=False),
    sa.Column('outcome', _enum('exploratory_step_outcome', ('ok', 'no_effect', 'navigated', 'error', 'blocked')),
              nullable=False),
    sa.Column('observations', _JSON, nullable=False),
    sa.Column('evidence_ids', _JSON, nullable=False),
    sa.Column('chosen_by', _enum('exploratory_chosen_by', ('rules', 'ai')), nullable=False),
    *_tenant_columns(),
    _fk('exploratory_steps', 'scan_id', 'quality_scans'),
    *_tenant_constraints('exploratory_steps'),
    sa.UniqueConstraint('scan_id', 'n', name=op.f('uq_exploratory_steps_scan_id_n'))
    )
    with op.batch_alter_table('exploratory_steps', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_exploratory_steps_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_exploratory_steps_scan_id'), ['scan_id'], unique=False)

    op.create_table('release_assessments',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=True),
    sa.Column('status', _enum('release_assessment_status',
                              ('awaiting_approval', 'final', 'rejected', 'superseded', 'stale')), nullable=False),
    sa.Column('recommendation', _enum('release_recommendation', ('go', 'conditional', 'no_go')), nullable=False),
    sa.Column('criteria', _JSON, nullable=False),
    sa.Column('conditions', _JSON, nullable=False),
    sa.Column('residual_risks', _JSON, nullable=False),
    sa.Column('overall_residual', sa.String(length=32), nullable=True),
    sa.Column('scope', _JSON, nullable=False),
    sa.Column('stale_reason', sa.Text(), nullable=True),
    sa.Column('decision', _enum('release_assessment_decision', ('approve', 'reject', 'override')), nullable=True),
    sa.Column('final_verdict', _enum('release_final_verdict', ('go', 'conditional', 'no_go')), nullable=True),
    sa.Column('override_reason', sa.Text(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('decided_by', sa.Uuid(), nullable=True),
    sa.Column('decided_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('generated_by', _enum('release_assessment_generated_by', ('ai', 'rules', 'human', 'mixed')),
              nullable=False),
    sa.Column('ai_sections', _JSON, nullable=False),
    *_tenant_columns(),
    _fk('release_assessments', 'stage_run_id', 'stage_runs'),
    _fk('release_assessments', 'created_by', 'users'),
    _fk('release_assessments', 'decided_by', 'users'),
    *_tenant_constraints('release_assessments'),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_release_assessments_project_id_key'))
    )
    with op.batch_alter_table('release_assessments', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_release_assessments_organisation_id'), ['organisation_id'],
                              unique=False)
        batch_op.create_index(batch_op.f('ix_release_assessments_stage_run_id'), ['stage_run_id'], unique=False)
        batch_op.create_index('ix_release_assessments_project_status', ['project_id', 'status'], unique=False)

    # ---------------------------------------------------------------- existing tables
    with op.batch_alter_table('scan_sessions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('is_rescan', sa.Boolean(), server_default=sa.false(), nullable=False))
        batch_op.add_column(sa.Column('baseline_scan_session_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(batch_op.f('fk_scan_sessions_baseline_scan_session_id_scan_sessions'),
                                    'scan_sessions', ['baseline_scan_session_id'], ['id'], ondelete='RESTRICT')
    with op.batch_alter_table('approvals', schema=None) as batch_op:
        batch_op.add_column(sa.Column('quality_scan_id', sa.Uuid(), nullable=True))
        batch_op.create_index(batch_op.f('ix_approvals_quality_scan_id'), ['quality_scan_id'], unique=False)
        batch_op.create_foreign_key(batch_op.f('fk_approvals_quality_scan_id_quality_scans'), 'quality_scans',
                                    ['quality_scan_id'], ['id'], ondelete='RESTRICT')
        batch_op.alter_column('kind', existing_type=_enum('approval_kind', _P5_APPROVALS),
                              type_=_enum('approval_kind', _P6_APPROVALS), existing_nullable=False)
    with op.batch_alter_table('automation_scripts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('outdated_reason', sa.Text(), nullable=True))
    # Batch mode recreates each table on SQLite; its other CHECK constraints are carried over by reflection
    # (asserted in tests/integration/test_p6_foundation.py).
    for table, column, name, old, new in _WIDENED:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column(column, existing_type=_enum(name, old), type_=_enum(name, new),
                                  existing_nullable=column == 'subject_type')
    with op.batch_alter_table('organisations', schema=None) as batch_op:
        batch_op.alter_column('settings', existing_type=_JSON, server_default=_P6_ORG_DEFAULT,
                              existing_server_default=_P5_ORG_DEFAULT, existing_nullable=False)
    _set_exploration_ceiling(add=True)


def downgrade() -> None:
    # Phase 6 rows can't exist under the Phase 5 CHECKs and foreign keys (downgrade is a development operation):
    # exploratory sessions with their findings, evidence, approvals and defect drafts, G9 subject decisions and the
    # rows of the two new stages go. Stored files stay in storage.
    new_stages = _in(('change_analysis', 'exploratory'))
    exp_scans = "SELECT id FROM quality_scans WHERE kind = 'exploratory'"
    exp_defects = "SELECT id FROM defects WHERE source = 'exploratory'"
    op.execute("DELETE FROM approvals WHERE kind = 'exploratory_session' OR quality_scan_id IS NOT NULL")
    op.execute(f"DELETE FROM evidence WHERE quality_scan_id IN ({exp_scans})")
    op.execute(f"DELETE FROM quality_findings WHERE kind = 'exploratory' OR scan_id IN ({exp_scans})")
    op.execute("DELETE FROM gate_decisions WHERE subject_type = 'release_assessment'")
    op.execute(f"DELETE FROM gate_decisions WHERE subject_type = 'defect' AND subject_id IN ({exp_defects})")
    op.execute(f"DELETE FROM defect_links WHERE defect_id IN ({exp_defects})")
    op.execute(f"DELETE FROM defect_occurrences WHERE defect_id IN ({exp_defects})")
    op.execute(f"DELETE FROM defects WHERE id IN ({exp_defects})")
    op.execute("DELETE FROM exploratory_steps")
    op.execute("DELETE FROM quality_scans WHERE kind = 'exploratory'")
    # Agent tasks and gate decisions point at these stage runs (ON DELETE RESTRICT), so they go first.
    new_runs = f"SELECT id FROM stage_runs WHERE stage_key IN ({new_stages})"
    op.execute(f"DELETE FROM agent_tasks WHERE stage_run_id IN ({new_runs})")
    op.execute(f"DELETE FROM gate_decisions WHERE stage_run_id IN ({new_runs})")
    op.execute(f"DELETE FROM stage_runs WHERE stage_key IN ({new_stages})")
    op.execute(f"DELETE FROM workflow_stages WHERE stage_key IN ({new_stages})")
    op.execute("UPDATE scan_sessions SET baseline_scan_session_id = NULL")

    _set_exploration_ceiling(add=False)
    with op.batch_alter_table('organisations', schema=None) as batch_op:
        batch_op.alter_column('settings', existing_type=_JSON, server_default=_P5_ORG_DEFAULT,
                              existing_server_default=_P6_ORG_DEFAULT, existing_nullable=False)
    for table, column, name, old, new in reversed(_WIDENED):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column(column, existing_type=_enum(name, new), type_=_enum(name, old),
                                  existing_nullable=column == 'subject_type')
    with op.batch_alter_table('automation_scripts', schema=None) as batch_op:
        batch_op.drop_column('outdated_reason')
    with op.batch_alter_table('approvals', schema=None) as batch_op:
        batch_op.alter_column('kind', existing_type=_enum('approval_kind', _P6_APPROVALS),
                              type_=_enum('approval_kind', _P5_APPROVALS), existing_nullable=False)
        batch_op.drop_constraint(batch_op.f('fk_approvals_quality_scan_id_quality_scans'), type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_approvals_quality_scan_id'))
        batch_op.drop_column('quality_scan_id')
    with op.batch_alter_table('scan_sessions', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_scan_sessions_baseline_scan_session_id_scan_sessions'),
                                 type_='foreignkey')
        batch_op.drop_column('baseline_scan_session_id')
        batch_op.drop_column('is_rescan')

    for table in ('release_assessments', 'exploratory_steps', 'heal_suggestions', 'impact_items', 'change_items',
                  'change_sets'):
        op.drop_table(table)
