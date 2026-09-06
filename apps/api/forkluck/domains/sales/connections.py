"""Sales-domain ownership of POS channel connections.

Provider adapters prove a credential works and normalize what the vendor
says about the account; nothing below this layer decides what Forkluck
stores or shows. This module owns the tenant-scoped connection rows, the
JSON shape both the read endpoint and the status action return, and the
slugs that connect or disconnect a channel — so the write path stays
``urls -> dispatch -> domains -> integrations`` with no user-facing action
handler living under ``integrations/``.
"""

from collections.abc import Callable

from django.db import transaction

from ...integrations import pos_sync as provider_sync
from ...integrations.pos_oauth import save_connection
from ...models import SalesChannelConnection, SalesImport, User
from ..shared.activity import record_event
from ..shared.locking import lock_workspace
from ..shared.values import text_value
from .core import JsonObject


def connection_json(row: SalesChannelConnection) -> JsonObject:
    return {
        "provider": row.provider,
        "providerAccountId": row.provider_account_id,
        "generation": row.generation,
        "status": row.status,
        "merchantId": row.merchant_id,
        "shopDomain": row.shop_domain,
        "scopes": row.scopes,
        "providerTimezone": row.provider_timezone,
        "currencyCode": row.currency_code,
        "lastSyncedAt": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "backfilledAt": row.backfilled_at.isoformat() if row.backfilled_at else None,
        "lastError": row.last_error,
        "connectedAt": row.created_at.isoformat(),
    }


def pos_connections_payload(user: User) -> JsonObject:
    rows = SalesChannelConnection.objects.filter(user=user)
    return {"items": [connection_json(row) for row in rows]}


def action_pos_connections_status(user: User, body: JsonObject) -> JsonObject:
    return pos_connections_payload(user)


def action_connect_shopify_credentials(user: User, body: JsonObject) -> JsonObject:
    """Connect Shopify with Dev Dashboard app client credentials."""

    shop = provider_sync.normalize_shop_domain(
        text_value(body.get("shopDomain"), "Store domain", max_length=120)
    )
    client_id = text_value(body.get("clientId"), "Client ID", max_length=64)
    client_secret = text_value(
        body.get("clientSecret"), "Client secret", max_length=255
    )
    connection = save_connection(
        user,
        SalesImport.Channel.SHOPIFY,
        provider_sync.shopify_credentials_connection_fields(
            shop, client_id, client_secret
        ),
    )
    record_event(user, user, "connection", "connected", name="Shopify")
    return connection_json(connection)


def action_connect_shopify_token(user: User, body: JsonObject) -> JsonObject:
    """Connect Shopify with a pasted store-admin custom-app token."""

    shop = provider_sync.normalize_shop_domain(
        text_value(body.get("shopDomain"), "Store domain", max_length=120)
    )
    token = text_value(body.get("accessToken"), "Access token", max_length=255)
    connection = save_connection(
        user,
        SalesImport.Channel.SHOPIFY,
        provider_sync.shopify_token_connection_fields(shop, token),
    )
    record_event(user, user, "connection", "connected", name="Shopify")
    return connection_json(connection)


def action_connect_square_token(user: User, body: JsonObject) -> JsonObject:
    """Connect a Square sandbox test account with its console-issued token."""

    token = text_value(
        body.get("accessToken"), "Square access token", max_length=2048
    )
    connection = save_connection(
        user,
        SalesImport.Channel.SQUARE,
        provider_sync.square_token_connection_fields(token),
    )
    record_event(user, user, "connection", "connected", name="Square")
    return connection_json(connection)


def action_disconnect_pos(user: User, body: JsonObject) -> JsonObject:
    provider = text_value(body.get("provider"), "Provider", max_length=16)
    connection = SalesChannelConnection.objects.filter(
        user=user, provider=provider
    ).first()
    if connection is None:
        raise ValueError("This channel is not connected")
    connection_id = connection.id
    observed_generation = connection.generation
    observed_account_id = connection.provider_account_id
    note = ""
    with transaction.atomic():
        lock_workspace(user)
        locked = (
            SalesChannelConnection.objects.select_for_update()
            .filter(
                id=connection_id,
                user=user,
                provider=provider,
                provider_account_id=observed_account_id,
                generation=observed_generation,
            )
            .first()
        )
        if locked is None:
            raise ValueError(
                "This connection changed while it was being disconnected. Try again."
            )
        if locked.status != SalesChannelConnection.Status.DISCONNECTING:
            locked.sync_runs.cancel_active(
                connection=locked,
                generation=locked.generation,
            )
            locked.generation += 1
            locked.status = SalesChannelConnection.Status.DISCONNECTING
            locked.sync_cursor = {}
            locked.sync_lease_token = None
            locked.sync_lease_started_at = None
            locked.save(
                update_fields=[
                    "generation",
                    "status",
                    "sync_cursor",
                    "sync_lease_token",
                    "sync_lease_started_at",
                    "updated_at",
                ]
            )
        disconnect_generation = locked.generation
        merchant_id = locked.merchant_id

    # Reconnect refuses the durable disconnecting state, so a replacement
    # credential cannot slip in between this provider effect and local delete.
    if provider == SalesImport.Channel.SQUARE and merchant_id:
        provider_sync.revoke_square_access(merchant_id)
    elif provider == SalesImport.Channel.SHOPIFY:
        note = (
            "Also uninstall Forkluck from your Shopify admin to fully revoke "
            "access."
        )

    with transaction.atomic():
        lock_workspace(user)
        locked = (
            SalesChannelConnection.objects.select_for_update()
            .filter(
                id=connection_id,
                user=user,
                provider=provider,
                provider_account_id=observed_account_id,
                generation=disconnect_generation,
                status=SalesChannelConnection.Status.DISCONNECTING,
            )
            .first()
        )
        if locked is None:
            raise ValueError(
                "This connection changed while it was being disconnected. Try again."
            )
        locked.delete()
    record_event(user, user, "connection", "disconnected", name=provider.title())
    return {"ok": True, "note": note}


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "pos-connections-status": action_pos_connections_status,
    "connect-square-token": action_connect_square_token,
    "connect-shopify-token": action_connect_shopify_token,
    "connect-shopify-credentials": action_connect_shopify_credentials,
    "disconnect-pos": action_disconnect_pos,
}
