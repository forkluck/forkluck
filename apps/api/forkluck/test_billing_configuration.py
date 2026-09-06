"""Exact Stripe object validation and safe provisioning behavior."""

import io
import stat
import tempfile
import urllib.error
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from .domains.accounts.billing_configuration import (
    BillingNotReady,
    LiveStripeConfiguration,
    LiveStripeProductConfiguration,
    assert_checkout_ready,
    mark_current_webhook_secret_verified,
    persist_configuration,
    read_live_configuration,
)
from .integrations import stripe
from .integrations.stripe import StripeError
from .models import StripeBillingConfiguration


PRODUCT_ID = "prod_forkluck"
PRICE_ID = "price_forkluck"
ENDPOINT_ID = "we_forkluck"
CONFIGURED = override_settings(
    SECRET_KEY="django-secret-for-digests",
    FORKLUCK_APP_ORIGIN="https://app.forkluck.com",
    STRIPE_SECRET_KEY="sk_live_forkluck",
    STRIPE_WEBHOOK_SECRET="whsec_forkluck",
    STRIPE_PRICE_ID=PRICE_ID,
    STRIPE_PRODUCT_ID=PRODUCT_ID,
    STRIPE_WEBHOOK_ENDPOINT_ID=ENDPOINT_ID,
    STRIPE_BILLING_ENABLED=True,
)


def account() -> dict:
    return {"id": "acct_forkluck"}


def product() -> dict:
    return {"id": PRODUCT_ID, "active": True, "livemode": True}


def price() -> dict:
    return {
        "id": PRICE_ID,
        "active": True,
        "livemode": True,
        "product": PRODUCT_ID,
        "currency": "usd",
        "unit_amount": 700,
        "type": "recurring",
        "recurring": {
            "interval": "month",
            "interval_count": 1,
            "usage_type": "licensed",
        },
    }


def endpoint(*, secret: str | None = None) -> dict:
    value = {
        "id": ENDPOINT_ID,
        "url": "https://app.forkluck.com/api/billing/stripe-webhook",
        "status": "enabled",
        "livemode": True,
        "api_version": stripe.STRIPE_VERSION,
        "enabled_events": [
            "checkout.session.completed",
            "customer.subscription.created",
            "customer.subscription.updated",
            "customer.subscription.deleted",
        ],
    }
    if secret is not None:
        value["secret"] = secret
    return value


def live() -> LiveStripeConfiguration:
    return LiveStripeConfiguration(
        stripe_account_id="acct_forkluck",
        price_id=PRICE_ID,
        product_id=PRODUCT_ID,
        webhook_endpoint_id=ENDPOINT_ID,
        livemode=True,
    )


