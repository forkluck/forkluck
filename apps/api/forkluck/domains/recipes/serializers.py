"""Recipe and bench-cost JSON shapes."""

from typing import Any

from django.db.models import Q

from ...models import (
    SavedComparison,
    BenchCostRecipe,
    BenchCostStep,
    BenchCostTiming,
    Ingredient,
    Menu,
    MenuItem,
    Recipe,
    RecipeComment,
    RecipeItem,
    RecipeMedia,
    RecipeExternalRef,
    RecipeStep,
    RecipeTiming,
)
from ..shared.recipe_access import accessible_recipe_queryset, recipe_permission
from ..shared.recipe_equivalency import equivalency_json
from ..shared.values import iso

JsonObject = dict[str, Any]


def external_ref_json(row: RecipeExternalRef) -> JsonObject:
    return {
        "id": str(row.id),
        "system": row.system,
        "refKind": row.ref_kind,
        "externalId": row.external_id,
    }


def subrecipe_line_json(item: RecipeItem) -> JsonObject:
    """One line of a nested recipe, shown inside the parent's expanded row."""
    return {
        "kind": item.kind,
        "quantity": float(item.quantity) if item.quantity is not None else None,
        "unit": item.unit,
        "displayName": item.display_name,
        "preparationNote": item.preparation_note,
        "subrecipeId": str(item.subrecipe_id) if item.subrecipe_id else None,
        "excludedFromCost": item.excluded_from_cost,
    }


def subrecipe_json(row: Recipe) -> JsonObject:
    """A linked recipe as the parent line shows it: its yield and its lines.

    One level deep on purpose. A nested line names its own subrecipe by id so
    the reader can follow it, but carries no lines of its own.
    """
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "title": row.title,
        "yieldAmount": row.yield_amount,
        "yieldUnit": row.yield_unit,
        "items": [subrecipe_line_json(child) for child in row.items.all()],
    }


def recipe_item_json(item: RecipeItem) -> JsonObject:
    return {
        "id": str(item.id),
        "kind": item.kind,
        "position": item.position,
        "displayName": item.display_name,
        "quantity": float(item.quantity) if item.quantity is not None else None,
        "unit": item.unit,
        "preparationNote": item.preparation_note,
        "efficiency": float(item.efficiency),
        "efficiencyAfterCooking": float(item.efficiency_after_cooking),
        "isBase": item.is_base,
        "excludedFromCost": item.excluded_from_cost,
        "ingredientId": str(item.ingredient_id) if item.ingredient_id else None,
        "subrecipeId": str(item.subrecipe_id) if item.subrecipe_id else None,
        "ingredientName": item.ingredient.name if item.ingredient_id else None,
        "subrecipeName": item.subrecipe.title if item.subrecipe_id else None,
        # Filled by the owner-only detail read after its normalized cost graph
        # has been evaluated. Writes and collaborator reads keep the same
        # shape without exposing pantry prices.
        "costCents": None,
        "resolved": bool(
            item.ingredient_id
            or item.subrecipe_id
            or item.kind in {RecipeItem.HEADER, RecipeItem.NOTE}
        ),
        "subrecipe": subrecipe_json(item.subrecipe) if item.subrecipe_id else None,
    }


