import json
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.conf import settings
from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from .integrations.exchange_rates import ExchangeRateError
from .models import (
    BenchCostRecipe,
    BenchCostSettings,
    CurrencyConversion,
    Ingredient,
    IngredientImport,
    IngredientImportItem,
    IngredientPrice,
    Recipe,
    SupplierItem,
    User,
)


TEST_RATES = (
    date(2026, 8, 7),
    {
        "EUR": Decimal("1"),
        "USD": Decimal("1.25"),
        "GBP": Decimal("0.875"),
        "CAD": Decimal("1.50"),
    },
)


class BusinessSettingsApiTests(TestCase):
    def setUp(self) -> None:
        self.client = Client()
        self.user = User.objects.create_user(
            email="settings@example.com",
            name="Settings Chef",
            password="a-long-test-passphrase-2468",
        )
        self.client.force_login(self.user)
        cache.clear()

    def get_settings(self):
        return self.client.get(
            "/internal/v1/business-settings/",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def update_settings(self, body: dict):
        return self.client.post(
            "/internal/v1/actions/update-business-settings/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def test_defaults_preserve_existing_metric_usd_behavior(self):
        response = self.get_settings()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "wagePerHourCents": 2000,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "labelRegion": "us",
                "foodCostTarget": 0.3,
                "overtimeWeeklyMinutes": 2400,
                "payrollTaxPercent": 0.0,
                "unpaidBreakMinutes": 0,
                "unpaidBreakPerHours": 8,
                "productMatching": True,
                "timezone": "UTC",
                "payrollAverageRateCents": None,
            },
        )

    def test_business_settings_can_be_updated_without_currency_conversion(self):
        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "us",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 200)
        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.wage_per_hour_cents, 3250)
        self.assertEqual(row.measurement_system, "us")
        self.assertEqual(row.currency_code, "USD")
        self.assertEqual(row.food_cost_target_bps, 3000)
        self.assertEqual(
            self.get_settings().json(),
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "us",
                "currencyCode": "USD",
                "labelRegion": "us",
                "foodCostTarget": 0.3,
                "overtimeWeeklyMinutes": 2400,
                "payrollTaxPercent": 0.0,
                "unpaidBreakMinutes": 0,
                "unpaidBreakPerHours": 8,
                "productMatching": True,
                "timezone": "UTC",
                "payrollAverageRateCents": None,
            },
        )

    def test_invalid_preferences_do_not_change_saved_settings(self):
        BenchCostSettings.objects.create(
            user=self.user,
            wage_per_hour_cents=2500,
            measurement_system="metric",
            currency_code="USD",
        )

        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "imperial",
                "currencyCode": "USD",
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 400)
        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.wage_per_hour_cents, 2500)
        self.assertEqual(row.measurement_system, "metric")
        self.assertEqual(row.currency_code, "USD")

    def test_food_cost_target_must_be_between_one_and_one_hundred_percent(self):
        row = BenchCostSettings.objects.create(user=self.user)

        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "foodCostTarget": 1.01,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 400)
        row.refresh_from_db()
        self.assertEqual(row.food_cost_target_bps, 3000)

    def test_overtime_threshold_is_saved_and_echoed_in_hours_of_minutes(self):
        response = self.update_settings(
            {
                "wagePerHourCents": 2000,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "overtimeWeeklyMinutes": 2250,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 200)
        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.overtime_weekly_minutes, 2250)
        self.assertEqual(self.get_settings().json()["overtimeWeeklyMinutes"], 2250)

    def test_omitting_the_overtime_threshold_keeps_the_saved_one(self):
        BenchCostSettings.objects.create(
            user=self.user,
            currency_code="USD",
            overtime_weekly_minutes=1800,
        )

        response = self.update_settings(
            {
                "wagePerHourCents": 2000,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 200)
        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.overtime_weekly_minutes, 1800)

    def test_out_of_range_overtime_threshold_changes_nothing(self):
        row = BenchCostSettings.objects.create(user=self.user, currency_code="USD")

        response = self.update_settings(
            {
                "wagePerHourCents": 2000,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "overtimeWeeklyMinutes": 10081,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Overtime threshold", response.json()["error"])
        row.refresh_from_db()
        self.assertEqual(row.overtime_weekly_minutes, 2400)

    def test_the_label_region_is_saved_and_echoed(self):
        response = self.update_settings(
            {
                "wagePerHourCents": 2000,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "labelRegion": "eu",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            BenchCostSettings.objects.get(user=self.user).label_region, "eu"
        )
        self.assertEqual(self.get_settings().json()["labelRegion"], "eu")

    def test_an_unknown_label_region_changes_nothing(self):
        row = BenchCostSettings.objects.create(user=self.user, currency_code="USD")

        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "labelRegion": "uk",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("label region", response.json()["error"])
        row.refresh_from_db()
        self.assertEqual(row.label_region, "")
        self.assertEqual(row.wage_per_hour_cents, 2000)

    def test_a_pound_or_euro_workspace_that_never_chose_reads_as_eu(self):
        row = BenchCostSettings.objects.create(user=self.user, currency_code="GBP")

        self.assertEqual(self.get_settings().json()["labelRegion"], "eu")

        row.currency_code = "EUR"
        row.save(update_fields=["currency_code"])
        self.assertEqual(self.get_settings().json()["labelRegion"], "eu")

        # A stored choice wins over the currency it disagrees with, either way.
        row.label_region = "eu"
        row.currency_code = "USD"
        row.save(update_fields=["label_region", "currency_code"])
        self.assertEqual(self.get_settings().json()["labelRegion"], "eu")
        row.label_region = "us"
        row.currency_code = "GBP"
        row.save(update_fields=["label_region", "currency_code"])
        self.assertEqual(self.get_settings().json()["labelRegion"], "us")

    @patch("forkluck.integrations.exchange_rates.get_ecb_daily_rates")
    def test_a_currency_conversion_keeps_the_label_region(self, download_rates):
        download_rates.return_value = TEST_RATES
        BenchCostSettings.objects.create(
            user=self.user,
            wage_per_hour_cents=2500,
            currency_code="USD",
            label_region="eu",
        )
        quote_response = self.client.post(
            "/internal/v1/actions/currency-conversion-quote/",
            data=json.dumps({"targetCurrency": "EUR", "expectedCurrencyCode": "USD"}),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        quote = quote_response.json()["quote"]

        response = self.update_settings(
            {
                "wagePerHourCents": 2500,
                "measurementSystem": "metric",
                "currencyCode": "EUR",
                "labelRegion": "eu",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
                "confirmCurrencyConversion": True,
                "quotedRate": quote["rate"],
                "quotedRateDate": quote["rateDate"],
            }
        )

        self.assertEqual(response.status_code, 200)
        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.currency_code, "EUR")
        self.assertEqual(row.label_region, "eu")

    def test_the_timezone_is_saved_and_echoed(self):
        response = self.update_settings(
            {
                "wagePerHourCents": 2000,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "timezone": "America/New_York",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            BenchCostSettings.objects.get(user=self.user).timezone,
            "America/New_York",
        )
        self.assertEqual(
            self.get_settings().json()["timezone"], "America/New_York"
        )

    def test_an_unknown_timezone_changes_nothing(self):
        row = BenchCostSettings.objects.create(
            user=self.user, currency_code="USD", timezone="America/New_York"
        )

        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "timezone": "Mars/Olympus_Mons",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Timezone", response.json()["error"])
        row.refresh_from_db()
        self.assertEqual(row.timezone, "America/New_York")

    def test_an_omitted_timezone_keeps_the_saved_one(self):
        BenchCostSettings.objects.create(
            user=self.user, currency_code="USD", timezone="Europe/Lisbon"
        )

        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "metric",
                "currencyCode": "USD",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
            }
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.get_settings().json()["timezone"], "Europe/Lisbon")

    @patch("forkluck.integrations.exchange_rates.get_ecb_daily_rates")
    def test_a_currency_conversion_keeps_the_timezone(self, download_rates):
        download_rates.return_value = TEST_RATES
        BenchCostSettings.objects.create(
            user=self.user,
            wage_per_hour_cents=2500,
            currency_code="USD",
            timezone="America/Chicago",
        )
        quote_response = self.client.post(
            "/internal/v1/actions/currency-conversion-quote/",
            data=json.dumps({"targetCurrency": "EUR", "expectedCurrencyCode": "USD"}),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        quote = quote_response.json()["quote"]

        response = self.update_settings(
            {
                "wagePerHourCents": 2500,
                "measurementSystem": "metric",
                "currencyCode": "EUR",
                "timezone": "America/Chicago",
                "foodCostTarget": 0.3,
                "expectedCurrencyCode": "USD",
                "confirmCurrencyConversion": True,
                "quotedRate": quote["rate"],
                "quotedRateDate": quote["rateDate"],
            }
        )

        self.assertEqual(response.status_code, 200)
        row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(row.currency_code, "EUR")
        self.assertEqual(row.timezone, "America/Chicago")

    @patch("forkluck.integrations.exchange_rates.get_ecb_daily_rates")
    def test_currency_change_converts_every_saved_amount_and_snapshots(
        self, download_rates
    ):
        download_rates.return_value = TEST_RATES
        BenchCostSettings.objects.create(
            user=self.user,
            wage_per_hour_cents=2500,
            measurement_system="metric",
            currency_code="USD",
        )
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Flour",
            normalized_name="flour",
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )
        history = IngredientPrice.objects.create(
            ingredient=ingredient,
            purchase_cost_cents=800,
            purchase_size=1,
            purchase_unit="kg",
            effective_at=timezone.now(),
        )
        supplier_item = SupplierItem.objects.create(
            user=self.user,
            ingredient=ingredient,
            supplier="supplier",
            external_id="sku-1",
            title="Flour",
            raw_size="1 kg",
            pack_price_cents=600,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Bread",
            body="1000 g Flour",
            menu_price_cents=1500,
        )
        cost_recipe = BenchCostRecipe.objects.create(
            user=self.user,
            recipe=recipe,
            name="Bread",
            ingredient_cost_cents=700,
            packaging_cost_cents=300,
            batch_yield=10,
        )
        ingredient_import = IngredientImport.objects.create(
            user=self.user,
            file_name="prices.xlsx",
        )
        import_item = IngredientImportItem.objects.create(
            ingredient_import=ingredient_import,
            position=0,
            operation=IngredientImportItem.Operation.UPDATED,
            supplier_before={"packPriceCents": 500},
            supplier_after={"packPriceCents": 600},
            ingredient_before={"packPriceCents": 900},
            ingredient_after={"packPriceCents": 1000},
        )

        quote_response = self.client.post(
            "/internal/v1/actions/currency-conversion-quote/",
            data=json.dumps(
                {
                    "targetCurrency": "EUR",
                    "expectedCurrencyCode": "USD",
                }
            ),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(quote_response.status_code, 200)
        quote = quote_response.json()["quote"]
        self.assertEqual(quote["rate"], "0.800000000000")
        self.assertEqual(quote["rateDate"], "2026-08-07")

        response = self.update_settings(
            {
                "wagePerHourCents": 3250,
                "measurementSystem": "us",
                "currencyCode": "EUR",
                "foodCostTarget": 0.4,
                "overtimeWeeklyMinutes": 2100,
                "expectedCurrencyCode": "USD",
                "confirmCurrencyConversion": True,
                "quotedRate": quote["rate"],
                "quotedRateDate": quote["rateDate"],
            }
        )

        self.assertEqual(response.status_code, 200)
        settings_row = BenchCostSettings.objects.get(user=self.user)
        self.assertEqual(settings_row.wage_per_hour_cents, 2600)
        self.assertEqual(settings_row.measurement_system, "us")
        self.assertEqual(settings_row.currency_code, "EUR")
        self.assertEqual(settings_row.food_cost_target_bps, 4000)
        self.assertEqual(settings_row.overtime_weekly_minutes, 2100)
        # A currency conversion rewrites this row; product matching is written
        # by its own action and must survive that save untouched.
        self.assertTrue(settings_row.product_auto_match_enabled)
        ingredient.refresh_from_db()
        history.refresh_from_db()
        supplier_item.refresh_from_db()
        recipe.refresh_from_db()
        cost_recipe.refresh_from_db()
        import_item.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 800)
        self.assertEqual(history.purchase_cost_cents, 640)
        self.assertEqual(supplier_item.pack_price_cents, 480)
        self.assertEqual(recipe.menu_price_cents, 1200)
        self.assertEqual(cost_recipe.ingredient_cost_cents, 560)
        self.assertEqual(cost_recipe.packaging_cost_cents, 240)
        self.assertEqual(import_item.supplier_before["packPriceCents"], 400)
        self.assertEqual(import_item.supplier_after["packPriceCents"], 480)
        self.assertEqual(import_item.ingredient_before["packPriceCents"], 720)
        self.assertEqual(import_item.ingredient_after["packPriceCents"], 800)
        conversion = CurrencyConversion.objects.get(user=self.user)
        self.assertEqual(conversion.source_currency, "USD")
        self.assertEqual(conversion.target_currency, "EUR")
        self.assertEqual(conversion.rate, Decimal("0.800000000000"))
        self.assertEqual(conversion.rate_date, date(2026, 8, 7))

    @patch("forkluck.integrations.exchange_rates.get_ecb_daily_rates")
    def test_unconfirmed_or_unavailable_conversion_changes_nothing(
        self, download_rates
    ):
        download_rates.return_value = TEST_RATES
        row = BenchCostSettings.objects.create(
            user=self.user,
            wage_per_hour_cents=2500,
            currency_code="USD",
        )

        response = self.update_settings(
            {
                "wagePerHourCents": 3000,
                "measurementSystem": "us",
                "currencyCode": "CAD",
                "foodCostTarget": 0.25,
                "expectedCurrencyCode": "USD",
            }
        )
        self.assertEqual(response.status_code, 400)
        row.refresh_from_db()
        self.assertEqual(row.wage_per_hour_cents, 2500)
        self.assertEqual(row.measurement_system, "metric")
        self.assertEqual(row.currency_code, "USD")
        self.assertEqual(row.food_cost_target_bps, 3000)

        cache.clear()
        download_rates.side_effect = ExchangeRateError("rate service unavailable")
        quote_response = self.client.post(
            "/internal/v1/actions/currency-conversion-quote/",
            data=json.dumps(
                {
                    "targetCurrency": "CAD",
                    "expectedCurrencyCode": "USD",
                }
            ),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )
        self.assertEqual(quote_response.status_code, 400)
        row.refresh_from_db()
        self.assertEqual(row.currency_code, "USD")
