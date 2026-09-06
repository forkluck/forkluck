"""Stripe checkout, portal, webhook, and account lifecycle commands."""

import logging
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from ...http.request import error
from ...integrations import stripe
from ...integrations.ghost_members import remove_member
from ...integrations.feedback import remove_feedback_user
from ...integrations.stripe import StripeError
from ...models import (
    BillingAccount,
    StripeCheckoutAttempt,
    StripeCustomer,
    StripeRetiredCustomer,
    StripeSubscription,
    StripeWebhookEvent,
    User,
)
from ..shared.billing import billing_enabled, billing_json, is_paid_status
from ..shared.values import text_value
from .billing_configuration import (
    BillingNotReady,
    assert_checkout_ready,
    mark_current_webhook_secret_verified,
)
from .billing_reconciliation import (
    BillingIdentityConflict,
    account_for_provider_customer,
    assert_customer_not_retired,
    get_billing_account,
    reconcile_billing_account,
)

logger = logging.getLogger(__name__)

JsonObject = dict[str, Any]
WEBHOOK_PROCESSING_LEASE = timedelta(minutes=5)
CANCELLABLE_STATUSES = {
    "active",
    "incomplete",
    "past_due",
    "paused",
    "trialing",
    "unpaid",
}


def _require_enabled() -> None:
    if not billing_enabled():
        raise ValueError("Billing is not enabled on this server.")


def _unreachable(exc: StripeError) -> BillingNotReady:
    logger.warning("Stripe call failed: %s", exc)
    return BillingNotReady("Stripe billing is temporarily unavailable.")


def _session_customer_id(session: dict) -> str:
    return _object_id(session.get("customer"))


def _object_id(value) -> str:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value or "")


def _completed_checkout_is_unresolved(account: BillingAccount) -> bool:
    subscription_ids = set(
        account.checkout_attempts.filter(
            status=StripeCheckoutAttempt.Status.COMPLETED
        ).values_list("stripe_subscription_id", flat=True)
    )
    if not subscription_ids:
        return False
    if None in subscription_ids or "" in subscription_ids:
        return True
    observed_ids = set(
        StripeSubscription.objects.filter(
            customer__account=account,
            stripe_subscription_id__in=subscription_ids,
        ).values_list("stripe_subscription_id", flat=True)
    )
    return observed_ids != subscription_ids


def _reconcile(account: BillingAccount) -> None:
    # A newer concurrent pass is authoritative if it supersedes this one.
    if not reconcile_billing_account(account):
        raise BillingNotReady("Stripe billing is already being refreshed.")


def _reserve_checkout(
    user: User, account: BillingAccount
) -> StripeCheckoutAttempt:
    with transaction.atomic():
        account = BillingAccount.objects.select_for_update().get(pk=account.pk)
        if account.deletion_state != BillingAccount.DeletionState.ACTIVE:
            raise ValueError("This account is being deleted.")
        active = (
            account.checkout_attempts.select_related("customer")
            .filter(
                status__in=[
                    StripeCheckoutAttempt.Status.PENDING,
                    StripeCheckoutAttempt.Status.OPEN,
                ]
            )
            .first()
        )
        if active is not None:
            if not active.with_trial:
                return active
            # Reserved before trials were removed; reusing it would still start
            # one, so it is retired in favour of a fresh attempt.
            StripeCheckoutAttempt.objects.filter(pk=active.pk).update(
                status=StripeCheckoutAttempt.Status.EXPIRED,
                updated_at=timezone.now(),
            )

        customer = (
            account.stripe_customers.order_by("-is_primary", "created_at", "id")
            .first()
        )
        if customer is None:
            customer = StripeCustomer(account=account, is_primary=True)
            customer.creation_idempotency_key = f"forkluck.customer.{customer.id}"
            customer.save()
        if _completed_checkout_is_unresolved(account):
            raise ValueError(
                "Your previous Checkout is still being confirmed. Refresh status."
            )
        return StripeCheckoutAttempt.objects.create(
            account=account,
            customer=customer,
            with_trial=False,
        )


