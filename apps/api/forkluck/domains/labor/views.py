"""Labor read endpoints.

Plain view functions: the internal-secret guard is applied by
internal_urls.py, so this module never reaches into the dispatch layer.
"""

import math
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from django.db.models import Count, Max, Min, Prefetch, Q, Sum
from django.db.models.functions import TruncDate
from django.http import HttpRequest, JsonResponse
from django.utils import timezone

from ...http.request import error
from ...labor_period import resolve_labor_reporting_period
from ...models import BenchCostSettings, Employee, LaborImport, TimeEntry
from ..shared.labor_policy import payroll_tax_cents
from ..shared.values import iso
from ..shared.workspace_timezone import workspace_timezone_name
from .serializers import (
    employee_json,
    employee_rate_on,
    labor_import_json,
    time_entry_json,
)

JsonObject = dict[str, Any]


def _week_start(day: date) -> date:
    """The Sunday that opens the workweek containing ``day``."""
    return day - timedelta(days=(day.weekday() + 1) % 7)


def labor_overview(request: HttpRequest) -> JsonResponse:
    date_value = request.GET.get("start") or request.GET.get("date")
    end_value = request.GET.get("end")
    comparison = request.GET.get("comparison", "fifty_two_weeks_prior")
    all_entries = TimeEntry.objects.filter(user=request.user).select_related(
        "employee", "labor_import"
    )
    latest_entry = all_entries.first()
    try:
        period = resolve_labor_reporting_period(
            start_value=date_value,
            end_value=end_value,
            timezone_name=workspace_timezone_name(request.user),
            now=timezone.now(),
            default_to_previous_week=latest_entry is not None,
            comparison=comparison,
        )
    except ValueError as exc:
        return error(str(exc))

    if latest_entry is None:
        available_dates: list[str] = []
    else:
        # Use the last completed calendar week even when the newest import is
        # stale. Anchoring this default to the latest shift can quietly open
        # the page months in the past.
        #
        # The window reaches back beyond a full year so that the day the
        # default "same weekday last year" comparison lands on is itself a
        # dated shift the picker can offer; a 90-day window hid every
        # year-over-year baseline. The cap is sized to hold that year of dates.
        latest_date = latest_entry.clock_in.astimezone(period.timezone).date()
        available_window_start = datetime.combine(
            latest_date - timedelta(days=400),
            datetime.min.time(),
            tzinfo=period.timezone,
        )
        available_dates = sorted(
            {
                day.isoformat()
                for day in all_entries.filter(
                    clock_in__gte=available_window_start
                )
                .annotate(day=TruncDate("clock_in", tzinfo=period.timezone))
                .order_by()
                .values_list("day", flat=True)
                .distinct()
            },
            reverse=True,
        )[:400]

    def entries_for(window_start: datetime | None, window_end: datetime | None):
        if window_start is None or window_end is None:
            return all_entries.none()
        return all_entries.filter(clock_in__gte=window_start, clock_in__lt=window_end)

    # One settings read serves three answers below: the payroll tax rate each
    # summary loads onto its wages, the overtime threshold, and the break rule
    # the overtime week has to respect.
    workspace_settings, _ = BenchCostSettings.objects.get_or_create(
        user=request.user
    )

    def summary_for(entries) -> JsonObject:
        # An employee left out of cost still worked the hours, so only the
        # money drops them — and their shifts are not "uncosted", since not
        # costing them is the point. The exclusion rides along as a filtered
        # aggregate rather than a second query: this is a hot read path with
        # a counted query budget. The unpaid break joins that same aggregate
        # for the same reason.
        counted = Q(employee__excluded_from_cost=False)
        totals = entries.aggregate(
            employee_count=Count("employee_id", distinct=True),
            total_seconds=Sum("paid_seconds"),
            unpaid_break_seconds=Sum("unpaid_break_seconds"),
            total_labor_cost_cents=Sum("labor_cost_cents", filter=counted),
        )
        uncosted = entries.filter(
            counted, labor_cost_cents__isnull=True
        ).aggregate(total_seconds=Sum("paid_seconds"), count=Count("id"))
        labor_cost = totals["total_labor_cost_cents"] or 0
        return {
            # Clocked, not payable: the hours a timesheet reported are a fact
            # and stay one. What the break rule took off rides beside them,
            # so a reader can see both and subtract.
            "totalSeconds": totals["total_seconds"] or 0,
            "unpaidBreakSeconds": totals["unpaid_break_seconds"] or 0,
            "employeeCount": totals["employee_count"] or 0,
            "totalLaborCostCents": labor_cost,
            # The employer's burden on that wage — the incremental. Derived
            # from the rate, never stored, so it can never disagree with the
            # setting that produced it.
            "payrollTaxCents": payroll_tax_cents(
                labor_cost, workspace_settings.payroll_tax_bps
            ),
            "uncostedSeconds": uncosted["total_seconds"] or 0,
            "uncostedCount": uncosted["count"] or 0,
        }

    current_entries = entries_for(period.window_start, period.window_end)
    comparison_entries = entries_for(
        period.comparison_window_start, period.comparison_window_end
    )

    employee_rows = list(
        Employee.objects.filter(user=request.user).prefetch_related(
            "hourly_rates",
            Prefetch("time_entries", queryset=current_entries),
        )
    )
    import_rows = list(LaborImport.objects.filter(user=request.user)[:20])
    latest_active = next(
        (row for row in import_rows if row.undone_at is None), None
    )

    overtime_threshold_seconds = workspace_settings.overtime_weekly_minutes * 60
    week_totals: dict[tuple[Any, date], int] = {}
    if period.start is not None and period.end is not None:
        overtime_window_start = datetime.combine(
            _week_start(period.start), datetime.min.time(), tzinfo=period.timezone
        )
        overtime_window_end = datetime.combine(
            _week_start(period.end) + timedelta(days=7),
            datetime.min.time(),
            tzinfo=period.timezone,
        )
        # Payable time, not clocked: an unpaid meal break is not time worked,
        # so counting it toward the weekly threshold would flag a cook for
        # overtime on hours the kitchen never paid for.
        for employee_id, clock_in, paid_seconds, unpaid_break in all_entries.filter(
            clock_in__gte=overtime_window_start, clock_in__lt=overtime_window_end
        ).values_list(
            "employee_id", "clock_in", "paid_seconds", "unpaid_break_seconds"
        ):
            week = _week_start(clock_in.astimezone(period.timezone).date())
            key = (employee_id, week)
            week_totals[key] = week_totals.get(key, 0) + paid_seconds - unpaid_break
    overtime_by_employee: dict[str, list[JsonObject]] = {}
    for (employee_id, week), total_seconds in sorted(
        week_totals.items(), key=lambda item: item[0][1]
    ):
        if total_seconds > overtime_threshold_seconds:
            overtime_by_employee.setdefault(str(employee_id), []).append(
                {"weekStart": week.isoformat(), "totalSeconds": total_seconds}
            )

    business_today = timezone.now().astimezone(period.timezone).date()

    return JsonResponse(
        {
            "period": {
                "start": period.start.isoformat() if period.start else None,
                "end": period.end.isoformat() if period.end else None,
                "comparisonStart": (
                    period.comparison_start.isoformat()
                    if period.comparison_start
                    else None
                ),
                "comparisonEnd": (
                    period.comparison_end.isoformat()
                    if period.comparison_end
                    else None
                ),
                "comparison": comparison,
                "timezone": period.timezone.key,
                "availableDates": available_dates,
            },
            "summary": summary_for(current_entries),
            "comparisonSummary": summary_for(comparison_entries),
            # The business-local date, not the server's: a rate effective
            # "today" must turn over at the workspace's midnight.
            "employees": [
                employee_json(
                    row,
                    today=business_today,
                    payroll_tax_bps=workspace_settings.payroll_tax_bps,
                )
                for row in employee_rows
            ],
            "overtime": {
                "weeklyThresholdMinutes": workspace_settings.overtime_weekly_minutes,
                "byEmployee": overtime_by_employee,
            },
            # What the workspace deducts and loads on, echoed so the Labor
            # screen can name the rule behind a number it is showing rather
            # than making the reader open Settings to find out.
            "policy": {
                "payrollTaxPercent": workspace_settings.payroll_tax_bps / 100,
                "unpaidBreakMinutes": workspace_settings.unpaid_break_minutes,
                "unpaidBreakPerHours": workspace_settings.unpaid_break_per_hours,
            },
            "imports": [
                labor_import_json(
                    row,
                    can_undo=(
                        latest_active is not None and row.id == latest_active.id
                    ),
                )
                for row in import_rows
            ],
        }
    )


