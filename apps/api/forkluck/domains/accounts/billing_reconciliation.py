"""Account-wide Stripe identity discovery, snapshot commit, and entitlement."""

from datetime import UTC, datetime
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from ...integrations import stripe
from ...models import (
    BillingAccount,
    StripeBillingConfiguration,
    StripeCheckoutAttempt,
    StripeCustomer,
    StripeRetiredCustomer,
    StripeSubscription,
    User,
)

LIVE_STATUS_PRECEDENCE = ("active", "trialing", "past_due")


class BillingIdentityConflict(RuntimeError):
    """A provider identity is already bound to another Forkluck account."""


def assert_customer_not_retired(customer_id: str) -> None:
    if StripeRetiredCustomer.objects.filter(pk=customer_id).exists():
        raise BillingIdentityConflict(
            "A retired Stripe customer cannot be attached to an account."
        )


def _at(epoch_seconds) -> datetime | None:
    if epoch_seconds is None:
        return None
    return datetime.fromtimestamp(int(epoch_seconds), UTC)


def get_billing_account(user: User) -> BillingAccount:
    account, _ = BillingAccount.objects.get_or_create(user=user)
    return account


def _claim_reconciliation(account_id) -> int:
    with transaction.atomic():
        account = BillingAccount.objects.select_for_update().get(pk=account_id)
        account.reconcile_generation += 1
        account.save(update_fields=["reconcile_generation", "updated_at"])
        return account.reconcile_generation


def _customer_snapshots(account: BillingAccount) -> list[tuple[dict, list[dict]]]:
    known_ids = set(
        account.stripe_customers.exclude(stripe_customer_id__isnull=True).values_list(
            "stripe_customer_id", flat=True
        )
    )
    customers: dict[str, dict] = {}
    for customer in stripe.search_customers(account.user_id):
        customer_id = str(customer.get("id") or "")
        metadata = customer.get("metadata") or {}
        if customer_id and metadata.get("forkluck_user_id") == str(account.user_id):
            customers[customer_id] = customer
    for customer_id in known_ids.difference(customers):
        customers[customer_id] = stripe.retrieve_customer(customer_id)

    return [
        (customer, stripe.list_subscriptions(customer_id))
        for customer_id, customer in sorted(customers.items())
    ]


def _subscription_product_price_period(
    subscription: dict,
) -> tuple[str, str, datetime | None]:
    items = (subscription.get("items") or {}).get("data") or []
    candidates: list[tuple[str, str, datetime | None]] = []
    for item in items:
        price = item.get("price") or {}
        product = price.get("product")
        product_id = product.get("id") if isinstance(product, dict) else product
        candidates.append(
            (
                str(product_id or ""),
                str(price.get("id") or ""),
                _at(item.get("current_period_end")),
            )
        )
    for product_id, price_id, period_end in candidates:
        if product_id == settings.STRIPE_PRODUCT_ID:
            return product_id, price_id, period_end
    return candidates[0] if candidates else ("", "", None)


def _customer_row(account: BillingAccount, provider: dict) -> StripeCustomer:
    customer_id = str(provider.get("id") or "")
    if not customer_id:
        raise BillingIdentityConflict("Stripe returned a customer without an id.")
    assert_customer_not_retired(customer_id)
    existing = StripeCustomer.objects.filter(stripe_customer_id=customer_id).first()
    if existing is not None:
        if existing.account_id != account.pk:
            raise BillingIdentityConflict(
                "A Stripe customer is already attached to another account."
            )
        return existing

    metadata = provider.get("metadata") or {}
    if str(metadata.get("forkluck_user_id") or "") != str(account.user_id):
        raise BillingIdentityConflict(
            "Stripe customer metadata does not match the billing account."
        )
    customer_ref = str(metadata.get("forkluck_customer_ref") or "")
    placeholder = None
    if customer_ref:
        try:
            placeholder = account.stripe_customers.filter(
                pk=UUID(customer_ref), stripe_customer_id__isnull=True
            ).first()
        except ValueError:
            placeholder = None
    if placeholder is not None:
        placeholder.stripe_customer_id = customer_id
        return placeholder
    raise BillingIdentityConflict(
        "Stripe customer has no matching local customer reservation."
    )


def derive_entitlement(
    subscriptions: list[StripeSubscription], deletion_state: str
) -> tuple[str, datetime | None, bool]:
    """Select one deterministic account state from every Forkluck subscription."""

    if deletion_state != BillingAccount.DeletionState.ACTIVE:
        return "deleting", None, True
    relevant = [
        row
        for row in subscriptions
        if row.provider_present and row.product_id == settings.STRIPE_PRODUCT_ID
    ]
    if not relevant:
        return "none", None, False
    for status in LIVE_STATUS_PRECEDENCE:
        matching = [row for row in relevant if row.status == status]
        if matching:
            trial_end = None
            if status == "trialing":
                ends = [row.trial_end for row in matching if row.trial_end is not None]
                trial_end = max(ends) if ends else None
            return status, trial_end, False
    newest = max(
        relevant,
        key=lambda row: (row.provider_created_at or row.created_at, str(row.pk)),
    )
    return newest.status, None, False


