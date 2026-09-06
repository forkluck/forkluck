"""Recipe costing read models shared by the recipe list and dashboard.

The browser does not need the complete pantry, recipe library, match table, and
bench-cost tree to render a health row.  This module performs that join beside
the database and returns only the values a screen displays.
"""

import math
import re
from dataclasses import dataclass, replace
from datetime import datetime, time, timedelta
from functools import lru_cache
from typing import Any, Callable, Iterable

from django.db.models import Exists, OuterRef, Prefetch
from django.db.models.functions import Lower
from django.db.models.signals import post_delete, post_save

from ...units import (
    APPROXIMATE_UNITS,
    COUNT_YIELD_UNITS,
    GRAMS_PER_UNIT,
    MASS_UNITS,
    MILLILITERS_PER_UNIT,
    VOLUME_UNITS,
    convert_amount,
    counted_as_each,
    unit_family,
    unit_ratio,
)
from ...models import (
    BenchCostRecipe,
    BenchCostSettings,
    BenchCostStep,
    CatalogIngredient,
    CatalogIngredientMeasure,
    Ingredient,
    IngredientMeasure,
    IngredientPrice,
    Menu,
    MenuItem,
    Recipe,
    RecipeItem,
    RecipeStep,
    SalesProduct,
    SalesProductComponent,
    User,
)
from ..sales.bundles import BundleIndex
from ..sales.core import EMPTY_PRODUCT_SALES, product_sales_stats
from ..shared.density import grams_for
from ..shared.ingredient_identity import qualifier_clauses, saved_line_match_map
from ..shared.preparations import ingredient_measure_name
from ..shared.physical_expansion import (
    Measure,
    PreparationBasis,
    PurchaseBasis,
    purchase_quantity,
)
from ..shared.recipe_equivalency import recipe_equivalency
from ..shared.values import iso, normalized_name
from ..shared.workspace_timezone import workspace_zone
from ..shared.vocabulary import each_weight_grams, profile_by_alias, vocabulary
from .serializers import (
    menu_ingredient_json,
    menu_item_json,
    menu_json,
    menu_recipe_json,
)

JsonObject = dict[str, Any]


def _ingredient_allergen_statuses(ingredient: Ingredient) -> dict[str, str]:
    """Effective positive allergen assertions for one pantry identity, keyed
    by allergen: "contains" or "mayContain". Packaging asserts nothing, and
    neither does a brand-dependent "checkLabel" row: that one is a hint the
    ingredient screen offers, never a claim a rollup may repeat."""
    if ingredient.non_edible:
        return {}
    catalog_ingredient = None
    if ingredient.catalog_ingredient_id:
        catalog_ingredient = ingredient.catalog_ingredient
    elif ingredient.catalog_product_id and ingredient.catalog_product.ingredient_id:
        catalog_ingredient = ingredient.catalog_product.ingredient
    defaults = {
        row.allergen: row.status
        for row in catalog_ingredient.allergen_defaults.all()
    } if catalog_ingredient is not None else {}
    defaults.update({row.allergen: row.status for row in ingredient.allergen_overrides.all()})
    return {key: status for key, status in defaults.items() if status in {"contains", "mayContain"}}


def _merge_allergen(result: dict[str, str], key: str, status: str) -> None:
    """A contains claim outranks a may-contain one from another line."""
    if status == "contains" or key not in result:
        result[key] = status


def recipe_allergens(recipe: Recipe, *, _seen: set | None = None) -> set[str]:
    """Resolve one recipe through the bulk normalized allergen loader."""
    if _seen is not None:
        # Retain the private recursive API for callers from older code while
        # ensuring the normal path uses the set-based loader below.
        if recipe.id in _seen:
            raise ValueError("Recipe subrecipes cannot contain a cycle")
    return set(recipe_allergens_many([recipe])[recipe.id])


def recipe_allergens_many(recipes: Iterable[Recipe]) -> dict[object, dict[str, str]]:
    """Resolve a recipe DAG with one query per graph depth, never per row.

    Each recipe maps to {allergen: "contains" | "mayContain"}. A line that
    keeps nothing after cooking (a discarded brine) keeps its allergens as
    they are: an ingredient the kitchen chose has no threshold, so only an
    explicit may-contain tag produces one. Packaging asserts nothing.
    """
    roots = list(recipes)
    items_by_recipe: dict[object, list[RecipeItem]] = {}
    pending: set[object] = set()
    for recipe in roots:
        cached = getattr(recipe, "_facet_items", None)
        if cached is None:
            cached = getattr(recipe, "_normalized_items", None)
        if cached is None:
            cached = getattr(recipe, "_prefetched_objects_cache", {}).get("items")
        if cached is None:
            pending.add(recipe.id)
        else:
            items_by_recipe[recipe.id] = list(cached)
    while pending:
        rows = list(
            RecipeItem.objects.filter(recipe_id__in=pending)
            .select_related(
                "ingredient__catalog_ingredient",
                "ingredient__catalog_product__ingredient",
                "subrecipe",
            )
            .prefetch_related(
                "ingredient__allergen_overrides",
                "ingredient__catalog_ingredient__allergen_defaults",
                "ingredient__catalog_product__ingredient__allergen_defaults",
            )
        )
        items_by_recipe.update({recipe_id: [] for recipe_id in pending})
        for item in rows:
            items_by_recipe[item.recipe_id].append(item)
        pending = {
            item.subrecipe_id
            for item_list in items_by_recipe.values()
            for item in item_list
            if item.subrecipe_id and item.subrecipe_id not in items_by_recipe
        }

    resolved: dict[object, dict[str, str]] = {}

    def visit(recipe_id: object, path: set[object]) -> dict[str, str]:
        if recipe_id in path:
            # The model refuses a cycle on save; a row that got one past it
            # contributes nothing on the second visit rather than taking the
            # whole browse page down with it.
            return {}
        if recipe_id in resolved:
            return resolved[recipe_id]
        result: dict[str, str] = {}
        for item in items_by_recipe.get(recipe_id, []):
            if item.ingredient_id:
                statuses = _ingredient_allergen_statuses(item.ingredient)
            elif item.subrecipe_id:
                statuses = visit(item.subrecipe_id, path | {recipe_id})
            else:
                continue
            for key, status in statuses.items():
                _merge_allergen(result, key, status)
        resolved[recipe_id] = result
        return result

    for recipe in roots:
        visit(recipe.id, set())
    return resolved

_VOCABULARY = vocabulary()

VULGAR_FRACTIONS: dict[str, str] = _VOCABULARY["vulgarFractions"]

COUNT_UNITS = {
    unit["slug"] for unit in _VOCABULARY["units"] if unit["family"] == "count"
}
_MASS_SLUGS = [
    unit["slug"] for unit in _VOCABULARY["units"] if unit["family"] == "mass"
]

# Order is load-bearing: the alternation matches left to right, so a longer
# spelling has to precede one that is its prefix ("fl oz" before "oz").
_UNIT_ALIASES = tuple(
    (unit["slug"], unit["pattern"])
    for unit in _VOCABULARY["units"]
    if unit.get("pattern")
)
_UNIT_PATTERNS = dict(_UNIT_ALIASES)
_UNIT_SOURCE = "|".join(pattern for _, pattern in _UNIT_ALIASES)
_COUNT_UNIT_SOURCE = "|".join(
    pattern for unit, pattern in _UNIT_ALIASES if unit in COUNT_UNITS
)
_MASS_UNIT_SOURCE = "|".join(
    _UNIT_PATTERNS[unit] for unit in _MASS_SLUGS if unit in _UNIT_PATTERNS
)

_AMOUNT_SOURCE = (
    r"\d+\s+\d+/\d+|\d+/\d+|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+"
)
_AMOUNT = re.compile(rf"^({_AMOUNT_SOURCE})\s*(.*)$")
_SUPPORTED_UNIT = re.compile(
    rf"^({_UNIT_SOURCE})\.?(?:\s*,\s*|\s+|$)(.*)$", re.IGNORECASE
)
_NAME_UNIT_AMOUNT = re.compile(
    rf"^(.+?)\s+({_UNIT_SOURCE})\.?\s+({_AMOUNT_SOURCE})$", re.IGNORECASE
)
_NAME_AMOUNT_UNIT = re.compile(
    rf"^(.+?)\s+({_AMOUNT_SOURCE})(?:\s*({_UNIT_SOURCE})\.?)?$",
    re.IGNORECASE,
)
_NAME_FIRST_UNIT = re.compile(rf"^(?:{_UNIT_SOURCE})\.?$", re.IGNORECASE)
_UNSUPPORTED_UNIT = re.compile(r"(?!)")
_METHOD_TAIL = re.compile(
    r"(?:^|\s)(at|to|for|of|about|until|minutes?|hours?|degrees?)$",
    re.IGNORECASE,
)
_PROFILE_ANNOTATION = re.compile(
    rf"\((?:{'|'.join(_VOCABULARY['profileAnnotations'])}|\d+\s*°?\s*[cf])\)",
    re.IGNORECASE,
)
_EXPLICIT_WEIGHT = re.compile(
    rf"^\(\s*({_AMOUNT_SOURCE})\s*(?:-\s*)?({_MASS_UNIT_SOURCE})\."
    rf"?(?:\s+(total|each))?\s*\)\s*(.*)$",
    re.IGNORECASE,
)
_UNPARENTHESIZED_CONTAINER_WEIGHT = re.compile(
    rf"^({_AMOUNT_SOURCE})\s*(?:-\s*)?({_MASS_UNIT_SOURCE})\."
    rf"?\s+({_COUNT_UNIT_SOURCE})\.?\s+(.+)$",
    re.IGNORECASE,
)
_RANGE = re.compile(
    rf"^({_AMOUNT_SOURCE})\s*(?:-|–|—|to)\s*({_AMOUNT_SOURCE})\b",
    re.IGNORECASE,
)
# A heading: a markdown hash, or a short label closed by a colon with nothing
# after it. "Note: chill 1 hr" keeps its text, so it is not a heading.
_HEADING_MARKER = re.compile(r"^#{1,6}\s+(.+)$")
_HEADING_LABEL = re.compile(r"^([^:]{1,80}):$")
_STANDALONE_NOTE = re.compile(r"^(?:notes?|tips?)\s*:\s*(.+)$", re.IGNORECASE)
# A line that states its measure only in front, in brackets: "(30ml) olive
# oil", "(1lb/454g) mozzarella". The first measure is what the line asks for.
_LEADING_MEASURE = re.compile(
    rf"^\(\s*({_AMOUNT_SOURCE})\s*({_UNIT_SOURCE})\.?"
    rf"(?:\s*[/|]\s*(?:{_AMOUNT_SOURCE})\s*(?:{_UNIT_SOURCE})\.?)?\s*\)\s*(.+)$",
    re.IGNORECASE,
)
# A gesture in place of an amount: "Drizzle of avocado oil".
_VAGUE_QUANTITY = re.compile(
    r"^(?:an?\s+)?(?:pinch|dash|drizzle|splash|handful|sprinkle|squeeze|knob"
    r"|glug)\s+of\s+(.+)$",
    re.IGNORECASE,
)
# A range tail that names time or temperature is a method line, not an
# ingredient, so it must not be reported as affecting a price. The bare
# temperature letter is case-sensitive: "1-2 c flour" is a cup of flour.
_NON_INGREDIENT_RANGE_TAIL = re.compile(
    r"^(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|degrees?|deg)\b",
    re.IGNORECASE,
)
_TEMPERATURE_RANGE_TAIL = re.compile(r"^(?:°\s?[CFcf]|[CF])\b")
# A second amount joined to the first ("2 tbsp plus 1 tsp"), which the single
# amount the line reports cannot represent.
_RESIDUAL_AMOUNT = re.compile(
    rf"^(?:plus|\+|and)\s*(?:{_AMOUNT_SOURCE})\b", re.IGNORECASE
)
# A decimal comma. A thousands group keeps three digits after the comma, so
# "1,500" stays an amount while "1,5" is a locale this refuses to guess at.
_DECIMAL_COMMA = re.compile(r"\d+,\d{1,2}(?!\d)")
# A list marker: an integer closed by a period or paren with no digit after
# it, so "1. Mix the dough" is a step while "1.5 kg Flour" stays an amount.
_NUMBERED_INSTRUCTION = re.compile(r"^\d+\s*[.)](?!\d)\s*\S")
# What a pasted list puts in front of an ingredient. A bullet or checkbox glyph
# carries no meaning, so it goes before the line is read; recipe sites that
# render tickable ingredient lists paste a checkbox, and losing those drops
# every line. `-` and `*` need a following space to count, or "-1" reads as a
# marker plus a quantity.
_LIST_MARKER = re.compile(
    rf"^(?:[-*]\s+|[{re.escape(''.join(_VOCABULARY['listMarkerGlyphs']))}]\s*)"
)
_NON_MEASURE_ANNOTATION = re.compile(
    rf"^(?:or\s+)?(?:{'|'.join(_VOCABULARY['nonMeasureAnnotations'])})$",
    re.IGNORECASE,
)
# "salt, to taste" and "salt to taste" are one line, matching the editor.
_TRAILING_ANNOTATION = re.compile(
    rf"^(.+?)(?:,\s*|\s+)((?:or\s+)?(?:{'|'.join(_VOCABULARY['nonMeasureAnnotations'])}))$",
    re.IGNORECASE,
)
# A parenthetical that only restates the measure ("(30ml)") describes the
# amount, not a preparation, so it must not become a qualifier and block a
# density or a saved measure.
_MEASURE_ANNOTATION = re.compile(
    rf"^(?:{_AMOUNT_SOURCE})\s*(?:{_UNIT_SOURCE})\.?$", re.IGNORECASE
)
# A size word describes the piece, never the ingredient's identity or its
# weight per unit volume, so it is discarded rather than kept as a qualifier:
# a qualifier would stop a saved measure for the plain ingredient matching.
_SIZE_WORD = re.compile(
    rf"^(?:{'|'.join(_VOCABULARY['sizeWords'])})\s+(.+)$", re.IGNORECASE
)
_QUALIFIER_WORDS = tuple(_VOCABULARY["qualifierWords"])
# A comma clause is a preparation note in full, and recipes write them as prose:
# "garlic, pressed or minced", "mushrooms, cleaned + sliced". Anchoring on the
# qualifier word alone left the rest of the clause welded to the base name, so
# the ingredient identity never matched what the same line matches without it.
_QUALIFIER_CLAUSE = re.compile(
    rf"\b(?:{'|'.join(_QUALIFIER_WORDS)})\b", re.IGNORECASE
)
# The ingredient profiles the editor resolves measures and each-weights through
# (`findIngredientProfile` in apps/web/lib/recipe/analyze.ts): every profile name and
# synonym, normalized, mapped to the profile's canonical normalized name.
_PROFILE_BY_ALIAS = profile_by_alias()
_EACH_WEIGHT_GRAMS = each_weight_grams()


