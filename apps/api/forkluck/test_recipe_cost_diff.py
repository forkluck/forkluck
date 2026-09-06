"""Temporal recipe-cost contract and authorization invariants."""

import json
from datetime import datetime, timezone as datetime_timezone
from decimal import Decimal
from unittest.mock import patch

from django.test import RequestFactory, TestCase

from .domains.recipes.health import catalog_measure_sources
from .domains.recipes.views import recipe_cost_diff
from .models import (
    Ingredient,
    IngredientConversion,
    IngredientMeasure,
    IngredientPrice,
    Preparation,
    Recipe,
    RecipeEquivalency,
    RecipeItem,
    RecipeShare,
    User,
)
from .testing import InternalApiTestCase


UTC = datetime_timezone.utc
NOW = datetime(2026, 8, 24, 18, 30, tzinfo=UTC)


class RecipeCostDiffTests(TestCase):
    def setUp(self) -> None:
        self.owner = User.objects.create_user(
            email="primo-owner@example.com", name="Owner", password="pass"
        )
        self.other = User.objects.create_user(
            email="primo-other@example.com", name="Other", password="pass"
        )
        self.ingredient = Ingredient.objects.create(
            user=self.owner,
            name="Butter",
            purchase_cost_cents=200,
            purchase_size=Decimal("1000"),
            purchase_unit="g",
        )
        self.old_price = self.price(100, datetime(2026, 4, 1, tzinfo=UTC))
        self.current_price = self.price(200, datetime(2026, 8, 10, tzinfo=UTC))
        self.recipe = Recipe.objects.create(
            user=self.owner,
            title="Butter cake",
            yield_amount=1,
            yield_unit="pcs",
        )
        self.line = RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
            position=0,
        )
        catalog_measure_sources()

    def price(self, cents: int, effective_at: datetime) -> IngredientPrice:
        return IngredientPrice.objects.create(
            ingredient=self.ingredient,
            purchase_cost_cents=cents,
            purchase_size=Decimal("1000"),
            purchase_unit="g",
            effective_at=effective_at,
        )

    def request(self, *, user=None, query: str = ""):
        request = RequestFactory().get(f"/{query}")
        request.user = user or self.owner
        with patch("django.utils.timezone.now", return_value=NOW):
            return recipe_cost_diff(request, self.recipe.public_id)

    def payload(self, **kwargs):
        response = self.request(**kwargs)
        self.assertEqual(response.status_code, 200)
        return json.loads(response.content)["item"]

    def test_default_window_is_ninety_calendar_days_from_midnight_utc(self):
        payload = self.payload()
        self.assertEqual(
            payload["window"],
            {
                "fromAt": "2026-05-26T00:00:00+00:00",
                "toAt": "2026-08-24T18:30:00+00:00",
                "fromDate": "2026-05-26",
                "toDate": "2026-08-24",
                "days": 90,
                "source": "default90Days",
                "comparison": "priceOnlyCurrentRecipeBasis",
            },
        )
        self.assertEqual(payload["totals"]["fromCents"], 10)
        self.assertEqual(payload["totals"]["toCents"], 20)
        self.assertEqual(payload["totals"]["deltaCents"], 10)
        self.assertEqual(payload["priceChangesInWindow"], 1)

    def test_explicit_start_is_validated_and_reported(self):
        payload = self.payload(query="?from=2026-01-01")
        self.assertEqual(payload["window"]["fromAt"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(payload["window"]["source"], "requestedDate")
        for raw in ("2026-1-1", "not-a-date", "2026-08-25"):
            response = self.request(query=f"?from={raw}")
            self.assertEqual(response.status_code, 400, raw)
        self.assertEqual(
            self.request(query="?from=2026-01-01&from=2026-02-01").status_code,
            400,
        )
        self.assertEqual(
            self.request(query="?from=2026-01-01&to=2026-08-01").status_code,
            400,
        )

    def test_empty_window_reports_the_latest_earlier_change(self):
        payload = self.payload(query="?from=2026-08-20")
        self.assertEqual(payload["priceChangesInWindow"], 0)
        self.assertEqual(
            payload["lastChangeBeforeWindow"],
            {
                "at": "2026-08-10T00:00:00+00:00",
                "ingredient": {
                    "publicId": self.ingredient.public_id,
                    "name": "Butter",
                },
            },
        )

    def test_empty_window_without_any_earlier_observation_reports_null(self):
        IngredientPrice.objects.all().delete()

        payload = self.payload(query="?from=2026-08-20")

        self.assertEqual(payload["priceChangesInWindow"], 0)
        self.assertIsNone(payload["lastChangeBeforeWindow"])
        self.assertFalse(payload["totals"]["fromComplete"])
        self.assertFalse(payload["totals"]["toComplete"])

    def test_effective_date_not_insert_order_controls_exact_boundaries(self):
        IngredientPrice.objects.all().delete()
        self.price(100, datetime(2026, 5, 1, tzinfo=UTC))
        self.price(120, datetime(2026, 6, 1, tzinfo=UTC))
        self.price(150, NOW)
        self.price(999, datetime(2026, 8, 25, tzinfo=UTC))

        payload = self.payload(query="?from=2026-06-01")

        self.assertEqual(payload["totals"]["fromCents"], 12)
        self.assertEqual(payload["totals"]["toCents"], 15)
        # The start boundary supplies the starting price but is not an event;
        # the exact end boundary is both selected and counted. The row inserted
        # last but effective after toAt is irrelevant.
        self.assertEqual(payload["priceChangesInWindow"], 1)
        self.assertEqual(
            payload["lines"][0]["from"]["effectiveAt"],
            "2026-06-01T00:00:00+00:00",
        )
        self.assertEqual(
            payload["lines"][0]["to"]["effectiveAt"],
            "2026-08-24T18:30:00+00:00",
        )

    def test_saved_conversion_and_excluded_lines_keep_costing_semantics(self):
        measured = Ingredient.objects.create(
            user=self.owner,
            name="Almond flour",
            purchase_cost_cents=300,
            purchase_size=Decimal("1000"),
            purchase_unit="g",
        )
        IngredientMeasure.objects.create(
            ingredient=measured,
            unit="cup",
            amount=1,
            grams=120,
        )
        IngredientPrice.objects.create(
            ingredient=measured,
            purchase_cost_cents=200,
            purchase_size=Decimal("1000"),
            purchase_unit="g",
            effective_at=datetime(2026, 4, 1, tzinfo=UTC),
        )
        IngredientPrice.objects.create(
            ingredient=measured,
            purchase_cost_cents=300,
            purchase_size=Decimal("1000"),
            purchase_unit="g",
            effective_at=datetime(2026, 8, 1, tzinfo=UTC),
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=measured,
            display_name="Almond flour",
            quantity=1,
            unit="cup",
            efficiency=Decimal("80"),
            position=1,
        )
        excluded = Ingredient.objects.create(
            user=self.owner,
            name="Garnish",
            purchase_cost_cents=500,
            purchase_size=Decimal("1"),
            purchase_unit="each",
        )
        IngredientPrice.objects.create(
            ingredient=excluded,
            purchase_cost_cents=100,
            purchase_size=Decimal("1"),
            purchase_unit="each",
            effective_at=datetime(2026, 4, 1, tzinfo=UTC),
        )
        IngredientPrice.objects.create(
            ingredient=excluded,
            purchase_cost_cents=500,
            purchase_size=Decimal("1"),
            purchase_unit="each",
            effective_at=datetime(2026, 8, 2, tzinfo=UTC),
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=excluded,
            display_name="Garnish",
            quantity=1,
            unit="each",
            excluded_from_cost=True,
            position=2,
        )

        payload = self.payload()

        almond = payload["lines"][1]
        self.assertEqual(almond["from"]["costCents"], 30)
        self.assertEqual(almond["to"]["costCents"], 45)
        self.assertEqual(payload["lines"][2]["status"], "excluded")
        self.assertEqual(payload["coverage"]["requiredLines"], 2)
        # Butter and almond flour changed; the excluded garnish did not enter
        # either event context or totals.
        self.assertEqual(payload["priceChangesInWindow"], 2)

    def test_temporal_cost_uses_the_selected_preparation_conversion_only(self):
        IngredientConversion.objects.create(
            user=self.owner,
            ingredient=self.ingredient,
            average_weight=False,
            weight_amount=1000,
            weight_unit="g",
            volume_amount=4,
            volume_unit="cup",
        )
        preparation = Preparation.objects.create(
            user=self.owner,
            ingredient=self.ingredient,
            name="Shredded",
            average_weight=False,
            volume_amount=2,
            volume_unit="cup",
        )
        self.line.quantity = 1
        self.line.unit = "cup"
        self.line.preparation_note = "shredded; chilled"
        self.line.save(
            update_fields=["quantity", "unit", "preparation_note", "updated_at"]
        )

        custom = self.payload()
        self.assertFalse(custom["totals"]["fromComplete"])
        self.assertFalse(custom["totals"]["toComplete"])

        preparation.average_weight = True
        preparation.volume_amount = None
        preparation.volume_unit = ""
        preparation.save(
            update_fields=[
                "average_weight",
                "volume_amount",
                "volume_unit",
                "updated_at",
            ]
        )

        standard = self.payload()
        self.assertEqual(standard["totals"]["fromCents"], 25)
        self.assertEqual(standard["totals"]["toCents"], 50)

    def test_nested_recipe_uses_its_standard_density_ratio_at_both_boundaries(self):
        child = Recipe.objects.create(
            user=self.owner,
            title="Butter glaze",
            yield_amount=1600,
            yield_unit="ml",
        )
        RecipeItem.objects.create(
            recipe=child,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Butter",
            quantity=1000,
            unit="g",
            position=0,
        )
        RecipeEquivalency.objects.create(
            recipe=child,
            mass_amount=8,
            mass_unit="oz",
            volume_amount=1,
            volume_unit="cup",
            standard=True,
        )
        line = RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=child,
            display_name=child.title,
            quantity=500,
            unit="g",
            position=1,
        )

        payload = self.payload()
        result = next(
            row for row in payload["lines"] if row["itemId"] == str(line.id)
        )
        batch_grams = 1600 / 236.5882365 * 226.796185
        self.assertAlmostEqual(
            result["from"]["costCents"], 100 * 500 / batch_grams, places=4
        )
        self.assertAlmostEqual(
            result["to"]["costCents"], 200 * 500 / batch_grams, places=4
        )

    def test_price_activity_is_not_empty_when_the_net_delta_returns_to_zero(self):
        self.current_price.delete()
        self.price(200, datetime(2026, 7, 1, tzinfo=UTC))
        self.price(100, datetime(2026, 8, 1, tzinfo=UTC))
        self.ingredient.purchase_cost_cents = 100
        self.ingredient.save(update_fields=["purchase_cost_cents", "updated_at"])
        payload = self.payload()
        self.assertEqual(payload["priceChangesInWindow"], 2)
        self.assertEqual(payload["totals"]["deltaCents"], 0)
        self.assertIsNone(payload["lastChangeBeforeWindow"])

    def test_missing_history_and_non_costable_rows_make_totals_incomplete(self):
        second = Ingredient.objects.create(
            user=self.owner,
            name="Vanilla",
            purchase_cost_cents=50,
            purchase_size=Decimal("1"),
            purchase_unit="each",
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=second,
            display_name="Vanilla",
            quantity=1,
            unit="each",
            position=1,
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            display_name="Deleted ingredient",
            quantity=1,
            unit="g",
            position=2,
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Measure later",
            position=3,
        )
        payload = self.payload()
        self.assertFalse(payload["totals"]["fromComplete"])
        self.assertFalse(payload["totals"]["toComplete"])
        self.assertIsNone(payload["totals"]["fromCents"])
        self.assertEqual(
            [line["status"] for line in payload["lines"]],
            ["comparable", "comparable", "unresolved", "missingQuantity"],
        )
        self.assertEqual(payload["lines"][1]["from"]["status"], "noHistory")

    def test_nested_subrecipe_uses_the_same_history_without_extra_semantics(self):
        child = Recipe.objects.create(
            user=self.owner,
            title="Butter filling",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=child,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Butter",
            quantity=100,
            unit="g",
            position=0,
        )
        self.line.delete()
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=child,
            display_name=child.title,
            quantity=50,
            unit="g",
            position=0,
        )
        payload = self.payload()
        self.assertEqual(payload["totals"]["fromCents"], 5)
        self.assertEqual(payload["totals"]["toCents"], 10)
        self.assertEqual(payload["lines"][0]["kind"], "subrecipe")

    def test_shared_and_foreign_viewers_receive_not_found(self):
        RecipeShare.objects.create(
            recipe=self.recipe, recipient=self.other, role=RecipeShare.VIEWER
        )
        self.assertEqual(self.request(user=self.other).status_code, 404)
        unknown = RequestFactory().get("/")
        unknown.user = self.owner
        with patch("django.utils.timezone.now", return_value=NOW):
            response = recipe_cost_diff(unknown, "rcp_000000000000")
        self.assertEqual(response.status_code, 404)

    def test_nested_graph_keeps_the_read_at_a_fixed_query_count(self):
        child = Recipe.objects.create(
            user=self.owner,
            title="Butter center",
            yield_amount=100,
            yield_unit="g",
        )
        RecipeItem.objects.create(
            recipe=child,
            kind=RecipeItem.INGREDIENT,
            ingredient=self.ingredient,
            display_name="Butter",
            quantity=100,
            unit="g",
            position=0,
        )
        RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.SUBRECIPE,
            subrecipe=child,
            display_name=child.title,
            quantity=25,
            unit="g",
            position=1,
        )
        request = RequestFactory().get("/")
        request.user = self.owner
        with patch("django.utils.timezone.now", return_value=NOW):
            with self.assertNumQueries(
                12,
                msg="The temporal cost read loads ownership, the costing "
                "snapshot, the normalized graph and all price history once; "
                "nested recipe lines must not add queries",
            ):
                response = recipe_cost_diff(request, self.recipe.public_id)
        self.assertEqual(response.status_code, 200)


