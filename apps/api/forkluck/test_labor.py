from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.conf import settings
from django.test import Client

from .models import (
    BenchCostSettings,
    Employee,
    EmployeeHourlyRate,
    LaborImport,
    TimeEntry,
    User,
)
from .testing import InternalApiTestCase


class LaborApiTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="labor@example.com",
            name="Labor Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def post_internal(self, action: str, body: dict, **kwargs):
        if action in {"import-labor", "set-employee-rate", "set-time-entry-rate"}:
            body = {"expectedCurrencyCode": "USD", **body}
        return super().post_internal(action, body, **kwargs)

    def import_payload(self) -> dict:
        return {
            "expectedCurrencyCode": "USD",
            "fileName": "hours.csv",
            "source": "csv",
            "timezone": "America/New_York",
            "mapping": {
                "employee": "Job",
                "clockIn": "Clocked In",
                "clockOut": "Clocked Out",
                "duration": "Duration",
            },
            "totalRows": 2,
            "skippedCount": 0,
            "excludedCount": 0,
            "rates": [
                {
                    "employeeName": "Alex Baker",
                    "hourlyRateCents": 2000,
                    "effectiveFrom": "2026-06-01",
                }
            ],
            "entries": [
                {
                    "position": 2,
                    "employeeName": "Alex Baker",
                    "clockInLocal": "2026-06-15T08:00:00",
                    "clockOutLocal": "2026-06-15T16:00:00",
                    "paidSeconds": 28800,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "Prep",
                    "raw": {"Job": "Alex Baker"},
                },
                {
                    "position": 3,
                    "employeeName": "Alex Baker",
                    "clockInLocal": "2026-07-15T08:00:00",
                    "clockOutLocal": "2026-07-15T12:00:00",
                    "paidSeconds": 14400,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 500,
                    "comment": "Service",
                    "raw": {"Job": "Alex Baker"},
                },
            ],
        }

    def shared_import_payload(self) -> dict:
        """One import holding a shift for each of two different employees."""
        return {
            "expectedCurrencyCode": "USD",
            "fileName": "shared-hours.csv",
            "source": "csv",
            "timezone": "America/New_York",
            "mapping": {
                "employee": "Job",
                "clockIn": "Clocked In",
                "clockOut": "Clocked Out",
                "duration": "Duration",
            },
            "totalRows": 2,
            "skippedCount": 0,
            "excludedCount": 0,
            "rates": [
                {
                    "employeeName": "Alex Baker",
                    "hourlyRateCents": 2000,
                    "effectiveFrom": "2026-06-01",
                },
                {
                    "employeeName": "Casey Diaz",
                    "hourlyRateCents": 2500,
                    "effectiveFrom": "2026-06-01",
                },
            ],
            "entries": [
                {
                    "position": 1,
                    "employeeName": "Alex Baker",
                    "clockInLocal": "2026-06-15T08:00:00",
                    "clockOutLocal": "2026-06-15T16:00:00",
                    "paidSeconds": 28800,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "Prep",
                    "raw": {"Job": "Alex Baker"},
                },
                {
                    "position": 2,
                    "employeeName": "Casey Diaz",
                    "clockInLocal": "2026-06-16T08:00:00",
                    "clockOutLocal": "2026-06-16T12:00:00",
                    "paidSeconds": 14400,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "Service",
                    "raw": {"Job": "Casey Diaz"},
                },
            ],
        }

    def test_import_rejects_a_stale_expected_currency(self):
        BenchCostSettings.objects.create(user=self.user, currency_code="EUR")

        response = self.post_internal("import-labor", self.import_payload())

        self.assertEqual(response.status_code, 400)
        self.assertIn("Currency settings changed", response.json()["error"])
        self.assertFalse(LaborImport.objects.exists())

    def test_import_rejects_a_clock_time_beyond_the_date_range(self):
        # A year-9999 sentinel or a mis-parsed year converts past datetime.max
        # in a west-of-UTC zone, raising OverflowError inside the timestamp
        # parse. The action funnel only maps ValueError/ValidationError to 400,
        # so an unguarded overflow reached the client as a 500. It must now be
        # a named 400 that leaves no partial import behind.
        payload = self.import_payload()
        payload["timezone"] = "America/Los_Angeles"
        payload["entries"] = payload["entries"][:1]
        payload["totalRows"] = 1
        payload["entries"][0]["clockInLocal"] = "9999-12-31T23:59:59"
        payload["entries"][0]["clockOutLocal"] = "9999-12-31T23:59:59"

        response = self.post_internal("import-labor", payload)

        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("date range", response.json()["error"])
        self.assertFalse(LaborImport.objects.exists())
        self.assertFalse(TimeEntry.objects.exists())

    def test_import_creates_dated_rate_and_costed_time_entries(self):
        response = self.post_internal("import-labor", self.import_payload())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "batchId": str(LaborImport.objects.get().id),
                "imported": 2,
                "createdEmployees": 1,
                "duplicates": 0,
                "skipped": 0,
                "excluded": 0,
                "totalSeconds": 43200,
                "totalLaborCostCents": 24500,
                "uncosted": 0,
            },
        )
        employee = Employee.objects.get()
        self.assertEqual(employee.normalized_name, "alex baker")
        self.assertEqual(employee.hourly_rates.get().effective_from.isoformat(), "2026-06-01")
        self.assertEqual(
            list(TimeEntry.objects.order_by("clock_in").values_list("labor_cost_cents", flat=True)),
            [16000, 8500],
        )

    def test_duplicate_import_is_audited_without_duplicate_shifts(self):
        first = self.post_internal("import-labor", self.import_payload())
        second = self.post_internal("import-labor", self.import_payload())

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["imported"], 0)
        self.assertEqual(second.json()["duplicates"], 2)
        self.assertEqual(TimeEntry.objects.count(), 2)
        self.assertEqual(LaborImport.objects.count(), 2)

    def test_import_records_intentionally_excluded_rows(self):
        payload = self.import_payload()
        payload["entries"] = payload["entries"][:1]
        payload["excludedCount"] = 1

        response = self.post_internal("import-labor", payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["imported"], 1)
        self.assertEqual(response.json()["excluded"], 1)
        self.assertEqual(response.json()["totalSeconds"], 28800)
        labor_import = LaborImport.objects.get()
        self.assertEqual(labor_import.total_rows, 2)
        self.assertEqual(labor_import.excluded_count, 1)
        self.assertEqual(TimeEntry.objects.count(), 1)

        Employee.objects.create(
            user=self.user,
            name="Rate Only Employee",
            normalized_name="rate only employee",
        )
        overview = self.client.get(
            "/internal/v1/labor-overview/",
            {"start": "2026-06-15"},
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.json()["summary"]["employeeCount"], 1)

    def test_excluding_an_employee_drops_their_money_but_keeps_their_hours(self):
        self.post_internal("import-labor", self.import_payload())
        employee = Employee.objects.get()

        def summary():
            response = self.client.get(
                "/internal/v1/labor-overview/",
                {"start": "2026-07-15", "end": "2026-08-14"},
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )
            return response.json()["summary"]

        before = summary()
        self.assertGreater(before["totalSeconds"], 0)
        self.assertGreater(before["totalLaborCostCents"], 0)

        excluded = self.post_internal(
            "set-employee-excluded-from-cost",
            {"employeeId": str(employee.id), "excludedFromCost": True},
        )
        self.assertEqual(excluded.status_code, 200)
        self.assertTrue(excluded.json()["excludedFromCost"])

        after = summary()
        self.assertEqual(after["totalSeconds"], before["totalSeconds"])
        self.assertEqual(after["totalLaborCostCents"], 0)
        # Not costing them is the point, so their shifts are not a warning.
        self.assertEqual(after["uncostedCount"], 0)
        self.assertEqual(after["uncostedSeconds"], 0)

    def test_overview_filters_date_range_and_returns_prior_period(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)

        response = self.client.get(
            "/internal/v1/labor-overview/",
            {
                "start": "2026-07-15",
                "end": "2026-08-14",
                "comparison": "prior_day",
            },
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["period"],
            {
                "start": "2026-07-15",
                "end": "2026-08-14",
                "comparisonStart": "2026-06-14",
                "comparisonEnd": "2026-07-14",
                "comparison": "prior_day",
                "timezone": "America/New_York",
                "availableDates": ["2026-07-15", "2026-06-15"],
            },
        )
        self.assertEqual(payload["summary"]["totalSeconds"], 14400)
        self.assertEqual(payload["summary"]["totalLaborCostCents"], 8500)
        self.assertEqual(payload["comparisonSummary"]["totalSeconds"], 28800)
        self.assertEqual(
            payload["comparisonSummary"]["totalLaborCostCents"], 16000
        )
        self.assertEqual(payload["employees"][0]["shiftCount"], 1)

    def test_overview_defaults_to_matching_weekday_a_year_prior(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)

        employee = Employee.objects.get()
        labor_import = LaborImport.objects.get()
        # The same weekday 52 weeks before 2026-07-15 (a Wednesday) is
        # 2025-07-16, also a Wednesday. Give it a shift so the default
        # comparison has something to measure against.
        year_ago_clock_in = datetime(
            2025, 7, 16, 8, 0, tzinfo=ZoneInfo("America/New_York")
        )
        TimeEntry.objects.create(
            user=self.user,
            employee=employee,
            labor_import=labor_import,
            source_position=99,
            source_fingerprint="year-ago-shift",
            clock_in=year_ago_clock_in,
            clock_out=year_ago_clock_in + timedelta(hours=8),
            paid_seconds=28800,
            hourly_rate_cents=2000,
            labor_cost_cents=16000,
            source_payload={},
        )

        # No comparison query param: the labor default now aligns the weekday.
        response = self.client.get(
            "/internal/v1/labor-overview/",
            {"start": "2026-07-15"},
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        period = payload["period"]
        self.assertEqual(period["comparison"], "fifty_two_weeks_prior")
        self.assertEqual(period["comparisonStart"], "2025-07-16")
        self.assertEqual(period["comparisonEnd"], "2025-07-16")
        # The year-ago window resolves to the frozen labor cost of that day,
        # not an empty comparison that would drop the delta pill.
        self.assertEqual(payload["summary"]["totalLaborCostCents"], 8500)
        self.assertEqual(
            payload["comparisonSummary"]["totalLaborCostCents"], 16000
        )
        self.assertEqual(payload["comparisonSummary"]["totalSeconds"], 28800)
        # The widened window surfaces the year-ago day for the date picker.
        self.assertIn("2025-07-16", period["availableDates"])

    def test_employee_shift_history_is_paginated_at_fifty_rows(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()
        labor_import = LaborImport.objects.get()
        first_entry = TimeEntry.objects.order_by("clock_in").first()
        assert first_entry is not None

        for position in range(10, 59):
            clock_in = first_entry.clock_in + timedelta(minutes=position)
            TimeEntry.objects.create(
                user=self.user,
                employee=employee,
                labor_import=labor_import,
                source_position=position,
                source_fingerprint=f"employee-history-{position}",
                clock_in=clock_in,
                clock_out=clock_in + timedelta(hours=1),
                paid_seconds=3600,
                hourly_rate_cents=2000,
                labor_cost_cents=2000,
                source_payload={},
            )

        response = self.client.get(
            f"/internal/v1/labor-employees/{employee.id}/",
            {"page": "2", "start": "2026-06-01", "end": "2026-08-01"},
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()["item"]
        self.assertEqual(
            payload["pagination"],
            {"page": 2, "limit": 50, "pages": 2, "total": 51},
        )
        self.assertEqual(len(payload["shifts"]), 1)
        self.assertEqual(payload["employee"]["shiftCount"], 51)
        self.assertEqual(payload["employee"]["totalSeconds"], 219600)
        self.assertEqual(
            payload["period"],
            {
                "start": "2026-06-01",
                "end": "2026-08-01",
                "timezone": "America/New_York",
            },
        )

    def test_overview_defaults_to_the_last_completed_calendar_week(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)

        with patch(
            "forkluck.domains.labor.views.timezone.now",
            return_value=datetime(2026, 8, 10, 12, tzinfo=ZoneInfo("UTC")),
        ):
            response = self.client.get(
                "/internal/v1/labor-overview/",
                HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["period"]["start"], "2026-08-02")
        self.assertEqual(payload["period"]["end"], "2026-08-08")
        # The default comparison aligns the weekday a year back (52 weeks),
        # so the baseline week is 2025-08-03..2025-08-09, not the prior week.
        self.assertEqual(payload["period"]["comparison"], "fifty_two_weeks_prior")
        self.assertEqual(payload["period"]["comparisonStart"], "2025-08-03")
        self.assertEqual(payload["period"]["comparisonEnd"], "2025-08-09")
        self.assertEqual(payload["summary"]["totalSeconds"], 0)

    def test_overview_rejects_an_inverted_date_range(self):
        response = self.client.get(
            "/internal/v1/labor-overview/",
            {"start": "2026-07-15", "end": "2026-07-14"},
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("must not be before", response.json()["error"])

    def test_new_rate_recalculates_only_shifts_on_or_after_effective_date(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()

        changed = self.post_internal(
            "set-employee-rate",
            {
                "employeeId": str(employee.id),
                "hourlyRateCents": 2500,
                "effectiveFrom": "2026-07-01",
            },
        )

        self.assertEqual(changed.status_code, 200)
        self.assertEqual(EmployeeHourlyRate.objects.count(), 2)
        self.assertEqual(
            list(
                TimeEntry.objects.order_by("clock_in").values_list(
                    "hourly_rate_cents", "labor_cost_cents"
                )
            ),
            [(2000, 16000), (2500, 10500)],
        )
        labor_import = LaborImport.objects.get()
        self.assertEqual(labor_import.total_labor_cost_cents, 26500)

    def test_manual_rate_writes_take_the_workspace_currency_lock(self):
        self.assertEqual(
            self.post_internal("import-labor", self.import_payload()).status_code, 200
        )
        employee = Employee.objects.get()
        entry = TimeEntry.objects.first()
        assert entry is not None

        with patch(
            "forkluck.domains.labor.actions.lock_workspace"
        ) as workspace_lock:
            employee_response = self.post_internal(
                "set-employee-rate",
                {
                    "employeeId": str(employee.id),
                    "hourlyRateCents": 2500,
                    "effectiveFrom": "2026-07-01",
                },
            )
            entry_response = self.post_internal(
                "set-time-entry-rate",
                {"entryId": str(entry.id), "hourlyRateCents": 3000},
            )

        self.assertEqual(employee_response.status_code, 200)
        self.assertEqual(entry_response.status_code, 200)
        self.assertEqual(workspace_lock.call_count, 2)
        workspace_lock.assert_any_call(self.user)

    def test_shift_rate_override_updates_only_that_shift_and_survives_rate_changes(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()
        adjusted_entry = TimeEntry.objects.order_by("clock_in").last()
        assert adjusted_entry is not None

        changed = self.post_internal(
            "set-time-entry-rate",
            {
                "entryId": str(adjusted_entry.id),
                "hourlyRateCents": 3000,
            },
        )

        self.assertEqual(changed.status_code, 200)
        self.assertEqual(
            changed.json(), {"ok": True, "employeeId": str(employee.id)}
        )
        self.assertEqual(EmployeeHourlyRate.objects.count(), 1)
        self.assertEqual(
            list(
                TimeEntry.objects.order_by("clock_in").values_list(
                    "hourly_rate_override_cents",
                    "hourly_rate_cents",
                    "labor_cost_cents",
                )
            ),
            [(None, 2000, 16000), (3000, 3000, 12500)],
        )
        labor_import = LaborImport.objects.get()
        self.assertEqual(labor_import.total_labor_cost_cents, 28500)
        self.assertEqual(labor_import.uncosted_count, 0)

        future_rate_change = self.post_internal(
            "set-employee-rate",
            {
                "employeeId": str(employee.id),
                "hourlyRateCents": 4000,
                "effectiveFrom": "2026-06-01",
            },
        )

        self.assertEqual(future_rate_change.status_code, 200)
        self.assertEqual(
            list(
                TimeEntry.objects.order_by("clock_in").values_list(
                    "hourly_rate_cents", "labor_cost_cents"
                )
            ),
            [(4000, 32000), (3000, 12500)],
        )
        labor_import.refresh_from_db()
        self.assertEqual(labor_import.total_labor_cost_cents, 44500)

    def test_shift_rate_override_accepts_zero_and_is_tenant_scoped(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        first_entry = TimeEntry.objects.order_by("clock_in").first()
        assert first_entry is not None
        other_user = User.objects.create_user(
            email="shift-rate-other@example.com",
            name="Shift Rate Other",
            password="a-long-test-passphrase-2468",
        )
        other_client = Client()
        other_client.force_login(other_user)

        forbidden = self.post_internal(
            "set-time-entry-rate",
            {"entryId": str(first_entry.id), "hourlyRateCents": 9999},
            client=other_client,
        )
        changed = self.post_internal(
            "set-time-entry-rate",
            {"entryId": str(first_entry.id), "hourlyRateCents": 0},
        )

        self.assertEqual(forbidden.status_code, 400)
        self.assertEqual(forbidden.json()["error"], "Time entry not found")
        self.assertEqual(changed.status_code, 200)
        first_entry.refresh_from_db()
        self.assertEqual(first_entry.hourly_rate_override_cents, 0)
        self.assertEqual(first_entry.hourly_rate_cents, 0)
        self.assertEqual(first_entry.labor_cost_cents, 0)

    def test_employee_rate_recalculation_locks_shift_rows_to_preserve_overrides(self):
        # A per-shift override save (set-time-entry-rate) locks exactly its own
        # TimeEntry row, while an employee-rate change recalculates every shift
        # for that employee. If the recalculation read a shift with an unlocked
        # SELECT, an override committed by an interleaved shift-rate save could
        # land between that read and the recalculation's bulk_update, which would
        # then clobber the committed override's cached rate and cost, violating
        # the documented precedence ("later rate-history edits preserve" the
        # override). Guard that the recalculation takes the same row lock, so the
        # two mutations serialize on the shared TimeEntry row instead of racing.
        self.assertEqual(
            self.post_internal("import-labor", self.import_payload()).status_code, 200
        )
        employee = Employee.objects.get()
        override_entry = TimeEntry.objects.order_by("clock_in").last()
        assert override_entry is not None
        self.assertEqual(
            self.post_internal(
                "set-time-entry-rate",
                {"entryId": str(override_entry.id), "hourlyRateCents": 3000},
            ).status_code,
            200,
        )

        from django.db.models.query import QuerySet

        original_select_for_update = QuerySet.select_for_update
        locked: list[tuple[type, object]] = []

        def record(self, *args, **kwargs):
            locked.append((self.model, kwargs.get("of")))
            return original_select_for_update(self, *args, **kwargs)

        with patch.object(
            QuerySet, "select_for_update", autospec=True, side_effect=record
        ):
            changed = self.post_internal(
                "set-employee-rate",
                {
                    "employeeId": str(employee.id),
                    "hourlyRateCents": 4000,
                    "effectiveFrom": "2026-06-01",
                },
            )

        self.assertEqual(changed.status_code, 200)
        # The recalculation locked the employee's TimeEntry rows (and only those
        # rows, via `of`), so it coordinates with a concurrent shift-rate save on
        # the same row rather than reading it unlocked.
        self.assertIn((TimeEntry, ("self",)), locked)

        # The committed override still wins over the newly effective employee
        # rate; only the un-overridden shift moves to the new 4000/hr rate.
        override_entry.refresh_from_db()
        self.assertEqual(override_entry.hourly_rate_override_cents, 3000)
        self.assertEqual(override_entry.hourly_rate_cents, 3000)
        self.assertEqual(override_entry.labor_cost_cents, 12500)
        plain_entry = TimeEntry.objects.order_by("clock_in").first()
        assert plain_entry is not None
        self.assertIsNone(plain_entry.hourly_rate_override_cents)
        self.assertEqual(plain_entry.hourly_rate_cents, 4000)
        self.assertEqual(plain_entry.labor_cost_cents, 32000)

    def test_import_total_refresh_locks_the_import_across_employees(self):
        # One import holds shifts for several employees, so a per-shift override
        # save and a *different* employee's rate recalculation mutate disjoint
        # TimeEntry rows: the per-row shift locks never collide. Both then
        # rewrite the same LaborImport totals. If either aggregated without the
        # import's row lock it could sum the shifts while the other transaction
        # was still uncommitted, block on the import row only at save time, and
        # write that stale total after the other committed, leaving import
        # history disagreeing with its own shifts. Guard that both refresh paths
        # take the import row lock, and take it *after* their TimeEntry locks:
        # one consistent TimeEntry-then-LaborImport order is what keeps the two
        # locks from being requested in a cycle. SQLite makes select_for_update
        # a no-op, so assert on the locks the paths request rather than on real
        # contention.
        self.assertEqual(
            self.post_internal(
                "import-labor", self.shared_import_payload()
            ).status_code,
            200,
        )
        labor_import = LaborImport.objects.get()
        self.assertEqual(labor_import.total_labor_cost_cents, 26000)
        alex_entry = TimeEntry.objects.get(employee__normalized_name="alex baker")
        casey = Employee.objects.get(normalized_name="casey diaz")

        from django.db.models.query import QuerySet

        original_select_for_update = QuerySet.select_for_update
        locks: list[tuple[type, object]] = []

        def record(self, *args, **kwargs):
            locks.append((self.model, kwargs.get("of")))
            return original_select_for_update(self, *args, **kwargs)

        with patch.object(
            QuerySet, "select_for_update", autospec=True, side_effect=record
        ):
            override = self.post_internal(
                "set-time-entry-rate",
                {"entryId": str(alex_entry.id), "hourlyRateCents": 3000},
            )
        override_locks = list(locks)
        locks.clear()

        with patch.object(
            QuerySet, "select_for_update", autospec=True, side_effect=record
        ):
            rate_change = self.post_internal(
                "set-employee-rate",
                {
                    "employeeId": str(casey.id),
                    "hourlyRateCents": 4000,
                    "effectiveFrom": "2026-06-01",
                },
            )
        recalculation_locks = list(locks)

        self.assertEqual(override.status_code, 200)
        self.assertEqual(rate_change.status_code, 200)
        for path_locks in (override_locks, recalculation_locks):
            self.assertIn((TimeEntry, ("self",)), path_locks)
            self.assertIn((LaborImport, None), path_locks)
            self.assertLess(
                path_locks.index((TimeEntry, ("self",))),
                path_locks.index((LaborImport, None)),
            )

        # Both employees' shifts moved, and the import total still equals the
        # sum of the shifts it owns.
        alex_entry.refresh_from_db()
        self.assertEqual(alex_entry.labor_cost_cents, 24000)
        casey_entry = TimeEntry.objects.get(employee=casey)
        self.assertEqual(casey_entry.labor_cost_cents, 16000)
        labor_import.refresh_from_db()
        self.assertEqual(labor_import.total_labor_cost_cents, 40000)
        self.assertEqual(
            labor_import.total_labor_cost_cents,
            sum(
                TimeEntry.objects.filter(
                    labor_import=labor_import
                ).values_list("labor_cost_cents", flat=True)
            ),
        )
        self.assertEqual(labor_import.total_seconds, 43200)
        self.assertEqual(labor_import.imported_count, 2)
        self.assertEqual(labor_import.uncosted_count, 0)

    def test_only_latest_import_can_be_undone_and_other_users_cannot_undo_it(self):
        first = self.post_internal("import-labor", self.import_payload()).json()
        second = self.post_internal("import-labor", self.import_payload()).json()

        blocked = self.post_internal("undo-labor-import", {"id": first["batchId"]})
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("newest", blocked.json()["error"])

        other_user = User.objects.create_user(
            email="other@example.com",
            name="Other Tester",
            password="a-long-test-passphrase-2468",
        )
        other_client = Client()
        other_client.force_login(other_user)
        forbidden = self.post_internal(
            "undo-labor-import", {"id": second["batchId"]}, client=other_client
        )
        self.assertEqual(forbidden.status_code, 400)
        self.assertEqual(forbidden.json()["error"], "Labor import not found")

        undone = self.post_internal("undo-labor-import", {"id": second["batchId"]})
        self.assertEqual(undone.status_code, 200)
        self.assertEqual(undone.json()["deletedEntries"], 0)
        self.assertEqual(TimeEntry.objects.count(), 2)

    def test_undo_locks_shifts_before_their_import(self):
        imported = self.post_internal("import-labor", self.import_payload()).json()

        from django.db.models.query import QuerySet

        original_select_for_update = QuerySet.select_for_update
        locks: list[type] = []

        def record(self, *args, **kwargs):
            locks.append(self.model)
            return original_select_for_update(self, *args, **kwargs)

        with patch.object(
            QuerySet, "select_for_update", autospec=True, side_effect=record
        ):
            undone = self.post_internal(
                "undo-labor-import", {"id": imported["batchId"]}
            )

        self.assertEqual(undone.status_code, 200)
        self.assertIn(TimeEntry, locks)
        self.assertIn(LaborImport, locks)
        self.assertLess(locks.index(TimeEntry), locks.index(LaborImport))

    def test_undoing_an_import_re_archives_the_employee_it_reactivated(self):
        self.post_internal("import-labor", self.import_payload())
        employee = Employee.objects.get()
        self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": False},
        )

        second = self.post_internal("import-labor", self.import_payload()).json()
        employee.refresh_from_db()
        self.assertTrue(employee.is_active)

        undone = self.post_internal("undo-labor-import", {"id": second["batchId"]})

        self.assertEqual(undone.status_code, 200)
        self.assertEqual(undone.json()["retainedEmployees"], 0)
        employee.refresh_from_db()
        self.assertFalse(employee.is_active)
        self.assertIsNone(employee.reactivated_by_import)

    def test_undoing_an_import_keeps_a_deliberately_restored_employee_active(self):
        self.post_internal("import-labor", self.import_payload())
        employee = Employee.objects.get()
        self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": False},
        )
        second = self.post_internal("import-labor", self.import_payload()).json()
        self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": True},
        )

        undone = self.post_internal("undo-labor-import", {"id": second["batchId"]})

        self.assertEqual(undone.status_code, 200)
        employee.refresh_from_db()
        self.assertTrue(employee.is_active)

    def overview_payload(self) -> dict:
        response = self.client.get(
            "/internal/v1/labor-overview/",
            {"start": "2026-06-15", "end": "2026-07-15"},
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_archived_employee_can_be_restored_and_is_scoped_to_its_owner(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()

        archived = self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": False},
        )

        self.assertEqual(archived.status_code, 200)
        self.assertEqual(archived.json(), {"ok": True, "isActive": False})
        employee.refresh_from_db()
        self.assertFalse(employee.is_active)
        self.assertFalse(self.overview_payload()["employees"][0]["isActive"])

        other_user = User.objects.create_user(
            email="other@example.com",
            name="Other Tester",
            password="a-long-test-passphrase-2468",
        )
        other_client = Client()
        other_client.force_login(other_user)
        forbidden = self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": True},
            client=other_client,
        )
        self.assertEqual(forbidden.status_code, 400)
        self.assertEqual(forbidden.json()["error"], "Employee not found")
        employee.refresh_from_db()
        self.assertFalse(employee.is_active)

        restored = self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": True},
        )

        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json(), {"ok": True, "isActive": True})
        employee.refresh_from_db()
        self.assertTrue(employee.is_active)
        self.assertTrue(self.overview_payload()["employees"][0]["isActive"])

    def test_archive_rejects_a_non_boolean_active_state(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()

        response = self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": "false"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("true or false", response.json()["error"])
        employee.refresh_from_db()
        self.assertTrue(employee.is_active)

    def test_import_restores_an_archived_employee(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()
        archived = self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": False},
        )
        self.assertEqual(archived.status_code, 200)

        payload = self.import_payload()
        payload["entries"] = payload["entries"][:1]
        payload["totalRows"] = 1
        payload["entries"][0]["clockInLocal"] = "2026-08-10T08:00:00"
        payload["entries"][0]["clockOutLocal"] = "2026-08-10T16:00:00"

        reimported = self.post_internal("import-labor", payload)

        self.assertEqual(reimported.status_code, 200)
        self.assertEqual(reimported.json()["imported"], 1)
        self.assertEqual(reimported.json()["createdEmployees"], 0)
        employee.refresh_from_db()
        self.assertTrue(employee.is_active)

    def test_archiving_keeps_the_period_hours_in_the_summary(self):
        imported = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(imported.status_code, 200)
        employee = Employee.objects.get()
        before = self.overview_payload()["summary"]
        self.assertEqual(before["totalSeconds"], 43200)

        archived = self.post_internal(
            "set-employee-active",
            {"employeeId": str(employee.id), "isActive": False},
        )

        self.assertEqual(archived.status_code, 200)
        self.assertEqual(self.overview_payload()["summary"], before)

    def import_shifts(self, shifts: list[tuple[str, str, int]]) -> None:
        payload = self.import_payload()
        payload["totalRows"] = len(shifts)
        payload["entries"] = [
            {
                "position": index + 2,
                "employeeName": "Alex Baker",
                "clockInLocal": clock_in,
                "clockOutLocal": clock_out,
                "paidSeconds": paid_seconds,
                "breakSeconds": 0,
                "timeAdjustmentSeconds": 0,
                "earningsAdjustmentCents": 0,
                "comment": "Service",
                "raw": {"Job": "Alex Baker"},
            }
            for index, (clock_in, clock_out, paid_seconds) in enumerate(shifts)
        ]
        response = self.post_internal("import-labor", payload)
        self.assertEqual(response.status_code, 200)

    def overtime_payload(self, start: str, end: str) -> dict:
        response = self.client.get(
            "/internal/v1/labor-overview/",
            {"start": start, "end": end},
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["overtime"]

    def test_overtime_evaluates_the_whole_week_behind_a_partial_range(self):
        self.import_shifts(
            [
                (f"2026-08-{day}T08:00:00", f"2026-08-{day}T17:00:00", 32400)
                for day in range(10, 15)
            ]
        )

        overtime = self.overtime_payload("2026-08-12", "2026-08-13")

        self.assertEqual(overtime["weeklyThresholdMinutes"], 2400)
        self.assertEqual(
            overtime["byEmployee"],
            {
                str(Employee.objects.get().id): [
                    {"weekStart": "2026-08-09", "totalSeconds": 162000}
                ]
            },
        )

    def test_overtime_buckets_an_overnight_shift_into_its_starting_week(self):
        self.import_shifts(
            [
                (f"2026-08-{day}T08:00:00", f"2026-08-{day}T16:00:00", 28800)
                for day in range(10, 15)
            ]
            + [("2026-08-15T22:00:00", "2026-08-16T02:00:00", 14400)]
        )

        overtime = self.overtime_payload("2026-08-10", "2026-08-16")

        self.assertEqual(
            overtime["byEmployee"],
            {
                str(Employee.objects.get().id): [
                    {"weekStart": "2026-08-09", "totalSeconds": 158400}
                ]
            },
        )

    def test_overtime_ignores_weeks_at_or_below_the_threshold(self):
        self.import_shifts(
            [
                (f"2026-08-{day}T08:00:00", f"2026-08-{day}T16:00:00", 28800)
                for day in range(10, 15)
            ]
            + [
                (f"2026-08-{day}T08:00:00", f"2026-08-{day}T16:00:00", 28800)
                for day in range(17, 21)
            ]
            + [("2026-08-21T08:00:00", "2026-08-21T15:00:00", 25200)]
        )

        overtime = self.overtime_payload("2026-08-10", "2026-08-21")

        self.assertEqual(overtime["byEmployee"], {})

    def test_overtime_threshold_follows_the_business_setting(self):
        BenchCostSettings.objects.create(
            user=self.user, overtime_weekly_minutes=1800
        )
        self.import_shifts(
            [
                (f"2026-08-{day}T08:00:00", f"2026-08-{day}T16:00:00", 28800)
                for day in range(10, 14)
            ]
        )

        overtime = self.overtime_payload("2026-08-10", "2026-08-13")

        self.assertEqual(overtime["weeklyThresholdMinutes"], 1800)
        self.assertEqual(
            overtime["byEmployee"],
            {
                str(Employee.objects.get().id): [
                    {"weekStart": "2026-08-09", "totalSeconds": 115200}
                ]
            },
        )


# Same inputs, same outputs, as apps/web/tests/labor-import.test.ts
# "normalizeEmployeeName matches the backend key". A fold added on one side
# and not the other is the silent join miss EmployeeNameKeyTests guards.
EMPLOYEE_KEY_PARITY = (
    ("Jan Groß", "jan groß"),
    ("STRAẞE KITCHEN", "straße kitchen"),
    ("Ken﻿Smith", "ken smith"),
    ("ﬁona Quinn", "ﬁona quinn"),
    ("  Alex   Baker  ", "alex baker"),
)


class EmployeeNameKeyTests(InternalApiTestCase):
    """The employee comparison key is the one the browser computes.

    `parseLaborFile` joins the preview's people against `labor-import-status`
    items by `normalizedName`, where the browser side is
    `value.toLowerCase().replace(/\\s+/g, " ").trim()` — so a backend key that
    folds more (the old `.casefold()` rule turned "Groß" into "gross") makes
    the join miss and every import shows a known employee as new, with no
    rate.
    """

    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="labor-keys@example.com",
            name="Labor Key Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def import_payload(self, name: str = "Jan Groß") -> dict:
        return {
            "expectedCurrencyCode": "USD",
            "fileName": "hours.csv",
            "source": "csv",
            "timezone": "America/New_York",
            "mapping": {
                "employee": "Job",
                "clockIn": "Clocked In",
                "clockOut": "Clocked Out",
                "duration": "Duration",
            },
            "totalRows": 1,
            "skippedCount": 0,
            "excludedCount": 0,
            "rates": [
                {
                    "employeeName": name,
                    "hourlyRateCents": 2000,
                    "effectiveFrom": "2026-06-01",
                }
            ],
            "entries": [
                {
                    "position": 2,
                    "employeeName": name,
                    "clockInLocal": "2026-06-15T08:00:00",
                    "clockOutLocal": "2026-06-15T16:00:00",
                    "paidSeconds": 28800,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "Prep",
                    "raw": {"Job": name},
                }
            ],
        }

    def test_the_key_matches_the_browser_rule_on_the_shared_corpus(self):
        from .domains.labor.serializers import normalize_employee_name

        for written, expected in EMPLOYEE_KEY_PARITY:
            with self.subTest(written=written):
                self.assertEqual(normalize_employee_name(written), expected)

    def test_import_status_returns_the_browser_key_for_an_eszett_name(self):
        response = self.post_internal("import-labor", self.import_payload())
        self.assertEqual(response.status_code, 200)
        employee = Employee.objects.get()
        self.assertEqual(employee.normalized_name, "jan groß")

        status = self.post_internal(
            "labor-import-status",
            {"people": [{"name": "Jan Groß", "effectiveOn": "2026-06-15"}]},
        )

        self.assertEqual(status.status_code, 200)
        item = status.json()["items"][0]
        # The browser looks this row up under its own key; anything else and
        # the preview shows a stored employee as brand new with no rate.
        self.assertEqual(item["normalizedName"], "jan groß")
        self.assertEqual(item["employeeId"], str(employee.id))
        self.assertEqual(item["hourlyRateCents"], 2000)

    def test_reimporting_an_eszett_employee_dedupes_and_reuses_the_row(self):
        first = self.post_internal("import-labor", self.import_payload())
        second = self.post_internal("import-labor", self.import_payload())

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["imported"], 0)
        self.assertEqual(second.json()["duplicates"], 1)
        self.assertEqual(second.json()["createdEmployees"], 0)
        self.assertEqual(Employee.objects.count(), 1)
        self.assertEqual(TimeEntry.objects.count(), 1)
