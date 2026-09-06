"""Create or adopt Forkluck's exact Stripe webhook endpoint."""

import hashlib
import os
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from forkluck.domains.accounts.billing_configuration import (
    EXPECTED_WEBHOOK_EVENTS,
    BillingNotReady,
    LiveStripeConfiguration,
    persist_configuration,
    read_live_configuration,
    read_live_product_configuration,
    validate_live_webhook_endpoint,
)
from forkluck.integrations import stripe
from forkluck.integrations.stripe import StripeError
from forkluck.models import StripeBillingConfiguration


class Command(BaseCommand):
    help = "Create or adopt the Stripe webhook endpoint and emit a mode-0600 env file."

    def add_arguments(self, parser) -> None:
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument(
            "--adopt",
            action="store_true",
            help="Adopt the endpoint and secret already supplied in the environment.",
        )
        mode.add_argument(
            "--retire-endpoint",
            metavar="ENDPOINT_ID",
            help="Delete an old endpoint after the replacement has been verified.",
        )
        parser.add_argument(
            "--output-env",
            type=Path,
            help="New file to receive the complete Stripe environment configuration.",
        )

    def handle(self, *args, **options) -> None:
        retirement = options["retire_endpoint"]
        if retirement:
            self._retire(retirement)
            return
        output: Path | None = options["output_env"]
        if output is None:
            raise CommandError("--output-env is required when creating or adopting.")
        if output.exists():
            raise CommandError(f"Refusing to overwrite existing file: {output}")
        if (
            StripeBillingConfiguration._meta.db_table
            not in connection.introspection.table_names()
        ):
            raise CommandError(
                "Run the Stripe billing schema migration before provisioning."
            )
        if not settings.STRIPE_SECRET_KEY:
            raise CommandError("STRIPE_SECRET_KEY is required.")
        if not settings.STRIPE_PRICE_ID or not settings.STRIPE_PRODUCT_ID:
            raise CommandError("STRIPE_PRICE_ID and STRIPE_PRODUCT_ID are required.")
        if options["adopt"]:
            self._adopt(output)
        else:
            self._create(output)

    def _adopt(self, output: Path) -> None:
        if (
            not settings.STRIPE_WEBHOOK_ENDPOINT_ID
            or not settings.STRIPE_WEBHOOK_SECRET
        ):
            raise CommandError(
                "Adoption requires STRIPE_WEBHOOK_ENDPOINT_ID and "
                "STRIPE_WEBHOOK_SECRET in the environment."
            )
        try:
            live = read_live_configuration()
        except BillingNotReady as exc:
            raise CommandError(str(exc)) from exc
        self._write_env(
            output,
            settings.STRIPE_WEBHOOK_ENDPOINT_ID,
            settings.STRIPE_WEBHOOK_SECRET,
        )
        try:
            persist_configuration(live)
        except Exception:
            output.unlink(missing_ok=True)
            raise
        self.stdout.write(
            self.style.WARNING(
                "Endpoint adopted. Checkout remains unavailable until a signed "
                "delivery proves the supplied secret."
            )
        )

    def _create(self, output: Path) -> None:
        created_endpoint_id = ""
        output_written = False
        try:
            product = read_live_product_configuration()
            expected_url = settings.FORKLUCK_APP_ORIGIN + "/api/billing/stripe-webhook"
            collisions = [
                endpoint
                for endpoint in stripe.list_webhook_endpoints()
                if endpoint.get("url") == expected_url
            ]
            if collisions:
                raise CommandError(
                    "A webhook endpoint already uses the Forkluck URL. Supply its "
                    "id and secret in the environment and rerun with --adopt."
                )
            seed = hashlib.sha256(
                f"{product.stripe_account_id}:{expected_url}".encode()
            ).hexdigest()
            endpoint = stripe.create_webhook_endpoint(
                expected_url,
                sorted(EXPECTED_WEBHOOK_EVENTS),
                idempotency_key=f"forkluck.webhook.{seed}",
            )
            created_endpoint_id = str(endpoint.get("id") or "")
            webhook_secret = str(endpoint.get("secret") or "")
            if not created_endpoint_id or not webhook_secret:
                raise BillingNotReady(
                    "Stripe did not return the new endpoint identity and secret."
                )
            validate_live_webhook_endpoint(
                endpoint,
                endpoint_id=created_endpoint_id,
                livemode=product.livemode,
            )
            live = LiveStripeConfiguration(
                stripe_account_id=product.stripe_account_id,
                price_id=product.price_id,
                product_id=product.product_id,
                webhook_endpoint_id=created_endpoint_id,
                livemode=product.livemode,
            )
            self._write_env(output, created_endpoint_id, webhook_secret)
            output_written = True
            persist_configuration(
                live,
                webhook_secret=webhook_secret,
                webhook_secret_verified=True,
            )
        except (BillingNotReady, StripeError) as exc:
            self._cleanup_create(created_endpoint_id, output, output_written)
            raise CommandError(str(exc)) from exc
        except Exception:
            self._cleanup_create(created_endpoint_id, output, output_written)
            raise
        self.stdout.write(
            self.style.SUCCESS(
                f"Stripe webhook provisioned; configuration written to {output}."
            )
        )

    def _cleanup_create(
        self, endpoint_id: str, output: Path, output_written: bool
    ) -> None:
        if output_written:
            output.unlink(missing_ok=True)
        if endpoint_id:
            try:
                stripe.delete_webhook_endpoint(endpoint_id)
            except StripeError:
                self.stderr.write(
                    "Provisioning failed and the new Stripe endpoint could not be retired."
                )

    def _write_env(self, output: Path, endpoint_id: str, webhook_secret: str) -> None:
        values = {
            "STRIPE_SECRET_KEY": settings.STRIPE_SECRET_KEY,
            "STRIPE_WEBHOOK_SECRET": webhook_secret,
            "STRIPE_PRICE_ID": settings.STRIPE_PRICE_ID,
            "STRIPE_PRODUCT_ID": settings.STRIPE_PRODUCT_ID,
            "STRIPE_WEBHOOK_ENDPOINT_ID": endpoint_id,
        }
        if any("\n" in value or "\r" in value for value in values.values()):
            raise CommandError("Stripe configuration values may not contain newlines.")
        try:
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise CommandError(f"Refusing to overwrite existing file: {output}") from exc
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
            for key, value in values.items():
                destination.write(f"{key}={value}\n")

    def _retire(self, endpoint_id: str) -> None:
        if endpoint_id == settings.STRIPE_WEBHOOK_ENDPOINT_ID:
            raise CommandError("Refusing to retire the currently configured endpoint.")
        try:
            endpoints = {
                str(endpoint.get("id") or ""): endpoint
                for endpoint in stripe.list_webhook_endpoints()
            }
            if endpoint_id not in endpoints:
                raise CommandError("Stripe webhook endpoint not found.")
            stripe.delete_webhook_endpoint(endpoint_id)
        except StripeError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(self.style.SUCCESS("Retired the old Stripe webhook endpoint."))
