"""Thin Shopify Admin API client over stdlib urllib.

Sales are read from the sales-agreements ledger (not order line items) so
refunds and order edits land on the day Shopify books them — the same basis
as the merchant's own analytics. A GraphQL response that carries `errors`
always raises: an error must never read as "no more pages", or the sync
would silently truncate.
"""

import hashlib
import hmac
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from django.conf import settings

logger = logging.getLogger(__name__)

# Shopify supports a stable version for 12 months and silently falls an
# inaccessible version forward to the oldest supported one, so a pin must be
# upgraded deliberately: 2025-07 retired 2026-07-16. Requests carry the pin and
# every response is checked against the version Shopify actually served.
API_VERSION = "2026-07"
MIN_SUPPORTED_API_VERSION = "2026-01"
# Shopify rejects queries costing >1000 points before running them, and cost
# is not linear in page size; MAX_COST_EXCEEDED triggers a halve-and-retry.
PAGE_SIZE = 25
MIN_PAGE_SIZE = 5
AGREEMENT_PAGE_SIZE = 10
SALE_PAGE_SIZE = 50
# Agreements are followed with their own cursor; the cap only stops a runaway
# order from eating the whole request budget, and leaves hasNextPage set so
# the caller knows the order was truncated.
AGREEMENT_PAGE_CAP = 20
THROTTLE_RETRIES = 5
THROTTLE_SLEEP_S = 1.5

SHOP_DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.myshopify\.com$")


def _same_iso_instant(left: str | None, right: str) -> bool:
    """Compare Shopify/Django ISO timestamps despite Z/+00:00 spelling."""
    if not left:
        return False
    try:
        return datetime.fromisoformat(left.replace("Z", "+00:00")) == datetime.fromisoformat(
            right.replace("Z", "+00:00")
        )
    except ValueError:
        return left == right

# read_orders covers the agreements ledger; read_all_orders unlocks history
# older than 60 days; read_products is what lets a line item name its catalog
# product/variant, the only identity that survives a title change (requested at
# install, granted subject to app approval).
REQUESTED_SCOPES = "read_orders,read_all_orders,read_products"

# The catalog identity fields need read_products; older tokens fall back to
# the SKU/name form. Every nested object added here multiplies across
# orders×agreements×sales toward Shopify's 1000-point query cost — which is
# why lineItemGroup is not queried even though pos_sync can store it.
LINE_ITEM_FIELDS = """
            lineItem {
              id
              name
              sku
              variantTitle
              variant { id }
              product { id productType category { name } }
            }"""

LINE_ITEM_FIELDS_BASIC = """
            lineItem { id name sku variantTitle }"""


def _agreement_fields(line_item_fields: str) -> str:
    return """
  nodes {
    id
    happenedAt
    sales(first: %(sales)d) {
      nodes {
        id
        actionType
        lineType
        quantity
        totalAmount { shopMoney { amount currencyCode } }
        totalDiscountAmountBeforeTaxes { shopMoney { amount } }
        totalTaxAmount { shopMoney { amount } }
        ... on ProductSale {%(line_item)s
        }
      }
      pageInfo { hasNextPage }
    }
  }
  pageInfo { hasNextPage endCursor }
""" % {"sales": SALE_PAGE_SIZE, "line_item": line_item_fields}


def _orders_query(line_item_fields: str) -> str:
    return """
query ForkluckSales($first: Int!, $after: String, $search: String!) {
  orders(first: $first, after: $after, query: $search, sortKey: UPDATED_AT) {
    nodes {
      id
      name
      test
      updatedAt
      cancelledAt
      agreements(first: %(agreements)d) {
%(agreement_fields)s
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
""" % {
        "agreements": AGREEMENT_PAGE_SIZE,
        "agreement_fields": _agreement_fields(line_item_fields),
    }


