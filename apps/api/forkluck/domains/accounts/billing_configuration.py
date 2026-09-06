"""Live Stripe configuration validation and local secret attestation."""

import hashlib
import hmac
from dataclasses import dataclass

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from ...integrations import stripe
from ...integrations.stripe import StripeError
from ...models import StripeBillingConfiguration

EXPECTED_PRICE_CENTS = 700
EXPECTED_CURRENCY = "usd"
EXPECTED_WEBHOOK_EVENTS = {
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
}


class BillingNotReady(ValueError):
    """The hosted Stripe objects or current local secrets are not ready."""


@dataclass(frozen=True)
class LiveStripeProductConfiguration:
    stripe_account_id: str
    price_id: str
    product_id: str
    livemode: bool


@dataclass(frozen=True)
class LiveStripeConfiguration(LiveStripeProductConfiguration):
    webhook_endpoint_id: str


def _secret_digest(value: str) -> str:
    return hmac.new(
        settings.SECRET_KEY.encode(), value.encode(), hashlib.sha256
    ).hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BillingNotReady(message)


def read_live_product_configuration() -> LiveStripeProductConfiguration:
    """Validate the account, product, and price used by Checkout."""

    price_id = settings.STRIPE_PRICE_ID
    product_id = settings.STRIPE_PRODUCT_ID
    try:
        account = stripe.retrieve_account()
        price = stripe.retrieve_price(price_id)
        product = stripe.retrieve_product(product_id)
    except StripeError as exc:
        raise BillingNotReady(
            "Stripe billing configuration could not be verified."
        ) from exc

    livemode = bool(price.get("livemode"))
    recurring = price.get("recurring") or {}
    price_product = price.get("product")
    if isinstance(price_product, dict):
        price_product = price_product.get("id")
    _require(price.get("id") == price_id, "The configured Stripe price was not found.")
    _require(bool(price.get("active")), "The configured Stripe price is inactive.")
    _require(
        price_product == product_id,
        "The Stripe price belongs to another product.",
    )
    _require(
        price.get("currency") == EXPECTED_CURRENCY,
        "The Stripe price must be in USD.",
    )
    _require(
        price.get("unit_amount") == EXPECTED_PRICE_CENTS,
        "The Stripe price must be $7.00.",
    )
    _require(price.get("type") == "recurring", "The Stripe price must be recurring.")
    _require(
        recurring.get("interval") == "month",
        "The Stripe price must recur monthly.",
    )
    _require(
        recurring.get("interval_count") == 1,
        "The Stripe price interval must be one month.",
    )
    _require(
        recurring.get("usage_type") == "licensed",
        "The Stripe price must be licensed.",
    )
    _require(
        product.get("id") == product_id,
        "The configured Stripe product was not found.",
    )
    _require(bool(product.get("active")), "The configured Stripe product is inactive.")
    _require(
        bool(product.get("livemode")) == livemode,
        "Stripe product and price modes differ.",
    )
    account_id = str(account.get("id") or "")
    _require(bool(account_id), "The Stripe account identity could not be verified.")
    return LiveStripeProductConfiguration(
        stripe_account_id=account_id,
        price_id=price_id,
        product_id=product_id,
        livemode=livemode,
    )


def validate_live_webhook_endpoint(
    endpoint: dict, *, endpoint_id: str, livemode: bool
) -> None:
    """Validate one endpoint against the exact public billing contract."""

    expected_url = settings.FORKLUCK_APP_ORIGIN + "/api/billing/stripe-webhook"
    _require(
        endpoint.get("id") == endpoint_id,
        "The Stripe webhook endpoint was not found.",
    )
    _require(endpoint.get("url") == expected_url, "The Stripe webhook URL is incorrect.")
    _require(
        endpoint.get("status") == "enabled",
        "The Stripe webhook endpoint is disabled.",
    )
    _require(
        bool(endpoint.get("livemode")) == livemode,
        "Stripe webhook and price modes differ.",
    )
    _require(
        endpoint.get("api_version") == stripe.STRIPE_VERSION,
        "The Stripe webhook API version is incorrect.",
    )
    _require(
        set(endpoint.get("enabled_events") or []) == EXPECTED_WEBHOOK_EVENTS,
        "The Stripe webhook event subscriptions are incorrect.",
    )


