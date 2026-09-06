"""Thin Square API client over stdlib urllib (house style — see shopify.py).

Token endpoints are NEVER retried: Square rotates the refresh token on every
use, so a blind retry can persist a stale pair and strand the connection.
Data endpoints stream page-by-page through an ``on_page`` callback so a large
window never accumulates in memory.
"""

import json
import logging
import time as time_module
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

SQUARE_VERSION = "2025-01-23"
PAGE_LIMIT = 200
CATALOG_CHUNK = 500
# POST /v2/orders/search rejects more than 10 location_ids outright.
LOCATION_CHUNK = 10
REQUEST_TIMEOUT_S = 15
# Sync runs inside a request under a 40s budget and a 60s worker timeout, so
# its calls give up well before the worker does.
SYNC_TIMEOUT_S = 10


class SquareError(Exception):
    """Transient or unexpected Square failure — safe to retry a whole sync."""


class SquareGrantRevoked(SquareError):
    """The merchant's grant is conclusively dead — reconnect required."""


def base_url() -> str:
    if settings.SQUARE_ENVIRONMENT == "production":
        return "https://connect.squareup.com"
    return "https://connect.squareupsandbox.com"


def _request(
    path: str,
    *,
    method: str = "POST",
    payload: dict | None = None,
    token: str | None = None,
    timeout: float = REQUEST_TIMEOUT_S,
) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
        "User-Agent": "forkluck-backend/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{base_url()}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:500]
        logger.warning("Square %s %s failed: %s %s", method, path, exc.code, body)
        if exc.code in (401, 403):
            raise SquareGrantRevoked("Square connection needs to be reauthorized")
        raise SquareError(f"Square request failed ({exc.code})")
    except urllib.error.URLError as exc:
        logger.warning("Square unreachable for %s: %s", path, exc)
        raise SquareError("Square could not be reached")
    except json.JSONDecodeError as exc:
        raise SquareError("Square returned an unreadable response") from exc


def authorize_url(state: str) -> str:
    params = {
        "client_id": settings.SQUARE_APPLICATION_ID,
        "scope": "ORDERS_READ ITEMS_READ MERCHANT_PROFILE_READ",
        "state": state,
        "redirect_uri": redirect_uri(),
    }
    # session=false forces a fresh Square login — right for production, but
    # sandbox test sellers have no login page, so it renders a blank screen;
    # sandbox must reuse the console-established seller session instead.
    if settings.SQUARE_ENVIRONMENT == "production":
        params["session"] = "false"
    query = urllib.parse.urlencode(params)
    return f"{base_url()}/oauth2/authorize?{query}"


def redirect_uri() -> str:
    return f"{settings.FORKLUCK_APP_ORIGIN}/api/integrations/square/callback"


def _token_request(payload: dict, *, timeout: float = REQUEST_TIMEOUT_S) -> dict:
    body = _request(
        "/oauth2/token",
        payload={
            "client_id": settings.SQUARE_APPLICATION_ID,
            "client_secret": settings.SQUARE_APPLICATION_SECRET,
            **payload,
        },
        timeout=timeout,
    )
    if not body.get("access_token"):
        raise SquareError("Square token response was missing the access token")
    return body


def exchange_code(code: str) -> dict:
    return _token_request(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri(),
        }
    )


def refresh_access_token(refresh_token: str) -> dict:
    # The caller holds a row lock across this call, so it takes the sync budget
    # rather than the longer interactive one.
    return _token_request(
        {"grant_type": "refresh_token", "refresh_token": refresh_token},
        timeout=SYNC_TIMEOUT_S,
    )


