from django.db import migrations


class Migration(migrations.Migration):
    """Retire `sku` and `normalized_sku` from the product: the table is the truth.

    The columns go in the same release as the code that stops naming them
    rather than one later (AGENTS.md, Migrations) because they were created
    without a database default, so a state-only removal would leave the new
    code's INSERTs failing on NOT NULL.
    """

    dependencies = [
        ("forkluck", "0017_backfill_sales_product_sku"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="salesproduct",
            name="sales_product_user_normalized_sku_unique",
        ),
        migrations.RemoveField(model_name="salesproduct", name="normalized_sku"),
        migrations.RemoveField(model_name="salesproduct", name="sku"),
    ]
