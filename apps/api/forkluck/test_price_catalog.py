import json
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client, TestCase

from .models import (
    CatalogIngredient,
    CatalogImportBatch,
    CatalogPriceObservation,
    CatalogProduct,
    CatalogSource,
    Ingredient,
    User,
)
from .price_catalog import normalized_catalog_price
from .testing import InternalApiTestCase


class CatalogPriceParserTests(TestCase):
    def test_normalizes_fixed_and_variable_weight_prices(self):
        fixed = normalized_catalog_price(
            {"price_text": "$42.99", "sell_unit": "35 LB", "name": "Cooking Oil"}
        )
        self.assertEqual(fixed["pack_price_cents"], 4299)
        self.assertEqual(fixed["pack_amount"], 35.0)
        self.assertEqual(fixed["pack_unit"], "lb")

        variable = normalized_catalog_price(
            {
                "price_text": "$3.79/LB",
                "sell_unit": "13 LB AVG | 2 PC",
                "name": "Boneless Cut",
            }
        )
        self.assertEqual(variable["pack_price_cents"], 379)
        self.assertEqual(variable["pack_amount"], 1.0)
        self.assertEqual(variable["pack_unit"], "lb")

    def test_multiplies_case_weight_from_product_title(self):
        value = normalized_catalog_price(
            {
                "price_text": "$35.99",
                "sell_unit": "Case",
                "name": "Pasta 12 oz. - 16/Case",
            }
        )
        self.assertEqual(value["pack_amount"], 192.0)
        self.assertEqual(value["pack_unit"], "oz")

    def test_accepts_decorated_visible_price_text(self):
        value = normalized_catalog_price(
            {
                "price_text": "Sale regular price $48.49",
                "sell_unit": "25 LB",
                "name": "Rice Flour 25 lb.",
            }
        )
        self.assertEqual(value["pack_price_cents"], 4849)

    def test_accepts_spaces_around_per_weight_price_separator(self):
        value = normalized_catalog_price(
            {
                "price_text": "$3.79 / LB",
                "sell_unit": "13 LB AVG",
                "name": "Boneless Cut",
            }
        )
        self.assertEqual(value["price_basis"], CatalogProduct.PriceBasis.WEIGHT)
        self.assertEqual(value["pack_price_cents"], 379)
        self.assertEqual(value["pack_amount"], 1.0)
        self.assertEqual(value["pack_unit"], "lb")

    def test_multiplies_count_first_slash_pack(self):
        value = normalized_catalog_price(
            {
                "price_text": "$48.00",
                "sell_unit": "4/5 LB",
                "name": "Case Product",
            }
        )
        self.assertEqual(value["pack_amount"], 20.0)
        self.assertEqual(value["pack_unit"], "lb")

    def test_accepts_single_count_slash_pack(self):
        value = normalized_catalog_price(
            {
                "price_text": "$48.00",
                "sell_unit": "1/20 LB",
                "name": "Single Case Product",
            }
        )
        self.assertEqual(value["pack_amount"], 20.0)
        self.assertEqual(value["pack_unit"], "lb")

    def test_rejects_zero_weight_pack_matches(self):
        rows = [
            {
                "price_text": "$48.00",
                "sell_unit": "0 LB",
                "name": "Zero Single",
            },
            {
                "price_text": "$48.00",
                "sell_unit": "2 X 0 LB",
                "name": "Zero Multipack",
            },
            {
                "price_text": "$48.00",
                "sell_unit": "CASE",
                "name": "0 OZ - 12/CASE",
            },
        ]

        for row in rows:
            with self.subTest(row=row):
                value = normalized_catalog_price(row)
                self.assertIsNone(value["pack_amount"])
                self.assertIsNone(value["pack_unit"])
                self.assertIsNone(value["pack_grams"])


class CatalogImportAndApiTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.client = Client()
        self.user = User.objects.create_user(
            email="catalog-chef@example.com",
            name="Catalog Chef",
            password="a-long-test-passphrase-2468",
        )
        self.client.force_login(self.user)

    def write_json(self, directory: str, name: str, value) -> Path:
        path = Path(directory) / name
        path.write_text(json.dumps(value))
        return path

    def import_source(
        self,
        directory: str,
        *,
        source_key: str,
        private_label: str,
        price: str,
        collected_at: str = "2026-08-11T00:00:00Z",
        include_unmapped: bool = True,
        sku: str = "ONION-1",
    ) -> Path:
        rows = [
            {
                "supplier": private_label,
                "category": "produce",
                "sku": sku,
                "name": "Yellow Onions 50 LB",
                "price_text": price,
                "sell_unit": "50 LB",
                "currency": "USD",
                "collected_at": collected_at,
            }
        ]
        if include_unmapped:
            rows.append(
                {
                    "supplier": private_label,
                    "category": "produce",
                    "sku": "UNMAPPED-1",
                    "name": "Unmapped Product 24 CT",
                    "price_text": "$12.00",
                    "sell_unit": "24 CT",
                    "currency": "USD",
                    "collected_at": collected_at,
                }
            )
        path = self.write_json(directory, f"{source_key}.json", rows)
        mapping = self.write_json(
            directory, f"{source_key}-mapping.json", {sku: "Yellow Onions"}
        )
        self.summary = self.run_import(
            path,
            source_key=source_key,
            private_label=private_label,
            mapping=mapping,
        )
        return path

    def run_import(self, *args, **options) -> str:
        """Import a catalog file and return the command's own summary line."""
        output = StringIO()
        call_command("import_price_catalog", *args, stdout=output, **options)
        return output.getvalue()

    def test_import_discards_repeated_canonical_ingredient(self):
        with TemporaryDirectory() as directory:
            first_path = self.import_source(
                directory,
                source_key="src_primary",
                private_label="Private source one",
                price="$20.00",
            )
            self.import_source(
                directory,
                source_key="src_secondary",
                private_label="Private source two",
                price="$18.00",
            )

            self.assertEqual(
                self.summary.strip(),
                "Imported: 1 products; 1 repeated products discarded; "
                "1 hidden for mapping or weight review.",
            )
            self.assertEqual(
                CatalogIngredient.objects.exclude(normalized_name="water").count(), 1
            )
            self.assertEqual(CatalogProduct.objects.count(), 3)
            self.assertEqual(CatalogPriceObservation.objects.count(), 3)
            kept_product = CatalogProduct.objects.get(ingredient__isnull=False)
            self.assertEqual(kept_product.source.key, "src_primary")
            self.assertEqual(kept_product.pack_price_cents, 2000)
            self.assertEqual(
                CatalogImportBatch.objects.get(source__key="src_secondary").discarded_count,
                1,
            )
            self.assertFalse(
                CatalogProduct.objects.get(external_id="UNMAPPED-1", source__key="src_primary").is_recipe_ready
            )

            with self.assertRaises(CommandError):
                self.run_import(
                    first_path,
                    source_key="src_primary",
                    private_label="Private source one",
                    mapping=Path(directory) / "src_primary-mapping.json",
                )

    def test_corrected_mapping_reimports_same_source_snapshot(self):
        with TemporaryDirectory() as directory:
            source_path = self.import_source(
                directory,
                source_key="src_revision",
                private_label="Private source revision",
                price="$20.00",
            )
            corrected_mapping = self.write_json(
                directory,
                "src_revision-corrected-mapping.json",
                {"ONION-1": "Spanish Onions"},
            )

            self.run_import(
                source_path,
                source_key="src_revision",
                private_label="Private source revision",
                mapping=corrected_mapping,
            )

            self.assertEqual(
                CatalogImportBatch.objects.filter(source__key="src_revision").count(),
                2,
            )
            product = CatalogProduct.objects.get(
                source__key="src_revision", external_id="ONION-1"
            )
            self.assertEqual(product.ingredient.name, "Spanish Onions")
            self.assertEqual(product.price_history.count(), 2)

    def test_rejects_source_sku_longer_than_database_identity(self):
        with TemporaryDirectory() as directory:
            long_sku = "S" * 121
            source_path = self.write_json(
                directory,
                "overlength.json",
                [
                    {
                        "supplier": "Private overlength source",
                        "category": "produce",
                        "sku": long_sku,
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$20.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-11T00:00:00Z",
                    }
                ],
            )
            mapping = self.write_json(
                directory, "overlength-mapping.json", {long_sku: "Yellow Onions"}
            )

            with self.assertRaisesMessage(CommandError, "sku exceeds 120 characters"):
                self.run_import(
                    source_path,
                    source_key="src_overlength",
                    private_label="Private overlength source",
                    mapping=mapping,
                )

            self.assertFalse(CatalogSource.objects.filter(key="src_overlength").exists())

    def test_input_source_filter_rejects_non_object_rows_cleanly(self):
        with TemporaryDirectory() as directory:
            source_path = self.write_json(
                directory,
                "non-object-row.json",
                ["not-an-object"],
            )

            with self.assertRaisesMessage(CommandError, "Row 1 must be an object"):
                self.run_import(
                    source_path,
                    source_key="src_non_object",
                    private_label="Private malformed source",
                    input_source="Private malformed source",
                )

            self.assertFalse(
                CatalogSource.objects.filter(key="src_non_object").exists()
            )

    def test_rejects_missing_or_invalid_collection_timestamp(self):
        with TemporaryDirectory() as directory:
            for source_key, collected_at in (
                ("src_missing_timestamp", None),
                ("src_invalid_timestamp", "not-a-timestamp"),
            ):
                row = {
                    "supplier": "Private timestamp source",
                    "category": "produce",
                    "sku": "ONION-1",
                    "name": "Yellow Onions 50 LB",
                    "price_text": "$20.00",
                    "sell_unit": "50 LB",
                    "currency": "USD",
                }
                if collected_at is not None:
                    row["collected_at"] = collected_at
                source_path = self.write_json(
                    directory,
                    f"{source_key}.json",
                    [row],
                )
                mapping = self.write_json(
                    directory,
                    f"{source_key}-mapping.json",
                    {"ONION-1": "Yellow Onions"},
                )

                with self.assertRaisesMessage(
                    CommandError, "missing a valid collected_at timestamp"
                ):
                    self.run_import(
                        source_path,
                        source_key=source_key,
                        private_label="Private timestamp source",
                        mapping=mapping,
                    )

                self.assertFalse(
                    CatalogSource.objects.filter(key=source_key).exists()
                )

    def test_rejects_canonical_name_longer_than_database_identity(self):
        with TemporaryDirectory() as directory:
            source_path = self.write_json(
                directory,
                "overlength-canonical.json",
                [
                    {
                        "supplier": "Private overlength canonical source",
                        "category": "produce",
                        "sku": "ONION-1",
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$20.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-11T00:00:00Z",
                    }
                ],
            )
            mapping = self.write_json(
                directory,
                "overlength-canonical-mapping.json",
                {"ONION-1": "A" * 121},
            )

            with self.assertRaisesMessage(
                CommandError, "Canonical name for SKU onion-1 exceeds 120 characters"
            ):
                self.run_import(
                    source_path,
                    source_key="src_overlength_canonical",
                    private_label="Private overlength canonical source",
                    mapping=mapping,
                )

            self.assertFalse(
                CatalogSource.objects.filter(key="src_overlength_canonical").exists()
            )

    def test_rejects_mapping_skus_that_collide_after_normalization(self):
        with TemporaryDirectory() as directory:
            source_path = self.write_json(
                directory,
                "mapping-collision.json",
                [
                    {
                        "supplier": "Private mapping-collision source",
                        "category": "produce",
                        "sku": "ONION-1",
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$20.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-11T00:00:00Z",
                    }
                ],
            )
            mapping = self.write_json(
                directory,
                "mapping-collision-mapping.json",
                {
                    "ONION-1": "Yellow Onions",
                    " onion-1 ": "Red Onions",
                },
            )

            with self.assertRaisesMessage(
                CommandError, "Duplicate mapping SKU after normalization"
            ):
                self.run_import(
                    source_path,
                    source_key="src_mapping_collision",
                    private_label="Private mapping-collision source",
                    mapping=mapping,
                )

            self.assertFalse(
                CatalogSource.objects.filter(key="src_mapping_collision").exists()
            )

    def test_import_preserves_deliberate_source_deactivation(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_disabled",
                private_label="Private disabled source",
                price="$20.00",
            )
            source = CatalogSource.objects.get(key="src_disabled")
            source.is_active = False
            source.save(update_fields=["is_active", "updated_at"])

            self.import_source(
                directory,
                source_key="src_disabled",
                private_label="Private disabled source updated",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
            )

            source.refresh_from_db()
            self.assertFalse(source.is_active)
            self.assertEqual(source.private_label, "Private disabled source updated")

    def test_import_preserves_deliberate_ingredient_deactivation(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_disabled_ingredient",
                private_label="Private ingredient source",
                price="$20.00",
            )
            ingredient = CatalogIngredient.objects.get(
                products__source__key="src_disabled_ingredient"
            )
            ingredient.is_active = False
            ingredient.save(update_fields=["is_active", "updated_at"])

            self.import_source(
                directory,
                source_key="src_disabled_ingredient",
                private_label="Private ingredient source",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
            )

            ingredient.refresh_from_db()
            self.assertFalse(ingredient.is_active)
            searched = self.post_internal("search-catalog-prices", {"query": "onion"})
            self.assertEqual(searched.json()["items"], [])

    def test_import_preserves_deliberate_product_deactivation(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_disabled_product",
                private_label="Private disabled-product source",
                price="$20.00",
                include_unmapped=False,
            )
            product = CatalogProduct.objects.get(
                source__key="src_disabled_product", external_id="ONION-1"
            )
            product.is_active = False
            product.save(update_fields=["is_active", "updated_at"])

            self.import_source(
                directory,
                source_key="src_disabled_product",
                private_label="Private disabled-product source",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
            )

            product.refresh_from_db()
            self.assertFalse(product.is_active)
            self.assertTrue(product.is_available)
            self.assertEqual(product.pack_price_cents, 2100)
            searched = self.post_internal("search-catalog-prices", {"query": "onion"})
            self.assertEqual(searched.json()["items"], [])

    def test_import_locks_source_before_batch_freshness_check(self):
        with TemporaryDirectory() as directory:
            source_path = self.write_json(
                directory,
                "locked-source.json",
                [
                    {
                        "supplier": "Private locked source",
                        "category": "produce",
                        "sku": "ONION-1",
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$20.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-11T00:00:00Z",
                    }
                ],
            )
            mapping = self.write_json(
                directory,
                "locked-source-mapping.json",
                {"ONION-1": "Yellow Onions"},
            )
            select_for_update = CatalogSource.objects.select_for_update

            with patch.object(
                CatalogSource.objects,
                "select_for_update",
                side_effect=select_for_update,
            ) as locked:
                self.run_import(
                    source_path,
                    source_key="src_locked",
                    private_label="Private locked source",
                    mapping=mapping,
                )

            locked.assert_called_once_with()

    def test_latest_snapshot_deactivates_products_that_disappear(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_removal",
                private_label="Private removal source",
                price="$20.00",
            )
            self.import_source(
                directory,
                source_key="src_removal",
                private_label="Private removal source",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
            )

            removed = CatalogProduct.objects.get(
                source__key="src_removal", external_id="UNMAPPED-1"
            )
            self.assertFalse(removed.is_available)

    def test_product_reactivates_when_it_returns_to_a_newer_snapshot(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_returning",
                private_label="Private returning source",
                price="$20.00",
            )
            self.import_source(
                directory,
                source_key="src_returning",
                private_label="Private returning source",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
            )
            removed = CatalogProduct.objects.get(
                source__key="src_returning", external_id="UNMAPPED-1"
            )
            self.assertFalse(removed.is_available)

            self.import_source(
                directory,
                source_key="src_returning",
                private_label="Private returning source",
                price="$22.00",
                collected_at="2026-08-13T00:00:00Z",
            )

            removed.refresh_from_db()
            self.assertTrue(removed.is_available)
            self.assertTrue(removed.is_active)

    def test_replacement_sku_inherits_omitted_products_canonical_ingredient(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_replacement",
                private_label="Private replacement source",
                price="$20.00",
            )
            self.import_source(
                directory,
                source_key="src_replacement",
                private_label="Private replacement source",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
                sku="ONION-2",
            )

            old_product = CatalogProduct.objects.get(
                source__key="src_replacement", external_id="ONION-1"
            )
            replacement = CatalogProduct.objects.get(
                source__key="src_replacement", external_id="ONION-2"
            )
            self.assertFalse(old_product.is_available)
            self.assertIsNone(old_product.ingredient)
            self.assertTrue(old_product.is_active)
            self.assertTrue(replacement.is_available)
            self.assertTrue(replacement.is_active)
            self.assertEqual(replacement.ingredient.name, "Yellow Onions")

    def test_known_sku_inherits_omitted_products_canonical_ingredient(self):
        with TemporaryDirectory() as directory:
            initial_path = self.write_json(
                directory,
                "known-replacement-initial.json",
                [
                    {
                        "supplier": "Private known-replacement source",
                        "category": "produce",
                        "sku": "ONION-A",
                        "name": "Red Onions 25 LB",
                        "price_text": "$18.00",
                        "sell_unit": "25 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-11T00:00:00Z",
                    },
                    {
                        "supplier": "Private known-replacement source",
                        "category": "produce",
                        "sku": "ONION-B",
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$20.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-11T00:00:00Z",
                    },
                ],
            )
            initial_mapping = self.write_json(
                directory,
                "known-replacement-initial-mapping.json",
                {
                    "ONION-A": "Red Onions",
                    "ONION-B": "Yellow Onions",
                },
            )
            self.run_import(
                initial_path,
                source_key="src_known_replacement",
                private_label="Private known-replacement source",
                mapping=initial_mapping,
            )
            latest_path = self.write_json(
                directory,
                "known-replacement-latest.json",
                [
                    {
                        "supplier": "Private known-replacement source",
                        "category": "produce",
                        "sku": "ONION-A",
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$21.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-12T00:00:00Z",
                    }
                ],
            )
            latest_mapping = self.write_json(
                directory,
                "known-replacement-latest-mapping.json",
                {"ONION-A": "Yellow Onions"},
            )

            self.run_import(
                latest_path,
                source_key="src_known_replacement",
                private_label="Private known-replacement source",
                mapping=latest_mapping,
            )

            replacement = CatalogProduct.objects.get(
                source__key="src_known_replacement", external_id="ONION-A"
            )
            omitted = CatalogProduct.objects.get(
                source__key="src_known_replacement", external_id="ONION-B"
            )
            self.assertEqual(replacement.ingredient.name, "Yellow Onions")
            self.assertTrue(replacement.is_available)
            self.assertIsNone(omitted.ingredient)
            self.assertFalse(omitted.is_available)

    def test_replacement_mapping_is_independent_of_snapshot_row_order(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_row_order",
                private_label="Private row-order source",
                price="$20.00",
                include_unmapped=False,
            )
            source_path = self.write_json(
                directory,
                "src_row_order.json",
                [
                    {
                        "supplier": "Private row-order source",
                        "category": "produce",
                        "sku": "ONION-2",
                        "name": "Yellow Onions 50 LB",
                        "price_text": "$21.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-12T00:00:00Z",
                    },
                    {
                        "supplier": "Private row-order source",
                        "category": "produce",
                        "sku": "ONION-1",
                        "name": "Legacy Onion Variant 50 LB",
                        "price_text": "$20.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-12T00:00:00Z",
                    },
                ],
            )
            mapping = self.write_json(
                directory,
                "src_row_order-mapping.json",
                {"ONION-2": "Yellow Onions"},
            )

            self.run_import(
                source_path,
                source_key="src_row_order",
                private_label="Private row-order source",
                mapping=mapping,
            )

            old_product = CatalogProduct.objects.get(
                source__key="src_row_order", external_id="ONION-1"
            )
            replacement = CatalogProduct.objects.get(
                source__key="src_row_order", external_id="ONION-2"
            )
            self.assertIsNone(old_product.ingredient)
            self.assertEqual(replacement.ingredient.name, "Yellow Onions")
            self.assertTrue(replacement.is_active)

    def test_mixed_timestamp_snapshot_does_not_detach_mapping_for_stale_row(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_mixed_freshness",
                private_label="Private mixed-freshness source",
                price="$20.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
            )
            source_path = self.write_json(
                directory,
                "src_mixed_freshness.json",
                [
                    {
                        "supplier": "Private mixed-freshness source",
                        "category": "produce",
                        "sku": "ONION-1",
                        "name": "Stale Onion Variant 50 LB",
                        "price_text": "$17.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-10T00:00:00Z",
                    },
                    {
                        "supplier": "Private mixed-freshness source",
                        "category": "produce",
                        "sku": "NEW-1",
                        "name": "New Unmapped Product 24 CT",
                        "price_text": "$12.00",
                        "sell_unit": "24 CT",
                        "currency": "USD",
                        "collected_at": "2026-08-13T00:00:00Z",
                    },
                ],
            )
            mapping = self.write_json(
                directory,
                "src_mixed_freshness-mapping.json",
                {},
            )

            self.run_import(
                source_path,
                source_key="src_mixed_freshness",
                private_label="Private mixed-freshness source",
                mapping=mapping,
            )

            onion = CatalogProduct.objects.get(
                source__key="src_mixed_freshness", external_id="ONION-1"
            )
            self.assertTrue(onion.is_active)
            self.assertTrue(onion.is_recipe_ready)
            self.assertEqual(onion.ingredient.name, "Yellow Onions")
            self.assertEqual(onion.pack_price_cents, 2000)
            self.assertEqual(onion.price_history.count(), 2)

    def test_stale_mapping_conflict_does_not_deactivate_current_product(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_stale_conflict",
                private_label="Private stale-conflict source",
                price="$20.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
            )
            holder_path = self.write_json(
                directory,
                "src_canonical_holder.json",
                [
                    {
                        "supplier": "Private canonical holder",
                        "category": "produce",
                        "sku": "CARROT-1",
                        "name": "Carrots 25 LB",
                        "price_text": "$15.00",
                        "sell_unit": "25 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-12T00:00:00Z",
                    }
                ],
            )
            holder_mapping = self.write_json(
                directory,
                "src_canonical_holder-mapping.json",
                {"CARROT-1": "Carrots"},
            )
            self.run_import(
                holder_path,
                source_key="src_canonical_holder",
                private_label="Private canonical holder",
                mapping=holder_mapping,
            )
            mixed_path = self.write_json(
                directory,
                "src_stale_conflict.json",
                [
                    {
                        "supplier": "Private stale-conflict source",
                        "category": "produce",
                        "sku": "ONION-1",
                        "name": "Stale Onion Variant 50 LB",
                        "price_text": "$17.00",
                        "sell_unit": "50 LB",
                        "currency": "USD",
                        "collected_at": "2026-08-10T00:00:00Z",
                    },
                    {
                        "supplier": "Private stale-conflict source",
                        "category": "produce",
                        "sku": "NEW-1",
                        "name": "New Unmapped Product 24 CT",
                        "price_text": "$12.00",
                        "sell_unit": "24 CT",
                        "currency": "USD",
                        "collected_at": "2026-08-13T00:00:00Z",
                    },
                ],
            )
            mixed_mapping = self.write_json(
                directory,
                "src_stale_conflict-mapping.json",
                {"ONION-1": "Carrots"},
            )

            self.run_import(
                mixed_path,
                source_key="src_stale_conflict",
                private_label="Private stale-conflict source",
                mapping=mixed_mapping,
            )

            onion = CatalogProduct.objects.get(
                source__key="src_stale_conflict", external_id="ONION-1"
            )
            self.assertTrue(onion.is_active)
            self.assertTrue(onion.is_recipe_ready)
            self.assertEqual(onion.ingredient.name, "Yellow Onions")
            self.assertEqual(onion.pack_price_cents, 2000)
            self.assertEqual(onion.price_history.count(), 2)

    def test_older_snapshot_records_history_without_replacing_current_state(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_history",
                private_label="Private history source",
                price="$30.00",
                collected_at="2026-08-12T00:00:00Z",
            )
            self.import_source(
                directory,
                source_key="src_history",
                private_label="Private history source",
                price="$19.00",
                collected_at="2026-08-10T00:00:00Z",
                include_unmapped=False,
            )

            current = CatalogProduct.objects.get(
                source__key="src_history", external_id="ONION-1"
            )
            self.assertEqual(current.pack_price_cents, 3000)
            self.assertEqual(current.price_history.count(), 2)
            self.assertTrue(
                CatalogProduct.objects.get(
                    source__key="src_history", external_id="UNMAPPED-1"
                ).is_available
            )

    def test_source_sku_identity_is_case_insensitive_across_imports(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_sku_case",
                private_label="Private SKU-case source",
                price="$20.00",
                include_unmapped=False,
            )
            product = CatalogProduct.objects.get(source__key="src_sku_case")
            product.is_active = False
            product.save(update_fields=["is_active", "updated_at"])

            self.import_source(
                directory,
                source_key="src_sku_case",
                private_label="Private SKU-case source",
                price="$21.00",
                collected_at="2026-08-12T00:00:00Z",
                include_unmapped=False,
                sku="onion-1",
            )

            self.assertEqual(
                CatalogProduct.objects.filter(source__key="src_sku_case").count(),
                1,
            )
            product.refresh_from_db()
            self.assertFalse(product.is_active)
            self.assertTrue(product.is_available)
            self.assertEqual(product.pack_price_cents, 2100)
            self.assertEqual(product.price_history.count(), 2)

    def test_catalog_api_hides_private_source_and_adopts_once(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_private",
                private_label="Do not disclose this source",
                price="$18.00",
            )

        searched = self.post_internal("search-catalog-prices", {"query": "onion"})
        self.assertEqual(searched.status_code, 200)
        payload = searched.json()
        self.assertEqual(len(payload["items"]), 1)
        self.assertEqual(payload["items"][0]["source"], "catalog")
        serialized = json.dumps(payload)
        self.assertNotIn("src_private", serialized)
        self.assertNotIn("Do not disclose", serialized)

        catalog_price_id = payload["items"][0]["catalogPriceId"]
        adopted = self.post_internal(
            "adopt-catalog-price", {"catalogPriceId": catalog_price_id}
        )
        self.assertEqual(adopted.status_code, 200)
        row = Ingredient.objects.get(id=adopted.json()["id"])
        self.assertEqual(row.price_source, Ingredient.PriceSource.CATALOG)
        self.assertIsNotNone(row.catalog_product_id)

        adopted_again = self.post_internal(
            "adopt-catalog-price", {"catalogPriceId": catalog_price_id}
        )
        self.assertEqual(adopted_again.status_code, 200)
        self.assertFalse(adopted_again.json()["created"])
        self.assertEqual(Ingredient.objects.count(), 1)

        hidden_after_adoption = self.post_internal(
            "search-catalog-prices", {"query": "onion"}
        )
        self.assertEqual(hidden_after_adoption.json()["items"], [])

    def test_catalog_search_matches_query_words_in_any_order(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_word_order",
                private_label="Private word-order source",
                price="$18.00",
            )

        # The picker falls back to this search with the recipe line still in the
        # box, so a line reading "onions yellow" has to reach "Yellow Onions"
        # exactly as the pantry side of the same dialog does.
        searched = self.post_internal(
            "search-catalog-prices", {"query": "onions yellow"}
        )
        self.assertEqual(searched.status_code, 200)
        self.assertEqual(len(searched.json()["items"]), 1)

        # Every word still has to appear, or the picker fills with near misses.
        missing_word = self.post_internal(
            "search-catalog-prices", {"query": "yellow carrots"}
        )
        self.assertEqual(missing_word.json()["items"], [])

    def test_inactive_source_cannot_be_searched_or_adopted(self):
        with TemporaryDirectory() as directory:
            self.import_source(
                directory,
                source_key="src_inactive",
                private_label="Private inactive source",
                price="$18.00",
            )

        product = CatalogProduct.objects.get(
            source__key="src_inactive", ingredient__isnull=False
        )
        product.source.is_active = False
        product.source.save(update_fields=["is_active", "updated_at"])

        searched = self.post_internal("search-catalog-prices", {"query": "onion"})
        self.assertEqual(searched.status_code, 200)
        self.assertEqual(searched.json()["items"], [])

        adopted = self.post_internal(
            "adopt-catalog-price", {"catalogPriceId": str(product.id)}
        )
        self.assertEqual(adopted.status_code, 400)
        self.assertEqual(adopted.json()["error"], "Catalog estimate not found")

    def test_source_registry_is_opaque_in_application_relationships(self):
        source = CatalogSource.objects.create(
            key="src_opaque", private_label="Private provenance"
        )
        self.assertEqual(str(source), "src_opaque")
