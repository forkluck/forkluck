import json
import os
import tempfile
from pathlib import Path
from unittest import TestCase, mock

from .master_prices import CATALOG_PATH_ENV, load_master_prices


class PrivateMasterPriceCatalogTests(TestCase):
    def test_no_configured_catalog_has_no_embedded_fallback(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_master_prices(), ())

    def test_loads_a_configured_private_catalog(self):
        row = {
            "masterPriceId": "00000000-0000-4000-8000-000000000001",
            "name": "Test Ingredient",
            "packPriceCents": 123,
            "packAmount": 2,
            "packUnit": "kg",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "catalog.json")
            path.write_text(json.dumps([row]), encoding="utf-8")
            with mock.patch.dict(os.environ, {CATALOG_PATH_ENV: str(path)}):
                prices = load_master_prices()

        self.assertEqual(len(prices), 1)
        self.assertEqual(prices[0].name, "Test Ingredient")
        self.assertEqual(prices[0].pack_grams, 2000)

    def test_rejects_duplicate_names_and_invalid_rows(self):
        row = {
            "masterPriceId": "00000000-0000-4000-8000-000000000001",
            "name": "Test Ingredient",
            "packPriceCents": 123,
            "packAmount": 2,
            "packUnit": "kg",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "catalog.json")
            path.write_text(json.dumps([row, row]), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "ids must be unique"):
                load_master_prices(path)

            path.write_text("not json", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "file cannot be read"):
                load_master_prices(path)
