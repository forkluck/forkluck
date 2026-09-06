"""Recipe and bench-cost read endpoints.

Plain view functions: the internal-secret guard is applied by
internal_urls.py, so this module never reaches into the dispatch layer.
"""

import uuid
from datetime import date, datetime, time, timedelta, timezone as datetime_timezone

from django.db.models import Case, CharField, Count, Exists, F, OuterRef, Q, Value, When
from django.db.models import Prefetch
from django.db.models.query import prefetch_related_objects
from django.db.models.functions import Lower
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ...http.request import error
from ...models import (
    BenchCostRecipe,
    Menu,
    Recipe,
    RecipeBookRecipe,
    RecipeCategory,
    RecipeComment,
    RecipeItem,
    RecipeStep,
    RecipeTagMembership,
    User,
)
from ..shared.billing import write_blocked
from ..shared.pagination import (
    DOCUMENT_DEFAULT_ORDER,
    optional_filter,
    paginate,
    paginated_payload,
    parse_browse_query,
)
from ..shared.recipe_access import (
    accessible_recipe_queryset,
    kitchen_roles,
    recipe_permission,
)
from ..shared.search import recipe_search, relevance_order, search_tokens
from ..shared.values import uuid_value
from ..shared.vocabulary import unit_slugs
from .guest_links import resolve_book_link, resolve_guest_link
from .nutrition import recipe_nutrition_payload
from .health import (
    RecipeHealthReadModel,
    dashboard_overview_json,
    menu_component_price_payload,
    menu_detail_payload,
    menu_sources_payload,
    recipe_allergens_many,
    recipe_cost_diff_payload,
)
from .serializers import (
    cost_recipe_json,
    guest_recipe_json,
    menu_summary_json,
    recipe_json,
)


RECIPE_ORDERS = frozenset(
    {"name", "-name", "category", "-category", "updatedAt", "-updatedAt"}
)
# A recipe filed under another tenant's category reads as uncategorized, so the
# sort follows the displayed value rather than the raw foreign row.
_CATEGORY_SORT = Lower(
    Case(
        When(category__user_id=F("user_id"), then=F("category__name")),
        default=Value(None),
        output_field=CharField(),
    )
)
RECIPE_FILTERS = frozenset({"status", "kind", "category", "attention", "tags", "allergens", "ingredients", "ownership", "kitchen"})


def _csv(value: str | None) -> set[str]:
    return {part.strip() for part in (value or "").split(",") if part.strip()}


