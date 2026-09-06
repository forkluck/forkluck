from __future__ import annotations

from datetime import date, datetime, timezone as datetime_timezone
from decimal import Decimal

from django.test import TestCase

from .domains.sales.consumption import daily_product_consumption_rows
from .domains.sales.core import action_record_manual_sales
from .models import (
    BenchCostSettings,
    SalesProductVariant,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesProduct,
    SalesProductComponent,
    User,
)


class DailyProductConsumptionTests(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="consumption@example.com",
            name="Consumption Chef",
            password="a-long-test-passphrase-2468",
        )
        BenchCostSettings.objects.create(
            user=self.user,
            timezone="America/New_York",
            currency_code="USD",
        )
        self.square_import = SalesImport.objects.create(
            user=self.user,
            file_name="square.csv",
            source=SalesImport.Source.CSV,
            channel=SalesImport.Channel.SQUARE,
            timezone="UTC",
            currency_code="USD",
        )
        self.shopify_import = SalesImport.objects.create(
            user=self.user,
            file_name="shopify.csv",
            source=SalesImport.Source.CSV,
            channel=SalesImport.Channel.SHOPIFY,
            timezone="UTC",
            currency_code="USD",
        )
        self.espresso = self.product("Espresso")
        self.cookie = self.product("Cookie")
        self.sprinkles = self.product("Sprinkles")
        self.counter = 0

    def product(self, name: str) -> SalesProduct:
        return SalesProduct.objects.create(
            user=self.user,
            name=name,
            normalized_name=name.casefold(),
        )

    def variant(
        self,
        product: SalesProduct | None,
        *,
        channel: str = SalesImport.Channel.SQUARE,
        multiplier: str = "1",
        match_key: str | None = None,
        attribution: int | None = None,
    ) -> SalesProductVariant:
        return SalesProductVariant.objects.create(
            user=self.user,
            product=product,
            channel=channel,
            match_key=match_key or f"test:{product.id if product else 'set'}:{channel}",
            external_name=product.name if product else "Set",
            quantity_multiplier=Decimal(multiplier),
            attribution_percent=attribution,
        )

    def line(
        self,
        variant: SalesProductVariant,
        *,
        quantity: str = "1",
        sold_at: datetime = datetime(
            2026, 3, 8, 5, 30, tzinfo=datetime_timezone.utc
        ),
        sales_import: SalesImport | None = None,
    ) -> SalesLine:
        self.counter += 1
        imported = sales_import or self.square_import
        return SalesLine.objects.create(
            user=self.user,
            sales_import=imported,
            variant=variant,
            channel=imported.channel,
            source_position=self.counter,
            source_fingerprint=f"consumption-{self.counter}",
            external_order_id=f"order-{self.counter}",
            sold_at=sold_at,
            timezone="UTC",
            sku="",
            item_name=variant.external_name,
            quantity=Decimal(quantity),
            gross_cents=100,
            net_sales_cents=100,
            tax_cents=0,
            refund_cents=0,
        )

    def rows_by_key(self, rows):
        return {
            (row["productId"], row["soldOn"], row["channel"], row["source"]): row[
                "quantity"
            ]
            for row in rows
        }

    def test_direct_multiplier_attribution_and_return_are_physical_only(self):
        variant = self.variant(
            self.espresso,
            multiplier="3",
            attribution=40,
        )
        self.line(variant, quantity="2")
        self.line(variant, quantity="-1")

        rows = daily_product_consumption_rows(
            self.user, date(2026, 3, 8), date(2026, 3, 8)
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["quantity"], Decimal("3"))
        self.assertEqual(rows[0]["source"], "base")
        self.assertNotIn("netSalesCents", rows[0])
        self.assertNotIn("attributionPercent", rows[0])

    def test_bundle_counts_and_a_mapped_modifier_share_quantity(self):
        box = SalesProduct.objects.create(
            user=self.user, name="Box", normalized_name="box"
        )
        SalesProductComponent.objects.create(
            product=box, component_product=self.espresso, quantity=Decimal("1"), position=0
        )
        SalesProductComponent.objects.create(
            product=box, component_product=self.cookie, quantity=Decimal("3"), position=1
        )
        box_variant = self.variant(box, match_key="test:box")
        modifier_variant = self.variant(
            self.sprinkles,
            match_key="test:modifier",
        )
        sale = self.line(box_variant, quantity="2")
        SalesLineModifier.objects.create(
            user=self.user,
            sales_line=sale,
            variant=modifier_variant,
            source_fingerprint="modifier-1",
            name="Sprinkles",
            match_key="test:modifier",
            quantity=Decimal("2"),
        )

        quantities = self.rows_by_key(
            daily_product_consumption_rows(
                self.user, date(2026, 3, 8), date(2026, 3, 8)
            )
        )
        # The box itself is made twice; what is inside it says so separately.
        self.assertEqual(
            quantities[(str(box.id), "2026-03-08", "square", "base")], Decimal("2")
        )
        self.assertEqual(
            quantities[(str(self.espresso.id), "2026-03-08", "square", "bundle")],
            Decimal("2"),
        )
        self.assertEqual(
            quantities[(str(self.cookie.id), "2026-03-08", "square", "bundle")],
            Decimal("6"),
        )
        self.assertEqual(
            quantities[(str(self.sprinkles.id), "2026-03-08", "square", "modifier")],
            Decimal("4"),
        )

    def test_a_box_inside_a_box_is_counted_once_at_each_level(self):
        inner = SalesProduct.objects.create(
            user=self.user, name="Inner", normalized_name="inner"
        )
        SalesProductComponent.objects.create(
            product=inner, component_product=self.espresso, quantity=Decimal("2"), position=0
        )
        outer = SalesProduct.objects.create(
            user=self.user, name="Outer", normalized_name="outer"
        )
        SalesProductComponent.objects.create(
            product=outer, component_product=inner, quantity=Decimal("3"), position=0
        )
        SalesProductComponent.objects.create(
            product=outer, component_product=self.cookie, quantity=Decimal("1"), position=1
        )
        self.line(self.variant(outer, match_key="test:outer"), quantity="2")

        quantities = self.rows_by_key(
            daily_product_consumption_rows(
                self.user, date(2026, 3, 8), date(2026, 3, 8)
            )
        )

        day = ("2026-03-08", "square")
        self.assertEqual(quantities[(str(outer.id), *day, "base")], Decimal("2"))
        self.assertEqual(quantities[(str(inner.id), *day, "bundle")], Decimal("6"))
        self.assertEqual(
            quantities[(str(self.espresso.id), *day, "bundle")],
            Decimal("12"),
            "the espresso is counted once, through one path",
        )
        self.assertEqual(quantities[(str(self.cookie.id), *day, "bundle")], Decimal("2"))

    def test_channel_and_product_filter_do_not_collapse_or_drop_contributions(self):
        square_variant = self.variant(self.espresso, channel=SalesImport.Channel.SQUARE)
        shopify_variant = self.variant(
            self.espresso,
            channel=SalesImport.Channel.SHOPIFY,
            match_key="test:espresso:shopify",
        )
        self.line(square_variant, quantity="2")
        self.line(shopify_variant, quantity="5", sales_import=self.shopify_import)

        rows = daily_product_consumption_rows(
            self.user,
            date(2026, 3, 8),
            date(2026, 3, 8),
            product_ids=[self.espresso.id],
        )
        quantities = self.rows_by_key(rows)
        self.assertEqual(
            quantities[(str(self.espresso.id), "2026-03-08", "square", "base")],
            Decimal("2"),
        )
        self.assertEqual(
            quantities[(str(self.espresso.id), "2026-03-08", "shopify", "base")],
            Decimal("5"),
        )
        self.assertEqual(
            daily_product_consumption_rows(
                self.user,
                date(2026, 3, 8),
                date(2026, 3, 8),
                product_ids=[self.cookie.id],
            ),
            [],
        )

    def test_workspace_local_dst_boundary_uses_business_day(self):
        variant = self.variant(self.espresso)
        # Both instants are on March 8 in New York, across the spring-forward
        # transition; the UTC window must still include both exactly once.
        self.line(
            variant,
            quantity="1",
            sold_at=datetime(2026, 3, 8, 5, 1, tzinfo=datetime_timezone.utc),
        )
        self.line(
            variant,
            quantity="2",
            sold_at=datetime(2026, 3, 9, 3, 59, tzinfo=datetime_timezone.utc),
        )

        rows = daily_product_consumption_rows(
            self.user, date(2026, 3, 8), date(2026, 3, 8)
        )

        self.assertEqual(rows[0]["soldOn"], "2026-03-08")
        self.assertEqual(rows[0]["quantity"], Decimal("3"))

    def test_manual_ledger_channel_is_included_without_provider_identity(self):
        result = action_record_manual_sales(
            self.user,
            {
                "productId": str(self.espresso.id),
                "soldOn": "2026-03-08",
                "quantity": 7,
            },
        )

        rows = daily_product_consumption_rows(
            self.user, date(2026, 3, 8), date(2026, 3, 8)
        )

        self.assertFalse(result["netProvided"])
        manual_line = SalesLine.objects.get(
            user=self.user, channel=SalesImport.Channel.MANUAL
        )
        self.assertEqual(manual_line.net_sales_cents, 0)
        self.assertEqual(manual_line.source_payload["netProvided"], False)
        self.assertEqual(rows[0]["channel"], "manual")
        self.assertEqual(rows[0]["quantity"], Decimal("7"))
