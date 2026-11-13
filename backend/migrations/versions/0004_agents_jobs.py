"""agents_jobs

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-12 23:56:29.157579
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('worker_heartbeats',
    sa.Column('worker_id', sa.String(length=100), nullable=False),
    sa.Column('mode', sa.String(length=16), nullable=False),
    sa.Column('heartbeat_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('worker_id', name=op.f('pk_worker_heartbeats'))
    )
    op.create_table('agent_events',
    sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('agent_task_id', sa.Uuid(), nullable=True),
    sa.Column('stage_key', sa.String(length=32), nullable=True),
    sa.Column('agent_key', sa.String(length=32), nullable=True),
    sa.Column('type', sa.String(length=48), nullable=False),
    sa.Column('level', sa.Enum('info', 'warn', 'error', name='event_level', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('data', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_agent_events_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_agent_events_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_agent_events'))
    )
    with op.batch_alter_table('agent_events', schema=None) as batch_op:
        batch_op.create_index('ix_agent_events_org_id', ['organisation_id', 'id'], unique=False)
        batch_op.create_index(batch_op.f('ix_agent_events_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_agent_events_project_id', ['project_id', 'id'], unique=False)

    op.create_table('jobs',
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('payload', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.Enum('queued', 'running', 'succeeded', 'failed', 'cancelled', name='job_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('dedupe_key', sa.String(length=200), nullable=True),
    sa.Column('concurrency_group', sa.String(length=32), nullable=True),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('max_attempts', sa.Integer(), nullable=False),
    sa.Column('run_after', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('locked_by', sa.String(length=100), nullable=True),
    sa.Column('locked_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('heartbeat_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('cancel_requested', sa.Boolean(), nullable=False),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('finished_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_jobs_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_jobs_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_jobs')),
    sa.UniqueConstraint('dedupe_key', name=op.f('uq_jobs_dedupe_key'))
    )
    with op.batch_alter_table('jobs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_jobs_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_jobs_status_run_after', ['status', 'run_after'], unique=False)

    op.create_table('agent_tasks',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=True),
    sa.Column('agent_key', sa.String(length=32), nullable=False),
    sa.Column('status', sa.Enum('queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused', name='task_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('input', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('output_ref', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('error', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('attempt', sa.Integer(), nullable=False),
    sa.Column('llm', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('dedupe_key', sa.String(length=200), nullable=True),
    sa.Column('started_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('finished_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('heartbeat_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_agent_tasks_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_agent_tasks_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_agent_tasks_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_agent_tasks')),
    sa.UniqueConstraint('dedupe_key', name=op.f('uq_agent_tasks_dedupe_key'))
    )
    with op.batch_alter_table('agent_tasks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_agent_tasks_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_agent_tasks_project_created', ['project_id', 'created_at'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('agent_tasks', schema=None) as batch_op:
        batch_op.drop_index('ix_agent_tasks_project_created')
        batch_op.drop_index(batch_op.f('ix_agent_tasks_organisation_id'))

    op.drop_table('agent_tasks')
    with op.batch_alter_table('jobs', schema=None) as batch_op:
        batch_op.drop_index('ix_jobs_status_run_after')
        batch_op.drop_index(batch_op.f('ix_jobs_organisation_id'))

    op.drop_table('jobs')
    with op.batch_alter_table('agent_events', schema=None) as batch_op:
        batch_op.drop_index('ix_agent_events_project_id')
        batch_op.drop_index(batch_op.f('ix_agent_events_organisation_id'))
        batch_op.drop_index('ix_agent_events_org_id')

    op.drop_table('agent_events')
    op.drop_table('worker_heartbeats')
