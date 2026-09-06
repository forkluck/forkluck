import json
from datetime import datetime
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from django.test import Client, SimpleTestCase, TransactionTestCase

from .domains.invoices.actions import (
    _pack_price_cents,
    ensure_expense_categories,
)
from .domains.shared.supplier_import import ensure_supplier, supplier_item_key
from .models import (
    AnthropicCredential,
    BenchCostSettings,
    DriveFile,
    DriveFileExtraction,
    ExpenseCategory,
    Ingredient,
    RecipeLineMatch,
    IngredientImport,
    IngredientInvoicePrice,
    IngredientPrice,
    Invoice,
    InvoiceExtraction,
    InvoiceLine,
    PaymentMethod,
    SupplierItem,
    SupplierItemIgnore,
    User,
)
from .testing import InternalApiTestCase
from .paths import WEB_ROOT

# Relative, like test_name_normalization's: a dotted "forkluck.…" literal would
# register this module in test_contract.PatchTargetInventoryTests.


class InvoiceTestCase(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="invoices@example.com",
            name="Invoice Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)
        ensure_expense_categories(self.user)
        self.categories = {
            row.name: row for row in ExpenseCategory.objects.filter(user=self.user)
        }

    def cost_line(self, **overrides) -> dict:
        line = {
            "sku": "CAR10",
            "description": "CARROTS BABY ORANGE",
            "quantity": 3,
            "unit": "CS",
            "packSize": "24 X 1 LB",
            "unitPriceCents": 2450,
            "lineAmountCents": 7350,
            "categoryId": str(self.categories["Ingredients"].id),
            "sourcePayload": {"raw": True},
            "costEntry": {
                "name": "Carrots baby orange",
                "packUnit": "lb",
                "packAmount": 24,
                "packPriceCents": 2450,
                "rawSize": "24 X 1 LB",
                "quantity": 3,
                "preferred": False,
                "ingredientId": None,
            },
        }
        cost_overrides = overrides.pop("costEntry", None)
        line.update(overrides)
        if cost_overrides is not None and line["costEntry"] is not None:
            line["costEntry"] = {**line["costEntry"], **cost_overrides}
        return line

    def expense_line(self, **overrides) -> dict:
        line = {
            "sku": "",
            "description": "FUEL SURCHARGE",
            "quantity": None,
            "unit": "",
            "packSize": "",
            "unitPriceCents": None,
            "lineAmountCents": 500,
            "categoryId": str(self.categories["Other"].id),
            "sourcePayload": {},
            "costEntry": None,
        }
        line.update(overrides)
        return line

    def invoice_payload(self, **overrides) -> dict:
        invoice = {
            "fileName": "2026-07-14_Harbor_IV101.pdf",
            "driveFileId": "drive-file-1",
            "driveWebViewLink": "https://drive.google.com/file/d/drive-file-1/view",
            "supplier": "harbor",
            "supplierName": "Harbor Supply",
            "documentType": "invoice",
            "invoiceNumber": "IV101-1",
            "invoiceDate": "2026-07-14",
            "totalCents": 7850,
            "extractionModel": "claude-opus-5",
            "lines": [self.cost_line(), self.expense_line()],
            "ignored": [],
        }
        invoice.update(overrides)
        return invoice

    def import_invoices(self, *invoices: dict, reviewed_currency: str = "USD"):
        response = self.post_internal(
            "import-invoices",
            {
                "invoices": list(invoices),
                "reviewedCurrencyCode": reviewed_currency,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()


class DocumentCurrencyTests(InvoiceTestCase):
    def test_document_currency_is_recorded_and_falls_back_to_workspace(self):
        eur = self.invoice_payload(
            currencyCode="EUR",
            invoiceNumber="IV-EUR-1",
            lines=[self.expense_line()],
            totalCents=500,
        )
        unmarked = self.invoice_payload(invoiceNumber="IV-USD-1")
        self.import_invoices(eur, unmarked)
        self.assertEqual(
            Invoice.objects.get(invoice_number="IV-EUR-1").currency_code, "EUR"
        )
        self.assertEqual(
            Invoice.objects.get(invoice_number="IV-USD-1").currency_code, "USD"
        )

    def test_foreign_currency_cost_lines_are_refused(self):
        eur = self.invoice_payload(currencyCode="EUR", invoiceNumber="IV-EUR-2")
        response = self.post_internal(
            "import-invoices",
            {"invoices": [eur], "reviewedCurrencyCode": "USD"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("priced in EUR", response.json()["error"])
        self.assertFalse(Invoice.objects.filter(invoice_number="IV-EUR-2").exists())


class ImportInvoicesTests(InvoiceTestCase):
    def test_import_creates_invoice_lines_and_price_pipeline(self) -> None:
        result = self.import_invoices(self.invoice_payload())

        self.assertEqual(result["invoices"], 1)
        self.assertEqual(result["lines"], 2)
        self.assertEqual(result["priceUpdated"], 1)
        self.assertEqual(result["created"], 1)
        self.assertEqual(result["expenseOnly"], 1)
        self.assertEqual(result["duplicates"], [])
        self.assertIsNotNone(result["batchId"])

        invoice = Invoice.objects.get(user=self.user)
        self.assertTrue(invoice.public_id.startswith("inv_"))
        self.assertEqual(invoice.supplier, "harbor")
        self.assertEqual(invoice.total_cents, 7850)
        self.assertEqual(invoice.line_count, 2)
        self.assertEqual(invoice.matched_line_count, 1)
        self.assertEqual(invoice.unresolved_line_count, 0)
        self.assertEqual(invoice.drive_file_id, "drive-file-1")
        self.assertIsNotNone(invoice.ingredient_import_id)

        cost_line = invoice.lines.get(position=0)
        self.assertEqual(cost_line.sku, "car10")
        self.assertTrue(cost_line.price_updated)
        self.assertIsNotNone(cost_line.supplier_item_id)
        self.assertIsNotNone(cost_line.ingredient_id)

        expense_row = invoice.lines.get(position=1)
        self.assertFalse(expense_row.price_updated)
        self.assertFalse(expense_row.needs_review)
        self.assertIsNone(expense_row.supplier_item_id)

        item = SupplierItem.objects.get(user=self.user)
        self.assertEqual(item.external_id, "car10")
        self.assertEqual(item.pack_price_cents, 2450)
        self.assertTrue(item.is_preferred)
        self.assertEqual(item.period_end.isoformat(), "2026-07-14")

        ingredient = Ingredient.objects.get(user=self.user)
        self.assertEqual(ingredient.purchase_cost_cents, 2450)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=ingredient).count(), 1
        )

        batch = IngredientImport.objects.get(user=self.user)
        self.assertEqual(batch.imported_count, 1)
        self.assertEqual(batch.created_count, 1)
        self.assertEqual(batch.file_name, "2026-07-14_Harbor_IV101.pdf")

    def test_new_invoice_pack_does_not_replace_an_existing_ingredient_price(
        self,
    ) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Egg",
            normalized_name="egg",
            purchase_cost_cents=4660,
            purchase_size=Decimal("180"),
            purchase_unit="each",
        )

        self.import_invoices(
            self.invoice_payload(
                supplier="wegmans",
                supplierName="Wegmans",
                lines=[
                    self.cost_line(
                        sku="WBO XLG EGG W OMGA",
                        description="WBO XLG EGG W OMGA",
                        quantity=1,
                        unit="EA",
                        packSize="20 EA",
                        unitPriceCents=598,
                        lineAmountCents=598,
                        costEntry={
                            "name": "Egg",
                            "packUnit": "each",
                            "packAmount": 20,
                            "packPriceCents": 598,
                            "rawSize": "20 EA",
                            "quantity": 1,
                            # Invoice input cannot choose a default, even if a
                            # stale or hand-written client asks it to.
                            "preferred": True,
                            "ingredientId": str(ingredient.id),
                        },
                    )
                ],
                totalCents=598,
            )
        )

        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 4660)
        self.assertEqual(ingredient.purchase_size, Decimal("180"))
        self.assertEqual(ingredient.purchase_unit, "each")
        self.assertFalse(SupplierItem.objects.get(user=self.user).is_preferred)
        self.assertFalse(IngredientPrice.objects.filter(ingredient=ingredient).exists())
        invoice_price = IngredientInvoicePrice.objects.get(ingredient=ingredient)
        self.assertEqual(_pack_price_cents(invoice_price.invoice_line), 598)
        self.assertEqual(invoice_price.purchase_size, 20)

    def test_new_invoice_pack_does_not_replace_the_preferred_supplier(self) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Egg",
            normalized_name="egg",
            purchase_cost_cents=4660,
            purchase_size=Decimal("180"),
            purchase_unit="each",
        )
        baldor = SupplierItem.objects.create(
            user=self.user,
            ingredient=ingredient,
            supplier="baldor",
            external_id="egg-180",
            title="Large eggs",
            pack_price_cents=4660,
            pack_amount=Decimal("180"),
            pack_unit="each",
            is_preferred=True,
        )

        self.import_invoices(
            self.invoice_payload(
                supplier="wegmans",
                supplierName="Wegmans",
                lines=[
                    self.cost_line(
                        sku="EGG20",
                        description="LARGE EGGS",
                        quantity=1,
                        unit="EA",
                        packSize="20 EA",
                        unitPriceCents=598,
                        lineAmountCents=598,
                        costEntry={
                            "name": "Egg",
                            "packUnit": "each",
                            "packAmount": 20,
                            "packPriceCents": 598,
                            "rawSize": "20 EA",
                            "quantity": 1,
                            "preferred": False,
                            "ingredientId": str(ingredient.id),
                        },
                    )
                ],
                totalCents=598,
            )
        )

        ingredient.refresh_from_db()
        baldor.refresh_from_db()
        wegmans = SupplierItem.objects.get(user=self.user, supplier="wegmans")
        self.assertTrue(baldor.is_preferred)
        self.assertFalse(wegmans.is_preferred)
        self.assertEqual(ingredient.purchase_cost_cents, 4660)
        self.assertFalse(IngredientPrice.objects.filter(ingredient=ingredient).exists())
        self.assertEqual(ingredient.invoice_prices.count(), 1)

    def test_an_import_reviewed_in_another_currency_is_refused(self) -> None:
        # The workspace was converted to EUR while this batch sat open. The
        # amounts on screen were USD, so importing them would stamp EUR rows
        # with figures nobody approved.
        settings_row, _ = BenchCostSettings.objects.get_or_create(user=self.user)
        settings_row.currency_code = "EUR"
        settings_row.save(update_fields=["currency_code"])

        response = self.post_internal(
            "import-invoices",
            {
                "invoices": [self.invoice_payload()],
                "reviewedCurrencyCode": "USD",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("currency changed", response.json()["error"].lower())
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)
        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 0)

    def test_an_import_reviewed_in_the_current_currency_is_accepted(self) -> None:
        settings_row, _ = BenchCostSettings.objects.get_or_create(user=self.user)
        settings_row.currency_code = "EUR"
        settings_row.save(update_fields=["currency_code"])

        result = self.import_invoices(self.invoice_payload(), reviewed_currency="EUR")

        self.assertEqual(result["invoices"], 1)
        self.assertEqual(Invoice.objects.get(user=self.user).currency_code, "EUR")

    def test_import_tracks_explicitly_unresolved_lines_separately(self) -> None:
        unresolved = self.expense_line(
            categoryId=None,
            needsReview=True,
        )

        result = self.import_invoices(self.invoice_payload(lines=[unresolved]))

        self.assertEqual(result["expenseOnly"], 0)
        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.line_count, 1)
        self.assertEqual(invoice.matched_line_count, 0)
        self.assertEqual(invoice.unresolved_line_count, 1)
        line = invoice.lines.get()
        self.assertTrue(line.needs_review)
        serialized = self.get_internal(
            f"/internal/v1/invoices/{invoice.id}/lines/"
        ).json()
        self.assertEqual(serialized["invoice"]["unresolvedLineCount"], 1)
        self.assertTrue(serialized["items"][0]["needsReview"])

    def test_invoice_updates_supplier_item_created_by_spreadsheet_import(self) -> None:
        spreadsheet = self.post_internal(
            "import-ingredients",
            {
                "fileName": "harbor.xlsx",
                "entries": [
                    {
                        "name": "Carrots baby orange",
                        "packUnit": "lb",
                        "packAmount": 24,
                        "packPriceCents": 2300,
                        "supplier": "harbor",
                        "externalId": "CAR10",
                        "rawSize": "24 X 1 LB",
                        "quantity": 2,
                        "preferred": False,
                    }
                ],
            },
        )
        self.assertEqual(spreadsheet.status_code, 200, spreadsheet.content)

        # Invoice input does not choose a default. The server recognizes that
        # this exact supplier item is already preferred and lets its new price
        # continue driving the ingredient.
        payload = self.invoice_payload()
        payload["lines"][0]["costEntry"]["preferred"] = False
        result = self.import_invoices(payload)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["created"], 0)

        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 1)
        item = SupplierItem.objects.get(user=self.user)
        self.assertEqual(item.pack_price_cents, 2450)
        ingredient = Ingredient.objects.get(user=self.user)
        # The invoice is dated 2026-07-14; the spreadsheet price was written
        # just now. Latest-effective wins, so the invoice's price is recorded
        # in history but does not restate the newer costing price.
        self.assertEqual(ingredient.purchase_cost_cents, 2300)
        # Price history: one row from the spreadsheet import, one from the
        # invoice price change.
        history = IngredientPrice.objects.filter(ingredient=ingredient)
        self.assertEqual(history.count(), 2)
        self.assertEqual(history.first().purchase_cost_cents, 2300)

    def test_duplicate_invoice_is_skipped_and_reported(self) -> None:
        self.import_invoices(self.invoice_payload())
        result = self.import_invoices(self.invoice_payload(fileName="again.pdf"))
        self.assertEqual(result["invoices"], 0)
        self.assertEqual(result["duplicates"], ["again.pdf"])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 1)

    def test_numberless_receipts_dedupe_on_date_and_total(self) -> None:
        receipt = self.invoice_payload(
            documentType="receipt",
            invoiceNumber=None,
            lines=[self.expense_line()],
            totalCents=500,
        )
        self.import_invoices(receipt)
        duplicate = self.import_invoices({**receipt, "fileName": "copy.pdf"})
        self.assertEqual(duplicate["duplicates"], ["copy.pdf"])
        different_total = self.import_invoices(
            {**receipt, "fileName": "other.pdf", "totalCents": 700}
        )
        self.assertEqual(different_total["invoices"], 1)
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 2)

    def test_receipts_with_a_reused_operator_number_are_distinct(self) -> None:
        first = self.invoice_payload(
            documentType="receipt",
            invoiceNumber="466303",
            invoiceDate="2026-07-02",
            totalCents=556,
            lines=[self.expense_line(lineAmountCents=556)],
        )
        second = self.invoice_payload(
            fileName="second-run.pdf",
            documentType="receipt",
            invoiceNumber="466303",
            invoiceDate="2026-07-13",
            totalCents=1386,
            lines=[self.expense_line(lineAmountCents=1386)],
        )

        result = self.import_invoices(first, second)

        self.assertEqual(result["invoices"], 2)
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 2)

    def test_price_history_is_effective_on_the_invoice_date(self) -> None:
        """A March invoice imported in August is a March price change; the
        30-day price-move column and the dashboard both read effective_at."""
        self.import_invoices(self.invoice_payload(invoiceDate="2026-03-09"))
        price = IngredientPrice.objects.get(ingredient__user=self.user)
        self.assertEqual(price.effective_at.date().isoformat(), "2026-03-09")
        self.assertEqual(price.source, IngredientPrice.Source.SUPPLIER)

    def test_a_corrected_total_is_still_the_same_invoice(self) -> None:
        """The total is user-editable, so it cannot be part of the invoice's
        identity: correcting a misread figure must not import it twice."""
        result = self.import_invoices(
            self.invoice_payload(),
            self.invoice_payload(fileName="corrected.pdf", totalCents=7900),
        )
        self.assertEqual(result["invoices"], 1)
        self.assertEqual(result["duplicates"], ["corrected.pdf"])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 1)

    def test_an_older_invoice_in_the_batch_does_not_win_the_price(self) -> None:
        march = self.invoice_payload(
            fileName="march.pdf",
            invoiceNumber="M1",
            invoiceDate="2026-03-05",
            lines=[
                self.cost_line(costEntry={"packPriceCents": 300, "preferred": True})
            ],
        )
        january = self.invoice_payload(
            fileName="january.pdf",
            invoiceNumber="J1",
            invoiceDate="2026-01-05",
            lines=[
                self.cost_line(costEntry={"packPriceCents": 100, "preferred": True})
            ],
        )
        # Newest file first, the way a Drive multi-select hands them over.
        self.import_invoices(march, january)

        ingredient = Ingredient.objects.get(user=self.user)
        self.assertEqual(ingredient.purchase_cost_cents, 300)
        history = IngredientPrice.objects.filter(ingredient=ingredient)
        self.assertEqual([row.purchase_cost_cents for row in history], [300, 100])

    def test_duplicate_within_one_batch_is_skipped(self) -> None:
        result = self.import_invoices(
            self.invoice_payload(),
            self.invoice_payload(fileName="second-copy.pdf"),
        )
        self.assertEqual(result["invoices"], 1)
        self.assertEqual(result["duplicates"], ["second-copy.pdf"])

    def test_credit_memo_lines_never_touch_prices(self) -> None:
        credit = self.invoice_payload(
            documentType="credit_memo",
            invoiceNumber="CR200",
            totalCents=-7350,
            lines=[
                self.expense_line(
                    description="CARROTS RETURN",
                    lineAmountCents=-7350,
                    categoryId=str(self.categories["Ingredients"].id),
                )
            ],
        )
        result = self.import_invoices(credit)
        self.assertEqual(result["priceUpdated"], 0)
        self.assertIsNone(result["batchId"])
        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 0)
        self.assertEqual(Ingredient.objects.filter(user=self.user).count(), 0)
        invoice = Invoice.objects.get(user=self.user)
        self.assertIsNone(invoice.ingredient_import_id)
        self.assertEqual(invoice.total_cents, -7350)

    def test_credit_memo_with_cost_entry_is_rejected(self) -> None:
        credit = self.invoice_payload(
            documentType="credit_memo",
            invoiceNumber="CR201",
            totalCents=-7350,
        )
        response = self.post_internal(
            "import-invoices",
            {"invoices": [credit], "reviewedCurrencyCode": "USD"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("cannot update prices", response.json()["error"])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)

    def test_invoice_requires_a_date(self) -> None:
        response = self.post_internal(
            "import-invoices",
            {
                "invoices": [self.invoice_payload(invoiceDate=None)],
                "reviewedCurrencyCode": "USD",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("needs a date", response.json()["error"])

    def test_ignored_lines_land_on_the_skip_list(self) -> None:
        payload = self.invoice_payload(
            lines=[self.expense_line()],
            ignored=[
                {
                    "supplier": "harbor",
                    "externalId": "ICE99",
                    "name": "DRY ICE",
                    "rawSize": "1 EA",
                }
            ],
        )
        result = self.import_invoices(payload)
        self.assertEqual(result["ignored"], 1)
        self.assertTrue(
            SupplierItemIgnore.objects.filter(
                user=self.user, supplier="harbor", external_id="ice99"
            ).exists()
        )


class OneTimeCostLineTests(InvoiceTestCase):
    """`remember: false` — the merchant unticked "Remember for this supplier"."""

    def test_remembered_line_writes_both_the_price_and_the_pack(self) -> None:
        result = self.import_invoices(
            self.invoice_payload(lines=[self.cost_line(costEntry={"remember": True})])
        )

        self.assertEqual(result["priceUpdated"], 1)
        self.assertEqual(result["created"], 1)
        item = SupplierItem.objects.get(user=self.user)
        ingredient = Ingredient.objects.get(user=self.user)
        self.assertEqual(item.ingredient_id, ingredient.id)
        self.assertEqual(ingredient.purchase_cost_cents, 2450)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=ingredient).count(), 1
        )

    def test_one_time_line_prices_the_ingredient_and_remembers_no_pack(self) -> None:
        result = self.import_invoices(
            self.invoice_payload(lines=[self.cost_line(costEntry={"remember": False})])
        )

        # The price landed, but nothing was added to the supplier's memory, so
        # neither the created nor the updated counter moved.
        self.assertEqual(result["priceUpdated"], 1)
        self.assertEqual(result["created"], 0)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 0)

        ingredient = Ingredient.objects.get(user=self.user)
        self.assertEqual(ingredient.purchase_cost_cents, 2450)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=ingredient).count(), 1
        )
        line = Invoice.objects.get(user=self.user).lines.get(position=0)
        self.assertTrue(line.price_updated)
        self.assertIsNone(line.supplier_item_id)
        self.assertEqual(line.ingredient_id, ingredient.id)
        invoice_price = IngredientInvoicePrice.objects.get(
            ingredient=ingredient, invoice_line=line
        )
        self.assertEqual(invoice_price.purchase_size, 24)
        self.assertEqual(invoice_price.purchase_unit, "lb")

    def test_one_time_line_leaves_a_preferred_pack_pricing_the_ingredient(self) -> None:
        self.import_invoices(self.invoice_payload())
        ingredient = Ingredient.objects.get(user=self.user)
        self.assertEqual(ingredient.purchase_cost_cents, 2450)

        # A different item code, so the one-time line finds the ingredient by
        # name rather than through the pack that already prices it.
        self.import_invoices(
            self.invoice_payload(
                fileName="august.pdf",
                invoiceNumber="IV202",
                invoiceDate="2026-08-14",
                lines=[
                    self.cost_line(
                        sku="CAR11",
                        costEntry={"remember": False, "packPriceCents": 9900},
                    )
                ],
            )
        )

        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 2450)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=ingredient).count(), 1
        )
        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 1)

    def test_one_time_line_does_not_replace_an_existing_ingredient_price(self) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Carrots baby orange",
            normalized_name="carrots baby orange",
            purchase_cost_cents=555,
            purchase_size=Decimal("24"),
            purchase_unit="lb",
        )
        result = self.import_invoices(
            self.invoice_payload(lines=[self.cost_line(costEntry={"remember": False})])
        )
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 555)
        self.assertFalse(IngredientPrice.objects.filter(ingredient=ingredient).exists())

        undo = self.post_internal("undo-ingredient-import", {"id": result["batchId"]})
        self.assertEqual(undo.status_code, 200, undo.content)

        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 555)
        self.assertFalse(IngredientPrice.objects.filter(ingredient=ingredient).exists())
        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 0)


