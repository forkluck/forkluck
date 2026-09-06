import json
import tempfile
from decimal import Decimal
from pathlib import Path

from django.core import management
from django.core.exceptions import ValidationError
from django.core.management.base import CommandError
from django.test import TestCase

from .domains.shared.ingredient_identity import (
    resolve_name,
    saved_line_match_map,
    unique_catalog_aliases,
)

from .models import (
    CatalogImportBatch,
    CatalogIngredient,
    CatalogIngredientAlias,
    CatalogIngredientMeasure,
    CatalogPreparationMeasure,
    Ingredient,
    Recipe,
    RecipeLineMatch,
    User,
)


class CatalogIdentityModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="catalog@example.com", password="pw", name="Catalog"
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user, name="Cilantro", purchase_cost_cents=100
        )

    def test_deployment_catalog_sync_ships_water_as_catalog_only(self):
        management.call_command("sync_catalog", verbosity=0)
        water = CatalogIngredient.objects.get(normalized_name="water")

        self.assertEqual(water.name, "Water")
        self.assertTrue(water.is_active)
        self.assertFalse(Ingredient.objects.filter(catalog_ingredient=water).exists())

    def test_alias_normalizes_and_allows_same_spelling_for_two_targets(self):
        first = CatalogIngredient.objects.create(name="Cilantro")
        second = CatalogIngredient.objects.create(name="Coriander leaf")
        CatalogIngredientAlias.objects.create(ingredient=first, text="Fresh Cilantro")
        CatalogIngredientAlias.objects.create(ingredient=second, text="fresh cilantro")
        self.assertEqual(
            CatalogIngredientAlias.objects.filter(
                normalized_text="fresh cilantro"
            ).count(),
            2,
        )

    def test_recipe_line_match_requires_one_target_and_component_recipe(self):
        recipe = Recipe.objects.create(
            user=self.user, title="Sauce", kind=Recipe.KIND_RECIPE
        )
        row = RecipeLineMatch(user=self.user, text="sauce", component_recipe=recipe)
        with self.assertRaises(ValidationError):
            row.full_clean()

    def test_live_profile_keeps_tags_but_forgets_the_retired_fields(self):
        self.assertTrue(hasattr(self.ingredient, "tags"))
        # `status` is back, but as the archive flag a recipe carries, not the
        # retired profile status with its own choices class.
        self.assertEqual(self.ingredient.status, Ingredient.STATUS_ACTIVE)
        for field in ("description", "recipe_use", "costing", "is_edible"):
            self.assertFalse(hasattr(self.ingredient, field), field)
        for choice in ("ProfileStatus", "RecipeUse", "Costing"):
            self.assertFalse(hasattr(Ingredient, choice), choice)

    def test_resolution_precedence_and_ambiguous_catalog_aliases(self):
        canonical = CatalogIngredient.objects.create(name="Cilantro")
        other = CatalogIngredient.objects.create(name="Coriander")
        adopted = Ingredient.objects.create(
            user=self.user,
            name="Fresh herbs",
            purchase_cost_cents=100,
            catalog_ingredient=canonical,
        )
        competing = Ingredient.objects.create(
            user=self.user,
            name="Green herbs",
            purchase_cost_cents=100,
            catalog_ingredient=other,
        )
        CatalogIngredientAlias.objects.create(ingredient=canonical, text="leafy")
        CatalogIngredientAlias.objects.create(ingredient=other, text="leafy")
        self.assertEqual(unique_catalog_aliases(self.user), [])
        RecipeLineMatch.objects.create(user=self.user, text="leafy", ingredient=adopted)
        RecipeLineMatch.objects.create(
            user=self.user, text="Cilantro", ingredient=competing
        )
        saved = saved_line_match_map(self.user)
        by_id = {str(adopted.id): adopted, str(competing.id): competing}
        self.assertIs(
            resolve_name(
                "leafy",
                by_name={},
                by_id=by_id,
                saved=saved,
            ),
            adopted,
        )
        self.assertIs(
            resolve_name(
                "Cilantro",
                by_name={},
                by_id=by_id,
                saved=saved,
            ),
            competing,
        )
        self.assertIs(
            resolve_name(
                "Cilantro",
                by_name={"cilantro": adopted},
                by_id=by_id,
                saved=saved,
            ),
            adopted,
        )


