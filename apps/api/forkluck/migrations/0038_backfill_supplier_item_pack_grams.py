from django.db import migrations

# Inlined rather than imported from units.py: a migration must keep meaning
# what it meant on the day it ran, whatever the catalog grows into.
WEIGHT_UNITS = ("g", "kg", "oz", "lb")


def null_non_weight_grams(apps, schema_editor):
    """Non-weight packs carried 0 grams as a sentinel while the column was NOT
    NULL; now that null means "no grams", the sentinel would read as a real
    zero-gram cache. Weight packs keep their grams."""
    SupplierItem = apps.get_model("forkluck", "SupplierItem")
    SupplierItem.objects.exclude(pack_unit__in=WEIGHT_UNITS).filter(
        pack_grams=0
    ).update(pack_grams=None)


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0037_supplier_item_pack_grams_nullable"),
    ]

    operations = [
        migrations.RunPython(null_non_weight_grams, migrations.RunPython.noop),
    ]
