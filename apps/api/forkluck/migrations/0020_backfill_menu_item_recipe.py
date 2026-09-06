from django.db import migrations


def link_single_recipe_rows(apps, schema_editor):
    """A row whose whole composition was one recipe becomes that recipe's row.

    Anything else without a product (ingredients, several recipes, nothing)
    stays unlinked for the worksheet to show as needing a link.
    """
    MenuItem = apps.get_model("forkluck", "MenuItem")
    for item in MenuItem.objects.filter(product__isnull=True).prefetch_related(
        "components"
    ):
        components = list(item.components.all())
        if len(components) == 1 and components[0].recipe_id is not None:
            item.recipe_id = components[0].recipe_id
            item.save(update_fields=["recipe"])


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0019_menu_item_recipe"),
    ]

    operations = [
        migrations.RunPython(link_single_recipe_rows, migrations.RunPython.noop),
    ]
