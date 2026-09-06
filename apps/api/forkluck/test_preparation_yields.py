import json
import tempfile
from decimal import Decimal
from io import StringIO
from pathlib import Path

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from .domains.ingredients import actions
from .domains.ingredients.serializers import preparation_json
from .domains.recipes.health import RecipeHealthReadModel
from .models import (
    CatalogImportBatch,
    CatalogIngredient,
    CatalogPreparationYield,
    CatalogProduct,
    CatalogSource,
    Ingredient,
    Preparation,
    Recipe,
    User,
)


class PreparationYieldImportTests(TestCase):
    def import_yields(self, *args, **options) -> str:
        """Import a manifest and return the command's own summary line."""
        output = StringIO()
        call_command("import_preparation_yields", *args, stdout=output, **options)
        return output.getvalue()

    def manifest(self, rows):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name, "yields.json")
        path.write_text(json.dumps(rows), encoding="utf-8")
        return path

    def row(self, **overrides):
        return {
            "ingredient": "Garlic",
            "name": "Minced",
            "yield_percent": 80,
            "source_kind": "public_food_data",
            "source_ref": "record-1",
            "source_release": "release-1",
            "derivation": "direct",
            "evidence_count": 2,
            "confidence": "medium",
            "is_default": True,
            "is_active": True,
            **overrides,
        }

    def test_import_is_idempotent_and_updates_the_same_source_record(self):
        path = self.manifest([self.row()])
        created = self.import_yields(path)
        self.assertEqual(CatalogPreparationYield.objects.count(), 1)

        path.write_text(json.dumps([self.row(yield_percent=82)]), encoding="utf-8")
        updated = self.import_yields(path)

        self.assertEqual(created.strip(), "Imported: 1 created; 0 updated.")
        self.assertEqual(updated.strip(), "Imported: 0 created; 1 updated.")
        row = CatalogPreparationYield.objects.get()
        self.assertEqual(row.yield_percent, Decimal("82"))
        self.assertEqual(row.normalized_name, "minced")
        self.assertEqual(row.source_release, "release-1")
        self.assertEqual(row.derivation, "direct")
        self.assertEqual(row.evidence_count, 2)

    def test_dry_run_validates_without_retaining_rows(self):
        summary = self.import_yields(self.manifest([self.row()]), dry_run=True)

        self.assertEqual(summary.strip(), "Dry run: 1 created; 0 updated.")
        self.assertEqual(CatalogPreparationYield.objects.count(), 0)

    def test_a_new_default_demotes_the_one_it_replaces(self):
        self.import_yields(self.manifest([self.row()]))
        self.import_yields(
            self.manifest(
                [self.row(source_ref="record-2", yield_percent=84, confidence="high")]
            )
        )

        defaults = CatalogPreparationYield.objects.filter(is_default=True)
        self.assertEqual(defaults.count(), 1)
        self.assertEqual(defaults.get().source_ref, "record-2")

    def test_rejects_duplicate_or_invalid_manifest_rows(self):
        with self.assertRaisesRegex(CommandError, "Duplicate"):
            self.import_yields(self.manifest([self.row(), self.row()]))
        with self.assertRaisesRegex(CommandError, "Multiple defaults"):
            self.import_yields(
                self.manifest([self.row(), self.row(source_ref="record-2")])
            )
        with self.assertRaisesRegex(CommandError, "positive percent"):
            self.import_yields(self.manifest([self.row(yield_percent=0)]))
        with self.assertRaisesRegex(CommandError, "positive percent"):
            self.import_yields(self.manifest([self.row(yield_percent=1001)]))
        with self.assertRaisesRegex(CommandError, "evidence_count"):
            self.import_yields(self.manifest([self.row(evidence_count=0)]))
        with self.assertRaisesRegex(CommandError, "source_release"):
            self.import_yields(self.manifest([self.row(source_release="")]))
        with self.assertRaisesRegex(CommandError, "derivation"):
            self.import_yields(self.manifest([self.row(derivation="")]))
        with self.assertRaisesRegex(CommandError, "provided together"):
            self.import_yields(self.manifest([self.row(low_percent=76)]))
        with self.assertRaisesRegex(CommandError, "inactive yield"):
            self.import_yields(self.manifest([self.row(is_active=False)]))

        self.assertEqual(CatalogPreparationYield.objects.count(), 0)

    def test_a_hydrating_yield_above_one_hundred_percent_is_accepted(self):
        self.import_yields(
            self.manifest(
                [
                    self.row(
                        ingredient="Rice",
                        name="Cooked",
                        yield_percent=300,
                        low_percent=280,
                        high_percent=320,
                    )
                ]
            )
        )

        row = CatalogPreparationYield.objects.get()
        self.assertEqual(row.yield_percent, Decimal("300"))
        self.assertEqual(row.low_percent, Decimal("280"))

    def test_database_guards_yield_range_and_default_state(self):
        ingredient = CatalogIngredient.objects.create(
            name="Guarded garlic", normalized_name="guarded garlic"
        )
        base = {
            "ingredient": ingredient,
            "name": "Minced",
            "normalized_name": "minced",
            "yield_percent": Decimal("80"),
            "source_kind": "public_food_data",
            "source_ref": "guarded-1",
            "source_release": "release-1",
            "derivation": "direct",
            "evidence_count": 1,
        }

        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogPreparationYield.objects.create(**base, low_percent=76)
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogPreparationYield.objects.create(
                **{**base, "source_ref": "center-below-range"},
                low_percent=Decimal("84"),
                high_percent=Decimal("90"),
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogPreparationYield.objects.create(
                **{**base, "source_ref": "over-bound", "yield_percent": Decimal("1001")}
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogPreparationYield.objects.create(
                **{**base, "source_ref": "no-evidence", "evidence_count": 0}
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CatalogPreparationYield.objects.create(
                **{
                    **base,
                    "source_ref": "inactive-default",
                    "is_default": True,
                    "is_active": False,
                }
            )


class SeededPreparationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="yield-owner@example.test", name="Yield owner"
        )
        self.other_user = User.objects.create_user(
            email="yield-other@example.test", name="Other owner"
        )
        self.garlic = Ingredient.objects.create(
            user=self.user,
            name="Garlic",
            normalized_name="garlic",
            purchase_cost_cents=400,
            purchase_size=1000,
            purchase_unit="g",
        )
        self.catalog_garlic = CatalogIngredient.objects.create(
            name="Garlic", normalized_name="garlic"
        )
        self.seed = CatalogPreparationYield.objects.create(
            ingredient=self.catalog_garlic,
            name="Minced",
            yield_percent=Decimal("88"),
            source_kind="public_food_data",
            source_ref="garlic-minced",
            source_release="release-1",
            derivation="direct",
            evidence_count=2,
            confidence="medium",
            is_default=True,
        )

    def add_preparation(self, name: str, **body) -> Preparation:
        result = actions.action_save_preparation(
            self.user,
            {
                "ingredientId": str(self.garlic.id),
                "name": name,
                "usesStandardConversion": True,
                **body,
            },
        )
        return Preparation.objects.get(id=result["id"])

    def test_a_new_preparation_takes_the_shared_yield_it_did_not_state(self):
        row = self.add_preparation("Minced")

        self.assertEqual(row.yield_percent, Decimal("88.000"))
        self.assertEqual(row.source, Preparation.Source.CATALOG)
        self.assertEqual(row.confidence, "medium")
        payload = preparation_json(row)
        self.assertEqual(payload["source"], "catalog")
        self.assertEqual(payload["confidence"], "medium")

    def test_a_stated_yield_is_never_replaced_by_the_shared_one(self):
        row = self.add_preparation("Minced", yieldPercent=92)

        self.assertEqual(row.yield_percent, Decimal("92.000"))
        self.assertEqual(row.source, Preparation.Source.USER)
        self.assertEqual(row.confidence, "high")

    def test_zero_or_half_a_measurement_is_rejected(self):
        for weight in (
            {"amount": 0, "unit": "g"},
            {"amount": 10, "unit": ""},
            {"amount": None, "unit": "g"},
        ):
            with self.subTest(weight=weight), self.assertRaisesMessage(
                ValueError,
                "Weight amount and unit must be supplied together and the "
                "amount must be greater than zero.",
            ):
                self.add_preparation(
                    "Crushed", usesStandardConversion=False, weight=weight
                )

    def test_preparation_yield_bounds_are_exact(self):
        for value in (0, -1, 1000.001):
            with self.subTest(value=value), self.assertRaisesMessage(
                ValueError,
                "Yield must be greater than zero and at most 1000.",
            ):
                self.add_preparation(f"Yield {value}", yieldPercent=value)

        self.assertEqual(
            self.add_preparation("Full yield", yieldPercent=1000).yield_percent,
            Decimal("1000"),
        )

    def test_standard_preparation_rejects_custom_measurements(self):
        with self.assertRaisesMessage(
            ValueError,
            "Standard preparation conversion cannot include custom measurements.",
        ):
            self.add_preparation(
                "Crushed",
                usesStandardConversion=True,
                weight={"amount": 10, "unit": "g"},
            )

    def test_empty_custom_preparation_remains_custom_and_unresolved(self):
        row = self.add_preparation("Crushed", usesStandardConversion=False)
        self.assertFalse(row.average_weight)
        self.assertIsNone(row.weight_amount)
        self.assertEqual(row.weight_unit, "")

    def test_editing_a_seeded_preparation_makes_it_the_tenants_own(self):
        row = self.add_preparation("Minced")

        actions.action_save_preparation(
            self.user,
            {
                "id": str(row.id),
                "ingredientId": str(self.garlic.id),
                "name": "Minced",
                "yieldPercent": 90,
                "usesStandardConversion": True,
            },
        )

        row.refresh_from_db()
        self.assertEqual(row.yield_percent, Decimal("90.000"))
        self.assertEqual(row.source, Preparation.Source.USER)
        self.assertEqual(row.confidence, "high")

    def test_clearing_the_yield_on_an_edit_does_not_reseed_it(self):
        row = self.add_preparation("Minced")

        actions.action_save_preparation(
            self.user,
            {
                "id": str(row.id),
                "ingredientId": str(self.garlic.id),
                "name": "Minced",
                "yieldPercent": None,
                "usesStandardConversion": True,
            },
        )

        row.refresh_from_db()
        self.assertIsNone(row.yield_percent)
        self.assertEqual(row.source, Preparation.Source.USER)

    def test_a_preparation_the_catalog_does_not_know_stays_the_users_own(self):
        row = self.add_preparation("Confit")

        self.assertIsNone(row.yield_percent)
        self.assertEqual(row.source, Preparation.Source.USER)
        self.assertEqual(row.confidence, "high")

    def test_an_inactive_or_undefaulted_shared_yield_seeds_nothing(self):
        self.seed.is_default = False
        self.seed.save()

        self.assertIsNone(self.add_preparation("Minced").yield_percent)

    def test_the_seed_follows_the_canonical_identity_after_a_pantry_rename(self):
        source = CatalogSource.objects.create(key="prep-yield-identity")
        batch = CatalogImportBatch.objects.create(
            source=source, content_sha256="c" * 64, observed_at=timezone.now()
        )
        product = CatalogProduct.objects.create(
            source=source,
            import_batch=batch,
            ingredient=self.catalog_garlic,
            external_id="garlic-1",
            normalized_external_id="garlic-1",
            title="Garlic",
            normalized_title="garlic",
            raw_size="1 kg",
            pack_price_cents=400,
            pack_grams=1000,
            pack_amount=1000,
            pack_unit="g",
            observed_at=timezone.now(),
            is_recipe_ready=True,
        )
        self.garlic.catalog_product = product
        self.garlic.name = "House garlic"
        self.garlic.save()

        self.assertEqual(
            self.add_preparation("Minced").yield_percent, Decimal("88.000")
        )

    def test_one_tenants_edit_leaves_another_tenants_seeded_row_alone(self):
        their_garlic = Ingredient.objects.create(
            user=self.other_user,
            name="Garlic",
            normalized_name="garlic",
            purchase_cost_cents=400,
            purchase_size=1000,
            purchase_unit="g",
        )
        theirs = Preparation.objects.get(
            id=actions.action_save_preparation(
                self.other_user,
                {
                    "ingredientId": str(their_garlic.id),
                    "name": "Minced",
                    "usesStandardConversion": True,
                },
            )["id"]
        )
        mine = self.add_preparation("Minced")

        actions.action_save_preparation(
            self.user,
            {
                "id": str(mine.id),
                "ingredientId": str(self.garlic.id),
                "name": "Minced",
                "yieldPercent": 95,
                "usesStandardConversion": True,
            },
        )

        theirs.refresh_from_db()
        self.assertEqual(theirs.yield_percent, Decimal("88.000"))
        self.assertEqual(theirs.source, Preparation.Source.CATALOG)
        with self.assertRaisesMessage(ValueError, "Preparation not found"):
            actions.action_save_preparation(
                self.other_user,
                {
                    "id": str(mine.id),
                    "ingredientId": str(their_garlic.id),
                    "name": "Minced",
                    "yieldPercent": 10,
                    "usesStandardConversion": True,
                },
            )

    def test_a_seeded_yield_costs_a_line_exactly_as_a_measured_one_does(self):
        # Pairs with `costs a seeded yield exactly as a measured one` in
        # apps/web/tests/pricing.test.ts: the tag says where the number came from and
        # nothing else, so both engines must price the line identically.
        self.add_preparation("Minced")
        recipe = Recipe.objects.create(
            user=self.user,
            title="Garlic butter",
            body="100 g Garlic, minced",
            yield_amount=1,
            yield_unit="pcs",
            serving_amount=1,
            serving_unit="each",
        )

        health = RecipeHealthReadModel(self.user).rows([recipe])[0]

        self.assertAlmostEqual(
            health["ingredientCents"], (100 / 1000) * (100 / 88) * 400, places=4
        )
