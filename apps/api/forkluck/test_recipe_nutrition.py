"""The label preview rollup: weights, retention, nesting, completeness,
readiness, allergens, the statement, viewer redaction, and its actions."""

from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from .domains.ingredients import actions as ingredient_actions
from .domains.ingredients import serializers as ingredient_serializers
from .domains.recipes import actions as recipe_actions
from .domains.recipes.health import RecipeHealthReadModel, recipe_allergens_many
from .domains.recipes.nutrition import recipe_nutrition_payload
from .domains.recipes.views import recipe_nutrition
from .models import (
    CatalogIngredient,
    CatalogIngredientAllergen,
    Ingredient,
    IngredientAllergenOverride,
    IngredientConversion,
    NutritionRequest,
    Preparation,
    Recipe,
    RecipeEquivalency,
    RecipeItem,
    RecipeShare,
    User,
)
from .testing import internal_payload


def snapshot(**overrides):
    """A complete per-100 g snapshot, in the shape food_data.py writes."""
    values = {
        "water": 10.0,
        "fat": 10.0,
        "protein": 10.0,
        "sugars": 10.0,
        "starch": 50.0,
        "fiber": 5.0,
        "salt": 1.0,
        "other": 4.0,
        "totalCarbohydrate": 65.0,
        "sodiumMg": 400.0,
        "saturatedFat": 2.0,
        "calories": 400.0,
        "transFat": 0.0,
        "cholesterolMg": 10.0,
        "addedSugars": 0.0,
        "vitaminDMcg": 1.0,
        "calciumMg": 100.0,
        "ironMg": 2.0,
        "potassiumMg": 300.0,
    }
    values.update(overrides)
    return values


