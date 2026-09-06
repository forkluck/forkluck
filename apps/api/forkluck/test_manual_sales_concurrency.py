"""PostgreSQL serialization coverage for manual Product/day upserts."""

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from django.db import close_old_connections, connection
from django.test import TransactionTestCase

from .domains.sales.core import action_record_manual_sales
from .models import (
    BenchCostSettings,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    User,
)


@unittest.skipUnless(
    connection.vendor == "postgresql",
    "Manual-sales concurrency assertions need PostgreSQL row-lock semantics",
)
class ManualSalesConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="manual-race@example.com",
            password="a-long-test-passphrase-2468",
        )
        BenchCostSettings.objects.create(
            user=self.user, timezone="America/New_York", currency_code="USD"
        )
        self.product = SalesProduct.objects.create(
            user=self.user, name="Race cookie", normalized_name="race cookie"
        )

    def _record(self, start: threading.Barrier) -> dict:
        close_old_connections()
        try:
            user = User.objects.get(pk=self.user.pk)
            start.wait(timeout=5)
            return action_record_manual_sales(
                user,
                {
                    "productId": str(self.product.pk),
                    "soldOn": "2026-07-04",
                    "quantity": 2,
                    "totalNetCents": 900,
                },
            )
        finally:
            close_old_connections()

    def test_same_product_day_is_one_idempotent_ledger_row(self) -> None:
        start = threading.Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as executor:
            receipts = [
                future.result(timeout=10)
                for future in (
                    executor.submit(self._record, start),
                    executor.submit(self._record, start),
                )
            ]

        self.assertEqual(receipts[0]["id"], receipts[1]["id"])
        self.assertEqual(SalesImport.objects.count(), 1)
        self.assertEqual(SalesProductVariant.objects.count(), 1)
        self.assertEqual(SalesLine.objects.count(), 1)
