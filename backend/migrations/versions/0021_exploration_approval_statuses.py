"""exploration_approval_statuses (P6-03a, decision D30): a signed-in exploratory session waits for its approval

The `quality_scans.status` CHECK gains `awaiting_approval`, `rejected` and `expired` (the P5-01b load test pattern): a
signed-in exploratory session is created `awaiting_approval` with a pending `exploratory_session` approval, becomes
`queued` when an approver types the host, and `rejected` (refused or withdrawn) or `expired` (24 h) otherwise.
Accessibility and security checks never use the new values.

One exploratory session at a time per project, guaranteed by the database: a partial unique index on
`quality_scans (project_id)` where `kind = 'exploratory'` and `status` is `queued` or `running` (SQLite and
PostgreSQL both support partial indexes). Two concurrent starts or approvals can't both commit; the loser gets 409.
No exploratory session could be created before this revision, so no existing rows can conflict.

Downgrade: drops the index; sessions in the three new statuses never contacted the site and become `cancelled` (the
Phase 6.0 CHECK can't hold them). Their approvals are kept. Tested up/down/up in
tests/integration/test_p6_exploratory.py::test_migration_0021_up_down_up.

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-17 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0021'
down_revision: str | None = '0020'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD = ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')
_NEW = (*_OLD, 'awaiting_approval', 'rejected', 'expired')
ONE_ACTIVE = 'uq_quality_scans_one_active_exploration'
_WHERE = "kind = 'exploratory' AND status IN ('queued', 'running')"


def _enum(values: tuple[str, ...]) -> sa.Enum:
    return sa.Enum(*values, name='quality_scan_status', native_enum=False, create_constraint=True, length=32)


def upgrade() -> None:
    # Batch mode recreates the table on SQLite; its other CHECK constraints and foreign keys are carried over by
    # reflection.
    with op.batch_alter_table('quality_scans', schema=None) as batch_op:
        batch_op.alter_column('status', existing_type=_enum(_OLD), type_=_enum(_NEW), existing_nullable=False)
    op.create_index(ONE_ACTIVE, 'quality_scans', ['project_id'], unique=True,
                    sqlite_where=sa.text(_WHERE), postgresql_where=sa.text(_WHERE))  # fmt: skip


def downgrade() -> None:
    op.drop_index(ONE_ACTIVE, table_name='quality_scans')
    op.execute("UPDATE quality_scans SET status = 'cancelled' "
               "WHERE status IN ('awaiting_approval', 'rejected', 'expired')")
    with op.batch_alter_table('quality_scans', schema=None) as batch_op:
        batch_op.alter_column('status', existing_type=_enum(_NEW), type_=_enum(_OLD), existing_nullable=False)
