import django.db.models.deletion
from django.db import migrations, models
from django.db.models import F, Q


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0011_rename_listing_fields_to_variant"),
    ]

    operations = [
        # The target check grows a third arm, so it is dropped and rebuilt
        # under the same name rather than renamed.
        migrations.RemoveConstraint(
            model_name="salesproductcomponent",
            name="sales_product_component_target_and_unit",
        ),
        migrations.AddField(
            model_name="salesproductcomponent",
            name="component_product",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="bundle_components",
                to="forkluck.salesproduct",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.UniqueConstraint(
                condition=Q(component_product__isnull=False),
                fields=("product", "component_product"),
                name="sales_product_component_product_unique",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.CheckConstraint(
                condition=(
                    Q(
                        component_product__isnull=True,
                        ingredient__isnull=True,
                        recipe__isnull=False,
                        unit="",
                    )
                    | Q(
                        component_product__isnull=True,
                        ingredient__isnull=False,
                        recipe__isnull=True,
                    )
                    & ~Q(unit="")
                    | Q(
                        component_product__isnull=False,
                        ingredient__isnull=True,
                        recipe__isnull=True,
                        unit="",
                    )
                ),
                name="sales_product_component_target_and_unit",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.CheckConstraint(
                condition=~Q(component_product=F("product")),
                name="sales_product_component_not_self",
            ),
        ),
    ]
