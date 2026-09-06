"""Focused tests for tenant-scoped browse and application search reads."""

import uuid
from datetime import timedelta
from decimal import Decimal
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.test.utils import CaptureQueriesContext

from .domains.ingredients import views as ingredient_views
from .domains.recipes.actions import action_save_recipe
from .domains.shared.ingredient_identity import recipes_using_ingredient
from .domains.recipes.health import (
    MeasureResolution,
    RecipeHealthReadModel,
    _ingredient_description,
    parse_ingredients,
)
from django.utils import timezone

from .models import (
    BenchCostRecipe,
    BenchCostSettings,
    BenchCostStep,
    BenchCostTiming,
    CatalogImportBatch,
    CatalogIngredient,
    CatalogIngredientMeasure,
    CatalogIngredientAllergen,
    CatalogProduct,
    CatalogSource,
    Ingredient,
    IngredientAllergenOverride,
    IngredientTag,
    RecipeLineMatch,
    IngredientConversion,
    IngredientMeasure,
    IngredientPrice,
    Preparation,
    Recipe,
    RecipeCategory,
    RecipeItem,
    SalesProduct,
    SalesProductComponent,
    SupplierItem,
    User,
)
from .testing import InternalApiTestCase, internal_payload


def _stocks(*names: str) -> dict:
    """Parser callbacks for a kitchen that stocks exactly these ingredients.

    A weight the text never states — a chart density, a profile each-weight, a
    bare count — belongs to the ingredient the line matched, so a test of that
    ladder has to say which names match. `RecipeHealthReadModel` supplies the
    real versions from the pantry.
    """
    known = {_ingredient_description(name)[1] for name in names}

    def density_name(name: str) -> str | None:
        base = _ingredient_description(name)[1]
        return base if base in known else None

    return {
        "resolve_density_name": density_name,
        "has_identity": lambda name: density_name(name) is not None,
    }



