"""Read-time menu-scoped demand forecasts.

The sales ledger remains the source of physical consumption.  This module
selects a saved menu's products, derives a recency-weighted weekday baseline
with a busy level beside it, prices both at current menu prices, and expands
the chosen plan through current composition.  It deliberately persists
nothing: forecasts are planning projections, not sales, imports, inventory
movements, or purchase orders.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone as datetime_timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from django.db.models import Prefetch
from django.utils import timezone

from ...models import (
    Ingredient,
    Menu,
    SalesLine,
    SalesLineModifier,
    SalesProduct,
    SalesProductComponent,
    User,
)
from ..shared.physical_expansion import (
    issue_json as _issue_json,
    purchase_quantity,
)
from ..shared.workspace_currency import workspace_currency_code
from ..shared.workspace_timezone import workspace_zone
from .bundles import BundleIndex
from .consumption import daily_product_consumption_rows
from .core import (
    _ingredient_purchase_basis,
    _product_recipe_nodes,
    _standard_density_bridge,
    interpret_line,
)


JsonObject = dict[str, Any]
_QUANTITY_PLACES = Decimal("0.001")
_WHOLE_CENTS = Decimal(1)
HISTORY_WEEKS = 8
WEEKLY_DECAY = Decimal("0.8")
BUSY_Z = Decimal("1.28")
SERIES_HISTORY_DAYS = 28
BACKTEST_WEEKS = 4
# The oldest backtest week has to read its own history out of the same single
# ledger read, so the window is both spans end to end.
LEDGER_WEEKS = HISTORY_WEEKS + BACKTEST_WEEKS
_NO_SEASONAL = Decimal(1)
# Last year's same weekday: 52 whole weeks back, not a calendar year.
SEASONAL_LAG_DAYS = 364
SEASONAL_DAMPING = Decimal(2)
SEASONAL_FLOOR = Decimal("0.5")
SEASONAL_CEILING = Decimal(2)
# The whole ledger window again, shifted back a year: the oldest backtest week
# compares against its own history-aligned days, not today's.
SEASONAL_LOOKBACK_DAYS = 7 * (HISTORY_WEEKS + BACKTEST_WEEKS) + SEASONAL_LAG_DAYS


def _round_quantity(value: Decimal) -> Decimal:
    return value.quantize(_QUANTITY_PLACES, rounding=ROUND_HALF_UP)


def _json_quantity(value: Decimal | float | int) -> float:
    return float(_round_quantity(Decimal(str(value))))


def _workspace_window(start: date, end: date, zone) -> tuple[datetime, datetime]:
    """Turn inclusive workspace dates into the ledger's UTC half-open window."""
    return (
        datetime.combine(start, time.min, tzinfo=zone).astimezone(datetime_timezone.utc),
        datetime.combine(
            end + date.resolution, time.min, tzinfo=zone
        ).astimezone(datetime_timezone.utc),
    )


def _history_dates(
    target: date, history_end: date, weeks: int = HISTORY_WEEKS
) -> tuple[date, ...]:
    """The most recent matching weekdays inside the history window.

    Anchoring on ``history_end`` rather than counting back from ``target``
    keeps a horizon day in week four reading the same sold weekdays as one in
    week one, instead of averaging in the horizon's own empty days.
    """
    latest = history_end - timedelta(days=(history_end - target).days % 7)
    return tuple(latest - timedelta(days=7 * offset) for offset in range(weeks))


def _window_total(
    daily: Mapping[date, Decimal], start: date, end: date
) -> Decimal:
    return sum(
        (units for day, units in daily.items() if start <= day <= end), Decimal()
    )


