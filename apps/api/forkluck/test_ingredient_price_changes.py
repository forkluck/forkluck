from datetime import datetime, timezone as dt_timezone
from unittest.mock import patch

from .domains.ingredients.views import ingredient_price_changes
from .models import BenchCostSettings, Ingredient, IngredientPrice, User
from .testing import InternalApiTestCase, internal_payload


class IngredientPriceChangesTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(
            email="price-reader@example.test", password="test-password-123"
        )
        cls.other = User.objects.create_user(
            email="other-reader@example.test", password="test-password-123"
        )
        BenchCostSettings.objects.create(
            user=cls.user, currency_code="USD", timezone="America/New_York"
        )

    def setUp(self):
        self.client.force_login(self.user)
        self.clock = patch(
            "django.utils.timezone.now",
            return_value=datetime(2026, 9, 15, 16, tzinfo=dt_timezone.utc),
        )
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def ingredient(self, name, **kwargs):
        return Ingredient.objects.create(
            user=kwargs.pop("user", self.user),
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=100,
            **kwargs,
        )

    def price(self, ingredient, when, cents, size=1, unit="kg"):
        return IngredientPrice.objects.create(
            ingredient=ingredient,
            effective_at=datetime.fromisoformat(when),
            purchase_cost_cents=cents,
            purchase_size=size,
            purchase_unit=unit,
        )

    def read(self):
        return internal_payload(
            ingredient_price_changes,
            self.user,
            query={"start": "2026-08-01", "end": "2026-08-31"},
        )

    def test_normalizes_units_and_pack_sizes_in_a_constant_query_count(self):
        flour = self.ingredient("Flour")
        self.price(flour, "2026-07-20T12:00:00+00:00", 1000, 2, "kg")
        self.price(flour, "2026-08-10T12:00:00+00:00", 600, 1000, "g")
        self.price(flour, "2026-09-10T12:00:00+00:00", 9999)
        with self.assertNumQueries(
            3,
            msg="One zone read, one correlated ingredient snapshot and one currency read; no per-ingredient history queries.",
        ):
            result = self.read()
        self.assertEqual(
            result["items"],
            [
                {
                    "ingredientRef": flour.public_id,
                    "name": "Flour",
                    "unit": "kg",
                    "fromUnitCostCents": 500.0,
                    "toUnitCostCents": 600.0,
                    "deltaUnitCostCents": 100.0,
                    "percent": 20.0,
                }
            ],
        )
        for index in range(25):
            row = self.ingredient(f"Ingredient {index}")
            self.price(row, "2026-07-20T12:00:00+00:00", 100)
            self.price(row, "2026-08-10T12:00:00+00:00", 200)
        with self.assertNumQueries(
            3, msg="Adding ingredients must not introduce N+1 snapshot reads."
        ):
            result = self.read()
        self.assertEqual(len(result["items"]), 20)
        self.assertEqual(result["omitted"], 6)

    def test_separates_missing_history_incompatible_units_zero_and_unchanged_prices(
        self,
    ):
        missing = self.ingredient("New ingredient")
        self.price(missing, "2026-08-10T12:00:00+00:00", 100)
        mismatch = self.ingredient("Unknown density")
        self.price(mismatch, "2026-07-20T12:00:00+00:00", 100, unit="l")
        self.price(mismatch, "2026-08-10T12:00:00+00:00", 200, unit="kg")
        same = self.ingredient("Same unit price")
        self.price(same, "2026-07-20T12:00:00+00:00", 100, 1)
        self.price(same, "2026-08-10T12:00:00+00:00", 200, 2)
        zero = self.ingredient("Previously free")
        self.price(zero, "2026-07-20T12:00:00+00:00", 0)
        self.price(zero, "2026-08-10T12:00:00+00:00", 100)
        result = self.read()
        self.assertEqual(result["missingBaseline"], 1)
        self.assertEqual(result["incomparableUnits"], 1)
        self.assertEqual(result["observedIngredients"], 4)
        self.assertEqual(len(result["items"]), 1)
        self.assertIsNone(result["items"][0]["percent"])

    def test_calendar_boundaries_follow_the_kitchen_zone_and_exclude_foreign_archived_rows(
        self,
    ):
        row = self.ingredient("Local boundary")
        self.price(row, "2026-08-01T03:59:00+00:00", 100)
        self.price(row, "2026-08-01T04:00:00+00:00", 120)
        self.price(row, "2026-09-01T04:00:00+00:00", 900)
        for other in [
            self.ingredient("Private", user=self.other),
            self.ingredient("Archived", status="archived"),
        ]:
            self.price(other, "2026-07-20T12:00:00+00:00", 100)
            self.price(other, "2026-08-10T12:00:00+00:00", 500)
        result = self.read()
        self.assertEqual([item["name"] for item in result["items"]], ["Local boundary"])
        self.assertEqual(result["items"][0]["percent"], 20)

    def test_empty_data_is_explicit(self):
        result = self.read()
        self.assertEqual(result["observedIngredients"], 0)
        self.assertEqual(result["items"], [])

    def test_rejects_bad_repeated_reversed_and_future_periods(self):
        for query in [
            "",
            "start=20260801&end=2026-08-31",
            "start=2026-09-01&end=2026-08-31",
            "start=2026-08-01&end=2027-01-01",
            "start=2026-08-01&start=2026-08-02&end=2026-08-31",
            "start=2024-01-01&end=2026-08-31",
        ]:
            with self.subTest(query=query):
                self.assertEqual(
                    self.get_internal(f"ingredient-price-changes/?{query}").status_code,
                    400,
                )