def _recipe_facets(rows: list[Recipe], viewer: User) -> dict[str, list[dict[str, object]]]:
    """Stable counts for the already-filtered, tenant-accessible rows."""
    status_keys = [key for key, _ in Recipe.STATUS_CHOICES]
    attention_keys = ["missingYield", "unresolvedItem", "missingQuantity", "unpricedIngredient"]
    statuses = {key: 0 for key in status_keys}
    attention = {key: 0 for key in attention_keys}
    ownership = {"owned": 0, "shared": 0}
    categories: dict[str, dict[str, object]] = {}
    tags: dict[str, dict[str, object]] = {}
    ingredients: dict[str, dict[str, object]] = {}
    allergens: dict[str, int] = {}
    allergen_sets = recipe_allergens_many(rows)
    for row in rows:
        statuses[row.status] = statuses.get(row.status, 0) + 1
        ownership["owned" if row.user_id == viewer.id else "shared"] += 1
        row_attention: set[str] = set()
        if row.yield_amount is None or row.yield_amount <= 0:
            row_attention.add("missingYield")
        for item in getattr(row, "_facet_items", []):
            if item.kind not in {RecipeItem.INGREDIENT, RecipeItem.SUBRECIPE}:
                continue
            if item.ingredient_id is None and item.subrecipe_id is None:
                row_attention.add("unresolvedItem")
            if item.quantity is None:
                row_attention.add("missingQuantity")
            if item.ingredient_id and (
                item.ingredient.purchase_cost_cents <= 0
                or not item.ingredient.purchase_size
                or not item.ingredient.purchase_unit
            ):
                row_attention.add("unpricedIngredient")
        row_targets: dict[str, str] = {}
        for item in getattr(row, "_facet_items", []):
            if item.ingredient_id:
                row_targets[str(item.ingredient_id)] = item.ingredient.name
            elif item.subrecipe_id:
                row_targets[str(item.subrecipe_id)] = f"Recipe · {item.subrecipe.title}"
        for key, name in row_targets.items():
            target = ingredients.setdefault(
                key, {"id": key, "name": name, "count": 0}
            )
            target["count"] = int(target["count"]) + 1
        for key in row_attention:
            attention[key] += 1
        if row.category_id and row.category.user_id == row.user_id:
            key = str(row.category_id)
            category = categories.setdefault(key, {"id": key, "name": row.category.name, "count": 0})
            category["count"] = int(category["count"]) + 1
        for membership in getattr(row, "_facet_tags", []):
            key = str(membership.tag_id)
            tag = tags.setdefault(key, {"id": key, "name": membership.tag.name, "count": 0})
            tag["count"] = int(tag["count"]) + 1
        for key in allergen_sets.get(row.id, {}):
            allergens[key] = allergens.get(key, 0) + 1
    return {
        "status": [{"key": key, "count": statuses[key]} for key in status_keys],
        "attention": [{"key": key, "count": attention[key]} for key in attention_keys],
        "category": sorted(categories.values(), key=lambda value: (str(value["name"]).lower(), str(value["id"]))),
        "tags": sorted(tags.values(), key=lambda value: (str(value["name"]).lower(), str(value["id"]))),
        "ingredients": sorted(ingredients.values(), key=lambda value: (str(value["name"]).lower(), str(value["id"]))),
        "allergens": [{"key": key, "count": allergens[key]} for key in sorted(allergens)],
        "ownership": [{"key": key, "count": ownership[key]} for key in ("owned", "shared")],
    }


def _recipe_detail_queryset(user: User):
    visible_parent_ids = accessible_recipe_queryset(
        user, prefetch_shares=False
    ).values("id")
    return accessible_recipe_queryset(user).select_related("category", "user").prefetch_related(
        "external_refs",
        # A linked recipe's own lines ride along with the parent's items, so
        # expanding a sub-recipe row costs one more query, not one per row.
        Prefetch(
            "items",
            queryset=RecipeItem.objects.select_related("ingredient", "subrecipe").prefetch_related(
                "subrecipe__items"
            ),
        ),
        Prefetch("steps", queryset=RecipeStep.objects.prefetch_related("timings", "media")),
        "batch_sizes",
        "equivalency",
        Prefetch("tag_memberships", queryset=RecipeTagMembership.objects.select_related("tag")),
        Prefetch("comments", queryset=RecipeComment.objects.select_related("author")),
        "media",
        "guest_links",
        # The books this recipe was shared inside, for the owner's Share
        # dialog. Scoped to the owner's own books, and carrying the size of
        # each so the row can name an untitled one.
        Prefetch(
            "book_items",
            queryset=RecipeBookRecipe.objects.filter(book__user=user)
            .select_related("book")
            .annotate(_book_recipe_count=Count("book__items"))
            .order_by("book__created_at", "book_id"),
            to_attr="_book_items",
        ),
        # The parent lines that link this recipe, for the "used in" list.
        Prefetch(
            "parent_items",
            queryset=RecipeItem.objects.filter(
                recipe_id__in=visible_parent_ids
            ).select_related("recipe"),
            to_attr="_parent_items",
        ),
    )


