"""Minimal records consumed by the application-wide search palette."""

from typing import Any

JsonObject = dict[str, Any]


def search_item_json(
    *,
    label: str,
    href: str,
    item_type: str,
) -> JsonObject:
    return {
        "label": label,
        "href": href,
        "type": item_type,
    }


def search_index_json(items: list[JsonObject]) -> JsonObject:
    return {"items": items}
