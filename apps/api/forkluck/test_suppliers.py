"""The supplier record: its backfill, its edits, and who creates it."""

from datetime import date
from decimal import Decimal

from django.test import TestCase

from .domains.invoices.actions import (
    action_delete_supplier,
    action_import_invoices,
    action_merge_suppliers,
    action_save_supplier,
    ensure_expense_categories,
)
from .domains.shared.supplier_import import (
    apply_supplier_import_entry,
    ensure_supplier,
    supplier_key_from_name,
    upsert_supplier_ignores,
)
from .models import (
    Ingredient,
    IngredientImport,
    Invoice,
    Supplier,
    SupplierItem,
    SupplierItemIgnore,
    User,
)


def make_user(email: str) -> User:
    return User.objects.create_user(
        email=email, name="Supplier Tester", password="a-long-test-passphrase-2468"
    )


def make_invoice(user: User, key: str, name: str, fingerprint: str) -> Invoice:
    return Invoice.objects.create(
        user=user,
        supplier=key,
        supplier_name=name,
        invoice_number=fingerprint,
        invoice_date=date(2026, 1, 15),
        total_cents=1000,
        source_fingerprint=fingerprint,
        file_name=f"{fingerprint}.pdf",
    )


def make_item(user: User, key: str, external_id: str) -> SupplierItem:
    ingredient = Ingredient.objects.create(
        user=user,
        name=f"{key} {external_id}",
        normalized_name=f"{key} {external_id}",
        purchase_cost_cents=1000,
        purchase_size=Decimal("1"),
        purchase_unit="kg",
    )
    return SupplierItem.objects.create(
        user=user,
        ingredient=ingredient,
        supplier=key,
        external_id=external_id,
        title=external_id,
        raw_size="1 kg",
        pack_price_cents=1000,
        pack_grams=1000,
        pack_amount=Decimal("1"),
        pack_unit="kg",
    )


class SupplierKeyTests(TestCase):
    def test_the_key_drops_legal_forms_and_collapses_baldor(self):
        self.assertEqual(supplier_key_from_name("Acme Foods Inc."), "acme foods")
        self.assertEqual(
            supplier_key_from_name("BALDOR SPECIALTY FOODS"), "baldor"
        )
        self.assertEqual(supplier_key_from_name("  "), "")


class SaveSupplierTests(TestCase):
    def setUp(self) -> None:
        self.user = make_user("save@example.com")

    def test_create_derives_the_key_and_keeps_the_details(self):
        result = action_save_supplier(
            self.user,
            {
                "name": "Acme Foods Inc.",
                "email": "orders@acme.example",
                "phone": "555-0100",
                "accountNumber": "A-1",
                "notes": "Tuesdays.",
            },
        )

        row = Supplier.objects.get(id=result["id"])
        self.assertEqual(row.key, "acme foods")
        self.assertEqual(row.account_number, "A-1")

    def test_creating_a_supplier_that_exists_is_refused(self):
        ensure_supplier(self.user, "acme foods", "Acme Foods")

        with self.assertRaisesMessage(ValueError, "That supplier already exists"):
            action_save_supplier(self.user, {"name": "Acme Foods LLC"})

    def test_a_rename_that_changes_the_key_repoints_every_table(self):
        row = ensure_supplier(self.user, "acme", "Acme")
        make_invoice(self.user, "acme", "Acme", "fp-1")
        make_item(self.user, "acme", "a-1")
        SupplierItemIgnore.objects.create(
            user=self.user, supplier="acme", external_id="a-2", title="Napkins"
        )

        action_save_supplier(self.user, {"id": str(row.id), "name": "Acme Foods"})

        row.refresh_from_db()
        self.assertEqual(row.key, "acme foods")
        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual(invoice.supplier, "acme foods")
        self.assertEqual(invoice.supplier_name, "Acme Foods")
        self.assertEqual(
            SupplierItem.objects.get(user=self.user).supplier, "acme foods"
        )
        self.assertEqual(
            SupplierItemIgnore.objects.get(user=self.user).supplier, "acme foods"
        )

    def test_a_rename_onto_another_supplier_asks_for_a_merge(self):
        row = ensure_supplier(self.user, "acme", "Acme")
        ensure_supplier(self.user, "vestal", "Vestal")

        with self.assertRaisesMessage(ValueError, "Merge them instead."):
            action_save_supplier(self.user, {"id": str(row.id), "name": "Vestal"})

        row.refresh_from_db()
        self.assertEqual(row.key, "acme")

    def test_editing_details_without_touching_the_name_keeps_the_key(self):
        row = ensure_supplier(self.user, "acme", "Acme")

        action_save_supplier(
            self.user, {"id": str(row.id), "name": "Acme", "phone": "555-0199"}
        )

        row.refresh_from_db()
        self.assertEqual((row.key, row.phone), ("acme", "555-0199"))


