"""Recipe and bench-cost mutations."""

import hashlib
import json
import logging
import secrets
from collections import Counter
from collections.abc import Callable
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote
from uuid import UUID

from django.conf import settings
from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import F, Max, ProtectedError
from django.db.models.deletion import RestrictedError
from django.utils import timezone

from ... import throttling
from ...catalog import (
    next_recipe_code,
    normalized_category_name,
    resolve_recipe_category,
)
from ...models import (
    MAX_INGREDIENT_MEASURE_VALUE,
    ActivityEvent,
    BenchCostRecipe,
    BenchCostStep,
    BenchCostTiming,
    Ingredient,
    IngredientConversion,
    IngredientMeasure,
    Menu,
    MenuItem,
    Preparation,
    Recipe,
    RecipeBatchSize,
    RecipeBook,
    RecipeBookRecipe,
    RecipeComment,
    RecipeCategory,
    RecipeEquivalency,
    RecipeExternalRef,
    RecipeGuestLink,
    RecipeItem,
    RecipePaste,
    RecipePasteItem,
    RecipeLineMatch,
    RecipeShare,
    RecipeStep,
    RecipeTag,
    RecipeTagMembership,
    RecipeTiming,
    SalesProduct,
    User,
)
from ...integrations.emails import (
    EmailNotConfigured,
    send_book_share,
    send_guest_share,
    send_share_notification,
    send_shares_notification,
)
from ..sales.bundles import BundleIndex
from ..shared.activity import activity_event, record_event
from ..shared.billing import EntitlementError, billing_json, write_blocked
from ..shared.locking import lock_workspace
from ..shared.ingredient_identity import save_line_match
from ..shared.preparations import seeded_preparation_yield
from ..shared.recipe_access import (
    accessible_recipe_queryset,
    editable_recipe_queryset,
    kitchen_roles,
    recipe_permission,
)
from ..shared.values import (
    MONEY_CENTS_LIMIT,
    bool_value,
    import_date_value,
    int_value,
    iso,
    normalized_name,
    number_value,
    text_value,
    uuid_value,
)
from ..shared.versioning import check_and_bump
from ..shared.vocabulary import unit_slugs
from .guest_links import hash_guest_token
from ...units import COUNT_YIELD_UNITS, MEASURE_UNIT_VALUES, unit_family
from .health import (
    RecipeHealthReadModel,
    menu_detail_payload,
    menu_item_cost_cents,
    menu_recipe_rows,
    named_identities,
)
from .serializers import external_ref_json, recipe_item_json

logger = logging.getLogger(__name__)

# A batch is counted, weighed or poured; a sauce is a quart the way bread is
# a loaf, so volume sits beside weight and the two count spellings. Mirrors
# YIELD_UNIT_VALUES in apps/web/lib/unit-registry.ts.
YIELD_UNITS = {
    *COUNT_YIELD_UNITS,
    "g",
    "kg",
    "oz",
    "lb",
    "ml",
    "l",
    "fl-oz",
    "cup",
    "pt",
    "qt",
    "gal",
}

JsonObject = dict[str, Any]


def owned_cost_recipe(user: User, value: Any) -> BenchCostRecipe:
    row = BenchCostRecipe.objects.filter(user=user, id=uuid_value(value)).first()
    if row is None:
        raise ValueError("Recipe not found")
    return row


def owned_step(user: User, value: Any) -> BenchCostStep:
    row = BenchCostStep.objects.filter(recipe__user=user, id=uuid_value(value)).first()
    if row is None:
        raise ValueError("Step not found")
    return row


def recipe_kind_value(value: Any) -> str:
    if value is None:
        return Recipe.KIND_RECIPE
    if value not in {choice for choice, _ in Recipe.KIND_CHOICES}:
        raise ValueError("Invalid recipe type")
    return value


def recipe_status_value(value: Any) -> str:
    if value is None:
        return Recipe.STATUS_ACTIVE
    if value not in {choice for choice, _ in Recipe.STATUS_CHOICES}:
        raise ValueError("Invalid recipe status")
    return value


def recipe_values(user: User, body: JsonObject) -> JsonObject:
    amount = number_value(
        body.get("yieldAmount"),
        "Yield",
        minimum=0.000001,
        maximum=1000000,
        nullable=True,
    )
    unit = body.get("yieldUnit")
    if amount is not None and unit not in YIELD_UNITS:
        raise ValueError("Invalid yield unit")
    menu_price = body.get("menuPriceCents")
    if menu_price is not None:
        menu_price = int_value(menu_price, "Menu price", minimum=1, maximum=100000000)
    category_value = body.get("category")
    category = (
        resolve_recipe_category(
            user, text_value(category_value, "Category", max_length=64).strip()
        )
        if category_value is not None
        else None
    )
    method = body.get("method", "")
    values: JsonObject = {
        "kind": recipe_kind_value(body.get("kind")),
        "title": text_value(
            body.get("title"), "Title", max_length=200, allow_blank=True
        ).strip()
        or "Untitled recipe",
        "body": text_value(
            body.get("body", ""), "Ingredients", max_length=200000, allow_blank=True
        ),
        "method": (
            text_value(method, "Method", max_length=200000, allow_blank=True)
            if method is not None
            else ""
        ),
        "yield_amount": amount,
        "yield_unit": unit if amount is not None else None,
        "category": category,
        "description": text_value(
            body.get("description", ""),
            "Description",
            max_length=200000,
            allow_blank=True,
        ),
    }
    # The sell price lives on the Cost tab now; an editor save that does not
    # mention it leaves it alone.
    if "menuPriceCents" in body:
        values["menu_price_cents"] = menu_price
    if "servingAmount" in body or "servingUnit" in body:
        serving_amount = _decimal(body.get("servingAmount"), "Serving amount")
        serving_unit = _recipe_unit(body.get("servingUnit", ""), "Serving unit")
        if (serving_amount is None) != (not serving_unit):
            raise ValueError("Serving amount and unit must be supplied together")
        if serving_amount is not None and serving_amount <= 0:
            raise ValueError("Serving amount must be positive")
        values["serving_amount"] = serving_amount
        values["serving_unit"] = serving_unit
    if "nutritionServingAmount" in body or "nutritionServingUnit" in body:
        values["nutrition_serving_amount"], values["nutrition_serving_unit"] = (
            _nutrition_measure(
                body.get("nutritionServingAmount"),
                body.get("nutritionServingUnit", ""),
            )
        )
    if "nutritionPackageAmount" in body or "nutritionPackageUnit" in body:
        values["nutrition_package_amount"], values["nutrition_package_unit"] = (
            _nutrition_measure(
                body.get("nutritionPackageAmount"),
                body.get("nutritionPackageUnit", ""),
                "Package size",
            )
        )
    if "shelfLifeAmount" in body or "shelfLifeUnit" in body:
        shelf_life_amount = _decimal(body.get("shelfLifeAmount"), "Shelf-life amount")
        shelf_life_unit = _shelf_life_unit(body.get("shelfLifeUnit", ""))
        if (shelf_life_amount is None) != (not shelf_life_unit):
            raise ValueError("Shelf-life amount and unit must be supplied together")
        if shelf_life_amount is not None and shelf_life_amount <= 0:
            raise ValueError("Shelf-life amount must be positive")
        values["shelf_life_amount"] = shelf_life_amount
        values["shelf_life_unit"] = shelf_life_unit
    if "prepTimeAmount" in body or "prepTimeUnit" in body:
        prep_time_amount = _decimal(body.get("prepTimeAmount"), "Prep-time amount")
        prep_time_unit = _prep_time_unit(body.get("prepTimeUnit", ""))
        if (prep_time_amount is None) != (not prep_time_unit):
            raise ValueError("Prep-time amount and unit must be supplied together")
        if prep_time_amount is not None and prep_time_amount <= 0:
            raise ValueError("Prep-time amount must be positive")
        values["prep_time_amount"] = prep_time_amount
        values["prep_time_unit"] = prep_time_unit
    if "autoSumYieldEnabled" in body:
        if not isinstance(body["autoSumYieldEnabled"], bool):
            raise ValueError("Auto-sum yield must be boolean")
        values["auto_sum_yield_enabled"] = body["autoSumYieldEnabled"]
    if "autoPrepTimeEnabled" in body:
        if not isinstance(body["autoPrepTimeEnabled"], bool):
            raise ValueError("Auto prep time must be boolean")
        values["auto_prep_time_enabled"] = body["autoPrepTimeEnabled"]
    if "percentageMode" in body:
        if body["percentageMode"] not in {"", "weight", "flour"}:
            raise ValueError("Invalid percentage mode")
        values["percentage_mode"] = body["percentageMode"]
    if "percentIngredientEnabled" in body:
        if not isinstance(body["percentIngredientEnabled"], bool):
            raise ValueError("Percent ingredient mode must be boolean")
        values["percent_ingredient_enabled"] = body["percentIngredientEnabled"]
    if "percentIngredientType" in body:
        if body["percentIngredientType"] not in {"", "weight", "flour"}:
            raise ValueError("Invalid percent ingredient type")
        values["percent_ingredient_type"] = body["percentIngredientType"]
    if "status" in body:
        values["status"] = recipe_status_value(body.get("status"))
    if "code" in body:
        code_value = body.get("code")
        values["code"] = (
            text_value(code_value, "Code", max_length=32, allow_blank=True).strip()
            if code_value is not None
            else ""
        )
    return values


