import json
from unittest import mock

from django.test import TestCase

from .domains.ingredients import actions
from .domains.shared.allergen_hints import (
    KEYWORDS,
    allergen_hints,
    ingredient_allergen_hints,
)
from .integrations.food_data import (
    PACKAGE_INGREDIENTS_LIMIT,
    get_food,
    label_nutrition_per_100g,
    nutrition_per_100g,
    search_foods,
)
from .models import (
    CatalogIngredient,
    CatalogIngredientAllergen,
    Ingredient,
    IngredientAllergenOverride,
    IngredientAllergenStatus,
    MasterPriceAccess,
    NutritionRequest,
    User,
)


class FoodDataAdapterTests(TestCase):
    def test_normalizes_usda_nutrients_and_converts_sodium_to_salt(self):
        profile = nutrition_per_100g(
            {
                "foodNutrients": [
                    {"nutrient": {"id": 1003}, "amount": 20},
                    {"nutrient": {"id": 1004}, "amount": 10},
                    {"nutrient": {"id": 1005}, "amount": 30},
                    {"nutrient": {"id": 1051}, "amount": 35},
                    {"nutrient": {"id": 1079}, "amount": 5},
                    {"nutrient": {"id": 1093}, "amount": 400},
                    {"nutrient": {"id": 2000}, "amount": 3},
                ]
            }
        )
        self.assertEqual(profile["salt"], 1)
        self.assertEqual(profile["sodiumMg"], 400)
        self.assertEqual(profile["totalCarbohydrate"], 30)
        self.assertEqual(profile["starch"], 22)
        self.assertEqual(profile["other"], 4)

    def test_reads_saturated_fat_without_counting_it_as_mass_beside_fat(self):
        # Saturates are a share of fat, so they are reported but must not shift
        # the mass accounting: starch and other stay where the proximates put
        # them whether or not 1258 is present.
        record = {
            "foodNutrients": [
                {"nutrient": {"id": 1003}, "amount": 20},
                {"nutrient": {"id": 1004}, "amount": 10},
                {"nutrient": {"id": 1005}, "amount": 30},
                {"nutrient": {"id": 1051}, "amount": 35},
                {"nutrient": {"id": 1079}, "amount": 5},
                {"nutrient": {"id": 1093}, "amount": 400},
                {"nutrient": {"id": 2000}, "amount": 3},
            ]
        }
        without = nutrition_per_100g(record)
        with_saturates = nutrition_per_100g(
            {"foodNutrients": [*record["foodNutrients"], {"nutrient": {"id": 1258}, "amount": 6}]}
        )
        # Absent is unknown, not zero: a label preview says "at least".
        self.assertIsNone(without["saturatedFat"])
        self.assertEqual(with_saturates["saturatedFat"], 6)
        self.assertEqual(with_saturates["fat"], without["fat"])
        self.assertEqual(with_saturates["starch"], without["starch"])
        self.assertEqual(with_saturates["other"], without["other"])

    def test_clamps_saturated_fat_that_exceeds_the_records_own_total_fat(self):
        profile = nutrition_per_100g(
            {
                "foodNutrients": [
                    {"nutrient": {"id": 1003}, "amount": 20},
                    {"nutrient": {"id": 1004}, "amount": 10},
                    {"nutrient": {"id": 1005}, "amount": 30},
                    {"nutrient": {"id": 1051}, "amount": 35},
                    {"nutrient": {"id": 1093}, "amount": 400},
                    {"nutrient": {"id": 1258}, "amount": 12},
                ]
            }
        )
        self.assertEqual(profile["saturatedFat"], 10)

    def test_accepts_a_foundation_record_without_sugars_or_fiber(self):
        # USDA Foundation entries (e.g. all-purpose flours) often publish no
        # sugars or fiber analysis at all; those default to zero rather than
        # rejecting the food.
        profile = nutrition_per_100g(
            {
                "foodNutrients": [
                    {"nutrient": {"id": 1003}, "amount": 10},
                    {"nutrient": {"id": 1004}, "amount": 1},
                    {"nutrient": {"id": 1005}, "amount": 76},
                    {"nutrient": {"id": 1051}, "amount": 12},
                    {"nutrient": {"id": 1093}, "amount": 2},
                ]
            }
        )
        self.assertEqual(profile["sugars"], 0)
        self.assertEqual(profile["fiber"], 0)
        self.assertEqual(profile["starch"], 76)

    def test_accepts_salt_which_publishes_no_macronutrients(self):
        # Real values from Foundation fdcId 746775.
        profile = nutrition_per_100g(
            {
                "foodNutrients": [
                    {"nutrient": {"id": 1051}, "amount": 0.42},
                    {"nutrient": {"id": 1093}, "amount": 38700},
                ]
            }
        )
        self.assertEqual(profile["sodiumMg"], 38700)
        self.assertEqual(profile["salt"], 96.75)
        self.assertEqual(profile["protein"], 0)
        self.assertEqual(profile["totalCarbohydrate"], 0)
        self.assertEqual(profile["water"], 0.42)

    def test_accepts_baking_soda_whose_mass_is_neither_macro_nor_ash(self):
        # Real values from SR Legacy: bicarbonate accounts for only 69 g.
        profile = nutrition_per_100g(
            {
                "foodNutrients": [
                    {"nutrient": {"id": 1051}, "amount": 0.2},
                    {"nutrient": {"id": 1007}, "amount": 36.9},
                    {"nutrient": {"id": 1093}, "amount": 27400},
                ]
            }
        )
        self.assertEqual(profile["sodiumMg"], 27400)

    def test_reads_nlea_total_fat_when_a_foundation_record_states_only_that(self):
        # USDA's Foundation "Oil, canola" (748278) carries fat under 1085
        # alone, with no water or energy; it is a complete record of an oil.
        composition = nutrition_per_100g(
            {
                "dataType": "Foundation",
                "foodNutrients": [
                    {"nutrient": {"id": 1085}, "amount": 94.5},
                    {"nutrient": {"id": 1258}, "amount": 6.61},
                ],
            }
        )
        self.assertEqual(composition["fat"], 94.5)
        self.assertEqual(composition["saturatedFat"], 6.61)
        self.assertEqual(composition["water"], 0)
        self.assertIsNone(composition["calories"])

    def test_a_branded_label_derives_its_water_and_keeps_its_brand(self):
        # A transcribed package states no water or ash; the mass it does
        # state leaves the rest over as water, and the floor does not apply.
        record = {
            "dataType": "Branded",
            "description": "ORGANIC TAMARI",
            "brandOwner": "San-J",
            "foodNutrients": [
                {"nutrientId": 1003, "value": 10},
                {"nutrientId": 1004, "value": 0},
                {"nutrientId": 1005, "value": 5},
                {"nutrientId": 1093, "value": 5000},
                {"nutrientId": 1110, "value": 40},
            ],
        }
        composition = nutrition_per_100g(record)
        self.assertAlmostEqual(composition["water"], 100 - 10 - 0 - 5 - 12.5, places=3)
        self.assertEqual(composition["vitaminDMcg"], 1)
        self.assertIsNone(composition["calciumMg"])
        self.assertIsNone(composition["saturatedFat"])

    def test_a_typed_label_becomes_a_per_100g_snapshot_with_blanks_kept(self):
        composition = label_nutrition_per_100g(
            {
                "calories": 100, "fat": 11, "saturatedFat": 7, "sodiumMg": 90,
                "totalCarbohydrate": 0, "sugars": 0, "protein": 0,
                "transFat": 0, "cholesterolMg": 30, "fiber": None,
                "addedSugars": None, "vitaminDMcg": None, "calciumMg": None,
                "ironMg": None, "potassiumMg": None,
            },
            14,
        )
        self.assertAlmostEqual(composition["fat"], 11 / 14 * 100, places=3)
        self.assertAlmostEqual(composition["saturatedFat"], 7 / 14 * 100, places=3)
        self.assertAlmostEqual(composition["calories"], 100 / 14 * 100, places=3)
        self.assertIsNone(composition["vitaminDMcg"])
        self.assertAlmostEqual(
            composition["water"] + composition["fat"] + composition["protein"]
            + composition["sugars"] + composition["starch"] + composition["fiber"]
            + composition["salt"] + composition["other"],
            100,
            places=3,
        )
        with self.assertRaises(ValueError):
            label_nutrition_per_100g({"calories": 1}, 0)

    def test_rejects_a_record_that_omits_required_nutrients(self):
        with self.assertRaisesMessage(
            ValueError, "does not include complete nutrition data"
        ):
            nutrition_per_100g(
                {
                    "foodNutrients": [
                        {"nutrient": {"id": 1003}, "amount": 20},
                        {"nutrient": {"id": 1004}, "amount": 10},
                        {"nutrient": {"id": 1005}, "amount": 30},
                    ]
                }
            )

    @mock.patch("forkluck.integrations.food_data.urlopen")
    @mock.patch.dict("os.environ", {"FDC_API_KEY": "test-key"})
    def test_search_sends_key_outside_the_response(self, mocked_urlopen):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "foods": [
                    {
                        "fdcId": 123,
                        "description": "PORK, GROUND",
                        "dataType": "Foundation",
                    }
                ]
            }
        ).encode()
        mocked_urlopen.return_value = response
        self.assertEqual(search_foods("ground pork")[0].fdc_id, 123)
        self.assertNotIn("test-key", str(search_foods("ground pork")[0].as_json()))

    @mock.patch("forkluck.integrations.food_data.urlopen")
    @mock.patch.dict("os.environ", {"FDC_API_KEY": "test-key"})
    def test_search_scope_picks_the_data_types_and_carries_the_brand(self, mocked_urlopen):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "foods": [
                    {
                        "fdcId": 9,
                        "description": "TAMARI",
                        "dataType": "Branded",
                        "brandOwner": "San-J",
                    }
                ]
            }
        ).encode()
        mocked_urlopen.return_value = response
        match = search_foods("tamari", scope="branded")[0]
        self.assertEqual(match.as_json()["brand"], "San-J")
        sent = json.loads(mocked_urlopen.call_args.args[0].data)
        self.assertEqual(sent["dataType"], ["Branded"])
        search_foods("tamari")
        sent = json.loads(mocked_urlopen.call_args.args[0].data)
        self.assertEqual(sent["dataType"], ["Foundation", "SR Legacy", "Survey (FNDDS)"])

    @mock.patch("forkluck.integrations.food_data.urlopen")
    @mock.patch.dict("os.environ", {"FDC_API_KEY": "test-key"})
    def test_search_surfaces_the_staple_above_composite_foods(self, mocked_urlopen):
        # FDC's own relevance order for "sugar" puts composite foods first;
        # the staple whose name leads with the query must come out on top.
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "foods": [
                    {
                        "fdcId": 1,
                        "description": "Beverages, tea, with sugar",
                        "dataType": "SR Legacy",
                    },
                    {
                        "fdcId": 2,
                        "description": "Gum drops, no sugar",
                        "dataType": "SR Legacy",
                    },
                    {
                        "fdcId": 3,
                        "description": "Sugar, white, granulated or lump",
                        "dataType": "Survey (FNDDS)",
                    },
                    {
                        "fdcId": 4,
                        "description": "Sugars, granulated",
                        "dataType": "Foundation",
                    },
                    {
                        "fdcId": 5,
                        "description": "Honey",
                        "dataType": "Foundation",
                    },
                ]
            }
        ).encode()
        mocked_urlopen.return_value = response
        results = search_foods("sugar")
        self.assertEqual([match.fdc_id for match in results], [4, 3, 1, 2, 5])
        # The request asks FDC for a deeper page than the eight rows shown.
        payload = json.loads(mocked_urlopen.call_args[0][0].data)
        self.assertEqual(payload["pageSize"], 40)


