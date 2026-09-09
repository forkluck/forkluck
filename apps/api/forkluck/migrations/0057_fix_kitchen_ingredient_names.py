"""Shorten copied catalog names without changing a kitchen's own identities."""

from django.db import migrations
from django.db.models import F
from django.utils import timezone


RENAMES = (
    ("sugar", "Granulated Sugar", "Sugar"),
    ("cheddar", "Cheddar Cheese", "Cheddar"),
    ("mozzarella", "Mozzarella Cheese", "Mozzarella"),
    ("parmesan", "Parmesan Cheese", "Parmesan"),
    ("feta", "Feta Cheese", "Feta"),
    ("ricotta", "Ricotta Cheese", "Ricotta"),
    ("panko", "Panko Breadcrumbs", "Panko"),
)


def rename_copied_ingredients(apps, schema_editor):
    Ingredient = apps.get_model("forkluck", "Ingredient")
    ingredients = Ingredient.objects.using(schema_editor.connection.alias)
    for key, old_name, new_name in RENAMES:
        # These reviewed names are ASCII words, so lowercase is their stored
        # normalization. The shared catalog itself is updated by sync_catalog.
        normalized = new_name.lower()
        occupied = ingredients.filter(normalized_name=normalized).values("user_id")
        ingredients.filter(
            catalog_ingredient__key=key,
            name__iexact=old_name,
            normalized_name=old_name.lower(),
        ).exclude(user_id__in=occupied).update(
            name=new_name,
            normalized_name=normalized,
            edit_version=F("edit_version") + 1,
            updated_at=timezone.now(),
        )


class Migration(migrations.Migration):
    dependencies = [("forkluck", "0056_user_google_subject")]

    operations = [
        migrations.RunPython(rename_copied_ingredients, migrations.RunPython.noop),
    ]