def _seasonal_factor(
    daily: Mapping[date, Decimal],
    *,
    exists_from: date | None,
    history_end: date,
    horizon_start: date,
    horizon_days: int,
    weeks: int = HISTORY_WEEKS,
) -> Decimal:
    """How much busier last year's horizon ran than last year's history.

    Both windows shift back 364 days rather than a calendar year because 364 is
    52 whole weeks: a Monday stays a Monday, so the ratio compares like
    weekdays instead of sliding a weekend into a weekday's place.

    A product that launched inside last year's history window has a mostly
    empty denominator, and its launch ramp would read as seasonality: the whole
    window has to predate the product or there is no comparison to make.

    The ratio is damped to half its deviation from 1 and clamped to
    [0.5, 2]: one good week last year is a hint about this year, not a rule,
    and a single anniversary rush must not double the kitchen's order.  With no
    sales in either window there is no evidence, so the factor is exactly 1.
    """
    lag = timedelta(days=SEASONAL_LAG_DAYS)
    horizon_first = horizon_start - lag
    horizon_last = horizon_first + timedelta(days=horizon_days - 1)
    history_last = history_end - lag
    history_days = 7 * weeks
    history_first = history_last - timedelta(days=history_days - 1)
    if exists_from is not None and exists_from > history_first:
        return _NO_SEASONAL
    horizon_total = _window_total(daily, horizon_first, horizon_last)
    history_total = _window_total(daily, history_first, history_last)
    if horizon_total <= 0 or history_total <= 0:
        return _NO_SEASONAL
    factor = (horizon_total / horizon_days) / (history_total / history_days)
    damped = _NO_SEASONAL + (factor - _NO_SEASONAL) / SEASONAL_DAMPING
    return min(max(damped, SEASONAL_FLOOR), SEASONAL_CEILING)


@dataclass(frozen=True)
class DayProjection:
    typical: Decimal
    variance: Decimal


@dataclass(frozen=True)
class ProductProjection:
    days: dict[date, DayProjection]
    typical_total: Decimal
    busy_total: Decimal
    weeks_observed: int
    seasonal_factor: Decimal


def _clamped(value: Decimal) -> Decimal:
    """A negative average is a return, not demand."""
    return Decimal() if value < 0 else _round_quantity(value)


def _weighted_moments(samples: Sequence[Decimal]) -> tuple[Decimal, Decimal]:
    """Recency-weighted mean and variance of samples given newest first.

    One sample has no spread to measure, so its variance is zero rather than
    an undefined width the busy level would then invent.
    """
    if not samples:
        return Decimal(), Decimal()
    weights = [WEEKLY_DECAY**index for index in range(len(samples))]
    total = sum(weights, Decimal())
    mean = sum(
        (weight * sample for weight, sample in zip(weights, samples)), Decimal()
    ) / total
    if len(samples) < 2:
        return mean, Decimal()
    variance = sum(
        (weight * (sample - mean) ** 2 for weight, sample in zip(weights, samples)),
        Decimal(),
    ) / total
    return mean, variance


def project_product(
    daily: Mapping[date, Decimal],
    *,
    exists_from: date | None,
    history_end: date,
    horizon_start: date,
    horizon_days: int,
    weeks: int = HISTORY_WEEKS,
    last_year: Mapping[date, Decimal] | None = None,
) -> ProductProjection:
    """Project one product's horizon from its own matching weekdays.

    Pure and DB-free so the backtest replays it at four past dates against the
    same in-memory history the live forecast read.  Samples from before the
    product existed are dropped rather than counted as zeroes, so a product
    first sold last week gets one honest sample instead of seven empties.
    Rounding and clamping happen here, never inside the moments.

    The seasonal factor is derived here rather than handed in, so the live
    forecast and the backtest that scores it cannot scale by different rules.
    """
    seasonal_factor = (
        _NO_SEASONAL
        if last_year is None
        else _seasonal_factor(
            last_year,
            exists_from=exists_from,
            history_end=history_end,
            horizon_start=horizon_start,
            horizon_days=horizon_days,
            weeks=weeks,
        )
    )
    days: dict[date, DayProjection] = {}
    typical_total = Decimal()
    variance_total = Decimal()
    for offset in range(horizon_days):
        day = horizon_start + timedelta(days=offset)
        samples = [
            daily.get(sample_day, Decimal())
            for sample_day in _history_dates(day, history_end, weeks)
            if exists_from is None or sample_day >= exists_from
        ]
        mean, variance = _weighted_moments(samples)
        mean *= seasonal_factor
        variance *= seasonal_factor * seasonal_factor
        if mean < 0:
            # A return is not demand, and neither is its spread: a day that
            # clamps to zero must not be widened by a busy plan.
            variance = Decimal()
        days[day] = DayProjection(typical=_clamped(mean), variance=variance)
        typical_total += days[day].typical
        variance_total += variance
    history_start = history_end - timedelta(days=7 * weeks - 1)
    return ProductProjection(
        days=days,
        typical_total=typical_total,
        # Variance is pooled over the whole horizon before the busy margin is
        # taken: summing thirty daily P90s buys for thirty rushes that never
        # all land on the same week.
        busy_total=_clamped(typical_total + BUSY_Z * variance_total.sqrt()),
        weeks_observed=len(
            {
                (history_end - day).days // 7
                for day in daily
                if history_start <= day <= history_end
            }
        ),
        seasonal_factor=seasonal_factor,
    )


