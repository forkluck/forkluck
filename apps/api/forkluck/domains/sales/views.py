"""Sales, menu and POS-connection read endpoints.

Thin wrappers over the payload builders: each one validates the query
string and hands the rest to the module that owns the numbers.
"""

import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.db.models import Prefetch, Q
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ...http.request import error
from ...models import (
    SalesImport,
    SalesLine,
    SalesLineModifier,
    Menu,
    SalesProduct,
    SyncRun,
)
from .connections import pos_connections_payload
from .core import (
    MENU_ITEM_ORDERS,
    VALID_CHANNELS,
    identity_lines_payload,
    menu_items_payload,
    menu_overview_payload,
    menu_product_rows_payload,
    product_detail_payload,
    sales_imports_payload,
    sales_overview_payload,
    sales_timezone,
)
from .pos_sync import sync_run_json, sync_runs_payload
from ..shared.pagination import (
    DOCUMENT_DEFAULT_ORDER,
    optional_filter,
    parse_browse_query,
)
from ..shared.periods import TREND_COMPARISONS
from ..shared.workspace_timezone import workspace_zone


def sales_overview(request: HttpRequest) -> JsonResponse:
    date_value = request.GET.get("start") or request.GET.get("date")
    end_value = request.GET.get("end")
    try:
        trend_date = date.fromisoformat(date_value) if date_value else None
        trend_end_date = date.fromisoformat(end_value) if end_value else None
    except ValueError:
        return error("Date must look like 2026-07-01")
    if trend_end_date is not None and trend_date is None:
        return error("A range end date requires a start date")
    if trend_date is not None and trend_end_date is not None:
        if trend_end_date < trend_date:
            return error("Range end date must not be before its start date")
        if (trend_end_date - trend_date).days > 365:
            return error("Date ranges can span at most one year")

    comparison = request.GET.get("comparison", "prior_day")
    if comparison not in TREND_COMPARISONS:
        return error("Comparison is not supported")

    timezone_value = request.GET.get("timezone")
    try:
        trend_timezone = (
            sales_timezone(timezone_value).key if timezone_value else None
        )
    except ValueError as exc:
        return error(str(exc))

    return JsonResponse(
        sales_overview_payload(
            request.user,
            trend_date=trend_date,
            trend_end_date=trend_end_date,
            trend_comparison=comparison,
            trend_timezone=trend_timezone,
        )
    )


def sales_imports(request: HttpRequest) -> JsonResponse:
    return JsonResponse(sales_imports_payload(request.user))


def menu_overview(request: HttpRequest) -> JsonResponse:
    raw = request.GET.get("sections")
    sections = (
        [name for name in (part.strip() for part in raw.split(",")) if name]
        if raw is not None
        else None
    )
    query_values = request.GET.getlist("q")
    if len(query_values) > 1:
        return error("Invalid q")
    review_query = (query_values[0] if query_values else "").strip()
    if len(review_query) > 200:
        return error("Invalid q")
    return JsonResponse(
        menu_overview_payload(
            request.user,
            sections,
            review_query=review_query,
        )
    )


def menu_items(request: HttpRequest) -> JsonResponse:
    try:
        browse = parse_browse_query(
            request.GET,
            allowed_orders=MENU_ITEM_ORDERS,
            default_order=DOCUMENT_DEFAULT_ORDER,
            extra_keys={"status"},
        )
        payload = menu_items_payload(
            request.user,
            browse,
            status=optional_filter(request.GET, "status"),
        )
    except ValueError as exc:
        return error(str(exc))
    return JsonResponse(payload)


def _window_dates(params) -> tuple[date | None, date | None]:
    """The `start`/`end` sales window a query string names, validated.

    Raises `ValueError` carrying the sentence the caller answers 400 with.
    `end` defaults to `start`, so a window is always a whole number of days.
    """
    start_value = params.get("start")
    end_value = params.get("end")
    try:
        start = date.fromisoformat(start_value) if start_value else None
        end = date.fromisoformat(end_value) if end_value else None
    except ValueError:
        raise ValueError("Date must look like 2026-07-01") from None
    if end is not None and start is None:
        raise ValueError("A range end date requires a start date")
    if date.max in {start, end}:
        raise ValueError("Date must be before 9999-12-31")
    if start is not None and end is not None:
        if end < start:
            raise ValueError("Range end date must not be before its start date")
        if (end - start).days > 365:
            raise ValueError("Date ranges can span at most one year")
    return start, (end or start)


