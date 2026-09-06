"""Validate the live Stripe objects and the local webhook-secret proof."""

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from forkluck.domains.accounts.billing_configuration import (
    BillingNotReady,
    validate_stripe_billing,
)
from forkluck.models import StripeBillingConfiguration


class Command(BaseCommand):
    help = "Validate the exact Stripe product, price, endpoint, mode, and secret proof."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--preflight",
            action="store_true",
            help="Perform provider reads only; do not read or write billing tables.",
        )
        parser.add_argument(
            "--bootstrap-pending-webhook-secret",
            action="store_true",
            help=(
                "Allow an unproved secret only while creating the first local "
                "configuration row. Later deploys still require signed proof."
            ),
        )

    def handle(self, *args, **options) -> None:
        configured = [
            settings.STRIPE_SECRET_KEY,
            settings.STRIPE_WEBHOOK_SECRET,
            settings.STRIPE_PRICE_ID,
            settings.STRIPE_PRODUCT_ID,
            settings.STRIPE_WEBHOOK_ENDPOINT_ID,
        ]
        if not any(configured):
            self.stdout.write("Stripe billing is disabled; no configuration to validate.")
            return
        if not all(configured):
            raise CommandError("Stripe billing configuration is incomplete.")
        bootstrap = bool(options["bootstrap_pending_webhook_secret"])
        configuration_existed = bool(
            not options["preflight"]
            and StripeBillingConfiguration.objects.filter(pk=1).exists()
        )
        try:
            live = validate_stripe_billing(
                persist=not options["preflight"],
                require_webhook_verified=not (
                    options["preflight"] or (bootstrap and not configuration_existed)
                ),
            )
        except BillingNotReady as exc:
            raise CommandError(str(exc)) from exc
        mode = "live" if live.livemode else "test"
        scope = "provider preflight" if options["preflight"] else "full attestation"
        self.stdout.write(self.style.SUCCESS(f"Stripe {scope} passed in {mode} mode."))