class MergeSuppliersTests(TestCase):
    def setUp(self) -> None:
        self.user = make_user("merge@example.com")
        self.source = ensure_supplier(self.user, "acme", "Acme")
        self.source.phone = "555-0100"
        self.source.notes = "Tuesdays."
        self.source.save()
        self.target = ensure_supplier(self.user, "vestal", "Vestal")
        self.target.notes = "Thursdays."
        self.target.save()

    def merge(self) -> dict:
        return action_merge_suppliers(
            self.user,
            {"sourceId": str(self.source.id), "targetId": str(self.target.id)},
        )

    def test_rows_move_and_the_source_is_gone(self):
        make_invoice(self.user, "acme", "Acme", "fp-1")
        make_item(self.user, "acme", "a-1")
        SupplierItemIgnore.objects.create(
            user=self.user, supplier="acme", external_id="a-2", title="Napkins"
        )

        result = self.merge()

        self.assertEqual(result["moved"], {"invoices": 1, "items": 1, "ignores": 1})
        invoice = Invoice.objects.get(user=self.user)
        self.assertEqual((invoice.supplier, invoice.supplier_name), ("vestal", "Vestal"))
        self.assertEqual(SupplierItem.objects.get(user=self.user).supplier, "vestal")
        self.assertFalse(Supplier.objects.filter(id=self.source.id).exists())

    def test_a_sku_both_suppliers_carry_keeps_the_targets_row(self):
        make_item(self.user, "acme", "shared")
        kept = make_item(self.user, "vestal", "shared")

        result = self.merge()

        self.assertEqual(result["moved"]["items"], 0)
        self.assertEqual(
            list(SupplierItem.objects.filter(user=self.user).values_list("id", flat=True)),
            [kept.id],
        )

    def test_the_target_keeps_its_details_and_fills_its_blanks(self):
        self.merge()

        self.target.refresh_from_db()
        self.assertEqual(self.target.notes, "Thursdays.")
        self.assertEqual(self.target.phone, "555-0100")

    def test_merging_a_supplier_into_itself_is_refused(self):
        with self.assertRaisesMessage(ValueError, "Pick a different supplier"):
            action_merge_suppliers(
                self.user,
                {"sourceId": str(self.source.id), "targetId": str(self.source.id)},
            )


class DeleteSupplierTests(TestCase):
    def setUp(self) -> None:
        self.user = make_user("delete@example.com")
        self.supplier = ensure_supplier(self.user, "acme", "Acme")

    def test_an_unused_supplier_is_deleted(self):
        action_delete_supplier(self.user, {"id": str(self.supplier.id)})

        self.assertFalse(Supplier.objects.filter(id=self.supplier.id).exists())

    def test_a_supplier_with_rows_is_kept(self):
        SupplierItemIgnore.objects.create(
            user=self.user, supplier="acme", external_id="a-1", title="Napkins"
        )

        with self.assertRaisesMessage(ValueError, "still has invoices or items."):
            action_delete_supplier(self.user, {"id": str(self.supplier.id)})

    def test_another_tenants_supplier_is_not_found(self):
        with self.assertRaisesMessage(ValueError, "Supplier not found"):
            action_delete_supplier(
                make_user("stranger@example.com"), {"id": str(self.supplier.id)}
            )


class EnsureSupplierTests(TestCase):
    def setUp(self) -> None:
        self.user = make_user("ensure@example.com")
        ensure_expense_categories(self.user)

    def test_an_invoice_upload_records_the_supplier_it_names(self):
        action_import_invoices(
            self.user,
            {
                "reviewedCurrencyCode": "USD",
                "invoices": [
                    {
                        "supplier": "acme foods",
                        "supplierName": "Acme Foods Inc.",
                        "documentType": "invoice",
                        "invoiceNumber": "INV-1",
                        "invoiceDate": "2026-01-15",
                        "totalCents": 1000,
                        "fileName": "inv.pdf",
                        "lines": [],
                        "ignored": [],
                    }
                ],
            },
        )

        row = Supplier.objects.get(user=self.user)
        self.assertEqual((row.key, row.name), ("acme foods", "Acme Foods Inc."))

    def test_a_skip_list_write_records_the_supplier(self):
        upsert_supplier_ignores(
            self.user,
            [{"supplier": "Vestal", "externalId": "v-1", "name": "Napkins"}],
        )

        self.assertEqual(
            Supplier.objects.get(user=self.user).key, "vestal"
        )

    def test_a_spreadsheet_import_records_the_supplier(self):
        ingredient_import = IngredientImport.objects.create(
            user=self.user, file_name="prices.csv"
        )

        apply_supplier_import_entry(
            self.user,
            ingredient_import,
            0,
            {
                "name": "Carrots",
                "packUnit": "lb",
                "packAmount": 24,
                "packPriceCents": 2450,
                "supplier": "Vestal",
                "externalId": "v-1",
                "rawSize": "24 X 1 LB",
                "preferred": False,
            },
        )

        self.assertEqual(Supplier.objects.get(user=self.user).key, "vestal")
