from django.db import migrations
from django.db.migrations.loader import MigrationLoader


VARIANT_TABLE = "forkluck_salesproductvariant"
# The last state that still described the member model; 0014 took it out.
BEFORE_REMOVAL = ("forkluck", "0013_backfill_bundle_products")


def _member_model():
    """The member model as 0013 left it, so Django writes each vendor's DDL."""
    return MigrationLoader(None).project_state(BEFORE_REMOVAL).apps.get_model(
        "forkluck", "SalesVariantMember"
    )


def drop_member_table(apps, schema_editor):
    schema_editor.delete_model(_member_model())


def create_member_table(apps, schema_editor):
    schema_editor.create_model(_member_model())


class Migration(migrations.Migration):
    """Drop `kind` and the member table from the database, one release after 0014.

    0014 retired both from the models, so no running code still names them and
    this is the safe half of the destructive change (AGENTS.md, Migrations).
    The column goes in raw SQL because PostgreSQL and the bundled SQLite 3.35+
    spell `DROP COLUMN` the same way, while the member table's `CREATE` does
    not spell the same on both and so is left to the schema editor.
    """

    dependencies = [
        ("forkluck", "0014_remove_variant_kind_and_member_state"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(drop_member_table, create_member_table),
                migrations.RunSQL(
                    sql=f'ALTER TABLE "{VARIANT_TABLE}" DROP COLUMN "kind";',
                    reverse_sql=(
                        f'ALTER TABLE "{VARIANT_TABLE}" '
                        "ADD COLUMN \"kind\" varchar(16) DEFAULT 'direct' NOT NULL;"
                    ),
                ),
            ],
            state_operations=[],
        ),
    ]
