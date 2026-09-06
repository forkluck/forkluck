"""The two engines read one unit catalog, and it stays well formed.

`data/parser-vocabulary.json` is the single list `apps/web/lib/unit-registry.ts` and
`forkluck.units` both derive from, so an edit that suits one side has to suit
the other. The manifest is read here directly rather than through `units.py`,
so a bug in that module's derivation fails this test instead of hiding in it.
"""

import json
import re

from django.test import SimpleTestCase

from .models import IngredientMeasure
from .units import (
    MEASURE_UNIT_VALUES,
    PACK_UNIT_SLUGS,
    PACK_UNIT_VALUES,
    PRODUCT_UNIT_SLUGS,
    PRODUCT_UNIT_VALUES,
)
from .paths import DATA_DIR, WEB_ROOT

MANIFEST = DATA_DIR / "parser-vocabulary.json"
REGISTRY = WEB_ROOT / "lib" / "unit-registry.ts"

GROUPS = {
    "metric",
    "cooking",
    "pack",
    "produce",
    "size",
    "vague",
}
SLUG = re.compile(r"[a-z0-9-]+")


def _units() -> list[dict]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["units"]


class UnitCatalogTests(SimpleTestCase):
    def test_the_catalog_and_units_module_name_the_same_measure_units(self):
        catalog = {
            unit["slug"]
            for unit in _units()
            if unit["family"] in ("volume", "count") or unit.get("approximate")
        }
        self.assertEqual(
            catalog,
            set(MEASURE_UNIT_VALUES),
            "measure units drifted: "
            f"catalog only {sorted(catalog - set(MEASURE_UNIT_VALUES))}, "
            f"units.py only {sorted(set(MEASURE_UNIT_VALUES) - catalog)}",
        )

    def test_every_unit_belongs_to_one_of_the_known_groups(self):
        for unit in _units():
            with self.subTest(slug=unit["slug"]):
                self.assertIn(
                    unit.get("group"),
                    GROUPS,
                    f"{unit['slug']} has group {unit.get('group')!r}",
                )

    def test_mass_and_volume_convert_and_dimensionless_units_do_not(self):
        for unit in _units():
            with self.subTest(slug=unit["slug"]):
                factor = unit["perBase"]
                if unit["family"] in ("mass", "volume"):
                    self.assertIsInstance(
                        factor, (int, float), f"{unit['slug']} has no perBase"
                    )
                    self.assertGreater(
                        factor, 0, f"{unit['slug']} perBase is not positive"
                    )
                elif unit["family"] == "dimensionless":
                    self.assertIsNone(
                        factor, f"{unit['slug']} is dimensionless but has a perBase"
                    )

    def test_slugs_are_unique_and_safe_to_store_and_put_in_a_url(self):
        slugs = [unit["slug"] for unit in _units()]
        duplicates = sorted({slug for slug in slugs if slugs.count(slug) > 1})
        self.assertEqual(duplicates, [], f"duplicate unit slugs: {duplicates}")
        for slug in slugs:
            with self.subTest(slug=slug):
                self.assertRegex(slug, rf"^{SLUG.pattern}$")

    def test_an_approximate_unit_states_the_factor_it_is_approximating(self):
        for unit in _units():
            if unit.get("approximate"):
                with self.subTest(slug=unit["slug"]):
                    self.assertIsNotNone(
                        unit["perBase"],
                        f"{unit['slug']} is approximate with nothing to approximate",
                    )

    def test_the_measure_unit_column_holds_every_measure_slug(self):
        longest = max(
            (
                unit["slug"]
                for unit in _units()
                if unit["family"] in ("volume", "count")
            ),
            key=len,
        )
        limit = IngredientMeasure._meta.get_field("unit").max_length
        self.assertLessEqual(
            len(longest),
            limit,
            f"{longest} is {len(longest)} characters, column holds {limit}",
        )

    def test_a_product_unit_is_a_real_catalog_slug(self):
        catalog = {unit["slug"] for unit in _units()}
        unknown = sorted(set(PRODUCT_UNIT_VALUES) - catalog)
        self.assertEqual(
            unknown, [], f"product units are not in the catalog: {unknown}"
        )

    def test_the_two_engines_offer_the_same_product_units(self):
        """The picker and the validator have to agree on the whole list.

        A slug in the registry but not in `units.py` builds a picker row the
        save action then refuses; one in `units.py` alone is a unit nobody can
        choose. The list is curated rather than derived on both sides, so
        nothing but this test keeps the two copies together.
        """
        source = (REGISTRY).read_text(encoding="utf-8")
        block = re.search(
            r"export const PRODUCT_UNIT_SLUGS = \[(.*?)\] as const",
            source,
            re.S,
        )
        self.assertIsNotNone(
            block, "PRODUCT_UNIT_SLUGS is no longer declared in apps/web/lib/unit-registry.ts"
        )
        registry = re.findall(r'"([a-z0-9-]+)"', block.group(1))
        self.assertEqual(
            registry,
            list(PRODUCT_UNIT_SLUGS),
            "product units drifted between apps/web/lib/unit-registry.ts and units.py",
        )

    def test_a_pack_unit_is_a_real_catalog_slug(self):
        catalog = {unit["slug"] for unit in _units()}
        unknown = sorted(set(PACK_UNIT_VALUES) - catalog)
        self.assertEqual(unknown, [], f"pack units are not in the catalog: {unknown}")

    def test_the_two_engines_offer_the_same_pack_units(self):
        """The purchase picker and the import validator agree on one list.

        A slug the picker offers but `units.py` refuses is a pack nobody can
        import; one `units.py` allows but the picker never shows is a unit
        nobody can choose. Curated on both sides, so only this test holds them
        together.
        """
        source = (REGISTRY).read_text(encoding="utf-8")
        block = re.search(
            r"export const PACK_UNIT_SLUGS = \[(.*?)\] as const",
            source,
            re.S,
        )
        self.assertIsNotNone(
            block, "PACK_UNIT_SLUGS is no longer declared in apps/web/lib/unit-registry.ts"
        )
        registry = re.findall(r'"([a-z0-9-]+)"', block.group(1))
        self.assertEqual(
            registry,
            list(PACK_UNIT_SLUGS),
            "pack units drifted between apps/web/lib/unit-registry.ts and units.py",
        )
