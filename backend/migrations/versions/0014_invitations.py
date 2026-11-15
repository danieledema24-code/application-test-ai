"""invitations

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-13 15:36:14.056964
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import Text  # noqa: F401 - used by rendered JSONB variants

import app.db.types  # noqa: F401 - custom column types


revision: str = '0014'
down_revision: str | None = '0013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('invitations',
    sa.Column('email', sa.String(length=320), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('can_approve', sa.Boolean(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('invited_by', sa.Uuid(), nullable=False),
    sa.Column('expires_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('accepted_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('accepted_user_id', sa.Uuid(), nullable=True),
    sa.Column('revoked_at', app.db.types.UTCDateTime(timezone=True), nullable=True),
    sa.Column('revoked_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['accepted_user_id'], ['users.id'], name=op.f('fk_invitations_accepted_user_id_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['invited_by'], ['users.id'], name=op.f('fk_invitations_invited_by_users'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['organisation_id'], ['organisations.id'], name=op.f('fk_invitations_organisation_id_organisations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['revoked_by'], ['users.id'], name=op.f('fk_invitations_revoked_by_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_invitations')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_invitations_token_hash'))
    )
    with op.batch_alter_table('invitations', schema=None) as batch_op:
        batch_op.create_index('ix_invitations_org_email', ['organisation_id', 'email'], unique=False)
        batch_op.create_index('ix_invitations_org_expires', ['organisation_id', 'expires_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_invitations_organisation_id'), ['organisation_id'], unique=False)

    with op.batch_alter_table('memberships', schema=None) as batch_op:
        batch_op.add_column(sa.Column('invited_by', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('joined_at', app.db.types.UTCDateTime(timezone=True), nullable=True))
        batch_op.create_foreign_key(batch_op.f('fk_memberships_invited_by_users'), 'users', ['invited_by'], ['id'], ondelete='RESTRICT')



def downgrade() -> None:
    with op.batch_alter_table('memberships', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_memberships_invited_by_users'), type_='foreignkey')
        batch_op.drop_column('joined_at')
        batch_op.drop_column('invited_by')

    with op.batch_alter_table('invitations', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_invitations_organisation_id'))
        batch_op.drop_index('ix_invitations_org_expires')
        batch_op.drop_index('ix_invitations_org_email')

    op.drop_table('invitations')
