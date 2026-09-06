"""The label preview rollup: one recipe's nutrients, allergens and ingredient
statement from its normalized lines, nested recipes included.

This is the only engine that sums nutrients for a label preview. It weighs
each line through the ladder costing climbs (`RecipeHealthReadModel.line_grams`),
keeps each line's yield after cooking, divides by the declared finished
weight when one is stated, and never turns an unknown nutrient into a zero.
The invariants are pinned in docs/INGREDIENT_MEASURES.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from ...models import Ingredient, Recipe, RecipeItem, User
from ...units import counted_as_each, unit_family, unit_ratio
from ..shared.allergen_hints import has_allergen_hints
from ..shared.recipe_access import accessible_recipe_queryset, recipe_permission
from ..shared.values import normalized_name
from .health import (
    RecipeHealthReadModel,
    _ingredient_allergen_statuses,
    _recipe_measure_pairs,
    recipe_allergens_many,
)

JsonObject = dict[str, Any]

NUTRIENT_KEYS: tuple[str, ...] = (
    "calories",
    "energyKj",
    "fat",
    "saturatedFat",
    "transFat",
    "cholesterolMg",
    "sodiumMg",
    "salt",
    "totalCarbohydrate",
    "fiber",
    "sugars",
    "addedSugars",
    "protein",
    "vitaminDMcg",
    "calciumMg",
    "ironMg",
    "potassiumMg",
)

# What each preview format has to know before it is ready. Protein is on
# both; its percent daily value is not, because that needs a digestibility
# figure no ingredient record carries.
US_MANDATORY: tuple[str, ...] = (
    "calories",
    "fat",
    "saturatedFat",
    "transFat",
    "cholesterolMg",
    "sodiumMg",
    "totalCarbohydrate",
    "fiber",
    "sugars",
    "addedSugars",
    "protein",
    "vitaminDMcg",
    "calciumMg",
    "ironMg",
    "potassiumMg",
)
EU_MANDATORY: tuple[str, ...] = (
    "energyKj",
    "calories",
    "fat",
    "saturatedFat",
    "totalCarbohydrate",
    "sugars",
    "protein",
    "salt",
)

KJ_PER_KCAL = 4.184


@dataclass
class NutrientSum:
    amount: float = 0.0
    complete: bool = True


@dataclass
class Rollup:
    """One recipe, weighed and summed, before it is scaled into a parent."""

    lines: list[JsonObject]
    totals: dict[str, NutrientSum]
    # Grams as incorporated, per statement name, heaviest first when listed.
    statement: dict[str, float]
    statement_names: dict[str, str]
    # Tag keys each statement entry's ingredient carries as "contains".
    statement_allergens: dict[str, set[str]]
    input_grams: float
    declared_grams: float | None
    batch_grams: float | None
    # (count, unit) and (amount, unit): what one batch comes to, counted and
    # measured, so a parent's "2 slice" or "250 ml" line can be a share of it.
    pieces: tuple[float, str] | None
    volume: tuple[float, str] | None
    issues: set[str] = field(default_factory=set)
    has_lines: bool = False

    @property
    def blocked(self) -> bool:
        return bool(self.issues)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None


def per_100g_nutrients(snapshot: dict[str, Any], *, sugars_are_added: bool) -> dict[str, float | None]:
    """Read an Ingredient.nutrition_per_100g snapshot into label nutrients.

    The mass-accounting keys are always present on a snapshot, so the macros
    are complete; the rest are None when the record did not report them.
    Calories fall back to general Atwater factors when the record states
    none. Added sugars come only from a sweetener the user flagged.
    """
    fat = _number(snapshot.get("fat")) or 0.0
    protein = _number(snapshot.get("protein")) or 0.0
    sugars = _number(snapshot.get("sugars")) or 0.0
    starch = _number(snapshot.get("starch")) or 0.0
    fiber = _number(snapshot.get("fiber")) or 0.0
    salt = _number(snapshot.get("salt")) or 0.0
    carbohydrate = _number(snapshot.get("totalCarbohydrate"))
    if carbohydrate is None:
        carbohydrate = sugars + starch + fiber
    sodium = _number(snapshot.get("sodiumMg"))
    if sodium is None:
        sodium = salt / 2.5 * 1000
    calories = _number(snapshot.get("calories"))
    if calories is None:
        available = max(0.0, carbohydrate - fiber)
        calories = 4 * protein + 4 * available + 9 * fat + 2 * fiber
    return {
        "calories": calories,
        "energyKj": calories * KJ_PER_KCAL,
        "fat": fat,
        "saturatedFat": _number(snapshot.get("saturatedFat")),
        "transFat": _number(snapshot.get("transFat")),
        "cholesterolMg": _number(snapshot.get("cholesterolMg")),
        "sodiumMg": sodium,
        "salt": salt,
        "totalCarbohydrate": carbohydrate,
        "fiber": fiber,
        "sugars": sugars,
        "addedSugars": sugars if sugars_are_added else _number(snapshot.get("addedSugars")),
        "protein": protein,
        "vitaminDMcg": _number(snapshot.get("vitaminDMcg")),
        "calciumMg": _number(snapshot.get("calciumMg")),
        "ironMg": _number(snapshot.get("ironMg")),
        "potassiumMg": _number(snapshot.get("potassiumMg")),
    }


def _load_graph(root: Recipe) -> dict[object, Recipe]:
    """Every recipe the root reaches, one item query per depth, with the
    lines attached so the allergen loader costs nothing more."""
    graph: dict[object, Recipe] = {root.id: root}
    pending = {root.id}
    while pending:
        items = list(
            RecipeItem.objects.filter(recipe_id__in=pending)
            .select_related(
                "ingredient__catalog_ingredient",
                "ingredient__catalog_product__ingredient",
                "subrecipe__equivalency",
            )
            .prefetch_related(
                "ingredient__allergen_overrides",
                "ingredient__catalog_ingredient__allergen_defaults",
                "ingredient__catalog_product__ingredient__allergen_defaults",
            )
        )
        for recipe_id in pending:
            graph[recipe_id]._normalized_items = []  # type: ignore[attr-defined]
        for item in items:
            graph[item.recipe_id]._normalized_items.append(item)  # type: ignore[attr-defined]
        pending = set()
        for item in items:
            if item.subrecipe_id and item.subrecipe_id not in graph:
                graph[item.subrecipe_id] = item.subrecipe
                pending.add(item.subrecipe_id)
    return graph


def _batch_basis(
    recipe: Recipe,
) -> tuple[float | None, tuple[float, str] | None, tuple[float, str] | None]:
    """What one batch comes to: a declared weight, a count and a volume.

    The yield states one of them; the equivalency states the others for the
    same batch. Mirrors `componentPriceSource` in apps/web/lib/pricing.ts.
    """
    declared: float | None = None
    pieces: tuple[float, str] | None = None
    volume: tuple[float, str] | None = None
    for amount, unit in _recipe_measure_pairs(recipe):
        family = unit_family(unit)
        if family == "mass" and declared is None:
            declared = unit_ratio(unit, "g") * amount  # type: ignore[operator]
        elif family == "volume" and volume is None:
            volume = (amount, unit)
        elif family == "count" and pieces is None:
            pieces = (amount, unit)
    return declared, pieces, volume


def _share_of_batch(
    amount: float,
    unit: str,
    batch_grams: float,
    pieces: tuple[float, str] | None,
    volume: tuple[float, str] | None,
) -> float | None:
    """Grams of `amount unit` of a batch: directly for a weight, as a share
    of the batch's count or volume otherwise. None when nothing relates them."""
    family = unit_family(unit)
    if family == "mass":
        ratio = unit_ratio(unit, "g")
        return None if ratio is None else amount * ratio
    if family == "count" and pieces is not None:
        count, count_unit = pieces
        ratio = unit_ratio(counted_as_each(unit), counted_as_each(count_unit))
        if ratio is None or count <= 0:
            return None
        return amount * ratio / count * batch_grams
    if family == "volume" and volume is not None:
        vol, vol_unit = volume
        ratio = unit_ratio(unit, vol_unit)
        if ratio is None or vol <= 0:
            return None
        return amount * ratio / vol * batch_grams
    return None