def _money(units: Decimal, price_cents: int) -> int:
    return int((units * price_cents).quantize(_WHOLE_CENTS, rounding=ROUND_HALF_UP))


def _priced(
    projections: Mapping[str, ProductProjection],
    prices: Mapping[str, int],
    days: Sequence[date] | None = None,
) -> tuple[int, int]:
    """Typical and busy cents for the priced products over ``days``.

    Defaults to the whole horizon.  Busy pools variance across every product
    and day at price squared, so the menu's busy is one level history stayed
    under nine weeks in ten, not every product's own rush landing at once.
    Money is rounded a day at a time so the horizon rows sum to the total.
    """
    typical = 0
    variance = Decimal()
    for product_id, price in prices.items():
        projection = projections[product_id]
        selected = (
            projection.days.values()
            if days is None
            else [projection.days[day] for day in days]
        )
        for entry in selected:
            typical += _money(entry.typical, price)
            variance += Decimal(price) ** 2 * entry.variance
    return typical, typical + _money(BUSY_Z * variance.sqrt(), 1)


def _menu_scope(
    menu: Menu,
) -> tuple[dict[str, SalesProduct], list[JsonObject], int, int, dict[str, int]]:
    """Return saved product links, and what the menu charges for each.

    A recipe row has no sales to forecast from and is neither counted as
    linked nor reported; only a row with no link at all is unresolved.
    """
    products: dict[str, SalesProduct] = {}
    prices: dict[str, int] = {}
    unresolved: list[JsonObject] = []
    items = list(
        menu.items.select_related("product").order_by("position", "created_at")
    )
    linked_count = 0
    for item in items:
        if item.recipe_id is not None:
            continue
        if item.product_id is None:
            unresolved.append(
                {
                    "code": "unlinked-menu-item",
                    "path": [str(item.id)],
                    "menuItemId": str(item.id),
                    "menuItemName": item.name,
                }
            )
            continue
        linked_count += 1
        products[str(item.product_id)] = item.product
        if item.sell_price_cents > 0:
            prices.setdefault(str(item.product_id), item.sell_price_cents)
    return products, unresolved, len(items), linked_count, prices


