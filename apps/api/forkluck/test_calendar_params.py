"""The Python half of the calendar and identifier parameter contract.

Every value below is also asserted in `apps/web/tests/date-search-param.test.ts`. The
Next.js pages guard their query parameters before forwarding them, and those
guards are only correct while they accept exactly what this layer accepts: a
value that passes the frontend shape check but fails here comes back as a 400,
and a 400 raised inside a Server Component takes the whole screen down instead
of falling back the way the page does for a value it recognizes as unusable.

Keep the two tables in step. Moving a value between the accepted and rejected
columns is a contract change in both languages.
"""

import re
from datetime import date

from django.test import SimpleTestCase
from django.urls.converters import UUIDConverter

from .domains.shared.values import month_value

# (end - start).days above this is refused by both reports.
MAX_RANGE_DAYS = 365

READABLE_DATES = [
    "2026-07-01",
    "2026-12-31",
    "2024-02-29",
    "0001-01-01",
    "9999-12-31",
]

# Well formed for /^\d{4}-\d{2}-\d{2}$/, but not dates.
UNREADABLE_DATES = [
    "2026-13-45",
    "2026-13-01",
    "2026-00-10",
    "2026-01-32",
    "2026-01-00",
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-11-31",
    "0000-01-01",
    "0000-12-31",
]

READABLE_MONTHS = ["2026-01", "2026-07", "2026-12", "9999-12"]

UNREADABLE_MONTHS = ["2026-13", "2026-00", "2026-99", "9999-99", "0000-01"]


class CalendarParameterContract(SimpleTestCase):
    def test_readable_dates_round_trip(self):
        for value in READABLE_DATES:
            with self.subTest(value=value):
                self.assertEqual(date.fromisoformat(value).isoformat(), value)

    def test_unreadable_dates_are_refused(self):
        for value in UNREADABLE_DATES:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    date.fromisoformat(value)

    def test_readable_months_round_trip(self):
        for value in READABLE_MONTHS:
            with self.subTest(value=value):
                parsed = month_value(value)
                self.assertIsNotNone(parsed)
                self.assertEqual(parsed.strftime("%Y-%m"), value)
                self.assertEqual(parsed.day, 1)

    def test_unreadable_months_are_refused(self):
        for value in UNREADABLE_MONTHS:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    month_value(value)

    def test_blank_month_reads_as_no_selection(self):
        self.assertIsNone(month_value(None))
        self.assertIsNone(month_value(""))

    def test_longest_allowed_window_is_a_year_of_whole_days(self):
        start = date.fromisoformat("2026-01-01")
        self.assertEqual(
            (date.fromisoformat("2027-01-01") - start).days, MAX_RANGE_DAYS
        )
        self.assertGreater(
            (date.fromisoformat("2027-01-02") - start).days, MAX_RANGE_DAYS
        )


class IdentifierParameterContract(SimpleTestCase):
    """The frontend guard mirrors `UUIDConverter.regex`, including its case."""

    ROUTABLE = [
        "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        "00000000-0000-0000-0000-000000000000",
    ]

    UNROUTABLE = [
        "",
        "not-a-uuid",
        "123",
        "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
        "3f2504e04f8911d39a0c0305e82c3301",
        "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        "3f2504e0-4f89-11d3-9a0c-0305e82c3301 ",
        "3f2504e0-4f89-11d3-9a0c-0305e82c33011",
    ]

    def test_converter_matches_the_ids_the_frontend_keeps(self):
        pattern = re.compile(f"^{UUIDConverter.regex}$")
        for value in self.ROUTABLE:
            with self.subTest(value=value):
                self.assertIsNotNone(pattern.match(value))
        for value in self.UNROUTABLE:
            with self.subTest(value=value):
                self.assertIsNone(pattern.match(value))
