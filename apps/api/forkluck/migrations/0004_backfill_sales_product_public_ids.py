import hashlib

from django.db import migrations


ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def _encode(prefix: str, value: int) -> str:
    chars = []
    for _ in range(12):
        chars.append(ALPHABET[value & 31])
        value >>= 5
    return f"{prefix}_{''.join(reversed(chars))}"


def _deterministic_id(value, attempt: int = 0) -> str:
    if attempt == 0:
        # Match derive_public_id_from_uuid("prd", uuid) without importing the
        # live model into a historical migration.
        number = value.int >> (128 - 5 * 12)
    else:
        digest = hashlib.sha256(f"{value}:{attempt}".encode()).digest()
        number = int.from_bytes(digest[:8], "big") >> 4
    return _encode("prd", number)


def backfill_sales_product_public_ids(apps, schema_editor):
    SalesProduct = apps.get_model("forkluck", "SalesProduct")
    used = set(
        SalesProduct.objects.exclude(public_id__isnull=True).values_list(
            "public_id", flat=True
        )
    )
    for row in SalesProduct.objects.filter(public_id__isnull=True).order_by("id"):
        attempt = 0
        public_id = _deterministic_id(row.id, attempt)
        while public_id in used:
            attempt += 1
            public_id = _deterministic_id(row.id, attempt)
        SalesProduct.objects.filter(pk=row.pk, public_id__isnull=True).update(
            public_id=public_id
        )
        used.add(public_id)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0003_sales_product_identity"),
    ]

    operations = [
        migrations.RunPython(backfill_sales_product_public_ids, noop),
    ]
