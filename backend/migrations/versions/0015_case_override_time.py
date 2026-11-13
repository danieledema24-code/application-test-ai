"""test case priority override time

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-13 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.db.types  # noqa: F401 - custom column types


revision: str = '0015'
down_revision: str | None = '0014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A plain ADD/DROP COLUMN: a batch rebuild would have to re-create the table's CHECK constraints.
    op.add_column('test_cases', sa.Column('priority_overridden_at', app.db.types.UTCDateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('test_cases', 'priority_overridden_at')
