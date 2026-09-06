import uuid
from decimal import Decimal

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """The SKU table. 0017 copies each product's SKU in, 0018 drops the columns."""

    dependencies = [
        ("forkluck", "0015_drop_variant_kind_and_member_table"),
    ]

    operations = [
        migrations.CreateModel(
            name="SalesProductSku",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("sku", models.CharField(max_length=120)),
                ("normalized_sku", models.CharField(max_length=120)),
                (
                    "quantity_multiplier",
                    models.DecimalField(
                        decimal_places=3, default=Decimal("1"), max_digits=12
                    ),
                ),
                ("position", models.PositiveIntegerField(default=0)),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="skus",
                        to="forkluck.salesproduct",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sales_product_skus",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["position"],
            },
        ),
        migrations.AddConstraint(
            model_name="salesproductsku",
            constraint=models.UniqueConstraint(
                fields=("user", "normalized_sku"), name="sales_product_sku_unique"
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductsku",
            constraint=models.CheckConstraint(
                condition=models.Q(("quantity_multiplier__gt", 0)),
                name="sales_product_sku_multiplier_positive",
            ),
        ),
    ]
