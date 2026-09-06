"""Coercion helpers shared by every domain.

A leaf module: it validates and normalizes raw request values, so any layer
can depend on it. Its one app-level import is `normalized_name`, which has to
be defined in the model layer because `Ingredient.save()` derives the stored
key from it and models may not import a domain.
"""

import math
import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from ...models import normalized_name as normalized_name


def group_key_part(value: str) -> str:
    """Whitespace-collapsed lowercase key for identities the browser also keys.

    Mirrors the JS importers' `value.toLowerCase().replace(/\\s+/g, " ").trim()`
    (`normalized` in `apps/web/lib/sales-import.ts`, `normalizeEmployeeName` in
    `apps/web/lib/labor-import.ts`): `.lower()` rather than `.casefold()`, because JS
    `toLowerCase` does not fold ß/ẞ or ligatures, and the key a browser
    computes must meet the key the server computes. JS `\\s` also matches
    U+FEFF, so the class carries it explicitly — an interior BOM must collapse
    the same way on both sides or the client-side key never meets the
    server-side one.
    """
    return re.sub("[\\s\\ufeff]+", " ", value.lower()).strip()


def iso(value) -> str:
    return value.isoformat()


def uuid_value(value: Any, label: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(f"Invalid {label}") from exc


def text_value(
    value: Any,
    label: str,
    *,
    max_length: int,
    allow_blank: bool = False,
) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text")
    result = value.strip()
    if not allow_blank and not result:
        raise ValueError(f"{label} is required")
    if len(result) > max_length:
        raise ValueError(f"{label} is too long")
    return result


def bool_value(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{label} must be true or false")
    return value


def int_value(
    value: Any, label: str, *, minimum: int, maximum: int
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be a whole number")
    if value < minimum or value > maximum:
        raise ValueError(f"{label} is outside the allowed range")
    return value


def number_value(
    value: Any,
    label: str,
    *,
    minimum: float,
    maximum: float,
    nullable: bool = False,
) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise ValueError(f"{label} is outside the allowed range")
    return result


def yield_percent_value(value: Any) -> Decimal | None:
    """An ingredient's usable share, or None when the payload states none.

    The column is bounded (0, 100]: a yield of nothing is not a yield, and
    nothing comes back heavier than it went in. Absent leaves the saved yield
    alone, so a payload that only prices an ingredient cannot reset it.
    """
    if value is None:
        return None
    number = number_value(value, "Yield", minimum=0, maximum=100)
    if number is None or number <= 0:
        raise ValueError("Yield is outside the allowed range")
    return Decimal(str(number))


def import_date_value(value: Any, label: str) -> date | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a date")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be a date") from exc


def optional_text(value: Any, label: str, *, max_length: int) -> str:
    if value is None:
        return ""
    return text_value(value, label, max_length=max_length, allow_blank=True).strip()


MONEY_CENTS_LIMIT = 100000000


def signed_cents(value: Any, label: str, *, nullable: bool = False) -> int | None:
    if value is None and nullable:
        return None
    return int_value(
        value, label, minimum=-MONEY_CENTS_LIMIT, maximum=MONEY_CENTS_LIMIT
    )


def month_value(value: str | None) -> date | None:
    if not value:
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m")
    except ValueError as exc:
        raise ValueError("Month must look like 2026-07") from exc
    return parsed.date().replace(day=1)
