import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from django.db import transaction

from .models import (
    derive_public_id_from_uuid,
    normalized_name,
    BenchCostRecipe,
    BenchCostSettings,
    BenchCostStep,
    BenchCostTiming,
    Ingredient,
    IngredientAllergenOverride,
    NutritionSource,
    RecipeLineMatch,
    IngredientPrice,
    Recipe,
    RecipeCategory,
    User,
)


DEMO_EMAIL = "user@user.com"
DEMO_PASSWORD = "user"
DEMO_NAME = "Demo Chef"
DEMO_NAMESPACE = uuid.UUID("16b725a9-e47c-49f6-b22b-50360a1abf82")

# Deliberately synthetic demo prices: every ingredient costs $1/kg. Production
# starter estimates are loaded from a private, deployment-owned catalog.
DEMO_INGREDIENT_NAMES = (
    "Flour",
    "Baking Powder",
    "Baking Soda",
    "Brown Sugar",
    "Buttermilk",
    "Canned Tomatoes",
    "Cornstarch",
    "Dark Chocolate",
    "Extra Virgin Olive Oil",
    "Granulated Sugar",
    "Heavy Cream",
    "Kosher Salt",
    "Powdered Sugar",
    "Unsalted Butter",
    "Vanilla Extract",
    "Vegetable Stock",
    "Whole Eggs",
    "Whole Milk",
    "Yellow Onions",
)
INGREDIENTS = [(name, 100, 1, "kg") for name in DEMO_INGREDIENT_NAMES]

# Custom nutrition snapshots (per 100 g, the Ingredient.nutrition_per_100g
# shape) and allergen tags for a few pantry rows, so a fresh workspace can
# build a label preview without a USDA key. Values are textbook figures, not
# a sourced record.
DEMO_NUTRITION = {
    "Unsalted Butter": (
        {
            "water": 16.2, "fat": 81.1, "protein": 0.9, "sugars": 0.1,
            "starch": 0.0, "fiber": 0.0, "salt": 0.03, "other": 1.67,
            "totalCarbohydrate": 0.1, "sodiumMg": 11.0, "saturatedFat": 51.4,
            "calories": 717.0, "transFat": 3.3, "cholesterolMg": 215.0,
            "addedSugars": 0.0, "vitaminDMcg": 1.5, "calciumMg": 24.0,
            "ironMg": 0.02, "potassiumMg": 24.0,
        },
        {"milk": "contains"},
    ),
    "Flour": (
        {
            "water": 11.9, "fat": 1.0, "protein": 10.3, "sugars": 0.3,
            "starch": 73.3, "fiber": 2.7, "salt": 0.005, "other": 0.5,
            "totalCarbohydrate": 76.3, "sodiumMg": 2.0, "saturatedFat": 0.2,
            "calories": 364.0, "transFat": 0.0, "cholesterolMg": 0.0,
            "addedSugars": 0.0, "vitaminDMcg": 0.0, "calciumMg": 15.0,
            "ironMg": 1.2, "potassiumMg": 107.0,
        },
        {"wheat": "contains", "gluten_cereals": "contains"},
    ),
    "Whole Eggs": (
        {
            "water": 76.2, "fat": 9.5, "protein": 12.6, "sugars": 0.4,
            "starch": 0.0, "fiber": 0.0, "salt": 0.36, "other": 1.0,
            "totalCarbohydrate": 0.7, "sodiumMg": 142.0, "saturatedFat": 3.1,
            "calories": 143.0, "transFat": 0.0, "cholesterolMg": 372.0,
            "addedSugars": 0.0, "vitaminDMcg": 2.0, "calciumMg": 56.0,
            "ironMg": 1.8, "potassiumMg": 138.0,
        },
        {"egg": "contains"},
    ),
}


