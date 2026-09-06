"""Bundle revenue completeness and concurrent product-composition edits."""

import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.contrib import admin
from django.contrib.messages.storage.cookie import CookieStorage
from django.db import close_old_connections, connection
from django.test import RequestFactory, TestCase, TransactionTestCase

from .domains.sales import core
from .domains.sales.views import sales_overview
from . import admin as admin_module
from .models import BenchCostSettings, SalesLine, SalesProduct, SalesProductComponent, User
from .verification import ADMIN_VERIFIED_SESSION_KEY


class BundleManualRevenueTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="bundle-revenue@example.com")
        BenchCostSettings.objects.create(user=self.user, timezone="UTC", currency_code="USD")
        self.cookie = SalesProduct.objects.create(
            user=self.user, name="Cookie", normalized_name="cookie", sell_price_cents=500
        )
        self.box = SalesProduct.objects.create(
            user=self.user, name="Box", normalized_name="box", sell_price_cents=1000
        )
        core.action_save_sales_product(self.user, {
            "id": str(self.box.id), "expectedEditVersion": 0,
            "components": [{"productId": str(self.cookie.id), "quantity": 2}],
        })

    def record(self, product, total, *, sold_on="2026-09-04"):
        body = {"productId": str(product.id), "soldOn": sold_on, "quantity": 1}
        if total is not None:
            body["totalNetCents"] = total
        return core.action_record_manual_sales(self.user, body)

    def overview(self):
        request = RequestFactory().get("/internal/v1/sales/overview/", {"date": "2026-09-04"})
        request.user = self.user
        response = sales_overview(request)
        self.assertEqual(response.status_code, 200)
        return json.loads(response.content)

    def test_direct_and_bundle_missing_totals_preserve_unknown_in_overview(self):
        for direct_total in (None, 500):
            for bundle_total in (None, 1000):
                with self.subTest(direct=direct_total, bundle=bundle_total):
                    self.record(self.cookie, direct_total)
                    self.record(self.box, bundle_total)
                    before = list(SalesLine.objects.values(
                        "id", "gross_cents", "discount_cents", "net_sales_cents",
                        "tax_cents", "refund_cents", "source_payload",
                    ))
                    overview = self.overview()
                    rows = {row["productName"]: row for row in overview["dailySales"]}
                    expected = (
                        None if direct_total is None or bundle_total is None
                        else direct_total + bundle_total
                    )
                    self.assertEqual(rows["Cookie"]["netSalesCents"], expected)
                    self.assertEqual(rows["Cookie"]["quantity"], 3)
                    self.assertEqual(rows["Box"]["quantity"], 1)
                    self.assertEqual(rows["Box"]["netSalesCents"], None if bundle_total is None else 0)
                    for row in rows.values():
                        for field in ("grossCents", "discountCents", "taxCents", "refundCents"):
                            self.assertEqual(row[field], 0)
                    self.assertEqual(overview["incompleteManualRevenue"], expected is None)
                    self.assertEqual(before, list(SalesLine.objects.values(
                        "id", "gross_cents", "discount_cents", "net_sales_cents",
                        "tax_cents", "refund_cents", "source_payload",
                    )))

    def test_missing_nested_bundle_total_does_not_become_zero(self):
        hamper = SalesProduct.objects.create(user=self.user, name="Hamper", normalized_name="hamper")
        core.action_save_sales_product(self.user, {
            "id": str(hamper.id), "expectedEditVersion": 0,
            "components": [{"productId": str(self.box.id), "quantity": 3}],
        })
        self.record(hamper, None)
        self.record(self.cookie, 500, sold_on="2026-09-03")
        rows = {(row["productName"], row["soldOn"]): row for row in self.overview()["dailySales"]}
        for name, quantity in (("Hamper", 1), ("Box", 3), ("Cookie", 6)):
            self.assertIsNone(rows[name, "2026-09-04"]["netSalesCents"])
            self.assertEqual(rows[name, "2026-09-04"]["quantity"], quantity)
        self.assertEqual(rows["Cookie", "2026-09-03"]["netSalesCents"], 500)
        as_sold = core.daily_sales_rows(self.user, expand_bundles=False)
        self.assertEqual(len(as_sold), 2)
        self.assertIsNone(next(row for row in as_sold if row["productName"] == "Hamper")["netSalesCents"])


