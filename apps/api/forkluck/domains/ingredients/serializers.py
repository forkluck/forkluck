"""Ingredient, import-batch and catalog-estimate JSON shapes."""

from typing import Any

from ...models import (
    CatalogIngredientMeasure,
    CatalogProduct,
    Ingredient,
    IngredientAllergenStatus,
    IngredientConversion,
    IngredientImport,
    IngredientMeasure,
    IngredientPrice,
    Preparation,
    Recipe,
    RecipeItem,
    SalesProductComponent,
)
from ...integrations.food_data import LABEL_VALUE_KEYS
from ..shared.allergen_hints import ingredient_allergen_hints
from ..shared.ingredient_identity import (
    recipes_using_ingredient,
    recipes_using_preparation,
)
from ..shared.recipe_equivalency import equivalency_json, recipe_equivalency
from ..shared.preparations import ingredient_measure_name
from ..shared.supplier_import import invoice_line_pack_price_cents
from ..shared.values import iso

JsonObject = dict[str, Any]


def _profile_json(row: Ingredient) -> JsonObject:
    """Stable profile controls shared by summary and detail payloads."""
    return {
        "tags": [{"id": str(tag.id), "name": tag.name} for tag in row.tags.all()],
    }


def _allergen_status(value: Any) -> str:
    return value


def effective_allergens(row: Ingredient) -> list[JsonObject]:
    """Merge tenant overrides over the adopted catalog defaults."""
    defaults = {}
    catalog = row.catalog_ingredient
    if catalog is None and row.catalog_product is not None:
        catalog = row.catalog_product.ingredient
    if catalog is not None:
        for item in catalog.allergen_defaults.all():
            value = item.status
            # A brand-dependent row is a hint, not a default; it belongs to
            # allergenHints and asserts nothing here.
            if value == IngredientAllergenStatus.CHECK_LABEL:
                continue
            defaults[item.allergen] = {
                "key": item.allergen,
                "status": _allergen_status(value),
                "source": "catalog",
            }
    for item in row.allergen_overrides.all():
        value = item.status
        defaults[item.allergen] = {
            "key": item.allergen,
            "status": _allergen_status(value),
            "source": "user",
        }
    return [defaults[key] for key in sorted(defaults)]


def _needs_attention(row: Ingredient) -> list[str]:
    reasons: list[str] = []
    if row.purchase_size in (None, 0):
        reasons.append("missingPurchaseSize")
    if not row.purchase_unit:
        reasons.append("missingPurchaseUnit")
    if row.purchase_cost_cents <= 0:
        reasons.append("missingPrice")
    return reasons


def ingredient_recipe_usage_json(row: Ingredient) -> list[JsonObject]:
    return [
        {"id": str(recipe.id), "publicId": recipe.public_id, "title": recipe.title}
        for recipe in recipes_using_ingredient(row.user, row)
    ]


def preparation_recipe_usage_json(row: Preparation) -> list[JsonObject]:
    return [
        {"id": str(recipe.id), "publicId": recipe.public_id, "title": recipe.title}
        for recipe in recipes_using_preparation(row.user, row)
    ]


