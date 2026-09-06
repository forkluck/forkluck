import hashlib
import json
import math
import re
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Callable, Collection, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from functools import cached_property
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import IntegrityError, transaction
from django.db.models import (
    Case,
    Count,
    DecimalField,
    Exists,
    ExpressionWrapper,
    F,
    Func,
    IntegerField,
    Max,
    Min,
    OuterRef,
    Q,
    QuerySet,
    Sum,
    Value,
    When,
)
from django.db.models.functions import (
    Coalesce,
    ExtractHour,
    Lower,
    TruncDate,
)
from django.utils import timezone

from ..shared.locking import lock_workspace
from ..shared.localtime import resolve_local
from ..shared.pagination import BrowseQuery, paginate, paginated_payload
from ..shared.physical_expansion import (
    EquivalencyBasis,
    ExpansionIssue,
    Measure,
    PreparationBasis,
    PurchaseBasis,
    RecipeLine,
    RecipeNode,
    expand_recipe,
    issue_json as _cost_issue_json,
    purchase_quantity,
)
from ..shared.periods import trend_comparison_window
from ..shared.values import (
    bool_value,
    group_key_part,
    int_value,
    number_value,
    signed_cents,
    text_value,
    uuid_value,
)
from ..shared.vocabulary import unit_slugs
from ..shared.workspace_currency import workspace_currency_code
from ..shared.workspace_timezone import known_zone, workspace_timezone_name, workspace_zone
from ..shared.versioning import StaleWriteError
from ...models import (
    BenchCostSettings,
    Ingredient,
    Invoice,
    Recipe,
    RecipeItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesIgnoreRule,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesCatalogItem,
    SalesModifierList,
    SalesModifierOption,
    SalesProduct,
    SalesProductComponent,
    SalesProductSku,
    SalesSkuIgnore,
    SyncRun,
    TimeEntry,
    User,
)
from ..shared.density import grams_for
from . import bundles
from .bundles import allocate_cents_by_weight
from ...units import (
    MILLILITERS_PER_UNIT,
    PRODUCT_UNIT_VALUES,
    unit_family,
    unit_ratio,
)


JsonObject = dict[str, Any]
PROVIDER_CHANNELS = frozenset(
    {SalesImport.Channel.SQUARE, SalesImport.Channel.SHOPIFY}
)
LEDGER_CHANNELS = frozenset((*PROVIDER_CHANNELS, SalesImport.Channel.MANUAL))
# Provider-facing parser and matcher callers intentionally never accept the
# manual ledger source as an external channel.
VALID_CHANNELS = PROVIDER_CHANNELS

# Review renders at most this many identity rows per (channel, category).
# `unmatched_group_rows` orders by revenue, so the kept prefix is the top-N
# the merchant would want acted on first.
REVIEW_RENDER_CAP = 200
VALID_IMPORT_DECISIONS = {"track", "ignore", "pending"}
MAX_VARIANT_MULTIPLIER = Decimal("1000000")


def variant_multiplier(value: Any) -> Decimal:
    result = decimal_value(
        value,
        "Units per sale",
        minimum=Decimal("-1000000"),
        maximum=MAX_VARIANT_MULTIPLIER,
    )
    if result <= 0:
        raise ValueError("Units per sale must be above zero")
    return result


ATTRIBUTION_ABSENT = object()


def attribution_value(value: Any) -> int | None:
    """Read the share of a sale that belongs to the variant's products.

    Absent or null is the default, which every reader treats as the whole
    line.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Attribution must be a whole percent")
    if value != int(value):
        raise ValueError("Attribution must be a whole percent")
    percent = int(value)
    if not 0 <= percent <= 100:
        raise ValueError("Attribution must be between 0 and 100 percent")
    return percent


def normalized_name(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def sales_group_key(sku: str, item_name: str, external_variant_title: str) -> str:
    if sku.strip():
        return f"sku:{group_key_part(sku)}"[:500]
    return f"name:{group_key_part(item_name)}|{group_key_part(external_variant_title)}"[:500]


IGNORE_RULE_MAX_CONDITIONS = 5
IGNORE_RULE_MAX_VALUE = 200
IGNORE_RULE_MAX_PER_USER = 25
# One sweep writes at most this many rows, so a rule nobody previewed cannot
# turn a sync into an unbounded insert.
IGNORE_RULE_SWEEP_CAP = 5000


@dataclass(frozen=True)
class IgnoreCandidate:
    """One pending identity, in the shape a rule condition reads."""

    channel: str
    provider_account_id: str
    match_key: str
    sku: str
    item_name: str
    external_variant_title: str


def _candidate_haystack(condition_field: str, candidate: IgnoreCandidate) -> str:
    if condition_field == SalesIgnoreRule.Field.SKU:
        return group_key_part(candidate.sku)
    if condition_field == SalesIgnoreRule.Field.TITLE:
        return group_key_part(candidate.item_name)
    return group_key_part(candidate.external_variant_title)


def rule_matches(conditions: Any, candidate: IgnoreCandidate) -> bool:
    """Whether every condition holds for this identity.

    Both sides pass through `group_key_part`, so matching folds case and
    collapses the same whitespace the identity's own `match_key` collapsed.
    That is why this is Python rather than an `icontains` filter: no SQL LIKE
    reproduces that normalization, and SQLite folds only ASCII where PostgreSQL
    folds Unicode — a rule would then mean two different things in dev and
    production.

    A malformed condition never matches rather than raising: the JSON column
    has no database-level shape, so one bad row must be inert instead of able
    to fail every sync in the workspace.
    """
    if not isinstance(conditions, list) or not conditions:
        return False
    for condition in conditions:
        if not isinstance(condition, dict):
            return False
        field_name = condition.get("field")
        operator = condition.get("operator")
        needle = group_key_part(str(condition.get("value") or ""))
        if not needle or field_name not in SalesIgnoreRule.Field.values:
            return False
        haystack = _candidate_haystack(field_name, candidate)
        if operator == SalesIgnoreRule.Operator.IS:
            if haystack != needle:
                return False
        elif operator == SalesIgnoreRule.Operator.STARTS_WITH:
            if not haystack.startswith(needle):
                return False
        elif operator == SalesIgnoreRule.Operator.CONTAINS:
            if needle not in haystack:
                return False
        else:
            return False
    return True


def parse_ignore_rule_conditions(raw: Any) -> list[JsonObject]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("A rule needs at least one condition")
    if len(raw) > IGNORE_RULE_MAX_CONDITIONS:
        raise ValueError(
            f"A rule can have at most {IGNORE_RULE_MAX_CONDITIONS} conditions"
        )
    conditions: list[JsonObject] = []
    seen: set[tuple[str, str, str]] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("Condition looks malformed")
        field_name = text_value(entry.get("field"), "Condition field", max_length=16)
        if field_name not in SalesIgnoreRule.Field.values:
            raise ValueError("Condition field is not supported")
        operator = text_value(
            entry.get("operator"), "Condition operator", max_length=16
        )
        if operator not in SalesIgnoreRule.Operator.values:
            raise ValueError("Condition operator is not supported")
        # A blank value would match every product on the channel, so it is
        # refused at the boundary rather than swept and undone later.
        value = text_value(
            entry.get("value"), "Condition value", max_length=IGNORE_RULE_MAX_VALUE
        )
        signature = (field_name, operator, group_key_part(value))
        if signature in seen:
            raise ValueError("A rule cannot repeat the same condition")
        seen.add(signature)
        conditions.append(
            {"field": field_name, "operator": operator, "value": value}
        )
    return conditions


def ignore_rule_signature(conditions: Iterable[JsonObject]) -> frozenset[tuple[str, str, str]]:
    return frozenset(
        (
            condition["field"],
            condition["operator"],
            group_key_part(condition["value"]),
        )
        for condition in conditions
    )


def base_name_key(item_name: str) -> str:
    """The variant-insensitive form of a `name:` key.

    A SKU-less product reaches us with its variant filled in on the API path
    (Square variation_name / Shopify variantTitle) and empty on parts of the
    CSV path, so the same external identity would otherwise mint two keys that
    never meet. Stored keys are never rewritten — this is the compat form both
    paths resolve THROUGH (see `resolve_item_variant`).
    """
    return f"name:{group_key_part(item_name)}|"[:500]


def decimal_value(
    value: Any,
    label: str,
    *,
    minimum: Decimal,
    maximum: Decimal,
) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if not result.is_finite() or result < minimum or result > maximum:
        raise ValueError(f"{label} is outside the allowed range")
    return result.quantize(Decimal("0.001"))


def sales_timezone(value: Any) -> ZoneInfo:
    name = text_value(value, "Timezone", max_length=64)
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Timezone is not recognized") from exc


def sales_datetime(value: Any, zone: ZoneInfo) -> datetime:
    raw = text_value(value, "Sale date", max_length=40)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Sale date is invalid") from exc
    if parsed.tzinfo is not None:
        # The fingerprint and the database both read this in UTC, and a value
        # within a day of year 1 or 9999 overflows there; reject it as a
        # fixable value rather than let the action funnel return a 500.
        try:
            parsed.astimezone(ZoneInfo("UTC"))
        except OverflowError as exc:
            raise ValueError("Sale date is outside the supported date range") from exc
        return parsed
    return resolve_local(parsed, zone, "Sale date")


def safe_source_payload(value: Any) -> JsonObject:
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError("Source row looks malformed")
    result: JsonObject = {}
    for key, cell_value in value.items():
        if not isinstance(key, str) or not isinstance(cell_value, str):
            raise ValueError("Source row looks malformed")
        if len(key) > 200 or len(cell_value) > 2000:
            raise ValueError("Source row is too large")
        result[key] = cell_value
    return result


def sales_import_json(row: SalesImport, *, can_undo: bool = False) -> JsonObject:
    return {
        "id": str(row.id),
        "fileName": row.file_name,
        "channel": row.channel,
        "providerAccountId": row.provider_account_id,
        "source": row.source,
        "timezone": row.timezone,
        "currencyCode": row.currency_code,
        "periodStart": row.period_start.isoformat() if row.period_start else None,
        "periodEnd": row.period_end.isoformat() if row.period_end else None,
        "totalRows": row.total_rows,
        "importedCount": row.imported_count,
        "duplicateCount": row.duplicate_count,
        "skippedCount": row.skipped_count,
        "ignoredCount": row.ignored_count,
        "orderCount": row.order_count,
        "grossCents": row.gross_cents,
        "discountCents": row.discount_cents,
        "netSalesCents": row.net_sales_cents,
        "taxCents": row.tax_cents,
        "refundCents": row.refund_cents,
        "createdAt": row.created_at.isoformat(),
        "undoneAt": row.undone_at.isoformat() if row.undone_at else None,
        "canUndo": can_undo,
    }


EMPTY_PRODUCT_SALES: JsonObject = {
    "lineCount": 0,
    "quantity": 0,
    "totalQuantity": 0,
    "grossCents": 0,
    "discountCents": 0,
    "netSalesCents": 0,
    "attributedNetSalesCents": 0,
    "taxCents": 0,
    "refundCents": 0,
    # A bundle row in an expanded view: its units are its own, its money has
    # moved to the products inside it. Zero rather than null, because every
    # money column has to keep summing to net revenue.
    "sharedToMembers": False,
    "asSoldNetSalesCents": 0,
    # Which rung of the value ladder split this bundle: null on a product
    # that is not one.
    "splitBasis": None,
}


def variant_json(row: SalesProductVariant) -> JsonObject:
    return {
        "id": str(row.id),
        "sku": row.sku,
        "matchKey": row.match_key,
        "channel": row.channel,
        "providerAccountId": row.provider_account_id,
        "externalName": row.external_name,
        "externalVariantTitle": row.external_variant_title,
        "identityKind": row.identity_kind,
        "externalObjectId": row.external_object_id,
        "productExternalObjectId": row.product_external_object_id,
        "quantityMultiplier": float(row.quantity_multiplier),
        "attributionPercent": row.attribution_percent,
    }


def product_json(row: SalesProduct, stats: JsonObject | None = None) -> JsonObject:
    components = list(row.components.all())
    component_rows = [
        {
            "id": str(component.id),
            "recipeId": str(component.recipe_id) if component.recipe_id else None,
            "recipePublicId": (
                component.recipe.public_id if component.recipe_id else None
            ),
            "recipeName": component.recipe.title if component.recipe_id else None,
            "ingredientId": (
                str(component.ingredient_id) if component.ingredient_id else None
            ),
            "ingredientPublicId": (
                component.ingredient.public_id if component.ingredient_id else None
            ),
            "ingredientName": (
                component.ingredient.name if component.ingredient_id else None
            ),
            "productId": (
                str(component.component_product_id)
                if component.component_product_id
                else None
            ),
            "productPublicId": (
                component.component_product.public_id
                if component.component_product_id
                else None
            ),
            "productName": (
                component.component_product.name
                if component.component_product_id
                else None
            ),
            "quantity": float(component.quantity),
            "unit": component.unit,
            "position": component.position,
            "nonEdible": (
                component.ingredient.non_edible if component.ingredient_id else False
            ),
        }
        for component in components
    ]
    # Keep this read-only alias for `menu-item-dialog.tsx` until it consumes
    # the canonical composition rows.  Writes use `components` when present.
    recipe_links = [
        {
            "recipeId": component["recipeId"],
            "publicId": component["recipePublicId"],
            "recipeTitle": component["recipeName"],
            "quantity": component["quantity"],
        }
        for component in component_rows
        if component["recipeId"] is not None
    ]
    costed = bool(component_rows)
    # The hidden first-party manual variant is an interpretation anchor, not
    # a provider/catalog mapping a merchant can edit or review.
    direct_variants = [
        variant for variant in row.variants.all() if not _is_system_manual_variant(variant)
    ]
    return {
        "id": str(row.id),
        "publicId": row.public_id,
        "editVersion": row.edit_version,
        "name": row.name,
        "normalizedName": row.normalized_name,
        "sku": row.sku,
        "skus": [
            {
                "id": str(sku.id),
                "sku": sku.sku,
                "quantityMultiplier": float(sku.quantity_multiplier),
                "position": sku.position,
            }
            for sku in row.skus.all()
        ],
        "description": row.description,
        "sellPriceCents": row.sell_price_cents,
        "baseUnit": row.base_unit,
        "category": row.category,
        "isActive": row.is_active,
        "costed": costed,
        "components": component_rows,
        "recipeLinks": recipe_links,
        "variants": [variant_json(variant) for variant in direct_variants],
        "sales": stats or dict(EMPTY_PRODUCT_SALES),
        "createdAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
    }


def _conversion_measures(conversion: Any) -> tuple[Measure, ...]:
    if conversion is None or conversion.average_weight:
        return ()
    return tuple(
        Measure(float(amount), unit)
        for amount, unit in (
            (conversion.weight_amount, conversion.weight_unit),
            (conversion.volume_amount, conversion.volume_unit),
            (conversion.each_amount, conversion.each_unit),
        )
        if amount is not None and float(amount) > 0 and unit
    )


def _ingredient_purchase_basis(ingredient: Ingredient) -> PurchaseBasis:
    try:
        conversion = ingredient.conversion
    except AttributeError:
        conversion = None
    return PurchaseBasis(
        purchase_size=(
            float(ingredient.purchase_size)
            if ingredient.purchase_size is not None
            else None
        ),
        purchase_unit=ingredient.purchase_unit,
        yield_percent=(
            float(ingredient.yield_percent)
            if ingredient.yield_percent is not None
            else None
        ),
        conversion=_conversion_measures(conversion),
        conversion_is_automatic=conversion is None or conversion.average_weight,
    )


def _standard_density_bridge(
    source_unit: str, target_unit: str, ingredient: Ingredient
) -> float | None:
    """Return target units per source unit for the shared density estimate."""
    source_family = unit_family(source_unit)
    target_family = unit_family(target_unit)
    if {source_family, target_family} != {"mass", "volume"}:
        return None
    cup_ml = MILLILITERS_PER_UNIT.get("cup")
    if cup_ml is None:
        return None
    grams_per_cup = grams_for(cup_ml, ingredient.name)
    if grams_per_cup is None or grams_per_cup <= 0:
        return None
    grams_per_ml = grams_per_cup / cup_ml
    if source_family == "mass":
        source_grams = unit_ratio(source_unit, "g")
        target_ml = unit_ratio("ml", target_unit)
        if source_grams is None or target_ml is None:
            return None
        return source_grams / grams_per_ml * target_ml
    source_ml = unit_ratio(source_unit, "ml")
    target_grams = unit_ratio("g", target_unit)
    if source_ml is None or target_grams is None:
        return None
    return source_ml * grams_per_ml * target_grams


def _preparation_basis(item: RecipeItem) -> PreparationBasis | None:
    note = group_key_part(item.preparation_note)
    if not note or item.ingredient_id is None:
        return None
    try:
        preparations = item.ingredient.preparations.all()
    except AttributeError:
        return None
    for preparation in preparations:
        if group_key_part(preparation.name) != note:
            continue
        return PreparationBasis(
            yield_percent=(
                float(preparation.yield_percent)
                if preparation.yield_percent is not None
                else None
            ),
            conversion=_conversion_measures(preparation),
            conversion_is_automatic=preparation.average_weight,
        )
    return None


def _recipe_equivalency(recipe: Recipe) -> EquivalencyBasis | None:
    try:
        equivalency = recipe.equivalency
    except AttributeError:
        return None
    return EquivalencyBasis(
        mass=(
            Measure(float(equivalency.mass_amount), equivalency.mass_unit)
            if equivalency.mass_amount is not None and equivalency.mass_unit
            else None
        ),
        volume=(
            Measure(float(equivalency.volume_amount), equivalency.volume_unit)
            if equivalency.volume_amount is not None and equivalency.volume_unit
            else None
        ),
        count=(
            Measure(float(equivalency.count_amount), equivalency.count_unit)
            if equivalency.count_amount is not None and equivalency.count_unit
            else None
        ),
        standard=bool(equivalency.standard),
    )


def _product_recipe_nodes(
    user: User, roots: Iterable[Recipe], direct_ingredients: Iterable[Ingredient]
) -> tuple[dict[str, RecipeNode], dict[str, Ingredient]]:
    """Load a recipe graph once and adapt it to the shared cost traversal."""
    root_ids = {str(recipe.id) for recipe in roots}
    seen = set(root_ids)
    items_by_recipe: dict[str, list[RecipeItem]] = {}
    ingredients: dict[str, Ingredient] = {
        str(ingredient.id): ingredient for ingredient in direct_ingredients
    }
    if root_ids:
        children_by_recipe: defaultdict[str, set[str]] = defaultdict(set)
        for recipe_id, child_id in RecipeItem.objects.filter(
            recipe__user=user,
            subrecipe__isnull=False,
        ).values_list("recipe_id", "subrecipe_id"):
            children_by_recipe[str(recipe_id)].add(str(child_id))
        pending = set(root_ids)
        while pending:
            children = {
                child_id
                for recipe_id in pending
                for child_id in children_by_recipe.get(recipe_id, ())
            }
            pending = children - seen
            seen.update(pending)
        rows = list(
            RecipeItem.objects.filter(
                recipe_id__in=seen, recipe__user=user
            )
            .select_related("ingredient", "subrecipe")
            .prefetch_related("ingredient__conversion", "ingredient__preparations")
        )
        for item in rows:
            recipe_key = str(item.recipe_id)
            items_by_recipe.setdefault(recipe_key, []).append(item)
            if item.ingredient_id and item.ingredient is not None:
                ingredients[str(item.ingredient_id)] = item.ingredient

    recipe_ids = seen
    recipes = {
        str(recipe.id): recipe
        for recipe in Recipe.objects.filter(user=user, id__in=recipe_ids).prefetch_related(
            "equivalency"
        )
    }
    nodes: dict[str, RecipeNode] = {}
    for recipe_key, recipe in recipes.items():
        lines = []
        for item in items_by_recipe.get(recipe_key, []):
            if item.kind in {RecipeItem.HEADER, RecipeItem.NOTE}:
                continue
            lines.append(
                RecipeLine(
                    id=str(item.id),
                    quantity=(
                        float(item.quantity) if item.quantity is not None else None
                    ),
                    unit=item.unit or None,
                    ingredient_key=(
                        str(item.ingredient_id) if item.ingredient_id else None
                    ),
                    recipe_key=(
                        str(item.subrecipe_id) if item.subrecipe_id else None
                    ),
                    efficiency=(
                        float(item.efficiency) if item.efficiency is not None else None
                    ),
                    excluded_from_cost=bool(item.excluded_from_cost),
                    preparation=_preparation_basis(item),
                )
            )
        nodes[recipe_key] = RecipeNode(
            id=recipe_key,
            yield_amount=(
                float(recipe.yield_amount)
                if recipe.yield_amount is not None
                else None
            ),
            yield_unit=recipe.yield_unit or None,
            equivalency=_recipe_equivalency(recipe),
            lines=tuple(lines),
        )
    return nodes, ingredients


@dataclass(frozen=True)
class ProductCost:
    """A product's composition cost, and why it could not be resolved.

    ``cents`` is None exactly when ``issues`` is non-empty: a cost this app
    cannot stand behind is never a number, and never a silent zero. The issues
    keep the reason the expansion already knew, so the merchant is told which
    ingredient is missing a price rather than only that a cost is missing.
    """

    cents: int | None
    issues: tuple[ExpansionIssue, ...] = ()


def _recipe_unit_cost(
    recipe: Recipe,
    nodes: dict[str, RecipeNode],
    ingredients: dict[str, Ingredient],
) -> tuple[float | None, tuple[ExpansionIssue, ...]]:
    """Return one batch's cost, or None with the issues that stopped it."""
    root = nodes.get(str(recipe.id))
    if root is None:
        # No path: the caller prefixes the recipe's title, and an id would
        # put a raw uuid in front of the merchant.
        return None, (ExpansionIssue("missing-recipe"),)

    def resolve_ingredient(key: str) -> PurchaseBasis | None:
        ingredient = ingredients.get(key)
        if ingredient is None or ingredient.purchase_cost_cents <= 0:
            return None
        source = _ingredient_purchase_basis(ingredient)
        sources[id(source)] = ingredient
        return source

    def resolve_recipe(key: str) -> RecipeNode | None:
        return nodes.get(key)

    sources: dict[int, Ingredient] = {}

    def bridge(
        source_unit: str, target_unit: str, source: PurchaseBasis
    ) -> float | None:
        ingredient = sources.get(id(source))
        return (
            _standard_density_bridge(source_unit, target_unit, ingredient)
            if ingredient is not None
            else None
        )

    expansion = expand_recipe(
        root,
        resolve_ingredient=resolve_ingredient,
        resolve_recipe=resolve_recipe,
        standard_bridge=bridge,
    )
    # A material's issues are also collected on the expansion, so the two
    # cannot simply be concatenated. What is left after removing them is the
    # recipe-level reason no material carries — a subrecipe cycle, which
    # reaches here with no materials at all and would otherwise read as a cost
    # of zero.
    #
    # The root batch's own issues are excluded: a product component quantity
    # is whole batches, so this caller never divides by the yield and an
    # unstated yield is not a reason to withhold its cost. A *nested* recipe's
    # batch does divide, and its failure arrives attached to a material.
    attributed = {
        issue for material in expansion.materials for issue in material.issues
    }
    attributed.update(expansion.batch.issues)
    issues: list[ExpansionIssue] = [
        issue for issue in expansion.issues if issue not in attributed
    ]
    total = 0.0
    for material in expansion.materials:
        # An excluded line still expands; only its money is skipped, so its
        # unresolved units must not withhold a cost the merchant can trust.
        if not material.cost_included:
            continue
        ingredient = ingredients.get(material.key)
        # A material key is an ingredient id for an ingredient line and a
        # recipe or line id otherwise, so it is only ever a name when the
        # ingredient is in hand. An unresolved subrecipe reports no path
        # rather than a raw uuid the merchant cannot look up.
        where = (ingredient.name,) if ingredient is not None else ()
        if material.issues:
            # `resolve_ingredient` withholds an unpriced ingredient, so the
            # expansion can only say "unresolved". Name the actual reason
            # here, where the price is in hand: it is the one a merchant can
            # fix, and the commonest reason a product has no cost at all.
            unpriced = ingredient is not None and ingredient.purchase_cost_cents <= 0
            issues.extend(
                ExpansionIssue(
                    "missing-ingredient-price"
                    if unpriced and issue.code == "unresolved-ingredient"
                    else issue.code,
                    where,
                    issue.detail,
                )
                for issue in material.issues
            )
            continue
        if material.purchase is None or ingredient is None:
            issues.append(ExpansionIssue("unresolved-ingredient", where))
            continue
        if ingredient.purchase_size is None or ingredient.purchase_size <= 0:
            issues.append(ExpansionIssue("missing-purchase-size", where))
            continue
        total += (
            material.purchase.amount
            / float(ingredient.purchase_size)
            * float(ingredient.purchase_cost_cents)
        )
    if issues:
        return None, tuple(issues)

    # A product component quantity is batches per sold product.  Unlike a
    # recipe line nested inside another recipe, it never means a share of the
    # component recipe's yield, so the full batch cost is the unit cost here.
    return total, ()


