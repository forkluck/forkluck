from django.db import migrations

from ..domains.shared.supplier_import import supplier_item_key

BATCH = 2000


def backfill_item_keys(apps, schema_editor):
    """Key every stored line the way `supplier_item_key` keys a new one.

    The rule is not an indexable SQL expression (the description key folds
    accents and collapses punctuation), so the column is filled row by row in
    batches rather than by one UPDATE.
    """
    InvoiceLine = apps.get_model("forkluck", "InvoiceLine")
    rows = InvoiceLine.objects.filter(item_key="").only("id", "sku", "description")
    batch: list = []
    for row in rows.iterator(chunk_size=BATCH):
        row.item_key = supplier_item_key(row.sku, row.description)
        batch.append(row)
        if len(batch) >= BATCH:
            InvoiceLine.objects.bulk_update(batch, ["item_key"])
            batch = []
    if batch:
        InvoiceLine.objects.bulk_update(batch, ["item_key"])


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0027_invoice_line_item_key"),
    ]

    operations = [
        migrations.RunPython(backfill_item_keys, migrations.RunPython.noop),
    ]
