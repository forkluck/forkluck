"""Normalized provider adapters and provider-credential verification.

This integration layer owns vendor authentication, acquisition, pagination,
and conversion of vendor payloads into one provider-neutral sales-entry
shape. It never decides which menu item owns a line and never persists sales
history; those responsibilities stay in the sales domain. The
``*_connection_fields`` helpers below prove a credential works and normalize
what the vendor says about the account — the sales domain decides what to do
with that, stores it, and owns the action slugs that call in here.
"""

import json
import logging
import time as time_module
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from . import shopify, square
from .token_crypto import TokenCryptoError, decrypt_token, encrypt_token
from ..models import SalesChannelConnection, SalesImport

JsonObject = dict[str, Any]
MAX_MODIFIERS_PER_LINE = 100

logger = logging.getLogger(__name__)

# Two years of history on first sync, for every provider: a merchant needs a
# full seasonal cycle to map items, and a shorter Square window silently hid
# months of counter sales behind an otherwise complete Shopify baseline.
BACKFILL_DAYS = 730
SHOPIFY_BACKFILL_DAYS = 730
OVERLAP = timedelta(days=2)
TIME_BUDGET_S = 40
# Hard server-side bound, independent of the client's timeBudgetS: a pass
# buffers every normalized line until persist, and production runs gunicorn
# under a 220M cgroup cap — a real merchant's 40-page pass pinned it into
# swap. Watermark resume makes many small passes equivalent to one big one.
PAGE_CAP = 12
# Refresh Square tokens a week before their ~30-day expiry.
REFRESH_WINDOW = timedelta(days=7)
CENT = Decimal("1")
MILLI = Decimal("0.001")
MAX_MODIFIER_QUANTITY = Decimal("1000000")
RAW_PAYLOAD_MAX_CHARS = 4000
# One sync pass tops up at most this many stored pending lines with their
# provider category — a bound on both the catalog fetch and the UPDATE.
CATEGORY_BACKFILL_LINE_CAP = 2000
MIN_TIME_BUDGET_S = 5
MAX_TIME_BUDGET_S = 40
# Longer than Shopify's worst bounded nested-order walk (twenty 15-second
# calls). If a process is killed before its finally block runs, a later worker
# can recover the lease without ever stealing it from a healthy atomic pass.
SYNC_LEASE_TIMEOUT = timedelta(minutes=15)


class SyncFailed(ValueError):
    """User-facing sync failure; the message is safe to show."""


def guarded_connection_update(
    connection: SalesChannelConnection,
    *,
    require_active: bool = False,
    **values: object,
) -> bool:
    """Write only through the credential generation this caller acquired."""

    rows = SalesChannelConnection.objects.filter(
        pk=connection.pk,
        user_id=connection.user_id,
        provider=connection.provider,
        provider_account_id=connection.provider_account_id,
        generation=connection.generation,
    )
    if require_active:
        rows = rows.filter(status=SalesChannelConnection.Status.ACTIVE)
    values["updated_at"] = timezone.now()
    updated = rows.update(**values)
    if updated == 1:
        for field, value in values.items():
            setattr(connection, field, value)
    return updated == 1


def money_to_cents(amount: str | None) -> int:
    if amount in (None, ""):
        return 0
    return int(
        (Decimal(str(amount)) * 100).quantize(CENT, rounding=ROUND_HALF_UP)
    )


def parse_provider_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = parse_datetime(value)
    if parsed is not None and parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo("UTC"))
    return parsed


def ensure_fresh_square_token(connection: SalesChannelConnection) -> str:
    """Return a usable access token, refreshing near expiry.

    The per-connection sync lease serializes refreshes. Both rotated tokens
    are persisted by a credential-generation-guarded update after the provider
    call, so no database transaction spans external I/O.
    """
    if (
        connection.token_expires_at is None
        or connection.token_expires_at > timezone.now() + REFRESH_WINDOW
        or not connection.refresh_token_encrypted
    ):
        return decrypt_token(connection.access_token_encrypted)
    # The per-connection sync lease serializes refreshes. Provider I/O stays
    # outside a database transaction; the guarded write below discards a
    # rotated token if reconnect advanced the generation in the meantime.
    prior_refresh = connection.refresh_token_encrypted
    try:
        tokens = square.refresh_access_token(decrypt_token(prior_refresh))
    except square.SquareGrantRevoked:
        guarded_connection_update(
            connection,
            require_active=True,
            status=SalesChannelConnection.Status.NEEDS_RECONNECT,
            last_error="Square access expired — reconnect Square",
        )
        raise SyncFailed(
            "Square access has expired. Reconnect Square in Settings."
        )
    access_encrypted = encrypt_token(tokens["access_token"])
    refresh_encrypted = (
        encrypt_token(tokens["refresh_token"])
        if tokens.get("refresh_token")
        else prior_refresh
    )
    expires_at = parse_provider_datetime(tokens.get("expires_at"))
    updated = SalesChannelConnection.objects.filter(
        pk=connection.pk,
        user_id=connection.user_id,
        provider=connection.provider,
        provider_account_id=connection.provider_account_id,
        generation=connection.generation,
        status=SalesChannelConnection.Status.ACTIVE,
        refresh_token_encrypted=prior_refresh,
    ).update(
        access_token_encrypted=access_encrypted,
        refresh_token_encrypted=refresh_encrypted,
        token_expires_at=expires_at,
        updated_at=timezone.now(),
    )
    if updated != 1:
        raise SyncFailed(
            "The provider connection changed while its token was refreshing."
        )
    connection.access_token_encrypted = access_encrypted
    connection.refresh_token_encrypted = refresh_encrypted
    connection.token_expires_at = expires_at
    return decrypt_token(connection.access_token_encrypted)