def _eligible_modifier_rows(
    user: User,
    *,
    start: date,
    end: date,
    scoped_product_ids: set[str],
    index: BundleIndex,
) -> list[dict[str, Any]]:
    """Return modifier quantities only for sales whose base reaches the menu.

    Daily consumption intentionally aggregates away source-line identity.  The
    modifier scope rule is the one forecast concern that needs that identity:
    a modifier belongs to a menu only alongside a base contribution from the
    same sale.  Base quantities still come solely from the daily rollup.
    """
    if not scoped_product_ids:
        return []
    zone = workspace_zone(user)
    start_at, end_at = _workspace_window(start, end, zone)
    modifiers = SalesLineModifier.objects.filter(
        user=user, variant__user=user
    ).select_related("variant", "variant__product")
    lines = (
        SalesLine.objects.filter(
            user=user,
            sales_import__undone_at__isnull=True,
            variant__isnull=False,
            variant__user=user,
            sold_at__gte=start_at,
            sold_at__lt=end_at,
        )
        .select_related("variant", "variant__product")
        .prefetch_related(Prefetch("modifiers", queryset=modifiers))
        .order_by("sold_at", "id")
    )
    rows: list[dict[str, Any]] = []
    for line in lines:
        contributions = interpret_line(line, index=index)
        if not any(
            contribution.source == "base"
            and str(contribution.product.id) in scoped_product_ids
            for contribution in contributions
        ):
            continue
        sold_on = line.sold_at.astimezone(zone).date().isoformat()
        for contribution in contributions:
            if contribution.source != "modifier":
                continue
            rows.append(
                {
                    "productId": str(contribution.product.id),
                    "soldOn": sold_on,
                    "quantity": contribution.quantity,
                }
            )
    return rows


def _forecast_history(
    user: User,
    *,
    start: date,
    end: date,
    scoped_product_ids: set[str],
    index: BundleIndex,
    modifiers: bool = True,
) -> tuple[dict[str, dict[date, Decimal]], dict[str, date]]:
    """Return daily product demand over the ledger window, and first sightings.

    The canonical daily rollup supplies all base consumption.  Modifier rows
    are rebuilt at line granularity only to apply the same-sale menu condition;
    they include modifier products not explicitly saved on the menu.  The
    window is read once and every later slice — history, series, backtest —
    reads it from memory.

    ``modifiers=False`` skips that line walk for a caller that only needs a
    ratio of window means — last year's seasonal comparison — where a modifier
    moves numerator and denominator alike and cannot be worth a second query.
    """
    quantities: defaultdict[str, defaultdict[date, Decimal]] = defaultdict(
        lambda: defaultdict(Decimal)
    )

    base_rows = daily_product_consumption_rows(
        user, start, end, product_ids=scoped_product_ids
    )
    for row in base_rows:
        # A member reached inside a box is consumed exactly as one sold on its
        # own; only mapped modifiers are rebuilt separately below.
        if row["source"] not in {"base", "bundle"}:
            continue
        product_id = row["productId"]
        sold_on = date.fromisoformat(row["soldOn"])
        quantities[product_id][sold_on] += Decimal(row["quantity"])

    for row in (
        _eligible_modifier_rows(
            user,
            start=start,
            end=end,
            scoped_product_ids=scoped_product_ids,
            index=index,
        )
        if modifiers
        else []
    ):
        product_id = row["productId"]
        sold_on = date.fromisoformat(row["soldOn"])
        quantities[product_id][sold_on] += Decimal(row["quantity"])
    daily = {product_id: dict(days) for product_id, days in quantities.items()}
    return daily, {
        product_id: min(days) for product_id, days in daily.items()
    }


def _add_material(
    materials: dict[tuple[str, str], Decimal],
    *,
    ingredient: Ingredient,
    usage_amount: Decimal | None,
    usage_unit: str | None,
    purchase_amount: Decimal | None,
    purchase_unit: str | None,
) -> None:
    if usage_amount is not None and usage_unit:
        materials[(str(ingredient.id), f"usage:{usage_unit}")] += usage_amount
    if purchase_amount is not None and purchase_unit:
        materials[(str(ingredient.id), f"purchase:{purchase_unit}")] += purchase_amount