@CONFIGURED
class StripeConfigurationTests(TestCase):
    @patch("forkluck.integrations.stripe.retrieve_webhook_endpoint")
    @patch("forkluck.integrations.stripe.retrieve_product")
    @patch("forkluck.integrations.stripe.retrieve_price")
    @patch("forkluck.integrations.stripe.retrieve_account")
    def test_exact_current_configuration_passes(
        self, retrieve_account, retrieve_price, retrieve_product, retrieve_endpoint
    ):
        retrieve_account.return_value = account()
        retrieve_price.return_value = price()
        retrieve_product.return_value = product()
        retrieve_endpoint.return_value = endpoint()

        self.assertEqual(read_live_configuration(), live())

    @patch("forkluck.integrations.stripe.retrieve_webhook_endpoint")
    @patch("forkluck.integrations.stripe.retrieve_product")
    @patch("forkluck.integrations.stripe.retrieve_price")
    @patch("forkluck.integrations.stripe.retrieve_account")
    def test_every_material_price_and_endpoint_drift_is_rejected(
        self, retrieve_account, retrieve_price, retrieve_product, retrieve_endpoint
    ):
        retrieve_account.return_value = account()
        cases = [
            ("inactive price", {**price(), "active": False}, product(), endpoint()),
            ("wrong amount", {**price(), "unit_amount": 600}, product(), endpoint()),
            ("wrong currency", {**price(), "currency": "eur"}, product(), endpoint()),
            (
                "wrong cadence",
                {**price(), "recurring": {**price()["recurring"], "interval": "year"}},
                product(),
                endpoint(),
            ),
            ("wrong product", {**price(), "product": "prod_other"}, product(), endpoint()),
            ("inactive product", price(), {**product(), "active": False}, endpoint()),
            ("wrong url", price(), product(), {**endpoint(), "url": "https://wrong"}),
            ("disabled endpoint", price(), product(), {**endpoint(), "status": "disabled"}),
            (
                "wrong version",
                price(),
                product(),
                {**endpoint(), "api_version": "2024-01-01"},
            ),
            (
                "wrong events",
                price(),
                product(),
                {**endpoint(), "enabled_events": ["checkout.session.completed"]},
            ),
            ("mode mismatch", price(), product(), {**endpoint(), "livemode": False}),
        ]
        for label, price_value, product_value, endpoint_value in cases:
            with self.subTest(label=label):
                retrieve_price.return_value = price_value
                retrieve_product.return_value = product_value
                retrieve_endpoint.return_value = endpoint_value
                with self.assertRaises(BillingNotReady):
                    read_live_configuration()

    def test_checkout_requires_matching_secrets_and_signed_delivery_proof(self):
        persist_configuration(live())
        with self.assertRaises(BillingNotReady):
            assert_checkout_ready()

        mark_current_webhook_secret_verified(livemode=True)
        assert_checkout_ready()

        with override_settings(STRIPE_WEBHOOK_SECRET="whsec_rotated"):
            with self.assertRaises(BillingNotReady):
                assert_checkout_ready()
        with override_settings(STRIPE_PRICE_ID="price_rotated"):
            with self.assertRaises(BillingNotReady):
                assert_checkout_ready()

    @patch(
        "forkluck.domains.accounts.billing_configuration.read_live_configuration",
        return_value=live(),
    )
    def test_deploy_bootstrap_allows_pending_proof_once(self, read_configuration):
        call_command(
            "validate_stripe_billing",
            "--bootstrap-pending-webhook-secret",
            stdout=io.StringIO(),
        )
        with self.assertRaises(CommandError):
            call_command(
                "validate_stripe_billing",
                "--bootstrap-pending-webhook-secret",
                stdout=io.StringIO(),
            )

        mark_current_webhook_secret_verified(livemode=True)
        call_command(
            "validate_stripe_billing",
            "--bootstrap-pending-webhook-secret",
            stdout=io.StringIO(),
        )

    @patch(
        "forkluck.domains.accounts.billing_configuration.read_live_configuration",
        return_value=live(),
    )
    def test_provider_preflight_does_not_touch_billing_tables(
        self, read_configuration
    ):
        with self.assertNumQueries(0):
            call_command(
                "validate_stripe_billing",
                "--preflight",
                stdout=io.StringIO(),
            )

    @patch("forkluck.integrations.stripe.create_webhook_endpoint")
    @patch("forkluck.integrations.stripe.list_webhook_endpoints", return_value=[])
    @patch(
        "forkluck.management.commands.provision_stripe_billing.read_live_product_configuration"
    )
    def test_provision_creates_exact_endpoint_and_exclusive_env_file(
        self, read_product, list_endpoints, create_endpoint
    ):
        read_product.return_value = LiveStripeProductConfiguration(
            stripe_account_id="acct_forkluck",
            price_id=PRICE_ID,
            product_id=PRODUCT_ID,
            livemode=True,
        )
        create_endpoint.return_value = endpoint(secret="whsec_new")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stripe.env"
            call_command(
                "provision_stripe_billing",
                "--output-env",
                str(output),
                stdout=io.StringIO(),
            )
            contents = output.read_text(encoding="utf-8")
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertIn("STRIPE_WEBHOOK_SECRET=whsec_new\n", contents)
            self.assertIn(f"STRIPE_WEBHOOK_ENDPOINT_ID={ENDPOINT_ID}\n", contents)
            with self.assertRaises(CommandError):
                call_command(
                    "provision_stripe_billing",
                    "--output-env",
                    str(output),
                    stdout=io.StringIO(),
                )

        create_endpoint.assert_called_once_with(
            "https://app.forkluck.com/api/billing/stripe-webhook",
            sorted(
                {
                    "checkout.session.completed",
                    "customer.subscription.created",
                    "customer.subscription.updated",
                    "customer.subscription.deleted",
                }
            ),
            idempotency_key=create_endpoint.call_args.kwargs["idempotency_key"],
        )
        self.assertTrue(
            StripeBillingConfiguration.objects.get(pk=1).webhook_secret_verified
        )

    @patch("forkluck.integrations.stripe.list_webhook_endpoints")
    @patch(
        "forkluck.management.commands.provision_stripe_billing.read_live_product_configuration"
    )
    def test_provision_refuses_to_duplicate_the_public_url(
        self, read_product, list_endpoints
    ):
        read_product.return_value = LiveStripeProductConfiguration(
            "acct_forkluck", PRICE_ID, PRODUCT_ID, True
        )
        list_endpoints.return_value = [endpoint()]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stripe.env"
            with self.assertRaises(CommandError):
                call_command(
                    "provision_stripe_billing",
                    "--output-env",
                    str(output),
                    stdout=io.StringIO(),
                )
            self.assertFalse(output.exists())

    @patch("forkluck.integrations.stripe.delete_webhook_endpoint")
    @patch("forkluck.integrations.stripe.create_webhook_endpoint")
    @patch("forkluck.integrations.stripe.list_webhook_endpoints", return_value=[])
    @patch(
        "forkluck.management.commands.provision_stripe_billing.read_live_product_configuration"
    )
    def test_provision_does_not_remove_a_destination_created_by_a_racer(
        self, read_product, list_endpoints, create_endpoint, delete_endpoint
    ):
        read_product.return_value = LiveStripeProductConfiguration(
            "acct_forkluck", PRICE_ID, PRODUCT_ID, True
        )
        create_endpoint.return_value = endpoint(secret="whsec_new")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stripe.env"

            def race(*args, **kwargs):
                output.write_text("owned-by-another-process\n", encoding="utf-8")
                raise CommandError(f"Refusing to overwrite existing file: {output}")

            with patch(
                "forkluck.management.commands.provision_stripe_billing.Command._write_env",
                side_effect=race,
            ):
                with self.assertRaises(CommandError):
                    call_command(
                        "provision_stripe_billing",
                        "--output-env",
                        str(output),
                        stdout=io.StringIO(),
                    )

            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "owned-by-another-process\n",
            )
        delete_endpoint.assert_called_once_with(ENDPOINT_ID)


