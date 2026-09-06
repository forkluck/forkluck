from datetime import datetime
from unittest import TestCase
from zoneinfo import ZoneInfo

from .labor_period import resolve_labor_reporting_period


class LaborReportingPeriodTests(TestCase):
    def resolve(self, **overrides):
        values = {
            "start_value": None,
            "end_value": None,
            "timezone_name": "America/New_York",
            "now": datetime(2026, 8, 10, 12, tzinfo=ZoneInfo("UTC")),
            "default_to_previous_week": True,
        }
        values.update(overrides)
        return resolve_labor_reporting_period(**values)

    def test_builds_an_inclusive_range_and_matching_comparison_windows(self):
        period = self.resolve(
            start_value="2026-07-15",
            end_value="2026-08-14",
            comparison="prior_day",
        )

        self.assertEqual(period.start.isoformat(), "2026-07-15")
        self.assertEqual(period.end.isoformat(), "2026-08-14")
        self.assertEqual(period.comparison_start.isoformat(), "2026-06-14")
        self.assertEqual(period.comparison_end.isoformat(), "2026-07-14")
        self.assertEqual(period.window_start.isoformat(), "2026-07-15T00:00:00-04:00")
        self.assertEqual(period.window_end.isoformat(), "2026-08-15T00:00:00-04:00")

    def test_full_year_comparison_window_does_not_overlap_current_range(self):
        period = self.resolve(
            start_value="2024-01-01",
            end_value="2024-12-31",
            comparison="fifty_two_weeks_prior",
        )

        self.assertEqual(period.comparison_start.isoformat(), "2022-12-31")
        self.assertEqual(period.comparison_end.isoformat(), "2023-12-31")
        self.assertLess(period.comparison_end, period.start)
        self.assertEqual(
            (period.comparison_end - period.comparison_start).days + 1,
            366,
        )

    def test_defaults_to_the_previous_completed_week_in_the_labor_timezone(self):
        period = self.resolve()

        self.assertEqual(period.start.isoformat(), "2026-08-02")
        self.assertEqual(period.end.isoformat(), "2026-08-08")

    def test_empty_overview_can_keep_the_period_unset(self):
        period = self.resolve(default_to_previous_week=False, comparison="prior_day")

        self.assertIsNone(period.start)
        self.assertIsNone(period.window_start)
        self.assertIsNone(period.comparison_start)

    def test_falls_back_to_utc_for_an_unknown_timezone(self):
        period = self.resolve(timezone_name="Not/A_Zone")

        self.assertEqual(period.timezone.key, "UTC")

    def test_rejects_invalid_ranges_with_endpoint_messages(self):
        cases = [
            ({"start_value": "not-a-date"}, "Date must look like 2026-07-01"),
            ({"end_value": "2026-07-15"}, "A range end date requires a start date"),
            (
                {"start_value": "2026-07-15", "end_value": "2026-07-14"},
                "Range end date must not be before its start date",
            ),
            (
                {"start_value": "2025-01-01", "end_value": "2026-01-02"},
                "Date ranges can span at most one year",
            ),
            ({"comparison": "unsupported"}, "Comparison is not supported"),
        ]

        for values, message in cases:
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, message):
                self.resolve(**values)
