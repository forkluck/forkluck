from copy import deepcopy
from typing import Any

from django.db import transaction
from django.db.models import BigIntegerField, Sum

from ...integrations.exchange_rates import ExchangeRateQuote, convert_cents
from ...models import (
    BenchCostRecipe,
    BenchCostSettings,
    CurrencyConversion,
    EmployeeHourlyRate,
    Ingredient,
    IngredientImport,
    IngredientImportItem,
    IngredientPrice,
    LaborImport,
    MenuItem,
    Recipe,
    SalesProduct,
    SupplierItem,
    TimeEntry,
    User,
)
from ..shared.labor_policy import policy_of, recost_workspace_shifts
from ..shared.locking import lock_workspace


def _convert_rows(
    queryset,
    fields: tuple[str, ...],
    rate,
    *,
    signed_fields: frozenset[str] = frozenset(),
) -> dict[str, int]:
    rows = list(queryset.select_for_update())
    counts = {field: 0 for field in fields}
    changed_rows = []
    for row in rows:
        changed = False
        for field in fields:
            value = getattr(row, field)
            if value is None:
                continue
            converted = (
                -convert_cents(abs(value), rate)
                if field in signed_fields and value < 0
                else convert_cents(value, rate)
            )
            setattr(row, field, converted)
            counts[field] += 1
            changed = True
        if changed:
            changed_rows.append(row)
    if changed_rows:
        queryset.model.objects.bulk_update(changed_rows, fields)
    return counts


def _recompute_labor_import_totals(user: User, rate) -> dict[str, int]:
    """Keep cached import totals equal to the converted entry-level facts."""
    totals = {
        row["labor_import_id"]: row["total"] or 0
        # Declared, not inferred: the per-shift column is a 32-bit integer
        # while the total this feeds is a BigInteger, and a whole import sums
        # past 2^31 in a weak currency. Neither backend truncates today, so
        # this states the width the destination needs rather than leaving it
        # to whatever Sum() infers from the source column.
        for row in TimeEntry.objects.filter(user=user)
        .values("labor_import_id")
        .annotate(total=Sum("labor_cost_cents", output_field=BigIntegerField()))
    }
    imports = list(LaborImport.objects.select_for_update().filter(user=user))
    for labor_import in imports:
        if labor_import.undone_at is not None:
            current = labor_import.total_labor_cost_cents
            labor_import.total_labor_cost_cents = (
                -convert_cents(abs(current), rate)
                if current < 0
                else convert_cents(current, rate)
            )
        else:
            labor_import.total_labor_cost_cents = totals.get(labor_import.id, 0)
    if imports:
        LaborImport.objects.bulk_update(imports, ["total_labor_cost_cents"])
    return {"total_labor_cost_cents": len(imports)}


def _with_prefix(prefix: str, counts: dict[str, int]) -> dict[str, int]:
    return {f"{prefix}.{field}": count for field, count in counts.items()}


def _convert_snapshot(value: Any, rate) -> tuple[Any, int]:
    if isinstance(value, dict):
        result = {}
        count = 0
        for key, item in value.items():
            if (
                key.endswith("Cents")
                and isinstance(item, int)
                and not isinstance(item, bool)
            ):
                result[key] = convert_cents(item, rate)
                count += 1
            else:
                result[key], nested_count = _convert_snapshot(item, rate)
                count += nested_count
        return result, count
    if isinstance(value, list):
        result = []
        count = 0
        for item in value:
            converted, nested_count = _convert_snapshot(item, rate)
            result.append(converted)
            count += nested_count
        return result, count
    return deepcopy(value), 0


def _convert_import_snapshots(user: User, rate) -> dict[str, int]:
    counts = {"import_item_snapshots": 0, "import_snapshots": 0}
    item_fields = (
        "supplier_before",
        "supplier_after",
        "ingredient_before",
        "ingredient_after",
    )
    items = list(
        IngredientImportItem.objects.select_for_update().filter(
            ingredient_import__user=user
        )
    )
    changed_items = []
    for item in items:
        changed = False
        for field in item_fields:
            converted, count = _convert_snapshot(getattr(item, field), rate)
            if count:
                setattr(item, field, converted)
                counts["import_item_snapshots"] += count
                changed = True
        if changed:
            changed_items.append(item)
    if changed_items:
        IngredientImportItem.objects.bulk_update(changed_items, item_fields)

    imports = list(
        IngredientImport.objects.select_for_update().filter(user=user)
    )
    changed_imports = []
    for ingredient_import in imports:
        converted, count = _convert_snapshot(
            ingredient_import.ignored_items, rate
        )
        if count:
            ingredient_import.ignored_items = converted
            counts["import_snapshots"] += count
            changed_imports.append(ingredient_import)
    if changed_imports:
        IngredientImport.objects.bulk_update(changed_imports, ["ignored_items"])
    return counts