def _browse_recipes(request: HttpRequest):
    browse = parse_browse_query(
        request.GET,
        allowed_orders=RECIPE_ORDERS,
        default_order=DOCUMENT_DEFAULT_ORDER,
        extra_keys=RECIPE_FILTERS,
    )
    status = optional_filter(request.GET, "status")
    if status not in {None, *(choice for choice, _ in Recipe.STATUS_CHOICES)}:
        raise ValueError("Invalid status")
    kind = optional_filter(request.GET, "kind")
    if kind not in {None, *(choice for choice, _ in Recipe.KIND_CHOICES)}:
        raise ValueError("Invalid kind")
    category = optional_filter(request.GET, "category")
    # The recipe list is one kitchen at a time. Without the parameter it is
    # the caller's own — their recipes and the ones shared with them one by
    # one — so a membership never mixes another kitchen's book into it.
    kitchen = optional_filter(request.GET, "kitchen")
    kitchen_owner_id = None
    if kitchen is not None:
        kitchen_owner_id = uuid_value(kitchen, "kitchen")
        if (
            kitchen_owner_id != request.user.id
            and kitchen_owner_id not in kitchen_roles(request.user)
        ):
            raise ValueError("Invalid kitchen")

    rows = accessible_recipe_queryset(
        request.user, kitchens=kitchen_owner_id is not None
    ).select_related(
        "category", "user", "equivalency"
    ).annotate(
        _has_normalized_items=Exists(
            RecipeItem.objects.filter(recipe_id=OuterRef("pk"))
        )
        | Exists(RecipeStep.objects.filter(recipe_id=OuterRef("pk")))
    )
    if kitchen_owner_id is not None:
        rows = rows.filter(user_id=kitchen_owner_id)
    # After the kitchen filter: "no recipes yet" is asked of the kitchen on
    # screen, not of everything the caller can reach.
    has_any_recipe = rows.exists()
    if status is not None:
        rows = rows.filter(status=status)
    if kind is not None:
        rows = rows.filter(kind=kind)
    if category is not None:
        category_id = uuid_value(category, "category")
        if not rows.filter(
            category_id=category_id,
            category__user_id=F("user_id"),
        ).exists():
            raise ValueError("Invalid category")
        rows = rows.filter(category_id=category_id)
    ownership = _csv(request.GET.get("ownership"))
    if ownership - {"owned", "shared"}:
        raise ValueError("Invalid ownership filter")
    if ownership == {"owned"}:
        rows = rows.filter(user=request.user)
    elif ownership == {"shared"}:
        rows = rows.exclude(user=request.user)
    tags = _csv(request.GET.get("tags") or request.GET.get("tag"))
    if tags:
        rows = rows.filter(Q(tag_memberships__tag_id__in=tags) | Q(tag_memberships__tag__normalized_name__in=tags)).distinct()
    ingredients = _csv(request.GET.get("ingredients") or request.GET.get("ingredient"))
    if ingredients:
        rows = rows.filter(
            Q(items__ingredient_id__in=ingredients)
            | Q(items__ingredient__normalized_name__in=ingredients)
            | Q(items__subrecipe_id__in=ingredients)
            | Q(items__subrecipe__title__in=ingredients)
        ).distinct()
    allergens = _csv(request.GET.get("allergens") or request.GET.get("allergen"))
    if allergens:
        candidates = list(
            rows.select_related(None).prefetch_related(
                Prefetch(
                    "items",
                    queryset=RecipeItem.objects.select_related(
                        "ingredient__catalog_ingredient",
                        "ingredient__catalog_product__ingredient",
                        "subrecipe",
                    ).prefetch_related(
                        "ingredient__allergen_overrides",
                        "ingredient__catalog_ingredient__allergen_defaults",
                        "ingredient__catalog_product__ingredient__allergen_defaults",
                    ),
                    to_attr="_facet_items",
                )
            )
        )
        allergen_sets = recipe_allergens_many(candidates)
        matching_ids = [
            recipe.id
            for recipe in candidates
            if allergens & allergen_sets.get(recipe.id, {}).keys()
        ]
        rows = rows.filter(id__in=matching_ids)
    attention = _csv(request.GET.get("attention"))
    allowed_attention = {"missingYield", "unresolvedItem", "missingQuantity", "unpricedIngredient"}
    if attention - allowed_attention:
        raise ValueError("Invalid attention filter")
    if attention:
        q = Q()
        if "missingYield" in attention:
            q |= Q(yield_amount__isnull=True)
        if "unresolvedItem" in attention:
            q |= Q(items__kind__in={"ingredient", "subrecipe"}, items__ingredient__isnull=True, items__subrecipe__isnull=True)
        if "missingQuantity" in attention:
            q |= Q(items__kind__in={"ingredient", "subrecipe"}, items__quantity__isnull=True)
        if "unpricedIngredient" in attention:
            q |= (
                Q(items__ingredient__purchase_cost_cents__lte=0)
                | Q(items__ingredient__purchase_size__isnull=True)
                | Q(items__ingredient__purchase_unit__isnull=True)
                | Q(items__ingredient__purchase_unit="")
            )
        rows = rows.filter(q).distinct()
    tokens = search_tokens(browse.query) if browse.query else []
    if tokens:
        rows = rows.filter(recipe_search(request.user.id, tokens))
    facet_rows = list(
        rows.select_related("category", "user")
        .prefetch_related(
            Prefetch(
                "items",
                queryset=RecipeItem.objects.select_related(
                    "ingredient__catalog_ingredient",
                    "ingredient__catalog_product__ingredient",
                    "subrecipe",
                ).prefetch_related(
                    "ingredient__allergen_overrides",
                    "ingredient__catalog_ingredient__allergen_defaults",
                    "ingredient__catalog_product__ingredient__allergen_defaults",
                ),
                to_attr="_facet_items",
            ),
            Prefetch(
                "tag_memberships",
                queryset=RecipeTagMembership.objects.select_related("tag"),
                to_attr="_facet_tags",
            ),
        )
    )
    facets = _recipe_facets(facet_rows, request.user)
    # Relevance leads a searched list unless a column was chosen.
    if tokens and not browse.ordered_explicitly:
        rows = rows.order_by(
            *relevance_order("title", tokens), Lower("title").asc(), "id"
        )
    elif browse.order == "name":
        rows = rows.order_by(Lower("title").asc(), "id")
    elif browse.order == "-name":
        rows = rows.order_by(Lower("title").desc(), "id")
    elif browse.order == "category":
        rows = rows.order_by(
            _CATEGORY_SORT.asc(nulls_last=True), Lower("title").asc(), "id"
        )
    elif browse.order == "-category":
        rows = rows.order_by(
            _CATEGORY_SORT.desc(nulls_last=True), Lower("title").asc(), "id"
        )
    elif browse.order == "updatedAt":
        rows = rows.order_by("updated_at", "id")
    else:
        rows = rows.order_by("-updated_at", "id")
    page, total = paginate(rows, browse)
    return browse, page, total, facets, has_any_recipe