def cost_walker(
    user: User,
    components_by_product: dict[uuid.UUID, list[SalesProductComponent]],
    closure: Collection[uuid.UUID],
    names: dict[uuid.UUID, str],
) -> Callable[
    [uuid.UUID, tuple[uuid.UUID, ...]], tuple[int | None, tuple[ExpansionIssue, ...]]
]:
    """Cost every product in a closure from one recipe-graph load.

    The returned walker memoizes across products, so a bundle and each of its
    members cost together for what one of them used to cost alone. `names`
    is seeded by the caller and filled in here; a cycle reports the chain of
    names it walked.
    """
    roots = []
    direct_ingredients = []
    for product_id in closure:
        for component in components_by_product.get(product_id, ()):
            if component.recipe_id:
                roots.append(component.recipe)
            elif component.ingredient_id and component.ingredient is not None:
                direct_ingredients.append(component.ingredient)
            elif component.component_product is not None:
                names.setdefault(
                    component.component_product_id, component.component_product.name
                )
    nodes, ingredients = _product_recipe_nodes(user, roots, direct_ingredients)
    memo: dict[uuid.UUID, tuple[int | None, tuple[ExpansionIssue, ...]]] = {}

    def cost_of(
        product_id: uuid.UUID, path: tuple[uuid.UUID, ...]
    ) -> tuple[int | None, tuple[ExpansionIssue, ...]]:
        cached = memo.get(product_id)
        if cached is not None:
            return cached
        own = components_by_product.get(product_id)
        if not own:
            return None, (ExpansionIssue("no-composition"),)
        total = 0.0
        issues: list[ExpansionIssue] = []
        for component in own:
            if component.ingredient_id:
                ingredient = ingredients.get(str(component.ingredient_id))
                if ingredient is None:
                    issues.append(ExpansionIssue("unresolved-ingredient"))
                    continue
                if ingredient.purchase_cost_cents <= 0:
                    issues.append(
                        ExpansionIssue("missing-ingredient-price", (ingredient.name,))
                    )
                    continue
                source = _ingredient_purchase_basis(ingredient)
                expansion = purchase_quantity(
                    float(component.quantity),
                    component.unit,
                    source,
                    standard_bridge=lambda source_unit, target_unit, ingredient=ingredient: _standard_density_bridge(
                        source_unit, target_unit, ingredient
                    ),
                )
                if expansion.issues:
                    issues.extend(
                        ExpansionIssue(issue.code, (ingredient.name,), issue.detail)
                        for issue in expansion.issues
                    )
                    continue
                if expansion.purchase_units is None:
                    issues.append(
                        ExpansionIssue("unresolved-purchase-unit", (ingredient.name,))
                    )
                    continue
                total += expansion.purchase_units * float(
                    ingredient.purchase_cost_cents
                )
            elif component.recipe_id:
                unit_cost, recipe_issues = _recipe_unit_cost(
                    component.recipe, nodes, ingredients
                )
                if unit_cost is None:
                    issues.extend(
                        issue.at(component.recipe.title) for issue in recipe_issues
                    )
                    continue
                total += float(component.quantity) * unit_cost
            elif component.component_product_id:
                member_id = component.component_product_id
                walked = (*path, product_id)
                if member_id in walked:
                    issues.append(
                        ExpansionIssue(
                            "product-cycle",
                            tuple(names.get(step, "") for step in (*walked, member_id)),
                        )
                    )
                    continue
                if component.component_product is None:
                    issues.append(ExpansionIssue("unresolved-product"))
                    continue
                member_cents, member_issues = cost_of(member_id, walked)
                if member_cents is None:
                    # The member's own reason, under the member's name: that
                    # is the product whose page the merchant has to open. A
                    # cycle already names the whole chain from here.
                    issues.extend(
                        issue
                        if issue.code == "product-cycle"
                        else issue.at(component.component_product.name)
                        for issue in member_issues
                    )
                    continue
                total += float(component.quantity) * member_cents
            else:
                issues.append(ExpansionIssue("unresolved-component"))
        if issues:
            # Two lines of the same unpriced ingredient recode to one identical
            # issue; repeating it would double the "N things to fix" count for a
            # single fix. Order is kept: first cause first.
            result = (None, tuple(dict.fromkeys(issues)))
        else:
            result = (math.floor(total + 0.5), ())
        # A cycle's reason depends on the path walked to reach it, so only a
        # path-independent answer is worth keeping.
        if not any(issue.code == "product-cycle" for issue in result[1]):
            memo[product_id] = result
        return result

    return cost_of


def product_cost(row: SalesProduct) -> ProductCost:
    """Cost one product's composition, keeping every reason it could not be.

    A component may be another product, so this recurses: a bundle costs its
    members' own costs plus whatever it adds itself, and a member's failure
    arrives under the member's name so the merchant knows which one to fix.
    """
    components = list(row.components.all())
    if not components:
        return ProductCost(None, (ExpansionIssue("no-composition"),))
    components_by_product = {row.id: components}
    if any(component.component_product_id for component in components):
        # One query for the workspace's components; the alternative is a
        # query per level of nesting.
        components_by_product = bundles.product_components_by_product(row.user)
        components_by_product.setdefault(row.id, components)
    closure = bundles.product_closure(components_by_product, row.id)
    names = {row.id: row.name}
    cost_of = cost_walker(row.user, components_by_product, closure, names)
    cents, issues = cost_of(row.id, ())
    return ProductCost(cents, issues)


def product_detail_payload(
    user: User,
    row: SalesProduct,
    *,
    sold_at_range: tuple[datetime, datetime] | None = None,
) -> JsonObject:
    """Owner detail shape for Product Hub, including live composition cost."""
    currency_code = workspace_currency_code(user)
    index = bundles.BundleIndex.for_user(user)
    stats = product_sales_stats(
        user,
        [row.id],
        sold_at_range=sold_at_range,
        currency_code=currency_code,
        index=index,
    ).get(row.id, dict(EMPTY_PRODUCT_SALES))
    # The page shows both views at once, so it gets both without a refetch:
    # what this product itself sold, and what also reached it inside a box.
    as_sold = product_sales_stats(
        user,
        [row.id],
        sold_at_range=sold_at_range,
        currency_code=currency_code,
        expand_bundles=False,
    ).get(row.id, dict(EMPTY_PRODUCT_SALES))
    payload = product_json(row, stats)
    payload["salesAsSold"] = as_sold
    cost = product_cost(row)
    cost_cents = cost.cents
    margin_cents = (
        row.sell_price_cents - cost_cents if cost_cents is not None else None
    )
    payload.update(
        {
            "incompleteManualRevenue": False,
            "costCents": cost_cents,
            "costIssues": [_cost_issue_json(issue) for issue in cost.issues],
            "marginCents": margin_cents,
            "marginPercent": (
                margin_cents / row.sell_price_cents
                if margin_cents is not None and row.sell_price_cents > 0
                else None
            ),
            "currencyCode": currency_code,
        }
    )
    return {"item": payload}


def sku_ignore_json(
    row: SalesSkuIgnore, history: JsonObject | None = None
) -> JsonObject:
    history = history or {}
    modifier = parse_modifier_match_key(row.match_key)
    return {
        "id": str(row.id),
        "channel": row.channel,
        "providerAccountId": row.provider_account_id,
        "matchKey": row.match_key,
        "sku": row.sku,
        "externalName": row.external_name,
        "externalVariantTitle": row.external_variant_title,
        "identityKind": "modifier" if modifier is not None else "item",
        "source": "rule" if row.rule_id else "manual",
        "ruleId": str(row.rule_id) if row.rule_id else None,
        "lineCount": history.get("lineCount", 0),
        "quantity": history.get("quantity", 0),
        "netSalesCents": history.get("netSalesCents", 0),
        "currencyCode": history.get("currencyCode", ""),
        "lastSoldAt": history.get("lastSoldAt"),
    }


def ignore_rule_json(rule: SalesIgnoreRule) -> JsonObject:
    return {
        "id": str(rule.id),
        "channel": rule.channel,
        "enabled": rule.enabled,
        "conditions": [
            {
                "field": condition.get("field", ""),
                "operator": condition.get("operator", ""),
                "value": condition.get("value", ""),
            }
            for condition in rule.conditions
            if isinstance(condition, dict)
        ],
        "ignoredCount": getattr(rule, "ignored_count", 0),
        "createdAt": rule.created_at.isoformat(),
        "updatedAt": rule.updated_at.isoformat(),
    }


def _sole_name_variant(variant: SalesProductVariant, base: str) -> bool:
    """True when this variant is the only one keyed under that item name.

    `|` separates the name and variant parts, so a name containing one is
    excluded rather than guessed at.
    """
    if "|" in base[len("name:") : -1]:
        return False
    return not (
        SalesProductVariant.objects.filter(
            user_id=variant.user_id,
            channel=variant.channel,
            provider_account_id=variant.provider_account_id,
            identity_kind=SalesProductVariant.IdentityKind.ITEM,
            match_key__startswith=base,
        )
        .exclude(pk=variant.pk)
        .exists()
    )


def _sole_sku_variant(variant: SalesProductVariant, normalized_sku: str) -> bool:
    """True when no rival variant carries that SKU here.

    A second variant on the channel+account sharing the SKU means the
    SKU-keyed history could belong to either — unless it resolves those lines
    identically (same product, same multiplier), where the question answers
    itself and either may claim them.
    """
    others = (
        SalesProductVariant.objects.filter(
            user_id=variant.user_id,
            channel=variant.channel,
            provider_account_id=variant.provider_account_id,
            identity_kind=SalesProductVariant.IdentityKind.ITEM,
        )
        .exclude(pk=variant.pk)
        .exclude(sku="")
    )
    if variant.product_id is not None:
        others = others.exclude(
            product_id=variant.product_id,
            quantity_multiplier=variant.quantity_multiplier,
        )
    return not any(
        group_key_part(sku) == normalized_sku
        for sku in others.values_list("sku", flat=True)
    )


def attach_lines_to_variant(user: User, variant: SalesProductVariant) -> int:
    """Claim every pending line this item identity now owns.

    A line stores both its `sku:`/`name:` group key and the provider object ID
    it arrived with, so an object-ID variant approved after the fact still
    reaches history imported before it existed. Name identities also claim the
    other variant spellings of the same item name (see `base_name_key`), and a
    variant with a SKU claims the SKU-keyed lines older imports minted before
    the object ID was known — in both cases only as long as no other variant
    owns the same key.
    """
    scope = Q(
        channel=variant.channel,
        provider_account_id=variant.provider_account_id,
        match_key=variant.match_key,
    )
    if variant.identity_kind == SalesProductVariant.IdentityKind.ITEM:
        if variant.external_object_id:
            scope |= Q(
                channel=variant.channel,
                provider_account_id=variant.provider_account_id,
                external_object_id=variant.external_object_id,
            )
        base = base_name_key(variant.external_name)
        if variant.match_key.startswith(base) and _sole_name_variant(variant, base):
            scope |= Q(
                channel=variant.channel,
                provider_account_id=variant.provider_account_id,
                match_key__startswith=base,
            )
        normalized_sku = group_key_part(variant.sku)
        if normalized_sku and _sole_sku_variant(variant, normalized_sku):
            scope |= Q(
                channel=variant.channel,
                provider_account_id=variant.provider_account_id,
                match_key=f"sku:{normalized_sku}"[:500],
            )
    return SalesLine.objects.filter(
        Q(user=user, variant__isnull=True) & scope
    ).update(product=variant.product, variant=variant)


def sync_attached_line_products(user: User, variant: SalesProductVariant) -> int:
    """Re-mirror `SalesLine.product` after a variant's product reference moved.

    Attach and import both stamp lines with their variant's product, but
    re-pointing a variant edits it in place and would otherwise leave attached
    history carrying the former reference — which deleting that former product
    would then mistake for its own.
    """
    return (
        SalesLine.objects.filter(user=user, variant=variant)
        .exclude(product_id=variant.product_id)
        .update(product_id=variant.product_id)
    )


def detach_lines_from_variant(variant: SalesProductVariant) -> int:
    """Release every line this SKU owns, FK-linked or not.

    Attaching is channel-agnostic and history predating the menu-item model can
    carry the product without the variant FK, so detaching matches on the key
    too — otherwise those lines would stay tracked with no way to reach them.
    """
    return SalesLine.objects.filter(
        Q(variant=variant)
        | Q(
            user_id=variant.user_id,
            product_id=variant.product_id,
            channel=variant.channel,
            provider_account_id=variant.provider_account_id,
            match_key=variant.match_key,
        )
    ).update(product=None, variant=None)


# --- external identities -------------------------------------------------
#
# Provider object IDs are the only stable identity, so they key their own
# namespace. `sku:`/`name:` keys predate them and must keep matching
# byte-for-byte (see sales_group_key), which is why nothing below rewrites
# them.

MATCH_KEY_MAX_LENGTH = 500
# A modifier mapping with no parent scope applies under every parent.
MODIFIER_ANY_PARENT = "*"


def item_object_match_key(channel: str, external_object_id: str) -> str:
    return f"{channel}:item:{external_object_id.strip()}"[:MATCH_KEY_MAX_LENGTH]


def product_variant_match_key(
    channel: str, product_external_object_id: str, external_variant_title: str
) -> str:
    """Stable Shopify fallback when a ProductVariant id is unavailable."""
    return (
        f"{channel}:product:{product_external_object_id.strip()}:"
        f"variant:{group_key_part(external_variant_title)}"
    )[:MATCH_KEY_MAX_LENGTH]


def item_match_key(
    channel: str,
    *,
    external_object_id: str = "",
    product_external_object_id: str = "",
    external_variant_title: str = "",
    group_key: str = "",
) -> str:
    if external_object_id.strip():
        return item_object_match_key(channel, external_object_id)
    if (
        channel == SalesImport.Channel.SHOPIFY
        and product_external_object_id.strip()
        and external_variant_title.strip()
    ):
        return product_variant_match_key(
            channel, product_external_object_id, external_variant_title
        )
    return group_key


IdentityScope = tuple[str, str, str]


def identity_scope_key(
    channel: str, provider_account_id: str, match_key: str
) -> IdentityScope:
    return (channel, provider_account_id, match_key)


def provider_account_value(user: User, channel: str, raw: JsonObject) -> str:
    """A caller may only name an account it is actually connected to.

    A stale page otherwise files a variant under an account that no longer
    applies, shadowing the real one.
    """
    account = text_value(
        raw.get("providerAccountId", ""),
        "Provider account id",
        max_length=192,
        allow_blank=True,
    )
    if account and not SalesChannelConnection.objects.filter(
        user=user, provider=channel, provider_account_id=account
    ).exists():
        raise ValueError("Unknown provider account")
    return account


def modifier_object_match_key(
    channel: str,
    external_object_id: str,
) -> str:
    key = f"{channel}:modifier:{MODIFIER_ANY_PARENT}:{external_object_id.strip()}"
    return key[:MATCH_KEY_MAX_LENGTH]


def modifier_name_match_key(
    channel: str,
    name: str,
) -> str:
    key = f"{channel}:modifier:{MODIFIER_ANY_PARENT}:name:{group_key_part(name)}"
    return key[:MATCH_KEY_MAX_LENGTH]


@dataclass(frozen=True)
class ModifierIdentity:
    channel: str
    scope_id: str
    kind: str  # "object" | "name"
    value: str


def parse_modifier_match_key(key: str) -> ModifierIdentity | None:
    """Read a modifier key back into its parts, or None if it isn't one.

    The `name:` marker sits where a provider object ID would, so an object ID
    that is literally "name" would be misread. No provider we support issues
    one, and the alternative (a second delimiter) would break stored keys.
    """
    parts = key.split(":")
    if len(parts) < 4 or parts[1] != "modifier":
        return None
    parent = parts[2]
    rest = parts[3:]
    if rest[0] == "name":
        if len(rest) < 2:
            return None
        kind, value = "name", ":".join(rest[1:])
    else:
        kind, value = "object", ":".join(rest)
    if not value:
        return None
    return ModifierIdentity(
        channel=parts[0],
        scope_id="" if parent == MODIFIER_ANY_PARENT else parent,
        kind=kind,
        value=value,
    )


def modifier_candidate_keys(
    channel: str,
    *,
    external_object_id: str = "",
    name: str = "",
) -> list[str]:
    """Provider-global modifier keys, preferring object ID to name."""
    object_id = external_object_id.strip()
    keys: list[str] = []
    if object_id:
        keys.append(modifier_object_match_key(channel, object_id))
    if group_key_part(name):
        keys.append(modifier_name_match_key(channel, name))
    seen: set[str] = set()
    ordered: list[str] = []
    for key in keys:
        if key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered


# --- canonical-name suggestions ------------------------------------------

_CANONICAL_TOKEN_SPLIT = re.compile(r"[\W_]+", re.UNICODE)
_CANONICAL_WITHOUT = re.compile(r"\bw/o\b|\bw/o(?=\s|$)")
_CANONICAL_WITH = re.compile(r"\bw/")


def canonical_name(value: str) -> str:
    """A lossy comparison form used ONLY to suggest candidates.

    Nothing may auto-attach on this: it folds case, accents, punctuation, and
    the `&`/`and` plus `w/`/`with` spellings together, so two genuinely
    different merchant items can collapse onto one form.
    """
    text = unicodedata.normalize("NFKD", value)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold()
    text = text.replace("&", " and ")
    text = _CANONICAL_WITHOUT.sub(" without ", text)
    text = _CANONICAL_WITH.sub(" with ", text)
    tokens = [token for token in _CANONICAL_TOKEN_SPLIT.split(text) if token]
    return " ".join(tokens)


def canonical_product_index(user: User) -> dict[str, list[SalesProduct]]:
    index: dict[str, list[SalesProduct]] = defaultdict(list)
    for product in SalesProduct.objects.filter(user=user, is_active=True):
        key = canonical_name(product.name)
        if key:
            index[key].append(product)
    return index


def canonical_product_candidates(
    user: User,
    name: str,
    *,
    index: dict[str, list[SalesProduct]] | None = None,
) -> list[SalesProduct]:
    """Every menu item whose name shares this canonical form.

    More than one result means the merchant must choose; the caller must not
    preselect.
    """
    key = canonical_name(name)
    if not key:
        return []
    if index is None:
        index = canonical_product_index(user)
    return list(index.get(key, []))


# --- resolution ----------------------------------------------------------


@dataclass(frozen=True)
class VariantMatch:
    """The outcome of resolving one external identity.

    `status` is the contract: only "matched" may attach automatically.
    "suggested" always needs merchant approval, "pending" has nothing to show.
    """

    status: str  # "matched" | "suggested" | "pending"
    variant: SalesProductVariant | None = None
    product: SalesProduct | None = None
    reason: str | None = None
    candidates: tuple[SalesProduct, ...] = field(default_factory=tuple)


PENDING_MATCH = VariantMatch(status="pending")


class VariantIndex(dict[IdentityScope, SalesProductVariant]):
    """Approved variants by identity scope, plus the derived lookups the
    resolver's compatibility rungs need.

    Each derived form is one pass over every variant, and one
    `reinterpret_sales` resolves every stored line against a single mapping:
    building them per call cost 18.9s on a 31k-line workspace and timed the
    browser out. Nothing mutates the mapping once `variant_index` has built
    it, so a form cached here is exactly as stale as the mapping itself.

    The cache lives in the instance `__dict__` that `cached_property` writes,
    which is not the mapping's own contents. Keeping it out of there is not
    incidental: `name_variant_index` unpacks every key as a 3-tuple.
    """

    @cached_property
    def by_sku(self) -> dict[str, list[SalesProductVariant]]:
        return sku_variant_index(self)

    @cached_property
    def by_name(self) -> dict[str, list[SalesProductVariant]]:
        return name_variant_index(self)

    @cached_property
    def by_product_title(
        self,
    ) -> dict[tuple[str, str, str, str], list[SalesProductVariant]]:
        return product_variant_title_index(self)


def variant_index(user: User) -> VariantIndex:
    return VariantIndex(
        {
            identity_scope_key(
                row.channel, row.provider_account_id, row.match_key
            ): row
            for row in SalesProductVariant.objects.filter(
                user=user, channel__in=PROVIDER_CHANNELS
            ).select_related("product")
        }
    )


def sku_variant_index(
    variants: dict[IdentityScope, SalesProductVariant],
) -> dict[str, list[SalesProductVariant]]:
    index: dict[str, list[SalesProductVariant]] = defaultdict(list)
    for variant in variants.values():
        if variant.identity_kind != SalesProductVariant.IdentityKind.ITEM:
            continue
        if variant.sku:
            index[group_key_part(variant.sku)].append(variant)
    # Plain: the result is cached and shared, so a reader reaching for a
    # missing key must not grow the structure other readers are iterating.
    return dict(index)


def name_variant_index(
    variants: dict[IdentityScope, SalesProductVariant],
) -> dict[str, list[SalesProductVariant]]:
    """Item variants grouped by the variant-insensitive part of a name key."""
    index: dict[str, list[SalesProductVariant]] = defaultdict(list)
    for (_, _, key), variant in variants.items():
        if variant.identity_kind != SalesProductVariant.IdentityKind.ITEM:
            continue
        # Exactly one `|`: a name or variant carrying the separator is
        # ambiguous, so it only ever matches its own exact key.
        if not key.startswith("name:") or key.count("|") != 1:
            continue
        index[key[len("name:") : key.index("|")]].append(variant)
    return dict(index)


def product_variant_title_index(
    variants: dict[IdentityScope, SalesProductVariant],
) -> dict[tuple[str, str, str, str], list[SalesProductVariant]]:
    """Item variants keyed by (catalog object id, provider variant title).

    Serves the Shopify "product ID + exact variant title" rung: a variant saved
    against a PRODUCT id plus a provider variant title is claimed by a sale
    carrying that product and that title, without inventing a second stored
    key format.
    """
    index: dict[tuple[str, str, str, str], list[SalesProductVariant]] = defaultdict(
        list
    )
    for variant in variants.values():
        if variant.identity_kind != SalesProductVariant.IdentityKind.ITEM:
            continue
        if not variant.external_object_id or not variant.external_variant_title:
            continue
        index[
            (
                variant.channel,
                variant.provider_account_id,
                variant.external_object_id,
                group_key_part(variant.external_variant_title),
            )
        ].append(variant)
    return dict(index)


def _sole_product_variant(
    rows: list[SalesProductVariant],
) -> SalesProductVariant | None:
    """One variant per distinct product, or None when the SKU is ambiguous."""
    rows = [row for row in rows if row.product_id is not None]
    if not rows:
        return None
    products = {row.product_id for row in rows}
    if len(products) != 1:
        return None
    return rows[0]


def _name_suggestion(
    user: User,
    name: str,
    *,
    canonical_index: dict[str, list[SalesProduct]] | None,
) -> VariantMatch:
    candidates = canonical_product_candidates(user, name, index=canonical_index)
    if not candidates:
        return PENDING_MATCH
    exact = [
        product
        for product in candidates
        if product.normalized_name == normalized_name(name)
    ]
    ordered = exact or candidates
    return VariantMatch(
        status="suggested",
        # Never preselect an ambiguous canonical form.
        product=ordered[0] if len(ordered) == 1 else None,
        reason="name" if exact else "canonical",
        candidates=tuple(candidates),
    )


def resolve_item_variant(
    user: User,
    *,
    channel: str,
    provider_account_id: str = "",
    external_object_id: str = "",
    product_external_object_id: str = "",
    group_key: str = "",
    sku: str = "",
    item_name: str = "",
    external_variant_title: str = "",
    variants: VariantIndex | None = None,
    canonical_index: dict[str, list[SalesProduct]] | None = None,
    suggest: bool = True,
) -> VariantMatch:
    """Resolve a parent item identity (spec: resolution priority for items).

    The Shopify priority maps onto the same rungs: variant ID -> `object_id`,
    approved variant -> `variant`, unique SKU -> `sku`, product ID + exact
    variant title -> `product_variant`, approved name alias -> `name`, then
    suggestion.

    `suggest=False` stops before canonical-name suggestions: a caller that
    only acts on "matched" would otherwise pay a menu-item scan per unmatched
    identity, which is every line of a first backfill.
    """
    if variants is None:
        variants = variant_index(user)

    if external_object_id.strip():
        variant = variants.get(
            identity_scope_key(
                channel,
                provider_account_id,
                item_object_match_key(channel, external_object_id),
            )
        )
        if variant is not None:
            return VariantMatch(
                status="matched",
                variant=variant,
                product=variant.product,
                reason="object_id",
            )

    if group_key:
        variant = variants.get(
            identity_scope_key(channel, provider_account_id, group_key)
        )
        if variant is not None:
            return VariantMatch(
                status="matched",
                variant=variant,
                product=variant.product,
                reason="match_key",
            )

    if sku.strip():
        variant = variants.get(
            identity_scope_key(
                channel,
                provider_account_id,
                sales_group_key(sku, item_name, external_variant_title),
            )
        )
        if variant is not None:
            return VariantMatch(
                status="matched",
                variant=variant,
                product=variant.product,
                reason="sku",
            )
        if suggest:
            # This rung only ever suggests, so a caller that acts on "matched"
            # alone must not reach the index at all.
            rows = variants.by_sku.get(group_key_part(sku), [])
            match = _sole_product_variant(rows) if rows else None
            if match is not None:
                return VariantMatch(
                    status="suggested", product=match.product, reason="sku"
                )

    if product_external_object_id.strip() and external_variant_title.strip():
        fallback_key = product_variant_match_key(
            channel, product_external_object_id, external_variant_title
        )
        variant = variants.get(
            identity_scope_key(channel, provider_account_id, fallback_key)
        )
        if variant is None:
            # Compatibility for approvals saved before product fallback ids
            # had their own column/key. The scope still has to match exactly.
            rows = variants.by_product_title.get(
                (
                    channel,
                    provider_account_id,
                    product_external_object_id.strip(),
                    group_key_part(external_variant_title),
                ),
                [],
            )
            variant = _sole_product_variant(rows) if rows else None
        if variant is not None:
            return VariantMatch(
                status="matched",
                variant=variant,
                product=variant.product,
                reason="product_variant",
            )

    if item_name.strip():
        variant = variants.get(
            identity_scope_key(
                channel,
                provider_account_id,
                sales_group_key("", item_name, external_variant_title),
            )
        )
        if variant is not None:
            return VariantMatch(
                status="matched",
                variant=variant,
                product=variant.product,
                reason="name",
            )
        if suggest:
            # Variant-insensitive compat (see `base_name_key`): the CSV and
            # API paths disagree on whether a SKU-less product carries its
            # variant, so the same item name resolves either way — but only
            # when the merchant's variants for that name all point at one menu
            # item. Suggestion-only, like the SKU rung above.
            rows = variants.by_name.get(group_key_part(item_name), [])
            match = _sole_product_variant(rows) if rows else None
            if match is not None:
                return VariantMatch(
                    status="suggested", product=match.product, reason="name"
                )

    if suggest and item_name.strip():
        return _name_suggestion(user, item_name, canonical_index=canonical_index)
    return PENDING_MATCH


def resolve_modifier_variant(
    user: User,
    *,
    channel: str,
    provider_account_id: str = "",
    external_object_id: str = "",
    name: str = "",
    variants: dict[IdentityScope, SalesProductVariant] | None = None,
    canonical_index: dict[str, list[SalesProduct]] | None = None,
    suggest: bool = True,
) -> VariantMatch:
    """Resolve one modifier occurrence (spec: resolution priority for
    modifiers). See `resolve_item_variant` for `suggest`."""
    if variants is None:
        variants = variant_index(user)
    for key in modifier_candidate_keys(
        channel,
        external_object_id=external_object_id,
        name=name,
    ):
        variant = variants.get(
            identity_scope_key(channel, provider_account_id, key)
        )
        if variant is None:
            continue
        if variant.identity_kind != SalesProductVariant.IdentityKind.MODIFIER:
            continue
        identity = parse_modifier_match_key(key)
        return VariantMatch(
            status="matched",
            variant=variant,
            product=variant.product,
            reason=identity.kind if identity else None,
        )
    if suggest and name.strip():
        return _name_suggestion(user, name, canonical_index=canonical_index)
    return PENDING_MATCH


# --- attach and detach ---------------------------------------------------


def approved_modifier_keys(user: User) -> set[IdentityScope]:
    return set(
        SalesProductVariant.objects.filter(
            user=user, identity_kind=SalesProductVariant.IdentityKind.MODIFIER
        ).values_list("channel", "provider_account_id", "match_key")
    )