def _sold_at_range(user, start: date | None, end: date | None):
    """The half-open [start, end) instant window those dates name locally."""
    if start is None:
        return None
    zone = workspace_zone(user)
    return (
        datetime.combine(start, time.min, tzinfo=zone),
        datetime.combine(end + timedelta(days=1), time.min, tzinfo=zone),
    )


def menu_product_rows(request: HttpRequest) -> JsonResponse:
    """The products a menu worksheet picks from, over the menu's period."""
    query_values = request.GET.getlist("q")
    if len(query_values) > 1:
        return error("Invalid q")
    search = (query_values[0] if query_values else "").strip()
    if len(search) > 200:
        return error("Invalid q")
    try:
        start, end = _window_dates(request.GET)
    except ValueError as exc:
        return error(str(exc))
    return JsonResponse(
        menu_product_rows_payload(
            request.user,
            q=search,
            sold_at_range=_sold_at_range(request.user, start, end),
        )
    )


def product_detail(request: HttpRequest, product_ref: str) -> JsonResponse:
    """Return one tenant-owned product for the Product Hub detail page."""
    try:
        start, end = _window_dates(request.GET)
    except ValueError as exc:
        return error(str(exc))
    sold_at_range = _sold_at_range(request.user, start, end)

    queryset = SalesProduct.objects.filter(user=request.user).prefetch_related(
        "skus",
        "components__recipe",
        "components__ingredient",
        "components__ingredient__conversion",
        "components__ingredient__preparations",
        "components__component_product",
    )
    if product_ref.startswith("prd_"):
        row = queryset.filter(public_id=product_ref).first()
    else:
        try:
            row = queryset.filter(id=uuid.UUID(product_ref)).first()
        except ValueError:
            row = None
    if row is None:
        return error("Product not found", 404)
    payload = product_detail_payload(
        request.user, row, sold_at_range=sold_at_range
    )
    detail_sales, as_sold, incomplete_manual = _product_detail_sales(
        request.user, row, start=start, end=end
    )
    payload["item"]["sales"].update(detail_sales)
    payload["item"]["salesAsSold"].update(as_sold)
    payload["item"]["incompleteManualRevenue"] = incomplete_manual
    return JsonResponse(payload)


def menu_forecast(request: HttpRequest, menu_ref: str) -> JsonResponse:
    """Return one tenant-owned Menu's read-time demand forecast.

    ``?start=`` and ``?end=`` are the selected dates, workspace-local; the
    default is the next seven days from today.
    """
    from .forecast import forecast_horizon

    today = timezone.now().astimezone(workspace_zone(request.user)).date()
    try:
        horizon_start, horizon_days = forecast_horizon(
            request.GET.get("start"), request.GET.get("end"), today=today
        )
    except ValueError as exc:
        return error(str(exc))
    plan = request.GET.get("plan", "typical")
    if plan not in {"typical", "busy"}:
        return error("Forecast plan must be typical or busy")
    queryset = Menu.objects.filter(user=request.user)
    if menu_ref.startswith("mnu_"):
        menu = queryset.filter(public_id=menu_ref).first()
    else:
        try:
            menu = queryset.filter(id=uuid.UUID(menu_ref)).first()
        except ValueError:
            menu = None
    if menu is None:
        return error("Menu not found", 404)

    from .forecast import menu_forecast_payload

    return JsonResponse(
        menu_forecast_payload(
            request.user,
            menu,
            horizon_start=horizon_start,
            horizon_days=horizon_days,
            plan=plan,
        )
    )