def _add_nutrients(
    totals: dict[str, NutrientSum], per_100g: dict[str, float | None], grams: float
) -> None:
    for key in NUTRIENT_KEYS:
        value = per_100g.get(key)
        if value is None:
            totals[key].complete = False
        else:
            totals[key].amount += value * grams / 100


def _scale_nutrients(
    totals: dict[str, NutrientSum], child: dict[str, NutrientSum], factor: float
) -> None:
    for key in NUTRIENT_KEYS:
        totals[key].amount += child[key].amount * factor
        totals[key].complete = totals[key].complete and child[key].complete


def _add_statement(
    rollup: Rollup, name: str, grams: float, allergens: set[str]
) -> None:
    key = normalized_name(name)
    if not key:
        return
    rollup.statement[key] = rollup.statement.get(key, 0.0) + grams
    rollup.statement_names.setdefault(key, name)
    rollup.statement_allergens.setdefault(key, set()).update(allergens)


def _ingredient_line_name(item: RecipeItem, ingredient: Ingredient | None) -> str:
    if ingredient is not None:
        return ingredient.nutrition_label_name.strip() or ingredient.name
    return item.display_name


class NutritionRollup:
    def __init__(self, model: RecipeHealthReadModel, graph: dict[object, Recipe]):
        self.model = model
        self.graph = graph
        self.memo: dict[object, Rollup] = {}

    def rollup(self, recipe_id: object, path: frozenset[object] = frozenset()) -> Rollup:
        if recipe_id in self.memo:
            return self.memo[recipe_id]
        recipe = self.graph[recipe_id]
        declared, pieces, volume = _batch_basis(recipe)
        result = Rollup(
            lines=[],
            totals={key: NutrientSum() for key in NUTRIENT_KEYS},
            statement={},
            statement_names={},
            statement_allergens={},
            input_grams=0.0,
            declared_grams=declared,
            batch_grams=None,
            pieces=pieces,
            volume=volume,
        )
        line_count = 0
        path = path | {recipe_id}
        for item in getattr(recipe, "_normalized_items", []):
            if item.kind not in {RecipeItem.INGREDIENT, RecipeItem.SUBRECIPE}:
                continue
            result.has_lines = True
            line_count += 1
            if item.kind == RecipeItem.INGREDIENT:
                self._ingredient_line(item, result)
            else:
                self._subrecipe_line(item, result, path)
        excluded = sum(
            1 for row in result.lines if row["status"] in {"nonEdible", "discarded"}
        )
        # Nothing stays in the dish: every line is packaging or poured off,
        # or there are no lines at all. A line that merely needs linking or
        # weighing names its own issue instead.
        if excluded == line_count:
            result.issues.add("allExcluded")
        result.batch_grams = (
            result.declared_grams
            if result.declared_grams is not None and result.declared_grams > 0
            else (result.input_grams if result.input_grams > 0 else None)
        )
        # No declared weight and nothing weighed to sum. Named only when it
        # is the whole story: with lines still to link or weigh, the missing
        # weight is their consequence, not a second thing to fix.
        if result.batch_grams is None and not result.issues:
            result.issues.add("noYield")
        self.memo[recipe_id] = result
        return result

    def _line(self, item: RecipeItem, **values: Any) -> JsonObject:
        row: JsonObject = {
            "itemId": str(item.id),
            "kind": item.kind,
            "name": item.display_name,
            "ingredientId": str(item.ingredient_id) if item.ingredient_id else None,
            "ingredientPublicId": None,
            "subrecipeId": str(item.subrecipe_id) if item.subrecipe_id else None,
            "subrecipePublicId": None,
            "linkedDescription": None,
            "linkedSource": None,
            "nonEdible": False,
            # Only a pantry line can carry hints; a sub-recipe line is the
            # rollup of its own lines, each of which answers for itself.
            "hasAllergenHints": False,
            "efficiencyAfterCooking": float(item.efficiency_after_cooking or 0),
            "grams": None,
            "netGrams": None,
            "status": "unresolved",
        }
        row.update(values)
        return row

    def _ingredient_line(self, item: RecipeItem, result: Rollup) -> bool:
        """Weigh one pantry line into the rollup. True when it contributed."""
        ingredient = item.ingredient
        if ingredient is None:
            result.lines.append(self._line(item))
            result.issues.add("unresolvedItem")
            return False
        name = ingredient.name
        retained = float(item.efficiency_after_cooking or 0) / 100
        linked = ingredient.nutrition_per_100g is not None
        source = ingredient.nutrition_source or None
        description = ingredient.nutrition_description or None
        hints = has_allergen_hints(ingredient)
        if ingredient.non_edible:
            result.lines.append(
                self._line(
                    item,
                    name=name,
                    ingredientPublicId=ingredient.public_id,
                    linkedDescription=description if linked else None,
                    linkedSource=source if linked else None,
                    nonEdible=True,
                    status="nonEdible",
                )
            )
            return False
        grams = None
        if item.quantity is not None and item.unit:
            grams = self.model.line_grams(
                str(ingredient.id),
                float(item.quantity),
                item.unit,
                normalized_name(item.preparation_note),
            )
        net = grams * retained if grams is not None else None
        row = self._line(
            item,
            name=name,
            ingredientPublicId=ingredient.public_id,
            linkedDescription=description if linked else None,
            linkedSource=source if linked else None,
            hasAllergenHints=hints,
            grams=grams,
            netGrams=net,
        )
        if not linked:
            row["status"] = "unlinked"
            result.lines.append(row)
            result.issues.add("unlinkedIngredient")
            return False
        if grams is None:
            row["status"] = "unweighed"
            result.lines.append(row)
            result.issues.add("unweighedItem")
            return False
        if retained <= 0:
            row["status"] = "discarded"
            result.lines.append(row)
            return False
        row["status"] = "linked"
        result.lines.append(row)
        _add_nutrients(
            result.totals,
            per_100g_nutrients(
                ingredient.nutrition_per_100g,
                sugars_are_added=ingredient.sugars_are_added,
            ),
            net,  # type: ignore[arg-type]
        )
        result.input_grams += net  # type: ignore[operator]
        _add_statement(
            result,
            _ingredient_line_name(item, ingredient),
            grams,
            {
                key
                for key, status in _ingredient_allergen_statuses(ingredient).items()
                if status == "contains"
            },
        )
        return True

    def _subrecipe_line(
        self, item: RecipeItem, result: Rollup, path: frozenset[object]
    ) -> bool:
        child_recipe = item.subrecipe
        if child_recipe is None:
            result.lines.append(self._line(item))
            result.issues.add("unresolvedItem")
            return False
        name = child_recipe.title
        retained = float(item.efficiency_after_cooking or 0) / 100
        row = self._line(item, name=name, subrecipePublicId=child_recipe.public_id)
        if child_recipe.id in path:
            row["status"] = "subrecipeIncomplete"
            result.lines.append(row)
            result.issues.add("subrecipeIncomplete")
            return False
        child = self.rollup(child_recipe.id, path)
        if not child.has_lines:
            row["status"] = "subrecipeIncomplete"
            result.lines.append(row)
            result.issues.add("subrecipeEmpty")
            return False
        if child.blocked or child.batch_grams is None:
            row["status"] = "subrecipeIncomplete"
            result.lines.append(row)
            result.issues.add("subrecipeIncomplete")
            return False
        grams = None
        if item.quantity is not None and item.unit:
            grams = _share_of_batch(
                float(item.quantity), item.unit, child.batch_grams, child.pieces, child.volume
            )
        if grams is None:
            row["status"] = "unweighed"
            result.lines.append(row)
            result.issues.add("subrecipeUnresolved")
            return False
        net = grams * retained
        row["grams"] = grams
        row["netGrams"] = net
        if retained <= 0:
            row["status"] = "discarded"
            result.lines.append(row)
            return False
        row["status"] = "linked"
        result.lines.append(row)
        _scale_nutrients(result.totals, child.totals, net / child.batch_grams)
        result.input_grams += net
        # The statement lists what went in as it went in: the child's lines,
        # scaled to the share of its batch this line took.
        incorporated = grams / child.batch_grams
        for key, child_grams in child.statement.items():
            _add_statement(
                result,
                child.statement_names[key],
                child_grams * incorporated,
                child.statement_allergens[key],
            )
        return True