def winning_modifier_key(
    match_key: str,
    external_object_id: str,
    name: str,
    provider_account_id: str,
    approved: set[IdentityScope],
) -> IdentityScope | None:
    """Return the provider-global mapping that owns one modifier occurrence."""
    identity = parse_modifier_match_key(match_key)
    if identity is None:
        return None
    keys = modifier_candidate_keys(
        identity.channel,
        external_object_id=external_object_id,
        name=name,
    )
    return next(
        (
            identity_scope_key(identity.channel, provider_account_id, key)
            for key in keys
            if identity_scope_key(identity.channel, provider_account_id, key)
            in approved
        ),
        None,
    )


def attach_modifiers_to_variant(user: User, variant: SalesProductVariant) -> int:
    """Claim every unattached occurrence this modifier identity now owns."""
    if variant.identity_kind != SalesProductVariant.IdentityKind.MODIFIER:
        return 0
    approved = approved_modifier_keys(user)
    claimed: list[uuid.UUID] = []
    for row_id, match_key, object_id, name in SalesLineModifier.objects.filter(
        user=user,
        variant__isnull=True,
        sales_line__channel=variant.channel,
        sales_line__provider_account_id=variant.provider_account_id,
    ).values_list("id", "match_key", "external_object_id", "name"):
        if winning_modifier_key(
            match_key,
            object_id,
            name,
            variant.provider_account_id,
            approved,
        ) == identity_scope_key(
            variant.channel, variant.provider_account_id, variant.match_key
        ):
            claimed.append(row_id)
    attached = 0
    for start in range(0, len(claimed), 500):
        attached += SalesLineModifier.objects.filter(
            id__in=claimed[start : start + 500]
        ).update(variant=variant)
    return attached


def detach_modifiers_from_variant(variant: SalesProductVariant) -> int:
    """Return this identity's occurrences to Modifier Review.

    Source facts stay: only the mapping is released.
    """
    return SalesLineModifier.objects.filter(variant=variant).update(variant=None)


# --- reinterpretation ----------------------------------------------------


def empty_receipt() -> JsonObject:
    return {
        "parentLinesAttached": 0,
        "parentLinesDetached": 0,
        "modifierOccurrencesAttached": 0,
        "modifierOccurrencesDetached": 0,
        "linesReinterpreted": 0,
        "conflicts": [],
    }


def finish_receipt(user: User, receipt: JsonObject) -> JsonObject:
    return receipt


def line_product_object_id(column: str, payload: object) -> str:
    """The catalog parent id a stored line arrived with, if any.

    Older lines carry it in the raw payload rather than the column: it is a
    resolution fallback, never an identity Forkluck keys anything on. The two
    forms are passed in rather than read off a `SalesLine`, so a caller that
    holds columns rather than model instances can still ask.
    """
    if column:
        return column
    if not isinstance(payload, dict):
        return ""
    value = payload.get("productObjectId")
    return value.strip()[:192] if isinstance(value, str) else ""


def reinterpret_sales(user: User) -> JsonObject:
    """Re-run matching over stored history. Safe to repeat: a second pass over
    unchanged mappings attaches and detaches nothing."""
    receipt = empty_receipt()
    variants = variant_index(user)
    touched: set[uuid.UUID] = set()

    # Columns rather than model instances: resolution reads ten fields, and a
    # workspace whose history is largely unmatched would otherwise build tens
    # of thousands of `SalesLine` objects to answer a question about strings.
    # Lines claiming the same variant are then updated together, the way the
    # modifier loop below already writes.
    claim: dict[tuple[uuid.UUID | None, uuid.UUID], list[uuid.UUID]] = defaultdict(
        list
    )
    pending_lines = (
        SalesLine.objects.filter(user=user, variant__isnull=True)
        .values_list(
            "id",
            "channel",
            "provider_account_id",
            "external_object_id",
            "product_external_object_id",
            "source_payload",
            "group_key",
            "sku",
            "item_name",
            "external_variant_title",
        )
        .iterator(chunk_size=2000)
    )
    for (
        line_id,
        channel,
        provider_account_id,
        external_object_id,
        product_object_column,
        source_payload,
        group_key,
        sku,
        item_name,
        external_variant_title,
    ) in pending_lines:
        match = resolve_item_variant(
            user,
            channel=channel,
            provider_account_id=provider_account_id,
            external_object_id=external_object_id,
            product_external_object_id=line_product_object_id(
                product_object_column, source_payload
            ),
            group_key=group_key,
            sku=sku,
            item_name=item_name,
            external_variant_title=external_variant_title,
            variants=variants,
            suggest=False,
        )
        if match.status != "matched" or match.variant is None:
            continue
        claim[(match.variant.product_id, match.variant.id)].append(line_id)
        touched.add(line_id)

    for (product_id, variant_id), line_ids in claim.items():
        for start in range(0, len(line_ids), 500):
            receipt["parentLinesAttached"] += SalesLine.objects.filter(
                id__in=line_ids[start : start + 500]
            ).update(product_id=product_id, variant_id=variant_id)

    approved = {
        key: row
        for key, row in variants.items()
        if row.identity_kind == SalesProductVariant.IdentityKind.MODIFIER
    }
    approved_keys = set(approved)
    attach: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    detach: list[uuid.UUID] = []
    for (
        row_id,
        line_id,
        variant_id,
        match_key,
        object_id,
        name,
        provider_account_id,
    ) in SalesLineModifier.objects.filter(user=user).values_list(
        "id",
        "sales_line_id",
        "variant_id",
        "match_key",
        "external_object_id",
        "name",
        "sales_line__provider_account_id",
    ):
        winner = winning_modifier_key(
            match_key,
            object_id,
            name,
            provider_account_id,
            approved_keys,
        )
        target = approved[winner].id if winner else None
        if target == variant_id:
            continue
        touched.add(line_id)
        if target is None:
            detach.append(row_id)
        else:
            attach[target].append(row_id)
    for target_id, row_ids in attach.items():
        for start in range(0, len(row_ids), 500):
            receipt["modifierOccurrencesAttached"] += (
                SalesLineModifier.objects.filter(
                    id__in=row_ids[start : start + 500]
                ).update(variant_id=target_id)
            )
    for start in range(0, len(detach), 500):
        receipt["modifierOccurrencesDetached"] += SalesLineModifier.objects.filter(
            id__in=detach[start : start + 500]
        ).update(variant=None)

    receipt["linesReinterpreted"] = len(touched)
    return receipt


# --- interpretation ------------------------------------------------------


@dataclass(frozen=True)
class InterpretedComponent:
    product: SalesProduct
    quantity: Decimal
    source: str  # "base" | "modifier"
    variant: SalesProductVariant | None = None
    modifier: SalesLineModifier | None = None


@dataclass(frozen=True)
class RecipeComponent:
    recipe: Recipe
    product: SalesProduct
    quantity: Decimal
    source: str


@dataclass(frozen=True)
class ProductContribution:
    """One product view of a source sales line.

    The line remains the only financial fact.  All product/read-model and
    recipe consumers use this shape so bundle cent allocation cannot diverge
    from unit interpretation.

    ``via_bundle`` marks a product the line reached through a bundle rather
    than through its own variant, and ``depth`` says how many bundles deep.
    The as-sold row is the one with ``via_bundle`` false: it is the row that
    counts the line, and a bundle's own row carries zero money because the
    money has moved to the products inside it.
    """
    product: SalesProduct
    quantity: Decimal
    gross_cents: int
    discount_cents: int
    net_sales_cents: int
    tax_cents: int
    refund_cents: int
    source: str
    via_bundle: bool = False
    depth: int = 0


def attributed_cents(variant: SalesProductVariant, value: int) -> int:
    """Return the part of one financial field this variant's products own.

    A variant sells what the merchant tracks alongside what they do not: a
    "tea and biscuits" variant names the biscuits and says nothing about the
    tea. `attribution_percent` is the share that belongs to the named
    products, and the remainder stays unattributed rather than inflating them.
    Null is the default and reads as the whole line, so a catalog nobody has
    visited still reports every figure correctly.
    """
    percent = variant.attribution_percent
    if percent is None or percent == 100:
        return value
    if percent == 0:
        return 0
    return allocate_cents_by_weight(value, [percent, 100 - percent])[0]


def _variant_contributions(
    variant: SalesProductVariant,
    quantity: Decimal,
    *,
    source: str,
    index: bundles.BundleIndex | None = None,
    expand_bundles: bool = True,
    gross_cents: int = 0,
    discount_cents: int = 0,
    net_sales_cents: int = 0,
    tax_cents: int = 0,
    refund_cents: int = 0,
) -> list[ProductContribution]:
    if variant.product_id is None:
        return []
    fields = [
        attributed_cents(variant, gross_cents),
        attributed_cents(variant, discount_cents),
        attributed_cents(variant, net_sales_cents),
        attributed_cents(variant, tax_cents),
        attributed_cents(variant, refund_cents),
    ]
    units = quantity * variant.quantity_multiplier
    if not expand_bundles or index is None or not index.is_bundle(variant.product_id):
        return [ProductContribution(variant.product, units, *fields, source)]
    # The bundle keeps its units and gives up its money: summing any money
    # column over the expanded set still gives the line's attributed total.
    return [
        ProductContribution(variant.product, units, 0, 0, 0, 0, 0, source),
        *(
            ProductContribution(
                share.product,
                share.units,
                *share.cents,
                source,
                True,
                share.depth,
            )
            for share in index.expand(variant.product_id, units, fields)
        ),
    ]


def interpret_line(
    line: SalesLine,
    *,
    index: bundles.BundleIndex | None = None,
    expand_bundles: bool = True,
) -> list[ProductContribution]:
    """Return every product contribution from a line, including mapped modifiers.

    Parent monetary fields are allocated only to the parent variant; modifier
    occurrences add physical consumption with zero monetary attribution.
    Unresolved modifiers never suppress an otherwise valid parent.  Without an
    ``index`` a bundle cannot be expanded, so the result is the as-sold view.
    """
    result: list[ProductContribution] = []
    if line.variant_id:
        result.extend(
            _variant_contributions(
                line.variant,
                line.quantity,
                source="base",
                index=index,
                expand_bundles=expand_bundles,
                gross_cents=line.gross_cents,
                discount_cents=line.discount_cents,
                net_sales_cents=line.net_sales_cents,
                tax_cents=line.tax_cents,
                refund_cents=line.refund_cents,
            )
        )
    for occurrence in line.modifiers.all():
        if occurrence.variant_id and occurrence.quantity:
            result.extend(
                _variant_contributions(
                    occurrence.variant,
                    line.quantity * occurrence.quantity,
                    source="modifier",
                    index=index,
                    expand_bundles=expand_bundles,
                )
            )
    return result


def interpreted_components(line: SalesLine) -> list[InterpretedComponent]:
    return [
        InterpretedComponent(
            product=item.product,
            quantity=item.quantity,
            source=item.source,
        )
        for item in interpret_line(line)
    ]


def interpreted_recipe_components(line: SalesLine) -> list[RecipeComponent]:
    """Expand product contributions through recipe components only."""
    result: list[RecipeComponent] = []
    for component in interpreted_components(line):
        links = component.product.components
        # Chaining select_related() onto the manager clones the queryset and
        # drops whatever the caller prefetched, re-querying once per component.
        # Read the cache where it exists; join the recipe where it does not, so
        # an un-prefetched caller still pays one query rather than one per link.
        cached = "components" in getattr(
            component.product, "_prefetched_objects_cache", {}
        )
        for link in links.all() if cached else links.select_related("recipe"):
            if link.recipe_id is None:
                continue
            result.append(
                RecipeComponent(
                    recipe=link.recipe,
                    product=component.product,
                    quantity=component.quantity * link.quantity,
                    source=component.source,
                )
            )
    return result


def interpreted_recipe_totals(line: SalesLine) -> dict[uuid.UUID, Decimal]:
    totals: dict[uuid.UUID, Decimal] = defaultdict(lambda: Decimal("0"))
    for component in interpreted_recipe_components(line):
        totals[component.recipe.id] += component.quantity
    return dict(totals)


DAILY_SALES_LIMIT = 50


def daily_sales_rows(
    user: User,
    limit: int = DAILY_SALES_LIMIT,
    *,
    expand_bundles: bool = True,
) -> list[JsonObject]:
    """Recent tracked sales, one row per product, channel, local day and currency.

    The sales list is a working ledger, not an order-event log. A daily rollup
    keeps it readable while retaining channel separation for reconciliation.
    Plain products and mapped modifiers group in SQL; a bundle's line is walked
    in Python, because the value ladder its money splits by is not something
    SQL can express. Every row is a product view, so money is the variant's
    attributed share; quantity is physical and never scales with attribution.
    """
    index = bundles.BundleIndex.for_user(user) if expand_bundles else None
    bundle_ids = index.bundle_ids if index is not None else set()
    groups: dict[tuple[str, str, date, str], dict[str, Any]] = {}
    direct_rows = (
        SalesLine.objects.filter(
            user=user,
            variant__user=user,
            variant__product__isnull=False,
        )
        .exclude(variant__product_id__in=bundle_ids)
        .values(
            "variant__product_id",
            "variant__product__name",
            "channel",
            "sold_on",
            "currency_code",
        )
        .annotate(
            quantity=Sum(
                ExpressionWrapper(
                    F("quantity") * F("variant__quantity_multiplier"),
                    output_field=DecimalField(max_digits=24, decimal_places=6),
                )
            ),
            gross_cents=_attributed_column_sum("gross_cents"),
            discount_cents=_attributed_column_sum("discount_cents"),
            net_sales_cents=_attributed_column_sum("net_sales_cents"),
            tax_cents=_attributed_column_sum("tax_cents"),
            refund_cents=_attributed_column_sum("refund_cents"),
            incomplete_manual_count=Count(
                "id",
                filter=Q(channel=SalesImport.Channel.MANUAL)
                & (
                    Q(source_payload__netProvided=False)
                    | Q(source_payload={})
                ),
            ),
            distinct_skus=Count("sku", distinct=True, filter=~Q(sku="")),
            any_sku=Max("sku"),
            item_name=Max("item_name"),
        )
        .order_by(
            "-sold_on",
            "-variant__product__name",
            "-channel",
            "-currency_code",
        )
    )
    direct_rows = direct_rows[:limit]

    for row in direct_rows:
        product_id = str(row["variant__product_id"])
        key = (product_id, row["channel"], row["sold_on"], row["currency_code"])
        groups[key] = {
            "channel": row["channel"],
            "soldOn": row["sold_on"],
            "productId": product_id,
            "productName": row["variant__product__name"],
            "itemName": row["item_name"],
            "skus": {row["any_sku"]} if row["distinct_skus"] == 1 else set(),
            "skuAmbiguous": row["distinct_skus"] > 1,
            "quantity": row["quantity"],
            "grossCents": row["gross_cents"],
            "discountCents": row["discount_cents"],
            "netSalesCents": (
                None
                if row["incomplete_manual_count"]
                else row["net_sales_cents"]
            ),
            "taxCents": row["tax_cents"],
            "refundCents": row["refund_cents"],
            "currencyCode": row["currency_code"],
        }

    # Modifier revenue stays on its parent line, so modifier consumption is a
    # straight SQL aggregate even when the parent itself is a bundle.
    modifier_rows = (
        SalesLineModifier.objects.filter(
            user=user,
            sales_line__user=user,
            sales_line__variant__isnull=False,
            variant__user=user,
            variant__product__isnull=False,
        )
        .exclude(variant__product_id__in=bundle_ids)
        .values(
            "variant__product_id",
            "variant__product__name",
            "sales_line__channel",
            "sales_line__sold_on",
            "sales_line__currency_code",
        )
        .annotate(
            quantity=Sum(
                ExpressionWrapper(
                    F("sales_line__quantity")
                    * F("quantity")
                    * F("variant__quantity_multiplier"),
                    output_field=DecimalField(max_digits=30, decimal_places=9),
                )
            ),
            distinct_skus=Count(
                "sales_line__sku",
                distinct=True,
                filter=~Q(sales_line__sku=""),
            ),
            any_sku=Max("sales_line__sku"),
            item_name=Max("sales_line__item_name"),
        )
        .order_by(
            "-sales_line__sold_on",
            "-variant__product__name",
            "-sales_line__channel",
            "-sales_line__currency_code",
        )[:limit]
    )
    for row in modifier_rows:
        product_id = str(row["variant__product_id"])
        key = (
            product_id,
            row["sales_line__channel"],
            row["sales_line__sold_on"],
            row["sales_line__currency_code"],
        )
        group = groups.setdefault(
            key,
            {
                "channel": row["sales_line__channel"],
                "soldOn": row["sales_line__sold_on"],
                "productId": product_id,
                "productName": row["variant__product__name"],
                "itemName": row["item_name"],
                "skus": set(),
                "skuAmbiguous": False,
                "quantity": Decimal("0"),
                "grossCents": 0,
                "discountCents": 0,
                "netSalesCents": 0,
                "taxCents": 0,
                "refundCents": 0,
                "currencyCode": row["sales_line__currency_code"],
            },
        )
        if row["distinct_skus"] > 1:
            group["skuAmbiguous"] = True
        elif row["distinct_skus"] == 1:
            sku = row["any_sku"]
            if group["skus"] and sku not in group["skus"]:
                group["skuAmbiguous"] = True
            group["skus"].add(sku)
        group["itemName"] = max(group["itemName"], row["item_name"])
        group["quantity"] += row["quantity"]

    # A bundle's line is read whole and split in Python: the ladder its money
    # splits by depends on member prices and costs, which no aggregate can
    # reach. Only bundle lines are loaded, so the ledger's size does not
    # decide the cost of this pass.
    if bundle_ids:

        def absorb(contribution: ProductContribution, line: SalesLine) -> None:
            product_id = str(contribution.product.id)
            key = (product_id, line.channel, line.sold_on, line.currency_code)
            group = groups.setdefault(
                key,
                {
                    "channel": line.channel,
                    "soldOn": line.sold_on,
                    "productId": product_id,
                    "productName": contribution.product.name,
                    "itemName": line.item_name,
                    "skus": set(),
                    "skuAmbiguous": False,
                    "quantity": Decimal("0"),
                    "grossCents": 0,
                    "discountCents": 0,
                    "netSalesCents": 0,
                    "taxCents": 0,
                    "refundCents": 0,
                    "currencyCode": line.currency_code,
                },
            )
            if line.sku:
                if group["skus"] and line.sku not in group["skus"]:
                    group["skuAmbiguous"] = True
                group["skus"].add(line.sku)
            group["itemName"] = max(group["itemName"], line.item_name)
            group["quantity"] += contribution.quantity
            group["grossCents"] += contribution.gross_cents
            group["discountCents"] += contribution.discount_cents
            # A count-only manual sale stays unknown after bundle expansion,
            # including when its member already has a direct daily row.
            if (
                contribution.source == "base"
                and line.channel == SalesImport.Channel.MANUAL
                and line.source_payload.get("netProvided") is not True
            ):
                group["netSalesCents"] = None
            elif group["netSalesCents"] is not None:
                group["netSalesCents"] += contribution.net_sales_cents
            group["taxCents"] += contribution.tax_cents
            group["refundCents"] += contribution.refund_cents

        bundle_lines = (
            SalesLine.objects.filter(
                user=user,
                variant__user=user,
                variant__product_id__in=bundle_ids,
            )
            .select_related("variant", "variant__product")
            .order_by("-sold_on", "id")
        )
        for line in bundle_lines:
            for contribution in _variant_contributions(
                line.variant,
                line.quantity,
                source="base",
                index=index,
                gross_cents=line.gross_cents,
                discount_cents=line.discount_cents,
                net_sales_cents=line.net_sales_cents,
                tax_cents=line.tax_cents,
                refund_cents=line.refund_cents,
            ):
                absorb(contribution, line)
        bundle_modifiers = (
            SalesLineModifier.objects.filter(
                user=user,
                sales_line__user=user,
                sales_line__variant__isnull=False,
                variant__user=user,
                variant__product_id__in=bundle_ids,
            )
            .exclude(quantity=0)
            .select_related("variant", "variant__product", "sales_line")
        )
        for occurrence in bundle_modifiers:
            for contribution in _variant_contributions(
                occurrence.variant,
                occurrence.sales_line.quantity * occurrence.quantity,
                source="modifier",
                index=index,
            ):
                absorb(contribution, occurrence.sales_line)

    result = []
    for key, group in groups.items():
        product_id, channel, sold_on, currency_code = key
        skus = group.pop("skus")
        ambiguous = group.pop("skuAmbiguous")
        result.append(
            {
                **group,
                "id": f"{product_id}:{channel}:{sold_on.isoformat()}:{currency_code}",
                "soldOn": sold_on.isoformat(),
                "sku": next(iter(skus)) if len(skus) == 1 and not ambiguous else "",
                "quantity": float(group["quantity"]),
            }
        )
    return sorted(
        result,
        key=lambda row: (
            row["soldOn"],
            row["productName"].casefold(),
            row["channel"],
            row["currencyCode"],
        ),
        reverse=True,
    )[:limit]


def period_product_sales_rows(
    rows: QuerySet[SalesLine],
    period_start: date | None,
    period_end: date | None,
    period_timezone: ZoneInfo,
    ignored_keys: set[IdentityScope],
    *,
    index: bundles.BundleIndex | None = None,
) -> list[JsonObject]:
    """Produced-product totals for the selected analytics period."""
    if period_start is None or period_end is None:
        return []

    period_start_at = datetime.combine(
        period_start, time.min, tzinfo=period_timezone
    ).astimezone(ZoneInfo("UTC"))
    period_end_at = datetime.combine(
        period_end + timedelta(days=1), time.min, tzinfo=period_timezone
    ).astimezone(ZoneInfo("UTC"))
    groups: dict[tuple[str, str], JsonObject] = {}
    canonical_rows = (
        rows.filter(
            sold_at__gte=period_start_at,
            sold_at__lt=period_end_at,
            variant__isnull=False,
        )
        .select_related("variant__product")
        .prefetch_related("modifiers__variant__product")
    )
    for row in canonical_rows:
        for contribution in interpret_line(row, index=index):
            key = (str(contribution.product.id), row.channel)
            group = groups.setdefault(
                key,
                {
                    "productId": str(contribution.product.id),
                    "productName": contribution.product.name,
                    "channel": row.channel,
                    "quantity": Decimal("0"),
                    "netSalesCents": 0,
                    "sharedToMembers": index is not None
                    and index.is_bundle(contribution.product.id),
                    "_incompleteManualRevenue": False,
                },
            )
            group["quantity"] += contribution.quantity
            group["netSalesCents"] += contribution.net_sales_cents
            if (
                row.channel == SalesImport.Channel.MANUAL
                and row.source_payload.get("netProvided") is not True
            ):
                group["_incompleteManualRevenue"] = True
    result = []
    for group in groups.values():
        incomplete = group.pop("_incompleteManualRevenue")
        result.append(
            {
                **group,
                "quantity": float(group["quantity"]),
                "netSalesCents": None if incomplete else group["netSalesCents"],
            }
        )
    return sorted(
        result,
        key=lambda row: (
            -(row["netSalesCents"] or 0),
            row["productName"].casefold(),
            row["channel"],
        ),
    )


def unmatched_order_sources(user: User) -> dict[IdentityScope, list[str]]:
    """Name the POS order sources behind each product-less identity.

    A second pass rather than an array aggregate, which SQLite has no answer for.
    """
    sources: dict[IdentityScope, list[tuple[int, str]]] = {}
    rows = (
        SalesLine.objects.filter(user=user, variant__isnull=True)
        .exclude(order_source="")
        .values("channel", "provider_account_id", "match_key", "order_source")
        .annotate(agg_net_sales_cents=Sum("net_sales_cents"))
        .order_by()
    )
    for row in rows:
        key = identity_scope_key(
            row["channel"], row["provider_account_id"], row["match_key"]
        )
        sources.setdefault(key, []).append(
            (row["agg_net_sales_cents"] or 0, row["order_source"])
        )
    # Name breaks ties so equal-revenue sources order the same on every backend.
    return {
        key: [name for _, name in sorted(entries, key=lambda e: (-e[0], e[1]))]
        for key, entries in sources.items()
    }


def unmatched_group_rows(user: User) -> list[JsonObject]:
    """Aggregate product-less sales lines into one row per match key."""
    rows = list(
        SalesLine.objects.filter(user=user, variant__isnull=True)
        .values("channel", "provider_account_id", "match_key")
        .annotate(
            agg_sku=Max("sku"),
            agg_item_name=Max("item_name"),
            agg_variant_name=Max("external_variant_title"),
            agg_external_object_id=Max("external_object_id"),
            agg_product_external_object_id=Max("product_external_object_id"),
            # One group is one identity, so its lines share a category; Max
            # also prefers a filled-in value over a blank from an older line.
            agg_category=Max("external_category"),
            # Likewise one identity, one provider, one currency — so Max picks
            # the code the group's money is actually denominated in.
            agg_currency_code=Max("currency_code"),
            agg_line_count=Count("id"),
            agg_quantity=Sum("quantity"),
            agg_net_sales_cents=Sum("net_sales_cents"),
            agg_last_sold_at=Max("sold_at"),
        )
    )
    # One set lookup per group instead of a correlated EXISTS per group — the
    # subquery form re-probed the whole ledger for every identity and took the
    # overview from tens of milliseconds to seconds.
    modifier_scopes = set(
        SalesLineModifier.objects.filter(user=user)
        # Clear the model's default ordering: its created_at would join the
        # SELECT DISTINCT and give one row per occurrence, not per identity.
        .order_by()
        .values_list(
            "sales_line__channel",
            "sales_line__provider_account_id",
            "sales_line__match_key",
        )
        .distinct()
    )
    order_sources = unmatched_order_sources(user)
    for row in rows:
        row["agg_has_modifiers"] = (
            row["channel"],
            row["provider_account_id"],
            row["match_key"],
        ) in modifier_scopes
        row["agg_order_sources"] = order_sources.get(
            identity_scope_key(
                row["channel"], row["provider_account_id"], row["match_key"]
            ),
            [],
        )
    # Revenue first, then a codepoint-stable key — sorted in Python, not SQL,
    # because the per-category render cap keeps a prefix of this order and a
    # database collation would decide ties differently on SQLite and Postgres.
    rows.sort(
        key=lambda row: (
            -(row["agg_net_sales_cents"] or 0),
            -(row["agg_line_count"] or 0),
            row["match_key"],
        )
    )
    return rows


def catalog_item_is_pending(
    item: SalesCatalogItem,
    *,
    listed: set[IdentityScope],
    pending_keys: set[IdentityScope],
    ignored_keys: set[IdentityScope],
    connected: set[tuple[str, str]],
) -> bool:
    key = identity_scope_key(
        item.channel, item.provider_account_id, item.match_key
    )
    return (
        key not in listed
        and key not in pending_keys
        and key not in ignored_keys
        and (item.channel, item.provider_account_id) in connected
    )


IDENTITY_LINES_LIMIT = 50


