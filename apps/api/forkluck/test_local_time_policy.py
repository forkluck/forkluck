"""Wall-clock times at the two daylight-saving edges, and business-local dates.

A local time with no offset does not always name one instant. The gap case was
already rejected; the overlap case was resolved by whatever
`replace(tzinfo=...)` happened to do, which is fold=0 — a real choice made by
accident and documented nowhere. And employee_json resolved "the current rate"
against the server's UTC date rather than the workspace's, so near local
midnight a rate could appear a day early or late.
"""

import json
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.conf import settings
from django.test import Client, TestCase

from .domains.labor.actions import labor_local_datetime
from .domains.labor.serializers import employee_json
from .domains.sales.core import sales_datetime
from .domains.shared.localtime import is_ambiguous, is_nonexistent, resolve_local
from .models import Employee, EmployeeHourlyRate, LaborImport, TimeEntry, User


NEW_YORK = ZoneInfo("America/New_York")
# A zone west of UTC pushes a late year-9999 wall clock past datetime.max when
# it converts to UTC; a zone east of UTC pushes an early year-0001 one before
# datetime.min. Both are within a day of the boundary and overflow.
LOS_ANGELES = ZoneInfo("America/Los_Angeles")
TOKYO = ZoneInfo("Asia/Tokyo")
# US 2026: spring forward 08 March 02:00 -> 03:00; fall back 01 November
# 02:00 -> 01:00.
GAP = datetime(2026, 3, 8, 2, 30)
OVERLAP = datetime(2026, 11, 1, 1, 30)
ORDINARY = datetime(2026, 6, 15, 8, 0)
# Within a day of each datetime boundary, so the offset conversion overflows.
BEYOND_MAX = datetime(9999, 12, 31, 23, 59, 59)
BEYOND_MIN = datetime(1, 1, 1, 0, 0, 0)


class LocalTimePolicyTests(TestCase):
    def test_the_gap_is_detected(self):
        self.assertTrue(is_nonexistent(GAP, NEW_YORK))
        self.assertFalse(is_nonexistent(OVERLAP, NEW_YORK))
        self.assertFalse(is_nonexistent(ORDINARY, NEW_YORK))

    def test_the_overlap_is_detected(self):
        self.assertTrue(is_ambiguous(OVERLAP, NEW_YORK))
        self.assertFalse(is_ambiguous(ORDINARY, NEW_YORK))
        # A gap time happens zero times, not twice. fold changes the resolved
        # offset at both transitions, so this needs stating separately.
        self.assertFalse(is_ambiguous(GAP, NEW_YORK))

    def test_a_time_in_the_gap_is_rejected_by_name(self):
        with self.assertRaises(ValueError) as caught:
            resolve_local(GAP, NEW_YORK, "Clock in")
        self.assertIn("Clock in", str(caught.exception))
        self.assertIn("daylight-saving", str(caught.exception))

    def test_an_ambiguous_time_resolves_to_the_first_occurrence(self):
        resolved = resolve_local(OVERLAP, NEW_YORK, "Clock in")

        # EDT (-04:00) is the pre-transition offset; EST (-05:00) is the
        # second occurrence, an hour later in real time.
        self.assertEqual(resolved.utcoffset(), timedelta(hours=-4))
        self.assertEqual(
            resolved.astimezone(datetime_timezone.utc),
            datetime(2026, 11, 1, 5, 30, tzinfo=datetime_timezone.utc),
        )

    def test_resolution_is_stable_across_calls(self):
        # Import fingerprints are derived from these instants, so a resolution
        # that drifted would turn a re-import into a set of duplicates.
        first = resolve_local(OVERLAP, NEW_YORK, "Clock in")
        second = resolve_local(OVERLAP, NEW_YORK, "Clock in")
        self.assertEqual(first, second)
        self.assertEqual(first.fold, second.fold)

    def test_ordinary_times_are_unaffected(self):
        resolved = resolve_local(ORDINARY, NEW_YORK, "Clock in")
        self.assertEqual(resolved.utcoffset(), timedelta(hours=-4))
        self.assertEqual(resolved.replace(tzinfo=None), ORDINARY)

    def test_a_time_beyond_the_date_range_is_rejected_by_name(self):
        # The offset conversion inside the gap check raises OverflowError, which
        # the action funnel does not catch and would turn into a 500. It has to
        # surface as a named, user-fixable ValueError instead.
        for naive, zone in ((BEYOND_MAX, LOS_ANGELES), (BEYOND_MIN, TOKYO)):
            with self.assertRaises(ValueError) as caught:
                resolve_local(naive, zone, "Clock in")
            self.assertIn("Clock in", str(caught.exception))
            self.assertIn("date range", str(caught.exception))