@unittest.skipUnless(connection.vendor == "postgresql", "Bundle concurrency needs PostgreSQL row locks")
class BundleCompositionConcurrencyTests(TransactionTestCase):
    def test_opposite_editor_saves_cannot_both_commit(self):
        self.race_opposite_saves(staff=False)

    def test_staff_component_form_cannot_race_product_editor(self):
        self.race_opposite_saves(staff=True)

    def race_opposite_saves(self, *, staff):
        user = User.objects.create_user(email="bundle-race@example.com")
        staff_user = User.objects.create_superuser(email="bundle-staff@example.com") if staff else None
        first = SalesProduct.objects.create(user=user, name="First", normalized_name="first")
        second = SalesProduct.objects.create(user=user, name="Second", normalized_name="second")
        first_validated = threading.Event()
        second_contending = threading.Event()
        thread_state = threading.local()
        original_parse = core.parse_product_components
        original_lock = core.lock_workspace

        def parse_components(user, body, product):
            result = original_parse(user, body, product)
            if thread_state.second:
                second_contending.set()
            else:
                first_validated.set()
                if not second_contending.wait(timeout=5):
                    raise AssertionError("Second editor never reached validation or workspace lock")
            return result

        def lock(user):
            if thread_state.second:
                second_contending.set()
            original_lock(user)

        def save(product, member, *, is_second):
            close_old_connections()
            thread_state.second = is_second
            try:
                if is_second and not first_validated.wait(timeout=5):
                    raise AssertionError("First editor never validated its composition")
                try:
                    if is_second and staff:
                        request = RequestFactory().post("/mommy/forkluck/salesproductcomponent/add/", {
                            "product": str(product.id), "component_product": str(member.id),
                            "quantity": "2", "position": "0", "unit": "",
                        })
                        request.user = staff_user
                        request.session = {ADMIN_VERIFIED_SESSION_KEY: str(staff_user.pk)}
                        request._dont_enforce_csrf_checks = True
                        request._messages = CookieStorage(request)
                        return admin.site._registry[SalesProductComponent].changeform_view(request)
                    return core.action_save_sales_product(user, {
                        "id": str(product.id), "expectedEditVersion": 0,
                        "components": [{"productId": str(member.id), "quantity": 2}],
                    })
                except ValueError as exc:
                    return exc
            finally:
                if is_second:
                    second_contending.set()
                connection.close()

        with patch.object(core, "parse_product_components", side_effect=parse_components), patch.object(core, "lock_workspace", side_effect=lock), patch.object(admin_module, "lock_workspace", side_effect=lock):
            with ThreadPoolExecutor(max_workers=2) as executor:
                a = executor.submit(save, first, second, is_second=False)
                b = executor.submit(save, second, first, is_second=True)
                first_result = a.result(timeout=10)
                second_result = b.result(timeout=10)
        self.assertIsInstance(first_result, dict)
        if staff:
            self.assertEqual(second_result.status_code, 200)
            self.assertIn("Bundles cannot contain a cycle", str(second_result.context_data["adminform"].form.errors))
        else:
            self.assertIsInstance(second_result, ValueError)
            self.assertEqual(str(second_result), "Bundles cannot contain a cycle")
        self.assertEqual(SalesProductComponent.objects.count(), 1)
        self.assertEqual(SalesProductComponent.objects.get().product_id, first.id)
        second.refresh_from_db()
        self.assertEqual(second.edit_version, 0)
