"""The canonical measure identity of an ingredient, and the shared yield a new
preparation starts from.

Both the preparation editor and the recipe paste create preparations, and both
must ask the catalog the same question, so the identity selection lives here
rather than in either domain.

A leaf module: it knows the models and nothing else.
"""

from decimal import Decimal

from ...models import (
    CatalogPreparationYield,
    Ingredient,
    IngredientMeasureConfidence,
    Preparation,
    normalized_name,
)


def ingredient_measure_name(row: Ingredient) -> str:
    """Canonical shared-measure identity, stable across pantry renames."""
    if row.catalog_ingredient is not None:
        return row.catalog_ingredient.name
    product = row.catalog_product
    if product is not None and product.ingredient is not None:
        return product.ingredient.name
    return row.name


def seeded_preparation_yield(
    ingredient: Ingredient, name: str
) -> tuple[Decimal | None, str, str]:
    """`(yield_percent, source, confidence)` for a preparation nobody measured.

    A reviewed catalog yield for this ingredient's canonical identity makes the
    row a shared estimate; without one it stays the chef's own blank.
    """
    seed = CatalogPreparationYield.objects.filter(
        ingredient__normalized_name=normalized_name(ingredient_measure_name(ingredient)),
        ingredient__is_active=True,
        normalized_name=normalized_name(name),
        is_active=True,
        is_default=True,
    ).first()
    if seed is None:
        return None, Preparation.Source.USER, IngredientMeasureConfidence.HIGH
    return seed.yield_percent, Preparation.Source.CATALOG, seed.confidence
