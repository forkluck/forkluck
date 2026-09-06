"""Every persisted money field is accounted for by a currency change.

The invariant, checked here for the whole schema rather than per feature:

    Every persisted *_cents field either belongs to a record that carries its
    own currency code, or is denominated in the workspace currency and is
    restated by convert_workspace_currency.

Conversion previously covered ingredient prices, price history, supplier items,
menu prices, bench costs and the wage, but not invoices, labour or sales. The
labour fields were workspace-native and simply missing, so a currency change
left every labour percentage wrong. Invoices and sales are third-party records
and must *not* be restated — they carry their own code instead.

The buckets below are the full inventory. A new money column that is added to
none of them fails test_every_money_field_is_classified, so this stays honest
as the schema grows.
"""

from datetime import date, datetime, timezone as datetime_timezone
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps as django_apps
from django.test import TestCase

from .domains.sales.core import sales_overview_payload, unmatched_group_rows
from .domains.workspace.currency import convert_workspace_currency
from .integrations.exchange_rates import ExchangeRateQuote
from .models import (
    BenchCostRecipe,
    BenchCostSettings,
    Employee,
    EmployeeHourlyRate,
    Ingredient,
    IngredientPrice,
    Invoice,
    InvoiceLine,
    LaborImport,
    Menu,
    MenuItem,
    Recipe,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesProduct,
    SupplierItem,
    TimeEntry,
    User,
)


# Money the workspace owns. Denominated in the workspace currency, restated
# when it changes.
WORKSPACE_MONEY: dict[str, tuple[str, ...]] = {
    "Ingredient": ("purchase_cost_cents",),
    "IngredientPrice": ("purchase_cost_cents",),
    "SupplierItem": ("pack_price_cents",),
    "Recipe": ("menu_price_cents",),
    "SalesProduct": ("sell_price_cents",),
    "BenchCostRecipe": ("ingredient_cost_cents", "packaging_cost_cents"),
    "BenchCostSettings": ("wage_per_hour_cents",),
    "EmployeeHourlyRate": ("hourly_rate_cents",),
    "TimeEntry": (
        "hourly_rate_override_cents",
        "hourly_rate_cents",
        "labor_cost_cents",
        "earnings_adjustment_cents",
    ),
    "LaborImport": ("total_labor_cost_cents",),
    "MenuItem": (
        "sell_price_cents",
        "original_sell_price_cents",
        "original_food_cost_cents",
    ),
}

# Money on a third-party record: what a supplier billed or a POS took. Carries
# its own currency code and is never restated.
DOCUMENT_MONEY: dict[str, tuple[str, ...]] = {
    "Invoice": ("total_cents", "tax_cents", "subtotal_cents"),
    "InvoiceLine": ("unit_price_cents", "line_amount_cents"),
    "SalesImport": (
        "gross_cents",
        "discount_cents",
        "net_sales_cents",
        "tax_cents",
        "refund_cents",
    ),
    "SalesLine": (
        "gross_cents",
        "discount_cents",
        "net_sales_cents",
        "tax_cents",
        "refund_cents",
    ),
    "SalesModifierOption": ("price_cents",),
    "SalesLineModifier": ("base_price_cents", "total_price_cents"),
}

# The shared master price catalog is global, not per workspace: it is USD
# reference data that every workspace reads and none owns, so it is neither
# converted nor stamped per record.
GLOBAL_CATALOG_MONEY: dict[str, tuple[str, ...]] = {
    "CatalogProduct": ("pack_price_cents",),
    "CatalogPriceObservation": ("pack_price_cents",),
}

# Records that carry their own code, and where SalesLineModifier reads it from.
CARRIES_OWN_CURRENCY = {
    "Invoice",
    "InvoiceLine",
    "SalesImport",
    "SalesLine",
    "SalesModifierOption",
}


def money_fields_in_schema() -> dict[str, tuple[str, ...]]:
    found: dict[str, tuple[str, ...]] = {}
    for model in django_apps.get_app_config("forkluck").get_models():
        names = tuple(
            field.name
            for field in model._meta.get_fields()
            if getattr(field, "attname", None) and field.name.endswith("_cents")
        )
        if names:
            found[model.__name__] = names
    return found