def recipe_used_in_json(row: Recipe, *, viewer_user: Any) -> list[JsonObject]:
    """The recipes whose lines link this one as a sub-recipe, one entry each.

    Lines are summed only when the parent asks for it in one unit; mixed
    units have no total, so the first line stands for the parent rather than
    a number nobody wrote.
    """
    items = getattr(row, "_parent_items", None)
    if items is None:
        items = RecipeItem.objects.filter(
            subrecipe=row,
            recipe__in=accessible_recipe_queryset(viewer_user, prefetch_shares=False),
        ).select_related("recipe")
    lines: dict[Any, list[RecipeItem]] = {}
    for item in items:
        lines.setdefault(item.recipe_id, []).append(item)
    entries = []
    for parent_lines in lines.values():
        parent = parent_lines[0].recipe
        units = {item.unit for item in parent_lines}
        quantities = [item.quantity for item in parent_lines]
        if len(units) == 1 and all(value is not None for value in quantities):
            quantity = float(sum(quantities))
        else:
            quantity = (
                float(parent_lines[0].quantity)
                if parent_lines[0].quantity is not None
                else None
            )
        entries.append(
            {
                "id": str(parent.id),
                "publicId": parent.public_id,
                "title": parent.title,
                "status": parent.status,
                "quantity": quantity,
                "unit": parent_lines[0].unit,
            }
        )
    entries.sort(
        key=lambda entry: (
            entry["status"] != Recipe.STATUS_ACTIVE,
            str(entry["title"]).lower(),
            entry["id"],
        )
    )
    return entries


def timing_json(row: RecipeTiming | BenchCostTiming) -> JsonObject:
    return {
        "id": str(row.id),
        "stepId": str(row.step_id),
        "seconds": row.seconds,
        "yieldCount": row.yield_count,
        "createdAt": iso(row.created_at),
    }


def normalized_step_json(row: RecipeStep) -> JsonObject:
    return {
        "id": str(row.id),
        "recipeId": str(row.recipe_id),
        "kind": row.kind,
        "title": row.title,
        "body": row.body,
        "position": row.position,
        "laborKind": row.labor_kind,
        "timings": [timing_json(timing) for timing in row.timings.all()],
        "media": [media_json(media) for media in row.media.all()],
    }


