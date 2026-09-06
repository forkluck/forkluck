from django.db import migrations


def backfill_invoice_prices(apps, schema_editor):
    InvoiceLine = apps.get_model("forkluck", "InvoiceLine")
    IngredientInvoicePrice = apps.get_model("forkluck", "IngredientInvoicePrice")

    rows = []
    for line in InvoiceLine.objects.filter(ingredient_id__isnull=False).select_related(
        "supplier_item", "invoice"
    ):
        # Credits were never eligible ingredient prices. Historical manual
        # links may still have classified such a line, so do not turn it into
        # a selectable costing reference during the backfill.
        source_cost = (
            line.unit_price_cents
            if line.unit_price_cents is not None
            else line.line_amount_cents
        )
        if source_cost < 0:
            continue
        item = line.supplier_item
        size = item.pack_amount if item is not None else None
        unit = item.pack_unit if item is not None else ""
        rows.append(
            IngredientInvoicePrice(
                user_id=line.user_id,
                ingredient_id=line.ingredient_id,
                invoice_line_id=line.id,
                ingredient_import_id=(
                    line.invoice.ingredient_import_id if line.price_updated else None
                ),
                purchase_size=size,
                purchase_unit=unit,
            )
        )
    IngredientInvoicePrice.objects.bulk_create(rows, ignore_conflicts=True)


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0047_ingredient_invoice_price"),
    ]

    operations = [
        migrations.RunPython(backfill_invoice_prices, migrations.RunPython.noop),
    ]