def identity_lines_payload(
    user: User, channel: str, provider_account_id: str, match_key: str
) -> JsonObject:
    """The most recent financial lines behind one external identity.

    Serves the Catalog row's detail dialog. Identity scope only — variant
    state is irrelevant, so a just-tracked identity still answers.
    """
    rows = SalesLine.objects.filter(
        user=user,
        channel=channel,
        provider_account_id=provider_account_id,
        match_key=match_key,
    )
    items = [
        {
            "id": str(row.id),
            "soldAt": row.sold_at.isoformat(),
            "timezone": row.timezone,
            "externalOrderId": row.external_order_id,
            "externalVariantTitle": row.external_variant_title,
            "quantity": float(row.quantity),
            "grossCents": row.gross_cents,
            "discountCents": row.discount_cents,
            "netSalesCents": row.net_sales_cents,
            "refundCents": row.refund_cents,
            "currencyCode": row.currency_code,
            "location": row.location,
            "employeeName": row.employee_name,
            "orderSource": row.order_source,
        }
        for row in rows.order_by("-sold_at", "-created_at")[:IDENTITY_LINES_LIMIT]
    ]
    return {"items": items, "lineCount": rows.count()}


def pending_review_count(user: User, ignored_keys: set[IdentityScope]) -> int:
    """Size the review queue without aggregating or rendering its rows.

    Counts the same two populations `menu_overview_payload`'s review section
    builds, so a page that asks for the count alone agrees with the tab.
    """
    unmatched = {
        key
        for key in SalesLine.objects.filter(user=user, variant__isnull=True)
        .order_by()
        .values_list("channel", "provider_account_id", "match_key")
        .distinct()
        if key not in ignored_keys
    }
    listed = set(
        SalesProductVariant.objects.filter(
            user=user, channel__in=PROVIDER_CHANNELS
        ).values_list("channel", "provider_account_id", "match_key")
    )
    connected = set(
        SalesChannelConnection.objects.filter(
            user=user, status=SalesChannelConnection.Status.ACTIVE
        ).values_list("provider", "provider_account_id")
    )
    catalog_only = sum(
        1
        for item in SalesCatalogItem.objects.filter(user=user, is_active=True)
        if catalog_item_is_pending(
            item,
            listed=listed,
            pending_keys=unmatched,
            ignored_keys=ignored_keys,
            connected=connected,
        )
    )
    return len(unmatched) + catalog_only


def pending_category_rows(pending: list[JsonObject]) -> list[JsonObject]:
    """Roll pending identity groups up by provider category.

    Uncategorized rows are a real bucket, not a gap, so they keep an empty
    `category` and are addressable by the same ignore action.
    """
    buckets: dict[tuple[str, str, str], JsonObject] = {}
    for group in pending:
        key = (
            group["channel"] or "",
            group["provider_account_id"] or "",
            group["agg_category"] or "",
        )
        bucket = buckets.get(key)
        if bucket is None:
            bucket = buckets[key] = {
                "channel": key[0],
                "providerAccountId": key[1],
                "category": key[2],
                "keyCount": 0,
                "catalogOnlyKeyCount": 0,
                "lineCount": 0,
                "netSalesCents": 0,
            }
        bucket["keyCount"] += 1
        bucket["catalogOnlyKeyCount"] += 1 if group.get("catalog_only") else 0
        bucket["lineCount"] += group["agg_line_count"]
        bucket["netSalesCents"] += group["agg_net_sales_cents"] or 0
    return sorted(
        buckets.values(),
        key=lambda row: (-row["keyCount"], row["channel"], row["category"]),
    )


def pending_groups_matching(
    pending: list[JsonObject], query: str
) -> list[JsonObject]:
    """Search every pending identity before the review payload is capped."""
    needle = query.strip().casefold()
    if not needle:
        return pending
    fields = ("agg_item_name", "agg_variant_name", "agg_sku", "agg_category")
    return [
        group
        for group in pending
        if any(needle in str(group.get(field) or "").casefold() for field in fields)
    ]


def pending_item_json(
    user: User,
    group: JsonObject,
    *,
    variants: VariantIndex,
    canonical_index: dict[str, list[SalesProduct]],
) -> JsonObject:
    match = resolve_item_variant(
        user,
        channel=group["channel"],
        provider_account_id=group["provider_account_id"],
        external_object_id=group["agg_external_object_id"] or "",
        product_external_object_id=(
            group["agg_product_external_object_id"] or ""
        ),
        group_key=group["match_key"],
        sku=group["agg_sku"] or "",
        item_name=group["agg_item_name"] or "",
        external_variant_title=group["agg_variant_name"] or "",
        variants=variants,
        canonical_index=canonical_index,
        suggest=True,
    )
    suggested = match.product if match.status == "suggested" else None
    return {
        "channel": group["channel"],
        "providerAccountId": group["provider_account_id"],
        "matchKey": group["match_key"],
        "externalObjectId": group["agg_external_object_id"] or "",
        "productExternalObjectId": (
            group["agg_product_external_object_id"] or ""
        ),
        "sku": group["agg_sku"] or "",
        "itemName": group["agg_item_name"] or "",
        "externalVariantTitle": group["agg_variant_name"] or "",
        "category": group["agg_category"] or "",
        "lineCount": group["agg_line_count"],
        "quantity": float(group["agg_quantity"] or 0),
        "orderSources": group.get("agg_order_sources") or [],
        "netSalesCents": group["agg_net_sales_cents"] or 0,
        "currencyCode": group["agg_currency_code"] or "",
        "hasModifiers": group["agg_has_modifiers"],
        "lastSoldAt": (
            group["agg_last_sold_at"].isoformat()
            if group["agg_last_sold_at"]
            else None
        ),
        "suggestedProductId": str(suggested.id) if suggested else None,
        "suggestedProductName": suggested.name if suggested else None,
        "suggestionReason": match.reason if suggested else None,
    }


def ignore_key_set(user: User) -> set[IdentityScope]:
    return set(
        SalesSkuIgnore.objects.filter(user=user).values_list(
            "channel", "provider_account_id", "match_key"
        )
    )


def rule_ignore_candidates(
    user: User, channels: Collection[str]
) -> Iterable[IgnoreCandidate]:
    """The two populations Review draws from, in the shape a rule reads.

    Modifier identities are excluded outright: they carry no variant and often
    no SKU, so two of the three fields a rule offers would silently never
    match. They also already inherit their parent's ignore.
    """
    for group in (
        SalesLine.objects.filter(
            user=user,
            variant__isnull=True,
            product__isnull=True,
            channel__in=channels,
        )
        .exclude(match_key__contains=":modifier:")
        .values("channel", "provider_account_id", "match_key")
        .annotate(
            agg_sku=Max("sku"),
            agg_item_name=Max("item_name"),
            agg_variant_name=Max("external_variant_title"),
        )
    ):
        if group["match_key"]:
            yield IgnoreCandidate(
                channel=group["channel"],
                provider_account_id=group["provider_account_id"],
                match_key=group["match_key"],
                sku=group["agg_sku"] or "",
                item_name=group["agg_item_name"] or "",
                external_variant_title=group["agg_variant_name"] or "",
            )
    for row in (
        SalesCatalogItem.objects.filter(
            user=user, is_active=True, channel__in=channels
        )
        .exclude(match_key__contains=":modifier:")
        .values(
            "channel",
            "provider_account_id",
            "match_key",
            "sku",
            "item_name",
            "external_variant_title",
        )
        .iterator(chunk_size=2000)
    ):
        yield IgnoreCandidate(**row)


def sweep_ignore_rules(
    user: User, *, channels: Collection[str] | None = None
) -> set[IdentityScope]:
    """Materialize every enabled rule's matches as ignore rows.

    Returns the identities it took, so a caller that already counted them as
    pending can correct itself rather than report two different answers.

    Unlike `apply_sku_ignores` this *skips* an identity a menu item already
    tracks instead of refusing the batch: the merchant is not standing here to
    read the refusal, and a raise would turn one rule into a failed sync.

    A workspace with no rule pays one query and takes no lock, because this
    runs on every sync and import whether or not anyone uses the feature.
    """

    def enabled_rules() -> list[SalesIgnoreRule]:
        return [
            rule
            for rule in SalesIgnoreRule.objects.filter(user=user, enabled=True)
            if rule.channel is None or channels is None or rule.channel in channels
        ]

    if not enabled_rules():
        return set()
    with transaction.atomic():
        lock_workspace(user)
        # Re-read under the lock: the rule may have gone in between.
        rules = enabled_rules()
        if not rules:
            return set()
        # A rule with no channel means every channel, but only ever the ones
        # this sweep was asked for: a Square sync must not scan Shopify.
        scope = VALID_CHANNELS if channels is None else set(channels) & VALID_CHANNELS
        rule_channels = {rule.channel for rule in rules if rule.channel is not None}
        if any(rule.channel is None for rule in rules):
            rule_channels |= scope
        claimed = ignore_key_set(user)
        tracked = set(
            SalesProductVariant.objects.filter(
                user=user, channel__in=rule_channels
            ).values_list("channel", "provider_account_id", "match_key")
        )
        connected = set(
            SalesChannelConnection.objects.filter(
                user=user, provider__in=rule_channels
            ).values_list("provider", "provider_account_id")
        )
        rows: list[SalesSkuIgnore] = []
        taken: set[IdentityScope] = set()
        for candidate in rule_ignore_candidates(user, rule_channels):
            key = identity_scope_key(
                candidate.channel, candidate.provider_account_id, candidate.match_key
            )
            if key in claimed or key in tracked:
                continue
            # A CSV identity carries no account and belongs to no connection.
            if (
                candidate.provider_account_id
                and (candidate.channel, candidate.provider_account_id) not in connected
            ):
                continue
            owner = next(
                (
                    rule
                    for rule in rules
                    if rule.channel in (None, candidate.channel)
                    and rule_matches(rule.conditions, candidate)
                ),
                None,
            )
            if owner is None:
                continue
            claimed.add(key)
            taken.add(key)
            rows.append(
                SalesSkuIgnore(
                    user=user,
                    rule=owner,
                    channel=candidate.channel,
                    provider_account_id=candidate.provider_account_id,
                    match_key=candidate.match_key,
                    sku=candidate.sku[:120],
                    external_name=candidate.item_name[:240],
                    external_variant_title=candidate.external_variant_title[:200],
                )
            )
            if len(rows) >= IGNORE_RULE_SWEEP_CAP:
                break
        # bulk_create skips SalesSkuIgnore.save(), whose only job is filling a
        # blank provider_account_id from the connection — every candidate here
        # already carries its own, and a CSV identity's blank is correct.
        # ignore_conflicts covers the degraded SQLite lock, where a concurrent
        # manual ignore may already hold the key; that row wins, as it should.
        SalesSkuIgnore.objects.bulk_create(
            rows, batch_size=500, ignore_conflicts=True
        )
        return taken


def unmatched_modifier_rows(
    user: User, ignored_parent_keys: set[IdentityScope] | None = None
) -> list[JsonObject]:
    """Aggregate unattached modifier occurrences into one row per identity.

    `ignored_parent_keys` drops occurrences sitting on an undecided-ignored
    parent line — a parent the merchant sent away should not keep pushing its
    modifiers into the queue. A *tracked* parent is unaffected, so its
    modifiers still surface, and un-ignoring the parent brings them straight
    back because nothing was deleted.
    """
    rows = SalesLineModifier.objects.filter(user=user, variant__isnull=True)
    ignored_parent = SalesSkuIgnore.objects.filter(
        user=user,
        channel=OuterRef("sales_line__channel"),
        provider_account_id=OuterRef("sales_line__provider_account_id"),
        match_key=OuterRef("sales_line__match_key"),
    )
    rows = rows.annotate(parent_is_ignored=Exists(ignored_parent)).exclude(
        sales_line__product__isnull=True, parent_is_ignored=True
    )
    return list(
        rows.values(
            "sales_line__channel",
            "sales_line__provider_account_id",
            "match_key",
        )
        .annotate(
            agg_name=Max("name"),
            agg_object_id=Max("external_object_id"),
            agg_sku=Max("sku"),
            agg_usage_count=Count("id"),
            agg_quantity=Sum("quantity"),
            agg_last_seen_at=Max("sales_line__sold_at"),
            agg_parent_name=Max("sales_line__item_name"),
            agg_channel=Max("sales_line__channel"),
        )
    )


def pending_modifier_rows(
    user: User, ignored_keys: set[IdentityScope]
) -> list[JsonObject]:
    """Modifier identities still waiting on a merchant decision."""
    rows: list[JsonObject] = []
    for group in unmatched_modifier_rows(user, ignored_keys):
        key = group["match_key"]
        channel = group["sales_line__channel"] or ""
        provider_account_id = group["sales_line__provider_account_id"] or ""
        if identity_scope_key(channel, provider_account_id, key) in ignored_keys:
            continue
        identity = parse_modifier_match_key(key)
        parent_name = group["agg_parent_name"] or ""
        name = group["agg_name"] or ""
        rows.append(
            {
                "channel": (
                    identity.channel if identity else channel
                ),
                "providerAccountId": provider_account_id,
                "matchKey": key,
                "name": name,
                "sku": group["agg_sku"] or "",
                "externalObjectId": group["agg_object_id"] or "",
                # The review inbox reads "Sampler > Chocolate Cookie".
                "contextLabel": f"{parent_name} > {name}" if parent_name else name,
                "usageCount": group["agg_usage_count"],
                "quantity": float(group["agg_quantity"] or 0),
                "lastSeenAt": (
                    group["agg_last_seen_at"].isoformat()
                    if group["agg_last_seen_at"]
                    else None
                ),
            }
        )
    rows.sort(key=lambda row: row["usageCount"], reverse=True)
    return rows


def pending_modifier_review_count(
    user: User, ignored_keys: set[IdentityScope]
) -> int:
    """Size the modifier queue without aggregating or rendering its rows.

    Counts the same identities `pending_modifier_rows` yields, so a page that
    asks for the count alone agrees with the Modifiers screen.
    """
    rows = SalesLineModifier.objects.filter(user=user, variant__isnull=True)
    ignored_parent = SalesSkuIgnore.objects.filter(
        user=user,
        channel=OuterRef("sales_line__channel"),
        provider_account_id=OuterRef("sales_line__provider_account_id"),
        match_key=OuterRef("sales_line__match_key"),
    )
    rows = rows.annotate(parent_is_ignored=Exists(ignored_parent)).exclude(
        sales_line__product__isnull=True, parent_is_ignored=True
    )
    return sum(
        1
        for channel, account, key in rows.order_by()
        .values_list(
            "sales_line__channel",
            "sales_line__provider_account_id",
            "match_key",
        )
        .distinct()
        if identity_scope_key(channel or "", account or "", key) not in ignored_keys
    )


def modifier_catalog_record_rows(
    user: User,
    pending_rows: list[JsonObject],
    active_catalog_keys: set[tuple[str, str, str]],
    *,
    channel: str,
    provider_account_id: str,
) -> list[JsonObject]:
    """Current pending facts plus mapped modifier ids no longer in a catalog.

    Square can replace a modifier object while retaining the same visible
    name. The active object is represented by ``SalesModifierOption``; older
    object ids still need to remain editable beside it so historical units do
    not disappear into a second review workflow.
    """

    records = [
        {
            **row,
            "variantId": None,
            "productId": None,
            "productName": None,
            "quantityMultiplier": 1,
        }
        for row in pending_rows
        if row["channel"] == channel
        and row["providerAccountId"] == provider_account_id
    ]

    historical_variants = list(
        SalesProductVariant.objects.filter(
            user=user,
            channel=channel,
            provider_account_id=provider_account_id,
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
        ).select_related("product")
    )
    historical_variants = [
        variant
        for variant in historical_variants
        if (
            variant.channel,
            variant.provider_account_id,
            variant.external_object_id,
        )
        not in active_catalog_keys
    ]
    if not historical_variants:
        return records

    occurrence_rows = SalesLineModifier.objects.filter(
        user=user, variant__in=historical_variants
    ).values(
        "variant_id",
        "match_key",
        "name",
        "sku",
        "external_object_id",
        "quantity",
        "sales_line__item_name",
        "sales_line__sold_at",
    )
    occurrences: dict[uuid.UUID, JsonObject] = {}
    for row in occurrence_rows:
        variant_id = row["variant_id"]
        stats = occurrences.setdefault(
            variant_id,
            {
                "usageCount": 0,
                "quantity": Decimal("0"),
                "lastSeenAt": None,
                "names": set(),
                "skus": set(),
                "objectIds": set(),
                "parentNames": set(),
            },
        )
        stats["usageCount"] += 1
        stats["quantity"] += row["quantity"] or Decimal("0")
        sold_at = row["sales_line__sold_at"]
        if sold_at and (stats["lastSeenAt"] is None or sold_at > stats["lastSeenAt"]):
            stats["lastSeenAt"] = sold_at
        if row["name"]:
            stats["names"].add(row["name"])
        if row["sku"]:
            stats["skus"].add(row["sku"])
        if row["external_object_id"]:
            stats["objectIds"].add(row["external_object_id"])
        if row["sales_line__item_name"]:
            stats["parentNames"].add(row["sales_line__item_name"])

    for variant in historical_variants:
        stats = occurrences.get(
            variant.id,
            {
                "usageCount": 0,
                "quantity": Decimal("0"),
                "lastSeenAt": None,
                "names": set(),
                "skus": set(),
                "objectIds": set(),
                "parentNames": set(),
            },
        )
        parent_names = stats["parentNames"]
        names = stats["names"]
        skus = stats["skus"]
        object_ids = stats["objectIds"]
        parent_name = next(iter(parent_names)) if len(parent_names) == 1 else ""
        name = variant.external_name or (next(iter(names)) if len(names) == 1 else "")
        external_object_id = variant.external_object_id or (
            next(iter(object_ids)) if len(object_ids) == 1 else ""
        )
        records.append(
            {
                "channel": variant.channel,
                "providerAccountId": variant.provider_account_id,
                "matchKey": variant.match_key,
                "name": name,
                "sku": variant.sku or (next(iter(skus)) if len(skus) == 1 else ""),
                "externalObjectId": external_object_id,
                "contextLabel": f"{parent_name} > {name}" if parent_name else name,
                "usageCount": stats["usageCount"],
                "quantity": float(stats["quantity"]),
                "lastSeenAt": (
                    stats["lastSeenAt"].isoformat() if stats["lastSeenAt"] else None
                ),
                "variantId": str(variant.id),
                "productId": str(variant.product_id),
                "productName": variant.product.name,
                "quantityMultiplier": float(variant.quantity_multiplier),
            }
        )
    return records


def place_modifier_records_in_catalog(
    modifier_lists: list[JsonObject], records: list[JsonObject]
) -> list[JsonObject]:
    """Put every sales record beside the one catalog list that explains it.

    Exact Square object identity wins, followed by a unique option-name match.
    Modifier identity is provider-global, so parent item context cannot select
    a list. Anything genuinely ambiguous stays in the fallback list instead of
    being guessed into the wrong modifier list.
    """

    by_object: dict[tuple[str, str], set[int]] = defaultdict(set)
    by_option_name: dict[tuple[str, str], set[int]] = defaultdict(set)
    for index, modifier_list in enumerate(modifier_lists):
        modifier_list["records"] = []
        channel = modifier_list["channel"]
        for option in modifier_list["options"]:
            by_object[(channel, option["externalObjectId"])].add(index)
            option_name = canonical_name(option["name"])
            if option_name:
                by_option_name[(channel, option_name)].add(index)

    unassigned: list[JsonObject] = []
    for record in records:
        channel = record["channel"]
        candidates = by_object.get(
            (channel, record["externalObjectId"]), set()
        )
        if len(candidates) != 1:
            candidates = by_option_name.get(
                (channel, canonical_name(record["name"])), set()
            )
        if len(candidates) == 1:
            modifier_lists[next(iter(candidates))]["records"].append(record)
        else:
            unassigned.append(record)

    for modifier_list in modifier_lists:
        modifier_list["records"].sort(
            key=lambda row: (-row["usageCount"], canonical_name(row["name"]))
        )
    unassigned.sort(key=lambda row: (-row["usageCount"], canonical_name(row["name"])))
    return unassigned


def net_sales_trend(
    tracked,
    *,
    user: User,
    currency_code: str,
    selected_date: date | None = None,
    selected_end_date: date | None = None,
    comparison: str = "prior_day",
    trend_timezone: str | None = None,
) -> JsonObject:
    """Build a selected period's net-sales comparison.

    The workspace timezone sets the business day unless the caller names one,
    so an overnight UTC conversion never moves an imported daytime sale onto
    the wrong period.
    Single-day selections use the familiar hourly chart; multi-day selections
    use daily totals, with an equal-length comparison period.

    Every figure here is one currency: `tracked` arrives filtered to
    `currency_code` and the invoice totals filter to it too, so the prime-cost
    ratio never divides one currency by another.
    """
    latest = tracked.order_by("-sold_at").first()
    latest_labor = None
    latest_invoice_date = None
    if latest is None:
        latest_labor = (
            TimeEntry.objects.filter(user=user)
            .select_related("labor_import")
            .order_by("-clock_in")
            .first()
        )
        latest_invoice_date = (
            Invoice.objects.filter(user=user, invoice_date__isnull=False)
            .order_by("-invoice_date")
            .values_list("invoice_date", flat=True)
            .first()
        )
    empty = {
        "currentDate": None,
        "previousDate": None,
        "comparisonDate": None,
        "periodStart": None,
        "periodEnd": None,
        "comparisonStart": None,
        "comparisonEnd": None,
        "granularity": "hour",
        "comparison": comparison,
        "availableDates": [],
        "timezone": "UTC",
        "currencyCode": currency_code,
        "financials": {
            "currentLaborCents": 0,
            "previousLaborCents": 0,
            "currentInvoiceCents": 0,
            "previousInvoiceCents": 0,
            "currentInvoiceCount": 0,
            "previousInvoiceCount": 0,
        },
        "hours": [
            {
                "hour": hour,
                "currentSquareCents": 0,
                "currentShopifyCents": 0,
                "currentManualCents": 0,
                "previousSquareCents": 0,
                "previousShopifyCents": 0,
                "previousManualCents": 0,
            }
            for hour in range(24)
        ],
        "days": [],
    }
    if latest is None and latest_labor is None and latest_invoice_date is None:
        return empty

    sales_timezone = known_zone(trend_timezone) or workspace_zone(user)

    if latest is not None:
        latest_date = latest.sold_at.astimezone(sales_timezone).date()
    else:
        operational_dates = []
        if latest_labor is not None:
            operational_dates.append(
                latest_labor.clock_in.astimezone(sales_timezone).date()
            )
        if latest_invoice_date is not None:
            operational_dates.append(latest_invoice_date)
        latest_date = max(operational_dates)
    current_start = selected_date or latest_date
    current_end = selected_end_date or current_start
    period_days = (current_end - current_start).days + 1
    previous_start, previous_end = trend_comparison_window(
        current_start, period_days, comparison
    )
    window_start = datetime.combine(previous_start, time.min, tzinfo=sales_timezone)
    window_end = datetime.combine(
        current_end + timedelta(days=1), time.min, tzinfo=sales_timezone
    )
    available_window_start = datetime.combine(
        latest_date - timedelta(days=90), time.min, tzinfo=sales_timezone
    )
    available_date_values = {
        day.isoformat()
        for day in tracked.filter(sold_at__gte=available_window_start)
        .annotate(day=TruncDate("sold_at", tzinfo=sales_timezone))
        .order_by()
        .values_list("day", flat=True)
        .distinct()
    }
    if latest is None:
        available_date_values.update(
            day.isoformat()
            for day in TimeEntry.objects.filter(
                user=user, clock_in__gte=available_window_start
            )
            .annotate(day=TruncDate("clock_in", tzinfo=sales_timezone))
            .order_by()
            .values_list("day", flat=True)
            .distinct()
        )
        available_date_values.update(
            invoice_date.isoformat()
            for invoice_date in Invoice.objects.filter(
                user=user,
                invoice_date__gte=available_window_start.date(),
            ).values_list("invoice_date", flat=True)
        )
    available_dates = sorted(available_date_values, reverse=True)[:31]
    hours = empty["hours"]
    days = [
        {
            "date": (current_start + timedelta(days=offset)).isoformat(),
            "currentSquareCents": 0,
            "currentShopifyCents": 0,
            "currentManualCents": 0,
            "previousSquareCents": 0,
            "previousShopifyCents": 0,
            "previousManualCents": 0,
        }
        for offset in range(period_days)
    ]

    # Bucketed by the request's sales timezone, never by the stored `sold_on`
    # column: that one carries the provider's own zone.
    bucket_keys = ["day", "channel"]
    trend_buckets = tracked.filter(
        sold_at__gte=window_start, sold_at__lt=window_end
    ).annotate(day=TruncDate("sold_at", tzinfo=sales_timezone))
    if period_days == 1:
        trend_buckets = trend_buckets.annotate(
            hour=ExtractHour("sold_at", tzinfo=sales_timezone)
        )
        bucket_keys.append("hour")
    for row in (
        trend_buckets.order_by()
        .values(*bucket_keys)
        .annotate(total=Sum("net_sales_cents"))
    ):
        day = row["day"]
        if current_start <= day <= current_end:
            period = "current"
            day_offset = (day - current_start).days
        elif previous_start <= day <= previous_end:
            period = "previous"
            day_offset = (day - previous_start).days
        else:
            continue
        channel = {
            SalesImport.Channel.SQUARE: "Square",
            SalesImport.Channel.SHOPIFY: "Shopify",
            SalesImport.Channel.MANUAL: "Manual",
        }[row["channel"]]
        if period_days == 1:
            hours[row["hour"]][f"{period}{channel}Cents"] += row["total"]
        else:
            days[day_offset][f"{period}{channel}Cents"] += row["total"]

    def labor_cents_for(start_date: date, end_date: date) -> int:
        day_start = datetime.combine(start_date, time.min, tzinfo=sales_timezone)
        day_end = datetime.combine(
            end_date + timedelta(days=1), time.min, tzinfo=sales_timezone
        )
        totals = TimeEntry.objects.filter(
            user=user, clock_in__gte=day_start, clock_in__lt=day_end
        ).aggregate(total=Sum("labor_cost_cents"))
        return totals["total"] or 0

    def invoice_totals_for(start_date: date, end_date: date) -> tuple[int, int]:
        totals = Invoice.objects.filter(
            user=user,
            currency_code=currency_code,
            invoice_date__gte=start_date,
            invoice_date__lte=end_date,
        ).aggregate(total=Sum("total_cents"), count=Count("id"))
        return totals["total"] or 0, totals["count"] or 0

    current_invoice_cents, current_invoice_count = invoice_totals_for(
        current_start, current_end
    )
    previous_invoice_cents, previous_invoice_count = invoice_totals_for(
        previous_start, previous_end
    )

    return {
        "currentDate": current_start.isoformat(),
        "previousDate": previous_start.isoformat(),
        "comparisonDate": previous_start.isoformat(),
        "periodStart": current_start.isoformat(),
        "periodEnd": current_end.isoformat(),
        "comparisonStart": previous_start.isoformat(),
        "comparisonEnd": previous_end.isoformat(),
        "granularity": "hour" if period_days == 1 else "day",
        "comparison": comparison,
        "availableDates": available_dates,
        "timezone": sales_timezone.key,
        "currencyCode": currency_code,
        "financials": {
            "currentLaborCents": labor_cents_for(current_start, current_end),
            "previousLaborCents": labor_cents_for(previous_start, previous_end),
            "currentInvoiceCents": current_invoice_cents,
            "previousInvoiceCents": previous_invoice_cents,
            "currentInvoiceCount": current_invoice_count,
            "previousInvoiceCount": previous_invoice_count,
        },
        "hours": hours,
        "days": days if period_days > 1 else [],
    }


