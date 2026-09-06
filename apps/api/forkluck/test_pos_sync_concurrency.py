"""PostgreSQL coverage for POS generation fencing across provider I/O."""

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.test import TransactionTestCase

from .domains.sales.pos_sync import sync_connection
from .integrations.pos_oauth import save_connection
from .integrations.pos_sync import (
    NormalizedSalesBatch,
    SquareSalesAdapter,
    SyncFailed,
)
from .integrations.token_crypto import encrypt_token
from .models import SalesChannelConnection, SalesImport, User


@unittest.skipUnless(
    connection.vendor == "postgresql",
    "Generation fencing needs PostgreSQL row-lock semantics",
)
class PosSyncGenerationConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="pos-race@example.com",
            name="POS Race",
            password="a-long-test-passphrase-2468",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider=SalesImport.Channel.SQUARE,
            provider_account_id="M1",
            merchant_id="M1",
            access_token_encrypted=encrypt_token("old-token"),
            location_ids=["L1"],
            location_timezones={"L1": "America/New_York"},
            provider_timezone="America/New_York",
            currency_code="USD",
        )

    def test_reconnect_fences_a_pass_waiting_on_provider_io(self) -> None:
        provider_started = threading.Event()
        release_provider = threading.Event()

        def delayed_acquire(
            adapter,
            *,
            since,
            until,
            backfilling,
            time_budget_s,
        ) -> NormalizedSalesBatch:
            provider_started.set()
            if not release_provider.wait(timeout=5):
                raise AssertionError("Reconnect did not release provider call")
            return NormalizedSalesBatch(
                entries=[],
                pages=1,
                location_ids=["L1"],
                location_timezones={"L1": "America/New_York"},
                session_end=until,
            )

        def run_old_generation():
            close_old_connections()
            try:
                return sync_connection(self.connection)
            except Exception as exc:  # returned for assertion in the main thread
                return exc
            finally:
                close_old_connections()

        with patch.object(SquareSalesAdapter, "_acquire", delayed_acquire):
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(run_old_generation)
                self.assertTrue(provider_started.wait(timeout=5))
                save_connection(
                    self.user,
                    SalesImport.Channel.SQUARE,
                    {
                        "access_token_encrypted": encrypt_token("new-token"),
                        "refresh_token_encrypted": "",
                        "token_expires_at": None,
                        "merchant_id": "M1",
                        "location_ids": ["L1"],
                        "location_timezones": {
                            "L1": "America/New_York"
                        },
                        "scopes": "ORDERS_READ",
                        "provider_timezone": "America/New_York",
                        "currency_code": "USD",
                    },
                )
                release_provider.set()
                result = future.result(timeout=5)

        self.assertIsInstance(result, SyncFailed)
        self.assertIn("changed or was disconnected", str(result))
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.generation, 2)
        self.assertIsNone(self.connection.sync_watermark)
        self.assertIsNone(self.connection.last_synced_at)
        self.assertIsNone(self.connection.sync_lease_token)
        self.assertFalse(self.user.sales_imports.exists())
