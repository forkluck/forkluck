from django.db import migrations
from django.db.migrations.loader import MigrationLoader


# The last state that still described the skip list; 0035 took it out.
BEFORE_REMOVAL = ("forkluck", "0034_backfill_drive_files")


def _skip_model():
    """The model as 0034 left it, so Django writes each vendor's DDL."""
    return MigrationLoader(None).project_state(BEFORE_REMOVAL).apps.get_model(
        "forkluck", "DriveFileSkip"
    )


def drop_skip_table(apps, schema_editor):
    schema_editor.delete_model(_skip_model())


def create_skip_table(apps, schema_editor):
    schema_editor.create_model(_skip_model())


class Migration(migrations.Migration):
    """Drop the Drive skip-list table, one release after 0035 retired it.

    0035 removed it from the model state and cut its foreign keys loose, so no
    running code names it and this is the safe half of the destructive change
    (AGENTS.md, Migrations).
    """

    dependencies = [
        ("forkluck", "0040_invoice_extraction"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(drop_skip_table, create_skip_table),
            ],
            state_operations=[],
        ),
    ]
