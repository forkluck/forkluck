"""Ingredient read endpoints.

Plain view functions: the internal-secret guard is applied by
internal_urls.py, so this module never reaches into the dispatch layer.
"""

import re
from collections import defaultdict

from django.db.models import Count, Exists, OuterRef, Prefetch, Q
from django.db.models.functions import Lower
from django.http import HttpRequest, JsonResponse

from ...http.request import error
from ...models import (
    CatalogIngredientMeasure,
    Ingredient,
    IngredientAllergenOverride,
    IngredientCategory,
    IngredientImport,
    IngredientMeasure,
    IngredientTag,
    Recipe,
    SupplierItem,
)
from ..shared.pagination import (
    DOCUMENT_DEFAULT_ORDER,
    optional_filter,
    paginate,
    paginated_payload,
    parse_browse_query,
)
from ..shared.ingredient_identity import (
    owned_line_match_queryset,
    unique_catalog_aliases,
)
from ..shared.preparations import ingredient_measure_name
from ..shared.search import ingredient_search, relevance_order, search_tokens
from ..shared.values import normalized_name, uuid_value
from ..shared.vocabulary import profile_measure_names
from .serializers import (
    editor_recipe_json,
    ingredient_import_json,
    ingredient_json,
    ingredient_measure_json,
    ingredient_option_json,
    pricing_entry_json,
    effective_allergens,
)


INGREDIENT_ORDERS = frozenset({"name", "-name", "updatedAt", "-updatedAt"})


def ingredients(request: HttpRequest) -> JsonResponse:
    try:
        browse = parse_browse_query(
            request.GET,
            allowed_orders=INGREDIENT_ORDERS,
            default_order=DOCUMENT_DEFAULT_ORDER,
            extra_keys={
                "attention",
                "tag",
                "allergen",
                "match",
                "status",
                "category",
                "kind",
            },
        )
        owned_rows = Ingredient.objects.filter(user=request.user).select_related(
            "category"
        )
        rows = owned_rows
        # An archived ingredient is out of the pantry unless it is asked for:
        # the default list is what the kitchen buys today.
        status = optional_filter(request.GET, "status")
        if status is None:
            rows = rows.filter(status=Ingredient.STATUS_ACTIVE)
        elif status in {choice for choice, _ in Ingredient.STATUS_CHOICES}:
            rows = rows.filter(status=status)
        elif status != "all":
            raise ValueError("Invalid status")
        # Supplies live in the same table but have their own list: the pantry
        # is food unless a kind is asked for.
        kind = optional_filter(request.GET, "kind")
        if kind is None or kind == "food":
            rows = rows.filter(non_edible=False)
        elif kind == "supply":
            rows = rows.filter(non_edible=True)
        elif kind != "all":
            raise ValueError("Invalid kind")
        category = optional_filter(request.GET, "category")
        if category is not None:
            category_id = uuid_value(category, "category")
            if not IngredientCategory.objects.filter(
                user=request.user, id=category_id
            ).exists():
                raise ValueError("Invalid category")
            rows = rows.filter(category_id=category_id)
        attention = _csv_filter(request.GET.get("attention"))
        if attention:
            allowed_attention = {
                "missingPrice",
                "missingPurchaseSize",
                "missingPurchaseUnit",
            }
            if attention - allowed_attention:
                raise ValueError("Invalid attention filter")
            if "missingPrice" in attention:
                rows = rows.filter(purchase_cost_cents__lte=0)
            if "missingPurchaseSize" in attention:
                rows = rows.filter(purchase_size__isnull=True)
            if "missingPurchaseUnit" in attention:
                rows = rows.filter(Q(purchase_unit__isnull=True) | Q(purchase_unit=""))
        tags = _csv_filter(request.GET.get("tag"))
        if tags:
            match_mode = request.GET.get("match", "any")
            if match_mode not in {"any", "all"}:
                raise ValueError("Invalid match mode")
            tag_q = Q(tags__id__in=tags) | Q(tags__normalized_name__in=tags)
            if match_mode == "all":
                for tag in tags:
                    rows = rows.filter(Q(tags__id=tag) | Q(tags__normalized_name=tag))
            else:
                rows = rows.filter(tag_q)
        allergens = _csv_filter(request.GET.get("allergen"))
        if allergens:
            match_mode = request.GET.get("match", "any")
            if match_mode not in {"any", "all"}:
                raise ValueError("Invalid allergen match mode")

            def allergen_q(key: str) -> Q:
                override = Q(
                    allergen_overrides__allergen=key,
                    allergen_overrides__status__in={"contains", "mayContain"},
                )
                catalog = Q(
                    catalog_ingredient__allergen_defaults__allergen=key,
                    catalog_ingredient__allergen_defaults__status__in={
                        "contains",
                        "mayContain",
                    },
                ) & ~Exists(
                    IngredientAllergenOverride.objects.filter(
                        ingredient=OuterRef("pk"), allergen=key
                    )
                )
                return override | catalog

            if match_mode == "all":
                for key in allergens:
                    rows = rows.filter(allergen_q(key))
            else:
                query = Q()
                for key in allergens:
                    query |= allergen_q(key)
                rows = rows.filter(query)
        if tags or allergens:
            rows = rows.distinct()
        tokens = search_tokens(browse.query) if browse.query else []
        if tokens:
            rows = rows.filter(ingredient_search(request.user.id, tokens))
        # Facets are calculated from the same filtered tenant queryset as the
        # page, so counts never disclose another tenant and queryCount is the
        # exact count represented by pagination.
        facet_rows = list(
            rows.select_related(
                "catalog_ingredient", "catalog_product__ingredient"
            ).prefetch_related(
                "tags", "allergen_overrides", "catalog_ingredient__allergen_defaults"
            )
        )
        facets = _ingredient_facets(facet_rows)
        # Relevance leads a searched list unless a column was chosen.
        if tokens and not browse.ordered_explicitly:
            rows = rows.order_by(
                *relevance_order("normalized_name", tokens),
                Lower("name").asc(),
                "id",
            )
        elif browse.order == "name":
            rows = rows.order_by(Lower("name").asc(), "id")
        elif browse.order == "-name":
            rows = rows.order_by(Lower("name").desc(), "id")
        elif browse.order == "updatedAt":
            rows = rows.order_by("updated_at", "id")
        else:
            rows = rows.order_by("-updated_at", "id")
        page, total = paginate(
            rows.select_related(
                "catalog_ingredient", "catalog_product__ingredient", "conversion"
            ).prefetch_related(
                "price_history",
                "preparations",
                "tags",
                "allergen_overrides",
                "catalog_ingredient__allergen_defaults",
                Prefetch(
                    "supplier_items",
                    queryset=SupplierItem.objects.filter(user=request.user),
                ),
            ),
            browse,
        )
    except ValueError as exc:
        return error(str(exc))
    payload = paginated_payload(
        [ingredient_json(row, detail=False) for row in page], browse, total
    )
    payload["queryCount"] = total
    payload["facets"] = facets
    payload["hasAnyIngredient"] = total > 0 if not browse.query else owned_rows.exists()
    return JsonResponse(payload)


