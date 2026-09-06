"""Private starter-price catalog boundary.

Hosted installations may point ``FORKLUCK_MASTER_PRICE_CATALOG_PATH`` at a
private JSON file. No production catalog or fallback prices belong in source
control. An unset path intentionally exposes no starter estimates.
"""

import json
import math
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

from .models import normalized_name as normalized_ingredient_name


from .units import WEIGHT_FACTORS  # re-exported; callers import it from here
CATALOG_PATH_ENV = "FORKLUCK_MASTER_PRICE_CATALOG_PATH"
MAX_CATALOG_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class MasterPrice:
    id: str
    name: str
    pack_price_cents: int
    pack_amount: float
    pack_unit: str

    @property
    def normalized_name(self) -> str:
        return normalized_ingredient_name(self.name)

    @property
    def pack_grams(self) -> int:
        return max(1, round(self.pack_amount * WEIGHT_FACTORS[self.pack_unit]))


def _catalog_error(message: str) -> RuntimeError:
    return RuntimeError(f"Invalid private starter-price catalog: {message}")


def _parse_catalog_row(raw: object, index: int) -> MasterPrice:
    if not isinstance(raw, dict):
        raise _catalog_error(f"row {index} must be an object")

    raw_id = raw.get("masterPriceId", raw.get("id"))
    if not isinstance(raw_id, str):
        raise _catalog_error(f"row {index} has no valid id")
    if raw_id.startswith("master:"):
        raw_id = raw_id.removeprefix("master:")
    try:
        price_id = str(uuid.UUID(raw_id))
    except (ValueError, AttributeError) as error:
        raise _catalog_error(f"row {index} has no valid id") from error

    name = raw.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
        raise _catalog_error(f"row {index} has no valid name")

    pack_price_cents = raw.get("packPriceCents")
    if (
        isinstance(pack_price_cents, bool)
        or not isinstance(pack_price_cents, int)
        or pack_price_cents <= 0
    ):
        raise _catalog_error(f"row {index} has no valid pack price")

    pack_amount = raw.get("packAmount")
    if (
        isinstance(pack_amount, bool)
        or not isinstance(pack_amount, (int, float))
        or not math.isfinite(pack_amount)
        or pack_amount <= 0
    ):
        raise _catalog_error(f"row {index} has no valid pack amount")

    pack_unit = raw.get("packUnit")
    if pack_unit not in WEIGHT_FACTORS:
        raise _catalog_error(f"row {index} has no valid pack unit")

    return MasterPrice(
        id=price_id,
        name=name.strip(),
        pack_price_cents=pack_price_cents,
        pack_amount=float(pack_amount),
        pack_unit=pack_unit,
    )


def load_master_prices(path: str | os.PathLike[str] | None = None) -> tuple[MasterPrice, ...]:
    configured_path = path if path is not None else os.environ.get(CATALOG_PATH_ENV)
    if not configured_path:
        return ()

    catalog_path = Path(configured_path)
    try:
        if catalog_path.stat().st_size > MAX_CATALOG_BYTES:
            raise _catalog_error("file is too large")
        raw_catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except RuntimeError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise _catalog_error("file cannot be read") from error
    if not isinstance(raw_catalog, list):
        raise _catalog_error("top level must be a list")

    prices = tuple(
        _parse_catalog_row(raw, index)
        for index, raw in enumerate(raw_catalog, start=1)
    )
    ids = [price.id for price in prices]
    names = [price.normalized_name for price in prices]
    if len(ids) != len(set(ids)):
        raise _catalog_error("ids must be unique")
    if len(names) != len(set(names)):
        raise _catalog_error("normalized names must be unique")
    return prices


MASTER_PRICE_LIST = load_master_prices()
MASTER_PRICES_BY_ID = {price.id: price for price in MASTER_PRICE_LIST}
MASTER_PRICES_BY_NAME = {price.normalized_name: price for price in MASTER_PRICE_LIST}


def master_price_json(price: MasterPrice) -> dict[str, object]:
    return {
        "id": f"master:{price.id}",
        "masterPriceId": price.id,
        "name": price.name,
        "normalizedName": price.normalized_name,
        "packPriceCents": price.pack_price_cents,
        "packGrams": price.pack_grams,
        "packAmount": price.pack_amount,
        "packUnit": price.pack_unit,
        "source": "master",
    }