def ingredient_linked_recipes_json(row: Ingredient) -> list[JsonObject]:
    """The recipes whose lines name this ingredient, one entry each.

    Lines are summed only when the recipe asks for the ingredient in one unit;
    mixed units have no total, so the first line stands for the recipe rather
    than a number nobody wrote.
    """
    lines: dict[Any, list[RecipeItem]] = {}
    items = RecipeItem.objects.filter(
        ingredient=row, recipe__user_id=row.user_id
    ).select_related("recipe")
    for item in items:
        lines.setdefault(item.recipe_id, []).append(item)
    entries = []
    for recipe_lines in lines.values():
        recipe = recipe_lines[0].recipe
        units = {item.unit for item in recipe_lines}
        quantities = [item.quantity for item in recipe_lines]
        if len(units) == 1 and all(value is not None for value in quantities):
            quantity = float(sum(quantities))
        else:
            quantity = decimal_json(recipe_lines[0].quantity)
        unit = recipe_lines[0].unit
        entries.append(
            {
                "id": str(recipe.id),
                "publicId": recipe.public_id,
                "title": recipe.title,
                "status": recipe.status,
                "quantity": quantity,
                "unit": unit,
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


def ingredient_linked_products_json(row: Ingredient) -> list[JsonObject]:
    """The products whose components name this ingredient, one entry each.

    A product composes from recipes and from ingredients directly, so this
    answers for food as well as for a supply. A component is unique per
    (product, ingredient), so a product says so once and the quantity is
    that one line's.
    """
    components = (
        SalesProductComponent.objects.filter(
            ingredient=row, product__user_id=row.user_id
        )
        .select_related("product")
        .order_by("product__name")
    )
    return [
        {
            "id": str(component.product.id),
            "publicId": component.product.public_id,
            "name": component.product.name,
            "isActive": component.product.is_active,
            "quantity": decimal_json(component.quantity),
            "unit": component.unit,
        }
        for component in components
    ]


def _nutrition_json(row: Ingredient) -> JsonObject | None:
    if row.nutrition_per_100g is None or row.nutrition_updated_at is None:
        return None
    values = row.nutrition_per_100g
    labels = (
        "calories",
        "water",
        "fat",
        "saturatedFat",
        "transFat",
        "protein",
        "sugars",
        "addedSugars",
        "starch",
        "fiber",
        "salt",
        "other",
        "totalCarbohydrate",
        "sodiumMg",
        "cholesterolMg",
        "vitaminDMcg",
        "calciumMg",
        "ironMg",
        "potassiumMg",
    )
    per_100g = {label: values.get(label) for label in labels}
    return {
        "source": row.nutrition_source,
        "sourceId": row.nutrition_source_id,
        "description": row.nutrition_description,
        "packageIngredients": row.nutrition_package_ingredients,
        "per100g": per_100g,
        "updatedAt": iso(row.nutrition_updated_at),
    }


def _nutrition_request_json(row: Ingredient) -> JsonObject | None:
    requests = list(row.nutrition_requests.all())
    if not requests:
        return None
    latest = max(requests, key=lambda item: item.created_at)
    values = latest.values if isinstance(latest.values, dict) else {}
    return {
        "id": str(latest.id),
        "status": latest.status,
        "servingGrams": float(latest.serving_grams),
        "values": {key: values.get(key) for key in LABEL_VALUE_KEYS},
        "source": latest.source,
        "note": latest.note,
        "createdAt": iso(latest.created_at),
    }


def _nutrition_per_100g(row: Ingredient) -> JsonObject | None:
    """Return the normalized nutrition composition used by pricing clients."""
    if row.nutrition_per_100g is None or row.nutrition_updated_at is None:
        return None
    labels = (
        "water",
        "fat",
        "saturatedFat",
        "protein",
        "sugars",
        "starch",
        "fiber",
        "salt",
        "other",
        "totalCarbohydrate",
        "sodiumMg",
        "calories",
        "transFat",
        "cholesterolMg",
        "addedSugars",
        "vitaminDMcg",
        "calciumMg",
        "ironMg",
        "potassiumMg",
    )
    return {label: row.nutrition_per_100g.get(label) for label in labels}


def _price_summary(row: IngredientPrice | None) -> JsonObject | None:
    if row is None:
        return None
    return {
        "purchaseCostCents": row.purchase_cost_cents,
        "purchaseSize": decimal_json(row.purchase_size),
        "purchaseUnit": row.purchase_unit,
        "effectiveAt": iso(row.effective_at),
    }


def ingredient_option_json(row: Ingredient) -> JsonObject:
    """The small identity shape used by cross-page ingredient pickers.

    `nonEdible` is what separates supplies from food in a picker that groups
    them, and it tells the invoice review which expense category a picked item
    belongs under.
    """
    return {"id": str(row.id), "name": row.name, "nonEdible": row.non_edible}


def ingredient_measure_json(
    row: IngredientMeasure | CatalogIngredientMeasure,
) -> JsonObject:
    ingredient = row.ingredient
    is_user_measure = isinstance(row, IngredientMeasure)
    return {
        "id": str(row.id),
        "ingredientId": str(ingredient.id) if is_user_measure else None,
        "name": ingredient.name,
        "normalizedName": ingredient.normalized_name,
        "unit": row.unit,
        "amount": float(row.amount),
        "grams": float(row.grams),
        "lowGrams": (
            float(row.low_grams)
            if isinstance(row, CatalogIngredientMeasure) and row.low_grams is not None
            else None
        ),
        "highGrams": (
            float(row.high_grams)
            if isinstance(row, CatalogIngredientMeasure) and row.high_grams is not None
            else None
        ),
        "qualifier": row.qualifier,
        "source": "user" if is_user_measure else "catalog",
        "confidence": (
            row.confidence if isinstance(row, CatalogIngredientMeasure) else "high"
        ),
    }


def decimal_json(value) -> float | None:
    """Decimal column → JSON number; DjangoJSONEncoder would emit a string."""
    return float(value) if value is not None else None


def ingredient_json(row: Ingredient, *, detail: bool = True) -> JsonObject:
    allergens = effective_allergens(row)
    # Category ids are user-owned too, so a row filed under another tenant's
    # category reads as uncategorized rather than leaking that name.
    category = (
        row.category
        if row.category is not None and row.category.user_id == row.user_id
        else None
    )
    prices = list(row.price_history.all())
    prices.sort(key=lambda p: p.effective_at, reverse=True)
    # Summary rows intentionally carry no history, supplier packs or
    # preparations. Detail is lazy-loaded by the ingredient page.
    payload = {
        "id": str(row.id),
        "publicId": row.public_id,
        "userId": str(row.user_id),
        "name": row.name,
        "normalizedName": row.normalized_name,
        "measureName": ingredient_measure_name(row),
        "purchaseCostCents": row.purchase_cost_cents,
        "purchaseSize": decimal_json(row.purchase_size),
        "purchaseUnit": row.purchase_unit,
        "priceSource": row.price_source,
        "categoryId": str(category.id) if category else None,
        "category": category.name if category else None,
        "status": row.status,
        "nonEdible": row.non_edible,
        **_profile_json(row),
        "previousPrice": _price_summary(prices[1] if len(prices) > 1 else None),
        "preferredSupplier": next(
            (
                {"id": str(item.id), "supplier": item.supplier, "title": item.title}
                for item in row.supplier_items.all()
                if item.is_preferred
            ),
            None,
        ),
        "effectiveAllergenKeys": sorted(
            item["key"]
            for item in allergens
            if item["status"] in {"contains", "mayContain"}
        ),
        "needsAttention": _needs_attention(row),
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }
    if not detail:
        return payload
    try:
        conversion = row.conversion
    except IngredientConversion.DoesNotExist:
        conversion = None
    payload.update(
        {
            "editVersion": row.edit_version,
            "yieldPercent": decimal_json(row.yield_percent),
            "usedInRecipes": ingredient_linked_recipes_json(row),
            "usedInProducts": ingredient_linked_products_json(row),
            "nutrition": _nutrition_json(row),
            "sugarsAreAdded": row.sugars_are_added,
            "nutritionLabelName": row.nutrition_label_name,
            "nutritionRequest": _nutrition_request_json(row),
            "effectiveAllergens": allergens,
            "allergenHints": ingredient_allergen_hints(row),
            "priceHistory": [
                {
                    "id": str(price.id),
                    "purchaseCostCents": price.purchase_cost_cents,
                    "purchaseSize": decimal_json(price.purchase_size),
                    "purchaseUnit": price.purchase_unit,
                    "source": price.source,
                    "effectiveAt": iso(price.effective_at),
                    "createdAt": iso(price.created_at),
                    "updatedAt": iso(price.updated_at),
                }
                for price in prices
            ],
            "supplierItems": [
                {
                    "id": str(item.id),
                    "supplier": item.supplier,
                    "externalId": item.external_id,
                    "title": item.title,
                    "rawSize": item.raw_size,
                    "packPriceCents": item.pack_price_cents,
                    "packGrams": item.pack_grams,
                    "packAmount": decimal_json(item.pack_amount),
                    "packUnit": item.pack_unit,
                    "purchasedQuantity": item.purchased_quantity,
                    "periodStart": item.period_start.isoformat()
                    if item.period_start
                    else None,
                    "periodEnd": item.period_end.isoformat()
                    if item.period_end
                    else None,
                    "isPreferred": item.is_preferred,
                    "updatedAt": iso(item.updated_at),
                }
                for item in sorted(
                    row.supplier_items.all(),
                    key=lambda item: (
                        not item.is_preferred,
                        item.supplier,
                        item.external_id,
                    ),
                )
            ],
            "invoicePrices": [
                {
                    "id": str(price.id),
                    "lineId": str(price.invoice_line_id),
                    "supplier": (
                        price.invoice_line.invoice.supplier_name
                        or price.invoice_line.invoice.supplier
                    ),
                    "title": price.invoice_line.description,
                    "externalId": price.invoice_line.sku,
                    "rawSize": price.invoice_line.pack_size,
                    "purchaseCostCents": invoice_line_pack_price_cents(
                        price.invoice_line
                    ),
                    "purchaseSize": decimal_json(price.purchase_size),
                    "purchaseUnit": price.purchase_unit,
                    "currencyCode": price.invoice_line.currency_code,
                    "invoiceNumber": price.invoice_line.invoice.invoice_number,
                    "invoiceDate": (
                        price.invoice_line.invoice.invoice_date.isoformat()
                        if price.invoice_line.invoice.invoice_date
                        else None
                    ),
                    "isUsedForCosting": (
                        row.purchase_cost_cents
                        == invoice_line_pack_price_cents(price.invoice_line)
                        and row.purchase_size == price.purchase_size
                        and (row.purchase_unit or "") == price.purchase_unit
                    ),
                    "createdAt": iso(price.created_at),
                    "updatedAt": iso(price.updated_at),
                }
                for price in row.invoice_prices.all()
            ],
            "preparations": [
                preparation_json(preparation) for preparation in row.preparations.all()
            ],
            "conversion": conversion_json(conversion),
        }
    )
    return payload


def conversion_json(row: IngredientConversion | None) -> JsonObject | None:
    if row is None:
        return None

    def number(value):
        return float(value) if value is not None else None

    def measure(amount, unit):
        return (
            {"amount": number(amount), "unit": unit}
            if amount is not None and unit
            else None
        )

    return {
        "usesStandardConversion": row.average_weight,
        "source": row.source,
        "confidence": row.confidence,
        "weight": measure(row.weight_amount, row.weight_unit),
        "volume": measure(row.volume_amount, row.volume_unit),
        "each": measure(row.each_amount, row.each_unit),
        "updatedAt": iso(row.updated_at),
    }


def preparation_json(row: Preparation) -> JsonObject:
    def number(value):
        return float(value) if value is not None else None

    def measure(amount, unit):
        return (
            {"amount": number(amount), "unit": unit}
            if amount is not None and unit
            else None
        )

    return {
        "id": str(row.id),
        "name": row.name,
        "yieldPercent": number(row.yield_percent),
        "source": row.source,
        "confidence": row.confidence,
        "usesStandardConversion": row.average_weight,
        "weight": measure(row.weight_amount, row.weight_unit),
        "volume": measure(row.volume_amount, row.volume_unit),
        "each": measure(row.each_amount, row.each_unit),
        "createdAt": iso(row.created_at),
        "updatedAt": iso(row.updated_at),
    }


def pricing_entry_json(row: Ingredient) -> JsonObject:
    """The pantry fields the recipe editor prices with, and nothing else."""
    try:
        conversion = row.conversion
    except IngredientConversion.DoesNotExist:
        conversion = None
    return {
        "id": str(row.id),
        "name": row.name,
        "normalizedName": row.normalized_name,
        "measureName": ingredient_measure_name(row),
        # Archived rows stay in this read: a line already naming one still
        # costs from it. The picker is what skips them.
        "status": row.status,
        # Supplies stay in this read for the same reason; the picker is what
        # keeps them out of a recipe.
        "nonEdible": row.non_edible,
        "purchaseCostCents": row.purchase_cost_cents,
        "purchaseSize": decimal_json(row.purchase_size),
        "purchaseUnit": row.purchase_unit,
        "yieldPercent": decimal_json(row.yield_percent),
        "conversion": conversion_json(conversion),
        "preparations": [
            preparation_json(preparation) for preparation in row.preparations.all()
        ],
        "nutritionPer100g": _nutrition_per_100g(row),
    }


def editor_recipe_json(row: Recipe) -> JsonObject:
    """The recipe fields component pricing and the category picker read.

    The equivalency travels with the yield because a line asking for a cup of
    a recipe weighed in grams has nothing else to go on.
    """
    category = (
        row.category
        if row.category is not None and row.category.user_id == row.user_id
        else None
    )
    return {
        "id": str(row.id),
        "title": row.title,
        "body": row.body,
        "kind": row.kind,
        "yieldAmount": row.yield_amount,
        "yieldUnit": row.yield_unit,
        "equivalency": equivalency_json(recipe_equivalency(row)),
        "category": category.name if category else None,
    }


def ingredient_import_json(
    row: IngredientImport, *, can_undo: bool = False
) -> JsonObject:
    return {
        "id": str(row.id),
        "fileName": row.file_name,
        "supplier": row.supplier,
        "periodStart": row.period_start.isoformat() if row.period_start else None,
        "periodEnd": row.period_end.isoformat() if row.period_end else None,
        "totalRows": row.total_rows,
        "importedCount": row.imported_count,
        "createdCount": row.created_count,
        "updatedCount": row.updated_count,
        "reviewCount": row.review_count,
        "ignoredCount": row.ignored_count,
        "createdAt": iso(row.created_at),
        "undoneAt": iso(row.undone_at) if row.undone_at else None,
        "canUndo": can_undo,
    }


def catalog_price_json(product: CatalogProduct) -> JsonObject:
    ingredient = product.ingredient
    if ingredient is None or product.pack_grams is None:
        raise ValueError("Catalog estimate is not available")
    return {
        "id": f"catalog:{product.id}",
        "catalogPriceId": str(product.id),
        "name": ingredient.name,
        "normalizedName": ingredient.normalized_name,
        "packPriceCents": product.pack_price_cents,
        "packGrams": product.pack_grams,
        "packAmount": decimal_json(product.pack_amount),
        "packUnit": product.pack_unit,
        "source": "catalog",
    }