def _ingredient_facets(rows: list[Ingredient]) -> dict[str, list[dict[str, object]]]:
    attention = {
        key: 0 for key in ("missingPrice", "missingPurchaseSize", "missingPurchaseUnit")
    }
    tags: dict[str, dict[str, object]] = {}
    categories: dict[str, dict[str, object]] = {}
    allergens: dict[str, int] = {}
    for row in rows:
        if row.purchase_cost_cents <= 0:
            attention["missingPrice"] += 1
        if row.purchase_size in (None, 0):
            attention["missingPurchaseSize"] += 1
        if not row.purchase_unit:
            attention["missingPurchaseUnit"] += 1
        for tag in row.tags.all():
            item = tags.setdefault(
                str(tag.id), {"id": str(tag.id), "name": tag.name, "count": 0}
            )
            item["count"] = int(item["count"]) + 1
        if row.category_id and row.category.user_id == row.user_id:
            key = str(row.category_id)
            category = categories.setdefault(
                key, {"id": key, "name": row.category.name, "count": 0}
            )
            category["count"] = int(category["count"]) + 1
        for allergen in effective_allergens(row):
            if allergen["status"] in {"contains", "mayContain"}:
                key = str(allergen["key"])
                allergens[key] = allergens.get(key, 0) + 1
    return {
        "attention": [{"key": key, "count": count} for key, count in attention.items()],
        "category": sorted(
            categories.values(),
            key=lambda item: (str(item["name"]).lower(), str(item["id"])),
        ),
        "tags": sorted(
            tags.values(), key=lambda item: (str(item["name"]).lower(), str(item["id"]))
        ),
        "allergens": [
            {"key": key, "count": count} for key, count in sorted(allergens.items())
        ],
    }


def _csv_filter(value: str | None) -> set[str]:
    return {piece.strip() for piece in (value or "").split(",") if piece.strip()}


def ingredient_detail(request: HttpRequest, ingredient_ref: str) -> JsonResponse:
    row = (
        Ingredient.objects.filter(user=request.user, public_id=ingredient_ref)
        .select_related(
            "category",
            "catalog_ingredient",
            "catalog_product__ingredient",
            "conversion",
        )
        .prefetch_related(
            "preparations",
            "price_history",
            "tags",
            "allergen_overrides",
            "catalog_ingredient__allergen_defaults",
            "nutrition_requests",
            "invoice_prices__invoice_line__invoice",
            Prefetch(
                "supplier_items",
                queryset=SupplierItem.objects.filter(user=request.user),
            ),
        )
        .first()
    )
    return JsonResponse({"item": ingredient_json(row, detail=True) if row else None})