class BrowseApiTests(InternalApiTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = User.objects.create_user(
            email="browse@example.com",
            name="Browse Chef",
            password="a-long-test-passphrase-2468",
        )
        cls.other_user = User.objects.create_user(
            email="other-browse@example.com",
            name="Other Chef",
            password="another-long-passphrase-2468",
        )

    def setUp(self) -> None:
        self.client = Client()
        self.client.force_login(self.user)

    def ingredient(self, name: str, *, user: User | None = None) -> Ingredient:
        return Ingredient.objects.create(
            user=user or self.user,
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )

    def test_tag_filters_all_any_and_tenant_scope(self):
        first = self.ingredient("First")
        second = self.ingredient("Second")
        foreign = self.ingredient("Foreign", user=self.other_user)
        sweet = IngredientTag.objects.create(user=self.user, name="Sweet", normalized_name="sweet")
        baked = IngredientTag.objects.create(user=self.user, name="Baked", normalized_name="baked")
        foreign_tag = IngredientTag.objects.create(user=self.other_user, name="Sweet", normalized_name="sweet")
        first.tags.add(sweet, baked)
        second.tags.add(sweet)
        foreign.tags.add(foreign_tag)
        all_rows = self.get_internal("ingredients/", {"tag": f"{sweet.id},{baked.id}", "match": "all"})
        any_rows = self.get_internal("ingredients/", {"tag": f"{sweet.id},{baked.id}", "match": "any"})
        self.assertEqual([row["name"] for row in all_rows.json()["items"]], ["First"])
        self.assertEqual({row["name"] for row in any_rows.json()["items"]}, {"First", "Second"})
        self.assertNotIn("Foreign", {row["name"] for row in any_rows.json()["items"]})

    def test_effective_allergen_override_filter_and_facets(self):
        catalog = CatalogIngredient.objects.create(name="Milk")
        CatalogIngredientAllergen.objects.create(ingredient=catalog, allergen="milk", status="contains")
        row = Ingredient.objects.create(
            user=self.user, name="Oat milk", normalized_name="oat milk",
            catalog_ingredient=catalog, purchase_cost_cents=1000, purchase_size=1, purchase_unit="kg",
        )
        IngredientAllergenOverride.objects.create(ingredient=row, allergen="milk", status="doesNotContain")
        filtered = self.get_internal("ingredients/", {"allergen": "milk"})
        self.assertEqual(filtered.json()["items"], [])
        self.assertEqual(filtered.json()["facets"]["allergens"], [])
        detail = self.get_internal(f"ingredients/{row.public_id}/").json()["item"]
        self.assertEqual(detail["effectiveAllergens"][0]["status"], "doesNotContain")
        IngredientAllergenOverride.objects.filter(ingredient=row).delete()
        inherited = self.get_internal("ingredients/", {"allergen": "milk"})
        self.assertEqual([item["id"] for item in inherited.json()["items"]], [str(row.id)])

    def test_a_check_label_row_is_a_hint_and_reaches_no_effective_reader(self):
        catalog = CatalogIngredient.objects.create(name="Marinade")
        CatalogIngredientAllergen.objects.create(
            ingredient=catalog, allergen="soy", status="checkLabel"
        )
        row = Ingredient.objects.create(
            user=self.user, name="Marinade", normalized_name="marinade",
            catalog_ingredient=catalog, purchase_cost_cents=1000, purchase_size=1,
            purchase_unit="kg",
        )
        filtered = self.get_internal("ingredients/", {"allergen": "soy"})
        self.assertEqual(filtered.json()["items"], [])
        self.assertEqual(self.get_internal("ingredients/").json()["facets"]["allergens"], [])
        detail = self.get_internal(f"ingredients/{row.public_id}/").json()["item"]
        self.assertEqual(detail["effectiveAllergens"], [])
        self.assertEqual(detail["effectiveAllergenKeys"], [])
        self.assertEqual(detail["allergenHints"]["checkLabel"], ["soy"])

    def test_attention_filters_cover_price_size_and_unit(self):
        missing_price = self.ingredient("Missing price")
        missing_price.purchase_cost_cents = 0
        missing_price.save(update_fields=["purchase_cost_cents"])
        missing_size = self.ingredient("Missing size")
        missing_size.purchase_size = None
        missing_size.save(update_fields=["purchase_size"])
        missing_unit = self.ingredient("Missing unit")
        missing_unit.purchase_unit = ""
        missing_unit.save(update_fields=["purchase_unit"])
        for key, expected in {
            "missingPrice": "Missing price",
            "missingPurchaseSize": "Missing size",
            "missingPurchaseUnit": "Missing unit",
        }.items():
            response = self.get_internal("ingredients/", {"attention": key})
            self.assertEqual([row["name"] for row in response.json()["items"]], [expected])

    def test_kind_splits_the_pantry_from_the_supplies(self):
        flour = self.ingredient("Flour")
        boxes = self.ingredient("Takeout boxes")
        boxes.non_edible = True
        boxes.save(update_fields=["non_edible"])

        default = self.get_internal("ingredients/")
        self.assertEqual([row["name"] for row in default.json()["items"]], ["Flour"])
        self.assertEqual(default.json()["queryCount"], 1)
        supplies = self.get_internal("ingredients/", {"kind": "supply"})
        self.assertEqual(
            [row["name"] for row in supplies.json()["items"]], ["Takeout boxes"]
        )
        both = self.get_internal("ingredients/", {"kind": "all"})
        self.assertEqual(
            {row["name"] for row in both.json()["items"]}, {flour.name, boxes.name}
        )
        self.assertEqual(
            self.get_internal("ingredients/", {"kind": "cutlery"}).status_code, 400
        )

    def test_an_ingredient_reads_its_used_in_from_the_products_holding_it(self):
        """A recipe can never hold a supply, so products are its Used-in list.

        A product composes from ingredients directly too, so food answers the
        same way about the products naming it.
        """
        boxes = self.ingredient("Takeout boxes")
        boxes.non_edible = True
        boxes.save(update_fields=["non_edible"])
        flour = self.ingredient("Flour")
        soup = SalesProduct.objects.create(
            user=self.user, name="Soup", normalized_name="soup"
        )
        salad = SalesProduct.objects.create(
            user=self.user, name="Salad", normalized_name="salad", is_active=False
        )
        foreign = SalesProduct.objects.create(
            user=self.other_user, name="Foreign", normalized_name="foreign"
        )
        for product in (soup, salad, foreign):
            SalesProductComponent.objects.create(
                product=product,
                ingredient=boxes,
                quantity=Decimal("2.000"),
                unit="each",
            )
        SalesProductComponent.objects.create(
            product=soup, ingredient=flour, quantity=Decimal("1.000"), unit="kg"
        )

        detail = self.get_internal(f"ingredients/{boxes.public_id}/").json()["item"]
        self.assertEqual(
            detail["usedInProducts"],
            [
                {
                    "id": str(salad.id),
                    "publicId": salad.public_id,
                    "name": "Salad",
                    "isActive": False,
                    "quantity": 2.0,
                    "unit": "each",
                },
                {
                    "id": str(soup.id),
                    "publicId": soup.public_id,
                    "name": "Soup",
                    "isActive": True,
                    "quantity": 2.0,
                    "unit": "each",
                },
            ],
        )
        food = self.get_internal(f"ingredients/{flour.public_id}/").json()["item"]
        self.assertEqual(
            [
                (entry["name"], entry["quantity"], entry["unit"])
                for entry in food["usedInProducts"]
            ],
            [("Soup", 1.0, "kg")],
        )

    def test_delete_blocks_exact_and_saved_recipe_usage_without_substrings(self):
        onion = self.ingredient("Onion")
        Recipe.objects.create(user=self.user, title="Exact", body="1 cup Onion")
        Recipe.objects.create(user=self.user, title="Substring", body="1 cup Onionish")
        RecipeLineMatch.objects.create(user=self.user, text="yellow onion", ingredient=onion)
        Recipe.objects.create(user=self.user, title="Saved", body="1 cup Yellow onion")
        normalized = Recipe.objects.create(user=self.user, title="Normalized", body="")
        RecipeItem.objects.create(
            recipe=normalized,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Onion",
            quantity=1,
            unit="each",
            ingredient=onion,
        )
        response = self.post_internal("delete-ingredient", {"id": str(onion.id)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            {row["title"] for row in response.json()["usedInRecipes"]},
            {"Exact", "Saved", "Normalized"},
        )
        self.assertTrue(Ingredient.objects.filter(id=onion.id).exists())

    def test_delete_allows_an_unused_ingredient(self):
        onion = self.ingredient("Onion")
        Recipe.objects.create(user=self.other_user, title="Private", body="1 cup Onion")
        response = self.post_internal("delete-ingredient", {"id": str(onion.id)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertFalse(Ingredient.objects.filter(id=onion.id).exists())

    def test_the_default_ingredient_page_leads_with_the_most_recently_saved(self):
        """An ingredient is a document the chef authors, not a catalog row."""
        apricot = self.ingredient("Apricot")
        banana = self.ingredient("Banana")
        cocoa = self.ingredient("Cocoa")

        default = self.get_internal("ingredients/")
        self.assertEqual(
            [row["id"] for row in default.json()["items"]],
            [str(cocoa.id), str(banana.id), str(apricot.id)],
        )
        # Editing the oldest row carries it to the top.
        response = self.post_internal(
            "save-ingredient", {"id": str(apricot.id), "name": "Apricot, dried"}
        )
        self.assertEqual(response.status_code, 200, response.content)
        edited = self.get_internal("ingredients/")
        self.assertEqual(
            [row["id"] for row in edited.json()["items"]][0], str(apricot.id)
        )
        # The alphabet is still one click away.
        self.assertEqual(
            [row["id"] for row in self.get_internal(
                "ingredients/", {"order": "name"}
            ).json()["items"]],
            [str(apricot.id), str(banana.id), str(cocoa.id)],
        )

    def assert_ingredient_leads(self, ingredient: Ingredient) -> None:
        response = self.get_internal("ingredients/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["items"][0]["id"], str(ingredient.id))

    @mock.patch("forkluck.domains.ingredients.actions.get_food")
    def test_nutrition_source_edits_carry_the_ingredient_to_the_top(self, get_food):
        apricot = self.ingredient("Apricot")
        self.ingredient("Banana")
        get_food.return_value = (
            "Apricot",
            {"calories": 48, "protein": 1.4},
            "APRICOTS.",
        )

        response = self.post_internal(
            "set-ingredient-nutrition",
            {"ingredientId": str(apricot.id), "fdcId": 123},
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

        self.ingredient("Cocoa")
        response = self.post_internal(
            "clear-ingredient-nutrition", {"ingredientId": str(apricot.id)}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

    def test_allergen_edits_carry_the_ingredient_to_the_top(self):
        apricot = self.ingredient("Apricot")
        self.ingredient("Banana")

        response = self.post_internal(
            "replace-ingredient-allergens",
            {
                "ingredientId": str(apricot.id),
                "allergens": [{"key": "milk", "status": "contains"}],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

    def test_conversion_edits_carry_the_ingredient_to_the_top(self):
        apricot = self.ingredient("Apricot")
        self.ingredient("Banana")

        response = self.post_internal(
            "save-ingredient-conversion",
            {
                "ingredientId": str(apricot.id),
                "usesStandardConversion": False,
                "weight": {"amount": 100, "unit": "g"},
                "volume": {"amount": 1, "unit": "cup"},
                "each": None,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

        self.ingredient("Cocoa")
        response = self.post_internal(
            "reset-ingredient-conversion", {"ingredientId": str(apricot.id)}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

    def test_preparation_edits_carry_the_ingredient_to_the_top(self):
        apricot = self.ingredient("Apricot")
        self.ingredient("Banana")
        preparation = {
            "ingredientId": str(apricot.id),
            "id": None,
            "name": "Dried",
            "yieldPercent": 80,
            "usesStandardConversion": False,
            "weight": None,
            "volume": None,
            "each": None,
        }

        response = self.post_internal("save-preparation", preparation)
        self.assertEqual(response.status_code, 200, response.content)
        preparation_id = response.json()["id"]
        self.assert_ingredient_leads(apricot)

        self.ingredient("Cocoa")
        response = self.post_internal(
            "save-preparation",
            {**preparation, "id": preparation_id, "name": "Diced"},
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

        self.ingredient("Dates")
        response = self.post_internal(
            "delete-preparations", {"ids": [preparation_id]}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_ingredient_leads(apricot)

    def test_ingredients_are_searched_ordered_and_paginated_on_the_server(self):
        apricot = self.ingredient("Apricot")
        banana = self.ingredient("banana")
        cocoa = self.ingredient("Cocoa")
        self.ingredient("Dragonfruit", user=self.other_user)
        RecipeLineMatch.objects.create(
            user=self.user, text="yellow fruit", ingredient=banana
        )
        RecipeLineMatch.objects.create(
            user=self.other_user, text="private pantry term", ingredient=apricot
        )
        SupplierItem.objects.create(
            user=self.other_user,
            ingredient=apricot,
            supplier="private-supplier",
            external_id="PRIVATE-SKU",
            title="Private supplier title",
            raw_size="1 kg",
            pack_price_cents=1000,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
        )

        first = self.get_internal(
            "ingredients/", {"limit": "2", "order": "-name"}
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(
            [row["id"] for row in first.json()["items"]],
            [str(cocoa.id), str(banana.id)],
        )
        self.assertEqual(
            first.json()["meta"],
            {
                "pagination": {
                    "page": 1,
                    "limit": 2,
                    "pages": 2,
                    "total": 3,
                    "next": 2,
                    "prev": None,
                }
            },
        )

        second = self.get_internal(
            "ingredients/", {"page": "2", "limit": "2", "order": "-name"}
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            [row["id"] for row in second.json()["items"]], [str(apricot.id)]
        )
        self.assertEqual(second.json()["meta"]["pagination"]["prev"], 1)
        self.assertIsNone(second.json()["meta"]["pagination"]["next"])

        searched = self.get_internal("ingredients/", {"q": "yellow"})
        self.assertEqual(searched.status_code, 200)
        self.assertEqual(
            [row["id"] for row in searched.json()["items"]], [str(banana.id)]
        )
        self.assertEqual(searched.json()["meta"]["pagination"]["total"], 1)

        capped = self.get_internal("ingredients/", {"limit": "101"})
        self.assertEqual(capped.status_code, 200)
        self.assertEqual(capped.json()["meta"]["pagination"]["limit"], 100)

        private_search = self.get_internal(
            "ingredients/", {"q": "private pantry"}
        )
        self.assertEqual(private_search.status_code, 200)
        self.assertEqual(private_search.json()["items"], [])
        supplier_search = self.get_internal(
            "ingredients/", {"q": "PRIVATE-SKU"}
        )
        self.assertEqual(supplier_search.status_code, 200)
        self.assertEqual(supplier_search.json()["items"], [])

    def test_ingredient_options_keep_supplies_for_invoice_matching(self):
        boxes = self.ingredient("Takeout boxes")
        boxes.non_edible = True
        boxes.save(update_fields=["non_edible"])

        # An invoice line can name a supply, so this list stays whole; only the
        # pantry list and the recipe pickers split food from supplies.
        response = self.get_internal("ingredient-options/")

        rows = response.json()["items"]
        self.assertIn("Takeout boxes", [row["name"] for row in rows])
        # The picker groups on this flag, so a supply has to say it is one.
        self.assertIs(
            next(row for row in rows if row["name"] == "Takeout boxes")["nonEdible"],
            True,
        )

    def test_ingredient_options_are_lightweight_ordered_and_tenant_scoped(self):
        zest = self.ingredient("zest")
        first = self.ingredient("Apple")
        self.ingredient("Private salt", user=self.other_user)

        response = self.get_internal("ingredient-options/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "items": [
                    {"id": str(first.id), "name": "Apple", "nonEdible": False},
                    {"id": str(zest.id), "name": "zest", "nonEdible": False},
                ]
            },
        )

    def test_ingredient_options_stay_one_query(self):
        for name in ("Apple", "Butter", "Carrots"):
            self.ingredient(name)

        with self.assertNumQueries(
            1,
            msg=(
                "ingredient-options/ is one row read; a per-row query means "
                "the option shape started touching related tables."
            ),
        ):
            payload = internal_payload(ingredient_views.ingredient_options, self.user)

        self.assertEqual(len(payload["items"]), 3)

    def test_ingredient_tags_are_ordered_and_tenant_scoped(self):
        second = IngredientTag.objects.create(user=self.user, name="Produce")
        first = IngredientTag.objects.create(user=self.user, name="Bakery")
        IngredientTag.objects.create(user=self.other_user, name="Private")
        self.ingredient("Carrots").tags.add(second)

        response = self.get_internal("ingredient-tags/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "items": [
                    {"id": str(first.id), "name": "Bakery", "count": 0},
                    {"id": str(second.id), "name": "Produce", "count": 1},
                ]
            },
        )

    def test_ingredient_browse_reports_unfiltered_tenant_existence(self):
        self.ingredient("Butter")

        no_match = self.get_internal("ingredients/", {"q": "missing"})

        self.assertEqual(no_match.status_code, 200)
        self.assertEqual(no_match.json()["items"], [])
        self.assertEqual(no_match.json()["meta"]["pagination"]["total"], 0)
        self.assertTrue(no_match.json()["hasAnyIngredient"])

        self.client.force_login(self.other_user)
        empty_tenant = self.get_internal("ingredients/", {"q": "missing"})
        self.assertFalse(empty_tenant.json()["hasAnyIngredient"])

    def test_duplicate_suggestions_are_compact_and_tenant_scoped(self):
        first = self.ingredient("Baby Spinach")
        second = self.ingredient("Spinach Baby")
        typo = self.ingredient("Coriandar")
        typo_match = self.ingredient("Coriander")
        insertion = self.ingredient("Chocolate")
        insertion_match = self.ingredient("Chocolates")
        self.ingredient("Private Spinach", user=self.other_user)

        response = self.get_internal("ingredient-duplicates/")

        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        self.assertIn(
            {
                "leftId": str(first.id),
                "leftName": first.name,
                "rightId": str(second.id),
                "rightName": second.name,
                "reason": "Same words in a different order",
            },
            items,
        )
        self.assertIn(
            {
                "leftId": str(insertion.id),
                "leftName": insertion.name,
                "rightId": str(insertion_match.id),
                "rightName": insertion_match.name,
                "reason": "Names differ by one character",
            },
            items,
        )
        self.assertIn(
            {
                "leftId": str(typo.id),
                "leftName": typo.name,
                "rightId": str(typo_match.id),
                "rightName": typo_match.name,
                "reason": "Names differ by one character",
            },
            items,
        )
        self.assertLessEqual(len(items), 20)

    def test_recipe_health_parser_matches_the_editor_costing_subset(self):
        parsed = parse_ingredients(
            "\n".join(
                [
                    "1 1/2 kg Flour",
                    "Butter gr 810",
                    "Salt 2 oz",
                    "2 each eggs",
                    "1 cup Water",
                    "Bake at 350",
                    "Bake until 20",
                ]
            ),
            **_stocks("eggs", "Water"),
        )

        self.assertEqual(
            [row.name for row in parsed],
            ["Flour", "Butter", "Salt", "eggs", "Water"],
        )
        self.assertAlmostEqual(parsed[0].grams, 1500)
        self.assertAlmostEqual(parsed[1].grams, 810)
        self.assertAlmostEqual(parsed[2].grams, 56.69904625)
        self.assertAlmostEqual(parsed[3].grams, 100)
        self.assertAlmostEqual(parsed[4].grams, 236.6)

    def test_recipe_health_parser_weighs_a_volume_from_the_density_chart(self):
        # Parity with "weighs a volume from a typical density when nothing is
        # saved" in apps/web/tests/pricing.test.ts: with no persisted measure, both read
        # models weigh the line from data/volume-measures.json.
        parsed = parse_ingredients(
            "1 cup Bread Flour\n1 tbsp White Wine Vinegar",
            keep_unresolved_measures=True,
            **_stocks("Bread Flour", "White Wine Vinegar"),
        )

        self.assertAlmostEqual(parsed[0].grams, 127)
        self.assertAlmostEqual(parsed[1].grams, 14.9, places=1)

    def test_recipe_health_parser_refuses_a_weight_for_an_unmatched_name(self):
        # Parity with "gives an unmatched name no weight and no unit" in
        # apps/web/tests/recipe-parse.test.ts: with nothing matched, the density chart,
        # the each-weight profile and the bare-number reading all stay silent,
        # and the line keeps its amount and name so the cook can act on it.
        parsed = parse_ingredients(
            "1 chicken bouillon cube\n1 tbsp all purpose flour\n3 eggs",
            keep_unresolved_measures=True,
        )

        self.assertEqual(
            [
                (row.name, row.entered_amount, row.entered_unit, row.grams)
                for row in parsed
            ],
            [
                ("chicken bouillon cube", 1, None, None),
                ("all purpose flour", 1, "tbsp", None),
                ("eggs", 3, None, None),
            ],
        )

    def test_recipe_health_parser_reads_a_trailing_annotation_without_its_comma(self):
        # Parity with "reads a trailing annotation with or without its comma"
        # in apps/web/tests/recipe-parse.test.ts: a line that names no amount costs
        # nothing either way, so neither spelling is reported as a loss.
        parsed = parse_ingredients(
            "tbsp olive oil for brushing\ntbsp olive oil, for brushing",
            keep_unresolved_measures=True,
        )

        self.assertEqual(parsed, [])

    def test_recipe_health_parser_keeps_a_qualified_volume_unresolved(self):
        # Parity with "does not apply an unqualified measure to a qualified
        # ingredient" in apps/web/tests/recipe-parse.test.ts.
        parsed = parse_ingredients(
            "1 cup All-purpose flour (sifted)\n1 cup Brown sugar, packed",
            keep_unresolved_measures=True,
            **_stocks("All-purpose flour", "Brown sugar"),
        )

        self.assertEqual([row.grams for row in parsed], [None, None])

    def test_recipe_health_keeps_a_bare_preparation_word_in_the_identity(self):
        parsed = parse_ingredients(
            "1 cup Almond Sliced\n1 cup Almond, sliced",
            keep_unresolved_measures=True,
            **_stocks("Almond Sliced", "Almond"),
        )

        self.assertAlmostEqual(parsed[0].grams, 226.796185)
        self.assertIsNone(parsed[1].grams)

    def test_used_in_keeps_bare_identity_words_and_reads_explicit_preparations(self):
        almond = self.ingredient("Almond")
        almond_sliced = self.ingredient("Almond Sliced")
        bare = Recipe.objects.create(
            user=self.user, title="Bare", body="50 g almond sliced"
        )
        comma = Recipe.objects.create(
            user=self.user, title="Comma", body="50 g almond, sliced"
        )
        parenthetical = Recipe.objects.create(
            user=self.user, title="Parenthetical", body="50 g almond (sliced)"
        )

        self.assertEqual(recipes_using_ingredient(self.user, almond_sliced), [bare])
        self.assertEqual(
            {recipe.id for recipe in recipes_using_ingredient(self.user, almond)},
            {comma.id, parenthetical.id},
        )

    def test_a_preparation_a_recipe_line_names_refuses_to_be_deleted(self):
        onion = self.ingredient("Onion")
        diced = Preparation.objects.create(
            user=self.user,
            ingredient=onion,
            name="Diced",
            normalized_name="diced",
            yield_percent=Decimal("90"),
        )
        minced = Preparation.objects.create(
            user=self.user,
            ingredient=onion,
            name="Minced",
            normalized_name="minced",
            yield_percent=Decimal("88"),
        )
        soup = Recipe.objects.create(user=self.user, title="Soup", body="200 g onion")
        RecipeItem.objects.create(
            recipe=soup,
            kind=RecipeItem.INGREDIENT,
            position=0,
            display_name="Onion",
            quantity=Decimal("200"),
            unit="g",
            ingredient=onion,
            preparation_note="diced",
        )

        response = self.post_internal("delete-preparations", {"ids": [str(diced.id)]})
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(body["error"], "This preparation is used in recipes.")
        self.assertEqual(
            [entry["title"] for entry in body["usedInRecipes"]], ["Soup"]
        )
        self.assertTrue(Preparation.objects.filter(id=diced.id).exists())

        # The batch is refused whole: one used row keeps the unused one too.
        response = self.post_internal(
            "delete-preparations", {"ids": [str(diced.id), str(minced.id)]}
        )
        self.assertIn("error", response.json())
        self.assertTrue(Preparation.objects.filter(id=minced.id).exists())

        response = self.post_internal("delete-preparations", {"ids": [str(minced.id)]})
        self.assertEqual(response.json(), {"ok": True})
        self.assertFalse(Preparation.objects.filter(id=minced.id).exists())

    def test_recipe_health_parser_uses_standard_after_rejecting_a_generic_rule(self):
        # Parity with "does not read a generic rule out of a compound name" in
        # apps/web/tests/recipe-parse.test.ts.
        parsed = parse_ingredients(
            "1 cup Sugar Snap Peas\n1 cup Sugar",
            keep_unresolved_measures=True,
            **_stocks("Sugar Snap Peas", "Sugar"),
        )

        self.assertAlmostEqual(parsed[0].grams, 226.796185)
        self.assertAlmostEqual(parsed[1].grams, 200)

    def test_recipe_health_weighs_an_aliased_line_as_the_ingredient_it_prices(self):
        # Parity with "weighs the ingredient it is priced as, not the word it
        # was written as" in apps/web/tests/recipe-parse.test.ts: the alias target, not
        # the written word, chooses the density rule.
        oil = self.ingredient("Olive Oil")
        RecipeLineMatch.objects.create(
            user=self.user, text="flour", ingredient=oil
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Dressing",
            body="1 cup flour",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        priced = RecipeHealthReadModel(self.user).rows([recipe])[0]

        # 125 would be flour's density on an ingredient priced as olive oil.
        self.assertAlmostEqual(priced["ingredientCents"], 216)

    def test_recipe_health_parser_uses_standard_after_rejecting_a_phrase_rule(self):
        # Parity with "does not weigh a different product form as the rule's
        # ingredient" in apps/web/tests/recipe-parse.test.ts: the powder is not the
        # paste, and cocoa powder still resolves through its endings.
        parsed = parse_ingredients(
            "1 cup Peanut Butter Powder\n1 cup Cocoa Powder",
            keep_unresolved_measures=True,
            **_stocks("Peanut Butter Powder", "Cocoa Powder"),
        )

        self.assertAlmostEqual(parsed[0].grams, 226.796185)
        self.assertAlmostEqual(parsed[1].grams, 85)

    def test_recipe_health_prefers_known_density_to_the_standard_estimate(self):
        parsed = parse_ingredients(
            "1 cup Shiro Miso\n1 cup Pimentón de la Vera",
            keep_unresolved_measures=True,
            **_stocks("Shiro Miso", "Pimentón de la Vera"),
        )

        self.assertAlmostEqual(parsed[0].grams, 273)
        self.assertAlmostEqual(parsed[1].grams, 226.796185)

    def test_recipe_health_weighs_a_self_line_as_the_pantry_it_prices_as(self):
        # A component whose title collides with a renamed pantry entry prices
        # its self-line as the pantry item; density must resolve through the
        # same swapped map, or the editor weighs 127 g while backend health
        # reports the line unpriced.
        catalog_source = CatalogSource.objects.create(key="density-map")
        batch = CatalogImportBatch.objects.create(
            source=catalog_source,
            content_sha256="c" * 64,
            observed_at=timezone.now(),
        )
        catalog_flour = CatalogIngredient.objects.create(
            name="Bread Flour", normalized_name="bread flour", category="flour"
        )
        product = CatalogProduct.objects.create(
            source=catalog_source,
            import_batch=batch,
            ingredient=catalog_flour,
            external_id="density-flour-1",
            normalized_external_id="density-flour-1",
            title="Bread Flour",
            normalized_title="bread flour",
            raw_size="1 kg",
            pack_price_cents=1000,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
            observed_at=timezone.now(),
            is_recipe_ready=True,
        )
        pantry = self.ingredient("House Staple")
        pantry.catalog_product = product
        pantry.price_source = Ingredient.PriceSource.CATALOG
        pantry.save(
            update_fields=["catalog_product", "price_source", "updated_at"]
        )
        component = Recipe.objects.create(
            user=self.user,
            title="House Staple",
            kind=Recipe.KIND_COMPONENT,
            body="1 cup House Staple",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([component])[0]

        self.assertAlmostEqual(row["ingredientCents"], 127)
        self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_keeps_a_component_title_off_the_density_chart(self):
        # Parity with "keeps a component recipe off the chart when its title
        # collides" in apps/web/tests/recipe-parse.test.ts: a component named Honey is a
        # prepared thing with its own weight, not 340 g of raw honey.
        self.ingredient("Sugar")
        Recipe.objects.create(
            user=self.user,
            title="Honey",
            kind=Recipe.KIND_COMPONENT,
            body="100 g Sugar",
            yield_amount=500,
            yield_unit="g",
        )
        parent = Recipe.objects.create(
            user=self.user,
            title="Glaze",
            body="1 cup Honey",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([parent])[0]

        self.assertEqual(row["ingredientCents"], 0)
        self.assertIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_parser_costs_an_ingredients_only_block(self):
        # Parity with the TS parser test "costs an ingredients-only block" in
        # apps/web/tests/recipe-parse.test.ts. With method kept in its own field, an
        # authoritative ingredient block parses to exactly these grams in both
        # read models — including the unparenthesized container-weight line.
        parsed = parse_ingredients(
            "\n".join(
                [
                    "650 g Bread Flour",
                    "2 400 g cans Diced tomatoes",
                    "8 g Kosher Salt",
                ]
            )
        )

        self.assertEqual(
            [row.name for row in parsed],
            ["Bread Flour", "Diced tomatoes", "Kosher Salt"],
        )
        self.assertEqual([row.grams for row in parsed], [650, 800, 8])

    def test_recipe_health_parser_matches_fraction_and_explicit_marker_matrix(self):
        parsed = parse_ingredients(
            "½ cup Flour\n1½ cups Flour\n2 cups (120 g each) Flour\n"
            "2 cups (240 g total) Flour",
            resolve_measure=lambda amount, _unit, _name: MeasureResolution(
                grams=amount * 100, needs_review=False
            ),
        )

        self.assertEqual([row.grams for row in parsed], [50, 150, 240, 240])

    def test_recipe_health_parser_skips_numbered_method_steps(self):
        parsed = parse_ingredients(
            "\n".join(
                [
                    "1. Mix the dough",
                    "2) Rest 30 minutes",
                    "10 . Bake",
                    "1.5 kg Flour",
                    "2.5kg Sugar",
                ]
            ),
            keep_unresolved_measures=True,
        )

        self.assertEqual([row.name for row in parsed], ["Flour", "Sugar"])
        self.assertAlmostEqual(parsed[0].grams, 1500)
        self.assertAlmostEqual(parsed[1].grams, 2500)

    def test_recipe_health_parser_rejects_non_finite_amounts(self):
        too_large = "9" * 309
        conversion_overflow = "1" + "0" * 308

        parsed = parse_ingredients(
            f"{too_large} g Flour\n{conversion_overflow} kg Flour"
        )

        self.assertEqual(parsed, [])

    def test_recipe_health_preserves_annotated_each_lines_for_pricing(self):
        for annotation in ("room temperature", "divided"):
            with self.subTest(annotation=annotation):
                parsed = parse_ingredients(
                    f"2 each eggs ({annotation})", **_stocks("eggs")
                )
                self.assertEqual(len(parsed), 1)
                self.assertEqual(parsed[0].name, f"eggs ({annotation})")
                self.assertEqual(parsed[0].grams, 100)

    def test_annotated_each_line_prices_against_its_base_ingredient(self):
        self.ingredient("Eggs")
        recipe = Recipe.objects.create(
            user=self.user,
            title="Egg wash",
            body="2 each eggs (room temperature)",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        priced = RecipeHealthReadModel(self.user).rows([recipe])[0]
        self.assertAlmostEqual(priced["ingredientCents"], 100)
        self.assertNotIn("1 unpriced", priced["issues"])

    def test_recipe_health_resolves_saved_volume_measures_and_review_state(self):
        flour = self.ingredient("Flour")
        catalog_flour = CatalogIngredient.objects.create(
            name="Flour", normalized_name="flour"
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=catalog_flour,
            unit="cup",
            amount=1,
            grams=125,
            low_grams=100,
            high_grams=150,
            source_kind="public_food_data",
            source_ref="flour-cup",
            is_default=True,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Volume biscuits",
            body="2 cups Flour",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        catalog_row = RecipeHealthReadModel(self.user).rows([recipe])[0]
        self.assertAlmostEqual(catalog_row["ingredientCents"], 250)
        self.assertIn("1 estimate to review", catalog_row["issues"])

        IngredientMeasure.objects.create(
            ingredient=flour,
            unit="cup",
            amount=1,
            grams=130,
        )
        user_row = RecipeHealthReadModel(self.user).rows([recipe])[0]
        self.assertAlmostEqual(user_row["ingredientCents"], 260)
        self.assertNotIn("1 estimate to review", user_row["issues"])

    def test_recipe_health_picks_first_catalog_default_measure_on_a_score_tie(self):
        self.ingredient("Widget powder")
        catalog_powder = CatalogIngredient.objects.create(
            name="Widget powder", normalized_name="widget powder"
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=catalog_powder,
            unit="cup",
            amount=1,
            grams=120,
            source_kind="public_food_data",
            source_ref="widget-cup",
            is_default=True,
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=catalog_powder,
            unit="tbsp",
            amount=1,
            grams=100,
            source_kind="public_food_data",
            source_ref="widget-tbsp",
            is_default=True,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Widget dust",
            body="2 ml Widget powder",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([recipe])[0]

        self.assertAlmostEqual(row["ingredientCents"], 2 / 236.5882365 * 120)

    def test_recipe_health_does_not_write_bench_cost_settings(self):
        with CaptureQueriesContext(connection) as captured:
            RecipeHealthReadModel(self.user)

        self.assertEqual(
            [
                query["sql"]
                for query in captured.captured_queries
                if "INSERT" in query["sql"].upper()
            ],
            [],
        )
        self.assertFalse(BenchCostSettings.objects.filter(user=self.user).exists())

    def test_recipe_health_uses_one_exact_identity_for_measure_and_price(self):
        bread_flour = self.ingredient("Bread Flour")
        exact_flour = self.ingredient("AP flour")
        RecipeLineMatch.objects.create(
            user=self.user, text="ap flour", ingredient=bread_flour
        )
        IngredientMeasure.objects.create(
            ingredient=bread_flour,
            unit="cup",
            amount=1,
            grams=140,
        )
        IngredientMeasure.objects.create(
            ingredient=exact_flour,
            unit="cup",
            amount=1,
            grams=100,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Exact flour",
            body="1 cup AP flour",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([recipe])[0]

        self.assertAlmostEqual(row["ingredientCents"], 100)
        self.assertNotIn("1 unpriced", row["issues"])

    def test_recipe_health_costs_unknown_standard_measures_and_ranges(self):
        self.ingredient("Mystery sauce")
        recipe = Recipe.objects.create(
            user=self.user,
            title="Mystery batch",
            body=(
                "1 cup Mystery sauce\n1–2 cups Mystery sauce\n"
                "10–12 minutes rest"
            ),
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([recipe])[0]

        self.assertAlmostEqual(row["ingredientCents"], 453.59237)
        self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_does_not_override_a_custom_conversion(self):
        ingredient = self.ingredient("Mystery paste")
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=ingredient,
            average_weight=False,
            each_amount=1,
            each_unit="each",
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Custom mystery batch",
            body="1 cup Mystery paste",
            yield_amount=1,
            yield_unit="pcs",
        )

        row = RecipeHealthReadModel(self.user).rows([recipe])[0]

        self.assertIn("1 unpriced", row["issues"])

    def test_recipe_health_preserves_qualifiers_through_composed_annotations(self):
        flour = self.ingredient("Flour")
        IngredientMeasure.objects.create(
            ingredient=flour,
            unit="cup",
            amount=1,
            grams=120,
            qualifier="sifted",
        )
        for body in (
            "1 cup Flour (sifted), divided",
            "1 cup Flour (sifted) (divided)",
            "1 cup Flour, sifted (divided)",
        ):
            with self.subTest(body=body):
                recipe = Recipe.objects.create(
                    user=self.user,
                    title=f"Qualified {body}",
                    body=body,
                    yield_amount=1,
                    yield_unit="pcs",
                    serving_amount=1,
                    serving_unit="each",
                )
                row = RecipeHealthReadModel(self.user).rows([recipe])[0]
                self.assertAlmostEqual(row["ingredientCents"], 120)
                self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_uses_explicit_container_weights_before_measures(self):
        tomatoes = self.ingredient("Diced tomatoes")
        tomatoes.purchase_cost_cents = 1000
        tomatoes.save(update_fields=["purchase_cost_cents", "updated_at"])
        recipe = Recipe.objects.create(
            user=self.user,
            title="Tomato sauce",
            body="2 cans (14-ounce) Diced tomatoes",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([recipe])[0]

        self.assertAlmostEqual(row["ingredientCents"], 793.7866475)
        self.assertNotIn("1 unpriced", row["issues"])

    def test_recipe_health_excludes_self_component_but_keeps_same_name_pantry(self):
        pantry = self.ingredient("Starter")
        pantry.purchase_cost_cents = 1000
        pantry.save(update_fields=["purchase_cost_cents", "updated_at"])
        component = Recipe.objects.create(
            user=self.user,
            title="Starter",
            kind=Recipe.KIND_COMPONENT,
            body="50 g Starter",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([component])[0]

        self.assertAlmostEqual(row["ingredientCents"], 50)
        self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_excludes_self_component_during_measure_resolution(self):
        pantry = self.ingredient("Starter")
        IngredientMeasure.objects.create(
            ingredient=pantry,
            unit="cup",
            amount=1,
            grams=125,
        )
        component = Recipe.objects.create(
            user=self.user,
            title="Starter",
            kind=Recipe.KIND_COMPONENT,
            body="1 cup Starter",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([component])[0]

        self.assertAlmostEqual(row["ingredientCents"], 125)
        self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_prices_each_component_from_its_declared_piece_yield(self):
        self.ingredient("Flour")
        dough = Recipe.objects.create(
            user=self.user,
            title="Cookie dough",
            kind=Recipe.KIND_COMPONENT,
            body="70 g Flour",
            yield_amount=70,
            yield_unit="pcs",
        )
        Recipe.objects.create(
            user=self.user,
            title="Cookie jam",
            kind=Recipe.KIND_COMPONENT,
            body="80 g Flour",
            yield_amount=80,
            yield_unit="pcs",
        )
        cookie = Recipe.objects.create(
            user=self.user,
            title="Finished cookie",
            body="1 ea Cookie dough\n1 ea Cookie jam",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        for dashboard in (False, True):
            with self.subTest(dashboard=dashboard):
                row = RecipeHealthReadModel(
                    self.user, dashboard=dashboard
                ).rows([cookie])[0]
                # Flour costs 1 cent/g and each child batch declares how many
                # pieces it yields, so both child lines cost one cent.
                self.assertAlmostEqual(row["ingredientCents"], 2)
                self.assertNotIn("unpriced", " ".join(row["issues"]))

        self.assertEqual(dough.yield_amount, 70)

    # --- the component graph ------------------------------------------------

    def test_recipe_health_prices_a_component_inside_a_component(self):
        self.ingredient("Flour")
        Recipe.objects.create(
            user=self.user,
            title="Pastry cream",
            kind=Recipe.KIND_COMPONENT,
            body="1000 g Flour",
            yield_amount=1,
            yield_unit="kg",
        )
        # Pass 1 cannot price this against the pantry alone; pass 2 can, now
        # that "Pastry cream" is a source.
        Recipe.objects.create(
            user=self.user,
            title="Chocolate cream",
            kind=Recipe.KIND_COMPONENT,
            body="500 g Pastry cream",
            yield_amount=500,
            yield_unit="g",
        )
        tart = Recipe.objects.create(
            user=self.user,
            title="Cream tart",
            body="250 g Chocolate cream",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        for dashboard in (False, True):
            with self.subTest(dashboard=dashboard):
                row = RecipeHealthReadModel(
                    self.user, dashboard=dashboard
                ).rows([tart])[0]
                # Flour is 1 cent/g throughout, so the chain never marks it up.
                self.assertAlmostEqual(row["ingredientCents"], 250)
                self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_reports_a_component_that_only_names_a_component(self):
        # Three levels is one more than the two passes cover. The middle
        # component prices, the top one cannot, and it says why instead of
        # reporting a bare unpriced count.
        self.ingredient("Flour")
        Recipe.objects.create(
            user=self.user,
            title="Base",
            kind=Recipe.KIND_COMPONENT,
            body="1000 g Flour",
            yield_amount=1000,
            yield_unit="g",
        )
        Recipe.objects.create(
            user=self.user,
            title="Middle",
            kind=Recipe.KIND_COMPONENT,
            body="500 g Base",
            yield_amount=500,
            yield_unit="g",
        )
        top = Recipe.objects.create(
            user=self.user,
            title="Top",
            kind=Recipe.KIND_COMPONENT,
            body="250 g Middle",
            yield_amount=250,
            yield_unit="g",
        )

        row = RecipeHealthReadModel(self.user).rows([top])[0]

        self.assertIn("references another component", row["issues"])
        self.assertNotIn("1 unpriced", row["issues"])

    def test_recipe_health_leaves_a_self_referencing_component_unpriced(self):
        self.ingredient("Flour")
        loop = Recipe.objects.create(
            user=self.user,
            title="Loop",
            kind=Recipe.KIND_COMPONENT,
            body="100 g Flour\n100 g Loop",
            yield_amount=200,
            yield_unit="g",
        )
        user = Recipe.objects.create(
            user=self.user,
            title="Uses the loop",
            body="100 g Loop",
            yield_amount=1,
            yield_unit="pcs",
        )

        rows = RecipeHealthReadModel(self.user).rows([loop, user])

        # A self-reference names no other component, so the honest report is the
        # plain unpriced count — and the recipe never becomes a price source.
        self.assertIn("1 unpriced", rows[0]["issues"])
        self.assertNotIn("references another component", rows[0]["issues"])
        self.assertIn("1 unpriced", rows[1]["issues"])

    def test_recipe_health_leaves_a_two_component_cycle_unpriced(self):
        self.ingredient("Flour")
        first = Recipe.objects.create(
            user=self.user,
            title="Alpha",
            kind=Recipe.KIND_COMPONENT,
            body="100 g Flour\n100 g Beta",
            yield_amount=200,
            yield_unit="g",
        )
        second = Recipe.objects.create(
            user=self.user,
            title="Beta",
            kind=Recipe.KIND_COMPONENT,
            body="100 g Flour\n100 g Alpha",
            yield_amount=200,
            yield_unit="g",
        )

        rows = RecipeHealthReadModel(self.user).rows([first, second])

        self.assertIn("references another component", rows[0]["issues"])
        self.assertIn("references another component", rows[1]["issues"])

    def test_recipe_health_lets_a_component_win_a_name_tie_with_the_pantry(self):
        pantry = self.ingredient("Flour")
        bought = self.ingredient("Tomato sauce")
        bought.purchase_cost_cents = 5000
        bought.save(update_fields=["purchase_cost_cents", "updated_at"])
        Recipe.objects.create(
            user=self.user,
            title="Tomato sauce",
            kind=Recipe.KIND_COMPONENT,
            body="1000 g Flour",
            yield_amount=1000,
            yield_unit="g",
        )
        dish = Recipe.objects.create(
            user=self.user,
            title="Pasta",
            body="100 g Tomato sauce",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([dish])[0]

        # The made sauce costs the flour rate (1 cent/g), not the bought sauce's
        # 5 cents/g: the component wins the tie, which is what the editor's
        # component badge exists to disclose.
        self.assertAlmostEqual(row["ingredientCents"], 100)
        self.assertEqual(pantry.purchase_cost_cents, 1000)

    def test_recipe_health_costs_a_component_from_its_declared_weight_yield(self):
        self.ingredient("Flour")
        component = Recipe.objects.create(
            user=self.user,
            title="Reduced stock",
            kind=Recipe.KIND_COMPONENT,
            body="1000 g Flour",
            yield_amount=1000,
            yield_unit="g",
            serving_amount=1,
            serving_unit="kg",
        )
        dish = Recipe.objects.create(
            user=self.user,
            title="Soup",
            body="800 g Reduced stock",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        rows = RecipeHealthReadModel(self.user).rows([component, dish])

        # The component costs 1000 cents per declared kilogram; 800 g in the
        # parent therefore costs 800 cents.
        self.assertAlmostEqual(rows[0]["ingredientCents"], 1000)
        self.assertAlmostEqual(rows[1]["ingredientCents"], 800)

    def test_recipe_health_refuses_a_piece_yield_component_measured_by_weight(self):
        # A piece yield says nothing about finished weight, so pricing a gram
        # line off the component's raw input mass would invent a density.
        self.ingredient("Flour")
        Recipe.objects.create(
            user=self.user,
            title="Brioche dough",
            kind=Recipe.KIND_COMPONENT,
            body="1000 g Flour",
            yield_amount=24,
            yield_unit="pcs",
        )
        bun = Recipe.objects.create(
            user=self.user,
            title="Bun",
            body="200 g Brioche dough",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        row = RecipeHealthReadModel(self.user).rows([bun])[0]

        self.assertEqual(row["ingredientCents"], 0)
        self.assertIn("1 unpriced", row["issues"])

    def test_recipe_health_reaches_a_catalog_measure_through_a_profile_name(self):
        # `apps/web/lib/recipe/parse.ts` resolves a measure through the ingredient
        # profile, so "strong flour" reaches the "bread flour" catalog measure.
        # The read model must agree or the editor and the recipe list show two
        # different costs for the same line. `apps/web/tests/pricing.test.ts` pins the
        # other half of this pair.
        catalog = CatalogIngredient.objects.create(
            name="Bread flour", normalized_name="bread flour"
        )
        CatalogIngredientMeasure.objects.create(
            ingredient=catalog,
            unit="cup",
            amount=1,
            grams=136,
            source_kind="public_food_data",
            source_ref="profile-parity-cup",
            confidence="high",
            is_default=True,
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Profile loaf",
            body="2 cups strong flour",
            yield_amount=1,
            yield_unit="pcs",
        )

        parsed = parse_ingredients(
            recipe.body,
            resolve_measure=RecipeHealthReadModel(self.user)._resolve_measure,
            keep_unresolved_measures=True,
        )

        self.assertAlmostEqual(parsed[0].grams, 272)

    def test_save_recipe_ignores_the_retired_sellable_yield(self):
        result = action_save_recipe(
            self.user,
            {
                "title": "Tray cookies",
                "body": "",
                "yieldUnit": "pcs",
                "yieldAmount": 48,
                "sellableYield": 480,
            },
        )

        recipe = Recipe.objects.get(id=result["id"])
        self.assertIsNone(recipe.sellable_yield)

    def test_renaming_a_component_keeps_its_references_priced(self):
        self.ingredient("Flour")
        component = Recipe.objects.create(
            user=self.user,
            title="Tomato sauce",
            kind=Recipe.KIND_COMPONENT,
            body="1000 g Flour",
            yield_amount=1000,
            yield_unit="g",
        )
        dish = Recipe.objects.create(
            user=self.user,
            title="Pasta",
            body="100 g Tomato sauce",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        action_save_recipe(
            self.user,
            {
                "id": str(component.id),
                "title": "House tomato sauce",
                "kind": Recipe.KIND_COMPONENT,
                "body": component.body,
                "yieldUnit": "g",
                "yieldAmount": 1000,
            },
        )

        self.assertTrue(
            RecipeLineMatch.objects.filter(
                user=self.user,
                normalized_text="tomato sauce",
                component_recipe=component,
            ).exists()
        )
        row = RecipeHealthReadModel(self.user).rows([dish])[0]
        self.assertAlmostEqual(row["ingredientCents"], 100)
        self.assertNotIn("unpriced", " ".join(row["issues"]))

    def test_recipe_health_prefers_piece_yield_component_over_each_weight_profile(
        self,
    ):
        # A component whose title collides with the built-in 50 g egg profile
        # (`Egg`, `Eggs`, ...) must be resolved before the profile so it is
        # costed from its declared piece yield, not the invented 50 g weight.
        self.ingredient("Flour")
        egg = Recipe.objects.create(
            user=self.user,
            title="Egg",
            kind=Recipe.KIND_COMPONENT,
            body="70 g Flour",
            yield_amount=70,
            yield_unit="pcs",
        )
        Recipe.objects.create(
            user=self.user,
            title="Eggs",
            kind=Recipe.KIND_COMPONENT,
            body="80 g Flour",
            yield_amount=80,
            yield_unit="pcs",
        )
        omelette = Recipe.objects.create(
            user=self.user,
            title="Finished omelette",
            body="1 ea Egg\n1 ea Eggs",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        for dashboard in (False, True):
            with self.subTest(dashboard=dashboard):
                row = RecipeHealthReadModel(
                    self.user, dashboard=dashboard
                ).rows([omelette])[0]
                # Flour costs 1 cent/g and both component yields make their
                # line one cent. The 50 g profile would mis-cost the lines.
                self.assertAlmostEqual(row["ingredientCents"], 2)
                self.assertNotIn("unpriced", " ".join(row["issues"]))

        self.assertEqual(egg.yield_amount, 70)

    def test_duplicate_component_title_precedence_does_not_follow_edit_time(self):
        self.ingredient("Flour")
        lower_id = uuid.UUID("00000000-0000-0000-0000-000000000001")
        higher_id = uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff")
        lower = Recipe.objects.create(
            id=lower_id,
            user=self.user,
            title="Sauce",
            kind=Recipe.KIND_COMPONENT,
            body="100 g Flour",
            yield_amount=100,
            yield_unit="g",
        )
        higher = Recipe.objects.create(
            id=higher_id,
            user=self.user,
            title="Sauce",
            kind=Recipe.KIND_COMPONENT,
            body="100 g Flour",
            yield_amount=50,
            yield_unit="g",
        )
        consumer = Recipe.objects.create(
            user=self.user,
            title="Finished dish",
            body="10 g Sauce",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        # getRecipes() used title then id and its Map kept the final duplicate,
        # so the higher id is the compatibility winner regardless of edits.
        Recipe.objects.filter(pk=higher.pk).update(
            updated_at=lower.updated_at + timedelta(hours=1)
        )
        for dashboard in (False, True):
            with self.subTest(dashboard=dashboard, latest="higher id"):
                row = RecipeHealthReadModel(
                    self.user, dashboard=dashboard
                ).rows([consumer])[0]
                self.assertAlmostEqual(row["ingredientCents"], 20)

        Recipe.objects.filter(pk=lower.pk).update(
            updated_at=higher.updated_at + timedelta(hours=2)
        )
        for dashboard in (False, True):
            with self.subTest(dashboard=dashboard, latest="lower id"):
                row = RecipeHealthReadModel(
                    self.user, dashboard=dashboard
                ).rows([consumer])[0]
                self.assertAlmostEqual(row["ingredientCents"], 20)

    def test_recipe_health_reads_the_single_cost_entry_per_recipe(self):
        # This used to assert a legacy tie-break across duplicate cost entries.
        # Migration 0055 detached those duplicates and a (user, recipe) unique
        # constraint now makes the state unreachable, so what remains to pin is
        # that the one permitted record is the one selected, and that a second
        # is refused. The legacy tie-break itself is covered by
        # test_bench_cost_migration.
        recipe = Recipe.objects.create(
            user=self.user,
            title="Legacy cost",
            body="",
            yield_amount=1,
            yield_unit="pcs",
        )
        only = BenchCostRecipe.objects.create(
            user=self.user,
            recipe=recipe,
            name="First",
            batch_yield=1,
            position=0,
        )

        selected = RecipeHealthReadModel(self.user).costs_for([recipe.id])
        self.assertEqual(selected[str(recipe.id)].id, only.id)

        with self.assertRaises(IntegrityError), transaction.atomic():
            BenchCostRecipe.objects.create(
                user=self.user,
                recipe=recipe,
                name="Second",
                batch_yield=1,
                position=1,
            )

    def test_recipe_health_category_filter_omits_unused_categories(self):
        used = RecipeCategory.objects.create(
            user=self.user, name="Used", normalized_name="used"
        )
        RecipeCategory.objects.create(
            user=self.user, name="Orphaned", normalized_name="orphaned"
        )
        Recipe.objects.create(
            user=self.user,
            title="Categorized",
            category=used,
        )

        response = self.get_internal("recipe-health/")

        self.assertEqual(
            response.json()["categories"],
            [{"id": str(used.id), "label": "Used"}],
        )

    def test_ingredient_browse_rejects_invalid_query_values(self):
        self.ingredient("Butter")
        invalid_queries = [
            {"page": "0"},
            {"page": "not-a-page"},
            {"page": "2"},
            {"limit": "0"},
            {"limit": "1.5"},
            {"order": "packPriceCents"},
            {"status": "paused"},
            {"q": "x" * 201},
        ]
        for query in invalid_queries:
            with self.subTest(query=query):
                response = self.get_internal("ingredients/", query)
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json())

    def test_recipes_apply_owned_filters_search_and_ordering(self):
        breads = RecipeCategory.objects.create(
            user=self.user, name="Breads", normalized_name="breads"
        )
        desserts = RecipeCategory.objects.create(
            user=self.user, name="Desserts", normalized_name="desserts"
        )
        other_category = RecipeCategory.objects.create(
            user=self.other_user, name="Private", normalized_name="private"
        )
        alpha = Recipe.objects.create(
            user=self.user,
            title="Alpha loaf",
            code="RCP-010",
            category=breads,
        )
        beta = Recipe.objects.create(
            user=self.user,
            title="beta dough",
            code="RCP-011",
            kind=Recipe.KIND_COMPONENT,
            category=breads,
        )
        Recipe.objects.create(
            user=self.user,
            title="Gamma tart",
            code="RCP-012",
            status=Recipe.STATUS_ARCHIVED,
            category=desserts,
        )
        Recipe.objects.create(
            user=self.other_user,
            title="Private loaf",
            category=other_category,
        )
        misfiled = Recipe.objects.create(
            user=self.user,
            title="Unsorted roll",
            category=other_category,
        )
        RecipeLineMatch.objects.create(
            user=self.user, text="layered pastry", component_recipe=beta
        )
        RecipeLineMatch.objects.create(
            user=self.other_user, text="private recipe term", component_recipe=alpha
        )

        filtered = self.get_internal(
            "recipes/",
            {
                "q": "layered",
                "status": Recipe.STATUS_ACTIVE,
                "kind": Recipe.KIND_COMPONENT,
                "category": str(breads.id),
                "order": "name",
            },
        )
        self.assertEqual(filtered.status_code, 200)
        self.assertEqual(
            [row["id"] for row in filtered.json()["items"]], [str(beta.id)]
        )
        self.assertEqual(filtered.json()["items"][0]["categoryId"], str(breads.id))
        self.assertEqual(filtered.json()["meta"]["pagination"]["total"], 1)

        archived = self.get_internal(
            "recipes/", {"status": Recipe.STATUS_ARCHIVED}
        )
        self.assertEqual(archived.status_code, 200)
        self.assertEqual(
            [row["title"] for row in archived.json()["items"]], ["Gamma tart"]
        )
        components = self.get_internal(
            "recipes/", {"kind": Recipe.KIND_COMPONENT}
        )
        self.assertEqual(components.status_code, 200)
        self.assertEqual(
            [row["id"] for row in components.json()["items"]], [str(beta.id)]
        )
        categorized = self.get_internal(
            "recipes/", {"category": str(breads.id), "order": "name"}
        )
        self.assertEqual(categorized.status_code, 200)
        self.assertEqual(
            [row["id"] for row in categorized.json()["items"]],
            [str(alpha.id), str(beta.id)],
        )

        all_rows = self.get_internal(
            "recipes/", {"category": "", "order": "name", "limit": "2"}
        )
        self.assertEqual(all_rows.status_code, 200)
        self.assertEqual(
            [row["id"] for row in all_rows.json()["items"]],
            [str(alpha.id), str(beta.id)],
        )
        self.assertEqual(all_rows.json()["meta"]["pagination"]["total"], 4)

        private_search = self.get_internal("recipes/", {"q": "private recipe"})
        self.assertEqual(private_search.status_code, 200)
        self.assertEqual(private_search.json()["items"], [])
        category_search = self.get_internal("recipes/", {"q": "Private"})
        self.assertEqual(category_search.status_code, 200)
        self.assertEqual(category_search.json()["items"], [])
        misfiled_result = self.get_internal("recipes/", {"q": "Unsorted"})
        self.assertEqual(misfiled_result.status_code, 200)
        self.assertEqual(misfiled_result.json()["items"][0]["id"], str(misfiled.id))
        self.assertIsNone(misfiled_result.json()["items"][0]["categoryId"])
        self.assertIsNone(misfiled_result.json()["items"][0]["category"])

        by_category = self.get_internal("recipes/", {"order": "category"})
        self.assertEqual(by_category.status_code, 200)
        self.assertEqual(
            [row["title"] for row in by_category.json()["items"]],
            ["Alpha loaf", "beta dough", "Gamma tart", "Unsorted roll"],
        )
        by_category_desc = self.get_internal("recipes/", {"order": "-category"})
        self.assertEqual(by_category_desc.status_code, 200)
        self.assertEqual(
            [row["title"] for row in by_category_desc.json()["items"]],
            ["Gamma tart", "Alpha loaf", "beta dough", "Unsorted roll"],
        )

        invalid_queries = [
            {"status": "deleted"},
            {"kind": "menu-item"},
            {"category": "not-a-uuid"},
            {"category": str(other_category.id)},
            {"order": "title"},
        ]
        for query in invalid_queries:
            with self.subTest(query=query):
                response = self.get_internal("recipes/", query)
                self.assertEqual(response.status_code, 400)

    def test_search_index_is_minimal_deterministic_and_tenant_scoped(self):
        breads = RecipeCategory.objects.create(
            user=self.user, name="Breads", normalized_name="breads"
        )
        recipe = Recipe.objects.create(
            user=self.user,
            title="Zebra loaf",
            code="RCP-009",
            category=breads,
        )
        ingredient = self.ingredient("Apple")
        private_ingredient = self.ingredient("Private salt", user=self.other_user)
        Recipe.objects.create(user=self.other_user, title="Private recipe")
        private_category = RecipeCategory.objects.create(
            user=self.other_user,
            name="Secret category",
            normalized_name="secret category",
        )
        misfiled_recipe = Recipe.objects.create(
            user=self.user,
            title="Misfiled recipe",
            category=private_category,
        )
        RecipeLineMatch.objects.create(
            user=self.user, text="morning loaf", component_recipe=recipe
        )
        RecipeLineMatch.objects.create(
            user=self.user, text="orchard fruit", ingredient=ingredient
        )
        # Even an inconsistent cross-tenant row must not attach to a result.
        RecipeLineMatch.objects.create(
            user=self.user, text="leaking alias", ingredient=private_ingredient
        )

        response = self.get_internal("search-index/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "items": [
                    {
                        "label": "Misfiled recipe",
                        "href": f"/recipes/{misfiled_recipe.public_id}",
                        "type": "recipe",
                    },
                    {
                        "label": "Zebra loaf",
                        "href": f"/recipes/{recipe.public_id}",
                        "type": "recipe",
                    },
                    {
                        "label": "Apple",
                        "href": "/ingredients?q=Apple",
                        "type": "ingredient",
                    },
                ]
            },
        )

        searched = self.get_internal("search-index/", {"q": "morning"})
        self.assertEqual(
            [item["label"] for item in searched.json()["items"]],
            ["Zebra loaf"],
        )

    def test_search_index_is_bounded_before_the_palette_opens(self):
        for index in range(30):
            self.ingredient(f"Pantry {index:02d}")

        response = self.get_internal("search-index/")

        self.assertLessEqual(len(response.json()["items"]), 9)

    def test_search_index_rejects_query_keys_it_does_not_serve(self):
        self.assertEqual(
            self.get_internal("search-index/", {"sections": "recipes"}).status_code,
            400,
        )
        self.assertEqual(
            self.get_internal("search-index/", {"order": "name"}).status_code, 400
        )
        self.assertEqual(
            self.get_internal("search-index/", {"q": "x" * 201}).status_code, 400
        )

    def test_recipe_health_and_dashboard_are_compact_owned_read_models(self):
        flour = self.ingredient("Flour")
        flour.purchase_cost_cents = 1000
        flour.save(update_fields=["purchase_cost_cents", "updated_at"])
        IngredientPrice.objects.create(
            ingredient=flour,
            purchase_cost_cents=500,
            purchase_size=1,
            purchase_unit="kg",
            effective_at=flour.updated_at,
        )
        IngredientPrice.objects.create(
            ingredient=flour,
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
            effective_at=flour.updated_at + timedelta(seconds=1),
        )
        butter = self.ingredient("Butter")
        butter.purchase_cost_cents = 2000
        butter.save(update_fields=["purchase_cost_cents", "updated_at"])
        recipe = Recipe.objects.create(
            user=self.user,
            title="Biscuits",
            code="RCP-100",
            body="100 g Flour\n50 g Butter",
            yield_amount=10,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
            menu_price_cents=500,
        )
        cost = BenchCostRecipe.objects.create(
            user=self.user,
            recipe=recipe,
            name=recipe.title,
            batch_yield=10,
        )
        step = BenchCostStep.objects.create(
            recipe=cost, name="Mix", kind=BenchCostStep.Kind.ACTIVE
        )
        BenchCostTiming.objects.create(step=step, seconds=600, yield_count=10)
        self.ingredient("Flour", user=self.other_user).purchase_cost_cents = 1
        Recipe.objects.create(user=self.other_user, title="Private recipe")

        health_response = self.get_internal(
            "recipe-health/",
            {"status": "active", "kind": "recipe", "order": "name"},
        )
        self.assertEqual(health_response.status_code, 200)
        payload = health_response.json()
        self.assertEqual(len(payload["items"]), 1)
        health = payload["items"][0]
        self.assertEqual(health["id"], str(recipe.id))
        self.assertAlmostEqual(health["ingredientCents"], 20)
        self.assertAlmostEqual(health["foodCost"], 0.04)
        self.assertAlmostEqual(health["labor"]["centsPerPiece"], 100 / 3)
        self.assertEqual(health["issues"], [])
        self.assertNotIn("body", health)

        dashboard_response = self.get_internal("dashboard-overview/")
        self.assertEqual(dashboard_response.status_code, 200)
        dashboard = dashboard_response.json()
        self.assertEqual(dashboard["recipeMetrics"]["totalRecipes"], 1)
        self.assertEqual(dashboard["recipeMetrics"]["costedRecipes"], 1)
        self.assertEqual(dashboard["recipeMetrics"]["recipesNeedingAttention"], 0)
        self.assertEqual(len(dashboard["priceMoves"]), 1)
        self.assertEqual(dashboard["priceMoves"][0]["id"], str(flour.id))
        self.assertNotIn("recipes", dashboard)

    def test_ingredient_search_result_opens_matching_browse_state(self):
        for index in range(51):
            self.ingredient(f"Pantry item {index:02d}")
        target = self.ingredient("Zest & Salt")

        response = self.get_internal("search-index/")
        target_item = next(
            item
            for item in response.json()["items"]
            if item["label"] == target.name
        )
        self.assertEqual(target_item["href"], "/ingredients?q=Zest+%26+Salt")

        target_url = urlsplit(target_item["href"])
        target_query = parse_qs(target_url.query)["q"][0]
        browse = self.get_internal("ingredients/", {"q": target_query})
        self.assertEqual(
            [item["id"] for item in browse.json()["items"]],
            [str(target.id)],
        )

    def _prepped_cabbage(self) -> Ingredient:
        """A head bought by weight that measures differently once prepped.

        Whole it is 8 cups; shredded the same head is only 4; cooked it comes
        back at half its weight and says nothing about volume of its own.
        """
        cabbage = Ingredient.objects.create(
            user=self.user,
            name="Cabbage",
            normalized_name="cabbage",
            purchase_cost_cents=300,
            purchase_size=1000,
            purchase_unit="g",
        )
        IngredientConversion.objects.create(
            user=self.user,
            ingredient=cabbage,
            average_weight=False,
            volume_amount=8,
            volume_unit="cup",
        )
        Preparation.objects.create(
            user=self.user,
            ingredient=cabbage,
            name="Shredded",
            average_weight=False,
            weight_amount=1000,
            weight_unit="g",
            volume_amount=4,
            volume_unit="cup",
        )
        Preparation.objects.create(
            user=self.user,
            ingredient=cabbage,
            name="Cooked",
            average_weight=True,
            yield_percent=50,
        )
        return cabbage

    def _minced_garlic(self) -> Ingredient:
        garlic = Ingredient.objects.create(
            user=self.user,
            name="Garlic",
            normalized_name="garlic",
            purchase_cost_cents=400,
            purchase_size=1000,
            purchase_unit="g",
        )
        Preparation.objects.create(
            user=self.user,
            ingredient=garlic,
            name="Minced",
            average_weight=True,
            yield_percent=88,
        )
        return garlic

    def _cost_of(self, body: str) -> float:
        recipe = Recipe.objects.create(
            user=self.user,
            title=f"Dish {uuid.uuid4()}",
            body=body,
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )
        return RecipeHealthReadModel(self.user).rows([recipe])[0][
            "ingredientCents"
        ]

    def test_prepped_line_costs_through_the_preparations_own_conversion(self):
        # Parity with "uses the preparation's own conversion, not the
        # ingredient's" in apps/web/tests/pricing.test.ts. Two of the four cups a head
        # shreds to is half a $3.00 head; the ingredient's own
        # eight-cups-a-head row would have said $0.75.
        self._prepped_cabbage()

        self.assertAlmostEqual(self._cost_of("2 cup Cabbage, shredded"), 150)

    def test_prepped_line_buys_enough_raw_to_cover_the_yield(self):
        # Parity with "buys enough raw to cover a yield, not less". 100 g of
        # minced garlic at 88% yield needs 113.6 g of garlic bought, so the
        # line costs more than the same 100 g unprepped, never less.
        self._minced_garlic()

        cost = self._cost_of("100 g Garlic, minced")

        self.assertAlmostEqual(cost, 100 / 1000 * (100 / 88) * 400)
        self.assertGreater(cost, 40)

    def test_preparation_without_its_own_conversion_borrows_the_ingredients(self):
        # Parity with "borrows the ingredient's conversion when the
        # preparation states none": the pack it is bought as is its own row, so
        # two of the head's eight cups is a quarter head — doubled, because
        # half the weight cooks away.
        self._prepped_cabbage()

        self.assertAlmostEqual(self._cost_of("2 cup Cabbage, cooked"), 150)

    def test_qualifier_naming_no_preparation_costs_as_the_ingredient(self):
        self._prepped_cabbage()

        self.assertAlmostEqual(self._cost_of("2 cup Cabbage, chopped"), 75)

    def test_unqualified_line_never_picks_up_a_preparation(self):
        self._prepped_cabbage()

        self.assertAlmostEqual(self._cost_of("2 cup Cabbage"), 75)

    def test_multi_word_qualifier_matches_a_preparation_whole(self):
        garlic = self._minced_garlic()
        garlic.preparations.update(name="Finely Minced", normalized_name="finely minced")

        self.assertAlmostEqual(
            self._cost_of("100 g Garlic, finely minced"),
            100 / 1000 * (100 / 88) * 400,
        )
        # The same preparation does not answer a line naming only part of it.
        self.assertAlmostEqual(self._cost_of("100 g Garlic, minced"), 40)
