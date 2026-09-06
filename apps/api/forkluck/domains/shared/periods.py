"""Trend comparison periods shared by the sales and labor reports.

A leaf module: the two reports resolve a comparison identically, so the
vocabulary lives in one place. Which of these each report *offers* is a UI
decision and differs — labor only offers the weekday-aligned ones, because
staffing follows day-of-week patterns — but a name means the same dates
wherever it arrives from, including on a link shared between the two.
"""

from datetime import date, timedelta


TREND_COMPARISONS = {
    "prior_day",
    "prior_week",
    "prior_sunday",
    "four_weeks_prior",
    "fifty_two_weeks_prior",
    "prior_year",
}


def trend_comparison_date(current_date: date, comparison: str) -> date:
    if comparison == "prior_day":
        return current_date - timedelta(days=1)
    if comparison == "prior_week":
        return current_date - timedelta(weeks=1)
    if comparison == "prior_sunday":
        days_since_sunday = (current_date.weekday() + 1) % 7
        return current_date - timedelta(days=days_since_sunday + 7)
    if comparison == "four_weeks_prior":
        return current_date - timedelta(weeks=4)
    if comparison == "fifty_two_weeks_prior":
        return current_date - timedelta(weeks=52)
    if comparison == "prior_year":
        try:
            return current_date.replace(year=current_date.year - 1)
        except ValueError:
            # February 29 compares to February 28 in a non-leap year.
            return current_date.replace(year=current_date.year - 1, day=28)
    raise ValueError("Comparison is not supported")


def trend_comparison_start(
    current_start: date, period_days: int, comparison: str
) -> date:
    if comparison == "prior_day":
        return current_start - timedelta(days=period_days)
    if comparison == "prior_week":
        # Whole weeks back, so the window keeps the current period's weekdays.
        # Rounding the shift up to a whole week also keeps it clear of the
        # current period, so the overlap correction below — which subtracts
        # days, not weeks — never runs and never breaks that alignment.
        return current_start - timedelta(weeks=-(-period_days // 7))
    return trend_comparison_date(current_start, comparison)


def trend_comparison_window(
    current_start: date, period_days: int, comparison: str
) -> tuple[date, date]:
    """Return an equal-length comparison window before the current one."""
    comparison_start = trend_comparison_start(
        current_start, period_days, comparison
    )
    comparison_end = comparison_start + timedelta(days=period_days - 1)
    if comparison_end >= current_start:
        overlap_days = (comparison_end - current_start).days + 1
        comparison_start -= timedelta(days=overlap_days)
        comparison_end -= timedelta(days=overlap_days)
    return comparison_start, comparison_end