def ingredient_options(request: HttpRequest) -> JsonResponse:
    """Lightweight tenant index for dialogs that operate across browse pages."""
    # A new recipe line is never started from an archived ingredient; the
    # lines that already name one keep costing from it.
    rows = Ingredient.objects.filter(
        user=request.user, status=Ingredient.STATUS_ACTIVE
    ).order_by(Lower("name").asc(), "id")
    return JsonResponse({"items": [ingredient_option_json(row) for row in rows]})


def ingredient_tags(request: HttpRequest) -> JsonResponse:
    """Every tag in this tenant's ingredient vocabulary."""
    rows = (
        IngredientTag.objects.filter(user=request.user)
        .annotate(
            usage_count=Count(
                "memberships",
                filter=Q(memberships__ingredient__user=request.user),
            )
        )
        .order_by(Lower("name").asc(), "id")
    )
    return JsonResponse(
        {
            "items": [
                {"id": str(row.id), "name": row.name, "count": row.usage_count}
                for row in rows
            ]
        }
    )


def ingredient_categories(request: HttpRequest) -> JsonResponse:
    """Every category in this tenant's pantry vocabulary.

    The detail page needs the whole list, which a filtered browse's facet
    cannot give it.
    """
    rows = (
        IngredientCategory.objects.filter(user=request.user)
        .annotate(
            usage_count=Count("ingredients", filter=Q(ingredients__user=request.user))
        )
        .order_by(Lower("name").asc(), "id")
    )
    return JsonResponse(
        {
            "items": [
                {"id": str(row.id), "name": row.name, "count": row.usage_count}
                for row in rows
            ]
        }
    )


def pricing_entries(request: HttpRequest) -> JsonResponse:
    """Everything the recipe editor prices with, in one unpaginated read."""
    items = (
        Ingredient.objects.filter(user=request.user)
        .select_related(
            "catalog_ingredient", "catalog_product__ingredient", "conversion"
        )
        .prefetch_related("preparations")
        .order_by(Lower("name").asc(), "id")
    )
    recipes = (
        Recipe.objects.filter(user=request.user)
        .select_related("category", "equivalency")
        .order_by(Lower("title").asc(), "id")
    )
    return JsonResponse(
        {
            "items": [pricing_entry_json(row) for row in items],
            "recipes": [editor_recipe_json(row) for row in recipes],
        }
    )


def ingredient_measures(request: HttpRequest) -> JsonResponse:
    """Shared reviewed defaults plus overrides owned by the current tenant.

    The shared half is narrowed to the identities this tenant's editor can
    resolve a line to — their own ingredients' canonical measure names, plus the
    built-in ingredient profiles every line is matched against. Shipping the
    whole global catalog grew the editor payload with a catalog no tenant owns.
    """
    reachable = {
        normalized_name(ingredient_measure_name(row))
        for row in Ingredient.objects.filter(user=request.user).select_related(
            "catalog_ingredient", "catalog_product__ingredient"
        )
    }
    reachable.update(profile_measure_names())
    catalog_rows = CatalogIngredientMeasure.objects.select_related("ingredient").filter(
        ingredient__normalized_name__in=reachable,
        ingredient__is_active=True,
        is_active=True,
        is_default=True,
    )
    user_rows = IngredientMeasure.objects.select_related("ingredient").filter(
        ingredient__user=request.user
    )
    return JsonResponse(
        {
            "items": [
                *[ingredient_measure_json(row) for row in catalog_rows],
                *[ingredient_measure_json(row) for row in user_rows],
            ]
        }
    )


def _edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def _duplicate_reason(left: str, right: str) -> str | None:
    left = normalized_name(left)
    right = normalized_name(right)
    if not left or not right or left == right:
        return None
    if " ".join(sorted(left.split())) == " ".join(sorted(right.split())):
        return "Same words in a different order"
    left_numbers = re.findall(r"\d+(?:\.\d+)?", left)
    right_numbers = re.findall(r"\d+(?:\.\d+)?", right)
    if left_numbers != right_numbers:
        return None
    if (
        min(len(left), len(right)) >= 8
        and len(left.split()) == len(right.split())
        and _edit_distance(left, right) == 1
    ):
        return "Names differ by one character"
    return None