def sales_overview_payload(
    user: User,
    *,
    trend_date: date | None = None,
    trend_end_date: date | None = None,
    trend_comparison: str = "prior_day",
    trend_timezone: str | None = None,
) -> JsonObject:
    # Variant attachment is the mapping decision.
    tracked = SalesLine.objects.filter(user=user, variant__isnull=False)
    # Sales are document money and are never restated, so a workspace that
    # connected a foreign-currency POS or changed its own currency holds rows
    # in more than one code. Summing those together and labelling the result
    # with one code is nonsense, so the one-figure sections keep only the
    # workspace currency and report how many lines they set aside.
    currency_code = workspace_currency_code(user)
    in_currency = tracked.filter(currency_code=currency_code)
    trend = net_sales_trend(
        in_currency,
        user=user,
        currency_code=currency_code,
        selected_date=trend_date,
        selected_end_date=trend_end_date,
        comparison=trend_comparison,
        trend_timezone=trend_timezone,
    )
    period_start = (
        date.fromisoformat(trend["periodStart"]) if trend["periodStart"] else None
    )
    period_end = date.fromisoformat(trend["periodEnd"]) if trend["periodEnd"] else None
    period_timezone = ZoneInfo(trend["timezone"])
    totals = in_currency.aggregate(
        line_count=Count("id"),
        quantity=Sum("quantity"),
        gross_cents=Sum("gross_cents"),
        discount_cents=Sum("discount_cents"),
        net_sales_cents=Sum("net_sales_cents"),
        tax_cents=Sum("tax_cents"),
        refund_cents=Sum("refund_cents"),
    )
    summary = {
        "currencyCode": currency_code,
        "lineCount": totals["line_count"] or 0,
        "quantity": float(totals["quantity"] or 0),
        "grossCents": totals["gross_cents"] or 0,
        "discountCents": totals["discount_cents"] or 0,
        "netSalesCents": totals["net_sales_cents"] or 0,
        "taxCents": totals["tax_cents"] or 0,
        "refundCents": totals["refund_cents"] or 0,
        "orderCount": in_currency.values("channel", "external_order_id")
        .distinct()
        .count(),
        "excludedLineCount": tracked.exclude(currency_code=currency_code).count(),
    }

    ignored_keys = ignore_key_set(user)
    pending_sku_count = 0
    pending_line_count = 0
    pending_net_sales_cents = 0
    ignored_line_count = 0
    ignored_net_sales_cents = 0
    excluded_scope_key_count = 0
    for group in unmatched_group_rows(user):
        scope = identity_scope_key(
            group["channel"],
            group["provider_account_id"],
            group["match_key"],
        )
        if group["agg_currency_code"] != currency_code:
            excluded_scope_key_count += 1
            continue
        if scope in ignored_keys:
            ignored_line_count += group["agg_line_count"]
            ignored_net_sales_cents += group["agg_net_sales_cents"] or 0
            continue
        pending_sku_count += 1
        pending_line_count += group["agg_line_count"]
        pending_net_sales_cents += group["agg_net_sales_cents"] or 0

    pending_modifiers = pending_modifier_rows(user, ignored_keys)
    manual_scope = tracked
    if trend["periodStart"] and trend["periodEnd"]:
        manual_zone = known_zone(trend["timezone"]) or workspace_zone(user)
        manual_start = datetime.combine(
            date.fromisoformat(trend["periodStart"]), time.min, tzinfo=manual_zone
        )
        manual_end = datetime.combine(
            date.fromisoformat(trend["periodEnd"]) + timedelta(days=1),
            time.min,
            tzinfo=manual_zone,
        )
        manual_scope = manual_scope.filter(
            sold_at__gte=manual_start, sold_at__lt=manual_end
        )
    incomplete_manual_revenue = manual_scope.filter(
        channel=SalesImport.Channel.MANUAL
    ).filter(
        Q(source_payload__netProvided=False) | Q(source_payload={})
    ).exists()
    return {
        "summary": summary,
        "netSalesTrend": trend,
        "scope": {
            "currencyCode": currency_code,
            "pendingSkuCount": pending_sku_count,
            "pendingLineCount": pending_line_count,
            "pendingNetSalesCents": pending_net_sales_cents,
            "ignoredSkuCount": SalesSkuIgnore.objects.filter(user=user).count(),
            "ignoredLineCount": ignored_line_count,
            "ignoredNetSalesCents": ignored_net_sales_cents,
            "pendingModifierCount": len(pending_modifiers),
            "pendingModifierOccurrenceCount": sum(
                row["usageCount"] for row in pending_modifiers
            ),
            "excludedSkuCount": excluded_scope_key_count,
        },
        "dailySales": daily_sales_rows(user),
        "topProducts": period_product_sales_rows(
            in_currency,
            period_start,
            period_end,
            period_timezone,
            ignored_keys,
            index=bundles.BundleIndex.for_user(user),
        ),
        "imports": sales_imports_payload(user)["items"],
        "incompleteManualRevenue": incomplete_manual_revenue,
    }


def sales_imports_payload(user: User) -> JsonObject:
    rows = list(
        SalesImport.objects.filter(user=user, channel__in=PROVIDER_CHANNELS)[:20]
    )
    latest_active = next((row for row in rows if row.undone_at is None), None)
    return {
        "items": [
            sales_import_json(
                row,
                can_undo=(latest_active is not None and row.id == latest_active.id),
            )
            for row in rows
        ]
    }


def _manual_sold_on(body: JsonObject) -> date:
    raw = body.get("soldOn")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("soldOn must be a date")
    try:
        return date.fromisoformat(raw.strip())
    except ValueError as exc:
        raise ValueError("soldOn must be a date") from exc


