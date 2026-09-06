from decimal import Decimal

from django.test import TestCase

from .domains.shared.catalog_activation import catalog_conversion_fields
from .models import CatalogIngredient, CatalogIngredientMeasure


def yolk_measures():
    yolk = CatalogIngredient.objects.create(name="Egg yolk", normalized_name="egg yolk")
    by_cup = CatalogIngredientMeasure.objects.create(
        ingredient=yolk,
        unit="cup",
        amount=1,
        grams=243,
        source_kind="public_food_data",
        source_ref="yolk-cup",
        is_default=True,
    )
    by_each = CatalogIngredientMeasure.objects.create(
        ingredient=yolk,
        unit="each",
        amount=1,
        grams=17,
        source_kind="public_food_data",
        source_ref="yolk-each",
        is_default=True,
    )
    return yolk, [by_cup, by_each]


class CatalogConversionTests(TestCase):
    def test_two_measures_become_one_statement(self):
        # "1 cup is 243 g" and "1 each is 17 g" must not read as "243 g is
        # 1 cup is 1 each": the each is scaled onto the cup's grams.
        _, measures = yolk_measures()
        fields = catalog_conversion_fields(measures)
        self.assertEqual(fields["weight_amount"], Decimal("243"))
        self.assertEqual(fields["volume_amount"], Decimal("1"))
        self.assertEqual(fields["each_unit"], "each")
        self.assertAlmostEqual(float(fields["each_amount"]), 243 / 17, places=4)
