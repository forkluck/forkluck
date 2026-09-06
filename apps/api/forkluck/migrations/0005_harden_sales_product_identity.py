import forkluck.models
from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0004_backfill_sales_product_public_ids"),
    ]

    operations = [
        migrations.AlterField(
            model_name="salesproduct",
            name="public_id",
            field=models.CharField(
                default=forkluck.models.generate_sales_product_public_id,
                max_length=24,
                unique=True,
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproduct",
            constraint=models.UniqueConstraint(
                condition=~Q(normalized_sku=""),
                fields=("user", "normalized_sku"),
                name="sales_product_user_normalized_sku_unique",
            ),
        ),
    ]