# Real branded ingredient strings from FoodData Central, trimmed to the part
# each case is about. Hard-coded: the parser is pinned against the shapes
# packages actually use, and the suite never reaches the network.
SANDWICH_COOKIES = (
    "ENRICHED FLOUR (WHEAT FLOUR, NIACIN, REDUCED IRON, THIAMINE "
    "MONONITRATE, RIBOFLAVIN, FOLIC ACID), SUGAR, PEANUT BUTTER (PEANUTS, "
    "CORN SYRUP SOLIDS, SALT), SOYBEAN OIL, HIGH FRUCTOSE CORN SYRUP, "
    "SOY LECITHIN (EMULSIFIER), VANILLIN - AN ARTIFICIAL FLAVOR. "
    "CONTAINS: WHEAT, PEANUT, AND SOY."
)
GLUTEN_FREE_COOKIE = (
    "SESAME MEAL, PALM SHORTENING (NON-HYDROGENATED), CHOCOLATE CHIP "
    "(EVAPORATED CANE JUICE, NATURAL CHOCOLATE LIQUOR, COCOA BUTTER), "
    "WATER, CHICORY EXTRACT, FLAX MEAL, BAKING POWDER (ALUMINUM-FREE, "
    "GLUTEN-FREE), SEA SALT, BAKING SODA (ALUMINUM-FREE, GLUTEN FREE)"
)
WORCESTERSHIRE = (
    "DISTILLED VINEGAR, WATER, MOLASSES, SUGAR, SALT, SPICES, CITRIC ACID, "
    "ANCHOVY (FISH), CELERY SEED, NATURAL FLAVOR (CONTAINS SOY), XANTHAN "
    "GUM (THICKENER), GARLIC POWDER & TAMARIND EXTRACT."
)


