from django.db import migrations, models


MEMBER_TABLE = "forkluck_salesvariantmember"


def drop_member_foreign_keys(apps, schema_editor):
    """Cut the member table loose from the tables it points at.

    Django no longer knows this table, so a `TRUNCATE` of the tables it still
    references — a test flush, say — is refused by PostgreSQL for as long as
    the constraints stand. Losing them also makes 0015's `DROP TABLE` trivial.
    SQLite has none to drop.
    """
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND contype = 'f'",
            [MEMBER_TABLE],
        )
        names = [name for (name,) in cursor.fetchall()]
    for name in names:
        schema_editor.execute(
            f'ALTER TABLE "{MEMBER_TABLE}" DROP CONSTRAINT "{name}"'
        )


class Migration(migrations.Migration):
    """Retire `kind` and the member table from the code, not yet from the DB.

    Dropping a column is destructive, so it ships one release after the code
    stops naming it (AGENTS.md, Migrations). The two `kind` constraints go for
    real: after 0013 every variant is direct with a product, so nothing
    violates them and the old code still writing `kind='direct'` cannot
    either. The database default is what keeps the rollout window alive — the
    new code's INSERTs no longer mention `kind`, and the column is NOT NULL.
    """

    dependencies = [
        ("forkluck", "0013_backfill_bundle_products"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="salesproductvariant",
            name="sales_variant_kind_product_shape",
        ),
        migrations.RemoveConstraint(
            model_name="salesproductvariant",
            name="sales_variant_modifier_not_assorted",
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.AlterField(
                    model_name="salesproductvariant",
                    name="kind",
                    field=models.CharField(
                        choices=[("direct", "Direct"), ("assorted", "Assorted")],
                        db_default="direct",
                        default="direct",
                        max_length=16,
                    ),
                ),
            ],
            state_operations=[
                migrations.RemoveField(
                    model_name="salesproductvariant",
                    name="kind",
                ),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name="SalesVariantMember"),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    drop_member_foreign_keys,
                    migrations.RunPython.noop,
                ),
            ],
            state_operations=[],
        ),
    ]