def recipes(request: HttpRequest) -> JsonResponse:
    try:
        browse, page, total, facets, has_any_recipe = _browse_recipes(request)
    except ValueError as exc:
        return error(str(exc))
    payload = paginated_payload(
            [recipe_json(row, full=False, viewer_user=request.user, include_costs=recipe_permission(row, request.user) == "owner") for row in page], browse, total
        )
    payload["queryCount"] = total
    payload["facets"] = facets
    payload["hasAnyRecipe"] = has_any_recipe
    return JsonResponse(payload)


def recipe_health(request: HttpRequest) -> JsonResponse:
    """Paginated recipe rows with costing already resolved for this tenant."""
    try:
        browse, page, total, facets, has_any_recipe = _browse_recipes(request)
    except ValueError as exc:
        return error(str(exc))
    if any(getattr(recipe, "_has_normalized_items", False) for recipe in page):
        prefetch_related_objects(
            page,
            Prefetch(
                "items",
                queryset=RecipeItem.objects.select_related(
                    "ingredient", "subrecipe__equivalency"
                ),
                to_attr="_normalized_items",
            ),
            Prefetch(
                "steps",
                queryset=RecipeStep.objects.prefetch_related("timings"),
                to_attr="_normalized_steps",
            ),
        )
    model = RecipeHealthReadModel(request.user)
    health_rows = model.rows(page)
    # Costing is private to the recipe owner. Shared rows retain the exact
    # health wire shape but carry no cost-derived values, avoiding both owner
    # leakage and attempts to price against the viewer's pantry.
    for recipe, row in zip(page, health_rows):
        permission = recipe_permission(recipe, request.user)
        row.update(
            {
                "ownerId": str(recipe.user_id),
                "ownerName": recipe.user.name,
                "permission": permission,
                "canEdit": permission in {"owner", "editor"},
                "canDelete": permission == "owner",
                "canViewCost": permission == "owner",
            }
        )
        if permission != "owner":
            row.update({
                "ingredientCents": None,
                "menuPriceCents": None,
                "foodCost": None,
                "labor": None,
                "overTarget": False,
                "issues": (
                    ["no yield"]
                    if recipe.yield_amount is None or recipe.yield_amount <= 0
                    else []
                ),
            })
    payload = paginated_payload(health_rows, browse, total)
    payload["categories"] = [
        {"id": str(row["id"]), "label": str(row["name"])}
        for row in facets["category"]
    ]
    payload["hasAnyRecipe"] = has_any_recipe
    payload["currencyCode"] = model.settings.currency_code
    payload["queryCount"] = total
    payload["facets"] = facets
    return JsonResponse(payload)