def _product_material_demand(
    user: User,
    forecasts: dict[str, Decimal],
) -> tuple[list[JsonObject], list[JsonObject], list[JsonObject]]:
    """Expand final product quantities through current product composition."""
    if not any(forecasts.values()):
        return [], [], []
    product_ids = [product_id for product_id, quantity in forecasts.items() if quantity]
    components = list(
        SalesProductComponent.objects.filter(product__user=user, product_id__in=product_ids)
        .select_related("product", "recipe", "ingredient")
        .prefetch_related("ingredient__conversion")
        .order_by("product_id", "position", "created_at")
    )
    roots = [component.recipe for component in components if component.recipe_id]
    direct = [component.ingredient for component in components if component.ingredient_id]
    nodes, ingredients = _product_recipe_nodes(
        user, roots, [ingredient for ingredient in direct if ingredient is not None]
    )
    recipe_models = {str(recipe.id): recipe for recipe in roots if recipe is not None}
    recipes: defaultdict[str, Decimal] = defaultdict(Decimal)
    material_amounts: defaultdict[tuple[str, str], Decimal] = defaultdict(Decimal)
    unresolved: list[JsonObject] = []

    for component in components:
        # A product component is another product, and the interpreter already
        # counted the units it pulled through. Expanding it here as well would
        # make the kitchen every member twice.
        if component.component_product_id:
            continue
        product_quantity = forecasts.get(str(component.product_id), Decimal())
        if not product_quantity:
            continue
        component_quantity = product_quantity * Decimal(component.quantity)
        prefix = (str(component.product_id), str(component.id))
        if component.recipe_id:
            recipe_key = str(component.recipe_id)
            recipes[recipe_key] += component_quantity
            root = nodes.get(recipe_key)
            if root is None:
                unresolved.append(
                    {
                        "code": "unresolved-recipe",
                        "path": list(prefix),
                        "recipeId": recipe_key,
                    }
                )
                continue

            sources: dict[int, Ingredient] = {}

            def resolve_ingredient(
                key: str,
                sources=sources,
                ingredients=ingredients,
            ):
                ingredient = ingredients.get(key)
                if ingredient is None:
                    return None
                basis = _ingredient_purchase_basis(ingredient)
                sources[id(basis)] = ingredient
                return basis

            def bridge(
                source_unit: str,
                target_unit: str,
                source,
                sources=sources,
            ):
                ingredient = sources.get(id(source))
                return (
                    _standard_density_bridge(source_unit, target_unit, ingredient)
                    if ingredient is not None
                    else None
                )

            from ..shared.physical_expansion import expand_physical_demand

            expansion = expand_physical_demand(
                root,
                resolve_ingredient=resolve_ingredient,
                resolve_recipe=nodes.get,
                standard_bridge=bridge,
            )
            material_issue_keys = {
                (issue.code, issue.path, issue.detail)
                for material in expansion.materials
                for issue in material.issues
            }
            unresolved.extend(
                _issue_json(issue, prefix=prefix)
                for issue in expansion.issues
                if (issue.code, issue.path, issue.detail) not in material_issue_keys
            )
            for material in expansion.materials:
                ingredient = ingredients.get(material.key)
                if ingredient is None:
                    if not material.issues:
                        unresolved.append(
                            {
                                "code": "unresolved-ingredient",
                                "path": [*prefix, *material.path],
                                "ingredientId": material.key,
                            }
                        )
                    continue
                unresolved.extend(
                    _issue_json(issue, prefix=prefix) for issue in material.issues
                )
                _add_material(
                    material_amounts,
                    ingredient=ingredient,
                    usage_amount=(
                        Decimal(str(material.usage.amount)) * component_quantity
                        if material.usage is not None
                        else None
                    ),
                    usage_unit=material.usage.unit if material.usage is not None else None,
                    purchase_amount=(
                        Decimal(str(material.purchase.amount)) * component_quantity
                        if material.purchase is not None
                        else None
                    ),
                    purchase_unit=(
                        material.purchase.unit if material.purchase is not None else None
                    ),
                )
            continue

        if component.ingredient_id:
            ingredient = ingredients.get(str(component.ingredient_id))
            if ingredient is None:
                unresolved.append(
                    {
                        "code": "unresolved-ingredient",
                        "path": list(prefix),
                        "ingredientId": str(component.ingredient_id),
                    }
                )
                continue
            basis = _ingredient_purchase_basis(ingredient)
            purchase = purchase_quantity(
                float(component_quantity),
                component.unit,
                basis,
                standard_bridge=lambda source_unit, target_unit, ingredient=ingredient: _standard_density_bridge(
                    source_unit, target_unit, ingredient
                ),
            )
            unresolved.extend(
                _issue_json(issue, prefix=prefix) for issue in purchase.issues
            )
            _add_material(
                material_amounts,
                ingredient=ingredient,
                usage_amount=component_quantity,
                usage_unit=component.unit,
                purchase_amount=(
                    Decimal(str(purchase.purchase.amount))
                    if purchase.purchase is not None
                    else None
                ),
                purchase_unit=purchase.purchase.unit if purchase.purchase is not None else None,
            )

    recipe_rows = [
        {
            "recipeId": recipe_id,
            "recipePublicId": recipe.public_id,
            "recipeTitle": recipe.title,
            "batches": _json_quantity(quantity),
        }
        for recipe_id, quantity in sorted(recipes.items())
        if (recipe := recipe_models.get(recipe_id)) is not None
    ]
    ingredient_rows: dict[str, JsonObject] = {}
    for (ingredient_id, kind_and_unit), quantity in sorted(material_amounts.items()):
        kind, unit = kind_and_unit.split(":", 1)
        ingredient = ingredients.get(ingredient_id)
        if ingredient is None:
            continue
        row = ingredient_rows.setdefault(
            ingredient_id,
            {
                "ingredientId": ingredient_id,
                "ingredientPublicId": ingredient.public_id,
                "ingredientName": ingredient.name,
                "kind": "supply" if ingredient.non_edible else "ingredient",
                "usage": [],
                "purchase": [],
            },
        )
        row[kind].append({"quantity": _json_quantity(quantity), "unit": unit})
    return recipe_rows, list(ingredient_rows.values()), unresolved


