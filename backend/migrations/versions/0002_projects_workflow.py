"""projects_workflow

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-12 23:56:28.903233
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('projects',
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('status', sa.Enum('active', 'paused', 'archived', name='project_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('approval_policy', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('settings', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('archived_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_projects_created_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_projects_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_projects'))
    )
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.create_index('ix_projects_org_archived_updated', ['organisation_id', 'archived_at', 'updated_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_projects_organisation_id'), ['organisation_id'], unique=False)

    op.create_table('project_counters',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('next_value', sa.Integer(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_project_counters_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_project_counters_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('project_id', 'kind', name=op.f('pk_project_counters'))
    )
    with op.batch_alter_table('project_counters', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_counters_organisation_id'), ['organisation_id'], unique=False)

    op.create_table('secrets',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('ciphertext', sa.Text(), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('rotated_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_secrets_created_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_secrets_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_secrets_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_secrets')),
    sa.UniqueConstraint('project_id', 'name', name=op.f('uq_secrets_project_id_name'))
    )
    with op.batch_alter_table('secrets', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_secrets_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_secrets_project_id'), ['project_id'], unique=False)

    op.create_table('workflow_stages',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_key', sa.Enum('intake', 'discovery', 'discovery_report', 'requirements', 'readiness_criteria', 'test_strategy', 'test_design', 'traceability', 'automation_assessment', 'automation', 'execution', 'failure_analysis', 'defects_summary', 'release_readiness', 'performance', name='stage_key', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('status', sa.Enum('not_started', 'queued', 'running', 'paused', 'awaiting_approval', 'approved', 'changes_requested', 'completed', 'failed', 'stale', 'cancelled', name='stage_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('current_stage_run_id', sa.Uuid(), nullable=True),
    sa.Column('gate_key', sa.Enum('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', name='gate_key', native_enum=False, create_constraint=True, length=32), nullable=True),
    sa.Column('gate_status', sa.Enum('none', 'pending', 'recommended', 'approved', 'rejected', name='gate_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('stale_reason', sa.Text(), nullable=True),
    sa.Column('updated_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_workflow_stages_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_workflow_stages_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], name=op.f('fk_workflow_stages_updated_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_workflow_stages')),
    sa.UniqueConstraint('project_id', 'stage_key', name=op.f('uq_workflow_stages_project_id_stage_key'))
    )
    with op.batch_alter_table('workflow_stages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_workflow_stages_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_workflow_stages_project_id'), ['project_id'], unique=False)

    op.create_table('project_urls',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('url', sa.String(length=2048), nullable=False),
    sa.Column('role', sa.Enum('primary', 'additional', 'api', name='url_role', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('allowed_hosts', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('environment_label', sa.String(length=64), nullable=True),
    sa.Column('authorisation_status', sa.Enum('pending', 'attested', 'revoked', name='authorisation_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('authorised_by', sa.Uuid(), nullable=True),
    sa.Column('authorised_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('authorisation_statement', sa.Text(), nullable=True),
    sa.Column('last_check', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('credentials_secret_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['authorised_by'], ['users.id'], name=op.f('fk_project_urls_authorised_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['credentials_secret_id'], ['secrets.id'], name=op.f('fk_project_urls_credentials_secret_id_secrets'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_project_urls_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_project_urls_project_id_projects'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_project_urls')),
    sa.UniqueConstraint('project_id', 'url', name=op.f('uq_project_urls_project_id_url'))
    )
    with op.batch_alter_table('project_urls', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_urls_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_project_urls_project_id'), ['project_id'], unique=False)

    op.create_table('stage_runs',
    sa.Column('workflow_stage_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_key', sa.Enum('intake', 'discovery', 'discovery_report', 'requirements', 'readiness_criteria', 'test_strategy', 'test_design', 'traceability', 'automation_assessment', 'automation', 'execution', 'failure_analysis', 'defects_summary', 'release_readiness', 'performance', name='stage_run_stage_key', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('status', sa.Enum('not_started', 'queued', 'running', 'paused', 'awaiting_approval', 'approved', 'changes_requested', 'completed', 'failed', 'stale', 'cancelled', name='stage_run_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('agent_task_id', sa.Uuid(), nullable=True),
    sa.Column('input_hash', sa.String(length=64), nullable=True),
    sa.Column('upstream_versions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('parameters', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('output', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('validation_issues', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='stage_run_generated_by', native_enum=False, create_constraint=True, length=32), nullable=True),
    sa.Column('partial', sa.Boolean(), nullable=False),
    sa.Column('started_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('finished_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('triggered_by', sa.Uuid(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_stage_runs_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_stage_runs_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['triggered_by'], ['users.id'], name=op.f('fk_stage_runs_triggered_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['workflow_stage_id'], ['workflow_stages.id'], name=op.f('fk_stage_runs_workflow_stage_id_workflow_stages'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_stage_runs')),
    sa.UniqueConstraint('workflow_stage_id', 'version', name=op.f('uq_stage_runs_workflow_stage_id_version'))
    )
    with op.batch_alter_table('stage_runs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_stage_runs_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_stage_runs_project_id'), ['project_id'], unique=False)

    op.create_table('gate_decisions',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('gate_key', sa.Enum('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', name='decision_gate_key', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('decision', sa.Enum('approve', 'reject', 'request_changes', name='gate_decision', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('comment', sa.Text(), nullable=False),
    sa.Column('decided_by', sa.Uuid(), nullable=True),
    sa.Column('agent_recommendation', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['decided_by'], ['users.id'], name=op.f('fk_gate_decisions_decided_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_gate_decisions_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_gate_decisions_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_gate_decisions_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gate_decisions'))
    )
    with op.batch_alter_table('gate_decisions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_gate_decisions_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_gate_decisions_project_gate_created', ['project_id', 'gate_key', 'created_at'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('gate_decisions', schema=None) as batch_op:
        batch_op.drop_index('ix_gate_decisions_project_gate_created')
        batch_op.drop_index(batch_op.f('ix_gate_decisions_organisation_id'))

    op.drop_table('gate_decisions')
    with op.batch_alter_table('stage_runs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_stage_runs_project_id'))
        batch_op.drop_index(batch_op.f('ix_stage_runs_organisation_id'))

    op.drop_table('stage_runs')
    with op.batch_alter_table('project_urls', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_urls_project_id'))
        batch_op.drop_index(batch_op.f('ix_project_urls_organisation_id'))

    op.drop_table('project_urls')
    with op.batch_alter_table('workflow_stages', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_workflow_stages_project_id'))
        batch_op.drop_index(batch_op.f('ix_workflow_stages_organisation_id'))

    op.drop_table('workflow_stages')
    with op.batch_alter_table('secrets', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_secrets_project_id'))
        batch_op.drop_index(batch_op.f('ix_secrets_organisation_id'))

    op.drop_table('secrets')
    with op.batch_alter_table('project_counters', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_counters_organisation_id'))

    op.drop_table('project_counters')
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_projects_organisation_id'))
        batch_op.drop_index('ix_projects_org_archived_updated')

    op.drop_table('projects')