def recipe_json(
    row: Recipe,
    *,
    full: bool = True,
    viewer_user=None,
    include_costs: bool | None = None,
) -> JsonObject:
    # Category ids are user-owned too. Normal write paths only attach a
    # category from the recipe's owner, but the read boundary remains safe if
    # legacy/admin data ever violates that invariant.
    category = (
        row.category
        if row.category is not None and row.category.user_id == row.user_id
        else None
    )
    owner_view = viewer_user is None or viewer_user.id == row.user_id
    permission = (
        recipe_permission(row, viewer_user) if viewer_user is not None else "owner"
    )
    if include_costs is None:
        include_costs = owner_view
    result: JsonObject = {
        "id": str(row.id),
        "publicId": row.public_id,
        "title": row.title,
        "code": row.code,
        "kind": row.kind,
        "status": row.status,
        "locked": row.locked,
        "categoryId": str(category.id) if category else None,
        "category": category.name if category else None,
        # Legacy text remains available as a rendered/import compatibility
        # field for this release; normalized rows below are authoritative.
        "body": row.body,
        "method": row.method,
        "yieldAmount": row.yield_amount,
        "yieldUnit": row.yield_unit,
        "description": row.description,
        "servingAmount": float(row.serving_amount)
        if row.serving_amount is not None
        else None,
        "servingUnit": row.serving_unit,
        "nutritionServingAmount": (
            float(row.nutrition_serving_amount)
            if row.nutrition_serving_amount is not None
            else None
        ),
        "nutritionServingUnit": row.nutrition_serving_unit,
        "nutritionPackageAmount": (
            float(row.nutrition_package_amount)
            if row.nutrition_package_amount is not None
            else None
        ),
        "nutritionPackageUnit": row.nutrition_package_unit,
        "shelfLifeAmount": float(row.shelf_life_amount)
        if row.shelf_life_amount is not None
        else None,
        "shelfLifeUnit": row.shelf_life_unit,
        "prepTimeAmount": float(row.prep_time_amount)
        if row.prep_time_amount is not None
        else None,
        "prepTimeUnit": row.prep_time_unit,
        "autoSumYieldEnabled": row.auto_sum_yield_enabled,
        "autoPrepTimeEnabled": row.auto_prep_time_enabled,
        "percentageMode": row.percentage_mode,
        "percentIngredientEnabled": row.percent_ingredient_enabled,
        "percentIngredientType": row.percent_ingredient_type,
        # In the summary too: the recipe list shows menu price and food cost.
        "menuPriceCents": row.menu_price_cents if include_costs else None,
        "updatedAt": iso(row.updated_at),
    }
    if viewer_user is not None:
        result.update(
            {
                "ownerId": str(row.user_id),
                "ownerName": row.user.name,
                "permission": permission,
                "canEdit": permission in {"owner", "editor"},
                "canDelete": permission == "owner",
                "canViewCost": permission == "owner",
            }
        )
    if full:
        result.update(
            {
                "userId": str(row.user_id),
                "editVersion": row.edit_version,
                "createdAt": iso(row.created_at),
                "externalRefs": [
                    external_ref_json(ref) for ref in row.external_refs.all()
                ],
            }
        )
        if viewer_user is not None:
            can_edit = permission in {"owner", "editor"}
            result.update(
                {
                    "items": [recipe_item_json(item) for item in row.items.all()],
                    "steps": [normalized_step_json(step) for step in row.steps.all()],
                    "batchSizes": [
                        {
                            "id": str(batch.id),
                            "label": batch.label,
                            "scale": float(batch.scale),
                            "isOriginal": batch.is_original,
                        }
                        for batch in row.batch_sizes.all()
                    ],
                    "equivalency": equivalency_json(getattr(row, "equivalency", None)),
                    "tags": [
                        {"id": str(membership.tag_id), "name": membership.tag.name}
                        for membership in row.tag_memberships.select_related(
                            "tag"
                        ).all()
                    ],
                    "comments": [
                        comment_json(comment) for comment in row.comments.all()
                    ],
                    "media": [media_json(media) for media in row.media.all()],
                    "shares": [
                        {
                            "id": str(share.id),
                            "recipientId": str(share.recipient_id),
                            "recipientName": share.recipient.name,
                            "role": share.role,
                        }
                        for share in getattr(row, "_all_shares", [])
                    ]
                    if owner_view
                    else [],
                    # Guest links are the owner's own invitations, so a
                    # collaborator sees the key with an empty list.
                    "guestLinks": [
                        {
                            "id": str(link.id),
                            "email": link.email,
                            "role": link.role,
                            "createdAt": iso(link.created_at),
                        }
                        for link in row.guest_links.all()
                    ]
                    if owner_view
                    else [],
                    # A book is the owner's invitation too, listed on every
                    # recipe inside it so it can be revoked from any of them.
                    "bookLinks": [
                        {
                            "id": str(item.book_id),
                            "email": item.book.email,
                            "role": item.book.role,
                            "title": item.book.title,
                            "recipeCount": item._book_recipe_count,
                            "createdAt": iso(item.book.created_at),
                        }
                        for item in getattr(row, "_book_items", [])
                    ]
                    if owner_view
                    else [],
                    # Collaborators edit against the recipe owner's pantry and
                    # recipe library, but receive no prices or other private
                    # ingredient profile data.
                    "ingredientOptions": [
                        {"id": str(ingredient.id), "name": ingredient.name}
                        # A recipe never contains a supply, so packaging is
                        # not offered as a line.
                        for ingredient in Ingredient.objects.filter(
                            user_id=row.user_id,
                            status=Ingredient.STATUS_ACTIVE,
                        )
                        .exclude(non_edible=True)
                        .distinct()
                        .order_by("name", "id")
                    ]
                    if can_edit
                    else [],
                    "recipeOptions": [
                        {
                            "id": str(recipe.id),
                            "publicId": recipe.public_id,
                            "title": recipe.title,
                        }
                        for recipe in Recipe.objects.filter(
                            user_id=row.user_id,
                        )
                        .filter(
                            Q(status=Recipe.STATUS_ACTIVE) | Q(parent_items__recipe=row)
                        )
                        .exclude(id=row.id)
                        .distinct()
                        .order_by("title", "id")
                    ]
                    if can_edit
                    else [],
                    "usedIn": recipe_used_in_json(row, viewer_user=viewer_user),
                }
            )
    return result


