"""retention (P5-05c) and the two new report types (P5-04a)

`evidence.purged_at` (the retention job deleted the stored file; metadata and sha256 stay), the owner's scheduled
purge of an archived project (`projects.purge_scheduled_at`, `purge_requested_by`), and the `qa_reports.report_type`
CHECK widened with `accessibility` and `security` (batch mode recreates the table on SQLite).

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-15 09:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.db.types  # noqa: F401 - custom column types

revision: str = '0018'
down_revision: str | None = '0017'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_P4_REPORTS = ('discovery', 'requirements_spec', 'test_strategy', 'test_plan', 'test_case_spec', 'rtm', 'execution',
               'defect', 'performance', 'completion', 'release_readiness')
_P5_REPORTS = (*_P4_REPORTS, 'accessibility', 'security')


def _enum(values: tuple[str, ...]) -> sa.Enum:
    return sa.Enum(*values, name='report_type', native_enum=False, create_constraint=True, length=32)


def upgrade() -> None:
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.add_column(sa.Column('purged_at', app.db.types.UTCDateTime(timezone=True), nullable=True))
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('purge_scheduled_at', app.db.types.UTCDateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('purge_requested_by', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(batch_op.f('fk_projects_purge_requested_by_users'), 'users',
                                    ['purge_requested_by'], ['id'], ondelete='RESTRICT')
    with op.batch_alter_table('qa_reports', schema=None) as batch_op:
        batch_op.alter_column('report_type', existing_type=_enum(_P4_REPORTS), type_=_enum(_P5_REPORTS),
                              existing_nullable=False)


def downgrade() -> None:
    # The two new report types can't exist under the Phase 4 CHECK (downgrade is a development operation); their
    # rendered files stay in storage as orphans.
    op.execute("DELETE FROM qa_reports WHERE report_type IN ('accessibility', 'security')")
    with op.batch_alter_table('qa_reports', schema=None) as batch_op:
        batch_op.alter_column('report_type', existing_type=_enum(_P5_REPORTS), type_=_enum(_P4_REPORTS),
                              existing_nullable=False)
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_constraint(batch_op.f('fk_projects_purge_requested_by_users'), type_='foreignkey')
        batch_op.drop_column('purge_requested_by')
        batch_op.drop_column('purge_scheduled_at')
    with op.batch_alter_table('evidence', schema=None) as batch_op:
        batch_op.drop_column('purged_at')
