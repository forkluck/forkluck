"""Model-agnostic physical recipe expansion.

This module owns the arithmetic that turns a recipe quantity into physical
usage and, when a purchase basis is known, gross purchasing demand.  It does
not know Django models, prices, inventory, or presentation.  Callers provide
small data objects and resolvers at the seam, so Sales and Recipes can use the
same UOM, yield, efficiency, and nested-recipe rules.

The two quantities in a resolved result are deliberately separate:

* ``usage`` is the quantity the recipe or sale asks to use;
* ``purchase`` is the gross quantity in the source's purchase unit.

The helper never rounds, prices, mutates inventory, or applies
``efficiency_after_cooking``.  That field is a nutrition retention rule, not a
purchase-demand rule.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Iterable

from ...units import SIZED_UNITS, counted_as_each, convert_amount, unit_family, unit_ratio


@dataclass(frozen=True)
class Measure:
    amount: float
    unit: str


@dataclass(frozen=True)
class EquivalencyBasis:
    """Whole-batch measures supplied by a recipe equivalency."""

    mass: Measure | None = None
    volume: Measure | None = None
    count: Measure | None = None
    standard: bool = False

    def stated(self) -> tuple[Measure, ...]:
        return tuple(
            measure
            for measure in (self.mass, self.volume, self.count)
            if measure is not None
            and math.isfinite(float(measure.amount))
            and float(measure.amount) > 0
            and bool(measure.unit)
        )


@dataclass(frozen=True)
class PreparationBasis:
    """The conversion and yield belonging to one named preparation."""

    yield_percent: float | None = None
    conversion: tuple[Measure, ...] = ()
    conversion_is_automatic: bool = True


@dataclass(frozen=True)
class PurchaseBasis:
    """The purchase-side facts for one ingredient or material."""

    purchase_size: float | None
    purchase_unit: str | None
    yield_percent: float | None = None
    conversion: tuple[Measure, ...] = ()
    conversion_is_automatic: bool = True


@dataclass(frozen=True)
class Quantity:
    amount: float
    unit: str


@dataclass(frozen=True)
class ExpansionIssue:
    """A non-fatal reason a physical value could not be resolved."""

    code: str
    path: tuple[str, ...] = ()
    detail: str | None = None

    def at(self, *parts: str) -> "ExpansionIssue":
        return ExpansionIssue(self.code, (*parts, *self.path), self.detail)


def issue_json(issue: ExpansionIssue, *, prefix: Iterable[str] = ()) -> dict:
    """The wire shape every reader of an unresolved physical value shares."""
    return {
        "code": issue.code,
        "path": [*prefix, *issue.path],
        "detail": issue.detail,
    }


@dataclass(frozen=True)
class PurchaseExpansion:
    """Usage and purchase quantities for one line."""

    usage: Quantity | None
    purchase: Quantity | None
    # Fractional source packs, retained for costing callers. ``purchase`` is
    # still the physical amount in ``purchase_unit`` and is not a pack count.
    purchase_units: float | None
    issues: tuple[ExpansionIssue, ...] = ()

    @property
    def resolved(self) -> bool:
        return self.purchase is not None and not self.issues


@dataclass(frozen=True)
class RecipeBatch:
    """The batch bases a nested recipe exposes to its parent."""

    pairs: tuple[Measure, ...]
    grams: float | None
    pieces: Measure | None
    volume: Measure | None
    issues: tuple[ExpansionIssue, ...] = ()


@dataclass(frozen=True)
class BatchShare:
    """A nested-line share of a child batch."""

    usage: Quantity | None
    factor: float | None
    grams: float | None
    issues: tuple[ExpansionIssue, ...] = ()


@dataclass(frozen=True)
class RecipeLine:
    """A model-free recipe line resolved by ``expand_recipe`` callbacks."""

    id: str
    quantity: float | None
    unit: str | None
    ingredient_key: str | None = None
    recipe_key: str | None = None
    # Gross-input efficiency.  Cooking retention is intentionally absent.
    efficiency: float | None = 100.0
    excluded_from_cost: bool = False
    preparation: PreparationBasis | None = None


@dataclass(frozen=True)
class RecipeNode:
    id: str
    yield_amount: float | None
    yield_unit: str | None
    equivalency: EquivalencyBasis | None = None
    lines: tuple[RecipeLine, ...] = ()


@dataclass(frozen=True)
class MaterialExpansion:
    key: str
    path: tuple[str, ...]
    usage: Quantity | None
    purchase: Quantity | None
    cost_included: bool
    issues: tuple[ExpansionIssue, ...] = ()


@dataclass(frozen=True)
class RecipeExpansion:
    recipe_id: str
    batch: RecipeBatch
    materials: tuple[MaterialExpansion, ...]
    issues: tuple[ExpansionIssue, ...] = ()


def _measure(value: Measure | tuple[float, str]) -> Measure:
    if isinstance(value, Measure):
        return value
    amount, unit = value
    return Measure(float(amount), unit)


def _measures(values: Iterable[Measure | tuple[float, str]]) -> tuple[Measure, ...]:
    return tuple(_measure(value) for value in values)


def recipe_measure_pairs(
    yield_amount: float | None,
    yield_unit: str | None,
    equivalency: EquivalencyBasis | None = None,
) -> tuple[tuple[float, str], ...]:
    """Return one finished batch in every reachable unit family.

    A custom equivalency describes whole-batch quantities directly.  A
    standard equivalency is a reusable ratio, so non-yield-family sides are
    scaled from the declared total yield before they are used.
    """

    basis = (
        float(yield_amount)
        if yield_amount is not None and math.isfinite(float(yield_amount))
        else None
    )
    pairs: list[Measure] = []
    if basis is not None and basis > 0 and yield_unit:
        pairs.append(Measure(basis, yield_unit))
    if equivalency is None:
        return tuple((item.amount, item.unit) for item in pairs)
    stated = equivalency.stated()
    if not equivalency.standard:
        pairs.extend(stated)
        return tuple((item.amount, item.unit) for item in pairs)
    if basis is None or basis <= 0 or not yield_unit:
        return tuple((item.amount, item.unit) for item in pairs)
    yield_family = unit_family(yield_unit)
    anchor = next(
        (item for item in stated if unit_family(item.unit) == yield_family), None
    )
    if anchor is None:
        return tuple((item.amount, item.unit) for item in pairs)
    yield_in_anchor = convert_amount(
        basis,
        counted_as_each(yield_unit),
        counted_as_each(anchor.unit),
    )
    if yield_in_anchor is None or yield_in_anchor <= 0:
        return tuple((item.amount, item.unit) for item in pairs)
    scale = yield_in_anchor / anchor.amount
    pairs.extend(
        Measure(item.amount * scale, item.unit)
        for item in stated
        if unit_family(item.unit) != yield_family
    )
    return tuple((item.amount, item.unit) for item in pairs)


def recipe_batch_basis(
    yield_amount: float | None,
    yield_unit: str | None,
    equivalency: EquivalencyBasis | None = None,
) -> RecipeBatch:
    """Resolve mass, count, and volume bases for a recipe batch."""

    pairs = _measures(recipe_measure_pairs(yield_amount, yield_unit, equivalency))
    grams: float | None = None
    pieces: Measure | None = None
    volume: Measure | None = None
    issues: list[ExpansionIssue] = []
    for item in pairs:
        family = unit_family(item.unit)
        if family == "mass" and grams is None:
            converted = convert_amount(item.amount, item.unit, "g")
            if converted is None or not math.isfinite(converted) or converted <= 0:
                issues.append(ExpansionIssue("unresolved-yield-unit", detail=item.unit))
            else:
                grams = converted
        elif family == "volume" and volume is None:
            volume = item
        elif family == "count" and pieces is None:
            pieces = item
    if not pairs:
        issues.append(ExpansionIssue("missing-yield"))
    elif grams is None and pieces is None and volume is None:
        issues.append(ExpansionIssue("unresolved-yield"))
    return RecipeBatch(tuple(pairs), grams, pieces, volume, tuple(issues))


def share_of_batch(
    amount: float | None,
    unit: str | None,
    batch: RecipeBatch,
) -> BatchShare:
    """Resolve a nested line to a fraction of its child batch."""

    usage = (
        Quantity(float(amount), unit)
        if amount is not None
        and unit
        and math.isfinite(float(amount))
        and float(amount) > 0
        else None
    )
    if usage is None:
        return BatchShare(
            None,
            None,
            None,
            (ExpansionIssue("missing-quantity"),),
        )
    family = unit_family(unit)
    if family == "mass":
        grams = convert_amount(usage.amount, unit, "g")
        if grams is None:
            return BatchShare(
                usage,
                None,
                None,
                (ExpansionIssue("unresolved-conversion", detail=unit),),
            )
        if batch.grams is None or batch.grams <= 0:
            return BatchShare(
                usage,
                None,
                grams,
                (ExpansionIssue("unresolved-yield", detail="mass"),),
            )
        return BatchShare(usage, grams / batch.grams, grams)
    if family == "count" and batch.pieces is not None:
        ratio = unit_ratio(counted_as_each(unit), counted_as_each(batch.pieces.unit))
        if ratio is not None and batch.pieces.amount > 0:
            return BatchShare(
                usage,
                usage.amount * ratio / batch.pieces.amount,
                None,
            )
    if family == "volume" and batch.volume is not None:
        ratio = unit_ratio(unit, batch.volume.unit)
        if ratio is not None and batch.volume.amount > 0:
            return BatchShare(
                usage,
                usage.amount * ratio / batch.volume.amount,
                None,
            )
    return BatchShare(
        usage,
        None,
        None,
        (ExpansionIssue("unresolved-conversion", detail=unit),),
    )


def purchase_quantity(
    amount: float | None,
    unit: str | None,
    source: PurchaseBasis,
    preparation: PreparationBasis | None = None,
    *,
    standard_bridge: Callable[[str, str], float | None] | None = None,
) -> PurchaseExpansion:
    """Resolve recipe usage into gross quantity in the purchase UOM.

    ``purchase_units`` is the fractional number of source purchase packs used
    and is retained for existing cost callers.  ``purchase`` is the same
    amount expressed in the source's purchase unit, so callers that need
    physical material do not confuse pack fractions with grams, litres, or
    pieces.
    """

    usage = (
        Quantity(float(amount), unit)
        if amount is not None
        and unit
        and math.isfinite(float(amount))
        and float(amount) > 0
        else None
    )
    if usage is None:
        return PurchaseExpansion(None, None, None, (ExpansionIssue("missing-quantity"),))
    purchase_size = source.purchase_size
    if (
        purchase_size is None
        or not math.isfinite(float(purchase_size))
        or float(purchase_size) <= 0
    ):
        return PurchaseExpansion(
            usage,
            None,
            None,
            (ExpansionIssue("missing-purchase-size"),),
        )
    if not source.purchase_unit:
        return PurchaseExpansion(
            usage,
            None,
            None,
            (ExpansionIssue("missing-purchase-unit"),),
        )
    percent = preparation.yield_percent if preparation is not None else source.yield_percent
    scale = 1.0
    if percent is not None:
        if not math.isfinite(float(percent)) or float(percent) <= 0:
            return PurchaseExpansion(
                usage,
                None,
                None,
                (ExpansionIssue("invalid-yield"),),
            )
        scale = 100.0 / float(percent)
    source_unit = counted_as_each(unit)
    purchase_unit = counted_as_each(source.purchase_unit)
    direct = unit_ratio(source_unit, purchase_unit)
    fraction: float | None = None
    if direct is not None:
        fraction = usage.amount * direct / float(purchase_size) * scale
    else:
        custom_preparation = (
            preparation is not None and not preparation.conversion_is_automatic
        )
        pairs = (
            preparation.conversion
            if custom_preparation
            else source.conversion
        )
        pairs = _measures(pairs)
        if not pairs:
            if custom_preparation or not source.conversion_is_automatic:
                return PurchaseExpansion(
                    usage,
                    None,
                    None,
                    (ExpansionIssue("unresolved-conversion"),),
                )
            bridge = (
                standard_bridge(source_unit, purchase_unit)
                if standard_bridge is not None
                else None
            )
            if bridge is None or not math.isfinite(float(bridge)) or bridge <= 0:
                return PurchaseExpansion(
                    usage,
                    None,
                    None,
                    (ExpansionIssue("unresolved-conversion"),),
                )
            fraction = usage.amount * bridge / float(purchase_size) * scale
        else:
            shares: float | None = None
            for pair in pairs:
                ratio = unit_ratio(source_unit, counted_as_each(pair.unit))
                if ratio is None or pair.amount <= 0:
                    continue
                shares = usage.amount * ratio / pair.amount
                break
            if shares is None:
                return PurchaseExpansion(
                    usage,
                    None,
                    None,
                    (ExpansionIssue("unresolved-conversion"),),
                )
            for pair in pairs:
                to_purchase = unit_ratio(counted_as_each(pair.unit), purchase_unit)
                if to_purchase is None or pair.amount <= 0:
                    continue
                fraction = (
                    shares * pair.amount * to_purchase / float(purchase_size) * scale
                )
                break
            if fraction is None:
                # A single stated measure can serve as the purchase-side
                # equivalency; a universal-sized pack cannot be guessed from
                # an unrelated family when two measures already relate one
                # another.
                if not custom_preparation and (
                    len(pairs) == 1 or purchase_unit not in SIZED_UNITS
                ):
                    fraction = shares * scale
                else:
                    return PurchaseExpansion(
                        usage,
                        None,
                        None,
                        (ExpansionIssue("unresolved-purchase-unit"),),
                    )
    if fraction is None or not math.isfinite(fraction) or fraction < 0:
        return PurchaseExpansion(
            usage,
            None,
            None,
            (ExpansionIssue("non-finite-result"),),
        )
    purchase_amount = fraction * float(purchase_size)
    if not math.isfinite(purchase_amount):
        return PurchaseExpansion(
            usage,
            None,
            None,
            (ExpansionIssue("non-finite-result"),),
        )
    return PurchaseExpansion(
        usage,
        Quantity(purchase_amount, source.purchase_unit),
        fraction,
    )


def _scale_quantity(value: Quantity | None, factor: float) -> Quantity | None:
    if value is None:
        return None
    amount = value.amount * factor
    return None if not math.isfinite(amount) else Quantity(amount, value.unit)


def _nested_path(
    path: tuple[str, ...], inherited_path: tuple[str, ...], line_path: tuple[str, ...]
) -> tuple[str, ...]:
    """Rebase a child path through its containing recipe line once."""
    if path[: len(inherited_path)] == inherited_path:
        return (*line_path, *path[len(inherited_path) :])
    return (*line_path, *path)


def expand_physical_demand(
    root: RecipeNode,
    *,
    resolve_ingredient: Callable[[str], PurchaseBasis | None],
    resolve_recipe: Callable[[str], RecipeNode | None],
    standard_bridge: Callable[[str, str, PurchaseBasis], float | None] | None = None,
) -> RecipeExpansion:
    """Expand a recipe into physical ingredient demand.

    The public name describes the seam consumed by forecast and recipe health;
    keeping the traversal model-free lets callers adapt their own ORM rows.
    """
    return expand_recipe(
        root,
        resolve_ingredient=resolve_ingredient,
        resolve_recipe=resolve_recipe,
        standard_bridge=standard_bridge,
    )


def expand_recipe(
    recipe: RecipeNode,
    *,
    resolve_ingredient: Callable[[str], PurchaseBasis | None],
    resolve_recipe: Callable[[str], RecipeNode | None],
    standard_bridge: Callable[[str, str, PurchaseBasis], float | None] | None = None,
    path: tuple[str, ...] = (),
) -> RecipeExpansion:
    """Recursively flatten one recipe into physical material expansions.

    The callbacks are the only identity/ownership seam. A caller may use
    Django rows, a forecast read model, or an in-memory adapter without this
    module importing either domain. Excluded cost lines still produce material
    usage and purchase quantities; ``cost_included`` only tells a pricing
    caller whether to include their money.
    """

    if recipe.id in path:
        issue = ExpansionIssue("recipe-cycle", (*path, recipe.id))
        batch = recipe_batch_basis(
            recipe.yield_amount, recipe.yield_unit, recipe.equivalency
        )
        return RecipeExpansion(recipe.id, batch, (), (issue,))
    batch = recipe_batch_basis(recipe.yield_amount, recipe.yield_unit, recipe.equivalency)
    issues: list[ExpansionIssue] = list(batch.issues)
    materials: list[MaterialExpansion] = []
    next_path = (*path, recipe.id)
    for line in recipe.lines:
        line_path = (*next_path, line.id)
        usage = (
            Quantity(float(line.quantity), line.unit)
            if line.quantity is not None
            and line.unit
            and math.isfinite(float(line.quantity))
            and float(line.quantity) > 0
            else None
        )
        if usage is None:
            issue = ExpansionIssue("missing-quantity", line_path)
            issues.append(issue)
            materials.append(
                MaterialExpansion(
                    line.ingredient_key or line.recipe_key or line.id,
                    line_path,
                    None,
                    None,
                    not line.excluded_from_cost,
                    (issue,),
                )
            )
            continue
        efficiency = 100.0 if line.efficiency is None else float(line.efficiency)
        if not math.isfinite(efficiency) or efficiency <= 0:
            issue = ExpansionIssue("invalid-efficiency", line_path)
            issues.append(issue)
            materials.append(
                MaterialExpansion(
                    line.ingredient_key or line.recipe_key or line.id,
                    line_path,
                    usage,
                    None,
                    not line.excluded_from_cost,
                    (issue,),
                )
            )
            continue
        gross_amount = usage.amount * 100.0 / efficiency
        if line.ingredient_key is not None:
            source = resolve_ingredient(line.ingredient_key)
            if source is None:
                issue = ExpansionIssue("unresolved-ingredient", line_path)
                issues.append(issue)
                materials.append(
                    MaterialExpansion(
                        line.ingredient_key,
                        line_path,
                        usage,
                        None,
                        not line.excluded_from_cost,
                        (issue,),
                    )
                )
                continue
            bridge = (
                None
                if standard_bridge is None
                else lambda source_unit, purchase_unit, source=source: standard_bridge(
                    source_unit, purchase_unit, source
                )
            )
            purchase = purchase_quantity(
                gross_amount,
                usage.unit,
                source,
                line.preparation,
                standard_bridge=bridge,
            )
            line_issues = tuple(
                ExpansionIssue(issue.code, line_path + issue.path, issue.detail)
                for issue in purchase.issues
            )
            issues.extend(line_issues)
            materials.append(
                MaterialExpansion(
                    line.ingredient_key,
                    line_path,
                    usage,
                    purchase.purchase,
                    not line.excluded_from_cost,
                    line_issues,
                )
            )
            continue
        if line.recipe_key is not None:
            child = resolve_recipe(line.recipe_key)
            if child is None:
                issue = ExpansionIssue("unresolved-recipe", line_path)
                issues.append(issue)
                materials.append(
                    MaterialExpansion(
                        line.recipe_key,
                        line_path,
                        usage,
                        None,
                        not line.excluded_from_cost,
                        (issue,),
                    )
                )
                continue
            child_expansion = expand_recipe(
                child,
                resolve_ingredient=resolve_ingredient,
                resolve_recipe=resolve_recipe,
                standard_bridge=standard_bridge,
                path=next_path,
            )
            child_issues = tuple(
                ExpansionIssue(
                    issue.code,
                    _nested_path(issue.path, next_path, line_path),
                    issue.detail,
                )
                for issue in child_expansion.issues
            )
            issues.extend(child_issues)
            share = share_of_batch(gross_amount, usage.unit, child_expansion.batch)
            share_issues = tuple(
                ExpansionIssue(issue.code, line_path + issue.path, issue.detail)
                for issue in share.issues
            )
            issues.extend(share_issues)
            if share.factor is None:
                line_issues = (*child_issues, *share_issues)
                materials.append(
                    MaterialExpansion(
                        line.recipe_key,
                        line_path,
                        usage,
                        None,
                        not line.excluded_from_cost,
                        line_issues,
                    )
                )
                continue
            for material in child_expansion.materials:
                material_issues = tuple(
                    ExpansionIssue(
                        issue.code,
                        _nested_path(issue.path, next_path, line_path),
                        issue.detail,
                    )
                    for issue in material.issues
                )
                materials.append(
                    MaterialExpansion(
                        material.key,
                        _nested_path(material.path, next_path, line_path),
                        _scale_quantity(material.usage, share.factor),
                        _scale_quantity(material.purchase, share.factor),
                        (not line.excluded_from_cost) and material.cost_included,
                        material_issues,
                    )
                )
            continue
        issue = ExpansionIssue("unresolved-line", line_path)
        issues.append(issue)
        materials.append(
            MaterialExpansion(
                line.id,
                line_path,
                usage,
                None,
                not line.excluded_from_cost,
                (issue,),
            )
        )
    return RecipeExpansion(recipe.id, batch, tuple(materials), tuple(issues))
