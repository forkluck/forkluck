"""The one write path for an ingredient's materialized price.

`Ingredient.purchase_cost_cents/purchase_size/purchase_unit` plus
`price_source` are a materialization of the latest-effective `IngredientPrice`
history row. Every mutation must move them together through `apply_price` /
`create_priced_ingredient`, so the invariant

    materialized tuple == latest-EFFECTIVE history row

holds after every write, and every history row says where its price came
from. A document can be dated before what we already know — a March invoice
imported in August — so history always grows while the materialized tuple
only follows the row that is newest by `effective_at` (ties to the newer
`created_at`, which is the incoming row). Bulk currency conversion
(`domains/workspace/currency.py`) and the legacy/demo importers rewrite
history wholesale and are the documented exceptions.
"""

from datetime import datetime
from typing import Any

from django.utils import timezone

from ...models import (
    CatalogPriceObservation,
    Ingredient,
    IngredientPrice,
    SupplierItem,
    User,
)

JsonObject = dict[str, Any]

PRICE_FIELDS = (
    "purchase_cost_cents",
    "purchase_size",
    "purchase_unit",
)

# A supplier-sourced price is still the merchant's own price on the
# ingredient itself; the finer distinction lives on the history row.
_MATERIALIZED_SOURCE = {
    IngredientPrice.Source.SUPPLIER: Ingredient.PriceSource.USER,
}


def materialized_price_source(source: str) -> str:
    return _MATERIALIZED_SOURCE.get(source, source)


def rematerialize_price(row: Ingredient) -> None:
    """Restore the materialized tuple from surviving history, or unprice it."""
    head = row.price_history.first()
    if head is None:
        values = {
            "purchase_cost_cents": 0,
            "purchase_size": None,
            "purchase_unit": None,
        }
        source = Ingredient.PriceSource.USER
    else:
        values = {field: getattr(head, field) for field in PRICE_FIELDS}
        source = materialized_price_source(head.source)
    for field, value in values.items():
        setattr(row, field, value)
    row.price_source = source
    row.save(update_fields=[*PRICE_FIELDS, "price_source", "updated_at"])


def price_changed(row: Ingredient, values: JsonObject) -> bool:
    return any(getattr(row, field) != values[field] for field in PRICE_FIELDS)


def record_price(
    row: Ingredient,
    values: JsonObject,
    *,
    source: str,
    supplier_item: SupplierItem | None = None,
    catalog_observation: CatalogPriceObservation | None = None,
    effective_at: datetime | None = None,
) -> IngredientPrice:
    return IngredientPrice.objects.create(
        ingredient=row,
        effective_at=effective_at or row.updated_at,
        source=source,
        supplier_item=supplier_item,
        catalog_observation=catalog_observation,
        **{field: values[field] for field in PRICE_FIELDS},
    )


def apply_price(
    row: Ingredient,
    values: JsonObject,
    *,
    source: str,
    supplier_item: SupplierItem | None = None,
    catalog_observation: CatalogPriceObservation | None = None,
    extra_fields: JsonObject | None = None,
    effective_at: datetime | None = None,
) -> IngredientPrice | None:
    """Sync the materialized tuple, `price_source`, and any `extra_fields`
    (a rename travelling with the price) in one save, appending a
    provenance-stamped history row when the price itself moved.

    `effective_at` is when the price was in effect (an invoice's date),
    defaulting to the write moment for interactive edits. A price that is not
    the newest-effective one for this ingredient is recorded in history but
    does not restate the materialized tuple, so a backdated document cannot
    clobber a newer price.

    Returns the history row, or None when nothing needed recording. A save
    with an unchanged price (rename, or a source relabel) updates the row
    without touching history — history answers "what did it cost", not
    "what was it called".
    """
    extra = extra_fields or {}
    changed_price = price_changed(row, values)
    changed_extra = any(getattr(row, field) != value for field, value in extra.items())
    materialized_source = materialized_price_source(source)
    changed_source = row.price_source != materialized_source
    if not (changed_price or changed_extra or changed_source):
        return None
    incoming_effective_at = effective_at or timezone.now()
    head = row.price_history.first()
    is_latest = head is None or incoming_effective_at >= head.effective_at
    if is_latest:
        for field in PRICE_FIELDS:
            setattr(row, field, values[field])
        row.price_source = materialized_source
    for field, value in extra.items():
        setattr(row, field, value)
    row.save(
        update_fields=[*PRICE_FIELDS, *extra, "price_source", "updated_at"]
    )
    if not changed_price:
        return None
    return record_price(
        row,
        values,
        source=source,
        supplier_item=supplier_item,
        catalog_observation=catalog_observation,
        effective_at=incoming_effective_at,
    )


def create_priced_ingredient(
    user: User,
    values: JsonObject,
    *,
    source: str,
    supplier_item: SupplierItem | None = None,
    catalog_observation: CatalogPriceObservation | None = None,
    extra_fields: JsonObject | None = None,
    effective_at: datetime | None = None,
) -> tuple[Ingredient, IngredientPrice]:
    """Create the ingredient and its first history row as one unit."""
    row = Ingredient.objects.create(
        user=user,
        price_source=materialized_price_source(source),
        **values,
        **(extra_fields or {}),
    )
    price = record_price(
        row,
        values,
        source=source,
        supplier_item=supplier_item,
        catalog_observation=catalog_observation,
        effective_at=effective_at,
    )
    return row, price
