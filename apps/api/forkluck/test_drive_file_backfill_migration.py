"""0033 seeds the Drive registry from what the workspace already knew.

The skip list and the invoices imported from Drive are the two states the
registry replaces, and a file can be on both — that collision is the reason
this is a migration test rather than a reading of the code.
"""

from datetime import date

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class DriveFileBackfillMigrationTests(TransactionTestCase):
    migrate_from = ("forkluck", "0033_drive_file_registry")
    migrate_to = ("forkluck", "0034_backfill_drive_files")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        Invoice = apps.get_model("forkluck", "Invoice")
        DriveFileSkip = apps.get_model("forkluck", "DriveFileSkip")
        user = User.objects.create(
            email="drive-migration@example.com",
            name="Migration",
            password="!",
            first_name="",
            last_name="",
        )
        DriveFileSkip.objects.create(
            user=user, drive_file_id="skipped", file_name="photo.heic", reason="heic"
        )
        # Skipped first, then imported anyway: the import is the later word.
        DriveFileSkip.objects.create(
            user=user, drive_file_id="both", file_name="early.pdf", reason=""
        )
        self.invoice_id = Invoice.objects.create(
            user=user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            invoice_date=date(2026, 8, 14),
            total_cents=1000,
            source_fingerprint="drive-migration-fp",
            file_name="harbor.pdf",
            drive_file_id="both",
            drive_web_view_link="https://drive.example/both",
        ).pk
        # An invoice that was uploaded rather than pulled out of Drive.
        Invoice.objects.create(
            user=user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            invoice_date=date(2026, 8, 15),
            total_cents=2000,
            source_fingerprint="upload-fp",
            file_name="uploaded.pdf",
        )
        self.user_id = user.pk

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        # 0034 retires the skip model from the state only, so its table and
        # the foreign key to the user outlive this test; empty it first or the
        # flush that follows is refused on SQLite.
        apps = executor.loader.project_state([self.migrate_to]).apps
        apps.get_model("forkluck", "DriveFileSkip").objects.all().delete()
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_skips_and_drive_invoices_become_registry_rows(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        DriveFile = apps.get_model("forkluck", "DriveFile")

        rows = {
            row.drive_file_id: row
            for row in DriveFile.objects.filter(user_id=self.user_id)
        }
        self.assertEqual(sorted(rows), ["both", "skipped"])
        self.assertEqual(rows["skipped"].status, "skipped")
        self.assertEqual(rows["skipped"].name, "photo.heic")
        self.assertEqual(rows["skipped"].reason, "heic")
        self.assertIsNone(rows["skipped"].invoice_id)

        # Imported wins over the earlier skip, and carries the invoice with it.
        self.assertEqual(rows["both"].status, "imported")
        self.assertEqual(rows["both"].invoice_id, self.invoice_id)
        self.assertEqual(rows["both"].name, "harbor.pdf")
        self.assertEqual(rows["both"].web_view_link, "https://drive.example/both")
        self.assertIsNotNone(rows["both"].seen_at)
