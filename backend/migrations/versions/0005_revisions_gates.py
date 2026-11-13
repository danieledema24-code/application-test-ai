"""revisions_gates

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('entity_revisions',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('entity_type', sa.String(length=32), nullable=False),
    sa.Column('entity_id', sa.Uuid(), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('snapshot', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('changes', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.Column('proposal_id', sa.Uuid(), nullable=True),
    sa.Column('changed_by', sa.Uuid(), nullable=True),
    sa.Column('change_reason', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['changed_by'], ['users.id'], name=op.f('fk_entity_revisions_changed_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_entity_revisions_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_entity_revisions_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_entity_revisions')),
    sa.UniqueConstraint('entity_type', 'lineage_id', 'version', name=op.f('uq_entity_revisions_entity_type_lineage_id_version'))
    )
    with op.batch_alter_table('entity_revisions', schema=None) as batch_op:
        batch_op.create_index('ix_entity_revisions_org_project_type_lineage', ['organisation_id', 'project_id', 'entity_type', 'lineage_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_entity_revisions_organisation_id'), ['organisation_id'], unique=False)
    with op.batch_alter_table('gate_decisions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('artefact_snapshot', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
        batch_op.add_column(sa.Column('snapshot_hash', sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column('stage_run_versions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
    with op.batch_alter_table('stage_runs', schema=None) as batch_op:
        batch_op.add_column(sa.Column('review_status', sa.Enum('not_required', 'pending_review', 'applied', 'discarded', name='stage_run_review_status', native_enum=False, create_constraint=True, length=32), server_default='not_required', nullable=False))
        batch_op.add_column(sa.Column('review_decisions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
        batch_op.add_column(sa.Column('applied_by', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('applied_at', app.db.types.UTCDateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('guidance', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('approved_input', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
        batch_op.create_foreign_key(batch_op.f('fk_stage_runs_applied_by_users'), 'users', ['applied_by'], ['id'], ondelete='RESTRICT')


def downgrade() -> None:
    with op.batch_alter_table('stage_runs', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_stage_runs_applied_by_users'), type_='foreignkey')
        batch_op.drop_column('approved_input')
        batch_op.drop_column('guidance')
        batch_op.drop_column('applied_at')
        batch_op.drop_column('applied_by')
        batch_op.drop_column('review_decisions')
        batch_op.drop_constraint(op.f('ck_stage_runs_stage_run_review_status'), type_='check')
        batch_op.drop_column('review_status')
    with op.batch_alter_table('gate_decisions', schema=None) as batch_op:
        batch_op.drop_column('stage_run_versions')
        batch_op.drop_column('snapshot_hash')
        batch_op.drop_column('artefact_snapshot')
    with op.batch_alter_table('entity_revisions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_entity_revisions_organisation_id'))
        batch_op.drop_index('ix_entity_revisions_org_project_type_lineage')
    op.drop_table('entity_revisions')