def guest_recipe_line_json(item: RecipeItem) -> JsonObject:
    """One line of a nested recipe as a guest reads it: no ids, no costs."""
    return {
        "kind": item.kind,
        "displayName": item.display_name,
        "quantity": float(item.quantity) if item.quantity is not None else None,
        "unit": item.unit,
        "preparationNote": item.preparation_note,
    }


def guest_recipe_json(row: Recipe, role: str) -> JsonObject:
    """The read-only payload a capability link serves.

    Deliberately lean: what a cook needs to make the dish, and nothing that
    belongs to the owner's business — no ids, no costs, no nutrition. The
    role is the standing waiting for the address once it has an account; the
    link itself only ever reads. It rides on the link or the book rather
    than the recipe, so it is passed in.
    """
    return {
        "role": role,
        "title": row.title,
        "description": row.description,
        "yieldAmount": row.yield_amount,
        "yieldUnit": row.yield_unit,
        "servingAmount": float(row.serving_amount)
        if row.serving_amount is not None
        else None,
        "servingUnit": row.serving_unit,
        "batchSizes": [
            {
                "label": batch.label,
                "scale": float(batch.scale),
                "isOriginal": batch.is_original,
            }
            for batch in row.batch_sizes.all()
        ],
        "items": [
            {
                **guest_recipe_line_json(item),
                "subrecipe": {
                    "title": item.subrecipe.title,
                    "yieldAmount": item.subrecipe.yield_amount,
                    "yieldUnit": item.subrecipe.yield_unit,
                    "items": [
                        guest_recipe_line_json(child)
                        for child in item.subrecipe.items.all()
                    ],
                }
                if item.subrecipe_id
                else None,
            }
            for item in row.items.all()
        ],
        "steps": [
            {"kind": step.kind, "title": step.title, "body": step.body}
            for step in row.steps.all()
        ],
        "ownerName": row.user.name,
    }


def comment_json(row: RecipeComment) -> JsonObject:
    return {
        "id": str(row.id),
        "authorId": str(row.author_id),
        "authorName": row.author.name,
        "body": row.body,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }


def media_json(row: RecipeMedia) -> JsonObject:
    return {
        "id": str(row.id),
        "recipeId": str(row.recipe_id) if row.recipe_id else None,
        "stepId": str(row.step_id) if row.step_id else None,
        "url": row.url,
        "thumbnailUrl": row.thumbnail_url,
        "mobileUrl": row.mobile_url,
        "altText": row.alt_text,
        "position": row.position,
    }


def step_json(row: BenchCostStep) -> JsonObject:
    return {
        "id": str(row.id),
        "recipeId": str(row.recipe_id),
        "name": row.name,
        "kind": row.kind,
        "covers": row.covers,
        "position": row.position,
        "timings": [timing_json(timing) for timing in row.timings.all()],
    }


def cost_recipe_json(row: BenchCostRecipe) -> JsonObject:
    return {
        "id": str(row.id),
        "userId": str(row.user_id),
        "recipeId": str(row.recipe_id) if row.recipe_id else None,
        "name": row.name,
        "ingredientCostCents": row.ingredient_cost_cents,
        "packagingCostCents": row.packaging_cost_cents,
        "batchYield": row.batch_yield,
        "sellableYield": row.sellable_yield,
        "position": row.position,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
        "steps": [step_json(step) for step in row.steps.all()],
    }


def _comparison_column_title(column) -> str:
    return column.recipe.title if column.recipe_id else column.pasted_title


def saved_comparison_summary_json(row: SavedComparison) -> JsonObject:
    """Expects `columns` prefetched with their recipes."""
    columns = list(row.columns.all())
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "title": row.title,
        "view": row.view,
        "columnTitles": [_comparison_column_title(column) for column in columns],
        "columnCount": len(columns),
        "updatedAt": iso(row.updated_at),
    }


