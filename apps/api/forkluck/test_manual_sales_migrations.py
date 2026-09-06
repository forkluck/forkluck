from datetime import date

from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class ManualSalesLedgerMigrationTests(TransactionTestCase):
    migrate_from = ("forkluck", "0006_sales_product_component")
    migrate_to = ("forkluck", "0007_manual_sales_ledger")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        SalesProduct = apps.get_model("forkluck", "SalesProduct")
        SalesImport = apps.get_model("forkluck", "SalesImport")
        SalesChannelListing = apps.get_model("forkluck", "SalesChannelListing")
        user = User.objects.create(
            email="manual-migration@example.com",
            name="Migration",
            password="!",
            first_name="",
            last_name="",
        )
        product = SalesProduct.objects.create(
            user=user,
            name="Migration product",
            normalized_name="migration product",
        )
        SalesImport.objects.create(
            user=user,
            file_name="manual",
            source="manual",
            channel="manual",
            period_start=date(2026, 7, 1),
        )
        SalesChannelListing.objects.create(
            user=user,
            product=product,
            channel="manual",
            provider_account_id="",
            match_key="manual:item:first",
            external_name="Migration product",
        )
        self.user_id = user.pk
        self.product_id = product.pk

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_manual_constraints_are_added_without_provider_choice_leak(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        SalesImport = apps.get_model("forkluck", "SalesImport")
        SalesChannelListing = apps.get_model("forkluck", "SalesChannelListing")
        SalesChannelConnection = apps.get_model("forkluck", "SalesChannelConnection")

        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesImport.objects.create(
                user_id=self.user_id,
                file_name="duplicate",
                source="manual",
                channel="manual",
                period_start=date(2026, 7, 1),
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesChannelListing.objects.create(
                user_id=self.user_id,
                product_id=self.product_id,
                channel="manual",
                provider_account_id="",
                match_key="manual:item:second",
                external_name="Migration product",
            )

        provider_choices = SalesChannelConnection._meta.get_field("provider").choices
        self.assertEqual({value for value, _ in provider_choices}, {"square", "shopify"})