@override_settings(STRIPE_SECRET_KEY="sk_live_dont_log")
class StripeClientTests(TestCase):
    @patch("urllib.request.urlopen", side_effect=TimeoutError)
    def test_socket_timeout_uses_the_safe_transport_error(self, urlopen):
        with self.assertRaisesMessage(StripeError, "Stripe could not be reached"):
            stripe.retrieve_account()

    @patch("urllib.request.urlopen")
    def test_provider_error_logs_only_status_and_safe_code(self, urlopen):
        body = io.BytesIO(
            b'{"error":{"code":"resource_missing","message":"card secret"}}'
        )
        urlopen.side_effect = urllib.error.HTTPError(
            "https://api.stripe.com/v1/account", 404, "Not found", {}, body
        )
        with self.assertLogs("forkluck.integrations.stripe", "WARNING") as logs:
            with self.assertRaises(StripeError):
                stripe.retrieve_account()
        joined = " ".join(logs.output)
        self.assertIn("status=404", joined)
        self.assertIn("code=resource_missing", joined)
        self.assertNotIn("card secret", joined)
        self.assertNotIn("sk_live_dont_log", joined)

    @patch("forkluck.integrations.stripe._request")
    def test_object_ids_are_url_encoded_before_provider_requests(self, request):
        stripe.retrieve_customer("cus/../../subscriptions")
        self.assertEqual(
            request.call_args.args,
            ("GET", "/v1/customers/cus%2F..%2F..%2Fsubscriptions"),
        )

    @patch("forkluck.integrations.stripe._request")
    def test_subscription_lists_follow_every_provider_page(self, request):
        request.side_effect = [
            {"data": [{"id": "sub_1"}], "has_more": True},
            {"data": [{"id": "sub_2"}], "has_more": False},
        ]

        self.assertEqual(
            [row["id"] for row in stripe.list_subscriptions("cus_1")],
            ["sub_1", "sub_2"],
        )
        self.assertEqual(request.call_args_list[1].args[2]["starting_after"], "sub_1")

    @patch("forkluck.integrations.stripe._request")
    def test_customer_search_follows_opaque_search_pages(self, request):
        request.side_effect = [
            {"data": [{"id": "cus_1"}], "next_page": "page_2"},
            {"data": [{"id": "cus_2"}]},
        ]

        self.assertEqual(
            [row["id"] for row in stripe.search_customers("user-1")],
            ["cus_1", "cus_2"],
        )
        self.assertEqual(request.call_args_list[1].args[2]["page"], "page_2")
