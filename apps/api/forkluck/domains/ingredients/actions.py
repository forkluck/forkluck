"""Ingredient and price mutations.

apply_supplier_import_entry() is the single place a supplier-linked price
row is written, so the spreadsheet import and the invoice import update the
same records the same way and share one undo history.
"""

import logging
import math
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Prefetch, Q
from django.db.models.deletion import ProtectedError, RestrictedError
from django.utils import timezone

from ...catalog import (
    normalized_category_name,
    resolve_ingredient_category,
)
from ...integrations.emails import (
    EmailNotConfigured,
    send_nutrition_request_notification,
)
from ...integrations.food_data import (
    LABEL_VALUE_KEYS,
    FoodDataError,
    get_food,
    label_nutrition_per_100g,
    search_foods,
)

from ...master_prices import (
    MASTER_PRICES_BY_ID,
    MASTER_PRICES_BY_NAME,
    master_price_json,
    normalized_ingredient_name,
)
from ...models import (
    BenchCostSettings,
    CatalogAccess,
    CatalogIngredient,
    CatalogIngredientAlias,
    CatalogPreparationYield,
    CatalogProduct,
    Ingredient,
    IngredientCategory,
    IngredientConversion,
    IngredientImport,
    IngredientImportItem,
    IngredientInvoicePrice,
    IngredientMeasure,
    IngredientMeasureConfidence,
    IngredientTag,
    IngredientTagMembership,
    IngredientAllergenOverride,
    IngredientPrice,
    InvoiceLine,
    MasterPriceAccess,
    MasterPriceDismissal,
    NutritionRequest,
    Preparation,
    RecipeItem,
    SalesProductComponent,
    RecipeLineMatch,
    SupplierItem,
    SupplierItemIgnore,
    User,
)
from ..shared.activity import record_event
from ..shared.billing import require_entitlement
from ..shared.catalog_activation import (
    catalog_conversion_fields,
    materialize_catalog_ingredient,
)
from ..shared.density import (
    MILLILITERS_PER_CUP,
    default_standard_grams_per_cup,
    grams_for,
)
from ..shared.fuzzy import fuzzy_matches
from ..shared.locking import lock_workspace
from ..shared.versioning import check_and_bump
from ..shared.preparations import seeded_preparation_yield
from ..shared.values import (
    bool_value,
    import_date_value,
    int_value,
    normalized_name,
    number_value,
    optional_text,
    text_value,
    uuid_value,
    yield_percent_value,
)
from ..shared.ingredient_pricing import (
    PRICE_FIELDS,
    apply_price,
    create_priced_ingredient,
    price_changed,
    record_price,
    rematerialize_price,
)
from ..shared.supplier_import import (
    PURCHASE_KEYS,
    apply_supplier_import_entry,
    ingredient_snapshot,
    ingredient_values,
    upsert_supplier_ignores,
)
from .serializers import (
    catalog_price_json,
    ingredient_json,
    ingredient_recipe_usage_json,
    preparation_recipe_usage_json,
)

JsonObject = dict[str, Any]

logger = logging.getLogger(__name__)


def ingredient_status_value(value: Any) -> str:
    if value not in {choice for choice, _ in Ingredient.STATUS_CHOICES}:
        raise ValueError("Invalid ingredient status")
    return value


def _set_ingredient_tags(user: User, row: Ingredient, tags: Any) -> None:
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError("Invalid ingredient tags")
    rows = [
        IngredientTag.objects.get_or_create(
            user=user,
            normalized_name=normalized_name(tag.strip()),
            defaults={"name": tag.strip()},
        )[0]
        for tag in dict.fromkeys(tag.strip() for tag in tags if tag.strip())
    ]
    row.tags.set(rows)


def action_save_ingredient(user: User, body: JsonObject) -> JsonObject:
    item_id = body.get("id")
    # Two half-payloads reach one action: a pack write carries the price and no
    # name, the form carries the name and no price. A create carries both.
    pack = not item_id or any(key in body for key in PURCHASE_KEYS)
    values: JsonObject = (
        ingredient_values(body, from_pack=False, require_name=not item_id)
        if pack
        else (
            {"name": text_value(body["name"], "Name", max_length=120).strip()}
            if "name" in body
            else {}
        )
    )
    # The yield is the ingredient's, not the price's, so it travels beside the
    # price fields rather than inside them. Absent leaves the saved one alone.
    yield_fields = {}
    yield_percent = yield_percent_value(body.get("yieldPercent"))
    if yield_percent is not None:
        yield_fields["yield_percent"] = yield_percent
    profile_fields: JsonObject = {}
    # A key that is not sent leaves the saved value alone; an explicit null
    # files the ingredient under nothing.
    if "category" in body:
        category_value = body.get("category")
        profile_fields["category"] = (
            resolve_ingredient_category(
                user, text_value(category_value, "Category", max_length=64).strip()
            )
            if category_value is not None
            else None
        )
    if body.get("status") is not None:
        profile_fields["status"] = ingredient_status_value(body.get("status"))
    if body.get("nonEdible") is not None:
        profile_fields["non_edible"] = bool_value(body.get("nonEdible"), "Not food")
    extra_fields = {**yield_fields, **profile_fields}
    rename = {
        **({"name": values["name"]} if "name" in values else {}),
        **extra_fields,
    }
    expected = (
        int_value(
            body["expectedEditVersion"],
            "Edit version",
            minimum=0,
            maximum=2147483647,
        )
        if "expectedEditVersion" in body
        else None
    )
    created_row = False
    try:
        with transaction.atomic():
            if item_id:
                row = (
                    Ingredient.objects.select_for_update()
                    .filter(user=user, id=uuid_value(item_id))
                    .first()
                )
                if row is None:
                    raise ValueError("Ingredient not found")
                check_and_bump(row, expected)
                if pack:
                    apply_price(
                        row,
                        values,
                        source=IngredientPrice.Source.USER,
                        extra_fields=rename,
                    )
                elif rename:
                    for field, value in rename.items():
                        setattr(row, field, value)
                    row.save(update_fields=[*rename, "updated_at"])
            else:
                row = (
                    Ingredient.objects.select_for_update()
                    .filter(user=user, normalized_name=normalized_name(values["name"]))
                    .first()
                )
                if row is None:
                    created_row = True
                    if values["purchase_cost_cents"]:
                        row, _ = create_priced_ingredient(
                            user,
                            values,
                            source=IngredientPrice.Source.USER,
                            extra_fields=extra_fields,
                        )
                    else:
                        # Nothing to record: an unpriced ingredient starts with
                        # an empty history rather than a $0.00 row.
                        row = Ingredient.objects.create(
                            user=user,
                            price_source=IngredientPrice.Source.USER,
                            **values,
                            **extra_fields,
                        )
                else:
                    check_and_bump(row, expected)
                    apply_price(
                        row,
                        values,
                        source=IngredientPrice.Source.USER,
                        extra_fields=rename,
                    )
            # The tags are part of the same user action, so they land in the
            # same transaction or not at all.
            if "tags" in body:
                _set_ingredient_tags(user, row, body["tags"])
    except IntegrityError:
        raise ValueError("You already have an ingredient with that name")
    record_event(
        user,
        user,
        "ingredient",
        "added" if created_row else "edited",
        resource_id=row.id,
        name=row.name,
        publicId=row.public_id,
    )
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "editVersion": row.edit_version,
    }


def action_activate_catalog_ingredient(user: User, body: JsonObject) -> JsonObject:
    catalog = (
        CatalogIngredient.objects.filter(
            id=uuid_value(body.get("catalogIngredientId"), "catalog ingredient id"),
            is_active=True,
        )
        .prefetch_related("measures", "preparation_yields__measures")
        .first()
    )
    if catalog is None:
        raise ValueError("Catalog ingredient not found")
    row, created, measure_count, preparation_count = materialize_catalog_ingredient(
        user, catalog
    )
    return {
        "id": str(row.id),
        "name": row.name,
        "created": created,
        "seededMeasures": measure_count,
        "seededPreparations": preparation_count,
        # The picker lists a pantry row's preparations under it; the new row
        # has to show its own before any reload.
        "preparations": list(
            row.preparations.order_by("name").values_list("name", flat=True)
        ),
    }