def revoke_access(merchant_id: str) -> None:
    """Best-effort: a failed revoke must not block disconnect."""
    headers = {
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
        "User-Agent": "forkluck-backend/1.0",
        "Authorization": f"Client {settings.SQUARE_APPLICATION_SECRET}",
    }
    request = urllib.request.Request(
        f"{base_url()}/oauth2/revoke",
        data=json.dumps(
            {
                "client_id": settings.SQUARE_APPLICATION_ID,
                "merchant_id": merchant_id,
            }
        ).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        logger.warning("Square revoke for %s failed: %s", merchant_id, exc)


def list_locations(token: str) -> list[dict]:
    body = _request("/v2/locations", method="GET", token=token)
    return [
        {
            "id": row.get("id", ""),
            "merchant_id": row.get("merchant_id", ""),
            "name": row.get("name", ""),
            "timezone": row.get("timezone", "UTC"),
            "currency": row.get("currency", "USD"),
            "status": row.get("status", "ACTIVE"),
        }
        for row in body.get("locations", [])
        if row.get("id")
    ]


def _catalog_int(value, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def list_modifier_lists(
    token: str, *, deadline: float | None = None
) -> list[dict]:
    """Return Square's active modifier lists with their nested options.

    ListCatalog returns top-level ``MODIFIER_LIST`` objects in pages of 100;
    each list carries its ``MODIFIER`` children inline. Text modifier lists
    are retained (with no selectable children) so the UI can distinguish them
    from a failed or incomplete import.
    """

    result: list[dict] = []
    cursor = ""
    seen_cursors: set[str] = set()
    while True:
        timeout = float(SYNC_TIMEOUT_S)
        if deadline is not None:
            remaining = deadline - time_module.monotonic()
            if remaining <= 0:
                raise SquareError("Square modifier catalog refresh timed out")
            timeout = min(timeout, remaining)
        params = {"types": "MODIFIER_LIST"}
        if cursor:
            params["cursor"] = cursor
        body = _request(
            f"/v2/catalog/list?{urllib.parse.urlencode(params)}",
            method="GET",
            token=token,
            timeout=timeout,
        )
        if body.get("errors"):
            raise SquareError(f"Square catalog list failed: {body['errors']!r}")
        for obj in body.get("objects", []) or []:
            if obj.get("type") != "MODIFIER_LIST" or obj.get("is_deleted"):
                continue
            object_id = obj.get("id")
            data = obj.get("modifier_list_data") or {}
            if not isinstance(object_id, str) or not object_id:
                continue
            options = []
            for modifier in data.get("modifiers", []) or []:
                if (
                    not isinstance(modifier, dict)
                    or modifier.get("type") != "MODIFIER"
                    or modifier.get("is_deleted")
                ):
                    continue
                modifier_id = modifier.get("id")
                modifier_data = modifier.get("modifier_data") or {}
                if not isinstance(modifier_id, str) or not modifier_id:
                    continue
                money = modifier_data.get("price_money") or {}
                amount = money.get("amount")
                options.append(
                    {
                        "external_object_id": modifier_id,
                        "name": str(modifier_data.get("name") or "")[:255],
                        "ordinal": _catalog_int(modifier_data.get("ordinal")),
                        "price_cents": (
                            amount
                            if isinstance(amount, int)
                            and not isinstance(amount, bool)
                            else None
                        ),
                        "currency_code": str(money.get("currency") or "")[:3],
                    }
                )
            result.append(
                {
                    "external_object_id": object_id,
                    "name": str(data.get("name") or "Unnamed modifier list")[:255],
                    "modifier_type": str(data.get("modifier_type") or "LIST")
                    .strip()
                    .lower()[:16],
                    "selection_type": str(data.get("selection_type") or "")
                    .strip()
                    .lower()[:16],
                    "ordinal": _catalog_int(data.get("ordinal")),
                    "allow_quantities": data.get("allow_quantities") is True,
                    "min_selected": _catalog_int(
                        data.get("min_selected_modifiers"), -1
                    ),
                    "max_selected": _catalog_int(
                        data.get("max_selected_modifiers"), -1
                    ),
                    "options": options,
                }
            )
        next_cursor = body.get("cursor") or ""
        if not isinstance(next_cursor, str) or not next_cursor:
            break
        if next_cursor in seen_cursors:
            raise SquareError("Square catalog pagination repeated a cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return result


def list_catalog_items(token: str, *, deadline: float | None = None) -> list[dict]:
    """Return every live Square item variation with its current item metadata.

    ``ListCatalog`` returns ITEM variations nested under their parent ITEM and
    CATEGORY objects as independent records.  Collect the whole successful
    walk before normalizing so categories work regardless of which page they
    appeared on.  A failure (including a deadline or repeated cursor) raises;
    callers must then retain the prior persisted catalog rather than treating
    a partial walk as a complete empty catalog.
    """
    items: list[dict] = []
    categories: dict[str, str] = {}
    cursor = ""
    seen_cursors: set[str] = set()
    while True:
        timeout = float(SYNC_TIMEOUT_S)
        if deadline is not None:
            remaining = deadline - time_module.monotonic()
            if remaining <= 0:
                raise SquareError("Square product catalog refresh timed out")
            timeout = min(timeout, remaining)
        params = {"types": "ITEM,CATEGORY"}
        if cursor:
            params["cursor"] = cursor
        body = _request(
            f"/v2/catalog/list?{urllib.parse.urlencode(params)}",
            method="GET",
            token=token,
            timeout=timeout,
        )
        if body.get("errors"):
            raise SquareError(f"Square catalog list failed: {body['errors']!r}")
        for obj in body.get("objects", []) or []:
            if not isinstance(obj, dict) or obj.get("is_deleted"):
                continue
            if obj.get("type") == "CATEGORY":
                category_id = obj.get("id")
                if isinstance(category_id, str) and category_id:
                    categories[category_id] = str(
                        (obj.get("category_data") or {}).get("name") or ""
                    )[:120]
            elif obj.get("type") == "ITEM":
                items.append(obj)
        next_cursor = body.get("cursor") or ""
        if not isinstance(next_cursor, str) or not next_cursor:
            break
        if next_cursor in seen_cursors:
            raise SquareError("Square catalog pagination repeated a cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor

    result: list[dict] = []
    for item in items:
        item_data = item.get("item_data") or {}
        if not isinstance(item_data, dict):
            continue
        category = categories.get(item_category_id(item_data), "")
        item_name = str(item_data.get("name") or "Unnamed item")[:240]
        for variation in item_data.get("variations", []) or []:
            if not isinstance(variation, dict) or variation.get("is_deleted"):
                continue
            if variation.get("type") not in (None, "ITEM_VARIATION"):
                continue
            variation_id = variation.get("id")
            if not isinstance(variation_id, str) or not variation_id:
                continue
            variation_data = variation.get("item_variation_data") or {}
            if not isinstance(variation_data, dict):
                variation_data = {}
            result.append(
                {
                    "external_object_id": variation_id,
                    "sku": str(variation_data.get("sku") or "")[:120],
                    "item_name": item_name,
                    "variant_name": str(variation_data.get("name") or "")[:200],
                    "category": category,
                    "is_active": True,
                }
            )
    return result


def search_orders_page(
    token: str,
    location_ids: list[str],
    *,
    field: str,
    start_at: str,
    end_at: str,
    cursor: str | None = None,
) -> tuple[list[dict], str | None]:
    """Fetch one bounded Square page for one <=10-location chunk."""

    if not location_ids or len(location_ids) > LOCATION_CHUNK:
        raise ValueError("Square order pages require 1-10 locations")
    payload = {
        "location_ids": location_ids,
        "limit": PAGE_LIMIT,
        "return_entries": False,
        "query": {
            "filter": {
                "state_filter": {"states": ["COMPLETED"]},
                "date_time_filter": {
                    field: {"start_at": start_at, "end_at": end_at}
                },
            },
            "sort": {
                "sort_field": field.upper(),
                "sort_order": "ASC",
            },
        },
    }
    if cursor:
        payload["cursor"] = cursor
    body = _request(
        "/v2/orders/search",
        payload=payload,
        token=token,
        timeout=SYNC_TIMEOUT_S,
    )
    if body.get("errors"):
        raise SquareError(f"Square order search failed: {body['errors']!r}")
    orders = [row for row in body.get("orders", []) or [] if isinstance(row, dict)]
    next_cursor = body.get("cursor")
    return orders, next_cursor if isinstance(next_cursor, str) and next_cursor else None


def item_category_id(item_data: dict) -> str:
    """The one category id worth showing for a catalog item.

    Square has shipped three shapes over time and a merchant catalog can carry
    all of them at once, so every one is read defensively:

    * ``reporting_category`` — the single category Square's own reports use;
      preferred whenever present.
    * ``categories[]`` — ``{"id", "ordinal"}`` entries since an item may sit in
      several categories; the lowest ordinal wins, ties break on id so the
      answer is stable across syncs.
    * ``category_id`` — the pre-2023 single-category field, still populated on
      older catalogs.

    Anything unreadable yields "" rather than raising: a missing category only
    costs the review inbox a grouping hint.
    """
    reporting = item_data.get("reporting_category")
    if isinstance(reporting, dict) and isinstance(reporting.get("id"), str):
        if reporting["id"]:
            return reporting["id"]
    elif isinstance(reporting, str) and reporting:
        return reporting

    categories = item_data.get("categories")
    if isinstance(categories, list):
        ranked: list[tuple[int, str]] = []
        for entry in categories:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                if not entry["id"]:
                    continue
                ordinal = entry.get("ordinal")
                if isinstance(ordinal, bool) or not isinstance(ordinal, int):
                    ordinal = 0
                ranked.append((ordinal, entry["id"]))
            elif isinstance(entry, str) and entry:
                ranked.append((0, entry))
        if ranked:
            return min(ranked)[1]

    legacy = item_data.get("category_id")
    if isinstance(legacy, str) and legacy:
        return legacy
    return ""


def batch_retrieve_catalog(token: str, object_ids: list[str]) -> dict[str, dict]:
    """Map catalog object ids to {"sku", "item_name", "variant_name", "kind",
    "category"}.

    Deleted objects are included — an order line can reference a variation
    that was removed from the catalog after the sale. MODIFIER objects are
    collected too, for their display name only: Square catalog modifiers are
    not required to carry a SKU, so nothing may depend on one.

    ``include_related_objects`` walks exactly one level, so retrieving a
    VARIATION returns its parent ITEM but not that item's CATEGORY objects. Any
    category id still missing a name after the main pass is therefore resolved
    in a second, best-effort batch — a failure there costs the display name and
    nothing else.
    """
    result: dict[str, dict] = {}
    items: dict[str, dict] = {}
    categories: dict[str, str] = {}
    variations: list[dict] = []
    modifiers: list[dict] = []

    def collect(obj: dict) -> None:
        if obj.get("type") == "ITEM":
            items[obj.get("id", "")] = obj
            for variation in obj.get("item_data", {}).get("variations", []):
                collect(variation)
        elif obj.get("type") == "ITEM_VARIATION":
            variations.append(obj)
        elif obj.get("type") == "MODIFIER":
            modifiers.append(obj)
        elif obj.get("type") == "MODIFIER_LIST":
            for modifier in obj.get("modifier_list_data", {}).get("modifiers", []):
                collect(modifier)
        elif obj.get("type") == "CATEGORY":
            category_id = obj.get("id", "")
            if category_id:
                categories[category_id] = (
                    obj.get("category_data", {}).get("name", "") or ""
                )

    for start in range(0, len(object_ids), CATALOG_CHUNK):
        body = _request(
            "/v2/catalog/batch-retrieve",
            payload={
                "object_ids": object_ids[start : start + CATALOG_CHUNK],
                "include_related_objects": True,
                "include_deleted_objects": True,
            },
            token=token,
            timeout=SYNC_TIMEOUT_S,
        )
        for obj in body.get("objects", []) or []:
            collect(obj)
        for obj in body.get("related_objects", []) or []:
            collect(obj)

    item_categories = {
        item_id: item_category_id(item.get("item_data", {}) or {})
        for item_id, item in items.items()
    }
    unnamed = sorted(
        {
            category_id
            for category_id in item_categories.values()
            if category_id and category_id not in categories
        }
    )
    for start in range(0, len(unnamed), CATALOG_CHUNK):
        try:
            body = _request(
                "/v2/catalog/batch-retrieve",
                payload={
                    "object_ids": unnamed[start : start + CATALOG_CHUNK],
                    "include_related_objects": False,
                    "include_deleted_objects": True,
                },
                token=token,
                timeout=SYNC_TIMEOUT_S,
            )
        except SquareError:
            logger.warning("Square category names could not be resolved")
            break
        for obj in body.get("objects", []) or []:
            collect(obj)

    for variation in variations:
        data = variation.get("item_variation_data", {})
        item_id = data.get("item_id", "")
        item = items.get(item_id, {})
        result[variation.get("id", "")] = {
            "sku": data.get("sku", "") or "",
            "item_name": item.get("item_data", {}).get("name", "") or "",
            "variant_name": data.get("name", "") or "",
            "kind": "item",
            "category": categories.get(item_categories.get(item_id, ""), ""),
        }
    for modifier in modifiers:
        data = modifier.get("modifier_data", {})
        result.setdefault(
            modifier.get("id", ""),
            {
                "sku": "",
                "item_name": data.get("name", "") or "",
                "variant_name": "",
                "kind": "modifier",
                "category": "",
            },
        )
    return result