def _ensure_provider_customer(user: User, customer: StripeCustomer) -> StripeCustomer:
    if customer.stripe_customer_id:
        return customer
    provider = stripe.create_customer(
        user.email,
        user.name,
        str(user.id),
        str(customer.id),
        idempotency_key=customer.creation_idempotency_key,
    )
    customer_id = str(provider.get("id") or "")
    if not customer_id:
        raise StripeError("Stripe returned a customer without an id")
    with transaction.atomic():
        current = StripeCustomer.objects.select_for_update().get(pk=customer.pk)
        if current.stripe_customer_id and current.stripe_customer_id != customer_id:
            raise BillingIdentityConflict(
                "The Stripe customer result changed between retries."
            )
        assert_customer_not_retired(customer_id)
        owner = StripeCustomer.objects.filter(stripe_customer_id=customer_id).first()
        if owner is not None and owner.pk != current.pk:
            raise BillingIdentityConflict(
                "A Stripe customer is already attached to another account."
            )
        current.stripe_customer_id = customer_id
        current.livemode = bool(provider.get("livemode"))
        current.save(
            update_fields=["stripe_customer_id", "livemode", "updated_at"]
        )
    return current


def _create_provider_checkout(
    user: User, attempt: StripeCheckoutAttempt
) -> dict:
    customer = _ensure_provider_customer(user, attempt.customer)
    session = stripe.create_checkout_session(
        str(customer.stripe_customer_id),
        settings.FORKLUCK_APP_ORIGIN
        + "/subscribe/complete?session_id={CHECKOUT_SESSION_ID}",
        settings.FORKLUCK_APP_ORIGIN + "/subscribe",
        str(user.id),
        str(attempt.id),
        attempt.with_trial,
        idempotency_key=f"forkluck.checkout.{attempt.id}",
    )
    session_id = str(session.get("id") or "")
    url = str(session.get("url") or "")
    status = str(session.get("status") or "open")
    if not session_id:
        raise StripeError("Stripe returned a Checkout session without an id")
    if status not in {"complete", "expired"} and not url:
        raise StripeError("Stripe returned a Checkout session without a URL")
    local_status = {
        "complete": StripeCheckoutAttempt.Status.COMPLETED,
        "expired": StripeCheckoutAttempt.Status.EXPIRED,
    }.get(status, StripeCheckoutAttempt.Status.OPEN)
    StripeCheckoutAttempt.objects.filter(pk=attempt.pk).update(
        stripe_checkout_session_id=session_id,
        stripe_subscription_id=(
            _object_id(session.get("subscription")) or None
            if local_status == StripeCheckoutAttempt.Status.COMPLETED
            else None
        ),
        status=local_status,
        updated_at=timezone.now(),
    )
    return session


def action_create_stripe_checkout(user: User, body: JsonObject) -> JsonObject:
    _require_enabled()
    assert_checkout_ready()
    account = get_billing_account(user)
    if account.deletion_state != BillingAccount.DeletionState.ACTIVE:
        raise ValueError("This account is being deleted.")
    try:
        _reconcile(account)
        account.refresh_from_db(fields=["status"])
        if is_paid_status(account.status):
            raise ValueError("You already have an active subscription.")
        for _ in range(2):
            attempt = _reserve_checkout(user, account)
            session = _create_provider_checkout(user, attempt)
            session_status = str(session.get("status") or "open")
            if session_status == "complete":
                raise ValueError(
                    "Your previous Checkout is still being confirmed. Refresh status."
                )
            if session_status != "expired":
                return {"url": str(session["url"])}
        raise ValueError("The previous Checkout session expired. Try again.")
    except StripeError as exc:
        raise _unreachable(exc) from exc
    except BillingIdentityConflict as exc:
        raise ValueError("Stripe billing identity could not be verified.") from exc


def _portal_customers(account: BillingAccount):
    return (
        account.stripe_customers.filter(
            stripe_customer_id__isnull=False,
            subscriptions__product_id=settings.STRIPE_PRODUCT_ID,
        )
        .distinct()
        .order_by("-is_primary", "provider_created_at", "id")
    )


