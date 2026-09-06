"""Persistence shared by supplier-backed ingredient import sources.

Both spreadsheet and invoice imports write the same supplier-item, ingredient,
and undo-history records. This shared leaf owns that persistence without making
either domain depend on the other.
"""

import re
from datetime import datetime
from decimal import Decimal, ROUND_FLOOR
from typing import Any

from ...models import (
    Ingredient,
    IngredientImport,
    IngredientImportItem,
    IngredientPrice,
    InvoiceLine,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    User,
)
from ...units import PACK_UNIT_VALUES, to_grams
from .ingredient_pricing import apply_price, create_priced_ingredient
from .values import (
    bool_value,
    import_date_value,
    int_value,
    iso,
    normalized_name,
    number_value,
    text_value,
    uuid_value,
)

JsonObject = dict[str, Any]


def invoice_line_pack_price_cents(line: InvoiceLine) -> int:
    """The document price for one pack, rounded exactly like JavaScript."""
    if line.unit_price_cents is not None:
        return line.unit_price_cents
    if line.quantity is not None and line.quantity > 0:
        quotient = Decimal(line.line_amount_cents) / Decimal(line.quantity)
        return int((quotient + Decimal("0.5")).to_integral_value(ROUND_FLOOR))
    return line.line_amount_cents


# Legal-form words that say nothing about who the supplier is, so "Baldor
# Specialty Foods Inc." and "BALDOR SPECIALTY FOODS" land on one key. Kept in
# step with SUPPLIER_SUFFIXES in apps/web/lib/invoice-import.ts, which derives the same
# key in the browser before an invoice is sent here.
SUPPLIER_SUFFIXES = frozenset(
    {"co", "company", "corp", "corporation", "inc", "incorporated", "llc", "ltd"}
)


def supplier_key_from_name(name: str) -> str:
    """The normalized key a supplier's rows are stored under."""
    words = [
        word
        for word in re.sub(r"[^a-z0-9]+", " ", name.lower()).split(" ")
        if word and word not in SUPPLIER_SUFFIXES
    ]
    if words[:1] == ["baldor"]:
        return "baldor"
    return " ".join(words)[:64].strip()


def supplier_item_key(sku: str, description: str) -> str:
    """The key one supplier product is remembered under.

    A printed item code is the key; a supplier that prints none (Wegmans, most
    receipts) is keyed on the normalized description instead, under a `desc:`
    prefix no printed code can collide with. A line with neither has no memory
    and stays expense-only. `supplierItemKey` in apps/web/lib/invoice-import.ts is the
    browser twin and must not drift.
    """
    code = sku.strip().lower()[:120]
    # A model reading a photo sometimes fills the code column with "0" or a
    # dash; treating that as a code would file every such line under one key.
    if code and (not any(ch.isalnum() for ch in code) or set(code) <= {"0"}):
        code = ""
    if code:
        return code
    normalized = normalized_name(description)
    return f"desc:{normalized}"[:120] if normalized else ""


def supplier_display_name(key: str) -> str:
    """A readable name for a key no invoice ever printed a name for."""
    return re.sub(r"(^|\s)(\w)", lambda match: match.group(0).upper(), key)


def ensure_supplier(user: User, key: str, name: str = "") -> Supplier | None:
    """The Supplier record behind a supplier key, created on first sight.

    Every write that puts a new key on an invoice, a supplier item or an
    ignore row comes through here, so Settings never shows a supplier the
    workspace has rows for but no record of.
    """
    key = key.strip().lower()
    if not key:
        return None
    supplier, _ = Supplier.objects.get_or_create(
        user=user,
        key=key,
        defaults={"name": name.strip() or supplier_display_name(key)},
    )
    return supplier


PACK_KEYS = ("packPriceCents", "packAmount", "packUnit")
PURCHASE_KEYS = ("purchaseCostCents", "purchaseSize", "purchaseUnit")


