from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0005_harden_sales_product_identity"),
    ]

    operations = [
        # RenameModel renames the existing table in place. No rows or primary
        # keys are copied, so legacy recipe links keep their identity.
        migrations.RenameModel(
            old_name="SalesProductRecipe",
            new_name="SalesProductComponent",
        ),
        migrations.AlterModelOptions(
            name="salesproductcomponent",
            options={"ordering": ["position", "created_at"]},
        ),
        migrations.RemoveConstraint(
            model_name="salesproductcomponent",
            name="sales_product_recipe_unique",
        ),
        migrations.RemoveConstraint(
            model_name="salesproductcomponent",
            name="sales_product_recipe_quantity_positive",
        ),
        migrations.AlterField(
            model_name="salesproductcomponent",
            name="product",
            field=models.ForeignKey(
                on_delete=models.CASCADE,
                related_name="components",
                to="forkluck.salesproduct",
            ),
        ),
        migrations.AlterField(
            model_name="salesproductcomponent",
            name="recipe",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.PROTECT,
                related_name="sales_product_components",
                to="forkluck.recipe",
            ),
        ),
        migrations.AddField(
            model_name="salesproductcomponent",
            name="position",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="salesproductcomponent",
            name="ingredient",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.PROTECT,
                related_name="sales_product_components",
                to="forkluck.ingredient",
            ),
        ),
        migrations.AddField(
            model_name="salesproductcomponent",
            name="unit",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AlterField(
            model_name="salesproductcomponent",
            name="quantity",
            field=models.DecimalField(decimal_places=3, max_digits=12),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.UniqueConstraint(
                condition=Q(recipe__isnull=False),
                fields=("product", "recipe"),
                name="sales_product_component_recipe_unique",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.UniqueConstraint(
                condition=Q(ingredient__isnull=False),
                fields=("product", "ingredient"),
                name="sales_product_component_ingredient_unique",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.CheckConstraint(
                condition=Q(quantity__gt=0),
                name="sales_product_component_quantity_positive",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesproductcomponent",
            constraint=models.CheckConstraint(
                condition=(
                    Q(recipe__isnull=False, ingredient__isnull=True, unit="")
                    | Q(recipe__isnull=True, ingredient__isnull=False)
                    & ~Q(unit="")
                ),
                name="sales_product_component_target_and_unit",
            ),
        ),
    ]
