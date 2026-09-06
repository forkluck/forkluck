from django.db import migrations

SKIP_TABLE = "forkluck_drivefileskip"


def drop_skip_foreign_keys(apps, schema_editor):
    """Cut the orphan table loose, as 0014 and 0021 did: Django no longer
    knows it, and a TRUNCATE of what it points at is refused while its
    constraints stand. SQLite has none to drop."""
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND contype = 'f'",
            [SKIP_TABLE],
        )
        names = [name for (name,) in cursor.fetchall()]
    for name in names:
        schema_editor.execute(f'ALTER TABLE "{SKIP_TABLE}" DROP CONSTRAINT "{name}"')


class Migration(migrations.Migration):
    """Retire the skip list from the code, not yet from the database.

    Skipping is a status on the Drive registry now (0032, 0033 copied the
    rows). The table drop ships one release later (AGENTS.md, Migrations).
    """

    dependencies = [
        ("forkluck", "0034_backfill_drive_files"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name="DriveFileSkip"),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    drop_skip_foreign_keys,
                    migrations.RunPython.noop,
                ),
            ],
            state_operations=[],
        ),
    ]