RECIPES = [
    {
        "title": "Sea Salt Chocolate Chip Cookies",
        "kind": Recipe.KIND_RECIPE,
        "category": "Cookies",
        "body": """650 g Bread Flour
8 g Baking Soda
12 g Kosher Salt
340 g Unsalted Butter
260 g Brown Sugar
180 g Granulated Sugar
200 g Whole Eggs
12 g Vanilla Extract
420 g Dark Chocolate""",
        "method": "Cream the butter and sugars. Add eggs and vanilla, then fold in the dry ingredients and chocolate. Portion, chill, and bake until the edges are set.",
        "yield_amount": 48,
        "yield_unit": "pcs",
        "menu_price_cents": 375,
    },
    {
        "title": "Buttermilk Biscuits",
        "kind": Recipe.KIND_RECIPE,
        "category": "Bread",
        "body": """1000 g Flour
42 g Baking Powder
18 g Kosher Salt
260 g Unsalted Butter
720 g Buttermilk""",
        "method": "Cut the cold butter into the dry ingredients. Fold in buttermilk, laminate three times, cut, and bake until deeply golden.",
        "yield_amount": 24,
        "yield_unit": "pcs",
        "menu_price_cents": 450,
    },
    {
        "title": "Roasted Tomato Soup",
        "kind": Recipe.KIND_RECIPE,
        "category": "Savory",
        "body": """5000 g Canned Tomatoes
700 g Yellow Onions
180 g Extra Virgin Olive Oil
1800 g Vegetable Stock
600 g Heavy Cream
35 g Kosher Salt""",
        "method": "Roast the tomatoes and onions until caramelized. Simmer with stock, blend smooth, finish with cream, and season.",
        "yield_amount": 7.2,
        "yield_unit": "kg",
        "menu_price_cents": 1400,
    },
    {
        "title": "Vanilla Pastry Cream",
        "kind": Recipe.KIND_COMPONENT,
        # Being a component is the recipe's kind, not a category.
        "category": None,
        "body": """1200 g Whole Milk
240 g Whole Eggs
220 g Granulated Sugar
90 g Cornstarch
80 g Unsalted Butter
12 g Vanilla Extract""",
        "method": "Temper the hot milk into the eggs, sugar, and cornstarch. Cook until bubbling, whisk in butter and vanilla, then chill over ice.",
        "yield_amount": 1.7,
        "yield_unit": "kg",
        "menu_price_cents": None,
    },
    {
        "title": "Chocolate Cream Tart",
        "kind": Recipe.KIND_RECIPE,
        "category": "Pastry",
        "body": """420 g Flour
80 g Powdered Sugar
220 g Unsalted Butter
100 g Whole Eggs
900 g Vanilla Pastry Cream
360 g Dark Chocolate
260 g Heavy Cream
8 g Kosher Salt""",
        "method": "Blind-bake the tart shells. Fold melted chocolate into pastry cream, fill the shells, chill, and finish with softly whipped cream.",
        "yield_amount": 12,
        "yield_unit": "pcs",
        "menu_price_cents": 1200,
    },
]


COSTS = {
    "Sea Salt Chocolate Chip Cookies": [
        ("Scale ingredients", "active", [310, 295, 305]),
        ("Mix dough", "active", [540, 515, 530]),
        ("Portion cookies", "active", [720, 690, 705]),
        ("Chill", "passive", [1800]),
        ("Bake and unload", "active", [480, 465, 470]),
        ("Package", "active", [390, 375, 385]),
    ],
    "Buttermilk Biscuits": [
        ("Scale and cut butter", "active", [360, 345, 355]),
        ("Mix and laminate", "active", [520, 500, 510]),
        ("Cut biscuits", "active", [300, 285, 295]),
        ("Bake", "passive", [1080]),
        ("Cool and pack", "active", [240, 225, 235]),
    ],
    "Roasted Tomato Soup": [
        ("Prep vegetables", "active", [780, 750, 765]),
        ("Roast", "passive", [2400]),
        ("Simmer and blend", "active", [900, 870, 885]),
        ("Portion", "active", [420, 405, 415]),
    ],
    "Chocolate Cream Tart": [
        ("Mix tart dough", "active", [540, 525, 535]),
        ("Line tart shells", "active", [960, 930, 945]),
        ("Blind bake", "passive", [1500]),
        ("Make filling", "active", [720, 700, 710]),
        ("Fill and finish", "active", [600, 580, 590]),
    ],
}


ALIASES = {
    "all purpose flour": "Flour",
    "ap flour": "Flour",
    "plain flour": "Flour",
    "butter": "Unsalted Butter",
    "dark choc": "Dark Chocolate",
    "evoo": "Extra Virgin Olive Oil",
    "pastry cream": "Vanilla Pastry Cream",
}


@dataclass(frozen=True)
class DemoSeedSummary:
    ingredients: int
    recipes: int
    cost_recipes: int


def _demo_id(email: str, model: str, key: str) -> uuid.UUID:
    return uuid.uuid5(DEMO_NAMESPACE, f"{email.lower()}:{model}:{key.lower()}")


def _demo_ingredient_key(name: str) -> str:
    # Preserve the deterministic IDs used by existing demo workspaces while
    # simplifying the display name on the row itself.
    return "All-Purpose Flour" if name == "Flour" else name