class CatalogVocabularyImporterTests(TestCase):
    def test_import_requires_documented_canonical_identity_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy-shape.json"
            path.write_text(
                json.dumps([{"name": "Cilantro", "synonyms": "fresh cilantro"}])
            )
            with self.assertRaises(CommandError):
                management.call_command(
                    "import_catalog_vocabulary", path, source_key="fixture", verbosity=0
                )

    def test_import_is_idempotent_and_dry_run_is_transactional(self):
        payload = [
            {
                "canonical": "Cilantro",
                "synonyms": "fresh cilantro|coriander leaf",
                "measures": [{"unit": "cup", "amount": 1, "grams": 16}],
                "preparations": [
                    {
                        "name": "chopped",
                        "yield_percent": 95,
                        "measures": [{"unit": "cup", "amount": 1, "grams": 16}],
                    }
                ],
            },
            {"canonical": "Parsley", "synonyms": "coriander leaf"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cilantro-vocabulary.json"
            path.write_text(json.dumps(payload))
            management.call_command(
                "import_catalog_vocabulary",
                path,
                source_key="fixture",
                dry_run=True,
                verbosity=0,
            )
            self.assertFalse(
                CatalogIngredient.objects.filter(
                    normalized_name__in=["cilantro", "parsley"]
                ).exists()
            )
            management.call_command(
                "import_catalog_vocabulary", path, source_key="fixture", verbosity=0
            )
            management.call_command(
                "import_catalog_vocabulary", path, source_key="fixture", verbosity=0
            )
        self.assertEqual(CatalogImportBatch.objects.count(), 1)
        self.assertEqual(
            CatalogIngredient.objects.filter(
                normalized_name__in=["cilantro", "parsley"]
            ).count(),
            2,
        )
        self.assertEqual(CatalogIngredientAlias.objects.count(), 3)
        self.assertEqual(CatalogIngredientMeasure.objects.count(), 1)
        self.assertEqual(CatalogPreparationMeasure.objects.count(), 1)

    def test_csv_identity_and_conversion_files_are_merged_and_old_source_rows_archived(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            identity_path = Path(directory) / "identities.csv"
            identity_path.write_text(
                "canonical,synonyms\nCilantro,fresh cilantro|coriander leaf\n"
            )
            conversions_path = Path(directory) / "conversions.csv"
            conversions_path.write_text(
                "canonical,preparation,unit,amount,grams\nCilantro,,cup,1,16\n"
                "Cilantro,chopped,cup,1,16\n"
            )
            management.call_command(
                "import_catalog_vocabulary",
                identity_path,
                conversions=conversions_path,
                source_key="fixture-csv",
                verbosity=0,
            )
            self.assertEqual(CatalogIngredientMeasure.objects.count(), 1)
            self.assertEqual(CatalogPreparationMeasure.objects.count(), 1)

            # A conversion-only edit is a new snapshot, not a false exact-file
            # no-op. The same identity path is intentionally reused here.
            conversions_path.write_text(
                "canonical,preparation,unit,amount,grams\nCilantro,,cup,1,18\n"
            )
            management.call_command(
                "import_catalog_vocabulary",
                identity_path,
                conversions=conversions_path,
                source_key="fixture-csv",
                verbosity=0,
            )
            self.assertEqual(
                CatalogIngredientMeasure.objects.get(is_active=True).grams, 18
            )

            replacement_path = Path(directory) / "replacement.csv"
            replacement_path.write_text("canonical,synonyms\nCilantro,fresh cilantro\n")
            management.call_command(
                "import_catalog_vocabulary",
                replacement_path,
                source_key="fixture-csv",
                verbosity=0,
            )
        self.assertEqual(
            CatalogIngredientAlias.objects.filter(is_active=False).count(), 2
        )


HEADER = (
    "id,name,synonyms,allergens,preparation,yield,grams,volume,each,estimated,source\n"
)
WATER = "water,Water,,,,,237,1 cup,,no,si:density\n"
CARROT = (
    "carrot,Carrot,carrots,,,,128,1 cup,,no,usda:11124\n"
    "carrot,,,,chopped,,128,1 cup,,no,usda:11124\n"
    "carrot,,,,peeled,88,,,,yes,\n"
)


# The brand-dependent column is optional: a catalog file written before it
# existed still loads.
VERIFY_HEADER = HEADER.rstrip("\n") + ",verify\n"
SOY_SAUCE = "soy-sauce,Soy sauce,,soy|wheat,,,255,1 cup,,no,usda:11000,sulphites|fish\n"


class CatalogSyncTests(TestCase):
    def sync(self, body: str, **options) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.csv"
            path.write_text(body)
            management.call_command("sync_catalog", path, verbosity=0, **options)

    def test_a_rename_onto_a_legacy_row_folds_that_row_into_the_keyed_one(self):
        # Production carries catalog rows from before keys existed. When a
        # keyed entry is renamed to one of their names, the legacy row is the
        # same thing: it folds into the keyed row instead of blocking the sync.
        self.sync(HEADER + "mustard-green,Mustard green,,,,,56,1 cup,,no,usda:11270\n")
        legacy = CatalogIngredient.objects.create(name="Mustard Greens")
        user = User.objects.create_user(
            email="fold@example.com",
            name="Fold",
            password="a-long-test-passphrase-2468",
        )
        pantry = Ingredient.objects.create(
            user=user,
            name="Mustard Greens",
            purchase_cost_cents=100,
            catalog_ingredient=legacy,
        )

        self.sync(HEADER + "mustard-green,Mustard Greens,,,,,56,1 cup,,no,usda:11270\n")

        keyed = CatalogIngredient.objects.get(key="mustard-green")
        self.assertEqual(keyed.name, "Mustard Greens")
        self.assertFalse(CatalogIngredient.objects.filter(pk=legacy.pk).exists())
        pantry.refresh_from_db()
        self.assertEqual(pantry.catalog_ingredient_id, keyed.id)

    def test_the_verify_column_writes_check_label_rows_beside_the_assertions(self):
        self.sync(VERIFY_HEADER + SOY_SAUCE)
        rows = CatalogIngredient.objects.get(key="soy-sauce").allergen_defaults.filter(
            is_active=True
        )
        self.assertEqual(
            sorted(rows.values_list("allergen", "status")),
            [
                ("fish", "checkLabel"),
                ("soy", "contains"),
                ("sulphites", "checkLabel"),
                ("wheat", "contains"),
            ],
        )

    def test_a_catalog_without_the_verify_column_still_loads(self):
        self.sync(HEADER + WATER)
        self.assertTrue(CatalogIngredient.objects.filter(key="water").exists())

    def test_a_tag_cannot_be_both_asserted_and_deferred(self):
        with self.assertRaises(CommandError):
            self.sync(
                VERIFY_HEADER
                + "soy-sauce,Soy sauce,,soy,,,255,1 cup,,no,usda:11000,soy\n"
            )
        with self.assertRaises(CommandError):
            self.sync(
                VERIFY_HEADER
                + "soy-sauce,Soy sauce,,,,,255,1 cup,,no,usda:11000,gluten\n"
            )

    def test_sync_adopts_the_key_less_shipped_row_and_is_idempotent(self):
        CatalogIngredient.objects.create(name="Carrot")

        self.sync(HEADER + WATER + CARROT, dry_run=True)
        self.assertFalse(CatalogIngredient.objects.filter(key="carrot").exists())

        self.sync(HEADER + WATER + CARROT)
        self.sync(HEADER + WATER + CARROT)

        self.assertEqual(CatalogImportBatch.objects.count(), 1)
        water = CatalogIngredient.objects.get(normalized_name="water")
        self.assertEqual(water.key, "water")
        self.assertEqual(water.measures.get(is_active=True).grams, 237)
        carrot = CatalogIngredient.objects.get(key="carrot")
        self.assertEqual(CatalogIngredient.objects.filter(name="Carrot").count(), 1)
        self.assertEqual(
            sorted(
                carrot.preparation_yields.filter(is_active=True).values_list(
                    "normalized_name", "yield_percent"
                )
            ),
            [("chopped", 100), ("peeled", 88)],
        )
        chopped = carrot.preparation_yields.get(normalized_name="chopped")
        self.assertTrue(chopped.source_release.startswith("catalog:"))
        self.assertEqual(chopped.confidence, "high")
        self.assertEqual(
            carrot.preparation_yields.get(normalized_name="peeled").confidence, "low"
        )
        self.assertEqual(chopped.measures.get(is_active=True).grams, 128)
        self.assertEqual(carrot.aliases.get(is_active=True).text, "carrots")

    def test_a_release_supersedes_the_previous_one_and_a_rename_keeps_the_key(self):
        self.sync(HEADER + WATER + CARROT)
        carrot = CatalogIngredient.objects.get(key="carrot")

        self.sync(HEADER + "carrot,Carrots,,,,,130,1 cup,,no,usda:11124\n")

        carrot.refresh_from_db()
        self.assertEqual(carrot.name, "Carrots")
        self.assertEqual(carrot.normalized_name, "carrots")
        self.assertEqual(carrot.measures.get(is_active=True).grams, 130)
        self.assertFalse(carrot.preparation_yields.filter(is_active=True).exists())
        self.assertFalse(carrot.aliases.filter(is_active=True).exists())
        self.assertFalse(
            CatalogIngredient.objects.get(normalized_name="water").is_active
        )

    def test_a_malformed_row_is_refused_before_anything_is_written(self):
        for body in (
            HEADER + "carrot,Carrot,,,,,128,1 pinch,,no,usda:11124\n",
            HEADER + "carrot,Carrot,,,chopped,88,128,1 cup,,no,usda:11124\n",
            HEADER + "carrot,Carrot,,,,,128,1 cup,,no,\n",
            HEADER + "Carrot,Carrot,,,,,128,1 cup,,no,usda:11124\n",
            HEADER + "carrot,Carrot,,,peeled,88,,,,yes,\n",
            HEADER + "carrot,Carrot,,,,,,1 cup,,no,usda:11124\n",
            HEADER
            + "carrot,Carrot,,,,,128,1 cup,,no,usda:11124\n"
            + "carrot-2,Carrot!,,,,,128,1 cup,,no,usda:11124\n",
        ):
            with self.assertRaises(CommandError):
                self.sync(body)
        self.assertFalse(CatalogIngredient.objects.filter(key="carrot").exists())


class ShippedCatalogTests(TestCase):
    """The file in data/catalog has to load, and a baking recipe has to weigh."""

    def test_the_shipped_file_loads_and_weighs_a_lemon_curd(self):
        management.call_command("sync_catalog", verbosity=0)

        def grams(key, unit):
            ingredient = CatalogIngredient.objects.get(key=key)
            return ingredient.measures.get(
                unit=unit, qualifier="", is_active=True
            ).grams

        self.assertEqual(grams("lemon-zest", "tbsp"), 6)
        self.assertEqual(grams("kosher-salt", "tsp"), Decimal("2.8"))
        self.assertEqual(grams("egg-yolk", "each"), 17)
        self.assertEqual(grams("egg", "each"), 50)
        self.assertEqual(grams("lemon-juice", "tbsp"), 15)
        self.assertEqual(grams("unsalted-butter", "tbsp"), Decimal("14.2"))
        self.assertEqual(grams("flour-ap", "cup"), 125)
        flour = CatalogIngredient.objects.get(key="flour-ap")
        self.assertEqual(flour.name, "Flour")
        self.assertTrue(
            flour.aliases.filter(
                normalized_text="all purpose flour", is_active=True
            ).exists()
        )
        self.assertEqual(grams("sugar", "cup"), 200)
        self.assertEqual(grams("vanilla-extract", "tsp"), Decimal("4.2"))
        self.assertEqual(grams("salt", "tsp"), 6)

    def test_kosher_salt_is_its_own_ingredient(self):
        management.call_command("sync_catalog", verbosity=0)

        alias = CatalogIngredientAlias.objects.get(
            normalized_text="kosher salt", is_active=True
        )
        self.assertEqual(alias.ingredient.key, "kosher-salt")
