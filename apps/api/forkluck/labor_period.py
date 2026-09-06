"""Reporting-period policy shared by labor read endpoints."""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .domains.shared.periods import TREND_COMPARISONS, trend_comparison_window


@dataclass(frozen=True)
class LaborReportingPeriod:
    """A validated, inclusive labor date range and its query windows."""

    timezone: ZoneInfo
    start: date | None
    end: date | None
    window_start: datetime | None
    window_end: datetime | None
    comparison_start: date | None
    comparison_end: date | None
    comparison_window_start: datetime | None
    comparison_window_end: datetime | None


def resolve_labor_timezone(timezone_name: str | None) -> ZoneInfo:
    """The reporting zone for an import's timezone name, falling back to UTC.

    Every consumer that has to agree on "which day is it for this workspace"
    resolves the name here, so an unknown or missing zone cannot mean one
    thing to the overview and another to a detail page.
    """
    try:
        return ZoneInfo(timezone_name) if timezone_name else ZoneInfo("UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def resolve_labor_reporting_period(
    *,
    start_value: str | None,
    end_value: str | None,
    timezone_name: str | None,
    now: datetime,
    default_to_previous_week: bool,
    comparison: str | None = None,
) -> LaborReportingPeriod:
    """Resolve labor query inputs, defaults, timezone fallback, and windows.

    A supplied range is inclusive.  Without one, callers choose whether an
    empty result remains unbounded or defaults to the previous completed week.
    """
    try:
        selected_start = date.fromisoformat(start_value) if start_value else None
        selected_end = date.fromisoformat(end_value) if end_value else None
    except ValueError as exc:
        raise ValueError("Date must look like 2026-07-01") from exc

    if selected_end is not None and selected_start is None:
        raise ValueError("A range end date requires a start date")
    if selected_start is not None and selected_end is not None:
        if selected_end < selected_start:
            raise ValueError("Range end date must not be before its start date")
        if (selected_end - selected_start).days > 365:
            raise ValueError("Date ranges can span at most one year")
    if comparison is not None and comparison not in TREND_COMPARISONS:
        raise ValueError("Comparison is not supported")

    zone = resolve_labor_timezone(timezone_name)

    if selected_start is not None:
        start = selected_start
        end = selected_end or selected_start
    elif default_to_previous_week:
        today = now.astimezone(zone).date()
        current_week_start = today - timedelta(days=(today.weekday() + 1) % 7)
        end = current_week_start - timedelta(days=1)
        start = end - timedelta(days=6)
    else:
        start = None
        end = None

    window_start, window_end = _date_window(start, end, zone)
    comparison_start = None
    comparison_end = None
    if start is not None and end is not None and comparison is not None:
        period_days = (end - start).days + 1
        comparison_start, comparison_end = trend_comparison_window(
            start, period_days, comparison
        )
    comparison_window_start, comparison_window_end = _date_window(
        comparison_start, comparison_end, zone
    )
    return LaborReportingPeriod(
        timezone=zone,
        start=start,
        end=end,
        window_start=window_start,
        window_end=window_end,
        comparison_start=comparison_start,
        comparison_end=comparison_end,
        comparison_window_start=comparison_window_start,
        comparison_window_end=comparison_window_end,
    )


def _date_window(
    start: date | None, end: date | None, zone: ZoneInfo
) -> tuple[datetime | None, datetime | None]:
    if start is None or end is None:
        return None, None
    return (
        datetime.combine(start, datetime.min.time(), tzinfo=zone),
        datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=zone),
    )