def _product_detail_sales(
    user,
    product: SalesProduct,
    *,
    start: date | None,
    end: date | None,
) -> tuple[dict, dict, bool]:
    """Range-scoped ledger rows in both views, from one walk of the ledger.

    The first result includes what reached this product inside a bundle; the
    second is what the product itself sold, which never moves.
    """
    from .bundles import BundleIndex
    from .consumption import daily_product_consumption_rows
    from .core import interpret_line

    if start is None:
        incomplete_manual = SalesLine.objects.filter(
            user=user,
            channel=SalesImport.Channel.MANUAL,
            sales_import__channel=SalesImport.Channel.MANUAL,
            sales_import__source=SalesImport.Source.MANUAL,
            sales_import__undone_at__isnull=True,
            variant__product=product,
        ).filter(
            Q(source_payload__netProvided=False) | Q(source_payload={})
        ).exists()
        empty = {"dailySales": [], "manualSales": []}
        return empty, dict(empty), incomplete_manual

    zone = workspace_zone(user)
    window_start = datetime.combine(start, time.min, tzinfo=zone)
    window_end = datetime.combine(end + timedelta(days=1), time.min, tzinfo=zone)

    manual_queryset = SalesLine.objects.filter(
        user=user,
        product=product,
        channel=SalesImport.Channel.MANUAL,
        sales_import__channel=SalesImport.Channel.MANUAL,
        sales_import__source=SalesImport.Source.MANUAL,
        sales_import__undone_at__isnull=True,
        sold_at__gte=window_start,
        sold_at__lt=window_end,
    ).order_by("sold_at", "id")
    manual_lines = list(manual_queryset)
    manual_rows = [
        {
            "id": str(line.id),
            "soldOn": line.sold_on.isoformat(),
            "quantity": float(line.quantity),
            "totalNetCents": (
                line.net_sales_cents
                if line.source_payload.get("netProvided") is True
                else None
            ),
        }
        for line in manual_lines
    ]

    index = BundleIndex.for_user(user)
    modifier_queryset = SalesLineModifier.objects.filter(
        user=user,
        sales_line__user=user,
        variant__user=user,
    ).select_related("variant", "variant__product")
    ledger_lines = (
        SalesLine.objects.filter(
            user=user,
            sales_import__undone_at__isnull=True,
            variant__isnull=False,
            variant__user=user,
            sold_at__gte=window_start,
            sold_at__lt=window_end,
        )
        .select_related("variant", "variant__product")
        .prefetch_related(Prefetch("modifiers", queryset=modifier_queryset))
        .order_by("sold_at", "id")
    )

    def blank_group() -> dict:
        return {
            "grossCents": 0,
            "discountCents": 0,
            "netSalesCents": 0,
            "taxCents": 0,
            "refundCents": 0,
            "currencies": set(),
            "skus": set(),
            "itemNames": set(),
            "incompleteManualRevenue": False,
        }

    money: dict[tuple[str, str], dict] = {}
    as_sold_money: dict[tuple[str, str], dict] = {}
    as_sold_quantities: dict[tuple[str, str], Decimal] = {}
    for line in ledger_lines:
        sold_on = line.sold_at.astimezone(zone).date().isoformat()
        key = (sold_on, line.channel)
        for expanded, target in (
            (True, money),
            (False, as_sold_money),
        ):
            for contribution in interpret_line(
                line, index=index if expanded else None, expand_bundles=expanded
            ):
                if contribution.product.id != product.id:
                    continue
                group = target.setdefault(key, blank_group())
                group["grossCents"] += contribution.gross_cents
                group["discountCents"] += contribution.discount_cents
                group["netSalesCents"] += contribution.net_sales_cents
                group["taxCents"] += contribution.tax_cents
                group["refundCents"] += contribution.refund_cents
                group["currencies"].add(line.currency_code)
                if line.sku:
                    group["skus"].add(line.sku)
                if line.item_name:
                    group["itemNames"].add(line.item_name)
                if (
                    line.channel == SalesImport.Channel.MANUAL
                    and line.source_payload.get("netProvided") is not True
                ):
                    group["incompleteManualRevenue"] = True
                if not expanded:
                    as_sold_quantities[key] = (
                        as_sold_quantities.get(key, Decimal("0"))
                        + contribution.quantity
                    )

    quantities: dict[tuple[str, str], Decimal] = {}
    for row in daily_product_consumption_rows(user, start, end, [product.id]):
        key = (row["soldOn"], row["channel"])
        quantities[key] = quantities.get(key, Decimal("0")) + row["quantity"]

    def daily_rows(
        totals: dict[tuple[str, str], Decimal], groups: dict[tuple[str, str], dict]
    ) -> tuple[list[dict], bool]:
        rows = []
        incomplete_any = False
        for (sold_on, channel), quantity in totals.items():
            group = groups.get((sold_on, channel), {})
            currencies = group.get("currencies", set())
            skus = group.get("skus", set())
            item_names = group.get("itemNames", set())
            mixed_currency = len(currencies) != 1
            incomplete = bool(group.get("incompleteManualRevenue"))
            incomplete_any = incomplete_any or incomplete
            rows.append(
                {
                    "id": f"{product.id}:{channel}:{sold_on}",
                    "soldOn": sold_on,
                    "channel": channel,
                    "productId": str(product.id),
                    "productName": product.name,
                    "sku": next(iter(skus)) if len(skus) == 1 else "",
                    "itemName": (
                        sorted(item_names)[-1] if item_names else product.name
                    ),
                    "quantity": float(quantity),
                    "grossCents": 0 if mixed_currency else group.get("grossCents", 0),
                    "discountCents": (
                        0 if mixed_currency else group.get("discountCents", 0)
                    ),
                    "netSalesCents": (
                        None
                        if incomplete or mixed_currency
                        else group.get("netSalesCents", 0)
                    ),
                    "taxCents": 0 if mixed_currency else group.get("taxCents", 0),
                    "refundCents": 0 if mixed_currency else group.get("refundCents", 0),
                    "currencyCode": next(iter(currencies), ""),
                }
            )
        return sorted(
            rows, key=lambda row: (row["soldOn"], row["channel"]), reverse=True
        ), incomplete_any

    daily, incomplete_manual = daily_rows(quantities, money)
    as_sold_daily, _ = daily_rows(as_sold_quantities, as_sold_money)
    return (
        {"dailySales": daily, "manualSales": manual_rows},
        {"dailySales": as_sold_daily, "manualSales": manual_rows},
        incomplete_manual,
    )