def clean_text(value, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_length]


def safe_provider_payload(row: dict) -> JsonObject:
    """Keep the provider payload verbatim, but never unbounded.

    An oversized payload falls back to the identity fields so audit still has
    something to read.
    """
    try:
        if len(json.dumps(row)) <= RAW_PAYLOAD_MAX_CHARS:
            return row
    except (TypeError, ValueError):
        pass
    return {
        "uid": clean_text(row.get("uid"), 120),
        "catalog_object_id": clean_text(row.get("catalog_object_id"), 192),
        "name": clean_text(row.get("name"), 255),
    }


def build_entry(
    *,
    channel: str,
    external_order_id: str,
    sold_at: datetime,
    entry_timezone: str,
    sku: str,
    item_name: str,
    variant_name: str,
    quantity: Decimal,
    gross_cents: int,
    discount_cents: int,
    tax_cents: int,
    currency_code: str,
    location: str = "",
    order_source: str = "",
    source_payload: dict | None = None,
    external_object_id: str = "",
    product_external_object_id: str = "",
    external_category: str = "",
    modifiers: list[JsonObject] | None = None,
    provider_record_id: str = "",
) -> JsonObject | None:
    if quantity == 0:
        return None
    item_name = clean_text(item_name, 240) or "Unknown item"
    variant_name = clean_text(variant_name, 200)
    sku = clean_text(sku, 120)
    external_object_id = clean_text(external_object_id, 192)
    product_external_object_id = clean_text(product_external_object_id, 192)
    net_sales_cents = gross_cents - discount_cents
    # Revenue fields are signed source facts. `refund_cents` is the separate,
    # non-negative reporting magnitude of reversed net sales, excluding tax.
    refund_cents = -net_sales_cents if quantity < 0 and net_sales_cents < 0 else 0
    return {
        "external_order_id": clean_text(external_order_id, 160) or "unknown",
        "sold_at": sold_at,
        "timezone": entry_timezone,
        "sku": sku,
        "item_name": item_name,
        "variant_name": variant_name,
        "quantity": quantity,
        "gross_cents": gross_cents,
        "discount_cents": discount_cents,
        "net_sales_cents": net_sales_cents,
        "tax_cents": tax_cents,
        "refund_cents": refund_cents,
        "currency_code": (clean_text(currency_code, 3) or "USD").upper(),
        "location": clean_text(location, 200),
        "employee_name": "",
        "order_source": clean_text(order_source, 120),
        "financial_status": "",
        "fulfillment_status": "",
        "source_payload": source_payload or {},
        "channel": channel,
        # Scopes modifier identities under their parent variation, and folds
        # into the fingerprint only when modifiers are actually present.
        "external_object_id": external_object_id,
        # The catalog PARENT of the variation above (Shopify product). Only a
        # resolution fallback: it never scopes modifiers and never fingerprints.
        "product_external_object_id": product_external_object_id,
        "provider_record_id": clean_text(provider_record_id, 500),
        # Provider category display name. Review triage only: it never matches,
        # never fingerprints, and is blank when the provider offers none.
        "external_category": clean_text(external_category, 120),
        "modifiers": modifiers or [],
    }


def square_modifier_price(row: dict, key: str) -> int | None:
    amount = (row.get(key) or {}).get("amount")
    if isinstance(amount, bool) or not isinstance(amount, int):
        return None
    return amount


def square_line_modifiers(
    line: dict, catalog: dict[str, dict], counts: JsonObject
) -> list[JsonObject]:
    """Normalized modifier occurrences carried by one Square line item.

    Square omits `quantity` when exactly one selection was made, so an absent
    quantity is one; a *present* but unreadable one is malformed and drops the
    modifier alone — never the parent sale, and never coerced to 1.
    """
    raw = line.get("modifiers")
    if raw is None:
        raw = line.get("return_modifiers")
    if raw is None:
        return []
    if not isinstance(raw, list):
        counts["malformed_modifiers"] += 1
        return []
    if len(raw) > MAX_MODIFIERS_PER_LINE:
        counts["malformed_modifiers"] += len(raw) - MAX_MODIFIERS_PER_LINE
        raw = raw[:MAX_MODIFIERS_PER_LINE]
    modifiers: list[JsonObject] = []
    for row in raw:
        if not isinstance(row, dict):
            counts["malformed_modifiers"] += 1
            continue
        object_id = clean_text(row.get("catalog_object_id"), 192)
        # A catalog modifier need not carry a name on the order line, and an
        # ad hoc modifier has no catalog id at all — one of the two is enough.
        name = clean_text(row.get("name"), 255) or clean_text(
            catalog.get(object_id, {}).get("item_name"), 255
        )
        if not object_id and not name:
            counts["malformed_modifiers"] += 1
            continue
        raw_quantity = row.get("quantity")
        if raw_quantity in (None, ""):
            quantity = Decimal("1")
        else:
            try:
                quantity = Decimal(str(raw_quantity))
            except ArithmeticError:
                counts["malformed_modifiers"] += 1
                continue
        if (
            not quantity.is_finite()
            or quantity < 0
            or quantity > MAX_MODIFIER_QUANTITY
        ):
            counts["malformed_modifiers"] += 1
            continue
        modifiers.append(
            {
                "source_uid": clean_text(row.get("uid"), 120),
                "external_object_id": object_id,
                "sku": "",
                "name": name,
                "quantity": quantity.quantize(MILLI),
                "base_price_cents": square_modifier_price(row, "base_price_money"),
                "total_price_cents": square_modifier_price(row, "total_price_money"),
                "source_payload": safe_provider_payload(row),
            }
        )
    return modifiers


