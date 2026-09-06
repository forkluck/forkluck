from datetime import date
from unittest import TestCase

from .domains.shared.periods import (
    TREND_COMPARISONS,
    trend_comparison_date,
    trend_comparison_window,
)


class TrendComparisonWindowTests(TestCase):
    def test_fifty_two_week_year_ranges_end_before_the_current_period(self):
        cases = [
            (date(2025, 1, 1), 365, date(2024, 1, 2), date(2024, 12, 31)),
            (date(2024, 1, 1), 366, date(2022, 12, 31), date(2023, 12, 31)),
        ]

        for current_start, period_days, expected_start, expected_end in cases:
            with self.subTest(period_days=period_days):
                comparison_start, comparison_end = trend_comparison_window(
                    current_start,
                    period_days,
                    "fifty_two_weeks_prior",
                )

                self.assertEqual(comparison_start, expected_start)
                self.assertEqual(comparison_end, expected_end)
                self.assertLess(comparison_end, current_start)
                self.assertEqual(
                    (comparison_end - comparison_start).days + 1,
                    period_days,
                )


class PriorWeekWindowTests(TestCase):
    """`prior_week`, the weekday-aligned comparison Labor offers.

    Labor is driven by day-of-week patterns, so a comparison has to land on the
    same weekdays: `prior_day` steps back by the range length and measures
    Mon-Tue against Sat-Sun. The TypeScript half of these cases lives in
    `apps/web/tests/components/period-filter.test.tsx` and must agree date for date.

    17 Aug 2026 is a Monday.
    """

    MONDAY = date(2026, 8, 17)

    def test_a_partial_week_lands_on_the_same_weekdays(self):
        # The reported case: Mon-Tue compared against the Monday before, not
        # against the weekend two days back.
        self.assertEqual(
            trend_comparison_window(self.MONDAY, 2, "prior_week"),
            (date(2026, 8, 10), date(2026, 8, 11)),
        )
        self.assertEqual(
            trend_comparison_window(self.MONDAY, 2, "prior_day"),
            (date(2026, 8, 15), date(2026, 8, 16)),
        )

    def test_a_whole_week_range_resolves_exactly_as_prior_day_did(self):
        # Why replacing prior_day on Labor loses nothing: whenever the range is
        # a whole number of weeks the two comparisons are the same dates.
        for period_days in (7, 14, 21):
            with self.subTest(period_days=period_days):
                self.assertEqual(
                    trend_comparison_window(
                        self.MONDAY, period_days, "prior_week"
                    ),
                    trend_comparison_window(
                        self.MONDAY, period_days, "prior_day"
                    ),
                )

    def test_a_range_longer_than_a_week_steps_back_whole_weeks(self):
        # Ten days needs two weeks of shift to clear the current period; one
        # would overlap it. Both ends still land on the starting weekday.
        self.assertEqual(
            trend_comparison_window(self.MONDAY, 10, "prior_week"),
            (date(2026, 8, 3), date(2026, 8, 12)),
        )
        # Eight days is the tightest such case: a naive seven-day shift ends on
        # the current period's first day.
        self.assertEqual(
            trend_comparison_window(self.MONDAY, 8, "prior_week"),
            (date(2026, 8, 3), date(2026, 8, 10)),
        )

    def test_every_range_length_stays_aligned_equal_and_clear(self):
        # The overlap correction in trend_comparison_window subtracts days, not
        # weeks, so it would silently break alignment if it ever ran. Rounding
        # the shift up to a whole week is what keeps it from running at all.
        for period_days in range(1, 61):
            with self.subTest(period_days=period_days):
                start, end = trend_comparison_window(
                    self.MONDAY, period_days, "prior_week"
                )
                self.assertEqual(start.weekday(), self.MONDAY.weekday())
                self.assertEqual((end - start).days + 1, period_days)
                self.assertLess(end, self.MONDAY)

    def test_the_comparison_is_part_of_the_shared_vocabulary(self):
        # Labor's URL carries it, so the HTTP surface has to accept it.
        self.assertIn("prior_week", TREND_COMPARISONS)
        # trend_comparison_date is total over that vocabulary; a name in the
        # set that it cannot resolve would raise only for whoever called it.
        self.assertEqual(
            trend_comparison_date(self.MONDAY, "prior_week"),
            date(2026, 8, 10),
        )
