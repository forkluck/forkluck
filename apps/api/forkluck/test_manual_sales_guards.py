from __future__ import annotations

import uuid
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from .domains.sales.core import (
    action_record_manual_sales,
    action_save_sales_product,
    action_undo_sales_import,
    menu_overview_payload,
    sales_imports_payload,
)
from .domains.sales.pos_sync import recover_stale_sync_runs, sync_product_catalog
from .models import (
    BenchCostSettings,
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    SyncRun,
    User,
)


class EmptyProviderCatalog:
    def product_catalog_items(self, *, deadline=None):
        return []


class ManualSalesGuardsTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="manual-guards@example.com",
            name="Manual Guard Chef",
            password="a-long-test-passphrase-2468",
        )
        BenchCostSettings.objects.create(
            user=self.user,
            timezone="America/New_York",
            currency_code="USD",
        )
        self.product = SalesProduct.objects.create(
            user=self.user,
            name="Manual Cookie",
            normalized_name="manual cookie",
        )
        self.manual_result = action_record_manual_sales(
            self.user,
            {
                "productId": str(self.product.id),
                "soldOn": "2026-03-08",
                "quantity": 7,
            },
        )
        self.manual_import = SalesImport.objects.get(
            user=self.user,
            channel=SalesImport.Channel.MANUAL,
        )
        self.manual_variant = SalesProductVariant.objects.get(
            user=self.user,
            channel=SalesImport.Channel.MANUAL,
            product=self.product,
        )
        self.manual_line = SalesLine.objects.get(
            user=self.user,
            channel=SalesImport.Channel.MANUAL,
        )

    def provider_connection(self) -> SalesChannelConnection:
        return SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            merchant_id="M1",
            access_token_encrypted="unused-in-test",
            provider_timezone="UTC",
            currency_code="USD",
        )

    def test_manual_import_and_variant_are_absent_from_provider_reads(self):
        imports = sales_imports_payload(self.user)["items"]
        self.assertNotIn(
            str(self.manual_import.id),
            {row["id"] for row in imports},
        )

        review = menu_overview_payload(self.user, sections=["review"])["review"]
        self.assertNotIn(
            SalesImport.Channel.MANUAL,
            {row["channel"] for row in review["items"]},
        )
        self.assertNotIn(
            self.manual_variant.match_key,
            {row["match_key"] for row in review["items"]},
        )

    def test_generic_undo_explicitly_refuses_manual_import(self):
        with self.assertRaisesMessage(
            ValueError, "Manual sales imports cannot be undone"
        ):
            action_undo_sales_import(
                self.user,
                {"id": str(self.manual_import.id)},
            )

        self.manual_import.refresh_from_db()
        self.manual_line.refresh_from_db()
        self.assertIsNone(self.manual_import.undone_at)
        self.assertEqual(self.manual_line.quantity, 7)
        self.assertEqual(self.manual_result["netProvided"], False)

    def test_provider_catalog_deactivation_cannot_touch_manual_rows(self):
        connection = self.provider_connection()
        stale_provider_item = SalesCatalogItem.objects.create(
            user=self.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id=connection.provider_account_id,
            match_key="square:item:stale",
            external_object_id="stale",
            item_name="Stale provider item",
            last_seen_at=timezone.now(),
            is_active=True,
        )

        sync_product_catalog(connection, adapter=EmptyProviderCatalog())

        stale_provider_item.refresh_from_db()
        self.manual_import.refresh_from_db()
        self.manual_variant.refresh_from_db()
        self.manual_line.refresh_from_db()
        self.assertFalse(stale_provider_item.is_active)
        self.assertEqual(self.manual_variant.channel, SalesImport.Channel.MANUAL)
        self.assertEqual(
            self.manual_variant.link_source,
            SalesProductVariant.LinkSource.SYSTEM,
        )
        self.assertIsNone(self.manual_import.undone_at)
        self.assertEqual(self.manual_line.quantity, 7)

    def test_stale_provider_recovery_cannot_touch_manual_rows(self):
        connection = self.provider_connection()
        stale_at = timezone.now() - timedelta(minutes=20)
        run = SyncRun.objects.create(
            user=self.user,
            connection=connection,
            provider=connection.provider,
            provider_account_id=connection.provider_account_id,
            connection_generation=connection.generation,
            status=SyncRun.Status.RUNNING,
            attempts=1,
            claim_token=uuid.uuid4(),
            heartbeat_at=stale_at,
        )

        self.assertEqual(
            recover_stale_sync_runs(now=timezone.now()),
            1,
        )

        run.refresh_from_db()
        self.manual_import.refresh_from_db()
        self.manual_variant.refresh_from_db()
        self.manual_line.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.QUEUED)
        self.assertIsNone(self.manual_import.undone_at)
        self.assertEqual(self.manual_variant.channel, SalesImport.Channel.MANUAL)
        self.assertEqual(
            self.manual_variant.link_source,
            SalesProductVariant.LinkSource.SYSTEM,
        )
        self.assertEqual(self.manual_line.quantity, 7)

    def test_product_save_preserves_hidden_manual_variant(self):
        action_save_sales_product(
            self.user,
            {
                "id": self.product.public_id,
                "expectedEditVersion": self.product.edit_version,
                "name": "Renamed manual cookie",
                "variants": [],
            },
        )
        self.assertTrue(
            SalesProductVariant.objects.filter(
                user=self.user,
                product=self.product,
                channel=SalesImport.Channel.MANUAL,
                link_source=SalesProductVariant.LinkSource.SYSTEM,
            ).exists()
        )
