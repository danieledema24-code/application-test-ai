"""test_design

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-13 15:36:02.895261
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0013'
down_revision: str | None = '0012'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('test_cases',
    sa.Column('condition_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('objective', sa.Text(), nullable=False),
    sa.Column('preconditions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('steps', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('expected_result', sa.Text(), nullable=False),
    sa.Column('expected_result_status', sa.Enum('defined', 'open_question', name='test_case_expected_result_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('open_question_ref', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('test_type', sa.String(length=32), nullable=False),
    sa.Column('test_level', sa.String(length=32), nullable=False),
    sa.Column('technique', sa.String(length=32), nullable=False),
    sa.Column('suites', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('side_effects', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('design_basis_ref', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('automation_suitability', sa.Enum('suitable', 'partial', 'manual_only', name='test_case_automation_suitability', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('automation_reason', sa.Text(), nullable=False),
    sa.Column('automation_assessed', sa.String(length=16), nullable=False),
    sa.Column('execution_status', sa.Enum('not_run', 'passed', 'failed', 'blocked', 'error', name='test_case_execution_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status', sa.Enum('draft', 'approved', 'rejected', 'deprecated', name='test_case_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status_comment', sa.Text(), nullable=True),
    sa.Column('status_changed_by', sa.Uuid(), nullable=True),
    sa.Column('status_changed_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('source', sa.Enum('design', 'user', 'assistant', name='test_case_source', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('risk_level', sa.String(length=16), nullable=True),
    sa.Column('risk_score', sa.Integer(), nullable=True),
    sa.Column('risk_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('derived_priority', sa.Enum('critical', 'high', 'medium', 'low', name='test_case_derived_priority', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('priority_override', sa.Enum('critical', 'high', 'medium', 'low', name='test_case_priority_override', native_enum=False, create_constraint=True, length=32), nullable=True),
    sa.Column('priority_override_reason', sa.Text(), nullable=True),
    sa.Column('priority_overridden_by', sa.Uuid(), nullable=True),
    sa.Column('lint', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('lint_rules_version', sa.Integer(), nullable=False),
    sa.Column('requirement_lineage_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('ac_lineage_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('data_lineage_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('match_key', sa.String(length=400), nullable=False),
    sa.Column('carried_from_id', sa.Uuid(), nullable=True),
    sa.Column('confidence', sa.Float(), nullable=False),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('rule_id', sa.String(length=64), nullable=True),
    sa.Column('locked', sa.Boolean(), nullable=False),
    sa.Column('human_edited', sa.Boolean(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('suggested_change', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='test_cases_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='test_cases_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.CheckConstraint('priority_override IS NULL OR priority_override_reason IS NOT NULL', name=op.f('ck_test_cases_override_needs_reason')),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_test_cases_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['priority_overridden_by'], ['users.id'], name=op.f('fk_test_cases_priority_overridden_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_test_cases_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_test_cases_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['status_changed_by'], ['users.id'], name=op.f('fk_test_cases_status_changed_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_test_cases_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_test_cases')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_test_cases_project_id_stage_run_id_key')),
    sa.UniqueConstraint('stage_run_id', 'lineage_id', name=op.f('uq_test_cases_stage_run_id_lineage_id'))
    )
    with op.batch_alter_table('test_cases', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_test_cases_condition_lineage_id'), ['condition_lineage_id'], unique=False)
        batch_op.create_index('ix_test_cases_org_project_run_status', ['organisation_id', 'project_id', 'stage_run_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_cases_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_test_cases_project_run_priority', ['project_id', 'stage_run_id', 'derived_priority'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_cases_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('test_conditions',
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('technique', sa.String(length=32), nullable=False),
    sa.Column('test_type', sa.String(length=32), nullable=False),
    sa.Column('feature_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('design_basis', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('coverage_items', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('notes', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.Enum('draft', 'approved', 'rejected', name='test_condition_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status_comment', sa.Text(), nullable=True),
    sa.Column('requirement_lineage_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('ac_lineage_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('match_key', sa.String(length=400), nullable=False),
    sa.Column('carried_from_id', sa.Uuid(), nullable=True),
    sa.Column('confidence', sa.Float(), nullable=False),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('rule_id', sa.String(length=64), nullable=True),
    sa.Column('locked', sa.Boolean(), nullable=False),
    sa.Column('human_edited', sa.Boolean(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('suggested_change', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='test_conditions_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='test_conditions_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_test_conditions_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_test_conditions_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_test_conditions_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_test_conditions_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_test_conditions')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_test_conditions_project_id_stage_run_id_key')),
    sa.UniqueConstraint('stage_run_id', 'lineage_id', name=op.f('uq_test_conditions_stage_run_id_lineage_id'))
    )
    with op.batch_alter_table('test_conditions', schema=None) as batch_op:
        batch_op.create_index('ix_test_conditions_org_project_run_technique', ['organisation_id', 'project_id', 'stage_run_id', 'technique'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_conditions_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_conditions_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('test_data',
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('feature_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('form_ref', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('field_label', sa.String(length=200), nullable=False),
    sa.Column('field_selector', sa.String(length=400), nullable=False),
    sa.Column('kind', sa.Enum('valid', 'invalid', 'boundary', 'secret_ref', name='test_data_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('value_type', sa.Enum('text', 'email', 'number', 'empty', 'whitespace', 'secret_ref', name='test_data_value_type', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('value', sa.Text(), nullable=True),
    sa.Column('secret_ref', sa.String(length=120), nullable=True),
    sa.Column('length', sa.Integer(), nullable=True),
    sa.Column('boundary_ref', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('generator', sa.String(length=120), nullable=True),
    sa.Column('synthetic', sa.Boolean(), nullable=False),
    sa.Column('status', sa.Enum('active', 'retired', name='test_data_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('match_key', sa.String(length=400), nullable=False),
    sa.Column('carried_from_id', sa.Uuid(), nullable=True),
    sa.Column('confidence', sa.Float(), nullable=False),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('rule_id', sa.String(length=64), nullable=True),
    sa.Column('locked', sa.Boolean(), nullable=False),
    sa.Column('human_edited', sa.Boolean(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('suggested_change', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='test_data_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='test_data_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.CheckConstraint("(kind = 'secret_ref') = (secret_ref IS NOT NULL AND value IS NULL)", name=op.f('ck_test_data_secret_ref_only')),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_test_data_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_test_data_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_test_data_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_test_data_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_test_data')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_test_data_project_id_stage_run_id_key')),
    sa.UniqueConstraint('stage_run_id', 'lineage_id', name=op.f('uq_test_data_stage_run_id_lineage_id'))
    )
    with op.batch_alter_table('test_data', schema=None) as batch_op:
        batch_op.create_index('ix_test_data_org_project_run_field', ['organisation_id', 'project_id', 'stage_run_id', 'field_label'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_data_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_data_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('condition_requirements',
    sa.Column('test_condition_id', sa.Uuid(), nullable=False),
    sa.Column('requirement_lineage_id', sa.Uuid(), nullable=False),
    sa.Column('acceptance_criterion_lineage_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['test_condition_id'], ['test_conditions.id'], name=op.f('fk_condition_requirements_test_condition_id_test_conditions'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('test_condition_id', 'requirement_lineage_id', 'acceptance_criterion_lineage_id', name=op.f('pk_condition_requirements'))
    )
    with op.batch_alter_table('condition_requirements', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_condition_requirements_requirement_lineage_id'), ['requirement_lineage_id'], unique=False)

    op.create_table('test_case_data',
    sa.Column('test_case_id', sa.Uuid(), nullable=False),
    sa.Column('test_data_lineage_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['test_case_id'], ['test_cases.id'], name=op.f('fk_test_case_data_test_case_id_test_cases'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('test_case_id', 'test_data_lineage_id', name=op.f('pk_test_case_data'))
    )
    with op.batch_alter_table('test_case_data', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_test_case_data_test_data_lineage_id'), ['test_data_lineage_id'], unique=False)

    op.create_table('test_case_requirements',
    sa.Column('test_case_id', sa.Uuid(), nullable=False),
    sa.Column('requirement_lineage_id', sa.Uuid(), nullable=False),
    sa.Column('acceptance_criterion_lineage_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['test_case_id'], ['test_cases.id'], name=op.f('fk_test_case_requirements_test_case_id_test_cases'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('test_case_id', 'requirement_lineage_id', 'acceptance_criterion_lineage_id', name=op.f('pk_test_case_requirements'))
    )
    with op.batch_alter_table('test_case_requirements', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_test_case_requirements_requirement_lineage_id'), ['requirement_lineage_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('test_case_requirements', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_case_requirements_requirement_lineage_id'))

    op.drop_table('test_case_requirements')
    with op.batch_alter_table('test_case_data', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_case_data_test_data_lineage_id'))

    op.drop_table('test_case_data')
    with op.batch_alter_table('condition_requirements', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_condition_requirements_requirement_lineage_id'))

    op.drop_table('condition_requirements')
    with op.batch_alter_table('test_data', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_data_stage_run_id'))
        batch_op.drop_index(batch_op.f('ix_test_data_organisation_id'))
        batch_op.drop_index('ix_test_data_org_project_run_field')

    op.drop_table('test_data')
    with op.batch_alter_table('test_conditions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_conditions_stage_run_id'))
        batch_op.drop_index(batch_op.f('ix_test_conditions_organisation_id'))
        batch_op.drop_index('ix_test_conditions_org_project_run_technique')

    op.drop_table('test_conditions')
    with op.batch_alter_table('test_cases', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_cases_stage_run_id'))
        batch_op.drop_index('ix_test_cases_project_run_priority')
        batch_op.drop_index(batch_op.f('ix_test_cases_organisation_id'))
        batch_op.drop_index('ix_test_cases_org_project_run_status')
        batch_op.drop_index(batch_op.f('ix_test_cases_condition_lineage_id'))

    op.drop_table('test_cases')
