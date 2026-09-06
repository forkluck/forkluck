"""Strict query parsing and Ghost-style pagination for browse endpoints.

This module is a domain leaf: it knows how to validate URL query values and
slice a queryset, but nothing about the records being browsed.
"""

from dataclasses import dataclass
from typing import Any, TypeVar

from django.db.models import QuerySet
from django.http import QueryDict

JsonObject = dict[str, Any]
Row = TypeVar("Row")

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
MAX_PAGE = 1_000_000
MAX_QUERY_LENGTH = 200

# A tenant-owned editable document — anything carrying `edit_version` — leads
# with the most recently changed row, so the thing just worked on is the thing
# on top. Reference data (the `Catalog*` models) keeps alphabetical order.
DOCUMENT_DEFAULT_ORDER = "-updatedAt"


@dataclass(frozen=True)
class BrowseQuery:
    page: int
    limit: int
    query: str
    order: str
    # A non-default order, which a searched list lets outrank relevance. The
    # pages send their own default even when nobody picked a column, so
    # `order=name` is not a choice.
    ordered_explicitly: bool = False


def _single_value(query: QueryDict, key: str) -> str | None:
    values = query.getlist(key)
    if not values:
        return None
    if len(values) != 1:
        raise ValueError(f"Invalid {key}")
    return values[0]


def _positive_integer(
    query: QueryDict,
    key: str,
    *,
    default: int,
    maximum: int | None = None,
    cap: bool = False,
) -> int:
    raw = _single_value(query, key)
    if raw is None:
        return default
    if not raw.isascii() or not raw.isdecimal():
        raise ValueError(f"Invalid {key}")
    normalized = raw.lstrip("0") or "0"
    if maximum is not None and (
        len(normalized) > len(str(maximum))
        or (len(normalized) == len(str(maximum)) and normalized > str(maximum))
    ):
        if cap:
            return maximum
        raise ValueError(f"Invalid {key}")
    value = int(normalized)
    if value < 1:
        raise ValueError(f"Invalid {key}")
    return value


def parse_browse_query(
    query: QueryDict,
    *,
    allowed_orders: set[str] | frozenset[str],
    default_order: str,
    extra_keys: set[str] | frozenset[str] = frozenset(),
) -> BrowseQuery:
    allowed_keys = {"page", "limit", "q", "order", *extra_keys}
    unknown_keys = set(query) - allowed_keys
    if unknown_keys:
        raise ValueError(f"Invalid query parameter: {sorted(unknown_keys)[0]}")

    page = _positive_integer(query, "page", default=1, maximum=MAX_PAGE)
    limit = _positive_integer(
        query,
        "limit",
        default=DEFAULT_LIMIT,
        maximum=MAX_LIMIT,
        cap=True,
    )
    raw_query = _single_value(query, "q")
    if raw_query is not None and len(raw_query) > MAX_QUERY_LENGTH:
        raise ValueError("Invalid q")
    search_query = (raw_query or "").strip()

    raw_order = _single_value(query, "order")
    order = default_order if raw_order is None else raw_order
    if order not in allowed_orders:
        raise ValueError("Invalid order")
    return BrowseQuery(
        page=page,
        limit=limit,
        query=search_query,
        order=order,
        ordered_explicitly=raw_order is not None and raw_order != default_order,
    )


def optional_filter(query: QueryDict, key: str) -> str | None:
    value = _single_value(query, key)
    if value is None or value == "":
        return None
    return value


def _page_count(total: int, limit: int) -> int:
    return max(1, (total + limit - 1) // limit)


def paginate(queryset: QuerySet[Row], browse: BrowseQuery) -> tuple[list[Row], int]:
    total = queryset.count()
    pages = _page_count(total, browse.limit)
    if browse.page > pages:
        raise ValueError("Invalid page")
    start = (browse.page - 1) * browse.limit
    return list(queryset[start : start + browse.limit]), total


def paginated_payload(
    items: list[JsonObject], browse: BrowseQuery, total: int
) -> JsonObject:
    pages = _page_count(total, browse.limit)
    return {
        "items": items,
        "meta": {
            "pagination": {
                "page": browse.page,
                "limit": browse.limit,
                "pages": pages,
                "total": total,
                "next": browse.page + 1 if browse.page < pages else None,
                "prev": browse.page - 1 if browse.page > 1 else None,
            }
        },
    }
