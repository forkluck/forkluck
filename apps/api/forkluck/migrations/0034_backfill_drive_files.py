from django.db import migrations
from django.utils import timezone

BATCH = 2000


def backfill_drive_files(apps, schema_editor):
    """Seed the registry from what the workspace already knew about Drive.

    Two sources, both keyed on (user, drive_file_id): the skip list becomes
    skipped rows, and every invoice imported from Drive becomes an imported
    row. Imported wins when a file is on both lists — a document that was
    skipped and later imported anyway is imported.
    """
    DriveFileSkip = apps.get_model("forkluck", "DriveFileSkip")
    DriveFile = apps.get_model("forkluck", "DriveFile")
    Invoice = apps.get_model("forkluck", "Invoice")
    now = timezone.now()

    rows: dict[tuple[int, str], object] = {}
    skips = DriveFileSkip.objects.all().only(
        "user_id", "drive_file_id", "file_name", "reason"
    )
    for skip in skips.iterator(chunk_size=BATCH):
        rows[(skip.user_id, skip.drive_file_id)] = DriveFile(
            user_id=skip.user_id,
            drive_file_id=skip.drive_file_id,
            name=skip.file_name,
            status="skipped",
            reason=skip.reason,
            seen_at=now,
        )

    invoices = (
        Invoice.objects.exclude(drive_file_id="")
        .only("id", "user_id", "drive_file_id", "file_name", "drive_web_view_link")
        .order_by("created_at")
    )
    for invoice in invoices.iterator(chunk_size=BATCH):
        rows[(invoice.user_id, invoice.drive_file_id)] = DriveFile(
            user_id=invoice.user_id,
            drive_file_id=invoice.drive_file_id,
            name=invoice.file_name or invoice.drive_file_id,
            web_view_link=invoice.drive_web_view_link,
            status="imported",
            invoice_id=invoice.id,
            seen_at=now,
        )

    batch = list(rows.values())
    for start in range(0, len(batch), BATCH):
        DriveFile.objects.bulk_create(batch[start : start + BATCH])


class Migration(migrations.Migration):
    dependencies = [
        ("forkluck", "0033_drive_file_registry"),
    ]

    operations = [
        migrations.RunPython(backfill_drive_files, migrations.RunPython.noop),
    ]