def action_create_billing_portal(user: User, body: JsonObject) -> JsonObject:
    _require_enabled()
    account = get_billing_account(user)
    try:
        _reconcile(account)
    except StripeError as exc:
        raise _unreachable(exc) from exc
    customers = list(_portal_customers(account))
    if not customers:
        raise ValueError("No billing account yet.")

    customer_id = body.get("customerId")
    if customer_id is None and len(customers) > 1:
        return {
            "customers": [
                {"id": str(customer.pk), "label": f"Subscription {index}"}
                for index, customer in enumerate(customers, start=1)
            ]
        }
    if customer_id is None:
        customer = customers[0]
    else:
        raw_id = text_value(customer_id, "Billing account", max_length=64)
        try:
            parsed_id = UUID(raw_id)
        except ValueError as exc:
            raise ValueError("Billing account is invalid.") from exc
        customer = _portal_customers(account).filter(pk=parsed_id).first()
        if customer is None:
            raise ValueError("Billing account is invalid.")
    try:
        portal = stripe.create_portal_session(
            str(customer.stripe_customer_id),
            settings.FORKLUCK_APP_ORIGIN + "/settings",
        )
    except StripeError as exc:
        raise _unreachable(exc) from exc
    return {"url": portal["url"]}


def _mark_checkout_completed(account: BillingAccount, session: dict) -> None:
    if session.get("status") != "complete":
        return
    metadata = session.get("metadata") or {}
    attempt_id = str(metadata.get("forkluck_checkout_attempt_id") or "")
    filters: dict[str, object] = {"account": account}
    if attempt_id:
        try:
            filters["pk"] = UUID(attempt_id)
        except ValueError:
            return
    else:
        session_id = str(session.get("id") or "")
        if not session_id:
            return
        filters["stripe_checkout_session_id"] = session_id
    StripeCheckoutAttempt.objects.filter(**filters).update(
        status=StripeCheckoutAttempt.Status.COMPLETED,
        stripe_checkout_session_id=str(session.get("id") or "") or None,
        stripe_subscription_id=_object_id(session.get("subscription")) or None,
        updated_at=timezone.now(),
    )


def action_sync_stripe_subscription(user: User, body: JsonObject) -> JsonObject:
    _require_enabled()
    account = get_billing_account(user)
    try:
        checkout_session_id = body.get("checkoutSessionId")
        if checkout_session_id is not None:
            session = stripe.retrieve_checkout_session(
                text_value(
                    checkout_session_id,
                    "Checkout session",
                    max_length=255,
                )
            )
            customer_id = _session_customer_id(session)
            owner = account_for_provider_customer(customer_id) if customer_id else None
            if (
                session.get("client_reference_id") != str(user.id)
                or owner is None
                or owner.pk != account.pk
            ):
                raise ValueError(
                    "That checkout session belongs to a different account."
                )
            _mark_checkout_completed(account, session)
        _reconcile(account)
    except StripeError as exc:
        raise _unreachable(exc) from exc
    except BillingIdentityConflict as exc:
        raise ValueError("Stripe billing identity could not be verified.") from exc
    return billing_json(user)


ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "create-stripe-checkout": action_create_stripe_checkout,
    "create-billing-portal": action_create_billing_portal,
    "sync-stripe-subscription": action_sync_stripe_subscription,
}


def _event_fields(event: dict) -> tuple[str, str, str, str]:
    event_id = str(event.get("id") or "")
    event_type = str(event.get("type") or "")
    obj = (event.get("data") or {}).get("object") or {}
    customer_id = _session_customer_id(obj)
    subscription_id = (
        str(obj.get("id") or "")
        if event_type.startswith("customer.subscription.")
        else _object_id(obj.get("subscription"))
    )
    return event_id, event_type, customer_id, subscription_id