def sales_identity_lines(request: HttpRequest) -> JsonResponse:
    channel = request.GET.get("channel", "")
    if channel not in VALID_CHANNELS:
        return error("Sales channel is not supported")
    # A CSV identity carries no provider account, so blank is legal.
    account = request.GET.get("account", "")
    if len(account) > 192:
        return error("Invalid account")
    key = request.GET.get("key", "")
    if not key or len(key) > 500:
        return error("Invalid key")
    return JsonResponse(
        identity_lines_payload(request.user, channel, account, key)
    )


def product_categories(request: HttpRequest) -> JsonResponse:
    """Every category this tenant's products are filed under.

    The product form needs the whole vocabulary; a product's category is a
    plain string, so the list is the distinct values, blanks left out.
    """
    names = sorted(
        {
            category
            for category in SalesProduct.objects.filter(user=request.user)
            .exclude(category="")
            .values_list("category", flat=True)
        },
        key=str.casefold,
    )
    return JsonResponse(
        {"items": [{"id": name, "label": name} for name in names]}
    )


def pos_connections(request: HttpRequest) -> JsonResponse:
    return JsonResponse(pos_connections_payload(request.user))


def pos_sync_runs(request: HttpRequest) -> JsonResponse:
    return JsonResponse(sync_runs_payload(request.user))


def pos_sync_run_detail(
    request: HttpRequest, sync_run_id
) -> JsonResponse:
    run = SyncRun.objects.filter(user=request.user, id=sync_run_id).first()
    if run is None:
        return error("Not found", 404)
    return JsonResponse({"syncRun": sync_run_json(run)})
