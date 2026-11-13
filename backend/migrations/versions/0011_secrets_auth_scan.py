"""secrets_auth_scan

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-13 09:43:59.283640
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types
from sqlalchemy.dialects import postgresql

revision: str = '0011'
down_revision: str | None = '0010'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('secrets', schema=None) as batch_op:
        batch_op.add_column(sa.Column('kind', sa.Enum('login_credentials', name='secret_kind', native_enum=False, create_constraint=True, length=32), server_default='login_credentials', nullable=False))
        batch_op.add_column(sa.Column('metadata', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
        batch_op.add_column(sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False))
        batch_op.add_column(sa.Column('last_used_at', app.db.types.UTCDateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('last_result', sa.Enum('succeeded', 'failed', 'not_attempted', name='secret_last_result', native_enum=False, create_constraint=True, length=32), nullable=True))
        batch_op.add_column(sa.Column('last_reason_code', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('last_result_at', app.db.types.UTCDateTime(timezone=True), nullable=True))
    with op.batch_alter_table('scan_sessions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('auth', sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), 'postgresql'), nullable=True))
    with op.batch_alter_table('discovered_pages', schema=None) as batch_op:
        batch_op.add_column(sa.Column('auth_context', sa.Enum('anonymous', 'authenticated', name='page_auth_context', native_enum=False, create_constraint=True, length=32), server_default='anonymous', nullable=False))
        batch_op.create_index('ix_discovered_pages_scan_auth_context', ['scan_session_id', 'auth_context'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('discovered_pages', schema=None) as batch_op:
        batch_op.drop_index('ix_discovered_pages_scan_auth_context')
        batch_op.drop_constraint(op.f('ck_discovered_pages_page_auth_context'), type_='check')
        batch_op.drop_column('auth_context')
    with op.batch_alter_table('scan_sessions', schema=None) as batch_op:
        batch_op.drop_column('auth')
    with op.batch_alter_table('secrets', schema=None) as batch_op:
        batch_op.drop_column('last_result_at')
        batch_op.drop_column('last_reason_code')
        batch_op.drop_constraint(op.f('ck_secrets_secret_last_result'), type_='check')
        batch_op.drop_column('last_result')
        batch_op.drop_column('last_used_at')
        batch_op.drop_column('version')
        batch_op.drop_column('metadata')
        batch_op.drop_constraint(op.f('ck_secrets_secret_kind'), type_='check')
        batch_op.drop_column('kind')
