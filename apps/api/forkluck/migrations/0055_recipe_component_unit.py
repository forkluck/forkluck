from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0054_feedback_grant"),
    ]

    operations = [
        # A recipe component may now carry a unit: blank still means whole
        # batches per sold unit, a unit means a measured share of the batch.
        # The check is dropped and rebuilt under the same name; existing rows
        # all have a blank unit and stay valid.
        migrations.RemoveConstraint(
            model_name="salesproductcomponent",
            name="sales_product_component_target_and_unit",
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.CheckConstraint(
                condition=(
                    Q(
                        component_product__isnull=True,
                        ingredient__isnull=True,
                        recipe__isnull=False,
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
    ]