def square_order_entries(
    order: dict,
    catalog: dict[str, dict],
    connection: SalesChannelConnection,
    *,
    location_timezones: dict[str, str],
) -> tuple[list[JsonObject], JsonObject]:
    """Returns (entries, {"malformed_lines", "malformed_modifiers"})."""
    entries: list[JsonObject] = []
    counts: JsonObject = {"malformed_lines": 0, "malformed_modifiers": 0}
    sold_at = parse_provider_datetime(
        order.get("closed_at") or order.get("updated_at")
    )
    if sold_at is None:
        return entries, counts
    order_id = order.get("id", "")
    location = order.get("location_id", "")
    entry_timezone = location_timezones.get(location)
    if not entry_timezone:
        raise SyncFailed("Square returned an order for an unknown location.")
    order_source = (order.get("source") or {}).get("name", "")
    currency = connection.currency_code

    for line in order.get("line_items", []) or []:
        # Gift cards leave the sync entirely, modifiers included: an orphan
        # modifier occurrence has no parent financial line to hang from.
        if line.get("item_type") == "GIFT_CARD":
            continue
        object_id = line.get("catalog_object_id") or ""
        info = catalog.get(object_id, {})
        try:
            quantity = Decimal(str(line.get("quantity", "0")))
        except ArithmeticError:
            counts["malformed_lines"] += 1
            continue
        if not quantity.is_finite() or quantity == 0:
            counts["malformed_lines"] += 1
            continue
        entry = build_entry(
            channel=SalesImport.Channel.SQUARE,
            external_order_id=order_id,
            sold_at=sold_at,
            entry_timezone=entry_timezone,
            sku=info.get("sku", ""),
            item_name=info.get("item_name") or line.get("name", ""),
            variant_name=info.get("variant_name")
            or line.get("variation_name", ""),
            quantity=quantity,
            gross_cents=(line.get("gross_sales_money") or {}).get("amount", 0),
            discount_cents=(line.get("total_discount_money") or {}).get(
                "amount", 0
            ),
            tax_cents=(line.get("total_tax_money") or {}).get("amount", 0),
            currency_code=(line.get("total_money") or {}).get(
                "currency", currency
            ),
            location=location,
            order_source=order_source,
            source_payload={"orderId": order_id, "lineUid": line.get("uid", "")},
            external_object_id=object_id,
            external_category=info.get("category", ""),
            modifiers=square_line_modifiers(line, catalog, counts),
            provider_record_id=(
                f"{order_id}:line:{line.get('uid')}"
                if order_id and line.get("uid")
                else ""
            ),
        )
        if entry:
            entries.append(entry)
        else:
            counts["malformed_lines"] += 1

    # An itemized refund is a NEW order carrying `returns`; its lines land on
    # the return order's close date as negative rows, so any total is a SUM.
    for group in order.get("returns", []) or []:
        return_order_id = (
            group.get("return_order_id") or group.get("id") or order_id
        )
        for line in group.get("return_line_items", []) or []:
            if line.get("item_type") == "GIFT_CARD":
                continue
            object_id = line.get("catalog_object_id") or ""
            info = catalog.get(object_id, {})
            try:
                quantity = -Decimal(str(line.get("quantity", "0")))
            except ArithmeticError:
                counts["malformed_lines"] += 1
                continue
            if not quantity.is_finite() or quantity == 0:
                counts["malformed_lines"] += 1
                continue
            entry = build_entry(
                channel=SalesImport.Channel.SQUARE,
                external_order_id=order_id,
                sold_at=sold_at,
                entry_timezone=entry_timezone,
                sku=info.get("sku", ""),
                item_name=info.get("item_name") or line.get("name", ""),
                variant_name=info.get("variant_name")
                or line.get("variation_name", ""),
                quantity=quantity,
                gross_cents=-(
                    (line.get("gross_return_money") or {}).get("amount", 0)
                ),
                discount_cents=-(
                    (line.get("total_discount_money") or {}).get("amount", 0)
                ),
                tax_cents=-((line.get("total_tax_money") or {}).get("amount", 0)),
                currency_code=currency,
                location=location,
                order_source=order_source,
                source_payload={
                    "orderId": order_id,
                    "returnOrderId": return_order_id,
                    "returnLineUid": line.get("uid", ""),
                },
                external_object_id=object_id,
                external_category=info.get("category", ""),
                # A returned modifier keeps its own non-negative quantity: the
                # reversal lives entirely in the negative parent quantity.
                modifiers=square_line_modifiers(line, catalog, counts),
                provider_record_id=(
                    f"{return_order_id}:return:{line.get('uid')}"
                    if return_order_id and line.get("uid")
                    else ""
                ),
            )
            if entry:
                entries.append(entry)
    return entries, counts