def _record_webhook_event(event: dict) -> tuple[StripeWebhookEvent, bool]:
    event_id, event_type, customer_id, subscription_id = _event_fields(event)
    if not event_id or not event_type:
        raise ValueError("Stripe event identity was missing.")
    row, created = StripeWebhookEvent.objects.get_or_create(
        event_id=event_id,
        defaults={
            "event_type": event_type,
            "stripe_customer_id": customer_id,
            "stripe_subscription_id": subscription_id,
            "livemode": bool(event.get("livemode")),
        },
    )
    if not created and (
        row.event_type != event_type
        or row.stripe_customer_id != customer_id
        or row.stripe_subscription_id != subscription_id
        or row.livemode != bool(event.get("livemode"))
    ):
        raise ValueError("Stripe event identity changed between deliveries.")
    return row, created


def _claim_webhook_event(row: StripeWebhookEvent) -> str:
    with transaction.atomic():
        current = StripeWebhookEvent.objects.select_for_update().get(pk=row.pk)
        if current.status == StripeWebhookEvent.Status.PROCESSED:
            return "processed"
        now = timezone.now()
        if (
            current.status == StripeWebhookEvent.Status.PROCESSING
            and current.processing_started_at is not None
            and current.processing_started_at > now - WEBHOOK_PROCESSING_LEASE
        ):
            return "busy"
        current.status = StripeWebhookEvent.Status.PROCESSING
        current.processing_started_at = now
        current.last_error = ""
        current.save(update_fields=["status", "processing_started_at", "last_error"])
    row.status = StripeWebhookEvent.Status.PROCESSING
    row.processing_started_at = now
    return "claimed"


def _finish_webhook_event(row: StripeWebhookEvent) -> bool:
    return bool(
        StripeWebhookEvent.objects.filter(
            pk=row.pk,
            status=StripeWebhookEvent.Status.PROCESSING,
            processing_started_at=row.processing_started_at,
        ).update(
            status=StripeWebhookEvent.Status.PROCESSED,
            last_error="",
            processing_started_at=None,
            processed_at=timezone.now(),
        )
    )


def _retry_webhook_event(row: StripeWebhookEvent, reason: str) -> JsonResponse:
    StripeWebhookEvent.objects.filter(
        pk=row.pk,
        status=StripeWebhookEvent.Status.PROCESSING,
        processing_started_at=row.processing_started_at,
    ).update(
        status=StripeWebhookEvent.Status.PENDING,
        last_error=reason[:240],
        processing_started_at=None,
    )
    return error("Billing refresh failed", 503, code="billing_retry")


@csrf_exempt
@require_POST
def stripe_webhook(request: HttpRequest) -> JsonResponse:
    if not billing_enabled():
        return error("Not found", 404)
    try:
        event = stripe.verify_webhook(
            request.body, request.headers.get("Stripe-Signature", "")
        )
    except StripeError as exc:
        logger.warning("Rejected Stripe webhook: %s", exc)
        return error("Invalid signature", 400)
    try:
        row, _ = _record_webhook_event(event)
    except ValueError:
        return error("Invalid Stripe event", 400)
    claim = _claim_webhook_event(row)
    if claim == "processed":
        return JsonResponse({"received": True})
    if claim == "busy":
        return error("Billing refresh in progress", 503, code="billing_retry")

    try:
        mark_current_webhook_secret_verified(livemode=bool(event.get("livemode")))
    except BillingNotReady:
        logger.warning("Could not attest the current Stripe webhook endpoint")
        return _retry_webhook_event(row, "billing_configuration_mismatch")
    supported = {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    }
    if row.event_type not in supported:
        if _finish_webhook_event(row):
            return JsonResponse({"received": True})
        return error("Billing refresh failed", 503, code="billing_retry")
    if not row.stripe_customer_id:
        return _retry_webhook_event(row, "missing_customer")
    if StripeRetiredCustomer.objects.filter(pk=row.stripe_customer_id).exists():
        if _finish_webhook_event(row):
            return JsonResponse({"received": True})
        return error("Billing refresh failed", 503, code="billing_retry")

    try:
        account = account_for_provider_customer(row.stripe_customer_id)
        if account is None:
            return _retry_webhook_event(row, "customer_identity_not_ready")
        StripeWebhookEvent.objects.filter(pk=row.pk).update(account=account)
        if row.event_type == "checkout.session.completed":
            obj = (event.get("data") or {}).get("object") or {}
            if obj.get("client_reference_id") != str(account.user_id):
                return _retry_webhook_event(row, "checkout_identity_mismatch")
            _mark_checkout_completed(account, obj)
        if not reconcile_billing_account(account):
            return _retry_webhook_event(row, "reconciliation_superseded")
    except (StripeError, BillingIdentityConflict) as exc:
        logger.warning(
            "Stripe webhook could not reconcile: %s",
            type(exc).__name__,
        )
        return _retry_webhook_event(row, "stripe_reconciliation_failed")
    if _finish_webhook_event(row):
        return JsonResponse({"received": True})
    return error("Billing refresh failed", 503, code="billing_retry")