@dataclass(frozen=True)
class ParsedIngredient:
    name: str
    grams: float | None
    grams_are_explicit: bool = False
    needs_review: bool = False
    entered_amount: float | None = None
    entered_unit: str | None = None


@dataclass(frozen=True)
class SourcePreparation:
    """A state the ingredient is used in, with the conversions that state has
    of its own. A cup of yolks is not a cup of egg, so conversions are not
    inherited; only mass travels, through `yield_percent`."""

    normalized_name: str
    yield_percent: float | None
    conversion: tuple[tuple[float, str], ...] = ()
    conversion_is_automatic: bool = True


@dataclass(frozen=True)
class PriceSource:
    id: str
    normalized_name: str
    measure_name: str
    purchase_cost_cents: float
    purchase_size: float | None = None
    purchase_unit: str | None = None
    # The usable share of the pack, after trim. A component has none.
    yield_percent: float | None = None
    # One equivalence, as the ingredient states it: 227 g of it is 1 cup of it.
    conversion: tuple[tuple[float, str], ...] = ()
    conversion_is_automatic: bool = True
    # The states this ingredient is used in; a component recipe has none.
    preparations: tuple[SourcePreparation, ...] = ()
    is_component: bool = False
    component_yield_amount: float | None = None
    component_yield_unit: str | None = None
    # A component's sale unit is its finished weight, not its raw input sum.
    component_weight_known: bool = False


def _stated_pairs(conversion) -> tuple[tuple[float, str], ...]:
    """The measures this row states, which are one equivalence between the
    families they name. Empty on the standard conversion: that answer comes
    from the shared weight and volume table rather than from a row here. A
    preparation states the same six measures as an ingredient conversion, so it
    reads the same way."""
    if conversion is None or conversion.average_weight:
        return ()
    pairs = (
        (conversion.weight_amount, conversion.weight_unit),
        (conversion.volume_amount, conversion.volume_unit),
        (conversion.each_amount, conversion.each_unit),
    )
    return tuple(
        (float(amount), unit)
        for amount, unit in pairs
        if amount is not None and float(amount) > 0 and unit
    )


def _recipe_measure_pairs(
    recipe: Recipe, yield_basis: float | None = None
) -> tuple[tuple[float, str], ...]:
    """One finished batch in every UOM the yield or equivalency reaches.

    A custom equivalency states whole-batch amounts. A standard equivalency is
    a density ratio, so its other side is scaled from Total Yield rather than
    mistaken for the size of the batch itself.
    """
    basis = yield_basis if yield_basis is not None else recipe.yield_amount
    pairs: list[tuple[float, str]] = []
    if basis is not None and float(basis) > 0 and recipe.yield_unit:
        pairs.append((float(basis), recipe.yield_unit))
    equivalency = recipe_equivalency(recipe)
    if equivalency is None:
        return tuple(pairs)
    stated = [
        (float(amount), unit)
        for amount, unit in (
            (equivalency.mass_amount, equivalency.mass_unit),
            (equivalency.volume_amount, equivalency.volume_unit),
            (equivalency.count_amount, equivalency.count_unit),
        )
        if amount is not None and float(amount) > 0 and unit
    ]
    if not equivalency.standard:
        pairs.extend(stated)
        return tuple(pairs)
    if basis is None or float(basis) <= 0 or not recipe.yield_unit:
        return tuple(pairs)
    yield_family = unit_family(recipe.yield_unit)
    anchor = next(
        ((amount, unit) for amount, unit in stated if unit_family(unit) == yield_family),
        None,
    )
    if anchor is None:
        return tuple(pairs)
    anchor_amount, anchor_unit = anchor
    yield_in_anchor = convert_amount(
        float(basis),
        counted_as_each(recipe.yield_unit),
        counted_as_each(anchor_unit),
    )
    if yield_in_anchor is None or yield_in_anchor <= 0:
        return tuple(pairs)
    scale = yield_in_anchor / anchor_amount
    pairs.extend(
        (amount * scale, unit)
        for amount, unit in stated
        if unit_family(unit) != yield_family
    )
    return tuple(pairs)


def _recipe_batch_grams(
    recipe: Recipe, yield_basis: float | None = None
) -> float | None:
    for amount, unit in _recipe_measure_pairs(recipe, yield_basis):
        grams = convert_amount(amount, counted_as_each(unit), "g")
        if grams is not None:
            return grams
    return None


def _recipe_portion_divisor(recipe: Recipe) -> tuple[float, str] | None:
    """How many saved commercial portions one finished batch contains."""
    amount = recipe.serving_amount
    unit = recipe.serving_unit
    if amount is None or float(amount) <= 0 or not unit:
        return None
    target = counted_as_each(unit)
    for batch_amount, batch_unit in _recipe_measure_pairs(recipe):
        converted = convert_amount(
            batch_amount,
            counted_as_each(batch_unit),
            target,
        )
        if converted is not None:
            return converted / float(amount), f"/{float(amount):g} {unit}"
    return None


def _recipe_portion_issue(recipe: Recipe) -> str | None:
    if not recipe.yield_amount or not recipe.yield_unit:
        return "no yield"
    if not recipe.serving_amount or not recipe.serving_unit:
        return "no portion"
    if _recipe_portion_divisor(recipe) is None:
        return "portion needs equivalency"
    return None


def _recipe_batch_count(
    recipe: Recipe, yield_basis: float | None = None
) -> float | None:
    for amount, unit in _recipe_measure_pairs(recipe, yield_basis):
        if counted_as_each(unit) == "each":
            return amount
    return None


def _conversion_pairs(row) -> tuple[tuple[float, str], ...]:
    """The measures the ingredient's own conversion states."""
    return _stated_pairs(getattr(row, "conversion", None))


@dataclass(frozen=True)
class MeasureSource:
    ingredient_id: str | None
    normalized_name: str
    unit: str
    amount: float
    grams: float
    low_grams: float | None
    high_grams: float | None
    qualifier: str
    is_user: bool
    confidence: str


@dataclass(frozen=True)
class MeasureResolution:
    grams: float
    needs_review: bool


@dataclass(frozen=True)
class BodyPricing:
    total_cents: float
    unpriced_count: int
    review_count: int
    # Unpriced lines that name another component recipe, which is what makes a
    # rejected component's own failure legible rather than a bare count.
    unpriced_component_count: int = 0


def _round_quantity(value: float | None) -> float | None:
    """Six decimals, the way the editor reads an amount and the quantity
    columns store one: `1 1/3` is 1.333333, never sixteen digits of float."""
    return None if value is None else round(value, 6)


def _number(value: str) -> float | None:
    value = value.replace(",", "").strip()
    if " " in value:
        whole, fraction = value.split(maxsplit=1)
        parsed_fraction = _number(fraction)
        try:
            result = (
                float(whole) + parsed_fraction
                if parsed_fraction is not None
                else None
            )
            return _round_quantity(
                result if result is None or math.isfinite(result) else None
            )
        except (ValueError, OverflowError):
            return None
    if "/" in value:
        try:
            numerator, denominator = (float(part) for part in value.split("/", 1))
            result = numerator / denominator if denominator else None
            return _round_quantity(
                result if result is None or math.isfinite(result) else None
            )
        except (ValueError, OverflowError):
            return None
    try:
        result = float(value)
        return _round_quantity(result) if math.isfinite(result) else None
    except (ValueError, OverflowError):
        return None


def _normalize_line_characters(value: str) -> str:
    """Strip the invisible characters pasted recipe text carries.

    Zero-width marks, the non-breaking space family (a paste of "1 1/2 cups"
    usually joins the whole number and the fraction with one), and the fraction
    slash all defeat the amount patterns otherwise.
    """
    value = re.sub(r"[\u200b-\u200d\ufeff]", "", value)
    value = re.sub(r"[\u00a0\u2007\u2009\u202f]", " ", value)
    return value.replace("\u2044", "/")


def _normalize_vulgar_fractions(value: str) -> str:
    result = ""
    for character in value:
        replacement = VULGAR_FRACTIONS.get(character)
        if replacement is None:
            result += character
            continue
        if result and result[-1].isdigit():
            result += " "
        result += replacement
    return result


def _unit(value: str) -> str:
    value = re.sub(r"\s+", " ", value.lower().replace(".", "")).strip()
    for unit, pattern in _UNIT_ALIASES:
        if re.fullmatch(pattern, value, re.IGNORECASE):
            return unit
    return "each"


@lru_cache(maxsize=4096)
def _ingredient_description(name: str) -> tuple[str, str, str]:
    """Return normalized full name, base identity, and preparation qualifier."""
    full = normalized_name(name)
    base = name.strip()
    qualifiers: list[str] = []
    # A recipe may write the annotation first ("(30ml) vegetable oil"). Move it
    # to the end so the peel loop below handles both orders.
    leading_parenthetical = re.match(r"^\(([^()]*)\)\s*(.+)$", base)
    if leading_parenthetical:
        base = (
            f"{leading_parenthetical.group(2).strip()} "
            f"({leading_parenthetical.group(1).strip()})"
        )
    while base:
        trailing_annotation = re.match(r"^(.*?),\s*([^,]+)$", base)
        if trailing_annotation and _NON_MEASURE_ANNOTATION.fullmatch(
            trailing_annotation.group(2).strip()
        ):
            base = trailing_annotation.group(1).strip()
            continue
        parenthetical = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", base)
        if parenthetical:
            base, annotation = parenthetical.groups()
            base = base.strip()
            annotation = annotation.strip()
            if not _NON_MEASURE_ANNOTATION.fullmatch(
                annotation
            ) and not _MEASURE_ANNOTATION.fullmatch(annotation):
                for clause in reversed(re.split(r"[,;]", annotation)):
                    clause = clause.strip()
                    if clause and not _MEASURE_ANNOTATION.fullmatch(clause):
                        qualifiers.insert(0, normalized_name(clause))
            continue
        if trailing_annotation and _QUALIFIER_CLAUSE.search(
            trailing_annotation.group(2)
        ):
            qualifiers.insert(
                0, normalized_name(trailing_annotation.group(2).strip())
            )
            base = trailing_annotation.group(1).strip()
            continue
        break
    size = _SIZE_WORD.match(base.strip())
    if size:
        base = size.group(1)
    return full, normalized_name(base), ", ".join(qualifiers)


