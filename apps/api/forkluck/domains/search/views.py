"""Tenant-scoped data for the application-wide search palette."""

from urllib.parse import urlencode

from django.db.models.functions import Lower
from django.http import HttpRequest, JsonResponse

from ...models import Ingredient
from ..shared.pagination import parse_browse_query
from ..shared.recipe_access import accessible_recipe_queryset
from ..shared.search import (
    ingredient_search,
    recipe_search,
    relevance_order,
    search_tokens,
)
from .serializers import search_index_json, search_item_json


def search_index(request: HttpRequest) -> JsonResponse:
    # The palette has one fixed order — recipes, then ingredients — so the
    # empty string is the only `order` it accepts.
    try:
        query = parse_browse_query(
            request.GET, allowed_orders={""}, default_order=""
        ).query
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    recipe_rows = (
        accessible_recipe_queryset(request.user, prefetch_shares=False)
        .select_related("category")
        .only(
            "id",
            "title",
            "public_id",
            "code",
            "category__name",
            "category__user_id",
        )
    )
    # The same fields and ranking as the Recipes and Ingredients lists: a
    # query that finds a row on its own page has to find it here too.
    tokens = search_tokens(query)
    if tokens:
        recipe_rows = recipe_rows.filter(
            recipe_search(request.user.id, tokens)
        ).order_by(
            *relevance_order("title", tokens), Lower("title").asc(), "id"
        )[:9]
    else:
        recipe_rows = recipe_rows.order_by("-updated_at", "id")[:5]
    recipes = list(recipe_rows)

    ingredient_rows = Ingredient.objects.filter(user=request.user).only(
        "id", "name"
    )
    if tokens:
        ingredient_rows = ingredient_rows.filter(
            ingredient_search(request.user.id, tokens)
        ).order_by(
            *relevance_order("normalized_name", tokens),
            Lower("name").asc(),
            "id",
        )[:9]
    else:
        ingredient_rows = ingredient_rows.order_by("-updated_at", "id")[:4]
    ingredients = list(ingredient_rows)
    items = [
        search_item_json(
            label=row.title,
            href=f"/recipes/{row.public_id}",
            item_type="recipe",
        )
        for row in recipes
    ]
    items.extend(
        search_item_json(
            label=row.name,
            href=f"/ingredients?{urlencode({'q': row.name})}",
            item_type="ingredient",
        )
        for row in ingredients
    )
    # Stable on type alone: recipes lead, and within a type the order the
    # database returned is the ranking.
    type_order = {"recipe": 0, "ingredient": 1}
    items.sort(key=lambda item: type_order[item["type"]])
    return JsonResponse(search_index_json(items[:9]))