def dashboard_overview(request: HttpRequest) -> JsonResponse:
    """Constant-size recipe and pantry metrics for the analytics landing page."""
    return JsonResponse(
        dashboard_overview_json(RecipeHealthReadModel(request.user, dashboard=True))
    )


def recipe_detail(request: HttpRequest, recipe_ref: str) -> JsonResponse:
    queryset = _recipe_detail_queryset(request.user)
    # Short URLs route by the globally unique public id; UUIDs and legacy
    # RCP codes keep working as fallbacks for old links.
    if recipe_ref.startswith("rcp_"):
        row = queryset.filter(public_id=recipe_ref).first()
    else:
        try:
            row = queryset.filter(id=uuid.UUID(recipe_ref)).first()
        except ValueError:
            row = queryset.filter(code__iexact=recipe_ref).first()
    if row is None:
        return JsonResponse({"item": None})
    permission = recipe_permission(row, request.user)
    payload = recipe_json(
        row,
        viewer_user=request.user,
        include_costs=permission == "owner",
    )
    if permission == "owner":
        row._has_normalized_items = bool(
            list(row.items.all()) or list(row.steps.all())
        )
        row._normalized_items = list(row.items.all())
        row._normalized_steps = list(row.steps.all())
        model = RecipeHealthReadModel(request.user)
        cost = model.costs_for([row.id]).get(str(row.id))
        health = model.row(row, cost)
        item_costs = model.normalized_item_costs(row)
        for item in payload["items"]:
            item["costCents"] = item_costs.get(item["id"])
        payload.update(
            {
                "ingredientCostCents": health["ingredientCents"],
                "foodCost": health["foodCost"],
                "attention": health["issues"],
            }
        )
    else:
        payload.update(
            {
                "ingredientCostCents": None,
                "foodCost": None,
                "attention": [],
            }
        )
    return JsonResponse({"item": payload})


def _owned_recipe(user: User, recipe_ref: str) -> Recipe | None:
    queryset = Recipe.objects.filter(user=user)
    if recipe_ref.startswith("rcp_"):
        return queryset.filter(public_id=recipe_ref).first()
    try:
        return queryset.filter(id=uuid.UUID(recipe_ref)).first()
    except ValueError:
        return queryset.filter(code__iexact=recipe_ref).first()


def _cost_diff_start(request: HttpRequest, to_at: datetime) -> tuple[datetime, str]:
    if set(request.GET) - {"from"}:
        raise ValueError("Only from is accepted")
    if "from" in request.GET and len(request.GET.getlist("from")) != 1:
        raise ValueError("From must be supplied once")
    raw = request.GET.get("from")
    if raw is None:
        start_date = (to_at - timedelta(days=90)).date()
        source = "default90Days"
    else:
        try:
            start_date = date.fromisoformat(raw)
        except ValueError as exc:
            raise ValueError("From must be YYYY-MM-DD") from exc
        if start_date.isoformat() != raw:
            raise ValueError("From must be YYYY-MM-DD")
        if start_date > to_at.date():
            raise ValueError("From cannot be in the future")
        source = "requestedDate"
    return (
        datetime.combine(start_date, time.min, tzinfo=datetime_timezone.utc),
        source,
    )