def shopify_source_payload(
    *,
    order_id: str,
    sale_id: str,
    line_item_id: str,
    variant_object_id: str,
    product_object_id: str,
    group_object_id: str,
) -> JsonObject:
    """Audit identity for one Shopify ledger sale.

    The line-item id is order-specific: it is kept for audit only and must
    never be used as a catalog identity. A bundle group id is preserved as a
    raw fact — interpreting native bundle components is a later phase.
    """
    payload: JsonObject = {"orderId": order_id, "saleId": sale_id}
    for key, value in (
        ("lineItemId", clean_text(line_item_id, 192)),
        ("variantObjectId", variant_object_id),
        ("productObjectId", product_object_id),
        ("lineItemGroupId", group_object_id),
    ):
        if value:
            payload[key] = value
    return payload


def shopify_order_entries(
    order: dict, connection: SalesChannelConnection
) -> tuple[list[JsonObject], int]:
    """Returns (entries, truncated_page_count).

    Cancelled orders are processed, not skipped: Shopify books reversing
    agreements as separate ledger sale ids, so those rows are required for a
    cancelled sale to net out. Only a corrected replay of the same Sale id
    replaces its prior snapshot.
    """
    entries: list[JsonObject] = []
    truncated = 0
    order_ref = order.get("name") or order.get("id", "")
    for agreement in ((order.get("agreements") or {}).get("nodes") or []):
        happened_at = parse_provider_datetime(agreement.get("happenedAt"))
        if happened_at is None:
            continue
        sales = agreement.get("sales") or {}
        if (sales.get("pageInfo") or {}).get("hasNextPage"):
            truncated += 1
        for sale in sales.get("nodes") or []:
            if sale.get("lineType") != "PRODUCT":
                continue
            line_item = sale.get("lineItem") or {}
            if not line_item:
                continue
            # Canonical identity form: Shopify's GID verbatim
            # ("gid://shopify/ProductVariant/123"). The type prefix is what
            # keeps a product and a variant sharing a numeric id apart, so the
            # gid is never reduced to its trailing number.
            variant_object_id = clean_text(
                (line_item.get("variant") or {}).get("id"), 192
            )
            product_object_id = clean_text(
                (line_item.get("product") or {}).get("id"), 192
            )
            group_object_id = clean_text(
                (line_item.get("lineItemGroup") or {}).get("id"), 192
            )
            quantity = Decimal(str(sale.get("quantity") or 0))
            total = (sale.get("totalAmount") or {}).get("shopMoney") or {}
            discount = (
                sale.get("totalDiscountAmountBeforeTaxes") or {}
            ).get("shopMoney") or {}
            tax = (sale.get("totalTaxAmount") or {}).get("shopMoney") or {}
            total_cents = money_to_cents(total.get("amount"))
            discount_cents = money_to_cents(discount.get("amount"))
            tax_cents = money_to_cents(tax.get("amount"))
            # Returns may arrive as actionType RETURN with positive numbers
            # or with amounts already negative, depending on the sale kind —
            # normalize both conventions to negative rows.
            if sale.get("actionType") == "RETURN":
                if quantity > 0:
                    quantity = -quantity
                if total_cents > 0:
                    total_cents = -total_cents
                if tax_cents > 0:
                    tax_cents = -tax_cents
                if discount_cents > 0:
                    discount_cents = -discount_cents
            # Ledger money: totalAmount is after discounts and includes tax.
            # Net = total - tax; gross (pre-discount) = net + discount.
            net_cents = total_cents - tax_cents
            gross_cents = net_cents + discount_cents
            entry = build_entry(
                channel=SalesImport.Channel.SHOPIFY,
                external_order_id=order_ref,
                sold_at=happened_at,
                entry_timezone=connection.provider_timezone,
                sku=line_item.get("sku") or "",
                item_name=line_item.get("name") or "",
                variant_name=line_item.get("variantTitle") or "",
                quantity=quantity,
                gross_cents=gross_cents,
                discount_cents=discount_cents,
                tax_cents=tax_cents,
                currency_code=total.get("currencyCode")
                or connection.currency_code,
                external_category=shopify.product_category_label(
                    line_item.get("product") or {}
                ),
                source_payload=shopify_source_payload(
                    order_id=order.get("id", ""),
                    sale_id=sale.get("id", ""),
                    line_item_id=line_item.get("id", ""),
                    variant_object_id=variant_object_id,
                    product_object_id=product_object_id,
                    group_object_id=group_object_id,
                ),
                external_object_id=variant_object_id,
                product_external_object_id=product_object_id,
                provider_record_id=sale.get("id", ""),
            )
            if entry:
                entries.append(entry)
    if ((order.get("agreements") or {}).get("pageInfo") or {}).get("hasNextPage"):
        truncated += 1
    return entries, truncated


@dataclass(slots=True)
class NormalizedSalesBatch:
    """One bounded acquisition pass, before sales-domain interpretation."""

    entries: list[JsonObject]
    malformed_lines: int = 0
    malformed_modifiers: int = 0
    warnings: int = 0
    pages: int = 0
    max_timestamp: datetime | None = None
    partial: bool = False
    # Square resumes exact provider pages. Shopify still advances through its
    # timestamp watermark, so None means "use the provider-neutral watermark".
    sync_cursor: JsonObject | None = None
    location_ids: list[str] | None = None
    location_timezones: dict[str, str] | None = None
    session_end: datetime | None = None