def _save_fingerprint(body: JsonObject) -> str:
    """A digest of what this save would write.

    The editor autosaves every few seconds with the same payload, so an
    `edited` line is recorded only when the digest differs from the one the
    last recorded edit carried.
    """
    payload = {
        key: value
        for key, value in body.items()
        if key not in {"id", "expectedEditVersion"}
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def _record_recipe_edit(actor: User, row: Recipe, body: JsonObject) -> None:
    fingerprint = _save_fingerprint(body)
    last = (
        ActivityEvent.objects.filter(
            user_id=row.user_id,
            resource_type="recipe",
            resource_id=row.id,
            event="edited",
        )
        .values_list("context", flat=True)
        .first()
    )
    if last is not None and last.get("hash") == fingerprint:
        return
    record_event(
        row.user,
        actor,
        "recipe",
        "edited",
        resource_id=row.id,
        name=row.title,
        publicId=row.public_id,
        hash=fingerprint,
    )


def action_save_recipe(user: User, body: JsonObject) -> JsonObject:
    existing_id = body.get("id")
    owner_id = body.get("ownerId")
    if existing_id and owner_id is not None:
        raise ValueError("A kitchen can be chosen only when creating a recipe")
    existing = (
        editable_recipe_queryset(user).filter(id=uuid_value(existing_id)).first()
        if existing_id
        else None
    )
    if existing_id:
        # An id nobody may edit is a refusal, never a new recipe of one's own.
        if existing is None:
            raise ValueError("Recipe not found or not editable")
    if existing is not None and existing.user_id != user.id:
        allowed_editor_fields = {
            "id",
            "title",
            "description",
            "items",
            "steps",
            "expectedEditVersion",
        }
        if set(body) - allowed_editor_fields:
            raise ValueError(
                "Editors may change only recipe title, description, items, and steps"
            )
        _require_open_kitchen(existing.user)
    # Everything a create writes belongs to the kitchen it lands in: its
    # category, its code, its cap and its lock are the owner's, not the
    # editor's. The two are the same user unless `ownerId` names a kitchen.
    owner = _editable_kitchen(user, owner_id) if owner_id is not None else user
    values = recipe_values(owner, body)
    row = existing
    created = row is None
    if row:
        actor_role = "owner" if row.user_id == user.id else "editor"
        explicit_code = values.get("code", row.code)
        previous_title = row.title
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
        try:
            with transaction.atomic():
                row = Recipe.objects.select_for_update().get(pk=row.pk)
                check_and_bump(row, expected)
                for field, value in values.items():
                    if actor_role == "editor" and field not in {"title", "description"}:
                        continue
                    setattr(row, field, value)
                _clean(row)
                row.save()
                if any(
                    key in body
                    for key in (
                        "items",
                        "steps",
                        "batchSizes",
                        "equivalency",
                        "tagIds",
                        "tags",
                    )
                ):
                    _save_normalized_content(row, body, actor=user)
                # A linked line copies the recipe title for display, but the
                # saved recipe id remains its identity. Follow a rename only
                # while that copy still equals the old canonical title; a cook's
                # deliberately different wording remains an attention state.
                if previous_title != row.title:
                    parent_ids = list(
                        RecipeItem.objects.filter(
                            recipe__user=row.user,
                            subrecipe=row,
                            display_name=previous_title,
                        )
                        .values_list("recipe_id", flat=True)
                        .distinct()
                    )
                    if parent_ids:
                        locked_parent_ids = list(
                            Recipe.objects.select_for_update()
                            .filter(user=row.user, id__in=parent_ids)
                            .order_by("id")
                            .values_list("id", flat=True)
                        )
                        affected_parent_ids = list(
                            RecipeItem.objects.filter(
                                recipe_id__in=locked_parent_ids,
                                subrecipe=row,
                                display_name=previous_title,
                            )
                            .values_list("recipe_id", flat=True)
                            .distinct()
                        )
                        if affected_parent_ids:
                            changed_at = timezone.now()
                            RecipeItem.objects.filter(
                                recipe_id__in=affected_parent_ids,
                                subrecipe=row,
                                display_name=previous_title,
                            ).update(display_name=row.title, updated_at=changed_at)
                            Recipe.objects.filter(
                                user=row.user, id__in=affected_parent_ids
                            ).update(
                                edit_version=F("edit_version") + 1,
                                updated_at=changed_at,
                            )
                # A parent recipe references a component by its title text, so
                # renaming one keeps the old title as an identity in the
                # component owner's workspace. It commits with the title and
                # edit version, never as a later actor-owned side effect.
                if row.kind == Recipe.KIND_COMPONENT:
                    old_match = normalized_name(previous_title)
                    if old_match and old_match != normalized_name(row.title):
                        save_line_match(
                            user=row.user,
                            line=old_match,
                            component_recipe=row,
                        )
        except IntegrityError:
            raise ValueError(f"Code {explicit_code!r} is already in use")
    else:
        explicit_code = values.pop("code", "")
        limit = billing_json(owner)["entitlements"]["maxRecipes"]
        with transaction.atomic():
            if limit is not None:
                # Serialized so concurrent creates cannot both read a count
                # below the cap; only a capped plan pays for the lock.
                lock_workspace(owner)
                if Recipe.objects.filter(user=owner).count() >= limit:
                    # The cap belongs to the kitchen, so a member is told
                    # whose plan to blame rather than offered an upgrade.
                    raise EntitlementError(
                        "This kitchen has reached its recipe limit. Ask the "
                        "owner to upgrade."
                        if owner.id != user.id
                        else (
                            f"You've reached the {limit}-recipe limit on the "
                            "Free plan. Upgrade to create unlimited recipes."
                        ),
                        code="recipe_limit_reached",
                    )
            try:
                with transaction.atomic():
                    row = Recipe(
                        user=owner,
                        code=explicit_code or next_recipe_code(owner),
                        **values,
                    )
                    _clean(row)
                    row.save()
                    if any(
                        key in body
                        for key in (
                            "items",
                            "steps",
                            "batchSizes",
                            "equivalency",
                            "tagIds",
                            "tags",
                        )
                    ):
                        _save_normalized_content(row, body, actor=user)
            except IntegrityError:
                if explicit_code:
                    raise ValueError(f"Code {explicit_code!r} is already in use")
                # Auto-generated code collided (concurrent create); retry once.
                with transaction.atomic():
                    row = Recipe(user=owner, code=next_recipe_code(owner), **values)
                    _clean(row)
                    row.save()
                    if any(
                        key in body
                        for key in (
                            "items",
                            "steps",
                            "batchSizes",
                            "equivalency",
                            "tagIds",
                            "tags",
                        )
                    ):
                        _save_normalized_content(row, body, actor=user)
    if created:
        # The line belongs to the kitchen the recipe landed in; the actor is
        # whoever typed it, which is how a member's work is attributed.
        record_event(
            row.user,
            user,
            "recipe",
            "added",
            resource_id=row.id,
            name=row.title,
            publicId=row.public_id,
        )
    else:
        _record_recipe_edit(user, row, body)
    saved: JsonObject = {
        "id": str(row.id),
        "publicId": row.public_id,
        "code": row.code,
        "editVersion": row.edit_version,
        "ownerId": str(row.user_id),
    }
    if "items" in body:
        # The stored lines, so an editor that just linked a sub-recipe can show
        # its nested payload without a reload.
        saved["items"] = [
            recipe_item_json(item)
            for item in RecipeItem.objects.filter(recipe=row)
            .select_related("ingredient", "subrecipe")
            .prefetch_related("subrecipe__items")
        ]
    return saved


def _require_open_kitchen(owner: User) -> None:
    """A closed workspace refuses another account's writes as well as its own.

    Dispatch gates every action on the caller's own billing; a collaborator
    writing into someone else's kitchen has to be gated on that kitchen.
    """
    if write_blocked(owner):
        raise ValueError("This kitchen is closed for edits.")


def _editable_kitchen(user: User, value: Any) -> User:
    """The kitchen a create names, if the caller may create in it."""
    owner_id = uuid_value(value, "kitchen")
    if kitchen_roles(user).get(owner_id) != RecipeShare.EDITOR:
        raise ValueError("Kitchen not found or read-only")
    owner = User.objects.get(pk=owner_id)
    _require_open_kitchen(owner)
    return owner


def _editable_recipe(user: User, value: Any) -> Recipe:
    row = editable_recipe_queryset(user).filter(id=uuid_value(value)).first()
    if row is None:
        raise ValueError("Recipe not found or not editable")
    return row


def _clean(row: Any, subject: str = "", *, unique: bool = True) -> None:
    """Validate a row, naming the row and the field in the message.

    Django reports field errors in a dict that the HTTP edge flattens to its
    first message, so an over-long quantity reached the editor as a bare
    "Ensure that there are no more than 15 digits in total." with nothing
    saying which row or which field the editor should fix.

    `unique=False` for a row that replaces the ones already saved: an item
    at position 0 is checked before the old position 0 is deleted, and the
    uniqueness check would refuse every re-save of a recipe with lines.
    """
    try:
        row.full_clean(validate_unique=unique, validate_constraints=unique)
    except ValidationError as exc:
        if not hasattr(exc, "error_dict"):
            raise
        field, messages = next(iter(exc.message_dict.items()))
        label = (
            ""
            if field == NON_FIELD_ERRORS
            else str(row._meta.get_field(field).verbose_name)
        )
        named = " ".join(part for part in (subject.strip(), label) if part)
        raise ValidationError(
            f"{named}: {messages[0]}" if named else messages[0]
        ) from exc


def _decimal(value: Any, label: str, *, nullable: bool = True) -> Decimal | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if not result.is_finite() or result < 0:
        raise ValueError(f"{label} is invalid")
    return result


def _nutrition_measure(
    amount_value: Any, unit_value: Any, label: str = "Serving size"
) -> tuple[Decimal | None, str]:
    """A measure a label preview describes: a positive amount in a unit a
    recipe is written in, or nothing at all."""
    amount = _decimal(amount_value, label)
    unit = _recipe_unit(unit_value, f"{label} unit")
    if (amount is None) != (not unit):
        raise ValueError(f"{label} amount and unit must be supplied together")
    if amount is not None and amount <= 0:
        raise ValueError(f"{label} must be positive")
    if unit and unit_family(unit) == "dimensionless":
        raise ValueError(f"{label} needs a weight, volume or count unit")
    return amount, unit


def _yield_after_cooking(value: Any) -> Decimal:
    """The share of a line that stays in the dish, 0..100. Zero is a real
    answer (a discarded brine), so it is not read as "unset"."""
    result = _decimal(
        100 if value is None else value, "Yield after cooking", nullable=False
    )
    if result is None or result > 100:
        raise ValueError("Yield after cooking must be between 0 and 100")
    return result


_SHELF_LIFE_UNITS = {"hours", "days", "weeks", "months"}
_PREP_TIME_UNITS = {"minutes", "hours"}


def _recipe_unit(value: Any, label: str, *, allow_blank: bool = True) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text")
    value = value.strip()
    if not value and allow_blank:
        return ""
    if value not in unit_slugs():
        raise ValueError(f"Invalid {label.lower()}")
    return value


def _shelf_life_unit(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Shelf-life unit must be text")
    value = value.strip().lower()
    if value and value not in _SHELF_LIFE_UNITS:
        raise ValueError("Invalid shelf-life unit")
    return value


def _prep_time_unit(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Prep-time unit must be text")
    value = value.strip().lower()
    if value and value not in _PREP_TIME_UNITS:
        raise ValueError("Invalid prep-time unit")
    return value


def _save_normalized_content(recipe: Recipe, body: JsonObject, *, actor: User) -> None:
    """Validate the complete aggregate before replacing supplied collections.

    The payload is an aggregate snapshot: omitted collections are preserved;
    supplied collections are intentionally replaced in one transaction.
    Existing item ids survive replacement so an editor can reorder and edit
    content without changing the owner's cost-exclusion decisions.
    """
    item_specs = step_specs = batch_specs = tags = None
    if "items" in body:
        raw_items = body["items"]
        if not isinstance(raw_items, list) or len(raw_items) > 1000:
            raise ValueError("Recipe items must be a list")
        existing_items = {item.id: item for item in recipe.items.all()}
        item_ids = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                raise ValueError("Recipe item is malformed")
            if raw.get("id") is not None:
                item_ids.append(uuid_value(raw["id"], "recipe item id"))
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("Recipe item ids must be unique")
        if RecipeItem.objects.filter(id__in=item_ids).exclude(recipe=recipe).exists():
            raise ValueError("Recipe line not found")
        editor = actor.id != recipe.user_id
        if (
            editor
            and any(item.excluded_from_cost for item in existing_items.values())
            and any(raw.get("id") is None for raw in raw_items)
        ):
            raise ValueError("Reload this recipe before editing its lines")
        item_specs = []
        for position, raw in enumerate(raw_items):
            if not isinstance(raw, dict):
                raise ValueError("Recipe item is malformed")
            kind = raw.get("kind")
            if kind not in {choice for choice, _ in RecipeItem.KIND_CHOICES}:
                raise ValueError("Invalid recipe item kind")
            item_id = (
                uuid_value(raw["id"], "recipe item id")
                if raw.get("id") is not None
                else None
            )
            previous = existing_items.get(item_id)
            excluded = previous.excluded_from_cost if previous is not None else False
            if "excludedFromCost" in raw:
                requested = bool_value(raw["excludedFromCost"], "Cost exclusion")
                if editor and requested != excluded:
                    raise ValueError("Only the recipe owner can change cost exclusion")
                excluded = requested
            ingredient = subrecipe = None
            if kind == RecipeItem.INGREDIENT and raw.get("ingredientId"):
                ingredient = Ingredient.objects.filter(
                    user=recipe.user,
                    id=uuid_value(raw["ingredientId"], "ingredient id"),
                ).first()
                if ingredient is None:
                    raise ValueError("Ingredient not found")
            if kind == RecipeItem.SUBRECIPE and raw.get("subrecipeId"):
                subrecipe = Recipe.objects.filter(
                    user=recipe.user, id=uuid_value(raw["subrecipeId"], "subrecipe id")
                ).first()
                if subrecipe is None:
                    raise ValueError("Subrecipe not found")
            display_name = text_value(
                raw.get("displayName", ""),
                "Item name",
                max_length=200,
                allow_blank=True,
            )
            if not display_name:
                display_name = (
                    ingredient.name
                    if ingredient is not None
                    else subrecipe.title
                    if subrecipe is not None
                    else ""
                )
            item = RecipeItem(
                **({"id": item_id} if item_id is not None else {}),
                recipe=recipe,
                kind=kind,
                position=position,
                display_name=display_name,
                quantity=_decimal(raw.get("quantity"), "Quantity"),
                unit=_recipe_unit(raw.get("unit", ""), "Unit"),
                preparation_note=text_value(
                    raw.get("preparationNote", ""),
                    "Preparation note",
                    max_length=200,
                    allow_blank=True,
                ),
                efficiency=_decimal(
                    raw.get("efficiency", 100), "Efficiency", nullable=False
                )
                or Decimal("100"),
                efficiency_after_cooking=_yield_after_cooking(
                    raw.get("efficiencyAfterCooking", 100)
                ),
                is_base=raw.get("isBase") is True,
                excluded_from_cost=excluded,
                ingredient=ingredient,
                subrecipe=subrecipe,
            )
            _clean(item, display_name or f"Row {position + 1}", unique=False)
            item_specs.append(item)
    if "steps" in body:
        raw_steps = body["steps"]
        if not isinstance(raw_steps, list) or len(raw_steps) > 1000:
            raise ValueError("Recipe steps must be a list")
        step_specs = []
        for position, raw in enumerate(raw_steps):
            if not isinstance(raw, dict):
                raise ValueError("Recipe step is malformed")
            kind = raw.get("kind", RecipeStep.INSTRUCTION)
            labor_kind = text_value(
                raw.get("laborKind", ""), "Labor kind", max_length=16, allow_blank=True
            )
            if (
                kind not in {choice for choice, _ in RecipeStep.KIND_CHOICES}
                or labor_kind not in RecipeStep.LABOR_KINDS
            ):
                raise ValueError("Invalid recipe step or labor kind")
            raw_timings = raw.get("timings", [])
            if not isinstance(raw_timings, list) or len(raw_timings) > 50:
                raise ValueError("Step timings are malformed")
            timings = []
            for timing in raw_timings:
                if not isinstance(timing, dict):
                    raise ValueError("Step timing is malformed")
                timings.append(
                    (
                        int_value(
                            timing.get("seconds"), "Seconds", minimum=1, maximum=86400
                        ),
                        int_value(
                            timing.get("yieldCount", 1),
                            "Yield",
                            minimum=1,
                            maximum=1000000,
                        ),
                    )
                )
            step_specs.append(
                (
                    RecipeStep(
                        recipe=recipe,
                        kind=kind,
                        position=position,
                        title=text_value(
                            raw.get("title", ""),
                            "Step title",
                            max_length=200,
                            allow_blank=True,
                        ),
                        body=text_value(
                            raw.get("body", ""),
                            "Step body",
                            max_length=200000,
                            allow_blank=True,
                        ),
                        labor_kind=labor_kind,
                    ),
                    timings,
                )
            )
    if "batchSizes" in body:
        raw_batches = body["batchSizes"]
        if not isinstance(raw_batches, list) or len(raw_batches) > 100:
            raise ValueError("Batch sizes are malformed")
        if (
            raw_batches
            and sum(
                bool(item.get("isOriginal", False))
                for item in raw_batches
                if isinstance(item, dict)
            )
            != 1
        ):
            raise ValueError("Exactly one batch size must be original")
        batch_specs = []
        for raw in raw_batches:
            if not isinstance(raw, dict) or not isinstance(
                raw.get("isOriginal", False), bool
            ):
                raise ValueError("Batch size is malformed")
            scale = _decimal(raw.get("scale"), "Batch scale", nullable=False)
            if not scale:
                raise ValueError("Batch scale must be positive")
            batch_specs.append(
                (
                    text_value(
                        raw.get("label", ""),
                        "Batch label",
                        max_length=120,
                        allow_blank=True,
                    ),
                    scale,
                    raw["isOriginal"],
                )
            )
    if "equivalency" in body:
        raw = body["equivalency"]
        if raw is not None and not isinstance(raw, dict):
            raise ValueError("Equivalency is malformed")
        if isinstance(raw, dict):
            values = {
                "mass_amount": _decimal(raw.get("massAmount"), "Mass amount"),
                "mass_unit": _recipe_unit(raw.get("massUnit", ""), "Mass unit"),
                "volume_amount": _decimal(raw.get("volumeAmount"), "Volume amount"),
                "volume_unit": _recipe_unit(raw.get("volumeUnit", ""), "Volume unit"),
                "count_amount": _decimal(raw.get("countAmount"), "Count amount"),
                "count_unit": _recipe_unit(raw.get("countUnit", ""), "Count unit"),
                "standard": raw.get("standard", True),
            }
            if not isinstance(values["standard"], bool):
                raise ValueError("Equivalency standard must be boolean")
            # A custom row describes the whole finished batch. Total Yield is
            # authoritative for its own family, so that redundant slot is not
            # persisted. A standard row is different: its mass/volume values
            # are a reusable density ratio and both sides must remain intact.
            if values["standard"] is False and recipe.yield_amount is not None:
                yield_family = unit_family(recipe.yield_unit)
                if yield_family in {"mass", "volume", "count"}:
                    values[f"{yield_family}_amount"] = None
                    values[f"{yield_family}_unit"] = ""
            if all(
                values[key] is None
                for key in ("mass_amount", "volume_amount", "count_amount")
            ):
                equivalency = None
            else:
                # Updating the saved row preserves its one-to-one identity and
                # lets full_clean distinguish this edit from a duplicate.
                equivalency = RecipeEquivalency.objects.filter(recipe=recipe).first()
                if equivalency is None:
                    equivalency = RecipeEquivalency(recipe=recipe)
                for field, value in values.items():
                    setattr(equivalency, field, value)
                _clean(equivalency, "Equivalency")
        else:
            equivalency = None
    else:
        equivalency = None
    if "tagIds" in body:
        raw_tag_ids = body["tagIds"]
        if not isinstance(raw_tag_ids, list) or len(raw_tag_ids) > 100:
            raise ValueError("Tags are malformed")
        tag_ids = [uuid_value(value, "tag id") for value in raw_tag_ids]
        tags = list(RecipeTag.objects.filter(user=recipe.user, id__in=tag_ids))
        if len(tags) != len(set(tag_ids)):
            raise ValueError("Tag not found")
    if "tags" in body:
        raw_names = body["tags"]
        if not isinstance(raw_names, list) or len(raw_names) > 100:
            raise ValueError("Tags are malformed")
        names_by_key: dict[str, str] = {}
        for value in raw_names:
            name = text_value(value, "Tag", max_length=80).strip()
            names_by_key.setdefault(normalized_name(name), name)
        tags = [
            RecipeTag.objects.get_or_create(
                user=recipe.user, normalized_name=key, defaults={"name": name}
            )[0]
            for key, name in names_by_key.items()
        ]

    if item_specs is not None:
        RecipeItem.objects.filter(recipe=recipe).delete()
        RecipeItem.objects.bulk_create(item_specs)
    if step_specs is not None:
        RecipeStep.objects.filter(recipe=recipe).delete()
        for step, timings in step_specs:
            step.save()
            RecipeTiming.objects.bulk_create(
                [
                    RecipeTiming(step=step, seconds=seconds, yield_count=count)
                    for seconds, count in timings
                ]
            )
    if batch_specs is not None:
        RecipeBatchSize.objects.filter(recipe=recipe).delete()
        RecipeBatchSize.objects.bulk_create(
            [
                RecipeBatchSize(
                    recipe=recipe, label=label, scale=scale, is_original=original
                )
                for label, scale, original in batch_specs
            ]
        )
    if "equivalency" in body:
        if equivalency is None:
            RecipeEquivalency.objects.filter(recipe=recipe).delete()
        else:
            equivalency.save()
    if tags is not None:
        RecipeTagMembership.objects.filter(recipe=recipe).delete()
        RecipeTagMembership.objects.bulk_create(
            [RecipeTagMembership(recipe=recipe, tag=tag) for tag in tags]
        )


def _owned_recipe(user: User, value: Any) -> Recipe:
    row = Recipe.objects.filter(user=user, id=uuid_value(value, "recipe id")).first()
    if row is None:
        raise ValueError("Recipe not found")
    return row


def _share_request(body: JsonObject) -> tuple[str, str, User | None]:
    """The address, the role, and the account behind it, if there is one."""
    email = text_value(body.get("email"), "Email", max_length=320).lower()
    role = body.get("role", RecipeShare.VIEWER)
    if role not in {RecipeShare.VIEWER, RecipeShare.EDITOR}:
        raise ValueError("Invalid share role")
    recipient = User.objects.filter(
        email__iexact=email, email_verified_at__isnull=False
    ).first()
    return email, role, recipient


def action_share_recipe(user: User, body: JsonObject) -> JsonObject:
    recipe = _owned_recipe(user, body.get("recipeId"))
    email, role, recipient = _share_request(body)
    # An address with no account is invited rather than refused: it gets a
    # capability link now and the role it was invited with once it verifies.
    if recipient is None:
        return {"guest": _mint_guest_link(user, recipe, email, role)}
    if recipient.id == user.id:
        raise ValueError("You already own this recipe")
    share, _ = RecipeShare.objects.update_or_create(
        recipe=recipe, recipient=recipient, defaults={"role": role}
    )
    _notify_share_recipient(user, recipe, recipient, share.role)
    return {
        "id": str(share.id),
        "recipeId": str(recipe.id),
        "recipientId": str(recipient.id),
        "recipientName": recipient.name,
        "role": share.role,
    }


def _notify_share_recipient(
    owner: User, recipe: Recipe, recipient: User, role: str
) -> None:
    """Mail an account holder that a recipe reached their kitchen.

    Best effort, and after the commit: the share row is the thing that grants
    access, so a mail that never leaves must not undo it.
    """
    path = quote(f"/recipes/{recipe.public_id}/recipe")
    link = f"{settings.FORKLUCK_APP_ORIGIN}/login?next={path}"

    def send() -> None:
        try:
            send_share_notification(
                recipient.email,
                owner_name=owner.name,
                recipe_title=recipe.title,
                role=role,
                link=link,
            )
        except (EmailNotConfigured, ValueError):
            logger.exception(
                "Could not send the share notification for recipe %s", recipe.id
            )

    transaction.on_commit(send)


def _mint_guest_link(user: User, recipe: Recipe, email: str, role: str) -> JsonObject:
    try:
        throttling.hit(
            "guest-share",
            str(user.id),
            limit=20,
            window=timedelta(days=1),
            message="Too many guest invites today. Try again tomorrow.",
        )
    except throttling.Throttled as exc:
        raise ValueError(str(exc)) from exc
    token = secrets.token_urlsafe(32)
    with transaction.atomic():
        # Re-sharing an address rotates its link rather than resending the old
        # one, so a forwarded invite stops working, and restates the role.
        RecipeGuestLink.objects.filter(recipe=recipe, email=email).delete()
        link = RecipeGuestLink.objects.create(
            recipe=recipe,
            email=email,
            token_hash=hash_guest_token(token),
            role=role,
        )
    try:
        send_guest_share(
            email,
            owner_name=user.name,
            recipe_title=recipe.title,
            link=f"{settings.FORKLUCK_APP_ORIGIN}/shared/{token}",
            role=role,
        )
    except (EmailNotConfigured, ValueError) as exc:
        # Nobody holds the token, so the row would only be an unreachable link.
        link.delete()
        raise ValueError("The invite email could not be sent") from exc
    throttling.sweep()
    return {"id": str(link.id), "email": link.email, "role": link.role}


def action_share_recipes(user: User, body: JsonObject) -> JsonObject:
    """Share a selection of recipes with one address, in one send.

    A verified account needs no book: it gets one share row per recipe and a
    single mail, and the recipes appear in its list the way one share does.
    An address with no account gets a book instead — one capability link over
    the whole selection — because there is nowhere else to put them.
    """
    raw = body.get("recipeIds")
    if not isinstance(raw, list) or not 1 <= len(raw) <= 50:
        raise ValueError("Select between 1 and 50 recipes")
    # Deduplicated in send order: the reader sees the selection as the owner
    # picked it, and a repeated id is the same recipe, not a second entry.
    ids = []
    for value in raw:
        recipe_id = uuid_value(value, "recipe id")
        if recipe_id not in ids:
            ids.append(recipe_id)
    title = text_value(body.get("title", ""), "Title", max_length=120, allow_blank=True)
    if len(ids) == 1:
        # One recipe is a plain share: the (recipe, email) rotation and the
        # Share dialog's own listing stay exactly as they are.
        answer = action_share_recipe(user, {**body, "recipeId": str(ids[0])})
        guest = answer.get("guest")
        if guest is None:
            return {"shared": 1, "guest": None}
        return {"shared": 0, "guest": {**guest, "title": ""}}

    owned = {row.id: row for row in Recipe.objects.filter(user=user, id__in=ids)}
    # One query, and the whole request is refused rather than the owned
    # subset shared: a selection the owner does not own is a mistake, not an
    # instruction to share part of it.
    if len(owned) != len(ids):
        raise ValueError("Recipe not found")
    recipes = [owned[recipe_id] for recipe_id in ids]
    email, role, recipient = _share_request(body)
    if recipient is None:
        return {
            "shared": 0,
            "guest": _mint_book_link(user, recipes, email, role, title),
        }
    if recipient.id == user.id:
        raise ValueError("You already own these recipes")
    for recipe in recipes:
        RecipeShare.objects.update_or_create(
            recipe=recipe, recipient=recipient, defaults={"role": role}
        )
    _notify_shares_recipient(user, recipient, len(recipes), role)
    return {"shared": len(recipes), "guest": None}


def _notify_shares_recipient(
    owner: User, recipient: User, recipe_count: int, role: str
) -> None:
    """Mail an account holder that a selection reached their kitchen.

    Best effort and after the commit, like the single-recipe notification:
    the share rows grant the access, so a mail that never leaves must not
    undo them. The link is the recipe list, since there is no one recipe.
    """
    link = f"{settings.FORKLUCK_APP_ORIGIN}/login?next=/recipes"

    def send() -> None:
        try:
            send_shares_notification(
                recipient.email,
                owner_name=owner.name,
                recipe_count=recipe_count,
                role=role,
                link=link,
            )
        except (EmailNotConfigured, ValueError):
            logger.exception(
                "Could not send the share notification for %s recipes to %s",
                recipe_count,
                recipient.id,
            )

    transaction.on_commit(send)


def _mint_book_link(
    user: User, recipes: list[Recipe], email: str, role: str, title: str
) -> JsonObject:
    """One capability link over a selection, for an address with no account.

    Books share the guest-link throttle: both are invitations mailed to an
    unverified address, so twenty a day is twenty of either.
    """
    try:
        throttling.hit(
            "guest-share",
            str(user.id),
            limit=20,
            window=timedelta(days=1),
            message="Too many guest invites today. Try again tomorrow.",
        )
    except throttling.Throttled as exc:
        raise ValueError(str(exc)) from exc
    token = secrets.token_urlsafe(32)
    with transaction.atomic():
        # A book is a snapshot, so sharing the same address again writes a
        # second book rather than rotating the first one's link.
        book = RecipeBook.objects.create(
            user=user,
            email=email,
            title=title,
            token_hash=hash_guest_token(token),
            role=role,
        )
        RecipeBookRecipe.objects.bulk_create(
            [
                RecipeBookRecipe(book=book, recipe=recipe, position=position)
                for position, recipe in enumerate(recipes)
            ]
        )
    try:
        send_book_share(
            email,
            owner_name=user.name,
            title=title,
            recipe_count=len(recipes),
            link=f"{settings.FORKLUCK_APP_ORIGIN}/shared/book/{token}",
            role=role,
        )
    except (EmailNotConfigured, ValueError) as exc:
        # Nobody holds the token, so the rows would only be an unreachable link.
        book.delete()
        raise ValueError("The invite email could not be sent") from exc
    throttling.sweep()
    return {
        "id": str(book.id),
        "email": book.email,
        "role": book.role,
        "title": book.title,
    }


def action_update_recipe_share(user: User, body: JsonObject) -> JsonObject:
    recipe = _owned_recipe(user, body.get("recipeId"))
    share = RecipeShare.objects.filter(
        recipe=recipe, id=uuid_value(body.get("shareId"))
    ).first()
    if share is None:
        raise ValueError("Share not found")
    role = body.get("role")
    if role not in {RecipeShare.VIEWER, RecipeShare.EDITOR}:
        raise ValueError("Invalid share role")
    share.role = role
    share.save(update_fields=["role", "updated_at"])
    return {"ok": True}


def action_remove_recipe_share(user: User, body: JsonObject) -> JsonObject:
    recipe = _owned_recipe(user, body.get("recipeId"))
    RecipeShare.objects.filter(
        recipe=recipe, id=uuid_value(body.get("shareId"))
    ).delete()
    return {"ok": True}


def action_remove_recipe_guest_link(user: User, body: JsonObject) -> JsonObject:
    recipe = _owned_recipe(user, body.get("recipeId"))
    RecipeGuestLink.objects.filter(
        recipe=recipe, id=uuid_value(body.get("linkId"), "link id")
    ).delete()
    return {"ok": True}


def action_remove_recipe_book(user: User, body: JsonObject) -> JsonObject:
    """Revoke a book. The token is the whole credential, so the row is it."""
    RecipeBook.objects.filter(
        user=user, id=uuid_value(body.get("bookId"), "book id")
    ).delete()
    return {"ok": True}


def action_save_recipe_comment(user: User, body: JsonObject) -> JsonObject:
    recipe = (
        accessible_recipe_queryset(user, prefetch_shares=False)
        .filter(id=uuid_value(body.get("recipeId")))
        .first()
    )
    if recipe is None:
        raise ValueError("Recipe not found")
    if recipe_permission(recipe, user) not in {"owner", "editor"}:
        raise ValueError("Recipe is read-only")
    if recipe.user_id != user.id:
        _require_open_kitchen(recipe.user)
    comment_id = body.get("id")
    text = text_value(body.get("body"), "Comment", max_length=20000)
    if comment_id:
        comment = RecipeComment.objects.filter(
            recipe=recipe, id=uuid_value(comment_id)
        ).first()
        if comment is None or (
            comment.author_id != user.id and recipe.user_id != user.id
        ):
            raise ValueError("Comment not found")
        comment.body = text
        comment.save(update_fields=["body", "updated_at"])
    else:
        comment = RecipeComment.objects.create(recipe=recipe, author=user, body=text)
    return {"id": str(comment.id)}


def action_delete_recipe_comment(user: User, body: JsonObject) -> JsonObject:
    comment = RecipeComment.objects.filter(
        id=uuid_value(body.get("id")),
        recipe__in=editable_recipe_queryset(user),
    ).first()
    if comment is None or (
        comment.author_id != user.id and comment.recipe.user_id != user.id
    ):
        raise ValueError("Comment not found")
    comment.delete()
    return {"ok": True}


def action_delete_recipe(user: User, body: JsonObject) -> JsonObject:
    row = Recipe.objects.filter(user=user, id=uuid_value(body.get("id"))).first()
    if row is None:
        raise ValueError("Recipe not found")
    try:
        row.delete()
    except ProtectedError:
        raise ValueError(
            "This recipe is used by a product. Remove it from the product "
            "first, or archive the recipe instead."
        )
    record_event(
        user,
        user,
        "recipe",
        "deleted",
        resource_id=row.id,
        name=row.title,
        publicId=row.public_id,
    )
    return {"ok": True}


def action_update_recipe_statuses(user: User, body: JsonObject) -> JsonObject:
    """Archive or restore a selection in one transaction.

    Refused whole when any id is not the owner's: a selection the owner does
    not own is a mistake, not an instruction to archive part of it. A recipe
    already in that status is left alone and writes no line, so archiving
    twice reads back as one event. The status is not a versioned field, so
    `edit_version` stays where it was.
    """
    raw = body.get("recipeIds")
    if not isinstance(raw, list) or not 1 <= len(raw) <= 200:
        raise ValueError("Select between 1 and 200 recipes")
    ids: list[UUID] = []
    for value in raw:
        recipe_id = uuid_value(value, "recipe id")
        if recipe_id not in ids:
            ids.append(recipe_id)
    status = recipe_status_value(body.get("status"))
    event = "archived" if status == Recipe.STATUS_ARCHIVED else "restored"
    with transaction.atomic():
        rows = list(Recipe.objects.filter(user=user, id__in=ids))
        if len(rows) != len(ids):
            raise ValueError("Recipe not found")
        changed = [row for row in rows if row.status != status]
        if changed:
            Recipe.objects.filter(id__in=[row.id for row in changed]).update(
                status=status, updated_at=timezone.now()
            )
            ActivityEvent.objects.bulk_create(
                [
                    activity_event(
                        user,
                        user,
                        "recipe",
                        event,
                        resource_id=row.id,
                        name=row.title,
                        publicId=row.public_id,
                    )
                    for row in changed
                ]
            )
    return {"ok": True, "changed": len(changed)}


def action_update_recipe_costing(user: User, body: JsonObject) -> JsonObject:
    """The commercial portion and the price of that portion are one setting."""
    row = _owned_recipe(user, body.get("recipeId"))
    serving_amount = _decimal(body.get("servingAmount"), "Portion amount")
    serving_unit = _recipe_unit(body.get("servingUnit", ""), "Portion unit")
    if (serving_amount is None) != (not serving_unit):
        raise ValueError("Portion amount and unit must be supplied together")
    if serving_amount is not None and serving_amount <= 0:
        raise ValueError("Portion amount must be positive")
    if serving_unit and unit_family(serving_unit) == "dimensionless":
        raise ValueError("Portion needs a weight, volume or count unit")
    cents = body.get("menuPriceCents")
    if cents is not None:
        cents = int_value(cents, "Menu price", minimum=1, maximum=100000000)
    fields = []
    if row.serving_amount != serving_amount:
        row.serving_amount = serving_amount
        fields.append("serving_amount")
    if row.serving_unit != serving_unit:
        row.serving_unit = serving_unit
        fields.append("serving_unit")
    if row.menu_price_cents != cents:
        row.menu_price_cents = cents
        fields.append("menu_price_cents")
    if fields:
        row.save(update_fields=[*fields, "updated_at"])
    return {"ok": True}


def action_set_recipe_nutrition_serving(user: User, body: JsonObject) -> JsonObject:
    """The serving and package a label preview describes. Owner metadata, like
    the cost serving: a shared editor changes the lines, not what a serving is.
    Each measure changes only when one of its keys is present."""
    row = _owned_recipe(user, body.get("recipeId"))
    fields: list[str] = []
    if "amount" in body or "unit" in body:
        amount, unit = _nutrition_measure(body.get("amount"), body.get("unit", ""))
        if row.nutrition_serving_amount != amount or row.nutrition_serving_unit != unit:
            row.nutrition_serving_amount = amount
            row.nutrition_serving_unit = unit
            fields += ["nutrition_serving_amount", "nutrition_serving_unit"]
    if "packageAmount" in body or "packageUnit" in body:
        package_amount, package_unit = _nutrition_measure(
            body.get("packageAmount"), body.get("packageUnit", ""), "Package size"
        )
        if (
            row.nutrition_package_amount != package_amount
            or row.nutrition_package_unit != package_unit
        ):
            row.nutrition_package_amount = package_amount
            row.nutrition_package_unit = package_unit
            fields += ["nutrition_package_amount", "nutrition_package_unit"]
    if fields:
        row.save(update_fields=[*fields, "updated_at"])
    return {"ok": True}


def action_set_recipe_item_yield_after_cooking(
    user: User, body: JsonObject
) -> JsonObject:
    """Yield after cooking for one line. Lines are an editor's to change, so
    a shared editor may set it; the row is found through its recipe, so one
    recipe's item id cannot reach another's."""
    recipe = _editable_recipe(user, body.get("recipeId"))
    if body.get("percent") is None:
        raise ValueError("Yield after cooking is required")
    percent = _yield_after_cooking(body.get("percent"))
    item_id = uuid_value(body.get("itemId"), "line id")
    # save-recipe replaces every line, so this write bumps: an editor holding an
    # older read must be refused rather than overwrite the yield.
    with transaction.atomic():
        locked = Recipe.objects.select_for_update().get(pk=recipe.pk)
        updated = RecipeItem.objects.filter(
            recipe=locked,
            id=item_id,
            kind__in=[RecipeItem.INGREDIENT, RecipeItem.SUBRECIPE],
        ).update(efficiency_after_cooking=percent)
        if not updated:
            raise ValueError("Recipe line not found")
        version = check_and_bump(locked, None)
    return {"ok": True, "editVersion": version}


def action_set_recipe_item_excluded_from_cost(
    user: User, body: JsonObject
) -> JsonObject:
    """Leave one measured line out of the money, or count it again. Owner
    metadata, like the costing portion: this is the Cost tab's control. The row
    is found through its recipe, so one recipe's item id cannot reach another's;
    headings and notes are never costed, so they are not togglable either."""
    recipe = _owned_recipe(user, body.get("recipeId"))
    excluded = bool_value(body.get("excluded"), "Left out of cost")
    item_id = uuid_value(body.get("itemId"), "line id")
    # save-recipe restates the flag on every line, so this write bumps: an
    # editor holding an older read must be refused rather than overwrite it.
    with transaction.atomic():
        locked = Recipe.objects.select_for_update().get(pk=recipe.pk)
        updated = RecipeItem.objects.filter(
            recipe=locked,
            id=item_id,
            kind__in=[RecipeItem.INGREDIENT, RecipeItem.SUBRECIPE],
        ).update(excluded_from_cost=excluded)
        if not updated:
            raise ValueError("Recipe line not found")
        version = check_and_bump(locked, None)
    return {"ok": True, "editVersion": version}


def action_save_recipe_external_ref(user: User, body: JsonObject) -> JsonObject:
    recipe = Recipe.objects.filter(
        user=user, id=uuid_value(body.get("recipeId"))
    ).first()
    if recipe is None:
        raise ValueError("Recipe not found")
    system = body.get("system")
    if system not in {choice for choice, _ in RecipeExternalRef.SYSTEM_CHOICES}:
        raise ValueError("Invalid system")
    ref_kind = body.get("refKind")
    if ref_kind not in {choice for choice, _ in RecipeExternalRef.KIND_CHOICES}:
        raise ValueError("Invalid reference kind")
    external_id = text_value(
        body.get("externalId"), "External ID", max_length=160
    ).strip()
    if not external_id:
        raise ValueError("External ID is required")
    try:
        row, _ = RecipeExternalRef.objects.update_or_create(
            user=user,
            system=system,
            ref_kind=ref_kind,
            external_id=external_id,
            defaults={"recipe": recipe},
        )
    except IntegrityError:
        raise ValueError("This reference is already linked")
    return {"item": external_ref_json(row)}


def action_delete_recipe_external_ref(user: User, body: JsonObject) -> JsonObject:
    RecipeExternalRef.objects.filter(user=user, id=uuid_value(body.get("id"))).delete()
    return {"ok": True}


def action_rename_recipe_category(user: User, body: JsonObject) -> JsonObject:
    name = text_value(body.get("name"), "Name", max_length=64).strip()
    if not name:
        raise ValueError("Name is required")
    current = text_value(body.get("currentName"), "Category", max_length=64).strip()
    row = RecipeCategory.objects.filter(
        user=user, normalized_name=normalized_category_name(current)
    ).first()
    if row is None:
        raise ValueError("Category not found")
    normalized = normalized_category_name(name)
    existing = (
        RecipeCategory.objects.filter(user=user, normalized_name=normalized)
        .exclude(id=row.id)
        .first()
    )
    if existing is not None:
        # Merge into the existing category instead of violating uniqueness.
        Recipe.objects.filter(user=user, category=row).update(category=existing)
        row.delete()
        record_event(
            user, user, "category", "edited", name=existing.name, kind="recipe"
        )
        return {"ok": True}
    row.name = name
    row.normalized_name = normalized
    row.save(update_fields=["name", "normalized_name", "updated_at"])
    record_event(
        user, user, "category", "edited", resource_id=row.id, name=name, kind="recipe"
    )
    return {"ok": True}


def action_delete_recipe_category(user: User, body: JsonObject) -> JsonObject:
    name = text_value(body.get("name"), "Name", max_length=64).strip()
    deleted, _ = RecipeCategory.objects.filter(
        user=user, normalized_name=normalized_category_name(name)
    ).delete()
    if deleted:
        record_event(user, user, "category", "deleted", name=name, kind="recipe")
    return {"ok": True}


def action_open_cost_for_recipe(user: User, body: JsonObject) -> JsonObject:
    recipe = Recipe.objects.filter(
        user=user, id=uuid_value(body.get("recipeId"))
    ).first()
    if recipe is None:
        raise ValueError("Recipe not found")
    batch_yield = (
        round(recipe.yield_amount)
        if recipe.yield_unit in COUNT_YIELD_UNITS and recipe.yield_amount
        else 1
    )
    max_position = BenchCostRecipe.objects.filter(user=user).aggregate(Max("position"))[
        "position__max"
    ]
    # Opening the cost sheet twice at once used to leave two records for one
    # recipe. get_or_create leans on the (user, recipe) unique constraint, and
    # the losing side of the race re-reads the winner's row rather than
    # creating its own. Position is left racing on purpose: model ordering
    # breaks ties by created_at, so equal positions stay deterministic.
    try:
        with transaction.atomic():
            row, _ = BenchCostRecipe.objects.get_or_create(
                user=user,
                recipe=recipe,
                defaults={
                    "name": recipe.title,
                    "batch_yield": batch_yield,
                    "position": 0 if max_position is None else max_position + 1,
                },
            )
    except IntegrityError:
        row = BenchCostRecipe.objects.filter(user=user, recipe=recipe).first()
        if row is None:
            raise
    return {"id": str(row.id)}


def step_values(body: JsonObject, *, partial: bool = False) -> JsonObject:
    result: JsonObject = {}
    if not partial or "name" in body:
        result["name"] = text_value(body.get("name"), "Name", max_length=120).strip()
    if not partial or "kind" in body:
        kind = body.get("kind")
        if kind not in {"active", "passive"}:
            raise ValueError("Invalid step kind")
        result["kind"] = kind
    if not partial or "covers" in body:
        result["covers"] = int_value(
            body.get("covers"), "Covers", minimum=1, maximum=1000000
        )
    return result


def action_create_step(user: User, body: JsonObject) -> JsonObject:
    recipe = owned_cost_recipe(user, body.get("recipeId"))
    fields = step_values(
        body.get("input") if isinstance(body.get("input"), dict) else {}
    )
    max_position = recipe.steps.aggregate(Max("position"))["position__max"]
    row = BenchCostStep.objects.create(
        recipe=recipe,
        position=0 if max_position is None else max_position + 1,
        **fields,
    )
    return {"id": str(row.id), "position": row.position}


def action_update_step(user: User, body: JsonObject) -> JsonObject:
    row = owned_step(user, body.get("id"))
    fields = step_values(body, partial=True)
    for field, value in fields.items():
        setattr(row, field, value)
    if fields:
        row.save(update_fields=list(fields))
    return {"ok": True}


def action_delete_step(user: User, body: JsonObject) -> JsonObject:
    owned_step(user, body.get("stepId")).delete()
    return {"ok": True}


def action_reorder_steps(user: User, body: JsonObject) -> JsonObject:
    recipe = owned_cost_recipe(user, body.get("recipeId"))
    raw_ids = body.get("orderedStepIds")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ValueError("Step list is required")
    ids = [uuid_value(value) for value in raw_ids]
    existing = {row.id: row for row in recipe.steps.all()}
    if len(existing) != len(ids) or set(existing) != set(ids):
        raise ValueError("Step list is out of date — reload the page")
    with transaction.atomic():
        for position, step_id in enumerate(ids):
            row = existing[step_id]
            row.position = position
            row.save(update_fields=["position"])
    return {"ok": True}


def action_add_timing(user: User, body: JsonObject) -> JsonObject:
    step = owned_step(user, body.get("stepId"))
    seconds_value = int_value(body.get("seconds"), "Seconds", minimum=1, maximum=86400)
    yield_count = int_value(body.get("yieldCount"), "Yield", minimum=1, maximum=1000000)
    row = BenchCostTiming.objects.create(
        step=step, seconds=seconds_value, yield_count=yield_count
    )
    return {"id": str(row.id)}


def action_delete_timing(user: User, body: JsonObject) -> JsonObject:
    row = BenchCostTiming.objects.filter(
        step__recipe__user=user, id=uuid_value(body.get("timingId"))
    ).first()
    if row is None:
        raise ValueError("Timing not found")
    row.delete()
    return {"ok": True}


MAX_PASTE_ENTRIES = 200
MAX_PASTE_PREPARATIONS = 20


def _row_snapshot(row: Any, name: str) -> JsonObject:
    return {"id": str(row.id), "name": name, "updatedAt": iso(row.updated_at)}


def _recipe_snapshot(row: Recipe) -> JsonObject:
    return {
        "id": str(row.id),
        "body": row.body,
        "method": row.method,
        "updatedAt": iso(row.updated_at),
    }


def _paste_entries(body: JsonObject) -> list[JsonObject]:
    entries = body.get("ingredients")
    if not isinstance(entries, list) or len(entries) > MAX_PASTE_ENTRIES:
        raise ValueError("Paste ingredients look malformed")
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Paste ingredients look malformed")
        names = entry.get("preparations", [])
        if not isinstance(names, list) or len(names) > MAX_PASTE_PREPARATIONS:
            raise ValueError("Paste preparations look malformed")
    return entries


def action_commit_recipe_paste(user: User, body: JsonObject) -> JsonObject:
    """Write a reviewed paste: the ingredients it proposes, the preparations
    those lines ask for, the matches that keep the lines resolving, and the
    recipe text itself — all or nothing, with one receipt to undo it by."""
    recipe_id = uuid_value(body.get("recipeId"), "recipe id")
    text = text_value(
        body.get("body"), "Ingredients", max_length=200000, allow_blank=True
    )
    method = text_value(
        body.get("method"), "Method", max_length=200000, allow_blank=True
    )
    entries = _paste_entries(body)

    with transaction.atomic():
        # The same workspace lock the undo takes, so a second paste cannot land
        # rows in the middle of an undo's validate-then-restore.
        lock_workspace(user)
        recipe = (
            Recipe.objects.select_for_update().filter(user=user, id=recipe_id).first()
        )
        if recipe is None:
            raise ValueError("Recipe not found")
        paste = RecipePaste.objects.create(
            user=user,
            recipe=recipe,
            recipe_before=_recipe_snapshot(recipe),
            recipe_after={},
        )
        items: list[RecipePasteItem] = []
        ingredient_ids: dict[str, str] = {}

        def record(kind: str, row: Any, name: str) -> None:
            items.append(
                RecipePasteItem(
                    recipe_paste=paste,
                    position=len(items),
                    kind=kind,
                    row_after=_row_snapshot(row, name),
                )
            )

        for entry in entries:
            name = text_value(
                entry.get("name"), "Ingredient name", max_length=120
            ).strip()
            if not name:
                raise ValueError("Ingredient name is required")
            given_id = entry.get("ingredientId")
            if given_id is not None:
                ingredient = Ingredient.objects.filter(
                    user=user, id=uuid_value(given_id, "ingredient id")
                ).first()
                if ingredient is None:
                    raise ValueError("Ingredient not found")
            else:
                ingredient = Ingredient.objects.filter(
                    user=user, normalized_name=normalized_name(name)
                ).first()
                if ingredient is None:
                    # Priceless on purpose: the paste knows what the line names,
                    # never what it cost.
                    ingredient = Ingredient.objects.create(
                        user=user,
                        name=name,
                        purchase_cost_cents=0,
                        price_source=Ingredient.PriceSource.USER,
                    )
                    record(RecipePasteItem.Kind.INGREDIENT, ingredient, ingredient.name)
                    # The line keeps resolving after the pantry renames the row,
                    # the way a renamed component keeps its old title.
                    match, created = RecipeLineMatch.objects.get_or_create(
                        user=user,
                        normalized_text=normalized_name(name),
                        defaults={"text": name, "ingredient": ingredient},
                    )
                    if created:
                        record(RecipePasteItem.Kind.ALIAS, match, match.text)

            for measure in entry.get("measures", []):
                if not isinstance(measure, dict):
                    raise ValueError("Paste measures look malformed")
                unit = text_value(
                    measure.get("unit"), "Measure unit", max_length=32
                ).strip()
                if unit not in MEASURE_UNIT_VALUES:
                    raise ValueError("Unsupported measure unit")
                amount = number_value(
                    measure.get("amount"),
                    "Measure amount",
                    minimum=0.000001,
                    maximum=1000000,
                )
                grams = number_value(
                    measure.get("grams"),
                    "Measure weight",
                    minimum=0.000001,
                    maximum=float(MAX_INGREDIENT_MEASURE_VALUE),
                )
                assert amount is not None and grams is not None
                qualifier = normalized_name(
                    text_value(
                        measure.get("qualifier", ""),
                        "Measure qualifier",
                        max_length=120,
                        allow_blank=True,
                    )
                )
                # What the kitchen already says about this measure wins: a
                # paste states what one recipe wrote, not a correction.
                if IngredientMeasure.objects.filter(
                    ingredient=ingredient, unit=unit, qualifier=qualifier
                ).exists():
                    continue
                saved_measure = IngredientMeasure.objects.create(
                    ingredient=ingredient,
                    unit=unit,
                    amount=Decimal(str(amount)),
                    grams=Decimal(str(grams)),
                    qualifier=qualifier,
                )
                record(
                    RecipePasteItem.Kind.MEASURE,
                    saved_measure,
                    f"{amount} {unit}",
                )

            ingredient_ids[ingredient.normalized_name] = str(ingredient.id)
            for raw_name in entry.get("preparations", []):
                preparation_name = text_value(
                    raw_name, "Preparation name", max_length=120
                ).strip()
                if not preparation_name:
                    raise ValueError("Preparation name is required")
                if Preparation.objects.filter(
                    ingredient=ingredient,
                    normalized_name=normalized_name(preparation_name),
                ).exists():
                    continue
                yield_percent, source, confidence = seeded_preparation_yield(
                    ingredient, preparation_name
                )
                preparation = Preparation.objects.create(
                    user=user,
                    ingredient=ingredient,
                    name=preparation_name,
                    yield_percent=yield_percent,
                    source=source,
                    confidence=confidence,
                )
                record(RecipePasteItem.Kind.PREPARATION, preparation, preparation.name)

        RecipePasteItem.objects.bulk_create(items)

        recipe.body = text
        recipe.method = method
        recipe.save(update_fields=["body", "method", "updated_at"])

        counts = Counter(item.kind for item in items)
        paste.recipe_after = _recipe_snapshot(recipe)
        paste.line_count = sum(1 for line in text.splitlines() if line.strip())
        paste.ingredient_count = counts[RecipePasteItem.Kind.INGREDIENT]
        paste.preparation_count = counts[RecipePasteItem.Kind.PREPARATION]
        paste.alias_count = counts[RecipePasteItem.Kind.ALIAS]
        # This save stamps the watermark every changed-since guard below reads,
        # so it has to come last.
        paste.save(
            update_fields=[
                "recipe_after",
                "line_count",
                "ingredient_count",
                "preparation_count",
                "alias_count",
                "updated_at",
            ]
        )

    record_event(
        user,
        user,
        "import",
        "imported",
        resource_id=paste.id,
        name="Recipe paste",
        kind="recipePaste",
        lines=paste.line_count,
        ingredients=paste.ingredient_count,
        preparations=paste.preparation_count,
        matches=paste.alias_count,
    )
    return {
        "batchId": str(paste.id),
        "lines": paste.line_count,
        "ingredients": paste.ingredient_count,
        "preparations": paste.preparation_count,
        "matches": paste.alias_count,
        "measures": counts[RecipePasteItem.Kind.MEASURE],
        "ingredientIds": ingredient_ids,
    }


# What each created row is re-read as, how it is scoped to its owner, and how
# a change to it is refused. A measure belongs to its ingredient, so that is
# the relation the tenant check travels through.
PASTE_ROW_MODELS: dict[str, tuple[Any, str, str]] = {
    RecipePasteItem.Kind.INGREDIENT: (
        Ingredient,
        "user",
        "An ingredient changed after this paste; undo it manually",
    ),
    RecipePasteItem.Kind.PREPARATION: (
        Preparation,
        "user",
        "A preparation changed after this paste; undo it manually",
    ),
    RecipePasteItem.Kind.ALIAS: (
        RecipeLineMatch,
        "user",
        "An ingredient match changed after this paste; undo it manually",
    ),
    RecipePasteItem.Kind.MEASURE: (
        IngredientMeasure,
        "ingredient__user",
        "A saved measure changed after this paste; undo it manually",
    ),
}


def action_undo_recipe_paste(user: User, body: JsonObject) -> JsonObject:
    paste_id = uuid_value(body.get("id"), "paste id")
    # Validation and mutation share one transaction: split, another request
    # could edit a row between the timestamp check and the delete, and the undo
    # would destroy the change the guard was meant to refuse.
    with transaction.atomic():
        lock_workspace(user)

        paste = (
            RecipePaste.objects.select_for_update()
            .filter(user=user, id=paste_id, undone_at__isnull=True)
            .first()
        )
        if paste is None:
            raise ValueError("Paste not found or already undone")
        # Latest by Meta.ordering. The recipe-paste stack is its own: a paste
        # and a supplier import do not order against each other.
        latest = RecipePaste.objects.filter(user=user, undone_at__isnull=True).first()
        if latest is None or latest.id != paste.id:
            raise ValueError("Undo newer pastes first")

        recipe = (
            Recipe.objects.select_for_update()
            .filter(user=user, id=paste.recipe_id)
            .first()
        )
        if recipe is None or recipe.updated_at > paste.updated_at:
            raise ValueError("The recipe changed after this paste; undo it manually")

        # What the rest of the library names. A recipe line references an
        # ingredient as text, so a recipe that started relying on a pasted row
        # leaves no relation for the sweeps below to find.
        # A line may name the ingredient through a saved match,
        # so "yellow onion" has to resolve to onion before anything is compared.
        match_targets = dict(
            RecipeLineMatch.objects.filter(
                user=user, ingredient__isnull=False
            ).values_list("normalized_text", "ingredient__normalized_name")
        )
        used_identities: set[str] = set()
        used_preparations: set[tuple[str, str]] = set()
        for other_body in (
            Recipe.objects.filter(user=user)
            .exclude(id=paste.recipe_id)
            .values_list("body", flat=True)
        ):
            names, qualified = named_identities(other_body)
            used_identities |= {match_targets.get(name, name) for name in names}
            used_preparations |= {
                (match_targets.get(name, name), qualifier)
                for name, qualifier in qualified
            }

        items = list(paste.items.all())
        rows: list[tuple[str, Any]] = []
        for item in items:
            model, owner_field, message = PASTE_ROW_MODELS[item.kind]
            row = (
                model.objects.select_for_update()
                .filter(
                    **{owner_field: user},
                    id=uuid_value(item.row_after["id"], "row id"),
                )
                .first()
            )
            # A row already gone is a paste effect already reversed; a row that
            # moved on is work this undo must not destroy.
            if row is not None:
                if row.updated_at > paste.updated_at:
                    raise ValueError(message)
                rows.append((item.kind, row))

        deleted_preparations = 0
        retained_preparations = 0
        deleted_matches = 0
        deleted_measures = 0
        created_ingredients = []
        for kind, row in rows:
            if kind == RecipePasteItem.Kind.MEASURE:
                # Swept before the ingredients: a measure this paste wrote is
                # not work someone else did on the ingredient afterwards.
                row.delete()
                deleted_measures += 1
            elif kind == RecipePasteItem.Kind.ALIAS:
                row.delete()
                deleted_matches += 1
            elif kind == RecipePasteItem.Kind.PREPARATION:
                if (
                    row.ingredient.normalized_name,
                    row.normalized_name,
                ) in used_preparations:
                    retained_preparations += 1
                    continue
                row.delete()
                deleted_preparations += 1
            else:
                created_ingredients.append(row)

        # Swept last, so the paste's own match and preparation no longer count
        # as work someone did on the ingredient afterwards.
        deleted_ingredients = 0
        retained_ingredients = 0
        for row in created_ingredients:
            if (
                row.normalized_name in used_identities
                or row.supplier_items.exists()
                or RecipeLineMatch.objects.filter(user=user, ingredient=row).exists()
                or row.recipe_items.filter(recipe__user=user).exists()
                or row.measures.exists()
                or row.preparations.exists()
                or IngredientConversion.objects.filter(ingredient=row).exists()
                or row.nutrition_per_100g is not None
            ):
                retained_ingredients += 1
                continue
            try:
                row.delete()
            except RestrictedError as exc:
                raise ValueError(
                    "An ingredient became used while the paste was being undone. "
                    "Try again."
                ) from exc
            deleted_ingredients += 1

        recipe.body = paste.recipe_before["body"]
        recipe.method = paste.recipe_before["method"]
        recipe.save(update_fields=["body", "method", "updated_at"])
        # auto_now has just moved updated_at forward; putting it back is what
        # keeps the next undo's changed-since guard honest.
        restored_updated_at = datetime.fromisoformat(paste.recipe_before["updatedAt"])
        Recipe.objects.filter(id=recipe.id).update(updated_at=restored_updated_at)

        paste.undone_at = timezone.now()
        paste.save(update_fields=["undone_at", "updated_at"])

    return {
        "ok": True,
        "deletedIngredients": deleted_ingredients,
        "retainedIngredients": retained_ingredients,
        "deletedPreparations": deleted_preparations,
        "retainedPreparations": retained_preparations,
        "deletedMatches": deleted_matches,
        "deletedMeasures": deleted_measures,
    }


def action_save_recipe_line_match(user: User, body: JsonObject) -> JsonObject:
    """Persist the reviewed identity for a recipe line.

    Targets are always looked up through the current user before the match is
    written.
    """
    line = text_value(body.get("line"), "Recipe line", max_length=200).strip()
    if not line:
        raise ValueError("Recipe line is required")
    target_kind = body.get("targetKind")
    target_id = body.get("targetId")
    if target_kind not in {"ingredient", "recipe"}:
        raise ValueError("Invalid match target")
    if target_id is None:
        raise ValueError("A match target is required")
    ingredient_id = target_id if target_kind == "ingredient" else None
    recipe_id = target_id if target_kind == "recipe" else None
    ingredient = None
    recipe = None
    if ingredient_id is not None:
        ingredient = Ingredient.objects.filter(
            user=user, id=uuid_value(ingredient_id, "ingredient id")
        ).first()
        if ingredient is None:
            raise ValueError("Ingredient not found")
    if recipe_id is not None:
        recipe = Recipe.objects.filter(
            user=user, id=uuid_value(recipe_id, "recipe id")
        ).first()
        if recipe is None:
            raise ValueError("Recipe not found")
        if recipe.kind != Recipe.KIND_COMPONENT:
            raise ValueError("Only component recipes can be matched")
    if ingredient is None and recipe is None:
        raise ValueError("A match target is required")
    if ingredient is not None and recipe is not None:
        raise ValueError("A match can have only one target")
    save_line_match(
        user=user,
        line=line,
        ingredient=ingredient,
        component_recipe=recipe,
    )
    return {
        "ok": True,
        "line": normalized_name(line),
        "targetId": str(ingredient.id if ingredient is not None else recipe.id),
        "targetKind": "ingredient" if ingredient is not None else "recipe",
    }


MENU_ITEM_LIMIT = 500


def _menu_period(body: JsonObject) -> tuple[date | None, date | None]:
    start = import_date_value(body.get("periodStart"), "Period start")
    end = import_date_value(body.get("periodEnd"), "Period end")
    if (start is None) != (end is None):
        raise ValueError("Period needs a start and an end")
    if start is not None and start > end:
        raise ValueError("Period start must be on or before period end")
    if start is not None and (end - start).days > 365:
        raise ValueError("Period can cover at most a year")
    return start, end


def _menu_rows(body: JsonObject) -> list[JsonObject]:
    items = body.get("items")
    if not isinstance(items, list):
        raise ValueError("Menu items must be a list")
    if len(items) > MENU_ITEM_LIMIT:
        raise ValueError(f"A menu can hold at most {MENU_ITEM_LIMIT} rows")
    rows: list[JsonObject] = []
    seen_rows: set = set()
    seen_links: set = set()
    for entry in items:
        if not isinstance(entry, dict):
            raise ValueError("Menu row must be an object")
        if "components" in entry:
            raise ValueError("A menu item is a recipe or a product, not a composition")
        row_id = uuid_value(entry.get("id"), "menu row id") if entry.get("id") else None
        product_id = (
            uuid_value(entry.get("productId"), "product id")
            if entry.get("productId")
            else None
        )
        recipe_id = (
            uuid_value(entry.get("recipeId"), "recipe id")
            if entry.get("recipeId")
            else None
        )
        if product_id is not None and recipe_id is not None:
            raise ValueError("A menu item is a recipe or a product, not both")
        # An unlinked row is a plain named line, waiting for a link.
        name = ""
        if product_id is None and recipe_id is None:
            name = text_value(
                entry.get("name") or "", "Item name", max_length=200, allow_blank=True
            )
            if not name:
                raise ValueError("Name every item")
        quantity = _decimal(entry.get("qtySold"), "Quantity sold", nullable=False)
        if quantity > 1000000:
            raise ValueError("Quantity sold is outside the allowed range")
        if row_id is not None:
            if row_id in seen_rows:
                raise ValueError("Menu row listed twice")
            seen_rows.add(row_id)
        link = product_id or recipe_id
        if link is not None:
            if link in seen_links:
                raise ValueError(
                    "Product listed twice" if product_id else "Recipe listed twice"
                )
            seen_links.add(link)
        rows.append(
            {
                "id": row_id,
                "name": name,
                "sellPriceCents": int_value(
                    entry.get("sellPriceCents"),
                    "Sell price",
                    minimum=0,
                    maximum=MONEY_CENTS_LIMIT,
                ),
                "qtySold": quantity.quantize(Decimal("0.001")),
                "productId": product_id,
                "recipeId": recipe_id,
            }
        )
    return rows


def action_save_menu(user: User, body: JsonObject) -> JsonObject:
    menu = None
    if body.get("id"):
        menu = Menu.objects.filter(user=user, id=uuid_value(body["id"])).first()
        if menu is None:
            raise ValueError("Menu not found")
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
    name = text_value(body.get("name"), "Menu name", max_length=120)
    period_start, period_end = _menu_period(body)
    rebaseline = bool_value(body.get("rebaseline", False), "Rebaseline")
    rows = _menu_rows(body)

    products = SalesProduct.objects.filter(
        user=user, id__in={row["productId"] for row in rows if row["productId"]}
    ).in_bulk()
    recipes = (
        Recipe.objects.filter(
            user=user, id__in={row["recipeId"] for row in rows if row["recipeId"]}
        )
        .select_related("category")
        .in_bulk()
    )
    for row in rows:
        if row["productId"] is not None and row["productId"] not in products:
            raise ValueError("Product not found")
        if row["recipeId"] is not None and row["recipeId"] not in recipes:
            raise ValueError("Recipe not found")

    existing = (
        {row.id: row for row in MenuItem.objects.filter(menu=menu)} if menu else {}
    )
    for row in rows:
        if row["id"] is not None and row["id"] not in existing:
            raise ValueError("Menu row not found")

    # The detail payload this returns needs the dashboard model anyway, so the
    # snapshots are costed out of that one model rather than a second.
    model = RecipeHealthReadModel(user, dashboard=True)
    recipe_costs = {
        row["id"]: row["ingredientCents"] for row in menu_recipe_rows(model)
    }
    index = BundleIndex.for_user(user)

    with transaction.atomic():
        added = menu is None
        if menu is None:
            menu = Menu(user=user, name=name)
        else:
            menu = Menu.objects.select_for_update().get(pk=menu.pk)
            check_and_bump(menu, expected)
        menu.name = name
        menu.period_start = period_start
        menu.period_end = period_end
        menu.save()
        kept: list[MenuItem] = []
        created: list[MenuItem] = []
        for position, row in enumerate(rows):
            if row["id"] is not None:
                item = existing[row["id"]]
                kept.append(item)
            else:
                item = MenuItem(
                    menu=menu,
                    original_sell_price_cents=row["sellPriceCents"],
                    original_qty_sold=row["qtySold"],
                )
                created.append(item)
            item.position = position
            item.sell_price_cents = row["sellPriceCents"]
            item.qty_sold = row["qtySold"]
            item.product_id = row["productId"]
            item.recipe_id = row["recipeId"]
            # The name and category columns follow the link so lists and
            # exports keep reading them; the worksheet reads the link itself.
            if row["productId"]:
                product = products[row["productId"]]
                item.name, item.category = product.name, product.category
            elif row["recipeId"]:
                recipe = recipes[row["recipeId"]]
                item.name = recipe.title
                item.category = recipe.category.name if recipe.category_id else ""
            else:
                item.name, item.category = row["name"], ""
            if rebaseline or row["id"] is None:
                item.original_sell_price_cents = row["sellPriceCents"]
                item.original_qty_sold = row["qtySold"]
                item.original_food_cost_cents = menu_item_cost_cents(
                    item, recipe_costs=recipe_costs, index=index
                )
        if kept:
            fields = [
                "position",
                "name",
                "category",
                "sell_price_cents",
                "qty_sold",
                "product",
                "recipe",
            ]
            if rebaseline:
                fields += [
                    "original_sell_price_cents",
                    "original_qty_sold",
                    "original_food_cost_cents",
                ]
            MenuItem.objects.bulk_update(kept, fields)
        if created:
            MenuItem.objects.bulk_create(created)
        stale = set(existing) - {row["id"] for row in rows if row["id"] is not None}
        if stale:
            MenuItem.objects.filter(menu=menu, id__in=stale).delete()
    record_event(
        user,
        user,
        "menu",
        "added" if added else "edited",
        resource_id=menu.id,
        name=menu.name,
        publicId=menu.public_id,
    )
    return menu_detail_payload(user, menu, model=model)


def action_delete_menu(user: User, body: JsonObject) -> JsonObject:
    row = Menu.objects.filter(user=user, id=uuid_value(body.get("id"))).first()
    if row is None:
        raise ValueError("Menu not found")
    row.delete()
    record_event(user, user, "menu", "deleted", resource_id=row.id, name=row.name)
    return {"ok": True}


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "save-recipe": action_save_recipe,
    "delete-recipe": action_delete_recipe,
    "update-recipe-statuses": action_update_recipe_statuses,
    "update-recipe-costing": action_update_recipe_costing,
    "set-recipe-nutrition-serving": action_set_recipe_nutrition_serving,
    "set-recipe-item-yield-after-cooking": action_set_recipe_item_yield_after_cooking,
    "set-recipe-item-excluded-from-cost": action_set_recipe_item_excluded_from_cost,
    "save-recipe-external-ref": action_save_recipe_external_ref,
    "delete-recipe-external-ref": action_delete_recipe_external_ref,
    "rename-recipe-category": action_rename_recipe_category,
    "delete-recipe-category": action_delete_recipe_category,
    "open-cost-for-recipe": action_open_cost_for_recipe,
    "create-step": action_create_step,
    "update-step": action_update_step,
    "delete-step": action_delete_step,
    "reorder-steps": action_reorder_steps,
    "add-timing": action_add_timing,
    "delete-timing": action_delete_timing,
    "commit-recipe-paste": action_commit_recipe_paste,
    "undo-recipe-paste": action_undo_recipe_paste,
    "save-recipe-line-match": action_save_recipe_line_match,
    "share-recipe": action_share_recipe,
    "share-recipes": action_share_recipes,
    "update-recipe-share": action_update_recipe_share,
    "remove-recipe-share": action_remove_recipe_share,
    "remove-recipe-guest-link": action_remove_recipe_guest_link,
    "remove-recipe-book": action_remove_recipe_book,
    "save-recipe-comment": action_save_recipe_comment,
    "delete-recipe-comment": action_delete_recipe_comment,
    "save-menu": action_save_menu,
    "delete-menu": action_delete_menu,
}
