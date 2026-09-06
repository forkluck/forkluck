from decimal import Decimal

from django.db import transaction

from .domains.shared.catalog_activation import materialize_catalog_ingredient
from .models import (
    BenchCostRecipe,
    BenchCostSettings,
    BenchCostStep,
    CatalogIngredient,
    Ingredient,
    Recipe,
    RecipeItem,
    RecipeStep,
    User,
    normalized_name,
)


# The sample recipe: it decides the pantry, so every line the catalog knows is
# activated and linked, and a line the catalog has no row for stays unlinked.
SAMPLE_ITEMS = [
    (260, "g", "Cake Flour", "sifted"),
    (2, "tsp", "Baking Powder", ""),
    (0.5, "tsp", "Baking Soda", ""),
    (0.5, "tsp", "Salt", ""),
    (3, "each", "Egg", "room temperature"),
    (240, "ml", "Buttermilk", "room temperature"),
    (2, "tsp", "Vanilla Extract", ""),
    (170, "g", "Butter", "softened"),
    (280, "g", "Granulated Sugar", ""),
]

SAMPLE_METHOD = [
    "Heat the oven to 175 °C. Butter two 20 cm round pans and line the bases.",
    "Sift the flour, baking powder, baking soda and salt together.",
    "Beat the butter until pale, then beat in the sugar until light and fluffy.",
    "Add the eggs a little at a time, beating well after each addition.",
    "Fold in the dry mix in three additions, alternating with the buttermilk "
    "and vanilla, and finish with flour.",
    "Divide between the pans and bake 30–35 minutes, until a skewer comes out "
    "clean. Cool 10 minutes in the pans, then turn out onto a rack.",
]

SAMPLE_STEPS = [
    ("Scale & mix", "active", 2),
    ("Pan up", "active", 2),
    ("Bake", "passive", 2),
    ("Cool & turn out", "passive", 2),
    ("Clean station", "active", 2),
]


@transaction.atomic
def seed_user_workspace(user: User) -> None:
    BenchCostSettings.objects.get_or_create(user=user)
    # The pantry is what the sample recipe calls for and nothing else; every
    # other catalog row waits to be pulled in by hand. Before the first
    # sync_catalog the catalog knows none of these names, which is not an error.
    wanted = {normalized_name(name) for _, _, name, _ in SAMPLE_ITEMS}
    for catalog in CatalogIngredient.objects.filter(
        is_active=True, normalized_name__in=wanted
    ):
        materialize_catalog_ingredient(user, catalog)
    recipe = Recipe.objects.create(
        user=user,
        title="Buttermilk Cake",
        code="RCP-0001",
        yield_amount=2,
        yield_unit="pcs",
    )
    pantry = {
        row.normalized_name: row for row in Ingredient.objects.filter(user=user)
    }
    RecipeItem.objects.bulk_create(
        [
            RecipeItem(
                recipe=recipe,
                kind=RecipeItem.INGREDIENT,
                position=position,
                display_name=name,
                quantity=Decimal(str(quantity)),
                unit=unit,
                preparation_note=note,
                ingredient=pantry.get(normalized_name(name)),
            )
            for position, (quantity, unit, name, note) in enumerate(SAMPLE_ITEMS)
        ]
    )
    RecipeStep.objects.bulk_create(
        [
            RecipeStep(recipe=recipe, body=body, position=position)
            for position, body in enumerate(SAMPLE_METHOD)
        ]
    )
    cost_recipe = BenchCostRecipe.objects.create(
        user=user,
        recipe=recipe,
        name=recipe.title,
        batch_yield=2,
        position=0,
    )
    BenchCostStep.objects.bulk_create(
        [
            BenchCostStep(
                recipe=cost_recipe,
                name=name,
                kind=kind,
                covers=covers,
                position=position,
            )
            for position, (name, kind, covers) in enumerate(SAMPLE_STEPS)
        ]
    )
