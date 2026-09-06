import hashlib

from django.db import migrations


def fix_receipt_fingerprints(apps, schema_editor):
    Invoice = apps.get_model("forkluck", "Invoice")

    rows = Invoice.objects.filter(document_type="receipt").only(
        "id",
        "supplier",
        "invoice_number",
        "invoice_date",
        "total_cents",
        "source_fingerprint",
    )
    for row in rows.iterator():
        key = (
            f"r|{row.supplier.strip().lower()}|{row.invoice_number.strip().lower()}|"
            f"{row.invoice_date.isoformat() if row.invoice_date else ''}|"
            f"{row.total_cents}"
        )
        fingerprint = hashlib.sha256(key.encode()).hexdigest()
        if row.source_fingerprint != fingerprint:
            Invoice.objects.filter(id=row.id).update(source_fingerprint=fingerprint)


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0048_backfill_ingredient_invoice_prices"),
    ]

    operations = [
        migrations.RunPython(fix_receipt_fingerprints, migrations.RunPython.noop),
    ]
