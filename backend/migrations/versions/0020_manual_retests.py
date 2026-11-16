"""manual_retests (P6-05a, decision D37): manual re-tests of impacted must-run tests are recordable

New table `manual_retests`: a person's passed/failed result with a note for an impacted manual must-run test of a
change set. Append-only; the latest row per (change set, case) counts for the release readiness criterion
`rr.impacted_rerun`. No existing table changes.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-16 15:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.db.types  # noqa: F401 - custom column types

revision: str = '0020'
down_revision: str | None = '0019'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _fk(table: str, column: str, target: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint([column], [f'{target}.id'], name=op.f(f'fk_{table}_{column}_{target}'),
                                   ondelete='RESTRICT')


def upgrade() -> None:
    op.create_table('manual_retests',
    sa.Column('change_set_id', sa.Uuid(), nullable=False),
    sa.Column('case_lineage_id', sa.Uuid(), nullable=False),
    sa.Column('test_case_id', sa.Uuid(), nullable=False),
    sa.Column('status', sa.Enum('passed', 'failed', name='manual_retest_status', native_enum=False,
                                create_constraint=True, length=32), nullable=False),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('recorded_by', sa.Uuid(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('organisation_id', sa.Uuid(), nullable=False),
    sa.Column('updated_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('created_at', app.db.types.UTCDateTime(timezone=True), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    _fk('manual_retests', 'change_set_id', 'change_sets'),
    _fk('manual_retests', 'test_case_id', 'test_cases'),
    _fk('manual_retests', 'recorded_by', 'users'),
    _fk('manual_retests', 'organisation_id', 'organisations'),
    _fk('manual_retests', 'project_id', 'projects'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_manual_retests')),
    )
    with op.batch_alter_table('manual_retests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_manual_retests_organisation_id'), ['organisation_id'], unique=False)
        batch_op.create_index('ix_manual_retests_set_case', ['change_set_id', 'case_lineage_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('manual_retests', schema=None) as batch_op:
        batch_op.drop_index('ix_manual_retests_set_case')
        batch_op.drop_index(batch_op.f('ix_manual_retests_organisation_id'))
    op.drop_table('manual_retests')
