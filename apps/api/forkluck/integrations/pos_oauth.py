"""OAuth connect/callback endpoints for Square and Shopify.

These are the only integration routes on the public site (/api/integrations/*,
proxied by nginx and the Next dev rewrite): provider callbacks arrive as
unauthenticated top-level GETs, so they can't live behind /internal/v1/. The
user is identified by the Django session cookie (SameSite=Lax rides along on
top-level redirects), and every flow is double-gated by a signed, expiring
state parameter plus a single-use nonce stored in that session.
"""

import logging
import secrets
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.http import HttpRequest, HttpResponse, HttpResponseRedirect
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.http import require_GET

from . import shopify, square
from ..models import SalesChannelConnection, SalesImport, SyncRun, User
from .exchange_rates import SUPPORTED_CURRENCIES
from .token_crypto import TokenCryptoError, encrypt_token

logger = logging.getLogger(__name__)

STATE_SALT = "pos-oauth"
STATE_MAX_AGE_S = 600
SESSION_KEY = "pos_oauth"


def session_key(provider: str) -> str:
    """One nonce slot per provider — connecting Square in one tab must not
    clobber a Shopify connect started in another."""
    return f"{SESSION_KEY}:{provider}"


def mint_state(request: HttpRequest, provider: str, shop: str = "") -> str:
    nonce = secrets.token_urlsafe(32)
    request.session[session_key(provider)] = {
        "nonce": nonce,
        "provider": provider,
    }
    return signing.dumps(
        {"n": nonce, "p": provider, "s": shop}, salt=STATE_SALT
    )


def consume_state(request: HttpRequest, raw: str, provider: str) -> dict | None:
    """Single-use: the session nonce is popped before any comparison, so a
    replayed callback fails even when the signature is still valid."""
    held = request.session.pop(session_key(provider), None)
    try:
        state = signing.loads(raw, salt=STATE_SALT, max_age=STATE_MAX_AGE_S)
    except signing.BadSignature:
        return None
    if not isinstance(held, dict) or not isinstance(state, dict):
        return None
    if state.get("p") != provider or held.get("provider") != provider:
        return None
    nonce = state.get("n") or ""
    if not secrets.compare_digest(str(held.get("nonce") or ""), str(nonce)):
        return None
    return state


def settings_redirect(**params: str) -> HttpResponseRedirect:
    query = "&".join(f"{key}={value}" for key, value in params.items())
    base = "/integrations/sales/connections"
    return HttpResponseRedirect(f"{base}?{query}" if query else base)


def error_redirect(provider: str, code: str) -> HttpResponseRedirect:
    return HttpResponseRedirect(
        f"/integrations/sales/connections?integration_error={code}&provider={provider}"
    )


def require_session_user(request: HttpRequest):
    if not request.user.is_authenticated:
        return None
    return request.user


def save_connection(user, provider: str, defaults: dict) -> SalesChannelConnection:
    """Upsert the user's connection; connecting a *different* merchant/shop
    resets the sync state so the old watermark can't hide the new account's
    history.

    Refuses a provider currency outside SUPPORTED_CURRENCIES: Square reports
    money in the currency's minor units and Shopify reports decimals, and both
    land in the same integer `net_sales_cents` column — a zero- or
    three-decimal currency would be off by 100x with nothing downstream able
    to tell. This is the one gate for every connect path, OAuth included.
    """
    currency = defaults.get("currency_code", "")
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError(
            f"That account reports sales in {currency or 'an unknown currency'}, "
            "which Forkluck can't track yet. Supported currencies: "
            f"{', '.join(sorted(SUPPORTED_CURRENCIES))}."
        )
    provider_timezone = defaults.get("provider_timezone", "")
    try:
        ZoneInfo(provider_timezone)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise ValueError(
            "That account reports an unsupported timezone. "
            "Update the provider location and reconnect."
        ) from exc
    provider_account_id = (
        defaults.get("merchant_id", "")
        if provider == SalesImport.Channel.SQUARE
        else defaults.get("shop_domain", "")
    )
    defaults = {**defaults, "provider_account_id": provider_account_id}
    with transaction.atomic():
        # Same workspace row and first-lock ordering as domain import/undo
        # flows. This public OAuth integration cannot import upward into the
        # domain layer, so it takes the shared rendezvous row directly.
        User.objects.select_for_update().only("id").get(pk=user.pk)
        existing = (
            SalesChannelConnection.objects.select_for_update()
            .filter(user=user, provider=provider)
            .first()
        )
        if existing is None:
            return SalesChannelConnection.objects.create(
                user=user,
                provider=provider,
                **defaults,
                status=SalesChannelConnection.Status.ACTIVE,
                last_error="",
            )
        if existing.status == SalesChannelConnection.Status.DISCONNECTING:
            raise ValueError(
                "This channel is still disconnecting. Try connecting again "
                "after it disappears from Settings."
            )

        prior_generation = existing.generation
        SyncRun.objects.cancel_active(
            connection=existing,
            generation=prior_generation,
            now=timezone.now(),
        )
        identity_changed = (
            bool(provider_account_id)
            and existing.provider_account_id != provider_account_id
        )
        if identity_changed:
            defaults = {
                **defaults,
                "sync_watermark": None,
                "backfilled_at": None,
                "last_synced_at": None,
                "modifier_catalog_synced_at": None,
                "product_catalog_synced_at": None,
            }
        # A pass cursor belongs to the exact credential generation even when
        # the provider account is unchanged. Reconnect cancels that intent;
        # the next request safely starts a fresh overlapped session.
        defaults = {
            **defaults,
            "sync_cursor": {},
            "sync_lease_token": None,
            "sync_lease_started_at": None,
            "generation": prior_generation + 1,
            "status": SalesChannelConnection.Status.ACTIVE,
            "last_error": "",
        }
        for field, value in defaults.items():
            setattr(existing, field, value)
        existing.save(update_fields=[*defaults, "updated_at"])
        return existing


