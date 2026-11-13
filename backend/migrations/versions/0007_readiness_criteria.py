"""readiness_criteria

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0007'
down_revision: str | None = '0006'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('readiness_criteria',
    sa.Column('kind', sa.Enum('dor', 'dod', name='readiness_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('scope', sa.Enum('requirement', 'project', name='readiness_scope', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('status', sa.Enum('active', 'removed', name='readiness_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('check_rule_id', sa.String(length=64), nullable=True),
    sa.Column('evaluable_from_phase', sa.Integer(), nullable=True),
    sa.Column('evaluation', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('sort_order', sa.Integer(), nullable=False),
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
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='readiness_criteria_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='readiness_criteria_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_readiness_criteria_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_readiness_criteria_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_readiness_criteria_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_readiness_criteria_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_readiness_criteria')),
    sa.UniqueConstraint('project_id', 'stage_run_id', 'key', name=op.f('uq_readiness_criteria_project_id_stage_run_id_key'))
    )
    with op.batch_alter_table('readiness_criteria', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_readiness_criteria_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_readiness_criteria_project_run_kind', ['project_id', 'stage_run_id', 'kind'], unique=False)
        batch_op.create_index(batch_op.f('ix_readiness_criteria_stage_run_id'), ['stage_run_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('readiness_criteria', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_readiness_criteria_stage_run_id'))
        batch_op.drop_index('ix_readiness_criteria_project_run_kind')
        batch_op.drop_index(batch_op.f('ix_readiness_criteria_organisation_id'))
    op.drop_table('readiness_criteria')