def _profile_name(base_normalized: str) -> str | None:
    """The canonical ingredient-profile name this identity answers to."""
    return _PROFILE_BY_ALIAS.get(base_normalized)


def _each_weight_grams(name: str) -> float | None:
    """What one piece of this ingredient weighs, from its profile alone."""
    _, base, _ = _ingredient_description(_PROFILE_ANNOTATION.sub(" ", name))
    profile = _profile_name(base)
    return _EACH_WEIGHT_GRAMS.get(profile) if profile is not None else None


def _known_by_volume(
    name: str, resolve_density_name: Callable[[str], str | None] | None
) -> bool:
    _, _, qualifier = _ingredient_description(name)
    density_name = resolve_density_name(name) if resolve_density_name else None
    if density_name is None:
        return False
    return (
        grams_for(MILLILITERS_PER_UNIT["fl-oz"], density_name, qualifier) is not None
    )


def _converted_grams(
    amount: float,
    unit: str,
    name: str,
    resolve_measure: Callable[[float, str, str], MeasureResolution | None] | None,
    is_piece_yield_component: Callable[[str], bool] | None = None,
    resolve_density_name: Callable[[str], str | None] | None = None,
    has_identity: Callable[[str], bool] | None = None,
) -> MeasureResolution | None:
    # A pinch of saffron is not a pinch of salt: an approximate unit's factor
    # is a default, so what the kitchen saved for this ingredient answers first.
    if unit in APPROXIMATE_UNITS and resolve_measure is not None:
        resolved = resolve_measure(amount, unit, name)
        if resolved is not None:
            return resolved
    if unit in GRAMS_PER_UNIT:
        grams = amount * GRAMS_PER_UNIT[unit]
        if not math.isfinite(grams):
            return None
        # A recipe writing "oz" for something we know by volume may have meant
        # fluid ounces, and the two readings differ by more than rounding, so
        # the line is flagged instead of silently costing the mass reading.
        return MeasureResolution(
            grams,
            unit == "oz" and _known_by_volume(name, resolve_density_name),
        )
    if resolve_measure is not None:
        resolved = resolve_measure(amount, unit, name)
        if resolved is not None:
            return resolved
    # Nothing saved matched, but a cup of canola oil weighs what it weighs
    # regardless of who sells it, so the editor weighs it from the shared
    # density chart. The chart answers only for a matched ingredient — the
    # written words alone do not say what a cup of them weighs. This read model
    # must agree or a saved recipe would cost differently here than in the
    # editor.
    if unit in MILLILITERS_PER_UNIT:
        _, _, qualifier = _ingredient_description(name)
        density_name = resolve_density_name(name) if resolve_density_name else None
        if density_name is not None:
            grams = grams_for(
                amount * MILLILITERS_PER_UNIT[unit], density_name, qualifier
            )
            if grams is not None and math.isfinite(grams):
                return MeasureResolution(grams, False)
    # Resolve a matched piece-yield component BEFORE the built-in each-weight
    # profile, mirroring the editor. A component whose title collides with a
    # profile (e.g. one named `Egg`) must stay grams-unresolved here so the
    # pricing pass costs it from its sellable piece yield instead of an
    # invented 50 g each-weight.
    if (
        unit == "each"
        and is_piece_yield_component is not None
        and is_piece_yield_component(name)
    ):
        return None
    # Match the editor's ingredient-profile normalization for each-weight
    # conversion while retaining the annotated name for explicit match pricing.
    # A profile's each-weight is a fact about a known ingredient, so an
    # unmatched name gets no weight from it.
    if unit == "each" and has_identity is not None and has_identity(name):
        each_grams = _each_weight_grams(name)
        if each_grams is not None:
            grams = amount * each_grams
            return MeasureResolution(grams, False) if math.isfinite(grams) else None
    return None


def _name_first(line: str) -> tuple[float, str | None, str] | None:
    between = _NAME_UNIT_AMOUNT.match(line)
    if between:
        name, token, raw_amount = between.groups()
        amount = _number(raw_amount)
        if amount is not None and amount > 0 and _NAME_FIRST_UNIT.match(token):
            return amount, token, name.strip()
        if _UNSUPPORTED_UNIT.match(token):
            return None

    trailing = _NAME_AMOUNT_UNIT.match(line)
    if not trailing:
        return None
    name, raw_amount, token = trailing.groups()
    amount = _number(raw_amount)
    name = name.strip()
    if amount is None or amount <= 0 or not name:
        return None
    if token:
        if _NAME_FIRST_UNIT.match(token):
            return amount, token, name
        return None
    if _METHOD_TAIL.search(name):
        return None
    return amount, None, name


def _looks_unmeasured(
    line: str, has_identity: Callable[[str], bool] | None
) -> bool:
    """Whether a line with no amount still names a real ingredient — "olive
    oil, for brushing", "Drizzle of avocado oil". Those cost nothing, so this
    read model drops them instead of reporting a line it could not price."""
    if _VAGUE_QUANTITY.match(line):
        return True
    if _TRAILING_ANNOTATION.match(line):
        return True
    segments = line.split(",")
    for count in range(len(segments), 0, -1):
        candidate = ",".join(segments[:count]).strip()
        if not candidate:
            continue
        _, base, _ = _ingredient_description(candidate)
        if _profile_name(base) is not None or (
            has_identity is not None and has_identity(candidate)
        ):
            return True
    return False


def parse_ingredients(
    body: str,
    *,
    resolve_measure: Callable[[float, str, str], MeasureResolution | None]
    | None = None,
    is_piece_yield_component: Callable[[str], bool] | None = None,
    resolve_density_name: Callable[[str], str | None] | None = None,
    has_identity: Callable[[str], bool] | None = None,
    keep_unresolved_measures: bool = False,
) -> list[ParsedIngredient]:
    """Parse the costing subset of the frontend's line-oriented recipe syntax."""
    parsed: list[ParsedIngredient] = []
    for source in body.splitlines():
        line = _normalize_vulgar_fractions(
            _LIST_MARKER.sub("", _normalize_line_characters(source.strip()))
        ).strip()
        if not line:
            continue
        # A heading or a standalone note is text about the recipe, never a cost.
        if _HEADING_MARKER.match(line) or _STANDALONE_NOTE.match(line):
            continue
        if _HEADING_LABEL.match(line) and not _AMOUNT.match(line):
            continue
        leading_measure = (
            None if _AMOUNT.match(line) else _LEADING_MEASURE.match(line)
        )
        if leading_measure:
            line = (
                f"{leading_measure.group(1)} {leading_measure.group(2)} "
                f"{leading_measure.group(3).strip()}"
            )
        if _DECIMAL_COMMA.search(line):
            if keep_unresolved_measures:
                parsed.append(ParsedIngredient(name=line, grams=None))
            continue
        range_match = _RANGE.match(line)
        if range_match:
            tail = line[range_match.end() :].strip()
            low = _number(range_match.group(1))
            # A range is read at its low end: the cook who wrote "3 1/2 to 4
            # cups" still bought flour, and refusing the line lost it.
            if (
                _NON_INGREDIENT_RANGE_TAIL.match(tail)
                or _TEMPERATURE_RANGE_TAIL.match(tail)
                or low is None
                or low <= 0
            ):
                continue
            line = f"{range_match.group(1).strip()} {tail}"
        if _NUMBERED_INSTRUCTION.match(line):
            continue
        match = _AMOUNT.match(line)
        amount = _number(match.group(1)) if match else None
        remainder = match.group(2).strip() if match else ""
        extraction: tuple[float, str | None, str] | None = None
        if amount is not None and amount > 0 and remainder:
            unit_match = _SUPPORTED_UNIT.match(remainder)
            raw_unit = unit_match.group(1) if unit_match else None
            name = (unit_match.group(2) if unit_match else remainder).strip()
            if unit_match:
                name = re.sub(r"^of\s+", "", name, flags=re.IGNORECASE)
            if name and not (raw_unit is None and _UNSUPPORTED_UNIT.match(remainder)):
                extraction = amount, raw_unit, name
        else:
            extraction = _name_first(line)
        if extraction is None:
            # An amount or a unit token means the line was aimed at the
            # ingredient list, so the read model keeps it and reports the loss.
            # A bare word is a section heading and stays dropped, matching the
            # editor's `kind: "prose"`.
            if (
                keep_unresolved_measures
                and (match is not None or _SUPPORTED_UNIT.match(line))
                and not _looks_unmeasured(line, has_identity)
            ):
                parsed.append(ParsedIngredient(name=line, grams=None))
            continue
        amount, raw_unit, name = extraction
        # "1 tsp salt:" introduces its section with the amount already written;
        # the colon is punctuation, never part of what the line names.
        name = re.sub(r"\s*:$", "", name).strip()
        if _RESIDUAL_AMOUNT.match(name):
            if keep_unresolved_measures:
                parsed.append(ParsedIngredient(name=line, grams=None))
            continue
        unit = _unit(raw_unit) if raw_unit else None
        # "2 x 400 g cans …" reads `x` as a count unit, so the container weight
        # has to be reachable with that unit already matched.
        package = (
            _UNPARENTHESIZED_CONTAINER_WEIGHT.match(name)
            if raw_unit is None or unit == "each"
            else None
        )
        if package:
            package_amount = _number(package.group(1))
            package_unit = _unit(package.group(2))
            count_unit = _unit(package.group(3))
            if package_amount is not None and package_unit in GRAMS_PER_UNIT:
                grams = amount * package_amount * GRAMS_PER_UNIT[package_unit]
                if math.isfinite(grams):
                    parsed.append(
                        ParsedIngredient(
                            name=package.group(4).strip(),
                            grams=grams,
                            grams_are_explicit=True,
                            entered_amount=amount,
                            entered_unit=count_unit,
                        )
                    )
                continue

        explicit = _EXPLICIT_WEIGHT.match(name)
        if explicit:
            explicit_amount = _number(explicit.group(1))
            explicit_unit = _unit(explicit.group(2))
            marker = (explicit.group(3) or "").lower()
            remaining_name = explicit.group(4).strip()
            if raw_unit is None:
                count = _SUPPORTED_UNIT.match(remaining_name)
                if count and _unit(count.group(1)) in COUNT_UNITS:
                    unit = _unit(count.group(1))
                    remaining_name = count.group(2).strip()
            if (
                explicit_amount is not None
                and explicit_unit in GRAMS_PER_UNIT
                and remaining_name
            ):
                per_item = (
                    amount != 1
                    and (
                        marker == "each"
                        or (
                            marker != "total"
                            and (raw_unit is None or unit in COUNT_UNITS)
                        )
                    )
                )
                grams = explicit_amount * GRAMS_PER_UNIT[explicit_unit]
                grams *= amount if per_item else 1
                if math.isfinite(grams):
                    parsed.append(
                        ParsedIngredient(
                            name=remaining_name,
                            grams=grams,
                            grams_are_explicit=True,
                            entered_amount=amount,
                            entered_unit=unit,
                        )
                    )
                continue

        if unit is None:
            # A bare number reads as grams only because a matched ingredient
            # says what it is; with nothing matched the line has no unit at
            # all, which is at least honest about not knowing.
            if has_identity is None or not has_identity(name):
                if keep_unresolved_measures:
                    parsed.append(
                        ParsedIngredient(
                            name=name,
                            grams=None,
                            entered_amount=amount,
                            entered_unit=None,
                        )
                    )
                continue
            # "3 eggs" is a count, not three grams: reading it as a weight would
            # be less than one physical piece, so the each-weight is the only
            # reading that can have been meant.
            each_grams = _each_weight_grams(name)
            counted = each_grams is not None and amount < each_grams
            parsed.append(
                ParsedIngredient(
                    name=name,
                    grams=amount * each_grams if counted else amount,
                    entered_amount=amount,
                    entered_unit="g",
                )
            )
            continue
        resolved = _converted_grams(
            amount,
            unit,
            name,
            resolve_measure,
            is_piece_yield_component,
            resolve_density_name,
            has_identity,
        )
        if resolved is None:
            if keep_unresolved_measures:
                parsed.append(
                    ParsedIngredient(
                        name=name,
                        grams=None,
                        entered_amount=amount,
                        entered_unit=unit,
                    )
                )
            continue
        parsed.append(
            ParsedIngredient(
                name=name,
                grams=resolved.grams,
                grams_are_explicit=(
                    unit in GRAMS_PER_UNIT and unit not in APPROXIMATE_UNITS
                ),
                needs_review=resolved.needs_review,
                entered_amount=amount,
                entered_unit=unit,
            )
        )
    return parsed


