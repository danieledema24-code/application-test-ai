"""assistant

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0010'
down_revision: str | None = '0009'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('assistant_threads',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('title', sa.String(length=120), nullable=False),
    sa.Column('archived_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('last_message_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_assistant_threads_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_assistant_threads_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_assistant_threads_user_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_assistant_threads'))
    )
    with op.batch_alter_table('assistant_threads', schema=None) as batch_op:
        batch_op.create_index('ix_assistant_threads_org_project_user_last', ['organisation_id', 'project_id', 'user_id', 'last_message_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_assistant_threads_organisation_id'), ['organisation_id'], unique=False)
    op.create_table('assistant_messages',
    sa.Column('thread_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('role', sa.Enum('user', 'assistant', name='assistant_message_role', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('intent', sa.String(length=48), nullable=True),
    sa.Column('params', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('context_ref', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('answered_by', sa.String(length=16), nullable=True),
    sa.Column('generated_by', sa.String(length=16), nullable=True),
    sa.Column('citations', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('notices', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('llm', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_assistant_messages_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_assistant_messages_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['thread_id'], ['assistant_threads.id'], name=op.f('fk_assistant_messages_thread_id_assistant_threads'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_assistant_messages'))
    )
    with op.batch_alter_table('assistant_messages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_assistant_messages_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_assistant_messages_thread_created', ['thread_id', 'created_at'], unique=False)
    op.create_table('assistant_proposals',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('thread_id', sa.Uuid(), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('target_type', sa.String(length=32), nullable=True),
    sa.Column('target_id', sa.Uuid(), nullable=True),
    sa.Column('target_lineage_id', sa.Uuid(), nullable=True),
    sa.Column('summary', sa.Text(), nullable=False),
    sa.Column('payload', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('preview', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('base_versions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.Enum('pending', 'accepted', 'rejected', 'stale', 'failed', name='proposal_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='proposal_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('decided_by', sa.Uuid(), nullable=True),
    sa.Column('decided_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('decision_comment', sa.Text(), nullable=True),
    sa.Column('result', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_assistant_proposals_created_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['decided_by'], ['users.id'], name=op.f('fk_assistant_proposals_decided_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['message_id'], ['assistant_messages.id'], name=op.f('fk_assistant_proposals_message_id_assistant_messages'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_assistant_proposals_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_assistant_proposals_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['thread_id'], ['assistant_threads.id'], name=op.f('fk_assistant_proposals_thread_id_assistant_threads'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_assistant_proposals')),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_assistant_proposals_project_id_key'))
    )
    with op.batch_alter_table('assistant_proposals', schema=None) as batch_op:
        batch_op.create_index('ix_assistant_proposals_org_project_status', ['organisation_id', 'project_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_assistant_proposals_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_assistant_proposals_target', ['target_type', 'target_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('assistant_proposals', schema=None) as batch_op:
        batch_op.drop_index('ix_assistant_proposals_target')
        batch_op.drop_index(batch_op.f('ix_assistant_proposals_organisation_id'))
        batch_op.drop_index('ix_assistant_proposals_org_project_status')
    op.drop_table('assistant_proposals')
    with op.batch_alter_table('assistant_messages', schema=None) as batch_op:
        batch_op.drop_index('ix_assistant_messages_thread_created')
        batch_op.drop_index(batch_op.f('ix_assistant_messages_organisation_id'))
    op.drop_table('assistant_messages')
    with op.batch_alter_table('assistant_threads', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_assistant_threads_organisation_id'))
        batch_op.drop_index('ix_assistant_threads_org_project_user_last')
    op.drop_table('assistant_threads')
