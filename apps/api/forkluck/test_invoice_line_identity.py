"""Invoice edits preserve each occurrence's ingredient price references."""

from decimal import Decimal

from .models import Ingredient, IngredientInvoicePrice, Invoice, User
from .test_invoices import InvoiceTestCase


class InvoiceLineIdentityTests(InvoiceTestCase):
    def document(self, *, sku="REPEATED", number="IDENTITY-1"):
        lines = [
            self.expense_line(
                sku=sku, description="Synthetic flour", quantity=1,
                unitPriceCents=price, lineAmountCents=price,
            )
            for price in (1000, 2000)
        ]
        body = {
            "supplierName": "Synthetic supplier", "invoiceNumber": number,
            "invoiceDate": "2026-09-01", "totalCents": 3000, "lines": lines,
        }
        response = self.post_internal("save-invoice", body)
        self.assertEqual(response.status_code, 200, response.content)
        item = response.json()["item"]
        body["id"] = item["id"]
        for position, (line, saved) in enumerate(zip(lines, item["lines"], strict=True)):
            line["id"] = saved["id"]
            ingredient = Ingredient.objects.create(
                user=self.user, name=f"Synthetic flour {number} {position}",
                purchase_cost_cents=500, purchase_size=1, purchase_unit="kg",
            )
            response = self.post_internal("link-invoice-line", {
                "ingredientId": str(ingredient.id), "lineId": saved["id"],
                "purchaseSize": position + 1, "purchaseUnit": "kg",
            })
            self.assertEqual(response.status_code, 200, response.content)
        return body

    def prices(self, invoice_id):
        return list(
            IngredientInvoicePrice.objects.filter(invoice_line__invoice_id=invoice_id)
            .order_by("invoice_line__position")
            .values_list("ingredient_id", "purchase_size", "purchase_unit")
        )

    def test_notes_save_preserves_each_repeated_sku_or_description(self):
        for sku in ("REPEATED", ""):
            for explicit_ids in (True, False):
                with self.subTest(sku=sku, explicit_ids=explicit_ids):
                    body = self.document(sku=sku, number=f"{sku}-{explicit_ids}")
                    before = self.prices(body["id"])
                    original_ids = [line["id"] for line in body["lines"]]
                    if not explicit_ids:
                        for line in body["lines"]:
                            del line["id"]
                    response = self.post_internal("save-invoice", {**body, "notes": "A note"})
                    self.assertEqual(response.status_code, 200, response.content)
                    self.assertEqual(self.prices(body["id"]), before)
                    self.assertEqual(
                        [line["id"] for line in response.json()["item"]["lines"]],
                        original_ids,
                    )

    def test_reorder_rename_and_delete_follow_the_exact_line(self):
        body = self.document()
        before = self.prices(body["id"])
        body["lines"].reverse()
        body["lines"][0]["description"] = "Corrected flour description"
        response = self.post_internal("save-invoice", body)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.prices(body["id"]), list(reversed(before)))
        body["lines"] = body["lines"][:1]
        response = self.post_internal("save-invoice", body)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.prices(body["id"]), [before[1]])

    def test_new_repeated_line_does_not_copy_an_existing_price_link(self):
        body = self.document()
        before = self.prices(body["id"])
        body["lines"].insert(0, {**body["lines"][0], "id": None})
        response = self.post_internal("save-invoice", body)
        self.assertEqual(response.status_code, 200, response.content)
        first_id = response.json()["item"]["lines"][0]["id"]
        self.assertFalse(IngredientInvoicePrice.objects.filter(invoice_line_id=first_id).exists())
        self.assertEqual(self.prices(body["id"]), before)
        self.assertEqual(before[0][1], Decimal("1"))

    def test_explicit_ids_are_reserved_before_legacy_occurrences(self):
        body = self.document()
        before = self.prices(body["id"])
        body["lines"].reverse()
        del body["lines"][0]["id"]
        response = self.post_internal("save-invoice", body)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.prices(body["id"]), list(reversed(before)))

    def test_foreign_and_repeated_line_ids_roll_back_the_whole_save(self):
        body = self.document()
        other = self.document(number="OTHER")
        foreign_user = User.objects.create_user(email="foreign-identity@example.test")
        foreign_invoice = Invoice.objects.get(id=other["id"])
        foreign_invoice.user = foreign_user
        foreign_invoice.save(update_fields=["user"])
        before = self.prices(body["id"])
        for invalid in (other["lines"][0]["id"], body["lines"][0]["id"], "malformed"):
            with self.subTest(invalid=invalid):
                response = self.post_internal("save-invoice", {
                    **body, "notes": "Must roll back",
                    "lines": [body["lines"][0], {**body["lines"][1], "id": invalid}],
                })
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(self.prices(body["id"]), before)
                self.assertEqual(Invoice.objects.get(id=body["id"]).notes, "")
