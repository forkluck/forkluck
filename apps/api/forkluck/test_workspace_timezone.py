from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from .domains.shared.workspace_timezone import known_zone, workspace_timezone_name
from .models import (
    BenchCostSettings,
    Employee,
    LaborImport,
    SalesImport,
    SalesLine,
    TimeEntry,
    User,
)


class WorkspaceTimezoneTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="zone@example.com",
            name="Zone Chef",
            password="a-long-test-passphrase-2468",
        )

    def add_sale(self, zone: str) -> None:
        sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
            timezone=zone,
        )
        SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            channel=SalesImport.Channel.SQUARE,
            source_position=1,
            source_fingerprint="fp-line-1",
            external_order_id="order-1",
            sold_at=timezone.now(),
            timezone=zone,
            item_name="Burger",
            quantity=Decimal("1"),
            gross_cents=1000,
            net_sales_cents=1000,
            tax_cents=0,
        )

    def add_shift(self, zone: str) -> None:
        labor_import = LaborImport.objects.create(
            user=self.user, file_name="hours.csv", timezone=zone
        )
        employee = Employee.objects.create(
            user=self.user, name="Baker", normalized_name="baker"
        )
        clock_in = timezone.now() - timedelta(days=1)
        TimeEntry.objects.create(
            user=self.user,
            employee=employee,
            labor_import=labor_import,
            source_position=1,
            source_fingerprint="fp-shift-1",
            clock_in=clock_in,
            clock_out=clock_in + timedelta(hours=6),
            paid_seconds=21600,
        )

    def test_a_workspace_with_nothing_reports_utc(self):
        self.assertEqual(workspace_timezone_name(self.user), "UTC")

    def test_the_newest_shift_answers_when_nothing_is_stored(self):
        self.add_shift("America/Chicago")
        self.assertEqual(workspace_timezone_name(self.user), "America/Chicago")

    def test_a_sale_outranks_a_shift(self):
        self.add_shift("America/Chicago")
        self.add_sale("Europe/Lisbon")
        self.assertEqual(workspace_timezone_name(self.user), "Europe/Lisbon")

    def test_a_stored_choice_outranks_both(self):
        self.add_shift("America/Chicago")
        self.add_sale("Europe/Lisbon")
        BenchCostSettings.objects.create(
            user=self.user, timezone="Asia/Tokyo", currency_code="USD"
        )
        self.assertEqual(workspace_timezone_name(self.user), "Asia/Tokyo")

    def test_a_stored_zone_this_build_cannot_resolve_falls_through(self):
        """A bad name must not reach ZoneInfo unguarded: it raises, and
        swallowing that would date rows against the host's calendar."""
        self.add_sale("Europe/Lisbon")
        BenchCostSettings.objects.create(
            user=self.user, timezone="Mars/Olympus_Mons", currency_code="USD"
        )
        self.assertEqual(workspace_timezone_name(self.user), "Europe/Lisbon")

    def test_another_workspace_is_not_consulted(self):
        other = User.objects.create_user(
            email="other@example.com",
            name="Other Chef",
            password="a-long-test-passphrase-1357",
        )
        self.add_sale("Europe/Lisbon")
        self.assertEqual(workspace_timezone_name(other), "UTC")

    def test_known_zone_rejects_offsets_and_blanks(self):
        self.assertIsNone(known_zone(""))
        self.assertIsNone(known_zone(None))
        self.assertIsNone(known_zone("+05:00"))
        self.assertIsNotNone(known_zone("America/New_York"))