def _order_agreements_query(line_item_fields: str) -> str:
    return """
query ForkluckOrderAgreements($id: ID!, $first: Int!, $after: String!) {
  order(id: $id) {
    id
    agreements(first: $first, after: $after) {
%(agreement_fields)s
    }
  }
}
""" % {"agreement_fields": _agreement_fields(line_item_fields)}


ORDERS_QUERY = _orders_query(LINE_ITEM_FIELDS)
ORDERS_QUERY_BASIC = _orders_query(LINE_ITEM_FIELDS_BASIC)
ORDER_AGREEMENTS_QUERY = _order_agreements_query(LINE_ITEM_FIELDS)
ORDER_AGREEMENTS_QUERY_BASIC = _order_agreements_query(LINE_ITEM_FIELDS_BASIC)


class ShopifyError(Exception):
    pass


class ShopifyAuthError(ShopifyError):
    """401/403 — the credentials are bad or the app was uninstalled."""


class ShopifyFieldAccessError(ShopifyError):
    """A field the token's scopes don't cover. Not a dead grant: the rest of
    the query is still readable, so the caller may retry a narrower one."""


class ShopifyCostError(ShopifyError):
    """MAX_COST_EXCEEDED — the query was rejected before execution. Retry
    with a smaller page size; nothing was consumed."""


def validate_shop_domain(shop: str) -> str:
    shop = shop.strip().lower()
    if not SHOP_DOMAIN_RE.match(shop) or len(shop) > 120:
        raise ValueError("Enter your store's .myshopify.com domain")
    return shop


