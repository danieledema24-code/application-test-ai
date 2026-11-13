"""test_plans

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0009'
down_revision: str | None = '0008'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('test_plans',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('strategy_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('strategy_version', sa.Integer(), nullable=False),
    sa.Column('source', sa.Enum('derived', 'edited', 'regenerated', name='plan_source', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('review_status', sa.Enum('not_required', 'pending_review', 'applied', 'discarded', name='plan_review_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('is_current', sa.Boolean(), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='plan_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('content', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('human_edited_sections', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('rules_template_sections', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('suggested_changes', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('review', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_test_plans_created_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_test_plans_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_test_plans_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_test_plans_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['strategy_id'], ['test_strategies.id'], name=op.f('fk_test_plans_strategy_id_test_strategies'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_test_plans')),
    sa.UniqueConstraint('project_id', 'version', name=op.f('uq_test_plans_project_id_version'))
    )
    with op.batch_alter_table('test_plans', schema=None) as batch_op:
        batch_op.create_index('ix_test_plans_org_project_current', ['organisation_id', 'project_id', 'is_current'], unique=False)
        batch_op.create_index(batch_op.f('ix_test_plans_organisation_id'), ['organisation_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('test_plans', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_test_plans_organisation_id'))
        batch_op.drop_index('ix_test_plans_org_project_current')
    op.drop_table('test_plans')
