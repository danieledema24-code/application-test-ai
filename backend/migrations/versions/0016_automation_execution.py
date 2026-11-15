"""automation_execution (P4-00): every Phase 4 table and column, created up front

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-13 22:54:24.371657
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0016'
down_revision: str | None = '0015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('automation_assets',
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.Enum('page_object', 'factory', 'platform', 'config', name='automation_asset_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('path', sa.String(length=300), nullable=False),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('generated_by', sa.Enum('rules', 'ai', 'heal', 'platform', name='automation_asset_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_automation_assets_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_automation_assets_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_automation_assets_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_automation_assets')),
    sa.UniqueConstraint('stage_run_id', 'path', name=op.f('uq_automation_assets_stage_run_id_path'))
    )
    with op.batch_alter_table('automation_assets', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_automation_assets_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_automation_assets_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('automation_assessments',
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('test_case_id', sa.Uuid(), nullable=False),
    sa.Column('case_lineage_id', sa.Uuid(), nullable=False),
    sa.Column('case_version', sa.Integer(), nullable=False),
    sa.Column('suitability', sa.Enum('suitable', 'partial', 'manual_only', name='automation_assessment_suitability', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('reasons', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('blockers', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('step_model', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_automation_assessments_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_automation_assessments_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_automation_assessments_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['test_case_id'], ['test_cases.id'], name=op.f('fk_automation_assessments_test_case_id_test_cases'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_automation_assessments')),
    sa.UniqueConstraint('stage_run_id', 'case_lineage_id', name=op.f('uq_automation_assessments_stage_run_id_case_lineage_id'))
    )
    with op.batch_alter_table('automation_assessments', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_automation_assessments_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_automation_assessments_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('automation_scripts',
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('test_case_id', sa.Uuid(), nullable=False),
    sa.Column('case_lineage_id', sa.Uuid(), nullable=False),
    sa.Column('case_version', sa.Integer(), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('path', sa.String(length=300), nullable=False),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('assertion_map', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.Enum('draft', 'valid', 'invalid', 'outdated', name='automation_script_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('validation', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('generated_by', sa.Enum('rules', 'ai', 'heal', 'platform', name='automation_script_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('review', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_automation_scripts_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_automation_scripts_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_automation_scripts_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['test_case_id'], ['test_cases.id'], name=op.f('fk_automation_scripts_test_case_id_test_cases'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_automation_scripts')),
    sa.UniqueConstraint('stage_run_id', 'case_lineage_id', name=op.f('uq_automation_scripts_stage_run_id_case_lineage_id'))
    )
    with op.batch_alter_table('automation_scripts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_automation_scripts_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_automation_scripts_project_status', ['project_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_automation_scripts_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('execution_runs',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=True),
    sa.Column('mode', sa.Enum('automated', 'manual', name='execution_run_mode', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('selection', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('scope', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('scope_hash', sa.String(length=64), nullable=True),
    sa.Column('config', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('bundle_version', sa.Integer(), nullable=True),
    sa.Column('g7_decision_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.Enum('awaiting_authorisation', 'rejected', 'queued', 'running', 'passed', 'failed', 'error', 'cancelled', name='execution_run_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('totals', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('requested_by', sa.Uuid(), nullable=True),
    sa.Column('started_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('finished_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['g7_decision_id'], ['gate_decisions.id'], name=op.f('fk_execution_runs_g7_decision_id_gate_decisions'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_execution_runs_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_execution_runs_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['requested_by'], ['users.id'], name=op.f('fk_execution_runs_requested_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_execution_runs_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_execution_runs')),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_execution_runs_project_id_key'))
    )
    with op.batch_alter_table('execution_runs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_execution_runs_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_execution_runs_project_created', ['project_id', 'created_at'], unique=False)
        batch_op.create_index('ix_execution_runs_project_status', ['project_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_execution_runs_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('approvals',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.Enum('destructive', 'external_transaction', 'real_user_data', 'load_test', 'security_test', name='approval_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('execution_run_id', sa.Uuid(), nullable=True),
    sa.Column('scope', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('requested_by', sa.Uuid(), nullable=True),
    sa.Column('decided_by', sa.Uuid(), nullable=True),
    sa.Column('decided_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('status', sa.Enum('pending', 'approved', 'rejected', 'expired', 'used', name='approval_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('comment', sa.Text(), nullable=True),
    sa.Column('expires_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['decided_by'], ['users.id'], name=op.f('fk_approvals_decided_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['execution_run_id'], ['execution_runs.id'], name=op.f('fk_approvals_execution_run_id_execution_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_approvals_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_approvals_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['requested_by'], ['users.id'], name=op.f('fk_approvals_requested_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_approvals')),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_approvals_project_id_key'))
    )
    with op.batch_alter_table('approvals', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_approvals_execution_run_id'), ['execution_run_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_approvals_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_approvals_project_kind_status', ['project_id', 'kind', 'status'], unique=False)

    op.create_table('execution_results',
    sa.Column('execution_run_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=40), nullable=False),
    sa.Column('test_case_id', sa.Uuid(), nullable=True),
    sa.Column('case_lineage_id', sa.Uuid(), nullable=False),
    sa.Column('automation_script_id', sa.Uuid(), nullable=True),
    sa.Column('script_version', sa.Integer(), nullable=True),
    sa.Column('browser', sa.String(length=32), nullable=False),
    sa.Column('viewport', sa.String(length=32), nullable=False),
    sa.Column('status', sa.Enum('passed', 'failed', 'error', 'skipped', 'blocked', 'flaky', name='execution_result_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('duration_ms', sa.Integer(), nullable=True),
    sa.Column('steps', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('failed_step', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('page_state', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('actual_result', sa.Text(), nullable=False),
    sa.Column('classification', sa.Enum('application_defect', 'script_defect', 'selector_failure', 'test_data_issue', 'environment_failure', 'network_failure', 'flaky', 'unknown', name='execution_result_classification', native_enum=False, create_constraint=True, length=32), nullable=True),
    sa.Column('analysis', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('heal_suggestions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['automation_script_id'], ['automation_scripts.id'], name=op.f('fk_execution_results_automation_script_id_automation_scripts'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['execution_run_id'], ['execution_runs.id'], name=op.f('fk_execution_results_execution_run_id_execution_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_execution_results_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_execution_results_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['test_case_id'], ['test_cases.id'], name=op.f('fk_execution_results_test_case_id_test_cases'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_execution_results')),
    sa.UniqueConstraint('execution_run_id', 'key', name=op.f('uq_execution_results_execution_run_id_key'))
    )
    with op.batch_alter_table('execution_results', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_execution_results_execution_run_id'), ['execution_run_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_execution_results_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_execution_results_project_case_created', ['project_id', 'case_lineage_id', 'created_at'], unique=False)

    op.create_table('defects',
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('summary', sa.String(length=300), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('environment', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('preconditions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('steps', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('expected', sa.Text(), nullable=False),
    sa.Column('actual', sa.Text(), nullable=False),
    sa.Column('severity', sa.Enum('critical', 'major', 'minor', 'trivial', name='defect_severity', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('severity_derived', sa.Enum('critical', 'major', 'minor', 'trivial', name='defect_severity_derived', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('severity_reason', sa.Text(), nullable=True),
    sa.Column('priority', sa.Enum('critical', 'high', 'medium', 'low', name='defect_priority', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('priority_derived', sa.Enum('critical', 'high', 'medium', 'low', name='defect_priority_derived', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('priority_reason', sa.Text(), nullable=True),
    sa.Column('reproducibility', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('root_cause_hypothesis', sa.Text(), nullable=True),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.Enum('draft', 'confirmed', 'rejected', 'fixed', 'verified', 'closed', name='defect_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status_reason', sa.Text(), nullable=True),
    sa.Column('status_comment', sa.Text(), nullable=True),
    sa.Column('confirmed_by', sa.Uuid(), nullable=True),
    sa.Column('confirmed_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('source', sa.Enum('analysis', 'user', name='defect_source', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('execution_result_id', sa.Uuid(), nullable=True),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['confirmed_by'], ['users.id'], name=op.f('fk_defects_confirmed_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['execution_result_id'], ['execution_results.id'], name=op.f('fk_defects_execution_result_id_execution_results'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_defects_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_defects_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_defects')),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_defects_project_id_key'))
    )
    with op.batch_alter_table('defects', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_defects_execution_result_id'), ['execution_result_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_defects_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_defects_project_severity', ['project_id', 'severity'], unique=False)
        batch_op.create_index('ix_defects_project_status', ['project_id', 'status'], unique=False)

    op.create_table('defect_links',
    sa.Column('defect_id', sa.Uuid(), nullable=False),
    sa.Column('requirement_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('test_case_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['defect_id'], ['defects.id'], name=op.f('fk_defect_links_defect_id_defects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_defect_links_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_defect_links_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_defect_links'))
    )
    with op.batch_alter_table('defect_links', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_defect_links_defect_id'), ['defect_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_defect_links_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_defect_links_requirement_lineage_id'), ['requirement_lineage_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_defect_links_test_case_lineage_id'), ['test_case_lineage_id'], unique=False)

    op.create_table('defect_occurrences',
    sa.Column('defect_id', sa.Uuid(), nullable=False),
    sa.Column('execution_result_id', sa.Uuid(), nullable=False),
    sa.Column('seen_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['defect_id'], ['defects.id'], name=op.f('fk_defect_occurrences_defect_id_defects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['execution_result_id'], ['execution_results.id'], name=op.f('fk_defect_occurrences_execution_result_id_execution_results'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_defect_occurrences_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_defect_occurrences_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_defect_occurrences')),
    sa.UniqueConstraint('defect_id', 'execution_result_id', name=op.f('uq_defect_occurrences_defect_id_execution_result_id'))
    )
    with op.batch_alter_table('defect_occurrences', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_defect_occurrences_execution_result_id'), ['execution_result_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_defect_occurrences_organisation_id'), ['organisation_id'], unique=False)

    # Batch mode recreates evidence and gate_decisions on SQLite (FK and nullability changes); their CHECK
    # constraints are carried over by reflection (asserted in tests/integration/test_p4_migrations.py).
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_evidence_execution_result_id'), ['execution_result_id'], unique=False)
        batch_op.create_foreign_key(batch_op.f('fk_evidence_execution_result_id_execution_results'), 'execution_results', ['execution_result_id'], ['id'], ondelete='RESTRICT')

    with op.batch_alter_table('gate_decisions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('subject_type', sa.Enum('execution_run', 'defect', 'automation_script', name='gate_decision_subject_type', native_enum=False, create_constraint=True, length=32), nullable=True))
        batch_op.add_column(sa.Column('subject_id', sa.Uuid(), nullable=True))
        batch_op.alter_column('stage_run_id',
               existing_type=sa.Uuid(),
               nullable=True)
        batch_op.create_index('ix_gate_decisions_subject', ['project_id', 'subject_type', 'subject_id'], unique=False)



def downgrade() -> None:
    # Per-subject decisions (G7 per run, G8 per defect, G6 script reviews) can't exist without the Phase 4 tables
    # (downgrade is a development operation).
    op.execute("DELETE FROM gate_decisions WHERE subject_type IS NOT NULL OR stage_run_id IS NULL")
    op.execute("UPDATE evidence SET execution_result_id = NULL WHERE execution_result_id IS NOT NULL")
    with op.batch_alter_table('gate_decisions', schema=None) as batch_op:
        batch_op.drop_index('ix_gate_decisions_subject')
        batch_op.alter_column('stage_run_id',
               existing_type=sa.Uuid(),
               nullable=False)
        batch_op.drop_column('subject_id')
        # The reflected CHECK on subject_type would outlive the column in the rebuilt table.
        batch_op.drop_constraint('gate_decision_subject_type', type_='check')  # ck_gate_decisions_… by convention
        batch_op.drop_column('subject_type')

    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_evidence_execution_result_id_execution_results'), type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_evidence_execution_result_id'))

    with op.batch_alter_table('defect_occurrences', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_defect_occurrences_organisation_id'))
        batch_op.drop_index(batch_op.f('ix_defect_occurrences_execution_result_id'))

    op.drop_table('defect_occurrences')
    with op.batch_alter_table('defect_links', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_defect_links_test_case_lineage_id'))
        batch_op.drop_index(batch_op.f('ix_defect_links_requirement_lineage_id'))
        batch_op.drop_index(batch_op.f('ix_defect_links_organisation_id'))
        batch_op.drop_index(batch_op.f('ix_defect_links_defect_id'))

    op.drop_table('defect_links')
    with op.batch_alter_table('defects', schema=None) as batch_op:
        batch_op.drop_index('ix_defects_project_status')
        batch_op.drop_index('ix_defects_project_severity')
        batch_op.drop_index(batch_op.f('ix_defects_organisation_id'))
        batch_op.drop_index(batch_op.f('ix_defects_execution_result_id'))

    op.drop_table('defects')
    with op.batch_alter_table('execution_results', schema=None) as batch_op:
        batch_op.drop_index('ix_execution_results_project_case_created')
        batch_op.drop_index(batch_op.f('ix_execution_results_organisation_id'))
        batch_op.drop_index(batch_op.f('ix_execution_results_execution_run_id'))

    op.drop_table('execution_results')
    with op.batch_alter_table('approvals', schema=None) as batch_op:
        batch_op.drop_index('ix_approvals_project_kind_status')
        batch_op.drop_index(batch_op.f('ix_approvals_organisation_id'))
        batch_op.drop_index(batch_op.f('ix_approvals_execution_run_id'))

    op.drop_table('approvals')
    with op.batch_alter_table('execution_runs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_execution_runs_stage_run_id'))
        batch_op.drop_index('ix_execution_runs_project_status')
        batch_op.drop_index('ix_execution_runs_project_created')
        batch_op.drop_index(batch_op.f('ix_execution_runs_organisation_id'))

    op.drop_table('execution_runs')
    with op.batch_alter_table('automation_scripts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_automation_scripts_stage_run_id'))
        batch_op.drop_index('ix_automation_scripts_project_status')
        batch_op.drop_index(batch_op.f('ix_automation_scripts_organisation_id'))

    op.drop_table('automation_scripts')
    with op.batch_alter_table('automation_assessments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_automation_assessments_stage_run_id'))
        batch_op.drop_index(batch_op.f('ix_automation_assessments_organisation_id'))

    op.drop_table('automation_assessments')
    with op.batch_alter_table('automation_assets', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_automation_assets_stage_run_id'))
        batch_op.drop_index(batch_op.f('ix_automation_assets_organisation_id'))

    op.drop_table('automation_assets')