class MoneyInventoryTests(TestCase):
    def test_every_money_field_is_classified(self):
        # The guard that keeps this file honest: a new *_cents column has to be
        # placed in one of the three buckets, which forces the author to decide
        # whether it is restated, stamped, or global reference data.
        classified = {
            model: set(fields)
            for bucket in (WORKSPACE_MONEY, DOCUMENT_MONEY, GLOBAL_CATALOG_MONEY)
            for model, fields in bucket.items()
        }
        for model, fields in money_fields_in_schema().items():
            with self.subTest(model=model):
                self.assertIn(
                    model,
                    classified,
                    f"{model} has money fields {fields} but is in no bucket",
                )
                self.assertEqual(
                    set(fields),
                    classified[model],
                    f"{model}'s money fields changed; classify them",
                )

    def test_document_money_records_carry_a_currency_code(self):
        for model_name in CARRIES_OWN_CURRENCY:
            with self.subTest(model=model_name):
                model = django_apps.get_model("forkluck", model_name)
                self.assertIn(
                    "currency_code",
                    {field.name for field in model._meta.get_fields()},
                    f"{model_name} holds money it does not restate, so it must "
                    "say what currency that money is in",
                )

    def test_sales_line_modifiers_inherit_their_line_s_currency(self):
        # The one document-money model without its own column: it is a child of
        # SalesLine and has no independent existence, so the line's code
        # governs. Pinned because adding a column later must be a decision.
        model = django_apps.get_model("forkluck", "SalesLineModifier")
        self.assertNotIn(
            "currency_code", {field.name for field in model._meta.get_fields()}
        )
        self.assertIn(
            "sales_line", {field.name for field in model._meta.get_fields()}
        )