class SaveInvoiceTests(InvoiceTestCase):
    """The hand-entry path: one document typed in, then corrected."""

    def manual_payload(self, **overrides) -> dict:
        body = {
            "supplierName": "Corner Market",
            "invoiceNumber": "CM-1",
            "invoiceDate": "2026-07-14",
            "totalCents": 7850,
            "taxCents": 350,
            "paymentMethod": "card",
            "lines": [self.cost_line(), self.expense_line()],
        }
        body.update(overrides)
        return body

    def save(self, **overrides):
        response = self.post_internal("save-invoice", self.manual_payload(**overrides))
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["item"]

    def test_create_records_the_document_and_prices_its_costed_line(self) -> None:
        item = self.save()

        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.source, "manual")
        self.assertEqual(invoice.file_name, "")
        self.assertEqual(invoice.document_type, "invoice")
        self.assertEqual(invoice.supplier, "corner market")
        self.assertEqual(invoice.tax_cents, 350)
        self.assertEqual(invoice.payment_method, "card")
        self.assertEqual(invoice.line_count, 2)
        self.assertEqual(invoice.matched_line_count, 1)

        self.assertEqual(item["publicId"], invoice.public_id)
        self.assertEqual(item["source"], "manual")
        self.assertEqual(len(item["lines"]), 2)

        item_row = SupplierItem.objects.get(user=self.user)
        self.assertEqual(item_row.supplier, "corner market")
        self.assertEqual(item_row.pack_price_cents, 2450)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=item_row.ingredient).count(), 1
        )

    def test_edit_replaces_the_lines_and_writes_the_newer_price(self) -> None:
        created = self.save()
        corrected = self.cost_line(
            lineAmountCents=9000,
            costEntry={"packPriceCents": 3000, "preferred": True},
        )
        item = self.save(id=created["id"], lines=[corrected], totalCents=9000)

        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 1)
        self.assertEqual(len(item["lines"]), 1)
        self.assertEqual(item["lines"][0]["lineAmountCents"], 9000)
        self.assertEqual(InvoiceLine.objects.filter(user=self.user).count(), 1)

        supplier_item = SupplierItem.objects.get(user=self.user)
        self.assertEqual(supplier_item.pack_price_cents, 3000)
        self.assertEqual(supplier_item.ingredient.purchase_cost_cents, 3000)
        # Prices are history: the first save's row stays, the edit adds one.
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=supplier_item.ingredient).count(),
            2,
        )
        self.assertEqual(IngredientImport.objects.filter(user=self.user).count(), 2)

    def test_editing_an_imported_invoice_keeps_what_only_the_import_knows(
        self,
    ) -> None:
        self.import_invoices(
            self.invoice_payload(currencyCode="EUR", lines=[self.expense_line()]),
            reviewed_currency="USD",
        )
        invoice = Invoice.objects.get(user=self.user)

        item = self.save(
            id=str(invoice.id),
            supplierName="Harbor Supply",
            invoiceNumber="IV101-1",
            invoiceDate="2026-07-14",
            totalCents=8000,
            lines=[self.expense_line(lineAmountCents=8000)],
        )

        invoice.refresh_from_db()
        self.assertEqual(invoice.total_cents, 8000)
        # The Drive link, the file it came from and the currency it was billed
        # in are the import's, not the editor's.
        self.assertEqual(invoice.source, "")
        self.assertEqual(invoice.file_name, "2026-07-14_Harbor_IV101.pdf")
        self.assertEqual(invoice.drive_file_id, "drive-file-1")
        self.assertEqual(
            invoice.drive_web_view_link,
            "https://drive.google.com/file/d/drive-file-1/view",
        )
        self.assertEqual(invoice.extraction_model, "claude-opus-5")
        self.assertEqual(invoice.currency_code, "EUR")
        self.assertEqual(invoice.document_type, "invoice")
        self.assertEqual(item["currencyCode"], "EUR")

    def test_editing_an_imported_invoice_keeps_its_price_matches(self) -> None:
        self.import_invoices(self.invoice_payload())
        invoice = Invoice.objects.get(user=self.user)
        matched = invoice.lines.get(item_key="car10")
        self.assertIsNotNone(matched.ingredient_id)
        yolk = Ingredient.objects.create(
            user=self.user,
            name="Egg yolk",
            normalized_name="egg yolk",
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="each",
        )
        IngredientInvoicePrice.objects.create(
            user=self.user,
            ingredient=yolk,
            invoice_line=matched,
            purchase_size=24,
            purchase_unit="lb",
        )

        # The same lines back with a corrected total and no cost entries: the
        # editor is fixing the header, not re-pricing the pantry.
        uncosted = self.cost_line()
        uncosted["costEntry"] = None
        self.save(
            id=str(invoice.id),
            supplierName="Harbor Supply",
            invoiceNumber="IV101-1",
            invoiceDate="2026-07-14",
            totalCents=7900,
            lines=[uncosted, self.expense_line()],
        )

        invoice.refresh_from_db()
        replacement = invoice.lines.get(item_key="car10")
        self.assertEqual(replacement.ingredient_id, matched.ingredient_id)
        self.assertEqual(replacement.supplier_item_id, matched.supplier_item_id)
        self.assertTrue(replacement.price_updated)
        self.assertEqual(invoice.matched_line_count, 1)
        self.assertEqual(
            set(replacement.ingredient_prices.values_list("ingredient_id", flat=True)),
            {matched.ingredient_id, yolk.id},
        )
        self.assertIsNone(
            replacement.ingredient_prices.get(ingredient=yolk).ingredient_import_id
        )

    def test_a_credit_memo_may_be_saved_with_a_negative_total(self) -> None:
        self.import_invoices(
            self.invoice_payload(
                documentType="credit_memo",
                totalCents=-500,
                lines=[self.expense_line(lineAmountCents=-500)],
            )
        )
        invoice = Invoice.objects.get(user=self.user)

        self.save(
            id=str(invoice.id),
            supplierName="Harbor Supply",
            invoiceNumber="IV101-1",
            invoiceDate="2026-07-14",
            totalCents=-750,
            lines=[self.expense_line(lineAmountCents=-750)],
        )

        invoice.refresh_from_db()
        self.assertEqual(invoice.total_cents, -750)
        self.assertEqual(invoice.document_type, "credit_memo")

    def test_the_document_fields_round_trip(self) -> None:
        item = self.save(
            dueDate="2026-08-14", subtotalCents=7500, notes="Left at the back door"
        )
        self.assertEqual(item["dueDate"], "2026-08-14")
        self.assertEqual(item["subtotalCents"], 7500)
        self.assertEqual(item["notes"], "Left at the back door")

        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.due_date.isoformat(), "2026-08-14")
        self.assertEqual(invoice.subtotal_cents, 7500)

    def test_a_document_prints_no_due_date_or_subtotal(self) -> None:
        item = self.save()
        self.assertIsNone(item["dueDate"])
        self.assertIsNone(item["subtotalCents"])
        self.assertEqual(item["notes"], "")

    def test_a_negative_total_is_refused(self) -> None:
        response = self.post_internal(
            "save-invoice", self.manual_payload(totalCents=-500)
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("positive total", response.json()["error"])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)

    def test_an_unknown_payment_method_is_refused(self) -> None:
        response = self.post_internal(
            "save-invoice", self.manual_payload(paymentMethod="crypto")
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Unsupported payment method")

    def test_a_workspace_method_is_accepted_and_stored_as_named(self) -> None:
        PaymentMethod.objects.create(
            user=self.user, name="Store credit", normalized_name="store credit"
        )

        self.save(paymentMethod="STORE CREDIT")

        self.assertEqual(
            Invoice.objects.get(user=self.user).payment_method, "Store credit"
        )

    def test_another_workspaces_method_is_still_unknown(self) -> None:
        other = User.objects.create_user(
            email="other-payments@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        PaymentMethod.objects.create(
            user=other, name="Store credit", normalized_name="store credit"
        )

        response = self.post_internal(
            "save-invoice", self.manual_payload(paymentMethod="Store credit")
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Unsupported payment method")

    def test_detail_reads_the_saved_document(self) -> None:
        item = self.save()
        response = self.get_internal(f"invoices/{item['publicId']}/")
        self.assertEqual(response.status_code, 200)
        payload = response.json()["item"]
        self.assertEqual(payload["taxCents"], 350)
        self.assertEqual(payload["paymentMethod"], "card")
        self.assertEqual(payload["currencyCode"], "USD")
        self.assertEqual([line["position"] for line in payload["lines"]], [0, 1])
        self.assertEqual(payload["lines"][0]["ingredientName"], "Carrots baby orange")

    def test_detail_names_the_drive_file_and_the_part_it_came_from(self) -> None:
        item = self.save()
        invoice = Invoice.objects.get(public_id=item["publicId"])
        invoice.drive_file_id = "drive-file-1"
        invoice.drive_file_part = 1
        invoice.save(update_fields=["drive_file_id", "drive_file_part"])
        drive_file = DriveFile.objects.create(
            user=self.user,
            drive_file_id="drive-file-1",
            name="bundle.pdf",
            status=DriveFile.Status.IMPORTED,
            seen_at=timezone.now(),
        )
        DriveFileExtraction.objects.create(
            drive_file=drive_file,
            part=1,
            page_start=2,
            page_end=3,
            status=DriveFileExtraction.Status.IMPORTED,
            document={},
            extracted_at=timezone.now(),
        )
        payload = self.get_internal(f"invoices/{item['publicId']}/").json()["item"]
        self.assertEqual(payload["driveFileId"], "drive-file-1")
        self.assertEqual(
            payload["driveFilePart"],
            {"part": 1, "pageStart": 2, "pageEnd": 3, "region": None},
        )

    def test_detail_of_a_typed_in_invoice_names_no_file(self) -> None:
        item = self.save()
        payload = self.get_internal(f"invoices/{item['publicId']}/").json()["item"]
        self.assertIsNone(payload["driveFileId"])
        self.assertIsNone(payload["driveFilePart"])

    def test_another_workspace_never_reads_the_document(self) -> None:
        item = self.save()
        other = User.objects.create_user(
            email="other@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        client = Client()
        client.force_login(other)
        response = self.get_internal(f"invoices/{item['publicId']}/", client=client)
        self.assertEqual(response.status_code, 404)


class ReviewInvoiceLineTests(InvoiceTestCase):
    """Resolving a line on the invoice's own page, after the document landed."""

    def review_line(self, **overrides) -> dict:
        line = self.expense_line(
            sku="LEM22",
            description="LEMONS 165CT",
            quantity=3,
            unit="CS",
            packSize="24 X 1 LB",
            unitPriceCents=2450,
            lineAmountCents=7350,
            categoryId=None,
            needsReview=True,
        )
        line.update(overrides)
        return line

    def imported(self, **overrides) -> Invoice:
        payload = self.invoice_payload(
            **{"lines": [self.review_line()], "totalCents": 7350, **overrides}
        )
        self.import_invoices(payload)
        return Invoice.objects.get(user=self.user)

    def review(self, line: InvoiceLine, **body):
        return self.post_internal(
            "review-invoice-line", {"lineId": str(line.id), **body}
        )

    def test_a_category_alone_resolves_the_review(self) -> None:
        invoice = self.imported()
        self.assertEqual(invoice.unresolved_line_count, 1)
        line = invoice.lines.get()

        response = self.review(line, categoryId=str(self.categories["Packaging"].id))
        self.assertEqual(response.status_code, 200, response.content)

        item = response.json()["item"]
        self.assertEqual(item["lines"][0]["categoryName"], "Packaging")
        self.assertFalse(item["lines"][0]["needsReview"])
        self.assertFalse(item["lines"][0]["priceUpdated"])
        line.refresh_from_db()
        self.assertFalse(line.needs_review)
        self.assertIsNone(line.ingredient_id)

    def test_a_cost_entry_prices_and_links_the_line(self) -> None:
        invoice = self.imported()
        line = invoice.lines.get()

        response = self.review(
            line,
            categoryId=str(self.categories["Ingredients"].id),
            costEntry={
                "name": "Lemons 165ct",
                "packUnit": "lb",
                "packAmount": 24,
                "packPriceCents": 2450,
                "rawSize": "24 X 1 LB",
                "quantity": 3,
                "preferred": False,
                "ingredientId": None,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        item = response.json()["item"]
        self.assertTrue(item["lines"][0]["priceUpdated"])
        self.assertEqual(item["lines"][0]["ingredientName"], "Lemons 165ct")
        self.assertFalse(item["lines"][0]["needsReview"])

        supplier_item = SupplierItem.objects.get(user=self.user)
        self.assertEqual(supplier_item.external_id, "lem22")
        self.assertEqual(supplier_item.pack_price_cents, 2450)

        # The batch is the invoice's own, so the ingredients Import history
        # undoes this price like any other.
        batch = IngredientImport.objects.get(user=self.user)
        invoice.refresh_from_db()
        self.assertEqual(invoice.ingredient_import_id, batch.id)
        self.assertEqual(batch.imported_count, 1)
        self.assertEqual(batch.created_count, 1)

        price = IngredientPrice.objects.get(ingredient=supplier_item.ingredient)
        self.assertEqual(price.effective_at.date(), invoice.invoice_date)

    def test_review_links_an_alternate_pack_without_repricing_the_ingredient(
        self,
    ) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Lemon",
            normalized_name="lemon",
            purchase_cost_cents=4200,
            purchase_size=Decimal("165"),
            purchase_unit="each",
        )
        invoice = self.imported(supplier="corner market", supplierName="Corner Market")
        line = invoice.lines.get()

        response = self.review(
            line,
            categoryId=str(self.categories["Ingredients"].id),
            costEntry={
                "name": "Lemon",
                "packUnit": "each",
                "packAmount": 4,
                "packPriceCents": 399,
                "rawSize": "4 EA",
                "quantity": 1,
                "preferred": True,
                "ingredientId": str(ingredient.id),
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        line.refresh_from_db()
        ingredient.refresh_from_db()
        self.assertEqual(line.ingredient_id, ingredient.id)
        self.assertFalse(line.supplier_item.is_preferred)
        self.assertEqual(ingredient.purchase_cost_cents, 4200)
        self.assertFalse(IngredientPrice.objects.filter(ingredient=ingredient).exists())

    def test_the_invoice_counters_follow_each_resolved_line(self) -> None:
        invoice = self.imported(
            lines=[
                self.review_line(),
                self.review_line(sku="ORA31", description="ORANGES 88CT"),
            ],
            totalCents=14700,
        )
        self.assertEqual(invoice.unresolved_line_count, 2)
        first, second = invoice.lines.order_by("position")

        first_item = self.review(
            first, categoryId=str(self.categories["Packaging"].id)
        ).json()["item"]
        self.assertEqual(first_item["unresolvedLineCount"], 1)
        self.assertEqual(first_item["matchedLineCount"], 0)

        second_item = self.review(
            second,
            categoryId=str(self.categories["Ingredients"].id),
            costEntry={
                "name": "Oranges 88ct",
                "packUnit": "lb",
                "packAmount": 40,
                "packPriceCents": 2450,
                "rawSize": "40 LB",
                "quantity": 3,
                "preferred": False,
                "ingredientId": None,
            },
        ).json()["item"]
        self.assertEqual(second_item["unresolvedLineCount"], 0)
        self.assertEqual(second_item["matchedLineCount"], 1)

    def test_a_credit_memo_line_refuses_a_cost_entry(self) -> None:
        invoice = self.imported(
            documentType="credit_memo", invoiceNumber="CR101-1", totalCents=-7350
        )
        response = self.review(
            invoice.lines.get(),
            categoryId=str(self.categories["Ingredients"].id),
            costEntry={
                "name": "Lemons 165ct",
                "packUnit": "lb",
                "packAmount": 24,
                "packPriceCents": 2450,
                "rawSize": "24 X 1 LB",
                "quantity": 3,
                "preferred": False,
                "ingredientId": None,
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"], "Credit memos and refunds cannot update prices"
        )
        self.assertFalse(SupplierItem.objects.filter(user=self.user).exists())
        invoice.refresh_from_db()
        self.assertEqual(invoice.unresolved_line_count, 1)

    def test_another_workspace_never_reviews_the_line(self) -> None:
        invoice = self.imported()
        line = invoice.lines.get()
        other = User.objects.create_user(
            email="reviewer@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        client = Client()
        client.force_login(other)

        response = self.post_internal(
            "review-invoice-line",
            {"lineId": str(line.id), "categoryId": None},
            client=client,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invoice line not found")
        line.refresh_from_db()
        self.assertTrue(line.needs_review)


class UndoAndDeleteTests(InvoiceTestCase):
    def test_undo_reverts_prices_but_keeps_invoices(self) -> None:
        result = self.import_invoices(self.invoice_payload())
        self.assertEqual(
            IngredientInvoicePrice.objects.filter(user=self.user).count(), 1
        )
        undo = self.post_internal("undo-ingredient-import", {"id": result["batchId"]})
        self.assertEqual(undo.status_code, 200, undo.content)

        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 0)
        self.assertEqual(Ingredient.objects.filter(user=self.user).count(), 0)
        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.line_count, 2)
        line = invoice.lines.get(position=0)
        # The FK nulls out with the deleted ingredient, but the expense record
        # survives untouched.
        self.assertIsNone(line.ingredient_id)
        self.assertTrue(line.price_updated)
        self.assertFalse(IngredientInvoicePrice.objects.filter(user=self.user).exists())

    def test_a_manually_kept_invoice_price_survives_import_undo(self) -> None:
        result = self.import_invoices(self.invoice_payload())
        ingredient = Ingredient.objects.get(user=self.user)
        line = InvoiceLine.objects.get(user=self.user, position=0)
        linked = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(ingredient.id),
                "lineId": str(line.id),
                "purchaseSize": 24,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(linked.status_code, 200, linked.content)

        undo = self.post_internal("undo-ingredient-import", {"id": result["batchId"]})

        self.assertEqual(undo.status_code, 200, undo.content)
        self.assertTrue(Ingredient.objects.filter(id=ingredient.id).exists())
        price = IngredientInvoicePrice.objects.get(
            ingredient_id=ingredient.id, invoice_line=line
        )
        self.assertIsNone(price.ingredient_import_id)
        self.assertEqual(price.purchase_size, 24)

    def test_price_ladder_of_two_imports_and_two_undos(self) -> None:
        """100 → 200 → undo → 100 → undo → the merchant's own price. Each undo
        pops the newest import off the stack, so the materialized price walks
        back down the history it walked up."""
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Carrots baby orange",
            normalized_name="carrots baby orange",
            purchase_cost_cents=555,
            purchase_size=Decimal("24"),
            purchase_unit="lb",
        )
        IngredientPrice.objects.create(
            ingredient=ingredient,
            purchase_cost_cents=555,
            purchase_size=Decimal("24"),
            purchase_unit="lb",
            source=IngredientPrice.Source.USER,
            effective_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
        )
        SupplierItem.objects.create(
            user=self.user,
            ingredient=ingredient,
            supplier="harbor",
            external_id="car10",
            title="Carrots baby orange",
            raw_size="24 X 1 LB",
            pack_price_cents=555,
            pack_amount=Decimal("24"),
            pack_unit="lb",
            is_preferred=True,
        )

        first = self.import_invoices(
            self.invoice_payload(
                fileName="march.pdf",
                invoiceNumber="M1",
                invoiceDate="2026-03-01",
                lines=[
                    self.cost_line(costEntry={"packPriceCents": 100, "preferred": True})
                ],
            )
        )
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 100)

        second = self.import_invoices(
            self.invoice_payload(
                fileName="april.pdf",
                invoiceNumber="A1",
                invoiceDate="2026-04-01",
                lines=[
                    self.cost_line(costEntry={"packPriceCents": 200, "preferred": True})
                ],
            )
        )
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 200)

        undo = self.post_internal("undo-ingredient-import", {"id": second["batchId"]})
        self.assertEqual(undo.status_code, 200, undo.content)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 100)

        undo = self.post_internal("undo-ingredient-import", {"id": first["batchId"]})
        self.assertEqual(undo.status_code, 200, undo.content)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 555)
        self.assertEqual(
            IngredientPrice.objects.filter(ingredient=ingredient).count(), 1
        )
        item = SupplierItem.objects.get(user=self.user)
        self.assertTrue(item.is_preferred)
        self.assertEqual(item.pack_price_cents, 555)

    def test_delete_invoice_keeps_prices_and_frees_fingerprint(self) -> None:
        self.import_invoices(self.invoice_payload())
        invoice = Invoice.objects.get(user=self.user)
        self.assertTrue(IngredientInvoicePrice.objects.filter(user=self.user).exists())
        response = self.post_internal("delete-invoice", {"id": str(invoice.id)})
        self.assertEqual(response.status_code, 200)

        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)
        self.assertEqual(InvoiceLine.objects.filter(user=self.user).count(), 0)
        self.assertEqual(SupplierItem.objects.filter(user=self.user).count(), 1)
        self.assertEqual(IngredientPrice.objects.count(), 1)
        self.assertFalse(IngredientInvoicePrice.objects.filter(user=self.user).exists())

        again = self.import_invoices(self.invoice_payload())
        self.assertEqual(again["invoices"], 1)


class UploadedDocumentTests(InvoiceTestCase):
    """A file the merchant uploaded is kept on our side and named by its key."""

    def uploaded_payload(self, **overrides) -> dict:
        return self.invoice_payload(
            driveFileId="",
            driveWebViewLink="",
            documentKey=f"{self.user.id}/f47ac10b.pdf",
            **overrides,
        )

    def test_import_keeps_the_document_key_and_the_detail_names_it(self) -> None:
        self.import_invoices(self.uploaded_payload())

        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.document_key, f"{self.user.id}/f47ac10b.pdf")
        payload = self.get_internal(f"invoices/{invoice.public_id}/").json()["item"]
        self.assertEqual(payload["documentKey"], f"{self.user.id}/f47ac10b.pdf")
        self.assertIsNone(payload["driveFileId"])

    def test_an_import_with_no_key_stores_nothing_and_reads_back_null(self) -> None:
        self.import_invoices(self.invoice_payload())

        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.document_key, "")
        payload = self.get_internal(f"invoices/{invoice.public_id}/").json()["item"]
        self.assertIsNone(payload["documentKey"])

    def test_editing_an_imported_invoice_keeps_the_document_key(self) -> None:
        self.import_invoices(self.uploaded_payload())
        invoice = Invoice.objects.get(user=self.user)

        response = self.post_internal(
            "save-invoice",
            {
                "id": str(invoice.id),
                "supplierName": "Harbor Supply",
                "invoiceNumber": "IV101-1",
                "invoiceDate": "2026-07-14",
                "totalCents": 8000,
                "lines": [self.expense_line(lineAmountCents=8000)],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        invoice.refresh_from_db()
        self.assertEqual(invoice.document_key, f"{self.user.id}/f47ac10b.pdf")
        self.assertEqual(
            response.json()["item"]["documentKey"], f"{self.user.id}/f47ac10b.pdf"
        )

    def test_delete_names_the_stored_file_so_next_can_remove_it(self) -> None:
        self.import_invoices(self.uploaded_payload())
        invoice = Invoice.objects.get(user=self.user)

        response = self.post_internal("delete-invoice", {"id": str(invoice.id)})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json(),
            {"ok": True, "documentKey": f"{self.user.id}/f47ac10b.pdf"},
        )

    def test_delete_of_an_invoice_with_no_stored_file_names_none(self) -> None:
        self.import_invoices(self.invoice_payload())
        invoice = Invoice.objects.get(user=self.user)

        response = self.post_internal("delete-invoice", {"id": str(invoice.id)})
        self.assertEqual(response.json(), {"ok": True, "documentKey": None})


class MergedIngredientLineTests(InvoiceTestCase):
    """An ingredient that survives a merge keeps its imported invoice lines.

    Deleting an ingredient really removes it, so a line's FK nulls out. A merge
    only moves the identity to another row, so every relation — including the
    line's own ingredient — has to follow it. Otherwise a line keeps
    priceUpdated with no ingredient to name, and disagrees with its own
    supplier item, which the merge did move.
    """

    def make_ingredient(self, name: str) -> Ingredient:
        return Ingredient.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )

    def merge(self, source: Ingredient, target: Ingredient) -> None:
        response = self.post_internal(
            "merge-ingredients",
            {"sourceId": str(source.id), "targetId": str(target.id)},
        )
        self.assertEqual(response.status_code, 200, response.content)

    def test_merge_moves_invoice_lines_to_the_target(self) -> None:
        self.import_invoices(self.invoice_payload())
        source = Ingredient.objects.get(user=self.user)
        target = self.make_ingredient("Baby carrots")

        self.merge(source, target)

        line = InvoiceLine.objects.get(user=self.user, position=0)
        self.assertEqual(line.ingredient_id, target.id)
        self.assertTrue(line.price_updated)
        # The supplier item moved with the merge; the line's own FK must name
        # the same ingredient rather than contradicting it.
        self.assertEqual(line.supplier_item.ingredient_id, target.id)
        self.assertEqual(
            set(target.invoice_prices.values_list("invoice_line_id", flat=True)),
            {line.id},
        )

        invoice = Invoice.objects.get(user=self.user)
        payload = self.get_internal(f"/internal/v1/invoices/{invoice.id}/lines/").json()
        cost_line = payload["items"][0]
        self.assertEqual(cost_line["ingredientId"], str(target.id))
        self.assertEqual(cost_line["ingredientName"], "Baby carrots")

    def test_merge_keeps_target_lines_and_gathers_source_lines(self) -> None:
        self.import_invoices(self.invoice_payload())
        source = Ingredient.objects.get(user=self.user)
        self.import_invoices(
            self.invoice_payload(
                fileName="2026-07-15_Harbor_IV102.pdf",
                invoiceNumber="IV102-1",
                totalCents=7851,
                lines=[
                    self.cost_line(
                        sku="ONI10",
                        description="ONIONS SPANISH",
                        costEntry={"name": "Onions spanish"},
                    )
                ],
            )
        )
        target = Ingredient.objects.get(
            user=self.user, normalized_name="onions spanish"
        )

        self.merge(source, target)

        self.assertEqual(
            set(
                InvoiceLine.objects.filter(
                    user=self.user, ingredient=target
                ).values_list("sku", flat=True)
            ),
            {"car10", "oni10"},
        )

    def test_chained_merge_follows_the_surviving_ingredient(self) -> None:
        self.import_invoices(self.invoice_payload())
        first = Ingredient.objects.get(user=self.user)
        second = self.make_ingredient("Baby carrots")
        third = self.make_ingredient("Carrots")

        self.merge(first, second)
        self.merge(second, third)

        line = InvoiceLine.objects.get(user=self.user, position=0)
        self.assertEqual(line.ingredient_id, third.id)
        self.assertEqual(line.supplier_item.ingredient_id, third.id)

    def test_deleting_an_ingredient_still_clears_the_line(self) -> None:
        self.import_invoices(self.invoice_payload())
        source = Ingredient.objects.get(user=self.user)

        response = self.post_internal("delete-ingredient", {"id": str(source.id)})
        self.assertEqual(response.status_code, 200, response.content)

        line = InvoiceLine.objects.get(user=self.user, position=0)
        self.assertIsNone(line.ingredient_id)

    def test_merge_leaves_another_tenants_lines_alone(self) -> None:
        self.import_invoices(self.invoice_payload())
        source = Ingredient.objects.get(user=self.user)
        target = self.make_ingredient("Baby carrots")

        other = User.objects.create_user(
            email="other-merge@example.com",
            name="Other Chef",
            password="a-long-test-passphrase-1357",
        )
        other_client = Client()
        other_client.force_login(other)
        ensure_expense_categories(other)
        other_ingredient = Ingredient.objects.create(
            user=other,
            name="Carrots baby orange",
            normalized_name="carrots baby orange",
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="kg",
        )
        other_invoice = Invoice.objects.create(
            user=other,
            supplier="harbor",
            supplier_name="Harbor Supply",
            document_type="invoice",
            invoice_number="IV900-1",
            total_cents=1000,
            source_fingerprint="other-merge-fingerprint",
        )
        other_line = InvoiceLine.objects.create(
            user=other,
            invoice=other_invoice,
            position=0,
            sku="car10",
            description="CARROTS BABY ORANGE",
            line_amount_cents=1000,
            ingredient=other_ingredient,
            price_updated=True,
        )

        self.merge(source, target)

        other_line.refresh_from_db()
        self.assertEqual(other_line.ingredient_id, other_ingredient.id)


