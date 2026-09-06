from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0006_sales_product_component"),
    ]

    operations = [
        migrations.AlterField(
            model_name="saleschannellisting",
            name="channel",
            field=models.CharField(
                choices=[
                    ("square", "Square"),
                    ("shopify", "Shopify"),
                    ("manual", "Manual"),
                ],
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="saleschannellisting",
            name="link_source",
            field=models.CharField(
                choices=[
                    ("manual", "Chosen by the merchant"),
                    ("auto_sku", "Matched automatically on SKU"),
                    ("system", "System"),
                ],
                default="manual",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="salesimport",
            name="channel",
            field=models.CharField(
                choices=[
                    ("square", "Square"),
                    ("shopify", "Shopify"),
                    ("manual", "Manual"),
                ],
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="salesimport",
            name="source",
            field=models.CharField(
                choices=[
                    ("csv", "CSV"),
                    ("api", "API"),
                    ("manual", "Manual"),
                ],
                default="csv",
                max_length=8,
            ),
        ),
        migrations.AlterField(
            model_name="salesline",
            name="channel",
            field=models.CharField(
                choices=[
                    ("square", "Square"),
                    ("shopify", "Shopify"),
                    ("manual", "Manual"),
                ],
                max_length=16,
            ),
        ),
        migrations.AddConstraint(
            model_name="saleschannellisting",
            constraint=models.UniqueConstraint(
                condition=models.Q(("channel", "manual"), ("product__isnull", False)),
                fields=("user", "product"),
                name="sales_listing_one_manual_product",
            ),
        ),
        migrations.AddConstraint(
            model_name="salesimport",
            constraint=models.UniqueConstraint(
                condition=models.Q(
                    ("channel", "manual"),
                    ("period_start__isnull", False),
                    ("source", "manual"),
                ),
                fields=("user", "channel", "period_start"),
                name="sales_manual_import_user_month_unique",
            ),
        ),
    ]