def verify_callback_hmac(params: dict[str, str]) -> bool:
    """Shopify signs the callback query with the app secret (HMAC-SHA256 over
    the sorted, hmac-stripped query string)."""
    received = params.get("hmac", "")
    rest = {key: value for key, value in params.items() if key != "hmac"}
    message = "&".join(
        f"{key}={value}" for key, value in sorted(rest.items())
    ).encode()
    expected = hmac.new(
        settings.SHOPIFY_API_SECRET.encode(), message, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(received, expected)


def authorize_url(shop: str, state: str) -> str:
    query = urllib.parse.urlencode(
        {
            "client_id": settings.SHOPIFY_API_KEY,
            "scope": REQUESTED_SCOPES,
            "redirect_uri": redirect_uri(),
            "state": state,
        }
    )
    return f"https://{shop}/admin/oauth/authorize?{query}"


def redirect_uri() -> str:
    return f"{settings.FORKLUCK_APP_ORIGIN}/api/integrations/shopify/callback"


_last_served_api_version = ""


def last_served_api_version() -> str:
    """The API version Shopify last served, for diagnostics only."""
    return _last_served_api_version


def _record_api_version(headers) -> None:
    """Note the version Shopify actually answered with.

    A mismatch means the pin fell forward (retired version) or a proxy rewrote
    it — the response is then not the contract this client was written against.
    """
    global _last_served_api_version
    try:
        served = (headers.get("X-Shopify-API-Version") or "").strip()
    except AttributeError:
        return
    if not served:
        return
    _last_served_api_version = served
    if served != API_VERSION:
        logger.warning(
            "Shopify served API version %s for a request pinned to %s",
            served,
            API_VERSION,
        )


def _post_json(
    url: str, payload: dict, headers: dict, *, timeout: float = 15
) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "forkluck-backend/1.0",
            **headers,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            _record_api_version(response.headers)
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        _record_api_version(getattr(exc, "headers", None) or {})
        body = exc.read().decode(errors="replace")[:500]
        logger.warning("Shopify POST %s failed: %s %s", url, exc.code, body)
        if exc.code in (401, 403):
            raise ShopifyAuthError("Shopify connection needs to be reauthorized")
        raise ShopifyError(f"Shopify request failed ({exc.code})")
    except urllib.error.URLError as exc:
        logger.warning("Shopify unreachable for %s: %s", url, exc)
        raise ShopifyError("Shopify could not be reached")
    except json.JSONDecodeError as exc:
        raise ShopifyError("Shopify returned an unreadable response") from exc


def client_credentials_token(shop: str, client_id: str, client_secret: str) -> dict:
    """Mint an access token for a merchant-created Dev Dashboard app.

    Since Jan 2026 merchants can't create admin custom apps with copyable
    tokens; Dev Dashboard apps hand out client credentials instead, and the
    minted tokens expire after ~24h (expires_in). Only works when the app and
    the store belong to the same Shopify organization.
    """
    body = _post_json(
        f"https://{shop}/admin/oauth/access_token",
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        {},
    )
    if not body.get("access_token"):
        raise ShopifyError("Shopify token response was missing the access token")
    return body


def exchange_code(shop: str, code: str) -> dict:
    body = _post_json(
        f"https://{shop}/admin/oauth/access_token",
        {
            "client_id": settings.SHOPIFY_API_KEY,
            "client_secret": settings.SHOPIFY_API_SECRET,
            "code": code,
        },
        {},
    )
    if not body.get("access_token"):
        raise ShopifyError("Shopify token response was missing the access token")
    return body


def graphql(
    shop: str,
    token: str,
    query: str,
    variables: dict,
    *,
    deadline: float | None = None,
) -> dict:
    throttled = 0
    while True:
        timeout = 15.0
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ShopifyError("Shopify GraphQL request timed out")
            timeout = min(timeout, remaining)
        body = _post_json(
            f"https://{shop}/admin/api/{API_VERSION}/graphql.json",
            {"query": query, "variables": variables},
            {"X-Shopify-Access-Token": token},
            timeout=timeout,
        )
        errors = body.get("errors") or []
        if errors:
            is_throttled = any(
                (error.get("extensions") or {}).get("code") == "THROTTLED"
                for error in errors
                if isinstance(error, dict)
            )
            if is_throttled and throttled < THROTTLE_RETRIES:
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= THROTTLE_SLEEP_S:
                        raise ShopifyError("Shopify GraphQL request timed out")
                throttled += 1
                time.sleep(THROTTLE_SLEEP_S)
                continue
            denied = any(
                (error.get("extensions") or {}).get("code") == "ACCESS_DENIED"
                for error in errors
                if isinstance(error, dict)
            )
            if denied:
                raise ShopifyFieldAccessError(
                    f"Shopify GraphQL denied a field: {errors!r}"[:500]
                )
            over_cost = any(
                (error.get("extensions") or {}).get("code")
                == "MAX_COST_EXCEEDED"
                for error in errors
                if isinstance(error, dict)
            )
            if over_cost:
                raise ShopifyCostError(
                    f"Shopify GraphQL query over cost limit: {errors!r}"[:500]
                )
            raise ShopifyError(f"Shopify GraphQL failed: {errors!r}"[:500])
        requested_cost = (
            ((body.get("extensions") or {}).get("cost") or {}).get(
                "requestedQueryCost"
            )
        )
        if isinstance(requested_cost, int) and requested_cost > 900:
            logger.warning(
                "Shopify query cost %s is close to the 1000-point limit",
                requested_cost,
            )
        data = body.get("data")
        if data is None:
            raise ShopifyError("Shopify GraphQL returned no data and no errors")
        return data


def fetch_shop_info(shop: str, token: str) -> dict:
    data = graphql(
        shop, token, "query { shop { ianaTimezone currencyCode } }", {}
    )
    info = data.get("shop") or {}
    return {
        "timezone": info.get("ianaTimezone") or "UTC",
        "currency": info.get("currencyCode") or "USD",
    }


def fetch_token_info(shop: str, token: str) -> dict:
    """Validate a pasted custom-app token: one query proves it works and
    returns the shop's settings plus the scopes the merchant granted."""
    data = graphql(
        shop,
        token,
        "query { shop { ianaTimezone currencyCode } "
        "currentAppInstallation { accessScopes { handle } } }",
        {},
    )
    info = data.get("shop") or {}
    installation = data.get("currentAppInstallation") or {}
    scopes = [
        row.get("handle", "")
        for row in installation.get("accessScopes") or []
        if row.get("handle")
    ]
    return {
        "timezone": info.get("ianaTimezone") or "UTC",
        "currency": info.get("currencyCode") or "USD",
        "scopes": scopes,
    }


PRODUCT_CATEGORY_CHUNK = 100

PRODUCT_CATEGORIES_QUERY = """
query ForkluckProductCategories($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product { id productType category { name } }
  }
}
"""


PRODUCT_VARIANTS_CATALOG_QUERY = """
query ForkluckProductVariantCatalog($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    nodes {
      id
      sku
      title
      product {
        title
        productType
        status
        category { name }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""


def list_catalog_items(
    shop: str, token: str, *, deadline: float | None = None
) -> list[dict]:
    """Return a complete Shopify ProductVariant catalog.

    Product variants are the stable sales identity, so this intentionally uses
    Shopify's top-level ``productVariants`` connection rather than nesting
    variants under products.  Never return a partial result: sync callers use
    a successful return as permission to deactivate missing local rows.
    """
    result: list[dict] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    page_size = PAGE_SIZE
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise ShopifyError("Shopify product catalog refresh timed out")
        try:
            data = graphql(
                shop,
                token,
                PRODUCT_VARIANTS_CATALOG_QUERY,
                {"first": page_size, "after": cursor},
                deadline=deadline,
            )
        except ShopifyCostError:
            if page_size <= MIN_PAGE_SIZE:
                raise
            page_size = max(MIN_PAGE_SIZE, page_size // 2)
            continue
        variants = data.get("productVariants") or {}
        for variant in variants.get("nodes") or []:
            if not isinstance(variant, dict):
                continue
            variant_id = variant.get("id")
            product = variant.get("product") or {}
            if not isinstance(variant_id, str) or not variant_id:
                continue
            if not isinstance(product, dict):
                product = {}
            result.append(
                {
                    "external_object_id": variant_id,
                    "sku": str(variant.get("sku") or "")[:120],
                    "item_name": str(product.get("title") or "Unnamed item")[:240],
                    "variant_name": str(variant.get("title") or "")[:200],
                    "category": product_category_label(product)[:120],
                    # Catalog activity means the variation was present in this
                    # complete provider snapshot, not that Shopify currently
                    # permits checkout. Draft and archived products are still
                    # catalog rows the merchant must be able to link/view.
                    "is_active": True,
                }
            )
        page_info = variants.get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            break
        next_cursor = page_info.get("endCursor")
        if not isinstance(next_cursor, str) or not next_cursor:
            raise ShopifyError(
                "Shopify product catalog pagination omitted a cursor"
            )
        if next_cursor in seen_cursors:
            raise ShopifyError(
                "Shopify product catalog pagination repeated a cursor"
            )
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return result


def product_category_label(product: dict) -> str:
    """The merchant's own productType wins; Shopify's taxonomy category
    fills in when no type was set."""
    product_type = (product.get("productType") or "").strip()
    if product_type:
        return product_type
    return ((product.get("category") or {}).get("name") or "").strip()


def fetch_product_categories(
    shop: str, token: str, product_ids: list[str]
) -> dict[str, str]:
    result: dict[str, str] = {}
    for start in range(0, len(product_ids), PRODUCT_CATEGORY_CHUNK):
        data = graphql(
            shop,
            token,
            PRODUCT_CATEGORIES_QUERY,
            {"ids": product_ids[start : start + PRODUCT_CATEGORY_CHUNK]},
        )
        for node in data.get("nodes") or []:
            if isinstance(node, dict) and node.get("id"):
                result[node["id"]] = product_category_label(node)
    return result


def complete_agreements(
    shop: str, token: str, order: dict, *, catalog_identity: bool = True
) -> None:
    """Follow an order's agreements cursor until the connection is exhausted.

    Mutates the order in place so callers see one full agreements list.
    `hasNextPage` stays true only when the page cap stopped the walk, which the
    caller must treat as truncated data.
    """
    agreements = order.get("agreements") or {}
    page_info = agreements.get("pageInfo") or {}
    nodes = list(agreements.get("nodes") or [])
    pages = 0
    first = AGREEMENT_PAGE_SIZE
    while page_info.get("hasNextPage") and page_info.get("endCursor"):
        if pages >= AGREEMENT_PAGE_CAP:
            break
        pages += 1
        try:
            data = graphql(
                shop,
                token,
                ORDER_AGREEMENTS_QUERY
                if catalog_identity
                else ORDER_AGREEMENTS_QUERY_BASIC,
                {
                    "id": order.get("id", ""),
                    "first": first,
                    "after": page_info["endCursor"],
                },
            )
        except ShopifyCostError:
            if first <= 1:
                raise
            first = max(1, first // 2)
            pages -= 1
            logger.warning(
                "Shopify agreement walk over cost limit; retrying with %s/page",
                first,
            )
            continue
        more = ((data.get("order") or {}).get("agreements")) or {}
        nodes.extend(more.get("nodes") or [])
        page_info = more.get("pageInfo") or {}
    order["agreements"] = {"nodes": nodes, "pageInfo": page_info}


def fetch_sales_agreements(
    shop: str,
    token: str,
    *,
    since_iso: str,
    on_page,
    should_continue=None,
) -> None:
    """Stream order nodes updated since `since_iso`, ascending.

    Calls on_page(order_nodes) per page; a falsy return stops paging. Each
    order arrives with its agreements connection already fully walked.
    should_continue is checked before starting another nested order walk.
    """
    after = None
    search = f"updated_at:>='{since_iso}'"
    catalog_identity = True
    page_size = PAGE_SIZE
    while True:
        try:
            data = graphql(
                shop,
                token,
                ORDERS_QUERY if catalog_identity else ORDERS_QUERY_BASIC,
                {"first": page_size, "after": after, "search": search},
            )
        except ShopifyFieldAccessError:
            if not catalog_identity:
                raise
            # A token minted before read_products was requested. Sales still
            # import; they resolve by SKU/name until the merchant reconnects.
            logger.warning(
                "Shopify token cannot read catalog identity; syncing without it"
            )
            catalog_identity = False
            continue
        except ShopifyCostError:
            if page_size <= MIN_PAGE_SIZE:
                raise
            # Rejected before execution — the same cursor retries smaller.
            page_size = max(MIN_PAGE_SIZE, page_size // 2)
            logger.warning(
                "Shopify query over cost limit; retrying with %s orders/page",
                page_size,
            )
            continue
        orders = data.get("orders")
        if orders is None:
            raise ShopifyError("Shopify GraphQL response was missing orders")
        nodes = orders.get("nodes", [])
        nested_walk_started = False
        for order in nodes:
            # Test orders are discarded by the importer, so spending the one
            # guaranteed nested walk on them can indefinitely starve a later
            # real order after the deadline expires.
            if order.get("test"):
                continue
            if ((order.get("agreements") or {}).get("pageInfo") or {}).get(
                "hasNextPage"
            ):
                replayed_boundary = _same_iso_instant(
                    order.get("updatedAt"), since_iso
                )
                # Completing one order is atomic from the importer's point of
                # view: stopping halfway would make every later pass restart
                # the same cursor walk. Do not start another expensive nested
                # walk once the caller's budget has elapsed. The untouched
                # hasNextPage flag makes on_page stop before this order, while
                # still committing fully-read orders that precede it.
                if (
                    should_continue is not None
                    and not should_continue()
                    and nested_walk_started
                    and not replayed_boundary
                ):
                    break
                # The inclusive resume query replays the watermark order.
                # Its walk must not consume the one guaranteed walk, or it can
                # starve the next unprocessed order on every subsequent pass.
                if not replayed_boundary:
                    nested_walk_started = True
                complete_agreements(
                    shop, token, order, catalog_identity=catalog_identity
                )
        if not on_page(nodes):
            return
        page_info = orders.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            return
        after = page_info.get("endCursor")
