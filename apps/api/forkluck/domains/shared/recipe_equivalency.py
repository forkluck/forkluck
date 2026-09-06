"""One recipe's equivalency as JSON.

The recipe detail and the pricing entries the recipe editor weighs with both
carry the same equivalency, and a sub-recipe line written in another unit
family is only weighed because the two agree, so the shape lives here rather
than in either domain.

A leaf module: it knows the models and nothing else.
"""

from typing import Any

from ...models import Recipe, RecipeEquivalency

JsonObject = dict[str, Any]


def equivalency_json(row: RecipeEquivalency | None) -> JsonObject | None:
    if row is None:
        return None
    return {
        "id": str(row.id),
        "massAmount": float(row.mass_amount) if row.mass_amount is not None else None,
        "massUnit": row.mass_unit,
        "volumeAmount": (
            float(row.volume_amount) if row.volume_amount is not None else None
        ),
        "volumeUnit": row.volume_unit,
        "countAmount": (
            float(row.count_amount) if row.count_amount is not None else None
        ),
        "countUnit": row.count_unit,
        "standard": row.standard,
    }


def recipe_equivalency(row: Recipe) -> RecipeEquivalency | None:
    """The recipe's equivalency, or None when it has none.

    A reverse one-to-one raises rather than answering None, and
    `select_related` does not change that, so every caller asks through here.
    """
    try:
        return row.equivalency
    except RecipeEquivalency.DoesNotExist:
        return None