class AllergenHintParserTests(TestCase):
    def test_a_trailing_contains_sentence_joins_the_ingredient_scan(self):
        self.assertEqual(
            allergen_hints(SANDWICH_COOKIES),
            {
                "contains": ["gluten_cereals", "peanut", "soy", "wheat"],
                "mayContain": [],
            },
        )

    def test_a_gluten_free_claim_and_a_cocoa_butter_name_nothing_they_are_not(self):
        self.assertEqual(
            allergen_hints(GLUTEN_FREE_COOKIE),
            {"contains": ["sesame"], "mayContain": []},
        )

    def test_a_parenthesised_species_and_an_inline_contains_are_both_read(self):
        self.assertEqual(
            allergen_hints(WORCESTERSHIRE),
            {"contains": ["celery", "fish", "soy"], "mayContain": []},
        )

    def test_a_may_contain_sentence_is_a_separate_list_and_never_the_scan(self):
        text = (
            "SUGAR, COCOA MASS, COCOA BUTTER, SUNFLOWER LECITHIN. "
            "MAY CONTAIN MILK, HAZELNUTS AND WHEAT."
        )
        self.assertEqual(
            allergen_hints(text),
            {
                "contains": [],
                "mayContain": ["gluten_cereals", "milk", "tree_nuts", "wheat"],
            },
        )

    def test_shared_equipment_and_facility_sentences_are_may_contain(self):
        facility = (
            "OATS, RAISINS. "
            "MANUFACTURED IN A FACILITY THAT ALSO PROCESSES PEANUTS."
        )
        self.assertEqual(
            allergen_hints(facility),
            {"contains": ["gluten_cereals"], "mayContain": ["peanut"]},
        )
        equipment = "RICE FLOUR, SALT. PRODUCED ON SHARED EQUIPMENT WITH SOY."
        self.assertEqual(
            allergen_hints(equipment),
            {"contains": [], "mayContain": ["soy"]},
        )
        also = "RICE FLOUR. MAY ALSO CONTAIN SESAME SEEDS."
        self.assertEqual(
            allergen_hints(also),
            {"contains": [], "mayContain": ["sesame"]},
        )

    def test_a_key_declared_as_contains_is_not_also_a_may_contain(self):
        text = "WHEAT FLOUR, MILK. CONTAINS: MILK. MAY CONTAIN MILK AND SOY."
        self.assertEqual(
            allergen_hints(text),
            {
                "contains": ["gluten_cereals", "milk", "wheat"],
                "mayContain": ["soy"],
            },
        )

    def test_the_milk_exclusions_never_fire_the_dairy_tag(self):
        for text in (
            "COCONUT MILK, WATER",
            "ALMOND MILK, SEA SALT",
            "OAT MILK",
            "SOY MILK",
            "RICE MILK",
            "SUGAR, COCOA BUTTER",
            "SHEA BUTTER",
            "PEANUT BUTTER, SALT",
            "ALMOND BUTTER",
            "ORGANIC NUT BUTTER",
            "BUTTERNUT SQUASH",
            "BAKING SODA, CREAM OF TARTAR",
        ):
            with self.subTest(text=text):
                self.assertNotIn("milk", allergen_hints(text)["contains"])

    def test_the_excluded_phrase_still_names_its_own_tag(self):
        self.assertEqual(allergen_hints("PEANUT BUTTER")["contains"], ["peanut"])
        self.assertEqual(allergen_hints("ALMOND MILK")["contains"], ["tree_nuts"])
        self.assertEqual(
            allergen_hints("GLUTEN FREE OATS")["contains"], ["gluten_cereals"]
        )

    def test_matching_is_whole_word_and_case_insensitive_with_plurals(self):
        self.assertEqual(allergen_hints("Eggplant, maltodextrin")["contains"], [])
        self.assertEqual(allergen_hints("eggs, ALMONDS")["contains"], ["egg", "tree_nuts"])
        self.assertEqual(allergen_hints("Sodium Metabisulfite")["contains"], ["sulphites"])
        self.assertEqual(allergen_hints("SULFUR DIOXIDE")["contains"], ["sulphites"])

    def test_every_tag_has_at_least_one_keyword_that_reaches_it(self):
        for tag, keywords in KEYWORDS.items():
            with self.subTest(tag=tag):
                self.assertIn(tag, allergen_hints(f"water, {keywords[0]}, salt")["contains"])

    def test_a_blank_or_wordless_package_hints_nothing(self):
        for text in ("", "   ", "WATER, SUGAR, SALT."):
            with self.subTest(text=text):
                self.assertEqual(
                    allergen_hints(text), {"contains": [], "mayContain": []}
                )