class ParserPolicyTests(TestCase):
    """Both parsers go through the shared policy, not their own copies."""

    def test_labor_rejects_the_gap_and_resolves_the_overlap(self):
        with self.assertRaises(ValueError):
            labor_local_datetime("2026-03-08T02:30:00", "Clock in", NEW_YORK)

        resolved = labor_local_datetime("2026-11-01T01:30:00", "Clock in", NEW_YORK)
        self.assertEqual(resolved.utcoffset(), timedelta(hours=-4))

    def test_sales_rejects_the_gap_and_resolves_the_overlap(self):
        with self.assertRaises(ValueError):
            sales_datetime("2026-03-08T02:30:00", NEW_YORK)

        resolved = sales_datetime("2026-11-01T01:30:00", NEW_YORK)
        self.assertEqual(resolved.utcoffset(), timedelta(hours=-4))

    def test_an_explicit_offset_is_never_reinterpreted(self):
        # A value that already names an instant is unambiguous, so neither
        # edge applies to it.
        resolved = labor_local_datetime(
            "2026-11-01T01:30:00-05:00", "Clock in", NEW_YORK
        )
        self.assertEqual(
            resolved.astimezone(datetime_timezone.utc),
            datetime(2026, 11, 1, 6, 30, tzinfo=datetime_timezone.utc),
        )

    def test_both_parsers_reject_a_date_beyond_the_supported_range(self):
        # A timeclock or POS export can carry a year-9999 sentinel or a
        # mis-parsed year; the offset conversion overflows and, unguarded,
        # 500s. Both parsers must reject it as a value the operator can fix,
        # across the naive path (both boundaries) and the aware path.
        with self.assertRaises(ValueError):
            labor_local_datetime("9999-12-31T23:59:59", "Clock in", LOS_ANGELES)
        with self.assertRaises(ValueError):
            labor_local_datetime("0001-01-01T00:00:00", "Clock in", TOKYO)
        with self.assertRaises(ValueError):
            labor_local_datetime("9999-12-31T23:59:59+00:00", "Clock in", TOKYO)
        with self.assertRaises(ValueError):
            sales_datetime("9999-12-31T23:59:59", LOS_ANGELES)
        with self.assertRaises(ValueError):
            sales_datetime("0001-01-01T00:00:00", TOKYO)
        # A Shopify export keeps the CSV's own offset, so the aware branch is
        # the one an import actually reaches; it returns the value unresolved
        # and the fingerprint's UTC conversion is what overflows.
        with self.assertRaises(ValueError):
            sales_datetime("9999-12-31T23:59:59-08:00", LOS_ANGELES)
        with self.assertRaises(ValueError):
            sales_datetime("0001-01-01T00:00:00+14:00", TOKYO)


class EmployeeCurrentRateDateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="rate-date@example.com",
            name="Rate Date",
            password="a-long-test-passphrase-2468",
        )
        self.employee = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        EmployeeHourlyRate.objects.create(
            employee=self.employee,
            hourly_rate_cents=2000,
            effective_from=date(2026, 6, 1),
        )
        EmployeeHourlyRate.objects.create(
            employee=self.employee,
            hourly_rate_cents=3000,
            effective_from=date(2026, 6, 16),
        )

    def test_the_rate_is_resolved_against_the_date_supplied(self):
        before = employee_json(self.employee, today=date(2026, 6, 15))
        on_the_day = employee_json(self.employee, today=date(2026, 6, 16))

        self.assertEqual(before["currentHourlyRateCents"], 2000)
        self.assertEqual(on_the_day["currentHourlyRateCents"], 3000)

    def test_the_business_date_wins_over_the_servers_utc_date(self):
        # 03:00 UTC on the 16th is still the 15th in New York. The new rate
        # starts on the 16th, so a New York workspace must still see the old
        # one — the server's date would have shown the new rate hours early.
        utc_now = datetime(2026, 6, 16, 3, 0, tzinfo=datetime_timezone.utc)
        new_york_date = utc_now.astimezone(NEW_YORK).date()
        self.assertEqual(new_york_date, date(2026, 6, 15))

        with patch("django.utils.timezone.now", return_value=utc_now):
            server_view = employee_json(self.employee)
            business_view = employee_json(self.employee, today=new_york_date)

        self.assertEqual(server_view["currentHourlyRateCents"], 3000)
        self.assertEqual(business_view["currentHourlyRateCents"], 2000)


class LaborViewUsesBusinessDateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="labor-view@example.com",
            name="Labor View",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def test_the_labor_view_resolves_rates_against_the_period_timezone(self):
        employee = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=2000,
            effective_from=date(2020, 1, 1),
        )

        response = self.client.get(
            "/internal/v1/labor-overview/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = json.loads(response.content)
        rates = {
            row["normalizedName"]: row["currentHourlyRateCents"]
            for row in payload["employees"]
        }
        self.assertEqual(rates["alex baker"], 2000)

    def test_the_employee_detail_agrees_with_the_overview_across_midnight(self):
        # The detail endpoint resolved "current rate" against the server's UTC
        # date while the overview used the workspace's, so between a New York
        # midnight and 00:00 UTC the same employee showed two different rates.
        employee = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=2000,
            effective_from=date(2026, 6, 1),
        )
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=3000,
            effective_from=date(2026, 6, 16),
        )
        # The period timezone is read off the newest import, so the workspace
        # is only "in New York" once an entry anchors it there.
        labor_import = LaborImport.objects.create(
            user=self.user, file_name="shifts.csv", timezone="America/New_York"
        )
        clock_in = datetime(2026, 6, 10, 14, 0, tzinfo=datetime_timezone.utc)
        TimeEntry.objects.create(
            user=self.user,
            employee=employee,
            labor_import=labor_import,
            source_position=1,
            source_fingerprint="detail-midnight",
            clock_in=clock_in,
            clock_out=clock_in + timedelta(hours=8),
            paid_seconds=8 * 3600,
        )

        # 03:00 UTC on the 16th is still the 15th in New York, so the rate
        # effective on the 16th must not be live yet.
        utc_now = datetime(2026, 6, 16, 3, 0, tzinfo=datetime_timezone.utc)
        self.assertEqual(utc_now.astimezone(NEW_YORK).date(), date(2026, 6, 15))

        with patch("django.utils.timezone.now", return_value=utc_now):
            detail = self.client.get(
                f"/internal/v1/labor-employees/{employee.id}/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
            overview = self.client.get(
                "/internal/v1/labor-overview/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )

        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(overview.status_code, 200, overview.content)
        detail_rate = json.loads(detail.content)["item"]["employee"][
            "currentHourlyRateCents"
        ]
        overview_rate = next(
            row["currentHourlyRateCents"]
            for row in json.loads(overview.content)["employees"]
            if row["normalizedName"] == "alex baker"
        )

        self.assertEqual(detail_rate, 2000)
        self.assertEqual(detail_rate, overview_rate)

    def _rate_pair(self, employee):
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=2000,
            effective_from=date(2026, 6, 1),
        )
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=3000,
            effective_from=date(2026, 6, 16),
        )

    def _shift(self, employee, timezone_name, *, day=10):
        labor_import = LaborImport.objects.create(
            user=self.user, file_name="shifts.csv", timezone=timezone_name
        )
        clock_in = datetime(2026, 6, day, 14, 0, tzinfo=datetime_timezone.utc)
        return TimeEntry.objects.create(
            user=self.user,
            employee=employee,
            labor_import=labor_import,
            source_position=1,
            source_fingerprint=f"{employee.normalized_name}-{timezone_name}-{day}",
            clock_in=clock_in,
            clock_out=clock_in + timedelta(hours=8),
            paid_seconds=8 * 3600,
        )

    def _rates_at(self, utc_now, employee):
        with patch("django.utils.timezone.now", return_value=utc_now):
            detail = self.client.get(
                f"/internal/v1/labor-employees/{employee.id}/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
            overview = self.client.get(
                "/internal/v1/labor-overview/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(overview.status_code, 200, overview.content)
        detail_payload = json.loads(detail.content)["item"]
        overview_payload = json.loads(overview.content)
        detail_rate = detail_payload["employee"]["currentHourlyRateCents"]
        overview_rate = next(
            row["currentHourlyRateCents"]
            for row in overview_payload["employees"]
            if row["normalizedName"] == employee.normalized_name
        )
        # The rate dialog computes the effective date it saves from the
        # timezone the detail response carries, so it has to match too.
        self.assertEqual(
            detail_payload["period"]["timezone"],
            overview_payload["period"]["timezone"],
        )
        return detail_rate, overview_rate

    def test_an_employee_with_no_shifts_uses_the_workspace_date(self):
        # Reading the zone off the employee's own latest entry falls back to
        # UTC when they have none, so a New York workspace would turn this
        # employee's rate over a day early while the overview did not.
        staffed = Employee.objects.create(
            user=self.user, name="Sam Cook", normalized_name="sam cook"
        )
        self._shift(staffed, "America/New_York")
        idle = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        self._rate_pair(idle)

        detail_rate, overview_rate = self._rates_at(
            datetime(2026, 6, 16, 3, 0, tzinfo=datetime_timezone.utc), idle
        )

        self.assertEqual(detail_rate, 2000)
        self.assertEqual(detail_rate, overview_rate)

    def test_a_shift_imported_in_another_zone_uses_the_workspace_date(self):
        # This employee's newest shift came in as UTC while the workspace's
        # newest is New York. "Today" must follow the workspace, not the row.
        employee = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        self._rate_pair(employee)
        self._shift(employee, "UTC", day=10)
        newer = Employee.objects.create(
            user=self.user, name="Sam Cook", normalized_name="sam cook"
        )
        self._shift(newer, "America/New_York", day=12)

        detail_rate, overview_rate = self._rates_at(
            datetime(2026, 6, 16, 3, 0, tzinfo=datetime_timezone.utc), employee
        )

        self.assertEqual(detail_rate, 2000)
        self.assertEqual(detail_rate, overview_rate)