def _measure_grams(
    amount: float | None,
    unit: str,
    rollup: Rollup,
    *,
    issue_missing: str | None,
    issue_unrelatable: str,
) -> tuple[float | None, set[str]]:
    if amount is None or amount <= 0 or not unit:
        return None, {issue_missing} if issue_missing else set()
    if unit_family(unit) == "mass":
        ratio = unit_ratio(unit, "g")
        return (None, {issue_unrelatable}) if ratio is None else (amount * ratio, set())
    if rollup.batch_grams is None:
        return None, set()
    grams = _share_of_batch(amount, unit, rollup.batch_grams, rollup.pieces, rollup.volume)
    if grams is None:
        return None, {issue_unrelatable}
    return grams, set()


def _serving_grams(
    recipe: Recipe, rollup: Rollup
) -> tuple[float | None, set[str]]:
    return _measure_grams(
        _number(recipe.nutrition_serving_amount),
        recipe.nutrition_serving_unit or "",
        rollup,
        issue_missing="noServingSize",
        issue_unrelatable="servingNeedsEquivalency",
    )


def _package_grams(
    recipe: Recipe, rollup: Rollup
) -> tuple[float | None, set[str]]:
    """An unset package is not an issue; it means the batch is the container."""
    return _measure_grams(
        _number(recipe.nutrition_package_amount),
        recipe.nutrition_package_unit or "",
        rollup,
        issue_missing=None,
        issue_unrelatable="packageNeedsEquivalency",
    )