class PosSalesAdapter(Protocol):
    provider: str

    def acquire(
        self,
        *,
        since: datetime,
        until: datetime,
        backfilling: bool,
        time_budget_s: int,
    ) -> NormalizedSalesBatch: ...

    def category_labels(self, object_ids: list[str]) -> dict[str, str]: ...

    def product_catalog_items(
        self, *, deadline: float | None = None
    ) -> list[JsonObject]: ...


class _BaseSalesAdapter:
    provider = ""

    def __init__(self, connection: SalesChannelConnection) -> None:
        self.connection = connection
        self.token = ""

    def acquire(
        self,
        *,
        since: datetime,
        until: datetime,
        backfilling: bool,
        time_budget_s: int,
    ) -> NormalizedSalesBatch:
        if self.connection.status != SalesChannelConnection.Status.ACTIVE:
            raise SyncFailed(
                f"{self.provider.title()} needs to be reconnected in Settings first."
            )
        try:
            return self._acquire(
                since=since,
                until=until,
                backfilling=backfilling,
                time_budget_s=time_budget_s,
            )
        except SyncFailed:
            raise
        except (square.SquareGrantRevoked, shopify.ShopifyError) as exc:
            dead_grant = isinstance(
                exc, (square.SquareGrantRevoked, shopify.ShopifyAuthError)
            )
            message = (
                f"{self.provider.title()} access has expired. Reconnect in Settings."
                if dead_grant
                else str(exc)
            )
            values: JsonObject = {"last_error": message[:1000]}
            if dead_grant:
                values["status"] = SalesChannelConnection.Status.NEEDS_RECONNECT
            guarded_connection_update(
                self.connection,
                require_active=True,
                **values,
            )
            raise SyncFailed(message) from exc
        except square.SquareError as exc:
            guarded_connection_update(
                self.connection,
                require_active=True,
                last_error=str(exc)[:1000],
            )
            raise SyncFailed(str(exc)) from exc
        except TokenCryptoError as exc:
            logger.exception(
                "Token decryption failed for connection %s", self.connection.pk
            )
            guarded_connection_update(
                self.connection,
                require_active=True,
                last_error="Stored credentials could not be read",
            )
            raise SyncFailed(
                f"{self.provider.title()} credentials could not be read — "
                "reconnect in Settings."
            ) from exc

    def _acquire(
        self,
        *,
        since: datetime,
        until: datetime,
        backfilling: bool,
        time_budget_s: int,
    ) -> NormalizedSalesBatch:
        raise NotImplementedError