def _manual_month_end(month: date) -> date:
    return (month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(
        days=1
    )


def _manual_source_position(
    product_id: uuid.UUID, sold_on: date, sales_import: SalesImport
) -> int:
    """Stable positive position, with a deterministic probe for hash clashes."""
    digest = hashlib.blake2b(
        f"{sales_import.id}:{product_id}:{sold_on.isoformat()}".encode(), digest_size=4
    ).digest()
    position = int.from_bytes(digest, "big") & 0x7FFFFFFF
    position = position or 1
    while SalesLine.objects.filter(
        sales_import=sales_import, source_position=position
    ).exists():
        position = position + 1 if position < 0x7FFFFFFF else 1
    return position


def _manual_variant(user: User, product: SalesProduct) -> SalesProductVariant:
    match_key = f"manual:item:{product.id}"
    variant = (
        SalesProductVariant.objects.select_for_update()
        .filter(user=user, channel=SalesImport.Channel.MANUAL, product=product)
        .first()
    )
    if variant is None:
        try:
            with transaction.atomic():
                variant = SalesProductVariant.objects.create(
                    user=user,
                    product=product,
                    channel=SalesImport.Channel.MANUAL,
                    provider_account_id="",
                    match_key=match_key,
                    sku=product.sku,
                    external_name=product.name,
                    identity_kind=SalesProductVariant.IdentityKind.ITEM,
                    quantity_multiplier=Decimal("1"),
                    link_source=SalesProductVariant.LinkSource.SYSTEM,
                )
        except IntegrityError:
            variant = (
                SalesProductVariant.objects.select_for_update()
                .filter(
                    user=user,
                    channel=SalesImport.Channel.MANUAL,
                    product=product,
                )
                .first()
            )
            if variant is None:
                raise
    return variant


def _refresh_manual_import_totals(sales_import: SalesImport) -> dict[str, Any]:
    totals = sales_import.lines.aggregate(
        line_count=Count("id"),
        quantity=Sum("quantity"),
        gross_cents=Sum("gross_cents"),
        discount_cents=Sum("discount_cents"),
        net_sales_cents=Sum("net_sales_cents"),
        tax_cents=Sum("tax_cents"),
        refund_cents=Sum("refund_cents"),
    )
    line_count = totals["line_count"] or 0
    currencies = set(
        sales_import.lines.values_list("currency_code", flat=True).distinct()
    )
    mixed_currency = len(currencies) > 1
    if mixed_currency:
        # A monthly container can span a workspace-currency change. Its rows
        # retain the currency captured at write time, but the container must
        # never present an incomparable cents sum as one currency.
        total_currency = ""
        gross_cents = discount_cents = net_sales_cents = tax_cents = refund_cents = 0
    else:
        total_currency = next(iter(currencies), sales_import.currency_code)
        gross_cents = totals["gross_cents"] or 0
        discount_cents = totals["discount_cents"] or 0
        net_sales_cents = totals["net_sales_cents"] or 0
        tax_cents = totals["tax_cents"] or 0
        refund_cents = totals["refund_cents"] or 0
    sales_import.total_rows = line_count
    sales_import.imported_count = line_count
    sales_import.order_count = line_count
    sales_import.currency_code = total_currency
    sales_import.gross_cents = gross_cents
    sales_import.discount_cents = discount_cents
    sales_import.net_sales_cents = net_sales_cents
    sales_import.tax_cents = tax_cents
    sales_import.refund_cents = refund_cents
    sales_import.save(
        update_fields=[
            "total_rows",
            "imported_count",
            "order_count",
            "gross_cents",
            "discount_cents",
            "net_sales_cents",
            "tax_cents",
            "refund_cents",
            "currency_code",
            "updated_at",
        ]
    )
    return {
        "lineCount": line_count,
        "quantity": float(totals["quantity"] or 0),
        "grossCents": gross_cents,
        "netSalesCents": net_sales_cents,
        "currencyCode": total_currency or None,
    }


def action_record_manual_sales(user: User, body: JsonObject) -> JsonObject:
    """Upsert one Product/day row in the workspace's manual sales ledger."""
    unknown = set(body) - {"productId", "soldOn", "quantity", "totalNetCents"}
    if unknown:
        raise ValueError("Manual sale fields are not supported")
    product_ref = body.get("productId")
    if product_ref is None:
        raise ValueError("Product is required")
    sold_on = _manual_sold_on(body)
    if "quantity" not in body:
        raise ValueError("Quantity is required")
    quantity = number_value(
        body["quantity"],
        "Quantity",
        minimum=0,
        maximum=1000000,
    )
    quantity_decimal = Decimal(str(quantity)).quantize(Decimal("0.001"))
    if quantity_decimal < 0:
        raise ValueError("Quantity cannot be negative")
    if quantity_decimal > 0 and quantity_decimal < Decimal("0.001"):
        raise ValueError("Quantity is too small")
    deleting = quantity_decimal == 0
    net_provided = "totalNetCents" in body
    if net_provided:
        net_cents = signed_cents(body["totalNetCents"], "Total net sales")
        if net_cents < 0:
            raise ValueError("Total net sales cannot be negative")
    else:
        net_cents = 0

    with transaction.atomic():
        lock_workspace(user)
        product = _sales_product_queryset(user, product_ref).select_for_update().first()
        if product is None:
            raise ValueError("Product not found")
        settings = (
            BenchCostSettings.objects.select_for_update().filter(user=user).first()
        )
        workspace_currency = (settings.currency_code if settings else "USD") or "USD"
        timezone_name = settings.timezone if settings and settings.timezone else None
        if known_zone(timezone_name) is None:
            timezone_name = workspace_timezone_name(user)
        zone = known_zone(timezone_name) or ZoneInfo("UTC")
        month = sold_on.replace(day=1)
        sold_at = datetime.combine(sold_on, time(12), tzinfo=zone)
        fingerprint = f"manual:{product.id}:{sold_on.isoformat()}"[:64]
        sales_import = (
            SalesImport.objects.select_for_update()
            .filter(
                user=user,
                channel=SalesImport.Channel.MANUAL,
                source=SalesImport.Source.MANUAL,
                period_start=month,
            )
            .first()
        )
        if sales_import is None and deleting:
            return {
                "ok": True,
                "deleted": False,
                "productId": str(product.id),
                "publicId": product.public_id,
                "soldOn": sold_on.isoformat(),
                "importId": None,
                "monthTotals": {
                    "lineCount": 0,
                    "quantity": 0.0,
                    "grossCents": 0,
                    "netSalesCents": 0,
                    "currencyCode": workspace_currency,
                },
            }
        if sales_import is None:
            sales_import = SalesImport.objects.create(
                user=user,
                channel=SalesImport.Channel.MANUAL,
                source=SalesImport.Source.MANUAL,
                period_start=month,
                file_name=f"Manual sales {month:%Y-%m}",
                provider_account_id="",
                timezone=str(zone.key),
                currency_code=workspace_currency,
                period_end=_manual_month_end(month),
            )
        line = (
            SalesLine.objects.select_for_update()
            .filter(
                user=user,
                channel=SalesImport.Channel.MANUAL,
                provider_account_id="",
                source_fingerprint=fingerprint,
            )
            .first()
        )
        if deleting:
            if line is not None:
                line.delete()
            totals = _refresh_manual_import_totals(sales_import)
            return {
                "ok": True,
                "deleted": line is not None,
                "productId": str(product.id),
                "publicId": product.public_id,
                "soldOn": sold_on.isoformat(),
                "importId": str(sales_import.id),
                "monthTotals": totals,
            }
        variant = _manual_variant(user, product)
        if line is None:
            line = SalesLine(
                user=user,
                sales_import=sales_import,
                product=product,
                variant=variant,
                channel=SalesImport.Channel.MANUAL,
                provider_account_id="",
                source_position=_manual_source_position(product.id, sold_on, sales_import),
                source_fingerprint=fingerprint,
                provider_record_id="",
                external_order_id=fingerprint,
                sold_at=sold_at,
                timezone=str(zone.key),
                sku=product.sku,
                item_name=product.name,
                group_key=variant.match_key,
                match_key=variant.match_key,
                quantity=quantity_decimal,
                gross_cents=0,
                discount_cents=0,
                net_sales_cents=net_cents,
                tax_cents=0,
                refund_cents=0,
                currency_code=workspace_currency,
                source_payload={
                    "manual": True,
                    "soldOn": sold_on.isoformat(),
                    "netProvided": net_provided,
                },
            )
        else:
            line.product = product
            line.variant = variant
            line.sold_at = sold_at
            line.timezone = str(zone.key)
            line.currency_code = workspace_currency
            line.sku = product.sku
            line.item_name = product.name
            line.group_key = variant.match_key
            line.match_key = variant.match_key
            line.quantity = quantity_decimal
            line.gross_cents = 0
            line.discount_cents = 0
            line.net_sales_cents = net_cents
            line.tax_cents = 0
            line.refund_cents = 0
            line.source_payload = {
                "manual": True,
                "soldOn": sold_on.isoformat(),
                "netProvided": net_provided,
            }
        line.save()
        totals = _refresh_manual_import_totals(sales_import)
    return {
        "ok": True,
        "deleted": False,
        "id": str(line.id),
        "importId": str(sales_import.id),
        "productId": str(product.id),
        "publicId": product.public_id,
        "soldOn": sold_on.isoformat(),
        "quantity": float(line.quantity),
        "grossCents": line.gross_cents,
        "netSalesCents": line.net_sales_cents,
        "netProvided": bool(line.source_payload.get("netProvided", False)),
        "currencyCode": line.currency_code,
        "monthTotals": totals,
    }


def _attributed_column_sum(column: str) -> Sum:
    """`attributed_cents` as a SQL sum over a direct variant's lines.

    Direct variants never leave their callers' grouped queries — the product
    rollup here and the daily rollup in `daily_sales_rows` — so the
    attribution rounding has to be reproduced here rather than borrowed from
    `_variant_contributions`. Scaling happens per line and only then sums,
    because the floor of a sum is not the sum of the floors, and the parity
    oracle in `test_menu_overview_queries` compares the two paths line by
    line.
    """
    sign = Case(
        When(**{f"{column}__lt": 0}, then=Value(-1)),
        default=Value(1),
        output_field=IntegerField(),
    )
    magnitude = ExpressionWrapper(
        Func(F(column), function="ABS")
        * Coalesce(F("variant__attribution_percent"), Value(100))
        / Value(100),
        output_field=IntegerField(),
    )
    return Sum(ExpressionWrapper(sign * magnitude, output_field=IntegerField()))


def product_sales_stats(
    user: User,
    product_ids: Collection[uuid.UUID] | None = None,
    *,
    sold_at_range: tuple[datetime, datetime] | None = None,
    currency_code: str | None = None,
    index: bundles.BundleIndex | None = None,
    expand_bundles: bool = True,
) -> dict[uuid.UUID, JsonObject]:
    """Attributed sales per product, in a fixed number of grouped queries.

    Plain products group in SQL; only bundles, whose money splits by a value
    ladder no aggregate can express, need the Python walk. `product_ids`
    scopes every read to one page of products, so a browse response never
    pays for the whole catalog. `sold_at_range` is a half-open [start, end)
    window on the sale moment; None keeps the all-time totals.
    """
    if expand_bundles and index is None:
        index = bundles.BundleIndex.for_user(user)
    bundle_ids = index.bundle_ids if expand_bundles and index is not None else set()
    product_stats: dict[uuid.UUID, JsonObject] = {}
    direct_lines = SalesLine.objects.filter(
        user=user,
        variant__product__isnull=False,
    ).exclude(variant__product_id__in=bundle_ids)
    direct_modifiers = (
        SalesLineModifier.objects.filter(
            sales_line__user=user,
            sales_line__variant__isnull=False,
            variant__product__isnull=False,
        )
        .exclude(variant__product_id__in=bundle_ids)
        .exclude(quantity=0)
    )
    bundle_lines = SalesLine.objects.filter(
        user=user, variant__product_id__in=bundle_ids
    )
    bundle_modifiers = SalesLineModifier.objects.filter(
        sales_line__user=user,
        sales_line__variant__isnull=False,
        variant__product_id__in=bundle_ids,
    ).exclude(quantity=0)
    if sold_at_range is not None:
        window_start, window_end = sold_at_range
        direct_lines = direct_lines.filter(
            sold_at__gte=window_start, sold_at__lt=window_end
        )
        direct_modifiers = direct_modifiers.filter(
            sales_line__sold_at__gte=window_start,
            sales_line__sold_at__lt=window_end,
        )
        bundle_lines = bundle_lines.filter(
            sold_at__gte=window_start, sold_at__lt=window_end
        )
        bundle_modifiers = bundle_modifiers.filter(
            sales_line__sold_at__gte=window_start,
            sales_line__sold_at__lt=window_end,
        )
    if currency_code is not None:
        direct_lines = direct_lines.filter(currency_code=currency_code)
        direct_modifiers = direct_modifiers.filter(
            sales_line__currency_code=currency_code
        )
        bundle_lines = bundle_lines.filter(currency_code=currency_code)
        bundle_modifiers = bundle_modifiers.filter(
            sales_line__currency_code=currency_code
        )
    if product_ids is not None:
        direct_lines = direct_lines.filter(variant__product_id__in=product_ids)
        direct_modifiers = direct_modifiers.filter(
            variant__product_id__in=product_ids
        )
        # A bundle is read whole — its allocation needs every member — and a
        # page product may sit several bundles deep, so the filter takes the
        # transitive parents too and the off-page products it also resolves
        # are dropped at the end.
        scoped_bundles = bundle_ids & (
            set(product_ids)
            | (index.bundles_containing(product_ids) if index is not None else set())
        )
        bundle_lines = bundle_lines.filter(variant__product_id__in=scoped_bundles)
        bundle_modifiers = bundle_modifiers.filter(
            variant__product_id__in=scoped_bundles
        )

    direct_rows = direct_lines.values("variant__product_id").annotate(
        line_count=Count("id"),
        total_quantity=Sum(
            ExpressionWrapper(
                F("quantity") * F("variant__quantity_multiplier"),
                output_field=DecimalField(max_digits=24, decimal_places=6),
            )
        ),
        total_gross_cents=_attributed_column_sum("gross_cents"),
        total_discount_cents=_attributed_column_sum("discount_cents"),
        total_net_sales_cents=_attributed_column_sum("net_sales_cents"),
        total_tax_cents=_attributed_column_sum("tax_cents"),
        total_refund_cents=_attributed_column_sum("refund_cents"),
    )
    for row in direct_rows:
        stats = product_stats.setdefault(
            row["variant__product_id"], dict(EMPTY_PRODUCT_SALES)
        )
        stats["lineCount"] += row["line_count"]
        stats["quantity"] += float(row["total_quantity"])
        stats["totalQuantity"] += float(row["total_quantity"])
        stats["grossCents"] += row["total_gross_cents"]
        stats["discountCents"] += row["total_discount_cents"]
        stats["netSalesCents"] += row["total_net_sales_cents"]
        stats["attributedNetSalesCents"] += row["total_net_sales_cents"]
        stats["asSoldNetSalesCents"] += row["total_net_sales_cents"]
        stats["taxCents"] += row["total_tax_cents"]
        stats["refundCents"] += row["total_refund_cents"]

    modifier_rows = direct_modifiers.values("variant__product_id").annotate(
        total_quantity=Sum(
            ExpressionWrapper(
                F("sales_line__quantity")
                * F("quantity")
                * F("variant__quantity_multiplier"),
                output_field=DecimalField(max_digits=30, decimal_places=9),
            )
        )
    )
    for row in modifier_rows:
        stats = product_stats.setdefault(
            row["variant__product_id"], dict(EMPTY_PRODUCT_SALES)
        )
        stats["quantity"] += float(row["total_quantity"])
        stats["totalQuantity"] += float(row["total_quantity"])

    expanded: list[ProductContribution] = []
    as_sold_net: dict[uuid.UUID, int] = defaultdict(int)
    if bundle_ids:
        for line in (
            bundle_lines.only(
                "quantity",
                "gross_cents",
                "discount_cents",
                "net_sales_cents",
                "tax_cents",
                "refund_cents",
                "variant_id",
            )
            .select_related("variant", "variant__product")
        ):
            expanded.extend(
                _variant_contributions(
                    line.variant,
                    line.quantity,
                    source="base",
                    index=index,
                    gross_cents=line.gross_cents,
                    discount_cents=line.discount_cents,
                    net_sales_cents=line.net_sales_cents,
                    tax_cents=line.tax_cents,
                    refund_cents=line.refund_cents,
                )
            )
            # The bundle's own row gives its money away, so what it sold for
            # has to be remembered before the split.
            as_sold_net[line.variant.product_id] += attributed_cents(
                line.variant, line.net_sales_cents
            )
        for occurrence in (
            bundle_modifiers.only("quantity", "variant_id", "sales_line__quantity")
            .select_related("variant", "variant__product", "sales_line")
        ):
            expanded.extend(
                _variant_contributions(
                    occurrence.variant,
                    occurrence.sales_line.quantity * occurrence.quantity,
                    source="modifier",
                    index=index,
                )
            )
    for contribution in expanded:
        stats = product_stats.setdefault(
            contribution.product.id, dict(EMPTY_PRODUCT_SALES)
        )
        # Only the as-sold row counts the line: counting it once per member
        # is why per-product line counts never summed to the ledger's.
        if contribution.source == "base" and not contribution.via_bundle:
            stats["lineCount"] += 1
        stats["quantity"] += float(contribution.quantity)
        stats["totalQuantity"] += float(contribution.quantity)
        stats["grossCents"] += contribution.gross_cents
        stats["discountCents"] += contribution.discount_cents
        stats["netSalesCents"] += contribution.net_sales_cents
        stats["attributedNetSalesCents"] += contribution.net_sales_cents
        stats["taxCents"] += contribution.tax_cents
        stats["refundCents"] += contribution.refund_cents
    for product_id, stats in product_stats.items():
        if product_id not in bundle_ids:
            continue
        # Its money is on the products inside it, whether or not this scope
        # caught a sale of the box itself.
        stats["sharedToMembers"] = True
        stats["splitBasis"] = index.split_basis(product_id)
        stats["asSoldNetSalesCents"] += as_sold_net.get(product_id, 0)

    if product_ids is None:
        return product_stats
    wanted = set(product_ids)
    return {
        product_id: stats
        for product_id, stats in product_stats.items()
        if product_id in wanted
    }


MENU_ITEM_ORDERS = frozenset(
    {
        "name",
        "-name",
        "sku",
        "-sku",
        "category",
        "-category",
        "price",
        "-price",
        "updatedAt",
        "-updatedAt",
    }
)


MENU_ITEM_STATUSES = frozenset({"active", "inactive"})


def menu_items_payload(
    user: User,
    browse: BrowseQuery,
    *,
    status: str | None = None,
) -> JsonObject:
    """One page of menu items in the menu-overview item shape.

    Products is a catalog: a row describes what the merchant sells, and
    carries no sales figures. Search, the active/inactive filter and sort all
    run in the database so the browser never holds the whole catalog.
    """
    owned = SalesProduct.objects.filter(user=user)
    rows = owned
    if status is not None:
        if status not in MENU_ITEM_STATUSES:
            raise ValueError("Invalid status")
        rows = rows.filter(is_active=status == "active")
    rows = rows.prefetch_related(
        "skus",
        "variants",
        "components__recipe",
        "components__ingredient",
        "components__component_product",
    )
    if browse.query:
        rows = rows.filter(
            Q(name__icontains=browse.query)
            | Q(variants__sku__icontains=browse.query)
            | Q(variants__external_name__icontains=browse.query)
        ).distinct()
    name = Lower("name").desc() if browse.order == "-name" else Lower("name").asc()
    descending = browse.order.startswith("-")
    metric = browse.order.lstrip("-")
    if metric == "sku":
        # A product's sort SKU is the lowest non-blank SKU its variants carry,
        # so the column and the sort name the same thing. No SKU at all sorts
        # last either way.
        rows = rows.annotate(
            sku_key=Min(Lower("variants__sku"), filter=Q(variants__sku__gt=""))
        )
        sku_order = (
            F("sku_key").desc(nulls_last=True)
            if descending
            else F("sku_key").asc(nulls_last=True)
        )
        rows = rows.order_by(sku_order, name, "id")
    elif metric == "category":
        # An unfiled product sorts last either way: reversing the column is a
        # request for the other end of the alphabet, not for a page of blanks.
        rows = rows.annotate(
            uncategorized=Case(
                When(category="", then=Value(1)),
                default=Value(0),
                output_field=IntegerField(),
            ),
            category_key=Lower("category"),
        )
        category_order = (
            F("category_key").desc() if descending else F("category_key").asc()
        )
        rows = rows.order_by("uncategorized", category_order, name, "id")
    elif metric == "price":
        price = (
            F("sell_price_cents").desc()
            if descending
            else F("sell_price_cents").asc()
        )
        rows = rows.order_by(price, name, "id")
    elif metric == "updatedAt":
        updated = (
            F("updated_at").desc() if descending else F("updated_at").asc()
        )
        rows = rows.order_by(updated, name, "id")
    else:
        rows = rows.order_by(name, "id")
    page, total = paginate(rows, browse)
    payload = paginated_payload(
        [product_json(product) for product in page],
        browse,
        total,
    )
    # The empty state has to tell "nothing matched" from "nothing yet", and a
    # search or filter that finds nothing cannot answer that from `total`.
    payload["hasAnyProduct"] = (
        total > 0 if not browse.query and status is None else owned.exists()
    )
    return payload


MENU_PRODUCT_ROW_LIMIT = 100


def menu_product_rows_payload(
    user: User,
    *,
    q: str = "",
    sold_at_range: tuple[datetime, datetime] | None = None,
) -> JsonObject:
    """The menu worksheet's product picker, priced over the menu's period.

    Products is a catalog and carries no figures, but a worksheet row is
    seeded from what the product actually sold while the menu ran, so this
    read exists beside `menu_items_payload`: same rows, same search, but the
    sales window the menu names and a units-first order. Bundles are
    expanded, so a box's units reach the products inside it. No pagination —
    a picker shows the busiest hundred and search reaches the rest.
    """
    rows = SalesProduct.objects.filter(user=user, is_active=True).prefetch_related(
        "skus",
        "variants",
        "components__recipe",
        "components__ingredient",
        "components__component_product",
    )
    if q:
        rows = rows.filter(
            Q(name__icontains=q)
            | Q(variants__sku__icontains=q)
            | Q(variants__external_name__icontains=q)
        ).distinct()
    products = list(rows)
    # One index for the whole read: every bundle allocation below shares it.
    index = bundles.BundleIndex.for_user(user)
    stats = product_sales_stats(
        user,
        [product.id for product in products],
        sold_at_range=sold_at_range,
        index=index,
    )
    products.sort(
        key=lambda product: (
            -(stats.get(product.id) or EMPTY_PRODUCT_SALES)["totalQuantity"],
            product.name.casefold(),
        )
    )
    return {
        "items": [
            product_json(product, stats.get(product.id))
            for product in products[:MENU_PRODUCT_ROW_LIMIT]
        ]
    }


MENU_OVERVIEW_SECTIONS = frozenset(
    {"modifiers", "review", "ignored", "items", "recipes", "stats", "rules"}
)


def menu_overview_payload(
    user: User,
    sections: Iterable[str] | None = None,
    *,
    review_query: str = "",
) -> JsonObject:
    # Every block is opt-in so a page pays only for what it renders. Omitting
    # the parameter keeps the full payload; unrequested blocks come back empty
    # but present, so the response shape never changes. `stats` implies
    # `items` — per-product sales are meaningless without the products — and
    # `items` implies `recipes`, the picker every item renders against.
    wanted = MENU_OVERVIEW_SECTIONS if sections is None else frozenset(sections)
    want_stats = "stats" in wanted
    want_items = want_stats or "items" in wanted
    want_recipes = want_items or "recipes" in wanted
    ignored_keys = ignore_key_set(user)
    product_stats = product_sales_stats(user) if want_stats else {}

    items = []
    if want_items:
        for product in SalesProduct.objects.filter(user=user).prefetch_related(
            "skus",
            "variants",
            "components__recipe",
            "components__ingredient",
            "components__component_product",
        ):
            payload = product_json(product, product_stats.get(product.id))
            items.append(payload)

    pending = []
    if "review" in wanted:
        pending = [
            group
            for group in unmatched_group_rows(user)
            if identity_scope_key(
                group["channel"], group["provider_account_id"], group["match_key"]
            )
            not in ignored_keys
        ]
        listed = set(
            SalesProductVariant.objects.filter(
                user=user, channel__in=PROVIDER_CHANNELS
            ).values_list("channel", "provider_account_id", "match_key")
        )
        connected = set(
            SalesChannelConnection.objects.filter(
                user=user, status=SalesChannelConnection.Status.ACTIVE
            ).values_list("provider", "provider_account_id")
        )
        pending_keys = {
            (group["channel"], group["provider_account_id"], group["match_key"])
            for group in pending
        }
        for item in SalesCatalogItem.objects.filter(user=user, is_active=True):
            if not catalog_item_is_pending(
                item,
                listed=listed,
                pending_keys=pending_keys,
                ignored_keys=ignored_keys,
                connected=connected,
            ):
                continue
            pending.append(
                {
                    "channel": item.channel,
                    "provider_account_id": item.provider_account_id,
                    "match_key": item.match_key,
                    "agg_sku": item.sku,
                    "agg_item_name": item.item_name,
                    "agg_variant_name": item.external_variant_title,
                    "agg_external_object_id": item.external_object_id,
                    "agg_product_external_object_id": "",
                    "agg_category": item.category,
                    # A catalog-only row has no sales, so it has no currency
                    # of its own to name.
                    "agg_currency_code": "",
                    "agg_line_count": 0,
                    "agg_quantity": Decimal("0"),
                    "agg_net_sales_cents": 0,
                    "agg_last_sold_at": None,
                    "agg_has_modifiers": False,
                    "catalog_only": True,
                }
            )
    pending.sort(key=lambda group: group["agg_net_sales_cents"] or 0, reverse=True)
    review_pending = pending_groups_matching(pending, review_query)
    # Review lists them and the modifier catalog places them into its lists;
    # nobody else reads them, so nobody else pays for them.
    want_pending_modifiers = "review" in wanted or "modifiers" in wanted
    pending_modifiers = (
        pending_modifier_rows(user, ignored_keys) if want_pending_modifiers else []
    )
    ignored = SalesSkuIgnore.objects.filter(user=user)
    modifier_ignores = Q()
    for channel in VALID_CHANNELS:
        modifier_ignores |= Q(match_key__startswith=f"{channel}:modifier:")
    ignored_items = ignored.exclude(modifier_ignores)
    ignored_modifiers = ignored.filter(modifier_ignores)
    want_ignored = "ignored" in wanted
    ignored_item_rows = list(ignored_items[:500]) if want_ignored else []
    ignored_modifier_rows = list(ignored_modifiers[:500]) if want_ignored else []

    # Both histories decorate only the Ignored tab's rows; they group the
    # entire sales-line table, so they only run when that tab asked.
    ignored_item_history = (
        {
            identity_scope_key(
                row["channel"], row["provider_account_id"], row["match_key"]
            ): {
                "lineCount": row["agg_line_count"],
                "quantity": float(row["agg_quantity"] or 0),
                "netSalesCents": row["agg_net_sales_cents"] or 0,
                "currencyCode": row["agg_currency_code"] or "",
                "lastSoldAt": (
                    row["agg_last_sold_at"].isoformat()
                    if row["agg_last_sold_at"]
                    else None
                ),
            }
            for row in SalesLine.objects.filter(user=user)
            .values("channel", "provider_account_id", "match_key")
            .annotate(
                agg_line_count=Count("id"),
                agg_quantity=Sum("quantity"),
                agg_net_sales_cents=Sum("net_sales_cents"),
                agg_currency_code=Max("currency_code"),
                agg_last_sold_at=Max("sold_at"),
            )
        }
        if want_ignored
        else {}
    )
    ignored_modifier_history = (
        {
            identity_scope_key(
                row["sales_line__channel"],
                row["sales_line__provider_account_id"],
                row["match_key"],
            ): {
                "lineCount": row["agg_line_count"],
                "quantity": float(row["agg_quantity"] or 0),
                "lastSoldAt": (
                    row["agg_last_sold_at"].isoformat()
                    if row["agg_last_sold_at"]
                    else None
                ),
            }
            for row in SalesLineModifier.objects.filter(user=user)
            .values(
                "sales_line__channel",
                "sales_line__provider_account_id",
                "match_key",
            )
            .annotate(
                agg_line_count=Count("id"),
                agg_quantity=Sum("quantity"),
                agg_last_sold_at=Max("sales_line__sold_at"),
            )
        }
        if want_ignored
        else {}
    )

    square_connection = SalesChannelConnection.objects.filter(
        user=user, provider=SalesImport.Channel.SQUARE
    ).first()
    modifier_lists = (
        list(
            SalesModifierList.objects.filter(
                user=user,
                channel=SalesImport.Channel.SQUARE,
                provider_account_id=square_connection.provider_account_id,
                is_active=True,
            ).prefetch_related("options")
        )
        if "modifiers" in wanted and square_connection is not None
        else []
    )
    active_catalog_keys = {
        (
            modifier_list.channel,
            modifier_list.provider_account_id,
            option.external_object_id,
        )
        for modifier_list in modifier_lists
        for option in modifier_list.options.all()
        if option.is_active
    }
    option_external_ids = {
        external_id for _, _, external_id in active_catalog_keys
    }
    catalog_mappings = {
        (
            variant.channel,
            variant.provider_account_id,
            variant.external_object_id,
        ): variant
        for variant in SalesProductVariant.objects.filter(
            user=user,
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
            external_object_id__in=option_external_ids,
        ).select_related("product")
    }
    modifier_catalog_lists = []
    for modifier_list in modifier_lists:
        options = []
        mapped_count = 0
        for option in modifier_list.options.all():
            if not option.is_active:
                continue
            variant = catalog_mappings.get(
                (
                    modifier_list.channel,
                    modifier_list.provider_account_id,
                    option.external_object_id,
                )
            )
            if variant is not None:
                mapped_count += 1
            options.append(
                {
                    "id": str(option.id),
                    "externalObjectId": option.external_object_id,
                    "name": option.name,
                    "ordinal": option.ordinal,
                    "priceCents": option.price_cents,
                    "currencyCode": option.currency_code,
                    "variantId": str(variant.id) if variant else None,
                    "productId": str(variant.product_id) if variant else None,
                    "productName": variant.product.name if variant else None,
                    "quantityMultiplier": (
                        float(variant.quantity_multiplier) if variant else 1
                    ),
                }
            )
        modifier_catalog_lists.append(
            {
                "id": str(modifier_list.id),
                "channel": modifier_list.channel,
                "providerAccountId": modifier_list.provider_account_id,
                "externalObjectId": modifier_list.external_object_id,
                "name": modifier_list.name,
                "modifierType": modifier_list.modifier_type,
                "selectionType": modifier_list.selection_type,
                "allowQuantities": modifier_list.allow_quantities,
                "minSelected": modifier_list.min_selected,
                "maxSelected": modifier_list.max_selected,
                "mappedCount": mapped_count,
                "options": options,
            }
        )

    unassigned_modifier_records: list[JsonObject] = []
    if "modifiers" in wanted and square_connection is not None:
        modifier_records = modifier_catalog_record_rows(
            user,
            pending_modifiers,
            active_catalog_keys,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id=square_connection.provider_account_id,
        )
        unassigned_modifier_records = place_modifier_records_in_catalog(
            modifier_catalog_lists, modifier_records
        )

    want_review = "review" in wanted
    review_variants = variant_index(user) if want_review else VariantIndex()
    review_canonical_index = (
        canonical_product_index(user) if want_review else {}
    )
    rendered_review: list[JsonObject] = []
    category_counts: dict[tuple[str, str], int] = defaultdict(int)
    for group in review_pending:
        category_key = (group["channel"], group.get("agg_category") or "")
        if category_counts[category_key] >= REVIEW_RENDER_CAP:
            continue
        category_counts[category_key] += 1
        rendered_review.append(group)

    # A page that only creates products asks for `recipes` alone; the whole
    # item list is a heavy way to reach the picker.
    recipes = (
        [
            {
                "id": str(recipe.id),
                "publicId": recipe.public_id,
                "title": recipe.title,
            }
            # Archived recipes stay pickable while a menu item still links
            # them, so those items keep rendering (and saving).
            for recipe in Recipe.objects.filter(user=user)
            .exclude(
                Q(status=Recipe.STATUS_ARCHIVED)
                & ~Q(
                    id__in=SalesProductComponent.objects.filter(
                        product__user=user
                    ).values("recipe_id")
                )
            )
            .order_by("title")
        ]
        if want_recipes
        else []
    )

    return {
        "items": items,
        "recipes": recipes,
        "rules": (
            [
                ignore_rule_json(rule)
                for rule in SalesIgnoreRule.objects.filter(user=user).annotate(
                    ignored_count=Count("ignores")
                )
            ]
            if "rules" in wanted
            else []
        ),
        "modifierCatalog": {
            "squareConnected": square_connection is not None,
            "squareNeedsReconnect": (
                square_connection is not None
                and square_connection.status
                == SalesChannelConnection.Status.NEEDS_RECONNECT
            ),
            "squareSyncedAt": (
                square_connection.modifier_catalog_synced_at.isoformat()
                if square_connection
                and square_connection.modifier_catalog_synced_at
                else None
            ),
            # A sales sync that ran later than the catalog import means the
            # catalog step was skipped or failed. The modifiers page compares
            # the two to tell the merchant their lists are behind.
            "squareSalesSyncedAt": (
                square_connection.last_synced_at.isoformat()
                if square_connection and square_connection.last_synced_at
                else None
            ),
            "lists": modifier_catalog_lists,
            "unassignedRecords": unassigned_modifier_records,
        },
        "review": {
            "items": [
                pending_item_json(
                    user,
                    group,
                    variants=review_variants,
                    canonical_index=review_canonical_index,
                )
                for group in (rendered_review if "review" in wanted else [])
            ],
            "reviewCount": (
                len(pending)
                if want_review
                else pending_review_count(user, ignored_keys)
            ),
            "reviewMatchCount": len(review_pending),
            # Rolled up over EVERY pending group, not just the 200 rendered:
            # the category filter has to be honest about what it will act on.
            "categories": (
                pending_category_rows(pending) if "review" in wanted else []
            ),
            "modifiers": pending_modifiers[:200] if "review" in wanted else [],
            "modifierReviewCount": (
                len(pending_modifiers)
                if want_pending_modifiers
                else pending_modifier_review_count(user, ignored_keys)
            ),
            "ignoredItems": [
                sku_ignore_json(
                    row,
                    ignored_item_history.get(
                        identity_scope_key(
                            row.channel, row.provider_account_id, row.match_key
                        )
                    ),
                )
                for row in ignored_item_rows
            ],
            "ignoredModifiers": [
                sku_ignore_json(
                    row,
                    ignored_modifier_history.get(
                        identity_scope_key(
                            row.channel, row.provider_account_id, row.match_key
                        )
                    ),
                )
                for row in ignored_modifier_rows
            ],
            # Both lists are capped independently; the counts let the page say
            # so without disguising modifiers as SKUs.
            "ignoredItemCount": ignored_items.count() if want_ignored else 0,
            "ignoredModifierCount": (
                ignored_modifiers.count() if want_ignored else 0
            ),
            "ignoredCount": ignored.count() if want_ignored else 0,
        },
    }


# Square allows far fewer than this per line; the cap is defensive only.
MAX_MODIFIERS_PER_LINE = 100


def modifier_fingerprint_facts(entry: JsonObject) -> list[list[str]]:
    """The modifier facts folded into a parent fingerprint.

    Empty when the entry carries no modifiers, so pre-modifier lines keep the
    exact fingerprints they were imported with.
    """
    return [
        [
            modifier["source_uid"],
            modifier["external_object_id"],
            modifier["sku"],
            modifier["name"],
            str(modifier["quantity"]),
        ]
        for modifier in entry.get("modifiers") or []
    ]


def base_fingerprint(entry: JsonObject) -> str:
    facts = modifier_fingerprint_facts(entry)
    canonical = json.dumps(
        [
            entry["channel"],
            entry["external_order_id"],
            entry["sold_at"].astimezone(ZoneInfo("UTC")).isoformat(),
            entry["sku"],
            entry["item_name"],
            entry["variant_name"],
            str(entry["quantity"]),
            entry["gross_cents"],
            entry["discount_cents"],
            entry["net_sales_cents"],
            entry["tax_cents"],
            # API syncs historically fingerprinted every refund with zero in
            # this slot. Keep that canonical shape even though the stored
            # reporting magnitude is now populated, or an id-less replay
            # would become a second financial line.
            0,
        ]
        + ([facts] if facts else []),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def modifier_source_fingerprint(entry_fingerprint: str, modifier: JsonObject, index: int) -> str:
    canonical = json.dumps(
        [
            entry_fingerprint,
            index,
            modifier["source_uid"],
            modifier["external_object_id"],
            modifier["sku"],
            modifier["name"],
            str(modifier["quantity"]),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def assign_entry_fingerprints(entries: list[JsonObject]) -> None:
    """Stamp each entry with a unique fingerprint: the base hash plus an
    occurrence suffix, so identical rows within one batch stay distinct while
    re-imports of the same rows still collide."""
    occurrences: dict[str, int] = defaultdict(int)
    for entry in entries:
        base = base_fingerprint(entry)
        occurrence = occurrences[base]
        occurrences[base] += 1
        entry["fingerprint"] = hashlib.sha256(
            f"{base}:{occurrence}".encode("utf-8")
        ).hexdigest()


def existing_fingerprints(
    user: User,
    channel: str,
    provider_account_id: str,
    fingerprints: list[str],
) -> set[str]:
    result: set[str] = set()
    for start in range(0, len(fingerprints), 500):
        result.update(
            SalesLine.objects.filter(
                user=user,
                channel=channel,
                provider_account_id=provider_account_id,
                source_fingerprint__in=fingerprints[start : start + 500],
            ).values_list("source_fingerprint", flat=True)
        )
    return result


def store_entry_modifiers(
    user: User,
    channel: str,
    provider_account_id: str,
    stored: list[tuple[JsonObject, SalesLine]],
) -> int:
    """Persist modifier occurrences for freshly stored lines.

    Entries without modifiers do no work at all, so pre-modifier imports are
    unchanged down to the query count.
    """
    if not any(entry.get("modifiers") for entry, _ in stored):
        return 0
    variants = variant_index(user)
    rows: list[SalesLineModifier] = []
    for entry, line in stored:
        for index, modifier in enumerate(entry.get("modifiers") or []):
            keys = modifier_candidate_keys(
                channel,
                external_object_id=modifier["external_object_id"],
                name=modifier["name"],
            )
            if not keys:
                continue
            match = resolve_modifier_variant(
                user,
                channel=channel,
                provider_account_id=provider_account_id,
                external_object_id=modifier["external_object_id"],
                name=modifier["name"],
                variants=variants,
                suggest=False,
            )
            rows.append(
                SalesLineModifier(
                    user=user,
                    sales_line=line,
                    variant=match.variant if match.status == "matched" else None,
                    source_uid=modifier["source_uid"],
                    source_fingerprint=modifier_source_fingerprint(
                        line.source_fingerprint, modifier, index
                    ),
                    external_object_id=modifier["external_object_id"],
                    sku=modifier["sku"],
                    name=modifier["name"],
                    # The most specific key available; attach re-derives the
                    # rest from the object id and name.
                    match_key=keys[0],
                    quantity=modifier["quantity"],
                    base_price_cents=modifier["base_price_cents"],
                    total_price_cents=modifier["total_price_cents"],
                    source_payload=modifier["source_payload"],
                )
            )
    SalesLineModifier.objects.bulk_create(rows, batch_size=500)
    return len(rows)


def refresh_sales_import_totals(row: SalesImport) -> None:
    lines = list(row.lines.all())
    row.imported_count = len(lines)
    row.unmapped_count = sum(line.variant_id is None for line in lines)
    row.order_count = len({line.external_order_id for line in lines})
    row.gross_cents = sum(line.gross_cents for line in lines)
    row.discount_cents = sum(line.discount_cents for line in lines)
    row.net_sales_cents = sum(line.net_sales_cents for line in lines)
    row.tax_cents = sum(line.tax_cents for line in lines)
    row.refund_cents = sum(line.refund_cents for line in lines)
    row.save(
        update_fields=[
            "imported_count",
            "unmapped_count",
            "order_count",
            "gross_cents",
            "discount_cents",
            "net_sales_cents",
            "tax_cents",
            "refund_cents",
            "updated_at",
        ]
    )


def parse_product_components(
    user: User, body: JsonObject, product: SalesProduct | None = None
) -> list[dict[str, Any]]:
    """Validate and resolve a product composition replacement.

    `recipeLinks` is the old menu-dialog spelling.  It remains accepted for
    callers that have not moved to the Product Hub yet; its rows become
    recipe components with an empty unit and replace only the product's
    recipe components.  New callers send `components`, whose rows have
    exactly one recipe, ingredient or product target and replace the whole
    list.
    """
    canonical = "components" in body
    raw_components = body.get("components" if canonical else "recipeLinks", [])
    if not isinstance(raw_components, list) or len(raw_components) > 100:
        raise ValueError("Component list looks malformed")

    recipe_ids: set[uuid.UUID] = set()
    ingredient_ids: set[uuid.UUID] = set()
    product_ids: set[uuid.UUID] = set()
    parsed: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_components):
        if not isinstance(raw, dict):
            raise ValueError("Component looks malformed")
        recipe_raw = raw.get("recipeId")
        ingredient_raw = raw.get("ingredientId")
        product_raw = raw.get("productId")
        if canonical:
            has_recipe = recipe_raw is not None
            has_ingredient = ingredient_raw is not None
            has_product = product_raw is not None
            if has_recipe + has_ingredient + has_product != 1:
                raise ValueError(
                    "A component needs exactly one recipe, ingredient or product"
                )
            recipe_id = uuid_value(recipe_raw, "recipe id") if has_recipe else None
            ingredient_id = (
                uuid_value(ingredient_raw, "ingredient id")
                if has_ingredient
                else None
            )
            component_product_id = (
                uuid_value(product_raw, "product id") if has_product else None
            )
            quantity = decimal_value(
                raw.get("quantity"),
                "Component quantity",
                minimum=Decimal("0.001"),
                maximum=Decimal("1000000"),
            )
            unit = text_value(
                raw.get("unit", ""),
                "Component unit",
                max_length=64,
                allow_blank=True,
            )
            position = int_value(
                raw.get("position", index),
                "Component position",
                minimum=0,
                maximum=2147483647,
            )
            if recipe_id is not None and unit:
                raise ValueError("Recipe components do not use a unit")
            if component_product_id is not None and unit:
                raise ValueError("Product components do not use a unit")
            if ingredient_id is not None and not unit:
                raise ValueError("Ingredient components need a unit")
            if ingredient_id is not None and unit not in unit_slugs():
                raise ValueError("Invalid unit")
        else:
            recipe_id = uuid_value(recipe_raw, "recipe id")
            ingredient_id = None
            component_product_id = None
            quantity = decimal_value(
                raw.get("quantity", 1),
                "Recipe quantity",
                minimum=Decimal("0.001"),
                maximum=Decimal("1000000"),
            )
            unit = ""
            position = index
        if recipe_id is not None:
            if recipe_id in recipe_ids:
                raise ValueError("A product can only include each recipe once")
            recipe_ids.add(recipe_id)
        if ingredient_id is not None:
            if ingredient_id in ingredient_ids:
                raise ValueError("A product can only include each ingredient once")
            ingredient_ids.add(ingredient_id)
        if component_product_id is not None:
            if component_product_id in product_ids:
                raise ValueError("A product can only include each product once")
            if product is not None and component_product_id == product.id:
                raise ValueError("A product cannot contain itself")
            product_ids.add(component_product_id)
        parsed.append(
            {
                "recipe_id": recipe_id,
                "ingredient_id": ingredient_id,
                "component_product_id": component_product_id,
                "quantity": quantity,
                "unit": unit,
                "position": position,
            }
        )

    # A recipe archived after it was linked stays saveable on the products
    # that already use it, matching the legacy recipe-link behavior.
    already_linked = (
        set(
            product.components.filter(recipe__isnull=False).values_list(
                "recipe_id", flat=True
            )
        )
        if product is not None
        else set()
    )
    recipes = {
        row.id: row
        for row in Recipe.objects.filter(user=user, id__in=recipe_ids).exclude(
            Q(status=Recipe.STATUS_ARCHIVED) & ~Q(id__in=already_linked)
        )
    }
    ingredients = {
        row.id: row
        for row in Ingredient.objects.filter(user=user, id__in=ingredient_ids)
    }
    if len(recipes) != len(recipe_ids):
        raise ValueError("Recipe not found")
    if len(ingredients) != len(ingredient_ids):
        raise ValueError("Ingredient not found")
    products = _resolve_component_products(user, product_ids, product)
    for component in parsed:
        component["recipe"] = recipes.get(component["recipe_id"])
        component["ingredient"] = ingredients.get(component["ingredient_id"])
        component["component_product"] = products.get(component["component_product_id"])
    return parsed


def _resolve_component_products(
    user: User, product_ids: set[uuid.UUID], product: SalesProduct | None
) -> dict[uuid.UUID, SalesProduct]:
    """Resolve bundle members, refusing anything that would not survive.

    The save path bulk-creates, so `SalesProductComponent.clean()` never runs
    for these rows and the cycle guard has to live here too.
    """
    if not product_ids:
        return {}
    # A product deactivated after it was linked stays saveable where it is
    # already used, matching the archived-recipe rule above.
    already_linked = (
        set(
            product.components.filter(component_product__isnull=False).values_list(
                "component_product_id", flat=True
            )
        )
        if product is not None
        else set()
    )
    products = {
        row.id: row
        for row in SalesProduct.objects.filter(user=user, id__in=product_ids)
    }
    if len(products) != len(product_ids):
        raise ValueError("Product not found")
    inactive = [
        row
        for row in products.values()
        if not row.is_active and row.id not in already_linked
    ]
    if inactive:
        raise ValueError("That product is not active")
    if product is None:
        # Nothing points at an unsaved product yet, so no edge can close a
        # loop back to it.
        return products
    edges: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for parent_id, member_id in SalesProductComponent.objects.filter(
        product__user=user, component_product__isnull=False
    ).values_list("product_id", "component_product_id"):
        edges[parent_id].add(member_id)
    seen = set(product_ids)
    pending = list(product_ids)
    while pending:
        for member_id in edges.get(pending.pop(), ()):
            if member_id == product.id:
                raise ValueError("Bundles cannot contain a cycle")
            if member_id not in seen:
                seen.add(member_id)
                pending.append(member_id)
    return products


def _is_system_manual_variant(variant: SalesProductVariant) -> bool:
    """Keep future/manual system links outside provider-list replacement."""
    return (
        getattr(variant, "channel", "") == "manual"
        or getattr(variant, "link_source", "") in {"system", "system_manual"}
        or getattr(variant, "source", "") in {"system", "system_manual"}
        or bool(getattr(variant, "is_system", False))
    )


def _sales_product_queryset(user: User, product_ref: Any):
    queryset = SalesProduct.objects.filter(user=user)
    if isinstance(product_ref, str) and product_ref.startswith("prd_"):
        return queryset.filter(public_id=product_ref)
    return queryset.filter(id=uuid_value(product_ref, "product id"))


def update_variant_settings(
    variant: SalesProductVariant,
    *,
    multiplier: Decimal | None = None,
) -> bool:
    updates: list[str] = []
    if multiplier is not None and variant.quantity_multiplier != multiplier:
        variant.quantity_multiplier = multiplier
        updates.append("quantity_multiplier")
    if not updates:
        return False
    # Editing an automatic link is the merchant taking ownership of it, so
    # turning product matching off must no longer reclaim it.
    if variant.link_source == SalesProductVariant.LinkSource.AUTO_SKU:
        variant.link_source = SalesProductVariant.LinkSource.MANUAL
        updates.append("link_source")
    variant.save(update_fields=updates + ["updated_at"])
    return True


def parse_product_skus(raw: Any) -> list[dict[str, Any]]:
    """Every SKU this product sells under, each with its units per sale."""
    if not isinstance(raw, list) or len(raw) > 20:
        raise ValueError("SKU list looks malformed")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for position, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError("SKU row looks malformed")
        sku = text_value(entry.get("sku"), "SKU", max_length=120)
        normalized = group_key_part(sku)
        if normalized in seen:
            raise ValueError("SKU is listed twice")
        seen.add(normalized)
        rows.append(
            {
                "sku": sku,
                "normalized_sku": normalized,
                "quantity_multiplier": variant_multiplier(
                    entry.get("quantityMultiplier", 1)
                ),
                "position": position,
            }
        )
    return rows


def action_save_sales_product(user: User, body: JsonObject) -> JsonObject:
    # A box is a product with products inside it, saved like any other. A
    # client still sending the old assortment shape would otherwise create a
    # plain variant and quietly lose the box.
    raw_variants = body.get("variants")
    if isinstance(raw_variants, list) and any(
        isinstance(row, dict)
        and (row.get("kind") == "assorted" or "members" in row)
        for row in raw_variants
    ):
        raise ValueError(
            "Assorted variants are now bundle products: send a product with "
            "product components"
        )
    # Direct products retain the existing product/recipe edit flow, without
    # legacy pack or policy settings. Product Hub scalar edits are flat and
    # optimistic-lock their product; legacy full saves remain compatible.
    if "patch" in body:
        raise ValueError("Product fields must be sent at the top level")
    if "sku" in body:
        raise ValueError("A product's SKUs are sent as a list: skus")
    item_id = body.get("id")
    product = (
        _sales_product_queryset(user, item_id).first() if item_id else None
    )
    if item_id and product is None:
        raise ValueError("Product not found")
    canonical_composition = "components" in body
    composition_given = canonical_composition or "recipeLinks" in body
    if item_id and "expectedEditVersion" not in body:
        raise ValueError("Edit version is required")
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
    created = product is None
    scalar_values: dict[str, Any] = {}
    if "name" in body or created:
        scalar_values["name"] = text_value(
            body.get("name"), "Menu item name", max_length=200
        )
    skus_given = "skus" in body
    skus = parse_product_skus(body.get("skus")) if skus_given else []
    if "description" in body:
        description = body.get("description")
        scalar_values["description"] = (
            ""
            if description is None
            else text_value(
                description, "Description", max_length=200000, allow_blank=True
            )
        )
    elif created:
        scalar_values["description"] = ""
    if "sellPriceCents" in body:
        scalar_values["sell_price_cents"] = int_value(
            body["sellPriceCents"],
            "Sell price",
            minimum=0,
            maximum=100000000,
        )
    elif created:
        scalar_values["sell_price_cents"] = 0
    if "baseUnit" in body:
        base_unit = body.get("baseUnit")
        base_unit = (
            ""
            if base_unit is None
            else text_value(base_unit, "Unit", max_length=32, allow_blank=True)
        )
        if base_unit and base_unit not in PRODUCT_UNIT_VALUES:
            raise ValueError("Unit is not one a product can be sold in")
        # Blank already means each; storing both spellings would make two
        # products sold by the piece compare as sold by different units.
        scalar_values["base_unit"] = "" if base_unit == "each" else base_unit
    elif created:
        scalar_values["base_unit"] = ""
    if "category" in body:
        category = body.get("category")
        scalar_values["category"] = (
            ""
            if category is None
            else text_value(category, "Category", max_length=120, allow_blank=True)
        )
    elif created:
        scalar_values["category"] = ""
    if "isActive" in body or created:
        scalar_values["is_active"] = bool_value(
            body.get("isActive", True), "Menu item status"
        )
    components_given = composition_given
    variants_given = "variants" in body
    if variants_given and (
        not isinstance(raw_variants, list) or len(raw_variants) > 50
    ):
        raise ValueError("SKU list looks malformed")
    with transaction.atomic():
        # Different product editors can add opposite edges concurrently.
        # Serialize the graph before validating it, always before row locks.
        lock_workspace(user)
        if product is None:
            product = SalesProduct(user=user)
        else:
            product = (
                SalesProduct.objects.select_for_update()
                .filter(user=user, id=product.id)
                .first()
            )
            if product is None:
                raise ValueError("Product not found")
            if expected is not None and expected != product.edit_version:
                raise StaleWriteError(product.edit_version, "sales product")
            product.edit_version += 1
        components = (
            parse_product_components(user, body, product) if components_given else []
        )
        for field, value in scalar_values.items():
            setattr(product, field, value)
        if "name" in scalar_values:
            product.normalized_name = normalized_name(scalar_values["name"])
        # Saving through the dialog is the merchant adopting this product, so
        # turning product matching off must not withdraw it from under them.
        product.link_source = "manual"
        product.save()
        if skus_given:
            taken = SalesProductSku.objects.filter(
                user=user,
                normalized_sku__in=[row["normalized_sku"] for row in skus],
            ).exclude(product=product)
            if taken.exists():
                raise ValueError("SKU is already used by another product")
            product.skus.all().delete()
            try:
                # Keep the race-safe database constraint, while limiting a
                # duplicate-SKU rollback to this savepoint so the action can
                # return a user-fixable validation error.
                with transaction.atomic():
                    SalesProductSku.objects.bulk_create(
                        SalesProductSku(user=user, product=product, **row)
                        for row in skus
                    )
            except IntegrityError as exc:
                if taken.exists():
                    raise ValueError(
                        "SKU is already used by another product"
                    ) from exc
                raise
        if components_given:
            # The legacy spelling only knows about recipes, so it replaces
            # those and leaves the product's ingredient rows alone.
            replaced = product.components.all()
            if not canonical_composition:
                replaced = replaced.filter(recipe__isnull=False)
            replaced.delete()
            SalesProductComponent.objects.bulk_create(
                [
                    SalesProductComponent(
                        product=product,
                        recipe=component["recipe"],
                        ingredient=component["ingredient"],
                        component_product=component.get("component_product"),
                        quantity=component["quantity"],
                        unit=component["unit"],
                        position=component["position"],
                    )
                    for component in components
                ]
            )
        if not variants_given:
            return {
                "id": str(product.id),
                "publicId": product.public_id,
                "editVersion": product.edit_version,
                "claimedLines": 0,
                **finish_receipt(user, empty_receipt()),
            }
        receipt = empty_receipt()
        kept_variant_ids: set[uuid.UUID] = set()
        for raw in raw_variants:
            if not isinstance(raw, dict):
                raise ValueError("SKU row looks malformed")
            # A later catalog model may expose an internal/manual channel.
            # It is not an external identity and must survive a provider-link
            # replacement when an older client sends the rest of the set.
            if raw.get("channel") == "manual" and raw.get("id"):
                preserved = SalesProductVariant.objects.filter(
                    user=user, id=uuid_value(raw["id"], "variant id")
                ).first()
                if preserved is None or not _is_system_manual_variant(preserved):
                    raise ValueError("Variant not found")
                kept_variant_ids.add(preserved.id)
                continue
            multiplier = variant_multiplier(raw.get("quantityMultiplier", 1))
            raw_attribution = raw.get("attributionPercent", ATTRIBUTION_ABSENT)
            attribution_given = raw_attribution is not ATTRIBUTION_ABSENT
            attribution = (
                attribution_value(raw_attribution)
                if attribution_given
                else None
            )
            variant_id = raw.get("id")
            variant = (
                SalesProductVariant.objects.filter(
                    user=user, id=uuid_value(variant_id, "variant id")
                ).first()
                if variant_id
                else None
            )
            if variant_id and variant is None:
                raise ValueError("Variant not found")
            if variant is None:
                channel = text_value(raw.get("channel"), "Sales channel", max_length=16)
                if channel not in VALID_CHANNELS:
                    raise ValueError("Sales channel is not supported")
                identity_kind = text_value(
                    raw.get("identityKind", SalesProductVariant.IdentityKind.ITEM),
                    "Identity kind",
                    max_length=16,
                )
                if identity_kind != SalesProductVariant.IdentityKind.ITEM:
                    raise ValueError("Catalog links must be item identities")
                provider_account_id = provider_account_value(user, channel, raw)
                match_key = text_value(
                    raw.get("matchKey"), "Product key", max_length=500
                )
                existing_variant = SalesProductVariant.objects.filter(
                    user=user,
                    channel=channel,
                    provider_account_id=provider_account_id,
                    match_key=match_key,
                ).first()
                if existing_variant is not None:
                    if existing_variant.identity_kind != SalesProductVariant.IdentityKind.ITEM:
                        raise ValueError("That catalog item is already linked")
                    if existing_variant.product_id not in (None, product.id):
                        raise ValueError(
                            "That catalog item is already connected to another menu item"
                        )
                    variant = existing_variant
                    variant.product = product
                    variant.quantity_multiplier = multiplier
                    if attribution_given:
                        variant.attribution_percent = attribution
                else:
                    variant = SalesProductVariant(
                        user=user,
                        product=product,
                        channel=channel,
                        provider_account_id=provider_account_id,
                        match_key=match_key,
                        sku=text_value(
                            raw.get("sku", ""),
                            "SKU",
                            max_length=120,
                            allow_blank=True,
                        ),
                        external_name=text_value(
                            raw.get("externalName", product.name),
                            "SKU name",
                            max_length=240,
                            allow_blank=True,
                        ),
                        external_variant_title=text_value(
                            raw.get("externalVariantTitle", ""),
                            "SKU variant",
                            max_length=200,
                            allow_blank=True,
                        ),
                        identity_kind=identity_kind,
                        external_object_id=text_value(
                            raw.get("externalObjectId", ""),
                            "External object id",
                            max_length=192,
                            allow_blank=True,
                        ),
                        product_external_object_id=text_value(
                            raw.get("productExternalObjectId", ""),
                            "Product external object id",
                            max_length=192,
                            allow_blank=True,
                        ),
                        quantity_multiplier=multiplier,
                        attribution_percent=attribution,
                    )
            else:
                if variant.identity_kind == SalesProductVariant.IdentityKind.MODIFIER:
                    raise ValueError("Modifiers must be edited from Modifiers")
                if variant.product_id not in (None, product.id):
                    raise ValueError(
                        "That catalog item is already connected to another menu item"
                    )
                # The catalog identity is immutable after it has been saved.
                identity_fields = (
                    ("channel", "channel"),
                    ("providerAccountId", "provider_account_id"),
                    ("matchKey", "match_key"),
                    ("sku", "sku"),
                    ("externalName", "external_name"),
                    ("externalVariantTitle", "external_variant_title"),
                    ("externalObjectId", "external_object_id"),
                    (
                        "productExternalObjectId",
                        "product_external_object_id",
                    ),
                )
                for input_name, field_name in identity_fields:
                    incoming = raw.get(input_name)
                    if incoming is not None and incoming != getattr(variant, field_name):
                        raise ValueError(
                            "Saved sales identities can't be edited — remove the "
                            "link and add the corrected identity."
                        )
                variant.product = product
                variant.quantity_multiplier = multiplier
                if attribution_given:
                    variant.attribution_percent = attribution
            variant.link_source = SalesProductVariant.LinkSource.MANUAL
            variant.clean()
            variant.save()
            sync_attached_line_products(user, variant)
            kept_variant_ids.add(variant.id)
            receipt["parentLinesAttached"] += attach_lines_to_variant(user, variant)
            SalesSkuIgnore.objects.filter(
                user=user,
                channel=variant.channel,
                provider_account_id=variant.provider_account_id,
                match_key=variant.match_key,
            ).delete()
        # The dialog submits the complete direct variant set.  Omitted links
        # are intentional removals and must release their historic sales.
        for old_variant in SalesProductVariant.objects.filter(
            product=product,
            identity_kind=SalesProductVariant.IdentityKind.ITEM,
        ):
            if old_variant.id in kept_variant_ids or _is_system_manual_variant(
                old_variant
            ):
                continue
            receipt["parentLinesDetached"] += detach_lines_from_variant(old_variant)
            old_variant.delete()
        # Tracking a SKU here is the decision; mirroring applies it to the
        # same SKU on the other channel so the merchant never tags twice.
        # Imported lazily for the same one-way reason as the toggle action.
        from .auto_match import mirror_variants

        _, mirrored_lines = mirror_variants(
            user,
            list(
                SalesProductVariant.objects.filter(
                    user=user, id__in=kept_variant_ids
                )
            ),
        )
        receipt["parentLinesAttached"] += mirrored_lines
        return {
            "id": str(product.id),
            "publicId": product.public_id,
            "editVersion": product.edit_version,
            "claimedLines": receipt["parentLinesAttached"],
            **finish_receipt(user, receipt),
        }


def parse_ignore_items(
    user: User, body: JsonObject, *, with_details: bool
) -> list[JsonObject]:
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 500:
        raise ValueError("SKU list looks malformed")
    items: list[JsonObject] = []
    keys: set[IdentityScope] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("SKU row looks malformed")
        channel = text_value(raw.get("channel"), "Sales channel", max_length=16)
        if channel not in VALID_CHANNELS:
            raise ValueError("Sales channel is not supported")
        match_key = text_value(raw.get("matchKey"), "Product key", max_length=500)
        provider_account_id = provider_account_value(user, channel, raw)
        scope_key = identity_scope_key(channel, provider_account_id, match_key)
        if scope_key in keys:
            raise ValueError("SKU list has duplicate keys")
        keys.add(scope_key)
        item: JsonObject = {
            "channel": channel,
            "provider_account_id": provider_account_id,
            "match_key": match_key,
        }
        if with_details:
            item["sku"] = text_value(
                raw.get("sku", ""), "SKU", max_length=120, allow_blank=True
            )
            item["external_name"] = text_value(
                raw.get("externalName", ""),
                "External product name",
                max_length=240,
                allow_blank=True,
            )
            item["external_variant_title"] = text_value(
                raw.get("externalVariantTitle", ""),
                "External variant",
                max_length=200,
                allow_blank=True,
            )
        items.append(item)
    return items


def action_delete_sales_product(user: User, body: JsonObject) -> JsonObject:
    with transaction.atomic():
        lock_workspace(user)
        product = (
            SalesProduct.objects.select_for_update()
            .filter(user=user, id=uuid_value(body.get("id"), "id"))
            .first()
        )
        if product is None:
            raise ValueError("Menu item not found")
        # A bundle's composition is its cost and its identity, so a member
        # leaves by being unlinked, never by vanishing. Name the bundles: the
        # merchant has to open them.
        bundles_using = list(
            SalesProduct.objects.filter(
                user=user, components__component_product=product
            )
            .values_list("name", flat=True)
            .distinct()[:3]
        )
        if bundles_using:
            raise ValueError(
                f"Remove this item from {', '.join(bundles_using)} before deleting it"
            )
        if product.menu_items.exists():
            raise ValueError("Remove this item from saved menus before deleting it")
        # A line with no variant is a hand-assigned/manual history reference;
        # deleting the product would silently erase the merchant's decision.
        if SalesLine.objects.filter(
            user=user, product=product, channel="manual"
        ).exists():
            raise ValueError("Remove this item from manual sales history before deleting it")
        # Sales history survives the item: SET_NULL clears the product and the
        # cascaded variants off their lines.
        product.delete()
    return {"ok": True}


def scoped_identity_query(items: Iterable[JsonObject]) -> Q:
    query = Q(pk__in=[])
    for item in items:
        query |= Q(
            channel=item["channel"],
            provider_account_id=item["provider_account_id"],
            match_key=item["match_key"],
        )
    return query


def tracked_ignore_keys(
    user: User, items: list[JsonObject]
) -> set[IdentityScope]:
    """Which scoped identities a menu item already claims — never ignorable."""
    return set(
        SalesProductVariant.objects.filter(user=user)
        .filter(scoped_identity_query(items))
        .values_list("channel", "provider_account_id", "match_key")
    )


def apply_sku_ignores(user: User, items: list[JsonObject]) -> int:
    """Write ignore rows, refusing any key a menu item already tracks.

    Holds the workspace lock so an ignore cannot interleave with a sync's
    auto-matching: either the matcher reads this ignore before pairing, or the
    tracked check here sees the variant the matcher just committed.
    """
    with transaction.atomic():
        lock_workspace(user)
        tracked = list(
            SalesProductVariant.objects.filter(user=user)
            .filter(scoped_identity_query(items))
            .select_related("product")[:5]
        )
        if tracked:
            # Name the offenders: the review table ignores in bulk, and a batch
            # refusal that identifies nothing leaves nothing to deselect.
            named = ", ".join(
                f"{variant.sku or variant.external_name} ({variant.product.name})"
                for variant in tracked
            )
            raise ValueError(
                f"Already tracked by a menu item — remove it there first: {named}"
            )
        for item in items:
            SalesSkuIgnore.objects.update_or_create(
                user=user,
                channel=item["channel"],
                provider_account_id=item["provider_account_id"],
                match_key=item["match_key"],
                defaults={
                    "sku": item["sku"],
                    "external_name": item["external_name"],
                    "external_variant_title": item["external_variant_title"],
                },
            )
    return len(items)


def action_ignore_sales_skus(user: User, body: JsonObject) -> JsonObject:
    items = parse_ignore_items(user, body, with_details=True)
    return {"ignored": apply_sku_ignores(user, items)}


def action_ignore_sales_category(user: User, body: JsonObject) -> JsonObject:
    """Ignore every pending identity in one displayed category, server-side.

    The merchant never sends the keys: at 400+ pending identities a client-side
    enumeration would be both huge and stale. The set is derived here from the
    user's own lines, so a category can only ever sweep up rows that are
    already pending for that user on that channel. A displayed bucket may span
    historical provider connections, so it carries every represented account.
    """
    channel = text_value(body.get("channel"), "Sales channel", max_length=16)
    if channel not in VALID_CHANNELS:
        raise ValueError("Sales channel is not supported")
    # "" is the uncategorized bucket — a real, addressable category.
    category = text_value(
        body.get("category", ""), "Category", max_length=120, allow_blank=True
    )
    sold_only = bool_value(body.get("soldOnly", False), "Sold-only flag")
    raw_provider_account_ids = body.get("providerAccountIds")
    if raw_provider_account_ids is None:
        # Compatibility for older callers and direct contract tests.
        raw_provider_account_ids = [body.get("providerAccountId", "")]
    if (
        not isinstance(raw_provider_account_ids, list)
        or not raw_provider_account_ids
        or len(raw_provider_account_ids) > 100
    ):
        raise ValueError("Provider account list looks malformed")
    provider_account_ids = []
    for raw_provider_account_id in raw_provider_account_ids:
        provider_account_id = text_value(
            raw_provider_account_id,
            "Provider account id",
            max_length=192,
            allow_blank=True,
        )
        if provider_account_id not in provider_account_ids:
            provider_account_ids.append(provider_account_id)

    ignored = ignore_key_set(user)
    groups = [
        group
        for group in SalesLine.objects.filter(
            user=user,
            variant__isnull=True,
            # Pre-reset imports can carry a stale denormalized product without
            # a variant. They are already tracked and must not be ignorable.
            product__isnull=True,
            channel=channel,
            provider_account_id__in=provider_account_ids,
            external_category=category,
        )
        .values("provider_account_id", "match_key")
        .annotate(
            agg_sku=Max("sku"),
            agg_item_name=Max("item_name"),
            agg_variant_name=Max("external_variant_title"),
            agg_line_count=Count("id"),
        )
        if group["match_key"]
        and identity_scope_key(
            channel, group["provider_account_id"], group["match_key"]
        )
        not in ignored
    ]
    if not sold_only:
        listed = set(
            SalesProductVariant.objects.filter(user=user).values_list(
                "channel", "provider_account_id", "match_key"
            )
        )
        existing = {(channel, group["provider_account_id"], group["match_key"]) for group in groups}
        connected = set(
            SalesChannelConnection.objects.filter(
                user=user,
                provider=channel,
                provider_account_id__in=provider_account_ids,
            ).values_list("provider", "provider_account_id")
        )
        for item in SalesCatalogItem.objects.filter(
            user=user,
            channel=channel,
            provider_account_id__in=provider_account_ids,
            category=category,
            is_active=True,
        ):
            key = (channel, item.provider_account_id, item.match_key)
            if (
                key not in existing
                and key not in listed
                and key not in ignored
                and (channel, item.provider_account_id) in connected
            ):
                groups.append(
                    {
                        "provider_account_id": item.provider_account_id,
                        "match_key": item.match_key,
                        "agg_sku": item.sku,
                        "agg_item_name": item.item_name,
                        "agg_variant_name": item.external_variant_title,
                        "agg_line_count": 0,
                    }
                )
    if not groups:
        return {"ignoredKeys": 0, "ignoredLines": 0, "skippedTracked": 0}

    # A pending line's key can still belong to a variant (approved after the
    # line landed, before reinterpretation). Those stay tracked and untouched
    # rather than failing the whole sweep the merchant just asked for.
    group_items = [
        {
            "channel": channel,
            "provider_account_id": group["provider_account_id"],
            "match_key": group["match_key"],
        }
        for group in groups
    ]
    tracked = tracked_ignore_keys(user, group_items)
    items = [
        {
            "channel": channel,
            "provider_account_id": group["provider_account_id"],
            "match_key": group["match_key"],
            "sku": (group["agg_sku"] or "")[:120],
            "external_name": (group["agg_item_name"] or "")[:240],
            "external_variant_title": (group["agg_variant_name"] or "")[:200],
        }
        for group in groups
        if identity_scope_key(
            channel, group["provider_account_id"], group["match_key"]
        )
        not in tracked
    ]
    ignored_lines = sum(
        group["agg_line_count"]
        for group in groups
        if identity_scope_key(
            channel, group["provider_account_id"], group["match_key"]
        )
        not in tracked
    )
    if items:
        apply_sku_ignores(user, items)
    return {
        "ignoredKeys": len(items),
        "ignoredLines": ignored_lines,
        "skippedTracked": len(groups) - len(items),
    }


def action_unignore_sales_skus(user: User, body: JsonObject) -> JsonObject:
    items = parse_ignore_items(user, body, with_details=False)
    # A rule-owned row would come straight back on the next sweep, so restoring
    # it is refused here rather than undone minutes later during a sync. The
    # UI hides the button, but a Server Action is reachable on its own.
    rule_owned = list(
        SalesSkuIgnore.objects.filter(user=user, rule__isnull=False)
        .filter(scoped_identity_query(items))[:5]
    )
    if rule_owned:
        named = ", ".join(row.sku or row.external_name for row in rule_owned)
        raise ValueError(
            f"Ignored by an auto-ignore rule — change the rule instead: {named}"
        )
    removed, _ = (
        SalesSkuIgnore.objects.filter(user=user)
        .filter(scoped_identity_query(items))
        .delete()
    )
    return {"removed": removed}


def _ignore_rule_channel(body: JsonObject) -> str | None:
    """The channel a rule or preview covers; `None` is every channel.

    An absent key is refused rather than read as every channel, for the same
    reason a blank condition value is: the widest rule has to be asked for.
    """
    if "channel" not in body:
        raise ValueError("Sales channel is required")
    raw = body.get("channel")
    if raw is None:
        return None
    channel = text_value(raw, "Sales channel", max_length=16)
    if channel not in VALID_CHANNELS:
        raise ValueError("Sales channel is not supported")
    return channel


def _ignore_rule_channels(channel: str | None) -> set[str]:
    return set(VALID_CHANNELS) if channel is None else {channel}


def action_save_sales_ignore_rule(user: User, body: JsonObject) -> JsonObject:
    channel = _ignore_rule_channel(body)
    conditions = parse_ignore_rule_conditions(body.get("conditions"))
    enabled = bool_value(body.get("enabled", True), "Enabled flag")
    raw_id = body.get("id")
    rule = None
    if raw_id is not None:
        rule = SalesIgnoreRule.objects.filter(
            user=user, id=uuid_value(raw_id, "rule id")
        ).first()
        if rule is None:
            raise ValueError("Rule not found")

    signature = ignore_rule_signature(conditions)
    # Overlap, not equality: a rule covering every channel says the same thing
    # as one naming a single channel, and the redundant one would hold nothing.
    others = SalesIgnoreRule.objects.filter(user=user)
    if channel is not None:
        others = others.filter(Q(channel=channel) | Q(channel__isnull=True))
    if rule is not None:
        others = others.exclude(id=rule.id)
    for other in others:
        if ignore_rule_signature(
            condition for condition in other.conditions if isinstance(condition, dict)
        ) == signature:
            raise ValueError("A rule with these conditions already exists")

    if rule is None:
        if SalesIgnoreRule.objects.filter(user=user).count() >= IGNORE_RULE_MAX_PER_USER:
            raise ValueError(
                f"You can have at most {IGNORE_RULE_MAX_PER_USER} rules"
            )
        rule = SalesIgnoreRule.objects.create(
            user=user, channel=channel, enabled=enabled, conditions=conditions
        )
    else:
        with transaction.atomic():
            # Rebuild rather than diff: an edit can narrow the match set, hand
            # rows to another rule, or meet an identity tracked since the last
            # sweep. Dropping this rule's rows collapses all three into one.
            rule.ignores.all().delete()
            rule.channel = channel
            rule.enabled = enabled
            rule.conditions = conditions
            rule.save(
                update_fields=["channel", "enabled", "conditions", "updated_at"]
            )
    # Always both channels: disabling, narrowing, or moving a rule to the other
    # channel all release identities that another rule may now claim, and the
    # released ones do not always sit on the channel just saved.
    ignored = len(sweep_ignore_rules(user))
    rule.ignored_count = rule.ignores.count()
    return {"rule": ignore_rule_json(rule), "ignored": ignored}


def action_delete_sales_ignore_rule(user: User, body: JsonObject) -> JsonObject:
    rule = SalesIgnoreRule.objects.filter(
        user=user, id=uuid_value(body.get("id"), "rule id")
    ).first()
    if rule is None:
        raise ValueError("Rule not found")
    restored = rule.ignores.count()
    rule.delete()
    sweep_ignore_rules(user)
    return {"restored": restored}


def action_preview_sales_ignore_rule(user: User, body: JsonObject) -> JsonObject:
    """Everything a rule would cover, before it is saved.

    A read on the action route because the conditions cannot travel as query
    params without inventing an encoding — and routing it here keeps the
    preview on the very predicate and candidate set the sweep uses.
    """
    channel = _ignore_rule_channel(body)
    conditions = parse_ignore_rule_conditions(body.get("conditions"))
    page = int_value(body.get("page", 1), "Page", minimum=1, maximum=1000000)
    query = group_key_part(
        text_value(
            body.get("q", ""), "Search", max_length=200, allow_blank=True
        )
    )
    channels = _ignore_rule_channels(channel)
    tracked = set(
        SalesProductVariant.objects.filter(
            user=user, channel__in=channels
        ).values_list("channel", "provider_account_id", "match_key")
    )
    claimed = ignore_key_set(user)
    matches: list[JsonObject] = []
    truncated = False
    # One identity commonly sits in both populations — a synced catalog row and
    # the lines it sold. The sweep collapses them into one ignore row, so the
    # preview has to count it once too or it promises twice the work it does.
    seen: set[IdentityScope] = set()
    for candidate in rule_ignore_candidates(user, channels):
        if not rule_matches(conditions, candidate):
            continue
        key = identity_scope_key(
            candidate.channel, candidate.provider_account_id, candidate.match_key
        )
        if key in seen:
            continue
        seen.add(key)
        if len(matches) >= IGNORE_RULE_SWEEP_CAP:
            truncated = True
            break
        if query and query not in group_key_part(
            f"{candidate.sku} {candidate.item_name} {candidate.external_variant_title}"
        ):
            continue
        matches.append(
            {
                "channel": candidate.channel,
                "providerAccountId": candidate.provider_account_id,
                "matchKey": candidate.match_key,
                "sku": candidate.sku,
                "itemName": candidate.item_name,
                "externalVariantTitle": candidate.external_variant_title,
                "status": (
                    "tracked"
                    if key in tracked
                    else "ignored"
                    if key in claimed
                    else "pending"
                ),
            }
        )
    # Channel sorts last so one product's two variants sit together rather than
    # splitting the preview into two lists of the same names.
    matches.sort(
        key=lambda row: (
            row["itemName"].lower(),
            row["sku"],
            row["matchKey"],
            row["channel"],
        )
    )
    browse = BrowseQuery(page=page, limit=25, query="", order="name")
    pages = max(1, (len(matches) + browse.limit - 1) // browse.limit)
    if page > pages:
        raise ValueError("Invalid page")
    start = (page - 1) * browse.limit
    payload = paginated_payload(
        matches[start : start + browse.limit], browse, len(matches)
    )
    payload["truncated"] = truncated
    return payload


def action_track_sales_modifiers(user: User, body: JsonObject) -> JsonObject:
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 200:
        raise ValueError("Modifier list looks malformed")
    with transaction.atomic():
        variant_ids: list[str] = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                raise ValueError("Modifier row looks malformed")
            product = SalesProduct.objects.filter(
                user=user, id=uuid_value(raw.get("productId"), "product id")
            ).first()
            if product is None:
                raise ValueError("A selected product could not be found")
            observed_match_key = text_value(
                raw.get("matchKey"), "Modifier key", max_length=500
            )
            channel = text_value(
                raw.get("channel") or observed_match_key.split(":", 1)[0],
                "Sales channel",
                max_length=16,
            )
            if channel not in VALID_CHANNELS:
                raise ValueError("Sales channel is not supported")
            identity = parse_modifier_match_key(observed_match_key)
            if identity is None or identity.channel != channel:
                raise ValueError("Modifier key is not recognized")
            external_object_id = text_value(
                raw.get("externalObjectId", identity.value),
                "Modifier object id",
                max_length=192,
                allow_blank=True,
            )
            if identity.kind == "object":
                external_object_id = identity.value
                match_key = modifier_object_match_key(channel, external_object_id)
            else:
                external_object_id = ""
                match_key = modifier_name_match_key(channel, identity.value)
            provider_account_id = provider_account_value(user, channel, raw)
            multiplier = variant_multiplier(raw.get("quantityMultiplier", 1))
            variant, _ = SalesProductVariant.objects.update_or_create(
                user=user,
                channel=channel,
                provider_account_id=provider_account_id,
                match_key=match_key,
                defaults={
                    "product": product,
                    "quantity_multiplier": multiplier,
                    "external_name": text_value(
                        raw.get("externalName", "Modifier"),
                        "Modifier name",
                        max_length=240,
                    ),
                    "external_object_id": external_object_id,
                    "identity_kind": SalesProductVariant.IdentityKind.MODIFIER,
                },
            )
            SalesSkuIgnore.objects.filter(
                user=user,
                channel=channel,
                provider_account_id=provider_account_id,
                match_key__in=[observed_match_key, match_key],
            ).delete()
            variant_ids.append(str(variant.id))
        receipt = reinterpret_sales(user)
    return {"variantIds": variant_ids, **finish_receipt(user, receipt)}


def action_associate_sales_modifier_options(
    user: User, body: JsonObject
) -> JsonObject:
    """Associate imported catalog modifier items with individual menu products.

    Catalog modifier ids are provider-global. Saving one therefore replaces
    older parent-scoped mappings for that same id with one global identity,
    which is the clean one-option → one-product relationship shown in the UI.
    """

    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 500:
        raise ValueError("Modifier associations look malformed")
    parsed: list[tuple[uuid.UUID, uuid.UUID | None]] = []
    option_ids: set[uuid.UUID] = set()
    product_ids: set[uuid.UUID] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("Modifier association looks malformed")
        option_id = uuid_value(raw.get("optionId"), "modifier option id")
        if option_id in option_ids:
            raise ValueError("Modifier associations contain a duplicate option")
        option_ids.add(option_id)
        raw_product_id = raw.get("productId")
        product_id = (
            None
            if raw_product_id in (None, "")
            else uuid_value(raw_product_id, "product id")
        )
        if product_id is not None:
            product_ids.add(product_id)
        parsed.append((option_id, product_id))

    options = {
        row.id: row
        for row in SalesModifierOption.objects.filter(
            id__in=option_ids,
            is_active=True,
            modifier_list__user=user,
            modifier_list__is_active=True,
        ).select_related("modifier_list")
    }
    if len(options) != len(option_ids):
        raise ValueError("A modifier option could not be found")
    products = {
        row.id: row
        for row in SalesProduct.objects.filter(
            user=user,
            id__in=product_ids,
        )
    }
    if len(products) != len(product_ids):
        raise ValueError("Modifiers can only be associated with single products")

    variant_ids: list[str] = []
    mapped = 0
    unmapped = 0
    with transaction.atomic():
        for option_id, product_id in parsed:
            option = options[option_id]
            channel = option.modifier_list.channel
            provider_account_id = option.modifier_list.provider_account_id
            variant_key = modifier_object_match_key(
                channel, option.external_object_id
            )
            candidates = SalesProductVariant.objects.filter(
                user=user,
                channel=channel,
                provider_account_id=provider_account_id,
                identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
                external_object_id=option.external_object_id,
            )
            if product_id is None:
                candidates.delete()
                unmapped += 1
                continue

            variant = candidates.filter(match_key=variant_key).first()
            if variant is None:
                variant = SalesProductVariant(
                    user=user,
                    product=products[product_id],
                    channel=channel,
                    provider_account_id=provider_account_id,
                    match_key=variant_key,
                    external_name=option.name,
                    identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
                    external_object_id=option.external_object_id,
                )
            else:
                variant.product = products[product_id]
                variant.external_name = option.name
            variant.clean()
            variant.save()
            candidates.exclude(pk=variant.pk).delete()
            observed_keys = SalesLineModifier.objects.filter(
                user=user,
                sales_line__channel=channel,
                sales_line__provider_account_id=provider_account_id,
                external_object_id=option.external_object_id,
            ).values_list("match_key", flat=True)
            SalesSkuIgnore.objects.filter(
                user=user,
                channel=channel,
                provider_account_id=provider_account_id,
                match_key__in=[variant_key, *observed_keys],
            ).delete()
            variant_ids.append(str(variant.id))
            mapped += 1
        receipt = reinterpret_sales(user)
    return {
        "variantIds": variant_ids,
        "mapped": mapped,
        "unmapped": unmapped,
        **finish_receipt(user, receipt),
    }


def parse_modifier_record_decisions(
    user: User, raw_records: object
) -> list[JsonObject]:
    if not isinstance(raw_records, list) or len(raw_records) > 500:
        raise ValueError("Historical modifier decisions look malformed")
    records: list[JsonObject] = []
    keys: set[IdentityScope] = set()
    product_ids: set[uuid.UUID] = set()
    for raw in raw_records:
        if not isinstance(raw, dict):
            raise ValueError("Historical modifier decision looks malformed")
        match_key = text_value(
            raw.get("matchKey"), "Modifier key", max_length=MATCH_KEY_MAX_LENGTH
        )
        identity = parse_modifier_match_key(match_key)
        if identity is None or identity.channel not in VALID_CHANNELS:
            raise ValueError("Modifier key is not recognized")
        provider_account_id = provider_account_value(user, identity.channel, raw)
        scope_key = identity_scope_key(
            identity.channel, provider_account_id, match_key
        )
        if scope_key in keys:
            raise ValueError("Historical modifier decisions contain a duplicate")
        keys.add(scope_key)
        decision = text_value(raw.get("decision"), "Modifier decision", max_length=16)
        if decision not in {"associate", "unassociate", "ignore"}:
            raise ValueError("Modifier decision is not supported")
        raw_product_id = raw.get("productId")
        product_id = (
            None
            if raw_product_id in (None, "")
            else uuid_value(raw_product_id, "product id")
        )
        if decision == "associate" and product_id is None:
            raise ValueError("Choose a product for this modifier")
        if decision != "associate" and product_id is not None:
            raise ValueError("Only associated modifiers can choose a product")
        if product_id is not None:
            product_ids.add(product_id)
        records.append(
            {
                "match_key": match_key,
                "identity": identity,
                "provider_account_id": provider_account_id,
                "decision": decision,
                "product_id": product_id,
                "external_name": text_value(
                    raw.get("externalName", identity.value),
                    "Modifier name",
                    max_length=240,
                ),
            }
        )

    owned_products = {
        row.id: row
        for row in SalesProduct.objects.filter(
            user=user,
            id__in=product_ids,
        )
    }
    if len(owned_products) != len(product_ids):
        raise ValueError("Modifiers can only be associated with single products")

    existing_keys = {
        identity_scope_key(row.channel, row.provider_account_id, row.match_key)
        for row in SalesProductVariant.objects.filter(
            user=user,
            identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
        )
    }
    occurrence_keys = {
        identity_scope_key(channel, account, match_key)
        for channel, account, match_key in SalesLineModifier.objects.filter(
            user=user
        ).values_list(
            "sales_line__channel",
            "sales_line__provider_account_id",
            "match_key",
        )
    }
    missing = keys.difference(existing_keys, occurrence_keys)
    if missing:
        raise ValueError("A historical modifier could not be found")

    for record in records:
        product_id = record["product_id"]
        record["product"] = owned_products.get(product_id)
    return records


def modifier_record_candidates(
    user: User, identity: ModifierIdentity, provider_account_id: str
):
    candidates = SalesProductVariant.objects.filter(
        user=user,
        channel=identity.channel,
        provider_account_id=provider_account_id,
        identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
    )
    if identity.kind == "object":
        return candidates.filter(external_object_id=identity.value)
    return candidates.filter(
        external_object_id="",
        match_key=modifier_name_match_key(identity.channel, identity.value),
    )


def apply_modifier_record_decisions(
    user: User, records: list[JsonObject]
) -> JsonObject:
    variant_ids: list[str] = []
    associated = 0
    unassociated = 0
    ignored = 0
    for record in records:
        identity: ModifierIdentity = record["identity"]
        provider_account_id = record["provider_account_id"]
        candidates = modifier_record_candidates(
            user, identity, provider_account_id
        )
        decision = record["decision"]
        if decision == "associate":
            if identity.kind == "object":
                variant_key = modifier_object_match_key(
                    identity.channel, identity.value
                )
                external_object_id = identity.value
            else:
                variant_key = modifier_name_match_key(identity.channel, identity.value)
                external_object_id = ""
            variant = candidates.filter(match_key=variant_key).first()
            if variant is None:
                variant = SalesProductVariant(
                    user=user,
                    product=record["product"],
                    channel=identity.channel,
                    provider_account_id=provider_account_id,
                    match_key=variant_key,
                    external_name=record["external_name"],
                    identity_kind=SalesProductVariant.IdentityKind.MODIFIER,
                    external_object_id=external_object_id,
                )
            else:
                variant.product = record["product"]
                variant.external_name = record["external_name"]
            variant.clean()
            variant.save()
            candidates.exclude(pk=variant.pk).delete()
            observed_keys = list(
                SalesLineModifier.objects.filter(
                    user=user,
                    sales_line__channel=identity.channel,
                    sales_line__provider_account_id=provider_account_id,
                    external_object_id=external_object_id,
                ).values_list("match_key", flat=True)
                if external_object_id
                else SalesLineModifier.objects.filter(
                    user=user,
                    sales_line__channel=identity.channel,
                    sales_line__provider_account_id=provider_account_id,
                    match_key=record["match_key"],
                ).values_list("match_key", flat=True)
            )
            SalesSkuIgnore.objects.filter(
                user=user,
                channel=identity.channel,
                provider_account_id=provider_account_id,
                match_key__in=[variant_key, record["match_key"], *observed_keys],
            ).delete()
            variant_ids.append(str(variant.id))
            associated += 1
            continue

        occurrences = list(
            SalesLineModifier.objects.filter(
                user=user,
                sales_line__channel=identity.channel,
                sales_line__provider_account_id=provider_account_id,
            )
            .filter(Q(match_key=record["match_key"]) | Q(variant__in=candidates))
            .select_related("sales_line")
        )
        candidates.delete()
        if decision == "unassociate":
            unassociated += 1
            continue

        ignore_rows: dict[str, JsonObject] = {}
        for occurrence in occurrences:
            ignore_rows[occurrence.match_key] = {
                "channel": occurrence.sales_line.channel,
                "provider_account_id": occurrence.sales_line.provider_account_id,
                "match_key": occurrence.match_key,
                "sku": occurrence.sku,
                "external_name": occurrence.name,
                "external_variant_title": occurrence.sales_line.item_name,
            }
        if not ignore_rows:
            ignore_rows[record["match_key"]] = {
                "channel": identity.channel,
                "provider_account_id": provider_account_id,
                "match_key": record["match_key"],
                "sku": "",
                "external_name": record["external_name"],
                "external_variant_title": "",
            }
        ignored += apply_sku_ignores(user, list(ignore_rows.values()))

    return {
        "variantIds": variant_ids,
        "associatedRecords": associated,
        "unassociatedRecords": unassociated,
        "ignoredRecords": ignored,
    }


def action_save_sales_modifier_associations(
    user: User, body: JsonObject
) -> JsonObject:
    """Save one grouped modifier dialog without exposing identity scope.

    Active catalog options keep their provider-global association. Historical
    sales records are promoted to the same global identity automatically; the
    merchant only chooses the food product (or marks a non-product ignored).
    """

    raw_options = body.get("options", [])
    if not isinstance(raw_options, list) or len(raw_options) > 500:
        raise ValueError("Modifier associations look malformed")
    records = parse_modifier_record_decisions(user, body.get("records", []))
    if not raw_options and not records:
        raise ValueError("Choose at least one modifier association")

    option_result: JsonObject = {"mapped": 0, "unmapped": 0, "variantIds": []}
    with transaction.atomic():
        if raw_options:
            option_result = action_associate_sales_modifier_options(
                user, {"items": raw_options}
            )
        record_result = apply_modifier_record_decisions(user, records)
        receipt = reinterpret_sales(user)
    return {
        "variantIds": [
            *option_result.get("variantIds", []),
            *record_result["variantIds"],
        ],
        "mapped": option_result.get("mapped", 0),
        "unmapped": option_result.get("unmapped", 0),
        "associatedRecords": record_result["associatedRecords"],
        "unassociatedRecords": record_result["unassociatedRecords"],
        "ignoredRecords": record_result["ignoredRecords"],
        **finish_receipt(user, receipt),
    }


def action_ignore_sales_modifiers(user: User, body: JsonObject) -> JsonObject:
    result = action_ignore_sales_skus(user, body)
    return {**result, **finish_receipt(user, empty_receipt())}


def action_unignore_sales_modifiers(user: User, body: JsonObject) -> JsonObject:
    result = action_unignore_sales_skus(user, body)
    with transaction.atomic():
        receipt = reinterpret_sales(user)
    return {**result, **finish_receipt(user, receipt)}


def action_update_sales_variant_multiplier(
    user: User, body: JsonObject
) -> JsonObject:
    variant = SalesProductVariant.objects.filter(
        user=user, id=uuid_value(body.get("variantId"), "variant id")
    ).first()
    if variant is None:
        raise ValueError("Sales identity not found")
    multiplier = variant_multiplier(body.get("quantityMultiplier"))
    receipt = empty_receipt()
    with transaction.atomic():
        update_variant_settings(variant, multiplier=multiplier)
        if variant.identity_kind == SalesProductVariant.IdentityKind.MODIFIER:
            receipt["linesReinterpreted"] = (
                SalesLine.objects.filter(user=user, modifiers__variant=variant)
                .distinct()
                .count()
            )
        else:
            receipt["linesReinterpreted"] = SalesLine.objects.filter(
                user=user, variant=variant
            ).count()
    return {
        "variantId": str(variant.id),
        "quantityMultiplier": float(variant.quantity_multiplier),
        **finish_receipt(user, receipt),
    }


def action_update_sales_variant_attribution(
    user: User, body: JsonObject
) -> JsonObject:
    """Set how much of a saved variant's sale its products own.

    Tracking is where attribution is first offered, but a merchant works out
    what a variant really contains later, so it has to be settable on a
    variant that already exists.
    """
    variant = SalesProductVariant.objects.filter(
        user=user, id=uuid_value(body.get("variantId"), "variant id")
    ).first()
    if variant is None:
        raise ValueError("Sales identity not found")
    attribution = attribution_value(body.get("attributionPercent"))
    receipt = empty_receipt()
    with transaction.atomic():
        if variant.attribution_percent != attribution:
            variant.attribution_percent = attribution
            # Setting it is the merchant adopting the link, as any other edit
            # is, so automatic matching may no longer reclaim it.
            variant.link_source = SalesProductVariant.LinkSource.MANUAL
            variant.save(
                update_fields=[
                    "attribution_percent",
                    "link_source",
                    "updated_at",
                ]
            )
        receipt["linesReinterpreted"] = SalesLine.objects.filter(
            user=user, variant=variant
        ).count()
    return {
        "variantId": str(variant.id),
        "attributionPercent": variant.attribution_percent,
        **finish_receipt(user, receipt),
    }


def action_untrack_sales_variant(user: User, body: JsonObject) -> JsonObject:
    variant_id = str(uuid_value(body.get("variantId"), "variant id"))
    variant = SalesProductVariant.objects.filter(user=user, id=variant_id).first()
    if variant is None:
        # Idempotent: a gone variant is already untracked, so a Save retry after a
        # concurrent untrack converges instead of wedging on the ghost id.
        return {"variantId": variant_id, **finish_receipt(user, empty_receipt())}
    # A modifier is untracked from Modifiers, where its own mapping lives.
    if variant.identity_kind != SalesProductVariant.IdentityKind.ITEM:
        raise ValueError("Only catalog items can be untracked")
    receipt = empty_receipt()
    with transaction.atomic():
        receipt["parentLinesDetached"] = detach_lines_from_variant(variant)
        variant.delete()
    return {"variantId": variant_id, **finish_receipt(user, receipt)}


def action_reinterpret_sales(user: User, body: JsonObject) -> JsonObject:
    with transaction.atomic():
        receipt = reinterpret_sales(user)
    return finish_receipt(user, receipt)


def action_undo_sales_import(user: User, body: JsonObject) -> JsonObject:
    import_id = uuid_value(body.get("id"), "sales import id")
    # The newest-active check has to hold until the undo commits. Read outside
    # the transaction it could pass, a POS sync or a second import could land,
    # and this undo would delete lines with a newer import still on top.
    with transaction.atomic():
        lock_workspace(user)

        sales_import = (
            SalesImport.objects.select_for_update()
            .filter(user=user, id=import_id)
            .first()
        )
        if sales_import is None:
            raise ValueError("Sales import not found")
        if (
            sales_import.channel == SalesImport.Channel.MANUAL
            or sales_import.source == SalesImport.Source.MANUAL
        ):
            raise ValueError("Manual sales imports cannot be undone")
        if sales_import.undone_at is not None:
            raise ValueError("This sales import was already undone")
        latest_active = SalesImport.objects.filter(
            user=user,
            undone_at__isnull=True,
            channel__in=PROVIDER_CHANNELS,
        ).first()
        if latest_active is None or latest_active.id != sales_import.id:
            raise ValueError("Only the newest active sales import can be undone")

        deleted_lines = sales_import.lines.count()
        provider_account_ids = set(
            sales_import.lines.exclude(provider_account_id="").values_list(
                "provider_account_id", flat=True
            )
        )
        if sales_import.provider_account_id:
            provider_account_ids.add(sales_import.provider_account_id)
        connections = list(
            SalesChannelConnection.objects.select_for_update().filter(
                user=user,
                provider=sales_import.channel,
                provider_account_id__in=provider_account_ids,
            )
        )
        for channel_connection in connections:
            SyncRun.objects.cancel_active(
                connection=channel_connection,
                generation=channel_connection.generation,
            )
            channel_connection.sync_lease_token = None
            channel_connection.sync_lease_started_at = None
            channel_connection.sync_cursor = {}
        sales_import.lines.all().delete()
        for ignored in reversed(sales_import.ignored_items):
            before = ignored.get("before")
            provider_account_id = ignored.get("providerAccountId", "")
            if before:
                # Never restore an ignore onto a key that is tracked now —
                # ignore+variant is a forbidden state. The variant survives
                # undo by design, so the ignore stays superseded.
                if SalesProductVariant.objects.filter(
                    user=user,
                    channel=ignored["channel"],
                    provider_account_id=provider_account_id,
                    match_key=ignored["matchKey"],
                ).exists():
                    continue
                SalesSkuIgnore.objects.update_or_create(
                    user=user,
                    channel=ignored["channel"],
                    provider_account_id=provider_account_id,
                    match_key=ignored["matchKey"],
                    defaults={
                        "sku": before.get("sku", ""),
                        "external_name": before.get("externalName", ""),
                        "external_variant_title": before.get("externalVariantTitle", ""),
                        # Absent in snapshots taken before rules existed, and
                        # None once the owning rule is gone — both mean manual.
                        "rule_id": (
                            before.get("ruleId")
                            if SalesIgnoreRule.objects.filter(
                                user=user, id=before.get("ruleId")
                            ).exists()
                            else None
                        ),
                    },
                )
            else:
                SalesSkuIgnore.objects.filter(
                    user=user,
                    channel=ignored["channel"],
                    provider_account_id=provider_account_id,
                    match_key=ignored["matchKey"],
                ).delete()
        sales_import.undone_at = timezone.now()
        sales_import.save(update_fields=["undone_at", "updated_at"])
        if (
            sales_import.source == SalesImport.Source.API
            and sales_import.period_start is not None
        ):
            # Without this rollback the undone window would be unreachable:
            # the next sync starts at watermark minus the overlap, which has
            # long passed the undone period. Re-covering it is idempotent.
            period_start = datetime.combine(
                sales_import.period_start,
                datetime.min.time(),
                tzinfo=ZoneInfo("UTC"),
            )
            # A None watermark is a pending backfill, not a gap: stamping it
            # here would turn the next sync incremental and skip the other 90
            # days. Only an existing watermark rolls BACK.
            for channel_connection in connections:
                if (
                    channel_connection.sync_watermark is not None
                    and channel_connection.sync_watermark > period_start
                ):
                    channel_connection.sync_watermark = period_start
        for channel_connection in connections:
            channel_connection.save(
                update_fields=[
                    "sync_watermark",
                    "sync_cursor",
                    "sync_lease_token",
                    "sync_lease_started_at",
                    "updated_at",
                ]
            )
    return {"ok": True, "deletedLines": deleted_lines}


# Slugs this module answers for, composed into the one action route by
# forkluck/http/dispatch.py.
def action_set_product_matching(user: User, body: JsonObject) -> JsonObject:
    """Turn SKU mirroring on or off, and act on it immediately.

    The setting lives on BenchCostSettings but the consequence is a sales
    concern, so the write and the linking happen together here rather than
    through the workspace settings action — domains are independent, and a
    merchant who flips this expects the catalog to change now, not at the next
    save.
    """
    # Imported here, not at module scope: auto_match reads this module's
    # normalizer and attach/detach helpers, so the dependency only runs one way
    # at import time.
    from .auto_match import mirror_existing_links, withdraw_auto_matches

    enabled = bool_value(body.get("enabled"), "Product matching")

    # One transaction holding the workspace lock across both the write and its
    # effect. A save mirroring a decision takes the same lock, so it cannot
    # read the old value and commit links into a workspace that just turned
    # off.
    with transaction.atomic():
        lock_workspace(user)
        row, _ = BenchCostSettings.objects.get_or_create(user=user)
        row.product_auto_match_enabled = enabled
        row.save(update_fields=["product_auto_match_enabled"])

        if enabled:
            return {"ok": True, "enabled": True, "linked": mirror_existing_links(user)}
        return {
            "ok": True,
            "enabled": False,
            "withdrawn": withdraw_auto_matches(user),
        }


ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "set-product-matching": action_set_product_matching,
    "save-sales-product": action_save_sales_product,
    "record-manual-sales": action_record_manual_sales,
    "delete-sales-product": action_delete_sales_product,
    "ignore-sales-skus": action_ignore_sales_skus,
    "ignore-sales-category": action_ignore_sales_category,
    "unignore-sales-skus": action_unignore_sales_skus,
    "save-sales-ignore-rule": action_save_sales_ignore_rule,
    "delete-sales-ignore-rule": action_delete_sales_ignore_rule,
    "preview-sales-ignore-rule": action_preview_sales_ignore_rule,
    "track-sales-modifiers": action_track_sales_modifiers,
    "associate-sales-modifier-options": action_associate_sales_modifier_options,
    "save-sales-modifier-associations": action_save_sales_modifier_associations,
    "ignore-sales-modifiers": action_ignore_sales_modifiers,
    "unignore-sales-modifiers": action_unignore_sales_modifiers,
    "update-sales-variant-multiplier": action_update_sales_variant_multiplier,
    "update-sales-variant-attribution": action_update_sales_variant_attribution,
    "untrack-sales-variant": action_untrack_sales_variant,
    "reinterpret-sales": action_reinterpret_sales,
    "undo-sales-import": action_undo_sales_import,
}
