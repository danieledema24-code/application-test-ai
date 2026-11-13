"""discovery

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-12 23:56:29.034434
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('scan_sessions',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('sequence', sa.Integer(), nullable=False),
    sa.Column('start_url', sa.String(length=2048), nullable=False),
    sa.Column('status', sa.Enum('queued', 'running', 'paused', 'completed', 'partial', 'failed', 'cancelled', name='scan_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('limits', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('frontier', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('stats', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('completeness', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('limitations', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('blocked_requests', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('robots', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('auth_boundaries', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('access_gaps', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('external_links', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('skipped_links', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('injection_flags', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('current', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True),
    sa.Column('control', sa.String(length=16), nullable=True),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.Column('summary_generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='scan_summary_generated_by', native_enum=False, create_constraint=True, length=32), nullable=True),
    sa.Column('started_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('finished_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_scan_sessions_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_scan_sessions_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_scan_sessions_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_scan_sessions')),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_scan_sessions_project_id_key'))
    )
    with op.batch_alter_table('scan_sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_scan_sessions_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_scan_sessions_project_created', ['project_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_scan_sessions_stage_run_id'), ['stage_run_id'], unique=False)

    op.create_table('application_features',
    sa.Column('scan_session_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('category', sa.Enum('navigation', 'auth', 'search', 'form', 'content', 'commerce', 'account', 'other', name='feature_category', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='feature_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('confidence', sa.Float(), nullable=False),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='feature_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('page_ids', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('reason', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_application_features_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_application_features_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['scan_session_id'], ['scan_sessions.id'], name=op.f('fk_application_features_scan_session_id_scan_sessions'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_application_features_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_application_features'))
    )
    with op.batch_alter_table('application_features', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_application_features_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_application_features_project_run', ['project_id', 'stage_run_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_application_features_scan_session_id'), ['scan_session_id'], unique=False)

    op.create_table('discovered_pages',
    sa.Column('scan_session_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('url', sa.String(length=2048), nullable=False),
    sa.Column('url_hash', sa.String(length=64), nullable=False),
    sa.Column('canonical_url', sa.String(length=2048), nullable=True),
    sa.Column('final_url', sa.String(length=2048), nullable=True),
    sa.Column('title', sa.String(length=500), nullable=False),
    sa.Column('http_status', sa.Integer(), nullable=True),
    sa.Column('status', sa.Enum('visited', 'failed', 'blocked', name='page_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('failure_reason', sa.Text(), nullable=True),
    sa.Column('depth', sa.Integer(), nullable=False),
    sa.Column('sequence', sa.Integer(), nullable=False),
    sa.Column('parent_page_id', sa.Uuid(), nullable=True),
    sa.Column('found_via', sa.String(length=32), nullable=True),
    sa.Column('redirected_from', sa.String(length=2048), nullable=True),
    sa.Column('page_type', sa.Enum('landing', 'listing', 'detail', 'form', 'auth', 'search', 'error', 'other', name='page_type', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('requires_auth', sa.Boolean(), nullable=False),
    sa.Column('headings', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('nav_links', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('links', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('forms', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('components', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('counts', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('responsive', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('console_issues', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('network_issues', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('screenshot_evidence_id', sa.Uuid(), nullable=True),
    sa.Column('load_ms', sa.Integer(), nullable=True),
    sa.Column('structure_hash', sa.String(length=64), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_discovered_pages_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['parent_page_id'], ['discovered_pages.id'], name=op.f('fk_discovered_pages_parent_page_id_discovered_pages'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_discovered_pages_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['scan_session_id'], ['scan_sessions.id'], name=op.f('fk_discovered_pages_scan_session_id_scan_sessions'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_discovered_pages')),
    sa.UniqueConstraint('scan_session_id', 'url_hash', name=op.f('uq_discovered_pages_scan_session_id_url_hash'))
    )
    with op.batch_alter_table('discovered_pages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_discovered_pages_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_discovered_pages_project_url_hash', ['project_id', 'url_hash'], unique=False)
        batch_op.create_index(batch_op.f('ix_discovered_pages_scan_session_id'), ['scan_session_id'], unique=False)

    op.create_table('knowledge_items',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.Enum('fact', 'glossary', 'assumption', 'decision', 'constraint', 'user_note', name='knowledge_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('title', sa.String(length=300), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='knowledge_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('source', sa.String(length=64), nullable=False),
    sa.Column('status', sa.Enum('proposed', 'active', 'superseded', 'rejected', name='knowledge_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('superseded_by', sa.Uuid(), nullable=True),
    sa.Column('scan_session_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_knowledge_items_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_knowledge_items_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['scan_session_id'], ['scan_sessions.id'], name=op.f('fk_knowledge_items_scan_session_id_scan_sessions'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_knowledge_items'))
    )
    with op.batch_alter_table('knowledge_items', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_knowledge_items_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_knowledge_items_project_kind_status', ['project_id', 'kind', 'status'], unique=False)

    op.create_table('qa_reports',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('report_type', sa.Enum('discovery', 'requirements_spec', 'test_strategy', 'test_plan', 'test_case_spec', 'rtm', 'execution', 'defect', 'performance', 'completion', 'release_readiness', name='report_type', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('status', sa.Enum('rendering', 'ready', 'failed', name='report_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=True),
    sa.Column('scan_session_id', sa.Uuid(), nullable=True),
    sa.Column('source_versions', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('content', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('files', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('ai_sections', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='report_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_qa_reports_created_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_qa_reports_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_qa_reports_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['scan_session_id'], ['scan_sessions.id'], name=op.f('fk_qa_reports_scan_session_id_scan_sessions'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_qa_reports_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_qa_reports'))
    )
    with op.batch_alter_table('qa_reports', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_qa_reports_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_qa_reports_project_type_version', ['project_id', 'report_type', 'version'], unique=False)

    op.create_table('user_journeys',
    sa.Column('scan_session_id', sa.Uuid(), nullable=False),
    sa.Column('stage_run_id', sa.Uuid(), nullable=False),
    sa.Column('lineage_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('steps', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('provenance', sa.Enum('observed', 'inferred', 'assumed', 'unverified', name='journey_provenance', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('confidence', sa.Float(), nullable=False),
    sa.Column('evidence_refs', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('generated_by', sa.Enum('ai', 'rules', 'human', 'mixed', name='journey_generated_by', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('reason', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_user_journeys_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_user_journeys_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['scan_session_id'], ['scan_sessions.id'], name=op.f('fk_user_journeys_scan_session_id_scan_sessions'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['stage_run_id'], ['stage_runs.id'], name=op.f('fk_user_journeys_stage_run_id_stage_runs'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_journeys'))
    )
    with op.batch_alter_table('user_journeys', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_user_journeys_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_user_journeys_project_run', ['project_id', 'stage_run_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_user_journeys_scan_session_id'), ['scan_session_id'], unique=False)

    op.create_table('evidence',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=True),
    sa.Column('kind', sa.Enum('screenshot', 'dom_snapshot', 'aria_snapshot', 'console_log', 'network_log', 'http_response', 'page_text', 'trace', 'video', 'k6_summary', 'axe_result', 'lighthouse_result', 'report_render', name='evidence_kind', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('storage_key', sa.String(length=512), nullable=False),
    sa.Column('mime', sa.String(length=100), nullable=False),
    sa.Column('size', sa.BigInteger(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('source_url', sa.String(length=2048), nullable=True),
    sa.Column('viewport', sa.String(length=32), nullable=True),
    sa.Column('scan_session_id', sa.Uuid(), nullable=True),
    sa.Column('page_id', sa.Uuid(), nullable=True),
    sa.Column('execution_result_id', sa.Uuid(), nullable=True),
    sa.Column('performance_run_id', sa.Uuid(), nullable=True),
    sa.Column('captured_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('metadata', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_evidence_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['page_id'], ['discovered_pages.id'], name=op.f('fk_evidence_page_id_discovered_pages'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_evidence_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['scan_session_id'], ['scan_sessions.id'], name=op.f('fk_evidence_scan_session_id_scan_sessions'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_evidence'))
    )
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_evidence_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_evidence_page_id'), ['page_id'], unique=False)
        batch_op.create_index('ix_evidence_project_kind', ['project_id', 'kind'], unique=False)
        batch_op.create_index(batch_op.f('ix_evidence_scan_session_id'), ['scan_session_id'], unique=False)

    op.create_table('feature_pages',
    sa.Column('feature_id', sa.Uuid(), nullable=False),
    sa.Column('page_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['feature_id'], ['application_features.id'], name=op.f('fk_feature_pages_feature_id_application_features'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['page_id'], ['discovered_pages.id'], name=op.f('fk_feature_pages_page_id_discovered_pages'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('feature_id', 'page_id', name=op.f('pk_feature_pages'))
    )


def downgrade() -> None:
    op.drop_table('feature_pages')
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_evidence_scan_session_id'))
        batch_op.drop_index('ix_evidence_project_kind')
        batch_op.drop_index(batch_op.f('ix_evidence_page_id'))
        batch_op.drop_index(batch_op.f('ix_evidence_organisation_id'))

    op.drop_table('evidence')
    with op.batch_alter_table('user_journeys', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_user_journeys_scan_session_id'))
        batch_op.drop_index('ix_user_journeys_project_run')
        batch_op.drop_index(batch_op.f('ix_user_journeys_organisation_id'))

    op.drop_table('user_journeys')
    with op.batch_alter_table('qa_reports', schema=None) as batch_op:
        batch_op.drop_index('ix_qa_reports_project_type_version')
        batch_op.drop_index(batch_op.f('ix_qa_reports_organisation_id'))

    op.drop_table('qa_reports')
    with op.batch_alter_table('knowledge_items', schema=None) as batch_op:
        batch_op.drop_index('ix_knowledge_items_project_kind_status')
        batch_op.drop_index(batch_op.f('ix_knowledge_items_organisation_id'))

    op.drop_table('knowledge_items')
    with op.batch_alter_table('discovered_pages', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_discovered_pages_scan_session_id'))
        batch_op.drop_index('ix_discovered_pages_project_url_hash')
        batch_op.drop_index(batch_op.f('ix_discovered_pages_organisation_id'))

    op.drop_table('discovered_pages')
    with op.batch_alter_table('application_features', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_application_features_scan_session_id'))
        batch_op.drop_index('ix_application_features_project_run')
        batch_op.drop_index(batch_op.f('ix_application_features_organisation_id'))

    op.drop_table('application_features')
    with op.batch_alter_table('scan_sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_scan_sessions_stage_run_id'))
        batch_op.drop_index('ix_scan_sessions_project_created')
        batch_op.drop_index(batch_op.f('ix_scan_sessions_organisation_id'))

    op.drop_table('scan_sessions')