def labor_employee_detail(
    request: HttpRequest, employee_id: uuid.UUID
) -> JsonResponse:
    employee = (
        Employee.objects.filter(user=request.user, id=employee_id)
        .prefetch_related("hourly_rates")
        .first()
    )
    if employee is None:
        return JsonResponse({"item": None})

    try:
        requested_page = int(request.GET.get("page", "1"))
    except ValueError:
        requested_page = 1
    page_size = 50
    all_entries = employee.time_entries.select_related("employee", "labor_import")
    date_value = request.GET.get("start") or request.GET.get("date")
    end_value = request.GET.get("end")
    try:
        period = resolve_labor_reporting_period(
            start_value=date_value,
            end_value=end_value,
            timezone_name=workspace_timezone_name(request.user),
            now=timezone.now(),
            default_to_previous_week=True,
        )
    except ValueError as exc:
        return error(str(exc))
    entries = all_entries.filter(
        clock_in__gte=period.window_start, clock_in__lt=period.window_end
    )
    totals = entries.aggregate(
        shift_count=Count("id"),
        total_seconds=Sum("paid_seconds"),
        unpaid_break_seconds=Sum("unpaid_break_seconds"),
        total_labor_cost_cents=Sum("labor_cost_cents"),
        uncosted_count=Count("id", filter=Q(labor_cost_cents__isnull=True)),
        first_shift_at=Min("clock_in"),
        last_shift_at=Max("clock_out"),
    )
    workspace_settings, _ = BenchCostSettings.objects.get_or_create(
        user=request.user
    )
    total_count = totals["shift_count"] or 0
    total_pages = max(1, math.ceil(total_count / page_size))
    page = min(max(1, requested_page), total_pages)
    offset = (page - 1) * page_size
    rates = list(employee.hourly_rates.all())
    # The workspace's date, not the server's: the period above carries the
    # same zone the overview uses, and the two must not disagree across a
    # workspace midnight the server has not reached yet.
    current_rate = employee_rate_on(
        employee, timezone.now().astimezone(period.timezone).date()
    )

    return JsonResponse(
        {
            "item": {
                "period": {
                    "start": period.start.isoformat(),
                    "end": period.end.isoformat(),
                    "timezone": period.timezone.key,
                },
                "employee": {
                    "id": str(employee.id),
                    "name": employee.name,
                    "normalizedName": employee.normalized_name,
                    "isActive": employee.is_active,
                    "excludedFromCost": employee.excluded_from_cost,
                    "currentHourlyRateCents": (
                        current_rate.hourly_rate_cents if current_rate else None
                    ),
                    "currentRateEffectiveFrom": (
                        current_rate.effective_from.isoformat()
                        if current_rate
                        else None
                    ),
                    "shiftCount": total_count,
                    "totalSeconds": totals["total_seconds"] or 0,
                    "unpaidBreakSeconds": totals["unpaid_break_seconds"] or 0,
                    "laborCostCents": totals["total_labor_cost_cents"] or 0,
                    "payrollTaxCents": payroll_tax_cents(
                        totals["total_labor_cost_cents"] or 0,
                        workspace_settings.payroll_tax_bps,
                    ),
                    "uncostedCount": totals["uncosted_count"] or 0,
                    "firstShiftAt": (
                        iso(totals["first_shift_at"])
                        if totals["first_shift_at"]
                        else None
                    ),
                    "lastShiftAt": (
                        iso(totals["last_shift_at"])
                        if totals["last_shift_at"]
                        else None
                    ),
                    "rateHistory": [
                        {
                            "id": str(rate.id),
                            "hourlyRateCents": rate.hourly_rate_cents,
                            "effectiveFrom": rate.effective_from.isoformat(),
                        }
                        for rate in rates
                    ],
                },
                "shifts": [
                    time_entry_json(row)
                    for row in entries[offset : offset + page_size]
                ],
                "pagination": {
                    "page": page,
                    "limit": page_size,
                    "pages": total_pages,
                    "total": total_count,
                },
            }
        }
    )
