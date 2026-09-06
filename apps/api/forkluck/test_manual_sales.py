import json
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import RequestFactory, TestCase

from .domains.sales.core import (
    action_record_manual_sales,
    daily_sales_rows,
    product_json,
    sales_imports_payload,
    sales_overview_payload,
)
from .domains.sales.views import product_detail
from .models import (
    BenchCostSettings,
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesIgnoreRule,
    SalesImport,
    SalesLine,
    SalesModifierList,
    SalesProduct,
    SalesSkuIgnore,
    SyncRun,
    User,
)


class ManualSalesLedgerTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="manual-sales@example.com",
            name="Manual Sales",
            password="test-password",
        )
        BenchCostSettings.objects.create(
            user=self.user,
            timezone="America/New_York",
            currency_code="USD",
        )
        self.product = SalesProduct.objects.create(
            user=self.user,
            name="Cookie",
            normalized_name="cookie",
            sell_price_cents=750,
        )

    def record(self, **body):
        return action_record_manual_sales(
            self.user,
            {"productId": str(self.product.id), "soldOn": "2026-07-04", **body},
        )

    def test_upserts_one_row_per_product_and_local_day(self) -> None:
        result = self.record(quantity=2, totalNetCents=900)
        line = SalesLine.objects.get(user=self.user)
        variant = SalesProductVariant.objects.get(user=self.user)
        imported = SalesImport.objects.get(user=self.user)

        self.assertEqual(result["soldOn"], "2026-07-04")
        self.assertEqual(line.quantity, Decimal("2.000"))
        self.assertEqual(line.net_sales_cents, 900)
        self.assertTrue(line.source_payload["netProvided"])
        self.assertEqual(line.gross_cents, 0)
        self.assertEqual(line.discount_cents, 0)
        self.assertEqual(line.tax_cents, 0)
        self.assertEqual(line.refund_cents, 0)
        self.assertEqual(line.currency_code, "USD")
        self.assertEqual(
            line.sold_at,
            datetime(2026, 7, 4, 12, tzinfo=ZoneInfo("America/New_York")),
        )
        self.assertEqual(variant.channel, SalesImport.Channel.MANUAL)
        self.assertEqual(variant.match_key, f"manual:item:{self.product.id}")
        self.assertEqual(variant.quantity_multiplier, Decimal("1"))
        self.assertEqual(imported.period_start.isoformat(), "2026-07-01")

        again = self.record(quantity=3, totalNetCents=1200)
        self.assertEqual(again["id"], str(line.id))
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 1)
        line.refresh_from_db()
        self.assertEqual(line.quantity, Decimal("3.000"))
        self.assertEqual(line.net_sales_cents, 1200)

        self.record(soldOn="2026-07-05", quantity=1, totalNetCents=400)
        self.assertEqual(SalesLine.objects.filter(user=self.user).count(), 2)
        self.assertEqual(SalesImport.objects.filter(user=self.user).count(), 1)
        self.assertEqual(
            SalesLine.objects.values_list("source_position", flat=True).distinct().count(),
            2,
        )

    def test_count_only_rows_keep_net_unknown_and_never_copy_price(self) -> None:
        result = self.record(quantity=2)
        line = SalesLine.objects.get(user=self.user)

        self.assertEqual(result["netSalesCents"], 0)
        self.assertEqual(line.net_sales_cents, 0)
        self.assertFalse(line.source_payload["netProvided"])
        self.assertEqual(line.gross_cents, 0)
        self.assertNotEqual(line.net_sales_cents, self.product.sell_price_cents)
        daily = daily_sales_rows(self.user)
        self.assertEqual(len(daily), 1)
        self.assertIsNone(daily[0]["netSalesCents"])
        self.assertTrue(sales_overview_payload(self.user)["incompleteManualRevenue"])

    def test_provided_manual_revenue_reaches_the_all_channel_trend(self) -> None:
        self.record(quantity=2, totalNetCents=900)

        overview = sales_overview_payload(
            self.user, trend_date=date(2026, 7, 4)
        )
        hours = overview["netSalesTrend"]["hours"]

        self.assertEqual(sum(row["currentManualCents"] for row in hours), 900)
        self.assertEqual(sum(row["currentSquareCents"] for row in hours), 0)
        self.assertEqual(sum(row["currentShopifyCents"] for row in hours), 0)
        self.assertFalse(overview["incompleteManualRevenue"])

    def test_analytics_warning_is_scoped_to_the_selected_period(self) -> None:
        self.record(quantity=2)

        same_day = sales_overview_payload(
            self.user, trend_date=date(2026, 7, 4)
        )
        next_day = sales_overview_payload(
            self.user, trend_date=date(2026, 7, 5)
        )

        self.assertTrue(same_day["incompleteManualRevenue"])
        self.assertFalse(next_day["incompleteManualRevenue"])

    def test_zero_quantity_deletes_day_and_keeps_zeroed_month_container(self) -> None:
        self.record(quantity=2, totalNetCents=900)
        result = self.record(quantity=0)

        self.assertTrue(result["deleted"])
        self.assertFalse(SalesLine.objects.filter(user=self.user).exists())
        imported = SalesImport.objects.get(user=self.user)
        self.assertEqual(imported.period_start.isoformat(), "2026-07-01")
        self.assertEqual(imported.total_rows, 0)
        self.assertEqual(imported.imported_count, 0)
        self.assertEqual(imported.order_count, 0)
        self.assertEqual(imported.gross_cents, 0)
        self.assertEqual(imported.net_sales_cents, 0)
        self.assertEqual(result["importId"], str(imported.id))

    def test_zero_quantity_for_absent_day_is_a_no_op(self) -> None:
        result = self.record(quantity=0)

        self.assertFalse(result["deleted"])
        self.assertIsNone(result["importId"])
        self.assertFalse(SalesImport.objects.filter(user=self.user).exists())
        self.assertFalse(SalesProductVariant.objects.filter(user=self.user).exists())
        self.assertFalse(SalesLine.objects.filter(user=self.user).exists())

    def test_workspace_currency_is_captured_per_row_and_mixed_month_is_neutral(self) -> None:
        self.record(quantity=1, totalNetCents=500)
        settings = BenchCostSettings.objects.get(user=self.user)
        settings.currency_code = "CAD"
        settings.save(update_fields=["currency_code"])
        action_record_manual_sales(
            self.user,
            {
                "productId": str(self.product.id),
                "soldOn": "2026-07-05",
                "quantity": 1,
                "totalNetCents": 500,
            },
        )

        lines = SalesLine.objects.filter(user=self.user).order_by("sold_on")
        self.assertEqual(list(lines.values_list("currency_code", flat=True)), ["USD", "CAD"])
        imported = SalesImport.objects.get(user=self.user)
        self.assertEqual(imported.currency_code, "")
        self.assertEqual(imported.net_sales_cents, 0)

    def test_manual_imports_are_hidden_from_provider_history(self) -> None:
        self.record(quantity=1, totalNetCents=100)
        self.assertEqual(sales_imports_payload(self.user)["items"], [])

    def test_system_manual_variant_is_hidden_from_product_payload(self) -> None:
        self.record(quantity=1, totalNetCents=100)
        payload = product_json(
            SalesProduct.objects.prefetch_related("variants").get(id=self.product.id)
        )
        self.assertEqual(payload["variants"], [])

    def test_product_detail_exposes_nullable_manual_daily_and_edit_rows(self) -> None:
        self.record(quantity=2)
        request = RequestFactory().get(
            "/", {"start": "2026-07-01", "end": "2026-07-31"}
        )
        request.user = self.user
        with self.assertNumQueries(
            20,
            msg=(
                "Product Sales must keep a fixed query count as ledger rows grow; "
                "canonical consumption and interpreted money are each prefetched, "
                "and the page's two views cost one bundle graph between them"
            ),
        ):
            response = product_detail(request, product_ref=self.product.public_id)
        self.record(soldOn="2026-07-05", quantity=1, totalNetCents=400)
        with self.assertNumQueries(
            20,
            msg="Product Sales query count must not grow with manual ledger rows",
        ):
            response = product_detail(request, product_ref=self.product.public_id)
        payload = json.loads(response.content)["item"]

        self.assertTrue(payload["incompleteManualRevenue"])
        count_only = next(
            row
            for row in payload["sales"]["dailySales"]
            if row["soldOn"] == "2026-07-04"
        )
        self.assertEqual(count_only["channel"], "manual")
        self.assertIsNone(count_only["netSalesCents"])
        self.assertEqual(payload["sales"]["manualSales"][0]["quantity"], 2.0)
        self.assertIsNone(payload["sales"]["manualSales"][0]["totalNetCents"])

    def test_negative_quantity_or_net_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.record(quantity=-1)
        with self.assertRaises(ValueError):
            self.record(quantity=1, totalNetCents=-1)

    def test_product_id_accepts_public_id_and_rejects_foreign_uuid(self) -> None:
        result = action_record_manual_sales(
            self.user,
            {
                "productId": self.product.public_id,
                "soldOn": "2026-07-06",
                "quantity": 1,
            },
        )
        self.assertEqual(result["publicId"], self.product.public_id)

        other = User.objects.create_user(
            email="other-manual-sales@example.com", password="test-password"
        )
        foreign = SalesProduct.objects.create(
            user=other, name="Foreign", normalized_name="foreign"
        )
        with self.assertRaisesMessage(ValueError, "Product not found"):
            action_record_manual_sales(
                self.user,
                {
                    "productId": str(foreign.id),
                    "soldOn": "2026-07-07",
                    "quantity": 1,
                },
            )

    def test_manual_container_and_variant_uniqueness_are_database_guards(self) -> None:
        self.record(quantity=1)
        imported = SalesImport.objects.get(user=self.user)
        variant = SalesProductVariant.objects.get(user=self.user)
        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesImport.objects.create(
                user=self.user,
                file_name="duplicate",
                source=SalesImport.Source.MANUAL,
                channel=SalesImport.Channel.MANUAL,
                period_start=imported.period_start,
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            SalesProductVariant.objects.create(
                user=self.user,
                product=self.product,
                channel=SalesImport.Channel.MANUAL,
                match_key="manual:item:duplicate",
                external_name=self.product.name,
            )
        self.assertEqual(variant.match_key, f"manual:item:{self.product.id}")

    def test_provider_only_model_choices_reject_manual(self) -> None:
        for model, field_name in (
            (SalesCatalogItem, "channel"),
            (SalesChannelConnection, "provider"),
            (SalesIgnoreRule, "channel"),
            (SalesModifierList, "channel"),
            (SalesSkuIgnore, "channel"),
            (SyncRun, "provider"),
        ):
            field = model._meta.get_field(field_name)
            with self.subTest(model=model.__name__, field=field_name):
                self.assertNotIn("manual", {value for value, _ in field.choices})
                with self.assertRaises(ValidationError):
                    field.validate("manual", None)