def _menu_revenue(
    projections: Mapping[str, ProductProjection],
    menu_prices: Mapping[str, int],
    *,
    currency_code: str,
    member_count: int,
    plan: str,
) -> JsonObject:
    """Both plans priced at current menu prices.

    Only menu members are priced: a bundle member or modifier reached through
    closure is physical demand whose money already sits in the box or the base.
    """
    typical, busy = _priced(projections, menu_prices)
    return {
        "currencyCode": currency_code,
        "typicalCents": typical,
        "busyCents": busy,
        "plannedCents": busy if plan == "busy" else typical,
        "pricedProducts": len(menu_prices),
        "unpricedProducts": member_count - len(menu_prices),
    }


def _series(
    daily: Mapping[str, Mapping[date, Decimal]],
    projections: Mapping[str, ProductProjection],
    menu_prices: Mapping[str, int],
    *,
    history_end: date,
    horizon_start: date,
    horizon_days: int,
) -> list[JsonObject]:
    """Recent history then the horizon, both in money at today's prices.

    History is actual units times the current price, not net sales, so the two
    halves of the line differ only by quantity.  The last history day carries
    all three values so the projection starts where history ends.
    """
    rows: list[JsonObject] = []
    for offset in range(SERIES_HISTORY_DAYS - 1, -1, -1):
        day = history_end - timedelta(days=offset)
        actual = sum(
            _money(daily.get(product_id, {}).get(day, Decimal()), price)
            for product_id, price in menu_prices.items()
        )
        bridge = offset == 0
        rows.append(
            {
                "date": day.isoformat(),
                "actualCents": actual,
                "typicalCents": actual if bridge else None,
                "busyCents": actual if bridge else None,
            }
        )
    for offset in range(horizon_days):
        day = horizon_start + timedelta(days=offset)
        typical, busy = _priced(projections, menu_prices, [day])
        rows.append(
            {
                "date": day.isoformat(),
                "actualCents": None,
                "typicalCents": typical,
                "busyCents": busy,
            }
        )
    return rows