def recipe_cost_diff(request: HttpRequest, recipe_ref: str) -> JsonResponse:
    """Price today's owned recipe graph at the start and end of one window."""
    recipe = _owned_recipe(request.user, recipe_ref)
    if recipe is None:
        return error("Recipe not found", 404)
    to_at = timezone.now()
    try:
        from_at, source = _cost_diff_start(request, to_at)
    except ValueError as exc:
        return error(str(exc), 400)
    model = RecipeHealthReadModel(request.user)
    return JsonResponse(
        {
            "item": recipe_cost_diff_payload(
                model,
                recipe,
                from_at=from_at,
                to_at=to_at,
                window_source=source,
            )
        }
    )


def recipe_nutrition(request: HttpRequest, recipe_ref: str) -> JsonResponse:
    """The label preview rollup for one recipe the user can open."""
    queryset = accessible_recipe_queryset(request.user).select_related(
        "user", "equivalency"
    )
    if recipe_ref.startswith("rcp_"):
        row = queryset.filter(public_id=recipe_ref).first()
    else:
        try:
            row = queryset.filter(id=uuid.UUID(recipe_ref)).first()
        except ValueError:
            row = queryset.filter(code__iexact=recipe_ref).first()
    if row is None:
        return JsonResponse({"item": None})
    return JsonResponse({"item": recipe_nutrition_payload(row, request.user)})


def _guest_recipe_queryset():
    """Everything a guest payload reads, one query per collection."""
    return Recipe.objects.select_related("user").prefetch_related(
        Prefetch(
            "items",
            queryset=RecipeItem.objects.select_related("subrecipe").prefetch_related(
                "subrecipe__items"
            ),
        ),
        "steps",
        "batch_sizes",
    )


def guest_recipe(request: HttpRequest, token: str) -> JsonResponse:
    """The lean read a capability link serves; the token is the authorization.

    An archived recipe still serves: archiving is filing, and the owner
    revokes by deleting the link. A closed workspace does not, so the same
    lock that stops the owner writing stops their links being read.
    """
    link = resolve_guest_link(token)
    if link is None:
        return error("Not found", 404)
    owner = link.recipe.user
    if not owner.is_active or write_blocked(owner):
        return error("Not found", 404)
    row = _guest_recipe_queryset().get(id=link.recipe_id)
    return JsonResponse({"item": guest_recipe_json(row, link.role)})


def guest_book(request: HttpRequest, token: str) -> JsonResponse:
    """The same lean read for several recipes at once, behind one token.

    A book is a snapshot of the selection: the recipes inside stay live, and
    one that has since been deleted simply drops out. A book whose recipes
    are all gone is a dead link and answers 404, like a revoked one.
    """
    book = resolve_book_link(token)
    if book is None:
        return error("Not found", 404)
    owner = book.user
    if not owner.is_active or write_blocked(owner):
        return error("Not found", 404)
    ordered_ids = list(book.items.values_list("recipe_id", flat=True))
    rows = {row.id: row for row in _guest_recipe_queryset().filter(id__in=ordered_ids)}
    # Reordered here rather than in SQL: the fetch is one `id__in` query and
    # the send order lives in the item rows, not in the recipe table.
    recipes = [rows[recipe_id] for recipe_id in ordered_ids if recipe_id in rows]
    if not recipes:
        return error("Not found", 404)
    noun = "recipe" if len(recipes) == 1 else "recipes"
    title = book.title or f"{len(recipes)} {noun} from {owner.name}"
    return JsonResponse(
        {
            "item": {
                "title": title,
                "ownerName": owner.name,
                "role": book.role,
                "recipes": [guest_recipe_json(row, book.role) for row in recipes],
            }
        }
    )