def _matched_source(
    name: str,
    by_name: dict[str, PriceSource],
    by_id: dict[str, PriceSource],
    matches: dict[str, str],
    *,
    exclude_id: str | None = None,
) -> PriceSource | None:
    full, base, _ = _ingredient_description(name)
    exact = by_name.get(full) or by_name.get(base)
    saved_match = by_id.get(matches.get(full, "")) or by_id.get(matches.get(base, ""))
    match = exact or saved_match
    if match is not None and match.id == exclude_id:
        match = saved_match if saved_match is not None and saved_match.id != exclude_id else None
    return match


def _names_another_component(
    name: str, component_names: dict[str, str], owner_id: str | None
) -> bool:
    """Whether this line names some other component recipe of this tenant."""
    if not component_names:
        return False
    full, base, _ = _ingredient_description(name)
    target = component_names.get(full) or component_names.get(base)
    return target is not None and target != owner_id


def named_identities(body: str) -> tuple[set[str], set[tuple[str, str]]]:
    """Every ingredient identity a recipe body names, and the identity-and-
    preparation pairs its lines ask for. A recipe line references the pantry as
    text, so this is the only trace a recipe leaves on an ingredient."""
    identities: set[str] = set()
    qualified: set[tuple[str, str]] = set()
    for line in parse_ingredients(body, keep_unresolved_measures=True):
        full, base, qualifier = _ingredient_description(line.name)
        identities.update((full, base))
        for clause in qualifier_clauses(qualifier):
            qualified.update(((full, clause), (base, clause)))
    return identities, qualified


def _preparation_for(
    match: PriceSource, qualifier: str
) -> SourcePreparation | None:
    """The ingredient state this line asks for, or None when it asks for none.

    Exact equality on the normalized qualifier, the same rule a saved measure
    is matched by. An unqualified line names the ingredient as bought and must
    not pick up a preparation.
    """
    clauses = qualifier_clauses(qualifier)
    if not clauses:
        return None
    for preparation in match.preparations:
        if preparation.normalized_name in clauses:
            return preparation
    return None


def _standard_volume_ratio(
    unit: str, target: str, match: PriceSource, qualifier: str
) -> float | None:
    """How many `target` units one `unit` is, from the shared weight and volume
    table — what the standard conversion means: a litre of milk weighs what a
    litre of milk weighs, whoever sells it.

    Mass into volume only, mirroring apps/web/lib/pricing.ts: a volume line already
    reaches grams through the full precedence ladder, and the chart must not
    overtake an explicit weight or a saved measure. It describes the plain
    ingredient, so a qualified line takes no density."""
    if unit not in MASS_UNITS or target not in VOLUME_UNITS:
        return None
    grams = unit_ratio(unit, "g")
    per_millilitre = grams_for(
        1.0, match.measure_name or match.normalized_name, qualifier
    )
    if grams is None or not per_millilitre or per_millilitre <= 0:
        return None
    return convert_amount(grams / per_millilitre, "ml", target)


def _sale_units_for(
    amount: float | None,
    unit: str | None,
    match: PriceSource,
    preparation: SourcePreparation | None = None,
    qualifier: str = "",
) -> float | None:
    """How many sale units `amount unit` is, or None when nothing relates them.

    The unit on the line comes first: when it agrees with what was bought, no
    conversion happens and none is needed. Otherwise the matched preparation's
    own conversion answers when it states one, because a cup of yolks is not a
    cup of egg; one left on the standard conversion states no pairs and borrows
    the ingredient's. Either way its yield travels: 100 g of minced garlic at
    88% yield is 113.6 g of garlic bought, so the sale units go up. A line
    naming no state is costed at the ingredient's own yield instead, never
    both: 1 lb of tomato off a 90% case is 1.111 lb of case bought.

    The stated measures are one equivalence, not a description of the pack:
    227 g of butter is 1 cup of butter, whether the pack is a 1 lb block or a
    25 kg drum. So they answer by relating the line's family to the pack's, as
    `saleUnitsFor` in apps/web/lib/pricing.ts does. The line becomes a share of the
    measure stated in its own family, that share is taken of the measure stated
    in the family the pack is bought in, and the pack size divides.
    """
    source = PurchaseBasis(
        purchase_size=match.purchase_size,
        purchase_unit=match.purchase_unit,
        yield_percent=match.yield_percent,
        conversion=tuple(Measure(value, pair_unit) for value, pair_unit in match.conversion),
        conversion_is_automatic=match.conversion_is_automatic,
    )
    preparation_basis = (
        PreparationBasis(
            yield_percent=preparation.yield_percent,
            conversion=tuple(
                Measure(value, pair_unit)
                for value, pair_unit in preparation.conversion
            ),
            conversion_is_automatic=preparation.conversion_is_automatic,
        )
        if preparation is not None
        else None
    )
    expansion = purchase_quantity(
        amount,
        unit,
        source,
        preparation_basis,
        standard_bridge=lambda source_unit, purchase_unit: _standard_volume_ratio(
            source_unit,
            purchase_unit,
            match,
            "" if preparation is not None else qualifier,
        ),
    )
    return expansion.purchase_units


def _pack_grams(
    match: PriceSource,
    preparation: SourcePreparation | None = None,
    qualifier: str = "",
) -> float | None:
    """What one sale unit of the pack weighs: its size when bought by mass,
    otherwise the weight the stated pairs relate it to (a gallon bought of a
    row stating 227 g is 1 cup). None when nothing stated reaches a weight."""
    if match.purchase_unit is None or not match.purchase_size or match.purchase_size <= 0:
        return None
    grams = convert_amount(match.purchase_size, counted_as_each(match.purchase_unit), "g")
    if grams is not None:
        return grams
    per_gram = _sale_units_for(1.0, "g", match, preparation, qualifier)
    if per_gram is None or per_gram <= 0:
        return None
    return 1.0 / per_gram


def _price_lines(
    ingredients: Iterable[ParsedIngredient],
    by_name: dict[str, PriceSource],
    by_id: dict[str, PriceSource],
    matches: dict[str, str],
    *,
    exclude_id: str | None = None,
    component_names: dict[str, str] | None = None,
) -> BodyPricing:
    total = 0.0
    missing = 0
    missing_components = 0
    review = 0
    for ingredient in ingredients:
        review += int(ingredient.needs_review)
        match = _matched_source(
            ingredient.name,
            by_name,
            by_id,
            matches,
            exclude_id=exclude_id,
        )

        matched_component = int(
            component_names is not None
            and _names_another_component(
                ingredient.name, component_names, exclude_id
            )
        )
        if (
            match is not None
            and match.is_component
            and match.component_yield_unit == "pcs"
        ):
            # An `ea` line consumes whole pieces, whatever the batch weighs.
            if (
                ingredient.entered_unit == "each"
                and ingredient.entered_amount is not None
                and match.component_yield_amount is not None
                and math.isfinite(match.component_yield_amount)
                and match.component_yield_amount > 0
            ):
                cost = (
                    ingredient.entered_amount
                    * match.purchase_cost_cents
                    / match.component_yield_amount
                )
                next_total = total + cost
                if math.isfinite(cost) and math.isfinite(next_total):
                    total = next_total
                    continue
                missing += 1
                missing_components += matched_component
                continue
        # A raw input sum is not a finished-batch mass equivalency. Other
        # declared families remain usable without one.
        if (
            match is not None
            and match.is_component
            and ingredient.entered_unit in MASS_UNITS
            and (
                match.component_yield_unit == "pcs"
                or any(unit in VOLUME_UNITS for _amount, unit in match.conversion)
            )
            and not match.component_weight_known
        ):
            missing += 1
            missing_components += matched_component
            continue
        if match is None:
            missing += 1
            missing_components += matched_component
            continue
        # The unit the line was written in, then the weight the parser worked
        # out, which is itself a conversion.
        qualifier = _ingredient_description(ingredient.name)[2]
        preparation = _preparation_for(match, qualifier)
        sale_units = _sale_units_for(
            ingredient.entered_amount,
            ingredient.entered_unit,
            match,
            preparation,
            qualifier,
        )
        custom_preparation = (
            preparation is not None and not preparation.conversion_is_automatic
        )
        if (
            sale_units is None
            and ingredient.grams is not None
            and (not custom_preparation or ingredient.grams_are_explicit)
        ):
            sale_units = _sale_units_for(
                ingredient.grams, "g", match, preparation, qualifier
            )
        if sale_units is not None:
            cost = sale_units * match.purchase_cost_cents
        else:
            missing += 1
            missing_components += matched_component
            continue
        next_total = total + cost
        if not math.isfinite(cost) or not math.isfinite(next_total):
            missing += 1
            missing_components += matched_component
            continue
        total = next_total
    return BodyPricing(
        total_cents=total,
        unpriced_count=missing,
        review_count=review,
        unpriced_component_count=missing_components,
    )


@lru_cache(maxsize=1)
def catalog_measure_sources() -> tuple[MeasureSource, ...]:
    """The shared reviewed measures, which no tenant owns and none can edit.

    Global reference data read on every health and dashboard request. The only
    production writer is the `import_ingredient_measures` command running out of
    process, so the staleness tradeoff matches the density chart's.
    """
    return tuple(
        MeasureSource(
            ingredient_id=None,
            normalized_name=row.ingredient.normalized_name,
            unit=row.unit,
            amount=float(row.amount),
            grams=float(row.grams),
            low_grams=float(row.low_grams) if row.low_grams is not None else None,
            high_grams=float(row.high_grams) if row.high_grams is not None else None,
            qualifier=normalized_name(row.qualifier),
            is_user=False,
            confidence=row.confidence,
        )
        for row in CatalogIngredientMeasure.objects.select_related("ingredient")
        .filter(ingredient__is_active=True, is_active=True, is_default=True)
        .order_by("ingredient_id", "unit", "qualifier", "source_kind")
    )


def _clear_catalog_measure_sources(**_: Any) -> None:
    catalog_measure_sources.cache_clear()


for _model in (CatalogIngredientMeasure, CatalogIngredient):
    post_save.connect(
        _clear_catalog_measure_sources, sender=_model, dispatch_uid="catalog-measures"
    )
    post_delete.connect(
        _clear_catalog_measure_sources, sender=_model, dispatch_uid="catalog-measures"
    )


PREP_TIME_SECONDS = {"minutes": 60, "hours": 3600}


def labor_seconds_per_batch(
    recipe: Recipe, steps: Iterable[RecipeStep]
) -> tuple[float | None, int]:
    """Labor time for one batch, and how many active steps carry no timing."""
    if not recipe.auto_prep_time_enabled:
        per_unit = PREP_TIME_SECONDS.get(recipe.prep_time_unit)
        if recipe.prep_time_amount is None or per_unit is None:
            return None, 0
        return float(recipe.prep_time_amount) * per_unit, 0
    total: float | None = None
    untimed = 0
    for step in steps:
        if step.labor_kind != "active":
            continue
        # A timing records one whole batch, so the mean over them is the batch.
        observed = [t.seconds for t in step.timings.all() if t.seconds > 0]
        if not observed:
            untimed += 1
            continue
        total = (total or 0.0) + sum(observed) / len(observed)
    return total, untimed