def _bounded_candidate_pairs(names: list[str], limit: int) -> list[tuple[int, int]]:
    """Find plausible pairs in roughly O(total name length), retaining order."""
    candidates: set[tuple[int, int]] = set()

    def remember(indices: list[int]) -> None:
        retained = 0
        for left_offset, left in enumerate(indices):
            for right in indices[left_offset + 1 :]:
                candidates.add((left, right))
                retained += 1
                if retained == limit:
                    return

    # Word-order duplicates share one canonical token signature.
    word_groups: dict[tuple[str, ...], list[int]] = defaultdict(list)
    # Equal-length Levenshtein-distance-one strings share a wildcard form.
    wildcard_groups: dict[tuple[int, tuple[str, ...], int, str], list[int]] = (
        defaultdict(list)
    )
    # A one-character insertion/deletion shares the shorter spelling.
    exact_groups: dict[tuple[int, tuple[str, ...], int, str], list[int]] = defaultdict(
        list
    )
    deletion_groups: dict[tuple[int, tuple[str, ...], int, str], list[int]] = (
        defaultdict(list)
    )

    for index, name in enumerate(names):
        words = name.split()
        numbers = tuple(re.findall(r"\d+(?:\.\d+)?", name))
        if len(words) > 1:
            word_groups[tuple(sorted(words))].append(index)
        if len(name) < 8:
            continue
        key_prefix = (len(words), numbers)
        exact_groups[(*key_prefix, len(name), name)].append(index)
        for position in range(len(name)):
            wildcard = f"{name[:position]}\0{name[position + 1 :]}"
            wildcard_groups[(*key_prefix, len(name), wildcard)].append(index)
            deleted = f"{name[:position]}{name[position + 1 :]}"
            deletion_groups[(*key_prefix, len(name) - 1, deleted)].append(index)

    for group in word_groups.values():
        remember(group)
    for group in wildcard_groups.values():
        remember(group)
    for key, shorter_indices in exact_groups.items():
        longer_indices = deletion_groups.get(key)
        if not longer_indices:
            continue
        retained = 0
        for left in shorter_indices:
            for right in longer_indices:
                if left != right:
                    candidates.add((min(left, right), max(left, right)))
                    retained += 1
                    if retained == limit:
                        break
            if retained == limit:
                break

    return sorted(candidates)[:limit]


def ingredient_duplicates(request: HttpRequest) -> JsonResponse:
    """At most twenty tenant-scoped duplicate candidates for the table banner."""
    rows = list(
        Ingredient.objects.filter(user=request.user)
        .only("id", "name")
        .order_by(Lower("name").asc(), "id")
    )
    normalized = [normalized_name(row.name) for row in rows]
    items = []
    for left_index, right_index in _bounded_candidate_pairs(normalized, 20):
        left = rows[left_index]
        right = rows[right_index]
        reason = _duplicate_reason(left.name, right.name)
        if reason is None:
            continue
        items.append(
            {
                "leftId": str(left.id),
                "leftName": left.name,
                "rightId": str(right.id),
                "rightName": right.name,
                "reason": reason,
            }
        )
    return JsonResponse({"items": items})


def ingredient_imports(request: HttpRequest) -> JsonResponse:
    rows = list(IngredientImport.objects.filter(user=request.user)[:20])
    latest_active = next((row for row in rows if row.undone_at is None), None)
    return JsonResponse(
        {
            "items": [
                ingredient_import_json(
                    row,
                    can_undo=latest_active is not None and row.id == latest_active.id,
                )
                for row in rows
            ]
        }
    )


def matches(request: HttpRequest) -> JsonResponse:
    """Tenant line-identity review list.

    This is named for what the rows mean: a
    recipe line match is not an alternate pantry name and is never included
    in ingredient browse/detail/search payloads.
    """
    rows = owned_line_match_queryset(request.user).select_related(
        "ingredient", "component_recipe"
    )
    items = []
    seen_lines: set[str] = set()
    for row in rows:
        target = row.ingredient or row.component_recipe
        target_id = row.ingredient_id or row.component_recipe_id
        line = row.text
        seen_lines.add(row.normalized_text)
        target_kind = "ingredient" if row.ingredient_id else "recipe"
        items.append(
            {
                "line": line,
                "targetId": str(target_id),
                "targetName": target.name
                if target_kind == "ingredient"
                else target.title,
                "targetKind": target_kind,
                "source": "user",
            }
        )
    owned = {
        str(row.id): row
        for row in Ingredient.objects.filter(
            user=request.user, catalog_ingredient__isnull=False
        ).select_related("catalog_ingredient")
    }
    for line, target_id, _kind in unique_catalog_aliases(request.user):
        if line in seen_lines:
            continue
        target = owned.get(target_id)
        if target is not None:
            items.append(
                {
                    "line": line,
                    "targetId": target_id,
                    "targetName": target.name,
                    "targetKind": "ingredient",
                    "source": "catalog",
                }
            )
    return JsonResponse({"items": items})
