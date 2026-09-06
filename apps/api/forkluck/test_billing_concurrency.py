"""PostgreSQL row-lock and generation-fence coverage for billing."""

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.test import TransactionTestCase, override_settings

from .domains.accounts.billing import _claim_webhook_event, _reserve_checkout
from .domains.accounts.billing_reconciliation import reconcile_billing_account
from .models import (
    BillingAccount,
    StripeCheckoutAttempt,
    StripeCustomer,
    StripeWebhookEvent,
    User,
)


@unittest.skipUnless(
    connection.vendor == "postgresql",
    "Billing concurrency assertions need PostgreSQL row-lock semantics",
)
@override_settings(STRIPE_PRODUCT_ID="prod_forkluck")
class BillingConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="billing-race@example.com",
            name="Billing Race",
            password="a-long-test-passphrase-2468",
        )
        self.account = BillingAccount.objects.create(user=self.user)

    def _thread(self, function):
        close_old_connections()
        try:
            return function()
        finally:
            close_old_connections()

    def test_concurrent_checkout_reservations_share_one_command_identity(self):
        release_first = threading.Event()
        first_reserved = threading.Event()

        def reserve_first():
            attempt = _reserve_checkout(self.user, self.account)
            first_reserved.set()
            if not release_first.wait(timeout=5):
                raise AssertionError("Second reservation did not start")
            return attempt.pk

        def reserve_second():
            if not first_reserved.wait(timeout=5):
                raise AssertionError("First reservation did not complete")
            try:
                return _reserve_checkout(self.user, self.account).pk
            finally:
                release_first.set()

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self._thread, reserve_first)
            second = executor.submit(self._thread, reserve_second)
            first_id = first.result(timeout=10)
            second_id = second.result(timeout=10)

        self.assertEqual(first_id, second_id)
        self.assertEqual(StripeCheckoutAttempt.objects.count(), 1)

    def test_newer_reconciliation_wins_when_older_provider_read_finishes_last(self):
        old_read_started = threading.Event()
        release_old_read = threading.Event()
        calls_lock = threading.Lock()
        calls = 0

        provider_customer = {
            "id": "cus_race",
            "livemode": False,
            "created": 100,
            "metadata": {"forkluck_user_id": str(self.user.pk)},
        }
        StripeCustomer.objects.create(
            account=self.account,
            stripe_customer_id="cus_race",
            creation_idempotency_key="known-race",
        )

        def subscription(status: str) -> dict:
            return {
                "id": f"sub_{status}",
                "status": status,
                "livemode": False,
                "created": 100,
                "trial_end": None,
                "cancel_at_period_end": False,
                "items": {
                    "data": [
                        {
                            "current_period_end": 200,
                            "price": {
                                "id": "price_forkluck",
                                "product": "prod_forkluck",
                            },
                        }
                    ]
                },
            }

        def snapshots(_account):
            nonlocal calls
            with calls_lock:
                calls += 1
                call = calls
            if call == 1:
                old_read_started.set()
                if not release_old_read.wait(timeout=5):
                    raise AssertionError("New reconciliation did not complete")
                return [(provider_customer, [subscription("canceled")])]
            return [(provider_customer, [subscription("active")])]

        def run_old():
            return reconcile_billing_account(self.account)

        with patch(
            "forkluck.domains.accounts.billing_reconciliation._customer_snapshots",
            snapshots,
        ):
            with ThreadPoolExecutor(max_workers=1) as executor:
                old = executor.submit(self._thread, run_old)
                self.assertTrue(old_read_started.wait(timeout=5))
                self.assertTrue(reconcile_billing_account(self.account))
                release_old_read.set()
                self.assertFalse(old.result(timeout=5))

        self.account.refresh_from_db()
        self.assertEqual(self.account.status, "active")
        self.assertFalse(self.account.locked)
        self.assertEqual(self.account.reconcile_generation, 2)

    def test_only_one_worker_can_hold_a_webhook_processing_lease(self):
        row = StripeWebhookEvent.objects.create(
            event_id="evt_race",
            event_type="customer.subscription.updated",
        )
        start = threading.Barrier(2)

        def claim():
            start.wait(timeout=5)
            current = StripeWebhookEvent.objects.get(pk=row.pk)
            return _claim_webhook_event(current)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [
                future.result(timeout=5)
                for future in (
                    executor.submit(self._thread, claim),
                    executor.submit(self._thread, claim),
                )
            ]

        self.assertCountEqual(results, ["claimed", "busy"])