def _nutrients_json(totals: dict[str, NutrientSum], factor: float) -> JsonObject:
    return {
        key: {
            "amount": round(totals[key].amount * factor, 3),
            "complete": totals[key].complete,
        }
        for key in NUTRIENT_KEYS
    }


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 3)


def _readiness(
    totals: dict[str, NutrientSum] | None, mandatory: Iterable[str], *, blocked: bool
) -> JsonObject:
    missing = (
        [key for key in mandatory if not totals[key].complete] if totals is not None else []
    )
    return {"ready": not blocked and not missing, "missing": missing}


def recipe_nutrition_payload(recipe: Recipe, viewer: User) -> JsonObject:
    """The label preview for one recipe, as the viewer may see it.

    The rollup runs through the owner's pantry, because the nutrients belong
    to the owner's ingredients; nothing priced leaves this function. A viewer
    gets names, statuses, weights, allergens, totals and readiness, and no
    handle on the owner's pantry or on recipes they cannot open.
    """
    permission = recipe_permission(recipe, viewer) or "viewer"
    owner = permission == "owner"
    graph = _load_graph(recipe)
    model = RecipeHealthReadModel(recipe.user)
    rollup = NutritionRollup(model, graph).rollup(recipe.id)
    serving_grams, serving_issues = _serving_grams(recipe, rollup)
    package_grams, package_issues = _package_grams(recipe, rollup)
    # Physical constraints between the three measures. They ride in the serving
    # set, so they block the per-serving totals like the other serving issues.
    batch = rollup.batch_grams
    if package_grams is not None and serving_grams is not None and package_grams < serving_grams:
        serving_issues.add("packageBelowServing")
    if serving_grams is not None and batch is not None and serving_grams > batch:
        serving_issues.add("servingAboveBatch")
    if package_grams is not None and batch is not None and package_grams > batch:
        serving_issues.add("packageAboveBatch")
    allergen_statuses = recipe_allergens_many(graph.values()).get(recipe.id, {})

    openable: set[object]
    if owner:
        openable = set(graph)
    else:
        openable = set(
            accessible_recipe_queryset(viewer, prefetch_shares=False)
            .filter(id__in=list(graph))
            .values_list("id", flat=True)
        )
    public_ids = {row.id: row.public_id for row in graph.values()}
    lines: list[JsonObject] = []
    for row in rollup.lines:
        line = dict(row)
        subrecipe_id = line.pop("subrecipeId")
        line.pop("ingredientId")
        child_key = next(
            (key for key in graph if str(key) == subrecipe_id), None
        ) if subrecipe_id else None
        line["subrecipePublicId"] = (
            public_ids[child_key] if child_key is not None and child_key in openable else None
        )
        if not owner:
            line["ingredientPublicId"] = None
            line["linkedDescription"] = None
            line["linkedSource"] = None
            # A hint is the owner's unfinished pantry work, not a fact about
            # the dish, so a viewer is never shown one.
            line["hasAllergenHints"] = False
        line["grams"] = _round(line["grams"])
        line["netGrams"] = _round(line["netGrams"])
        lines.append(line)

    blocked = rollup.blocked
    batch_grams = rollup.batch_grams
    # An unset package means the batch is the container. A package that was
    # asked for and could not be related has no count rather than the batch's.
    package_asked = recipe.nutrition_package_amount is not None
    container_grams = package_grams if package_asked else batch_grams
    totals = None if blocked or batch_grams is None else rollup.totals
    batch_json = _nutrients_json(totals, 1.0) if totals is not None else None
    per_100g_json = (
        _nutrients_json(totals, 100 / batch_grams) if totals is not None else None  # type: ignore[operator]
    )
    per_serving_json = (
        _nutrients_json(totals, serving_grams / batch_grams)  # type: ignore[operator]
        if totals is not None and serving_grams is not None and not serving_issues
        else None
    )
    statement = sorted(
        (
            {
                "name": rollup.statement_names[key],
                "grams": round(grams, 3),
                "allergens": sorted(rollup.statement_allergens[key]),
            }
            for key, grams in rollup.statement.items()
        ),
        key=lambda entry: (-entry["grams"], entry["name"].casefold()),
    )
    return {
        "recipeId": str(recipe.id),
        "publicId": recipe.public_id,
        "title": recipe.title,
        "permission": permission,
        "canEdit": permission in {"owner", "editor"},
        "serving": {
            "amount": _number(recipe.nutrition_serving_amount),
            "unit": recipe.nutrition_serving_unit or "",
            "grams": _round(serving_grams),
        },
        "package": {
            "amount": _number(recipe.nutrition_package_amount),
            "unit": recipe.nutrition_package_unit or "",
            "grams": _round(package_grams),
        },
        "batch": {
            "grams": _round(batch_grams),
            "declaredGrams": _round(rollup.declared_grams),
            "inputGrams": round(rollup.input_grams, 3),
            "servings": (
                round(container_grams / serving_grams, 3)
                if container_grams is not None and serving_grams
                else None
            ),
            "containers": (
                round(batch_grams / package_grams, 3)
                if batch_grams is not None and package_grams
                else None
            ),
        },
        "lines": lines,
        "totals": {
            "batch": batch_json,
            "per100g": per_100g_json,
            "perServing": per_serving_json,
        },
        "allergens": {
            "contains": sorted(key for key, status in allergen_statuses.items() if status == "contains"),
            "mayContain": sorted(key for key, status in allergen_statuses.items() if status == "mayContain"),
        },
        "statement": statement,
        "issues": {
            "batch": sorted(rollup.issues),
            "serving": sorted(serving_issues | package_issues),
        },
        "readiness": {
            "us": _readiness(
                totals, US_MANDATORY, blocked=blocked or per_serving_json is None
            ),
            "eu": _readiness(totals, EU_MANDATORY, blocked=blocked),
        },
    }
