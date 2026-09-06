import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0018_remove_sales_product_sku_columns"),
    ]

    operations = [
        migrations.AddField(
            model_name="menuitem",
            name="recipe",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="menu_items",
                to="forkluck.recipe",
            ),
        ),
        migrations.AddConstraint(
            model_name="menuitem",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("recipe__isnull", False), ("product__isnull", False), _negated=True
                ),
                name="menu_item_one_link",
            ),
        ),
    ]