class PackageIngredientsTests(TestCase):
    @mock.patch("forkluck.integrations.food_data.urlopen")
    @mock.patch.dict("os.environ", {"FDC_API_KEY": "test-key"})
    def _fetch(self, record, mocked_urlopen):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(record).encode()
        mocked_urlopen.return_value = response
        return get_food(1)

    def test_a_branded_record_carries_its_ingredient_list_stripped(self):
        _, _, package = self._fetch(
            {
                "dataType": "Branded",
                "description": "SANDWICH COOKIES",
                "ingredients": f"  {SANDWICH_COOKIES}  ",
                "foodNutrients": [{"nutrientId": 1003, "value": 5}],
            }
        )
        self.assertEqual(package, SANDWICH_COOKIES)

    def test_a_common_food_states_no_package_and_a_long_one_is_capped(self):
        _, _, package = self._fetch(
            {
                "dataType": "Foundation",
                "description": "Apples, raw",
                "foodNutrients": [
                    {"nutrientId": 1003, "value": 0},
                    {"nutrientId": 1051, "value": 85},
                ],
            }
        )
        self.assertEqual(package, "")
        _, _, capped = self._fetch(
            {
                "dataType": "Branded",
                "description": "LONG",
                "ingredients": "SALT, " * 2000,
                "foodNutrients": [{"nutrientId": 1003, "value": 5}],
            }
        )
        self.assertEqual(len(capped), PACKAGE_INGREDIENTS_LIMIT)