def _backtest(
    daily: Mapping[str, Mapping[date, Decimal]],
    menu_prices: Mapping[str, int],
    *,
    today: date,
    exists_from: Mapping[str, date],
    last_year: Mapping[str, Mapping[date, Decimal]],
) -> JsonObject:
    """Replay the same projection at four past weeks it could not have seen.

    The projection derives its own seasonal factor from the as_of handed in, so
    the replay scores exactly what the live forecast would have said then.
    The error is volume-weighted, so one quiet week cannot dominate the number
    the screen shows.
    """
    weeks: list[JsonObject] = []
    error = 0
    volume = 0
    scored = 0
    covered = 0
    for back in range(BACKTEST_WEEKS, 0, -1):
        as_of = today - timedelta(days=7 * back)
        actual = 0
        projections: dict[str, ProductProjection] = {}
        for product_id, price in menu_prices.items():
            product_daily = daily.get(product_id, {})
            projections[product_id] = project_product(
                product_daily,
                exists_from=exists_from.get(product_id),
                history_end=as_of - timedelta(days=1),
                horizon_start=as_of,
                horizon_days=7,
                last_year=last_year.get(product_id),
            )
            actual += sum(
                _money(
                    product_daily.get(as_of + timedelta(days=offset), Decimal()), price
                )
                for offset in range(7)
            )
        typical, busy = _priced(projections, menu_prices)
        weeks.append(
            {
                "start": as_of.isoformat(),
                "end": (as_of + timedelta(days=6)).isoformat(),
                "typicalCents": typical,
                "busyCents": busy,
                "actualCents": actual,
            }
        )
        if actual <= 0:
            continue
        scored += 1
        error += abs(typical - actual)
        volume += actual
        covered += busy >= actual
    return {
        "weeks": weeks,
        "scoredWeeks": scored,
        "errorPercent": (
            float(
                (Decimal(100 * error) / volume).quantize(
                    Decimal("0.1"), rounding=ROUND_HALF_UP
                )
            )
            if volume
            else None
        ),
        "busyCoveredWeeks": covered,
    }