class SquareSalesAdapter(_BaseSalesAdapter):
    provider = SalesImport.Channel.SQUARE

    def _acquire(
        self,
        *,
        since: datetime,
        until: datetime,
        backfilling: bool,
        time_budget_s: int,
    ) -> NormalizedSalesBatch:
        self.token = ensure_fresh_square_token(self.connection)
        deadline = time_module.monotonic() + time_budget_s
        cursor = self._session_cursor(
            since=since, until=until, backfilling=backfilling
        )
        location_ids = list(cursor["locationIds"])
        location_timezones = dict(cursor["locationTimezones"])
        batch = NormalizedSalesBatch(
            entries=[],
            sync_cursor=cursor,
            location_ids=location_ids,
            location_timezones=location_timezones,
            session_end=parse_provider_datetime(cursor["endAt"]),
        )
        catalog: dict[str, dict] = {}

        while (
            cursor["chunkIndex"] < len(cursor["chunks"])
            and batch.pages < PAGE_CAP
            and time_module.monotonic() <= deadline
        ):
            chunk = cursor["chunks"][cursor["chunkIndex"]]
            prior_provider_cursor = chunk.get("providerCursor")
            orders, next_provider_cursor = square.search_orders_page(
                self.token,
                chunk["locationIds"],
                field=chunk["field"],
                start_at=chunk["startAt"],
                end_at=cursor["endAt"],
                cursor=prior_provider_cursor,
            )
            batch.pages += 1
            page_lines = [
                line
                for order in orders
                for line in (
                    (order.get("line_items") or [])
                    + [
                        item
                        for group in order.get("returns") or []
                        for item in group.get("return_line_items") or []
                    ]
                )
            ]
            unseen = {
                line.get("catalog_object_id")
                for line in page_lines
                if line.get("catalog_object_id")
                and line.get("catalog_object_id") not in catalog
            }
            unseen.update(
                modifier.get("catalog_object_id")
                for line in page_lines
                if line.get("item_type") != "GIFT_CARD"
                for modifier in (
                    line.get("modifiers") or line.get("return_modifiers") or []
                )
                if isinstance(modifier, dict)
                and modifier.get("catalog_object_id")
                and not clean_text(modifier.get("name"), 255)
                and modifier.get("catalog_object_id") not in catalog
            )
            if unseen:
                catalog.update(
                    square.batch_retrieve_catalog(self.token, sorted(unseen))
                )
            for order in orders:
                location_id = clean_text(order.get("location_id"), 200)
                if location_id not in location_timezones:
                    # A location may be moved or restored while a long session
                    # is in flight. Refresh exactly once before treating the
                    # provider row as unresolvable.
                    _, refreshed_timezones = self._locations()
                    location_timezones = refreshed_timezones
                    batch.location_timezones = refreshed_timezones
                    cursor["locationTimezones"] = refreshed_timezones
                if location_id not in location_timezones:
                    raise SyncFailed(
                        "Square returned an order for an unknown location. "
                        "Try the sync again after reconnecting Square."
                    )
                entries, counts = square_order_entries(
                    order,
                    catalog,
                    self.connection,
                    location_timezones=location_timezones,
                )
                batch.entries.extend(entries)
                batch.malformed_lines += counts["malformed_lines"]
                batch.malformed_modifiers += counts["malformed_modifiers"]
                marker = parse_provider_datetime(order.get(chunk["field"]))
                if marker is not None:
                    batch.max_timestamp = marker
            if next_provider_cursor:
                if next_provider_cursor == prior_provider_cursor:
                    raise SyncFailed(
                        "Square repeated an orders cursor; the sync stopped "
                        "before replaying a page."
                    )
                chunk["providerCursor"] = next_provider_cursor
            else:
                cursor["chunkIndex"] += 1
        if cursor["chunkIndex"] >= len(cursor["chunks"]):
            batch.sync_cursor = {}
            batch.partial = False
        else:
            batch.sync_cursor = cursor
            batch.partial = True
        return batch

    def _locations(self) -> tuple[list[str], dict[str, str]]:
        rows = square.list_locations(self.token)
        active = [row for row in rows if row.get("status", "ACTIVE") == "ACTIVE"]
        usable = active or rows
        if not usable:
            raise SyncFailed(
                "No Square locations are available — reconnect Square in Settings."
            )
        currencies = {
            clean_text(row.get("currency"), 3) for row in usable if row.get("currency")
        }
        if currencies and currencies != {self.connection.currency_code}:
            raise SyncFailed(
                "Square locations use a different currency than this connection. "
                "Reconnect Square in Settings."
            )
        location_ids: list[str] = []
        location_timezones: dict[str, str] = {}
        for row in usable:
            location_id = clean_text(row.get("id"), 200)
            timezone_name = clean_text(row.get("timezone"), 64)
            if not location_id or not timezone_name:
                raise SyncFailed(
                    "Square returned a location without a usable timezone."
                )
            try:
                ZoneInfo(timezone_name)
            except Exception as exc:
                raise SyncFailed(
                    f"Square location {location_id} has an unsupported timezone."
                ) from exc
            location_ids.append(location_id)
            location_timezones[location_id] = timezone_name
        return location_ids, location_timezones

    def _session_cursor(
        self, *, since: datetime, until: datetime, backfilling: bool
    ) -> JsonObject:
        # Acquisition mutates the candidate cursor page by page. Copy the
        # model value so a provider failure cannot make an uncommitted cursor
        # appear advanced to another call reusing this Python object.
        existing = json.loads(json.dumps(self.connection.sync_cursor or {}))
        if existing:
            if (
                existing.get("version") != 1
                or existing.get("provider") != SalesImport.Channel.SQUARE
                or not isinstance(existing.get("chunks"), list)
                or not isinstance(existing.get("chunkIndex"), int)
                or not isinstance(existing.get("locationIds"), list)
                or not isinstance(existing.get("locationTimezones"), dict)
            ):
                raise SyncFailed(
                    "Stored Square sync progress is invalid. Reconnect Square "
                    "to start a clean session."
                )
            return existing

        location_ids, location_timezones = self._locations()
        old_ids = set(self.connection.location_ids or [])
        new_ids = [value for value in location_ids if value not in old_ids]
        existing_ids = [value for value in location_ids if value in old_ids]
        groups: list[tuple[list[str], str, datetime]] = []
        if backfilling:
            groups.append((location_ids, "closed_at", since))
        else:
            if existing_ids:
                groups.append((existing_ids, "updated_at", since))
            if new_ids:
                groups.append(
                    (new_ids, "closed_at", until - timedelta(days=BACKFILL_DAYS))
                )
        chunks = [
            {
                "locationIds": ids[start : start + square.LOCATION_CHUNK],
                "field": field,
                "startAt": start_at.isoformat(),
                "providerCursor": None,
            }
            for ids, field, start_at in groups
            for start in range(0, len(ids), square.LOCATION_CHUNK)
        ]
        return {
            "version": 1,
            "provider": SalesImport.Channel.SQUARE,
            "endAt": until.isoformat(),
            "locationIds": location_ids,
            "locationTimezones": location_timezones,
            "chunks": chunks,
            "chunkIndex": 0,
        }

    def category_labels(self, object_ids: list[str]) -> dict[str, str]:
        if not object_ids:
            return {}
        catalog = square.batch_retrieve_catalog(self.token, object_ids)
        return {
            object_id: clean_text(row.get("category"), 120)
            for object_id, row in catalog.items()
        }

    def modifier_lists(
        self, *, deadline: float | None = None
    ) -> list[JsonObject]:
        self.token = ensure_fresh_square_token(self.connection)
        try:
            return square.list_modifier_lists(self.token, deadline=deadline)
        except square.SquareGrantRevoked as exc:
            message = "Square access has expired. Reconnect in Settings."
            guarded_connection_update(
                self.connection,
                require_active=True,
                status=SalesChannelConnection.Status.NEEDS_RECONNECT,
                last_error=message,
            )
            raise SyncFailed(message) from exc
        except square.SquareError as exc:
            guarded_connection_update(
                self.connection,
                require_active=True,
                last_error=str(exc)[:1000],
            )
            raise SyncFailed(str(exc)) from exc

    def product_catalog_items(
        self, *, deadline: float | None = None
    ) -> list[JsonObject]:
        self.token = ensure_fresh_square_token(self.connection)
        try:
            return square.list_catalog_items(self.token, deadline=deadline)
        except square.SquareGrantRevoked as exc:
            message = "Square access has expired. Reconnect in Settings."
            guarded_connection_update(
                self.connection,
                require_active=True,
                status=SalesChannelConnection.Status.NEEDS_RECONNECT,
                last_error=message,
            )
            raise SyncFailed(message) from exc
        except square.SquareError as exc:
            guarded_connection_update(
                self.connection,
                require_active=True,
                last_error=str(exc)[:1000],
            )
            raise SyncFailed(str(exc)) from exc


