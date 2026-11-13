"""source_documents

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0012'
down_revision: str | None = '0011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_P1_KINDS = ('screenshot', 'dom_snapshot', 'aria_snapshot', 'console_log', 'network_log', 'http_response', 'page_text',
             'trace', 'video', 'k6_summary', 'axe_result', 'lighthouse_result', 'report_render')
_P2_KINDS = (*_P1_KINDS, 'document_file', 'document_text')


def _kind(values: tuple[str, ...]) -> sa.Enum:
    return sa.Enum(*values, name='evidence_kind', native_enum=False, create_constraint=True, length=32)


def upgrade() -> None:
    op.create_table('source_documents',
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('title', sa.String(length=160), nullable=False),
    sa.Column('filename', sa.String(length=255), nullable=False),
    sa.Column('mime', sa.String(length=100), nullable=False),
    sa.Column('size', sa.BigInteger(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('status', sa.Enum('extracting', 'ready', 'failed', 'withdrawn', name='document_status', native_enum=False, create_constraint=True, length=32), nullable=False),
    sa.Column('pages', sa.Integer(), nullable=True),
    sa.Column('chars', sa.Integer(), nullable=True),
    sa.Column('outline', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('statements', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('injection_flags', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=False),
    sa.Column('file_evidence_id', sa.Uuid(), nullable=False),
    sa.Column('text_evidence_id', sa.Uuid(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('uploaded_by', sa.Uuid(), nullable=False),
    sa.Column('withdrawn_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('withdrawn_by', sa.Uuid(), nullable=True),
    sa.Column('withdraw_reason', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['file_evidence_id'], ['evidence.id'], name=op.f('fk_source_documents_file_evidence_id_evidence'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_source_documents_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_source_documents_project_id_projects'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['text_evidence_id'], ['evidence.id'], name=op.f('fk_source_documents_text_evidence_id_evidence'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['uploaded_by'], ['users.id'], name=op.f('fk_source_documents_uploaded_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['withdrawn_by'], ['users.id'], name=op.f('fk_source_documents_withdrawn_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_source_documents')),
    sa.UniqueConstraint('project_id', 'key', name=op.f('uq_source_documents_project_id_key'))
    )
    with op.batch_alter_table('source_documents', schema=None) as batch_op:
        batch_op.create_index('ix_source_documents_org_project_status', ['organisation_id', 'project_id', 'status'], unique=False)
        batch_op.create_index(batch_op.f('ix_source_documents_organisation_id'), ['organisation_id'], unique=False)
    # Widens the evidence.kind CHECK (batch mode recreates the table on SQLite).
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.add_column(sa.Column('source_document_id', sa.Uuid(), nullable=True))
        batch_op.alter_column('kind', existing_type=_kind(_P1_KINDS), type_=_kind(_P2_KINDS), existing_nullable=False)


def downgrade() -> None:
    # Document evidence cannot exist under the narrower Phase 1 CHECK (downgrade is a development operation).
    op.execute("DELETE FROM evidence WHERE kind IN ('document_file', 'document_text')")
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.drop_column('source_document_id')
        batch_op.alter_column('kind', existing_type=_kind(_P2_KINDS), type_=_kind(_P1_KINDS), existing_nullable=False)
    with op.batch_alter_table('source_documents', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_source_documents_organisation_id'))
        batch_op.drop_index('ix_source_documents_org_project_status')
    op.drop_table('source_documents')