def read_live_configuration() -> LiveStripeConfiguration:
    product = read_live_product_configuration()
    endpoint_id = settings.STRIPE_WEBHOOK_ENDPOINT_ID
    try:
        endpoint = stripe.retrieve_webhook_endpoint(endpoint_id)
    except StripeError as exc:
        raise BillingNotReady(
            "Stripe billing configuration could not be verified."
        ) from exc
    validate_live_webhook_endpoint(
        endpoint,
        endpoint_id=endpoint_id,
        livemode=product.livemode,
    )
    return LiveStripeConfiguration(
        stripe_account_id=product.stripe_account_id,
        price_id=product.price_id,
        product_id=product.product_id,
        webhook_endpoint_id=endpoint_id,
        livemode=product.livemode,
    )


def _local_matches(row: StripeBillingConfiguration, *, livemode: bool) -> bool:
    return bool(
        row.stripe_account_id
        and row.price_id == settings.STRIPE_PRICE_ID
        and row.product_id == settings.STRIPE_PRODUCT_ID
        and row.webhook_endpoint_id == settings.STRIPE_WEBHOOK_ENDPOINT_ID
        and row.api_version == stripe.STRIPE_VERSION
        and row.livemode == livemode
        and hmac.compare_digest(
            row.api_secret_digest, _secret_digest(settings.STRIPE_SECRET_KEY)
        )
        and hmac.compare_digest(
            row.webhook_secret_digest,
            _secret_digest(settings.STRIPE_WEBHOOK_SECRET),
        )
    )


def persist_configuration(
    live: LiveStripeConfiguration,
    *,
    webhook_secret: str | None = None,
    webhook_secret_verified: bool = False,
) -> StripeBillingConfiguration:
    """Commit provider facts after their HTTP reads, preserving valid proof only."""

    api_digest = _secret_digest(settings.STRIPE_SECRET_KEY)
    secret = (
        settings.STRIPE_WEBHOOK_SECRET
        if webhook_secret is None
        else webhook_secret
    )
    webhook_digest = _secret_digest(secret)
    with transaction.atomic():
        current = (
            StripeBillingConfiguration.objects.select_for_update()
            .filter(pk=1)
            .first()
        )
        proof = webhook_secret_verified
        if current is not None and current.webhook_secret_verified:
            proof = proof or bool(
                current.stripe_account_id == live.stripe_account_id
                and current.webhook_endpoint_id == live.webhook_endpoint_id
                and current.livemode == live.livemode
                and hmac.compare_digest(
                    current.webhook_secret_digest, webhook_digest
                )
            )
        row, _ = StripeBillingConfiguration.objects.update_or_create(
            pk=1,
            defaults={
                "stripe_account_id": live.stripe_account_id,
                "price_id": live.price_id,
                "product_id": live.product_id,
                "webhook_endpoint_id": live.webhook_endpoint_id,
                "api_version": stripe.STRIPE_VERSION,
                "livemode": live.livemode,
                "api_secret_digest": api_digest,
                "webhook_secret_digest": webhook_digest,
                "webhook_secret_verified": proof,
                "validated_at": timezone.now(),
            },
        )
    return row


def validate_stripe_billing(
    *, persist: bool, require_webhook_verified: bool
) -> LiveStripeConfiguration:
    live = read_live_configuration()
    if not persist:
        return live
    row = persist_configuration(live)
    if require_webhook_verified and not row.webhook_secret_verified:
        raise BillingNotReady(
            "The Stripe webhook secret has not passed a signed delivery."
        )
    return live


def assert_checkout_ready() -> None:
    row = StripeBillingConfiguration.objects.filter(pk=1).first()
    if (
        row is None
        or not _local_matches(row, livemode=row.livemode)
        or not row.webhook_secret_verified
    ):
        raise BillingNotReady("Stripe billing is not ready for Checkout.")


def mark_current_webhook_secret_verified(*, livemode: bool) -> None:
    with transaction.atomic():
        row = StripeBillingConfiguration.objects.select_for_update().filter(pk=1).first()
        if row is None or not _local_matches(row, livemode=livemode):
            raise BillingNotReady("The signed delivery does not match local billing.")
        if not row.webhook_secret_verified:
            row.webhook_secret_verified = True
            row.save(update_fields=["webhook_secret_verified", "updated_at"])