class ShopifySalesAdapter(_BaseSalesAdapter):
    provider = SalesImport.Channel.SHOPIFY

    def _acquire(
        self,
        *,
        since: datetime,
        until: datetime,
        backfilling: bool,
        time_budget_s: int,
    ) -> NormalizedSalesBatch:
        del until, backfilling
        self.token = ensure_fresh_shopify_token(self.connection)
        deadline = time_module.monotonic() + time_budget_s
        batch = NormalizedSalesBatch(entries=[])

        def budget_left() -> bool:
            batch.pages += 1
            if time_module.monotonic() > deadline or batch.pages >= PAGE_CAP:
                batch.partial = True
                return False
            return True

        def on_page(orders: list[dict]) -> bool:
            for order in orders:
                if order.get("test"):
                    continue
                entries, truncated = shopify_order_entries(order, self.connection)
                batch.entries.extend(entries)
                if truncated:
                    batch.warnings += truncated
                    batch.partial = True
                    return False
                marker = parse_provider_datetime(order.get("updatedAt"))
                if marker is not None:
                    batch.max_timestamp = marker
            return budget_left()

        shopify.fetch_sales_agreements(
            self.connection.shop_domain,
            self.token,
            since_iso=since.isoformat(),
            on_page=on_page,
            should_continue=lambda: time_module.monotonic() <= deadline,
        )
        return batch

    def category_labels(self, object_ids: list[str]) -> dict[str, str]:
        if not object_ids:
            return {}
        return shopify.fetch_product_categories(
            self.connection.shop_domain, self.token, object_ids
        )

    def product_catalog_items(
        self, *, deadline: float | None = None
    ) -> list[JsonObject]:
        self.token = ensure_fresh_shopify_token(self.connection)
        try:
            return shopify.list_catalog_items(
                self.connection.shop_domain, self.token, deadline=deadline
            )
        except shopify.ShopifyAuthError as exc:
            message = "Shopify access has expired. Reconnect in Settings."
            guarded_connection_update(
                self.connection,
                require_active=True,
                status=SalesChannelConnection.Status.NEEDS_RECONNECT,
                last_error=message,
            )
            raise SyncFailed(message) from exc
        except shopify.ShopifyError as exc:
            guarded_connection_update(
                self.connection,
                require_active=True,
                last_error=str(exc)[:1000],
            )
            raise SyncFailed(str(exc)) from exc


def get_pos_sales_adapter(connection: SalesChannelConnection) -> PosSalesAdapter:
    if connection.provider == SalesImport.Channel.SQUARE:
        return SquareSalesAdapter(connection)
    if connection.provider == SalesImport.Channel.SHOPIFY:
        return ShopifySalesAdapter(connection)
    raise SyncFailed("This channel does not support API sync")


def ensure_fresh_shopify_token(connection: SalesChannelConnection) -> str:
    """Return a usable Shopify token, re-minting expiring ones.

    Legacy admin custom apps (pre-2026) have permanent shpat_ tokens and no
    stored credential — those pass straight through. Dev Dashboard apps store
    client credentials (client id in merchant_id, secret encrypted in the
    refresh slot) and their minted tokens die every ~24h.
    """
    if not connection.refresh_token_encrypted:
        return decrypt_token(connection.access_token_encrypted)
    if (
        connection.token_expires_at is not None
        and connection.token_expires_at > timezone.now() + timedelta(minutes=5)
    ):
        return decrypt_token(connection.access_token_encrypted)
    prior_secret = connection.refresh_token_encrypted
    try:
        minted = shopify.client_credentials_token(
            connection.shop_domain,
            connection.merchant_id,
            decrypt_token(prior_secret),
        )
    except shopify.ShopifyAuthError:
        guarded_connection_update(
            connection,
            require_active=True,
            status=SalesChannelConnection.Status.NEEDS_RECONNECT,
            last_error="Shopify rejected the app credentials — reconnect Shopify",
        )
        raise SyncFailed(
            "Shopify rejected the app credentials. Check the app is still "
            "installed, then reconnect in Settings."
        )
    access_encrypted = encrypt_token(minted["access_token"])
    expires_at = timezone.now() + timedelta(
        seconds=int(minted.get("expires_in") or 86000)
    )
    updated = SalesChannelConnection.objects.filter(
        pk=connection.pk,
        user_id=connection.user_id,
        provider=connection.provider,
        provider_account_id=connection.provider_account_id,
        generation=connection.generation,
        status=SalesChannelConnection.Status.ACTIVE,
        refresh_token_encrypted=prior_secret,
    ).update(
        access_token_encrypted=access_encrypted,
        token_expires_at=expires_at,
        updated_at=timezone.now(),
    )
    if updated != 1:
        raise SyncFailed(
            "The provider connection changed while its token was refreshing."
        )
    connection.access_token_encrypted = access_encrypted
    connection.token_expires_at = expires_at
    return decrypt_token(connection.access_token_encrypted)