class LinkSizelessIngredientTests(InvoiceTestCase):
    """A SupplierItem describes a concrete pack, so it needs a size and a unit.

    An ingredient can be named and priced before anyone says how it is bought —
    a case, a bushel, a bottle — and the pack columns are NOT NULL. Connecting
    an invoice item without one has to be refused in words, not by letting the
    database raise and reach the user as a generic conflict.
    """

    def test_refuses_before_writing_a_null_pack(self):
        invoice = Invoice.objects.create(
            user=self.user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            document_type="invoice",
            invoice_number="IV-SIZELESS",
            total_cents=5000,
            source_fingerprint="sizeless-fingerprint",
        )
        line = InvoiceLine.objects.create(
            user=self.user,
            invoice=invoice,
            position=0,
            sku="egg-cs",
            description="EGGS GRADE A",
            pack_size="1 CS",
            line_amount_cents=5000,
        )
        sizeless = Ingredient.objects.create(
            user=self.user,
            name="Eggs",
            normalized_name="eggs",
            purchase_cost_cents=5000,
        )

        response = self.post_internal(
            "link-invoice-line",
            {"ingredientId": str(sizeless.id), "lineId": str(line.id)},
        )

        self.assertIn("purchase size", response.json()["error"])
        self.assertFalse(SupplierItem.objects.filter(user=self.user).exists())
        line.refresh_from_db()
        self.assertIsNone(line.ingredient)


