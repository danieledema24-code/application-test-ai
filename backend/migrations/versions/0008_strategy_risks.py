"""strategy_risks

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0008'
down_revision: str | None = '0007'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('test_strategies',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('status', sa.Enum('draft', 'awaiting_approval', 'approved', 'stale', name='strategy_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='strategy_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('content', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('approved_input', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('human_edited_sections', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('locked_sections', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('suggested_changes', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('validation_issues', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_test_strategies_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_test_strategies_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_test_strategies_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_test_strategies_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_test_strategies')),
    sa.UniqueConstraint('project_id', 'stage_run_id', name=op.f('uq_test_strategies_project_id_stage_run_id'))
    )
    with op.batch_alter_table('test_strategies', schema=None) as batch_op:
        batch_op.create_index('ix_test_strategies_org_project_status', ['organisation_id', 'project_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_strategies_organisation_id'), ['organisation_id'], unique=False)
    op.create_table('risks',
    sa.Column('strategy_id', sa.Uuid(), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('category', sa.Enum('product', 'project', name='risk_category', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('likelihood', sa.Integer(), nullable=False),
    sa.Column('impact', sa.Integer(), nullable=False),
    sa.Column('score', sa.Integer(), nullable=False),
    sa.Column('level', sa.Enum('low', 'medium', 'high', 'very_high', name='risk_level', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('factors', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('likelihood_rationale', sa.Text(), nullable=False),
    sa.Column('impact_rationale', sa.Text(), nullable=False),
    sa.Column('mitigation', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('requires_approval', sa.Boolean(), nullable=False),
    sa.Column('status', sa.Enum('open', 'mitigated', 'accepted', name='risk_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status_comment', sa.Text(), nullable=True),
    sa.Column('source', sa.String(length=16), nullable=False),
    sa.Column('requirement_lineage_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
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
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='risks_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='risks_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.CheckConstraint('likelihood BETWEEN 1 AND 5 AND impact BETWEEN 1 AND 5 AND score = likelihood * impact', name=op.f('ck_risks_score_is_l_times_i')),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_risks_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_risks_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_risks_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['strategy_id'], ['test_strategies.id'], name=op.f('fk_risks_strategy_id_test_strategies'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_risks_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_risks')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_risks_project_id_stage_run_id_key'))
    )
    with op.batch_alter_table('risks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_risks_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_risks_project_run_level', ['project_id', 'stage_run_id', 'level'], unique=False)
        batch_op.create_index(batch_op.f('ix_risks_stage_run_id'), ['stage_run_id'], unique=False)
    op.create_table('risk_requirements',
    sa.Column('risk_id', sa.Uuid(), nullable=False),
    sa.Column('requirement_lineage_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['risk_id'], ['risks.id'], name=op.f('fk_risk_requirements_risk_id_risks'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('risk_id', 'requirement_lineage_id', name=op.f('pk_risk_requirements'))
    )
    with op.batch_alter_table('risk_requirements', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_risk_requirements_requirement_lineage_id'), ['requirement_lineage_id'], unique=False)
    op.create_table('risk_features',
    sa.Column('risk_id', sa.Uuid(), nullable=False),
    sa.Column('feature_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['feature_id'], ['application_features.id'], name=op.f('fk_risk_features_feature_id_application_features'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['risk_id'], ['risks.id'], name=op.f('fk_risk_features_risk_id_risks'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('risk_id', 'feature_id', name=op.f('pk_risk_features'))
    )


def downgrade() -> None:
    op.drop_table('risk_features')
    with op.batch_alter_table('risk_requirements', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_risk_requirements_requirement_lineage_id'))
    op.drop_table('risk_requirements')
    with op.batch_alter_table('risks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_risks_stage_run_id'))
        batch_op.drop_index('ix_risks_project_run_level')
        batch_op.drop_index(batch_op.f('ix_risks_organisation_id'))
    op.drop_table('risks')
    with op.batch_alter_table('test_strategies', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_strategies_organisation_id'))
        batch_op.drop_index('ix_test_strategies_org_project_status')
    op.drop_table('test_strategies')