def menu_forecast_payload(
    user: User,
    menu: Menu,
    *,
    today: date | None = None,
    horizon_days: int = 7,
    plan: str = "typical",
) -> JsonObject:
    """Build the selected menu's non-persisted demand forecast over a horizon.

    Every horizon day is projected from its own matching weekdays, recent
    weeks counting more; only the sum is reported, because a single day's
    average is a weekday profile dressed up as a date.  ``today`` is an
    explicit test seam.
    """
    if menu.user_id != user.pk:
        raise ValueError("Menu does not belong to this workspace")
    if plan not in ("typical", "busy"):
        raise ValueError("Forecast plan must be typical or busy")
    zone = workspace_zone(user)
    today = today or timezone.now().astimezone(zone).date()
    history_start = today - timedelta(days=7 * HISTORY_WEEKS)
    history_end = today - timedelta(days=1)
    ledger_start = today - timedelta(days=7 * LEDGER_WEEKS)
    scoped_products, unresolved, menu_item_count, linked_menu_item_count, menu_prices = (
        _menu_scope(menu)
    )
    scoped_product_ids = set(scoped_products)
    # A menu that names only the box still has to plan for what is in it, and
    # a menu that names only the members still has to see the boxes' sales.
    index = BundleIndex.for_user(user)
    consumption_ids = scoped_product_ids | {
        str(product_id) for product_id in index.closure(
            product.id for product in scoped_products.values()
        )
    }
    daily, first_seen = _forecast_history(
        user,
        start=ledger_start,
        end=history_end,
        scoped_product_ids=consumption_ids,
        index=index,
    )
    # One extra span covering every window the live forecast and all four
    # backtest weeks compare against, read once like the ledger window itself.
    last_year, last_year_first_seen = _forecast_history(
        user,
        start=today - timedelta(days=SEASONAL_LOOKBACK_DAYS),
        end=today - timedelta(days=SEASONAL_LAG_DAYS - horizon_days + 1),
        scoped_product_ids=consumption_ids,
        index=index,
        modifiers=False,
    )
    # A product whose only rows are older than the history window would join as
    # a zero row and dilute coverage; the wider ledger read exists for the
    # backtest, not to widen the roster.
    all_product_ids = scoped_product_ids | {
        product_id
        for product_id, days in daily.items()
        if max(days) >= history_start
    }
    extra_products = {
        str(product.id): product
        for product in SalesProduct.objects.filter(user=user, id__in=all_product_ids)
    }
    products = {**scoped_products, **extra_products}
    # When a product began: the earlier of when the workspace made it and when
    # it was first sold.  A freshly connected workspace backfills two years of
    # sales onto products created this morning, so the ledger has to be allowed
    # to disagree with created_at.
    exists_from = {
        product_id: min(
            product.created_at.astimezone(zone).date(),
            first_seen.get(product_id, date.max),
            last_year_first_seen.get(product_id, date.max),
        )
        for product_id, product in products.items()
    }
    projections = {
        product_id: project_product(
            daily.get(product_id, {}),
            exists_from=exists_from[product_id],
            history_end=history_end,
            horizon_start=today,
            horizon_days=horizon_days,
            last_year=last_year.get(product_id),
        )
        for product_id in products
    }
    # Only a menu member is priced; a member reached inside a box is demand,
    # not a second sale.  The menu's own price wins over the product's.
    priced = {
        product_id: price
        for product_id in scoped_product_ids
        if (
            price := menu_prices.get(product_id)
            or products[product_id].sell_price_cents
        )
        > 0
    }
    product_rows: list[JsonObject] = []
    total_quantities: dict[str, Decimal] = {}
    with_history = 0
    for product_id, product in sorted(
        products.items(), key=lambda row: row[1].name.casefold()
    ):
        projection = projections[product_id]
        total = projection.busy_total if plan == "busy" else projection.typical_total
        total_quantities[product_id] = total
        with_history += bool(projection.weeks_observed)
        product_rows.append(
            {
                "productId": product_id,
                "productPublicId": product.public_id,
                "productName": product.name,
                "isActive": product.is_active,
                "menuMember": product_id in scoped_product_ids,
                "weeksObserved": projection.weeks_observed,
                "typicalQuantity": _json_quantity(projection.typical_total),
                "busyQuantity": _json_quantity(projection.busy_total),
                "totalQuantity": _json_quantity(total),
            }
        )
    recipe_requirements, material_requirements, material_unresolved = _product_material_demand(
        user, total_quantities
    )
    unresolved.extend(material_unresolved)
    return {
        "menu": {
            "id": str(menu.id),
            "publicId": menu.public_id,
            "name": menu.name,
        },
        "basis": {
            "timezone": zone.key,
            "historyStart": history_start.isoformat(),
            "historyEnd": history_end.isoformat(),
            "horizonStart": today.isoformat(),
            "horizonEnd": (today + timedelta(days=horizon_days - 1)).isoformat(),
            "horizonDays": horizon_days,
            "historyWeeks": HISTORY_WEEKS,
            "plan": plan,
            "seasonalAdjustment": any(
                projection.seasonal_factor != _NO_SEASONAL
                for projection in projections.values()
            ),
            "compositionBasis": "current",
        },
        "coverage": {
            "menuItems": menu_item_count,
            "linkedMenuItems": linked_menu_item_count,
            "unresolvedMenuItems": menu_item_count - linked_menu_item_count,
            "products": len(product_rows),
            "productsWithHistory": with_history,
            "productsWithoutHistory": len(product_rows) - with_history,
            "inactiveProducts": sum(
                1 for row in product_rows if not row["isActive"]
            ),
            "unresolvedPaths": len(unresolved),
        },
        "revenue": _menu_revenue(
            projections,
            priced,
            currency_code=workspace_currency_code(user),
            member_count=len(scoped_product_ids),
            plan=plan,
        ),
        "series": _series(
            daily,
            projections,
            priced,
            history_end=history_end,
            horizon_start=today,
            horizon_days=horizon_days,
        ),
        "backtest": _backtest(
            daily,
            priced,
            today=today,
            exists_from=exists_from,
            last_year=last_year,
        ),
        "products": product_rows,
        "recipeRequirements": recipe_requirements,
        "materialRequirements": material_requirements,
        "unresolved": unresolved,
    }
