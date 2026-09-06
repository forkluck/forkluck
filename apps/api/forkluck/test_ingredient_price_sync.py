"""The materialized-price invariant.

`Ingredient.purchase_cost_cents/purchase_size/purchase_unit` and
`price_source` are a materialization of the latest `IngredientPrice` row,
written only through `domains/shared/ingredient_pricing.py`. After every
mutation path the tuple must equal the latest history row, and the history
row must say where the price came from.

Matrix: mutation paths {save create, save edit, rename-only save, repeat
save, supplier import create, supplier import price update, set-preferred,
merge} × units {g, kg, oz, lb} × integer/fractional amounts.
"""

import json
from datetime import datetime
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.conf import settings
from django.test import Client

from .domains.shared.ingredient_pricing import PRICE_FIELDS, rematerialize_price
from .models import (
    Ingredient,
    IngredientImport,
    IngredientMeasure,
    IngredientPrice,
    SupplierItem,
    User,
)
from .testing import InternalApiTestCase


class IngredientPriceSyncTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.client = Client(enforce_csrf_checks=True)
        token_response = self.client.get("/api/auth/csrf")
        token = token_response.cookies[settings.CSRF_COOKIE_NAME].value
        self.client.post(
            "/api/auth/register",
            data=json.dumps(
                {
                    "name": "Sync Chef",
                    "email": "sync@example.com",
                    "password": "a-long-test-passphrase-2468",
                }
            ),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.user = User.objects.get(email="sync@example.com")

    def priced_ingredient(self, name: str, price_cents: int) -> Ingredient:
        return Ingredient.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=price_cents,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )

    def latest_price(self, ingredient: Ingredient) -> IngredientPrice:
        latest = (
            IngredientPrice.objects.filter(ingredient=ingredient)
            .order_by("-effective_at", "-created_at")
            .first()
        )
        self.assertIsNotNone(latest)
        return latest

    def assert_synced(
        self,
        ingredient: Ingredient,
        *,
        history_source: str,
        price_source: str,
    ) -> None:
        ingredient.refresh_from_db()
        latest = self.latest_price(ingredient)
        for field in PRICE_FIELDS:
            self.assertEqual(
                getattr(ingredient, field),
                getattr(latest, field),
                f"{field} diverged from the latest history row",
            )
        self.assertEqual(latest.source, history_source)
        self.assertEqual(ingredient.price_source, price_source)

    def test_rematerialize_uses_surviving_history_or_becomes_unpriced(self) -> None:
        ingredient = self.priced_ingredient("History", 900)
        older = IngredientPrice.objects.create(
            ingredient=ingredient,
            purchase_cost_cents=400,
            purchase_size=Decimal("2"),
            purchase_unit="kg",
            source=IngredientPrice.Source.SUPPLIER,
            effective_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
        )
        IngredientPrice.objects.create(
            ingredient=ingredient,
            purchase_cost_cents=900,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
            source=IngredientPrice.Source.USER,
            effective_at=datetime(2026, 2, 1, tzinfo=dt_timezone.utc),
        ).delete()

        rematerialize_price(ingredient)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, older.purchase_cost_cents)
        self.assertEqual(ingredient.purchase_size, older.purchase_size)
        self.assertEqual(ingredient.price_source, Ingredient.PriceSource.USER)

        older.delete()
        rematerialize_price(ingredient)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 0)
        self.assertIsNone(ingredient.purchase_size)
        self.assertIsNone(ingredient.purchase_unit)

    # ---- save-ingredient ---------------------------------------------------

    def test_save_create_is_synced_for_every_unit(self) -> None:
        for index, (unit, amount) in enumerate(
            [("g", 500), ("kg", 2.5), ("oz", 12), ("lb", 0.1)]
        ):
            response = self.post_internal(
                "save-ingredient",
                {
                    "id": None,
                    "name": f"Sync test {index}",
                    "purchaseCostCents": 1000 + index,
                    "purchaseSize": amount,
                    "purchaseUnit": unit,
                },
            )
            self.assertEqual(response.status_code, 200)
            ingredient = Ingredient.objects.get(
                user=self.user, id=response.json()["id"]
            )
            self.assert_synced(
                ingredient, history_source="user", price_source="user"
            )

    def test_save_create_allows_an_unpriced_draft_but_rejects_malformed_unit(self) -> None:
        for index, size, unit in (
            ("null", None, None),
            ("blank", "", "  "),
        ):
            response = self.post_internal(
                "save-ingredient",
                {
                    "id": None,
                    "name": f"Draft ingredient {index}",
                    "purchaseCostCents": 0,
                    "purchaseSize": size,
                    "purchaseUnit": unit,
                },
            )
            self.assertEqual(response.status_code, 200)
            ingredient = Ingredient.objects.get(user=self.user, id=response.json()["id"])
            self.assertIsNone(ingredient.purchase_size)
            self.assertIsNone(ingredient.purchase_unit)
            self.assertEqual(ingredient.price_history.count(), 0)

        malformed = self.post_internal(
            "save-ingredient",
            {
                "id": None,
                "name": "Malformed draft",
                "purchaseCostCents": 0,
                "purchaseSize": None,
                "purchaseUnit": 123,
            },
        )
        self.assertEqual(malformed.status_code, 400)

    def test_save_edit_appends_history_and_stays_synced(self) -> None:
        created = self.post_internal(
            "save-ingredient",
            {
                "id": None,
                "name": "Bread flour",
                "purchaseCostCents": 1850,
                "purchaseSize": 25,
                "purchaseUnit": "kg",
            },
        )
        ingredient_id = created.json()["id"]
        self.post_internal(
            "save-ingredient",
            {
                "id": ingredient_id,
                "name": "Bread flour",
                "purchaseCostCents": 1990,
                "purchaseSize": 25,
                "purchaseUnit": "kg",
            },
        )
        ingredient = Ingredient.objects.get(user=self.user, id=ingredient_id)
        self.assertEqual(ingredient.price_history.count(), 2)
        self.assert_synced(ingredient, history_source="user", price_source="user")

    def test_rename_only_save_records_no_history(self) -> None:
        created = self.post_internal(
            "save-ingredient",
            {
                "id": None,
                "name": "Kosher salt",
                "purchaseCostCents": 300,
                "purchaseSize": 0.1,
                "purchaseUnit": "kg",
            },
        )
        ingredient_id = created.json()["id"]
        self.post_internal(
            "save-ingredient",
            {
                "id": ingredient_id,
                "name": "Kosher salt (fine)",
                "purchaseCostCents": 300,
                "purchaseSize": 0.1,
                "purchaseUnit": "kg",
            },
        )
        ingredient = Ingredient.objects.get(user=self.user, id=ingredient_id)
        self.assertEqual(ingredient.name, "Kosher salt (fine)")
        self.assertEqual(ingredient.price_history.count(), 1)
        self.assert_synced(ingredient, history_source="user", price_source="user")

    def test_repeat_save_of_a_fractional_amount_is_a_no_op(self) -> None:
        """0.1 has no exact float form; a repeated identical save must still
        compare equal against the Decimal column and add no history."""
        body = {
            "id": None,
            "name": "Vanilla extract",
            "purchaseCostCents": 4200,
            "purchaseSize": 0.1,
            "purchaseUnit": "lb",
        }
        first = self.post_internal("save-ingredient", body)
        ingredient_id = first.json()["id"]
        self.post_internal("save-ingredient", {**body, "id": ingredient_id})
        self.post_internal("save-ingredient", {**body, "id": ingredient_id})
        ingredient = Ingredient.objects.get(user=self.user, id=ingredient_id)
        self.assertEqual(ingredient.price_history.count(), 1)
        self.assertEqual(ingredient.purchase_size, Decimal("0.1"))

    # ---- supplier import ---------------------------------------------------

    def supplier_entry(self, **overrides) -> dict:
        entry = {
            "supplier": "harbor",
            "externalId": "sku-1",
            "name": "Baby Arugula",
            "rawSize": "3 LB",
            "quantity": 2,
            "packAmount": 3,
            "packUnit": "lb",
            "packPriceCents": 1775,
            "periodStart": "2025-07-01",
            "periodEnd": "2026-08-06",
            "preferred": True,
        }
        entry.update(overrides)
        return entry

    def test_supplier_import_create_labels_history_supplier(self) -> None:
        response = self.post_internal(
            "import-ingredients", {"entries": [self.supplier_entry()]}
        )
        self.assertEqual(response.status_code, 200)
        ingredient = Ingredient.objects.get(
            user=self.user, normalized_name="baby arugula"
        )
        # The ingredient's own label stays "user": a supplier price is still
        # the merchant's price. The history row keeps the finer origin.
        self.assert_synced(
            ingredient, history_source="supplier", price_source="user"
        )

    def test_supplier_price_update_links_the_supplier_item(self) -> None:
        self.post_internal(
            "import-ingredients", {"entries": [self.supplier_entry()]}
        )
        self.post_internal(
            "import-ingredients",
            {"entries": [self.supplier_entry(packPriceCents=1990)]},
        )
        ingredient = Ingredient.objects.get(
            user=self.user, normalized_name="baby arugula"
        )
        self.assert_synced(
            ingredient, history_source="supplier", price_source="user"
        )
        latest = self.latest_price(ingredient)
        self.assertIsNotNone(latest.supplier_item)
        self.assertEqual(latest.supplier_item.external_id, "sku-1")

    def test_set_preferred_supplier_item_moves_the_price_with_provenance(
        self,
    ) -> None:
        self.post_internal(
            "import-ingredients",
            {
                "entries": [
                    self.supplier_entry(),
                    self.supplier_entry(
                        externalId="sku-2",
                        rawSize="4 LB",
                        packAmount=4,
                        packPriceCents=1925,
                        preferred=False,
                    ),
                ]
            },
        )
        ingredient = Ingredient.objects.get(
            user=self.user, normalized_name="baby arugula"
        )
        other = SupplierItem.objects.get(user=self.user, external_id="sku-2")

        before = ingredient.edit_version
        response = self.post_internal(
            "set-preferred-supplier-item", {"id": str(other.id)}
        )
        self.assertEqual(response.status_code, 200)
        # It re-prices the ingredient, so it bumps against an open form.
        self.assertEqual(response.json(), {"ok": True, "editVersion": before + 1})

        other.refresh_from_db()
        self.assertTrue(other.is_preferred)
        self.assert_synced(
            ingredient, history_source="supplier", price_source="user"
        )
        latest = self.latest_price(ingredient)
        self.assertEqual(latest.supplier_item_id, other.id)
        self.assertEqual(latest.purchase_size, Decimal("4"))

    def test_a_reparented_pack_promotes_the_old_ingredients_next_pack(self) -> None:
        self.post_internal(
            "import-ingredients",
            {
                "entries": [
                    self.supplier_entry(),
                    self.supplier_entry(
                        externalId="sku-2",
                        rawSize="4 LB",
                        packAmount=4,
                        packPriceCents=1925,
                        preferred=False,
                    ),
                ]
            },
        )
        arugula = Ingredient.objects.get(
            user=self.user, normalized_name="baby arugula"
        )
        other = Ingredient.objects.create(
            user=self.user,
            name="Wild arugula",
            normalized_name="wild arugula",
            purchase_cost_cents=500,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )

        # The reviewer maps sku-1 onto a different ingredient.
        response = self.post_internal(
            "import-ingredients",
            {
                "entries": [
                    self.supplier_entry(
                        name="Wild arugula",
                        packPriceCents=2000,
                        ingredientId=str(other.id),
                    )
                ]
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        moved = SupplierItem.objects.get(user=self.user, external_id="sku-1")
        self.assertEqual(moved.ingredient_id, other.id)
        # The pack that priced Baby Arugula left, so its remaining pack takes
        # over instead of the ingredient keeping a price it no longer sources.
        remaining = SupplierItem.objects.get(user=self.user, external_id="sku-2")
        self.assertTrue(remaining.is_preferred)
        arugula.refresh_from_db()
        self.assertEqual(arugula.purchase_cost_cents, 1925)
        self.assert_synced(
            arugula, history_source="supplier", price_source="user"
        )

    def test_undoing_a_reparent_restores_the_promotion_too(self) -> None:
        self.post_internal(
            "import-ingredients",
            {
                "entries": [
                    self.supplier_entry(),
                    self.supplier_entry(
                        externalId="sku-2",
                        rawSize="4 LB",
                        packAmount=4,
                        packPriceCents=1925,
                        preferred=False,
                    ),
                ]
            },
        )
        arugula = Ingredient.objects.get(
            user=self.user, normalized_name="baby arugula"
        )
        before_price = arugula.purchase_cost_cents
        before_history = IngredientPrice.objects.filter(ingredient=arugula).count()
        other = Ingredient.objects.create(
            user=self.user,
            name="Wild arugula",
            normalized_name="wild arugula",
            purchase_cost_cents=500,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )

        response = self.post_internal(
            "import-ingredients",
            {
                "entries": [
                    self.supplier_entry(
                        name="Wild arugula",
                        packPriceCents=2000,
                        ingredientId=str(other.id),
                    )
                ]
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        import_id = str(
            IngredientImport.objects.filter(user=self.user).first().id
        )

        response = self.post_internal("undo-ingredient-import", {"id": import_id})
        self.assertEqual(response.status_code, 200, response.content)

        # The move itself is reverted…
        moved = SupplierItem.objects.get(user=self.user, external_id="sku-1")
        self.assertEqual(moved.ingredient_id, arugula.id)
        self.assertTrue(moved.is_preferred)
        # …and so is the promotion it triggered: one preferred pack, the old
        # price back, and the promotion's history row gone.
        remaining = SupplierItem.objects.get(user=self.user, external_id="sku-2")
        self.assertFalse(remaining.is_preferred)
        arugula.refresh_from_db()
        self.assertEqual(arugula.purchase_cost_cents, before_price)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=arugula).count(),
            before_history,
        )
        self.assert_synced(
            arugula, history_source="supplier", price_source="user"
        )
        other.refresh_from_db()
        self.assertEqual(other.purchase_cost_cents, 500)

    # ---- merge -------------------------------------------------------------

    def test_merge_adopting_a_preferred_pack_relabels_the_target(self) -> None:
        self.post_internal(
            "import-ingredients",
            {"entries": [self.supplier_entry(name="Arugula source")]},
        )
        source = Ingredient.objects.get(
            user=self.user, normalized_name="arugula source"
        )
        # A catalog-labelled target with no supplier items of its own.
        target = Ingredient.objects.create(
            user=self.user,
            name="Arugula target",
            normalized_name="arugula target",
            purchase_cost_cents=999,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
            price_source=Ingredient.PriceSource.CATALOG,
        )

        response = self.post_internal(
            "merge-ingredients",
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )
        self.assertEqual(response.status_code, 200)

        # The target now costs from the adopted supplier pack, so the stale
        # catalog label moves with the price instead of surviving it.
        self.assert_synced(
            target, history_source="supplier", price_source="user"
        )
        latest = self.latest_price(target)
        self.assertIsNotNone(latest.supplier_item)
        self.assertEqual(latest.purchase_cost_cents, 1775)

    def test_merge_keeps_its_own_price_at_the_head_of_the_history(self) -> None:
        """The source's rows move into the target's history. A source price that
        moved more recently must not end up as the target's head row, which the
        history dialog reads as the current price."""
        target = self.priced_ingredient("Target arugula", 1200)
        SupplierItem.objects.create(
            user=self.user,
            ingredient=target,
            supplier="harbor",
            external_id="target-1",
            title="Target arugula",
            raw_size="1 KG",
            pack_price_cents=1200,
            pack_grams=1000,
            pack_amount=Decimal("1"),
            pack_unit="kg",
            is_preferred=True,
        )
        IngredientPrice.objects.create(
            ingredient=target,
            purchase_cost_cents=1200,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
            effective_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
        )
        source = self.priced_ingredient("Source arugula", 900)
        IngredientPrice.objects.create(
            ingredient=source,
            purchase_cost_cents=900,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
            effective_at=datetime(2026, 6, 1, tzinfo=dt_timezone.utc),
        )

        response = self.post_internal(
            "merge-ingredients",
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )
        self.assertEqual(response.status_code, 200)

        target.refresh_from_db()
        self.assertEqual(target.purchase_cost_cents, 1200)
        self.assert_synced(target, history_source="user", price_source="user")

    def test_merge_counts_measures_the_target_wins(self) -> None:
        target = self.priced_ingredient("Measure target", 1000)
        source = self.priced_ingredient("Measure source", 1000)
        IngredientMeasure.objects.create(
            ingredient=target, unit="cup", qualifier="", amount=1, grams=120
        )
        IngredientMeasure.objects.create(
            ingredient=source, unit="cup", qualifier="", amount=1, grams=95
        )
        IngredientMeasure.objects.create(
            ingredient=source, unit="tbsp", qualifier="", amount=1, grams=8
        )

        response = self.post_internal(
            "merge-ingredients",
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )

        self.assertEqual(response.json()["droppedMeasures"], 1)
        self.assertEqual(
            IngredientMeasure.objects.get(ingredient=target, unit="cup").grams, 120
        )
        self.assertTrue(
            IngredientMeasure.objects.filter(ingredient=target, unit="tbsp").exists()
        )
