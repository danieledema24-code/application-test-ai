"""requirements

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0006'
down_revision: str | None = '0005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('knowledge_items', schema=None) as batch_op:
        batch_op.add_column(sa.Column('metadata', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
    op.create_table('requirements',
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('type', sa.Enum('functional', 'non_functional', name='requirement_type', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('category', sa.String(length=32), nullable=False),
    sa.Column('behaviour_scope', sa.Enum('ui', 'backend', 'mixed', name='requirement_behaviour_scope', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('source', sa.Enum('discovery', 'document', 'user', 'assistant', name='requirement_source', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('source_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('assumptions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.Enum('draft', 'approved', 'rejected', 'needs_info', name='requirement_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status_comment', sa.Text(), nullable=True),
    sa.Column('status_changed_by', sa.Uuid(), nullable=True),
    sa.Column('status_changed_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('risk_level', sa.String(length=16), nullable=True),
    sa.Column('validation_issues', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('feature_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
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
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='requirements_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='requirements_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.CheckConstraint("NOT (provenance = 'observed' AND behaviour_scope <> 'ui')", name=op.f('ck_requirements_observed_ui_only')),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_requirements_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_requirements_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_requirements_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['status_changed_by'], ['users.id'], name=op.f('fk_requirements_status_changed_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_requirements_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_requirements')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_requirements_project_id_stage_run_id_key')),
    sa.UniqueConstraint('stage_run_id', 'lineage_id', name=op.f('uq_requirements_stage_run_id_lineage_id'))
    )
    with op.batch_alter_table('requirements', schema=None) as batch_op:
        batch_op.create_index('ix_requirements_org_project_run_status', ['organisation_id', 'project_id', 'stage_run_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_requirements_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_requirements_project_match_key', ['project_id', 'match_key'], unique=False)
        batch_op.create_index(batch_op.f('ix_requirements_stage_run_id'), ['stage_run_id'], unique=False)
    op.create_table('acceptance_criteria',
    sa.Column('requirement_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.Enum('positive', 'negative', 'boundary', name='ac_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('given_text', sa.Text(), nullable=False),
    sa.Column('when_text', sa.Text(), nullable=False),
    sa.Column('then_text', sa.Text(), nullable=False),
    sa.Column('status', sa.Enum('draft', 'approved', 'rejected', name='ac_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('test_values', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('sort_order', sa.Integer(), nullable=False),
    sa.Column('exercised', sa.Boolean(), nullable=False),
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
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='acceptance_criteria_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='acceptance_criteria_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_acceptance_criteria_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_acceptance_criteria_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['requirement_id'], ['requirements.id'], name=op.f('fk_acceptance_criteria_requirement_id_requirements'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_acceptance_criteria_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_acceptance_criteria_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_acceptance_criteria')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_acceptance_criteria_project_id_stage_run_id_key'))
    )
    with op.batch_alter_table('acceptance_criteria', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_acceptance_criteria_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_acceptance_criteria_requirement_sort', ['requirement_id', 'sort_order'], unique=False)
        batch_op.create_index(batch_op.f('ix_acceptance_criteria_stage_run_id'), ['stage_run_id'], unique=False)
    op.create_table('requirement_features',
    sa.Column('requirement_id', sa.Uuid(), nullable=False),
    sa.Column('feature_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['feature_id'], ['application_features.id'], name=op.f('fk_requirement_features_feature_id_application_features'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['requirement_id'], ['requirements.id'], name=op.f('fk_requirement_features_requirement_id_requirements'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('requirement_id', 'feature_id', name=op.f('pk_requirement_features'))
    )
    with op.batch_alter_table('requirement_features', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_requirement_features_feature_id'), ['feature_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('requirement_features', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_requirement_features_feature_id'))
    op.drop_table('requirement_features')
    with op.batch_alter_table('acceptance_criteria', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_acceptance_criteria_stage_run_id'))
        batch_op.drop_index('ix_acceptance_criteria_requirement_sort')
        batch_op.drop_index(batch_op.f('ix_acceptance_criteria_organisation_id'))
    op.drop_table('acceptance_criteria')
    with op.batch_alter_table('requirements', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_requirements_stage_run_id'))
        batch_op.drop_index('ix_requirements_project_match_key')
        batch_op.drop_index(batch_op.f('ix_requirements_organisation_id'))
        batch_op.drop_index('ix_requirements_org_project_run_status')
    op.drop_table('requirements')
    with op.batch_alter_table('knowledge_items', schema=None) as batch_op:
        batch_op.drop_column('metadata')