class LeftOutOfCostTests(InternalApiTestCase):
    """set-recipe-item-excluded-from-cost: the Cost tab's per-line toggle."""

    def setUp(self) -> None:
        self.owner = User.objects.create_user(
            email="left-out-owner@example.com", name="Owner", password="pass"
        )
        self.other = User.objects.create_user(
            email="left-out-other@example.com", name="Other", password="pass"
        )
        self.recipe = Recipe.objects.create(user=self.owner, title="Focaccia")
        self.line = RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.INGREDIENT,
            display_name="Butter",
            quantity=Decimal("100"),
            unit="g",
            position=0,
        )
        self.client.force_login(self.owner)

    def toggle(self, excluded: bool, item: RecipeItem | None = None):
        return self.post_internal(
            "set-recipe-item-excluded-from-cost",
            {
                "recipeId": str(self.recipe.id),
                "itemId": str((item or self.line).id),
                "excluded": excluded,
            },
        )

    def test_the_flag_goes_both_ways_and_echoes_the_bumped_version(self):
        response = self.toggle(True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "editVersion": 1})
        self.line.refresh_from_db()
        self.assertTrue(self.line.excluded_from_cost)

        response = self.toggle(False)
        self.assertEqual(response.json(), {"ok": True, "editVersion": 2})
        self.line.refresh_from_db()
        self.assertFalse(self.line.excluded_from_cost)

    def test_a_bump_refuses_an_aggregate_save_written_before_it(self):
        self.assertEqual(self.toggle(True).status_code, 200)
        response = self.post_internal(
            "save-recipe",
            {
                "id": str(self.recipe.id),
                "title": "Focaccia",
                "items": [],
                "steps": [],
                "expectedEditVersion": 0,
            },
        )
        self.assertEqual(response.status_code, 409)

    def test_a_heading_is_not_a_costed_line(self):
        heading = RecipeItem.objects.create(
            recipe=self.recipe,
            kind=RecipeItem.HEADER,
            display_name="Dough",
            position=1,
        )
        response = self.toggle(True, heading)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Recipe line not found")
        self.recipe.refresh_from_db()
        self.assertEqual(self.recipe.edit_version, 0)

    def test_an_editor_or_a_stranger_cannot_reach_it(self):
        RecipeShare.objects.create(
            recipe=self.recipe, recipient=self.other, role=RecipeShare.EDITOR
        )
        self.client.force_login(self.other)
        response = self.toggle(True)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Recipe not found")
        self.line.refresh_from_db()
        self.assertFalse(self.line.excluded_from_cost)
