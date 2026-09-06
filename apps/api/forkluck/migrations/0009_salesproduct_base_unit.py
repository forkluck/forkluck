import forkluck.units
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0008_payroll_tax_and_unpaid_break"),
    ]

    operations = [
        # Blank reads as "each", so every existing product keeps the meaning
        # it already had and no backfill is needed.
        migrations.AddField(
            model_name="salesproduct",
            name="base_unit",
            field=models.CharField(
                blank=True,
                choices=forkluck.units.product_unit_choices,
                default="",
                max_length=32,
            ),
        ),
    ]
