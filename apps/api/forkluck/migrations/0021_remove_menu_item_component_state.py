from django.db import migrations


COMPONENT_TABLE = "forkluck_menuitemcomponent"


def drop_component_foreign_keys(apps, schema_editor):
    """Cut the orphan table loose, as 0014 did for the member table: Django
    no longer knows it, and a TRUNCATE of what it points at is refused while
    its constraints stand. SQLite has none to drop."""
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND contype = 'f'",
            [COMPONENT_TABLE],
        )
        names = [name for (name,) in cursor.fetchall()]
    for name in names:
        schema_editor.execute(
            f'ALTER TABLE "{COMPONENT_TABLE}" DROP CONSTRAINT "{name}"'
        )


class Migration(migrations.Migration):
    """Retire menu components from the code, not yet from the database.

    A menu item is a link to a recipe or a product and never a composition of
    its own. The table drop ships one release later (AGENTS.md, Migrations).
    """

    dependencies = [
        ("forkluck", "0020_backfill_menu_item_recipe"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.DeleteModel(name="MenuItemComponent"),
            ],
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    drop_component_foreign_keys,
                    migrations.RunPython.noop,
                ),
            ],
            state_operations=[],
        ),
    ]
