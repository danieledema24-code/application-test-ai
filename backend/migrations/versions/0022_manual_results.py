"""manual_results (P4-14a, decisions D38-D40): results recorded by hand count as execution evidence

`execution_runs.status` CHECK gains `recording`: a manual run (`mode = 'manual'`) is created `recording` and stays so
until a member finishes it. It is never `running`, so it never blocks an automated run or a load test (both refuse to
start beside a `running` execution run). New columns on `execution_results`: `recorded_by` (FK users, nullable; set
on every result a person recorded), `notes` (text, nullable) and `recorded_at` (nullable; the time a person last saved
the result, which decides the latest result: results are edited in place until their run is finished). `manual_retests` (0020) is not changed: it is frozen
and read as legacy (D39).

Batch mode recreates both tables on SQLite (their other CHECK constraints and foreign keys are carried over by
reflection); on PostgreSQL the same operations are plain ALTERs.

Downgrade: `recording` runs become `cancelled` (their saved results stay); the three columns are dropped. Tested
up/down/up in tests/integration/test_p4_14_manual_results.py::test_migration_0022_up_down_up.

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-19 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.db.types  # noqa: F401 - custom column types

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD = ("awaiting_authorisation", "rejected", "queued", "running", "passed", "failed", "error", "cancelled")
_NEW = (*_OLD, "recording")
_FK = "fk_execution_results_recorded_by_users"
_IX = "ix_execution_results_recorded_by"


def _enum(values: tuple[str, ...]) -> sa.Enum:
    return sa.Enum(*values, name="execution_run_status", native_enum=False, create_constraint=True, length=32)


def upgrade() -> None:
    with op.batch_alter_table("execution_runs", schema=None) as batch_op:
        batch_op.alter_column("status", existing_type=_enum(_OLD), type_=_enum(_NEW), existing_nullable=False)
    with op.batch_alter_table("execution_results", schema=None) as batch_op:
        batch_op.add_column(sa.Column("recorded_by", sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column("notes", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("recorded_at", app.db.types.UTCDateTime(timezone=True), nullable=True))
        batch_op.create_index(_IX, ["recorded_by"], unique=False)
        batch_op.create_foreign_key(_FK, "users", ["recorded_by"], ["id"], ondelete="RESTRICT")


def downgrade() -> None:
    op.execute(
        "UPDATE execution_runs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE status = 'recording'"
    )
    with op.batch_alter_table("execution_results", schema=None) as batch_op:
        batch_op.drop_constraint(_FK, type_="foreignkey")
        batch_op.drop_index(_IX)
        batch_op.drop_column("recorded_at")
        batch_op.drop_column("notes")
        batch_op.drop_column("recorded_by")
    with op.batch_alter_table("execution_runs", schema=None) as batch_op:
        batch_op.alter_column("status", existing_type=_enum(_NEW), type_=_enum(_OLD), existing_nullable=False)