class ConversionCoverageTests(TestCase):
    """Populate every money field, convert, and check what moved."""

    RATE = Decimal("2")

    def setUp(self):
        self.user = User.objects.create_user(
            email="currency@example.com",
            name="Currency Chef",
            password="a-long-test-passphrase-2468",
        )
        self.settings_row, _ = BenchCostSettings.objects.get_or_create(
            user=self.user
        )
        BenchCostSettings.objects.filter(pk=self.settings_row.pk).update(
            currency_code="USD", wage_per_hour_cents=2000
        )
        self.settings_row.refresh_from_db()
        self.build_fixture()

    def build_fixture(self):
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Flour",
            normalized_name="flour",
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )
        self.price = IngredientPrice.objects.create(
            ingredient=self.ingredient,
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
            effective_at=datetime(2026, 6, 1, tzinfo=datetime_timezone.utc),
        )
        self.supplier_item = SupplierItem.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            supplier="harbor",
            external_id="FLR1",
            pack_price_cents=1000,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
        )
        self.recipe = Recipe.objects.create(
            user=self.user, title="Bread", menu_price_cents=1000
        )
        self.product = SalesProduct.objects.create(
            user=self.user,
            name="Bread product",
            normalized_name="bread product",
            sell_price_cents=1200,
        )
        self.cost = BenchCostRecipe.objects.create(
            user=self.user,
            recipe=self.recipe,
            name="Bread",
            batch_yield=1,
            ingredient_cost_cents=1000,
            packaging_cost_cents=500,
        )

        self.menu = Menu.objects.create(user=self.user, name="Spring")
        self.menu_item = MenuItem.objects.create(
            menu=self.menu,
            position=0,
            name="Bread",
            sell_price_cents=1000,
            qty_sold=Decimal("3"),
            original_sell_price_cents=1000,
            original_qty_sold=Decimal("3"),
            original_food_cost_cents=400,
            recipe=self.recipe,
        )
        # A row whose links were uncosted when it was created: the snapshot is
        # null and must stay null through a conversion.
        self.uncosted_menu_item = MenuItem.objects.create(
            menu=self.menu,
            position=1,
            name="Mystery",
            sell_price_cents=500,
            qty_sold=Decimal("1"),
            original_sell_price_cents=500,
            original_qty_sold=Decimal("1"),
            original_food_cost_cents=None,
        )

        self.employee = Employee.objects.create(
            user=self.user, name="Alex Baker", normalized_name="alex baker"
        )
        self.rate = EmployeeHourlyRate.objects.create(
            employee=self.employee,
            hourly_rate_cents=2000,
            effective_from=date(2026, 6, 1),
        )
        self.labor_import = LaborImport.objects.create(
            user=self.user,
            file_name="hours.csv",
            source="csv",
            timezone="America/New_York",
            mapping={},
            period_start=date(2026, 6, 1),
            period_end=date(2026, 6, 30),
            total_rows=1,
            total_labor_cost_cents=16000,
        )
        self.time_entry = TimeEntry.objects.create(
            user=self.user,
            employee=self.employee,
            labor_import=self.labor_import,
            source_position=0,
            source_fingerprint="tfp-1",
            clock_in=datetime(2026, 6, 15, 12, tzinfo=datetime_timezone.utc),
            clock_out=datetime(2026, 6, 15, 20, tzinfo=datetime_timezone.utc),
            paid_seconds=28800,
            hourly_rate_override_cents=1500,
            hourly_rate_cents=2000,
            labor_cost_cents=16000,
            earnings_adjustment_cents=500,
        )

        self.invoice = Invoice.objects.create(
            user=self.user,
            supplier="harbor",
            supplier_name="Harbor",
            currency_code="USD",
            total_cents=100000,
            source_fingerprint="fp-1",
            file_name="inv.pdf",
        )
        self.invoice_line = InvoiceLine.objects.create(
            user=self.user,
            invoice=self.invoice,
            currency_code="USD",
            position=0,
            description="Carrots",
            unit_price_cents=500,
            line_amount_cents=100000,
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="sales.csv",
            channel=SalesImport.Channel.SQUARE,
            timezone="America/New_York",
            currency_code="USD",
            period_start=date(2026, 6, 1),
            period_end=date(2026, 6, 30),
            total_rows=1,
            gross_cents=800,
            discount_cents=100,
            net_sales_cents=700,
            tax_cents=62,
            refund_cents=0,
        )
        self.sales_line = SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            channel=SalesImport.Channel.SQUARE,
            source_position=0,
            source_fingerprint="sfp-1",
            external_order_id="payment-1",
            item_name="Espresso",
            sold_at=datetime(2026, 6, 15, 13, tzinfo=datetime_timezone.utc),
            currency_code="USD",
            quantity=Decimal("2"),
            gross_cents=800,
            discount_cents=100,
            net_sales_cents=700,
            tax_cents=62,
            refund_cents=0,
        )

    def convert(self, target="EUR"):
        quote = ExchangeRateQuote(
            source_currency="USD",
            target_currency=target,
            rate=self.RATE,
            rate_date=date(2026, 8, 7),
            provider="test",
        )
        with patch(
            "forkluck.domains.workspace.currency.convert_cents",
            lambda value, rate: int(value * rate),
        ):
            return convert_workspace_currency(
                user=self.user,
                quote=quote,
                wage_per_hour_cents=self.settings_row.wage_per_hour_cents,
                measurement_system=self.settings_row.measurement_system,
                label_region=self.settings_row.label_region,
                food_cost_target_bps=self.settings_row.food_cost_target_bps,
                overtime_weekly_minutes=self.settings_row.overtime_weekly_minutes,
                timezone_name=self.settings_row.timezone,
                payroll_tax_bps=self.settings_row.payroll_tax_bps,
                unpaid_break_minutes=self.settings_row.unpaid_break_minutes,
                unpaid_break_per_hours=self.settings_row.unpaid_break_per_hours,
                )

    def convert_with_real_rounding(self, rate: Decimal):
        quote = ExchangeRateQuote(
            source_currency="USD",
            target_currency="EUR",
            rate=rate,
            rate_date=date(2026, 8, 7),
            provider="test",
        )
        return convert_workspace_currency(
            user=self.user,
            quote=quote,
            wage_per_hour_cents=self.settings_row.wage_per_hour_cents,
            measurement_system=self.settings_row.measurement_system,
            label_region=self.settings_row.label_region,
            food_cost_target_bps=self.settings_row.food_cost_target_bps,
            overtime_weekly_minutes=self.settings_row.overtime_weekly_minutes,
            timezone_name=self.settings_row.timezone,
            payroll_tax_bps=self.settings_row.payroll_tax_bps,
            unpaid_break_minutes=self.settings_row.unpaid_break_minutes,
            unpaid_break_per_hours=self.settings_row.unpaid_break_per_hours,
        )

    def test_workspace_money_is_restated(self):
        self.convert()

        expected = {
            self.ingredient: {"purchase_cost_cents": 2000},
            self.price: {"purchase_cost_cents": 2000},
            self.supplier_item: {"pack_price_cents": 2000},
            self.recipe: {"menu_price_cents": 2000},
            self.product: {"sell_price_cents": 2400},
            self.cost: {
                "ingredient_cost_cents": 2000,
                "packaging_cost_cents": 1000,
            },
            self.rate: {"hourly_rate_cents": 4000},
            self.time_entry: {
                "hourly_rate_override_cents": 3000,
                "hourly_rate_cents": 4000,
                "labor_cost_cents": 32000,
                "earnings_adjustment_cents": 1000,
            },
            self.labor_import: {"total_labor_cost_cents": 32000},
            self.menu_item: {
                "sell_price_cents": 2000,
                "original_sell_price_cents": 2000,
                "original_food_cost_cents": 800,
            },
            self.uncosted_menu_item: {
                "sell_price_cents": 1000,
                "original_sell_price_cents": 1000,
                "original_food_cost_cents": None,
            },
        }
        for row, fields in expected.items():
            row.refresh_from_db()
            for field, value in fields.items():
                with self.subTest(model=type(row).__name__, field=field):
                    self.assertEqual(getattr(row, field), value)

        self.settings_row.refresh_from_db()
        self.assertEqual(self.settings_row.wage_per_hour_cents, 4000)
        self.assertEqual(self.settings_row.currency_code, "EUR")

    def test_conversion_takes_the_workspace_write_lock(self):
        with patch(
            "forkluck.domains.workspace.currency.lock_workspace"
        ) as workspace_lock:
            self.convert()

        workspace_lock.assert_called_once_with(self.user)

    def test_document_money_is_left_exactly_as_recorded(self):
        self.convert()

        for row, fields in {
            self.invoice: {"total_cents": 100000},
            self.invoice_line: {
                "unit_price_cents": 500,
                "line_amount_cents": 100000,
            },
            self.sales_import: {"gross_cents": 800, "net_sales_cents": 700},
            self.sales_line: {"gross_cents": 800, "net_sales_cents": 700},
        }.items():
            row.refresh_from_db()
            for field, value in fields.items():
                with self.subTest(model=type(row).__name__, field=field):
                    self.assertEqual(
                        getattr(row, field),
                        value,
                        "third-party amounts must not be restated",
                    )
            self.assertEqual(
                row.currency_code,
                "USD",
                "and must keep pointing at the currency they were recorded in",
            )

    def test_every_workspace_money_field_is_named_in_the_receipt(self):
        # The conversion receipt is what the confirmation dialog describes, so
        # a field converted without being counted would under-report the change.
        conversion = self.convert()
        counted = set(conversion.converted_counts)

        for model, fields in WORKSPACE_MONEY.items():
            if model == "BenchCostSettings":
                self.assertIn("wage_per_hour_cents", counted)
                continue
            for field in fields:
                with self.subTest(model=model, field=field):
                    self.assertTrue(
                        any(
                            key.endswith(f".{field}") and conversion.converted_counts[key]
                            for key in counted
                        ),
                        f"{model}.{field} was converted but not counted",
                    )

    def test_converting_back_returns_the_original_amounts(self):
        self.convert("EUR")
        # Rate 1/2 back to USD.
        quote = ExchangeRateQuote(
            source_currency="EUR",
            target_currency="USD",
            rate=Decimal("0.5"),
            rate_date=date(2026, 8, 8),
            provider="test",
        )
        with patch(
            "forkluck.domains.workspace.currency.convert_cents",
            lambda value, rate: int(value * rate),
        ):
            convert_workspace_currency(
                user=self.user,
                quote=quote,
                wage_per_hour_cents=4000,
                measurement_system=self.settings_row.measurement_system,
                label_region=self.settings_row.label_region,
                food_cost_target_bps=self.settings_row.food_cost_target_bps,
                overtime_weekly_minutes=self.settings_row.overtime_weekly_minutes,
                timezone_name=self.settings_row.timezone,
                payroll_tax_bps=self.settings_row.payroll_tax_bps,
                unpaid_break_minutes=self.settings_row.unpaid_break_minutes,
                unpaid_break_per_hours=self.settings_row.unpaid_break_per_hours,
                )

        self.time_entry.refresh_from_db()
        self.rate.refresh_from_db()
        self.labor_import.refresh_from_db()
        self.assertEqual(self.time_entry.labor_cost_cents, 16000)
        self.assertEqual(self.time_entry.hourly_rate_override_cents, 1500)
        self.assertEqual(self.rate.hourly_rate_cents, 2000)
        self.assertEqual(self.labor_import.total_labor_cost_cents, 16000)
        self.menu_item.refresh_from_db()
        self.assertEqual(self.menu_item.sell_price_cents, 1000)
        self.assertEqual(self.menu_item.original_sell_price_cents, 1000)
        self.assertEqual(self.menu_item.original_food_cost_cents, 400)

    def test_another_workspace_is_untouched(self):
        other = User.objects.create_user(
            email="bystander@example.com",
            name="Bystander",
            password="a-long-test-passphrase-1357",
        )
        other_employee = Employee.objects.create(
            user=other, name="Sam", normalized_name="sam"
        )
        other_rate = EmployeeHourlyRate.objects.create(
            employee=other_employee,
            hourly_rate_cents=2500,
            effective_from=date(2026, 6, 1),
        )

        other_menu = Menu.objects.create(user=other, name="Their menu")
        other_item = MenuItem.objects.create(
            menu=other_menu,
            position=0,
            name="Their scone",
            sell_price_cents=2500,
            original_sell_price_cents=2500,
            original_food_cost_cents=900,
        )

        self.convert()

        other_rate.refresh_from_db()
        self.assertEqual(other_rate.hourly_rate_cents, 2500)
        other_item.refresh_from_db()
        self.assertEqual(other_item.sell_price_cents, 2500)
        self.assertEqual(other_item.original_food_cost_cents, 900)

    def test_negative_labor_adjustments_convert_without_becoming_positive(self):
        self.time_entry.earnings_adjustment_cents = -500
        self.time_entry.labor_cost_cents = -100
        self.time_entry.save(
            update_fields=[
                "earnings_adjustment_cents",
                "labor_cost_cents",
                "updated_at",
            ]
        )

        self.convert_with_real_rounding(Decimal("2"))

        self.time_entry.refresh_from_db()
        self.assertEqual(self.time_entry.earnings_adjustment_cents, -1000)
        self.assertEqual(self.time_entry.labor_cost_cents, -200)

    def test_import_totals_are_recomputed_after_entry_level_rounding(self):
        self.time_entry.labor_cost_cents = 1
        self.time_entry.earnings_adjustment_cents = 0
        self.time_entry.save(
            update_fields=[
                "labor_cost_cents",
                "earnings_adjustment_cents",
                "updated_at",
            ]
        )
        TimeEntry.objects.create(
            user=self.user,
            employee=self.employee,
            labor_import=self.labor_import,
            source_position=1,
            source_fingerprint="tfp-2",
            clock_in=datetime(2026, 6, 16, 12, tzinfo=datetime_timezone.utc),
            clock_out=datetime(2026, 6, 16, 13, tzinfo=datetime_timezone.utc),
            paid_seconds=3600,
            hourly_rate_cents=1,
            labor_cost_cents=1,
            earnings_adjustment_cents=0,
        )
        self.labor_import.total_labor_cost_cents = 2
        self.labor_import.save(
            update_fields=["total_labor_cost_cents", "updated_at"]
        )

        self.convert_with_real_rounding(Decimal("0.5"))

        self.labor_import.refresh_from_db()
        self.assertEqual(
            list(
                TimeEntry.objects.filter(labor_import=self.labor_import)
                .order_by("source_position")
                .values_list("labor_cost_cents", flat=True)
            ),
            [1, 1],
        )
        self.assertEqual(self.labor_import.total_labor_cost_cents, 2)

    def test_undone_import_retains_and_converts_its_cached_total(self):
        self.time_entry.delete()
        self.labor_import.undone_at = datetime(
            2026, 7, 1, tzinfo=datetime_timezone.utc
        )
        self.labor_import.save(update_fields=["undone_at", "updated_at"])

        self.convert_with_real_rounding(Decimal("2"))

        self.labor_import.refresh_from_db()
        self.assertEqual(self.labor_import.total_labor_cost_cents, 32000)

    def test_an_active_import_total_survives_the_32_bit_boundary(self):
        # Shift costs are a 32-bit column but the cached import total is a
        # BigInteger, and a whole import sums past 2^31 in a weak currency.
        # No backend truncates this today, so this pins the invariant rather
        # than reproducing a defect: it fails if a future annotation, backend
        # or Django version starts narrowing the sum to its source width.
        near_ceiling = 2_000_000_000
        self.time_entry.labor_cost_cents = near_ceiling
        self.time_entry.earnings_adjustment_cents = 0
        self.time_entry.save(
            update_fields=[
                "labor_cost_cents",
                "earnings_adjustment_cents",
                "updated_at",
            ]
        )
        TimeEntry.objects.create(
            user=self.user,
            employee=self.employee,
            labor_import=self.labor_import,
            source_position=1,
            source_fingerprint="tfp-big",
            clock_in=datetime(2026, 6, 16, 12, tzinfo=datetime_timezone.utc),
            clock_out=datetime(2026, 6, 16, 13, tzinfo=datetime_timezone.utc),
            paid_seconds=3600,
            hourly_rate_cents=1,
            labor_cost_cents=near_ceiling,
            earnings_adjustment_cents=0,
        )

        self.convert_with_real_rounding(Decimal("1"))

        self.labor_import.refresh_from_db()
        total = 2 * near_ceiling
        self.assertGreater(total, 2**31 - 1)
        self.assertEqual(self.labor_import.total_labor_cost_cents, total)