def _decimal_or_none(value: Any, label: str, maximum: float) -> Decimal | None:
    """A blank conversion stays blank rather than becoming a zero."""
    if value is None or value == "":
        return None
    number = number_value(value, label, minimum=0, maximum=maximum)
    if number is None:
        return None
    return Decimal(str(number))


def _conversion_measure(body: JsonObject, family: str) -> tuple[Any, Any]:
    nested = body.get(family)
    if isinstance(nested, dict):
        return nested.get("amount"), nested.get("unit")
    return None, None


def _preparation_yield(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Yield must be a number")
    number = float(value)
    if not math.isfinite(number) or number <= 0 or number > 1000:
        raise ValueError("Yield must be greater than zero and at most 1000.")
    return Decimal(str(number))


def _preparation_measure(
    body: JsonObject, family: str, label: str
) -> tuple[Decimal | None, str]:
    amount_value, unit_value = _conversion_measure(body, family)
    unit = optional_text(unit_value, f"{label} unit", max_length=64)
    amount_blank = amount_value is None or amount_value == ""
    if amount_blank and not unit:
        return None, ""
    error = (
        f"{label} amount and unit must be supplied together and the amount "
        "must be greater than zero."
    )
    if amount_blank or not unit:
        raise ValueError(error)
    try:
        number = number_value(amount_value, label, minimum=0, maximum=1000000)
    except ValueError as exc:
        raise ValueError(error) from exc
    if number is None or number <= 0:
        raise ValueError(error)
    return Decimal(str(number)), unit


def action_save_preparation(user: User, body: JsonObject) -> JsonObject:
    ingredient = Ingredient.objects.filter(
        user=user, id=uuid_value(body.get("ingredientId"), "ingredient id")
    ).first()
    if ingredient is None:
        raise ValueError("Ingredient not found")
    name = text_value(body.get("name"), "Preparation name", max_length=120).strip()
    if not name:
        raise ValueError("Preparation name is required")
    preparation_id = body.get("id")
    yield_percent = _preparation_yield(body.get("yieldPercent"))
    uses_standard = bool_value(
        body.get("usesStandardConversion"), "Standard conversion"
    )
    measures = {
        family: _preparation_measure(body, family, label)
        for family, label in (
            ("weight", "Weight"),
            ("volume", "Volume"),
            ("each", "Each"),
        )
    }
    if uses_standard and any(amount is not None for amount, _unit in measures.values()):
        raise ValueError(
            "Standard preparation conversion cannot include custom measurements."
        )
    source = Preparation.Source.USER
    confidence = IngredientMeasureConfidence.HIGH
    if yield_percent is None and not preparation_id:
        yield_percent, source, confidence = seeded_preparation_yield(ingredient, name)
    fields = {
        "user": user,
        "name": name,
        "yield_percent": yield_percent,
        "source": source,
        "confidence": confidence,
        "average_weight": uses_standard,
        "weight_amount": measures["weight"][0],
        "weight_unit": measures["weight"][1],
        "volume_amount": measures["volume"][0],
        "volume_unit": measures["volume"][1],
        "each_amount": measures["each"][0],
        "each_unit": measures["each"][1],
    }
    try:
        with transaction.atomic():
            if preparation_id:
                row = Preparation.objects.filter(
                    user=user,
                    ingredient=ingredient,
                    id=uuid_value(preparation_id, "preparation id"),
                ).first()
                if row is None:
                    raise ValueError("Preparation not found")
                for field, value in fields.items():
                    setattr(row, field, value)
                row.save()
            else:
                row = Preparation.objects.create(ingredient=ingredient, **fields)
            _touch_ingredient(ingredient)
    except IntegrityError:
        raise ValueError("This ingredient already has a preparation with that name")
    return {"id": str(row.id)}


def _owned_ingredient(user: User, value: Any) -> Ingredient:
    row = Ingredient.objects.filter(
        user=user, id=uuid_value(value, "ingredient id")
    ).first()
    if row is None:
        raise ValueError("Ingredient not found")
    return row


def _touch_ingredient(ingredient: Ingredient) -> None:
    """Make a user edit to owned ingredient data visible in recency order."""
    ingredient.save(update_fields=["updated_at"])


def action_replace_ingredient_allergens(user: User, body: JsonObject) -> JsonObject:
    row = _owned_ingredient(user, body.get("ingredientId"))
    values = body.get("allergens", [])
    if not isinstance(values, list):
        raise ValueError("Invalid allergens")
    parsed = {}
    for value in values:
        if not isinstance(value, dict):
            raise ValueError("Invalid allergens")
        parsed[value.get("key")] = value.get("status")
    valid = {
        choice
        for choice, _ in IngredientAllergenOverride._meta.get_field("allergen").choices
    }
    statuses = {"contains", "mayContain", "doesNotContain"}
    if set(parsed) - valid or any(status not in statuses for status in parsed.values()):
        raise ValueError("Invalid allergen")
    # The list replaces the row's tags in one go: a half-written set would
    # read as an allergen the cook never cleared.
    with transaction.atomic():
        IngredientAllergenOverride.objects.filter(ingredient=row).delete()
        IngredientAllergenOverride.objects.bulk_create(
            [
                IngredientAllergenOverride(ingredient=row, allergen=key, status=status)
                for key, status in parsed.items()
            ]
        )
        _touch_ingredient(row)
    return {"ok": True}


def action_save_ingredient_conversion(user: User, body: JsonObject) -> JsonObject:
    ingredient = Ingredient.objects.filter(
        user=user, id=uuid_value(body.get("ingredientId"), "ingredient id")
    ).first()
    if ingredient is None:
        return {"error": "Ingredient not found"}
    with transaction.atomic():
        IngredientConversion.objects.update_or_create(
            ingredient=ingredient,
            defaults={
                "user": user,
                "source": IngredientConversion.Source.USER,
                "confidence": IngredientMeasureConfidence.HIGH,
                "average_weight": bool_value(
                    body.get("usesStandardConversion"), "Standard conversion"
                ),
                "weight_amount": _decimal_or_none(
                    _conversion_measure(body, "weight")[0], "Weight", maximum=1000000
                ),
                "weight_unit": optional_text(
                    _conversion_measure(body, "weight")[1],
                    "Weight unit",
                    max_length=64,
                ),
                "volume_amount": _decimal_or_none(
                    _conversion_measure(body, "volume")[0],
                    "Volume",
                    maximum=1000000,
                ),
                "volume_unit": optional_text(
                    _conversion_measure(body, "volume")[1],
                    "Volume unit",
                    max_length=64,
                ),
                "each_amount": _decimal_or_none(
                    _conversion_measure(body, "each")[0], "Each", maximum=1000000
                ),
                "each_unit": optional_text(
                    _conversion_measure(body, "each")[1], "Each unit", max_length=64
                ),
            },
        )
        _touch_ingredient(ingredient)
    return {"ok": True}


def action_reset_ingredient_conversion(user: User, body: JsonObject) -> JsonObject:
    ingredient = _owned_ingredient(user, body.get("ingredientId"))
    confidence = IngredientMeasureConfidence.LOW
    if ingredient.catalog_ingredient_id:
        measures = list(
            ingredient.catalog_ingredient.measures.filter(
                is_active=True, is_default=True
            )
        )
        fields: JsonObject = catalog_conversion_fields(measures)
        if measures:
            confidence = measures[0].confidence
    else:
        # Nothing linked to reset to: the reference density when the chart
        # knows the name, else the generic cup. Explicit pairs, so the panel
        # shows the number the costing engine uses — an estimate either way.
        grams = grams_for(
            MILLILITERS_PER_CUP,
            ingredient.normalized_name,
            allow_standard=False,
        )
        if grams is not None:
            confidence = IngredientMeasureConfidence.MEDIUM
        else:
            grams = default_standard_grams_per_cup()
        fields = {
            "average_weight": False,
            "weight_amount": Decimal(str(round(grams, 3))),
            "weight_unit": "g",
            "volume_amount": Decimal("1"),
            "volume_unit": "cup",
            "each_amount": None,
            "each_unit": "",
        }
    with transaction.atomic():
        IngredientConversion.objects.update_or_create(
            ingredient=ingredient,
            defaults={
                "user": user,
                "source": IngredientConversion.Source.CATALOG,
                "confidence": confidence,
                **fields,
            },
        )
        _touch_ingredient(ingredient)
    return {"ok": True}


def action_delete_preparations(user: User, body: JsonObject) -> JsonObject:
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > 200:
        raise ValueError("Preparation ids look malformed")
    with transaction.atomic():
        rows = Preparation.objects.filter(
            user=user,
            id__in=[uuid_value(one, "preparation id") for one in ids],
        )
        # A line names a preparation rather than pointing at it, so nothing
        # stops the delete on its own: recipes asking for that state would
        # quietly reprice against the plain ingredient. The batch is refused
        # whole, the way one used ingredient refuses its own delete.
        used_in_recipes: list[JsonObject] = []
        seen: set[str] = set()
        for row in rows:
            for recipe in preparation_recipe_usage_json(row):
                if recipe["id"] not in seen:
                    seen.add(str(recipe["id"]))
                    used_in_recipes.append(recipe)
        if used_in_recipes:
            return {
                "error": "This preparation is used in recipes.",
                "usedInRecipes": used_in_recipes,
            }
        ingredient_ids = list(rows.values_list("ingredient_id", flat=True).distinct())
        rows.delete()
        Ingredient.objects.filter(user=user, id__in=ingredient_ids).update(
            updated_at=timezone.now()
        )
    return {"ok": True}


def action_search_nutrition_foods(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "usdaSearch")
    query = text_value(body.get("query"), "Search", max_length=120).strip()
    if len(query) < 2:
        raise ValueError("Enter at least 2 characters")
    check_master_price_rate_limit(
        user,
        "nutri-s",
        20,
        message="Too many nutrition searches. Wait a minute and try again.",
    )
    scope = body.get("scope", "common")
    if scope not in {"common", "branded"}:
        raise ValueError("Invalid search scope")
    try:
        return {
            "items": [match.as_json() for match in search_foods(query, scope=scope)]
        }
    except FoodDataError as exc:
        raise ValueError(str(exc)) from exc


def action_set_ingredient_nutrition(user: User, body: JsonObject) -> JsonObject:
    ingredient = _owned_ingredient(user, body.get("ingredientId"))
    check_master_price_rate_limit(
        user,
        "nutri-f",
        20,
        message="Too many nutrition lookups. Wait a minute and try again.",
    )
    fdc_id = int_value(body.get("fdcId"), "food id", minimum=1, maximum=2_147_483_647)
    try:
        description, profile, package_ingredients = get_food(fdc_id)
    except FoodDataError as exc:
        raise ValueError(str(exc)) from exc
    ingredient.nutrition_source = "usda_fdc"
    ingredient.nutrition_source_id = str(fdc_id)
    ingredient.nutrition_description = description[:240]
    ingredient.nutrition_package_ingredients = package_ingredients
    ingredient.nutrition_per_100g = profile
    ingredient.nutrition_updated_at = timezone.now()
    ingredient.save(
        update_fields=[
            "nutrition_source",
            "nutrition_source_id",
            "nutrition_description",
            "nutrition_package_ingredients",
            "nutrition_per_100g",
            "nutrition_updated_at",
            "updated_at",
        ]
    )
    return {"ok": True}


def action_update_ingredient_nutrition_settings(
    user: User, body: JsonObject
) -> JsonObject:
    """Not food, added sugars and the label name. A key the payload leaves
    out is left alone, so each control on the screen saves only itself."""
    ingredient = _owned_ingredient(user, body.get("ingredientId"))
    fields: list[str] = []
    if "nonEdible" in body:
        ingredient.non_edible = bool_value(body.get("nonEdible"), "Not food")
        fields.append("non_edible")
    if "sugarsAreAdded" in body:
        ingredient.sugars_are_added = bool_value(
            body.get("sugarsAreAdded"), "Added sugars"
        )
        fields.append("sugars_are_added")
    if "labelName" in body:
        ingredient.nutrition_label_name = text_value(
            body.get("labelName"), "Name on label", max_length=120, allow_blank=True
        )
        fields.append("nutrition_label_name")
    if fields:
        ingredient.save(update_fields=[*fields, "updated_at"])
    return {"ok": True}


_REQUIRED_LABEL_VALUES = (
    "calories",
    "fat",
    "saturatedFat",
    "sodiumMg",
    "totalCarbohydrate",
    "sugars",
    "protein",
)


def action_request_custom_nutrition(user: User, body: JsonObject) -> JsonObject:
    """Package values for an ingredient no USDA record matches.

    The row is the record: support applies it from the staff console. The
    email only says one is waiting, so a mail failure is logged, not raised.
    """
    ingredient = _owned_ingredient(user, body.get("ingredientId"))
    if NutritionRequest.objects.filter(
        ingredient=ingredient, status=NutritionRequest.Status.PENDING
    ).exists():
        raise ValueError("A request for this ingredient is already waiting")
    check_master_price_rate_limit(
        user,
        "nutri-r",
        5,
        message="Too many nutrition requests. Wait a minute and try again.",
    )
    serving_grams = number_value(
        body.get("servingGrams"), "Serving grams", minimum=0.000001, maximum=100000
    )
    raw_values = body.get("values")
    if not isinstance(raw_values, dict):
        raise ValueError("Nutrition values are required")
    values: dict[str, float | None] = {}
    for key in LABEL_VALUE_KEYS:
        values[key] = number_value(
            raw_values.get(key),
            key,
            minimum=0,
            maximum=100000,
            nullable=key not in _REQUIRED_LABEL_VALUES,
        )
    source = text_value(
        body.get("source", ""), "Source", max_length=240, allow_blank=True
    )
    note = text_value(body.get("note", ""), "Note", max_length=2000, allow_blank=True)
    try:
        per_100g = label_nutrition_per_100g(values, serving_grams)  # type: ignore[arg-type]
    except FoodDataError as exc:
        raise ValueError(str(exc)) from exc
    request = NutritionRequest.objects.create(
        user=user,
        ingredient=ingredient,
        serving_grams=Decimal(str(serving_grams)),
        values=values,
        per_100g=per_100g,
        source=source,
        note=note,
    )
    if settings.FORKLUCK_SUPPORT_EMAIL:
        try:
            send_nutrition_request_notification(
                settings.FORKLUCK_SUPPORT_EMAIL,
                user_name=user.name,
                user_email=user.email,
                ingredient_name=ingredient.name,
                ingredient_id=ingredient.public_id,
                serving_grams=str(serving_grams),
                values=values,
                note=note,
            )
        except (EmailNotConfigured, ValueError):
            logger.exception(
                "Could not announce nutrition request %s for %s",
                request.id,
                ingredient.public_id,
            )
    return {"id": str(request.id), "status": request.status}


def action_clear_ingredient_nutrition(user: User, body: JsonObject) -> JsonObject:
    ingredient = Ingredient.objects.filter(
        user=user, id=uuid_value(body.get("ingredientId"), "ingredient id")
    ).first()
    if ingredient is None:
        return {"error": "Ingredient not found"}
    ingredient.nutrition_source = ""
    ingredient.nutrition_source_id = ""
    ingredient.nutrition_description = ""
    ingredient.nutrition_package_ingredients = ""
    ingredient.nutrition_per_100g = None
    ingredient.nutrition_updated_at = None
    ingredient.save(
        update_fields=[
            "nutrition_source",
            "nutrition_source_id",
            "nutrition_description",
            "nutrition_package_ingredients",
            "nutrition_per_100g",
            "nutrition_updated_at",
            "updated_at",
        ]
    )
    return {"ok": True}


def check_master_price_rate_limit(
    user: User, bucket: str, limit: int, *, message: str | None = None
) -> None:
    now = timezone.now()
    with transaction.atomic():
        User.objects.select_for_update().only("id").get(id=user.id)
        recent = MasterPriceAccess.objects.filter(
            user=user,
            bucket=bucket,
            created_at__gte=now - timedelta(minutes=1),
        ).count()
        if recent >= limit:
            raise ValueError(
                message
                or "Too many starter-price requests. Wait a minute and try again."
            )
        MasterPriceAccess.objects.create(user=user, bucket=bucket)
        MasterPriceAccess.objects.filter(
            user=user, created_at__lt=now - timedelta(days=1)
        ).delete()


def require_usd_master_prices(user: User) -> None:
    settings_row, _ = BenchCostSettings.objects.get_or_create(user=user)
    if settings_row.currency_code != "USD":
        raise ValueError("Starter estimates are currently available in USD only")


def available_master_price_ids(user: User) -> set[str]:
    return {
        str(value)
        for value in MasterPriceDismissal.objects.filter(user=user).values_list(
            "master_price_id", flat=True
        )
    }


def action_search_master_prices(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "catalogSearch")
    check_master_price_rate_limit(user, "search", 20)
    require_usd_master_prices(user)
    query = normalized_ingredient_name(
        text_value(body.get("query"), "Search", max_length=120)
    )
    if len(query) < 3:
        raise ValueError("Enter at least 3 characters")
    dismissed_ids = available_master_price_ids(user)
    owned_names = set(
        Ingredient.objects.filter(user=user).values_list("normalized_name", flat=True)
    )
    matches = [
        price
        for price in MASTER_PRICES_BY_ID.values()
        if price.id not in dismissed_ids
        and price.normalized_name not in owned_names
        and query in price.normalized_name
    ][:5]
    return {"items": [master_price_json(price) for price in matches]}


def action_match_master_prices(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "catalogSearch")
    check_master_price_rate_limit(user, "match", 30)
    require_usd_master_prices(user)
    names = body.get("names")
    if not isinstance(names, list) or len(names) > 12:
        raise ValueError("A recipe can request at most 12 starter estimates")
    normalized_names = []
    for value in names:
        name = normalized_ingredient_name(
            text_value(value, "Ingredient name", max_length=200)
        )
        if name and name not in normalized_names:
            normalized_names.append(name)
    dismissed_ids = available_master_price_ids(user)
    owned_names = set(
        Ingredient.objects.filter(user=user).values_list("normalized_name", flat=True)
    )
    matches = [
        price
        for name in normalized_names
        if name not in owned_names
        and (price := MASTER_PRICES_BY_NAME.get(name)) is not None
        and price.id not in dismissed_ids
    ]
    return {"items": [master_price_json(price) for price in matches]}


def master_price_from_body(body: JsonObject):
    master_price_id = str(uuid_value(body.get("masterPriceId"), "master price id"))
    price = MASTER_PRICES_BY_ID.get(master_price_id)
    if price is None:
        raise ValueError("Starter estimate not found")
    return price


def action_adopt_master_price(user: User, body: JsonObject) -> JsonObject:
    require_usd_master_prices(user)
    price = master_price_from_body(body)
    with transaction.atomic():
        row = Ingredient.objects.filter(
            user=user, normalized_name=price.normalized_name
        ).first()
        created = row is None
        if row is None:
            row, _ = create_priced_ingredient(
                user,
                {
                    "purchase_cost_cents": price.pack_price_cents,
                    "purchase_size": Decimal(str(price.pack_amount)),
                    "purchase_unit": price.pack_unit,
                },
                source=IngredientPrice.Source.MASTER,
                extra_fields={"name": price.name},
            )
        MasterPriceDismissal.objects.filter(
            user=user, master_price_id=price.id
        ).delete()
    return {"id": str(row.id), "created": created}


def action_dismiss_master_price(user: User, body: JsonObject) -> JsonObject:
    price = master_price_from_body(body)
    MasterPriceDismissal.objects.get_or_create(user=user, master_price_id=price.id)
    return {"ok": True}


def check_catalog_rate_limit(user: User, bucket: str, limit: int) -> None:
    now = timezone.now()
    with transaction.atomic():
        User.objects.select_for_update().only("id").get(id=user.id)
        recent = CatalogAccess.objects.filter(
            user=user,
            bucket=bucket,
            created_at__gte=now - timedelta(minutes=1),
        ).count()
        if recent >= limit:
            raise ValueError("Too many Catalog requests. Wait a minute and try again.")
        CatalogAccess.objects.create(user=user, bucket=bucket)
        CatalogAccess.objects.filter(
            user=user, created_at__lt=now - timedelta(days=1)
        ).delete()


def require_catalog_currency(user: User) -> str:
    settings_row, _ = BenchCostSettings.objects.get_or_create(user=user)
    return settings_row.currency_code


def catalog_products_for_user(user: User):
    currency = require_catalog_currency(user)
    owned_names = Ingredient.objects.filter(user=user).values_list(
        "normalized_name", flat=True
    )
    return (
        CatalogProduct.objects.select_related("ingredient")
        .filter(
            ingredient__is_active=True,
            source__is_active=True,
            is_active=True,
            is_available=True,
            is_recipe_ready=True,
            currency=currency,
        )
        .exclude(ingredient__normalized_name__in=owned_names)
        # A Catalog-backed pantry row can be renamed while retaining the
        # canonical product identity used by shared measures.  Name-only
        # exclusion would offer that same product again and a second adoption
        # would create a duplicate pantry row under the old canonical name.
        .exclude(adopted_ingredients__user=user)
    )


def _search_query(body: JsonObject, minimum: int) -> str:
    query = normalized_ingredient_name(
        text_value(body.get("query"), "Search", max_length=120)
    )
    if len(query) < minimum:
        raise ValueError(f"Enter at least {minimum} characters")
    return query


def _matching_every_word(queryset, query: str, prefix: str = ""):
    """Every word has to appear, in any order. Matching the query as one phrase
    missed "Maldon Sea Salt" for "maldon salt", which is also what the picker
    falls back to, so both sides have to agree on the same rule."""
    for token in query.split():
        queryset = queryset.filter(
            Q(**{f"{prefix}normalized_name__contains": token})
            | Q(
                **{
                    f"{prefix}aliases__normalized_text__contains": token,
                    f"{prefix}aliases__is_active": True,
                }
            )
        )
    return queryset.distinct()


def action_search_catalog_prices(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "catalogSearch")
    check_catalog_rate_limit(user, CatalogAccess.Bucket.SEARCH, 20)
    query = _search_query(body, 3)
    products = _matching_every_word(
        catalog_products_for_user(user), query, "ingredient__"
    )
    return {"items": [catalog_price_json(product) for product in products[:8]]}


def action_search_catalog_ingredients(user: User, body: JsonObject) -> JsonObject:
    """Identities the recipe picker can pull into the pantry: the open catalog
    (keyed rows), not the identities supplier price lists create. Open data,
    so no rate limit: a dropdown asks once per pause in typing."""
    require_entitlement(user, "catalogSearch")
    query = _search_query(body, 2)
    owned_names = Ingredient.objects.filter(user=user).values_list(
        "normalized_name", flat=True
    )
    identities = (
        CatalogIngredient.objects.filter(is_active=True, key__isnull=False)
        .exclude(normalized_name__in=owned_names)
        .exclude(tenant_ingredients__user=user)
        .prefetch_related(
            Prefetch(
                "preparation_yields",
                queryset=CatalogPreparationYield.objects.filter(is_active=True),
            ),
            # Every row carries its synonyms, exact hits included, so the
            # picker can say why a card appeared and a pasted synonym links
            # itself. One extra query for the page, not one per row.
            Prefetch(
                "aliases",
                queryset=CatalogIngredientAlias.objects.filter(is_active=True),
            ),
        )
    )
    # "onion" should lead with Onion, then Onion powder, and only then the
    # things that merely mention onions.
    rows = sorted(
        _matching_every_word(identities, query)[:40],
        key=lambda row: (
            not row.normalized_name.startswith(query),
            len(row.normalized_name),
            row.normalized_name,
        ),
    )
    if len(rows) < 8:
        # "jarlic" is garlic: the typo pass runs over the catalog's names and
        # aliases, after the exact matches.
        seen = {row.id for row in rows}
        rows += sorted(
            (
                row
                for row in identities
                if row.id not in seen
                and any(
                    fuzzy_matches(text, query)
                    for text in [row.normalized_name]
                    + [alias.normalized_text for alias in row.aliases.all()]
                )
            ),
            key=lambda row: (len(row.normalized_name), row.normalized_name),
        )
    return {
        "items": [
            {
                "id": str(row.id),
                "name": row.name,
                "preparations": [prep.name for prep in row.preparation_yields.all()],
                "aliases": sorted({alias.text for alias in row.aliases.all()}),
            }
            for row in rows[:20]
        ]
    }


def action_match_catalog_prices(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "catalogSearch")
    check_catalog_rate_limit(user, CatalogAccess.Bucket.MATCH, 30)
    names = body.get("names")
    if not isinstance(names, list) or len(names) > 12:
        raise ValueError("A recipe can request at most 12 Catalog estimates")
    normalized_names = []
    for value in names:
        name = normalized_ingredient_name(
            text_value(value, "Ingredient name", max_length=200)
        )
        if name and name not in normalized_names:
            normalized_names.append(name)
    products = (
        catalog_products_for_user(user)
        .filter(
            Q(ingredient__normalized_name__in=normalized_names)
            | Q(
                ingredient__aliases__normalized_text__in=normalized_names,
                ingredient__aliases__is_active=True,
            )
        )
        .distinct()
    )
    by_name = {
        product.ingredient.normalized_name: product
        for product in products
        if product.ingredient is not None
    }
    return {
        "items": [
            catalog_price_json(by_name[name])
            for name in normalized_names
            if name in by_name
        ]
    }


def catalog_product_from_body(body: JsonObject) -> CatalogProduct:
    product = (
        CatalogProduct.objects.select_related("ingredient")
        .filter(
            id=uuid_value(body.get("catalogPriceId"), "catalog price id"),
            ingredient__is_active=True,
            source__is_active=True,
            is_active=True,
            is_available=True,
            is_recipe_ready=True,
        )
        .first()
    )
    if product is None or product.pack_grams is None or product.ingredient is None:
        raise ValueError("Catalog estimate not found")
    return product


def action_adopt_catalog_price(user: User, body: JsonObject) -> JsonObject:
    product = catalog_product_from_body(body)
    if product.currency != require_catalog_currency(user):
        raise ValueError("Catalog estimate is unavailable in this currency")
    catalog_ingredient = product.ingredient
    assert catalog_ingredient is not None
    with transaction.atomic():
        # Product identity survives a user rename and is therefore the
        # authoritative idempotency key.  The normalized-name fallback keeps
        # adoption compatible with pantry rows created before Catalog linkage.
        row = Ingredient.objects.filter(user=user, catalog_product=product).first()
        if row is None:
            row = Ingredient.objects.filter(
                user=user, normalized_name=catalog_ingredient.normalized_name
            ).first()
        created = row is None
        if row is None:
            row, _ = create_priced_ingredient(
                user,
                {
                    "purchase_cost_cents": product.pack_price_cents,
                    "purchase_size": product.pack_amount,
                    "purchase_unit": product.pack_unit,
                },
                source=IngredientPrice.Source.CATALOG,
                # The product's materialized price is its latest observation.
                catalog_observation=product.price_history.first(),
                extra_fields={
                    "name": catalog_ingredient.name,
                    "catalog_product": product,
                    "catalog_ingredient": catalog_ingredient,
                },
            )
        else:
            row.catalog_ingredient = catalog_ingredient
            row.catalog_product = product
            row.save(
                update_fields=["catalog_ingredient", "catalog_product", "updated_at"]
            )
    return {"id": str(row.id), "created": created}


def action_archive_ingredient(user: User, body: JsonObject) -> JsonObject:
    row = Ingredient.objects.filter(user=user, id=uuid_value(body.get("id"))).first()
    if row is None:
        raise ValueError("Ingredient not found")
    archived = bool_value(body.get("archived"), "Archived")
    status = Ingredient.STATUS_ARCHIVED if archived else Ingredient.STATUS_ACTIVE
    if row.status != status:
        row.status = status
        row.save(update_fields=["status", "updated_at"])
        record_event(
            user,
            user,
            "ingredient",
            "archived" if archived else "restored",
            resource_id=row.id,
            name=row.name,
            publicId=row.public_id,
        )
    return {"item": ingredient_json(row)}


def action_rename_ingredient_category(user: User, body: JsonObject) -> JsonObject:
    name = text_value(body.get("name"), "Name", max_length=64).strip()
    if not name:
        raise ValueError("Name is required")
    current = text_value(body.get("currentName"), "Category", max_length=64).strip()
    row = IngredientCategory.objects.filter(
        user=user, normalized_name=normalized_category_name(current)
    ).first()
    if row is None:
        raise ValueError("Category not found")
    normalized = normalized_category_name(name)
    existing = (
        IngredientCategory.objects.filter(user=user, normalized_name=normalized)
        .exclude(id=row.id)
        .first()
    )
    if existing is not None:
        # Merge into the existing category instead of violating uniqueness.
        Ingredient.objects.filter(user=user, category=row).update(category=existing)
        row.delete()
        record_event(
            user, user, "category", "edited", name=existing.name, kind="ingredient"
        )
        return {"ok": True}
    row.name = name
    row.normalized_name = normalized
    row.save(update_fields=["name", "normalized_name", "updated_at"])
    record_event(
        user,
        user,
        "category",
        "edited",
        resource_id=row.id,
        name=name,
        kind="ingredient",
    )
    return {"ok": True}


def action_delete_ingredient_category(user: User, body: JsonObject) -> JsonObject:
    name = text_value(body.get("name"), "Name", max_length=64).strip()
    deleted, _ = IngredientCategory.objects.filter(
        user=user, normalized_name=normalized_category_name(name)
    ).delete()
    if deleted:
        record_event(user, user, "category", "deleted", name=name, kind="ingredient")
    return {"ok": True}


def action_delete_ingredient(user: User, body: JsonObject) -> JsonObject:
    with transaction.atomic():
        row = (
            Ingredient.objects.select_for_update()
            .filter(user=user, id=uuid_value(body.get("id")))
            .first()
        )
        if row is None:
            return {"error": "Ingredient not found"}
        used_in_recipes = ingredient_recipe_usage_json(row)
        if used_in_recipes:
            return {
                "error": "This ingredient is used in recipes.",
                "usedInRecipes": used_in_recipes,
            }
        if SalesProductComponent.objects.filter(ingredient=row).exists():
            return {"error": "This ingredient is used in product compositions."}
        master_price = (
            MASTER_PRICES_BY_NAME.get(row.normalized_name)
            if row.price_source == Ingredient.PriceSource.MASTER
            else None
        )
        try:
            row.delete()
        except RestrictedError:
            return {
                "error": "This ingredient is used in recipes.",
                "usedInRecipes": ingredient_recipe_usage_json(row),
            }
        except ProtectedError as exc:
            if SalesProductComponent.objects.filter(ingredient=row).exists():
                return {"error": "This ingredient is used in product compositions."}
            raise exc
        if master_price is not None:
            MasterPriceDismissal.objects.get_or_create(
                user=user, master_price_id=master_price.id
            )
    record_event(
        user,
        user,
        "ingredient",
        "deleted",
        resource_id=row.id,
        name=row.name,
        publicId=row.public_id,
    )
    return {"ok": True}


def action_import_ingredients(user: User, body: JsonObject) -> JsonObject:
    entries = body.get("entries")
    ignored_entries = body.get("ignored", [])
    if (
        not isinstance(entries, list)
        or len(entries) > 500
        or not isinstance(ignored_entries, list)
        or len(ignored_entries) > 500
        or len(entries) + len(ignored_entries) < 1
    ):
        return {"error": "Import data looks malformed."}

    file_name = text_value(
        body.get("fileName", "Purchase import"),
        "File name",
        max_length=255,
    ).strip()
    source = body.get("source")
    source_supplier = None
    period_start = None
    period_end = None
    if source is not None:
        if not isinstance(source, dict):
            raise ValueError("Import source looks malformed")
        source_supplier = (
            text_value(source.get("supplier"), "Supplier", max_length=64)
            .strip()
            .lower()
        )
        period_start = import_date_value(source.get("periodStart"), "Period start")
        period_end = import_date_value(source.get("periodEnd"), "Period end")
    total_rows = int_value(
        body.get("totalRows", len(entries) + len(ignored_entries)),
        "Total rows",
        minimum=0,
        maximum=1000000,
    )
    review_count = int_value(
        body.get("reviewCount", 0),
        "Review count",
        minimum=0,
        maximum=1000000,
    )

    imported = 0
    created = 0
    updated = 0
    with transaction.atomic():
        # Same workspace lock the undo takes, so an import cannot land rows
        # in the middle of an undo's validate-then-restore.
        lock_workspace(user)
        ingredient_import = IngredientImport.objects.create(
            user=user,
            file_name=file_name,
            supplier=source_supplier,
            period_start=period_start,
            period_end=period_end,
            total_rows=total_rows,
            review_count=review_count,
            ignored_count=len(ignored_entries),
        )

        ignored_snapshots = upsert_supplier_ignores(user, ignored_entries)

        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise ValueError("Import data looks malformed")
            supplier_value = entry.get("supplier")
            external_id_value = entry.get("externalId")
            if (supplier_value is None) != (external_id_value is None):
                raise ValueError(
                    "Supplier and supplier item ID must be provided together"
                )

            if supplier_value is not None:
                item_created, _, _ = apply_supplier_import_entry(
                    user, ingredient_import, position, entry
                )
                if item_created:
                    created += 1
                else:
                    updated += 1
                imported += 1
                continue

            values = ingredient_values(entry)
            row = Ingredient.objects.filter(
                user=user, normalized_name=normalized_name(values["name"])
            ).first()
            ingredient_before = ingredient_snapshot(row) if row else None
            ingredient_created = row is None
            price_history_id = None
            if row is None:
                row, price = create_priced_ingredient(
                    user, values, source=IngredientPrice.Source.USER
                )
                price_history_id = price.id
                created += 1
            else:
                price = apply_price(
                    row,
                    values,
                    source=IngredientPrice.Source.USER,
                    extra_fields={"name": values["name"]},
                )
                if price is not None:
                    price_history_id = price.id
                updated += 1
            IngredientImportItem.objects.create(
                ingredient_import=ingredient_import,
                # Even, like apply_supplier_import_entry's rows: one import can
                # mix both paths, and promotions take the odd slots.
                position=position * 2,
                operation=(
                    IngredientImportItem.Operation.CREATED
                    if ingredient_created
                    else IngredientImportItem.Operation.UPDATED
                ),
                ingredient_before=ingredient_before,
                ingredient_after=ingredient_snapshot(row),
                ingredient_created=ingredient_created,
                price_history_id=price_history_id,
            )
            imported += 1

        ingredient_import.imported_count = imported
        ingredient_import.created_count = created
        ingredient_import.updated_count = updated
        ingredient_import.ignored_items = ignored_snapshots
        ingredient_import.save(
            update_fields=[
                "imported_count",
                "created_count",
                "updated_count",
                "ignored_items",
                "updated_at",
            ]
        )
    record_event(
        user,
        user,
        "import",
        "imported",
        resource_id=ingredient_import.id,
        name=file_name,
        kind="ingredients",
        imported=imported,
        created=created,
        updated=updated,
        ignored=len(ignored_entries),
    )
    return {
        "batchId": str(ingredient_import.id),
        "imported": imported,
        "created": created,
        "updated": updated,
        "ignored": len(ignored_entries),
        "review": review_count,
    }


def action_supplier_import_status(user: User, body: JsonObject) -> JsonObject:
    supplier = (
        text_value(body.get("supplier"), "Supplier", max_length=64).strip().lower()
    )
    external_ids = body.get("externalIds")
    if not isinstance(external_ids, list) or len(external_ids) > 500:
        raise ValueError("Supplier item IDs look malformed")
    normalized_ids = [
        text_value(value, "Supplier item ID", max_length=120).strip().lower()
        for value in external_ids
    ]
    existing_ids = SupplierItem.objects.filter(
        user=user, supplier=supplier, external_id__in=normalized_ids
    ).values_list("external_id", flat=True)
    ignored_ids = SupplierItemIgnore.objects.filter(
        user=user, supplier=supplier, external_id__in=normalized_ids
    ).values_list("external_id", flat=True)
    return {"existingIds": list(existing_ids), "ignoredIds": list(ignored_ids)}


def restore_ingredient(user: User, snapshot: JsonObject) -> Ingredient:
    row = Ingredient.objects.filter(
        user=user, id=uuid_value(snapshot.get("id"), "ingredient id")
    ).first()
    if row is None:
        raise ValueError("An imported ingredient was removed after this import")
    values = {
        "name": snapshot["name"],
        "normalized_name": snapshot["normalizedName"],
        "purchase_cost_cents": snapshot["purchaseCostCents"],
        "purchase_size": snapshot["purchaseSize"],
        "purchase_unit": snapshot["purchaseUnit"],
        "price_source": snapshot.get("priceSource", Ingredient.PriceSource.USER),
    }
    for field, value in values.items():
        setattr(row, field, value)
    row.save(update_fields=[*values, "updated_at"])
    restored_updated_at = datetime.fromisoformat(snapshot["updatedAt"])
    Ingredient.objects.filter(id=row.id).update(updated_at=restored_updated_at)
    row.updated_at = restored_updated_at
    return row


def restore_supplier_item(user: User, snapshot: JsonObject) -> SupplierItem:
    row = SupplierItem.objects.filter(
        user=user, id=uuid_value(snapshot.get("id"), "supplier item id")
    ).first()
    if row is None:
        raise ValueError("An imported supplier product was removed after this import")
    ingredient = Ingredient.objects.filter(
        user=user,
        id=uuid_value(snapshot.get("ingredientId"), "ingredient id"),
    ).first()
    if ingredient is None:
        raise ValueError("An imported ingredient was removed after this import")

    if row.is_preferred:
        row.is_preferred = False
        row.save(update_fields=["is_preferred", "updated_at"])
    values = {
        "ingredient": ingredient,
        "supplier": snapshot["supplier"],
        "external_id": snapshot["externalId"],
        "title": snapshot["title"],
        "raw_size": snapshot["rawSize"],
        "pack_price_cents": snapshot["packPriceCents"],
        "pack_grams": snapshot["packGrams"],
        "pack_amount": snapshot["packAmount"],
        "pack_unit": snapshot["packUnit"],
        "purchased_quantity": snapshot["purchasedQuantity"],
        "period_start": import_date_value(snapshot["periodStart"], "Period start"),
        "period_end": import_date_value(snapshot["periodEnd"], "Period end"),
        "is_preferred": bool(snapshot["isPreferred"]),
    }
    if values["is_preferred"]:
        SupplierItem.objects.filter(ingredient=ingredient, is_preferred=True).exclude(
            id=row.id
        ).update(is_preferred=False)
    for field, value in values.items():
        setattr(row, field, value)
    row.save(update_fields=[*values, "updated_at"])
    restored_updated_at = datetime.fromisoformat(snapshot["updatedAt"])
    SupplierItem.objects.filter(id=row.id).update(updated_at=restored_updated_at)
    row.updated_at = restored_updated_at
    return row


def restore_supplier_ignore(user: User, snapshot: JsonObject) -> SupplierItemIgnore:
    row, _ = SupplierItemIgnore.objects.update_or_create(
        user=user,
        supplier=snapshot["supplier"],
        external_id=snapshot["externalId"],
        defaults={"title": snapshot["title"], "raw_size": snapshot["rawSize"]},
    )
    restored_updated_at = datetime.fromisoformat(snapshot["updatedAt"])
    SupplierItemIgnore.objects.filter(id=row.id).update(updated_at=restored_updated_at)
    row.updated_at = restored_updated_at
    return row


def _ingredient_has_dependent_work(user: User, row: Ingredient) -> bool:
    """Whether user work outside the imported parent row makes it durable."""
    return (
        RecipeLineMatch.objects.filter(user=user, ingredient=row).exists()
        or row.recipe_items.filter(recipe__user=user).exists()
        or row.measures.exists()
        or row.preparations.exists()
        or row.invoice_prices.filter(ingredient_import__isnull=True).exists()
        or IngredientConversion.objects.filter(ingredient=row).exists()
        or row.nutrition_per_100g is not None
        or IngredientAllergenOverride.objects.filter(ingredient=row).exists()
    )


def action_undo_ingredient_import(user: User, body: JsonObject) -> JsonObject:
    import_id = uuid_value(body.get("id"), "import id")
    created_ingredient_ids: set[uuid.UUID] = set()
    deleted_supplier_items = 0
    restored_supplier_items = 0
    # Validation and mutation share one transaction. Splitting them let another
    # request modify an ingredient between the timestamp check and the restore,
    # so the undo overwrote or deleted a change the guard was meant to refuse.
    with transaction.atomic():
        # Serialize import and undo for this workspace against each other. The
        # per-row locks below cannot do it alone: rows created by a concurrent
        # import do not exist yet at the moment this undo reads them.
        lock_workspace(user)

        ingredient_import = (
            IngredientImport.objects.select_for_update()
            .filter(user=user, id=import_id, undone_at__isnull=True)
            .first()
        )
        if ingredient_import is None:
            raise ValueError("Import not found or already undone")
        latest = IngredientImport.objects.filter(
            user=user, undone_at__isnull=True
        ).first()
        if latest is None or latest.id != ingredient_import.id:
            raise ValueError("Undo newer imports first")

        items = list(ingredient_import.items.all())
        for item in items:
            supplier_after = item.supplier_after
            if supplier_after:
                current_supplier = (
                    SupplierItem.objects.select_for_update()
                    .filter(
                        user=user,
                        id=uuid_value(supplier_after.get("id"), "supplier item id"),
                    )
                    .first()
                )
                if (
                    current_supplier is None
                    or current_supplier.updated_at > ingredient_import.updated_at
                ):
                    raise ValueError(
                        "A supplier product changed after this import; undo it manually"
                    )
            current_ingredient = (
                Ingredient.objects.select_for_update()
                .filter(
                    user=user,
                    id=uuid_value(item.ingredient_after.get("id"), "ingredient id"),
                )
                .first()
            )
            if current_ingredient is None or (
                current_ingredient.updated_at > ingredient_import.updated_at
                and not (
                    item.ingredient_created
                    and _ingredient_has_dependent_work(user, current_ingredient)
                )
            ):
                raise ValueError(
                    "An ingredient changed after this import; undo it manually"
                )

        for ignored in ingredient_import.ignored_items:
            current_ignore = (
                SupplierItemIgnore.objects.select_for_update()
                .filter(
                    user=user,
                    supplier=ignored["supplier"],
                    external_id=ignored["externalId"],
                )
                .first()
            )
            if (
                current_ignore is None
                or current_ignore.updated_at > ingredient_import.updated_at
            ):
                raise ValueError(
                    "An ignored supplier product changed after this import; "
                    "undo it manually"
                )

        # Automatic invoice-price references belong to the import and unwind
        # with it. A relation the user added later has no import owner and is
        # deliberately preserved (and makes a newly imported ingredient
        # durable through `_ingredient_has_dependent_work`).
        IngredientInvoicePrice.objects.filter(
            user=user, ingredient_import=ingredient_import
        ).delete()

        for item in reversed(items):
            if item.price_history_id:
                IngredientPrice.objects.filter(
                    ingredient__user=user, id=item.price_history_id
                ).delete()

            if item.supplier_after:
                current_supplier = SupplierItem.objects.get(
                    user=user,
                    id=uuid_value(item.supplier_after["id"], "supplier item id"),
                )
                if item.operation == IngredientImportItem.Operation.CREATED:
                    current_supplier.delete()
                    deleted_supplier_items += 1
                elif item.supplier_before:
                    restore_supplier_item(user, item.supplier_before)
                    restored_supplier_items += 1
            if item.ignore_before:
                restore_supplier_ignore(user, item.ignore_before)

            if item.ingredient_created:
                created_ingredient_ids.add(
                    uuid_value(item.ingredient_after["id"], "ingredient id")
                )
            elif item.ingredient_before:
                restore_ingredient(user, item.ingredient_before)

        deleted_ingredients = 0
        retained_ingredients = 0
        for ingredient_id in created_ingredient_ids:
            row = Ingredient.objects.filter(user=user, id=ingredient_id).first()
            if row is None:
                continue
            # Work the user did after the import makes the row durable, and a
            # conversion or a preparation is that work as much as a measure is.
            if row.supplier_items.exists() or _ingredient_has_dependent_work(user, row):
                rematerialize_price(row)
                retained_ingredients += 1
                continue
            try:
                row.delete()
            except RestrictedError as exc:
                raise ValueError(
                    "An ingredient became used while the import was being undone. "
                    "Try again."
                ) from exc
            deleted_ingredients += 1

        for ignored in reversed(ingredient_import.ignored_items):
            before = ignored.get("before")
            if before:
                restore_supplier_ignore(user, before)
            else:
                SupplierItemIgnore.objects.filter(
                    user=user,
                    supplier=ignored["supplier"],
                    external_id=ignored["externalId"],
                ).delete()

        ingredient_import.undone_at = timezone.now()
        ingredient_import.save(update_fields=["undone_at", "updated_at"])

    return {
        "ok": True,
        "deletedSupplierItems": deleted_supplier_items,
        "restoredSupplierItems": restored_supplier_items,
        "deletedIngredients": deleted_ingredients,
        "retainedIngredients": retained_ingredients,
    }


def action_set_preferred_supplier_item(user: User, body: JsonObject) -> JsonObject:
    item = SupplierItem.objects.filter(
        user=user, id=uuid_value(body.get("id"), "supplier item id")
    ).first()
    if item is None:
        raise ValueError("Supplier product not found")
    # It re-prices the ingredient off the chosen pack, which is what
    # save-ingredient writes too, so it bumps against an open form elsewhere.
    with transaction.atomic():
        row = Ingredient.objects.select_for_update().get(pk=item.ingredient_id)
        SupplierItem.objects.filter(ingredient=row, is_preferred=True).exclude(
            id=item.id
        ).update(is_preferred=False)
        if not item.is_preferred:
            item.is_preferred = True
            item.save(update_fields=["is_preferred", "updated_at"])
        apply_price(
            row,
            {
                "purchase_cost_cents": item.pack_price_cents,
                "purchase_size": item.pack_amount,
                "purchase_unit": item.pack_unit,
            },
            source=IngredientPrice.Source.SUPPLIER,
            supplier_item=item,
        )
        version = check_and_bump(row, None)
    return {"ok": True, "editVersion": version}


def action_merge_ingredients(user: User, body: JsonObject) -> JsonObject:
    source_id = uuid_value(body.get("sourceId"), "source ingredient id")
    target_id = uuid_value(body.get("targetId"), "target ingredient id")
    if source_id == target_id:
        raise ValueError("Choose two different ingredients")

    with transaction.atomic():
        # Lock in UUID order so two merges naming the same rows cannot deadlock.
        locked = {
            row.id: row
            for row in Ingredient.objects.select_for_update()
            .filter(user=user, id__in=(source_id, target_id))
            .order_by("id")
        }
        source = locked.get(source_id)
        target = locked.get(target_id)
        if source is None or target is None:
            raise ValueError("Ingredient not found")

        target_has_preferred = target.supplier_items.filter(is_preferred=True).exists()
        source_preferred = source.supplier_items.filter(is_preferred=True).first()
        for supplier_item in source.supplier_items.all():
            if target_has_preferred and supplier_item.is_preferred:
                supplier_item.is_preferred = False
            supplier_item.ingredient = target
            supplier_item.save(
                update_fields=["ingredient", "is_preferred", "updated_at"]
            )
        IngredientPrice.objects.filter(ingredient=source).update(ingredient=target)
        RecipeLineMatch.objects.filter(user=user, ingredient=source).update(
            ingredient=target
        )
        # Normalized recipe rows are the authoritative identity relation; a
        # pantry merge must move them alongside the legacy alias rows.
        RecipeItem.objects.filter(recipe__user=user, ingredient=source).update(
            ingredient=target
        )
        # InvoiceLine.ingredient is SET_NULL, so the source row's deletion below
        # would silently erase the link an imported line already recorded even
        # though the ingredient survives under the target's id. Move it with
        # every other relation so a line's own ingredient and its supplier
        # item's ingredient keep naming the same row.
        InvoiceLine.objects.filter(user=user, ingredient=source).update(
            ingredient=target
        )
        # Invoice prices are many-to-many references. Preserve every source
        # purchase, but let the target's version win when both ingredients
        # already point at the same invoice line.
        target_invoice_lines = set(
            target.invoice_prices.values_list("invoice_line_id", flat=True)
        )
        IngredientInvoicePrice.objects.filter(
            user=user,
            ingredient=source,
            invoice_line_id__in=target_invoice_lines,
        ).delete()
        IngredientInvoicePrice.objects.filter(user=user, ingredient=source).update(
            ingredient=target
        )
        target_changes: JsonObject = {}
        if (
            target.catalog_ingredient_id is None
            and source.catalog_ingredient_id is not None
        ):
            target_changes["catalog_ingredient_id"] = source.catalog_ingredient_id
        if target.catalog_product_id is None and source.catalog_product_id is not None:
            target_changes["catalog_product_id"] = source.catalog_product_id
        if (
            target.category_id is None
            and source.category_id is not None
            and IngredientCategory.objects.filter(
                user=user, id=source.category_id
            ).exists()
        ):
            target_changes["category_id"] = source.category_id
        if source.non_edible and not target.non_edible:
            target_changes["non_edible"] = True
        if source.sugars_are_added and not target.sugars_are_added:
            target_changes["sugars_are_added"] = True
        if not target.nutrition_label_name and source.nutrition_label_name:
            target_changes["nutrition_label_name"] = source.nutrition_label_name
        if target.nutrition_per_100g is None and source.nutrition_per_100g is not None:
            target_changes.update(
                {
                    "nutrition_source": source.nutrition_source,
                    "nutrition_source_id": source.nutrition_source_id,
                    "nutrition_description": source.nutrition_description,
                    "nutrition_package_ingredients": source.nutrition_package_ingredients,
                    "nutrition_per_100g": source.nutrition_per_100g,
                    "nutrition_updated_at": source.nutrition_updated_at,
                }
            )
        source_tag_ids = IngredientTagMembership.objects.filter(
            ingredient=source, tag__user=user
        ).values_list("tag_id", flat=True)
        IngredientTagMembership.objects.bulk_create(
            [
                IngredientTagMembership(ingredient=target, tag_id=tag_id)
                for tag_id in source_tag_ids
            ],
            ignore_conflicts=True,
        )
        target_allergens = set(
            target.allergen_overrides.values_list("allergen", flat=True)
        )
        IngredientAllergenOverride.objects.bulk_create(
            [
                IngredientAllergenOverride(
                    ingredient=target,
                    allergen=override.allergen,
                    status=override.status,
                    source_kind=override.source_kind,
                    source_ref=override.source_ref,
                )
                for override in source.allergen_overrides.all()
                if override.allergen not in target_allergens
            ]
        )
        # A waiting custom value follows the row it was typed for; when the
        # target already has one waiting, the source's is superseded rather
        # than queued behind it, because only one can be pending.
        pending = NutritionRequest.objects.filter(
            ingredient=source, status=NutritionRequest.Status.PENDING
        )
        if NutritionRequest.objects.filter(
            ingredient=target, status=NutritionRequest.Status.PENDING
        ).exists():
            pending.update(
                status=NutritionRequest.Status.SUPERSEDED, resolved_at=timezone.now()
            )
        NutritionRequest.objects.filter(ingredient=source).update(ingredient=target)
        dropped_measures = 0
        for measure in source.measures.all():
            kept, created = IngredientMeasure.objects.get_or_create(
                ingredient=target,
                unit=measure.unit,
                qualifier=measure.qualifier,
                defaults={"amount": measure.amount, "grams": measure.grams},
            )
            # The target wins the conflict, so the two rows disagreeing about
            # what a cup weighs is the merge's only lossy step. Count it: the
            # merge is not undoable.
            if not created and (
                kept.amount != measure.amount or kept.grams != measure.grams
            ):
                dropped_measures += 1
        # A conversion and a preparation are CASCADE children of the source, so
        # the delete below takes them with it unless they move first. The
        # target wins both conflicts, exactly as it wins a measure: it is the
        # row the user chose to keep.
        if not IngredientConversion.objects.filter(ingredient=target).exists():
            IngredientConversion.objects.filter(ingredient=source).update(
                ingredient=target
            )
        kept_preparations = set(
            target.preparations.values_list("normalized_name", flat=True)
        )
        source.preparations.exclude(normalized_name__in=kept_preparations).update(
            ingredient=target
        )
        if not target_has_preferred and source_preferred is not None:
            # The adopted preferred item now sets the target's price, so its
            # price_source moves with it — a Catalog-labelled target does not
            # keep that label while costing from a supplier pack.
            apply_price(
                target,
                {
                    "purchase_cost_cents": source_preferred.pack_price_cents,
                    "purchase_size": source_preferred.pack_amount,
                    "purchase_unit": source_preferred.pack_unit,
                },
                source=IngredientPrice.Source.SUPPLIER,
                supplier_item=source_preferred,
                extra_fields=target_changes,
            )
        else:
            for field, value in target_changes.items():
                setattr(target, field, value)
            target.save(update_fields=[*target_changes, "updated_at"])
        # The source's reparented rows can out-date the target's own history, and
        # the head of that history is read as the current price. Restate the
        # target's materialized tuple as the newest row when it no longer is.
        head = target.price_history.first()
        if head is None or price_changed(
            target, {field: getattr(head, field) for field in PRICE_FIELDS}
        ):
            record_price(
                target,
                {field: getattr(target, field) for field in PRICE_FIELDS},
                source=target.price_source,
            )
        source_name = source.name
        source.delete()
        version = check_and_bump(target, None)
    record_event(
        user,
        user,
        "ingredient",
        "edited",
        resource_id=target.id,
        name=target.name,
        publicId=target.public_id,
        mergedFrom=source_name,
    )
    return {
        "ok": True,
        "targetId": str(target.id),
        "droppedMeasures": dropped_measures,
        "editVersion": version,
    }


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "save-ingredient": action_save_ingredient,
    "save-preparation": action_save_preparation,
    "replace-ingredient-allergens": action_replace_ingredient_allergens,
    "delete-preparations": action_delete_preparations,
    "save-ingredient-conversion": action_save_ingredient_conversion,
    "reset-ingredient-conversion": action_reset_ingredient_conversion,
    "search-nutrition-foods": action_search_nutrition_foods,
    "set-ingredient-nutrition": action_set_ingredient_nutrition,
    "update-ingredient-nutrition-settings": action_update_ingredient_nutrition_settings,
    "request-custom-nutrition": action_request_custom_nutrition,
    "clear-ingredient-nutrition": action_clear_ingredient_nutrition,
    "search-master-prices": action_search_master_prices,
    "match-master-prices": action_match_master_prices,
    "adopt-master-price": action_adopt_master_price,
    "dismiss-master-price": action_dismiss_master_price,
    "search-catalog-prices": action_search_catalog_prices,
    "search-catalog-ingredients": action_search_catalog_ingredients,
    "match-catalog-prices": action_match_catalog_prices,
    "adopt-catalog-price": action_adopt_catalog_price,
    "activate-catalog-ingredient": action_activate_catalog_ingredient,
    "archive-ingredient": action_archive_ingredient,
    "rename-ingredient-category": action_rename_ingredient_category,
    "delete-ingredient-category": action_delete_ingredient_category,
    "delete-ingredient": action_delete_ingredient,
    "import-ingredients": action_import_ingredients,
    "supplier-import-status": action_supplier_import_status,
    "undo-ingredient-import": action_undo_ingredient_import,
    "set-preferred-supplier-item": action_set_preferred_supplier_item,
    "merge-ingredients": action_merge_ingredients,
}
