"""Thin Stripe API client over stdlib urllib (house style — see square.py)."""

import hashlib
import hmac
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping

from django.conf import settings

logger = logging.getLogger(__name__)

STRIPE_BASE_URL = "https://api.stripe.com"
# Match the live Forkluck endpoint. Clover places subscription billing periods
# on each item rather than on the top-level subscription object.
STRIPE_VERSION = "2025-12-15.clover"
REQUEST_TIMEOUT_S = 10
WEBHOOK_TOLERANCE_S = 300


class StripeError(Exception):
    """A Stripe call failed; its message is safe to log and show a user."""

    def __init__(self, message: str, *, code: str = "", status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


def _object_path(collection: str, object_id: str, suffix: str = "") -> str:
    encoded = urllib.parse.quote(object_id, safe="")
    return f"/v1/{collection}/{encoded}{suffix}"


def _request(
    method: str,
    path: str,
    params: Mapping[str, object] | None = None,
    *,
    idempotency_key: str | None = None,
) -> dict:
    url = f"{STRIPE_BASE_URL}{path}"
    data = None
    if method == "GET":
        if params:
            url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"
    else:
        data = urllib.parse.urlencode(params or {}, doseq=True).encode()
    headers = {
        "Authorization": f"Bearer {settings.STRIPE_SECRET_KEY}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": STRIPE_VERSION,
        "User-Agent": "forkluck-backend/1.0",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        code = ""
        try:
            body = json.loads(exc.read() or b"{}")
            code = str((body.get("error") or {}).get("code") or "")[:80]
        except (json.JSONDecodeError, AttributeError):
            pass
        logger.warning(
            "Stripe request failed: method=%s status=%s code=%s",
            method,
            exc.code,
            code or "unknown",
        )
        raise StripeError(
            f"Stripe request failed ({exc.code})", code=code, status=exc.code
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        logger.warning("Stripe request was unreachable: method=%s", method)
        raise StripeError("Stripe could not be reached") from exc
    except json.JSONDecodeError as exc:
        logger.warning("Stripe returned unreadable JSON: method=%s", method)
        raise StripeError("Stripe returned an unreadable response") from exc


def create_customer(
    email: str,
    name: str,
    user_id,
    customer_ref,
    *,
    idempotency_key: str,
) -> dict:
    return _request(
        "POST",
        "/v1/customers",
        {
            "email": email,
            "name": name,
            "metadata[forkluck_user_id]": user_id,
            "metadata[forkluck_customer_ref]": customer_ref,
        },
        idempotency_key=idempotency_key,
    )


def create_checkout_session(
    customer_id: str,
    success_url: str,
    cancel_url: str,
    user_id,
    attempt_id,
    with_trial: bool,
    *,
    idempotency_key: str,
) -> dict:
    params = {
        "customer": customer_id,
        "mode": "subscription",
        "line_items[0][price]": settings.STRIPE_PRICE_ID,
        "line_items[0][quantity]": 1,
        "client_reference_id": user_id,
        "success_url": success_url,
        "cancel_url": cancel_url,
        "metadata[forkluck_checkout_attempt_id]": attempt_id,
        "subscription_data[metadata][forkluck_user_id]": user_id,
        "subscription_data[metadata][forkluck_checkout_attempt_id]": attempt_id,
    }
    if with_trial:
        params["subscription_data[trial_period_days]"] = 14
    return _request(
        "POST",
        "/v1/checkout/sessions",
        params,
        idempotency_key=idempotency_key,
    )


def create_portal_session(customer_id: str, return_url: str) -> dict:
    return _request(
        "POST",
        "/v1/billing_portal/sessions",
        {"customer": customer_id, "return_url": return_url},
    )


def retrieve_subscription(subscription_id: str) -> dict:
    return _request("GET", _object_path("subscriptions", subscription_id))


def retrieve_checkout_session(session_id: str) -> dict:
    return _request("GET", _object_path("checkout/sessions", session_id))


def retrieve_customer(customer_id: str) -> dict:
    return _request("GET", _object_path("customers", customer_id))


def _list_all(path: str, params: Mapping[str, object]) -> list[dict]:
    items: list[dict] = []
    cursor = ""
    while True:
        page_params = {**params, "limit": 100}
        if cursor:
            page_params["starting_after"] = cursor
        body = _request("GET", path, page_params)
        page = body.get("data") or []
        items.extend(item for item in page if isinstance(item, dict))
        if not body.get("has_more") or not page:
            return items
        cursor = str(page[-1].get("id") or "")
        if not cursor:
            raise StripeError("Stripe returned an invalid pagination cursor")


def list_subscriptions(customer_id: str) -> list[dict]:
    return _list_all("/v1/subscriptions", {"customer": customer_id, "status": "all"})


def list_open_checkout_sessions(customer_id: str) -> list[dict]:
    return _list_all(
        "/v1/checkout/sessions", {"customer": customer_id, "status": "open"}
    )


def search_customers(user_id) -> list[dict]:
    escaped = str(user_id).replace("\\", "\\\\").replace("'", "\\'")
    query = f"metadata['forkluck_user_id']:'{escaped}'"
    items: list[dict] = []
    page = ""
    while True:
        params = {"query": query, "limit": 100}
        if page:
            params["page"] = page
        body = _request("GET", "/v1/customers/search", params)
        items.extend(
            item for item in (body.get("data") or []) if isinstance(item, dict)
        )
        page = str(body.get("next_page") or "")
        if not page:
            return items


def cancel_subscription(subscription_id: str) -> dict:
    # Stripe does not apply idempotency keys to DELETE. Callers reconcile first
    # and only delete provider subscriptions that are still cancellable.
    return _request("DELETE", _object_path("subscriptions", subscription_id))


def expire_checkout_session(session_id: str, *, idempotency_key: str) -> dict:
    return _request(
        "POST",
        _object_path("checkout/sessions", session_id, "/expire"),
        idempotency_key=idempotency_key,
    )


def list_customers() -> list[dict]:
    return _list_all("/v1/customers", {})


def retrieve_account() -> dict:
    return _request("GET", "/v1/account")


def retrieve_price(price_id: str) -> dict:
    return _request("GET", _object_path("prices", price_id))


def retrieve_product(product_id: str) -> dict:
    return _request("GET", _object_path("products", product_id))


def retrieve_webhook_endpoint(endpoint_id: str) -> dict:
    return _request("GET", _object_path("webhook_endpoints", endpoint_id))


def list_webhook_endpoints() -> list[dict]:
    return _list_all("/v1/webhook_endpoints", {})


def create_webhook_endpoint(
    url: str, enabled_events: list[str], *, idempotency_key: str
) -> dict:
    return _request(
        "POST",
        "/v1/webhook_endpoints",
        {
            "url": url,
            "enabled_events[]": enabled_events,
            "api_version": STRIPE_VERSION,
            "description": "Forkluck subscription billing",
        },
        idempotency_key=idempotency_key,
    )


def delete_webhook_endpoint(endpoint_id: str) -> dict:
    return _request("DELETE", _object_path("webhook_endpoints", endpoint_id))


def verify_webhook(payload: bytes, signature_header: str) -> dict:
    timestamp = ""
    candidates = []
    for part in (signature_header or "").split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            candidates.append(value)
    if not timestamp or not candidates:
        raise StripeError("Stripe signature header was malformed")
    try:
        age = abs(time.time() - int(timestamp))
    except ValueError as exc:
        raise StripeError("Stripe signature header was malformed") from exc
    if age > WEBHOOK_TOLERANCE_S:
        raise StripeError("Stripe signature timestamp is outside the tolerance")
    expected = hmac.new(
        settings.STRIPE_WEBHOOK_SECRET.encode(),
        f"{timestamp}.".encode() + payload,
        hashlib.sha256,
    ).hexdigest()
    if not any(hmac.compare_digest(expected, candidate) for candidate in candidates):
        raise StripeError("Stripe signature did not match")
    try:
        event = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise StripeError("Stripe webhook body was unreadable") from exc
    if not isinstance(event, dict):
        raise StripeError("Stripe webhook body was not an event object")
    return event