class IngredientAllergenHintTests(TestCase):
    """What one ingredient suggests, and what it has stopped suggesting."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="hints@example.com", password="a-long-test-passphrase-2468", name="Chef"
        )
        self.catalog = CatalogIngredient.objects.create(
            name="Hint soy sauce", normalized_name="hint soy sauce"
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Soy sauce",
            normalized_name="soy sauce",
            catalog_ingredient=self.catalog,
            purchase_cost_cents=500,
            purchase_size=1,
            purchase_unit="l",
            nutrition_package_ingredients=(
                "WATER, WHEAT, SOYBEANS, SALT. MAY CONTAIN FISH."
            ),
        )

    def hints(self):
        row = Ingredient.objects.select_related("catalog_ingredient").get(
            id=self.ingredient.id
        )
        return ingredient_allergen_hints(row)

    def catalog_row(self, allergen, status):
        CatalogIngredientAllergen.objects.create(
            ingredient=self.catalog,
            allergen=allergen,
            status=status,
            source_kind="catalog",
            source_ref="hint-soy-sauce",
        )

    def test_the_package_text_supplies_both_hint_lists(self):
        self.assertEqual(
            self.hints(),
            {
                "contains": ["gluten_cereals", "soy", "wheat"],
                "mayContain": ["fish"],
                "checkLabel": [],
            },
        )

    def test_a_brand_dependent_catalog_row_is_a_check_label_hint(self):
        self.catalog_row("sulphites", IngredientAllergenStatus.CHECK_LABEL)
        self.assertEqual(self.hints()["checkLabel"], ["sulphites"])

    def test_a_user_decision_of_any_status_retires_the_hint(self):
        self.catalog_row("sulphites", IngredientAllergenStatus.CHECK_LABEL)
        for allergen, status in (
            ("wheat", "contains"),
            ("fish", "doesNotContain"),
            ("sulphites", "mayContain"),
        ):
            IngredientAllergenOverride.objects.create(
                ingredient=self.ingredient, allergen=allergen, status=status
            )
        self.assertEqual(
            self.hints(),
            {"contains": ["gluten_cereals", "soy"], "mayContain": [], "checkLabel": []},
        )

    def test_a_catalog_assertion_retires_the_contains_hint_it_already_makes(self):
        self.catalog_row("soy", IngredientAllergenStatus.CONTAINS)
        self.assertEqual(self.hints()["contains"], ["gluten_cereals", "wheat"])

    def test_the_package_answer_swallows_the_check_label_question(self):
        # The catalog says "check for soy"; the package says soy is in it.
        # One suggestion, in the stronger row.
        self.catalog_row("soy", IngredientAllergenStatus.CHECK_LABEL)
        hints = self.hints()
        self.assertIn("soy", hints["contains"])
        self.assertNotIn("soy", hints["checkLabel"])

    def test_packaging_hints_nothing(self):
        self.catalog_row("sulphites", IngredientAllergenStatus.CHECK_LABEL)
        Ingredient.objects.filter(id=self.ingredient.id).update(non_edible=True)
        self.assertEqual(
            self.hints(),
            {"contains": [], "mayContain": [], "checkLabel": []},
        )


class IngredientNutritionActionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="cook@example.com", password="password"
        )
        self.other = User.objects.create_user(
            email="other@example.com", password="password"
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Pork",
            normalized_name="pork",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )

    @mock.patch("forkluck.domains.ingredients.actions.get_food")
    def test_set_fetches_server_side_and_persists_on_owned_ingredient(self, get_food):
        get_food.return_value = (
            "Pork, ground",
            {
                "water": 60,
                "fat": 20,
                "protein": 19,
                "sugars": 0,
                "starch": 0,
                "fiber": 0,
                "salt": 1,
                "other": 0,
                "totalCarbohydrate": 0,
                "sodiumMg": 400,
            },
            "PORK, SALT, DEXTROSE. CONTAINS: MILK.",
        )
        result = actions.action_set_ingredient_nutrition(
            self.user, {"ingredientId": str(self.ingredient.id), "fdcId": 123}
        )
        self.assertEqual(result, {"ok": True})
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.nutrition_source_id, "123")
        self.assertEqual(self.ingredient.nutrition_per_100g["protein"], 19)
        self.assertEqual(self.ingredient.nutrition_per_100g["sodiumMg"], 400)
        self.assertEqual(
            self.ingredient.nutrition_package_ingredients,
            "PORK, SALT, DEXTROSE. CONTAINS: MILK.",
        )

    @mock.patch("forkluck.domains.ingredients.actions.get_food")
    def test_cannot_set_another_users_ingredient(self, get_food):
        with self.assertRaises(ValueError) as caught:
            actions.action_set_ingredient_nutrition(
                self.other, {"ingredientId": str(self.ingredient.id), "fdcId": 123}
            )
        self.assertEqual(str(caught.exception), "Ingredient not found")
        get_food.assert_not_called()

    def test_clear_removes_mapping(self):
        self.ingredient.nutrition_source = "usda_fdc"
        self.ingredient.nutrition_source_id = "123"
        self.ingredient.nutrition_description = "Pork"
        self.ingredient.nutrition_package_ingredients = "PORK, SALT."
        self.ingredient.nutrition_per_100g = {"protein": 19}
        self.ingredient.save()
        result = actions.action_clear_ingredient_nutrition(
            self.user, {"ingredientId": str(self.ingredient.id)}
        )
        self.assertEqual(result, {"ok": True})
        self.ingredient.refresh_from_db()
        self.assertIsNone(self.ingredient.nutrition_per_100g)
        self.assertEqual(self.ingredient.nutrition_package_ingredients, "")

    def test_applying_a_typed_label_drops_the_package_text_it_replaces(self):
        self.ingredient.nutrition_source = "usda_fdc"
        self.ingredient.nutrition_source_id = "123"
        self.ingredient.nutrition_package_ingredients = "PORK, SALT. CONTAINS: MILK."
        self.ingredient.nutrition_per_100g = {"protein": 19}
        self.ingredient.save()
        request = NutritionRequest.objects.create(
            user=self.user,
            ingredient=self.ingredient,
            serving_grams=30,
            values={"calories": 100},
            per_100g={"protein": 5},
        )
        request.apply(force=True)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.nutrition_source, "custom")
        self.assertEqual(self.ingredient.nutrition_package_ingredients, "")

    def test_merge_preserves_source_mapping_when_target_is_unmapped(self):
        source = self.ingredient
        source.nutrition_source = "usda_fdc"
        source.nutrition_source_id = "123"
        source.nutrition_description = "Pork"
        source.nutrition_package_ingredients = "PORK, SALT. CONTAINS: MILK."
        source.nutrition_per_100g = {"protein": 19}
        source.nutrition_updated_at = source.updated_at
        source.save()
        target = Ingredient.objects.create(
            user=self.user,
            name="Ground pork",
            normalized_name="ground pork",
            purchase_cost_cents=500,
            purchase_size=1000,
            purchase_unit="g",
        )
        result = actions.action_merge_ingredients(
            self.user,
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )
        self.assertEqual(result["targetId"], str(target.id))
        target.refresh_from_db()
        self.assertEqual(target.nutrition_source_id, "123")
        self.assertEqual(
            target.nutrition_package_ingredients, "PORK, SALT. CONTAINS: MILK."
        )

    def test_nutrition_rate_limit_buckets_fit_the_persisted_column(self):
        max_length = MasterPriceAccess._meta.get_field("bucket").max_length
        self.assertLessEqual(len("nutri-s"), max_length)
        self.assertLessEqual(len("nutri-f"), max_length)

    @mock.patch("forkluck.domains.ingredients.actions.get_food")
    def test_direct_food_fetch_is_rate_limited(self, get_food):
        for _ in range(20):
            MasterPriceAccess.objects.create(user=self.user, bucket="nutri-f")
        with self.assertRaisesMessage(ValueError, "Too many nutrition lookups"):
            actions.action_set_ingredient_nutrition(
                self.user,
                {"ingredientId": str(self.ingredient.id), "fdcId": 123},
            )
        get_food.assert_not_called()
