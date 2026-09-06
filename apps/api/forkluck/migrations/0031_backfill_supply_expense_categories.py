from django.db import migrations

# The two default categories that buy things the kitchen does not eat. A
# workspace created before supplies were costable carries them as plain
# expense categories; both become costable supply categories here.
SUPPLY_NORMALIZED_NAMES = ("packaging", "cleaning supplies")


def mark_supply_categories(apps, schema_editor):
    ExpenseCategory = apps.get_model("forkluck", "ExpenseCategory")
    ExpenseCategory.objects.filter(
        normalized_name__in=SUPPLY_NORMALIZED_NAMES
    ).update(is_supply=True, is_ingredient=True)


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0030_expense_category_is_supply"),
    ]

    operations = [
        migrations.RunPython(mark_supply_categories, migrations.RunPython.noop),
    ]
