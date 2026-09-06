import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from .models import CatalogProduct


WEIGHT_GRAMS = {
    "g": Decimal("1"),
    "kg": Decimal("1000"),
    "oz": Decimal("28.349523125"),
    "lb": Decimal("453.59237"),
}
WEIGHT_UNIT = r"(?:LB|LBS|OZ|KG|G)"


def _unit(value: str) -> str:
    normalized = value.lower()
    return "lb" if normalized == "lbs" else normalized


def _grams(amount: Decimal, unit: str) -> int:
    return max(1, int((amount * WEIGHT_GRAMS[unit]).quantize(Decimal("1"))))


def parse_visible_price(value: Any) -> tuple[int, str | None]:
    text = str(value or "").strip().upper().replace(",", "")
    match = re.search(
        rf"\$([0-9]+(?:\.[0-9]{{1,2}})?)(?:\s*/\s*({WEIGHT_UNIT})\b)?",
        text,
    )
    if match is None:
        raise ValueError("Price must be a positive visible dollar amount")
    try:
        amount = Decimal(match.group(1))
    except InvalidOperation as exc:
        raise ValueError("Price must be a positive visible dollar amount") from exc
    if amount <= 0:
        raise ValueError("Price must be above zero")
    cents = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    basis_unit = _unit(match.group(2)) if match.group(2) else None
    return cents, basis_unit


def parse_weight_pack(raw_size: Any, title: Any) -> tuple[float, str, int] | None:
    raw = str(raw_size or "").strip().upper()
    product_title = str(title or "").strip().upper()

    multipack = re.search(
        rf"\b([0-9]+(?:\.[0-9]+)?)\s*X\s*([0-9]+(?:\.[0-9]+)?)\s*({WEIGHT_UNIT})\b",
        raw,
    )
    if multipack:
        count = Decimal(multipack.group(1))
        each_amount = Decimal(multipack.group(2))
        if count <= 0 or each_amount <= 0:
            return None
        unit = _unit(multipack.group(3))
        amount = count * each_amount
        return float(amount), unit, _grams(amount, unit)

    case_pack = re.search(
        rf"\b([0-9]+(?:\.[0-9]+)?)\s*({WEIGHT_UNIT})\.?\s*-\s*([0-9]+)\s*/\s*(?:CASE|PACK)\b",
        product_title,
    )
    if case_pack:
        each_amount = Decimal(case_pack.group(1))
        unit = _unit(case_pack.group(2))
        count = Decimal(case_pack.group(3))
        if count <= 0 or each_amount <= 0:
            return None
        amount = each_amount * count
        return float(amount), unit, _grams(amount, unit)

    for text in (raw, product_title):
        count_first_pack = re.search(
            rf"\b([0-9]+)\s*/\s*([0-9]+(?:\.[0-9]+)?)\s*({WEIGHT_UNIT})\b",
            text,
        )
        if count_first_pack:
            count = Decimal(count_first_pack.group(1))
            each_amount = Decimal(count_first_pack.group(2))
            if count <= 0 or each_amount <= 0:
                return None
            unit = _unit(count_first_pack.group(3))
            amount = count * each_amount
            return float(amount), unit, _grams(amount, unit)

        single = re.search(
            rf"\b([0-9]+(?:\.[0-9]+)?)\s*({WEIGHT_UNIT})\b",
            text,
        )
        if single:
            amount = Decimal(single.group(1))
            if amount <= 0:
                return None
            unit = _unit(single.group(2))
            return float(amount), unit, _grams(amount, unit)
    return None


def normalized_catalog_price(row: dict[str, Any]) -> dict[str, Any]:
    cents, basis_unit = parse_visible_price(row.get("price_text"))
    if basis_unit:
        return {
            "price_basis": CatalogProduct.PriceBasis.WEIGHT,
            "pack_price_cents": cents,
            "pack_amount": 1.0,
            "pack_unit": basis_unit,
            "pack_grams": _grams(Decimal("1"), basis_unit),
        }

    pack = parse_weight_pack(row.get("sell_unit"), row.get("name"))
    if pack is None:
        return {
            "price_basis": CatalogProduct.PriceBasis.PACK,
            "pack_price_cents": cents,
            "pack_amount": None,
            "pack_unit": None,
            "pack_grams": None,
        }
    amount, unit, grams = pack
    return {
        "price_basis": CatalogProduct.PriceBasis.PACK,
        "pack_price_cents": cents,
        "pack_amount": amount,
        "pack_unit": unit,
        "pack_grams": grams,
    }