def ingredient_values(
    body: JsonObject, *, from_pack: bool = True, require_name: bool = True
) -> JsonObject:
    """The ingredient columns a payload sets.

    An import describes a supplier's pack — measured, priced, `pack*` on the
    wire — and demands every part of it. A hand-entered ingredient describes
    what the kitchen buys, `purchase*` on the wire, and may carry a name only,
    priced later. A pack write onto a saved ingredient carries no name at all,
    and `name` is then absent from the result rather than blank.
    """
    cost_key, size_key, unit_key = PACK_KEYS if from_pack else PURCHASE_KEYS
    named = require_name or "name" in body
    name = text_value(body.get("name"), "Name", max_length=120).strip() if named else ""
    unit = body.get(unit_key)
    # An import names its pack unit from the purchase vocabulary — a weight, a
    # volume or a count. A hand-entered ingredient may also be bought by the
    # bushel or anything else the kitchen writes down.
    if from_pack:
        if unit not in PACK_UNIT_VALUES:
            raise ValueError("Unsupported pack unit")
    else:
        if unit is None:
            unit = None
        elif not isinstance(unit, str):
            raise ValueError("Purchase unit must be text")
        else:
            unit = unit.strip() or None
    floor = 0.000001 if from_pack else 0
    raw_amount = body.get(size_key)
    if not from_pack and raw_amount in (None, ""):
        amount = None
    else:
        amount = number_value(
            raw_amount,
            "Pack size",
            minimum=floor,
            maximum=1000000,
            nullable=not from_pack,
        )
    price = int_value(
        body.get(cost_key),
        "Price",
        minimum=1 if from_pack else 0,
        maximum=100000000,
    )
    return {
        **({"name": name} if named else {}),
        "purchase_cost_cents": price,
        # Through str, not Decimal(float): "0.1" arrives exact, so a repeat
        # import of the same number compares equal against the stored column.
        "purchase_size": Decimal(str(amount)) if amount else None,
        "purchase_unit": unit,
    }


def ingredient_snapshot(row: Ingredient) -> JsonObject:
    return {
        "id": str(row.id),
        "name": row.name,
        "normalizedName": row.normalized_name,
        "purchaseCostCents": row.purchase_cost_cents,
        "purchaseSize": (
            float(row.purchase_size) if row.purchase_size is not None else None
        ),
        "purchaseUnit": row.purchase_unit,
        "priceSource": row.price_source,
        "updatedAt": iso(row.updated_at),
    }


def supplier_item_snapshot(row: SupplierItem) -> JsonObject:
    return {
        "id": str(row.id),
        "ingredientId": str(row.ingredient_id),
        "supplier": row.supplier,
        "externalId": row.external_id,
        "title": row.title,
        "rawSize": row.raw_size,
        "packPriceCents": row.pack_price_cents,
        "packGrams": row.pack_grams,
        "packAmount": float(row.pack_amount),
        "packUnit": row.pack_unit,
        "purchasedQuantity": row.purchased_quantity,
        "periodStart": row.period_start.isoformat() if row.period_start else None,
        "periodEnd": row.period_end.isoformat() if row.period_end else None,
        "isPreferred": row.is_preferred,
        "updatedAt": iso(row.updated_at),
    }


def supplier_ignore_snapshot(row: SupplierItemIgnore) -> JsonObject:
    return {
        "supplier": row.supplier,
        "externalId": row.external_id,
        "title": row.title,
        "rawSize": row.raw_size,
        "updatedAt": iso(row.updated_at),
    }


def upsert_supplier_ignores(user: User, ignored_entries: list) -> list[JsonObject]:
    """Upsert skip-list rows and return their before-snapshots for undo."""
    ignored_snapshots: list[JsonObject] = []
    for ignored in ignored_entries:
        if not isinstance(ignored, dict):
            raise ValueError("Ignored supplier item looks malformed")
        ignored_supplier = (
            text_value(ignored.get("supplier"), "Supplier", max_length=64)
            .strip()
            .lower()
        )
        ignored_title = text_value(
            ignored.get("name"), "Supplier item title", max_length=200
        ).strip()
        # The skip list is keyed the way the probe keys a line, so a code-less
        # item stays ignored on the next invoice that prints it.
        ignored_id = supplier_item_key(
            text_value(
                ignored.get("externalId"),
                "Supplier item ID",
                max_length=120,
                allow_blank=True,
            ),
            ignored_title,
        )
        ignored_size = text_value(
            ignored.get("rawSize", ""),
            "Supplier pack size",
            max_length=120,
            allow_blank=True,
        ).strip()
        ensure_supplier(user, ignored_supplier)
        existing_ignore = SupplierItemIgnore.objects.filter(
            user=user,
            supplier=ignored_supplier,
            external_id=ignored_id,
        ).first()
        ignored_snapshots.append(
            {
                "supplier": ignored_supplier,
                "externalId": ignored_id,
                "before": (
                    supplier_ignore_snapshot(existing_ignore)
                    if existing_ignore
                    else None
                ),
            }
        )
        SupplierItemIgnore.objects.update_or_create(
            user=user,
            supplier=ignored_supplier,
            external_id=ignored_id,
            defaults={"title": ignored_title, "raw_size": ignored_size},
        )
    return ignored_snapshots