@transaction.atomic
def convert_workspace_currency(
    *,
    user: User,
    quote: ExchangeRateQuote,
    wage_per_hour_cents: int,
    measurement_system: str,
    label_region: str,
    food_cost_target_bps: int,
    overtime_weekly_minutes: int,
    timezone_name: str,
    payroll_tax_bps: int,
    unpaid_break_minutes: int,
    unpaid_break_per_hours: int,
) -> CurrencyConversion:
    # Labor imports and manual rate edits take this same lock before writing
    # workspace-native money. Hold it through the settings switch so no source-
    # currency row can land after its table has already been restated.
    lock_workspace(user)
    settings = BenchCostSettings.objects.select_for_update().get(user=user)
    if settings.currency_code != quote.source_currency:
        raise ValueError(
            "Currency settings changed in another window. Refresh and try again."
        )

    # Judged from the locked row, not from what the caller last read: a save
    # landing between that read and this lock would otherwise let a moved
    # break rule skip the recost it needs.
    break_rule_moved = (
        settings.unpaid_break_minutes,
        settings.unpaid_break_per_hours,
    ) != (unpaid_break_minutes, unpaid_break_per_hours)

    counts: dict[str, int] = {}
    counts.update(
        _with_prefix(
            "ingredients",
            _convert_rows(
                Ingredient.objects.filter(user=user),
                ("purchase_cost_cents",),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "ingredient_prices",
            _convert_rows(
                IngredientPrice.objects.filter(ingredient__user=user),
                ("purchase_cost_cents",),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "supplier_items",
            _convert_rows(
                SupplierItem.objects.filter(user=user),
                ("pack_price_cents",),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "recipes",
            _convert_rows(
                Recipe.objects.filter(user=user),
                ("menu_price_cents",),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "sales_products",
            _convert_rows(
                SalesProduct.objects.filter(user=user),
                ("sell_price_cents",),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "menu_items",
            _convert_rows(
                MenuItem.objects.filter(menu__user=user),
                (
                    "sell_price_cents",
                    "original_sell_price_cents",
                    "original_food_cost_cents",
                ),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "cost_recipes",
            _convert_rows(
                BenchCostRecipe.objects.filter(user=user),
                ("ingredient_cost_cents", "packaging_cost_cents"),
                quote.rate,
            ),
        )
    )
    # Labour money is workspace-native: a wage is an estimate the workspace
    # owns, and labour cost is compared against ingredient cost and menu price,
    # which are converted above. Leaving these behind made every labour
    # percentage silently wrong after a currency change.
    counts.update(
        _with_prefix(
            "employee_rates",
            _convert_rows(
                EmployeeHourlyRate.objects.filter(employee__user=user),
                ("hourly_rate_cents",),
                quote.rate,
            ),
        )
    )
    counts.update(
        _with_prefix(
            "time_entries",
            _convert_rows(
                TimeEntry.objects.filter(user=user),
                (
                    "hourly_rate_override_cents",
                    "hourly_rate_cents",
                    "labor_cost_cents",
                    "earnings_adjustment_cents",
                ),
                quote.rate,
                signed_fields=frozenset(
                    {"labor_cost_cents", "earnings_adjustment_cents"}
                ),
            ),
        )
    )
    counts.update(
        _with_prefix(
            "labor_imports",
            _recompute_labor_import_totals(user, quote.rate),
        )
    )
    counts.update(_convert_import_snapshots(user, quote.rate))

    settings.wage_per_hour_cents = convert_cents(
        wage_per_hour_cents, quote.rate
    )
    settings.measurement_system = measurement_system
    settings.label_region = label_region
    settings.currency_code = quote.target_currency
    settings.food_cost_target_bps = food_cost_target_bps
    settings.overtime_weekly_minutes = overtime_weekly_minutes
    settings.timezone = timezone_name
    # A rate and two durations: none of them is money, so the exchange rate
    # leaves all three alone. They ride along because this is the one path
    # that writes settings when the currency moves.
    settings.payroll_tax_bps = payroll_tax_bps
    settings.unpaid_break_minutes = unpaid_break_minutes
    settings.unpaid_break_per_hours = unpaid_break_per_hours
    settings.save(
        update_fields=[
            "wage_per_hour_cents",
            "measurement_system",
            "label_region",
            "currency_code",
            "food_cost_target_bps",
            "overtime_weekly_minutes",
            "timezone",
            "payroll_tax_bps",
            "unpaid_break_minutes",
            "unpaid_break_per_hours",
        ]
    )
    counts["wage_per_hour_cents"] = 1
    if break_rule_moved:
        # After the conversion, never before: recosting reads the hourly rates
        # this pass has just restated, so running it first would rebuild every
        # shift cost in the currency the workspace is leaving.
        recost_workspace_shifts(user, policy_of(settings))

    return CurrencyConversion.objects.create(
        user=user,
        source_currency=quote.source_currency,
        target_currency=quote.target_currency,
        rate=quote.rate,
        rate_date=quote.rate_date,
        provider=quote.provider,
        converted_counts=counts,
    )
