"""Activating a shared catalog identity for one tenant.

Registration seeds a workspace with the catalog's starter rows and the
ingredient action activates one on demand; both copy the same card, so the
copy lives here rather than in either caller.

A leaf module: it knows the models and nothing else.
"""

from decimal import Decimal
from typing import Any

from django.db import transaction

from ...models import (
    CatalogIngredient,
    CatalogPreparationYield,
    Ingredient,
    IngredientConversion,
    IngredientMeasure,
    Preparation,
    User,
    normalized_name,
)
from ...units import unit_family

JsonObject = dict[str, Any]


def catalog_conversion_fields(measures: list[Any]) -> JsonObject:
    """Translate reviewed catalog measures to one tenant conversion.

    A tenant conversion is one statement: so many grams, which is also so much
    volume, which is also so many pieces. The catalog states its measures one
    at a time ("1 cup is 243 g", "1 each is 17 g"), each with its own grams, so
    every measure is scaled onto the first one's grams before it is kept. A
    cup and an each written side by side would otherwise read as equal.
    Existing tenant conversions are never overwritten by activation.
    """
    fields: JsonObject = {
        # These are explicit catalog pairs.  Marking the row as standard
        # makes the costing readers discard them and consult the generic
        # density table instead.
        "average_weight": False,
        "weight_amount": None,
        "weight_unit": "",
        "volume_amount": None,
        "volume_unit": "",
        "each_amount": None,
        "each_unit": "",
    }
    basis: Decimal | None = None
    for measure in measures:
        grams = Decimal(measure.grams)
        if grams <= 0:
            continue
        if basis is None:
            basis = grams
            fields["weight_amount"] = grams
            fields["weight_unit"] = "g"
        scaled = Decimal(measure.amount) * basis / grams
        family = unit_family(measure.unit)
        if family == "volume" and fields["volume_amount"] is None:
            fields["volume_amount"] = scaled
            fields["volume_unit"] = measure.unit
        elif family in {"count", "dimensionless"} and fields["each_amount"] is None:
            fields["each_amount"] = scaled
            fields["each_unit"] = measure.unit
    return fields


def _materialize_catalog_preparation(
    user: User,
    ingredient: Ingredient,
    catalog_yield: CatalogPreparationYield,
) -> bool:
    """Create one catalog-sourced preparation, preserving user edits."""
    name_key = normalized_name(catalog_yield.name)
    measures = list(catalog_yield.measures.filter(is_active=True, is_default=True))
    fields = catalog_conversion_fields(measures)
    row, created = Preparation.objects.get_or_create(
        user=user,
        ingredient=ingredient,
        normalized_name=name_key,
        defaults={
            "name": catalog_yield.name,
            "yield_percent": catalog_yield.yield_percent,
            "source": Preparation.Source.CATALOG,
            "confidence": catalog_yield.confidence,
            **fields,
        },
    )
    return created


def materialize_catalog_ingredient(
    user: User, catalog: CatalogIngredient
) -> tuple[Ingredient, bool, int, int]:
    """Idempotently activate a canonical catalog ingredient for one tenant.

    Catalog rows are global reference data; the resulting Ingredient and all
    materialized measures/preparations are tenant-owned.  This helper has no
    recipe or matching side effects and is deliberately usable by the action
    and direct backend tests alike.
    """
    if not catalog.is_active:
        raise ValueError("Catalog ingredient not found")
    # In the order they were reviewed, so the first one is the gram basis the
    # rest are scaled onto, and the repair migration reads the same order.
    measures = list(
        catalog.measures.filter(is_active=True, is_default=True).order_by(
            "created_at", "id"
        )
    )
    # The whole card comes over, not only the default preparations: picking an
    # ingredient adopts every preparation the catalog knows for it.
    yields = list(
        catalog.preparation_yields.filter(is_active=True).prefetch_related("measures")
    )
    with transaction.atomic():
        row = (
            Ingredient.objects.select_for_update()
            .filter(user=user, catalog_ingredient=catalog)
            .first()
        )
        if row is None:
            row = (
                Ingredient.objects.select_for_update()
                .filter(user=user, normalized_name=catalog.normalized_name)
                .first()
            )
            if row is not None and row.catalog_ingredient_id not in (None, catalog.id):
                raise ValueError(
                    "Ingredient name is linked to another catalog ingredient"
                )
        created = row is None
        if row is None:
            row = Ingredient.objects.create(
                user=user,
                name=catalog.name,
                normalized_name=catalog.normalized_name,
                purchase_cost_cents=0,
                purchase_size=None,
                purchase_unit=None,
                catalog_ingredient=catalog,
                price_source=Ingredient.PriceSource.USER,
            )
        elif row.catalog_ingredient_id is None:
            row.catalog_ingredient = catalog
            row.save(update_fields=["catalog_ingredient", "updated_at"])

        for measure in measures:
            IngredientMeasure.objects.get_or_create(
                ingredient=row,
                unit=measure.unit,
                qualifier=normalized_name(measure.qualifier),
                defaults={"amount": measure.amount, "grams": measure.grams},
            )
        if measures:
            IngredientConversion.objects.get_or_create(
                ingredient=row,
                defaults={
                    "user": user,
                    "source": IngredientConversion.Source.CATALOG,
                    "confidence": measures[0].confidence,
                    **catalog_conversion_fields(measures),
                },
            )
        seeded_preparations = sum(
            _materialize_catalog_preparation(user, row, catalog_yield)
            for catalog_yield in yields
        )
    return row, created, len(measures), seeded_preparations
