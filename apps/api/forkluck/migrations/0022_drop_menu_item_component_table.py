from django.db import migrations
from django.db.migrations.loader import MigrationLoader


# The last state that still described the component model; 0021 took it out.
BEFORE_REMOVAL = ("forkluck", "0020_backfill_menu_item_recipe")


def _component_model():
    return MigrationLoader(None).project_state(BEFORE_REMOVAL).apps.get_model(
        "forkluck", "MenuItemComponent"
    )


def drop_component_table(apps, schema_editor):
    schema_editor.delete_model(_component_model())


def create_component_table(apps, schema_editor):
    schema_editor.create_model(_component_model())


class Migration(migrations.Migration):
    """Drop the menu component table, one release after 0021 retired it."""

    dependencies = [
        ("forkluck", "0021_remove_menu_item_component_state"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(drop_component_table, create_component_table),
            ],
            state_operations=[],
        ),
    ]