@transaction.atomic
def seed_demo_workspace(user: User) -> DemoSeedSummary:
    ingredients: dict[str, Ingredient] = {}
    old_effective_at = datetime(2026, 5, 1, 12, tzinfo=UTC)
    current_effective_at = datetime(2026, 8, 1, 12, tzinfo=UTC)

    for name, price_cents, amount, unit in INGREDIENTS:
        ingredient_key = _demo_ingredient_key(name)
        ingredient, _ = Ingredient.objects.update_or_create(
            id=_demo_id(user.email, "ingredient", ingredient_key),
            defaults={
                "user": user,
                "name": name,
                "purchase_cost_cents": price_cents,
                "purchase_size": amount,
                "purchase_unit": unit,
            },
        )
        ingredients[name] = ingredient

        nutrition = DEMO_NUTRITION.get(name)
        if nutrition is not None:
            per_100g, allergens = nutrition
            ingredient.nutrition_source = NutritionSource.CUSTOM
            ingredient.nutrition_source_id = ""
            ingredient.nutrition_description = "Custom nutrition value"
            ingredient.nutrition_per_100g = per_100g
            ingredient.nutrition_updated_at = current_effective_at
            ingredient.save(
                update_fields=[
                    "nutrition_source",
                    "nutrition_source_id",
                    "nutrition_description",
                    "nutrition_per_100g",
                    "nutrition_updated_at",
                ]
            )
            for allergen, status in allergens.items():
                IngredientAllergenOverride.objects.update_or_create(
                    ingredient=ingredient,
                    allergen=allergen,
                    defaults={"status": status},
                )

        for label, effective_at, point_price in (
            ("old", old_effective_at, round(price_cents * 0.92)),
            ("current", current_effective_at, price_cents),
        ):
            IngredientPrice.objects.update_or_create(
                id=_demo_id(
                    user.email,
                    "ingredient-price",
                    f"{ingredient_key}:{label}",
                ),
                defaults={
                    "ingredient": ingredient,
                    "purchase_cost_cents": point_price,
                    "purchase_size": amount,
                    "purchase_unit": unit,
                    "effective_at": effective_at,
                },
            )

    recipes: dict[str, Recipe] = {}
    for position, values in enumerate(RECIPES, start=1):
        title = str(values["title"])
        category_name = values.get("category")
        category = None
        if category_name:
            # Match on the natural key: the migration backfill may already have
            # created this category with a different id.
            category, _ = RecipeCategory.objects.update_or_create(
                user=user,
                normalized_name=normalized_name(str(category_name)),
                defaults={"name": category_name},
            )
        recipe_id = _demo_id(user.email, "recipe", title)
        recipe, _ = Recipe.objects.update_or_create(
            id=recipe_id,
            defaults={
                "user": user,
                **{key: value for key, value in values.items() if key != "category"},
                "category": category,
                # Deterministic identifiers keep reseeding idempotent.
                "code": f"RCP-{position:04d}",
                "public_id": derive_public_id_from_uuid("rcp", recipe_id),
            },
        )
        recipes[title] = recipe

    for alias, target_name in ALIASES.items():
        target_ingredient = ingredients.get(target_name)
        target_recipe = recipes.get(target_name)
        RecipeLineMatch.objects.update_or_create(
            user=user,
            normalized_text=normalized_name(alias),
            defaults={
                "text": alias,
                "ingredient": target_ingredient,
                "component_recipe": target_recipe,
            },
        )

    BenchCostSettings.objects.update_or_create(
        user=user,
        defaults={"wage_per_hour_cents": 2800},
    )

    for position, (title, steps) in enumerate(COSTS.items()):
        recipe = recipes[title]
        batch_yield = round(recipe.yield_amount or 1)
        cost_recipe, _ = BenchCostRecipe.objects.update_or_create(
            id=_demo_id(user.email, "cost-recipe", title),
            defaults={
                "user": user,
                "recipe": recipe,
                "name": title,
                "ingredient_cost_cents": 0,
                "packaging_cost_cents": 0,
                "batch_yield": batch_yield,
                "sellable_yield": None,
                "position": position,
            },
        )
        timing_yield = batch_yield
        for step_position, (step_name, kind, timings) in enumerate(steps):
            step, _ = BenchCostStep.objects.update_or_create(
                id=_demo_id(user.email, "cost-step", f"{title}:{step_name}"),
                defaults={
                    "recipe": cost_recipe,
                    "name": step_name,
                    "kind": kind,
                    "covers": timing_yield,
                    "position": step_position,
                },
            )
            for timing_position, seconds in enumerate(timings):
                BenchCostTiming.objects.update_or_create(
                    id=_demo_id(
                        user.email,
                        "cost-timing",
                        f"{title}:{step_name}:{timing_position}",
                    ),
                    defaults={
                        "step": step,
                        "seconds": seconds,
                        "yield_count": timing_yield,
                    },
                )

    return DemoSeedSummary(
        ingredients=len(INGREDIENTS),
        recipes=len(RECIPES),
        cost_recipes=len(COSTS),
    )