def saved_comparison_json(row: SavedComparison, accessible_recipe_ids) -> JsonObject:
    """Expects `columns` prefetched with their recipes.

    A recipe the reader can no longer open (a share withdrawn since the save)
    comes back as a column with no recipe, and is counted, so the page says
    how many are gone instead of quietly reading fewer.
    """
    columns = []
    missing = 0
    for column in row.columns.all():
        recipe = None
        if column.recipe_id:
            if column.recipe_id in accessible_recipe_ids:
                recipe = {
                    "publicId": column.recipe.public_id,
                    "title": column.recipe.title,
                }
            else:
                missing += 1
        columns.append(
            {
                "position": column.position,
                "recipe": recipe,
                "pastedTitle": column.pasted_title,
                "pastedText": column.pasted_text,
            }
        )
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "title": row.title,
        "view": row.view,
        "baselinePosition": row.baseline_position,
        "editVersion": row.edit_version,
        "columns": columns,
        "missingCount": missing,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }


def menu_summary_json(row: Menu) -> JsonObject:
    """Expects the `item_count` annotation from the menus list query."""
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "name": row.name,
        "periodStart": iso(row.period_start) if row.period_start else None,
        "periodEnd": iso(row.period_end) if row.period_end else None,
        "itemCount": row.item_count,
        "updatedAt": iso(row.updated_at),
    }


def menu_json(row: Menu) -> JsonObject:
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "editVersion": row.edit_version,
        "name": row.name,
        "periodStart": iso(row.period_start) if row.period_start else None,
        "periodEnd": iso(row.period_end) if row.period_end else None,
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }


def menu_ingredient_json(row: JsonObject) -> JsonObject:
    """A pantry row narrowed to what the component picker needs."""
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "purchaseUnit": row["purchase_unit"],
        "nonEdible": bool(row.get("non_edible", False)),
    }


def menu_item_json(
    item: MenuItem,
    *,
    food_cost_cents: int | None,
    source_qty_sold: float | None,
) -> JsonObject:
    """Name, category and price come from the link; an unlinked row keeps the
    name it was saved with and has no category or source figures."""
    product = item.product if item.product_id else None
    recipe = item.recipe if item.recipe_id else None
    if product is not None:
        name, category = product.name, product.category
        source_price = product.sell_price_cents or None
    elif recipe is not None:
        name = recipe.title
        category = recipe.category.name if recipe.category_id else ""
        source_price = recipe.menu_price_cents
    else:
        name, category, source_price = item.name, None, None
    return {
        "id": str(item.id),
        "name": name,
        "position": item.position,
        "sellPriceCents": item.sell_price_cents,
        "qtySold": float(item.qty_sold),
        "recipeId": str(item.recipe_id) if recipe else None,
        "recipePublicId": recipe.public_id if recipe else None,
        "recipeName": recipe.title if recipe else None,
        "productId": str(item.product_id) if product else None,
        "productPublicId": product.public_id if product else None,
        "productName": product.name if product else None,
        "category": category,
        "foodCostCents": food_cost_cents,
        "sourceSellPriceCents": source_price,
        "sourceQtySold": source_qty_sold,
        "original": {
            "sellPriceCents": item.original_sell_price_cents,
            "qtySold": float(item.original_qty_sold),
            "foodCostCents": item.original_food_cost_cents,
        },
    }


def menu_recipe_json(row: JsonObject) -> JsonObject:
    """A recipe health row narrowed to what the menu worksheet prices with."""
    return {
        "id": row["id"],
        "publicId": row["publicId"],
        "title": row["title"],
        "kind": row["kind"],
        "category": row["category"],
        "menuPriceCents": row["menuPriceCents"],
        "ingredientCents": row["ingredientCents"],
        "suffix": row["suffix"],
        "batchMeasures": row["batchMeasures"],
        "servingAmount": row["servingAmount"],
        "servingUnit": row["servingUnit"],
    }