class ItemSyncScopeTests(InvoiceTestCase):
    """Invoice prices are many-to-many references, not supplier ownership."""

    def second_vendor_invoice(self) -> dict:
        """A second vendor selling the same ingredient, matched by name."""
        return self.invoice_payload(
            fileName="2026-07-20_Sysco_SY55.pdf",
            supplier="sysco",
            supplierName="Sysco",
            invoiceNumber="SY55-1",
            invoiceDate="2026-07-20",
            totalCents=8100,
            lines=[
                self.cost_line(
                    sku="SYS77",
                    description="CARROT BABY PEELED",
                    costEntry={"rawSize": "25 LB", "packAmount": 25},
                )
            ],
        )

    def two_vendor_ingredient(self) -> Ingredient:
        self.import_invoices(self.invoice_payload())
        self.import_invoices(self.second_vendor_invoice())
        ingredient = Ingredient.objects.get(user=self.user)
        self.assertEqual(
            sorted(
                SupplierItem.objects.filter(
                    user=self.user, ingredient=ingredient
                ).values_list("external_id", flat=True)
            ),
            ["car10", "sys77"],
        )
        return ingredient

    def other_vendor_line(self) -> InvoiceLine:
        return InvoiceLine.objects.get(user=self.user, sku="sys77")

    def test_disconnect_keeps_the_other_vendor_item_and_its_lines(self) -> None:
        ingredient = self.two_vendor_ingredient()
        other = self.other_vendor_line()
        dropped_line = InvoiceLine.objects.get(user=self.user, sku="car10")
        dropped_price = IngredientInvoicePrice.objects.get(
            ingredient=ingredient, invoice_line=dropped_line
        )

        before = ingredient.edit_version
        response = self.post_internal(
            "disconnect-invoice-line",
            {
                "ingredientId": str(ingredient.id),
                "invoicePriceId": str(dropped_price.id),
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"ok": True, "editVersion": before + 1})

        self.assertFalse(
            IngredientInvoicePrice.objects.filter(id=dropped_price.id).exists()
        )
        self.assertTrue(
            IngredientInvoicePrice.objects.filter(
                ingredient=ingredient, invoice_line=other
            ).exists()
        )
        other.refresh_from_db()
        self.assertEqual(other.ingredient_id, ingredient.id)
        self.assertIsNotNone(other.supplier_item_id)
        dropped_line.refresh_from_db()
        self.assertEqual(dropped_line.ingredient_id, ingredient.id)
        self.assertIsNotNone(dropped_line.supplier_item_id)

    def test_connecting_another_line_keeps_every_existing_pack(self) -> None:
        ingredient = self.two_vendor_ingredient()
        loose = InvoiceLine.objects.create(
            user=self.user,
            invoice=Invoice.objects.get(user=self.user, supplier="harbor"),
            position=5,
            sku="CAR20",
            description="CARROTS JUMBO",
            pack_size="50 LB",
            line_amount_cents=6000,
        )
        other = self.other_vendor_line()

        response = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(ingredient.id),
                "lineId": str(loose.id),
                "purchaseCostCents": 6000,
                "purchaseSize": 50,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"ok": True, "editVersion": 1})

        self.assertEqual(ingredient.invoice_prices.count(), 3)
        other.refresh_from_db()
        self.assertEqual(other.ingredient_id, ingredient.id)
        connected = IngredientInvoicePrice.objects.get(
            ingredient=ingredient, invoice_line=loose
        )
        self.assertEqual(_pack_price_cents(connected.invoice_line), 6000)
        self.assertEqual(connected.purchase_size, 50)
        self.assertEqual(connected.purchase_unit, "lb")
        self.assertFalse(
            SupplierItem.objects.filter(user=self.user, external_id="car20").exists()
        )
        previous = SupplierItem.objects.get(user=self.user, external_id="car10")
        self.assertTrue(previous.is_preferred)
        previous_line = InvoiceLine.objects.get(user=self.user, sku="car10")
        self.assertEqual(previous_line.supplier_item_id, previous.id)
        self.assertEqual(previous_line.ingredient_id, ingredient.id)

    def test_disconnect_can_remove_one_alternate_price(self) -> None:
        ingredient = self.two_vendor_ingredient()
        alternate_line = self.other_vendor_line()
        alternate = IngredientInvoicePrice.objects.get(
            ingredient=ingredient, invoice_line=alternate_line
        )
        preferred = SupplierItem.objects.get(user=self.user, external_id="car10")

        response = self.post_internal(
            "disconnect-invoice-line",
            {
                "ingredientId": str(ingredient.id),
                "invoicePriceId": str(alternate.id),
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        preferred.refresh_from_db()
        self.assertTrue(preferred.is_preferred)
        self.assertFalse(
            IngredientInvoicePrice.objects.filter(id=alternate.id).exists()
        )
        alternate_line.refresh_from_db()
        self.assertIsNotNone(alternate_line.supplier_item_id)
        self.assertEqual(alternate_line.ingredient_id, ingredient.id)

    def test_connecting_does_not_change_cost_or_yield(self) -> None:
        ingredient = self.two_vendor_ingredient()
        loose = InvoiceLine.objects.create(
            user=self.user,
            invoice=Invoice.objects.get(user=self.user, supplier="harbor"),
            position=6,
            sku="CAR30",
            description="CARROTS LOOSE",
            pack_size="50 LB",
            line_amount_cents=6000,
        )

        response = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(ingredient.id),
                "lineId": str(loose.id),
                "purchaseCostCents": 6000,
                "purchaseSize": 50,
                "purchaseUnit": "lb",
                "yieldPercent": 85,
            },
        )

        self.assertEqual(response.status_code, 200, response.content)
        ingredient.refresh_from_db()
        self.assertEqual(ingredient.purchase_cost_cents, 2450)
        self.assertEqual(ingredient.purchase_size, 24)
        self.assertEqual(ingredient.yield_percent, Decimal("100.000"))

    def test_a_line_can_price_two_ingredients(self) -> None:
        ingredient = self.two_vendor_ingredient()
        other = self.other_vendor_line()
        rival = Ingredient.objects.create(
            user=self.user,
            name="Rainbow carrots",
            normalized_name="rainbow carrots",
            purchase_cost_cents=1200,
            purchase_size=1,
            purchase_unit="kg",
        )

        response = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(rival.id),
                "lineId": str(other.id),
                "purchaseCostCents": 1200,
                "purchaseSize": 1,
                "purchaseUnit": "kg",
            },
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            SupplierItem.objects.get(user=self.user, external_id="sys77").ingredient_id,
            ingredient.id,
        )
        other.refresh_from_db()
        self.assertEqual(other.ingredient_id, ingredient.id)
        self.assertFalse(
            SupplierItem.objects.filter(user=self.user, ingredient=rival).exists()
        )
        self.assertEqual(
            set(other.ingredient_prices.values_list("ingredient_id", flat=True)),
            {ingredient.id, rival.id},
        )
        rival.refresh_from_db()
        self.assertEqual(rival.purchase_cost_cents, 1200)


