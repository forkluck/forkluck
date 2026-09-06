"""Import and undo serialize per workspace.

Undo used to validate outside the transaction it mutated in: it read each
affected row, checked the row's timestamp against the import, and only then
opened a transaction to restore or delete. Another request landing in that gap
would be overwritten by the very guard meant to refuse it.

The fix is one transaction spanning validation and mutation, entered by taking
the workspace's own row. Cross-connection contention cannot be demonstrated on
SQLite — select_for_update is a no-op there — so what these tests pin is the
structure that makes the lock effective on PostgreSQL: every import and undo
flow takes the workspace lock, takes it inside a transaction, and takes it
before reading anything it validates.
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.db import connection, transaction
from django.test import Client
from django.utils import timezone

from .models import (
    Ingredient,
    IngredientImport,
    LaborImport,
    SalesImport,
    SalesLine,
    User,
)
from .testing import InternalApiTestCase


class WorkspaceLockSpy:
    """Stands in for lock_workspace and records how it was entered."""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, user):
        self.calls.append(
            {
                "user_id": user.pk,
                "in_atomic_block": connection.in_atomic_block,
            }
        )

    @property
    def called(self) -> bool:
        return bool(self.calls)


class UndoLockingTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="undo-locking@example.com",
            name="Undo Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client = Client()
        self.client.force_login(self.user)

    # -- ingredients ----------------------------------------------------

    def ingredient_import_payload(self) -> dict:
        return {
            "fileName": "purchases.xlsx",
            "entries": [
                {
                    "name": "Flour",
                    "packUnit": "kg",
                    "packAmount": 25,
                    "packPriceCents": 1200,
                    "supplier": "harbor",
                    "externalId": "FLR10",
                    "rawSize": "25 KG",
                    "quantity": 1,
                    "preferred": False,
                }
            ],
        }

    def test_ingredient_import_takes_the_workspace_lock_in_a_transaction(self):
        spy = WorkspaceLockSpy()
        with patch("forkluck.domains.ingredients.actions.lock_workspace", spy):
            response = self.post_internal(
                "import-ingredients", self.ingredient_import_payload()
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(spy.called, "import-ingredients must lock the workspace")
        self.assertTrue(spy.calls[0]["in_atomic_block"])
        self.assertEqual(spy.calls[0]["user_id"], self.user.pk)

    def test_ingredient_undo_locks_before_it_validates(self):
        created = self.post_internal(
            "import-ingredients", self.ingredient_import_payload()
        )
        self.assertEqual(created.status_code, 200)
        import_id = str(IngredientImport.objects.get(user=self.user).id)

        spy = WorkspaceLockSpy()
        with patch("forkluck.domains.ingredients.actions.lock_workspace", spy):
            response = self.post_internal("undo-ingredient-import", {"id": import_id})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(spy.called, "undo-ingredient-import must lock the workspace")
        self.assertTrue(
            spy.calls[0]["in_atomic_block"],
            "the lock must be taken inside the transaction that also mutates",
        )

    def test_ingredient_undo_still_refuses_a_row_changed_after_the_import(self):
        # The guard itself must survive being moved inside the transaction.
        created = self.post_internal(
            "import-ingredients", self.ingredient_import_payload()
        )
        self.assertEqual(created.status_code, 200)
        import_row = IngredientImport.objects.get(user=self.user)

        ingredient = Ingredient.objects.get(user=self.user, name="Flour")
        Ingredient.objects.filter(pk=ingredient.pk).update(
            updated_at=import_row.updated_at + timedelta(minutes=5)
        )

        response = self.post_internal(
            "undo-ingredient-import", {"id": str(import_row.id)}
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("changed after this import", response.json()["error"])
        # Refused means untouched: the import is still active and the row lives.
        import_row.refresh_from_db()
        self.assertIsNone(import_row.undone_at)
        self.assertTrue(Ingredient.objects.filter(pk=ingredient.pk).exists())

    def test_a_refused_ingredient_undo_leaves_nothing_partially_applied(self):
        # Two entries, with the guard tripped on one of them. Validation now
        # runs in the same transaction as the restores, so a late failure must
        # still roll the whole undo back.
        payload = self.ingredient_import_payload()
        payload["entries"].append(
            {
                "name": "Sugar",
                "packUnit": "kg",
                "packAmount": 25,
                "packPriceCents": 800,
                "supplier": "harbor",
                "externalId": "SUG10",
                "rawSize": "25 KG",
                "quantity": 1,
                "preferred": False,
            }
        )
        self.assertEqual(
            self.post_internal("import-ingredients", payload).status_code, 200
        )
        import_row = IngredientImport.objects.get(user=self.user)
        before = set(
            Ingredient.objects.filter(user=self.user).values_list("id", flat=True)
        )

        Ingredient.objects.filter(user=self.user, name="Sugar").update(
            updated_at=import_row.updated_at + timedelta(minutes=5)
        )

        response = self.post_internal(
            "undo-ingredient-import", {"id": str(import_row.id)}
        )

        self.assertEqual(response.status_code, 400)
        after = set(
            Ingredient.objects.filter(user=self.user).values_list("id", flat=True)
        )
        self.assertEqual(before, after, "a refused undo must delete nothing")

    # -- labor ----------------------------------------------------------

    def labor_import_payload(self) -> dict:
        return {
            "expectedCurrencyCode": "USD",
            "fileName": "hours.csv",
            "source": "csv",
            "timezone": "America/New_York",
            "mapping": {"employee": "Job", "clockIn": "In", "clockOut": "Out"},
            "totalRows": 1,
            "skippedCount": 0,
            "excludedCount": 0,
            "rates": [
                {
                    "employeeName": "Alex Baker",
                    "hourlyRateCents": 2000,
                    "effectiveFrom": "2026-06-01",
                }
            ],
            "entries": [
                {
                    "position": 2,
                    "employeeName": "Alex Baker",
                    "clockInLocal": "2026-06-15T08:00:00",
                    "clockOutLocal": "2026-06-15T16:00:00",
                    "paidSeconds": 28800,
                    "breakSeconds": 0,
                    "timeAdjustmentSeconds": 0,
                    "earningsAdjustmentCents": 0,
                    "comment": "Prep",
                    "raw": {"Job": "Alex Baker"},
                }
            ],
        }

    def test_labor_import_and_undo_both_lock_the_workspace(self):
        spy = WorkspaceLockSpy()
        with patch("forkluck.domains.labor.actions.lock_workspace", spy):
            created = self.post_internal("import-labor", self.labor_import_payload())
            self.assertEqual(created.status_code, 200)
            import_id = str(LaborImport.objects.get(user=self.user).id)
            undone = self.post_internal("undo-labor-import", {"id": import_id})

        self.assertEqual(undone.status_code, 200)
        self.assertEqual(len(spy.calls), 2, "both import and undo must lock")
        self.assertTrue(all(call["in_atomic_block"] for call in spy.calls))

    def test_labor_undo_still_refuses_anything_but_the_newest_active_import(self):
        first = self.post_internal("import-labor", self.labor_import_payload())
        second = self.post_internal("import-labor", self.labor_import_payload())
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        oldest = LaborImport.objects.filter(user=self.user).order_by("created_at").first()

        response = self.post_internal("undo-labor-import", {"id": str(oldest.id)})

        self.assertEqual(response.status_code, 400)
        self.assertIn("newest active", response.json()["error"])
        oldest.refresh_from_db()
        self.assertIsNone(oldest.undone_at)

    # -- sales ----------------------------------------------------------

    def make_sales_import(self, *, order_id: str = "payment-1") -> SalesImport:
        """One stored batch, the shape a sync pass leaves behind.

        Undo is what these tests are about, and undo does not care how the
        batch arrived — only that it is the newest active one.
        """
        batch = SalesImport.objects.create(
            user=self.user,
            file_name="square-sync",
            channel="square",
            timezone="America/New_York",
            currency_code="USD",
        )
        SalesLine.objects.create(
            user=self.user,
            sales_import=batch,
            channel="square",
            source_position=2,
            source_fingerprint=f"line-{order_id}",
            external_order_id=order_id,
            sold_at=timezone.now(),
            sku="200120",
            item_name="Pineapple Linzer",
            external_variant_title="Regular",
            group_key="sku:200120",
            quantity=Decimal("2"),
            gross_cents=800,
            discount_cents=100,
            net_sales_cents=700,
        )
        return batch

    def test_sales_undo_locks_the_workspace_in_a_transaction(self):
        batch = self.make_sales_import()

        spy = WorkspaceLockSpy()
        with patch("forkluck.domains.sales.core.lock_workspace", spy):
            undone = self.post_internal("undo-sales-import", {"id": str(batch.id)})

        self.assertEqual(undone.status_code, 200, undone.content)
        self.assertEqual(len(spy.calls), 1, "undo must lock")
        self.assertTrue(all(call["in_atomic_block"] for call in spy.calls))

    def test_sales_undo_still_refuses_anything_but_the_newest_active_import(self):
        self.make_sales_import()
        self.make_sales_import(order_id="payment-2")
        oldest = SalesImport.objects.filter(user=self.user).order_by("created_at").first()

        response = self.post_internal("undo-sales-import", {"id": str(oldest.id)})

        self.assertEqual(response.status_code, 400)
        self.assertIn("newest active", response.json()["error"])

    # -- the helper itself ----------------------------------------------

    def test_lock_workspace_targets_this_workspace_only(self):
        from .domains.shared.locking import lock_workspace

        other = User.objects.create_user(
            email="other-workspace@example.com",
            name="Other",
            password="a-long-test-passphrase-1357",
        )
        with transaction.atomic():
            # Both must be lockable independently; the helper is per workspace,
            # not a global mutex.
            lock_workspace(self.user)
            lock_workspace(other)