class ReadSideCurrencyTests(TestCase):
    """The write side keeps foreign rows honest; the read side must too.

    Document money is never restated, so a workspace that connected a
    foreign-currency POS or changed its own currency holds sales and invoices in
    more than one code. Every one-figure section of the overview therefore names
    the currency it reports and counts only rows recorded in it — otherwise the
    prime-cost ratio divides one currency by another.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            email="read-currency@example.com",
            name="Read Chef",
            password="a-long-test-passphrase-1357",
        )
        BenchCostSettings.objects.update_or_create(
            user=self.user, defaults={"currency_code": "USD"}
        )
        self.sales_import = SalesImport.objects.create(
            user=self.user,
            file_name="mixed.csv",
            channel=SalesImport.Channel.SQUARE,
            timezone="UTC",
            currency_code="USD",
        )
        self.make_line("USD", 1000, "usd-line", 0)
        self.make_line("GBP", 4000, "gbp-line", 1)
        for code, cents, fingerprint in (
            ("USD", 30000, "inv-usd"),
            ("GBP", 90000, "inv-gbp"),
        ):
            Invoice.objects.create(
                user=self.user,
                supplier="harbor",
                supplier_name="Harbor",
                currency_code=code,
                total_cents=cents,
                invoice_date=date(2026, 6, 15),
                source_fingerprint=fingerprint,
                file_name=f"{fingerprint}.pdf",
            )

    def make_line(
        self, currency_code: str, cents: int, key: str, position: int
    ) -> None:
        product = SalesProduct.objects.create(
            user=self.user, name=key, normalized_name=key
        )
        variant = SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel=SalesImport.Channel.SQUARE,
            match_key=f"sku:{key}",
            external_name=key,
        )
        SalesLine.objects.create(
            user=self.user,
            sales_import=self.sales_import,
            product=product,
            variant=variant,
            channel=SalesImport.Channel.SQUARE,
            source_position=position,
            source_fingerprint=key,
            external_order_id=key,
            item_name=key,
            group_key=variant.match_key,
            sold_at=datetime(2026, 6, 15, 13, tzinfo=datetime_timezone.utc),
            timezone="UTC",
            currency_code=currency_code,
            quantity=Decimal("1"),
            gross_cents=cents,
            net_sales_cents=cents,
        )

    def overview(self):
        return sales_overview_payload(self.user)

    def test_summary_reports_only_the_workspace_currency_and_says_so(self):
        summary = self.overview()["summary"]

        self.assertEqual(summary["currencyCode"], "USD")
        self.assertEqual(summary["netSalesCents"], 1000)
        self.assertEqual(summary["lineCount"], 1)
        self.assertEqual(summary["excludedLineCount"], 1)

    def test_trend_reports_only_the_workspace_currency(self):
        trend = self.overview()["netSalesTrend"]

        self.assertEqual(trend["currencyCode"], "USD")
        self.assertEqual(
            sum(row["currentSquareCents"] for row in trend["hours"]), 1000
        )

    def test_prime_cost_invoices_are_one_currency(self):
        financials = self.overview()["netSalesTrend"]["financials"]

        self.assertEqual(financials["currentInvoiceCents"], 30000)
        self.assertEqual(financials["currentInvoiceCount"], 1)

    def test_pending_scope_excludes_foreign_currency_identities(self):
        # Detaching leaves both lines pending, one in each currency.
        SalesLine.objects.filter(user=self.user).update(variant=None, product=None)

        scope = self.overview()["scope"]

        self.assertEqual(scope["currencyCode"], "USD")
        self.assertEqual(scope["pendingSkuCount"], 1)
        self.assertEqual(scope["pendingNetSalesCents"], 1000)
        self.assertEqual(scope["excludedSkuCount"], 1)

    def test_per_identity_rows_carry_their_own_currency(self):
        SalesLine.objects.filter(user=self.user).update(variant=None, product=None)

        by_key = {
            row["agg_currency_code"]: row for row in unmatched_group_rows(self.user)
        }

        self.assertEqual(set(by_key), {"USD", "GBP"})
        self.assertEqual(by_key["GBP"]["agg_net_sales_cents"], 4000)
