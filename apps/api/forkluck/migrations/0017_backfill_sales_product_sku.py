from django.db import migrations


def copy_product_skus(apps, schema_editor):
    """Every product SKU becomes that product's own x1 row."""
    SalesProduct = apps.get_model("forkluck", "SalesProduct")
    SalesProductSku = apps.get_model("forkluck", "SalesProductSku")
    SalesProductSku.objects.bulk_create(
        SalesProductSku(
            user_id=product.user_id,
            product_id=product.id,
            sku=product.sku,
            normalized_sku=product.normalized_sku,
            position=0,
        )
        for product in SalesProduct.objects.exclude(sku="").iterator()
    )


def copy_back(apps, schema_editor):
    SalesProductSku = apps.get_model("forkluck", "SalesProductSku")
    for row in SalesProductSku.objects.filter(quantity_multiplier=1).iterator():
        row.product.sku = row.sku
        row.product.normalized_sku = row.normalized_sku
        row.product.save(update_fields=["sku", "normalized_sku"])


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0016_sales_product_sku"),
    ]

    operations = [
        migrations.RunPython(copy_product_skus, copy_back),
    ]