def reconcile_billing_account(account: BillingAccount) -> bool:
    """Fetch outside a transaction, then atomically commit only the newest claim."""

    generation = _claim_reconciliation(account.pk)
    account = BillingAccount.objects.select_related("user").get(pk=account.pk)
    snapshots = _customer_snapshots(account)
    now = timezone.now()

    with transaction.atomic():
        account = BillingAccount.objects.select_for_update().get(pk=account.pk)
        if account.reconcile_generation != generation:
            return False
        expected_livemode = StripeBillingConfiguration.objects.filter(pk=1).values_list(
            "livemode", flat=True
        ).first()

        customer_rows: dict[str, StripeCustomer] = {}
        for provider_customer, subscriptions in snapshots:
            if (
                expected_livemode is not None
                and bool(provider_customer.get("livemode")) != expected_livemode
            ):
                raise BillingIdentityConflict(
                    "Stripe customer and billing configuration modes differ."
                )
            row = _customer_row(account, provider_customer)
            row.livemode = bool(provider_customer.get("livemode"))
            row.provider_created_at = _at(provider_customer.get("created"))
            row.save()
            customer_rows[str(provider_customer["id"])] = row

            seen_subscription_ids: set[str] = set()
            for provider_subscription in subscriptions:
                subscription_id = str(provider_subscription.get("id") or "")
                if not subscription_id:
                    raise BillingIdentityConflict(
                        "Stripe returned a subscription without an id."
                    )
                if bool(provider_subscription.get("livemode")) != row.livemode:
                    raise BillingIdentityConflict(
                        "Stripe customer and subscription modes differ."
                    )
                existing = (
                    StripeSubscription.objects.select_related("customer")
                    .filter(stripe_subscription_id=subscription_id)
                    .first()
                )
                if existing is not None and existing.customer.account_id != account.pk:
                    raise BillingIdentityConflict(
                        "A Stripe subscription is attached to another account."
                    )
                product_id, price_id, period_end = (
                    _subscription_product_price_period(provider_subscription)
                )
                StripeSubscription.objects.update_or_create(
                    stripe_subscription_id=subscription_id,
                    defaults={
                        "customer": row,
                        "status": str(provider_subscription.get("status") or "unknown"),
                        "trial_end": _at(provider_subscription.get("trial_end")),
                        "current_period_end": period_end,
                        "cancel_at_period_end": bool(
                            provider_subscription.get("cancel_at_period_end")
                        ),
                        "price_id": price_id,
                        "product_id": product_id,
                        "livemode": bool(provider_subscription.get("livemode")),
                        "provider_created_at": _at(
                            provider_subscription.get("created")
                        ),
                        "provider_present": True,
                    },
                )
                attempt_id = str(
                    (provider_subscription.get("metadata") or {}).get(
                        "forkluck_checkout_attempt_id"
                    )
                    or ""
                )
                if attempt_id:
                    try:
                        attempt_pk = UUID(attempt_id)
                    except ValueError:
                        attempt_pk = None
                    if attempt_pk is not None:
                        StripeCheckoutAttempt.objects.filter(
                            pk=attempt_pk,
                            account=account,
                            customer=row,
                        ).update(
                            status=StripeCheckoutAttempt.Status.COMPLETED,
                            stripe_subscription_id=subscription_id,
                            updated_at=now,
                        )
                seen_subscription_ids.add(subscription_id)
            missing = row.subscriptions.all()
            if seen_subscription_ids:
                missing = missing.exclude(
                    stripe_subscription_id__in=seen_subscription_ids
                )
            missing.update(provider_present=False, status="missing")

        if customer_rows and not account.stripe_customers.filter(is_primary=True).exists():
            primary = min(
                customer_rows.values(),
                key=lambda row: (
                    row.provider_created_at or row.created_at,
                    str(row.pk),
                ),
            )
            primary.is_primary = True
            primary.save(update_fields=["is_primary", "updated_at"])

        status, trial_end, locked = derive_entitlement(
            list(
                StripeSubscription.objects.filter(
                    customer__account=account
                ).select_related("customer")
            ),
            account.deletion_state,
        )
        account.status = status
        account.locked = locked
        account.trial_end = trial_end
        account.last_reconciled_at = now
        account.save(
            update_fields=[
                "status",
                "locked",
                "trial_end",
                "last_reconciled_at",
                "updated_at",
            ]
        )
    return True


def account_for_provider_customer(customer_id: str) -> BillingAccount | None:
    """Resolve a signed provider customer, adopting only app-written metadata."""

    local = (
        StripeCustomer.objects.select_related("account")
        .filter(stripe_customer_id=customer_id)
        .first()
    )
    if local is not None:
        return local.account
    provider = stripe.retrieve_customer(customer_id)
    metadata = provider.get("metadata") or {}
    user_id = str(metadata.get("forkluck_user_id") or "")
    try:
        user = User.objects.get(pk=UUID(user_id))
    except (User.DoesNotExist, ValueError):
        return None
    account = get_billing_account(user)
    with transaction.atomic():
        account = BillingAccount.objects.select_for_update().get(pk=account.pk)
        row = _customer_row(account, provider)
        row.livemode = bool(provider.get("livemode"))
        row.provider_created_at = _at(provider.get("created"))
        if not account.stripe_customers.filter(is_primary=True).exists():
            row.is_primary = True
        row.save()
    return account