class LinkAndPriceTogetherTests(InvoiceTestCase):
    """Connecting an invoice price never chooses the active ingredient cost."""

    def setUp(self) -> None:
        super().setUp()
        self.invoice = Invoice.objects.create(
            user=self.user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            document_type="invoice",
            invoice_number="IV-ATOMIC",
            invoice_date="2026-07-14",
            total_cents=7350,
            source_fingerprint="atomic-fingerprint",
        )
        self.line = InvoiceLine.objects.create(
            user=self.user,
            invoice=self.invoice,
            position=0,
            sku="CAR10",
            description="CARROTS BABY ORANGE",
            quantity=Decimal("3"),
            pack_size="25 LB",
            unit_price_cents=None,
            line_amount_cents=7350,
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Carrots",
            normalized_name="carrots",
            purchase_cost_cents=1200,
            purchase_size=1,
            purchase_unit="kg",
        )

    def link(self, **overrides) -> dict:
        body = {
            "ingredientId": str(self.ingredient.id),
            "lineId": str(self.line.id),
            "purchaseCostCents": 2450,
            "purchaseSize": 25,
            "purchaseUnit": "lb",
        }
        body.update(overrides)
        return self.post_internal("link-invoice-line", body).json()

    def test_a_count_pack_connects_and_caches_no_weight(self) -> None:
        payload = self.link(purchaseSize=48, purchaseUnit="each")

        self.assertTrue(payload["ok"])
        price = IngredientInvoicePrice.objects.get(ingredient=self.ingredient)
        self.assertEqual(price.purchase_unit, "each")
        self.assertEqual(price.purchase_size, 48)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.purchase_unit, "kg")

    def test_a_refused_measure_leaves_the_line_and_cost_alone(self) -> None:
        payload = self.link(purchaseSize=1000001)

        self.assertIn("Purchase size", payload["error"])
        self.assertFalse(IngredientInvoicePrice.objects.filter(user=self.user).exists())
        self.assertFalse(SupplierItem.objects.filter(user=self.user).exists())
        self.line.refresh_from_db()
        self.assertIsNone(self.line.ingredient_id)
        self.assertIsNone(self.line.supplier_item_id)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.purchase_cost_cents, 1200)
        self.assertEqual(self.ingredient.purchase_unit, "kg")

    def test_supplier_ownership_does_not_block_an_invoice_price(self) -> None:
        rival = Ingredient.objects.create(
            user=self.user,
            name="Rainbow carrots",
            normalized_name="rainbow carrots",
            purchase_cost_cents=900,
            purchase_size=1,
            purchase_unit="kg",
        )
        SupplierItem.objects.create(
            user=self.user,
            ingredient=rival,
            supplier="harbor",
            external_id="car10",
            title="CARROTS BABY ORANGE",
            raw_size="25 LB",
            pack_price_cents=2450,
            pack_grams=11340,
            pack_amount=25,
            pack_unit="lb",
        )

        payload = self.link()

        self.assertTrue(payload["ok"])
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.purchase_cost_cents, 1200)
        self.assertEqual(self.ingredient.purchase_unit, "kg")
        self.assertFalse(
            IngredientPrice.objects.filter(ingredient=self.ingredient).exists()
        )

    def test_connecting_only_adds_the_invoice_price(self) -> None:
        before = self.ingredient.edit_version
        payload = self.link()

        self.assertEqual(payload, {"ok": True, "editVersion": before + 1})
        price = IngredientInvoicePrice.objects.get(ingredient=self.ingredient)
        self.assertEqual(_pack_price_cents(price.invoice_line), 2450)
        self.assertEqual(price.purchase_size, 25)
        self.assertEqual(price.purchase_unit, "lb")
        self.line.refresh_from_db()
        self.assertIsNone(self.line.supplier_item_id)
        self.assertIsNone(self.line.ingredient_id)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.purchase_cost_cents, 1200)
        self.assertEqual(self.ingredient.purchase_size, 1)
        self.assertEqual(self.ingredient.purchase_unit, "kg")
        self.assertFalse(
            IngredientPrice.objects.filter(ingredient=self.ingredient).exists()
        )

    def test_using_a_connected_price_is_the_explicit_costing_step(self) -> None:
        self.link()
        price = IngredientInvoicePrice.objects.get(ingredient=self.ingredient)

        response = self.post_internal(
            "use-invoice-price",
            {
                "ingredientId": str(self.ingredient.id),
                "invoicePriceId": str(price.id),
            },
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.ingredient.refresh_from_db()
        self.assertEqual(self.ingredient.purchase_cost_cents, 2450)
        self.assertEqual(self.ingredient.purchase_size, 25)
        self.assertEqual(self.ingredient.purchase_unit, "lb")

    def test_invoice_price_actions_are_tenant_scoped(self) -> None:
        other = User.objects.create_user(
            email="other-price@example.com",
            name="Other kitchen",
            password="a-long-test-passphrase-9753",
        )
        other_ingredient = Ingredient.objects.create(
            user=other,
            name="Carrots",
            normalized_name="carrots",
            purchase_cost_cents=100,
            purchase_size=1,
            purchase_unit="kg",
        )

        response = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(other_ingredient.id),
                "lineId": str(self.line.id),
                "purchaseSize": 25,
                "purchaseUnit": "lb",
            },
        )

        self.assertEqual(response.json(), {"error": "Ingredient not found"})
        self.assertFalse(IngredientInvoicePrice.objects.filter(user=other).exists())


class PackPriceFromQuantityTests(InvoiceTestCase):
    """A line for three cases costs three cases, not one.

    Invoices that print no unit price still print a quantity, so the pack price
    is the line total divided by it — the rule apps/web/lib/invoice-import.ts already
    applies when it imports the same line.
    """

    def setUp(self) -> None:
        super().setUp()
        self.invoice = Invoice.objects.create(
            user=self.user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            document_type="invoice",
            invoice_number="IV-NOUNIT",
            invoice_date="2026-07-14",
            total_cents=7350,
            source_fingerprint="no-unit-price-fingerprint",
        )
        self.line = InvoiceLine.objects.create(
            user=self.user,
            invoice=self.invoice,
            position=0,
            sku="CAR10",
            description="CARROTS BABY ORANGE",
            quantity=Decimal("3"),
            pack_size="25 LB",
            unit_price_cents=None,
            line_amount_cents=7350,
        )
        self.ingredient = Ingredient.objects.create(
            user=self.user,
            name="Carrots",
            normalized_name="carrots",
            purchase_cost_cents=2450,
            purchase_size=25,
            purchase_unit="lb",
        )

    def test_an_exact_half_cent_rounds_the_way_the_picker_rounds(self) -> None:
        """7353 over two packs is 3676.5. The picker rounds it in JavaScript and
        shows 3677, so the link must not store bankers'-rounded 3676."""
        self.line.quantity = Decimal("2")
        self.line.line_amount_cents = 7353
        self.line.save(update_fields=["quantity", "line_amount_cents"])
        self.assertEqual(_pack_price_cents(self.line), 3677)

    def test_a_credit_lines_half_cent_rounds_the_way_the_picker_rounds(self) -> None:
        """A credit memo signs the line total negative. Math.round(-3676.5) is
        -3676 — it takes a half toward +infinity, not away from zero — and the
        picker offers credit lines, so the link must store the same -3676."""
        self.line.quantity = Decimal("2")
        self.line.line_amount_cents = -7353
        self.line.save(update_fields=["quantity", "line_amount_cents"])
        self.assertEqual(_pack_price_cents(self.line), -3676)

    def test_the_picker_offers_a_credit_line(self) -> None:
        """The negative line the rounding above is about is reachable: nothing
        filters it out of the options the picker lists."""
        self.line.quantity = Decimal("2")
        self.line.line_amount_cents = -7353
        self.line.save(update_fields=["quantity", "line_amount_cents"])

        payload = self.get_internal("invoice-line-options/").json()

        self.assertEqual(payload["items"][0]["lineAmountCents"], -7353)

    def test_linking_divides_the_line_total_by_the_quantity(self) -> None:
        response = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(self.ingredient.id),
                "lineId": str(self.line.id),
                "purchaseCostCents": 2450,
                "purchaseSize": 25,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(response.status_code, 200, response.content)

        price = IngredientInvoicePrice.objects.get(
            ingredient=self.ingredient, invoice_line=self.line
        )
        self.assertEqual(_pack_price_cents(price.invoice_line), 2450)

    def test_options_carry_the_quantity_the_picker_divides_by(self) -> None:
        payload = self.get_internal("invoice-line-options/").json()

        self.assertEqual(payload["items"][0]["quantity"], 3.0)
        self.assertIsNone(payload["items"][0]["unitPriceCents"])
        self.assertEqual(payload["items"][0]["lineAmountCents"], 7350)

    def test_options_name_every_ingredient_using_the_invoice_price(self) -> None:
        owner = Ingredient.objects.create(
            user=self.user,
            name="Rainbow carrots",
            normalized_name="rainbow carrots",
            purchase_cost_cents=1200,
            purchase_size=1,
            purchase_unit="kg",
        )
        IngredientInvoicePrice.objects.create(
            user=self.user,
            ingredient=owner,
            invoice_line=self.line,
            purchase_size=25,
            purchase_unit="lb",
        )

        payload = self.get_internal("invoice-line-options/").json()

        self.assertEqual(
            payload["items"][0]["linkedIngredients"],
            [{"name": "Rainbow carrots", "publicId": owner.public_id}],
        )


class ProbeTests(InvoiceTestCase):
    def probe(self, body: dict) -> dict:
        response = self.post_internal("invoice-line-status", body)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_probe_matches_supplier_items_ignores_and_history(self) -> None:
        self.import_invoices(self.invoice_payload())
        SupplierItemIgnore.objects.create(
            user=self.user, supplier="harbor", external_id="ice99", title="DRY ICE"
        )
        staff_meal = self.categories["Staff meal"]
        invoice = Invoice.objects.get(user=self.user)
        line = invoice.lines.get(position=0)
        line.category = staff_meal
        line.save(update_fields=["category", "updated_at"])

        result = self.probe(
            {
                "supplier": "harbor",
                "lines": [
                    {"sku": "CAR10", "name": "CARROTS BABY ORANGE"},
                    {"sku": "ICE99", "name": "DRY ICE"},
                    {"sku": "NEW01", "name": "Totally new item"},
                ],
                "invoice": {
                    "invoiceNumber": "IV101-1",
                    "invoiceDate": "2026-07-14",
                    "totalCents": 7850,
                },
            }
        )

        self.assertTrue(result["duplicate"])
        known, ignored, unknown = result["items"]
        self.assertIsNotNone(known["supplierItem"])
        self.assertEqual(known["supplierItem"]["packPriceCents"], 2450)
        self.assertEqual(known["lastCategoryId"], str(staff_meal.id))
        self.assertTrue(ignored["ignored"])
        self.assertIsNone(unknown["supplierItem"])
        self.assertIsNone(unknown["matchedIngredientId"])
        self.assertEqual(len(result["categories"]), 8)

    def test_probe_names_the_invoice_a_duplicate_would_repeat(self) -> None:
        self.import_invoices(self.invoice_payload())
        stored = Invoice.objects.get(user=self.user)

        result = self.probe(
            {
                "supplier": "harbor",
                "lines": [],
                "invoice": {
                    "invoiceNumber": "IV101-1",
                    "invoiceDate": "2026-07-14",
                    "totalCents": 7850,
                },
            }
        )

        self.assertTrue(result["duplicate"])
        self.assertEqual(
            result["existingInvoice"],
            {
                "id": str(stored.id),
                "publicId": stored.public_id,
                "invoiceNumber": "IV101-1",
                "invoiceDate": "2026-07-14",
                "totalCents": 7850,
                "lineCount": 2,
                "importedAt": result["existingInvoice"]["importedAt"],
            },
        )
        self.assertTrue(result["existingInvoice"]["importedAt"].startswith("20"))

    def test_probe_does_not_confuse_two_receipts_with_one_operator_number(self) -> None:
        self.import_invoices(
            self.invoice_payload(
                documentType="receipt",
                invoiceNumber="466303",
                invoiceDate="2026-07-02",
                totalCents=556,
                lines=[self.expense_line(lineAmountCents=556)],
            )
        )

        result = self.probe(
            {
                "supplier": "harbor",
                "lines": [],
                "invoice": {
                    "documentType": "receipt",
                    "invoiceNumber": "466303",
                    "invoiceDate": "2026-07-13",
                    "totalCents": 1386,
                },
            }
        )

        self.assertFalse(result["duplicate"])
        self.assertIsNone(result["existingInvoice"])

    def test_probe_returns_no_existing_invoice_when_nothing_matches(self) -> None:
        self.import_invoices(self.invoice_payload())

        unmatched = self.probe(
            {
                "supplier": "harbor",
                "lines": [],
                "invoice": {
                    "invoiceNumber": "IV999",
                    "invoiceDate": "2026-07-14",
                    "totalCents": 7850,
                },
            }
        )
        self.assertFalse(unmatched["duplicate"])
        self.assertIsNone(unmatched["existingInvoice"])
        # A probe asked no header cannot answer, and says so the same way.
        self.assertIsNone(
            self.probe({"supplier": "harbor", "lines": []})["existingInvoice"]
        )

    def test_probe_reports_a_drive_file_already_imported(self) -> None:
        self.import_invoices(self.invoice_payload())
        known = self.probe(
            {"supplier": "harbor", "lines": [], "driveFileId": "drive-file-1"}
        )
        self.assertTrue(known["driveFileKnown"])
        unknown = self.probe(
            {"supplier": "harbor", "lines": [], "driveFileId": "drive-file-2"}
        )
        self.assertFalse(unknown["driveFileKnown"])
        self.assertFalse(
            self.probe({"supplier": "harbor", "lines": []})["driveFileKnown"]
        )

    def test_probe_matches_unknown_skus_by_alias_and_name(self) -> None:
        ingredient = Ingredient.objects.create(
            user=self.user,
            name="Baby carrots",
            normalized_name="baby carrots",
            purchase_cost_cents=1000,
            purchase_size=1,
            purchase_unit="lb",
        )
        RecipeLineMatch.objects.create(
            user=self.user, text="Carrots Baby Orange", ingredient=ingredient
        )
        result = self.probe(
            {
                "supplier": "harbor",
                "lines": [
                    {"sku": "NEW01", "name": "CARROTS BABY ORANGE"},
                    {"sku": "NEW02", "name": "Baby carrots"},
                ],
            }
        )
        alias_match, name_match = result["items"]
        self.assertEqual(alias_match["matchedIngredientId"], str(ingredient.id))
        self.assertEqual(name_match["matchedIngredientId"], str(ingredient.id))

    def test_category_seeding_is_idempotent(self) -> None:
        ensure_expense_categories(self.user)
        ensure_expense_categories(self.user)
        self.assertEqual(ExpenseCategory.objects.filter(user=self.user).count(), 8)
        self.assertTrue(
            ExpenseCategory.objects.get(
                user=self.user, normalized_name="ingredients"
            ).is_ingredient
        )

    def test_supply_categories_are_costable(self) -> None:
        for name in ("packaging", "cleaning supplies"):
            row = ExpenseCategory.objects.get(user=self.user, normalized_name=name)
            self.assertTrue(row.is_supply, name)
            # is_ingredient is the costable flag; a supply line prices a supply.
            self.assertTrue(row.is_ingredient, name)
        staff = ExpenseCategory.objects.get(
            user=self.user, normalized_name="staff meal"
        )
        self.assertFalse(staff.is_supply)
        ingredients = ExpenseCategory.objects.get(
            user=self.user, normalized_name="ingredients"
        )
        self.assertFalse(ingredients.is_supply)


# The browser derives the same key before an invoice is sent here; both ends
# read this file so a drift in either rule fails a test.
ITEM_KEY_FIXTURE = (
    WEB_ROOT
    / "tests"
    / "fixtures"
    / "supplier-item-keys.json"
)


