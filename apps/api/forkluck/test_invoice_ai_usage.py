"""Hosted AI allowance: both entry points spend the same durable budget."""

from datetime import datetime, timezone as dt_timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.test import TransactionTestCase, override_settings

from .domains.invoices.ai_usage import action_invoice_ai_usage, invoice_ai_usage
from .domains.invoices.views import invoices_overview
from .domains.invoices.actions import ensure_expense_categories
from .domains.shared.billing import EntitlementError
from .models import BillingAccount, DriveFolderSource, Invoice, InvoiceAiRead, User
from .testing import InternalApiTestCase, internal_payload


@override_settings(STRIPE_BILLING_ENABLED=True)
class InvoiceAiUsageTests(InternalApiTestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="ai-budget@example.com", name="Chef")
        self.clock = patch(
            "forkluck.domains.invoices.ai_usage.timezone.now",
            return_value=datetime(2026, 12, 31, 23, 59, tzinfo=dt_timezone.utc),
        )
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        self.client.force_login(self.user)

    def reserve(self, pages=1, read_id=None, user=None):
        return action_invoice_ai_usage(
            user or self.user,
            {"operation": "reserve", "pages": pages, "attempts": 2, "readId": read_id},
        )

    def test_tenth_page_is_allowed_and_eleventh_spends_nothing(self):
        self.reserve(9)
        read = self.reserve()
        # Finishing the admitted tenth page still works at the page cap.
        self.reserve(0, read["readId"])
        with self.assertRaises(EntitlementError) as caught:
            self.reserve()
        self.assertEqual(caught.exception.code, "invoice_ai_limit_reached")
        self.assertEqual(
            invoice_ai_usage(self.user),
            {
                "usedPages": 10,
                "maxPages": 10,
                "resetsOn": "2027-01-01",
                "exhausted": True,
            },
        )
        self.assertEqual(InvoiceAiRead.objects.count(), 2)

    def test_a_multi_page_file_is_refused_whole(self):
        self.reserve(9)
        with self.assertRaises(EntitlementError):
            self.reserve(2)
        self.assertEqual(invoice_ai_usage(self.user)["usedPages"], 9)

    def test_retries_and_escalation_spend_attempts_without_recharging_pages(self):
        read = self.reserve()
        for _ in range(39):
            self.reserve(0, read["readId"])
        with self.assertRaises(EntitlementError):
            self.reserve(0, read["readId"])
        row = InvoiceAiRead.objects.get()
        self.assertEqual((row.pages, row.attempts), (1, 80))
        self.assertTrue(invoice_ai_usage(self.user)["exhausted"])

    def test_recording_usage_is_scoped_cumulative_and_cannot_refund(self):
        read = self.reserve()
        body = {"operation": "record", **read, "inputTokens": 123, "outputTokens": 45}
        action_invoice_ai_usage(self.user, body)
        action_invoice_ai_usage(self.user, body)
        action_invoice_ai_usage(
            self.user, {**body, "inputTokens": 1, "outputTokens": 2}
        )
        other = User.objects.create_user(email="other-ai@example.com")
        with self.assertRaises(ValueError):
            action_invoice_ai_usage(other, body)
        with self.assertRaises(ValueError):
            self.reserve(0, read["readId"], other)
        row = InvoiceAiRead.objects.get()
        self.assertEqual(
            (row.pages, row.attempts, row.input_tokens, row.output_tokens),
            (1, 2, 123, 45),
        )

    def test_uploads_and_drive_share_the_owner_budget(self):
        DriveFolderSource.objects.create(
            user=self.user, folder_id="folder", folder_name="Invoices"
        )
        self.reserve(9)
        body = {
            "userId": str(self.user.id),
            "operation": "reserve",
            "pages": 1,
            "attempts": 2,
        }
        self.assertEqual(
            self.post_system("system/invoice-ai-usage/", body).status_code, 200
        )
        refused = self.post_internal("invoice-ai-usage", {**body, "userId": "ignored"})
        self.assertEqual(refused.status_code, 403)
        self.assertEqual(refused.json()["code"], "invoice_ai_limit_reached")
        # A body-supplied owner never redirects a session-scoped action.
        self.assertEqual(invoice_ai_usage(self.user)["usedPages"], 10)

    def test_disconnected_drive_and_locked_workspace_cannot_spend(self):
        body = {
            "userId": str(self.user.id),
            "operation": "reserve",
            "pages": 1,
            "attempts": 2,
        }
        self.assertEqual(
            self.post_system("system/invoice-ai-usage/", body).status_code, 404
        )
        DriveFolderSource.objects.create(
            user=self.user, folder_id="folder", folder_name="Invoices"
        )
        BillingAccount.objects.create(user=self.user, status="active", locked=True)
        self.assertEqual(
            self.post_system("system/invoice-ai-usage/", body).status_code, 403
        )
        self.assertFalse(InvoiceAiRead.objects.exists())

    def test_month_boundary_resets_and_old_reads_cannot_keep_spending(self):
        old = self.reserve(10)
        self.now.return_value = datetime(2027, 1, 1, tzinfo=dt_timezone.utc)
        self.assertEqual(invoice_ai_usage(self.user)["usedPages"], 0)
        with self.assertRaises(EntitlementError):
            self.reserve(0, old["readId"])
        self.reserve(10)
        # A late provider completion can still record last month's usage.
        action_invoice_ai_usage(
            self.user,
            {"operation": "record", **old, "inputTokens": 1, "outputTokens": 2},
        )
        self.assertEqual(InvoiceAiRead.objects.count(), 2)

    def test_upgrade_and_downgrade_preserve_consumption(self):
        self.reserve(10)
        account = BillingAccount.objects.create(user=self.user, status="active")
        self.reserve(90)
        with self.assertRaises(EntitlementError):
            self.reserve()
        account.status = "canceled"
        account.save()
        with self.assertRaises(EntitlementError):
            self.reserve()
        self.assertEqual(invoice_ai_usage(self.user)["usedPages"], 100)

    @override_settings(STRIPE_BILLING_ENABLED=False)
    def test_self_hosted_install_uses_its_own_key_without_a_hosted_quota(self):
        self.assertEqual(self.reserve(200), {"readId": None})
        self.assertFalse(InvoiceAiRead.objects.exists())

    def test_staff_is_exempt(self):
        self.user.is_staff = True
        self.user.save()
        self.assertEqual(self.reserve(200), {"readId": None})

    def test_malformed_reservations_never_write(self):
        for key, value in (
            ("pages", 0),
            ("pages", -1),
            ("pages", True),
            ("pages", "1"),
            ("pages", 201),
            ("attempts", 0),
            ("attempts", 3),
            ("readId", "bad"),
        ):
            with self.subTest(key=key, value=value):
                body = {"operation": "reserve", "pages": 1, "attempts": 2, key: value}
                self.assertEqual(
                    self.post_internal("invoice-ai-usage", body).status_code, 400
                )
        self.assertFalse(InvoiceAiRead.objects.exists())

    def test_deleting_invoices_does_not_refund_ai_and_account_deletion_cascades(self):
        self.reserve(10)
        Invoice.objects.filter(user=self.user).delete()
        with self.assertRaises(EntitlementError):
            self.reserve()
        self.user.delete()
        self.assertFalse(InvoiceAiRead.objects.exists())

    def test_usage_read_has_fixed_query_cost(self):
        for _ in range(10):
            self.reserve()
        with self.assertNumQueries(
            2, msg="One billing lookup and one aggregate, never one query per AI read"
        ):
            invoice_ai_usage(self.user)

    def test_invoices_overview_has_fixed_query_cost(self):
        ensure_expense_categories(self.user)
        with self.assertNumQueries(
            13,
            msg="Overview adds one billing lookup and one AI usage aggregate, independent of invoices",
        ):
            payload = internal_payload(invoices_overview, self.user)
        self.assertEqual(payload["aiUsage"]["maxPages"], 10)


@skipUnless(connection.vendor == "postgresql", "Requires PostgreSQL row locks")
@override_settings(STRIPE_BILLING_ENABLED=True)
class InvoiceAiConcurrencyTests(TransactionTestCase):
    def test_two_readers_cannot_both_spend_the_last_page(self):
        user = User.objects.create_user(email="ai-race@example.com")
        action_invoice_ai_usage(
            user, {"operation": "reserve", "pages": 9, "attempts": 2}
        )
        barrier = Barrier(2)

        def reserve():
            close_old_connections()
            try:
                owner = User.objects.get(pk=user.pk)
                barrier.wait(timeout=5)
                try:
                    action_invoice_ai_usage(
                        owner, {"operation": "reserve", "pages": 1, "attempts": 2}
                    )
                    return True
                except EntitlementError:
                    return False
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: reserve(), range(2)))
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(invoice_ai_usage(user)["usedPages"], 10)
