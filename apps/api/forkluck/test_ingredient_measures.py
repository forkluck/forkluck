import json
from io import StringIO
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, connection, transaction
from django.test import RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .domains.ingredients import actions, views
from .domains.ingredients.serializers import (
    ingredient_json,
    preparation_json,
    pricing_entry_json,
)
from .domains.recipes.health import RecipeHealthReadModel
from .models import (
    CatalogIngredient,
    CatalogIngredientAlias,
    CatalogIngredientMeasure,
    CatalogImportBatch,
    CatalogPreparationMeasure,
    CatalogPreparationYield,
    CatalogProduct,
    CatalogSource,
    Ingredient,
    IngredientAllergenOverride,
    IngredientCategory,
    RecipeLineMatch,
    IngredientConversion,
    IngredientMeasure,
    IngredientTag,
    IngredientTagMembership,
    Preparation,
    Recipe,
    User,
)


class IngredientMeasureTenantTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="measure-owner@example.test", name="Measure owner"
        )
        self.other_user = User.objects.create_user(
            email="measure-other@example.test", name="Other owner"
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Test flour",
            normalized_name="test flour",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
        )
        self.other_ingredient = Ingredient.objects.create(
            user=self.other_user,
            name="Other flour",
            normalized_name="other flour",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
        )

    def test_measure_read_returns_reachable_defaults_and_only_owned_overrides(self):
        # A shared default is shipped when this tenant's editor can resolve a
        # line to it: their own ingredient's canonical measure name, or a
        # built-in ingredient profile. The rest of the global catalog is theirs
        # to never reach, so it stays out of the editor payload.
        reachable = CatalogIngredientMeasure.objects.create(
            ingredient=CatalogIngredient.objects.create(
                name="Test flour", normalized_name="test flour"
            ),
            unit="cup",
            amount=1,
            grams=130,
            source_kind="public_food_data",
            source_ref="reachable-1",
            is_default=True,
        )
        profiled = CatalogIngredientMeasure.objects.create(
            ingredient=CatalogIngredient.objects.create(
                name="Bread flour", normalized_name="bread flour"
            ),
            unit="cup",
            amount=1,
            grams=136,
            source_kind="public_food_data",
            source_ref="profiled-1",
            is_default=True,
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=CatalogIngredient.objects.create(
                name="Unreachable millet", normalized_name="unreachable millet"
            ),
            unit="cup",
            amount=1,
            grams=200,
            source_kind="public_food_data",
            source_ref="unreachable-1",
            is_default=True,
        )
        owned = IngredientMeasure.objects.create(
            ingredient=self.ingredient, unit="cup", amount=1, grams=125
        )
        IngredientMeasure.objects.create(
            ingredient=self.other_ingredient, unit="cup", amount=1, grams=999
        )
        request = RequestFactory().get("/internal/v1/ingredient-measures/")
        request.user = self.user

        response = views.ingredient_measures(request)
        payload = json.loads(response.content)

        self.assertEqual(
            {item["id"] for item in payload["items"]},
            {str(reachable.id), str(profiled.id), str(owned.id)},
        )
        self.assertNotIn("sourceRef", json.dumps(payload))

    def test_merge_preserves_existing_target_measure(self):
        source = self.ingredient
        target = Ingredient.objects.create(
            user=self.user,
            name="Target flour",
            normalized_name="target flour",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
        )
        IngredientMeasure.objects.create(
            ingredient=source, unit="cup", amount=1, grams=125
        )
        IngredientMeasure.objects.create(
            ingredient=target, unit="cup", amount=1, grams=130
        )

        actions.action_merge_ingredients(
            self.user, {"sourceId": str(source.id), "targetId": str(target.id)}
        )

        measures = IngredientMeasure.objects.filter(ingredient=target)
        self.assertEqual(measures.count(), 1)
        self.assertEqual(measures.get().grams, Decimal("130"))

    def test_merge_copies_a_source_measure_when_target_has_no_match(self):
        target = Ingredient.objects.create(
            user=self.user,
            name="Target flour",
            normalized_name="target flour",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
        )
        IngredientMeasure.objects.create(
            ingredient=self.ingredient,
            unit="cup",
            amount=1,
            grams=125,
            qualifier="sifted",
        )

        actions.action_merge_ingredients(
            self.user,
            {"sourceId": str(self.ingredient.id), "targetId": str(target.id)},
        )

        copied = IngredientMeasure.objects.get(ingredient=target)
        self.assertEqual(copied.unit, "cup")
        self.assertEqual(copied.qualifier, "sifted")
        self.assertEqual(copied.amount, Decimal("1"))
        self.assertEqual(copied.grams, Decimal("125"))

    def test_merge_moves_a_conversion_and_preparations_the_target_lacks(self):
        target = Ingredient.objects.create(
            user=self.user,
            name="Target garlic",
            normalized_name="target garlic",
            purchase_cost_cents=1000,
            purchase_size=1000,
            purchase_unit="g",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            average_weight=False,
            volume_amount=8,
            volume_unit="cup",
        )
        Preparation.objects.create(
            user=self.user, ingredient=self.ingredient, name="Minced", yield_percent=88
        )

        actions.action_merge_ingredients(
            self.user,
            {"sourceId": str(self.ingredient.id), "targetId": str(target.id)},
        )

        conversion = IngredientConversion.objects.get(ingredient=target)
        self.assertEqual(conversion.volume_amount, Decimal("8"))
        self.assertFalse(conversion.average_weight)
        moved = Preparation.objects.get(ingredient=target)
        self.assertEqual(moved.normalized_name, "minced")
        self.assertEqual(moved.yield_percent, Decimal("88"))

    def test_merge_keeps_the_target_conversion_and_preparation_on_a_collision(self):
        target = Ingredient.objects.create(
            user=self.user,
            name="Target garlic",
            normalized_name="target garlic",
            purchase_cost_cents=1000,
            purchase_size=1000,
            purchase_unit="g",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            average_weight=False,
            volume_amount=8,
            volume_unit="cup",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=target,
            average_weight=False,
            volume_amount=6,
            volume_unit="cup",
        )
        Preparation.objects.create(
            user=self.user, ingredient=self.ingredient, name="Minced", yield_percent=88
        )
        Preparation.objects.create(
            user=self.user, ingredient=target, name="minced", yield_percent=92
        )
        Preparation.objects.create(
            user=self.user, ingredient=self.ingredient, name="Roasted", yield_percent=70
        )

        actions.action_merge_ingredients(
            self.user,
            {"sourceId": str(self.ingredient.id), "targetId": str(target.id)},
        )

        conversion = IngredientConversion.objects.get(ingredient=target)
        self.assertEqual(conversion.volume_amount, Decimal("6"))
        self.assertEqual(
            {
                row.normalized_name: row.yield_percent
                for row in Preparation.objects.filter(ingredient=target)
            },
            {"minced": Decimal("92"), "roasted": Decimal("70")},
        )
        self.assertEqual(IngredientConversion.objects.count(), 1)

    def test_merge_unions_metadata_with_kept_row_precedence(self):
        source_category = IngredientCategory.objects.create(
            user=self.user, name="Produce", normalized_name="produce"
        )
        shared_tag = IngredientTag.objects.create(
            user=self.user, name="Staple", normalized_name="staple"
        )
        source_tag = IngredientTag.objects.create(
            user=self.user, name="Fresh", normalized_name="fresh"
        )
        target_tag = IngredientTag.objects.create(
            user=self.user, name="Local", normalized_name="local"
        )
        source = self.ingredient
        source.category = source_category
        source.non_edible = True
        source.sugars_are_added = True
        source.nutrition_label_name = "Source label"
        source.nutrition_per_100g = {"calories": 10}
        source.save()
        source.tags.set([shared_tag, source_tag])
        IngredientAllergenOverride.objects.create(
            ingredient=source, allergen="milk", status="contains"
        )
        IngredientAllergenOverride.objects.create(
            ingredient=source, allergen="egg", status="mayContain"
        )
        target = Ingredient.objects.create(
            user=self.user,
            name="Kept flour",
            normalized_name="kept flour",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
            yield_percent=90,
            status=Ingredient.STATUS_ARCHIVED,
            nutrition_per_100g={"calories": 20},
        )
        target.tags.set([shared_tag, target_tag])
        IngredientAllergenOverride.objects.create(
            ingredient=target, allergen="milk", status="doesNotContain"
        )

        result = actions.action_merge_ingredients(
            self.user, {"sourceId": str(source.id), "targetId": str(target.id)}
        )

        target.refresh_from_db()
        self.assertEqual(result["editVersion"], 1)
        self.assertEqual(target.edit_version, 1)
        self.assertEqual(target.category, source_category)
        self.assertTrue(target.non_edible)
        self.assertTrue(target.sugars_are_added)
        self.assertEqual(target.nutrition_label_name, "Source label")
        self.assertEqual(target.nutrition_per_100g, {"calories": 20})
        self.assertEqual(target.yield_percent, Decimal("90"))
        self.assertEqual(target.status, Ingredient.STATUS_ARCHIVED)
        self.assertEqual(
            set(target.tags.values_list("name", flat=True)),
            {"Staple", "Fresh", "Local"},
        )
        self.assertEqual(
            dict(target.allergen_overrides.values_list("allergen", "status")),
            {"milk": "doesNotContain", "egg": "mayContain"},
        )

    def test_failed_merge_rolls_back_metadata_and_relations(self):
        source = self.ingredient
        tag = IngredientTag.objects.create(
            user=self.user, name="Fresh", normalized_name="fresh"
        )
        IngredientTagMembership.objects.create(ingredient=source, tag=tag)
        target = Ingredient.objects.create(
            user=self.user,
            name="Kept flour",
            normalized_name="kept flour",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
        )

        with mock.patch.object(Ingredient, "delete", side_effect=RuntimeError("stop")):
            with self.assertRaisesRegex(RuntimeError, "stop"):
                actions.action_merge_ingredients(
                    self.user,
                    {"sourceId": str(source.id), "targetId": str(target.id)},
                )

        self.assertTrue(Ingredient.objects.filter(id=source.id).exists())
        self.assertFalse(target.tags.exists())
        target.refresh_from_db()
        self.assertEqual(target.edit_version, 0)

    def test_merge_metadata_query_count_does_not_grow_with_relation_count(self):
        def merge_queries(suffix: str, relation_count: int) -> int:
            source = Ingredient.objects.create(
                user=self.user,
                name=f"Source {suffix}",
                normalized_name=f"source {suffix}",
                purchase_cost_cents=0,
            )
            target = Ingredient.objects.create(
                user=self.user,
                name=f"Target {suffix}",
                normalized_name=f"target {suffix}",
                purchase_cost_cents=0,
            )
            tags = IngredientTag.objects.bulk_create(
                [
                    IngredientTag(
                        user=self.user,
                        name=f"Tag {suffix} {index}",
                        normalized_name=f"tag {suffix} {index}",
                    )
                    for index in range(relation_count)
                ]
            )
            IngredientTagMembership.objects.bulk_create(
                [
                    IngredientTagMembership(ingredient=source, tag=tag)
                    for tag in tags
                ]
            )
            allergens = [
                key
                for key, _label in IngredientAllergenOverride._meta.get_field(
                    "allergen"
                ).choices
            ][:relation_count]
            IngredientAllergenOverride.objects.bulk_create(
                [
                    IngredientAllergenOverride(
                        ingredient=source, allergen=allergen, status="contains"
                    )
                    for allergen in allergens
                ]
            )

            with CaptureQueriesContext(connection) as queries:
                actions.action_merge_ingredients(
                    self.user,
                    {"sourceId": str(source.id), "targetId": str(target.id)},
                )
            return len(queries)

        one_relation = merge_queries("one", 1)
        many_relations = merge_queries("many", 5)

        self.assertLessEqual(
            many_relations,
            one_relation,
            "tag/allergen transfer must use set-based statements, not one query per row",
        )

    def test_merge_preserves_source_catalog_measure_identity_when_target_has_none(
        self,
    ):
        catalog_ingredient = CatalogIngredient.objects.create(
            name="Canonical parsley", normalized_name="canonical parsley"
        )
        product_catalog_ingredient = CatalogIngredient.objects.create(
            name="Product parsley", normalized_name="product parsley"
        )
        CatalogIngredientAlias.objects.create(
            ingredient=catalog_ingredient, text="green parsley"
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=catalog_ingredient,
            unit="cup",
            amount=1,
            grams=30,
            source_kind="public_food_data",
            source_ref="merge-parsley-cup",
            is_default=True,
        )
        catalog_source = CatalogSource.objects.create(key="merge-measure-identity")
        batch = CatalogImportBatch.objects.create(
            source=catalog_source,
            content_sha256="b" * 64,
            observed_at=timezone.now(),
        )
        product = CatalogProduct.objects.create(
            source=catalog_source,
            import_batch=batch,
            ingredient=product_catalog_ingredient,
            external_id="merge-parsley-1",
            normalized_external_id="merge-parsley-1",
            title="Parsley",
            normalized_title="parsley",
            raw_size="1 bunch",
            pack_price_cents=299,
            pack_grams=100,
            pack_amount=1,
            pack_unit="bunch",
            observed_at=timezone.now(),
            is_recipe_ready=True,
        )
        source = self.ingredient
        source.catalog_ingredient = catalog_ingredient
        source.catalog_product = product
        source.price_source = Ingredient.PriceSource.CATALOG
        source.save(update_fields=["catalog_ingredient", "catalog_product", "price_source", "updated_at"])
        target = Ingredient.objects.create(
            user=self.user,
            name="House parsley",
            normalized_name="house parsley",
            purchase_cost_cents=1000,
            purchase_size=10000,
            purchase_unit="g",
        )
        RecipeLineMatch.objects.create(
            user=self.user,
            text="green garnish",
            ingredient=source,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Parsley sauce",
            body="1 cup green garnish",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        actions.action_merge_ingredients(
            self.user,
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )

        target.refresh_from_db()
        self.assertEqual(target.catalog_ingredient_id, catalog_ingredient.id)
        self.assertEqual(target.catalog_product_id, product.id)
        self.assertEqual(
            RecipeLineMatch.objects.filter(
                user=self.user, normalized_text="green parsley", ingredient=target
            ).count(),
            0,
        )
        match_request = RequestFactory().get("/internal/v1/matches/")
        match_request.user = self.user
        self.assertIn(
            {
                "line": "green parsley",
                "targetId": str(target.id),
                "targetName": target.name,
                "targetKind": "ingredient",
                "source": "catalog",
            },
            json.loads(views.matches(match_request).content)["items"],
        )
        self.assertEqual(ingredient_json(target)["measureName"], "Canonical parsley")
        self.assertEqual(
            RecipeLineMatch.objects.get(user=self.user, normalized_text="green garnish").ingredient,
            target,
        )
        health = RecipeHealthReadModel(self.user).rows([recipe])[0]
        self.assertEqual(health["ingredientCents"], 3)
        self.assertNotIn("unpriced", " ".join(health["issues"]))

    def test_alias_payload_keeps_catalog_measure_identity_after_pantry_rename(self):
        catalog_ingredient = CatalogIngredient.objects.create(
            name="Canonical parsley", normalized_name="canonical parsley"
        )
        CatalogIngredientAlias.objects.create(
            ingredient=catalog_ingredient, text="green parsley"
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=catalog_ingredient,
            unit="cup",
            amount=1,
            grams=30,
            source_kind="public_food_data",
            source_ref="canonical-parsley-cup",
            is_default=True,
        )
        source = CatalogSource.objects.create(key="measure-identity")
        batch = CatalogImportBatch.objects.create(
            source=source,
            content_sha256="a" * 64,
            observed_at=timezone.now(),
        )
        product = CatalogProduct.objects.create(
            source=source,
            import_batch=batch,
            ingredient=catalog_ingredient,
            external_id="parsley-1",
            normalized_external_id="parsley-1",
            title="Parsley",
            normalized_title="parsley",
            raw_size="1 bunch",
            pack_price_cents=299,
            pack_grams=100,
            pack_amount=1,
            pack_unit="bunch",
            observed_at=timezone.now(),
            is_recipe_ready=True,
        )
        adopted = actions.action_adopt_catalog_price(
            self.user, {"catalogPriceId": str(product.id)}
        )
        pantry = Ingredient.objects.get(id=adopted["id"])
        self.assertEqual(pantry.catalog_ingredient_id, catalog_ingredient.id)
        actions.action_save_ingredient(
            self.user,
            {
                "id": str(pantry.id),
                "name": "House parsley",
                "purchaseCostCents": 399,
                "purchaseSize": 100,
                "purchaseUnit": "g",
            },
        )
        pantry.refresh_from_db()
        self.assertEqual(pantry.catalog_product_id, product.id)
        self.assertEqual(pantry.price_source, Ingredient.PriceSource.USER)
        self.assertEqual(
            ingredient_json(pantry)["measureName"], "Canonical parsley"
        )
        self.assertFalse(
            actions.catalog_products_for_user(self.user)
            .filter(id=product.id)
            .exists()
        )
        pantry_count = Ingredient.objects.filter(user=self.user).count()
        adopted_again = actions.action_adopt_catalog_price(
            self.user, {"catalogPriceId": str(product.id)}
        )
        self.assertEqual(adopted_again, {"id": str(pantry.id), "created": False})
        self.assertEqual(
            Ingredient.objects.filter(user=self.user).count(), pantry_count
        )
        RecipeLineMatch.objects.create(
            user=self.user,
            text="green garnish",
            ingredient=pantry,
        )
        request = RequestFactory().get("/internal/v1/matches/")
        request.user = self.user

        payload = json.loads(views.matches(request).content)

        self.assertEqual(
            payload["items"],
            [
                {
                    "line": "green garnish",
                    "targetId": str(pantry.id),
                    "targetName": "House parsley",
                    "targetKind": "ingredient",
                    "source": "user",
                },
                {
                    "line": "green parsley",
                    "targetId": str(pantry.id),
                    "targetName": "House parsley",
                    "targetKind": "ingredient",
                    "source": "catalog",
                },
            ],
        )

        recipe = Recipe.objects.create(
            user=self.user,
            title="Parsley sauce",
            body="1 cup House parsley",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        health = RecipeHealthReadModel(self.user).rows([recipe])[0]
        self.assertAlmostEqual(health["ingredientCents"], 119.7)
        self.assertNotIn("unpriced", " ".join(health["issues"]))


class StandardConversionPricingTests(TestCase):
    """The shared weight and volume table across the mass/volume line, which
    both engines must answer the same way. The TypeScript half of each case
    lives in apps/web/tests/pricing.test.ts."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="standard-conversion@example.test", name="Standard"
        )
        self.milk = Ingredient.objects.create(
            user=self.user,
            name="Milk",
            normalized_name="milk",
            purchase_cost_cents=200,
            purchase_size=1,
            purchase_unit="l",
        )

    def cents(self, body: str) -> float:
        recipe = Recipe.objects.create(
            user=self.user,
            title="Custard",
            body=body,
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        return RecipeHealthReadModel(self.user).rows([recipe])[0]["ingredientCents"]

    def test_a_mass_line_prices_a_volume_bought_ingredient(self):
        # A litre of milk weighs 1031.34 g, so 100 g is 9.6961% of a $2.00 litre.
        self.assertAlmostEqual(self.cents("100 g milk"), 19.392, places=3)

    def test_a_stated_conversion_keeps_the_last_word(self):
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=self.milk,
            average_weight=False,
            each_amount=4,
            each_unit="each",
        )

        self.assertEqual(self.cents("100 g milk"), 0)

    def test_a_qualified_line_takes_no_standard_density(self):
        self.assertEqual(self.cents("100 g milk, scalded"), 0)


class StatedConversionPricingTests(TestCase):
    """A stated weight and volume are one equivalence about the ingredient and
    not a description of the pack: 227 g of butter is 1 cup of butter, whoever
    sells it. The TypeScript half of each case lives in apps/web/tests/pricing.test.ts.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            email="stated-conversion@example.test", name="Stated"
        )
        self.butter = Ingredient.objects.create(
            user=self.user,
            name="Unsalted butter",
            normalized_name="unsalted butter",
            purchase_cost_cents=499,
            purchase_size=1,
            purchase_unit="lb",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=self.butter,
            average_weight=False,
            weight_amount=Decimal("227"),
            weight_unit="g",
            volume_amount=Decimal("1"),
            volume_unit="cup",
            source=IngredientConversion.Source.CATALOG,
        )

    def cents(self, body: str) -> float:
        recipe = Recipe.objects.create(
            user=self.user,
            title="Shortbread",
            body=body,
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        return RecipeHealthReadModel(self.user).rows([recipe])[0]["ingredientCents"]

    def issues(self, body: str) -> str:
        recipe = Recipe.objects.create(
            user=self.user,
            title="Shortbread",
            body=body,
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        row = RecipeHealthReadModel(self.user).rows([recipe])[0]
        return " ".join(row["issues"])

    def test_a_cup_costs_the_grams_the_conversion_states(self):
        # A cup is 227 g, half of a 454 g block, so half of $4.99 and not all
        # of it.
        self.assertAlmostEqual(
            self.cents("1 cup unsalted butter"), 499 * 227 / 453.59237, places=6
        )
        self.assertAlmostEqual(self.cents("1 cup unsalted butter"), 250, places=0)

    def test_a_cup_costs_what_the_grams_it_states_cost(self):
        self.assertAlmostEqual(
            self.cents("1 cup unsalted butter"),
            self.cents("227 g unsalted butter"),
            places=6,
        )

    def test_the_same_density_scales_by_the_pack_it_is_bought_in(self):
        self.butter.purchase_size = Decimal("25")
        self.butter.purchase_unit = "kg"
        self.butter.save(update_fields=["purchase_size", "purchase_unit"])

        # The same cup is a much smaller share of a 25 kg drum.
        self.assertAlmostEqual(
            self.cents("1 cup unsalted butter"), 499 * 227 / 25000, places=6
        )

    def test_a_line_stays_unpriced_when_nothing_stated_reaches_the_pack(self):
        # Bought by the piece, with a density on it and no piece weight
        # anywhere: 227 g is 1 cup says nothing about what one piece is.
        self.butter.purchase_unit = "each"
        self.butter.save(update_fields=["purchase_unit"])

        self.assertEqual(self.cents("1 cup unsalted butter"), 0)
        self.assertIn("unpriced", self.issues("1 cup unsalted butter"))

    def test_a_container_is_still_described_by_what_it_states(self):
        # Nothing universal says how many eggs a case holds, so the measures
        # stated here describe the case itself.
        eggs = Ingredient.objects.create(
            user=self.user,
            name="Eggs",
            normalized_name="eggs",
            purchase_cost_cents=1800,
            purchase_size=1,
            purchase_unit="case",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=eggs,
            average_weight=False,
            weight_amount=Decimal("1800"),
            weight_unit="g",
            each_amount=Decimal("36"),
            each_unit="each",
        )

        # Two of thirty-six eggs, then half the case by weight.
        self.assertAlmostEqual(self.cents("2 each eggs"), 100)
        self.assertAlmostEqual(self.cents("900 g eggs"), 900)


class IngredientYieldPricingTests(TestCase):
    """The ingredient's own usable factor, ChefTec's: EP cost = AP cost / yield.

    A case of tomatoes bought at $10 with a 90% yield costs $11.11 a case of
    usable tomato. The TypeScript half of each case lives in apps/web/tests/pricing.ts.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            email="ingredient-yield@example.test", name="Yield"
        )
        self.tomatoes = Ingredient.objects.create(
            user=self.user,
            name="Tomatoes",
            normalized_name="tomatoes",
            purchase_cost_cents=1000,
            purchase_size=10,
            purchase_unit="lb",
            yield_percent=Decimal("90"),
        )

    def cents(self, body: str) -> float:
        recipe = Recipe.objects.create(
            user=self.user,
            title="Sauce",
            body=body,
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        return RecipeHealthReadModel(self.user).rows([recipe])[0]["ingredientCents"]

    def test_a_pound_costs_what_the_trim_makes_it_cost(self):
        # A pound of the case is 100 cents; a pound of usable tomato needs
        # 1.111 lb of case, so $1.11.
        self.assertAlmostEqual(self.cents("1 lb tomatoes"), 1000 / 10 / 0.9, places=6)
        self.assertAlmostEqual(self.cents("1 lb tomatoes"), 111.11, places=1)

    def test_a_full_yield_changes_nothing(self):
        self.tomatoes.yield_percent = Decimal("100")
        self.tomatoes.save(update_fields=["yield_percent"])
        self.assertAlmostEqual(self.cents("1 lb tomatoes"), 100)

    def test_a_named_preparation_replaces_the_ingredient_yield(self):
        """Never both: the state's yield answers, the ingredient's stands down."""
        Preparation.objects.create(
            user=self.user,
            ingredient=self.tomatoes,
            name="Diced",
            yield_percent=Decimal("50"),
        )
        # Half of the diced line's weight, not half of nine tenths of it.
        self.assertAlmostEqual(self.cents("1 lb tomatoes, diced"), 200)
        self.assertAlmostEqual(self.cents("1 lb tomatoes"), 1000 / 10 / 0.9, places=6)


class IngredientYieldWriteTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="yield-writes@example.test", name="Yield writes"
        )

    def test_the_column_is_bounded_to_a_usable_share(self):
        for percent in (Decimal("0"), Decimal("120")):
            with self.subTest(percent=percent), self.assertRaises(IntegrityError):
                with transaction.atomic():
                    Ingredient.objects.create(
                        user=self.user,
                        name=f"Refused {percent}",
                        normalized_name=f"refused {percent}",
                        purchase_cost_cents=100,
                        yield_percent=percent,
                    )
        row = Ingredient.objects.create(
            user=self.user,
            name="Allowed",
            normalized_name="allowed",
            purchase_cost_cents=100,
            yield_percent=Decimal("100"),
        )
        self.assertEqual(row.yield_percent, Decimal("100"))

    def test_a_new_ingredient_starts_at_a_full_yield(self):
        result = actions.action_save_ingredient(
            self.user,
            {
                "id": None,
                "name": "Carrots",
                "purchaseCostCents": 500,
                "purchaseSize": 5,
                "purchaseUnit": "lb",
            },
        )
        row = Ingredient.objects.get(id=result["id"])
        self.assertEqual(row.yield_percent, Decimal("100.000"))

    def test_save_ingredient_takes_a_yield_and_keeps_it(self):
        created = actions.action_save_ingredient(
            self.user,
            {
                "id": None,
                "name": "Tomatoes",
                "purchaseCostCents": 1000,
                "purchaseSize": 10,
                "purchaseUnit": "lb",
                "yieldPercent": 90,
            },
        )
        row = Ingredient.objects.get(id=created["id"])
        self.assertEqual(row.yield_percent, Decimal("90.000"))

        # A payload that only reprices says nothing about the yield, so the
        # saved one stays.
        actions.action_save_ingredient(
            self.user,
            {
                "id": created["id"],
                "name": "Tomatoes",
                "purchaseCostCents": 1200,
                "purchaseSize": 10,
                "purchaseUnit": "lb",
            },
        )
        row.refresh_from_db()
        self.assertEqual(row.purchase_cost_cents, 1200)
        self.assertEqual(row.yield_percent, Decimal("90.000"))

    def test_save_ingredient_refuses_a_yield_outside_the_bounds(self):
        for percent in (0, 120):
            with self.subTest(percent=percent):
                with self.assertRaises(ValueError) as refused:
                    actions.action_save_ingredient(
                        self.user,
                        {
                            "id": None,
                            "name": f"Refused {percent}",
                            "purchaseCostCents": 100,
                            "purchaseSize": 1,
                            "purchaseUnit": "lb",
                            "yieldPercent": percent,
                        },
                    )
                self.assertIn("Yield", str(refused.exception))
        self.assertEqual(Ingredient.objects.count(), 0)

    def test_the_payloads_the_editor_reads_carry_the_yield(self):
        row = Ingredient.objects.create(
            user=self.user,
            name="Tomatoes",
            normalized_name="tomatoes",
            purchase_cost_cents=1000,
            purchase_size=10,
            purchase_unit="lb",
            yield_percent=Decimal("90"),
        )
        self.assertEqual(ingredient_json(row)["yieldPercent"], 90.0)
        self.assertEqual(pricing_entry_json(row)["yieldPercent"], 90.0)


class IngredientMeasureImportTests(TestCase):
    def import_measures(self, *args, **options) -> str:
        """Import a manifest and return the command's own summary line."""
        output = StringIO()
        call_command("import_ingredient_measures", *args, stdout=output, **options)
        return output.getvalue()

    def manifest(self, rows):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name, "measures.json")
        path.write_text(json.dumps(rows), encoding="utf-8")
        return path

    def row(self, **overrides):
        return {
            "ingredient": "Test flour",
            "unit": "cup",
            "amount": 1,
            "grams": 125,
            "qualifier": "",
            "source_kind": "public_food_data",
            "source_ref": "record-1",
            "confidence": "high",
            "is_default": True,
            "is_active": True,
            **overrides,
        }

    def test_import_is_idempotent_and_updates_the_same_source_record(self):
        path = self.manifest([self.row()])
        created = self.import_measures(path)
        self.assertEqual(CatalogIngredientMeasure.objects.count(), 1)

        path.write_text(json.dumps([self.row(grams=127)]), encoding="utf-8")
        updated = self.import_measures(path)

        self.assertEqual(created.strip(), "Imported: 1 created; 0 updated.")
        self.assertEqual(updated.strip(), "Imported: 0 created; 1 updated.")

        self.assertEqual(CatalogIngredientMeasure.objects.count(), 1)
        self.assertEqual(
            CatalogIngredientMeasure.objects.get().grams, Decimal("127")
        )

    def test_dry_run_validates_without_retaining_rows(self):
        self.import_measures(
            self.manifest([self.row()]),
            dry_run=True,
        )
        self.assertEqual(CatalogIngredientMeasure.objects.count(), 0)

    def test_rejects_duplicate_or_invalid_manifest_rows(self):
        with self.assertRaisesRegex(CommandError, "Duplicate"):
            self.import_measures(
                self.manifest([self.row(), self.row()]),
            )
        with self.assertRaisesRegex(CommandError, "unsupported unit"):
            self.import_measures(
                self.manifest([self.row(unit="furlong")]),
            )
        with self.assertRaisesRegex(CommandError, "positive number"):
            self.import_measures(
                self.manifest([self.row(grams=1_000_000_000)]),
            )

        self.assertEqual(CatalogIngredientMeasure.objects.count(), 0)

    def test_rejects_multiple_defaults_for_the_same_measure_identity(self):
        with self.assertRaisesRegex(CommandError, "Multiple defaults"):
            self.import_measures(
                self.manifest(
                    [
                        self.row(),
                        self.row(source_ref="record-2", grams=130),
                    ]
                ),
            )

        self.assertEqual(CatalogIngredientMeasure.objects.count(), 0)

    def test_rejects_partial_ranges_and_inactive_defaults(self):
        with self.assertRaisesRegex(CommandError, "provided together"):
            self.import_measures(
                self.manifest([self.row(low_grams=110)]),
            )
        with self.assertRaisesRegex(CommandError, "inactive measure"):
            self.import_measures(
                self.manifest([self.row(is_active=False)]),
            )

        self.assertEqual(CatalogIngredientMeasure.objects.count(), 0)

    def test_database_guards_measure_range_and_default_state(self):
        ingredient = CatalogIngredient.objects.create(
            name="Guarded flour", normalized_name="guarded flour"
        )
        base = {
            "ingredient": ingredient,
            "unit": "cup",
            "amount": 1,
            "grams": 125,
            "source_kind": "public_food_data",
            "source_ref": "guarded-1",
        }

        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogIngredientMeasure.objects.create(**base, low_grams=110)
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogIngredientMeasure.objects.create(
                **{**base, "source_ref": "center-below-range"},
                low_grams=130,
                high_grams=140,
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogIngredientMeasure.objects.create(
                **{**base, "source_ref": "center-above-range"},
                low_grams=100,
                high_grams=120,
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogIngredientMeasure.objects.create(
                **{
                    **base,
                    "source_ref": "inactive-default",
                    "is_default": True,
                    "is_active": False,
                }
            )


class VolumeMeasureSeedTests(TestCase):
    def seed(self, *args, **options) -> str:
        """Seed reference densities and return the command's own summary."""
        output = StringIO()
        call_command("seed_volume_measures", *args, stdout=output, **options)
        return output.getvalue()

    def catalog(self, name: str, category: str) -> CatalogIngredient:
        return CatalogIngredient.objects.create(
            name=name, normalized_name=name.lower(), category=category
        )

    def test_seeds_a_reference_density_for_a_matched_catalog_ingredient(self):
        flour = self.catalog("Bread Flour", "flour")

        summary = self.seed()

        # Water is a builtin: migration 0100 puts it in the catalog, so every
        # test starts with one ingredient already there and the seeder matches
        # it too. Assert on this test's own ingredient rather than a total that
        # moves whenever another builtin is added.
        self.assertIn("1  bread-flour", summary)
        measure = CatalogIngredientMeasure.objects.get(ingredient=flour)
        self.assertEqual(measure.grams, Decimal("127.000000"))
        self.assertEqual(measure.unit, "cup")
        self.assertEqual(measure.source_kind, "seed")
        self.assertEqual(measure.confidence, "low")
        self.assertTrue(measure.is_default)

    def test_seeding_preserves_an_existing_reviewed_default(self):
        flour = self.catalog("Bread Flour", "flour")
        reviewed = CatalogIngredientMeasure.objects.create(
            ingredient=flour,
            unit="cup",
            amount=1,
            grams=137,
            source_kind="public_food_data",
            source_ref="reviewed-1",
            confidence="high",
            is_default=True,
        )
        sugar = self.catalog("Granulated Sugar", "sugar")

        self.seed()

        reviewed.refresh_from_db()
        self.assertTrue(reviewed.is_default)
        self.assertEqual(reviewed.grams, Decimal("137.000000"))
        self.assertEqual(
            list(
                CatalogIngredientMeasure.objects.filter(
                    ingredient=flour
                ).values_list("source_kind", flat=True)
            ),
            ["public_food_data"],
        )
        self.assertTrue(
            CatalogIngredientMeasure.objects.filter(
                ingredient=sugar, source_kind="seed", is_default=True
            ).exists()
        )

    def test_a_reviewed_default_in_any_volume_unit_is_preserved(self):
        # The resolver prefers a direct-unit candidate, so a seeded cup would
        # outrank a reviewed tablespoon for cup recipes even without touching
        # the tablespoon row. The ingredient is skipped entirely.
        flour = self.catalog("Bread Flour", "flour")
        reviewed = CatalogIngredientMeasure.objects.create(
            ingredient=flour,
            unit="tbsp",
            amount=1,
            grams=8,
            source_kind="public_food_data",
            source_ref="reviewed-tbsp",
            confidence="high",
            is_default=True,
        )

        self.seed()

        reviewed.refresh_from_db()
        self.assertTrue(reviewed.is_default)
        self.assertFalse(
            CatalogIngredientMeasure.objects.filter(
                ingredient=flour, source_kind="seed"
            ).exists()
        )

    def test_reviewed_evidence_retires_an_already_installed_seed(self):
        # The seed ran first; reviewed evidence arrived later. Declining to
        # reinstall is not enough — the resolver's direct-unit preference
        # would still pick the old seeded cup over the reviewed tablespoon.
        flour = self.catalog("Bread Flour", "flour")
        self.seed()
        reviewed = CatalogIngredientMeasure.objects.create(
            ingredient=flour,
            unit="tbsp",
            amount=1,
            grams=8,
            source_kind="public_food_data",
            source_ref="reviewed-tbsp",
            confidence="high",
            is_default=True,
        )

        self.seed()

        reviewed.refresh_from_db()
        self.assertTrue(reviewed.is_default)
        self.assertFalse(
            CatalogIngredientMeasure.objects.filter(
                ingredient=flour, source_kind="seed"
            ).exists()
        )

    def test_a_different_product_form_is_not_seeded(self):
        # "Peanut Butter Powder" contains the phrase but is not the paste;
        # "Cocoa Powder" is the rule's own product, named in its endings. A
        # broad category never excuses the terminal check: "Sugar Snap Peas"
        # in grocery is inside the sugar rule's categories and is not sugar.
        powder = self.catalog("Peanut Butter Powder", "grocery")
        peas = self.catalog("Sugar Snap Peas", "grocery")
        cocoa = self.catalog("Cocoa Powder", "bakery")

        self.seed()

        self.assertFalse(
            CatalogIngredientMeasure.objects.filter(ingredient=powder).exists()
        )
        self.assertFalse(
            CatalogIngredientMeasure.objects.filter(ingredient=peas).exists()
        )
        measure = CatalogIngredientMeasure.objects.get(ingredient=cocoa)
        self.assertEqual(measure.grams, Decimal("85.000000"))

    def test_a_seed_orphaned_by_a_manifest_edit_is_retired(self):
        # A rule tightening leaves an earlier seed with no rule that would
        # recreate it; the rerun must not keep what a fresh install would
        # never make. Simulated by renaming the ingredient off every rule.
        flour = self.catalog("Bread Flour", "flour")
        keeper = self.catalog("Granulated Sugar", "sugar")
        self.seed()
        self.assertTrue(
            CatalogIngredientMeasure.objects.filter(ingredient=flour).exists()
        )

        flour.name = "Bread Sticks"
        flour.normalized_name = "bread sticks"
        flour.save()

        self.seed()

        self.assertFalse(
            CatalogIngredientMeasure.objects.filter(ingredient=flour).exists()
        )
        self.assertTrue(
            CatalogIngredientMeasure.objects.filter(ingredient=keeper).exists()
        )

    def test_manifest_list_fields_are_validated(self):
        import json as json_module
        import tempfile as tempfile_module
        from pathlib import Path

        from .domains.shared import density

        with tempfile_module.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            for field in ("exclude", "categories", "endings"):
                path.write_text(
                    json_module.dumps(
                        {
                            "standardGramsPerCup": 226.796185,
                            "rules": [
                                {
                                    "key": "x",
                                    "match": ["x"],
                                    field: "powder",
                                    "gramsPerCup": 100,
                                }
                            ]
                        }
                    ),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, field):
                    density.load_rules(path)

    def test_seeding_twice_updates_its_own_row_without_duplicating_it(self):
        flour = self.catalog("Bread Flour", "flour")

        self.seed()
        self.seed()

        self.assertEqual(
            CatalogIngredientMeasure.objects.filter(ingredient=flour).count(), 1
        )


class CatalogIngredientActivationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="activation-owner@example.test", name="Activation owner"
        )
        self.other_user = User.objects.create_user(
            email="activation-other@example.test", name="Activation other"
        )
        self.catalog = CatalogIngredient.objects.create(
            name="Yellow onion", normalized_name="yellow onion", key="onion-yellow"
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=self.catalog,
            unit="cup",
            amount=1,
            grams=160,
            source_kind="reviewed",
            source_ref="onion-cup",
            confidence="high",
            is_default=True,
        )
        preparation = CatalogPreparationYield.objects.create(
            ingredient=self.catalog,
            name="diced",
            normalized_name="diced",
            yield_percent=100,
            source_kind="reviewed",
            source_ref="onion-diced",
            source_release="2026-01",
            derivation="reviewed",
            evidence_count=1,
            confidence="high",
            is_default=True,
        )
        CatalogPreparationMeasure.objects.create(
            preparation_yield=preparation,
            unit="each",
            amount=1,
            grams=80,
            source_kind="reviewed",
            source_ref="onion-diced-cup",
            confidence="high",
            is_default=True,
        )

    def test_direct_catalog_identity_survives_rename_and_seeds_later_yields(self):
        activated = actions.action_activate_catalog_ingredient(
            self.user, {"catalogIngredientId": str(self.catalog.id)}
        )
        ingredient = Ingredient.objects.get(id=activated["id"])
        ingredient.name = "House onion"
        ingredient.save(update_fields=["name", "updated_at"])

        ingredient.refresh_from_db()
        self.assertEqual(ingredient_json(ingredient)["measureName"], "Yellow onion")
        self.assertEqual(
            pricing_entry_json(ingredient)["measureName"], "Yellow onion"
        )

        later = CatalogPreparationYield.objects.create(
            ingredient=self.catalog,
            name="roasted",
            normalized_name="roasted",
            yield_percent=82,
            source_kind="reviewed",
            source_ref="onion-roasted",
            source_release="2026-08",
            derivation="reviewed",
            evidence_count=1,
            confidence="medium",
            is_default=True,
        )
        saved = actions.action_save_preparation(
            self.user,
            {
                "ingredientId": str(ingredient.id),
                "id": None,
                "name": later.name,
                "yieldPercent": None,
                "usesStandardConversion": True,
                "weight": None,
                "volume": None,
                "each": None,
            },
        )

        preparation = Preparation.objects.get(id=saved["id"])
        self.assertEqual(preparation.yield_percent, Decimal("82"))
        self.assertEqual(preparation.source, Preparation.Source.CATALOG)

    def test_activation_is_tenant_scoped_idempotent_and_materializes_defaults(self):
        first = actions.action_activate_catalog_ingredient(
            self.user, {"catalogIngredientId": str(self.catalog.id)}
        )
        second = actions.action_activate_catalog_ingredient(
            self.user, {"catalogIngredientId": str(self.catalog.id)}
        )

        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["id"], second["id"])
        ingredient = Ingredient.objects.get(id=first["id"], user=self.user)
        self.assertEqual(ingredient.catalog_ingredient_id, self.catalog.id)
        self.assertEqual(IngredientMeasure.objects.filter(ingredient=ingredient).count(), 1)
        conversion = IngredientConversion.objects.get(ingredient=ingredient)
        self.assertEqual(conversion.weight_unit, "g")
        self.assertEqual(conversion.weight_amount, Decimal("160"))
        self.assertEqual(Preparation.objects.filter(ingredient=ingredient).count(), 1)
        ingredient.purchase_cost_cents = 1000
        ingredient.purchase_size = Decimal("1")
        ingredient.purchase_unit = "each"
        ingredient.save(
            update_fields=[
                "purchase_cost_cents",
                "purchase_size",
                "purchase_unit",
                "updated_at",
            ]
        )
        preparation = Preparation.objects.get(ingredient=ingredient)
        self.assertFalse(preparation_json(preparation)["usesStandardConversion"])
        recipe = Recipe.objects.create(
            user=self.user,
            title="Diced onion",
            body="100 g yellow onion, diced",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        health = RecipeHealthReadModel(self.user).rows([recipe])[0]
        self.assertEqual(health["ingredientCents"], 1250, health)
        self.assertNotIn("unpriced", " ".join(health["issues"]))
        self.assertEqual(
            Ingredient.objects.filter(user=self.other_user).count(), 0
        )

    def test_activation_copies_every_preparation_and_names_the_row(self):
        CatalogPreparationYield.objects.create(
            ingredient=self.catalog,
            name="sliced",
            normalized_name="sliced",
            yield_percent=90,
            source_kind="catalog",
            source_ref="usda:11282",
            source_release="v-test",
            derivation="catalog",
            evidence_count=1,
            confidence="low",
            is_default=False,
        )

        result = actions.action_activate_catalog_ingredient(
            self.user, {"catalogIngredientId": str(self.catalog.id)}
        )

        self.assertEqual(result["name"], "Yellow onion")
        self.assertEqual(result["preparations"], ["diced", "sliced"])
        self.assertEqual(
            sorted(
                Preparation.objects.filter(
                    ingredient_id=result["id"]
                ).values_list("name", flat=True)
            ),
            ["diced", "sliced"],
        )
        conversion = IngredientConversion.objects.get(ingredient_id=result["id"])
        self.assertEqual(conversion.source, "catalog")
        self.assertEqual(conversion.confidence, "high")

    def test_reset_without_a_catalog_link_falls_back_to_an_estimated_cup(self):
        row = Ingredient.objects.create(
            user=self.user, name="Mystery powder", purchase_cost_cents=0
        )

        actions.action_reset_ingredient_conversion(
            self.user, {"ingredientId": str(row.id)}
        )

        conversion = IngredientConversion.objects.get(ingredient=row)
        self.assertFalse(conversion.average_weight)
        self.assertEqual(conversion.weight_amount, Decimal("226.796"))
        self.assertEqual(conversion.weight_unit, "g")
        self.assertEqual(conversion.volume_amount, Decimal("1"))
        self.assertEqual(conversion.volume_unit, "cup")
        self.assertEqual(conversion.source, "catalog")
        self.assertEqual(conversion.confidence, "low")

        actions.action_save_ingredient_conversion(
            self.user,
            {
                "ingredientId": str(row.id),
                "usesStandardConversion": False,
                "weight": {"amount": 300, "unit": "g"},
                "volume": {"amount": 1, "unit": "cup"},
            },
        )

        conversion.refresh_from_db()
        self.assertEqual(conversion.source, "user")
        self.assertEqual(conversion.confidence, "high")

        # A name the density chart knows resets to that density, not to water.
        flour = Ingredient.objects.create(
            user=self.user, name="Bread flour", purchase_cost_cents=0
        )
        actions.action_reset_ingredient_conversion(
            self.user, {"ingredientId": str(flour.id)}
        )
        conversion = IngredientConversion.objects.get(ingredient=flour)
        self.assertEqual(conversion.weight_amount, Decimal("127"))
        self.assertEqual(conversion.confidence, "medium")

    def test_search_offers_unowned_identities_with_their_preparations(self):
        CatalogIngredientAlias.objects.create(
            ingredient=self.catalog, text="Spanish onion", provenance="catalog"
        )
        # Sorted by text, deduplicated, and an inactive spelling stays out.
        CatalogIngredientAlias.objects.create(
            ingredient=self.catalog, text="Sweet onion", provenance="usda"
        )
        CatalogIngredientAlias.objects.create(
            ingredient=self.catalog, text="Sweet onion", provenance="catalog"
        )
        CatalogIngredientAlias.objects.create(
            ingredient=self.catalog,
            text="Retired onion",
            provenance="catalog",
            is_active=False,
        )
        shallot = CatalogIngredient.objects.create(
            name="Shallot", normalized_name="shallot", key="shallot"
        )
        CatalogIngredient.objects.create(name="Onion ring", normalized_name="onion ring", key="onion-ring", is_active=False)
        # A supplier price list names its own identities; they are not the catalog.
        CatalogIngredient.objects.create(name="Onion 50 lb sack", normalized_name="onion 50 lb sack")
        for name in ("Onion powder", "Pickled onion relish", "Onion"):
            CatalogIngredient.objects.create(name=name, normalized_name=name.lower(), key=name.lower().replace(" ", "-"))

        result = actions.action_search_catalog_ingredients(
            self.user, {"query": "Onion spanish"}
        )

        self.assertEqual(
            result["items"],
            [
                {
                    "id": str(self.catalog.id),
                    "name": "Yellow onion",
                    "preparations": ["diced"],
                    "aliases": ["Spanish onion", "Sweet onion"],
                }
            ],
        )
        self.assertEqual(
            [row["name"] for row in actions.action_search_catalog_ingredients(self.user, {"query": "onion"})["items"]],
            ["Onion", "Onion powder", "Yellow onion", "Pickled onion relish"],
        )
        # A synonym alone reaches the card, and says which synonym it was.
        self.assertEqual(
            actions.action_search_catalog_ingredients(
                self.user, {"query": "spanish"}
            )["items"],
            [
                {
                    "id": str(self.catalog.id),
                    "name": "Yellow onion",
                    "preparations": ["diced"],
                    "aliases": ["Spanish onion", "Sweet onion"],
                }
            ],
        )
        # A row nothing was aliased to still carries the key, empty.
        self.assertEqual(
            [
                (row["name"], row["aliases"])
                for row in actions.action_search_catalog_ingredients(
                    self.user, {"query": "shallot"}
                )["items"]
            ],
            [("Shallot", [])],
        )
        # A typo still finds the card; parity with apps/web/tests/fuzzy.test.ts.
        self.assertEqual(
            [row["name"] for row in actions.action_search_catalog_ingredients(self.user, {"query": "jellow onion"})["items"]],
            ["Yellow onion"],
        )
        self.assertEqual(
            [row["name"] for row in actions.action_search_catalog_ingredients(self.user, {"query": "shalot"})["items"]],
            ["Shallot"],
        )
        with self.assertRaises(ValueError):
            actions.action_search_catalog_ingredients(self.user, {"query": "o"})

        # Once the card is in the pantry the catalog stops offering it, and a
        # hand-typed row with the same name counts as holding it too.
        actions.action_activate_catalog_ingredient(
            self.user, {"catalogIngredientId": str(self.catalog.id)}
        )
        Ingredient.objects.create(user=self.user, name="Shallot", purchase_cost_cents=0)
        self.assertEqual(
            [row["name"] for row in actions.action_search_catalog_ingredients(self.user, {"query": "on"})["items"]],
            ["Onion", "Onion powder", "Pickled onion relish"],
        )
        self.assertEqual(
            actions.action_search_catalog_ingredients(self.user, {"query": "shall"})["items"],
            [],
        )

        self.assertEqual(
            [
                row["name"]
                for row in actions.action_search_catalog_ingredients(
                    self.other_user, {"query": "on"}
                )["items"]
            ],
            ["Onion", "Onion powder", "Yellow onion", "Pickled onion relish"],
        )
        self.assertEqual(shallot.tenant_ingredients.count(), 0)

    def test_activation_rejects_inactive_catalog_rows(self):
        self.catalog.is_active = False
        self.catalog.save(update_fields=["is_active", "updated_at"])
        with self.assertRaisesMessage(ValueError, "Catalog ingredient not found"):
            actions.action_activate_catalog_ingredient(
                self.user, {"catalogIngredientId": str(self.catalog.id)}
            )
