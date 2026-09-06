"""The workspace labor policy: unpaid break deduction and payroll burden.

The two settings sit at different depths, and the difference is the point of
most of what is checked here. The unpaid break changes what a shift is paid
for, so it is baked into every stored `labor_cost_cents` and has to survive a
policy change, a rate edit and a per-shift override. The payroll tax is a rate
applied to money that is already correct, so nothing stores it and it must
never reach a stored column.

Both default to off, and the first test in each group pins that: this feature
is not allowed to move a number in a workspace that never opened it.
"""

from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.test import Client

from .integrations.exchange_rates import ExchangeRateQuote

from .domains.shared.labor_policy import (
    LaborPolicy,
    payroll_tax_cents,
    unpaid_break_seconds_for,
)
from .models import BenchCostSettings, LaborImport, TimeEntry, User
from .testing import InternalApiTestCase

EIGHT_HOURS = 28800
FOUR_HOURS = 14400


class UnpaidBreakArithmeticTests(InternalApiTestCase):
    """The rule itself, away from the database."""

    def policy(self, minutes: int, per_hours: int = 8) -> LaborPolicy:
        return LaborPolicy(
            unpaid_break_minutes=minutes,
            unpaid_break_per_hours=per_hours,
            payroll_tax_bps=0,
        )

    def test_no_minutes_deducts_nothing(self):
        self.assertEqual(
            unpaid_break_seconds_for(EIGHT_HOURS, self.policy(0)), 0
        )

    def test_only_whole_completed_blocks_are_deducted(self):
        rule = self.policy(30)
        # A short shift loses nothing: prorating would dock a four-hour lunch
        # service for a meal break nobody took.
        self.assertEqual(unpaid_break_seconds_for(FOUR_HOURS, rule), 0)
        self.assertEqual(unpaid_break_seconds_for(EIGHT_HOURS - 1, rule), 0)
        self.assertEqual(unpaid_break_seconds_for(EIGHT_HOURS, rule), 1800)
        self.assertEqual(unpaid_break_seconds_for(15 * 3600, rule), 1800)
        self.assertEqual(unpaid_break_seconds_for(16 * 3600, rule), 3600)

    def test_the_deduction_never_exceeds_the_shift(self):
        # Payable time below zero would pay the kitchen to open, and the
        # TimeEntry check constraint would refuse the row besides.
        self.assertEqual(
            unpaid_break_seconds_for(7200, self.policy(480, per_hours=1)), 7200
        )

    def test_payroll_tax_carries_the_sign_of_the_money_it_is_on(self):
        # An earnings adjustment can outweigh a shift, and a burden that
        # stayed positive on a negative total would invent money.
        self.assertEqual(payroll_tax_cents(10000, 939), 939)
        self.assertEqual(payroll_tax_cents(-10000, 939), -939)
        self.assertEqual(payroll_tax_cents(10000, 0), 0)


class LaborPolicyApiTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="policy@example.com",
            name="Policy Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def post_internal(self, action: str, body: dict, **kwargs):
        if action in {
            "import-labor",
            "set-employee-rate",
            "set-time-entry-rate",
            "update-business-settings",
        }:
            body = {"expectedCurrencyCode": "USD", **body}
        return super().post_internal(action, body, **kwargs)

    def import_payload(self, *, paid_seconds: int = EIGHT_HOURS) -> dict:
        """One $20/h shift, whose length the caller chooses."""
        return {
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
                    "clockOutLocal": "2026-06-15T20:00:00",
                    "paidSeconds": paid_seconds,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "Prep",
                    "raw": {"Job": "Alex Baker"},
                }
            ],
        }

    def settings_payload(self, **overrides) -> dict:
        return {
            "wagePerHourCents": 2000,
            "measurementSystem": "metric",
            "currencyCode": "USD",
            "foodCostTarget": 0.3,
            **overrides,
        }

    def save_settings(self, **overrides):
        response = self.post_internal(
            "update-business-settings", self.settings_payload(**overrides)
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response

    def only_entry(self) -> TimeEntry:
        return TimeEntry.objects.get(user=self.user)

    def overview(self, **query):
        response = self.get_internal("labor-overview/", query or None)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    # --- defaults -------------------------------------------------------

    def test_a_workspace_that_never_set_the_policy_costs_the_full_shift(self):
        self.post_internal("import-labor", self.import_payload())

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 0)
        # Eight hours at $20 — exactly what it cost before this feature.
        self.assertEqual(entry.labor_cost_cents, 16000)

    def test_an_imported_break_column_is_recorded_and_never_deducted(self):
        # A provider's break column is already reflected in the hours it hands
        # us; subtracting it again would bill the break twice. Only the
        # workspace's own rule deducts.
        payload = self.import_payload()
        payload["entries"][0]["breakSeconds"] = 1800
        self.post_internal("import-labor", payload)

        entry = self.only_entry()
        self.assertEqual(entry.break_seconds, 1800)
        self.assertEqual(entry.unpaid_break_seconds, 0)
        self.assertEqual(entry.labor_cost_cents, 16000)

    # --- the break rule -------------------------------------------------

    def test_the_rule_deducts_from_a_shift_as_it_is_imported(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)

        self.post_internal("import-labor", self.import_payload())

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 1800)
        # Clocked time is the imported fact and does not move.
        self.assertEqual(entry.paid_seconds, EIGHT_HOURS)
        # Seven and a half hours at $20.
        self.assertEqual(entry.labor_cost_cents, 15000)

    def test_turning_the_rule_on_recosts_shifts_already_imported(self):
        self.post_internal("import-labor", self.import_payload())
        self.assertEqual(self.only_entry().labor_cost_cents, 16000)

        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 1800)
        self.assertEqual(entry.labor_cost_cents, 15000)
        # The import's cached totals move with the shifts they summarize, or
        # import history disagrees with its own rows.
        row = LaborImport.objects.get(user=self.user)
        self.assertEqual(row.total_labor_cost_cents, 15000)
        self.assertEqual(row.total_seconds, EIGHT_HOURS)

    def test_turning_the_rule_off_again_restores_the_full_cost(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)
        self.post_internal("import-labor", self.import_payload())
        self.assertEqual(self.only_entry().labor_cost_cents, 15000)

        self.save_settings(unpaidBreakMinutes=0, unpaidBreakPerHours=8)

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 0)
        self.assertEqual(entry.labor_cost_cents, 16000)

    def test_widening_the_block_stops_deducting_from_a_shift_under_it(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)
        self.post_internal("import-labor", self.import_payload())
        self.assertEqual(self.only_entry().unpaid_break_seconds, 1800)

        # The same eight-hour shift no longer completes a twelve-hour block.
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=12)

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 0)
        self.assertEqual(entry.labor_cost_cents, 16000)

    def test_a_per_shift_rate_override_still_costs_payable_time(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)
        self.post_internal("import-labor", self.import_payload())
        entry = self.only_entry()

        response = self.post_internal(
            "set-time-entry-rate",
            {"entryId": str(entry.id), "hourlyRateCents": 4000},
        )
        self.assertEqual(response.status_code, 200, response.content)

        entry.refresh_from_db()
        self.assertEqual(entry.unpaid_break_seconds, 1800)
        # Seven and a half hours at $40, not eight.
        self.assertEqual(entry.labor_cost_cents, 30000)

    def test_an_employee_rate_change_recosts_against_the_break_rule(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)
        self.post_internal("import-labor", self.import_payload())
        employee_id = self.only_entry().employee_id

        response = self.post_internal(
            "set-employee-rate",
            {
                "employeeId": str(employee_id),
                "hourlyRateCents": 3000,
                "effectiveFrom": "2026-06-01",
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        self.assertEqual(self.only_entry().labor_cost_cents, 22500)

    def test_a_short_shift_keeps_every_minute(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)

        self.post_internal(
            "import-labor", self.import_payload(paid_seconds=FOUR_HOURS)
        )

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 0)
        self.assertEqual(entry.labor_cost_cents, 8000)

    def test_the_rule_is_rejected_outside_its_range(self):
        for field, value in (
            ("unpaidBreakMinutes", 481),
            ("unpaidBreakMinutes", -1),
            ("unpaidBreakPerHours", 0),
            ("unpaidBreakPerHours", 25),
        ):
            with self.subTest(field=field, value=value):
                response = self.post_internal(
                    "update-business-settings",
                    self.settings_payload(**{field: value}),
                )
                self.assertEqual(response.status_code, 400)

        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.unpaid_break_minutes, 0)
        self.assertEqual(row.unpaid_break_per_hours, 8)

    # --- the payroll tax ------------------------------------------------

    def test_the_payroll_tax_is_reported_without_touching_stored_cost(self):
        self.post_internal("import-labor", self.import_payload())

        self.save_settings(payrollTaxPercent=9.39)

        # The wage a shift stores is the wage. The burden is derived, so it
        # can never drift from the rate that produced it.
        self.assertEqual(self.only_entry().labor_cost_cents, 16000)
        summary = self.overview(start="2026-06-15", end="2026-06-15")["summary"]
        self.assertEqual(summary["totalLaborCostCents"], 16000)
        self.assertEqual(summary["payrollTaxCents"], 1502)

    def test_a_workspace_with_no_tax_set_reports_no_burden(self):
        self.post_internal("import-labor", self.import_payload())

        summary = self.overview(start="2026-06-15", end="2026-06-15")["summary"]
        self.assertEqual(summary["payrollTaxCents"], 0)

    def test_changing_the_rate_needs_no_backfill(self):
        self.post_internal("import-labor", self.import_payload())
        self.save_settings(payrollTaxPercent=9.39)
        self.save_settings(payrollTaxPercent=20)

        summary = self.overview(start="2026-06-15", end="2026-06-15")["summary"]
        self.assertEqual(summary["payrollTaxCents"], 3200)

    def test_the_rate_survives_two_decimal_places(self):
        self.save_settings(payrollTaxPercent=9.39)

        self.assertEqual(
            BenchCostSettings.objects.get(user=self.user).payroll_tax_bps, 939
        )
        self.assertEqual(
            self.get_internal("business-settings/").json()["payrollTaxPercent"],
            9.39,
        )

    def test_the_rate_is_rejected_outside_its_range(self):
        for value in (-1, 201):
            with self.subTest(value=value):
                response = self.post_internal(
                    "update-business-settings",
                    self.settings_payload(payrollTaxPercent=value),
                )
                self.assertEqual(response.status_code, 400)

    # --- what the two policies do to the rest of Labor ------------------

    def test_the_overview_reports_the_deduction_beside_clocked_hours(self):
        self.save_settings(unpaidBreakMinutes=30, unpaidBreakPerHours=8)
        self.post_internal("import-labor", self.import_payload())

        payload = self.overview(start="2026-06-15", end="2026-06-15")
        summary = payload["summary"]
        self.assertEqual(summary["totalSeconds"], EIGHT_HOURS)
        self.assertEqual(summary["unpaidBreakSeconds"], 1800)
        # The screen can name the rule behind the number it is showing.
        self.assertEqual(payload["policy"]["unpaidBreakMinutes"], 30)
        self.assertEqual(payload["policy"]["unpaidBreakPerHours"], 8)
        self.assertEqual(payload["employees"][0]["unpaidBreakSeconds"], 1800)

    def test_overtime_is_judged_on_payable_time(self):
        # A meal break is not time worked, so it must not push a cook over the
        # weekly threshold. The threshold here is one minute under the shift's
        # clocked length, and exactly the payable length once the rule applies.
        self.save_settings(
            overtimeWeeklyMinutes=EIGHT_HOURS // 60 - 1,
            unpaidBreakMinutes=0,
        )
        self.post_internal("import-labor", self.import_payload())
        flagged = self.overview(start="2026-06-15", end="2026-06-15")
        self.assertTrue(flagged["overtime"]["byEmployee"])

        self.save_settings(
            overtimeWeeklyMinutes=EIGHT_HOURS // 60 - 1,
            unpaidBreakMinutes=30,
            unpaidBreakPerHours=8,
        )

        cleared = self.overview(start="2026-06-15", end="2026-06-15")
        self.assertEqual(cleared["overtime"]["byEmployee"], {})

    def test_a_currency_change_that_also_moves_the_break_rule_recosts(self):
        # The two paths through update-business-settings write settings in
        # different places, and only one of them used to recost. A kitchen
        # switching currency and turning the break rule on in the same save
        # must not be left with shifts costing the old rule.
        self.post_internal("import-labor", self.import_payload())
        quote = {
            "source_currency": "USD",
            "target_currency": "EUR",
            "rate": Decimal("2"),
            "rate_date": date(2026, 8, 7),
            "provider": "test",
        }
        with patch(
            "forkluck.domains.workspace.actions.get_exchange_rate_quote",
            return_value=ExchangeRateQuote(**quote),
        ):
            response = self.post_internal(
                "update-business-settings",
                self.settings_payload(
                    currencyCode="EUR",
                    unpaidBreakMinutes=30,
                    unpaidBreakPerHours=8,
                    confirmCurrencyConversion=True,
                    quotedRate="2",
                    quotedRateDate="2026-08-07",
                ),
            )
        self.assertEqual(response.status_code, 200, response.content)

        entry = self.only_entry()
        self.assertEqual(entry.unpaid_break_seconds, 1800)
        # Seven and a half hours at the converted €40 rate.
        self.assertEqual(entry.hourly_rate_cents, 4000)
        self.assertEqual(entry.labor_cost_cents, 30000)

    def test_the_payroll_average_quotes_a_loaded_hour_of_payable_time(self):
        self.post_internal("import-labor", self.import_payload())
        self.save_settings(
            payrollTaxPercent=10, unpaidBreakMinutes=30, unpaidBreakPerHours=8
        )

        # $150.00 of wages plus 10% over 7.5 payable hours is $22/h — the
        # figure the "average labor rate" field is defined to hold. Dividing
        # by clocked hours instead would quote $20.63, an hour the kitchen
        # never actually buys.
        self.assertEqual(
            self.get_internal("business-settings/").json()[
                "payrollAverageRateCents"
            ],
            2200,
        )