def _recover_checkout_for_deletion(
    user: User, attempt: StripeCheckoutAttempt
) -> None:
    customer = _ensure_provider_customer(user, attempt.customer)
    if attempt.stripe_checkout_session_id:
        session = stripe.retrieve_checkout_session(attempt.stripe_checkout_session_id)
    else:
        session = _create_provider_checkout(user, attempt)
    session_id = str(session.get("id") or "")
    if not session_id:
        raise StripeError("Stripe returned a Checkout session without an id")
    status = str(session.get("status") or "")
    if status == "open":
        stripe.expire_checkout_session(
            session_id,
            idempotency_key=f"forkluck.checkout.expire.{attempt.id}",
        )
        status = "expired"
    StripeCheckoutAttempt.objects.filter(pk=attempt.pk).update(
        stripe_checkout_session_id=session_id,
        stripe_subscription_id=(
            _object_id(session.get("subscription")) or None
            if status == "complete"
            else None
        ),
        status=(
            StripeCheckoutAttempt.Status.COMPLETED
            if status == "complete"
            else StripeCheckoutAttempt.Status.EXPIRED
        ),
        updated_at=timezone.now(),
    )
    customer.refresh_from_db()


def delete_user_with_billing(user: User) -> tuple[int, dict[str, int]]:
    """Cancel all provider work, tombstone identities, then delete one user."""

    # Queued before the delete so the address is captured while the row is
    # still readable; on_commit outside an atomic block runs immediately.
    email = user.email

    if not billing_enabled():
        if StripeCustomer.objects.filter(
            account__user=user,
            stripe_customer_id__isnull=False,
        ).exists():
            raise BillingNotReady(
                "Restore Stripe billing configuration before deleting this user."
            )
        remove_feedback_user(user.pk)
        transaction.on_commit(lambda: remove_member(email))
        return user.delete()
    account = get_billing_account(user)
    with transaction.atomic():
        account = BillingAccount.objects.select_for_update().get(pk=account.pk)
        account.deletion_state = BillingAccount.DeletionState.DELETING
        account.status = "deleting"
        account.locked = True
        account.save(
            update_fields=["deletion_state", "status", "locked", "updated_at"]
        )

    for attempt in account.checkout_attempts.select_related("customer").filter(
        status__in=[
            StripeCheckoutAttempt.Status.PENDING,
            StripeCheckoutAttempt.Status.OPEN,
        ]
    ):
        _recover_checkout_for_deletion(user, attempt)
    _reconcile(account)
    if _completed_checkout_is_unresolved(account):
        raise BillingNotReady(
            "A completed Stripe Checkout is still being reconciled."
        )
    subscriptions = list(
        StripeSubscription.objects.filter(
            customer__account=account,
            status__in=CANCELLABLE_STATUSES,
        )
    )
    for subscription in subscriptions:
        stripe.cancel_subscription(subscription.stripe_subscription_id)

    remove_feedback_user(user.pk)
    with transaction.atomic():
        account = BillingAccount.objects.select_for_update().get(pk=account.pk)
        tombstones = [
            StripeRetiredCustomer(
                stripe_customer_id=customer.stripe_customer_id,
                livemode=customer.livemode,
            )
            for customer in account.stripe_customers.exclude(
                stripe_customer_id__isnull=True
            )
        ]
        StripeRetiredCustomer.objects.bulk_create(
            tombstones,
            ignore_conflicts=True,
        )
        transaction.on_commit(lambda: remove_member(email))
        return user.delete()
