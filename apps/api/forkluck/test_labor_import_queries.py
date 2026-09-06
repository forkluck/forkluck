"""The labour import's query count does not follow the size of the file.

The endpoint accepts up to 5,000 entries. It used to run get_or_create per
distinct employee, update_or_create per declared rate, a rate lookup per entry
— employee_rate_on falls back to a query whenever rates are not prefetched, and
the employees assembled during import never had them prefetched — and one
INSERT per entry. Query count therefore grew linearly with the file, and a
large upload spent its time in round trips.

These tests assert the shape that fixes it: a fixed number of queries
regardless of how many rows and employees arrive, with identical results.
"""

from datetime import date, timedelta

from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from .models import (
    Employee,
    EmployeeHourlyRate,
    LaborImport,
    TimeEntry,
    User,
)
from .testing import InternalApiTestCase


class LaborImportQueryCountTests(InternalApiTestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="labor-queries@example.com",
            name="Labor Queries",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def payload(self, *, employees: int, shifts_each: int) -> dict:
        entries = []
        position = 2
        for index in range(employees):
            for shift in range(shifts_each):
                day = date(2026, 6, 1) + timedelta(days=shift)
                entries.append(
                    {
                        "position": position,
                        "employeeName": f"Employee {index}",
                        "clockInLocal": f"{day.isoformat()}T08:00:00",
                        "clockOutLocal": f"{day.isoformat()}T16:00:00",
                        "paidSeconds": 28800,
                        "breakSeconds": 0,
                        "timeAdjustmentSeconds": 0,
                        "earningsAdjustmentCents": 0,
                        "comment": "",
                        "raw": {"Job": f"Employee {index}", "Row": str(position)},
                    }
                )
                position += 1
        return {
            "expectedCurrencyCode": "USD",
            "fileName": "hours.csv",
            "source": "csv",
            "timezone": "America/New_York",
            "mapping": {
                "employee": "Job",
                "clockIn": "Clocked In",
                "clockOut": "Clocked Out",
            },
            "totalRows": len(entries),
            "skippedCount": 0,
            "excludedCount": 0,
            "rates": [
                {
                    "employeeName": f"Employee {index}",
                    "hourlyRateCents": 2000 + index,
                    "effectiveFrom": "2026-05-01",
                }
                for index in range(employees)
            ],
            "entries": entries,
        }

    def count_queries(self, payload: dict) -> int:
        with CaptureQueriesContext(connection) as captured:
            response = self.post_internal("import-labor", payload)
        self.assertEqual(response.status_code, 200, response.content)
        return len(captured)

    def test_query_count_does_not_grow_with_the_number_of_rows(self):
        small = self.count_queries(self.payload(employees=2, shifts_each=2))

        LaborImport.objects.all().delete()
        Employee.objects.all().delete()
        large = self.count_queries(self.payload(employees=2, shifts_each=50))

        # Not exact equality: bulk_create splits into more INSERT statements
        # as rows grow, because SQLite caps parameters per statement. What
        # must not happen is growth proportional to rows — 25x the rows here.
        self.assertLessEqual(
            large - small,
            2,
            f"{small} queries for 4 rows but {large} for 100 — the import is "
            "still doing per-row work",
        )

    def test_query_count_does_not_grow_with_the_number_of_employees(self):
        few = self.count_queries(self.payload(employees=2, shifts_each=2))

        LaborImport.objects.all().delete()
        Employee.objects.all().delete()
        many = self.count_queries(self.payload(employees=40, shifts_each=2))

        self.assertLessEqual(
            many - few,
            2,
            f"{few} queries for 2 employees but {many} for 40 — the import is "
            "still doing per-employee work",
        )

    def test_a_large_import_stays_within_a_small_fixed_budget(self):
        # A ceiling rather than an exact number, so ordinary refactors do not
        # churn it, but a reintroduced N+1 fails loudly.
        used = self.count_queries(self.payload(employees=50, shifts_each=20))

        self.assertLess(used, 40, f"1,000 rows took {used} queries")
        self.assertEqual(TimeEntry.objects.filter(user=self.user).count(), 1000)


class LaborImportResultsUnchangedTests(InternalApiTestCase):
    """The staged import must produce exactly what the row-by-row one did."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="labor-results@example.com",
            name="Labor Results",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def base_payload(self, **overrides) -> dict:
        payload = {
            "expectedCurrencyCode": "USD",
            "fileName": "hours.csv",
            "source": "csv",
            "timezone": "America/New_York",
            "mapping": {"employee": "Job", "clockIn": "In", "clockOut": "Out"},
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
                    "earningsAdjustmentCents": 500,
                    "comment": "Prep",
                    "raw": {"Job": "Alex Baker"},
                },
                {
                    "position": 3,
                    "employeeName": "Sam Cook",
                    "clockInLocal": "2026-06-15T08:00:00",
                    "clockOutLocal": "2026-06-15T12:00:00",
                    "paidSeconds": 14400,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "",
                    "raw": {"Job": "Sam Cook"},
                },
            ],
        }
        payload.update(overrides)
        return payload

    def test_totals_match_the_entries_that_were_accepted(self):
        response = self.post_internal("import-labor", self.base_payload())
        body = response.json()

        self.assertEqual(body["imported"], 2)
        self.assertEqual(body["totalSeconds"], 28800 + 14400)
        # Alex is rated (8h at 2000 + 500 adjustment); Sam has no rate.
        self.assertEqual(body["totalLaborCostCents"], 16000 + 500)
        self.assertEqual(body["uncosted"], 1)
        self.assertEqual(body["createdEmployees"], 2)

        row = LaborImport.objects.get(user=self.user)
        self.assertEqual(row.imported_count, 2)
        self.assertEqual(row.total_seconds, 28800 + 14400)
        self.assertEqual(row.total_labor_cost_cents, 16000 + 500)
        self.assertEqual(row.uncosted_count, 1)

    def test_duplicates_are_counted_and_not_stored(self):
        self.post_internal("import-labor", self.base_payload())
        second = self.post_internal("import-labor", self.base_payload())

        self.assertEqual(second.json()["duplicates"], 2)
        self.assertEqual(second.json()["imported"], 0)
        self.assertEqual(TimeEntry.objects.filter(user=self.user).count(), 2)

    def test_an_existing_employee_is_reused_not_duplicated(self):
        Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )

        body = self.post_internal("import-labor", self.base_payload()).json()

        self.assertEqual(body["createdEmployees"], 1, "only Sam is new")
        self.assertEqual(Employee.objects.filter(user=self.user).count(), 2)

    def test_an_archived_employee_is_reactivated_and_attributed(self):
        archived = Employee.objects.create(
            user=self.user,
            name="Alex Baker",
            normalized_name="alex baker",
            is_active=False,
        )

        self.post_internal("import-labor", self.base_payload())

        archived.refresh_from_db()
        self.assertTrue(archived.is_active)
        self.assertIsNotNone(archived.reactivated_by_import)

    def test_a_rate_the_file_creates_is_attributed_to_that_import(self):
        self.post_internal("import-labor", self.base_payload())

        rate = EmployeeHourlyRate.objects.get(employee__normalized_name="alex baker")
        self.assertEqual(rate.hourly_rate_cents, 2000)
        self.assertIsNotNone(rate.source_import)

    def test_a_restated_rate_is_updated_and_keeps_its_original_attribution(self):
        first = self.post_internal("import-labor", self.base_payload())
        original_import = first.json()["batchId"]

        payload = self.base_payload(fileName="hours-2.csv")
        payload["rates"][0]["hourlyRateCents"] = 2500
        for entry in payload["entries"]:
            entry["raw"]["Row"] = "changed"
            entry["position"] += 10
        self.post_internal("import-labor", payload)

        rates = EmployeeHourlyRate.objects.filter(
            employee__normalized_name="alex baker"
        )
        self.assertEqual(rates.count(), 1, "same effective date must not duplicate")
        rate = rates.get()
        self.assertEqual(rate.hourly_rate_cents, 2500)
        self.assertEqual(
            str(rate.source_import_id),
            original_import,
            "only the file that first created a rate owns it",
        )

    def test_the_rate_in_force_on_each_shift_is_the_one_applied(self):
        # A rate already on file plus a newer one this file declares, with a
        # shift on either side of the change. Resolution moved from a per-entry
        # query to an in-memory scan over the union of both, so precedence has
        # to be pinned: the newest rate effective on or before the shift wins.
        # (A single file can only declare one rate per employee — rate_values
        # is keyed by name — so the older rate has to come from the database.)
        employee = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        EmployeeHourlyRate.objects.create(
            employee=employee,
            hourly_rate_cents=2000,
            effective_from=date(2026, 6, 1),
        )

        payload = self.base_payload()
        payload["rates"] = [
            {
                "employeeName": "Alex Baker",
                "hourlyRateCents": 3000,
                "effectiveFrom": "2026-06-16",
            },
        ]
        payload["entries"] = [
            {
                "position": 2,
                "employeeName": "Alex Baker",
                "clockInLocal": "2026-06-15T08:00:00",
                "clockOutLocal": "2026-06-15T16:00:00",
                "paidSeconds": 3600,
                "breakSeconds": 0,
                "timeAdjustmentSeconds": 0,
                "earningsAdjustmentCents": 0,
                "comment": "",
                "raw": {"Job": "Alex Baker", "Row": "1"},
            },
            {
                "position": 3,
                "employeeName": "Alex Baker",
                "clockInLocal": "2026-06-17T08:00:00",
                "clockOutLocal": "2026-06-17T16:00:00",
                "paidSeconds": 3600,
                "breakSeconds": 0,
                "timeAdjustmentSeconds": 0,
                "earningsAdjustmentCents": 0,
                "comment": "",
                "raw": {"Job": "Alex Baker", "Row": "2"},
            },
        ]
        payload["totalRows"] = 2

        self.post_internal("import-labor", payload)

        entries = TimeEntry.objects.filter(user=self.user).order_by("clock_in")
        self.assertEqual(
            [entry.hourly_rate_cents for entry in entries], [2000, 3000]
        )

    def test_a_shift_before_every_rate_stays_uncosted(self):
        payload = self.base_payload()
        payload["rates"][0]["effectiveFrom"] = "2026-07-01"

        body = self.post_internal("import-labor", payload).json()

        self.assertEqual(body["uncosted"], 2)
        self.assertEqual(body["totalLaborCostCents"], 0)

    def test_another_workspace_s_employee_of_the_same_name_is_not_reused(self):
        other = User.objects.create_user(
            email="other-labor@example.com",
            name="Other",
            password="a-long-test-passphrase-1357",
        )
        Employee.objects.create(
            user=other, name="Alex Baker", normalized_name="alex baker"
        )

        body = self.post_internal("import-labor", self.base_payload()).json()

        self.assertEqual(body["createdEmployees"], 2)
        self.assertEqual(Employee.objects.filter(user=self.user).count(), 2)
        self.assertEqual(Employee.objects.filter(user=other).count(), 1)