class RecipeHealthReadModel:
    """One tenant-scoped costing snapshot, reused for every requested row."""

    def __init__(self, user: User, *, dashboard: bool = False):
        self.user = user
        self._normalized_recipes: dict[str, Recipe] | None = None
        self.settings = BenchCostSettings.objects.filter(
            user=user
        ).first() or BenchCostSettings(user=user)
        self.unit = "lb" if self.settings.measurement_system == "us" else "kg"
        recipe_rows = Recipe.objects.filter(user=user).annotate(
            _has_normalized_items=Exists(
                RecipeItem.objects.filter(recipe_id=OuterRef("pk"))
            )
            | Exists(RecipeStep.objects.filter(recipe_id=OuterRef("pk")))
        )
        # The old frontend built component sources from getRecipes(), whose
        # name order used title then id. Keep that exact precedence here: the
        # final source wins when legacy data contains duplicate component
        # titles, and editing a component must not silently change its price.
        source_order = (Lower("title").asc(), "id")
        if dashboard:
            self.all_recipes = list(
                recipe_rows.select_related("category", "equivalency")
                .prefetch_related(
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
                .order_by(*source_order)
            )
            component_recipes = [
                recipe
                for recipe in self.all_recipes
                if recipe.kind == Recipe.KIND_COMPONENT
            ]
            self._normalized_recipes = {
                str(recipe.id): recipe for recipe in self.all_recipes
            }
            self.has_any_recipe = bool(self.all_recipes)
        else:
            self.all_recipes = []
            self.has_any_recipe = recipe_rows.exists()
            component_recipes = list(
                recipe_rows.filter(kind=Recipe.KIND_COMPONENT)
                .select_related("equivalency")
                .only(
                    "id",
                    "title",
                    "body",
                    "kind",
                    "yield_amount",
                    "yield_unit",
                    "equivalency__mass_amount",
                    "equivalency__mass_unit",
                    "equivalency__volume_amount",
                    "equivalency__volume_unit",
                    "equivalency__count_amount",
                    "equivalency__count_unit",
                )
                .order_by(*source_order)
            )
        pantry = list(
            Ingredient.objects.filter(user=user)
            .select_related(
                "catalog_ingredient", "catalog_product__ingredient", "conversion"
            )
            .prefetch_related("preparations")
            .only(
                "id",
                "name",
                "normalized_name",
                "purchase_cost_cents",
                "purchase_size",
                "purchase_unit",
                "yield_percent",
                "catalog_ingredient__name",
                "catalog_product__ingredient__name",
                "catalog_product__ingredient__normalized_name",
                "conversion__average_weight",
                "conversion__weight_amount",
                "conversion__weight_unit",
                "conversion__volume_amount",
                "conversion__volume_unit",
                "conversion__each_amount",
                "conversion__each_unit",
            )
        )
        self.matches = {
            normalized_name(line): str(target_id)
            for line, (target_id, _kind) in saved_line_match_map(user).items()
        }
        sources = [
            PriceSource(
                id=str(row.id),
                normalized_name=row.normalized_name,
                measure_name=normalized_name(ingredient_measure_name(row)),
                purchase_cost_cents=row.purchase_cost_cents,
                purchase_size=(
                    float(row.purchase_size) if row.purchase_size is not None else None
                ),
                purchase_unit=row.purchase_unit,
                yield_percent=float(row.yield_percent),
                conversion=_conversion_pairs(row),
                conversion_is_automatic=(
                    row.conversion.average_weight
                    if getattr(row, "conversion", None) is not None
                    else True
                ),
                preparations=tuple(
                    SourcePreparation(
                        normalized_name=preparation.normalized_name,
                        yield_percent=(
                            float(preparation.yield_percent)
                            if preparation.yield_percent is not None
                            else None
                        ),
                        conversion=_stated_pairs(preparation),
                        conversion_is_automatic=preparation.average_weight,
                    )
                    for preparation in row.preparations.all()
                ),
            )
            for row in pantry
        ]
        self.pantry_by_name = {row.normalized_name: row for row in sources}
        pantry_by_id = {row.id: row for row in sources}
        self.by_name = self.pantry_by_name
        self.by_id = pantry_by_id
        user_measures = IngredientMeasure.objects.select_related(
            "ingredient"
        ).filter(ingredient__user=user)
        self.measures = [
            *catalog_measure_sources(),
            *[
                MeasureSource(
                    ingredient_id=str(row.ingredient_id),
                    normalized_name=row.ingredient.normalized_name,
                    unit=row.unit,
                    amount=float(row.amount),
                    grams=float(row.grams),
                    low_grams=None,
                    high_grams=None,
                    qualifier=normalized_name(row.qualifier),
                    is_user=True,
                    confidence="high",
                )
                for row in user_measures
            ],
        ]
        # `_resolve_measure` breaks score ties with `max`, which keeps the first
        # maximal candidate, so entries carry their `self.measures` index and
        # assembled candidates are re-sorted to the original scan order.
        self.measures_by_ingredient_id: dict[str, list[tuple[int, MeasureSource]]] = {}
        self.measures_by_name: dict[str, list[tuple[int, MeasureSource]]] = {}
        for index, measure in enumerate(self.measures):
            if measure.ingredient_id is not None:
                self.measures_by_ingredient_id.setdefault(
                    measure.ingredient_id, []
                ).append((index, measure))
            self.measures_by_name.setdefault(measure.normalized_name, []).append(
                (index, measure)
            )
        # Two passes, so a component may consume another component. Pass 1
        # prices against the pantry alone; pass 2 re-prices only what failed,
        # now against the pantry plus the components pass 1 established. Fixed
        # at two, this terminates with no recursion guard and still covers a
        # sub-recipe of a sub-recipe — the depth real kitchens write.
        self.component_issues: dict[str, str] = {}
        # Component titles as written, so a rejected component can say that a
        # line named another component rather than only that it went unpriced.
        self.component_names = {
            normalized_name(recipe.title): str(recipe.id)
            for recipe in component_recipes
        }
        priced, failed = self._component_sources(
            component_recipes, self.pantry_by_name, pantry_by_id
        )
        sources.extend(priced)
        if failed:
            second_by_name = {row.normalized_name: row for row in sources}
            second_by_id = {row.id: row for row in sources}
            priced, failed = self._component_sources(
                [recipe for recipe, _ in failed], second_by_name, second_by_id
            )
            sources.extend(priced)
        for recipe, pricing in failed:
            if pricing is not None and pricing.unpriced_component_count:
                self.component_issues[str(recipe.id)] = "references another component"
        # Components intentionally follow pantry rows, matching the frontend's
        # Map construction when a component and ingredient share a name.
        self.by_name = {row.normalized_name: row for row in sources}
        self.by_id = {row.id: row for row in sources}

    def _component_sources(
        self,
        component_recipes: Iterable[Recipe],
        by_name: dict[str, PriceSource],
        by_id: dict[str, PriceSource],
    ) -> tuple[list[PriceSource], list[tuple[Recipe, BodyPricing | None]]]:
        """Price each component against these maps; report the ones that failed."""
        # `_resolve_measure` reads the model's own maps, so this pass's maps are
        # what it must see while the pass runs.
        self.by_name = by_name
        self.by_id = by_id
        priced: list[PriceSource] = []
        failed: list[tuple[Recipe, BodyPricing | None]] = []
        for recipe in component_recipes:
            parsed = parse_ingredients(
                recipe.body,
                resolve_measure=self._resolve_measure,
                is_piece_yield_component=lambda name: self._is_piece_yield_component(
                    name, by_name, by_id
                ),
                resolve_density_name=lambda name: self._density_name(
                    name, by_name=by_name, by_id=by_id
                ),
                has_identity=lambda name: self._has_identity(
                    name, by_name=by_name, by_id=by_id
                ),
                keep_unresolved_measures=True,
            )
            if not parsed:
                failed.append((recipe, None))
                continue
            yield_basis = recipe.yield_amount
            declared_grams = _recipe_batch_grams(recipe, yield_basis)
            measure_pairs = _recipe_measure_pairs(recipe, yield_basis)
            counted = _recipe_batch_count(recipe, yield_basis)
            input_grams = sum(row.grams or 0 for row in parsed)
            grams = declared_grams or input_grams
            pricing = _price_lines(
                parsed,
                by_name,
                by_id,
                self.matches,
                exclude_id=str(recipe.id),
                component_names=self.component_names,
            )
            if (
                not math.isfinite(grams)
                or grams <= 0
                or pricing.unpriced_count
                or pricing.review_count
            ):
                failed.append((recipe, pricing))
                continue
            priced.append(
                PriceSource(
                    id=str(recipe.id),
                    normalized_name=normalized_name(recipe.title),
                    measure_name=normalized_name(recipe.title),
                    purchase_cost_cents=math.floor(pricing.total_cents + 0.5),
                    purchase_size=math.floor(grams + 0.5),
                    purchase_unit="g",
                    conversion=measure_pairs,
                    conversion_is_automatic=False,
                    is_component=True,
                    component_yield_amount=counted,
                    # "pcs" is the one spelling a piece basis is published
                    # in, whichever word the yield itself used.
                    component_yield_unit=(
                        "pcs" if counted is not None else None
                    ),
                    component_weight_known=declared_grams is not None,
                )
            )
        return priced, failed

    def _is_piece_yield_component(
        self,
        name: str,
        by_name: dict[str, PriceSource],
        by_id: dict[str, PriceSource],
        *,
        exclude_id: str | None = None,
    ) -> bool:
        # Centralize identity selection with the pricing pass: the parse phase
        # must recognize the same matched component that `_price_lines` would
        # cost by piece yield, so the built-in each-weight profile never
        # hijacks a component whose title collides with it.
        match = _matched_source(
            name, by_name, by_id, self.matches, exclude_id=exclude_id
        )
        return (
            match is not None
            and match.is_component
            and match.component_yield_unit == "pcs"
            and match.component_yield_amount is not None
            and math.isfinite(match.component_yield_amount)
            and match.component_yield_amount > 0
        )

    def _has_identity(
        self,
        name: str,
        *,
        by_name: dict[str, PriceSource] | None = None,
        by_id: dict[str, PriceSource] | None = None,
        exclude_id: str | None = None,
    ) -> bool:
        """Whether this line's name reached a known ingredient or component.

        A weight the text does not state — a bare count, a profile each-weight
        — is only ever the matched ingredient's, so this is what licenses it.
        """
        return (
            _matched_source(
                name,
                self.by_name if by_name is None else by_name,
                self.by_id if by_id is None else by_id,
                self.matches,
                exclude_id=exclude_id,
            )
            is not None
        )

    def _density_name(
        self,
        name: str,
        *,
        by_name: dict[str, PriceSource] | None = None,
        by_id: dict[str, PriceSource] | None = None,
        exclude_id: str | None = None,
    ) -> str | None:
        # Weigh the line as the ingredient it is priced as: the same matched
        # identity `_price_lines` uses — resolved through the same maps the
        # caller prices with — so a match cannot weigh flour while costing
        # oil. An unmatched name takes no density at all: its written words
        # say nothing about what a cup of it weighs. A component recipe never
        # takes a chart density either: its weight is its own, not the raw
        # ingredient its title happens to name.
        identity = _matched_source(
            name,
            self.by_name if by_name is None else by_name,
            self.by_id if by_id is None else by_id,
            self.matches,
            exclude_id=exclude_id,
        )
        if identity is None:
            return None
        if identity.is_component or not identity.conversion_is_automatic:
            return None
        return identity.measure_name or identity.normalized_name

    def _resolve_measure(
        self,
        amount: float,
        unit: str,
        ingredient_name: str,
        *,
        exclude_id: str | None = None,
        identity_id: str | None = None,
        qualifier_override: str | None = None,
    ) -> MeasureResolution | None:
        full, base, qualifier = _ingredient_description(ingredient_name)
        if qualifier_override is not None:
            qualifier = normalized_name(qualifier_override)
        else:
            qualifier = normalized_name(qualifier)
        profile = _profile_name(base)
        identity = self.by_id.get(identity_id or "")
        if identity is None:
            identity = _matched_source(
                ingredient_name,
                self.by_name,
                self.by_id,
                self.matches,
                exclude_id=exclude_id,
            )
        if identity is None and exclude_id is not None:
            identity = self.pantry_by_name.get(full) or self.pantry_by_name.get(base)
        measure_names = {
            identity.normalized_name if identity else "",
            identity.measure_name if identity else "",
        }

        # `measure_names` is a set, so bucket assembly order is arbitrary; the
        # index sort restores the `self.measures` scan order that `max` below
        # depends on for tie-breaks.
        matched: list[tuple[int, MeasureSource]] = []
        if identity is not None:
            if not identity.is_component:
                for name in measure_names:
                    matched.extend(
                        entry
                        for entry in self.measures_by_name.get(name, ())
                        if entry[1].ingredient_id is None
                    )
            matched.extend(self.measures_by_ingredient_id.get(identity.id, ()))
        else:
            # The editor also reaches a measure through the ingredient profile
            # ("strong flour" → "bread flour"), so this read model must too or
            # the recipe list and the editor weigh the same line differently.
            for name in dict.fromkeys((full, base, profile or "")):
                matched.extend(self.measures_by_name.get(name, ()))
        matched.sort(key=lambda entry: entry[0])
        candidates: list[tuple[int, MeasureSource, float]] = []
        for _, measure in matched:
            if (
                not math.isfinite(measure.amount)
                or measure.amount <= 0
                or not math.isfinite(measure.grams)
                or measure.grams <= 0
            ):
                continue
            if measure.qualifier != qualifier:
                continue
            direct = measure.unit == unit
            if not direct and not (
                measure.unit in MILLILITERS_PER_UNIT
                and unit in MILLILITERS_PER_UNIT
            ):
                continue
            if direct:
                grams = amount / measure.amount * measure.grams
            else:
                grams = (
                    amount
                    * MILLILITERS_PER_UNIT[unit]
                    / (measure.amount * MILLILITERS_PER_UNIT[measure.unit])
                    * measure.grams
                )
            score = (
                (100 if measure.is_user else 0)
                + (20 if measure.normalized_name == full else 0)
                + (12 if profile is not None and measure.normalized_name == profile else 0)
                + (10 if direct else 0)
                + {"high": 3, "medium": 2, "low": 1}.get(
                    measure.confidence, 0
                )
            )
            candidates.append((score, measure, grams))
        if not candidates:
            return None
        _, selected, grams = max(candidates, key=lambda candidate: candidate[0])
        needs_review = False
        if (
            not selected.is_user
            and selected.low_grams is not None
            and selected.high_grams is not None
        ):
            midpoint = (selected.high_grams + selected.low_grams) / 2
            needs_review = (
                midpoint > 0
                and (selected.high_grams - selected.low_grams) / midpoint > 0.1
            )
        return MeasureResolution(grams=grams, needs_review=needs_review)

    def costs_for(self, recipe_ids: Iterable[object]) -> dict[str, BenchCostRecipe]:
        steps = Prefetch(
            "steps",
            queryset=BenchCostStep.objects.prefetch_related("timings"),
        )
        rows = BenchCostRecipe.objects.filter(
            user=self.user, recipe_id__in=list(recipe_ids)
        ).prefetch_related(steps)
        # A (user, recipe) unique constraint now guarantees at most one row per
        # recipe, and migration 0054 detached the legacy duplicates it found.
        # setdefault keeps the historical winner — first in model order — so a
        # database restored from before that migration still reads the same way.
        costs: dict[str, BenchCostRecipe] = {}
        for row in rows:
            if row.recipe_id:
                costs.setdefault(str(row.recipe_id), row)
        return costs

    def _unit_divisor(self, recipe: Recipe) -> tuple[float, str] | None:
        declared_yield = recipe.yield_amount
        if not declared_yield or declared_yield <= 0:
            return None
        if recipe.yield_unit in COUNT_YIELD_UNITS:
            return (
                declared_yield,
                "/slice" if recipe.yield_unit == "slice" else "/pc",
            )
        milliliters = MILLILITERS_PER_UNIT.get(recipe.yield_unit or "")
        if milliliters is not None:
            return declared_yield * milliliters / 1000, "/L"
        grams = GRAMS_PER_UNIT.get(recipe.yield_unit or "")
        if grams is None:
            return None
        return declared_yield * grams / GRAMS_PER_UNIT[self.unit], f"/{self.unit}"

    @staticmethod
    def _labor(cost: BenchCostRecipe) -> tuple[float, int]:
        hands_on_seconds = 0.0
        untimed = 0
        for step in cost.steps.all():
            if step.kind != BenchCostStep.Kind.ACTIVE:
                continue
            timings = [
                timing
                for timing in step.timings.all()
                if timing.seconds > 0 and timing.yield_count > 0
            ]
            if not timings:
                untimed += 1
                continue
            total_seconds = sum(timing.seconds for timing in timings)
            total_yield = sum(timing.yield_count for timing in timings)
            hands_on_seconds += total_seconds / total_yield * cost.batch_yield
        return hands_on_seconds, untimed

    def _normalized_cost_detail(
        self, recipe: Recipe, path: set[str] | None = None
    ) -> tuple[float | None, list[str], float, dict[str, float | None]]:
        """Cost normalized rows and retain each saved line's contribution."""
        if recipe.user_id != self.user.id:
            # Shared recipe costs belong to the owner's private pantry. The
            # viewer read model must neither load nor attempt to reproduce it.
            return (
                None,
                [],
                float(recipe.yield_amount or 0),
                {},
            )
        recipe = self._owner_recipes().get(str(recipe.id), recipe)
        path = set() if path is None else path
        recipe_key = str(recipe.id)
        if recipe_key in path:
            return None, ["subrecipe cycle"], 0.0, {}
        path.add(recipe_key)
        total = 0.0
        issues: list[str] = []
        line_costs: dict[str, float | None] = {}
        items = getattr(recipe, "_normalized_items", None)
        if items is None:
            items = recipe.items.all()
        for item in items:
            if item.kind in {RecipeItem.HEADER, RecipeItem.NOTE}:
                continue
            item_key = str(item.id)
            # Left out of cost on purpose, so it is not a gap either.
            if item.excluded_from_cost:
                line_costs[item_key] = 0.0
                continue
            if item.quantity is None or not item.unit:
                line_costs[item_key] = None
                issues.append("missing quantity")
                continue
            # Efficiency describes the gross amount needed to deliver the
            # normalized net quantity, so the preparation loss scales what is
            # bought. Yield after cooking does not: what the oven takes out of
            # the dish was still paid for. Nutrition reads that field instead.
            quantity = float(item.quantity)
            efficiency = float(item.efficiency or 100)
            if efficiency <= 0:
                line_costs[item_key] = None
                issues.append("invalid efficiency")
                continue
            quantity *= 100.0 / efficiency
            if item.ingredient_id:
                cents = self.ingredient_cents(
                    str(item.ingredient_id),
                    quantity,
                    item.unit,
                    item.preparation_note,
                )
                if cents is None:
                    line_costs[item_key] = None
                    issues.append("unpriced ingredient")
                    continue
                line_costs[item_key] = cents
                total += cents
            elif item.subrecipe_id:
                child_total, child_issues, child_yield, child_line_costs = (
                    self._normalized_cost_detail(item.subrecipe, path)
                )
                line_costs.update(child_line_costs)
                issues.extend(child_issues)
                if child_total is None or child_yield <= 0:
                    line_costs[item_key] = None
                    issues.append("unpriced subrecipe")
                    continue
                child_unit = item.subrecipe.yield_unit or ""
                child_pairs = _recipe_measure_pairs(item.subrecipe, child_yield)
                child_count = _recipe_batch_count(item.subrecipe, child_yield)
                child_grams = _recipe_batch_grams(item.subrecipe, child_yield)
                child_source = PriceSource(
                    id=str(item.subrecipe_id),
                    normalized_name=normalized_name(item.subrecipe.title),
                    measure_name=normalized_name(item.subrecipe.title),
                    purchase_cost_cents=child_total,
                    purchase_size=child_yield,
                    purchase_unit=child_unit,
                    conversion=child_pairs,
                    conversion_is_automatic=False,
                    is_component=True,
                    component_yield_amount=child_count,
                    component_yield_unit=(
                        "pcs" if child_count is not None else None
                    ),
                    component_weight_known=child_grams is not None,
                )
                sale_units = _sale_units_for(quantity, item.unit, child_source)
                if sale_units is None:
                    line_costs[item_key] = None
                    issues.append("unpriced subrecipe")
                    continue
                cents = sale_units * child_total
                line_costs[item_key] = cents
                total += cents
            else:
                line_costs[item_key] = None
                issues.append("unresolved item")
        path.remove(recipe_key)
        divisor = recipe.yield_amount
        return total, issues, float(divisor or 0), line_costs

    def _normalized_cost(
        self, recipe: Recipe, path: set[str] | None = None
    ) -> tuple[float | None, list[str], float]:
        """Cost normalized item rows without consulting pasted body text."""
        total, issues, declared_yield, _line_costs = self._normalized_cost_detail(
            recipe, path
        )
        return total, issues, declared_yield

    def normalized_item_costs(self, recipe: Recipe) -> dict[str, float | None]:
        """The batch-cost contribution of every saved row in ``recipe``."""
        _total, _issues, _declared_yield, line_costs = (
            self._normalized_cost_detail(recipe)
        )
        return line_costs

    def _owner_recipes(self) -> dict[str, Recipe]:
        """The normalized owner graph, loaded once for every recursive read."""
        if self._normalized_recipes is None:
            normalized_rows = Recipe.objects.filter(user=self.user).select_related(
                "equivalency"
            ).prefetch_related(
                Prefetch(
                    "items",
                    queryset=RecipeItem.objects.select_related(
                        "ingredient", "subrecipe__equivalency"
                    ),
                    to_attr="_normalized_items",
                )
            )
            self._normalized_recipes = {
                str(row.id): row for row in normalized_rows
            }
        return self._normalized_recipes

    def _stray_word_issues(self, recipe: Recipe) -> list[str]:
        """"stray words" when a linked line's written name reads more than its
        link: the extra words are free text that neither weighing nor costing
        reads, which the editor flags in amber, so the list must say so too."""
        graph = self._owner_recipes().get(str(recipe.id), recipe)
        items = getattr(graph, "_normalized_items", None)
        if items is None:
            items = graph.items.all()
        issues: list[str] = []
        for item in items:
            written = normalized_name(item.display_name)
            if not written:
                continue
            if item.ingredient_id is not None:
                linked = item.ingredient.name
            elif item.subrecipe_id is not None:
                linked = item.subrecipe.title
            else:
                continue
            if written != normalized_name(linked):
                issues.append("stray words")
        return issues

    def _normalized_row(self, recipe: Recipe) -> JsonObject:
        total, issues, _declared_yield = self._normalized_cost(recipe)
        issues.extend(self._stray_word_issues(recipe))
        unit = _recipe_portion_divisor(recipe)
        portion_issue = _recipe_portion_issue(recipe)
        if portion_issue is not None:
            issues.append(portion_issue)
        divisor = unit[0] if unit is not None else None
        ingredient_cents = total / divisor if total is not None and divisor else None
        menu_price = (
            recipe.menu_price_cents
            if recipe.user_id == self.user.id and recipe.kind != Recipe.KIND_COMPONENT
            else None
        )
        food_cost = ingredient_cents / menu_price if ingredient_cents is not None and menu_price else None
        steps = getattr(recipe, "_normalized_steps", None)
        if steps is None:
            steps = recipe.steps.all()
        labor_seconds, untimed = labor_seconds_per_batch(recipe, steps)
        if labor_seconds is None:
            issues.append(
                "No timed steps" if recipe.auto_prep_time_enabled else "No prep time"
            )
        elif untimed:
            suffix = "s" if untimed > 1 else ""
            issues.append(f"{untimed} step{suffix} untimed")
        labor_cents = (
            labor_seconds / 3600 * self.settings.wage_per_hour_cents
            if labor_seconds is not None
            else None
        )
        return {
            "id": str(recipe.id), "publicId": recipe.public_id, "title": recipe.title,
            "code": recipe.code, "kind": recipe.kind, "status": recipe.status,
            "categoryId": str(recipe.category_id) if recipe.category_id else None,
            "category": recipe.category.name if recipe.category_id and recipe.category.user_id == recipe.user_id else None,
            "updatedAt": iso(recipe.updated_at), "ingredientCents": ingredient_cents,
            "menuPriceCents": menu_price, "foodCost": food_cost,
            "overTarget": bool(food_cost is not None and food_cost > self.settings.food_cost_target_bps / 10000),
            "suffix": unit[1] if unit is not None else "", "issues": sorted(set(issues)),
            "labor": (
                {
                    "centsPerBatch": round(labor_cents),
                    "centsPerPiece": labor_cents / divisor if divisor else None,
                }
                if labor_cents is not None
                else None
            ),
        }

    def row(self, recipe: Recipe, cost: BenchCostRecipe | None) -> JsonObject:
        has_normalized = getattr(recipe, "_has_normalized_items", None)
        if has_normalized is None:
            # Callers outside the recipe read views may provide a prefetched
            # relation but must never trigger a per-row existence query.
            cached_items = getattr(recipe, "_normalized_items", None)
            has_normalized = bool(cached_items) if cached_items is not None else False
        if has_normalized:
            return self._normalized_row(recipe)
        # The old client implementation removed the current component before
        # constructing its name map. If a pantry item shares that name, it must
        # remain available as the fallback price source.
        by_name = self.by_name
        exact = by_name.get(normalized_name(recipe.title))
        if exact is not None and exact.id == str(recipe.id):
            by_name = dict(by_name)
            pantry_match = self.pantry_by_name.get(exact.normalized_name)
            if pantry_match is None:
                by_name.pop(exact.normalized_name, None)
            else:
                by_name[exact.normalized_name] = pantry_match
        pricing = _price_lines(
            parse_ingredients(
                recipe.body,
                resolve_measure=lambda amount, unit, name: self._resolve_measure(
                    amount,
                    unit,
                    name,
                    exclude_id=str(recipe.id),
                ),
                is_piece_yield_component=lambda name: self._is_piece_yield_component(
                    name, by_name, self.by_id, exclude_id=str(recipe.id)
                ),
                resolve_density_name=lambda name: self._density_name(
                    name, by_name=by_name, exclude_id=str(recipe.id)
                ),
                has_identity=lambda name: self._has_identity(
                    name, by_name=by_name, exclude_id=str(recipe.id)
                ),
                keep_unresolved_measures=True,
            ),
            by_name,
            self.by_id,
            self.matches,
            exclude_id=str(recipe.id),
        )
        unit = _recipe_portion_divisor(recipe)
        issues: list[str] = []
        portion_issue = _recipe_portion_issue(recipe)
        if portion_issue is not None:
            issues.append(portion_issue)
        component_issue = self.component_issues.get(str(recipe.id))
        if component_issue is not None:
            issues.append(component_issue)
        elif pricing.unpriced_count:
            issues.append(f"{pricing.unpriced_count} unpriced")
        if pricing.review_count:
            suffix = "s" if pricing.review_count != 1 else ""
            issues.append(f"{pricing.review_count} estimate{suffix} to review")

        labor_batch = None
        labor_cents_per_unit = None
        if cost is None:
            issues.append("labor not tracked")
        elif not list(cost.steps.all()):
            issues.append("no steps")
        else:
            hands_on_seconds, untimed = self._labor(cost)
            if untimed:
                suffix = "s" if untimed > 1 else ""
                issues.append(f"{untimed} step{suffix} untimed")
            labor_batch = hands_on_seconds / 3600 * self.settings.wage_per_hour_cents
            if unit is not None:
                labor_cents_per_unit = labor_batch / unit[0]

        ingredient_cents = pricing.total_cents / unit[0] if unit else None
        menu_price = (
            None
            if recipe.kind == Recipe.KIND_COMPONENT
            else recipe.menu_price_cents
        )
        food_cost = (
            ingredient_cents / menu_price
            if ingredient_cents is not None and menu_price
            else None
        )
        category = (
            recipe.category
            if recipe.category is not None
            and recipe.category.user_id == recipe.user_id
            else None
        )
        return {
            "id": str(recipe.id),
            "publicId": recipe.public_id,
            "title": recipe.title,
            "code": recipe.code,
            "kind": recipe.kind,
            "status": recipe.status,
            "categoryId": str(category.id) if category else None,
            "category": category.name if category else None,
            "updatedAt": iso(recipe.updated_at),
            "ingredientCents": ingredient_cents,
            "menuPriceCents": menu_price,
            "foodCost": food_cost,
            "overTarget": bool(
                food_cost is not None
                and food_cost > self.settings.food_cost_target_bps / 10000
            ),
            "suffix": unit[1] if unit else "",
            "issues": issues,
            "labor": (
                {
                    "centsPerBatch": round(labor_batch),
                    "centsPerPiece": labor_cents_per_unit,
                }
                if labor_cents_per_unit is not None
                else None
            ),
        }

    def ingredient_cents(
        self, ingredient_id: str, quantity: float, unit: str, qualifier: str = ""
    ) -> float | None:
        """Cost of `quantity unit` of one pantry row, or None if unpriceable."""
        match = self.by_id.get(ingredient_id)
        # `by_id` also holds component recipes; the price route takes any UUID.
        if match is None or match.is_component or match.purchase_cost_cents <= 0:
            return None
        return self._source_cents(match, quantity, unit, qualifier)

    def _source_cents(
        self, match: PriceSource, quantity: float, unit: str, qualifier: str = ""
    ) -> float | None:
        """Price a line against one explicit pack tuple.

        Keeping the pack selection outside this method lets temporal readers
        reuse the exact conversion, preparation and measure ladder used by the
        current-cost screen.
        """
        preparation = _preparation_for(match, qualifier)
        custom_preparation = (
            preparation is not None and not preparation.conversion_is_automatic
        )
        sale_units = _sale_units_for(quantity, unit, match, preparation, qualifier)
        if sale_units is None and not custom_preparation:
            measure_qualifier = "" if preparation is not None else qualifier
            measured = self._resolve_measure(
                quantity,
                unit,
                match.normalized_name,
                identity_id=match.id,
                qualifier_override=measure_qualifier,
            )
            if measured is not None:
                sale_units = _sale_units_for(
                    measured.grams, "g", match, preparation, qualifier
                )
        if sale_units is None:
            return None
        return sale_units * match.purchase_cost_cents

    def line_grams(
        self, ingredient_id: str, quantity: float, unit: str, qualifier: str = ""
    ) -> float | None:
        """Grams of `quantity unit` of one pantry row, or None when nothing
        relates them. The same ladder `ingredient_cents` climbs, so a line
        weighs what it costs: a mass unit directly, then the stated pairs
        through the pack, then the saved and shared measures. Yields stay
        out of it, because a line says what went into the bowl, not what was
        bought to get there; and a price is not required, because an unpriced
        ingredient still weighs something.
        """
        match = self.by_id.get(ingredient_id)
        if match is None or match.is_component:
            return None
        grams = convert_amount(quantity, counted_as_each(unit), "g")
        if grams is not None:
            return grams
        preparation = _preparation_for(match, qualifier)
        custom_preparation = (
            preparation is not None and not preparation.conversion_is_automatic
        )
        bare = replace(match, yield_percent=None)
        bare_preparation = (
            replace(preparation, yield_percent=None) if preparation else None
        )
        sale_units = _sale_units_for(quantity, unit, bare, bare_preparation, qualifier)
        if sale_units is not None:
            pack_grams = _pack_grams(bare, bare_preparation, qualifier)
            if pack_grams is not None:
                return sale_units * pack_grams
        if custom_preparation:
            return None
        measure_qualifier = "" if preparation is not None else qualifier
        measured = self._resolve_measure(
            quantity,
            unit,
            match.normalized_name,
            identity_id=ingredient_id,
            qualifier_override=measure_qualifier,
        )
        return measured.grams if measured is not None else None

    def rows(self, recipes: Iterable[Recipe]) -> list[JsonObject]:
        recipes = list(recipes)
        costs = self.costs_for(recipe.id for recipe in recipes)
        return [self.row(recipe, costs.get(str(recipe.id))) for recipe in recipes]


def recipe_cost_diff_payload(
    model: RecipeHealthReadModel,
    recipe: Recipe,
    *,
    from_at,
    to_at,
    window_source: str,
) -> JsonObject:
    """Price today's normalized recipe graph at two history cutoffs.

    Recipe structure, preparations, conversions and yields deliberately stay
    current. Only the IngredientPrice pack tuple changes between the two
    evaluations, making this a price-impact read rather than a recipe audit.
    """
    recipes = model._owner_recipes()
    recipe = recipes.get(str(recipe.id), recipe)
    relevant: dict[str, Ingredient] = {}

    def collect(row: Recipe, path: set[str]) -> None:
        key = str(row.id)
        if key in path:
            return
        for item in getattr(row, "_normalized_items", []):
            if (
                item.kind in {RecipeItem.HEADER, RecipeItem.NOTE}
                or item.excluded_from_cost
                or item.quantity is None
                or not item.unit
            ):
                continue
            if (
                item.ingredient_id
                and item.ingredient is not None
                and item.ingredient.user_id == model.user.id
            ):
                relevant[str(item.ingredient_id)] = item.ingredient
            elif item.subrecipe_id:
                child = recipes.get(str(item.subrecipe_id))
                if child is not None:
                    collect(child, path | {key})

    collect(recipe, set())
    history = list(
        IngredientPrice.objects.filter(
            ingredient__user=model.user,
            ingredient_id__in=relevant.keys(),
            effective_at__lte=to_at,
        )
        .select_related("ingredient", "supplier_item")
        .order_by("ingredient_id", "-effective_at", "-created_at")
    )
    selected: dict[tuple[str, str], IngredientPrice] = {}
    changes_in_window = 0
    for row in history:
        ingredient_id = str(row.ingredient_id)
        selected.setdefault((ingredient_id, "to"), row)
        if row.effective_at <= from_at:
            selected.setdefault((ingredient_id, "from"), row)
        elif row.effective_at <= to_at:
            changes_in_window += 1

    issues: list[str] = []
    batch_cache: dict[tuple[str, str], float | None] = {}

    def ingredient_side(item: RecipeItem, side: str) -> JsonObject:
        history_row = selected.get((str(item.ingredient_id), side))
        if history_row is None:
            return {
                "status": "noHistory",
                "costCents": None,
                "unitCostCents": None,
                "effectiveAt": None,
                "source": None,
                "supplier": None,
            }
        current = model.by_id.get(str(item.ingredient_id))
        efficiency = float(item.efficiency)
        if (
            current is None
            or current.is_component
            or efficiency <= 0
            or history_row.purchase_cost_cents <= 0
        ):
            cents = None
        else:
            source = replace(
                current,
                purchase_cost_cents=history_row.purchase_cost_cents,
                purchase_size=(
                    float(history_row.purchase_size)
                    if history_row.purchase_size is not None
                    else None
                ),
                purchase_unit=history_row.purchase_unit,
            )
            quantity = float(item.quantity) * 100.0 / efficiency
            cents = model._source_cents(
                source,
                quantity,
                item.unit,
                item.preparation_note,
            )
        size = (
            float(history_row.purchase_size)
            if history_row.purchase_size is not None
            else None
        )
        unit_cents = (
            history_row.purchase_cost_cents / size
            if size is not None and size > 0
            else None
        )
        return {
            "status": "priced" if cents is not None else "unpriceable",
            "costCents": cents,
            "unitCostCents": unit_cents,
            "effectiveAt": iso(history_row.effective_at),
            "source": history_row.source,
            "supplier": (
                history_row.supplier_item.supplier
                if history_row.supplier_item_id
                else None
            ),
        }

    def recipe_batch(row: Recipe, side: str, path: set[str]) -> float | None:
        key = str(row.id)
        cache_key = (key, side)
        if cache_key in batch_cache:
            return batch_cache[cache_key]
        if key in path:
            issues.append("subrecipe cycle")
            return None
        items = getattr(row, "_normalized_items", [])
        cost_items = [
            item
            for item in items
            if item.kind not in {RecipeItem.HEADER, RecipeItem.NOTE}
        ]
        if not cost_items:
            issues.append("no normalized lines")
            batch_cache[cache_key] = None
            return None
        total = 0.0
        for item in cost_items:
            if item.excluded_from_cost:
                continue
            if item.quantity is None or not item.unit:
                batch_cache[cache_key] = None
                return None
            if item.ingredient_id and item.ingredient is not None:
                side_payload = ingredient_side(item, side)
                cents = side_payload["costCents"]
            elif item.subrecipe_id:
                child = recipes.get(str(item.subrecipe_id))
                if child is None:
                    cents = None
                else:
                    child_total = recipe_batch(child, side, path | {key})
                    child_yield = child.yield_amount
                    if child_total is None or not child_yield or child_yield <= 0:
                        cents = None
                    else:
                        child_pairs = _recipe_measure_pairs(child, child_yield)
                        child_count = _recipe_batch_count(child, child_yield)
                        child_grams = _recipe_batch_grams(child, child_yield)
                        source = PriceSource(
                            id=str(child.id),
                            normalized_name=normalized_name(child.title),
                            measure_name=normalized_name(child.title),
                            purchase_cost_cents=child_total,
                            purchase_size=float(child_yield),
                            purchase_unit=child.yield_unit or "",
                            conversion=child_pairs,
                            is_component=True,
                            component_yield_amount=child_count,
                            component_yield_unit=(
                                "pcs" if child_count is not None else None
                            ),
                            component_weight_known=child_grams is not None,
                        )
                        efficiency = float(item.efficiency)
                        sale_units = (
                            _sale_units_for(
                                float(item.quantity) * 100.0 / efficiency,
                                item.unit,
                                source,
                            )
                            if efficiency > 0
                            else None
                        )
                        cents = (
                            sale_units * child_total
                            if sale_units is not None
                            else None
                        )
            else:
                cents = None
            if cents is None:
                batch_cache[cache_key] = None
                return None
            total += cents
        batch_cache[cache_key] = total
        return total

    def line_status(item: RecipeItem) -> str:
        if item.excluded_from_cost:
            return "excluded"
        if item.quantity is None or not item.unit:
            return "missingQuantity"
        if item.ingredient_id is None and item.subrecipe_id is None:
            return "unresolved"
        return "comparable"

    def side_for(item: RecipeItem, side: str) -> JsonObject:
        if item.ingredient_id:
            return ingredient_side(item, side)
        child = recipes.get(str(item.subrecipe_id))
        cents = recipe_batch(child, side, set()) if child is not None else None
        if cents is not None and child is not None:
            child_yield = child.yield_amount
            if child_yield and child_yield > 0:
                child_pairs = _recipe_measure_pairs(child, child_yield)
                child_count = _recipe_batch_count(child, child_yield)
                child_grams = _recipe_batch_grams(child, child_yield)
                source = PriceSource(
                    id=str(child.id),
                    normalized_name=normalized_name(child.title),
                    measure_name=normalized_name(child.title),
                    purchase_cost_cents=cents,
                    purchase_size=float(child_yield),
                    purchase_unit=child.yield_unit or "",
                    conversion=child_pairs,
                    is_component=True,
                    component_yield_amount=child_count,
                    component_yield_unit=(
                        "pcs" if child_count is not None else None
                    ),
                    component_weight_known=child_grams is not None,
                )
                efficiency = float(item.efficiency)
                sale_units = (
                    _sale_units_for(
                        float(item.quantity) * 100.0 / efficiency,
                        item.unit,
                        source,
                    )
                    if efficiency > 0
                    else None
                )
                cents = sale_units * cents if sale_units is not None else None
            else:
                cents = None
        return {
            "status": "priced" if cents is not None else "unpriceable",
            "costCents": cents,
            "unitCostCents": None,
            "effectiveAt": None,
            "source": None,
            "supplier": None,
        }

    lines: list[JsonObject] = []
    required_lines = 0
    comparable_both = 0
    from_total = 0.0
    to_total = 0.0
    comparable_from = 0.0
    comparable_to = 0.0
    from_complete = True
    to_complete = True
    for item in getattr(recipe, "_normalized_items", []):
        if item.kind in {RecipeItem.HEADER, RecipeItem.NOTE}:
            continue
        status = line_status(item)
        from_side = side_for(item, "from") if status == "comparable" else None
        to_side = side_for(item, "to") if status == "comparable" else None
        delta = None
        if status != "excluded":
            required_lines += 1
        if status == "comparable":
            from_cents = from_side["costCents"]
            to_cents = to_side["costCents"]
            from_complete = from_complete and from_cents is not None
            to_complete = to_complete and to_cents is not None
            if from_cents is not None:
                from_total += from_cents
            if to_cents is not None:
                to_total += to_cents
            if from_cents is not None and to_cents is not None:
                comparable_both += 1
                comparable_from += from_cents
                comparable_to += to_cents
                delta = to_cents - from_cents
            if float(item.efficiency) <= 0:
                issues.append("invalid efficiency")
        elif status != "excluded":
            from_complete = False
            to_complete = False
            issues.append(
                "missing quantity" if status == "missingQuantity" else "unresolved item"
            )
        target_name = (
            item.ingredient.name
            if item.ingredient_id
            and item.ingredient is not None
            and item.ingredient.user_id == model.user.id
            else recipes[str(item.subrecipe_id)].title
            if item.subrecipe_id and str(item.subrecipe_id) in recipes
            else item.display_name
        )
        lines.append(
            {
                "itemId": str(item.id),
                "kind": item.kind,
                "name": target_name or item.display_name,
                "ingredientPublicId": (
                    item.ingredient.public_id
                    if item.ingredient_id
                    and item.ingredient is not None
                    and item.ingredient.user_id == model.user.id
                    else None
                ),
                "status": status,
                "basis": {
                    "quantity": (
                        float(item.quantity) if item.quantity is not None else None
                    ),
                    "unit": item.unit or None,
                    "efficiency": float(item.efficiency),
                    "preparation": item.preparation_note or None,
                },
                "from": from_side,
                "to": to_side,
                "deltaCents": delta,
            }
        )

    if required_lines == 0:
        from_complete = False
        to_complete = False
        issues.append("no normalized lines")
    full_from = from_total if from_complete else None
    full_to = to_total if to_complete else None
    last_change = None
    if changes_in_window == 0:
        prior_rows = [
            row
            for (ingredient_id, side), row in selected.items()
            if side == "from" and ingredient_id in relevant
        ]
        if prior_rows:
            previous = max(
                prior_rows, key=lambda row: (row.effective_at, row.created_at)
            )
            last_change = {
                "at": iso(previous.effective_at),
                "ingredient": {
                    "publicId": previous.ingredient.public_id,
                    "name": previous.ingredient.name,
                },
            }

    return {
        "recipe": {
            "id": str(recipe.id),
            "publicId": recipe.public_id,
            "title": recipe.title,
        },
        "window": {
            "fromAt": iso(from_at),
            "toAt": iso(to_at),
            "fromDate": from_at.date().isoformat(),
            "toDate": to_at.date().isoformat(),
            "days": (to_at.date() - from_at.date()).days,
            "source": window_source,
            "comparison": "priceOnlyCurrentRecipeBasis",
        },
        "basis": (
            "Using today's recipe quantities, yields and conversions; only "
            "ingredient prices vary between the two dates."
        ),
        "totals": {
            "fromCents": full_from,
            "toCents": full_to,
            "deltaCents": (
                full_to - full_from
                if full_from is not None and full_to is not None
                else None
            ),
            "fromComplete": from_complete,
            "toComplete": to_complete,
            "comparableFromCents": comparable_from,
            "comparableToCents": comparable_to,
            "comparableDeltaCents": comparable_to - comparable_from,
        },
        "coverage": {
            "requiredLines": required_lines,
            "comparableBoth": comparable_both,
            "skippedLines": required_lines - comparable_both,
        },
        "priceChangesInWindow": changes_in_window,
        "lastChangeBeforeWindow": last_change,
        "lines": lines,
        "issues": sorted(set(issues)),
        "currencyCode": model.settings.currency_code,
    }


def dashboard_recipe_metrics(model: RecipeHealthReadModel) -> JsonObject:
    rows = model.rows(model.all_recipes)
    food_costs = [row["foodCost"] for row in rows if row["foodCost"] is not None]
    target = model.settings.food_cost_target_bps / 10000
    return {
        "averageFoodCost": sum(food_costs) / len(food_costs) if food_costs else None,
        "totalRecipes": len(rows),
        "costedRecipes": len(food_costs),
        "recipesNeedingAttention": sum(
            bool(row["issues"])
            or (row["foodCost"] is not None and row["foodCost"] > target)
            for row in rows
        ),
        "foodCostTarget": target,
    }


def _price_per_unit(
    cents: float, amount, unit: str | None, target: str | None
) -> float | None:
    """What one `target` unit costs, or None when the units do not relate."""
    ratio = unit_ratio(unit, target)
    if ratio is None or not amount or float(amount) <= 0:
        return None
    return cents / (float(amount) * ratio)


def dashboard_price_moves(model: RecipeHealthReadModel) -> list[JsonObject]:
    """The last price change per ingredient, biggest move first.

    Compared per unit of sale, so an ingredient bought by the case counts the
    same as one bought by the kilo. A price row in a unit that no longer
    relates to how the ingredient is bought has nothing to compare and is
    skipped rather than guessed at.
    """
    rows = (
        IngredientPrice.objects.filter(
            ingredient__user=model.user,
            ingredient__purchase_size__gt=0,
            purchase_size__gt=0,
        )
        .select_related("ingredient")
        .order_by("ingredient_id", "-effective_at", "-created_at")
    )
    moves: list[tuple[float, object, JsonObject]] = []
    settled: set = set()
    for previous in rows:
        row = previous.ingredient
        if row.id in settled:
            continue
        now = _price_per_unit(
            row.purchase_cost_cents, row.purchase_size, row.purchase_unit, row.purchase_unit
        )
        was = _price_per_unit(
            previous.purchase_cost_cents,
            previous.purchase_size,
            previous.purchase_unit,
            row.purchase_unit,
        )
        if now is None or was is None or was <= 0:
            continue
        percent = (now - was) / was * 100
        if abs(percent) < 0.01:
            continue
        settled.add(row.id)
        # Priced in the kitchen's own weight unit when it was bought by weight,
        # and per unit of sale when it was not.
        shown = _price_per_unit(
            row.purchase_cost_cents, row.purchase_size, row.purchase_unit, model.unit
        )
        item = {
            "id": str(row.id),
            "name": row.name,
            "percent": percent,
            "unitPriceCents": shown if shown is not None else now,
            "unit": model.unit if shown is not None else (row.purchase_unit or ""),
        }
        moves.append((abs(percent), row.updated_at, item))
    moves.sort(
        key=lambda entry: (
            -entry[0],
            -entry[1].timestamp(),
            entry[2]["name"].casefold(),
            entry[2]["name"],
        )
    )
    return [entry[2] for entry in moves[:5]]


def dashboard_overview_json(model: RecipeHealthReadModel) -> JsonObject:
    return {
        "recipeMetrics": dashboard_recipe_metrics(model),
        "priceMoves": dashboard_price_moves(model),
        "currencyCode": model.settings.currency_code,
    }


def menu_items_queryset(menu: Menu):
    return MenuItem.objects.filter(menu=menu).select_related(
        "product", "recipe__category"
    )


def menu_recipe_rows(model: RecipeHealthReadModel) -> list[JsonObject]:
    """Every owned recipe costed in one pass; needs a dashboard read model."""
    return model.rows(model.all_recipes)


def menu_ingredient_rows(user: User) -> list[JsonObject]:
    return list(
        Ingredient.objects.filter(user=user)
        .order_by(Lower("name").asc(), "id")
        .values("id", "name", "purchase_unit", "non_edible")
    )


def menu_product_rows(user: User) -> list[JsonObject]:
    """Active products, each with the products it already contains.

    The picker needs those edges to keep a product out of its own
    composition, so they ship with the options rather than as a second call.
    """
    members: dict[Any, list[str]] = {}
    for parent_id, member_id in SalesProductComponent.objects.filter(
        product__user=user, component_product__isnull=False
    ).values_list("product_id", "component_product_id"):
        members.setdefault(parent_id, []).append(str(member_id))
    return [
        {
            "id": str(row["id"]),
            "publicId": row["public_id"],
            "name": row["name"],
            "componentProductIds": sorted(members.get(row["id"], ())),
        }
        for row in SalesProduct.objects.filter(user=user, is_active=True)
        .order_by(Lower("name").asc(), "id")
        .values("id", "public_id", "name")
    ]


def menu_item_cost_cents(
    item: MenuItem,
    *,
    recipe_costs: dict[str, float | None],
    index: BundleIndex,
) -> int | None:
    """Food cost through the link, never stored.

    A product row costs what its product page shows; a recipe row costs the
    recipe's cost per unit of sale as its Cost tab computes it. None when the
    source cannot be costed, or when the row is a leftover with no link.
    """
    if item.product_id:
        return index.unit_cost(item.product_id)
    if item.recipe_id:
        cents = recipe_costs.get(str(item.recipe_id))
        return None if cents is None else math.floor(cents + 0.5)
    return None


def menu_sources_payload(
    user: User,
    *,
    model: RecipeHealthReadModel | None = None,
    rows: list[JsonObject] | None = None,
) -> JsonObject:
    if model is None:
        model = RecipeHealthReadModel(user, dashboard=True)
    if rows is None:
        rows = menu_recipe_rows(model)
    return {
        "recipes": [menu_recipe_json(row) for row in rows],
        "ingredients": [
            menu_ingredient_json(row) for row in menu_ingredient_rows(user)
        ],
        "products": menu_product_rows(user),
        "currencyCode": model.settings.currency_code,
    }


def menu_detail_payload(
    user: User, menu: Menu, *, model: RecipeHealthReadModel | None = None
) -> JsonObject:
    if model is None:
        model = RecipeHealthReadModel(user, dashboard=True)
    recipe_rows = menu_recipe_rows(model)
    recipe_costs = {row["id"]: row["ingredientCents"] for row in recipe_rows}
    index = BundleIndex.for_user(user)
    items = list(menu_items_queryset(menu))
    product_ids = [item.product_id for item in items if item.product_id]
    # The same window the picker prices products over: the menu's period
    # when it has one, all time when it does not.
    sold_at_range = None
    if menu.period_start is not None:
        zone = workspace_zone(user)
        sold_at_range = (
            datetime.combine(menu.period_start, time.min, tzinfo=zone),
            datetime.combine(
                menu.period_end + timedelta(days=1), time.min, tzinfo=zone
            ),
        )
    stats = (
        product_sales_stats(user, product_ids, sold_at_range=sold_at_range, index=index)
        if product_ids
        else {}
    )
    return {
        "menu": menu_json(menu),
        "items": [
            menu_item_json(
                item,
                food_cost_cents=menu_item_cost_cents(
                    item, recipe_costs=recipe_costs, index=index
                ),
                source_qty_sold=(
                    (stats.get(item.product_id) or EMPTY_PRODUCT_SALES)["totalQuantity"]
                    if item.product_id
                    else None
                ),
            )
            for item in items
        ],
        **menu_sources_payload(user, model=model, rows=recipe_rows),
    }


def menu_component_price_payload(
    user: User, ingredient_id: str, unit: str
) -> JsonObject | None:
    """None when that id is not one of this tenant's pantry rows."""
    model = RecipeHealthReadModel(user)
    source = model.by_id.get(ingredient_id)
    if source is None or source.is_component:
        return None
    return {"unitCostCents": model.ingredient_cents(ingredient_id, 1.0, unit)}