def recipe_categories(request: HttpRequest) -> JsonResponse:
    """Every category in this tenant's recipe vocabulary, empty ones included."""
    rows = (
        RecipeCategory.objects.filter(user=request.user)
        .annotate(
            usage_count=Count("recipes", filter=Q(recipes__user=request.user))
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


def recipes_export(request: HttpRequest) -> JsonResponse:
    """One complete row per recipe for the CSV export: identity, costing, and
    the full body/method so an exported recipe can be pasted back in."""
    model = RecipeHealthReadModel(request.user)
    recipes = list(
        Recipe.objects.filter(user=request.user)
        .select_related("category")
        .order_by(Lower("title").asc(), "id")
    )
    items = [
        {
            "publicId": row["publicId"],
            "title": row["title"],
            "kind": row["kind"],
            "status": row["status"],
            "category": row["category"],
            "yieldAmount": recipe.yield_amount,
            "yieldUnit": recipe.yield_unit,
            "menuPriceCents": row["menuPriceCents"],
            "ingredientCents": row["ingredientCents"],
            "laborCentsPerPiece": (row["labor"] or {}).get("centsPerPiece"),
            "foodCost": row["foodCost"],
            "body": recipe.body,
            "method": recipe.method,
            "updatedAt": row["updatedAt"],
        }
        for recipe, row in zip(recipes, model.rows(recipes))
    ]
    return JsonResponse(
        {"currencyCode": model.settings.currency_code, "items": items}
    )


def cost_queryset(user: User):
    return BenchCostRecipe.objects.filter(user=user).prefetch_related("steps__timings")


def cost_recipes(request: HttpRequest) -> JsonResponse:
    return JsonResponse(
        {"items": [cost_recipe_json(row) for row in cost_queryset(request.user)]}
    )


def cost_recipe_detail(request: HttpRequest, recipe_ref: str) -> JsonResponse:
    queryset = cost_queryset(request.user)
    # A recipe public id (or legacy code) resolves to that recipe's cost
    # entry, mirroring the short /recipes/ URLs; UUIDs still address the cost
    # entry directly.
    if recipe_ref.startswith("rcp_"):
        recipe = Recipe.objects.filter(
            user=request.user, public_id=recipe_ref
        ).first()
        row = queryset.filter(recipe=recipe).first() if recipe else None
    else:
        try:
            row = queryset.filter(id=uuid.UUID(recipe_ref)).first()
        except ValueError:
            recipe = Recipe.objects.filter(
                user=request.user, code__iexact=recipe_ref
            ).first()
            row = queryset.filter(recipe=recipe).first() if recipe else None
    return JsonResponse({"item": cost_recipe_json(row) if row else None})


def cost_recipe_for_recipe(request: HttpRequest, recipe_id: uuid.UUID) -> JsonResponse:
    row = BenchCostRecipe.objects.filter(
        user=request.user, recipe_id=recipe_id
    ).first()
    return JsonResponse({"id": str(row.id) if row else None})


def menus(request: HttpRequest) -> JsonResponse:
    rows = list(
        Menu.objects.filter(user=request.user).annotate(item_count=Count("items"))
    )
    return JsonResponse(
        {
            "menus": [menu_summary_json(row) for row in rows],
            "hasAnyMenu": bool(rows),
        }
    )


def _owned_menu(user: User, menu_ref: str) -> Menu | None:
    queryset = Menu.objects.filter(user=user)
    if menu_ref.startswith("mnu_"):
        return queryset.filter(public_id=menu_ref).first()
    try:
        return queryset.filter(id=uuid.UUID(menu_ref)).first()
    except ValueError:
        return None


def menu_detail(request: HttpRequest, menu_ref: str) -> JsonResponse:
    menu = _owned_menu(request.user, menu_ref)
    if menu is None:
        return error("Menu not found", 404)
    return JsonResponse(menu_detail_payload(request.user, menu))


def _component_unit(value: str | None) -> str:
    if value not in unit_slugs():
        raise ValueError("Invalid unit")
    return value


def menu_sources(request: HttpRequest) -> JsonResponse:
    return JsonResponse(menu_sources_payload(request.user))


def menu_component_price(request: HttpRequest) -> JsonResponse:
    try:
        ingredient_id = uuid_value(request.GET.get("ingredientId"), "ingredient id")
        unit = _component_unit(request.GET.get("unit"))
    except ValueError as exc:
        return error(str(exc), 400)
    payload = menu_component_price_payload(request.user, str(ingredient_id), unit)
    if payload is None:
        return error("Ingredient not found", 404)
    return JsonResponse(payload)