def promote_next_preferred(
    user: User, ingredient: Ingredient
) -> tuple[SupplierItem, JsonObject, JsonObject, IngredientPrice | None] | None:
    """Give an ingredient a preferred pack again after its own one left.

    The pack that priced the ingredient now belongs to another one, so the
    next remaining pack is promoted and the ingredient re-priced off it,
    instead of keeping the departed price with no preferred pack behind it.
    Returns the promoted pack, the before-snapshots and the price row it
    wrote, so an import can record the step as undoable; None when the
    ingredient has no pack left.
    """
    replacement = SupplierItem.objects.filter(user=user, ingredient=ingredient).first()
    if replacement is None:
        return None
    replacement_before = supplier_item_snapshot(replacement)
    ingredient_before = ingredient_snapshot(ingredient)
    replacement.is_preferred = True
    replacement.save(update_fields=["is_preferred", "updated_at"])
    price = apply_price(
        ingredient,
        {
            "purchase_cost_cents": replacement.pack_price_cents,
            "purchase_size": replacement.pack_amount,
            "purchase_unit": replacement.pack_unit,
        },
        source=IngredientPrice.Source.SUPPLIER,
        supplier_item=replacement,
    )
    return replacement, replacement_before, ingredient_before, price


def apply_supplier_import_entry(
    user: User,
    ingredient_import: IngredientImport,
    position: int,
    entry: JsonObject,
    *,
    effective_at: datetime | None = None,
    non_edible: bool = False,
    allow_preferred_selection: bool = True,
) -> tuple[bool, SupplierItem, Ingredient]:
    """Write one supplier-linked row inside an open transaction.

    `effective_at` is when this price was in effect; the invoice import passes
    the invoice's own date so a backfilled document cannot restate a newer
    price. Omitted, the price is effective as of the write.

    `non_edible` marks an ingredient this entry *creates* as a supply. It is a
    keyword the caller derives from the line's expense category, never a field
    read off `entry`, so no client can decide what a pantry row is.

    `allow_preferred_selection` is false for invoice review. An invoice may
    update a pack that the merchant already chose as preferred, but attaching
    a new supplier pack to an existing ingredient must not make that purchase
    the ingredient's costing source. A newly created ingredient still needs
    its first pack and price to agree.
    """
    values = ingredient_values(entry)
    supplier = (
        text_value(entry.get("supplier"), "Supplier", max_length=64).strip().lower()
    )
    external_id = (
        text_value(entry.get("externalId"), "Supplier item ID", max_length=120)
        .strip()
        .lower()
    )
    raw_size = text_value(
        entry.get("rawSize"), "Supplier pack size", max_length=120
    ).strip()
    ensure_supplier(user, supplier)
    purchased_quantity = number_value(
        entry.get("quantity"),
        "Purchased quantity",
        minimum=0,
        maximum=1000000,
        nullable=True,
    )
    preferred = bool_value(entry.get("preferred"), "Preferred supplier item")
    item_period_start = import_date_value(entry.get("periodStart"), "Period start")
    item_period_end = import_date_value(entry.get("periodEnd"), "Period end")
    supplier_item = SupplierItem.objects.filter(
        user=user, supplier=supplier, external_id=external_id
    ).first()
    requested_ingredient_id = entry.get("ingredientId")
    if requested_ingredient_id is not None:
        row = Ingredient.objects.filter(
            user=user,
            id=uuid_value(requested_ingredient_id, "ingredient id"),
        ).first()
        if row is None:
            raise ValueError("Ingredient match was not found")
    elif supplier_item is not None:
        row = supplier_item.ingredient
    else:
        row = Ingredient.objects.filter(
            user=user, normalized_name=normalized_name(values["name"])
        ).first()
    supplier_before = (
        supplier_item_snapshot(supplier_item) if supplier_item is not None else None
    )
    ingredient_before = ingredient_snapshot(row) if row else None
    ingredient_created = row is None
    price_history_id = None
    if row is None:
        # The supplier item does not exist yet, so the first history row
        # carries the supplier source without the item link.
        row, price = create_priced_ingredient(
            user,
            values,
            source=IngredientPrice.Source.SUPPLIER,
            effective_at=effective_at,
            extra_fields={"non_edible": True} if non_edible else None,
        )
        price_history_id = price.id
    orphaned_ingredient = None
    if (
        supplier_item is not None
        and supplier_item.ingredient_id != row.id
        and supplier_item.is_preferred
    ):
        supplier_item.is_preferred = False
        supplier_item.save(update_fields=["is_preferred", "updated_at"])
        orphaned_ingredient = supplier_item.ingredient
    supplier_item, item_created = SupplierItem.objects.update_or_create(
        user=user,
        supplier=supplier,
        external_id=external_id,
        defaults={
            "ingredient": row,
            "title": values["name"],
            "raw_size": raw_size,
            "pack_price_cents": values["purchase_cost_cents"],
            # A derived cache of the pack's weight, null when its unit carries
            # no weight of its own. Never the price, which is the pack itself.
            "pack_grams": to_grams(values["purchase_size"], values["purchase_unit"]),
            "pack_amount": values["purchase_size"],
            "pack_unit": values["purchase_unit"],
            "purchased_quantity": purchased_quantity,
            "period_start": item_period_start,
            "period_end": item_period_end,
        },
    )
    if orphaned_ingredient is not None:
        promoted = promote_next_preferred(user, orphaned_ingredient)
        if promoted is not None:
            replacement, replacement_before, orphan_before, promotion_price = promoted
            # The promotion is its own import item so undo reverses it with
            # the machinery it already has: the replacement drops back to
            # unpreferred, the orphaned ingredient's materialized price is
            # restored, and the promotion's history row is deleted. Odd
            # position, so it unwinds before its main row.
            IngredientImportItem.objects.create(
                ingredient_import=ingredient_import,
                position=position * 2 + 1,
                supplier=replacement.supplier,
                external_id=replacement.external_id,
                operation=IngredientImportItem.Operation.UPDATED,
                supplier_before=replacement_before,
                supplier_after=supplier_item_snapshot(replacement),
                ingredient_before=orphan_before,
                ingredient_after=ingredient_snapshot(orphaned_ingredient),
                ingredient_created=False,
                price_history_id=promotion_price.id if promotion_price else None,
            )
    existing_ignore = SupplierItemIgnore.objects.filter(
        user=user, supplier=supplier, external_id=external_id
    ).first()
    ignore_before = (
        supplier_ignore_snapshot(existing_ignore) if existing_ignore else None
    )
    SupplierItemIgnore.objects.filter(
        user=user, supplier=supplier, external_id=external_id
    ).delete()
    has_preferred = SupplierItem.objects.filter(
        ingredient=row, is_preferred=True
    ).exists()
    should_price_ingredient = supplier_item.is_preferred or ingredient_created
    if allow_preferred_selection and (preferred or not has_preferred):
        should_price_ingredient = True
    if should_price_ingredient:
        SupplierItem.objects.filter(ingredient=row, is_preferred=True).exclude(
            id=supplier_item.id
        ).update(is_preferred=False)
        if not supplier_item.is_preferred:
            supplier_item.is_preferred = True
            supplier_item.save(update_fields=["is_preferred", "updated_at"])
        price = apply_price(
            row,
            values,
            source=IngredientPrice.Source.SUPPLIER,
            supplier_item=supplier_item,
            extra_fields={"name": values["name"]},
            effective_at=effective_at,
        )
        if price is not None:
            price_history_id = price.id
    IngredientImportItem.objects.create(
        ingredient_import=ingredient_import,
        # Entries own even positions; a pack promotion (above) records itself
        # at the odd slot in between.
        position=position * 2,
        supplier=supplier,
        external_id=external_id,
        operation=(
            IngredientImportItem.Operation.CREATED
            if item_created
            else IngredientImportItem.Operation.UPDATED
        ),
        supplier_before=supplier_before,
        supplier_after=supplier_item_snapshot(supplier_item),
        ignore_before=ignore_before,
        ingredient_before=ingredient_before,
        ingredient_after=ingredient_snapshot(row),
        ingredient_created=ingredient_created,
        price_history_id=price_history_id,
    )
    return item_created, supplier_item, row
