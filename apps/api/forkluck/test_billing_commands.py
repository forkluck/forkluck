"""Operator reconciliation paths for pre-existing provider identities."""

import io
from datetime import UTC, datetime
from uuid import uuid4
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from .models import (
    StripeBillingConfiguration,
    StripeCustomer,
    StripeRetiredCustomer,
    User,
)


@override_settings(STRIPE_PRODUCT_ID="prod_forkluck")
class ReconcileStripeBillingCommandTests(TestCase):
    def setUp(self) -> None:
        StripeBillingConfiguration.objects.create(
            stripe_account_id="acct_forkluck",
            price_id="price_forkluck",
            product_id="prod_forkluck",
            webhook_endpoint_id="we_forkluck",
            api_version="2025-12-15.clover",
            livemode=True,
            api_secret_digest="digest",
            webhook_secret_digest="digest",
            validated_at=datetime.now(UTC),
        )

    def customer(self, user_id, customer_id="cus_orphan") -> dict:
        return {
            "id": customer_id,
            "livemode": True,
            "created": 1_700_000_000,
            "metadata": {"forkluck_user_id": str(user_id)},
        }

    @patch("forkluck.integrations.stripe.list_open_checkout_sessions", return_value=[])
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.list_customers")
    def test_subscriptionless_orphan_can_only_be_retained_as_a_tombstone(
        self, list_customers, list_subscriptions, list_open_checkout_sessions
    ):
        list_customers.return_value = [self.customer(uuid4())]

        call_command(
            "reconcile_stripe_billing",
            "--inventory-provider",
            "--tombstone-orphans",
            stdout=io.StringIO(),
        )

        self.assertTrue(StripeRetiredCustomer.objects.filter(pk="cus_orphan").exists())

    @patch("forkluck.integrations.stripe.list_customers")
    def test_retired_orphan_is_resolved_on_later_inventory(
        self, list_customers
    ):
        list_customers.return_value = [self.customer(uuid4())]
        StripeRetiredCustomer.objects.create(
            stripe_customer_id="cus_orphan",
            livemode=True,
        )
        output = io.StringIO()

        call_command(
            "reconcile_stripe_billing",
            "--inventory-provider",
            "--fail-on-orphans",
            stdout=output,
        )

        self.assertIn("tagged_customers=1", output.getvalue())
        self.assertIn("unresolved_orphans=0", output.getvalue())

    @patch(
        "forkluck.integrations.stripe.list_open_checkout_sessions",
        return_value=[{"id": "cs_open"}],
    )
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.list_customers")
    def test_orphan_with_open_checkout_cannot_be_tombstoned(
        self, list_customers, list_subscriptions, list_open_checkout_sessions
    ):
        list_customers.return_value = [self.customer(uuid4())]

        with self.assertRaises(CommandError):
            call_command(
                "reconcile_stripe_billing",
                "--inventory-provider",
                "--tombstone-orphans",
                stdout=io.StringIO(),
            )

        self.assertFalse(StripeRetiredCustomer.objects.exists())

    @patch("forkluck.integrations.stripe.list_subscriptions")
    @patch("forkluck.integrations.stripe.list_customers")
    def test_orphan_with_subscription_history_requires_manual_resolution(
        self, list_customers, list_subscriptions
    ):
        list_customers.return_value = [self.customer(uuid4())]
        list_subscriptions.return_value = [{"id": "sub_history"}]

        with self.assertRaises(CommandError):
            call_command(
                "reconcile_stripe_billing",
                "--inventory-provider",
                "--tombstone-orphans",
                stdout=io.StringIO(),
            )
        self.assertFalse(StripeRetiredCustomer.objects.exists())

    @patch("forkluck.integrations.stripe.list_open_checkout_sessions", return_value=[])
    @patch("forkluck.integrations.stripe.list_subscriptions", return_value=[])
    @patch("forkluck.integrations.stripe.search_customers")
    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_explicit_adoption_requires_matching_current_user_metadata(
        self,
        retrieve_customer,
        search_customers,
        list_subscriptions,
        list_open_checkout_sessions,
    ):
        user = User.objects.create_user(email="adopt@example.com")
        provider = self.customer(user.pk, "cus_adopt")
        retrieve_customer.return_value = provider
        search_customers.return_value = [provider]

        call_command(
            "reconcile_stripe_billing",
            "--adopt-customer",
            "cus_adopt",
            "--adopt-user",
            str(user.pk),
            stdout=io.StringIO(),
        )

        row = StripeCustomer.objects.get(stripe_customer_id="cus_adopt")
        self.assertEqual(row.account_id, user.pk)

    @patch(
        "forkluck.integrations.stripe.list_open_checkout_sessions",
        return_value=[{"id": "cs_open"}],
    )
    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_explicit_adoption_rejects_an_open_checkout(
        self, retrieve_customer, list_open_checkout_sessions
    ):
        user = User.objects.create_user(email="adopt-open@example.com")
        retrieve_customer.return_value = self.customer(user.pk, "cus_open")

        with self.assertRaises(CommandError):
            call_command(
                "reconcile_stripe_billing",
                "--adopt-customer",
                "cus_open",
                "--adopt-user",
                str(user.pk),
                stdout=io.StringIO(),
            )

        self.assertFalse(StripeCustomer.objects.exists())

    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_explicit_adoption_rejects_a_metadata_mismatch(self, retrieve_customer):
        user = User.objects.create_user(email="adopt-mismatch@example.com")
        retrieve_customer.return_value = self.customer(uuid4(), "cus_wrong")

        with self.assertRaises(CommandError):
            call_command(
                "reconcile_stripe_billing",
                "--adopt-customer",
                "cus_wrong",
                "--adopt-user",
                str(user.pk),
                stdout=io.StringIO(),
            )
        self.assertFalse(StripeCustomer.objects.exists())

    @patch("forkluck.integrations.stripe.retrieve_customer")
    def test_explicit_adoption_rejects_a_mode_mismatch_before_writing(
        self, retrieve_customer
    ):
        user = User.objects.create_user(email="adopt-mode@example.com")
        retrieve_customer.return_value = {
            **self.customer(user.pk, "cus_test_mode"),
            "livemode": False,
        }

        with self.assertRaises(CommandError):
            call_command(
                "reconcile_stripe_billing",
                "--adopt-customer",
                "cus_test_mode",
                "--adopt-user",
                str(user.pk),
                stdout=io.StringIO(),
            )

        self.assertFalse(StripeCustomer.objects.exists())
