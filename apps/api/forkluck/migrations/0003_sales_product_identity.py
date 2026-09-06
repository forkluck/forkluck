from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0002_recipe_nutrition_package"),
    ]

    operations = [
        migrations.AddField(
            model_name="salesproduct",
            name="edit_version",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="salesproduct",
            name="public_id",
            field=models.CharField(max_length=24, null=True),
        ),
        migrations.AddField(
            model_name="salesproduct",
            name="sku",
            field=models.CharField(blank=True, default="", max_length=120),
        ),
        migrations.AddField(
            model_name="salesproduct",
            name="normalized_sku",
            field=models.CharField(blank=True, default="", max_length=120),
        ),
        migrations.AddField(
            model_name="salesproduct",
            name="description",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="salesproduct",
            name="sell_price_cents",
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name="salesproduct",
            name="category",
            field=models.CharField(blank=True, default="", max_length=120),
        ),
    ]
