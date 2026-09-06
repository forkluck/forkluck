"""The supplier memory behind auto-matching, as Suppliers → Mapping edits it.

Every row here is keyed on the supplier string, so renaming or merging a
supplier has to carry the relinked and ignored rows along with the invoices.
"""

from datetime import date
from decimal import Decimal

from .models import (
    Ingredient,
    Invoice,
    InvoiceLine,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    User,
)
from .testing import InternalApiTestCase


class SupplierItemsTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="mapping@example.com",
            name="Mapping Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client.force_login(self.user)
        self.butter = self.ingredient("Butter")
        self.margarine = self.ingredient("Margarine")
        Supplier.objects.create(user=self.user, key="baldor", name="Baldor")
        self.invoice = Invoice.objects.create(
            user=self.user,
            supplier="baldor",
            supplier_name="Baldor",
            invoice_date=date(2026, 1, 15),
            total_cents=2400,
            source_fingerprint="mapping-fp-1",
            file_name="baldor.pdf",
        )
        self.item = self.supplier_item("DABUT11", "Butter 36X1 LB", self.butter)
        self.line = self.invoice_line(0, self.item)

    def ingredient(self, name: str) -> Ingredient:
        return Ingredient.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=1200,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )

    def supplier_item(
        self, external_id: str, title: str, ingredient: Ingredient, **extra
    ) -> SupplierItem:
        return SupplierItem.objects.create(
            user=self.user,
            ingredient=ingredient,
            supplier="baldor",
            external_id=external_id,
            title=title,
            raw_size="36X1 LB",
            pack_price_cents=1200,
            pack_grams=1000,
            pack_amount=Decimal("1"),
            pack_unit="kg",
            **extra,
        )

    def invoice_line(self, position: int, item: SupplierItem) -> InvoiceLine:
        return InvoiceLine.objects.create(
            user=self.user,
            invoice=self.invoice,
            position=position,
            sku=item.external_id if not item.external_id.startswith("desc:") else "",
            description=item.title,
            item_key=item.external_id,
            line_amount_cents=1200,
            supplier_item=item,
            ingredient=item.ingredient,
        )

    def read(self, **params) -> dict:
        response = self.get_internal("supplier-items/", params or None)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_items_page_carries_the_row_the_table_draws(self):
        self.invoice_line(1, self.item)
        payload = self.read()
        self.assertEqual(payload["total"], 1)
        row = payload["items"][0]
        self.assertEqual(row["supplier"], "baldor")
        self.assertEqual(row["supplierName"], "Baldor")
        self.assertEqual(row["externalId"], "DABUT11")
        self.assertTrue(row["hasCode"])
        self.assertEqual(row["ingredientName"], "Butter")
        self.assertEqual(row["timesSeen"], 2)
        self.assertEqual(row["lastInvoiceDate"], "2026-01-15")

    def test_a_description_key_reads_as_having_no_code(self):
        self.supplier_item("desc:og hvy whp crm", "OG HVY WHP CRM", self.margarine)
        rows = {row["externalId"]: row for row in self.read()["items"]}
        self.assertFalse(rows["desc:og hvy whp crm"]["hasCode"])
        self.assertEqual(rows["desc:og hvy whp crm"]["timesSeen"], 0)
        self.assertIsNone(rows["desc:og hvy whp crm"]["lastInvoiceDate"])

    def test_a_supplier_without_a_record_still_shows_a_name(self):
        SupplierItem.objects.filter(id=self.item.id).update(supplier="great river")
        self.assertEqual(self.read()["items"][0]["supplierName"], "Great River")

    def test_search_and_paging_narrow_the_page_not_the_total(self):
        for index in range(3):
            self.supplier_item(f"FLOUR{index}", f"Flour {index}", self.margarine)
        self.assertEqual(self.read(q="flour")["total"], 3)
        self.assertEqual(self.read(q="FLOUR1")["total"], 1)
        self.assertEqual(self.read(supplier="baldor")["total"], 4)
        self.assertEqual(self.read(supplier="wegmans")["total"], 0)
        page = self.read(limit="2", offset="2")
        self.assertEqual(page["total"], 4)
        self.assertEqual(len(page["items"]), 2)

    def test_ignored_tab_reads_the_skip_list(self):
        self.post_internal("ignore-supplier-item", {"itemId": str(self.item.id)})
        self.assertEqual(self.read()["total"], 0)
        payload = self.read(tab="ignored")
        self.assertEqual(payload["total"], 1)
        self.assertEqual(
            payload["items"][0]["externalId"], self.item.external_id
        )
        self.assertEqual(payload["items"][0]["title"], "Butter 36X1 LB")

    def test_relink_moves_the_pack_and_its_invoice_lines(self):
        response = self.post_internal(
            "relink-supplier-item",
            {"itemId": str(self.item.id), "ingredientId": str(self.margarine.id)},
        )
        self.assertEqual(response.json(), {"ok": True})
        self.item.refresh_from_db()
        self.line.refresh_from_db()
        self.assertEqual(self.item.ingredient_id, self.margarine.id)
        self.assertEqual(self.line.ingredient_id, self.margarine.id)

    def test_relink_promotes_the_next_pack_the_ingredient_still_has(self):
        SupplierItem.objects.filter(id=self.item.id).update(is_preferred=True)
        spare = self.supplier_item("DABUT12", "Butter 12X1 LB", self.butter)
        self.post_internal(
            "relink-supplier-item",
            {"itemId": str(self.item.id), "ingredientId": str(self.margarine.id)},
        )
        spare.refresh_from_db()
        self.item.refresh_from_db()
        self.assertTrue(spare.is_preferred)
        # Margarine had no preferred pack, so the arriving one takes the flag.
        self.assertTrue(self.item.is_preferred)

    def test_relink_leaves_the_flag_alone_when_the_target_has_one(self):
        held = self.supplier_item(
            "MARG1", "Margarine", self.margarine, is_preferred=True
        )
        self.post_internal(
            "relink-supplier-item",
            {"itemId": str(self.item.id), "ingredientId": str(self.margarine.id)},
        )
        self.item.refresh_from_db()
        held.refresh_from_db()
        self.assertFalse(self.item.is_preferred)
        self.assertTrue(held.is_preferred)

    def test_relink_refuses_another_workspace_ingredient(self):
        other = User.objects.create_user(
            email="mapping-other@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        theirs = Ingredient.objects.create(
            user=other,
            name="Butter",
            normalized_name="butter",
            purchase_cost_cents=1200,
            purchase_size=Decimal("1"),
            purchase_unit="kg",
        )
        response = self.post_internal(
            "relink-supplier-item",
            {"itemId": str(self.item.id), "ingredientId": str(theirs.id)},
        )
        self.assertEqual(response.status_code, 400)
        self.item.refresh_from_db()
        self.assertEqual(self.item.ingredient_id, self.butter.id)

    def test_ignore_drops_the_pack_and_unlinks_its_lines(self):
        self.post_internal("ignore-supplier-item", {"itemId": str(self.item.id)})
        self.line.refresh_from_db()
        self.assertIsNone(self.line.ingredient_id)
        self.assertIsNone(self.line.supplier_item_id)
        self.assertFalse(SupplierItem.objects.filter(id=self.item.id).exists())
        ignore = SupplierItemIgnore.objects.get(user=self.user)
        self.assertEqual(
            (ignore.supplier, ignore.external_id, ignore.title, ignore.raw_size),
            ("baldor", "DABUT11", "Butter 36X1 LB", "36X1 LB"),
        )

    def test_unignore_removes_the_skip_row(self):
        self.post_internal("ignore-supplier-item", {"itemId": str(self.item.id)})
        self.post_internal(
            "unignore-supplier-item",
            {"supplier": "Baldor", "externalId": "DABUT11"},
        )
        self.assertEqual(SupplierItemIgnore.objects.count(), 0)

    def test_delete_drops_the_pack_without_skipping_it(self):
        self.post_internal("delete-supplier-item", {"itemId": str(self.item.id)})
        self.assertFalse(SupplierItem.objects.filter(id=self.item.id).exists())
        self.assertEqual(SupplierItemIgnore.objects.count(), 0)

    def test_actions_refuse_another_workspace_pack(self):
        other = User.objects.create_user(
            email="mapping-thief@example.com",
            name="Thief",
            password="a-long-test-passphrase-2468",
        )
        client = self.client_class()
        client.force_login(other)
        for slug in ("ignore-supplier-item", "delete-supplier-item"):
            response = self.post_internal(
                slug, {"itemId": str(self.item.id)}, client=client
            )
            self.assertEqual(response.status_code, 400)
        self.assertTrue(SupplierItem.objects.filter(id=self.item.id).exists())

    def test_relinked_and_ignored_rows_survive_a_rename_and_a_merge(self):
        self.post_internal(
            "relink-supplier-item",
            {"itemId": str(self.item.id), "ingredientId": str(self.margarine.id)},
        )
        skipped = self.supplier_item("FLOUR8C", "Flour 8C", self.butter)
        self.post_internal("ignore-supplier-item", {"itemId": str(skipped.id)})

        supplier = Supplier.objects.get(user=self.user, key="baldor")
        self.assertEqual(
            self.post_internal(
                "save-supplier", {"id": str(supplier.id), "name": "Baldor Produce"}
            ).status_code,
            200,
        )
        supplier.refresh_from_db()
        self.item.refresh_from_db()
        self.assertEqual(self.item.supplier, supplier.key)
        self.assertEqual(self.item.ingredient_id, self.margarine.id)
        self.assertEqual(
            SupplierItemIgnore.objects.get(user=self.user).supplier, supplier.key
        )
        self.assertEqual(self.read(supplier=supplier.key)["total"], 1)
        self.assertEqual(
            self.read(supplier=supplier.key, tab="ignored")["total"], 1
        )

        target = Supplier.objects.create(
            user=self.user, key="great river", name="Great River"
        )
        self.assertEqual(
            self.post_internal(
                "merge-suppliers",
                {"sourceId": str(supplier.id), "targetId": str(target.id)},
            ).status_code,
            200,
        )
        self.item.refresh_from_db()
        self.assertEqual(self.item.supplier, "great river")
        self.assertEqual(self.item.ingredient_id, self.margarine.id)
        self.assertEqual(
            SupplierItemIgnore.objects.get(user=self.user).supplier, "great river"
        )
        self.assertEqual(self.read(supplier="great river")["total"], 1)
        self.assertEqual(
            self.read(supplier="great river", tab="ignored")["total"], 1
        )
