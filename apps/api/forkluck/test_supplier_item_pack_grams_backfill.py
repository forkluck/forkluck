"""0038 turns the 0-gram sentinel of non-weight packs into null, and leaves
weight packs and their real grams alone."""

import importlib
from decimal import Decimal

from django.apps import apps

from .models import Ingredient, SupplierItem, User
from .testing import InternalApiTestCase


class SupplierItemPackGramsBackfillTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="grams@example.com",
            name="Grams Tester",
            password="a-long-test-passphrase-2468",
        )

    def item(self, external_id: str, unit: str, grams: int | None) -> SupplierItem:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name=external_id,
            normalized_name=external_id.lower(),
            purchase_cost_cents=1200,
            purchase_size=Decimal("1"),
            purchase_unit=unit,
        )
        return SupplierItem.objects.create(
            user=self.user,
            ingredient=ingredient,
            supplier="baldor",
            external_id=external_id,
            title=external_id,
            raw_size="",
            pack_price_cents=1200,
            pack_grams=grams,
            pack_amount=Decimal("1"),
            pack_unit=unit,
        )

    def test_only_the_sentinel_of_non_weight_packs_becomes_null(self) -> None:
        gallons = self.item("MILK1GAL", "gal", 0)
        eaches = self.item("EGGS12", "each", 0)
        pounds = self.item("BUTTER1LB", "lb", 454)
        zero_pounds = self.item("EMPTY", "lb", 0)

        module = importlib.import_module(
            ".migrations.0038_backfill_supplier_item_pack_grams", package=__package__
        )
        module.null_non_weight_grams(apps, None)

        for row in (gallons, eaches, pounds, zero_pounds):
            row.refresh_from_db()
        self.assertIsNone(gallons.pack_grams)
        self.assertIsNone(eaches.pack_grams)
        self.assertEqual(pounds.pack_grams, 454)
        # A weight pack is never touched, even at zero: its grams are its own.
        self.assertEqual(zero_pounds.pack_grams, 0)