@require_GET
def square_connect(request: HttpRequest) -> HttpResponse:
    if require_session_user(request) is None:
        return HttpResponseRedirect("/login")
    if not settings.SQUARE_APPLICATION_ID:
        return error_redirect("square", "not_configured")
    state = mint_state(request, "square")
    return HttpResponseRedirect(square.authorize_url(state))


@require_GET
def square_callback(request: HttpRequest) -> HttpResponse:
    user = require_session_user(request)
    if user is None:
        return HttpResponseRedirect("/login")
    if request.GET.get("error"):
        return error_redirect("square", "denied")
    if consume_state(request, request.GET.get("state", ""), "square") is None:
        return error_redirect("square", "state_expired")
    code = request.GET.get("code", "")
    if not code:
        return error_redirect("square", "exchange_failed")
    try:
        tokens = square.exchange_code(code)
        locations = square.list_locations(tokens["access_token"])
    except square.SquareError:
        logger.exception("Square token exchange failed for %s", user.id)
        return error_redirect("square", "exchange_failed")
    # Square lists closed locations too, and they never carry orders while
    # still eating a slot in the 10-location search cap. The first ACTIVE
    # location is the merchant's main one and defines the workspace's timezone
    # and currency; a merchant with no active location falls back to the whole
    # list so the connection is still usable.
    active = [row for row in locations if row.get("status", "ACTIVE") == "ACTIVE"]
    usable = active or locations
    main = usable[0] if usable else {}
    expires_at = None
    if tokens.get("expires_at"):
        expires_at = parse_datetime(tokens["expires_at"])
    try:
        access_encrypted = encrypt_token(tokens["access_token"])
        refresh_encrypted = (
            encrypt_token(tokens["refresh_token"])
            if tokens.get("refresh_token")
            else ""
        )
    except TokenCryptoError:
        logger.exception("Square token could not be encrypted for %s", user.id)
        return error_redirect("square", "not_configured")
    try:
        save_connection(
            user,
            SalesImport.Channel.SQUARE,
            {
                "access_token_encrypted": access_encrypted,
                "refresh_token_encrypted": refresh_encrypted,
                "token_expires_at": expires_at,
                "merchant_id": tokens.get("merchant_id", ""),
                "location_ids": [row["id"] for row in usable],
                "location_timezones": {
                    row["id"]: row.get("timezone", "UTC") for row in usable
                },
                "scopes": "ORDERS_READ ITEMS_READ MERCHANT_PROFILE_READ",
                "provider_timezone": main.get("timezone", "UTC"),
                "currency_code": main.get("currency", "USD"),
            },
        )
    except ValueError:
        return error_redirect("square", "unsupported_currency")
    return settings_redirect(connected="square")


@require_GET
def shopify_connect(request: HttpRequest) -> HttpResponse:
    if require_session_user(request) is None:
        return HttpResponseRedirect("/login")
    if not settings.SHOPIFY_API_KEY:
        return error_redirect("shopify", "not_configured")
    try:
        shop = shopify.validate_shop_domain(request.GET.get("shop", ""))
    except ValueError:
        return error_redirect("shopify", "bad_shop")
    state = mint_state(request, "shopify", shop)
    return HttpResponseRedirect(shopify.authorize_url(shop, state))


@require_GET
def shopify_callback(request: HttpRequest) -> HttpResponse:
    user = require_session_user(request)
    if user is None:
        return HttpResponseRedirect("/login")
    params = {key: request.GET[key] for key in request.GET}
    if not shopify.verify_callback_hmac(params):
        return error_redirect("shopify", "hmac_invalid")
    state = consume_state(request, params.get("state", ""), "shopify")
    if state is None:
        return error_redirect("shopify", "state_expired")
    try:
        shop = shopify.validate_shop_domain(params.get("shop", ""))
    except ValueError:
        return error_redirect("shopify", "bad_shop")
    # The signed state pinned the shop the user asked to connect; a callback
    # for any other shop is not theirs.
    if state.get("s") != shop:
        return error_redirect("shopify", "bad_shop")
    code = params.get("code", "")
    if not code:
        return error_redirect("shopify", "exchange_failed")
    try:
        tokens = shopify.exchange_code(shop, code)
        info = shopify.fetch_shop_info(shop, tokens["access_token"])
    except shopify.ShopifyError:
        logger.exception("Shopify token exchange failed for %s", user.id)
        return error_redirect("shopify", "exchange_failed")
    try:
        access_encrypted = encrypt_token(tokens["access_token"])
    except TokenCryptoError:
        logger.exception("Shopify token could not be encrypted for %s", user.id)
        return error_redirect("shopify", "not_configured")
    try:
        save_connection(
            user,
            SalesImport.Channel.SHOPIFY,
            {
                "access_token_encrypted": access_encrypted,
                "refresh_token_encrypted": "",
                "token_expires_at": None,
                "shop_domain": shop,
                "scopes": tokens.get("scope", ""),
                "provider_timezone": info["timezone"],
                "currency_code": info["currency"],
            },
        )
    except ValueError:
        return error_redirect("shopify", "unsupported_currency")
    return settings_redirect(connected="shopify")