class SupplierItemKeyTests(SimpleTestCase):
    def test_agrees_with_the_browser_twin_on_the_shared_cases(self) -> None:
        cases = json.loads(ITEM_KEY_FIXTURE.read_text())["cases"]
        self.assertTrue(cases)
        for case in cases:
            self.assertEqual(
                supplier_item_key(case["sku"], case["description"]),
                case["key"],
                case["description"],
            )


class CodelessLineMemoryTests(InvoiceTestCase):
    """A receipt that prints no item codes still builds supplier memory."""

    def cream_line(
        self,
        *,
        price_cents: int = 299,
        cost: bool = True,
        preferred: bool = False,
        **overrides,
    ):
        line = self.cost_line(
            sku="",
            description="OG HVY WHP CRM UHT",
            quantity=1,
            unit="lb",
            packSize="",
            unitPriceCents=price_cents,
            lineAmountCents=price_cents,
            costEntry={
                "name": "Heavy whipping cream",
                "packUnit": "lb",
                "packAmount": 1,
                "packPriceCents": price_cents,
                "rawSize": "1 lb",
                "quantity": 1,
                "preferred": preferred,
            },
        )
        if not cost:
            line["costEntry"] = None
        line.update(overrides)
        return line

    def test_import_keys_the_item_on_the_description(self) -> None:
        self.import_invoices(
            self.invoice_payload(lines=[self.cream_line()], totalCents=299)
        )
        item = SupplierItem.objects.get(user=self.user)
        self.assertEqual(item.external_id, "desc:og hvy whp crm uht")
        self.assertEqual(item.pack_price_cents, 299)
        line = InvoiceLine.objects.get(user=self.user)
        self.assertEqual(line.item_key, "desc:og hvy whp crm uht")
        self.assertEqual(line.sku, "")

    def test_a_second_receipt_updates_that_price_without_a_second_item(self) -> None:
        self.import_invoices(
            self.invoice_payload(lines=[self.cream_line()], totalCents=299)
        )
        self.import_invoices(
            self.invoice_payload(
                invoiceNumber="IV101-2",
                invoiceDate="2026-07-21",
                driveFileId="drive-file-2",
                driveWebViewLink="https://drive.google.com/file/d/drive-file-2/view",
                # The dialog sends the stored pack's preferred flag back, the
                # way a known-SKU price update does.
                lines=[self.cream_line(price_cents=349, preferred=True)],
                totalCents=349,
            )
        )
        item = SupplierItem.objects.get(user=self.user)
        self.assertEqual(item.external_id, "desc:og hvy whp crm uht")
        self.assertEqual(item.pack_price_cents, 349)
        self.assertEqual(
            Ingredient.objects.get(user=self.user).purchase_cost_cents, 349
        )

    def test_the_probe_auto_applies_the_key_it_stored(self) -> None:
        self.import_invoices(
            self.invoice_payload(lines=[self.cream_line()], totalCents=299)
        )
        SupplierItemIgnore.objects.create(
            user=self.user,
            supplier="harbor",
            external_id="desc:bagged ice 10lb",
            title="BAGGED ICE 10LB",
        )
        response = self.post_internal(
            "invoice-line-status",
            {
                "supplier": "harbor",
                "lines": [
                    {"sku": "", "name": "OG HVY WHP CRM UHT"},
                    {"sku": "", "name": "BAGGED ICE 10LB"},
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        known, ignored = response.json()["items"]
        self.assertIsNotNone(known["supplierItem"])
        self.assertEqual(known["supplierItem"]["packPriceCents"], 299)
        self.assertEqual(
            known["lastCategoryId"], str(self.categories["Ingredients"].id)
        )
        self.assertTrue(ignored["ignored"])

    def test_ignoring_a_code_less_line_keys_the_skip_list_the_same_way(self) -> None:
        self.import_invoices(
            self.invoice_payload(
                lines=[self.expense_line()],
                totalCents=500,
                ignored=[
                    {
                        "supplier": "harbor",
                        "externalId": "",
                        "name": "BAGGED ICE 10LB",
                        "rawSize": "",
                    }
                ],
            )
        )
        self.assertTrue(
            SupplierItemIgnore.objects.filter(
                user=self.user,
                supplier="harbor",
                external_id="desc:bagged ice 10lb",
            ).exists()
        )

    def test_reviewing_and_linking_a_code_less_line_write_the_same_key(self) -> None:
        self.import_invoices(
            self.invoice_payload(
                lines=[self.cream_line(cost=False, categoryId=None, needsReview=True)],
                totalCents=299,
            )
        )
        line = InvoiceLine.objects.get(user=self.user)
        response = self.post_internal(
            "review-invoice-line",
            {
                "lineId": str(line.id),
                "categoryId": str(self.categories["Ingredients"].id),
                "costEntry": {
                    "name": "Heavy whipping cream",
                    "packUnit": "lb",
                    "packAmount": 1,
                    "packPriceCents": 299,
                    "rawSize": "1 lb",
                    "quantity": 1,
                    "preferred": False,
                    "ingredientId": None,
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        reviewed = SupplierItem.objects.get(user=self.user)
        self.assertEqual(reviewed.external_id, "desc:og hvy whp crm uht")

        other = Ingredient.objects.create(
            user=self.user,
            name="Cream, heavy",
            normalized_name="cream heavy",
            purchase_cost_cents=100,
            purchase_size=1,
            purchase_unit="lb",
        )
        # The same line can be a price reference for another ingredient without
        # moving or duplicating the supplier SKU used for invoice matching.
        response = self.post_internal(
            "link-invoice-line",
            {
                "ingredientId": str(other.id),
                "lineId": str(line.id),
                "purchaseCostCents": 349,
                "purchaseSize": 1,
                "purchaseUnit": "lb",
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            list(
                SupplierItem.objects.filter(user=self.user).values_list(
                    "external_id", flat=True
                )
            ),
            ["desc:og hvy whp crm uht"],
        )
        self.assertEqual(line.ingredient_prices.count(), 2)


class IngredientInvoicePriceBackfillTests(TransactionTestCase):
    migrate_from = ("forkluck", "0046_primo_conversations")
    migrate_to = ("forkluck", "0048_backfill_ingredient_invoice_prices")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        Ingredient = apps.get_model("forkluck", "Ingredient")
        SupplierItem = apps.get_model("forkluck", "SupplierItem")
        Invoice = apps.get_model("forkluck", "Invoice")
        InvoiceLine = apps.get_model("forkluck", "InvoiceLine")
        self.user = User.objects.create(
            email="invoice-price-backfill@example.com",
            name="Backfill",
            password="!",
            first_name="",
            last_name="",
        )
        ingredient = Ingredient.objects.create(
            user_id=self.user.pk,
            name="Egg",
            normalized_name="egg",
            purchase_cost_cents=4660,
            purchase_size=180,
            purchase_unit="each",
        )
        item = SupplierItem.objects.create(
            user_id=self.user.pk,
            ingredient_id=ingredient.pk,
            supplier="wegmans",
            external_id="egg20",
            title="Large eggs",
            raw_size="20 EA",
            pack_price_cents=598,
            pack_amount=20,
            pack_unit="each",
        )
        invoice = Invoice.objects.create(
            user_id=self.user.pk,
            supplier="wegmans",
            supplier_name="Wegmans",
            document_type="receipt",
            invoice_number="501054",
            invoice_date="2026-07-09",
            total_cents=598,
            source_fingerprint="invoice-price-backfill",
        )
        self.line = InvoiceLine.objects.create(
            user_id=self.user.pk,
            invoice_id=invoice.pk,
            position=0,
            sku="EGG20",
            item_key="egg20",
            description="LARGE EGGS",
            quantity=1,
            unit_price_cents=598,
            line_amount_cents=598,
            supplier_item_id=item.pk,
            ingredient_id=ingredient.pk,
        )
        credit = Invoice.objects.create(
            user_id=self.user.pk,
            supplier="wegmans",
            supplier_name="Wegmans",
            document_type="refund",
            invoice_number="RETURN-1",
            invoice_date="2026-07-10",
            total_cents=-598,
            source_fingerprint="invoice-price-credit-backfill",
        )
        self.credit_line = InvoiceLine.objects.create(
            user_id=self.user.pk,
            invoice_id=credit.pk,
            position=0,
            sku="EGG20",
            item_key="egg20",
            description="LARGE EGGS RETURN",
            quantity=1,
            unit_price_cents=-598,
            line_amount_cents=-598,
            ingredient_id=ingredient.pk,
        )

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_existing_matched_lines_become_invoice_prices(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        Price = apps.get_model("forkluck", "IngredientInvoicePrice")

        price = Price.objects.get(invoice_line_id=self.line.pk)
        self.assertEqual(price.purchase_size, 20)
        self.assertEqual(price.purchase_unit, "each")
        self.assertFalse(Price.objects.filter(invoice_line_id=self.credit_line.pk).exists())


class InvoiceLineItemKeyBackfillTests(TransactionTestCase):
    """0026 keys the lines that were stored before the column existed."""

    migrate_from = ("forkluck", "0024_fix_billing_locked")
    migrate_to = ("forkluck", "0028_backfill_invoice_line_item_key")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        Invoice = apps.get_model("forkluck", "Invoice")
        InvoiceLine = apps.get_model("forkluck", "InvoiceLine")
        self.user = User.objects.create(
            email="backfill@example.com",
            name="Backfill",
            password="!",
            first_name="",
            last_name="",
        )
        invoice = Invoice.objects.create(
            user_id=self.user.pk,
            supplier="harbor",
            supplier_name="Harbor Supply",
            document_type="invoice",
            invoice_number="IV-BACKFILL",
            invoice_date="2026-07-14",
            total_cents=1000,
            source_fingerprint="backfill-fingerprint",
        )
        for position, (sku, description) in enumerate(
            (
                ("CAR10", "CARROTS BABY ORANGE"),
                ("", "OG HVY WHP CRM UHT"),
                ("", "---"),
            )
        ):
            InvoiceLine.objects.create(
                user_id=self.user.pk,
                invoice_id=invoice.pk,
                position=position,
                sku=sku,
                description=description,
                line_amount_cents=100,
            )

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_stored_lines_get_the_key_a_new_line_would_get(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        InvoiceLine = apps.get_model("forkluck", "InvoiceLine")
        self.assertEqual(
            list(
                InvoiceLine.objects.filter(user_id=self.user.pk)
                .order_by("position")
                .values_list("item_key", flat=True)
            ),
            ["car10", "desc:og hvy whp crm uht", ""],
        )


class SupplyExpenseCategoryMigrationTests(TransactionTestCase):
    """0031 makes the two default supply categories costable supplies."""

    migrate_from = ("forkluck", "0029_drive_folder_source")
    migrate_to = ("forkluck", "0031_backfill_supply_expense_categories")

    def setUp(self) -> None:
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        apps = executor.loader.project_state([self.migrate_from]).apps
        User = apps.get_model("forkluck", "User")
        ExpenseCategory = apps.get_model("forkluck", "ExpenseCategory")
        self.user = User.objects.create(
            email="supplies@example.com",
            name="Supplies",
            password="!",
            first_name="",
            last_name="",
        )
        for position, (name, normalized) in enumerate(
            (
                ("Ingredients", "ingredients"),
                ("Packaging", "packaging"),
                ("Cleaning supplies", "cleaning supplies"),
                ("Utilities", "utilities"),
            )
        ):
            ExpenseCategory.objects.create(
                user_id=self.user.pk,
                name=name,
                normalized_name=normalized,
                is_ingredient=normalized == "ingredients",
                position=position,
            )

    def tearDown(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_packaging_and_cleaning_become_costable_supplies(self) -> None:
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])
        apps = executor.loader.project_state([self.migrate_to]).apps
        ExpenseCategory = apps.get_model("forkluck", "ExpenseCategory")
        rows = {
            row.normalized_name: (row.is_ingredient, row.is_supply)
            for row in ExpenseCategory.objects.filter(user_id=self.user.pk)
        }
        self.assertEqual(
            rows,
            {
                "ingredients": (True, False),
                "packaging": (True, True),
                "cleaning supplies": (True, True),
                "utilities": (False, False),
            },
        )


class SupplyLineTests(InvoiceTestCase):
    """A packaging or cleaning line prices a supply, not a food ingredient."""

    def supply_line(self, **overrides) -> dict:
        return self.cost_line(
            sku="BOX12",
            description="TAKEOUT BOX 8X8",
            categoryId=str(self.categories["Packaging"].id),
            costEntry={"name": "Takeout box 8x8"},
            **overrides,
        )

    def test_an_imported_supply_line_creates_a_non_edible_ingredient(self) -> None:
        self.import_invoices(
            self.invoice_payload(lines=[self.supply_line()], totalCents=7350)
        )
        box = Ingredient.objects.get(user=self.user, name="Takeout box 8x8")
        self.assertTrue(box.non_edible)

    def test_an_imported_food_line_stays_edible(self) -> None:
        self.import_invoices(self.invoice_payload())
        carrots = Ingredient.objects.get(user=self.user, name="Carrots baby orange")
        self.assertFalse(carrots.non_edible)

    def test_a_client_flag_cannot_make_a_food_line_a_supply(self) -> None:
        # non_edible is derived from the stored category, never the payload.
        line = self.cost_line()
        line["costEntry"]["nonEdible"] = True
        self.import_invoices(self.invoice_payload(lines=[line], totalCents=7350))
        carrots = Ingredient.objects.get(user=self.user, name="Carrots baby orange")
        self.assertFalse(carrots.non_edible)

    def test_reviewing_a_line_under_a_supply_category_creates_a_supply(self) -> None:
        self.import_invoices(
            self.invoice_payload(
                lines=[self.expense_line(lineAmountCents=7350, needsReview=True)],
                totalCents=7350,
            )
        )
        line = InvoiceLine.objects.get(user=self.user)
        response = self.post_internal(
            "review-invoice-line",
            {
                "lineId": str(line.id),
                "categoryId": str(self.categories["Cleaning supplies"].id),
                "costEntry": {
                    "name": "Dish soap",
                    "packUnit": "lb",
                    "packAmount": 5,
                    "packPriceCents": 1200,
                    "rawSize": "5 LB",
                    "quantity": 1,
                    "preferred": False,
                    "ingredientId": None,
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(
            Ingredient.objects.get(user=self.user, name="Dish soap").non_edible
        )


class OverviewTests(InvoiceTestCase):
    def _supplier_item(self, ingredient, supplier: str, external_id: str, user=None):
        # Every write that puts a key on a row records the supplier behind it,
        # which is the invariant invoice-suppliers/ reads.
        ensure_supplier(user or self.user, supplier)
        return SupplierItem.objects.create(
            user=user or self.user,
            ingredient=ingredient,
            supplier=supplier,
            external_id=external_id,
            pack_price_cents=1000,
            pack_grams=1000,
            pack_amount=1,
            pack_unit="kg",
        )

    def _ingredient(self, name: str, user=None):
        return Ingredient.objects.create(
            user=user or self.user,
            name=name,
            normalized_name=name.lower(),
            purchase_cost_cents=1000,
        )

    def test_invoice_suppliers_count_pantry_products_per_supplier(self) -> None:
        """The counts the settings screen shows are aggregated in Django.

        They used to be produced in Next by downloading every ingredient with
        its full price history and supplier items, purely to total them.
        """
        ingredient = self._ingredient("Carrots")
        for index, supplier in enumerate(["harbor", "harbor", "acme"]):
            self._supplier_item(ingredient, supplier, f"EXT{index}")

        # Another workspace's products must never be counted here.
        other = User.objects.create_user(
            email="supplier-count-other@example.com",
            name="Other",
            password="a-long-test-passphrase-1357",
        )
        self._supplier_item(
            self._ingredient("Carrots", user=other), "harbor", "OTHER1", user=other
        )

        items = self.get_internal("/internal/v1/invoice-suppliers/").json()["items"]
        counts = {item["key"]: item["itemCount"] for item in items}

        self.assertEqual(counts["harbor"], 2)
        self.assertEqual(counts["acme"], 1)

    def test_invoice_suppliers_are_ordered_by_name(self) -> None:
        # The list is an address book now, not a leaderboard: it is read to
        # find one supplier, so it reads in the order a name is looked up in.
        ingredient = self._ingredient("Carrots")
        for index, supplier in enumerate(["harbor", "harbor", "acme"]):
            self._supplier_item(ingredient, supplier, f"ORD{index}")

        items = self.get_internal("/internal/v1/invoice-suppliers/").json()["items"]

        self.assertEqual([item["key"] for item in items], ["acme", "harbor"])

    def test_a_supplier_only_in_the_pantry_still_appears(self) -> None:
        # Spreadsheet imports create supplier products without any invoice, so
        # the invoice table alone is not the full list.
        self._supplier_item(self._ingredient("Flour"), "pantryonly", "P1")

        items = self.get_internal("/internal/v1/invoice-suppliers/").json()["items"]
        entry = next(item for item in items if item["key"] == "pantryonly")

        self.assertEqual(entry["itemCount"], 1)
        # No invoice supplied a display name, so the key is title-cased back.
        self.assertEqual(entry["name"], "Pantryonly")

    def test_invoice_suppliers_include_expense_only_imports_and_scope_user(
        self,
    ) -> None:
        self.import_invoices(
            self.invoice_payload(
                supplier="harbor",
                supplierName="Harbor Supply",
                lines=[self.expense_line()],
            )
        )
        self.assertFalse(
            SupplierItem.objects.filter(user=self.user, supplier="harbor").exists()
        )
        other = User.objects.create_user(
            email="other-invoices@example.com",
            name="Other Invoice User",
            password="a-long-test-passphrase-1357",
        )
        Invoice.objects.create(
            user=other,
            supplier="private-supplier",
            supplier_name="Private Supplier",
            invoice_number="PRIVATE-1",
            invoice_date=self.invoice_payload()["invoiceDate"],
            total_cents=100,
            line_count=0,
            matched_line_count=0,
            source_fingerprint="private-invoice",
            file_name="private.pdf",
        )

        response = self.get_internal("/internal/v1/invoice-suppliers/")

        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        self.assertEqual([item["key"] for item in items], ["harbor"])
        self.assertEqual(
            {key: value for key, value in items[0].items() if key != "id"},
            {
                "key": "harbor",
                "name": "Harbor Supply",
                "email": "",
                "phone": "",
                "accountNumber": "",
                "notes": "",
                "defaultCategoryId": None,
                "invoiceCount": 1,
                # Expense-only: no pantry products carry this supplier.
                "itemCount": 0,
                "ignoreCount": 0,
            },
        )

    def test_overview_aggregates_month_categories_and_suppliers(self) -> None:
        self.import_invoices(
            self.invoice_payload(),
            self.invoice_payload(
                fileName="acme.pdf",
                supplier="acme",
                supplierName="Acme Provisions",
                invoiceNumber="W-9",
                totalCents=2000,
                lines=[
                    self.expense_line(
                        description="DELI CONTAINERS",
                        lineAmountCents=2000,
                        categoryId=str(self.categories["Packaging"].id),
                    )
                ],
            ),
            self.invoice_payload(
                fileName="credit.pdf",
                documentType="credit_memo",
                invoiceNumber="CR-1",
                totalCents=-500,
                lines=[
                    self.expense_line(
                        description="RETURNED GOODS",
                        lineAmountCents=-500,
                        categoryId=str(self.categories["Ingredients"].id),
                    )
                ],
            ),
            self.invoice_payload(
                fileName="june.pdf",
                invoiceNumber="IV-JUNE",
                invoiceDate="2026-06-02",
                totalCents=1000,
                lines=[self.expense_line(lineAmountCents=1000)],
            ),
        )

        response = self.get_internal("/internal/v1/invoices-overview/?month=2026-07")
        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data["month"], "2026-07")
        self.assertEqual(
            [row["month"] for row in data["months"]], ["2026-07", "2026-06"]
        )
        (summary,) = data["summary"]
        self.assertEqual(summary["currencyCode"], "USD")
        self.assertEqual(summary["invoiceCount"], 3)
        self.assertEqual(summary["totalCents"], 7850 + 2000 - 500)
        self.assertEqual(summary["creditCents"], -500)

        by_category = {row["name"]: row for row in data["byCategory"]}
        self.assertEqual(by_category["Ingredients"]["totalCents"], 7350 - 500)
        self.assertEqual(by_category["Packaging"]["totalCents"], 2000)
        self.assertEqual(by_category["Other"]["totalCents"], 500)

        by_supplier = {row["supplier"]: row for row in data["bySupplier"]}
        self.assertEqual(by_supplier["harbor"]["invoiceCount"], 2)
        self.assertEqual(by_supplier["acme"]["totalCents"], 2000)

        self.assertEqual(len(data["invoices"]), 3)

    def test_overview_never_sums_different_document_currencies(self) -> None:
        settings_row, _ = BenchCostSettings.objects.get_or_create(user=self.user)
        settings_row.currency_code = "USD"
        settings_row.save(update_fields=["currency_code"])
        self.import_invoices(self.invoice_payload())

        settings_row.currency_code = "EUR"
        settings_row.save(update_fields=["currency_code"])
        self.import_invoices(
            self.invoice_payload(
                fileName="eur.pdf",
                invoiceNumber="EUR-1",
                totalCents=2000,
                lines=[self.expense_line(lineAmountCents=2000)],
            ),
            reviewed_currency="EUR",
        )

        data = self.get_internal("/internal/v1/invoices-overview/?month=2026-07").json()

        self.assertEqual(
            {row["currencyCode"]: row["totalCents"] for row in data["summary"]},
            {"EUR": 2000, "USD": 7850},
        )
        july = next(row for row in data["months"] if row["month"] == "2026-07")
        self.assertEqual(
            {row["currencyCode"]: row["totalCents"] for row in july["totals"]},
            {"EUR": 2000, "USD": 7850},
        )
        self.assertEqual(
            {
                (row["name"], row["currencyCode"]): row["totalCents"]
                for row in data["byCategory"]
            },
            {
                ("Ingredients", "USD"): 7350,
                ("Other", "EUR"): 2000,
                ("Other", "USD"): 500,
            },
        )

    def test_overview_defaults_to_latest_month(self) -> None:
        self.import_invoices(self.invoice_payload())
        response = self.get_internal("/internal/v1/invoices-overview/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["month"], "2026-07")

    def test_overview_caps_the_month_and_the_tab_finds_the_hidden_row(self) -> None:
        Invoice.objects.bulk_create(
            [
                Invoice(
                    user=self.user,
                    supplier="test-supplier",
                    supplier_name="Test Supplier",
                    invoice_number=f"APPLIED-{index}",
                    invoice_date="2026-07-31",
                    total_cents=0,
                    line_count=1,
                    matched_line_count=1,
                    source_fingerprint=f"applied-{index}",
                    file_name=f"applied-{index}.pdf",
                )
                for index in range(200)
            ]
        )
        review_invoice = Invoice.objects.create(
            user=self.user,
            supplier="test-supplier",
            supplier_name="Test Supplier",
            invoice_number="REVIEW-OLD",
            invoice_date="2026-07-01",
            total_cents=0,
            line_count=1,
            matched_line_count=0,
            unresolved_line_count=1,
            source_fingerprint="review-old",
            file_name="review-old.pdf",
        )

        data = self.get_internal("/internal/v1/invoices-overview/?month=2026-07").json()

        self.assertEqual(data["needsReviewCount"], 1)
        # The month list is a bounded page and no longer smuggles the review
        # rows past its own cap; the tab is where they are read.
        self.assertEqual(len(data["invoices"]), 200)
        self.assertNotIn(
            str(review_invoice.id), {row["id"] for row in data["invoices"]}
        )

        attention = self.get_internal(
            "/internal/v1/invoices-overview/?month=2026-07&tab=attention"
        ).json()
        self.assertEqual(
            [row["id"] for row in attention["invoices"]], [str(review_invoice.id)]
        )
        self.assertEqual(attention["invoices"][0]["issueKind"], "unmatched-lines")

    def test_invoice_lines_endpoint(self) -> None:
        self.import_invoices(self.invoice_payload())
        invoice = Invoice.objects.get(user=self.user)
        response = self.get_internal(f"/internal/v1/invoices/{invoice.id}/lines/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["invoice"]["publicId"], invoice.public_id)
        self.assertEqual(len(data["items"]), 2)
        self.assertEqual(data["items"][0]["sku"], "car10")
        self.assertTrue(data["items"][0]["priceUpdated"])


class OverviewSearchTests(InvoiceTestCase):
    """One search box and one attention tab, both across every month."""

    def setUp(self) -> None:
        super().setUp()
        self.import_invoices(
            self.invoice_payload(
                fileName="july.pdf",
                invoiceNumber="IV101-1",
                invoiceDate="2026-07-14",
                totalCents=7850,
            ),
            self.invoice_payload(
                fileName="may.pdf",
                supplier="acme",
                supplierName="Acme Provisions",
                invoiceNumber="W-9",
                invoiceDate="2026-05-02",
                totalCents=8873,
                lines=[
                    self.expense_line(
                        description="DELI CONTAINERS", lineAmountCents=8873
                    )
                ],
            ),
        )

    def numbers(self, suffix: str) -> list[str]:
        response = self.get_internal(f"/internal/v1/invoices-overview/{suffix}")
        self.assertEqual(response.status_code, 200, response.content)
        return [row["invoiceNumber"] for row in response.json()["invoices"]]

    def test_the_month_view_sees_only_its_month(self) -> None:
        self.assertEqual(self.numbers("?month=2026-07"), ["IV101-1"])

    def test_a_number_is_found_from_another_month(self) -> None:
        self.assertEqual(self.numbers("?month=2026-07&q=W-9"), ["W-9"])

    def test_a_supplier_name_is_found_from_another_month(self) -> None:
        self.assertEqual(self.numbers("?month=2026-07&q=acme"), ["W-9"])

    def test_a_line_description_is_found_from_another_month(self) -> None:
        self.assertEqual(self.numbers("?month=2026-07&q=deli+containers"), ["W-9"])

    def test_a_printed_total_is_found_from_another_month(self) -> None:
        self.assertEqual(self.numbers("?month=2026-07&q=88.73"), ["W-9"])

    def test_a_query_that_matches_nothing_returns_nothing(self) -> None:
        self.assertEqual(self.numbers("?month=2026-07&q=zzz"), [])

    def test_the_month_totals_stay_on_the_month_under_a_search(self) -> None:
        data = self.get_internal(
            "/internal/v1/invoices-overview/?month=2026-07&q=acme"
        ).json()
        self.assertEqual(data["month"], "2026-07")
        self.assertEqual([row["totalCents"] for row in data["summary"]], [7850])
        self.assertEqual(
            [row["supplierName"] for row in data["bySupplier"]], ["Harbor Supply"]
        )

    def test_the_attention_tab_reaches_across_months(self) -> None:
        older = Invoice.objects.create(
            user=self.user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            invoice_number="OLD-1",
            invoice_date="2026-01-05",
            total_cents=1000,
            source_fingerprint="old-1",
            file_name="old.pdf",
        )

        data = self.get_internal(
            "/internal/v1/invoices-overview/?month=2026-07&tab=attention"
        ).json()

        self.assertEqual([row["id"] for row in data["invoices"]], [str(older.id)])
        self.assertEqual(data["needsReviewCount"], 1)
        # The month's own totals are unmoved by the tab.
        self.assertEqual(data["month"], "2026-07")
        self.assertEqual([row["totalCents"] for row in data["summary"]], [7850])

    def test_the_count_is_the_workspace_not_the_month(self) -> None:
        Invoice.objects.create(
            user=self.user,
            supplier="harbor",
            supplier_name="Harbor Supply",
            invoice_number="OLD-1",
            invoice_date="2026-01-05",
            total_cents=1000,
            source_fingerprint="old-1",
            file_name="old.pdf",
        )
        data = self.get_internal("/internal/v1/invoices-overview/?month=2026-07").json()
        self.assertEqual(data["needsReviewCount"], 1)


class InvoiceIssueKindTests(InvoiceTestCase):
    """What each row says is wrong with it, and which complaint wins."""

    def row(self, **fields) -> dict:
        defaults = {
            "user": self.user,
            "supplier": "harbor",
            "supplier_name": "Harbor Supply",
            "invoice_number": "N",
            "invoice_date": "2026-07-14",
            "total_cents": 0,
            "line_count": 1,
            "source_fingerprint": f"fp-{Invoice.objects.count()}",
            "file_name": "f.pdf",
        }
        invoice = Invoice.objects.create(**{**defaults, **fields})
        data = self.get_internal(f"/internal/v1/invoices/{invoice.id}/lines/").json()
        return data["invoice"]

    def test_no_lines(self) -> None:
        self.assertEqual(self.row(line_count=0)["issueKind"], "no-lines")

    def test_unmatched_lines(self) -> None:
        self.assertEqual(
            self.row(unresolved_line_count=1)["issueKind"], "unmatched-lines"
        )

    def test_total_mismatch(self) -> None:
        row = self.row(total_cents=5100)
        self.assertEqual(row["issueKind"], "total-mismatch")
        self.assertEqual(row["totalDeltaCents"], 5100)

    def test_a_total_within_the_tolerance_is_not_a_mismatch(self) -> None:
        self.assertIsNone(self.row(total_cents=50)["issueKind"])

    def test_unknown_supplier(self) -> None:
        self.assertEqual(self.row(supplier_name="")["issueKind"], "unknown-supplier")

    def test_nothing_is_wrong(self) -> None:
        self.assertIsNone(self.row()["issueKind"])

    def test_precedence_runs_worst_first(self) -> None:
        # Every complaint at once: the row with no lines says so and nothing
        # else, and each rung takes over as the one above it is fixed.
        self.assertEqual(
            self.row(
                line_count=0,
                unresolved_line_count=1,
                supplier_name="",
                total_cents=5100,
            )["issueKind"],
            "no-lines",
        )
        self.assertEqual(
            self.row(unresolved_line_count=1, supplier_name="", total_cents=5100)[
                "issueKind"
            ],
            "unmatched-lines",
        )
        self.assertEqual(
            self.row(supplier_name="", total_cents=5100)["issueKind"],
            "total-mismatch",
        )

    def test_the_tab_and_the_kind_agree(self) -> None:
        for fields in (
            {"line_count": 0},
            {"unresolved_line_count": 1},
            {"total_cents": 5100},
            {"supplier_name": ""},
        ):
            with self.subTest(fields=fields):
                Invoice.objects.filter(user=self.user).delete()
                self.row(**fields)
                data = self.get_internal(
                    "/internal/v1/invoices-overview/?tab=attention"
                ).json()
                self.assertEqual(len(data["invoices"]), 1)
                self.assertEqual(data["needsReviewCount"], 1)


class InvoiceActivityTests(InvoiceTestCase):
    """One log line per imported invoice, readable by resource id."""

    def second_invoice(self) -> dict:
        return self.invoice_payload(
            fileName="acme.pdf",
            supplier="acme",
            supplierName="Acme Provisions",
            invoiceNumber="W-9",
            totalCents=2000,
            lines=[self.expense_line(lineAmountCents=2000)],
        )

    def activity(self, suffix: str = "") -> list[dict]:
        response = self.get_internal(f"/internal/v1/activity/{suffix}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["items"]

    def test_each_imported_invoice_writes_its_own_line(self) -> None:
        self.import_invoices(self.invoice_payload(), self.second_invoice())
        invoices = {row.invoice_number: row for row in Invoice.objects.all()}

        rows = self.activity("?types=invoice")
        self.assertEqual(
            {row["name"] for row in rows},
            {"Harbor Supply · IV101-1", "Acme Provisions · W-9"},
        )
        for number, invoice in invoices.items():
            with self.subTest(number=number):
                line = next(row for row in rows if row["resourceId"] == str(invoice.id))
                self.assertEqual(line["event"], "added")
                self.assertEqual(line["context"]["publicId"], invoice.public_id)
                self.assertEqual(line["context"]["fileName"], invoice.file_name)
                self.assertEqual(line["context"]["source"], "")

    def test_the_resource_filter_narrows_to_one_invoice(self) -> None:
        self.import_invoices(self.invoice_payload(), self.second_invoice())
        invoice = Invoice.objects.get(invoice_number="W-9")

        rows = self.activity(f"?resourceId={invoice.id}")
        self.assertEqual([row["resourceId"] for row in rows], [str(invoice.id)])

    def test_a_malformed_resource_id_is_refused(self) -> None:
        response = self.get_internal("/internal/v1/activity/?resourceId=nope")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid resourceId")


class SupplierDefaultCategoryTests(InvoiceTestCase):
    """The category a supplier's lines fall back to."""

    def supplier_row(self, key: str = "harbor supply") -> dict:
        items = self.get_internal("/internal/v1/invoice-suppliers/").json()["items"]
        return next(row for row in items if row["key"] == key)

    def test_save_sets_it_and_null_clears_it(self) -> None:
        packaging = self.categories["Packaging"]
        response = self.post_internal(
            "save-supplier",
            {"name": "Harbor Supply", "defaultCategoryId": str(packaging.id)},
        )
        self.assertEqual(response.status_code, 200, response.content)
        supplier_id = response.json()["id"]
        self.assertEqual(self.supplier_row()["defaultCategoryId"], str(packaging.id))

        self.post_internal(
            "save-supplier",
            {"id": supplier_id, "name": "Harbor Supply", "defaultCategoryId": None},
        )
        self.assertIsNone(self.supplier_row()["defaultCategoryId"])

    def test_an_unknown_category_is_refused(self) -> None:
        response = self.post_internal(
            "save-supplier",
            {
                "name": "Harbor Supply",
                "defaultCategoryId": "00000000-0000-0000-0000-000000000000",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Expense category was not found")

    def test_a_merge_fills_the_target_blank_from_the_source(self) -> None:
        packaging = self.categories["Packaging"]
        source = self.post_internal(
            "save-supplier",
            {"name": "Harbor Supply", "defaultCategoryId": str(packaging.id)},
        ).json()["id"]
        target = self.post_internal(
            "save-supplier", {"name": "Acme Provisions"}
        ).json()["id"]

        response = self.post_internal(
            "merge-suppliers", {"sourceId": source, "targetId": target}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            self.supplier_row("acme provisions")["defaultCategoryId"],
            str(packaging.id),
        )

    def test_the_probe_falls_back_to_it(self) -> None:
        packaging = self.categories["Packaging"]
        self.post_internal(
            "save-supplier",
            {"name": "Harbor Supply", "defaultCategoryId": str(packaging.id)},
        )

        response = self.post_internal(
            "invoice-line-status",
            {
                "supplier": "harbor supply",
                "lines": [{"sku": "NEW-1", "name": "PAPER CUPS"}],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["items"][0]["lastCategoryId"], str(packaging.id)
        )

    def test_a_line_with_its_own_memory_keeps_it(self) -> None:
        packaging = self.categories["Packaging"]
        self.post_internal(
            "save-supplier",
            {"name": "Harbor Supply", "defaultCategoryId": str(packaging.id)},
        )
        self.import_invoices(self.invoice_payload(supplier="harbor supply"))

        response = self.post_internal(
            "invoice-line-status",
            {
                "supplier": "harbor supply",
                "lines": [{"sku": "CAR10", "name": "CARROTS BABY ORANGE"}],
            },
        )
        self.assertEqual(
            response.json()["items"][0]["lastCategoryId"],
            str(self.categories["Ingredients"].id),
        )


class AnthropicKeyTests(InvoiceTestCase):
    KEY = "sk-ant-test-key-1234"

    def test_save_encrypts_and_returns_hint(self) -> None:
        response = self.post_internal("save-anthropic-key", {"key": self.KEY})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"configured": True, "hint": "1234"})

        credential = AnthropicCredential.objects.get(user=self.user)
        self.assertNotIn(self.KEY, credential.api_key_encrypted)
        self.assertTrue(credential.api_key_encrypted.startswith("v1:"))

        # The loopback endpoint hands the decrypted key to the Next process.
        fetched = self.get_internal("/internal/v1/ai-credential/")
        self.assertEqual(
            fetched.json(), {"configured": True, "hint": "1234", "key": self.KEY}
        )

    def test_undecryptable_key_reports_configured_with_no_key(self) -> None:
        # The third state of this read model: a key IS on file, but the
        # envelope will not open (rotated FORKLUCK_TOKEN_KEY, corrupted row).
        # It must stay distinguishable from "never configured" — the Next
        # process shows a different, actionable message for each, and
        # collapsing them would tell the user to connect a key they already
        # have. Parity case: apps/web/tests/invoice-parse-credential.test.ts.
        self.post_internal("save-anthropic-key", {"key": self.KEY})
        credential = AnthropicCredential.objects.get(user=self.user)
        credential.api_key_encrypted = "v1:not-a-real-envelope"
        credential.save(update_fields=["api_key_encrypted"])

        fetched = self.get_internal("/internal/v1/ai-credential/").json()
        self.assertEqual(fetched, {"configured": True, "hint": "1234", "key": None})

    def test_save_replaces_existing_key(self) -> None:
        self.post_internal("save-anthropic-key", {"key": self.KEY})
        replaced = self.post_internal(
            "save-anthropic-key", {"key": "sk-ant-next-key-5678"}
        )
        self.assertEqual(replaced.json()["hint"], "5678")
        self.assertEqual(AnthropicCredential.objects.filter(user=self.user).count(), 1)

    def test_save_rejects_non_anthropic_keys(self) -> None:
        response = self.post_internal(
            "save-anthropic-key", {"key": "not-an-anthropic-key"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(AnthropicCredential.objects.filter(user=self.user).exists())

    def test_delete_and_status_in_overview(self) -> None:
        self.post_internal("save-anthropic-key", {"key": self.KEY})
        self.import_invoices(self.invoice_payload())
        overview = self.get_internal("/internal/v1/invoices-overview/").json()
        self.assertEqual(overview["aiKey"], {"configured": True, "hint": "1234"})

        deleted = self.post_internal("delete-anthropic-key", {})
        self.assertEqual(deleted.status_code, 200)
        fetched = self.get_internal("/internal/v1/ai-credential/").json()
        self.assertEqual(fetched, {"configured": False, "hint": None, "key": None})


class ExpenseCategoryTests(InvoiceTestCase):
    def test_save_rename_and_duplicate_category(self) -> None:
        created = self.post_internal(
            "save-expense-category", {"id": None, "name": "Flowers"}
        )
        self.assertEqual(created.status_code, 200)
        category_id = created.json()["id"]

        renamed = self.post_internal(
            "save-expense-category", {"id": category_id, "name": "Florals"}
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertTrue(
            ExpenseCategory.objects.filter(user=self.user, name="Florals").exists()
        )

        duplicate = self.post_internal(
            "save-expense-category", {"id": None, "name": "florals"}
        )
        self.assertEqual(duplicate.status_code, 400)

    def test_marking_a_category_a_supply_makes_it_costable(self) -> None:
        created = self.post_internal(
            "save-expense-category", {"id": None, "name": "Takeaway", "isSupply": True}
        )
        self.assertEqual(created.status_code, 200)
        row = ExpenseCategory.objects.get(user=self.user, id=created.json()["id"])
        self.assertTrue(row.is_supply)
        self.assertTrue(row.is_ingredient)

        cleared = self.post_internal(
            "save-expense-category",
            {"id": str(row.id), "name": "Takeaway", "isSupply": False},
        )
        self.assertEqual(cleared.status_code, 200)
        row.refresh_from_db()
        self.assertFalse(row.is_supply)
        self.assertFalse(row.is_ingredient)

    def test_a_rename_leaves_a_supply_category_a_supply(self) -> None:
        packaging = self.categories["Packaging"]
        renamed = self.post_internal(
            "save-expense-category", {"id": str(packaging.id), "name": "Boxes"}
        )
        self.assertEqual(renamed.status_code, 200)
        packaging.refresh_from_db()
        self.assertTrue(packaging.is_supply)
        self.assertTrue(packaging.is_ingredient)

    def test_renaming_the_ingredients_category_keeps_it_costable(self) -> None:
        ingredients = self.categories["Ingredients"]
        renamed = self.post_internal(
            "save-expense-category", {"id": str(ingredients.id), "name": "Food"}
        )
        self.assertEqual(renamed.status_code, 200)
        ingredients.refresh_from_db()
        self.assertTrue(ingredients.is_ingredient)
        self.assertFalse(ingredients.is_supply)

    def test_delete_category_refuses_ingredients(self) -> None:
        ingredients = self.categories["Ingredients"]
        refused = self.post_internal(
            "delete-expense-category", {"id": str(ingredients.id)}
        )
        self.assertEqual(refused.status_code, 400)

        other = self.categories["Other"]
        deleted = self.post_internal("delete-expense-category", {"id": str(other.id)})
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(
            ExpenseCategory.objects.filter(user=self.user, id=other.id).exists()
        )


class PaymentMethodTests(InvoiceTestCase):
    def add(self, name: str) -> str:
        response = self.post_internal("save-payment-method", {"name": name})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["id"]

    def test_save_rename_list_and_delete(self) -> None:
        method_id = self.add("Store credit")

        renamed = self.post_internal(
            "save-payment-method", {"id": method_id, "name": "House account"}
        )
        self.assertEqual(renamed.status_code, 200)

        listed = self.get_internal("payment-methods/").json()["items"]
        self.assertEqual(listed, [{"id": method_id, "name": "House account"}])

        deleted = self.post_internal("delete-payment-method", {"id": method_id})
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(PaymentMethod.objects.filter(user=self.user).exists())

    def test_a_duplicate_or_built_in_name_is_refused(self) -> None:
        self.add("Store credit")

        duplicate = self.post_internal("save-payment-method", {"name": "store credit"})
        self.assertEqual(duplicate.status_code, 400)

        built_in = self.post_internal("save-payment-method", {"name": "cash"})
        self.assertEqual(built_in.status_code, 400)
        self.assertEqual(built_in.json()["error"], "That payment method is built in")

    def test_the_column_no_longer_carries_a_check_constraint(self) -> None:
        names = {constraint.name for constraint in Invoice._meta.constraints}
        self.assertNotIn("invoice_payment_method_known", names)


class InvoiceExtractionTests(InvoiceTestCase):
    """The read the invoice was made from, kept beside the merchant's
    corrections. Nothing reads the pair yet."""

    def extraction(self) -> dict:
        return {
            "supplierName": "Harbor Supply",
            "documentType": "invoice",
            "invoiceNumber": "IV101-1",
            "invoiceDate": "2026-07-14",
            "totalAmount": "78.50",
            "currency": None,
            "otherChargesAmount": None,
            "notUsable": None,
            "lines": [
                {
                    "lineNumber": 1,
                    "sku": "CAR10",
                    "description": "CARROTS BABY ORANGE",
                    "quantity": "3",
                    "unit": "CS",
                    "packSize": "24 X 1 LB",
                    "unitPrice": "24.50",
                    "lineAmount": "73.50",
                    "suggestedCategory": "Ingredients",
                    "uncertain": False,
                    "uncertainReason": None,
                }
            ],
        }

    def test_import_keeps_the_read_beside_the_invoice(self) -> None:
        document = self.extraction()
        self.import_invoices(self.invoice_payload(extraction=document, escalated=True))

        invoice = Invoice.objects.get(user=self.user)
        stored = InvoiceExtraction.objects.get(invoice=invoice)
        self.assertEqual(stored.document, document)
        self.assertTrue(stored.escalated)

    def test_an_invoice_with_no_read_keeps_none(self) -> None:
        self.import_invoices(self.invoice_payload(extraction=None))
        self.assertEqual(InvoiceExtraction.objects.count(), 0)

    def test_a_duplicate_file_adds_no_second_read(self) -> None:
        document = self.extraction()
        self.import_invoices(self.invoice_payload(extraction=document))
        result = self.import_invoices(self.invoice_payload(extraction=document))

        self.assertEqual(result["invoices"], 0)
        self.assertEqual(InvoiceExtraction.objects.count(), 1)

    def test_a_document_too_large_to_store_is_refused(self) -> None:
        oversize = {**self.extraction(), "notUsable": "x" * 70_000}
        response = self.post_internal(
            "import-invoices",
            {
                "invoices": [self.invoice_payload(extraction=oversize)],
                "reviewedCurrencyCode": "USD",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("too large", response.json()["error"])
        self.assertEqual(Invoice.objects.filter(user=self.user).count(), 0)
        self.assertEqual(InvoiceExtraction.objects.count(), 0)

    def test_a_read_that_is_not_an_object_is_refused(self) -> None:
        response = self.post_internal(
            "import-invoices",
            {
                "invoices": [self.invoice_payload(extraction=["lines"])],
                "reviewedCurrencyCode": "USD",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("malformed", response.json()["error"])

    def test_deleting_the_invoice_takes_the_read_with_it(self) -> None:
        self.import_invoices(self.invoice_payload(extraction=self.extraction()))
        invoice = Invoice.objects.get(user=self.user)

        response = self.post_internal("delete-invoice", {"id": str(invoice.id)})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(InvoiceExtraction.objects.count(), 0)