def normalize_shop_domain(value: str) -> str:
    """Vendor-shaped validation of a myshopify store domain."""

    return shopify.validate_shop_domain(value)


def shopify_credentials_connection_fields(
    shop: str, client_id: str, client_secret: str
) -> JsonObject:
    """Mint a Dev Dashboard token and normalize the account it opens.

    Since Jan 1, 2026 merchants can't create admin custom apps, and Dev
    Dashboard apps expose no copyable token — only client id + secret, which
    we exchange for ~24h tokens (client_credentials grant, same-organization
    stores only).
    """
    try:
        minted = shopify.client_credentials_token(
            shop, client_id, client_secret
        )
    except shopify.ShopifyError:
        raise ValueError(
            "Shopify rejected those credentials. Check the Client ID and "
            "secret, that the app is installed on this store, and that the "
            "app was created in this store's own organization."
        )
    scopes = minted.get("scope", "")
    if "read_orders" not in scopes.split(","):
        raise ValueError(
            "That app can't read orders — add the read_orders scope to its "
            "released version, then try again."
        )
    token = minted["access_token"]
    try:
        info = shopify.fetch_shop_info(shop, token)
    except shopify.ShopifyError:
        raise ValueError(
            "The app connected but Shopify rejected an API call — check the "
            "app's scopes and installation."
        )
    return {
        "access_token_encrypted": encrypt_token(token),
        "refresh_token_encrypted": encrypt_token(client_secret),
        "token_expires_at": timezone.now()
        + timedelta(seconds=int(minted.get("expires_in") or 86000)),
        "merchant_id": client_id,
        "shop_domain": shop,
        "scopes": scopes,
        "provider_timezone": info["timezone"],
        "currency_code": info["currency"],
    }


def shopify_token_connection_fields(shop: str, token: str) -> JsonObject:
    """Prove a pasted store-admin token reads orders, then normalize it.

    The merchant creates the app themselves (store admin → Develop apps),
    grants read_orders, installs it, and pastes the Admin API access token.
    No Partner app, no OAuth, no protected-customer-data review — and
    store-created custom apps aren't subject to the 60-day order limit.
    """
    if token.startswith("shpss_"):
        raise ValueError(
            "That's the API secret key — paste the Admin API access token "
            "instead (it starts with shpat_ and is revealed once after you "
            "install the app)."
        )
    try:
        info = shopify.fetch_token_info(shop, token)
    except shopify.ShopifyError:
        raise ValueError(
            "Shopify rejected that token. Check the store domain, that the "
            "app is installed, and that the full token was copied."
        )
    if "read_orders" not in info["scopes"]:
        raise ValueError(
            "That app can't read orders — edit its Admin API scopes to "
            "include read_orders, then paste the token again."
        )
    return {
        "access_token_encrypted": encrypt_token(token),
        "refresh_token_encrypted": "",
        "token_expires_at": None,
        "shop_domain": shop,
        "scopes": ",".join(info["scopes"]),
        "provider_timezone": info["timezone"],
        "currency_code": info["currency"],
    }


def square_token_connection_fields(token: str) -> JsonObject:
    """Prove a console-issued Square token reads the account, then normalize it.

    Square's sandbox console authorizes test accounts directly and exposes an
    access token there. Validating it with ListLocations proves it can read the
    sales data before we store its encrypted form.
    """
    try:
        locations = square.list_locations(token)
    except square.SquareError:
        raise ValueError(
            "Square rejected that token. In the Square Developer Console, "
            "copy the access token for an authorized sandbox test account."
        )
    active = [
        row for row in locations if row.get("status", "ACTIVE") == "ACTIVE"
    ]
    usable = active or locations
    if not usable:
        raise ValueError(
            "Square accepted that token, but the account has no locations to "
            "sync."
        )
    main = usable[0]
    return {
        "access_token_encrypted": encrypt_token(token),
        "refresh_token_encrypted": "",
        "token_expires_at": None,
        "merchant_id": main.get("merchant_id", ""),
        "location_ids": [row["id"] for row in usable],
        "location_timezones": {
            row["id"]: row.get("timezone", "UTC") for row in usable
        },
        "scopes": "ORDERS_READ ITEMS_READ MERCHANT_PROFILE_READ",
        "provider_timezone": main.get("timezone", "UTC"),
        "currency_code": main.get("currency", "USD"),
    }


def revoke_square_access(merchant_id: str) -> None:
    """Tell Square to drop the authorization behind a stored connection."""

    square.revoke_access(merchant_id)