class NutritionFixture(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(
            email="owner-nutrition@example.com", name="Owner", password="pass"
        )
        cls.editor = User.objects.create_user(
            email="editor-nutrition@example.com",
            name="Editor",
            password="pass",
            email_verified_at=timezone.now(),
        )
        cls.viewer = User.objects.create_user(
            email="viewer-nutrition@example.com",
            name="Viewer",
            password="pass",
            email_verified_at=timezone.now(),
        )
        cls.stranger = User.objects.create_user(
            email="stranger-nutrition@example.com", name="Stranger", password="pass"
        )

    def ingredient(self, name, *, linked=True, **fields):
        values = {
            "user": self.owner,
            "name": name,
            "purchase_cost_cents": 1000,
            "purchase_size": 1,
            "purchase_unit": "kg",
        }
        if linked:
            values.update(
                nutrition_source="usda_fdc",
                nutrition_source_id="1",
                nutrition_description=f"{name}, raw",
                nutrition_per_100g=snapshot(),
            )
        values.update(fields)
        return Ingredient.objects.create(**values)

    def recipe(self, title, *, yield_amount=None, yield_unit=None, **fields):
        return Recipe.objects.create(
            user=self.owner,
            title=title,
            yield_amount=yield_amount,
            yield_unit=yield_unit,
            **fields,
        )

    def line(self, recipe, position, ingredient=None, subrecipe=None, quantity=100, unit="g", **fields):
        return RecipeItem.objects.create(
            recipe=recipe,
            kind=RecipeItem.SUBRECIPE if subrecipe is not None else RecipeItem.INGREDIENT,
            position=position,
            display_name=subrecipe.title if subrecipe is not None else ingredient.name,
            quantity=Decimal(str(quantity)) if quantity is not None else None,
            unit=unit,
            ingredient=ingredient,
            subrecipe=subrecipe,
            **fields,
        )

    def payload(self, recipe, user=None):
        recipe = Recipe.objects.select_related("user", "equivalency").get(id=recipe.id)
        return recipe_nutrition_payload(recipe, user or self.owner)


class RollupTests(NutritionFixture):
    def test_batch_totals_sum_each_line_by_its_net_grams(self):
        butter = self.ingredient("Butter", nutrition_per_100g=snapshot(fat=80.0, calories=700.0))
        flour = self.ingredient("Flour", nutrition_per_100g=snapshot(fat=1.0, calories=360.0))
        recipe = self.recipe("Dough", yield_amount=300, yield_unit="g")
        self.line(recipe, 0, butter, quantity=100)
        self.line(recipe, 1, flour, quantity=200)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"], {"batch": [], "serving": ["noServingSize"]})
        batch = payload["totals"]["batch"]
        self.assertAlmostEqual(batch["fat"]["amount"], 80 + 2, places=3)
        self.assertAlmostEqual(batch["calories"]["amount"], 700 + 720, places=3)
        self.assertAlmostEqual(batch["energyKj"]["amount"], 1420 * 4.184, places=2)
        self.assertTrue(batch["fat"]["complete"])
        per_100g = payload["totals"]["per100g"]
        self.assertAlmostEqual(per_100g["fat"]["amount"], 82 / 3, places=3)
        self.assertIsNone(payload["totals"]["perServing"])
        self.assertEqual(payload["batch"]["grams"], 300)
        self.assertEqual(payload["batch"]["inputGrams"], 300)

    def test_yield_after_cooking_scales_nutrients_and_leaves_cost_alone(self):
        oil = self.ingredient("Oil", nutrition_per_100g=snapshot(fat=100.0))
        recipe = self.recipe("Seared", yield_amount=1000, yield_unit="g")
        oil_line = self.line(recipe, 0, oil, quantity=30, efficiency_after_cooking=2)
        payload = self.payload(recipe)
        line = payload["lines"][0]
        self.assertEqual(line["grams"], 30)
        self.assertEqual(line["netGrams"], 0.6)
        self.assertAlmostEqual(payload["totals"]["batch"]["fat"]["amount"], 0.6, places=3)
        before, _, _ = RecipeHealthReadModel(self.owner)._normalized_cost(recipe)
        oil_line.efficiency_after_cooking = 100
        oil_line.save()
        after, _, _ = RecipeHealthReadModel(self.owner)._normalized_cost(recipe)
        self.assertEqual(before, after)

    def test_a_discarded_line_keeps_nothing_but_still_contains_its_allergens(self):
        brine = self.ingredient("Brine")
        IngredientAllergenOverride.objects.create(ingredient=brine, allergen="fish", status="contains")
        chicken = self.ingredient("Chicken")
        recipe = self.recipe("Brined", yield_amount=500, yield_unit="g")
        self.line(recipe, 0, brine, quantity=1000, efficiency_after_cooking=0)
        self.line(recipe, 1, chicken, quantity=500)
        payload = self.payload(recipe)
        self.assertEqual(payload["lines"][0]["status"], "discarded")
        self.assertEqual(payload["lines"][0]["netGrams"], 0)
        self.assertEqual(payload["issues"]["batch"], [])
        self.assertAlmostEqual(payload["totals"]["batch"]["fat"]["amount"], 50, places=3)
        self.assertEqual([entry["name"] for entry in payload["statement"]], ["Chicken"])
        # An ingredient the kitchen chose has no threshold: pouring the brine
        # off does not turn its fish into a may-contain.
        self.assertEqual(payload["allergens"], {"contains": ["fish"], "mayContain": []})

    def test_packaging_contributes_nothing_allergens_included(self):
        box = self.ingredient("Box", non_edible=True, linked=False)
        IngredientAllergenOverride.objects.create(ingredient=box, allergen="wheat", status="contains")
        flour = self.ingredient("Flour")
        recipe = self.recipe("Boxed", yield_amount=100, yield_unit="g")
        self.line(recipe, 0, box, quantity=1, unit="each")
        self.line(recipe, 1, flour, quantity=100)
        payload = self.payload(recipe)
        self.assertEqual(payload["lines"][0]["status"], "nonEdible")
        self.assertTrue(payload["lines"][0]["nonEdible"])
        self.assertEqual(payload["issues"]["batch"], [])
        self.assertEqual([entry["name"] for entry in payload["statement"]], ["Flour"])
        self.assertEqual(payload["allergens"], {"contains": [], "mayContain": []})

    def test_every_line_excluded_blocks_the_preview(self):
        box = self.ingredient("Box", non_edible=True, linked=False)
        recipe = self.recipe("Empty box", yield_amount=100, yield_unit="g")
        self.line(recipe, 0, box, quantity=1, unit="each")
        payload = self.payload(recipe)
        self.assertIn("allExcluded", payload["issues"]["batch"])
        self.assertIsNone(payload["totals"]["batch"])

    def test_a_volume_line_weighs_what_it_costs(self):
        # 227 g of butter is 1 cup of it, bought by the kilo at 50% usable.
        butter = self.ingredient("Butter", yield_percent=Decimal("50"))
        IngredientConversion.objects.create(
            user=self.owner,
            ingredient=butter,
            average_weight=False,
            weight_amount=Decimal("227"),
            weight_unit="g",
            volume_amount=Decimal("1"),
            volume_unit="cup",
        )
        model = RecipeHealthReadModel(self.owner)
        grams = model.line_grams(str(butter.id), 2, "cup")
        self.assertAlmostEqual(grams, 454, places=3)
        # Costing doubles for the yield; the weight of the line does not.
        cents = model.ingredient_cents(str(butter.id), 2, "cup")
        self.assertAlmostEqual(cents, 454 / 1000 * 1000 * 2, places=3)
        self.assertEqual(model.line_grams(str(butter.id), 250, "g"), 250)

    def test_custom_preparation_never_borrows_an_incomplete_conversion(self):
        cabbage = self.ingredient("Cabbage")
        IngredientConversion.objects.create(
            user=self.owner,
            ingredient=cabbage,
            average_weight=False,
            weight_amount=Decimal("1000"),
            weight_unit="g",
            volume_amount=Decimal("4"),
            volume_unit="cup",
        )
        Preparation.objects.create(
            user=self.owner,
            ingredient=cabbage,
            name="Shredded",
            average_weight=False,
            volume_amount=Decimal("2"),
            volume_unit="cup",
        )
        model = RecipeHealthReadModel(self.owner)

        self.assertIsNone(
            model.line_grams(
                str(cabbage.id), 1, "cup", "shredded, room temperature"
            )
        )
        self.assertIsNone(
            model.ingredient_cents(
                str(cabbage.id), 1, "cup", "shredded; room temperature"
            )
        )

    def test_standard_preparation_uses_the_ingredient_conversion(self):
        cabbage = self.ingredient("Cabbage")
        IngredientConversion.objects.create(
            user=self.owner,
            ingredient=cabbage,
            average_weight=False,
            weight_amount=Decimal("1000"),
            weight_unit="g",
            volume_amount=Decimal("4"),
            volume_unit="cup",
        )
        Preparation.objects.create(
            user=self.owner,
            ingredient=cabbage,
            name="Cooked",
            average_weight=True,
            yield_percent=Decimal("50"),
        )
        model = RecipeHealthReadModel(self.owner)

        self.assertAlmostEqual(
            model.line_grams(str(cabbage.id), 1, "cup", "cooked, cooled"), 250
        )
        self.assertAlmostEqual(
            model.ingredient_cents(str(cabbage.id), 1, "cup", "cooked; cooled"),
            500,
        )
        self.assertAlmostEqual(
            model.line_grams(str(cabbage.id), 1, "cup", "slow cooked"), 250
        )
        self.assertAlmostEqual(
            model.ingredient_cents(str(cabbage.id), 1, "cup", "slow cooked"),
            250,
        )

    def test_a_volume_line_with_no_conversion_is_unweighed(self):
        mystery = self.ingredient("Mystery powder")
        recipe = self.recipe("Mystery", yield_amount=100, yield_unit="g")
        self.line(recipe, 0, mystery, quantity=2, unit="cup")
        payload = self.payload(recipe)
        self.assertEqual(payload["lines"][0]["status"], "unweighed")
        self.assertEqual(payload["issues"]["batch"], ["unweighedItem"])

    def test_unlinked_and_unresolved_lines_name_their_issue(self):
        flour = self.ingredient("Flour", linked=False)
        recipe = self.recipe("Gappy", yield_amount=100, yield_unit="g")
        self.line(recipe, 0, flour, quantity=100)
        RecipeItem.objects.create(
            recipe=recipe, kind=RecipeItem.INGREDIENT, position=1,
            display_name="Something", quantity=Decimal("1"), unit="g",
        )
        payload = self.payload(recipe)
        self.assertEqual([line["status"] for line in payload["lines"]], ["unlinked", "unresolved"])
        # Still weighed for display: the cook sees what the link will cover.
        self.assertEqual(payload["lines"][0]["grams"], 100)
        self.assertEqual(payload["issues"]["batch"], ["unlinkedIngredient", "unresolvedItem"])
        self.assertIsNone(payload["totals"]["per100g"])


class NestedRecipeTests(NutritionFixture):
    def test_a_sub_recipe_rolls_in_as_a_share_of_its_batch(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0, protein=0.0))
        egg = self.ingredient("Egg", nutrition_per_100g=snapshot(protein=12.0, sugars=0.0))
        IngredientAllergenOverride.objects.create(ingredient=egg, allergen="egg", status="contains")
        curd = self.recipe("Curd", yield_amount=1800, yield_unit="g", kind=Recipe.KIND_COMPONENT)
        self.line(curd, 0, sugar, quantity=900)
        self.line(curd, 1, egg, quantity=900)
        tart = self.recipe("Tart", yield_amount=1000, yield_unit="g")
        self.line(tart, 0, subrecipe=curd, quantity=600)
        flour = self.ingredient("Flour", nutrition_per_100g=snapshot(sugars=0.0, protein=10.0))
        self.line(tart, 1, flour, quantity=400)
        payload = self.payload(tart)
        self.assertEqual(payload["issues"]["batch"], [])
        self.assertEqual(payload["lines"][0]["status"], "linked")
        self.assertEqual(payload["lines"][0]["subrecipePublicId"], curd.public_id)
        batch = payload["totals"]["batch"]
        self.assertAlmostEqual(batch["sugars"]["amount"], 900 / 3, places=3)
        self.assertAlmostEqual(batch["protein"]["amount"], 900 * 0.12 / 3 + 40, places=3)
        self.assertEqual(
            payload["statement"],
            [
                {"name": "Flour", "grams": 400, "allergens": []},
                {"name": "Egg", "grams": 300, "allergens": ["egg"]},
                {"name": "Sugar", "grams": 300, "allergens": []},
            ],
        )
        self.assertEqual(payload["allergens"]["contains"], ["egg"])

    def test_a_sub_recipe_counted_in_pieces_answers_a_slice_line(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        cake = self.recipe("Cake", yield_amount=12, yield_unit="pcs")
        self.line(cake, 0, sugar, quantity=1200)
        plate = self.recipe("Plate", yield_amount=300, yield_unit="g")
        self.line(plate, 0, subrecipe=cake, quantity=3, unit="slice")
        payload = self.payload(plate)
        self.assertEqual(payload["issues"]["batch"], [])
        self.assertEqual(payload["lines"][0]["grams"], 300)
        self.assertAlmostEqual(payload["totals"]["batch"]["sugars"]["amount"], 300, places=3)

    def test_a_sub_recipe_with_only_an_equivalency_weight_still_scales(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        syrup = self.recipe("Syrup", yield_amount=12, yield_unit="serving")
        RecipeEquivalency.objects.create(
            recipe=syrup, mass_amount=Decimal("1800"), mass_unit="g",
            volume_amount=Decimal("1500"), volume_unit="ml",
            standard=False,
        )
        self.line(syrup, 0, sugar, quantity=2000)
        drink = self.recipe("Drink", yield_amount=500, yield_unit="g")
        self.line(drink, 0, subrecipe=syrup, quantity=250, unit="ml")
        payload = self.payload(drink)
        self.assertEqual(payload["issues"]["batch"], [])
        self.assertEqual(payload["lines"][0]["grams"], 300)
        # 2000 g of sugar went in; 1800 g came out; 300 g of that is 1/6.
        self.assertAlmostEqual(payload["totals"]["batch"]["sugars"]["amount"], 2000 / 6, places=3)

    def test_a_sub_recipe_scales_a_standard_density_ratio_to_its_yield(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        glaze = self.recipe("Glaze", yield_amount=1600, yield_unit="ml")
        RecipeEquivalency.objects.create(
            recipe=glaze,
            mass_amount=Decimal("8"),
            mass_unit="oz",
            volume_amount=Decimal("1"),
            volume_unit="cup",
            standard=True,
        )
        self.line(glaze, 0, sugar, quantity=2000)
        plate = self.recipe("Plate", yield_amount=800, yield_unit="g")
        self.line(plate, 0, subrecipe=glaze, quantity=800, unit="ml")

        payload = self.payload(plate)

        batch_grams = 1600 / 236.5882365 * 226.796185
        self.assertAlmostEqual(payload["lines"][0]["grams"], batch_grams / 2, places=3)
        self.assertAlmostEqual(
            payload["totals"]["batch"]["sugars"]["amount"], 1000, places=3
        )

    def test_a_blocked_empty_or_unrelatable_sub_recipe_names_its_issue(self):
        unlinked = self.ingredient("Mystery", linked=False)
        blocked_child = self.recipe("Blocked", yield_amount=100, yield_unit="g")
        self.line(blocked_child, 0, unlinked, quantity=100)
        empty_child = self.recipe("Empty", yield_amount=100, yield_unit="g")
        sugar = self.ingredient("Sugar")
        fine_child = self.recipe("Fine", yield_amount=100, yield_unit="g")
        self.line(fine_child, 0, sugar, quantity=100)
        parent = self.recipe("Parent", yield_amount=300, yield_unit="g")
        self.line(parent, 0, subrecipe=blocked_child, quantity=50)
        self.line(parent, 1, subrecipe=empty_child, quantity=50)
        self.line(parent, 2, subrecipe=fine_child, quantity=1, unit="case")
        payload = self.payload(parent)
        self.assertEqual(
            [line["status"] for line in payload["lines"]],
            ["subrecipeIncomplete", "subrecipeIncomplete", "unweighed"],
        )
        self.assertEqual(
            payload["issues"]["batch"],
            ["subrecipeEmpty", "subrecipeIncomplete", "subrecipeUnresolved"],
        )

    def test_a_cycle_marks_the_line_incomplete_without_raising(self):
        sugar = self.ingredient("Sugar")
        a = self.recipe("A", yield_amount=100, yield_unit="g")
        b = self.recipe("B", yield_amount=100, yield_unit="g")
        self.line(a, 0, sugar, quantity=50)
        # bulk_create skips clean(), which is where the cycle guard lives.
        RecipeItem.objects.bulk_create(
            [
                RecipeItem(recipe=a, kind=RecipeItem.SUBRECIPE, position=1, display_name="B",
                           quantity=Decimal("50"), unit="g", subrecipe=b),
                RecipeItem(recipe=b, kind=RecipeItem.SUBRECIPE, position=0, display_name="A",
                           quantity=Decimal("50"), unit="g", subrecipe=a),
            ]
        )
        payload = self.payload(a)
        self.assertEqual(payload["lines"][1]["status"], "subrecipeIncomplete")
        self.assertIn("subrecipeIncomplete", payload["issues"]["batch"])


class ServingAndReadinessTests(NutritionFixture):
    def test_a_serving_in_grams_divides_the_batch(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Sweet", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("50"), nutrition_serving_unit="g",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["serving"], {"amount": 50, "unit": "g", "grams": 50})
        self.assertEqual(payload["batch"]["servings"], 20)
        self.assertAlmostEqual(payload["totals"]["perServing"]["sugars"]["amount"], 50, places=3)
        self.assertTrue(payload["readiness"]["us"]["ready"])
        self.assertTrue(payload["readiness"]["eu"]["ready"])

    def test_a_package_sets_servings_per_container(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Jarred", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("50"), nutrition_serving_unit="g",
            nutrition_package_amount=Decimal("250"), nutrition_package_unit="g",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["package"], {"amount": 250, "unit": "g", "grams": 250})
        self.assertEqual(payload["batch"]["servings"], 5)
        self.assertEqual(payload["batch"]["containers"], 4)
        # The package divides the container, never the nutrient math.
        self.assertAlmostEqual(payload["totals"]["perServing"]["sugars"]["amount"], 50, places=3)

    def test_without_a_package_the_batch_is_the_container(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Loose", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("50"), nutrition_serving_unit="g",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["package"], {"amount": None, "unit": "", "grams": None})
        self.assertEqual(payload["batch"]["servings"], 20)
        self.assertIsNone(payload["batch"]["containers"])
        self.assertEqual(payload["issues"]["serving"], [])

    def test_a_counted_package_reads_through_the_equivalency(self):
        sugar = self.ingredient("Sugar")
        recipe = self.recipe(
            "Tray", yield_amount=12, yield_unit="serving",
            nutrition_serving_amount=Decimal("1"), nutrition_serving_unit="serving",
            nutrition_package_amount=Decimal("4"), nutrition_package_unit="serving",
        )
        RecipeEquivalency.objects.create(
            recipe=recipe,
            mass_amount=Decimal("1800"),
            mass_unit="g",
            standard=False,
        )
        self.line(recipe, 0, sugar, quantity=2000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], [])
        self.assertEqual(payload["package"]["grams"], 600)
        self.assertEqual(payload["batch"]["servings"], 4)
        self.assertEqual(payload["batch"]["containers"], 3)

    def test_a_package_the_yield_cannot_relate_is_an_issue(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Loose", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("50"), nutrition_serving_unit="g",
            nutrition_package_amount=Decimal("1"), nutrition_package_unit="portion",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], ["packageNeedsEquivalency"])
        self.assertIsNone(payload["batch"]["servings"])
        self.assertIsNone(payload["batch"]["containers"])
        # The counts go, the nutrients stay: a serving does not depend on the
        # package it is packed into.
        self.assertAlmostEqual(
            payload["totals"]["perServing"]["sugars"]["amount"], 50, places=3
        )

    def test_a_counted_serving_reads_through_the_equivalency(self):
        sugar = self.ingredient("Sugar")
        recipe = self.recipe(
            "Tray", yield_amount=12, yield_unit="serving",
            nutrition_serving_amount=Decimal("1"), nutrition_serving_unit="serving",
        )
        RecipeEquivalency.objects.create(
            recipe=recipe,
            mass_amount=Decimal("1800"),
            mass_unit="g",
            standard=False,
        )
        self.line(recipe, 0, sugar, quantity=2000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], [])
        self.assertEqual(payload["serving"]["grams"], 150)
        # The water rule: the declared 1800 g wins over the 2000 g that went in.
        self.assertEqual(payload["batch"]["grams"], 1800)
        self.assertEqual(payload["batch"]["declaredGrams"], 1800)
        self.assertEqual(payload["batch"]["inputGrams"], 2000)

    def test_a_volume_serving_reads_through_a_volume_yield(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Syrup", yield_amount=1, yield_unit="l",
            nutrition_serving_amount=Decimal("250"), nutrition_serving_unit="ml",
        )
        self.line(recipe, 0, sugar, quantity=1200)
        payload = self.payload(recipe)
        self.assertEqual(payload["serving"]["grams"], 300)

    def test_a_serving_the_yield_cannot_relate_is_an_issue(self):
        sugar = self.ingredient("Sugar")
        recipe = self.recipe(
            "Loose", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("1"), nutrition_serving_unit="portion",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], ["servingNeedsEquivalency"])
        self.assertIsNone(payload["totals"]["perServing"])
        self.assertIsNotNone(payload["totals"]["per100g"])
        self.assertFalse(payload["readiness"]["us"]["ready"])
        self.assertTrue(payload["readiness"]["eu"]["ready"])

    def test_a_package_smaller_than_a_serving_is_an_issue(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Loose", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("100"), nutrition_serving_unit="g",
            nutrition_package_amount=Decimal("50"), nutrition_package_unit="g",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], ["packageBelowServing"])
        self.assertIsNone(payload["totals"]["perServing"])

    def test_a_package_equal_to_a_serving_is_fine(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Single", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("100"), nutrition_serving_unit="g",
            nutrition_package_amount=Decimal("100"), nutrition_package_unit="g",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], [])
        self.assertIsNotNone(payload["totals"]["perServing"])

    def test_a_serving_above_the_batch_is_an_issue(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Loose", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("2"), nutrition_serving_unit="kg",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], ["servingAboveBatch"])
        self.assertIsNone(payload["totals"]["perServing"])

    def test_a_package_above_the_batch_is_an_issue(self):
        sugar = self.ingredient("Sugar", nutrition_per_100g=snapshot(sugars=100.0))
        recipe = self.recipe(
            "Loose", yield_amount=1000, yield_unit="g",
            nutrition_serving_amount=Decimal("100"), nutrition_serving_unit="g",
            nutrition_package_amount=Decimal("2"), nutrition_package_unit="kg",
        )
        self.line(recipe, 0, sugar, quantity=1000)
        payload = self.payload(recipe)
        self.assertEqual(payload["issues"]["serving"], ["packageAboveBatch"])
        self.assertIsNone(payload["totals"]["perServing"])

    def test_an_unreported_nutrient_is_incomplete_never_zero(self):
        flour = self.ingredient("Flour", nutrition_per_100g=snapshot(vitaminDMcg=None))
        butter = self.ingredient("Butter", nutrition_per_100g=snapshot(vitaminDMcg=1.5))
        recipe = self.recipe(
            "Pastry", yield_amount=200, yield_unit="g",
            nutrition_serving_amount=Decimal("100"), nutrition_serving_unit="g",
        )
        self.line(recipe, 0, flour, quantity=100)
        self.line(recipe, 1, butter, quantity=100)
        payload = self.payload(recipe)
        vitamin_d = payload["totals"]["batch"]["vitaminDMcg"]
        self.assertEqual(vitamin_d, {"amount": 1.5, "complete": False})
        self.assertEqual(payload["readiness"]["us"], {"ready": False, "missing": ["vitaminDMcg"]})
        self.assertEqual(payload["readiness"]["eu"], {"ready": True, "missing": []})

    def test_a_snapshot_without_saturates_or_calories_derives_what_it_can(self):
        old = {
            "water": 16, "fat": 81, "protein": 1, "sugars": 0, "starch": 0,
            "fiber": 0, "salt": 0, "other": 2,
        }
        butter = self.ingredient("Butter", nutrition_per_100g=old)
        recipe = self.recipe("Old", yield_amount=100, yield_unit="g")
        self.line(recipe, 0, butter, quantity=100)
        batch = self.payload(recipe)["totals"]["batch"]
        self.assertEqual(batch["calories"], {"amount": 733.0, "complete": True})
        self.assertEqual(batch["totalCarbohydrate"], {"amount": 0.0, "complete": True})
        self.assertFalse(batch["saturatedFat"]["complete"])
        self.assertFalse(batch["transFat"]["complete"])

    def test_a_sweetener_counts_its_sugars_as_added(self):
        honey = self.ingredient(
            "Honey", sugars_are_added=True,
            nutrition_per_100g=snapshot(sugars=80.0, addedSugars=None),
        )
        recipe = self.recipe("Glaze", yield_amount=100, yield_unit="g")
        self.line(recipe, 0, honey, quantity=100)
        batch = self.payload(recipe)["totals"]["batch"]
        self.assertEqual(batch["addedSugars"], {"amount": 80.0, "complete": True})


class StatementAndAllergenTests(NutritionFixture):
    def test_the_statement_orders_by_weight_as_incorporated_under_the_label_name(self):
        pork = self.ingredient("Pork belly", nutrition_label_name="Locally sourced pork belly")
        salt = self.ingredient("Salt")
        oil = self.ingredient("Oil")
        recipe = self.recipe("Roast", yield_amount=900, yield_unit="g")
        # Heaviest as written, even though most of it cooks off.
        self.line(recipe, 0, pork, quantity=1000, efficiency_after_cooking=60)
        self.line(recipe, 1, salt, quantity=20)
        self.line(recipe, 2, oil, quantity=50)
        self.line(recipe, 3, salt, quantity=5)
        payload = self.payload(recipe)
        self.assertEqual(
            payload["statement"],
            [
                {"name": "Locally sourced pork belly", "grams": 1000, "allergens": []},
                {"name": "Oil", "grams": 50, "allergens": []},
                {"name": "Salt", "grams": 25, "allergens": []},
            ],
        )

    def test_a_statement_entry_carries_the_allergens_of_what_it_names(self):
        butter = self.ingredient("Butter")
        IngredientAllergenOverride.objects.create(
            ingredient=butter, allergen="milk", status="contains"
        )
        traces = self.ingredient("Cultured butter", nutrition_label_name="Butter")
        IngredientAllergenOverride.objects.create(
            ingredient=traces, allergen="tree_nuts", status="mayContain"
        )
        flour = self.ingredient("Flour")
        IngredientAllergenOverride.objects.create(
            ingredient=flour, allergen="wheat", status="contains"
        )
        crumb = self.recipe("Crumb", yield_amount=200, yield_unit="g", kind=Recipe.KIND_COMPONENT)
        self.line(crumb, 0, flour, quantity=200)
        tart = self.recipe("Tart", yield_amount=600, yield_unit="g")
        self.line(tart, 0, butter, quantity=300)
        # The same statement name twice: the keys union, a may-contain tag
        # is not a "contains" and stays out.
        self.line(tart, 1, traces, quantity=100)
        self.line(tart, 2, subrecipe=crumb, quantity=200)
        payload = self.payload(tart)
        self.assertEqual(
            payload["statement"],
            [
                {"name": "Butter", "grams": 400, "allergens": ["milk"]},
                {"name": "Flour", "grams": 200, "allergens": ["wheat"]},
            ],
        )

    def test_a_check_label_row_never_reaches_the_rollup(self):
        catalog = CatalogIngredient.objects.create(
            name="Rollup marinade", normalized_name="rollup marinade"
        )
        CatalogIngredientAllergen.objects.create(
            ingredient=catalog,
            allergen="soy",
            status="checkLabel",
            source_kind="catalog",
            source_ref="rollup-marinade",
        )
        marinade = self.ingredient("Marinade", catalog_ingredient=catalog)
        dish = self.recipe("Grilled", yield_amount=200, yield_unit="g")
        self.line(dish, 0, marinade, quantity=200)
        payload = self.payload(dish)
        self.assertEqual(payload["allergens"], {"contains": [], "mayContain": []})
        self.assertEqual(payload["statement"][0]["allergens"], [])

    def test_allergens_roll_through_sub_recipes_with_contains_outranking_may_contain(self):
        milk = self.ingredient("Milk")
        IngredientAllergenOverride.objects.create(ingredient=milk, allergen="milk", status="contains")
        cream = self.ingredient("Cream")
        IngredientAllergenOverride.objects.create(ingredient=cream, allergen="milk", status="mayContain")
        IngredientAllergenOverride.objects.create(ingredient=cream, allergen="tree_nuts", status="mayContain")
        sauce = self.recipe("Sauce", yield_amount=200, yield_unit="g")
        self.line(sauce, 0, milk, quantity=200)
        dish = self.recipe("Dish", yield_amount=400, yield_unit="g")
        self.line(dish, 0, subrecipe=sauce, quantity=200)
        self.line(dish, 1, cream, quantity=200)
        payload = self.payload(dish)
        self.assertEqual(payload["allergens"], {"contains": ["milk"], "mayContain": ["tree_nuts"]})
        rolled = recipe_allergens_many([Recipe.objects.get(id=dish.id)])
        self.assertEqual(rolled[dish.id], {"milk": "contains", "tree_nuts": "mayContain"})


class AccessTests(NutritionFixture):
    def setUp(self):
        self.sugar = self.ingredient("Sugar")
        self.child = self.recipe("Child", yield_amount=100, yield_unit="g")
        self.line(self.child, 0, self.sugar, quantity=100)
        self.recipe_row = self.recipe("Shared", yield_amount=200, yield_unit="g")
        self.line(self.recipe_row, 0, self.sugar, quantity=100)
        self.line(self.recipe_row, 1, subrecipe=self.child, quantity=100)
        RecipeShare.objects.create(recipe=self.recipe_row, recipient=self.viewer, role=RecipeShare.VIEWER)
        RecipeShare.objects.create(recipe=self.recipe_row, recipient=self.editor, role=RecipeShare.EDITOR)

    def test_the_owner_sees_the_pantry_handles(self):
        payload = internal_payload(recipe_nutrition, self.owner, recipe_ref=self.recipe_row.public_id)
        line = payload["item"]["lines"][0]
        self.assertEqual(line["ingredientPublicId"], self.sugar.public_id)
        self.assertEqual(line["linkedDescription"], "Sugar, raw")
        self.assertEqual(line["linkedSource"], "usda_fdc")
        self.assertEqual(payload["item"]["lines"][1]["subrecipePublicId"], self.child.public_id)

    def test_the_owner_sees_the_hint_flag_and_a_sub_recipe_line_never_carries_one(self):
        Ingredient.objects.filter(id=self.sugar.id).update(
            nutrition_package_ingredients="SUGAR. MAY CONTAIN MILK."
        )
        lines = internal_payload(
            recipe_nutrition, self.owner, recipe_ref=self.recipe_row.public_id
        )["item"]["lines"]
        self.assertTrue(lines[0]["hasAllergenHints"])
        self.assertFalse(lines[1]["hasAllergenHints"])

    def test_a_viewer_is_never_shown_the_owners_unfinished_hints(self):
        Ingredient.objects.filter(id=self.sugar.id).update(
            nutrition_package_ingredients="SUGAR. MAY CONTAIN MILK."
        )
        lines = internal_payload(
            recipe_nutrition, self.viewer, recipe_ref=self.recipe_row.public_id
        )["item"]["lines"]
        self.assertFalse(lines[0]["hasAllergenHints"])

    def test_a_viewer_gets_the_preview_and_nothing_to_open(self):
        payload = internal_payload(recipe_nutrition, self.viewer, recipe_ref=self.recipe_row.public_id)
        item = payload["item"]
        self.assertEqual(item["permission"], "viewer")
        self.assertFalse(item["canEdit"])
        self.assertIsNotNone(item["totals"]["batch"])
        line = item["lines"][0]
        self.assertEqual(line["status"], "linked")
        self.assertIsNone(line["ingredientPublicId"])
        self.assertIsNone(line["linkedDescription"])
        self.assertIsNone(line["linkedSource"])
        # The child is not shared with the viewer, so it is not a link.
        self.assertIsNone(item["lines"][1]["subrecipePublicId"])
        self.assertNotIn("Cents", str(payload))

    def test_an_editor_may_open_a_child_shared_with_them(self):
        RecipeShare.objects.create(recipe=self.child, recipient=self.editor, role=RecipeShare.VIEWER)
        payload = internal_payload(recipe_nutrition, self.editor, recipe_ref=self.recipe_row.public_id)
        self.assertTrue(payload["item"]["canEdit"])
        self.assertEqual(payload["item"]["lines"][1]["subrecipePublicId"], self.child.public_id)

    def test_a_stranger_gets_nothing(self):
        payload = internal_payload(recipe_nutrition, self.stranger, recipe_ref=self.recipe_row.public_id)
        self.assertEqual(payload, {"item": None})

    def test_the_read_is_a_fixed_number_of_queries_per_depth(self):
        with CaptureQueriesContext(connection) as context:
            internal_payload(recipe_nutrition, self.owner, recipe_ref=self.recipe_row.public_id)
        # Recipe, settings, the read model's recipe and pantry reads, two
        # item depths with their allergen prefetches, and the equivalency.
        self.assertLessEqual(
            len(context.captured_queries),
            18,
            "The nutrition read grew a per-row query; prefetch it instead",
        )


class RecipeActionTests(NutritionFixture):
    def setUp(self):
        self.sugar = self.ingredient("Sugar")
        self.recipe_row = self.recipe("Owned", yield_amount=100, yield_unit="g")
        self.item = self.line(self.recipe_row, 0, self.sugar, quantity=100)
        self.other = self.recipe("Other", yield_amount=100, yield_unit="g")
        RecipeShare.objects.create(recipe=self.recipe_row, recipient=self.editor, role=RecipeShare.EDITOR)
        RecipeShare.objects.create(recipe=self.recipe_row, recipient=self.viewer, role=RecipeShare.VIEWER)

    def test_the_serving_is_the_owners_to_set(self):
        body = {"recipeId": str(self.recipe_row.id), "amount": 50, "unit": "g"}
        self.assertEqual(recipe_actions.action_set_recipe_nutrition_serving(self.owner, body), {"ok": True})
        self.recipe_row.refresh_from_db()
        self.assertEqual(self.recipe_row.nutrition_serving_amount, Decimal("50"))
        self.assertEqual(self.recipe_row.nutrition_serving_unit, "g")
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            recipe_actions.action_set_recipe_nutrition_serving(self.editor, body)
        with self.assertRaisesMessage(ValueError, "supplied together"):
            recipe_actions.action_set_recipe_nutrition_serving(
                self.owner, {"recipeId": str(self.recipe_row.id), "amount": 50, "unit": ""}
            )
        with self.assertRaisesMessage(ValueError, "weight, volume or count"):
            recipe_actions.action_set_recipe_nutrition_serving(
                self.owner, {"recipeId": str(self.recipe_row.id), "amount": 1, "unit": "splash"}
            )
        recipe_actions.action_set_recipe_nutrition_serving(
            self.owner, {"recipeId": str(self.recipe_row.id), "amount": None, "unit": ""}
        )
        self.recipe_row.refresh_from_db()
        self.assertIsNone(self.recipe_row.nutrition_serving_amount)

    def test_the_package_is_the_owners_to_set(self):
        recipe_id = str(self.recipe_row.id)
        body = {"recipeId": recipe_id, "amount": 50, "unit": "g", "packageAmount": 250, "packageUnit": "g"}
        self.assertEqual(recipe_actions.action_set_recipe_nutrition_serving(self.owner, body), {"ok": True})
        self.recipe_row.refresh_from_db()
        self.assertEqual(self.recipe_row.nutrition_package_amount, Decimal("250"))
        self.assertEqual(self.recipe_row.nutrition_package_unit, "g")
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            recipe_actions.action_set_recipe_nutrition_serving(self.editor, body)
        with self.assertRaisesMessage(ValueError, "supplied together"):
            recipe_actions.action_set_recipe_nutrition_serving(
                self.owner, {**body, "packageAmount": 250, "packageUnit": ""}
            )
        # A body without the package keys leaves the package alone.
        recipe_actions.action_set_recipe_nutrition_serving(
            self.owner, {"recipeId": recipe_id, "amount": 60, "unit": "g"}
        )
        self.recipe_row.refresh_from_db()
        self.assertEqual(self.recipe_row.nutrition_serving_amount, Decimal("60"))
        self.assertEqual(self.recipe_row.nutrition_package_amount, Decimal("250"))
        # A package-only write cannot restore a stale serving from another tab.
        recipe_actions.action_set_recipe_nutrition_serving(
            self.owner,
            {
                "recipeId": recipe_id,
                "packageAmount": None,
                "packageUnit": "",
            },
        )
        self.recipe_row.refresh_from_db()
        self.assertEqual(self.recipe_row.nutrition_serving_amount, Decimal("60"))
        self.assertIsNone(self.recipe_row.nutrition_package_amount)
        self.assertEqual(self.recipe_row.nutrition_package_unit, "")

    def test_yield_after_cooking_is_an_editors_to_set_within_bounds(self):
        body = {"recipeId": str(self.recipe_row.id), "itemId": str(self.item.id), "percent": 0}
        before = self.recipe_row.edit_version
        # It bumps and echoes: save-recipe rewrites every line's yield too.
        self.assertEqual(
            recipe_actions.action_set_recipe_item_yield_after_cooking(self.editor, body),
            {"ok": True, "editVersion": before + 1},
        )
        self.item.refresh_from_db()
        self.recipe_row.refresh_from_db()
        self.assertEqual(self.item.efficiency_after_cooking, 0)
        self.assertEqual(self.recipe_row.edit_version, before + 1)
        with self.assertRaisesMessage(ValueError, "Recipe not found"):
            recipe_actions.action_set_recipe_item_yield_after_cooking(self.viewer, body)
        with self.assertRaisesMessage(ValueError, "between 0 and 100"):
            recipe_actions.action_set_recipe_item_yield_after_cooking(
                self.owner, {**body, "percent": 101}
            )
        with self.assertRaisesMessage(ValueError, "Recipe line not found"):
            recipe_actions.action_set_recipe_item_yield_after_cooking(
                self.owner, {**body, "recipeId": str(self.other.id)}
            )

    def test_the_save_path_bounds_yield_after_cooking_and_carries_the_serving(self):
        with self.assertRaisesMessage(ValueError, "between 0 and 100"):
            recipe_actions.action_save_recipe(
                self.owner,
                {
                    "id": str(self.recipe_row.id),
                    "title": self.recipe_row.title,
                    "items": [
                        {
                            "kind": "ingredient", "displayName": "Sugar", "quantity": 1,
                            "unit": "g", "preparationNote": "", "efficiencyAfterCooking": 150,
                            "ingredientId": str(self.sugar.id),
                        }
                    ],
                },
            )
        saved = recipe_actions.action_save_recipe(
            self.owner,
            {
                "id": None, "title": "Copy", "kind": "recipe", "status": "active",
                "nutritionServingAmount": 2, "nutritionServingUnit": "slice",
                "nutritionPackageAmount": 6, "nutritionPackageUnit": "slice",
                "servingAmount": 1, "servingUnit": "each", "menuPriceCents": 200,
            },
        )
        copy = Recipe.objects.get(id=saved["id"])
        self.assertEqual(copy.nutrition_serving_amount, Decimal("2"))
        self.assertEqual(copy.nutrition_serving_unit, "slice")
        self.assertEqual(copy.nutrition_package_amount, Decimal("6"))
        self.assertEqual(copy.nutrition_package_unit, "slice")
        self.assertEqual(copy.serving_amount, Decimal("1"))
        self.assertEqual(copy.serving_unit, "each")
        self.assertEqual(copy.menu_price_cents, 200)


@override_settings(FORKLUCK_SUPPORT_EMAIL="support@example.com")
class IngredientActionTests(NutritionFixture):
    def setUp(self):
        self.butter = self.ingredient("Butter", linked=False)

    def test_settings_update_only_the_keys_sent(self):
        body = {"ingredientId": str(self.butter.id), "labelName": "Cultured butter"}
        self.assertEqual(
            ingredient_actions.action_update_ingredient_nutrition_settings(self.owner, body),
            {"ok": True},
        )
        self.butter.refresh_from_db()
        self.assertEqual(self.butter.nutrition_label_name, "Cultured butter")
        self.assertFalse(self.butter.non_edible)
        ingredient_actions.action_update_ingredient_nutrition_settings(
            self.owner, {"ingredientId": str(self.butter.id), "nonEdible": True, "sugarsAreAdded": True}
        )
        self.butter.refresh_from_db()
        self.assertTrue(self.butter.non_edible)
        self.assertTrue(self.butter.sugars_are_added)
        self.assertEqual(self.butter.nutrition_label_name, "Cultured butter")
        with self.assertRaisesMessage(ValueError, "Ingredient not found"):
            ingredient_actions.action_update_ingredient_nutrition_settings(self.stranger, body)

    def request_body(self, **overrides):
        body = {
            "ingredientId": str(self.butter.id),
            "servingGrams": 14,
            "values": {
                "calories": 100, "fat": 11, "saturatedFat": 7, "sodiumMg": 90,
                "totalCarbohydrate": 0, "sugars": 0, "protein": 0,
                "transFat": 0, "cholesterolMg": 30, "fiber": None, "addedSugars": None,
                "vitaminDMcg": None, "calciumMg": None, "ironMg": None, "potassiumMg": None,
            },
            "source": "Kerrygold Pure Irish Butter, 8 oz",
            "note": "From the pack",
        }
        body.update(overrides)
        return body

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_a_request_is_stored_announced_and_unique_while_pending(self, notify):
        result = ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        row = NutritionRequest.objects.get(id=result["id"])
        self.assertEqual(result["status"], "pending")
        self.assertEqual(row.values["calories"], 100)
        self.assertIsNone(row.values["fiber"])
        self.assertAlmostEqual(row.per_100g["fat"], 11 / 14 * 100, places=3)
        self.assertIsNone(row.per_100g["vitaminDMcg"])
        notify.assert_called_once()
        self.assertEqual(notify.call_args.args[0], "support@example.com")
        with self.assertRaisesMessage(ValueError, "already waiting"):
            ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        with self.assertRaisesMessage(ValueError, "must be a number"):
            ingredient_actions.action_request_custom_nutrition(
                self.owner,
                self.request_body(ingredientId=str(self.ingredient("Flour").id),
                                  values={**self.request_body()["values"], "calories": None}),
            )

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_a_pending_request_reads_back_what_it_asked_for(self, notify):
        ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        row = Ingredient.objects.prefetch_related("nutrition_requests").get(id=self.butter.id)
        sent = ingredient_serializers.ingredient_json(row)["nutritionRequest"]
        self.assertEqual(sent["status"], "pending")
        self.assertEqual(sent["servingGrams"], 14.0)
        self.assertEqual(sent["source"], "Kerrygold Pure Irish Butter, 8 oz")
        self.assertEqual(sent["note"], "From the pack")
        self.assertEqual(sent["values"]["calories"], 100)
        self.assertEqual(sent["values"]["cholesterolMg"], 30)
        self.assertIsNone(sent["values"]["fiber"])
        self.assertEqual(len(sent["values"]), 15)

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_a_request_without_a_source_still_applies_under_the_old_wording(self, notify):
        result = ingredient_actions.action_request_custom_nutrition(
            self.owner, self.request_body(source="")
        )
        row = NutritionRequest.objects.get(id=result["id"])
        self.assertEqual(row.source, "")
        row.apply()
        self.butter.refresh_from_db()
        self.assertEqual(self.butter.nutrition_description, "Custom nutrition value")

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_a_mail_failure_or_no_address_keeps_the_request(self, notify):
        notify.side_effect = ValueError("mail down")
        result = ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        self.assertTrue(NutritionRequest.objects.filter(id=result["id"]).exists())
        notify.reset_mock()
        with override_settings(FORKLUCK_SUPPORT_EMAIL=""):
            ingredient_actions.action_request_custom_nutrition(
                self.owner, self.request_body(ingredientId=str(self.ingredient("Flour").id))
            )
        notify.assert_not_called()

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_requests_are_rate_limited(self, notify):
        for index in range(5):
            ingredient_actions.action_request_custom_nutrition(
                self.owner, self.request_body(ingredientId=str(self.ingredient(f"Row {index}", linked=False).id))
            )
        with self.assertRaisesMessage(ValueError, "Too many nutrition requests"):
            ingredient_actions.action_request_custom_nutrition(
                self.owner, self.request_body(ingredientId=str(self.ingredient("Row 6", linked=False).id))
            )

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_applying_writes_a_custom_source_and_refuses_to_overwrite_a_newer_link(self, notify):
        result = ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        row = NutritionRequest.objects.get(id=result["id"])
        # Clearing leaves the request waiting; linking after it is newer.
        ingredient_actions.action_clear_ingredient_nutrition(self.owner, {"ingredientId": str(self.butter.id)})
        row.refresh_from_db()
        self.assertEqual(row.status, "pending")
        Ingredient.objects.filter(id=self.butter.id).update(
            nutrition_per_100g=snapshot(), nutrition_source="usda_fdc",
            nutrition_updated_at=row.created_at + __import__("datetime").timedelta(minutes=1),
        )
        with self.assertRaisesMessage(ValueError, "newer record"):
            row.apply()
        row.apply(force=True)
        self.butter.refresh_from_db()
        row.refresh_from_db()
        self.assertEqual(self.butter.nutrition_source, "custom")
        self.assertEqual(
            self.butter.nutrition_description, "Kerrygold Pure Irish Butter, 8 oz"
        )
        self.assertAlmostEqual(self.butter.nutrition_per_100g["fat"], 11 / 14 * 100, places=3)
        self.assertEqual(row.status, "applied")
        self.assertIsNotNone(row.resolved_at)

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_merging_re_points_or_supersedes_a_pending_request(self, notify):
        target = self.ingredient("Target", linked=False)
        ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        ingredient_actions.action_merge_ingredients(
            self.owner, {"sourceId": str(self.butter.id), "targetId": str(target.id)}
        )
        self.assertEqual(NutritionRequest.objects.get(ingredient=target).status, "pending")
        # A second source with its own waiting request gives way to the target's.
        other = self.ingredient("Other", linked=False)
        ingredient_actions.action_request_custom_nutrition(
            self.owner, self.request_body(ingredientId=str(other.id))
        )
        ingredient_actions.action_merge_ingredients(
            self.owner, {"sourceId": str(other.id), "targetId": str(target.id)}
        )
        statuses = sorted(NutritionRequest.objects.filter(ingredient=target).values_list("status", flat=True))
        self.assertEqual(statuses, ["pending", "superseded"])

    @mock.patch("forkluck.domains.ingredients.actions.send_nutrition_request_notification")
    def test_deleting_the_ingredient_drops_its_requests(self, notify):
        result = ingredient_actions.action_request_custom_nutrition(self.owner, self.request_body())
        ingredient_actions.action_delete_ingredient(self.owner, {"id": str(self.butter.id)})
        self.assertFalse(NutritionRequest.objects.filter(id=result["id"]).exists())
