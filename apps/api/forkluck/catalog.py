import re

from .models import (
    IngredientCategory,
    Recipe,
    RecipeCategory,
    User,
    normalized_name as normalized_category_name,
)

RECIPE_CODE_PATTERN = re.compile(r"^RCP-(\d+)$")


def next_recipe_code(user: User) -> str:
    highest = 0
    codes = Recipe.objects.filter(user=user).exclude(code="").values_list(
        "code", flat=True
    )
    for code in codes:
        match = RECIPE_CODE_PATTERN.match(code)
        if match:
            highest = max(highest, int(match.group(1)))
    return f"RCP-{highest + 1:04d}"


def resolve_recipe_category(user: User, name: str | None) -> RecipeCategory | None:
    name = (name or "").strip()
    if not name:
        return None
    category, _ = RecipeCategory.objects.get_or_create(
        user=user,
        normalized_name=normalized_category_name(name),
        defaults={"name": name},
    )
    return category


def resolve_ingredient_category(
    user: User, name: str | None
) -> IngredientCategory | None:
    name = (name or "").strip()
    if not name:
        return None
    category, _ = IngredientCategory.objects.get_or_create(
        user=user,
        normalized_name=normalized_category_name(name),
        defaults={"name": name},
    )
    return category
